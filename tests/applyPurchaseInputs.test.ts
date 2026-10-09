/**
 * `POST /api/admin/pricing/products/:id/apply-purchase` — A CONFIRMED PURCHASE
 * → THE PRODUCT'S CURRENT COSTS AND THE OWNER'S TYPED MINIMUM PROFITS (USD
 * design §3.1, §6.3, §6.4, §12 P-C; owner question Q1's default: yes).
 *
 * Proves: which purchases may feed (ordered / partial / received with a final
 * cost; never draft, cancelled or estimated); the body carries no cost amount;
 * `source_ref = purchase:<id>`; a replay after the receive's version bump is
 * `already: true`; the purchase's own batch holds no pricing statement; an
 * IQD-converted supplier cost is replaced with its snapshot cleared under the
 * owner token; a cancelled source is flagged; the apply writes no procurement
 * or lot row and no price; audit_log carries ids and counts only.
 *
 * Run: node --import tsx --test tests/applyPurchaseInputs.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, count, post, row } from './fixtures/app';
import { pricingWorld, AMS, AMS_MODEL } from './fixtures/procurementPricing';

type World = ReturnType<typeof pricingWorld>;
const MIN = [{ scope: 'product', amount_usd: '120' }];
const ZERO_HASH = '0'.repeat(64);

/** The owner's look at the draft, then the confirm: the purchase saved, its preview hash. */
async function confirmed(w: World, extra: Record<string, unknown> = {}) {
  const d = w.draft(extra);
  const look = await w.preview({ draft: d, pricing: { minimum_profits: [{ product_id: AMS, ...MIN[0] }] } });
  assert.equal(look.status, 200, JSON.stringify(look.body));
  const id = await w.save(d);
  return { id, hash: String(look.body.products[0].preview_hash), operation: String(d.operation_id) };
}

const snapshot = (w: World) =>
  JSON.stringify(
    ['purchase_orders', 'purchase_lines', 'purchase_charges', 'incoming_inventory', 'inventory_lots', 'inventory_lot_cost_versions', 'products', 'product_option_values', 'product_option_fulfillment', 'product_option_transports', 'price_history'].map((t) =>
      all(w.raw, `SELECT * FROM ${t} ORDER BY rowid`)
    )
  );

test('an ordered purchase with a final cost applies: inputs from the committed lines, the typed minimum profit, source_ref purchase:<id>; no procurement row, lot or price moves', async () => {
  const w = pricingWorld();
  const { id, hash } = await confirmed(w);
  // The purchase's own batch wrote no pricing row.
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_inputs'), 0);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_rules WHERE product_id IS NOT NULL'), 0);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_audit'), 0);
  const stored = row<{ request_json: string }>(w.raw, 'SELECT request_json FROM purchase_orders WHERE id = ?', id)!;
  assert.doesNotMatch(stored.request_json, /minimum|amount_usd|pricing_summary/);

  const before = snapshot(w);
  const r = await w.apply(AMS, { purchase_id: id, minimum_profits: MIN, preview_hash: hash });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.already, false);
  assert.equal(snapshot(w), before, 'no purchase, lot or price row changed');
  const input = row<Record<string, unknown>>(w.raw, "SELECT * FROM pricing_inputs WHERE scope = 'option' AND scope_id = ?", AMS_MODEL)!;
  assert.equal(input.source_ref, `purchase:${id}`);
  assert.equal(input.supplier_cost_amount, '450');
  assert.equal(input.supplier_cost_currency, 'EUR');
  assert.equal(input.shipping_weight_g, 2500);
  assert.equal(input.shipping_profile, 'GERMANY_LAND');
  assert.equal(row<{ amount_usd: string }>(w.raw, "SELECT amount_usd FROM pricing_rules WHERE product_id = ? AND kind = 'target_profit'", AMS)!.amount_usd, '120');
  const log = row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'pricing.applied_from_purchase'")!;
  assert.deepEqual(Object.keys(JSON.parse(log.detail)).sort(), ['entered', 'product_id', 'purchase_id', 'rows_changed']);
  assert.doesNotMatch(log.detail, /450|120|2500/);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM ops_guards WHERE id LIKE 'pricing-input-owner:%'"), 0);

  // A saved purchase's view now says the cost was applied.
  const saved = await w.preview({ purchase_id: id });
  assert.equal(saved.body.products[0].applied, true);
});

test('quick receive (received) and a part receipt (partial) still apply; the replay after the receive’s version bump is already:true', async () => {
  const w = pricingWorld();
  const a = await confirmed(w);
  const recv = await w.receive(a.id, `op_recv_${a.id.slice(-8)}_full`);
  assert.equal(recv.status, 200, JSON.stringify(recv.body));
  assert.equal(row<{ status: string }>(w.raw, 'SELECT status FROM purchase_orders WHERE id = ?', a.id)!.status, 'received');
  const first = await w.apply(AMS, { purchase_id: a.id, minimum_profits: MIN, preview_hash: a.hash });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const audits = count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_audit');
  const replay = await w.apply(AMS, { purchase_id: a.id, minimum_profits: MIN, preview_hash: a.hash });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.already, true);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_audit'), audits);

  const w2 = pricingWorld();
  const b = await confirmed(w2);
  const lines = all<{ line_id: string }>(w2.raw, 'SELECT id AS line_id FROM purchase_lines WHERE purchase_id = ?', b.id);
  const part = await post(w2.app, `/api/admin/procurement/documents/${b.id}/receive`, { operation_id: `op_part_${b.id.slice(-8)}`, lines: lines.map((l) => ({ line_id: l.line_id, qty: 1, rejected_qty: 0 })) });
  assert.equal(part.status, 200, await part.text());
  assert.equal(row<{ status: string }>(w2.raw, 'SELECT status FROM purchase_orders WHERE id = ?', b.id)!.status, 'partial');
  const applied = await w2.apply(AMS, { purchase_id: b.id, minimum_profits: MIN, preview_hash: b.hash });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
});

test('a draft, an estimated cost or a cancelled purchase cannot feed pricing (409 with the reason code only)', async () => {
  const w = pricingWorld();
  const draft = await w.save(w.draft({ status: 'draft' }));
  const estimated = await w.save(w.draft({ cost_state: 'estimated' }));
  const cancelledId = await w.save(w.draft());
  const closed = await post(w.app, `/api/admin/procurement/documents/${cancelledId}/close`, { reason: 'المورد ألغى الطلب' });
  assert.equal(closed.status, 200, await closed.text());
  for (const [id, reason] of [[draft, 'status'], [estimated, 'estimated'], [cancelledId, 'status']] as const) {
    const r = await w.apply(AMS, { purchase_id: id, minimum_profits: MIN, preview_hash: ZERO_HASH });
    assert.equal(r.status, 409, `${reason} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'PRICING_PURCHASE_NOT_ELIGIBLE');
    assert.deepEqual(r.body.details, { reason });
  }
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_inputs'), 0);
});

test('the body carries no cost amount: any amount key is UNKNOWN_FIELD; a changed purchase is PRICING_PREVIEW_STALE with a fresh preview', async () => {
  const w = pricingWorld();
  const { id, hash } = await confirmed(w);
  for (const key of ['supplier_cost_amount', 'shipping_weight_g', 'additional_cost_iqd', 'amount_iqd']) {
    const r = await w.apply(AMS, { purchase_id: id, preview_hash: hash, [key]: 1 });
    assert.equal(r.status, 400, key);
    assert.equal(r.body.code, 'UNKNOWN_FIELD', key);
  }
  const stale = await w.apply(AMS, { purchase_id: id, minimum_profits: [{ scope: 'product', amount_usd: '130' }], preview_hash: hash });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'PRICING_PREVIEW_STALE');
  assert.match(String(stale.body.details.preview.preview_hash), /^[0-9a-f]{64}$/);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_inputs'), 0);
});

test('an IQD-converted supplier cost is replaced by the purchase’s, its snapshot columns cleared under the owner token', async () => {
  const w = pricingWorld();
  w.raw.exec(`INSERT INTO pricing_inputs (product_id, scope, scope_id, origin, supplier_cost_amount, supplier_cost_currency, supplier_input_mode,
      original_input_amount, original_input_currency, conversion_rate_snapshot, conversion_fx_version, canonical_supplier_cost_usd, converted_at,
      source_ref, version, updated_at)
    VALUES ('${AMS}', 'option', '${AMS_MODEL}', 'MANUAL_OVERRIDE', '300', 'USD', 'IQD_CONVERTED', '480000', 'IQD', '1600', 1, '300',
      '2026-10-01T00:00:00.000Z', 'owner', 1, '2026-10-01T00:00:00.000Z')`);
  // Without the token the converted cost is frozen.
  assert.throws(() => w.raw.exec(`UPDATE pricing_inputs SET supplier_cost_amount = '310', canonical_supplier_cost_usd = '310' WHERE product_id = '${AMS}'`), /FX_SNAPSHOT_IMMUTABLE/);
  const { id, hash } = await confirmed(w);
  const r = await w.apply(AMS, { purchase_id: id, minimum_profits: MIN, preview_hash: hash });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = row<Record<string, unknown>>(w.raw, 'SELECT * FROM pricing_inputs WHERE product_id = ?', AMS)!;
  assert.equal(after.supplier_cost_amount, '450');
  assert.equal(after.supplier_cost_currency, 'EUR');
  assert.equal(after.supplier_input_mode, 'SOURCE_CURRENCY');
  for (const k of ['original_input_amount', 'original_input_currency', 'conversion_rate_snapshot', 'conversion_fx_version', 'canonical_supplier_cost_usd', 'converted_at'])
    assert.equal(after[k], null, k);
});

test('a cost from a purchase cancelled afterwards is flagged on the saved document; the inputs are never rolled back', async () => {
  const w = pricingWorld();
  const { id, hash } = await confirmed(w);
  assert.equal((await w.apply(AMS, { purchase_id: id, minimum_profits: MIN, preview_hash: hash })).status, 200);
  const closed = await post(w.app, `/api/admin/procurement/documents/${id}/close`, { reason: 'المورد ألغى الطلب' });
  assert.equal(closed.status, 200);
  const view = await w.preview({ purchase_id: id });
  assert.equal(view.status, 200, JSON.stringify(view.body));
  assert.equal(view.body.products[0].cancelled_source, true);
  assert.equal(row<{ supplier_cost_amount: string }>(w.raw, 'SELECT supplier_cost_amount FROM pricing_inputs WHERE product_id = ?', AMS)!.supplier_cost_amount, '450');
});

test('only the owner applies: every other admin is refused at the door and nothing is written', async () => {
  const w = pricingWorld();
  const { id, hash } = await confirmed(w);
  const other = pricingWorld({ raw: w.raw, user: { id: 'usr_full', role: 'admin', email: 'full@x.co' } });
  const r = await other.apply(AMS, { purchase_id: id, minimum_profits: MIN, preview_hash: hash });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'COST_ACCESS_DENIED');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_inputs'), 0);
});
