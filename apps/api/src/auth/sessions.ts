import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DbClient } from '../db.js';

export const SESSION_COOKIE = 'vch_session';

export interface SessionUser {
  id: number;
  email: string;
  role: 'admin' | 'developer' | 'user';
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionUser;
  }
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  db: DbClient,
  userId: number,
  ttlDays: number,
): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  await db.query(
    'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, hashToken(token), expiresAt.toISOString()],
  );
  return { token, expiresAt };
}

export async function destroySession(db: DbClient, token: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

/** Resuelve el usuario desde la cookie de sesión y lo adjunta a request.user. */
export async function resolveUser(request: FastifyRequest, db: DbClient): Promise<SessionUser | undefined> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return undefined;
  const res = await db.query<{
    id: number;
    email: string;
    role: SessionUser['role'];
  }>(
    `SELECT u.id, u.email, u.role FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active = true`,
    [hashToken(token)],
  );
  return res.rows[0];
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
  opts: { domain?: string; secure: boolean },
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: opts.secure,
    path: '/',
    domain: opts.domain,
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, opts: { domain?: string; secure: boolean }): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/', domain: opts.domain, secure: opts.secure });
}

export const COOKIE_OPTS_KEY = 'cookieOpts';

export interface CookieOpts {
  domain?: string;
  secure: boolean;
}
