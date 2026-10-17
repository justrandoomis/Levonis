/**
 * THE PLAIN LISTING DID NOT MOVE (catalog discovery S1 acceptance).
 *
 * `/api/products` gained sort, filters and facet counts. A request that uses
 * none of them must answer exactly what it answered before — same products,
 * same order, same prices, same paging — except for the three card fields the
 * listing now carries (`sale_types`, `created_at`, `compare_type`) and the
 * category's new `path`.
 *
 * tests/fixtures/snapshots/productsListing.baseline.json was captured from the
 * route BEFORE this change, over the live catalogue of 2026-09-25
 * (tests/fixtures/liveCatalog.ts). It is a regression oracle: regenerate it only
 * for a deliberate change to the plain listing.
 *
 * Run: node --import tsx --test tests/productsListingSnapshot.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { asD1, freshDb, get, json, proOnSale, stubApp } from './fixtures/app';
import { seedLiveCatalog } from './fixtures/liveCatalog';
import { productRoutes } from '../worker/routes/products';

// `price_status` (DECISIONS row 240): every card says whether it is priced; the snapshot predates it.
// `section_name` and `key_specs` (the Bambu import spec §G.5): the card's knowledge line, from the row and the
// taxonomy the listing already holds — asserted in the test below and in tests/productCardKnowledge.test.ts.
// `display_offer_before_iqd` and `display_offer_saving_percent` (docs/ux/PRODUCT-DISCOUNT.md §8.1): the struck
// price of a live offer and its «−N٪» — null on every card here, since the live catalogue has no offer window
// (asserted below before they are set aside).
const NEW_CARD_FIELDS = [
  'sale_types',
  'created_at',
  'compare_type',
  'price_status',
  'section_name',
  'key_specs',
  'display_offer_before_iqd',
  'display_offer_saving_percent',
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withoutNewFields(body: Record<string, any>) {
  const out = { ...body };
  if (Array.isArray(out.products)) {
    out.products = out.products.map((p: Record<string, unknown>) => {
      const c = { ...p };
      for (const k of NEW_CARD_FIELDS) delete c[k];
      return c;
    });
  }
  if (out.category && typeof out.category === 'object') {
    const { path: _path, ...rest } = out.category as Record<string, unknown>;
    void _path;
    out.category = rest;
  }
  return out;
}

/**
 * ONE DELIBERATE CHANGE SINCE THE BASELINE, applied to it rather than
 * regenerated over it: PREMIUM carries no member price since migration 0145
 * («اشتراك البريميوم لا يحمل خصومات»), so every card's PREMIUM teaser is null.
 * Everything else — PRO's teaser included, with PRO on sale — is still held
 * to the captured answer.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withoutPremiumTeasers(body: any): any {
  if (!body || typeof body !== 'object') return body;
  const out = { ...body };
  if (Array.isArray(out.products)) {
    out.products = out.products.map((p: Record<string, unknown>) =>
      'display_prime_iqd' in p ? { ...p, display_prime_iqd: null } : p
    );
  }
  return out;
}

/**
 * THE CLEAN START (DECISIONS row 222, addendum A.12.1), also applied to the baseline rather than regenerated
 * over it: every product is priced in dollars, so each dinar price is its old one reproduced at the fixture
 * rate — an off-step price moves up to the next 1,000 — and no typed PRO rung survives the first V2 price
 * (the live catalogue has no PRO rule, so no card carries a PRO teaser). Order, paging and every other field
 * are still held to the captured answer.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asCleanStart(body: any): any {
  if (!body || typeof body !== 'object') return body;
  const out = { ...body };
  const step = (v: unknown) => (typeof v === 'number' && v > 0 ? Math.ceil(v / 1000) * 1000 : v);
  if (Array.isArray(out.products)) {
    out.products = out.products.map((p: Record<string, unknown>) => ({
      ...p,
      ...('price_iqd' in p ? { price_iqd: step(p.price_iqd) } : {}),
      ...('display_price_iqd' in p ? { display_price_iqd: step(p.display_price_iqd) } : {}),
      ...('display_regular_iqd' in p ? { display_regular_iqd: step(p.display_regular_iqd) } : {}),
      ...('display_pro_iqd' in p ? { display_pro_iqd: null } : {}),
    }));
  }
  return out;
}

test('every plain listing request answers what it answered before, minus the new card fields', async () => {
  const baseline = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/snapshots/productsListing.baseline.json'), 'utf8')) as Record<string, unknown>;
  // The PRO teaser is compared as it reads while PRO is sold; the pause that
  // hides it is proven in tests/proPause.test.ts and tierPriceDisclosure.
  const raw = proOnSale(freshDb());
  seedLiveCatalog(raw);
  const app = stubApp(asD1(raw), null, (a) => a.route('/api/products', productRoutes));
  assert.ok(Object.keys(baseline).length >= 6);
  for (const [path, expected] of Object.entries(baseline)) {
    const body = await json(await get(app, path));
    for (const p of (body.products ?? []) as Array<Record<string, unknown>>) {
      assert.deepEqual([p.display_offer_before_iqd, p.display_offer_saving_percent], [null, null], `${path} ${String(p.id)}: no offer, no strike`);
    }
    assert.deepEqual(withoutNewFields(body), asCleanStart(withoutPremiumTeasers(expected)), path);
  }
});

test('the new card fields are there, and say what the row says', async () => {
  const raw = freshDb();
  seedLiveCatalog(raw);
  const app = stubApp(asD1(raw), null, (a) => a.route('/api/products', productRoutes));
  const body = await json(await get(app, '/api/products?category=cat_printers_fdm'));
  const x2d = body.products.find((p: { slug: string }) => p.slug === 'bambu-lab-x2d');
  assert.deepEqual(x2d.sale_types, ['direct_sale', 'pre_order']);
  assert.equal(x2d.compare_type, 'printer');
  assert.match(x2d.created_at, /^2026-09-20T10:/);
  assert.equal(body.category.path, '/categories/printers/fdm-printers', 'an old ?category= link can replace to this');
  const root = await json(await get(app, '/api/products?category=printers'));
  assert.equal(root.category.path, '/categories/printers');
  const pla = (await json(await get(app, '/api/products?category=cat_materials'))).products[0];
  assert.equal(pla.compare_type, 'filament');
  // The card's knowledge line (§G.5): the section it is filed in, the registry's card keys for its type, then
  // the printer's enclosure and colours worded in three languages (worker/lib/knowledge/cards.ts CARD_FIELDS).
  assert.deepEqual(x2d.key_specs, [
    '256 × 256 × 260 mm (Main nozzle)',
    { ar: 'هيكل مغلق', en: 'Enclosed', ckb: 'لەشی داخراو' },
    { ar: 'حتى 25 لونًا', en: 'Up to 25 colours', ckb: 'تا 25 ڕەنگ' },
  ]);
  assert.equal(x2d.section_name.en, 'FDM Printers');
  assert.deepEqual(pla.key_specs, ['PLA', '1.75 mm', '1,000 g']);
  // No listing parameter → no listing envelope.
  assert.equal('total' in body, false);
  assert.equal('facets' in body, false);
});
