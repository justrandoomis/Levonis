/**
 * EVERY MODEL ANSWER IS READ BY HAND, OR IT IS NOTHING (push B plan §16 #2,
 * §6.2, §7; invariants I2, I3, I4).
 *
 *   - `readReading` and `readPhotoReading` refuse (null) an extra or a
 *     missing key, an unknown enum, an action that disagrees with its intent,
 *     a non-object or an array, and an outcome outside the steps stage;
 *   - enums are read case-insensitively and canonicalised, printer aliases
 *     round-trip to push A's tokens, `"none"` is an absent field;
 *   - a search term survives only as whole tokens of the customer's own text;
 *   - an HMS code survives only in push A's canonical form, three at most;
 *     label codes four at most; low confidence keeps the codes only, an
 *     unclear subject nothing;
 *   - `readTranscript` refuses Sorani letters, another language, a low
 *     probability, mostly silence and a note over 75 s.
 *
 * Run: node --import tsx --test tests/aiValidate.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalHmsCode, readPhotoReading, readReading, readTranscript, verifiedTerms } from '../worker/lib/assist/ai/validate';
import { MODEL_ALIAS, MODEL_ALIASES, aliasOfToken, tokenOfAlias } from '../worker/lib/assist/ai/aliases';
import { ROUTABLE_INTENTS } from '../worker/lib/assist/ai/adapter';
import { MODEL_TOKENS } from '../worker/lib/assist/types';
import type { AssistContext } from '../worker/lib/assist/context';
import { photoReading, textReading } from './fixtures/aiRoutes';

const CTX: AssistContext = { v: 1 };
const STEPS: AssistContext = { v: 1, printer: { model: 'A1' }, triage: { stage: 'steps', symptom: 'clog', steps: true } };

test('a reading is a plain object with exactly the schema keys, or nothing', () => {
  const ok = textReading({ action: 'triage', symptom: 'clog' });
  assert.ok(readReading(ok, 'x', CTX));
  for (const bad of [null, undefined, 'triage', 7, [], [ok], Object.assign(Object.create({ evil: 1 }), ok)]) {
    assert.equal(readReading(bad, 'x', CTX), null, JSON.stringify(bad));
  }
  assert.equal(readReading({ ...ok, note: 'extra' }, 'x', CTX), null, 'an extra key');
  const missing: Record<string, unknown> = { ...ok };
  delete missing.terms;
  assert.equal(readReading(missing, 'x', CTX), null, 'a missing key');
  assert.equal(readReading({ ...ok, symptom: 'overheating' }, 'x', CTX), null, 'an unknown enum');
  assert.equal(readReading({ ...ok, printer: 'Ender 3' }, 'x', CTX), null, 'a printer outside the aliases');
  assert.equal(readReading({ ...ok, maintenance: 'yes' }, 'x', CTX), null, 'a boolean that is not one');
  assert.equal(readReading({ ...ok, terms: 'nozzle' }, 'x', CTX), null, 'terms that are not a list');
  assert.equal(readReading({ ...ok, terms: ['nozzle', 4] }, 'x', CTX), null, 'a term that is not a string');
  assert.equal(readReading({ ...ok, action: 'none_of_these' }, 'x', CTX), null);
});

test('the action and the intent agree, or nothing', () => {
  assert.deepEqual(readReading(textReading({ action: 'intent', intent: 'order_status' }), 'x', CTX), { action: 'intent', intent: 'order_status' });
  assert.equal(readReading(textReading({ action: 'intent' }), 'x', CTX), null, 'an intent action with no intent');
  assert.equal(readReading(textReading({ action: 'triage', intent: 'order_status' }), 'x', CTX), null, 'an intent beside another action');
  assert.equal(readReading(textReading({ action: 'none', intent: 'greeting' }), 'x', CTX), null);
  // No write intent is in the enum, so none can be named.
  for (const write of ['cancel_order', 'open_ticket', 'product_search', 'printer_problem', 'price_question']) {
    assert.equal(readReading(textReading({ action: 'intent', intent: write }), 'x', CTX), null, write);
  }
  for (const intent of ROUTABLE_INTENTS) assert.ok(readReading(textReading({ action: 'intent', intent }), 'x', CTX), intent);
  assert.deepEqual(readReading(textReading(), 'x', CTX), { action: 'none' });
});

test('an outcome stands only while the steps are on screen', () => {
  const said = textReading({ action: 'outcome', outcome: 'not_fixed' });
  assert.equal(readReading(said, 'ما انحلت', CTX), null, 'no steps on screen');
  assert.equal(readReading(said, 'ما انحلت', { v: 1, triage: { stage: 'symptom' } }), null);
  assert.deepEqual(readReading(said, 'ما انحلت', STEPS), { action: 'outcome', outcome: 'not_fixed' });
  assert.equal(readReading(textReading({ action: 'outcome' }), 'x', STEPS), null, 'an outcome action with no outcome');
});

test('enums are read case-insensitively, canonicalised, and the aliases round-trip', () => {
  const r = readReading(textReading({ action: 'TRIAGE', printer: 'P1S', symptom: 'Adhesion' }), 'x', CTX);
  assert.deepEqual(r, { action: 'triage', model: 'P1S', symptom: 'adhesion' });
  assert.deepEqual(readReading(textReading({ action: 'triage', printer: 'a1_mini' }), 'x', CTX), { action: 'triage', model: 'A1 mini' });
  assert.deepEqual(readReading(textReading({ action: 'triage', printer: 'OTHER' }), 'x', CTX), { action: 'triage', model: 'other' });
  assert.deepEqual(readReading(textReading({ action: 'triage', printer: 'NONE', symptom: 'None' }), 'x', CTX), { action: 'triage' });
  // Every alias is unique, round-trips, and is enum-safe.
  assert.equal(new Set(MODEL_ALIASES).size, MODEL_TOKENS.length);
  for (const token of MODEL_TOKENS) {
    const alias = aliasOfToken(token);
    assert.match(alias, /^[a-z0-9_]+$/);
    assert.equal(MODEL_ALIAS[alias], token);
    assert.equal(tokenOfAlias(alias.toUpperCase()), token);
  }
  assert.equal(tokenOfAlias('A1 mini'), null, 'a token is not an alias');
});

test('search terms survive only as whole tokens of what the customer typed', () => {
  const typed = 'شنو احسن شي انظف بيه النوزل مال PEI-plate';
  assert.deepEqual(verifiedTerms(['النوزل', 'انظف', 'نوزل', 'pei plate', 'ZZMODELZZ', 'plate', 'p'], typed), ['النوزل', 'انظف', 'pei plate', 'plate']);
  assert.deepEqual(verifiedTerms(['x'.repeat(33), 'a'], 'a ' + 'x'.repeat(33)), [], 'shorter than 2 or longer than 32 characters');
  assert.equal(verifiedTerms(['انظف', 'النوزل', 'شنو', 'احسن', 'شي'], typed).length, 4, 'four at most');
  const r = readReading(textReading({ action: 'products', part: 'cleaning', maintenance: true, terms: ['النوزل', 'invented'] }), typed, CTX);
  assert.deepEqual(r, { action: 'products', part: 'cleaning', maintenance: true, terms: ['النوزل'] });
  // Nothing left to search for: no part, no printer of the shop, no surviving word.
  assert.equal(readReading(textReading({ action: 'products', terms: ['invented'] }), typed, CTX), null);
  assert.equal(readReading(textReading({ action: 'products', printer: 'other' }), typed, CTX), null);
  assert.ok(readReading(textReading({ action: 'products', printer: 'a1' }), typed, CTX));
});

test('an HMS code is push A’s canonical code or nothing', () => {
  assert.equal(canonicalHmsCode('0300-0100-0001-0003'), '0300-0100-0001-0003');
  assert.equal(canonicalHmsCode('0300_0100_0001_000a'), '0300-0100-0001-000A');
  assert.equal(canonicalHmsCode('0500-4038'), '0500-4038', 'the printer’s short code');
  for (const bad of ['0300-0100-0001', '2024-1000-5000-3000', 'ZZMO-DELZ', '0300-0100-0001-0003-0004', 'HMS', '', 42, null]) {
    assert.equal(canonicalHmsCode(bad), undefined, String(bad));
  }
});

test('a photo reading: exact keys, canonical codes, the caps, and what confidence keeps', () => {
  const full = photoReading({
    subject: 'Printer_Screen',
    printer: 'X1C',
    symptom: 'hms',
    part: 'nozzle_hotend',
    hms_codes: ['0300-0100-0001-0003', '0300_0100_0001_0003', '0500-4038', 'ZZMO-DELZ', '0700-2000', '0C00-0300-0003-0008'],
    label_codes: ['PLA-BASIC-1', 'pla-basic-1', 'TPU-95A', 'ABS-1', 'PETG-1', 'ASA-1', '-bad', 'x'],
  });
  assert.deepEqual(readPhotoReading(full), {
    subject: 'printer_screen',
    model: 'X1C',
    symptom: 'hms',
    part: 'nozzle_hotend',
    hmsCodes: ['0300-0100-0001-0003', '0500-4038', '0700-2000'],
    labelCodes: ['PLA-BASIC-1', 'TPU-95A', 'ABS-1', 'PETG-1'],
    confidence: 'high',
  });
  assert.deepEqual(readPhotoReading({ ...full, confidence: 'low' }), {
    subject: 'printer_screen',
    hmsCodes: ['0300-0100-0001-0003', '0500-4038', '0700-2000'],
    labelCodes: [],
    confidence: 'low',
  });
  assert.deepEqual(readPhotoReading({ ...full, subject: 'unclear' }), { subject: 'unclear', hmsCodes: [], labelCodes: [], confidence: 'high' });
  assert.equal(readPhotoReading({ ...full, extra: 1 }), null);
  assert.equal(readPhotoReading({ ...full, printer: 'other' }), null, 'a photo names no «other» printer');
  assert.equal(readPhotoReading({ ...full, hms_codes: '0300-0100-0001-0003' }), null);
  assert.equal(readPhotoReading({ ...full, label_codes: [1] }), null);
  assert.equal(readPhotoReading({ ...full, confidence: 'certain' }), null);
  assert.equal(readPhotoReading([full]), null);
  assert.equal(readPhotoReading({ ...full, hms_codes: Array.from({ length: 40 }, () => '0300-0100-0001-0003') }), null, 'a list that is no answer');
});

test('a transcript: plain text, Arabic or English, mostly speech, at most 75 s, never Sorani', () => {
  assert.deepEqual(readTranscript({ text: '  النوزل\u0000 مسدود\n\n ', transcription_info: { language: 'ar', language_probability: 0.93, duration: 4.5 } }), {
    text: 'النوزل مسدود',
    seconds: 4.5,
  });
  assert.deepEqual(readTranscript({ text: 'my nozzle is clogged' }), { text: 'my nozzle is clogged', seconds: null });
  for (const bad of [
    null,
    [],
    { text: 4 },
    { text: '   ' },
    { text: 'x'.repeat(501) },
    { text: 'نۆزڵەکە گیراوە' },
    { text: 'hola', transcription_info: { language: 'es' } },
    { text: 'hello', transcription_info: { language: 'en', language_probability: 0.4 } },
    { text: 'hello', transcription_info: { language: 'en', duration: 80 } },
    { text: 'hello', transcription_info: { language: 'en', duration: 'long' } },
    { text: 'hello', segments: [{ no_speech_prob: 0.9 }, { no_speech_prob: 0.7 }] },
    { text: 'hello', segments: 'none' },
    { text: 'hello', transcription_info: 'en' },
  ]) {
    assert.equal(readTranscript(bad), null, JSON.stringify(bad));
  }
  assert.ok(readTranscript({ text: 'hello', segments: [{ no_speech_prob: 0.1 }, { no_speech_prob: 0.6 }] }), 'a mean of 0.35 is speech');
});
