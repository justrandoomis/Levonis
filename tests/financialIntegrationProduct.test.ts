import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pricingWorld, AMS, AMS_MODEL, OWNER_USER } from './fixtures/procurementPricing';
import { loadProductPricing } from '../worker/lib/pricingEngine/store';
import { asD1, json, put, stubApp } from './fixtures/app';
import { applyRate } from './fixtures/fx';
import { adminPricingRoutes } from '../worker/routes/adminPricing';

test('a full-channel owner edit cannot silently fall back to direct pricing when it removes preorder supplier data', async () => {
  const w = pricingWorld();
  const initial = await w.putInputs(AMS, { inputs_seq: 0, data_only: true,
    inputs: [{ scope: 'base', supplier_cost_amount: '100', supplier_cost_currency: 'EUR', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 2500 }],
    rules: [{ kind: 'target_profit', scope: 'product', amount_usd: '120' }, { kind: 'direct_sale_extra', scope: 'product', amount_iqd: 50000 }],
  });
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  const purchaseId = await w.save(w.draft());
  const preview = await w.preview({ purchase_id: purchaseId });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const purchase = preview.body.products[0];
  assert.equal(purchase.adoption.complete, true, JSON.stringify(purchase.adoption));
  const stock = await w.apply(AMS, { purchase_id: purchaseId, preview_hash: purchase.preview_hash, confirm_large_change: true });
  assert.equal(stock.status, 200, JSON.stringify(stock.body));
  const clear = { inputs: [{ scope: 'base', supplier_cost_amount: null, supplier_cost_currency: null }] };
  const rejectIncomplete = async () => {
    const current = await loadProductPricing(w.db, AMS);
    const before = JSON.stringify(w.raw.prepare('SELECT * FROM pricing_inputs WHERE product_id=? ORDER BY scope,scope_id').all(AMS));
    const invalid = await w.previewInputs(AMS, clear);
    assert.equal(invalid.status, 200, JSON.stringify(invalid.body));
    assert.equal(invalid.body.adoption.complete, false, 'ordinary owner pricing must report its now-incomplete preorder channel');
    assert.ok(invalid.body.adoption.missing_codes.includes('SUPPLIER_COST_MISSING'));
    const refused = await w.putInputs(AMS, { inputs_seq: current.state!.inputs_seq, ...clear, preview_hash: invalid.body.preview_hash, confirm_large_change: true });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.code, 'PRICING_ENGINE_INCOMPLETE');
    assert.equal(JSON.stringify(w.raw.prepare('SELECT * FROM pricing_inputs WHERE product_id=? ORDER BY scope,scope_id').all(AMS)), before);
    assert.deepEqual(await loadProductPricing(w.db, AMS), current, 'refusal changes neither pricing state nor the stock overlay');
  };
  assert.equal((await loadProductPricing(w.db, AMS)).direct_purchase?.direct_only, true);
  await rejectIncomplete();
  const fullPreview = await w.previewInputs(AMS, {});
  assert.equal(fullPreview.status, 200, JSON.stringify(fullPreview.body));
  assert.deepEqual(fullPreview.body.adoption.rows.map((r: { channel: string }) => r.channel).sort(), ['direct_sale', 'pre_order_land']);
  const full = await w.putInputs(AMS, { inputs_seq: fullPreview.body.inputs_seq, preview_hash: fullPreview.body.preview_hash, confirm_large_change: true });
  assert.equal(full.status, 200, JSON.stringify(full.body));
  const stored = await loadProductPricing(w.db, AMS);
  assert.equal(stored.state?.mode, 'engine');
  assert.equal(stored.direct_purchase?.direct_only, false);
  assert.equal(stored.direct_purchase?.inputs.find((r) => r.scope_id === AMS_MODEL)?.set.supplier_cost_amount, '450');
  await rejectIncomplete();
});

test('a data-only IQD conversion refuses a rate committed between the rate read and pricing-store read', async () => {
 for (const movedRate of ['2000', '1600']) {
  const w = pricingWorld();
  const draft = { inputs: [{ scope: 'base', supplier_cost_iqd: 160000 }] };
  const preview = await w.previewInputs(AMS, draft);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.rates.usd_iqd_rate, '1600');
  const original = asD1(w.raw);
  let raced = false;
  const racedDb = new Proxy(original, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => {
        if (!raced && sql.startsWith('SELECT * FROM products WHERE id IN')) {
          raced = true;
          if (movedRate === '1600') applyRate(w.raw, 'USD_IQD', '1700');
          applyRate(w.raw, 'USD_IQD', movedRate);
        }
        return target.prepare(sql);
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const app = stubApp(racedDb, OWNER_USER, (a) => a.route('/api/admin/pricing', adminPricingRoutes));
  const response = await put(app, `/api/admin/pricing/products/${AMS}/inputs`, {
    inputs_seq: 0, data_only: true, ...draft, preview_hash: preview.body.conversion_hash,
  });
  const body = await json(response);
  assert.equal(raced, true);
  assert.equal(response.status, 409, JSON.stringify({ body, supplier: w.raw.prepare('SELECT supplier_cost_amount,conversion_rate_snapshot FROM pricing_inputs WHERE product_id=?').all(AMS) }));
  assert.equal(body.code, 'PRICING_CHANGED');
  assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM pricing_inputs WHERE product_id=?').get(AMS)!.n, 0);
  assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM product_pricing_state WHERE product_id=?').get(AMS)!.n, 0);
  const fresh = await w.previewInputs(AMS, draft);
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  const saved = await w.putInputs(AMS, { inputs_seq: 0, data_only: true, ...draft, preview_hash: fresh.body.conversion_hash });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const savedRow = w.raw.prepare("SELECT * FROM pricing_inputs WHERE product_id=? AND scope='base'").get(AMS)!;
  assert.equal(savedRow.supplier_cost_amount, movedRate === '2000' ? '80' : '100');
  assert.equal(savedRow.conversion_rate_snapshot, movedRate);
  assert.equal(savedRow.conversion_fx_version, w.raw.prepare("SELECT effective_version FROM fx_rate_pairs WHERE pair='USD_IQD'").get()!.effective_version);
  // A deliberate conversion is sticky thereafter: identical typed dinars do
  // not follow FX until the owner explicitly requests reconversion.
  applyRate(w.raw, 'USD_IQD', '3000');
  const samePreview = await w.previewInputs(AMS, draft);
  const same = await w.putInputs(AMS, { inputs_seq: saved.body.inputs_seq, data_only: true, ...draft, preview_hash: samePreview.body.conversion_hash });
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.deepEqual(w.raw.prepare("SELECT * FROM pricing_inputs WHERE product_id=? AND scope='base'").get(AMS), savedRow);
  const reconvert = { inputs: [{ scope: 'base', supplier_cost_iqd: 160000, reconvert: true }] };
  const conversion = await w.previewInputs(AMS, reconvert);
  const changed = await w.putInputs(AMS, { inputs_seq: same.body.inputs_seq, data_only: true, ...reconvert, preview_hash: conversion.body.conversion_hash });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const changedRow = w.raw.prepare("SELECT supplier_cost_amount,conversion_rate_snapshot FROM pricing_inputs WHERE product_id=? AND scope='base'").get(AMS)!;
  assert.equal(changedRow.supplier_cost_amount, '53.333333');
  assert.equal(changedRow.conversion_rate_snapshot, '3000');
 }
});

test('the first approved USD rate enables an IQD conversion without requiring unrelated cross or shipping rates', async () => {
  const w = pricingWorld({ rates: false });
  const draft = { inputs: [{ scope: 'base', supplier_cost_iqd: 160000 }] };
  const absent = await w.putInputs(AMS, { inputs_seq: 0, data_only: true, ...draft });
  assert.equal(absent.status, 409, JSON.stringify(absent.body));
  assert.equal(absent.body.code, 'PRICING_FX_RATE_MISSING');
  assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM pricing_inputs WHERE product_id=?').get(AMS)!.n, 0);
  applyRate(w.raw, 'USD_IQD', '1600');
  const preview = await w.previewInputs(AMS, draft);
  const saved = await w.putInputs(AMS, { inputs_seq: 0, data_only: true, ...draft, preview_hash: preview.body.conversion_hash });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const input = w.raw.prepare('SELECT supplier_cost_amount,conversion_rate_snapshot FROM pricing_inputs WHERE product_id=?').get(AMS)!;
  assert.equal(input.supplier_cost_amount, '100');
  assert.equal(input.conversion_rate_snapshot, '1600');
});
