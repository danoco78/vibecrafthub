import type { FastifyInstance } from 'fastify';
import type { DbClient } from '../db.js';
import { requireRole } from '../plugins/auth.js';

/** Métricas de uso para el panel y su export CSV (docs/design-v1.0-metrics-audit.md §4.3). */

const RANGES = [1, 7, 30] as const;

function parseDays(raw: unknown): number {
  const n = Number(raw);
  return (RANGES as readonly number[]).includes(n) ? n : 30;
}

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

interface MetricRow {
  metric: string;
  key: string;
  total: string;
}

export function metricsRoutes(app: FastifyInstance, db: DbClient): void {
  const requireAdmin = requireRole(app, 'admin');

  app.get('/api/admin/metrics', { preHandler: requireAdmin }, async (request) => {
    const days = parseDays((request.query as { days?: string }).days);
    const res = await db.query<MetricRow>(
      `SELECT metric, key, SUM(value)::text AS total
       FROM metric_daily
       WHERE day >= current_date - ($1::int - 1)
       GROUP BY metric, key`,
      [days],
    );

    const summary = {
      loginOkLocal: 0,
      loginOkLdap: 0,
      loginFail: 0,
      publishOk: 0,
      publishRejected: 0,
      dbQueries: 0,
      appAccess: 0,
    };
    const apps = new Map<string, { slug: string; access: number; dbQueries: number; publishOk: number; publishRejected: number }>();
    const appFor = (slug: string) => {
      let a = apps.get(slug);
      if (!a) {
        a = { slug, access: 0, dbQueries: 0, publishOk: 0, publishRejected: 0 };
        apps.set(slug, a);
      }
      return a;
    };

    for (const row of res.rows) {
      const total = Number(row.total);
      switch (row.metric) {
        case 'login.ok':
          if (row.key === 'ldap') summary.loginOkLdap += total;
          else summary.loginOkLocal += total;
          break;
        case 'login.fail':
          summary.loginFail += total;
          break;
        case 'publish.ok':
          summary.publishOk += total;
          appFor(row.key).publishOk += total;
          break;
        case 'publish.rejected':
          summary.publishRejected += total;
          appFor(row.key).publishRejected += total;
          break;
        case 'dbquery.ok':
        case 'dbquery.error':
          summary.dbQueries += total;
          appFor(row.key).dbQueries += total;
          break;
        case 'appaccess':
          summary.appAccess += total;
          appFor(row.key).access += total;
          break;
      }
    }

    return { days, summary, apps: [...apps.values()].sort((a, b) => b.access - a.access) };
  });

  app.get('/api/admin/metrics/export', { preHandler: requireAdmin }, async (request, reply) => {
    const days = parseDays((request.query as { days?: string }).days);
    const res = await db.query<{ day: string; metric: string; key: string; value: string }>(
      `SELECT day::text AS day, metric, key, value::text AS value
       FROM metric_daily
       WHERE day >= current_date - ($1::int - 1)
       ORDER BY day ASC, metric ASC, key ASC`,
      [days],
    );
    const lines = ['day,metric,key,value'];
    for (const r of res.rows) {
      lines.push([r.day, csvField(r.metric), csvField(r.key), r.value].join(','));
    }
    const filename = `metricas-vibecrafthub-${new Date().toISOString().slice(0, 10)}.csv`;
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .send(lines.join('\n') + '\n');
  });
}
