import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_MAP_PROJECTION,
  DEFAULT_MAP_TEXTURE_URL,
  DEFAULT_WAYBACK_INTERVAL_SECONDS,
  DEFAULT_WORLD_TREE_TEXTURE_URL,
} from '@palsentry/shared';
import { verifyPassword } from '../src/auth/password.js';
import { ConfigError, loadConfig } from '../src/config.js';

/** A minimal, valid environment. Individual tests override single keys. */
function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    PALWORLD_REST_URL: 'http://192.168.1.50:8212',
    PALWORLD_ADMIN_PASSWORD: 'palworld-admin-password',
    PALSENTRY_LOGIN_USERNAME: 'admin',
    PALSENTRY_LOGIN_PASSWORD: 'palsentry-admin-password',
    PALSENTRY_SESSION_SECRET: 'a'.repeat(48),
    ...overrides,
  };
}

/** Assert that loading throws a ConfigError whose message mentions `needle`. */
function assertConfigError(env: NodeJS.ProcessEnv, needle: string): void {
  assert.throws(
    () => loadConfig(env),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError, `expected ConfigError, got ${String(error)}`);
      assert.match(error.message, new RegExp(needle, 'i'));
      return true;
    },
  );
}

describe('loadConfig', () => {
  it('parses a minimal valid environment', () => {
    const config = loadConfig(validEnv());
    assert.equal(config.port, 3000);
    assert.equal(config.host, '0.0.0.0');
    assert.equal(config.palworld.username, 'admin');
    assert.equal(config.palworld.timeoutMs, 10_000);
    assert.equal(config.auth.username, 'admin');
    assert.equal(config.auth.sessionTtlHours, 12);
    assert.equal(config.auth.secureCookies, false);
    assert.equal(config.allowDestructive, true, 'destructive actions are enabled by default');
    assert.equal(config.history.retentionDays, 30);
    assert.equal(config.history.sampleIntervalSeconds, 60);
    assert.equal(config.history.waybackIntervalSeconds, 5);
    assert.equal(DEFAULT_WAYBACK_INTERVAL_SECONDS, 5);
    assert.equal(config.map.projection, DEFAULT_MAP_PROJECTION);
    assert.equal(config.map.layers.palpagos.textureUrl, DEFAULT_MAP_TEXTURE_URL);
    assert.equal(config.map.layers.worldTree.textureUrl, DEFAULT_WORLD_TREE_TEXTURE_URL);
    assert.equal(config.restart.defaultWaitSeconds, 30);
  });

  describe('Palworld API URL normalisation', () => {
    it('appends /v1/api when the bare host is given', () => {
      const config = loadConfig(validEnv({ PALWORLD_REST_URL: 'http://192.168.1.50:8212' }));
      assert.equal(config.palworld.apiBaseUrl, 'http://192.168.1.50:8212/v1/api');
    });

    it('tolerates a trailing slash', () => {
      const config = loadConfig(validEnv({ PALWORLD_REST_URL: 'http://192.168.1.50:8212/' }));
      assert.equal(config.palworld.apiBaseUrl, 'http://192.168.1.50:8212/v1/api');
    });

    it('keeps an explicit /v1/api instead of doubling it', () => {
      const config = loadConfig(validEnv({ PALWORLD_REST_URL: 'http://192.168.1.50:8212/v1/api' }));
      assert.equal(config.palworld.apiBaseUrl, 'http://192.168.1.50:8212/v1/api');
    });

    it('keeps an explicit /v1/api with a trailing slash', () => {
      const config = loadConfig(validEnv({ PALWORLD_REST_URL: 'http://host:8212/v1/api/' }));
      assert.equal(config.palworld.apiBaseUrl, 'http://host:8212/v1/api');
    });

    it('supports https and hostnames', () => {
      const config = loadConfig(
        validEnv({ PALWORLD_REST_URL: 'https://palworld.example.com:8212' }),
      );
      assert.equal(config.palworld.apiBaseUrl, 'https://palworld.example.com:8212/v1/api');
    });

    it('drops query strings and fragments', () => {
      const config = loadConfig(validEnv({ PALWORLD_REST_URL: 'http://host:8212/?x=1#frag' }));
      assert.equal(config.palworld.apiBaseUrl, 'http://host:8212/v1/api');
    });

    it('rejects a non-http protocol', () => {
      assertConfigError(validEnv({ PALWORLD_REST_URL: 'ftp://host:8212' }), 'http or https');
    });

    it('rejects a malformed URL', () => {
      assertConfigError(validEnv({ PALWORLD_REST_URL: 'not-a-url' }), 'not a valid URL');
    });
  });

  describe('required fields', () => {
    it('requires PALWORLD_REST_URL', () => {
      assertConfigError(
        validEnv({ PALWORLD_REST_URL: undefined }),
        'PALWORLD_REST_URL is required',
      );
    });

    it('requires PALWORLD_ADMIN_PASSWORD', () => {
      assertConfigError(
        validEnv({ PALWORLD_ADMIN_PASSWORD: undefined }),
        'PALWORLD_ADMIN_PASSWORD is required',
      );
    });

    it('treats a blank value as missing', () => {
      assertConfigError(validEnv({ PALWORLD_REST_URL: '   ' }), 'PALWORLD_REST_URL is required');
    });
  });

  describe('auth credentials', () => {
    it('uses the default password and session secret when they are unset', () => {
      const config = loadConfig(
        validEnv({
          PALSENTRY_LOGIN_PASSWORD: undefined,
          PALSENTRY_LOGIN_PASSWORD_HASH: undefined,
          PALSENTRY_SESSION_SECRET: undefined,
        }),
      );

      assert.equal(verifyPassword('admin', config.auth.passwordHash), true);
      assert.equal(config.auth.passwordIsPlaintext, true);
      assert.equal(
        config.auth.sessionSecret,
        'bb5930c05402c03f897c0cdd0e98bb8420a8359f7dbab25fe53df1a5c060d5ea',
      );
      assert.ok(config.warnings.some((warning) => warning.includes('default value "admin"')));
      assert.ok(config.warnings.some((warning) => warning.includes('shared default value')));
    });

    it('treats blank password and session-secret values as unset', () => {
      const config = loadConfig(
        validEnv({ PALSENTRY_LOGIN_PASSWORD: '', PALSENTRY_SESSION_SECRET: '' }),
      );
      assert.equal(verifyPassword('admin', config.auth.passwordHash), true);
      assert.equal(
        config.auth.sessionSecret,
        'bb5930c05402c03f897c0cdd0e98bb8420a8359f7dbab25fe53df1a5c060d5ea',
      );
    });

    it('hashes a plaintext password and flags it as plaintext', () => {
      const config = loadConfig(validEnv());
      assert.equal(config.auth.passwordIsPlaintext, true);
      assert.match(config.auth.passwordHash, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
      // The plaintext must not survive into the config object.
      assert.ok(!config.auth.passwordHash.includes('palsentry-admin-password'));
    });

    it('accepts a pre-computed hash and prefers it over a plaintext password', () => {
      const hash = `scrypt$${'ab'.repeat(16)}$${'cd'.repeat(64)}`;
      const config = loadConfig(
        validEnv({
          PALSENTRY_LOGIN_PASSWORD: 'ignored-plaintext',
          PALSENTRY_LOGIN_PASSWORD_HASH: hash,
        }),
      );
      assert.equal(config.auth.passwordHash, hash);
      assert.equal(config.auth.passwordIsPlaintext, false);
      assert.ok(
        config.warnings.some((w) => w.includes('Both PALSENTRY_LOGIN_PASSWORD and')),
        'warns that both credentials were supplied',
      );
    });

    it('rejects a malformed hash with a helpful message', () => {
      assertConfigError(
        validEnv({
          PALSENTRY_LOGIN_PASSWORD: undefined,
          PALSENTRY_LOGIN_PASSWORD_HASH: 'bcrypt$nope',
        }),
        'malformed',
      );
    });

    it('rejects a session secret shorter than 32 characters', () => {
      assertConfigError(validEnv({ PALSENTRY_SESSION_SECRET: 'short' }), 'at least 32 characters');
    });

    it('warns when the password has surrounding whitespace', () => {
      const config = loadConfig(validEnv({ PALSENTRY_LOGIN_PASSWORD: ' spaced ' }));
      assert.ok(config.warnings.some((w) => w.includes('leading or trailing whitespace')));
    });
  });

  describe('booleans', () => {
    const truthy = ['true', 'TRUE', '1', 'yes', 'on', 'On'];
    const falsy = ['false', 'FALSE', '0', 'no', 'off'];

    for (const value of truthy) {
      it(`accepts "${value}" as true`, () => {
        const config = loadConfig(validEnv({ PALSENTRY_ALLOW_DESTRUCTIVE: value }));
        assert.equal(config.allowDestructive, true);
      });
    }

    for (const value of falsy) {
      it(`accepts "${value}" as false`, () => {
        const config = loadConfig(validEnv({ PALSENTRY_ALLOW_DESTRUCTIVE: value }));
        assert.equal(config.allowDestructive, false);
      });
    }

    it('treats an empty value as unset', () => {
      const config = loadConfig(validEnv({ PALSENTRY_ALLOW_DESTRUCTIVE: '' }));
      assert.equal(config.allowDestructive, true);
    });

    it('rejects a non-boolean value', () => {
      assertConfigError(validEnv({ PALSENTRY_ALLOW_DESTRUCTIVE: 'maybe' }), 'must be a boolean');
    });

    it('warns when destructive actions are enabled', () => {
      const config = loadConfig(validEnv({ PALSENTRY_ALLOW_DESTRUCTIVE: 'true' }));
      assert.ok(config.warnings.some((w) => w.includes('PALSENTRY_ALLOW_DESTRUCTIVE=true')));
    });
  });

  describe('integers', () => {
    it('parses valid numbers', () => {
      const config = loadConfig(
        validEnv({
          PALSENTRY_PORT: '8080',
          PALSENTRY_SESSION_TTL_HOURS: '48',
          PALSENTRY_HISTORY_RETENTION_DAYS: '7',
          PALSENTRY_SAMPLE_INTERVAL_SECONDS: '15',
          PALSENTRY_WAYBACK_INTERVAL_SECONDS: '30',
        }),
      );
      assert.equal(config.port, 8080);
      assert.equal(config.auth.sessionTtlHours, 48);
      assert.equal(config.history.retentionDays, 7);
      assert.equal(config.history.sampleIntervalSeconds, 15);
      assert.equal(config.history.waybackIntervalSeconds, 30);
    });

    it('rejects a non-integer', () => {
      assertConfigError(validEnv({ PALSENTRY_PORT: 'abc' }), 'must be an integer');
      assertConfigError(validEnv({ PALSENTRY_PORT: '30.5' }), 'must be an integer');
    });

    it('rejects out-of-range values', () => {
      assertConfigError(validEnv({ PALSENTRY_PORT: '99999' }), 'must be between');
      assertConfigError(validEnv({ PALSENTRY_SAMPLE_INTERVAL_SECONDS: '1' }), 'must be between');
      assertConfigError(
        validEnv({ PALSENTRY_WAYBACK_INTERVAL_SECONDS: '1' }),
        'PALSENTRY_WAYBACK_INTERVAL_SECONDS',
      );
      assertConfigError(
        validEnv({ PALSENTRY_WAYBACK_INTERVAL_SECONDS: '7200' }),
        'must be between 5 and 3600',
      );
    });
  });

  describe('logging', () => {
    it('rejects an unknown log level', () => {
      assertConfigError(validEnv({ LOG_LEVEL: 'verbose' }), 'must be one of');
    });

    it('accepts known log levels', () => {
      assert.equal(loadConfig(validEnv({ LOG_LEVEL: 'debug' })).logLevel, 'debug');
    });

    it('disables pretty logging in production', () => {
      assert.equal(loadConfig(validEnv({ NODE_ENV: 'production' })).logPretty, false);
      assert.equal(loadConfig(validEnv({ NODE_ENV: 'development' })).logPretty, true);
    });
  });

  describe('map configuration', () => {
    it('defaults to both bundled textures and the modern projection', () => {
      const config = loadConfig(validEnv());
      assert.equal(config.map.projection, DEFAULT_MAP_PROJECTION);
      assert.equal(config.map.layers.palpagos.textureUrl, DEFAULT_MAP_TEXTURE_URL);
      assert.equal(config.map.layers.worldTree.textureUrl, DEFAULT_WORLD_TREE_TEXTURE_URL);
      assert.equal(
        config.warnings.some((w) => w.includes('MAP')),
        false,
        'the out-of-the-box map needs no warning',
      );
    });

    it('falls back to interactive grids for both regions when projection is "none"', () => {
      const config = loadConfig(validEnv({ PALSENTRY_MAP_PROJECTION: 'none' }));
      assert.equal(config.map.projection, 'none');
      assert.equal(config.map.layers.palpagos.textureUrl, null);
      assert.equal(config.map.layers.worldTree.textureUrl, null);
    });

    it('prefers explicit texture URLs over both bundled defaults', () => {
      const config = loadConfig(
        validEnv({
          PALSENTRY_MAP_TEXTURE_URL: '/map/world.png',
          PALSENTRY_WORLD_TREE_TEXTURE_URL: '/map/tree.png',
        }),
      );
      assert.equal(config.map.layers.palpagos.textureUrl, '/map/world.png');
      assert.equal(config.map.layers.worldTree.textureUrl, '/map/tree.png');
      assert.equal(config.map.projection, DEFAULT_MAP_PROJECTION);
      assert.equal(
        config.warnings.some((w) => w.includes('MAP')),
        false,
        'custom textures need no warning',
      );
    });

    it('accepts custom textures with the legacy Palpagos projection', () => {
      const config = loadConfig(
        validEnv({
          PALSENTRY_MAP_TEXTURE_URL: '/map/world.png',
          PALSENTRY_WORLD_TREE_TEXTURE_URL: '/map/tree.png',
          PALSENTRY_MAP_PROJECTION: 'legacy',
        }),
      );
      assert.equal(config.map.layers.palpagos.textureUrl, '/map/world.png');
      assert.equal(config.map.layers.worldTree.textureUrl, '/map/tree.png');
      assert.equal(config.map.projection, 'legacy');
      assert.equal(
        config.warnings.some((w) => w.includes('MAP')),
        false,
        'no map warnings when configured consistently',
      );
    });

    it('warns when either texture is set but projection turns maps off', () => {
      for (const override of [
        { PALSENTRY_MAP_TEXTURE_URL: '/map/world.png' },
        { PALSENTRY_WORLD_TREE_TEXTURE_URL: '/map/tree.png' },
      ]) {
        const config = loadConfig(validEnv({ ...override, PALSENTRY_MAP_PROJECTION: 'none' }));
        assert.equal(config.map.layers.palpagos.textureUrl, null);
        assert.equal(config.map.layers.worldTree.textureUrl, null);
        assert.ok(config.warnings.some((w) => w.includes('PALSENTRY_MAP_PROJECTION is "none"')));
      }
    });

    it('rejects an unknown projection', () => {
      assertConfigError(validEnv({ PALSENTRY_MAP_PROJECTION: 'treemap' }), 'must be one of');
    });
  });

  describe('error output hygiene', () => {
    it('never echoes secret values in a validation message', () => {
      // Force a failure on a *different* field while a secret is present.
      try {
        loadConfig(
          validEnv({ PALSENTRY_PORT: 'nope', PALSENTRY_LOGIN_PASSWORD: 'super-secret-value' }),
        );
        assert.fail('expected loadConfig to throw');
      } catch (error) {
        assert.ok(error instanceof ConfigError);
        assert.ok(
          !error.message.includes('super-secret-value'),
          'secret value leaked into the error message',
        );
        assert.ok(!error.message.includes('palworld-admin-password'), 'Palworld password leaked');
      }
    });
  });

  describe('web dist candidates', () => {
    it('includes an explicit override first when provided', () => {
      const config = loadConfig(validEnv({ PALSENTRY_WEB_DIST: '/custom/static' }));
      assert.equal(config.webDistCandidates[0], '/custom/static');
    });

    it('provides fallbacks when no override is given', () => {
      const config = loadConfig(validEnv());
      assert.ok(config.webDistCandidates.length >= 1);
      assert.ok(config.webDistCandidates.some((p) => p.endsWith('public')));
    });
  });

  describe('desktop hosting', () => {
    /** Desktop mode with nothing else set: the connection screen has not been filled in yet. */
    const desktopEnv = (overrides: Record<string, string | undefined> = {}) =>
      validEnv({
        PALWORLD_REST_URL: undefined,
        PALWORLD_ADMIN_PASSWORD: undefined,
        PALSENTRY_DESKTOP: '1',
        ...overrides,
      });

    it('is off by default and reports an unconfigured, credential-less desktop state', () => {
      const config = loadConfig(validEnv());
      assert.equal(config.desktop.enabled, false);
      assert.equal(config.desktop.configured, true);
      assert.equal(config.desktop.configPath, null);
    });

    it('starts without any Palworld credentials and waits for the connection screen', () => {
      const config = loadConfig(desktopEnv());
      assert.equal(config.desktop.enabled, true);
      assert.equal(config.desktop.configured, false);
      // Nothing listens on the reserved loopback port, so upstream calls fail fast instead of
      // hanging while the user has not connected yet.
      assert.equal(config.palworld.apiBaseUrl, 'http://127.0.0.1:1/v1/api');
      assert.equal(config.palworld.password, '');
    });

    it('prefills a saved REST URL without treating it as configured', () => {
      const config = loadConfig(desktopEnv({ PALWORLD_REST_URL: 'http://10.0.0.9:8212/' }));
      assert.equal(config.desktop.configured, false);
      assert.equal(config.palworld.apiBaseUrl, 'http://10.0.0.9:8212/v1/api');
    });

    it('is configured when the shell supplies both values', () => {
      const config = loadConfig(
        desktopEnv({ PALWORLD_REST_URL: 'http://10.0.0.9:8212', PALWORLD_ADMIN_PASSWORD: 'pw' }),
      );
      assert.equal(config.desktop.configured, true);
      assert.equal(config.palworld.password, 'pw');
    });

    it('resolves the shell-owned config path', () => {
      const config = loadConfig(
        desktopEnv({ PALSENTRY_DESKTOP_CONFIG: '/tmp/palsentry/desktop.json' }),
      );
      assert.equal(config.desktop.configPath, '/tmp/palsentry/desktop.json');
    });

    it('accepts port 0 so the shell can ask the OS for a free port', () => {
      const config = loadConfig(desktopEnv({ PALSENTRY_PORT: '0' }));
      assert.equal(config.port, 0);
    });

    it('drops warnings about public exposure that a loopback-only app cannot act on', () => {
      const config = loadConfig(
        desktopEnv({
          PALSENTRY_LOGIN_PASSWORD: undefined,
          PALSENTRY_SESSION_SECRET: undefined,
          PALSENTRY_ALLOW_DESTRUCTIVE: 'true',
          NODE_ENV: 'production',
        }),
      );

      assert.ok(config.allowDestructive);
      assert.deepEqual(config.warnings, []);
    });

    it('still requires credentials when the desktop flag is absent', () => {
      assertConfigError(
        validEnv({ PALWORLD_ADMIN_PASSWORD: undefined }),
        'PALWORLD_ADMIN_PASSWORD is required',
      );
      assertConfigError(
        validEnv({ PALWORLD_REST_URL: undefined }),
        'PALWORLD_REST_URL is required',
      );
    });
  });
});
