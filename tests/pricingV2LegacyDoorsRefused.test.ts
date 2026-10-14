/**
 * THE LEGACY DOORS ARE CLOSED (spec addendum A.6, A.12.4; DECISIONS row 222).
 *
 * Every V1 pricing door answers 409 PRICING_V2_MANAGED naming the form
 * section, for a product still in the «يحتاج تسعيرًا» queue AND for a
 * V2-published one; the product, relations and order-type saves keep every
 * stored dinar field and refuse a moved one by name; the planner pins the
 * legacy money of every other writer (TXT, template, CSV) and names what it
 * kept; a fixed or PLUS offer price on an ordinary product is refused.
 *
 * LOCAL ONLY: in-memory SQLite, no network.
 *
 * Run: node --import tsx --test tests/pricingV2LegacyDoorsRefused.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, OWNER, row, send, stubApp } from './fixtures/app';
import { seedLegacyCatalogue, seedProfileRates } from './fixtures/legacyCatalogue';
import { publishV2 } from './fixtures/v2Publish';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { adminProductRelationsRoutes } from '../worker/routes/adminProductRelations';
import { adminPriceGridRoutes } from '../worker/routes/adminPriceGrid';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { adminOffersRoutes } from '../worker/routes/offers';
import { planProductSave } from '../worker/lib/productPersistence';
import { parseProductRow } from '../worker/lib/productModel';

/** `row` for a row the test itself just wrote (never absent). */
const one = <T = Record<string, unknown>>(...a: Parameters<typeof row>): T => row<T>(...a)!;

const PID = 'lp_08';

async function world(v2: boolean) {
  const raw = freshDb();
  seedLegacyCatalogue(raw);
  seedProfileRates(raw);
  if (v2) await publishV2(raw, PID);
  const db = asD1(raw);
  const app = stubApp(
    db,
    OWNER,
    (a) => {
      a.route('/api/admin/products-v2', adminProductsRoutes);
      a.route('/api/admin/products', adminProductRelationsRoutes);
      a.route('/api/admin/products', adminPriceGridRoutes);
      a.route('/api/admin/pricing', adminPricingRoutes);
      a.route('/api/admin/offers', adminOffersRoutes);
    },
    { publishV2: false }
  );
  return { raw, db, app };
}

const managed = async (res: Response, section: 3 | 5, what: string) => {
  const body = await json(res);
  assert.equal(res.status, 409, `${what}: ${JSON.stringify(body).slice(0, 200)}`);
  assert.equal(body.code, 'PRICING_V2_MANAGED', what);
  assert.equal(body.details?.section, section, what);
  return body;
};

for (const v2 of [false, true]) {
  const label = v2 ? 'a V2 product' : 'a product that needs pricing';

  test(`every V1 pricing door answers PRICING_V2_MANAGED with its section — ${label}`, async () => {
    const { app } = await world(v2);
    const calls: Array<[string, string, unknown, 3 | 5]> = [
      ['GET', `/api/admin/pricing/products/${PID}`, undefined, 3],
      ['POST', `/api/admin/pricing/products/${PID}/what-if`, { supplier_cost: '500', currency: 'EUR' }, 3],
      ['GET', `/api/admin/pricing/products/${PID}/rules`, undefined, 3],
      ['PUT', `/api/admin/pricing/products/${PID}/rules`, { rules: [] }, 3],
      ['GET', `/api/admin/pricing/products/${PID}/inputs`, undefined, 3],
      ['PUT', `/api/admin/pricing/products/${PID}/inputs`, { inputs_seq: 0 }, 3],
      ['POST', `/api/admin/pricing/products/${PID}/preview`, {}, 3],
      ['POST', `/api/admin/pricing/products/${PID}/apply-purchase`, {}, 3],
      ['GET', '/api/admin/pricing/save-list', undefined, 3],
      ['POST', '/api/admin/pricing/products/save-bulk', { items: [] }, 3],
      ['POST', `/api/admin/pricing/products/${PID}/manual`, {}, 3],
      ['POST', `/api/admin/pricing/products/${PID}/targets/adopt`, {}, 3],
      ['GET', `/api/admin/products/${PID}/price-grid`, undefined, 3],
      ['PATCH', `/api/admin/products/${PID}/price-grid`, { cells: [] }, 3],
      ['PATCH', `/api/admin/products/${PID}/price-grid/traits`, { traits: [] }, 5],
      ['POST', `/api/admin/products/${PID}/price-grid/bulk`, {}, 3],
      ['POST', `/api/admin/products-v2/${PID}/reprice`, { mode: 'delta', from_price_iqd: 1, to_price_iqd: 2 }, 3],
      ['POST', `/api/admin/products-v2/${PID}/selection-price`, {}, 5],
    ];
    for (const [method, path, body, section] of calls) await managed(await (method === 'GET' ? get(app, path) : send(app, method, path, body)), section, `${method} ${path}`);
    const overview = await json(await get(app, '/api/admin/pricing/overview'));
    assert.equal(overview.success, true);
    assert.deepEqual(Object.keys(overview.v2).sort(), ['compositions', 'needs_pricing', 'published', 'saved']);
  });

  test(`the product save keeps every stored dinar field and refuses a moved one by name — ${label}`, async () => {
    const { raw, app } = await world(v2);
    const before = one<{ price_iqd: number; pro_price_iqd: number | null }>(raw, 'SELECT price_iqd, pro_price_iqd FROM products WHERE id = ?', PID);
    const doc = (await json(await get(app, `/api/admin/products-v2/${PID}`))).product as Record<string, unknown>;
    const moved = await managed(await send(app, 'POST', '/api/admin/products-v2', { ...doc, price_iqd: Number(doc.price_iqd) + 1000 }), 3, 'a moved price');
    assert.equal(moved.details.field, 'doc.price_iqd');
    assert.doesNotMatch(JSON.stringify(moved), new RegExp(String(Number(doc.price_iqd) + 1000)), 'the refusal names the field, never the value');
    // Without the dinar keys at all, the description saves and every stored price stays.
    const stripped = Object.fromEntries(Object.entries(doc).filter(([k]) => !/(^|_)(price_iqd|adjust_iqd|cost_iqd|surcharge_iqd)$/.test(k)));
    const saved = await send(app, 'POST', '/api/admin/products-v2', { ...stripped, description_en: 'A new description' });
    assert.equal(saved.status, 200, JSON.stringify(await json(saved.clone())).slice(0, 300));
    const after = one<{ price_iqd: number; pro_price_iqd: number | null }>(raw, 'SELECT price_iqd, pro_price_iqd FROM products WHERE id = ?', PID);
    assert.deepEqual(after, before);
  });

  test(`the relations door refuses a moved option price (section ٥) and keeps an absent one — ${label}`, async () => {
    const { raw, app } = await world(v2);
    const rel = await json(await get(app, `/api/admin/products/${PID}/relations`));
    // The editor's PUT shape: each group carries its values (the GET answers them flat).
    const groups = (rel.groups as Array<Record<string, unknown>>).map((g) => ({ ...g, values: (rel.values as Array<Record<string, unknown>>).filter((v) => v.group_id === g.id) }));
    const body = { groups, colors: rel.colors };
    const value = groups[0]!.values[0]!;
    const storedPrice = one<{ p: number | null }>(raw, 'SELECT regular_price_iqd AS p FROM product_option_values WHERE id = ?', value.id).p;
    value.regular_price_iqd = (Number(storedPrice ?? 0) || 100000) + 5000;
    const res = await managed(await send(app, 'PUT', `/api/admin/products/${PID}/relations`, body), 5, 'a moved option price');
    assert.equal(res.details.field, `values.${String(value.id)}.regular_price_iqd`);
    assert.equal(one<{ p: number | null }>(raw, 'SELECT regular_price_iqd AS p FROM product_option_values WHERE id = ?', value.id).p, storedPrice);
  });
}

test('the planner pins legacy money for every other writer and names what it kept (TXT, template, CSV)', async () => {
  const { raw, db } = await world(false);
  const prev = parseProductRow(one<Record<string, unknown>>(raw, 'SELECT * FROM products WHERE id = ?', PID));
  const doc = { ...prev, price_iqd: prev.price_iqd + 7000, original_price_iqd: 999000 };
  const plan = await planProductSave(db, { mode: 'update', doc, prev, relations: null, actor: { adminId: 'usr_owner', money: true } });
  assert.deepEqual(plan.moneyPinned.sort(), ['doc.original_price_iqd', 'doc.price_iqd']);
  assert.equal(plan.doc!.price_iqd, prev.price_iqd);
  assert.ok(plan.warnings.some((w) => w.startsWith('PRICING_V2_MANAGED')));
});

test('a fixed or PLUS offer price on an ordinary product is refused (section ٣); a percent offer stays', async () => {
  const { app } = await world(true);
  await managed(await send(app, 'PUT', `/api/admin/offers/${PID}`, { offer_price_mode: 'fixed', offer_price_iqd: 100000, active: true }), 3, 'a fixed offer price');
  await managed(await send(app, 'PUT', `/api/admin/offers/${PID}`, { plus_price_iqd: 90000, active: true }), 3, 'a PLUS price');
  const percent = await send(app, 'PUT', `/api/admin/offers/${PID}`, { offer_price_mode: 'discount_percent', discount_percent: 10, active: true });
  assert.equal(percent.status, 200, JSON.stringify(await json(percent.clone())).slice(0, 200));
});
