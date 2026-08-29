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
 *    deterministically.
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLoginIdentifier, referrerLookupCandidates } from '../worker/routes/auth';
import { normalizePhone, toAsciiDigits } from '../worker/lib/phone';

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
