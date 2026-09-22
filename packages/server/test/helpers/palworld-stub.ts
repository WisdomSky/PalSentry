import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A minimal stand-in for the Palworld dedicated-server REST API.
 *
 * Backed by a real `node:http` server rather than a fetch mock, so the client under test
 * exercises genuine sockets, real `fetch` behaviour, actual abort signals, and real connection
 * failures. That matters here because most of this client's complexity is error classification,
 * and a mocked `fetch` would never produce the `ECONNREFUSED` / `TimeoutError` shapes it handles.
 */

export interface RecordedRequest {
  method: string;
  /** Path after `/v1/api`, e.g. `/players`. */
  path: string;
  /** Raw request body. */
  body: string;
  authorization: string | undefined;
  contentType: string | undefined;
}

export interface StubContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  path: string;
  body: string;
  /** Parsed JSON body, or null when the body was absent or malformed. */
  json: unknown;
}

export type StubHandler = (context: StubContext) => void | Promise<void>;

export interface StubOptions {
  username?: string;
  password?: string;
  /** Handle every request yourself. Defaults to serving the fixtures below. */
  handler?: StubHandler;
  /** Delay every response by this many milliseconds (used to provoke timeouts). */
  delayMs?: number;
  /** Replace individual default fixtures without taking over routing entirely. */
  overrides?: {
    info?: unknown;
    players?: unknown;
    metrics?: unknown;
    settings?: unknown;
    gameData?: unknown;
  };
}

export interface PalworldStub {
  /** Base URL including the `/v1/api` suffix the client expects. */
  baseUrl: string;
  requests: RecordedRequest[];
  /** Requests recorded against a specific path, e.g. `/kick`. */
  requestsFor(path: string): RecordedRequest[];
  /**
   * Replace what `/players` reports for the rest of the run.
   *
   * An array makes the endpoint answer with those players (an empty array is a successful "nobody
   * is online"); `null` makes it answer `503`, which is how a game server that is down looks to
   * the client. Tests that care about a roster change over time need to flip this between reads.
   */
  setPlayers(players: readonly unknown[] | null): void;
  close(): Promise<void>;
}

/** Documented default fixtures. */
export const FIXTURES = {
  info: {
    version: 'v0.1.5.0',
    servername: 'Palworld example Server',
    description: 'This is a Palworld server.',
    worldguid: 'A7E97BAA767DB9029EF013BB71E993A0',
  },
  players: {
    players: [
      {
        name: 'Alice',
        accountName: 'alice_steam',
        playerId: 'PLAYER-1',
        userId: 'USER-1',
        ip: '10.0.0.11',
        ping: 24.5,
        location_x: -359583,
        location_y: 267748.59375,
        level: 42,
        building_count: 137,
      },
      {
        name: 'Bob',
        accountName: 'bob_xbox',
        playerId: 'PLAYER-2',
        userId: 'USER-2',
        ip: '10.0.0.12',
        ping: 88,
        location_x: 120000,
        location_y: -45000,
        level: 7,
        building_count: 3,
      },
    ],
  },
  metrics: {
    serverfps: 58,
    currentplayernum: 2,
    serverframetime: 17.2,
    maxplayernum: 32,
    uptime: 54321,
    basecampnum: 5,
    days: 132,
  },
  settings: {
    Difficulty: 'None',
    ExpRate: 1.2,
    bEnablePlayerToPlayerDamage: false,
    ServerName: 'Pals',
  },
  gameData: {
    Time: '2026-09-21 12:00:00',
    ActorData: [
      {
        InstanceID: 'BASE-PALPAGOS-1',
        Type: 'PalBox',
        GuildID: 'GUILD-BUILDERS',
        GuildName: 'The Builders',
        LocationX: -359_583,
        LocationY: 267_748.59375,
      },
      {
        InstanceID: 'BASE-WORLD-TREE-1',
        Type: 'PalBox',
        GuildID: 'GUILD-EXPLORERS',
        GuildName: 'Tree Explorers',
        LocationX: 500_000,
        LocationY: -650_000,
      },
      {
        InstanceID: 'WORKER-IGNORED',
        Type: 'Character',
        UnitType: 'BaseCampPal',
        GuildID: 'GUILD-BUILDERS',
        NickName: 'Anubis',
        LocationX: -359_500,
        LocationY: 267_700,
      },
    ],
  },
} as const;

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

/** Start the stub on an ephemeral port. */
export async function startPalworldStub(options: StubOptions = {}): Promise<PalworldStub> {
  const username = options.username ?? 'admin';
  const password = options.password ?? 'test-password';
  const requests: RecordedRequest[] = [];
  /** Mutable `/players` response, so a running app can watch the roster change. */
  let playersResponse: { status: number; body: unknown } = {
    status: 200,
    body: options.overrides?.players ?? FIXTURES.players,
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const fullPath = req.url ?? '/';
        // Strip the /v1/api prefix so handlers can route on the documented endpoint names.
        const path = fullPath.replace(/^\/v1\/api/, '').split('?')[0] ?? '/';

        requests.push({
          method: req.method ?? 'GET',
          path,
          body,
          authorization: req.headers.authorization,
          contentType: req.headers['content-type'],
        });

        if (options.delayMs !== undefined && options.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        }

        try {
          if (options.handler !== undefined) {
            await options.handler({ req, res, path, body, json: safeParse(body) });
            return;
          }

          const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
          if (req.headers.authorization !== expected) {
            sendJson(res, 401, { error: 'Unauthorized' });
            return;
          }

          switch (path) {
            case '/info':
              sendJson(res, 200, options.overrides?.info ?? FIXTURES.info);
              return;
            case '/players':
              sendJson(res, playersResponse.status, playersResponse.body);
              return;
            case '/metrics':
              sendJson(res, 200, options.overrides?.metrics ?? FIXTURES.metrics);
              return;
            case '/settings':
              sendJson(res, 200, options.overrides?.settings ?? FIXTURES.settings);
              return;
            case '/game-data':
              sendJson(res, 200, options.overrides?.gameData ?? FIXTURES.gameData);
              return;
            case '/announce':
            case '/kick':
            case '/ban':
            case '/unban':
            case '/save':
            case '/shutdown':
            case '/stop':
              sendJson(res, 200, { ok: true });
              return;
            default:
              sendJson(res, 404, { error: 'Not Found' });
          }
        } catch (error) {
          if (!res.headersSent) {
            sendJson(res, 500, { error: String(error) });
          }
        }
      })();
    });

    // Aborted requests (client timeouts) surface as a socket error; ignore it.
    res.on('error', () => {});
    req.on('error', () => {});
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1/api`,
    requests,
    requestsFor: (path: string) => requests.filter((entry) => entry.path === path),
    setPlayers: (players: readonly unknown[] | null) => {
      playersResponse =
        players === null
          ? { status: 503, body: { error: 'Server is not running' } }
          : { status: 200, body: { players } };
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function safeParse(text: string): unknown {
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Reserve a port and immediately release it, yielding an address nothing is listening on. */
export async function findClosedPort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => {
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return address.port;
}
