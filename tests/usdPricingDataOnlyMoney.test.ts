/**
 * MONEY SAFETY OF THE PRODUCT FORM'S DATA-FIRST PRICING SAVE — «البيانات أولاً» / `data_only`
 * (owner report 2026-10-10; docs/DECISIONS.md row 213; the verifiers' money review).
 *
 * Every test here asks one question: can the product form's pricing save
 * (PUT …/products/:id/inputs, `commitPricing`) move a store price, an
 * option / colour / SKU price or the engine mode without the owner's explicit
 * adoption (the preview's hash, the >15% tick, a fresh sign-in)? And the
 * cost it stores: are typed dinars ever converted at a dollar rate the owner
 * was not shown (FX plan §12)?
 *
 * Run: node --import tsx --test tests/usdPricingDataOnlyMoney.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, ctx, json, post } from './fixtures/app';
import { applyRate } from './fixtures/fx';
import { pricingWorld } from './fixtures/procurementPricing';
import { OWNER_BASE, OWNER_RULES, SNAP, SNAP_MODEL, persisted, readBack, type World } from './fixtures/usdPricingSave';
import { ApiError } from '../src/lib/api';
import { commitPricing, draftWire, inputsPath, previewPath, type PricingIo, type ScopeDraft, type UsdPricingAnswer } from '../src/components/adminProducts/form/UsdPricingSection';

/** Every price-carrying row of a product, and its engine state (any change here is a price write). */
function priceImage(raw: DatabaseSync, pid: string): string {
  const q = (sql: string) => all(raw, sql, pid).map((r) => ({ ...(r as Record<string, unknown>) }));
  return JSON.stringify({
    product: q('SELECT price_iqd, prime_price_iqd, pro_price_iqd, direct_surcharge_iqd, product_cost_iqd FROM products WHERE id = ?'),
    options: q('SELECT id, regular_price_iqd, regular_adjust_iqd, cost_iqd, cost_adjust_iqd FROM product_option_values WHERE product_id = ? ORDER BY id'),
    cells: q('SELECT id, regular_price_iqd, cost_iqd FROM product_option_fulfillment WHERE product_id = ? ORDER BY id'),
    transports: q('SELECT id, surcharge_iqd FROM product_option_transports WHERE product_id = ? ORDER BY id'),
    colours: q('SELECT * FROM product_colors WHERE product_id = ? ORDER BY id'),
    variants: q('SELECT * FROM product_variants WHERE product_id = ? ORDER BY id'),
    skuPrices: q('SELECT * FROM product_sku_prices WHERE product_id = ? ORDER BY combo_key, channel'),
    skuCosts: q('SELECT * FROM pricing_sku_costs WHERE product_id = ? ORDER BY 1, 2'),
    state: q('SELECT mode, write_seq, priced_inputs_seq, opted_out_at FROM product_pricing_state WHERE product_id = ?'),
  });
}

const engineAudits = (raw: DatabaseSync, pid: string) =>
  all<{ n: number }>(raw, "SELECT COUNT(*) AS n FROM pricing_audit WHERE product_id = ? AND entity IN ('product_write', 'sku_price', 'engine_mode')", pid)[0]!.n;

/** Adopt the owner's product through the form path: data first, then the sheet's confirm (tick when large). */
async function adoptViaForm(w: World) {
  const r = await w.putInputs(SNAP, { inputs_seq: 0, inputs: [OWNER_BASE], rules: OWNER_RULES, data_only: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const confirm = { inputs_seq: r.body.inputs_seq, inputs: [], rules: [], preview_hash: r.body.preview_hash, confirm_large_change: true };
  const c = await w.putInputs(SNAP, confirm);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.mode, 'engine');
  return c;
}

test('data_only cannot be turned into a price write: the engine hash + the >15% tick + a fresh session on a data_only request still write nothing (manual stays manual)', async () => {
  const w = pricingWorld();
  const before = priceImage(w.raw, SNAP);
  const pv = await w.previewInputs(SNAP, { inputs: [OWNER_BASE], rules: OWNER_RULES });
  assert.equal(pv.status, 200, JSON.stringify(pv.body));
  assert.equal(pv.body.adoption.kind, 'adopt');
  const r = await w.putInputs(SNAP, { inputs_seq: 0, inputs: [OWNER_BASE], rules: OWNER_RULES, data_only: true, preview_hash: pv.body.preview_hash, confirm_large_change: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'manual');
  assert.equal(priceImage(w.raw, SNAP).replace(/"state":\[[^\]]*\]/, ''), before.replace(/"state":\[[^\]]*\]/, ''), 'no price row moved');
  assert.equal(persisted(w.raw).state?.mode, 'manual');
  assert.equal(engineAudits(w.raw, SNAP), 0, 'no engine write audited');
});

test('a product the owner took back to manual («رجوع إلى التسعير اليدوي») is never re-adopted by a data_only save, nor by the confirm-shaped request that follows it', async () => {
  const w = pricingWorld();
  const adopted = await adoptViaForm(w);
  const exit = await post(w.app, `/api/admin/pricing/products/${SNAP}/manual`, { write_seq: adopted.body.write_seq });
  assert.equal(exit.status, 200, JSON.stringify(await json(exit)));
  assert.equal(persisted(w.raw).state?.mode, 'manual');
  const before = priceImage(w.raw, SNAP);
  const seq = persisted(w.raw).state!.inputs_seq;
  // A dearer supplier: if adoption happened, every price would move.
  const r = await w.putInputs(SNAP, { inputs_seq: seq, inputs: [{ scope: 'base', supplier_cost_amount: '1500', supplier_cost_currency: 'USD' }], data_only: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'manual');
  assert.equal(r.body.adoption?.kind ?? null, null, 'an opted-out product offers no adoption');
  assert.equal(priceImage(w.raw, SNAP), before);
  // What the sheet would send if it opened (it must not, but a stale client could): nothing is written.
  const c = await w.putInputs(SNAP, { inputs_seq: r.body.inputs_seq, inputs: [], rules: [], preview_hash: r.body.preview_hash, confirm_large_change: true });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.mode, 'manual');
  assert.equal(priceImage(w.raw, SNAP), before, 'no adoption without `adopt: true`');
});

test('a stale tab: tab A read the product while manual; tab B adopted it; tab A’s data_only save is held by the engine (nothing stored, no price moved)', async () => {
  const w = pricingWorld();
  // Tab A: the data is stored (manual); it keeps the answer.
  const a = await w.putInputs(SNAP, { inputs_seq: 0, inputs: [OWNER_BASE], rules: OWNER_RULES, data_only: true });
  assert.equal(a.status, 200);
  // Tab B: the confirm (adopts; inputs_seq does not move).
  const b = await w.putInputs(SNAP, { inputs_seq: a.body.inputs_seq, inputs: [], rules: [], preview_hash: a.body.preview_hash, confirm_large_change: true });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(b.body.mode, 'engine');
  const priced = priceImage(w.raw, SNAP);
  const stored = JSON.stringify(persisted(w.raw).inputs);
  // Tab A, still believing the product is manual, sends a data_only change at the same inputs_seq.
  const late = await w.putInputs(SNAP, { inputs_seq: a.body.inputs_seq, inputs: [{ scope: 'base', additional_cost_iqd: 90000 }], data_only: true });
  assert.equal(late.status, 409, JSON.stringify(late.body));
  assert.ok(['PRICING_PREVIEW_REQUIRED', 'PRICING_CHANGED'].includes(late.body.code), late.body.code);
  assert.equal(JSON.stringify(persisted(w.raw).inputs), stored, 'nothing stored on an engine product outside a priced batch');
  assert.equal(priceImage(w.raw, SNAP), priced);
});

test('a product with models, colours and SKUs: a data_only save at every level moves no option, colour, variant or SKU price and leaves the product manual', async () => {
  const w = pricingWorld();
  const pick = all<{ product_id: string; opts: number; cols: number }>(
    w.raw,
    `SELECT v.product_id, COUNT(DISTINCT v.id) AS opts, (SELECT COUNT(*) FROM product_colors c WHERE c.product_id = v.product_id) AS cols
       FROM product_option_values v GROUP BY v.product_id HAVING opts >= 2 AND cols >= 1 ORDER BY v.product_id LIMIT 1`
  )[0];
  assert.ok(pick, 'the census has a product with models and colours');
  const pid = pick.product_id;
  const g = await w.getInputs(pid);
  assert.equal(g.status, 200, JSON.stringify(g.body));
  const scopes = (g.body.scopes as Array<{ scope: string; scope_id: string }>).filter((s) => s.scope !== 'base');
  const before = priceImage(w.raw, pid);
  const inputs = [
    { scope: 'base', supplier_cost_amount: '50', supplier_cost_currency: 'USD', shipping_profile: 'CHINA_AIR', shipping_weight_g: 1500 },
    ...scopes.map((s, i) => ({ scope: s.scope, scope_id: s.scope_id, supplier_cost_amount: String(60 + i), supplier_cost_currency: 'USD' })),
  ];
  const rules = [{ kind: 'target_profit', scope: 'product', amount_usd: '30' }];
  const r = await w.putInputs(pid, { inputs_seq: g.body.inputs_seq, inputs, rules, data_only: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'manual');
  assert.equal(priceImage(w.raw, pid).replace(/"state":\[[^\]]*\]/, ''), before.replace(/"state":\[[^\]]*\]/, ''));
  assert.equal(engineAudits(w.raw, pid), 0);
});

test('an engine product: a data_only rules-only change and a data_only change carrying the stale engine hash are both held; nothing is stored and no price moves', async () => {
  const w = pricingWorld();
  const adopted = await adoptViaForm(w);
  const priced = priceImage(w.raw, SNAP);
  const stored = JSON.stringify(persisted(w.raw));
  const rulesOnly = await w.putInputs(SNAP, { inputs_seq: adopted.body.inputs_seq, rules: [{ kind: 'target_profit', scope: 'product', amount_usd: '999' }], data_only: true });
  assert.equal(rulesOnly.status, 409, JSON.stringify(rulesOnly.body));
  assert.equal(rulesOnly.body.code, 'PRICING_PREVIEW_REQUIRED');
  // The adoption's own (now spent) hash, sent again with a new change: stale, never "already".
  const replay = await w.putInputs(SNAP, {
    inputs_seq: adopted.body.inputs_seq,
    inputs: [{ scope: 'base', additional_cost_iqd: 1 }],
    data_only: true,
    preview_hash: adopted.body.preview_hash,
    confirm_large_change: true,
  });
  assert.ok(replay.status === 409 || replay.body.already === true, JSON.stringify(replay.body));
  assert.equal(JSON.stringify(persisted(w.raw)), stored);
  assert.equal(priceImage(w.raw, SNAP), priced);
});

/** The form's `io` over the real routes (as tests/usdPricingCommit.test.ts builds it). */
function ioOf(w: World, log: Array<{ method: string; body?: Record<string, unknown>; status?: number; code?: string }> = []): PricingIo {
  const call = async (method: string, path: string, body?: unknown) => {
    const entry: { method: string; body?: Record<string, unknown>; status?: number; code?: string } = { method, ...(body === undefined ? {} : { body: body as Record<string, unknown> }) };
    log.push(entry);
    const res = await w.app.request(path, { method, headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, undefined, ctx);
    const out = (await res.json()) as Record<string, unknown>;
    entry.status = res.status;
    entry.code = typeof out.code === 'string' ? out.code : undefined;
    if (!res.ok) throw new ApiError(res.status, String(out.error ?? ''), out.code as string | undefined, out.details as Record<string, unknown> | undefined, out);
    return out as unknown as UsdPricingAnswer;
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), put: (p, b) => call('PUT', p, b) };
}

test('commitPricing never sends an engine hash: every PUT it makes for a completing manual save carries data_only and, at most, the conversion hash', async () => {
  const w = pricingWorld();
  const io = ioOf(w);
  const log: Array<{ method: string; body?: Record<string, unknown>; status?: number; code?: string }> = [];
  const drafts: Record<string, ScopeDraft> = {
    base: { supplier_cost_currency: 'IQD', supplier_cost_iqd: 1_450_000, shipping_profile: 'CHINA_SEA', box: [600, 520, 480], additional_cost_iqd: 15000, minimum_target_profit_usd: '120', direct_sale_extra_iqd: 25000 },
  };
  const current = await io.get(inputsPath(SNAP));
  const body = draftWire(drafts, current);
  const shown = await io.post(previewPath(SNAP), { draft: body });
  assert.equal(shown.adoption?.kind, 'adopt');
  const before = priceImage(w.raw, SNAP);
  const res = await commitPricing(ioOf(w, log), SNAP, drafts, { base: current, preview: { wire: JSON.stringify(body), answer: shown } });
  assert.equal(res.kind, 'saved', JSON.stringify(res));
  for (const c of log.filter((x) => x.method === 'PUT')) {
    assert.equal(c.body!.data_only, true);
    assert.notEqual(c.body!.preview_hash, shown.preview_hash, 'the engine hash never rides on a data save');
    assert.equal(c.body!.confirm_large_change, undefined);
  }
  assert.equal(priceImage(w.raw, SNAP).replace(/"state":\[[^\]]*\]/, ''), before.replace(/"state":\[[^\]]*\]/, ''));
  assert.equal(persisted(w.raw).state?.mode, 'manual');
});

test('FX plan §12 — typed dinars are stored at the rate the owner was SHOWN: a rate that moved after the owner’s preview is not used silently; it is shown, and the next save uses it', async () => {
  const w = pricingWorld();
  const io = ioOf(w);
  const drafts: Record<string, ScopeDraft> = { base: { supplier_cost_currency: 'IQD', supplier_cost_iqd: 1_600_000 } };
  const current = await io.get(inputsPath(SNAP));
  const body = draftWire(drafts, current);
  // The owner's live preview: 1,600,000 IQD at 1 USD = 1,600 IQD → $1,000 (what the panel showed).
  const shown = await io.post(previewPath(SNAP), { draft: body });
  const shownBase = (shown.scopes as unknown as Array<{ scope: string; pricing_inputs: { conversion_rate_snapshot: string | null } | null }>).find((s) => s.scope === 'base');
  assert.equal(shownBase?.pricing_inputs?.conversion_rate_snapshot, '1600', 'the panel showed the 1,600 rate');
  // The rate moves before «نشر» (another tab approved a new USD/IQD rate).
  applyRate(w.raw, 'USD_IQD', '2000', '2026-10-10T09:00:00.000Z');
  const log: Array<{ method: string; body?: Record<string, unknown>; status?: number; code?: string }> = [];
  const res = await commitPricing(ioOf(w, log), SNAP, drafts, { base: current, preview: { wire: JSON.stringify(body), answer: shown }, seenRates: ['1600'] });
  const storedRate = () => all<{ conversion_rate_snapshot: string | null }>(w.raw, "SELECT conversion_rate_snapshot FROM pricing_inputs WHERE product_id = ? AND scope = 'base' AND origin = 'MANUAL_OVERRIDE'", SNAP)[0]?.conversion_rate_snapshot ?? null;
  // Never stored at 2,000: the dinars are withheld (they were all there was to save), with the new conversion to see.
  assert.equal(res.kind, 'withheld', JSON.stringify(res));
  assert.deepEqual(log.map((c) => `${c.method} ${c.status}${c.code ? ` ${c.code}` : ''}`), ['PUT 409 PRICING_PREVIEW_STALE', 'POST 200']);
  if (res.kind !== 'withheld') return;
  assert.equal(res.withheld.reason, 'rate_unseen');
  assert.deepEqual(res.withheld.conversions, [['1,600,000', '800', '2000']], 'the conversion at the new rate, for the owner to see');
  assert.equal(storedRate(), null, 'nothing stored at a rate the owner had not seen');
  // The outcome said it (the hook adds 2,000 to the rates seen): the next save stores it at 2,000.
  const again = await commitPricing(ioOf(w), SNAP, drafts, { seenRates: ['1600', '2000'] });
  assert.equal(again.kind, 'saved', JSON.stringify(again));
  assert.equal(storedRate(), '2000');
  const back = readBack((await w.getInputs(SNAP)).body, 'base')!;
  assert.equal(back.supplier_cost_amount, '800');
});

test('FX plan §12 — no cached preview (pressed before it landed): the fresh look is used only at a rate the owner was shown; otherwise the rest is saved and the dinars wait', async () => {
  const w = pricingWorld();
  const drafts: Record<string, ScopeDraft> = { base: { supplier_cost_currency: 'IQD', supplier_cost_iqd: 1_600_000, minimum_target_profit_usd: '120' } };
  // The panel had said 1 USD = 1,500 IQD (an answer read before the rate moved to today's 1,600).
  const log: Array<{ method: string; body?: Record<string, unknown>; status?: number; code?: string }> = [];
  const res = await commitPricing(ioOf(w, log), SNAP, drafts, { seenRates: ['1500'] });
  assert.equal(res.kind, 'saved', JSON.stringify(res));
  if (res.kind !== 'saved') return;
  assert.equal(res.withheld?.reason, 'rate_unseen');
  assert.deepEqual(res.withheld?.conversions, [['1,600,000', '1000', '1600']]);
  const put = log.find((c) => c.method === 'PUT')!;
  assert.ok(!(put.body!.inputs as Array<Record<string, unknown>> | undefined ?? []).some((e) => 'supplier_cost_iqd' in e), 'the dinars were not sent');
  assert.equal(put.body!.preview_hash, undefined);
  const p = persisted(w.raw);
  assert.ok(p.rules.some((r) => r.kind === 'target_profit' && r.amount_usd === '120'), 'the rest is stored');
  assert.equal(p.inputs.find((i) => i.scope === 'base')?.supplier_cost_amount ?? null, null);
  // The rate the panel shows (1,600) is a rate the owner saw: the same save goes through at once.
  const w2 = pricingWorld();
  const ok = await commitPricing(ioOf(w2), SNAP, drafts, { seenRates: ['1600'] });
  assert.equal(ok.kind, 'saved');
  if (ok.kind === 'saved') assert.equal(ok.withheld ?? null, null);
  assert.equal(persisted(w2.raw).inputs.find((i) => i.scope === 'base')?.conversion_rate_snapshot, '1600');
});

void SNAP_MODEL;
