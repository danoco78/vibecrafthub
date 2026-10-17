import {
  ALLOWED_EXTENSIONS,
  APP_MANIFEST_FILENAME,
  appManifestSchema,
  extensionOf,
  type AppManifest,
  type Finding,
} from '@vch/shared';
import type { BundleEntry } from './types.js';

export interface Limits {
  maxFiles: number;
  maxBundleMb: number;
}

const SQLITE_HEADER = 'SQLite format 3\x00';

function finding(
  rule: string,
  severity: Finding['severity'],
  file: string,
  message: string,
  fix: string,
  line = 0,
): Finding {
  return { rule, severity, file, line, message, fix };
}

function nameIsSafe(path: string): boolean {
  if (path.includes('\0') || path.includes('\\')) return false;
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return false;
  return !path.split('/').includes('..');
}

/**
 * Etapa 1 del pipeline: estructura del bundle.
 * Valida manifiesto, extensiones permitidas, límites y firma binaria.
 * Los symlinks de zip quedan neutralizados por la lista de extensiones:
 * su contenido (ruta destino) no tiene extensión permitida.
 */
export function validateStructure(
  entries: BundleEntry[],
  limits: Limits,
): { findings: Finding[]; manifest: AppManifest | null } {
  const findings: Finding[] = [];
  const files = entries.filter((e) => !e.isDir);

  // --- límites globales ---
  if (files.length > limits.maxFiles) {
    findings.push(
      finding(
        'limit-files',
        'critical',
        'bundle',
        `El bundle contiene ${files.length} archivos; el máximo es ${limits.maxFiles}.`,
        'Reduce la cantidad de archivos. No empaquetes dependencias completas (node_modules, librerías con miles de archivos).',
      ),
    );
  }
  const totalBytes = files.reduce((acc, e) => acc + e.data.length, 0);
  const maxBytes = limits.maxBundleMb * 1024 * 1024;
  if (totalBytes > maxBytes) {
    findings.push(
      finding(
        'limit-size',
        'critical',
        'bundle',
        `El bundle descomprimido pesa ${(totalBytes / 1024 / 1024).toFixed(1)} MB; el máximo es ${limits.maxBundleMb} MB.`,
        'Reduce el tamaño: elimina archivos innecesarios, comprime imágenes o divide la app.',
      ),
    );
  }

  // --- nombres de entrada (zip-slip) ---
  for (const e of files) {
    if (!nameIsSafe(e.path)) {
      findings.push(
        finding(
          'zip-slip',
          'critical',
          e.path,
          'Nombre de archivo inválido o peligroso (ruta absoluta, traversal o separador inválido).',
          'Empaqueta el zip con rutas relativas normales, sin "../" ni rutas absolutas.',
        ),
      );
    }
  }

  // --- extensiones permitidas y firma binaria ---
  for (const e of files) {
    const ext = extensionOf(e.path);
    if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(ext)) {
      findings.push(
        finding(
          'structure-extension',
          'critical',
          e.path,
          `Extensión ".${ext || '(sin extensión)'}" no permitida. Solo se permiten: ${ALLOWED_EXTENSIONS.join(', ')}.`,
          'Elimina el archivo o conviértelo a un formato permitido. Las fuentes de librerías deben incluirse como .js.',
        ),
      );
      continue;
    }
    if (looksBinaryDisguised(e.data)) {
      findings.push(
        finding(
          'binary-disguised',
          'critical',
          e.path,
          'El contenido tiene firma de ejecutable (MZ/ELF) aunque su extensión sea permitida.',
          'No empaquetes binarios ejecutables. Incluye solo código fuente web.',
        ),
      );
    }
    if (ext === 'sqlite' && !isSqliteFile(e.data)) {
      findings.push(
        finding(
          'sqlite-header',
          'critical',
          e.path,
          'El archivo .sqlite no tiene el encabezado de un archivo SQLite válido.',
          'Exporta la base de datos con una herramienta SQLite estándar y vuelve a empaquetarla.',
        ),
      );
    }
  }

  // --- manifest ---
  let manifest: AppManifest | null = null;
  const manifestEntry = entries.find((e) => e.path === APP_MANIFEST_FILENAME);
  if (!manifestEntry || manifestEntry.isDir) {
    findings.push(
      finding(
        'manifest-missing',
        'critical',
        APP_MANIFEST_FILENAME,
        'Falta el manifiesto app.json en la raíz del bundle.',
        'Agrega un app.json con name, version y entrypoint. Ver la documentación de la plataforma.',
      ),
    );
  } else {
    try {
      const parsed = appManifestSchema.parse(JSON.parse(manifestEntry.data.toString('utf8')));
      manifest = parsed;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      findings.push(
        finding(
          'manifest-invalid',
          'critical',
          APP_MANIFEST_FILENAME,
          `El manifiesto app.json es inválido: ${detail}`,
          'Corrige el app.json: name (1-64 caracteres), version semver, entrypoint apuntando a un .html existente.',
        ),
      );
    }
  }

  if (manifest) {
    const entryPath = manifest.entrypoint.replace(/^\.\//, '');
    const entry = entries.find((e) => !e.isDir && e.path === entryPath);
    if (!entry) {
      findings.push(
        finding(
          'manifest-entrypoint-missing',
          'critical',
          entryPath,
          'El entrypoint declarado en app.json no existe en el bundle.',
          'Crea el archivo o corrige el campo entrypoint de app.json.',
        ),
      );
    } else if (extensionOf(entryPath) !== 'html') {
      findings.push(
        finding(
          'manifest-entrypoint-html',
          'critical',
          entryPath,
          'El entrypoint debe ser un archivo .html.',
          'Apunta entrypoint al index.html de la app.',
        ),
      );
    }
    if (manifest.database) {
      const dbPath = manifest.database.file.replace(/^\.\//, '');
      const dbEntry = entries.find((e) => !e.isDir && e.path === dbPath);
      if (!dbEntry) {
        findings.push(
          finding(
            'manifest-database-missing',
            'critical',
            dbPath,
            'El archivo de base de datos declarado en app.json no existe en el bundle.',
            'Incluye el archivo .sqlite o elimina la sección database del app.json.',
          ),
        );
      } else if (extensionOf(dbPath) !== 'sqlite') {
        findings.push(
          finding(
            'manifest-database-sqlite',
            'critical',
            dbPath,
            'El archivo de base de datos debe tener extensión .sqlite.',
            'Renombra el archivo a .sqlite y actualiza app.json.',
          ),
        );
      }
    }
  }

  return { findings, manifest };
}

function looksBinaryDisguised(data: Buffer): boolean {
  if (data.length < 4) return false;
  if (data[0] === 0x4d && data[1] === 0x5a) return true; // MZ (Windows PE)
  if (data[0] === 0x7f && data[1] === 0x45 && data[2] === 0x4c && data[3] === 0x46) return true; // ELF (Linux)
  return false;
}

function isSqliteFile(data: Buffer): boolean {
  return data.length >= 16 && data.subarray(0, 16).toString('latin1') === SQLITE_HEADER;
}
