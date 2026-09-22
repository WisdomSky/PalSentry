import type { RestartState, RestartStatusResponse } from '@palsentry/shared';
import { HttpError } from '../http/errors.js';
import type { Logger } from '../logger.js';
import type { PalworldClient } from '../palworld/client.js';
import { PalworldError } from '../palworld/errors.js';
import type { AuditService } from './audit.js';

/**
 * Restart orchestration.
 *
 * The Palworld REST API has **no restart endpoint** — only `/shutdown` (graceful) and `/stop`
 * (force). Something outside the game process has to bring it back, which is the Docker
 * container's `restart: unless-stopped` policy. So a "restart" here means:
 *
 *   announce → save → shutdown → wait out the countdown → wait for the process to return
 *
 * The service is a small explicit state machine so the UI can show honest progress instead of a
 * spinner that means nothing.
 *
 * ### Detecting that the restart actually happened
 *
 * The naive approach — poll until `/info` fails, then poll until it succeeds — breaks when the
 * container restarts faster than the poll interval, which is common on a fast host. This
 * implementation instead compares `/metrics.uptime` against a baseline captured before the
 * shutdown: a *lower* uptime means a genuinely new process, even if we never observed the gap.
 * Both signals are used, so neither a slow nor a fast restart is missed.
 */

export interface RestartConfig {
  defaultWaitSeconds: number;
  /** Budget for the server to come back, *after* the countdown has elapsed. */
  healthTimeoutSeconds: number;
  /** How often to probe while waiting for the process to return. */
  pollIntervalMs?: number;
}

export interface StartRestartOptions {
  waittime?: number;
  message?: string;
  actorName: string | null;
  actorIp: string | null;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;

function idleStatus(): RestartStatusResponse {
  return {
    state: 'idle',
    startedAt: null,
    finishedAt: null,
    waittimeSeconds: 0,
    downtimeMs: null,
    error: null,
    detail: 'No restart in progress.',
  };
}

export class RestartService {
  private readonly client: PalworldClient;
  private readonly audit: AuditService;
  private readonly logger: Logger;
  private readonly config: RestartConfig;
  private readonly pollIntervalMs: number;

  private status: RestartStatusResponse = idleStatus();
  private running = false;
  private cancelled = false;

  constructor(options: {
    client: PalworldClient;
    audit: AuditService;
    logger: Logger;
    config: RestartConfig;
  }) {
    this.client = options.client;
    this.audit = options.audit;
    this.logger = options.logger;
    this.config = options.config;
    this.pollIntervalMs = options.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  getStatus(): RestartStatusResponse {
    return { ...this.status };
  }

  /** True while a restart sequence is in flight. */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Begin a restart and return immediately.
   *
   * The caller gets the initial status and then polls {@link getStatus}; the sequence itself
   * takes tens of seconds and must not hold an HTTP request open.
   */
  start(options: StartRestartOptions): RestartStatusResponse {
    if (this.running) {
      throw HttpError.conflict('A restart is already in progress. Wait for it to finish.');
    }

    const waittime = options.waittime ?? this.config.defaultWaitSeconds;

    this.running = true;
    this.cancelled = false;
    this.status = {
      state: 'announcing',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      waittimeSeconds: waittime,
      downtimeMs: null,
      error: null,
      detail: 'Warning players about the restart.',
    };

    void this.run({
      waittime,
      message: options.message,
      actorName: options.actorName,
      actorIp: options.actorIp,
    });

    return this.getStatus();
  }

  /** Abort an in-flight restart. Used on shutdown so timers do not outlive the process. */
  stop(): void {
    this.cancelled = true;
  }

  private update(
    state: RestartState,
    detail: string,
    extra: Partial<RestartStatusResponse> = {},
  ): void {
    this.status = { ...this.status, state, detail, ...extra };
    this.logger.debug({ state, detail }, 'Restart progress');
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref();
    });
  }

  /** The full restart sequence. Never throws: failures are recorded in `status` and the audit log. */
  private async run(options: {
    waittime: number;
    message: string | undefined;
    actorName: string | null;
    actorIp: string | null;
  }): Promise<void> {
    const { waittime } = options;
    const message = options.message ?? `Server restarting in ${waittime} seconds.`;

    // Budget for the return trip, on top of the countdown players were promised.
    const healthDeadline = Date.now() + (waittime + this.config.healthTimeoutSeconds) * 1000;

    try {
      // Capture the baseline uptime before touching anything, so a restart that happens too
      // fast to observe is still detectable.
      const baseline = await this.probeUptime();

      this.update('announcing', `Announcing a restart in ${waittime} seconds.`);
      await this.client.announce(message);

      this.update('saving', 'Saving the world before shutting down.');
      await this.client.save();

      this.update('shutting_down', `Shutdown requested; ${waittime}s countdown running.`);
      // The game server owns the countdown, so it stays accurate while players watch it.
      await this.client.shutdown(waittime, message);

      // Wait out the countdown without polling: the server is expected to still be up, and
      // hammering it during the countdown would be pointless load.
      await this.waitOutCountdown(waittime);

      this.update('waiting_for_process', 'Waiting for the server to stop.');
      const outcome = await this.waitForRestart(healthDeadline, baseline);

      const downtimeMs = outcome.downtimeMs;
      this.update(
        'succeeded',
        downtimeMs === null
          ? 'Server is back online.'
          : `Server is back online after ${Math.round(downtimeMs / 1000)}s of downtime.`,
        { downtimeMs, finishedAt: new Date().toISOString() },
      );

      this.audit.record({
        actorName: options.actorName,
        actorIp: options.actorIp,
        action: 'restart',
        target: null,
        payload: { waittime, message },
        httpStatus: 200,
        ok: true,
        error: null,
        durationMs: downtimeMs,
      });
      this.logger.info({ waittime, downtimeMs }, 'Server restart completed');
    } catch (error) {
      const reason =
        error instanceof PalworldError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);

      this.update('failed', reason, { error: reason, finishedAt: new Date().toISOString() });

      this.audit.record({
        actorName: options.actorName,
        actorIp: options.actorIp,
        action: 'restart',
        target: null,
        payload: { waittime, message },
        httpStatus: error instanceof PalworldError ? error.httpStatus : 500,
        ok: false,
        error: reason,
        durationMs: null,
      });
      this.logger.error({ reason, waittime }, 'Server restart failed');
    } finally {
      this.running = false;
    }
  }

  /** Sleep through the shutdown countdown, ticking the detail line so the UI has a live clock. */
  private async waitOutCountdown(waittime: number): Promise<void> {
    for (let remaining = waittime; remaining > 0; remaining -= 1) {
      if (this.cancelled) return;
      this.update('shutting_down', `Waiting for the ${remaining}s shutdown countdown.`);
      await this.sleep(1_000);
    }
  }

  /** Read `/metrics.uptime`, tolerating an unreachable server. */
  private async probeUptime(): Promise<number | null> {
    try {
      const metrics = await this.client.metrics({ force: true });
      return metrics.uptime;
    } catch {
      // A server that is already down is a legitimate starting point.
      return null;
    }
  }

  /**
   * Wait until the server has restarted.
   *
   * Returns the observed downtime when the gap was seen, or `null` when the process came back
   * faster than the poll interval allowed us to notice.
   */
  private async waitForRestart(
    deadline: number,
    baselineUptime: number | null,
  ): Promise<{ downtimeMs: number | null }> {
    let observedDownAt: number | null = null;

    while (Date.now() < deadline) {
      if (this.cancelled) {
        throw new PalworldError({
          kind: 'timeout',
          endpoint: 'restart',
          message: 'The restart was cancelled because Palsentry is shutting down.',
        });
      }

      try {
        const metrics = await this.client.metrics({ force: true });

        if (observedDownAt !== null) {
          // We saw it go down and now it answers again: that is a completed restart.
          return { downtimeMs: Date.now() - observedDownAt };
        }

        if (baselineUptime !== null && metrics.uptime < baselineUptime) {
          // Never observed the gap, but uptime went backwards — a new process is running.
          return { downtimeMs: null };
        }

        this.update(
          'waiting_for_process',
          `Shutting down (uptime ${metrics.uptime}s, was ${baselineUptime ?? 'unknown'}s).`,
        );
      } catch {
        if (observedDownAt === null) {
          observedDownAt = Date.now();
          this.update('polling_health', 'Server is down; waiting for it to come back.');
        }
      }

      await this.sleep(this.pollIntervalMs);
    }

    throw new PalworldError({
      kind: 'timeout',
      endpoint: 'restart',
      message:
        `The server did not come back within ${this.config.healthTimeoutSeconds}s of the countdown finishing. ` +
        'Check that the Palworld container has `restart: unless-stopped` set — without it, Docker will not start it again after a shutdown. ' +
        'Then use "Stop" + start the container manually, or check the container logs.',
    });
  }
}
