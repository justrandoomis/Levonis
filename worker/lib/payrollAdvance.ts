import { badRequest, conflict } from './http';
import { fence, journalPlan, periodOpen } from './operations';
import { commitParticipantStatements, effectiveStaffCostSql, heldSourceSql, staffReconciliationBlockedSql } from './financeParticipants';

/** Apply an existing cash advance to approved earnings; no new cash or expense. */
export async function settleAdvance(
  db: D1Database,
  input: { id: string; staffId: string; amount: number; day: string; note: string; actor: string },
) {
  const prior = await db
    .prepare('SELECT staff_id,amount_iqd FROM finance_advance_settlements WHERE id=?')
    .bind(input.id)
    .first<{ staff_id: string; amount_iqd: number }>();
  if (prior) {
    if (prior.staff_id !== input.staffId || prior.amount_iqd !== input.amount)
      throw conflict('عملية التسوية مستخدمة لمحتوى مختلف');
    return;
  }
  await periodOpen(db, input.day);
  const [advances, costs] = await Promise.all([
    db
      .prepare(
        `SELECT p.id,p.amount_iqd-COALESCE((SELECT SUM(a.amount_iqd) FROM finance_payment_allocations a WHERE a.payment_id=p.id),0) AS balance
      FROM finance_staff_payments p WHERE p.staff_id=? AND p.kind='advance' ORDER BY p.payment_day,p.id`,
      )
      .bind(input.staffId)
      .all<{ id: string; balance: number }>(),
    db
      .prepare(
        `SELECT c.id,${effectiveStaffCostSql()}-COALESCE((SELECT SUM(a.amount_iqd) FROM finance_payment_allocations a WHERE a.cost_id=c.id),0)-${heldSourceSql("'staff'",'c.id')} AS balance
      FROM finance_order_costs c WHERE c.staff_id=? AND c.state='approved' AND NOT ${staffReconciliationBlockedSql()} ORDER BY c.cost_day,c.id`,
      )
      .bind(input.staffId)
      .all<{ id: string; balance: number }>(),
  ]);
  const incoming = (advances.results ?? []).filter((v) => v.balance > 0),
    dues = (costs.results ?? []).filter((v) => v.balance > 0);
  if (
    incoming.reduce((n, v) => n + v.balance, 0) < input.amount ||
    (costs.results??[]).reduce((n, v) => n + v.balance, 0) < input.amount
  )
    throw badRequest('التسوية تتجاوز السلفة المتبقية أو الأجور المعتمدة');
  const statements: D1PreparedStatement[] = [];
  for (const a of incoming)
    statements.push(
      ...fence(
        db,
        '(SELECT amount_iqd-COALESCE((SELECT SUM(amount_iqd) FROM finance_payment_allocations WHERE payment_id=?),0) FROM finance_staff_payments WHERE id=?)=?',
        [a.id, a.id, a.balance],
      ),
    );
  for (const c of dues)
    statements.push(
      ...fence(
        db,
        `EXISTS(SELECT 1 FROM finance_order_costs c WHERE id=? AND state='approved' AND NOT ${staffReconciliationBlockedSql()} AND ${effectiveStaffCostSql()}-COALESCE((SELECT SUM(amount_iqd) FROM finance_payment_allocations WHERE cost_id=?),0)-${heldSourceSql("'staff'",'c.id')}=?)`,
        [c.id, c.id, c.balance],
      ),
    );
  statements.push(
    db
      .prepare(
        'INSERT INTO finance_advance_settlements(id,staff_id,amount_iqd,settlement_day,note,actor_id,created_at) VALUES (?,?,?,?,?,?,?)',
      )
      .bind(
        input.id,
        input.staffId,
        input.amount,
        input.day,
        input.note,
        input.actor,
        new Date().toISOString(),
      ),
  );
  let left = input.amount,
    ai = 0,
    ci = 0;
  while (left > 0) {
    const a = incoming[ai],
      c = dues[ci],
      take = Math.min(left, a.balance, c.balance);
    statements.push(
      db
        .prepare(
          'INSERT INTO finance_payment_allocations(payment_id,cost_id,amount_iqd) VALUES (?,?,?) ON CONFLICT(payment_id,cost_id) DO UPDATE SET amount_iqd=amount_iqd+excluded.amount_iqd',
        )
        .bind(a.id, c.id, take),
    );
    left -= take;
    a.balance -= take;
    c.balance -= take;
    if (a.balance === 0) ai++;
    if (c.balance === 0) ci++;
  }
  statements.push(
    ...journalPlan(
      db,
      {
        key: `advance-settlement:${input.id}`,
        day: input.day,
        title: 'تسوية سلفة مع الأجور المعتمدة',
        source: 'advance_settlement',
        sourceId: input.id,
        actor: input.actor,
      },
      [
        { account: '2100', debit: input.amount },
        { account: '1400', credit: input.amount },
      ],
    ).statements,
  );
  await commitParticipantStatements(db,statements);
}
