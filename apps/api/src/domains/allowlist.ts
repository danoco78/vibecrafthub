import type { DbClient } from '../db.js';

/** Dominios aprobados por el admin (allowlist global para el scanner y la CSP). */
export async function loadExternalAllowlist(db: DbClient): Promise<string[]> {
  try {
    const res = await db.query<{ domain: string }>(
      'SELECT domain FROM external_domain_allowlist ORDER BY domain ASC',
    );
    return res.rows.map((r) => r.domain);
  } catch {
    return [];
  }
}
