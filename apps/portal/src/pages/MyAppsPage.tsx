import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type AppInfo } from '../api';
import { useAuth } from '../App';
import PromptWizard from '../components/PromptWizard';

export default function MyAppsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();  const [apps, setApps] = useState<AppInfo[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showWizard, setShowWizard] = useState(false);

  function load() {
    api
      .listApps()
      .then((r) => setApps(r.apps.filter((a) => a.owner_id === user?.id || user?.role === 'admin')))
      .catch((e) => setError(e instanceof Error ? e.message : 'Error'));
  }
  useEffect(load, [user?.id, user?.role]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await api.createApp(name, description);
      navigate(`/publish?app=${res.app.slug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    }
  }

  async function removeApp(slug: string, appName: string) {
    if (!window.confirm(`¿Eliminar "${appName}" (${slug})? Se borran sus versiones, bundles e historial. Acción irreversible.`)) {
      return;
    }
    setError(null);
    try {
      await api.deleteApp(slug);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    }
  }

  return (
    <div>
      <h1>Mis aplicaciones</h1>
      {error && <div className="banner err">{error}</div>}

      <form className="card" onSubmit={create}>
        <div className="inline" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
          <h2 style={{ margin: 0 }}>Nueva aplicación</h2>
          <button type="button" className="secondary" onClick={() => setShowWizard(true)} title="Genera el prompt para pedirle la app a tu IA">
            🪄 ¿Cómo crear mis apps?
          </button>
        </div>
        <div className="inline">
          <div style={{ flex: 1, minWidth: 220 }}>
            <label htmlFor="app-name">Nombre</label>
            <input
              id="app-name"
              required
              minLength={2}
              maxLength={64}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ej: Inventario de oficina"
            />
          </div>
          <div style={{ flex: 2, minWidth: 260 }}>
            <label htmlFor="app-desc">Descripción (opcional)</label>
            <input
              id="app-desc"
              maxLength={500}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Qué hace la aplicación"
            />
          </div>
          <button type="submit">Crear y publicar</button>
        </div>
      </form>

      <h2>Mis apps</h2>
      <div className="grid">
        {apps.map((a) => (
          <div className="card app-card" key={a.id}>
            <div className="title">{a.name}</div>
            <div className="meta">
              <span className="mono">{a.slug}</span>
              {a.current_version && <span>v{a.current_version}</span>}
            </div>
            <div className="actions">
              <Link className="btn secondary" to={`/publish?app=${a.slug}`}>
                Publicar
              </Link>
              <Link className="btn secondary" to={`/apps/${a.slug}`}>
                Ver
              </Link>
              <button
                className="danger"
                onClick={() => removeApp(a.slug, a.name)}
                title="Eliminar app, versiones e historial"
              >
                Eliminar
              </button>
            </div>
          </div>
        ))}
      </div>
      {apps.length === 0 && <div className="card muted">Crea tu primera aplicación arriba.</div>}

      {showWizard && <PromptWizard onClose={() => setShowWizard(false)} />}
    </div>
  );
}
