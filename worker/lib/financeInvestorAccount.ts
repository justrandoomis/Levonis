import type { ParticipantSource } from './financeParticipants';
import { PENDING_SURPLUS_SQL, RETURNED_SURPLUS_SQL, surplusInstalled } from './investorSurplus';

/** Account-scoped progress, without customer data, purchase costs or owner margins.
 * `returned_surplus_iqd`: received funding no contract took — returned to the
 * investor as capital in «أرباحي» (worker/lib/investorSurplus.ts); kept as
 * `unallocated_iqd` too for an older cached screen. `pending_surplus_iqd`: the
 * remainder still waiting for the rest of the investor's cash. */
export async function investorAccountProgress(db:D1Database,userId:string,sources:ParticipantSource[],budgets:Map<string,number>){
 if(!await surplusInstalled(db))return {unallocated_iqd:0,returned_surplus_iqd:0,pending_surplus_iqd:0,batches:[]};
 const rows=(await db.prepare(`SELECT c.id,c.name,c.principal_iqd,c.profit_share_bps,i.qty_ordered,i.qty_received,
  COALESCE((SELECT SUM(e.amount_iqd) FROM investor_finance_events e WHERE e.contract_id=c.id AND e.kind='funding'),0) AS received_iqd,
  COALESCE((SELECT SUM(l.qty_remaining) FROM inventory_lots l WHERE l.incoming_id=i.id),0) AS remaining_qty,
  COALESCE((SELECT SUM(json_extract(r.snapshot,'$.qty')) FROM investor_allocation_results r WHERE r.contract_id=c.id),0) AS delivered_qty,
  COALESCE((SELECT SUM(r.profit_iqd) FROM investor_allocation_results r WHERE r.contract_id=c.id AND r.eligible=0),0) AS collection_pending_iqd
  FROM investment_contracts c JOIN incoming_inventory i ON i.id=c.incoming_id WHERE c.user_id=? AND c.state='active' ORDER BY c.created_at DESC,c.id`).bind(userId).all<{id:string;name:string;principal_iqd:number;profit_share_bps:number;qty_ordered:number;qty_received:number;received_iqd:number;remaining_qty:number;delivered_qty:number;collection_pending_iqd:number}>()).results??[];
 const unallocated=await db.prepare(RETURNED_SURPLUS_SQL).bind(userId).first<{n:number}>();
 const pending=await db.prepare(PENDING_SURPLUS_SQL).bind(userId).first<{n:number}>();
 return {unallocated_iqd:unallocated?.n??0,returned_surplus_iqd:unallocated?.n??0,pending_surplus_iqd:pending?.n??0,batches:rows.map(r=>{
  const profit=sources.find(s=>s.id===`invprofit:${r.id}`),capital=sources.find(s=>s.id===`invcapital:${r.id}`),available=budgets.get(`invprofit:${r.id}`)??0;
  const state=profit?.blocked?'settlement':r.received_iqd<r.principal_iqd?'funding':!r.qty_received?'incoming':!r.delivered_qty?'delivery':r.collection_pending_iqd>0?'collection':available>0?'available':(profit?.held_iqd??0)>0?'reserved':(profit?.paid_iqd??0)>0?'paid':'delivery';
  return {...r,state,earned_iqd:profit?.accrued_iqd??0,available_iqd:available,paid_iqd:profit?.paid_iqd??0,recovered_capital_iqd:capital?.accrued_iqd??0,capital_paid_iqd:capital?.paid_iqd??0};
 })};
}
