/**
 * Capa de acceso a datos con dos drivers:
 *  - Postgres real vía DATABASE_URL (producción, docker compose).
 *  - PGlite embebida (desarrollo sin docker): mismo dialecto SQL, datos en disco local.
 * La interfaz mínima mantiene el resto del código agnóstico del driver.
 */

export interface QueryResult<T> {
  rows: T[];
}

export interface DbClient {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Para DDL / migraciones: varias sentencias en una llamada */
  exec(sql: string): Promise<void>;
}

export async function createDb(opts: { databaseUrl?: string; pgliteDir: string }): Promise<DbClient> {
  if (opts.databaseUrl) {
    const pg = await import('pg');
    const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 10 });
    return {
      async query<T>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
        const res = await pool.query(text, params as never[]);
        return { rows: res.rows as T[] };
      },
      async exec(sql: string) {
        await pool.query(sql);
      },
    };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(opts.pgliteDir, { recursive: true });
  const db = new PGlite(opts.pgliteDir);
  await db.waitReady;
  return {
    async query<T>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
      const res = await db.query(text, params as never[]);
      return { rows: res.rows as T[] };
    },
    async exec(sql: string) {
      await db.exec(sql);
    },
  };
}

/** Aplica migraciones .sql pendientes en orden, de forma idempotente. */
export async function migrate(db: DbClient): Promise<string[]> {
  const { readdirSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const dir = fileURLToPath(new URL('./migrations/', import.meta.url));
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  await db.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const applied = await db.query<{ name: string }>('SELECT name FROM _migrations');
  const done = new Set(applied.rows.map((r) => r.name));

  const ran: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = (await import('node:fs/promises')).readFile(`${dir}/${file}`, 'utf8');
    await db.exec('BEGIN');
    try {
      await db.exec(await sql);
      await db.exec(`INSERT INTO _migrations (name) VALUES ('${file.replace(/'/g, "''")}')`);
      await db.exec('COMMIT');
      ran.push(file);
    } catch (err) {
      await db.exec('ROLLBACK');
      throw err;
    }
  }
  return ran;
}
