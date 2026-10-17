import type { FastifyRequest } from 'fastify';
import type { DbClient } from '../db.js';
import type { SessionUser } from '../auth/sessions.js';

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

/**
 * Extrae el slug de un Host del wildcard de apps (ej: "inventario.apps.empresa.com"
 * con sufijo ".apps.empresa.com" → "inventario"). Null si el host no es de apps.
 */
export function slugFromHost(host: string, suffix: string): string | null {
  if (!suffix) return null;
  const idx = host.indexOf(suffix);
  if (idx <= 0) return null;
  const slug = host.slice(0, idx);
  return SLUG_RE.test(slug) ? slug : null;
}

export interface AppAccessRow {
  id: number;
  slug: string;
  name: string;
  visibility: 'public' | 'private';
  owner_id: number;
  current_version_id: number | null;
}

export async function loadAppBySlug(db: DbClient, slug: string): Promise<AppAccessRow | undefined> {
  const res = await db.query<AppAccessRow>(
    'SELECT id, slug, name, visibility, owner_id, current_version_id FROM apps WHERE slug = $1',
    [slug],
  );
  return res.rows[0];
}

export async function isAppMember(db: DbClient, appId: number, userId: number): Promise<boolean> {
  const res = await db.query(
    'SELECT 1 FROM app_members WHERE app_id = $1 AND user_id = $2',
    [appId, userId],
  );
  return res.rows.length > 0;
}

/**
 * ¿Puede el usuario VER/USAR la app?: pública, propia, admin, o en la allowlist.
 * Una función única para catálogo, forward_auth y data gateway.
 */
export async function canAccessApp(
  db: DbClient,
  app: AppAccessRow,
  user: SessionUser,
): Promise<boolean> {
  if (app.visibility === 'public') return true;
  if (app.owner_id === user.id || user.role === 'admin') return true;
  return isAppMember(db, app.id, user.id);
}

/** ¿Puede administrar la app (visibilidad, allowlist, publicar, eliminar)?: dueño o admin. */
export function canManageApp(app: AppAccessRow, request: FastifyRequest): boolean {
  const user = request.user!;
  return app.owner_id === user.id || user.role === 'admin';
}
