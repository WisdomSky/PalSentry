/**
 * Assemble everything the packaged app needs into `packages/desktop/dist`.
 *
 * The layout is what the shell expects at runtime, and it is identical in development and in a
 * packaged build, so nothing here is conditional:
 *
 * ```
 * dist/
 *   main.js            Electron main process (tsup)
 *   server.js          embedded PalSentry server bundle (tsup, @palsentry/server)
 *   public/            built SPA, served by the embedded server
 *   assets/tray/       tray images, loaded by the shell
 * ```
 *
 * `server.js` is a copy rather than an import: the server package keeps `better-sqlite3` external,
 * and the file has to sit beside `main.js` for the dynamic import in `server-host.ts` to find it.
 */

import { cp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');

const dist = path.join(desktopRoot, 'dist');
const serverBundle = path.join(
  repoRoot,
  'packages',
  'server',
  'dist',
  'desktop',
  'desktop-entry.js',
);
const serverMap = `${serverBundle}.map`;
const webDist = path.join(repoRoot, 'packages', 'web', 'dist');
const trayAssets = path.join(desktopRoot, 'assets', 'tray');

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function requirePath(target, hint) {
  if (!(await exists(target))) {
    console.error(`[desktop-stage] missing ${target}\n  ${hint}`);
    process.exit(1);
  }
}

await requirePath(serverBundle, 'Build the server first: npm run build:desktop-server');
await requirePath(
  path.join(webDist, 'index.html'),
  'Build the web app first: npm run build -w @palsentry/web',
);
await requirePath(
  path.join(trayAssets, 'tray.png'),
  'Generate icons first: npm run icons -w palsentrydesktop',
);

await mkdir(dist, { recursive: true });

// Stale copies would be worse than none: the app would serve a mixture of two builds.
await rm(path.join(dist, 'public'), { recursive: true, force: true });
await rm(path.join(dist, 'assets'), { recursive: true, force: true });
await rm(path.join(dist, 'server.js'), { force: true });
await rm(path.join(dist, 'server.js.map'), { force: true });

await cp(serverBundle, path.join(dist, 'server.js'));
if (await exists(serverMap)) await cp(serverMap, path.join(dist, 'server.js.map'));

await cp(webDist, path.join(dist, 'public'), { recursive: true });
await cp(trayAssets, path.join(dist, 'assets', 'tray'), { recursive: true });

console.log('[desktop-stage] staged dist/server.js, dist/public and dist/assets/tray');
