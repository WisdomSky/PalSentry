import { Menu, Tray, nativeImage, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DesktopPaths, MainLogger } from './paths.js';

/**
 * The tray icon.
 *
 * PalSentry is meant to keep recording while you are not looking at it, so closing the window
 * hides it instead of quitting, and the tray is how it stays reachable. It also carries the two
 * actions a background app needs: open it again, and quit when you actually mean it.
 *
 * Created only after `app.whenReady()` and referenced from a module-scope variable in the caller,
 * because a `Tray` that gets garbage collected takes the icon with it.
 */

/** Tray image for this platform: a template image on macOS, the coloured mark elsewhere. */
export function trayImage(trayDir: string): Electron.NativeImage {
  const file = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  const target = path.join(trayDir, file);

  if (!existsSync(target)) {
    // Never fatal: a tray icon is chrome, and a missing asset should not stop the app from
    // recording. An empty image gives an invisible but functional tray item.
    return nativeImage.createEmpty();
  }

  const image = nativeImage.createFromPath(target);
  // macOS tints template images for light and dark menu bars; set it explicitly so a rename or a
  // copy that drops the `Template` suffix still behaves.
  if (process.platform === 'darwin') image.setTemplateImage(true);

  return image;
}

export interface TrayOptions {
  paths: DesktopPaths;
  logger: MainLogger;
  getWindow: () => BrowserWindow | null;
  openWindow: () => void;
  quit: () => void;
  openLogFolder: () => void;
  checkForUpdates: () => void;
  canRestartToUpdate: () => boolean;
  restartToUpdate: () => void;
  /** One-line connection summary for the disabled status item. */
  connectionSummary: () => string;
}

export interface TrayController {
  /** Rebuild the menu, e.g. after the connection or update state changed. */
  refresh(): void;
  destroy(): void;
}

export function createTray(options: TrayOptions): TrayController {
  const tray = new Tray(trayImage(options.paths.trayDir));

  tray.setToolTip('PalSentry');

  function build(): Menu {
    return Menu.buildFromTemplate([
      { label: options.connectionSummary(), enabled: false },
      { type: 'separator' },
      { label: 'Open PalSentry', click: () => options.openWindow() },
      { type: 'separator' },
      {
        label: 'Check for updates…',
        click: () => {
          options.checkForUpdates();
          // The result lands in the status line below, so rebuild once it has had a chance.
          setTimeout(() => refresh(), 250);
        },
      },
      ...(options.canRestartToUpdate()
        ? ([
            { label: 'Restart to update', click: () => options.restartToUpdate() },
          ] satisfies Electron.MenuItemConstructorOptions[])
        : []),
      { type: 'separator' },
      { label: 'Open log folder', click: () => options.openLogFolder() },
      { type: 'separator' },
      { label: 'Quit PalSentry', click: () => options.quit() },
    ]);
  }

  function refresh(): void {
    try {
      tray.setContextMenu(build());
    } catch (error) {
      options.logger.warn('Could not refresh the tray menu', { error: String(error) });
    }
  }

  refresh();

  // Left-click opens the window on Windows and Linux, where a plain click is the expected action.
  // macOS opens the menu on click, which is left alone.
  if (process.platform !== 'darwin') {
    tray.on('click', () => options.openWindow());
  }

  return {
    refresh,
    destroy: () => {
      // A destroyed tray on shutdown would throw on some platforms; drop it quietly.
      try {
        tray.destroy();
      } catch {
        /* already gone */
      }
    },
  };
}

/** Open a folder in the OS file manager. */
export function openFolder(target: string): void {
  void shell.openPath(target);
}
