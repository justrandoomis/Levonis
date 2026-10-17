/**
 * PRICING V2 — A COST-FIRST MODEL WITH STOCK IS PRICED FROM ITS SHELF (owner
 * decisions of 2026-10-17, DECISIONS row 244; docs/PRICING-V2.md §10).
 *
 * The owner's own example: an «A1» printer with two models, A1 Combo on the
 * shelf at 685,831 / 689,581 / 690,062 IQD a unit and A1 at 500,346, priced
 * «من التكلفة» with no supplier price at all — which, before row 244, priced
 * nothing («—», «ما ينقص: …»). Proves, through the real V2 writer, the real
 * quarter-hour sweep and the real routes:
 *   - the max-of-shelf rule, per model: Combo's direct cost is 690,062, A1's
 *     500,346, D = round(cost + T × U) by the one rounding rule
 *     (`roundPriceIqd`, row 245), stored with its R;
 *   - selling a unit that leaves the costliest batch, or receiving a cheaper
 *     one, moves nothing (not even stale); the costliest sold out reprices DOWN
 *     to the next max, a costlier batch received reprices UP — through the
 *     sweep (reason STOCK, `engine_owner` in the history);
 *   - pre-order follows the direct price on the shelf too (row 247, B1):
 *     P = round(E_D − Δ × U), so a batch that moves D moves P with it and
 *     D − P stays Δ; unavailable while there is no supplier price (no error
 *     for the direct price); withdrawn to D when the discounted price does not
 *     clear the route's own supplier cost; stopped while the shelf sells below
 *     that cost;
 *   - the shelf sold out → the supplier price; sold out with no supplier price
 *     → the model is not sold («يحتاج تسعيرًا») and the owner's bell rings;
 *     restocked → priced from the shelf again; every model sold out → the
 *     product is held with the bell;
 *   - a price editor and a customer never see the shelf's cost;
 *   - the form's words in Arabic, English and Sorani.
 *
 * Run: node --import tsx --test tests/pricingV2Shelf.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, count, freshDb, get, json, row, stubApp, type StubUser } from './fixtures/app';
import { applyRate, fxEnv, OWNER_ROW_SQL } from './fixtures/fx';
import { cartGrid, v2App, writeV2 } from './fixtures/pricingV2';
import { priceProductV2, type V2Sku } from '@levonis/pricing/priceV2';
import { roundPriceIqd } from '../packages/pricing/src/priceRounding';
import { PRICING_ISSUES } from '@levonis/contracts/pricingIssues';
import { loadShelves, shelfOfSku } from '../worker/lib/pricingEngine/v2/shelf';
import { sweepStaleEnginePrices } from '../worker/lib/fx/reprice';
import { statementBudget } from '../worker/lib/fx/budget';
import { STOCK_REVIEW_NOTICE, STOCK_SOLD_OUT_NOTICE } from '../worker/lib/fx/notify';
import { productRoutes } from '../worker/routes/products';
import { V2_STRINGS } from '../src/components/adminProducts/form/v2/v2Strings';
import { blockedText } from '../src/components/adminProducts/form/v2/FinalPricesTable';
import type { Env } from '../worker/lib/types';

const PID = 'p_a1';
const A1 = 'p_a1_std';
const COMBO = 'p_a1_combo';
const OWNER: StubUser = { id: 'usr_owner', role: 'admin', email: 'boss@x.co' };
const EDITOR: StubUser = { id: 'usr_editor', role: 'admin', email: 'editor@x.co' };
/** U = 1,500 and a minimum profit of $40: T × U = 60,000 IQD. */
const TU = 60_000;
/** The engine's own rounding (never a step written here): every expected price goes through it. */
const D = (iqd: number) => roundPriceIqd(iqd);
/** The owner's figures: A1 Combo from its costliest batch, A1 from its one. */
const COMBO_D = D(690_062 + TU); // 750,250
const A1_D = D(500_346 + TU); // 560,500
const sql = (v: unknown): string => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

let lotSeq = 0;
/** A batch on the shelf, as the receiving door writes one (the effective cost is its unit_cost_iqd). */
function lot(raw: DatabaseSync, model: string, qty: number, unitCost: number | null, remaining = qty): string {
  const id = `lot_${++lotSeq}`;
  const at = new Date(Date.UTC(2026, 8, 1) + lotSeq * 60_000).toISOString();
  raw.exec(`INSERT INTO inventory_lots (id, product_id, scope, scope_id, qty_received, qty_remaining, unit_cost_iqd, cost_basis, received_at)
            VALUES (${sql(id)}, ${sql(PID)}, 'option', ${sql(model)}, ${qty}, ${remaining}, ${sql(unitCost)}, ${unitCost === null ? "'opening_unpriced'" : "'received'"}, ${sql(at)})`);
  return id;
}
/** FIFO's own move on a sale or a stock-out: the batch gives up units (worker/lib/inventoryLots.ts). */
const take = (raw: DatabaseSync, id: string, qty: number) => raw.exec(`UPDATE inventory_lots SET qty_remaining = qty_remaining - ${qty} WHERE id = ${sql(id)}`);

/** The owner's A1: two models, OPTION stock, each sold direct and by land pre-order; the shelf of the screenshots. */
async function world(o: { supplier?: boolean; discountUsd?: string } = {}) {
  lotSeq = 0;
  const raw = freshDb();
  raw.exec(OWNER_ROW_SQL);
  raw.exec("INSERT INTO users (id,name,email,password_hash,role,email_verified_at) VALUES ('usr_editor','Editor','editor@x.co','h','admin','2026-01-01T00:00:00.000Z')");
  applyRate(raw, 'USD_IQD', '1500');
  applyRate(raw, 'EUR_USD', '1.1');
  applyRate(raw, 'CNY_USD', '0.14');
  raw.exec(`UPDATE pricing_shipping_rates SET rate_iqd = '3200', version = version + 1 WHERE profile = 'GERMANY_LAND';
            UPDATE pricing_shipping_rates SET rate_iqd = '20000', version = version + 1 WHERE profile = 'CHINA_AIR';
            UPDATE pricing_shipping_rates SET rate_iqd = '400000', version = version + 1 WHERE profile = 'CHINA_SEA';`);
  raw.exec(`
    INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode)
    VALUES (${sql(PID)}, 'bambu-a1', 'Bambu Lab A1', 'طابعة A1', 'چاپکەری A1', 'active', 700000, 9, 'direct_sale', '["direct_sale","pre_order"]', '[]', 'OPTION');
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('p_a1_g', ${sql(PID)}, 'Model', 0, 1);
  `);
  [
    { id: A1, en: 'A1', ar: 'A1', ckb: 'A1' },
    { id: COMBO, en: 'A1 Combo', ar: 'A1 كومبو', ckb: 'A1 کۆمبۆ' },
  ].forEach((m, j) =>
    raw.exec(`
      INSERT INTO product_option_values (id, product_id, group_id, name_en, name_ar, name_ckb, sort, active, stock, variant_key, variant_label)
      VALUES (${sql(m.id)}, ${sql(PID)}, 'p_a1_g', ${sql(m.en)}, ${sql(m.ar)}, ${sql(m.ckb)}, ${j}, 1, ${j ? 6 : 3}, ${sql(`m${j}`)}, ${sql(m.en)});
      INSERT INTO product_option_fulfillment (id, product_id, option_id, fulfillment_type, enabled) VALUES (${sql(`${m.id}_d`)}, ${sql(PID)}, ${sql(m.id)}, 'direct_sale', 1);
      INSERT INTO product_option_fulfillment (id, product_id, option_id, fulfillment_type, enabled) VALUES (${sql(`${m.id}_p`)}, ${sql(PID)}, ${sql(m.id)}, 'pre_order', 1);
      INSERT INTO product_option_transports (id, product_id, fulfillment_id, method, enabled) VALUES (${sql(`${m.id}_p_land`)}, ${sql(PID)}, ${sql(`${m.id}_p`)}, 'land', 1);
    `)
  );
  // «دفعات هذا المنتج»: A1 Combo at 685,831 / 689,581 / 690,062 (two units each), A1 at 500,346 (three).
  const lots = {
    c1: lot(raw, COMBO, 2, 685_831),
    c2: lot(raw, COMBO, 2, 689_581),
    c3: lot(raw, COMBO, 2, 690_062),
    a1: lot(raw, A1, 3, 500_346),
  };
  const db = asD1(raw);
  const ev = await writeV2(db, PID, {
    method: 'cost',
    minimumProfitUsd: '40',
    ...(o.discountUsd ? { discounts: [{ scope: 'product' as const, scope_id: '', usd: o.discountUsd }] } : {}),
    // A supplier price at USD 450 by Germany land, 2.5 kg: R = 450 × 1,500 + 2.5 × 3,200 = 683,000 on every route.
    ...(o.supplier ? { inputs: { supplier_cost_amount: '450', supplier_cost_currency: 'USD' as const, shipping_profile: 'GERMANY_LAND' as const, shipping_weight_g: 2500 } } : {}),
  });
  return { raw, db, ev, lots, env: fxEnv(raw) as Env };
}

type World = Awaited<ReturnType<typeof world>>;

const sweep = (w: World) => sweepStaleEnginePrices(w.env, { trigger: 'sweep', budget: statementBudget(200) });
const directOf = async (w: World, model: string) => (await cartGrid(w.db, PID))[`o:${model}@direct_sale`]!;
const landOf = async (w: World, model: string) => (await cartGrid(w.db, PID))[`o:${model}@pre_order_land`]!;
const resultOf = (w: World, model: string, channel = 'direct_sale') =>
  row<{ final_price_iqd: number; replacement_cost_iqd: number | null; replacement_exact: string | null; shipping_profile: string | null; supplier_currency: string | null }>(
    w.raw,
    'SELECT final_price_iqd, replacement_cost_iqd, replacement_exact, shipping_profile, supplier_currency FROM pricing_v2_sku_results WHERE product_id = ? AND combo_key = ? AND channel = ?',
    PID,
    `o:${model}`,
    channel
  );

test('the max-of-shelf rule, per model: A1 Combo 685,831 / 689,581 / 690,062 → 690,062; A1 500,346; no supplier price needed', async () => {
  const w = await world();
  // The shelf as the engine reads it: the highest KNOWN cost among the batches still on it, per model.
  const shelves = await loadShelves(w.db, [PID]);
  const shelf = shelves.get(PID)!;
  assert.equal(shelf.mode, 'OPTION');
  assert.deepEqual(shelfOfSku(shelf, { option_value_ids: [COMBO], color_id: null, combo_key: `o:${COMBO}` }), { state: 'on_shelf', cost_iqd: 690_062, units: 6 });
  assert.deepEqual(shelfOfSku(shelf, { option_value_ids: [A1], color_id: null, combo_key: `o:${A1}` }), { state: 'on_shelf', cost_iqd: 500_346, units: 3 });

  // Complete, and published: D = round(max + T × U) per model.
  assert.equal(w.ev.complete, true, w.ev.codes.join(','));
  assert.deepEqual(w.ev.missing, []);
  assert.equal((await directOf(w, COMBO)).prepaid, COMBO_D);
  assert.equal((await directOf(w, A1)).prepaid, A1_D);
  // The stored result names the shelf's batch as R (dinars, exact) and no supplier, rate or freight.
  const combo = resultOf(w, COMBO)!;
  assert.equal(combo.replacement_cost_iqd, 690_062);
  assert.equal(combo.replacement_exact, '690062');
  assert.equal(combo.shipping_profile, null);
  assert.equal(combo.supplier_currency, null);
  for (const m of [A1, COMBO]) assert.ok(resultOf(w, m)!.final_price_iqd - resultOf(w, m)!.replacement_cost_iqd! >= TU, 'D − R_shelf ≥ T × U');
  // The shelf signature is stored with the prices (a hash, never a figure).
  const sig = row<{ s: string | null }>(w.raw, 'SELECT shelf_sig AS s FROM product_pricing_state WHERE product_id = ?', PID)!.s;
  assert.match(sig ?? '', /^[0-9a-f]{64}$/);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM product_pricing_state WHERE shelf_sig LIKE '%690%'"), 0);

  // Pre-order without a supplier price: unavailable while the shelf sells — no error, no missing gap, route row kept on.
  assert.equal((await landOf(w, COMBO)).ok, false);
  const land = w.ev.rows.find((r) => r.combo_key === `o:${COMBO}` && r.channel === 'pre_order_land')!;
  assert.equal(land.blocked, true);
  assert.equal(land.blocked_code, 'V2_ROUTE_NO_SUPPLIER');
  assert.equal(row<{ e: number }>(w.raw, 'SELECT enabled AS e FROM product_option_transports WHERE id = ?', `${COMBO}_p_land`)!.e, 1);
});

test('the engine, pure: the shelf prices the direct sale in dinars as paid, the pre-order follows it by Δ (row 247); differences add at U; an unknown-cost batch never sets it', () => {
  const rates = {
    fx: { USD: { rate: '1500', version: 1, confirmed: true }, EUR: { rate: '1650', version: 1, confirmed: true }, CNY: { rate: '210', version: 1, confirmed: true } },
    shipping: { GERMANY_LAND: { rate: '3200', version: 1, confirmed: true }, CHINA_AIR: { rate: '20000', version: 1, confirmed: true }, CHINA_SEA: { rate: '400000', version: 1, confirmed: true } },
  };
  const target = { kind: 'target_profit', status: 'active', rule: { id: 'r1', version: 1 }, amount_usd: '40', amount_iqd: null, tie: false } as unknown as V2Sku['target'];
  const sku = (shelf: V2Sku['shelf'], chain: V2Sku['chain'] = {}): V2Sku => ({
    combo_key: 'o:m1',
    model_id: 'm1',
    option_value_ids: ['m1'],
    color_id: null,
    channels: ['direct_sale', 'pre_order_land'],
    chain,
    target,
    shelf,
  });
  const supplier: V2Sku['chain'] = { base: { override: { supplier_cost: '450', supplier_currency: 'USD', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 2500 } } };
  const price = (s: V2Sku, points: Parameters<typeof priceProductV2>[0]['points'] = [], discounts: Parameters<typeof priceProductV2>[0]['discounts'] = []) =>
    priceProductV2({ method: 'cost', rates, points, discounts, skus: [s] }).skus[0]!;

  // On the shelf, a model difference of +$10 adds at U: 690,062 + 60,000 + 15,000.
  const onShelf = price(sku({ state: 'on_shelf', cost_iqd: 690_062, units: 6 }), [{ scope: 'option', scope_id: 'm1', kind: 'delta', usd: '+10' }]);
  const direct = onShelf.channels.find((c) => c.channel === 'direct_sale')!;
  assert.equal(direct.price_iqd, D(690_062 + TU + 15_000));
  assert.deepEqual(direct.shelf, { cost_iqd: 690_062, units: 6 });
  assert.equal(direct.replacement, null);
  assert.deepEqual(onShelf.issues.filter((i) => i.severity === 'error').map((i) => i.code), ['V2_ROUTE_NO_SUPPLIER']);

  // Pre-order follows the direct price on the shelf too (row 247, B1): P = round(E_D − Δ × U), so a batch that
  // moves D moves the land price with it and D − P stays Δ ($20 = 30,000)…
  const supDirect = D(683_000 + TU); // 743,000: R = 450 × 1,500 + 2.5 × 3,200
  const off20 = [{ scope: 'product' as const, scope_id: '', usd: '20' }];
  const both = (shelf: V2Sku['shelf']) => {
    const r = price(sku(shelf, supplier), [], off20);
    return { r, direct: r.channels.find((c) => c.channel === 'direct_sale'), land: r.channels.find((c) => c.channel === 'pre_order_land') };
  };
  assert.equal(both(null).land!.price_iqd, D(683_000 + TU - 30_000));
  for (const cost of [690_062, 720_000, 750_000]) {
    const at = both({ state: 'on_shelf', cost_iqd: cost, units: 1 });
    assert.equal(at.direct!.price_iqd, D(cost + TU), `shelf ${cost}: direct`);
    assert.equal(at.land!.price_iqd, D(cost + TU - 30_000), `shelf ${cost}: land = D − Δ`);
    assert.equal(at.land!.floor, 'none');
    assert.equal(at.land!.discount_usd, '20');
    assert.equal(at.land!.replacement!.replacement_cost_iqd, 683_000, 'the route still knows its own supplier cost');
  }
  // …the discount withdrawn (the route sells at D, with the owner's warning) when the discounted price does not clear
  // the route's own supplier cost (640,000 + 60,000 − 30,000 = 670,000 ≤ 683,000) — never capped silently…
  const withdrawn = both({ state: 'on_shelf', cost_iqd: 640_000, units: 1 });
  const cheapD = D(640_000 + TU);
  assert.equal(withdrawn.direct!.price_iqd, cheapD);
  assert.equal(withdrawn.land!.price_iqd, cheapD);
  assert.equal(withdrawn.land!.floor, 'discount_withdrawn');
  assert.ok(withdrawn.r.issues.some((i) => i.code === 'V2_DISCOUNT_WITHDRAWN' && i.channel === 'pre_order_land'));
  // …and stopped while the shelf sells below the route's own cost (683,000), never sold at a loss.
  const cheaper = price(sku({ state: 'on_shelf', cost_iqd: 600_000, units: 1 }, supplier), [], off20);
  assert.equal(cheaper.channels.find((c) => c.channel === 'direct_sale')!.price_iqd, D(600_000 + TU));
  assert.equal(cheaper.channels.find((c) => c.channel === 'pre_order_land'), undefined);
  assert.deepEqual(cheaper.issues.filter((i) => i.severity === 'error').map((i) => i.code), ['V2_ROUTE_SHELF_CHEAPER']);

  // Sold out: the supplier price; sold out with none: every channel unsold (V2_STOCK_SOLD_OUT), never guessed.
  assert.equal(price(sku({ state: 'sold_out' }, supplier)).channels.find((c) => c.channel === 'direct_sale')!.price_iqd, supDirect);
  const none = price(sku({ state: 'sold_out' }));
  assert.deepEqual(none.channels, []);
  assert.deepEqual([...new Set(none.issues.map((i) => i.code))], ['V2_STOCK_SOLD_OUT']);
  // Price-first ignores the shelf entirely.
  const usd = priceProductV2({ method: 'usd', rates, points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '600' }], discounts: [], skus: [sku({ state: 'on_shelf', cost_iqd: 900_000, units: 1 })] }).skus[0]!;
  assert.equal(usd.channels.find((c) => c.channel === 'direct_sale')!.price_iqd, 900_000);
  assert.equal(usd.channels.find((c) => c.channel === 'direct_sale')!.shelf, null);

  // An unknown-cost batch: the highest KNOWN cost sets the price; a shelf of unknown costs prices from the supplier.
  const mixed = { mode: 'OPTION' as const, identities: [{ scope: 'option' as const, scope_id: 'm1', combo_key: null, cost_iqd: 500_000, units: 4 }] };
  assert.deepEqual(shelfOfSku(mixed, { option_value_ids: ['m1'], color_id: null, combo_key: 'o:m1' }), { state: 'on_shelf', cost_iqd: 500_000, units: 4 });
  const unknown = { mode: 'OPTION' as const, identities: [{ scope: 'option' as const, scope_id: 'm1', combo_key: null, cost_iqd: null, units: 4 }] };
  assert.equal(shelfOfSku(unknown, { option_value_ids: ['m1'], color_id: null, combo_key: 'o:m1' }), null);
  // Two stocked options: a unit takes one of each, so the costs add and the units are the fewest.
  const two = { mode: 'OPTION' as const, identities: [
    { scope: 'option' as const, scope_id: 'm1', combo_key: null, cost_iqd: 500_000, units: 4 },
    { scope: 'option' as const, scope_id: 'n1', combo_key: null, cost_iqd: 20_000, units: 2 },
  ] };
  assert.deepEqual(shelfOfSku(two, { option_value_ids: ['m1', 'n1'], color_id: null, combo_key: 'o:m1|o:n1' }), { state: 'on_shelf', cost_iqd: 520_000, units: 2 });
});

test('the shelf moves: a sale leaving the costliest batch moves nothing; its sell-out reprices DOWN to the next max; a costlier batch reprices UP', async () => {
  const w = await world();
  const history0 = count(w.raw, 'SELECT COUNT(*) AS n FROM price_history');

  // A sale from the oldest batch, and a cheaper batch received: the costliest is still there — not even stale.
  take(w.raw, w.lots.c1, 1);
  lot(w.raw, COMBO, 3, 650_000);
  const quiet = await sweep(w);
  assert.equal(quiet.skipped, 'NOTHING_STALE');
  assert.equal((await directOf(w, COMBO)).prepaid, COMBO_D);

  // The costliest batch sells out: down to the next max (689,581 + 60,000 → 749,750), through the sweep.
  take(w.raw, w.lots.c3, 2);
  const down = await sweep(w);
  assert.deepEqual(down.repriced, [PID], JSON.stringify(down));
  assert.equal((await directOf(w, COMBO)).prepaid, D(689_581 + TU));
  assert.equal((await directOf(w, A1)).prepaid, A1_D, 'the other model is untouched');
  assert.equal(resultOf(w, COMBO)!.replacement_cost_iqd, 689_581);
  const moved = all<{ price_source: string; new_iqd: number }>(w.raw, 'SELECT price_source, new_iqd FROM price_history WHERE rowid > (SELECT ? ) ORDER BY rowid', history0);
  assert.deepEqual(moved.map((h) => [h.price_source, h.new_iqd]), [['engine_owner', D(689_581 + TU)]], 'one SKU × channel moved, a cost change (not FX)');
  assert.ok(
    all<{ summary_json: string }>(w.raw, "SELECT summary_json FROM pricing_audit WHERE product_id = ? AND action = 'reprice_auto'", PID).some((r) => JSON.parse(r.summary_json).reasons?.includes('STOCK')),
    'audited with the reason STOCK'
  );
  assert.equal((await sweep(w)).skipped, 'NOTHING_STALE', 'current again');

  // A costlier batch arrives: up (700,000 + 60,000).
  lot(w.raw, COMBO, 1, 700_000);
  const up = await sweep(w);
  assert.deepEqual(up.repriced, [PID]);
  assert.equal((await directOf(w, COMBO)).prepaid, D(700_000 + TU));

  // A cost correction of a batch on the shelf (its newest cost version) counts as its cost.
  w.raw.exec(`
    INSERT INTO incoming_inventory (id, product_id, scope, scope_id, qty_ordered, purchase_unit_iqd) VALUES ('inc1', ${sql(PID)}, 'option', ${sql(A1)}, 3, 500000);
    INSERT INTO lot_cost_adjustments (id, incoming_id, amount_iqd, adjustment_day, title, actor_id, request_json, created_at)
      VALUES ('adj1', 'inc1', 59000, '2026-10-17', 'customs', 'usr_owner', '{}', '2026-10-17T00:00:00.000Z');
    INSERT INTO inventory_lot_cost_versions (lot_id, version, unit_cost_iqd, adjustment_id) VALUES (${sql(w.lots.a1)}, 1, 520000, 'adj1');`);
  await sweep(w);
  assert.equal((await directOf(w, A1)).prepaid, D(520_000 + TU));
});

test('a rise from the shelf is never held (no unit below cost + minimum profit); a large fall waits for the owner with the bell', async () => {
  const w = await world();
  // A1 at 500,346 → 560,500; a batch at 700,000 arrives: +35%, published on the next tick, never held.
  const dear = lot(w.raw, A1, 1, 700_000);
  const up = await sweep(w);
  assert.deepEqual(up.repriced, [PID], JSON.stringify(up));
  assert.deepEqual(up.blocked, []);
  assert.equal((await directOf(w, A1)).prepaid, D(700_000 + TU));
  // It sells out: back to 500,346 → 560,500, a 26% fall — held (the higher price meanwhile is safe), the bell rings.
  take(w.raw, dear, 1);
  const down = await sweep(w);
  assert.deepEqual(down.blocked, [{ product_id: PID, code: 'PRICING_V2_LARGE_CHANGE' }]);
  assert.equal((await directOf(w, A1)).prepaid, D(700_000 + TU));
  const bell = all<{ meta: string; title_ar: string }>(w.raw, "SELECT meta, title_ar FROM user_notifications WHERE user_id = 'usr_owner' AND kind = 'fx_attention'");
  assert.deepEqual(bell.map((b) => [JSON.parse(b.meta).reason, b.title_ar]), [['stock_review', STOCK_REVIEW_NOTICE.title.ar]]);
});

test('pre-order follows the direct price on the shelf (row 247): a batch that moves D moves the land price by the same, D − P = Δ', async () => {
  const w = await world({ supplier: true, discountUsd: '20' });
  const OFF = 30_000; // $20 × 1,500
  assert.equal((await directOf(w, COMBO)).prepaid, COMBO_D, 'the shelf prices the direct sale');
  assert.equal((await landOf(w, COMBO)).prepaid, D(690_062 + TU - OFF), 'the land route: the shelf direct price less the discount');
  assert.equal(COMBO_D - (await landOf(w, COMBO)).prepaid!, OFF);
  // A1's shelf sells at 560,500, below the land route's own cost (683,000): its pre-order is stopped while it sells.
  assert.equal((await landOf(w, A1)).ok, false);
  assert.equal(w.ev.rows.find((r) => r.combo_key === `o:${A1}` && r.channel === 'pre_order_land')!.blocked_code, 'V2_ROUTE_SHELF_CHEAPER');
  // The costliest batch sells out: D falls to the next max and the land price falls with it.
  take(w.raw, w.lots.c3, 2);
  await sweep(w);
  assert.equal((await directOf(w, COMBO)).prepaid, D(689_581 + TU));
  assert.equal((await landOf(w, COMBO)).prepaid, D(689_581 + TU - OFF), 'moved with the direct price');
  // A costlier batch arrives: both rise, the discount between them unchanged.
  lot(w.raw, COMBO, 1, 720_000);
  await sweep(w);
  assert.equal((await directOf(w, COMBO)).prepaid, D(720_000 + TU));
  assert.equal((await landOf(w, COMBO)).prepaid, D(720_000 + TU - OFF));
});

test('row 247 with row 244: a costlier batch that brings a withdrawn discount back is published with D, never held; a fall of D that withdraws it waits', async () => {
  // Supplier USD 450 by land (the route costs 683,000), T $40, Δ $130 (195,000): at 750,250 the discount is withdrawn.
  const w = await world({ supplier: true, discountUsd: '130' });
  assert.equal((await landOf(w, COMBO)).prepaid, COMBO_D, 'withdrawn: the land route sells at D');
  // A batch at 760,000: D 820,000, still withdrawn — both +9%.
  const mid = lot(w.raw, COMBO, 1, 760_000);
  assert.deepEqual((await sweep(w)).repriced, [PID]);
  assert.equal((await directOf(w, COMBO)).prepaid, D(760_000 + TU));
  assert.equal((await landOf(w, COMBO)).prepaid, D(760_000 + TU));
  // A batch at 830,000: D rises to 890,000 and the discount comes back — the land price FALLS 15.2%, with D. Never held:
  // holding D would sell the 830,000 unit below its cost + the minimum profit.
  const dear = lot(w.raw, COMBO, 1, 830_000);
  const up = await sweep(w);
  assert.deepEqual(up.repriced, [PID], JSON.stringify(up));
  assert.deepEqual(up.blocked, []);
  assert.equal((await directOf(w, COMBO)).prepaid, D(830_000 + TU));
  assert.equal((await landOf(w, COMBO)).prepaid, D(830_000 + TU - 195_000));
  // It sells out: D falls 7.9% and the land price rises 18% back to D (withdrawn) — no direct rise, a large move: held.
  take(w.raw, dear, 1);
  const down = await sweep(w);
  assert.deepEqual(down.blocked, [{ product_id: PID, code: 'PRICING_V2_LARGE_CHANGE' }], JSON.stringify(down));
  assert.equal((await directOf(w, COMBO)).prepaid, D(830_000 + TU), 'the higher price meanwhile is safe');
  assert.equal((await landOf(w, COMBO)).prepaid, D(830_000 + TU - 195_000));
  void mid;
});

test('the shelf sold out: back to the supplier price (and to the shelf when stock returns)', async () => {
  const w = await world({ supplier: true });
  for (const id of [w.lots.c1, w.lots.c2, w.lots.c3]) take(w.raw, id, 2);
  const r = await sweep(w);
  assert.deepEqual(r.repriced, [PID]);
  assert.equal((await directOf(w, COMBO)).prepaid, D(683_000 + TU));
  const res = resultOf(w, COMBO)!;
  assert.equal(res.shipping_profile, 'GERMANY_LAND', 'priced from the supplier calculation again');
  assert.equal(res.replacement_cost_iqd, 683_000);
  lot(w.raw, COMBO, 2, 695_000);
  await sweep(w);
  assert.equal((await directOf(w, COMBO)).prepaid, D(695_000 + TU));
});

test('sold out with no supplier price: the model is not sold («يحتاج تسعيرًا») and the owner hears it; restocked, it sells again', async () => {
  const w = await world();
  take(w.raw, w.lots.a1, 3);
  const r = await sweep(w);
  assert.deepEqual(r.repriced, [PID], JSON.stringify(r));
  const a1 = await directOf(w, A1);
  assert.equal(a1.ok, false, 'never a silent stale price: A1 is not on sale');
  assert.ok(a1.errors.includes('VARIANT_UNAVAILABLE'));
  assert.equal((await directOf(w, COMBO)).prepaid, COMBO_D, 'the other model still sells from its shelf');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_v2_sku_results WHERE product_id = ? AND combo_key = ?', PID, `o:${A1}`), 0);
  const bell = all<{ title_ar: string; link: string; meta: string }>(w.raw, "SELECT title_ar, link, meta FROM user_notifications WHERE user_id = 'usr_owner' AND kind = 'fx_attention'");
  const sold = bell.filter((n) => JSON.parse(n.meta).reason === 'stock_sold_out');
  assert.equal(sold.length, 1, JSON.stringify(bell));
  assert.equal(sold[0]!.title_ar, STOCK_SOLD_OUT_NOTICE.title.ar);
  assert.equal(sold[0]!.link, `/admin?tab=products&edit=${PID}&section=3`);
  assert.doesNotMatch(JSON.stringify(sold), /[0-9]{4,}|500[,.]?346/, 'no figure in the bell');

  // The owner's form says why: the A1 rows are «يحتاج تسعيرًا: نفد المخزون».
  const owner = await json(await get(v2App(w.raw, OWNER), `/api/admin/products-v2/${PID}/pricing`));
  const a1Rows = (owner.table as Array<Record<string, unknown>>).filter((t) => t.combo_key === `o:${A1}`);
  assert.ok(a1Rows.length && a1Rows.every((t) => t.blocked === true && t.v2_blocked === 'V2_STOCK_SOLD_OUT'), JSON.stringify(a1Rows));

  // Stock returns: priced from the shelf again.
  lot(w.raw, A1, 2, 510_000);
  await sweep(w);
  assert.equal((await directOf(w, A1)).prepaid, D(510_000 + TU));
});

test('every model sold out with no supplier price: the product is held (V2_STOCK_SOLD_OUT) with the bell', async () => {
  const w = await world();
  for (const id of [w.lots.c1, w.lots.c2, w.lots.c3]) take(w.raw, id, 2);
  take(w.raw, w.lots.a1, 3);
  const r = await sweep(w);
  assert.deepEqual(r.blocked, [{ product_id: PID, code: 'V2_STOCK_SOLD_OUT' }]);
  assert.equal(row<{ c: string }>(w.raw, 'SELECT reprice_blocked_code AS c FROM product_pricing_state WHERE product_id = ?', PID)!.c, 'V2_STOCK_SOLD_OUT');
  assert.equal(all<{ meta: string }>(w.raw, "SELECT meta FROM user_notifications WHERE user_id = 'usr_owner' AND kind = 'fx_attention'").filter((n) => JSON.parse(n.meta).reason === 'stock_sold_out').length, 1);
  // Held products wait a day — but not this one once stock is back: the next tick prices it from the new batch.
  assert.equal((await sweep(w)).skipped, 'NOTHING_STALE', 'still sold out: it waits, no second bell');
  lot(w.raw, COMBO, 1, 720_000);
  const back = await sweep(w);
  assert.deepEqual(back.repriced, [PID], JSON.stringify(back));
  assert.equal((await directOf(w, COMBO)).prepaid, D(720_000 + TU), 'never the old 750,250 under a 720,000 batch');
  assert.equal(row<{ c: string | null }>(w.raw, 'SELECT reprice_blocked_code AS c FROM product_pricing_state WHERE product_id = ?', PID)!.c, null);
});

test('owner-only: the owner reads the shelf; a price editor and a customer never see its cost', async () => {
  const w = await world();
  const owner = await json(await get(v2App(w.raw, OWNER), `/api/admin/products-v2/${PID}/pricing`));
  type OwnerRow = { combo_key: string; channel: string; source: string; price_iqd: number; owner: { v2_shelf: unknown; v2_replacement_iqd: number } };
  const combo = (owner.table as OwnerRow[]).find((t) => t.combo_key === `o:${COMBO}` && t.channel === 'direct_sale')!;
  assert.deepEqual(combo.owner.v2_shelf, { cost_iqd: 690_062, units: 6 });
  assert.equal(combo.owner.v2_replacement_iqd, 690_062);
  assert.equal(combo.source, 'stock');
  assert.equal(combo.price_iqd, COMBO_D);
  assert.equal(owner.complete, true);
  assert.deepEqual(owner.missing, [], '«ما ينقص» no longer lists the direct price');

  const editorRes = await get(v2App(w.raw, EDITOR), `/api/admin/products-v2/${PID}/pricing`);
  assert.equal(editorRes.status, 200);
  const editorText = await editorRes.text();
  for (const figure of ['690062', '690,062', '689581', '685831', '500346']) assert.ok(!editorText.includes(figure), `no stock cost (${figure}) for a price editor`);
  for (const key of ['v2_shelf', 'v2_blocked', 'v2_replacement_iqd', '"stock"']) assert.ok(!editorText.includes(key), `no ${key} for a price editor`);
  assert.ok(editorText.includes(String(COMBO_D)), 'the editor reads the final price');

  const shop = stubApp(asD1(w.raw), null, (a) => a.route('/api/products', productRoutes), { publishV2: false });
  const page = await (await get(shop, '/api/products/bambu-a1')).text();
  for (const figure of ['690062', '689581', '685831', '500346', 'v2_shelf']) assert.ok(!page.includes(figure), `no stock cost (${figure}) for a customer`);
});

test('the form and the bell speak Arabic, English and real Sorani', () => {
  assert.equal(V2_STRINGS.ar.sourceStock('690,062', 6), 'من المخزون: أعلى تكلفة على الرف 690,062 د.ع (6 قطع)');
  assert.equal(V2_STRINGS.en.sourceStock('690,062', 6), 'From stock: highest cost on the shelf 690,062 IQD (6 units)');
  assert.equal(V2_STRINGS.ckb.sourceStock('690,062', 6), 'لە کۆگاوە: بەرزترین تێچوو لەسەر ڕەفەکە 690,062 دینار (6 دانە)');
  assert.equal(V2_STRINGS.ar.sourceStock('500,346', 1), 'من المخزون: أعلى تكلفة على الرف 500,346 د.ع (قطعة واحدة)');
  const sorani = /[ڕڵێۆەڤگچپژ]/;
  for (const k of ['routeNoSupplier', 'routeShelfCheaper', 'stockSoldOut', 'routeNoSupplierNote', 'routeShelfCheaperNote', 'stockSoldOutNote'] as const) {
    for (const lang of ['ar', 'en', 'ckb'] as const) assert.ok(V2_STRINGS[lang][k].trim().length > 0, `${lang}.${k}`);
    assert.notEqual(V2_STRINGS.ckb[k], V2_STRINGS.ar[k], `ckb.${k} is not the Arabic`);
    assert.match(V2_STRINGS.ckb[k], sorani, `ckb.${k} is Sorani`);
  }
  assert.equal(blockedText({ v2_blocked: 'V2_ROUTE_NO_SUPPLIER' }, V2_STRINGS.ar), 'غير متاح: لا سعر مورّد');
  assert.equal(blockedText({ v2_blocked: 'V2_STOCK_SOLD_OUT' }, V2_STRINGS.ckb), V2_STRINGS.ckb.stockSoldOut);
  assert.equal(blockedText({}, V2_STRINGS.en), V2_STRINGS.en.routeBlocked);
  assert.equal(blockedText({ v2_blocked: 'V2_ROUTE_SHELF_CHEAPER' }, V2_STRINGS.en), 'Stopped: stock is cheaper');
  for (const code of ['V2_ROUTE_NO_SUPPLIER', 'V2_ROUTE_SHELF_CHEAPER', 'V2_STOCK_SOLD_OUT'] as const) {
    const l = PRICING_ISSUES[code].label;
    assert.ok(l.ar && l.en && l.ckb && l.ckb !== l.ar && sorani.test(l.ckb), code);
  }
  for (const n of [STOCK_SOLD_OUT_NOTICE, STOCK_REVIEW_NOTICE]) {
    for (const part of [n.title, n.body] as Array<{ ar: string; en: string; ckb: string }>) {
      assert.ok(part.ckb !== part.ar && sorani.test(part.ckb));
      assert.doesNotMatch(`${part.ar}${part.en}${part.ckb}`, /[0-9٠-٩]/, 'the bell carries no digit');
    }
  }
});
