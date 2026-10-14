/**
 * PRICING AND SHIPPING INSIDE «تعديل منتج» / «إضافة منتج» — THE SERVER GLUE
 * (owner correction 2026-10-09: the product form itself carries the owner's
 * USD pricing; FX plan §12-§13; USD design §5.3, decision 8's six figures).
 * Routes: GET|PUT /products/:id/inputs, POST /products/:id/preview
 * (worker/lib/pricingEngine/productInputs.ts).
 *
 * Proves:
 *   - the IQD convenience input converts ONCE, at save, to canonical USD =
 *     floor6(I ÷ U) with its snapshot (dinars, U, U's version, time); the
 *     preview shows the conversion and the save needs that preview's hash; a
 *     rate moved since is PRICING_PREVIEW_STALE; the same dinars again keep the
 *     snapshot byte for byte unless «حوّل مرة أخرى» (reconvert); the client can
 *     never send the USD or the rate; no USD rate refuses;
 *   - the brief's example from dinars: 792,000 IQD → $495 → … → 992,000 IQD;
 *   - the shipping box travels whole and prices sea freight by its CBM;
 *   - every answer carries decision 8's six figures per model × channel, the
 *     preview's with the drafts, and the preview writes nothing;
 *   - no customer price moves (this stage writes no price).
 *
 * THE CLEAN START (spec addendum A.6, A.12.2; DECISIONS row 222): the V1
 * routes and writers this file proved are closed — 409 PRICING_V2_MANAGED for
 * the owner (tests/pricingV2LegacyDoorsRefused.test.ts) — and their tests went
 * with them. What stays here still holds on the closed doors.
 *
 * Run: node --import tsx --test tests/productFormPricing.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { count } from './fixtures/app';
import { pricingWorld, AMS } from './fixtures/procurementPricing';

test('the door: the dinar conversion and the box are the verified owner’s alone', async () => {
  for (const user of [
    { id: 'usr_full', role: 'admin' as const, email: 'full@x.co' },
    { id: 'usr_asst', role: 'admin' as const, email: 'asst@x.co', admin_scope: 'assistant' },
  ]) {
    const w = pricingWorld({ user });
    const p = await w.previewInputs(AMS, { inputs: [{ scope: 'base', supplier_cost_iqd: 792_000 }] });
    const u = await w.putInputs(AMS, { inputs_seq: 0, inputs: [{ scope: 'base', shipping_length_mm: 500, shipping_width_mm: 400, shipping_height_mm: 300 }] });
    for (const r of [p, u]) {
      assert.equal(r.status, 403, `${user.id} ${JSON.stringify(r.body)}`);
      assert.doesNotMatch(JSON.stringify(r.body), /792000|495|1600/);
    }
    assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_inputs'), 0);
  }
});
