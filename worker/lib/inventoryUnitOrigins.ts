/** Procurement evidence, never a second stock counter or a guessed serial.
 * Plans join the caller's stock/FIFO transaction. Missing historical evidence
 * remains missing; only explicitly entered pieces acquire an identity. */
import { newId } from './crypto';
import { HttpError, badRequest, conflict } from './http';
import { fence } from './operations';

export interface UnitOriginInput { unit_index: number; supplier_order_no: string; tracking_no: string; serial_no?: string }
export interface UnitOrigin extends UnitOriginInput {
  id: string; incoming_id: string; purchase_line_id: string; purchase_id: string;
  received_lot_id: string | null; current_lot_id: string | null; received_at: string | null;
  unavailable_reason: string | null; serial_norm: string | null;
}
export async function unitOriginsInstalled(db: D1Database) {
  return !!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inventory_unit_origins'").first();
}
export function normalizeUnitOrigins(raw: unknown, qty: number): UnitOriginInput[] {
  if (raw == null || (Array.isArray(raw) && raw.length === 0)) return [];
  if (!Array.isArray(raw) || qty > 1000 || raw.length !== qty)
    throw badRequest('أدخل بيانات كل قطعة؛ الحد الأعلى للتتبع الفردي 1000 قطعة للبند', 'UNIT_ORIGINS_INVALID');
  const seen = new Set<number>();
  return raw.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('بيانات القطعة غير صحيحة', 'UNIT_ORIGINS_INVALID');
    const r = value as Record<string, unknown>, index = r.unit_index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 1 || index > qty || seen.has(index))
      throw badRequest('ترقيم القطع يجب أن يكون فريداً من 1 إلى كمية الشراء', 'UNIT_ORIGINS_INVALID');
    seen.add(index);
    const ref = (v: unknown, required: boolean) => {
      if (v == null && !required) return '';
      if (typeof v !== 'string' || v.trim().length > 120 || (required && !v.trim()) || Array.from(v).some(c=>c.charCodeAt(0)<32 || c.charCodeAt(0)===127))
        throw badRequest('أدخل رقم طلب المورد لكل قطعة؛ رقم التتبع اختياري حتى توفره (120 حرفاً كحد أقصى)', 'UNIT_ORIGINS_INVALID');
      return v.trim();
    };
    const serial = r.serial_no == null ? '' : r.serial_no;
    if(typeof serial!=='string' || serial.length>1000) throw badRequest('الرقم التسلسلي غير صحيح','SERIAL_INVALID');
    return { unit_index: index, supplier_order_no: ref(r.supplier_order_no, true), tracking_no: ref(r.tracking_no, false), ...(serial.trim()?{serial_no:serial.trim()}:{}) };
  }).sort((a,b) => a.unit_index-b.unit_index);
}
export function planCreateUnitOrigins(db: D1Database, input: {
  incomingId: string; purchaseLineId: string; purchaseId: string; units: readonly UnitOriginInput[]; actorId: string;
}): D1PreparedStatement[] {
  // Chunk JSON rather than one statement per device, including 1,000-unit lines.
  const statements: D1PreparedStatement[] = [];
  for (let i=0; i<input.units.length; i+=100) {
    const units = input.units.slice(i,i+100).map(u=>({...u,id:newId('iunit')}));
    statements.push(db.prepare(`INSERT INTO inventory_unit_origins
      (id,incoming_id,purchase_line_id,purchase_id,unit_index,supplier_order_no,tracking_no,created_by)
      SELECT json_extract(value,'$.id'),?1,?2,?3,json_extract(value,'$.unit_index'),json_extract(value,'$.supplier_order_no'),json_extract(value,'$.tracking_no'),?4 FROM json_each(?5)`)
      .bind(input.incomingId,input.purchaseLineId,input.purchaseId,input.actorId,JSON.stringify(units)));
  }
  return statements;
}
export async function unitOriginsByIncoming(db: D1Database, incomingIds: readonly string[]) {
  const out = new Map<string,UnitOrigin[]>();
  if (!incomingIds.length || !await unitOriginsInstalled(db)) return out;
  for (let i=0;i<incomingIds.length;i+=80) {
    const part=incomingIds.slice(i,i+80);
    const rows=(await db.prepare(`SELECT * FROM inventory_unit_origins WHERE incoming_id IN (${part.map(()=>'?').join(',')}) ORDER BY unit_index`).bind(...part).all<UnitOrigin>()).results??[];
    for (const row of rows) {const list=out.get(row.incoming_id)??[];list.push(row);out.set(row.incoming_id,list);}
  }
  return out;
}
export async function planReceiveUnitOrigins(db:D1Database,input:{incomingId:string;lotId:string;fromIndex?:number;qty:number;originIds?:readonly string[]}):Promise<D1PreparedStatement[]> {
  if (!await unitOriginsInstalled(db)) return [];
  const origins=(await unitOriginsByIncoming(db,[input.incomingId])).get(input.incomingId)??[];
  if (!origins.length) return [];
  const available=origins.filter(o=>!o.received_lot_id);
  const selected=input.originIds ? origins.filter(o=>input.originIds!.includes(o.id)) : available.slice(0,input.qty);
  if (selected.length!==input.qty || (input.originIds && new Set(input.originIds).size!==input.qty) || selected.some(o=>o.received_lot_id))
    throw conflict('اختر القطع غير المستلمة المطابقة لكمية الاستلام', 'UNIT_ORIGINS_RECEIPT_CHANGED');
  const ids=JSON.stringify(selected.map(o=>o.id));
  return [
    ...fence(db,'(SELECT COUNT(*) FROM inventory_unit_origins WHERE incoming_id=? AND received_lot_id IS NULL AND id IN (SELECT value FROM json_each(?)))=?',[input.incomingId,ids,input.qty]),
    db.prepare(`UPDATE inventory_unit_origins SET received_lot_id=?1,current_lot_id=?1,received_at=(SELECT received_at FROM inventory_lots WHERE id=?1)
      WHERE incoming_id=?2 AND id IN (SELECT value FROM json_each(?3))`).bind(input.lotId,input.incomingId,ids),
    ...fence(db,`NOT EXISTS(SELECT 1 FROM inventory_unit_origins u JOIN stock_serial_links s ON s.serial_norm=u.serial_norm WHERE u.id IN (SELECT value FROM json_each(?)) AND s.lot_id<>?)`,[ids,input.lotId]),
    db.prepare(`INSERT INTO stock_serial_links(serial_norm,lot_id,linked_by,linked_at)
      SELECT serial_norm,current_lot_id,created_by,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM inventory_unit_origins
      WHERE id IN (SELECT value FROM json_each(?)) AND serial_norm IS NOT NULL
      ON CONFLICT(serial_norm) DO NOTHING`).bind(ids),
  ];
}

const availableSql = (alias: string) => `${alias}.received_lot_id IS NOT NULL AND ${alias}.unavailable_reason IS NULL AND NOT EXISTS (SELECT 1 FROM order_item_inventory_unit_assignments a WHERE a.origin_id=${alias}.id AND a.released_at IS NULL)`;
const AVAILABLE = availableSql('u');
export async function availableLotOrigins(db:D1Database,lotId:string):Promise<UnitOrigin[]> {
  if (!await unitOriginsInstalled(db)) return [];
  return (await db.prepare(`SELECT u.* FROM inventory_unit_origins u WHERE u.current_lot_id=? AND ${AVAILABLE} ORDER BY u.received_at,u.unit_index,u.id`).bind(lotId).all<UnitOrigin>()).results??[];
}
/** Assigns tracked pieces to a sale's order slots inside the sale's own FIFO
 * batch. The pieces are chosen when the batch COMMITS, not when it is planned
 * (review 2026-10-13, PROV-1): two confirmations of the same product planned
 * at the same moment both see the same first free piece, and fencing on those
 * exact ids rolled the slower confirmation's whole deduction back (stock,
 * lot and COGS), with no caller retrying it. Now the slower one takes the next
 * free piece in the same FIFO order. The partial unique index
 * ux_inventory_origin_assigned still makes a double assignment impossible,
 * and the lot's own qty fence still refuses a sale the lot cannot cover.
 * `excluded` only sizes the plan when one batch draws several allocations
 * from the same lot; the statements themselves run in order and see each
 * other's assignments. */
export async function planUnitOriginConsumption(db:D1Database,input:{orderId:string;itemId:string;lotId:string;allocationId:string;qty:number;unitIndexStart:number;excluded:Set<string>}):Promise<D1PreparedStatement[]> {
  const selected=(await availableLotOrigins(db,input.lotId)).filter(u=>!input.excluded.has(u.id)).slice(0,input.qty);
  if (!selected.length) return [];
  selected.forEach(u=>input.excluded.add(u.id));
  const slots=JSON.stringify(selected.map((_,i)=>({slot:input.unitIndexStart+i,assignment:newId('iuas')})));
  return [
    db.prepare(`INSERT INTO order_item_inventory_unit_assignments
      (id,origin_id,allocation_id,order_id,order_ref,order_item_id,order_item_ref,unit_index,lot_id,purchase_id,purchase_line_id,incoming_id,purchase_unit_index,purchase_name,supplier_order_no,tracking_no)
      SELECT json_extract(j.value,'$.assignment'),u.id,?1,?2,?2,?3,?3,json_extract(j.value,'$.slot'),?4,u.purchase_id,u.purchase_line_id,u.incoming_id,u.unit_index,COALESCE(p.invoice_no,''),u.supplier_order_no,u.tracking_no
      FROM (SELECT c.id, ROW_NUMBER() OVER (ORDER BY c.received_at,c.unit_index,c.id)-1 AS k
              FROM inventory_unit_origins c WHERE c.current_lot_id=?4 AND ${availableSql('c')}
             ORDER BY c.received_at,c.unit_index,c.id LIMIT ?6) pick
      JOIN json_each(?5) j ON j.key=pick.k
      JOIN inventory_unit_origins u ON u.id=pick.id
      LEFT JOIN purchase_orders p ON p.id=u.purchase_id`)
      .bind(input.allocationId,input.orderId,input.itemId,input.lotId,slots,selected.length),
  ];
}

export async function planReleaseUnitOrigins(db:D1Database,input:{allocationId:string;qty:number;reason:string;originIds?:readonly string[];restock?:boolean}):Promise<D1PreparedStatement[]> {
  if (!await unitOriginsInstalled(db)) return [];
  const rows=(await db.prepare('SELECT id,origin_id,lot_id,released_at FROM order_item_inventory_unit_assignments WHERE allocation_id=? ORDER BY unit_index,id').bind(input.allocationId).all<{id:string;origin_id:string;lot_id:string;released_at:string|null}>()).results??[];
  const requested=input.originIds ? rows.filter(r=>input.originIds!.includes(r.origin_id)) : rows.filter(r=>!r.released_at).slice(0,input.qty);
  if(requested.some(r=>r.released_at)) throw conflict('تغيرت القطع المرتجعة؛ حدّث الطلب وأعد اختيارها','UNIT_ORIGINS_RETURN_MISMATCH');
  const selected=requested;
  if (selected.length>input.qty) throw conflict('بيانات القطع المرتجعة لا تطابق الكمية', 'UNIT_ORIGINS_RETURN_MISMATCH');
  if (!selected.length) return [];
  const ids=JSON.stringify(selected.map(r=>r.id));
  const originIds=JSON.stringify(selected.map(r=>r.origin_id));
  return [
    ...fence(db,'(SELECT COUNT(*) FROM order_item_inventory_unit_assignments WHERE id IN (SELECT value FROM json_each(?)) AND released_at IS NULL)=?',[ids,selected.length]),
    db.prepare(`UPDATE order_item_inventory_unit_assignments SET released_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),release_reason=? WHERE id IN (SELECT value FROM json_each(?))`).bind(input.reason,ids),
    db.prepare(`UPDATE inventory_unit_origins SET unavailable_reason=? WHERE id IN (SELECT value FROM json_each(?))`).bind(input.restock===false?input.reason:null,originIds),
  ];
}

/** Transfers, write-offs and missing-count corrections follow the pieces that
 * physically moved (review 2026-10-13, PROV-3). Moving or losing a WHOLE lot
 * takes every piece in it. A PART of a lot that holds identified pieces must
 * name them: the first pieces in FIFO order are no longer guessed, because
 * each carton's label, supplier order and tracking number must stay where the
 * carton is. Unidentified (historical) units of the same lot may make up the
 * rest of the quantity. Positive counts never invent a supplier origin for
 * newly found, unidentified stock. */
export async function planMoveUnitOrigins(db:D1Database,input:{lotId:string;qty:number;lotRemaining:number;targetLotId?:string;reason?:string;originIds?:unknown}):Promise<D1PreparedStatement[]> {
  const available=await availableLotOrigins(db,input.lotId);
  if (!available.length) return [];
  let selected=available;
  if (input.qty<input.lotRemaining) {
    if (input.originIds==null)
      throw new HttpError(409, 'هذه الدفعة فيها قطع معرّفة: حدد بأرقامها الداخلية القطع التي نُقلت أو فُقدت فعلاً', 'UNIT_ORIGIN_SELECTION_REQUIRED',
        { lot_id: input.lotId, qty: input.qty, identified: available.length, unidentified: Math.max(0, input.lotRemaining-available.length) });
    const ids=input.originIds;
    if (!Array.isArray(ids) || ids.some(v=>typeof v!=='string') || new Set(ids).size!==ids.length)
      throw badRequest('أرقام القطع غير صحيحة', 'UNIT_ORIGINS_INVALID');
    selected=(ids as string[]).map(id=>available.find(u=>u.id===id)).filter((u):u is UnitOrigin=>!!u);
    if (selected.length!==ids.length) throw conflict('إحدى القطع المحددة لم تعد متاحة في هذه الدفعة؛ حدّث القائمة', 'UNIT_ORIGINS_CHANGED');
    const unidentified=Math.max(0,input.lotRemaining-available.length);
    if (ids.length>input.qty || ids.length<input.qty-unidentified)
      throw badRequest('عدد القطع المحددة لا يطابق الكمية', 'UNIT_ORIGINS_QTY', { qty: input.qty, unidentified });
    if (!selected.length) return [];
  }
  const ids=JSON.stringify(selected.map(u=>u.id));
  return [
    ...fence(db,`(SELECT COUNT(*) FROM inventory_unit_origins u WHERE u.current_lot_id=? AND ${AVAILABLE} AND u.id IN (SELECT value FROM json_each(?)))=?`,[input.lotId,ids,selected.length]),
    input.targetLotId
      ?db.prepare('UPDATE inventory_unit_origins SET current_lot_id=? WHERE id IN (SELECT value FROM json_each(?))').bind(input.targetLotId,ids)
      :db.prepare('UPDATE inventory_unit_origins SET unavailable_reason=? WHERE id IN (SELECT value FROM json_each(?))').bind(input.reason??'stock_adjustment',ids),
  ];
}

/** The identified pieces still in a lot, for the screens that must name them. */
export async function lotUnitChoices(db:D1Database,lotId:string) {
  const lot=await db.prepare('SELECT qty_remaining FROM inventory_lots WHERE id=?').bind(lotId).first<{qty_remaining:number}>();
  if (!lot) return null;
  const units=(await availableLotOrigins(db,lotId)).map(u=>({id:u.id,unit_index:u.unit_index,supplier_order_no:u.supplier_order_no,tracking_no:u.tracking_no,serial_norm:u.serial_norm}));
  return {lot_id:lotId,qty_remaining:lot.qty_remaining,units,unidentified:Math.max(0,lot.qty_remaining-units.length)};
}

/** A partial return must name its physical pieces. An entire outstanding line
 * can safely release all its evidence; legacy lines keep their prior behavior. */
export interface ReturnedOriginSelection { originIds: string[]; allocationQty: Record<string,number> }
export async function resolveReturnedOriginIds(db:D1Database,input:{orderId:string;itemId:string;qty:number;originIds?:unknown;unitIds?:readonly string[];returnCaseId?:string}):Promise<ReturnedOriginSelection|undefined> {
  if (!await unitOriginsInstalled(db)) return undefined;
  const rows=(await db.prepare(`SELECT a.origin_id,a.unit_index,a.allocation_id,a.lot_id FROM order_item_inventory_unit_assignments a
    WHERE a.order_id=? AND a.order_item_id=? AND a.released_at IS NULL ORDER BY a.unit_index`).bind(input.orderId,input.itemId).all<{origin_id:string;unit_index:number;allocation_id:string;lot_id:string}>()).results??[];
  if (!rows.length) return undefined;
  if(!input.unitIds?.length && input.returnCaseId){
    const savedUnits=(await db.prepare('SELECT unit_id FROM stock_return_order_unit_evidence WHERE return_case_id=?').bind(input.returnCaseId).all<{unit_id:string}>()).results??[];
    if(savedUnits.length) input={...input,unitIds:savedUnits.map(r=>r.unit_id)};
  }
  if(input.originIds===undefined && input.returnCaseId){
    const saved=(await db.prepare('SELECT origin_id FROM stock_return_unit_evidence WHERE return_case_id=?').bind(input.returnCaseId).all<{origin_id:string}>()).results??[];
    if(saved.length) input={...input,originIds:saved.map(r=>r.origin_id)};
  }
  const mismatch=()=>conflict('القطع المختارة لا تطابق القطع المسحوبة لهذا الطلب أو كمية المرتجع','UNIT_ORIGINS_RETURN_MISMATCH');
  const allocations=(await db.prepare(`SELECT a.id,a.lot_id,a.qty-COALESCE((SELECT SUM(r.qty) FROM order_item_inventory_allocations r WHERE r.order_item_id=a.order_item_id AND r.lot_id=a.lot_id AND r.released_at IS NOT NULL),0) AS remaining
    FROM order_item_inventory_allocations a WHERE a.order_id=? AND a.order_item_id=? AND a.released_at IS NULL`).bind(input.orderId,input.itemId).all<{id:string;lot_id:string;remaining:number}>()).results??[];
  const allocationQty: Record<string,number> = {};
  const add=(id:string)=>{allocationQty[id]=(allocationQty[id]??0)+1;};
  let selected: string[] | undefined;
  if (input.unitIds?.length) {
    const units=(await db.prepare('SELECT id,unit_index,inventory_lot_id FROM order_item_units WHERE order_item_id=? AND id IN (SELECT value FROM json_each(?))').bind(input.itemId,JSON.stringify(input.unitIds)).all<{id:string;unit_index:number;inventory_lot_id:string|null}>()).results??[];
    if(units.length!==input.qty || new Set(input.unitIds).size!==input.qty) throw mismatch();
    selected=[];
    for(const unit of units){
      const origin=rows.find(r=>r.unit_index===unit.unit_index);
      if(origin){
        if(unit.inventory_lot_id && unit.inventory_lot_id!==origin.lot_id) throw mismatch();
        selected.push(origin.origin_id);add(origin.allocation_id);
      }else{
        // Known legacy unit: restore its proven cost lot, but release no
        // tracked origin merely because it shares this customer's line.
        const allocation=allocations.find(a=>a.lot_id===unit.inventory_lot_id && a.remaining>(allocationQty[a.id]??0));
        if(!allocation) throw mismatch();
        add(allocation.id);
      }
    }
  }
  if(input.originIds!==undefined){
    if(!Array.isArray(input.originIds) || input.originIds.some(v=>typeof v!=='string')) throw mismatch();
    const explicit=input.originIds as string[];
    if(new Set(explicit).size!==explicit.length || explicit.some(id=>!rows.some(r=>r.origin_id===id))) throw mismatch();
    if(selected){
      if(explicit.length!==selected.length || explicit.some(id=>!selected!.includes(id))) throw mismatch();
    }else{
      if(explicit.length!==input.qty) throw mismatch();
      selected=explicit;
      for(const id of explicit) add(rows.find(r=>r.origin_id===id)!.allocation_id);
    }
  }
  if(selected){
    if(Object.entries(allocationQty).some(([id,n])=>n>(allocations.find(a=>a.id===id)?.remaining??0))) throw mismatch();
    return {originIds:selected,allocationQty};
  }
  const outstanding=allocations.reduce((n,a)=>n+a.remaining,0);
  if(input.qty===outstanding){
    if(rows.length!==outstanding) return undefined;
    for(const row of rows) add(row.allocation_id);
    return {originIds:rows.map(r=>r.origin_id),allocationQty};
  }
  throw conflict('حدد القطعة المرتجعة برقمها الداخلي أو رقمها التسلسلي قبل إكمال المرتجع','UNIT_ORIGIN_SELECTION_REQUIRED');
}

export async function planUnsellableOriginReturn(db:D1Database,input:{orderId:string;itemId:string;qty:number;reason:string;originIds?:readonly string[]}):Promise<D1PreparedStatement[]> {
  if (!await unitOriginsInstalled(db)) return [];
  const selectionGuard: D1PreparedStatement[] = [];
  if(input.originIds){
    const ids=JSON.stringify(input.originIds);
    const sql='(SELECT COUNT(*) FROM order_item_inventory_unit_assignments WHERE order_id=? AND order_item_id=? AND released_at IS NULL AND origin_id IN (SELECT value FROM json_each(?)))=?';
    const count=(await db.prepare('SELECT COUNT(*) AS n FROM order_item_inventory_unit_assignments WHERE order_id=? AND order_item_id=? AND released_at IS NULL AND origin_id IN (SELECT value FROM json_each(?))').bind(input.orderId,input.itemId,ids).first<{n:number}>())?.n??0;
    if(count!==input.originIds.length) throw conflict('تغيرت القطع المرتجعة؛ حدّث الطلب وأعد اختيارها','UNIT_ORIGINS_RETURN_MISMATCH');
    selectionGuard.push(...fence(db,sql,[input.orderId,input.itemId,ids,input.originIds.length]));
  }
  const groups=(await db.prepare(`SELECT allocation_id,COUNT(*) AS n FROM order_item_inventory_unit_assignments
    WHERE order_id=? AND order_item_id=? AND released_at IS NULL
      AND (? IS NULL OR origin_id IN (SELECT value FROM json_each(?))) GROUP BY allocation_id`)
    .bind(input.orderId,input.itemId,input.originIds?JSON.stringify(input.originIds):null,input.originIds?JSON.stringify(input.originIds):'[]').all<{allocation_id:string;n:number}>()).results??[];
  const statements:D1PreparedStatement[]=[...selectionGuard];
  for(const row of groups) statements.push(...await planReleaseUnitOrigins(db,{allocationId:row.allocation_id,qty:row.n,reason:input.reason,originIds:input.originIds,restock:false}));
  return statements;
}
