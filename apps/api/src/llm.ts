import crypto from 'node:crypto';
import { type Finding, type Severity } from '@vch/shared';
import type { BundleEntry } from '@vch/scanner';
import type { DbClient } from './db.js';

/**
 * Etapa 3 del pipeline: revisión semántica con LLM.
 * El proveedor lo configura el admin (panel): OpenAI-compatible o Anthropic,
 * cloud o local. Los hallazgos se integran con el mismo esquema de severidades
 * y quedan auditados en publish_attempts con el modelo usado.
 */

export interface LlmConfig {
  enabled: boolean;
  provider: 'openai' | 'anthropic';
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Si el LLM no responde: 'continue' agrega hallazgo informativo; 'block' agrega crítico */
  onUnavailable: 'continue' | 'block';
}

export const DEFAULT_LLM_BASE_URL: Record<LlmConfig['provider'], string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

const NULL_CONFIG: LlmConfig = {
  enabled: false,
  provider: 'openai',
  baseUrl: DEFAULT_LLM_BASE_URL.openai,
  model: '',
  apiKey: '',
  onUnavailable: 'continue',
};

export async function loadLlmConfig(db: DbClient): Promise<LlmConfig> {
  try {
    const res = await db.query<{
      enabled: boolean;
      provider: LlmConfig['provider'];
      base_url: string;
      model: string;
      api_key: string;
      on_unavailable: LlmConfig['onUnavailable'];
    }>('SELECT enabled, provider, base_url, model, api_key, on_unavailable FROM llm_config WHERE id = 1');
    const row = res.rows[0];
    if (!row) return NULL_CONFIG;
    return {
      enabled: row.enabled,
      provider: row.provider,
      baseUrl: row.base_url || DEFAULT_LLM_BASE_URL[row.provider],
      model: row.model,
      apiKey: row.api_key,
      onUnavailable: row.on_unavailable,
    };
  } catch {
    return NULL_CONFIG;
  }
}

export function maskApiKey(key: string): string {
  return key.length > 4 ? `••••${key.slice(-4)}` : '';
}

// ---------- límites ----------

const TEXT_EXTENSIONS = new Set(['html', 'js', 'css', 'json', 'xml']);
const MAX_FILE_BYTES = 64 * 1024;
const MAX_FILES = 30;
const CALL_TIMEOUT_MS = 60_000;

const SYSTEM_PROMPT = `Actúas como revisor de seguridad de aplicaciones web estáticas (html, js, css, json, xml) que corren aisladas en un entorno corporativo.
Detecta en el archivo entregado: XSS (datos no confiables que llegan al DOM), secretos o credenciales embebidos, código ofuscado o con doble lectura, exfiltración de datos hacia terceros, carga remota de código, keyloggers, y lógica claramente maliciosa.
NO reportes estilo de código, rendimiento ni sugerencias cosméticas. NO inventes hallazgos: si el archivo es seguro responde un array vacío.
Responde ÚNICAMENTE con un array JSON válido, sin texto adicional. Cada elemento:
{"severity": "critical"|"high"|"medium"|"low", "rule": "id-corto-en-kebab-case", "line": <número de línea 1-based>, "message": "descripción del riesgo", "fix": "cómo corregirlo"}`;

const VALID_SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export interface LlmReviewMeta {
  provider: string;
  model: string;
  reviewed: number;
  cached: number;
  skipped: number;
  available: boolean;
}

export interface LlmReviewResult {
  findings: Finding[];
  meta: LlmReviewMeta;
}

function sha256(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Extrae y valida el array JSON que devuelve el modelo (tolera fences y texto alrededor). */
function parseFindings(raw: string): Finding[] {
  const fenced = raw.replace(/```(?:json)?/gi, '');
  const start = fenced.indexOf('[');
  const end = fenced.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Finding[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const severity = VALID_SEVERITIES.includes(o.severity as Severity) ? (o.severity as Severity) : 'medium';
    const line = typeof o.line === 'number' && Number.isFinite(o.line) ? Math.max(0, Math.floor(o.line)) : 0;
    const rule = typeof o.rule === 'string' && o.rule.trim() ? o.rule.trim().slice(0, 64) : 'review';
    out.push({
      rule: `llm-${rule}`,
      severity,
      file: '', // se completa por archivo
      line,
      message: typeof o.message === 'string' ? o.message.slice(0, 500) : 'Hallazgo reportado por revisión LLM.',
      fix: typeof o.fix === 'string' ? o.fix.slice(0, 500) : 'Revisa el fragmento señalado.',
    });
  }
  return out;
}

async function callOpenAI(cfg: LlmConfig, userContent: string, signal: AbortSignal): Promise<string> {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`OpenAI-compatible respondió ${res.status}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? '';
}

async function callAnthropic(cfg: LlmConfig, userContent: string, signal: AbortSignal): Promise<string> {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/v1/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Anthropic respondió ${res.status}`);
  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  return (data.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

async function callLlm(cfg: LlmConfig, userContent: string): Promise<string> {
  const call = cfg.provider === 'anthropic' ? callAnthropic : callOpenAI;
  return call(cfg, userContent, AbortSignal.timeout(CALL_TIMEOUT_MS));
}

/**
 * Revisa los archivos de texto del bundle contra el LLM configurado.
 * Caché por hash(contenido + modelo): un archivo sin cambios entre versiones no consume tokens.
 * Si el LLM no está disponible aplica la política onUnavailable del admin.
 */
export async function reviewBundleWithLlm(
  db: DbClient,
  entries: BundleEntry[],
  cfg: LlmConfig,
): Promise<LlmReviewResult> {
  const meta: LlmReviewMeta = {
    provider: cfg.provider,
    model: cfg.model,
    reviewed: 0,
    cached: 0,
    skipped: 0,
    available: true,
  };
  const findings: Finding[] = [];

  const files = entries.filter((e) => !e.isDir);
  const candidates = files
    .filter((e) => TEXT_EXTENSIONS.has(e.path.split('.').pop()?.toLowerCase() ?? ''))
    .sort((a, b) => a.path.localeCompare(b.path));

  const withinBudget = candidates.filter((e) => e.data.length <= MAX_FILE_BYTES);
  meta.skipped = candidates.length - withinBudget.length;

  for (const entry of withinBudget.slice(0, MAX_FILES)) {
    const content = entry.data.toString('utf8');
    const cacheKey = sha256(`${cfg.provider}\0${cfg.model}\0${entry.data}`);

    const hit = await db.query<{ findings: Finding[] }>(
      'SELECT findings FROM llm_file_cache WHERE file_hash = $1',
      [cacheKey],
    );
    if (hit.rows.length > 0) {
      meta.cached++;
      for (const f of hit.rows[0].findings ?? []) findings.push({ ...f, file: entry.path });
      continue;
    }

    let raw: string;
    try {
      raw = await callLlm(cfg, `Archivo: ${entry.path}\n\`\`\`\n${content}\n\`\`\``);
    } catch {
      // LLM no disponible: aplica la política configurada
      meta.available = false;
      break;
    }

    const mapped = parseFindings(raw).map((f) => ({ ...f, file: entry.path }));
    meta.reviewed++;
    findings.push(...mapped);
    await db.query(
      'INSERT INTO llm_file_cache (file_hash, model, findings) VALUES ($1, $2, $3::jsonb) ON CONFLICT (file_hash) DO NOTHING',
      [cacheKey, cfg.model, JSON.stringify(mapped)],
    );
  }

  if (meta.available) {
    const notReviewed = withinBudget.length - Math.min(withinBudget.length, MAX_FILES);
    meta.skipped += notReviewed;
  }
  if (meta.skipped > 0) {
    findings.push({
      rule: 'llm-budget',
      severity: 'info',
      file: 'bundle',
      line: 0,
      message: `La revisión LLM omitió ${meta.skipped} archivo(s): superan ${Math.round(MAX_FILE_BYTES / 1024)} KB o el máximo de ${MAX_FILES} archivos por publicación.`,
      fix: 'Divide archivos grandes o reduce el bundle si quieres revisión LLM completa.',
    });
  }
  if (!meta.available) {
    const block = cfg.onUnavailable === 'block';
    findings.push({
      rule: 'llm-unavailable',
      severity: block ? 'critical' : 'info',
      file: 'bundle',
      line: 0,
      message: block
        ? 'El LLM de revisión no está disponible y la política exige bloquear la publicación sin revisión semántica.'
        : 'El LLM de revisión no está disponible; la publicación continúa solo con las reglas estáticas.',
      fix: block
        ? 'Verifica la conexión al proveedor LLM en el panel admin, o cambia la política "cuando no responde" a continuar con advertencia.'
        : 'No action required. Configura la política del admin si prefieres bloquear sin revisión LLM.',
    });
  }

  return { findings, meta };
}
