import { z } from 'zod';

/**
 * Dominios externos de la allowlist (docs/design-v0.3.md §5).
 * Exactos, sin esquema, puerto ni ruta: "api.empresa.com".
 */

const HOSTNAME_RE =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Normaliza un dominio: quita esquema/puerto/ruta y pasa a minúsculas. Null si queda inválido. */
export function normalizeDomain(input: string): string | null {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '') // esquema
    .replace(/[:/?#].*$/, ''); // puerto, ruta, query, hash
  return HOSTNAME_RE.test(cleaned) ? cleaned : null;
}

export const externalDomainSchema = z
  .string()
  .trim()
  .max(253)
  .refine((v) => normalizeDomain(v) !== null, {
    message: 'Dominio inválido. Formato esperado: api.empresa.com (sin esquema, puerto ni ruta).',
  });

/** Extrae el hostname de una URL arbitraria para contrastarlo con la allowlist. */
export function hostnameOf(url: string): string | null {
  const normalized = normalizeDomain(url);
  return normalized;
}

/**
 * Primer host con URL explícita dentro de una línea de código
 * (https://, wss://, protocol-relative //host/…). Null si no hay.
 * Lo usan las reglas del scanner para verificar contra la allowlist.
 */
export function firstUrlHost(text: string): string | null {
  const match = /(?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\/([^\s"'`<>()\\]+)/.exec(text);
  if (!match) return null;
  return normalizeDomain(match[1]);
}
