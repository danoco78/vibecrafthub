import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Attempt } from '../api';
import { FindingsTable } from '../components/Findings';

export default function AttemptDetailPage() {
  const { id = '' } = useParams();
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .attempt(Number(id))
      .then((r) => setAttempt(r.attempt))
      .catch((e) => setError(e instanceof Error ? e.message : 'Error'));
  }, [id]);

  if (error) return <div className="banner err">{error}</div>;
  if (!attempt) return <p className="muted">Cargando…</p>;

  const findings = attempt.findings ?? [];

  return (
    <div>
      <div className="inline" style={{ marginBottom: 18 }}>
        <h1 style={{ margin: 0 }}>Intento #{attempt.id}</h1>
        <span className={`badge ${attempt.verdict}`}>
          {attempt.verdict === 'published' ? 'Publicado' : 'Rechazado'}
        </span>
        <div className="spacer" />
        {attempt.app_slug && <Link to={`/apps/${attempt.app_slug}`}>Ver app</Link>}
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="meta muted" style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontSize: 14 }}>
          {attempt.app_name && (
            <span>
              App: <strong style={{ color: 'var(--text)' }}>{attempt.app_name}</strong>
            </span>
          )}
          {attempt.user_email && <span>Usuario: {attempt.user_email}</span>}
          {attempt.version && <span>Versión: v{attempt.version}</span>}
          <span>{new Date(attempt.created_at).toLocaleString()}</span>
          {attempt.bundle_hash && <span className="mono">hash: {attempt.bundle_hash.slice(0, 16)}…</span>}
        </div>
      </div>

      <h2>Reporte de revisión ({findings.length} hallazgos)</h2>
      <FindingsTable findings={findings} />
    </div>
  );
}
