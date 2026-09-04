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
