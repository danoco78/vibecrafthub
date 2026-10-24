export interface Config {
  port: number;
  host: string;
  /** Cadena de conexión Postgres (modo producción, compose). Si no existe, usa PGlite embebida (dev). */
  databaseUrl?: string;
  /** Directorio de datos de PGlite en modo dev */
  pgliteDir: string;
  /** Volumen donde se almacenan los bundles publicados */
  bundlesDir: string;
  /** Directorio de las BD SQLite de las apps (data gateway). Volumen propio, separado de bundles. */
  dataDir: string;
  /** Sufijo de host de las apps (ej: ".apps.empresa.com") para resolver el slug desde el Host. */
  appsHostSuffix: string;
  /** Domain de la cookie de sesión, ej: ".localhost" para cubrir subdominios. Vacío = host-only. */
  cookieDomain?: string;
  cookieSecure: boolean;
  sessionTtlDays: number;
  /**
   * Plantilla de URL pública de las apps publicadas. Debe contener "{slug}".
   * Dev: /bundles/{slug}/ (relativa: el iframe hereda la sesión vía proxy de vite).
   * Compose: https://{slug}.apps.localhost
   */
  appsUrlTemplate: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl: env.DATABASE_URL || undefined,
    pgliteDir: env.PGLITE_DIR ?? 'data/pglite',
    bundlesDir: env.BUNDLES_DIR ?? 'data/bundles',
    dataDir: env.DATA_DIR ?? 'data/appdb',
    appsHostSuffix: env.APPS_HOST_SUFFIX ?? '.apps.',
    cookieDomain: env.COOKIE_DOMAIN || undefined,
    cookieSecure: env.COOKIE_SECURE === '1',
    sessionTtlDays: Number(env.SESSION_TTL_DAYS ?? 7),
    appsUrlTemplate: env.APPS_URL_TEMPLATE ?? '/bundles/{slug}/',
  };
}
