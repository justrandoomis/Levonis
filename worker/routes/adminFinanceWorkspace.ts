import { participantReport } from '../lib/financeParticipantReports';
import { isConfirmedOrderCost } from '../lib/financeLedger';
import { Hono } from 'hono';
import type { AppContext } from '../lib/types';
import { badRequest, conflict, notFound, requireAdmin, str, unavailable } from '../lib/http';
import { canViewCost, isOwner } from '../lib/adminScope';
import { requireCostRead } from '../lib/costAccess';
import { limitByMethod } from '../lib/ratelimit';
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
import { baghdadDayStart, centsOf, chartCents, expenseCompositionCents, iqdToCents, instantOf, sumCents, type Cents } from '../lib/financeUsdDisplay';

type Row=Record<string,unknown>;
const n=(v:unknown)=>Number(v??0),s=(v:unknown)=>String(v??'');
const text=(v:unknown,max=200)=>str(v,'النص',{max,required:false})??'';
export const adminFinanceWorkspaceRoutes=new Hono<AppContext>();
adminFinanceWorkspaceRoutes.use('*',requireAdmin);
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
const sumFields=['net_goods_iqd','retained_revenue_iqd','cogs_iqd','gross_profit_iqd','shipping_income_iqd','cod_tax_iqd','direct_cost_iqd','wages_iqd','materials_iqd','manual_direct_iqd','courier_fee_iqd','payment_fee_iqd','contribution_profit_iqd','profit_basis_iqd','promotion_iqd','investor_iqd','owner_net_iqd','coupon_iqd','price_protection_iqd','net_after_report_adjustments_iqd','refunded_iqd','refund_iqd','collected_iqd','collection_difference_iqd','pending_costs','unknown_lines','units'];
function sumRows(rows:Row[]):Row {
  const totals:Row={};
  for(const key of sumFields)totals[key]=rows.some((r)=>r[key]===null)?null:rows.reduce((v,r)=>v+n(r[key]),0);
  return totals;
}
function orderRow(base:OrderProfitBase){return {...base.order,...base.totals,id:base.order_id,order_id:base.order_id,version:base.version,
  has_financial_activity:base.has_financial_activity,projected_finance:base.projected_finance,
  review_reasons:[...base.lines.flatMap(l=>l.cost_review?.issues??[]),...base.costs.flatMap(c=>Array.isArray(c.review_reasons)?c.review_reasons:[])],
  cost_confidence:base.lines.every((l)=>isConfirmedOrderCost(l.cost_confidence))?'verified':base.lines.some((l)=>l.cogs_iqd===null)?'unknown':'snapshot'};}
function grouped(lines:ProfitLine[],kind:'product'|'main'|'sub'){
  const groups=new Map<string,{name:string;lines:ProfitLine[]}>();
  for(const l of lines){const id=kind==='product'?l.product_id||l.id:kind==='main'?l.main_catalog_id:l.sub_catalog_id;
    if(kind==='sub'&&!id)continue;
    const key=id||'unclassified',name=kind==='product'?l.name_snapshot:kind==='main'?l.main_name:l.sub_name;
    const g=groups.get(key)??{name:name||'غير مصنف',lines:[]};g.lines.push(l);groups.set(key,g);}
  return [...groups].map(([id,g])=>({id,name:g.name,level:kind,qty:g.lines.reduce((v,l)=>v+l.qty,0),...sumRows(g.lines),orders_count:new Set(g.lines.map((l)=>l.order_id)).size}));
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
/** Charts use the same delivered-order bases and full-month promotion shares as the report. */
function chartAmounts(t:Row,general=0,unallocated=0,truncated=false){
  const revenue=n(t.retained_revenue_iqd)+n(t.shipping_income_iqd)+n(t.cod_tax_iqd);
  const cost=t.profit_basis_iqd===null||truncated?null:n(t.cogs_iqd)+n(t.direct_cost_iqd)+n(t.manual_direct_iqd)+n(t.courier_fee_iqd)+n(t.payment_fee_iqd)+n(t.promotion_iqd)+general+unallocated;
  return {revenue_iqd:revenue,cost_iqd:cost,owner_net_iqd:t.owner_net_iqd===null||truncated?null:n(t.owner_net_iqd)-general-unallocated,
    investor_iqd:t.investor_iqd===null||truncated?null:n(t.investor_iqd),orders_count:n(t.orders_count),unknown_lines:n(t.unknown_lines),pending_costs:n(t.pending_costs)};
}
/** The Baghdad day an order was delivered on — the chart's bucket. */
function deliveredDay(b:OrderProfitBase){const at=s(b.order.delivered_at).replace(' ','T'),stamp=Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(at)?at:`${at}Z`);
  return new Date(stamp+3*3600000).toISOString().slice(0,10);}
function summaryCharts(bases:OrderProfitBase[],r:{from:string;to:string},expenses:Row[],unallocated:Map<string,number>,totals:Row,truncated:boolean){
  const groups=new Map<string,Row[]>(),generalByDay=new Map(expenses.map((e)=>[s(e.expense_day),n(e.total)]));
  for(const b of bases){const day=deliveredDay(b),rows=groups.get(day)??[];rows.push(b.totals);groups.set(day,rows);}
  const daily=[];
  for(let stamp=Date.parse(r.from);stamp<=Date.parse(r.to);stamp+=86400000){const day=new Date(stamp).toISOString().slice(0,10),rows=groups.get(day)??[],t=sumRows(rows);t.orders_count=rows.length;
    const general=generalByDay.get(day)??0;
    daily.push({day,...chartAmounts(t,general,unallocated.get(day)??0,truncated)});}
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
 * amounts, as DEDUCTIONS IN THIS REPORT ONLY (owner question Q3, default
 * "report only"; worker/lib/financeReportOverlay.ts). Applied to the bases
 * this route already built, after the investor split, so `calculateGoods`,
 * `getOrderProfitBase(s)` and every writer that settles investors, wages and
 * journals never see them. A line takes its share of `min(coupon, net goods)`
 * by net goods plus its own claims; the excess of a coupon above the goods
 * (it cut shipping, then the COD fee) stays at the order level, so the
 * products never carry more than their goods.
 */
function applyReportAdjustments(bases:OrderProfitBase[],adjustments:Map<string,ReportAdjustments>){
  for(const b of bases){
    const a=adjustments.get(b.order_id);const coupon=a?.coupon_iqd??0,claims=a?.price_protection_by_line??new Map<string,number>();
    const goods=b.lines.map((l)=>Math.max(0,n(l.net_goods_iqd))),toLines=Math.min(coupon,goods.reduce((v,x)=>v+x,0));
    const shares=spread(toLines,goods);
    b.lines.forEach((l,i)=>{const share=shares[i]??0,credit=claims.get(l.id)??0;
      l.coupon_iqd=share;l.price_protection_iqd=credit;
      l.net_after_report_adjustments_iqd=l.owner_net_iqd===null||l.owner_net_iqd===undefined?null:n(l.owner_net_iqd)-share-credit;});
    const credited=a?.price_protection_iqd??0;
    b.totals.coupon_iqd=coupon;b.totals.price_protection_iqd=credited;
    b.totals.net_after_report_adjustments_iqd=b.totals.owner_net_iqd===null||b.totals.owner_net_iqd===undefined?null:n(b.totals.owner_net_iqd)-coupon-credited;
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
    db.prepare('SELECT DISTINCT a.order_id,a.order_item_id FROM order_item_inventory_allocations a JOIN inventory_lots l ON l.id=a.lot_id JOIN investment_contracts c ON c.incoming_id=l.incoming_id WHERE a.order_id IN (SELECT value FROM json_each(?)) AND a.released_at IS NULL').bind(ids).all<Row>(),
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
interface OrderUsd{usd_basis:'at_time'|'today';fx_rate_snapshot:string;cents:Cents;lines:Map<string,Cents>}
/** Each order and each of its lines in cents, at the order's own creation-time rate. Null when no rate exists at all. */
function ordersInUsd(bases:OrderProfitBase[],steps:UsdRateSteps|null){
  const out=new Map<string,OrderUsd>();
  for(const b of bases){const hit=usdRateAt(steps,instantOf(b.order.created_at));if(!hit)return null;
    out.set(b.order_id,{usd_basis:hit.basis,fx_rate_snapshot:hit.rate,cents:centsOf(b.totals,hit.rate),lines:new Map(b.lines.map((l)=>[l.id,centsOf(l,hit.rate)]))});}
  return out;
}
const basisCounts=(orders:Map<string,OrderUsd>)=>{const today=[...orders.values()].filter((o)=>o.usd_basis==='today').length;return {at_time_count:orders.size-today,today_count:today};};
const orderBlock=(orders:Map<string,OrderUsd>)=>Object.fromEntries([...orders].map(([id,o])=>[id,{usd_basis:o.usd_basis,fx_rate_snapshot:o.fx_rate_snapshot,cents:o.cents}]));
function groupedCents(lines:ProfitLine[],kind:'product'|'main'|'sub',orders:Map<string,OrderUsd>){
  const groups=new Map<string,Cents[]>();
  for(const l of lines){const id=kind==='product'?l.product_id||l.id:kind==='main'?l.main_catalog_id:l.sub_catalog_id;
    if(kind==='sub'&&!id)continue;
    const key=id||'unclassified',rows=groups.get(key)??[];rows.push(orders.get(s(l.order_id))?.lines.get(l.id)??{});groups.set(key,rows);}
  return Object.fromEntries([...groups].map(([id,rows])=>[id,sumCents(rows)]));
}
async function summaryInUsd(db:D1Database,bases:OrderProfitBase[],r:{from:string;to:string},expenses:Row[],unallocatedDays:Map<string,number>,truncated:boolean,pendingCosts:boolean){
  const expenseStarts=expenses.map((e)=>baghdadDayStart(s(e.expense_day))),monthStarts=[...unallocatedDays.keys()].map((d)=>baghdadDayStart(d));
  const steps=await usdSteps(db,[...bases.map((b)=>instantOf(b.order.created_at)),...expenseStarts,...monthStarts]);
  const orders=ordersInUsd(bases,steps);if(!orders||(!steps?.today&&!steps?.steps.length))return unavailableUsd();
  let approximate=[...orders.values()].some((o)=>o.usd_basis==='today');
  const atDay=(day:string,iqd:number)=>{const hit=usdRateAt(steps,baghdadDayStart(day));if(!hit)return null;if(hit.basis==='today')approximate=true;return iqdToCents(iqd,hit.rate);};
  const generalByDay=new Map<string,number>();for(const e of expenses){const c=atDay(s(e.expense_day),n(e.total));if(c===null)return unavailableUsd();generalByDay.set(s(e.expense_day),c);}
  const unallocatedByDay=new Map<string,number>();for(const [day,amount] of unallocatedDays){const c=atDay(day,amount);if(c===null)return unavailableUsd();unallocatedByDay.set(day,c);}
  const general=[...generalByDay.values()].reduce((v,x)=>v+x,0),unallocated=[...unallocatedByDay.values()].reduce((v,x)=>v+x,0);
  const totals=sumCents([...orders.values()].map((o)=>o.cents));
  const ownerNet=totals.owner_net_cents??null;
  const periodNet=ownerNet===null||truncated?null:ownerNet-general-unallocated;
  Object.assign(totals,{general_expenses_cents:general,unallocated_promotion_cents:unallocated,owner_period_net_cents:periodNet,
    owner_period_net_after_report_adjustments_cents:periodNet===null?null:periodNet-(totals.coupon_cents??0)-(totals.price_protection_cents??0)});
  const byDay=new Map<string,Cents[]>();for(const b of bases){const day=deliveredDay(b),rows=byDay.get(day)??[];rows.push(orders.get(b.order_id)!.cents);byDay.set(day,rows);}
  const daily:Record<string,ReturnType<typeof chartCents>>={};
  for(let stamp=Date.parse(r.from);stamp<=Date.parse(r.to);stamp+=86400000){const day=new Date(stamp).toISOString().slice(0,10);
    daily[day]=chartCents(sumCents(byDay.get(day)??[]),generalByDay.get(day)??0,unallocatedByDay.get(day)??0,truncated);}
  const kinds=Object.fromEntries(ORDER_KINDS.map((kind)=>[kind,sumCents(bases.filter((b)=>(ORDER_KINDS as readonly string[]).includes(s(b.order.order_kind))?b.order.order_kind===kind:kind==='normal').map((b)=>orders.get(b.order_id)!.cents))]));
  const lines=bases.flatMap((b)=>b.lines.map((l)=>({...l,order_id:b.order_id})));
  return {available:true as const,today_rate:steps?.today??null,...basisCounts(orders),approximate,
    orders:orderBlock(orders),kinds,products:groupedCents(lines,'product',orders),
    categories:{main:groupedCents(lines,'main',orders),sub:groupedCents(lines,'sub',orders)},
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
adminFinanceWorkspaceRoutes.get('/summary',async(c)=>{
  const db=c.env.DB,r=range(c.req.query('from'),c.req.query('to')),display=displayOf(c.req.query('display'));
  const {bases,truncated}=await selectOrders(db,r,{summary:true});
  const [expenses,failures,promotions]=await Promise.all([
    db.prepare(`SELECT e.expense_day,COALESCE(SUM(e.amount_iqd),0) total FROM operating_expenses e WHERE e.voided_at IS NULL AND e.expense_day BETWEEN ? AND ?
      AND NOT EXISTS(SELECT 1 FROM finance_expense_links l WHERE l.expense_id=e.id AND l.order_id IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM finance_order_costs c WHERE c.expense_id=e.id)
      AND NOT EXISTS(SELECT 1 FROM finance_collections c WHERE c.expense_id=e.id)
      AND NOT EXISTS(SELECT 1 FROM finance_monthly_promotions p WHERE p.expense_id=e.id) GROUP BY e.expense_day`).bind(r.from,r.to).all<Row>(),
    db.prepare('SELECT event_key id,order_id,message,last_attempt_at FROM finance_posting_errors WHERE order_id IN (SELECT value FROM json_each(?)) ORDER BY last_attempt_at DESC LIMIT 100').bind(JSON.stringify(bases.map((b)=>b.order_id))).all<Row>(),
    db.prepare("SELECT *,CASE WHEN currency='IQD' THEN amount_minor ELSE amount_minor/100.0 END amount FROM finance_monthly_promotions WHERE month BETWEEN ? AND ? ORDER BY month,id").bind(r.from.slice(0,7),r.to.slice(0,7)).all<Row>()]);
  const expenseDays=expenses.results??[],totals=sumRows(bases.map((b)=>b.totals));totals.orders_count=bases.length;totals.general_expenses_iqd=expenseDays.reduce((v,e)=>v+n(e.total),0);
  let unallocated=0;const unallocatedDays=new Map<string,number>();
  for(const month of new Set((promotions.results??[]).map((p)=>s(p.month))))if(`${month}-01`>=r.from&&`${month}-01`<=r.to){const amount=(await monthlyPromotionShares(db,month)).unallocated_iqd;unallocated+=amount;unallocatedDays.set(`${month}-01`,amount);}
  totals.unallocated_promotion_iqd=unallocated;
  totals.owner_period_net_iqd=totals.owner_net_iqd===null||truncated?null:n(totals.owner_net_iqd)-n(totals.general_expenses_iqd)-unallocated;
  // F4/F5 at the period level: «الصافي بعد خصومات التقرير» beside «صافي المالك».
  totals.owner_period_net_after_report_adjustments_iqd=totals.owner_period_net_iqd===null?null:n(totals.owner_period_net_iqd)-n(totals.coupon_iqd)-n(totals.price_protection_iqd);
  if(truncated)totals.owner_net_iqd=null;
  const exceptions:Row[]=[...(failures.results??[]).map((e)=>({...e,type:'posting_failed'}))];
  for(const b of bases)for(const warning of b.warnings)exceptions.push({id:`${b.order_id}:${warning}`,order_id:b.order_id,type:warning.split(':')[0],message:warning.startsWith('cost:')?'تكلفة البضاعة تحتاج تثبيت FIFO أو تحققًا ماليًا خاصًا':warning==='investor:pending'?'توزيع المستثمر ينتظر التسوية':'يوجد بند مالي يحتاج مراجعة'});
  for(const b of bases)if(n(b.totals.pending_costs)>0)exceptions.push({id:`${b.order_id}:pending_cost`,order_id:b.order_id,type:'pending_cost',message:'الأجور أو المواد تنتظر تثبيت التكلفة'});
  const lines=bases.flatMap((b)=>b.lines);
  const answer={success:true,range:r,totals,orders:bases.map(orderRow),kinds:byKind(bases),products:grouped(lines,'product'),categories:[...grouped(lines,'main'),...grouped(lines,'sub')],chart_data:summaryCharts(bases,r,expenseDays,unallocatedDays,totals,truncated),exceptions:exceptions.slice(0,200),promotions:promotions.results??[],general_expenses_iqd:totals.general_expenses_iqd,truncated,allocation_basis:'sold_units'};
  if(display==='IQD')return c.json(answer);
  return c.json({...answer,display_usd:await summaryInUsd(db,bases,r,expenseDays,unallocatedDays,truncated,n(totals.pending_costs)>0)});
});
adminFinanceWorkspaceRoutes.get('/orders',async(c)=>{
  const r=range(c.req.query('from'),c.req.query('to')),offset=whole(c.req.query('offset')??0,'الصفحة',0,100000);
  const kind=text(c.req.query('kind'),20);if(kind&&!['normal','quick_buy','gift'].includes(kind))throw badRequest('نوع الطلب غير معروف');
  const display=displayOf(c.req.query('display'));
  const result=await selectOrders(c.env.DB,r,{offset,q:text(c.req.query('q'),100),kind});
  const answer={success:true,orders:result.bases.map(orderRow),total:result.total,offset,range:r};
  if(display==='IQD')return c.json(answer);
  const steps=await usdSteps(c.env.DB,result.bases.map((b)=>instantOf(b.order.created_at)));
  const orders=ordersInUsd(result.bases,steps);
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
  const order=ordersInUsd([answer],steps)?.get(answer.order_id);
  return c.json({...answer,display_usd:!order?unavailableUsd():{available:true,today_rate:steps?.today??null,usd_basis:order.usd_basis,fx_rate_snapshot:order.fx_rate_snapshot,cents:order.cents,lines:Object.fromEntries(order.lines)}});
});
adminFinanceWorkspaceRoutes.post('/orders/:id/adjustments',async(c)=>{
  const db=c.env.DB,actor=c.get('user')!,id=c.req.param('id');await requireCapability(c.env,actor,'accounting');
  const body=await c.req.json<Row>(),field=text(body.field,40) as ProfitField,value=whole(body.value_iqd,'القيمة الجديدة'),lineId=text(body.line_id,100)||null;
  if(!profitFields.includes(field))throw badRequest('الحقل المالي غير صحيح');
  const operationId=body.operation_id===undefined?newId('profitop'):str(body.operation_id,'رقم العملية',{min:8,max:100});
  const old=await db.prepare('SELECT * FROM finance_order_adjustments WHERE operation_id=?').bind(operationId).first<ProfitAdjustment&{actor_id:string}>();
  if(old){if(old.order_id!==id||old.field!==field||old.order_item_id!==lineId||old.new_value_iqd!==value||old.actor_id!==actor.id)throw conflict('رقم العملية مستخدم لتعديل آخر');const pending=await reconcileWorkspace(db,id,actor.id,baghdadDay());return c.json({success:true,already:true,reconciliation_pending:pending,...await detail(db,id)});}
  const source=await profitSourceFingerprint(db,id);
  const [current,plain]=await Promise.all([getOrderProfitBase(db,id),getOrderProfitBases(db,[id],{skipAdjustments:true})]);
  if(current.order.seller_type!=='levonis')throw notFound('Order not found');
  if(['cancelled','returned'].includes(s(current.order.status)))throw conflict('لا يمكن تعديل طلب ملغى');
  const expected=body.version===undefined?current.version:whole(body.version,'نسخة الحساب');
  if(expected!==current.version)throw conflict('تغيرت نسخة الحساب؛ حدّث الطلب');
  const plan=planProfitAdjustment(current,lineId,field,value),next=current.version+1,now=new Date().toISOString(),day=baghdadDay();await periodOpen(db,day);
  const before=JSON.stringify(current),after=JSON.parse(before) as OrderProfitBase;
  const revision:ProfitAdjustment={order_id:id,order_item_id:lineId,field,version:next,old_value_iqd:plan.previous,new_value_iqd:value,allocations_json:JSON.stringify(plan.allocations)};
  applyProfitAdjustment(after,revision);
  const posting=await planWorkspaceAccounting(db,plain[0],after,{actor:actor.id,day});
  const adjustmentId=newId('profitfix');
  try{await db.batch([
    ...fence(db,`(${source.sql.replace(/\?1/g,'?2')})=? AND COALESCE((SELECT version FROM finance_order_versions WHERE order_id=?),0)=?`,[id,source.value,id,expected]),
    db.prepare('INSERT INTO finance_order_versions(order_id,version) VALUES (?,?) ON CONFLICT(order_id) DO UPDATE SET version=excluded.version').bind(id,next),
    ...posting.statements,
    db.prepare('INSERT INTO finance_order_adjustments(id,operation_id,order_id,order_item_id,field,old_value_iqd,new_value_iqd,delta_iqd,version,actor_id,created_at,journal_id,allocations_json,before_json,after_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(adjustmentId,operationId,id,lineId,field,plan.previous,value,plan.delta,next,actor.id,now,posting.journalIds[0]??null,revision.allocations_json,before,JSON.stringify(after)),
    db.prepare('INSERT INTO finance_order_calculations(order_id,version,snapshot,actor_id,created_at) VALUES (?,?,?,?,?)').bind(id,next,JSON.stringify(after),actor.id,now),
    ...(await auditStatements(db,actor.id,'finance.order_adjusted',id,{field,line_id:lineId,before:plan.previous,after:value,version:next,operation_id:operationId})).statements]);}
  catch(e){if(/CHECK constraint|UNIQUE constraint/.test(String(e)))throw conflict('تغير الطلب أثناء الحفظ؛ حدّث الحساب وأعد المحاولة');throw e;}
  const reconciliationPending=await reconcileWorkspace(db,id,actor.id,day);
  return c.json({success:true,reconciliation_pending:reconciliationPending,accounting_pending:posting.pending,...await detail(db,id)});
});
adminFinanceWorkspaceRoutes.get('/promotions',async(c)=>{
  const month=text(c.req.query('month'),7)||baghdadDay().slice(0,7),allocation=await monthlyPromotionShares(c.env.DB,month);
  // P-A F3: a SUGGESTION for the rate field — the shop's USD/IQD in force on the
  // month's first day (worker/lib/fx/historyRate), never the wallet's. The page
  // shows it and fills the field only when the owner taps it; the server never
  // books a promotion at it unless that rate is sent as the rate actually paid.
  const start=baghdadDayStart(`${month}-01`),steps=start===null?null:await usdSteps(c.env.DB,[start]),hit=usdRateAt(steps,start);
  const rate_suggestion=hit?{rate:hit.rate,date:`${month}-01`,usd_basis:hit.basis}:null;
  return c.json({success:true,month,promotions:allocation.promotions,total_iqd:allocation.total_iqd,unallocated_iqd:allocation.unallocated_iqd,allocation_basis:'sold_units',rate_suggestion});
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
const csvCell=(v:unknown)=>`"${s(v).replace(/^[=+\-@\t\r]/,"'$&").replace(/"/g,'""')}"`;
adminFinanceWorkspaceRoutes.get('/export.csv',async(c)=>{
  const r=range(c.req.query('from'),c.req.query('to')),{bases,truncated}=await selectOrders(c.env.DB,r,{summary:true});if(truncated)throw badRequest('اختر فترة أضيق لتصدير جميع البنود');
  const fields=['order_id','id','product_id','name_snapshot','sku_snapshot','qty','returned_qty','main_name','sub_name','net_goods_iqd','refund_iqd','cogs_iqd','cost_confidence','gross_profit_iqd','wages_iqd','materials_iqd','manual_direct_iqd','shipping_income_iqd','cod_tax_iqd','courier_fee_iqd','payment_fee_iqd','promotion_iqd','investor_iqd','owner_net_iqd'];
  const rows=[fields.map(csvCell).join(','),...bases.flatMap((b)=>b.lines.map((l)=>fields.map((f)=>csvCell(f==='order_id'?b.order_id:l[f])).join(',')))];
  return new Response('\uFEFF'+rows.join('\r\n'),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="finance-lines-${r.from}-${r.to}.csv"`}});
});
