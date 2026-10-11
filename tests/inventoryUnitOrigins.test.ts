import {test} from 'node:test';
import assert from 'node:assert/strict';
import {freshDb,asD1} from './fixtures/app';
import {planLotConsumption,planLotRestore,cogsByLine} from '../worker/lib/inventoryLots';
import {normalizeUnitOrigins,planCreateUnitOrigins,planReceiveUnitOrigins,planMoveUnitOrigins,availableLotOrigins,resolveReturnedOriginIds,planUnsellableOriginReturn} from '../worker/lib/inventoryUnitOrigins';
import type {StockMove} from '../worker/lib/inventory';

function setup() {
 const raw=freshDb(),db=asD1(raw);
 raw.exec(`INSERT INTO users(id,name,email,password_hash,role) VALUES ('buyer','Buyer','buyer@x.t','h','customer');
 INSERT INTO products(id,name,slug,price_iqd,inventory_mode,stock) VALUES ('product','A1','a1',2000,'BASE',10);
 INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd)
 VALUES ('order','buyer','pending','{}','std','{}','cod',10000,1400,10000,10000),('other','buyer','pending','{}','std','{}','cod',10000,1400,10000,10000);
 INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd)
 VALUES ('line','order','product','A1',10,2000,20000),('line2','other','product','A1',10,2000,20000);`);
 return {raw,db};
}
const move=(qty:number,line='line'):StockMove=>({product_id:'product',line_id:line,qty,targets:[{scope:'base',scope_id:'',stock:10,reserved:0,low_stock_threshold:null,label:'A1'}]});
async function received(ctx:ReturnType<typeof setup>,id:string,qty:number,cost:number,date:string,tracked=true) {
 ctx.raw.prepare(`INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,cost_basis,received_at)
 VALUES (?,'product','base','',?,?,?,'received',?)`).run(id,qty,qty,cost,date);
 if(tracked){
  await ctx.db.batch(planCreateUnitOrigins(ctx.db,{incomingId:`in_${id}`,purchaseLineId:`pl_${id}`,purchaseId:`po_${id}`,actorId:'admin',units:normalizeUnitOrigins(Array.from({length:qty},(_,i)=>({unit_index:i+1,supplier_order_no:`supplier-${id}-${i+1}`,tracking_no:`track-${i+1}`})),qty)}));
  await ctx.db.batch(await planReceiveUnitOrigins(ctx.db,{incomingId:`in_${id}`,lotId:id,qty}));
 }
}

test('2 + 3 + 5 FIFO records exact piece provenance across cost layers without changing COGS',async()=>{
 const ctx=setup();try{
  await received(ctx,'lot1',2,100,'2026-01-01');await received(ctx,'lot2',3,150,'2026-02-01');await received(ctx,'lot3',5,200,'2026-03-01');
  const plan=await planLotConsumption(ctx.db,'order',[move(7)]);await ctx.db.batch(plan.statements);
  assert.deepEqual(ctx.raw.prepare('SELECT lot_id,COUNT(*) AS qty FROM order_item_inventory_unit_assignments GROUP BY lot_id ORDER BY lot_id').all().map(r=>({...r})),[{lot_id:'lot1',qty:2},{lot_id:'lot2',qty:3},{lot_id:'lot3',qty:2}]);
  const units=ctx.raw.prepare('SELECT unit_index,supplier_order_no FROM order_item_inventory_unit_assignments ORDER BY unit_index').all();
  assert.deepEqual(units.map(u=>u.unit_index),[1,2,3,4,5,6,7]);assert.equal(units[2].supplier_order_no,'supplier-lot2-1');
  assert.equal((await cogsByLine(ctx.db,['order'])).get('line')?.cogs_iqd,1050);
  assert.equal((await planLotConsumption(ctx.db,'order',[move(7)])).statements.length,0);
 }finally{ctx.raw.close();}
});
test('two preplanned sales cannot allocate the same individual unit; loser rolls its batch back',async()=>{
 const ctx=setup();try{
  await received(ctx,'lot1',2,100,'2026-01-01');
  const first=await planLotConsumption(ctx.db,'order',[move(1)]),racing=await planLotConsumption(ctx.db,'other',[move(1,'line2')]);
  await ctx.db.batch(first.statements);await assert.rejects(()=>ctx.db.batch(racing.statements));
  assert.equal(ctx.raw.prepare('SELECT qty_remaining FROM inventory_lots WHERE id=?').get('lot1')?.qty_remaining,1);
  assert.equal(ctx.raw.prepare('SELECT COUNT(*) AS n FROM order_item_inventory_allocations WHERE order_id=?').get('other')?.n,0);
  await ctx.db.batch((await planLotConsumption(ctx.db,'other',[move(1,'line2')])).statements);
  assert.equal(ctx.raw.prepare('SELECT COUNT(DISTINCT origin_id) AS n FROM order_item_inventory_unit_assignments').get()?.n,2);
 }finally{ctx.raw.close();}
});
test('specific returned piece restores its original cost lot; history survives return, replay and resale',async()=>{
 const ctx=setup();try{
  await received(ctx,'lot1',1,100,'2026-01-01');await received(ctx,'lot2',2,150,'2026-02-01');
  await ctx.db.batch((await planLotConsumption(ctx.db,'order',[move(3)])).statements);
  await assert.rejects(()=>resolveReturnedOriginIds(ctx.db,{orderId:'order',itemId:'line',qty:1}),/حدد القطعة/);
  const origin=String(ctx.raw.prepare('SELECT origin_id FROM order_item_inventory_unit_assignments WHERE unit_index=3').get()?.origin_id);
  const ids=await resolveReturnedOriginIds(ctx.db,{orderId:'order',itemId:'line',qty:1,originIds:[origin]});
  await ctx.db.batch((await planLotRestore(ctx.db,'order',{qtyByLine:{line:1},operation:'return:case1',originIds:ids?.originIds,allocationQty:ids?.allocationQty})).statements);
  assert.equal(ctx.raw.prepare('SELECT qty_remaining FROM inventory_lots WHERE id=?').get('lot2')?.qty_remaining,1);
  assert.equal(ctx.raw.prepare('SELECT qty_remaining FROM inventory_lots WHERE id=?').get('lot1')?.qty_remaining,0);
  assert.equal((await cogsByLine(ctx.db,['order'])).get('line')?.cogs_iqd,250);
  assert.equal((await planLotRestore(ctx.db,'order',{qtyByLine:{line:1},operation:'return:case1',originIds:ids?.originIds,allocationQty:ids?.allocationQty})).statements.length,0);
  await ctx.db.batch((await planLotConsumption(ctx.db,'other',[move(1,'line2')])).statements);
  assert.equal(ctx.raw.prepare('SELECT COUNT(*) AS n FROM order_item_inventory_unit_assignments WHERE origin_id=?').get(origin)?.n,2);
  assert.equal(ctx.raw.prepare('SELECT COUNT(*) AS n FROM order_item_inventory_unit_assignments WHERE origin_id=? AND released_at IS NULL').get(origin)?.n,1);
 }finally{ctx.raw.close();}
});
test('out-of-order receiving, transfer, write-off, and unsellable return preserve known identities',async()=>{
 const ctx=setup();try{
  await received(ctx,'lot1',3,100,'2026-01-01',false);
  await ctx.db.batch(planCreateUnitOrigins(ctx.db,{incomingId:'in',purchaseLineId:'pl',purchaseId:'po',actorId:'admin',units:normalizeUnitOrigins([1,2,3].map(i=>({unit_index:i,supplier_order_no:`PO${i}`,tracking_no:''})),3)}));
  const all=ctx.raw.prepare('SELECT id FROM inventory_unit_origins ORDER BY unit_index').all().map(r=>String(r.id));
  await ctx.db.batch(await planReceiveUnitOrigins(ctx.db,{incomingId:'in',lotId:'lot1',qty:1,originIds:[all[2]]}));
  await ctx.db.batch(await planReceiveUnitOrigins(ctx.db,{incomingId:'in',lotId:'lot1',qty:2,originIds:all.slice(0,2)}));
  await received(ctx,'child',1,100,'2026-01-01',false);
  await ctx.db.batch(await planMoveUnitOrigins(ctx.db,{lotId:'lot1',qty:1,targetLotId:'child'}));
  ctx.raw.exec("UPDATE inventory_lots SET qty_remaining=qty_remaining-1 WHERE id='lot1'");
  assert.equal((await availableLotOrigins(ctx.db,'child'))[0].id,all[0]);
  assert.equal(ctx.raw.prepare('SELECT received_lot_id FROM inventory_unit_origins WHERE id=?').get(all[0])?.received_lot_id,'lot1');
  await ctx.db.batch(await planMoveUnitOrigins(ctx.db,{lotId:'lot1',qty:1,reason:'damaged'}));
  assert.equal(ctx.raw.prepare('SELECT unavailable_reason FROM inventory_unit_origins WHERE id=?').get(all[1])?.unavailable_reason,'damaged');
  ctx.raw.exec("UPDATE inventory_lots SET qty_remaining=qty_remaining-1 WHERE id='lot1'");
  await ctx.db.batch((await planLotConsumption(ctx.db,'order',[move(2)])).statements);
  await ctx.db.batch(await planUnsellableOriginReturn(ctx.db,{orderId:'order',itemId:'line',qty:2,reason:'return_unsellable:test'}));
  assert.equal((await availableLotOrigins(ctx.db,'child')).length,0);
  assert.equal(ctx.raw.prepare('SELECT unavailable_reason FROM inventory_unit_origins WHERE id=?').get(all[0])?.unavailable_reason,'return_unsellable:test');
 }finally{ctx.raw.close();}
});
test('legacy stock does not acquire invented supplier identities and invalid opt-in is rejected',async()=>{
 const ctx=setup();try{
  await received(ctx,'old',2,100,'2026-01-01',false);
  await ctx.db.batch((await planLotConsumption(ctx.db,'order',[move(1)])).statements);
  assert.equal(ctx.raw.prepare('SELECT COUNT(*) AS n FROM inventory_unit_origins').get()?.n,0);
  assert.equal(ctx.raw.prepare('SELECT COUNT(*) AS n FROM order_item_inventory_unit_assignments').get()?.n,0);
  assert.throws(()=>normalizeUnitOrigins([{unit_index:1,supplier_order_no:''}],1));
  assert.throws(()=>normalizeUnitOrigins([{unit_index:1,supplier_order_no:'PO'}],2));
  assert.deepEqual(normalizeUnitOrigins(undefined,10000),[]);
 }finally{ctx.raw.close();}
});

test('mixed legacy and tracked line restores explicitly identified legacy slot without releasing tracked origin',async()=>{
 const ctx=setup();try{
  await received(ctx,'legacy',1,100,'2026-01-01',false);await received(ctx,'tracked',2,150,'2026-02-01');
  await ctx.db.batch((await planLotConsumption(ctx.db,'order',[move(3)])).statements);
  ctx.raw.exec(`INSERT INTO order_item_units(id,order_id,order_item_id,owner_user_id,unit_index,inventory_lot_id) VALUES ('legacy-unit','order','line','buyer',1,'legacy'),('tracked-unit','order','line','buyer',2,'tracked')`);
  const selection=await resolveReturnedOriginIds(ctx.db,{orderId:'order',itemId:'line',qty:1,unitIds:['legacy-unit']});
  assert.deepEqual(selection?.originIds,[]);
  await ctx.db.batch((await planLotRestore(ctx.db,'order',{qtyByLine:{line:1},operation:'return:legacy',originIds:selection?.originIds,allocationQty:selection?.allocationQty})).statements);
  assert.equal(ctx.raw.prepare('SELECT qty_remaining FROM inventory_lots WHERE id=?').get('legacy')?.qty_remaining,1);
  assert.equal(ctx.raw.prepare('SELECT qty_remaining FROM inventory_lots WHERE id=?').get('tracked')?.qty_remaining,0);
  assert.equal(ctx.raw.prepare('SELECT COUNT(*) AS n FROM order_item_inventory_unit_assignments WHERE released_at IS NULL').get()?.n,2);
 }finally{ctx.raw.close();}
});
test('receipt identity and verified provenance cannot be silently rewritten',async()=>{
 const ctx=setup();try{
  await received(ctx,'tracked',1,100,'2026-01-01');
  await ctx.db.batch((await planLotConsumption(ctx.db,'order',[move(1)])).statements);
  assert.throws(()=>ctx.raw.exec("UPDATE inventory_unit_origins SET unit_index=2"),/immutable/);
  assert.throws(()=>ctx.raw.exec("DELETE FROM inventory_unit_origins"),/cannot be deleted/);
  assert.throws(()=>ctx.raw.exec("UPDATE order_item_inventory_unit_assignments SET supplier_order_no='WRONG'"),/immutable/);
  ctx.raw.exec("UPDATE inventory_unit_origins SET serial_norm='KNOWN123'; UPDATE order_item_inventory_unit_assignments SET physical_verified_at='2026-10-11',verified_serial_norm='KNOWN123',verified_by='admin'");
  assert.throws(()=>ctx.raw.exec("UPDATE inventory_unit_origins SET serial_norm='OTHER123'"),/immutable/);
  assert.throws(()=>ctx.raw.exec("UPDATE order_item_inventory_unit_assignments SET verified_serial_norm='OTHER123'"),/immutable/);
 }finally{ctx.raw.close();}
});
test('stale exact-piece return refuses before restoring another piece in the same lot',async()=>{
 const ctx=setup();try{
  await received(ctx,'tracked',2,100,'2026-01-01');
  await ctx.db.batch((await planLotConsumption(ctx.db,'order',[move(2)])).statements);
  const origin=String(ctx.raw.prepare('SELECT origin_id FROM order_item_inventory_unit_assignments ORDER BY unit_index LIMIT 1').get()?.origin_id);
  const selection=await resolveReturnedOriginIds(ctx.db,{orderId:'order',itemId:'line',qty:1,originIds:[origin]});
  const options={qtyByLine:{line:1},originIds:selection?.originIds,allocationQty:selection?.allocationQty};
  await ctx.db.batch((await planLotRestore(ctx.db,'order',{...options,operation:'return:first'})).statements);
  await assert.rejects(()=>planLotRestore(ctx.db,'order',{...options,operation:'return:second'}),/تغيرت القطع/);
  await assert.rejects(()=>planUnsellableOriginReturn(ctx.db,{orderId:'order',itemId:'line',qty:1,reason:'return_unsellable:second',originIds:selection?.originIds}),/تغيرت القطع/);
  assert.equal(ctx.raw.prepare('SELECT qty_remaining FROM inventory_lots').get()?.qty_remaining,1);
 }finally{ctx.raw.close();}
});
