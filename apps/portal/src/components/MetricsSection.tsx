import { useEffect, useState } from 'react';
import { api, type MetricsView } from '../api';

const RANGES = [
  { days: 1, label: '24 horas' },
  { days: 7, label: '7 días' },
  { days: 30, label: '30 días' },
];

function Bar({ value, max, color = 'var(--accent)' }: { value: number; max: number; color?: string }) {
  if (value <= 0) return <div style={{ height: 6, background: 'var(--border)', borderRadius: 3, minWidth: 6 }} />;
  const pct = Math.max(4, Math.round((value / Math.max(max, 1)) * 100));
  return (
    <div style={{ height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
      <div style={{ height: 6, width: `${pct}%`, background: color, borderRadius: 3 }} />
    </div>
  );
}

function MetricCard({ label, value, bar }: { label: string; value: number; bar: React.ReactNode }) {
  return (
    <div className="card" style={{ minWidth: 0 }}>
      <div className="muted" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, margin: '4px 0 8px' }}>{value.toLocaleString('es')}</div>
      {bar}
    </div>
  );
}

/** Sección admin: métricas de uso (docs/design-v1.0-metrics-audit.md §4.4). */
export default function MetricsSection() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<MetricsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load(range = days) {
    api
      .metrics(range)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Error'));
  }
  useEffect(() => load(), []);

  if (error) return <div className="banner err">{error}</div>;
  if (!data) return null;

  const s = data.summary;
  const maxCard = Math.max(s.appAccess, s.dbQueries, s.publishOk + s.publishRejected, s.loginOkLocal + s.loginOkLdap + s.loginFail, 1);
  const cards: { label: string; value: number; segments: { value: number; color: string }[] }[] = [
    {
      label: 'Accesos a apps',
      value: s.appAccess,
      segments: [{ value: s.appAccess, color: 'var(--accent)' }],
    },
    {
      label: 'Queries (data gateway)',
      value: s.dbQueries,
      segments: [{ value: s.dbQueries, color: 'var(--ok)' }],
    },
    {
      label: 'Publicaciones (ok / rechazo)',
      value: s.publishOk + s.publishRejected,
      segments: [
        { value: s.publishOk, color: 'var(--ok)' },
        { value: s.publishRejected, color: 'var(--crit)' },
      ],
    },
    {
      label: 'Logins (local / LDAP / fallos)',
      value: s.loginOkLocal + s.loginOkLdap + s.loginFail,
      segments: [
        { value: s.loginOkLocal, color: 'var(--accent)' },
        { value: s.loginOkLdap, color: 'var(--warn)' },
        { value: s.loginFail, color: 'var(--crit)' },
      ],
    },
  ];
  const maxApps = Math.max(...data.apps.map((a) => a.access), 1);

  return (
    <>
      <h2>Métricas de uso</h2>
      <div className="inline" style={{ marginBottom: 12 }}>
        {RANGES.map((r) => (
          <button
            key={r.days}
            className={days === r.days ? '' : 'secondary'}
            onClick={() => {
              setDays(r.days);
              load(r.days);
            }}
          >
            {r.label}
          </button>
        ))}
      </div>
      <div className="grid" style={{ marginBottom: 20 }}>
        {cards.map((c) => (
          <MetricCard key={c.label} label={c.label} value={c.value} bar={
            <div>
              {c.segments.map((seg, i) => (
                <div key={i} style={{ marginTop: i > 0 ? 4 : 0 }}>
                  <Bar value={seg.value} max={maxCard} color={seg.color} />
                </div>
              ))}
            </div>
          } />
        ))}
      </div>

      {data.apps.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>App</th>
                <th style={{ width: '38%' }}>Accesos</th>
                <th>Queries</th>
                <th>Publicadas</th>
                <th>Rechazos</th>
              </tr>
            </thead>
            <tbody>
              {data.apps.map((a) => (
                <tr key={a.slug}>
                  <td className="mono">{a.slug}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <div style={{ flex: 1 }}>
                        <Bar value={a.access} max={maxApps} />
                      </div>
                      <span className="mono">{a.access.toLocaleString('es')}</span>
                    </div>
                  </td>
                  <td className="mono">{a.dbQueries.toLocaleString('es')}</td>
                  <td className="mono">{a.publishOk.toLocaleString('es')}</td>
                  <td className="mono">{a.publishRejected.toLocaleString('es')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.apps.length === 0 && (
        <div className="card muted">Sin actividad por app en el rango seleccionado.</div>
      )}
    </>
  );
}
