export interface Config {
  port: number;
  host: string;
  /** Cadena de conexión Postgres (modo producción, compose). Si no existe, usa PGlite embebida (dev). */
  databaseUrl?: string;
  /** Directorio de datos de PGlite en modo dev */
  pgliteDir: string;
  /** Volumen donde se almacenan los bundles publicados */
  bundlesDir: string;
  /** Domain de la cookie de sesión, ej: ".localhost" para cubrir subdominios. Vacío = host-only. */
  cookieDomain?: string;
  cookieSecure: boolean;
  sessionTtlDays: number;
  /**
   * Plantilla de URL pública de las apps publicadas. Debe contener "{slug}".
   * Dev:      http://localhost:3000/bundles/{slug}/
   * Compose:  https://{slug}.apps.localhost
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
    cookieDomain: env.COOKIE_DOMAIN || undefined,
    cookieSecure: env.COOKIE_SECURE === '1',
    sessionTtlDays: Number(env.SESSION_TTL_DAYS ?? 7),
    appsUrlTemplate: env.APPS_URL_TEMPLATE ?? 'http://localhost:3000/bundles/{slug}/',
  };
}
