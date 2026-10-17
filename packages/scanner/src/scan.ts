import { type AppManifest, type Finding, type Policy, blocksPublish } from '@vch/shared';
import type { BundleEntry } from './types.js';
import { RULES } from './rules.js';
import { checkReferences } from './references.js';
import { validateStructure, type Limits } from './structure.js';

const TEXT_EXTENSIONS = new Set(['html', 'js', 'css', 'json', 'xml']);
const MAX_SNIPPET = 160;

export interface ScanResult {
  findings: Finding[];
  manifest: AppManifest | null;
}

/**
 * Pipeline de revisión estático: estructura + reglas.
 * El veredicto depende de la política: severidad ≥ umbral bloquea.
 */
export function scanBundle(entries: BundleEntry[], policy: Policy): ScanResult {
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

  // Dominios externos declarados: la allowlist global llega en v2,
  // así que cualquier dominio externo genera hallazgo alto.
  if (manifest && manifest.externalDomains && manifest.externalDomains.length > 0) {
    findings.push({
      rule: 'manifest-external-domains',
      severity: 'high',
      file: 'app.json',
      line: 0,
      snippet: manifest.externalDomains.join(', ').slice(0, MAX_SNIPPET),
      message:
        'La app declara dominios externos, pero la empresa aún no tiene allowlist de dominios configurada.',
      fix: 'Elimina las llamadas a dominios externos, o pide al admin habilitar el allowlist de dominios.',
    });
  }

  return { findings, manifest };
}

export function verdictFromFindings(findings: Finding[], policy: Policy): 'published' | 'rejected' {
  return findings.some((f) => blocksPublish(policy, f.severity)) ? 'rejected' : 'published';
}
