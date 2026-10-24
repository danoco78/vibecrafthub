import { z } from 'zod';

/**
 * Configuración del conector LDAP/Active Directory (docs/design-v0.3.md §4.3).
 * TLS obligatorio: solo ldaps (636) o starttls (389 → StartTLS).
 */
export const LDAP_MODES = ['ldaps', 'starttls'] as const;
export const LDAP_BIND_MODES = ['service', 'direct'] as const;
export const PLATFORM_ROLES = ['admin', 'developer', 'user'] as const;

export const ldapConfigSchema = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(LDAP_MODES),
    url: z.string().trim().max(300),
    baseDn: z.string().trim().max(300),
    bindMode: z.enum(LDAP_BIND_MODES),
    bindDn: z.string().trim().max(300).optional(),
    bindPassword: z.string().max(400).optional(),
    userDnPattern: z.string().trim().max(300).optional(),
    userFilter: z.string().trim().max(500).optional(),
    mailAttr: z.string().trim().min(1).max(64),
    groupAttr: z.string().trim().min(1).max(64),
    tlsSkipVerify: z.boolean().optional(),
    roleMappings: z
      .array(
        z.object({
          group: z.string().trim().min(1).max(300),
          role: z.enum(PLATFORM_ROLES),
        }),
      )
      .max(50),
    defaultRole: z.enum(PLATFORM_ROLES),
  })
  .superRefine((c, ctx) => {
    // Cada modo exige sus propios campos; los del otro modo son opcionales.
    if (c.bindMode === 'service') {
      if (!c.bindDn) {
        ctx.addIssue({ code: 'custom', path: ['bindDn'], message: 'Requerido en modo cuenta de servicio.' });
      }
      if (!c.userFilter) {
        ctx.addIssue({ code: 'custom', path: ['userFilter'], message: 'Requerido en modo cuenta de servicio.' });
      }
    }
    if (c.bindMode === 'direct') {
      if (!c.userDnPattern) {
        ctx.addIssue({ code: 'custom', path: ['userDnPattern'], message: 'Requerido en modo DN directo.' });
      } else if (!c.userDnPattern.includes('{login}')) {
        ctx.addIssue({
          code: 'custom',
          path: ['userDnPattern'],
          message: 'Debe contener {login} (ej.: uid={login},ou=people,dc=empresa,dc=com).',
        });
      }
    }
    if (c.enabled) {
      if (!c.url) ctx.addIssue({ code: 'custom', path: ['url'], message: 'Requerido con el directorio activado.' });
      if (!c.baseDn) ctx.addIssue({ code: 'custom', path: ['baseDn'], message: 'Requerido con el directorio activado.' });
    }
  });

/** Configuración resuelta tal como se guarda/usa internamente (password siempre string). */
export interface LdapConfig {
  enabled: boolean;
  mode: (typeof LDAP_MODES)[number];
  url: string;
  baseDn: string;
  bindMode: (typeof LDAP_BIND_MODES)[number];
  bindDn: string;
  bindPassword: string;
  userDnPattern: string;
  userFilter: string;
  mailAttr: string;
  groupAttr: string;
  roleMappings: { group: string; role: (typeof PLATFORM_ROLES)[number] }[];
  defaultRole: (typeof PLATFORM_ROLES)[number];
  /** Solo laboratorios: cifrado sí, validación de certificado no. */
  tlsSkipVerify: boolean;
}

/** Máscara para exponer secretos en la UI sin revelarlos (patrón LLM). */
export function maskSecret(value: string): string {
  return value.length > 4 ? `••••${value.slice(-4)}` : '';
}
