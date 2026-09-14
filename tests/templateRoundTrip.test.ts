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

test('TXT export/import preserves product delivery rules and partial edits merge safely', () => {
  const doc = parseProductRow({
    ...baseRow(),
    ops_policy: JSON.stringify({
      delivery_options: {
        standard: { enabled: true, quantity_step: 10, fee_iqd: 5000 },
        personal: { enabled: true, quantity_step: 1, fee_iqd: 50000 },
      },
    }),
  });
  const exported = exportProduct(doc);
  assert.match(exported, /^standard_delivery_quantity_step=10$/m);
  assert.match(exported, /^personal_delivery_fee_iqd=50000$/m);
  const roundTrip = validateProductDoc(toDocBody(parseTemplate(exported), doc, { needs_review: [] }).body);
  assert.deepEqual(roundTrip.delivery_options, doc.delivery_options);

  const partial = parseTemplate('template_version=2\nstandard_delivery_fee_iqd=7000\n');
  const edited = validateProductDoc(toDocBody(partial, doc, { needs_review: [] }).body);
  assert.deepEqual(edited.delivery_options, {
    standard: { enabled: true, quantity_step: 10, fee_iqd: 7000 },
    personal: { enabled: true, quantity_step: 1, fee_iqd: 50000 },
  });
});

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
        availability_type: '', lead_time_text: '', lead_time_min_days: null,
        lead_time_max_days: null, variant_key: 'a1', variant_label: 'A1',
      },
      {
        id: 'ov2', product_id: 'prd_x', group_id: 'og1', name_en: 'A1 Combo', sku_part: 'A1C',
        image: '', sort: 1, active: 1, stock: null, low_stock_threshold: null,
        regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null,
        regular_adjust_iqd: 300_000, prime_adjust_iqd: null, pro_adjust_iqd: null, cost_adjust_iqd: 250_000,
        availability_type: '', lead_time_text: '25-40 يوم', lead_time_min_days: 25,
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
        // +5,000 over whichever model is picked — the owner's surcharge form.
        regular_price_iqd: null, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: 2_000,
        regular_adjust_iqd: 5_000, prime_adjust_iqd: null, pro_adjust_iqd: null, cost_adjust_iqd: null,
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
  // An unrecognised key is a WARNING, not an error — parseTemplate collects it
  // in unknown_keys and carries on. So asserting on errors alone would let the
  // exporter start writing keys the parser silently ignores; this is the
  // assertion that actually catches that.
  assert.deepEqual(parsed.unknown_keys, []);
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
  // THE OWNER'S FORM. A1 was stored as a FIXED 899,000; the file writes it as
  // what it is relative to the 500,000 base — +399,000 — and that is what
  // comes back. Same price at checkout; see tests/cheapestBase.test.ts.
  assert.equal(a1.regular_price_iqd, null);
  assert.equal(a1.regular_adjust_iqd, 399_000);
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
  assert.equal(colors[0].regular_price_iqd, null);
  assert.equal(colors[0].regular_adjust_iqd, 5_000, 'the +5,000 surcharge over the chosen model');
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

test('an inheriting price is annotated with the number the ladder resolves', () => {
  const doc = applyRelations(parseProductRow(baseRow()), view(), { includeInactive: true });
  const text = exportProduct(doc, { includeCost: true });
  // options.2 inherits its regular price and carries a +300,000 adjustment,
  // so the file must say 500,000 + 300,000 rather than only "__NULL__".
  assert.match(
    text,
    /options\.2\.regular_price_iqd=__NULL__\n#\s+↳ السعر الاعتيادي الفعلي للصنف: 800,000 د\.ع — فرق \+300,000 عن 500,000/
  );
});

test('a member price is never annotated above the regular price of its own row', () => {
  // A clearance option — regular adjusted down below the inherited PRO price.
  // The member ladder follows the regular one, so the reduction swallows the
  // PRO price (400,000 − 450,000 < 0): the member pays the reduced regular
  // and the file must not annotate a PRO number at all, let alone one above
  // the row's own 50,000.
  const v = view();
  const vals = v.values as unknown as Array<Record<string, unknown>>;
  vals[1].regular_adjust_iqd = -450_000; // 500,000 - 450,000 = 50,000
  const doc = applyRelations(
    parseProductRow({ ...baseRow(), pro_price_iqd: 400_000, prime_price_iqd: 450_000 }),
    v,
    { includeInactive: true }
  );
  const text = exportProduct(doc, { includeCost: true });
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === 'options.2.id=ov2');
  const end = lines.findIndex((l, i) => i > start && /^options\.3\.id=/.test(l));
  const block = lines.slice(start, end);
  assert.ok(block.some((l) => l.includes('السعر الاعتيادي الفعلي للصنف: 50,000')), 'the reduced regular is annotated');
  for (const l of block.filter((l) => /سعر (PRO|PRIME) الفعلي/.test(l))) {
    const n = Number((l.match(/: ([\d,]+) د/) ?? [])[1]?.replace(/,/g, '') ?? '0');
    assert.ok(n <= 50_000, `a member note above the row's regular: ${l}`);
  }
});

test('an inheriting colour on a product whose options differ says so instead of naming a price', () => {
  // buildGrid resolves an unlinked colour from the BASE price; the resolver
  // walks base → the option the customer picked → the colour. One number
  // would be right only when the base-priced option is chosen.
  const doc = applyRelations(
    parseProductRow({ ...baseRow(), pro_price_iqd: 450_000, prime_price_iqd: 480_000 }),
    view(),
    { includeInactive: true }
  );
  const text = exportProduct(doc, { includeCost: true });
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => l.startsWith('colors.1.pro_price_iqd='));
  assert.ok(idx > 0, 'the colour inherits its PRO price');
  assert.match(lines[idx + 1], /يتبع الخيار الذي يختاره الزبون/);
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

test('a row that must keep a fixed price is written as a number and told WHY, not what it costs', () => {
  // A colour on two models that price differently has no single increase
  // that is right for both, so its fixed price stays — and the comment beside
  // it explains that instead of restating the number above it.
  const v = view();
  const cols = v.colors as unknown as Array<Record<string, unknown>>;
  cols[0].regular_price_iqd = 905_000;
  cols[0].regular_adjust_iqd = null;
  const doc = applyRelations(parseProductRow(baseRow()), v, { includeInactive: true });
  const text = exportProduct(doc, { includeCost: true });
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l === 'colors.1.regular_price_iqd=905000');
  assert.ok(i > 0, 'the colour states its own regular price');
  assert.match(lines[i + 1], /أُبقي سعر اللون/, 'the reason it stayed fixed');
  assert.ok(!lines[i + 1].includes('الفعلي'), 'a fixed price is not told what its own price is');
});

// ------------------------------------------- the owner's form: one price, then surcharges

test('the export writes the cheapest sellable price as the base and every option as an increase', () => {
  // Stored: base 500,000; A1 FIXED at 899,000; A1 Combo +300,000; a switched-off
  // nozzle +25,000. The base is already the cheapest sellable line, so it
  // stays; the fixed A1 becomes +399,000, and the file says what it did.
  const doc = applyRelations(parseProductRow(baseRow()), view(), { includeInactive: true });
  const text = exportProduct(doc, { includeCost: true });
  assert.match(text, /^price_iqd=500000\n#\s+↳ أرخص صنف قابل للبيع/m);
  assert.match(text, /^options\.1\.regular_price_iqd=__NULL__\n#\s+↳ السعر الاعتيادي الفعلي للصنف: 899,000 د\.ع — فرق \+399,000 عن 500,000/m);
  assert.match(text, /^options\.1\.regular_adjust_iqd=399000$/m);
  assert.match(text, /أسعار ثابتة للخيارات\/الألوان في المخزن تظهر هنا كزيادات/, 'the file says the stored form differed');
  // Re-importing stores exactly this: once the product is in the owner's
  // form, export → import → export changes nothing at all. (The first export
  // also carries the "stored form differed" note and the selling type the
  // options imply, which is why the comparison starts from the second.)
  const built1 = validateProductDoc(toDocBody(parseTemplate(text), doc, { needs_review: [] }).body);
  const text2 = exportProduct(built1, { includeCost: true });
  const built2 = validateProductDoc(toDocBody(parseTemplate(text2), built1, { needs_review: [] }).body);
  const text3 = exportProduct(built2, { includeCost: true });
  assert.equal(text3, text2, 'export → import → export is a fixed point');
  assert.ok(!text2.includes('في المخزن تظهر هنا كزيادات'), 'nothing left to re-express');
  assert.equal(built1.price_iqd, 500_000);
  assert.equal(built1.options.find((o) => o.id === 'ov1')?.regular_adjust_iqd, 399_000);
});

test('the documented Bambu A1 example is valid and already in the owner\'s form', async () => {
  const { readFileSync } = await import('node:fs');
  const text = readFileSync('docs/examples/bambu-a1.txt', 'utf8');
  const parsed = parseTemplate(text);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.unknown_keys, []);
  const merged = toDocBody(parsed, null, { brand_id: null, catalog_ids: [] });
  assert.deepEqual(merged.needs_review, []);
  const built = validateProductDoc(merged.body);
  assert.equal(built.price_iqd, 899_000, 'the cheapest model is the base');
  assert.deepEqual(built.sale_types.sort(), ['direct_sale', 'pre_order'], 'sold both ways, at product level');
  assert.equal(built.direct_surcharge_iqd, 51_000);
  assert.equal(built.preorder_transports.find((t) => t.method === 'air')?.commission_iqd, 25_000);
  const combo = built.options.find((o) => o.id === 'a1-combo')!;
  assert.equal(combo.availability_type, '', 'availability follows the product');
  assert.deepEqual([combo.regular_price_iqd, combo.regular_adjust_iqd], [null, 200_000]);
  // The member prices follow the surcharge on their own (pricing.ts
  // memberAtRung) — the example states no member adjustment.
  assert.deepEqual([combo.prime_adjust_iqd ?? null, combo.pro_adjust_iqd ?? null], [null, null]);
  // Nothing for the normalizer to do — the example teaches the stored form.
  const { normalizeCheapestBase } = await import('../worker/lib/cheapestBase');
  assert.deepEqual(normalizeCheapestBase(built).changed, []);
  // And the resolver charges what the header table promises.
  const { resolveUnitPrice } = await import('../worker/lib/pricing');
  const comboDirect = resolveUnitPrice({ product: built, optionId: 'a1-combo', tier: 'free', tierActive: false });
  assert.equal(comboDirect.unit_subtotal_iqd, 1_099_000 + 51_000, 'Combo, direct sale');
  const a1Air = resolveUnitPrice({ product: built, optionId: 'a1', transportMethod: 'air', tier: 'free', tierActive: false });
  assert.equal(a1Air.unit_subtotal_iqd, 899_000 + 25_000, 'A1, pre-order by air');
  const comboPro = resolveUnitPrice({ product: built, optionId: 'a1-combo', transportMethod: 'air', tier: 'pro', tierActive: true });
  assert.equal(comboPro.applied_iqd, 999_000, 'PRO price of the Combo');
  assert.equal(comboPro.unit_subtotal_iqd, 999_000, 'and PRO pays no air commission');
});

test('a product stored with a base above its cheapest option is re-based on the cheapest', () => {
  const v = view();
  const vals = v.values as unknown as Array<Record<string, unknown>>;
  vals[0].regular_price_iqd = 450_000; // A1 below the 500,000 base
  vals[0].prime_price_iqd = 445_000; // its member prices come down with it
  vals[0].pro_price_iqd = 430_000;
  const doc = applyRelations(parseProductRow(baseRow()), v, { includeInactive: true });
  const text = exportProduct(doc, { includeCost: true });
  assert.match(text, /^price_iqd=450000$/m);
  assert.match(text, /المخزّن حاليًا 500,000 د\.ع/);
  // The Combo inherited 500,000 and must still cost 500,000: +50,000 now.
  assert.match(text, /^options\.2\.regular_adjust_iqd=350000$/m, '300,000 over the old base is 350,000 over the new one');
  const built = validateProductDoc(toDocBody(parseTemplate(text), doc, { needs_review: [] }).body);
  assert.equal(built.price_iqd, 450_000);
});

test('a signed number on an option price is read as the increase, and lands in the adjustment', () => {
  const doc = applyRelations(parseProductRow(baseRow()), view(), { includeInactive: true });
  const text = exportProduct(doc, { includeCost: true })
    .replace(/^options\.2\.regular_price_iqd=__NULL__$/m, 'options.2.regular_price_iqd=+120000')
    .replace(/^options\.2\.regular_adjust_iqd=300000$/m, '# (moved to the price line above)')
    .replace(/^colors\.1\.pro_price_iqd=__NULL__$/m, 'colors.1.pro_price_iqd=-7000');
  const parsed = parseTemplate(text);
  assert.deepEqual(parsed.errors, []);
  const built = validateProductDoc(toDocBody(parsed, doc, { needs_review: [] }).body);
  const combo = built.options.find((o) => o.id === 'ov2')!;
  assert.equal(combo.regular_price_iqd, null, 'not a price');
  assert.equal(combo.regular_adjust_iqd, 120_000, 'the increase');
  const black = built.colors[0];
  assert.equal(black.pro_price_iqd, null);
  assert.equal(black.pro_adjust_iqd, -7_000, 'a discount is a negative difference');
});

test('a signed number on the PRODUCT price is refused — there is nothing beneath it to differ from', () => {
  const parsed = parseTemplate('template_version=2\nname_ar=x\nprice_iqd=+5000\n');
  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0].message, /signed value/);
});

test('a surcharge may be written with the plus the guides use — it is just the number', () => {
  const parsed = parseTemplate(
    'template_version=2\nname_ar=x\nprice_iqd=100000\ndirect_surcharge_iqd=+51000\n' +
      'transports.1.method=land\ntransports.1.surcharge_iqd=+15000\ntransports.1.active=true\n'
  );
  assert.deepEqual(parsed.errors, []);
  const built = validateProductDoc(toDocBody(parsed, null, { brand_id: null, catalog_ids: [] }).body);
  assert.equal(built.direct_surcharge_iqd, 51_000);
  assert.equal(built.preorder_transports[0].commission_iqd, 15_000);
});

test('REVIEW: the apply re-expresses prices only when the file writes the option/colour rows', async () => {
  // A relational product's rows live in their own tables and are rewritten
  // only when the file carries options.*/colors.* keys. A file that renames
  // the product must not lower products.price_iqd and leave the inheriting
  // rows behind — that would change what they sell for.
  const { touchesPricingStructure } = await import('../worker/lib/template');
  assert.equal(touchesPricingStructure(parseTemplate('template_version=2\nname_ar=x\nprice_iqd=1\n')), false);
  assert.equal(touchesPricingStructure(parseTemplate('template_version=2\noptions.1.name_ar=a\n')), true);
  assert.equal(touchesPricingStructure(parseTemplate('template_version=2\ncolors.1.name_ar=a\n')), true);
  assert.equal(touchesPricingStructure(parseTemplate('template_version=2\noptions=__CLEAR__\n')), true);
});

test('a usage step with neither title nor body is warned about, not silently dropped', () => {
  const parsed = parseTemplate('template_version=2\nname_ar=x\nprice_iqd=1\nusage_steps.1.kind=setup\nusage_steps.1.images=https://img.example/a.jpg\n');
  const merge = toDocBody(parsed, null, { brand_id: null, catalog_ids: [] });
  assert.ok(merge.warnings.some((w) => w.startsWith('usage_steps.1:')), merge.warnings.join('\n'));
  assert.equal(validateProductDoc(merge.body).usage_guide.steps.length, 0);
});

test('the transport surcharge may be written with the word the form uses', () => {
  const doc = applyRelations(parseProductRow(baseRow()), view(), { includeInactive: true });
  const text = exportProduct(doc, { includeCost: true })
    .replace(/^transports\.3\.surcharge_iqd=__NULL__$/m, 'transports.3.surcharge_iqd=15000')
    .replace(/^transports\.3\.enabled=false$/m, 'transports.3.enabled=true');
  const parsed = parseTemplate(text);
  assert.deepEqual(parsed.errors, []);
  const built = validateProductDoc(toDocBody(parsed, doc, { needs_review: [] }).body);
  const land = built.preorder_transports.find((t) => t.method === 'land')!;
  assert.equal(land.commission_iqd, 15_000, 'surcharge_iqd is commission_iqd');
  assert.equal(land.active, true);
  assert.ok(!/^transports\.\d+\.commission_iqd=/m.test(exportProduct(doc, { includeCost: true })), 'the legacy spelling is input-only');
});

// ------------------------------------------------------------- the usage guide

test('the setup & usage guide round-trips: official link, steps, photos, video, doc link', () => {
  const doc = applyRelations(
    parseProductRow({
      ...baseRow(),
      usage_guide: JSON.stringify({
        official_url: 'https://wiki.bambulab.com/en/a1',
        steps: [
          { id: 'ustep_1', kind: 'setup', title: 'Mount the spool holder', body: 'Two screws.\nHand-tight.', images: ['https://img.example/1.jpg', 'https://img.example/2.jpg'], video_url: 'https://www.youtube.com/watch?v=abc', link_url: 'https://wiki.bambulab.com/en/a1/spool', order: 0 },
          { id: 'ustep_2', kind: 'usage', title: 'First print', body: 'Load PLA.', images: [], video_url: '', link_url: '', order: 1 },
        ],
      }),
    }),
    view(),
    { includeInactive: true }
  );
  const text = exportProduct(doc, { includeCost: true });
  assert.match(text, /^usage_official_url=https:\/\/wiki\.bambulab\.com\/en\/a1$/m);
  assert.match(text, /^usage_steps\.1\.kind=setup$/m);
  // SPACE-separated, not comma-separated. A comma is a legal character in a URL
  // path — a Cloudinary transform reads `/upload/w_400,h_300/a.jpg` — so the
  // old bare-comma join split one working image into two broken ones on every
  // trip. A bare space cannot occur inside a valid URL, so this join is
  // unambiguous; the reader still accepts a comma before a new address, which
  // is what keeps every file written before the change readable.
  assert.match(text, /^usage_steps\.1\.images=https:\/\/img\.example\/1\.jpg https:\/\/img\.example\/2\.jpg$/m);
  assert.match(text, /^usage_steps\.2\.title=First print$/m);
  const parsed = parseTemplate(text);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.unknown_keys, []);
  const built = validateProductDoc(toDocBody(parsed, doc, { needs_review: [] }).body);
  assert.equal(built.usage_guide.official_url, 'https://wiki.bambulab.com/en/a1');
  assert.equal(built.usage_guide.steps.length, 2);
  assert.equal(built.usage_guide.steps[0].body, 'Two screws.\nHand-tight.', 'a heredoc body survives');
  assert.deepEqual(built.usage_guide.steps[0].images, ['https://img.example/1.jpg', 'https://img.example/2.jpg']);
  assert.equal(built.usage_guide.steps[0].video_url, 'https://www.youtube.com/watch?v=abc');
  assert.equal(built.usage_guide.steps[1].kind, 'usage');

  // Editing ONE step's title merges by id; a file that omits the guide keeps it.
  const renamed = text.replace(/^usage_steps\.2\.title=First print$/m, 'usage_steps.2.title=أول طباعة');
  const edited = validateProductDoc(toDocBody(parseTemplate(renamed), built, { needs_review: [] }).body);
  assert.deepEqual(edited.usage_guide.steps.map((s) => s.title), ['Mount the spool holder', 'أول طباعة']);
  const without = text.split('\n').filter((l) => !l.startsWith('usage_')).join('\n');
  const kept = validateProductDoc(toDocBody(parseTemplate(without), built, { needs_review: [] }).body);
  assert.equal(kept.usage_guide.steps.length, 2, 'an omitted group preserves');
  const cleared = validateProductDoc(toDocBody(parseTemplate(`${without}\nusage_steps=__CLEAR__\n`), built, { needs_review: [] }).body);
  assert.equal(cleared.usage_guide.steps.length, 0, '__CLEAR__ really clears');
  assert.equal(cleared.usage_guide.official_url, 'https://wiki.bambulab.com/en/a1', 'clearing the steps keeps the link');
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
  assert.match(text, /transports\.1\.enabled=false/);
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
  assert.match(text, /transports\.1\.surcharge_iqd=__NULL__\n#\s+↳ العمولة الفعلية 250,000 د\.ع/);
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

// ============================================================ review round 2
// Each test below is a defect an adversarial review found in the first cut and
// that would have destroyed real data on an ordinary edit.

test('a file that omits the compare-at price PRESERVES it, as the header promises', () => {
  const doc = applyRelations(
    parseProductRow({ ...baseRow(), original_price_iqd: 650_000 }),
    view(),
    { includeInactive: true }
  );
  // The partial file an owner writes by hand, or last week's export from a
  // build that never wrote the key.
  const partial = `template_version=2\nproduct_id=prd_x\nname_ar=منتج\nprice_iqd=500000\n`;
  const built = validateProductDoc(toDocBody(parseTemplate(partial), doc, { needs_review: [] }).body);
  assert.equal(built.original_price_iqd, 650_000, 'the struck-through price must survive an omitted key');
});

test('a file with no group column leaves every group exactly where it was', () => {
  // The export before the `group` key existed. All rows arrive nameless; they
  // used to collapse into the first group, which deleted every other group.
  const doc = applyRelations(parseProductRow(baseRow()), view(), { includeInactive: true });
  const stripped = { ...doc, options: doc.options.map((o) => ({ ...o, group_en: '' })) };
  const body = relationsBodyFromDoc(stripped, view());
  const groups = body.groups as Array<{ id: string; name_en: string; values: Array<{ id: string }> }>;
  assert.equal(groups.length, 2, 'both groups must survive a file that never mentions them');
  assert.deepEqual(
    groups.map((g) => g.values.map((v) => v.id)).flat().sort(),
    ['ov1', 'ov2', 'ov3'],
    'and every option must still be in one'
  );
  const nozzle = groups.find((g) => g.id === 'og2')!;
  assert.deepEqual(nozzle.values.map((v) => v.id), ['ov3'], 'ov3 stays in the group it is in');
});

test('renaming a group keeps its id, so its values are not cascade-deleted', () => {
  // product_option_values.group_id is ON DELETE CASCADE. Matching a group by
  // NAME alone gave a renamed group a fresh id, the old row was deleted, its
  // values went with it, and they came back with reserved units zeroed.
  const doc = applyRelations(parseProductRow(baseRow()), view(), { includeInactive: true });
  const renamed = {
    ...doc,
    options: doc.options.map((o) => (o.group_en === 'Nozzle' ? { ...o, group_en: 'Nozzle size' } : o)),
  };
  const groups = relationsBodyFromDoc(renamed, view()).groups as Array<{ id: string; name_en: string }>;
  const nozzle = groups.find((g) => g.name_en === 'Nozzle size')!;
  assert.equal(nozzle.id, 'og2', 'a rename must reuse the group id, not mint a new one');
});

test('a NEW group named in the file gets a new id and does not steal an existing one', () => {
  const doc = applyRelations(parseProductRow(baseRow()), view(), { includeInactive: true });
  const extra = {
    ...doc,
    options: [...doc.options, { ...doc.options[0], id: 'ov9', group_en: 'Plate', name_ar: 'PEI', name_en: 'PEI' }],
  };
  const groups = relationsBodyFromDoc(extra, view()).groups as Array<{ id: string; name_en: string }>;
  const plate = groups.find((g) => g.name_en === 'Plate')!;
  assert.ok(!['og1', 'og2'].includes(plate.id), 'a genuinely new group must not reuse an existing id');
  assert.equal(groups.length, 3);
});

test("a colour's SKU fragment survives an ordinary edit", () => {
  const v = view();
  (v.colors as unknown as Array<Record<string, unknown>>)[0].sku_part = 'BLK';
  const doc = applyRelations(parseProductRow(baseRow()), v, { includeInactive: true });
  const text = exportProduct(doc, { includeCost: true });
  assert.ok(text.includes('colors.1.sku_part=BLK\n'), 'the file must SHOW it, or it cannot be restored');
  const built = validateProductDoc(toDocBody(parseTemplate(text), doc, { needs_review: [] }).body);
  const colors = relationsBodyFromDoc(built, v).colors as Array<Record<string, unknown>>;
  assert.equal(colors[0].sku_part, 'BLK', 'the writer overwrites this column unconditionally');
});

test("an image's recorded type and size are carried, not cleared", () => {
  const v = view();
  const first = (v.images as unknown as Array<Record<string, unknown>>)[0];
  first.content_type = 'image/jpeg';
  first.bytes = 204_800;
  const doc = applyRelations(parseProductRow(baseRow()), v, { includeInactive: true });
  const built = validateProductDoc(
    toDocBody(parseTemplate(exportProduct(doc, { includeCost: true })), doc, { needs_review: [] }).body
  );
  const images = relationsBodyFromDoc(built, v).images as Array<Record<string, unknown>>;
  const im1 = images.find((i) => i.id === 'im1')!;
  assert.equal(im1.content_type, 'image/jpeg');
  assert.equal(im1.bytes, 204_800);
});

// ------------------------------------------- a legacy row the ladder now refuses

test('U2: a legacy product whose option swallows the base PRO exports with a warning, and the apply refusal names the row to give its own PRO price', () => {
  // Stored before the rule: base 100,000 / PRO 90,000, option FIXED 5,000.
  // The PRO carried onto the option would be 90,000 − 95,000 ≤ 0 — nothing.
  const legacy = {
    has_relations: true,
    inventory_mode: 'BASE',
    groups: [{ id: 'og1', product_id: 'prd_x', name_en: 'Model', sort: 0, active: 1 }],
    values: [
      {
        id: 'ov1', product_id: 'prd_x', group_id: 'og1', name_en: 'Clearance', sku_part: '', image: '', sort: 0, active: 1,
        stock: null, low_stock_threshold: null,
        regular_price_iqd: 5_000, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null,
        regular_adjust_iqd: null, prime_adjust_iqd: null, pro_adjust_iqd: null, cost_adjust_iqd: null,
        availability_type: '', lead_time_text: '', lead_time_min_days: null, lead_time_max_days: null, variant_key: '', variant_label: '',
      },
    ],
    colors: [], links: [], variants: [], images: [],
  } as unknown as ProductRelationsView;
  const doc = applyRelations(
    parseProductRow({ ...baseRow(), price_iqd: 100_000, pro_price_iqd: 90_000, original_price_iqd: null, product_cost_iqd: null }),
    legacy,
    { includeInactive: true }
  );
  const text = exportProduct(doc, { includeCost: true, brand: null, catalogs: [] });

  // The normaliser keeps the base (lowering it to 5,000 would take PRO to
  // zero), says so beside price_iqd, and writes the option as −95,000.
  assert.match(text, /^price_iqd=100000$/m);
  assert.match(text, /أرخص صنف هو 5,000 د\.ع، لكن خفض الأساسي إليه يُنزل سعر PRO للمنتج إلى الصفر أو أقل/);
  assert.match(text, /^options\.1\.regular_adjust_iqd=-95000$/m);

  // Applying that file is refused exactly as saving the product itself is —
  // and the message says which row, and what to do: give it its own PRO.
  const parsed = parseTemplate(text);
  assert.deepEqual(parsed.errors, []);
  const refusal = {
    message: /^options\.ov1\.regular_price_iqd: the reduction on this row is larger than the PRO price it inherits \(90000\) — state a PRO price for this row, or reduce less$/,
  };
  assert.throws(() => validateProductDoc(toDocBody(parsed, doc, { needs_review: [] }).body), refusal, 'the file as exported');
  assert.throws(() => validateProductDoc({ ...doc, options: doc.options, colors: doc.colors } as unknown as Record<string, unknown>), refusal, 'the stored product itself');

  // Following the advice — one line in the file — makes it apply, and the
  // row charges PRO members the number the owner wrote.
  const fixed = text.replace(/^options\.1\.pro_price_iqd=__NULL__$/m, 'options.1.pro_price_iqd=4000');
  assert.notEqual(fixed, text, 'the export carries the pro_price_iqd line to fill in');
  const built = validateProductDoc(toDocBody(parseTemplate(fixed), doc, { needs_review: [] }).body);
  assert.deepEqual([built.options[0].regular_adjust_iqd, built.options[0].pro_price_iqd], [-95_000, 4_000]);
});
