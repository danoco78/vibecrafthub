import { useEffect, useState, type FormEvent } from 'react';
import { api, type User } from '../api';

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
  const [users, setUsers] = useState<User[]>([]);
  const [policy, setPolicy] = useState<Policy | null>(null);
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
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.email}</td>
                <td>
                  <span className="badge info">{u.role}</span>
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
    </div>
  );
}
