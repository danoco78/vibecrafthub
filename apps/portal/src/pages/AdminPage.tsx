import { useEffect, useState, type FormEvent } from 'react';
import { api, type LlmConfigView, type User } from '../api';
import { useAuth } from '../App';

interface Policy {
  blockSeverities: string[];
  maxBundleMb: number;
  maxFiles: number;
}

const SEVERITIES = [
  { value: 'critical', label: 'Crítica' },
  { value: 'high', label: 'Alta' },
  { value: 'medium', label: 'Media' },
  { value: 'low', label: 'Baja' },
];

export default function AdminPage() {
  const { user } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [llm, setLlm] = useState<LlmConfigView | null>(null);
  const [llmApiKey, setLlmApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('developer');

  function load() {
    api
      .users()
      .then((r) => setUsers(r.users))
      .catch((e) => setError(e instanceof Error ? e.message : 'Error'));
    api
      .policy()
      .then((r) => setPolicy(r.policy))
      .catch(() => undefined);
    api
      .llmConfig()
      .then((r) => setLlm(r.config))
      .catch(() => undefined);
  }
  useEffect(load, []);

  async function createUser(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      await api.createUser(email, password, role);
      setNotice(`Usuario ${email} creado.`);
      setEmail('');
      setPassword('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    }
  }

  async function savePolicy() {
    if (!policy) return;
    setError(null);
    setNotice(null);
    try {
      const res = await api.updatePolicy(policy);
      setPolicy(res.policy);
      setNotice('Política actualizada.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    }
  }

  async function saveLlm() {
    if (!llm) return;
    setError(null);
    setNotice(null);
    try {
      const res = await api.updateLlmConfig({
        enabled: llm.enabled,
        provider: llm.provider,
        baseUrl: llm.baseUrl === defaultBaseUrl(llm.provider) ? '' : llm.baseUrl,
        model: llm.model,
        apiKey: llmApiKey || undefined,
        onUnavailable: llm.onUnavailable,
      });
      setLlm(res.config);
      setLlmApiKey('');
      setNotice('Configuración LLM guardada.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    }
  }

  function toggleSeverity(value: string) {
    if (!policy) return;
    const has = policy.blockSeverities.includes(value);
    setPolicy({
      ...policy,
      blockSeverities: has
        ? policy.blockSeverities.filter((s) => s !== value)
        : [...policy.blockSeverities, value],
    });
  }

  function defaultBaseUrl(provider: LlmConfigView['provider']): string {
    return provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1';
  }

  return (
    <div>
      <h1>Administración</h1>
      {error && <div className="banner err">{error}</div>}
      {notice && <div className="banner ok">{notice}</div>}

      <h2>Usuarios</h2>
      <div className="card" style={{ padding: 0, marginBottom: 20 }}>
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Rol</th>
              <th>Estado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} style={{ opacity: u.active === false ? 0.5 : 1 }}>
                <td>{u.email}</td>
                <td>
                  <span className="badge info">{u.role}</span>
                </td>
                <td>
                  <span className={`badge ${u.active === false ? 'rejected' : 'published'}`}>
                    {u.active === false ? 'Desactivada' : 'Activa'}
                  </span>
                </td>
                <td>
                  <div className="row-actions">
                    {u.id !== user?.id && (
                      <button
                        className="secondary"
                        onClick={async () => {
                          try {
                            await api.setUserActive(u.id, u.active === false);
                            load();
                          } catch (err) {
                            setError(err instanceof Error ? err.message : 'Error');
                          }
                        }}
                      >
                        {u.active === false ? 'Activar' : 'Desactivar'}
                      </button>
                    )}
                    <button
                      className="secondary"
                      onClick={async () => {
                        const newPassword = window.prompt(`Nueva contraseña para ${u.email}:`);
                        if (!newPassword) return;
                        try {
                          await api.resetPassword(u.id, newPassword);
                          setNotice(`Contraseña restablecida para ${u.email}.`);
                        } catch (err) {
                          setError(err instanceof Error ? err.message : 'Error');
                        }
                      }}
                    >
                      Reset pass
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form className="card" onSubmit={createUser}>
        <h2 style={{ marginTop: 0 }}>Crear usuario</h2>
        <div className="inline">
          <div style={{ flex: 2, minWidth: 220 }}>
            <label htmlFor="u-email">Email</label>
            <input
              id="u-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div style={{ flex: 1, minWidth: 180 }}>
            <label htmlFor="u-pass">Contraseña</label>
            <input
              id="u-pass"
              type="text"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="mínimo 8 caracteres"
            />
          </div>
          <div style={{ minWidth: 140 }}>
            <label htmlFor="u-role">Rol</label>
            <select id="u-role" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="developer">developer</option>
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <button type="submit">Crear</button>
        </div>
      </form>

      <h2>Política de publicación</h2>
      <p className="muted">
        Define qué severidades de hallazgos bloquean una publicación y los límites del bundle.
      </p>
      {policy && (
        <div className="card">
          <div className="inline" style={{ marginBottom: 16 }}>
            {SEVERITIES.map((s) => (
              <label key={s.value} style={{ display: 'flex', gap: 6, alignItems: 'center', color: 'var(--text)' }}>
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={policy.blockSeverities.includes(s.value)}
                  onChange={() => toggleSeverity(s.value)}
                />
                Bloquear {s.label}
              </label>
            ))}
          </div>
          <div className="inline">
            <div style={{ maxWidth: 200 }}>
              <label htmlFor="p-mb">Máx. bundle (MB)</label>
              <input
                id="p-mb"
                type="number"
                min={1}
                max={200}
                value={policy.maxBundleMb}
                onChange={(e) => setPolicy({ ...policy, maxBundleMb: Number(e.target.value) })}
              />
            </div>
            <div style={{ maxWidth: 200 }}>
              <label htmlFor="p-files">Máx. archivos</label>
              <input
                id="p-files"
                type="number"
                min={1}
                max={10000}
                value={policy.maxFiles}
                onChange={(e) => setPolicy({ ...policy, maxFiles: Number(e.target.value) })}
              />
            </div>
            <button type="button" onClick={savePolicy}>
              Guardar política
            </button>
          </div>
        </div>
      )}

      <h2>Revisión de código con LLM</h2>
      <p className="muted">
        Cuando está activa, cada publicación pasa además una revisión semántica (XSS, secretos, código
        ofuscado, exfiltración) por un modelo de lenguaje. Compatible con APIs estilo OpenAI (incluye
        Ollama, llama.cpp, vLLM locales) y Anthropic.
      </p>
      {llm && (
        <div className="card">
          <div className="inline" style={{ marginBottom: 16 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text)' }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={llm.enabled}
                onChange={(e) => setLlm({ ...llm, enabled: e.target.checked })}
              />
              Revisión LLM activada
            </label>
            {llm.apiKeyMasked && (
              <span className="muted">
                Clave actual: <span className="mono">{llm.apiKeyMasked}</span>
              </span>
            )}
          </div>
          <div className="inline" style={{ marginBottom: 16 }}>
            <div style={{ minWidth: 180 }}>
              <label htmlFor="l-provider">Proveedor</label>
              <select
                id="l-provider"
                value={llm.provider}
                onChange={(e) => {
                  const provider = e.target.value as LlmConfigView['provider'];
                  setLlm({ ...llm, provider, baseUrl: defaultBaseUrl(provider) });
                }}
              >
                <option value="openai">OpenAI-compatible</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </div>
            <div style={{ flex: 2, minWidth: 260 }}>
              <label htmlFor="l-url">URL base (vacía = oficial del proveedor)</label>
              <input
                id="l-url"
                value={llm.baseUrl}
                onChange={(e) => setLlm({ ...llm, baseUrl: e.target.value })}
                placeholder={defaultBaseUrl(llm.provider)}
              />
            </div>
            <div style={{ flex: 1, minWidth: 180 }}>
              <label htmlFor="l-model">Modelo</label>
              <input
                id="l-model"
                value={llm.model}
                onChange={(e) => setLlm({ ...llm, model: e.target.value })}
                placeholder="gpt-4o-mini / claude-… / qwen3:8b"
              />
            </div>
          </div>
          <div className="inline" style={{ marginBottom: 16 }}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <label htmlFor="l-key">API key {llm.apiKeyMasked && '(dejar vacío para conservar)'}</label>
              <input
                id="l-key"
                type="password"
                value={llmApiKey}
                onChange={(e) => setLlmApiKey(e.target.value)}
                placeholder={llm.apiKeyMasked || 'sk-…'}
                autoComplete="off"
              />
            </div>
            <div style={{ minWidth: 280 }}>
              <label htmlFor="l-unavail">Cuando el LLM no responde</label>
              <select
                id="l-unavail"
                value={llm.onUnavailable}
                onChange={(e) => setLlm({ ...llm, onUnavailable: e.target.value as LlmConfigView['onUnavailable'] })}
              >
                <option value="continue">Continuar con advertencia</option>
                <option value="block">Bloquear la publicación</option>
              </select>
            </div>
          </div>
          <p className="muted" style={{ marginBottom: 12 }}>
            Los hallazgos del LLM usan las mismas severidades y la misma política de bloqueo que las reglas
            estáticas. Archivos sin cambios entre versiones no se re-analizan (caché por hash). Para un LLM
            local en el host, usa <span className="mono">http://host.containers.internal:puerto</span> como URL
            base (podman) y déjala accesible desde el contenedor del API.
          </p>
          <button type="button" onClick={saveLlm}>
            Guardar revisión LLM
          </button>
        </div>
      )}
    </div>
  );
}
