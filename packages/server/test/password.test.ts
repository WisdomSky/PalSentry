import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  parsePasswordHash,
  timingSafeEqualString,
  verifyPassword,
} from '../src/auth/password.js';

describe('password hashing', () => {
  it('produces a scrypt-prefixed hash with salt and derived key', () => {
    const hash = hashPassword('correct horse battery staple');
    const parts = hash.split('$');
    assert.equal(parts.length, 3);
    assert.equal(parts[0], 'scrypt');
    assert.equal(parts[1]?.length, 32, 'salt is 16 bytes of hex');
    assert.equal(parts[2]?.length, 128, 'derived key is 64 bytes of hex');
  });

  it('uses a fresh salt each time so identical passwords hash differently', () => {
    assert.notEqual(hashPassword('same'), hashPassword('same'));
  });

  it('verifies the correct password', () => {
    const hash = hashPassword('s3cret-pw');
    assert.equal(verifyPassword('s3cret-pw', hash), true);
  });

  it('rejects the wrong password', () => {
    const hash = hashPassword('s3cret-pw');
    assert.equal(verifyPassword('s3cret-pW', hash), false);
    assert.equal(verifyPassword('', hash), false);
    assert.equal(verifyPassword('s3cret-pw ', hash), false);
  });

  it('is case and whitespace sensitive', () => {
    const hash = hashPassword('Pass Word');
    assert.equal(verifyPassword('pass word', hash), false);
    assert.equal(verifyPassword('Pass  Word', hash), false);
    assert.equal(verifyPassword('Pass Word', hash), true);
  });

  it('verifies the dummy hash correctly so the timing-equalisation path is exercised', () => {
    // Reaching a real scrypt comparison is the point: a bogus *format* would short-circuit.
    assert.notEqual(parsePasswordHash(DUMMY_PASSWORD_HASH), null);
    assert.equal(verifyPassword('anything', DUMMY_PASSWORD_HASH), false);
  });

  describe('parsePasswordHash', () => {
    it('rejects malformed input rather than throwing', () => {
      const invalid = [
        '',
        'scrypt',
        'scrypt$',
        'scrypt$$',
        'bcrypt$aa$bb',
        'scrypt$aa$bb',
        'scrypt$zz$bb',
        'scrypt$aa$zz',
        'plaintext-password',
        'scrypt$0011$22',
      ];
      for (const value of invalid) {
        assert.equal(parsePasswordHash(value), null, `expected null for ${JSON.stringify(value)}`);
      }
    });

    it('round-trips a real hash', () => {
      const parsed = parsePasswordHash(hashPassword('round-trip'));
      assert.notEqual(parsed, null);
      assert.equal(parsed?.salt.length, 16);
      assert.equal(parsed?.derived.length, 64);
    });
  });

  describe('timingSafeEqualString', () => {
    it('compares equal and unequal strings', () => {
      assert.equal(timingSafeEqualString('admin', 'admin'), true);
      assert.equal(timingSafeEqualString('admin', 'adm1n'), false);
    });

    it('handles differing lengths without throwing', () => {
      // `crypto.timingSafeEqual` throws on length mismatch; hashing first avoids that.
      assert.equal(timingSafeEqualString('a', 'a'.repeat(500)), false);
      assert.equal(timingSafeEqualString('', ''), true);
      assert.equal(timingSafeEqualString('', 'x'), false);
    });

    it('handles multi-byte characters', () => {
      assert.equal(timingSafeEqualString('pässwörd', 'pässwörd'), true);
      assert.equal(timingSafeEqualString('pässwörd', 'password'), false);
    });
  });
});
