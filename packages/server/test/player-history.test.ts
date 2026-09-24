import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { PalworldPlayer } from '@palsentry/shared';
import { DEFAULT_WAYBACK_INTERVAL_SECONDS } from '@palsentry/shared';
import type { AppContext } from '../src/context.js';
import type { PlayerSnapshot } from '../src/services/players.js';
import { createTestApp, signIn, type TestApp } from './helpers/test-app.js';

const apps: TestApp[] = [];
const tempDirs: string[] = [];

after(async () => {
  for (const app of apps) await app.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'palsentry-wayback-'));
  tempDirs.push(dir);
  return path.join(dir, 'nested', 'palsentry.db');
}

async function newApp(env: Record<string, string | undefined> = {}): Promise<TestApp> {
  const testApp = await createTestApp({ env });
  apps.push(testApp);
  return testApp;
}

/** A player fixture with only the fields the recorder stores. */
function player(userId: string, name: string, x: number, y: number): PalworldPlayer {
  return {
    name,
    accountName: name.toLowerCase(),
    playerId: `P-${userId}`,
    userId,
    level: 10,
    ip: '10.0.0.1',
    ping: 20,
    location_x: x,
    location_y: y,
    building_count: 0,
  };
}

/**
 * Record one observation at an explicit instant.
 *
 * Positions and times are passed in rather than taken from the clock so every assertion is about
 * the recorder's behaviour and not about how long the test took to run.
 */
function observeAt(
  ctx: AppContext,
  baseSeconds: number,
  offsetSeconds: number,
  players: readonly PalworldPlayer[],
): number | null {
  const observedAt = new Date((baseSeconds + offsetSeconds) * 1_000).toISOString();
  if (players.length > 0) ctx.players.record(players, new Date(observedAt));
  return ctx.playerHistory.recordSnapshot({
    ok: true,
    observedAt,
    players: [...players],
    error: null,
  });
}

/**
 * A round hour, so a one-hour window's epoch-aligned 60-second buckets do not straddle the
 * instants a test writes.
 */
const BASE = 3_600 * 100_000;
/** Half an hour into that hour: `1h` windows then span `BASE - 1800 … BASE + 1800`. */
const NOW_MS = (BASE + 1_800) * 1_000;

function snapshotCount(ctx: AppContext): number {
  const row = ctx.db.prepare('SELECT COUNT(*) AS n FROM player_position_snapshots').get() as {
    n: number;
  };
  return row.n;
}

function positionCount(ctx: AppContext): number {
  const row = ctx.db.prepare('SELECT COUNT(*) AS n FROM player_positions').get() as { n: number };
  return row.n;
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

describe('PlayerHistoryService recording', () => {
  it('stores one observation and the positions it saw', async () => {
    const testApp = await newApp();
    const { ctx } = testApp;

    observeAt(ctx, BASE, 0, [player('USER-A', 'Alice', 1, 2), player('USER-B', 'Bob', 3, 4)]);

    assert.equal(snapshotCount(ctx), 1);
    assert.equal(positionCount(ctx), 2);
    assert.equal(ctx.playerHistory.count(), 1);

    const row = ctx.db.prepare('SELECT * FROM player_positions ORDER BY userid').get() as {
      userid: string;
      captured_at: number;
      name: string;
      location_x: number;
    };
    assert.equal(row.userid, 'USER-A');
    assert.equal(row.captured_at, BASE, 'the position carries its observation instant');
    assert.equal(row.location_x, 1);
  });

  it('stores an observation that found nobody online', async () => {
    const testApp = await newApp();
    const { ctx } = testApp;

    observeAt(ctx, BASE, 0, []);

    // An empty observation is a fact: it is what separates "the server was empty" from "PalSentry
    // could not reach the server" on the timeline.
    assert.equal(snapshotCount(ctx), 1);
    assert.equal(positionCount(ctx), 0);
    const row = ctx.db.prepare('SELECT player_count AS n FROM player_position_snapshots').get() as {
      n: number;
    };
    assert.equal(row.n, 0);
  });

  it('writes nothing at all when the upstream read failed', async () => {
    const testApp = await newApp();
    const { ctx } = testApp;

    const failed: PlayerSnapshot = {
      ok: false,
      observedAt: new Date(BASE * 1_000).toISOString(),
      players: [],
      error: new Error('connection refused'),
    };
    assert.equal(ctx.playerHistory.recordSnapshot(failed), null);

    assert.equal(snapshotCount(ctx), 0, 'an outage is a gap, not an observation');
    assert.equal(positionCount(ctx), 0);
  });

  it('records the same second only once', async () => {
    const testApp = await newApp();
    const { ctx } = testApp;

    observeAt(ctx, BASE, 0, [player('USER-A', 'Alice', 1, 2)]);
    // A restart can land in the same second as the previous process's last observation.
    observeAt(ctx, BASE, 0, [player('USER-A', 'Alice', 9, 9)]);

    assert.equal(snapshotCount(ctx), 1);
    assert.equal(positionCount(ctx), 1);
    const row = ctx.db.prepare('SELECT location_x AS x FROM player_positions').get() as {
      x: number;
    };
    assert.equal(row.x, 1, 'the first observation for that second stands');
  });

  it('records nothing when a browser asks for the live player list', async () => {
    const testApp = await newApp();
    const { ctx } = testApp;

    const response = await testApp.app.inject({
      method: 'GET',
      url: '/api/players',
      headers: { cookie: await signIn(testApp.app) },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(ctx.players.count(), 2, 'the roster was refreshed from the stub');
    // Recording is the background timer's job. A page view must not fill the history with samples
    // taken whenever somebody happened to open the dashboard.
    assert.equal(snapshotCount(ctx), 0);
  });

  it('records what one scheduled observation saw', async () => {
    const testApp = await newApp();
    const { ctx } = testApp;

    assert.equal(await ctx.playerHistory.observe(), true);

    assert.equal(snapshotCount(ctx), 1);
    assert.equal(positionCount(ctx), 2, 'both stub players were recorded');
    const names = ctx.db.prepare('SELECT name FROM player_positions ORDER BY name').all() as {
      name: string;
    }[];
    assert.deepEqual(
      names.map((row) => row.name),
      ['Alice', 'Bob'],
    );
  });

  it('does not record twice for one observation', async () => {
    const testApp = await newApp();
    const { ctx } = testApp;

    const results = await Promise.all([
      ctx.playerHistory.observe(),
      ctx.playerHistory.observe(),
      ctx.playerHistory.observe(),
    ]);

    // Every caller is told the same observation succeeded; what must not happen is three reads or
    // three rows.
    assert.deepEqual(results, [true, true, true]);
    assert.equal(snapshotCount(ctx), 1);
    assert.equal(testApp.stub.requestsFor('/players').length, 1);
  });
});

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

describe('PlayerHistoryService cadence', () => {
  it('records every five seconds by default', async () => {
    const testApp = await newApp();
    assert.equal(testApp.ctx.playerHistory.intervalSeconds, 5);
    assert.equal(DEFAULT_WAYBACK_INTERVAL_SECONDS, 5);
  });

  it('takes the cadence from the environment', async () => {
    const testApp = await newApp({ PALSENTRY_WAYBACK_INTERVAL_SECONDS: '30' });
    assert.equal(testApp.ctx.playerHistory.intervalSeconds, 30);
  });

  it('ignores a cadence persisted by an older release', async () => {
    const dbPath = tempDbPath();
    // A database written before the cadence moved to the environment still carries its old row.
    // The environment wins, so an upgrade cannot silently keep recording at the old rate.
    const first = await newApp({ PALSENTRY_DB_PATH: dbPath });
    first.ctx.db.prepare('UPDATE wayback_settings SET interval_seconds = 300 WHERE id = 1').run();
    await first.close();

    const second = await newApp({ PALSENTRY_DB_PATH: dbPath });
    assert.equal(second.ctx.playerHistory.intervalSeconds, 5);

    const stored = second.ctx.db
      .prepare('SELECT interval_seconds AS seconds FROM wayback_settings WHERE id = 1')
      .get() as { seconds: number };
    assert.equal(stored.seconds, 300, 'the legacy row is left untouched');
  });

  it('does not schedule anything until it is started', async () => {
    const testApp = await newApp();
    const { ctx } = testApp;
    const internals = ctx.playerHistory as unknown as { sampleTimer: NodeJS.Timeout | null };

    assert.equal(internals.sampleTimer, null);
    assert.equal(snapshotCount(ctx), 0);
  });
});

// ---------------------------------------------------------------------------
// Reading history
// ---------------------------------------------------------------------------

describe('PlayerHistoryService history', () => {
  it('defaults to the last day', async () => {
    const testApp = await newApp();
    const history = testApp.ctx.playerHistory.history(undefined, NOW_MS);

    assert.equal(history.window, '24h');
    assert.equal(history.selection.kind, 'window');
    assert.equal(history.to - history.from, 24 * 60 * 60);
  });

  it('returns nothing for a range with no observations', async () => {
    const testApp = await newApp();
    const history = testApp.ctx.playerHistory.history('1h', NOW_MS);

    assert.deepEqual(history.snapshots, []);
    assert.deepEqual(history.players, []);
  });

  it('folds several observations into one bucket and keeps the latest', async () => {
    const testApp = await newApp();
    const { ctx } = testApp;

    observeAt(ctx, BASE, 0, [player('USER-A', 'Alice', 1, 1)]);
    observeAt(ctx, BASE, 10, [player('USER-A', 'Alice', 2, 2)]);
    observeAt(ctx, BASE, 20, [player('USER-A', 'Alice', 3, 3)]);

    const history = ctx.playerHistory.history('1h', NOW_MS);

    assert.equal(history.bucketSeconds, 60, 'preset windows keep their chart buckets');
    assert.equal(history.snapshots.length, 1, 'one tick per bucket');
    assert.equal(history.snapshots[0]?.ts, BASE + 20, 'the tick names a real observation');
    assert.equal(history.snapshots[0]?.playerCount, 1);

    const alice = history.players[0];
    assert.equal(alice?.points.length, 1);
    assert.deepEqual(alice?.points[0], { ts: BASE + 20, x: 3, y: 3 });
  });

  it('reveals second-level detail when a custom range is zoomed in', async () => {
    const testApp = await newApp();
    const { ctx } = testApp;

    observeAt(ctx, BASE, 0, [player('USER-A', 'Alice', 1, 1)]);
    observeAt(ctx, BASE, 5, [player('USER-A', 'Alice', 2, 2)]);
    observeAt(ctx, BASE, 10, [player('USER-A', 'Alice', 3, 3)]);
    observeAt(ctx, BASE, 15, [player('USER-A', 'Alice', 4, 4)]);

    // A one-minute view of a five-second cadence: twelve observations fit the point cap easily,
    // so the timeline is expected to expose each one rather than folding them into 60s columns.
    const history = ctx.playerHistory.history({ kind: 'range', from: BASE, to: BASE + 60 });

    assert.equal(history.bucketSeconds, 5, 'the bucket is one cadence step');
    assert.deepEqual(
      history.snapshots.map((snapshot) => snapshot.ts),
      [BASE, BASE + 5, BASE + 10, BASE + 15],
      'each observation is its own tick',
    );
    assert.deepEqual(
      history.players[0]?.points.map((point) => point.x),
      [1, 2, 3, 4],
    );
  });

  it('coarsens a custom range only as far as the point cap requires', async () => {
    const testApp = await newApp();
    const { ctx } = testApp;

    // An hour of five-second observations is 720 instants: twice the cap, so the bucket must be a
    // cadence multiple that brings the response back under it.
    const hour = ctx.playerHistory.history({ kind: 'range', from: BASE, to: BASE + 3_600 });
    assert.equal(hour.bucketSeconds, 10);
    assert.ok(Math.ceil(3_600 / hour.bucketSeconds) <= 360);

    const day = ctx.playerHistory.history({ kind: 'range', from: BASE, to: BASE + 86_400 });
    assert.ok(day.bucketSeconds % 5 === 0, 'wide ranges still bucket on cadence multiples');
    assert.ok(Math.ceil(86_400 / day.bucketSeconds) <= 360);
  });

  it('honours a coarser configured cadence in a zoomed custom range', async () => {
    const testApp = await newApp({ PALSENTRY_WAYBACK_INTERVAL_SECONDS: '60' });
    const { ctx } = testApp;

    const history = ctx.playerHistory.history({ kind: 'range', from: BASE, to: BASE + 60 });

    // No bucket can be finer than the observations it has to describe, so a 60-second cadence
    // yields one bucket here even though the point cap would allow twelve.
    assert.equal(history.bucketSeconds, 60);
  });

  it('leaves a gap where no observations were recorded', async () => {
    const testApp = await newApp();
    const { ctx } = testApp;

    observeAt(ctx, BASE, 0, [player('USER-A', 'Alice', 1, 1)]);
    // Ten minutes pass with the game server unreachable: nothing is written for them.
    observeAt(ctx, BASE, 600, [player('USER-A', 'Alice', 50, 50)]);

    const history = ctx.playerHistory.history('1h', NOW_MS);

    assert.deepEqual(
      history.snapshots.map((snapshot) => snapshot.ts),
      [BASE, BASE + 600],
    );
    assert.deepEqual(
      history.players[0]?.points.map((point) => point.x),
      [1, 50],
      'no point was invented to bridge the outage',
    );
  });

  it('does not report a player with no observation in the range', async () => {
    const testApp = await newApp();
    const { ctx } = testApp;

    // Dave left two hours before the window opens and never came back, so there is no instant inside
    // the range at which he can honestly be drawn.
    observeAt(ctx, BASE, -7_200, [player('USER-DAVE', 'Dave', 7, 7)]);
    observeAt(ctx, BASE, 0, [player('USER-A', 'Alice', 1, 1)]);

    const history = ctx.playerHistory.history('1h', NOW_MS);

    assert.deepEqual(
      history.players.map((entry) => entry.userId),
      ['USER-A'],
      'only the account recorded inside the range is reported',
    );
  });

  it('never reports a player the roster does not know', async () => {
    const testApp = await newApp();
    const { ctx } = testApp;

    // Positions always come from the roster's own observations, so this can only happen if the
    // database was edited by hand — and the response must still be coherent.
    const inserted = ctx.db
      .prepare('INSERT INTO player_position_snapshots (captured_at, player_count) VALUES (?, 1)')
      .run(BASE);
    ctx.db
      .prepare(
        `INSERT INTO player_positions (snapshot_id, captured_at, userid, name, level, location_x, location_y)
         VALUES (?, ?, 'USER-GHOST', 'Ghost', 1, 5, 5)`,
      )
      .run(inserted.lastInsertRowid, BASE);

    const history = ctx.playerHistory.history('1h', NOW_MS);
    assert.equal(history.snapshots.length, 1, 'the observation itself is still a tick');
    assert.deepEqual(history.players, [], 'but an unnameable account is not drawn');
  });

  it('keeps pre-upgrade positions out of the timeline entirely', async () => {
    const testApp = await newApp();
    const { ctx } = testApp;

    const inserted = ctx.db
      .prepare(
        'INSERT INTO player_position_snapshots (captured_at, player_count, synthetic) VALUES (?, 1, 1)',
      )
      .run(BASE - 7_200);
    ctx.db
      .prepare(
        `INSERT INTO player_positions (snapshot_id, captured_at, userid, name, level, location_x, location_y)
         VALUES (?, ?, 'USER-DAVE', 'Dave', 1, 8, 9)`,
      )
      .run(inserted.lastInsertRowid, BASE - 7_200);
    ctx.players.record([player('USER-DAVE', 'Dave', 8, 9)], new Date((BASE - 7_200) * 1_000));

    const history = ctx.playerHistory.history('1h', NOW_MS);

    assert.deepEqual(history.snapshots, [], 'a synthesised row was never observed by this service');
    assert.deepEqual(
      history.players,
      [],
      'and it cannot place a player at an instant the timeline can land on',
    );
  });

  it('rejects a range longer than the retention window', async () => {
    const testApp = await newApp();
    assert.throws(
      () =>
        testApp.ctx.playerHistory.history(
          { kind: 'range', from: BASE, to: BASE + 40 * 24 * 60 * 60 },
          NOW_MS,
        ),
      /retention period/,
    );
  });

  it('rejects a reversed range', async () => {
    const testApp = await newApp();
    assert.throws(
      () => testApp.ctx.playerHistory.history({ kind: 'range', from: BASE, to: BASE }, NOW_MS),
      /ordered positive/,
    );
  });

  it('prunes history beyond the retention window', async () => {
    const testApp = await newApp();
    const { ctx } = testApp;

    observeAt(ctx, BASE, -40 * 24 * 60 * 60, [player('USER-A', 'Alice', 1, 1)]);
    observeAt(ctx, BASE, 0, [player('USER-A', 'Alice', 2, 2)]);

    assert.equal(ctx.playerHistory.prune(NOW_MS), 1, 'only the observation past retention went');
    assert.equal(positionCount(ctx), 1, 'and its position went with it');
    assert.equal(snapshotCount(ctx), 1);
  });
});

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

describe('player history API', () => {
  it('requires authentication', async () => {
    const testApp = await newApp();

    const history = await testApp.app.inject({ method: 'GET', url: '/api/player-history' });
    assert.equal(history.statusCode, 401);
  });

  it('has no cadence endpoint: the interval is deployment configuration', async () => {
    const testApp = await newApp();
    const cookie = await signIn(testApp.app);

    const response = await testApp.app.inject({
      method: 'PUT',
      url: '/api/player-history/settings',
      headers: { cookie, 'content-type': 'application/json' },
      payload: { intervalSeconds: 15 },
    });

    assert.equal(response.statusCode, 404);
  });

  it('serves the last day by default', async () => {
    const testApp = await newApp();
    const cookie = await signIn(testApp.app);

    const response = await testApp.app.inject({
      method: 'GET',
      url: '/api/player-history',
      headers: { cookie },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json() as { window: string; bucketSeconds: number; snapshots: unknown[] };
    assert.equal(body.window, '24h');
    assert.equal(body.bucketSeconds, 300);
    assert.deepEqual(body.snapshots, []);
  });

  it('accepts a custom range and rejects an impossible one', async () => {
    const testApp = await newApp();
    const cookie = await signIn(testApp.app);

    const ok = await testApp.app.inject({
      method: 'GET',
      url: `/api/player-history?from=${BASE}&to=${BASE + 600}`,
      headers: { cookie },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal((ok.json() as { window: string | null }).window, null);

    const reversed = await testApp.app.inject({
      method: 'GET',
      url: `/api/player-history?from=${BASE + 600}&to=${BASE}`,
      headers: { cookie },
    });
    assert.equal(reversed.statusCode, 400);

    const tooLong = await testApp.app.inject({
      method: 'GET',
      url: `/api/player-history?from=${BASE}&to=${BASE + 40 * 24 * 60 * 60}`,
      headers: { cookie },
    });
    assert.equal(tooLong.statusCode, 400);

    const both = await testApp.app.inject({
      method: 'GET',
      url: `/api/player-history?window=1h&from=${BASE}&to=${BASE + 600}`,
      headers: { cookie },
    });
    assert.equal(both.statusCode, 400, 'a preset and a range are mutually exclusive');
  });

  it('reports the effective cadence in /meta', async () => {
    const testApp = await newApp({
      PALSENTRY_HISTORY_RETENTION_DAYS: '7',
      PALSENTRY_WAYBACK_INTERVAL_SECONDS: '30',
    });
    const cookie = await signIn(testApp.app);

    const response = await testApp.app.inject({
      method: 'GET',
      url: '/api/meta',
      headers: { cookie },
    });

    const body = response.json() as {
      history: { retentionDays: number; waybackIntervalSeconds: number };
    };
    assert.equal(body.history.retentionDays, 7);
    assert.equal(body.history.waybackIntervalSeconds, 30);
    assert.equal(
      Object.hasOwn(body.history, 'waybackIntervalOptions'),
      false,
      'the SPA cannot choose the cadence, so /meta does not offer options',
    );
  });
});
