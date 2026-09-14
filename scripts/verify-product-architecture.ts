/** Local native workerd + D1 + R2 proof. No deployment, real accounts, external
 * network calls or production cleanup. Run with node --import tsx. */
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { completeTxt } from '../tests/fixtures/fullProduct';
import { MemoryMedia } from '../tests/fixtures/media';

const root=resolve(import.meta.dirname,'..');
const bundle=await build({entryPoints:[join(root,'tests/fixtures/productProofWorker.ts')],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
const opts=convertV4MiniflareOptions({host:'127.0.0.1',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2025-04-01',d1Databases:['DB'],r2Buckets:['BUCKET'],cf:false,bindings:{APP_ORIGIN:'https://levonis-iq.com',INITIAL_ADMIN_EMAIL:'owner@test.com'}});
opts.telemetry={enabled:false};
const mf=new Miniflare(opts);
const output=join(root,'docs/evidence/product-architecture');mkdirSync(output,{recursive:true});
try {
  const origin=await mf.ready;
  const call=async(path:string,body?:unknown)=>{
    const r=await fetch(new URL(path,origin),body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal(r.status,200,await r.clone().text());return r;
  };
  const sql=async(statements:Array<{sql:string;args?:unknown[]}>)=>await (await call('/sql',statements)).json() as Array<{results:Record<string,unknown>[]} >;
  // sqlite3.complete_statement handles strings, comments and trigger bodies;
  // splitting a migration on semicolons alone corrupts CREATE TRIGGER.
  const migrations=JSON.parse(execFileSync('python3',['-c',`
import sqlite3,json,sys
from pathlib import Path
out=[]
for p in sorted(Path(sys.argv[1]).glob('*.sql')):
 statements=[];current=''
 for char in p.read_text():
  current+=char
  if char==';' and sqlite3.complete_statement(current):
   statements.append(current.strip());current=''
 out.append({'file':p.name,'statements':statements})
print(json.dumps(out))
`,join(root,'migrations')],{encoding:'utf8',maxBuffer:10*1024*1024})) as Array<{file:string;statements:string[]}>;
  for(const m of migrations) {await sql(m.statements.map(text=>({sql:text}))); if(m.file.startsWith('007')) console.log(`applied ${m.file}`);}
  await sql([{sql:"INSERT INTO users(id,email,name,role) VALUES ('owner','owner@test.com','Owner','admin')"},{sql:"UPDATE catalogs SET is_printer_catalog=1 WHERE slug='printers'"}]);
  const files=new MemoryMedia();const text=completeTxt(files);
  for(const [key,bytes] of files.objects) await call('/r2',{key,bytes:[...bytes]});
  const imported=await (await call('/api/admin/template/apply',{text,mode:'draft',confirm:true})).json() as {product_id:string};
  const id=imported.product_id;assert.ok(id);
  const exported=await (await call(`/api/admin/template/export/${id}`)).text();
  assert.ok(exported.includes('# levonis_asset_v1='));
  await sql([
    {sql:"INSERT INTO cart_items(id,user_id,product_id,option_id,qty) VALUES ('cart','owner',?,'model-1',1)",args:[id]},
    {sql:"INSERT INTO orders(id,user_id,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd) VALUES ('history','owner','{}','standard','{}','cash',549000,1400,549000,549000)"},
    {sql:"INSERT INTO order_items(id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd) VALUES ('line','history',?,'A1 mini','A1 mini',1,549000,549000)",args:[id]},
  ]);
  const deletion=await (await call(`/delete/${id}`,{})).json() as {product_deleted:boolean;r2_cleanup_pending:number;r2_objects_deleted:number};
  assert.equal(deletion.product_deleted,true); if(deletion.r2_cleanup_pending) console.log(JSON.stringify(await sql([{sql:'SELECT status,last_error FROM media_cleanup_jobs'}]))); assert.equal(deletion.r2_cleanup_pending,0);assert.equal(deletion.r2_objects_deleted,5);
  const counts=await (await call(`/counts/${id}`)).json() as Record<string,number>;
  for(const [table,n] of Object.entries(counts)) assert.equal(n,0,table);
  const r2After=await (await call('/r2')).json() as {objects:unknown[]};assert.equal(r2After.objects.length,0);
  const history=await sql([{sql:"SELECT COUNT(*) n FROM order_items WHERE order_id='history'"}]);assert.equal(history[0].results[0].n,1);
  const restored=await (await call('/api/admin/template/apply',{text:exported,mode:'draft',confirm:true})).json() as {product_id:string};assert.notEqual(restored.product_id,id);
  const r2Restored=await (await call('/r2')).json() as {objects:Array<{key:string}>};assert.equal(r2Restored.objects.length,5);
  assert.ok(r2Restored.objects.every(o=>!files.objects.has(o.key)));
  assert.deepEqual((await sql([{sql:'PRAGMA foreign_key_check'}]))[0].results,[]);
  const result={environment:'local Cloudflare workerd + native D1 and R2 bindings (Miniflare)',production:false,migrations:migrations.length,deletion,after_delete_counts:counts,r2_after_delete:r2After,historical_order_items:1,reimport:{success:true,fresh_product_id:restored.product_id!==id,restored_r2_objects:r2Restored.objects.length},foreign_key_violations:0};
  writeFileSync(join(output,'native-d1-r2.json'),JSON.stringify(result,null,2)+'\n');
  // Old orphan proof is a READ-ONLY scan. The fixture alone creates bad rows.
  await assert.rejects(sql([{sql:'PRAGMA defer_foreign_keys=ON'},{sql:"INSERT INTO product_images(id,product_id,url,r2_key) VALUES ('orphan-image','missing','/files/products/orphan/image.webp','products/orphan/image.webp')"}]), /FOREIGN KEY constraint failed/);
  // D1 rightly prevents an orphan INSERT; an unused object is still auditable.
  await call('/r2',{key:'products/unused/orphan.webp',bytes:[1,2,3]});
  const scan=await (await call('/orphans')).json();
  writeFileSync(join(output,'native-orphan-dry-run.json'),JSON.stringify({environment:result.environment,production:false,result:scan},null,2)+'\n');
  console.log(JSON.stringify(result));
} finally {await mf.dispose();}
