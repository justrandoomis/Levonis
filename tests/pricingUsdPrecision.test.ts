/** Fractional-cent product prices survive the input, preview, SQL CHECKs and reload. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { all, asD1, dbThrough, get, json, post, put } from './fixtures/app';
import { AMS, pricingWorld } from './fixtures/procurementPricing';
import { applyRate } from './fixtures/fx';
import { seedOptionless, v2App, writeV2 } from './fixtures/pricingV2';
import { cleanUsd, draftOf, finalUsdOf, profitForFinal, skuLines, typingUsd, usdText, type V2Answer } from '../src/components/adminProducts/form/v2/v2Model';
import { centsOfUsdText } from '../worker/lib/offerUsd';

test('decimal keyboards preserve 0.051 and six-place unit prices; cents-only offers keep their own limit', () => {
  for (const raw of ['0.051', '٠٫٠٥١', '۰٫۰۵۱']) {
    assert.equal(typingUsd(raw), '0.051');
    assert.equal(cleanUsd(raw), '0.051');
  }
  for (const raw of ['0.000001', '99999.999999']) assert.equal(cleanUsd(typingUsd(raw)), raw);
  assert.equal(typingUsd('-٠٫٠٠١', true), '-0.001');
  assert.equal(cleanUsd('-0.001', { signed: true }), '-0.001');
  assert.equal(cleanUsd('0.0000001'), null);
  assert.equal(cleanUsd('100000.000001'), null);
  assert.equal(usdText('0.051'), '$0.051');
  assert.equal(usdText('0.000001'), '$0.000001');
  assert.equal(usdText('125'), '$125.00');
  assert.equal(typingUsd('0.051', false, 2), '0.05');
  assert.equal(centsOfUsdText('0.051'), null, 'offers never silently round a fractional cent');
});

test('price-first preview, save and reload keep a 0.051 price and a 0.001 preorder discount', async () => {
  const w = pricingWorld();
  const app = v2App(w.raw);
  const pricing = {
    method: 'usd',
    points: [{ scope: 'product', id: '', kind: 'fixed', usd: '0.051' }],
    discounts: [{ scope: 'product', id: '', usd: '0.001' }],
  };
  const res = await post(app, '/api/admin/products-v2/pricing/preview', { product_id: AMS, pricing });
  const preview = await json(res);
  assert.equal(res.status, 200, JSON.stringify(preview));
  assert.equal(preview.complete, true, JSON.stringify(preview.codes));
  const saved = await put(app, `/api/admin/products-v2/${AMS}/pricing`, { pricing, seq: preview.seq, preview_hash: preview.review_hash, confirm_large_change: true });
  assert.equal(saved.status, 200, JSON.stringify(await json(saved)));
  const reload = await json(await get(app, `/api/admin/products-v2/${AMS}/pricing`));
  const draft = draftOf(reload as V2Answer);
  assert.equal(draft.product_usd, '0.051');
  assert.equal(draft.discount_usd, '0.001');
  const direct = reload.table.find((r: { channel: string }) => r.channel === 'direct_sale');
  const preorder = reload.table.find((r: { channel: string }) => r.channel === 'pre_order_land');
  assert.equal(direct.editor_usd_price, '0.051');
  assert.equal(direct.price_iqd, 82, '0.051 × 1600 = 81.6, rounded once to whole dinars');
  assert.equal(preorder.editor_usd_price, '0.05');
  assert.equal(preorder.price_iqd, 80);
  assert.equal(w.raw.prepare('SELECT amount_usd FROM pricing_price_points WHERE product_id=?').get(AMS)?.amount_usd, '0.051');
  assert.equal(w.raw.prepare('SELECT amount_usd FROM pricing_preorder_discounts WHERE product_id=?').get(AMS)?.amount_usd, '0.001');
  // A model difference exercises the signed SQL grammar and the private result's six-place sum.
  const modelPricing = { ...pricing, points: [...pricing.points, { scope: 'option', id: `${AMS}_o0`, kind: 'delta', usd: '-0.000001' }] };
  const next = await json(await post(app, '/api/admin/products-v2/pricing/preview', { product_id: AMS, pricing: modelPricing }));
  const modelSave = await put(app, `/api/admin/products-v2/${AMS}/pricing`, { pricing: modelPricing, seq: next.seq, preview_hash: next.review_hash });
  assert.equal(modelSave.status, 200, JSON.stringify(await json(modelSave)));
  const modelReload = await json(await get(app, `/api/admin/products-v2/${AMS}/pricing`));
  assert.equal(draftOf(modelReload as V2Answer).models[`${AMS}_o0`].usd, '-0.000001');
  assert.equal(modelReload.table.find((r: { channel: string }) => r.channel === 'direct_sale').editor_usd_price, '0.050999');
});

test('a cost-first final price of 0.051 derives a fractional-cent profit, then reloads as exactly 0.051', async () => {
  const w = pricingWorld();
  const pid = 'tiny-unit';
  seedOptionless(w.raw, pid, { saleTypes: ['direct_sale'] });
  w.raw.exec(`UPDATE products SET package_weight_g=1, package_depth_mm=1, package_width_mm=1, package_height_mm=1 WHERE id='${pid}'`);
  await writeV2(w.db, pid, {
    method: 'cost', minimumProfitUsd: '0.01',
    inputs: { supplier_cost_amount: '0.01', supplier_cost_currency: 'USD', shipping_profile: 'GERMANY_LAND', shipping_weight_g: 1, additional_cost_iqd: 0 },
  });
  const app = v2App(w.raw);
  const before = await json(await get(app, `/api/admin/products-v2/${pid}/pricing`));
  const ref = finalUsdOf(skuLines(before.table)[0])!;
  assert.ok(ref);
  const profit = profitForFinal(typingUsd('٠٫٠٥١'), ref.base);
  assert.ok(profit?.ok, JSON.stringify({ ref, profit }));
  assert.ok(profit.usd.split('.')[1].length > 2, 'the correction must not discard fractions of a cent');
  const pricing = { cost: { minimum_profit: profit.usd } };
  const pre = await json(await post(app, '/api/admin/products-v2/pricing/preview', { product_id: pid, pricing }));
  assert.equal(finalUsdOf(skuLines(pre.table)[0])?.final, '0.051');
  const save = await put(app, `/api/admin/products-v2/${pid}/pricing`, { seq: pre.seq, pricing, preview_hash: pre.review_hash, confirm_large_change: true });
  assert.equal(save.status, 200, JSON.stringify(await json(save)));
  const reload = await json(await get(app, `/api/admin/products-v2/${pid}/pricing`));
  assert.equal(finalUsdOf(skuLines(reload.table)[0])?.final, '0.051');
  assert.equal(draftOf(reload as V2Answer).min_profit_usd, profit.usd);
  assert.equal(w.raw.prepare('SELECT target_profit_usd FROM pricing_v2_sku_results WHERE product_id=?').get(pid)?.target_profit_usd, profit.usd);
});

test('0211 preserves existing data, every guard and index, and the input/config revisions', async () => {
  const raw = dbThrough('0210');
  applyRate(raw, 'USD_IQD', '1600');
  seedOptionless(raw, 'existing-unit');
  await writeV2(asD1(raw), 'existing-unit', { method: 'usd', points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '1.25' }], discounts: [{ scope: 'product', scope_id: '', usd: '0.05' }] });
  raw.exec("INSERT INTO pricing_rules(id,kind,scope,state,amount_usd,updated_at) VALUES ('precision-rule','target_profit','global','ACTIVE','1.25','2026-10-23')");
  const tables = ['pricing_rules', 'pricing_price_points', 'pricing_preorder_discounts', 'pricing_v2_sku_results', 'pricing_sku_costs'];
  const rows = () => [...tables, 'product_sku_prices', 'product_pricing_state', 'pricing_engine_control'].map((t) => all(raw, `SELECT * FROM ${t}`));
  const schema = () => tables.map((t) => all(raw, `SELECT name,sql FROM sqlite_master WHERE tbl_name='${t}' AND type IN ('index','trigger') ORDER BY name`));
  const before = rows();
  const guards = schema();
  assert.throws(() => raw.exec("UPDATE pricing_rules SET amount_usd='0.051' WHERE id='precision-rule'"), /CHECK/);
  raw.exec(readFileSync(join(ROOT, 'migrations/0211_pricing_usd_precision.sql'), 'utf8'));
  assert.deepEqual(rows(), before, 'no repricing, ledger mutation or revision bump during migration');
  assert.deepEqual(schema(), guards, 'all indexes and trigger bodies survive unchanged');
  assert.deepEqual(all(raw, 'PRAGMA foreign_key_check'), []);
  raw.exec("UPDATE pricing_rules SET amount_usd='0.051' WHERE id='precision-rule'");
  raw.exec("UPDATE pricing_rules SET amount_usd='99999.999999' WHERE id='precision-rule'");
  assert.throws(() => raw.exec("UPDATE pricing_rules SET amount_usd='0.0000001' WHERE id='precision-rule'"), /CHECK/);
  assert.throws(() => raw.exec("UPDATE pricing_price_points SET amount_usd='0.051' WHERE product_id='existing-unit'"), /PRICING_PREVIEW_REQUIRED/);
});
