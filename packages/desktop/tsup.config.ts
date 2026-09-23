import { defineConfig } from 'tsup';

/**
 * Bundle the Electron main process.
 *
 * One ESM file, because `packages/desktop/package.json` is `"type": "module"`:
 *
 * - `electron` and `electron-updater` stay external — they are provided by the runtime, and
 *   bundling Electron's own API would be nonsense.
 * - `better-sqlite3` never appears here at all: the shell imports the server bundle dynamically, so
 *   the native addon is only referenced from `dist/server.js` (which keeps it external too).
 * - `clean` is off because the staging step puts the built SPA and tray images into `dist/` beside
 *   this bundle, and a rebuild must not delete them.
 */
export default defineConfig({
  entry: { main: 'src/main.ts' },
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: false,
  splitting: false,
  external: ['electron', 'electron-updater'],
  // The shell has no runtime dependencies of its own; everything else is Node built-ins.
  noExternal: [],
  silent: true,
});
