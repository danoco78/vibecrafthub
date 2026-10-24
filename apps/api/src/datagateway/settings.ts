import { DEFAULT_DB_POLICY, dbPolicySchema, type DbPolicy } from '@vch/shared';
import type { DbClient } from '../db.js';

/** Carga los límites del gateway (fila única). Si falta o es inválida, usa la default. */
export async function loadDbPolicy(db: DbClient): Promise<DbPolicy> {
  try {
    const res = await db.query<{
      quota_mb: number;
      timeout_ms: number;
      max_rows: number;
      rate_limit_per_min: number;
    }>('SELECT quota_mb, timeout_ms, max_rows, rate_limit_per_min FROM db_config WHERE id = 1');
    const row = res.rows[0];
    if (!row) return DEFAULT_DB_POLICY;
    const parsed = dbPolicySchema.safeParse({
      quotaMb: row.quota_mb,
      timeoutMs: row.timeout_ms,
      maxRows: row.max_rows,
      rateLimitPerMin: row.rate_limit_per_min,
    });
    return parsed.success ? parsed.data : DEFAULT_DB_POLICY;
  } catch {
    return DEFAULT_DB_POLICY;
  }
}

export async function saveDbPolicy(db: DbClient, policy: DbPolicy): Promise<void> {
  await db.query(
    `UPDATE db_config SET quota_mb = $1, timeout_ms = $2, max_rows = $3, rate_limit_per_min = $4, updated_at = now()
     WHERE id = 1`,
    [policy.quotaMb, policy.timeoutMs, policy.maxRows, policy.rateLimitPerMin],
  );
}
