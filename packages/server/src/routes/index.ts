import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { createAuthGuard } from '../plugins/session.js';
import { basesRoutes, metaRoutes, playersRoutes, settingsRoutes, statusRoutes } from './core.js';
import { actionRoutes } from './actions.js';
import { auditRoutes } from './audit.js';
import { bansRoutes } from './bans.js';
import { historyRoutes } from './history.js';
import { publicApiRoutes } from './public.js';
import { restartRoutes } from './restart.js';

/**
 * Every authenticated `/api` route.
 *
 * The auth guard is added as an `onRequest` hook on this plugin instance. Because Fastify hooks
 * are encapsulated and inherited by child plugins, the guard covers exactly the routes
 * registered below — and nothing in `publicApiRoutes`. Authorisation is therefore structural
 * rather than a list of URL prefixes to keep in sync.
 *
 * Adding a route file: register it here, and it is protected automatically.
 */
export function protectedApiRoutes(ctx: AppContext) {
  return async function protectedApi(app: FastifyInstance): Promise<void> {
    app.addHook('onRequest', createAuthGuard(ctx.config));

    await app.register(metaRoutes(ctx));
    await app.register(statusRoutes(ctx));
    await app.register(playersRoutes(ctx));
    await app.register(basesRoutes(ctx));
    await app.register(settingsRoutes(ctx));
    await app.register(actionRoutes(ctx));
    await app.register(bansRoutes(ctx));
    await app.register(auditRoutes(ctx));
    await app.register(historyRoutes(ctx));
    await app.register(restartRoutes(ctx));
  };
}

export { publicApiRoutes };
