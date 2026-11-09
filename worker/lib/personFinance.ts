import { participantAdvanceState, participantSources, participantSummary, participantWithdrawableSources, type ParticipantSource } from './financeParticipants';
import { investorInventoryCapital } from './investorInventoryCapital';
import { investorOrderProjectionStaleSql } from './investorFinance';
import { employmentInstalled, investorEmploymentPendingSql } from './financeEmployment';
import { inactiveAt, type EmploymentInterval } from './financeEmploymentIntervals';
import { PENDING_SURPLUS_SQL, SURPLUS_PREFIX, surplusInstalled } from './investorSurplus';
import { investorReportedAllocationsSql } from './investorCapitalReporting';
import { staffPeriodReport } from './financeParticipantReports';
import { financeRangeArgs, inFinanceRangeSql, type FinanceRange } from './financeRange';

/**
 * ONE PERSON, ONE PICTURE (owner request 2026-11-09: «he doesnot show his
 * invest his return his ratio or what he earn from invest and work»).
 *
 * The owner's people screens and the person's own «أرباحي» read this one
 * summary, so both show the same numbers. It is read-only: every amount comes
 * from the ledgers that already pay people (participantSources and the
 * withdrawal budgets), never a second calculation of money. What it adds is
 * the grouping the owner asked for —
 *   - capital: put in, still at work (in stock, in transit, sold but not yet
 *     released), returned (withdrawable, reserved or paid back);
 *   - each agreement's own profit share, and the share actually earned;
 *   - profit earned, settled and held, with the REASON a sale is held;
 *   - return on investment so far;
 *   - wages, and one combined «what he earned» from investing and working.
 * The person's own view never receives order ids (owner: false).
 */
/**
 * Why money is not withdrawable yet:
 *   cost          the sale's cost of goods is not complete (or its investor split is pending on it)
 *   cancelled     the order is no longer delivered (cancelled or returned after delivery)
 *   recalculation the system is still recalculating (a wage job, a stale projection, a posting retry)
 *   funding       the agreement's capital is not fully received yet
 *   collection    delivered, but the courier cash is not recorded as collected
 *   agreement     this sale is settled, but another sale of the same agreement is unresolved,
 *                 and today's rule holds the whole agreement for it
 */
export type HoldReason = 'collection' | 'cost' | 'recalculation' | 'cancelled' | 'funding' | 'agreement';

export interface HeldSale {
  /** Owner view only. */
  order_id?: string;
  /** Baghdad delivery day. Owner view only. */
  day?: string | null;
  /** Every reason that applies to this sale; the first is the main one. */
  reasons: HoldReason[];
  profit_iqd: number;
  capital_iqd: number;
  /** Profit not calculated yet (the sale's cost is unresolved). */
  profit_unknown: boolean;
}

export interface AgreementFinance {
  id: string;
  name: string;
  product_name: string | null;
  product_name_ar: string | null;
  label: string | null;
  created_at: string;
  principal_iqd: number;
  funded_iqd: number;
  profit_share_bps: number;
  loss_share_bps: number;
  units: { received: number; sold: number; in_stock: number };
  capital: { in_stock_iqd: number | null; in_transit_iqd: number; back_from_sales_iqd: number; available_iqd: number; reserved_iqd: number; paid_iqd: number; held_iqd: number; loss_iqd: number };
  profit: { earned_iqd: number; available_iqd: number; reserved_iqd: number; paid_iqd: number; held_iqd: number; sales: number; sales_unknown: number };
  /** The whole agreement is held while one of its sales is unresolved (DECISIONS row 304). */
  held_whole: boolean;
  held_sales: HeldSale[];
}

export interface PersonWork {
  staff_id: string;
  name: string;
  role: string;
  status: 'active' | 'paused' | 'archived';
  start_work_date: string | null;
  /** Current pause start (ISO), when paused. */
  paused_from: string | null;
  /** Scheduled resumption (ISO) of the current pause, if any. */
  resumes_at: string | null;
  /** When work last resumed after a pause (ISO), while active. */
  working_since: string | null;
  pauses: EmploymentInterval[];
}

export interface PersonFinance {
  user_id: string | null;
  name: string;
  investor: null | {
    state: string;
    default_profit_share_bps: number | null;
    capital: {
      agreed_iqd: number; put_in_iqd: number; in_agreements_iqd: number;
      in_stock_iqd: number | null; in_transit_iqd: number; sold_held_iqd: number; at_work_iqd: number | null;
      unused_returned_iqd: number; awaiting_rest_of_funding_iqd: number;
      returned_iqd: number; available_iqd: number; reserved_iqd: number; paid_iqd: number; loss_iqd: number;
    };
    profit: { earned_iqd: number; available_iqd: number; reserved_iqd: number; paid_iqd: number; held_iqd: number; debt_iqd: number };
    share: { agreements_bps: number[]; min_bps: number | null; max_bps: number | null; earned_bps: number | null };
    /** Profit earned so far ÷ capital put in, in basis points. */
    roi_bps: number | null;
    units: { received: number; sold: number; in_stock: number };
    agreements: AgreementFinance[];
    holds: Array<{ reason: HoldReason; sales: number; profit_iqd: number; capital_iqd: number; profit_unknown: number }>;
  };
  work: null | {
    roles: PersonWork[];
    earned_iqd: number; paid_iqd: number; available_iqd: number; reserved_iqd: number; held_iqd: number; debt_iqd: number; balance_iqd: number;
    pending_costs: number;
    holds: Array<{ reason: HoldReason; entries: number; amount_iqd: number }>;
  };
  combined: { earned_iqd: number; paid_iqd: number; available_iqd: number; held_iqd: number };
  period?: { wages_iqd: number; profit_iqd: number };
}

const REASON_ORDER: HoldReason[] = ['cost', 'cancelled', 'recalculation', 'funding', 'collection', 'agreement'];
const sortReasons = (reasons: Iterable<HoldReason>) => [...new Set(reasons)].sort((a, b) => REASON_ORDER.indexOf(a) - REASON_ORDER.indexOf(b));
const tableExists = async (db: D1Database, name: string) => !!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").bind(name).first();

/** Work status from the saved pause intervals, as the payroll reads them. */
export function workStatus(staff: { archived_at: string | null; active: number; inactive_periods_json: string; start_work_date: string | null }, now = Date.now()) {
  const pauses = JSON.parse(staff.inactive_periods_json || '[]') as EmploymentInterval[];
  const current = pauses.find((p) => inactiveAt([p], now)) ?? null;
  const status: PersonWork['status'] = staff.archived_at ? 'archived' : pauses.length ? (current ? 'paused' : 'active') : staff.active ? 'active' : 'paused';
  const lastResume = pauses.filter((p) => p.to && Date.parse(p.to) <= now).map((p) => p.to!).sort().at(-1) ?? null;
  return { status, paused_from: status === 'active' ? null : current?.from ?? null, resumes_at: status === 'paused' ? current?.to ?? null : null, working_since: status === 'active' ? lastResume : null, pauses };
}

type ResultRow = { allocation_id: string; contract_id: string; profit_iqd: number; capital_iqd: number; eligible: number; pending: number; qty: number | null; profit_basis: number | null; order_id: string; status: string; day: string | null; collected: number; cost_error: number; other_error: number; stale: number };

async function investorPart(db: D1Database, userId: string, sources: ParticipantSource[], budgets: Map<string, number>, summary: ReturnType<typeof participantSummary>, owner: boolean): Promise<PersonFinance['investor']> {
  if (!await tableExists(db, 'investment_contracts')) return null;
  const profile = await tableExists(db, 'investment_profiles') ? await db.prepare('SELECT state,default_profit_share_bps FROM investment_profiles WHERE user_id=?').bind(userId).first<{ state: string; default_profit_share_bps: number }>() : null;
  const contracts = (await db.prepare(`SELECT c.id,c.name,c.incoming_id,c.principal_iqd,c.capital_share_bps,c.profit_share_bps,c.loss_share_bps,c.created_at,
      i.qty_received,p.name AS product_name,p.name_ar AS product_name_ar,(SELECT pl.label FROM purchase_lines pl WHERE pl.incoming_id=i.id LIMIT 1) AS label,
      COALESCE((SELECT SUM(e.amount_iqd) FROM investor_finance_events e WHERE e.contract_id=c.id AND e.kind='funding'),0) AS funded_iqd,
      COALESCE((SELECT SUM(l.qty_remaining) FROM inventory_lots l WHERE l.incoming_id=i.id),0) AS in_stock,
      COALESCE((SELECT amount_iqd FROM investor_capital_losses x WHERE x.contract_id=c.id),0) AS loss_iqd
    FROM investment_contracts c JOIN incoming_inventory i ON i.id=c.incoming_id LEFT JOIN products p ON p.id=i.product_id
    WHERE c.user_id=? AND c.state='active' ORDER BY c.created_at,c.id`).bind(userId).all<{ id: string; name: string; incoming_id: string; principal_iqd: number; capital_share_bps: number; profit_share_bps: number; loss_share_bps: number; created_at: string; qty_received: number; product_name: string | null; product_name_ar: string | null; label: string | null; funded_iqd: number; in_stock: number; loss_iqd: number }>()).results ?? [];
  const surplusRows = sources.filter((s) => s.kind === 'investor_capital' && s.id.startsWith(SURPLUS_PREFIX));
  if (!profile && !contracts.length && !surplusRows.length) return null;

  const results = contracts.length ? (await db.prepare(`SELECT r.allocation_id,r.contract_id,r.profit_iqd,r.capital_iqd,r.eligible,r.pending,
      json_extract(r.snapshot,'$.qty') AS qty,json_extract(r.snapshot,'$.profit') AS profit_basis,
      a.order_id,o.status,date(o.delivered_at,'+3 hours') AS day,
      (SELECT COALESCE(SUM(fc.amount_iqd),0) FROM finance_collections fc WHERE fc.order_id=a.order_id)>=MAX(0,COALESCE(o.due_on_delivery_iqd,0)+COALESCE(o.gini_paid_iqd,0)
        -(SELECT COALESCE(SUM(rf.refund_iqd),0) FROM finance_refund_facts rf WHERE rf.order_id=a.order_id AND rf.channel='gini')) AS collected,
      EXISTS(SELECT 1 FROM finance_posting_errors pe WHERE pe.order_id=a.order_id AND (pe.event_key LIKE 'cogs:%' OR pe.event_key LIKE 'investor-pending:%')) AS cost_error,
      EXISTS(SELECT 1 FROM finance_posting_errors pe WHERE pe.order_id=a.order_id AND pe.event_key NOT LIKE 'cogs:%' AND pe.event_key NOT LIKE 'investor-pending:%') AS other_error,
      (${investorOrderProjectionStaleSql('a.order_id')}) AS stale
    FROM investor_allocation_results r JOIN investment_contracts c ON c.id=r.contract_id
    JOIN order_item_inventory_allocations a ON a.id=r.allocation_id JOIN orders o ON o.id=a.order_id
    WHERE c.user_id=? AND c.state='active' ORDER BY o.delivered_at,a.order_id,r.allocation_id`).bind(userId).all<ResultRow>()).results ?? [] : [];
  const employment = await employmentInstalled(db);

  const agreements: AgreementFinance[] = [];
  for (const c of contracts) {
    const rows = results.filter((r) => r.contract_id === c.id);
    const inventory = await investorInventoryCapital(db, c);
    const wagesPending = employment && !!(await db.prepare(`SELECT ${investorEmploymentPendingSql('?', "'investor_profit'")} AS n`).bind(c.id).first<{ n: number }>())?.n;
    const profitSource = sources.find((s) => s.id === `invprofit:${c.id}`);
    const capitalSource = sources.find((s) => s.id === `invcapital:${c.id}`);
    const money = (s: ParticipantSource | undefined, id: string) => {
      const accrued = s?.accrued_iqd ?? 0, paid = s?.paid_iqd ?? 0, reserved = s?.held_iqd ?? 0, available = budgets.get(id) ?? 0;
      return { accrued, paid, reserved, available, held: Math.max(0, accrued - paid - reserved - available) };
    };
    const profit = money(profitSource, `invprofit:${c.id}`), capital = money(capitalSource, `invcapital:${c.id}`);
    const bySale = new Map<string, ResultRow[]>();
    for (const r of rows) bySale.set(r.order_id, [...(bySale.get(r.order_id) ?? []), r]);
    // planInvestorSources zeroes the whole agreement while any of its sales is
    // pending, and the read-time guard blocks it for any unresolved order.
    const heldWhole = (!!profitSource?.blocked || !!capitalSource?.blocked || rows.some((r) => r.pending === 1)) && profit.held + capital.held > 0;
    const heldSales: HeldSale[] = [];
    for (const [orderId, sale] of bySale) {
      const reasons: HoldReason[] = [];
      if (sale.some((r) => r.status !== 'delivered')) reasons.push('cancelled');
      const costPending = sale.some((r) => r.pending === 1 || r.cost_error);
      if (costPending) reasons.push('cost');
      // A pending row reads as stale by construction; only a settled one being redone is a recalculation.
      if ((!costPending && sale.some((r) => r.stale)) || sale.some((r) => r.other_error) || wagesPending) reasons.push('recalculation');
      if (sale.some((r) => !r.collected)) reasons.push('collection');
      if (c.funded_iqd < c.principal_iqd) reasons.push('funding');
      // A sale that is not itself a cause still waits for the one that is.
      if (heldWhole && !reasons.some((r) => r === 'cost' || r === 'cancelled' || r === 'recalculation')) reasons.push('agreement');
      if (!reasons.length) continue;
      heldSales.push({ ...(owner ? { order_id: orderId, day: sale[0].day } : {}), reasons: sortReasons(reasons),
        profit_iqd: sale.reduce((n, r) => n + (r.pending === 1 ? 0 : r.profit_iqd), 0), capital_iqd: sale.reduce((n, r) => n + r.capital_iqd, 0),
        profit_unknown: sale.some((r) => r.pending === 1) });
    }
    agreements.push({
      id: c.id, name: c.name, product_name: c.product_name, product_name_ar: c.product_name_ar, label: owner ? c.label : null, created_at: c.created_at,
      principal_iqd: c.principal_iqd, funded_iqd: c.funded_iqd, profit_share_bps: c.profit_share_bps, loss_share_bps: c.loss_share_bps,
      units: { received: c.qty_received, sold: rows.reduce((n, r) => n + Math.max(0, Number(r.qty ?? 0)), 0), in_stock: c.in_stock },
      capital: { in_stock_iqd: inventory.inventory_iqd, in_transit_iqd: inventory.received_iqd === null ? 0 : Math.max(0, c.funded_iqd - inventory.received_iqd),
        back_from_sales_iqd: capital.accrued, available_iqd: capital.available, reserved_iqd: capital.reserved, paid_iqd: capital.paid, held_iqd: capital.held, loss_iqd: c.loss_iqd },
      profit: { earned_iqd: profit.accrued, available_iqd: profit.available, reserved_iqd: profit.reserved, paid_iqd: profit.paid, held_iqd: profit.held,
        sales: bySale.size, sales_unknown: [...bySale.values()].filter((sale) => sale.some((r) => r.pending === 1)).length },
      held_whole: heldWhole,
      held_sales: heldSales,
    });
  }

  const sum = <T>(list: T[], f: (x: T) => number) => list.reduce((n, x) => n + f(x), 0);
  // Capital received is the cash the store actually got from this person:
  // funding recorded on direct agreements plus every purchase receipt (the part
  // no agreement took is the unused remainder returned to «أرباحي»).
  const purchases = await surplusInstalled(db) && await tableExists(db, 'purchase_investor_allocations');
  const funds = await db.prepare(`SELECT
      COALESCE((SELECT SUM(e.amount_iqd) FROM investor_finance_events e JOIN investment_contracts c ON c.id=e.contract_id WHERE c.user_id=?1 AND e.kind='funding'),0) AS funded,
      COALESCE((SELECT SUM(principal_iqd) FROM investment_contracts c WHERE c.user_id=?1 AND c.state='active'${purchases ? ' AND NOT EXISTS(SELECT 1 FROM purchase_investor_allocations a WHERE a.contract_id=c.id)' : ''}),0) AS direct_agreed,
      ${purchases ? 'COALESCE((SELECT SUM(agreed_iqd) FROM purchase_investor_agreements WHERE user_id=?1),0)' : '0'} AS purchase_agreed`).bind(userId).first<{ funded: number; direct_agreed: number; purchase_agreed: number }>();
  const unused = sum(surplusRows, (s) => s.accrued_iqd);
  const awaitingRest = await surplusInstalled(db) ? (await db.prepare(PENDING_SURPLUS_SQL).bind(userId).first<{ n: number }>())?.n ?? 0 : 0;
  const inStock = agreements.some((a) => a.capital.in_stock_iqd === null) ? null : sum(agreements, (a) => a.capital.in_stock_iqd!);
  const inTransit = sum(agreements, (a) => a.capital.in_transit_iqd);
  const capitalLedger = summary.ledgers.investor_capital;
  const soldHeld = summary.capital_pending_iqd;
  const putIn = (funds?.funded ?? 0) + unused;
  const profitLedger = summary.ledgers.investor_profit;
  const earned = summary.investor_profit_iqd;
  const basis = sum(results.filter((r) => r.pending !== 1 && r.profit_basis !== null), (r) => Math.max(0, Number(r.profit_basis)));
  const earnedKnown = sum(results.filter((r) => r.pending !== 1), (r) => r.profit_iqd);
  const shares = [...new Set(contracts.map((c) => c.profit_share_bps))].sort((a, b) => a - b);
  const holds = new Map<HoldReason, { reason: HoldReason; sales: number; profit_iqd: number; capital_iqd: number; profit_unknown: number }>();
  for (const sale of agreements.flatMap((a) => a.held_sales)) {
    const reason = sale.reasons[0] ?? 'recalculation';
    const h = holds.get(reason) ?? { reason, sales: 0, profit_iqd: 0, capital_iqd: 0, profit_unknown: 0 };
    h.sales++; h.profit_iqd += sale.profit_iqd; h.capital_iqd += sale.capital_iqd; if (sale.profit_unknown) h.profit_unknown++;
    holds.set(reason, h);
  }
  return {
    state: profile?.state ?? 'active',
    default_profit_share_bps: profile?.default_profit_share_bps ?? null,
    capital: {
      agreed_iqd: (funds?.direct_agreed ?? 0) + (funds?.purchase_agreed ?? 0), put_in_iqd: putIn, in_agreements_iqd: sum(contracts, (c) => c.principal_iqd),
      in_stock_iqd: inStock, in_transit_iqd: inTransit, sold_held_iqd: soldHeld, at_work_iqd: inStock === null ? null : inStock + inTransit + soldHeld,
      unused_returned_iqd: unused, awaiting_rest_of_funding_iqd: awaitingRest,
      returned_iqd: capitalLedger.available_iqd + capitalLedger.held_iqd + capitalLedger.paid_iqd,
      available_iqd: capitalLedger.available_iqd, reserved_iqd: capitalLedger.held_iqd, paid_iqd: capitalLedger.paid_iqd, loss_iqd: sum(contracts, (c) => c.loss_iqd),
    },
    profit: { earned_iqd: earned, available_iqd: profitLedger.available_iqd, reserved_iqd: profitLedger.held_iqd, paid_iqd: profitLedger.paid_iqd,
      held_iqd: summary.investor_profit_pending_iqd, debt_iqd: profitLedger.debt_iqd },
    share: { agreements_bps: shares, min_bps: shares[0] ?? null, max_bps: shares.at(-1) ?? null, earned_bps: basis > 0 ? Math.round(earnedKnown * 10000 / basis) : null },
    roi_bps: putIn > 0 ? Math.floor(earned * 10000 / putIn) : null,
    units: { received: sum(agreements, (a) => a.units.received), sold: sum(agreements, (a) => a.units.sold), in_stock: sum(agreements, (a) => a.units.in_stock) },
    agreements,
    holds: sortReasons(holds.keys()).map((r) => holds.get(r)!),
  };
}

type StaffRow = { id: string; name: string; role: string; user_id: string | null; active: number; start_work_date: string | null; archived_at: string | null; inactive_periods_json: string };

async function workPart(db: D1Database, staffRows: StaffRow[], sources: ParticipantSource[], summary: ReturnType<typeof participantSummary>): Promise<PersonFinance['work']> {
  if (!staffRows.length) return null;
  const roles = staffRows.map((s) => ({ staff_id: s.id, name: s.name, role: s.role, start_work_date: s.start_work_date, ...workStatus(s) }));
  const blocked = sources.filter((s) => s.kind === 'staff' && s.blocked && s.accrued_iqd - s.paid_iqd > 0);
  const holds = new Map<HoldReason, { reason: HoldReason; entries: number; amount_iqd: number }>();
  if (blocked.length) {
    const rows = (await db.prepare(`SELECT c.id,o.status,
        EXISTS(SELECT 1 FROM finance_wage_targets wt WHERE wt.cost_id=c.id AND wt.amount_iqd IS NULL) AS pending_cost,
        EXISTS(SELECT 1 FROM finance_staff_reconciliations j WHERE j.staff_id=c.staff_id AND j.state<>'complete') AS job,
        EXISTS(SELECT 1 FROM finance_posting_errors pe WHERE pe.order_id=c.order_id) AS posting
      FROM finance_order_costs c JOIN orders o ON o.id=c.order_id WHERE c.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(blocked.map((s) => s.id))).all<{ id: string; status: string; pending_cost: number; job: number; posting: number }>()).results ?? [];
    for (const s of blocked) {
      const r = rows.find((x) => x.id === s.id);
      const reason: HoldReason = !r ? 'recalculation' : r.status !== 'delivered' ? 'cancelled' : r.job ? 'recalculation' : r.pending_cost || r.posting ? 'cost' : 'recalculation';
      const h = holds.get(reason) ?? { reason, entries: 0, amount_iqd: 0 };
      h.entries++; h.amount_iqd += s.accrued_iqd - s.paid_iqd; holds.set(reason, h);
    }
  }
  return {
    roles,
    earned_iqd: summary.staff_iqd, paid_iqd: summary.staff_paid_iqd, available_iqd: summary.staff_available_iqd, reserved_iqd: summary.staff_held_iqd,
    held_iqd: summary.staff_pending_settlement_reserve_iqd, debt_iqd: summary.staff_debt_iqd, balance_iqd: summary.staff_net_iqd,
    pending_costs: sources.filter((s) => s.kind === 'staff' && (s.state === 'pending_cost' || s.pending_cost)).length,
    holds: sortReasons(holds.keys()).map((r) => holds.get(r)!),
  };
}

function combine(investor: PersonFinance['investor'], work: PersonFinance['work']): PersonFinance['combined'] {
  return {
    earned_iqd: (work?.earned_iqd ?? 0) + (investor?.profit.earned_iqd ?? 0),
    paid_iqd: (work?.paid_iqd ?? 0) + (investor?.profit.paid_iqd ?? 0),
    available_iqd: (work?.available_iqd ?? 0) + (investor?.profit.available_iqd ?? 0) + (investor?.capital.available_iqd ?? 0),
    held_iqd: (work?.held_iqd ?? 0) + (investor?.profit.held_iqd ?? 0) + (investor?.capital.sold_held_iqd ?? 0),
  };
}

type WageReport = Awaited<ReturnType<typeof staffPeriodReport>>;

/** One account's picture. `owner` adds order ids, purchase labels and pause history. */
export async function personFinance(db: D1Database, userId: string, opts: { owner?: boolean; name?: string; range?: FinanceRange; wages?: WageReport; sources?: ParticipantSource[]; advance?: { balance: number } } = {}): Promise<PersonFinance> {
  const owner = opts.owner === true;
  const [sources, advance, user, staffRows] = await Promise.all([
    opts.sources ?? participantSources(db, userId), opts.advance ?? participantAdvanceState(db, userId),
    opts.name === undefined ? db.prepare('SELECT name,email FROM users WHERE id=?').bind(userId).first<{ name: string | null; email: string }>() : Promise.resolve(null),
    db.prepare('SELECT id,name,role,user_id,active,start_work_date,archived_at,inactive_periods_json FROM finance_staff WHERE user_id=? ORDER BY archived_at IS NOT NULL,id').bind(userId).all<StaffRow>().then((r) => r.results ?? []),
  ]);
  const summary = participantSummary(sources, advance.balance);
  const budgets = participantWithdrawableSources(sources, advance.balance);
  const investor = await investorPart(db, userId, sources, budgets, summary, owner);
  const work = await workPart(db, staffRows, sources, summary);
  if (work && !owner) for (const role of work.roles) role.pauses = [];
  const person: PersonFinance = { user_id: userId, name: opts.name ?? (user?.name || user?.email || ''), investor, work, combined: combine(investor, work) };
  if (opts.range) person.period = await periodFor(db, userId, staffRows.map((s) => s.id), opts.range, opts.wages);
  return person;
}

/** A staff member with no linked account: work only (the owner's list). */
export async function unlinkedStaffFinance(db: D1Database, staff: StaffRow, range?: FinanceRange, wages?: WageReport): Promise<PersonFinance & { staff_id: string }> {
  const [sources, advance] = await Promise.all([participantSources(db, staff.id, 'staff'), participantAdvanceState(db, staff.id, 'staff')]);
  const summary = participantSummary(sources, advance.balance);
  const work = await workPart(db, [staff], sources, summary);
  const person = { user_id: null, staff_id: staff.id, name: staff.name, investor: null, work, combined: combine(null, work) } as PersonFinance & { staff_id: string };
  if (range) person.period = await periodFor(db, null, [staff.id], range, wages);
  return person;
}

async function periodFor(db: D1Database, userId: string | null, staffIds: string[], range: FinanceRange, report?: WageReport) {
  const wages = report ?? await staffPeriodReport(db, range);
  const profit = userId && await tableExists(db, 'investment_contracts')
    ? (await db.prepare(`SELECT COALESCE(SUM(r.profit_iqd),0) AS n FROM (${investorReportedAllocationsSql}) r WHERE r.user_id=? AND ${inFinanceRangeSql('r.earning_day')}`).bind(userId, ...financeRangeArgs(range)).first<{ n: number }>())?.n ?? 0
    : 0;
  return { wages_iqd: staffIds.reduce((n, id) => n + (wages.get(id)?.earned_iqd ?? 0), 0), profit_iqd: profit };
}

/** Every person the owner pays: investors, linked staff, then unlinked staff. */
export async function peopleFinance(db: D1Database, range?: FinanceRange) {
  const sources: string[] = ['SELECT user_id AS id FROM finance_staff WHERE user_id IS NOT NULL'];
  if (await tableExists(db, 'investment_contracts')) sources.push('SELECT user_id FROM investment_contracts');
  if (await tableExists(db, 'investment_profiles')) sources.push('SELECT user_id FROM investment_profiles');
  const users = (await db.prepare(`SELECT u.id,COALESCE(NULLIF(u.name,''),u.email) AS name FROM users u WHERE u.id IN (${sources.join(' UNION ')}) ORDER BY u.name,u.id`).all<{ id: string; name: string }>()).results ?? [];
  const wages = range ? await staffPeriodReport(db, range) : undefined;
  const people: Array<PersonFinance & { staff_id?: string }> = [];
  for (const u of users) people.push(await personFinance(db, u.id, { owner: true, name: u.name, range, wages }));
  const unlinked = (await db.prepare('SELECT id,name,role,user_id,active,start_work_date,archived_at,inactive_periods_json FROM finance_staff WHERE user_id IS NULL ORDER BY archived_at IS NOT NULL,name,id').all<StaffRow>()).results ?? [];
  for (const s of unlinked) people.push(await unlinkedStaffFinance(db, s, range, wages));
  const rank = (p: PersonFinance) => p.investor && p.investor.state !== 'archived' ? 0 : p.work?.roles.some((r) => r.status !== 'archived') ? 1 : 2;
  return people.sort((a, b) => rank(a) - rank(b));
}
