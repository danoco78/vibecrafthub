/**
 * Hallazgos (findings) del pipeline de publicación.
 * Todo intento de publicación produce una lista de findings, exitoso o no.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

export interface Finding {
  /** Identificador de la regla o etapa que generó el hallazgo, ej: "no-eval", "structure-extension" */
  rule: string;
  severity: Severity;
  /** Archivo relativo dentro del bundle, o "bundle" si aplica a todo */
  file: string;
  /** Línea 1-based; 0 si no aplica */
  line: number;
  /** Fragmento de código encontrado (truncado) */
  snippet?: string;
  /** Descripción del problema */
  message: string;
  /** Cómo corregirlo */
  fix: string;
}

export type PublishVerdict = 'published' | 'rejected';

export function maxSeverity(findings: Finding[]): Severity | null {
  let max: Severity | null = null;
  for (const f of findings) {
    if (max === null || SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[max]) {
      max = f.severity;
    }
  }
  return max;
}

export function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}
