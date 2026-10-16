/**
 * THE IMPORT'S TRANSLATIONS (Bambu import spec §C.8; DECISIONS rows 2 and 183).
 *
 * Every fixture product is written through the real writer, and every ar/ckb
 * pair it leaves is read back: the document's localizable slots, the option
 * groups and values, the image alt texts, the document titles and the
 * product_translations rows. No ckb slot equals its ar slot when either
 * contains Arabic script — a ckb text is real Sorani or the reader falls back to
 * the English, never a copy of the Arabic. Imported prose is marked `imported`
 * in translation_meta and every product_translations row is `review_needed`,
 * whatever the dictionary covered; the authored registry labels (spec labels,
 * the official-specifications group) keep their reviewed ar/ckb. Spec VALUES
 * are imported prose: what the dictionary renders, never approved, never kept
 * in English when the dictionary knows the word, and the internal family code
 * is never a row of the table.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { complete, count, newWorld, stage, write, type World } from './fixtures/catalogImportWorld';
import type { SampleHandle } from './fixtures/bambu/load';
import { parseProductRow } from '../worker/lib/productModel';
import { localizableSlots } from '../worker/lib/translationSlots';
import { ckbNotCopy, OFFICIAL_SPEC_GROUP } from '../worker/lib/catalogImport/writer';
import { localizeRespectingAuthored } from '../worker/lib/productPersistence';
import { translateText } from '../worker/lib/translate/index';

const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const HANDLES: SampleHandle[] = ['ams-2-pro-feeder-unit', 'a1', 'pla-basic-filament', 'h2d', 'bambu-hotend-a1-a2', 'bambu-textured-pei-plate', 'build-plate-combo', 'refurbished-bambu-lab-h2d-3d-printer', 'h2c'];

let world: World | null = null;
async function written(): Promise<World> {
  if (world) return world;
  const w = newWorld();
  for (const h of HANDLES) {
    const s = stage(w, h);
    await write(w, s);
    complete(w, s.itemId);
  }
  world = w;
  return w;
}

function copies(pairs: Array<{ where: string; ar: string; ckb: string }>): string[] {
  return pairs.filter((p) => (ARABIC.test(p.ar) || ARABIC.test(p.ckb)) && p.ar === p.ckb).map((p) => p.where);
}

test('no ckb slot equals its ar slot when either contains Arabic script — documents, options, images, documents, translation rows', async () => {
  const w = await written();
  const pairs: Array<{ where: string; ar: string; ckb: string }> = [];
  const products = w.raw.prepare('SELECT * FROM products').all() as Array<Record<string, unknown>>;
  assert.equal(products.length, HANDLES.length);
  let arabicSlots = 0;
  for (const row of products) {
    const doc = parseProductRow(row);
    for (const s of localizableSlots(doc as unknown as Record<string, unknown>)) {
      pairs.push({ where: `${doc.slug} ${s.key}`, ar: s.ar, ckb: s.ckb });
      if (ARABIC.test(s.ar)) arabicSlots++;
    }
  }
  assert.ok(arabicSlots > 20, 'the check reads real Arabic, not empty slots');
  for (const g of w.raw.prepare('SELECT id, name_ar, name_ckb FROM product_option_groups').all() as Array<{ id: string; name_ar: string; name_ckb: string }>) {
    pairs.push({ where: `group ${g.id}`, ar: g.name_ar, ckb: g.name_ckb });
  }
  for (const v of w.raw.prepare('SELECT id, name_ar, name_ckb FROM product_option_values').all() as Array<{ id: string; name_ar: string; name_ckb: string }>) {
    pairs.push({ where: `value ${v.id}`, ar: v.name_ar ?? '', ckb: v.name_ckb ?? '' });
  }
  for (const i of w.raw.prepare('SELECT id, alt_ar, alt_ckb FROM product_images').all() as Array<{ id: string; alt_ar: string; alt_ckb: string }>) {
    pairs.push({ where: `image ${i.id}`, ar: i.alt_ar, ckb: i.alt_ckb });
  }
  for (const d of w.raw.prepare('SELECT id, title_ar, title_ckb FROM product_documents').all() as Array<{ id: string; title_ar: string; title_ckb: string }>) {
    pairs.push({ where: `document ${d.id}`, ar: d.title_ar, ckb: d.title_ckb });
  }
  for (const t of w.raw.prepare('SELECT product_id, field, text_ar, text_ckb FROM product_translations').all() as Array<{ product_id: string; field: string; text_ar: string; text_ckb: string }>) {
    pairs.push({ where: `translation ${t.product_id} ${t.field}`, ar: t.text_ar, ckb: t.text_ckb });
  }
  assert.ok(pairs.filter((p) => ARABIC.test(p.ar)).length > 100);
  assert.deepEqual(copies(pairs), [], 'a ckb that copies the Arabic');
});

test('imported prose is marked imported and every translation row is review_needed; authored labels keep their reviewed text', async () => {
  const w = await written();
  const statuses = w.raw.prepare('SELECT DISTINCT status FROM product_translations').all() as Array<{ status: string }>;
  assert.deepEqual(statuses.map((s) => s.status), ['review_needed']);
  for (const row of w.raw.prepare('SELECT * FROM products').all() as Array<Record<string, unknown>>) {
    const doc = parseProductRow(row);
    // The name is the English title in every language (§1 row 15).
    assert.equal(doc.name_ar, doc.name_en);
    assert.equal(doc.name_ckb, doc.name_en);
    if (doc.description_en.trim()) assert.equal(doc.translation_meta.description?.ar?.status, 'imported', `${doc.slug} description`);
    const official = doc.spec_groups.find((g) => g.id === OFFICIAL_SPEC_GROUP.id);
    if (official) {
      assert.equal(official.title_ar, OFFICIAL_SPEC_GROUP.title_ar);
      assert.equal(official.title_ckb, OFFICIAL_SPEC_GROUP.title_ckb);
      assert.equal(doc.translation_meta[`spec_group:${official.id}:title`]?.ckb?.status, 'approved');
    }
  }
  // Every option group the registry knows carries its authored Arabic and Sorani names.
  const unnamed = w.raw.prepare("SELECT COUNT(*) AS n FROM product_option_groups WHERE kind NOT IN ('', 'other') AND (name_ar = '' OR name_ckb = '')").get() as { n: number };
  assert.equal(unnamed.n, 0);
});

test('spec values: what the local dictionary renders (never kept in English when it knows the word), imported, never approved — and an owner save keeps it so', async () => {
  const w = await written();
  let covered = 0;
  let uncovered = 0;
  const seen = new Map<string, { ar: string; ckb: string }>();
  for (const row of w.raw.prepare('SELECT * FROM products').all() as Array<Record<string, unknown>>) {
    const doc = parseProductRow(row);
    const official = doc.spec_groups.find((g) => g.id === OFFICIAL_SPEC_GROUP.id);
    if (!official) continue;
    for (const r of official.rows) {
      const key: string = `spec:${official.id}:${r.id}:value`;
      for (const lang of ['ar', 'ckb'] as const) assert.equal(doc.translation_meta[key]?.[lang]?.status, 'imported', `${doc.slug} ${r.label_en} ${lang}`);
      const ar = translateText(r.value_en, 'ar');
      const ckb = translateText(r.value_en, 'ckb');
      if (ar.status === 'machine') {
        covered++;
        assert.equal(r.value_ar, ar.text, `${doc.slug} ${r.label_en}: the dictionary's Arabic`);
        assert.equal(r.value_ckb, ckbNotCopy(ar.text, ckb.text), `${doc.slug} ${r.label_en}: the dictionary's Sorani (row 183)`);
      } else uncovered++;
      seen.set(r.value_en, { ar: r.value_ar, ckb: r.value_ckb });
    }
    // The owner's next save (the form path, adminProducts.ts): no imported value becomes approved, the dictionary's
    // text stays, and every value it does not cover is listed for the owner to translate.
    const next = parseProductRow(row);
    const saved = localizeRespectingAuthored(next, parseProductRow(row));
    const after = next.spec_groups.find((g) => g.id === OFFICIAL_SPEC_GROUP.id)!;
    for (const r of after.rows) {
      const key: string = `spec:${after.id}:${r.id}:value`;
      assert.notEqual(next.translation_meta[key]?.ar?.status, 'approved', `${doc.slug} ${r.label_en} after a save`);
      if (translateText(r.value_en, 'ar').status === 'machine') assert.equal(r.value_ar, translateText(r.value_en, 'ar').text);
      else assert.ok(saved.review_needed.includes(key), `${doc.slug} ${r.label_en}: listed for review`);
    }
  }
  assert.ok(covered > 20 && uncovered > 0, `${covered} covered, ${uncovered} not`);
  assert.deepEqual(seen.get('Supported'), { ar: 'مدعوم', ckb: 'پشتگیریکراو' }, 'H2D door sensor: the dictionary, not the English word');
});

test('the internal product_family code is never a row of the specification table; it stays a spec value for the facet', async () => {
  const w = await written();
  for (const row of w.raw.prepare('SELECT * FROM products').all() as Array<Record<string, unknown>>) {
    const doc = parseProductRow(row);
    const family = (w.raw.prepare("SELECT value_text FROM product_spec_values WHERE product_id = ? AND canonical_key = 'identity.family'").get(doc.id) as { value_text: string } | undefined)?.value_text;
    for (const g of doc.spec_groups) {
      for (const r of g.rows) {
        assert.notEqual(r.label_en, 'Family', `${doc.slug}: no Family row`);
        if (family) assert.notEqual(r.value_en, family, `${doc.slug}: the code ${family} is not shown`);
      }
    }
  }
  assert.ok(count(w.raw, "SELECT COUNT(*) AS n FROM product_spec_values WHERE canonical_key = 'identity.family'") >= 3, 'printers, filament, AMS keep the row (facet mirror)');
});

test('the guard itself: an Arabic ckb that copies the ar becomes empty; Latin text and real Sorani pass through', () => {
  assert.equal(ckbNotCopy('صورة PLA', 'صورة PLA'), '');
  assert.equal(ckbNotCopy('PLA', 'PLA'), 'PLA');
  assert.equal(ckbNotCopy('صورة PLA', 'وێنەی PLA'), 'وێنەی PLA');
  assert.equal(ckbNotCopy('', ''), '');
});
