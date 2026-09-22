#!/usr/bin/env node
/**
 * End-to-end smoke test.
 *
 * Boots the mock Palworld API and the *built* PalSentry server as real child processes, then
 * exercises the whole stack over HTTP: authentication, every read endpoint, every action, the
 * restart state machine, and the SPA fallback.
 *
 * This complements the unit tests, which use `app.inject()` and never touch a real socket. Here
 * everything is real: two processes, real ports, real cookies, real network failures.
 *
 * Usage (after `npm run build`):
 *   node packages/server/scripts/smoke-test.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const repoRoot = path.resolve(serverRoot, '..', '..');

const MOCK_PORT = 18212;
const APP_PORT = 13000;
const PALWORLD_PASSWORD = 'smoke-palworld-password';
const APP_USERNAME = 'admin';
const APP_PASSWORD = 'smoke-palsentry-password';
const SESSION_SECRET = 'smoke-test-session-secret-at-least-32-chars';
const smokeDataDir = mkdtempSync(path.join(tmpdir(), 'palsentry-smoke-'));

const results = [];
let mockProcess = null;
let appProcess = null;

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const icon = ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m';
  console.log(`${icon} ${name}${detail === '' ? '' : ` — ${detail}`}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, detail ?? '');
    return true;
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
    return false;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll a URL until it answers, so we do not race process startup. */
async function waitForHttp(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return true;
    } catch {
      // Not up yet.
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${url}`);
}

/** A minimal cookie-aware client, so the session flow is exercised for real. */
function createClient(baseUrl) {
  let cookie = null;

  async function request(pathname, options = {}) {
    const response = await fetch(`${baseUrl}${pathname}`, {
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie === null ? {} : { Cookie: cookie }),
        ...options.headers,
      },
      redirect: 'manual',
    });

    const setCookie = response.headers.getSetCookie?.() ?? [];
    for (const entry of setCookie) {
      const [pair] = entry.split(';');
      if (pair?.startsWith('palsentry_session=')) cookie = pair;
    }

    const text = await response.text();
    let body = null;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      body = text;
    }

    return { status: response.status, body, text, headers: response.headers };
  }

  return {
    get: (pathname) => request(pathname),
    post: (pathname, payload = {}) =>
      request(pathname, { method: 'POST', body: JSON.stringify(payload) }),
    del: (pathname) => request(pathname, { method: 'DELETE' }),
    hasCookie: () => cookie !== null,
    clearCookie: () => {
      cookie = null;
    },
  };
}

function startProcess(name, command, args, env) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`\n[${name}] exited with code ${code}\n${output.join('')}\n`);
    }
  });

  return child;
}

async function main() {
  const entry = path.join(serverRoot, 'dist', 'index.js');
  if (!existsSync(entry)) {
    console.error(`\nBuilt server not found at ${entry}\nRun \`npm run build\` first.\n`);
    process.exit(1);
  }

  console.log('\nStarting mock Palworld API and PalSentry…\n');

  mockProcess = startProcess(
    'mock-palworld',
    process.execPath,
    [path.join(serverRoot, 'scripts', 'mock-palworld.mjs')],
    {
      MOCK_PORT: String(MOCK_PORT),
      MOCK_ADMIN_PASSWORD: PALWORLD_PASSWORD,
      MOCK_DOWNTIME_MS: '3000',
      // Carol leaves mid-run while the mock stays up, so the roster has something to remember.
      MOCK_DROP_USER: 'USER-CAROL',
      MOCK_DROP_USER_AFTER_SECONDS: '5',
    },
  );

  appProcess = startProcess('palsentry', process.execPath, [entry], {
    NODE_ENV: 'production',
    PALSENTRY_PORT: String(APP_PORT),
    PALSENTRY_HOST: '127.0.0.1',
    PALWORLD_REST_URL: `http://127.0.0.1:${MOCK_PORT}`,
    PALWORLD_ADMIN_PASSWORD: PALWORLD_PASSWORD,
    PALSENTRY_LOGIN_USERNAME: APP_USERNAME,
    PALSENTRY_LOGIN_PASSWORD: APP_PASSWORD,
    PALSENTRY_SESSION_SECRET: SESSION_SECRET,
    PALSENTRY_ALLOW_DESTRUCTIVE: 'true',
    PALSENTRY_SAMPLE_INTERVAL_SECONDS: '5',
    PALSENTRY_RESTART_POLL_INTERVAL_MS: '500',
    PALSENTRY_DB_PATH: path.join(smokeDataDir, 'palsentry.db'),
    LOG_LEVEL: 'warn',
  });

  await waitForHttp(`http://127.0.0.1:${APP_PORT}/api/health`);
  const app = createClient(`http://127.0.0.1:${APP_PORT}`);

  // ---------------------------------------------------------------- public
  await check('GET /api/health works without a session', async () => {
    const { status, body } = await app.get('/api/health');
    if (status !== 200) throw new Error(`status ${status}`);
    if (body?.status !== 'ok') throw new Error('unexpected body');
    return `version ${body.version}`;
  });

  await check('protected endpoints reject unauthenticated requests', async () => {
    for (const pathname of [
      '/api/status',
      '/api/players',
      '/api/bases',
      '/api/bans',
      '/api/audit',
      '/api/settings',
      '/api/history',
    ]) {
      const { status } = await app.get(pathname);
      if (status !== 401) throw new Error(`${pathname} returned ${status}, expected 401`);
    }
    return 'status, players, bases, bans, audit, settings, history all 401';
  });

  // ------------------------------------------------------------------ auth
  await check('login rejects a wrong password', async () => {
    const { status } = await app.post('/api/auth/login', {
      username: APP_USERNAME,
      password: 'wrong-password',
    });
    if (status !== 401) throw new Error(`status ${status}`);
    return '401';
  });

  await check('login sets a session cookie', async () => {
    const { status } = await app.post('/api/auth/login', {
      username: APP_USERNAME,
      password: APP_PASSWORD,
    });
    if (status !== 200) throw new Error(`status ${status}`);
    if (!app.hasCookie()) throw new Error('no session cookie was set');
    return 'signed in';
  });

  await check('GET /api/auth/me identifies the session', async () => {
    const { body } = await app.get('/api/auth/me');
    if (body?.authenticated !== true) throw new Error('not authenticated');
    return body.user.username;
  });

  // ----------------------------------------------------------- capabilities
  await check('GET /api/meta reports capabilities', async () => {
    const { status, body } = await app.get('/api/meta');
    if (status !== 200) throw new Error(`status ${status}`);
    if (body.destructiveAllowed !== true) throw new Error('destructive actions should be enabled');
    const mapMode = body.map.layers?.palpagos?.textureUrl === null ? 'grids' : 'textures';
    return `map=${mapMode}, poll=${body.polling.defaultIntervalMs}ms`;
  });

  // ------------------------------------------------------------------ reads
  await check('GET /api/status returns live server info', async () => {
    const { status, body } = await app.get('/api/status');
    if (status !== 200) throw new Error(`status ${status}`);
    if (!body.online) throw new Error(`offline: ${body.error?.message}`);
    return `${body.info.servername}, ${body.metrics.currentplayernum} players, ${body.metrics.serverfps}fps`;
  });

  await check('GET /api/players lists the roster with online state', async () => {
    const { status, body } = await app.get('/api/players');
    if (status !== 200) throw new Error(`status ${status}`);
    if (body.online !== true) throw new Error('the roster was not refreshed from the game server');
    if (body.players.length !== 4)
      throw new Error(`expected the mock's 4 players, got ${body.players.length}`);

    // Every row is either fully described (online) or explicitly stripped of session data. The
    // mock drops a player part-way through this run, so the online count is not asserted exactly.
    for (const player of body.players) {
      if (typeof player.userId !== 'string' || player.userId === '')
        throw new Error('a roster row has no userId');
      if (typeof player.lastOnline !== 'string' || player.lastOnline === '')
        throw new Error(`${player.name} has no last-online timestamp`);
      if (player.online && !(typeof player.ip === 'string' && typeof player.ping === 'number'))
        throw new Error(`${player.name} is online but has no session details`);
      if (!player.online && (player.ip !== null || player.ping !== null))
        throw new Error(`${player.name} is offline but still reports session details`);
    }

    const online = body.players.filter((player) => player.online === true).length;
    return `${body.players.length} remembered, ${online} online`;
  });

  await check('a player who disconnects stays in the roster', async () => {
    // The mock removes a player from `/players` while staying up, which is the only way this is
    // observable end to end. Poll rather than sleeping a fixed amount, so a slow machine cannot
    // turn a timing race into a false failure.
    const deadline = Date.now() + 20_000;
    let offline = [];

    while (Date.now() < deadline) {
      const { body } = await app.get('/api/players');
      if (body.online !== true) throw new Error('the game server was not reachable');
      if (body.players.length !== 4) {
        throw new Error(`the roster shrank from 4 to ${body.players.length}`);
      }
      offline = body.players.filter((player) => player.online === false);
      if (offline.length > 0) break;
      await sleep(500);
    }

    if (offline.length === 0)
      throw new Error('the disconnected player was dropped from the roster');

    for (const player of offline) {
      if (player.ip !== null || player.ping !== null || player.building_count !== null)
        throw new Error(`${player.name} is offline but still reports session details`);
      if (typeof player.location_x !== 'number' || typeof player.location_y !== 'number')
        throw new Error(`${player.name} lost their last known position`);
    }

    return `${offline.map((player) => player.name).join(', ')} kept with last known positions`;
  });

  await check('GET /api/bases lists normalized guild bases', async () => {
    const { status, body } = await app.get('/api/bases');
    if (status !== 200) throw new Error(`status ${status}`);
    if (body.available !== true) throw new Error(`unavailable: ${body.error?.message}`);
    if (body.bases.length !== 6) throw new Error(`expected 6 bases, got ${body.bases.length}`);
    const guilds = new Set(body.bases.map((base) => base.guildName));
    if (!guilds.has('Canopy Keepers') || !guilds.has('Mossy Mammoths')) {
      throw new Error('expected guild names were not normalized');
    }
    return `${body.bases.length} bases across ${guilds.size} guilds`;
  });

  await check('GET /api/settings returns the settings dump', async () => {
    const { status, body } = await app.get('/api/settings');
    if (status !== 200) throw new Error(`status ${status}`);
    if (body.settings.ServerName === undefined) throw new Error('missing ServerName');
    return `${Object.keys(body.settings).length} keys`;
  });

  await check('GET /api/history returns a series once sampled', async () => {
    // The poller samples every 5s in this run; give it a moment to produce a point.
    await sleep(1_200);
    const { status, body } = await app.get('/api/history?window=1h');
    if (status !== 200) throw new Error(`status ${status}`);
    if (!Array.isArray(body.samples)) throw new Error('no samples array');
    if (body.selection?.kind !== 'window' || body.selection.window !== '1h') {
      throw new Error(`unexpected selection ${JSON.stringify(body.selection)}`);
    }
    if (!(body.to > body.from)) throw new Error('effective bounds are not ordered');
    return `${body.samples.length} bucket(s), ${body.bucketSeconds}s each`;
  });

  await check('GET /api/history serves every Metrics series', async () => {
    const { status, body } = await app.get('/api/history?window=1h');
    if (status !== 200) throw new Error(`status ${status}`);
    const sample = body.samples?.[0];
    if (sample === undefined) throw new Error('expected at least one sample');

    for (const field of ['currentplayernum', 'serverfps', 'basecampnum', 'serverframetime']) {
      if (typeof sample[field] !== 'number') throw new Error(`sample.${field} is not a number`);
    }
    return 'currentplayernum, serverfps, basecampnum, serverframetime';
  });

  await check('GET /api/history accepts a custom range', async () => {
    const now = Math.floor(Date.now() / 1000);
    const from = now - 1_800;
    const { status, body } = await app.get(`/api/history?from=${from}&to=${now}`);
    if (status !== 200) throw new Error(`status ${status}`);
    if (body.selection?.kind !== 'range') throw new Error('selection was not a range');
    if (body.selection.from !== from || body.selection.to !== now) {
      throw new Error('the response did not echo the requested bounds');
    }
    if (body.window !== null) throw new Error('window should be null for a custom range');
    if (body.from !== from || body.to !== now) throw new Error('effective bounds drifted');
    return `range ${body.from}–${body.to}, ${body.bucketSeconds}s buckets`;
  });

  await check('GET /api/history rejects an invalid window', async () => {
    const { status } = await app.get('/api/history?window=forever');
    if (status !== 400) throw new Error(`status ${status}`);
    return '400';
  });

  await check('GET /api/history rejects malformed ranges', async () => {
    const now = Math.floor(Date.now() / 1000);
    const cases = {
      mixed: `/api/history?window=6h&from=${now - 60}&to=${now}`,
      'from only': `/api/history?from=${now - 60}`,
      'to only': `/api/history?to=${now}`,
      reversed: `/api/history?from=${now}&to=${now - 60}`,
      fractional: `/api/history?from=${now - 60}.5&to=${now}`,
    };

    for (const [label, pathname] of Object.entries(cases)) {
      const { status, body } = await app.get(pathname);
      if (status !== 400) throw new Error(`${label} returned ${status}, expected 400`);
      if (body?.error?.code !== 'validation')
        throw new Error(`${label} was not a validation error`);
    }
    return Object.keys(cases).join(', ');
  });

  await check('GET /api/history caps a range at the retention period', async () => {
    const now = Math.floor(Date.now() / 1000);
    // Read the limit from the running server rather than assuming the default.
    const meta = await app.get('/api/meta');
    const days = Number(meta.body?.history?.retentionDays ?? 30);
    const { status, body } = await app.get(
      `/api/history?from=${now - (days + 1) * 86_400}&to=${now}`,
    );
    if (status !== 400) throw new Error(`status ${status}`);
    if (body?.error?.code !== 'validation') throw new Error('not a validation error');
    return `rejected a ${days + 1}-day range`;
  });

  // ---------------------------------------------------------------- actions
  await check('POST /api/actions/announce broadcasts a message', async () => {
    const { status, body } = await app.post('/api/actions/announce', {
      message: 'Smoke test message',
    });
    if (status !== 200) throw new Error(`status ${status}`);
    if (body.ok !== true) throw new Error('not ok');
    return body.message;
  });

  await check('POST /api/actions/announce rejects an empty message', async () => {
    const { status } = await app.post('/api/actions/announce', { message: '   ' });
    if (status !== 400) throw new Error(`status ${status}`);
    return '400';
  });

  await check('POST /api/actions/save saves the world', async () => {
    const { status } = await app.post('/api/actions/save');
    if (status !== 200) throw new Error(`status ${status}`);
    return '200';
  });

  let bannedUserid = null;
  await check('POST /api/actions/ban bans a player and records it', async () => {
    const players = await app.get('/api/players');
    const target = players.body.players.find((player) => player.name === 'Bob');
    if (target === undefined) throw new Error('Bob was not online');
    bannedUserid = target.userId;

    const { status, body } = await app.post('/api/actions/ban', {
      userid: target.userId,
      playerName: target.name,
      reason: 'smoke test',
    });
    if (status !== 200) throw new Error(`status ${status}: ${JSON.stringify(body)}`);

    const bans = await app.get('/api/bans');
    if (bans.body.bans.length === 0) throw new Error('ban was not recorded in the registry');
    return `banned ${target.name}`;
  });

  await check('banned players are flagged in the player list', async () => {
    const { body } = await app.get('/api/players');
    const bob = body.players.find((player) => player.userId === bannedUserid);
    if (bob?.banned !== true) throw new Error('Bob is not flagged as banned');
    return `reason: ${bob.banReason}`;
  });

  await check('POST /api/actions/kick kicks a player', async () => {
    const { status } = await app.post('/api/actions/kick', {
      userid: 'USER-ALICE',
      message: 'smoke test',
    });
    if (status !== 200) throw new Error(`status ${status}`);
    return '200';
  });

  await check('POST /api/actions/unban lifts the ban', async () => {
    const { status } = await app.post('/api/actions/unban', { userid: bannedUserid });
    if (status !== 200) throw new Error(`status ${status}`);

    const bans = await app.get('/api/bans');
    const active = bans.body.bans.filter((ban) => ban.active);
    if (active.length !== 0) throw new Error('ban is still active');
    if (bans.body.bans.length === 0) throw new Error('ban history was lost');
    return 'unbanned, history preserved';
  });

  // ------------------------------------------------------------------ audit
  await check('GET /api/audit records every action', async () => {
    const { status, body } = await app.get('/api/audit?limit=100');
    if (status !== 200) throw new Error(`status ${status}`);

    const actions = new Set(body.entries.map((entry) => entry.action));
    for (const expected of ['announce', 'save', 'ban', 'kick', 'unban']) {
      if (!actions.has(expected)) throw new Error(`no audit entry for ${expected}`);
    }
    return `${body.total} entries covering ${[...actions].join(', ')}`;
  });

  await check('GET /api/audit filters by outcome', async () => {
    const { body } = await app.get('/api/audit?ok=false');
    if (!body.entries.every((entry) => entry.ok === false))
      throw new Error('filter leaked successes');
    return `${body.total} failures recorded`;
  });

  // ---------------------------------------------------------------- restart
  await check('POST /api/restart runs the full sequence and recovers', async () => {
    const { status, body } = await app.post('/api/restart', {
      waittime: 0,
      message: 'Smoke test restart',
    });
    if (status !== 202) throw new Error(`expected 202, got ${status}`);
    if (body.state === undefined) throw new Error('no state in response');

    const deadline = Date.now() + 30_000;
    let final = null;
    while (Date.now() < deadline) {
      const poll = await app.get('/api/restart/status');
      final = poll.body;
      if (['succeeded', 'failed'].includes(final.state)) break;
      await sleep(400);
    }

    if (final?.state !== 'succeeded') {
      throw new Error(`restart ended in state "${final?.state}": ${final?.error ?? ''}`);
    }
    return `succeeded${final.downtimeMs === null ? ' (unobserved downtime)' : `, ${final.downtimeMs}ms downtime`}`;
  });

  await check('server is serving traffic again after the restart', async () => {
    const { body } = await app.get('/api/status');
    if (!body.online) throw new Error('still offline');
    return 'online';
  });

  await check('GET /api/restart/status reflects the completed restart', async () => {
    const { body } = await app.get('/api/restart/status');
    if (body.state !== 'succeeded') throw new Error(`state is ${body.state}`);
    return body.detail;
  });

  // -------------------------------------------------------------- SPA + CSRF
  await check('SPA is served at /', async () => {
    const response = await fetch(`http://127.0.0.1:${APP_PORT}/`);
    const html = await response.text();
    if (response.status !== 200) throw new Error(`status ${response.status}`);
    if (!html.includes('<div id="app">')) throw new Error('index.html did not look like the SPA');
    return `${html.length} bytes`;
  });

  await check('SPA deep links fall back to index.html', async () => {
    for (const pathname of ['/bans', '/audit', '/settings', '/map', '/players', '/metrics']) {
      const response = await fetch(`http://127.0.0.1:${APP_PORT}${pathname}`);
      const html = await response.text();
      if (response.status !== 200 || !html.includes('<div id="app">')) {
        throw new Error(`${pathname} did not serve the SPA (status ${response.status})`);
      }
    }
    return '/bans, /audit, /settings, /map, /players, /metrics';
  });

  await check('unknown /api routes return JSON 404, not HTML', async () => {
    const { status, body } = await app.get('/api/nope');
    if (status !== 404) throw new Error(`status ${status}`);
    if (body?.error?.code !== 'not_found') throw new Error('not a JSON error envelope');
    return '404 JSON';
  });

  await check('mutations reject non-JSON content types (CSRF defence)', async () => {
    const response = await fetch(`http://127.0.0.1:${APP_PORT}/api/actions/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'a=b',
    });
    if (response.status !== 401 && response.status !== 415) {
      throw new Error(`expected 401/415, got ${response.status}`);
    }
    return `${response.status} without a valid session`;
  });

  await check('logout invalidates the session', async () => {
    await app.post('/api/auth/logout');
    app.clearCookie();
    const { status } = await app.get('/api/status');
    if (status !== 401) throw new Error(`status ${status}`);
    return '401 after logout';
  });

  // -------------------------------------------------------------- resilience
  await check('a stopped Palworld server is reported, not crashed on', async () => {
    // Log back in, then kill the mock and confirm PalSentry degrades instead of erroring out.
    await app.post('/api/auth/login', { username: APP_USERNAME, password: APP_PASSWORD });

    mockProcess.kill('SIGKILL');
    mockProcess = null;

    // Wait past the read cache TTLs. `/status` combines `/info` (5s TTL) and `/metrics` (1s TTL);
    // `/metrics` is what signals liveness, so an outage is reflected after roughly a second, and
    // definitely after the 5s `/info` TTL. Asserting sooner would be testing the cache, not the
    // outage handling.
    await sleep(5_500);

    const status = await app.get('/api/status');
    if (status.status !== 200) throw new Error(`/api/status returned ${status.status}`);
    if (status.body.online !== false) throw new Error('expected online:false');
    if (status.body.error?.code !== 'unreachable') {
      throw new Error(`unexpected error code ${status.body.error?.code}`);
    }

    const players = await app.get('/api/players');
    if (players.status !== 200 || players.body.online !== false) {
      throw new Error('/api/players should degrade to 200 with online:false');
    }

    // An unreachable game server says nothing about who is online, so nobody may be flagged as
    // online — but the roster itself must survive, with session details withheld rather than stale.
    if (players.body.players.length !== 4) {
      throw new Error(`the roster should survive the outage, got ${players.body.players.length}`);
    }
    for (const player of players.body.players) {
      if (player.online) throw new Error(`${player.name} is claimed online during an outage`);
      if (player.ip !== null || player.ping !== null) {
        throw new Error(`${player.name} still reports session details during an outage`);
      }
    }

    const bases = await app.get('/api/bases?refresh=true');
    if (bases.status !== 200 || bases.body.available !== false) {
      throw new Error('/api/bases should degrade to 200 with available:false');
    }

    const settings = await app.get('/api/settings');
    if (settings.status !== 502) throw new Error('/api/settings should surface a 502');

    return `status 200 online:false (${status.body.error.code}), bases optional, settings 502`;
  });

  await check('PalSentry itself is still healthy with the game server down', async () => {
    const { status, body } = await app.get('/api/health');
    if (status !== 200 || body.status !== 'ok') throw new Error('health check failed');
    return 'ok';
  });

  // ----------------------------------------------------------------- report
  const failed = results.filter((result) => !result.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed` +
      (failed.length === 0 ? ' \u001b[32m— all good\u001b[0m' : ''),
  );
  if (failed.length > 0) {
    console.log('\nFailures:');
    for (const failure of failed) console.log(`  • ${failure.name}: ${failure.detail}`);
  }
  console.log();

  return failed.length === 0 ? 0 : 1;
}

async function cleanup() {
  for (const child of [appProcess, mockProcess]) {
    if (child !== null && child.exitCode === null) {
      child.kill('SIGTERM');
      await sleep(300);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
  rmSync(smokeDataDir, { recursive: true, force: true });
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  console.error('\nSmoke test crashed:', error);
  exitCode = 1;
} finally {
  await cleanup();
}

process.exit(exitCode);
