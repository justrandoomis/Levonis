import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toAsciiDigits,
  publicAuthChallengeState,
  cooldownRemaining,
  OTP_RESEND_COOLDOWN_SECONDS,
  TG_AUTH_PURPOSES,
} from '../worker/lib/telegram';
import { normalizePhone } from '../worker/lib/phone';

// ------------------------------------------------------- digit mapping

test('toAsciiDigits maps Arabic-Indic digits to ASCII', () => {
  assert.equal(toAsciiDigits('٠١٢٣٤٥٦٧٨٩'), '0123456789');
});

test('toAsciiDigits maps Eastern Arabic-Indic (Farsi) digits to ASCII', () => {
  assert.equal(toAsciiDigits('۰۱۲۳۴۵۶۷۸۹'), '0123456789');
});

test('toAsciiDigits leaves ASCII digits and other characters untouched', () => {
  assert.equal(toAsciiDigits('07701234567'), '07701234567');
  assert.equal(toAsciiDigits('+964 770-123 4567'), '+964 770-123 4567');
  assert.equal(toAsciiDigits('abc ٥x۵y5'), 'abc 5x5y5');
  assert.equal(toAsciiDigits(''), '');
});

test('Arabic-digit Iraqi mobile normalizes to E.164 through toAsciiDigits + normalizePhone', () => {
  assert.equal(normalizePhone(toAsciiDigits('٠٧٧٠١٢٣٤٥٦٧')), '+9647701234567');
  assert.equal(normalizePhone(toAsciiDigits('۰۷۷۰۱۲۳۴۵۶۷')), '+9647701234567');
  // Mixed scripts within one number still normalize.
  assert.equal(normalizePhone(toAsciiDigits('٠٧70123456٧')), '+9647701234567');
  // A valid ASCII number is not altered by the mapping.
  assert.equal(normalizePhone(toAsciiDigits('+9647701234567')), '+9647701234567');
});

test('garbage stays invalid after digit mapping (no false acceptance)', () => {
  assert.equal(normalizePhone(toAsciiDigits('٧٧٧')), null);
  assert.equal(normalizePhone(toAsciiDigits('abc')), null);
});

// -------------------------------------------------- purposes are distinct

test('auth purposes are exactly signup and login (a link/reset code can never authorize auth)', () => {
  assert.deepEqual([...TG_AUTH_PURPOSES], ['signup', 'login']);
});

// --------------------------------------------- public challenge state map

const NOW = Date.parse('2026-08-28T12:00:00.000Z');
const FUTURE = '2026-08-28T12:10:00.000Z';
const PAST = '2026-08-28T11:59:00.000Z';

function row(overrides: Partial<Parameters<typeof publicAuthChallengeState>[0]> = {}) {
  return {
    state: 'pending',
    expires_at: FUTURE,
    consumed_at: null,
    otp_sent_at: null,
    ...overrides,
  };
}

test('pending and contact_received pass through', () => {
  assert.equal(publicAuthChallengeState(row(), NOW), 'pending');
  assert.equal(publicAuthChallengeState(row({ state: 'contact_received' }), NOW), 'contact_received');
});

test('phone_verified without a dispatched code stays transient (phone_verified)', () => {
  assert.equal(publicAuthChallengeState(row({ state: 'phone_verified' }), NOW), 'phone_verified');
});

test('phone_verified with otp_sent_at reports otp_sent', () => {
  assert.equal(
    publicAuthChallengeState(row({ state: 'phone_verified', otp_sent_at: '2026-08-28T11:59:30.000Z' }), NOW),
    'otp_sent'
  );
});

test('a linked (completed) challenge reports completed even though consumed', () => {
  assert.equal(
    publicAuthChallengeState(row({ state: 'linked', consumed_at: '2026-08-28T11:59:59.000Z' }), NOW),
    'completed'
  );
});

test('expiry wins over every non-linked state', () => {
  assert.equal(publicAuthChallengeState(row({ expires_at: PAST }), NOW), 'expired');
  assert.equal(publicAuthChallengeState(row({ state: 'phone_verified', expires_at: PAST }), NOW), 'expired');
  assert.equal(
    publicAuthChallengeState(row({ state: 'phone_verified', otp_sent_at: PAST, expires_at: PAST }), NOW),
    'expired'
  );
});

test('a consumed-but-not-linked challenge is expired (single use, never revivable)', () => {
  assert.equal(publicAuthChallengeState(row({ consumed_at: PAST }), NOW), 'expired');
});

test('explicitly expired/revoked states report expired', () => {
  assert.equal(publicAuthChallengeState(row({ state: 'expired' }), NOW), 'expired');
  assert.equal(publicAuthChallengeState(row({ state: 'revoked' }), NOW), 'expired');
});

// ----------------------------------------------------- resend cooldown

test('cooldownRemaining counts down from the dispatch time', () => {
  const sentAt = new Date(NOW - 10_000).toISOString(); // 10s ago
  assert.equal(cooldownRemaining(sentAt, NOW), OTP_RESEND_COOLDOWN_SECONDS - 10);
});

test('cooldownRemaining is 0 once the cooldown has passed', () => {
  const sentAt = new Date(NOW - (OTP_RESEND_COOLDOWN_SECONDS + 5) * 1000).toISOString();
  assert.equal(cooldownRemaining(sentAt, NOW), 0);
});

test('cooldownRemaining handles null and malformed timestamps as 0 (no stuck buttons)', () => {
  assert.equal(cooldownRemaining(null, NOW), 0);
  assert.equal(cooldownRemaining('not-a-date', NOW), 0);
});

test('cooldownRemaining never exceeds the configured cooldown (clock skew safety)', () => {
  const sentAt = new Date(NOW + 3_600_000).toISOString(); // "sent" an hour in the future
  assert.equal(cooldownRemaining(sentAt, NOW), OTP_RESEND_COOLDOWN_SECONDS);
});
