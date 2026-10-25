import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { json, post, put } from './fixtures/app';
import { AMS, AMS_MODEL, OWNER_USER, pricingWorld } from './fixtures/procurementPricing';
import { seedOptionless, v2App } from './fixtures/pricingV2';
import { planProcurementImportStock } from '../worker/lib/procurementImportStock';
import { trackedStockReady } from '../worker/lib/importStock';

function imported(raw: DatabaseSync, id: string) {
  raw.prepare(`INSERT INTO product_source_refs (source,source_product_id,product_id,source_handle,canonical_url,match_kind,stock_decision,fingerprint,fetched_at,import_run_id)
    VALUES ('bambu_us',?,?,?,'https://us.store.bambulab.com/products/test','created','not_configured','test','2026-10-24','test')`).run(id, id, id);
}
const decision = (raw: DatabaseSync, id: string) => raw.prepare('SELECT stock_decision FROM product_source_refs WHERE product_id = ?').get(id)?.stock_decision;
const stock = (raw: DatabaseSync, id: string) => raw.prepare('SELECT stock FROM products WHERE id = ?').get(id)?.stock;

test('receiving unconfigured imported choices initializes stock in the same transaction, once, even without published pricing', async () => {
  const w = pricingWorld();
  imported(w.raw, AMS);
  w.raw.prepare('UPDATE product_option_values SET stock=NULL WHERE product_id=?').run(AMS);
  const group = w.raw.prepare('SELECT group_id FROM product_option_values WHERE id=?').get(AMS_MODEL)!.group_id!;
  w.raw.prepare("INSERT INTO product_option_values(id,product_id,group_id,name_en,active,stock) VALUES ('receipt-second',?,?,'Second',1,NULL)").run(AMS, group);
  const lines = [AMS_MODEL, 'receipt-second'].map((id, i) => ({ product_id: AMS, scope: 'option', scope_id: id, qty_ordered: i + 2, source_unit_amount: 12, weight_g: 25, volume_mm3: 0 }));
  const id = await w.save(w.draft({ lines }));
  w.raw.exec("CREATE TEMP TRIGGER fail_receipt BEFORE INSERT ON incoming_inventory_receipts BEGIN SELECT RAISE(ABORT,'failed receipt'); END");
  const operationId = crypto.randomUUID();
  assert.equal((await w.receive(id, operationId)).status, 500);
  assert.equal(w.raw.prepare('SELECT stock FROM product_option_values WHERE id=?').get(AMS_MODEL)?.stock, null);
  assert.equal(decision(w.raw, AMS), 'not_configured');
  assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM inventory_lots WHERE product_id=?').get(AMS)?.n, 0);
  w.raw.exec('DROP TRIGGER fail_receipt');
  const received = await w.receive(id, operationId);
  assert.equal(received.status, 200, JSON.stringify(received));
  assert.equal((await w.receive(id, operationId)).status, 200);
  assert.deepEqual(w.raw.prepare('SELECT stock FROM product_option_values WHERE product_id=? ORDER BY id').all(AMS).map(r=>r.stock), [2,3]);
  assert.equal(decision(w.raw, AMS), 'tracked');
  assert.equal(w.raw.prepare('SELECT SUM(qty_remaining) AS n FROM inventory_lots WHERE product_id=?').get(AMS)?.n, 5);
  assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM pricing_v2_sku_results WHERE product_id=?').get(AMS)?.n, 0, 'receipt does not publish or invent a selling price');
});

test('a first receipt tracks an ordinary untracked selection; existing stock and reservations are never guessed', async () => {
  for (const mode of ['BASE','COLOR','VARIANT_COMBINATION'] as const) {
    const w=pricingWorld(), pid=`receive-${mode}`;
    seedOptionless(w.raw,pid,{colours:mode==='BASE'?0:2,saleTypes:['direct_sale']});
    w.raw.prepare('UPDATE products SET inventory_mode=?,stock=NULL WHERE id=?').run(mode,pid);
    const scope=mode==='BASE'?'base':mode==='COLOR'?'color':'variant';
    const scopeId=scope==='base'?'':scope==='color'?`${pid}_c0`:`${pid}_v0`;
    if(scope==='variant')w.raw.prepare('INSERT INTO product_variants(id,product_id,combo_key,active,stock) VALUES (?,?,?,1,NULL)').run(scopeId,pid,`c:${pid}_c0`);
    if(scope==='color')w.raw.prepare('UPDATE product_colors SET stock=NULL WHERE product_id=?').run(pid);
    const id=await w.save(w.draft({lines:[{product_id:pid,scope,scope_id:scopeId,qty_ordered:2,source_unit_amount:10,weight_g:10,volume_mm3:0}]}));
    const table=scope==='base'?'products':scope==='color'?'product_colors':'product_variants', rowId=scope==='base'?pid:scopeId;
    const reserved=scope==='base'?'stock_reserved':'reserved';
    w.raw.prepare(`UPDATE ${table} SET ${reserved}=1 WHERE id=?`).run(rowId);
    assert.equal((await w.receive(id,crypto.randomUUID())).body.code,'STOCK_RECOUNT_REQUIRED');
    w.raw.prepare(`UPDATE ${table} SET ${reserved}=0 WHERE id=?`).run(rowId);
    const result=await w.receive(id,crypto.randomUUID());
    assert.equal(result.status,200,JSON.stringify(result));
    assert.equal(w.raw.prepare(`SELECT stock FROM ${table} WHERE id=?`).get(rowId)?.stock,2);
    if(scope==='color')assert.equal(w.raw.prepare('SELECT stock FROM product_colors WHERE id=?').get(`${pid}_c1`)?.stock,null,'unrelated existing choices retain their policy');
  }
});

test('an inventory price save configures an imported purchase atomically, without making the incoming quantity available', async () => {
  const w = pricingWorld();
  const pid = 'import-inline-base';
  seedOptionless(w.raw, pid, { saleTypes: ['direct_sale'] });
  imported(w.raw, pid);
  w.raw.prepare('UPDATE products SET stock = NULL WHERE id = ?').run(pid);
  const selection = { product_id: pid, scope: 'base', scope_id: '' };
  const draft = w.draft({ invoice_no: 'Pending inventory', lines: [{ ...selection, qty_ordered: 2, source_unit_amount: 18.9, weight_g: 10, volume_mm3: 0 }] });
  const purchaseId = await w.save(draft);
  draft.cost_profile_version = w.profileVersion();
  const p = await json(await post(w.app, '/api/admin/pricing/procurement/line-pricing', { ...selection, draft, customer_price_usd: '25' }));
  assert.equal(p.preview?.complete, true, JSON.stringify(p));
  assert.equal(stock(w.raw, pid), null, 'a price preview does not configure inventory');
  const app = v2App(w.raw);
  const path = `/api/admin/products-v2/${pid}/pricing`;
  const price = { pricing: p.pricing, seq: p.preview.seq, preview_hash: p.preview.review_hash, confirm_large_change: true };
  const generic = await put(app, path, price);
  assert.equal((await json(generic)).code, 'IMPORT_STOCK_NOT_CONFIGURED', 'other price doors retain the import gate');
  const body = { ...price, procurement_stock: { scope: 'base', scope_id: '' } };
  const stale = await put(app, path, { ...body, preview_hash: '0'.repeat(64) });
  assert.equal(stale.status, 409);
  assert.equal(stock(w.raw, pid), null);
  assert.equal(decision(w.raw, pid), 'not_configured');
  const denied = await put(v2App(w.raw, { id: 'editor', role: 'admin', email: 'editor@x.co' }), path, body);
  assert.equal(denied.status, 403);
  const wrongSelection = await put(app, path, { ...body, procurement_stock: { scope: 'option', scope_id: AMS_MODEL } });
  assert.equal(wrongSelection.status, 400);
  // Fail AFTER stock setup: both setup and price must roll back together.
  w.raw.exec(`CREATE TEMP TRIGGER reject_inline_price BEFORE INSERT ON pricing_v2_sku_results BEGIN SELECT RAISE(ABORT,'test price failure'); END`);
  const failed = await put(app, path, body);
  assert.equal(failed.status, 500, JSON.stringify(await json(failed)));
  assert.equal(stock(w.raw, pid), null);
  assert.equal(decision(w.raw, pid), 'not_configured');
  w.raw.exec('DROP TRIGGER reject_inline_price');
  const saved = await put(app, path, body);
  assert.equal(saved.status, 200, JSON.stringify(await json(saved)));
  assert.equal(stock(w.raw, pid), 0);
  assert.equal(decision(w.raw, pid), 'tracked');
  const incoming = w.raw.prepare('SELECT qty_ordered,qty_received FROM incoming_inventory WHERE product_id = ?').get(pid);
  assert.equal(incoming?.qty_ordered, 2);
  assert.equal(incoming?.qty_received, 0);
  assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM inventory_lots WHERE product_id = ?').get(pid)?.n, 0);
  const add = await post(v2App(w.raw), '/api/cart/items', { productId: pid, qty: 1, fulfillmentType: 'direct_sale' });
  assert.equal((await json(add)).code, 'OUT_OF_STOCK');
  const replay = await put(app, path, body);
  assert.equal(replay.status, 200);
  assert.equal(stock(w.raw, pid), 0);
  assert.equal(w.raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='product.import_stock_decision' AND target=?").get(pid)?.n, 1);
  const receipt = await w.receive(purchaseId, crypto.randomUUID());
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  assert.equal(stock(w.raw, pid), 2, 'only receiving the purchase adds its quantity to available stock');
  assert.equal(w.raw.prepare('SELECT qty_received FROM incoming_inventory WHERE product_id = ?').get(pid)?.qty_received, 2);
  assert.equal(w.raw.prepare('SELECT SUM(qty_remaining) AS n FROM inventory_lots WHERE product_id = ?').get(pid)?.n, 2);
  const oversell = await post(v2App(w.raw), '/api/cart/items', { productId: pid, qty: 3, fulfillmentType: 'direct_sale' });
  assert.equal((await json(oversell)).code, 'QTY_UNAVAILABLE', 'published pricing cannot bypass the received quantity');
  assert.equal(stock(w.raw, pid), 2);
});

test('batch setup follows each inventory mode, preserves quantities and reservations, and refuses a raced stock decision', async () => {
  const w = pricingWorld();
  const now = new Date().toISOString();
  for (const mode of ['COLOR', 'VARIANT_COMBINATION']) {
    const pid = `import-${mode.toLowerCase()}`;
    seedOptionless(w.raw, pid, { colours: 2, saleTypes: ['direct_sale'] });
    imported(w.raw, pid);
    w.raw.prepare('UPDATE products SET inventory_mode = ? WHERE id = ?').run(mode, pid);
    const scope = mode === 'COLOR' ? 'color' : 'variant';
    const table = mode === 'COLOR' ? 'product_colors' : 'product_variants';
    if (scope === 'variant') {
      for (let i = 0; i < 2; i++) w.raw.prepare('INSERT INTO product_variants (id,product_id,combo_key,active,stock) VALUES (?,?,?,1,NULL)').run(`${pid}_v${i}`, pid, `c:${pid}_c${i}`);
    } else w.raw.prepare('UPDATE product_colors SET stock = NULL WHERE product_id = ?').run(pid);
    const id = `${pid}_${scope === 'variant' ? 'v' : 'c'}0`;
    w.raw.prepare(`UPDATE ${table} SET stock = 3,reserved = 1 WHERE id = ?`).run(id);
    const plan = await planProcurementImportStock(w.db, pid, { scope, scope_id: id }, OWNER_USER.id, now);
    assert.equal(decision(w.raw, pid), 'not_configured', 'planning is read-only');
    await w.db.batch(plan);
    assert.equal(await trackedStockReady(w.db, pid), true);
    const rows = w.raw.prepare(`SELECT stock,reserved FROM ${table} WHERE product_id = ? ORDER BY id`).all(pid);
    assert.deepEqual(rows.map(r => [r.stock, r.reserved]), [[3, 1], [0, 0]]);
    assert.equal(decision(w.raw, pid), 'tracked');
  }
  imported(w.raw, AMS);
  w.raw.prepare('UPDATE product_option_values SET stock = NULL WHERE product_id = ?').run(AMS);
  const selectedGroup = w.raw.prepare('SELECT group_id FROM product_option_values WHERE id = ?').get(AMS_MODEL)?.group_id;
  w.raw.prepare("INSERT INTO product_option_values (id,product_id,group_id,name_en,active,stock) VALUES ('inline-option-extra',?,?,'Extra',1,7)").run(AMS, selectedGroup!);
  w.raw.prepare("INSERT INTO product_option_groups (id,product_id,name_en,active) VALUES ('inline-group-other',?,'Other',1)").run(AMS);
  w.raw.prepare("INSERT INTO product_option_values (id,product_id,group_id,name_en,active,stock) VALUES ('inline-other',?,'inline-group-other','Other',1,NULL)").run(AMS);
  const scope = { scope: 'option', scope_id: AMS_MODEL };
  const plan = await planProcurementImportStock(w.db, AMS, scope, OWNER_USER.id, now);
  w.raw.prepare("UPDATE product_source_refs SET stock_decision='untracked',stock_decided_by=?,stock_decided_at=? WHERE product_id=?").run(OWNER_USER.id, now, AMS);
  await assert.rejects(w.db.batch(plan), /CHECK constraint failed/);
  assert.equal(w.raw.prepare('SELECT stock FROM product_option_values WHERE id=?').get(AMS_MODEL)?.stock, null);
  assert.deepEqual(await planProcurementImportStock(w.db, AMS, scope, OWNER_USER.id, now), [], 'an explicit untracked decision is preserved');
  w.raw.prepare("UPDATE product_source_refs SET stock_decision='not_configured' WHERE product_id=?").run(AMS);
  await w.db.batch(await planProcurementImportStock(w.db, AMS, scope, OWNER_USER.id, now));
  assert.equal(w.raw.prepare('SELECT stock FROM product_option_values WHERE id=?').get(AMS_MODEL)?.stock, 0);
  assert.equal(w.raw.prepare("SELECT stock FROM product_option_values WHERE id='inline-option-extra'").get()?.stock, 7);
  assert.equal(w.raw.prepare("SELECT stock FROM product_option_values WHERE id='inline-other'").get()?.stock, null, 'unrelated option groups remain untracked');
  assert.equal(await trackedStockReady(w.db, AMS), true);
});
