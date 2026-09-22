import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type {
  ConnectionStatusResponse,
  MeResponse,
  MetaResponse,
  StatusResponse,
} from '@palsentry/shared';
import { createTestApp, type TestApp } from './helpers/test-app.js';

/**
 * Desktop hosting.
 *
 * These tests cover the contract the Electron shell and the connection screen rely on: the server
 * starts without credentials, the connection screen can reach the API before any session exists,
 * a connection is only accepted after a live probe, the password is never persisted, and the live
 * client follows the connection.
 */

const PALWORLD_PASSWORD = 'test-palworld-password';
const temporaryDirs: string[] = [];

/** A scratch directory for the shell-owned connection file, removed after the suite. */
async function scratchDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'palsentry-desktop-'));
  temporaryDirs.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(temporaryDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Desktop app with no credentials, exactly as the shell starts before the user connects. */
async function desktopApp(
  options: { configPath?: string | null; palworldUrl?: string } = {},
): Promise<TestApp & { configPath: string | null }> {
  const configPath =
    options.configPath === undefined
      ? path.join(await scratchDir(), 'connection.json')
      : options.configPath;

  const app = await createTestApp({
    palworldUrl: options.palworldUrl,
    env: {
      PALSENTRY_DESKTOP: '1',
      PALWORLD_REST_URL: undefined,
      PALWORLD_ADMIN_PASSWORD: undefined,
      PALSENTRY_DESKTOP_CONFIG: configPath ?? undefined,
    },
  });

  return Object.assign(app, { configPath });
}

async function connect(
  app: TestApp,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: ConnectionStatusResponse; raw: string }> {
  const response = await app.app.inject({
    method: 'POST',
    url: '/api/connection',
    headers: { 'content-type': 'application/json' },
    payload,
  });

  return {
    statusCode: response.statusCode,
    body: response.json<ConnectionStatusResponse>(),
    raw: response.body,
  };
}

describe('desktop hosting', () => {
  describe('before a connection exists', () => {
    it('starts and reports itself as desktop with nothing configured', async () => {
      const app = await desktopApp();
      try {
        const response = await app.app.inject({ method: 'GET', url: '/api/connection' });

        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.json<ConnectionStatusResponse>(), {
          desktop: true,
          configured: false,
          restUrl: null,
          username: 'admin',
        });
      } finally {
        await app.close();
      }
    });

    it('reports an unauthenticated session so the SPA renders the connection screen', async () => {
      const app = await desktopApp();
      try {
        const response = await app.app.inject({ method: 'GET', url: '/api/auth/me' });

        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.json<MeResponse>(), {
          authenticated: false,
          user: null,
          desktop: true,
        });
        // No cookie is issued: there is no session to keep alive in desktop mode.
        assert.equal(response.headers['set-cookie'], undefined);
      } finally {
        await app.close();
      }
    });

    it('keeps protected routes closed until a connection is made', async () => {
      const app = await desktopApp();
      try {
        const response = await app.app.inject({ method: 'GET', url: '/api/status' });
        assert.equal(response.statusCode, 401);
      } finally {
        await app.close();
      }
    });

    it('prefills a saved REST URL without treating it as connected', async () => {
      const app = await createTestApp({
        env: {
          PALSENTRY_DESKTOP: '1',
          PALWORLD_REST_URL: 'http://saved.example:8212',
          PALWORLD_ADMIN_PASSWORD: undefined,
        },
      });

      try {
        const response = await app.app.inject({ method: 'GET', url: '/api/connection' });
        const body = response.json<ConnectionStatusResponse>();

        assert.equal(body.configured, false);
        assert.equal(body.restUrl, 'http://saved.example:8212/v1/api');
      } finally {
        await app.close();
      }
    });
  });

  describe('connecting', () => {
    it('accepts a working server and reports it as configured', async () => {
      const app = await desktopApp();
      try {
        const result = await connect(app, {
          restUrl: app.stub.baseUrl,
          adminPassword: PALWORLD_PASSWORD,
        });

        assert.equal(result.statusCode, 200);
        assert.equal(result.body.configured, true);
        // Normalised to the client's base URL: the stub's baseUrl already ends in /v1/api.
        assert.equal(result.body.restUrl, app.stub.baseUrl);

        // The session now exists, so the dashboard's routes open up.
        const me = await app.app.inject({ method: 'GET', url: '/api/auth/me' });
        assert.deepEqual(me.json<MeResponse>(), {
          authenticated: true,
          user: { username: 'Local' },
          desktop: true,
        });

        const status = await app.app.inject({ method: 'GET', url: '/api/status' });
        assert.equal(status.statusCode, 200);
        assert.equal(status.json<StatusResponse>().online, true);
      } finally {
        await app.close();
      }
    });

    it('accepts the host:port form the docs use, adding the API path', async () => {
      const app = await desktopApp();
      try {
        const result = await connect(app, {
          restUrl: `${app.stub.baseUrl}/`,
          adminPassword: PALWORLD_PASSWORD,
        });

        assert.equal(result.statusCode, 200);
        assert.equal(result.body.restUrl, app.stub.baseUrl);
      } finally {
        await app.close();
      }
    });

    it('rejects a wrong password with the upstream message and changes nothing', async () => {
      const app = await desktopApp();
      try {
        const result = await connect(app, {
          restUrl: app.stub.baseUrl,
          adminPassword: 'not-the-password',
        });

        // 502, not 401: an upstream failure is reported as a gateway error, the same way every
        // other Palworld failure in this API is. The message is what tells the user what to fix,
        // and it is phrased for someone using the form rather than the container's environment.
        assert.equal(result.statusCode, 502);
        assert.match(result.raw, /rejected the admin password/i);
        assert.doesNotMatch(result.raw, /PALWORLD_ADMIN_PASSWORD/);

        const status = await app.app.inject({ method: 'GET', url: '/api/connection' });
        assert.equal(status.json<ConnectionStatusResponse>().configured, false);
      } finally {
        await app.close();
      }
    });

    it('rejects an unreachable server', async () => {
      const app = await desktopApp();
      try {
        const result = await connect(app, {
          // Reserved loopback port, nothing listens there.
          restUrl: 'http://127.0.0.1:1',
          adminPassword: PALWORLD_PASSWORD,
        });

        assert.equal(result.statusCode, 502);
        assert.match(result.raw, /Could not reach/i);
        assert.doesNotMatch(result.raw, /PALWORLD_REST_URL/);
      } finally {
        await app.close();
      }
    });

    it('rejects an unparseable URL with a field message', async () => {
      const app = await desktopApp();
      try {
        const result = await connect(app, {
          restUrl: 'not a url',
          adminPassword: PALWORLD_PASSWORD,
        });

        assert.equal(result.statusCode, 400);
        assert.match(result.raw, /restUrl/);
      } finally {
        await app.close();
      }
    });

    it('requires JSON, so a cross-origin form cannot change the connection', async () => {
      const app = await desktopApp();
      try {
        const response = await app.app.inject({
          method: 'POST',
          url: '/api/connection',
          headers: { 'content-type': 'text/plain' },
          payload: 'restUrl=http://evil.example',
        });

        assert.equal(response.statusCode, 415);
      } finally {
        await app.close();
      }
    });

    it('records an audit entry without the password', async () => {
      const app = await desktopApp();
      try {
        await connect(app, { restUrl: app.stub.baseUrl, adminPassword: PALWORLD_PASSWORD });

        const rows = app.ctx.db
          .prepare('SELECT action, target, payload_json FROM audit ORDER BY id DESC')
          .all() as { action: string; target: string | null; payload_json: string }[];

        const entry = rows.find((row) => row.action === 'desktop-connect');
        assert.ok(entry, 'expected a desktop-connect audit entry');
        assert.ok(!entry.payload_json.includes(PALWORLD_PASSWORD), 'password leaked into audit');
      } finally {
        await app.close();
      }
    });

    it('starts sampling the new server', async () => {
      const app = await desktopApp();
      try {
        await connect(app, { restUrl: app.stub.baseUrl, adminPassword: PALWORLD_PASSWORD });

        const samples = app.ctx.db
          .prepare('SELECT COUNT(*) AS count FROM metric_samples')
          .get() as { count: number };

        assert.ok(samples.count > 0, 'connecting should start metric sampling');
        assert.ok(
          app.stub.requestsFor('/metrics').length > 0,
          'the stub should have been polled for metrics',
        );
      } finally {
        await app.close();
      }
    });
  });

  describe('persistence', () => {
    it('stores the REST URL and username but never the password', async () => {
      const app = await desktopApp();
      try {
        assert.notEqual(app.configPath, null);
        await connect(app, { restUrl: app.stub.baseUrl, adminPassword: PALWORLD_PASSWORD });

        const raw = await readFile(app.configPath as string, 'utf8');
        assert.ok(!raw.includes(PALWORLD_PASSWORD), 'the admin password must never be written');
        assert.deepEqual(JSON.parse(raw), {
          restUrl: app.stub.baseUrl,
          username: 'admin',
        });
      } finally {
        await app.close();
      }
    });

    it('still connects when the URL cannot be saved', async () => {
      const app = await desktopApp({ configPath: null });
      try {
        const result = await connect(app, {
          restUrl: app.stub.baseUrl,
          adminPassword: PALWORLD_PASSWORD,
        });

        assert.equal(result.statusCode, 200);
        assert.equal(result.body.configured, true);
      } finally {
        await app.close();
      }
    });

    it('preserves the keys the desktop shell keeps in the same file', async () => {
      const dir = await scratchDir();
      const configPath = path.join(dir, 'desktop.json');
      // What the shell writes before the server starts: the port it settled on.
      await writeFile(configPath, JSON.stringify({ port: 43100 }, null, 2), 'utf8');

      const app = await desktopApp({ configPath });
      try {
        await connect(app, { restUrl: app.stub.baseUrl, adminPassword: PALWORLD_PASSWORD });

        assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
          port: 43100,
          restUrl: app.stub.baseUrl,
          username: 'admin',
        });
      } finally {
        await app.close();
      }
    });

    it('recovers from a corrupt settings file instead of refusing to connect', async () => {
      const dir = await scratchDir();
      const configPath = path.join(dir, 'desktop.json');
      await writeFile(configPath, 'this is not json', 'utf8');

      const app = await desktopApp({ configPath });
      try {
        const result = await connect(app, {
          restUrl: app.stub.baseUrl,
          adminPassword: PALWORLD_PASSWORD,
        });

        assert.equal(result.statusCode, 200);
        assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
          restUrl: app.stub.baseUrl,
          username: 'admin',
        });
      } finally {
        await app.close();
      }
    });
  });

  describe('reconnecting and disconnecting', () => {
    it('switches the live client to a different server without restarting', async () => {
      const first = await createTestApp({
        stub: { overrides: { info: { servername: 'First Server' } } },
      });

      try {
        const second = await createTestApp({
          stub: { overrides: { info: { servername: 'Second Server' } } },
        });

        try {
          const app = await desktopApp({ palworldUrl: first.stub.baseUrl });

          try {
            // Boot with the first server already known.
            await connect(app, {
              restUrl: first.stub.baseUrl,
              adminPassword: PALWORLD_PASSWORD,
            });
            const before = await app.app.inject({ method: 'GET', url: '/api/status' });
            assert.equal(before.json<StatusResponse>().info?.servername, 'First Server');

            await connect(app, {
              restUrl: second.stub.baseUrl,
              adminPassword: PALWORLD_PASSWORD,
            });

            const after = await app.app.inject({ method: 'GET', url: '/api/status' });
            assert.equal(after.json<StatusResponse>().info?.servername, 'Second Server');
          } finally {
            await app.close();
          }
        } finally {
          await second.close();
        }
      } finally {
        await first.close();
      }
    });

    it('keeps the working connection when a new attempt fails', async () => {
      const app = await desktopApp();
      try {
        await connect(app, { restUrl: app.stub.baseUrl, adminPassword: PALWORLD_PASSWORD });

        const failed = await connect(app, {
          restUrl: 'http://127.0.0.1:1',
          adminPassword: PALWORLD_PASSWORD,
        });
        assert.equal(failed.statusCode, 502);

        const status = await app.app.inject({ method: 'GET', url: '/api/status' });
        assert.equal(status.json<StatusResponse>().online, true, 'the old connection must survive');
      } finally {
        await app.close();
      }
    });

    it('disconnects back to the connection screen and remembers the URL', async () => {
      const app = await desktopApp();
      try {
        await connect(app, { restUrl: app.stub.baseUrl, adminPassword: PALWORLD_PASSWORD });

        const response = await app.app.inject({
          method: 'POST',
          url: '/api/connection/disconnect',
          headers: { 'content-type': 'application/json' },
          payload: {},
        });

        assert.equal(response.statusCode, 200);
        const body = response.json<ConnectionStatusResponse>();
        assert.equal(body.configured, false);
        assert.equal(body.restUrl, app.stub.baseUrl, 'the URL is kept for prefill');

        const me = await app.app.inject({ method: 'GET', url: '/api/auth/me' });
        assert.equal(me.json<MeResponse>().authenticated, false);

        const protectedRoute = await app.app.inject({ method: 'GET', url: '/api/status' });
        assert.equal(protectedRoute.statusCode, 401);

        const audit = app.ctx.db
          .prepare("SELECT COUNT(*) AS count FROM audit WHERE action = 'desktop-disconnect'")
          .get() as { count: number };

        assert.equal(audit.count, 1);
      } finally {
        await app.close();
      }
    });

    it('reconnects after a disconnect', async () => {
      const app = await desktopApp();
      try {
        const first = await connect(app, {
          restUrl: app.stub.baseUrl,
          adminPassword: PALWORLD_PASSWORD,
        });
        assert.equal(first.body.configured, true);

        await app.app.inject({
          method: 'POST',
          url: '/api/connection/disconnect',
          headers: { 'content-type': 'application/json' },
          payload: {},
        });

        const second = await connect(app, {
          restUrl: app.stub.baseUrl,
          adminPassword: PALWORLD_PASSWORD,
        });

        assert.equal(second.statusCode, 200);
        assert.equal(second.body.configured, true);
      } finally {
        await app.close();
      }
    });
  });

  describe('meta', () => {
    it('reports the desktop capability flags', async () => {
      const app = await desktopApp();
      try {
        await connect(app, { restUrl: app.stub.baseUrl, adminPassword: PALWORLD_PASSWORD });

        const response = await app.app.inject({ method: 'GET', url: '/api/meta' });
        const meta = response.json<MetaResponse>();

        assert.equal(meta.app.desktop, true);
        assert.equal(meta.app.authEnabled, false);
      } finally {
        await app.close();
      }
    });
  });

  describe('container deployments', () => {
    it('does not expose the connection routes outside desktop mode', async () => {
      const app = await createTestApp();
      try {
        const response = await app.app.inject({ method: 'GET', url: '/api/connection' });
        assert.equal(response.statusCode, 404);
      } finally {
        await app.close();
      }
    });

    it('keeps the login session model', async () => {
      const app = await createTestApp();
      try {
        const response = await app.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { 'content-type': 'application/json' },
          payload: { username: 'admin', password: 'test-palsentry-password' },
        });

        assert.equal(response.statusCode, 200);
        assert.equal(response.json<MeResponse>().desktop, false);
        assert.match(String(response.headers['set-cookie']), /palsentry_session=/);
      } finally {
        await app.close();
      }
    });
  });
});
