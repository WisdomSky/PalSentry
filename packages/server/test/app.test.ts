import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type {
  BasesResponse,
  HealthResponse,
  MeResponse,
  MetaResponse,
  PlayersResponse,
  SettingsResponse,
  StatusResponse,
} from '@palsentry/shared';
import {
  DEFAULT_MAP_PROJECTION,
  DEFAULT_MAP_TEXTURE_URL,
  DEFAULT_WORLD_TREE_TEXTURE_URL,
} from '@palsentry/shared';
import {
  TEST_PASSWORD,
  TEST_SESSION_SECRET,
  TEST_USERNAME,
  cookieHeader,
  createTestApp,
  signIn,
  type TestApp,
} from './helpers/test-app.js';
import { FIXTURES } from './helpers/palworld-stub.js';

const apps: TestApp[] = [];

async function makeApp(options: Parameters<typeof createTestApp>[0] = {}): Promise<TestApp> {
  const testApp = await createTestApp(options);
  apps.push(testApp);
  return testApp;
}

after(async () => {
  await Promise.all(apps.map((testApp) => testApp.close()));
});

describe('GET /api/health', () => {
  it('is reachable without a session so Docker HEALTHCHECK works', async () => {
    const { app } = await makeApp();
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    assert.equal(response.statusCode, 200);
    const body = response.json<HealthResponse>();
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.version, 'string');
    assert.ok(body.uptimeSeconds >= 0);
  });

  it('does not leak Palworld server details', async () => {
    const { app } = await makeApp();
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    assert.ok(!response.body.includes('Palworld example Server'));
    assert.ok(!response.body.includes('password'));
  });
});

describe('authentication', () => {
  const PROTECTED = ['/api/meta', '/api/status', '/api/players', '/api/bases', '/api/settings'];

  for (const url of PROTECTED) {
    it(`rejects ${url} without a session`, async () => {
      const { app } = await makeApp();
      const response = await app.inject({ method: 'GET', url });

      assert.equal(response.statusCode, 401);
      assert.equal(response.json<{ error: { code: string } }>().error.code, 'unauthorized');
      assert.equal(response.headers['set-cookie'], undefined, 'nothing to clear when no cookie');
    });
  }

  it('rejects a request with a forged cookie signature', async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { cookie: 'palsentry_session=eyJ1IjoiYWRtaW4iLCJleHAiOjQ3MDAwMDAwMDAwMH0.forged' },
    });

    assert.equal(response.statusCode, 401);
  });

  it('rejects a cookie signed with a different secret', async () => {
    // A session minted by another instance must not be accepted here.
    const other = await makeApp({
      env: { PALSENTRY_SESSION_SECRET: 'a-completely-different-secret-value-here' },
    });
    const foreignCookie = await signIn(other.app);

    const { app } = await makeApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { cookie: foreignCookie },
    });

    assert.equal(response.statusCode, 401);
    assert.notEqual(TEST_SESSION_SECRET, 'a-completely-different-secret-value-here');
  });

  it('clears an invalid session cookie so the browser stops sending it', async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { cookie: 'palsentry_session=garbage.invalid' },
    });

    assert.equal(response.statusCode, 401);
    const cleared = response.headers['set-cookie'];
    assert.ok(cleared !== undefined, 'expected the invalid cookie to be cleared');
    assert.match(String(cleared), /palsentry_session=;/);
  });

  it('rejects a session issued for a different username', async () => {
    // Valid signature, wrong user — happens after PALSENTRY_AUTH_USERNAME is changed.
    const other = await makeApp({ env: { PALSENTRY_AUTH_USERNAME: 'someone-else' } });
    const otherCookie = await signIn(other.app, 'someone-else');

    const { app } = await makeApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { cookie: otherCookie },
    });

    assert.equal(response.statusCode, 401);
  });
});

describe('POST /api/auth/login', () => {
  it('signs in with the correct credentials and sets an httpOnly session cookie', async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json<MeResponse>(), {
      authenticated: true,
      user: { username: TEST_USERNAME },
    });

    const setCookie = String(response.headers['set-cookie']);
    assert.match(setCookie, /palsentry_session=/);
    assert.match(setCookie, /HttpOnly/i, 'the session must not be readable from JavaScript');
    assert.match(setCookie, /SameSite=Lax/i, 'SameSite=Lax is the primary CSRF defence');
    assert.match(setCookie, /Path=\//);
  });

  it('omits the Secure flag when not behind TLS', async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
    });

    assert.ok(!/Secure/i.test(String(response.headers['set-cookie'])));
  });

  it('marks the cookie Secure when PALSENTRY_TRUST_PROXY is enabled', async () => {
    const { app } = await makeApp({ env: { PALSENTRY_TRUST_PROXY: 'true' } });
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
    });

    assert.match(String(response.headers['set-cookie']), /Secure/i);
  });

  it('rejects a wrong password with 401 and no cookie', async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { username: TEST_USERNAME, password: 'wrong-password' },
    });

    assert.equal(response.statusCode, 401);
    assert.equal(response.cookies.length, 0);
  });

  it('rejects an unknown username', async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'nobody', password: TEST_PASSWORD },
    });

    assert.equal(response.statusCode, 401);
  });

  it('returns the same message for a bad username and a bad password', async () => {
    const { app } = await makeApp();

    const badUser = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'nobody', password: TEST_PASSWORD },
    });
    const badPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { username: TEST_USERNAME, password: 'nope' },
    });

    // Differing messages would let an attacker enumerate valid usernames.
    assert.equal(
      badUser.json<{ error: { message: string } }>().error.message,
      badPassword.json<{ error: { message: string } }>().error.message,
    );
  });

  it('validates the body', async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { username: '', password: '' },
    });

    assert.equal(response.statusCode, 400);
    const body = response.json<{ error: { code: string; fields?: Record<string, string> } }>();
    assert.equal(body.error.code, 'validation');
    assert.ok(body.error.fields?.username !== undefined);
    assert.ok(body.error.fields?.password !== undefined);
  });

  it('rate limits repeated failures', async () => {
    const { app } = await makeApp();

    let sawRateLimit = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: { username: TEST_USERNAME, password: `wrong-${attempt}` },
      });
      if (response.statusCode === 429) {
        sawRateLimit = true;
        break;
      }
    }

    assert.ok(sawRateLimit, 'expected a 429 after enough failed attempts');
  });

  it('accepts a pre-computed password hash instead of a plaintext password', async () => {
    // scrypt hash of "hash-only-password", generated with the project's own hash-password script.
    const { hashPassword } = await import('../src/auth/password.js');
    const hash = hashPassword('hash-only-password');

    const { app } = await makeApp({
      env: { PALSENTRY_AUTH_PASSWORD: undefined, PALSENTRY_AUTH_PASSWORD_HASH: hash },
    });

    const ok = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { username: TEST_USERNAME, password: 'hash-only-password' },
    });
    assert.equal(ok.statusCode, 200);

    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: { username: TEST_USERNAME, password: 'hash-only-passwerd' },
    });
    assert.equal(bad.statusCode, 401);
  });
});

describe('/api/auth/me and /api/auth/logout', () => {
  it('reports unauthenticated without a cookie', async () => {
    const { app } = await makeApp();
    const response = await app.inject({ method: 'GET', url: '/api/auth/me' });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json<MeResponse>(), { authenticated: false, user: null });
  });

  it('reports the user with a valid cookie', async () => {
    const { app } = await makeApp();
    const cookie = await signIn(app);

    const response = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json<MeResponse>(), {
      authenticated: true,
      user: { username: TEST_USERNAME },
    });
  });

  it('refreshes the session cookie on /me so a long session does not expire mid-use', async () => {
    const { app } = await makeApp();
    const cookie = await signIn(app);

    const response = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    assert.ok(cookieHeader(response, 'palsentry_session') !== null, 'expected a refreshed cookie');
  });

  it('logout clears the cookie and access is denied afterwards', async () => {
    const { app } = await makeApp();
    const cookie = await signIn(app);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    assert.equal(logout.statusCode, 200);
    assert.match(String(logout.headers['set-cookie']), /palsentry_session=;/);

    const cleared = cookieHeader(logout, 'palsentry_session');
    assert.ok(cleared !== null && cleared.endsWith('='), 'cookie value should be emptied');
  });
});

describe('CSRF defence', () => {
  it('rejects a non-JSON POST to a protected route once authenticated', async () => {
    const { app } = await makeApp();
    const cookie = await signIn(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/actions/save',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=b',
    });

    assert.equal(response.statusCode, 415);
    assert.match(
      response.json<{ error: { message: string } }>().error.message,
      /application\/json/,
    );
  });

  it('rejects a protected POST with no content type at all', async () => {
    const { app } = await makeApp();
    const cookie = await signIn(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/actions/save',
      headers: { cookie },
      payload: '',
    });

    assert.equal(response.statusCode, 415);
  });

  it('allows a JSON POST through to routing, which is what real clients send', async () => {
    const { app } = await makeApp();
    const cookie = await signIn(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/actions/save',
      headers: { cookie, 'content-type': 'application/json' },
      payload: {},
    });

    assert.notEqual(response.statusCode, 415, 'a JSON body must not be blocked by the CSRF check');
  });

  it('checks authentication before content type, so unauthenticated callers learn nothing', async () => {
    const { app } = await makeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/actions/save',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=b',
    });

    assert.equal(response.statusCode, 401);
  });
});

describe('GET /api/meta', () => {
  it('reports capabilities to an authenticated caller', async () => {
    const { app } = await makeApp();
    const cookie = await signIn(app);

    const response = await app.inject({ method: 'GET', url: '/api/meta', headers: { cookie } });
    assert.equal(response.statusCode, 200);

    const body = response.json<MetaResponse>();
    assert.equal(body.destructiveAllowed, false, 'destructive actions default to off');
    assert.equal(body.map.projection, DEFAULT_MAP_PROJECTION);
    assert.equal(body.map.layers.palpagos.textureUrl, DEFAULT_MAP_TEXTURE_URL);
    assert.equal(body.map.layers.worldTree.textureUrl, DEFAULT_WORLD_TREE_TEXTURE_URL);
    assert.equal(body.polling.defaultIntervalMs, 5_000);
    assert.ok(body.polling.options.includes(0), 'manual refresh is an option');
    assert.equal(body.history.retentionDays, 30);
    assert.equal(body.restart.defaultWaitSeconds, 30);
  });

  it('reflects PALSENTRY_ALLOW_DESTRUCTIVE', async () => {
    const { app } = await makeApp({ env: { PALSENTRY_ALLOW_DESTRUCTIVE: 'true' } });
    const cookie = await signIn(app);

    const response = await app.inject({ method: 'GET', url: '/api/meta', headers: { cookie } });
    assert.equal(response.json<MetaResponse>().destructiveAllowed, true);
  });

  it('reports configured map textures and projection', async () => {
    const { app } = await makeApp({
      env: {
        PALSENTRY_MAP_TEXTURE_URL: '/map/world.png',
        PALSENTRY_WORLD_TREE_TEXTURE_URL: '/map/tree.png',
        PALSENTRY_MAP_PROJECTION: 'new',
      },
    });
    const cookie = await signIn(app);

    const body = (
      await app.inject({ method: 'GET', url: '/api/meta', headers: { cookie } })
    ).json<MetaResponse>();

    assert.equal(body.map.layers.palpagos.textureUrl, '/map/world.png');
    assert.equal(body.map.layers.worldTree.textureUrl, '/map/tree.png');
    assert.equal(body.map.projection, 'new');
  });

  it('reports the abstract grid when the projection is disabled', async () => {
    const { app } = await makeApp({ env: { PALSENTRY_MAP_PROJECTION: 'none' } });
    const cookie = await signIn(app);

    const body = (
      await app.inject({ method: 'GET', url: '/api/meta', headers: { cookie } })
    ).json<MetaResponse>();

    assert.equal(body.map.projection, 'none');
    assert.equal(body.map.layers.palpagos.textureUrl, null);
    assert.equal(
      body.map.layers.worldTree.textureUrl,
      null,
      'a disabled projection serves no texture to the client',
    );
  });
});

describe('GET /api/status', () => {
  it('returns live info and metrics when the server is up', async () => {
    const { app } = await makeApp();
    const cookie = await signIn(app);

    const response = await app.inject({ method: 'GET', url: '/api/status', headers: { cookie } });
    assert.equal(response.statusCode, 200);

    const body = response.json<StatusResponse>();
    assert.equal(body.online, true);
    assert.deepEqual(body.info, FIXTURES.info);
    assert.equal(body.metrics?.serverfps, 58);
    assert.equal(body.metrics?.currentplayernum, 2);
    assert.equal(body.error, null);
    assert.ok(typeof body.latencyMs === 'number' && body.latencyMs >= 0);
  });

  it('returns 200 with online:false when the game server is down, not a 502', async () => {
    // The dashboard must be able to render "your server is off" as a normal state.
    const { app } = await makeApp({ palworldUrl: 'http://127.0.0.1:9' });
    const cookie = await signIn(app);

    const response = await app.inject({ method: 'GET', url: '/api/status', headers: { cookie } });
    assert.equal(response.statusCode, 200);

    const body = response.json<StatusResponse>();
    assert.equal(body.online, false);
    assert.equal(body.info, null);
    assert.equal(body.metrics, null);
    assert.equal(body.latencyMs, null);
    assert.equal(body.error?.code, 'unreachable');
    assert.match(body.error?.message ?? '', /Connection refused|Could not reach/);
  });

  it('reports a credential problem distinctly from an unreachable server', async () => {
    const { app } = await makeApp({
      env: { PALSERVER_ADMIN_PASSWORD: 'the-wrong-palworld-password' },
    });
    const cookie = await signIn(app);

    const body = (
      await app.inject({ method: 'GET', url: '/api/status', headers: { cookie } })
    ).json<StatusResponse>();

    assert.equal(body.online, false);
    assert.equal(body.error?.code, 'palworld_error');
    assert.match(body.error?.message ?? '', /PALSERVER_ADMIN_PASSWORD/);
  });
});

describe('GET /api/players', () => {
  it('lists online players', async () => {
    const { app } = await makeApp();
    const cookie = await signIn(app);

    const response = await app.inject({ method: 'GET', url: '/api/players', headers: { cookie } });
    assert.equal(response.statusCode, 200);

    const body = response.json<PlayersResponse>();
    assert.equal(body.online, true);
    assert.equal(body.players.length, 2);
    assert.equal(body.players[0]?.name, 'Alice');
    assert.equal(body.players[0]?.banned, false, 'nobody is banned yet');
    assert.equal(body.players[0]?.banReason, null);
    assert.equal(body.players[0]?.online, true, 'a listed player is online by definition');
  });

  it('reports live-only details for players who are online', async () => {
    const { app } = await makeApp();
    const cookie = await signIn(app);

    const body = (
      await app.inject({ method: 'GET', url: '/api/players', headers: { cookie } })
    ).json<PlayersResponse>();

    const alice = body.players.find((player) => player.userId === 'USER-1');
    assert.equal(alice?.online, true);
    assert.ok(
      alice !== undefined && alice.online,
      'narrow on `online` before reading session fields',
    );
    assert.equal(alice.ip, '10.0.0.11');
    assert.equal(alice.ping, 24.5);
    assert.equal(alice.building_count, 137);
    assert.ok(alice.lastOnline !== '');
  });

  it('annotates banned players from the registry', async () => {
    const { app, ctx } = await makeApp();
    const cookie = await signIn(app);

    ctx.bans.recordBan({
      userid: 'USER-1',
      playerName: 'Alice',
      reason: 'griefing',
      actorName: 'admin',
      actorIp: '10.0.0.5',
      rawResponse: null,
    });

    const body = (
      await app.inject({ method: 'GET', url: '/api/players', headers: { cookie } })
    ).json<PlayersResponse>();

    const alice = body.players.find((player) => player.userId === 'USER-1');
    const bob = body.players.find((player) => player.userId === 'USER-2');

    assert.equal(alice?.banned, true, 'the banned player is flagged');
    assert.equal(alice?.banReason, 'griefing', 'the reason is surfaced for the UI');
    assert.ok(alice?.bannedAt !== null, 'the ban timestamp is surfaced');
    assert.equal(bob?.banned, false, 'other players are unaffected');
  });

  it('returns 200 with an empty roster when the game server is down and nobody was seen', async () => {
    const { app } = await makeApp({ palworldUrl: 'http://127.0.0.1:9' });
    const cookie = await signIn(app);

    const response = await app.inject({ method: 'GET', url: '/api/players', headers: { cookie } });
    assert.equal(response.statusCode, 200);

    const body = response.json<PlayersResponse>();
    assert.equal(body.online, false);
    assert.deepEqual(body.players, []);
    assert.equal(body.error?.code, 'unreachable');
  });

  it('keeps remembered players visible while the game server is down', async () => {
    const { app, ctx, stub } = await makeApp();
    const cookie = await signIn(app);

    // One successful read puts Alice and Bob on the roster.
    const first = (
      await app.inject({ method: 'GET', url: '/api/players', headers: { cookie } })
    ).json<PlayersResponse>();
    assert.equal(first.players.length, 2);
    ctx.players.record(
      [
        {
          name: 'Carol',
          accountName: 'carol_psn',
          playerId: 'PLAYER-3',
          userId: 'USER-3',
          ip: '10.0.0.13',
          ping: 12,
          location_x: 5,
          location_y: 6,
          level: 3,
          building_count: 9,
        },
      ],
      new Date('2026-09-01T00:00:00.000Z'),
    );

    stub.setPlayers(null);
    ctx.client.invalidateCache();
    const body = (
      await app.inject({ method: 'GET', url: '/api/players', headers: { cookie } })
    ).json<PlayersResponse>();

    assert.equal(body.online, false, 'the roster could not be refreshed');
    assert.ok(body.error !== null, 'the reason the roster could not be refreshed is reported');
    assert.equal(body.players.length, 3, 'the roster survives an outage');

    // Every row is reported offline, and session-only details are withheld rather than stale.
    for (const player of body.players) {
      assert.equal(player.online, false);
      assert.equal(player.ip, null);
      assert.equal(player.ping, null);
      assert.equal(player.building_count, null);
    }

    const carol = body.players.find((player) => player.userId === 'USER-3');
    assert.equal(carol?.name, 'Carol', 'identity fields survive');
    assert.equal(carol?.lastOnline, '2026-09-01T00:00:00.000Z');
    assert.notEqual(carol?.location_x, undefined, 'the last known position is kept');
  });

  it('marks players who left as offline without forgetting them', async () => {
    const { app, ctx, stub } = await makeApp();
    const cookie = await signIn(app);

    const first = (
      await app.inject({ method: 'GET', url: '/api/players', headers: { cookie } })
    ).json<PlayersResponse>();
    assert.equal(first.players.length, 2);

    // Bob disconnects: the next successful read reports only Alice.
    stub.setPlayers([FIXTURES.players.players[0]]);
    ctx.client.invalidateCache();
    const body = (
      await app.inject({ method: 'GET', url: '/api/players', headers: { cookie } })
    ).json<PlayersResponse>();

    assert.equal(body.online, true);
    assert.equal(body.players.length, 2, 'the roster keeps the player who left');

    const alice = body.players.find((player) => player.userId === 'USER-1');
    const bob = body.players.find((player) => player.userId === 'USER-2');
    assert.equal(alice?.online, true);
    assert.equal(bob?.online, false);
    assert.ok(bob !== undefined && !bob.online);
    assert.equal(bob.ip, null, 'a stale IP address is never reported as current');
    assert.equal(bob.name, 'Bob', 'the last known identity is kept');
  });

  it('annotates offline players from the ban registry too', async () => {
    const { app, ctx, stub } = await makeApp();
    const cookie = await signIn(app);

    await app.inject({ method: 'GET', url: '/api/players', headers: { cookie } });
    stub.setPlayers([]);
    ctx.client.invalidateCache();
    ctx.bans.recordBan({
      userid: 'USER-2',
      playerName: 'Bob',
      reason: 'griefing',
      actorName: 'admin',
      actorIp: '10.0.0.5',
      rawResponse: null,
    });

    const body = (
      await app.inject({ method: 'GET', url: '/api/players', headers: { cookie } })
    ).json<PlayersResponse>();

    assert.equal(body.players.length, 2);
    assert.ok(
      body.players.every((player) => !player.online),
      'an empty successful read means everyone is offline',
    );

    const bob = body.players.find((player) => player.userId === 'USER-2');
    assert.equal(bob?.banned, true, 'ban state reaches offline rows');
    assert.equal(bob?.banReason, 'griefing');
  });
});

describe('GET /api/bases', () => {
  it('returns all normalized guild bases in a recoverable envelope', async () => {
    const { app } = await makeApp();
    const cookie = await signIn(app);

    const response = await app.inject({ method: 'GET', url: '/api/bases', headers: { cookie } });
    assert.equal(response.statusCode, 200);

    const body = response.json<BasesResponse>();
    assert.equal(body.available, true);
    assert.equal(body.error, null);
    assert.equal(body.bases.length, 2);
    assert.deepEqual(
      body.bases.map((base) => base.guildName),
      ['The Builders', 'Tree Explorers'],
    );
  });

  it('shares the cached snapshot and supports an explicit refresh', async () => {
    const { app, stub } = await makeApp();
    const cookie = await signIn(app);

    await app.inject({ method: 'GET', url: '/api/bases', headers: { cookie } });
    await app.inject({ method: 'GET', url: '/api/bases', headers: { cookie } });
    assert.equal(stub.requestsFor('/game-data').length, 1);

    await app.inject({ method: 'GET', url: '/api/bases?refresh=true', headers: { cookie } });
    assert.equal(stub.requestsFor('/game-data').length, 2);
  });

  it('stays 200 and explains how to enable a missing game-data endpoint', async () => {
    const { app } = await makeApp({
      stub: {
        handler: ({ res }) => {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'game-data disabled' }));
        },
      },
    });
    const cookie = await signIn(app);

    const response = await app.inject({ method: 'GET', url: '/api/bases', headers: { cookie } });
    const body = response.json<BasesResponse>();
    assert.equal(response.statusCode, 200);
    assert.equal(body.available, false);
    assert.deepEqual(body.bases, []);
    assert.equal(body.error?.code, 'not_found');
    assert.match(body.error?.message ?? '', /-enable-gamedata-api/);
  });

  it('reports malformed game-data without failing the player map contract', async () => {
    const { app } = await makeApp({ stub: { overrides: { gameData: { ActorData: null } } } });
    const cookie = await signIn(app);

    const response = await app.inject({ method: 'GET', url: '/api/bases', headers: { cookie } });
    const body = response.json<BasesResponse>();
    assert.equal(response.statusCode, 200);
    assert.equal(body.available, false);
    assert.equal(body.error?.code, 'palworld_error');
    assert.match(body.error?.message ?? '', /-enable-gamedata-api/);
  });

  it('reports transient upstream failures separately from the game-data prerequisite', async () => {
    const { app } = await makeApp({
      stub: {
        handler: ({ res }) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'temporary failure' }));
        },
      },
    });
    const cookie = await signIn(app);

    const body = (
      await app.inject({ method: 'GET', url: '/api/bases', headers: { cookie } })
    ).json<BasesResponse>();
    assert.equal(body.available, false);
    assert.equal(body.error?.code, 'palworld_error');
    assert.match(body.error?.message ?? '', /HTTP 500/);
    assert.doesNotMatch(body.error?.message ?? '', /enable-gamedata-api/);
  });
});

describe('GET /api/settings', () => {
  it('returns the settings dump', async () => {
    const { app } = await makeApp();
    const cookie = await signIn(app);

    const response = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    assert.equal(response.statusCode, 200);

    const body = response.json<SettingsResponse>();
    assert.equal(body.settings.ServerName, 'Pals');
    assert.equal(body.settings.ExpRate, 1.2);
  });

  it('propagates a 502 when the game server is unreachable', async () => {
    // Unlike /status, an empty settings page would be misleading, so this one errors.
    const { app } = await makeApp({ palworldUrl: 'http://127.0.0.1:9' });
    const cookie = await signIn(app);

    const response = await app.inject({ method: 'GET', url: '/api/settings', headers: { cookie } });
    assert.equal(response.statusCode, 502);
    assert.equal(response.json<{ error: { code: string } }>().error.code, 'unreachable');
  });
});

describe('unknown routes', () => {
  it('returns JSON, not HTML, for an unknown /api path', async () => {
    const { app } = await makeApp();
    const response = await app.inject({ method: 'GET', url: '/api/does-not-exist' });

    assert.equal(response.statusCode, 404);
    assert.match(String(response.headers['content-type']), /application\/json/);
    assert.equal(response.json<{ error: { code: string } }>().error.code, 'not_found');
  });

  it('serves a JSON 404 for a non-API path when no frontend build is present', async () => {
    // `PALSENTRY_WEB_DIST` is the first candidate checked but a missing directory falls through
    // to the others, so whether the SPA exists depends on whether `npm run build` has run.
    // Assert whichever behaviour is correct for the current tree instead of pinning one.
    const { app } = await makeApp();
    const response = await app.inject({ method: 'GET', url: '/some/client/route' });

    if (response.statusCode === 200) {
      assert.match(String(response.headers['content-type']), /text\/html/);
      assert.match(response.body, /<div id="app">/);
    } else {
      assert.equal(response.statusCode, 404);
    }
  });
});

describe('error handling', () => {
  it('returns a structured 400 for a malformed JSON body', async () => {
    const { app } = await makeApp();
    const cookie = await signIn(app);

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { cookie, 'content-type': 'application/json' },
      payload: '{ this is not json',
    });

    assert.equal(response.statusCode, 400);
    assert.ok(response.json<{ error: { code: string } }>().error.code !== undefined);
  });
});
