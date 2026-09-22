/**
 * Copies the built SPA into the server's dist directory so a single Node process can serve
 * both the API and the frontend. This is what makes the Docker image a single container with
 * no CORS configuration and no second service.
 *
 * Run via `npm run build` from the repo root, which builds the web workspace first.
 */
import { access, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const webDist = path.resolve(serverRoot, '..', 'web', 'dist');
const target = path.resolve(serverRoot, 'dist', 'public');

try {
  await access(path.join(webDist, 'index.html'));
} catch {
  console.error(
    `\n[copy-web] No frontend build found at ${webDist}\n` +
      `[copy-web] Build the web workspace first:  npm run build -w @palsentry/web\n` +
      `[copy-web] Or build everything from the repo root:  npm run build\n`,
  );
  process.exit(1);
}

await rm(target, { recursive: true, force: true });
await cp(webDist, target, { recursive: true });
console.log(`[copy-web] Copied ${webDist} -> ${target}`);
