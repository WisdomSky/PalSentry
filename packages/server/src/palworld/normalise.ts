import type {
  PalworldGuildBase,
  PalworldInfo,
  PalworldMetrics,
  PalworldPlayer,
  PalworldSettings,
} from '@palsentry/shared';
import { normaliseMetrics } from '@palsentry/shared';

/**
 * Tolerant parsers for Palworld REST API responses.
 *
 * The API has no formal schema guarantee and its field set drifts between server versions
 * (for example `uptime` vs `serveruptime`). Strict validation would turn a cosmetic upstream
 * change into a total outage, so these normalisers coerce what they can and drop only what is
 * genuinely unusable. Unit-tested in `test/normalise.test.ts`.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerce to a string, mapping null/undefined/objects to `''`. */
export function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * Coerce to a finite number, accepting numeric strings.
 *
 * `Number.isFinite` is checked explicitly because `Number('')` is `0` and
 * `Number('abc')` is `NaN` — neither should silently become a real measurement.
 */
export function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/** `GET /info`. Returns null when the payload is not an object at all. */
export function normaliseInfo(raw: unknown): PalworldInfo | null {
  if (!isRecord(raw)) return null;
  return {
    version: toText(raw.version),
    servername: toText(raw.servername),
    description: toText(raw.description),
    worldguid: toText(raw.worldguid),
  };
}

/**
 * One entry of `GET /players`.
 *
 * `userId` is mandatory: it is the identifier `/kick`, `/ban`, and `/unban` take, so a player
 * row without one could be displayed but never acted on. Those rows are dropped rather than
 * shown as a dead end.
 */
export function normalisePlayer(raw: unknown): PalworldPlayer | null {
  if (!isRecord(raw)) return null;

  const userId = toText(raw.userId);
  if (userId === '') return null;

  return {
    name: toText(raw.name) || 'Unknown',
    accountName: toText(raw.accountName),
    playerId: toText(raw.playerId),
    userId,
    ip: toText(raw.ip),
    ping: toNumber(raw.ping),
    location_x: toNumber(raw.location_x),
    location_y: toNumber(raw.location_y),
    level: toNumber(raw.level),
    building_count: toNumber(raw.building_count),
  };
}

/** The `players` array of `GET /players`, skipping unusable entries. */
export function normalisePlayers(raw: unknown): PalworldPlayer[] {
  if (!isRecord(raw)) return [];
  const list = raw.players;
  if (!Array.isArray(list)) return [];

  const players: PalworldPlayer[] = [];
  for (const entry of list) {
    const player = normalisePlayer(entry);
    if (player !== null) players.push(player);
  }
  return players;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Base terminals from the optional `GET /game-data` actor snapshot.
 *
 * `null` means the envelope itself is malformed or game-data is disabled; an empty array is a
 * valid snapshot containing no usable PalBox actors.
 */
export function normaliseGuildBases(raw: unknown): PalworldGuildBase[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.ActorData)) return null;

  const byId = new Map<string, PalworldGuildBase>();
  for (const actor of raw.ActorData) {
    if (!isRecord(actor) || toText(actor.Type).trim().toLowerCase() !== 'palbox') continue;

    const locationX = finiteNumber(actor.LocationX);
    const locationY = finiteNumber(actor.LocationY);
    if (locationX === null || locationY === null) continue;

    const guildId = toText(actor.GuildID).trim();
    const guildName = toText(actor.GuildName).trim() || 'Unknown guild';
    const instanceId = toText(actor.InstanceID).trim().toLowerCase();
    const id =
      instanceId ||
      `base:${(guildId || guildName).toLowerCase()}:${String(locationX)}:${String(locationY)}`;

    if (!byId.has(id)) {
      byId.set(id, {
        id,
        guildId,
        guildName,
        location_x: locationX,
        location_y: locationY,
      });
    }
  }

  return [...byId.values()].sort(
    (left, right) =>
      left.guildName.localeCompare(right.guildName) || left.id.localeCompare(right.id),
  );
}

/** `GET /metrics`, normalised to a stable shape (see `normaliseMetrics` in shared). */
export function normaliseMetricsResponse(raw: unknown): PalworldMetrics {
  if (!isRecord(raw)) return normaliseMetrics(null);
  return normaliseMetrics({
    serverfps: toNumber(raw.serverfps),
    currentplayernum: toNumber(raw.currentplayernum),
    serverframetime: toNumber(raw.serverframetime),
    maxplayernum: toNumber(raw.maxplayernum),
    uptime: raw.uptime === undefined ? undefined : toNumber(raw.uptime),
    serveruptime: raw.serveruptime === undefined ? undefined : toNumber(raw.serveruptime),
    basecampnum: toNumber(raw.basecampnum),
    days: toNumber(raw.days),
  });
}

/**
 * `GET /settings`.
 *
 * Keeps only primitives, since the settings browser renders values as text and a nested object
 * would have no sensible representation.
 */
export function normaliseSettings(raw: unknown): PalworldSettings {
  if (!isRecord(raw)) return {};

  const settings: PalworldSettings = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      settings[key] = value;
    } else if (value !== null && value !== undefined) {
      settings[key] = JSON.stringify(value);
    }
  }
  return settings;
}

/** Decode a JSON response body, returning null instead of throwing on malformed input. */
export function parseJson(text: string): unknown {
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
