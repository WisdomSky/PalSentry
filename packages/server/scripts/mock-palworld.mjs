#!/usr/bin/env node
/**
 * A mock Palworld dedicated-server REST API.
 *
 * Purpose: let you run and evaluate PalSentry without a Palworld server, and exercise the restart
 * flow end to end (the mock actually goes offline and comes back, so the state machine has
 * something real to detect).
 *
 * It is a development aid, not a compatibility shim. It implements the documented endpoints with
 * plausible data; it does not simulate game logic.
 *
 * Usage:
 *   node packages/server/scripts/mock-palworld.mjs
 *   MOCK_PORT=8212 MOCK_ADMIN_PASSWORD=secret node packages/server/scripts/mock-palworld.mjs
 *   MOCK_GAME_DATA_ENABLED=false node packages/server/scripts/mock-palworld.mjs # test fallback UI
 *   MOCK_TELEPORT_USER=USER-DAVE MOCK_TELEPORT_EVERY=1 node packages/server/scripts/mock-palworld.mjs
 *   MOCK_DROP_USER=USER-ALICE MOCK_DROP_USER_AFTER_SECONDS=30 node packages/server/scripts/mock-palworld.mjs
 *
 * Then point PalSentry at it:
 *   PALWORLD_REST_URL=http://127.0.0.1:8212
 *   PALWORLD_ADMIN_PASSWORD=secret
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 8212);
const HOST = process.env.MOCK_HOST ?? '127.0.0.1';
const ADMIN_PASSWORD = process.env.MOCK_ADMIN_PASSWORD ?? 'mock-admin-password';
const GAME_DATA_ENABLED = process.env.MOCK_GAME_DATA_ENABLED !== 'false';
const USERNAME = 'admin';
const EXPECTED_AUTH = `Basic ${Buffer.from(`${USERNAME}:${ADMIN_PASSWORD}`).toString('base64')}`;

/**
 * Deterministic QA hooks.
 *
 * The random drift below is fine for eyeballing the map but useless for verifying follow mode, so
 * `MOCK_TELEPORT_USER` pins one player to a fixed route that alternates regions:
 * Palpagos → inland Palpagos → World Tree → northern World Tree, advancing one step every
 * `MOCK_TELEPORT_EVERY` player reads. `MOCK_TELEPORT_EVERY=1` changes every response, which is the
 * quickest way to watch a follow recentre.
 *
 * `MOCK_DROP_USER` + `MOCK_DROP_USER_AFTER_SECONDS` removes a player from the online list while
 * the server itself stays up, so the "tracked player went offline" path can be exercised without
 * stopping the mock.
 */
const TELEPORT_USER = process.env.MOCK_TELEPORT_USER ?? '';
const TELEPORT_EVERY = Math.max(1, Number(process.env.MOCK_TELEPORT_EVERY ?? 3));
const DROP_USER = process.env.MOCK_DROP_USER ?? '';
const DROP_USER_AFTER_SECONDS = Number(process.env.MOCK_DROP_USER_AFTER_SECONDS ?? 0);

/** Alternating Palpagos/World Tree waypoints, in a deliberately non-random order. */
const TELEPORT_ROUTE = [
  { x: -359_583, y: 267_748 },
  { x: -120_000, y: 40_000 },
  { x: 500_000, y: -650_000 },
  { x: 620_000, y: -540_000 },
];

let playerReads = 0;
let teleportStep = -1;

/** Milliseconds the mock stays down after a shutdown, to exercise restart detection. */
const DOWNTIME_MS = Number(process.env.MOCK_DOWNTIME_MS ?? 5_000);

let startedAt = Date.now();
let restarting = false;
let shutdownTimer;
let recoveryTimer;
const worldGuid = 'A7E97BAA767DB9029EF013BB71E993A0';

/** `null` while the "process" is down. */
let offline = null;

/**
 * Fake players that drift around the map so the live map and charts have something to show.
 */
const players = [
  {
    name: 'Alice',
    accountName: 'alice_steam',
    userId: 'USER-ALICE',
    playerId: 'P-1',
    ip: '10.0.0.11',
    ping: 24,
    level: 42,
    buildingCount: 137,
    x: -359_583,
    y: 267_748,
  },
  {
    name: 'Bob',
    accountName: 'bob_xbox',
    userId: 'USER-BOB',
    playerId: 'P-2',
    ip: '10.0.0.12',
    ping: 88,
    level: 17,
    buildingCount: 12,
    x: 120_000,
    y: -45_000,
  },
  {
    name: 'Carol',
    accountName: 'carol_psn',
    userId: 'USER-CAROL',
    playerId: 'P-3',
    ip: '10.0.0.13',
    ping: 145,
    level: 61,
    buildingCount: 402,
    x: -210_000,
    y: -180_000,
  },
  {
    name: 'Dave',
    accountName: 'dave_steam',
    userId: 'USER-DAVE',
    playerId: 'P-4',
    ip: '10.0.0.14',
    ping: 41,
    level: 8,
    buildingCount: 3,
    // World Tree coordinates exercise the second region tab in local development.
    x: 500_000,
    y: -650_000,
  },
];

const gameDataActors = [
  {
    InstanceID: 'BASE-MOSSY-MARSH',
    Type: 'PalBox',
    GuildID: 'GUILD-MOSSY',
    GuildName: 'Mossy Mammoths',
    LocationX: -359_000,
    LocationY: 267_000,
  },
  {
    InstanceID: 'BASE-EMBER-DESERT',
    Type: 'PalBox',
    GuildID: 'GUILD-EMBER',
    GuildName: 'Ember Union',
    LocationX: 120_000,
    LocationY: -45_000,
  },
  {
    InstanceID: 'BASE-FROST-NORTH',
    Type: 'PalBox',
    GuildID: 'GUILD-FROST',
    GuildName: 'Frostbound',
    LocationX: -800_000,
    LocationY: -500_000,
  },
  {
    InstanceID: 'BASE-TREE-ROOTS',
    Type: 'PalBox',
    GuildID: 'GUILD-CANOPY',
    GuildName: 'Canopy Keepers',
    LocationX: 500_000,
    LocationY: -650_000,
  },
  {
    InstanceID: 'BASE-TREE-CROWN',
    Type: 'PalBox',
    GuildID: 'GUILD-CANOPY',
    GuildName: 'Canopy Keepers',
    LocationX: 620_000,
    LocationY: -760_000,
  },
  {
    InstanceID: 'BASE-TREE-WAYFARER',
    Type: 'PalBox',
    GuildID: 'GUILD-WAYFARER',
    GuildName: 'Wayfarers',
    LocationX: 420_000,
    LocationY: -560_000,
  },
  {
    InstanceID: 'CHARACTER-ALICE',
    Type: 'Character',
    UnitType: 'Player',
    NickName: 'Alice',
    GuildID: 'GUILD-MOSSY',
    GuildName: 'Mossy Mammoths',
    LocationX: -359_583,
    LocationY: 267_748,
  },
];

const bannedUserIds = new Set();
const log = (...args) => console.log(`[mock-palworld]`, ...args);

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function uptimeSeconds() {
  return Math.floor((Date.now() - startedAt) / 1000);
}

/** Drift positions by a small random amount on each read, so the map is not frozen. */
function drift() {
  for (const player of players) {
    player.x += (Math.random() - 0.5) * 20_000;
    player.y += (Math.random() - 0.5) * 20_000;
    player.ping = Math.max(5, Math.round(player.ping + (Math.random() - 0.5) * 20));
  }
}

/** Advance the scripted QA route, if one is configured. */
function script() {
  playerReads += 1;
  if (TELEPORT_USER === '' || playerReads % TELEPORT_EVERY !== 0) return;

  teleportStep = (teleportStep + 1) % TELEPORT_ROUTE.length;
  const waypoint = TELEPORT_ROUTE[teleportStep];
  const player = players.find((candidate) => candidate.userId === TELEPORT_USER);
  if (player === undefined || waypoint === undefined) return;

  player.x = waypoint.x;
  player.y = waypoint.y;
}

/** The online roster, minus a QA player that has been scripted to drop out. */
function onlinePlayers() {
  if (DROP_USER === '' || DROP_USER_AFTER_SECONDS <= 0) return players;
  const elapsed = (Date.now() - startedAt) / 1000;
  return elapsed >= DROP_USER_AFTER_SECONDS
    ? players.filter((player) => player.userId !== DROP_USER)
    : players;
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const path = (req.url ?? '/').split('?')[0] ?? '/';

    // The game server is genuinely unreachable while "stopped" — the socket is destroyed rather
    // than answered with an error, which is what a real stopped process does.
    if (offline !== null) {
      log(`${req.method} ${path} → refusing (server is down)`);
      res.destroy();
      return;
    }

    if (req.headers.authorization !== EXPECTED_AUTH) {
      log(`${req.method} ${path} → 401`);
      send(res, 401, { error: 'Unauthorized' });
      return;
    }

    log(`${req.method} ${path}${body === '' ? '' : ` ${body}`}`);

    switch (path) {
      case '/v1/api/info':
        send(res, 200, {
          version: 'v1.0.4-mock',
          servername: 'PalSentry Mock Server',
          description: 'A mock Palworld server for trying out PalSentry.',
          worldguid: worldGuid,
        });
        return;

      case '/v1/api/players':
        drift();
        script();
        send(res, 200, {
          players: onlinePlayers().map((player) => ({
            name: player.name,
            accountName: player.accountName,
            playerId: player.playerId,
            userId: player.userId,
            ip: player.ip,
            ping: player.ping,
            location_x: player.x,
            location_y: player.y,
            level: player.level,
            building_count: player.buildingCount,
          })),
        });
        return;

      case '/v1/api/game-data':
        if (!GAME_DATA_ENABLED) {
          send(res, 404, {
            error: 'Game-data API disabled; start Palworld with -enable-gamedata-api',
          });
          return;
        }
        send(res, 200, { ActorData: gameDataActors });
        return;

      case '/v1/api/metrics':
        send(res, 200, {
          serverfps: 55 + Math.round(Math.random() * 6),
          currentplayernum: players.length,
          serverframetime: 16 + Math.random() * 2,
          maxplayernum: 32,
          uptime: uptimeSeconds(),
          basecampnum: 6,
          days: 132,
        });
        return;

      case '/v1/api/settings':
        send(res, 200, {
          Difficulty: 'None',
          DayTimeSpeedRate: 1,
          NightTimeSpeedRate: 1,
          ExpRate: 1.2,
          PalCaptureRate: 1,
          PalSpawnNumRate: 1,
          DeathPenalty: 'All',
          bEnablePlayerToPlayerDamage: false,
          bEnableFriendlyFire: false,
          bEnableInvaderEnemy: true,
          BaseCampMaxNum: 128,
          BaseCampWorkerMaxNum: 15,
          GuildPlayerMaxNum: 32,
          bAutoResetGuildNoOnlinePlayers: false,
          AutoResetGuildTimeNoOnlinePlayers: 72,
          PalEggDefaultHatchingTime: 1,
          WorkSpeedRate: 1,
          CoopPlayerMaxNum: 4,
          ServerPlayerMaxNum: 32,
          ServerName: 'PalSentry Mock Server',
          ServerDescription: 'A mock Palworld server for trying out PalSentry.',
          PublicPort: 8211,
          PublicIP: '',
          RCONEnabled: false,
          RCONPort: 25575,
          Region: 'EU',
          bUseAuth: true,
          BanListURL: 'https://api.palworldgame.com/api/banlist.txt',
          RESTAPIEnabled: true,
          RESTAPIPort: PORT,
          bShowPlayerList: false,
          AllowConnectPlatform: 'Steam',
          bIsUseBackupSaveData: true,
          LogFormatType: 'Text',
        });
        return;

      case '/v1/api/announce': {
        const parsed = safeParse(body);
        log(`  📢 broadcast: ${parsed?.message ?? '(no message)'}`);
        send(res, 200, {});
        return;
      }

      case '/v1/api/kick': {
        const parsed = safeParse(body);
        log(`  👢 kick: ${parsed?.userid ?? '(no userid)'}`);
        send(res, 200, {});
        return;
      }

      case '/v1/api/ban': {
        const parsed = safeParse(body);
        if (parsed?.userid) bannedUserIds.add(parsed.userid);
        log(`  🔨 ban: ${parsed?.userid ?? '(no userid)'}`);
        send(res, 200, {});
        return;
      }

      case '/v1/api/unban': {
        const parsed = safeParse(body);
        if (parsed?.userid) bannedUserIds.delete(parsed.userid);
        log(`  🕊️  unban: ${parsed?.userid ?? '(no userid)'}`);
        send(res, 200, {});
        return;
      }

      case '/v1/api/save':
        log('  💾 world saved');
        send(res, 200, {});
        return;

      case '/v1/api/shutdown': {
        const parsed = safeParse(body);
        const waittime = Number(parsed?.waittime ?? 0);
        log(`  🛑 shutdown in ${waittime}s — going offline for ${DOWNTIME_MS}ms`);
        send(res, 200, {});
        scheduleRestart(waittime * 1000);
        return;
      }

      case '/v1/api/stop':
        log(`  ☠️  force stop — going offline for ${DOWNTIME_MS}ms`);
        send(res, 200, {});
        scheduleRestart(0);
        return;

      default:
        send(res, 404, { error: 'Not Found' });
    }
  });

  res.on('error', () => {});
  req.on('error', () => {});
});

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Simulate the container restart policy: drop the server, then bring it back.
 *
 * Coming back resets `uptime`, which is exactly the signal PalSentry's restart detector looks for
 * when the downtime is too short to observe.
 */
function scheduleRestart(delayMs) {
  if (restarting) return;
  restarting = true;
  shutdownTimer = setTimeout(() => {
    offline = Date.now();
    recoveryTimer = setTimeout(() => {
      startedAt = Date.now();
      offline = null;
      restarting = false;
      log('  ✅ back online (uptime reset)');
    }, DOWNTIME_MS);
  }, delayMs);
}

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}/v1/api`);
  log(
    `username: ${USERNAME}; password configured via MOCK_ADMIN_PASSWORD (see script for dev default)`,
  );
  log(
    `${players.length} fake players, ${gameDataActors.length - 1} fake bases, game-data ${GAME_DATA_ENABLED ? 'enabled' : 'disabled'}, restart downtime ${DOWNTIME_MS}ms`,
  );
  if (TELEPORT_USER !== '') {
    log(
      `scripted route: ${TELEPORT_USER} teleports every ${TELEPORT_EVERY} player read(s) across ${TELEPORT_ROUTE.length} waypoints`,
    );
  }
  if (DROP_USER !== '' && DROP_USER_AFTER_SECONDS > 0) {
    log(`scripted drop: ${DROP_USER} leaves the roster after ${DROP_USER_AFTER_SECONDS}s`);
  }
  log('point PalSentry at this with PALWORLD_REST_URL=http://127.0.0.1:' + PORT);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('shutting down');
    clearTimeout(shutdownTimer);
    clearTimeout(recoveryTimer);
    server.close(() => process.exit(0));
  });
}
