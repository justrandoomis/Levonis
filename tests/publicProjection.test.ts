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
import { parseProductRow, primaryMediaFirst, projectPublic } from '../worker/lib/productModel';
import type { MediaV2, ProductDoc } from '../worker/lib/productModel';

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
  return parseProductRow({
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

test('and it still carries the selling prices and adjustments it should', () => {
  const out = projectPublic(docWithCosts()) as unknown as {
    options: Array<Record<string, unknown>>;
    colors: Array<Record<string, unknown>>;
  };
  // The stripper must remove cost, not everything: an option's own selling
  // price and its ADJUSTMENT are what the resolver needs downstream.
  assert.equal(out.options[0].regular_price_iqd, 100_000);
  assert.equal(out.options[0].regular_adjust_iqd, 5_000);
  assert.equal(out.colors[0].pro_price_iqd, 90_000);
});

function media(id: string, order: number, primary = false): MediaV2 {
  return {
    id,
    url: `https://cdn.example.com/${id}.jpg`,
    key: '',
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
