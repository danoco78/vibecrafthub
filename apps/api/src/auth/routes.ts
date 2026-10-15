import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '../db.js';
import { hashPassword, validatePasswordStrength, verifyPassword } from './passwords.js';
import {
  COOKIE_OPTS_KEY,
  SESSION_COOKIE,
  clearSessionCookie,
  createSession,
  destroySession,
  setSessionCookie,
} from './sessions.js';

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
});

const registerSchema = loginSchema;

export function authRoutes(app: FastifyInstance, db: DbClient, sessionTtlDays: number): void {
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
    const res = await db.query<{ id: number; email: string; role: 'admin' | 'developer' | 'user'; password_hash: string }>(
      'SELECT id, email, role, password_hash FROM users WHERE email = $1',
      [email],
    );
    const user = res.rows[0];
    const ok = user ? await verifyPassword(user.password_hash, parsed.data.password) : false;
    if (!user || !ok) {
      return reply.code(401).send({ error: 'Credenciales incorrectas.' });
    }
    const session = await createSession(db, user.id, sessionTtlDays);
    setSessionCookie(reply, session.token, session.expiresAt, {
      domain: app.cookieOpts?.domain,
      secure: app.cookieOpts?.secure ?? false,
    });
    return { user: { id: user.id, email: user.email, role: user.role } };
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

  /** Endpoint para Caddy forward_auth: 204 si la sesión es válida, 401 si no. */
  app.get('/api/auth/check', async (request, reply) => {
    if (!request.user) return reply.code(401).send();
    return reply.code(204).send();
  });
}
