import type { Finding } from '@vch/shared';
import type { BundleEntry } from './types.js';

const MAX_SNIPPET = 160;

/**
 * Uso del data gateway sin cargar su SDK: si un archivo usa VCH.db pero
 * ningún HTML carga /db/sdk.js, VCH es undefined en el navegador. Peor aún,
 * las apps "resistentes" suelen degradar en silencio y funcionar sin
 * persistencia: el usuario pierde los datos sin ver ningún error.
 * Se detecta en el pipeline, no en runtime.
 */

const USES_VCH_RE = /\bVCH\s*\.\s*db\b|window\s*\.\s*VCH\b/;
const SDK_SCRIPT_RE = /<script[^>]*\bsrc\s*=\s*["']\/db\/sdk\.js/i;
const TEXT_EXTS = new Set(['html', 'js', 'json', 'xml']);

export function checkSdkUsage(entries: BundleEntry[]): Finding[] {
  const files = entries.filter((e) => !e.isDir);
  const sdkLoaded = files.some(
    (e) => e.path.toLowerCase().endsWith('.html') && SDK_SCRIPT_RE.test(e.data.toString('utf8')),
  );
  if (sdkLoaded) return [];

  const findings: Finding[] = [];
  for (const entry of files) {
    const ext = entry.path.split('.').pop()?.toLowerCase() ?? '';
    if (!TEXT_EXTS.has(ext)) continue;
    const lines = entry.data.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (USES_VCH_RE.test(lines[i])) {
        findings.push({
          rule: 'vch-sdk-not-loaded',
          severity: 'high',
          file: entry.path,
          line: i + 1,
          snippet: lines[i].trim().slice(0, MAX_SNIPPET),
          message:
            'La app usa VCH.db (data gateway) pero ningún HTML carga /db/sdk.js: VCH no existe en el navegador y la persistencia no funciona (o falla en silencio).',
          fix:
            'En el <head> del index.html agrega <script src="/db/sdk.js"></script> ANTES de tus archivos .js. Para publicar datos compartidos es obligatorio.',
        });
        break; // un hallazgo por archivo basta
      }
    }
  }
  return findings;
}
