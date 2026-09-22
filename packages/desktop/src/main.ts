import { BrowserWindow, Menu, app, dialog, screen, session } from 'electron';
import type { Rectangle } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { resolvePaths, createMainLogger, type DesktopPaths, type MainLogger } from './paths.js';
import { readDesktopConfig, writeDesktopConfig } from './connection-config.js';
import { reservePort, startServerHost, type ServerHost } from './server-host.js';
import {
  CONTENT_SECURITY_POLICY,
  createMainWindow,
  isVisibleOnSomeDisplay,
  windowStatePath,
} from './window.js';
import { createTray, openFolder, type TrayController } from './tray.js';
import { buildApplicationMenu } from './menu.js';
import { createUpdater, type Updater } from './updater.js';

/**
 * PalSentry for the desktop.
 *
 * The shell's job is small on purpose: start the embedded server on a stable loopback port, show a
 * window pointed at it, keep running in the tray when the window is closed, and shut everything
 * down in the right order when the user really does quit.
 *
 * There is no IPC and no preload script. The window loads the app over HTTP exactly as a browser
 * would, which means the web app has no desktop-only code paths to maintain — with one exception
 * it discovers at runtime: `PALSENTRY_DESKTOP=1` replaces the login screen with the Palworld
 * connection screen.
 */

/** Development escape hatch: load the Vite dev server instead of the embedded one. */
const DEV_URL = process.env.PALSENTRY_DESKTOP_DEV_URL;

// A development run must not share the installed app's data directory or its single-instance lock.
// `app.getName()` comes from `productName` ("PalSentry") once packaged, so without this a checkout
// and an installed build would both claim <appData>/PalSentry — the second one to start would exit
// on the instance lock and a dev run would write into real recorded history.
if (!app.isPackaged) app.setPath('userData', `${app.getPath('userData')}-dev`);

/** The application menu is rebuilt whenever the update state or connection state changes. */
const paths: DesktopPaths = resolvePaths();
const logger: MainLogger = createMainLogger(paths.mainLogPath);

let window: BrowserWindow | null = null;
let tray: TrayController | null = null;
let server: ServerHost | null = null;
let updater: Updater | null = null;
let quitting = false;

/** One-line connection summary, shown in the tray. Refreshed from the loopback API. */
let connectionSummary = 'Starting up…';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * A second launch focuses the existing app instead of starting a rival instance that would fight
 * over the same database and port.
 */
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    logger.info('A second launch was requested; focusing the existing window');
    showWindow();
  });

  void start();
}

async function start(): Promise<void> {
  await app.whenReady();

  logger.info('PalSentry desktop starting', {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    dataDir: paths.dataDir,
  });

  installContentSecurityPolicy();

  // The connection screen lives in the renderer; the shell only remembers the URL, and only ever
  // the URL.
  const stored = await readDesktopConfig(paths.configPath);
  if (stored.stripped.length > 0) {
    logger.error('Removed credential-shaped keys from the settings file', {
      keys: stored.stripped,
    });
    await writeDesktopConfig(paths.configPath, {});
  }

  const origin = await resolveOrigin(stored.config.port, stored.config.restUrl);
  if (origin === null) return;

  await openWindow(origin);
  buildMenusAndTray();

  // Notifications and the taskbar identity are tied together on Windows: without this, an update
  // notification would be attributed to "electron.app.Electron".
  if (process.platform === 'win32') app.setAppUserModelId('com.palsentry.app');

  updater = createUpdater({ logger, onStatusChange: refreshMenusAndTray });
  updater.start();

  app.on('activate', () => showWindow());

  // Deliberately no `window-all-closed` handler: closing the window hides it and the app is meant to
  // keep recording in the tray on every platform. Shutdown destroys the window itself and then exits
  // explicitly — a competing `app.quit()` from here would race the ordered shutdown and could cut it
  // off half-finished.

  app.on('before-quit', (event) => {
    // ⌘Q, the app menu's Quit, the dock and a system logout all arrive here. Without this the
    // process would exit with the samplers still running and SQLite never closed; instead take
    // over the quit and run the same ordered shutdown the tray uses.
    if (quitting) return;
    event.preventDefault();
    void shutdown('quit');
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  logger.info('PalSentry desktop ready', { origin });
}

/** Start the embedded server (or use the development URL) and return the origin to load. */
async function resolveOrigin(
  savedPort: number | null,
  restUrl: string | null,
): Promise<string | null> {
  if (DEV_URL !== undefined && DEV_URL !== '') {
    logger.info('Using the development URL; the embedded server is not started', {
      origin: DEV_URL,
    });
    connectionSummary = 'Development mode';
    return DEV_URL;
  }

  try {
    const port = await reservePort(savedPort);
    // Persist before binding so the next launch can reuse it even if this one crashes.
    await writeDesktopConfig(paths.configPath, { port });

    server = await startServerHost({
      paths,
      logger,
      restUrl,
      port,
      logLevel: process.env.LOG_LEVEL ?? 'info',
    });

    if (server.port !== port) {
      await writeDesktopConfig(paths.configPath, { port: server.port });
    } else if (port !== savedPort) {
      logger.debug('Listening on a new port', { port, previous: savedPort });
    }

    return server.origin;
  } catch (error) {
    reportStartupFailure(error);
    return null;
  }
}

/**
 * Lock the renderer down with a CSP.
 *
 * Injected here rather than served by the API, so the container deployment keeps whatever policy
 * its reverse proxy sets and this stays a desktop-only decision. Development skips it: Vite's
 * client needs inline scripts and a websocket.
 */
function installContentSecurityPolicy(): void {
  if (DEV_URL !== undefined && DEV_URL !== '') return;

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CONTENT_SECURITY_POLICY],
      },
    });
  });
}

function reportStartupFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const permissionHint = /EACCES|EPERM|readonly|SQLITE_CANTOPEN/i.test(message)
    ? `\n\nPalSentry could not use its data folder:\n${paths.dataDir}`
    : '';

  logger.error('PalSentry could not start', { error: message });
  dialog.showErrorBox('PalSentry could not start', `${message}${permissionHint}`);
  quitting = true;
  app.exit(1);
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

interface StoredWindowState {
  bounds?: { x: number; y: number; width: number; height: number };
}

async function readWindowState(): Promise<StoredWindowState> {
  try {
    return JSON.parse(await readFile(windowStatePath(paths), 'utf8')) as StoredWindowState;
  } catch {
    return {};
  }
}

async function saveWindowState(): Promise<void> {
  await writeWindowState(captureBounds());
}

/**
 * Read the window's geometry while it still exists.
 *
 * Separate from writing it because shutdown destroys the window before the (slow) server close,
 * and a destroyed window cannot report its bounds.
 */
function captureBounds(): Rectangle | null {
  if (window === null || window.isDestroyed()) return null;
  if (window.isMinimized() || window.isFullScreen()) return null;
  return window.getBounds();
}

async function writeWindowState(bounds: Rectangle | null): Promise<void> {
  if (bounds === null) return;

  try {
    await writeFile(windowStatePath(paths), `${JSON.stringify({ bounds }, null, 2)}\n`, 'utf8');
  } catch {
    // Geometry is a convenience; losing it is not worth a warning.
  }
}

async function openWindow(origin: string): Promise<BrowserWindow> {
  const created = createMainWindow({ origin, paths, logger, devTools: !app.isPackaged });

  const state = await readWindowState();
  if (state.bounds !== undefined) {
    // Restore only if the window would still be visible: a monitor may have been unplugged since.
    const workAreas = screen.getAllDisplays().map((display) => display.workArea);
    if (isVisibleOnSomeDisplay(state.bounds, workAreas)) created.setBounds(state.bounds);
  }

  created.on('close', (event) => {
    if (quitting) return;

    // Hide rather than close: the tray keeps recording, and reopening is instant.
    event.preventDefault();
    created.hide();
    logger.debug('Window hidden; recording continues in the tray');
  });

  created.on('resize', () => void saveWindowState());
  created.on('move', () => void saveWindowState());

  window = created;

  return created;
}

function showWindow(): void {
  if (window === null || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

// ---------------------------------------------------------------------------
// Menus and tray
// ---------------------------------------------------------------------------

function menuOptions() {
  return {
    version: app.getVersion(),
    updateStatus: () => updater?.statusText() ?? 'not checked yet',
    checkForUpdates: () => updater?.check(),
    canRestartToUpdate: () => updater?.isReady() === true,
    restartToUpdate: () => restartToUpdate(),
    openLogFolder: () => openFolder(paths.logDir),
    openDataFolder: () => openFolder(paths.dataDir),
    getWindow: () => window,
  };
}

function buildMenusAndTray(): void {
  Menu.setApplicationMenu(buildApplicationMenu(menuOptions()));

  tray = createTray({
    paths,
    logger,
    getWindow: () => window,
    openWindow: () => showWindow(),
    quit: () => void shutdown('tray'),
    openLogFolder: () => openFolder(paths.logDir),
    checkForUpdates: () => updater?.check(),
    canRestartToUpdate: () => updater?.isReady() === true,
    restartToUpdate: () => restartToUpdate(),
    connectionSummary: () => connectionSummary,
  });

  void refreshConnectionSummary();
  const timer = setInterval(() => void refreshConnectionSummary(), 15_000);
  timer.unref();

  logger.info('Tray and application menu are ready');
}

/** Ask the loopback API whether recording is active, and update the tray when that changes. */
async function refreshConnectionSummary(): Promise<void> {
  const previous = connectionSummary;

  if (server === null) {
    connectionSummary =
      DEV_URL === undefined || DEV_URL === '' ? 'Not connected' : 'Development mode';
  } else {
    try {
      const response = await fetch(`${server.origin}/api/connection`);
      const status = (await response.json()) as { configured?: boolean; restUrl?: string | null };
      connectionSummary = status.configured
        ? `Recording${status.restUrl ? ` · ${status.restUrl.replace(/\/v1\/api$/, '')}` : ''}`
        : 'Not connected';
    } catch {
      // The embedded server is in the same process, so this only fails while it is shutting down.
      connectionSummary = 'Not connected';
    }
  }

  // Rebuilding the menu closes it on some platforms if it happens to be open, so only do it when
  // the text a user would actually read has changed.
  if (connectionSummary !== previous) tray?.refresh();
}

/**
 * Rebuild the application menu and the tray after the update state changed.
 *
 * Both carry update items: the menu shows the status line in About, and the tray grows a "Restart to
 * update" entry once an update is downloaded.
 */
function refreshMenusAndTray(): void {
  Menu.setApplicationMenu(buildApplicationMenu(menuOptions()));
  tray?.refresh();
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

/**
 * Restart into a downloaded update.
 *
 * Shutting down first is the point: the installer replaces the app while it is running, so SQLite
 * has to be closed before that happens.
 */
function restartToUpdate(): void {
  if (updater === null || !updater.isReady()) return;
  void shutdown('update', () => updater?.install());
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

/**
 * Shut down in order: hide the window, close the server (which stops the samplers and closes
 * SQLite), then exit. Closing the database before the timers would lose whatever a poll was
 * writing at that moment.
 *
 * `afterShutdown` hands the process to something else once everything is closed — the updater, which
 * needs the database closed before it replaces the app.
 */
async function shutdown(reason: string, afterShutdown?: () => void): Promise<void> {
  if (quitting) return;
  quitting = true;

  logger.info('Shutting down', { reason });

  const bounds = captureBounds();

  // Hide first so quitting looks instant, then destroy the window. Destroying it is not cosmetic:
  // the renderer holds keep-alive sockets to the embedded server, and Fastify's `close()` waits for
  // connections to drain — up to its 72-second keep-alive timeout — which would leave the process
  // alive long after the window disappeared and the tray icon was gone.
  try {
    window?.hide();
    window?.destroy();
  } catch {
    /* already gone */
  }

  window = null;

  tray?.destroy();
  tray = null;

  try {
    // Closing the server stops the samplers and closes SQLite. The timeout is a backstop: a stuck
    // close must never keep the app alive, and SQLite in WAL mode survives an abrupt exit.
    await Promise.race([server?.close(), delay(SHUTDOWN_GRACE_MS)]);
  } catch (error) {
    logger.warn('The embedded server did not shut down cleanly', { error: String(error) });
  }

  server = null;

  // Geometry is a convenience; it goes last so nothing can cost us the database close above.
  await writeWindowState(bounds);

  logger.info('Goodbye');

  if (afterShutdown !== undefined) {
    // The updater takes the process from here: it starts the installer and quits.
    try {
      afterShutdown();
      return;
    } catch (error) {
      logger.error('Could not start the update installer', { error: String(error) });
    }
  }

  app.exit(0);
}

/** How long to wait for the embedded server before exiting anyway. */
const SHUTDOWN_GRACE_MS = 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
