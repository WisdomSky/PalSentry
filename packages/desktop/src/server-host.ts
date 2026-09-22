import type {
  Logger,
  StartPalSentryOptions,
  RunningPalSentry,
} from '@palsentry/server/desktop-entry';
import { choosePort } from './port.js';
import type { DesktopPaths } from './paths.js';
import type { MainLogger } from './paths.js';

/**
 * Start PalSentry inside the Electron main process.
 *
 * The server runs **in-process** rather than as a child process: there is no second executable to
 * ship, the database and timers live in one place, and shutting down is a single `await`. What it
 * costs is that the server is configured through the environment, so this module assembles that
 * environment before importing the bundle — `loadConfig()` reads `process.env` at import time, and
 * getting the order wrong would mean silently falling back to container defaults.
 *
 * The password is never part of this: it is typed into the connection screen at runtime and lives
 * only in the server's memory. All the shell passes at launch is the URL it remembered.
 */

/** What the shell needs from the embedded server bundle. Typed against the server's source. */
interface ServerBundle {
  createLogger(options: { level: string; pretty: boolean; destination?: string }): Logger;
  startPalSentry(options: StartPalSentryOptions): Promise<RunningPalSentry>;
}

/** Where the bundle sits next to the shell's own bundle. */
const SERVER_BUNDLE = new URL('./server.js', import.meta.url);

export interface StartServerOptions {
  paths: DesktopPaths;
  logger: MainLogger;
  /** The remembered REST URL, or null on a first launch. */
  restUrl: string | null;
  /** Port the shell settled on. Persisted for a stable origin. */
  port: number;
  logLevel: string;
}

export interface ServerHost {
  /** Origin the window should load, e.g. `http://127.0.0.1:43100`. */
  origin: string;
  /** The port actually bound, which differs from the requested one if the OS chose it. */
  port: number;
  close(): Promise<void>;
}

/**
 * Point the environment at this app's data, logs and port.
 *
 * Only the desktop-specific variables are set; everything else (session secret, login password,
 * retention, cadence) is left to the server's own defaults, which the desktop app does not use or
 * expose — there is no login in desktop mode.
 */
function applyEnvironment(options: StartServerOptions): void {
  const env = process.env;

  env.PALSENTRY_DESKTOP = '1';
  env.PALSENTRY_HOST = '127.0.0.1';
  env.PALSENTRY_PORT = String(options.port);
  env.PALSENTRY_DATA_DIR = options.paths.dataDir;
  env.PALSENTRY_DESKTOP_CONFIG = options.paths.configPath;
  env.PALSENTRY_WEB_DIST = options.paths.webDistDir;
  env.NODE_ENV = 'production';
  env.LOG_LEVEL = options.logLevel;

  // The desktop app never takes a Palworld password from the environment: it is typed into the
  // connection form and lives only in the server's memory for that session. A variable inherited
  // from a shell profile must not be able to make the app look connected (or worse, connect
  // silently) without a probed connection.
  delete env.PALWORLD_ADMIN_PASSWORD;

  if (options.restUrl !== null) {
    env.PALWORLD_REST_URL = options.restUrl;
  } else {
    // A stale value inherited from a terminal that happens to have it set would silently connect
    // the app to a server the user never chose.
    delete env.PALWORLD_REST_URL;
  }
}

export async function startServerHost(options: StartServerOptions): Promise<ServerHost> {
  applyEnvironment(options);

  const bundle = (await import(SERVER_BUNDLE.href)) as unknown as Partial<ServerBundle>;

  if (typeof bundle.startPalSentry !== 'function' || typeof bundle.createLogger !== 'function') {
    throw new Error(
      `The embedded server bundle is missing (${SERVER_BUNDLE.pathname}). Run "npm run build" for the desktop package.`,
    );
  }

  const logger = bundle.createLogger({
    level: options.logLevel,
    // The window has no terminal: logs go to the file the tray can open.
    pretty: false,
    destination: options.paths.serverLogPath,
  });

  // Recording starts when the user connects, not at launch: without a password there is nothing
  // to poll, and the desktop app deliberately forgets the password on every quit.
  const running = await bundle.startPalSentry({ startSamplers: false, logger });

  const address = new URL(running.url);
  const port = Number(address.port);

  options.logger.info('Embedded Palworld dashboard is listening', {
    origin: running.url,
    dataDir: options.paths.dataDir,
    restUrl: options.restUrl,
  });

  return {
    origin: running.url,
    port,
    close: async () => {
      await running.close();
      options.logger.info('Embedded server stopped');
    },
  };
}

/** Pick a port and report it, so the caller can persist it before the server binds. */
export async function reservePort(saved: number | null): Promise<number> {
  return choosePort(saved);
}
