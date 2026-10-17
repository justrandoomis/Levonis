/**
 * THE COMMITTED TRANSLATION MEMORY (docs/bambu-import/I18N-DESIGN.md §A.3, §E;
 * data/bambu-import/translations/; scripts/bambu-import/i18nData.ts).
 *
 *   1. the committed directory is valid: index.json lists exactly the part
 *      files present with their SHA-256, rows and bytes, each ≤ 1 MB; every
 *      row passes `validateTranslationRow` with the names and the identity
 *      terms; `h` and `en` are unique across parts; every product is a
 *      manifest product (a create's `p_…`, a merge's reviewed id). An empty
 *      directory — `{ version: 1, parts: {} }` — passes, so the code release
 *      lands first;
 *   2. the check catches each fault on a scratch copy: a part the index does
 *      not list, a changed byte, a bad row, a repeated string, a product the
 *      manifest does not hold;
 *   3. THE SCHEMA OF EVERY COMMITTED ROW, re-proved here without the validator:
 *      the keys in the committed order; `h` is the SHA-256 (node:crypto) of
 *      its `en` under the shared normalization; no empty `ar` or `ckb`; Arabic
 *      script in both unless the row is `keep` (the English stays: its ar and
 *      ckb ARE the English); the Sorani never a copy of the Arabic unless
 *      `keep` (DECISIONS row 183); no price, cost, stock or shipping-time word
 *      the English does not carry; no bidi control character.
 *
 * Run: node --import tsx --test tests/catalogTranslationsData.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { loadReviewedBundle } from '../scripts/bambu-import/discover';
import { checkTranslationsDir, indexOf, manifestProductIds, serializeIndex, TRANSLATIONS_DIR, translationNames } from '../scripts/bambu-import/i18nData';
import { normalizeSource, serializeTranslationPart, sourceHash, type TranslationRow } from '../packages/catalog/src/bambuImport/i18n';
import { newProductIdOf } from '../worker/lib/catalogImport/reviewed';

const bundle = loadReviewedBundle(join(ROOT, 'data', 'bambu-import'));
const ctx = { names: translationNames(bundle), productIds: manifestProductIds(bundle) };

test('the committed translations directory is valid (an empty index included)', () => {
  assert.deepEqual(checkTranslationsDir(join(ROOT, TRANSLATIONS_DIR), ctx), []);
  const index = JSON.parse(readFileSync(join(ROOT, TRANSLATIONS_DIR, 'index.json'), 'utf8'));
  assert.equal(index.version, 1);
});

test('the names and the product ids come from the reviewed files', () => {
  const fb = bundle.rows.find((r) => r.handle === 'filament-buffer')!;
  assert.ok(ctx.productIds.has(newProductIdOf(fb.source_product_id)), 'a create\'s deterministic id');
  for (const m of bundle.matches.values()) if (m.levonis_product_id) assert.ok(ctx.productIds.has(String(m.levonis_product_id)), 'a merge\'s reviewed id');
  for (const n of ['Filament Buffer', 'X1 Series', 'P1 Series', 'AMS Hub', 'Bambu Lab']) assert.ok(ctx.names.has(n), n);
  assert.ok(!ctx.names.has('Brush'), 'a one-word title is an ordinary word');
});

test('the check names every fault of a scratch copy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tm-data-'));
  try {
    const fb = newProductIdOf(bundle.rows.find((r) => r.handle === 'filament-buffer')!.source_product_id);
    const row = (en: string, ar: string, ckb: string, products = [fb]): TranslationRow => ({ h: sourceHash(en), en, ar, ckb, kind: 'spec_value_text', status: 'reviewed', products });
    const good = serializeTranslationPart([row('Below 10mA', 'أقل من 10mA', 'کەمتر لە 10mA'), row('Gray', 'رمادي', 'خۆڵەمێشی')]);
    const write = (parts: Record<string, string>, extra: Record<string, string> = {}) => {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      for (const [n, t] of Object.entries({ ...parts, ...extra })) writeFileSync(join(dir, `${n}.json`), t);
      writeFileSync(join(dir, 'index.json'), serializeIndex(indexOf(new Map(Object.entries(parts)))));
    };
    write({ p001: good });
    assert.deepEqual(checkTranslationsDir(dir, ctx), []);
    write({ p001: good }, { p002: good });
    assert.ok(checkTranslationsDir(dir, ctx).some((p) => /index\.json lists/.test(p)), 'a part the index does not list');
    write({ p001: good });
    writeFileSync(join(dir, 'p001.json'), good.replace('رمادي', 'رمادى'));
    assert.ok(checkTranslationsDir(dir, ctx).some((p) => /sha256 differs/.test(p)), 'a changed byte');
    write({ p001: serializeTranslationPart([row('Gray', 'رمادي', 'رمادي')]) });
    assert.deepEqual(checkTranslationsDir(dir, ctx), ['p001 row 0: CKB_COPIES_AR']);
    write({ p001: serializeTranslationPart([row('Use the AMS Hub', 'استخدم موزع AMS', 'AMS Hub بەکاربهێنە')]) });
    assert.deepEqual(checkTranslationsDir(dir, ctx), ['p001 row 0: NAME_TRANSLATED'], 'a name is kept verbatim');
    write({ p001: good, p002: serializeTranslationPart([row('Gray', 'رمادي', 'خۆڵەمێشی')]) });
    assert.ok(checkTranslationsDir(dir, ctx).some((p) => /h repeats/.test(p)), 'a string is in one part only');
    write({ p001: serializeTranslationPart([row('Gray', 'رمادي', 'خۆڵەمێشی', ['p_not_in_the_manifest'])]) });
    assert.ok(checkTranslationsDir(dir, ctx).some((p) => /not a manifest product/.test(p)));
    write({ p001: `${good.trimEnd()}` });
    assert.ok(checkTranslationsDir(dir, ctx).some((p) => /not written as the assembler writes/.test(p)), 'the exact form');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A money word in Arabic or Sorani → what the English must say for it to be the English's own fact. */
const MONEY: ReadonlyArray<[RegExp, RegExp, string]> = [
  [/\$|\bUSD\b|\bIQD\b|د\.ع|دينار|دۆلار/, /\$|\bUSD\b|\bIQD\b|dinar|dollar/i, 'a currency'],
  [/سعر|أسعار|ثمن|(^|[^؀-ۿ])نرخ/, /pric/i, 'a price'],
  [/تكلف|كلفة|تكاليف|(^|[^؀-ۿ])تێچوو/, /\bcosts?\b|costly|expens/i, 'a cost'],
  [/مخزون|متوفر في المخزن|(^|[\s،؛.:()«»])کۆگا(کە|ی|دا)?($|[\s،؛.:()«»])/, /stock|inventor|warehouse/i, 'stock'],
  [/الشحن خلال|التوصيل خلال|يُ?شحن خلال|گەیاندن لە ماوەی/, /ship|deliver/i, 'a shipping time'],
];
const ARABIC_LETTER = /[ؠ-يٮ-ۓەۺ-ۼۿ]/;
const BIDI = /[‎‏‪-‮⁦-⁩]/;

test('the schema of every committed row, re-proved without the validator: key, normalization, languages, no money added', () => {
  const dir = join(ROOT, TRANSLATIONS_DIR);
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as { parts: Record<string, { rows: number }> };
  const statuses: Record<string, number> = {};
  const seen = new Set<string>();
  let rows = 0;
  for (const part of Object.keys(index.parts).sort()) {
    const list = JSON.parse(readFileSync(join(dir, `${part}.json`), 'utf8')) as Array<Record<string, unknown>>;
    assert.equal(list.length, index.parts[part].rows, part);
    list.forEach((r, i) => {
      const at = `${part} row ${i}`;
      assert.deepEqual(Object.keys(r), ['h', 'en', 'ar', 'ckb', 'kind', 'status', 'products'], at);
      const { h, en, ar, ckb, status } = r as Record<string, string>;
      assert.equal(en, normalizeSource(en), `${at}: the English is stored normalized`);
      assert.equal(h, createHash('sha256').update(Buffer.from(normalizeSource(en), 'utf8')).digest('hex'), `${at}: h is the hash of its English`);
      assert.ok(!seen.has(h), `${at}: one row per string`);
      seen.add(h);
      assert.ok(typeof ar === 'string' && ar.trim() !== '' && typeof ckb === 'string' && ckb.trim() !== '', `${at}: no empty ar or ckb`);
      assert.ok(!BIDI.test(ar) && !BIDI.test(ckb), `${at}: no bidi control`);
      assert.ok(['reviewed', 'machine', 'needs_review', 'keep'].includes(status), `${at}: status ${status}`);
      if (status === 'keep') {
        assert.equal(ar, en, `${at}: a kept row is its English`);
        assert.equal(ckb, en, `${at}: a kept row is its English`);
      } else {
        assert.notEqual(ckb, ar, `${at}: the Sorani is never a copy of the Arabic (row 183)`);
        assert.match(ar, ARABIC_LETTER, `${at}: Arabic script`);
        assert.match(ckb, ARABIC_LETTER, `${at}: Sorani in Arabic script`);
      }
      for (const [word, english, what] of MONEY) {
        if (word.test(ar) || word.test(ckb)) assert.match(en, english, `${at}: ${what} the English does not state`);
      }
      assert.ok(Array.isArray(r.products) && (r.products as unknown[]).length > 0, `${at}: a product shows it`);
      statuses[status] = (statuses[status] ?? 0) + 1;
      rows += 1;
    });
  }
  // The committed memory (the reviewed translations of the imported text, 2026-10-17): every string of the
  // extraction has its row — reviewed, kept English, or stored for review — save the four the validator refused.
  assert.equal(rows, 8653);
  assert.deepEqual(statuses, { reviewed: 8254, keep: 378, needs_review: 21 });
});
