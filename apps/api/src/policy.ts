import { DEFAULT_POLICY, policySchema, type Policy } from '@vch/shared';
import type { DbClient } from './db.js';

/** Carga la política de publicación (fila única). Si falta o es inválida, usa la default. */
export async function loadPolicy(db: DbClient): Promise<Policy> {
  try {
    const res = await db.query<{
      block_severities: string[];
      max_bundle_mb: number;
      max_files: number;
    }>('SELECT block_severities, max_bundle_mb, max_files FROM policy WHERE id = 1');
    const row = res.rows[0];
    if (!row) return DEFAULT_POLICY;
    const parsed = policySchema.safeParse({
      blockSeverities: row.block_severities,
      maxBundleMb: row.max_bundle_mb,
      maxFiles: row.max_files,
    });
    return parsed.success ? parsed.data : DEFAULT_POLICY;
  } catch {
    return DEFAULT_POLICY;
  }
}
