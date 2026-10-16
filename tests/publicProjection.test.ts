/**
 * WHAT A STRANGER MAY SEE ABOUT A PRODUCT.
 *
 * `projectPublic` is a privacy boundary, and boundaries written as a list of
 * fields to remove rot the moment a field is added somewhere else. Migration
 * 0044 added `cost_adjust_iqd` to every option and colour; the stripper still
 * named only `cost_iqd`, so the shop's margin move was served on the public
 * product endpoint until this test existed.
 *
 * The assertion is therefore deliberately not "cost_adjust_iqd is gone". It is
 * "NO key mentioning cost survives, at any level" — the shape that catches the
 * NEXT cost column too, whoever adds it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseProductRow, primaryMediaFirst, projectPublic } from '../worker/lib/productModel';
import type { MediaV2, ProductDoc } from '../worker/lib/productModel';
import { productDocumentPublic, productRoutes } from '../worker/routes/products';
import { ROOT } from './fixtures/d1';
import { asD1, freshDb, get, stubApp } from './fixtures/app';
import { seedLiveCatalog } from './fixtures/liveCatalog';

/**
 * A real doc, built by the REAL parser from a row shaped like the products
 * table. Hand-rolling the object was the first attempt and it failed for the
 * wrong reason — a missing unrelated field — which would have made this test
 * about the fixture instead of about the boundary.
 */
function docWithCosts(): ProductDoc {
  const prices = {
    regular_price_iqd: 100_000,
    prime_price_iqd: 95_000,
    pro_price_iqd: 90_000,
    cost_iqd: 70_000,
    regular_adjust_iqd: 5_000,
    prime_adjust_iqd: null,
    pro_adjust_iqd: null,
    cost_adjust_iqd: 3_000,
  };
  const doc = parseProductRow({
    id: 'prd_test',
    slug: 'test',
    status: 'active',
    name_ar: 'اختبار',
    name_en: 'Test',
    price_iqd: 100_000,
    prime_price_iqd: 95_000,
    pro_price_iqd: 90_000,
    product_cost_iqd: 70_000,
    selling_type: 'direct_sale',
    sale_types: JSON.stringify(['direct_sale']),
    options: JSON.stringify([{ id: 'o1', name_ar: 'A', name_en: 'A', active: true, ...prices }]),
    colors: JSON.stringify([
      { id: 'c1', name_ar: 'أسود', name_en: 'Black', hex: '#000000', active: true, ...prices },
    ]),
  });

  /**
   * 0073 HUNG TWO MORE LEVELS OFF AN OPTION, AND BOTH CARRY `PriceFields`.
   *
   * They are attached HERE, after the parser, because that is where they come
   * from in production: `parseProductRow` whitelists the option keys and drops
   * `fulfillments`, and `applyRelations` hangs the per-model cells and their
   * per-route transports on afterwards. A fixture that only went through the
   * parser had nothing nested for the recursive assertion below to catch —
   * which is how the shop's cost for a model and for a shipping route came to
   * be served to anonymous callers on `GET /api/products/:slug` with this file
   * already green.
   */
  (doc.options[0] as unknown as Record<string, unknown>).fulfillments = [
    {
      fulfillment_type: 'pre_order',
      enabled: true,
      ...prices,
      transports: [{ method: 'land', enabled: true, surcharge_iqd: 60_000, ...prices }],
    },
  ];
  return doc;
}

/** Every key on every object, at any depth. */
function allKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) allKeys(v, into);
    return into;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      into.add(k);
      allKeys(v, into);
    }
  }
  return into;
}

test('the public projection carries no cost field at any level', () => {
  const out = projectPublic(docWithCosts()) as unknown;
  const keys = [...allKeys(out)];
  const costish = keys.filter((k) => k.toLowerCase().includes('cost'));
  assert.deepEqual(
    costish,
    [],
    `the public product payload leaks cost keys: ${costish.join(', ')}`
  );
});

/**
 * FINAL NUMBERS ONLY (Pricing V2 V2-0, C5; DECISIONS row 225). This test used
 * to pin the opposite — that an option's own selling price and adjustment
 * survive "for the resolver downstream". Nothing downstream resolves a price
 * from this payload: every figure a customer sees is resolved on the server
 * (`price_levels`, `pricing_modes`, the quote). The ladder was the arithmetic
 * of the final price, and on a product priced per SKU not even a price anyone
 * pays. The chooser's facts stay; every rung of the ladder goes.
 */
test('and it carries what a chooser draws, never the ladder beneath the price', () => {
  const out = projectPublic(docWithCosts()) as unknown as {
    options: Array<Record<string, unknown>>;
    colors: Array<Record<string, unknown>>;
    preorder_transports: Array<Record<string, unknown>>;
  } & Record<string, unknown>;
  const ladder = /^(regular|prime|pro)_(price|adjust)_iqd$|^surcharge_iqd$|^commission_iqd$|^direct_surcharge_iqd$/;
  const levels = [
    ...out.options,
    ...out.colors,
    ...out.options.flatMap((o) => (o.fulfillments as Array<Record<string, unknown>>) ?? []),
    ...out.options.flatMap((o) =>
      ((o.fulfillments as Array<Record<string, unknown>>) ?? []).flatMap((f) => (f.transports as Array<Record<string, unknown>>) ?? [])
    ),
    ...out.preorder_transports,
  ];
  assert.deepEqual(levels.flatMap((l) => Object.keys(l).filter((k) => ladder.test(k))), []);
  assert.equal('direct_surcharge_iqd' in out, false);
  // …and the facts a chooser needs are still there.
  assert.equal(out.options[0].id, 'o1');
  assert.equal(out.options[0].name_en, 'A');
  assert.equal(out.colors[0].hex, '#000000');
  const cell = (out.options[0].fulfillments as Array<Record<string, unknown>>)[0];
  assert.equal(cell.fulfillment_type, 'pre_order');
  assert.deepEqual((cell.transports as Array<Record<string, unknown>>).map((t) => [t.method, t.enabled]), [['land', true]]);
});

function media(id: string, order: number, primary = false): MediaV2 {
  const key = `products/test/gallery/${id}.webp`;
  return {
    id,
    url: `/files/${key}`,
    key,
    role: 'gallery',
    alt_ar: '',
    alt_en: '',
    alt_ckb: '',
    order,
    primary,
    width: null,
    height: null,
    source_url: '',
    option_value_id: '',
    color_id: '',
    variant_id: '',
  };
}

test('product media projections fail closed for hotlinks, non-WebP, and mismatched keys', () => {
  const doc = docWithCosts();
  const valid = media('valid', 3, true);
  doc.media = [
    { ...valid, id: 'external', url: 'https://vendor.example/image.webp', key: '' },
    { ...valid, id: 'jpeg', url: '/files/products/test/gallery/image.jpg', key: 'products/test/gallery/image.jpg' },
    { ...valid, id: 'uppercase', url: '/files/products/test/gallery/image.WEBP', key: 'products/test/gallery/image.WEBP' },
    { ...valid, id: 'mismatch', url: '/files/products/test/gallery/other.webp' },
    valid,
  ];
  doc.options[0].image = 'https://vendor.example/model.jpg';
  doc.colors[0].image = '/files/products/test/gallery/swatch.png';

  const out = projectPublic(doc) as unknown as {
    media: MediaV2[];
    images: string[];
    options: Array<{ image: string }>;
    colors: Array<{ image: string }>;
  };
  assert.deepEqual(out.media.map((item) => item.id), ['valid']);
  assert.deepEqual(out.images, [valid.url]);
  assert.equal(out.options[0].image, '');
  assert.equal(out.colors[0].image, '');
});

test('the explicit primary image leads every public image view without mutating admin order', () => {
  const doc = docWithCosts();
  const firstByGalleryOrder = media('gallery-first', 0);
  const chosenPrimary = media('chosen-primary', 9, true);
  const sameOrderA = media('same-a', 3);
  const sameOrderB = media('same-b', 3);
  doc.media = [firstByGalleryOrder, chosenPrimary, sameOrderA, sameOrderB];

  const originalIds = doc.media.map((item) => item.id);
  const out = projectPublic(doc) as unknown as { media: MediaV2[]; images: string[] };

  assert.equal(out.media[0].id, 'chosen-primary');
  assert.equal(out.images[0], chosenPrimary.url);
  assert.deepEqual(doc.media.map((item) => item.id), originalIds, 'projection must not rewrite the editor document');
  assert.deepEqual(out.media.slice(2).map((item) => item.id), ['same-a', 'same-b'], 'equal gallery orders stay stable');
});

test('primaryMediaFirst gives a deterministic gallery-order fallback when no primary exists', () => {
  const unordered = [media('later', 8), media('first', 1), media('middle', 4)];
  assert.deepEqual(primaryMediaFirst(unordered).map((item) => item.id), ['first', 'middle', 'later']);
  assert.deepEqual(unordered.map((item) => item.id), ['later', 'first', 'middle']);
});

// ---------------------------------------------------------------------------
// THE PRINTER SPECS THE CUSTOMER CAN ACTUALLY READ.
//
// The ten spec fields the owner named (§6) were storable, importable and
// exportable — and invisible. The storefront's specifications table renders
// `spec_groups`; nothing rendered `spec_fields` except the in-the-box bullet
// list. projectPublic now derives the one from the other using the family
// definition, so the same table shows them with no new renderer.
// ---------------------------------------------------------------------------

function printerDoc(specs: Record<string, string>): ProductDoc {
  return parseProductRow({
    id: 'prd_a1',
    slug: 'a1',
    status: 'active',
    name_ar: 'A1',
    name_en: 'A1',
    price_iqd: 700_000,
    selling_type: 'direct_sale',
    sale_types: JSON.stringify(['direct_sale']),
    template_family: 'devices',
    spec_fields: JSON.stringify(specs),
  });
}

test('filled printer spec fields reach the public payload as spec groups', () => {
  const out = projectPublic(
    printerDoc({
      max_acceleration: '10000',
      supported_nozzle_sizes: '0.2 / 0.4 / 0.6 / 0.8',
      ams_compatibility: 'AMS lite',
      camera_resolution: '1080p',
      companion_app: 'Bambu Handy',
    })
  ) as unknown as { spec_groups: Array<{ title_ar: string; rows: Array<Record<string, unknown>> }> };

  const rows = out.spec_groups.flatMap((g) => g.rows);
  const byLabel = new Map(rows.map((r) => [String(r.label_en), r]));

  assert.equal(byLabel.get('Maximum acceleration')?.value_en, '10000');
  // The unit rides along from the definition rather than being typed into the
  // value, so «mm/s²» cannot be spelled two ways across two products.
  assert.equal(byLabel.get('Maximum acceleration')?.unit, 'mm/s²');
  assert.equal(byLabel.get('Supported nozzle sizes')?.value_en, '0.2 / 0.4 / 0.6 / 0.8');
  assert.equal(byLabel.get('AMS compatibility')?.value_en, 'AMS lite');
  assert.equal(byLabel.get('Camera resolution')?.value_en, '1080p');
  assert.equal(byLabel.get('Companion app')?.value_en, 'Bambu Handy');
  // Arabic labels come from the same definition the admin form renders.
  assert.equal(byLabel.get('Maximum acceleration')?.label_ar, 'أقصى تسارع');
});

test('an empty spec field produces no row, and in_the_box is not duplicated', () => {
  const out = projectPublic(
    printerDoc({ max_acceleration: '', build_plate: '   ', in_the_box: 'Spool\nNozzle' })
  ) as unknown as { spec_groups: unknown[] };
  // The page renders in_the_box as bullets under the gallery; repeating it in
  // the table would show the same text twice.
  assert.deepEqual(out.spec_groups, []);
});

test('a spec key the definitions no longer carry is dropped, not shown raw', () => {
  const out = projectPublic(printerDoc({ some_removed_field: 'x' })) as unknown as {
    spec_groups: unknown[];
  };
  assert.deepEqual(out.spec_groups, []);
});

test('hand-authored spec groups keep their place ahead of the derived ones', () => {
  const doc = printerDoc({ max_acceleration: '10000' });
  doc.spec_groups = [
    {
      id: 'sg_manual',
      title_ar: 'يدوي',
      title_en: 'Manual',
      title_ckb: 'Manual',
      order: 0,
      rows: [],
    },
  ];
  const out = projectPublic(doc) as unknown as { spec_groups: Array<{ id: string }> };
  assert.equal(out.spec_groups[0].id, 'sg_manual');
  assert.equal(out.spec_groups.length, 2);
});

// ---------------------------------------------------------------------------
// THE SPEC TABLE IS SENT ONCE (speed audit 2026-10-16, finding 24).
//
// The public detail carried the table twice: `spec_groups` (three languages,
// what the page draws) and the legacy flat `specifications` copy of the same
// rows, which the page draws only when `spec_groups` has no row. On a printer
// that second copy was ~30 KB of the preloaded detail, never drawn.
// ---------------------------------------------------------------------------

/** A hand-typed table: `groups` groups of `rows` rows, every value a unique marker. */
function tableRows(groups: number, rows: number) {
  return Array.from({ length: groups }, (_, gi) => ({
    id: `sg_${gi}`,
    title_ar: `مجموعة ${gi}`,
    title_en: `Group ${gi}`,
    title_ckb: `گرووپی ${gi}`,
    order: gi,
    rows: Array.from({ length: rows }, (_, ri) => ({
      id: `sr_${gi}_${ri}`,
      label_ar: `الخاصية ${gi}-${ri}`,
      label_en: `Property ${gi}-${ri}`,
      label_ckb: `تایبەتمەندی ${gi}-${ri}`,
      value_ar: `VALUE-MARK-${gi}-${ri} قيمة`,
      value_en: `VALUE-MARK-${gi}-${ri} value`,
      value_ckb: `VALUE-MARK-${gi}-${ri} بەها`,
      unit: 'mm',
      order: ri,
    })),
  }));
}

test('a product with a spec table publishes it once — the flat legacy copy is empty', () => {
  const doc = printerDoc({});
  doc.spec_groups = tableRows(3, 4) as ProductDoc['spec_groups'];
  const out = productDocumentPublic(doc) as { spec_groups: Array<{ rows: unknown[] }>; specifications: unknown[] };
  assert.deepEqual(out.specifications, [], 'the flat copy of the table rode along');
  assert.equal(out.spec_groups.flatMap((g) => g.rows).length, 12, 'the table the page draws is whole');
  // The derived family groups alone are a table too: no flat copy of those either (it never held them).
  const derived = productDocumentPublic(printerDoc({ max_acceleration: '10000' })) as { spec_groups: Array<{ rows: unknown[] }>; specifications: unknown[] };
  assert.ok(derived.spec_groups.some((g) => g.rows.length > 0));
  assert.deepEqual(derived.specifications, []);
  // A legacy flat table (`[{key, value}]` in the column) is upgraded into a group — and so sent once too.
  const legacy = parseProductRow({ id: 'prd_l', slug: 'l', status: 'active', name_en: 'L', price_iqd: 1, specifications: JSON.stringify([{ key: 'الوزن', value: '5 kg' }]) });
  const legacyOut = productDocumentPublic(legacy) as { spec_groups: Array<{ rows: Array<{ label_ar: string; value_ar: string }> }>; specifications: unknown[] };
  assert.deepEqual(legacyOut.specifications, []);
  assert.deepEqual(legacyOut.spec_groups[0].rows.map((r) => [r.label_ar, r.value_ar]), [['الوزن', '5 kg']]);
});

test('the flat list still rides wherever the page would read it: no group has a row', () => {
  const doc = printerDoc({});
  doc.spec_groups = [{ id: 'sg_empty', title_ar: 'فارغة', title_en: 'Empty', title_ckb: 'بەتاڵ', order: 0, rows: [] }];
  const out = productDocumentPublic(doc) as { spec_groups: Array<{ rows: unknown[] }>; specifications: unknown[] };
  assert.equal(out.spec_groups.some((g) => g.rows.length > 0), false);
  assert.ok(Array.isArray(out.specifications), 'the key stays an array for every reader that iterates it');
  assert.deepEqual(out.specifications, [], 'and it is what the legacy view of no rows is');
  // The admin document keeps its flat view (the editor and the exports are not on the shop's critical path).
  const admin = productDocumentPublic(Object.assign(printerDoc({}), { spec_groups: tableRows(1, 2) }), { includeInternal: true }) as { specifications: unknown[] };
  assert.equal(admin.specifications.length, 2);
});

test('the product page draws spec_groups first and the flat list only when no group has a row', () => {
  // The rule the server's `publicSpecifications` mirrors; if the page ever preferred the flat list, an empty one would hide the table.
  const src = readFileSync(join(ROOT, 'src/pages/Product.tsx'), 'utf8');
  assert.ok(src.includes('const specGroups = (product.spec_groups ?? []).filter((g) => (g.rows ?? []).length > 0);'));
  assert.ok(src.includes('const legacySpecs = product.specifications ?? [];'));
  assert.match(src, /\{specGroups\.length > 0 \? \(\s*<div className="space-y-4">\s*\{specGroups\.map/);
});

test('through the detail route: every value of the table is in the answer exactly once', async () => {
  const raw = freshDb();
  seedLiveCatalog(raw);
  raw.prepare('UPDATE products SET specifications = ? WHERE slug = ?').run(JSON.stringify(tableRows(4, 10)), 'bambu-lab-x2d');
  const app = stubApp(asD1(raw), null, (a) => a.route('/api/products', productRoutes));
  const res = await get(app, '/api/products/bambu-lab-x2d');
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text) as { product: { spec_groups: Array<{ rows: unknown[] }>; specifications: unknown[] } };
  assert.deepEqual(body.product.specifications, []);
  assert.ok(body.product.spec_groups.flatMap((g) => g.rows).length >= 40);
  for (const mark of ['VALUE-MARK-0-0 قيمة', 'VALUE-MARK-3-9 قيمة', 'الخاصية 2-5']) {
    assert.equal(text.split(mark).length - 1, 1, `«${mark}» is in the detail ${text.split(mark).length - 1} times`);
  }
});
