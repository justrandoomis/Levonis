import { journalPlan, operationsInstalled } from './operations';

/** Keep the ordinary expense editor and journal in one transaction. */
export async function planExpenseAccounting(
  db: D1Database,
  input: {
    id: string;
    actor: string;
    title: string;
    day: string;
    amount: number;
    fresh?: boolean;
    void?: boolean;
  },
) {
  if (!(await operationsInstalled(db))) return [];
  const entries =
    (
      await db
        .prepare(
          `SELECT e.id,e.entry_day,EXISTS(SELECT 1 FROM accounting_entries r WHERE r.reversal_of=e.id) AS reversed
    FROM accounting_entries e WHERE source_type='expense' AND source_id=? ORDER BY created_at,id`,
        )
        .bind(input.id)
        .all<{ id: string; entry_day: string; reversed: number }>()
    ).results ?? [];
  // Pre-migration expenses belong to opening balances; do not post them again.
  if (!input.fresh && !entries.length) return [];
  const statements: D1PreparedStatement[] = [];
  for (const entry of entries.filter((e) => !e.reversed)) {
    const lines =
      (
        await db
          .prepare('SELECT account_code,debit_iqd,credit_iqd FROM accounting_lines WHERE entry_id=?')
          .bind(entry.id)
          .all<{ account_code: string; debit_iqd: number; credit_iqd: number }>()
      ).results ?? [];
    statements.push(
      ...journalPlan(
        db,
        {
          key: `expense-reversal:${entry.id}`,
          day: entry.entry_day,
          title: 'تصحيح مصروف: ' + input.title,
          source: 'expense_reversal',
          sourceId: input.id,
          actor: input.actor,
          reversalOf: entry.id,
        },
        lines.map((l) => ({ account: l.account_code, debit: l.credit_iqd, credit: l.debit_iqd })),
      ).statements,
    );
  }
  if (!input.void)
    statements.push(
      ...journalPlan(
        db,
        {
          key: `expense:${input.id}:${crypto.randomUUID()}`,
          day: input.day,
          title: input.title || 'مصروف عام',
          source: 'expense',
          sourceId: input.id,
          actor: input.actor,
        },
        [
          { account: '5100', debit: input.amount },
          { account: '1000', credit: input.amount },
        ],
      ).statements,
    );
  return statements;
}
