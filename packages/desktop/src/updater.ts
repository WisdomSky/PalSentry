import { Notification, app } from 'electron';
import electronUpdater from 'electron-updater';
import type { MainLogger } from './paths.js';

/**
 * Automatic updates.
 *
 * Windows and Linux installations update themselves from the public GitHub Releases feed that
 * `electron-builder` writes into the packaged app (`app-update.yml`). Two platforms deliberately
 * do not:
 *
 * - **macOS.** Installing an update means replacing the app bundle, which macOS only allows for a
 *   code-signed app. These builds are unsigned, so a check there would offer an update that could
 *   never land; macOS users download new releases from GitHub until Developer ID signing exists.
 * - **Development.** There is no packaged app to replace and no update metadata to read.
 *
 * `PALSENTRY_UPDATE_FEED` points the updater at a different feed (any URL serving `latest.yml` /
 * `latest-mac.yml` next to the artifacts) and lifts the two restrictions above, so the update flow
 * can be exercised without publishing a release. It is a testing switch, not a product feature.
 */

// electron-updater is CommonJS and exposes `autoUpdater` through a lazy getter, which Node's ESM
// interop cannot see as a named export. The default import is the module object itself.
const { autoUpdater } = electronUpdater;

/** How long after launch the first (automatic) check runs. */
const STARTUP_CHECK_DELAY_MS = 10_000;

/** Menu rebuilds are not free, so download progress is reported at most this often. */
const PROGRESS_INTERVAL_MS = 2_000;

export interface UpdaterOptions {
  logger: MainLogger;
  /** Called when the status line or the availability of "Restart to update" changed. */
  onStatusChange: () => void;
}

export interface Updater {
  /** Human-readable state, shown in the About dialog and the tray/menu status line. */
  statusText(): string;
  /** True once an update has been downloaded and is waiting for a restart. */
  isReady(): boolean;
  /** Wire up the updater and schedule the automatic check. No-op where updates are unsupported. */
  start(): void;
  /** Check now, reporting progress through the status line. */
  check(): void;
  /**
   * Install the downloaded update and restart.
   *
   * Only called after the shell has shut the embedded server down, so SQLite is closed before the
   * installer replaces the app.
   */
  install(): void;
}

export function createUpdater(options: UpdaterOptions): Updater {
  const { logger } = options;

  const feedOverride = (process.env.PALSENTRY_UPDATE_FEED ?? '').trim();
  const unsupported = unsupportedReason();

  let status = unsupported ?? 'not checked yet';
  let ready = false;
  let downloadingVersion: string | null = null;
  let lastProgressAt = 0;

  function setStatus(next: string): void {
    if (next === status) return;
    status = next;
    // Logged because the status line is the only place update progress is visible, and a support log
    // is how "it never updated" gets answered.
    logger.info('Update status changed', { status: next });
    options.onStatusChange();
  }

  function notify(title: string, body: string): void {
    if (!Notification.isSupported()) return;

    try {
      new Notification({ title, body }).show();
      logger.info('Showed an update notification', { title });
    } catch (error) {
      logger.warn('Could not show an update notification', { error: messageOf(error) });
    }
  }

  function check(): void {
    logger.info('Update check requested', {
      supported: unsupported === null,
      feed: feedOverride === '' ? 'github' : feedOverride,
    });

    if (unsupported !== null) {
      setStatus(unsupported);
      return;
    }

    void autoUpdater.checkForUpdates().catch((error: unknown) => {
      // Failures also arrive through the error event; this catch is so a rejected promise never
      // becomes an unhandled rejection in the main process.
      logger.warn('Update check failed', { error: messageOf(error) });
    });
  }

  function install(): void {
    logger.info('Installing the downloaded update and restarting');
    // Silent install, then run the new version: for a tray app that is recording in the background,
    // an installer window would be noise.
    autoUpdater.quitAndInstall(true, true);
  }

  function start(): void {
    if (unsupported !== null) {
      logger.info('Update checks are off for this build', { reason: unsupported });
      return;
    }

    // electron-updater logs through this, so its messages end up in main.log with everything else.
    autoUpdater.logger = {
      info: (message?: unknown, ...rest: unknown[]) => logger.info(withPrefix(message, rest)),
      warn: (message?: unknown, ...rest: unknown[]) => logger.warn(withPrefix(message, rest)),
      error: (message?: unknown, ...rest: unknown[]) => logger.error(withPrefix(message, rest)),
      debug: (message?: unknown, ...rest: unknown[]) => logger.debug(withPrefix(message, rest)),
    };

    if (feedOverride !== '') {
      logger.warn('Using an update feed from PALSENTRY_UPDATE_FEED', { feed: feedOverride });
      autoUpdater.setFeedURL({ provider: 'generic', url: feedOverride });
    }

    autoUpdater.autoDownload = true;
    // Installing is always an explicit action here ("Restart to update"), so a downloaded update
    // never runs an installer behind the user's back — including during a system shutdown.
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on('checking-for-update', () => setStatus('Checking for updates…'));

    autoUpdater.on('update-available', (info) => {
      downloadingVersion = info.version;
      setStatus(`Downloading v${info.version}…`);
    });

    autoUpdater.on('download-progress', (progress) => {
      const now = Date.now();
      if (now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
      lastProgressAt = now;

      const version = downloadingVersion ?? 'update';
      setStatus(`Downloading ${version}… ${Math.round(progress.percent)}%`);
    });

    autoUpdater.on('update-not-available', () => setStatus('Up to date'));

    autoUpdater.on('update-downloaded', (info) => {
      ready = true;
      setStatus(`v${info.version} is ready — Restart to update`);
      notify(
        `PalSentry ${info.version} is ready`,
        'Restart from the PalSentry tray menu to install it.',
      );
    });

    autoUpdater.on('error', (error) => {
      // The detail goes to the log only: the status line is shown in the About dialog, where an
      // ENOENT path or a stack trace would be noise.
      logger.warn('Update check failed', { error: messageOf(error) });
      setStatus('update check failed');
    });

    // A tray app is rarely opened, so check once shortly after launch. Anything more frequent would
    // be noise on a release feed that changes a few times a year.
    const timer = setTimeout(() => check(), STARTUP_CHECK_DELAY_MS);
    timer.unref();

    logger.info('Update checks are enabled', {
      feed: feedOverride === '' ? 'github releases' : feedOverride,
    });
  }

  return {
    statusText: () => status,
    isReady: () => ready,
    start,
    check,
    install,
  };
}

/**
 * Why this build cannot check for updates, or null when it can.
 *
 * `PALSENTRY_UPDATE_FEED` overrides all of it for testing.
 */
function unsupportedReason(): string | null {
  if ((process.env.PALSENTRY_UPDATE_FEED ?? '').trim() !== '') return null;

  if (!app.isPackaged) return 'not available in a development build';
  if (process.platform === 'darwin') return 'macOS: download new versions from GitHub';

  // electron-updater only self-updates an AppImage; a .deb or .rpm install belongs to the system
  // package manager. Without APPIMAGE set, a check would fail with a confusing error instead.
  if (process.platform === 'linux' && (process.env.APPIMAGE ?? '') === '') {
    return 'updates need the AppImage build';
  }

  return null;
}

/** Render an electron-updater log call as one line, keeping any extra arguments. */
function withPrefix(message: unknown, rest: unknown[]): string {
  const head = typeof message === 'string' ? message : String(message);
  const tail = rest.map((value) => (typeof value === 'string' ? value : JSON.stringify(value)));

  return `[updater] ${[head, ...tail].join(' ')}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
