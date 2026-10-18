/**
 * INCOMING STOCK LINKED TO THE PRODUCT (owner report 2026-10-17; DECISIONS
 * row 249): what a purchase carries to the product — the supplier price, the
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
 *   (K) the next purchase's prefill learns only a final cost;
 *   (L) two variants (and two colours) of one model confirmed BEFORE the owner
 *       reviews either: each review names its own bought level, neither replaces
 *       the other, applied in either order each level keeps what it was bought
 *       at; the broader level takes the first seed only, in the fold too;
 *   (M) a purchase that replaced another's review, then cancelled or taken back
 *       to estimated, gives that review back: the purchase really bought still
 *       reaches the owner, and its arrival rings;
 *   (N) at an unchanged U a rated batch is its dinars as paid, never one more;
 *   (O) the stock-level guard: the fulfillment route refuses, the form's derived
 *       level is kept (with a note) instead of freezing the save;
 *   (P) the purchase card's preview of a dinar purchase says what its confirm
 *       will carry.
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
import { adminProductRelationsRoutes } from '../worker/routes/adminProductRelations';
import { pendingReviewsOf, reviewFoldInputs } from '../worker/lib/pricingEngine/v2/firstWrite';
import { chainOfUnit, loadProductsPricing, type ProductPricingData, type StoredInputRow } from '../worker/lib/pricingEngine/store';
import { resolveSkuInputs } from '../packages/pricing/src/costToPrice';
import { asD1, freshDb } from './fixtures/app';

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

test('(E) bambu-lab-pla-cf: variant o0|c0 at €10, then o0|c1 at €12 → the model stays €10 (seeded once), each bought SKU carries what it was bought at', async () => {
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
    { scope: 'sku', scope_id: v0.combo_key, supplier_cost_amount: '10' },
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
  // The same U: the dinars as paid. Another U: the batch's dinars × today's U ÷ its U, rounded up, exactly.
  const at = (u: bigint) => Number((BigInt(lot.unit_cost_iqd) * u + 1599n) / 1600n);
  assert.deepEqual(shelfOfSku(shelf, sku, '1600'), { state: 'on_shelf', cost_iqd: lot.unit_cost_iqd, units: 2 });
  assert.deepEqual(shelfOfSku(shelf, sku, '1700'), { state: 'on_shelf', cost_iqd: at(1700n), units: 2 });
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

/** The supplier price each of the product's SKUs resolves, by combo key. */
const resolvedSupplier = async (w: World, pid: string, units: Array<{ option: string; color: string; combo: string }>) => {
  const stored = (await loadProductsPricing(w.db, [pid])).get(pid)!;
  return Object.fromEntries(
    units.map((u) => [u.combo, resolveSkuInputs(chainOfUnit(stored.inputs, { option_value_ids: [u.option], color_id: u.color, combo_key: u.combo })).inputs.supplier?.amount ?? null])
  );
};

const ownRows = (w: World, pid: string) =>
  w.raw
    .prepare("SELECT scope, scope_id, supplier_cost_amount FROM pricing_inputs WHERE product_id = ? AND origin = 'MANUAL_OVERRIDE' AND supplier_cost_amount IS NOT NULL ORDER BY scope, scope_id")
    .all(pid)
    .map((r) => ({ ...r }));

for (const order of ['first', 'second'] as const) {
  test(`(L) two variants of one model confirmed before any review (€10 then €12), the ${order} applied first → each SKU keeps its own price`, async () => {
    const w = pricingWorld();
    const CF = legacyProductId('bambu-lab-pla-cf');
    await publishV2(w.raw, CF);
    const o0 = legacyOptionId('bambu-lab-pla-cf', 0);
    const [v0, v1] = (w.raw.prepare('SELECT id, combo_key FROM product_variants WHERE product_id = ? ORDER BY id').all(CF) as Array<{ id: string; combo_key: string }>).filter((v) =>
      v.combo_key.startsWith(`o:${o0}|c:`)
    );
    const line = (variant: string, eur: number) => ({ product_id: CF, scope: 'variant', scope_id: variant, qty_ordered: 2, source_unit_amount: eur, weight_g: 1200, volume_mm3: 0 });
    const p1 = await w.save(w.draft({ lines: [line(v0!.id, 10)] }));
    const p2 = await w.save(w.draft({ lines: [line(v1!.id, 12)] }));
    const list = reviews(w, CF);
    assert.deepEqual(list.map((r) => r.state), ['pending', 'pending'], 'a colour or variant bought never replaces another one’s review');
    for (const [r, combo] of [[list[0]!, v0!.combo_key], [list[1]!, v1!.combo_key]] as const) {
      const inputs = JSON.parse(r.inputs_json) as Array<{ scope: string; scope_id: string; seed?: boolean }>;
      assert.deepEqual(inputs.map((i) => [i.scope, i.scope_id, !!i.seed]), [['option', o0, true], ['sku', combo, false]], 'the bought level is named, the model only seeded');
    }
    const ids = order === 'first' ? [list[0]!.id, list[1]!.id] : [list[1]!.id, list[0]!.id];
    for (const id of ids) assert.equal((await applyReview(w, CF, id)).status, 200);
    const units = [v0!, v1!].map((v) => ({ option: o0, color: v.combo_key.split('|c:')[1]!, combo: v.combo_key }));
    assert.deepEqual(await resolvedSupplier(w, CF, units), { [v0!.combo_key]: '10', [v1!.combo_key]: '12' });
    // The model took the seed of the review applied first, and only that one.
    assert.deepEqual(ownRows(w, CF).find((r) => r.scope === 'option'), { scope: 'option', scope_id: o0, supplier_cost_amount: order === 'first' ? '10' : '12' });
    assert.ok(p1 && p2);
  });
}

test('(L) two colours (COLOR mode) confirmed before any review: both wait, both ring on arrival, each colour keeps its own; the needs-pricing fold seeds the product once', async () => {
  const w = pricingWorld();
  const CF = legacyProductId('bambu-lab-pla-cf');
  w.raw.prepare("UPDATE products SET inventory_mode = 'COLOR' WHERE id = ?").run(CF);
  await publishV2(w.raw, CF);
  const c0 = `${CF}_c0`, c1 = `${CF}_c1`, o0 = legacyOptionId('bambu-lab-pla-cf', 0);
  const line = (colour: string, eur: number) => ({ product_id: CF, scope: 'color', scope_id: colour, qty_ordered: 2, source_unit_amount: eur, weight_g: 1200, volume_mm3: 0 });
  const p1 = await w.save(w.draft({ lines: [line(c0, 10)] }));
  const p2 = await w.save(w.draft({ lines: [line(c1, 12)] }));
  assert.deepEqual(reviews(w, CF).map((r) => r.state), ['pending', 'pending']);
  // The needs-pricing fold of the same two reviews: the product takes the first seed, each colour its own.
  const stored = (await loadProductsPricing(w.db, [CF])).get(CF)!;
  const fold = reviewFoldInputs(stored, await pendingReviewsOf(w.db, CF), () => true).map((x) => [x.scope, x.scope_id, x.set.supplier_cost_amount ?? null]);
  assert.deepEqual(fold, [['base', '', '10'], ['color', c0, '10'], ['color', c1, '12']]);
  for (const [p, op] of [[p1, 'op_llcolourxxxx1'], [p2, 'op_llcolourxxxx2']] as const) {
    const rec = await w.receive(p, op);
    assert.equal(rec.status, 200, JSON.stringify(rec.body).slice(0, 300));
    assert.deepEqual(rec.body.price_reviews, [{ product_id: CF, state: 'pending' }]);
  }
  assert.deepEqual(bells(w).map((b) => JSON.parse(b.meta).purchase_id), [p1, p2], 'each arrival rings for its own review');
  // Applied newest first: the product is seeded by the €12 colour, the €10 colour's seed finds it filled.
  for (const r of reviews(w, CF).reverse()) assert.equal((await applyReview(w, CF, r.id)).status, 200);
  assert.deepEqual(ownRows(w, CF), [
    { scope: 'base', scope_id: '', supplier_cost_amount: '12' },
    { scope: 'color', scope_id: c0, supplier_cost_amount: '10' },
    { scope: 'color', scope_id: c1, supplier_cost_amount: '12' },
  ]);
  const units = [c0, c1].map((c) => ({ option: o0, color: c, combo: `o:${o0}|c:${c}` }));
  assert.deepEqual(await resolvedSupplier(w, CF, units), { [`o:${o0}|c:${c0}`]: '10', [`o:${o0}|c:${c1}`]: '12' });
});

for (const how of ['closed with nothing received', 'taken back to estimated'] as const) {
  test(`(M) P2 replaced P1's review of the same model, then was ${how} → P1's review is back; its arrival rings and its cost reaches the product`, async () => {
    const w = pricingWorld();
    await publishV2(w.raw, AMS);
    const line = (eur: number) => [{ ...(w.draft().lines as Array<Record<string, unknown>>)[0]!, source_unit_amount: eur }];
    const p1 = await w.save(w.draft({ lines: line(450) }));
    const p2 = await w.save(w.draft({ lines: line(500) }));
    assert.deepEqual(reviews(w, AMS).map((r) => [r.purchase_id === p1 ? 'P1' : 'P2', r.state]), [['P1', 'superseded'], ['P2', 'pending']]);
    if (how === 'closed with nothing received') {
      const closed = await post(w.app, `/api/admin/procurement/documents/${p2}/close`, { reason: 'supplier cancelled' });
      assert.equal(closed.status, 200, JSON.stringify(await json(closed)).slice(0, 300));
    } else await edit(w, p2, { lines: line(500), cost_state: 'estimated' });
    const pending = reviews(w, AMS).filter((r) => r.state === 'pending');
    assert.deepEqual(pending.map((r) => r.purchase_id), [p1], 'the purchase really bought still awaits the owner');
    assert.match(pending[0]!.inputs_json, /"supplier_cost_amount":"450"/);
    const rec = await w.receive(p1, 'op_mmmmmmmmmmmm1');
    assert.deepEqual(rec.body.price_reviews, [{ product_id: AMS, state: 'pending' }]);
    assert.equal(bells(w).length, 1, 'its arrival rings the owner');
    const read = await json(await get(owner(w), `/api/admin/products-v2/${AMS}/purchase-review`));
    assert.deepEqual((read.purchase_reviews as Array<{ purchase_id: string }>).map((r) => r.purchase_id), [p1]);
    assert.equal((await applyReview(w, AMS, pending[0]!.id)).status, 200);
    assert.deepEqual(ownRows(w, AMS), [{ scope: 'option', scope_id: AMS_MODEL, supplier_cost_amount: '450' }]);
    // P2 back to final: it replaces nothing the owner already applied, and asks for its own figures.
    if (how === 'taken back to estimated') {
      await edit(w, p2, { lines: line(500), cost_state: 'final' });
      assert.deepEqual(reviews(w, AMS).filter((r) => r.state === 'pending').map((r) => r.purchase_id), [p2]);
    }
  });
}

test('(N) a rated batch at an unchanged U is priced at its dinars as paid — never one dinar more', async () => {
  const raw = freshDb();
  for (const [i, cost] of [690063, 500347, 123457, 999999, 685831, 689581].entries()) {
    raw.exec(`INSERT INTO products (id, slug, name, name_ar, name_ku, status, price_iqd, stock, selling_type, sale_types, preorder_transports, inventory_mode)
              VALUES ('p${i}', 'p${i}', 'P', 'P', 'P', 'active', 700000, 9, 'direct_sale', '["direct_sale"]', '[]', 'BASE')`);
    raw.exec(`INSERT INTO inventory_lots (id, product_id, scope, scope_id, qty_received, qty_remaining, unit_cost_iqd, cost_basis, received_at, snapshot_version, snapshot_source, calculated_at, usd_iqd_rate_at_purchase, fx_snapshot_source)
              VALUES ('l${i}', 'p${i}', 'base', '', 2, 2, ${cost}, 'received', '2026-09-01T00:00:00Z', 1, 'adjustment', '2026-09-01T00:00:00Z', '1310', 'central')`);
    const shelf = (await loadShelves(asD1(raw), [`p${i}`])).get(`p${i}`)!;
    const sku = { option_value_ids: [], color_id: null, combo_key: '' };
    assert.deepEqual(shelfOfSku(shelf, sku, '1310'), { state: 'on_shelf', cost_iqd: cost, units: 2 }, `${cost} at 1,310 → 1,310`);
    assert.deepEqual(shelfOfSku(shelf, sku, '1400'), { state: 'on_shelf', cost_iqd: Number((BigInt(cost) * 1400n + 1309n) / 1310n), units: 2 }, `${cost} at 1,310 → 1,400`);
  }
});

test('(O) the fulfillment route refuses a stock-level change under batches on the shelf; the form’s derived level is kept with a note', async () => {
  const w = pricingWorld();
  const CF = legacyProductId('bambu-lab-pla-cf');
  const v = w.raw.prepare('SELECT id FROM product_variants WHERE product_id = ? ORDER BY id LIMIT 1').get(CF) as { id: string };
  const id = await w.save(w.draft({ lines: [{ product_id: CF, scope: 'variant', scope_id: v.id, qty_ordered: 2, source_unit_amount: 10, weight_g: 1200, volume_mm3: 0 }] }));
  assert.equal((await w.receive(id, 'op_oooooooooooo1')).status, 200);
  const app = stubApp(w.db, OWNER_USER, (a) => a.route('/api/admin/products', adminProductRelationsRoutes));
  const res = await put(app, `/api/admin/products/${CF}/fulfillment`, {
    fulfillments: [0, 1].map((j) => ({ option_id: legacyOptionId('bambu-lab-pla-cf', j), fulfillment_type: 'direct_sale', enabled: true, transports: [] })),
    direct_stock: [0, 1].map((j) => ({ scope: 'option', id: legacyOptionId('bambu-lab-pla-cf', j), stock: 0, low_stock_threshold: null })),
    inventory_mode: 'OPTION',
  });
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'INVENTORY_MODE_HAS_STOCK');
  assert.equal((w.raw.prepare('SELECT inventory_mode FROM products WHERE id = ?').get(CF) as { inventory_mode: string }).inventory_mode, 'VARIANT_COMBINATION');
  // A BASE product with a base batch on the shelf: the form derives OPTION from a typed option stock; the
  // save goes through at BASE and says why, instead of freezing every edit of the product.
  w.raw.prepare("UPDATE products SET inventory_mode = 'BASE' WHERE id = ?").run(AMS);
  w.raw.exec(`INSERT INTO inventory_lots (id, product_id, scope, scope_id, qty_received, qty_remaining, unit_cost_iqd, cost_basis, received_at, snapshot_version, snapshot_source, calculated_at)
              VALUES ('lot_o_base', '${AMS}', 'base', '', 2, 2, 700000, 'received', '2026-09-01T00:00:00Z', 1, 'adjustment', '2026-09-01T00:00:00Z')`);
  const plan = await planRelationsWriteFrom(w.db, await loadRelationsSnapshot(w.db, AMS), { inventory_mode: 'OPTION', groups: [], colors: [], variants: [], images: [] }, { money: true });
  assert.ok('mode' in plan && plan.mode !== undefined, JSON.stringify(plan.errors));
  assert.equal(plan.mode, 'BASE');
  assert.ok(plan.warnings.some((x: string) => /inventory_mode stays BASE/.test(x) && /بقي مستوى المخزون/.test(x) && /ئاستی کۆگا/.test(x)), JSON.stringify(plan.warnings));
});

test('(P) the purchase card’s preview of a dinar purchase carries what its confirm will (the same U)', async () => {
  const w = pricingWorld();
  await publishV2(w.raw, AMS);
  const manual = { cost_profile_id: undefined, cost_profile_version: undefined, shipping_rate_iqd: undefined };
  const line: Record<string, unknown> = { ...(w.draft().lines as Array<Record<string, unknown>>)[0]!, source_unit_amount: 720_000 };
  const draft = w.draft({ ...manual, currency: 'IQD', exchange_rate: 1, lines: [line] });
  const preview = await w.preview({ draft, pricing: { manual_line_opt_in: [`${line.product_id}:${line.scope}:${line.scope_id}`] } });
  const entries = (preview.body.products as Array<{ entries: Array<{ changes: Record<string, { after: unknown }> }> }>)[0]?.entries ?? [];
  assert.equal(entries[0]?.changes.supplier_cost_amount?.after, '450', JSON.stringify(preview.body).slice(0, 400));
  assert.equal(entries[0]?.changes.supplier_cost_currency?.after, 'USD');
});
