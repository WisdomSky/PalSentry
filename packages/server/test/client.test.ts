import assert from 'node:assert/strict';
import http from 'node:http';
import { after, describe, it } from 'node:test';
import type { PalworldConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { MAX_GAME_DATA_RESPONSE_BYTES, PalworldClient } from '../src/palworld/client.js';
import { PalworldError } from '../src/palworld/errors.js';
import { normaliseGuildBases } from '../src/palworld/normalise.js';
import {
  FIXTURES,
  findClosedPort,
  startPalworldStub,
  type PalworldStub,
} from './helpers/palworld-stub.js';

const logger = createLogger({ level: 'silent', pretty: false });

const openStubs: PalworldStub[] = [];

after(async () => {
  await Promise.all(openStubs.map((stub) => stub.close()));
});

async function makeStub(
  options: Parameters<typeof startPalworldStub>[0] = {},
): Promise<PalworldStub> {
  const stub = await startPalworldStub(options);
  openStubs.push(stub);
  return stub;
}

function makeConfig(overrides: Partial<PalworldConfig> = {}): PalworldConfig {
  return {
    apiBaseUrl: 'http://127.0.0.1:1/v1/api',
    username: 'admin',
    password: 'test-password',
    timeoutMs: 2_000,
    ...overrides,
  };
}

function clientFor(stub: PalworldStub, overrides: Partial<PalworldConfig> = {}): PalworldClient {
  return new PalworldClient(makeConfig({ apiBaseUrl: stub.baseUrl, ...overrides }), logger);
}

/** Assert that `fn` rejects with a PalworldError matching `kind`. */
async function assertPalworldError(
  fn: () => Promise<unknown>,
  kind: PalworldError['kind'],
): Promise<PalworldError> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof PalworldError, `expected PalworldError, got ${String(error)}`);
    assert.equal(error.kind, kind);
    return error;
  }
  assert.fail(`expected a PalworldError of kind "${kind}", but the call resolved`);
}

describe('PalworldClient reads', () => {
  it('parses /info', async () => {
    const stub = await makeStub();
    const info = await clientFor(stub).info();
    assert.deepEqual(info, FIXTURES.info);
  });

  it('parses /players', async () => {
    const stub = await makeStub();
    const players = await clientFor(stub).players();
    assert.equal(players.length, 2);
    assert.equal(players[0]?.name, 'Alice');
    assert.equal(players[0]?.userId, 'USER-1');
    assert.equal(players[0]?.level, 42);
    assert.equal(players[0]?.ping, 24.5);
    assert.equal(players[0]?.location_x, -359583);
    assert.equal(players[1]?.name, 'Bob');
  });

  it('parses /metrics', async () => {
    const stub = await makeStub();
    const metrics = await clientFor(stub).metrics();
    assert.deepEqual(metrics, FIXTURES.metrics);
  });

  it('parses /settings', async () => {
    const stub = await makeStub();
    const settings = await clientFor(stub).settings();
    assert.equal(settings.ExpRate, 1.2);
    assert.equal(settings.bEnablePlayerToPlayerDamage, false);
    assert.equal(settings.ServerName, 'Pals');
  });

  it('parses guild bases from /game-data without publishing other actors', async () => {
    const stub = await makeStub();
    const bases = await clientFor(stub).guildBases();

    assert.equal(bases.length, 2);
    assert.deepEqual(
      bases.map((base) => ({ id: base.id, guild: base.guildName })),
      [
        { id: 'base-palpagos-1', guild: 'The Builders' },
        { id: 'base-world-tree-1', guild: 'Tree Explorers' },
      ],
    );
    assert.equal(stub.requestsFor('/game-data').length, 1);
  });

  it('reads game-data bodies beyond the old 2,000-character diagnostic limit', async () => {
    const stub = await makeStub({
      overrides: {
        gameData: {
          Padding: 'x'.repeat(5_000),
          ActorData: [
            {
              InstanceID: 'LARGE-BODY-BASE',
              Type: 'PalBox',
              GuildName: 'Large Body Guild',
              LocationX: 1,
              LocationY: 2,
            },
          ],
        },
      },
    });

    const bases = await clientFor(stub).guildBases();
    assert.equal(bases[0]?.guildName, 'Large Body Guild');
  });

  it('rejects game-data responses without ActorData as invalid', async () => {
    const stub = await makeStub({ overrides: { gameData: { Time: 'now' } } });
    const error = await assertPalworldError(() => clientFor(stub).guildBases(), 'invalid_response');
    assert.match(error.message, /ActorData/);
  });

  it('drops player rows with no userId, which could never be actioned', async () => {
    const stub = await makeStub({
      handler: ({ res, path }) => {
        if (path === '/players') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              players: [
                { name: 'Valid', userId: 'U1', level: 1 },
                { name: 'Missing userId' },
                { name: 'Null userId', userId: null },
                'not-an-object',
              ],
            }),
          );
          return;
        }
        res.writeHead(404).end();
      },
    });

    const players = await clientFor(stub).players();
    assert.equal(players.length, 1);
    assert.equal(players[0]?.name, 'Valid');
  });

  it('fills sane defaults for missing player fields instead of throwing', async () => {
    const stub = await makeStub({
      handler: ({ res, path }) => {
        if (path === '/players') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ players: [{ userId: 'U1' }] }));
          return;
        }
        res.writeHead(404).end();
      },
    });

    const players = await clientFor(stub).players();
    assert.equal(players.length, 1);
    assert.equal(players[0]?.name, 'Unknown');
    assert.equal(players[0]?.ping, 0);
    assert.equal(players[0]?.level, 0);
  });

  it('normalises the legacy `serveruptime` field into `uptime`', async () => {
    const stub = await makeStub({
      handler: ({ res, path }) => {
        if (path === '/metrics') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ serveruptime: 999, currentplayernum: 3 }));
          return;
        }
        res.writeHead(404).end();
      },
    });

    const metrics = await clientFor(stub).metrics();
    assert.equal(metrics.uptime, 999);
    assert.equal(metrics.currentplayernum, 3);
    assert.equal(metrics.serverfps, 0, 'absent fields default to zero');
  });

  it('sends HTTP Basic auth with the configured credentials', async () => {
    const stub = await makeStub({ username: 'admin', password: 'hunter2' });
    await clientFor(stub, { password: 'hunter2' }).info();

    const expected = `Basic ${Buffer.from('admin:hunter2').toString('base64')}`;
    assert.equal(stub.requests[0]?.authorization, expected);
  });
});

describe('game-data normalization', () => {
  it('keeps finite PalBox actors, deduplicates IDs, and creates deterministic fallbacks', () => {
    const bases = normaliseGuildBases({
      ActorData: [
        {
          InstanceID: 'ABC',
          Type: 'PalBox',
          GuildID: 'G-1',
          GuildName: 'Guild One',
          LocationX: '10.5',
          LocationY: 20,
        },
        {
          InstanceID: 'abc',
          Type: 'palbox',
          GuildID: 'G-1',
          GuildName: 'Duplicate',
          LocationX: 99,
          LocationY: 99,
        },
        { Type: 'PalBox', GuildID: 'G-2', LocationX: 30, LocationY: 40 },
        { Type: 'Character', GuildName: 'Ignored', LocationX: 1, LocationY: 2 },
        { Type: 'PalBox', GuildName: 'Bad X', LocationX: 'NaN', LocationY: 2 },
        { Type: 'PalBox', GuildName: 'Bad Y', LocationX: 1, LocationY: null },
      ],
    });

    assert.ok(bases !== null);
    assert.equal(bases.length, 2);
    assert.deepEqual(
      bases.find((base) => base.id === 'abc'),
      {
        id: 'abc',
        guildId: 'G-1',
        guildName: 'Guild One',
        location_x: 10.5,
        location_y: 20,
      },
    );
    const fallback = bases.find((base) => base.guildId === 'G-2');
    assert.equal(fallback?.guildName, 'Unknown guild');
    assert.equal(fallback?.id, 'base:g-2:30:40');
  });

  it('distinguishes malformed envelopes from a valid empty snapshot', () => {
    assert.equal(normaliseGuildBases(null), null);
    assert.equal(normaliseGuildBases({}), null);
    assert.deepEqual(normaliseGuildBases({ ActorData: [] }), []);
  });
});

describe('PalworldClient error mapping', () => {
  it('maps 401 to a credential hint', async () => {
    const stub = await makeStub();
    const error = await assertPalworldError(
      () => clientFor(stub, { password: 'wrong' }).info(),
      'unauthorized',
    );
    assert.match(error.message, /PALSERVER_ADMIN_PASSWORD/);
    assert.equal(error.status, 401);
    assert.equal(error.apiCode, 'palworld_error');
    assert.equal(error.retryable, false);
  });

  it('maps 400 to bad_request', async () => {
    const stub = await makeStub({
      handler: ({ res }) => {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end('bad body');
      },
    });
    const error = await assertPalworldError(() => clientFor(stub).announce('hi'), 'bad_request');
    assert.equal(error.httpStatus, 400);
    assert.match(error.message, /bad body/);
  });

  it('maps 404 to a version/port hint', async () => {
    const stub = await makeStub({
      handler: ({ res }) => {
        res.writeHead(404).end();
      },
    });
    const error = await assertPalworldError(() => clientFor(stub).info(), 'not_found');
    assert.match(error.message, /RESTAPIPort/);
    assert.equal(error.httpStatus, 404);
  });

  it('maps 500 to server_error and marks it retryable', async () => {
    const stub = await makeStub({
      handler: ({ res }) => {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('unavailable');
      },
    });
    const error = await assertPalworldError(() => clientFor(stub).info(), 'server_error');
    assert.equal(error.retryable, true);
    assert.equal(error.status, 503);
  });

  it('maps connection refused to unreachable, not a generic failure', async () => {
    const port = await findClosedPort();
    const client = new PalworldClient(
      makeConfig({ apiBaseUrl: `http://127.0.0.1:${port}/v1/api` }),
      logger,
    );
    const error = await assertPalworldError(() => client.info(), 'unreachable');
    assert.equal(error.apiCode, 'unreachable');
    assert.equal(error.httpStatus, 502);
    assert.match(error.message, /Connection refused/);
    assert.match(error.message, /RESTAPIEnabled/, 'tells the operator what to check');
  });

  it('maps a slow response to timeout', async () => {
    const stub = await makeStub({ delayMs: 400 });
    const client = clientFor(stub, { timeoutMs: 50 });
    const error = await assertPalworldError(() => client.info(), 'timeout');
    assert.equal(error.httpStatus, 504);
    assert.equal(error.apiCode, 'timeout');
    assert.equal(error.retryable, true);
  });

  it('maps a JSON body that is not an object to invalid_response', async () => {
    const stub = await makeStub({
      handler: ({ res, path }) => {
        if (path === '/info') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html>this is a web server, not the Palworld API</html>');
          return;
        }
        res.writeHead(404).end();
      },
    });
    const error = await assertPalworldError(() => clientFor(stub).info(), 'invalid_response');
    assert.match(error.message, /not the Palworld REST API/);
  });

  it('rejects a successful response whose advertised body exceeds the endpoint limit', async () => {
    const stub = await makeStub({
      handler: ({ res, path }) => {
        if (path === '/game-data') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Length': String(MAX_GAME_DATA_RESPONSE_BYTES + 1),
          });
          res.end('{}');
          return;
        }
        res.writeHead(404).end();
      },
    });

    const error = await assertPalworldError(() => clientFor(stub).guildBases(), 'invalid_response');
    assert.match(error.message, /safety limit/);
  });

  it('returns an empty player list for a malformed /players body rather than throwing', async () => {
    const stub = await makeStub({
      handler: ({ res, path }) => {
        if (path === '/players') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{not json');
          return;
        }
        res.writeHead(404).end();
      },
    });
    assert.deepEqual(await clientFor(stub).players(), []);
  });
});

describe('PalworldClient writes', () => {
  it('POSTs /announce with the message', async () => {
    const stub = await makeStub();
    await clientFor(stub).announce('Server restarting soon');

    const [request] = stub.requestsFor('/announce');
    assert.equal(request?.method, 'POST');
    assert.deepEqual(JSON.parse(request?.body ?? '{}'), { message: 'Server restarting soon' });
    assert.equal(request?.contentType, 'application/json');
  });

  it('POSTs /kick omitting an empty message', async () => {
    const stub = await makeStub();
    const client = clientFor(stub);

    await client.kick('USER-1');
    assert.deepEqual(JSON.parse(stub.requestsFor('/kick')[0]?.body ?? '{}'), { userid: 'USER-1' });

    await client.kick('USER-2', 'Please read the rules');
    assert.deepEqual(JSON.parse(stub.requestsFor('/kick')[1]?.body ?? '{}'), {
      userid: 'USER-2',
      message: 'Please read the rules',
    });
  });

  it('POSTs /ban with the userid and message', async () => {
    const stub = await makeStub();
    await clientFor(stub).ban('USER-9', 'cheating');
    assert.deepEqual(JSON.parse(stub.requestsFor('/ban')[0]?.body ?? '{}'), {
      userid: 'USER-9',
      message: 'cheating',
    });
  });

  it('POSTs /unban with only the userid', async () => {
    const stub = await makeStub();
    await clientFor(stub).unban('USER-9');
    assert.deepEqual(JSON.parse(stub.requestsFor('/unban')[0]?.body ?? '{}'), { userid: 'USER-9' });
  });

  it('POSTs /save with an empty object', async () => {
    const stub = await makeStub();
    await clientFor(stub).save();
    assert.equal(stub.requestsFor('/save')[0]?.method, 'POST');
    assert.deepEqual(JSON.parse(stub.requestsFor('/save')[0]?.body ?? '{}'), {});
  });

  it('POSTs /shutdown with waittime and message', async () => {
    const stub = await makeStub();
    await clientFor(stub).shutdown(30, 'Back in a minute');
    assert.deepEqual(JSON.parse(stub.requestsFor('/shutdown')[0]?.body ?? '{}'), {
      waittime: 30,
      message: 'Back in a minute',
    });
  });

  it('POSTs /stop with an empty JSON object so no server rejects a bodyless POST', async () => {
    const stub = await makeStub();
    await clientFor(stub).stop();
    const [request] = stub.requestsFor('/stop');
    assert.equal(request?.method, 'POST');
    assert.equal(request?.contentType, 'application/json');
    assert.deepEqual(JSON.parse(request?.body ?? '{}'), {});
  });

  it('reports latency for a write', async () => {
    const stub = await makeStub();
    const meta = await clientFor(stub).save();
    assert.equal(meta.status, 200);
    assert.ok(meta.latencyMs >= 0);
  });
});

describe('PalworldClient caching', () => {
  it('collapses concurrent identical reads into one upstream request', async () => {
    const stub = await makeStub({ delayMs: 60 });
    const client = clientFor(stub);

    const results = await Promise.all([
      client.info(),
      client.info(),
      client.info(),
      client.info(),
      client.info(),
    ]);

    assert.equal(
      stub.requestsFor('/info').length,
      1,
      'single-flight should dedupe concurrent calls',
    );
    for (const result of results) {
      assert.deepEqual(result, FIXTURES.info, 'every caller receives the same parsed value');
    }
  });

  it('serves a cached read within the TTL', async () => {
    const stub = await makeStub();
    const client = clientFor(stub);

    await client.info();
    await client.info();
    await client.info();

    assert.equal(stub.requestsFor('/info').length, 1);
  });

  it('caches the normalized game-data base snapshot independently', async () => {
    const stub = await makeStub();
    const client = clientFor(stub);

    const first = await client.guildBases();
    const second = await client.guildBases();

    assert.strictEqual(second, first, 'the compact normalized snapshot is the cached value');
    assert.equal(stub.requestsFor('/game-data').length, 1);
  });

  it('refetches after the TTL expires', async () => {
    const stub = await makeStub();
    const client = clientFor(stub);

    await client.metrics(); // 1s TTL
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await client.metrics();

    assert.equal(stub.requestsFor('/metrics').length, 2);
  });

  it('bypasses the cache when forced', async () => {
    const stub = await makeStub();
    const client = clientFor(stub);

    await client.info();
    await client.info({ force: true });

    assert.equal(stub.requestsFor('/info').length, 2);
  });

  it('does not cache failures, so recovery is noticed on the next poll', async () => {
    let calls = 0;
    const stub = await makeStub({
      handler: ({ res, path }) => {
        if (path !== '/info') {
          res.writeHead(404).end();
          return;
        }
        calls += 1;
        if (calls === 1) {
          res.writeHead(500).end('boom');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(FIXTURES.info));
      },
    });

    const client = clientFor(stub);
    await assertPalworldError(() => client.info(), 'server_error');
    const info = await client.info();
    assert.deepEqual(info, FIXTURES.info);
    assert.equal(calls, 2);
  });

  it('invalidates read caches after a write so the next poll is fresh', async () => {
    const stub = await makeStub();
    const client = clientFor(stub);

    await client.info();
    assert.equal(stub.requestsFor('/info').length, 1);

    await client.save();

    await client.info();
    assert.equal(
      stub.requestsFor('/info').length,
      2,
      'a write must not leave a stale snapshot behind',
    );
  });

  it('caches each endpoint independently', async () => {
    const stub = await makeStub();
    const client = clientFor(stub);

    await client.info();
    await client.players();
    await client.metrics();
    await client.settings();
    await client.info();
    await client.players();

    assert.equal(stub.requestsFor('/info').length, 1);
    assert.equal(stub.requestsFor('/players').length, 1);
    assert.equal(stub.requestsFor('/metrics').length, 1);
    assert.equal(stub.requestsFor('/settings').length, 1);
  });
});

describe('PalworldClient.probe', () => {
  it('reports reachable with info when the server answers', async () => {
    const stub = await makeStub();
    const result = await clientFor(stub).probe();
    assert.equal(result.reachable, true);
    if (result.reachable) {
      assert.deepEqual(result.info, FIXTURES.info);
      assert.ok(result.latencyMs >= 0);
    }
  });

  it('reports unreachable without throwing when the server is down', async () => {
    const port = await findClosedPort();
    const client = new PalworldClient(
      makeConfig({ apiBaseUrl: `http://127.0.0.1:${port}/v1/api` }),
      logger,
    );
    const result = await client.probe();
    assert.equal(result.reachable, false);
    if (!result.reachable) {
      assert.equal(result.error.kind, 'unreachable');
    }
  });

  it('bypasses the cache so restart detection is immediate', async () => {
    const stub = await makeStub();
    const client = clientFor(stub);

    await client.info();
    await client.probe();

    assert.equal(stub.requestsFor('/info').length, 2);
  });
});

describe('PalworldClient configuration handling', () => {
  it('rejects a host that answers with a non-JSON 200 for /info', async () => {
    // A plain web server on the REST API port is a realistic misconfiguration.
    const decoy = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('hello from some other service');
    });
    await new Promise<void>((resolve) => decoy.listen(0, '127.0.0.1', resolve));
    const address = decoy.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    try {
      const client = new PalworldClient(
        makeConfig({ apiBaseUrl: `http://127.0.0.1:${port}/v1/api` }),
        logger,
      );
      await assertPalworldError(() => client.info(), 'invalid_response');
    } finally {
      decoy.closeAllConnections();
      await new Promise<void>((resolve) => decoy.close(() => resolve()));
    }
  });
});
