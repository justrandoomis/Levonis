import { participantReport } from '../lib/financeParticipantReports';
import { hasUnknownRefund, isConfirmedOrderCost } from '../lib/financeLedger';
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { badRequest, conflict, notFound, requireAdmin, str, unavailable } from '../lib/http';
import { canViewCost, isOwner } from '../lib/adminScope';
import { requireCostRead } from '../lib/costAccess';
import { limitByMethod, limitInstead } from '../lib/ratelimit';
import { newId } from '../lib/crypto';
import { auditStatements } from '../lib/audit';
import { baghdadDay, dateValue, decimal, fence, periodOpen, requireCapability, whole } from '../lib/operations';
import { serverMessage } from '@levonis/contracts/costRefusals';
import { planExpenseAccounting } from '../lib/expenseAccounting';
import { addOwnerPromotions, applyProfitAdjustment, getOrderProfitBase, getOrderProfitBases, monthlyPromotionShares, planProfitAdjustment, planWorkspaceAccounting, profitFields, profitSourceFingerprint, spread, workspaceInstalled, type OrderProfitBase, type ProfitAdjustment, type ProfitField, type ProfitLine } from '../lib/orderProfit';
import { investorFinanceInstalled, investorOrderSplit, investorProjectionStaleSql } from '../lib/investorFinance';
import { reconcileFinanceOrder } from '../lib/financeReconcile';
import { enrichOrderProfitReview } from '../lib/orderProfitReview';
import { enrichOrderCostProjections } from '../lib/orderCostProjection';
import { reportAdjustments, type ReportAdjustments } from '../lib/financeReportOverlay';
import { loadUsdRateSteps, usdRateAt, type UsdRateSteps } from '../lib/fx/historyRate';
import { ADDITIVE_IQD_FIELDS, baghdadDayStart, batchCogsCents, centsOf, chartCents, expenseCompositionCents, iqdToCents, instantOf, rederive, sumCents, type Cents } from '../lib/financeUsdDisplay';
import { loadLotUsdRates } from '../lib/batchSnapshot';
import { runFinanceChecks } from '../lib/financeChecks';
import { CLOSED_MONTHS_SQL, EXPENSE_ROW_LIMIT, EXPENSE_ROWS_SQL, isGeneralKind, periodExpenses, PROMOTION_HISTORY_LIMIT, PROMOTION_HISTORY_SQL } from '../lib/financeExpenseKinds';

type Row=Record<string,unknown>;
const n=(v:unknown)=>Number(v??0),s=(v:unknown)=>String(v??'');
const text=(v:unknown,max=200)=>str(v,'النص',{max,required:false})??'';
export const adminFinanceWorkspaceRoutes=new Hono<AppContext>();
adminFinanceWorkspaceRoutes.use('*',requireAdmin);
// «التكاليف الناقصة» prices one line per request: on the shared write budget (120 an
// hour, per user, shared by every finance router) a long list would lock the owner out
// of withdrawals, payments, expenses and closing a period until the hour turned. It
// spends its own bucket INSTEAD (registered before the door, as the staff reconcile).
adminFinanceWorkspaceRoutes.on('POST','/missing-costs/lines',limitInstead('finance-missing-costs',600,['finance-write']));
// THE DOOR (owner decision 2): payroll, withdrawals and profit are cost — the
// owner's alone, full-scope admins included. The rate limit runs before the
// guard, so a refused caller still spends budget.
adminFinanceWorkspaceRoutes.use('*', limitByMethod(['finance-read', 600], ['finance-write', 120]), requireCostRead);
adminFinanceWorkspaceRoutes.use('*',async(c,next)=>{
  if(!await workspaceInstalled(c.env.DB))throw unavailable('تحديث مساحة العمل المالية لم يطبق بعد');
  await next();
});
function range(fromValue?:string,toValue?:string){
  const today=baghdadDay(),from=dateValue(fromValue,`${today.slice(0,7)}-01`),to=dateValue(toValue,today);
  const days=(Date.parse(to)-Date.parse(from))/86400000;
  if(days<0||days>365)throw badRequest('اختر فترة لا تتجاوز سنة');
  return {from,to};
}
const sumFields=['net_goods_iqd','retained_revenue_iqd','cogs_iqd','gross_profit_iqd','shipping_income_iqd','cod_tax_iqd','direct_cost_iqd','wages_iqd','materials_iqd','manual_direct_iqd','courier_fee_iqd','payment_fee_iqd','contribution_profit_iqd','profit_basis_iqd','promotion_iqd','investor_iqd','owner_net_iqd','coupon_iqd','price_protection_iqd','trade_in_credit_iqd','trade_in_credit_returned_iqd','net_after_report_adjustments_iqd','refunded_iqd','refund_iqd','collected_iqd','collection_difference_iqd','pending_costs','unknown_lines','units'];
function sumRows(rows:Row[]):Row {
  const totals:Row={};
  for(const key of sumFields)totals[key]=rows.some((r)=>r[key]===null)?null:rows.reduce((v,r)=>v+n(r[key]),0);
  return totals;
}
/**
 * WHAT IS MISSING (owner 2026-11-10: «الحساب يحتاج مراجعة fix all them»).
 * Every delivered line whose goods cost is not confirmed (FIFO from a priced
 * stock batch, verified by the owner, or a recorded pre-cut-over snapshot):
 * the sale-time estimate, if any, is only a hint — the owner confirms a price.
 * `cost_qty` is what a line's goods cost covers: the pieces the customer kept
 * (a return put back in stock is not a cost of this sale). `stock_qty` counts
 * pieces that came from a stock batch, and `preorder` marks a pre-order line
 * whose batch is not linked yet: both are priced in their order (a linked batch
 * brings the actual cost), never from the list.
 */
type MissingCostLine={order_id:string;version:number;delivered_at:string|null;customer_name:string|null;line_id:string;product_id:string|null;name:string;option:string|null;color:string|null;qty:number;restocked_qty:number;cost_qty:number;stock_qty:number;preorder:boolean;confidence:string;estimate_unit_iqd:number|null;cogs_iqd:number|null};
const keptQty=(l:ProfitLine)=>Math.max(0,n(l.qty)-n(l.restocked_qty));
const isPreorder=(order:Row)=>s(order.shipping_type).startsWith('preorder_');
function missingCostLines(bases:OrderProfitBase[]):MissingCostLine[]{
  return bases.flatMap((b)=>b.lines.filter((l)=>!isConfirmedOrderCost(l.cost_confidence)).map((l)=>({order_id:b.order_id,version:b.version,delivered_at:b.order.delivered_at==null?null:s(b.order.delivered_at),customer_name:b.order.customer_name==null?null:s(b.order.customer_name),
    line_id:l.id,product_id:l.product_id??null,name:s(l.name_snapshot),option:l.option_snapshot==null?null:s(l.option_snapshot),color:l.color_snapshot==null?null:s(l.color_snapshot),qty:n(l.qty),restocked_qty:n(l.restocked_qty),cost_qty:keptQty(l),
    stock_qty:(l.allocations??[]).reduce((v,a)=>v+n(a.qty),0),preorder:isPreorder(b.order),confidence:s(l.cost_confidence),
    estimate_unit_iqd:typeof l.estimated_cost_iqd==='number'?l.estimated_cost_iqd:null,cogs_iqd:l.cogs_iqd==null?null:n(l.cogs_iqd)})));
}
/**
 * The orders whose every amount is known, and their share of the period's revenue.
 * General expenses and an unallocated promotion belong to the whole period, so the
 * complete orders carry only that share of them, never all of it. By revenue, not
 * by sold units: many cheap pieces (magnets) must not shift the overhead onto the
 * few dear ones and make a period that is a loss look like a profit (review 2026-11-11).
 */
/** An order whose every amount is known: «known», the statement's «محسوبة» column, the order list's state and the CSV all ask this one question. */
const isComplete=(b:OrderProfitBase)=>b.totals.owner_net_iqd!=null&&b.totals.profit_basis_iqd!=null;
function completeOrders(bases:OrderProfitBase[]){
  const complete=bases.filter(isComplete);
  const revenue=(rows:OrderProfitBase[])=>rows.reduce((v,b)=>v+Math.max(0,n(b.totals.retained_revenue_iqd)+n(b.totals.shipping_income_iqd)+n(b.totals.cod_tax_iqd)),0);
  const units=(rows:OrderProfitBase[])=>rows.reduce((v,b)=>v+n(b.totals.units),0);
  const allRevenue=revenue(bases),allUnits=units(bases);
  return {complete,share:allRevenue>0?revenue(complete)/allRevenue:allUnits>0?units(complete)/allUnits:bases.length?complete.length/bases.length:0};
}
/**
 * A complete order rests on confirmed costs only when every line's goods cost is
 * (FIFO from a priced batch, owner-verified, or a recorded snapshot); otherwise at
 * least one line still counts the sale-time estimate. The owner keeps estimates in
 * the net, always labelled (2026-11-11, DECISIONS row 313), so the two are told apart.
 */
const restsOnConfirmedCosts=(b:OrderProfitBase)=>b.lines.every((l)=>isConfirmedOrderCost(l.cost_confidence));
const orderRevenue=(b:OrderProfitBase)=>Math.max(0,n(b.totals.retained_revenue_iqd)+n(b.totals.shipping_income_iqd)+n(b.totals.cod_tax_iqd));
/**
 * The confirmed orders' part of the complete orders' overhead: by revenue, as the overhead
 * itself is shared, in dinars and in cents alike. The estimated part is the remainder, so
 * the two always add up to the known net exactly.
 */
function confirmedOverheadOf(complete:OrderProfitBase[],overhead:number){
  const revenue=complete.reduce((v,b)=>v+orderRevenue(b),0),confirmed=complete.filter(restsOnConfirmedCosts);
  return revenue>0?Math.round(overhead*confirmed.reduce((v,b)=>v+orderRevenue(b),0)/revenue):complete.length?Math.round(overhead*confirmed.length/complete.length):0;
}
/**
 * The one thing an incomplete order waits for — the statement's «تنتظر» column and the overview's banner say it
 * (redesign step 3). First match wins, in the order the owner fixes them: a purchase price; a wage that waits for
 * the goods cost; an investor share that waits for its cash or a confirmed cost; a refund amount. An investor share
 * held by a posting error waits for no cash and no price, so it is a line to review (independent review, 2026-11-11).
 * A goods cost that is unknown only because a piece RETURNED TO STOCK has no known cost (the line's own cost is confirmed)
 * is no missing purchase price: «التكاليف الناقصة» does not list it, so it waits for that cost in the order itself
 * (`return_cost`, the independent review of step 4).
 */
export type WaitReason='no_price'|'return_cost'|'wage_waits_cost'|'investor_waits'|'refund_unknown'|'other';
/** A line with no goods cost because its own price is not known — what «التكاليف الناقصة» lists — not a returned piece's. */
const noPrice=(l:ProfitLine)=>l.cogs_iqd===null&&!isConfirmedOrderCost(l.cost_confidence);
export function waitReason(b:OrderProfitBase,postingErrors:ReadonlySet<string>=new Set()):WaitReason{
  if(b.lines.some(noPrice))return 'no_price';
  if(b.lines.some((l)=>l.cogs_iqd===null))return 'return_cost';
  if(n(b.totals.pending_costs)>0)return 'wage_waits_cost';
  if(b.totals.investor_iqd===null)return postingErrors.has(b.order_id)?'other':'investor_waits';
  return b.totals.gross_profit_iqd===null?'refund_unknown':'other';
}
/**
 * WHERE AN ORDER STANDS (redesign step 4, DECISIONS row 316): complete on confirmed costs only, complete with at least one
 * sale-time estimate, or waiting — and then for what (waitReason). The order list, the statement's columns and every CSV view
 * read this one answer, so a row never says «مؤكد» while the statement counts it as waiting.
 */
export type FinanceState='confirmed'|'estimated'|'waiting';
export function orderState(b:OrderProfitBase,postingErrors:ReadonlySet<string>=new Set()):{finance_state:FinanceState;wait_reason:WaitReason|null}{
  if(!isComplete(b))return {finance_state:'waiting',wait_reason:waitReason(b,postingErrors)};
  return {finance_state:restsOnConfirmedCosts(b)?'confirmed':'estimated',wait_reason:null};
}
/**
 * A product's or a section's state, from its own lines, by the same rule in the same order: a line without a purchase
 * price first, then a returned piece's unknown cost, a wage that waits for the cost, an investor share (a line to review when every share it waits for
 * is held by a posting error), a refund amount; complete lines are confirmed, or estimated if one rests on the estimate.
 */
function groupState(lines:ProfitLine[],postingErrors:ReadonlySet<string>):{finance_state:FinanceState;wait_reason:WaitReason|null}{
  const t=sumRows(lines);
  if(t.owner_net_iqd!==null&&t.profit_basis_iqd!==null)return {finance_state:lines.every((l)=>isConfirmedOrderCost(l.cost_confidence))?'confirmed':'estimated',wait_reason:null};
  const held=lines.filter((l)=>l.investor_iqd===null);
  const reason:WaitReason=t.cogs_iqd===null?(lines.some(noPrice)?'no_price':'return_cost'):n(t.pending_costs)>0?'wage_waits_cost'
    :held.length?(held.every((l)=>postingErrors.has(s(l.order_id)))?'other':'investor_waits'):t.gross_profit_iqd===null?'refund_unknown':'other';
  return {finance_state:'waiting',wait_reason:reason};
}
/**
 * The cash of an order: nothing was due on delivery (paid before it), every amount due is recorded as received, part of it
 * is, or none yet. `collection_difference_iqd` is what is due (on delivery or from Gini, less a refund through Gini) and not
 * recorded; with what is recorded it makes what was due.
 */
export type CashState='prepaid'|'recorded'|'part'|'not_recorded';
export function cashState(t:Row):CashState{
  const recorded=n(t.collected_iqd),open=n(t.collection_difference_iqd);
  if(recorded+open<=0&&recorded<=0)return 'prepaid';
  if(open<=0)return 'recorded';
  return recorded>0?'part':'not_recorded';
}
/** The orders that carry a posting error: their investor share waits for no cash and no price (waitReason). One read for /summary, /orders and the export. */
async function postingErrorOrders(db:D1Database,bases:OrderProfitBase[]):Promise<Set<string>>{
  if(!bases.length)return new Set();
  const rows=await db.prepare('SELECT DISTINCT order_id FROM finance_posting_errors WHERE order_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(bases.map((b)=>b.order_id))).all<{order_id:string}>();
  return new Set((rows.results??[]).map((r)=>s(r.order_id)));
}
/** The period's figures over the orders whose every amount is known (none: null), and what the rest lack. */
function knownAndMissing(bases:OrderProfitBase[],general:number,unallocated:number,truncated:boolean,postingErrors:ReadonlySet<string>=new Set()){
  const {complete,share}=completeOrders(bases);
  const overhead={general:Math.round(general*share),unallocated:Math.round(unallocated*share)};
  const known=sumRows(complete.map((b)=>b.totals));known.orders_count=complete.length;
  const amounts=chartAmounts(known,overhead.general,overhead.unallocated,truncated);
  const confirmed=complete.filter(restsOnConfirmedCosts),estimated=complete.filter((b)=>!restsOnConfirmedCosts(b));
  const overheadTotal=overhead.general+overhead.unallocated,confirmedOverhead=confirmedOverheadOf(complete,overheadTotal);
  const part=(rows:OrderProfitBase[],share:number)=>{const t=sumRows(rows.map((b)=>b.totals));
    return {orders_count:rows.length,revenue_iqd:rows.reduce((v,b)=>v+orderRevenue(b),0),
      owner_net_iqd:t.owner_net_iqd===null||truncated?null:n(t.owner_net_iqd)-share,
      net_after_report_adjustments_iqd:t.net_after_report_adjustments_iqd===null||truncated?null:n(t.net_after_report_adjustments_iqd)-share,
      order_ids:rows.map((b)=>b.order_id)};};
  const lines=missingCostLines(bases),unknown=lines.filter((l)=>l.cogs_iqd===null);
  const products=new Map<string,{product_id:string|null;name:string;qty:number;lines:number}>();
  for(const l of unknown){const key=l.product_id??l.name,p=products.get(key)??{product_id:l.product_id,name:l.name,qty:0,lines:0};p.qty+=l.cost_qty;p.lines++;products.set(key,p);}
  // The orders that are not complete, and the one thing each waits for (waitReason).
  const incomplete=bases.filter((b)=>!complete.includes(b));
  const reasons:Record<string,string[]>={};for(const b of incomplete)(reasons[waitReason(b,postingErrors)]??=[]).push(b.order_id);
  return {
    known:complete.length?{orders_count:complete.length,incomplete_orders:bases.length-complete.length,revenue_iqd:amounts.revenue_iqd,cost_iqd:amounts.cost_iqd,owner_net_iqd:amounts.owner_net_iqd,
      net_after_report_adjustments_iqd:known.net_after_report_adjustments_iqd===null||truncated?null:n(known.net_after_report_adjustments_iqd)-overheadTotal,
      overhead_share_iqd:overheadTotal,general_share_iqd:overhead.general,unallocated_share_iqd:overhead.unallocated,
      totals:known,confirmed:part(confirmed,confirmedOverhead),estimated:part(estimated,overheadTotal-confirmedOverhead)}:null,
    waiting:incomplete.length?{orders_count:incomplete.length,totals:sumRows(incomplete.map((b)=>b.totals)),reasons,general_share_iqd:general-overhead.general,unallocated_share_iqd:unallocated-overhead.unallocated}:null,
    missing_costs:{lines:lines.length,orders:new Set(lines.map((l)=>l.order_id)).size,unknown_lines:unknown.length,estimated_lines:lines.length-unknown.length,
      unknown_products:[...products.values()].sort((a,b)=>b.qty-a.qty)},
  };
}
/**
 * One order of the period as the screens and the export read it. Redesign step 4 (DECISIONS row 316) adds what the reports
 * table shows beside its sums: `revenue_iqd` (net sales, delivery and the COD fee — the margin's base and the chart's revenue),
 * where the order stands (orderState) and its cash (cashState) — each from the one function the export uses too.
 * `unknown_refunds`: its lines with a refunded return whose amount nobody recorded. Their sales count that refund as 0
 * (orderProfit, as everywhere the period's sales are read), so the tables name it beside the figure instead of passing it
 * off as known (the independent review of step 4).
 */
const unknownRefunds=(lines:ProfitLine[])=>lines.filter((l)=>hasUnknownRefund(l)).length;
function orderRow(base:OrderProfitBase,postingErrors:ReadonlySet<string>=new Set()){return {...base.order,...base.totals,id:base.order_id,order_id:base.order_id,version:base.version,
  has_financial_activity:base.has_financial_activity,projected_finance:base.projected_finance,
  review_reasons:[...base.lines.flatMap(l=>l.cost_review?.issues??[]),...base.costs.flatMap(c=>Array.isArray(c.review_reasons)?c.review_reasons:[])],
  cost_confidence:base.lines.every((l)=>isConfirmedOrderCost(l.cost_confidence))?'verified':base.lines.some((l)=>l.cogs_iqd===null)?'unknown':'snapshot',
  revenue_iqd:n(base.totals.retained_revenue_iqd)+n(base.totals.shipping_income_iqd)+n(base.totals.cod_tax_iqd),
  unknown_refunds:unknownRefunds(base.lines),
  ...orderState(base,postingErrors),cash_state:cashState(base.totals)};}
/**
 * The period's lines by product, by main section or by subsection. Every line counts in each grouping — one with no
 * section (or no subsection) under 'unclassified' — so each table adds up to the period (redesign step 4). `qty` is every
 * piece sold, as before; `kept_qty` the pieces the customers kept and `returned_qty` the pieces they returned (owner
 * default 2026-11-11: the tables count what was kept, with the returned pieces shown apart). `order_ids` lets a row open
 * the orders it comes from; a product row names its main section (`main_id`, `main_name`).
 */
const groupKey=(l:ProfitLine,kind:'product'|'main'|'sub')=>(kind==='product'?l.product_id||s((l as Row).offer_product_id)||l.id:kind==='main'?l.main_catalog_id:l.sub_catalog_id)||'unclassified';
/**
 * A DRAWN SPOOL IS FILED UNDER ITS OFFER (redesign step 4, the plan's mystery-box check). A mystery box's spool lines carry
 * its money and its cost but no product of their own — the pick stays hidden (worker/routes/orders.ts) — so grouped by
 * product each spool was a row of its own named after the box, and its sections «غير مصنف». As the old report files them
 * (financeReport.ts, MYSTERY_SPOOL_SQL: the offer's id is the product of the line the spool belongs to), such a line is
 * grouped under that line's product and its sections. Only the offer's id and sections cross; nothing of the drawn spool.
 */
async function fileUnderOffer(db:D1Database,bases:OrderProfitBase[]){
  const spools=bases.flatMap((b)=>b.lines).filter((l)=>!l.product_id&&l.bundle_parent_item_id);
  if(!spools.length)return;
  const parents=new Map(((await db.prepare(`SELECT i.id,i.product_id,COALESCE(p.category_id,'') main_id,COALESCE(p.sub_category_id,'') sub_id,COALESCE(mc.name_ar,'') main_name,COALESCE(sc.name_ar,'') sub_name
    FROM order_items i LEFT JOIN products p ON p.id=i.product_id LEFT JOIN catalogs mc ON mc.id=p.category_id LEFT JOIN catalogs sc ON sc.id=p.sub_category_id
    WHERE i.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify([...new Set(spools.map((l)=>s(l.bundle_parent_item_id)))])).all<Row>()).results??[]).map((p)=>[s(p.id),p]));
  for(const l of spools){const p=parents.get(s(l.bundle_parent_item_id));if(!p?.product_id)continue;
    Object.assign(l,{offer_product_id:s(p.product_id)},l.main_catalog_id?{}:{main_catalog_id:s(p.main_id),main_name:s(p.main_name)},l.sub_catalog_id?{}:{sub_catalog_id:s(p.sub_id),sub_name:s(p.sub_name)});}
}
function grouped(lines:ProfitLine[],kind:'product'|'main'|'sub',postingErrors:ReadonlySet<string>=new Set()){
  const groups=new Map<string,{name:string;lines:ProfitLine[]}>();
  for(const l of lines){
    const key=groupKey(l,kind),name=kind==='product'?l.name_snapshot:kind==='main'?l.main_name:l.sub_name;
    const g=groups.get(key)??{name:name||'غير مصنف',lines:[]};g.lines.push(l);groups.set(key,g);}
  // estimated_lines: the lines whose goods cost is the sale-time estimate, so the overview names a margin that rests on it (owner decision 3).
  // unknown_lines: its lines with no goods cost, as an order's (totalProfit). A line carries no count of its own, so the sum of its
  // lines (sumRows) was always 0 — a file read «0 unknown lines» beside an empty goods cost (the second review of step 4).
  return [...groups].map(([id,g])=>({id,name:g.name,level:kind,qty:g.lines.reduce((v,l)=>v+l.qty,0),...sumRows(g.lines),orders_count:new Set(g.lines.map((l)=>l.order_id)).size,
    unknown_lines:g.lines.filter((l)=>l.cogs_iqd===null).length,
    estimated_lines:g.lines.filter((l)=>l.cogs_iqd!==null&&!isConfirmedOrderCost(l.cost_confidence)).length,
    kept_qty:g.lines.reduce((v,l)=>v+Math.max(0,n(l.qty)-n(l.returned_qty)),0),returned_qty:g.lines.reduce((v,l)=>v+n(l.returned_qty),0),unknown_refunds:unknownRefunds(g.lines),
    order_ids:[...new Set(g.lines.map((l)=>s(l.order_id)))],...groupState(g.lines,postingErrors),
    ...(kind==='product'?{main_id:g.lines[0].main_catalog_id||'unclassified',main_name:g.lines[0].main_name||'غير مصنف'}:{})}));
}
/**
 * The sections' names in Arabic, English and Sorani, from `catalogs` by id; the frozen Arabic snapshot of the sale
 * (`name`) stands in when the section is gone. The screen words «غير مصنف» itself.
 */
async function withSectionNames(db:D1Database,rows:Array<Row&{id:string;name:string}>){
  const ids=[...new Set(rows.map((r)=>r.id).filter((id)=>id&&id!=='unclassified'))];
  const found=ids.length?(await db.prepare('SELECT id,name_ar,name_en,name_ckb FROM catalogs WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).all<Row>()).results??[]:[];
  const live=new Map(found.map((c)=>[s(c.id),c]));
  return rows.map((r)=>{const c=live.get(r.id);return {...r,name_ar:s(c?.name_ar)||r.name,name_en:s(c?.name_en),name_ckb:s(c?.name_ckb)};});
}
/**
 * §21: the same delivered-order bases split by what made each order (0174) —
 * the cart, a Quick Buy session, or gifts only. The three rows add up to the
 * period totals. A gift order sells at 0 and still carries its goods cost, so
 * its profit is what the gifts cost; a Quick Buy hold is never here, because
 * a hold is not an order and an order counts only once it is delivered.
 */
const ORDER_KINDS=['normal','quick_buy','gift'] as const;
function byKind(bases:OrderProfitBase[]){
  return ORDER_KINDS.map((kind)=>{const rows=bases.filter((b)=>(ORDER_KINDS as readonly string[]).includes(s(b.order.order_kind))?b.order.order_kind===kind:kind==='normal');
    return {kind,...sumRows(rows.map((b)=>b.totals)),orders_count:rows.length};});
}
/**
 * Charts use the same delivered-order bases and full-month promotion shares as the report. Redesign step 4 (DECISIONS
 * row 316) adds the day's coupons, credited price protection and returned trade-in credits (`deductions_iqd`) and its net
 * after them (`net_after_report_adjustments_iqd`): «صافيك» on Reports → Days is the statement's, after the deductions, so
 * revenue − costs − investor share − deductions = the net on every day, and the days add up to «صافي حصتك».
 */
function chartAmounts(t:Row,general=0,unallocated=0,truncated=false){
  const revenue=n(t.retained_revenue_iqd)+n(t.shipping_income_iqd)+n(t.cod_tax_iqd);
  const cost=t.profit_basis_iqd===null||truncated?null:n(t.cogs_iqd)+n(t.direct_cost_iqd)+n(t.manual_direct_iqd)+n(t.courier_fee_iqd)+n(t.payment_fee_iqd)+n(t.promotion_iqd)+general+unallocated;
  return {revenue_iqd:revenue,cost_iqd:cost,owner_net_iqd:t.owner_net_iqd===null||truncated?null:n(t.owner_net_iqd)-general-unallocated,
    investor_iqd:t.investor_iqd===null||truncated?null:n(t.investor_iqd),orders_count:n(t.orders_count),unknown_lines:n(t.unknown_lines),pending_costs:n(t.pending_costs),
    deductions_iqd:n(t.coupon_iqd)+n(t.price_protection_iqd)+n(t.trade_in_credit_returned_iqd),
    net_after_report_adjustments_iqd:t.owner_net_iqd===null||t.net_after_report_adjustments_iqd===null||truncated?null:n(t.net_after_report_adjustments_iqd)-general-unallocated};
}
/** The Baghdad day an order was delivered on — the chart's bucket. */
function deliveredDay(b:OrderProfitBase){const at=s(b.order.delivered_at).replace(' ','T'),stamp=Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(at)?at:`${at}Z`);
  return new Date(stamp+3*3600000).toISOString().slice(0,10);}
/**
 * WHAT A DAY'S SUMS STAND ON (the second review of step 4): its orders whose known goods cost rests on a sale-time estimate —
 * a waiting order's too, whose cost is known while its investor share waits (`estimated_orders`, «تقديري n» beside a known cost
 * or net: owner decision 3) — and its orders whose sales count a refund nobody recorded as 0 (`unknown_refund_orders`, «مرتجع
 * غير مثبت n»). Reports → Days counts the same orders from /summary's own (reportTable.ts groupDays); its file says them too.
 */
const dayCounts=(day:OrderProfitBase[])=>({estimated_orders:day.filter((b)=>b.totals.profit_basis_iqd!=null&&!restsOnConfirmedCosts(b)).length,
  unknown_refund_orders:day.filter((b)=>unknownRefunds(b.lines)>0).length});
function summaryCharts(bases:OrderProfitBase[],r:{from:string;to:string},expenses:Row[],unallocated:Map<string,number>,totals:Row,truncated:boolean){
  const groups=new Map<string,OrderProfitBase[]>(),generalByDay=new Map(expenses.map((e)=>[s(e.expense_day),n(e.total)]));
  for(const b of bases){const day=deliveredDay(b),rows=groups.get(day)??[];rows.push(b);groups.set(day,rows);}
  const daily=[];
  for(let stamp=Date.parse(r.from);stamp<=Date.parse(r.to);stamp+=86400000){const day=new Date(stamp).toISOString().slice(0,10),rows=groups.get(day)??[],t=sumRows(rows.map((b)=>b.totals));t.orders_count=rows.length;
    const general=generalByDay.get(day)??0;
    daily.push({day,...chartAmounts(t,general,unallocated.get(day)??0,truncated),...dayCounts(rows)});}
  const pending=n(totals.pending_costs)>0;
  const expense_composition=[
    {key:'goods',amount_iqd:totals.cogs_iqd===null||truncated?null:n(totals.cogs_iqd)},
    {key:'wages',amount_iqd:pending||truncated?null:n(totals.wages_iqd)},
    {key:'materials',amount_iqd:pending||truncated?null:n(totals.materials_iqd)},
    {key:'other',amount_iqd:pending||truncated?null:n(totals.direct_cost_iqd)-n(totals.wages_iqd)-n(totals.materials_iqd)+n(totals.manual_direct_iqd)},
    {key:'delivery',amount_iqd:truncated?null:n(totals.courier_fee_iqd)+n(totals.payment_fee_iqd)},
    {key:'promotion',amount_iqd:truncated?null:n(totals.promotion_iqd)+n(totals.unallocated_promotion_iqd)},
    {key:'general',amount_iqd:n(totals.general_expenses_iqd)},
  ];
  return {daily,expense_composition,basis:'delivered_baghdad_day',...chartAmounts(totals,n(totals.general_expenses_iqd),n(totals.unallocated_promotion_iqd),truncated)};
}
/**
 * P-A F4 + F5: the order-level coupon and the credited price-protection
 * amounts, displayed after the investor split. Participant entitlements use
 * these same deductions through participantProfit (owner, 2026-10-22).
 * The original invoice/accounting basis stays intact; display deductions are
 * still applied once here. A line takes its share of `min(coupon, net goods)`
 * by net goods plus its own claims; the excess of a coupon above the goods
 * (it cut shipping, then the COD fee) stays at the order level, so the
 * products never carry more than their goods.
 */
function applyReportAdjustments(bases:OrderProfitBase[],adjustments:Map<string,ReportAdjustments>){
  for(const b of bases){
    const a=adjustments.get(b.order_id);const coupon=a?.coupon_iqd??0,claims=a?.price_protection_by_line??new Map<string,number>();
    const goods=b.lines.map((l)=>Math.max(0,n(l.net_goods_iqd))),toLines=Math.min(coupon,goods.reduce((v,x)=>v+x,0));
    const shares=spread(toLines,goods);
    // S-P2 (review F-12): an in-stock credit a return gave back is deducted from the line it paid for —
    // the cash refund is net of it — so this report and the period report agree.
    const returnedBy=a?.trade_in_credit_returned_by_line??new Map<string,number>();
    b.lines.forEach((l,i)=>{const share=shares[i]??0,credit=claims.get(l.id)??0,back=returnedBy.get(l.id)??0;
      l.coupon_iqd=share;l.price_protection_iqd=credit;(l as unknown as Record<string,unknown>).trade_in_credit_returned_iqd=back;
      l.net_after_report_adjustments_iqd=l.owner_net_iqd===null||l.owner_net_iqd===undefined?null:n(l.owner_net_iqd)-share-credit-back;});
    const credited=a?.price_protection_iqd??0,returned=a?.trade_in_credit_returned_iqd??0;
    b.totals.coupon_iqd=coupon;b.totals.price_protection_iqd=credited;
    // S-P2: a trade-in credit whose device is stock is shown, never deducted (DECISIONS row 238).
    (b.totals as Record<string,unknown>).trade_in_credit_iqd=a?.trade_in_credit_iqd??0;
    (b.totals as Record<string,unknown>).trade_in_credit_returned_iqd=returned;
    b.totals.net_after_report_adjustments_iqd=b.totals.owner_net_iqd===null||b.totals.owner_net_iqd===undefined?null:n(b.totals.owner_net_iqd)-coupon-credited-returned;
  }
  return bases;
}
async function addInvestors(db:D1Database,bases:OrderProfitBase[],live=false){
  await addOwnerPromotions(db,bases);
  if(!await investorFinanceInstalled(db)){for(const b of bases){b.totals.investor_iqd=0;for(const l of b.lines)l.investor_iqd=0;}return bases;}
  if(live){for(const b of bases){const split=await investorOrderSplit(db,b.order_id);
    for(const l of b.lines){const a=split.allocations.filter((a)=>l.allocations.some((v)=>v.id===a.allocation_id));l.investor_iqd=b.order.status==='delivered'?a.reduce((v,a)=>v+a.profit_iqd-a.loss_iqd,0):0;
      l.owner_net_iqd=l.profit_basis_iqd===null||split.pending?null:l.profit_basis_iqd-n(l.promotion_iqd)-n(l.investor_iqd);}
    b.totals.investor_iqd=split.investor_profit_iqd-n(split.investor_loss_iqd);b.totals.owner_net_iqd=b.totals.profit_basis_iqd===null||split.owner_profit_iqd===null?null:split.owner_profit_iqd-n(b.totals.promotion_iqd);
    if(split.pending)b.warnings.push('investor:pending');}return bases;}
  const ids=JSON.stringify(bases.map((b)=>b.order_id));
  const [rows,funded,errors]=await Promise.all([
    db.prepare(`SELECT a.order_id,a.order_item_id,r.profit_iqd,r.loss_iqd,r.pending,r.snapshot,${investorProjectionStaleSql('r.contract_id')} projection_stale FROM investor_allocation_results r JOIN order_item_inventory_allocations a ON a.id=r.allocation_id WHERE a.order_id IN (SELECT value FROM json_each(?))`).bind(ids).all<Row>(),
    // Funded = an ACTIVE agreement, as investorOrderSplit projects it: a voided one never gets a projection,
    // so counting it here held the sale's net as unknown for ever (audit V1, DECISIONS row 313).
    db.prepare("SELECT DISTINCT a.order_id,a.order_item_id FROM order_item_inventory_allocations a JOIN inventory_lots l ON l.id=a.lot_id JOIN investment_contracts c ON c.incoming_id=l.incoming_id AND c.state='active' WHERE a.order_id IN (SELECT value FROM json_each(?)) AND a.released_at IS NULL").bind(ids).all<Row>(),
    db.prepare('SELECT order_id FROM finance_posting_errors WHERE order_id IN (SELECT value FROM json_each(?))').bind(ids).all<Row>()]);
  for(const b of bases){let pending=false;
    for(const l of b.lines){const rr=(rows.results??[]).filter((r)=>r.order_id===b.order_id&&r.order_item_id===l.id),isFunded=(funded.results??[]).some((r)=>r.order_id===b.order_id&&r.order_item_id===l.id);
      const stale=isFunded&&(rr.length===0||rr.some((r)=>n(r.pending)>0||n(r.projection_stale)>0||n(JSON.parse(s(r.snapshot)).version)!==b.version)||(errors.results??[]).some((r)=>r.order_id===b.order_id)||!isConfirmedOrderCost(l.cost_confidence)||l.profit_basis_iqd===null);
      l.investor_iqd=stale?null:rr.reduce((v,r)=>v+n(r.profit_iqd)-n(r.loss_iqd),0);
      l.owner_net_iqd=stale||l.profit_basis_iqd===null?null:l.profit_basis_iqd-n(l.promotion_iqd)-n(l.investor_iqd);pending ||= stale;}
    b.totals.investor_iqd=b.lines.some((l)=>l.investor_iqd===null)?null:b.lines.reduce((v,l)=>v+n(l.investor_iqd),0);
    b.totals.owner_net_iqd=pending||b.totals.profit_basis_iqd===null?null:b.totals.profit_basis_iqd-n(b.totals.promotion_iqd)-n(b.totals.investor_iqd);
    if(pending)b.warnings.push('investor:pending');}
  return bases;
}
// ------------------------------------------------- display=USD (design P-A §8)
/**
 * «عملة العرض»: `?display=IQD|USD` on /summary, /orders and /orders/:id. IQD
 * (the default) answers exactly as before. USD adds ONE `display_usd` block
 * beside the answer — every IQD field stays byte-identical and nothing is
 * written. Each order is converted at the SHOP's effective USD/IQD in force
 * when it was created (worker/lib/fx/historyRate, the rate history), else at
 * today's rate marked «≈» (`usd_basis: 'today'`); never at the wallet's rate.
 * Expenses convert at the start of their own Baghdad day, an unallocated
 * promotion at the start of its month. With no applied rate at all,
 * `display_usd.available` is false and the page stays in dinars. Owner only,
 * private and no-store, as the rest of this router (the door above).
 *
 * FX-6 (FX plan §17, §19): a line's cost of goods converts at the USD/IQD its
 * BATCHES recorded when they were bought (migration 0182) wherever every
 * batch of the line recorded one and its allocations add up to the line's
 * cost exactly; otherwise at the order's rate, as above. Revenue stays at the
 * order's rate, and every derived figure is recomputed from those cents.
 * `batch_cost_lines` counts the lines so costed.
 */
type Display='IQD'|'USD';
function displayOf(value:string|undefined):Display{
  if(value===undefined||value===''||value==='IQD')return 'IQD';
  if(value==='USD')return 'USD';
  throw badRequest('عملة العرض غير معروفة / Unknown display currency','DISPLAY_CURRENCY_INVALID');
}
async function usdSteps(db:D1Database,instants:Array<number|null>){
  const known=instants.filter((x):x is number=>x!==null&&Number.isFinite(x));
  const now=Date.now(),anchor=known.length?Math.min(...known):now;
  return loadUsdRateSteps(db,new Date(Math.min(anchor,now)).toISOString(),new Date(now).toISOString());
}
const unavailableUsd=()=>({available:false as const});
interface OrderUsd{usd_basis:'at_time'|'today';fx_rate_snapshot:string;cents:Cents;lines:Map<string,Cents>;batch_lines:number}
/** The purchase-time USD/IQD every batch these orders consumed recorded (FX-6); empty without 0182. */
const lotRatesOf=(db:D1Database,bases:OrderProfitBase[])=>loadLotUsdRates(db,bases.flatMap((b)=>b.lines.flatMap((l)=>(l.allocations??[]).map((a)=>a.lot_id))));
/** One order in cents: each line at its batches' recorded rates where it can be (FX-6), else at the order's rate; the totals' cost of goods to match. */
function orderInUsd(b:OrderProfitBase,rate:string,lotRates:ReadonlyMap<string,string>){
  const plain=()=>({cents:centsOf(b.totals,rate),lines:new Map(b.lines.map((l)=>[l.id,centsOf(l,rate)])),batch_lines:0});
  if(!lotRates.size||b.totals.cogs_iqd===null||b.lines.some((l)=>l.cogs_iqd===null)||b.lines.reduce((v,l)=>v+n(l.cogs_iqd),0)!==b.totals.cogs_iqd)return plain();
  let batchIqd=0,batchCents=0,batchLines=0;const lines=new Map<string,Cents>();
  for(const l of b.lines){const c=batchCogsCents(l,lotRates);
    if(c===null){lines.set(l.id,centsOf(l,rate));continue;}
    batchLines+=1;batchIqd+=n(l.cogs_iqd);batchCents+=c;lines.set(l.id,centsOf(l,rate,{cogs_iqd:c}));}
  const rest=iqdToCents(b.totals.cogs_iqd-batchIqd,rate);
  if(!batchLines||rest===null)return plain();
  return {cents:centsOf(b.totals,rate,{cogs_iqd:rest+batchCents}),lines,batch_lines:batchLines};
}
/** Each order and each of its lines in cents, at the order's own creation-time rate (a line's cost of goods at its batches' rates, FX-6). Null when no rate exists at all. */
function ordersInUsd(bases:OrderProfitBase[],steps:UsdRateSteps|null,lotRates:ReadonlyMap<string,string>=new Map()){
  const out=new Map<string,OrderUsd>();
  for(const b of bases){const hit=usdRateAt(steps,instantOf(b.order.created_at));if(!hit)return null;
    out.set(b.order_id,{usd_basis:hit.basis,fx_rate_snapshot:hit.rate,...orderInUsd(b,hit.rate,lotRates)});}
  return out;
}
const basisCounts=(orders:Map<string,OrderUsd>)=>{const today=[...orders.values()].filter((o)=>o.usd_basis==='today').length;return {at_time_count:orders.size-today,today_count:today,batch_cost_lines:[...orders.values()].reduce((v,o)=>v+o.batch_lines,0)};};
const orderBlock=(orders:Map<string,OrderUsd>)=>Object.fromEntries([...orders].map(([id,o])=>[id,{usd_basis:o.usd_basis,fx_rate_snapshot:o.fx_rate_snapshot,cents:o.cents}]));
/**
 * AN ORDER'S LINES IN CENTS THAT ADD UP TO THE ORDER'S (the independent review of step 4, money lens). Each line converts on
 * its own, so two lines of 25,001 IQD at 1,500 made 3,334¢ against the order's 3,333¢, and a product's or a section's dollar
 * total drifted from the orders' by up to a cent a line and a field. Where the lines add up to their order in dinars, the
 * order's own cents are shared over them by their dinars (largest remainder, `spread`) and the figures derived from them
 * worked out again (rederive); where they do not — a coupon larger than the goods — the order-level row takes the rest
 * (orderLevelOf). For the products' and sections' dollars only: the order sheet keeps each line's own conversion.
 */
function linesAddingUp(b:OrderProfitBase,o:OrderUsd):Map<string,Cents>{
  const out=new Map(b.lines.map((l)=>[l.id,{...(o.lines.get(l.id)??{})}])),totals=b.totals as unknown as Row,row=(l:ProfitLine)=>l as unknown as Row;
  for(const f of ADDITIVE_IQD_FIELDS){
    const k=f.replace(/_iqd$/,'_cents'),target=o.cents[k];
    if(target==null||totals[f]==null||b.lines.some((l)=>row(l)[f]==null||out.get(l.id)![k]==null))continue;
    if(b.lines.reduce((v,l)=>v+n(row(l)[f]),0)!==n(totals[f]))continue;
    const rest=target-b.lines.reduce((v,l)=>v+(out.get(l.id)![k] as number),0);
    if(rest)spread(rest,b.lines.map((l)=>Math.abs(n(row(l)[f])))).forEach((x,i)=>{const c=out.get(b.lines[i].id)!;c[k]=(c[k] as number)+x;});
  }
  for(const c of out.values())rederive(c);
  return out;
}
function groupedCents(lines:ProfitLine[],kind:'product'|'main'|'sub',cents:ReadonlyMap<string,Cents>){
  const groups=new Map<string,Cents[]>();
  // The same keys as grouped() (groupKey): a line with no subsection under 'unclassified', a spool under its offer (redesign step 4).
  for(const l of lines){const key=groupKey(l,kind),rows=groups.get(key)??[];rows.push(cents.get(l.id)??{});groups.set(key,rows);}
  return Object.fromEntries([...groups].map(([id,rows])=>[id,sumCents(rows)]));
}
async function summaryInUsd(db:D1Database,bases:OrderProfitBase[],r:{from:string;to:string},expenses:Row[],unallocatedDays:Map<string,number>,truncated:boolean,pendingCosts:boolean,done=completeOrders(bases)){
  const expenseStarts=expenses.map((e)=>baghdadDayStart(s(e.expense_day))),monthStarts=[...unallocatedDays.keys()].map((d)=>baghdadDayStart(d));
  const steps=await usdSteps(db,[...bases.map((b)=>instantOf(b.order.created_at)),...expenseStarts,...monthStarts]);
  const orders=ordersInUsd(bases,steps,await lotRatesOf(db,bases));if(!orders||(!steps?.today&&!steps?.steps.length))return unavailableUsd();
  let approximate=[...orders.values()].some((o)=>o.usd_basis==='today');
  const atDay=(day:string,iqd:number)=>{const hit=usdRateAt(steps,baghdadDayStart(day));if(!hit)return null;if(hit.basis==='today')approximate=true;return iqdToCents(iqd,hit.rate);};
  const generalByDay=new Map<string,number>();for(const e of expenses){const c=atDay(s(e.expense_day),n(e.total));if(c===null)return unavailableUsd();generalByDay.set(s(e.expense_day),c);}
  const unallocatedByDay=new Map<string,number>();for(const [day,amount] of unallocatedDays){const c=atDay(day,amount);if(c===null)return unavailableUsd();unallocatedByDay.set(day,c);}
  const general=[...generalByDay.values()].reduce((v,x)=>v+x,0),unallocated=[...unallocatedByDay.values()].reduce((v,x)=>v+x,0);
  // The sum of no order is 0 in dollars as in dinars (sumRows): a period, or a day, without a delivered order
  // owes only its overheads — never a missing headline, cost tile or chart day beside the dinar figure.
  const sum=(rows:Cents[])=>rows.length?sumCents(rows):centsOf(sumRows([]),'1');
  const totals=sum([...orders.values()].map((o)=>o.cents));
  const ownerNet=totals.owner_net_cents??null;
  const periodNet=ownerNet===null||truncated?null:ownerNet-general-unallocated;
  // As in dinars: the orders after their own deductions (a returned trade-in credit included), minus the period's overheads.
  const afterDeductions=totals.net_after_report_adjustments_cents;
  Object.assign(totals,{general_expenses_cents:general,unallocated_promotion_cents:unallocated,owner_period_net_cents:periodNet,
    owner_period_net_after_report_adjustments_cents:periodNet===null||afterDeductions===null||afterDeductions===undefined?null:afterDeductions-general-unallocated});
  const byDay=new Map<string,Cents[]>();for(const b of bases){const day=deliveredDay(b),rows=byDay.get(day)??[];rows.push(orders.get(b.order_id)!.cents);byDay.set(day,rows);}
  const daily:Record<string,ReturnType<typeof chartCents>>={};
  for(let stamp=Date.parse(r.from);stamp<=Date.parse(r.to);stamp+=86400000){const day=new Date(stamp).toISOString().slice(0,10);
    daily[day]=chartCents(sum(byDay.get(day)??[]),generalByDay.get(day)??0,unallocatedByDay.get(day)??0,truncated);}
  // A kind without orders is 0 in every column, as its dinar row (sumRows) — never «ناقص» beside «0 طلب».
  const kinds=Object.fromEntries(ORDER_KINDS.map((kind)=>[kind,sum(bases.filter((b)=>(ORDER_KINDS as readonly string[]).includes(s(b.order.order_kind))?b.order.order_kind===kind:kind==='normal').map((b)=>orders.get(b.order_id)!.cents))]));
  const lines=bases.flatMap((b)=>b.lines.map((l)=>({...l,order_id:b.order_id})));
  // The lines' cents adding up to their orders' (linesAddingUp), and what no line carries — the order-level row of the
  // products and the sections, as in dinars: the order's deductions less its lines', its net less the lines' nets.
  const lineCents=new Map<string,Cents>(),levelRows:Cents[]=[];
  for(const b of bases){const o=orders.get(b.order_id)!,own=linesAddingUp(b,o);for(const [id,c] of own)lineCents.set(id,c);
    if(!orderLevelDeductions(b))continue;
    const rest=Object.fromEntries(REPORT_DEDUCTIONS.map((f)=>{const k=f.replace(/_iqd$/,'_cents');return [k,n(o.cents[k])-b.lines.reduce((v,l)=>v+n(own.get(l.id)?.[k]),0)];}));
    levelRows.push({...rest,net_after_report_adjustments_cents:o.cents.net_after_report_adjustments_cents==null?null:-Object.values(rest).reduce((v,x)=>v+x,0)});}
  // `known` (the complete orders, with their share of the period's overhead) in cents, as /summary's IQD `known`,
  // with its confirmed and estimated parts, so the overview names them in dollars beside a dollar headline.
  const knownCents=done.complete.length?sumCents(done.complete.map((b)=>orders.get(b.order_id)!.cents)):null,knownOverhead=Math.round(general*done.share)+Math.round(unallocated*done.share);
  const partCents=(rows:OrderProfitBase[],overhead:number)=>{const t=sum(rows.map((b)=>orders.get(b.order_id)!.cents));
    return {orders_count:rows.length,owner_net_cents:truncated||t.owner_net_cents==null?null:t.owner_net_cents-overhead,
      net_after_report_adjustments_cents:truncated||t.net_after_report_adjustments_cents==null?null:t.net_after_report_adjustments_cents-overhead};};
  const confirmedOverhead=confirmedOverheadOf(done.complete,knownOverhead);
  const knownGeneral=Math.round(general*done.share),knownUnallocated=Math.round(unallocated*done.share);
  // The statement's «محسوبة» and «تنتظر» columns in cents (redesign step 3): each the sum of its orders' cents, with
  // the overheads split as above, so in dollars too the two columns add up to the period's.
  const known=knownCents?{...chartCents(knownCents,knownGeneral,knownUnallocated,truncated),
    net_after_report_adjustments_cents:truncated||knownCents.net_after_report_adjustments_cents==null?null:knownCents.net_after_report_adjustments_cents-knownOverhead,
    confirmed:partCents(done.complete.filter(restsOnConfirmedCosts),confirmedOverhead),
    estimated:partCents(done.complete.filter((b)=>!restsOnConfirmedCosts(b)),knownOverhead-confirmedOverhead),
    totals:knownCents,general_share_cents:knownGeneral,unallocated_share_cents:knownUnallocated}:null;
  const incomplete=bases.filter((b)=>!done.complete.includes(b));
  const waitingCents=incomplete.length?{orders_count:incomplete.length,totals:sum(incomplete.map((b)=>orders.get(b.order_id)!.cents)),
    general_share_cents:general-knownGeneral,unallocated_share_cents:unallocated-knownUnallocated}:null;
  return {available:true as const,today_rate:steps?.today??null,...basisCounts(orders),approximate,known,waiting:waitingCents,
    orders:orderBlock(orders),kinds,products:groupedCents(lines,'product',lineCents),
    categories:{main:groupedCents(lines,'main',lineCents),sub:groupedCents(lines,'sub',lineCents)},order_level:levelRows.length?sumCents(levelRows):null,
    chart:{...chartCents(totals,general,unallocated,truncated),daily,expense_composition:expenseCompositionCents(totals,general,unallocated,pendingCosts,truncated)},
    totals};
}
async function selectOrders(db:D1Database,r:{from:string;to:string},opts:{q?:string;offset?:number;summary?:boolean;kind?:string}={}){
  const q=opts.q??'',kind=opts.kind??'';
  // Profit lists, counts, summaries and exports share realised deliveries.
  // A stage label, prepayment or stale delivery timestamp cannot make an
  // undelivered/cancelled order a sale; return facts still reduce each sale.
  // `kind` narrows the list to what made the order (0174 order_kind, D15).
  const condition="o.seller_type='levonis' AND o.status='delivered' AND date(o.delivered_at,'+3 hours') BETWEEN ? AND ? AND (?='' OR instr(lower(o.id||' '||COALESCE(u.name,'')),lower(?))>0) AND (?='' OR COALESCE(o.order_kind,'normal')=?)";
  const args=[r.from,r.to,q,q,kind,kind];
  const [rows,total]=await Promise.all([
    db.prepare(`SELECT o.id FROM orders o LEFT JOIN users u ON u.id=o.user_id WHERE ${condition} ORDER BY o.delivered_at DESC,o.id ${opts.summary?'':'LIMIT 100 OFFSET ?'}`).bind(...args,...(opts.summary?[]:[opts.offset??0])).all<{id:string}>(),
    db.prepare(`SELECT COUNT(*) total FROM orders o LEFT JOIN users u ON u.id=o.user_id WHERE ${condition}`).bind(...args).first<{total:number}>()]);
  const orderIds=(rows.results??[]).map((r)=>r.id);
  const rawBases:OrderProfitBase[]=[];
  for(let i=0;i<orderIds.length;i+=250)rawBases.push(...await getOrderProfitBases(db,orderIds.slice(i,i+250)));
  const byId=new Map(rawBases.map((b)=>[b.order_id,b]));
  const bases=orderIds.map((id)=>byId.get(id)!).filter(Boolean);
  await addInvestors(db,bases);applyReportAdjustments(bases,await reportAdjustments(db,bases.map((b)=>b.order_id)));
  if(!opts.summary)await enrichOrderCostProjections(db,bases);return {bases,total:total?.total??0,truncated:false};
}
adminFinanceWorkspaceRoutes.get('/participant-report',async c=>{const r=range(c.req.query('from'),c.req.query('to'));return c.json({success:true,...await participantReport(c.env.DB,r)});});
/**
 * THE PERIOD, READ ONCE (redesign step 4, DECISIONS row 316): /summary and every view of /export.csv but the line file
 * are built here, so a file never disagrees with the screen it was exported from. One set of queries, one set of rules:
 * the orders and their state, the products and sections, the days, «known» and «waiting», the overheads.
 */
async function periodFigures(db:D1Database,r:{from:string;to:string}){
  const {bases,truncated}=await selectOrders(db,r,{summary:true});
  await fileUnderOffer(db,bases);
  // An expense linked to an order is that order's cost while the order can still be
  // delivered (it waits for it, and is counted on its delivery). Once the order ended
  // without a delivery — cancelled, returned, refunded — it is a cost of the shop like
  // rent, on its own day; before 2026-11-11 it vanished from every figure (DECISIONS row 313).
  // Since redesign step 5 (DECISIONS row 317) where each expense counts is one fragment (financeExpenseKinds.ts) that
  // GET /expenses reads too: the general expenses by day and the costs still waiting for their orders come from it.
  const [spent,failures,promotions,postingErrors]=await Promise.all([
    periodExpenses(db,r),
    db.prepare('SELECT event_key id,order_id,message,last_attempt_at FROM finance_posting_errors WHERE order_id IN (SELECT value FROM json_each(?)) ORDER BY last_attempt_at DESC LIMIT 100').bind(JSON.stringify(bases.map((b)=>b.order_id))).all<Row>(),
    db.prepare("SELECT *,CASE WHEN currency='IQD' THEN amount_minor ELSE amount_minor/100.0 END amount FROM finance_monthly_promotions WHERE month BETWEEN ? AND ? ORDER BY month,id").bind(r.from.slice(0,7),r.to.slice(0,7)).all<Row>(),
    postingErrorOrders(db,bases)]);
  const expenseDays:Row[]=spent.days,totals=sumRows(bases.map((b)=>b.totals));totals.orders_count=bases.length;totals.general_expenses_iqd=spent.general_iqd;
  // Costs entered in the period for orders still on their way: not in this period's net, and named so they are not lost.
  totals.general_waiting_iqd=spent.waiting_iqd;
  let unallocated=0;const unallocatedDays=new Map<string,number>();
  for(const month of new Set((promotions.results??[]).map((p)=>s(p.month))))if(`${month}-01`>=r.from&&`${month}-01`<=r.to){const amount=(await monthlyPromotionShares(db,month)).unallocated_iqd;unallocated+=amount;unallocatedDays.set(`${month}-01`,amount);}
  totals.unallocated_promotion_iqd=unallocated;
  totals.owner_period_net_iqd=totals.owner_net_iqd===null||truncated?null:n(totals.owner_net_iqd)-n(totals.general_expenses_iqd)-unallocated;
  // F4/F5 at the period level: «الصافي بعد خصومات التقرير» — the orders after their own
  // deductions (coupon, credited price protection AND a returned trade-in credit, as each
  // order and product already counts it), minus the period's overheads (DECISIONS row 313).
  totals.owner_period_net_after_report_adjustments_iqd=totals.owner_period_net_iqd===null||totals.net_after_report_adjustments_iqd===null?null:n(totals.net_after_report_adjustments_iqd)-n(totals.general_expenses_iqd)-unallocated;
  if(truncated)totals.owner_net_iqd=null;
  const exceptions:Row[]=[...(failures.results??[]).map((e)=>({...e,type:'posting_failed'}))];
  for(const b of bases)for(const warning of b.warnings)exceptions.push({id:`${b.order_id}:${warning}`,order_id:b.order_id,type:warning.split(':')[0],message:warning.startsWith('cost:')?'تكلفة البضاعة تحتاج تثبيت FIFO أو تحققًا ماليًا خاصًا':warning==='investor:pending'?'توزيع المستثمر ينتظر التسوية':'يوجد بند مالي يحتاج مراجعة'});
  for(const b of bases)if(n(b.totals.pending_costs)>0)exceptions.push({id:`${b.order_id}:pending_cost`,order_id:b.order_id,type:'pending_cost',message:'الأجور أو المواد تنتظر تثبيت التكلفة'});
  const lines=bases.flatMap((b)=>b.lines);
  const categories=await withSectionNames(db,[...grouped(lines,'main',postingErrors),...grouped(lines,'sub',postingErrors)]);
  const answer={success:true,range:r,totals,...knownAndMissing(bases,n(totals.general_expenses_iqd),unallocated,truncated,postingErrors),orders:bases.map((b)=>orderRow(b,postingErrors)),kinds:byKind(bases),products:grouped(lines,'product',postingErrors),categories,
    order_level:orderLevelOf(bases),chart_data:summaryCharts(bases,r,expenseDays,unallocatedDays,totals,truncated),exceptions:exceptions.slice(0,200),promotions:promotions.results??[],general_expenses_iqd:totals.general_expenses_iqd,truncated,allocation_basis:'sales_value'};
  return {answer,bases,truncated,expenseDays,unallocatedDays,totals};
}
adminFinanceWorkspaceRoutes.get('/summary',async(c)=>{
  const db=c.env.DB,r=range(c.req.query('from'),c.req.query('to')),display=displayOf(c.req.query('display'));
  const {answer,bases,truncated,expenseDays,unallocatedDays,totals}=await periodFigures(db,r);
  if(display==='IQD')return c.json(answer);
  return c.json({...answer,display_usd:await summaryInUsd(db,bases,r,expenseDays,unallocatedDays,truncated,n(totals.pending_costs)>0)});
});
adminFinanceWorkspaceRoutes.get('/missing-costs',async(c)=>{
  const db=c.env.DB,r=range(c.req.query('from'),c.req.query('to'));
  const {bases,truncated}=await selectOrders(db,r,{summary:true});
  const lines=missingCostLines(bases);
  const ids=[...new Set(lines.map((l)=>l.product_id).filter((id):id is string=>!!id))];
  // A product with no stock batch cannot cost its next sale either: say so beside it.
  const stocked=ids.length?((await db.prepare('SELECT DISTINCT product_id FROM inventory_lots WHERE product_id IN (SELECT value FROM json_each(?)) AND unit_cost_iqd IS NOT NULL').bind(JSON.stringify(ids)).all<{product_id:string}>()).results??[]).map((x)=>x.product_id):[];
  return c.json({success:true,range:r,truncated,lines,stocked});
});
adminFinanceWorkspaceRoutes.get('/orders',async(c)=>{
  const r=range(c.req.query('from'),c.req.query('to')),offset=whole(c.req.query('offset')??0,'الصفحة',0,100000);
  const kind=text(c.req.query('kind'),20);if(kind&&!['normal','quick_buy','gift'].includes(kind))throw badRequest('نوع الطلب غير معروف');
  const display=displayOf(c.req.query('display'));
  const result=await selectOrders(c.env.DB,r,{offset,q:text(c.req.query('q'),100),kind});
  const postingErrors=await postingErrorOrders(c.env.DB,result.bases);
  const answer={success:true,orders:result.bases.map((b)=>orderRow(b,postingErrors)),total:result.total,offset,range:r};
  if(display==='IQD')return c.json(answer);
  const steps=await usdSteps(c.env.DB,result.bases.map((b)=>instantOf(b.order.created_at)));
  const orders=ordersInUsd(result.bases,steps,await lotRatesOf(c.env.DB,result.bases));
  return c.json({...answer,display_usd:!orders||(!steps?.today&&!steps?.steps.length)?unavailableUsd():{available:true,today_rate:steps?.today??null,...basisCounts(orders),orders:orderBlock(orders)}});
});
async function detail(db:D1Database,id:string,canVerify=true){
  const base=await getOrderProfitBase(db,id);if(base.order.seller_type!=='levonis')throw notFound('Order not found');
  await addInvestors(db,[base],true);
  applyReportAdjustments([base],await reportAdjustments(db,[base.order_id]));
  await enrichOrderCostProjections(db,[base],true);
  await enrichOrderProfitReview(db,base,canVerify);
  const history=await db.prepare('SELECT a.id,a.order_item_id line_id,a.field,a.old_value_iqd,a.new_value_iqd,a.version,a.actor_id,u.name actor_name,a.created_at,a.reason,a.journal_id FROM finance_order_adjustments a LEFT JOIN users u ON u.id=a.actor_id WHERE a.order_id=? ORDER BY a.version DESC LIMIT 200').bind(id).all<Row>();
  const wages=await db.prepare("SELECT a.id,c.order_item_id line_id,'amount_iqd' field,a.before_iqd old_value_iqd,a.after_iqd new_value_iqd,a.actor_id,u.name actor_name,a.created_at,a.kind,0 version FROM finance_cost_adjustments a JOIN finance_order_costs c ON c.id=a.cost_id LEFT JOIN users u ON u.id=a.actor_id WHERE c.order_id=? ORDER BY a.created_at DESC LIMIT 200").bind(id).all<Row>();
  return {...base,history:[...(history.results??[]),...(wages.results??[])].sort((a,b)=>s(b.created_at).localeCompare(s(a.created_at))).slice(0,200)};
}
async function reconcileWorkspace(db:D1Database,id:string,actor:string,day:string){
  const result=await reconcileFinanceOrder(db,id,{actor,day});
  if(result.complete)await db.prepare('DELETE FROM finance_posting_errors WHERE event_key=?').bind(`workspace-reconciliation:${id}`).run();
  return !result.complete;
}
adminFinanceWorkspaceRoutes.get('/orders/:id',async(c)=>{
  const actor=c.get('user')!,display=displayOf(c.req.query('display'));
  const permissions=(await c.env.DB.prepare("SELECT capability,allowed FROM ops_permissions WHERE user_id=? AND capability IN ('accounting','rules')").bind(actor.id).all<{capability:string;allowed:number}>()).results??[];
  // Owner, or (only once delegation exists) a cost grantee with an explicit
  // permission row: a missing row no longer means allowed (owner decision 2).
  const canVerify=isOwner(c.env,actor)||(canViewCost(c.env,actor)&&permissions.find(p=>p.capability==='accounting')?.allowed===1);
  const canReconcile=isOwner(c.env,actor)||(canViewCost(c.env,actor)&&permissions.find(p=>p.capability==='rules')?.allowed===1);
  const answer={success:true,...await detail(c.env.DB,c.req.param('id'),canVerify),can_reconcile:canReconcile};
  if(display==='IQD')return c.json(answer);
  const steps=await usdSteps(c.env.DB,[instantOf(answer.order.created_at)]);
  const order=ordersInUsd([answer],steps,await lotRatesOf(c.env.DB,[answer]))?.get(answer.order_id);
  return c.json({...answer,display_usd:!order?unavailableUsd():{available:true,today_rate:steps?.today??null,usd_basis:order.usd_basis,fx_rate_snapshot:order.fx_rate_snapshot,cents:order.cents,lines:Object.fromEntries(order.lines),batch_cost_lines:order.batch_lines}});
});
/**
 * One per-order correction (a goods cost, a fee, …): replay-safe by operation id,
 * versioned, fenced against a source change, posted and audited. `check` sees the
 * order as it is now, before anything is planned: it may refuse, or answer 'skip'.
 */
async function writeAdjustment(db:D1Database,actor:string,input:{id:string;field:ProfitField;value:number;lineId:string|null;operationId:string;version?:unknown;check?:(current:OrderProfitBase)=>'skip'|void}){
  const {id,field,value,lineId,operationId}=input;
  const old=await db.prepare('SELECT * FROM finance_order_adjustments WHERE operation_id=?').bind(operationId).first<ProfitAdjustment&{actor_id:string}>();
  if(old){if(old.order_id!==id||old.field!==field||old.order_item_id!==lineId||old.new_value_iqd!==value||old.actor_id!==actor)throw conflict('رقم العملية مستخدم لتعديل آخر');return {already:true,skipped:false,accounting_pending:false};}
  const source=await profitSourceFingerprint(db,id);
  const [current,plain]=await Promise.all([getOrderProfitBase(db,id),getOrderProfitBases(db,[id],{skipAdjustments:true})]);
  if(current.order.seller_type!=='levonis')throw notFound('Order not found');
  if(['cancelled','returned'].includes(s(current.order.status)))throw conflict('لا يمكن تعديل طلب ملغى');
  const expected=input.version===undefined?current.version:whole(input.version,'نسخة الحساب');
  if(expected!==current.version)throw conflict('تغيرت نسخة الحساب؛ حدّث الطلب');
  if(input.check?.(current)==='skip')return {already:false,skipped:true,accounting_pending:false};
  const plan=planProfitAdjustment(current,lineId,field,value),next=current.version+1,now=new Date().toISOString(),day=baghdadDay();await periodOpen(db,day);
  const before=JSON.stringify(current),after=JSON.parse(before) as OrderProfitBase;
  const revision:ProfitAdjustment={order_id:id,order_item_id:lineId,field,version:next,old_value_iqd:plan.previous,new_value_iqd:value,allocations_json:JSON.stringify(plan.allocations)};
  applyProfitAdjustment(after,revision);
  const posting=await planWorkspaceAccounting(db,plain[0],after,{actor,day});
  const adjustmentId=newId('profitfix');
  try{await db.batch([
    ...fence(db,`(${source.sql.replace(/\?1/g,'?2')})=? AND COALESCE((SELECT version FROM finance_order_versions WHERE order_id=?),0)=?`,[id,source.value,id,expected]),
    db.prepare('INSERT INTO finance_order_versions(order_id,version) VALUES (?,?) ON CONFLICT(order_id) DO UPDATE SET version=excluded.version').bind(id,next),
    ...posting.statements,
    db.prepare('INSERT INTO finance_order_adjustments(id,operation_id,order_id,order_item_id,field,old_value_iqd,new_value_iqd,delta_iqd,version,actor_id,created_at,journal_id,allocations_json,before_json,after_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(adjustmentId,operationId,id,lineId,field,plan.previous,value,plan.delta,next,actor,now,posting.journalIds[0]??null,revision.allocations_json,before,JSON.stringify(after)),
    db.prepare('INSERT INTO finance_order_calculations(order_id,version,snapshot,actor_id,created_at) VALUES (?,?,?,?,?)').bind(id,next,JSON.stringify(after),actor,now),
    ...(await auditStatements(db,actor,'finance.order_adjusted',id,{field,line_id:lineId,before:plan.previous,after:value,version:next,operation_id:operationId})).statements]);}
  catch(e){if(/CHECK constraint|UNIQUE constraint/.test(String(e)))throw conflict('تغير الطلب أثناء الحفظ؛ حدّث الحساب وأعد المحاولة');throw e;}
  return {already:false,skipped:false,accounting_pending:posting.pending};
}
adminFinanceWorkspaceRoutes.post('/orders/:id/adjustments',async(c)=>{
  const db=c.env.DB,actor=c.get('user')!,id=c.req.param('id');await requireCapability(c.env,actor,'accounting');
  const body=await c.req.json<Row>(),field=text(body.field,40) as ProfitField,value=whole(body.value_iqd,'القيمة الجديدة'),lineId=text(body.line_id,100)||null;
  if(!profitFields.includes(field))throw badRequest('الحقل المالي غير صحيح');
  const operationId=body.operation_id===undefined?newId('profitop'):str(body.operation_id,'رقم العملية',{min:8,max:100});
  const result=await writeAdjustment(db,actor.id,{id,field,value,lineId,operationId,version:body.version});
  const reconciliationPending=await reconcileWorkspace(db,id,actor.id,baghdadDay());
  return c.json(result.already?{success:true,already:true,reconciliation_pending:reconciliationPending,...await detail(db,id)}
    :{success:true,reconciliation_pending:reconciliationPending,accounting_pending:result.accounting_pending,...await detail(db,id)});
});
/**
 * «التكاليف الناقصة»: the owner's price of ONE PIECE for one line (owner 2026-11-10).
 * The server decides what it covers — the pieces the customer kept; a return put back
 * in stock is not a cost of the sale — and writes it through the same correction as
 * the order sheet, as the line's cost itself (planProfitAdjustment), never as a
 * change to its sale-time estimate.
 * Refused: a line with pieces from a stock batch (their batch cost is known; it is set
 * in the order itself), a pre-order line (its batch, once linked, brings the actual
 * cost) and a line whose pieces changed since the list was read.
 * Left as it is: a line priced meanwhile (a batch linked, a cost set in its order).
 * The order's version is read here, so two products of one order can be priced from
 * the same list one after the other. Its own rate bucket (`limitInstead` above).
 */
adminFinanceWorkspaceRoutes.post('/missing-costs/lines',async(c)=>{
  const db=c.env.DB,actor=c.get('user')!;await requireCapability(c.env,actor,'accounting');
  const body=await c.req.json<Row>(),id=str(body.order_id,'رقم الطلب',{min:1,max:100}),lineId=str(body.line_id,'رقم البند',{min:1,max:100});
  const unit=whole(body.unit_iqd,'سعر القطعة'),costQty=whole(body.cost_qty,'عدد القطع',0,1e6),value=unit*costQty;
  if(!Number.isSafeInteger(value)||value>1e12)throw badRequest('القيمة المالية غير صحيحة');
  const operationId=str(body.operation_id,'رقم العملية',{min:8,max:100});
  const result=await writeAdjustment(db,actor.id,{id,field:'cogs_iqd',value,lineId,operationId,check:(current)=>{
    const line=current.lines.find((l)=>l.id===lineId);if(!line)throw notFound('Order line not found');
    if(isConfirmedOrderCost(line.cost_confidence))return 'skip';
    if((line.allocations??[]).length>0)throw conflict('بعض قطع هذا البند من دفعة مخزون؛ ثبّت تكلفته من الطلب نفسه','MISSING_COST_HAS_STOCK');
    // A pre-order's batch brings its actual cost («اربط بالدفعة الواصلة»); a typed price would stay over it.
    if(isPreorder(current.order))throw conflict('هذا البند من طلب مسبق؛ اربط دفعته الواصلة من الطلب نفسه لتُحسب تكلفته الفعلية','MISSING_COST_PREORDER');
    if(keptQty(line)!==costQty)throw conflict('تغيّرت قطع هذا البند منذ فُتحت القائمة؛ حدّثها وراجعها','MISSING_COST_LINE_CHANGED');
  }});
  const reconciliationPending=result.skipped?false:await reconcileWorkspace(db,id,actor.id,baghdadDay());
  return c.json({success:true,already:result.already,skipped:result.skipped,reconciliation_pending:reconciliationPending,accounting_pending:result.accounting_pending});
});
/**
 * «التكاليف ← ترويج الشهر» (redesign step 5, DECISIONS row 317) reads, beside the month's promotion and its rate suggestion:
 * WHO CARRIES IT — the month's products, each with its pieces, its net sales and its share of the promotion, from the very
 * line shares every order carries (monthlyPromotionShares: the rule does not change; a bundle's parent is never a line of its
 * own, a drawn spool is filed under its offer), so the rows add up to `total_iqd` exactly — with the month's sales and line
 * count; and THE HISTORY of its edits (finance_promotion_history, migration 0163), newest first, each with who made it and the
 * amount and month before and after (an edit can move a promotion to another month: both months list it, and the page says
 * so), the latest PROMOTION_HISTORY_LIMIT of them and `history_truncated` when there are more. `month` must be a month (400).
 */
type PromotionState={month:string;currency:string;amount:number;exchange_rate:number;amount_iqd:number;enabled:boolean};
function promotionState(json:string):PromotionState|null{
  let v:Row;try{v=JSON.parse(json) as Row;}catch{return null;}
  if(!v||typeof v!=='object'||v.amount_minor===undefined)return null;
  return {month:s(v.month),currency:s(v.currency),amount:n(v.amount_minor)/(v.currency==='IQD'?1:100),exchange_rate:n(v.exchange_rate),amount_iqd:n(v.amount_iqd),enabled:n(v.enabled)===1||v.enabled===true};
}
adminFinanceWorkspaceRoutes.get('/promotions',async(c)=>{
  const month=text(c.req.query('month'),7)||baghdadDay().slice(0,7);
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw badRequest('الشهر غير صحيح / Invalid month','PROMOTION_MONTH_INVALID');
  const allocation=await monthlyPromotionShares(c.env.DB,month);
  // P-A F3: a SUGGESTION for the rate field — the shop's USD/IQD in force on the
  // month's first day (worker/lib/fx/historyRate), never the wallet's. The page
  // shows it and fills the field only when the owner taps it; the server never
  // books a promotion at it unless that rate is sent as the rate actually paid.
  const start=baghdadDayStart(`${month}-01`),steps=start===null?null:await usdSteps(c.env.DB,[start]),hit=usdRateAt(steps,start);
  const rate_suggestion=hit?{rate:hit.rate,date:`${month}-01`,usd_basis:hit.basis}:null;
  const edits=(await c.env.DB.prepare(PROMOTION_HISTORY_SQL).bind(month,month).all<Row>()).results??[];
  const history=edits.slice(0,PROMOTION_HISTORY_LIMIT).map((h)=>({id:s(h.id),promotion_id:s(h.promotion_id),version:n(h.version),at:s(h.created_at),actor_id:s(h.actor_id),actor_name:h.actor_name==null?null:s(h.actor_name),
    before:promotionState(s(h.before_json)),after:promotionState(s(h.after_json))}));
  return c.json({success:true,month,promotions:allocation.promotions,total_iqd:allocation.total_iqd,unallocated_iqd:allocation.unallocated_iqd,allocation_basis:'sales_value',rate_suggestion,
    products:allocation.products,sales_iqd:allocation.sales_iqd,lines_count:allocation.lines_count,history,history_truncated:edits.length>PROMOTION_HISTORY_LIMIT});
});
/**
 * «التكاليف ← المصاريف العامة» (redesign step 5, DECISIONS row 317): the period's expense entries, each with where it counts
 * (financeExpenseKinds.ts: general, the month's promotion, an order's wage or material, a courier's fee, linked to a delivered
 * order, to one on its way, or to one that ended without a delivery), its category in three languages, its cost-centre tag
 * and the order or the promotion's month it counts with; and the period's sums from the same statement /summary reads —
 * `general_iqd` is the statement's «المصاريف العامة», `waiting_iqd` its «تنتظر تسليم طلباتها», `by_category` the general
 * entries by category (they add up to `general_iqd`), `by_kind` every entry, so the page can say why the ledger's total of
 * every entry is not the general figure. Voided rows only with `include_voided=1`, flagged, and never in a sum. The period is
 * at most a year (400), as /summary's; the door is the owner's (cost read), as for every route here.
 *
 * The independent review of step 5: the general entries are listed first (EXPENSE_ROWS_SQL), so the first EXPENSE_ROW_LIMIT
 * rows cut the other kinds before the rent the page and the drawer list; `truncated` still says a row was left out, and the
 * page takes every heading and its emptiness from the totals, never from the rows it was given. `closed_months` names the
 * months of the period whose accounting is closed: their entries cannot change, so the page offers no edit there.
 */
adminFinanceWorkspaceRoutes.get('/expenses',async(c)=>{
  const db=c.env.DB,r=range(c.req.query('from'),c.req.query('to')),voided=['1','true'].includes(c.req.query('include_voided')??'')?1:0;
  const [totals,rows,closed]=await Promise.all([periodExpenses(db,r),db.prepare(EXPENSE_ROWS_SQL).bind(r.from,r.to,voided,EXPENSE_ROW_LIMIT+1).all<Row>(),
    db.prepare(CLOSED_MONTHS_SQL).bind(r.from.slice(0,7),r.to.slice(0,7)).all<Row>()]);
  const list=(rows.results??[]).slice(0,EXPENSE_ROW_LIMIT).map((e)=>({id:s(e.id),expense_day:s(e.expense_day),amount_iqd:n(e.amount_iqd),title:s(e.title),note:s(e.note),series_id:e.series_id==null?null:s(e.series_id),
    category_id:s(e.category_id),category:{name_ar:s(e.category_name_ar),name_en:s(e.category_name_en),name_ckb:s(e.category_name_ckb)},
    kind:s(e.expense_kind),counts_as_general:isGeneralKind(s(e.expense_kind)),order_id:e.order_id==null?null:s(e.order_id),order_status:e.order_status==null?null:s(e.order_status),
    promotion_month:e.promotion_month==null?null:s(e.promotion_month),center_id:e.center_id==null?null:s(e.center_id),center_name:e.center_name==null?null:s(e.center_name),
    voided:e.voided_at!=null,void_reason:s(e.void_reason)}));
  const {general_iqd,waiting_iqd,all_iqd,entries,by_kind,by_category}=totals;
  return c.json({success:true,range:r,rows:list,truncated:(rows.results??[]).length>EXPENSE_ROW_LIMIT,totals:{general_iqd,waiting_iqd,all_iqd,entries,by_kind,by_category},
    closed_months:(closed.results??[]).map((m)=>s(m.month))});
});
async function promotionValues(db:D1Database,b:Row,old?:Row){
  const month=b.month===undefined?s(old?.month):text(b.month,7);if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw badRequest('الشهر غير صحيح');
  const currency=b.currency===undefined?s(old?.currency||'USD'):text(b.currency,3);if(!['IQD','USD','EUR','CNY'].includes(currency))throw badRequest('العملة غير صحيحة');
  const amount=b.amount===undefined&&old?n(old.amount_minor)/(old.currency==='IQD'?1:100):decimal(b.amount,'المبلغ',0.01),scale=currency==='IQD'?1:100;
  const minor=Math.round(amount*scale);if(!Number.isSafeInteger(minor)||minor<=0||Math.abs(amount*scale-minor)>0.000001)throw badRequest('عدد المنازل العشرية غير صحيح');
  // P-A F3 (owner brief 2026-10-09; owner decision 9): a promotion in another
  // currency is booked at the rate ACTUALLY PAID. The wallet's 1 USD = 1,400
  // IQD used to fill a missing rate and was stored as the expense — a rate
  // nobody paid. Now a missing rate is refused unless an existing row of the
  // same currency already carries its own (an edit keeps the stored rate);
  // the page only SUGGESTS the shop's rate, it never submits it.
  const missing=b.exchange_rate===undefined||b.exchange_rate===null||b.exchange_rate==='';
  const fx=currency==='IQD'?1:missing?(old&&currency===old.currency?n(old.exchange_rate):0):decimal(b.exchange_rate,'سعر التحويل',0.000001);
  if(!Number.isFinite(fx)||fx<=0)throw badRequest(serverMessage('PROMOTION_RATE_REQUIRED'),'PROMOTION_RATE_REQUIRED');
  const iqd=Math.round(amount*fx);whole(iqd,'قيمة الدينار',1);
  return {month,title:b.title===undefined?s(old?.title||'ترويج شهري'):text(b.title,200)||'ترويج شهري',currency,amount_minor:minor,exchange_rate:fx,amount_iqd:iqd,enabled:b.enabled===undefined?n(old?.enabled??1):b.enabled?1:0};
}
async function promotionWrite(db:D1Database,actor:string,id:string|null,b:Row,disable=false){
  const operationId=b.operation_id===undefined?newId('promoop'):str(b.operation_id,'رقم العملية',{min:8,max:100});
  const prior=await db.prepare('SELECT * FROM finance_promotion_history WHERE operation_id=?').bind(operationId).first<{promotion_id:string;actor_id:string;after_json:string}>();
  const request=JSON.stringify({...b,operation_id:undefined,disable});
  if(prior){const after=JSON.parse(prior.after_json) as Row;if(prior.actor_id!==actor||(id&&id!==prior.promotion_id)||after.request!==request)throw conflict('رقم العملية مستخدم لتعديل آخر');return {id:prior.promotion_id,already:true};}
  const old=id?await db.prepare('SELECT * FROM finance_monthly_promotions WHERE id=?').bind(id).first<Row>():null;if(id&&!old)throw notFound('الترويج غير موجود');
  if(old&&b.version!==undefined&&whole(b.version,'النسخة')!==n(old.version))throw conflict('تغير الترويج؛ حدّث الصفحة');
  const value=await promotionValues(db,disable?{...b,enabled:false}:b,old??undefined),day=`${value.month}-01`,now=new Date().toISOString();
  await periodOpen(db,day);if(old)await periodOpen(db,`${s(old.month)}-01`);
  const promotionId=id??newId('promo'),expenseId=s(old?.expense_id)||newId('expense'),version=n(old?.version)+1;
  if(value.enabled&&await db.prepare('SELECT 1 FROM finance_monthly_promotions WHERE month=? AND enabled=1 AND id<>?').bind(value.month,promotionId).first())throw conflict('يوجد ترويج فعال لهذا الشهر؛ عدّل قيمته');
  const statements:D1PreparedStatement[]=[...fence(db,`NOT EXISTS(SELECT 1 FROM finance_monthly_promotions WHERE month=? AND enabled=1 AND id<>?) OR ?=0`,[value.month,promotionId,value.enabled])];
  if(old)statements.push(...fence(db,'EXISTS(SELECT 1 FROM finance_monthly_promotions WHERE id=? AND version=?)',[promotionId,n(old.version)]),db.prepare('INSERT INTO ops_guards(id,ok) VALUES (?,1)').bind(`promotion-write:${expenseId}`),
    db.prepare('UPDATE operating_expenses SET amount_iqd=?,expense_day=?,title=?,updated_at=?,voided_at=?,voided_by=?,void_reason=? WHERE id=?').bind(value.amount_iqd,day,value.title,now,value.enabled?null:now,value.enabled?null:actor,value.enabled?'':'إيقاف الترويج الشهري',expenseId));
  else statements.push(db.prepare('INSERT INTO operating_expenses(id,category_id,amount_iqd,expense_day,title,created_by,created_at,updated_at,voided_at,voided_by) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(expenseId,'exp_owner_marketing',value.amount_iqd,day,value.title,actor,now,now,value.enabled?null:now,value.enabled?null:actor));
  statements.push(...await planExpenseAccounting(db,{id:expenseId,actor,title:value.title,day,amount:value.amount_iqd,fresh:!old,void:!value.enabled}));
  if(old)statements.push(db.prepare('UPDATE finance_monthly_promotions SET month=?,title=?,currency=?,amount_minor=?,exchange_rate=?,amount_iqd=?,enabled=?,version=?,updated_at=? WHERE id=?').bind(value.month,value.title,value.currency,value.amount_minor,value.exchange_rate,value.amount_iqd,value.enabled,version,now,promotionId));
  else statements.push(db.prepare('INSERT INTO finance_monthly_promotions(id,month,title,currency,amount_minor,exchange_rate,amount_iqd,enabled,expense_id,version,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(promotionId,value.month,value.title,value.currency,value.amount_minor,value.exchange_rate,value.amount_iqd,value.enabled,expenseId,version,actor,now,now));
  const after={id:promotionId,...value,expense_id:expenseId,version,request};
  statements.push(db.prepare('INSERT INTO finance_promotion_history(id,promotion_id,operation_id,version,before_json,after_json,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?)').bind(newId('promohist'),promotionId,operationId,version,JSON.stringify(old??{}),JSON.stringify(after),actor,now));
  if(old)statements.push(db.prepare('DELETE FROM ops_guards WHERE id=?').bind(`promotion-write:${expenseId}`));
  statements.push(...(await auditStatements(db,actor,'finance.monthly_promotion',promotionId,{before:old,after})).statements);
  try{await db.batch(statements);}catch(e){if(/CHECK constraint|UNIQUE constraint/.test(String(e)))throw conflict('تغير الترويج أثناء الحفظ؛ حدّث الصفحة');throw e;}
  return {id:promotionId,promotion:{...after,amount:value.amount_minor/(value.currency==='IQD'?1:100)}};
}
adminFinanceWorkspaceRoutes.post('/promotions',async(c)=>{const actor=c.get('user')!;await requireCapability(c.env,actor,'accounting');return c.json({success:true,...await promotionWrite(c.env.DB,actor.id,null,await c.req.json<Row>())});});
adminFinanceWorkspaceRoutes.patch('/promotions/:id',async(c)=>{const actor=c.get('user')!;await requireCapability(c.env,actor,'accounting');return c.json({success:true,...await promotionWrite(c.env.DB,actor.id,c.req.param('id'),await c.req.json<Row>())});});
adminFinanceWorkspaceRoutes.delete('/promotions/:id',async(c)=>{const actor=c.get('user')!;await requireCapability(c.env,actor,'accounting');return c.json({success:true,...await promotionWrite(c.env.DB,actor.id,c.req.param('id'),{},true)});});
// An amount is written as a number, so a spreadsheet sums it (a loss included); only
// text that could start a formula gets the leading «'» (DECISIONS row 313). Since the
// independent review of step 4 that includes text starting with white space (a line feed,
// a space — a spreadsheet that trims it would read the formula behind it) and with the
// full-width ＝ ＋ － ＠: a customer writes their own name. A finance file is never read
// back in, so nothing has to take the quote off again.
const csvCell=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?String(v):`"${s(v).replace(/^[\s=+\-@＝＋－＠]/,"'$&").replace(/"/g,'""')}"`;
/**
 * What an order deducts beyond its lines: a line carries the order coupon only up to its own
 * goods, so the rest of a coupon larger than the goods (it cut the shipping, then the COD fee)
 * stays with the order (applyReportAdjustments). The export gives it its own order-level row
 * (`row_kind` 'order_level'), so each deduction column, and the net after them, adds up to the
 * orders' own figures (review R3, DECISIONS row 313). Null: nothing is left at the order level.
 */
const REPORT_DEDUCTIONS=['coupon_iqd','price_protection_iqd','trade_in_credit_returned_iqd'] as const;
function orderLevelDeductions(b:OrderProfitBase):Row|null{
  const totals=b.totals as unknown as Row,lines=b.lines as unknown as Row[];
  const rest=Object.fromEntries(REPORT_DEDUCTIONS.map((f)=>[f,n(totals[f])-lines.reduce((v,l)=>v+n(l[f]),0)]));
  if(REPORT_DEDUCTIONS.every((f)=>rest[f]===0))return null;
  return {...rest,net_after_report_adjustments_iqd:b.totals.net_after_report_adjustments_iqd==null?null:-REPORT_DEDUCTIONS.reduce((v,f)=>v+rest[f],0),row_kind:'order_level'};
}
/**
 * WHAT NO PRODUCT AND NO SECTION CARRIES (the independent review of step 4, money lens). The rest above — a coupon larger
 * than the goods, a price protection or a returned trade-in credit no line carries — is on the order but on no product and
 * no section, so the products' and the sections' «صافيك» added up to more than the orders', with nothing on screen to say
 * why. /summary names it once (`order_level`, the same rest for the products and both levels of sections), and their tables
 * and files give it a row of its own, so each grouping adds up to the orders. Its net is unknown while an order it comes
 * from has none, as a product's is. Null: nothing is left at the order level.
 */
function orderLevelOf(bases:OrderProfitBase[]){
  const rows=bases.flatMap((b):Row[]=>{const r=orderLevelDeductions(b);return r?[{...r,order_id:b.order_id}]:[];});
  if(!rows.length)return null;
  const sum=(f:string)=>rows.some((r)=>r[f]===null)?null:rows.reduce((v,r)=>v+n(r[f]),0);
  return {coupon_iqd:n(sum('coupon_iqd')),price_protection_iqd:n(sum('price_protection_iqd')),trade_in_credit_returned_iqd:n(sum('trade_in_credit_returned_iqd')),
    net_after_report_adjustments_iqd:sum('net_after_report_adjustments_iqd'),order_ids:rows.map((r)=>s(r.order_id)),orders_count:rows.length};
}
/** The order-level row's name in the files' name columns (the screens word it themselves). */
const ORDER_LEVEL_NAMES=['خصومات على مستوى الطلب','Order-level deductions','داشکاندنەکانی ئاستی داواکاری'] as const;
/**
 * THE EXPORT FOLLOWS THE PAGE (redesign step 4, DECISIONS row 316). `view=lines` (the default) is the line file it always
 * was, byte for byte. `view=orders` is Reports → Orders, one row per order with where it stands and its cash;
 * `&part=calculated|waiting` keeps the orders of one column of the statement and adds that column's share of the
 * period's overheads as a last row (`row_kind` 'overhead'), so the file adds up to the column, as the figure drawer
 * does. `view=products` and `view=sections&level=main|sub` are the products and sections tables (the pieces kept and
 * returned apart), `view=days` the days. Every view but the lines is built from periodFigures, the read /summary
 * answers from. An unknown amount is an empty cell, never 0, so a spreadsheet's sum is the known sum the screen shows.
 * The independent review of step 4 adds what the page shows (exportFilter), the order-level row of the products and the
 * sections (orderLevelOf), `&part=period` (the drawer of a period with no order: its overheads alone), and the wages and
 * materials of a row whose costs still wait (`pending_costs`) as empty cells, as the screens show them. The second review adds
 * a product's and a section's own `unknown_lines` (grouped) and each day's `estimated_orders` and `unknown_refund_orders`
 * (dayCounts). The line file still writes a waiting wage's approved part: its bytes stay as they were (the owner's question).
 * The fourth review adds each order's `estimated_cost`: 1 when its known goods cost rests on a sale-time estimate (a waiting order's
 * too, as Reports → Orders names it), 0 when it is confirmed, empty beside an unknown one — so the column adds up to the goods-cost
 * total's «تقديري n», which the orders' `finance_state` alone cannot give.
 */
const EXPORT_VIEWS=['lines','orders','products','sections','days','expenses'] as const;
const csvFile=(rows:Row[],fields:readonly string[],name:string)=>new Response('\uFEFF'+[fields.map(csvCell).join(','),...rows.map((row)=>fields.map((f)=>csvCell(row[f])).join(','))].join('\r\n'),
  {headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${name}"`}});
const MONEY_COLUMNS=['retained_revenue_iqd','cogs_iqd','gross_profit_iqd','shipping_income_iqd','cod_tax_iqd','wages_iqd','materials_iqd','manual_direct_iqd','courier_fee_iqd','payment_fee_iqd','promotion_iqd'] as const;
const NET_COLUMNS=['investor_iqd','owner_net_iqd','coupon_iqd','price_protection_iqd','trade_in_credit_returned_iqd','net_after_report_adjustments_iqd'] as const;
const ORDER_COLUMNS=['order_id','delivered_day','customer_name','order_kind','finance_state','wait_reason','cash_state','revenue_iqd',...MONEY_COLUMNS,'general_expenses_iqd',...NET_COLUMNS,'collected_iqd','collection_difference_iqd','pending_costs','unknown_lines','unknown_refunds','estimated_cost','row_kind'] as const;
const GROUP_COLUMNS=['kept_qty','returned_qty',...MONEY_COLUMNS,...NET_COLUMNS,'finance_state','wait_reason','estimated_lines','orders_count','pending_costs','unknown_lines','unknown_refunds','row_kind'] as const;
// Since the second review of step 4 a day also says how many of its orders stand on a sale-time estimate and how many count an
// unrecorded refund as 0 (dayCounts), as the page does beside its cost, net and revenue; since the third, the estimates only
// beside a known cost (exportView), where the page names them.
const DAY_COLUMNS=['day','orders_count','revenue_iqd','cost_iqd','investor_iqd','deductions_iqd','net_after_report_adjustments_iqd','owner_net_iqd','unknown_lines','pending_costs','estimated_orders','unknown_refund_orders'] as const;
/** A week or a month of Reports → Days: its first and last day in the period, then the day's columns. */
const BUCKET_COLUMNS=['from','to',...DAY_COLUMNS.slice(1)] as const;
/** «غير مصنف» in the file's three name columns: a line with no section, or no subsection. */
const UNCLASSIFIED={main:['غير مصنف','Unclassified','پۆلێننەکراو'],sub:['بلا قسم فرعي','No subsection','بێ بەشی لاوەکی']} as const;
/**
 * THE FILE IS THE PAGE AS IT IS SHOWN (the independent review of step 4). A filtered page exported every row of the period
 * and a week view eleven days, so neither added up to its screen. The page sends what it shows — Reports → Orders its search
 * (`q`), status (`state`: a state or `reason:<why>`), type (`kind`) and the row or days it was opened on (`scope`:
 * `product:`, `main:` or `sub:` and an id, or `days:<from>:<to>`); a cash figure of the drawer the orders whose cash is due
 * or not recorded yet (`cash=due|open`); the products and the sections their search; the days their grouping (`by`) — and
 * the server applies it to its own rows by the screen's rules (reportTable.ts filterOrders, scopeIds, filterGroups,
 * groupDays). A value it does not know, or one the view does not read, is a 400, as an unknown view is.
 */
const WAIT_REASONS=['no_price','return_cost','wage_waits_cost','investor_waits','refund_unknown','other'] as const;
const EXPORT_READS:Record<string,readonly string[]>={lines:[],orders:['part','q','state','kind','scope','cash'],products:['q'],sections:['q'],days:['by'],expenses:[]};
type ExportFilter={part:string;q:string;state:string;kind:string;scope:string;cash:string;by:string};
function exportFilter(get:(key:string)=>string|undefined,view:string):ExportFilter{
  const f:ExportFilter={part:get('part')||'',q:(get('q')||'').trim().slice(0,100),state:get('state')||'',kind:get('kind')||'',scope:(get('scope')||'').slice(0,300),cash:get('cash')||'',by:get('by')||''};
  if(!['','calculated','waiting','period'].includes(f.part)||(f.part&&!EXPORT_READS[view].includes('part')))throw badRequest('جزء الطلبات غير معروف / Unknown order part','EXPORT_PART_INVALID');
  const known=(f.state===''||['confirmed','estimated','waiting',...WAIT_REASONS.map((r)=>`reason:${r}`)].includes(f.state))&&['','normal','quick_buy','gift'].includes(f.kind)
    &&(f.scope===''||/^(?:(?:product|main|sub):.+|days:\d{4}-\d{2}-\d{2}:\d{4}-\d{2}-\d{2})$/.test(f.scope))&&['','due','open'].includes(f.cash)&&['','day','week','month'].includes(f.by);
  if(!known||(['q','state','kind','scope','cash','by'] as const).some((k)=>f[k]&&!EXPORT_READS[view].includes(k)))throw badRequest('فلتر التصدير غير معروف / Unknown export filter','EXPORT_FILTER_INVALID');
  return f;
}
/** The orders a page was opened on (reportTable.ts scopeIds): a product's or a section's own, the order-level row's, or those delivered on those days. */
function scopeOrders(scope:string,answer:{products:Row[];categories:Row[];order_level:{order_ids:string[]}|null},days:ReadonlyMap<string,string>):Set<string>|null{
  if(!scope)return null;
  const [kind,...rest]=scope.split(':');
  if(kind==='days'){const [from,to]=rest;return new Set([...days].filter(([,d])=>d>=from&&d<=to).map(([id])=>id));}
  const id=rest.join(':');
  if(id==='order_level')return new Set(answer.order_level?.order_ids??[]);
  const rows=kind==='product'?answer.products:answer.categories.filter((c)=>c.level===kind);
  return new Set((rows.find((r)=>r.id===id)?.order_ids as string[]|undefined)??[]);
}
/** Reports → Days by week (from Saturday, the old report's bucketKeyOf) or by month, as reportTable.ts groupDays sums them: an amount unknown on one of its days is unknown. */
const weekOf=(day:string)=>{const t=Date.parse(`${day}T00:00:00Z`),dow=new Date(t).getUTCDay();return new Date(t-((dow+1)%7)*86400000).toISOString().slice(0,10);};
function dayBuckets(daily:Row[],by:'week'|'month'):Row[]{
  const out=new Map<string,Row>(),plus=(a:unknown,b:unknown)=>(a===null||b===null?null:n(a)+n(b));
  for(const d of daily){const day=s(d.day),key=by==='month'?day.slice(0,7):weekOf(day),row=out.get(key);
    if(!row){out.set(key,{...d,from:day,to:day});continue;}
    out.set(key,{from:row.from,to:day,orders_count:n(row.orders_count)+n(d.orders_count),revenue_iqd:n(row.revenue_iqd)+n(d.revenue_iqd),cost_iqd:plus(row.cost_iqd,d.cost_iqd),
      investor_iqd:plus(row.investor_iqd,d.investor_iqd),deductions_iqd:n(row.deductions_iqd)+n(d.deductions_iqd),
      net_after_report_adjustments_iqd:plus(row.net_after_report_adjustments_iqd,d.net_after_report_adjustments_iqd),owner_net_iqd:plus(row.owner_net_iqd,d.owner_net_iqd),
      unknown_lines:n(row.unknown_lines)+n(d.unknown_lines),pending_costs:n(row.pending_costs)+n(d.pending_costs),
      estimated_orders:n(row.estimated_orders)+n(d.estimated_orders),unknown_refund_orders:n(row.unknown_refund_orders)+n(d.unknown_refund_orders)});}
  return [...out.values()];
}
/**
 * THE BOOKS' OWN CHECKS (the owner's brief, 2026-11-12, part 4; worker/lib/financeChecks.ts): each finds what should not
 * be, with its count, its money where it is money, and its first ids. Read on demand by the accounting page; the daily
 * alert runs the same set.
 */
adminFinanceWorkspaceRoutes.get('/accounting-checks',async(c)=>c.json({success:true,...await runFinanceChecks(c.env.DB)}));
adminFinanceWorkspaceRoutes.get('/export.csv',async(c)=>{
  const view=c.req.query('view')||'lines',level=c.req.query('level')||'main';
  if(!(EXPORT_VIEWS as readonly string[]).includes(view))throw badRequest('عرض التصدير غير معروف / Unknown export view','EXPORT_VIEW_INVALID');
  if(!['main','sub'].includes(level))throw badRequest('مستوى الأقسام غير معروف / Unknown section level','EXPORT_LEVEL_INVALID');
  const filter=exportFilter((key)=>c.req.query(key),view);
  if(view==='expenses')return exportExpenses(c.env.DB,range(c.req.query('from'),c.req.query('to')));
  if(view!=='lines')return exportView(c.env.DB,range(c.req.query('from'),c.req.query('to')),view as Exclude<(typeof EXPORT_VIEWS)[number],'lines'|'expenses'>,level as 'main'|'sub',filter);
  const r=range(c.req.query('from'),c.req.query('to')),{bases,truncated}=await selectOrders(c.env.DB,r,{summary:true});if(truncated)throw badRequest('اختر فترة أضيق لتصدير جميع البنود');
  const fields=['order_id','id','product_id','name_snapshot','sku_snapshot','qty','returned_qty','main_name','sub_name','net_goods_iqd','refund_iqd','cogs_iqd','cost_confidence','gross_profit_iqd','wages_iqd','materials_iqd','manual_direct_iqd','shipping_income_iqd','cod_tax_iqd','courier_fee_iqd','payment_fee_iqd','promotion_iqd','investor_iqd','owner_net_iqd','pending_costs','coupon_iqd','price_protection_iqd','trade_in_credit_returned_iqd','net_after_report_adjustments_iqd','row_kind'];
  const rows=[fields.map(csvCell).join(','),...bases.flatMap((b)=>{const rest=orderLevelDeductions(b);
    return [...b.lines.map((l):Row=>({...l,row_kind:'line'})),...(rest?[rest]:[])].map((l)=>fields.map((f)=>csvCell(f==='order_id'?b.order_id:l[f])).join(','));})];
  return new Response('\uFEFF'+rows.join('\r\n'),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="finance-lines-${r.from}-${r.to}.csv"`}});
});
/**
 * `view=expenses` (redesign step 5, DECISIONS row 317): Costs → General expenses as a file — every live entry of the period with
 * where it counts (`kind`), `counts_as_general` 1 for the entries the statement's «المصاريف العامة» sums (so a spreadsheet's sum of
 * those rows is that line), its category in three languages, its cost-centre tag and the order or the promotion's month it counts
 * with. From the same statement as the page (financeExpenseKinds.ts); a period of more than 20,000 entries is refused, never cut.
 */
const EXPENSE_COLUMNS=['expense_day','kind','counts_as_general','category_name_ar','category_name_en','category_name_ckb','title','amount_iqd','center_name','order_id','promotion_month','expense_id'] as const;
async function exportExpenses(db:D1Database,r:{from:string;to:string}){
  const rows=(await db.prepare(EXPENSE_ROWS_SQL).bind(r.from,r.to,0,20001).all<Row>()).results??[];
  if(rows.length>20000)throw badRequest('اختر فترة أضيق لتصدير جميع المصاريف');
  return csvFile(rows.map((e)=>({...e,kind:s(e.expense_kind),counts_as_general:isGeneralKind(s(e.expense_kind))?1:0,amount_iqd:n(e.amount_iqd),expense_id:s(e.id)})),EXPENSE_COLUMNS,`finance-expenses-${r.from}-${r.to}.csv`);
}
async function exportView(db:D1Database,r:{from:string;to:string},view:'orders'|'products'|'sections'|'days',level:'main'|'sub',f:ExportFilter){
  const {answer,bases,truncated}=await periodFigures(db,r);if(truncated)throw badRequest('اختر فترة أضيق لتصدير جميع البنود');
  const filtered=!!(f.q||f.state||f.kind||f.scope||f.cash);
  const file=(rows:Row[],fields:readonly string[])=>csvFile(rows,fields,`finance-${view}${view==='sections'?`-${level}`:''}${f.part?`-${f.part}`:''}${f.by&&f.by!=='day'?`-${f.by}`:''}${filtered?'-filtered':''}-${r.from}-${r.to}.csv`);
  // A cost that waits for the goods cost (a profit-based wage) is in no sum yet, so a row with one has no known wages or
  // materials — the statement's rule (statement.ts) and the tables' — never the part that happens to be approved.
  const settled=(row:Row):Row=>(n(row.pending_costs)>0?{...row,wages_iqd:null,materials_iqd:null}:row);
  // A row's estimates are named beside its known cost, as the page names them: beside an empty cost the count is empty too (the
  // third review of step 4), so the column adds up to the costs total's «تقديري n» — and, over the rows with a net, to the net's.
  const besideCost=(rows:Row[])=>rows.map((row)=>(row.cost_iqd===null?{...row,estimated_orders:null}:row));
  if(view==='days'){const daily=answer.chart_data.daily as Row[];return f.by==='week'||f.by==='month'?file(besideCost(dayBuckets(daily,f.by)),BUCKET_COLUMNS):file(besideCost(daily),DAY_COLUMNS);}
  // Products and sections: the rows whose name holds the search (any language the server has), then — on the whole table only,
  // as the screen draws it — the order-level row, so the file adds up to the orders.
  const needle=f.q.toLocaleLowerCase(),named=(x:Row)=>!needle||[x.name,x.name_ar,x.name_en,x.name_ckb].some((v)=>typeof v==='string'&&v.toLocaleLowerCase().includes(needle));
  const level0=needle?null:answer.order_level;
  const orderLevelRow=(names:Row):Row=>({...Object.fromEntries(GROUP_COLUMNS.map((k)=>[k,0])),...names,coupon_iqd:level0!.coupon_iqd,price_protection_iqd:level0!.price_protection_iqd,
    trade_in_credit_returned_iqd:level0!.trade_in_credit_returned_iqd,net_after_report_adjustments_iqd:level0!.net_after_report_adjustments_iqd,finance_state:'',wait_reason:'',orders_count:level0!.orders_count,row_kind:'order_level'});
  if(view==='products'){const rows=(answer.products as Row[]).filter(named).map((p)=>settled({...p,product_id:p.id,row_kind:'product'}));
    if(level0)rows.push(orderLevelRow({product_id:'order_level',name:ORDER_LEVEL_NAMES[0],main_id:'',main_name:''}));
    return file(rows,['product_id','name','main_id','main_name',...GROUP_COLUMNS]);}
  if(view==='sections'){const [ar,en,ckb]=UNCLASSIFIED[level];
    const rows=(answer.categories as Row[]).filter((x)=>x.level===level&&named(x)).map((x)=>settled({...x,section_id:x.id,row_kind:'section',...(x.id==='unclassified'?{name_ar:ar,name_en:en,name_ckb:ckb}:{})}));
    if(level0){const [lar,len,lckb]=ORDER_LEVEL_NAMES;rows.push(orderLevelRow({section_id:'order_level',name_ar:lar,name_en:len,name_ckb:lckb}));}
    return file(rows,['section_id','name_ar','name_en','name_ckb',...GROUP_COLUMNS]);}
  const days=new Map(bases.map((b)=>[b.order_id,deliveredDay(b)]));
  const scope=scopeOrders(f.scope,{products:answer.products as Row[],categories:answer.categories as Row[],order_level:answer.order_level},days),q=f.q.toLocaleLowerCase();
  const orders=(answer.orders as Row[]).filter((o)=>{
    const id=s(o.order_id),state=s(o.finance_state);
    if(f.part&&f.part!=='period'&&(f.part==='waiting')!==(state==='waiting'))return false;
    if(scope&&!scope.has(id))return false;
    if(q&&!`${id} ${s(o.customer_name)}`.toLocaleLowerCase().includes(q))return false;
    if(f.kind&&(s(o.order_kind)||'normal')!==f.kind)return false;
    if(f.state&&(f.state.startsWith('reason:')?state!=='waiting'||o.wait_reason!==f.state.slice(7):state!==f.state))return false;
    // The drawer's cash figures list the orders with cash due, or with some of it not recorded yet (drill.ts).
    if(f.cash==='due'&&n(o.collection_difference_iqd)+n(o.collected_iqd)===0)return false;
    if(f.cash==='open'&&n(o.collection_difference_iqd)===0)return false;
    return true;
  }).map((o):Row=>settled({...o,delivered_day:days.get(s(o.order_id))??'',general_expenses_iqd:0,
    // Named beside a known goods cost only, as the page names it (reportTable.ts costOnEstimate; the fourth review of step 4).
    estimated_cost:o.cogs_iqd==null?null:o.cost_confidence==='verified'?0:1,row_kind:'order'}));
  // The column's share of the overheads, as the statement and the drawer carry it: rent and the like, and a month's promotion with
  // no sales — the period's own for `part=period`. A file filtered by anything else is that page's rows, with no share.
  const totals=answer.totals as Row;
  const share=filtered||!f.part?null:f.part==='calculated'?answer.known:f.part==='waiting'?answer.waiting:{general_share_iqd:n(totals.general_expenses_iqd),unallocated_share_iqd:n(totals.unallocated_promotion_iqd)};
  const general=n(share?.general_share_iqd),unallocated=n(share?.unallocated_share_iqd);
  // They come off the calculated column's net, and the period's while every order of it is known; the waiting column has none.
  const net=f.part==='calculated'||(f.part==='period'&&orders.every((o)=>o.net_after_report_adjustments_iqd!=null))?-general-unallocated:null;
  if(share&&(general||unallocated))orders.push({...Object.fromEntries(ORDER_COLUMNS.map((k)=>[k,0])),order_id:'',delivered_day:'',customer_name:'',order_kind:'',finance_state:'',wait_reason:'',cash_state:'',
    promotion_iqd:unallocated,general_expenses_iqd:general,owner_net_iqd:net,net_after_report_adjustments_iqd:net,row_kind:'overhead'});
  return file(orders,ORDER_COLUMNS);
}
