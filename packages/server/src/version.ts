/**
 * Application version reported by `/api/health` and `/api/meta`.
 *
 * Kept as a literal rather than read from package.json so the bundled server has no runtime
 * file-resolution dependency on a path that changes between `tsx` and `tsup` output.
 * Bump alongside the root `package.json` version.
 */
export const APP_VERSION = '1.2.0';
