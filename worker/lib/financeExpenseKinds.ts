/**
 * WHERE AN EXPENSE COUNTS — ONE FRAGMENT FOR EVERY READ (redesign step 5, owner 2026-11-11; DECISIONS row 317).
 *
 * Each row of `operating_expenses` in a period counts in exactly one place of «المال والأرباح», first match wins:
 *
 *   promotion        the month's promotion (finance_monthly_promotions.expense_id) → Costs → Monthly promotion
 *   order_cost       an order's wage or material (finance_order_costs.expense_id)  → that order's wages or materials
 *   collection_fee   a courier's collection fee (finance_collections.expense_id)     → «أجور التوصيل والدفع»
 *   order_delivered  linked to a delivered order (finance_expense_links)            → that order's «المواد والتكاليف الإضافية»
 *   order_waiting    linked to an order still on its way                            → counted on its delivery (`general_waiting_iqd`)
 *   order_ended      linked to an order that ended without a delivery               → a general expense on its own day (since step 1, row 313)
 *   general          everything else — rent, power, subscriptions, a row tagged only to a cost centre
 *
 * «المصاريف العامة» of the period is `general` + `order_ended` (GENERAL_KINDS): the rule /summary used before this step
 * (voided rows out; no promotion, order cost or collection behind it; no link to an order that can still be delivered),
 * written once. /summary and /expenses both read EXPENSE_TOTALS_SQL through periodExpenses(), so the statement's line,
 * its drawer and the General expenses page cannot drift apart (tests/financeCostsServer.test.ts holds them equal).
 *
 * A link is at most one per expense (`finance_expense_links.expense_id` is its primary key) and an order one per id, so the
 * LEFT JOINs never repeat an amount. A cost-centre tag (`center_id`) does not change where an expense counts: the owner has
 * not ruled on it yet (the plan's question 5.7.3), so the rule stays exactly as the code had it and the page shows the tag.
 * tests/reportCteBudget.test.ts counts these statements against D1's subquery budget with the report's own.
 */
export const EXPENSE_KINDS = ['general', 'order_ended', 'promotion', 'order_cost', 'collection_fee', 'order_delivered', 'order_waiting'] as const;
export type ExpenseKind = (typeof EXPENSE_KINDS)[number];
/** The kinds the period's «المصاريف العامة» is the sum of. */
export const GENERAL_KINDS: readonly ExpenseKind[] = ['general', 'order_ended'];
export const isGeneralKind = (kind: string) => (GENERAL_KINDS as readonly string[]).includes(kind);

/** Every statement that classifies an expense reads it from here: the expense, its one link, the order the link names. */
export const EXPENSE_FROM = 'operating_expenses e LEFT JOIN finance_expense_links l ON l.expense_id=e.id LEFT JOIN orders lo ON lo.id=l.order_id';
/** The kind of the expense `e` (EXPENSE_FROM's aliases), first match wins. */
export const EXPENSE_KIND_SQL = "CASE WHEN EXISTS(SELECT 1 FROM finance_monthly_promotions p WHERE p.expense_id=e.id) THEN 'promotion'"
  + " WHEN EXISTS(SELECT 1 FROM finance_order_costs oc WHERE oc.expense_id=e.id) THEN 'order_cost'"
  + " WHEN EXISTS(SELECT 1 FROM finance_collections fc WHERE fc.expense_id=e.id) THEN 'collection_fee'"
  + " WHEN lo.id IS NULL THEN 'general' WHEN lo.status='delivered' THEN 'order_delivered'"
  + " WHEN lo.status IN ('cancelled','returned','refunded') THEN 'order_ended' ELSE 'order_waiting' END";

/** The period's live expenses by day, kind and category — what /summary and /expenses both sum. Binds: from, to. */
export const EXPENSE_TOTALS_SQL = `SELECT e.expense_day,${EXPENSE_KIND_SQL} expense_kind,e.category_id,ec.name_ar,ec.name_en,ec.name_ckb,COALESCE(SUM(e.amount_iqd),0) total,COUNT(*) entries
  FROM ${EXPENSE_FROM} LEFT JOIN expense_categories ec ON ec.id=e.category_id
  WHERE e.voided_at IS NULL AND e.expense_day BETWEEN ? AND ? GROUP BY 1,2,3`;

/**
 * The period's entries, newest first, each with its kind, its category in three languages, its cost-centre tag and the
 * order (or the promotion's month) it counts with. Binds: from, to, include voided (0 or 1), limit.
 */
export const EXPENSE_ROWS_SQL = `SELECT e.id,e.expense_day,e.amount_iqd,e.title,e.note,e.series_id,e.category_id,ec.name_ar category_name_ar,ec.name_en category_name_en,ec.name_ckb category_name_ckb,
  e.voided_at,e.void_reason,l.center_id,cc.name center_name,lo.status order_status,
  COALESCE(l.order_id,(SELECT oc.order_id FROM finance_order_costs oc WHERE oc.expense_id=e.id),(SELECT fc.order_id FROM finance_collections fc WHERE fc.expense_id=e.id LIMIT 1)) order_id,
  (SELECT p.month FROM finance_monthly_promotions p WHERE p.expense_id=e.id) promotion_month,${EXPENSE_KIND_SQL} expense_kind
  FROM ${EXPENSE_FROM} LEFT JOIN expense_categories ec ON ec.id=e.category_id LEFT JOIN finance_cost_centers cc ON cc.id=l.center_id
  WHERE e.expense_day BETWEEN ? AND ? AND (e.voided_at IS NULL OR ?=1) ORDER BY e.expense_day DESC,e.rowid DESC LIMIT ?`;

/** A month's promotion edits, newest first, with who made each. Binds: the month (YYYY-MM), twice. */
export const PROMOTION_HISTORY_SQL = `SELECT h.id,h.promotion_id,h.version,h.before_json,h.after_json,h.actor_id,u.name actor_name,h.created_at
  FROM finance_promotion_history h LEFT JOIN users u ON u.id=h.actor_id
  WHERE json_extract(h.after_json,'$.month')=? OR json_extract(h.before_json,'$.month')=? ORDER BY h.created_at DESC,h.version DESC LIMIT 50`;

/** The statements of this module, by name, for the subquery budget (tests/reportCteBudget.test.ts). */
export const EXPENSE_STATEMENTS: Readonly<Record<string, string>> = { expenseTotals: EXPENSE_TOTALS_SQL, expenseRows: EXPENSE_ROWS_SQL, promotionHistory: PROMOTION_HISTORY_SQL };

type Row = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0), s = (v: unknown) => String(v ?? '');
export interface ExpenseCategoryTotal { category_id: string; name_ar: string; name_en: string; name_ckb: string; amount_iqd: number; entries: number }
export interface PeriodExpenses {
  /** The general expenses of each day that has any — the chart's and the dollar view's input (`{expense_day, total}`). */
  days: Array<{ expense_day: string; total: number }>;
  /** The statement's «المصاريف العامة» (= /summary's `general_expenses_iqd`). */
  general_iqd: number;
  /** Costs of orders still on their way, counted on delivery (= /summary's `general_waiting_iqd`). */
  waiting_iqd: number;
  /** Every live entry of the period, whatever it counts as. */
  all_iqd: number;
  entries: number;
  by_kind: Record<ExpenseKind, { amount_iqd: number; entries: number }>;
  /** The general entries by category, largest first; they add up to `general_iqd`. */
  by_category: ExpenseCategoryTotal[];
}

/** The period's expenses, summed by where they count. One statement (EXPENSE_TOTALS_SQL), for /summary and /expenses alike. */
export async function periodExpenses(db: D1Database, r: { from: string; to: string }): Promise<PeriodExpenses> {
  const rows = (await db.prepare(EXPENSE_TOTALS_SQL).bind(r.from, r.to).all<Row>()).results ?? [];
  const by_kind = Object.fromEntries(EXPENSE_KINDS.map((k) => [k, { amount_iqd: 0, entries: 0 }])) as PeriodExpenses['by_kind'];
  const days = new Map<string, number>(), categories = new Map<string, ExpenseCategoryTotal>();
  for (const row of rows) {
    const kind = s(row.expense_kind) as ExpenseKind, amount = n(row.total), entries = n(row.entries);
    const k = by_kind[kind] ?? (by_kind[kind] = { amount_iqd: 0, entries: 0 });
    k.amount_iqd += amount; k.entries += entries;
    if (!isGeneralKind(kind)) continue;
    days.set(s(row.expense_day), (days.get(s(row.expense_day)) ?? 0) + amount);
    const id = s(row.category_id), c = categories.get(id) ?? { category_id: id, name_ar: s(row.name_ar), name_en: s(row.name_en), name_ckb: s(row.name_ckb), amount_iqd: 0, entries: 0 };
    c.amount_iqd += amount; c.entries += entries; categories.set(id, c);
  }
  const general_iqd = GENERAL_KINDS.reduce((v, k) => v + by_kind[k].amount_iqd, 0);
  return {
    days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([expense_day, total]) => ({ expense_day, total })),
    general_iqd, waiting_iqd: by_kind.order_waiting.amount_iqd,
    all_iqd: Object.values(by_kind).reduce((v, k) => v + k.amount_iqd, 0), entries: Object.values(by_kind).reduce((v, k) => v + k.entries, 0),
    by_kind, by_category: [...categories.values()].sort((a, b) => b.amount_iqd - a.amount_iqd || a.category_id.localeCompare(b.category_id)),
  };
}
