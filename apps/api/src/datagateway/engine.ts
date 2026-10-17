import type { DatabaseSync } from 'node:sqlite';
import type { DbErrorCode, DbPolicy } from '@vch/shared';

/**
 * Motor de ejecución del data gateway:
 *  - allowlist estricta de statements (SELECT/DML + DDL acotado)
 *  - un solo statement por request
 *  - límite de filas en lecturas (sin materializar resultados enormes)
 *  - cuota de disco en escrituras (savepoint + rollback si se excede)
 */

export type StatementKind = 'read' | 'write' | 'ddl';

export class VchDbError extends Error {
  constructor(
    readonly code: DbErrorCode,
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = 'VchDbError';
  }
}

/** Quita comentarios SQL conservando strings literales. */
function stripComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** Sustituye literales por ? para inspeccionar estructura sin contenido. */
function maskLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, '?').replace(/"[^"]*"/g, '?');
}

/**
 * Clasifica un statement. Retorna null si está fuera del allowlist.
 * Lanza VchDbError si hay más de un statement.
 */
export function classifyStatement(rawSql: string): StatementKind | null {
  const noComments = stripComments(rawSql).trim();
  if (noComments.length === 0) return null;

  // Multi-statement: ';' que no sea el único delimitador final.
  const structure = maskLiterals(noComments);
  const withoutTrailing = structure.replace(/;\s*$/, '');
  if (withoutTrailing.includes(';')) {
    throw new VchDbError('VCH_DB_FORBIDDEN_STATEMENT', 'Solo se permite un statement por request.');
  }

  let sql = withoutTrailing.trim();
  // EXPLAIN / EXPLAIN QUERY PLAN delante de un statement permitido → mismo tipo.
  sql = sql.replace(/^EXPLAIN(\s+QUERY\s+PLAN)?\s+/i, '');

  const first = /^(\w+)/.exec(sql.toUpperCase());
  if (!first) return null;
  const verb = first[1];

  switch (verb) {
    case 'SELECT':
    case 'VALUES':
    case 'TABLE':
      return 'read';
    case 'INSERT':
    case 'UPDATE':
    case 'DELETE':
    case 'REPLACE':
      return 'write';
    case 'CREATE':
    case 'ALTER':
    case 'DROP': {
      // Solo objetos de esquema acotados; nada de TRIGGER (ejecutan código),
      // ni funciones/vistas materializadas/ATTACH/VACUUM.
      return /^(CREATE|ALTER|DROP)\s+(TABLE|INDEX|VIEW)\b/i.test(sql) ? 'ddl' : null;
    }
    case 'WITH': {
      // CTE: el verbo principal decide. Clasificar como escritura ante la duda
      // (WITH…INSERT sería write; false-positive write solo pierde el shape de rows).
      return /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(maskLiterals(sql)) ? 'write' : 'read';
    }
    default:
      return null;
  }
}

/** JSON-safe: bigint → number/string, Uint8Array (BLOB) → array de números. */
export function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = jsonSafe(v);
    return out;
  }
  return value;
}

function validateParams(params: unknown): unknown[] | Record<string, unknown> | undefined {
  if (params === undefined || params === null) return undefined;
  if (Array.isArray(params)) {
    if (params.length > 200) {
      throw new VchDbError('VCH_DB_FORBIDDEN_STATEMENT', 'Máximo 200 parámetros por query.');
    }
    return params.map(validateOneParam);
  }
  if (typeof params === 'object') {
    const entries = Object.entries(params as Record<string, unknown>);
    if (entries.length > 200) {
      throw new VchDbError('VCH_DB_FORBIDDEN_STATEMENT', 'Máximo 200 parámetros por query.');
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = validateOneParam(v);
    return out;
  }
  throw new VchDbError('VCH_DB_FORBIDDEN_STATEMENT', 'params debe ser array u objeto.');
}

function validateOneParam(v: unknown): unknown {
  const t = typeof v;
  if (t === 'string' && (v as string).length > 4 * 1024 * 1024) {
    throw new VchDbError('VCH_DB_FORBIDDEN_STATEMENT', 'Parámetro demasiado grande (máx 4 MB).');
  }
  if (t === 'number' || t === 'string' || t === 'bigint' || t === 'boolean' || v === null) return v;
  if (Array.isArray(v) && v.every((x) => typeof x === 'number' && x >= 0 && x <= 255)) {
    return Uint8Array.from(v); // BLOB desde JSON
  }
  throw new VchDbError('VCH_DB_FORBIDDEN_STATEMENT', 'Tipo de parámetro no soportado.');
}

export interface QueryResultRead {
  kind: 'read';
  rows: Record<string, unknown>[];
  truncated: boolean;
}

export interface QueryResultWrite {
  kind: 'write';
  changes: number;
  lastInsertRowid: number | string | null;
  /** Tamaño del archivo tras la escritura (bytes, según page_count de SQLite). */
  sizeBytes: number;
}

export type GatewayQueryResult = QueryResultRead | QueryResultWrite;

/** Tamaño del archivo de BD según SQLite (incluye páginas ya commiteadas en WAL). */
function dbSizeBytes(conn: DatabaseSync): number {
  const pageCount = (conn.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
  const pageSize = (conn.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
  return pageCount * pageSize;
}

/**
 * Ejecuta un statement ya clasificado contra la BD de la app.
 * - lecturas: itera y corta en maxRows (truncated=true si había más)
 * - escrituras/DDL: savepoint + verificación de cuota con rollback
 */
export function executeStatement(
  conn: DatabaseSync,
  sql: string,
  kind: StatementKind,
  params: unknown,
  policy: DbPolicy,
): GatewayQueryResult {
  const bound = validateParams(params);

  if (kind === 'read') {
    const rows: Record<string, unknown>[] = [];
    let truncated = false;
    try {
      const stmt = conn.prepare(sql);
      const iterable =
        bound === undefined
          ? stmt.iterate()
          : Array.isArray(bound)
            ? stmt.iterate(...(bound as never[]))
            : stmt.iterate(bound as never);
      for (const row of iterable) {
        if (rows.length >= policy.maxRows) {
          truncated = true;
          break;
        }
        rows.push(jsonSafe(row) as Record<string, unknown>);
      }
    } catch (err) {
      throw wrapSqliteError(err);
    }
    return { kind: 'read', rows, truncated };
  }

  // Escritura / DDL con cuota: si el resultado supera la cuota, se deshace.
  conn.exec('SAVEPOINT vch_gateway');
  try {
    const stmt = conn.prepare(sql);
    const info =
      bound === undefined
        ? stmt.run()
        : Array.isArray(bound)
          ? stmt.run(...(bound as never[]))
          : stmt.run(bound as never);
    const size = dbSizeBytes(conn);
    if (size > policy.quotaMb * 1024 * 1024) {
      conn.exec('ROLLBACK TO vch_gateway');
      throw new VchDbError(
        'VCH_DB_QUOTA_EXCEEDED',
        `La base de datos superó la cuota de ${policy.quotaMb} MB. La escritura fue revertida.`,
      );
    }
    return {
      kind: 'write',
      changes: Number(info.changes),
      lastInsertRowid: jsonSafe(info.lastInsertRowid) as number | string | null,
      sizeBytes: size,
    };
  } catch (err) {
    if (err instanceof VchDbError) throw err;
    throw wrapSqliteError(err);
  } finally {
    try {
      conn.exec('RELEASE vch_gateway');
    } catch {
      // el savepoint ya no existe (rollback completo del error original)
    }
  }
}

/** Mapea errores de SQLite a errores tipados sin filtrar rutas internas. */
function wrapSqliteError(err: unknown): VchDbError {
  if (err instanceof VchDbError) return err;
  const msg = err instanceof Error ? err.message : '';
  if (/database is locked/i.test(msg)) {
    return new VchDbError('VCH_DB_TIMEOUT', 'La base de datos está ocupada. Reintenta en un momento.', 503);
  }
  if (/syntax error|no such|wrong number|cannot bind|out of range|too large/i.test(msg)) {
    return new VchDbError('VCH_DB_FORBIDDEN_STATEMENT', `SQLite rechazó el statement: ${msg}`);
  }
  if (/quota/i.test(msg)) {
    return new VchDbError('VCH_DB_QUOTA_EXCEEDED', msg);
  }
  return new VchDbError('VCH_DB_INTERNAL', 'Error ejecutando el statement.', 500);
}
