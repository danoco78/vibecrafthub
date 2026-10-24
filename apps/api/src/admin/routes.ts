import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '../db.js';
import { requireRole } from '../plugins/auth.js';
import { hashPassword, validatePasswordStrength } from '../auth/passwords.js';
import { policySchema, type Policy } from '@vch/shared';
import { DEFAULT_LLM_BASE_URL, loadLlmConfig, maskApiKey } from '../llm.js';
import { ldapConfigSchema, maskSecret, type LdapConfig } from '@vch/shared';
import { loadLdapConfig, saveLdapConfig } from '../ldap/settings.js';
import { testLdapConnection } from '../auth/ldap.js';

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
    const res = await db.query<{ id: number; email: string; role: Role; active: boolean; created_at: string; auth_source: 'local' | 'ldap' }>(
      'SELECT id, email, role, active, created_at, auth_source FROM users ORDER BY created_at ASC',
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

  /** Activa/desactiva un usuario. Nadie puede desactivarse a sí mismo. */
  app.put('/api/admin/users/:id/active', { preHandler: requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = z.object({ active: z.boolean() }).safeParse(request.body);
    if (!Number.isInteger(id) || !parsed.success) {
      return reply.code(400).send({ error: 'Datos inválidos.' });
    }
    if (!parsed.data.active && id === request.user!.id) {
      return reply.code(400).send({ error: 'No puedes desactivar tu propia cuenta.' });
    }
    const res = await db.query<{ id: number; email: string; role: Role; active: boolean }>(
      'UPDATE users SET active = $1 WHERE id = $2 RETURNING id, email, role, active',
      [parsed.data.active, id],
    );
    if (res.rows.length === 0) {
      return reply.code(404).send({ error: 'Usuario no encontrado.' });
    }
    if (!parsed.data.active) {
      // Mata las sesiones activas del usuario desactivado
      await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    }
    return { user: res.rows[0] };
  });

  const resetPasswordSchema = z.object({ newPassword: z.string().min(1).max(128) });

  /** Restablece la contraseña de cualquier usuario sin conocer la actual. */
  app.post('/api/admin/users/:id/reset-password', { preHandler: requireAdmin }, async (request, reply) => {
    const id = Number((request.params as { id: string }).id);
    const parsed = resetPasswordSchema.safeParse(request.body);
    if (!Number.isInteger(id) || !parsed.success) {
      return reply.code(400).send({ error: 'Datos inválidos.' });
    }
    const strengthError = validatePasswordStrength(parsed.data.newPassword);
    if (strengthError) return reply.code(400).send({ error: strengthError });

    const target = await db.query<{ auth_source: 'local' | 'ldap' }>(
      'SELECT auth_source FROM users WHERE id = $1',
      [id],
    );
    if (target.rows[0]?.auth_source === 'ldap') {
      return reply.code(400).send({ error: 'La contraseña de este usuario la gestiona el directorio de la empresa.' });
    }

    const passwordHash = await hashPassword(parsed.data.newPassword);
    const res = await db.query<{ id: number }>(
      'UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id',
      [passwordHash, id],
    );
    if (res.rows.length === 0) {
      return reply.code(404).send({ error: 'Usuario no encontrado.' });
    }
    // Contraseña comprometida/olvidada → sesiones existentes fuera
    await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    return { ok: true };
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

  // ---------- directorio LDAP/AD (v0.3) ----------
  app.get('/api/ldap-config', { preHandler: requireAdmin }, async () => {
    const cfg = await loadLdapConfig(db);
    return {
      config: {
        ...cfg,
        roleMappings: cfg.roleMappings,
        bindPasswordMasked: maskSecret(cfg.bindPassword),
        bindPassword: undefined,
      },
    };
  });

  app.put('/api/ldap-config', { preHandler: requireAdmin }, async (request, reply) => {
    const parsed = ldapConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return reply.code(400).send({ error: `Configuración LDAP inválida: ${detail}` });
    }
    const input = parsed.data;
    const existing = await loadLdapConfig(db);
    // Contraseña vacía/ausente = conservar la guardada (no se re-expone en el portal)
    const bindPassword = input.bindPassword && input.bindPassword.length > 0 ? input.bindPassword : existing.bindPassword;
    if (input.enabled && input.bindMode === 'service' && !bindPassword) {
      return reply.code(400).send({ error: 'Configuración LDAP inválida: bindDn/bindPassword: la contraseña del bind es obligatoria con el directorio activado.' });
    }
    const cfg: LdapConfig = {
      ...input,
      bindDn: input.bindDn ?? '',
      bindPassword,
      userDnPattern: input.userDnPattern ?? '',
      userFilter: input.userFilter ?? '',
      tlsSkipVerify: input.tlsSkipVerify ?? false,
    };
    await saveLdapConfig(db, cfg);
    return {
      config: {
        ...cfg,
        bindPasswordMasked: maskSecret(cfg.bindPassword),
        bindPassword: undefined,
      },
    };
  });

  /** Test de conexión (decisión #6): bind, búsqueda y autenticación opcional. */
  app.post('/api/ldap-config/test', { preHandler: requireAdmin }, async (request, reply) => {
    const cfg = await loadLdapConfig(db);
    if (!cfg.url || !cfg.baseDn) {
      return reply.code(400).send({ error: 'Configura url y baseDn antes de probar la conexión.' });
    }
    const body = request.body as { login?: unknown; password?: unknown } | null;
    const result = await testLdapConnection(cfg, {
      login: typeof body?.login === 'string' ? body.login : undefined,
      password: typeof body?.password === 'string' ? body.password : undefined,
    });
    return {
      ok: result.steps.every((s) => s.ok),
      steps: result.steps,
      role: result.result?.role,
      email: result.result?.mail,
    };
  });
}
