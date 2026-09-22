import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing with `scrypt` from `node:crypto`.
 *
 * Deliberately no bcrypt/argon2 native dependency: `node:crypto` gives a memory-hard KDF with
 * zero build steps, which keeps the Docker image simple and avoids another native module
 * alongside better-sqlite3.
 *
 * Stored format: `scrypt$<saltHex>$<derivedKeyHex>`
 */

const SALT_BYTES = 16;
const KEY_LENGTH = 64;

/** Minimum accepted sizes when parsing a stored hash. Anything shorter is a truncated or
 * hand-written value and must not be treated as a working credential. */
const MIN_SALT_BYTES = 16;
const MIN_DERIVED_BYTES = 32;

const HEX_PATTERN = /^[0-9a-f]+$/i;

/** N=16384, r=8, p=1 is the Node default cost profile; maxmem is raised to fit it comfortably. */
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export const PASSWORD_HASH_PREFIX = 'scrypt$';

/** Derive a storable hash for a plaintext password. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);
  return `${PASSWORD_HASH_PREFIX}${salt.toString('hex')}$${derived.toString('hex')}`;
}

export interface ParsedPasswordHash {
  salt: Buffer;
  derived: Buffer;
}

/** Parse a stored hash, returning null when it is malformed or truncated. */
export function parsePasswordHash(hash: string): ParsedPasswordHash | null {
  // Defensive: a missing/None hash must read as "does not match", never as a thrown error.
  if (typeof hash !== 'string') return null;

  const parts = hash.split('$');
  if (parts.length !== 3) return null;
  const [prefix, saltHex, derivedHex] = parts;
  if (prefix !== 'scrypt' || !saltHex || !derivedHex) return null;

  if (!HEX_PATTERN.test(saltHex) || !HEX_PATTERN.test(derivedHex)) return null;
  // Odd-length hex is not byte-aligned and would be silently truncated by Buffer.from.
  if (saltHex.length % 2 !== 0 || derivedHex.length % 2 !== 0) return null;

  const salt = Buffer.from(saltHex, 'hex');
  const derived = Buffer.from(derivedHex, 'hex');

  if (salt.length < MIN_SALT_BYTES || derived.length < MIN_DERIVED_BYTES) return null;

  return { salt, derived };
}

/**
 * Verify a password against a stored `scrypt` hash in constant time.
 *
 * Returns false for malformed hashes instead of throwing, so a typo in `.env` shows up as
 * "invalid credentials" rather than a 500.
 */
export function verifyPassword(password: string, hash: string): boolean {
  if (typeof password !== 'string') return false;
  const parsed = parsePasswordHash(hash);
  if (!parsed) return false;

  const candidate = scryptSync(password, parsed.salt, parsed.derived.length, SCRYPT_OPTIONS);
  if (candidate.length !== parsed.derived.length) return false;
  return timingSafeEqual(candidate, parsed.derived);
}

/**
 * Compare two strings in constant time.
 *
 * Both inputs are hashed to a fixed 32 bytes first, because `timingSafeEqual` throws on
 * length mismatch and returning early on length would leak the expected length.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * A well-formed but unusable hash, used to burn the same CPU time when the submitted username
 * does not exist. Without this, a missing user would return noticeably faster than a wrong
 * password and reveal which usernames are valid.
 */
export const DUMMY_PASSWORD_HASH = `${PASSWORD_HASH_PREFIX}${'00'.repeat(SALT_BYTES)}$${'00'.repeat(KEY_LENGTH)}`;

export interface ExpectedCredentials {
  username: string;
  /** Always a well-formed hash — `config.ts` guarantees this at startup. */
  passwordHash: string;
}

/**
 * Check submitted credentials in constant time.
 *
 * Both comparisons are always evaluated (never short-circuited) and no branch skips the
 * expensive scrypt call, so a valid username with a wrong password and an unknown username cost
 * the same. Otherwise response timing would allow enumerating valid usernames.
 */
export function verifyCredentials(
  expected: ExpectedCredentials,
  submittedUsername: string,
  submittedPassword: string,
): boolean {
  const usernameMatches = timingSafeEqualString(submittedUsername, expected.username);
  const passwordMatches = verifyPassword(submittedPassword, expected.passwordHash);
  return usernameMatches && passwordMatches;
}
