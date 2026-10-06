import test from 'node:test';
import assert from 'node:assert/strict';
import { changeLineCostProfile, changePurchaseCostMode, packedMeasureInput, packedMeasureValid, restoreCostProfileSnapshot, selectionCostDraft } from '../src/components/adminOperations/procurementCostDraft';
import { purchaseEstimate } from '../src/components/adminOperations/purchaseEstimate';
import type { Selection } from '../src/components/adminOperations/shared';
import type { CostProfile } from '../packages/contracts/src/procurementCost';

const germany: CostProfile = { id: 'germany_land', name_ar: 'ألمانيا بري', name_en: 'Germany land', currency: 'EUR', shipping_basis: 'weight', exchange_rate: 1626.25, shipping_rate_iqd: 5950, version: 7 };
const air: CostProfile = { ...germany, id: 'china_air', currency: 'CNY', exchange_rate: 200, shipping_rate_iqd: 12500 };
const selection: Selection = {
  product_id: 'printer', scope: 'variant', scope_id: 'combo-black', label: 'Printer combo black', sku: 'COMBO-BLACK', stock: 0, reserved: 0,
  selling_price_iqd: 2000000, purchase_unit_iqd: 1523129, unit_cost_iqd: 1523129, cost_source: 'catalogue', weight_g: 17000, volume_mm3: 80000000,
  packed_weight_g: 22300, packed_volume_mm3: 120000000,
  procurement_defaults: [{ profile_id: 'germany_land', currency: 'EUR', source_unit_amount: 855, weight_g: 22300, volume_mm3: 120000000, updated_at: '2026-10-06' }, { profile_id: 'china_air', currency: 'CNY', source_unit_amount: 6500, weight_g: 22400, volume_mm3: 125000000, updated_at: '2026-10-05' }],
};

test('new raw input never borrows catalogue or historical landed cost', () => {
  for (const cost_source of ['catalogue', 'confirmed_purchase', 'latest_purchase']) {
    const draft = selectionCostDraft({ ...selection, cost_source }, null);
    assert.equal(draft.source_unit_amount, '');
    assert.equal(draft.source_total_amount, '');
    assert.equal(draft.selling_price_iqd, 2000000);
    assert.equal(draft.purchase_unit_iqd, 1523129, 'reference remains available without being used as input');
  }
});

test('raw defaults belong to the exact selection and supplier route', () => {
  const draft = selectionCostDraft(selection, 'germany_land', 3);
  assert.equal(draft.source_unit_amount, 855);
  assert.equal(draft.source_total_amount, 2565);
  assert.equal(draft.weight_g, 22300);
  assert.equal(draft.cost_source, 'procurement_default');
  const another = selectionCostDraft({ ...selection, scope_id: 'combo-white', procurement_defaults: [] }, 'germany_land');
  assert.equal(another.source_unit_amount, '');
  const sea = selectionCostDraft(selection, 'china_sea');
  assert.equal(sea.source_unit_amount, '', 'air price is never reused for sea');
});

test('profile changes load its own raw amount and packed measurements while preserving quantity mode', () => {
  const draft = { ...selectionCostDraft(selection, 'germany_land', 3), invoiced_qty: 2, purchase_cost_mode: 'total' as const, source_unit_amount: 900 };
  const changed = changeLineCostProfile(draft, air);
  assert.equal(changed.source_unit_amount, 6500, 'EUR input was not reinterpreted as CNY');
  assert.equal(changed.source_total_amount, 19500);
  assert.equal(changed.weight_g, 22400);
  assert.equal(changed.qty_ordered, 3);
  assert.equal(changed.invoiced_qty, 2);
  assert.equal(changed.purchase_cost_mode, 'total');
  assert.equal(changeLineCostProfile(changed, null).source_unit_amount, '');
});

test('a total-only supplier invoice can remember packing without inventing a rounded raw unit price', () => {
  const next = selectionCostDraft({ ...selection, procurement_defaults: [{ ...selection.procurement_defaults![0], source_unit_amount: null, weight_g: 24000 }] }, 'germany_land', 3);
  assert.equal(next.source_unit_amount, '');
  assert.equal(next.source_total_amount, '');
  assert.equal(next.cost_source, 'unknown');
  assert.equal(next.cost_date, null);
  assert.equal(next.weight_g, 24000);
});

test('packed measurement fallback never treats net product measurements as carton measurements', () => {
  const draft = selectionCostDraft({ ...selection, procurement_defaults: [], packed_weight_g: null, packed_volume_mm3: null }, 'germany_land');
  assert.equal(draft.weight_g, 0);
  assert.equal(draft.volume_mm3, 0);
  assert.equal(packedMeasureValid(draft, 'weight'), false);
  assert.equal(packedMeasureInput('22.3', 'weight'), 22300);
  assert.equal(packedMeasureInput('0.123456789', 'volume'), 123456789);
  assert.ok(Number.isNaN(packedMeasureInput('', 'weight')));
});

test('restoring a historical local draft preserves manual economics without inheriting a profile', () => {
  const old = { currency: 'IQD', exchange_rate: 1 };
  const restored = restoreCostProfileSnapshot(old, [germany]);
  assert.equal(restored.currency, 'IQD');
  assert.equal(restored.exchange_rate, 1);
  assert.equal(restored.cost_profile_id, null);
  assert.equal(restored.shipping_rate_iqd, null);
  assert.equal(restored.cost_profile_version, null);
});

test('editing preserves its snapshot rates and refreshes only the concurrency token (a copy is priced at current rates: procurementCharges.test.ts)', () => {
  const restored = restoreCostProfileSnapshot({ cost_profile_id: germany.id, cost_profile_version: 2, currency: 'EUR', exchange_rate: 1500, shipping_rate_iqd: 5000, shipping_basis: 'weight' as const }, [germany]);
  assert.equal(restored.cost_profile_version, 7);
  assert.equal(restored.exchange_rate, 1500);
  assert.equal(restored.shipping_rate_iqd, 5000);
  assert.equal(restored.currency, 'EUR');
});

test('855 EUR and 22.3 kg produce the requested separated landed total', () => {
  const [result] = purchaseEstimate([selectionCostDraft(selection, 'germany_land')], [], 1626.25, 0, undefined, { basis: 'weight', rate: 5950 });
  assert.equal(result.purchase_iqd, 1390444);
  assert.equal(result.auto_shipping_iqd, 132685);
  assert.equal(result.freight_iqd, 132685);
  assert.equal(result.unit_iqd, 1523129);
  assert.equal(result.total_iqd, 1523129);
});

test('new profile raw amounts round after multiplying quantity, preserving small unit values', () => {
  const line = { ...selectionCostDraft(selection, 'germany_land', 50000), source_unit_amount: 0.01 };
  const [profile] = purchaseEstimate([line], [], 1, 0, undefined, { basis: 'weight', rate: 0 });
  const [legacy] = purchaseEstimate([line], [], 1, 0);
  assert.equal(profile.purchase_iqd, 500);
  assert.equal(legacy.purchase_iqd, 0, 'manual historical rounding remains unchanged');
});

test('total input uses the original foreign invoice amount independently of its unit average', () => {
  const line = { ...selectionCostDraft(selection, 'china_air', 3), purchase_cost_mode: 'total', source_unit_amount: 0.003333, source_total_amount: 0.01 };
  const [result] = purchaseEstimate([line], [], 150, 0, undefined, { basis: 'weight', rate: 0 });
  assert.equal(result.purchase_iqd, 2);
  assert.equal(result.total_iqd, 2);
  assert.equal(result.unit_iqd, 2 / 3);
});

test('a repeating invoice average clears unit input and toggling back restores the exact invoice total', () => {
  const original = { ...selectionCostDraft(selection, 'china_air', 3), purchase_cost_mode: 'total' as const, source_total_amount: 1 };
  const unit = changePurchaseCostMode(original, 'unit');
  assert.equal(unit.source_unit_amount, '');
  assert.equal(unit.unit_conversion_inexact, true);
  const restored = changePurchaseCostMode(unit, 'total');
  assert.equal(restored.source_total_amount, 1);
  const [result] = purchaseEstimate([restored], [], 235.5, 0, undefined, { basis: 'weight', rate: 0 });
  assert.equal(result.purchase_iqd, 236);
  const exact = changePurchaseCostMode({ ...original, source_total_amount: 1.5 }, 'unit');
  assert.equal(exact.source_unit_amount, 0.5);
  assert.equal(exact.unit_conversion_inexact, false);
  const wholeDinars = changePurchaseCostMode({ ...original, qty_ordered: 2, source_total_amount: 1 }, 'unit', 0);
  assert.equal(wholeDinars.source_unit_amount, '', 'IQD input cannot conceal a half-dinar unit price');
  assert.equal(changePurchaseCostMode(wholeDinars, 'total', 0).source_total_amount, 1);
});

test('unit to total input does not introduce binary-decimal errors at an FX half boundary', () => {
  const unit = { ...selectionCostDraft(selection, 'china_air', 3), source_unit_amount: 0.7 };
  const total = changePurchaseCostMode(unit, 'total');
  assert.equal(total.source_total_amount, 2.1);
  const [result] = purchaseEstimate([total], [], 5, 0, undefined, { basis: 'weight', rate: 0 });
  assert.equal(result.purchase_iqd, 11);
});

test('sea freight uses packed CBM and adds extra fees exactly once', () => {
  const lines = [selectionCostDraft(selection, 'china_air', 2), selectionCostDraft(selection, 'germany_land')];
  const results = purchaseEstimate(lines, [{ amount_iqd: 1001, basis: 'quantity' }], 200, 3500, [0], { basis: 'volume', rate: 300000 });
  assert.equal(results[0].auto_shipping_iqd, 75000);
  assert.equal(results[1].auto_shipping_iqd, 36000);
  assert.equal(results[0].freight_iqd, 75000 + 667);
  assert.equal(results[1].freight_iqd, 36000 + 334);
  assert.equal(results[1].investor_iqd, 0, 'funding selection is retained');
  assert.equal(results.reduce((sum, r) => sum + r.freight_iqd, 0), 112001);
});

test('incomplete or unsafe profile drafts render an invalid estimate instead of throwing or saving zero', () => {
  const base = selectionCostDraft(selection, 'germany_land');
  for (const line of [{ ...base, source_unit_amount: '' }, { ...base, source_unit_amount: -1 }, { ...base, weight_g: 0 }, { ...base, weight_g: NaN }, { ...base, source_unit_amount: 1e12 }]) {
    const [result] = purchaseEstimate([line], [], 1626.25, 0, undefined, { basis: 'weight', rate: 5950 });
    assert.ok(Number.isNaN(result.total_iqd));
  }
  for (const rate of [NaN, -1]) {
    const [result] = purchaseEstimate([base], [], 1626.25, 0, undefined, { basis: 'weight', rate });
    assert.ok(Number.isNaN(result.total_iqd));
  }
  const [missingFx] = purchaseEstimate([base], [], NaN, 0, undefined, { basis: 'weight', rate: 5950 });
  assert.ok(Number.isNaN(missingFx.total_iqd));
});

test('missing extra-charge allocation measurements invalidate totals without crashing the editor', () => {
  const line = { ...selectionCostDraft(selection, 'germany_land'), volume_mm3: 0 };
  const [result] = purchaseEstimate([line], [{ amount_iqd: 500, basis: 'volume' }], 1626.25, 0, undefined, { basis: 'weight', rate: 5950 });
  assert.ok(Number.isNaN(result.total_iqd));
});
