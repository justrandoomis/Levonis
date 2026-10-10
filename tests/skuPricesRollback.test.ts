/**
 * FX-7 BLOCKERS REVIEW — A SKU ROW IS CHARGED ONLY WHILE THE ENGINE STILL SAYS IT
 * (migration 0183, `product_sku_prices`; worker/lib/productOverlay.ts `skuPriceRows`).
 *
 * 0183's rollback safety covers an older Worker READING the database: it ignores
 * the table, and the ladder beneath holds each model's highest. It did not cover
 * that older Worker WRITING, and then this one coming back:
 *   - its «رجوع إلى التسعير اليدوي» (8a170ee6, the commit before FX-7) flips the
 *     product to manual and deletes its `pricing_sku_costs`, and knows nothing of
 *     `product_sku_prices` — the SKU rows stay behind;
 *   - its automatic repricing prices a colour product per model (it ignores the
 *     colour's inputs) and rewrites `pricing_sku_costs` under the models' keys —
 *     the SKU rows stay behind, at the old figures.
 * Read back by this Worker, a row left like that overrode the manual prices the
 * owner typed afterwards (forever: nothing deletes a manual product's rows) or
 * the engine's newer figures. So the overlay reads a SKU row only while the
 * product is engine-priced AND the engine's own stored result for that exact
 * SKU × channel is the same price — the pair every engine batch writes together.
 * A row that fails either is inert: the ladder answers, exactly as it does for
 * an older Worker.
 *
 * Run: node --import tsx --test tests/skuPricesRollback.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { count, row } from './fixtures/app';
import { pricingWorld } from './fixtures/procurementPricing';
import { legacyProductId } from './fixtures/legacyCatalogue';
import { loadPreviewContext, loadProducts } from '../worker/lib/pricingEngine/load';
import { loadRelationsView, loadRelationsViews } from '../worker/lib/productOverlay';
import { resolveCartLine } from '../worker/routes/cart';

type World = ReturnType<typeof pricingWorld>;

// bambu-lab-pla-matte-1kg: two models, 25 colours (linked to every model), sold direct and by sea pre-order.
const PID = legacyProductId('bambu-lab-pla-matte-1kg');
const M0 = `${PID}_o0`;
const M1 = `${PID}_o1`;
const C = (k: number) => `${PID}_c${k}`;
const sku = (ids: string[], colour: string | null) => [...[...ids].sort().map((id) => `o:${id}`), ...(colour ? [`c:${colour}`] : [])].join('|');

const PER_COLOUR = {
  inputs: [
    { scope: 'base', supplier_cost_amount: '10', supplier_cost_currency: 'USD', shipping_profile: 'CHINA_SEA', manual_cbm: '0.005' },
    { scope: 'color', scope_id: C(0), supplier_cost_amount: '12', supplier_cost_currency: 'USD' },
  ],
  rules: [
    { kind: 'target_profit', scope: 'product', amount_usd: '3' },
    { kind: 'direct_sale_extra', scope: 'product', amount_iqd: 2000 },
  ],
};

const ceil1000 = (n: number) => Math.ceil(n / 1000) * 1000;
/** The pre-order price of lp_23 at U = 1,600: supplier $ + 0.005 CBM × 400,000 + the minimum profit $, rounded up. */
const sea = (usd: number, target: number, u = 1600) => ceil1000(usd * u + 0.005 * 400_000 + target * u);

const seqOf = (w: World, pid: string) => row<{ s: number }>(w.raw, 'SELECT inputs_seq AS s FROM product_pricing_state WHERE product_id = ?', pid)?.s ?? 0;

/** The owner's save: 409 with the preview, then the same body with its hash. */
async function save(w: World, pid: string, draft: Record<string, unknown>) {
  const first = await w.putInputs(pid, { inputs_seq: seqOf(w, pid), ...draft });
  assert.equal(first.status, 409, JSON.stringify(first.body).slice(0, 600));
  const preview = first.body.details.preview;
  const saved = await w.putInputs(pid, { inputs_seq: seqOf(w, pid), ...draft, preview_hash: preview.preview_hash, confirm_large_change: true });
  assert.equal(saved.status, 200, JSON.stringify(saved.body).slice(0, 600));
  assert.equal(saved.body.mode, 'engine');
}

/** What the cart charges a guest for one line, prepaid. */
async function charge(w: World, ids: string[], colour: string, route: '' | 'sea') {
  const loaded = (await loadProducts(w.db, [PID])).get(PID)!;
  const ctx = await loadPreviewContext(w.db);
  const r = resolveCartLine(
    loaded.row,
    { optionId: ids[0] ?? '', optionValueIds: ids, colorId: colour, transportMethod: route, fulfillmentType: route ? 'pre_order' : 'direct_sale', warrantyPlanId: '' },
    'free',
    false,
    ctx,
    loaded.view,
    'prepaid'
  );
  assert.deepEqual([...r.resolved.errors, ...r.selectionErrors], [], `${ids.join('+')} ${colour} ${route}`);
  return r.resolved.unit_subtotal_iqd;
}

const skuRowCount = (w: World) => count(w.raw, 'SELECT COUNT(*) AS n FROM product_sku_prices WHERE product_id = ?', PID);

/** Exactly the batch 8a170ee6's `POST /products/:id/manual` sends (the Worker before FX-7): no word of product_sku_prices. */
function olderWorkerExit(w: World) {
  const now = new Date().toISOString();
  w.raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('pricing-mode:${PID}', 1)`);
  w.raw
    .prepare("UPDATE product_pricing_state SET mode = 'manual', write_seq = write_seq + 1, opted_out_at = ?, opted_out_by = 'usr_owner', updated_at = ? WHERE product_id = ?")
    .run(now, now, PID);
  w.raw.prepare('DELETE FROM pricing_sku_costs WHERE product_id = ?').run(PID);
  w.raw.exec(`DELETE FROM ops_guards WHERE id = 'pricing-mode:${PID}'`);
}

test('an older Worker’s exit to manual leaves the SKU rows behind: back on this Worker they never override the owner’s manual prices — not in the cart, not on the card', async () => {
  const w = pricingWorld();
  await save(w, PID, PER_COLOUR);
  assert.ok(skuRowCount(w) > 0, 'priced per colour: SKU rows');
  assert.equal(await charge(w, [M0], C(5), 'sea'), sea(10, 3), 'engine-priced: the SKU row');

  olderWorkerExit(w);
  assert.ok(skuRowCount(w) > 0, 'the older Worker left the SKU rows');
  // The owner, on manual pricing now, types a sea price of 30,000 for model 1 (no engine lock on a manual product).
  const fid = row<{ id: string }>(w.raw, "SELECT id FROM product_option_fulfillment WHERE option_id = ? AND fulfillment_type = 'pre_order'", M0)!.id;
  w.raw.prepare("UPDATE product_option_transports SET regular_price_iqd = 30000 WHERE fulfillment_id = ? AND method = 'sea'").run(fid);
  w.raw.prepare("UPDATE product_option_fulfillment SET regular_price_iqd = 30000 WHERE id = ?").run(fid);

  for (const k of [0, 5, 17]) assert.equal(await charge(w, [M0], C(k), 'sea'), 30_000, `colour ${k}: the owner's manual price, not a left-over SKU row`);

  // Every reader of the rung sees none: the one-product and the list views, so the card and the cart agree.
  const one = await loadRelationsView(w.db, PID, 'BASE');
  assert.deepEqual(one.sku_prices, [], 'the table is there (an array), the rows are inert');
  assert.equal(one.sku_prices_unread, undefined);
  const many = (await loadRelationsViews(w.db, [{ id: PID, inventory_mode: 'BASE' }])).get(PID)!;
  assert.deepEqual(many.sku_prices, []);
  const loaded = (await loadProducts(w.db, [PID])).get(PID)!;
  assert.equal(loaded.doc.sku_prices, undefined, 'no SKU rung on the customer document (the card, compare and the finder read it)');
});

test('a SKU row the engine’s own stored result no longer says (an older Worker priced the product per model) is not charged: the ladder answers; the rows the engine wrote together are', async () => {
  const w = pricingWorld();
  await save(w, PID, PER_COLOUR);
  const k5 = sku([M0], C(5));
  assert.equal(await charge(w, [M0], C(5), 'sea'), sea(10, 3));
  assert.equal(await charge(w, [M1], C(9), ''), sea(10, 3) + 2000);
  const highest = await charge(w, [M0], C(0), 'sea');
  assert.equal(highest, sea(12, 3), 'colour 0 is the model’s highest on sea');

  // The engine's stored result for one SKU × channel no longer names its row (what an older Worker's per-model
  // write leaves: pricing_sku_costs rewritten under the models' keys, product_sku_prices untouched).
  w.raw.prepare('DELETE FROM pricing_sku_costs WHERE product_id = ? AND combo_key = ? AND channel = ?').run(PID, k5, 'pre_order_sea');
  assert.equal(await charge(w, [M0], C(5), 'sea'), highest, 'that SKU × channel: the ladder (the model’s highest), never the stale row');
  assert.equal(await charge(w, [M0], C(5), ''), sea(10, 3) + 2000, 'its other channel still agrees: still its own row');
  assert.equal(await charge(w, [M1], C(9), ''), sea(10, 3) + 2000, 'every other SKU: its own row');

  // Gone altogether (the older Worker's per-model keys): every SKU row is inert.
  w.raw.prepare("DELETE FROM pricing_sku_costs WHERE product_id = ? AND combo_key LIKE '%|c:%'").run(PID);
  assert.equal(await charge(w, [M1], C(9), 'sea'), highest, 'the ladder');
  assert.deepEqual((await loadRelationsView(w.db, PID, 'BASE')).sku_prices, []);
});
