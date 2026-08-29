/**
 * Unit tests for the auth-server phone + username-referral helpers
 * (worker/routes/auth.ts + worker/lib/phone.ts) — integrated mandate §2.3
 * and §3.1/§3.2:
 *  - login identifier classification mirrors worker/lib/phone.ts exactly
 *    (single validity source, no length-only acceptance),
 *  - the +964 international form never carries the local leading zero and
 *    never accepts an arbitrary 10-digit string,
 *  - referral-ref lookup candidates put the username form (lowercase,
 *    CURRENT holder) before the legacy uppercase code alias,
 *    deterministically,
 *  - only a code/username is ever read from a signup body — an arbitrary
 *    referrer_user_id is ignored (§3.2),
 *  - the explicitly entered code wins over the one captured when an
 *    external (Telegram) sign-up flow started, and never silently falls
 *    back to it,
 *  - the dummy password record used to keep login failures uniform in
 *    latency can never authenticate anyone.
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyLoginIdentifier,
  referrerLookupCandidates,
  referralCodeFrom,
  pickSignupReferralSource,
  DUMMY_PASSWORD_HASH,
} from '../worker/routes/auth';
import { normalizePhone, toAsciiDigits } from '../worker/lib/phone';
import { verifyPassword } from '../worker/lib/crypto';

// ---------------------------------------------- login identifier: phones

test('valid Iraqi phone forms classify as the same E.164 phone', () => {
  for (const raw of ['07701234567', '7701234567', '+9647701234567', '009647701234567', '964 770 123 4567']) {
    assert.equal(classifyLoginIdentifier(raw).phone, '+9647701234567', raw);
  }
});

test('Arabic-Indic digits classify as a phone (٠٧٧٠١٢٣٤٥٦٧)', () => {
  const c = classifyLoginIdentifier('٠٧٧٠١٢٣٤٥٦٧');
  assert.equal(c.phone, '+9647701234567');
});

test('classification mirrors worker/lib/phone.ts exactly — no separate rule', () => {
  for (const raw of ['07701234567', '+9647701234567', 'someone@example.com', 'levonis_user', '+9641234567890']) {
    assert.equal(classifyLoginIdentifier(raw).phone, normalizePhone(toAsciiDigits(raw.trim())), raw);
  }
});

test('an email never classifies as a phone, even with many digits', () => {
  const c = classifyLoginIdentifier('User.77012345678@Example.com');
  assert.equal(c.phone, null);
  assert.equal(c.identifier, 'user.77012345678@example.com');
});

test('a username never classifies as a phone; identifier is lowercased', () => {
  const c = classifyLoginIdentifier('  Levonis_User ');
  assert.equal(c.phone, null);
  assert.equal(c.identifier, 'levonis_user');
});

test('NOT length-only: ten digits after +964 must start with mobile 7', () => {
  // 13 digits total, right length for an Iraqi mobile, wrong structure.
  assert.equal(classifyLoginIdentifier('+9641234567890').phone, null);
  assert.equal(classifyLoginIdentifier('+96412345678').phone, null);
});

test('the international form never carries the local leading zero (+9640…)', () => {
  assert.equal(classifyLoginIdentifier('+96407701234567').phone, null);
  assert.equal(classifyLoginIdentifier('009640770123456').phone, null);
});

test('too-short and garbage inputs never classify as phones', () => {
  for (const raw of ['777', 'abc', '+964', '0770123', '']) {
    assert.equal(classifyLoginIdentifier(raw).phone, null, raw);
  }
});

// ------------------------------------- referral ref lookup candidates §3.1

test('mixed-case ref tries the username form (lowercase) FIRST, then the legacy uppercase code', () => {
  assert.deepEqual(referrerLookupCandidates('Levo_Maker'), ['levo_maker', 'LEVO_MAKER']);
});

test('an already-lowercase username yields username-first order too', () => {
  assert.deepEqual(referrerLookupCandidates('levo_maker'), ['levo_maker', 'LEVO_MAKER']);
});

test('a digits-only ref yields a single candidate (no duplicate lookup)', () => {
  assert.deepEqual(referrerLookupCandidates('12345'), ['12345']);
});

test('refs are trimmed; empty, oversized and non-string refs yield no candidates', () => {
  assert.deepEqual(referrerLookupCandidates('  ok '), ['ok', 'OK']);
  assert.deepEqual(referrerLookupCandidates(''), []);
  assert.deepEqual(referrerLookupCandidates('   '), []);
  assert.deepEqual(referrerLookupCandidates('x'.repeat(65)), []);
  assert.deepEqual(referrerLookupCandidates(42), []);
  assert.deepEqual(referrerLookupCandidates(undefined), []);
  assert.deepEqual(referrerLookupCandidates(null), []);
});

test('candidate order is deterministic — the preview endpoint and signup attribution can never disagree', () => {
  // Same input, repeated calls, identical order (no set/randomized paths).
  const a = referrerLookupCandidates('MixedCase1');
  const b = referrerLookupCandidates('MixedCase1');
  assert.deepEqual(a, b);
  assert.deepEqual(a, ['mixedcase1', 'MIXEDCASE1']);
});

// ------------------------------- what a signup body may contribute (§3.2)

test('referralCode is read from the body; ref is accepted as an alias', () => {
  assert.equal(referralCodeFrom({ referralCode: 'levo_maker' }), 'levo_maker');
  assert.equal(referralCodeFrom({ ref: 'levo_maker' }), 'levo_maker');
  // referralCode wins when both are present (it is the explicit field).
  assert.equal(referralCodeFrom({ referralCode: 'chosen', ref: 'other' }), 'chosen');
  // An empty referralCode falls through to ref instead of masking it.
  assert.equal(referralCodeFrom({ referralCode: '   ', ref: 'fallback' }), 'fallback');
});

test('refs are trimmed and capped; non-strings and absence yield no code', () => {
  assert.equal(referralCodeFrom({ referralCode: '  spaced  ' }), 'spaced');
  assert.equal(referralCodeFrom({ referralCode: 'x'.repeat(200) }).length, 64);
  assert.equal(referralCodeFrom({}), '');
  assert.equal(referralCodeFrom({ referralCode: 12345 }), '');
  assert.equal(referralCodeFrom({ referralCode: null }), '');
});

test('an arbitrary referrer id in the body is NEVER read as a referral source', () => {
  // §3.2: the referrer is resolved server-side from a code/username only.
  assert.equal(referralCodeFrom({ referrer_user_id: 'usr_attacker' }), '');
  assert.equal(referralCodeFrom({ referrerId: 'usr_attacker', referrer_id: 'usr_attacker' }), '');
});

// ------------------ referral precedence across an external signup flow §3.2

test('an explicitly entered code wins over the referrer captured at flow start', () => {
  assert.deepEqual(pickSignupReferralSource('typed_code', 'usr_captured'), {
    kind: 'explicit',
    ref: 'typed_code',
  });
});

test('an explicit code is used ALONE — no silent fallback to the captured referrer', () => {
  // The user can see the code they typed; swapping in a hidden one would be
  // a silent substitution even if theirs turns out to be unknown.
  const picked = pickSignupReferralSource('  unknown_code  ', 'usr_captured');
  assert.deepEqual(picked, { kind: 'explicit', ref: 'unknown_code' });
});

test('without an explicit code the server-resolved referrer from flow start is used', () => {
  assert.deepEqual(pickSignupReferralSource('', 'usr_captured'), {
    kind: 'stored',
    referrerId: 'usr_captured',
  });
  assert.deepEqual(pickSignupReferralSource('   ', 'usr_captured'), {
    kind: 'stored',
    referrerId: 'usr_captured',
  });
});

test('no code and no captured referrer means no attribution at all', () => {
  assert.deepEqual(pickSignupReferralSource('', null), { kind: 'none' });
  assert.deepEqual(pickSignupReferralSource('', ''), { kind: 'none' });
});

// ------------------------------------ uniform login failure, uniform timing

test('the dummy password record can never authenticate anyone', async () => {
  for (const attempt of ['', 'password', 'A'.repeat(43), DUMMY_PASSWORD_HASH]) {
    assert.equal(await verifyPassword(attempt, DUMMY_PASSWORD_HASH), false, attempt.slice(0, 12));
  }
});

test('the dummy record is a real PBKDF2 record, so the work is actually done', () => {
  // Same shape hashPassword produces: pbkdf2$<iterations>$<salt>$<digest>.
  const parts = DUMMY_PASSWORD_HASH.split('$');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], 'pbkdf2');
  assert.ok(Number(parts[1]) >= 100_000);
  assert.ok(parts[2].length > 0 && parts[3].length > 0);
});
