/**
 * INCOMING STOCK LINKED TO THE PRODUCT (owner report 2026-10-17; DECISIONS
 * row 247): what a purchase carries to the product — the supplier price, the
 * shipping weight, the CBM and the extras — per model, colour and variant
 * exactly as bought, and when.
 *
 *   (A) a purchase confirmed with an ESTIMATED cost and fixed FINAL by an edit
 *       gets its review; its arrival rings the owner's bell once (no figure);
 *   (B) an edit before receipt refreshes the review; the same figures keep it;
 *   (C) purchases of different models each keep their own review; only one of
 *       the same levels replaces an older one; the needs-pricing fold applies
 *       them all;
 *   (D) a cancelled purchase leaves no review and its cost is never applied;
 *       a close after a partial receipt keeps it;
 *   (E) a variant bought costlier never moves its sibling: the model is only
 *       seeded, the bought SKU carries what was bought;
 *   (F) a colour line never changes the product's own value once it has one;
 *   (G) the review names the colour whose own cost the purchase will not reach;
 *   (H) a local dinar purchase is offered as USD (IQD_CONVERTED, once, at U);
 *   (I) a received batch is its dollars on the shelf, priced at today's U;
 *   (J) the stock level never changes under batches on the shelf;
 *   (K) the next purchase's prefill learns only a final cost.
 *
 * LOCAL ONLY: in-memory SQLite, no network.
 *
 * Run: node --import tsx --test tests/purchaseStockLink.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, json, post, put, stubApp } from './fixtures/app';
import { AMS, AMS_MODEL, OWNER_USER, pricingWorld } from './fixtures/procurementPricing';
import { legacyOptionId, legacyProductId } from './fixtures/legacyCatalogue';
import { publishV2 } from './fixtures/v2Publish';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { adminProcurementRoutes } from '../worker/routes/adminProcurement';
import { deriveProductEntries, shadowedOf, type PurchaseForPricing } from '../worker/lib/pricingEngine/fromPurchase';
import { reviewView, type PurchaseReviewRow } from '../worker/lib/pricingEngine/v2/purchaseReview';
import { PURCHASE_ARRIVED_EVENT } from '../worker/lib/pricingEngine/v2/bell';
import { loadShelves, shelfOfSku } from '../worker/lib/pricingEngine/v2/shelf';
import { loadRelationsSnapshot, planRelationsWriteFrom } from '../worker/lib/productPersistence';
import type { ProductPricingData, StoredInputRow } from '../worker/lib/pricingEngine/store';

type World = ReturnType<typeof pricingWorld>;

const reviews = (w: World, productId?: string) =>
  w.raw
    .prepare(`SELECT id, product_id, purchase_id, state, inputs_json FROM pricing_v2_purchase_reviews ${productId ? 'WHERE product_id = ?' : ''} ORDER BY created_at, id`)
    .all(...(productId ? [productId] : [])) as Array<{ id: string; product_id: string; purchase_id: string; state: string; inputs_json: string }>;

const owner = (w: World) =>
  stubApp(
    w.db,
    OWNER_USER,
    (a) => {
      a.route('/api/admin/products-v2', adminProductsRoutes);
      a.route('/api/admin/procurement', adminProcurementRoutes);
    },
    { publishV2: false }
  );

const versionOf = async (w: World, id: string) => Number((await json(await get(w.app, `/api/admin/procurement/documents/${id}`))).purchase.version);

async function edit(w: World, id: string, extra: Record<string, unknown>) {
  const res = await put(w.app, `/api/admin/procurement/documents/${id}`, { ...w.draft(extra), version: await versionOf(w, id) });
  assert.equal(res.status, 200, JSON.stringify(await json(res)).slice(0, 300));
}

async function applyReview(w: World, pid: string, id: string) {
  const o = owner(w);
  const preview = await json(await post(o, `/api/admin/products-v2/${pid}/purchase-review/${id}/preview`, {}));
  assert.equal(preview.success, true, JSON.stringify(preview).slice(0, 400));
  const body = { preview_hash: preview.preview.review_hash, ...(preview.preview.large_change || preview.preview.drop_flag ? { confirm_large_change: true } : {}) };
  const res = await post(o, `/api/admin/products-v2/${pid}/purchase-review/${id}/apply`, body);
  return { status: res.status, body: await json(res) };
}

const bells = (w: World) =>
  w.raw.prepare("SELECT entity_id, body_ar, body_en, meta FROM user_notifications WHERE json_extract(meta, '$.reason') = ?").all(PURCHASE_ARRIVED_EVENT) as Array<{
    entity_id: string;
    body_ar: string;
    body_en: string;
    meta: string;
  }>;

test('(A) estimated at confirm → no review; fixed FINAL by an edit → one pending review; the arrival rings the owner once, with no figure', async () => {
  const w = pricingWorld();
  await publishV2(w.raw, AMS);
  const id = await w.save(w.draft({ cost_state: 'estimated' }));
  assert.equal(reviews(w).length, 0, 'an estimate is never offered as the product’s cost');
  await edit(w, id, { cost_state: 'final' });
  const list = reviews(w);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.state, 'pending');
  assert.match(list[0]!.inputs_json, /"supplier_cost_amount":"450"/);
  assert.match(list[0]!.inputs_json, /"shipping_weight_g":2500/);
  // Receive one unit, then the other: the review stays pending, the bell rings once.
  const doc = await json(await get(w.app, `/api/admin/procurement/documents/${id}`));
  const line = (doc.lines as Array<{ line_id: string }>)[0]!;
  for (const op of ['op_aaaaaaaaaaaa1', 'op_aaaaaaaaaaaa2']) {
    const res = await post(w.app, `/api/admin/procurement/documents/${id}/receive`, { operation_id: op, lines: [{ line_id: line.line_id, qty: 1, rejected_qty: 0 }] });
    const body = await json(res);
    assert.equal(res.status, 200, JSON.stringify(body).slice(0, 300));
    assert.deepEqual(body.price_reviews, [{ product_id: AMS, state: 'pending' }], 'the owner’s answer names the waiting review');
  }
  assert.equal(reviews(w)[0]!.state, 'pending');
  const rung = bells(w);
  assert.equal(rung.length, 1, 'once per product and purchase');
  assert.equal(rung[0]!.entity_id, AMS);
  assert.equal(JSON.parse(rung[0]!.meta).purchase_id, id);
  assert.doesNotMatch(`${rung[0]!.body_ar} ${rung[0]!.body_en}`, /[0-9٠-٩]/, 'no figure in the bell');
});

test('(B) an ordered purchase edited 450 → 600 EUR replaces its review; re-saving the same figures keeps the review id', async () => {
  const w = pricingWorld();
  await publishV2(w.raw, AMS);
  const id = await w.save(w.draft());
  const first = reviews(w)[0]!;
  const line = (eur: number) => [{ ...(w.draft().lines as Array<Record<string, unknown>>)[0]!, source_unit_amount: eur }];
  await edit(w, id, { lines: line(600) });
  const after = reviews(w);
  assert.deepEqual(after.map((r) => r.state), ['superseded', 'pending']);
  assert.equal(after[0]!.id, first.id);
  assert.match(after[1]!.inputs_json, /"supplier_cost_amount":"600"/);
  await edit(w, id, { lines: line(600) });
  const again = reviews(w);
  assert.equal(again.length, 2, 'no new row for the same figures');
  assert.equal(again[1]!.id, after[1]!.id);
  assert.equal(again[1]!.state, 'pending');
  // Back to an estimate: the review goes (an estimate is never the product’s cost).
  await edit(w, id, { lines: line(600), cost_state: 'estimated' });
  assert.deepEqual(reviews(w).map((r) => r.state), ['superseded', 'superseded']);
  // Final again: a fresh review; once the owner applied it, the same figures saved again ask nothing more.
  await edit(w, id, { lines: line(600) });
  const fresh = reviews(w).at(-1)!;
  assert.equal(fresh.state, 'pending');
  assert.equal((await applyReview(w, AMS, fresh.id)).status, 200);
  await edit(w, id, { lines: line(600) });
  assert.deepEqual(reviews(w).map((r) => r.state), ['superseded', 'superseded', 'applied']);
});

test('(C) bambu-lab-a1: purchases of two models each keep their review, listed oldest first; only a later purchase of the same model replaces one; the needs-pricing fold applies both', async () => {
  const w = pricingWorld();
  const A1 = legacyProductId('bambu-lab-a1');
  const [m0, m1] = [legacyOptionId('bambu-lab-a1', 0), legacyOptionId('bambu-lab-a1', 1)];
  const line = (model: string, eur: number) => ({ product_id: A1, scope: 'option', scope_id: model, qty_ordered: 1, source_unit_amount: eur, weight_g: 4000, volume_mm3: 0 });
  const p1 = await w.save(w.draft({ lines: [line(m0, 300)] }));
  const p2 = await w.save(w.draft({ lines: [line(m1, 500)] }));
  assert.deepEqual(reviews(w, A1).map((r) => [r.purchase_id, r.state]), [
    [p1, 'pending'],
    [p2, 'pending'],
  ]);
  const read = await json(await get(owner(w), `/api/admin/products-v2/${A1}/purchase-review`));
  assert.deepEqual(
    (read.purchase_reviews as Array<{ purchase_id: string }>).map((r) => r.purchase_id),
    [p1, p2],
    'every pending review, oldest first'
  );
  assert.equal(read.purchase_review.purchase_id, p2, 'the older key names the newest');
  assert.equal(read.purchase_reviews[0].inputs[0].scope, 'option');
  assert.ok(read.purchase_reviews[0].inputs[0].name, 'the model is named');
  // The needs-pricing prefill carries both models’ costs.
  const pricing = await json(await get(owner(w), `/api/admin/products-v2/${A1}/pricing`));
  const shown = pricing.v2_cost_inputs.inputs as Array<Record<string, unknown>>;
  assert.equal(String(shown.find((r) => r.scope === 'option' && r.scope_id === m0)?.supplier_cost_amount), '300');
  assert.equal(String(shown.find((r) => r.scope === 'option' && r.scope_id === m1)?.supplier_cost_amount), '500');
  assert.deepEqual([...pricing.v2_cost_inputs.purchase_review_ids].sort(), reviews(w, A1).map((r) => r.id).sort());
  // A third purchase of model 0 alone replaces purchase 1’s review only.
  const p3 = await w.save(w.draft({ lines: [line(m0, 320)] }));
  assert.deepEqual(reviews(w, A1).map((r) => [r.purchase_id, r.state]), [
    [p1, 'superseded'],
    [p2, 'pending'],
    [p3, 'pending'],
  ]);
  // The owner's first complete write applies every folded review.
  const o = owner(w);
  const set = { method: 'usd', points: [{ scope: 'product', id: '', kind: 'fixed', usd: '1000' }] };
  const pre = await json(await post(o, '/api/admin/products-v2/pricing/preview', { product_id: A1, pricing: set }));
  const res = await put(o, `/api/admin/products-v2/${A1}/pricing`, { seq: pre.seq, pricing: set, preview_hash: pre.review_hash });
  assert.equal(res.status, 200, (await res.text()).slice(0, 300));
  assert.deepEqual(reviews(w, A1).map((r) => r.state), ['superseded', 'applied', 'applied']);
  const stored = w.raw.prepare("SELECT scope_id, supplier_cost_amount FROM pricing_inputs WHERE product_id = ? AND scope = 'option' AND origin = 'MANUAL_OVERRIDE' ORDER BY scope_id").all(A1);
  assert.deepEqual(
    stored.map((r) => ({ ...r })),
    [
      { scope_id: m0, supplier_cost_amount: '320' },
      { scope_id: m1, supplier_cost_amount: '500' },
    ]
  );
});

test('(D) a purchase closed with nothing received takes its review with it; a review of a cancelled purchase is refused; a close after a partial receipt keeps it', async () => {
  const w = pricingWorld();
  await publishV2(w.raw, AMS);
  const id = await w.save(w.draft());
  const res = await post(w.app, `/api/admin/procurement/documents/${id}/close`, { reason: 'supplier cancelled' });
  assert.equal(res.status, 200);
  assert.deepEqual(reviews(w).map((r) => r.state), ['superseded']);
  // Out of band: a purchase cancelled while its review still waits.
  const id2 = await w.save(w.draft());
  const pending = reviews(w).find((r) => r.purchase_id === id2)!;
  w.raw.prepare("UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?").run(id2);
  const refused = await applyReview(w, AMS, pending.id);
  assert.equal(refused.status, 409, JSON.stringify(refused.body).slice(0, 300));
  assert.equal(refused.body.code, 'PRICING_REVIEW_PURCHASE_CANCELLED');
  assert.equal((w.raw.prepare("SELECT COUNT(*) AS n FROM pricing_inputs WHERE source_ref = ?").get(`purchase:${id2}`) as { n: number }).n, 0);
  // A partial receipt, then a close: those units arrived at that cost.
  const id3 = await w.save(w.draft());
  const doc = await json(await get(w.app, `/api/admin/procurement/documents/${id3}`));
  const line = (doc.lines as Array<{ line_id: string }>)[0]!;
  const rec = await post(w.app, `/api/admin/procurement/documents/${id3}/receive`, { operation_id: 'op_dddddddddddd1', lines: [{ line_id: line.line_id, qty: 1, rejected_qty: 0 }] });
  assert.equal(rec.status, 200);
  assert.equal((await post(w.app, `/api/admin/procurement/documents/${id3}/close`, { reason: 'rest never shipped' })).status, 200);
  assert.equal(reviews(w).find((r) => r.purchase_id === id3)!.state, 'pending');
  const applied = await applyReview(w, AMS, reviews(w).find((r) => r.purchase_id === id3)!.id);
  assert.equal(applied.status, 200, JSON.stringify(applied.body).slice(0, 300));
});

test('(E) bambu-lab-pla-cf: variant o0|c0 at €10, then o0|c1 at €12 → the model stays €10 (seeded once), the bought SKU carries €12, o0|c0 still €10', async () => {
  const w = pricingWorld();
  const CF = legacyProductId('bambu-lab-pla-cf');
  await publishV2(w.raw, CF);
  const variants = w.raw.prepare('SELECT id, combo_key FROM product_variants WHERE product_id = ? ORDER BY id').all(CF) as Array<{ id: string; combo_key: string }>;
  const o0 = legacyOptionId('bambu-lab-pla-cf', 0);
  const [v0, v1] = variants.filter((v) => v.combo_key.startsWith(`o:${o0}|c:`));
  assert.ok(v0 && v1, JSON.stringify(variants.slice(0, 4)));
  const line = (variant: string, eur: number) => ({ product_id: CF, scope: 'variant', scope_id: variant, qty_ordered: 2, source_unit_amount: eur, weight_g: 1200, volume_mm3: 0 });
  await w.save(w.draft({ lines: [line(v0.id, 10)] }));
  assert.equal((await applyReview(w, CF, reviews(w, CF).at(-1)!.id)).status, 200);
  await w.save(w.draft({ lines: [line(v1.id, 12)] }));
  assert.equal((await applyReview(w, CF, reviews(w, CF).at(-1)!.id)).status, 200);
  const rows = w.raw
    .prepare("SELECT scope, scope_id, supplier_cost_amount FROM pricing_inputs WHERE product_id = ? AND origin = 'MANUAL_OVERRIDE' AND supplier_cost_amount IS NOT NULL ORDER BY scope, scope_id")
    .all(CF)
    .map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { scope: 'option', scope_id: o0, supplier_cost_amount: '10' },
    { scope: 'sku', scope_id: v1.combo_key, supplier_cost_amount: '12' },
  ]);
});

/** A colour line of product p1 (COLOR mode) at `eur`, with the SKU rung's levels. */
const colourCase = () => {
  const row = (scope: StoredInputRow['scope'], scope_id: string, amount: string): StoredInputRow => ({
    product_id: 'p1', scope, scope_id, origin: 'MANUAL_OVERRIDE', supplier_cost_amount: amount, supplier_cost_delta: null, supplier_cost_currency: 'EUR',
    supplier_input_mode: 'SOURCE_CURRENCY', original_input_amount: null, original_input_currency: null, conversion_rate_snapshot: null, conversion_fx_version: null,
    canonical_supplier_cost_usd: null, converted_at: null, shipping_profile: 'GERMANY_LAND', pricing_weight_g: null, shipping_weight_g: 1000, shipping_length_mm: null,
    shipping_width_mm: null, shipping_height_mm: null, manual_cbm: null, additional_cost_iqd: null, unresolved_fields: '[]', source_ref: 'owner', version: 1, updated_at: '',
  });
  const purchase = (line: Partial<PurchaseForPricing['lines'][number]>): PurchaseForPricing => ({
    purchase_id: 'po1', status: 'ordered', cost_state: 'final', currency: 'EUR', exchange_rate: 1760,
    profile: { id: 'germany_land', shipping_basis: 'weight' },
    lines: [{ index: 0, line_id: null, key: 'p1:color:c0', product_id: 'p1', scope: 'color', scope_id: 'c0', option_id: null, label: 'c0', qty: 2, cost_mode: 'unit', source_amount: 14, weight_g: 1000, volume_mm3: 0, store_price_iqd: null, ...line }],
    charges: [],
  });
  const levels = {
    color: new Set(['c0', 'c1']),
    sku: new Set(['o:o0|c:c0', 'o:o0|c:c1']),
    variants: new Map<string, string>(),
    units: [
      { option_value_ids: ['o0'], color_id: 'c0', combo_key: 'o:o0|c:c0' },
      { option_value_ids: ['o0'], color_id: 'c1', combo_key: 'o:o0|c:c1' },
    ],
  };
  return { row, purchase, levels };
};

test('(F) a colour purchase lands on its colour; the product’s own value stays as it is', () => {
  const { row, purchase, levels } = colourCase();
  const stored: ProductPricingData = { product_id: 'p1', state: null, rules: [], config_version: 1, inputs: [row('base', '', '10')] };
  const d = deriveProductEntries(purchase({}), 'p1', stored, { optIn: new Set(['p1:color:c0']), prefer: false, usePurchase: true, rates: null, levels });
  const base = d.entries.find((e) => e.write.scope === 'base')!;
  assert.equal(base.write.set.supplier_cost_amount, undefined, 'the base is not raised');
  const colour = d.entries.find((e) => e.write.scope === 'color')!;
  assert.equal(colour.write.scope_id, 'c0');
  assert.equal(colour.write.set.supplier_cost_amount, '14');
});

test('(G) a model bought at €14 under a colour holding its own €9: the review names the colour the cost will not reach', () => {
  const { row, levels } = colourCase();
  const stored = [row('option', 'o0', '10'), row('color', 'c0', '9')];
  const writes = [{ scope: 'option' as const, scope_id: 'o0', set: { supplier_cost_amount: '14', supplier_cost_currency: 'EUR' as const }, existing: stored[0]! }];
  const shadowed = shadowedOf(stored, writes, levels);
  assert.deepEqual(shadowed, [{ scope: 'option', scope_id: 'o0', field: 'supplier_cost_amount', by: [{ scope: 'color', scope_id: 'c0' }] }]);
  const review: PurchaseReviewRow = {
    id: 'pvr_1', product_id: 'p1', purchase_id: 'po1', state: 'pending', created_at: '', purchase_name: 'Shipment 7', purchase_status: 'ordered',
    inputs_json: JSON.stringify([{ scope: 'option', scope_id: 'o0', set: { supplier_cost_amount: '14', supplier_cost_currency: 'EUR' }, source_ref: 'purchase:po1' }]),
  };
  const names = (scope: string, id: string) => (scope === 'color' && id === 'c0' ? { ar: 'أسود', en: 'Black', ckb: 'ڕەش' } : null);
  const view = reviewView(review, { stored, levels, names });
  assert.equal(view.purchase_name, 'Shipment 7');
  assert.deepEqual(view.shadowed[0]!.by, [{ scope: 'color', scope_id: 'c0', name: { ar: 'أسود', en: 'Black', ckb: 'ڕەش' } }]);
});

test('(H) a local dinar purchase is offered as USD — converted once at U (1,600) — and applying it stores IQD_CONVERTED with the dinars typed', async () => {
  const w = pricingWorld();
  await publishV2(w.raw, AMS);
  const manual = { cost_profile_id: undefined, cost_profile_version: undefined, shipping_rate_iqd: undefined };
  const line = [{ ...(w.draft().lines as Array<Record<string, unknown>>)[0]!, source_unit_amount: 720000 }];
  const id = await w.save(w.draft({ ...manual, currency: 'IQD', exchange_rate: 1, lines: line }));
  const [r] = reviews(w);
  const inputs = JSON.parse(r!.inputs_json) as Array<{ set: Record<string, unknown>; iqd?: Record<string, unknown> }>;
  assert.equal(inputs[0]!.set.supplier_cost_currency, 'USD');
  assert.equal(inputs[0]!.set.supplier_cost_amount, '450', '720,000 IQD ÷ 1,600');
  assert.equal(inputs[0]!.iqd?.original_input_amount, '720000');
  assert.equal(inputs[0]!.iqd?.conversion_fx_version, 1);
  const applied = await applyReview(w, AMS, r!.id);
  assert.equal(applied.status, 200, JSON.stringify(applied.body).slice(0, 300));
  const stored = w.raw
    .prepare("SELECT supplier_cost_amount, supplier_cost_currency, supplier_input_mode, original_input_amount, conversion_rate_snapshot FROM pricing_inputs WHERE product_id = ? AND source_ref = ?")
    .get(AMS, `purchase:${id}`) as Record<string, unknown>;
  assert.deepEqual({ ...stored }, { supplier_cost_amount: '450', supplier_cost_currency: 'USD', supplier_input_mode: 'IQD_CONVERTED', original_input_amount: '720000', conversion_rate_snapshot: '1600' });
});

test('(I) a received batch is its dollars on the shelf: its dinars ÷ the purchase’s U, priced at today’s U', async () => {
  const w = pricingWorld();
  const id = await w.save(w.draft());
  const rec = await w.receive(id, 'op_iiiiiiiiiiii1');
  assert.equal(rec.status, 200, JSON.stringify(rec.body).slice(0, 300));
  const lot = w.raw.prepare('SELECT unit_cost_iqd, usd_iqd_rate_at_purchase FROM inventory_lots WHERE product_id = ?').get(AMS) as { unit_cost_iqd: number; usd_iqd_rate_at_purchase: string };
  assert.equal(lot.usd_iqd_rate_at_purchase, '1600', 'the EUR purchase carries the central U it was confirmed at');
  const micro = Math.round((lot.unit_cost_iqd * 1_000_000) / 1600);
  const shelf = (await loadShelves(w.db, [AMS])).get(AMS)!;
  const sku = { option_value_ids: [AMS_MODEL], color_id: null, combo_key: `o:${AMS_MODEL}` };
  assert.equal(shelf.identities[0]!.cost_usd_micro, micro);
  assert.deepEqual(shelfOfSku(shelf, sku, '1600'), { state: 'on_shelf', cost_iqd: Math.ceil((micro * 1600) / 1_000_000), units: 2 });
  assert.deepEqual(shelfOfSku(shelf, sku, '1700'), { state: 'on_shelf', cost_iqd: Math.ceil((micro * 1700) / 1_000_000), units: 2 });
});

test('(J) the stock level never changes under units on the shelf (INVENTORY_MODE_HAS_STOCK); with the shelf empty and nothing open it may', async () => {
  const w = pricingWorld();
  const id = await w.save(w.draft());
  const rec = await w.receive(id, 'op_jjjjjjjjjjjj1');
  assert.equal(rec.status, 200, JSON.stringify(rec.body).slice(0, 300));
  const body = { inventory_mode: 'BASE', groups: [], colors: [], variants: [], images: [] };
  await assert.rejects(
    async () => planRelationsWriteFrom(w.db, await loadRelationsSnapshot(w.db, AMS), body, { money: true }),
    (e: unknown) => (e as { code?: string }).code === 'INVENTORY_MODE_HAS_STOCK'
  );
  w.raw.prepare('UPDATE inventory_lots SET qty_remaining = 0 WHERE product_id = ?').run(AMS);
  await planRelationsWriteFrom(w.db, await loadRelationsSnapshot(w.db, AMS), body, { money: true });
});

test('(K) the next purchase’s prefill learns a FINAL cost only', async () => {
  const w = pricingWorld();
  const defaults = () => w.raw.prepare('SELECT source_unit_amount FROM procurement_selection_cost_defaults WHERE product_id = ?').all(AMS).map((r) => ({ ...r }));
  const id = await w.save(w.draft({ cost_state: 'estimated' }));
  assert.deepEqual(defaults(), [], 'an estimate is never the last price');
  await edit(w, id, { cost_state: 'final' });
  assert.deepEqual(defaults(), [{ source_unit_amount: 450 }]);
});
