import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The shell's view of `desktop.json`.
 *
 * One small JSON file shared by the shell and the embedded server:
 *
 * - The **shell** writes `port` — the port it settled on, so the app keeps a stable origin (and
 *   therefore the same `localStorage` theme, polling cadence and map calibration) across restarts.
 * - The **server** writes `restUrl` when the user connects, so the connection screen can prefill it.
 *
 * **It cannot hold a password.** That is enforced, not merely intended: the shell only ever writes
 * these keys, and a file that somehow contains something password-shaped is rewritten without it
 * at the next launch, so a mistake in a future version cannot quietly start persisting credentials.
 */
export interface DesktopConfigFile {
  port: number | null;
  restUrl: string | null;
  /** Basic-auth username for the REST API, e.g. `admin`. Not a secret. */
  username: string | null;
}

const EMPTY: DesktopConfigFile = { port: null, restUrl: null, username: null };

/** Keys that must never be persisted. Matched loosely so `adminPassword` is caught too. */
const FORBIDDEN_KEY = /pass|secret|token|credential/i;

/** Keys this file is allowed to carry, in a stable write order. */
const ALLOWED_KEYS = ['port', 'restUrl', 'username'] as const;

function sanitise(raw: unknown): { config: DesktopConfigFile; stripped: string[] } {
  const stripped: string[] = [];

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { config: { ...EMPTY }, stripped };
  }

  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_KEY.test(key)) stripped.push(key);
  }

  const port = record.port;
  const restUrl = record.restUrl;
  const username = record.username;

  return {
    config: {
      port:
        typeof port === 'number' && Number.isInteger(port) && port >= 0 && port <= 65_535
          ? port
          : null,
      restUrl: typeof restUrl === 'string' && restUrl !== '' ? restUrl : null,
      username: typeof username === 'string' && username !== '' ? username : null,
    },
    stripped,
  };
}

export interface ReadResult {
  config: DesktopConfigFile;
  /** Keys that were dropped because they looked like credentials. Logged by the caller. */
  stripped: string[];
}

/** Read the shared file, tolerating a missing or damaged one. */
export async function readDesktopConfig(configPath: string): Promise<ReadResult> {
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch {
    return { config: { ...EMPTY }, stripped: [] };
  }

  try {
    return sanitise(JSON.parse(raw));
  } catch {
    return { config: { ...EMPTY }, stripped: [] };
  }
}

/**
 * Merge a patch into the file, atomically.
 *
 * Read-modify-write with a temporary file and a rename: an interrupted write cannot leave a
 * half-written file behind, and keys the server owns (`restUrl`) survive a port update.
 */
export async function writeDesktopConfig(
  configPath: string,
  patch: Partial<DesktopConfigFile>,
): Promise<DesktopConfigFile> {
  const { config } = await readDesktopConfig(configPath);
  const merged = { ...config, ...patch };

  const payload: Record<string, unknown> = {};
  for (const key of ALLOWED_KEYS) {
    const value = merged[key];
    if (value !== null) payload[key] = value;
  }

  await mkdir(path.dirname(configPath), { recursive: true });
  const temporary = `${configPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(temporary, configPath);

  return merged;
}
