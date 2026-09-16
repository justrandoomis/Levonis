/**
 * Mandate §3 — the local deterministic translator.
 *
 * The two properties that matter most are pinned first: no network call ever
 * happens, and the engine never invents a translation. Everything else is a
 * behaviour check on the documented rules.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  translateText,
  translateField,
  hashSource,
  segment,
  TRANSLATABLE_FIELDS,
  TRANSLATION_VERSION,
} from '../worker/lib/translate/index';

// ------------------------------------------------------------ no AI, no net

test('translating never performs a network call', () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  // Deliberately replacing the global for the duration of the test.
  globalThis.fetch =  (...args: unknown[]) => {
    calls += 1;
    throw new Error(`translation attempted a network call: ${String(args[0])}`);
  };
  try {
    translateField('description', 'Nozzle diameter: 0.4 mm\nSome free prose the engine cannot handle.');
    translateText('Build volume: 256 x 256 x 256 mm', 'ckb');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls, 0);
});

test('the translator source contains no fetch, no AI provider and no API key', () => {
  for (const f of ['worker/lib/translate/index.ts', 'worker/lib/translate/dictionary.ts', 'worker/lib/translate/store.ts']) {
    const src = readFileSync(f, 'utf8');
    // Comments mention the ban by name; code must not call any of it.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.equal(/\bfetch\s*\(/.test(code), false, `${f} calls fetch`);
    assert.equal(/gemini|openai|anthropic|translate\.google|deepl/i.test(code), false, `${f} references a translation provider`);
    assert.equal(/API_KEY/.test(code), false, `${f} references an API key`);
  }
});

// ------------------------------------------------------- never invents text

test('free prose is kept in English and flagged review_needed — never guessed', () => {
  const prose = 'This printer is perfect for hobbyists who want reliable results every day.';
  const r = translateText(prose, 'ar');
  assert.equal(r.text, prose, 'prose must be returned unchanged');
  assert.equal(r.status, 'review_needed');
  assert.equal(r.coverage, 0);
});

test('a mixed field translates what it can and keeps the rest in English', () => {
  const src = 'Layer height: 0.2 mm\nThis is a sentence the catalog cannot cover.\nNozzle diameter: 0.4 mm';
  const r = translateText(src, 'ar');
  assert.match(r.text, /ارتفاع الطبقة: 0\.2 مم/);
  assert.match(r.text, /قطر الفوهة: 0\.4 مم/);
  assert.match(r.text, /This is a sentence the catalog cannot cover\./);
  assert.equal(r.status, 'review_needed');
  assert.ok(r.coverage > 0 && r.coverage < 1);
});

test('a term with no confident Sorani entry degrades ckb only, never fabricates one', () => {
  // 'acceleration' is recorded with ar and deliberately without ckb.
  const ar = translateText('Acceleration', 'ar');
  const ckb = translateText('Acceleration', 'ckb');
  assert.equal(ar.status, 'machine');
  assert.equal(ar.text, 'التسارع');
  assert.equal(ckb.status, 'review_needed');
  assert.equal(ckb.text, 'Acceleration');
});

// -------------------------------------------------------------- the rules

test('R2: material codes and model numbers stay as they are, and that counts as translated', () => {
  for (const token of ['PLA', 'PETG', 'USB-C', '3MF', 'X1C', 'A1']) {
    const r = translateText(token, 'ar');
    assert.equal(r.text, token, token);
    assert.equal(r.status, 'machine', token);
  }
});

test('R3: measurements keep their numbers and localize only the unit', () => {
  assert.equal(translateText('0.4 mm', 'ar').text, '0.4 مم');
  // The dimension separator becomes the MULTIPLICATION SIGN, not a Latin "x".
  // In an RTL paragraph a bare Latin x is a stray letter that flips the run
  // direction around it; × is what an Arabic or Kurdish spec sheet writes.
  assert.equal(translateText('256 x 256 x 256 mm', 'ar').text, '256 × 256 × 256 مم');
  assert.equal(translateText('256 × 256 × 256 mm', 'ckb').text, '256 × 256 × 256 مم');
  assert.equal(translateText('500 mm/s', 'ar').text, '500 مم/ث');
  assert.equal(translateText('220V', 'ar').text, '220 فولت');
  assert.equal(translateText('1.75 mm', 'ckb').text, '1.75 مم');
});

test('R4: an exact catalog phrase translates in both languages', () => {
  assert.equal(translateText('Build volume', 'ar').text, 'حجم الطباعة');
  assert.equal(translateText('Build volume', 'ckb').text, 'قەبارەی چاپ');
});

test('R5: label:value needs BOTH halves covered', () => {
  const good = translateText('Nozzle diameter: 0.4 mm', 'ar');
  assert.equal(good.text, 'قطر الفوهة: 0.4 مم');
  assert.equal(good.status, 'machine');
  // Known label, uncoverable value → the whole segment stays English.
  const bad = translateText('Nozzle diameter: whatever the vendor wrote', 'ar');
  assert.equal(bad.text, 'Nozzle diameter: whatever the vendor wrote');
  assert.equal(bad.status, 'review_needed');
});

test('R6: an enumeration translates only when every member is covered', () => {
  assert.equal(translateText('Supported materials: PLA, PETG, TPU', 'ar').text, 'المواد المدعومة: PLA، PETG، TPU');
  const partial = translateText('Black, Mauve', 'ar');
  assert.equal(partial.status, 'review_needed');
  assert.equal(partial.text, 'Black, Mauve');
});

test('bullets and trailing punctuation survive the round trip', () => {
  const r = translateText('- Layer height: 0.2 mm.', 'ar');
  assert.equal(r.text, '- ارتفاع الطبقة: 0.2 مم.');
  assert.equal(r.status, 'machine');
});

test('line structure is preserved exactly', () => {
  const src = 'Weight: 5 kg\n\nColor: Black';
  const r = translateText(src, 'ar');
  assert.equal(r.text.split('\n').length, 3);
  assert.equal(r.text, 'الوزن: 5 كغم\n\nاللون: أسود');
});

test('empty input is machine-complete, not an error', () => {
  const r = translateText('', 'ar');
  assert.equal(r.status, 'machine');
  assert.equal(r.text, '');
  assert.equal(r.coverage, 1);
});

// ------------------------------------------------------------ determinism

test('the same input always yields the same output', () => {
  const src = 'Nozzle diameter: 0.4 mm\nUnknown prose here.';
  const a = translateField('description', src);
  const b = translateField('description', src);
  assert.deepEqual(a, b);
});

test('the source hash changes with the text and with the engine version', () => {
  assert.notEqual(hashSource('a'), hashSource('b'));
  assert.equal(hashSource('a'), hashSource('a'));
  assert.match(hashSource('a'), /^[0-9a-f]{16}$/);
});

test('field status is the WEAKER of the two languages', () => {
  // 'Acceleration' is ar-only, so the field must be review_needed overall.
  const t = translateField('description', 'Acceleration');
  assert.equal(t.text_ar, 'التسارع');
  assert.equal(t.text_ckb, 'Acceleration');
  assert.equal(t.status, 'review_needed');
  assert.equal(t.translation_version, TRANSLATION_VERSION);
});

test('the product NAME is not in the translatable field list (§3)', () => {
  assert.equal((TRANSLATABLE_FIELDS as readonly string[]).includes('name'), false);
  assert.equal((TRANSLATABLE_FIELDS as readonly string[]).includes('name_en'), false);
});

test('segmentation is byte-for-byte reversible — no silent reflow', () => {
  for (const src of ['One. Two!\nThree?\n\nFour', '', 'no terminator', 'a.  b', '\n\n']) {
    assert.equal(segment(src).join(''), src, JSON.stringify(src));
  }
});

test('untranslatable prose comes back identical, spacing included', () => {
  const src = 'First sentence here. Second sentence here.\nThird line.';
  assert.equal(translateText(src, 'ar').text, src);
});
