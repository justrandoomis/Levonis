/**
 * "Iraqi mobile only" is gone. This is what replaced it.
 *
 * The old rule was two rules wearing one coat: a real structural check for
 * Iraq (`+964` had to be `7XXXXXXXXX`) and, for every other country, "a plus
 * and 8–15 digits" — a length check that called itself validation. It let
 * `+971000000000` through as a UAE number and rejected valid numbers whose
 * national format is shorter than eight digits.
 *
 * Now every country's actual numbering plan decides, via libphonenumber's
 * metadata. The tests below are grouped by the question each one answers,
 * because "does this phone number validate" has more interesting answers
 * than true and false.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePhone,
  countryOfPhone,
  phonesMatch,
  maskPhone,
  toAsciiDigits,
  allCountries,
  DEFAULT_COUNTRY,
} from '../worker/lib/phone';

// ------------------------------------------------- the countries that matter

test('real numbers from four continents all normalize to E.164', () => {
  const cases: [string, string][] = [
    ['+9647701234567', '+9647701234567'], // Iraq  — the home market
    ['+971501234567', '+971501234567'],   // UAE
    ['+12025550123', '+12025550123'],     // United States
    ['+447400123456', '+447400123456'],   // United Kingdom
    ['+905321234567', '+905321234567'],   // Türkiye
    ['+4915112345678', '+4915112345678'], // Germany
    ['+46701234567', '+46701234567'],     // Sweden
    ['+201001234567', '+201001234567'],   // Egypt
  ];
  for (const [input, expected] of cases) {
    assert.equal(normalizePhone(input), expected, input);
  }
});

test('a shared calling code makes the COUNTRY best-effort, and that is stated', () => {
  // +44 is not the UK's alone — Guernsey, Jersey and the Isle of Man share
  // it, and some ranges cannot be told apart at all. `+447911123456` reads as
  // GG, not GB. The number is still valid and still stored correctly; only
  // the country label is a guess. Nothing security-relevant may depend on it,
  // which is why the identity key is the E.164 number and never the country.
  assert.equal(normalizePhone('+447911123456'), '+447911123456');
  assert.equal(countryOfPhone('+447911123456'), 'GG');
});

test('the country is read back out of the stored number', () => {
  assert.equal(countryOfPhone('+9647701234567'), 'IQ');
  assert.equal(countryOfPhone('+971501234567'), 'AE');
  assert.equal(countryOfPhone('+447400123456'), 'GB');
  assert.equal(countryOfPhone('+12025550123'), 'US');
});

// -------------------------------------------- the shapes people actually type

test('an Iraqi customer typing their number the local way still works', () => {
  for (const raw of ['07701234567', '7701234567', '0770 123 4567', '(0770) 123-4567']) {
    assert.equal(normalizePhone(raw), '+9647701234567', raw);
  }
});

test('Arabic-Indic and Eastern Arabic-Indic digits are the same number', () => {
  assert.equal(normalizePhone('٠٧٧٠١٢٣٤٥٦٧'), '+9647701234567');
  assert.equal(normalizePhone('۰۷۷۰۱۲۳۴۵۶۷'), '+9647701234567');
  assert.equal(toAsciiDigits('٠٧٧٠'), '0770');
});

test('the 00 international prefix is the same as +', () => {
  assert.equal(normalizePhone('009647701234567'), '+9647701234567');
  assert.equal(normalizePhone('00971501234567'), '+971501234567');
});

test('a Telegram contact arrives WITHOUT a plus and must still be read', () => {
  // This is not a hypothetical: `contact.phone_number` from the Bot API has
  // no '+'. If this branch broke, every Telegram sign-in would break with it.
  assert.equal(normalizePhone('9647701234567'), '+9647701234567');
  assert.equal(normalizePhone('971501234567'), '+971501234567');
  assert.equal(normalizePhone('12025550123'), '+12025550123');
  assert.equal(normalizePhone('447400123456'), '+447400123456');
});

test('a bare local number is read in the default country, not guessed at', () => {
  // Same digits, two countries, two different real numbers.
  assert.equal(normalizePhone('07701234567', 'IQ'), '+9647701234567');
  assert.equal(normalizePhone('05012345678', 'TR'), '+905012345678');
  assert.equal(DEFAULT_COUNTRY, 'IQ');
});

test('an unknown default country falls back to Iraq rather than throwing', () => {
  assert.equal(normalizePhone('07701234567', 'ZZ'), '+9647701234567');
  assert.equal(normalizePhone('07701234567', ''), '+9647701234567');
});

// ------------------------------------------------------ what must be refused

test('length is no longer enough — the number has to exist', () => {
  // THE OLD BUG, stated as a test. Eleven digits after +971 passed the old
  // "8–15 digits" check. It is not a UAE number.
  assert.equal(normalizePhone('+971000000000'), null);
  assert.equal(normalizePhone('+11111111111'), null);
  assert.equal(normalizePhone('+9999999999999'), null);
});

test('garbage, fragments and letters are never phone numbers', () => {
  for (const raw of ['', '   ', 'abc', '+964', '777', '0770123', '+', '++9647701234567', 'user@example.com']) {
    assert.equal(normalizePhone(raw), null, JSON.stringify(raw));
  }
});

test('an over-long string of digits is refused rather than truncated', () => {
  assert.equal(normalizePhone('+964770123456789012345'), null);
  assert.equal(normalizePhone('123456789012345678'), null);
});

// ------------------------------------------------------------- one identity

test('every way of writing one number compares equal', () => {
  const forms = ['07701234567', '+9647701234567', '009647701234567', '9647701234567', '٠٧٧٠١٢٣٤٥٦٧'];
  for (const a of forms) {
    for (const b of forms) {
      assert.equal(phonesMatch(a, b), true, `${a} vs ${b}`);
    }
  }
});

test('two different numbers never compare equal, however similar', () => {
  assert.equal(phonesMatch('+9647701234567', '+9647701234568'), false);
  // No suffix matching: a shared tail is not a shared identity.
  assert.equal(phonesMatch('+9647701234567', '+971701234567'), false);
  assert.equal(phonesMatch('nonsense', '+9647701234567'), false);
});

// -------------------------------------------------------------- the display

test('a masked number shows the country and the last three digits, nothing else', () => {
  assert.equal(maskPhone('+9647701234567'), '+9647******567');
  assert.equal(maskPhone('+12025550123'), '+1202****123');
  assert.equal(maskPhone('+964'), '***');
});

// ------------------------------------------------------- the country picker

test('the country list covers the world and carries dial codes', () => {
  const all = allCountries();
  assert.ok(all.length > 200, `only ${all.length} countries`);
  const byIso = new Map(all.map((c) => [c.iso, c.dial]));
  assert.equal(byIso.get('IQ'), '964');
  assert.equal(byIso.get('AE'), '971');
  assert.equal(byIso.get('US'), '1');
  assert.equal(byIso.get('GB'), '44');
  // Every entry is a usable pair — a blank dial code would render as "+".
  for (const c of all) {
    assert.match(c.iso, /^[A-Z]{2}$/);
    assert.match(c.dial, /^\d{1,4}$/);
  }
});

test('country names are localized by the platform, not by a hand-written table', () => {
  // Three languages, no translation file to drift. `ckb` is supported by ICU,
  // which is why the picker can be Kurdish without anyone typing 245 names.
  for (const lang of ['en', 'ar', 'ckb']) {
    const dn = new Intl.DisplayNames([lang], { type: 'region' });
    const name = dn.of('IQ');
    assert.equal(typeof name, 'string');
    assert.ok((name as string).length > 1, `${lang} produced no name for IQ`);
    assert.notEqual(name, 'IQ', `${lang} fell back to the raw code`);
  }
});
