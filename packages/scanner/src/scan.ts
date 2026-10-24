import { type AppManifest, type Finding, type Policy, blocksPublish, firstUrlHost, normalizeDomain } from '@vch/shared';
import type { BundleEntry } from './types.js';
import { RULES } from './rules.js';
import { checkReferences } from './references.js';
import { checkSdkUsage } from './sdk.js';
import { validateStructure, type Limits } from './structure.js';

const TEXT_EXTENSIONS = new Set(['html', 'js', 'css', 'json', 'xml']);
const MAX_SNIPPET = 160;

export interface ScanResult {
  findings: Finding[];
  manifest: AppManifest | null;
}

/** Reglas cuyo hallazgo se omite cuando el host de la URL está en la allowlist del admin. */
const ALLOWLIST_AWARE_RULES = new Set([
  'remote-script',
  'remote-stylesheet',
  'remote-iframe',
  'remote-image',
  'remote-fetch',
  'xmlhttprequest',
  'no-websocket',
  'no-dynamic-import-url',
]);

/**
 * Pipeline de revisión estático: estructura + reglas.
 * El veredicto depende de la política: severidad ≥ umbral bloquea.
 * `externalAllowlist`: dominios aprobados por el admin (v0.3); las reglas de
 * recursos remotos no hallan URLs cuyo host esté aprobado.
 */
export function scanBundle(
  entries: BundleEntry[],
  policy: Policy,
  externalAllowlist: string[] = [],
): ScanResult {
  const findings: Finding[] = [];
  const { findings: structureFindings, manifest } = validateStructure(entries, {
    maxFiles: policy.maxFiles,
    maxBundleMb: policy.maxBundleMb,
  });
  findings.push(...structureFindings);

  const files = entries.filter((e) => !e.isDir);

  for (const entry of files) {
    const ext = entry.path.split('.').pop()?.toLowerCase() ?? '';
    if (!TEXT_EXTENSIONS.has(ext)) continue;

    let text: string;
    try {
      text = entry.data.toString('utf8');
    } catch {
      findings.push({
        rule: 'encoding-invalid',
        severity: 'medium',
        file: entry.path,
        line: 0,
        message: 'El archivo no es texto UTF-8 válido.',
        fix: 'Guarda el archivo con codificación UTF-8.',
      });
      continue;
    }
    const lines = text.split(/\r?\n/);

    for (const rule of RULES) {
      if (!rule.exts.includes(ext as never)) continue;
      for (let i = 0; i < lines.length; i++) {
        rule.pattern.lastIndex = 0;
        if (rule.pattern.test(lines[i])) {
          // Dominio aprobado por el admin ⇒ la regla de recurso remoto no aplica.
          if (
            externalAllowlist.length > 0 &&
            ALLOWLIST_AWARE_RULES.has(rule.id) &&
            externalAllowlist.includes(firstUrlHost(lines[i]) ?? '')
          ) {
            continue;
          }
          findings.push({
            rule: rule.id,
            severity: rule.severity,
            file: entry.path,
            line: i + 1,
            snippet: lines[i].trim().slice(0, MAX_SNIPPET),
            message: rule.message,
            fix: rule.fix,
          });
        }
      }
    }
  }

  // Referencias locales rotas: html que apunta a archivos ausentes del zip.
  findings.push(...checkReferences(entries));

  // Uso de VCH.db sin cargar /db/sdk.js: persistencia rota (o silenciosa).
  findings.push(...checkSdkUsage(entries));

  // Dominios externos declarados: solo se aceptan si el admin los aprobó en
  // la allowlist (v0.3). Cada dominio pendiente genera su hallazgo accionable.
  if (manifest && manifest.externalDomains && manifest.externalDomains.length > 0) {
    const approved = new Set(externalAllowlist);
    const pending = manifest.externalDomains
      .map((d) => ({ declared: d, normalized: normalizeDomain(d) }))
      .filter((d) => !d.normalized || !approved.has(d.normalized));
    for (const p of pending) {
      findings.push({
        rule: 'manifest-external-domains',
        severity: 'high',
        file: 'app.json',
        line: 0,
        snippet: p.declared.slice(0, MAX_SNIPPET),
        message: p.normalized
          ? `El dominio externo "${p.normalized}" no está aprobado por la empresa.`
          : `El dominio declarado "${p.declared}" no tiene formato válido (usa api.ejemplo.com, sin esquema ni ruta).`,
        fix: 'Solicita al admin agregarlo en Panel → Dominios externos, o elimina la dependencia externa.',
      });
    }
  }

  return { findings, manifest };
}

export function verdictFromFindings(findings: Finding[], policy: Policy): 'published' | 'rejected' {
  return findings.some((f) => blocksPublish(policy, f.severity)) ? 'rejected' : 'published';
}
