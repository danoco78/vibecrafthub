import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type AppInfo, type Version } from '../api';
import { useAuth } from '../App';

interface Member {
  user_id: number;
  email: string;
  added_at: string;
}

export default function AppDetailPage() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const { user, appsUrlTemplate } = useAuth();
  const [app, setApp] = useState<AppInfo | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [memberEmail, setMemberEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function load() {
    Promise.all([api.getApp(slug), api.versions(slug)])
      .then(([a, v]) => {
        setApp(a.app);
        setVersions(v.versions);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Error'));
    api
      .members(slug)
      .then((r) => setMembers(r.members))
      .catch(() => setMembers([]));
  }
  useEffect(load, [slug]);

  if (error) return <div className="banner err">{error}</div>;
  if (!app) return <p className="muted">Cargando…</p>;

  const canManage = user?.id === app.owner_id || user?.role === 'admin';
  const appUrl = appsUrlTemplate.replace('{slug}', app.slug);

  async function saveVisibility(visibility: 'public' | 'private') {
    setError(null);
    setNotice(null);
    try {
      const res = await api.updateApp(slug, { visibility });
      setApp(res.app);
      setNotice(
        visibility === 'private'
          ? 'App privada: solo la allowlist (y tú) pueden verla. Añade usuarios abajo.'
          : 'App pública: visible para toda la empresa.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    }
  }

  async function addMember() {
    setError(null);
    setNotice(null);
    try {
      await api.addMember(slug, memberEmail.trim());
      setMemberEmail('');
      setNotice(`${memberEmail.trim()} añadido a la allowlist.`);
      api.members(slug).then((r) => setMembers(r.members)).catch(() => undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    }
  }

  async function removeMember(id: number, email: string) {
    setError(null);
    setNotice(null);
    try {
      await api.removeMember(slug, id);
      setNotice(`${email} retirado de la allowlist.`);
      api.members(slug).then((r) => setMembers(r.members)).catch(() => undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    }
  }

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
            <button
              className="danger"
              onClick={async () => {
                if (!window.confirm(`¿Eliminar "${app.name}" (${app.slug})? Acción irreversible.`)) return;
                try {
                  await api.deleteApp(app.slug);
                  navigate('/my-apps');
                } catch (e) {
                  setError(e instanceof Error ? e.message : 'Error');
                }
              }}
            >
              Eliminar
            </button>
          </>
        )}
      </div>
      {app.description && <p className="muted">{app.description}</p>}
      {notice && <div className="banner ok">{notice}</div>}

      {canManage && (
        <>
          <h2>Visibilidad</h2>
          <div className="card inline" style={{ alignItems: 'center' }}>
            <div style={{ minWidth: 200 }}>
              <label htmlFor="vis">¿Quién puede usar esta app?</label>
              <select
                id="vis"
                value={app.visibility}
                onChange={(e) => saveVisibility(e.target.value as 'public' | 'private')}
              >
                <option value="public">Pública — toda la empresa</option>
                <option value="private">Privada — solo allowlist</option>
              </select>
            </div>
            {app.visibility === 'private' && (
              <span className="badge info">🔒 Privada · {members.length} en la allowlist</span>
            )}
          </div>

          {app.visibility === 'private' && (
            <>
              <h2>Allowlist de acceso</h2>
              <p className="muted">
                Los usuarios de esta lista pueden ver la app en el catálogo y abrir su subdominio.
                Tú y los admins siempre tienen acceso.
              </p>
              <div className="card" style={{ padding: 0 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Email</th>
                      <th>Añadido</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.length === 0 && (
                      <tr>
                        <td colSpan={3} className="muted">
                          Nadie más tiene acceso todavía.
                        </td>
                      </tr>
                    )}
                    {members.map((m) => (
                      <tr key={m.user_id}>
                        <td>{m.email}</td>
                        <td className="muted">{new Date(m.added_at).toLocaleDateString()}</td>
                        <td>
                          <button className="secondary" onClick={() => removeMember(m.user_id, m.email)}>
                            Quitar
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="card inline" style={{ marginTop: 12 }}>
                <div style={{ flex: 2, minWidth: 240 }}>
                  <label htmlFor="member-email">Añadir usuario por email</label>
                  <input
                    id="member-email"
                    type="email"
                    placeholder="colega@empresa.com"
                    value={memberEmail}
                    onChange={(e) => setMemberEmail(e.target.value)}
                  />
                </div>
                <button onClick={addMember}>Añadir a la allowlist</button>
              </div>
            </>
          )}
        </>
      )}

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
            {' · '}¿Se ve en blanco? Abre la URL directa en una pestaña nueva y acepta el certificado
            del subdominio: los iframes no pueden mostrar avisos de certificado.
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
