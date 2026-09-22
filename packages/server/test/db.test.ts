import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createLogger } from '../src/logger.js';
import { openDatabase } from '../src/db/index.js';
import {
  SCHEMA_VERSION,
  getSchemaVersion,
  pruneMetricSamples,
  runMigrations,
} from '../src/db/migrations.js';

const logger = createLogger({ level: 'silent', pretty: false });

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function memoryDb() {
  return openDatabase(':memory:', logger);
}

function tempDbPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'palsentry-test-'));
  tempDirs.push(dir);
  return path.join(dir, 'nested', 'palsentry.db');
}

describe('openDatabase', () => {
  it('creates the schema and records the version', () => {
    const db = memoryDb();
    assert.equal(getSchemaVersion(db), SCHEMA_VERSION);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    for (const expected of ['audit', 'bans', 'metric_samples']) {
      assert.ok(names.includes(expected), `expected table ${expected}`);
    }
    db.close();
  });

  it('is idempotent — reopening an existing database applies nothing', () => {
    const dbPath = tempDbPath();

    const first = openDatabase(dbPath, logger);
    assert.equal(getSchemaVersion(first), SCHEMA_VERSION);
    first.close();

    const second = openDatabase(dbPath, logger);
    assert.equal(getSchemaVersion(second), SCHEMA_VERSION);
    runMigrations(second, logger); // explicit re-run must also be a no-op
    assert.equal(getSchemaVersion(second), SCHEMA_VERSION);
    second.close();
  });

  it('creates the parent directory for the database file', () => {
    const dbPath = tempDbPath();
    const db = openDatabase(dbPath, logger);
    // Confirms the nested directory was created rather than the open failing.
    assert.equal(getSchemaVersion(db), SCHEMA_VERSION);
    db.close();
  });

  it('enables WAL so the poller can write while the UI reads', () => {
    const dbPath = tempDbPath();
    const db = openDatabase(dbPath, logger);
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
    db.close();
  });

  it('refuses to open a database from a newer build', () => {
    const db = memoryDb();
    db.pragma('user_version = 999');

    assert.throws(() => runMigrations(db, logger), /newer than this build supports/);
    db.close();
  });
});

describe('bans table', () => {
  function insertBan(
    db: ReturnType<typeof memoryDb>,
    userid: string,
    details: { name?: string; reason?: string; at?: string } = {},
  ) {
    // Mirrors the statement the bans service uses, so this test also validates that SQLite
    // accepts an ON CONFLICT target naming a *partial* index.
    return db
      .prepare(
        `INSERT INTO bans (userid, player_name, reason, actor_name, actor_ip, banned_at, active)
         VALUES (@userid, @player_name, @reason, @actor_name, @actor_ip, @banned_at, 1)
         ON CONFLICT(userid) WHERE active = 1
         DO UPDATE SET
           player_name = excluded.player_name,
           reason      = excluded.reason,
           actor_name  = excluded.actor_name,
           actor_ip    = excluded.actor_ip,
           banned_at   = excluded.banned_at`,
      )
      .run({
        userid,
        player_name: details.name ?? 'Player',
        reason: details.reason ?? null,
        actor_name: 'admin',
        actor_ip: '10.0.0.5',
        banned_at: details.at ?? new Date().toISOString(),
      });
  }

  it('inserts a new ban', () => {
    const db = memoryDb();
    insertBan(db, 'USER-1', { name: 'Alice', reason: 'griefing' });

    const rows = db.prepare('SELECT * FROM bans').all() as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.userid, 'USER-1');
    assert.equal(rows[0]?.player_name, 'Alice');
    assert.equal(rows[0]?.active, 1);
    db.close();
  });

  it('enforces at most one active ban per player', () => {
    const db = memoryDb();
    insertBan(db, 'USER-1', { reason: 'first' });
    insertBan(db, 'USER-1', { reason: 'second' });

    const rows = db.prepare('SELECT * FROM bans WHERE userid = ? AND active = 1').all('USER-1');
    assert.equal(rows.length, 1, 're-banning updates the open episode instead of adding another');
    assert.equal((rows[0] as Record<string, unknown>).reason, 'second', 'latest reason wins');
    db.close();
  });

  it('allows a new active ban after the previous one was lifted', () => {
    const db = memoryDb();
    insertBan(db, 'USER-1', { reason: 'first' });
    db.prepare(
      "UPDATE bans SET active = 0, unbanned_at = ?, unbanned_by_ip = '10.0.0.5' WHERE userid = ? AND active = 1",
    ).run(new Date().toISOString(), 'USER-1');

    insertBan(db, 'USER-1', { reason: 'second' });

    const all = db
      .prepare('SELECT * FROM bans WHERE userid = ? ORDER BY id')
      .all('USER-1') as Record<string, unknown>[];
    assert.equal(all.length, 2, 'the ban history is preserved as separate episodes');
    assert.equal(all[0]?.active, 0);
    assert.equal(all[1]?.active, 1);
    db.close();
  });

  it('permits different players to be banned at once', () => {
    const db = memoryDb();
    insertBan(db, 'USER-1');
    insertBan(db, 'USER-2');
    const active = db.prepare('SELECT COUNT(*) AS n FROM bans WHERE active = 1').get() as {
      n: number;
    };
    assert.equal(active.n, 2);
    db.close();
  });

  it('rejects a ban row with no userid', () => {
    const db = memoryDb();
    assert.throws(() =>
      db.prepare("INSERT INTO bans (userid, banned_at, active) VALUES (NULL, 'now', 1)").run(),
    );
    db.close();
  });
});

describe('audit table', () => {
  it('records a full action entry', () => {
    const db = memoryDb();
    db.prepare(
      `INSERT INTO audit (ts, actor_name, actor_ip, action, target, payload_json, http_status, ok, error, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      new Date().toISOString(),
      'admin',
      '10.0.0.5',
      'ban',
      'USER-1',
      JSON.stringify({ userid: 'USER-1' }),
      200,
      1,
      null,
      42,
    );

    const row = db.prepare('SELECT * FROM audit').get() as Record<string, unknown>;
    assert.equal(row.action, 'ban');
    assert.equal(row.target, 'USER-1');
    assert.equal(row.ok, 1);
    assert.equal(row.duration_ms, 42);
    db.close();
  });

  it('records a failed action with the error message and no result payload', () => {
    const db = memoryDb();
    db.prepare(
      `INSERT INTO audit (ts, actor_ip, action, target, ok, error, http_status)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    ).run(new Date().toISOString(), '10.0.0.5', 'shutdown', null, 'Connection refused', 502);

    const row = db.prepare('SELECT * FROM audit').get() as Record<string, unknown>;
    assert.equal(row.ok, 0);
    assert.equal(row.error, 'Connection refused');
    assert.equal(row.http_status, 502);
    db.close();
  });
});

describe('metric_samples table', () => {
  function insertSample(db: ReturnType<typeof memoryDb>, ts: number) {
    db.prepare(
      `INSERT INTO metric_samples (ts, serverfps, currentplayernum, maxplayernum, serverframetime, uptime, basecampnum, days)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(ts, 60, 3, 32, 16.6, 1000, 2, 10);
  }

  it('stores and reads a sample', () => {
    const db = memoryDb();
    const now = Math.floor(Date.now() / 1000);
    insertSample(db, now);

    const row = db.prepare('SELECT * FROM metric_samples WHERE ts = ?').get(now) as Record<
      string,
      unknown
    >;
    assert.equal(row.serverfps, 60);
    assert.equal(row.currentplayernum, 3);
    assert.equal(row.serverframetime, 16.6, 'floating point frame time survives as REAL');
    db.close();
  });

  it('replaces a sample written for the same second', () => {
    const db = memoryDb();
    const now = Math.floor(Date.now() / 1000);
    insertSample(db, now);
    db.prepare(
      `INSERT INTO metric_samples (ts, serverfps, currentplayernum, maxplayernum, serverframetime, uptime, basecampnum, days)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ts) DO UPDATE SET serverfps = excluded.serverfps`,
    ).run(now, 30, 3, 32, 16.6, 1000, 2, 10);

    const rows = db.prepare('SELECT * FROM metric_samples').all() as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.serverfps, 30);
    db.close();
  });

  describe('pruneMetricSamples', () => {
    it('removes only samples older than the retention window', () => {
      const db = memoryDb();
      const now = Date.now();
      const nowSeconds = Math.floor(now / 1000);

      insertSample(db, nowSeconds - 10); // fresh
      insertSample(db, nowSeconds - 60 * 60); // 1 hour old
      insertSample(db, nowSeconds - 31 * 24 * 60 * 60); // 31 days old
      insertSample(db, nowSeconds - 400 * 24 * 60 * 60); // over a year old

      const removed = pruneMetricSamples(db, 30, now);
      assert.equal(removed, 2, 'only the two samples beyond 30 days are dropped');

      const remaining = db.prepare('SELECT ts FROM metric_samples ORDER BY ts').all() as {
        ts: number;
      }[];
      assert.equal(remaining.length, 2);
      db.close();
    });

    it('is a no-op when nothing is expired', () => {
      const db = memoryDb();
      insertSample(db, Math.floor(Date.now() / 1000));
      assert.equal(pruneMetricSamples(db, 30), 0);
      db.close();
    });

    it('keeps a sample exactly on the retention boundary', () => {
      const db = memoryDb();
      const now = Date.now();
      const boundary = Math.floor(now / 1000) - 30 * 24 * 60 * 60;
      insertSample(db, boundary);

      // Strictly-less-than comparison, so a sample exactly at the cutoff survives.
      assert.equal(pruneMetricSamples(db, 30, now), 0);
      db.close();
    });
  });
});
