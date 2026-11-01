/**
 * PAST ENGINE_MAX_SKUS, A COMBINATION A PRODUCT DOES NOT SELL IS STILL «NOT
 * AVAILABLE», NEVER «طلب السعر» (review r3-unoffered-large; docs/SMART_PRICING.md
 * §3.5 rule 3).
 *
 * A VARIANT_COMBINATION grid past ENGINE_MAX_SKUS is counted on the cells it
 * keeps (`sellableSkus` → `stockedPastLimit`, at most ENGINE_MAX_SKUS), so the
 * page body does not list the combinations it leaves out (`unoffered_selections`
 * is absent there). It lists the SKUs it sells instead, `offered_selections`:
 *
 *   - `offeredPastLimitKeys` is exactly the kept set, and only for such a grid:
 *     empty under ENGINE_MAX_SKUS (the left-out list covers it), for another
 *     mode, with no active row, and when the kept cells pass the limit;
 *   - the page body carries it on a priced and on a catalog-only product, and
 *     every other body is unchanged;
 *   - the page's rule — a selection that is part of no SKU in the list is not
 *     offered — is exactly «طلب السعر»'s refusal (SELECTION_INVALID), over every
 *     selection the plain chooser can form;
 *   - the page reads the list, and the rule feeds the one `selectionUnoffered`
 *     (no quote, no figure, no «طلب السعر») and the colour rows.
 *
 * Run: node --import tsx --test tests/priceEstimateStorefrontOffered.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, freshDb, get, json, post, stubApp, type StubUser } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { pricingWorld } from './fixtures/procurementPricing';
import { writeV2 } from './fixtures/pricingV2';
import { loadProducts } from '../worker/lib/pricingEngine/load';
import { sellableSkus } from '../worker/lib/pricingEngine/legacy';
import { offeredPastLimitKeys, unofferedSkuKeys } from '../worker/lib/commercialState';
import { productRoutes } from '../worker/routes/products';
import { priceRequestRoutes } from '../worker/routes/priceRequests';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const CUSTOMER: StubUser = { id: 'usr_cust', role: 'customer', email: 'c@x.co' };
const k = (...ids: string[]) => [...ids].sort().map((id) => `o:${id}`).join('|');
const A = Array.from({ length: 20 }, (_, i) => `a${i + 1}`);
const B = Array.from({ length: 13 }, (_, i) => `b${i + 1}`);
/** 20 × 13 = 260 cells, stocked on 32 rows: a1..a20 · b1 and a1 · b2..b13. The other 228 cells are left out. */
const STOCKED = [...A.map((a) => [a, 'b1']), ...B.slice(1).map((b) => ['a1', b])];

/** An owner-built product past ENGINE_MAX_SKUS (two groups, no colours), sold by pre-order over land. */
function seedBig(raw: DatabaseSync, id: string, rows: string[][] = STOCKED): void {
  raw.exec(`INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode,
                        package_weight_g, package_depth_mm, package_width_mm, package_height_mm)
    VALUES ('${id}', '${id}', 'Big', 'كبير', 'گەورە', 'active', 0, NULL, 'pre_order', '["pre_order"]',
            '[{"method":"land","commission_iqd":0,"active":true}]', 'VARIANT_COMBINATION', 1000, 400, 300, 200);
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('${id}_ga', '${id}', 'A', 0, 1), ('${id}_gb', '${id}', 'B', 1, 1);`);
  A.forEach((a, i) => raw.exec(`INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES ('${id}_${a}', '${id}', '${id}_ga', '${a}', ${i}, 1)`));
  B.forEach((b, i) => raw.exec(`INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES ('${id}_${b}', '${id}', '${id}_gb', '${b}', ${i}, 1)`));
  rows.forEach((r, i) => raw.exec(`INSERT INTO product_variants (id, product_id, combo_key, active) VALUES ('${id}_pv${i}', '${id}', '${k(...r.map((v) => `${id}_${v}`))}', 1)`));
  for (const a of A) {
    raw.exec(`INSERT INTO product_option_fulfillment (id, product_id, option_id, fulfillment_type, enabled) VALUES ('${id}_f_${a}', '${id}', '${id}_${a}', 'pre_order', 1);
      INSERT INTO product_option_transports (id, product_id, fulfillment_id, method, enabled) VALUES ('${id}_t_${a}', '${id}', '${id}_f_${a}', 'land', 1);`);
  }
}

/** The page's rule, written as src/pages/Product.tsx writes it (pinned below). */
const outsideOffered = (offered: readonly string[], key: string): boolean =>
  offered.length > 0 && key !== '' && !offered.some((sku) => key.split('|').every((part) => sku.split('|').includes(part)));

// ---------------------------------------------------------------- the list

test('offeredPastLimitKeys: the SKUs a grid past ENGINE_MAX_SKUS keeps — and nothing for any other product', async () => {
  const raw = freshDb();
  seedBig(raw, 'pg');
  // Every cell stocked: the kept set passes the limit and overflows, as before.
  seedBig(raw, 'pa', A.flatMap((a) => B.map((b) => [a, b])));
  seedBig(raw, 'pn');
  raw.exec("UPDATE product_variants SET active = 0 WHERE product_id = 'pn'");
  seedBig(raw, 'po');
  raw.exec("UPDATE products SET inventory_mode = 'OPTION' WHERE id = 'po'");
  const loaded = await loadProducts(asD1(raw), ['pg', 'pa', 'pn', 'po']);
  const of = (id: string) => offeredPastLimitKeys(loaded.get(id)!.doc, loaded.get(id)!.view);
  const { doc, view } = loaded.get('pg')!;
  assert.equal(sellableSkus(doc, { ...view!, variants: [] }).overflow, true, 'the whole grid is past ENGINE_MAX_SKUS');
  assert.deepEqual(unofferedSkuKeys(doc, view), [], 'the left-out cells are not listed there');
  assert.deepEqual(new Set(of('pg')), new Set(STOCKED.map((r) => k(...r.map((v) => `pg_${v}`)))), 'the 32 stocked cells');
  assert.equal(of('pg').length, 32);
  assert.deepEqual(of('pa'), [], 'every cell stocked: past the limit, as before');
  assert.deepEqual(of('pn'), [], 'no active row');
  assert.deepEqual(of('po'), [], 'another inventory mode');
  // Under the limit the left-out list answers: no second list.
  raw.exec(`INSERT INTO products (id, slug, name, status, price_iqd, inventory_mode) VALUES ('ps', 'ps', 'Small', 'active', 0, 'VARIANT_COMBINATION');
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('ps_ga', 'ps', 'A', 0, 1), ('ps_gb', 'ps', 'B', 1, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active) VALUES
      ('ps_a1', 'ps', 'ps_ga', 'A1', 0, 1), ('ps_a2', 'ps', 'ps_ga', 'A2', 1, 1), ('ps_b1', 'ps', 'ps_gb', 'B1', 0, 1), ('ps_b2', 'ps', 'ps_gb', 'B2', 1, 1);
    INSERT INTO product_variants (id, product_id, combo_key, active) VALUES ('ps_v1', 'ps', '${k('ps_a1', 'ps_b1')}', 1), ('ps_v2', 'ps', '${k('ps_a2', 'ps_b2')}', 1);`);
  const small = (await loadProducts(asD1(raw), ['ps'])).get('ps')!;
  assert.deepEqual(offeredPastLimitKeys(small.doc, small.view), []);
  assert.equal(unofferedSkuKeys(small.doc, small.view).length, 2);
});

// ---------------------------------------------------------------- the page body and the request door

async function shop() {
  const w = pricingWorld();
  w.raw.exec("INSERT OR IGNORE INTO users (id, email, role) VALUES ('usr_cust', 'c@x.co', 'customer')");
  const app = stubApp(
    asD1(w.raw),
    CUSTOMER,
    (a) => {
      a.route('/api/products', productRoutes);
      a.route('/api/price-requests', priceRequestRoutes);
    },
    { publishV2: false }
  );
  return { ...w, app };
}

test('past ENGINE_MAX_SKUS the page body lists the SKUs it sells, and a selection part of none is exactly one «طلب السعر» refuses', async () => {
  const w = await shop();
  seedBig(w.raw, 'ph');
  seedBig(w.raw, 'pu');
  await writeV2(w.db, 'ph', { method: 'usd', points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '10' }] });
  // a1·b13 loses its price: b13 is then in no priced SKU (its level is null), the dead end the page took before.
  w.raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('engine-price:ph', 1);
    DELETE FROM product_sku_prices WHERE product_id = 'ph' AND combo_key = '${k('ph_a1', 'ph_b13')}';
    DELETE FROM ops_guards WHERE id = 'engine-price:ph';`);
  for (const [id, status] of [['ph', 'priced'], ['pu', 'unpriced']] as const) {
    w.raw.exec('DELETE FROM rate_limits');
    const page = (await json(await get(w.app, `/api/products/${id}`))) as Json;
    assert.equal(page.price_status, status, id);
    assert.equal('unoffered_selections' in page, false, `${id}: not listed past the limit`);
    const offered: string[] = page.offered_selections;
    assert.deepEqual(new Set(offered), new Set(STOCKED.map((r) => k(...r.map((v) => `${id}_${v}`)))), `${id}: the 32 SKUs it sells`);
    if (status === 'priced') {
      assert.deepEqual(page.unpriced_selections, [k('ph_a1', 'ph_b13')]);
      assert.equal(page.price_levels.option.ph_b13, null, 'b13 has no priced SKU: the page used to jump to «طلب السعر» on it');
    }
    // Every value alone, nothing chosen, and every cell of a1, a2 and a20: the page's rule is the door's refusal.
    const sels: string[][] = [[], ...[...A, ...B].map((v) => [`${id}_${v}`]), ...['a1', 'a2', 'a20'].flatMap((a) => B.map((b) => [`${id}_${a}`, `${id}_${b}`]))];
    let notOffered = 0;
    for (const sel of sels) {
      w.raw.exec('DELETE FROM rate_limits; DELETE FROM product_price_requests; DELETE FROM product_price_request_stats');
      const res = await post(w.app, '/api/price-requests', { product_id: id, option_value_ids: sel });
      const code = res.status === 200 ? 'ok' : ((await json(res)) as Json).code;
      const not = outsideOffered(offered, k(...sel));
      if (not) notOffered += 1;
      assert.equal(not, code === 'PRICE_REQUEST_SELECTION_INVALID', `${id} ${sel.join('·') || '(nothing)'}: page ${not}, door ${code}`);
    }
    assert.equal(notOffered, 24, 'a2 and a20 with b2..b13');
    assert.equal(outsideOffered(offered, k(`${id}_a2`, `${id}_b13`)), true, 'the old dead end: not offered');
    assert.equal(outsideOffered(offered, k(`${id}_a1`, `${id}_b13`)), false, 'a SKU it sells (unpriced on ph: «طلب السعر» takes it)');
  }
});

test('every body under the limit, and every other mode, carries no such list', async () => {
  const w = await shop();
  // The census as the live site publishes it (every VARIANT_COMBINATION product has a row for every cell, ≤ 60 cells).
  const app = stubApp(asD1(w.raw), CUSTOMER, (a) => a.route('/api/products', productRoutes));
  const slugs = (w.raw.prepare('SELECT slug FROM products ORDER BY id').all() as Array<{ slug: string }>).map((r) => r.slug);
  assert.equal(slugs.length, 41);
  for (const slug of slugs) {
    w.raw.exec('DELETE FROM rate_limits');
    const res = await get(app, `/api/products/${slug}`);
    assert.equal(res.status, 200, slug);
    const page = (await json(res)) as Json;
    assert.equal('offered_selections' in page, false, slug);
    assert.equal('unoffered_selections' in page, false, slug);
  }
});

// ---------------------------------------------------------------- the page

test('the page reads the list, and a selection part of no SKU in it is not offered — the one rule for the page and its colour rows', () => {
  const page = readFileSync(join(ROOT, 'src/pages/Product.tsx'), 'utf8');
  assert.match(page, /offered_selections\?: string\[\];/);
  assert.match(page, /setOfferedSelections\(Array\.isArray\(data\.offered_selections\) \? data\.offered_selections : \[\]\);/);
  // The rule the test above checks against «طلب السعر», as the page writes it.
  assert.ok(
    page.includes(
      'const outsideOffered = (offered: readonly string[], key: string): boolean =>\n' +
        "  offered.length > 0 && key !== '' && !offered.some((sku) => key.split('|').every((part) => sku.split('|').includes(part)));"
    ),
    'the page states the rule this test runs'
  );
  assert.match(page, /const selectionUnoffered = unofferedSelections\.includes\(selectionKey\) \|\| outsideOffered\(offeredSelections, selectionKey\);/);
  assert.match(page, /const rowUnoffered = \(key: string\): boolean => unofferedSelections\.includes\(key\) \|\| outsideOffered\(offeredSelections, key\);/);
  // `selectionUnoffered` comes before the shortcut to «طلب السعر», so a left-out cell never takes it.
  assert.match(page, /const choiceUnpriced =\s*!catalogOnly &&\s*!selectionUnoffered &&/);
});
