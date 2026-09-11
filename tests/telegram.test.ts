import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateOtpCode } from '../worker/lib/telegram';
import { randomToken, sha256Hex } from '../worker/lib/crypto';

test('OTP codes are always exactly 6 digits (leading zeros kept)', () => {
  for (let i = 0; i < 500; i++) {
    const code = generateOtpCode();
    assert.match(code, /^\d{6}$/);
  }
});

test('deep-link nonce fits Telegram start payload limit (64 chars, base64url charset)', () => {
  const nonce = randomToken(32); // 32 bytes → 43 base64url chars
  assert.equal(nonce.length, 43);
  assert.ok(nonce.length <= 64);
  assert.match(nonce, /^[A-Za-z0-9_-]+$/);
});

test('challenge id is the SHA-256 digest of the nonce (raw nonce never stored)', async () => {
  const nonce = randomToken(32);
  const id = await sha256Hex(nonce);
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.notEqual(id, nonce);
});
