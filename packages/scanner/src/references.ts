import type { Finding } from '@vch/shared';
import type { BundleEntry } from './types.js';

/**
 * Referencias locales rotas: un HTML que apunta a archivos que no vienen en el
 * zip (js/app.js, css/style.css…) produce una app publicada muerta. Es el error
 * más común al armar bundles generados con IA: el pipeline lo rechaza con un
 * reporte explícito en vez de publicar a ciegas.
 *
 * Solo se revisan src/href con extensión permitida; los recursos externos
 * (http/https) ya tienen sus propias reglas, y /db/* lo sirve la plataforma.
 */

const MAX_SNIPPET = 160;
const REF_RE = /(?<![\w-])(?:src|href)\s*=\s*["']([^"']+)["']/gi;
const ALLOWED_REF_EXTS = new Set(['html', 'js', 'css', 'json', 'xml', 'sqlite']);

function skipRef(ref: string): boolean {
  const r = ref.trim();
  if (!r || r.startsWith('#')) return true;
  if (/^(?:data|mailto|tel|javascript|blob):/i.test(r)) return true;
  if (/^https?:\/\//i.test(r) || r.startsWith('//')) return true;
  if (/^\/db(?:\/|$)/i.test(r)) return true; // namespace del data gateway (sdk.js)
  return false;
}

/** Resuelve la referencia contra el directorio del HTML ('a/./b/../c' → 'a/c'). */
function resolveRef(fromHtmlPath: string, ref: string): string {
  const clean = ref.trim().replace(/[?#].*$/, '');
  const baseDir = fromHtmlPath.includes('/')
    ? fromHtmlPath.slice(0, fromHtmlPath.lastIndexOf('/') + 1)
    : '';
  const segments = (clean.startsWith('/') ? clean.slice(1) : baseDir + clean).split('/');
  const out: string[] = [];
  for (const seg of segments) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

export function checkReferences(entries: BundleEntry[]): Finding[] {
  const findings: Finding[] = [];
  const present = new Set(entries.filter((e) => !e.isDir).map((e) => e.path));

  for (const entry of entries) {
    if (entry.isDir || !entry.path.toLowerCase().endsWith('.html')) continue;
    const lines = entry.data.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      REF_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = REF_RE.exec(lines[i])) !== null) {
        const raw = match[1];
        if (skipRef(raw)) continue;
        const ext = (raw.split(/[?#]/)[0].split('.').pop() ?? '').toLowerCase();
        if (!ALLOWED_REF_EXTS.has(ext)) continue; // favicon.ico, rutas de API, etc.
        const resolved = resolveRef(entry.path, raw);
        if (!present.has(resolved)) {
          findings.push({
            rule: 'missing-referenced-file',
            severity: 'high',
            file: entry.path,
            line: i + 1,
            snippet: lines[i].trim().slice(0, MAX_SNIPPET),
            message: `Se referencia "${raw.trim()}" pero ese archivo no viene en el bundle (resuelve a "${resolved}"). La app se publica sin esa parte y queda rota.`,
            fix: 'Incluye el archivo en el zip (verifica rutas relativas y que el zip contenga TODOS los archivos) o elimina la referencia del HTML.',
          });
        }
      }
    }
  }
  return findings;
}
