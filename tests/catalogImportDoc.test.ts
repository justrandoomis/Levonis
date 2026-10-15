/**
 * THE DOCUMENT OF AN IMPORTED PRODUCT IS BUILT FROM DEFAULTS (Bambu import
 * spec §A.4 step 3, §C.9, §C.10 layer 3).
 *
 * `newImportProductDoc` passes only the allow-listed fields to the app's own
 * validator, with `price_iqd: 0` (the column default) and nothing else money:
 * every money, stock, package, warranty, ops, offer and condition field of the
 * result is the schema default or null — asserted here field by field, and
 * again when a caller's object smuggles such a key in by a cast.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importDocDefaultsViolations, newImportProductDoc, IMPORT_DOC_FIELD_KEYS, type ImportDocFields } from '../worker/lib/catalogImport/doc';
import { serializeDoc } from '../worker/lib/productModel';
import { DIMENSION_FIELDS } from '../worker/lib/physicalDimensions';

const FIELDS: ImportDocFields = {
  id: 'p_0123456789abcdef01234567',
  slug: 'pla-basic-filament',
  status: 'active',
  name_en: 'PLA Basic',
  name_ar: 'PLA Basic',
  name_ckb: 'PLA Basic',
  description_en: 'PLA is the most common material in 3D printing.',
  brand_id: 'brd_bambu',
  category_id: 'cat_materials',
  sub_category_id: 'cat_bi_pla',
  template_family: 'materials',
  spec_fields: { filament_diameter: '1.75 mm' },
  spec_groups: [],
  content_blocks: [],
  usage_guide: { official_url: 'https://wiki.bambulab.com/en/filament', steps: [] },
};

test('every money, stock, package, warranty, ops, offer and condition field is the schema default or null', () => {
  const doc = newImportProductDoc(FIELDS);
  assert.deepEqual(importDocDefaultsViolations(doc), []);
  // Money.
  assert.equal(doc.price_iqd, 0, 'price_iqd is the column default (0001: NOT NULL DEFAULT 0)');
  for (const k of ['pro_price_iqd', 'prime_price_iqd', 'product_cost_iqd', 'original_price_iqd', 'direct_surcharge_iqd'] as const) assert.equal(doc[k], null, k);
  // Stock.
  assert.equal(doc.stock, null, 'stock NULL: untracked until the owner decides (§B.10)');
  assert.equal(doc.low_stock_threshold, null);
  // Package and product measures.
  for (const f of DIMENSION_FIELDS) assert.equal((doc.dimensions as unknown as Record<string, unknown>)[f], null, f);
  // Warranty.
  assert.deepEqual(doc.warranty_plans, []);
  assert.equal(doc.warranty_base_months, null);
  assert.equal(doc.serialized, null);
  // Ops.
  assert.deepEqual(doc.ops_policy, {});
  assert.equal(doc.delivery_options ?? null, null);
  // Offer.
  assert.equal(doc.composition, '');
  assert.deepEqual(doc.sale_types, ['direct_sale'], 'the form-default sale type');
  assert.equal(doc.selling_type, 'direct_sale');
  assert.deepEqual(doc.preorder_transports, []);
  assert.deepEqual(doc.labels, []);
  assert.deepEqual(doc.payment_options, []);
  assert.equal(doc.is_featured, false);
  assert.equal(doc.display_order, 0);
  assert.equal(doc.gini_url, '');
  assert.equal(doc.light_image, '');
  assert.deepEqual(doc.hashtags, []);
  assert.equal(doc.sku, null, 'products.sku is Levonis’s own; the source SKU code is an external id');
  // Condition.
  assert.equal(doc.condition, null, 'a new product is NEW');
  // And what the import does set.
  assert.equal(doc.name_en, 'PLA Basic');
  assert.equal(doc.sub_category_id, 'cat_bi_pla');
  assert.equal(doc.status, 'active');
  assert.equal(doc.spec_fields.filament_diameter, '1.75 mm');
});

test('the row the document serialises to carries the defaults the 0195 guard triggers demand', () => {
  const row = serializeDoc(newImportProductDoc(FIELDS));
  assert.equal(row.price_iqd, 0);
  for (const k of ['prime_price_iqd', 'pro_price_iqd', 'original_price_iqd', 'product_cost_iqd', 'direct_surcharge_iqd', 'stock', 'low_stock_threshold', ...DIMENSION_FIELDS]) {
    assert.equal(row[k] ?? null, null, k);
  }
  assert.equal(row.warranty_plans, '[]');
  assert.equal(row.preorder_transports, '[]');
});

test('a key outside the allow-list never reaches the validator, whatever the caller casts in', () => {
  const smuggled = {
    ...FIELDS,
    price_iqd: 990000,
    prime_price_iqd: 900000,
    product_cost_iqd: 700000,
    original_price_iqd: 1200000,
    direct_surcharge_iqd: 5000,
    stock: 12,
    low_stock_threshold: 2,
    package_weight_g: 1200,
    net_weight_g: 1000,
    dimensions: { package_width_mm: 200 },
    warranty_plans: [{ id: 'w1', title_en: 'Extended', duration_months: 12, fee_iqd: 50000, active: true }],
    warranty_base_months: 12,
    serialized: true,
    ops_policy: { size_class: 'large' },
    labels: [{ id: 'l1', text_en: 'Sale', visible: true }],
    sale_types: ['pre_order'],
    preorder_transports: [{ method: 'air', commission_iqd: 9000, active: true }],
    composition: 'bundle',
    condition: { grade: 'used' },
    sku: 'A00-W1',
    is_featured: true,
    payment_options: ['gini'],
    hashtags: ['sale'],
  } as unknown as ImportDocFields;
  const doc = newImportProductDoc(smuggled);
  assert.deepEqual(importDocDefaultsViolations(doc), []);
  assert.equal(doc.price_iqd, 0);
  assert.equal(doc.stock, null);
  assert.equal(doc.sku, null);
});

test('the allow-list names no money, stock, package, warranty, ops, offer or condition key', () => {
  for (const k of IMPORT_DOC_FIELD_KEYS) {
    assert.ok(!/price|cost|stock|warranty|ops|surcharge|package|weight|sku|label|payment|condition|composition|sale|transport|featured/i.test(k), k);
  }
});

test('the defaults check names each field it finds off its default', () => {
  const doc = newImportProductDoc(FIELDS);
  assert.deepEqual(importDocDefaultsViolations({ ...doc, price_iqd: 5, stock: 1, warranty_base_months: 12 }), ['price_iqd', 'stock', 'warranty_base_months']);
});
