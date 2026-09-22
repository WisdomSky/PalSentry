import type { ActionName } from '@palsentry/shared';
import { isDestructiveAction } from '@palsentry/shared';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { HttpError } from './errors.js';

/**
 * Enforce the `PALSENTRY_ALLOW_DESTRUCTIVE` gate.
 *
 * This is the *second* gate on destructive actions, independent of the session: if the session
 * secret were ever leaked, an operator can still switch off kick/ban/shutdown centrally by
 * flipping one environment variable, with no redeploy of code.
 *
 * Blocked attempts are audited rather than silently dropped. If the UI is misconfigured, or
 * someone is probing the API, that belongs in the trail.
 */
export function assertActionAllowed(
  ctx: AppContext,
  request: FastifyRequest,
  action: ActionName,
): void {
  if (!isDestructiveAction(action) || ctx.config.allowDestructive) return;

  const reason = `"${action}" is disabled on this deployment.`;

  ctx.audit.record({
    actorName: request.session?.username ?? null,
    actorIp: request.ip,
    action,
    target: null,
    payload: null,
    httpStatus: 403,
    ok: false,
    error: `Blocked: ${reason}`,
    durationMs: null,
  });

  ctx.logger.warn(
    { action, ip: request.ip, actor: request.session?.username },
    'Blocked destructive action because PALSENTRY_ALLOW_DESTRUCTIVE is not enabled',
  );

  throw HttpError.forbidden(
    `${reason} Set PALSENTRY_ALLOW_DESTRUCTIVE=true to enable kick, ban, unban, shutdown, stop, and restart.`,
  );
}
