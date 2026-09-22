import type {
  PalworldGuildBase,
  PalworldInfo,
  PalworldMetrics,
  PalworldPlayer,
  PalworldSettings,
} from '@palsentry/shared';
import { unconfiguredPalworldConfig, type PalworldConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { SingleFlightCache } from './cache.js';
import { PalworldError, describeFetchFailure } from './errors.js';
import {
  normaliseGuildBases,
  normaliseInfo,
  normaliseMetricsResponse,
  normalisePlayers,
  normaliseSettings,
  parseJson,
} from './normalise.js';

/**
 * Cache lifetimes for read endpoints.
 *
 * Tuned around the dashboard's default 5s poll: short enough that a manual refresh feels
 * immediate, long enough to collapse simultaneous pollers into a single upstream call.
 * `info` is slower because the server version and world GUID essentially never change — except
 * during a restart, which is why the restart state machine bypasses the cache (`force: true`).
 */
export const CACHE_TTL_MS = {
  info: 5_000,
  players: 1_000,
  metrics: 1_000,
  settings: 30_000,
  gameData: 15_000,
} as const;

/** Normal endpoints are small; game-data is a bounded but deliberately larger snapshot. */
export const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_GAME_DATA_RESPONSE_BYTES = 32 * 1024 * 1024;

/** Error details stay short even if an upstream proxy returns a large HTML page. */
const MAX_ERROR_BODY_BYTES = 8 * 1024;
const MAX_ERROR_BODY_CHARS = 2_000;

interface BoundedBody {
  text: string;
  truncated: boolean;
}

/** Read a response without allowing an upstream server to consume unbounded memory. */
async function readBoundedBody(response: Response, maxBytes: number): Promise<BoundedBody> {
  const advertisedLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
    await response.body?.cancel();
    return { text: '', truncated: true };
  }

  if (response.body === null) return { text: '', truncated: false };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) return { text: text + decoder.decode(), truncated: false };

    const remaining = maxBytes - received;
    if (value.byteLength > remaining) {
      if (remaining > 0) text += decoder.decode(value.subarray(0, remaining), { stream: true });
      await reader.cancel();
      return { text: text + decoder.decode(), truncated: true };
    }

    received += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
}

export interface RequestMeta {
  /** Round-trip time in milliseconds. */
  latencyMs: number;
  /** Upstream HTTP status. */
  status: number;
  /** Complete successful response body (bounded by the endpoint-specific limit). */
  body: string;
}

export interface ReadOptions {
  /** Skip the cache (and single-flight) and go straight to the server. */
  force?: boolean;
}

/** Pre-encode the Basic credential, which is the only place the password is used. */
function basicAuthHeader(config: PalworldConfig): string {
  return `Basic ${Buffer.from(`${config.username}:${config.password}`, 'utf8').toString('base64')}`;
}

/**
 * Typed client for the official Palworld dedicated-server REST API.
 *
 * Scope notes:
 * - **No automatic retries.** A user clicking "Ban" should get one unambiguous outcome. Callers
 *   that legitimately need to retry (the restart health poll) do so explicitly.
 * - **Every method throws {@link PalworldError}** with an actionable message and a mapped HTTP
 *   status, so route handlers stay thin.
 * - Credentials are only ever placed in the `Authorization` header, which the logger redacts.
 */
export class PalworldClient {
  // Mutable so a desktop user can point the app at a different Palworld server without restarting
  // it. Everything derived from the connection — the `Authorization` header and any cached reads —
  // is rebuilt by `applyConnection`.
  private config: PalworldConfig;
  private authorizationHeader: string;
  private readonly logger: Logger;
  private readonly cache = new SingleFlightCache();

  constructor(config: PalworldConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.authorizationHeader = basicAuthHeader(config);
  }

  /**
   * Point this client at a different Palworld server.
   *
   * Cached reads are dropped: they describe the previous server, and the very next poll must
   * reflect the new one instead of replaying a stale snapshot from the old one.
   */
  applyConnection(config: PalworldConfig): void {
    this.config = config;
    this.authorizationHeader = basicAuthHeader(config);
    this.cache.invalidate();
  }

  /**
   * Forget the connection.
   *
   * Used when a desktop user disconnects: the client keeps working (every call fails fast against
   * the placeholder loopback address) so no caller needs a null check, but nothing is sent to the
   * server the user just walked away from.
   */
  clearConnection(): void {
    this.applyConnection(unconfiguredPalworldConfig(this.config.timeoutMs));
  }

  /** Absolute URL for an endpoint path, e.g. `/players`. */
  private url(path: string): string {
    return `${this.config.apiBaseUrl}${path}`;
  }

  /**
   * Perform one HTTP call and classify any failure.
   *
   * Returns the raw body rather than parsed JSON so each caller can apply the normaliser
   * appropriate to its endpoint.
   */
  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  ): Promise<RequestMeta> {
    const endpoint = this.url(path);
    const startedAt = performance.now();

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method,
        headers: {
          Authorization: this.authorizationHeader,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      // Network-level failure: no response at all.
      const failure = describeFetchFailure(error, endpoint);
      this.logger.debug(
        { method, endpoint, kind: failure.kind, err: failure.message },
        'Palworld request failed before a response',
      );
      throw failure;
    }

    let bounded: BoundedBody;
    try {
      bounded = await readBoundedBody(
        response,
        response.ok ? maxResponseBytes : MAX_ERROR_BODY_BYTES,
      );
    } catch (error) {
      throw describeFetchFailure(error, endpoint);
    }

    const latencyMs = Math.round(performance.now() - startedAt);
    if (!response.ok) {
      throw this.mapHttpError(
        response.status,
        endpoint,
        bounded.text.slice(0, MAX_ERROR_BODY_CHARS),
      );
    }

    if (bounded.truncated) {
      throw new PalworldError({
        kind: 'invalid_response',
        endpoint,
        status: response.status,
        message: `The Palworld server response from ${endpoint} exceeded the ${maxResponseBytes}-byte safety limit.`,
      });
    }

    this.logger.trace({ method, endpoint, status: response.status, latencyMs }, 'Palworld request');

    return { latencyMs, status: response.status, body: bounded.text };
  }

  /** Build an actionable error for a non-2xx upstream response. */
  private mapHttpError(status: number, endpoint: string, body: string): PalworldError {
    if (status === 401 || status === 403) {
      return new PalworldError({
        kind: 'unauthorized',
        endpoint,
        status,
        body,
        message:
          'The Palworld server rejected the API credentials. ' +
          'Check that PALWORLD_ADMIN_PASSWORD matches AdminPassword in PalWorldSettings.ini.',
      });
    }

    if (status === 400) {
      return new PalworldError({
        kind: 'bad_request',
        endpoint,
        status,
        body,
        message: `The Palworld server rejected the request as invalid${body ? `: ${body}` : '.'}`,
      });
    }

    if (status === 404) {
      return new PalworldError({
        kind: 'not_found',
        endpoint,
        status,
        body,
        message:
          `The Palworld server has no endpoint at ${endpoint}. ` +
          `Check that PALWORLD_REST_URL points at the REST API port (RESTAPIPort, usually 8212) and that your server version supports this call.`,
      });
    }

    if (status >= 500) {
      return new PalworldError({
        kind: 'server_error',
        endpoint,
        status,
        body,
        message: `The Palworld server returned HTTP ${status}${body ? `: ${body}` : '.'}`,
      });
    }

    return new PalworldError({
      kind: 'server_error',
      endpoint,
      status,
      body,
      message: `Unexpected HTTP ${status} from the Palworld server${body ? `: ${body}` : '.'}`,
    });
  }

  /** Shared implementation for cached JSON GET endpoints. */
  private async getJson(
    path: string,
    ttlMs: number,
    options: ReadOptions,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  ): Promise<{ raw: unknown; latencyMs: number }> {
    const ttl = options.force === true ? 0 : ttlMs;

    // The cache stores the parsed body plus latency so a cache hit can still report a number.
    const result = await this.cache.run(`GET ${path}`, ttl, async () => {
      const meta = await this.request('GET', path, undefined, maxResponseBytes);
      return { raw: parseJson(meta.body), latencyMs: meta.latencyMs, body: meta.body };
    });

    return { raw: result.raw, latencyMs: result.latencyMs };
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** `GET /info` */
  async info(options: ReadOptions = {}): Promise<PalworldInfo> {
    const { raw } = await this.getJson('/info', CACHE_TTL_MS.info, options);
    const info = normaliseInfo(raw);
    if (info === null) {
      throw new PalworldError({
        kind: 'invalid_response',
        endpoint: this.url('/info'),
        message:
          'The Palworld server returned an unexpected response for /info. ' +
          'This usually means PALWORLD_REST_URL points at something that is not the Palworld REST API.',
      });
    }
    return info;
  }

  /** `GET /players` */
  async players(options: ReadOptions = {}): Promise<PalworldPlayer[]> {
    const { raw } = await this.getJson('/players', CACHE_TTL_MS.players, options);
    return normalisePlayers(raw);
  }

  /** `GET /metrics` */
  async metrics(options: ReadOptions = {}): Promise<PalworldMetrics> {
    const { raw } = await this.getJson('/metrics', CACHE_TTL_MS.metrics, options);
    return normaliseMetricsResponse(raw);
  }

  /** `GET /settings` */
  async settings(options: ReadOptions = {}): Promise<PalworldSettings> {
    const { raw } = await this.getJson('/settings', CACHE_TTL_MS.settings, options);
    return normaliseSettings(raw);
  }

  /** Guild base terminals from the optional `GET /game-data` actor snapshot. */
  async guildBases(options: ReadOptions = {}): Promise<PalworldGuildBase[]> {
    const ttl = options.force === true ? 0 : CACHE_TTL_MS.gameData;

    // Cache the compact normalized list, not the potentially 32 MiB actor snapshot. This avoids
    // reparsing the world for every browser while still letting a manual retry bypass the cache.
    return this.cache.run('GET /game-data:guild-bases', ttl, async () => {
      const meta = await this.request('GET', '/game-data', undefined, MAX_GAME_DATA_RESPONSE_BYTES);
      const bases = normaliseGuildBases(parseJson(meta.body));
      if (bases === null) {
        throw new PalworldError({
          kind: 'invalid_response',
          endpoint: this.url('/game-data'),
          message:
            'The Palworld game-data response is missing ActorData. ' +
            'Ensure the game server was started with -enable-gamedata-api.',
        });
      }
      return bases;
    });
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * POST an action and return its metadata.
   *
   * Writes invalidate the read caches that their effect would change, so the very next poll
   * reflects reality instead of a stale snapshot. This matters most for a restart, where the
   * dashboard must not keep showing the pre-shutdown state.
   */
  private async post(path: string, body?: unknown): Promise<RequestMeta> {
    const meta = await this.request('POST', path, body);
    this.cache.invalidate();
    return meta;
  }

  /** `POST /announce` */
  announce(message: string): Promise<RequestMeta> {
    return this.post('/announce', { message });
  }

  /** `POST /kick` */
  kick(userid: string, message?: string): Promise<RequestMeta> {
    return this.post('/kick', message === undefined ? { userid } : { userid, message });
  }

  /** `POST /ban` */
  ban(userid: string, message?: string): Promise<RequestMeta> {
    return this.post('/ban', message === undefined ? { userid } : { userid, message });
  }

  /** `POST /unban` */
  unban(userid: string): Promise<RequestMeta> {
    return this.post('/unban', { userid });
  }

  /** `POST /save` */
  save(): Promise<RequestMeta> {
    return this.post('/save', {});
  }

  /** `POST /shutdown` — the server stops after `waittime` seconds. */
  shutdown(waittime: number, message?: string): Promise<RequestMeta> {
    return this.post('/shutdown', message === undefined ? { waittime } : { waittime, message });
  }

  /**
   * `POST /stop` — force stop, with no grace period.
   *
   * The body is sent as `{}` rather than omitted: `/stop` documents no body, but Fastify-derived
   * servers commonly reject a POST with no `Content-Type` at all, and an empty JSON object is
   * harmless to the ones that ignore it.
   */
  stop(): Promise<RequestMeta> {
    return this.post('/stop', {});
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  /** Drop all cached reads. Called after a restart completes. */
  invalidateCache(): void {
    this.cache.invalidate();
  }

  /**
   * Probe reachability without throwing.
   *
   * Used by the restart state machine, where a connection failure is the *expected* signal that
   * the server is down rather than an error worth surfacing.
   */
  async probe(): Promise<
    | { reachable: true; latencyMs: number; info: PalworldInfo }
    | { reachable: false; error: PalworldError }
  > {
    try {
      const startedAt = performance.now();
      const info = await this.info({ force: true });
      return { reachable: true, latencyMs: Math.round(performance.now() - startedAt), info };
    } catch (error) {
      if (error instanceof PalworldError) return { reachable: false, error };
      throw error;
    }
  }
}
