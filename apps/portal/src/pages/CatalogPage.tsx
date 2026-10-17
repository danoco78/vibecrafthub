import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type AppInfo } from '../api';
import { useAuth } from '../App';

export default function CatalogPage() {
  const { user } = useAuth();
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listApps()
      .then((r) => setApps(r.apps))
      .catch((e) => setError(e instanceof Error ? e.message : 'Error'));
  }, []);

  return (
    <div>
      <h1>Catálogo de aplicaciones</h1>
      {error && <div className="banner err">{error}</div>}
      {apps.length === 0 && !error && (
        <div className="card muted">
          Todavía no hay aplicaciones publicadas. {user?.role !== 'user' && <>Crea la primera en “Mis apps”.</>}
        </div>
      )}
      <div className="grid">
        {apps.map((a) => (
          <div className="card app-card" key={a.id}>
            <div className="title">{a.name}</div>
            <div className="meta">
              <span className="mono">{a.slug}</span>
              {a.current_version && <span>v{a.current_version}</span>}
              <span>por {a.owner_email}</span>
            </div>
            {a.description && <p style={{ margin: 0, fontSize: 14 }}>{a.description}</p>}
            <div className="actions">
              <Link className="btn" to={`/apps/${a.slug}`}>
                Abrir
              </Link>
              {(user?.id === a.owner_id || user?.role === 'admin') && (
                <Link className="btn secondary" to={`/publish?app=${a.slug}`}>
                  Publicar
                </Link>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
