import {Hono} from 'hono';
import type {AppContext} from '../lib/types';
import type {StockScope} from '../lib/inventory';
import {requireAdmin,requireMainHost,notFound,badRequest,conflict,unavailable,str} from '../lib/http';
import {requireSerialWrite,isFenceMiss} from '../lib/operations';
import {unitOriginsInstalled} from '../lib/inventoryUnitOrigins';
import {canonicalSerial} from '../lib/serialAssignments';
import {ruleForProduct} from '../lib/serialRules';
import {planSavedOriginSerial,originSerialConflict} from '../lib/procurementOriginSerials';

export const adminProcurementOriginSerialRoutes=new Hono<AppContext>();
adminProcurementOriginSerialRoutes.use('/documents/:id/unit-origins/:originId/serial',requireMainHost,requireAdmin);
adminProcurementOriginSerialRoutes.post('/documents/:id/unit-origins/:originId/serial',async c=>{
 const db=c.env.DB,user=c.get('user')!;
 await requireSerialWrite(c.env,user);
 if(!await unitOriginsInstalled(db))throw unavailable('تتبع القطع غير متاح بعد','INVENTORY_ORIGINS_NOT_INSTALLED');
 c.header('Cache-Control','private, no-store');
 const body=await c.req.json<Record<string,unknown>>();
 const code=str(body.code,'code',{min:1,max:1000});
 if(body.source!==undefined && !['camera','scanner','manual'].includes(String(body.source)))throw badRequest('طريقة قراءة الرقم غير صحيحة');
 const row=await db.prepare(`SELECT u.id,u.incoming_id,u.unit_index,u.serial_norm,u.current_lot_id,u.unavailable_reason,
   p.version,p.cost_state,p.status AS purchase_status,i.product_id,i.scope,i.scope_id,i.status AS incoming_status
   FROM inventory_unit_origins u JOIN purchase_orders p ON p.id=u.purchase_id JOIN incoming_inventory i ON i.id=u.incoming_id
   WHERE u.id=? AND u.purchase_id=?`).bind(c.req.param('originId'),c.req.param('id')).first<{id:string;incoming_id:string;unit_index:number;serial_norm:string|null;current_lot_id:string|null;unavailable_reason:string|null;version:number;cost_state:string;purchase_status:string;incoming_status:string;product_id:string;scope:StockScope;scope_id:string}>();
 if(!row)throw notFound('القطعة غير موجودة في هذا الشراء');
 if(row.purchase_status==='draft')throw conflict('أكد الشراء بعد مراجعة تكاليفه، ثم أضف الرقم التسلسلي للجهاز.','PURCHASE_SERIAL_REQUIRES_CONFIRM');
 if(row.cost_state!=='final')throw conflict('ثبت التكاليف النهائية للشراء قبل تسجيل الأرقام التسلسلية.','PURCHASE_SERIAL_REQUIRES_FINAL_COST');
 if(row.purchase_status==='cancelled'||row.incoming_status==='cancelled'||row.unavailable_reason)throw originSerialConflict();
 const {norm}=await canonicalSerial(db,code,await ruleForProduct(db,row.product_id));
 if(row.serial_norm){
   if(row.serial_norm!==norm)throw conflict('هذه القطعة مرتبطة برقم تسلسلي ثابت؛ لا تستبدله برقم جهاز آخر.','INVENTORY_ORIGIN_SERIAL_LOCKED');
   return c.json({success:true,already:true,serial_norm:norm,version:row.version,format_warnings:[]});
 }
 if(body.expected_serial_norm!==undefined && body.expected_serial_norm!==null)throw originSerialConflict();
 const plan=await planSavedOriginSerial(db,{purchaseId:c.req.param('id'),originId:row.id,incomingId:row.incoming_id,unitIndex:row.unit_index,productId:row.product_id,scope:row.scope,scopeId:row.scope_id,actorId:user.id,code,source:body.source==='camera'?'camera':body.source==='scanner'?'scanner':'manual',version:row.version,currentLotId:row.current_lot_id,expectedSerial:null});
 try{await db.batch(plan.statements);}catch(error){
   const now=await db.prepare('SELECT u.serial_norm,p.version FROM inventory_unit_origins u JOIN purchase_orders p ON p.id=u.purchase_id WHERE u.id=? AND p.id=?').bind(row.id,c.req.param('id')).first<{serial_norm:string|null;version:number}>();
   if(now?.serial_norm===plan.serialNorm)return c.json({success:true,already:true,serial_norm:now.serial_norm,version:now.version,format_warnings:plan.formatWarnings});
   if(isFenceMiss(error)||/UNIQUE constraint failed: (inventory_unit_origins.serial_norm|serial_inventory.serial_norm|stock_serial_links.serial_norm)/.test(String(error)))throw originSerialConflict();
   throw error;
 }
 return c.json({success:true,serial_norm:plan.serialNorm,already:false,version:row.version+1,format_warnings:plan.formatWarnings});
});
