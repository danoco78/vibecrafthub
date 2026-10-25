import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DbClient } from '../db.js';
import type { Config } from '../config.js';
import { canAccessApp, loadAppBySlug, SLUG_RE, slugFromHost } from '../apps/access.js';
import { classifyStatement, executeStatement, VchDbError } from './engine.js';
import { loadDbPolicy } from './settings.js';
import { count } from '../metrics/collector.js';
import { SDK_JS } from './sdk.js';

/**
 * Rutas del data gateway (v0.2).
 *
 * Producción: Caddy enruta "{slug}.apps" + "/db" hacia api:3000, y el slug
 * se resuelve por el Host (NUNCA por input del cliente).
 * Dev sin gateway: "/bundles/{slug}/db" con el slug en el path (mismo origen).
 */

const MAX_SQL_BYTES = 100 * 1024;

/** Rate limit por app+usuario (MVP monoproceso, mismo patrón que el login). */
class RateLimiter {
  private hits = new Map<string, { count: number; firstAt: number }>();

  allow(key: string, limitPerMin: number): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || now - entry.firstAt > 60_000) {
      this.hits.set(key, { count: 1, firstAt: now });
      if (this.hits.size > 10_000) this.hits.clear(); // techo de memoria
      return true;
    }
    entry.count++;
    return entry.count <= limitPerMin;
  }
}

interface QueryBody {
  sql?: unknown;
  params?: unknown;
  mode?: unknown;
}

export function datagatewayRoutes(app: FastifyInstance, db: DbClient, cfg: Config): void {
  const limiter = new RateLimiter();

  function replyError(reply: FastifyReply, err: VchDbError): FastifyReply {
    return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
  }

  async function serveSdk(reply: FastifyReply): Promise<FastifyReply> {
    return reply
      .header('content-type', 'application/javascript; charset=utf-8')
      .header('cache-control', 'public, max-age=300')
      .header('x-content-type-options', 'nosniff')
      .send(SDK_JS);
  }

  async function handleQuery(request: FastifyRequest, reply: FastifyReply, slug: string) {
    if (!request.user) {
      return replyError(
        reply,
        new VchDbError('VCH_DB_UNAUTHENTICATED', 'Se requiere sesión del portal.', 401),
      );
    }

    const policy = await loadDbPolicy(db);
    if (!limiter.allow(`${slug}|${request.user.id}`, policy.rateLimitPerMin)) {
      return replyError(
        reply,
        new VchDbError('VCH_DB_RATE_LIMITED', 'Demasiadas queries. Espera un momento.', 429),
      );
    }

    const appRow = await loadAppBySlug(db, slug);
    if (!appRow || appRow.current_version_id === null) {
      return replyError(reply, new VchDbError('VCH_DB_FORBIDDEN', 'App inexistente o sin versión activa.', 403));
    }
    if (!(await canAccessApp(db, appRow, request.user))) {
      return replyError(reply, new VchDbError('VCH_DB_FORBIDDEN', 'No tienes acceso a esta app.', 403));
    }

    const body = request.body as QueryBody;
    const sql = typeof body?.sql === 'string' ? body.sql : '';
    if (sql.length === 0 || sql.length > MAX_SQL_BYTES) {
      return replyError(
        reply,
        new VchDbError('VCH_DB_FORBIDDEN_STATEMENT', 'sql requerido (máx. 100 KB).'),
      );
    }
    const mode = body.mode === 'get' ? 'get' : body.mode === 'run' ? 'run' : 'all';

    let kind;
    try {
      kind = classifyStatement(sql);
    } catch (err) {
      return replyError(reply, err as VchDbError);
    }
    if (kind === null) {
      return replyError(
        reply,
        new VchDbError(
          'VCH_DB_FORBIDDEN_STATEMENT',
          'Statement no permitido. Allowlist: SELECT/INSERT/UPDATE/DELETE y CREATE/ALTER/DROP TABLE·INDEX·VIEW.',
        ),
      );
    }
    // El modo pedido debe coincidir con el tipo real del statement.
    const wantsWrite = mode === 'run';
    const isWrite = kind !== 'read';
    if (wantsWrite !== isWrite) {
      return replyError(
        reply,
        new VchDbError(
          'VCH_DB_FORBIDDEN_STATEMENT',
          wantsWrite
            ? 'VCH.db.run() es solo para INSERT/UPDATE/DELETE/DDL.'
            : 'Este statement modifica datos: usa VCH.db.run().',
        ),
      );
    }

    const conn = app.appDb.open(slug, { busyTimeoutMs: policy.timeoutMs });
    let result;
    try {
      result = executeStatement(conn, sql, kind, body.params, policy);
      count('dbquery.ok', slug);
    } catch (err) {
      count('dbquery.error', slug);
      if (err instanceof VchDbError) return replyError(reply, err);
      request.log.error(err);
      return replyError(reply, new VchDbError('VCH_DB_INTERNAL', 'Error ejecutando el statement.', 500));
    }

    // Metadatos de uso (tamaño/actualización) tras cada escritura exitosa.
    if (result.kind === 'write') {
      await db.query(
        `INSERT INTO app_databases (app_id, size_bytes, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (app_id) DO UPDATE SET size_bytes = $2, updated_at = now()`,
        [appRow.id, result.sizeBytes],
      );
    }

    if (result.kind === 'read') {
      if (mode === 'get') return { row: result.rows[0] ?? null, truncated: result.truncated };
      return { rows: result.rows, truncated: result.truncated };
    }
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }

  // ---------- Producción: /db/* en el API, slug resuelto por Host ----------
  app.get('/db/sdk.js', async (_request, reply) => serveSdk(reply));

  app.post(
    '/db/query',
    { bodyLimit: 1024 * 1024 },
    async (request, reply) => {
      const slug = slugFromHost(request.hostname, cfg.appsHostSuffix);
      if (!slug) {
        return replyError(
          reply,
          new VchDbError('VCH_DB_FORBIDDEN', 'Host no reconocido como app publicada.', 403),
        );
      }
      return handleQuery(request, reply, slug);
    },
  );

  // ---------- Dev sin gateway: /bundles/{slug}/db/* (slug en el path) ----------
  if (!cfg.databaseUrl) {
    app.get('/bundles/:slug/db/sdk.js', async (request, reply) => {
      const { slug } = request.params as { slug: string };
      if (!SLUG_RE.test(slug)) return reply.code(404).send();
      return serveSdk(reply);
    });

    app.post(
      '/bundles/:slug/db/query',
      { bodyLimit: 1024 * 1024 },
      async (request, reply) => {
        const { slug } = request.params as { slug: string };
        if (!SLUG_RE.test(slug)) {
          return replyError(reply, new VchDbError('VCH_DB_FORBIDDEN', 'App inexistente.', 403));
        }
        return handleQuery(request, reply, slug);
      },
    );
  }
}
