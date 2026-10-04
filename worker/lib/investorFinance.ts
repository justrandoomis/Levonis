import { newId } from './crypto';
import { badRequest, conflict, notFound } from './http';
import { allocateExact, baghdadDay, fence, journalPlan, periodOpen } from './operations';
import { getOrderProfitBase } from './orderProfit';
import { employmentInstalled, investorEmploymentPendingSql } from './financeEmployment';

export type InvestmentContract = {
  id: string; incoming_id: string; user_id: string; name: string; principal_iqd: number;
  capital_share_bps: number; profit_share_bps: number; loss_share_bps: number; version: number;
};
type Allocation = { id: string; lot_id: string; qty: number; cogs_iqd: number | null; unit_cost_iqd: number | null; returned_qty: number; returned_cogs_iqd: number; late_cost_iqd?: number };
type ProfitView = {
  order: Record<string, unknown>; version: string | number;
  lines: Array<{ id: string; qty: number; returned_qty: number; retained_revenue_iqd: number; cogs_iqd: number | null; profit_basis_iqd: number | null; cost_confidence: string; allocations: Allocation[] }>;
};
export async function investorFinanceInstalled(db: D1Database) {
  return !!await db.prepare("SELECT 1 FROM sqlite_master WHERE name='investment_contracts'").first();
}
export const signedShares = (amount: number, weights: number[]) => allocateExact(Math.abs(amount), weights).map(v => amount < 0 ? -v : v);
const percent = (amount: number, bps: number) => Number(BigInt(amount)*BigInt(bps)/10000n);
const lossRawSql=`COALESCE((SELECT SUM(loss_iqd) FROM investor_allocation_results WHERE contract_id=?2),0)+COALESCE((SELECT SUM(amount_iqd) FROM investor_finance_events WHERE contract_id=?2 AND allocation_id IS NULL AND kind IN ('loss','loss_correction')),0)`;
/** Raw per-piece losses retain their evidence; the capital account absorbs at
 * most actual funded capital. One contract fence covers concurrent orders. */
export async function planInvestorCapitalLoss(db:D1Database,contract:InvestmentContract,rawDelta:number,day:string,actor?:string){
  const old=await db.prepare('SELECT * FROM investor_capital_losses WHERE contract_id=?').bind(contract.id).first<{amount_iqd:number;version:number}>();
  const totals=await db.prepare(`SELECT COALESCE((SELECT SUM(loss_iqd) FROM investor_allocation_results WHERE contract_id=?1),0)+COALESCE((SELECT SUM(amount_iqd) FROM investor_finance_events WHERE contract_id=?1 AND allocation_id IS NULL AND kind IN ('loss','loss_correction')),0) AS raw,COALESCE((SELECT SUM(amount_iqd) FROM investor_finance_events WHERE contract_id=?1 AND kind='funding'),0) AS funded`).bind(contract.id).first<{raw:number;funded:number}>();
  const target=Math.max(0,Math.min(totals!.funded,totals!.raw+rawDelta)),delta=target-(old?.amount_iqd??0),version=(old?.version??0)+1;
  if(!rawDelta&&!delta&&old)return{guards:[] as D1PreparedStatement[],post:[] as D1PreparedStatement[]};
  const guards=[...fence(db,`(${lossRawSql})=?3 AND COALESCE((SELECT SUM(amount_iqd) FROM investor_finance_events WHERE contract_id=?2 AND kind='funding'),0)=?4 AND COALESCE((SELECT version FROM investor_capital_losses WHERE contract_id=?2),0)=?5`,[contract.id,totals!.raw,totals!.funded,old?.version??0])];
  const post:D1PreparedStatement[]=[];
  if(delta)post.push(...journalPlan(db,{key:`investor-capital-loss:${contract.id}:${version}`,day,title:'حصة خسارة المستثمر ضمن رأس المال الممول',source:'investor',sourceId:contract.id,actor},delta>0?[{account:'3100',debit:delta},{account:'3200',credit:delta}]:[{account:'3200',debit:-delta},{account:'3100',credit:-delta}]).statements);
  post.push(db.prepare('INSERT INTO investor_capital_losses(contract_id,amount_iqd,version) VALUES (?,?,?) ON CONFLICT(contract_id) DO UPDATE SET amount_iqd=excluded.amount_iqd,version=excluded.version').bind(contract.id,target,version));
  return{guards,post};
}
const fingerprintSql = `json_array(
 (SELECT json_array(status,price_adjustment_iqd,due_on_delivery_iqd,gini_paid_iqd,shipping_iqd,cod_tax_iqd) FROM orders WHERE id=?1),
 (SELECT COALESCE(MAX(version),0) FROM finance_order_adjustments WHERE order_id=?1),
 (SELECT json_group_array(json_array(id,amount_iqd,state)) FROM (SELECT * FROM finance_order_costs WHERE order_id=?1 ORDER BY id)),
 (SELECT json_group_array(json_array(a.id,a.delta_iqd)) FROM finance_cost_adjustments a JOIN finance_order_costs c ON c.id=a.cost_id WHERE c.order_id=?1),
 (SELECT json_group_array(json_array(e.id,e.amount_iqd,e.voided_at)) FROM finance_expense_links l JOIN operating_expenses e ON e.id=l.expense_id WHERE l.order_id=?1),
 (SELECT json_group_array(json_array(id,qty,line_total_iqd,cost_iqd,component_alloc_iqd,coupon_discount_iqd,membership_discount_iqd)) FROM (SELECT * FROM order_items WHERE order_id=?1 ORDER BY id)),
 (SELECT json_group_array(json_array(case_id,refund_iqd,qty,disposition,cogs_iqd)) FROM (SELECT * FROM finance_refund_facts WHERE order_id=?1 ORDER BY case_id)),
 (SELECT json_group_array(json_array(id,qty,cogs_iqd,released_at)) FROM (SELECT * FROM order_item_inventory_allocations WHERE order_id=?1 ORDER BY id)),
 (SELECT json_group_array(json_array(id,amount_iqd,fee_iqd)) FROM (SELECT * FROM finance_collections WHERE order_id=?1 ORDER BY id)),
 (SELECT json_group_array(json_array(e.event_key,e.state)) FROM accounting_entries e WHERE e.event_key IN ('sale:'||?1,'cogs:'||?1)),
 (SELECT json_group_array(json_array(id,field,delta_iqd)) FROM finance_workspace_postings WHERE order_id=?1),
 (SELECT json_group_array(json_array(s.adjustment_id,s.allocation_id,s.unit_delta_iqd)) FROM lot_cost_adjustment_shares s JOIN order_item_inventory_allocations a ON a.id=s.allocation_id WHERE a.order_id=?1),
 (SELECT json_group_array(json_array(e.return_case_id,e.allocation_id,e.qty,r.state)) FROM stock_return_lot_evidence e JOIN return_cases r ON r.id=e.return_case_id WHERE r.order_id=?1))`;
async function fingerprint(db: D1Database, orderId: string) { return (await db.prepare(`SELECT ${fingerprintSql} AS value`).bind(orderId).first<{ value: string }>())!.value; }
/** Trusted SQL expressions only. Used inside payout's own transaction fence. */
export function investorProjectionStaleSql(contractExpr='e.contract_id'){
  return `EXISTS(SELECT 1 FROM investor_allocation_results ip JOIN order_item_inventory_allocations ia ON ia.id=ip.allocation_id
    WHERE ip.contract_id=${contractExpr} AND (ip.pending=1 OR json_extract(ip.snapshot,'$.source_fingerprint') IS NOT (${fingerprintSql.replace(/\?1/g,'ia.order_id')})))`;
}

/** A mixed funded line needs evidence before money or stock can be refunded. */
export async function validateInvestorReturnEvidence(db: D1Database, caseId: string) {
  if (!await investorFinanceInstalled(db)) return;
  const kase = await db.prepare('SELECT order_item_id,qty FROM return_cases WHERE id=?').bind(caseId).first<{ order_item_id: string; qty: number }>();
  if (!kase) throw notFound('Return not found');
  const lots = (await db.prepare(`SELECT DISTINCT a.lot_id,EXISTS(SELECT 1 FROM investment_contracts c WHERE c.incoming_id=l.incoming_id AND c.state='active') AS funded FROM order_item_inventory_allocations a JOIN inventory_lots l ON l.id=a.lot_id
    WHERE a.order_item_id=? AND a.released_at IS NULL`).bind(kase.order_item_id).all<{ lot_id: string; funded: number }>()).results ?? [];
  if (lots.length < 2 || !lots.some(l => l.funded)) return;
  const n = await db.prepare('SELECT COALESCE(SUM(qty),0) AS n FROM stock_return_lot_evidence WHERE return_case_id=?').bind(caseId).first<{ n: number }>();
  if (n?.n !== kase.qty) throw badRequest('حدد دفعة القطع المرتجعة قبل رد المال لتسوية المستثمر الصحيح', 'RETURN_LOT_REQUIRED');
}

/** Read-only current entitlement. It never creates money from a GET. */
export async function investorOrderSplit(db: D1Database, orderId: string) {
  if (!await investorFinanceInstalled(db)) return { allocations: [], investor_profit_iqd: 0, owner_profit_iqd: null, pending: false };
  const sourceFingerprint = await fingerprint(db, orderId);
  const base = await getOrderProfitBase(db, orderId) as unknown as ProfitView;
  const contracts = (await db.prepare(`SELECT DISTINCT c.* FROM investment_contracts c JOIN inventory_lots l ON l.incoming_id=c.incoming_id
    JOIN order_item_inventory_allocations a ON a.lot_id=l.id WHERE a.order_id=? AND a.released_at IS NULL AND c.state='active'`).bind(orderId).all<InvestmentContract>()).results ?? [];
  const origins = (await db.prepare(`SELECT a.id,l.incoming_id FROM order_item_inventory_allocations a JOIN inventory_lots l ON l.id=a.lot_id
    WHERE a.order_id=? AND a.released_at IS NULL`).bind(orderId).all<{ id: string; incoming_id: string | null }>()).results ?? [];
  const adjustments = (await db.prepare(`SELECT s.allocation_id,SUM(s.unit_delta_iqd) AS unit_delta FROM lot_cost_adjustment_shares s
    JOIN order_item_inventory_allocations a ON a.id=s.allocation_id WHERE a.order_id=? GROUP BY s.allocation_id`).bind(orderId).all<{ allocation_id: string; unit_delta: number }>()).results ?? [];
  const evidence = (await db.prepare(`SELECT e.allocation_id,SUM(e.qty) AS qty FROM stock_return_lot_evidence e JOIN return_cases r ON r.id=e.return_case_id
    WHERE r.order_id=? AND r.state='resolved' AND r.resolution='refund' GROUP BY e.allocation_id`).bind(orderId).all<{ allocation_id: string; qty: number }>()).results ?? [];
  const financial = await db.prepare(`SELECT (SELECT COALESCE(SUM(amount_iqd),0) FROM finance_collections WHERE order_id=?1) AS collected,
    (SELECT COALESCE(SUM(refund_iqd),0) FROM finance_refund_facts WHERE order_id=?1 AND channel='gini') AS refunded`).bind(orderId).first<{ collected: number; refunded: number }>();
  const required = Math.max(0, Number(base.order.due_on_delivery_iqd ?? 0) + Number(base.order.gini_paid_iqd ?? 0) - (financial?.refunded ?? 0));
  const collected = (financial?.collected ?? 0) >= required;
  const delivered = base.order.status === 'delivered';
  const posting=await db.prepare(`SELECT EXISTS(SELECT 1 FROM accounting_entries WHERE event_key=?1 AND state='posted') AS sale,
    COALESCE((SELECT SUM(l.debit_iqd-l.credit_iqd) FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id WHERE e.event_key=?2 AND e.state='posted' AND l.account_code='5000'),0)
      +COALESCE((SELECT SUM(delta_iqd) FROM finance_workspace_postings WHERE order_id=?3 AND field='cogs_iqd'),0)
      +COALESCE((SELECT SUM(s.recognized_iqd) FROM lot_cost_adjustment_shares s JOIN order_item_inventory_allocations a ON a.id=s.allocation_id WHERE a.order_id=?3),0)
      -COALESCE((SELECT SUM(cogs_iqd) FROM finance_refund_facts WHERE order_id=?3 AND disposition='restock' AND posted_at IS NOT NULL),0) AS cogs,
    EXISTS(SELECT 1 FROM finance_refund_facts WHERE order_id=?3 AND posted_at IS NULL) AS refund_pending`).bind(`sale:${orderId}`,`cogs:${orderId}`,orderId).first<{sale:number;cogs:number;refund_pending:number}>();
  const out: Array<{ allocation_id: string; lot_id: string; contract_id: string; user_id: string; qty: number; profit_basis_iqd: number; profit_iqd: number; capital_iqd: number; loss_iqd: number; raw_loss_iqd:number;eligible: boolean; snapshot: string }> = [];
  let totalBasis = 0, investorProfit = 0, investorLoss = 0, pending = false;
  if(delivered&&contracts.length&&(!posting?.sale||posting.refund_pending||base.lines.some(l=>l.cogs_iqd===null)||posting.cogs!==base.lines.reduce((n,l)=>n+Number(l.cogs_iqd??0),0)))pending=true;
  for (const line of base.lines) {
    if (line.profit_basis_iqd !== null) totalBasis += line.profit_basis_iqd;
    const rows = line.allocations;
    if (!rows.length || line.profit_basis_iqd === null || line.cogs_iqd === null || !['fifo','manual_verified'].includes(line.cost_confidence) || (line.cost_confidence !== 'manual_verified' && rows.some(a => a.cogs_iqd === null))) {
      if (rows.some(a => contracts.some(c => c.incoming_id === origins.find(o => o.id === a.id)?.incoming_id))) pending = true;
      continue;
    }
    const returned = rows.map(a => evidence.find(e => e.allocation_id === a.id)?.qty ?? a.returned_qty ?? 0);
    if (line.returned_qty > returned.reduce((n, q) => n + q, 0) && rows.length > 1 && contracts.length) { pending = true; continue; }
    if (rows.length === 1) returned[0] = Math.max(returned[0], line.returned_qty);
    const weights = rows.map((a, i) => Math.max(0, a.qty - returned[i]));
    const revenue = signedShares(line.retained_revenue_iqd, weights.some(q => q > 0) ? weights : rows.map(a => a.qty));
    const originalCogs = rows.map(a => Number(a.cogs_iqd ?? 0) - Number(a.returned_cogs_iqd ?? 0) + (a.late_cost_iqd ?? 0));
    const costOverride = signedShares(line.cogs_iqd - originalCogs.reduce((n, v) => n + v, 0), rows.map(a => a.qty));
    const expenses = signedShares(line.retained_revenue_iqd - line.cogs_iqd - line.profit_basis_iqd, rows.map(a => a.qty));
    for (const [i, a] of rows.entries()) {
      const lateCost = a.late_cost_iqd === undefined ? (adjustments.find(v => v.allocation_id === a.id)?.unit_delta ?? 0) * Math.max(0, a.qty - Number(a.returned_qty ?? 0)) : 0;
      const cost = originalCogs[i] + costOverride[i] + lateCost;
      const profit = revenue[i] - cost - expenses[i];
      totalBasis -= lateCost;
      for (const c of contracts.filter(c => c.incoming_id === origins.find(o => o.id === a.id)?.incoming_id)) {
        const earned = percent(Math.max(0, profit), c.profit_share_bps);
        const loss = percent(Math.max(0, -profit), c.loss_share_bps);
        investorProfit += earned;
        investorLoss += loss;
        out.push({ allocation_id: a.id, lot_id: a.lot_id, contract_id: c.id, user_id: c.user_id,
          qty: weights[i], profit_basis_iqd: profit, profit_iqd: earned,
          capital_iqd: percent(Math.max(0, Math.min(cost, revenue[i])), c.capital_share_bps),
          loss_iqd: loss,raw_loss_iqd:loss,eligible: delivered && collected,
          snapshot: JSON.stringify({ version: base.version, source_fingerprint:sourceFingerprint,contract_version: c.version, qty: weights[i], revenue: revenue[i], cost, expenses: expenses[i], profit, collected, delivered }) });
      }
    }
  }
  // Attribute the limited capital loss in delivered-order order. Looking at
  // every other order as a prior loss would make both orders claim zero.
  for(const contract of contracts){
    const prior=(await db.prepare(`SELECT r.allocation_id,r.loss_iqd,o.delivered_at,a.order_id FROM investor_allocation_results r JOIN order_item_inventory_allocations a ON a.id=r.allocation_id JOIN orders o ON o.id=a.order_id WHERE r.contract_id=? AND a.order_id<>?`).bind(contract.id,orderId).all<{allocation_id:string;loss_iqd:number;delivered_at:string|null;order_id:string}>()).results??[];
    const money=await db.prepare(`SELECT COALESCE(SUM(CASE WHEN kind='funding' THEN amount_iqd ELSE 0 END),0) AS funded,COALESCE(SUM(CASE WHEN allocation_id IS NULL AND kind IN ('loss','loss_correction') THEN amount_iqd ELSE 0 END),0) AS physical FROM investor_finance_events WHERE contract_id=?`).bind(contract.id).first<{funded:number;physical:number}>();
    let left=Math.max(0,(money?.funded??0)-(money?.physical??0));
    const combined=[...prior,...out.filter(a=>a.contract_id===contract.id).map(a=>({allocation_id:a.allocation_id,loss_iqd:a.raw_loss_iqd,delivered_at:String(base.order.delivered_at??''),order_id:orderId}))].sort((a,b)=>`${a.delivered_at??''}:${a.order_id}:${a.allocation_id}`.localeCompare(`${b.delivered_at??''}:${b.order_id}:${b.allocation_id}`));
    for(const row of combined){const assigned=Math.min(left,row.loss_iqd);left-=assigned;const a=out.find(a=>a.contract_id===contract.id&&a.allocation_id===row.allocation_id);if(a){a.loss_iqd=assigned;a.snapshot=JSON.stringify({...JSON.parse(a.snapshot),capital_loss_iqd:assigned});}}
  }
  investorLoss=out.reduce((n,a)=>n+a.loss_iqd,0);
  const cap=Math.max(0,totalBasis);
  if(investorProfit>cap&&out.length){const shares=signedShares(cap,out.map(a=>a.profit_iqd));out.forEach((a,i)=>{a.profit_iqd=shares[i];a.snapshot=JSON.stringify({...JSON.parse(a.snapshot),profit_share_iqd:shares[i]});});investorProfit=cap;}
  return { allocations: out, investor_profit_iqd: delivered ? investorProfit : 0, investor_loss_iqd: delivered ? investorLoss : 0,
    investor_net_iqd: delivered ? investorProfit - investorLoss : 0,
    owner_profit_iqd: pending ? null : totalBasis - (delivered ? investorProfit - investorLoss : 0), pending, source_fingerprint: sourceFingerprint };
}

export function planInvestorSources(db: D1Database, contract: InvestmentContract, day: string) {
  // All aggregates are evaluated inside the same D1 batch as each projection.
  // Two orders cannot publish a source calculated from an earlier read.
  return ['investor_profit','investor_capital'].map(kind => db.prepare(`
    WITH totals AS (SELECT COALESCE(SUM(profit_iqd),0) AS accrued,COALESCE(SUM(CASE WHEN eligible=1 THEN profit_iqd ELSE 0 END),0) AS available,
      COALESCE(SUM(CASE WHEN eligible=1 THEN capital_iqd ELSE 0 END),0) AS capital,COALESCE(SUM(loss_iqd),0) AS loss,COALESCE(MAX(pending),0) AS pending FROM investor_allocation_results WHERE contract_id=?1),
    funds AS (SELECT COALESCE(SUM(CASE WHEN kind='funding' THEN amount_iqd ELSE 0 END),0) AS funded,
      COALESCE(SUM(CASE WHEN allocation_id IS NULL AND kind IN ('loss','loss_correction') THEN amount_iqd ELSE 0 END),0) AS physical_loss FROM investor_finance_events WHERE contract_id=?1),
    value AS (SELECT CASE WHEN ?2='investor_profit' THEN accrued ELSE MAX(0,MIN(capital,funded-loss-physical_loss)) END AS accrued,
      CASE WHEN pending=1 THEN 0 WHEN ?2='investor_profit' THEN CASE WHEN funded>=?3 THEN MAX(0,available) ELSE 0 END ELSE MAX(0,MIN(capital,funded-loss-physical_loss)) END AS amount FROM totals,funds)
    INSERT INTO finance_investor_earnings(id,user_id,contract_id,kind,title,amount_iqd,accrued_iqd,state,day,updated_at)
    SELECT ?4,?5,?1,?2,?6,amount,accrued,CASE WHEN amount>0 THEN 'available' ELSE 'pending' END,?7,?8 FROM value WHERE 1
    ON CONFLICT(id) DO UPDATE SET amount_iqd=excluded.amount_iqd,accrued_iqd=excluded.accrued_iqd,state=excluded.state,
    version=finance_investor_earnings.version+1,updated_at=excluded.updated_at WHERE amount_iqd<>excluded.amount_iqd OR accrued_iqd<>excluded.accrued_iqd OR state<>excluded.state`)
    .bind(contract.id,kind,contract.principal_iqd,`${kind === 'investor_profit' ? 'invprofit' : 'invcapital'}:${contract.id}`,contract.user_id,contract.name,day,new Date().toISOString()));
}

/** Delivery/refund/correction/collection hook. Source events and journal commit together. */
export async function syncInvestorOrder(db: D1Database, orderId: string, opts: { actor?: string; day?: string } = {}) {
  if (!await investorFinanceInstalled(db)) return;
  const order = await db.prepare('SELECT status FROM orders WHERE id=?').bind(orderId).first<{ status: string }>();
  if (!order) return;
  const day = opts.day ?? baghdadDay();
  await recognizeLateCosts(db, orderId, day, opts.actor);
  if (order.status !== 'delivered') return;
  const split = await investorOrderSplit(db, orderId);
  if (split.pending) {
    const contracts = (await db.prepare(`SELECT DISTINCT c.* FROM investment_contracts c JOIN investor_allocation_results r ON r.contract_id=c.id JOIN order_item_inventory_allocations a ON a.id=r.allocation_id WHERE a.order_id=?`).bind(orderId).all<InvestmentContract>()).results ?? [];
    await db.batch([...fence(db,`(SELECT ${fingerprintSql.replace(/\?1/g, '?2')})=?3`,[orderId,split.source_fingerprint]),db.prepare(`UPDATE investor_allocation_results SET pending=1,eligible=0,version=version+1 WHERE allocation_id IN (SELECT id FROM order_item_inventory_allocations WHERE order_id=?) AND pending=0`).bind(orderId),...contracts.flatMap(c=>planInvestorSources(db,c,day))]);
    throw conflict('أرباح المستثمر معلقة حتى تثبيت التكلفة وأصل المرتجع','INVESTOR_PENDING');
  }
  await periodOpen(db, day);
  const orderStatements:D1PreparedStatement[]=[...fence(db,`(SELECT ${fingerprintSql.replace(/\?1/g, '?2')})=?3`,[orderId,split.source_fingerprint])];
  const touched=new Set<string>();
  for (const a of split.allocations) {
    const old = await db.prepare('SELECT * FROM investor_allocation_results WHERE allocation_id=? AND contract_id=?').bind(a.allocation_id, a.contract_id)
      .first<{ profit_iqd: number; capital_iqd: number; loss_iqd: number; eligible: number; version: number; snapshot: string }>();
    if (old?.snapshot === a.snapshot && !(old as unknown as {pending?:number})?.pending) continue;
    touched.add(a.contract_id);
    const version = (old?.version ?? 0) + 1;
    const statements: D1PreparedStatement[] = [...fence(db, old
      ? 'EXISTS(SELECT 1 FROM investor_allocation_results WHERE allocation_id=? AND contract_id=? AND version=?)'
      : 'NOT EXISTS(SELECT 1 FROM investor_allocation_results WHERE allocation_id=? AND contract_id=?)', old ? [a.allocation_id, a.contract_id, old.version] : [a.allocation_id, a.contract_id])];
    for (const [field, kind, before] of [
      ['profit_iqd', old ? 'profit_correction' : 'profit', old?.profit_iqd ?? 0],
      ['capital_iqd', old ? 'capital_correction' : 'capital_recovered', old?.capital_iqd ?? 0],
      ['loss_iqd', old ? 'loss_correction' : 'loss', old?.loss_iqd ?? 0],
    ] as const) {
      const delta = (field==='loss_iqd'?a.raw_loss_iqd:a[field]) - before;
      if (!delta) continue;
      statements.push(db.prepare(`INSERT INTO investor_finance_events(id,event_key,contract_id,kind,amount_iqd,event_day,order_id,allocation_id,lot_id,actor_id,snapshot,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(newId('ive'), `${a.contract_id}:${a.allocation_id}:${version}:${kind}`, a.contract_id, kind, delta, day, orderId,
          a.allocation_id, a.lot_id, opts.actor ?? null, a.snapshot, new Date().toISOString()));
      if (field === 'profit_iqd') statements.push(...journalPlan(db, { key: `investor-profit:${a.contract_id}:${a.allocation_id}:${version}`, day,
        title: 'توزيع ربح دفعة على المستثمر', source: 'investor', sourceId: a.contract_id, actor: opts.actor }, delta > 0
        ? [{ account: '3200', debit: delta }, { account: '2450', credit: delta }]
        : [{ account: '2450', debit: -delta }, { account: '3200', credit: -delta }]).statements);
    }
    statements.push(db.prepare(`INSERT INTO investor_allocation_results(allocation_id,contract_id,profit_iqd,capital_iqd,loss_iqd,eligible,snapshot,version)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(allocation_id,contract_id) DO UPDATE SET profit_iqd=excluded.profit_iqd,capital_iqd=excluded.capital_iqd,
      loss_iqd=excluded.loss_iqd,eligible=excluded.eligible,pending=0,snapshot=excluded.snapshot,version=excluded.version`)
      .bind(a.allocation_id, a.contract_id, a.profit_iqd, a.capital_iqd, a.raw_loss_iqd, a.eligible ? 1 : 0, a.snapshot, version));
    orderStatements.push(...statements);
  }
  for(const id of touched){const contract=await db.prepare('SELECT * FROM investment_contracts WHERE id=?').bind(id).first<InvestmentContract>();if(!contract)throw conflict('Contract missing');
    const before=(await db.prepare('SELECT COALESCE(SUM(r.loss_iqd),0) AS n FROM investor_allocation_results r JOIN order_item_inventory_allocations a ON a.id=r.allocation_id WHERE r.contract_id=? AND a.order_id=?').bind(id,orderId).first<{n:number}>())?.n??0;
    const after=split.allocations.filter(a=>a.contract_id===id).reduce((n,a)=>n+a.raw_loss_iqd,0),loss=await planInvestorCapitalLoss(db,contract,after-before,day,opts.actor);
    orderStatements.unshift(...loss.guards);orderStatements.push(...loss.post,...planInvestorSources(db,contract,day));}
  if(touched.size)await db.batch(orderStatements);
}

export async function investorParticipantSources(db: D1Database, userId: string) {
  if (!await investorFinanceInstalled(db)) return [];
  const employmentPending=await employmentInstalled(db)?investorEmploymentPendingSql():'0';
  const rows = (await db.prepare(`SELECT e.*,(${investorProjectionStaleSql()} OR ${employmentPending}) AS stale,COALESCE((SELECT SUM(a.paid_iqd) FROM finance_withdrawal_allocations a WHERE a.source_kind=e.kind AND a.source_id=e.id),0) AS paid_iqd
    FROM finance_investor_earnings e WHERE e.user_id=? ORDER BY e.day,e.id`).bind(userId).all<Record<string, unknown>>()).results ?? [];
  return rows.map(r => ({ ...r, id: String(r.id), contract_id:String(r.contract_id), kind: r.kind as 'investor_profit' | 'investor_capital', title: String(r.title), order_id: r.order_id == null ? null : String(r.order_id), day: String(r.day),
    amount_iqd: Number(r.amount_iqd), accrued_iqd: Number(r.accrued_iqd), paid_iqd: Number(r.paid_iqd), version: Number(r.version), state: r.stale?'pending':String(r.state), eligible: !r.stale&&r.state === 'available' }));
}

/** Cost corrections initially stay in inventory, then follow delivered/returned quantities. */
export async function recognizeLateCosts(db: D1Database, orderId: string, day = baghdadDay(), actor?: string) {
  if(!await investorFinanceInstalled(db))return;
  const shares = (await db.prepare(`SELECT s.rowid AS row_id,s.*,a.qty AS sold_qty,o.status,
    (SELECT COALESCE(SUM(r.qty),0) FROM order_item_inventory_allocations r WHERE r.order_item_id=a.order_item_id AND r.lot_id=a.lot_id AND r.released_at IS NOT NULL) AS restored
    FROM lot_cost_adjustment_shares s JOIN order_item_inventory_allocations a ON a.id=s.allocation_id JOIN orders o ON o.id=a.order_id WHERE a.order_id=?`).bind(orderId)
    .all<{ row_id: number; adjustment_id: string; allocation_id: string; unit_delta_iqd: number; recognized_iqd: number; version: number; qty: number; sold_qty: number; restored: number; status: string }>()).results ?? [];
  for (const s of shares) {
    const target = s.status === 'delivered' ? Math.min(s.qty, Math.max(0, s.sold_qty - s.restored)) * s.unit_delta_iqd : 0;
    const delta = target - s.recognized_iqd;
    if (!delta) continue;
    await periodOpen(db, day);
    await db.batch([
      ...fence(db, 'EXISTS(SELECT 1 FROM lot_cost_adjustment_shares WHERE rowid=? AND version=?)', [s.row_id, s.version]),
      ...journalPlan(db, { key: `late-cogs:${s.adjustment_id}:${s.allocation_id}:${s.version}`, day, title: 'تسوية تكلفة دفعة مباعة', source: 'lot-cost', sourceId: s.adjustment_id, actor }, delta > 0
        ? [{ account: '5000', debit: delta }, { account: '1200', credit: delta }]
        : [{ account: '1200', debit: -delta }, { account: '5000', credit: -delta }]).statements,
      db.prepare('UPDATE lot_cost_adjustment_shares SET recognized_iqd=?,version=version+1 WHERE rowid=?').bind(target, s.row_id),
    ]);
  }
}

export async function investmentContractSummary(db: D1Database, id: string) {
  const contract = await db.prepare('SELECT c.*,u.name AS user_name FROM investment_contracts c JOIN users u ON u.id=c.user_id WHERE c.id=?').bind(id).first<InvestmentContract>();
  if (!contract) throw notFound('Investment contract not found');
  const funded = (await db.prepare("SELECT COALESCE(SUM(amount_iqd),0) AS n FROM investor_finance_events WHERE contract_id=? AND kind='funding'").bind(id).first<{ n: number }>())?.n ?? 0;
  const inventory = (await db.prepare(`SELECT SUM(l.qty_remaining*COALESCE((SELECT v.unit_cost_iqd FROM inventory_lot_cost_versions v WHERE v.lot_id=l.id ORDER BY version DESC LIMIT 1),l.unit_cost_iqd)) AS n,
    SUM(CASE WHEN l.unit_cost_iqd IS NULL THEN l.qty_remaining ELSE 0 END) AS unknown FROM inventory_lots l WHERE l.incoming_id=?`).bind(contract.incoming_id).first<{ n: number; unknown: number }>());
  const sources = (await investorParticipantSources(db, contract.user_id)).filter(s => s.contract_id === id);
  const holds=(await db.prepare(`SELECT a.source_id,SUM(a.amount_iqd-a.paid_iqd) AS n FROM finance_withdrawal_allocations a JOIN finance_withdrawals w ON w.id=a.withdrawal_id WHERE w.state IN ('requested','approved','part_paid') AND a.source_id IN (?,?) GROUP BY a.source_id`).bind(`invprofit:${id}`,`invcapital:${id}`).all<{source_id:string;n:number}>()).results??[];
  const available=(kind:string)=>{const s=sources.find(s=>s.kind===kind);return s?.eligible?Math.max(0,s.amount_iqd-s.paid_iqd-(holds.find(h=>h.source_id===s.id)?.n??0)):0;};
  const loss = (await db.prepare("SELECT COALESCE(amount_iqd,0) AS n FROM investor_capital_losses WHERE contract_id=?").bind(id).first<{ n: number }>())?.n ?? 0;
  return { contract, summary: { funded_iqd: funded, principal_iqd: contract.principal_iqd,
    inventory_capital_iqd: inventory?.unknown ? null : percent(inventory?.n ?? 0, contract.capital_share_bps),
    accrued_profit_iqd: sources.find(s => s.kind === 'investor_profit')?.accrued_iqd ?? 0,
    available_profit_iqd: available('investor_profit'),available_capital_iqd:available('investor_capital'),
    paid_profit_iqd:sources.find(s=>s.kind==='investor_profit')?.paid_iqd??0,paid_capital_iqd:sources.find(s=>s.kind==='investor_capital')?.paid_iqd??0,
    recovered_capital_iqd: sources.find(s => s.kind === 'investor_capital')?.amount_iqd ?? 0, loss_iqd: loss }, sources };
}

export async function refreshInvestorContract(db: D1Database, id: string, day = baghdadDay()) {
  const contract = await db.prepare('SELECT * FROM investment_contracts WHERE id=?').bind(id).first<InvestmentContract>();
  if (!contract) throw conflict('Contract changed');
  const loss=await planInvestorCapitalLoss(db,contract,0,day);
  await db.batch([...loss.guards,...loss.post,...planInvestorSources(db,contract,day)]);
}
