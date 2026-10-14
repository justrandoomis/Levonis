/**
 * Services V2 survey — price protection: bugs found on 3b0f6f4f, ported onto
 * the default branch for stage S-P0. Every test states the CORRECT behaviour.
 * Local only (fresh in-memory database).
 *
 * Ported here:
 *   - PP-B1 (owner decision 3: an assistant moves no money) and PP-B8 (one
 *     money process per unit, plan §1.3) — the money-gates stage;
 *   - PP-B2 (the rung that priced the line), PP-B3 (the line's channel),
 *     PP-B4 (the buyer's price class), PP-B6 (the customer is told the
 *     decision), PP-B7 (the customer's projection) and PP-B10 (Arabic and
 *     Sorani refusals) — the protection-rule stage.
 * PP-B5 (per-unit claims) and PP-B9 (a refund net of a credit) land with S-P8.
 *
 * Run: node --import tsx --test tests/sv2_price-protection_bugs.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ppWorld } from './sv2_price-protection_fixture';

/** A plain product, one price, no options. */
function plain(w: ReturnType<typeof ppWorld>, id = 'p', price = 40_000) {
  w.raw.prepare(`INSERT INTO products (id, slug, name, status, price_iqd, stock) VALUES (?, ?, 'Plain', 'active', ?, 5)`).run(id, id, price);
}

// ---------------------------------------------------------------- PP-B1
test('PP-B1 an assistant-scope admin cannot approve a claim and credit the wallet (money needs the financial scope)', async () => {
  const w = ppWorld();
  plain(w);
  const { itemId } = w.deliveredLine({ productId: 'p', unit: 50_000 });
  const c = await w.claim(itemId);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const r = await w.decide(w.assistant, c.body.claim.id);
  assert.equal(
    r.status,
    403,
    `assistant credited the wallet: status ${r.status}, wallet rows ${w.n("SELECT COUNT(*) n FROM wallet_transactions WHERE id LIKE 'wtx_pp_%'")} — ${JSON.stringify(r.body).slice(0, 160)}`
  );
  assert.equal(r.body.code, 'FINANCIAL_SCOPE_REQUIRED');
});

// ---------------------------------------------------------------- PP-B2
test('PP-B2 a change of the BASE price is not a drop of a model that carries its own price', async () => {
  const w = ppWorld();
  w.raw.exec(`
    INSERT INTO products (id, slug, name, status, price_iqd, stock) VALUES ('pm', 'pm', 'Printer', 'active', 200000, 5);
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('pm_g', 'pm', 'Model', 0, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active, stock, regular_price_iqd)
      VALUES ('pm_combo', 'pm', 'pm_g', 'Combo', 0, 1, 5, 350000), ('pm_solo', 'pm', 'pm_g', 'Solo', 1, 1, 5, NULL);`);
  const { itemId } = w.deliveredLine({ productId: 'pm', unit: 350_000, optionId: 'pm_combo' });
  // The owner RAISES the base price (the Solo model) 200,000 → 210,000. The Combo stays 350,000.
  w.raw.exec(`UPDATE products SET price_iqd = 210000 WHERE id = 'pm'`);
  w.priceRow('pm', '', 200_000, 210_000);
  const c = await w.claim(itemId);
  assert.equal(
    c.status,
    400,
    `a Combo buyer was offered the base price as a drop: observed ${c.body.claim?.observed_unit_iqd}, claimable ${(c.body.claim?.original_unit_iqd ?? 0) - (c.body.claim?.observed_unit_iqd ?? 0)} IQD`
  );
  assert.equal(c.body.code, 'NO_ELIGIBLE_DROP');
});

// ---------------------------------------------------------------- PP-B3
test('PP-B3 a pre-order line is compared with today’s PRE-ORDER price, not the direct-sale price', async () => {
  const w = ppWorld();
  w.raw.exec(`
    INSERT INTO products (id, slug, name, status, price_iqd, stock, sale_types) VALUES ('pf', 'pf', 'Printer', 'active', 900000, 5, '["direct_sale","pre_order"]');
    INSERT INTO product_option_groups (id, product_id, name_en, sort, active) VALUES ('pf_g', 'pf', 'Model', 0, 1);
    INSERT INTO product_option_values (id, product_id, group_id, name_en, sort, active, stock, regular_price_iqd)
      VALUES ('pf_a', 'pf', 'pf_g', 'A', 0, 1, 5, 900000);
    INSERT INTO product_option_fulfillment (id, product_id, option_id, fulfillment_type, enabled, regular_price_iqd)
      VALUES ('pf_a_d', 'pf', 'pf_a', 'direct_sale', 1, 950000), ('pf_a_p', 'pf', 'pf_a', 'pre_order', 1, 900000);
    INSERT INTO product_option_transports (id, product_id, fulfillment_id, method, enabled, surcharge_iqd, regular_price_iqd)
      VALUES ('pf_a_p_air', 'pf', 'pf_a_p', 'air', 1, 0, 900000);`);
  const { itemId } = w.deliveredLine({
    productId: 'pf', unit: 900_000, optionId: 'pf_a',
    pricing: { pricing_basis: 'preorder' }, transport: { method: 'air', commission_iqd: 0 },
  });
  // The pre-order (air) price falls 900,000 → 870,000; the direct price stays 950,000.
  w.raw.exec(`UPDATE product_option_fulfillment SET regular_price_iqd = 870000 WHERE id = 'pf_a_p';
              UPDATE product_option_transports SET regular_price_iqd = 870000 WHERE id = 'pf_a_p_air';`);
  const c = await w.claim(itemId);
  assert.equal(c.status, 200, `the pre-order buyer is refused a real 30,000 drop: ${c.body.code} — ${c.body.error}`);
  assert.equal(c.body.claim.observed_unit_iqd, 870_000);
});

// ---------------------------------------------------------------- PP-B4
test('PP-B4 a PRIME buyer is compared with today’s PRIME price (policy 10.4: “a buyer of the same price class”)', async () => {
  const w = ppWorld();
  w.raw.exec(`INSERT INTO products (id, slug, name, status, price_iqd, prime_price_iqd, stock) VALUES ('pp', 'pp', 'Printer', 'active', 100000, 90000, 5)`);
  const { itemId } = w.deliveredLine({ productId: 'pp', unit: 90_000, pricing: { applied_tier: 'prime', applied_iqd: 90_000, regular_iqd: 100_000 } });
  // Both prices fall 5%: regular 95,000, PRIME 85,500.
  w.raw.exec(`UPDATE products SET price_iqd = 95000, prime_price_iqd = 85500 WHERE id = 'pp'`);
  w.priceRow('pp', '', 100_000, 95_000);
  w.priceRow('pp', '', 90_000, 85_500, undefined, 'prime');
  const c = await w.claim(itemId);
  assert.equal(c.status, 200, `the PRIME buyer is compared with the regular price and refused: ${c.body.code}`);
  assert.equal(c.body.claim.observed_unit_iqd, 85_500);
});

// ---------------------------------------------------------------- PP-B6
test('PP-B6 the customer is told the decision (bell, ar/en/ckb)', async () => {
  const w = ppWorld();
  plain(w);
  const { itemId } = w.deliveredLine({ productId: 'p', unit: 50_000 });
  const c = await w.claim(itemId);
  const r = await w.decide(w.owner, c.body.claim.id);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const told = w.n("SELECT COUNT(*) n FROM user_notifications WHERE user_id = 'buyer'");
  assert.ok(told >= 1, 'a 10,000 IQD credit reached the wallet and the customer was never notified');
});

// ---------------------------------------------------------------- PP-B7
test('PP-B7 the customer’s claim view carries no internal note (the policy snapshot is staff material)', async () => {
  const w = ppWorld();
  plain(w);
  const { itemId } = w.deliveredLine({ productId: 'p', unit: 50_000 });
  await w.claim(itemId);
  const mine = await w.myClaims();
  const text = JSON.stringify(mine.claims[0]);
  assert.ok(!/DECISIONS\.md|owner decision pending|configurable default/i.test(text), `customer reads: ${JSON.stringify(mine.claims[0].policy?.compensation_channel)}`);
});

// ---------------------------------------------------------------- PP-B8
test('PP-B8 a unit already handed in for trade-in is not price-protected (it was valued on the price paid)', async () => {
  const w = ppWorld();
  plain(w);
  const { orderId, itemId } = w.deliveredLine({ productId: 'p', unit: 50_000 });
  const now = new Date().toISOString();
  w.raw
    .prepare(`INSERT INTO trade_in_requests (id, user_id, status, order_id, order_item_id, unit_index, family, created_at, updated_at)
              VALUES ('ti1', 'buyer', 'completed', ?, ?, 1, 'fdm', ?, ?)`)
    .run(orderId, itemId, now, now);
  w.raw.prepare(`INSERT INTO trade_in_claims (order_item_id, unit_index, part, request_id, created_at) VALUES (?, 1, 'device', 'ti1', ?)`).run(itemId, now);
  const c = await w.claim(itemId);
  assert.equal(c.status, 400, `a traded-in unit was offered ${(c.body.claim?.original_unit_iqd ?? 0) - (c.body.claim?.observed_unit_iqd ?? 0)} IQD of protection on top of its trade-in value`);
});

// ---------------------------------------------------------------- PP-B10
test('PP-B10 every refusal the claim route can answer reads in Arabic and Sorani (row 183)', async () => {
  const { refusalText } = await import('../src/lib/refusalStrings');
  const codes = ['NOT_DELIVERED', 'WINDOW_CLOSED', 'PRODUCT_MISSING', 'COMPOSITION_NOT_ELIGIBLE', 'CLAIM_PENDING', 'VARIANT_UNRESOLVED',
    'FX_ONLY_DROP', 'NO_ELIGIBLE_DROP', 'ALREADY_COMPENSATED', 'PRICE_PROTECTION_RETURN_REVIEW'];
  const missing = codes.filter((k) => refusalText(k, 'ckb', '\u0000') === '\u0000' || refusalText(k, 'ar', '\u0000') === '\u0000');
  assert.deepEqual(missing, [], `an Arabic/Sorani customer reads the server's English for: ${missing.join(', ')}`);
});
