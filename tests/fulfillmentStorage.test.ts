import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newSqlite, SqliteD1, ROOT } from './fixtures/d1';
import { loadModelFulfillmentRows, enrichModelFulfillmentValues, modelFulfillmentWriteStatements, mergeFulfillmentWrite, FulfillmentStorageError } from '../worker/lib/fulfillmentStorage';
import type { OptionValueRow } from '../worker/lib/productRelations';
import type { ModelFulfillment } from '../packages/pricing/src/fulfillment';
const migration=readFileSync(join(ROOT,'migrations/0072_model_fulfillment.sql'),'utf8');
function fixture(){
  const raw=newSqlite();raw.exec('CREATE TABLE products(id TEXT PRIMARY KEY); CREATE TABLE product_option_values(id TEXT PRIMARY KEY, product_id TEXT REFERENCES products(id), stock INTEGER);');
  raw.exec("INSERT INTO products VALUES('p'),('other'); INSERT INTO product_option_values VALUES('m','p',5),('old-pre','p',0),('foreign-model','other',2);");
  raw.exec(migration);return{raw,db:new SqliteD1(raw) as unknown as D1Database};
}
const config:ModelFulfillment={direct:{enabled:true,stock:5,regular_price_iqd:549000,cost_iqd:400000},preorder:{enabled:true,regular_price_iqd:499000,transports:{sea:{enabled:true,surcharge_iqd:0,lead_time_min_days:21,lead_time_max_days:28}}}};
const value:OptionValueRow={id:'m',product_id:'p',group_id:'g',name_en:'A1 mini',sku_part:'M',image:'',sort:0,active:1,stock:5,reserved:1,low_stock_threshold:null,regular_price_iqd:499000,prime_price_iqd:null,pro_price_iqd:449000,cost_iqd:400000};
test('schema itself is idempotent, without altering existing models or orders',()=>{
  const{raw}=fixture();try{raw.exec(migration);assert.equal(raw.prepare('SELECT COUNT(*) n FROM product_option_values').get()?.n,3);}finally{raw.close();}
});
test('configuration saves only in the caller transaction and reads back through the real DB',async()=>{
  const{raw,db}=fixture();try{
    const statements=modelFulfillmentWriteStatements(db,'p','m',config);assert.equal(raw.prepare('SELECT COUNT(*) n FROM product_model_fulfillment').get()?.n,0);
    await db.batch(statements);const rows=await loadModelFulfillmentRows(db,['p']);const saved=JSON.parse(rows.configurations[0].config_json);assert.equal(saved.direct.stock,undefined);
    const enriched=enrichModelFulfillmentValues([value],rows);assert.equal(enriched[0].fulfillment?.direct?.stock,5);assert.equal(enriched[0].fulfillment?.preorder?.transports?.sea?.surcharge_iqd,0);
    const updated=enrichModelFulfillmentValues([{...value,stock:3}],rows);assert.equal(updated[0].fulfillment?.direct?.stock,3);
  }finally{raw.close();}
});
test('cross-product model association fails atomically',async()=>{
  const{raw,db}=fixture();try{await assert.rejects(db.batch(modelFulfillmentWriteStatements(db,'p','foreign-model',config)),/OWNER_MISMATCH/);assert.equal(raw.prepare('SELECT COUNT(*) n FROM product_model_fulfillment').get()?.n,0);}finally{raw.close();}
});
test('a subsequent transaction error rolls back fulfillment configuration too',async()=>{
  const{raw,db}=fixture();try{await assert.rejects(db.batch([...modelFulfillmentWriteStatements(db,'p','m',config),db.prepare("INSERT INTO products VALUES('p')")]));assert.equal(raw.prepare('SELECT COUNT(*) n FROM product_model_fulfillment').get()?.n,0);}finally{raw.close();}
});
test('legacy IDs survive while the model list contains only the canonical model',async()=>{
  const{raw,db}=fixture();try{
    await db.batch(modelFulfillmentWriteStatements(db,'p','m',config));raw.prepare('INSERT INTO product_option_legacy_map(legacy_option_id,product_id,model_id,fulfillment_type,original_json) VALUES(?,?,?,?,?)').run('old-pre','p','m','pre_order',JSON.stringify({cost_iqd:123,sku:'original-sku'}));
    const rows=await loadModelFulfillmentRows(db,['p']);assert.doesNotMatch(JSON.stringify(rows.aliases),/cost|original_json/);
    const read=enrichModelFulfillmentValues([value,{...value,id:'old-pre'}],rows);assert.equal(read.length,1);assert.deepEqual(read[0].legacy_fulfillment_ids,[{id:'old-pre',fulfillment_type:'pre_order'}]);
    assert.equal(raw.prepare("SELECT COUNT(*) n FROM product_option_values WHERE id='old-pre'").get()?.n,1);
    assert.throws(()=>raw.exec("UPDATE product_option_legacy_map SET original_json='{}'"),/IMMUTABLE/);
  }finally{raw.close();}
});
test('missing new tables permit an old-schema read; other storage errors do not invent legacy pricing',async()=>{
  const raw=newSqlite();const db=new SqliteD1(raw) as unknown as D1Database;
  try{assert.deepEqual(await loadModelFulfillmentRows(db,['p']),{configurations:[],aliases:[]});}finally{raw.close();}
  const broken={prepare(){throw new Error('connection lost');}} as unknown as D1Database;
  await assert.rejects(loadModelFulfillmentRows(broken,['p']),FulfillmentStorageError);
});
test('corrupt stored configuration fails closed',()=>{
  assert.throws(()=>enrichModelFulfillmentValues([value],{configurations:[{product_id:'p',model_id:'m',config_json:'{"direct":{"enabled":"yes"}}'}],aliases:[]}),FulfillmentStorageError);
});
test('assistant saves cannot write nested costs and retain omitted branches',()=>{
  const r=mergeFulfillmentWrite(config,{direct:{enabled:false,cost_iqd:1}},false);assert.equal(r.config?.direct?.cost_iqd,400000);assert.equal(r.config?.direct?.enabled,false);assert.deepEqual(r.config?.preorder,config.preorder);assert.ok(r.refused.length);
  const clear=mergeFulfillmentWrite(config,null,false);assert.deepEqual(clear.config,config);assert.ok(clear.refused.length);
});
test('price-mode changes replace the old mode while null/zero/false survive patches',()=>{
  const r=mergeFulfillmentWrite(config,{direct:{regular_adjust_iqd:0,enabled:false}},true);assert.equal(r.config?.direct?.regular_price_iqd,null);assert.equal(r.config?.direct?.regular_adjust_iqd,0);assert.equal(r.config?.direct?.enabled,false);
  assert.equal(mergeFulfillmentWrite(r.config,{direct:{regular_price_iqd:500000}},true).config?.direct?.regular_adjust_iqd,null);
});
