import { z } from 'zod';

/**
 * Límites del data gateway (BD SQLite por app), configurados por el admin.
 * Defaults conservadores para una VM compartida.
 */
export const dbPolicySchema = z.object({
  /** Cuota de disco por app (MB del archivo de BD) */
  quotaMb: z.number().int().min(1).max(2048),
  /** Timeout de busy-wait por query (ms) */
  timeoutMs: z.number().int().min(100).max(60_000),
  /** Máximo de filas devueltas por query */
  maxRows: z.number().int().min(1).max(10_000),
  /** Requests de /db/query por minuto y usuario */
  rateLimitPerMin: z.number().int().min(1).max(10_000),
});

export type DbPolicy = z.infer<typeof dbPolicySchema>;

export const DEFAULT_DB_POLICY: DbPolicy = {
  quotaMb: 10,
  timeoutMs: 5_000,
  maxRows: 1_000,
  rateLimitPerMin: 60,
};

/** Códigos de error estables del data gateway (contrato del SDK). */
export const DB_ERROR_CODES = [
  'VCH_DB_UNAUTHENTICATED',
  'VCH_DB_FORBIDDEN',
  'VCH_DB_FORBIDDEN_STATEMENT',
  'VCH_DB_QUOTA_EXCEEDED',
  'VCH_DB_TIMEOUT',
  'VCH_DB_ROW_LIMIT',
  'VCH_DB_RATE_LIMITED',
  'VCH_DB_INTERNAL',
] as const;

export type DbErrorCode = (typeof DB_ERROR_CODES)[number];
