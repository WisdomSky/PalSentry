import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { closeContext, createContext, type AppContext } from '../../src/context.js';
import { createLogger } from '../../src/logger.js';
import { startPalworldStub, type PalworldStub, type StubOptions } from './palworld-stub.js';

/**
 * Build a fully wired PalSentry app backed by a stubbed Palworld server and an in-memory
 * database, driven through `app.inject()` — real routing, real hooks, real cookies, no ports.
 */

export const TEST_USERNAME = 'admin';
export const TEST_PASSWORD = 'test-palsentry-password';
export const TEST_SESSION_SECRET = 'test-session-secret-that-is-long-enough-1234';

export interface TestApp {
  app: Awaited<ReturnType<typeof buildApp>>;
  stub: PalworldStub;
  /** The live context, so tests can reach the real services and database. */
  ctx: AppContext;
  /** Override the env for this app. Keys not given fall back to the defaults below. */
  close(): Promise<void>;
}

export interface CreateTestAppOptions {
  stub?: StubOptions;
  env?: Record<string, string | undefined>;
  /** Replace the stub entirely, e.g. to point at an unreachable host. */
  palworldUrl?: string;
}

export function baseEnv(palworldUrl: string, overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'test',
    PALWORLD_REST_URL: palworldUrl,
    PALWORLD_ADMIN_PASSWORD: 'test-palworld-password',
    PALSENTRY_LOGIN_USERNAME: TEST_USERNAME,
    PALSENTRY_LOGIN_PASSWORD: TEST_PASSWORD,
    PALSENTRY_SESSION_SECRET: TEST_SESSION_SECRET,
    // Keep the registry out of the working tree.
    PALSENTRY_DB_PATH: ':memory:',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

export async function createTestApp(options: CreateTestAppOptions = {}): Promise<TestApp> {
  const stub = await startPalworldStub({ password: 'test-palworld-password', ...options.stub });

  const config = loadConfig(baseEnv(options.palworldUrl ?? stub.baseUrl, options.env));
  const logger = createLogger({ level: 'silent', pretty: false });
  const ctx = createContext(config, logger);
  const app = await buildApp(ctx);
  await app.ready();

  return {
    app,
    stub,
    ctx,
    close: async () => {
      await app.close();
      await closeContext(ctx);
      await stub.close();
    },
  };
}

/** Sign in and return the session cookie header value ready for reuse. */
export async function signIn(
  app: Awaited<ReturnType<typeof buildApp>>,
  username = TEST_USERNAME,
  password = TEST_PASSWORD,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: { username, password },
  });

  if (response.statusCode !== 200) {
    throw new Error(`sign-in failed: ${response.statusCode} ${response.body}`);
  }

  const cookie = response.cookies.find((entry) => entry.name === 'palsentry_session');
  if (cookie === undefined) throw new Error('sign-in did not set a session cookie');

  return `${cookie.name}=${cookie.value}`;
}

/** Pull a single cookie out of an inject response. */
export function cookieHeader(response: LightMyRequestResponse, name: string): string | null {
  const cookie = response.cookies.find((entry) => entry.name === name);
  return cookie === undefined ? null : `${cookie.name}=${cookie.value}`;
}
