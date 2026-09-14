import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, row } from './fixtures/app';
import { deleteProductPermanently, processProductMediaCleanup, ownedMediaKeys } from '../worker/lib/productDeletion';
import { scanProductOrphans, confirmProductOrphanCleanup } from '../worker/lib/productOrphans';
import type { Env } from '../worker/lib/types';

class Bucket {
  objects = new Map<string, number>();
  fail = false;
  async head(key: string) { return this.objects.has(key) ? { key, size: this.objects.get(key)! } : null; }
  async delete(key: string) { if (this.fail) throw new Error('injected R2 failure'); this.objects.delete(key); }
  async list(input: { prefix?: string; cursor?: string; limit?: number } = {}) {
    const all = [...this.objects].filter(([k]) => k.startsWith(input.prefix ?? '')).map(([key,size]) => ({key,size}));
    const start = Number(input.cursor ?? 0); const end = start + (input.limit ?? 1000);
    return { objects: all.slice(start,end), truncated: end < all.length, cursor: String(end) };
  }
}
function setup() {
  const raw = freshDb(); const bucket = new Bucket();
  const env = { DB: asD1(raw), BUCKET: bucket, APP_ORIGIN: 'https://levonis-iq.com' } as unknown as Env;
  const product = (id: string) => raw.prepare('INSERT INTO products(id,slug,name,price_iqd) VALUES (?,?,?,100000)').run(id,id,id);
  const image = (id: string, productId: string, key: string) => { raw.prepare('INSERT INTO product_images(id,product_id,url,r2_key) VALUES (?,?,?,?)').run(id,productId,`/files/${key}`,key); bucket.objects.set(key,1024); };
  return {raw,bucket,env,product,image};
}

test('permanent delete removes the product and owned relationships, keeps order/review history, and is idempotent', async () => {
  const {raw,bucket,env,product,image} = setup(); product('p');
  raw.prepare("INSERT INTO users(id,email,name) VALUES ('u','u@test.com','User')").run();
  raw.prepare("INSERT INTO orders(id,user_id,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd) VALUES ('o','u','{}','d','{}','cash',100000,1400,100000,100000)").run();
  raw.prepare("INSERT INTO order_items(id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd) VALUES ('oi','o','p','Historical product','Historical model',1,100000,100000)").run();
  raw.prepare("INSERT INTO reviews(id,user_id,product_id,order_item_id,stars,body) VALUES ('review','u','p','oi',5,'Historical review')").run();
  raw.prepare("INSERT INTO product_option_groups(id,product_id,name_en) VALUES ('g','p','Model')").run();
  for(let i=0;i<2;i++) {
    raw.prepare('INSERT INTO product_option_values(id,product_id,group_id,name_en) VALUES (?,?,?,?)').run(`opt${i}`,'p','g',`Model ${i}`);
    for(const type of ['direct_sale','pre_order']) raw.prepare('INSERT INTO product_option_fulfillment(id,product_id,option_id,fulfillment_type) VALUES (?,?,?,?)').run(`f${i}${type}`,'p',`opt${i}`,type);
  }
  for(let i=0;i<3;i++) raw.prepare('INSERT INTO product_colors(id,product_id,name_en,hex) VALUES (?,?,?,?)').run(`c${i}`,'p',`Color ${i}`,'#000000');
  for(let i=0;i<5;i++) image(`im${i}`,'p',`products/p/gallery/${i}.webp`);
  raw.prepare("INSERT INTO favorites(user_id,product_id) VALUES ('u','p')").run();
  raw.prepare("INSERT INTO cart_items(id,user_id,product_id,qty) VALUES ('cart','u','p',1)").run();
  raw.prepare("INSERT INTO price_history(product_id,field,new_iqd) VALUES ('p','regular',100000)").run();
  const r = await deleteProductPermanently(env,'p','u');
  assert.equal(r.product_deleted,true);
  for(const t of ['products','product_option_groups','product_option_values','product_colors','product_images','product_option_fulfillment','cart_items','favorites','price_history']) assert.equal(row(raw,`SELECT COUNT(*) n FROM ${t}`)?.n,0,t);
  assert.equal(bucket.objects.size,0); assert.equal(r.r2_objects_deleted,5); assert.equal(r.r2_cleanup_pending,0);
  assert.equal(row(raw,'SELECT name_snapshot FROM order_items WHERE id=?','oi')?.name_snapshot,'Historical product');
  assert.equal(row(raw,'SELECT product_id FROM reviews WHERE id=?','review')?.product_id,null);
  assert.equal((await deleteProductPermanently(env,'p','u')).already_deleted,true);
  product('p-new'); raw.prepare("UPDATE products SET slug='p' WHERE id='p-new'").run();
});

test('shared image survives A and is deleted after B', async () => {
  const {env,bucket,product,image}=setup(); product('a');product('b');image('ia','a','products/shared/image.webp');image('ib','b','products/shared/image.webp');
  const a=await deleteProductPermanently(env,'a','owner');assert.equal(a.r2_objects_shared_skipped,1);assert.equal(bucket.objects.size,1);
  const b=await deleteProductPermanently(env,'b','owner');assert.equal(b.r2_objects_deleted,1);assert.equal(bucket.objects.size,0);
});

test('R2 failure commits DB deletion and leaves a retry job', async () => {
  const {raw,env,bucket,product,image}=setup();product('p');image('i','p','products/p/image.webp');bucket.fail=true;
  const r=await deleteProductPermanently(env,'p','owner');assert.equal(row(raw,'SELECT COUNT(*) n FROM products')?.n,0);assert.equal(r.r2_cleanup_pending,1);
  bucket.fail=false;assert.equal((await processProductMediaCleanup(env,r.deletion_job_id!)).deleted,1);assert.equal(bucket.objects.size,0);
});

test('old orphan dry run does not delete; confirmation cleans only reviewed unused data', async () => {
  const {raw,env,bucket}=setup();raw.exec('PRAGMA foreign_keys=OFF');
  raw.prepare("INSERT INTO product_images(id,product_id,url,r2_key) VALUES ('orphan-image','missing','/files/products/missing/image.webp','products/missing/image.webp')").run();
  raw.prepare("INSERT INTO product_option_values(id,product_id,group_id,name_en) VALUES ('orphan-option','missing','missing-group','Orphan')").run();
  raw.exec('PRAGMA foreign_keys=ON');bucket.objects.set('products/missing/image.webp',1024);bucket.objects.set('products/unused/image.webp',2048);
  const report=await scanProductOrphans(env,'owner');assert.equal(report.tables.find(t=>t.table==='product_images')?.orphan_rows,1);assert.equal(report.tables.find(t=>t.table==='product_option_values')?.orphan_rows,1);assert.equal(report.r2_objects,2);
  assert.equal(bucket.objects.size,2);assert.equal(row(raw,'SELECT COUNT(*) n FROM product_images')?.n,1);
  await confirmProductOrphanCleanup(env,report.scan_id,'owner');assert.equal(bucket.objects.size,0);assert.equal(row(raw,'SELECT COUNT(*) n FROM product_images')?.n,0);assert.equal(row(raw,'SELECT COUNT(*) n FROM product_option_values')?.n,0);
});

test('remote third-party URLs never become deletion keys',()=>{
  assert.deepEqual([...ownedMediaKeys({url:'https://bambulab.com/files/products/p/a.webp'},'https://levonis-iq.com')],[]);
  assert.deepEqual([...ownedMediaKeys({url:'/files/products/p/a.webp'},'https://levonis-iq.com')],['products/p/a.webp']);
});

test('historical image snapshots retain their internal file after permanent product deletion', async () => {
  const {raw,env,bucket,product,image}=setup(); product('p'); image('image','p','products/p/history.webp');
  raw.exec(`
    INSERT INTO users(id,email,name) VALUES ('u','u@test.com','User');
    INSERT INTO orders(id,user_id,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd) VALUES ('o','u','{}','d','{}','cash',100000,1400,100000,100000);
    INSERT INTO order_items(id,order_id,product_id,name_snapshot,option_snapshot,image_snapshot,qty,unit_price_iqd,line_total_iqd) VALUES ('oi','o','p','Historical product','Model','/files/products/p/history.webp',1,100000,100000);
  `);
  const result=await deleteProductPermanently(env,'p','owner');
  assert.equal(result.r2_objects_shared_skipped,1);
  assert.ok(await bucket.head('products/p/history.webp'));
  assert.equal(row(raw,'SELECT image_snapshot FROM order_items')?.image_snapshot,'/files/products/p/history.webp');
  assert.equal((await scanProductOrphans(env,'owner')).r2_objects,0,'history-owned media is not an orphan');
});

test('private product assets and duplicate legacy/public bucket copies cannot resurrect after cleanup', async () => {
  const {raw,env,bucket,product,image}=setup(); product('p'); image('image','p','products/p/model.stl');
  const publicBucket = new Bucket(); const privateBucket = new Bucket();
  publicBucket.objects.set('products/p/model.stl',1024); privateBucket.objects.set('products/p/model.stl',2048);
  env.R2_PUBLIC=publicBucket as unknown as R2Bucket; env.R2_PRIVATE=privateBucket as unknown as R2Bucket;
  raw.exec("INSERT INTO file_objects(object_key,visibility,domain,entity_id,mime_type,byte_size) VALUES ('products/p/model.stl','private','products','p','model/stl',2048)");
  const result=await deleteProductPermanently(env,'p','owner'); assert.equal(result.r2_cleanup_pending,0);
  for (const b of [bucket,publicBucket,privateBucket]) assert.equal(await b.head('products/p/model.stl'),null);
  assert.equal(row(raw,'SELECT COUNT(*) n FROM file_objects')?.n,0);
});
