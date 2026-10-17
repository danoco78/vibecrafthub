import type { FastifyInstance, FastifyReply } from 'fastify';
import type { DbClient } from '../db.js';
import { resolveUser, type CookieOpts, type SessionUser } from '../auth/sessions.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: DbClient;
    cookieOpts: CookieOpts;
  }
}

/** Adjunta request.user si existe sesión válida. Nunca rechaza: los guards deciden. */
export function authPlugin(app: FastifyInstance): void {
  app.addHook('preHandler', async (request) => {
    request.user = await resolveUser(request, app.db);
  });
}

export function requireAuth(app: FastifyInstance): (req: import('fastify').FastifyRequest, reply: FastifyReply) => Promise<FastifyReply | undefined> {
  return async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Autenticación requerida.' });
    }
    return undefined;
  };
}

type Role = SessionUser['role'];

export function requireRole(app: FastifyInstance, ...roles: Role[]) {
  return async (request: import('fastify').FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    if (!request.user) {
      return reply.code(401).send({ error: 'Autenticación requerida.' });
    }
    if (!roles.includes(request.user.role)) {
      return reply.code(403).send({ error: 'No tienes permisos para esta operación.' });
    }
    return undefined;
  };
}
