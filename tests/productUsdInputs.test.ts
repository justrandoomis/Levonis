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
 * Run: node --import tsx --test tests/productUsdInputs.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, count, row } from './fixtures/app';
import { pricingWorld, AMS, AMS_MODEL } from './fixtures/procurementPricing';

const BRIEF_BASE = { scope: 'base', supplier_cost_amount: '450', supplier_cost_currency: 'EUR', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 2500 };
const BRIEF_RULE = { kind: 'target_profit', scope: 'product', amount_usd: '120' };

const priceImage = (raw: ReturnType<typeof pricingWorld>['raw'], pid: string) =>
  JSON.stringify([
    all(raw, 'SELECT id, price_iqd, prime_price_iqd, pro_price_iqd, direct_surcharge_iqd FROM products WHERE id = ?', pid),
    all(raw, 'SELECT * FROM product_option_values WHERE product_id = ? ORDER BY id', pid),
    all(raw, 'SELECT * FROM product_option_fulfillment WHERE product_id = ? ORDER BY id', pid),
    all(raw, 'SELECT * FROM product_option_transports WHERE product_id = ? ORDER BY id', pid),
    all(raw, 'SELECT * FROM price_history ORDER BY id'),
  ]);

test('GET: every scope (the product, each model) and each model’s bar; private, no-store; nothing stored yet', async () => {
  const w = pricingWorld();
  const r = await w.getInputs(AMS);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control') ?? '', /private/);
  assert.match(r.headers.get('cache-control') ?? '', /no-store/);
  assert.equal(r.body.inputs_seq, 0);
  assert.equal(r.body.mode, 'manual');
  assert.deepEqual(r.body.scopes.map((s: { scope: string; scope_id: string }) => `${s.scope}:${s.scope_id}`), ['base:', `option:${AMS_MODEL}`]);
  assert.equal(r.body.scopes[0].pricing_inputs, null);
  assert.equal(r.body.models.length, 1);
  assert.equal(r.body.models[0].option_id, AMS_MODEL);
  assert.equal(r.body.models[0].pricing_summary.state, 'blocked');
});

test('PUT: the brief’s example from the form — $500 / +$120 / $620 / 992,000 IQD; inputs and rule stored, audited, no price written', async () => {
  const w = pricingWorld();
  const before = priceImage(w.raw, AMS);
  const r = await w.putInputs(AMS, { inputs_seq: 0, inputs: [BRIEF_BASE], rules: [BRIEF_RULE] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const bar = r.body.models[0].pricing_summary;
  assert.equal(bar.state, 'ok', JSON.stringify(bar));
  assert.equal(bar.current_total_cost_cents, 50_000);
  assert.equal(bar.target_profit_cents, 12_000);
  assert.equal(bar.final_price_cents, 62_000);
  assert.equal(bar.preorder_base_iqd, 992_000);
  assert.equal(bar.supplier_cost_cents + bar.shipping_cost_cents + bar.additional_cost_cents, bar.current_total_cost_cents);
  assert.equal(bar.engine_priced, false);

  const input = row<Record<string, unknown>>(w.raw, "SELECT * FROM pricing_inputs WHERE product_id = ? AND scope = 'base'", AMS)!;
  assert.equal(input.supplier_cost_amount, '450');
  assert.equal(input.supplier_cost_currency, 'EUR');
  assert.equal(input.supplier_input_mode, 'SOURCE_CURRENCY');
  assert.equal(input.shipping_weight_g, 2500);
  assert.equal(input.origin, 'MANUAL_OVERRIDE');
  assert.equal(input.source_ref, 'owner');
  const rule = row<Record<string, unknown>>(w.raw, "SELECT * FROM pricing_rules WHERE product_id = ? AND kind = 'target_profit'", AMS)!;
  assert.equal(rule.amount_usd, '120');
  assert.equal(rule.amount_iqd, null);
  assert.equal(rule.source, 'OWNER');
  // The state row exists, its counter moved, the token is gone, the product stays manual.
  const state = row<{ mode: string; inputs_seq: number }>(w.raw, 'SELECT mode, inputs_seq FROM product_pricing_state WHERE product_id = ?', AMS)!;
  assert.equal(state.mode, 'manual');
  assert.ok(state.inputs_seq >= 2);
  assert.equal(r.body.inputs_seq, state.inputs_seq);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM ops_guards WHERE id LIKE 'pricing-input-owner:%'"), 0);
  // Values in the owner-only pricing audit; ids and counts only in audit_log.
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_audit WHERE product_id = ?', AMS), 2);
  const log = row<{ action: string; detail: string }>(w.raw, "SELECT action, detail FROM audit_log WHERE action = 'pricing.inputs.updated'")!;
  assert.deepEqual(Object.keys(JSON.parse(log.detail)).sort(), ['inputs_changed', 'inputs_seq', 'product_id', 'rules_changed']);
  assert.doesNotMatch(log.detail, /450|120|2500|EUR/);
  // No customer price moved (decision 8: the engine prices at the completing save).
  assert.equal(priceImage(w.raw, AMS), before);

  // A replay of the same values writes nothing.
  const again = await w.putInputs(AMS, { inputs_seq: r.body.inputs_seq, inputs: [BRIEF_BASE], rules: [BRIEF_RULE] });
  assert.equal(again.status, 200);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_audit WHERE product_id = ?', AMS), 2);
});

test('a model’s own value beats the product’s; null hands it back; the Direct Sale Extra joins the direct price after rounding', async () => {
  const w = pricingWorld();
  const first = await w.putInputs(AMS, { inputs_seq: 0, inputs: [BRIEF_BASE], rules: [BRIEF_RULE] });
  const own = await w.putInputs(AMS, {
    inputs_seq: first.body.inputs_seq,
    inputs: [{ scope: 'option', scope_id: AMS_MODEL, supplier_cost_amount: '600', supplier_cost_currency: 'USD' }],
    rules: [{ kind: 'direct_sale_extra', scope: 'option', scope_id: AMS_MODEL, amount_iqd: 25_000 }],
  });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  const bar = own.body.models[0].pricing_summary;
  // $600 + 8,000 IQD ÷ 1,600 = $605; + $120 = $725; × 1,600 = 1,160,000.
  assert.equal(bar.current_total_cost_cents, 60_500);
  assert.equal(bar.final_price_cents, 72_500);
  assert.equal(bar.preorder_base_iqd, 1_160_000);
  assert.equal(bar.direct_sale_extra_iqd, 25_000);
  assert.equal(bar.direct_sale_price_iqd, 1_185_000);
  const option = own.body.scopes.find((s: { scope: string }) => s.scope === 'option');
  assert.equal(option.pricing_inputs.supplier_cost_amount, '600');
  assert.equal(option.direct_sale_extra_iqd, 25_000);

  const back = await w.putInputs(AMS, { inputs_seq: own.body.inputs_seq, inputs: [{ scope: 'option', scope_id: AMS_MODEL, supplier_cost_amount: null }] });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.models[0].pricing_summary.preorder_base_iqd, 992_000);
  const optionRow = row<Record<string, unknown>>(w.raw, "SELECT supplier_cost_amount, supplier_cost_currency, supplier_input_mode FROM pricing_inputs WHERE scope = 'option'")!;
  assert.deepEqual({ ...optionRow }, { supplier_cost_amount: null, supplier_cost_currency: null, supplier_input_mode: null });
});

test('the preview prices a draft and writes nothing', async () => {
  const w = pricingWorld();
  const tables = ['pricing_inputs', 'pricing_rules', 'pricing_audit', 'product_pricing_state', 'audit_log'];
  const counts = () => tables.map((t) => count(w.raw, `SELECT COUNT(*) AS n FROM ${t}`));
  const before = counts();
  const r = await w.previewInputs(AMS, { inputs: [BRIEF_BASE], rules: [BRIEF_RULE] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.models[0].pricing_summary.preorder_base_iqd, 992_000);
  assert.equal(r.body.scopes[0].pricing_inputs.supplier_cost_amount, '450');
  assert.deepEqual(counts(), before);
});

test('validation names the field, never the value; Arabic-Indic digits are read; a stale counter is a fresh look', async () => {
  const w = pricingWorld();
  const refuse = async (body: Record<string, unknown>, code: string, field?: string) => {
    const r = await w.putInputs(AMS, { inputs_seq: 0, ...body });
    assert.equal(r.status, code === 'PRICING_CHANGED' || code === 'DIRECT_SALE_EXTRA_NOT_ON_STEP' ? (code === 'PRICING_CHANGED' ? 409 : 400) : 400, JSON.stringify(r.body));
    assert.equal(r.body.code, code, JSON.stringify(r.body));
    if (field) assert.equal(r.body.details?.field, field);
    assert.doesNotMatch(JSON.stringify(r.body), /777/);
  };
  await refuse({ inputs: [{ scope: 'base', supplier_cost_amount: 777, supplier_cost_currency: 'EUR' }] }, 'PRICING_INPUT_INVALID', 'supplier_cost_amount');
  await refuse({ inputs: [{ scope: 'base', supplier_cost_amount: '777' }] }, 'PRICING_INPUT_INVALID', 'supplier_cost_currency');
  await refuse({ inputs: [{ scope: 'base', supplier_cost_amount: '777', supplier_cost_currency: 'IQD' }] }, 'PRICING_INPUT_INVALID', 'supplier_cost_currency');
  await refuse({ inputs: [{ scope: 'base', shipping_weight_g: 2.5 }] }, 'PRICING_INPUT_INVALID', 'shipping_weight_g');
  await refuse({ inputs: [{ scope: 'base', shipping_profile: 'MOON' }] }, 'PRICING_INPUT_INVALID', 'shipping_profile');
  await refuse({ inputs: [{ scope: 'option', scope_id: 'nope', additional_cost_iqd: 777 }] }, 'PRICING_INPUT_INVALID', 'inputs[0].scope_id');
  await refuse({ inputs: [{ scope: 'base', pricing_weight_g: 777 }] }, 'UNKNOWN_FIELD');
  await refuse({ inputs: [{ scope: 'base', supplier_cost_amount: '777', supplier_cost_currency: 'EUR' }], nope: 1 }, 'UNKNOWN_FIELD');
  await refuse({ rules: [{ kind: 'target_profit', scope: 'product', amount_usd: '777.555' }] }, 'PRICING_INPUT_INVALID', 'minimum_target_profit_usd');
  await refuse({ rules: [{ kind: 'target_profit', scope: 'product', amount_iqd: 777000 }] }, 'PRICING_INPUT_INVALID');
  await refuse({ rules: [{ kind: 'direct_sale_extra', scope: 'product', amount_iqd: 7770 }] }, 'DIRECT_SALE_EXTRA_NOT_ON_STEP');
  await refuse({ rules: [{ kind: 'target_profit', scope: 'category', amount_usd: '777' }] }, 'PRICING_INPUT_INVALID');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_inputs'), 0);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_rules WHERE product_id IS NOT NULL'), 0);

  const ok = await w.putInputs(AMS, { inputs_seq: 0, rules: [{ kind: 'target_profit', scope: 'product', amount_usd: '١٢٠٫٥' }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(row<{ amount_usd: string }>(w.raw, 'SELECT amount_usd FROM pricing_rules WHERE product_id = ?', AMS)!.amount_usd, '120.5');
  const stale = await w.putInputs(AMS, { inputs_seq: 0, rules: [{ kind: 'target_profit', scope: 'product', amount_usd: '130' }] });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'PRICING_CHANGED');
});

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
