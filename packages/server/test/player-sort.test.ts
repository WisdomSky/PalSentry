import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EnrichedPlayer, OnlineEnrichedPlayer } from '@palsentry/shared';
import { DEFAULT_ROSTER_SORT, sortPlayers } from '@palsentry/shared';

/**
 * Tests for the roster table ordering in `@palsentry/shared`.
 *
 * The table mixes connected players, which have live session values, with remembered players,
 * which do not. Getting that mixture wrong is easy and invisible in a screenshot — an inverted
 * sort still renders a tidy table — so the ordering is pinned down here rather than by eye.
 */

function online(overrides: Partial<OnlineEnrichedPlayer> = {}): OnlineEnrichedPlayer {
  return {
    name: 'Online',
    accountName: 'online_steam',
    playerId: 'PLAYER-ON',
    userId: 'USER-ON',
    location_x: 0,
    location_y: 0,
    level: 10,
    banned: false,
    banReason: null,
    bannedAt: null,
    lastOnline: '2026-09-21T12:00:00.000Z',
    online: true,
    ip: '10.0.0.1',
    ping: 20,
    building_count: 100,
    ...overrides,
  };
}

function offline(overrides: Partial<EnrichedPlayer> = {}): EnrichedPlayer {
  return {
    name: 'Offline',
    accountName: 'offline_steam',
    playerId: 'PLAYER-OFF',
    userId: 'USER-OFF',
    location_x: 0,
    location_y: 0,
    level: 10,
    banned: false,
    banReason: null,
    bannedAt: null,
    lastOnline: '2026-09-20T12:00:00.000Z',
    online: false,
    ip: null,
    ping: null,
    building_count: null,
    ...overrides,
  } as EnrichedPlayer;
}

/** Names in table order, which is what the assertions actually care about. */
function names(players: readonly EnrichedPlayer[], sort: Parameters<typeof sortPlayers>[1]) {
  return sortPlayers(players, sort).map((player) => player.name);
}

describe('default roster order', () => {
  it('opens on recency, descending', () => {
    assert.deepEqual(DEFAULT_ROSTER_SORT, { key: 'lastOnline', ascending: false });
  });

  it('puts everyone who is online above everyone who is not', () => {
    const players = [
      offline({ name: 'Yesterday', lastOnline: '2026-09-20T12:00:00.000Z' }),
      online({ name: 'Connected' }),
      offline({ name: 'LastWeek', lastOnline: '2026-09-14T12:00:00.000Z' }),
    ];

    assert.deepEqual(names(players, DEFAULT_ROSTER_SORT), ['Connected', 'Yesterday', 'LastWeek']);
  });

  it('puts a stale online row above a fresher offline one', () => {
    // The staleness is the point: "is this player here right now" outranks "when were they here".
    const players = [
      offline({ name: 'JustLeft', lastOnline: '2026-09-21T11:59:59.000Z' }),
      online({ name: 'Connected', lastOnline: '2026-09-21T11:00:00.000Z' }),
    ];

    assert.deepEqual(names(players, DEFAULT_ROSTER_SORT), ['Connected', 'JustLeft']);
  });

  it('orders remembered players from most to least recent', () => {
    const players = [
      offline({ name: 'NineDays', lastOnline: '2026-09-12T12:00:00.000Z' }),
      offline({ name: 'AnHour', lastOnline: '2026-09-21T11:00:00.000Z' }),
      offline({ name: 'AWeek', lastOnline: '2026-09-14T12:00:00.000Z' }),
    ];

    assert.deepEqual(names(players, DEFAULT_ROSTER_SORT), ['AnHour', 'AWeek', 'NineDays']);
  });

  it('breaks same-snapshot ties by name, so the order is stable between polls', () => {
    // Every player in one snapshot shares a timestamp, so ties are the normal case; without a
    // total tie-break the table would reshuffle on every poll.
    const players = [
      online({ name: 'Zoe', userId: 'USER-Z' }),
      online({ name: 'adam', userId: 'USER-A2' }),
      online({ name: 'Adam', userId: 'USER-A1' }),
    ];

    const first = names(players, DEFAULT_ROSTER_SORT);
    const reversed = names([...players].reverse(), DEFAULT_ROSTER_SORT);

    assert.deepEqual(first, reversed, 'arrival order must not decide the tie');
    assert.equal(first[2], 'Zoe', 'the alphabetically last name sorts last');
  });

  it('reverses the whole ordering when the column is flipped', () => {
    const players = [
      online({ name: 'Connected' }),
      offline({ name: 'Yesterday', lastOnline: '2026-09-20T12:00:00.000Z' }),
      offline({ name: 'LastWeek', lastOnline: '2026-09-14T12:00:00.000Z' }),
    ];

    assert.deepEqual(names(players, { key: 'lastOnline', ascending: true }), [
      'LastWeek',
      'Yesterday',
      'Connected',
    ]);
  });

  it('does not mutate the array it was given', () => {
    const players = [offline({ name: 'Offline' }), online({ name: 'Connected' })];
    const before = [...players];

    sortPlayers(players, DEFAULT_ROSTER_SORT);
    assert.deepEqual(players, before);
  });
});

describe('roster ordering by other columns', () => {
  it('sorts by level in both directions', () => {
    const players = [
      online({ name: 'Mid', level: 20 }),
      online({ name: 'Low', level: 5 }),
      online({ name: 'High', level: 42 }),
    ];

    assert.deepEqual(names(players, { key: 'level', ascending: true }), ['Low', 'Mid', 'High']);
    assert.deepEqual(names(players, { key: 'level', ascending: false }), ['High', 'Mid', 'Low']);
  });

  it('sorts by name case-insensitively', () => {
    const players = [online({ name: 'bob' }), online({ name: 'Alice' }), online({ name: 'Carol' })];

    assert.deepEqual(names(players, { key: 'name', ascending: true }), ['Alice', 'bob', 'Carol']);
  });

  it('parks players with no ping at the end of either direction', () => {
    // A disconnected player has no ping at all; treating that as 0 would sort them as the best
    // connection on the server.
    const players = [
      offline({ name: 'Gone' }),
      online({ name: 'Fast', ping: 15 }),
      online({ name: 'Slow', ping: 200 }),
    ];

    assert.deepEqual(names(players, { key: 'ping', ascending: true }), ['Fast', 'Slow', 'Gone']);
    assert.deepEqual(names(players, { key: 'ping', ascending: false }), ['Slow', 'Fast', 'Gone']);
  });

  it('parks players with no building count at the end of either direction', () => {
    const players = [
      offline({ name: 'Gone' }),
      online({ name: 'Builder', building_count: 400 }),
      online({ name: 'Newcomer', building_count: 2 }),
    ];

    assert.deepEqual(names(players, { key: 'building_count', ascending: true }), [
      'Newcomer',
      'Builder',
      'Gone',
    ]);
    assert.deepEqual(names(players, { key: 'building_count', ascending: false }), [
      'Builder',
      'Newcomer',
      'Gone',
    ]);
  });

  it('keeps every offline row after every online row regardless of key', () => {
    // Level is a roster fact, so an offline veteran legitimately outranks an online newcomer —
    // what must not happen is the offline row being dropped or duplicated.
    const players = [
      online({ name: 'Newcomer', level: 2 }),
      offline({ name: 'Veteran', level: 50 }),
    ];

    assert.deepEqual(names(players, { key: 'level', ascending: false }), ['Veteran', 'Newcomer']);
    assert.equal(sortPlayers(players, { key: 'level', ascending: false }).length, 2);
  });
});
