/**
 * PRICING V2-3b — THE OWNER AND ADMIN V2 PRICING API (spec §4.1-§4.3, §4.6).
 *
 * On the census world (U = 1,600) through the real routes
 * (`/api/admin/products-v2/...`):
 *   - a preview with `product_id: null` and a 2×3 draft (two models, three
 *     colours) with client ids returns the full table and a hash; saving the
 *     product with that hash creates the product, its relations, its dollar
 *     points and its prices in ONE batch, under the client's ids, and the cart
 *     charges exactly the previewed prices;
 *   - a replay of the hash answers `already`; a stale `seq` is PRICING_CHANGED;
 *     a rate moved between preview and apply is PRICING_PREVIEW_STALE;
 *   - above 15% without the tick is PRICING_LARGE_CHANGE_CONFIRM, with the
 *     tick but an old sign-in REAUTH_REQUIRED; a 30% drop is flagged;
 *   - adding a model and switching a route on, on a V2 product, commits the
 *     structure and its prices atomically: a failure injected in the last
 *     statement leaves every table as it was; without the hash the save is
 *     409 PRICING_PREVIEW_REQUIRED carrying the V2 preview, never
 *     ENGINE_MANAGED;
 *   - publishing an incomplete product is PRICING_V2_PRICE_MISSING; a draft
 *     saves its data, born V2 and unsellable;
 *   - every refusal names its section;
 *   - on a database before 0189 (a deploy ahead of it) the V2 reads answer as
 *     for an unmigrated product and every V2 write is PRICING_NOT_INSTALLED.
 *
 * Run: REQUIRE_DIST=1 node --import tsx --test tests/pricingV2Api.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, count, dbThrough, failingD1, get, json, post, put, row, stubApp } from './fixtures/app';
import { legacyProductId, seedLegacyCatalogue } from './fixtures/legacyCatalogue';
import { pricingWorld, AMS, OWNER_USER } from './fixtures/procurementPricing';
import { OWNER_ROW_SQL, applyRate } from './fixtures/fx';
import { cartGrid, v2App, writeV2 } from './fixtures/pricingV2';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { adminProductRelationsRoutes } from '../worker/routes/adminProductRelations';

const MODEL = `${AMS}_o0`;
const fixed = (usd: string) => ({ scope: 'product' as const, scope_id: '', kind: 'fixed' as const, usd });
const off = (usd: string) => ({ scope: 'product' as const, scope_id: '', usd });

async function v2Ams(w: ReturnType<typeof pricingWorld>) {
  return writeV2(w.db, AMS, { method: 'usd', points: [fixed('1000')], discounts: [off('50')] });
}

const point = (usd: string) => ({ scope: 'product', id: '', kind: 'fixed', usd });
const answer = async (res: Response) => ({ status: res.status, body: await json(res) });

/** The add-product draft: two models (client ids), three colours shown with both, direct + land pre-order. */
function newProductBody(id: string, status: 'draft' | 'active' = 'active') {
  const cells = [
    { fulfillment_type: 'direct_sale', enabled: true },
    { fulfillment_type: 'pre_order', enabled: true, transports: [{ method: 'land', enabled: true }] },
  ];
  return {
    doc: {
      id,
      name_ar: 'منتج جديد',
      name_en: 'New V2 product',
      price_iqd: 0,
      status,
      selling_type: 'direct_sale',
      sale_types: ['direct_sale', 'pre_order'],
      stock: null,
    },
    relations: {
      groups: [
        {
          id: `${id}_g`,
          name_en: 'Model',
          values: [
            { id: `${id}_std`, name_en: 'Standard', stock: 4, fulfillments: cells },
            { id: `${id}_pro`, name_en: 'Pro', stock: 3, fulfillments: cells },
          ],
        },
      ],
      colors: [
        { id: `${id}_blk`, name_en: 'Black', hex: '#000000' },
        { id: `${id}_wht`, name_en: 'White', hex: '#ffffff' },
        { id: `${id}_red`, name_en: 'Red', hex: '#ff0000' },
      ],
      images: [],
    },
  };
}

const NEW_PRICING = {
  method: 'usd',
  points: [point('100'), { scope: 'option', id: 'np_pro', kind: 'fixed', usd: '150' }, { scope: 'color', id: 'np_red', kind: 'delta', usd: '5' }],
  discounts: [{ scope: 'product', id: '', usd: '10' }],
};

test('add-product: the draft is priced before the first save, and the save writes product, relations, points and prices in one batch', async () => {
  const w = pricingWorld();
  const app = v2App(w.raw);
  const structure = newProductBody('np');
  const pre = await answer(await post(app, '/api/admin/products-v2/pricing/preview', { product_id: null, structure, pricing: NEW_PRICING }));
  assert.equal(pre.status, 200, JSON.stringify(pre.body).slice(0, 400));
  assert.equal(pre.body.product_id, null, 'a draft has no product yet');
  assert.equal(pre.body.v2, true);
  assert.equal(pre.body.complete, true, JSON.stringify(pre.body.codes));
  assert.match(pre.body.review_hash, /^[0-9a-f]{64}$/);
  // 2 models × 3 colours × (direct + land) — every row under the client's ids.
  assert.equal(pre.body.table.length, 12);
  const price = (combo: string, channel: string) => pre.body.table.find((r: { combo_key: string; channel: string }) => r.combo_key === combo && r.channel === channel)?.price_iqd;
  assert.equal(price('o:np_std|c:np_blk', 'direct_sale'), 160_000);
  assert.equal(price('o:np_std|c:np_blk', 'pre_order_land'), 144_000);
  assert.equal(price('o:np_pro|c:np_wht', 'direct_sale'), 240_000);
  assert.equal(price('o:np_pro|c:np_red', 'direct_sale'), 248_000, 'the colour difference is the same dollars on every model (C1)');
  assert.equal(price('o:np_std|c:np_red', 'pre_order_land'), 152_000);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM products WHERE id = 'np'"), 0, 'a preview writes nothing');

  // The save without the hash: the sheet first (the V2 preview rides on the refusal).
  const bare = await answer(await post(app, '/api/admin/products-v2', { ...structure.doc, relations: structure.relations, pricing_v2: { pricing: NEW_PRICING } }));
  assert.equal(bare.status, 409, JSON.stringify(bare.body).slice(0, 300));
  assert.equal(bare.body.code, 'PRICING_PREVIEW_REQUIRED');
  assert.equal(bare.body.details.section, 3);
  assert.equal(bare.body.details.preview.review_hash, pre.body.review_hash, 'the refusal carries the same preview');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM products WHERE id = 'np'"), 0);

  const saved = await answer(await post(app, '/api/admin/products-v2', { ...structure.doc, relations: structure.relations, pricing_v2: { pricing: NEW_PRICING, preview_hash: pre.body.review_hash } }));
  assert.equal(saved.status, 200, JSON.stringify(saved.body).slice(0, 500));
  assert.equal(saved.body.created, true);
  assert.deepEqual(saved.body.pricing_v2, { priced: true });
  // The client's ids, the method, the points and every SKU row.
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM product_option_values WHERE product_id = 'np' AND id IN ('np_std', 'np_pro')"), 2);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM product_colors WHERE product_id = 'np'"), 3);
  assert.equal(row<{ m: string; mode: string }>(w.raw, "SELECT pricing_method AS m, mode FROM product_pricing_state WHERE product_id = 'np'")?.m, 'usd');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM pricing_price_points WHERE product_id = 'np'"), 3);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM pricing_preorder_discounts WHERE product_id = 'np'"), 1);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM product_sku_prices WHERE product_id = 'np'"), 12);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM pricing_v2_sku_results WHERE product_id = 'np'"), 12);
  // The cart charges exactly the previewed prices; fees 0; the commissions are explicit zeros.
  const grid = await cartGrid(w.db, 'np');
  for (const r of pre.body.table as Array<{ combo_key: string; channel: string; price_iqd: number }>) {
    assert.equal(grid[`${r.combo_key}@${r.channel}`]?.prepaid, r.price_iqd, `${r.combo_key} ${r.channel}`);
    assert.equal(grid[`${r.combo_key}@${r.channel}`]?.fee ?? 0, 0);
  }
  // The same save again (a retry after a timeout): the hash replays, nothing new is written.
  const again = await answer(await post(app, '/api/admin/products-v2', { ...structure.doc, relations: structure.relations, pricing_v2: { pricing: NEW_PRICING, preview_hash: pre.body.review_hash } }));
  assert.equal(again.status, 200, JSON.stringify(again.body).slice(0, 300));
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM pricing_audit WHERE product_id = 'np' AND action = 'engine_entry'"), 1);
});

test('publishing an incomplete product is PRICING_V2_PRICE_MISSING; a draft saves its data, born V2 and unsellable', async () => {
  const w = pricingWorld();
  const app = v2App(w.raw);
  const missing = { method: 'usd', points: [], discounts: [] };
  const live = newProductBody('nq', 'active');
  const refused = await answer(await post(app, '/api/admin/products-v2', { ...live.doc, relations: live.relations, pricing_v2: { pricing: missing } }));
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'PRICING_V2_PRICE_MISSING');
  assert.equal(refused.body.details.section, 3);
  assert.ok(refused.body.details.missing.some((m: { code: string }) => m.code === 'V2_PRICE_MISSING'), JSON.stringify(refused.body.details.missing));
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM products WHERE id = 'nq'"), 0);

  const draft = newProductBody('nq', 'draft');
  const saved = await answer(await post(app, '/api/admin/products-v2', { ...draft.doc, relations: draft.relations, pricing_v2: { pricing: missing } }));
  assert.equal(saved.status, 200, JSON.stringify(saved.body).slice(0, 400));
  assert.deepEqual(saved.body.pricing_v2, { priced: false });
  assert.equal(row<{ m: string }>(w.raw, "SELECT pricing_method AS m FROM product_pricing_state WHERE product_id = 'nq'")?.m, 'usd', 'born V2');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM product_sku_prices WHERE product_id = 'nq'"), 0, 'no price is written');
  const grid = await cartGrid(w.db, 'nq');
  assert.ok(Object.values(grid).every((c) => !c.ok), 'nothing is sellable before it is priced (C-13)');
  const state = await answer(await get(app, '/api/admin/products-v2/nq/pricing'));
  assert.equal(state.body.status.kind, 'missing');
});

test('apply: replay, stale seq, a rate moved, the 15% tick and the fresh sign-in, the 30% drop', async () => {
  const w = pricingWorld();
  await v2Ams(w);
  const app = v2App(w.raw);
  const read = await answer(await get(app, `/api/admin/products-v2/${AMS}/pricing`));
  const seq = read.body.seq;
  const pricing = { points: [point('1100')] };
  const pre = await answer(await post(app, '/api/admin/products-v2/pricing/preview', { product_id: AMS, pricing }));
  assert.equal(pre.body.changes.length, 2);
  assert.equal(pre.body.large_change, false, '10% needs no tick');

  // A stale sequence: a second tab saved since.
  const stale = await answer(await put(app, `/api/admin/products-v2/${AMS}/pricing`, { seq: { ...seq, inputs_seq: seq.inputs_seq - 1 }, pricing, preview_hash: pre.body.review_hash }));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'PRICING_CHANGED');
  assert.equal(stale.body.details.section, 3);

  const ok = await answer(await put(app, `/api/admin/products-v2/${AMS}/pricing`, { seq, pricing, preview_hash: pre.body.review_hash }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body).slice(0, 300));
  assert.equal((await cartGrid(w.db, AMS))[`o:${MODEL}@direct_sale`]!.prepaid, 1_760_000);
  // The same request again: the hash is the idempotency key.
  const replay = await answer(await put(app, `/api/admin/products-v2/${AMS}/pricing`, { seq, pricing, preview_hash: pre.body.review_hash }));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.already, true);
  assert.equal(count(w.raw, `SELECT COUNT(*) AS n FROM pricing_audit WHERE product_id = '${AMS}' AND action = 'reprice_owner'`), 1);

  // A rate moved between preview and apply: the preview is stale.
  const now = (await answer(await get(app, `/api/admin/products-v2/${AMS}/pricing`))).body.seq;
  const next = { points: [point('1150')] };
  const pre2 = await answer(await post(app, '/api/admin/products-v2/pricing/preview', { product_id: AMS, pricing: next }));
  applyRate(w.raw, 'USD_IQD', '1610', '2026-10-02T00:00:00.000Z');
  const moved = await answer(await put(app, `/api/admin/products-v2/${AMS}/pricing`, { seq: now, pricing: next, preview_hash: pre2.body.review_hash }));
  assert.equal(moved.status, 409, JSON.stringify(moved.body).slice(0, 300));
  assert.equal(moved.body.code, 'PRICING_PREVIEW_STALE');
  assert.equal(moved.body.details.section, 3);
  assert.match(moved.body.details.preview.review_hash, /^[0-9a-f]{64}$/);
  applyRate(w.raw, 'USD_IQD', '1600', '2026-10-03T00:00:00.000Z');

  // Above 15%: the tick, then a fresh sign-in.
  const big = { points: [point('1500')] };
  const pre3 = await answer(await post(app, '/api/admin/products-v2/pricing/preview', { product_id: AMS, pricing: big }));
  assert.equal(pre3.body.large_change, true);
  const seq3 = pre3.body.seq;
  const untick = await answer(await put(app, `/api/admin/products-v2/${AMS}/pricing`, { seq: seq3, pricing: big, preview_hash: pre3.body.review_hash }));
  assert.equal(untick.body.code, 'PRICING_LARGE_CHANGE_CONFIRM');
  assert.equal(untick.body.details.section, 3);
  const oldSession = v2App(w.raw, OWNER_USER, 3600);
  const reauth = await answer(await put(oldSession, `/api/admin/products-v2/${AMS}/pricing`, { seq: seq3, pricing: big, preview_hash: pre3.body.review_hash, confirm_large_change: true }));
  assert.equal(reauth.status, 401);
  assert.equal(reauth.body.code, 'REAUTH_REQUIRED');
  assert.equal(reauth.body.details.section, 3);
  const ticked = await answer(await put(app, `/api/admin/products-v2/${AMS}/pricing`, { seq: seq3, pricing: big, preview_hash: pre3.body.review_hash, confirm_large_change: true }));
  assert.equal(ticked.status, 200, JSON.stringify(ticked.body).slice(0, 300));

  // A drop above 30% is flagged — and needs the same tick.
  const drop = await answer(await post(app, '/api/admin/products-v2/pricing/preview', { product_id: AMS, pricing: { points: [point('900')] } }));
  assert.equal(drop.body.drop_flag, true);
  assert.ok(drop.body.changes.some((r: { drop_flag: boolean }) => r.drop_flag));
  const dropped = await answer(await put(app, `/api/admin/products-v2/${AMS}/pricing`, { seq: drop.body.seq, pricing: { points: [point('900')] }, preview_hash: drop.body.review_hash }));
  assert.equal(dropped.body.code, 'PRICING_LARGE_CHANGE_CONFIRM');
});

test('a new model and a route switched on, on a V2 product: structure and prices in one batch — all or nothing; never ENGINE_MANAGED', async () => {
  const w = pricingWorld();
  await v2Ams(w);
  const app = v2App(w.raw);
  const doc = (await json(await get(app, `/api/admin/products-v2/${AMS}`))).product;
  const rel = await json(await get(app, `/api/admin/products/${AMS}/relations`));
  const NEW = `${AMS}_o9`;
  const cellsOf = (air: boolean) => [
    { fulfillment_type: 'direct_sale', enabled: true },
    { fulfillment_type: 'pre_order', enabled: true, transports: [{ method: 'land', enabled: true }, { method: 'air', enabled: air }] },
  ];
  const relations = {
    groups: rel.groups.map((g: { id: string; name_en: string }) => ({
      id: g.id,
      name_en: g.name_en,
      values: [
        ...rel.values.filter((v: { group_id: string }) => v.group_id === g.id).map((v: { id: string; name_en: string; stock: number }) => ({ id: v.id, name_en: v.name_en, stock: v.stock, fulfillments: cellsOf(true) })),
        { id: NEW, name_en: 'Combo', stock: 2, fulfillments: cellsOf(false) },
      ],
    })),
    colors: [],
    images: [],
  };
  const body = { ...doc, expected_updated_at: undefined, relations };
  const pre = await answer(await post(app, '/api/admin/products-v2/pricing/preview', { product_id: AMS, structure: { doc, relations }, pricing: {} }));
  assert.equal(pre.status, 200, JSON.stringify(pre.body).slice(0, 400));
  assert.deepEqual(
    pre.body.changes.map((r: { combo_key: string; channel: string; old_iqd: number | null; new_iqd: number }) => [r.combo_key, r.channel, r.old_iqd, r.new_iqd]).sort(),
    [
      [`o:${MODEL}`, 'pre_order_air', null, 1_520_000],
      [`o:${NEW}`, 'direct_sale', null, 1_600_000],
      [`o:${NEW}`, 'pre_order_land', null, 1_520_000],
    ].sort(),
    'the sheet lists only the new rows'
  );

  // Without the hash: the V2 sheet, never ENGINE_MANAGED.
  const bare = await answer(await post(app, '/api/admin/products-v2', body));
  assert.equal(bare.status, 409, JSON.stringify(bare.body).slice(0, 300));
  assert.equal(bare.body.code, 'PRICING_PREVIEW_REQUIRED');
  assert.equal(bare.body.details.preview.review_hash, pre.body.review_hash);

  // A failure injected at the LAST statement of the batch: nothing at all is written.
  const tables = ['products', 'product_option_values', 'product_option_fulfillment', 'product_option_transports', 'product_sku_prices', 'pricing_v2_sku_results', 'product_pricing_state', 'pricing_audit', 'price_history', 'audit_log'];
  const snapshot = () => tables.map((t) => JSON.stringify(w.raw.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
  const before = snapshot();
  const { failing, db: failDb } = failingD1(w.raw);
  failing.failWhen = (s) => s.length > 20 && /ops_guards/.test(s[s.length - 1]!.sql);
  const failApp = stubApp(failDb, OWNER_USER, (a) => {
    a.use('/api/admin/*', noStoreUnlessSet);
    a.route('/api/admin/products-v2', adminProductsRoutes);
    a.route('/api/admin/products', adminProductRelationsRoutes);
  });
  const failed = await failApp.request('/api/admin/products-v2', { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' }, body: JSON.stringify({ ...body, pricing_v2: { pricing: {}, preview_hash: pre.body.review_hash } }) });
  assert.equal(failed.status, 500);
  assert.deepEqual(snapshot(), before, 'structure and prices land together or not at all');

  const saved = await answer(await post(app, '/api/admin/products-v2', { ...body, pricing_v2: { pricing: {}, preview_hash: pre.body.review_hash } }));
  assert.equal(saved.status, 200, JSON.stringify(saved.body).slice(0, 500));
  const grid = await cartGrid(w.db, AMS);
  assert.equal(grid[`o:${NEW}@direct_sale`]!.prepaid, 1_600_000, 'the new model sells at its V2 price at once');
  assert.equal(grid[`o:${MODEL}@pre_order_air`]!.prepaid, 1_520_000, 'the route switched on sells at P');
  assert.equal(grid[`o:${NEW}@pre_order_air`]?.ok ?? false, false);
  assert.equal(count(w.raw, `SELECT COUNT(*) AS n FROM product_option_values WHERE id = '${NEW}'`), 1);
  // A plain re-save (nothing moves): no sheet, no hash needed.
  const doc2 = (await json(await get(app, `/api/admin/products-v2/${AMS}`))).product;
  const plain = await answer(await post(app, '/api/admin/products-v2', { ...doc2, name_en: 'Renamed', relations }));
  assert.equal(plain.status, 200, JSON.stringify(plain.body).slice(0, 300));
  assert.equal((await cartGrid(w.db, AMS))[`o:${NEW}@direct_sale`]!.prepaid, 1_600_000);
});

test('an unmigrated product: the V2 doors refuse with PRICING_V2_NOT_MIGRATED and the section; the old save is untouched', async () => {
  const w = pricingWorld();
  const app = v2App(w.raw);
  const read = await answer(await get(app, `/api/admin/products-v2/${AMS}/pricing`));
  assert.equal(read.status, 200);
  assert.deepEqual([read.body.v2, read.body.not_migrated, read.body.table], [false, true, []]);
  const doors = [
    await answer(await post(app, '/api/admin/products-v2/pricing/preview', { product_id: AMS, pricing: {} })),
    await answer(await put(app, `/api/admin/products-v2/${AMS}/pricing`, { seq: { inputs_seq: 0, write_seq: 0 }, pricing: {} })),
  ];
  for (const r of doors) {
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'PRICING_V2_NOT_MIGRATED');
    assert.equal(r.body.details.section, 3);
  }
  const doc = (await json(await get(app, `/api/admin/products-v2/${AMS}`))).product;
  const migrate = await answer(await post(app, '/api/admin/products-v2', { ...doc, pricing_v2: { pricing: { method: 'usd', points: [point('1000')] } } }));
  assert.equal(migrate.status, 409);
  assert.equal(migrate.body.code, 'PRICING_V2_NOT_MIGRATED');
  const plain = await answer(await post(app, '/api/admin/products-v2', doc));
  assert.equal(plain.status, 200, 'an unmigrated product saves exactly as today');
  assert.equal(row<{ m: string | null }>(w.raw, 'SELECT pricing_method AS m FROM product_pricing_state WHERE product_id = ?', AMS)?.m ?? null, null);
  void asD1;
});

test('every refusal names its section; a scope that is not the product\'s names section 5 and the id', async () => {
  const w = pricingWorld();
  await v2Ams(w);
  const app = v2App(w.raw);
  const bad = await answer(await post(app, '/api/admin/products-v2/pricing/preview', { product_id: AMS, pricing: { points: [point('1000'), { scope: 'option', id: 'nope', kind: 'fixed', usd: '10' }] } }));
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'PRICING_V2_SCOPE_INVALID');
  assert.deepEqual([bad.body.details.section, bad.body.details.scope, bad.body.details.id], [5, 'option', 'nope']);
  const colourFixed = await answer(await post(app, '/api/admin/products-v2/pricing/preview', { product_id: AMS, pricing: { points: [{ scope: 'color', id: 'c', kind: 'fixed', usd: '1' }] } }));
  assert.equal(colourFixed.body.code, 'PRICING_V2_SCOPE_INVALID');
  assert.equal(colourFixed.body.details.section, 5);
  const fee = await answer(await post(app, '/api/admin/products-v2/pricing/preview', { product_id: AMS, pricing: { cost: { minimum_profit: [{ kind: 'direct_sale_extra', scope: 'product', amount_usd: '5' }] } } }));
  assert.equal(fee.body.code, 'PRICING_V2_FEES_RETIRED');
  assert.equal(fee.body.details.section, 3);
});

test('a database before 0189 (deploy ahead): the V2 reads answer as for an unmigrated product; every V2 write is PRICING_NOT_INSTALLED and writes nothing', async () => {
  for (const through of ['0176', '0188']) {
    const raw = dbThrough(through);
    raw.exec(OWNER_ROW_SQL);
    seedLegacyCatalogue(raw);
    const app = v2App(raw);
    const pid = legacyProductId('bambu-lab-a1');
    const read = await answer(await get(app, `/api/admin/products-v2/${pid}/pricing`));
    assert.equal(read.status, 200, `${through}: ${JSON.stringify(read.body).slice(0, 300)}`);
    assert.equal(read.body.not_migrated, true);
    const list = await answer(await get(app, '/api/admin/pricing/v2/migration'));
    assert.equal(list.status, 200, `${through}: ${JSON.stringify(list.body).slice(0, 300)}`);
    assert.ok(list.body.items.length > 0 && list.body.items.every((i: { available: boolean }) => !i.available), `${through}: no rates, nothing to commit`);
    assert.equal((await answer(await get(app, `/api/admin/pricing/v2/migration/${pid}`))).status, 200);
    const commit = await answer(await post(app, `/api/admin/pricing/v2/migration/${pid}/commit`, { option: 'keep_usd', preview_hash: 'a'.repeat(64) }));
    assert.equal(commit.status, 503, `${through}: ${JSON.stringify(commit.body).slice(0, 300)}`);
    assert.equal(commit.body.code, 'PRICING_NOT_INSTALLED');
    assert.equal(commit.body.details.section, 3);
    const bulk = await answer(await post(app, '/api/admin/pricing/v2/migration/commit-unchanged', { items: [{ product_id: pid, preview_hash: 'a'.repeat(64) }] }));
    assert.equal(bulk.body.code, 'PRICING_NOT_INSTALLED');
    const structure = newProductBody('np');
    const born = await answer(await post(app, '/api/admin/products-v2', { ...structure.doc, relations: structure.relations, pricing_v2: { pricing: NEW_PRICING, preview_hash: 'a'.repeat(64) } }));
    assert.equal(born.status, 503, `${through}: ${JSON.stringify(born.body).slice(0, 300)}`);
    assert.equal(born.body.code, 'PRICING_NOT_INSTALLED');
    assert.equal(born.body.details.section, 3);
    assert.equal(count(raw, "SELECT COUNT(*) AS n FROM products WHERE id = 'np'"), 0);
    // The same product without a V2 block saves exactly as today.
    const plain = await answer(await post(app, '/api/admin/products-v2', { ...structure.doc, relations: structure.relations }));
    assert.equal(plain.status, 200, `${through}: ${JSON.stringify(plain.body).slice(0, 300)}`);
  }
});
