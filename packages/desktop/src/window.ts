import { BrowserWindow, shell } from 'electron';
import type { Rectangle } from 'electron';
import path from 'node:path';
import type { DesktopPaths } from './paths.js';
import type { MainLogger } from './paths.js';

/**
 * The application window.
 *
 * The renderer is untrusted in the strict sense even though it is our own code: it renders data
 * that came from a Palworld server and from other players' names. So it runs with no Node access
 * at all — no preload script, no IPC surface — and talks to the embedded server over HTTP like any
 * browser would. Everything it could otherwise be tricked into doing (running a command, reading a
 * file, opening a window) is denied here.
 */

const WINDOW_BACKGROUND = '#f8fafc';

/** Content Security Policy for the packaged app. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  // Tailwind and Vue set styles at runtime; inline *styles* are harmless, inline scripts are not.
  "style-src 'self' 'unsafe-inline'",
  // Map textures are bundled, and the map may be handed a blob/data URL for a user-supplied image.
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export interface CreateWindowOptions {
  origin: string;
  paths: DesktopPaths;
  logger: MainLogger;
  /** Reload/devtools in development builds. */
  devTools: boolean;
}

/** Links that belong in the user's browser, not in an app window. */
function isExternal(url: string, origin: string): boolean {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return !url.startsWith(origin);
  }
  return url.startsWith('mailto:');
}

export function createMainWindow(options: CreateWindowOptions): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: WINDOW_BACKGROUND,
    title: 'PalSentry',
    // Keep the native title bar on every platform, macOS included. Hiding it looks sleeker, but a
    // window without one is only draggable through a CSS `app-region: drag` region, and macOS does
    // not honour the system double-click action (zoom or minimize) in those regions, so the window
    // could not be dragged or maximised the way every other Mac app can
    // (https://github.com/electron/electron/issues/16385).
    webPreferences: {
      // No Node, no preload, no IPC: the renderer only speaks HTTP to the loopback server.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: options.devTools,
      spellcheck: false,
    },
  });

  // Show only once the first frame is painted, so the window never flashes white.
  window.once('ready-to-show', () => {
    window.show();
  });

  /**
   * Send every external link to the real browser.
   *
   * The app's donate and GitHub links use `target="_blank"`, which would otherwise open a bare
   * Electron window with no navigation controls.
   */
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternal(url, options.origin)) {
      void shell.openExternal(url);
    } else {
      options.logger.debug('Blocked a request to open a window', { url });
    }
    return { action: 'deny' };
  });

  // Nothing may navigate the app away from its own origin — not a link, not a redirect, not a
  // script. A page that tries is logged and ignored.
  window.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(options.origin)) return;
    event.preventDefault();
    options.logger.warn('Blocked navigation away from the app', { url });
    if (isExternal(url, options.origin)) void shell.openExternal(url);
  });

  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
    options.logger.warn('Blocked a webview attachment');
  });

  // A crashed renderer leaves an empty window; reloading is friendlier than a blank screen.
  window.webContents.on('render-process-gone', (_event, details) => {
    options.logger.error('The renderer stopped unexpectedly', { reason: details.reason });
    if (!window.isDestroyed() && details.reason !== 'clean-exit') window.reload();
  });

  void window.loadURL(options.origin);

  return window;
}

/**
 * Keep the app reachable from anywhere on screen.
 *
 * A window hidden on a monitor that has since been unplugged would otherwise be invisible and
 * unreachable, so the stored bounds are validated against the current displays.
 */
export function isVisibleOnSomeDisplay(bounds: Rectangle, workAreas: Rectangle[]): boolean {
  const MIN_VISIBLE = 48;
  return workAreas.some((area) => {
    const overlapX =
      Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const overlapY =
      Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
    return overlapX >= MIN_VISIBLE && overlapY >= MIN_VISIBLE;
  });
}

/** Where the shell stores window geometry, next to the rest of the app's state. */
export function windowStatePath(paths: DesktopPaths): string {
  return path.join(paths.dataDir, 'window.json');
}
