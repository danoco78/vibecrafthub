import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yauzl from 'yauzl';
import { type BundleEntry, scanBundle, verdictFromFindings } from '@vch/scanner';
import { APP_MANIFEST_FILENAME, blocksPublish, countBySeverity, type Finding, type Policy } from '@vch/shared';
import type { DbClient } from '../db.js';
import { extractBundle, setActiveVersion } from './storage.js';
import { loadLlmConfig, reviewBundleWithLlm } from '../llm.js';
import { loadExternalAllowlist } from '../domains/allowlist.js';

interface AppRow {
  id: number;
  slug: string;
  owner_id: number;
}

export interface PublishOutcome {
  verdict: 'published' | 'rejected';
  attemptId: number;
  version?: string;
  findings: Finding[];
  summary: Record<string, number>;
  meta?: Record<string, unknown>;
}

function openZip(buffer: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => (err ? reject(err) : resolve(zip)));
  });
}

function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(err ?? new Error('sin stream'));
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  });
}

/** Lee todas las entradas del zip con tope de tamaño total descomprimido. */
async function readZipEntries(buffer: Buffer, maxTotalBytes: number): Promise<BundleEntry[]> {
  const zip = await openZip(buffer);
  try {
    const listing = await new Promise<yauzl.Entry[]>((resolve, reject) => {
      const list: yauzl.Entry[] = [];
      zip.on('entry', (e) => {
        list.push(e);
        zip.readEntry();
      });
      zip.on('end', () => resolve(list));
      zip.on('error', reject);
      zip.readEntry();
    });

    const entries: BundleEntry[] = [];
    let total = 0;
    for (const entry of listing) {
      const normalized = entry.fileName.replace(/^\.\//, '');
      if (entry.fileName.endsWith('/')) {
        entries.push({ path: normalized, data: Buffer.alloc(0), isDir: true });
        continue;
      }
      const data = await readEntry(zip, entry);
      total += data.length;
      if (total > maxTotalBytes) {
        throw new Error(
          `El zip descomprimido supera el máximo de ${Math.round(maxTotalBytes / 1024 / 1024)} MB`,
        );
      }
      entries.push({ path: normalized, data, isDir: false });
    }
    return entries;
  } finally {
    zip.close();
  }
}

/** PRAGMA integrity_check con node:sqlite. Si no está disponible, omite (devuelve null). */
async function sqliteIntegrityCheck(data: Buffer): Promise<string | null> {
  let tmpDir: string | null = null;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vch-dbcheck-'));
    const file = path.join(tmpDir, 'check.sqlite');
    await fs.writeFile(file, data);
    const db = new DatabaseSync(file);
    try {
      const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
      const result = row?.integrity_check ?? 'unknown';
      return result === 'ok' ? null : `integrity_check reportó: ${result}`;
    } finally {
      db.close();
    }
  } catch (err) {
    // Archivo corrupto que SQLite no pudo abrir, o node:sqlite no disponible.
    if (err instanceof Error && /file is not a database|malformed|corrupt/i.test(err.message)) {
      return 'El archivo no se puede abrir como SQLite (parece corrupto).';
    }
    return null;
  } finally {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function finding(rule: string, severity: Finding['severity'], message: string, fix: string): Finding {
  return { rule, severity, file: 'bundle', line: 0, message, fix };
}

/**
 * Pipeline completo de publicación: zip → estructura → reglas → política → volumen.
 * Siempre registra un intento en publish_attempts, exitoso o rechazado.
 */
export async function publishBundle(
  db: DbClient,
  app: AppRow,
  userId: number,
  buffer: Buffer,
  policy: Policy,
  bundlesDir: string,
): Promise<PublishOutcome> {
  const findings: Finding[] = [];
  const bundleHash = crypto.createHash('sha256').update(buffer).digest('hex');

  // --- Lectura del zip ---
  let entries: BundleEntry[];
  try {
    entries = await readZipEntries(buffer, (policy.maxBundleMb + 2) * 1024 * 1024);
  } catch (err) {
    findings.push(
      finding(
        'zip-invalid',
        'critical',
        `El archivo no es un zip válido: ${err instanceof Error ? err.message : 'error desconocido'}.`,
        'Empaqueta la app como .zip estándar (no .tar, no .rar) e inténtalo de nuevo.',
      ),
    );
    return persistAttempt(db, app.id, userId, null, 'rejected', findings, bundleHash);
  }

  // --- Scanner: estructura + reglas (con la allowlist de dominios del admin) ---
  const externalAllowlist = await loadExternalAllowlist(db);
  const scan = scanBundle(entries, policy, externalAllowlist);
  findings.push(...scan.findings);

  const manifest = scan.manifest;

  // --- Versión duplicada ---
  let version: string | null = manifest?.version ?? null;
  if (version) {
    const dup = await db.query('SELECT id FROM app_versions WHERE app_id = $1 AND version = $2', [
      app.id,
      version,
    ]);
    if (dup.rows.length > 0) {
      findings.push(
        finding(
          'manifest-version-exists',
          'critical',
          `La versión ${version} ya fue publicada para esta app.`,
          `Incrementa el campo version del ${APP_MANIFEST_FILENAME} (por ejemplo a ${nextPatch(version)}) y vuelve a publicar.`,
        ),
      );
    }
  }

  // --- Integridad de la base de datos declarada ---
  if (
    manifest?.database &&
    findings.every((f) => f.rule !== 'sqlite-header' && f.rule !== 'manifest-database-missing')
  ) {
    const dbEntry = entries.find(
      (e) => !e.isDir && e.path === manifest.database!.file.replace(/^\.\//, ''),
    );
    if (dbEntry) {
      const problem = await sqliteIntegrityCheck(dbEntry.data);
      if (problem) {
        findings.push(
          finding(
            'sqlite-integrity',
            'critical',
            `La base de datos ${manifest.database.file} falló la verificación de integridad: ${problem}`,
            'Regenera el archivo .sqlite con una herramienta SQLite estándar y verifica que abre sin errores.',
          ),
        );
      }
    }
  }

  // --- Etapa 3: revisión semántica con LLM (configurable por el admin) ---
  // Solo corre si las reglas estáticas aún no rechazan: ahorra tokens en bundles ya bloqueados.
  let llmMeta: Record<string, unknown> | undefined;
  const llmCfg = await loadLlmConfig(db);
  if (llmCfg.enabled && llmCfg.model && !findings.some((f) => blocksPublish(policy, f.severity))) {
    const review = await reviewBundleWithLlm(db, entries, llmCfg);
    findings.push(...review.findings);
    llmMeta = { llm: review.meta };
  }

  const verdict = verdictFromFindings(findings, policy);

  if (verdict === 'rejected' || !manifest) {
    return persistAttempt(db, app.id, userId, null, 'rejected', findings, bundleHash, llmMeta);
  }

  // --- Publicar: extracción inmutable + versión + symlink activo ---
  version = manifest.version;
  const destRoot = path.join(bundlesDir, app.slug, version);
  await fs.rm(destRoot, { recursive: true, force: true });
  await extractBundle(entries, destRoot);
  await setActiveVersion(bundlesDir, app.slug, version);

  const previous = await db.query<{ id: number }>(
    "SELECT id FROM app_versions WHERE app_id = $1 AND status = 'active'",
    [app.id],
  );
  const inserted = await db.query<{ id: number }>(
    "INSERT INTO app_versions (app_id, version, bundle_hash, status) VALUES ($1, $2, $3, 'active') RETURNING id",
    [app.id, version, bundleHash],
  );
  const versionId = inserted.rows[0].id;
  for (const prev of previous.rows) {
    await db.query("UPDATE app_versions SET status = 'published' WHERE id = $1", [prev.id]);
  }
  await db.query('UPDATE apps SET current_version_id = $1 WHERE id = $2', [versionId, app.id]);

  return persistAttempt(db, app.id, userId, versionId, 'published', findings, bundleHash, llmMeta, version);
}

export async function persistAttempt(
  db: DbClient,
  appId: number,
  userId: number,
  versionId: number | null,
  verdict: 'published' | 'rejected',
  findings: Finding[],
  bundleHash: string,
  meta?: Record<string, unknown>,
  version?: string,
): Promise<PublishOutcome> {
  const res = await db.query<{ id: number }>(
    `INSERT INTO publish_attempts (app_id, user_id, version_id, verdict, findings, bundle_hash, meta)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb) RETURNING id`,
    [appId, userId, versionId, verdict, JSON.stringify(findings), bundleHash, JSON.stringify(meta ?? {})],
  );
  return {
    verdict,
    attemptId: res.rows[0].id,
    version,
    findings,
    summary: countBySeverity(findings),
    meta,
  };
}

function nextPatch(version: string): string {
  const parts = version.split('-')[0].split('.');
  const patch = Number(parts[2] ?? 0) + 1;
  return `${parts[0]}.${parts[1]}.${patch}`;
}
