/**
 * THE STORE'S OWN EXPORT MUST BE IMPORTABLE.
 *
 * `GET /export/:productId` was taught to read the relational tables, so it
 * finally carried the options, colours and pictures of every product built in
 * the admin form. `POST /apply` then refused that exact file with
 * `TXT_CANNOT_WRITE_RELATIONS`, because the TXT path could only write the
 * `products` JSON mirror — which nothing reads once relational rows exist.
 * Download → edit → upload, the entire purpose of the format, was impossible
 * for exactly the products the owner works on.
 *
 * These tests drive the REAL pipeline end to end —
 *   applyRelations → exportProduct → parseTemplate → toDocBody → relationsBodyFromDoc
 * — and assert that what comes out the far end is the product that went in.
 * The last step is the wire body `planRelationsWrite` receives, so a field
 * that stops surviving here is a field the owner loses on save.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProductRow, validateProductDoc } from '../worker/lib/productModel';
import { applyRelations } from '../worker/lib/productOverlay';
import type { ProductRelationsView } from '../worker/lib/productOverlay';
import { exportProduct, parseTemplate, toDocBody } from '../worker/lib/template';
import { relationsBodyFromDoc, selectionFromComboKey } from '../worker/lib/templateRelations';

function baseRow() {
  return {
    id: 'prd_x',
    slug: 'x',
    status: 'active',
    name_ar: 'منتج',
    name_en: 'Product',
    price_iqd: 500_000,
    original_price_iqd: 650_000,
    product_cost_iqd: 300_000,
    selling_type: 'direct_sale',
    sale_types: JSON.stringify(['direct_sale']),
  };
}

/**
 * A product shaped the way the admin form stores one, including the three
 * things the old export threw away: an INACTIVE option, a colour linked to
 * TWO options, and pictures bound to an option and to a colour.
 */
function view(): ProductRelationsView {
  return {
    has_relations: true,
    inventory_mode: 'BASE',
    groups: [
      { id: 'og1', product_id: 'prd_x', name_en: 'Model', sort: 0, active: 1 },
      { id: 'og2', product_id: 'prd_x', name_en: 'Nozzle', sort: 1, active: 1 },
    ],
    values: [
      {
        id: 'ov1', product_id: 'prd_x', group_id: 'og1', name_en: 'A1', sku_part: 'A1',
        image: '/files/opt-a1.jpg', sort: 0, active: 1, stock: 5, low_stock_threshold: 2,
        regular_price_iqd: 899_000, prime_price_iqd: 885_000, pro_price_iqd: 799_000, cost_iqd: 700_000,
        regular_adjust_iqd: null, prime_adjust_iqd: null, pro_adjust_iqd: null, cost_adjust_iqd: null,
        availability_type: 'direct_sale', lead_time_text: '', lead_time_min_days: null,
        lead_time_max_days: null, variant_key: 'a1', variant_label: 'A1',
      },
      {
        id: 'ov2', product_id: 'prd_x', group_id: 'og1', name_en: 'A1 Combo', sku_part: 'A1C',
        image: '', sort: 1, active: 1, stock: null, low_stock_threshold: null,
        regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null,
        regular_adjust_iqd: 300_000, prime_adjust_iqd: null, pro_adjust_iqd: null, cost_adjust_iqd: 250_000,
        availability_type: 'pre_order', lead_time_text: '25-40 يوم', lead_time_min_days: 25,
        lead_time_max_days: 40, variant_key: 'a1-combo', variant_label: 'A1 Combo',
      },
      {
        // SWITCHED OFF. The shop must not show it; the owner must still be
        // able to see it in the file and turn it back on.
        id: 'ov3', product_id: 'prd_x', group_id: 'og2', name_en: '0.6mm', sku_part: '06',
        image: '', sort: 0, active: 0, stock: null, low_stock_threshold: null,
        regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null,
        regular_adjust_iqd: 25_000, prime_adjust_iqd: null, pro_adjust_iqd: null, cost_adjust_iqd: null,
        availability_type: '', lead_time_text: '', lead_time_min_days: null,
        lead_time_max_days: null, variant_key: '', variant_label: '',
      },
    ],
    colors: [
      {
        id: 'pc1', product_id: 'prd_x', name_en: 'Black', hex: '#000000', image: '/files/col-black.jpg',
        sort: 0, active: 1, stock: 9, low_stock_threshold: 3,
        regular_price_iqd: 5_000, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: 2_000,
        regular_adjust_iqd: null, prime_adjust_iqd: null, pro_adjust_iqd: null, cost_adjust_iqd: null,
      },
    ],
    // Available for BOTH models — the case `option_id` alone cannot express.
    links: [
      { color_id: 'pc1', option_value_id: 'ov1', group_id: 'og1' },
      { color_id: 'pc1', option_value_id: 'ov2', group_id: 'og1' },
    ],
    variants: [
      {
        id: 'pv1', product_id: 'prd_x', combo_key: 'o:ov1|c:pc1', sku: 'A1-BLK', active: 1,
        stock: 3, reserved: 0, low_stock_threshold: null,
        regular_price_iqd: 910_000, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: 705_000,
      },
    ],
    images: [
      { id: 'im1', product_id: 'prd_x', url: '/files/a.jpg', alt_en: 'front', alt_ar: 'أمام',
        alt_ckb: '', r2_key: 'products/a.jpg', source_url: 'https://vendor.example/a.jpg',
        sort_order: 0, is_primary: 1, option_value_id: null, color_id: null, variant_id: null,
        width: 1200, height: 900 },
      { id: 'im2', product_id: 'prd_x', url: '/files/b.jpg', alt_en: 'A1 only', alt_ar: '',
        alt_ckb: '', r2_key: '', source_url: '',
        sort_order: 1, is_primary: 0, option_value_id: 'ov1', color_id: null, variant_id: null,
        width: null, height: null },
      { id: 'im3', product_id: 'prd_x', url: '/files/c.jpg', alt_en: 'black', alt_ar: '',
        alt_ckb: '', r2_key: '', source_url: '',
        sort_order: 2, is_primary: 0, option_value_id: null, color_id: 'pc1', variant_id: null,
        width: null, height: null },
    ],
  } as unknown as ProductRelationsView;
}

/** The whole journey, exactly as the two routes run it. */
function roundTrip() {
  const doc = applyRelations(parseProductRow(baseRow()), view(), { includeInactive: true });
  const text = exportProduct(doc, { includeCost: true, brand: null, catalogs: [] });
  const parsed = parseTemplate(text);
  assert.deepEqual(parsed.errors, [], 'the store\'s own export must parse without errors');
  // Exactly the sequence POST /apply runs: merge onto the existing doc, then
  // validate into a real ProductDoc, then translate for the relations writer.
  const merged = toDocBody(parsed, doc, { needs_review: [] });
  const built = validateProductDoc(merged.body);
  return { doc, text, parsed, merged, built, body: relationsBodyFromDoc(built, view()) };
}

// -------------------------------------------------------------- the journey

test('the export parses back with no errors and no unknown keys', () => {
  const { parsed } = roundTrip();
  assert.deepEqual(parsed.errors, []);
  // An unrecognised key is reported as an ERROR by parseTemplate, so an empty
  // error list already proves the exporter writes nothing the parser rejects.
  assert.equal(parsed.errors.length, 0);
});

test('the option GROUPS survive — «1 مجموعة · 4 قيمة» is not flattened', () => {
  const { body } = roundTrip();
  const groups = body.groups as Array<{ name_en: string; values: unknown[] }>;
  assert.equal(groups.length, 2, 'two groups went in, two must come out');
  assert.deepEqual(groups.map((g) => g.name_en), ['Model', 'Nozzle']);
  assert.equal(groups[0].values.length, 2);
  assert.equal(groups[1].values.length, 1);
});

test('a switched-off option comes back switched off, not deleted and not re-enabled', () => {
  const { text, body } = roundTrip();
  assert.match(text, /options\.3\.active=false/, 'the file must SHOW the disabled option');
  const groups = body.groups as Array<{ values: Array<{ id: string; active: boolean }> }>;
  const all = groups.flatMap((g) => g.values);
  assert.equal(all.length, 3, 'the inactive option must not be dropped on the way back');
  assert.equal(all.find((v) => v.id === 'ov3')?.active, false);
});

test('every price, membership price, adjustment and cost survives the trip', () => {
  const { body } = roundTrip();
  const groups = body.groups as Array<{ values: Array<Record<string, unknown>> }>;
  const a1 = groups.flatMap((g) => g.values).find((v) => v.id === 'ov1')!;
  assert.equal(a1.regular_price_iqd, 899_000);
  assert.equal(a1.prime_price_iqd, 885_000);
  assert.equal(a1.pro_price_iqd, 799_000);
  assert.equal(a1.cost_iqd, 700_000);
  const combo = groups.flatMap((g) => g.values).find((v) => v.id === 'ov2')!;
  assert.equal(combo.regular_price_iqd, null, 'an inheriting row must stay inheriting');
  assert.equal(combo.regular_adjust_iqd, 300_000, 'the adjustment is what makes it follow the base');
  assert.equal(combo.cost_adjust_iqd, 250_000);
});

test('the colour keeps its own price, its cost, its stock and BOTH its links', () => {
  const { body } = roundTrip();
  const colors = body.colors as Array<Record<string, unknown>>;
  assert.equal(colors.length, 1);
  assert.equal(colors[0].regular_price_iqd, 5_000);
  assert.equal(colors[0].cost_iqd, 2_000);
  assert.equal(colors[0].stock, 9);
  assert.equal(colors[0].low_stock_threshold, 3);
  assert.deepEqual(colors[0].option_value_ids, ['ov1', 'ov2'], 'a two-option colour must not become available-to-all');
});

test('the option-bound and colour-bound pictures stay bound', () => {
  const { text, body } = roundTrip();
  assert.match(text, /images\.2\.option_value_id=ov1/);
  assert.match(text, /images\.3\.color_id=pc1/);
  const images = body.images as Array<Record<string, unknown>>;
  assert.equal(images.length, 3);
  assert.equal(images.find((i) => i.id === 'im2')?.option_value_id, 'ov1');
  assert.equal(images.find((i) => i.id === 'im3')?.color_id, 'pc1');
  assert.equal(images.find((i) => i.id === 'im1')?.is_primary, true);
});

test('an image keeps its size, its R2 key, its source and its per-language alt text', () => {
  const { body } = roundTrip();
  const im1 = (body.images as Array<Record<string, unknown>>).find((i) => i.id === 'im1')!;
  assert.equal(im1.width, 1200);
  assert.equal(im1.height, 900);
  assert.equal(im1.r2_key, 'products/a.jpg');
  assert.equal(im1.source_url, 'https://vendor.example/a.jpg');
  assert.equal(im1.alt_ar, 'أمام', 'the Arabic alt is its own text, not a copy of the English one');
  assert.equal(im1.alt_en, 'front');
});

test('the modelled combination is carried through untouched — a text edit never deletes it', () => {
  const { body } = roundTrip();
  const variants = body.variants as Array<Record<string, unknown>>;
  assert.equal(variants.length, 1, 'the TXT has no key for a combination; it must still survive');
  assert.deepEqual(variants[0].option_value_ids, ['ov1']);
  assert.equal(variants[0].color_id, 'pc1');
  assert.equal(variants[0].regular_price_iqd, 910_000);
  assert.equal(variants[0].sku, 'A1-BLK');
});

test('the compare-at price makes the round trip', () => {
  const { text, built } = roundTrip();
  assert.match(text, /original_price_iqd=650000/);
  assert.equal(built.original_price_iqd, 650_000);
});

test('an id-less row the owner appended by hand is created, not rejected', () => {
  const { text } = roundTrip();
  const edited = `${text}\ncolors.2.name_ar=أحمر\ncolors.2.name_en=Red\ncolors.2.hex=#ff0000\n`;
  const parsed = parseTemplate(edited);
  assert.deepEqual(parsed.errors, []);
  const doc = applyRelations(parseProductRow(baseRow()), view(), { includeInactive: true });
  const built = validateProductDoc(toDocBody(parsed, doc, { needs_review: [] }).body);
  const body = relationsBodyFromDoc(built, view());
  const colors = body.colors as Array<Record<string, unknown>>;
  assert.equal(colors.length, 2);
  assert.equal(colors[1].name_en, 'Red');
  assert.equal(colors[1].hex, '#ff0000');
});

// ------------------------------------------------------------- combo keys

test('a combination key decomposes into exactly the selection that built it', () => {
  assert.deepEqual(selectionFromComboKey('o:ov1|o:ov9|c:pc1'), {
    option_value_ids: ['ov1', 'ov9'],
    color_id: 'pc1',
  });
  assert.deepEqual(selectionFromComboKey('c:pc1'), { option_value_ids: [], color_id: 'pc1' });
  assert.deepEqual(selectionFromComboKey(''), { option_value_ids: [], color_id: null });
});

test('deleting an item\'s lines PRESERVES it — an omitted key is never a deletion', () => {
  // Worth pinning because it is the opposite of what an owner expects from a
  // text file. The format says so in its own header: «الحقول المحذوفة من الملف
  // تحافظ على قيمتها الحالية». Removing an option needs `options=__CLEAR__`.
  const doc = applyRelations(parseProductRow(baseRow()), view(), { includeInactive: true });
  const text = exportProduct(doc, { includeCost: true, brand: null, catalogs: [] });
  const edited = text.split('\n').filter((l) => !l.startsWith('options.1.')).join('\n');
  const built = validateProductDoc(toDocBody(parseTemplate(edited), doc, { needs_review: [] }).body);
  assert.ok(built.options.some((o) => o.id === 'ov1'), 'the option survives being left out');
});

test('clearing the options group drops the combination that depended on it', () => {
  const doc = applyRelations(parseProductRow(baseRow()), view(), { includeInactive: true });
  const text = exportProduct(doc, { includeCost: true, brand: null, catalogs: [] });
  const edited = `${text
    .split('\n')
    .filter((l) => !l.startsWith('options.'))
    .join('\n')}\noptions=__CLEAR__\n`;
  const parsed = parseTemplate(edited);
  assert.deepEqual(parsed.errors, []);
  const built = validateProductDoc(toDocBody(parsed, doc, { needs_review: [] }).body);
  assert.equal(built.options.length, 0);
  const body = relationsBodyFromDoc(built, view());
  assert.equal(
    (body.variants as unknown[]).length,
    0,
    'a combination naming an option that no longer exists would be refused by the writer'
  );
});

// ------------------------------------------- what the file could not say

test('the section pair, SKU, template family, low-stock and direct premium round-trip', () => {
  const doc = applyRelations(
    parseProductRow({
      ...baseRow(),
      sku: 'BL-A1-001',
      template_family: 'devices',
      low_stock_threshold: 3,
      direct_surcharge_iqd: 50_000,
      category_id: 'cat_printers',
      sub_category_id: 'cat_fdm',
    }),
    view(),
    { includeInactive: true }
  );
  const text = exportProduct(doc, {
    includeCost: true,
    brand: 'bambu-lab',
    catalogs: ['printers'],
    category: 'printers',
    subCategory: 'fdm',
  });
  for (const line of [
    'category=printers',
    'sub_category=fdm',
    'template_family=devices',
    'sku=BL-A1-001',
    'low_stock_threshold=3',
    'direct_surcharge_iqd=50000',
  ]) {
    assert.ok(text.includes(`${line}\n`), `the export must carry ${line}`);
  }
  const parsed = parseTemplate(text);
  assert.deepEqual(parsed.errors, []);
  const built = validateProductDoc(
    toDocBody(parsed, doc, {
      needs_review: [],
      category_id: 'cat_printers',
      sub_category_id: 'cat_fdm',
    }).body
  );
  assert.equal(built.sku, 'BL-A1-001');
  assert.equal(built.template_family, 'devices');
  assert.equal(built.low_stock_threshold, 3);
  assert.equal(built.direct_surcharge_iqd, 50_000);
  assert.equal(built.category_id, 'cat_printers');
  assert.equal(built.sub_category_id, 'cat_fdm');
});

test('an unknown section is sent to review, never silently created or dropped', () => {
  const doc = applyRelations(parseProductRow(baseRow()), view(), { includeInactive: true });
  // Replace, not append: a second `category=` line would be a duplicate key.
  const text = exportProduct(doc, { includeCost: true }).replace(
    /^category=.*$/m,
    'category=no-such-section'
  );
  const parsed = parseTemplate(text);
  // The route resolves refs; with nothing resolved the merge must ASK rather
  // than guess — the same rule brands have always followed.
  const merged = toDocBody(parsed, doc, { needs_review: [] });
  assert.ok(merged.needs_review.some((n) => n.key === 'category'));
});

test('the §10 spec sheet is written field by field and read back', () => {
  const doc = applyRelations(
    parseProductRow({ ...baseRow(), template_family: 'devices', spec_fields: JSON.stringify({ weight: '8.5', nozzle: '0.4' }) }),
    view(),
    { includeInactive: true }
  );
  const text = exportProduct(doc, {
    includeCost: true,
    // What the route passes: every field this family declares, in form order.
    specFieldIds: ['technology', 'build_volume', 'nozzle', 'weight', 'in_the_box'],
  });
  assert.ok(text.includes('spec.weight=8.5\n'), 'a filled spec is written with its value');
  assert.ok(text.includes('spec.nozzle=0.4\n'));
  assert.ok(text.includes('spec.build_volume=\n'), 'an EMPTY declared spec is still listed, waiting to be typed');
  assert.ok(text.includes('spec.in_the_box=\n'));

  const edited = text.replace('spec.build_volume=\n', 'spec.build_volume=256 x 256 x 256\n');
  const parsed = parseTemplate(edited);
  assert.deepEqual(parsed.errors, []);
  const built = validateProductDoc(toDocBody(parsed, doc, { needs_review: [] }).body);
  assert.equal(built.spec_fields.build_volume, '256 x 256 x 256');
  assert.equal(built.spec_fields.weight, '8.5', 'the specs already set are not lost');
});

test('a spec the file leaves out is preserved; __CLEAR__ removes it', () => {
  const doc = applyRelations(
    parseProductRow({ ...baseRow(), spec_fields: JSON.stringify({ weight: '8.5', nozzle: '0.4' }) }),
    view(),
    { includeInactive: true }
  );
  const only = `template_version=2\nproduct_id=prd_x\nname_ar=منتج\nprice_iqd=500000\nspec.nozzle=__CLEAR__\n`;
  const built = validateProductDoc(toDocBody(parseTemplate(only), doc, { needs_review: [] }).body);
  assert.equal(built.spec_fields.weight, '8.5');
  assert.equal(built.spec_fields.nozzle, undefined);
});

// ------------------------------------------ the number actually charged

test('an inheriting price is annotated with what the customer really pays', () => {
  const doc = applyRelations(parseProductRow(baseRow()), view(), { includeInactive: true });
  const text = exportProduct(doc, { includeCost: true });
  // options.2 inherits its regular price and carries a +300,000 adjustment,
  // so the file must say 500,000 + 300,000 rather than only "__NULL__".
  assert.match(text, /options\.2\.regular_price_iqd=__NULL__\n#\s+↳ السعر الاعتيادي الفعلي: 800,000 د\.ع — فرق \+300,000 عن 500,000/);
});

test('the annotation is a COMMENT — re-parsing the annotated file is identical', () => {
  const doc = applyRelations(parseProductRow(baseRow()), view(), { includeInactive: true });
  const withNotes = exportProduct(doc, { includeCost: true });
  const withoutNotes = exportProduct(doc, { includeCost: true, showEffective: false });
  assert.notEqual(withNotes, withoutNotes, 'the annotations must actually be there');
  const a = validateProductDoc(toDocBody(parseTemplate(withNotes), doc, { needs_review: [] }).body);
  const b = validateProductDoc(toDocBody(parseTemplate(withoutNotes), doc, { needs_review: [] }).body);
  assert.deepEqual(a, b, 'a comment can never change what a file means');
});

test('a row that states its own price is not told what its own price is', () => {
  const doc = applyRelations(parseProductRow(baseRow()), view(), { includeInactive: true });
  const text = exportProduct(doc, { includeCost: true });
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l === 'options.1.regular_price_iqd=899000');
  assert.ok(i > 0, 'options.1 states its own regular price');
  assert.ok(!lines[i + 1].startsWith('#   ↳'), 'a fixed price needs no annotation');
});

test('an assistant admin sees no cost, and no cost annotation either', () => {
  const doc = applyRelations(parseProductRow(baseRow()), view(), { includeInactive: true });
  const text = exportProduct(doc, { includeCost: false });
  assert.ok(!text.includes('cost_iqd='), 'no cost key');
  assert.ok(!text.includes('الكلفة الفعلية'), 'and no cost smuggled into a comment');
});

// --------------------------------------------------- shipping / transports

test('all three pre-order routes are listed even when the product declares none', () => {
  const doc = applyRelations(parseProductRow(baseRow()), view(), { includeInactive: true });
  assert.equal(doc.preorder_transports.length, 0, 'this product has no transport rows');
  const text = exportProduct(doc, { includeCost: true });
  for (const m of ['air', 'sea', 'land']) {
    assert.ok(text.includes(`.method=${m}\n`), `${m} must be listed so it can be switched on`);
  }
  assert.match(text, /transports\.1\.active=false/);
});

test('an inheriting transport commission names the admin default', () => {
  const doc = applyRelations(
    parseProductRow({
      ...baseRow(),
      preorder_transports: JSON.stringify([{ method: 'air', commission_iqd: null, active: true }]),
    }),
    view(),
    { includeInactive: true }
  );
  const text = exportProduct(doc, {
    includeCost: true,
    transportDefaults: [{ method: 'air', commission_iqd: 250_000 }],
  });
  assert.match(text, /transports\.1\.commission_iqd=__NULL__\n#\s+↳ العمولة الفعلية 250,000 د\.ع/);
});

test('an unconfigured transport default says so rather than inventing a number', () => {
  const doc = applyRelations(
    parseProductRow({
      ...baseRow(),
      preorder_transports: JSON.stringify([{ method: 'land', commission_iqd: null, active: true }]),
    }),
    view(),
    { includeInactive: true }
  );
  const text = exportProduct(doc, {
    includeCost: true,
    transportDefaults: [{ method: 'land', commission_iqd: null }],
  });
  assert.match(text, /غير مضبوط/);
  assert.ok(!/العمولة الفعلية \d/.test(text), 'no fabricated commission');
});
