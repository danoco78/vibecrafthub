import { useMemo, useState } from 'react';

/**
 * Asistente "¿Cómo crear mis apps?": un formulario corto cuyas respuestas se
 * integran en un prompt listo para pegar en cualquier IA, con todas las
 * restricciones de la plataforma ya incorporadas (formato del bundle, reglas
 * del pipeline y SDK del data gateway). El empleado no necesita saber nada
 * técnico: copia el prompt, la IA le devuelve los archivos, y los sube.
 */

interface Answers {
  nombre: string;
  proposito: string;
  datos: string;
  audiencia: string;
  compartido: boolean;
}

const INITIAL: Answers = {
  nombre: '',
  proposito: '',
  datos: '',
  audiencia: '',
  compartido: true,
};

export function buildPrompt(a: Answers): string {
  const nombre = a.nombre?.trim() || '<nombre de tu app>';
  const proposito = a.proposito?.trim() || '<qué debe hacer tu app>';
  const datos = a.datos?.trim() || '<qué información guarda la app>';
  const audiencia = a.audiencia?.trim() || 'empleados de la empresa';
  const compartido = a.compartido !== false;

  return `Construye una aplicación web interna para publicarla en VibeCraftHub, la plataforma de apps internas de la empresa. Entrégala como archivos completos listos para empaquetar en un zip, sin pasos de instalación ni compilación.

## Qué necesito
- Nombre de la app: ${nombre}
- Qué debe hacer: ${proposito}
- Información que va a guardar o manejar: ${datos}
- Quiénes la van a usar: ${audiencia}
- ¿Los datos se comparten entre todos los usuarios de la app? ${
    compartido
      ? 'Sí — usa el SDK de persistencia descrito más abajo.'
      : 'No — la app puede funcionar sin servidor (localStorage del navegador).'
  }

## Restricciones obligatorias de la plataforma (un revisor automático rechaza lo que las rompa)
1. El zip debe contener un archivo app.json en la raíz, con este formato:
   {"name": "<nombre>", "version": "1.0.0", "entrypoint": "index.html", "description": "<una frase>"}
   La versión es semver y debe incrementarse en cada actualización (1.0.1, 1.1.0, 2.0.0…).
2. Extensiones permitidas ÚNICAMENTE: .html, .js, .css, .json, .xml, .sqlite. Cualquier otro archivo se rechaza.
3. Todo autocontenido: ningún recurso remoto (CDNs, fuentes externas, imágenes de internet, WebSockets, fetch a otros dominios). Todos los assets van dentro del zip.
4. Prohibido usar: eval, new Function, innerHTML, document.write, handlers inline (onclick="…"), service workers y secretos o API keys embebidas. Construye el HTML con createElement/textContent o plantillas seguras.
5. El entrypoint es index.html; organiza el JavaScript y el CSS en archivos propios.
6. Límites: máximo 20 MB y 500 archivos en total.
7. Los archivos finales deben funcionar al abrirse tal cual: nada que compilar ni instalar.
${
  compartido
    ? `
## Persistencia (SDK del data gateway)
Los usuarios comparten una base de datos SQLite por app mediante el SDK de la plataforma. Ya está disponible en la página, no hay que instalar nada:

<script src="/db/sdk.js"></script>
<script>
  // El esquema es responsabilidad de la app; la BD persiste entre versiones.
  await VCH.db.run('CREATE TABLE IF NOT EXISTS notas (id INTEGER PRIMARY KEY, autor TEXT, texto TEXT, fecha TEXT)');
  await VCH.db.run('INSERT INTO notas (autor, texto, fecha) VALUES (?, ?, ?)', [autor, texto, fecha]); // SIEMPRE con placeholders
  const { rows, truncated } = await VCH.db.all('SELECT * FROM notas ORDER BY fecha DESC');
  const una = await VCH.db.get('SELECT * FROM notas WHERE id = ?', [id]);
</script>

- Un statement por llamada a VCH.db.*; los valores SIEMPRE con ? o :nombre (nunca concatenados).
- Datos iniciales idempotentes: CREATE TABLE IF NOT EXISTS + INSERT OR IGNORE, para no duplicarlos al publicar una nueva versión.
- Los errores llegan como Error con .code (ej.: VCH_DB_QUOTA_EXCEEDED, VCH_DB_RATE_LIMITED): muéstralos con mensajes amables.
`
    : ''
}
## Formato de entrega
- La lista completa de archivos, cada uno con su contenido íntegro (sin pseudocódigo ni "…" que abrevie).
- Interfaz en español, limpia y directa para personas sin formación técnica: textos claros, botones evidentes, validación de formularios y mensajes de error amables.
- Cierra indicando en 3 pasos cómo empaquetar el zip y publicarlo desde el portal.`;
}

export default function PromptWizard({ onClose }: { onClose: () => void }) {
  const [a, setA] = useState<Answers>(INITIAL);
  const [copied, setCopied] = useState(false);
  const prompt = useMemo(() => buildPrompt(a), [a]);
  const ready = a.nombre.trim().length > 0 && a.proposito.trim().length > 0;

  function set<K extends keyof Answers>(key: K, value: Answers[K]) {
    setA((prev) => ({ ...prev, [key]: value }));
    setCopied(false);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
    } catch {
      // fallback para contextos sin Clipboard API
      const el = document.getElementById('vch-prompt-text') as HTMLTextAreaElement | null;
      if (!el) return;
      el.select();
      document.execCommand('copy');
      setCopied(true);
    }
  }

  function download() {
    const blob = new Blob([prompt], { type: 'text/plain; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `prompt-${(a.nombre.trim() || 'mi-app').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h1 style={{ margin: 0 }}>¿Cómo crear mis apps?</h1>
          <button className="secondary" onClick={onClose} aria-label="Cerrar">
            ✕
          </button>
        </div>
        <p className="muted" style={{ marginTop: 10 }}>
          Responde unas preguntas y te armamos la instrucción exacta para pedírsela a tu IA
          (ChatGPT, Claude, Copilot…). La IA te devuelve los archivos de la app respetando todas las
          reglas de la plataforma — tú solo los empaquetas y los subes.
        </p>

        <div className="field">
          <label htmlFor="pw-nombre">1 · ¿Cómo se llama tu app?</label>
          <input
            id="pw-nombre"
            maxLength={64}
            value={a.nombre}
            onChange={(e) => set('nombre', e.target.value)}
            placeholder="Ej: Reserva de salas"
          />
        </div>
        <div className="field">
          <label htmlFor="pw-proposito">2 · ¿Qué debe hacer? Explícalo como se lo contarías a un colega</label>
          <textarea
            id="pw-proposito"
            rows={3}
            maxLength={1000}
            value={a.proposito}
            onChange={(e) => set('proposito', e.target.value)}
            placeholder="Ej: Que cualquiera pueda reservar una sala de reuniones por día y hora, ver las reservas existentes y cancelar la suya."
          />
        </div>
        <div className="field">
          <label htmlFor="pw-datos">3 · ¿Qué información va a guardar? (opcional)</label>
          <input
            id="pw-datos"
            maxLength={300}
            value={a.datos}
            onChange={(e) => set('datos', e.target.value)}
            placeholder="Ej: sala, fecha, hora, quién reservó"
          />
        </div>
        <div className="field">
          <label htmlFor="pw-audiencia">4 · ¿Quiénes la van a usar? (opcional)</label>
          <input
            id="pw-audiencia"
            maxLength={200}
            value={a.audiencia}
            onChange={(e) => set('audiencia', e.target.value)}
            placeholder="Ej: todos los empleados de la oficina"
          />
        </div>
        <div className="field">
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text)', fontSize: 14 }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={a.compartido}
              onChange={(e) => set('compartido', e.target.checked)}
            />
            Todos los usuarios ven y comparten los mismos datos
          </label>
          {!a.compartido && (
            <p className="muted" style={{ margin: '6px 0 0' }}>
              La app funcionará con datos locales del navegador de cada persona.
            </p>
          )}
        </div>

        {!ready && <div className="banner info">Completa al menos el nombre y qué debe hacer, y el prompt se genera abajo.</div>}
        {ready && (
          <>
            <div className="field">
              <label htmlFor="vch-prompt-text">Tu prompt, listo para copiar</label>
              <textarea
                id="vch-prompt-text"
                className="mono"
                rows={12}
                readOnly
                value={prompt}
                onFocus={(e) => e.currentTarget.select()}
              />
            </div>
            <div className="inline">
              <button onClick={copy}>{copied ? '✓ Copiado' : 'Copiar prompt'}</button>
              <button className="secondary" onClick={download}>
                Descargar .txt
              </button>
              <span className="muted">
                Pégalo en tu IA, guarda los archivos que te devuelva en un zip y publícalo en «Nueva aplicación».
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
