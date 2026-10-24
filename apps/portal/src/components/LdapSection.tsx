import { useEffect, useState } from 'react';
import { api, type LdapConfigView, type LdapTestResult } from '../api';

const ROLES = ['admin', 'developer', 'user'] as const;

/** Sección admin: conexión al directorio LDAP/AD (docs/design-v0.3.md §4). */
export default function LdapSection() {
  const [cfg, setCfg] = useState<LdapConfigView | null>(null);
  const [bindPassword, setBindPassword] = useState('');
  const [testLogin, setTestLogin] = useState('');
  const [testPassword, setTestPassword] = useState('');
  const [testResult, setTestResult] = useState<LdapTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function load() {
    api
      .ldapConfig()
      .then((r) => setCfg(r.config))
      .catch((e) => setError(e instanceof Error ? e.message : 'Error'));
  }
  useEffect(load, []);

  if (!cfg) return null;

  async function save() {
    if (!cfg) return;
    setError(null);
    setNotice(null);
    try {
      const res = await api.updateLdapConfig({ ...cfg, bindPassword: bindPassword || undefined });
      setCfg(res.config);
      setBindPassword('');
      setNotice('Configuración del directorio guardada.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    }
  }

  async function test() {
    setError(null);
    setNotice(null);
    setTestResult(null);
    try {
      const res = await api.testLdap(testLogin || undefined, testPassword || undefined);
      setTestResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    }
  }

  function setMapping(i: number, patch: Partial<{ group: string; role: string }>) {
    setCfg((prev) => {
      if (!prev) return prev;
      const mappings = prev.roleMappings.map((m, idx) =>
        idx === i ? { ...m, ...patch } as typeof m : m,
      );
      return { ...prev, roleMappings: mappings };
    });
  }

  return (
    <>
      <h2>Directorio corporativo (LDAP / Active Directory)</h2>
      <p className="muted">
        Los empleados entran con sus credenciales del directorio; la cuenta se crea sola al primer
        ingreso y el rol sale del mapeo de grupos. El login local sigue funcionando como rescate.
        Conexión cifrada obligatoria (LDAPS o StartTLS).
      </p>
      {error && <div className="banner err">{error}</div>}
      {notice && <div className="banner ok">{notice}</div>}
      <div className="card">
        <div className="inline" style={{ marginBottom: 14 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text)' }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={cfg.enabled}
              onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })}
            />
            Login con el directorio activado
          </label>
        </div>

        <div className="inline" style={{ marginBottom: 12 }}>
          <div style={{ minWidth: 150 }}>
            <label htmlFor="l2-mode">Cifrado</label>
            <select
              id="l2-mode"
              value={cfg.mode}
              onChange={(e) => setCfg({ ...cfg, mode: e.target.value as LdapConfigView['mode'] })}
            >
              <option value="ldaps">LDAPS (puerto 636)</option>
              <option value="starttls">StartTLS (puerto 389)</option>
            </select>
          </div>
          <div style={{ flex: 2, minWidth: 240 }}>
            <label htmlFor="l2-url">Servidor (host o host:puerto)</label>
            <input
              id="l2-url"
              value={cfg.url}
              onChange={(e) => setCfg({ ...cfg, url: e.target.value })}
              placeholder="ad.empresa.com"
            />
          </div>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', color: 'var(--text)', alignSelf: 'end', paddingBottom: 9 }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={cfg.tlsSkipVerify}
              onChange={(e) => setCfg({ ...cfg, tlsSkipVerify: e.target.checked })}
              title="Solo laboratorios: el tráfico sigue cifrado pero no se valida el certificado"
            />
            No validar certificado <span className="muted">(solo labs)</span>
          </label>
        </div>

        <div className="inline" style={{ marginBottom: 12 }}>
          <div style={{ minWidth: 300 }}>
            <label htmlFor="l2-basedn">Base DN</label>
            <input
              id="l2-basedn"
              value={cfg.baseDn}
              onChange={(e) => setCfg({ ...cfg, baseDn: e.target.value })}
              placeholder="dc=empresa,dc=com"
            />
          </div>
          <div style={{ minWidth: 160 }}>
            <label htmlFor="l2-bindmode">Modo de bind</label>
            <select
              id="l2-bindmode"
              value={cfg.bindMode}
              onChange={(e) => setCfg({ ...cfg, bindMode: e.target.value as LdapConfigView['bindMode'] })}
            >
              <option value="service">Cuenta de servicio + búsqueda</option>
              <option value="direct">DN directo con {'{login}'}</option>
            </select>
          </div>
        </div>

        {cfg.bindMode === 'service' ? (
          <div className="inline" style={{ marginBottom: 12 }}>
            <div style={{ flex: 2, minWidth: 260 }}>
              <label htmlFor="l2-binddn">Bind DN (cuenta de servicio)</label>
              <input
                id="l2-binddn"
                value={cfg.bindDn}
                onChange={(e) => setCfg({ ...cfg, bindDn: e.target.value })}
                placeholder="cn=vch,ou=service,dc=empresa,dc=com"
              />
            </div>
            <div style={{ flex: 1, minWidth: 180 }}>
              <label htmlFor="l2-bindpw">
                Contraseña {cfg.bindPasswordMasked && `(guardada: ${cfg.bindPasswordMasked})`}
              </label>
              <input
                id="l2-bindpw"
                type="password"
                value={bindPassword}
                onChange={(e) => setBindPassword(e.target.value)}
                placeholder={cfg.bindPasswordMasked || 'contraseña del bind'}
                autoComplete="off"
              />
            </div>
            <div style={{ flex: 2, minWidth: 240 }}>
              <label htmlFor="l2-filter">Filtro de usuario</label>
              <input
                id="l2-filter"
                value={cfg.userFilter}
                onChange={(e) => setCfg({ ...cfg, userFilter: e.target.value })}
                placeholder="(mail={login})  · AD: (&(objectClass=user)(userPrincipalName={login}))"
              />
            </div>
          </div>
        ) : (
          <div className="inline" style={{ marginBottom: 12 }}>
            <div style={{ flex: 2, minWidth: 320 }}>
              <label htmlFor="l2-pattern">Patrón de DN (debe incluir {'{login}'})</label>
              <input
                id="l2-pattern"
                value={cfg.userDnPattern}
                onChange={(e) => setCfg({ ...cfg, userDnPattern: e.target.value })}
                placeholder="uid={login},ou=people,dc=empresa,dc=com"
              />
            </div>
          </div>
        )}

        <div className="inline" style={{ marginBottom: 12 }}>
          <div style={{ minWidth: 140 }}>
            <label htmlFor="l2-mail">Atributo email</label>
            <input
              id="l2-mail"
              value={cfg.mailAttr}
              onChange={(e) => setCfg({ ...cfg, mailAttr: e.target.value })}
              placeholder="mail / userPrincipalName"
            />
          </div>
          <div style={{ minWidth: 140 }}>
            <label htmlFor="l2-group">Atributo de grupos</label>
            <input
              id="l2-group"
              value={cfg.groupAttr}
              onChange={(e) => setCfg({ ...cfg, groupAttr: e.target.value })}
              placeholder="memberOf"
            />
          </div>
          <div style={{ minWidth: 140 }}>
            <label htmlFor="l2-defrole">Rol por defecto</label>
            <select
              id="l2-defrole"
              value={cfg.defaultRole}
              onChange={(e) => setCfg({ ...cfg, defaultRole: e.target.value as LdapConfigView['defaultRole'] })}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label>Grupos → rol (en orden: la primera coincidencia gana)</label>
          {cfg.roleMappings.map((m, i) => (
            <div className="inline" key={i} style={{ marginBottom: 8 }}>
              <div style={{ flex: 3, minWidth: 260 }}>
                <input
                  value={m.group}
                  onChange={(e) => setMapping(i, { group: e.target.value })}
                  placeholder="cn=desarrolladores,ou=groups,dc=empresa,dc=com"
                />
              </div>
              <div style={{ minWidth: 140 }}>
                <select
                  value={m.role}
                  onChange={(e) => setMapping(i, { role: e.target.value })}
                  aria-label="Rol del grupo"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  setCfg((prev) =>
                    prev ? { ...prev, roleMappings: prev.roleMappings.filter((_, idx) => idx !== i) } : prev,
                  )
                }
              >
                Quitar
              </button>
            </div>
          ))}
          <button
            type="button"
            className="secondary"
            onClick={() =>
              setCfg((prev) =>
                prev
                  ? { ...prev, roleMappings: [...prev.roleMappings, { group: '', role: 'user' }] }
                  : prev,
              )
            }
          >
            + Añadir mapeo
          </button>
        </div>

        <div className="inline">
          <button type="button" onClick={save}>
            Guardar directorio
          </button>
        </div>

        <h2 style={{ marginTop: 20, marginBottom: 8 }}>Probar conexión</h2>
        <div className="inline">
          <div style={{ minWidth: 200 }}>
            <label htmlFor="l2-tlogin">Login de prueba (opcional)</label>
            <input
              id="l2-tlogin"
              value={testLogin}
              onChange={(e) => setTestLogin(e.target.value)}
              placeholder="uid o email de un empleado real"
            />
          </div>
          <div style={{ minWidth: 180 }}>
            <label htmlFor="l2-tpass">Su contraseña (opcional)</label>
            <input
              id="l2-tpass"
              type="password"
              value={testPassword}
              onChange={(e) => setTestPassword(e.target.value)}
              autoComplete="off"
            />
          </div>
          <button type="button" className="secondary" onClick={test}>
            Probar
          </button>
        </div>
        {testResult && (
          <div className="card" style={{ marginTop: 12, background: 'var(--bg)' }}>
            {testResult.steps.map((s, i) => (
              <div key={i} style={{ marginBottom: 4 }}>
                <span className={`badge ${s.ok ? 'published' : 'rejected'}`}>{s.ok ? 'OK' : 'FALLO'}</span>{' '}
                <span className="mono">{s.step}</span> — <span className="muted">{s.detail}</span>
              </div>
            ))}
            {testResult.role && (
              <p style={{ margin: '8px 0 0' }}>
                Rol que recibiría: <span className="badge info">{testResult.role}</span> · email:{' '}
                <span className="mono">{testResult.email}</span>
              </p>
            )}
          </div>
        )}
      </div>
    </>
  );
}
