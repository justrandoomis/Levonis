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
import { directPurchaseStore } from '../worker/lib/pricingEngine/directPurchase';
import { loadProductPricing } from '../worker/lib/pricingEngine/store';

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
  const direct = (product.adoption.rows as Array<Record<string, unknown>>).find((r) => r.channel === 'direct_sale')!;
  assert.equal(direct.preorder_base_iqd, 992_000, 'the direct base: EUR 450 → $495 + $5 freight + $120 → 992,000');
  assert.equal(direct.computed_price_iqd, 1_042_000, 'direct base plus the existing 50,000 extra');
  assert.equal(direct.today_prepaid_iqd, 500_000);
  assert.ok(product.adoption.rows.every((r: { channel: string }) => r.channel === 'direct_sale'));
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
  assert.deepEqual({ ...route }, { p: null, s: null }, 'the existing preorder price and route fee are untouched');
  assert.equal(row<{ p: number }>(w.raw, "SELECT regular_price_iqd AS p FROM product_option_fulfillment WHERE option_id = ? AND fulfillment_type = 'direct_sale'", AMS_MODEL)!.p, 1_042_000);
  assert.equal(row<{ v: string }>(w.raw, "SELECT final_price_usd AS v FROM pricing_sku_costs WHERE channel = 'direct_sale'")!.v, '620');
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM pricing_sku_costs WHERE channel <> 'direct_sale'"), 0);
  // The committed purchase feeds the direct overlay in the same batch, leaving preorder inputs untouched.
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_inputs'), 0);
  const effective = directPurchaseStore(await loadProductPricing(w.db, AMS));
  assert.equal(effective.inputs.find((r) => r.scope === 'option')!.source_ref, `purchase:${id}`);
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

// ---------------------------------------------------------------- the Direct Sale Extra typed in the review (owner request 2026-10-10)

const ZERO = [{ scope: 'product', scope_id: '', amount_iqd: 0 }];
const typedExtras = (amount_iqd: number) => [{ product_id: AMS, scope: 'product', scope_id: '', amount_iqd }];

test('typed Direct Sale Extra 0: the direct overlay and direct price commit together, preorder is unchanged and a replay writes nothing', async () => {
  const w = pricingWorld();
  const d = w.draft();
  const look = await w.preview({ draft: d, pricing: { minimum_profits: [MIN], direct_sale_extras: typedExtras(0) } });
  assert.equal(look.body.products[0].adoption.kind, 'adopt', 'the typed extra completes the product: the review shows the prices the confirm writes');
  const id = await w.save(d);
  const saved = await w.preview({ purchase_id: id, pricing: { minimum_profits: [MIN], direct_sale_extras: typedExtras(0) } });
  const hash = String(saved.body.products[0].preview_hash);
  const books = accounting(w);
  const body = { purchase_id: id, minimum_profits: [{ scope: 'product', amount_usd: '120' }], direct_sale_extras: ZERO, preview_hash: hash };

  // A large change without the tick: refused, nothing stored — not even the rule.
  const unticked = await w.apply(AMS, body);
  assert.equal(unticked.status, 409, JSON.stringify(unticked.body));
  assert.equal(unticked.body.code, 'PRICING_LARGE_CHANGE_CONFIRM');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_rules'), 0);

  const r = await w.apply(AMS, { ...body, confirm_large_change: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.priced, true);
  const effective = directPurchaseStore(await loadProductPricing(w.db, AMS));
  const rule = effective.rules.find((r) => r.kind === 'direct_sale_extra')!;
  assert.deepEqual([rule.kind, rule.scope, rule.scope_id, rule.state, rule.source, rule.amount_iqd], ['direct_sale_extra', 'product', '', 'ACTIVE', 'OWNER', 0]);
  assert.equal(effective.inputs.find((r) => r.scope === 'option')!.source_ref, `purchase:${id}`);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_inputs'), 0);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_rules'), 0);
  const direct = row<{ p: number }>(w.raw, "SELECT regular_price_iqd AS p FROM product_option_fulfillment WHERE option_id = ? AND fulfillment_type = 'direct_sale'", AMS_MODEL)!.p;
  const land = row<{ p: number }>(
    w.raw,
    "SELECT t.regular_price_iqd AS p FROM product_option_transports t JOIN product_option_fulfillment f ON f.id = t.fulfillment_id WHERE f.option_id = ? AND t.method = 'land'",
    AMS_MODEL
  )!.p;
  assert.deepEqual([direct, land], [992_000, null], 'direct = base + 0; stored preorder price remains unchanged');
  const keys = all<{ k: string }>(w.raw, "SELECT idempotency_key AS k FROM pricing_audit WHERE idempotency_key LIKE 'apply:%'").map((x) => x.k);
  assert.equal(keys.length, 1);
  assert.match(keys[0]!, new RegExp(`^apply:${id}:${AMS}:[0-9a-f]{64}$`));
  assert.equal(accounting(w), books, 'the purchase, its lots, orders and the wallet are untouched');

  const audits = count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_audit');
  const replay = await w.apply(AMS, { ...body, confirm_large_change: true });
  assert.equal(replay.body.already, true);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_audit'), audits);
  assert.equal(row<{ v: number }>(w.raw, 'SELECT version AS v FROM pricing_direct_purchase WHERE product_id = ?', AMS)!.v, 1, 'no second overlay version');

  // Another typed extra updates the direct overlay once; the ordinary rule store stays unchanged.
  const again = await w.preview({ purchase_id: id, pricing: { minimum_profits: [MIN], direct_sale_extras: typedExtras(50_000) } });
  assert.notEqual(again.body.products[0].preview_hash, hash);
  const moved = await w.apply(AMS, { ...body, direct_sale_extras: [{ scope: 'product', scope_id: '', amount_iqd: 50_000 }], preview_hash: again.body.products[0].preview_hash, confirm_large_change: true });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(directPurchaseStore(await loadProductPricing(w.db, AMS)).rules.find((r) => r.kind === 'direct_sale_extra')!.amount_iqd, 50_000);
  assert.equal(row<{ v: number }>(w.raw, 'SELECT version AS v FROM pricing_direct_purchase WHERE product_id = ?', AMS)!.v, 2);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM pricing_rules WHERE kind = 'direct_sale_extra'"), 0);
  assert.equal(row<{ p: number }>(w.raw, "SELECT regular_price_iqd AS p FROM product_option_fulfillment WHERE option_id = ? AND fulfillment_type = 'direct_sale'", AMS_MODEL)!.p, 1_042_000);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM pricing_audit WHERE idempotency_key LIKE 'apply:%'"), 2);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM pricing_audit WHERE entity = 'rule' AND entity_key = 'direct_sale_extra:product:'"), 2, 'each version of the rule is audited, before → after');
});

test('«استعمل هذا الشراء» unticked with a typed Direct Sale Extra: the rule alone is saved — no input from the purchase, no price', async () => {
  const w = pricingWorld();
  const id = await w.save(w.draft());
  const saved = await w.preview({ purchase_id: id, pricing: { use_purchase: { [AMS]: false }, direct_sale_extras: typedExtras(0) } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const r = await w.apply(AMS, { purchase_id: id, use_purchase: false, direct_sale_extras: ZERO, preview_hash: saved.body.products[0].preview_hash });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.priced, false);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM pricing_inputs WHERE source_ref LIKE 'purchase:%'"), 0);
  const effective = directPurchaseStore(await loadProductPricing(w.db, AMS));
  const extra = effective.rules.find((r) => r.kind === 'direct_sale_extra')!;
  assert.equal(extra.amount_iqd, 0);
  assert.equal(extra.source, 'OWNER');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_rules'), 0);
  assert.equal(effective.inputs.length, 0, 'unticked purchase contributes no direct cost input');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_sku_costs'), 0);
  // The apply door validates its own entries: one product's own scope only.
  const bad = await w.apply(AMS, { purchase_id: id, use_purchase: false, direct_sale_extras: [{ product_id: AMS, scope: 'product', scope_id: '', amount_iqd: 0 }], preview_hash: saved.body.products[0].preview_hash });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'UNKNOWN_FIELD');
});
