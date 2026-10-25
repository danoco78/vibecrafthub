import type { FastifyInstance } from 'fastify';
import type { DbClient } from '../db.js';
import { requireRole } from '../plugins/auth.js';

/**
 * Export de auditoría (docs/design-v1.0-metrics-audit.md §5):
 * publicaciones (publish_attempts) y acciones de administración
 * (admin_actions), en CSV o JSON, filtrables por rango de fechas y app.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function csvField(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n;]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function filename(kind: 'publicaciones' | 'acciones', format: string, from: string, to: string): string {
  return `auditoria-${kind}-${from}_${to}.${format}`;
}

export function auditRoutes(app: FastifyInstance, db: DbClient): void {
  const requireAdmin = requireRole(app, 'admin');

  app.get('/api/admin/audit/export', { preHandler: requireAdmin }, async (request, reply) => {
    const q = request.query as {
      type?: string;
      from?: string;
      to?: string;
      slug?: string;
      format?: string;
    };
    const type = q.type === 'actions' ? 'actions' : 'publishes';
    const format = q.format === 'json' ? 'json' : 'csv';
    const from = DATE_RE.test(q.from ?? '') ? (q.from as string) : '1970-01-01';
    const to = DATE_RE.test(q.to ?? '') ? (q.to as string) : new Date().toISOString().slice(0, 10);
    const slug = typeof q.slug === 'string' && q.slug.trim() !== '' ? q.slug.trim() : undefined;

    if (type === 'actions') {
      const res = await db.query<{
        id: number;
        created_at: string;
        action: string;
        target: string;
        admin_email: string;
      }>(
        `SELECT a.id, a.created_at, a.action, a.target, u.email AS admin_email
         FROM admin_actions a JOIN users u ON u.id = a.user_id
         WHERE a.created_at::date BETWEEN $1::date AND $2::date
         ORDER BY a.created_at ASC`,
        [from, to],
      );
      const records = res.rows.map((r) => ({
        id: r.id,
        fecha: r.created_at,
        admin: r.admin_email,
        accion: r.action,
        objetivo: r.target,
      }));
      if (format === 'json') {
        return reply.header('content-disposition', `attachment; filename="${filename('acciones', 'json', from, to)}"`).send({
          tipo: 'acciones',
          desde: from,
          hasta: to,
          total: records.length,
          registros: records,
        });
      }
      const lines = ['id,fecha,admin,accion,objetivo'];
      for (const r of records) {
        lines.push([r.id, r.fecha, r.admin, r.accion, r.objetivo].map(csvField).join(','));
      }
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filename('acciones', 'csv', from, to)}"`)
        .send(lines.join('\n') + '\n');
    }

    const publishes = await db.query<{
      id: number;
      created_at: string;
      app_slug: string;
      app_name: string;
      user_email: string;
      verdict: string;
      version: string | null;
      bundle_hash: string;
      findings: { rule: string; severity: string; file: string; line: number; message: string }[];
    }>(
      `SELECT pa.id, pa.created_at, a.slug AS app_slug, a.name AS app_name, u.email AS user_email,
              pa.verdict, v.version, pa.bundle_hash, pa.findings
       FROM publish_attempts pa
       JOIN apps a ON a.id = pa.app_id
       JOIN users u ON u.id = pa.user_id
       LEFT JOIN app_versions v ON v.id = pa.version_id
       WHERE pa.created_at::date BETWEEN $1::date AND $2::date
         ${slug ? 'AND a.slug = $3' : ''}
       ORDER BY pa.created_at ASC`,
      slug ? [from, to, slug] : [from, to],
    );
    const records = publishes.rows.map((r) => ({
      id: r.id,
      fecha: r.created_at,
      app_slug: r.app_slug,
      app_name: r.app_name,
      usuario: r.user_email,
      veredicto: r.verdict,
      version: r.version,
      bundle_hash: r.bundle_hash,
      total_hallazgos: r.findings.length,
      hallazgos: r.findings,
    }));

    if (format === 'json') {
      return reply
        .header('content-disposition', `attachment; filename="${filename('publicaciones', 'json', from, to)}"`)
        .send({ tipo: 'publicaciones', desde: from, hasta: to, app: slug ?? null, total: records.length, registros: records });
    }

    const lines = [
      'id,fecha,app_slug,app_name,usuario,veredicto,version,bundle_hash,total_hallazgos,hallazgos',
    ];
    for (const r of records) {
      lines.push(
        [
          r.id,
          r.fecha,
          r.app_slug,
          r.app_name,
          r.usuario,
          r.veredicto,
          r.version ?? '',
          r.bundle_hash,
          r.total_hallazgos,
          JSON.stringify(r.hallazgos),
        ]
          .map(csvField)
          .join(','),
      );
    }
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename('publicaciones', 'csv', from, to)}"`)
      .send(lines.join('\n') + '\n');
  });
}
