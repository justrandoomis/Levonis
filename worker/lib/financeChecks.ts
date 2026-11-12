/**
 * THE BOOKS' OWN CHECKS — automated consistency checks over the money (the owner's brief, 2026-11-12, part 4:
 * «reconciliation, and automated consistency checks … all financial calculations must remain accurate and traceable»;
 * it carries the checks step 6 B planned for the accounting page, D:/lv-tmp/fin/plan-step6-addendum.md).
 *
 * Each check is one read that should find nothing. What it finds is counted, its money totalled where it is money, and its
 * first rows named, so the owner can open them. Two kinds:
 *   'error'    the books disagree with themselves — a journal entry whose debits are not its credits, a posting that
 *              failed, more cash recorded on an order than was due, a delivered order with no day, a staff payment shared
 *              out beyond its amount. Never right; each one is a fault to fix.
 *   'warning'  something the books do not settle on their own and the owner should look at — a delivered order whose sale
 *              never reached the journal, an order cancelled after delivery whose sale is still in it (DECISIONS row 318
 *              reverses those), an order walked back after delivery, cash recorded on an order since cancelled, a month
 *              that cannot close while costs wait, an expense linked to an order that will never count it.
 *
 * ONE ROUND TRIP. Every check is wrapped the same way (count, total, the first five ids) and the whole set is one D1 batch
 * of reads, so the page and the daily alert (financeChecksAlert.ts) cost the same few hundred milliseconds whatever they
 * find. A check reads only tables migration 0162 or earlier created, so it runs on every database this code runs on.
 */

export type FinanceCheckKey =
  | 'journal_unbalanced'
  | 'posting_errors'
  | 'collections_over_due'
  | 'undated_delivered'
  | 'staff_payment_overallocated'
  | 'delivered_without_sale'
  | 'cancelled_after_delivery_in_journal'
  | 'walk_backs'
  | 'cash_on_cancelled'
  | 'pending_cost_months'
  | 'expenses_counting_nowhere';

export type FinanceCheckSeverity = 'error' | 'warning';

/** What each check selects: one row per thing found, its id and, where it is money, its amount. */
interface FinanceCheckSpec {
  key: FinanceCheckKey;
  severity: FinanceCheckSeverity;
  /** Whether `amount` is dinars (a total worth showing) or a plain count. */
  money: boolean;
  sql: string;
}

/** The order of the list on the page: the faults first, then what to look at. */
export const FINANCE_CHECKS: readonly FinanceCheckSpec[] = [
  {
    key: 'journal_unbalanced',
    severity: 'error',
    money: true,
    sql: `SELECT e.id AS id, ABS(SUM(l.debit_iqd) - SUM(l.credit_iqd)) AS amount
      FROM accounting_entries e JOIN accounting_lines l ON l.entry_id = e.id
      WHERE e.state = 'posted' GROUP BY e.id HAVING SUM(l.debit_iqd) <> SUM(l.credit_iqd)`,
  },
  {
    key: 'posting_errors',
    severity: 'error',
    money: false,
    sql: `SELECT COALESCE(p.order_id, p.event_key) AS id, NULL AS amount FROM finance_posting_errors p`,
  },
  {
    // The door's own limits (POST /collections): at the door, what was due on delivery; at the bank, what Gini paid less its refunds.
    key: 'collections_over_due',
    severity: 'error',
    money: true,
    sql: `WITH c AS (SELECT order_id, SUM(CASE WHEN payer = 'bank' THEN amount_iqd ELSE 0 END) AS bank,
          SUM(CASE WHEN payer <> 'bank' THEN amount_iqd ELSE 0 END) AS door FROM finance_collections GROUP BY order_id),
        r AS (SELECT order_id, SUM(refund_iqd) AS gini FROM finance_refund_facts WHERE channel = 'gini' GROUP BY order_id)
      SELECT o.id AS id, MAX(c.door - COALESCE(o.due_on_delivery_iqd, 0), c.bank - (COALESCE(o.gini_paid_iqd, 0) - COALESCE(r.gini, 0)), 0) AS amount
      FROM c JOIN orders o ON o.id = c.order_id LEFT JOIN r ON r.order_id = o.id
      WHERE c.door > COALESCE(o.due_on_delivery_iqd, 0) OR c.bank > COALESCE(o.gini_paid_iqd, 0) - COALESCE(r.gini, 0)`,
  },
  {
    key: 'undated_delivered',
    severity: 'error',
    money: true,
    sql: `SELECT o.id AS id, o.total_iqd AS amount FROM orders o
      WHERE o.seller_type = 'levonis' AND o.status = 'delivered' AND date(o.delivered_at, '+3 hours') IS NULL`,
  },
  {
    key: 'staff_payment_overallocated',
    severity: 'error',
    money: true,
    sql: `SELECT p.id AS id, SUM(a.amount_iqd) - p.amount_iqd AS amount
      FROM finance_staff_payments p JOIN finance_payment_allocations a ON a.payment_id = p.id
      GROUP BY p.id HAVING SUM(a.amount_iqd) > p.amount_iqd`,
  },
  {
    // Since the journal's first sale only: orders delivered before the books existed were never posted, and are not news.
    key: 'delivered_without_sale',
    severity: 'warning',
    money: true,
    sql: `SELECT o.id AS id, o.total_iqd AS amount FROM orders o
      WHERE o.seller_type = 'levonis' AND o.status = 'delivered' AND o.total_iqd > 0
        AND date(o.delivered_at, '+3 hours') >= (SELECT MIN(entry_day) FROM accounting_entries WHERE event_key >= 'sale:' AND event_key < 'sale;')
        AND NOT EXISTS (SELECT 1 FROM accounting_entries s WHERE s.event_key IN ('sale:' || o.id, 'membership-sale:' || o.id) AND s.state = 'posted')
        AND NOT EXISTS (SELECT 1 FROM finance_posting_errors p WHERE p.order_id = o.id)`,
  },
  {
    key: 'cancelled_after_delivery_in_journal',
    severity: 'warning',
    money: true,
    sql: `SELECT o.id AS id, o.total_iqd AS amount FROM orders o
      WHERE o.seller_type = 'levonis' AND o.status = 'cancelled' AND COALESCE(o.delivered_at, '') <> ''
        AND EXISTS (SELECT 1 FROM accounting_entries s WHERE s.event_key IN ('sale:' || o.id, 'membership-sale:' || o.id) AND s.state = 'posted'
          AND NOT EXISTS (SELECT 1 FROM accounting_entries r WHERE r.reversal_of = s.id))`,
  },
  {
    key: 'walk_backs',
    severity: 'warning',
    money: true,
    sql: `SELECT o.id AS id, o.total_iqd AS amount FROM orders o
      WHERE o.seller_type = 'levonis' AND COALESCE(o.delivered_at, '') <> '' AND o.status NOT IN ('delivered', 'cancelled')`,
  },
  {
    key: 'cash_on_cancelled',
    severity: 'warning',
    money: true,
    sql: `SELECT c.order_id AS id, SUM(c.amount_iqd) AS amount FROM finance_collections c JOIN orders o ON o.id = c.order_id
      WHERE o.status = 'cancelled' GROUP BY c.order_id`,
  },
  {
    key: 'pending_cost_months',
    severity: 'warning',
    money: false,
    sql: `SELECT substr(cost_day, 1, 7) AS id, NULL AS amount FROM finance_order_costs WHERE state = 'pending_cost' GROUP BY substr(cost_day, 1, 7)`,
  },
  {
    // Linked to an order its profit never reads: cancelled, a store's own, or delivered with no day (step 5 kept them out of
    // every figure; DECISIONS row 317). Named here so no expense goes missing without the owner seeing it.
    key: 'expenses_counting_nowhere',
    severity: 'warning',
    money: true,
    sql: `SELECT e.id AS id, e.amount_iqd AS amount FROM operating_expenses e
        JOIN finance_expense_links l ON l.expense_id = e.id JOIN orders o ON o.id = l.order_id
      WHERE e.voided_at IS NULL AND (o.status = 'cancelled' OR o.seller_type <> 'levonis'
        OR (o.status = 'delivered' AND date(o.delivered_at, '+3 hours') IS NULL))`,
  },
];

export interface FinanceCheckResult {
  key: FinanceCheckKey;
  severity: FinanceCheckSeverity;
  count: number;
  /** The found rows' money in dinars, or null for a check that counts things that are not money. */
  amount_iqd: number | null;
  /** The first five ids found (orders, entries, payments, expenses, months), in id order. */
  sample: string[];
}

export interface FinanceChecksReport {
  checked_at: string;
  /** No error-kind check found anything. */
  ok: boolean;
  checks: FinanceCheckResult[];
}

export const SAMPLE_SIZE = 5;

const wrapped = (sql: string) => `WITH q AS (${sql})
  SELECT (SELECT COUNT(*) FROM q) AS n, (SELECT SUM(amount) FROM q) AS total,
    (SELECT json_group_array(id) FROM (SELECT CAST(id AS TEXT) AS id FROM q ORDER BY id LIMIT ${SAMPLE_SIZE})) AS sample`;

/** Every check, one batch of reads. */
export async function runFinanceChecks(db: D1Database, now = new Date()): Promise<FinanceChecksReport> {
  const answers = await db.batch(FINANCE_CHECKS.map((c) => db.prepare(wrapped(c.sql))));
  const checks = FINANCE_CHECKS.map((c, i): FinanceCheckResult => {
    const r = (answers[i]?.results?.[0] ?? {}) as { n?: number; total?: number | null; sample?: string };
    let sample: string[] = [];
    try { sample = (JSON.parse(r.sample ?? '[]') as unknown[]).map(String); } catch { sample = []; }
    const count = Number(r.n ?? 0);
    return { key: c.key, severity: c.severity, count, amount_iqd: c.money ? (count ? Number(r.total ?? 0) : 0) : null, sample };
  });
  return { checked_at: now.toISOString(), ok: checks.every((c) => c.severity !== 'error' || c.count === 0), checks };
}
