import type { DbClient } from '../db.js';
import { loadExternalAllowlist } from './allowlist.js';

/**
 * CSP por app (docs/design-v0.3.md §5.3):
 * base estricta de la plataforma + https://dominio en connect-src e img-src
 * por cada dominio externo APROBADO de la versión activa de la app.
 * Resolución con caché de 60 s: quitar un dominio de la allowlist aplica al vuelo.
 */

export function buildAppCsp(approvedDomains: string[], frameAncestors?: string): string {
  const external = approvedDomains.map((d) => `https://${d}`).join(' ');
  const directives = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data:${external ? ` ${external}` : ''}`,
    `connect-src 'self'${external ? ` ${external}` : ''}`,
    "object-src 'none'",
    'base-uri \'self\'',
  ];
  if (frameAncestors) directives.push(`frame-ancestors ${frameAncestors}`);
  return directives.join('; ');
}

const RESOLVE_TTL_MS = 60_000;
const domainCache = new Map<string, { at: number; domains: string[] }>();
let allowlistCache: { at: number; domains: string[] } | null = null;

async function cachedAllowlist(db: DbClient): Promise<string[]> {
  if (allowlistCache && Date.now() - allowlistCache.at < RESOLVE_TTL_MS) {
    return allowlistCache.domains;
  }
  const domains = await loadExternalAllowlist(db);
  allowlistCache = { at: Date.now(), domains };
  return domains;
}

/** Dominios externos APROBADOS de la versión activa de la app (declarados ∩ allowlist). */
export async function resolveApprovedDomains(db: DbClient, slug: string): Promise<string[]> {
  const cached = domainCache.get(slug);
  if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) return cached.domains;

  const res = await db.query<{ external_domains: string[] | null }>(
    `SELECT v.external_domains
     FROM apps a JOIN app_versions v ON v.id = a.current_version_id
     WHERE a.slug = $1`,
    [slug],
  );
  const declared = (res.rows[0]?.external_domains ?? []) as string[];
  const approved = new Set(await cachedAllowlist(db));
  const domains = declared.filter((d) => approved.has(d));
  domainCache.set(slug, { at: Date.now(), domains });
  return domains;
}

export function invalidateDomainCaches(): void {
  domainCache.clear();
  allowlistCache = null;
}
