import { ldapConfigSchema, type LdapConfig } from '@vch/shared';
import type { DbClient } from '../db.js';

/**
 * Carga/guardado de la configuración del directorio (fila única, patrón llm_config).
 * La contraseña del bind vive en la BD y se enmascara solo al exponerla en la UI.
 */

export const NULL_LDAP_CONFIG: LdapConfig = {
  enabled: false,
  mode: 'ldaps',
  url: '',
  baseDn: '',
  bindMode: 'service',
  bindDn: '',
  bindPassword: '',
  userDnPattern: '',
  userFilter: '',
  mailAttr: 'mail',
  groupAttr: 'memberOf',
  tlsSkipVerify: false,
  roleMappings: [],
  defaultRole: 'user',
};

interface LdapConfigRow {
  enabled: boolean;
  mode: LdapConfig['mode'];
  url: string;
  base_dn: string;
  bind_mode: LdapConfig['bindMode'];
  bind_dn: string;
  bind_password: string;
  user_dn_pattern: string;
  user_filter: string;
  mail_attr: string;
  group_attr: string;
  tls_skip_verify: boolean;
  role_mappings: { group?: unknown; role?: unknown }[] | null;
  default_role: LdapConfig['defaultRole'];
}

export async function loadLdapConfig(db: DbClient): Promise<LdapConfig> {
  try {
    const res = await db.query<LdapConfigRow>(
      `SELECT enabled, mode, url, base_dn, bind_mode, bind_dn, bind_password,
              user_dn_pattern, user_filter, mail_attr, group_attr, tls_skip_verify, role_mappings, default_role
       FROM ldap_config WHERE id = 1`,
    );
    const row = res.rows[0];
    if (!row) return NULL_LDAP_CONFIG;

    // role_mappings llega como JSONB: validar entrada por entrada y descartar basura.
    const roleMappings = (row.role_mappings ?? [])
      .map((m) => ({
        group: typeof m.group === 'string' ? m.group : '',
        role: m.role as LdapConfig['roleMappings'][number]['role'],
      }))
      .filter(
        (m) =>
          m.group.length > 0 &&
          ['admin', 'developer', 'user'].includes(m.role),
      );

    return {
      enabled: row.enabled,
      mode: row.mode,
      url: row.url,
      baseDn: row.base_dn,
      bindMode: row.bind_mode,
      bindDn: row.bind_dn,
      bindPassword: row.bind_password,
      userDnPattern: row.user_dn_pattern,
      userFilter: row.user_filter,
      mailAttr: row.mail_attr || 'mail',
      groupAttr: row.group_attr || 'memberOf',
      tlsSkipVerify: row.tls_skip_verify,
      roleMappings,
      defaultRole: row.default_role,
    };
  } catch {
    return NULL_LDAP_CONFIG;
  }
}

export async function saveLdapConfig(db: DbClient, cfg: LdapConfig): Promise<void> {
  await db.query(
    `UPDATE ldap_config
     SET enabled = $1, mode = $2, url = $3, base_dn = $4, bind_mode = $5, bind_dn = $6,
         bind_password = $7, user_dn_pattern = $8, user_filter = $9, mail_attr = $10,
         group_attr = $11, tls_skip_verify = $12, role_mappings = $13::jsonb, default_role = $14, updated_at = now()
     WHERE id = 1`,
    [
      cfg.enabled,
      cfg.mode,
      cfg.url,
      cfg.baseDn,
      cfg.bindMode,
      cfg.bindDn,
      cfg.bindPassword,
      cfg.userDnPattern,
      cfg.userFilter,
      cfg.mailAttr,
      cfg.groupAttr,
      cfg.tlsSkipVerify,
      JSON.stringify(cfg.roleMappings),
      cfg.defaultRole,
    ],
  );
}
