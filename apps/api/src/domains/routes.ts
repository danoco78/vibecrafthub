import type { FastifyInstance } from 'fastify';
import type { DbClient } from '../db.js';
import { requireRole } from '../plugins/auth.js';
import { externalDomainSchema, normalizeDomain } from '@vch/shared';

/** Allowlist de dominios externos aprobados por el admin (docs/design-v0.3.md §5). */
export function domainsRoutes(app: FastifyInstance, db: DbClient): void {
  const requireAdmin = requireRole(app, 'admin');

  app.get('/api/admin/external-domains', { preHandler: requireAdmin }, async () => {
    const res = await db.query<{ domain: string; note: string; created_at: string }>(
      'SELECT domain, note, created_at FROM external_domain_allowlist ORDER BY domain ASC',
    );
    return { domains: res.rows };
  });

  app.post('/api/admin/external-domains', { preHandler: requireAdmin }, async (request, reply) => {
    const body = request.body as { domain?: unknown; note?: unknown };
    const parsed = externalDomainSchema.safeParse(typeof body?.domain === 'string' ? body.domain : '');
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Dominio inválido.' });
    }
    const domain = normalizeDomain(parsed.data);
    if (!domain) return reply.code(400).send({ error: 'Dominio inválido.' });
    const note = typeof body?.note === 'string' ? body.note.slice(0, 300) : '';

    try {
      const res = await db.query<{ domain: string }>(
        'INSERT INTO external_domain_allowlist (domain, note) VALUES ($1, $2) RETURNING domain',
        [domain, note],
      );
      return reply.code(201).send({ domain: res.rows[0].domain });
    } catch (err) {
      if (err instanceof Error && /unique|duplicate/i.test(err.message)) {
        return reply.code(409).send({ error: `${domain} ya está en la allowlist.` });
      }
      throw err;
    }
  });

  app.delete(
    '/api/admin/external-domains/:domain',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const raw = (request.params as { domain: string }).domain;
      const domain = normalizeDomain(decodeURIComponent(raw));
      if (!domain) return reply.code(400).send({ error: 'Dominio inválido.' });
      const res = await db.query<{ domain: string }>(
        'DELETE FROM external_domain_allowlist WHERE domain = $1 RETURNING domain',
        [domain],
      );
      if (res.rows.length === 0) {
        return reply.code(404).send({ error: `${domain} no está en la allowlist.` });
      }
      return { ok: true };
    },
  );
}
