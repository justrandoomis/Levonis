/**
 * WAGE SETTLEMENT (owner 2026-11-10; DECISIONS row 306).
 *
 * «Hussein: 75,000 only», «Sousou: 0», «Sajjad starts from 0 on 10 Nov». The
 * owner agrees ONE amount still owed for every order an employee earned on
 * before a day (`through_day`, exclusive, Baghdad). It lands on the
 * employee's own wage rows as manual adjustments — the payable rows carry the
 * agreed amount in proportion to what each still owed, every other row keeps
 * exactly what was already paid on it — so a payout still allocates to real
 * rows, and every order's wage (and profit) moves by the same share. Rows still waiting
 * for an amount (pending_cost) are reversed: the agreement replaces whatever
 * they would have become. After it:
 *   - the period's rows are never held again (cost, recalculation, posting
 *     error): their amount is agreed, not calculated (staffSettledSql.ts);
 *   - the wage planner neither changes them nor creates new rows for orders
 *     delivered before `through_day`; later deliveries accrue as usual;
 *   - the books move by one entry: the agreed amount minus what was unpaid.
 * Settlements are immutable, one per day boundary, each after the last.
 */
import { badRequest, conflict, notFound } from './http';
import { auditStatements } from './audit';
import { newId } from './crypto';
import { allocateExact, baghdadDay, fence, journalPlan, periodOpen } from './operations';
import { readStaff } from './financeEmployment';
import { staffAdvanceSql } from './financeParticipants';
import { settledCostSql, settledThroughSql, settlementInstalled } from './staffSettledSql';

const effectiveSql = 'c.amount_iqd+COALESCE((SELECT SUM(ca.delta_iqd) FROM finance_cost_adjustments ca WHERE ca.cost_id=c.id),0)';
const paidSql = '(SELECT COALESCE(SUM(pa.amount_iqd),0) FROM finance_payment_allocations pa WHERE pa.cost_id=c.id)';
const heldSql = `(SELECT COALESCE(SUM(wa.amount_iqd-wa.paid_iqd),0) FROM finance_withdrawal_allocations wa JOIN finance_withdrawals w ON w.id=wa.withdrawal_id
  WHERE wa.source_kind='staff' AND wa.source_id=c.id AND w.state IN ('requested','approved','part_paid'))`;
const deliveredDaySql = "CASE WHEN o.status='delivered' AND o.delivered_at IS NOT NULL THEN date(o.delivered_at,'+3 hours') END";
/** The rows a settlement of staff `?` through day `?` takes: every live, unsettled row of an
 * order delivered before that day — by its delivery time, which an order keeps when it is later
 * cancelled. A wage on an order not delivered yet belongs to the work still to come and is left
 * alone. Plain `?` placeholders (staff, day): `fence` binds its own id first. */
const periodRowsSql = `SELECT c.id,c.order_id,c.state,c.cost_day,${effectiveSql} AS effective_iqd,${paidSql} AS paid_iqd,${heldSql} AS held_iqd,${deliveredDaySql} AS delivered_day
  FROM finance_order_costs c JOIN orders o ON o.id=c.order_id
  WHERE c.staff_id=? AND c.state<>'reversed' AND NOT ${settledCostSql('c.id', true)} AND o.delivered_at IS NOT NULL AND date(o.delivered_at,'+3 hours')<?`;
/** The whole period as one string: any change between the plan and the write misses the fence. */
const fingerprintSql = `(SELECT COALESCE(group_concat(x,'|'),'') FROM (SELECT id||':'||state||':'||COALESCE(effective_iqd,'n')||':'||paid_iqd||':'||held_iqd AS x FROM (${periodRowsSql}) ORDER BY id))`;

type PeriodRow = { id: string; order_id: string; state: string; cost_day: string; effective_iqd: number | null; paid_iqd: number; held_iqd: number; delivered_day: string | null };
export interface SettlementLine { id: string; before_iqd: number | null; paid_iqd: number; after_iqd: number | null; reverse: boolean }
export interface SettlementPlan {
  staff_id: string; through_day: string; owed_iqd: number;
  /** What the period's rows said before: earned, paid, and earned minus paid. */
  earned_before_iqd: number; paid_before_iqd: number; owed_before_iqd: number;
  rows: number; adjusted: number; reversed: number;
  /** The one movement of the books: agreed minus what was owed (negative: a cut). */
  change_iqd: number;
  /** Owner only: each order whose wage moves, before and after (an order's profit moves by the opposite). */
  order_changes: Array<{ order_id: string; before_iqd: number; after_iqd: number }>;
  fingerprint: string;
  lines: SettlementLine[];
}

export async function planStaffSettlement(db: D1Database, staffId: string, throughDay: string, owedIqd: number): Promise<SettlementPlan> {
  const staff = await readStaff(db, staffId);
  if (!staff) throw notFound('الموظف غير موجود');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(throughDay) || Number.isNaN(Date.parse(`${throughDay}T00:00:00Z`))) throw badRequest('اختر يوم بداية الفترة الجديدة');
  if (!Number.isSafeInteger(owedIqd) || owedIqd < 0) throw badRequest('المبلغ المتفق عليه غير صحيح');
  // Through today at most: a later day would close orders still to be delivered today.
  if (throughDay > baghdadDay()) throw badRequest('لا تُسوّى أيام لم تأتِ بعد');
  if (!await settlementInstalled(db)) throw conflict('جدول التسويات غير موجود بعد؛ انتظر اكتمال النشر');
  // The ledger nets an unspent cash advance against wages; settle it first so the agreed amount is the whole truth.
  const advance = (await db.prepare(`SELECT ${staffAdvanceSql('?')} AS balance`).bind(staffId).first<{ balance: number }>())?.balance ?? 0;
  if (advance > 0) throw conflict('للموظف سلفة غير مسوّاة؛ سوِّها من الأجور أولًا ثم سوِّ الأجور');
  const previous = await db.prepare(`SELECT ${settledThroughSql('?', true)} AS through_day`).bind(staffId).first<{ through_day: string | null }>();
  if (previous?.through_day && throughDay <= previous.through_day) throw conflict('هذه الفترة سُوّيت من قبل؛ اختر يومًا بعد آخر تسوية');
  // The fingerprint is read FIRST: a write landing before the rows are read then makes the
  // plan's fingerprint stale and the fence refuses, instead of passing on an older plan.
  const fingerprint = (await db.prepare(`SELECT ${fingerprintSql} AS f`).bind(staffId, throughDay).first<{ f: string }>())?.f ?? '';
  const rows = (await db.prepare(`${periodRowsSql} ORDER BY delivered_day IS NULL,COALESCE(delivered_day,c.cost_day),c.order_id,c.id`).bind(staffId, throughDay).all<PeriodRow>()).results ?? [];
  if (rows.some((r) => r.held_iqd > 0)) throw conflict('طلب سحب مفتوح يحجز جزءًا من هذه الأجور؛ ادفعه أو ارفضه أولًا');
  if (rows.some((r) => r.state === 'pending_cost' && r.paid_iqd > 0)) throw conflict('أجر مدفوع ما زال ينتظر تكلفته؛ صحّحه قبل التسوية');
  const accrued = (r: PeriodRow) => (r.state === 'pending_cost' ? 0 : Math.max(0, r.effective_iqd ?? 0));
  const earned = rows.reduce((n, r) => n + accrued(r), 0), paid = rows.reduce((n, r) => n + r.paid_iqd, 0);
  // The agreed amount rides on the payable rows of delivered orders IN PROPORTION
  // to what each still owed: every order's wage moves by the same share, so no
  // order's profit (and no investor's share of it) carries more of the change
  // than another. A raise beyond what was owed goes to the oldest row.
  const carriers = rows.filter((r) => (r.state === 'due' || r.state === 'approved') && r.effective_iqd !== null && r.delivered_day !== null);
  const room = carriers.map((r) => Math.max(0, r.effective_iqd! - r.paid_iqd));
  const totalRoom = room.reduce((n, x) => n + x, 0);
  const shares = totalRoom === 0 ? room.map(() => 0) : allocateExact(Math.min(owedIqd, totalRoom), room);
  const after = new Map(carriers.map((r, i) => [r.id, r.paid_iqd + shares[i]] as const));
  if (owedIqd > totalRoom) {
    if (!carriers.length) throw conflict('لا يوجد أجر مسجّل في هذه الفترة يحمل المبلغ المتفق عليه');
    after.set(carriers[0].id, after.get(carriers[0].id)! + owedIqd - totalRoom);
  }
  const lines: SettlementLine[] = rows.map((r) => r.state === 'pending_cost'
    ? { id: r.id, before_iqd: r.effective_iqd, paid_iqd: r.paid_iqd, after_iqd: null, reverse: true }
    : { id: r.id, before_iqd: r.effective_iqd, paid_iqd: r.paid_iqd, after_iqd: r.effective_iqd === null ? null : after.get(r.id) ?? r.paid_iqd, reverse: false });
  // A row with no amount cannot be adjusted (NULL+delta stays NULL); only a paid one would matter.
  if (lines.some((l) => !l.reverse && l.after_iqd === null && l.paid_iqd > 0)) throw conflict('أجر مدفوع بلا مبلغ مسجّل؛ صحّحه قبل التسوية');
  const owedAfter = lines.reduce((n, l) => n + (l.reverse || l.after_iqd === null ? 0 : l.after_iqd - l.paid_iqd), 0);
  if (owedAfter !== owedIqd) throw conflict('تعذر توزيع المبلغ المتفق عليه على أجور الفترة');
  const change = lines.reduce((n, l) => n + (l.reverse ? -Math.max(0, l.before_iqd ?? 0) : l.after_iqd === null || l.before_iqd === null ? 0 : l.after_iqd - l.before_iqd), 0);
  return {
    staff_id: staffId, through_day: throughDay, owed_iqd: owedIqd,
    earned_before_iqd: earned, paid_before_iqd: paid, owed_before_iqd: earned - paid,
    rows: lines.length,
    adjusted: lines.filter((l) => !l.reverse && l.after_iqd !== null && l.after_iqd !== l.before_iqd).length,
    reversed: lines.filter((l) => l.reverse).length,
    change_iqd: change, order_changes: orderChanges(rows, lines), fingerprint, lines,
  };
}

function orderChanges(rows: PeriodRow[], lines: SettlementLine[]) {
  const byOrder = new Map<string, { before_iqd: number; after_iqd: number }>();
  lines.forEach((l, i) => {
    const before = Math.max(0, l.before_iqd ?? 0);
    const after = l.reverse ? 0 : l.after_iqd ?? before;
    if (before === after) return;
    const o = byOrder.get(rows[i].order_id) ?? { before_iqd: 0, after_iqd: 0 };
    o.before_iqd += before; o.after_iqd += after; byOrder.set(rows[i].order_id, o);
  });
  return [...byOrder].map(([order_id, v]) => ({ order_id, ...v }));
}

export async function settleStaffWages(db: D1Database, input: { staffId: string; throughDay: string; owedIqd: number; reason?: string; actor: string; expectedOwedBefore?: number; operationId?: string }) {
  const staff = await readStaff(db, input.staffId);
  if (!staff) throw notFound('الموظف غير موجود');
  // A retried request (a timeout after the write) answers with the settlement it already made.
  const id = input.operationId ? `wagesettle_${input.operationId}` : newId('wagesettle');
  if (input.operationId && await settlementInstalled(db)) {
    const prior = await db.prepare('SELECT * FROM finance_staff_settlements WHERE id=?').bind(id).first<{ staff_id: string; through_day: string; owed_iqd: number }>();
    if (prior) {
      if (prior.staff_id !== staff.id || prior.through_day !== input.throughDay || prior.owed_iqd !== input.owedIqd) throw conflict('رقم العملية مستخدم لتسوية أخرى');
      return { already: true, settlement: prior };
    }
  }
  const job = await db.prepare('SELECT state FROM finance_staff_reconciliations WHERE staff_id=?').bind(staff.id).first<{ state: string }>();
  if (job && job.state !== 'complete') throw conflict('أجور الموظف قيد إعادة الحساب؛ انتظر حتى تكتمل ثم سوِّها');
  const plan = await planStaffSettlement(db, staff.id, input.throughDay, input.owedIqd);
  if (input.expectedOwedBefore !== undefined && input.expectedOwedBefore !== plan.owed_before_iqd) throw conflict('تغيرت الأجور منذ المعاينة؛ حدّث ثم أعد المحاولة');
  const day = baghdadDay();
  await periodOpen(db, day);
  const now = new Date().toISOString();
  const reason = (input.reason ?? '').trim().slice(0, 300) || 'تسوية أجور نهائية متفق عليها';
  const statements: D1PreparedStatement[] = [
    ...fence(db, 'EXISTS(SELECT 1 FROM finance_staff WHERE id=? AND employment_version=?)', [staff.id, staff.employment_version]),
    ...fence(db, "NOT EXISTS(SELECT 1 FROM finance_staff_reconciliations WHERE staff_id=? AND state<>'complete')", [staff.id]),
    ...fence(db, `COALESCE(${settledThroughSql('?', true)},'')<?`, [staff.id, plan.through_day]),
    ...fence(db, `${staffAdvanceSql('?')}=0`, [staff.id]),
    ...fence(db, `${fingerprintSql}=?`, [staff.id, plan.through_day, plan.fingerprint]),
    db.prepare('INSERT INTO finance_staff_settlements(id,staff_id,through_day,owed_iqd,earned_before_iqd,paid_before_iqd,owed_before_iqd,rows_settled,reason,settlement_day,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(id, staff.id, plan.through_day, plan.owed_iqd, plan.earned_before_iqd, plan.paid_before_iqd, plan.owed_before_iqd, plan.rows, reason, day, input.actor, now),
  ];
  for (const line of plan.lines) {
    statements.push(db.prepare('INSERT INTO finance_staff_settled_costs(cost_id,settlement_id,before_iqd,paid_iqd,after_iqd) VALUES (?,?,?,?,?)').bind(line.id, id, line.before_iqd, line.paid_iqd, line.after_iqd));
    // A target still waiting for an amount would keep the order's profit «pending» for ever
    // (orderProfit, the recovery scan): the agreed amount is that amount now.
    statements.push(db.prepare('UPDATE finance_wage_targets SET amount_iqd=?,updated_at=? WHERE cost_id=? AND amount_iqd IS NULL').bind(line.reverse ? 0 : line.after_iqd ?? 0, now, line.id));
    if (line.reverse) {
      statements.push(db.prepare("UPDATE finance_order_costs SET state='reversed' WHERE id=? AND state='pending_cost'").bind(line.id));
      if ((line.before_iqd ?? 0) > 0) statements.push(db.prepare('INSERT INTO finance_cost_reversals(id,cost_id,amount_iqd,reversal_day,reason,actor_id) VALUES (?,?,?,?,?,?)').bind(newId('rev'), line.id, line.before_iqd, day, reason, input.actor));
    } else if (line.before_iqd !== null && line.after_iqd !== null && line.after_iqd !== line.before_iqd) {
      statements.push(db.prepare("INSERT INTO finance_cost_adjustments(id,cost_id,kind,delta_iqd,before_iqd,after_iqd,actor_id,adjustment_day,created_at,employment_version,reason) VALUES (?,?,'manual',?,?,?,?,?,?,?,?)")
        .bind(newId('wagesettle'), line.id, line.after_iqd - line.before_iqd, line.before_iqd, line.after_iqd, input.actor, day, now, staff.employment_version, reason));
    }
  }
  if (plan.change_iqd) statements.push(...journalPlan(db, { key: `staff-settlement:${id}`, day, title: reason, source: 'finance_staff_settlement', sourceId: id, actor: input.actor },
    plan.change_iqd < 0 ? [{ account: '2100', debit: -plan.change_iqd }, { account: '5100', credit: -plan.change_iqd }] : [{ account: '5100', debit: plan.change_iqd }, { account: '2100', credit: plan.change_iqd }]).statements);
  statements.push(...(await auditStatements(db, input.actor, 'finance.staff_settled', staff.id, {
    settlement_id: id, through_day: plan.through_day, owed_iqd: plan.owed_iqd, owed_before_iqd: plan.owed_before_iqd, earned_before_iqd: plan.earned_before_iqd,
    paid_before_iqd: plan.paid_before_iqd, rows: plan.rows, adjusted: plan.adjusted, reversed: plan.reversed, change_iqd: plan.change_iqd, reason,
  })).statements);
  try { await db.batch(statements); } catch (e) {
    if (/CHECK constraint|UNIQUE constraint|FOREIGN KEY/i.test(String(e))) throw conflict('تغيرت أجور الموظف أثناء التسوية؛ حدّث ثم أعد المحاولة');
    throw e;
  }
  const { lines: _lines, fingerprint: _fingerprint, ...summary } = plan;
  return { settlement: { id, ...summary, reason, settlement_day: day } };
}

/** The latest settlement of each of these employees (for the people picture). */
export async function latestSettlements(db: D1Database, staffIds: string[]) {
  const out = new Map<string, { through_day: string; owed_iqd: number; settlement_day: string }>();
  if (!staffIds.length || !await settlementInstalled(db)) return out;
  const rows = (await db.prepare(`SELECT staff_id,through_day,owed_iqd,settlement_day FROM finance_staff_settlements
    WHERE staff_id IN (SELECT value FROM json_each(?)) ORDER BY through_day DESC,id DESC`).bind(JSON.stringify(staffIds)).all<{ staff_id: string; through_day: string; owed_iqd: number; settlement_day: string }>()).results ?? [];
  for (const r of rows) if (!out.has(r.staff_id)) out.set(r.staff_id, { through_day: r.through_day, owed_iqd: r.owed_iqd, settlement_day: r.settlement_day });
  return out;
}
