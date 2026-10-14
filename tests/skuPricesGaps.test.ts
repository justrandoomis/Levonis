/**
 * FX-7 GAPS (DECISIONS row 202; migration 0183's SKU rung) — the four the
 * review listed, each against the real routes, the real engine writer and the
 * cart's own resolver on a real database with the 41 census products, at the
 * brief's rates (1 USD = 1,600 IQD; China sea 400,000 IQD per CBM; Germany land
 * 3,200 IQD per kg). Proves:
 *   1. one figure per product or model reads the rung as the cart does: the
 *      comparison's and the printer finder's model is «from» its lowest SKU
 *      (never the model's highest, which the ladder beneath the rung holds),
 *      the listing card is «from» the lowest sellable SKU, and the admin quote
 *      preview prices a whole selection (one value per group) at its SKU's own
 *      price;
 *   2. a failed read of the SKU prices is not a missing table: the overlay says
 *      so; back to manual pricing, an engine save (a per-model one included) and
 *      the bulk save refuse PRICING_READ_FAILED (503, retryable) and write
 *      nothing; the automatic repricing skips the product without blocking it
 *      and reprices it on the next good read;
 *   3. a product with no option whose colours are gone: its orphaned colour
 *      inputs are dropped from the plan — it is priced as the product itself
 *      again, no SKU row under an empty key, the old SKU rows removed;
 *   4. purchase lines per variant (and per colour) feed direct pricing at that
 *      variant's (that colour's) level as well as the model's (the product's): only where
 *      the purchase differs from what the level inherits, never above the
 *      owner's pricing weight, never with route freight (the double-freight
 *      guard); preorder stays unchanged; without 0183 the preview stays per model.
 *
 * THE CLEAN START (spec addendum A.6, A.12.2; DECISIONS row 222): 1–3 and the
 * purchase-variant half of 4 drove the V1 writer through its closed doors and
 * went with it; what stays is 4's pure colour-level derivation.
 *
 * Run: node --import tsx --test tests/skuPricesGaps.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveProductEntries, type PurchaseForPricing, type PurchaseSkuLevels } from '../worker/lib/pricingEngine/fromPurchase';
import { type ProductPricingData, type StoredInputRow } from '../worker/lib/pricingEngine/store';

// ------------------------------------------------------------- 1. one figure reads the rung

// ------------------------------------------------------------- 2. a failed read is not a missing table

// ------------------------------------------------------------- 3. orphaned colour inputs

// ------------------------------------------------------------- 4. purchase lines per variant / colour

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

/** A colour-only product: three colours, each one sellable SKU. */
const COLOUR_LEVELS: PurchaseSkuLevels = {
  color: new Set(['c1', 'c2', 'c3']),
  sku: new Set(['c:c1', 'c:c2', 'c:c3']),
  variants: new Map(),
  units: ['c1', 'c2', 'c3'].map((c) => ({ option_value_ids: [], color_id: c, combo_key: `c:${c}` })),
};

/** Germany land, EUR: colour c1 at 450 (2.0 kg) and c2 at 500 (3.0 kg); freight on both, packaging per colour. */
const colourLines = (): PurchaseForPricing => ({
  purchase_id: 'po_colour_gaps',
  status: 'ordered',
  cost_state: 'final',
  currency: 'EUR',
  exchange_rate: 1760,
  profile: { id: 'germany_land', shipping_basis: 'weight' },
  lines: [
    { index: 0, line_id: null, key: 'p1:color:c1', product_id: 'p1', scope: 'color', scope_id: 'c1', option_id: null, label: 'c1', qty: 1, cost_mode: 'unit', source_amount: 450, weight_g: 2000, volume_mm3: 0, store_price_iqd: null },
    { index: 1, line_id: null, key: 'p1:color:c2', product_id: 'p1', scope: 'color', scope_id: 'c2', option_id: null, label: 'c2', qty: 1, cost_mode: 'unit', source_amount: 500, weight_g: 3000, volume_mm3: 0, store_price_iqd: null },
  ],
  charges: [
    { title: 'شحن محلي', pricing_role: 'excluded', shares: [{ index: 0, amount_iqd: 16_000 }, { index: 1, amount_iqd: 16_000 }] },
    { title: 'تغليف أ', pricing_role: 'additional', shares: [{ index: 0, amount_iqd: 3_000 }] },
    { title: 'تغليف ب', pricing_role: 'additional', shares: [{ index: 1, amount_iqd: 5_000 }] },
  ],
});

test('purchase lines per colour feed the colour’s own level: what differs from the inherited value, never route freight (the double-freight guard), never above the owner’s pricing weight', () => {
  const stored = storedWith([{ supplier_cost_amount: '500', supplier_cost_currency: 'EUR', supplier_input_mode: 'SOURCE_CURRENCY', shipping_weight_g: 3000 }]);
  const d = deriveProductEntries(colourLines(), 'p1', stored, { optIn: new Set(), prefer: false, usePurchase: true, rates: null, levels: COLOUR_LEVELS });
  const at = (scope: string, id: string) => d.entries.find((e) => e.write.scope === scope && e.write.scope_id === id)!;
  // The product (narrow, never lower): its supplier and weight kept, the packaging maximum taken.
  assert.equal(at('base', '').narrow, true);
  assert.equal(at('base', '').write.set.supplier_cost_amount, undefined);
  assert.equal(at('base', '').write.set.additional_cost_iqd, 5_000);
  // c1 differs from what it inherits (500 EUR, 3 kg, 5,000): its own values; the freight never.
  assert.deepEqual(at('color', 'c1').write.set, { supplier_cost_amount: '450', supplier_cost_currency: 'EUR', shipping_weight_g: 2000, additional_cost_iqd: 3_000 });
  assert.equal(at('color', 'c1').narrow, false);
  // c2 is exactly what it inherits: it keeps inheriting.
  assert.deepEqual(at('color', 'c2').write.set, {});
  for (const e of d.entries) assert.notEqual(e.write.set.additional_cost_iqd, 16_000, 'route freight never feeds pricing');
  assert.deepEqual(d.proposals, [], 'no profile proposed at a colour (the product resolves one)');

  // The owner's pricing weight decides above the colour: the purchase's shipping weight is not written there.
  const weighed = storedWith([{ supplier_cost_amount: '500', supplier_cost_currency: 'EUR', supplier_input_mode: 'SOURCE_CURRENCY', shipping_weight_g: 3000, pricing_weight_g: 3500 }]);
  const w2 = deriveProductEntries(colourLines(), 'p1', weighed, { optIn: new Set(), prefer: false, usePurchase: true, rates: null, levels: COLOUR_LEVELS });
  assert.equal(w2.entries.find((e) => e.write.scope === 'color' && e.write.scope_id === 'c1')!.write.set.shipping_weight_g, undefined);
  assert.ok(w2.shadowed.some((x) => x.scope === 'color' && x.scope_id === 'c1' && x.field === 'shipping_weight_g'), JSON.stringify(w2.shadowed));

  // A colour with its own row: replaced exactly (the purchase priced that colour).
  const own = storedWith([
    { supplier_cost_amount: '500', supplier_cost_currency: 'EUR', supplier_input_mode: 'SOURCE_CURRENCY', shipping_weight_g: 3000 },
    { scope: 'color', scope_id: 'c2', supplier_cost_amount: '520', supplier_cost_currency: 'EUR', supplier_input_mode: 'SOURCE_CURRENCY', shipping_profile: null },
  ]);
  const d3 = deriveProductEntries(colourLines(), 'p1', own, { optIn: new Set(), prefer: false, usePurchase: true, rates: null, levels: COLOUR_LEVELS });
  assert.equal(d3.entries.find((e) => e.write.scope === 'color' && e.write.scope_id === 'c2')!.write.set.supplier_cost_amount, '500');

  // Without the SKU rung (no levels): the product's scope alone, exactly as before.
  const before = deriveProductEntries(colourLines(), 'p1', stored, { optIn: new Set(), prefer: false, usePurchase: true, rates: null });
  assert.deepEqual(before.entries.map((e) => e.write.scope), ['base']);
});
