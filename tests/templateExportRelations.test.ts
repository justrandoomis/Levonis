/**
 * THE EXPORT MUST CONTAIN THE PRODUCT.
 *
 * `GET /api/admin/template/export/:productId` read the `products` row alone.
 * Every product built in the current admin form keeps its options, colours and
 * images in the relational tables — the relations PUT writes them there and
 * never mirrors them back into `products.options` — so the exported .txt was
 * the base fields and nothing else.
 *
 * Measured on a real product with two priced options (each with its own cost),
 * one colour and one image: 24 keys, of which options.* = 0, colors.* = 0,
 * images.* = 0 and option costs = 0. The owner reported that as four separate
 * complaints — empty or few fields, options not included, no images, cost
 * missing — and it was one defect.
 *
 * These tests run the REAL overlay and the REAL exporter, so they fail if
 * either stops carrying the relational structure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProductRow } from '../worker/lib/productModel';
import { applyRelations } from '../worker/lib/productOverlay';
import { docToEntries, exportProduct } from '../worker/lib/template';
import type { ProductRelationsView } from '../worker/lib/productOverlay';

function baseDoc() {
  return parseProductRow({
    id: 'prd_x',
    slug: 'x',
    status: 'active',
    name_ar: 'منتج',
    name_en: 'Product',
    price_iqd: 500_000,
    product_cost_iqd: 300_000,
    selling_type: 'direct_sale',
    sale_types: JSON.stringify(['direct_sale']),
  });
}

/** A product shaped the way the admin form actually stores one. */
function relationalView(): ProductRelationsView {
  return {
    has_relations: true,
    inventory_mode: 'BASE',
    groups: [{ id: 'og1', product_id: 'prd_x', name_en: 'Model', sort: 0, active: 1 }],
    values: [
      {
        id: 'ov1', product_id: 'prd_x', group_id: 'og1', name_en: 'A1', sku_part: 'A1',
        image: '', sort: 0, active: 1, stock: 5, low_stock_threshold: null,
        regular_price_iqd: 899_000, prime_price_iqd: 885_000, pro_price_iqd: 799_000, cost_iqd: 700_000,
        regular_adjust_iqd: null, prime_adjust_iqd: null, pro_adjust_iqd: null, cost_adjust_iqd: null,
        availability_type: 'direct_sale', lead_time_text: '', lead_time_min_days: null,
        lead_time_max_days: null, variant_key: 'a1', variant_label: 'A1',
      },
      {
        id: 'ov2', product_id: 'prd_x', group_id: 'og1', name_en: 'A1 Combo', sku_part: 'A1C',
        image: '', sort: 1, active: 1, stock: 2, low_stock_threshold: null,
        regular_price_iqd: 1_199_000, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: 950_000,
        regular_adjust_iqd: null, prime_adjust_iqd: null, pro_adjust_iqd: null, cost_adjust_iqd: null,
        availability_type: 'pre_order', lead_time_text: '25-40 يوم', lead_time_min_days: 25,
        lead_time_max_days: 40, variant_key: 'a1', variant_label: 'A1',
      },
    ],
    colors: [
      {
        id: 'pc1', product_id: 'prd_x', name_en: 'Black', hex: '#000000', image: '',
        sort: 0, active: 1, stock: null, low_stock_threshold: null,
        regular_price_iqd: 5_000, prime_price_iqd: null, pro_price_iqd: null, cost_iqd: null,
        regular_adjust_iqd: null, prime_adjust_iqd: null, pro_adjust_iqd: null, cost_adjust_iqd: null,
      },
    ],
    links: [],
    variants: [],
    images: [
      { id: 'im1', product_id: 'prd_x', url: '/files/products/a.jpg', alt_en: 'front',
        sort_order: 0, is_primary: 1, option_value_id: null, color_id: null, variant_id: null,
        width: 1200, height: 900 },
    ],
  } as unknown as ProductRelationsView;
}

const keysOf = (entries: Array<{ key: string }>) => entries.map((e) => e.key);
const countPrefix = (entries: Array<{ key: string }>, p: string) =>
  keysOf(entries).filter((k) => k.startsWith(p)).length;

test('the JSON row alone carries none of the structure — this is what shipped', () => {
  // Not a hypothetical: this is the doc the export used to be built from.
  const entries = docToEntries(baseDoc(), { includeCost: true });
  assert.equal(countPrefix(entries, 'options.'), 0);
  assert.equal(countPrefix(entries, 'colors.'), 0);
  assert.equal(countPrefix(entries, 'images.'), 0);
});

test('through the overlay, the export carries options, colours and images', () => {
  const doc = applyRelations(baseDoc(), relationalView());
  const entries = docToEntries(doc, { includeCost: true });
  assert.ok(countPrefix(entries, 'options.') >= 40, `options keys: ${countPrefix(entries, 'options.')}`);
  assert.ok(countPrefix(entries, 'colors.') >= 12, `colour keys: ${countPrefix(entries, 'colors.')}`);
  assert.ok(countPrefix(entries, 'images.') >= 8, `image keys: ${countPrefix(entries, 'images.')}`);
});

test('every option carries its own cost, which is what «التكلفة» meant', () => {
  const doc = applyRelations(baseDoc(), relationalView());
  const entries = docToEntries(doc, { includeCost: true });
  const costs = entries.filter((e) => /^options\.\d+\.cost_iqd$/.test(e.key));
  assert.equal(costs.length, 2);
  assert.deepEqual(costs.map((e) => e.value).sort(), ['700000', '950000']);
  assert.equal(entries.find((e) => e.key === 'product_cost_iqd')?.value, '300000');
});

test('the 0043 fields survive, so a re-import cannot reset the variant', () => {
  const doc = applyRelations(baseDoc(), relationalView());
  const entries = docToEntries(doc, { includeCost: true });
  const at = (k: string) => entries.find((e) => e.key === k)?.value;
  assert.equal(at('options.1.availability_type'), 'direct_sale');
  assert.equal(at('options.2.availability_type'), 'pre_order');
  // 0079 — the source moved to the `_en` line; the two translation lines sit
  // beside it, empty until a human or the local engine fills them.
  assert.equal(at('options.2.lead_time_text_en'), '25-40 يوم');
  assert.equal(at('options.2.lead_time_text_ar'), '');
  assert.equal(at('options.2.lead_time_text_ckb'), '');
  assert.equal(at('options.2.lead_time_text'), undefined, 'the bare spelling is import-only');
  assert.equal(at('options.1.variant_key'), 'a1');
  assert.equal(at('options.2.variant_label'), 'A1');
});

test('a relational image no longer crashes the whole export', () => {
  // The overlay built a media object with `kind`/`media_key` — fields MediaV2
  // does not have — while missing key/role/width/height/source_url, and an
  // `as` cast hid it. The exporter's formatter takes `string | null`, so one
  // relational image took the entire export down with
  // "Cannot read properties of undefined (reading 'includes')".
  const doc = applyRelations(baseDoc(), relationalView());
  const entries = docToEntries(doc, { includeCost: true });
  for (const e of entries) {
    assert.notEqual(e.value, undefined, `${e.key} has an undefined value`);
  }
  const text = exportProduct(doc, { includeCost: true });
  assert.ok(text.includes('images.1.url=/files/products/a.jpg'));
  assert.ok(text.includes('images.1.primary='));
});

test('the media the overlay produces is a complete MediaV2', () => {
  const doc = applyRelations(baseDoc(), relationalView());
  const m = doc.media[0] as unknown as Record<string, unknown>;
  for (const field of ['id', 'url', 'key', 'role', 'alt_ar', 'alt_en', 'alt_ckb', 'order', 'primary', 'width', 'height', 'source_url']) {
    assert.ok(field in m, `MediaV2.${field} is missing from the overlay's output`);
  }
  // Taken from the row rather than invented.
  assert.equal(m.width, 1200);
  assert.equal(m.height, 900);
  assert.equal(m.role, 'gallery');
});

test('a product with no relational rows exports exactly as before', () => {
  const doc = baseDoc();
  const untouched = applyRelations(doc, { has_relations: false } as unknown as ProductRelationsView);
  assert.deepEqual(docToEntries(untouched, { includeCost: true }), docToEntries(doc, { includeCost: true }));
});

// ---------------------------------------------------------------------------
// §11: cost reaches no export an assistant admin can open.
//
// The CSV path has always gated this on canViewFinancials. The TXT path had no
// flag at all, so `product_cost_iqd`, `options.N.cost_iqd` and the colour
// equivalents went out unconditionally — the whole cost sheet, as a .txt.
// ---------------------------------------------------------------------------

test('cost is withheld from an export the caller may not see', () => {
  const doc = applyRelations(baseDoc(), relationalView());
  const withoutCost = docToEntries(doc, { includeCost: false });
  const leaked = withoutCost.map((x) => x.key).filter((k) => k.toLowerCase().includes('cost'));
  assert.deepEqual(leaked, [], `cost keys survived: ${leaked.join(', ')}`);

  // And the rest of the product is still there — this withholds cost, it does
  // not cripple the export.
  assert.ok(countPrefix(withoutCost, 'options.') >= 30);
  assert.ok(withoutCost.some((x) => x.key === 'options.1.regular_price_iqd'));
});

test('a financial admin still gets every cost field', () => {
  const doc = applyRelations(baseDoc(), relationalView());
  const keys = docToEntries(doc, { includeCost: true }).map((x) => x.key);
  for (const k of ['product_cost_iqd', 'options.1.cost_iqd', 'options.1.cost_adjust_iqd', 'colors.1.cost_iqd']) {
    assert.ok(keys.includes(k), `${k} is missing for a financial admin`);
  }
});

test('an omitted flag still means "may see it", so the blank template is unchanged', () => {
  const doc = applyRelations(baseDoc(), relationalView());
  assert.deepEqual(docToEntries(doc), docToEntries(doc, { includeCost: true }));
});
