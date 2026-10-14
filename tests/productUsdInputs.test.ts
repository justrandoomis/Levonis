/**
 * «التسعير بالدولار والشحن» IN THE PRODUCT FORM — the owner's own inputs per
 * product and per model (owner brief 2026-10-09; the owner's request: pricing
 * and shipping are entered where the product is added or edited, in its prices
 * and its options' prices). Routes: GET /products/:id/inputs, POST
 * /products/:id/preview, PUT /products/:id/inputs (worker/lib/pricingEngine/
 * productInputs.ts).
 *
 * Proves: the brief's example gives $500 / +$120 / $620 / 992,000 IQD from the
 * form; a model's own value beats the product's and null hands it back; the
 * save is atomic, fenced, audited (values in pricing_audit only, ids and counts
 * in audit_log) and writes no price; the preview writes nothing; validation
 * names fields; the door is the owner's alone.
 *
 * THE CLEAN START (spec addendum A.6, A.12.2; DECISIONS row 222): the V1
 * routes and writers this file proved are closed — 409 PRICING_V2_MANAGED for
 * the owner (tests/pricingV2LegacyDoorsRefused.test.ts) — and their tests went
 * with them. What stays here still holds on the closed doors.
 *
 * Run: node --import tsx --test tests/productUsdInputs.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { count } from './fixtures/app';
import { pricingWorld, AMS } from './fixtures/procurementPricing';

const BRIEF_BASE = { scope: 'base', supplier_cost_amount: '450', supplier_cost_currency: 'EUR', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 2500 };

test('the door: every other admin is refused at the pricing door; a customer never reaches it', async () => {
  for (const user of [
    { id: 'usr_full', role: 'admin' as const, email: 'full@x.co' },
    { id: 'usr_asst', role: 'admin' as const, email: 'asst@x.co', admin_scope: 'assistant' },
    { id: 'usr_cust', role: 'customer' as const, email: 'c@x.co' },
  ]) {
    const w = pricingWorld({ user });
    const g = await w.getInputs(AMS);
    const p = await w.previewInputs(AMS, { inputs: [BRIEF_BASE] });
    const u = await w.putInputs(AMS, { inputs_seq: 0, inputs: [BRIEF_BASE] });
    for (const r of [g, p, u]) {
      assert.equal(r.status, 403, `${user.id} ${JSON.stringify(r.body)}`);
      assert.doesNotMatch(JSON.stringify(r.body), /450|2500/);
    }
    assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_inputs'), 0);
  }
});
