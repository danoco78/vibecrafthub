import { z } from 'zod';
import type { Severity } from './finding.js';

/**
 * Política de publicación configurada por el admin de la empresa.
 */
export const policySchema = z.object({
  /** Severidades que bloquean una publicación */
  blockSeverities: z.array(z.enum(['critical', 'high', 'medium', 'low'])).min(0),
  maxBundleMb: z.number().int().min(1).max(200),
  maxFiles: z.number().int().min(1).max(10000),
});

export type Policy = z.infer<typeof policySchema>;

export const DEFAULT_POLICY: Policy = {
  blockSeverities: ['critical', 'high'],
  maxBundleMb: 20,
  maxFiles: 500,
};

export function blocksPublish(policy: Policy, severity: Severity): boolean {
  return (policy.blockSeverities as string[]).includes(severity);
}
