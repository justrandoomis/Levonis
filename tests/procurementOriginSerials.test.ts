import {test} from 'node:test';
import assert from 'node:assert/strict';
import {freshDb,asD1,stubApp,post,put,get,json,row,count,failingD1} from './fixtures/app';
import {seed,USERS,SN,SN2,order} from './fixtures/serialPrep';
import {adminProcurementRoutes} from '../worker/routes/adminProcurement';
import {adminProcurementOriginSerialRoutes} from '../worker/routes/adminProcurementOriginSerials';
import {adminOrderSerialRoutes} from '../worker/routes/adminOrderSerials';
import {planLotConsumption} from '../worker/lib/inventoryLots';
import {linkFromInventory} from '../worker/lib/serialInventory';
import {baghdadDay} from '../worker/lib/operations';
import type {StockMove} from '../worker/lib/inventory';

function setup(){
 const raw=freshDb();seed(raw);raw.exec("UPDATE products SET stock=0,inventory_mode='BASE' WHERE id='pA1'");const db=asD1(raw);
 const app=(user=USERS.boss,binding:D1Database=db)=>stubApp(binding,user,a=>{a.route('/api/admin/procurement',adminProcurementOriginSerialRoutes);a.route('/api/admin/procurement',adminProcurementRoutes);a.route('/api/admin/orders',adminOrderSerialRoutes);});
 return {raw,db,app};
}
function purchase(qty=2,serials:string[]=[],status='ordered',cost='final'){
 return {operation_id:crypto.randomUUID(),currency:'IQD',purchase_day:baghdadDay(),invoice_no:'Device shipment',status,cost_state:cost,charges:[],lines:[{product_id:'pA1',scope:'base',scope_id:'',qty_ordered:qty,source_unit_amount:100000,unit_origins:Array.from({length:qty},(_,i)=>({unit_index:i+1,supplier_order_no:`SOURCE-${i+1}`,tracking_no:'',...(serials[i]?{serial_no:serials[i]}:{})}))}]};
}
async function create(w:ReturnType<typeof setup>,body=purchase()){
 const response=await post(w.app(),'/api/admin/procurement/documents',body);assert.equal(response.status,200,await response.clone().text());
 const detail=await json(await get(w.app(),`/api/admin/procurement/documents/${body.operation_id}`));
 return {id:body.operation_id,body,line:detail.lines[0],detail};
}
const url=(p:{id:string},originId:string)=>`/api/admin/procurement/documents/${p.id}/unit-origins/${originId}/serial`;
function balances(w:ReturnType<typeof setup>){return JSON.stringify({product:row(w.raw,"SELECT stock,price_iqd,product_cost_iqd FROM products WHERE id='pA1'"),lots:count(w.raw,'SELECT COUNT(*) n FROM inventory_lots'),ledger:count(w.raw,'SELECT COUNT(*) n FROM inventory_ledger'),journal:count(w.raw,'SELECT COUNT(*) n FROM accounting_entries')});}

test('assistant scans saved final purchase piece immediately; replay/collision/freeze preserve identity and money',async()=>{
 const w=setup(),p=await create(w);const u=p.line.unit_origins;const before=balances(w);
 let response=await post(w.app(USERS.ast),url(p,u[0].id),{code:`SN ${SN}`,source:'camera',expected_serial_norm:null});
 assert.equal(response.status,200,await response.clone().text());const first=await json(response);assert.equal(first.serial_norm,SN);assert.equal(first.version,2);
 assert.equal(row(w.raw,'SELECT serial_norm FROM inventory_unit_origins WHERE id=?',u[0].id)?.serial_norm,SN);
 assert.equal(row(w.raw,'SELECT product_id,source FROM serial_inventory WHERE serial_norm=?',SN)?.product_id,'pA1');
 assert.equal(count(w.raw,'SELECT COUNT(*) n FROM stock_serial_links'),0);assert.equal(balances(w),before);
 response=await post(w.app(USERS.ast),url(p,u[0].id),{code:SN,source:'camera',expected_serial_norm:null});assert.equal(response.status,200);assert.equal((await json(response)).already,true);
 assert.equal(row(w.raw,'SELECT version FROM purchase_orders WHERE id=?',p.id)?.version,2);
 response=await post(w.app(USERS.ast),url(p,u[1].id),{code:SN});assert.equal(response.status,409);
 response=await post(w.app(USERS.ast),url(p,u[0].id),{code:SN2});assert.equal(response.status,409);assert.equal((await json(response)).code,'INVENTORY_ORIGIN_SERIAL_LOCKED');
 response=await put(w.app(),`/api/admin/procurement/documents/${p.id}`,{...p.body,version:2});assert.equal(response.status,409);assert.equal((await json(response)).code,'PURCHASE_SERIALS_FROZEN');
 assert.equal(count(w.raw,'SELECT COUNT(*) n FROM inventory_unit_origins'),2);assert.equal(balances(w),before);
 w.raw.close();
});

test('serial binding requires confirmed final costs and allowed receive permission; customers cannot enroll',async()=>{
 const w=setup();
 for(const [status,cost,expected] of [['draft','final','PURCHASE_SERIAL_REQUIRES_CONFIRM'],['ordered','estimated','PURCHASE_SERIAL_REQUIRES_FINAL_COST']]){
  const p=await create(w,purchase(1,[],status,cost));
  const response=await post(w.app(USERS.ast),url(p,p.line.unit_origins[0].id),{code:SN});assert.equal(response.status,409,await response.clone().text());assert.equal((await json(response)).code,expected);
  const serialDraft=await post(w.app(),'/api/admin/procurement/documents',purchase(1,[SN],status,cost));assert.equal(serialDraft.status,400,await serialDraft.clone().text());assert.equal((await json(serialDraft)).code,expected);
 }
 const p=await create(w,purchase(1));
 assert.equal((await post(w.app(USERS.u1),url(p,p.line.unit_origins[0].id),{code:SN})).status,403);
 w.raw.prepare("INSERT INTO ops_permissions(user_id,capability,allowed) VALUES ('ast','receive',0)").run();
 assert.equal((await post(w.app(USERS.ast),url(p,p.line.unit_origins[0].id),{code:SN})).status,403);
 assert.equal(count(w.raw,'SELECT COUNT(*) n FROM serial_inventory'),0);w.raw.close();
});

test('confirmed purchase serial follows its exact receipt lot and order unit; customer legacy auto-link cannot claim it',async()=>{
 const w=setup(),p=await create(w,purchase(2,[SN,SN2]));
 assert.equal(count(w.raw,'SELECT COUNT(*) n FROM serial_inventory'),2);
 assert.equal(row(w.raw,'SELECT serial_norm FROM inventory_unit_origins WHERE unit_index=1')?.serial_norm,SN);
 let response=await post(w.app(USERS.ast),`/api/admin/procurement/documents/${p.id}/receive`,{operation_id:crypto.randomUUID(),lines:[{line_id:p.line.line_id,qty:2}]});assert.equal(response.status,200,await response.clone().text());
 assert.equal(count(w.raw,'SELECT COUNT(*) n FROM stock_serial_links'),2);
 const provenance=row(w.raw,'SELECT u.current_lot_id,s.lot_id FROM inventory_unit_origins u JOIN stock_serial_links s ON s.serial_norm=u.serial_norm WHERE u.serial_norm=?',SN);assert.equal(provenance?.current_lot_id,provenance?.lot_id);
 assert.equal((await linkFromInventory(w.db,'u1',SN)).kind,'refused');
 order(w.raw,'ORD-ORIGINS',[{id:'origins-line',product:'pA1',qty:2}]);
 const movement:StockMove={product_id:'pA1',line_id:'origins-line',qty:2,targets:[{scope:'base',scope_id:'',stock:2,reserved:0,low_stock_threshold:null,label:'A1'}]};
 await w.db.batch((await planLotConsumption(w.db,'ORD-ORIGINS',[movement])).statements);
 const orderScan=(slot:number,code:string)=>post(w.app(USERS.ast),'/api/admin/orders/ORD-ORIGINS/serials/scan',{order_item_id:'origins-line',unit_index:slot,code,source:'camera',op_id:crypto.randomUUID()});
 response=await orderScan(1,SN2);assert.equal(response.status,400);
 response=await orderScan(2,SN2);assert.equal(response.status,200,await response.clone().text());
 response=await orderScan(1,SN);assert.equal(response.status,200,await response.clone().text());
 assert.equal(count(w.raw,'SELECT COUNT(*) n FROM serial_assignments WHERE order_id=?','ORD-ORIGINS'),2);w.raw.close();
});

test('post-receipt enrollment links exact lot and concurrent piece collision rolls asset creation back',async()=>{
 const w=setup(),p=await create(w);const ids=p.line.unit_origins.map((u:{id:string})=>u.id);
 let response=await post(w.app(USERS.ast),`/api/admin/procurement/documents/${p.id}/receive`,{operation_id:crypto.randomUUID(),lines:[{line_id:p.line.line_id,qty:2}]});assert.equal(response.status,200,await response.clone().text());
 response=await post(w.app(USERS.ast),url(p,ids[0]),{code:SN});assert.equal(response.status,200,await response.clone().text());
 assert.equal(row(w.raw,'SELECT lot_id FROM stock_serial_links WHERE serial_norm=?',SN)?.lot_id,row(w.raw,'SELECT current_lot_id FROM inventory_unit_origins WHERE id=?',ids[0])?.current_lot_id);
 const other=await create(w,purchase(1));const raced=failingD1(w.raw);
 raced.failing.beforeBatch=()=>{raced.failing.beforeBatch=null;w.raw.prepare('UPDATE inventory_unit_origins SET serial_norm=? WHERE id=?').run(SN2,other.line.unit_origins[0].id);};
 response=await post(w.app(USERS.ast,raced.db),url(p,ids[1]),{code:SN2});assert.equal(response.status,409,await response.clone().text());
 assert.equal(row(w.raw,'SELECT serial_norm FROM inventory_unit_origins WHERE id=?',ids[1])?.serial_norm,null);
 assert.equal(count(w.raw,'SELECT COUNT(*) n FROM serial_inventory WHERE serial_norm=?',SN2),0);w.raw.close();
});

test('confirmation bounds serial enrollment and duplicate serials across lines roll back every purchase write',async()=>{
 const w=setup();
 const tooMany=purchase(51,Array.from({length:51},(_,i)=>`03919D58060${String(i).padStart(4,'0')}`));
 let response=await post(w.app(),'/api/admin/procurement/documents',tooMany);assert.equal(response.status,400);assert.equal((await json(response)).code,'PURCHASE_SERIAL_LIMIT');
 const duplicate=purchase(1,[SN]);duplicate.lines.push({...duplicate.lines[0]});
 response=await post(w.app(),'/api/admin/procurement/documents',duplicate);assert.equal(response.status,409,await response.clone().text());assert.equal((await json(response)).code,'INVENTORY_ORIGIN_SERIAL_CONFLICT');
 assert.equal(count(w.raw,'SELECT COUNT(*) n FROM purchase_orders'),0);
 assert.equal(count(w.raw,'SELECT COUNT(*) n FROM inventory_unit_origins'),0);
 assert.equal(count(w.raw,'SELECT COUNT(*) n FROM serial_inventory'),0);
 assert.equal(count(w.raw,'SELECT COUNT(*) n FROM accounting_entries'),0);w.raw.close();
});
