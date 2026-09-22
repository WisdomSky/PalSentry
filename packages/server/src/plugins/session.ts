import type { SessionUser } from '@palsentry/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { DESKTOP_SESSION_USERNAME } from '../auth/session.js';
import { errorBody } from '../http/errors.js';
import { SESSION_COOKIE_NAME, parseSessionValue } from '../auth/session.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth guard on protected routes; always null on public ones. */
    session: SessionUser | null;
  }
}

/**
 * Read and validate the session cookie.
 *
 * Two independent checks: `@fastify/cookie` verifies the HMAC signature, then
 * {@link parseSessionValue} checks the payload is well-formed and unexpired.
 *
 * Desktop hosting has no login at all: there the Palworld connection *is* the session, so this
 * reports one exactly while a probed connection is in force. The auth guard, `/auth/me` and the
 * SPA's router all keep working unchanged, and "connected" and "signed in" stay the same idea.
 */
export function readSession(request: FastifyRequest, config: AppConfig): SessionUser | null {
  if (config.desktop.enabled) {
    return config.desktop.configured ? { username: DESKTOP_SESSION_USERNAME } : null;
  }

  const raw = request.cookies[SESSION_COOKIE_NAME];
  if (raw === undefined) return null;

  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || unsigned.value === null) return null;

  const session = parseSessionValue(unsigned.value);
  if (session === null) return null;

  // A changed username invalidates existing sessions, so renaming the admin locks everyone out
  // rather than leaving a session valid for a user that no longer exists.
  if (session.username !== config.auth.username) return null;

  return session;
}

/**
 * Guard for every protected `/api` route.
 *
 * Registered as an `onRequest` hook inside the protected plugin's encapsulation context, so it
 * applies to exactly the routes that plugin owns. Authorisation is therefore structural rather
 * than a list of protected URL prefixes — there is no path string to mistype, and no encoding
 * trick that can slip a route past it.
 */
export function createAuthGuard(config: AppConfig) {
  return async function authGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const session = readSession(request, config);

    if (session === null) {
      // Clear a present-but-invalid cookie so the browser stops sending it.
      if (request.cookies[SESSION_COOKIE_NAME] !== undefined) {
        reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
      }
      await reply.code(401).send(errorBody('unauthorized', 'Sign in to continue.'));
      return;
    }

    request.session = session;

    // Defence in depth against CSRF. `SameSite=Lax` already keeps the session cookie off
    // cross-site POSTs; requiring a JSON content type means a cross-origin <form> submission
    // cannot reach a mutating handler either, since forms can only send
    // application/x-www-form-urlencoded, multipart/form-data, or text/plain.
    if (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH') {
      const contentType = request.headers['content-type'] ?? '';
      if (!contentType.toLowerCase().includes('application/json')) {
        await reply
          .code(415)
          .send(
            errorBody(
              'validation',
              'Expected Content-Type: application/json. This endpoint does not accept form submissions.',
            ),
          );
        return;
      }
    }
  };
}
