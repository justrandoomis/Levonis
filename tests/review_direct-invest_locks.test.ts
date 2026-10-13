/**
 * REVIEW (direct-invest group, 5e0593f2): applying a stock purchase to a
 * MANUAL product adopts it into the engine «direct-only» (pricing_direct_purchase
 * .direct_only = true, product_pricing_state.mode = 'engine'). The engine then
 * manages the direct price only — yet every ENGINE_MANAGED lock of 0181 is
 * keyed on mode = 'engine', so the pre-order prices the engine does NOT manage
 * become frozen for the owner as well:
 *   - the quick-price grid / product form refuse any price change (ENGINE_MANAGED);
 *   - the product form's pricing save evaluates all channels and refuses
 *     (PRICING_ENGINE_INCOMPLETE) unless the pre-order inputs are complete, and
 *     `data_only` is ignored for an engine product.
 * The only exit is «إيقاف التسعير التلقائي» (POST /manual), which also drops the
 * direct-sale pricing the purchase just wrote. A stock purchase must not
 * silently change the pre-order side's engine mode or locks.
 *
 * Run: node --import tsx --test tests/review_direct-invest_locks.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, row, stubApp } from './fixtures/app';
import { pricingWorld, AMS, AMS_MODEL, OWNER_USER } from './fixtures/procurementPricing';
import { adminPriceGridRoutes } from '../worker/routes/adminPriceGrid';
import { loadProductPricing } from '../worker/lib/pricingEngine/store';

const send = async (app: ReturnType<typeof stubApp>, method: string, path: string, body: unknown) => {
  const res = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await json(res) };
};

test('a stock purchase on a manual product leaves its pre-order prices editable by the owner', async () => {
  const w = pricingWorld();
  const admin = stubApp(w.db, { ...OWNER_USER, email_verified_at: '2026-01-01T00:00:00.000Z' } as never, (a) => {
    a.route('/api/admin/products', adminPriceGridRoutes);
  }, { env: { INITIAL_ADMIN_EMAIL: OWNER_USER.email } });

  // Before: a manual product — the owner edits the shared model price freely.
  const before = await send(admin, 'PATCH', `/api/admin/products/${AMS}/price-grid`, { cells: [{ level: 'option', id: AMS_MODEL, field: 'regular', mode: 'fixed', value: '455000' }] });
  assert.notEqual(before.body.code, 'ENGINE_MANAGED', JSON.stringify(before.body));

  // The owner's stock purchase, reviewed for direct sale only (the review shows direct rows only).
  const id = await w.save(w.draft());
  const choices = { minimum_profits: [{ product_id: AMS, scope: 'product', amount_usd: '120' }], direct_sale_extras: [{ product_id: AMS, scope: 'product', amount_iqd: 50_000 }] };
  const p = await w.preview({ purchase_id: id, pricing: choices });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const product = p.body.products[0];
  assert.ok(product.adoption.rows.every((r: { channel: string }) => r.channel === 'direct_sale'), 'the review shows direct-sale rows only');
  const out = await w.apply(AMS, { purchase_id: id, preview_hash: product.preview_hash, confirm_large_change: true, minimum_profits: [{ scope: 'product', amount_usd: '120' }], direct_sale_extras: [{ scope: 'product', amount_iqd: 50_000 }] });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  const stored = await loadProductPricing(w.db, AMS);
  const facts: Record<string, unknown> = { mode: stored.state?.mode, direct_only: stored.direct_purchase?.direct_only, entered: out.body.entered };

  // After: the engine prices direct sale only; the shared/pre-order price cell stays the owner's.
  const grid = await send(admin, 'PATCH', `/api/admin/products/${AMS}/price-grid`, { cells: [{ level: 'option', id: AMS_MODEL, field: 'regular', mode: 'fixed', value: '460000' }] });
  facts.grid = { status: grid.status, code: grid.body.code };
  assert.equal(facts.mode, 'engine');
  assert.equal(facts.direct_only, true);
  assert.notEqual(grid.body.code, 'ENGINE_MANAGED', JSON.stringify(facts));
  assert.equal(grid.status, 200, JSON.stringify(facts));
  // The direct-sale price is still the engine's, and still locked outside its batch.
  const direct = () => row<{ p: number; id: string }>(w.raw, "SELECT regular_price_iqd AS p, id FROM product_option_fulfillment WHERE option_id = ? AND fulfillment_type = 'direct_sale'", AMS_MODEL)!;
  assert.equal(direct().p, 1_042_000);
  assert.throws(() => w.raw.prepare('UPDATE product_option_fulfillment SET regular_price_iqd = 1 WHERE id = ?').run(direct().id), /ENGINE_MANAGED/);
  // A full all-channel adoption clears direct_only, and every lock returns (migration 0188).
  w.raw.exec(`INSERT INTO ops_guards (id, ok) VALUES ('pricing-input-owner:${AMS}', 1);
    UPDATE pricing_direct_purchase SET payload_json = json_set(payload_json, '$.direct_only', json('false')), version = version + 1 WHERE product_id = '${AMS}';
    DELETE FROM ops_guards WHERE id = 'pricing-input-owner:${AMS}';`);
  const locked = await send(admin, 'PATCH', `/api/admin/products/${AMS}/price-grid`, { cells: [{ level: 'option', id: AMS_MODEL, field: 'regular', mode: 'fixed', value: '470000' }] });
  assert.equal(locked.body.code, 'ENGINE_MANAGED', JSON.stringify(locked.body));
});

/* The product form's pricing save keeps ignoring `data_only` on an engine
 * product: that refusal was chosen on purpose in 3c051143
 * (tests/financialIntegrationProduct.test.ts), the skeptic agreed, and the
 * reviewer's assertion on it is not carried here. The lock was the defect. */
