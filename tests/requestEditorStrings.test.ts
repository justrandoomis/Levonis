/**
 * THE REQUEST EDITOR'S WORDS (plan P1-06; docs/DECISIONS.md rows 183, 268;
 * design critiques 9, 16–18): every key in Arabic, English and Sorani, and
 * Sorani never the Arabic or the English pasted across.
 *
 * Sorani is checked against the other two, not against an alphabet: «داخستن»,
 * «وردی» or «ستاندارد» are good Sorani with no letter Arabic lacks, so a rule
 * «every Sorani line carries ڕ ێ ۆ ە ڵ» would fail correct words. What IS
 * held: no Sorani value equals its Arabic or English; the technical names
 * that are the same in every language are a reviewed list; a placeholder is
 * in all three; English carries no ASCII apostrophe (the clay census reads
 * quotes); the editor names a part «القطعة» / «پارچە» everywhere, and the
 * original file with the words its refusal uses.
 *
 * Run: node --import tsx --test tests/requestEditorStrings.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { EDITOR_STRINGS, partsCountWords, piecesPerSetWords, setsWords } from '../src/components/community/requests/editor/strings';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';

const { ar, en, ckb } = EDITOR_STRINGS;
const keys = Object.keys(ar) as Array<keyof typeof ar>;

/** The technical names that are the same in every language (reviewed). */
const TECHNICAL = new Set(['PLA', 'PETG', 'TPU', 'FDM', 'STL', '3MF', 'OBJ', 'STEP', 'PDF', 'CAD', 'https', 'mm']);

test('every key is written in Arabic, English and Sorani', () => {
  assert.deepEqual(Object.keys(en).sort(), [...keys].sort());
  assert.deepEqual(Object.keys(ckb).sort(), [...keys].sort());
  for (const k of keys) {
    for (const [lang, table] of [['ar', ar], ['en', en], ['ckb', ckb]] as const) {
      assert.equal(typeof table[k], 'string', `${lang}.${k}`);
      assert.ok(String(table[k]).trim().length > 0, `${lang}.${k} is empty`);
    }
  }
  assert.ok(keys.length > 150, `${keys.length} keys`);
});

test('no Sorani line is the Arabic or the English pasted across', () => {
  const copies = keys.filter((k) => ckb[k] === ar[k] || ckb[k] === en[k]);
  assert.deepEqual(copies, [], `ckb copies: ${copies.join(', ')}`);
});

test('every placeholder is in all three languages', () => {
  const holes = (v: string) => [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  const off = keys.filter((k) => holes(ar[k]) !== holes(en[k]) || holes(ar[k]) !== holes(ckb[k]));
  assert.deepEqual(off, [], `placeholders differ: ${off.join(', ')}`);
});

test('Arabic and Sorani carry no Latin words but the reviewed technical names', () => {
  const stray: string[] = [];
  for (const k of keys) {
    for (const [lang, table] of [['ar', ar], ['ckb', ckb]] as const) {
      const words = String(table[k]).replace(/\{\w+\}/g, ' ').match(/[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*/g) ?? [];
      for (const w of words) if (!TECHNICAL.has(w)) stray.push(`${lang}.${k}: ${w}`);
    }
  }
  assert.deepEqual(stray, []);
});

test('English carries no ASCII apostrophe (the clay census reads quotes in sources)', () => {
  const quoted = keys.filter((k) => en[k].includes("'"));
  assert.deepEqual(quoted, []);
});

test('one word for a part, and the original file named as its refusal names it', () => {
  // «القطعة» / «پارچە» — never «الأجزاء» / «بەش» beside it (critique 8).
  for (const k of ['addPart', 'addPartHint', 'partName', 'removePart', 'perSet'] as const) {
    assert.ok(!/الأجزاء|جزء/.test(ar[k]), `ar.${k}`);
    assert.ok(!/\bبەش\b/.test(ckb[k]), `ckb.${k}`);
  }
  assert.match(ar.addPartHint, /عدة قطع/);
  assert.match(ckb.addPart, /پارچە/);
  // «الملف الأصلي» / «فایلی ڕەسەن», the words of SOURCE_ORIGINAL_PRIVATE — never «دەستکاریکراو» (the EDITED original).
  assert.match(ar.originalOn, /الملف الأصلي/);
  assert.match(ckb.originalOn, /فایلی ڕەسەن/);
  assert.match(REFUSAL_STRINGS.SOURCE_ORIGINAL_PRIVATE.ar, /الملف الأصلي/);
  assert.match(REFUSAL_STRINGS.SOURCE_ORIGINAL_PRIVATE.ckb, /فایلی ڕەسەن/);
  for (const k of keys) assert.ok(!ckb[k].includes('دەستکاریکراو'), `ckb.${k} says «edited»`);
  // A nozzle is «نۆزڵ», never «لووتکە» (a summit).
  assert.match(ckb.traitAbrasive, /نۆزڵ/);
  assert.ok(!keys.some((k) => ckb[k].includes('لووتکە')));
  // The original's file name is listed publicly: the hint says so.
  assert.match(ar.originalHint, /اسمه يظهر/);
  assert.match(en.originalHint, /file name is listed/);
});

test('the bar fits 360 px: the primary step and every status are short in every language', () => {
  for (const table of [ar, en, ckb]) {
    assert.ok(table.review.length <= 12, table.review);
    for (const k of ['statusSaved', 'statusSaving', 'statusDirty', 'statusFailed', 'statusOffline', 'statusConflict', 'statusEditDirty'] as const) {
      assert.ok(table[k].length <= 22, `${k}: ${table[k]}`);
    }
  }
});

test('the count words agree with their number, in the cards’ own word', () => {
  assert.equal(partsCountWords(2, 'ar'), 'قطعتان');
  assert.equal(partsCountWords(3, 'ar'), '3 قطع');
  assert.equal(partsCountWords(11, 'ar'), '11 قطعة');
  assert.equal(partsCountWords(2, 'en'), '2 parts');
  assert.equal(partsCountWords(2, 'ckb'), '2 پارچە');
  assert.equal(piecesPerSetWords(3, 'ar'), '3 نسخ في الطقم');
  assert.equal(piecesPerSetWords(2, 'en'), '2 copies in a set');
  assert.equal(setsWords(2, 'ar'), 'طقمان');
  assert.notEqual(piecesPerSetWords(3, 'ckb'), piecesPerSetWords(3, 'ar'));
});

test('the editor never shows the sheet grabber words (their Sorani slot is still the Arabic placeholder)', () => {
  // Sheet.tsx names its grabber button «توسيع»/«تصغير» only when a sheet has
  // two detents. Its ckb slot still carries the Arabic (an OWNER note there);
  // writing it costs the merchant workspace closure 53 bytes it does not have
  // (tests/bundleBudget.test.ts). Every editor sheet has ONE detent, so a
  // Sorani reader of the editor never meets those words.
  const dir = join(ROOT, 'src/components/community/requests/editor');
  for (const f of ['MaterialPicker.tsx', 'ColourPicker.tsx', 'ReviewSheet.tsx']) {
    const src = readFileSync(join(dir, f), 'utf8');
    assert.match(src, /detents=\{\['large'\]\}/, f);
    assert.doesNotMatch(src, /dragHandle|'medium'/, f);
  }
});

test('the editor refusals are written in all three languages', () => {
  for (const code of ['REQUEST_TITLE_REQUIRED', 'REQUEST_DESCRIPTION_REQUIRED', 'DRAFT_CHANGED', 'REQUEST_IS_DIRECT']) {
    const e = REFUSAL_STRINGS[code];
    assert.ok(e?.ar && e.en && e.ckb, code);
    assert.notEqual(e.ckb, e.ar, code);
    assert.notEqual(e.ckb, e.en, code);
  }
});
