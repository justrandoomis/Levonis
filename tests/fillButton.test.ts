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
import { readFileSync } from 'node:fs';
import {
  clamp01,
  isValidEmailAddress,
  emailFieldProgress,
  lengthProgress,
  combineFillProgress,
  loginPasswordPart,
  signinIdentifierPart,
  INCOMPLETE_FILL_CAP,
} from '../src/components/auth/FillButton';
import {
  toAsciiDigitsClient,
  normalizePhoneInput,
  buildPhoneValue,
  emptyPhoneValue,
  countryByIso,
  COUNTRIES,
  COMMON_ISO,
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

test('typing an email into the identifier never moves the meter backwards', () => {
  // "use" is a complete username (valid at 3), but the next keystrokes of
  // "user@example.com" put the field on the EMAIL track. The old ramp read
  // 1.0 at three characters and 0.45 the moment "@" arrived — a backwards
  // slosh mid-word that looks like a broken animation. The tracks now meet.
  let prev = -1;
  const typed = 'user@example.com';
  for (let n = 1; n <= typed.length; n++) {
    const part = signinIdentifierPart(typed.slice(0, n));
    assert.ok(
      part.progress >= prev - 1e-9,
      `progress fell from ${prev} to ${part.progress} at "${typed.slice(0, n)}"`
    );
    prev = part.progress;
  }
  const done = signinIdentifierPart(typed);
  assert.equal(done.valid, true);
  assert.equal(done.progress, 1);

  // The username track stays honest on its own terms: valid at 3+, and its
  // partial display never over-reports past where the email track begins.
  const uname = signinIdentifierPart('use');
  assert.equal(uname.valid, true);
  assert.ok(uname.progress <= 0.45 + 1e-9, String(uname.progress));
  assert.equal(signinIdentifierPart('us').valid, false);
});

test('the sign-in meter fills with password length and completes only at 8', () => {
  // The calibration complaint, pinned: with a finished email, each password
  // character moves the bar, nothing before the 8th completes it, and the
  // incomplete bar always stays at or below the visible cap — an
  // almost-valid form must never wear a finished button.
  const emailPart = {
    progress: emailFieldProgress('user@example.com'),
    valid: isValidEmailAddress('user@example.com'),
  };
  let prev = -1;
  for (let n = 0; n <= 7; n++) {
    const r = combineFillProgress([emailPart, loginPasswordPart('x'.repeat(n))]);
    assert.equal(r.ready, false, `${n} password characters must not be ready`);
    assert.ok(r.progress <= INCOMPLETE_FILL_CAP + 1e-9, `cap broken at ${n}: ${r.progress}`);
    assert.ok(r.progress >= prev, `the meter went backwards while typing at ${n}`);
    prev = r.progress;
  }
  assert.deepEqual(combineFillProgress([emailPart, loginPasswordPart('x'.repeat(8))]), {
    progress: 1,
    ready: true,
  });
});

test('the sign-in password minimum matches the one the worker stores by', () => {
  // loginPasswordPart may demand 8 only because every write path
  // (register / reset / change / telegram-complete) enforces PASSWORD_MIN=8
  // in worker/routes/auth.ts — if that constant moves, this must move with it.
  const src = readFileSync(new URL('../worker/routes/auth.ts', import.meta.url), 'utf8');
  assert.match(src, /const PASSWORD_MIN = 8;/);
  assert.equal(loginPasswordPart('x'.repeat(7)).valid, false);
  assert.equal(loginPasswordPart('x'.repeat(8)).valid, true);
  assert.equal(loginPasswordPart('x'.repeat(129)).valid, false, 'above PASSWORD_MAX is not a stored password either');
});

test('an incomplete form can never fill past the visible cap', () => {
  // One rule short of valid used to render 96% — a sliver the border radius
  // swallows, so the button LOOKED finished while refusing the tap.
  const r = combineFillProgress([
    { progress: 1, valid: true },
    { progress: 0.99, valid: false },
  ]);
  assert.equal(r.ready, false);
  // An ABSOLUTE bound, not the constant itself — comparing against
  // INCOMPLETE_FILL_CAP would pass no matter where the cap drifted, which
  // is exactly how the first version of this test let 0.96 back in.
  assert.ok(r.progress <= 0.9, `${r.progress} — anything above ~90% hides in the border radius and reads as done`);
  assert.ok(INCOMPLETE_FILL_CAP <= 0.9, String(INCOMPLETE_FILL_CAP));
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
  assert.equal(countryByIso('nope').iso, 'IQ');
  // The list is now every country libphonenumber knows, sorted by ISO code,
  // so "Iraq is first" is no longer a property of the array — it is a
  // property of the PICKER, which floats the markets this platform serves to
  // the top. That is the guarantee worth asserting.
  assert.equal(COMMON_ISO[0], 'IQ');
  assert.ok(COUNTRIES.length > 200, `only ${COUNTRIES.length} countries`);
  assert.ok(COUNTRIES.some((c) => c.iso === 'IQ' && c.dial === '964'));
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

  // 07700 900xxx is Ofcom's drama range — reserved as NEVER allocated, so a
  // real numbering plan refuses it. That is the point of validating against
  // one: the old "8 to 15 digits" rule would have accepted it.
  assert.equal(buildPhoneValue('GB', '7700900123').valid, false);

  const uk = normalizePhoneInput('00447400123456', 'IQ');
  assert.equal(uk.iso, 'GB');
  assert.equal(buildPhoneValue(uk.iso, uk.national).e164, '+447400123456');
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
