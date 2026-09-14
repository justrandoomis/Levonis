/** Integration proof against Cloudflare's local workerd D1/R2 bindings.
 * No production credentials or resources are read or changed. */
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import assert from 'node:assert/strict';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { splitStatements } from './lib/sql-split.mjs';
const { deleteProductPermanently, processProductMediaCleanup } = await import(new URL('../worker/lib/productDeletion.ts', import.meta.url).href);

const runtime = new Miniflare(convertV4MiniflareOptions({ modules:true, script:'export default {fetch(){return new Response("Product lifecycle verification")}}', compatibilityDate:'2026-08-01', d1Databases:['DB'], r2Buckets:['BUCKET'], cf:false }));
try {
  const DB=await runtime.getD1Database('DB'); const BUCKET=await runtime.getR2Bucket('BUCKET');
  const env={DB,BUCKET,APP_ORIGIN:'https://levonis-iq.com'};
  for(const name of (await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort()) {
    const statements=splitStatements(await readFile(`migrations/${name}`,'utf8'));
    await DB.batch(statements.map(s=>DB.prepare(s)));
  }
  const run=(sql,...args)=>DB.prepare(sql).bind(...args).run();
  const count=async(table,id)=>Number((await DB.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${table==='products' ? 'id' : 'product_id'}=?`).bind(id).first()).n);
  await run("INSERT INTO users(id,email) VALUES ('proof-user','local-proof@example.test')");
  const product=async id=>run('INSERT INTO products(id,slug,name,price_iqd) VALUES (?,?,?,100000)',id,id,id);
  const image=async(id,productId,key)=>{await BUCKET.put(key,new Uint8Array([1,2,3,4]));await run('INSERT INTO product_images(id,product_id,url,r2_key) VALUES (?,?,?,?)',id,productId,`/files/${key}`,key);};
  await product('proof-product');
  await run("INSERT INTO product_option_groups(id,product_id,name_en) VALUES ('g','proof-product','Model')");
  for(let i=0;i<2;i++) {
    await run('INSERT INTO product_option_values(id,product_id,group_id,name_en) VALUES (?,?,?,?)',`m${i}`,'proof-product','g',`Model ${i}`);
    for(const type of ['direct_sale','pre_order']) await run('INSERT INTO product_option_fulfillment(id,product_id,option_id,fulfillment_type,enabled,stock) VALUES (?,?,?,?,1,5)',`f${i}-${type}`,'proof-product',`m${i}`,type);
  }
  for(const method of ['air','sea','land']) await run('INSERT INTO product_option_transports(id,product_id,option_id,fulfillment_id,method,enabled,surcharge_iqd) VALUES (?,?,?,?,?,1,30000)',method,'proof-product','m0','f0-pre_order',method);
  for(let i=0;i<3;i++) await run('INSERT INTO product_colors(id,product_id,name_en,hex) VALUES (?,?,?,?)',`c${i}`,'proof-product',`Color ${i}`,'#000000');
  const specs=[{id:'specs',rows:Array.from({length:39},(_,i)=>({id:`spec${i}`,label_en:`Spec ${i}`,value_en:String(i)}))}];
  const blocks=Array.from({length:5},(_,i)=>({id:`b${i}`,kind:'image',media_key:`products/proof/blocks/${i}.webp`}));
  const usage={steps:Array.from({length:10},(_,i)=>({id:`u${i}`,kind:'setup',title:`Step ${i}`,images:[`/files/products/proof/usage/${i}.webp`]}))};
  await run('UPDATE products SET specifications=?,warranty_plans=?,content_blocks=?,usage_guide=?,preorder_transports=?,ops_policy=? WHERE id=?',JSON.stringify(specs),JSON.stringify([12,24].map(n=>({id:`w${n}`,duration_months:n,active:true}))),JSON.stringify(blocks),JSON.stringify(usage),JSON.stringify(['air','sea','land'].map(method=>({method,active:true,commission_iqd:30000}))),JSON.stringify({standard_delivery_enabled:true,standard_delivery_quantity_step:2,standard_delivery_fee_iqd:10000,personal_delivery_enabled:true,personal_delivery_quantity_step:1,personal_delivery_fee_iqd:25000}),'proof-product');
  for(let i=0;i<5;i++) await image(`image${i}`,'proof-product',`products/proof/gallery/${i}.webp`);
  for(const b of blocks) await BUCKET.put(b.media_key,new Uint8Array([1,2,3,4]));
  for(const s of usage.steps) await BUCKET.put(s.images[0].slice(7),new Uint8Array([1,2,3,4]));
  await run("INSERT INTO cart_items(id,user_id,product_id,qty) VALUES ('cart','proof-user','proof-product',1)");
  await run("INSERT INTO favorites(user_id,product_id) VALUES ('proof-user','proof-product')");
  await run("INSERT INTO orders(id,user_id,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd) VALUES ('order','proof-user','{}','standard','{}','cash',100000,1400,100000,100000)");
  await run("INSERT INTO order_items(id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd) VALUES ('item','order','proof-product','Historical product','Historical model',1,100000,100000)");
  const deletion=await deleteProductPermanently(env,'proof-product','proof-user');
  const after={};
  for(const table of Object.keys(deletion.rows_deleted_by_table)) {after[table]=await count(table,'proof-product').catch(async()=>Number((await DB.prepare(`SELECT COUNT(*) n FROM ${table}`).first()).n));assert.equal(after[table],0,table);}
  if(deletion.r2_objects_deleted!==20) console.error(JSON.stringify({deletion,jobs:(await DB.prepare('SELECT status,last_error FROM media_cleanup_jobs').all()).results},null,2));
  assert.equal(deletion.r2_objects_deleted,20);assert.equal(deletion.r2_cleanup_pending,0);
  assert.equal((await BUCKET.list({prefix:'products/proof/'})).objects.length,0);
  assert.equal((await DB.prepare("SELECT name_snapshot FROM order_items WHERE id='item'").first()).name_snapshot,'Historical product');
  assert.equal((await deleteProductPermanently(env,'proof-product','proof-user')).already_deleted,true);
  await product('a');await product('b');await image('ia','a','products/shared.webp');await image('ib','b','products/shared.webp');
  const sharedA=await deleteProductPermanently(env,'a','proof-user');assert.ok(await BUCKET.head('products/shared.webp'));
  const sharedB=await deleteProductPermanently(env,'b','proof-user');assert.equal(await BUCKET.head('products/shared.webp'),null);
  await product('retry');await image('retry-image','retry','products/retry.webp');
  const failingBucket={head:BUCKET.head.bind(BUCKET),get:BUCKET.get.bind(BUCKET),delete:async()=>{throw new Error('injected R2 failure');}};
  const failed=await deleteProductPermanently({...env,BUCKET:failingBucket},'retry','proof-user');
  assert.equal(await count('products','retry'),0);assert.equal(failed.r2_cleanup_pending,1);
  const retried=await processProductMediaCleanup(env,failed.deletion_job_id);assert.equal(retried.pending,0);assert.equal(await BUCKET.head('products/retry.webp'),null);
  const proof={runtime:'Cloudflare local workerd / Miniflare D1 and R2 bindings',production_modified:false,checked_at:new Date().toISOString(),full_fixture:{models:2,colors:3,images:5,specs:39,warranty_plans:2,content_blocks:5,usage_steps:10,transports:3,owned_r2_objects:20},deletion,rows_after_delete:after,r2_objects_after_delete:0,historical_orders:1,historical_order_items:1,idempotency:true,shared_image:{after_a:sharedA.r2_objects_shared_skipped,after_b:sharedB.r2_objects_deleted},r2_failure:{product_rows:0,pending_before_retry:failed.r2_cleanup_pending,pending_after_retry:retried.pending}};
  await mkdir('docs/verification',{recursive:true});await writeFile('docs/verification/product-lifecycle-workerd.json',JSON.stringify(proof,null,2)+'\n');
  console.log(JSON.stringify(proof,null,2));
} finally { await runtime.dispose(); }
