import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { ActionResponse, AuditResponse, BansResponse } from '@palsentry/shared';
import { createTestApp, signIn, type TestApp } from './helpers/test-app.js';

const apps: TestApp[] = [];

async function makeApp(options: Parameters<typeof createTestApp>[0] = {}): Promise<TestApp> {
  const app = await createTestApp(options);
  apps.push(app);
  return app;
}

/** An app with destructive actions explicitly disabled for gate-denial tests. */
async function makeSafeApp(options: Parameters<typeof createTestApp>[0] = {}): Promise<TestApp> {
  return makeApp({
    ...options,
    env: { PALSENTRY_ALLOW_DESTRUCTIVE: 'false', ...options.env },
  });
}

/** An app with destructive actions enabled, which is what most action tests need. */
async function makeDestructiveApp(
  options: Parameters<typeof createTestApp>[0] = {},
): Promise<TestApp> {
  return makeApp({
    ...options,
    env: { PALSENTRY_ALLOW_DESTRUCTIVE: 'true', ...options.env },
  });
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()));
});

/** POST a JSON action and return its status plus parsed body. */
async function post(
  app: TestApp['app'],
  url: string,
  cookie: string,
  payload: Record<string, unknown> = {},
): Promise<{ status: number; json: <T>() => T; raw: string }> {
  const response = await app.inject({
    method: 'POST',
    url,
    headers: { cookie, 'content-type': 'application/json' },
    payload,
  });
  return {
    status: response.statusCode,
    json: <T>() => response.json<T>(),
    raw: response.body,
  };
}

describe('the destructive-action gate', () => {
  const DESTRUCTIVE = [
    { url: '/api/actions/kick', payload: { userid: 'USER-1' } },
    { url: '/api/actions/ban', payload: { userid: 'USER-1' } },
    { url: '/api/actions/unban', payload: { userid: 'USER-1' } },
    { url: '/api/actions/shutdown', payload: { waittime: 5 } },
    { url: '/api/actions/stop', payload: {} },
  ];

  for (const { url, payload } of DESTRUCTIVE) {
    it(`refuses ${url} while PALSENTRY_ALLOW_DESTRUCTIVE is off`, async () => {
      const { app } = await makeSafeApp();
      const cookie = await signIn(app);

      const response = await post(app, url, cookie, payload);

      assert.equal(response.status, 403);
      const body = response.json<{ error: { code: string; message: string } }>();
      assert.equal(body.error.code, 'forbidden');
      assert.match(body.error.message, /PALSENTRY_ALLOW_DESTRUCTIVE/);
    });

    it(`does not reach the game server for ${url}`, async () => {
      const { app, stub } = await makeSafeApp();
      const cookie = await signIn(app);

      await post(app, url, cookie, payload);

      const path = url.replace('/api/actions', '');
      assert.equal(
        stub.requestsFor(path).length,
        0,
        'a blocked action must never be forwarded upstream',
      );
    });
  }

  it('allows announce and save while the destructive gate is off', async () => {
    const { app, stub } = await makeSafeApp();
    const cookie = await signIn(app);

    assert.equal((await post(app, '/api/actions/announce', cookie, { message: 'hi' })).status, 200);
    assert.equal((await post(app, '/api/actions/save', cookie)).status, 200);
    assert.equal(stub.requestsFor('/announce').length, 1);
    assert.equal(stub.requestsFor('/save').length, 1);
  });

  it('audits a blocked attempt so it is visible in the trail', async () => {
    const { app } = await makeSafeApp();
    const cookie = await signIn(app);

    await post(app, '/api/actions/stop', cookie);

    const audit = (
      await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie } })
    ).json<AuditResponse>();

    const blocked = audit.entries.find((entry) => entry.action === 'stop');
    assert.ok(blocked !== undefined, 'the blocked attempt should be recorded');
    assert.equal(blocked.ok, false);
    assert.equal(blocked.httpStatus, 403);
    assert.match(blocked.error ?? '', /Blocked/);
  });

  it('allows destructive actions once the flag is enabled', async () => {
    const { app, stub } = await makeDestructiveApp();
    const cookie = await signIn(app);

    assert.equal((await post(app, '/api/actions/kick', cookie, { userid: 'USER-1' })).status, 200);
    assert.equal(stub.requestsFor('/kick').length, 1);
  });
});

describe('action payloads', () => {
  it('forwards a broadcast message verbatim', async () => {
    const { app, stub } = await makeApp();
    const cookie = await signIn(app);

    await post(app, '/api/actions/announce', cookie, { message: 'Server restart in 5 minutes' });

    assert.deepEqual(JSON.parse(stub.requestsFor('/announce')[0]?.body ?? '{}'), {
      message: 'Server restart in 5 minutes',
    });
  });

  it('forwards kick with and without a message', async () => {
    const { app, stub } = await makeDestructiveApp();
    const cookie = await signIn(app);

    await post(app, '/api/actions/kick', cookie, { userid: 'USER-1' });
    await post(app, '/api/actions/kick', cookie, { userid: 'USER-2', message: 'Read the rules' });

    const requests = stub.requestsFor('/kick');
    assert.deepEqual(JSON.parse(requests[0]?.body ?? '{}'), { userid: 'USER-1' });
    assert.deepEqual(JSON.parse(requests[1]?.body ?? '{}'), {
      userid: 'USER-2',
      message: 'Read the rules',
    });
  });

  it('omits an empty message rather than sending a blank line', async () => {
    const { app, stub } = await makeDestructiveApp();
    const cookie = await signIn(app);

    await post(app, '/api/actions/kick', cookie, { userid: 'USER-1', message: '' });

    assert.deepEqual(JSON.parse(stub.requestsFor('/kick')[0]?.body ?? '{}'), { userid: 'USER-1' });
  });

  it('forwards shutdown with waittime and message', async () => {
    const { app, stub } = await makeDestructiveApp();
    const cookie = await signIn(app);

    await post(app, '/api/actions/shutdown', cookie, { waittime: 60, message: 'Back soon' });

    assert.deepEqual(JSON.parse(stub.requestsFor('/shutdown')[0]?.body ?? '{}'), {
      waittime: 60,
      message: 'Back soon',
    });
  });

  it('strips a ban reason and player name from the upstream payload', async () => {
    const { app, stub } = await makeDestructiveApp();
    const cookie = await signIn(app);

    await post(app, '/api/actions/ban', cookie, {
      userid: 'USER-1',
      message: 'cheating',
      playerName: 'Alice',
      reason: 'duping',
    });

    // The Palworld API only accepts userid + message; the extra fields are registry metadata.
    assert.deepEqual(JSON.parse(stub.requestsFor('/ban')[0]?.body ?? '{}'), {
      userid: 'USER-1',
      message: 'cheating',
    });
  });

  it('returns a consistent response shape', async () => {
    const { app } = await makeDestructiveApp();
    const cookie = await signIn(app);

    const response = await post(app, '/api/actions/kick', cookie, { userid: 'USER-1' });
    const body = response.json<ActionResponse>();

    assert.equal(body.ok, true);
    assert.equal(body.action, 'kick');
    assert.equal(body.target, 'USER-1');
    assert.match(body.message, /kicked/i);
    assert.ok(typeof body.durationMs === 'number' && body.durationMs >= 0);
  });
});

describe('action validation', () => {
  it('requires a message for announce', async () => {
    const { app } = await makeApp();
    const cookie = await signIn(app);

    const response = await post(app, '/api/actions/announce', cookie, {});
    assert.equal(response.status, 400);
    const body = response.json<{ error: { code: string; fields?: Record<string, string> } }>();
    assert.equal(body.error.code, 'validation');
    assert.ok(body.error.fields?.message !== undefined);
  });

  it('rejects a blank announce message', async () => {
    const { app } = await makeApp();
    const cookie = await signIn(app);

    const response = await post(app, '/api/actions/announce', cookie, { message: '   ' });
    assert.equal(response.status, 400);
  });

  it('rejects an over-long message', async () => {
    const { app } = await makeApp();
    const cookie = await signIn(app);

    const response = await post(app, '/api/actions/announce', cookie, { message: 'x'.repeat(201) });
    assert.equal(response.status, 400);
  });

  it('requires a userid for kick, ban, and unban', async () => {
    const { app } = await makeDestructiveApp();
    const cookie = await signIn(app);

    for (const url of ['/api/actions/kick', '/api/actions/ban', '/api/actions/unban']) {
      const response = await post(app, url, cookie, {});
      assert.equal(response.status, 400, `${url} should require a userid`);
    }
  });

  it('rejects a negative waittime', async () => {
    const { app } = await makeDestructiveApp();
    const cookie = await signIn(app);

    const response = await post(app, '/api/actions/shutdown', cookie, { waittime: -1 });
    assert.equal(response.status, 400);
  });

  it('rejects an absurd waittime', async () => {
    const { app } = await makeDestructiveApp();
    const cookie = await signIn(app);

    const response = await post(app, '/api/actions/shutdown', cookie, { waittime: 99_999 });
    assert.equal(response.status, 400);
  });

  it('rejects a non-numeric waittime', async () => {
    const { app } = await makeDestructiveApp();
    const cookie = await signIn(app);

    const response = await post(app, '/api/actions/shutdown', cookie, { waittime: 'soon' });
    assert.equal(response.status, 400);
  });

  it('validates before checking the destructive flag ordering is irrelevant to security', async () => {
    // A malformed body against a gated action should not leak whether the action is enabled;
    // either 400 or 403 is acceptable, but it must not be a 200 or a 500.
    const { app } = await makeApp();
    const cookie = await signIn(app);

    const response = await post(app, '/api/actions/kick', cookie, { userid: '' });
    assert.ok([400, 403].includes(response.status), `unexpected status ${response.status}`);
  });
});

describe('ban registry integration', () => {
  it('records a ban and surfaces it in the bans list', async () => {
    const { app } = await makeDestructiveApp();
    const cookie = await signIn(app);

    const ban = await post(app, '/api/actions/ban', cookie, {
      userid: 'USER-1',
      playerName: 'Alice',
      reason: 'griefing spawn',
      message: 'Banned for griefing',
    });
    assert.equal(ban.status, 200);

    const bans = (
      await app.inject({ method: 'GET', url: '/api/bans', headers: { cookie } })
    ).json<BansResponse>();

    assert.equal(bans.bans.length, 1);
    assert.equal(bans.bans[0]?.userid, 'USER-1');
    assert.equal(bans.bans[0]?.playerName, 'Alice');
    assert.equal(bans.bans[0]?.reason, 'griefing spawn');
    assert.equal(bans.bans[0]?.active, true);
    assert.equal(bans.bans[0]?.actorName, 'admin', 'attributed to the signed-in session');
    assert.ok(bans.bans[0]?.bannedAt !== undefined);
  });

  it('falls back to the message when no explicit reason is given', async () => {
    const { app } = await makeDestructiveApp();
    const cookie = await signIn(app);

    await post(app, '/api/actions/ban', cookie, { userid: 'USER-1', message: 'cheating' });

    const bans = (
      await app.inject({ method: 'GET', url: '/api/bans', headers: { cookie } })
    ).json<BansResponse>();
    assert.equal(bans.bans[0]?.reason, 'cheating');
  });

  it('deactivates the ban when the player is unbanned', async () => {
    const { app } = await makeDestructiveApp();
    const cookie = await signIn(app);

    await post(app, '/api/actions/ban', cookie, { userid: 'USER-1', reason: 'first' });
    const unban = await post(app, '/api/actions/unban', cookie, { userid: 'USER-1' });
    assert.equal(unban.status, 200);

    const bans = (
      await app.inject({ method: 'GET', url: '/api/bans', headers: { cookie } })
    ).json<BansResponse>();

    assert.equal(bans.bans.length, 1, 'the episode is kept for history');
    assert.equal(bans.bans[0]?.active, false);
    assert.ok(bans.bans[0]?.unbannedAt !== null);
  });

  it('keeps both episodes when a player is banned, unbanned, and banned again', async () => {
    const { app } = await makeDestructiveApp();
    const cookie = await signIn(app);

    await post(app, '/api/actions/ban', cookie, { userid: 'USER-1', reason: 'first offence' });
    await post(app, '/api/actions/unban', cookie, { userid: 'USER-1' });
    await post(app, '/api/actions/ban', cookie, { userid: 'USER-1', reason: 'second offence' });

    const bans = (
      await app.inject({ method: 'GET', url: '/api/bans', headers: { cookie } })
    ).json<BansResponse>();

    assert.equal(bans.bans.length, 2, 'history is preserved');
    assert.equal(bans.bans.filter((ban) => ban.active).length, 1, 'exactly one active episode');
  });

  it('re-banning an already-banned player updates the open episode instead of duplicating it', async () => {
    const { app } = await makeDestructiveApp();
    const cookie = await signIn(app);

    await post(app, '/api/actions/ban', cookie, { userid: 'USER-1', reason: 'first' });
    await post(app, '/api/actions/ban', cookie, { userid: 'USER-1', reason: 'updated' });

    const bans = (
      await app.inject({ method: 'GET', url: '/api/bans', headers: { cookie } })
    ).json<BansResponse>();

    assert.equal(bans.bans.length, 1);
    assert.equal(bans.bans[0]?.reason, 'updated');
  });

  it('does not record a ban when the game server rejects it', async () => {
    const { app } = await makeDestructiveApp({
      stub: {
        handler: ({ res, path }) => {
          if (path === '/ban') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end('no such player');
            return;
          }
          res.writeHead(404).end();
        },
      },
    });
    const cookie = await signIn(app);

    const response = await post(app, '/api/actions/ban', cookie, { userid: 'USER-1' });
    assert.equal(response.status, 400);

    const bans = (
      await app.inject({ method: 'GET', url: '/api/bans', headers: { cookie } })
    ).json<BansResponse>();
    assert.deepEqual(bans.bans, [], 'the registry must not claim a ban that never took effect');
  });
});

describe('audit trail', () => {
  it('records a successful action with actor, target, and duration', async () => {
    const { app } = await makeApp();
    const cookie = await signIn(app);

    await post(app, '/api/actions/announce', cookie, { message: 'hello' });

    const audit = (
      await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie } })
    ).json<AuditResponse>();

    const entry = audit.entries.find((item) => item.action === 'announce');
    assert.ok(entry !== undefined);
    assert.equal(entry.ok, true);
    assert.equal(entry.actorName, 'admin');
    assert.equal(entry.httpStatus, 200);
    assert.deepEqual(entry.payload, { message: 'hello' });
    assert.equal(entry.error, null);
    assert.ok(entry.durationMs !== null && entry.durationMs >= 0);
  });

  it('records a failed action with the upstream error', async () => {
    const { app } = await makeDestructiveApp({ palworldUrl: 'http://127.0.0.1:9' });
    const cookie = await signIn(app);

    await post(app, '/api/actions/kick', cookie, { userid: 'USER-1' });

    const audit = (
      await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie } })
    ).json<AuditResponse>();

    const entry = audit.entries.find((item) => item.action === 'kick');
    assert.ok(entry !== undefined);
    assert.equal(entry.ok, false);
    assert.equal(entry.httpStatus, 502);
    assert.match(entry.error ?? '', /Connection refused|Could not reach/);
    assert.equal(entry.target, 'USER-1');
  });

  it('orders entries newest first', async () => {
    const { app } = await makeApp();
    const cookie = await signIn(app);

    await post(app, '/api/actions/announce', cookie, { message: 'first' });
    await post(app, '/api/actions/save', cookie);

    const audit = (
      await app.inject({ method: 'GET', url: '/api/audit', headers: { cookie } })
    ).json<AuditResponse>();

    assert.equal(audit.entries[0]?.action, 'save', 'the most recent action comes first');
    assert.equal(audit.entries[1]?.action, 'announce');
  });

  it('filters by action', async () => {
    const { app } = await makeApp();
    const cookie = await signIn(app);

    await post(app, '/api/actions/announce', cookie, { message: 'a' });
    await post(app, '/api/actions/save', cookie);

    const audit = (
      await app.inject({ method: 'GET', url: '/api/audit?action=announce', headers: { cookie } })
    ).json<AuditResponse>();

    assert.equal(audit.entries.length, 1);
    assert.equal(audit.entries[0]?.action, 'announce');
  });

  it('filters by target', async () => {
    const { app } = await makeDestructiveApp();
    const cookie = await signIn(app);

    await post(app, '/api/actions/kick', cookie, { userid: 'USER-1' });
    await post(app, '/api/actions/kick', cookie, { userid: 'USER-2' });

    const audit = (
      await app.inject({ method: 'GET', url: '/api/audit?target=USER-2', headers: { cookie } })
    ).json<AuditResponse>();

    assert.equal(audit.entries.length, 1);
    assert.equal(audit.entries[0]?.target, 'USER-2');
  });

  it('filters by outcome', async () => {
    const { app } = await makeSafeApp();
    const cookie = await signIn(app);

    await post(app, '/api/actions/announce', cookie, { message: 'ok' });
    await post(app, '/api/actions/stop', cookie); // blocked → failure

    const failures = (
      await app.inject({ method: 'GET', url: '/api/audit?ok=false', headers: { cookie } })
    ).json<AuditResponse>();

    assert.ok(failures.entries.length >= 1);
    assert.ok(failures.entries.every((entry) => !entry.ok));
  });

  it('paginates', async () => {
    const { app } = await makeApp();
    const cookie = await signIn(app);

    for (let index = 0; index < 5; index += 1) {
      await post(app, '/api/actions/announce', cookie, { message: `msg ${index}` });
    }

    const firstPage = (
      await app.inject({ method: 'GET', url: '/api/audit?limit=2&offset=0', headers: { cookie } })
    ).json<AuditResponse>();
    const secondPage = (
      await app.inject({ method: 'GET', url: '/api/audit?limit=2&offset=2', headers: { cookie } })
    ).json<AuditResponse>();

    assert.equal(firstPage.entries.length, 2);
    assert.equal(firstPage.total, 5);
    assert.equal(firstPage.limit, 2);
    assert.equal(secondPage.entries.length, 2);
    assert.notEqual(firstPage.entries[0]?.id, secondPage.entries[0]?.id, 'pages must not overlap');
  });

  it('rejects an oversized limit', async () => {
    const { app } = await makeApp();
    const cookie = await signIn(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/audit?limit=100000',
      headers: { cookie },
    });
    assert.equal(response.statusCode, 400);
  });
});

describe('bans registry routes', () => {
  it('requires authentication', async () => {
    const { app } = await makeApp();
    const response = await app.inject({ method: 'GET', url: '/api/bans' });
    assert.equal(response.statusCode, 401);
  });

  it('deletes a registry row without calling unban upstream', async () => {
    const { app, stub } = await makeDestructiveApp();
    const cookie = await signIn(app);

    await post(app, '/api/actions/ban', cookie, { userid: 'USER-1' });

    const bans = (
      await app.inject({ method: 'GET', url: '/api/bans', headers: { cookie } })
    ).json<BansResponse>();
    const id = bans.bans[0]?.id;
    assert.ok(id !== undefined);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/bans/${id}`,
      headers: { cookie },
    });
    assert.equal(response.statusCode, 204);

    const after = (
      await app.inject({ method: 'GET', url: '/api/bans', headers: { cookie } })
    ).json<BansResponse>();
    assert.deepEqual(after.bans, []);

    // Forgetting bookkeeping must not unban anyone on the game server.
    assert.equal(stub.requestsFor('/unban').length, 0);
  });

  it('returns 404 deleting an unknown row', async () => {
    const { app } = await makeDestructiveApp();
    const cookie = await signIn(app);

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/bans/99999',
      headers: { cookie },
    });
    assert.equal(response.statusCode, 404);
  });
});
