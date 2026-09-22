import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  sourcemap: true,
  clean: true,
  // `@palsentry/shared` ships as TypeScript source rather than compiled JS, so it has to be
  // bundled in. Everything else stays external and resolves from node_modules at runtime.
  noExternal: [/^@palsentry\//],
  // Native addon — never bundle it; its prebuilt binding must be loaded by Node directly.
  external: ['better-sqlite3'],
});
