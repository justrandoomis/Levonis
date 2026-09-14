import { completeTxt } from './fixtures/fullProduct';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb, asD1, row, stubApp, post, get, failingD1 } from './fixtures/app';
import { templateRoutes } from '../worker/routes/template';
import { parseProductRow } from '../worker/lib/productModel';
import { loadRelationsView, applyRelations } from '../worker/lib/productOverlay';
import { deleteProductPermanently, processProductMediaCleanup, productSchema, productDependencyGraph } from '../worker/lib/productDeletion';
import { scanProductOrphans, confirmProductOrphanCleanup } from '../worker/lib/productOrphans';
import type { Env } from '../worker/lib/types';
import { resolveUnitPrice } from '../worker/lib/pricing';

import { MemoryMedia } from './fixtures/media';

function evidence(name: string, value: unknown) {
  const dir=process.env.PRODUCT_ARCHITECTURE_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,name),JSON.stringify({ environment:'local SQLite via D1 adapter; in-memory R2 fixture',production:false,recorded_at:new Date().toISOString(),result:value },null,2)+'\n');
}

function setup() {
  const raw = freshDb(); const media = new MemoryMedia(); const db = asD1(raw);
  raw.prepare("INSERT INTO users(id,email,name,role) VALUES ('owner','owner@test.com','Owner','admin')").run();
  raw.prepare("UPDATE catalogs SET is_printer_catalog=1 WHERE slug='printers'").run();
  const env = { DB: db, BUCKET: media, APP_ORIGIN: 'https://levonis-iq.com', INITIAL_ADMIN_EMAIL: 'owner@test.com' } as unknown as Env;
  const app = stubApp(db, { id: 'owner', role: 'admin', email: 'owner@test.com' }, a => a.route('/api/admin/template', templateRoutes), { env: env as unknown as Record<string,unknown> });
  return { raw, media, env, db, app };
}


test('full product export → permanent delete → import restores model/fulfillment/transports and every content section with fresh media keys', async () => {
  const {raw, media, env, db, app} = setup();
  const text=completeTxt(media);
  const initial=await post(app,'/api/admin/template/apply',{text,mode:'draft',confirm:true});
  const created=await initial.json() as {product_id:string}; assert.equal(initial.status,200,JSON.stringify(created));
  const id=created.product_id;
  const before=applyRelations(parseProductRow(row(raw,'SELECT * FROM products WHERE id=?',id)!),await loadRelationsView(db,id,'BASE'));
  assert.equal(before.options.length,2); assert.equal(before.colors.length,3); assert.equal(before.media.length,5);
  assert.equal(before.spec_groups[0].rows.length,39); assert.equal(before.content_blocks.length,5);
  assert.equal(before.usage_guide.steps.length,10); assert.equal(before.warranty_plans.length,2);
  const download=await get(app,`/api/admin/template/export/${id}`);
  const exported=await download.text(); assert.equal(download.status,200,exported);
  assert.ok(exported.includes('# levonis_asset_v1='));
  assert.ok(!/^options\.\d+\.availability_type=/m.test(exported));
  raw.prepare("INSERT INTO cart_items(id,user_id,product_id,option_id,qty) VALUES ('cart','owner',?,'model-1',1)").run(id);
  raw.prepare("INSERT INTO orders(id,user_id,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd) VALUES ('history','owner','{}','standard','{}','cash',549000,1400,549000,549000)").run();
  raw.prepare("INSERT INTO order_items(id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd) VALUES ('historical-line','history',?,'A1 mini','A1 mini',1,549000,549000)").run(id);
  const report=await deleteProductPermanently(env,id,'owner');
  assert.equal(report.product_deleted,true); assert.equal(report.r2_cleanup_pending,0); assert.equal(report.r2_objects_deleted,5);
  assert.equal(media.objects.size,0);
  const verifiedCounts: Record<string,number>={};
  for(const dep of productDependencyGraph(await productSchema(db))) {
    const remaining=(await db.prepare(`SELECT COUNT(*) n FROM "${dep.table}" WHERE ${dep.predicate}`).bind(id).first<{n:number}>())?.n ?? -1;
    assert.equal(remaining,0,dep.table); verifiedCounts[dep.table]=remaining;
  }
  assert.equal(row(raw,"SELECT COUNT(*) n FROM orders WHERE id='history'")?.n,1);
  assert.equal(row(raw,"SELECT name_snapshot FROM order_items WHERE id='historical-line'")?.name_snapshot,'A1 mini');
  assert.ok(report.cache_keys_invalidated.some(k=>k.startsWith('catalog-generation:')));
  const restored=await post(app,'/api/admin/template/apply',{text:exported,mode:'draft',confirm:true});
  const result=await restored.json() as {product_id:string}; assert.equal(restored.status,200,JSON.stringify(result));
  assert.notEqual(result.product_id,id);
  const after=applyRelations(parseProductRow(row(raw,'SELECT * FROM products WHERE id=?',result.product_id)!),await loadRelationsView(db,result.product_id,'BASE'));
  assert.equal(after.slug,before.slug); assert.equal(after.options.length,2); assert.equal(after.colors.length,3);
  assert.deepEqual(after.spec_groups,before.spec_groups); assert.deepEqual(after.warranty_plans,before.warranty_plans); assert.deepEqual(after.usage_guide,before.usage_guide);
  assert.deepEqual(after.delivery_options,before.delivery_options); assert.equal(after.content_blocks.length,5);
  for(const [i,m] of after.media.entries()) { assert.notEqual(m.key,before.media[i].key); assert.deepEqual(media.objects.get(m.key),new Uint8Array([i+1,2,3,4])); }
  for(const model of after.options) for(const method of [null,'sea','land','air']) {
    const quote=resolveUnitPrice({product:after,optionId:model.id,transportMethod:method,tier:'free',tierActive:false});
    const prior=resolveUnitPrice({product:before,optionId:model.id,transportMethod:method,tier:'free',tierActive:false});
    assert.equal(quote.unit_subtotal_iqd,prior.unit_subtotal_iqd); assert.deepEqual(quote.errors,[]);
  }
  evidence('lifecycle.json',{deletion:report,after_delete_counts:verifiedCounts,owned_old_r2_keys_remaining:before.media.filter(m=>media.objects.has(m.key)).length,historical_orders:1,reimport:{success:true,fresh_product_id:result.product_id!==id,same_slug:after.slug===before.slug,models:after.options.length,colors:after.colors.length,images:after.media.length,spec_rows:after.spec_groups[0].rows.length,warranty_plans:after.warranty_plans.length,content_blocks:after.content_blocks.length,usage_steps:after.usage_guide.steps.length,delivery_options:after.delivery_options},schema:productDependencyGraph(await productSchema(db))});
});

test('D1 failure and a concurrent child write both abort deletion before any R2 delete',async()=>{
  const {raw,env,media}=setup();
  raw.prepare("INSERT INTO products(id,slug,name,price_iqd,images) VALUES ('p','p','P',10,'[\"/files/products/p/x.webp\"]')").run();
  media.objects.set('products/p/x.webp',new Uint8Array([1]));
  const {db,failing}=failingD1(raw);env.DB=db;
  failing.failWhen=stmts=>stmts.some(s=>s.sql.startsWith('DELETE FROM "products"'));
  await assert.rejects(deleteProductPermanently(env,'p','owner'));
  assert.equal(row(raw,"SELECT COUNT(*) n FROM products WHERE id='p'")?.n,1);assert.equal(media.objects.size,1);
  failing.failWhen=null;
  failing.beforeBatch=()=>{ failing.beforeBatch=null;raw.prepare("INSERT INTO product_images(id,product_id,url) VALUES ('new','p','/files/products/p/concurrent.webp')").run(); };
  await assert.rejects(deleteProductPermanently(env,'p','owner'));
  assert.equal(row(raw,"SELECT COUNT(*) n FROM products WHERE id='p'")?.n,1);
  assert.equal(row(raw,'SELECT COUNT(*) n FROM product_deletion_jobs')?.n,0);assert.equal(media.objects.size,1);
});

test('R2 cleanup lock prevents new references during retries', async()=>{
  const {raw,env,media}=setup();
  raw.prepare("INSERT INTO products(id,slug,name,price_iqd,images) VALUES ('a','a','A',10,'[\"/files/products/a/x.webp\"]')").run();
  media.objects.set('products/a/x.webp',new Uint8Array([1]));media.fail=true;
  const report=await deleteProductPermanently(env,'a','owner');assert.equal(report.r2_cleanup_pending,1);
  assert.throws(()=>raw.prepare("INSERT INTO products(id,slug,name,price_iqd,images) VALUES ('b','b','B',10,'[\"/files/products/a/x.webp\"]')").run(),/MEDIA_KEY/);
  media.fail=false;assert.equal((await processProductMediaCleanup(env,report.deletion_job_id!)).deleted,1);
});

test('orphan dry run finds grandchildren and excludes a file newly referenced before confirmation',async()=>{
  const {raw,env,media}=setup();raw.exec('PRAGMA foreign_keys=OFF');
  raw.prepare("INSERT INTO product_option_groups(id,product_id,name_en) VALUES ('orphan-group','missing','Model')").run();
  raw.prepare("INSERT INTO product_option_values(id,product_id,group_id,name_en,image) VALUES ('orphan-option','missing','orphan-group','Model','/files/products/orphan/x.webp')").run();
  raw.prepare("INSERT INTO product_colors(id,product_id,name_en,hex) VALUES ('orphan-color','missing','Black','#000000')").run();
  raw.prepare("INSERT INTO product_images(id,product_id,url,r2_key) VALUES ('orphan-image','missing','/files/products/orphan/x.webp','products/orphan/x.webp')").run();
  raw.prepare("INSERT INTO product_color_option_links(color_id,option_value_id,group_id) VALUES ('orphan-color','orphan-option','orphan-group')").run();raw.exec('PRAGMA foreign_keys=ON');
  media.objects.set('products/orphan/x.webp',new Uint8Array([1,2,3]));
  const report=await scanProductOrphans(env,'owner');
  assert.equal(report.tables.find(t=>t.table==='product_color_option_links')?.orphan_rows,1);assert.equal(report.bytes,3);
  assert.equal(report.tables.find(t=>t.table==='product_images')?.orphan_rows,1);
  evidence('orphan-dry-run-fixture.json',report);
  raw.prepare("INSERT INTO products(id,slug,name,price_iqd,images) VALUES ('live','live','Live',10,'[\"/files/products/orphan/x.webp\"]')").run();
  await confirmProductOrphanCleanup(env,report.scan_id,'owner');
  assert.equal(media.objects.size,1);assert.equal(row(raw,'SELECT COUNT(*) n FROM product_color_option_links')?.n,0);
  assert.equal(row(raw, 'SELECT COUNT(*) n FROM product_images')?.n, 0);
});
