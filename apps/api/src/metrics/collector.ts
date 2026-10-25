import type { DbClient } from '../db.js';

/**
 * Collector de métricas de uso (docs/design-v1.0-metrics-audit.md §4.2).
 * count() acumula en memoria; cada 10 s un flush persiste los agregados del
 * día con upsert incremental. Ante crash se pierden ≤10 s de agregados
 * (aceptable para métricas de uso, documentado en el diseño).
 */

const FLUSH_INTERVAL_MS = 10_000;

const buffer = new Map<string, Map<string, Map<string, number>>>(); // día → métrica → clave → valor
let timer: NodeJS.Timeout | null = null;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Cuenta n eventos de una métrica (clave opcional, ej.: slug de la app). */
export function count(metric: string, key = '', n = 1): void {
  if (n === 0) return;
  const day = buffer.get(today()) ?? new Map();
  const byKey = day.get(metric) ?? new Map();
  byKey.set(key, (byKey.get(key) ?? 0) + n);
  day.set(metric, byKey);
  buffer.set(today(), day);
}

/** Upsert incremental de todos los conteos pendientes. Re-bufferiza si falla. */
export async function flushMetrics(db: DbClient): Promise<void> {
  if (buffer.size === 0) return;
  const pending: { day: string; metric: string; key: string; value: number }[] = [];
  for (const [day, byMetric] of buffer) {
    for (const [metric, byKey] of byMetric) {
      for (const [key, value] of byKey) pending.push({ day, metric, key, value });
    }
  }
  buffer.clear();
  try {
    for (const p of pending) {
      await db.query(
        `INSERT INTO metric_daily (day, metric, key, value) VALUES ($1, $2, $3, $4)
         ON CONFLICT (day, metric, key) DO UPDATE SET value = metric_daily.value + $4`,
        [p.day, p.metric, p.key, p.value],
      );
    }
  } catch (err) {
    // No perder conteos: devolverlos al buffer y registrar el fallo.
    for (const p of pending) count(p.metric, p.key, p.value);
    console.error('[metrics] flush falló, conteos re-bufferizados:', (err as Error).message);
  }
}

/** Arranca el flush periódico (una sola vez por proceso). */
export function startMetricFlusher(db: DbClient): void {
  if (timer) return;
  timer = setInterval(() => {
    void flushMetrics(db);
  }, FLUSH_INTERVAL_MS);
  timer.unref(); // no impide que el proceso termine
}
