import { participantAdvanceState, participantSources, participantSummary, participantWithdrawableSources, type ParticipantSource } from './financeParticipants';
import { inactiveAt, type EmploymentInterval } from './financeEmploymentIntervals';
import { PENDING_SURPLUS_SQL, SURPLUS_PREFIX, surplusInstalled } from './investorSurplus';
import { investorReportedAllocationsSql } from './investorCapitalReporting';
import { staffPeriodReport } from './financeParticipantReports';
import { financeRangeArgs, inFinanceRangeSql, type FinanceRange } from './financeRange';
import { remainingAllocationQtySql } from './inventoryAllocationQuantity';

/**
 * ONE PERSON, ONE PICTURE (owner request 2026-11-09: «he doesnot show his
 * invest his return his ratio or what he earn from invest and work»;
 * DECISIONS row 304).
 *
 * The owner's people screens and the person's own «أرباحي» read this one
 * summary, so both show the same numbers. It is read-only, and every amount
 * comes from the ledgers that already pay people (participantSources and the
 * withdrawal budgets) — never a second calculation of money:
 *   - held = earned − paid − reserved for a withdrawal − available, per
 *     ledger, so money already paid can never read as held;
 *   - capital put in = still in goods + sold and waiting + returned + loss,
 *     where «still in goods» is the remainder: the bar always adds up, and
 *     units on confirmed but undelivered orders are counted, not lost;
 *   - the combined «what he earned» is wages + investment profit; capital is
 *     the person's own money and stays in its own block.
 * The person's own view gets no order ids, purchase labels or pause history,
 * and no amount per sale or per reason (one held sale would otherwise show one
 * order's margin; DECISIONS row 220) — only counts and totals that the old
 * page already showed.
 */
/**
 * Why money is not withdrawable yet:
 *   cost          the sale's cost of goods is not complete (or its investor split waits on it)
 *   cancelled     the order is no longer delivered (cancelled or returned after delivery)
 *   recalculation the system is still recalculating (a wage job, a stale projection, a posting retry)
 *   funding       the agreement's capital is not fully received yet
 *   collection    delivered, but the courier cash is not recorded as collected
 *   agreement     the sale is settled, but its agreement's capital shares losses and waits
 *                 as a whole for another unresolved sale (the one whole hold left, DECISIONS row 305)
 */
export type HoldReason = 'collection' | 'cost' | 'recalculation' | 'cancelled' | 'funding' | 'agreement';
const REASON_ORDER: HoldReason[] = ['cost', 'cancelled', 'recalculation', 'funding', 'collection', 'agreement'];
const sortReasons = (reasons: Iterable<HoldReason>) => [...new Set(reasons)].sort((a, b) => REASON_ORDER.indexOf(a) - REASON_ORDER.indexOf(b));
/** Owner view: at most this many held sales are listed per agreement; the rest are counted. */
const HELD_SALES_LISTED = 30;

/** A held sale (owner view only). Amounts are this sale's share of what is still unpaid. */
export interface HeldSale { order_id: string; day: string | null; reasons: HoldReason[]; profit_iqd: number; capital_iqd: number; profit_unknown: boolean }
/** Settled sales of one agreement that wait as a group (another sale, funding, a recalculation).
 * Not counted: which of them a past payout covered is not knowable per sale. */
export interface HeldRest { reason: HoldReason; profit_iqd?: number; capital_iqd?: number }

export interface AgreementFinance {
  id: string; name: string; product_name: string | null; product_name_ar: string | null; label: string | null; created_at: string;
  principal_iqd: number; funded_iqd: number; profit_share_bps: number; loss_share_bps: number;
  units: { ordered: number; received: number; in_stock: number; in_orders: number; sold: number };
  capital: { back_from_sales_iqd: number; available_iqd: number; reserved_iqd: number; paid_iqd: number; held_iqd: number; loss_iqd: number;
    /** Principal not recovered on sales below cost, beyond the loss share the investor bears. */
    not_recovered_iqd: number };
  profit: { earned_iqd: number; available_iqd: number; reserved_iqd: number; paid_iqd: number; held_iqd: number; sales: number; sales_unknown: number };
  /** A loss-sharing agreement's capital waits as a whole for an unresolved sale (DECISIONS row 305). */
  held_whole: boolean;
  /** Owner view only (empty for the person). */
  held_sales: HeldSale[];
  held_sales_more: number;
  held_rest: HeldRest | null;
}

export interface PersonWork {
  staff_id: string; name: string; role: string; status: 'active' | 'paused' | 'archived'; start_work_date: string | null;
  /** Current pause start (ISO), when paused. */
  paused_from: string | null;
  /** Scheduled resumption (ISO) of the current pause, if any. */
  resumes_at: string | null;
  /** When work last resumed after a pause (ISO), while active. */
  working_since: string | null;
  /** Owner view only (empty for the person). */
  pauses: EmploymentInterval[];
}

export type HoldSummary = { reason: HoldReason; sales: number; profit_iqd?: number; capital_iqd?: number; profit_unknown: number };
export type WageHold = { reason: HoldReason; entries: number; amount_iqd?: number };

export interface PersonFinance {
  user_id: string | null;
  name: string;
  investor: null | {
    state: string;
    default_profit_share_bps: number | null;
    capital: {
      agreed_iqd: number; put_in_iqd: number; in_agreements_iqd: number;
      /** Still in goods: on the shelf, on confirmed orders not delivered yet, or not received yet. */
      in_goods_iqd: number;
      /** Recovered from sales, not withdrawable yet. */
      sold_held_iqd: number;
      /** «Still at work» as the owner asked: in goods + sold and waiting. */
      at_work_iqd: number;
      /** Back in the account: withdrawable now, reserved for a withdrawal, or paid. */
      returned_iqd: number; available_iqd: number; reserved_iqd: number; paid_iqd: number;
      /** Capital paid beyond what is now recovered (a paid sale later refunded): owed back. */
      debt_iqd: number;
      /** Principal not recovered on sales below cost, beyond the investor's loss share. */
      not_recovered_iqd: number;
      unused_returned_iqd: number; awaiting_rest_of_funding_iqd: number; loss_iqd: number;
    };
    profit: { earned_iqd: number; available_iqd: number; reserved_iqd: number; paid_iqd: number; held_iqd: number; debt_iqd: number };
    share: { agreements_bps: number[]; min_bps: number | null; max_bps: number | null; earned_bps: number | null };
    /** Profit earned so far ÷ capital put in, in basis points. */
    roi_bps: number | null;
    units: { ordered: number; received: number; in_stock: number; in_orders: number; sold: number };
    agreements: AgreementFinance[];
    /** Owner: counts and amounts; the person: counts only. */
    holds: HoldSummary[];
  };
  work: null | {
    roles: PersonWork[];
    earned_iqd: number; paid_iqd: number; available_iqd: number; reserved_iqd: number; held_iqd: number; debt_iqd: number; balance_iqd: number;
    pending_costs: number;
    /** Owner: counts and amounts; the person: counts only. */
    holds: WageHold[];
  };
  /** Earnings only (wages + investment profit). Capital is in `investor.capital`. */
  combined: { earned_iqd: number; paid_iqd: number; reserved_iqd: number; held_iqd: number; available_earnings_iqd: number; available_capital_iqd: number; available_iqd: number };
  period?: { wages_iqd: number; profit_iqd: number };
}

const tableExists = async (db: D1Database, name: string) => !!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").bind(name).first();
const sum = <T>(list: T[], f: (x: T) => number) => list.reduce((n, x) => n + f(x), 0);
const unpaid = (earned: number, paid: number, reserved: number, available: number) => Math.max(0, earned - paid - reserved - available);

/** Work status from the saved pause intervals, as the payroll reads them. */
export function workStatus(staff: { archived_at: string | null; active: number; inactive_periods_json: string; start_work_date: string | null }, now = Date.now()) {
  const pauses = JSON.parse(staff.inactive_periods_json || '[]') as EmploymentInterval[];
  const current = pauses.find((p) => inactiveAt([p], now)) ?? null;
  const status: PersonWork['status'] = staff.archived_at ? 'archived' : pauses.length ? (current ? 'paused' : 'active') : staff.active ? 'active' : 'paused';
  const lastResume = pauses.filter((p) => p.to && Date.parse(p.to) <= now).map((p) => p.to!).sort().at(-1) ?? null;
  return { status, paused_from: status === 'active' ? null : current?.from ?? null, resumes_at: status === 'paused' ? current?.to ?? null : null, working_since: status === 'active' ? lastResume : null, pauses };
}

type Contract = { id: string; name: string; incoming_id: string; principal_iqd: number; profit_share_bps: number; loss_share_bps: number; created_at: string; qty_ordered: number; qty_received: number; product_name: string | null; product_name_ar: string | null; label: string | null; funded_iqd: number; in_stock: number; loss_iqd: number };
type SaleRow = { contract_id: string; order_id: string; status: string; day: string | null; profit: number; capital: number; pending: number; eligible: number; collected: number; cost_error: number; other_error: number };
type Totals = { contract_id: string; sales: number; sales_unknown: number; sold: number; basis: number; earned_known: number; shortfall: number; sale_loss: number };

/** Spread `total` over `items` in order, each up to its own amount. */
function spread<T>(items: T[], own: (x: T) => number, total: number) {
  let left = Math.max(0, total);
  return items.map((x) => { const take = Math.min(Math.max(0, own(x)), left); left -= take; return take; });
}

async function investorPart(db: D1Database, userId: string, sources: ParticipantSource[], budgets: Map<string, number>, summary: ReturnType<typeof participantSummary>, owner: boolean): Promise<PersonFinance['investor']> {
  if (!await tableExists(db, 'investment_contracts')) return null;
  const profile = await tableExists(db, 'investment_profiles') ? await db.prepare('SELECT state,default_profit_share_bps FROM investment_profiles WHERE user_id=?').bind(userId).first<{ state: string; default_profit_share_bps: number }>() : null;
  const contracts = (await db.prepare(`SELECT c.id,c.name,c.incoming_id,c.principal_iqd,c.profit_share_bps,c.loss_share_bps,c.created_at,
      i.qty_ordered,i.qty_received,p.name AS product_name,p.name_ar AS product_name_ar,(SELECT pl.label FROM purchase_lines pl WHERE pl.incoming_id=i.id LIMIT 1) AS label,
      COALESCE((SELECT SUM(e.amount_iqd) FROM investor_finance_events e WHERE e.contract_id=c.id AND e.kind='funding'),0) AS funded_iqd,
      COALESCE((SELECT SUM(l.qty_remaining) FROM inventory_lots l WHERE l.incoming_id=i.id),0) AS in_stock,
      COALESCE((SELECT amount_iqd FROM investor_capital_losses x WHERE x.contract_id=c.id),0) AS loss_iqd
    FROM investment_contracts c JOIN incoming_inventory i ON i.id=c.incoming_id LEFT JOIN products p ON p.id=i.product_id
    WHERE c.user_id=? AND c.state='active' ORDER BY c.created_at,c.id`).bind(userId).all<Contract>()).results ?? [];
  const surplusRows = sources.filter((s) => s.kind === 'investor_capital' && s.id.startsWith(SURPLUS_PREFIX));
  if (!profile && !contracts.length && !surplusRows.length) return null;

  // Three grouped reads for every agreement at once, never one per sale.
  const [totals, saleRows, inOrders] = contracts.length ? await Promise.all([
    db.prepare(`SELECT r.contract_id,COUNT(DISTINCT a.order_id) AS sales,COUNT(DISTINCT CASE WHEN r.pending=1 THEN a.order_id END) AS sales_unknown,
        COALESCE(SUM(MAX(0,COALESCE(json_extract(r.snapshot,'$.qty'),0))),0) AS sold,
        COALESCE(SUM(CASE WHEN r.pending=1 THEN 0 ELSE MAX(0,COALESCE(json_extract(r.snapshot,'$.profit'),0)) END),0) AS basis,
        COALESCE(SUM(CASE WHEN r.pending=1 THEN 0 ELSE r.profit_iqd END),0) AS earned_known,
        -- Principal a settled sale did not bring back (sold below cost): its
        -- assigned principal less what it recovered (investorOrderSplit's rule).
        COALESCE(SUM(CASE WHEN r.pending=1 THEN 0 ELSE MAX(0,COALESCE(lc.unit_principal_iqd*COALESCE(json_extract(r.snapshot,'$.qty'),0),
          CAST(COALESCE(json_extract(r.snapshot,'$.cost'),0)*c.capital_share_bps/10000 AS INTEGER))-r.capital_iqd) END),0) AS shortfall,
        COALESCE(SUM(r.loss_iqd),0) AS sale_loss
      FROM investor_allocation_results r JOIN investment_contracts c ON c.id=r.contract_id JOIN order_item_inventory_allocations a ON a.id=r.allocation_id
      LEFT JOIN purchase_investor_lot_capital lc ON lc.lot_id=a.lot_id AND lc.contract_id=r.contract_id
      WHERE c.user_id=? AND c.state='active' GROUP BY r.contract_id`).bind(userId).all<Totals>().then((r) => r.results ?? []),
    // Only sales with a reason of their own: pending, not collected, not delivered, or a posting error.
    db.prepare(`SELECT r.contract_id,a.order_id,o.status,date(o.delivered_at,'+3 hours') AS day,
        SUM(CASE WHEN r.pending=1 THEN 0 ELSE r.profit_iqd END) AS profit,SUM(r.capital_iqd) AS capital,MAX(r.pending) AS pending,MIN(r.eligible) AS eligible,
        (SELECT COALESCE(SUM(fc.amount_iqd),0) FROM finance_collections fc WHERE fc.order_id=a.order_id)>=MAX(0,COALESCE(o.due_on_delivery_iqd,0)+COALESCE(o.gini_paid_iqd,0)
          -(SELECT COALESCE(SUM(rf.refund_iqd),0) FROM finance_refund_facts rf WHERE rf.order_id=a.order_id AND rf.channel='gini')) AS collected,
        EXISTS(SELECT 1 FROM finance_posting_errors pe WHERE pe.order_id=a.order_id AND (pe.event_key LIKE 'cogs:%' OR pe.event_key LIKE 'investor-pending:%')) AS cost_error,
        EXISTS(SELECT 1 FROM finance_posting_errors pe WHERE pe.order_id=a.order_id AND pe.event_key NOT LIKE 'cogs:%' AND pe.event_key NOT LIKE 'investor-pending:%') AS other_error
      FROM investor_allocation_results r JOIN investment_contracts c ON c.id=r.contract_id
      JOIN order_item_inventory_allocations a ON a.id=r.allocation_id JOIN orders o ON o.id=a.order_id
      WHERE c.user_id=? AND c.state='active' AND (r.pending=1 OR r.eligible=0 OR o.status<>'delivered' OR EXISTS(SELECT 1 FROM finance_posting_errors pe WHERE pe.order_id=a.order_id))
      GROUP BY r.contract_id,a.order_id ORDER BY o.delivered_at,a.order_id LIMIT 2000`).bind(userId).all<SaleRow>().then((r) => r.results ?? []),
    // Units on confirmed orders not delivered yet: off the shelf, not yet a sale.
    // A cancellation restocks through a separate release row, so count what is
    // still on the order, never the original allocation.
    db.prepare(`SELECT c.id AS contract_id,COALESCE(SUM(${remainingAllocationQtySql('a')}),0) AS qty FROM investment_contracts c JOIN inventory_lots l ON l.incoming_id=c.incoming_id
      JOIN order_item_inventory_allocations a ON a.lot_id=l.id JOIN orders o ON o.id=a.order_id
      WHERE c.user_id=? AND c.state='active' AND a.released_at IS NULL AND o.status NOT IN ('delivered','cancelled')
        AND NOT EXISTS(SELECT 1 FROM investor_allocation_results r WHERE r.allocation_id=a.id AND r.contract_id=c.id) GROUP BY c.id`).bind(userId).all<{ contract_id: string; qty: number }>().then((r) => r.results ?? []),
  ]) : [[], [], []] as [Totals[], SaleRow[], { contract_id: string; qty: number }[]];
  // The person's real held totals come from the ledgers, which net one
  // agreement's overpayment against another's money; each agreement's row
  // takes its share of them in order, so no row shows more than the card.
  const capitalLedger = summary.ledgers.investor_capital, profitLedger = summary.ledgers.investor_profit;
  const profitHeld = unpaid(summary.investor_profit_iqd, profitLedger.paid_iqd, profitLedger.held_iqd, profitLedger.available_iqd);
  const capitalHeld = unpaid(summary.capital_iqd, capitalLedger.paid_iqd, capitalLedger.held_iqd, capitalLedger.available_iqd);
  let profitLeft = profitHeld, capitalLeft = capitalHeld;

  const agreements: AgreementFinance[] = [];
  /** Every held sale with its share of the unpaid amount, before the owner list is capped. */
  const listedBy = new Map<string, HeldSale[]>();
  for (const c of contracts) {
    const t = totals.find((x) => x.contract_id === c.id) ?? { sales: 0, sales_unknown: 0, sold: 0, basis: 0, earned_known: 0, shortfall: 0, sale_loss: 0 };
    const profitSource = sources.find((s) => s.id === `invprofit:${c.id}`), capitalSource = sources.find((s) => s.id === `invcapital:${c.id}`);
    const money = (s: ParticipantSource | undefined, id: string, left: number) => {
      const earned = s?.accrued_iqd ?? 0, paid = s?.paid_iqd ?? 0, reserved = s?.held_iqd ?? 0, available = budgets.get(id) ?? 0;
      return { earned, paid, reserved, available, held: Math.min(left, unpaid(earned, paid, reserved, available)) };
    };
    const profit = money(profitSource, `invprofit:${c.id}`, profitLeft), capital = money(capitalSource, `invcapital:${c.id}`, capitalLeft);
    profitLeft -= profit.held; capitalLeft -= capital.held;
    const own = saleRows.filter((r) => r.contract_id === c.id).map((r) => {
      const reasons: HoldReason[] = [];
      if (r.status !== 'delivered') reasons.push('cancelled');
      if (r.pending === 1 || r.cost_error) reasons.push('cost');
      if (r.other_error) reasons.push('recalculation');
      if (!r.collected) reasons.push('collection');
      return { ...r, reasons: sortReasons(reasons) };
    }).filter((r) => r.reasons.length > 0);
    // The money each listed sale still holds is its share of the agreement's
    // unpaid amount — never more, so a payout already made is not held twice.
    // Sales that were never withdrawable (pending, cash not collected) cannot
    // have been paid: they take their share first, then the others in order.
    const order = own.map((r, i) => i).sort((x, y) => (own[x].eligible === 0 ? 0 : 1) - (own[y].eligible === 0 ? 0 : 1) || x - y);
    const ownProfit: number[] = [], ownCapital: number[] = [];
    spread(order, (i) => own[i].profit, profit.held).forEach((n, k) => { ownProfit[order[k]] = n; });
    spread(order, (i) => own[i].capital, capital.held).forEach((n, k) => { ownCapital[order[k]] = n; });
    const restProfit = profit.held - sum(ownProfit, (n) => n), restCapital = capital.held - sum(ownCapital, (n) => n);
    // One unresolved sale holds only itself (DECISIONS row 305). The one whole
    // hold left: a loss-sharing contract's capital, while any sale is unresolved.
    const unresolved = own.some((r) => r.reasons.some((x) => x === 'cost' || x === 'cancelled' || x === 'recalculation'));
    const heldWhole = !!capitalSource?.blocked && c.loss_share_bps > 0 && unresolved && capital.held > 0;
    // Settled sales still waiting as a group: unfunded agreement, the
    // loss-sharing capital hold, or else a sale being redone (a stale
    // projection or a wage job, which no sale row names).
    const restReason: HoldReason | null = restProfit > 0 || restCapital > 0
      ? (c.funded_iqd < c.principal_iqd ? 'funding' : heldWhole ? 'agreement' : 'recalculation') : null;
    const listed = own.map((r, i) => ({ order_id: r.order_id, day: r.day, reasons: r.reasons, profit_iqd: ownProfit[i], capital_iqd: ownCapital[i], profit_unknown: r.pending === 1 }))
      .filter((h) => h.profit_iqd > 0 || h.capital_iqd > 0 || h.profit_unknown || h.reasons.includes('cancelled'));
    agreements.push({
      id: c.id, name: c.name, product_name: c.product_name, product_name_ar: c.product_name_ar, label: owner ? c.label : null, created_at: c.created_at,
      principal_iqd: c.principal_iqd, funded_iqd: c.funded_iqd, profit_share_bps: c.profit_share_bps, loss_share_bps: c.loss_share_bps,
      units: { ordered: c.qty_ordered, received: c.qty_received, in_stock: c.in_stock, in_orders: inOrders.find((x) => x.contract_id === c.id)?.qty ?? 0, sold: t.sold },
      capital: { back_from_sales_iqd: capital.earned, available_iqd: capital.available, reserved_iqd: capital.reserved, paid_iqd: capital.paid, held_iqd: capital.held, loss_iqd: c.loss_iqd,
        // A physical write-off is part of the loss account too; only the loss the sales themselves carried offsets their shortfall.
        not_recovered_iqd: Math.max(0, t.shortfall - Math.min(c.loss_iqd, t.sale_loss)) },
      profit: { earned_iqd: profit.earned, available_iqd: profit.available, reserved_iqd: profit.reserved, paid_iqd: profit.paid, held_iqd: profit.held, sales: t.sales, sales_unknown: t.sales_unknown },
      held_whole: heldWhole,
      held_sales: owner ? listed.slice(0, HELD_SALES_LISTED) : [],
      held_sales_more: owner ? Math.max(0, listed.length - HELD_SALES_LISTED) : 0,
      held_rest: restReason && (restProfit > 0 || restCapital > 0) ? { reason: restReason, ...(owner ? { profit_iqd: restProfit, capital_iqd: restCapital } : {}) } : null,
    });
    listedBy.set(c.id, listed);
  }

  const purchases = await surplusInstalled(db) && await tableExists(db, 'purchase_investor_allocations');
  const funds = await db.prepare(`SELECT
      COALESCE((SELECT SUM(e.amount_iqd) FROM investor_finance_events e JOIN investment_contracts c ON c.id=e.contract_id WHERE c.user_id=?1 AND e.kind='funding'),0) AS funded,
      COALESCE((SELECT SUM(principal_iqd) FROM investment_contracts c WHERE c.user_id=?1 AND c.state='active'${purchases ? ' AND NOT EXISTS(SELECT 1 FROM purchase_investor_allocations a WHERE a.contract_id=c.id)' : ''}),0) AS direct_agreed,
      ${purchases ? 'COALESCE((SELECT SUM(agreed_iqd) FROM purchase_investor_agreements WHERE user_id=?1),0)' : '0'} AS purchase_agreed`).bind(userId).first<{ funded: number; direct_agreed: number; purchase_agreed: number }>();
  const unused = sum(surplusRows, (s) => s.accrued_iqd);
  const awaitingRest = await surplusInstalled(db) ? (await db.prepare(PENDING_SURPLUS_SQL).bind(userId).first<{ n: number }>())?.n ?? 0 : 0;
  const putIn = (funds?.funded ?? 0) + unused;
  const soldHeld = capitalHeld;
  const returned = capitalLedger.available_iqd + capitalLedger.held_iqd + capitalLedger.paid_iqd;
  // Capital paid beyond what is now recovered (a paid sale refunded later) is
  // owed back (the ledger's own netting): «returned» less this debt is what
  // came back, and the goods never depend on payouts at all.
  const debt = capitalLedger.debt_iqd;
  const loss = sum(contracts, (c) => c.loss_iqd);
  const notRecovered = sum(agreements, (a) => a.capital.not_recovered_iqd);
  // Still in goods = what was put in less what came back (capital accrued,
  // with the unused remainder), less losses and principal no sale recovered.
  const inGoods = Math.max(0, putIn - summary.capital_iqd - loss - notRecovered);
  const earned = summary.investor_profit_iqd;
  const earnedKnown = sum(totals, (t) => t.earned_known), basis = sum(totals, (t) => t.basis);
  const shares = [...new Set(contracts.map((c) => c.profit_share_bps))].sort((a, b) => a - b);
  const holds = new Map<HoldReason, HoldSummary>();
  const add = (reason: HoldReason, sales: number, profit: number, capital: number, unknown: number) => {
    const h = holds.get(reason) ?? { reason, sales: 0, profit_iqd: 0, capital_iqd: 0, profit_unknown: 0 };
    h.sales += sales; h.profit_iqd! += profit; h.capital_iqd! += capital; h.profit_unknown += unknown; holds.set(reason, h);
  };
  for (const a of agreements) {
    const listed = listedBy.get(a.id) ?? [];
    for (const h of listed) add(h.reasons[0], 1, h.profit_iqd, h.capital_iqd, h.profit_unknown ? 1 : 0);
    if (a.held_rest) add(a.held_rest.reason, 0, a.profit.held_iqd - sum(listed, (h) => h.profit_iqd), a.capital.held_iqd - sum(listed, (h) => h.capital_iqd), 0);
  }
  // The reasons never add up to more than the person's real totals.
  const holdList = sortReasons(holds.keys()).map((r) => holds.get(r)!);
  spread(holdList, (h) => h.profit_iqd!, profitHeld).forEach((n, i) => { holdList[i].profit_iqd = n; });
  spread(holdList, (h) => h.capital_iqd!, soldHeld).forEach((n, i) => { holdList[i].capital_iqd = n; });
  const shownHolds = holdList.filter((h) => h.sales > 0 || h.profit_iqd! > 0 || h.capital_iqd! > 0 || h.profit_unknown > 0);
  return {
    state: profile?.state ?? 'active',
    default_profit_share_bps: profile?.default_profit_share_bps ?? null,
    capital: {
      agreed_iqd: (funds?.direct_agreed ?? 0) + (funds?.purchase_agreed ?? 0), put_in_iqd: putIn, in_agreements_iqd: sum(contracts, (c) => c.principal_iqd),
      in_goods_iqd: inGoods, sold_held_iqd: soldHeld, at_work_iqd: inGoods + soldHeld,
      returned_iqd: returned, available_iqd: capitalLedger.available_iqd, reserved_iqd: capitalLedger.held_iqd, paid_iqd: capitalLedger.paid_iqd,
      debt_iqd: debt, not_recovered_iqd: notRecovered,
      unused_returned_iqd: unused, awaiting_rest_of_funding_iqd: awaitingRest, loss_iqd: loss,
    },
    profit: { earned_iqd: earned, available_iqd: profitLedger.available_iqd, reserved_iqd: profitLedger.held_iqd, paid_iqd: profitLedger.paid_iqd,
      held_iqd: profitHeld, debt_iqd: profitLedger.debt_iqd },
    share: { agreements_bps: shares, min_bps: shares[0] ?? null, max_bps: shares.at(-1) ?? null, earned_bps: basis > 0 ? Math.round(earnedKnown * 10000 / basis) : null },
    roi_bps: putIn > 0 ? Math.floor(earned * 10000 / putIn) : null,
    units: { ordered: sum(agreements, (a) => a.units.ordered), received: sum(agreements, (a) => a.units.received), in_stock: sum(agreements, (a) => a.units.in_stock), in_orders: sum(agreements, (a) => a.units.in_orders), sold: sum(agreements, (a) => a.units.sold) },
    agreements,
    holds: shownHolds.map((h) => owner ? h : { reason: h.reason, sales: h.sales, profit_unknown: h.profit_unknown }),
  };
}

type StaffRow = { id: string; name: string; role: string; user_id: string | null; active: number; start_work_date: string | null; archived_at: string | null; inactive_periods_json: string };

async function workPart(db: D1Database, staffRows: StaffRow[], sources: ParticipantSource[], summary: ReturnType<typeof participantSummary>, owner: boolean): Promise<PersonFinance['work']> {
  if (!staffRows.length) return null;
  const roles = staffRows.map((s) => ({ staff_id: s.id, name: s.name, role: s.role, start_work_date: s.start_work_date, ...workStatus(s) })).map((r) => owner ? r : { ...r, pauses: [] });
  const earned = summary.staff_iqd, paid = summary.staff_paid_iqd, reserved = summary.staff_held_iqd, available = summary.staff_available_iqd;
  const held = unpaid(earned, paid, reserved, available);
  const blocked = sources.filter((s) => s.kind === 'staff' && s.blocked && s.accrued_iqd - s.paid_iqd > 0);
  const raw = new Map<HoldReason, { entries: number; amount: number }>();
  if (blocked.length && held > 0) {
    const rows = (await db.prepare(`SELECT c.id,o.status,
        EXISTS(SELECT 1 FROM finance_wage_targets wt WHERE wt.cost_id=c.id AND wt.amount_iqd IS NULL) AS pending_cost,
        EXISTS(SELECT 1 FROM finance_staff_reconciliations j WHERE j.staff_id=c.staff_id AND j.state<>'complete') AS job,
        EXISTS(SELECT 1 FROM finance_posting_errors pe WHERE pe.order_id=c.order_id) AS posting
      FROM finance_order_costs c JOIN orders o ON o.id=c.order_id WHERE c.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(blocked.map((s) => s.id))).all<{ id: string; status: string; pending_cost: number; job: number; posting: number }>()).results ?? [];
    for (const s of blocked) {
      const r = rows.find((x) => x.id === s.id);
      const reason: HoldReason = !r ? 'recalculation' : r.status !== 'delivered' ? 'cancelled' : r.job ? 'recalculation' : r.pending_cost || r.posting ? 'cost' : 'recalculation';
      const x = raw.get(reason) ?? { entries: 0, amount: 0 };
      x.entries++; x.amount += s.accrued_iqd - s.paid_iqd; raw.set(reason, x);
    }
  }
  // What is held is the ledger's unpaid remainder, spread over the reasons in order.
  const order = sortReasons(raw.keys());
  const takes = spread(order, (r) => raw.get(r)!.amount, held);
  const holds: WageHold[] = order.map((reason, i) => ({ reason, entries: raw.get(reason)!.entries, amount_iqd: takes[i] })).filter((h) => h.amount_iqd! > 0);
  const explained = sum(holds, (h) => h.amount_iqd!);
  if (held > explained) {
    const other = holds.find((h) => h.reason === 'recalculation');
    if (other) other.amount_iqd! += held - explained; else holds.push({ reason: 'recalculation', entries: 0, amount_iqd: held - explained });
  }
  return {
    roles,
    earned_iqd: earned, paid_iqd: paid, available_iqd: available, reserved_iqd: reserved, held_iqd: held, debt_iqd: summary.staff_debt_iqd, balance_iqd: summary.staff_net_iqd,
    pending_costs: sources.filter((s) => s.kind === 'staff' && (s.state === 'pending_cost' || s.pending_cost)).length,
    holds: owner ? holds : holds.map((h) => ({ reason: h.reason, entries: h.entries })),
  };
}

function combine(investor: PersonFinance['investor'], work: PersonFinance['work']): PersonFinance['combined'] {
  const earnings = (work?.available_iqd ?? 0) + (investor?.profit.available_iqd ?? 0), capital = investor?.capital.available_iqd ?? 0;
  return {
    earned_iqd: (work?.earned_iqd ?? 0) + (investor?.profit.earned_iqd ?? 0),
    paid_iqd: (work?.paid_iqd ?? 0) + (investor?.profit.paid_iqd ?? 0),
    reserved_iqd: (work?.reserved_iqd ?? 0) + (investor?.profit.reserved_iqd ?? 0),
    held_iqd: (work?.held_iqd ?? 0) + (investor?.profit.held_iqd ?? 0),
    available_earnings_iqd: earnings, available_capital_iqd: capital, available_iqd: earnings + capital,
  };
}

type WageReport = Awaited<ReturnType<typeof staffPeriodReport>>;

/** One account's picture. `owner` adds order ids, amounts per sale and reason, purchase labels and pause history. */
export async function personFinance(db: D1Database, userId: string, opts: { owner?: boolean; name?: string; range?: FinanceRange; wages?: WageReport; profitByUser?: Map<string, number>; sources?: ParticipantSource[]; advance?: { balance: number } } = {}): Promise<PersonFinance> {
  const owner = opts.owner === true;
  const [sources, advance, user, staffRows] = await Promise.all([
    opts.sources ?? participantSources(db, userId), opts.advance ?? participantAdvanceState(db, userId),
    opts.name === undefined ? db.prepare('SELECT name,email FROM users WHERE id=?').bind(userId).first<{ name: string | null; email: string }>() : Promise.resolve(null),
    db.prepare('SELECT id,name,role,user_id,active,start_work_date,archived_at,inactive_periods_json FROM finance_staff WHERE user_id=? ORDER BY archived_at IS NOT NULL,id').bind(userId).all<StaffRow>().then((r) => r.results ?? []),
  ]);
  const summary = participantSummary(sources, advance.balance);
  const budgets = participantWithdrawableSources(sources, advance.balance);
  const investor = await investorPart(db, userId, sources, budgets, summary, owner);
  const work = await workPart(db, staffRows, sources, summary, owner);
  const person: PersonFinance = { user_id: userId, name: opts.name ?? (user?.name || user?.email || ''), investor, work, combined: combine(investor, work) };
  if (opts.range) {
    const wages = opts.wages ?? await staffPeriodReport(db, opts.range);
    const profit = opts.profitByUser ?? await periodProfit(db, opts.range);
    person.period = { wages_iqd: sum(staffRows, (s) => wages.get(s.id)?.earned_iqd ?? 0), profit_iqd: profit.get(userId) ?? 0 };
  }
  return person;
}

/** Investment profit earned in a period, by delivery day, for every investor at once. */
async function periodProfit(db: D1Database, range: FinanceRange) {
  if (!await tableExists(db, 'investment_contracts')) return new Map<string, number>();
  const rows = (await db.prepare(`SELECT r.user_id,COALESCE(SUM(r.profit_iqd),0) AS n FROM (${investorReportedAllocationsSql}) r WHERE ${inFinanceRangeSql('r.earning_day')} GROUP BY r.user_id`).bind(...financeRangeArgs(range)).all<{ user_id: string; n: number }>()).results ?? [];
  return new Map(rows.map((r) => [r.user_id, r.n]));
}

/** Every person the owner pays: investors, linked staff, then active staff with no account. */
export async function peopleFinance(db: D1Database, range?: FinanceRange) {
  const ids: string[] = ['SELECT user_id AS id FROM finance_staff WHERE user_id IS NOT NULL'];
  if (await tableExists(db, 'investment_contracts')) ids.push('SELECT user_id FROM investment_contracts');
  if (await tableExists(db, 'investment_profiles')) ids.push('SELECT user_id FROM investment_profiles');
  const users = (await db.prepare(`SELECT u.id,COALESCE(NULLIF(u.name,''),u.email) AS name FROM users u WHERE u.id IN (${ids.join(' UNION ')}) ORDER BY u.name,u.id`).all<{ id: string; name: string }>()).results ?? [];
  const [wages, profitByUser] = range ? await Promise.all([staffPeriodReport(db, range), periodProfit(db, range)]) : [undefined, undefined];
  const people: Array<PersonFinance & { staff_id?: string }> = [];
  for (const u of users) people.push(await personFinance(db, u.id, { owner: true, name: u.name, range, wages, profitByUser }));
  // A staff member with no linked account: work only. Removed ones keep their history elsewhere.
  const unlinked = (await db.prepare('SELECT id,name,role,user_id,active,start_work_date,archived_at,inactive_periods_json FROM finance_staff WHERE user_id IS NULL AND archived_at IS NULL ORDER BY name,id').all<StaffRow>()).results ?? [];
  for (const s of unlinked) {
    const [sources, advance] = await Promise.all([participantSources(db, s.id, 'staff'), participantAdvanceState(db, s.id, 'staff')]);
    const work = await workPart(db, [s], sources, participantSummary(sources, advance.balance), true);
    const person: PersonFinance & { staff_id: string } = { user_id: null, staff_id: s.id, name: s.name, investor: null, work, combined: combine(null, work) };
    if (range) person.period = { wages_iqd: wages!.get(s.id)?.earned_iqd ?? 0, profit_iqd: 0 };
    people.push(person);
  }
  const rank = (p: PersonFinance) => p.investor && p.investor.state !== 'archived' ? 0 : p.work?.roles.some((r) => r.status !== 'archived') ? 1 : 2;
  return people.sort((a, b) => rank(a) - rank(b));
}
