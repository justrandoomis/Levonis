/** Register a physical piece's serial in the existing device inventory.
 * Neither enrollment nor source binding changes stock, costs or warranty dates. */
import { canonicalSerial, judgeFormat, serialFamilyConflict, legacyAliases } from './serialAssignments';
import { ruleForProduct } from './serialRules';
import { verifyProductChoice } from './serialInventory';
import { conflict, badRequest } from './http';
import { fence } from './operations';
import { auditStatements } from './audit';
import type { StockScope } from './inventory';
import type { UnitOriginInput } from './inventoryUnitOrigins';

export const originSerialConflict = () => conflict('الرقم التسلسلي مرتبط بقطعة أو طلب أو دفعة أخرى، أو تغيرت بيانات القطعة؛ حدّث البيانات وتحقق من الجهاز.', 'INVENTORY_ORIGIN_SERIAL_CONFLICT');
interface OriginKey { purchaseId:string; incomingId:string; unitIndex:number; productId:string; scope:StockScope; scopeId:string; actorId:string; code:unknown; source?:'camera'|'scanner'|'manual' }

async function enrollmentPlan(db:D1Database,input:OriginKey) {
  const rule=await ruleForProduct(db,input.productId);
  const canonical=await canonicalSerial(db,input.code,rule);
  const warnings=judgeFormat(canonical.norm,rule);
  const variantId=input.scope==='variant'?input.scopeId:null;
  const product=await verifyProductChoice(db,input.productId,variantId);
  const family=serialFamilyConflict(canonical.norm,[product.name],rule);
  if(family) throw badRequest('الرقم التسلسلي لا يطابق موديل المنتج المختار','SERIAL_MODEL_MISMATCH');
  if((await legacyAliases(db,canonical.norm)).length) throw originSerialConflict();
  const originSql='SELECT id FROM inventory_unit_origins WHERE incoming_id=?1 AND unit_index=?2';
  // A device already scanned against this very assigned piece may be filed
  // after receipt. No other pending, delivered or historical device is adopted.
  const sameSlot=`EXISTS(SELECT 1 FROM order_item_inventory_unit_assignments a WHERE a.origin_id=(${originSql})
    AND a.released_at IS NULL AND a.order_id=s.order_id AND a.order_item_id=s.order_item_id AND a.unit_index=s.unit_index AND s.part='device' AND s.part_index=1 AND s.lot_id=a.lot_id)`;
  const condition=`NOT EXISTS(SELECT 1 FROM inventory_unit_origins u WHERE u.serial_norm=?3 AND NOT(u.incoming_id=?1 AND u.unit_index=?2))
    AND NOT EXISTS(SELECT 1 FROM inventory_unit_origins u WHERE u.incoming_id=?1 AND u.unit_index=?2 AND (u.unavailable_reason IS NOT NULL OR (u.serial_norm IS NOT NULL AND u.serial_norm<>?3)))
    AND NOT EXISTS(SELECT 1 FROM serial_inventory si WHERE si.serial_norm=?3 AND (si.voided_at IS NOT NULL OR (si.product_id IS NOT NULL AND si.product_id<>?4) OR (si.variant_id IS NOT NULL AND si.variant_id IS NOT ?5)))
    AND NOT EXISTS(SELECT 1 FROM serial_inventory si WHERE si.box_sn=?3 AND si.box_sn<>'' AND si.serial_norm<>?3)
    AND NOT EXISTS(SELECT 1 FROM serial_assignments s WHERE s.serial_norm=?3 AND s.released_at IS NULL AND NOT ${sameSlot})
    AND NOT EXISTS(SELECT 1 FROM order_item_inventory_unit_assignments a JOIN serial_assignments s ON s.order_id=a.order_id AND s.order_item_id=a.order_item_id AND s.unit_index=a.unit_index AND s.part='device' AND s.part_index=1 AND s.released_at IS NULL
      WHERE a.origin_id=(${originSql}) AND a.released_at IS NULL AND s.serial_norm<>?3)
    AND NOT EXISTS(SELECT 1 FROM device_serials d WHERE d.serial_norm=?3 AND NOT EXISTS(SELECT 1 FROM serial_assignments s WHERE s.serial_norm=d.serial_norm AND s.unit_id=d.unit_id AND s.released_at IS NULL AND ${sameSlot}))
    AND NOT EXISTS(SELECT 1 FROM warranty_receipts wr WHERE wr.serial_norm=?3 AND wr.status IN ('draft','active') AND NOT EXISTS(SELECT 1 FROM serial_assignments s WHERE s.serial_norm=wr.serial_norm AND s.unit_id=wr.unit_id AND s.released_at IS NULL AND ${sameSlot}))
    AND NOT EXISTS(SELECT 1 FROM stock_serial_links sl WHERE sl.serial_norm=?3 AND sl.lot_id IS NOT (SELECT current_lot_id FROM inventory_unit_origins WHERE incoming_id=?1 AND unit_index=?2))`;
  const args=[input.incomingId,input.unitIndex,canonical.norm,input.productId,variantId];
  if(!await db.prepare(`SELECT 1 WHERE ${condition}`).bind(...args).first()) throw originSerialConflict();
  // Numbered placeholders in the condition need no offset when wrapping it:
  // fence uses an extra leading ? which would alias ?1. Put the guard id last.
  const guardId=crypto.randomUUID();
  const statements:D1PreparedStatement[]=[
    ...fence(db,`EXISTS(SELECT 1 FROM inventory_unit_origins u JOIN incoming_inventory i ON i.id=u.incoming_id JOIN purchase_orders p ON p.id=u.purchase_id
      WHERE u.incoming_id=? AND u.unit_index=? AND u.purchase_id=? AND i.product_id=? AND i.scope=? AND i.scope_id=?
      AND p.status IN ('ordered','partial','received') AND p.cost_state='final' AND i.status<>'cancelled')`,[input.incomingId,input.unitIndex,input.purchaseId,input.productId,input.scope,input.scopeId]),
    db.prepare(`INSERT INTO ops_guards(id,ok) SELECT ?6,CASE WHEN ${condition} THEN 1 ELSE 0 END`).bind(...args,guardId),
    db.prepare('DELETE FROM ops_guards WHERE id=?').bind(guardId),
    db.prepare(`INSERT INTO serial_inventory(serial_norm,serial_raw,product_id,variant_id,source,created_by,model_name)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(serial_norm) DO NOTHING`).bind(canonical.norm,canonical.raw,input.productId,variantId,input.source==='manual'?'manual':'scan',input.actorId,product.name.slice(0,120)),
    db.prepare(`UPDATE serial_inventory SET product_id=COALESCE(product_id,?),variant_id=COALESCE(variant_id,?),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE serial_norm=?`).bind(input.productId,variantId,canonical.norm),
    db.prepare('UPDATE inventory_unit_origins SET serial_norm=? WHERE incoming_id=? AND unit_index=? AND serial_norm IS NULL').bind(canonical.norm,input.incomingId,input.unitIndex),
    db.prepare(`INSERT INTO stock_serial_links(serial_norm,lot_id,linked_by,linked_at)
      SELECT serial_norm,current_lot_id,?,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM inventory_unit_origins
      WHERE incoming_id=? AND unit_index=? AND current_lot_id IS NOT NULL AND serial_norm IS NOT NULL
      ON CONFLICT(serial_norm) DO NOTHING`).bind(input.actorId,input.incomingId,input.unitIndex),
    ...(await auditStatements(db,input.actorId,'inventory.origin_serial_enrolled',canonical.norm,{incoming_id:input.incomingId,unit_index:input.unitIndex,product_id:input.productId,source:input.source??'manual',format_warnings:warnings})).statements,
  ];
  return {statements,serialNorm:canonical.norm,formatWarnings:warnings};
}

/** Append after incoming/product-origin INSERTs in the purchase's own batch. */
export async function planDraftOriginSerials(db:D1Database,input:{purchaseId:string;incomingId:string;productId:string;scope:StockScope;scopeId:string;units:readonly UnitOriginInput[];actorId:string}) {
  const statements:D1PreparedStatement[]=[],seen=new Set<string>();
  for(const unit of input.units){
    if(!unit.serial_no)continue;
    const planned=await enrollmentPlan(db,{...input,unitIndex:unit.unit_index,code:unit.serial_no,source:'manual'});
    if(seen.has(planned.serialNorm))throw originSerialConflict();
    seen.add(planned.serialNorm);statements.push(...planned.statements);
  }
  return statements;
}

export async function planSavedOriginSerial(db:D1Database,input:OriginKey & {purchaseId:string;originId:string;version:number;currentLotId:string|null;expectedSerial:string|null}) {
  const plan=await enrollmentPlan(db,input);
  return {...plan,statements:[
    ...fence(db,`EXISTS(SELECT 1 FROM purchase_orders p JOIN inventory_unit_origins u ON u.purchase_id=p.id
      JOIN incoming_inventory i ON i.id=u.incoming_id WHERE p.id=? AND p.version=? AND p.status IN ('ordered','partial','received') AND p.cost_state='final'
        AND u.id=? AND u.incoming_id=? AND u.unit_index=? AND u.serial_norm IS ? AND u.current_lot_id IS ?
        AND i.product_id=? AND i.scope=? AND i.scope_id=? AND i.status<>'cancelled')`,
      [input.purchaseId,input.version,input.originId,input.incomingId,input.unitIndex,input.expectedSerial,input.currentLotId,input.productId,input.scope,input.scopeId]),
    ...plan.statements,
    db.prepare("UPDATE purchase_orders SET version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").bind(input.purchaseId),
  ]};
}
