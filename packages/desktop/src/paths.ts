import { app } from 'electron';
import { appendFileSync, mkdirSync, statSync, truncateSync } from 'node:fs';
import path from 'node:path';

/**
 * Where the desktop app keeps its state.
 *
 * Everything lives under Electron's `userData` directory, so an uninstall or a "delete the app"
 * leaves nothing behind and two users on one machine cannot collide:
 *
 * - macOS: `~/Library/Application Support/PalSentry`
 * - Windows: `%APPDATA%\PalSentry`
 * - Linux: `~/.config/PalSentry`
 */
export interface DesktopPaths {
  /** Root of all app state. Passed to the server as `PALSENTRY_DATA_DIR`. */
  dataDir: string;
  /** SQLite database, resolved by the server from `dataDir`; named here for messages. */
  databasePath: string;
  /** `desktop.json`: the port we settled on and the last REST URL. Never a password. */
  configPath: string;
  logDir: string;
  /** Server logs (JSON lines). */
  serverLogPath: string;
  /** Shell lifecycle and update logs. */
  mainLogPath: string;
  /** Built SPA, staged next to the shell bundle at build time. */
  webDistDir: string;
  /** Tray images, staged next to the shell bundle at build time. */
  trayDir: string;
}

export function resolvePaths(): DesktopPaths {
  const dataDir = app.getPath('userData');
  const logDir = path.join(dataDir, 'logs');

  return {
    dataDir,
    databasePath: path.join(dataDir, 'palsentry.db'),
    configPath: path.join(dataDir, 'desktop.json'),
    logDir,
    serverLogPath: path.join(logDir, 'palsentry.log'),
    mainLogPath: path.join(logDir, 'main.log'),
    // `dist/` in both development and a packaged app: the staging step copies the built SPA and
    // the tray images in beside `main.js`.
    webDistDir: path.join(app.getAppPath(), 'dist', 'public'),
    trayDir: path.join(app.getAppPath(), 'dist', 'assets', 'tray'),
  };
}

// ---------------------------------------------------------------------------
// Shell logging
// ---------------------------------------------------------------------------

export interface MainLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Keep one log file from growing without bound across launches.
 *
 * The shell writes a handful of lines per launch, so truncating at a modest size loses nothing
 * anyone would miss and guarantees the file stays mailable straight from the tray.
 */
const MAX_LOG_BYTES = 512 * 1024;

/**
 * The shell's own logger.
 *
 * Deliberately tiny and dependency-free — the shell logs a launch, a few lifecycle events and
 * update results. It never logs credentials: the Palworld password only ever exists inside the
 * server's memory, and the shell never sees it. Output is mirrored to stdout when unpackaged so
 * `npm run dev:desktop` shows it, and always appended to the log file for support purposes.
 */
export function createMainLogger(logPath: string): MainLogger {
  let prepared = false;

  function ensure(): void {
    if (prepared) return;
    prepared = true;

    try {
      mkdirSync(path.dirname(logPath), { recursive: true });
      try {
        if (statSync(logPath).size > MAX_LOG_BYTES) truncateSync(logPath, 0);
      } catch {
        // No file yet: nothing to trim.
      }
    } catch (error) {
      console.error('[palsentry] could not prepare the log directory', error);
    }
  }

  function write(level: string, message: string, meta?: Record<string, unknown>): void {
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      msg: message,
      ...(meta ?? {}),
    });

    if (!app.isPackaged) {
      const sink = level === 'error' ? console.error : console.log;
      sink(`[palsentry] ${message}`, meta ?? '');
    }

    ensure();

    try {
      appendFileSync(logPath, `${line}\n`, 'utf8');
    } catch {
      // The log file is not worth failing over.
    }
  }

  return {
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
  };
}
