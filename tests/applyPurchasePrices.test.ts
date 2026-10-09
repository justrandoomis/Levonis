/**
 * APPLY-PURCHASE WRITES PRICES AFTER ITS PREVIEW (owner decision 8 in «التكاليف
 * والشحن»; USD design §6.3, §6.4).
 *
 * Proves: a confirmed purchase that leaves the product complete adopts the
 * engine and writes its prices in the apply's own batch — after the review
 * preview carried the six figures and a hash that covers the prices; a change
 * above 15% needs the tick; a replay is `already` and writes nothing; the
 * purchase's own rows, lots and wallet are untouched; a product the purchase
 * does not complete stores the costs only.
 *
 * Run: node --import tsx --test tests/applyPurchasePrices.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, count, row } from './fixtures/app';
import { pricingWorld, AMS, AMS_MODEL } from './fixtures/procurementPricing';

type World = ReturnType<typeof pricingWorld>;
const MIN = { product_id: AMS, scope: 'product', amount_usd: '120' };

const accounting = (w: World) =>
  JSON.stringify(
    ['purchase_orders', 'purchase_lines', 'purchase_charges', 'incoming_inventory', 'inventory_lots', 'inventory_lot_cost_versions', 'orders', 'order_items', 'wallet_transactions'].map((t) =>
      all(w.raw, `SELECT * FROM ${t} ORDER BY rowid`)
    )
  );

/** The Direct Sale Extra first (data only: the product is still incomplete), then the purchase looked at and saved. */
async function completingPurchase(w: World) {
  const rules = await w.putRules(AMS, { inputs_seq: 0, rules: [{ kind: 'direct_sale_extra', scope: 'product', amount_iqd: 50_000 }] });
  assert.equal(rules.status, 200, JSON.stringify(rules.body));
  const d = w.draft();
  const look = await w.preview({ draft: d, pricing: { minimum_profits: [MIN] } });
  assert.equal(look.status, 200, JSON.stringify(look.body));
  const id = await w.save(d);
  // The review step reads the committed purchase again before the apply (the same preview the confirm loop uses).
  const saved = await w.preview({ purchase_id: id, pricing: { minimum_profits: [MIN] } });
  return { id, look, saved };
}

test('a purchase that completes the product: the review preview shows the six figures; the apply adopts the engine and writes the prices in its own batch', async () => {
  const w = pricingWorld();
  const { id, look, saved } = await completingPurchase(w);
  const product = look.body.products[0];
  assert.equal(product.adoption.kind, 'adopt');
  assert.equal(product.adoption.complete, true);
  const land = (product.adoption.rows as Array<Record<string, unknown>>).find((r) => r.channel === 'pre_order_land')!;
  assert.equal(land.computed_price_iqd, 992_000, 'the brief: EUR 450 → $495 + $5 freight + $120 → 992,000');
  assert.equal(land.today_prepaid_iqd, 450_000);
  assert.equal(product.adoption.large_change, true);
  const hash = String(saved.body.products[0].preview_hash);
  const books = accounting(w);

  const unticked = await w.apply(AMS, { purchase_id: id, minimum_profits: [{ scope: 'product', amount_usd: '120' }], preview_hash: hash });
  assert.equal(unticked.status, 409, JSON.stringify(unticked.body));
  assert.equal(unticked.body.code, 'PRICING_LARGE_CHANGE_CONFIRM');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM product_pricing_state WHERE mode = 'engine'"), 0);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM pricing_inputs WHERE source_ref LIKE 'purchase:%'"), 0, 'a refused apply stores nothing');

  const r = await w.apply(AMS, { purchase_id: id, minimum_profits: [{ scope: 'product', amount_usd: '120' }], preview_hash: hash, confirm_large_change: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.priced, true);
  assert.equal(r.body.entered, true);
  assert.equal(row<{ mode: string }>(w.raw, 'SELECT mode FROM product_pricing_state WHERE product_id = ?', AMS)!.mode, 'engine');
  const route = row<{ p: number; s: number }>(
    w.raw,
    "SELECT t.regular_price_iqd AS p, t.surcharge_iqd AS s FROM product_option_transports t JOIN product_option_fulfillment f ON f.id = t.fulfillment_id WHERE f.option_id = ? AND t.method = 'land'",
    AMS_MODEL
  )!;
  assert.deepEqual({ ...route }, { p: 992_000, s: 0 });
  assert.equal(row<{ p: number }>(w.raw, "SELECT regular_price_iqd AS p FROM product_option_fulfillment WHERE option_id = ? AND fulfillment_type = 'direct_sale'", AMS_MODEL)!.p, 1_042_000);
  assert.equal(row<{ v: string }>(w.raw, "SELECT final_price_usd AS v FROM pricing_sku_costs WHERE channel = 'pre_order_land'")!.v, '620');
  // The inputs came from the committed purchase, in the same batch.
  assert.equal(row<{ s: string }>(w.raw, "SELECT source_ref AS s FROM pricing_inputs WHERE scope = 'option'")!.s, `purchase:${id}`);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM pricing_audit WHERE action = 'input_from_purchase' AND entity = 'product_write'"), 1);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM pricing_audit WHERE action = 'engine_entry'"), 1);
  // Accounting stays IQD and untouched: the purchase, its lots, orders and the wallet.
  assert.equal(accounting(w), books);

  // A replay: already, nothing new.
  const audits = count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_audit');
  const again = await w.apply(AMS, { purchase_id: id, minimum_profits: [{ scope: 'product', amount_usd: '120' }], preview_hash: hash, confirm_large_change: true });
  assert.equal(again.status, 200);
  assert.equal(again.body.already, true);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_audit'), audits);
});

test('a purchase that leaves the product incomplete stores its costs only; the price stays manual', async () => {
  const w = pricingWorld();
  const d = w.draft();
  const look = await w.preview({ draft: d, pricing: { minimum_profits: [MIN] } });
  assert.equal(look.body.products[0].adoption.kind, null, 'no Direct Sale Extra yet: the direct channel is not priced');
  assert.ok((look.body.products[0].adoption.missing_codes as string[]).includes('DIRECT_SALE_EXTRA_MISSING'));
  const id = await w.save(d);
  const r = await w.apply(AMS, { purchase_id: id, minimum_profits: [{ scope: 'product', amount_usd: '120' }], preview_hash: look.body.products[0].preview_hash });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.priced, false);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM product_pricing_state WHERE mode = 'engine'"), 0);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_sku_costs'), 0);
});
