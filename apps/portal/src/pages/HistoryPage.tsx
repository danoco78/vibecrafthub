import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { api, type Attempt } from '../api';
import { useAuth } from '../App';

export default function HistoryPage() {
  const { user } = useAuth();
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (user?.role === 'user') return; // el guard de ruta ya redirige
    api
      .attempts()
      .then((r) => setAttempts(r.attempts))
      .catch((e) => setError(e instanceof Error ? e.message : 'Error'));
  }, [user?.role]);

  // El historial es solo para admin y developer (la API también lo exige).
  if (user?.role === 'user') return <Navigate to="/" replace />;

  return (
    <div>
      <h1>Historial de publicaciones</h1>
      {error && <div className="banner err">{error}</div>}
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>App</th>
              <th>Usuario</th>
              <th>Versión</th>
              <th>Resultado</th>
            </tr>
          </thead>
          <tbody>
            {attempts.map((a) => (
              <tr
                key={a.id}
                style={{ cursor: 'pointer' }}
                onClick={() => navigate(`/attempts/${a.id}`)}
              >
                <td className="muted">{new Date(a.created_at).toLocaleString()}</td>
                <td>{a.app_name}</td>
                <td className="muted">{a.user_email}</td>
                <td className="mono">{a.version ? `v${a.version}` : '—'}</td>
                <td>
                  <span className={`badge ${a.verdict}`}>
                    {a.verdict === 'published' ? 'Publicada' : 'Rechazada'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {attempts.length === 0 && <div className="muted" style={{ padding: 20 }}>Sin intentos registrados todavía.</div>}
      </div>
      <p className="muted mt">
        Cada intento de publicación —exitoso o rechazado— queda registrado con sus hallazgos completos.{' '}
        <Link to="/">Volver al catálogo</Link>
      </p>
    </div>
  );
}
