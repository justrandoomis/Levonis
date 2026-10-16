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
 *      manifest does not hold.
 *
 * Run: node --import tsx --test tests/catalogTranslationsData.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { loadReviewedBundle } from '../scripts/bambu-import/discover';
import { checkTranslationsDir, indexOf, manifestProductIds, serializeIndex, TRANSLATIONS_DIR, translationNames } from '../scripts/bambu-import/i18nData';
import { serializeTranslationPart, sourceHash, type TranslationRow } from '../packages/catalog/src/bambuImport/i18n';
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
