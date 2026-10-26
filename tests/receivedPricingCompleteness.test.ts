import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { get, json, post, put } from './fixtures/app';
import { pricingWorld } from './fixtures/procurementPricing';
import { seedOptionless, v2App, writeV2 } from './fixtures/pricingV2';
import { seedCatalog } from './fixtures/completeness';
import { recomputeCompleteness, scanStale } from '../worker/lib/productCompleteness';
import { loadV2Read } from '../worker/lib/pricingEngine/v2/api';
import { evaluateV2Write, storedDesired } from '../worker/lib/pricingEngine/v2/evaluate';
import { recoverReceivedPricing } from '../worker/lib/pricingEngine/v2/receivedRecovery';
import { statementBudget } from '../worker/lib/fx/budget';
import { countingD1 } from '../worker/lib/d1Count';

const pid = 'received-priced';
const selection = { product_id: pid, scope: 'color', scope_id: `${pid}_c0` };
const migration = readFileSync(new URL('../migrations/0214_received_pricing_recovery.sql', import.meta.url), 'utf8');

async function world(savedBeforeReceipt = false, publishBeforeReceipt = false) {
  const w = pricingWorld();
  seedCatalog(w.raw);
  seedOptionless(w.raw, pid, { colours: 2, saleTypes: ['direct_sale'] });
  w.raw.exec(`UPDATE products SET inventory_mode='COLOR', category_id='cat_p', product_cost_iqd=NULL,
    package_weight_g=NULL, package_width_mm=NULL, package_depth_mm=NULL, package_height_mm=NULL WHERE id='${pid}';
    UPDATE product_colors SET stock=NULL WHERE product_id='${pid}';
    INSERT INTO product_images(id,product_id,url,r2_key,content_type,bytes,width,height,sort_order,is_primary) VALUES ('received-image','${pid}','/files/products/received.webp','products/received.webp','image/webp',1000,800,600,0,1);
    INSERT INTO admin_settings(key,value) VALUES ('catalogHideIncomplete','{"enabled":true}') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
    INSERT INTO product_source_refs(source,source_product_id,product_id,source_handle,canonical_url,match_kind,stock_decision,fingerprint,fetched_at,import_run_id)
      VALUES ('bambu_us','${pid}','${pid}','${pid}','https://us.store.bambulab.com/products/test','created','not_configured','test','2026-10-26','test');`);
  const draft = w.draft({ lines: [{ ...selection, qty_ordered: 2, source_unit_amount: 10, weight_g: 25, volume_mm3: 0 }] });
  const purchase = await w.save(draft);
  draft.cost_profile_version = w.profileVersion();
  const app = v2App(w.raw);
  if (savedBeforeReceipt) {
    const p = await json(await post(w.app, '/api/admin/pricing/procurement/line-pricing', { ...selection, draft, customer_price_usd: '25' }));
    // Reproduce a pre-fix data-only save: its ordinary writer sees unknown stock
    // until the receipt, rather than accepting the procurement stock decision.
    const saved = await json(await put(app, `/api/admin/products-v2/${pid}/pricing`, {
      pricing: p.pricing, seq: p.preview.seq,
      ...(publishBeforeReceipt ? { preview_hash: p.preview.review_hash, procurement_stock: { scope: selection.scope, scope_id: selection.scope_id } } : {}),
    }));
    assert.equal(saved.saved, publishBeforeReceipt ? 'prices' : 'data', JSON.stringify(saved));
    if (publishBeforeReceipt) assert.equal(w.raw.prepare('SELECT stock FROM product_colors WHERE id=?').get(selection.scope_id)?.stock, 0, 'pricing never receives inventory');
  }
  const receipt = await w.receive(purchase, crypto.randomUUID());
  assert.equal(receipt.status, 200, JSON.stringify(receipt));
  return { ...w, app, draft };
}

test('a received, priced selection publishes while its empty sibling stays off; no false cost or package hold', async () => {
  const w = await world();
  const p = await json(await post(w.app, '/api/admin/pricing/procurement/line-pricing', { ...selection, draft: w.draft, customer_price_usd: '25' }));
  assert.equal(p.preview.complete, true, JSON.stringify(p.preview));
  const saved = await json(await put(w.app, `/api/admin/products-v2/${pid}/pricing`, { pricing: p.pricing, seq: p.preview.seq, preview_hash: p.preview.review_hash }));
  assert.equal(saved.saved, 'prices', JSON.stringify(saved));
  const verdict = await recomputeCompleteness(w.db, [pid]);
  assert.deepEqual(verdict.verdicts[0]?.items, []);
  const list = await json(await get(w.app, '/api/admin/products-v2?limit=100'));
  const product = list.products.find((r: { id: string }) => r.id === pid);
  assert.equal(product.needs_pricing, false);
  assert.equal(product.from_iqd, p.customer_price_iqd);
  assert.equal(product.held, false);
  const available = await post(w.app, '/api/cart/items', { productId: pid, colorId: `${pid}_c0`, qty: 1, fulfillmentType: 'direct_sale' });
  assert.equal(available.status, 200, JSON.stringify(await json(available)));
  const empty = await post(w.app, '/api/cart/items', { productId: pid, colorId: `${pid}_c1`, qty: 1, fulfillmentType: 'direct_sale' });
  assert.equal(empty.status, 400, JSON.stringify(await json(empty)));
  assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM pricing_v2_sku_results WHERE product_id=?').get(pid)?.n, 1);
  // Published goods with an old package-only hold are repaired immediately on
  // the owner page, even when they never belonged to the unpublished snapshot.
  w.raw.prepare("UPDATE product_completeness SET list_version=1,complete=0,held=1,missing_count=1,missing_json='[{\"c\":\"PACKAGE_BOX\",\"o\":\"\"}]' WHERE product_id=?").run(pid);
  const denied = await post(v2App(w.raw, { id: 'editor', email: 'editor@x.co', role: 'admin' }), '/api/admin/products-v2/pricing/recover-received', {});
  assert.equal(denied.status, 403);
  assert.equal(w.raw.prepare('SELECT held FROM product_completeness WHERE product_id=?').get(pid)?.held, 1);
  const repaired = await json(await post(w.app, '/api/admin/products-v2/pricing/recover-received', {}));
  assert.equal(repaired.recovered, 0);
  assert.equal(repaired.refreshed, 1);
  assert.equal(w.raw.prepare('SELECT held FROM product_completeness WHERE product_id=?').get(pid)?.held, 0);
  await writeV2(w.db, pid, { method: 'usd', points: [{ scope: 'product', scope_id: '', kind: 'fixed', usd: '25' }] });
  assert.deepEqual((await recomputeCompleteness(w.db, [pid])).verdicts[0]?.items, [], 'received direct goods do not need supplier freight dimensions in either V2 method');
});

test('snapshot recovery publishes only unchanged saved receipt pricing, is idempotent and respects the statement budget', async () => {
  const w = await world(true);
  w.raw.exec(migration);
  assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM pricing_received_recovery').get()?.n, 1);
  const counted = countingD1(w.db), before = counted.executed;
  const budget = statementBudget(200);
  const result = await recoverReceivedPricing(counted.db, budget);
  assert.deepEqual(result.recovered, [pid], JSON.stringify(result));
  assert.ok(counted.executed - before <= budget.used && budget.used <= 200, `${counted.executed - before} executed / ${budget.used} budgeted`);
  assert.deepEqual((await recoverReceivedPricing(w.db, statementBudget(200))).recovered, []);
  assert.equal(w.raw.prepare('SELECT complete,held FROM product_completeness WHERE product_id=?').get(pid)?.held, 0);
  assert.equal(w.raw.prepare('SELECT SUM(qty_remaining) AS n FROM inventory_lots WHERE product_id=?').get(pid)?.n, 2);
  assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM pricing_v2_sku_results WHERE product_id=?').get(pid)?.n, 1);
});

test('a recovery snapshot cannot publish later edits or an ordinary future draft', async () => {
  const w = await world(true);
  assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM pricing_received_recovery').get()?.n, 0, 'future saves are not enqueued');
  w.raw.exec(migration);
  w.raw.prepare('UPDATE product_pricing_state SET inputs_seq=inputs_seq+1 WHERE product_id=?').run(pid);
  const result = await recoverReceivedPricing(w.db, statementBudget(200));
  assert.deepEqual(result.recovered, []);
  assert.equal(result.skipped, 1);
  assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM pricing_v2_sku_results WHERE product_id=?').get(pid)?.n, 0);
});

test('unknown stock, positive physical stock and pre-order gaps still block an incomplete price set', async () => {
  const w = await world(true);
  for (const stock of [null, 1]) {
    w.raw.prepare('UPDATE product_colors SET stock=? WHERE id=?').run(stock, `${pid}_c1`);
    const read = (await loadV2Read(w.db, pid))!;
    const ev = await evaluateV2Write({ ...read, ...storedDesired(read.v2), method: 'cost', inputWrites: [], ruleWrites: [], acceptBlocked: true });
    assert.equal(ev.complete, false, `stock ${stock} must not disappear from pricing`);
  }
  w.raw.prepare('UPDATE product_colors SET stock=0 WHERE id=?').run(`${pid}_c1`);
  w.raw.exec(`INSERT INTO ops_guards(id,ok) VALUES ('engine-price:${pid}',1);
    UPDATE products SET sale_types='["direct_sale","pre_order"]',preorder_transports='[{"method":"land","active":true,"commission_iqd":0}]' WHERE id='${pid}';
    DELETE FROM ops_guards WHERE id='engine-price:${pid}';`);
  const read = (await loadV2Read(w.db, pid))!;
  const ev = await evaluateV2Write({ ...read, ...storedDesired(read.v2), method: 'cost', inputWrites: [], ruleWrites: [], acceptBlocked: true });
  assert.equal(ev.complete, false);
});

test('received cost and price writes invalidate old completeness verdicts', async () => {
  const w = await world(true);
  await recomputeCompleteness(w.db, [pid]);
  assert.ok(!(await scanStale(w.db)).stale.some((r) => r.id === pid));
  w.raw.prepare('UPDATE inventory_lots SET qty_remaining=0 WHERE product_id=?').run(pid);
  assert.ok((await scanStale(w.db)).stale.some((r) => r.id === pid));
});


test('pricing an incoming imported choice publishes only its saved price and receives quantity only on receipt', async () => {
  const w = await world(true, true);
  assert.equal(w.raw.prepare('SELECT stock FROM product_colors WHERE id=?').get(selection.scope_id)?.stock, 2);
  assert.equal(w.raw.prepare('SELECT stock FROM product_colors WHERE id=?').get(`${pid}_c1`)?.stock, 0);
  assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM pricing_v2_sku_results WHERE product_id=?').get(pid)?.n, 1);
  assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM pricing_received_recovery').get()?.n, 0);
});
