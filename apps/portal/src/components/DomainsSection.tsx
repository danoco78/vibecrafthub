import { useEffect, useState } from 'react';
import { api } from '../api';

interface DomainRow {
  domain: string;
  note: string;
  created_at: string;
}

/** Sección admin: allowlist de dominios externos (docs/design-v0.3.md §5). */
export default function DomainsSection() {
  const [rows, setRows] = useState<DomainRow[]>([]);
  const [domain, setDomain] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function load() {
    api
      .externalDomains()
      .then((r) => setRows(r.domains))
      .catch((e) => setError(e instanceof Error ? e.message : 'Error'));
  }
  useEffect(load, []);

  async function add() {
    setError(null);
    setNotice(null);
    try {
      await api.addExternalDomain(domain.trim(), note.trim());
      setNotice(`${domain.trim()} aprobado: las apps que lo declaren pasarán el pipeline y obtendrán su CSP.`);
      setDomain('');
      setNote('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    }
  }

  async function remove(d: string) {
    if (!window.confirm(`¿Quitar "${d}" de la allowlist? Las apps que lo usan no podrán volver a publicarse hasta renovar la aprobación.`)) return;
    setError(null);
    try {
      await api.removeExternalDomain(d);
      setNotice(`${d} eliminado.`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error');
    }
  }

  return (
    <>
      <h2>Dominios externos aprobados</h2>
      <p className="muted">
        Las apps declaran en su app.json los dominios que necesitan (externalDomains). Solo pasan el
        pipeline y obtienen CSP los dominios de esta lista. Quitar un dominio no rompe apps ya
        publicadas, pero sí bloquea su próxima publicación.
      </p>
      {error && <div className="banner err">{error}</div>}
      {notice && <div className="banner ok">{notice}</div>}
      <div className="card" style={{ padding: 0, marginBottom: 12 }}>
        <table>
          <thead>
            <tr>
              <th>Dominio</th>
              <th>Nota</th>
              <th>Aprobado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  Todavía no hay dominios aprobados.
                </td>
              </tr>
            )}
            {rows.map((d) => (
              <tr key={d.domain}>
                <td className="mono">{d.domain}</td>
                <td className="muted">{d.note}</td>
                <td className="muted">{new Date(d.created_at).toLocaleDateString()}</td>
                <td>
                  <button className="secondary" onClick={() => remove(d.domain)}>
                    Quitar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card inline">
        <div style={{ flex: 2, minWidth: 240 }}>
          <label htmlFor="ed-domain">Dominio</label>
          <input
            id="ed-domain"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="api.empresa.com"
          />
        </div>
        <div style={{ flex: 2, minWidth: 220 }}>
          <label htmlFor="ed-note">Nota (opcional)</label>
          <input
            id="ed-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="¿Para qué se aprueba?"
          />
        </div>
        <button onClick={add}>Aprobar dominio</button>
      </div>
    </>
  );
}
