import { useState, type FormEvent } from 'react';
import { api } from '../api';

export default function AccountPage() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (next !== repeat) {
      setError('Las contraseñas nuevas no coinciden.');
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setNotice('Contraseña actualizada.');
      setCurrent('');
      setNext('');
      setRepeat('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 420 }}>
      <h1>Mi cuenta</h1>
      {error && <div className="banner err">{error}</div>}
      {notice && <div className="banner ok">{notice}</div>}
      <form className="card" onSubmit={submit}>
        <h2 style={{ marginTop: 0 }}>Cambiar contraseña</h2>
        <div className="field">
          <label htmlFor="cp-current">Contraseña actual</label>
          <input
            id="cp-current"
            type="password"
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="cp-new">Contraseña nueva</label>
          <input
            id="cp-new"
            type="password"
            required
            minLength={8}
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder="mínimo 8 caracteres, letras y números"
          />
        </div>
        <div className="field">
          <label htmlFor="cp-repeat">Repetir contraseña nueva</label>
          <input
            id="cp-repeat"
            type="password"
            required
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
          />
        </div>
        <button type="submit" disabled={busy}>
          {busy ? 'Guardando…' : 'Cambiar contraseña'}
        </button>
      </form>
    </div>
  );
}
