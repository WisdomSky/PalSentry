/**
 * Raw and normalised types for the official Palworld dedicated-server REST API.
 *
 * Reference: https://docs.palworldgame.com/category/rest-api (documented against v1.0.4)
 *
 * The API is served from `http://<host>:<RESTAPIPort>/v1/api` and requires HTTP Basic auth
 * with the username `admin` and the value of `AdminPassword` from `PalWorldSettings.ini`.
 * It is only available when `RESTAPIEnabled=True`.
 */

/** `GET /info` */
export interface PalworldInfo {
  version: string;
  servername: string;
  description: string;
  worldguid: string;
}

/**
 * `GET /players`
 *
 * `userId` is the stable account identifier and is what `/kick` and `/ban` expect in their
 * `userid` field. `playerId` is the transient in-world entity id and changes between sessions.
 */
export interface PalworldPlayer {
  name: string;
  accountName: string;
  playerId: string;
  userId: string;
  ip: string;
  ping: number;
  location_x: number;
  location_y: number;
  level: number;
  building_count: number;
}

export interface PalworldPlayersResponse {
  players: PalworldPlayer[];
}

/** A guild base terminal (`Type: "PalBox"`) normalized from `GET /game-data`. */
export interface PalworldGuildBase {
  /** Stable actor ID, or a deterministic coordinate/guild fallback when the upstream ID is absent. */
  id: string;
  guildId: string;
  /** Human-readable owner shown by map marker tooltips. */
  guildName: string;
  location_x: number;
  location_y: number;
}

/**
 * `GET /metrics` as actually returned.
 *
 * Field names drift between server versions: older builds report `serveruptime` where newer
 * ones report `uptime`. Everything is optional here and normalised by
 * {@link PalworldMetrics} so a version mismatch degrades instead of throwing.
 */
export interface PalworldMetricsRaw {
  serverfps?: number;
  currentplayernum?: number;
  serverframetime?: number;
  maxplayernum?: number;
  uptime?: number;
  serveruptime?: number;
  basecampnum?: number;
  days?: number;
}

/** `GET /metrics`, normalised to a stable shape with sensible zero defaults. */
export interface PalworldMetrics {
  serverfps: number;
  currentplayernum: number;
  serverframetime: number;
  maxplayernum: number;
  uptime: number;
  basecampnum: number;
  days: number;
}

/**
 * `GET /settings`
 *
 * A flat dump of the resolved `PalWorldSettings.ini`. Read-only: the REST API cannot write it.
 */
export type PalworldSettings = Record<string, string | number | boolean>;

/** POST bodies accepted by the Palworld REST API. */
export interface PalworldAnnounceBody {
  message: string;
}
export interface PalworldKickBody {
  userid: string;
  message?: string;
}
export interface PalworldBanBody {
  userid: string;
  message?: string;
}
export interface PalworldUnbanBody {
  userid: string;
}
export interface PalworldShutdownBody {
  waittime: number;
  message?: string;
}

/** Normalise a raw `/metrics` payload into {@link PalworldMetrics}. */
export function normaliseMetrics(raw: PalworldMetricsRaw | null | undefined): PalworldMetrics {
  const num = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return {
    serverfps: num(raw?.serverfps),
    currentplayernum: num(raw?.currentplayernum),
    serverframetime: num(raw?.serverframetime),
    maxplayernum: num(raw?.maxplayernum),
    // `uptime` is the documented name; `serveruptime` appears in some builds.
    uptime: num(raw?.uptime ?? raw?.serveruptime),
    basecampnum: num(raw?.basecampnum),
    days: num(raw?.days),
  };
}
