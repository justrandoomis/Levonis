/**
 * THE TRANSLATION MEMORY ON THE PAGES A CUSTOMER READS (docs/bambu-import/
 * I18N-DESIGN.md §A.5; the owner's note on /product/filament-buffer,
 * 2026-10-16: «النص في الوصف وغيرها مازالت انجليزية كلها بالرغم اللغه عربيه»).
 *
 * The world: the live catalogue, the H2D carrying what the import's writer
 * leaves (English prose, the dictionary's or the English in the ar/ckb slots,
 * `translation_meta` = imported), its knowledge rows, and the memory's rows its
 * refs name — real routes, real migrations.
 *
 *   1. the page body (catalog-only and priced): the description, the usage
 *      steps, the content blocks and the official spec values in Arabic and
 *      Sorani, line by line; a line without a translation stays English; a
 *      slot a human approved keeps the human's text; the name and the option
 *      names stay English; a `needs_review` row is never shown; the legacy
 *      aliases follow; ckb never equals ar;
 *   2. public API v1 carries the same (description, usage_guide, content,
 *      specifications);
 *   3. the knowledge answer: `value_i18n`, `items_i18n`, `label_i18n`,
 *      `text_i18n`, a document's title;
 *   4. the comparison: a knowledge cell carries the memory's `i18n`, and the
 *      memory wins over the dictionary;
 *   5. a database at 0195 (no 0196) answers byte-identical bodies to one with
 *      an empty memory; a read that fails for any other reason gives English,
 *      never a 5xx.
 *
 * Run: node --import tsx --test tests/catalogTranslationsDisplay.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { APEX, asD1, ctx, dbThrough, freshDb, get, stubApp } from './fixtures/app';
import { seedLiveCatalog, LIVE_PRODUCTS, P } from './fixtures/liveCatalog';
import { insertSpecValue } from './fixtures/knowledgeModel';
import { fetchPublished } from './fixtures/autoPublish';
import { productRoutes } from '../worker/routes/products';
import worker from '../worker/index';
import { sourceHash } from '../packages/catalog/src/bambuImport/i18n';
import { forgetTranslationSchema } from '../worker/lib/translate/memory';
import { knowledgeCellsFor } from '../worker/lib/knowledge/compareKeys';
import { compareProducts, type KnowledgeCell } from '../worker/lib/compareSpecs';

const H2D = LIVE_PRODUCTS.find((p) => p.id === P.H2D)!;

const EN = {
  desc1: 'The buffer smooths the filament path.',
  desc2: 'Compatibility: X1 Series, P1P',
  title: 'Install the buffer',
  body1: 'Clip the buffer onto the printer.',
  body2: 'Connect the 4-Pin cable.',
  heading: 'Highlights',
  cell: 'Smooth feeding',
  gray: 'Gray',
  current: 'Below 10mA',
  howTo: 'Keep the buffer dry.',
  box: 'Buffer cable',
  label: 'Cable pitch',
  doc: 'Filament Buffer Quick Start',
  pending: 'A sentence still in review.',
} as const;

/** The memory: [en, ar, ckb, status]. */
const TM: Array<[string, string, string, string]> = [
  [EN.desc1, 'يُنعّم المخزن المؤقت مسار الخيط.', 'بافەرەکە ڕێڕەوی فیلامێنتەکە نەرم دەکات.', 'reviewed'],
  [EN.title, 'تركيب المخزن المؤقت', 'دانانی بافەرەکە', 'reviewed'],
  [EN.body1, 'ثبّت المخزن المؤقت على الطابعة.', 'بافەرەکە لەسەر پرینتەرەکە جێگیر بکە.', 'reviewed'],
  [EN.heading, 'أبرز الميزات', 'تایبەتمەندییە سەرەکییەکان', 'reviewed'],
  [EN.cell, 'تغذية سلسة', 'پێدانی نەرم', 'machine'],
  [EN.gray, 'رمادي', 'خۆڵەمێشی', 'reviewed'],
  [EN.current, 'أقل من 10mA', 'کەمتر لە 10mA', 'reviewed'],
  [EN.howTo, 'حافظ على جفاف المخزن المؤقت.', 'بافەرەکە وشک ڕابگرە.', 'reviewed'],
  [EN.box, 'كابل المخزن المؤقت', 'کێبڵی بافەر', 'reviewed'],
  [EN.label, 'خطوة الكابل', 'هەنگاوی کێبڵ', 'reviewed'],
  [EN.doc, 'دليل البدء السريع للمخزن المؤقت', 'ڕێبەری دەستپێکی خێرای بافەر', 'reviewed'],
  [EN.pending, 'جملة قيد المراجعة.', 'ڕستەیەک کە هێشتا پێداچوونەوەی بۆ دەکرێت.', 'needs_review'],
  // A name and an option name: the memory may hold them, the overlay never writes them (§3/§7).
  [H2D.name ?? 'Bambu Lab H2D', 'اسم مترجم', 'ناوی وەرگێڕدراو', 'reviewed'],
  ['Black', 'أسود', 'ڕەش', 'reviewed'],
];

const imported = { ar: { status: 'imported', src_rev: 1 }, ckb: { status: 'imported', src_rev: 1 } };

/** The H2D as the writer leaves an imported product, its knowledge rows, and (optionally) the memory. */
function seedImported(raw: DatabaseSync, { memory = true }: { memory?: boolean } = {}): void {
  const description = `${EN.desc1}\n${EN.desc2}`;
  const body = `• ${EN.body1}\n• ${EN.body2}`;
  const block = `${EN.heading}\n${EN.cell} | 50 g | ${EN.gray}\n${EN.pending}`;
  const guide = {
    official_url: '',
    steps: [{ id: 'us_1', kind: 'usage', title: EN.title, body, title_ar: EN.title, title_ckb: EN.title, body_ar: body, body_ckb: body, images: [], video_url: '', link_url: '', order: 0 }],
  };
  const blocks = [
    { id: 'cb_1', kind: 'text', order: 0, body_en: block, body_ar: block, body_ckb: block, caption_ar: '', caption_en: '', caption_ckb: '', alt_ar: '', alt_en: '', alt_ckb: '', url: '', media_key: '' },
  ];
  const groups = [
    {
      id: 'sg_bambu_official',
      title_ar: 'مواصفات Bambu Lab الرسمية',
      title_en: 'Bambu Lab official specifications',
      title_ckb: 'تایبەتمەندییە فەرمییەکانی Bambu Lab',
      order: 0,
      rows: [
        { id: 'sr_1', label_en: 'Electricity', label_ar: 'التيار', label_ckb: 'تەزووی کارەبا', value_en: EN.current, value_ar: EN.current, value_ckb: EN.current, unit: '', order: 0 },
        { id: 'sr_2', label_en: 'Voltage', label_ar: 'الجهد', label_ckb: 'ڤۆڵتیە', value_en: '24V', value_ar: '24V', value_ckb: '24V', unit: '', order: 1 },
      ],
    },
  ];
  const meta = {
    description: imported,
    'usage_step:us_1:title': imported,
    'usage_step:us_1:body': imported,
    'block:cb_1:body': imported,
    'spec:sg_bambu_official:sr_1:value': imported,
    'spec:sg_bambu_official:sr_2:value': imported,
    how_to_use: { ar: { status: 'approved', src_rev: 1 }, ckb: { status: 'approved', src_rev: 1 } },
  };
  raw
    .prepare(
      `UPDATE products SET description = ?, description_ar = ?, description_ku = ?, usage_guide = ?, content_blocks = ?, specifications = ?,
              how_to_use = ?, how_to_use_ar = ?, how_to_use_ckb = ?, translation_meta = ? WHERE id = ?`
    )
    .run(description, description, description, JSON.stringify(guide), JSON.stringify(blocks), JSON.stringify(groups), EN.howTo, 'نص كتبه المالك.', 'دەقێک کە خاوەنەکە نووسیویەتی.', JSON.stringify(meta), P.H2D);
  raw.exec(`
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('g_t_col', '${P.H2D}', 'Color', 0, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active) VALUES ('v_t_black', '${P.H2D}', 'g_t_col', 'Black', 'Black', 'Black', 0, 1);
    INSERT INTO product_documents (id, product_id, kind, title_en, title_ar, title_ckb, url, host, active, sort) VALUES
      ('doc_t_qs', '${P.H2D}', 'manual', '${EN.doc}', 'دليل — ${EN.doc}', 'ڕێبەر — ${EN.doc}', 'https://store.bblcdn.com/s1/qs.pdf', 'store.bblcdn.com', 1, 0);
  `);
  insertSpecValue(raw, P.H2D, 'electrical.current', { value_text: EN.current, sort: 1 });
  insertSpecValue(raw, P.H2D, 'part.color', { value_text: EN.gray, sort: 2 });
  insertSpecValue(raw, P.H2D, 'electrical.voltage', { value_text: '24V', sort: 3 });
  insertSpecValue(raw, P.H2D, 'x.cable-pitch', { original_label: EN.label, value_text: '3mm', group_key: 'other', sort: 4 });
  insertSpecValue(raw, P.H2D, 'printing.supported_filament', { data_type: 'list', value_text: 'Gray, PLA', value_list: JSON.stringify([EN.gray, 'PLA']), sort: 5 });
  insertSpecValue(raw, P.H2D, 'package.contents', { data_type: 'list', value_list: JSON.stringify([{ text: EN.box, qty: 1 }, 'Screw kit']), sort: 6 });
  if (!memory) return;
  const ins = raw.prepare('INSERT INTO catalog_translations (h, en, ar, ckb, kind, status, part) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const ref = raw.prepare('INSERT INTO catalog_translation_refs (product_id, h) VALUES (?, ?)');
  for (const [en, ar, ckb, status] of TM) {
    ins.run(sourceHash(en), en, ar, ckb, 'short_description', status, 'p001');
    ref.run(P.H2D, sourceHash(en));
  }
}

const tr = (en: string, lang: 'ar' | 'ckb') => {
  const row = TM.find((r) => r[0] === en)!;
  return lang === 'ar' ? row[1] : row[2];
};

type Rec = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function page(raw: DatabaseSync, opts: { priced?: boolean; db?: D1Database } = {}): Promise<{ status: number; text: string; body: Rec }> {
  const app = stubApp(opts.db ?? asD1(raw), null, (a) => a.route('/api/products', productRoutes), { publishV2: opts.priced ? 'always' : false });
  const res = await get(app, `/api/products/${H2D.slug}`);
  const text = await res.text();
  return { status: res.status, text, body: res.status === 200 ? JSON.parse(text) : {} };
}

async function knowledgeOf(raw: DatabaseSync, db?: D1Database): Promise<{ status: number; text: string; body: Rec }> {
  const app = stubApp(db ?? asD1(raw), null, (a) => a.route('/api/products', productRoutes), { publishV2: false });
  const res = await get(app, `/api/products/${H2D.slug}/knowledge`);
  const text = await res.text();
  return { status: res.status, text, body: res.status === 200 ? JSON.parse(text) : {} };
}

function assertPageTranslated(product: Rec, label: string): void {
  assert.equal(product.description_en, `${EN.desc1}\n${EN.desc2}`, `${label}: the English source is untouched`);
  assert.equal(product.description_ar, `${tr(EN.desc1, 'ar')}\n${EN.desc2}`, `${label}: line by line, a line without a translation stays English`);
  assert.equal(product.description_ckb, `${tr(EN.desc1, 'ckb')}\n${EN.desc2}`);
  const step = product.usage_guide.steps[0];
  assert.equal(step.title_ar, tr(EN.title, 'ar'));
  assert.equal(step.title_ckb, tr(EN.title, 'ckb'));
  assert.equal(step.body_ar, `• ${tr(EN.body1, 'ar')}\n• ${EN.body2}`, 'the bullet is kept');
  assert.equal(step.body_ckb, `• ${tr(EN.body1, 'ckb')}\n• ${EN.body2}`);
  const block = product.content_blocks[0];
  assert.equal(block.body_ar, `${tr(EN.heading, 'ar')}\n${tr(EN.cell, 'ar')} | 50 g | ${tr(EN.gray, 'ar')}\n${EN.pending}`, 'cells; a needs_review row is never shown');
  assert.equal(block.body_ckb, `${tr(EN.heading, 'ckb')}\n${tr(EN.cell, 'ckb')} | 50 g | ${tr(EN.gray, 'ckb')}\n${EN.pending}`);
  const rows = product.spec_groups.find((g: Rec) => g.id === 'sg_bambu_official').rows;
  assert.equal(rows[0].value_ar, tr(EN.current, 'ar'));
  assert.equal(rows[0].value_ckb, tr(EN.current, 'ckb'));
  assert.equal(rows[1].value_ar, '24V', 'a value without a row is left as it was');
  assert.equal(rows[0].label_ar, 'التيار', 'labels are never the overlay\'s');
  assert.equal(product.how_to_use_ar, 'نص كتبه المالك.', `${label}: a slot a human approved keeps the human's text`);
  assert.equal(product.how_to_use_ckb, 'دەقێک کە خاوەنەکە نووسیویەتی.');
  assert.notEqual(product.name_ar, 'اسم مترجم', 'the name is never translated');
  assert.notEqual(product.name_ckb, 'ناوی وەرگێڕدراو');
  assert.equal(product.name_en, H2D.name);
  for (const o of product.options ?? []) assert.notEqual(o.name_ar, 'أسود', 'an option name is never translated');
  for (const [a, k] of [
    [product.description_ar, product.description_ckb],
    [step.title_ar, step.title_ckb],
    [block.body_ar, block.body_ckb],
    [rows[0].value_ar, rows[0].value_ckb],
  ])
    assert.notEqual(a, k, 'a Sorani slot never copies the Arabic (row 183)');
  if ('description_ku' in product) assert.equal(product.description_ku, product.description_ckb, 'the legacy alias follows');
  const legacy = (product.specifications as Rec[]).find((s) => s.key === 'التيار');
  if (legacy) assert.equal(legacy.value, tr(EN.current, 'ar'));
}

test('the page body of an imported product: line by line in Arabic and Sorani — catalog-only and priced', async () => {
  const raw = freshDb();
  seedLiveCatalog(raw);
  seedImported(raw);
  const only = await page(raw);
  assert.equal(only.status, 200, only.text);
  assert.equal(only.body.price_status, 'unpriced');
  assertPageTranslated(only.body.product, 'catalog-only');
  const priced = await page(raw, { priced: true });
  assert.equal(priced.status, 200, priced.text);
  assert.equal(priced.body.price_status, 'priced');
  assertPageTranslated(priced.body.product, 'priced');
  assert.ok(!priced.text.includes('catalog_translation') && !priced.text.includes('"part"'), 'no memory bookkeeping reaches a customer');
});

test('public API v1 carries the same Arabic and Sorani: description, usage guide, content, specifications', async () => {
  const raw = freshDb();
  seedLiveCatalog(raw);
  seedImported(raw);
  const env = { DB: asD1(raw), STORE_ROOT_DOMAIN: APEX, APP_ORIGIN: `https://${APEX}`, INITIAL_ADMIN_EMAIL: 'boss@x.co', EXTRA_ALLOWED_ORIGINS: '', ASSETS: { fetch: async () => new Response('spa') } };
  const res = await fetchPublished(
    worker,
    new Request(`https://${APEX}/api/public/v1/products/${H2D.slug}`, { headers: { Host: APEX, 'CF-Connecting-IP': '203.0.113.9' } }),
    env as never,
    ctx
  );
  const text = await res.text();
  assert.equal(res.status, 200, text);
  const d = JSON.parse(text).data;
  assert.equal(d.description.ar, `${tr(EN.desc1, 'ar')}\n${EN.desc2}`);
  assert.equal(d.description.ckb, `${tr(EN.desc1, 'ckb')}\n${EN.desc2}`);
  assert.equal(d.usage_guide.steps[0].title.ar, tr(EN.title, 'ar'));
  assert.equal(d.content[0].text.ckb.split('\n')[0], tr(EN.heading, 'ckb'));
  const row = d.specifications.flatMap((g: Rec) => g.rows).find((r: Rec) => r.value.en === EN.current);
  assert.equal(row.value.ar, tr(EN.current, 'ar'));
  assert.notEqual(d.name.ar, 'اسم مترجم');
});

test('the knowledge answer: value_i18n, items_i18n, label_i18n, text_i18n and a document title from the memory', async () => {
  const raw = freshDb();
  seedLiveCatalog(raw);
  seedImported(raw);
  const k = await knowledgeOf(raw);
  assert.equal(k.status, 200, k.text);
  const rows: Rec[] = k.body.specs.flatMap((g: Rec) => g.rows);
  const current = rows.find((r) => r.key === 'electrical.current')!;
  assert.deepEqual(current.value_i18n, { ar: tr(EN.current, 'ar'), ckb: tr(EN.current, 'ckb') });
  assert.equal(current.value_text, EN.current, 'the English stays beside it');
  assert.equal(rows.find((r) => r.key === 'electrical.voltage')!.value_i18n, undefined, 'no row, no field');
  const list = rows.find((r) => r.key === 'printing.supported_filament')!;
  assert.deepEqual(list.items_i18n, [{ ar: tr(EN.gray, 'ar'), ckb: tr(EN.gray, 'ckb') }, null]);
  const x = rows.find((r) => r.key === 'x.cable-pitch')!;
  assert.deepEqual(x.label_i18n, { ar: tr(EN.label, 'ar'), ckb: tr(EN.label, 'ckb') });
  assert.equal(current.label_i18n, undefined, 'a registry label is authored, never the memory\'s');
  const box: Rec[] = k.body.in_the_box;
  assert.deepEqual(box.find((b) => b.text === EN.box)!.text_i18n, { ar: tr(EN.box, 'ar'), ckb: tr(EN.box, 'ckb') });
  assert.equal(box.find((b) => b.text === 'Screw kit')!.text_i18n, undefined);
  const doc = k.body.documents.find((d: Rec) => d.title.en === EN.doc);
  assert.deepEqual(doc.title, { ar: tr(EN.doc, 'ar'), en: EN.doc, ckb: tr(EN.doc, 'ckb') });
});

test('the comparison: a knowledge cell carries the memory, and the memory wins over the dictionary', () => {
  const tm = new Map([[EN.gray, { ar: 'رمادي فاتح (الذاكرة)', ckb: 'خۆڵەمێشی کاڵ (بیرگە)' }]]);
  const facts = [
    { canonical_key: 'printing.build_volume', scope_kind: 'product', scope_id: '', region: '', value_text: EN.gray, value_num: null, value_num_max: null, unit: '', status: 'verified', test_method: '' },
  ];
  const cells = knowledgeCellsFor(facts, null, tm);
  assert.deepEqual(cells.build_volume.i18n, { ar: 'رمادي فاتح (الذاكرة)', ckb: 'خۆڵەمێشی کاڵ (بیرگە)' });
  assert.equal(knowledgeCellsFor(facts, null).build_volume.i18n, undefined, 'no memory, no field');
  const cell = (i18n?: { ar: string; ckb: string }): KnowledgeCell => ({ key: 'x.motion', status: 'verified', text: EN.gray, num: null, num_max: null, unit: '', test_method: '', ...(i18n ? { i18n } : {}) });
  const run = (c: KnowledgeCell) =>
    compareProducts({
      products: [
        { id: 'a', product_type: 'printer', section_slugs: ['printers', 'fdm-printers'], spec_fields: {}, price_iqd: null, knowledge: { motion_system: c } },
        { id: 'b', product_type: 'printer', section_slugs: ['printers', 'fdm-printers'], spec_fields: { motion_system: 'CoreXY' }, price_iqd: null },
      ],
    });
  const valueOf = (r: ReturnType<typeof compareProducts>) => r.groups.flatMap((g) => g.rows).find((x) => x.field_id === 'motion_system')!.values[0];
  assert.deepEqual(valueOf(run(cell(tm.get(EN.gray)))).i18n, { ar: 'رمادي فاتح (الذاكرة)', ckb: 'خۆڵەمێشی کاڵ (بیرگە)' }, 'the memory first');
  assert.notDeepEqual(valueOf(run(cell())).i18n, { ar: 'رمادي فاتح (الذاكرة)', ckb: 'خۆڵەمێشی کاڵ (بیرگە)' }, 'without it, the dictionary (or nothing)');
});

test('a database at 0195 answers byte-identical bodies to an empty memory; a failing read gives English, never a 5xx', async () => {
  const old = dbThrough('0195');
  seedLiveCatalog(old);
  seedImported(old, { memory: false });
  const empty = freshDb();
  seedLiveCatalog(empty);
  seedImported(empty, { memory: false });
  const a = await page(old);
  const b = await page(empty);
  assert.equal(a.status, 200, a.text);
  assert.equal(a.text, b.text, 'the page body without 0196 is the page body with an empty memory');
  assert.equal(a.body.product.description_ar, `${EN.desc1}\n${EN.desc2}`, 'English, as stored');
  const ka = await knowledgeOf(old);
  const kb = await knowledgeOf(empty);
  assert.equal(ka.status, 200);
  assert.equal(ka.text, kb.text, 'the knowledge answer too');
  assert.ok(!ka.text.includes('_i18n'));
  // A read that fails for another reason (a lost connection): logged, English, 200.
  const raw = freshDb();
  seedLiveCatalog(raw);
  seedImported(raw);
  const real = asD1(raw);
  const flaky = new Proxy(real, {
    get(target, key, receiver) {
      if (key === 'prepare') {
        return (sql: string) => {
          if (/catalog_translation_refs/.test(sql)) {
            const failing = { bind: () => failing, all: async () => { throw new Error('D1_ERROR: Network connection lost.'); }, first: async () => { throw new Error('D1_ERROR: Network connection lost.'); }, run: async () => { throw new Error('D1_ERROR: Network connection lost.'); } };
            return failing;
          }
          return target.prepare(sql);
        };
      }
      const v = Reflect.get(target, key, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as D1Database;
  const errors: string[] = [];
  const log = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.map(String).join(' '));
  try {
    forgetTranslationSchema(flaky);
    const p = await page(raw, { db: flaky });
    assert.equal(p.status, 200, p.text);
    assert.equal(p.body.product.description_ar, `${EN.desc1}\n${EN.desc2}`);
    const k = await knowledgeOf(raw, flaky);
    assert.equal(k.status, 200, k.text);
    assert.ok(!k.text.includes('_i18n'));
  } finally {
    console.error = log;
  }
  assert.ok(errors.some((e) => e.includes('catalog_translations_read_failed')), 'logged by name');
  assert.ok(!errors.some((e) => e.includes('Network connection lost')), 'never the error text');
});
