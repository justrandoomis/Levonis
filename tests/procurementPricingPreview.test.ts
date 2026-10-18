/**
 * THE PROCUREMENT CARD'S PRICING (USD design §3, §5, §12 P-C;
 * owner brief 2026-10-09): `POST /api/admin/pricing/procurement/preview` and
 * the server-side mapping of a purchase into the product's current costs
 * (worker/lib/pricingEngine/fromPurchase.ts, procurementPreview.ts).
 *
 * Run: node --import tsx --test tests/procurementPricingPreview.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeFreight } from '../packages/contracts/src/procurementCost';
import { looksLikeFreight as clientLooksLikeFreight } from '../src/components/adminOperations/procurementCharges';
import { deriveProductEntries, supplierUnitText, type PurchaseForPricing } from '../worker/lib/pricingEngine/fromPurchase';
import type { ProductPricingData, StoredInputRow } from '../worker/lib/pricingEngine/store';
import { row } from './fixtures/app';
import { pricingWorld, AMS, AMS_MODEL } from './fixtures/procurementPricing';

const KEY = `${AMS}:option:${AMS_MODEL}`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a JSON answer walked by key
type Answer = Record<string, any>;
const summaryOf = (body: Answer, i = 0) => body.lines[i].pricing_summary;
const productOf = (body: Answer) => body.products[0];

test('the summary is the cost at the CENTRAL rates — the brief’s $500 / +$120, never the document’s rates — and no price of the old engine', async () => {
  const w = pricingWorld();
  // The document says 1,800 IQD/EUR and 5,000 IQD/kg; the central rates are EUR 1.1 × 1,600 and 3,200 IQD/kg.
  const r = await w.preview({ draft: w.draft({ exchange_rate: 1800 }), pricing: { minimum_profits: [{ product_id: AMS, scope: 'product', amount_usd: '120' }] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.headers.get('cache-control') ?? '', /no-store/);
  const s = summaryOf(r.body);
  assert.equal(s.state, 'ok');
  assert.equal(s.current_total_cost_cents, 50_000);
  assert.equal(s.target_profit_cents, 12_000);
  // The clean start (review 2026-10-14): the card shows no price of the old engine — the V2 review in
  // section ٣ is the one price sheet; the store price is the V2 one (null: the product needs pricing).
  for (const k of ['final_price_cents', 'final_price_usd', 'preorder_base_iqd', 'direct_sale_extra_iqd', 'direct_sale_price_iqd', 'rounding_added_iqd', 'store_price_iqd']) assert.equal(s[k], null, k);
  assert.equal(s.shipping_cost_iqd, 8_000, 'the central 3,200 IQD/kg, not the document’s 5,000');
  assert.equal(s.document_rate, '1800', 'N1 names the document’s own rate when it differs');
  assert.equal(s.cross_rate, '1.1');
  assert.equal(s.usd_iqd_rate, '1600');
  // «تفاصيل»: the 13 items are all there, and rows 4 + 7 + 8 = row 9 in cents.
  for (const k of ['supplier_original_amount', 'supplier_original_currency', 'cross_rate', 'supplier_cost_cents', 'effective_weight_g', 'shipping_cost_iqd', 'shipping_cost_cents', 'additional_cost_iqd', 'current_total_cost_cents', 'minimum_target_profit_usd', 'usd_iqd_rate'])
    assert.ok(s[k] !== undefined && s[k] !== null, k);
  assert.equal(s.supplier_cost_cents + s.shipping_cost_cents + s.additional_cost_cents, s.current_total_cost_cents);
  assert.equal(s.engine_priced, false, 'a manual product: the bar says «السعر المقترح للزبون»');
  // The preview writes nothing.
  assert.equal(row<{ n: number }>(w.raw, 'SELECT COUNT(*) AS n FROM pricing_inputs')!.n, 0);
  assert.equal(row<{ n: number }>(w.raw, 'SELECT COUNT(*) AS n FROM purchase_orders')!.n, 0);
});

test('the card freights a model on its own package, as V2 prices it (row 247): 1,200 g, never the purchase’s 2,500 g', async () => {
  const w = pricingWorld();
  w.raw.exec(`UPDATE product_option_values SET package_weight_g = 1200 WHERE id = '${AMS_MODEL}'`);
  const r = await w.preview({ draft: w.draft(), pricing: { minimum_profits: [{ product_id: AMS, scope: 'product', amount_usd: '120' }] } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = summaryOf(r.body);
  assert.equal(s.effective_weight_g, 1200);
  assert.equal(s.shipping_cost_iqd, 3_840, 'the central 3,200 IQD/kg × 1.2 kg');
});

test('the freight words: the shared regex catches «گواستنەوە» and «ناردن», and the editor re-exports it', () => {
  for (const t of ['شحن محلي', 'freight', 'Shipping fee', 'بارکردن', 'کرێی گواستنەوە', 'تێچووی ناردن']) assert.equal(looksLikeFreight(t), true, t);
  for (const t of ['شحنة', 'customs', 'تغليف', 'packaging']) assert.equal(looksLikeFreight(t), false, t);
  assert.equal(clientLooksLikeFreight, looksLikeFreight);
});

test('a freight-looking charge on a routed document is left out of pricing until the owner says it is not freight', async () => {
  const w = pricingWorld();
  const charge = { title: 'شحن محلي', scope: 'unit', unit_amount_iqd: 16_000, basis: 'quantity', applies_to: null };
  const pricing = { minimum_profits: [{ product_id: AMS, scope: 'product', amount_usd: '120' }] };
  const out = await w.preview({ draft: w.draft({ charges: [charge] }), pricing });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.deepEqual(summaryOf(out.body).excluded_charges, ['شحن محلي']);
  assert.equal(summaryOf(out.body).additional_cost_iqd, 0);
  assert.equal(productOf(out.body).entries[0].changes.additional_cost_iqd, undefined);

  const counted = await w.preview({ draft: w.draft({ charges: [{ ...charge, pricing_role: 'additional' }] }), pricing });
  assert.deepEqual(summaryOf(counted.body).excluded_charges, []);
  assert.equal(summaryOf(counted.body).additional_cost_iqd, 16_000);
  assert.equal(productOf(counted.body).entries[0].changes.additional_cost_iqd.after, 16_000);

  // A charge that does not look like freight counts by default; the saved row carries its role.
  const id = await w.save(w.draft({ charges: [{ ...charge, title: 'تغليف' }, charge] }));
  const roles = (w.raw.prepare('SELECT title, pricing_role FROM purchase_charges WHERE purchase_id = ? ORDER BY position').all(id) as Array<{ title: string; pricing_role: string }>).map((r) => [r.title, r.pricing_role]);
  assert.deepEqual(roles, [['تغليف', 'additional'], ['شحن محلي', 'excluded']]);
});

test('a manual document feeds only the supplier cost of a line the owner ticked', async () => {
  const w = pricingWorld();
  const manual = {
    operation_id: 'op_manual_0000000001',
    currency: 'USD',
    exchange_rate: 1500,
    status: 'ordered',
    cost_state: 'final',
    lines: [{ product_id: AMS, scope: 'option', scope_id: AMS_MODEL, qty_ordered: 1, source_unit_amount: 300, weight_g: 2500, volume_mm3: 0 }],
    charges: [],
  };
  const off = await w.preview({ draft: manual });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(productOf(off.body).feeds, false);
  assert.deepEqual(productOf(off.body).entries, []);
  const on = await w.preview({ draft: manual, pricing: { manual_line_opt_in: [KEY] } });
  const entry = productOf(on.body).entries[0];
  assert.deepEqual(Object.keys(entry.changes).sort(), ['supplier_cost_amount', 'supplier_cost_currency']);
  assert.equal(entry.changes.supplier_cost_amount.after, '300');
  assert.equal(entry.changes.supplier_cost_currency.after, 'USD');
});

test('field mapping: fractional grams round UP; a weight route’s allocation CBM never feeds; a zero supplier price is not written', async () => {
  const w = pricingWorld();
  const r = await w.preview({ draft: w.draft({ lines: [{ product_id: AMS, scope: 'option', scope_id: AMS_MODEL, qty_ordered: 2, source_unit_amount: 450, weight_g: 2500.4, volume_mm3: 30_000_000 }] }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const changes = productOf(r.body).entries[0].changes;
  assert.equal(changes.shipping_weight_g.after, 2501);
  assert.equal(changes.manual_cbm, undefined);
  const zero = await w.preview({ draft: w.draft({ lines: [{ product_id: AMS, scope: 'option', scope_id: AMS_MODEL, qty_ordered: 2, source_unit_amount: 0, weight_g: 2500, volume_mm3: 0 }] }) });
  assert.equal(zero.status, 200, JSON.stringify(zero.body));
  assert.equal(productOf(zero.body).entries[0].changes.supplier_cost_amount, undefined);
});

test('total mode: an exact unit is kept; an inexact one is rounded UP at 6 places (never to nearest)', () => {
  assert.equal(supplierUnitText({ cost_mode: 'total', source_amount: 900, qty: 2 }), '450');
  assert.equal(supplierUnitText({ cost_mode: 'total', source_amount: 1000, qty: 3 }), '333.333334');
  assert.equal(supplierUnitText({ cost_mode: 'unit', source_amount: 1.0000001, qty: 1 }), '1.000001');
  assert.equal(supplierUnitText({ cost_mode: 'unit', source_amount: 0, qty: 1 }), null);
});

// ---------------------------------------------------------------- pure mapping

const storedWith = (rows: Array<Partial<StoredInputRow>>): ProductPricingData => ({
  product_id: 'p1',
  state: null,
  config_version: 0,
  rules: [],
  inputs: rows.map((r) => ({
    product_id: 'p1', scope: 'base', scope_id: '', origin: 'MANUAL_OVERRIDE', supplier_cost_amount: null, supplier_cost_delta: null,
    supplier_cost_currency: null, supplier_input_mode: null, original_input_amount: null, original_input_currency: null,
    conversion_rate_snapshot: null, conversion_fx_version: null, canonical_supplier_cost_usd: null, converted_at: null,
    shipping_profile: 'GERMANY_LAND', pricing_weight_g: null, shipping_weight_g: null, shipping_length_mm: null, shipping_width_mm: null,
    shipping_height_mm: null, manual_cbm: null, additional_cost_iqd: null, unresolved_fields: '[]', source_ref: '', version: 1, updated_at: '',
    ...r,
  })) as StoredInputRow[],
});

const colourPurchase = (amount: number, weight: number): PurchaseForPricing => ({
  purchase_id: 'po_colour_0001',
  status: 'ordered',
  cost_state: 'final',
  currency: 'EUR',
  exchange_rate: 1760,
  profile: { id: 'germany_land', shipping_basis: 'weight' },
  lines: [{ index: 0, line_id: null, key: 'p1:color:c1', product_id: 'p1', scope: 'color', scope_id: 'c1', option_id: null, label: 'x', qty: 1, cost_mode: 'unit', source_amount: amount, weight_g: weight, volume_mm3: 0, store_price_iqd: null }],
  charges: [],
});

test('a colour line only seeds the product’s value (row 249): never lowered, never raised, unless the owner prefers this purchase', () => {
  const stored = storedWith([{ supplier_cost_amount: '500', supplier_cost_currency: 'EUR', supplier_input_mode: 'SOURCE_CURRENCY', shipping_weight_g: 3000 }]);
  const lower = deriveProductEntries(colourPurchase(400, 2000), 'p1', stored, { optIn: new Set(), prefer: false, usePurchase: true, rates: null });
  const e = lower.entries[0]!;
  assert.equal(e.narrow, true);
  assert.equal(e.write.scope, 'base');
  assert.equal(e.write.set.supplier_cost_amount, undefined);
  assert.equal(e.write.set.shipping_weight_g, undefined);
  assert.deepEqual([...e.kept_higher].sort(), ['shipping_weight_g', 'supplier_cost_amount']);
  const preferred = deriveProductEntries(colourPurchase(400, 2000), 'p1', stored, { optIn: new Set(), prefer: true, usePurchase: true, rates: null });
  assert.equal(preferred.entries[0]!.write.set.supplier_cost_amount, '400');
  assert.equal(preferred.entries[0]!.write.set.shipping_weight_g, 2000);
  // Row 249: a costlier colour never raises what every other colour inherits (its own level carries it).
  const higher = deriveProductEntries(colourPurchase(600, 4000), 'p1', stored, { optIn: new Set(), prefer: false, usePurchase: true, rates: null });
  assert.equal(higher.entries[0]!.write.set.supplier_cost_amount, undefined);
  assert.equal(higher.entries[0]!.write.set.shipping_weight_g, undefined);
  assert.deepEqual([...higher.entries[0]!.kept_higher].sort(), ['shipping_weight_g', 'supplier_cost_amount']);
  // A product with nothing stored yet is seeded by the colour's purchase.
  const seeded = deriveProductEntries(colourPurchase(600, 4000), 'p1', storedWith([]), { optIn: new Set(), prefer: false, usePurchase: true, rates: null });
  assert.equal(seeded.entries[0]!.write.set.supplier_cost_amount, '600');
  assert.equal(seeded.entries[0]!.write.set.shipping_weight_g, 4000);
  // «استعمل هذا الشراء» unticked: nothing at all.
  assert.deepEqual(deriveProductEntries(colourPurchase(600, 4000), 'p1', stored, { optIn: new Set(), prefer: false, usePurchase: false, rates: null }).entries, []);
});

test('shadowing: a product-level value a model’s own row holds is listed as not used in the price', () => {
  const stored = storedWith([{ scope: 'option', scope_id: 'o1', supplier_cost_amount: '700', supplier_cost_currency: 'EUR', supplier_input_mode: 'SOURCE_CURRENCY' }]);
  const p: PurchaseForPricing = { ...colourPurchase(400, 2000), lines: [{ ...colourPurchase(400, 2000).lines[0]!, key: 'p1:base:', scope: 'base', scope_id: '' }] };
  const d = deriveProductEntries(p, 'p1', stored, { optIn: new Set(), prefer: false, usePurchase: true, rates: null });
  assert.ok(d.shadowed.some((x) => x.scope === 'base' && x.field === 'supplier_cost_amount'), JSON.stringify(d.shadowed));
});

// ---------------------------------------------------------------- a stock purchase is reviewed for direct sale (owner request 2026-10-10)

const extra = (amount_iqd: unknown, over: Record<string, unknown> = {}) => ({ product_id: AMS, scope: 'product', scope_id: '', amount_iqd, ...over });

test('the clean start: a typed Direct Sale Extra is refused by name (PRICING_V2_FEES_RETIRED), and none is ever suggested', async () => {
  const w = pricingWorld();
  const r = await w.preview({ draft: w.draft(), pricing: { direct_sale_extras: [extra(1000)] } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'PRICING_V2_FEES_RETIRED');
  assert.equal(r.body.details.field, 'direct_sale_extras');
  assert.ok(!JSON.stringify(r.body).includes('1000'), 'the refusal never repeats the value');
  const look = await w.preview({ draft: w.draft() });
  assert.equal(look.status, 200, JSON.stringify(look.body));
  assert.deepEqual(productOf(look.body).extra_suggestions, [], 'no Direct Sale Extra is suggested from the old prices');
  assert.deepEqual(productOf(look.body).direct_sale_extras, []);
  assert.deepEqual(productOf(look.body).rows, [], 'no per-model price of the old engine');
});
