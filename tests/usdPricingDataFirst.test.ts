/**
 * «البيانات أولاً» — THE PRODUCT FORM'S PRICING SAVE STORES THE OWNER'S DATA FIRST
 * (owner report 2026-10-10: «بالرغم من كتابة التسعير بالدولار والشحن وملء الحقول
 * فعند الضغط على كلمة نشر والحفظ لا يحفظ»; docs/DECISIONS.md, the row of that day).
 *
 * PUT /api/admin/pricing/products/:id/inputs with `data_only: true` (the product
 * form's one save path, src/components/adminProducts/form/UsdPricingSection.tsx
 * `commitPricing`):
 *   - a MANUAL product's inputs and rules are stored as data even when they
 *     complete it — the store price and «التكلفة القديمة» never move;
 *   - the answer then carries the review of the new prices (adopt, complete,
 *     needs_write, the engine hash), and the price is written ONLY by the
 *     confirming request with that hash — 15% tick and fresh sign-in unchanged;
 *   - typed dinars still need the hash of the conversion the owner was shown
 *     (`conversion_hash`; the engine's hash is refused as stale);
 *   - an ENGINE product ignores the flag: its save stays one held write;
 *   - without the flag every caller behaves exactly as before;
 *   - audit_log carries counts, never a cost.
 *
 * Run: node --import tsx --test tests/usdPricingDataFirst.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all } from './fixtures/app';
import { pricingWorld } from './fixtures/procurementPricing';
import { OWNER_BASE, OWNER_RULES, SNAP, legacyCost, liveLikeWorld, persisted, readBack, storePrice, type World } from './fixtures/usdPricingSave';

const HEX64 = /^[0-9a-f]{64}$/;

/** Every audit_log line the pricing saves wrote for the product (ids and counts only). */
const pricingAudits = (raw: DatabaseSync) =>
  all<{ action: string; detail: string }>(raw, "SELECT action, detail FROM audit_log WHERE action LIKE 'pricing.%' ORDER BY id").map((r) => ({ ...r }));

/** Adopt a manual product the way the owner did before (held → confirm with the hash, tick when large). */
async function adopt(w: World) {
  const held = await w.putInputs(SNAP, { inputs_seq: 0, inputs: [OWNER_BASE], rules: OWNER_RULES });
  assert.equal(held.body.code, 'PRICING_PREVIEW_REQUIRED', JSON.stringify(held.body));
  const body = { inputs_seq: 0, inputs: [OWNER_BASE], rules: OWNER_RULES, preview_hash: held.body.details.preview.preview_hash };
  let r = await w.putInputs(SNAP, body);
  if (r.status === 409 && r.body.code === 'PRICING_LARGE_CHANGE_CONFIRM') r = await w.putInputs(SNAP, { ...body, confirm_large_change: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'engine');
  return r;
}

test('LIVE-LIKE (no approved rate): the owner’s full entry with data_only is stored and read back field for field; the store price and the old cost stay; the product stays manual', async () => {
  const w = liveLikeWorld();
  const before = storePrice(w.raw);
  const cost = legacyCost(w.raw);
  assert.ok(cost !== null && cost > 0, 'the twin carries a legacy cost');
  const r = await w.putInputs(SNAP, { inputs_seq: 0, inputs: [{ ...OWNER_BASE, supplier_cost_amount: '٨٩٩٫٥' }], rules: OWNER_RULES, data_only: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'manual');
  const back = readBack((await w.getInputs(SNAP)).body, 'base');
  assert.deepEqual(back, {
    supplier_cost_amount: '899.5',
    supplier_cost_currency: 'USD',
    supplier_input_mode: 'SOURCE_CURRENCY',
    original_input_amount: null,
    shipping_profile: 'CHINA_SEA',
    shipping_weight_g: null,
    box: [600, 520, 480],
    manual_cbm: null,
    additional_cost_iqd: 15000,
    minimum_target_profit_usd: '120',
    direct_sale_extra_iqd: 25000,
  });
  assert.equal(persisted(w.raw).state?.mode, 'manual');
  assert.equal(storePrice(w.raw), before, 'no store price moved');
  assert.equal(legacyCost(w.raw), cost, '«التكلفة القديمة» is never written by pricing');
  assert.equal(r.body.adoption.kind, null, 'no rate: nothing to adopt');
  // Counts in audit_log, never a value.
  const audits = pricingAudits(w.raw);
  assert.ok(audits.length >= 1);
  for (const a of audits) assert.doesNotMatch(a.detail, /899|15000|25000|"120"|1579000/, a.detail);
});

test('LIVE-LIKE: dinars cannot convert — 409 PRICING_FX_RATE_MISSING names the field and the scope (ids, never the amount), with or without data_only; nothing of that batch is stored', async () => {
  const w = liveLikeWorld();
  const entry = { scope: 'base', supplier_cost_iqd: 1_450_000, shipping_profile: 'CHINA_SEA', additional_cost_iqd: 15000 };
  for (const extra of [{}, { data_only: true }]) {
    const r = await w.putInputs(SNAP, { inputs_seq: 0, inputs: [entry], rules: OWNER_RULES, ...extra });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, 'PRICING_FX_RATE_MISSING');
    assert.deepEqual(r.body.details, { field: 'supplier_cost_iqd', scope: 'base', scope_id: '' });
    assert.doesNotMatch(JSON.stringify(r.body), /1450000/);
  }
  const pv = await w.previewInputs(SNAP, { inputs: [entry] });
  assert.equal(pv.status, 409);
  assert.equal(pv.body.details.field, 'supplier_cost_iqd');
  assert.deepEqual(persisted(w.raw), { inputs: [], rules: [], state: null });
});

test('LIVE-LIKE: the decimal the form accepts is the decimal the server stores — «٨٩٩٫٥» / 899,5 / ٠٫١٥ / 0,15 read as typed; 1,250 and 899. refused by field, nothing stored', async () => {
  const w = liveLikeWorld();
  for (const amount of ['1,250', '1,250,000', '899.']) {
    const r = await w.putInputs(SNAP, { inputs_seq: 0, inputs: [{ ...OWNER_BASE, supplier_cost_amount: amount }], data_only: true });
    assert.equal(r.status, 400, amount);
    assert.equal(r.body.details.field, 'supplier_cost_amount', amount);
  }
  assert.deepEqual(persisted(w.raw), { inputs: [], rules: [], state: null });
  let seq = 0;
  for (const [amount, cbm] of [['899,5', '0,15'], ['٨٩٩٫٥', '٠٫١٥']] as const) {
    const r = await w.putInputs(SNAP, { inputs_seq: seq, inputs: [{ scope: 'base', supplier_cost_amount: amount, supplier_cost_currency: 'USD', manual_cbm: cbm }], data_only: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([readBack(r.body, 'base')!.supplier_cost_amount, readBack(r.body, 'base')!.manual_cbm], ['899.5', '0.15']);
    seq = r.body.inputs_seq;
  }
});

test('NORMAL (rates approved): a full entry with data_only is STORED and stays manual; the answer carries the adoption to confirm; only the confirm with the hash writes the price, and «التكلفة القديمة» never moves', async () => {
  const w = pricingWorld();
  const before = storePrice(w.raw);
  const cost = legacyCost(w.raw);
  const r = await w.putInputs(SNAP, { inputs_seq: 0, inputs: [OWNER_BASE], rules: OWNER_RULES, data_only: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'manual');
  assert.equal(storePrice(w.raw), before, 'the data save writes no price');
  assert.equal(readBack(r.body, 'base')!.supplier_cost_amount, '899');
  assert.equal(readBack(r.body, 'base')!.minimum_target_profit_usd, '120');
  assert.equal(persisted(w.raw).rules.length, 2);
  assert.equal(r.body.adoption.kind, 'adopt');
  assert.equal(r.body.adoption.complete, true);
  assert.equal(r.body.adoption.needs_write, true);
  assert.match(r.body.preview_hash, HEX64);
  assert.equal(r.body.conversion_hash, null, 'no dinars, no conversion hash');
  // A GET reads the same review (the form's «راجع السعر الجديد واعتمده» after a reload).
  const g = await w.getInputs(SNAP);
  assert.equal(g.body.preview_hash, r.body.preview_hash);
  assert.equal(g.body.adoption.kind, 'adopt');

  // The confirm: the stored data, nothing typed, the preview's hash — the request decision 8 always required.
  const confirm = { inputs_seq: r.body.inputs_seq, inputs: [], rules: [], preview_hash: r.body.preview_hash };
  let c = await w.putInputs(SNAP, confirm);
  if (c.status === 409 && c.body.code === 'PRICING_LARGE_CHANGE_CONFIRM') {
    assert.equal(storePrice(w.raw), before, 'no price before the tick');
    c = await w.putInputs(SNAP, { ...confirm, confirm_large_change: true });
  }
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.mode, 'engine');
  assert.notEqual(storePrice(w.raw), before, 'the confirm writes the engine price');
  assert.equal(legacyCost(w.raw), cost, '«التكلفة القديمة» is never written by pricing');
  for (const a of pricingAudits(w.raw)) assert.doesNotMatch(a.detail, /899|15000|25000|"120"/, a.detail);
});

test('NORMAL: a confirm that moves the price more than 15% needs the tick, then a sign-in under 10 minutes — refused, the data stays stored and the price stays', async () => {
  const w = pricingWorld({ sessionAgeSeconds: 20 * 60 });
  const before = storePrice(w.raw);
  // A dearer supplier: the engine price lands far above today's manual price.
  const entry = { ...OWNER_BASE, supplier_cost_amount: '1500' };
  const r = await w.putInputs(SNAP, { inputs_seq: 0, inputs: [entry], rules: OWNER_RULES, data_only: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.adoption.large_change, true, 'the fixture must be a large change');
  const confirm = { inputs_seq: r.body.inputs_seq, inputs: [], rules: [], preview_hash: r.body.preview_hash };
  const untick = await w.putInputs(SNAP, confirm);
  assert.equal(untick.status, 409);
  assert.equal(untick.body.code, 'PRICING_LARGE_CHANGE_CONFIRM');
  const stale = await w.putInputs(SNAP, { ...confirm, confirm_large_change: true });
  assert.equal(stale.status, 401, JSON.stringify(stale.body));
  assert.equal(stale.body.code, 'REAUTH_REQUIRED');
  assert.equal(storePrice(w.raw), before);
  const back = readBack((await w.getInputs(SNAP)).body, 'base');
  assert.equal(back!.supplier_cost_amount, '1500', 'signing in again loses nothing: the data is stored');
  assert.equal(persisted(w.raw).state?.mode, 'manual');
});

test('NORMAL: WITHOUT data_only every caller is unchanged — a completing save is held (409 PRICING_PREVIEW_REQUIRED) and nothing is stored', async () => {
  const w = pricingWorld();
  const held = await w.putInputs(SNAP, { inputs_seq: 0, inputs: [OWNER_BASE], rules: OWNER_RULES });
  assert.equal(held.status, 409);
  assert.equal(held.body.code, 'PRICING_PREVIEW_REQUIRED');
  assert.deepEqual(persisted(w.raw), { inputs: [], rules: [], state: null });
});

test('NORMAL: typed dinars with data_only need the conversion the owner was shown — no hash 400, the engine hash 409 stale, the conversion_hash stores IQD_CONVERTED', async () => {
  const w = pricingWorld();
  const { supplier_cost_amount: _a, supplier_cost_currency: _c, ...rest } = OWNER_BASE;
  void _a; void _c;
  const entry = { ...rest, supplier_cost_iqd: 1_450_000 };
  const draft = { inputs: [entry], rules: OWNER_RULES };
  const pv = await w.previewInputs(SNAP, draft);
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.equal(pv.body.adoption.kind, 'adopt', 'the dinars complete the product: preview_hash is the engine’s');
  assert.match(pv.body.conversion_hash, HEX64);
  assert.notEqual(pv.body.conversion_hash, pv.body.preview_hash);
  const plain = await w.previewInputs(SNAP, { inputs: [OWNER_BASE] });
  assert.equal(plain.body.conversion_hash, null, 'no dinars, no conversion hash');

  const noHash = await w.putInputs(SNAP, { inputs_seq: 0, ...draft, data_only: true });
  assert.equal(noHash.status, 400);
  assert.equal(noHash.body.details.field, 'preview_hash');
  const engineHash = await w.putInputs(SNAP, { inputs_seq: 0, ...draft, data_only: true, preview_hash: pv.body.preview_hash });
  assert.equal(engineHash.status, 409);
  assert.equal(engineHash.body.code, 'PRICING_PREVIEW_STALE');
  assert.deepEqual(persisted(w.raw), { inputs: [], rules: [], state: null });

  const r = await w.putInputs(SNAP, { inputs_seq: 0, ...draft, data_only: true, preview_hash: pv.body.conversion_hash });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'manual');
  const base = readBack(r.body, 'base')!;
  assert.equal(base.supplier_input_mode, 'IQD_CONVERTED');
  assert.equal(base.original_input_amount, '1450000');
  assert.equal(base.supplier_cost_amount, '906.25');
  assert.equal(r.body.adoption.kind, 'adopt', 'stored and complete: the review the form opens');
});

test('ENGINE product: data_only is ignored — a change is held for the sheet (409 PRICING_PREVIEW_REQUIRED) and nothing is stored until the confirm', async () => {
  const w = pricingWorld();
  const adopted = await adopt(w);
  const price = storePrice(w.raw);
  const change = { inputs_seq: adopted.body.inputs_seq, inputs: [{ scope: 'base', additional_cost_iqd: 40000 }], data_only: true };
  const held = await w.putInputs(SNAP, change);
  assert.equal(held.status, 409, JSON.stringify(held.body));
  assert.equal(held.body.code, 'PRICING_PREVIEW_REQUIRED');
  assert.equal(held.body.details.preview.adoption.kind, 'reprice');
  assert.equal(readBack((await w.getInputs(SNAP)).body, 'base')!.additional_cost_iqd, 15000, 'nothing stored');
  assert.equal(storePrice(w.raw), price);
  // The sheet's «حفظ»: the same body WITHOUT data_only, with the held preview's hash.
  const { data_only: _d, ...body } = change;
  void _d;
  let c = await w.putInputs(SNAP, { ...body, preview_hash: held.body.details.preview.preview_hash });
  if (c.status === 409 && c.body.code === 'PRICING_LARGE_CHANGE_CONFIRM') c = await w.putInputs(SNAP, { ...body, preview_hash: held.body.details.preview.preview_hash, confirm_large_change: true });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(readBack(c.body, 'base')!.additional_cost_iqd, 40000);
});

test('the flag is strict: data_only must be a boolean, never with adopt; an unknown key is still UNKNOWN_FIELD', async () => {
  const w = pricingWorld();
  const a = await w.putInputs(SNAP, { inputs_seq: 0, inputs: [OWNER_BASE], data_only: 'yes' });
  assert.equal(a.status, 400);
  assert.equal(a.body.details.field, 'data_only');
  const b = await w.putInputs(SNAP, { inputs_seq: 0, inputs: [OWNER_BASE], data_only: true, adopt: true });
  assert.equal(b.status, 400);
  assert.equal(b.body.details.field, 'data_only');
  const c = await w.putInputs(SNAP, { inputs_seq: 0, inputs: [OWNER_BASE], data_onl: true });
  assert.equal(c.status, 400);
  assert.equal(c.body.code, 'UNKNOWN_FIELD');
  assert.deepEqual(persisted(w.raw), { inputs: [], rules: [], state: null });
});
