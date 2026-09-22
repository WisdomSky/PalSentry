#!/usr/bin/env node
/**
 * Generate a `PALSENTRY_LOGIN_PASSWORD_HASH` for your .env.
 *
 * Usage:
 *   npm run hash-password -- "my-password"
 *   npm run hash-password                 # prompts for the password
 *   echo -n "my-password" | npm run hash-password   # non-interactive
 *
 * Storing the hash instead of the plaintext keeps the actual password off disk.
 */
import { randomBytes, scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

const SALT_BYTES = 16;
const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/** Read piped stdin without printing anything. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

async function resolvePassword() {
  const fromArgv = process.argv[2];
  if (fromArgv !== undefined) return { password: fromArgv, source: 'argument' };

  if (!process.stdin.isTTY) {
    return { password: await readStdin(), source: 'stdin' };
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Password to hash: ');
    return { password: answer, source: 'prompt' };
  } finally {
    rl.close();
  }
}

const { password, source } = await resolvePassword();

if (!password) {
  console.error('\nNo password provided. Nothing to do.\n');
  process.exit(1);
}

if (source === 'argument') {
  console.error(
    '\nNote: passing the password as an argument may leave it in your shell history.\n' +
      'Run the command with no argument to be prompted instead.\n',
  );
}

console.log(`\nAdd this line to your .env:\n`);
// Single quotes are important: Docker Compose otherwise treats `$salt` / `$hash` as variable
// interpolation when the generated line is pasted into .env.
console.log(`PALSENTRY_LOGIN_PASSWORD_HASH='${hashPassword(password)}'\n`);
console.log('Then remove PALSENTRY_LOGIN_PASSWORD so the plaintext password is not kept on disk.\n');
