import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MAP_PROJECTION,
  DEFAULT_MAP_TEXTURE_URL,
  DEFAULT_WORLD_TREE_TEXTURE_URL,
  type MapMeta,
  type MapProjection,
} from '@palsentry/shared';
import { z } from 'zod';
import { PASSWORD_HASH_PREFIX, hashPassword, parsePasswordHash } from './auth/password.js';

const DEFAULT_PALSENTRY_LOGIN_PASSWORD = 'admin';
const DEFAULT_PALSENTRY_SESSION_SECRET =
  'bb5930c05402c03f897c0cdd0e98bb8420a8359f7dbab25fe53df1a5c060d5ea';

/** Thrown when the environment is unusable. The entrypoint prints this and exits non-zero. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface PalworldConfig {
  /** Fully-qualified REST API base, always ending in `/v1/api`. */
  apiBaseUrl: string;
  username: string;
  password: string;
  timeoutMs: number;
}

export interface AuthConfig {
  username: string;
  /** `scrypt$salt$hash`. Always populated — derived from `PALSENTRY_LOGIN_PASSWORD` if needed. */
  passwordHash: string;
  /** True when using a plaintext password (operator-supplied or the built-in default). */
  passwordIsPlaintext: boolean;
  sessionSecret: string;
  sessionTtlHours: number;
  secureCookies: boolean;
}

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  port: number;
  host: string;
  logLevel: string;
  logPretty: boolean;
  dataDir: string;
  dbPath: string;
  palworld: PalworldConfig;
  auth: AuthConfig;
  allowDestructive: boolean;
  history: {
    retentionDays: number;
    sampleIntervalSeconds: number;
  };
  map: MapMeta;
  restart: {
    defaultWaitSeconds: number;
    /** How long to wait for the server to come back before declaring the restart failed. */
    healthTimeoutSeconds: number;
    /** How often to probe while waiting for the process to return. */
    pollIntervalMs: number;
  };
  /** Candidate locations for the built SPA, checked in order by the entrypoint. */
  webDistCandidates: string[];
  /** Startup warnings to surface once the logger exists. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Env field helpers
// ---------------------------------------------------------------------------

/**
 * A required, non-empty string.
 *
 * Missing values are preprocessed to `''` so the failure message is ours rather than zod's
 * type error, which reads poorly for environment variables.
 */
const requiredString = (message: string) =>
  z.preprocess(
    (value) => (typeof value === 'string' ? value.trim() : ''),
    z.string().min(1, message),
  );

const optionalString = () =>
  z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed === undefined || trimmed === '' ? null : trimmed;
    });

const envInt = (defaultValue: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      const trimmed = value?.trim();
      if (trimmed === undefined || trimmed === '') return defaultValue;
      const parsed = Number(trimmed);
      if (!Number.isInteger(parsed)) {
        ctx.addIssue({ code: 'custom', message: `must be an integer, got "${trimmed}"` });
        return z.NEVER;
      }
      if (parsed < min || parsed > max) {
        ctx.addIssue({
          code: 'custom',
          message: `must be between ${min} and ${max}, got ${parsed}`,
        });
        return z.NEVER;
      }
      return parsed;
    });

const envBool = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      const trimmed = value?.trim().toLowerCase();
      if (trimmed === undefined || trimmed === '') return defaultValue;
      if (['true', '1', 'yes', 'on'].includes(trimmed)) return true;
      if (['false', '0', 'no', 'off'].includes(trimmed)) return false;
      ctx.addIssue({
        code: 'custom',
        message: `must be a boolean (true/false/1/0/yes/no/on/off), got "${value}"`,
      });
      return z.NEVER;
    });

const envEnum = <const T extends readonly [string, ...string[]]>(
  values: T,
  defaultValue: T[number],
) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      const trimmed = value?.trim().toLowerCase();
      if (trimmed === undefined || trimmed === '') return defaultValue as T[number];
      if (!values.includes(trimmed as T[number])) {
        ctx.addIssue({
          code: 'custom',
          message: `must be one of ${values.join(' | ')}, got "${value}"`,
        });
        return z.NEVER;
      }
      return trimmed as T[number];
    });

/**
 * Secrets are read verbatim — never trimmed.
 *
 * Silently trimming a password would make a credential that legitimately starts or ends with a
 * space impossible to use, and would turn a stray space in `.env` into a confusing auth failure.
 * Instead we keep the value exact and warn about surrounding whitespace at startup.
 */
const secretString = (message: string) =>
  z.preprocess((value) => (typeof value === 'string' ? value : ''), z.string().min(1, message));

const envSchema = z.object({
  NODE_ENV: envEnum(['development', 'production', 'test'] as const, 'development'),

  // --- Palworld server ---
  PALWORLD_REST_URL: requiredString(
    'PALWORLD_REST_URL is required, e.g. http://192.168.1.50:8212 (the host and RESTAPIPort of your Palworld server)',
  ),
  PALSERVER_REST_USERNAME: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed === undefined || trimmed === '' ? 'admin' : trimmed;
    }),
  PALWORLD_ADMIN_PASSWORD: secretString(
    'PALWORLD_ADMIN_PASSWORD is required (the AdminPassword from your PalWorldSettings.ini)',
  ),
  PALSERVER_TIMEOUT_MS: envInt(10_000, 500, 120_000),

  // --- PalSentry auth ---
  PALSENTRY_LOGIN_USERNAME: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed === undefined || trimmed === '' ? 'admin' : trimmed;
    }),
  PALSENTRY_LOGIN_PASSWORD: z
    .string()
    .optional()
    .transform((value) => value || DEFAULT_PALSENTRY_LOGIN_PASSWORD),
  PALSENTRY_LOGIN_PASSWORD_HASH: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed === undefined || trimmed === '' ? null : trimmed;
    }),
  PALSENTRY_SESSION_SECRET: z
    .string()
    .optional()
    .transform((value) => value || DEFAULT_PALSENTRY_SESSION_SECRET),
  PALSENTRY_SESSION_TTL_HOURS: envInt(12, 1, 24 * 30),
  PALSENTRY_TRUST_PROXY: envBool(false),

  // --- PalSentry runtime ---
  PALSENTRY_PORT: envInt(3000, 1, 65_535),
  PALSENTRY_HOST: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed === undefined || trimmed === '' ? '0.0.0.0' : trimmed;
    }),
  PALSENTRY_DATA_DIR: optionalString(),
  PALSENTRY_DB_PATH: optionalString(),
  PALSENTRY_ALLOW_DESTRUCTIVE: envBool(true),
  PALSENTRY_HISTORY_RETENTION_DAYS: envInt(30, 1, 3650),
  PALSENTRY_SAMPLE_INTERVAL_SECONDS: envInt(60, 5, 3600),
  PALSENTRY_RESTART_WAIT_SECONDS: envInt(30, 0, 3600),
  PALSENTRY_RESTART_HEALTH_TIMEOUT_SECONDS: envInt(180, 10, 1800),
  PALSENTRY_RESTART_POLL_INTERVAL_MS: envInt(2_000, 250, 30_000),
  PALSENTRY_WEB_DIST: optionalString(),

  // --- Map (optional) ---
  PALSENTRY_MAP_TEXTURE_URL: optionalString(),
  PALSENTRY_WORLD_TREE_TEXTURE_URL: optionalString(),
  PALSENTRY_MAP_PROJECTION: envEnum(['none', 'new', 'legacy'] as const, DEFAULT_MAP_PROJECTION),

  LOG_LEVEL: envEnum(
    ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const,
    'info',
  ),
});

/** Env keys whose values must never be echoed back in an error message. */
const SECRET_KEYS = new Set([
  'PALWORLD_ADMIN_PASSWORD',
  'PALSENTRY_LOGIN_PASSWORD',
  'PALSENTRY_LOGIN_PASSWORD_HASH',
  'PALSENTRY_SESSION_SECRET',
]);

function formatIssues(error: z.ZodError, env: NodeJS.ProcessEnv): string {
  return error.issues
    .map((issue) => {
      const key = issue.path.join('.') || '(root)';
      const raw = env[key];
      const current = SECRET_KEYS.has(key)
        ? raw === undefined
          ? 'not set'
          : 'set (value hidden)'
        : raw === undefined
          ? 'not set'
          : `"${raw}"`;
      return `  • ${key}\n      ${issue.message}\n      current: ${current}`;
    })
    .join('\n');
}

/**
 * Normalise the operator-supplied Palworld URL into a `/v1/api` base.
 *
 * Accepts `http://host:8212`, `http://host:8212/`, and `http://host:8212/v1/api` so a user
 * cannot get it subtly wrong by copying either form out of the docs.
 */
function normaliseApiBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(
      `PALWORLD_REST_URL is not a valid URL: "${raw}"\n` +
        `  Expected something like http://192.168.1.50:8212`,
    );
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`PALWORLD_REST_URL must use http or https, got "${url.protocol}"`);
  }

  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith('/v1/api') ? pathname : `${pathname}/v1/api`;
  url.search = '';
  url.hash = '';

  // `toString()` appends a trailing slash for an empty path; ours is never empty here.
  return url.toString().replace(/\/$/, '');
}

/** Parse and validate the environment. Throws {@link ConfigError} with actionable detail. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    throw new ConfigError(
      `Invalid configuration:\n${formatIssues(result.error, env)}\n\n` +
        `See .env.example for a documented template.`,
    );
  }

  const parsed = result.data;
  const warnings: string[] = [];

  // ---- Auth: resolve the password hash -------------------------------------
  let passwordHash: string;
  let passwordIsPlaintext = false;

  if (parsed.PALSENTRY_LOGIN_PASSWORD_HASH !== null) {
    if (parsePasswordHash(parsed.PALSENTRY_LOGIN_PASSWORD_HASH) === null) {
      throw new ConfigError(
        'PALSENTRY_LOGIN_PASSWORD_HASH is malformed.\n' +
          `  Expected the form ${PASSWORD_HASH_PREFIX}<saltHex>$<hashHex>, produced by:\n` +
          '    npm run hash-password -- "your-password"',
      );
    }
    passwordHash = parsed.PALSENTRY_LOGIN_PASSWORD_HASH;
    if (parsed.PALSENTRY_LOGIN_PASSWORD !== DEFAULT_PALSENTRY_LOGIN_PASSWORD) {
      warnings.push(
        'Both PALSENTRY_LOGIN_PASSWORD and PALSENTRY_LOGIN_PASSWORD_HASH are set. Using the hash; ' +
          'remove PALSENTRY_LOGIN_PASSWORD so the plaintext password is not stored on disk.',
      );
    }
  } else {
    // Hash the plaintext once at boot so the login path always compares against a hash.
    passwordHash = hashPassword(parsed.PALSENTRY_LOGIN_PASSWORD);
    passwordIsPlaintext = true;
    if (parsed.PALSENTRY_LOGIN_PASSWORD === DEFAULT_PALSENTRY_LOGIN_PASSWORD) {
      warnings.push(
        'PALSENTRY_LOGIN_PASSWORD is using the default value "admin". Change it before exposing ' +
          'PalSentry beyond a trusted local network.',
      );
    } else {
      warnings.push(
        'PALSENTRY_LOGIN_PASSWORD is stored in plaintext. This is fine for a local .env, but you can ' +
          'avoid keeping the password on disk by using PALSENTRY_LOGIN_PASSWORD_HASH instead ' +
          '(npm run hash-password).',
      );
    }
  }

  if (
    parsed.PALSENTRY_LOGIN_PASSWORD &&
    parsed.PALSENTRY_LOGIN_PASSWORD !== parsed.PALSENTRY_LOGIN_PASSWORD.trim()
  ) {
    warnings.push(
      'PALSENTRY_LOGIN_PASSWORD has leading or trailing whitespace, which is easy to lose when ' +
        'editing .env files. Remove it unless it is intentional.',
    );
  }

  if (parsed.PALSENTRY_SESSION_SECRET.length < 32) {
    throw new ConfigError(
      `PALSENTRY_SESSION_SECRET must be at least 32 characters (got ${parsed.PALSENTRY_SESSION_SECRET.length}).\n` +
        '  Generate one with:  openssl rand -hex 32',
    );
  }
  if (parsed.PALSENTRY_SESSION_SECRET === DEFAULT_PALSENTRY_SESSION_SECRET) {
    warnings.push(
      'PALSENTRY_SESSION_SECRET is using the shared default value. Replace it with a random secret ' +
        'before exposing PalSentry beyond a trusted local network.',
    );
  }

  // ---- Paths ---------------------------------------------------------------
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const dataDir = path.resolve(parsed.PALSENTRY_DATA_DIR ?? path.join(process.cwd(), 'data'));
  const dbPath = parsed.PALSENTRY_DB_PATH
    ? // `:memory:` is a SQLite sentinel, not a path — resolving it would create a file named
      // literally ":memory:" on disk. Tests rely on this.
      parsed.PALSENTRY_DB_PATH === ':memory:'
      ? ':memory:'
      : path.resolve(parsed.PALSENTRY_DB_PATH)
    : path.join(dataDir, 'palsentry.db');

  const webDistCandidates = [
    ...(parsed.PALSENTRY_WEB_DIST ? [path.resolve(parsed.PALSENTRY_WEB_DIST)] : []),
    // Production bundle: the SPA is copied next to the compiled server.
    path.join(moduleDir, 'public'),
    // Built once, then run from src via tsx.
    path.join(moduleDir, '..', 'dist', 'public'),
    // Local dev against the Vite dev server is separate; this covers `vite build` + tsx.
    path.join(moduleDir, '..', '..', 'web', 'dist'),
  ];

  // ---- Non-fatal guidance --------------------------------------------------
  if (parsed.PALSENTRY_ALLOW_DESTRUCTIVE) {
    warnings.push(
      'PALSENTRY_ALLOW_DESTRUCTIVE=true — kick, ban, unban, shutdown, stop, and restart are enabled. ' +
        'Make sure PalSentry is not reachable from the public internet.',
    );
  }

  // ---- Map -----------------------------------------------------------------
  // Texture URLs only matter while a projection is active; `none` means interactive grids.
  const mapProjection = parsed.PALSENTRY_MAP_PROJECTION as MapProjection;
  const palpagosTextureUrl =
    mapProjection === 'none' ? null : (parsed.PALSENTRY_MAP_TEXTURE_URL ?? DEFAULT_MAP_TEXTURE_URL);
  const worldTreeTextureUrl =
    mapProjection === 'none'
      ? null
      : (parsed.PALSENTRY_WORLD_TREE_TEXTURE_URL ?? DEFAULT_WORLD_TREE_TEXTURE_URL);

  if (
    (parsed.PALSENTRY_MAP_TEXTURE_URL || parsed.PALSENTRY_WORLD_TREE_TEXTURE_URL) &&
    mapProjection === 'none'
  ) {
    warnings.push(
      'A map texture URL is set but PALSENTRY_MAP_PROJECTION is "none", so both regions will ' +
        'render as abstract grids. Set it to "new" (Palworld 1.0+) or "legacy" to use textures.',
    );
  }

  if (parsed.NODE_ENV === 'production' && parsed.PALSENTRY_TRUST_PROXY === false) {
    warnings.push(
      'PALSENTRY_TRUST_PROXY=false, so the session cookie is not marked Secure. Set it to true ' +
        'when PalSentry is served over HTTPS/TLS by a reverse proxy.',
    );
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PALSENTRY_PORT,
    host: parsed.PALSENTRY_HOST,
    logLevel: parsed.LOG_LEVEL,
    logPretty: parsed.NODE_ENV !== 'production',
    dataDir,
    dbPath,
    palworld: {
      apiBaseUrl: normaliseApiBaseUrl(parsed.PALWORLD_REST_URL),
      username: parsed.PALSERVER_REST_USERNAME,
      password: parsed.PALWORLD_ADMIN_PASSWORD,
      timeoutMs: parsed.PALSERVER_TIMEOUT_MS,
    },
    auth: {
      username: parsed.PALSENTRY_LOGIN_USERNAME,
      passwordHash,
      passwordIsPlaintext,
      sessionSecret: parsed.PALSENTRY_SESSION_SECRET,
      sessionTtlHours: parsed.PALSENTRY_SESSION_TTL_HOURS,
      secureCookies: parsed.PALSENTRY_TRUST_PROXY,
    },
    allowDestructive: parsed.PALSENTRY_ALLOW_DESTRUCTIVE,
    history: {
      retentionDays: parsed.PALSENTRY_HISTORY_RETENTION_DAYS,
      sampleIntervalSeconds: parsed.PALSENTRY_SAMPLE_INTERVAL_SECONDS,
    },
    map: {
      projection: mapProjection,
      layers: {
        palpagos: { textureUrl: palpagosTextureUrl },
        worldTree: { textureUrl: worldTreeTextureUrl },
      },
    },
    restart: {
      defaultWaitSeconds: parsed.PALSENTRY_RESTART_WAIT_SECONDS,
      healthTimeoutSeconds: parsed.PALSENTRY_RESTART_HEALTH_TIMEOUT_SECONDS,
      pollIntervalMs: parsed.PALSENTRY_RESTART_POLL_INTERVAL_MS,
    },
    webDistCandidates,
    warnings,
  };
}
