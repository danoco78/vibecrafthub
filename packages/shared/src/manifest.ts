import { z } from 'zod';

/**
 * Manifest obligatorio: app.json en la raíz del bundle.
 */
export const APP_MANIFEST_FILENAME = 'app.json';

export const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export const appManifestSchema = z.object({
  name: z.string().min(1).max(64),
  version: z.string().regex(SEMVER_RE, 'version debe ser semver (ej: 1.0.0)'),
  /** Punto de entrada, debe existir y ser .html en la raíz o ruta relativa del bundle */
  entrypoint: z
    .string()
    .min(1)
    .max(256)
    .refine((p) => !p.includes('..') && !p.startsWith('/'), 'entrypoint debe ser ruta relativa'),
  description: z.string().max(500).optional(),
  /** Base de datos opcional incluida en el bundle */
  database: z
    .object({
      /** Ruta relativa del archivo sqlite dentro del bundle */
      file: z
        .string()
        .min(1)
        .max(256)
        .refine((p) => !p.includes('..') && !p.startsWith('/'), 'database.file debe ser ruta relativa'),
      /** true si este archivo inicializa la DB compartida la primera vez */
      seed: z.boolean().optional(),
    })
    .optional(),
  /**
   * Dominios externos que la app necesita contactar.
   * El scanner los compara con la allowlist del admin (v0.3): aprobados pasan
   * sin hallazgo (y habilitan CSP por app); los demás generan hallazgo alto.
   */
  externalDomains: z.array(z.string().min(1).max(253)).max(16).optional(),
});

export type AppManifest = z.infer<typeof appManifestSchema>;

/** Extensiones permitidas dentro del bundle (no negociable #1) */
export const ALLOWED_EXTENSIONS = ['html', 'js', 'css', 'json', 'xml', 'sqlite'] as const;
export type AllowedExtension = (typeof ALLOWED_EXTENSIONS)[number];

export function extensionOf(path: string): string {
  const base = path.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}
