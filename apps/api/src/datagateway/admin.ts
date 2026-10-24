import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DbClient } from '../db.js';
import { dbPolicySchema, type DbPolicy } from '@vch/shared';
import { requireRole } from '../plugins/auth.js';
import { loadAppBySlug } from '../apps/access.js';
import { loadDbPolicy, saveDbPolicy } from './settings.js';

/** Acciones de administración del data gateway (con auditoría). */
export function datagatewayAdminRoutes(app: FastifyInstance, db: DbClient): void {
  const requireAdmin = requireRole(app, 'admin');

  async function audit(userId: number, action: string, target: string): Promise<void> {
    await db.query('INSERT INTO admin_actions (user_id, action, target) VALUES ($1, $2, $3)', [
      userId,
      action,
      target,
    ]);
  }

  async function requireApp(reply: FastifyReply, slug: string) {
    if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(slug)) {
      return { reply: reply.code(404).send({ error: 'App no encontrada.' }), appRow: undefined };
    }
    const appRow = await loadAppBySlug(db, slug);
    if (!appRow) {
      return { reply: reply.code(404).send({ error: 'App no encontrada.' }), appRow: undefined };
    }
    return { reply: undefined, appRow };
  }

  // ---------- límites configurables ----------
  app.get('/api/db-config', { preHandler: requireAdmin }, async () => {
    return { config: await loadDbPolicy(db) };
  });

  app.put('/api/db-config', { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = dbPolicySchema.safeParse(request.body);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return reply.code(400).send({ error: `Límites inválidos: ${detail}` });
    }
    await saveDbPolicy(db, parsed.data as DbPolicy);
    return { config: parsed.data };
  });

  // ---------- vista general de uso ----------
  app.get('/api/admin/db-overview', { preHandler: requireAdmin }, async () => {
    const res = await db.query<{
      slug: string;
      name: string;
      size_bytes: number | null;
      updated_at: string | null;
    }>(
      `SELECT a.slug, a.name, d.size_bytes, d.updated_at
       FROM apps a LEFT JOIN app_databases d ON d.app_id = a.id
       ORDER BY a.name ASC`,
    );
    return {
      databases: res.rows.map((r) => ({
        slug: r.slug,
        name: r.name,
        exists: r.size_bytes !== null,
        sizeBytes: Number(r.size_bytes ?? 0),
        updatedAt: r.updated_at,
      })),
    };
  });

  // ---------- detalle / descarga / reset por app ----------
  app.get('/api/admin/apps/:slug/database', { preHandler: requireAdmin }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const { reply: early, appRow } = await requireApp(reply, slug);
    if (early || !appRow) return early;
    const res = await db.query<{ size_bytes: number | null; updated_at: string | null; created_at: string | null }>(
      'SELECT size_bytes, updated_at, created_at FROM app_databases WHERE app_id = $1',
      [appRow.id],
    );
    const row = res.rows[0];
    return {
      database: {
        slug: appRow.slug,
        exists: !!row,
        sizeBytes: Number(row?.size_bytes ?? 0),
        updatedAt: row?.updated_at ?? null,
        createdAt: row?.created_at ?? null,
      },
    };
  });

  app.get(
    '/api/admin/apps/:slug/database/download',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const { reply: early, appRow } = await requireApp(reply, slug);
      if (early || !appRow) return early;

      // Cerrar la conexión fuerza un checkpoint del WAL: copia consistente.
      app.appDb.close(slug);
      const file = app.appDb.dbPath(slug);
      try {
        await fsp.access(file);
      } catch {
        return reply.code(404).send({ error: 'Esta app aún no tiene base de datos.' });
      }
      await audit(request.user!.id, 'db.download', slug);
      return reply
        .header('content-type', 'application/octet-stream')
        .header('content-disposition', `attachment; filename="${path.basename(slug)}-${new Date().toISOString().slice(0, 10)}.app.db"`)
        .header('x-content-type-options', 'nosniff')
        .send(fs.createReadStream(file));
    },
  );

  const resetSchema = z.object({ confirm: z.literal(true) });

  app.post(
    '/api/admin/apps/:slug/database/reset',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const parsed = resetSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'Confirmación requerida: {"confirm": true}.' });
      }
      const { reply: early, appRow } = await requireApp(reply, slug);
      if (early || !appRow) return early;

      await app.appDb.removeData(slug);
      await db.query('DELETE FROM app_databases WHERE app_id = $1', [appRow.id]);
      await audit(request.user!.id, 'db.reset', slug);
      return { ok: true };
    },
  );
}
