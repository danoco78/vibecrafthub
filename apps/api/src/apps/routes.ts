import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DbClient } from '../db.js';
import { requireAuth, requireRole } from '../plugins/auth.js';
import { loadPolicy } from '../policy.js';
import { canManageApp, isAppMember } from './access.js';
import { loadExternalAllowlist } from '../domains/allowlist.js';
import { persistAttempt, publishBundle } from './publish.js';
import { setActiveVersion } from './storage.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

export function slugify(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'app';
}

interface AppRow {
  id: number;
  slug: string;
  name: string;
  description: string;
  owner_id: number;
  visibility: 'public' | 'private';
  current_version_id: number | null;
  owner_email: string;
  current_version: string | null;
}

async function loadApp(db: DbClient, slug: string): Promise<AppRow | undefined> {
  const res = await db.query<AppRow>(
    `SELECT a.id, a.slug, a.name, a.description, a.owner_id, a.visibility, a.current_version_id,
            u.email AS owner_email, v.version AS current_version
     FROM apps a
     JOIN users u ON u.id = a.owner_id
     LEFT JOIN app_versions v ON v.id = a.current_version_id
     WHERE a.slug = $1`,
    [slug],
  );
  return res.rows[0];
}

/** El usuario puede ver la app: pública, propia, admin o en la allowlist (privadas). */
async function canSee(db: DbClient, app: AppRow, request: FastifyRequest): Promise<boolean> {
  const user = request.user!;
  if (app.visibility === 'public' || app.owner_id === user.id || user.role === 'admin') {
    return true;
  }
  return isAppMember(db, app.id, user.id);
}

/** El usuario puede administrar la app: dueño o admin. */
function canManage(app: AppRow, request: FastifyRequest): boolean {
  return canManageApp(app, request);
}

const createAppSchema = z.object({
  name: z.string().min(2).max(64),
  description: z.string().max(500).optional(),
});

export function appsRoutes(
  app: FastifyInstance,
  db: DbClient,
  bundlesDir: string,
): void {
  const requireDevOrAdmin = requireRole(app, 'admin', 'developer');

  // ---------- catálogo ----------
  app.get('/api/apps', { preHandler: requireAuth(app) }, async (request) => {
    const res = await db.query<AppRow>(
      `SELECT a.id, a.slug, a.name, a.description, a.owner_id, a.visibility, a.current_version_id,
              u.email AS owner_email, v.version AS current_version
       FROM apps a
       JOIN users u ON u.id = a.owner_id
       LEFT JOIN app_versions v ON v.id = a.current_version_id
       WHERE a.visibility = 'public' OR a.owner_id = $1 OR $2 = 'admin'
              OR EXISTS (SELECT 1 FROM app_members m WHERE m.app_id = a.id AND m.user_id = $1)
       ORDER BY a.created_at DESC`,
      [request.user!.id, request.user!.role],
    );
    return { apps: res.rows };
  });

  app.post('/api/apps', { preHandler: requireDevOrAdmin }, async (request, reply) => {
    const parsed = createAppSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Nombre requerido (2-64 caracteres).' });
    }
    const name = parsed.data.name.trim();
    let slug = slugify(name);
    for (let i = 2; ; i++) {
      const exists = await db.query('SELECT id FROM apps WHERE slug = $1', [slug]);
      if (exists.rows.length === 0) break;
      slug = `${slugify(name)}-${i}`;
    }
    const inserted = await db.query<{ id: number; slug: string }>(
      'INSERT INTO apps (slug, name, description, owner_id) VALUES ($1, $2, $3, $4) RETURNING id, slug',
      [slug, name, parsed.data.description ?? '', request.user!.id],
    );
    return reply.code(201).send({ app: inserted.rows[0] });
  });

  app.get('/api/apps/:slug', { preHandler: requireAuth(app) }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    if (!SLUG_RE.test(slug)) return reply.code(404).send({ error: 'App no encontrada.' });
    const appRow = await loadApp(db, slug);
    if (!appRow || !(await canSee(db, appRow, request))) {
      return reply.code(404).send({ error: 'App no encontrada.' });
    }
    // Dominios externos declarados por la versión activa + estado de aprobación (v0.3)
    const extRes = await db.query<{ external_domains: string[] | null }>(
      `SELECT v.external_domains FROM app_versions v WHERE v.id = $1`,
      [appRow.current_version_id],
    );
    const allowlist = await loadExternalAllowlist(db);
    const externalDomains = (extRes.rows[0]?.external_domains ?? []).map((d) => ({
      declared: d,
      approved: allowlist.includes(d),
    }));
    return { app: { ...appRow, externalDomains } };
  });

  // ---------- ajustes (visibilidad, descripción) ----------
  const updateAppSchema = z.object({
    visibility: z.enum(['public', 'private']).optional(),
    description: z.string().max(500).optional(),
  });

  app.patch('/api/apps/:slug', { preHandler: requireDevOrAdmin }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const appRow = await loadApp(db, slug);
    if (!appRow || !canManage(appRow, request)) {
      return reply.code(404).send({ error: 'App no encontrada.' });
    }
    const parsed = updateAppSchema.safeParse(request.body);
    if (!parsed.success || (parsed.data.visibility === undefined && parsed.data.description === undefined)) {
      return reply.code(400).send({ error: 'Nada que actualizar: visibility y/o description.' });
    }
    const { visibility, description } = parsed.data;
    await db.query('UPDATE apps SET visibility = COALESCE($1, visibility), description = COALESCE($2, description) WHERE id = $3', [
      visibility ?? null,
      description ?? null,
      appRow.id,
    ]);
    return { app: { ...appRow, visibility: visibility ?? appRow.visibility, description: description ?? appRow.description } };
  });

  // ---------- allowlist de apps privadas ----------
  app.get('/api/apps/:slug/members', { preHandler: requireAuth(app) }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const appRow = await loadApp(db, slug);
    if (!appRow || !canManage(appRow, request)) {
      return reply.code(404).send({ error: 'App no encontrada.' });
    }
    const res = await db.query<{ user_id: number; email: string; added_at: string }>(
      `SELECT m.user_id, u.email, m.created_at AS added_at
       FROM app_members m JOIN users u ON u.id = m.user_id
       WHERE m.app_id = $1 ORDER BY u.email ASC`,
      [appRow.id],
    );
    return { members: res.rows };
  });

  app.post('/api/apps/:slug/members', { preHandler: requireDevOrAdmin }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const appRow = await loadApp(db, slug);
    if (!appRow || !canManage(appRow, request)) {
      return reply.code(404).send({ error: 'App no encontrada.' });
    }
    const parsed = z.object({ email: z.string().email().max(254) }).safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Email válido requerido.' });
    }
    const email = parsed.data.email.toLowerCase().trim();
    const user = await db.query<{ id: number; email: string }>(
      'SELECT id, email FROM users WHERE email = $1',
      [email],
    );
    if (user.rows.length === 0) {
      return reply.code(404).send({ error: `No existe un usuario con email ${email}.` });
    }
    const target = user.rows[0];
    if (target.id === appRow.owner_id) {
      return reply.code(409).send({ error: 'El dueño de la app ya tiene acceso.' });
    }
    const dup = await db.query('SELECT 1 FROM app_members WHERE app_id = $1 AND user_id = $2', [
      appRow.id,
      target.id,
    ]);
    if (dup.rows.length > 0) {
      return reply.code(409).send({ error: `${email} ya está en la allowlist.` });
    }
    await db.query('INSERT INTO app_members (app_id, user_id) VALUES ($1, $2)', [
      appRow.id,
      target.id,
    ]);
    return reply.code(201).send({ member: { user_id: target.id, email: target.email } });
  });

  app.delete('/api/apps/:slug/members/:userId', { preHandler: requireDevOrAdmin }, async (request, reply) => {
    const { slug, userId } = request.params as { slug: string; userId: string };
    const appRow = await loadApp(db, slug);
    if (!appRow || !canManage(appRow, request)) {
      return reply.code(404).send({ error: 'App no encontrada.' });
    }
    const id = Number(userId);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Id inválido.' });
    await db.query('DELETE FROM app_members WHERE app_id = $1 AND user_id = $2', [
      appRow.id,
      id,
    ]);
    return { ok: true };
  });

  // ---------- versiones ----------
  app.get('/api/apps/:slug/versions', { preHandler: requireAuth(app) }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const appRow = await loadApp(db, slug);
    if (!appRow || !(await canSee(db, appRow, request))) {
      return reply.code(404).send({ error: 'App no encontrada.' });
    }
    const res = await db.query(
      `SELECT id, version, bundle_hash, status, created_at
       FROM app_versions WHERE app_id = $1 ORDER BY created_at DESC`,
      [appRow.id],
    );
    return { versions: res.rows };
  });

  app.post(
    '/api/apps/:slug/versions/:id/activate',
    { preHandler: requireDevOrAdmin },
    async (request, reply) => {
      const { slug, id } = request.params as { slug: string; id: string };
      const appRow = await loadApp(db, slug);
      if (!appRow || !canManage(appRow, request)) {
        return reply.code(404).send({ error: 'App no encontrada.' });
      }
      const versionId = Number(id);
      if (!Number.isInteger(versionId)) {
        return reply.code(400).send({ error: 'Id de versión inválido.' });
      }
      const version = await db.query<{ id: number; version: string }>(
        'SELECT id, version FROM app_versions WHERE id = $1 AND app_id = $2',
        [versionId, appRow.id],
      );
      if (version.rows.length === 0) {
        return reply.code(404).send({ error: 'Versión no encontrada.' });
      }
      await db.query("UPDATE app_versions SET status = 'published' WHERE app_id = $1 AND status = 'active'", [
        appRow.id,
      ]);
      await db.query("UPDATE app_versions SET status = 'active' WHERE id = $1", [versionId]);
      await db.query('UPDATE apps SET current_version_id = $1 WHERE id = $2', [versionId, appRow.id]);
      await setActiveVersion(bundlesDir, appRow.slug, version.rows[0].version);
      return { ok: true };
    },
  );

  // ---------- publicación ----------
  app.post(
    '/api/apps/:slug/publish',
    { preHandler: requireDevOrAdmin },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const appRow = await loadApp(db, slug);
      if (!appRow || !canManage(appRow, request)) {
        return reply.code(404).send({ error: 'App no encontrada.' });
      }
      const policy = await loadPolicy(db);
      const maxBytes = (policy.maxBundleMb + 2) * 1024 * 1024;

      const file = await request.file({ limits: { files: 1, fileSize: maxBytes } });
      if (!file) {
        return reply.code(400).send({ error: 'Se esperaba un archivo zip en el campo "bundle".' });
      }

      const chunks: Buffer[] = [];
      let size = 0;
      let tooLarge = false;
      try {
        for await (const chunk of file.file) {
          size += chunk.length;
          if (size > maxBytes) {
            tooLarge = true;
            break;
          }
          chunks.push(chunk as Buffer);
        }
      } catch {
        // stream cortado: se trata como bundle vacío y el pipeline lo rechaza
      }

      if (tooLarge) {
        const outcome = await persistAttempt(
          db,
          appRow.id,
          request.user!.id,
          null,
          'rejected',
          [
            {
              rule: 'upload-size',
              severity: 'critical',
              file: 'bundle',
              line: 0,
              message: `El archivo supera el máximo de ${policy.maxBundleMb} MB.`,
              fix: 'Reduce el tamaño del bundle y vuelve a intentarlo.',
            },
          ],
          '',
        );
        return reply.code(413).send(outcome);
      }

      const buffer = Buffer.concat(chunks);
      const outcome = await publishBundle(
        db,
        appRow,
        request.user!.id,
        buffer,
        policy,
        bundlesDir,
      );
      return outcome;
    },
  );

  // ---------- eliminación de app ----------
  app.delete('/api/apps/:slug', { preHandler: requireDevOrAdmin }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const appRow = await loadApp(db, slug);
    if (!appRow || !canManage(appRow, request)) {
      return reply.code(404).send({ error: 'App no encontrada.' });
    }
    // NULL antes del DELETE: current_version_id referencia app_versions, que cascada con apps
    await db.query('UPDATE apps SET current_version_id = NULL WHERE id = $1', [appRow.id]);
    await db.query('DELETE FROM apps WHERE id = $1', [appRow.id]);
    await fs.rm(path.join(bundlesDir, appRow.slug), { recursive: true, force: true });
    // La BD de la app (data gateway) se elimina con ella. app_databases cae por FK cascade.
    await app.appDb.removeData(appRow.slug);
    return { ok: true };
  });

  // ---------- historial de intentos ----------
  app.get('/api/apps/:slug/attempts', { preHandler: requireAuth(app) }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const appRow = await loadApp(db, slug);
    if (!appRow || !(await canSee(db, appRow, request))) {
      return reply.code(404).send({ error: 'App no encontrada.' });
    }
    if (!canManage(appRow, request)) {
      return reply.code(403).send({ error: 'Solo el dueño o un admin puede ver el historial completo.' });
    }
    const res = await db.query(
      `SELECT pa.id, pa.verdict, pa.created_at, pa.bundle_hash,
              u.email AS user_email, v.version
       FROM publish_attempts pa
       JOIN users u ON u.id = pa.user_id
       LEFT JOIN app_versions v ON v.id = pa.version_id
       WHERE pa.app_id = $1
       ORDER BY pa.created_at DESC
       LIMIT 200`,
      [appRow.id],
    );
    return { attempts: res.rows };
  });

  // El historial global es solo para admin y developer (los usuarios no publican).
  const requireStaff = requireRole(app, 'admin', 'developer');

  app.get('/api/attempts', { preHandler: requireStaff }, async (request) => {
    const user = request.user!;
    const filter = user.role === 'admin' ? '' : 'WHERE pa.user_id = $1';
    const params = user.role === 'admin' ? [] : [user.id];
    const res = await db.query(
      `SELECT pa.id, pa.verdict, pa.created_at, a.slug AS app_slug, a.name AS app_name,
              u.email AS user_email, v.version
       FROM publish_attempts pa
       JOIN apps a ON a.id = pa.app_id
       JOIN users u ON u.id = pa.user_id
       LEFT JOIN app_versions v ON v.id = pa.version_id
       ${filter}
       ORDER BY pa.created_at DESC
       LIMIT 200`,
      params,
    );
    return { attempts: res.rows };
  });

  app.get('/api/attempts/:id', { preHandler: requireStaff }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'Id inválido.' });
    const res = await db.query(
      `SELECT pa.*, a.slug AS app_slug, a.owner_id, u.email AS user_email
       FROM publish_attempts pa
       JOIN apps a ON a.id = pa.app_id
       JOIN users u ON u.id = pa.user_id
       WHERE pa.id = $1`,
      [id],
    );
    const attempt = res.rows[0];
    if (!attempt) return reply.code(404).send({ error: 'Intento no encontrado.' });
    const user = request.user!;
    if (attempt.user_id !== user.id && attempt.owner_id !== user.id && user.role !== 'admin') {
      return reply.code(403).send({ error: 'Sin permisos para ver este intento.' });
    }
    return { attempt };
  });
}
