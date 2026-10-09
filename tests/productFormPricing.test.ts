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
 * Run: node --import tsx --test tests/productFormPricing.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, count, row } from './fixtures/app';
import { applyRate } from './fixtures/fx';
import { pricingWorld, AMS, AMS_MODEL } from './fixtures/procurementPricing';

const BRIEF_RULE = { kind: 'target_profit', scope: 'product', amount_usd: '120' };
const LAND = { shipping_profile: 'GERMANY_LAND', shipping_weight_g: 2500 };

const priceImage = (raw: ReturnType<typeof pricingWorld>['raw'], pid: string) =>
  JSON.stringify([
    all(raw, 'SELECT id, price_iqd, prime_price_iqd, pro_price_iqd, direct_surcharge_iqd FROM products WHERE id = ?', pid),
    all(raw, 'SELECT * FROM product_option_values WHERE product_id = ? ORDER BY id', pid),
    all(raw, 'SELECT * FROM product_option_fulfillment WHERE product_id = ? ORDER BY id', pid),
    all(raw, 'SELECT * FROM product_option_transports WHERE product_id = ? ORDER BY id', pid),
    all(raw, 'SELECT * FROM price_history ORDER BY id'),
  ]);

const baseRow = (raw: ReturnType<typeof pricingWorld>['raw']) =>
  row<Record<string, unknown>>(raw, "SELECT * FROM pricing_inputs WHERE product_id = ? AND scope = 'base' AND origin = 'MANUAL_OVERRIDE'", AMS);

test('the IQD convenience input: the preview shows the one conversion, the save needs its hash and stores the snapshot — the brief’s 992,000 from dinars', async () => {
  const w = pricingWorld();
  const before = priceImage(w.raw, AMS);
  const draft = { inputs: [{ scope: 'base', supplier_cost_iqd: 792_000, ...LAND }], rules: [BRIEF_RULE] };

  const p = await w.previewInputs(AMS, draft);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const shown = p.body.scopes[0].pricing_inputs;
  assert.equal(shown.supplier_cost_amount, '495', 'floor6(792,000 ÷ 1,600)');
  assert.equal(shown.supplier_cost_currency, 'USD');
  assert.equal(shown.supplier_input_mode, 'IQD_CONVERTED');
  assert.equal(shown.original_input_amount, '792000');
  assert.equal(shown.conversion_rate_snapshot, '1600');
  const bar = p.body.models[0].pricing_summary;
  assert.equal(bar.current_total_cost_cents, 50_000);
  assert.equal(bar.final_price_cents, 62_000);
  assert.equal(bar.preorder_base_iqd, 992_000);
  assert.equal(bar.iqd_converted?.original_input_amount, '792000', '«تفاصيل» row 1 names the dinars typed');
  assert.match(p.body.preview_hash, /^[0-9a-f]{64}$/);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_inputs'), 0, 'the preview writes nothing');

  // A save without the preview's hash converts nothing.
  const blind = await w.putInputs(AMS, { inputs_seq: 0, ...draft });
  assert.equal(blind.status, 400, JSON.stringify(blind.body));
  assert.equal(blind.body.code, 'PRICING_INPUT_INVALID');
  assert.equal(blind.body.details?.field, 'preview_hash');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_inputs'), 0);

  const r = await w.putInputs(AMS, { inputs_seq: 0, ...draft, preview_hash: p.body.preview_hash });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.models[0].pricing_summary.preorder_base_iqd, 992_000);
  const stored = baseRow(w.raw)!;
  const usdVersion = row<{ v: number }>(w.raw, "SELECT effective_version AS v FROM fx_rate_pairs WHERE pair = 'USD_IQD'")!.v;
  assert.deepEqual(
    {
      amount: stored.supplier_cost_amount, currency: stored.supplier_cost_currency, mode: stored.supplier_input_mode,
      original: stored.original_input_amount, originalCurrency: stored.original_input_currency, rate: stored.conversion_rate_snapshot,
      version: stored.conversion_fx_version, canonical: stored.canonical_supplier_cost_usd,
    },
    { amount: '495', currency: 'USD', mode: 'IQD_CONVERTED', original: '792000', originalCurrency: 'IQD', rate: '1600', version: usdVersion, canonical: '495' }
  );
  assert.ok(stored.converted_at);
  // The snapshot is in the owner-only pricing audit; audit_log keeps ids and counts.
  const audit = row<{ after: string }>(w.raw, "SELECT pricing_after_json AS after FROM pricing_audit WHERE entity = 'input' AND product_id = ?", AMS)!;
  assert.equal(JSON.parse(audit.after).iqd.original_input_amount, '792000');
  const log = row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'pricing.inputs.updated'")!;
  assert.doesNotMatch(log.detail, /792000|495|1600/);
  assert.equal(priceImage(w.raw, AMS), before, 'no customer price moved');
});

test('the same dinars keep the snapshot byte for byte; a rate moved since the preview is a fresh look; «حوّل مرة أخرى» converts at today’s rate', async () => {
  const w = pricingWorld();
  const entry = { scope: 'base', supplier_cost_iqd: 1_000_000, ...LAND };
  const p0 = await w.previewInputs(AMS, { inputs: [entry] });
  const first = await w.putInputs(AMS, { inputs_seq: 0, inputs: [entry], preview_hash: p0.body.preview_hash });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(baseRow(w.raw)!.supplier_cost_amount, '625');
  const snapshot = JSON.stringify(baseRow(w.raw));

  // The dollar moves: the stored conversion stays (the canonical USD is never re-derived).
  applyRate(w.raw, 'USD_IQD', '1660');
  const same = { scope: 'base', supplier_cost_iqd: 1_000_000 };
  const p1 = await w.previewInputs(AMS, { inputs: [same] });
  assert.equal(p1.body.scopes[0].pricing_inputs.supplier_cost_amount, '625', 'the preview keeps the stored conversion too');
  const again = await w.putInputs(AMS, { inputs_seq: first.body.inputs_seq, inputs: [same], preview_hash: p1.body.preview_hash });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(JSON.stringify(baseRow(w.raw)), snapshot, 'byte for byte');

  // «حوّل مرة أخرى» at 1,660, previewed — then the rate moves again before the save.
  const redo = { scope: 'base', supplier_cost_iqd: 1_000_000, reconvert: true };
  const p2 = await w.previewInputs(AMS, { inputs: [redo] });
  assert.equal(p2.body.scopes[0].pricing_inputs.supplier_cost_amount, '602.409638', 'FX plan §12: 1,000,000 at 1,660');
  applyRate(w.raw, 'USD_IQD', '1700');
  const stale = await w.putInputs(AMS, { inputs_seq: again.body.inputs_seq, inputs: [redo], preview_hash: p2.body.preview_hash });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.code, 'PRICING_PREVIEW_STALE');
  assert.equal(JSON.stringify(baseRow(w.raw)), snapshot);

  const p3 = await w.previewInputs(AMS, { inputs: [redo] });
  const done = await w.putInputs(AMS, { inputs_seq: again.body.inputs_seq, inputs: [redo], preview_hash: p3.body.preview_hash });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const after = baseRow(w.raw)!;
  assert.equal(after.supplier_cost_amount, '588.235294');
  assert.equal(after.conversion_rate_snapshot, '1700');
  assert.ok(String(after.converted_at) > String(JSON.parse(snapshot).converted_at), 'a newer conversion time (0181 trigger)');
  // floor6 then × U rounds back up to the dinars typed.
  assert.equal(Math.ceil(588.235294 * 1700), 1_000_000);

  // A source currency replaces the dinars and clears their snapshot.
  const eur = await w.putInputs(AMS, { inputs_seq: done.body.inputs_seq, inputs: [{ scope: 'base', supplier_cost_amount: '450', supplier_cost_currency: 'EUR' }] });
  assert.equal(eur.status, 200, JSON.stringify(eur.body));
  const plain = baseRow(w.raw)!;
  assert.deepEqual(
    [plain.supplier_input_mode, plain.original_input_amount, plain.conversion_rate_snapshot, plain.canonical_supplier_cost_usd, plain.converted_at],
    ['SOURCE_CURRENCY', null, null, null, null]
  );
});

test('the client never sends the USD or the rate; dinars never travel with a source amount; no USD rate refuses the conversion', async () => {
  const w = pricingWorld();
  const refuse = async (entry: Record<string, unknown>, status: number, code: string, field?: string) => {
    const r = await w.previewInputs(AMS, { inputs: [{ scope: 'base', ...entry }] });
    assert.equal(r.status, status, JSON.stringify(r.body));
    assert.equal(r.body.code, code, JSON.stringify(r.body));
    if (field) assert.equal(r.body.details?.field, field);
  };
  for (const key of ['canonical_supplier_cost_usd', 'conversion_rate_snapshot', 'conversion_fx_version', 'original_input_amount', 'converted_at', 'supplier_input_mode'])
    await refuse({ supplier_cost_iqd: 792_000, [key]: '1' }, 400, 'UNKNOWN_FIELD');
  await refuse({ supplier_cost_iqd: 792_000, supplier_cost_amount: '495' }, 400, 'PRICING_INPUT_INVALID', 'supplier_cost_iqd');
  await refuse({ supplier_cost_iqd: 792_000, supplier_cost_currency: 'USD' }, 400, 'PRICING_INPUT_INVALID', 'supplier_cost_iqd');
  await refuse({ supplier_cost_iqd: '792000' }, 400, 'PRICING_INPUT_INVALID', 'supplier_cost_iqd');
  await refuse({ supplier_cost_iqd: 0 }, 400, 'PRICING_INPUT_INVALID', 'supplier_cost_iqd');
  await refuse({ supplier_cost_iqd: 792_000.5 }, 400, 'PRICING_INPUT_INVALID', 'supplier_cost_iqd');
  await refuse({ supplier_cost_iqd: 792_000, reconvert: 'yes' }, 400, 'PRICING_INPUT_INVALID', 'reconvert');
  await refuse({ reconvert: true }, 400, 'PRICING_INPUT_INVALID', 'reconvert');

  const bare = pricingWorld({ rates: false });
  const r = await bare.previewInputs(AMS, { inputs: [{ scope: 'base', supplier_cost_iqd: 792_000 }] });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'PRICING_FX_RATE_MISSING');
  assert.equal(count(bare.raw, 'SELECT COUNT(*) AS n FROM pricing_inputs'), 0);
});

test('the shipping box travels whole (the form’s package measurements) and prices sea freight by its CBM', async () => {
  const w = pricingWorld();
  const refuse = async (entry: Record<string, unknown>) => {
    const r = await w.putInputs(AMS, { inputs_seq: 0, inputs: [{ scope: 'base', ...entry }] });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.details?.field, 'shipping_box', JSON.stringify(r.body));
  };
  await refuse({ shipping_length_mm: 500, shipping_width_mm: 400 });
  await refuse({ shipping_length_mm: 500, shipping_width_mm: 400, shipping_height_mm: null });
  const axis = await w.putInputs(AMS, { inputs_seq: 0, inputs: [{ scope: 'base', shipping_length_mm: 500, shipping_width_mm: 400, shipping_height_mm: 0 }] });
  assert.equal(axis.body.details?.field, 'shipping_height_mm');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM pricing_inputs'), 0);

  // $100 + 0.06 CBM × 400,000 = 24,000 IQD = $15 → K $115; + $10 → $125 × 1,600 = 200,000.
  const r = await w.putInputs(AMS, {
    inputs_seq: 0,
    inputs: [{ scope: 'base', supplier_cost_amount: '100', supplier_cost_currency: 'USD', shipping_profile: 'CHINA_SEA', shipping_length_mm: 500, shipping_width_mm: 400, shipping_height_mm: 300 }],
    rules: [{ kind: 'target_profit', scope: 'product', amount_usd: '10' }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const bar = r.body.models[0].pricing_summary;
  assert.equal(bar.basis, 'volume');
  assert.equal(bar.effective_cbm, '0.06');
  assert.equal(bar.shipping_cost_iqd, 24_000);
  assert.equal(bar.current_total_cost_cents, 11_500);
  assert.equal(bar.preorder_base_iqd, 200_000);
  const box = r.body.scopes[0].pricing_inputs;
  assert.deepEqual([box.shipping_length_mm, box.shipping_width_mm, box.shipping_height_mm], [500, 400, 300]);

  // A manual CBM still wins over the box at its level; clearing the box takes the three axes together.
  const manual = await w.putInputs(AMS, { inputs_seq: r.body.inputs_seq, inputs: [{ scope: 'base', manual_cbm: '0.1', shipping_length_mm: null, shipping_width_mm: null, shipping_height_mm: null }] });
  assert.equal(manual.status, 200, JSON.stringify(manual.body));
  assert.equal(manual.body.models[0].pricing_summary.effective_cbm, '0.1');
  const stored = baseRow(w.raw)!;
  assert.deepEqual([stored.shipping_length_mm, stored.shipping_width_mm, stored.shipping_height_mm, stored.manual_cbm], [null, null, null, '0.1']);
});

test('decision 8’s six figures per model × channel ride every answer — the preview’s with the drafts, and the preview writes nothing', async () => {
  const w = pricingWorld();
  const saved = await w.putInputs(AMS, {
    inputs_seq: 0,
    inputs: [{ scope: 'base', supplier_cost_amount: '450', supplier_cost_currency: 'EUR', ...LAND }],
    rules: [BRIEF_RULE, { kind: 'direct_sale_extra', scope: 'product', amount_iqd: 25_000 }],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const rows = (await w.getInputs(AMS)).body.rows as Array<Record<string, unknown>>;
  assert.deepEqual(rows.map((r) => r.channel).sort(), ['direct_sale', 'pre_order_land']);
  for (const r of rows) {
    assert.equal(r.option_id, AMS_MODEL);
    assert.equal(r.replacement_cost_iqd, 800_000, '792,000 supplier + 8,000 shipping');
    assert.equal(r.target_profit_usd, '120');
    assert.equal(r.preorder_base_iqd, 992_000);
    assert.equal(typeof r.today_prepaid_iqd, 'number');
    assert.equal(r.change_iqd, (r.computed_price_iqd as number) - (r.today_prepaid_iqd as number));
  }
  const direct = rows.find((r) => r.channel === 'direct_sale')!;
  assert.equal(direct.direct_sale_extra_iqd, 25_000);
  assert.equal(direct.computed_price_iqd, 1_017_000);
  assert.equal(rows.find((r) => r.channel === 'pre_order_land')!.computed_price_iqd, 992_000);

  const tables = ['pricing_inputs', 'pricing_rules', 'pricing_audit', 'product_pricing_state', 'audit_log'];
  const counts = () => tables.map((t) => count(w.raw, `SELECT COUNT(*) AS n FROM ${t}`));
  const before = counts();
  const p = await w.previewInputs(AMS, { rules: [{ kind: 'target_profit', scope: 'product', amount_usd: '130' }] });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const land = (p.body.rows as Array<Record<string, unknown>>).find((r) => r.channel === 'pre_order_land')!;
  assert.equal(land.computed_price_iqd, 1_008_000, '$130 × 1,600 above the same cost');
  assert.deepEqual(counts(), before);
});

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
