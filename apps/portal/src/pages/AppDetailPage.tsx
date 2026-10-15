import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type AppInfo, type Version } from '../api';
import { useAuth } from '../App';

export default function AppDetailPage() {
  const { slug = '' } = useParams();
  const { user, appsUrlTemplate } = useAuth();
  const [app, setApp] = useState<AppInfo | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [error, setError] = useState<string | null>(null);

  function load() {
    Promise.all([api.getApp(slug), api.versions(slug)])
      .then(([a, v]) => {
        setApp(a.app);
        setVersions(v.versions);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Error'));
  }
  useEffect(load, [slug]);

  if (error) return <div className="banner err">{error}</div>;
  if (!app) return <p className="muted">Cargando…</p>;

  const canManage = user?.id === app.owner_id || user?.role === 'admin';
  const appUrl = appsUrlTemplate.replace('{slug}', app.slug);

  return (
    <div>
      <div className="inline" style={{ marginBottom: 18 }}>
        <h1 style={{ margin: 0 }}>{app.name}</h1>
        <span className="muted mono">
          {app.slug}
          {app.current_version ? ` · v${app.current_version}` : ' · sin versión publicada'}
        </span>
        <div className="spacer" />
        {canManage && (
          <>
            <Link className="btn secondary" to={`/publish?app=${app.slug}`}>
              Publicar actualización
            </Link>
            <Link className="btn secondary" to="/history">
              Historial
            </Link>
          </>
        )}
      </div>
      {app.description && <p className="muted">{app.description}</p>}

      {app.current_version ? (
        <>
          <h2>Vista previa</h2>
          <iframe
            className="preview-frame"
            src={appUrl}
            sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-same-origin"
            title={`Vista previa de ${app.name}`}
          />
          <p className="muted mt">
            URL directa:{' '}
            <a href={appUrl} target="_blank" rel="noreferrer" className="mono">
              {appUrl}
            </a>
          </p>
        </>
      ) : (
        <div className="card muted">Esta app aún no tiene una versión publicada.</div>
      )}

      <h2>Versiones</h2>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Versión</th>
              <th>Estado</th>
              <th>Hash</th>
              <th>Fecha</th>
              {canManage && <th></th>}
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id}>
                <td className="mono">v{v.version}</td>
                <td>
                  <span className={`badge ${v.status === 'active' ? 'published' : 'info'}`}>
                    {v.status === 'active' ? 'Activa' : 'Publicada'}
                  </span>
                </td>
                <td className="muted mono">{v.bundle_hash.slice(0, 12)}…</td>
                <td className="muted">{new Date(v.created_at).toLocaleString()}</td>
                {canManage && (
                  <td>
                    {v.status !== 'active' && (
                      <button
                        className="secondary"
                        onClick={async () => {
                          await api.activate(slug, v.id);
                          load();
                        }}
                      >
                        Activar
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
