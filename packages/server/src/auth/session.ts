import type { SessionUser } from '@palsentry/shared';

/**
 * Signed-cookie sessions.
 *
 * The cookie payload is not secret (a username and an expiry), so it is signed rather than
 * encrypted. Tampering is impossible without `PALSENTRY_SESSION_SECRET`, and we hold no
 * server-side session state — which means no session store, no Redis, and a restart does not
 * log anybody out.
 *
 * Trade-off: individual sessions cannot be revoked server-side. Rotating the secret invalidates
 * every session at once, which is the documented remedy (see the README security section).
 */

export const SESSION_COOKIE_NAME = 'palsentry_session';

/**
 * Username reported while the desktop app is connected.
 *
 * There is no login in desktop mode, but the session shape is what the guard, `/auth/me` and the
 * SPA already agree on, so a connected desktop app presents this fixed identity.
 */
export const DESKTOP_SESSION_USERNAME = 'Local';

export interface SessionPayload {
  /** Username the session was issued to. */
  u: string;
  /** Expiry, as a Unix millisecond timestamp. */
  exp: number;
}

const HOUR_MS = 60 * 60 * 1000;

/** Serialise a session into the cookie value (before signing). */
export function createSessionValue(
  username: string,
  ttlHours: number,
  now: number = Date.now(),
): string {
  const payload: SessionPayload = { u: username, exp: now + ttlHours * HOUR_MS };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Parse and validate a cookie value.
 *
 * Returns null for anything malformed or expired, so a corrupted or stale cookie is treated as
 * "not signed in" rather than an error. Note that the signature is verified by
 * `@fastify/cookie` *before* this runs — this function only handles content validity.
 */
export function parseSessionValue(value: string, now: number = Date.now()): SessionUser | null {
  if (typeof value !== 'string' || value === '') return null;

  let decoded: string;
  try {
    decoded = Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;

  const { u, exp } = parsed as { u?: unknown; exp?: unknown };
  if (typeof u !== 'string' || u === '') return null;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  if (exp <= now) return null;

  return { username: u };
}

/** Cookie options shared by login (set) and logout (clear). */
export function sessionCookieOptions(secure: boolean, ttlHours: number) {
  return {
    path: '/',
    httpOnly: true,
    // `lax` means the cookie is not attached to cross-site POSTs, which is the primary CSRF
    // defence here and the reason no CSRF token dance is needed.
    sameSite: 'lax' as const,
    secure,
    signed: true,
    maxAge: Math.floor(ttlHours * 3600),
  };
}
