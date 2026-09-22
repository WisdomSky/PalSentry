import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import type { PalworldPlayer } from '@palsentry/shared';
import { createLogger } from '../src/logger.js';
import { openDatabase } from '../src/db/index.js';
import { SCHEMA_VERSION, getSchemaVersion, runMigrations } from '../src/db/migrations.js';
import { PlayerRoster } from '../src/services/players.js';
import { FIXTURES } from './helpers/palworld-stub.js';
import { createTestApp, type TestApp } from './helpers/test-app.js';

/**
 * Tests for the durable player roster.
 *
 * The roster exists because `/players` only reports who is connected right now, so the two
 * behaviours worth pinning down are "a snapshot is remembered" and "nothing is ever forgotten or
 * overwritten by accident" — the rows are the only record of past players.
 */

const logger = createLogger({ level: 'silent', pretty: false });

const tempDirs: string[] = [];
/** Fully wired apps backed by a real HTTP stub, used by the observation tests. */
const apps: TestApp[] = [];

after(async () => {
  await Promise.all(apps.map((testApp) => testApp.close()));
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function memoryDb() {
  return openDatabase(':memory:', logger);
}

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'palsentry-players-'));
  tempDirs.push(dir);
  return path.join(dir, 'nested', 'palsentry.db');
}

/** A normalized `/players` row, exactly as the client hands it to the service. */
function player(overrides: Partial<PalworldPlayer> = {}): PalworldPlayer {
  return {
    name: 'Alice',
    accountName: 'alice_steam',
    playerId: 'PLAYER-1',
    userId: 'USER-1',
    ip: '10.0.0.11',
    ping: 24.5,
    location_x: -359_583,
    location_y: 267_748.59375,
    level: 42,
    building_count: 137,
    ...overrides,
  };
}

const T0 = new Date('2026-09-21T10:00:00.000Z');
const T1 = new Date('2026-09-21T11:30:00.000Z');

describe('players migration', () => {
  it('creates the players table and records the new schema version', () => {
    const db = memoryDb();
    assert.equal(getSchemaVersion(db), SCHEMA_VERSION);
    assert.ok(SCHEMA_VERSION >= 2, 'the roster migration must bump the schema version');

    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'players'")
      .get() as { sql: string } | undefined;
    assert.ok(row !== undefined, 'expected a players table');
    assert.match(row.sql, /userid\s+TEXT\s+PRIMARY KEY/);
  });

  it('upgrades a version 1 database without losing its existing tables', () => {
    const dbPath = tempDbPath();

    // Simulate the database an operator has on disk today: schema version 1, which has no
    // players table. Everything else must come through the upgrade untouched.
    const legacy = openDatabase(dbPath, logger);
    legacy.exec('DROP TABLE players');
    legacy.pragma('user_version = 1');
    legacy.close();

    const upgraded = openDatabase(dbPath, logger);
    assert.equal(getSchemaVersion(upgraded), SCHEMA_VERSION);

    const tables = (
      upgraded
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as { name: string }[]
    ).map((table) => table.name);
    for (const expected of ['players', 'bans', 'audit', 'metric_samples']) {
      assert.ok(tables.includes(expected), `expected table ${expected} after the upgrade`);
    }
    upgraded.close();
  });

  it('is idempotent — reopening applies nothing', () => {
    const dbPath = tempDbPath();
    const first = openDatabase(dbPath, logger);
    first.close();

    const second = openDatabase(dbPath, logger);
    assert.equal(getSchemaVersion(second), SCHEMA_VERSION);
    runMigrations(second, logger);
    assert.equal(getSchemaVersion(second), SCHEMA_VERSION);
    second.close();
  });

  it('keeps connection-level fields (IP, ping, buildings) out of the roster', () => {
    const db = memoryDb();
    const columns = (db.prepare('PRAGMA table_info(players)').all() as { name: string }[]).map(
      (column) => column.name,
    );

    assert.deepEqual(columns.sort(), [
      'account_name',
      'first_seen_at',
      'last_online_at',
      'level',
      'location_x',
      'location_y',
      'name',
      'player_id',
      'userid',
    ]);
  });
});

describe('PlayerRoster.record', () => {
  it('adds every player of a snapshot with one shared timestamp', () => {
    const db = memoryDb();
    const players = new PlayerRoster(db);

    players.record([player(), player({ name: 'Bob', userId: 'USER-2', playerId: 'PLAYER-2' })], T0);

    const roster = players.list();
    assert.equal(roster.length, 2);
    assert.equal(players.count(), 2);
    for (const entry of roster) {
      assert.equal(entry.lastOnlineAt, T0.toISOString());
      assert.equal(entry.firstSeenAt, T0.toISOString());
    }
  });

  it('writes nothing for an empty snapshot', () => {
    const db = memoryDb();
    const players = new PlayerRoster(db);

    players.record([], T0);
    assert.equal(players.count(), 0);
  });

  it('keeps the first-seen time while advancing last-online', () => {
    const db = memoryDb();
    const players = new PlayerRoster(db);

    players.record([player()], T0);
    players.record([player()], T1);

    const entry = players.find('USER-1');
    assert.equal(entry?.firstSeenAt, T0.toISOString(), 'first seen is written once');
    assert.equal(entry?.lastOnlineAt, T1.toISOString(), 'last online follows the newest snapshot');
    assert.equal(players.count(), 1, 'a returning player is not duplicated');
  });

  it('follows the latest snapshot for a rename, level change, and move', () => {
    const db = memoryDb();
    const players = new PlayerRoster(db);

    players.record([player()], T0);
    players.record(
      [
        player({
          name: 'Alice the Great',
          accountName: 'alice_new',
          level: 55,
          location_x: 1_000,
          location_y: -2_000,
        }),
      ],
      T1,
    );

    const entry = players.find('USER-1');
    assert.equal(entry?.name, 'Alice the Great');
    assert.equal(entry?.accountName, 'alice_new');
    assert.equal(entry?.level, 55);
    assert.equal(entry?.location_x, 1_000);
    assert.equal(entry?.location_y, -2_000);
  });

  it('does not touch players who are absent from the snapshot', () => {
    const db = memoryDb();
    const players = new PlayerRoster(db);

    players.record([player(), player({ name: 'Bob', userId: 'USER-2', playerId: 'PLAYER-2' })], T0);
    // Bob disconnects; only Alice is reported next time.
    players.record([player()], T1);

    const bob = players.find('USER-2');
    assert.equal(
      bob?.lastOnlineAt,
      T0.toISOString(),
      'an offline player keeps their last sighting',
    );
    assert.equal(players.count(), 2, 'an offline player is retained');
  });

  it('survives a duplicate userId inside one snapshot', () => {
    const db = memoryDb();
    const players = new PlayerRoster(db);

    players.record([player(), player({ name: 'Alice again' })], T0);

    assert.equal(players.count(), 1);
    assert.equal(players.find('USER-1')?.name, 'Alice again');
  });

  it('is read back by a later service instance', () => {
    const db = memoryDb();
    new PlayerRoster(db).record([player()], T0);

    assert.equal(new PlayerRoster(db).find('USER-1')?.name, 'Alice');
  });
});

describe('PlayerRoster.list', () => {
  it('orders the roster by most recent sighting first', () => {
    const db = memoryDb();
    const players = new PlayerRoster(db);

    players.record([player({ name: 'Alice', userId: 'USER-1' })], T0);
    players.record([player({ name: 'Bob', userId: 'USER-2' })], T1);
    players.record([player({ name: 'Carol', userId: 'USER-3' })], T0);

    assert.deepEqual(
      players.list().map((entry) => entry.name),
      ['Bob', 'Alice', 'Carol'],
    );
  });

  it('falls back to name and id for players seen in the same second', () => {
    const db = memoryDb();
    const players = new PlayerRoster(db);

    players.record(
      [
        player({ name: 'Zoe', userId: 'USER-9' }),
        player({ name: 'adam', userId: 'USER-2' }),
        player({ name: 'Adam', userId: 'USER-1' }),
      ],
      T0,
    );

    // Case-insensitive so the names read in alphabetical order, then the id breaks the tie.
    assert.deepEqual(
      players.list().map((entry) => entry.userId),
      ['USER-1', 'USER-2', 'USER-9'],
    );
  });

  it('returns an empty roster before anything has been observed', () => {
    const db = memoryDb();
    assert.deepEqual(new PlayerRoster(db).list(), []);
  });

  it('reports nothing for an unknown account', () => {
    const db = memoryDb();
    assert.equal(new PlayerRoster(db).find('USER-MISSING'), null);
  });
});

describe('player roster persistence', () => {
  it('survives closing and reopening the database', () => {
    const dbPath = tempDbPath();

    const first = openDatabase(dbPath, logger);
    new PlayerRoster(first).record(
      [player(), player({ name: 'Bob', userId: 'USER-2', playerId: 'PLAYER-2' })],
      T0,
    );
    first.close();

    const second = openDatabase(dbPath, logger);
    const roster = new PlayerRoster(second).list();
    assert.deepEqual(
      roster.map((entry) => entry.name),
      ['Alice', 'Bob'],
    );
    assert.equal(roster[0]?.lastOnlineAt, T0.toISOString());
    second.close();
  });
});

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

describe('PlayerService observation', () => {
  it('persists what a successful read found', async () => {
    const testApp = await createTestApp();
    apps.push(testApp);

    const snapshot = await testApp.ctx.players.refresh();

    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.players.length, 2);
    assert.deepEqual(
      testApp.ctx.players.list().map((entry) => entry.name),
      ['Alice', 'Bob'],
    );
  });

  it('shares one upstream read between concurrent callers', async () => {
    // A browser poll landing on top of the background tick must not produce two reads, let alone
    // two roster writes from two slightly different snapshots.
    const testApp = await createTestApp({
      stub: {
        handler: async ({ res, path }) => {
          if (path !== '/players') {
            res.writeHead(404).end();
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 40));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(FIXTURES.players));
        },
      },
    });
    apps.push(testApp);

    const snapshots = await Promise.all([
      testApp.ctx.players.refresh(),
      testApp.ctx.players.refresh(),
      testApp.ctx.players.refresh(),
    ]);

    assert.equal(snapshots[0], snapshots[1], 'callers share the in-flight read');
    assert.equal(snapshots[1], snapshots[2]);
    assert.equal(testApp.stub.requestsFor('/players').length, 1);
  });

  it('reports an unreachable game server without changing the roster', async () => {
    const testApp = await createTestApp();
    apps.push(testApp);

    // A first successful read puts Alice and Bob on the roster.
    await testApp.ctx.players.refresh();
    const before = testApp.ctx.players.list();
    assert.equal(before.length, 2);

    testApp.stub.setPlayers(null);
    testApp.ctx.client.invalidateCache();
    const failed = await testApp.ctx.players.refresh();

    assert.equal(failed.ok, false, 'a failed read is not a snapshot');
    assert.deepEqual(failed.players, []);
    assert.ok(failed.error !== null, 'the failure is surfaced for the route to map');

    // An outage is not evidence that anyone left, so nothing may be rewritten.
    assert.deepEqual(testApp.ctx.players.list(), before);
  });

  it('resumes recording after the game server comes back', async () => {
    const testApp = await createTestApp();
    apps.push(testApp);

    testApp.stub.setPlayers([]);
    testApp.ctx.client.invalidateCache();
    assert.equal((await testApp.ctx.players.refresh()).ok, true);
    assert.equal(testApp.ctx.players.count(), 0, 'nobody was online, so nobody is remembered');

    testApp.stub.setPlayers(FIXTURES.players.players);
    testApp.ctx.client.invalidateCache();
    assert.equal((await testApp.ctx.players.refresh()).ok, true);
    assert.equal(testApp.ctx.players.count(), 2);
  });

  it('takes its first sample when the observer starts', async () => {
    const testApp = await createTestApp();
    apps.push(testApp);

    assert.equal(testApp.ctx.players.count(), 0, 'nothing is observed before start()');
    await testApp.ctx.players.start();
    assert.equal(testApp.ctx.players.count(), 2);

    await testApp.ctx.players.stop();
  });

  it('tolerates being started and stopped more than once', async () => {
    const testApp = await createTestApp();
    apps.push(testApp);

    await testApp.ctx.players.start();
    await testApp.ctx.players.start(); // no-op
    await testApp.ctx.players.stop();
    await testApp.ctx.players.stop(); // safe when already stopped

    assert.equal(testApp.ctx.players.count(), 2);
  });

  it('stops cleanly while a read is in flight', async () => {
    const testApp = await createTestApp({
      stub: { delayMs: 30 },
    });
    apps.push(testApp);

    await testApp.ctx.players.start();
    // stop() waits for the in-flight read rather than closing the database underneath it.
    const pending = testApp.ctx.players.refresh();
    await testApp.ctx.players.stop();
    assert.equal((await pending).ok, true);
  });
});
