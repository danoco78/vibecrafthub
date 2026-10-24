import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '../db.js';
import { requireRole } from '../plugins/auth.js';
import { canAccessApp, loadAppBySlug, slugFromHost } from '../apps/access.js';
import { buildAppCsp, resolveApprovedDomains } from '../domains/csp.js';
import { hashPassword, validatePasswordStrength, verifyPassword } from './passwords.js';
import { authenticateWithLdap, LdapInvalidCredentialsError } from './ldap.js';
import { loadLdapConfig } from '../ldap/settings.js';
import { count } from '../metrics/collector.js';
import { count } from '../metrics/collector.js';
import {
  COOKIE_OPTS_KEY,
  SESSION_COOKIE,
  clearSessionCookie,
  createSession,
  destroySession,
  setSessionCookie,
} from './sessions.js';

const loginSchema = z.object({
  // Identificador de acceso: email local o uid/UPN corporativo (LDAP resuelve
  // el email real desde el atributo configurado). El registro sí exige email.
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(128),
});

const registerSchema = loginSchema;

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(1).max(128),
});

/**
 * Rate limiting de login en memoria (MVP monoproceso): máximo 5 fallos
 * por combinación email+IP en 15 minutos. Se limpia al acertar y al
 * expirar la ventana. Si algún día corre más de una réplica del API,
 * mover a un store compartido (p. ej. Redis).
 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const loginFailures = new Map<string, { count: number; firstAt: number }>();

function loginBlocked(key: string): boolean {
  const entry = loginFailures.get(key);
  if (!entry) return false;
  if (Date.now() - entry.firstAt > LOGIN_WINDOW_MS) {
    loginFailures.delete(key);
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(key: string): void {
  const now = Date.now();
  const entry = loginFailures.get(key);
  if (!entry || now - entry.firstAt > LOGIN_WINDOW_MS) {
    loginFailures.set(key, { count: 1, firstAt: now });
    return;
  }
  entry.count++;
}

function clearLoginFailures(key: string): void {
  loginFailures.delete(key);
}

/** Página que Caddy copia al usuario cuando forward_auth rechaza (401). */
function sessionRequiredHtml(): string {
  const portalUrl = process.env.PORTAL_PUBLIC_URL ?? '/';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Sesión requerida</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1420;color:#e6eaf2;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}div{text-align:center;padding:20px}h1{font-size:20px}a{color:#4f8cff}p{color:#93a0b8}</style></head>
<body><div><h1>Sesión requerida</h1><p>Inicia sesión en el portal para usar esta aplicación.</p><p><a href="${portalUrl}">Ir al portal</a></p></div></body></html>`;
}

/** Página 403 para apps privadas: el usuario tiene sesión pero no está en la allowlist. */
function forbiddenHtml(appName: string): string {
  const portalUrl = process.env.PORTAL_PUBLIC_URL ?? '/';
  const safeName = appName.replace(/[<>&]/g, '');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Acceso restringido</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1420;color:#e6eaf2;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}div{text-align:center;padding:20px}h1{font-size:20px}a{color:#4f8cff}p{color:#93a0b8}</style></head>
<body><div><h1>Acceso restringido</h1><p>La aplicación <strong>${safeName}</strong> es privada y tu cuenta no está en su lista de acceso.</p><p>Pide al dueño de la app que te añada, o <a href="${portalUrl}">vuelve al portal</a>.</p></div></body></html>`;
}

export function authRoutes(
  app: FastifyInstance,
  db: DbClient,
  sessionTtlDays: number,
  appsHostSuffix = '.apps.',
  portalPublicUrl?: string,
): void {
  /**
   * Primer usuario registrado = admin. Resto se crean desde /api/admin/users.
   */
  app.post('/api/auth/register', async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Email o contraseña inválidos.' });
    }
    const email = parsed.data.email.toLowerCase().trim();
    const strengthError = validatePasswordStrength(parsed.data.password);
    if (strengthError) return reply.code(400).send({ error: strengthError });

    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return reply.code(409).send({ error: 'Ya existe un usuario con ese email.' });
    }

    const count = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM users');
    const isFirstUser = count.rows[0].n === '0';
    const role = isFirstUser ? 'admin' : 'user';

    const passwordHash = await hashPassword(parsed.data.password);
    const inserted = await db.query<{ id: number }>(
      'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role',
      [email, passwordHash, role],
    );
    const user = inserted.rows[0];

    const session = await createSession(db, user.id, sessionTtlDays);
    setSessionCookie(reply, session.token, session.expiresAt, {
      domain: app.cookieOpts?.domain,
      secure: app.cookieOpts?.secure ?? false,
    });
    return { user };
  });

  app.post('/api/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Email o contraseña inválidos.' });
    }
    const email = parsed.data.email.toLowerCase().trim();
    const rateKey = `${email}|${request.ip}`;
    if (loginBlocked(rateKey)) {
      return reply.code(429).send({
        error: 'Demasiados intentos fallidos. Espera 15 minutos antes de volver a intentar.',
      });
    }
    const res = await db.query<{ id: number; email: string; role: 'admin' | 'developer' | 'user'; password_hash: string; active: boolean; auth_source: 'local' | 'ldap' }>(
      'SELECT id, email, role, password_hash, active, auth_source FROM users WHERE email = $1',
      [email],
    );
    const user = res.rows[0];
    if (user && !user.active) {
      return reply.code(403).send({ error: 'Esta cuenta está desactivada. Contacta al administrador.' });
    }

    const ldapCfg = await loadLdapConfig(db);
    // LDAP aplica a: cuentas nacidas en el directorio, o emails desconocidos
    // (JIT). Las cuentas locales siguen autenticando con Argon2id.
    const tryLdap = ldapCfg.enabled && (!user || user.auth_source === 'ldap');

    if (tryLdap) {
      let result;
      try {
        result = await authenticateWithLdap(ldapCfg, email, parsed.data.password);
      } catch (err) {
        if (err instanceof LdapInvalidCredentialsError) {
          count('login.fail', 'ldap');
          recordLoginFailure(rateKey);
          return reply.code(401).send({ error: 'Credenciales incorrectas.' });
        }
        request.log.error(err);
        return reply.code(503).send({ error: 'El directorio de la empresa no está disponible. Inténtalo más tarde.' });
      }
      const mail = (result.mail ?? email).toLowerCase().trim();
      let account: { id: number; email: string; role: 'admin' | 'developer' | 'user'; active: boolean };
      if (!user) {
        // JIT: primera entrada corporativa. Sin hash utilizable: la contraseña vive en el directorio.
        try {
          const inserted = await db.query<{ id: number; email: string; role: 'admin' | 'developer' | 'user' }>(
            "INSERT INTO users (email, password_hash, role, auth_source, ldap_dn) VALUES ($1, '', $2, 'ldap', $3) RETURNING id, email, role",
            [mail, result.role, result.dn],
          );
          account = { ...inserted.rows[0], active: true };
        } catch (err) {
          if (err instanceof Error && /unique|duplicate/i.test(err.message)) {
            return reply.code(409).send({ error: 'Ya existe una cuenta local con ese email. Contacta al administrador.' });
          }
          throw err;
        }
      } else {
        // El directorio manda: el rol se recalcula con el mapeo vigente.
        await db.query('UPDATE users SET role = $1, ldap_dn = $2 WHERE id = $3', [
          result.role,
          result.dn,
          user.id,
        ]);
        account = { id: user.id, email: user.email, role: result.role, active: true };
      }
      clearLoginFailures(rateKey);
      count('login.ok', 'ldap');
      const session = await createSession(db, account.id, sessionTtlDays);
      setSessionCookie(reply, session.token, session.expiresAt, {
        domain: app.cookieOpts?.domain,
        secure: app.cookieOpts?.secure ?? false,
      });
      return { user: { id: account.id, email: account.email, role: account.role } };
    }

    if (!user) {
      count('login.fail', 'local');
      recordLoginFailure(rateKey);
      return reply.code(401).send({ error: 'Credenciales incorrectas.' });
    }
    const ok = await verifyPassword(user.password_hash, parsed.data.password);
    if (!ok) {
      count('login.fail', 'local');
      recordLoginFailure(rateKey);
      return reply.code(401).send({ error: 'Credenciales incorrectas.' });
    }
    clearLoginFailures(rateKey);
    count('login.ok', 'local');
    const session = await createSession(db, user.id, sessionTtlDays);
    setSessionCookie(reply, session.token, session.expiresAt, {
      domain: app.cookieOpts?.domain,
      secure: app.cookieOpts?.secure ?? false,
    });
    return { user: { id: user.id, email: user.email, role: user.role } };
  });

  /** Cambio de contraseña del usuario autenticado. */
  app.post('/api/auth/change-password', { preHandler: requireRole(app, 'admin', 'developer', 'user') }, async (request, reply) => {
    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Datos inválidos.' });
    }
    const strengthError = validatePasswordStrength(parsed.data.newPassword);
    if (strengthError) return reply.code(400).send({ error: strengthError });

    const res = await db.query<{ password_hash: string; auth_source: 'local' | 'ldap' }>(
      'SELECT password_hash, auth_source FROM users WHERE id = $1',
      [request.user!.id],
    );
    if (res.rows[0]?.auth_source === 'ldap') {
      return reply.code(403).send({ error: 'Tu contraseña la gestiona el directorio de la empresa; cámbiala ahí.' });
    }
    const ok = res.rows[0] ? await verifyPassword(res.rows[0].password_hash, parsed.data.currentPassword) : false;
    if (!ok) {
      return reply.code(400).send({ error: 'La contraseña actual no es correcta.' });
    }
    const passwordHash = await hashPassword(parsed.data.newPassword);
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, request.user!.id]);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await destroySession(db, token);
    clearSessionCookie(reply, {
      domain: app.cookieOpts?.domain,
      secure: app.cookieOpts?.secure ?? false,
    });
    return { ok: true };
  });

  app.get('/api/auth/me', async (request) => {
    return { user: request.user ?? null };
  });

  /** Endpoint para Caddy forward_auth: 204 si la sesión es válida, 401 si no.
   *  El cuerpo del 401 se copia al cliente: página amigable con enlace al portal.
   *  v0.2: si el Host es de una app privada, además exige estar en la allowlist (403).
   *  v0.3: devuelve la CSP por app (dominios aprobados) para que Caddy la
   *  copie al request original con copy_headers — sin peticiones extra. */
  app.get('/api/auth/check', async (request, reply) => {
    if (!request.user) {
      reply.code(401).header('content-type', 'text/html; charset=utf-8');
      return sessionRequiredHtml();
    }
    const slug = slugFromHost(request.hostname, appsHostSuffix);
    if (slug) {
      const appRow = await loadAppBySlug(db, slug);
      if (appRow && !(await canAccessApp(db, appRow, request.user))) {
        reply.code(403).header('content-type', 'text/html; charset=utf-8');
        return forbiddenHtml(appRow.name);
      }
      if (appRow) {
        // v1.0: cada asset servido cuenta como uso de la app.
        count('appaccess', slug);
        const approved = await resolveApprovedDomains(db, slug);
        const frameAncestors = portalPublicUrl ? new URL(portalPublicUrl).hostname : undefined;
        reply.header('content-security-policy', buildAppCsp(approved, frameAncestors));
      }
    }
    return reply.code(204).send();
  });
}
