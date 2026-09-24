import type { MapLayerId, MapProjection } from './map.js';
import type {
  PalworldGuildBase,
  PalworldInfo,
  PalworldMetrics,
  PalworldSettings,
} from './palworld.js';

/** Every action PalSentry can perform. Used for routing, audit records, and the UI. */
export type ActionName =
  'announce' | 'save' | 'kick' | 'ban' | 'unban' | 'shutdown' | 'stop' | 'restart';

/**
 * Actions gated by `PALSENTRY_ALLOW_DESTRUCTIVE`.
 *
 * `announce` and `save` are always allowed: neither can disconnect a player or take the
 * server down. `restart` is included because it necessarily stops the server.
 */
export const DESTRUCTIVE_ACTIONS: readonly ActionName[] = [
  'kick',
  'ban',
  'unban',
  'shutdown',
  'stop',
  'restart',
];

export function isDestructiveAction(action: ActionName): boolean {
  return DESTRUCTIVE_ACTIONS.includes(action);
}

/** Machine-readable error codes shared by every API response. */
export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'validation'
  | 'not_found'
  | 'rate_limited'
  | 'conflict'
  | 'unreachable'
  | 'timeout'
  | 'palworld_error'
  | 'internal';

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Palworld HTTP status when the failure originated upstream. */
    upstreamStatus?: number;
    /** Field-level messages for `validation` errors. */
    fields?: Record<string, string>;
  };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface LoginRequest {
  username: string;
  password: string;
}

export interface SessionUser {
  username: string;
}

export interface MeResponse {
  authenticated: boolean;
  user: SessionUser | null;
  /**
   * True when the desktop app is hosting this server.
   *
   * There is no login in that mode: "authenticated" means "connected to a Palworld server", and
   * the SPA renders the connection screen instead of the sign-in form.
   */
  desktop: boolean;
}

// ---------------------------------------------------------------------------
// Desktop connection
// ---------------------------------------------------------------------------

/** What the desktop connection screen needs to render itself. */
export interface ConnectionStatusResponse {
  /** Always true — the route only exists in desktop mode. */
  desktop: boolean;
  /** True once a Palworld connection has been probed and accepted. */
  configured: boolean;
  /** Last accepted REST URL, kept so the form can prefill it. Never includes a password. */
  restUrl: string | null;
  /** Basic-auth username used for the REST API. */
  username: string;
}

/** Body of the desktop connect request. The password is used once and never stored. */
export interface ConnectionRequest {
  restUrl: string;
  adminPassword: string;
  username?: string;
}

// ---------------------------------------------------------------------------
// Meta / capabilities
// ---------------------------------------------------------------------------

export interface MapLayerMeta {
  /** Bundled texture by default; operator override when configured; null selects the grid. */
  textureUrl: string | null;
}

export interface MapMeta {
  projection: MapProjection;
  layers: Record<MapLayerId, MapLayerMeta>;
}

export interface MetaResponse {
  app: {
    version: string;
    /** False in desktop mode, where the Palworld connection replaces the PalSentry login. */
    authEnabled: boolean;
    /** True when the desktop app is hosting this server. */
    desktop: boolean;
  };
  /** `PALSENTRY_ALLOW_DESTRUCTIVE` — when false the UI disables and the API rejects these. */
  destructiveAllowed: boolean;
  map: MapMeta;
  polling: {
    defaultIntervalMs: number;
    options: number[];
  };
  history: {
    retentionDays: number;
    sampleIntervalSeconds: number;
    /**
     * Cadence wayback position recording is running at, from
     * `PALSENTRY_WAYBACK_INTERVAL_SECONDS`. Read-only for the SPA: it explains how dense a replay
     * can be, and how fast a running recorder adds new observations.
     */
    waybackIntervalSeconds: number;
  };
  restart: {
    defaultWaitSeconds: number;
  };
}

export interface HealthResponse {
  status: 'ok';
  version: string;
  uptimeSeconds: number;
}

// ---------------------------------------------------------------------------
// Server status
// ---------------------------------------------------------------------------

export interface StatusResponse {
  /** False when the Palworld server could not be reached. */
  online: boolean;
  checkedAt: string;
  /** Round-trip time to the Palworld API in milliseconds, null when offline. */
  latencyMs: number | null;
  info: PalworldInfo | null;
  metrics: PalworldMetrics | null;
  error: { code: ApiErrorCode; message: string } | null;
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

/**
 * What PalSentry knows about a player.
 *
 * The roster outlives the session: `/players` only reports who is connected right now, so these
 * are the fields worth keeping for everyone PalSentry has ever seen. Live connection details are
 * added by the two variants below rather than held here, so a stale IP address cannot be mistaken
 * for a current one.
 */
export interface PlayerIdentity {
  name: string;
  accountName: string;
  /** Transient per-session actor id; not usable across sessions. */
  playerId: string;
  /** Stable account id. This is what moderation and map tracking target. */
  userId: string;
  location_x: number;
  location_y: number;
  level: number;
  /** True when PalSentry's registry has an active ban for this `userId`. */
  banned: boolean;
  banReason: string | null;
  bannedAt: string | null;
  /** ISO-8601 instant of the most recent successful snapshot this player appeared in. */
  lastOnline: string;
}

/** A player who is connected right now. */
export interface OnlineEnrichedPlayer extends PlayerIdentity {
  online: true;
  ip: string;
  ping: number;
  building_count: number;
}

/**
 * A player the roster remembers who is not connected right now.
 *
 * The last known position is kept — it is where they logged off, which is genuinely useful — but
 * IP address, ping, and building count describe a live session and are deliberately absent.
 */
export interface OfflineEnrichedPlayer extends PlayerIdentity {
  online: false;
  ip: null;
  ping: null;
  building_count: null;
}

/** A roster entry, online or not. Narrow on `online` before using session-only fields. */
export type EnrichedPlayer = OnlineEnrichedPlayer | OfflineEnrichedPlayer;

/** Narrow a roster entry to the online variant, for filters and type guards. */
export function isOnlinePlayer(player: EnrichedPlayer): player is OnlineEnrichedPlayer {
  return player.online;
}

export interface PlayersResponse {
  /**
   * True when the roster was refreshed from a successful live read.
   *
   * False means PalSentry could not ask the game server, so `players` is the last known roster
   * with every entry reported offline rather than an empty list or a set of confident lies.
   */
  online: boolean;
  players: EnrichedPlayer[];
  checkedAt: string;
  error: { code: ApiErrorCode; message: string } | null;
}

// ---------------------------------------------------------------------------
// Guild bases
// ---------------------------------------------------------------------------

export interface BasesResponse {
  /** False when the optional Palworld game-data API is disabled or temporarily unavailable. */
  available: boolean;
  bases: PalworldGuildBase[];
  checkedAt: string;
  error: { code: ApiErrorCode; message: string } | null;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface SettingsResponse {
  settings: PalworldSettings;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export interface AnnounceRequest {
  message: string;
}

export interface KickRequest {
  userid: string;
  message?: string;
}

export interface BanRequest {
  userid: string;
  message?: string;
  /** Optional label stored in the registry so the bans list is human-readable. */
  playerName?: string;
  reason?: string;
}

export interface UnbanRequest {
  userid: string;
}

export interface ShutdownRequest {
  waittime: number;
  message?: string;
}

export interface ActionResponse {
  ok: true;
  action: ActionName;
  target: string | null;
  message: string;
  /** Milliseconds the upstream call took. */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Bans registry
// ---------------------------------------------------------------------------

export interface BanRecord {
  id: number;
  userid: string;
  playerName: string | null;
  reason: string | null;
  actorName: string | null;
  actorIp: string | null;
  bannedAt: string;
  active: boolean;
  unbannedAt: string | null;
  unbannedByIp: string | null;
}

export interface BansResponse {
  bans: BanRecord[];
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: number;
  ts: string;
  actorName: string | null;
  actorIp: string | null;
  action: string;
  target: string | null;
  payload: unknown;
  httpStatus: number | null;
  ok: boolean;
  error: string | null;
  durationMs: number | null;
}

export interface AuditQuery {
  action?: string;
  actor?: string;
  target?: string;
  ok?: boolean;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface AuditResponse {
  entries: AuditEntry[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// Metrics history
// ---------------------------------------------------------------------------

export type HistoryWindow = '1h' | '6h' | '24h' | '7d' | '30d';

export const HISTORY_WINDOWS: readonly HistoryWindow[] = ['1h', '6h', '24h', '7d', '30d'];
export const DEFAULT_HISTORY_WINDOW: HistoryWindow = '6h';
/** Keep chart payloads near the width of the rendered graph. */
export const HISTORY_MAX_POINTS = 360;

/** A rolling preset or a fixed pair of absolute Unix-second boundaries. */
export type HistorySelection =
  { kind: 'window'; window: HistoryWindow } | { kind: 'range'; from: number; to: number };

export interface HistorySample {
  ts: number;
  serverfps: number;
  currentplayernum: number;
  maxplayernum: number;
  serverframetime: number;
  uptime: number;
  basecampnum: number;
  days: number;
}

export interface HistoryResponse {
  /** Normalized selection used for this response. */
  selection: HistorySelection;
  /** Preset compatibility field; null for an explicit custom range. */
  window: HistoryWindow | null;
  /** Inclusive effective Unix-second boundaries queried by the server. */
  from: number;
  to: number;
  /** Bucket size used for downsampling, in seconds. */
  bucketSeconds: number;
  samples: HistorySample[];
}

// ---------------------------------------------------------------------------
// Wayback player history
// ---------------------------------------------------------------------------

/**
 * Bounds for the wayback position-recording cadence, in seconds.
 *
 * Five seconds is the finest interval worth offering: every sample is a `/players` request the
 * game server has to serve, and each one is stored for the whole retention window. An hour is the
 * coarsest that still reads as movement rather than a series of unrelated points.
 */
export const MIN_WAYBACK_INTERVAL_SECONDS = 5;
export const MAX_WAYBACK_INTERVAL_SECONDS = 3_600;

/**
 * Default recording cadence.
 *
 * Five seconds makes a short chase legible on the map, which is the reason wayback exists; the
 * interval is deployment configuration, so an operator who values database size over detail can
 * raise it without touching the code.
 */
export const DEFAULT_WAYBACK_INTERVAL_SECONDS = MIN_WAYBACK_INTERVAL_SECONDS;

/** Wayback opens on the last day: long enough to cover a session, small enough to draw. */
export const DEFAULT_WAYBACK_WINDOW: HistoryWindow = '24h';

/**
 * One successful background observation.
 *
 * These are the exact instants PalSentry heard back from the game server, so the timeline snaps
 * to them rather than to an arbitrary grid: a selected time always describes real data.
 */
export interface WaybackSnapshot {
  ts: number;
  /** Players reported by this observation; zero is a valid, informative observation. */
  playerCount: number;
}

/** One recorded position. `ts` is the bucket the observation was folded into. */
export interface WaybackPoint {
  ts: number;
  x: number;
  y: number;
}

/**
 * One player's movement inside the requested range.
 *
 * `points` is downsampled to the response's `bucketSeconds`, so a 5-second cadence over a month
 * cannot ship hundreds of thousands of rows: each bucket keeps the player's last observation in it.
 * Snapshots are downsampled the same way, so the two agree exactly — a point whose `ts` matches a
 * snapshot's `ts` *is* that observation, which is how the UI answers "were they online at this
 * instant?" without a second request.
 */
export interface WaybackPlayerHistory {
  userId: string;
  /** The roster's current name for the account; the points carry no identity of their own. */
  name: string;
  points: WaybackPoint[];
}

export interface PlayerHistoryResponse {
  /** Normalized selection used for this response. */
  selection: HistorySelection;
  /** Preset compatibility field; null for an explicit custom range. */
  window: HistoryWindow | null;
  /** Inclusive effective Unix-second boundaries queried by the server. */
  from: number;
  to: number;
  /** Bucket size used to downsample both the snapshots and each player's points. */
  bucketSeconds: number;
  /** Successful observations inside the range, ascending. Outages leave gaps here. */
  snapshots: WaybackSnapshot[];
  players: WaybackPlayerHistory[];
}

// ---------------------------------------------------------------------------
// Restart state machine
// ---------------------------------------------------------------------------

export type RestartState =
  | 'idle'
  | 'announcing'
  | 'saving'
  | 'shutting_down'
  | 'waiting_for_process'
  | 'polling_health'
  | 'succeeded'
  | 'failed';

export interface RestartRequest {
  /** Seconds of warning players get before the server goes down. */
  waittime?: number;
  message?: string;
}

export interface RestartStatusResponse {
  state: RestartState;
  startedAt: string | null;
  finishedAt: string | null;
  waittimeSeconds: number;
  /** Milliseconds the server was unreachable, once it is back. */
  downtimeMs: number | null;
  error: string | null;
  /** Human-readable progress line for the UI. */
  detail: string;
}

/** Terminal states: the UI can stop polling once one of these is reached. */
export function isRestartSettled(state: RestartState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'idle';
}

export const DEFAULT_RESTART_WAIT_SECONDS = 30;
