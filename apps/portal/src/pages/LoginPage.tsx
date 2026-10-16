import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../App';

export default function LoginPage() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Redirección en useEffect, nunca durante el render
  useEffect(() => {
    if (user) navigate('/', { replace: true });
  }, [user, navigate]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = mode === 'login' ? await api.login(email, password) : await api.register(email, password);
      setUser(res.user);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error inesperado');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 380, margin: '80px auto', padding: '0 20px' }}>
      <h1 style={{ textAlign: 'center' }}>
        Vibe<span style={{ color: 'var(--accent)' }}>Craft</span>Hub
      </h1>
      <form className="card" onSubmit={submit}>
        {error && (
          <div className="banner err" role="alert">
            {error}
          </div>
        )}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="tu@empresa.com"
          />
        </div>
        <div className="field">
          <label htmlFor="password">Contraseña</label>
          <input
            id="password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
          />
        </div>
        <button type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Procesando…' : mode === 'login' ? 'Ingresar' : 'Crear cuenta admin'}
        </button>
        <p className="muted" style={{ marginTop: 14, textAlign: 'center' }}>
          {mode === 'login' ? (
            <>
              ¿Sin cuenta?{' '}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setMode('register');
                }}
              >
                Registro (primer usuario = admin)
              </a>
            </>
          ) : (
            <>
              ¿Ya tienes cuenta?{' '}
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  setMode('login');
                }}
              >
                Ingresar
              </a>
            </>
          )}
        </p>
      </form>
    </div>
  );
}
