import { Client } from 'ldapts';
import { type LdapConfig, type PLATFORM_ROLES } from '@vch/shared';

/**
 * Cliente LDAP/AD (docs/design-v0.3.md §4): TLS obligatorio (ldaps o starttls),
 * bind de servicio o directo, escape anti LDAP-injection y roles por grupos.
 * Errores tipados: credenciales inválidas (401) vs directorio no disponible (503).
 */

export class LdapInvalidCredentialsError extends Error {
  constructor(message = 'Credenciales rechazadas por el directorio.') {
    super(message);
    this.name = 'LdapInvalidCredentialsError';
  }
}

export class LdapUnavailableError extends Error {
  constructor(message = 'El directorio de la empresa no está disponible.') {
    super(message);
    this.name = 'LdapUnavailableError';
  }
}

/** Escape RFC 4515 para valores dentro de filtros de búsqueda. */
export function escapeLdapFilter(value: string): string {
  return value.replace(/[\\()*\0]/g, (ch) => `\\${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** Escape mínimo para el {login} interpolado en un DN ( RFC 4514 ). */
export function escapeLdapDn(value: string): string {
  return value.replace(/([,+"\\<>;]|^ | $)/g, (ch) => `\\${ch}`);
}

type Role = (typeof PLATFORM_ROLES)[number];

export interface LdapLoginResult {
  dn: string;
  mail: string | null;
  groups: string[];
  role: Role;
}

function clientUrl(cfg: LdapConfig): string {
  const host = cfg.url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
  const scheme = cfg.mode === 'ldaps' ? 'ldaps' : 'ldap';
  return `${scheme}://${host}`;
}

function tlsOptions(cfg: LdapConfig) {
  return { rejectUnauthorized: !cfg.tlsSkipVerify };
}

function mapError(err: unknown): Error {
  const e = err as { name?: string; code?: number; message?: string };
  const name = e?.name ?? '';
  const msg = `${name}: ${e?.message ?? ''}`;
  // ldapts v9 lanza errores tipados (InvalidCredentialsError, code 49 = 0x31).
  if (name === 'InvalidCredentialsError' || e?.code === 49 || /invalid credential|code: 49|0x31/i.test(msg)) {
    return new LdapInvalidCredentialsError();
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|timeout|refused|unavailable|certificate|handshake/i.test(msg)) {
    return new LdapUnavailableError(msg);
  }
  return new LdapUnavailableError(msg);
}

function cnOf(groupDn: string): string {
  const m = /(?:^|,)\s*cn=([^,]+)/i.exec(groupDn);
  return m ? m[1].toLowerCase() : '';
}

function mapRole(cfg: LdapConfig, groups: string[]): Role {
  for (const mapping of cfg.roleMappings) {
    const target = mapping.group.toLowerCase();
    const targetCn = cnOf(mapping.group);
    const hit =
      groups.some((g) => g.toLowerCase() === target) ||
      (targetCn !== '' && groups.some((g) => cnOf(g) === targetCn));
    if (hit) return mapping.role;
  }
  return cfg.defaultRole;
}

function asArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

interface UserEntry {
  dn: string;
  mail: string | null;
  groups: string[];
}

async function withClient<T>(cfg: LdapConfig, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    url: clientUrl(cfg),
    connectTimeout: 5_000,
    timeout: 8_000,
    tlsOptions: tlsOptions(cfg),
  });
  try {
    if (cfg.mode === 'starttls') {
      await client.startTLS(tlsOptions(cfg));
    }
    return await fn(client);
  } catch (err) {
    // Los errores ya tipados por los flujos internos pasan sin re-mapear.
    if (err instanceof LdapInvalidCredentialsError || err instanceof LdapUnavailableError) throw err;
    throw mapError(err);
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

/** Bind de servicio + búsqueda del usuario + bind con sus credenciales. */
async function serviceBindFlow(
  cfg: LdapConfig,
  login: string,
  password: string,
  client: Client,
): Promise<UserEntry> {
  await client.bind(cfg.bindDn, cfg.bindPassword).catch((err) => {
    throw mapError(err);
  });

  const filter = cfg.userFilter.replaceAll('{login}', escapeLdapFilter(login));
  const { searchEntries } = await client.search(cfg.baseDn, {
    scope: 'sub',
    filter,
    attributes: [cfg.mailAttr, cfg.groupAttr],
  });
  const entry = searchEntries[0];
  if (!entry) throw new LdapInvalidCredentialsError();

  // Re-bind con las credenciales del empleado: la prueba real de la contraseña.
  try {
    await client.bind(entry.dn, password);
  } catch (err) {
    throw mapError(err);
  }
  return {
    dn: entry.dn,
    mail: asArray((entry as Record<string, unknown>)[cfg.mailAttr])[0] ?? null,
    groups: asArray((entry as Record<string, unknown>)[cfg.groupAttr]),
  };
}

/** Bind directo con DN patrón + lectura de la propia entrada. */
async function directBindFlow(
  cfg: LdapConfig,
  login: string,
  password: string,
  client: Client,
): Promise<UserEntry> {
  const dn = cfg.userDnPattern.replaceAll('{login}', escapeLdapDn(login));
  try {
    await client.bind(dn, password);
  } catch (err) {
    throw mapError(err);
  }
  let entry: Record<string, unknown> & { dn: string } | undefined;
  try {
    const { searchEntries } = await client.search(dn, {
      scope: 'base',
      attributes: [cfg.mailAttr, cfg.groupAttr],
    });
    entry = searchEntries[0] as typeof entry;
  } catch {
    entry = undefined; // el servidor puede negar la lectura de la propia entrada
  }
  return {
    dn,
    mail: entry ? (asArray(entry[cfg.mailAttr])[0] ?? null) : null,
    groups: entry ? asArray(entry[cfg.groupAttr]) : [],
  };
}

/** Autentica un empleado contra el directorio y devuelve su identidad + rol mapeado. */
export async function authenticateWithLdap(
  cfg: LdapConfig,
  login: string,
  password: string,
): Promise<LdapLoginResult> {
  const entry =
    cfg.bindMode === 'service'
      ? await withClient(cfg, (client) => serviceBindFlow(cfg, login, password, client))
      : await withClient(cfg, (client) => directBindFlow(cfg, login, password, client));

  return {
    dn: entry.dn,
    mail: entry.mail,
    groups: entry.groups,
    role: mapRole(cfg, entry.groups),
  };
}

export interface LdapTestStep {
  step: string;
  ok: boolean;
  detail: string;
}

export interface LdapTestResult {
  steps: LdapTestStep[];
  result?: LdapLoginResult;
}

/**
 * Test de conexión para el panel (decisión #6): bind, búsqueda y —si se pasa
 * un login real— autenticación completa con roles. Registra cada paso.
 */
export async function testLdapConnection(
  cfg: LdapConfig,
  opts: { login?: string; password?: string } = {},
): Promise<LdapTestResult> {
  const steps: LdapTestStep[] = [];
  const record = (step: string, ok: boolean, detail: string) => steps.push({ step, ok, detail });
  let result: LdapLoginResult | undefined;

  const mode = cfg.mode === 'ldaps' ? 'LDAPS' : 'LDAP+StartTLS';
  try {
    await withClient(cfg, async (client) => {
      if (cfg.bindMode === 'service') {
        try {
          await client.bind(cfg.bindDn, cfg.bindPassword);
          record('bind de servicio', true, `OK como ${cfg.bindDn}`);
        } catch (err) {
          const mapped = mapError(err);
          record('bind de servicio', false, mapped.message);
          throw mapped;
        }
        if (opts.login && opts.password) {
          try {
            const entry = await serviceBindFlow(cfg, opts.login, opts.password, client);
            result = { ...entry, role: mapRole(cfg, entry.groups) };
            record('autenticación del usuario', true, `OK: ${entry.dn} · rol: ${result?.role}`);
          } catch (err) {
            const mapped = mapError(err);
            record('autenticación del usuario', false, mapped.message);
            throw mapped;
          }
        } else {
          const filter = cfg.userFilter.replaceAll('{login}', escapeLdapFilter('prueba-conexion'));
          try {
            await client.search(cfg.baseDn, { scope: 'sub', filter, attributes: [cfg.mailAttr] });
            record('búsqueda', true, `filtro ${filter} ejecutado contra ${cfg.baseDn}`);
          } catch (err) {
            const mapped = mapError(err);
            record('búsqueda', false, mapped.message);
            throw mapped;
          }
        }
      } else {
        if (!opts.login || !opts.password) {
          record('bind directo', false, 'El modo directo requiere login y password para probar.');
          throw new LdapUnavailableError('El modo directo requiere login y password para probar.');
        }
        try {
          const entry = await directBindFlow(cfg, opts.login, opts.password, client);
          result = { ...entry, role: mapRole(cfg, entry.groups) };
          record('bind directo', true, `OK: ${entry.dn} · rol: ${result?.role}`);
        } catch (err) {
          const mapped = mapError(err);
          record('bind directo', false, mapped.message);
          throw mapped;
        }
      }
    });
    record('cifrado', true, mode);
  } catch (err) {
    record('cifrado', false, err instanceof Error ? err.message : 'error desconocido');
  }

  return { steps, result };
}
