import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { HistoryResponse, HistorySample } from '@palsentry/shared';
import { createTestApp, signIn, type TestApp } from './helpers/test-app.js';
import { FIXTURES } from './helpers/palworld-stub.js';

const apps: TestApp[] = [];

async function makeApp(options: Parameters<typeof createTestApp>[0] = {}): Promise<TestApp> {
  const app = await createTestApp(options);
  apps.push(app);
  return app;
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()));
});

/**
 * A fixed timestamp that is an exact multiple of every bucket size in use (60, 120, 300, 1800,
 * 7200), so bucket boundaries land exactly on the timestamps under test.
 */
const BASE = 1_699_999_200;
const HOUR = 3_600;

/** Insert a sample directly, bypassing the poller, for deterministic bucketing tests. */
function insertSample(
  testApp: TestApp,
  ts: number,
  overrides: Partial<{
    serverfps: number;
    currentplayernum: number;
    maxplayernum: number;
    serverframetime: number;
    uptime: number;
    basecampnum: number;
    days: number;
  }> = {},
): void {
  const value = {
    serverfps: 60,
    currentplayernum: 2,
    maxplayernum: 32,
    serverframetime: 16.6,
    uptime: 1_000,
    basecampnum: 3,
    days: 100,
    ...overrides,
  };

  testApp.ctx.db
    .prepare(
      `INSERT INTO metric_samples
         (ts, serverfps, currentplayernum, maxplayernum, serverframetime, uptime, basecampnum, days)
       VALUES
         (@ts, @serverfps, @currentplayernum, @maxplayernum, @serverframetime, @uptime, @basecampnum, @days)`,
    )
    .run({ ts, ...value });
}

describe('MetricsPoller.sample', () => {
  it('stores a sample read from the game server', async () => {
    const testApp = await makeApp();

    const ok = await testApp.ctx.metrics.sample();
    assert.equal(ok, true);

    const row = testApp.ctx.db.prepare('SELECT * FROM metric_samples').get() as Record<
      string,
      unknown
    >;

    assert.notEqual(row, undefined);
    assert.equal(row.serverfps, 58, 'matches the stub metrics');
    assert.equal(row.currentplayernum, 2);
    assert.equal(row.serverframetime, 17.2);
    assert.equal(row.basecampnum, 5);
    assert.equal(row.days, 132);
  });

  it('returns false instead of throwing when the game server is down', async () => {
    const testApp = await makeApp({ palworldUrl: 'http://127.0.0.1:9' });

    // A failing sample is normal (the server restarts, or is off) and must not break the poller.
    assert.equal(await testApp.ctx.metrics.sample(), false);

    const count = testApp.ctx.db.prepare('SELECT COUNT(*) AS n FROM metric_samples').get() as {
      n: number;
    };
    assert.equal(count.n, 0, 'no row is written for a failed sample');
  });

  it('replaces a sample taken in the same second rather than failing on the primary key', async () => {
    const testApp = await makeApp();

    await testApp.ctx.metrics.sample();
    await testApp.ctx.metrics.sample();

    const count = testApp.ctx.db.prepare('SELECT COUNT(*) AS n FROM metric_samples').get() as {
      n: number;
    };
    assert.equal(count.n, 1, 'ts is the primary key, so the second sample updates the first');
  });

  it('rounds fps to an integer', async () => {
    const testApp = await makeApp({
      stub: { overrides: { metrics: { ...FIXTURES.metrics, serverfps: 57.6 } } },
    });

    await testApp.ctx.metrics.sample();
    const row = testApp.ctx.db.prepare('SELECT serverfps FROM metric_samples').get() as {
      serverfps: number;
    };
    assert.equal(row.serverfps, 58);
  });
});

describe('MetricsPoller lifecycle', () => {
  it('start and stop are idempotent and do not leave timers running', async () => {
    const testApp = await makeApp();

    // `start()` resolves once the first sample is stored, so this is not racy.
    await testApp.ctx.metrics.start();
    await testApp.ctx.metrics.start(); // second call is a no-op
    await testApp.ctx.metrics.stop();
    await testApp.ctx.metrics.stop(); // safe when already stopped

    const count = testApp.ctx.db.prepare('SELECT COUNT(*) AS n FROM metric_samples').get() as {
      n: number;
    };
    assert.equal(count.n, 1);
  });

  it('does not stack up duplicate samples when called concurrently', async () => {
    const testApp = await makeApp({ stub: { delayMs: 40 } });

    await Promise.all([
      testApp.ctx.metrics.sample(),
      testApp.ctx.metrics.sample(),
      testApp.ctx.metrics.sample(),
    ]);

    assert.equal(
      testApp.stub.requestsFor('/metrics').length,
      1,
      'concurrent samples are coalesced',
    );
  });
});

describe('MetricsPoller.prune', () => {
  it('removes samples past the retention window', async () => {
    const testApp = await makeApp({ env: { PALSENTRY_HISTORY_RETENTION_DAYS: '7' } });

    const nowSeconds = Math.floor(Date.now() / 1000);
    insertSample(testApp, nowSeconds - 60); // fresh
    insertSample(testApp, nowSeconds - 8 * 24 * 3600); // 8 days old

    const removed = testApp.ctx.metrics.prune();
    assert.equal(removed, 1);

    assert.equal(testApp.ctx.metrics.count(), 1);
  });
});

describe('MetricsPoller.history', () => {
  it('returns an empty series when there is no data', async () => {
    const testApp = await makeApp();
    const history = testApp.ctx.metrics.history('6h', BASE * 1000);

    assert.equal(history.window, '6h');
    assert.deepEqual(history.selection, { kind: 'window', window: '6h' });
    assert.equal(history.from, BASE - 6 * HOUR);
    assert.equal(history.to, BASE);
    assert.equal(history.bucketSeconds, 120);
    assert.deepEqual(history.samples, []);
  });

  it('averages rate metrics and takes high-water marks within a bucket', async () => {
    const testApp = await makeApp();

    // Both timestamps land in the same 120s bucket for the 6h window.
    insertSample(testApp, BASE, { serverfps: 30, currentplayernum: 1, maxplayernum: 32 });
    insertSample(testApp, BASE + 60, { serverfps: 90, currentplayernum: 3, maxplayernum: 40 });

    const history = testApp.ctx.metrics.history('6h', (BASE + HOUR) * 1000);

    assert.equal(history.samples.length, 1, 'one bucket for two samples');
    const sample = history.samples[0] as HistorySample;
    assert.equal(sample.ts, BASE);
    assert.equal(sample.serverfps, 60, 'average of 30 and 90');
    assert.equal(sample.currentplayernum, 2, 'average of 1 and 3');
    assert.equal(sample.maxplayernum, 40, 'MAX, since the cap is a ceiling not an average');
  });

  it('produces separate buckets with a finer bucket size', async () => {
    const testApp = await makeApp();

    insertSample(testApp, BASE, { serverfps: 30 });
    insertSample(testApp, BASE + 60, { serverfps: 90 });

    const history = testApp.ctx.metrics.history('1h', (BASE + HOUR) * 1000);

    assert.equal(history.bucketSeconds, 60);
    assert.equal(history.samples.length, 2);
    assert.equal(history.samples[0]?.serverfps, 30);
    assert.equal(history.samples[1]?.serverfps, 90);
  });

  it('excludes samples older than the window', async () => {
    const testApp = await makeApp();

    insertSample(testApp, BASE, { serverfps: 10 });
    insertSample(testApp, BASE - 8 * HOUR, { serverfps: 99 }); // outside a 6h window

    const history = testApp.ctx.metrics.history('6h', (BASE + HOUR) * 1000);

    assert.equal(history.samples.length, 1);
    assert.equal(history.samples[0]?.serverfps, 10);
  });

  it('includes samples exactly on the window boundary', async () => {
    const testApp = await makeApp();

    // `6h` window with now = BASE + 6h puts the cutoff exactly at BASE.
    insertSample(testApp, BASE, { serverfps: 42 });

    const history = testApp.ctx.metrics.history('6h', (BASE + 6 * HOUR) * 1000);
    assert.equal(history.samples.length, 1);
  });

  it('uses a coarser bucket for longer windows to bound the payload', async () => {
    const testApp = await makeApp();

    assert.equal(testApp.ctx.metrics.history('1h', BASE * 1000).bucketSeconds, 60);
    assert.equal(testApp.ctx.metrics.history('6h', BASE * 1000).bucketSeconds, 120);
    assert.equal(testApp.ctx.metrics.history('24h', BASE * 1000).bucketSeconds, 300);
    assert.equal(testApp.ctx.metrics.history('7d', BASE * 1000).bucketSeconds, 1_800);
    assert.equal(testApp.ctx.metrics.history('30d', BASE * 1000).bucketSeconds, 7_200);
  });

  it('returns buckets in ascending time order so charts read left to right', async () => {
    const testApp = await makeApp();

    insertSample(testApp, BASE + 120, { serverfps: 3 });
    insertSample(testApp, BASE, { serverfps: 1 });
    insertSample(testApp, BASE + 60, { serverfps: 2 });

    const history = testApp.ctx.metrics.history('1h', (BASE + HOUR) * 1000);
    const timestamps = history.samples.map((sample) => sample.ts);

    assert.deepEqual(
      timestamps,
      [...timestamps].sort((a, b) => a - b),
    );
  });

  it('keeps one decimal on frame time', async () => {
    const testApp = await makeApp();
    insertSample(testApp, BASE, { serverframetime: 16.64 });

    const history = testApp.ctx.metrics.history('6h', (BASE + HOUR) * 1000);
    assert.equal(history.samples[0]?.serverframetime, 16.6);
  });

  it('queries explicit inclusive boundaries and anchors buckets at the selected start', async () => {
    const testApp = await makeApp();
    insertSample(testApp, BASE - 60, { serverfps: 10 });
    insertSample(testApp, BASE, { serverfps: 20 });
    insertSample(testApp, BASE + 60, { serverfps: 40 });
    insertSample(testApp, BASE + 120, { serverfps: 80 });

    const history = testApp.ctx.metrics.history({
      kind: 'range',
      from: BASE,
      to: BASE + 60,
    });

    assert.deepEqual(history.selection, { kind: 'range', from: BASE, to: BASE + 60 });
    assert.equal(history.window, null);
    assert.equal(history.from, BASE);
    assert.equal(history.to, BASE + 60);
    assert.equal(history.bucketSeconds, 60);
    assert.deepEqual(
      history.samples.map((sample) => [sample.ts, sample.serverfps]),
      [
        [BASE, 20],
        [BASE + 60, 40],
      ],
    );
  });

  it('adaptively bounds custom ranges beyond the longest preset', async () => {
    const testApp = await makeApp({ env: { PALSENTRY_HISTORY_RETENTION_DAYS: '60' } });
    const span = 45 * 24 * HOUR;
    const history = testApp.ctx.metrics.history({ kind: 'range', from: BASE, to: BASE + span });

    assert.ok(history.bucketSeconds >= Math.ceil(span / 360));
    assert.ok(Math.ceil(span / history.bucketSeconds) <= 360);
  });

  it('defensively rejects custom ranges beyond configured retention', async () => {
    const testApp = await makeApp({ env: { PALSENTRY_HISTORY_RETENTION_DAYS: '7' } });
    assert.throws(
      () =>
        testApp.ctx.metrics.history({
          kind: 'range',
          from: BASE,
          to: BASE + 8 * 24 * HOUR,
        }),
      /retention period/,
    );
  });
});

describe('GET /api/history', () => {
  it('requires authentication', async () => {
    const { app } = await makeApp();
    const response = await app.inject({ method: 'GET', url: '/api/history' });
    assert.equal(response.statusCode, 401);
  });

  it('defaults to the 6h window', async () => {
    const { app } = await makeApp();
    const cookie = await signIn(app);

    const response = await app.inject({ method: 'GET', url: '/api/history', headers: { cookie } });
    assert.equal(response.statusCode, 200);
    const history = response.json<HistoryResponse>();
    assert.equal(history.window, '6h');
    assert.deepEqual(history.selection, { kind: 'window', window: '6h' });
    assert.equal(history.to - history.from, 6 * HOUR);
  });

  it('accepts each supported window', async () => {
    const { app } = await makeApp();
    const cookie = await signIn(app);

    for (const window of ['1h', '6h', '24h', '7d', '30d']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/history?window=${window}`,
        headers: { cookie },
      });
      assert.equal(response.statusCode, 200, `window=${window} should be accepted`);
      const history = response.json<HistoryResponse>();
      assert.equal(history.window, window);
      assert.deepEqual(history.selection, { kind: 'window', window });
    }
  });

  it('accepts a complete explicit range and returns only its data', async () => {
    const testApp = await makeApp();
    const { app } = testApp;
    const cookie = await signIn(app);
    insertSample(testApp, BASE - 60, { serverfps: 10 });
    insertSample(testApp, BASE, {
      serverfps: 45,
      currentplayernum: 4,
      basecampnum: 7,
      serverframetime: 22.25,
    });
    insertSample(testApp, BASE + 60, { serverfps: 90 });

    const response = await app.inject({
      method: 'GET',
      url: `/api/history?from=${BASE}&to=${BASE}`,
      headers: { cookie },
    });
    assert.equal(response.statusCode, 400, 'equal boundaries are invalid');

    const valid = await app.inject({
      method: 'GET',
      url: `/api/history?from=${BASE}&to=${BASE + 30}`,
      headers: { cookie },
    });
    assert.equal(valid.statusCode, 200);
    const history = valid.json<HistoryResponse>();
    assert.deepEqual(history.selection, { kind: 'range', from: BASE, to: BASE + 30 });
    assert.equal(history.window, null);
    assert.equal(history.samples.length, 1);
    assert.equal(history.samples[0]?.currentplayernum, 4);
    assert.equal(history.samples[0]?.basecampnum, 7);
    assert.equal(history.samples[0]?.serverframetime, 22.3);
  });

  it('rejects malformed, mixed, incomplete, reversed, and retention-exceeding ranges', async () => {
    const { app } = await makeApp({ env: { PALSENTRY_HISTORY_RETENTION_DAYS: '7' } });
    const cookie = await signIn(app);
    const urls = [
      '/api/history?window=forever',
      `/api/history?window=6h&from=${BASE}&to=${BASE + 60}`,
      `/api/history?from=${BASE}`,
      `/api/history?to=${BASE}`,
      `/api/history?from=${BASE + 60}&to=${BASE}`,
      `/api/history?from=${BASE}&to=${BASE + 8 * 24 * HOUR}`,
      `/api/history?from=not-a-date&to=${BASE}`,
      `/api/history?from=${BASE}.5&to=${BASE + 60}`,
    ];

    for (const url of urls) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie } });
      assert.equal(response.statusCode, 400, `${url} should be rejected`);
      assert.equal(response.json().error.code, 'validation');
    }
  });

  it('returns data recorded by the poller', async () => {
    const { app, ctx } = await makeApp();
    const cookie = await signIn(app);

    await ctx.metrics.sample();

    const response = await app.inject({
      method: 'GET',
      url: '/api/history?window=1h',
      headers: { cookie },
    });

    const history = response.json<HistoryResponse>();
    assert.equal(history.samples.length, 1);
    assert.equal(history.samples[0]?.serverfps, 58);
  });
});
