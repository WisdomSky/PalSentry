import { defineConfig } from 'tsup';

/**
 * Desktop (Electron) build of the server.
 *
 * The CLI build in `tsup.config.ts` keeps every dependency external because the Docker image
 * installs `node_modules`. A packaged Electron app has no `node_modules` to resolve from, so this
 * entry bundles everything except the native addon, which must stay a real file on disk and be
 * unpacked from `app.asar` by electron-builder.
 *
 * Output goes to `dist/desktop/` so the CLI build (which cleans `dist`) cannot delete it and vice
 * versa; the desktop package stages the result into its own `dist/`.
 */
export default defineConfig({
  entry: ['src/desktop-entry.ts'],
  outDir: 'dist/desktop',
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  // One self-contained file: the desktop package stages a single `server.js` next to the SPA.
  splitting: false,
  // Bundle every dependency, including CJS ones such as fastify and pino, but never the native
  // addon: its JavaScript locates a prebuilt `.node` binding at runtime, and electron-builder has
  // to unpack that file from `app.asar`. tsup drops packages from `external` when `noExternal`
  // matches them, so the exclusion has to be part of this pattern.
  noExternal: [/^(?!better-sqlite3$).*/],
  external: ['better-sqlite3'],
  banner: {
    // `pino` and `fastify` reach for `require` in a few code paths that esbuild cannot statically
    // rewrite. The shim keeps those calls working in the bundled ESM output.
    js: "import { createRequire as __palsentryCreateRequire } from 'node:module'; const require = __palsentryCreateRequire(import.meta.url);",
  },
});
