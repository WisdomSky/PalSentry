import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ConnectionStatusResponse } from '@palsentry/shared';
import {
  ConfigError,
  UNCONFIGURED_API_BASE_URL,
  normaliseApiBaseUrl,
  type AppConfig,
  type PalworldConfig,
} from '../config.js';
import { HttpError } from '../http/errors.js';
import type { Logger } from '../logger.js';
import { PalworldClient } from '../palworld/client.js';
import type { PalworldErrorKind } from '../palworld/errors.js';
import type { AuditService } from './audit.js';
import type { MetricsPoller } from './metrics-poller.js';
import type { PlayerHistoryService } from './player-history.js';

/**
 * Desktop wording for failures whose container message names environment variables.
 *
 * The client's messages are written for a deployment that reads `PALWORLD_REST_URL` and
 * `PALWORLD_ADMIN_PASSWORD` from the environment. A desktop user typed both into a form, so telling
 * them to check an environment variable would be nonsense — the same failure is re-stated in terms
 * of what they actually entered. Anything not listed here keeps its original message.
 */
function desktopFailureMessage(kind: PalworldErrorKind, message: string, restUrl: string): string {
  switch (kind) {
    case 'unauthorized':
      return 'The Palworld server rejected the admin password. Check AdminPassword in PalWorldSettings.ini.';
    case 'unreachable':
    case 'timeout':
      return `Could not reach ${restUrl}. Check that the server is running and that RESTAPIEnabled=True with the right REST API port.`;
    case 'not_found':
      return `The Palworld REST API answered at ${restUrl} but without the expected endpoint. Check that RESTAPIEnabled=True.`;
    default:
      return message;
  }
}

/**
 * The desktop app's Palworld connection.
 *
 * The container deployment takes its credentials from the environment and never changes them. The
 * desktop app asks for them in the UI instead, so this service owns the mutable half of that
 * state:
 *
 * - **The password lives in memory only.** It is handed straight to the live Palworld client, is
 *   never written to disk, is never returned by an API, and is gone when the app quits — the
 *   connection screen asks again on the next launch. Nothing in this service even stores it.
 * - **The REST URL is remembered** so the form can prefill it.
 * - **A connection is only accepted after a live probe.** The candidate values are tried with a
 *   throwaway client, so a typo produces an actionable error in the form rather than a dashboard
 *   that silently shows an offline server.
 * - **Sampling follows the connection.** Metric and Wayback timers run only while connected, so a
 *   disconnected app does not poll a server it does not know about.
 */

export interface ConnectInput {
  restUrl: string;
  adminPassword: string;
  username?: string;
}

export interface DesktopSettingsOptions {
  config: AppConfig;
  client: PalworldClient;
  metrics: MetricsPoller;
  playerHistory: PlayerHistoryService;
  audit: AuditService;
  logger: Logger;
}

export class DesktopSettingsService {
  private readonly config: AppConfig;
  private readonly client: PalworldClient;
  private readonly metrics: MetricsPoller;
  private readonly playerHistory: PlayerHistoryService;
  private readonly audit: AuditService;
  private readonly logger: Logger;

  /** Last accepted REST URL, for prefilling the form. Null until one is known. */
  private restUrl: string | null;
  /** Basic-auth username. */
  private username: string;

  /**
   * Serialises connect/disconnect.
   *
   * Both operations stop or start timers and rewrite state, and a user double-clicking "Connect"
   * must not end up with two probes racing to apply different servers.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: DesktopSettingsOptions) {
    this.config = options.config;
    this.client = options.client;
    this.metrics = options.metrics;
    this.playerHistory = options.playerHistory;
    this.audit = options.audit;
    this.logger = options.logger;

    // The shell passes a saved URL as PALWORLD_REST_URL at boot, and the password only when the
    // user has already been asked (which, for a real launch, means: not yet).
    const boot = options.config.palworld;
    this.restUrl = boot.apiBaseUrl === UNCONFIGURED_API_BASE_URL ? null : boot.apiBaseUrl;
    this.username = boot.username;
  }

  /** Snapshot for the connection screen. Never includes the password. */
  status(): ConnectionStatusResponse {
    return {
      desktop: true,
      configured: this.config.desktop.configured,
      restUrl: this.restUrl,
      username: this.username,
    };
  }

  /** True once a probed connection is in force. Mirrored into the config for `readSession`. */
  get configured(): boolean {
    return this.config.desktop.configured;
  }

  /**
   * Probe, accept and apply a connection.
   *
   * Everything that can fail — an unusable URL, an unreachable host, rejected credentials —
   * fails here, before any state changes, so a failed attempt leaves the previous connection
   * exactly as it was.
   */
  async connect(input: ConnectInput, actorIp: string | null): Promise<ConnectionStatusResponse> {
    return this.exclusive(async () => {
      const candidate = this.buildCandidate(input);
      const previous = this.restUrl;

      await this.probe(candidate);

      // Apply first: sampling started below must poll the new server, not the old one.
      this.client.applyConnection(candidate);
      this.restUrl = candidate.apiBaseUrl;
      this.username = candidate.username;
      this.config.desktop.configured = true;

      // A failure to persist must not undo a connection that demonstrably works, but the user
      // should know the URL will not come back after a restart.
      try {
        await this.persist();
      } catch (error) {
        this.logger.warn(
          { err: error, path: this.config.desktop.configPath },
          'Connected, but the Palworld REST URL could not be saved for next launch',
        );
      }

      await Promise.all([this.metrics.start(), this.playerHistory.start()]);

      this.audit.record({
        actorName: null,
        actorIp,
        action: 'desktop-connect',
        target: null,
        payload: {
          restUrl: candidate.apiBaseUrl,
          previousRestUrl: previous,
          username: candidate.username,
        },
        httpStatus: 200,
        ok: true,
        error: null,
        durationMs: null,
      });

      this.logger.info(
        { restUrl: candidate.apiBaseUrl, previous, username: candidate.username },
        'Connected to the Palworld server',
      );

      return this.status();
    });
  }

  /**
   * Drop the connection and stop sampling.
   *
   * The remembered URL survives so reconnecting is one password away; the password does not.
   */
  async disconnect(actorIp: string | null): Promise<ConnectionStatusResponse> {
    return this.exclusive(async () => {
      const previous = this.restUrl;

      // Stop before clearing: a sampler still holding the old credentials must not write another
      // observation against a server the user just disconnected from.
      await Promise.all([this.metrics.stop(), this.playerHistory.stop()]);

      this.client.clearConnection();
      this.config.desktop.configured = false;

      this.audit.record({
        actorName: null,
        actorIp,
        action: 'desktop-disconnect',
        target: null,
        payload: { restUrl: previous },
        httpStatus: 200,
        ok: true,
        error: null,
        durationMs: null,
      });

      this.logger.info({ restUrl: previous }, 'Disconnected from the Palworld server');

      return this.status();
    });
  }

  /** Normalise and validate the submitted values. Throws a 400 the form can render. */
  private buildCandidate(input: ConnectInput): PalworldConfig {
    const rawUrl = input.restUrl.trim();
    if (rawUrl === '') {
      throw new HttpError(400, 'validation', 'Enter the REST URL of your Palworld server.', {
        restUrl: 'Required',
      });
    }

    let apiBaseUrl: string;
    try {
      apiBaseUrl = normaliseApiBaseUrl(rawUrl);
    } catch (error) {
      const message =
        error instanceof ConfigError
          ? error.message.split('\n')[0]!
          : 'That REST URL could not be parsed.';
      throw new HttpError(400, 'validation', message, { restUrl: message });
    }

    const username = input.username?.trim() === '' ? undefined : input.username?.trim();
    if (input.adminPassword === '') {
      throw new HttpError(400, 'validation', 'Enter the Palworld admin password.', {
        adminPassword: 'Required',
      });
    }

    return {
      apiBaseUrl,
      username: username ?? this.config.palworld.username,
      password: input.adminPassword,
      timeoutMs: this.config.palworld.timeoutMs,
    };
  }

  /**
   * Prove the candidate connection works before it is adopted.
   *
   * Uses a separate client so the live one keeps serving its current server while the probe runs,
   * and so a failed probe cannot leave partial state behind. The thrown error keeps the upstream
   * message — "the Palworld server rejected the API credentials" is exactly what the user needs.
   */
  private async probe(candidate: PalworldConfig): Promise<void> {
    const probeClient = new PalworldClient(candidate, this.logger);
    const result = await probeClient.probe();

    if (!result.reachable) {
      const failure = result.error;
      // Keep the upstream classification (it already says whether the host refused the connection,
      // timed out or rejected the credentials) but say it in the user's terms.
      const message = desktopFailureMessage(failure.kind, failure.message, candidate.apiBaseUrl);
      throw new HttpError(failure.httpStatus, failure.apiCode, message, { restUrl: message });
    }

    this.logger.debug(
      { restUrl: candidate.apiBaseUrl, latencyMs: result.latencyMs },
      'Palworld connection probe succeeded',
    );
  }

  /**
   * Write the URL next to the app's data, atomically. The password is not part of this shape.
   *
   * The file is shared with the desktop shell, which also keeps the port it settled on there, so
   * the existing contents are merged rather than replaced — otherwise connecting would quietly
   * throw away the shell's port and every launch would have to search for a free one again.
   */
  private async persist(): Promise<void> {
    const target = this.config.desktop.configPath;
    if (target === null) return;

    const stored: Record<string, unknown> = {
      ...(await this.readExisting(target)),
      restUrl: this.restUrl ?? '',
      username: this.username,
    };

    await mkdir(path.dirname(target), { recursive: true });
    // Write-then-rename so an interrupted write cannot leave a half-written file for the shell to
    // read at the next launch.
    const temporary = `${target}.tmp`;
    await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
    await rename(temporary, target);
  }

  /**
   * Read the shared file's current contents, tolerating both a missing and an unreadable file.
   *
   * A corrupt file is worth a warning rather than a failure: the connection itself is already in
   * force by the time this runs, and the next write replaces the damage with valid JSON.
   */
  private async readExisting(target: string): Promise<Record<string, unknown>> {
    let raw: string;
    try {
      raw = await readFile(target, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn({ err: error, path: target }, 'Could not read the desktop settings file');
      }
      return {};
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through to the warning below */
    }

    this.logger.warn({ path: target }, 'Desktop settings file was not a JSON object; rewriting it');
    return {};
  }

  /** Run `task` after any in-flight connect/disconnect, propagating its result. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    // Keep the chain alive regardless of outcome so one failure cannot block later attempts.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
