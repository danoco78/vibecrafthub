import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '../db.js';
import { requireRole } from '../plugins/auth.js';
import { hashPassword, validatePasswordStrength } from '../auth/passwords.js';
import { policySchema, type Policy } from '@vch/shared';
import { DEFAULT_LLM_BASE_URL, loadLlmConfig, maskApiKey } from '../llm.js';

const ROLES = ['admin', 'developer', 'user'] as const;
type Role = (typeof ROLES)[number];

const createUserSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
  role: z.enum(ROLES),
});

const llmConfigSchema = z
  .object({
    enabled: z.boolean(),
    provider: z.enum(['openai', 'anthropic']),
    /** Vacío = usa la URL por defecto del proveedor (útil para locales con URL propia) */
    baseUrl: z
      .string()
      .trim()
      .max(300)
      .refine((v) => v === '' || /^https?:\/\//.test(v), 'baseUrl debe iniciar con http:// o https://'),
    model: z.string().trim().max(120),
    /** Vacío/ausente = conserva la clave existente */
    apiKey: z.string().max(400).optional(),
    onUnavailable: z.enum(['continue', 'block']),
  })
  .refine((c) => !c.enabled || c.model !== '', {
    message: 'El nombre del modelo es obligatorio cuando la revisión LLM está activa.',
    path: ['model'],
  });

export function adminRoutes(app: FastifyInstance, db: DbClient): void {
  const requireAdmin = requireRole(app, 'admin');

  app.get('/api/admin/users', { preHandler: requireAdmin }, async () => {
    const res = await db.query<{ id: number; email: string; role: Role; created_at: string }>(
      'SELECT id, email, role, created_at FROM users ORDER BY created_at ASC',
    );
    return { users: res.rows };
  });

  app.post('/api/admin/users', { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Datos inválidos: email, password (8+) y role son requeridos.' });
    }
    const strengthError = validatePasswordStrength(parsed.data.password);
    if (strengthError) return reply.code(400).send({ error: strengthError });

    const email = parsed.data.email.toLowerCase().trim();
    try {
      const passwordHash = await hashPassword(parsed.data.password);
      const res = await db.query<{ id: number; email: string; role: Role }>(
        'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role',
        [email, passwordHash, parsed.data.role],
      );
      return reply.code(201).send({ user: res.rows[0] });
    } catch (err) {
      if (err instanceof Error && /unique|duplicate/i.test(err.message)) {
        return reply.code(409).send({ error: 'Ya existe un usuario con ese email.' });
      }
      throw err;
    }
  });

  app.get('/api/policy', { preHandler: requireAdmin }, async () => {
    const res = await db.query<{ block_severities: string[]; max_bundle_mb: number; max_files: number }>(
      'SELECT block_severities, max_bundle_mb, max_files FROM policy WHERE id = 1',
    );
    const row = res.rows[0];
    return {
      policy: {
        blockSeverities: row?.block_severities ?? ['critical', 'high'],
        maxBundleMb: row?.max_bundle_mb ?? 20,
        maxFiles: row?.max_files ?? 500,
      },
    };
  });

  app.put('/api/policy', { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = policySchema.safeParse(request.body);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return reply.code(400).send({ error: `Política inválida: ${detail}` });
    }
    const p: Policy = parsed.data;
    await db.query('UPDATE policy SET block_severities = $1, max_bundle_mb = $2, max_files = $3 WHERE id = 1', [
      p.blockSeverities,
      p.maxBundleMb,
      p.maxFiles,
    ]);
    return { policy: p };
  });

  // ---------- revisión LLM ----------
  app.get('/api/llm-config', { preHandler: requireAdmin }, async () => {
    const cfg = await loadLlmConfig(db);
    return {
      config: {
        enabled: cfg.enabled,
        provider: cfg.provider,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        apiKeyMasked: maskApiKey(cfg.apiKey),
        onUnavailable: cfg.onUnavailable,
      },
    };
  });

  app.put('/api/llm-config', { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = llmConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return reply.code(400).send({ error: `Configuración LLM inválida: ${detail}` });
    }
    const data = parsed.data;
    const existing = await loadLlmConfig(db);
    // Clave vacía = conservar la actual (no se re-expone en el portal)
    const apiKey = data.apiKey && data.apiKey.length > 0 ? data.apiKey : existing.apiKey;
    const baseUrl = data.baseUrl || DEFAULT_LLM_BASE_URL[data.provider];
    await db.query(
      `UPDATE llm_config
       SET enabled = $1, provider = $2, base_url = $3, model = $4, api_key = $5, on_unavailable = $6, updated_at = now()
       WHERE id = 1`,
      [data.enabled, data.provider, baseUrl, data.model, apiKey, data.onUnavailable],
    );
    return {
      config: {
        enabled: data.enabled,
        provider: data.provider,
        baseUrl,
        model: data.model,
        apiKeyMasked: maskApiKey(apiKey),
        onUnavailable: data.onUnavailable,
      },
    };
  });
}
