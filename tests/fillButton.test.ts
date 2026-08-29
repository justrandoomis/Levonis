/**
 * Unit tests for the /auth UX helpers (integrated mandate §2.1/§2.2/§2.4):
 *
 *  - FillButton progress/readiness: readiness comes ONLY from real
 *    validation — never from text length alone, never from an animation —
 *    and it regresses the instant a character is deleted.
 *  - Email shape: no forced `.com`/`.ru`, no fixed TLD length.
 *  - PhoneField: Iraq +964 default, local/international/Arabic-digit paste
 *    normalization, no doubled dial code, no local trunk zero in E.164, and
 *    NO length-only acceptance — the client mirrors worker/lib/phone.ts.
 *  - OtpBoxes: six digits mean "ready to submit", never "verified".
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp01,
  isValidEmailAddress,
  emailFieldProgress,
  lengthProgress,
  combineFillProgress,
} from '../src/components/auth/FillButton';
import {
  toAsciiDigitsClient,
  normalizePhoneInput,
  buildPhoneValue,
  emptyPhoneValue,
  countryByIso,
  COUNTRIES,
} from '../src/components/auth/PhoneField';
import { normalizeOtp } from '../src/components/auth/OtpBoxes';
import { normalizePhone, toAsciiDigits } from '../worker/lib/phone';

// ------------------------------------------------------------- clamp01

test('clamp01 pins to [0,1] and treats non-finite input as 0', () => {
  assert.equal(clamp01(-3), 0);
  assert.equal(clamp01(0.42), 0.42);
  assert.equal(clamp01(7), 1);
  // Non-finite input can only come from a bug: it must read as "empty",
  // never as a full bar (an honest meter never over-reports).
  assert.equal(clamp01(Number.NaN), 0);
  assert.equal(clamp01(Number.POSITIVE_INFINITY), 0);
  assert.equal(clamp01(Number.NEGATIVE_INFINITY), 0);
});

// --------------------------------------------------------- email shape

test('email validity accepts real addresses without forcing a TLD (§2.2)', () => {
  for (const ok of [
    'user@example.com',
    'user@example.ru',
    'name+tag@sub.example.co.uk',
    'a.b-c_d@mail.levonis-iq.com',
    'user@example.iq',
  ]) {
    assert.equal(isValidEmailAddress(ok), true, ok);
  }
});

test('email validity rejects incomplete shapes', () => {
  for (const bad of [
    '',
    'user',
    'user@',
    '@example.com',
    'user@example',
    'user@example.',
    'user@exam ple.com',
    'a@b.c', // single-char TLD
    'two@at@example.com',
  ]) {
    assert.equal(isValidEmailAddress(bad), false, bad);
  }
});

test('email progress never reaches 100% while the address is invalid', () => {
  for (const partial of ['u', 'user', 'user@', 'user@exam', 'user@example.']) {
    const p = emailFieldProgress(partial);
    assert.ok(p < 1, `${partial} → ${p}`);
    assert.ok(p >= 0, partial);
  }
  assert.equal(emailFieldProgress('user@example.com'), 1);
  assert.equal(emailFieldProgress(''), 0);
});

test('email progress grows while typing and REGRESSES on deletion', () => {
  const typed = ['u', 'us', 'user', 'user@', 'user@e', 'user@example', 'user@example.c', 'user@example.com'];
  const values = typed.map(emailFieldProgress);
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i] >= values[i - 1], `${typed[i]} (${values[i]}) < ${typed[i - 1]} (${values[i - 1]})`);
  }
  // Deleting the last character of a valid address drops it back below 1.
  assert.equal(values[values.length - 1], 1);
  assert.ok(emailFieldProgress('user@example.co') < 1 || isValidEmailAddress('user@example.co'));
  assert.ok(emailFieldProgress('user@example.c') < 1);
});

// ------------------------------------------------------ length progress

test('lengthProgress is a visual meter only, capped at 1', () => {
  assert.equal(lengthProgress('', 8), 0);
  assert.equal(lengthProgress('1234', 8), 0.5);
  assert.equal(lengthProgress('12345678', 8), 1);
  assert.equal(lengthProgress('123456789012', 8), 1);
  // Any-script characters count — "8 محارف", not 8 English letters (§2.2).
  assert.equal(lengthProgress('كلمةسرية', 8), 1);
});

// -------------------------------------------------- combineFillProgress

test('readiness requires EVERY part to be really valid — length alone never counts', () => {
  // A field can look "full" (progress 1) and still be invalid: readiness
  // must follow `valid`, not the meter.
  const r = combineFillProgress([
    { progress: 1, valid: false },
    { progress: 1, valid: true },
  ]);
  assert.equal(r.ready, false);
  assert.ok(r.progress <= 0.96, String(r.progress));
});

test('all parts valid ⇒ ready and a full bar', () => {
  const r = combineFillProgress([
    { progress: 0.2, valid: true },
    { progress: 0.9, valid: true },
  ]);
  assert.deepEqual(r, { progress: 1, ready: true });
});

test('an invalid form can never show a 100% bar (honest meter)', () => {
  for (const parts of [
    [{ progress: 1, valid: false }],
    [
      { progress: 1, valid: true },
      { progress: 1, valid: true },
      { progress: 1, valid: false },
    ],
  ]) {
    const r = combineFillProgress(parts);
    assert.equal(r.ready, false);
    assert.ok(r.progress < 1, String(r.progress));
  }
});

test('no parts ⇒ never ready (an empty form is not a complete form)', () => {
  assert.deepEqual(combineFillProgress([]), { progress: 0, ready: false });
});

test('deleting a character regresses readiness immediately', () => {
  const partsFor = (pw: string) => [
    { progress: emailFieldProgress('user@example.com'), valid: isValidEmailAddress('user@example.com') },
    { progress: lengthProgress(pw, 8), valid: pw.length >= 8 },
  ];
  assert.equal(combineFillProgress(partsFor('12345678')).ready, true);
  const after = combineFillProgress(partsFor('1234567'));
  assert.equal(after.ready, false);
  assert.ok(after.progress < 1);
});

// --------------------------------------------------------- phone digits

test('Arabic-Indic and Eastern Arabic-Indic digits normalize to ASCII', () => {
  assert.equal(toAsciiDigitsClient('٠٧٧٠١٢٣٤٥٦٧'), '07701234567');
  assert.equal(toAsciiDigitsClient('۰۷۷۰۱۲۳۴۵۶۷'), '07701234567');
  assert.equal(toAsciiDigitsClient('+٩٦٤ ٧٧٠ ١٢٣ ٤٥٦٧'), '+964 770 123 4567');
  // Mirrors the server helper exactly (worker/lib/phone.ts).
  for (const raw of ['٠٧٧٠١٢٣٤٥٦٧', '۰۷۷۰۱۲۳۴۵۶۷', '+٩٦٤٧٧٠١٢٣٤٥٦٧', 'abc']) {
    assert.equal(toAsciiDigitsClient(raw), toAsciiDigits(raw), raw);
  }
});

test('Iraq is the default country (+964)', () => {
  const v = emptyPhoneValue();
  assert.equal(v.iso, 'IQ');
  assert.equal(v.dial, '964');
  assert.equal(v.valid, false);
  assert.equal(v.e164, null);
  assert.equal(COUNTRIES[0].iso, 'IQ');
  assert.equal(countryByIso('nope').iso, 'IQ');
});

test('pasting local / international / 00 / Arabic-digit forms all normalize to the same number', () => {
  for (const raw of [
    '07701234567',
    '7701234567',
    '+9647701234567',
    '009647701234567',
    '+964 770 123 4567',
    '0770-123-4567',
    '(0770) 123 4567',
    '٠٧٧٠١٢٣٤٥٦٧',
    '۰۷۷۰۱۲۳۴۵۶۷',
    '9647701234567',
  ]) {
    const { iso, national } = normalizePhoneInput(raw, 'IQ');
    assert.equal(iso, 'IQ', raw);
    assert.equal(national, '7701234567', raw);
    assert.equal(buildPhoneValue(iso, national).e164, '+9647701234567', raw);
  }
});

test('the country code is never doubled and the local trunk 0 never survives', () => {
  assert.equal(normalizePhoneInput('+96407701234567', 'IQ').national, '7701234567');
  assert.equal(normalizePhoneInput('00964 0770 123 4567', 'IQ').national, '7701234567');
  const v = buildPhoneValue('IQ', normalizePhoneInput('+9647701234567', 'IQ').national);
  assert.equal(v.e164, '+9647701234567');
  assert.ok(!v.e164!.startsWith('+9640'));
});

test('pasting another country dial code switches the selected country', () => {
  const tr = normalizePhoneInput('+90 532 123 4567', 'IQ');
  assert.equal(tr.iso, 'TR');
  assert.equal(tr.national, '5321234567');
  assert.equal(buildPhoneValue(tr.iso, tr.national).e164, '+905321234567');

  const uk = normalizePhoneInput('00447700900123', 'IQ');
  assert.equal(uk.iso, 'GB');
  assert.equal(buildPhoneValue(uk.iso, uk.national).e164, '+447700900123');
});

test('an arbitrary 10-digit string is NOT a valid Iraqi mobile (§2.3)', () => {
  for (const bad of ['1234567890', '0123456789', '9999999999', '6701234567']) {
    const { national } = normalizePhoneInput(bad, 'IQ');
    const v = buildPhoneValue('IQ', national);
    assert.equal(v.valid, false, bad);
    assert.equal(v.e164, null, bad);
  }
});

test('client Iraqi validity mirrors worker/lib/phone.ts (single rule, both sides)', () => {
  for (const raw of [
    '07701234567',
    '7701234567',
    '+9647701234567',
    '٠٧٧٠١٢٣٤٥٦٧',
    '1234567890',
    '770123456', // one digit short
    '77012345678', // one digit long
    '6701234567',
  ]) {
    const { iso, national } = normalizePhoneInput(raw, 'IQ');
    const client = iso === 'IQ' ? buildPhoneValue(iso, national).e164 : null;
    const server = normalizePhone(toAsciiDigits(raw));
    const serverIraqi = server && server.startsWith('+964') ? server : null;
    assert.equal(client, serverIraqi, raw);
  }
});

test('phone progress never reaches 100% while the number is incomplete, and regresses on deletion', () => {
  const full = buildPhoneValue('IQ', '7701234567');
  assert.equal(full.valid, true);
  assert.equal(full.progress, 1);

  const short = buildPhoneValue('IQ', '770123456');
  assert.equal(short.valid, false);
  assert.ok(short.progress < 1, String(short.progress));
  assert.ok(short.progress < full.progress);

  // A number on the wrong track (not an Iraqi mobile prefix) must not look
  // "almost done".
  const wrong = buildPhoneValue('IQ', '123456789');
  assert.equal(wrong.valid, false);
  assert.ok(wrong.progress <= 0.2, String(wrong.progress));
});

test('changing the country re-validates immediately (§2.2 regression rule)', () => {
  const digits = '7701234567';
  assert.equal(buildPhoneValue('IQ', digits).valid, true);
  // Same digits under a different dial code are only a plausibility pass,
  // and the E.164 changes — readiness is recomputed, never latched.
  const de = buildPhoneValue('DE', digits);
  assert.equal(de.e164, '+497701234567');
  const iqShort = buildPhoneValue('IQ', '77012345');
  assert.equal(iqShort.valid, false);
});

// --------------------------------------------------------------- OTP

test('OTP normalization keeps digits only, in Arabic or ASCII, capped at six', () => {
  assert.equal(normalizeOtp('123456'), '123456');
  assert.equal(normalizeOtp('123 456'), '123456');
  assert.equal(normalizeOtp('١٢٣٤٥٦'), '123456');
  assert.equal(normalizeOtp('۱۲۳۴۵۶'), '123456');
  assert.equal(normalizeOtp('12-34-56'), '123456');
  assert.equal(normalizeOtp('1234567890'), '123456');
  assert.equal(normalizeOtp('abc'), '');
  assert.equal(normalizeOtp(''), '');
});

test('six digits mean READY TO SUBMIT, never verified (§2.4)', () => {
  const meter = (code: string) =>
    combineFillProgress([{ progress: code.length / 6, valid: normalizeOtp(code).length === 6 }]);
  assert.equal(meter('').ready, false);
  assert.equal(meter('12345').ready, false);
  assert.ok(meter('12345').progress < 1);
  const full = meter('123456');
  assert.equal(full.ready, true);
  assert.equal(full.progress, 1);
  // Backspace ⇒ instantly not ready again.
  assert.equal(meter('12345').ready, false);
});
