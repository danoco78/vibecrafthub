import path from 'node:path';
import fs from 'node:fs/promises';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { configFromEnv, type Config } from './config.js';
import { createDb, migrate, type DbClient } from './db.js';
import { authPlugin } from './plugins/auth.js';
import { authRoutes } from './auth/routes.js';
import { requireAuth } from './plugins/auth.js';
import { appsRoutes } from './apps/routes.js';
import { adminRoutes } from './admin/routes.js';

export async function buildApp(cfg: Config): Promise<{ app: FastifyInstance; db: DbClient }> {
  const app = Fastify({
    bodyLimit: 64 * 1024 * 1024,
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
  });

  const db = await createDb(cfg);
  const applied = await migrate(db);
  if (applied.length > 0) app.log.info({ applied }, 'migraciones aplicadas');

  app.decorate('db', db);
  app.decorate('cookieOpts', { domain: cfg.cookieDomain, secure: cfg.cookieSecure });

  await app.register(cookie);
  await app.register(multipart);

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/api/config', async () => ({ appsUrlTemplate: cfg.appsUrlTemplate }));

  authPlugin(app);
  authRoutes(app, db, cfg.sessionTtlDays);
  appsRoutes(app, db, cfg.bundlesDir);
  adminRoutes(app, db);

  // Servir bundles directamente (modo dev sin gateway; producción lo hace Caddy con forward_auth).
  if (!cfg.databaseUrl) {
    app.get('/bundles/:slug/*', { preHandler: requireAuth(app) }, async (request, reply) => {
      const { slug, '*': rel } = request.params as { slug: string; '*': string };
      if (!/^[a-z0-9-]+$/.test(slug)) return reply.code(404).send();
      const base = path.resolve(cfg.bundlesDir, slug, 'active');
      const target = path.resolve(base, rel);
      if (target !== base && !target.startsWith(base + path.sep)) {
        return reply.code(404).send();
      }
      try {
        const data = await fs.readFile(target);
        const ext = path.extname(target).toLowerCase();
        const mimes: Record<string, string> = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'text/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.xml': 'application/xml; charset=utf-8',
          '.sqlite': 'application/octet-stream',
        };
        reply
          .header('content-type', mimes[ext] ?? 'application/octet-stream')
          .header('x-content-type-options', 'nosniff')
          .header(
            'content-security-policy',
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'",
          );
        return data;
      } catch {
        return reply.code(404).send();
      }
    });
  }

  app.setErrorHandler((err: FastifyError, request, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return reply.code(status).send({ error: err.message });
    }
    request.log.error(err);
    return reply.code(500).send({ error: 'Error interno del servidor.' });
  });

  return { app, db };
}

async function main(): Promise<void> {
  const cfg = configFromEnv();
  const { app } = await buildApp(cfg);
  const mode = cfg.databaseUrl ? 'postgres' : 'pglite (dev)';
  app.log.info(`arrancando con driver: ${mode}`);
  await app.listen({ port: cfg.port, host: cfg.host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
