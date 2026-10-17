import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError, type AppInfo, type PublishOutcome } from '../api';
import { FindingsTable } from '../components/Findings';
import { useAuth } from '../App';

export default function PublishPage() {
  const { user, appsUrlTemplate } = useAuth();
  const [params] = useSearchParams();
  const [apps, setApps] = useState<AppInfo[]>([]);
  const [slug, setSlug] = useState(params.get('app') ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [outcome, setOutcome] = useState<PublishOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .listApps()
      .then((r) => {
        const mine = r.apps.filter((a) => a.owner_id === user?.id || user?.role === 'admin');
        setApps(mine);
        if (!slug && mine.length > 0) setSlug(mine[0].slug);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function upload(selected: File | null) {
    if (!selected || !slug) return;
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const res = await api.publish(slug, selected);
      setOutcome(res);
    } catch (err) {
      // Un rechazo puede llegar con código 4xx/5xx pero con el outcome completo
      const body = err instanceof ApiError ? err.body : null;
      if (body && typeof body === 'object' && 'verdict' in body) {
        setOutcome(body as PublishOutcome);
      } else {
        setError(err instanceof Error ? err.message : 'Error de publicación');
      }
    } finally {
      setBusy(false);
    }
  }

  function pickFile(f: File | null) {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.zip')) {
      setError('Selecciona un archivo .zip');
      return;
    }
    setError(null);
    setOutcome(null);
    setFile(f);
  }

  const selectedApp = apps.find((a) => a.slug === slug);

  return (
    <div>
      <h1>Publicar aplicación</h1>
      {error && <div className="banner err">{error}</div>}

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="inline">
          <div style={{ flex: 1, minWidth: 240 }}>
            <label htmlFor="app-select">Aplicación</label>
            <select id="app-select" value={slug} onChange={(e) => setSlug(e.target.value)}>
              {apps.length === 0 && <option value="">— crea primero una app en “Mis apps” —</option>}
              {apps.map((a) => (
                <option key={a.slug} value={a.slug}>
                  {a.name} ({a.slug})
                </option>
              ))}
            </select>
          </div>
          <Link className="btn secondary" to="/my-apps">
            Nueva app
          </Link>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          El zip debe contener un <span className="mono">app.json</span> con name, version y entrypoint, y solo
          archivos html, js, css, json, xml o sqlite. Cada intento queda registrado en el historial.
        </p>
      </div>

      <div
        className={`dropzone${over ? ' over' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          pickFile(e.dataTransfer.files[0] ?? null);
        }}
      >
        {file ? (
          <>
            <strong>{file.name}</strong>
            <div className="muted">{(file.size / 1024 / 1024).toFixed(2)} MB — haz clic para cambiar</div>
          </>
        ) : (
          <>Arrastra el <span className="mono">.zip</span> aquí o haz clic para seleccionarlo</>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".zip"
        hidden
        onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
      />

      <div className="mt">
        <button disabled={!file || !slug || busy} onClick={() => upload(file)}>
          {busy ? 'Revisando bundle…' : 'Enviar a revisión'}
        </button>
      </div>

      {busy && <div className="banner info mt">El pipeline está revisando estructura, reglas de seguridad y política…</div>}

      {outcome && (
        <div className="mt">
          {outcome.verdict === 'published' ? (
            <div className="banner ok">
              ✔ Publicado: versión v{outcome.version} de “{selectedApp?.name}”.
              {outcome.findings.length > 0 && ' Con observaciones no bloqueantes, revisa abajo.'}
            </div>
          ) : (
            <div className="banner err">
              ✖ Publicación rechazada. Corrige los hallazgos bloqueantes y vuelve a intentarlo.
            </div>
          )}
          <h2>Hallazgos ({outcome.findings.length})</h2>
          <FindingsTable findings={outcome.findings} />
          {outcome.meta?.llm && (
            <p className="muted">
              Revisión LLM ({outcome.meta.llm.provider} · {outcome.meta.llm.model}):{' '}
              {outcome.meta.llm.reviewed} archivo(s) analizados
              {outcome.meta.llm.cached > 0 && `, ${outcome.meta.llm.cached} desde caché`}
              {!outcome.meta.llm.available && ' · LLM no disponible durante esta publicación'}
            </p>
          )}
          {outcome.verdict === 'published' && selectedApp && (
            <p>
              URL de la app:{' '}
              <a href={appsUrlTemplate.replace('{slug}', slug)} target="_blank" rel="noreferrer" className="mono">
                {appsUrlTemplate.replace('{slug}', slug)}
              </a>{' '}
              · <Link to={`/apps/${slug}`}>Ver en el catálogo</Link>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
