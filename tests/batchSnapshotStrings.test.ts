/**
 * THE OWNER'S BATCH SNAPSHOT CARD IN THREE LANGUAGES, AND ITS CONTRACT (FX
 * programme plan §9 §17-§19; push FX-6; docs/DECISIONS.md row 183: a `ckb`
 * slot never carries a copy of the Arabic).
 *
 * Every entry of src/components/adminInventory/batchSnapshotStrings.ts has
 * ar, en and real Sorani with matching placeholders; the plan's own words are
 * kept («غير معروف» / Unknown / «نەزانراو», «مشتق من مستند الشراء»); the card
 * reads the owner's route only, renders nothing when refused, shows the two
 * costs apart and computes no money; it is mounted on the lot detail and on a
 * received purchase.
 *
 * Run: node --import tsx --test tests/batchSnapshotStrings.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { BATCH_STRINGS, fill } from '../src/components/adminInventory/batchSnapshotStrings';

const SORANI_ONLY = /[ڕڵێۆەڤگچپژیک]/;
const ARABIC_ONLY = /[ةىيك]/;
const placeholders = (s: string) => [...s.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]).sort();

test('every batch snapshot string has ar, en and its own Sorani — never the Arabic or the English', () => {
  const entries = Object.entries(BATCH_STRINGS);
  assert.ok(entries.length >= 30, String(entries.length));
  for (const [key, { ar, en, ckb }] of entries) {
    for (const [lang, s] of Object.entries({ ar, en, ckb })) assert.ok(s.trim().length > 0 && s === s.trim(), `${key}.${lang}`);
    assert.notEqual(ckb, ar, `${key}: the Sorani slot carries the Arabic (row 183)`);
    assert.notEqual(ckb, en, `${key}: the Sorani slot carries the English`);
    assert.match(ckb, SORANI_ONLY, `${key}: no Sorani letter`);
    assert.doesNotMatch(ckb, ARABIC_ONLY, `${key}: an Arabic-only letter in the Sorani`);
    assert.match(ar, /[؀-ۿ]/, `${key}: the Arabic is not Arabic`);
    assert.doesNotMatch(en, /[؀-ۿ]/, `${key}: Arabic script in the English`);
    assert.deepEqual(placeholders(ckb), placeholders(ar), `${key}: ckb placeholders`);
    assert.deepEqual(placeholders(en), placeholders(ar), `${key}: en placeholders`);
  }
  assert.equal(fill(BATCH_STRINGS.version.en, { n: 3 }), 'version 3');
});

test('the plan\'s own words: unknown, known only in IQD, derived from the purchase document', () => {
  assert.deepEqual(BATCH_STRINGS.unknown, { ar: 'غير معروف', en: 'Unknown', ckb: 'نەزانراو' });
  assert.equal(BATCH_STRINGS.iqdOnly.ar, 'بالدينار فقط');
  assert.deepEqual(BATCH_STRINGS.derivedDocument, { ar: 'مشتق من مستند الشراء', en: 'derived from the purchase document', ckb: 'لە بەڵگەنامەی کڕینەوە دەرهێنراوە' });
  assert.match(BATCH_STRINGS.iqdOnlyNote.en, /never converted at today’s rate/);
});

test('the card reads the owner\'s route only, renders nothing when refused, keeps the two costs apart and computes no money', () => {
  const src = readFileSync(join(ROOT, 'src/components/adminInventory/BatchSnapshotCard.tsx'), 'utf8');
  assert.match(src, /\/api\/admin\/pricing\/batches\?/);
  assert.match(src, /status === 'hidden'\) return null/);
  assert.match(src, /e\?\.status === 403/);
  assert.ok(src.indexOf('S.batchCostTitle') < src.indexOf('S.snapshotTitle'), 'the batch cost first, the snapshot apart');
  assert.doesNotMatch(src, /\*\s*(Number|rate|parseFloat)|\/\s*(Number|rate|parseFloat)|iqdTo|toUsd/, 'no client-side conversion');
  assert.doesNotMatch(src, /localStorage|sessionStorage/);
  const lots = readFileSync(join(ROOT, 'src/components/adminInventory/InventoryLotPanel.tsx'), 'utf8');
  assert.match(lots, /<BatchSnapshotCard[^>]*filter=\{\{ lot_id: detail\.lot\.id \}\}/);
  const procurement = readFileSync(join(ROOT, 'src/components/adminOperations/ProcurementPanel.tsx'), 'utf8');
  assert.match(procurement, /<BatchSnapshotCard[^>]*filter=\{\{ purchase_id: selected\.purchase\.id \}\}/);
});
