import { app, dialog, shell } from 'electron';
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';
import { Menu } from 'electron';

/**
 * The application menu.
 *
 * Two things here are not cosmetic:
 *
 * - **Edit** exists so the standard text shortcuts work in the connection form. Without it, ⌘V
 *   pastes nothing on macOS, which for a screen whose only two fields are a URL and a password is
 *   the difference between usable and not.
 * - **About** reports the version and the update state, because in a tray-first app it is the only
 *   place a user can see whether they are up to date.
 */

const GITHUB_URL = 'https://github.com/wisdomsky/palsentry';
const ISSUES_URL = 'https://github.com/wisdomsky/palsentry/issues';

export interface MenuOptions {
  version: string;
  /** Human-readable update state, e.g. `Up to date` or `Downloading… 42%`. */
  updateStatus: () => string;
  /** Runs an update check; a no-op where updates are unavailable. */
  checkForUpdates: () => void;
  /** True when Restart to update should be offered. */
  canRestartToUpdate: () => boolean;
  restartToUpdate: () => void;
  openLogFolder: () => void;
  openDataFolder: () => void;
  getWindow: () => BrowserWindow | null;
}

export function showAboutDialog(options: MenuOptions): void {
  const lines = [
    `Version ${options.version}`,
    `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
    '',
    `Updates: ${options.updateStatus()}`,
    '',
    'PalSentry keeps your Palworld server safe. It runs entirely on this computer —',
    'the Palworld admin password you enter is never written to disk.',
  ];

  void dialog.showMessageBox({
    type: 'info',
    title: 'About PalSentry',
    message: 'PalSentry',
    detail: lines.join('\n'),
    buttons: ['OK'],
    defaultId: 0,
    noLink: true,
  });
}

export function buildApplicationMenu(options: MenuOptions): Menu {
  const isMac = process.platform === 'darwin';
  const isDev = !app.isPackaged;

  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: app.name,
          submenu: [
            { label: 'About PalSentry', click: () => showAboutDialog(options) },
            { label: 'Check for updates…', click: () => options.checkForUpdates() },
            { type: 'separator' },
            { label: 'Open log folder', click: () => options.openLogFolder() },
            { label: 'Open data folder', click: () => options.openDataFolder() },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
      ]
    : [];

  const template: MenuItemConstructorOptions[] = [
    ...appMenu,
    {
      label: 'File',
      submenu: [
        // Windows and Linux have no application menu, so these live under File there.
        ...(isMac
          ? []
          : ([
              { label: 'About PalSentry', click: () => showAboutDialog(options) },
              { label: 'Check for updates…', click: () => options.checkForUpdates() },
              { type: 'separator' },
              { label: 'Open log folder', click: () => options.openLogFolder() },
              { label: 'Open data folder', click: () => options.openDataFolder() },
              { type: 'separator' },
            ] satisfies MenuItemConstructorOptions[])),
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...((isMac ? [{ role: 'pasteAndMatchStyle' }] : []) satisfies MenuItemConstructorOptions[]),
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isDev
          ? ([
              { type: 'separator' },
              { role: 'toggleDevTools' },
            ] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...((isMac
          ? [{ type: 'separator' }, { role: 'front' }]
          : []) satisfies MenuItemConstructorOptions[]),
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Check for updates…',
          click: () => options.checkForUpdates(),
        },
        {
          label: 'Restart to update',
          enabled: options.canRestartToUpdate(),
          click: () => options.restartToUpdate(),
        },
        { type: 'separator' },
        { label: 'PalSentry on GitHub', click: () => void shell.openExternal(GITHUB_URL) },
        { label: 'Report an issue', click: () => void shell.openExternal(ISSUES_URL) },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}
