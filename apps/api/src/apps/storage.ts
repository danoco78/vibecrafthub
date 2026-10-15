import fs from 'node:fs/promises';
import path from 'node:path';
import type { BundleEntry } from '@vch/scanner';

/**
 * Extrae entradas ya validadas por el scanner al volumen de bundles.
 * Defensa extra: jamás escribe fuera de destRoot, incluso si el scanner cambiara.
 */
export async function extractBundle(entries: BundleEntry[], destRoot: string): Promise<void> {
  const resolvedRoot = path.resolve(destRoot);
  await fs.mkdir(resolvedRoot, { recursive: true });
  for (const e of entries) {
    if (e.isDir) continue;
    const dest = path.resolve(resolvedRoot, e.path);
    if (dest !== resolvedRoot && !dest.startsWith(resolvedRoot + path.sep)) {
      throw new Error(`Ruta fuera del bundle: ${e.path}`);
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, e.data);
  }
}

/**
 * Apunta el symlink "active" de la app a la nueva versión.
 * Symlink relativo + rename atómico: el gateway nunca sirve una versión a medias.
 */
export async function setActiveVersion(bundlesRoot: string, slug: string, version: string): Promise<void> {
  const appDir = path.join(bundlesRoot, slug);
  const activePath = path.join(appDir, 'active');
  const tmp = path.join(appDir, `.active-tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fs.symlink(version, tmp);
  await fs.rename(tmp, activePath);
}
