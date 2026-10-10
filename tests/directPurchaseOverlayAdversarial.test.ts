import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directPurchaseStore, nextDirectPurchase, directPurchaseStatement, pruneDirectPurchase } from '../worker/lib/pricingEngine/directPurchase';
import { INPUT_FIELD_NAMES, batchHead, batchTail, inputStatements, loadProductPricing, type InputWrite, type ProductPricingData, type StoredInputRow } from '../worker/lib/pricingEngine/store';
import { resolveSkuInputs } from '../packages/pricing/src/costToPrice';
import { chainOf } from '../worker/lib/pricingEngine/store';
import { asD1, dbThrough, stubApp } from './fixtures/app';
import { pricingWorld, AMS } from './fixtures/procurementPricing';
import { templateRoutes } from '../worker/routes/template';
import { apply, download, edit, preview, OWNER } from './fixtures/dataFile';

function convertedStore(): ProductPricingData {
  const input: StoredInputRow = {
    ...Object.fromEntries(INPUT_FIELD_NAMES.map(k => [k, null])),
    product_id: 'part', scope: 'base', scope_id: '', origin: 'MANUAL_OVERRIDE',
    supplier_cost_amount: '100', supplier_cost_currency: 'USD', supplier_input_mode: 'IQD_CONVERTED',
    original_input_amount: '150000', original_input_currency: 'IQD', conversion_rate_snapshot: '1500',
    conversion_fx_version: 1, canonical_supplier_cost_usd: '100', converted_at: '2026-10-01T00:00:00Z',
    shipping_weight_g: 1000, shipping_profile: 'GERMANY_LAND',
    unresolved_fields: '[]', source_ref: 'owner', version: 1, updated_at: '2026-10-01T00:00:00Z',
  } as StoredInputRow;
  return { product_id: 'part', state: null, inputs: [input], rules: [], config_version: 1 };
}
function overlay(s: ProductPricingData, set: InputWrite['set']) {
  const w: InputWrite = { scope: 'base', scope_id: '', existing: s.inputs[0]!, set, source_ref: 'purchase:stock-shipment' };
  return directPurchaseStore(s, nextDirectPurchase(s, [w], []));
}

test('direct supplier replacement clears obsolete IQD conversion provenance while preorder keeps its snapshot', () => {
  const s = convertedStore();
  const direct = overlay(s, { supplier_cost_amount: '120', supplier_cost_currency: 'EUR' });
  const row = direct.inputs[0]!;
  assert.deepEqual(resolveSkuInputs(chainOf(direct.inputs, '')).inputs.supplier, { amount: '120', currency: 'EUR', amount_level: 'base' });
  assert.equal(row.supplier_input_mode, 'SOURCE_CURRENCY');
  for (const key of ['original_input_amount', 'original_input_currency', 'conversion_rate_snapshot', 'conversion_fx_version', 'canonical_supplier_cost_usd', 'converted_at'] as const)
    assert.equal(row[key], null, `obsolete ${key} must not describe the newly purchased supplier cost`);
  assert.equal(s.inputs[0]!.canonical_supplier_cost_usd, '100');
  assert.equal(s.inputs[0]!.supplier_input_mode, 'IQD_CONVERTED');
});

test('a direct shipping-only patch preserves the unchanged supplier IQD conversion snapshot', () => {
  const s = convertedStore();
  const direct = overlay(s, { shipping_weight_g: 2000 });
  assert.equal(direct.inputs[0]!.shipping_weight_g, 2000);
  assert.equal(direct.inputs[0]!.supplier_input_mode, 'IQD_CONVERTED');
  assert.equal(direct.inputs[0]!.original_input_amount, '150000');
  assert.equal(direct.inputs[0]!.canonical_supplier_cost_usd, '100');
  assert.equal(direct.inputs[0]!.conversion_rate_snapshot, '1500');
  assert.equal(s.inputs[0]!.shipping_weight_g, 1000);
});

test('ordinary supplier edits permanently clear supplier patches while retaining unrelated shipping patches', () => {
  const original = convertedStore();
  const stock: InputWrite = { scope: 'base', scope_id: '', existing: original.inputs[0]!, set: { supplier_cost_amount: '120', supplier_cost_currency: 'USD', shipping_weight_g: 2000 }, source_ref: 'purchase:shipment' };
  const s = { ...original, direct_purchase: nextDirectPurchase(original, [stock], []) };
  const write: InputWrite = { ...stock, set: { supplier_cost_amount: '130' }, source_ref: 'owner' };
  const pruned = pruneDirectPurchase(s, [write], []);
  assert.ok(pruned);
  assert.deepEqual(pruned.inputs[0]!.set, { shipping_weight_g: 2000 });
  const restored = { ...original, direct_purchase: pruned };
  const effective = directPurchaseStore(restored);
  assert.equal(effective.inputs[0]!.supplier_cost_amount, '100', 'restoring the original normal input must not revive purchased120');
  assert.equal(effective.inputs[0]!.shipping_weight_g, 2000);
});

test('an older schema reads ordinary inputs with no direct overlay; transient overlay reads fail closed', async () => {
  const db = asD1(dbThrough('0185'));
  const s = await loadProductPricing(db, 'missing-product');
  assert.equal(s.direct_purchase_available, false);
  assert.equal(s.direct_purchase, null);
  const failing = new Proxy(db, { get(target, key) {
    if (key === 'prepare') return (sql: string) => {
      if (sql.includes('FROM pricing_direct_purchase')) throw new Error('database temporarily unavailable');
      return target.prepare(sql);
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  }});
  await assert.rejects(loadProductPricing(failing, 'missing-product'), /temporarily unavailable/);
});

test('data-only product-file updates prune direct supplier patches in the same fenced batch and never revive them', async () => {
  const w = pricingWorld();
  const app = stubApp(w.db, OWNER, a => a.route('/api/admin/template', templateRoutes));
  const empty = await loadProductPricing(w.db, AMS);
  const now = new Date().toISOString();
  await w.db.batch([...batchHead(w.db, empty, now), ...inputStatements(w.db, AMS, [{ scope: 'base', scope_id: '', existing: null, set: { supplier_cost_amount: '100', supplier_cost_currency: 'USD' }, source_ref: 'owner' }], OWNER.id, now), ...batchTail(w.db, AMS)]);
  const before = await loadProductPricing(w.db, AMS);
  const stock = nextDirectPurchase(before, [{ scope: 'base', scope_id: '', existing: before.inputs[0]!, set: { supplier_cost_amount: '120', supplier_cost_currency: 'USD' }, source_ref: 'purchase:shipment' }], []);
  const staleWrite = [...batchHead(w.db, before, now), directPurchaseStatement(w.db, before, stock, OWNER.id, now), ...batchTail(w.db, AMS)];
  await w.db.batch(staleWrite);
  await assert.rejects(w.db.batch(staleWrite), /CHECK|UNIQUE/, 'a concurrent old snapshot cannot overwrite the overlay');
  assert.throws(() => w.raw.prepare('UPDATE pricing_direct_purchase SET payload_json=? WHERE product_id=?').run('{}', AMS), /pricing_owner_required/);
  assert.throws(() => w.raw.prepare('DELETE FROM pricing_direct_purchase WHERE product_id=?').run(AMS), /pricing_owner_required/);
  for (const amount of ['130', '100']) {
    const text = edit(await download(app, AMS), 'pricing.base.supplier_cost_amount', amount);
    const [p] = await preview(app, text, AMS);
    assert.equal(p.pricing?.kind, 'data');
    const result = await apply(app, text, p);
    assert.equal(result.status, 200, await result.clone().text());
    const live = await loadProductPricing(w.db, AMS);
    assert.equal(directPurchaseStore(live).inputs[0]!.supplier_cost_amount, amount);
    assert.equal(live.direct_purchase?.inputs.length, 0);
  }
});
