/**
 * THE OWNER'S FINANCE CALLS — the profit report and the expense ledger
 * (`/api/admin/finance/*`, behind `requireCostRead` on the Worker).
 *
 * Moved out of ./api.ts (DECISIONS row 219): every page — the storefront,
 * the product page, the cart — loads api.ts at first paint, so these route
 * names travelled to every visitor. Only the finance panel imports this
 * file, and it is reached through the admin shell alone. The types stay in
 * ./api.ts: they emit no code.
 */
import {
  api,
  type ExpenseCategory,
  type ExpenseLedgerPage,
  type FinanceCategoriesReport,
  type FinanceGranularity,
  type FinancePeriodReport,
  type FinanceProductsReport,
  type FinanceQuery,
  type RequestOptions,
} from './api';

const financePath = (path: string, params: Record<string, string | number | undefined>): string => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const query = q.toString();
  return query ? `${path}?${query}` : path;
};

/** GET /api/admin/finance/report/summary — buckets, totals, and the comparison. */
export function fetchFinanceSummary(
  query: FinanceQuery & { granularity: FinanceGranularity },
  opts?: RequestOptions
): Promise<FinancePeriodReport> {
  return api.get<FinancePeriodReport & { success: boolean }>(
    financePath('/api/admin/finance/report/summary', {
      from: query.from,
      to: query.to,
      granularity: query.granularity,
    }),
    opts
  );
}

/** GET /api/admin/finance/report/products — GROSS profit per product. Never net. */
export function fetchFinanceProducts(
  query: FinanceQuery & { limit?: number },
  opts?: RequestOptions
): Promise<FinanceProductsReport> {
  return api.get<FinanceProductsReport & { success: boolean }>(
    financePath('/api/admin/finance/report/products', {
      from: query.from,
      to: query.to,
      limit: query.limit,
    }),
    opts
  );
}

/** GET /api/admin/finance/report/categories — the same, rolled up to a rung. */
export function fetchFinanceCategories(
  query: FinanceQuery & { level: 'main' | 'sub'; limit?: number },
  opts?: RequestOptions
): Promise<FinanceCategoriesReport> {
  return api.get<FinanceCategoriesReport & { success: boolean }>(
    financePath('/api/admin/finance/report/categories', {
      from: query.from,
      to: query.to,
      level: query.level,
      limit: query.limit,
    }),
    opts
  );
}

export function fetchExpenseCategories(opts?: RequestOptions): Promise<{ categories: ExpenseCategory[] }> {
  return api.get<{ categories: ExpenseCategory[]; success: boolean }>('/api/admin/finance/expense-categories', opts);
}

export function createExpenseCategory(
  body: { name_ar: string; name_en?: string; name_ckb?: string },
  opts?: RequestOptions
): Promise<{ category: ExpenseCategory }> {
  return api.post<{ category: ExpenseCategory; success: boolean }>('/api/admin/finance/expense-categories', body, opts);
}

export function updateExpenseCategory(
  id: string,
  body: { name_ar?: string; name_en?: string; name_ckb?: string; active?: boolean },
  opts?: RequestOptions
): Promise<{ success: boolean }> {
  return api.patch<{ success: boolean }>(`/api/admin/finance/expense-categories/${encodeURIComponent(id)}`, body, opts);
}

/** The ledger for a period. `include_voided` shows what was removed, and by whom. */
export function fetchExpenses(
  query: { from: string; to: string; category_id?: string; include_voided?: boolean; limit?: number },
  opts?: RequestOptions
): Promise<ExpenseLedgerPage> {
  return api.get<ExpenseLedgerPage & { success: boolean }>(
    financePath('/api/admin/finance/expenses', {
      from: query.from,
      to: query.to,
      category_id: query.category_id,
      include_voided: query.include_voided ? '1' : undefined,
      limit: query.limit,
    }),
    opts
  );
}

/**
 * Record an expense. `repeat_months` writes N REAL ROWS NOW — it is not a
 * recurrence rule, and nothing generates rows later. The server's own comment
 * says why: a rule evaluated at report time makes last January's profit depend
 * on this June's edit, which is the same silent rewriting of history the cost
 * snapshot exists to abolish.
 */
export function createExpense(
  body: {
    category_id: string;
    amount_iqd: number;
    expense_day: string;
    title?: string;
    note?: string;
    repeat_months?: number;
  },
  opts?: RequestOptions
): Promise<{ ids: string[]; series_id: string | null; days: string[] }> {
  return api.post<{ ids: string[]; series_id: string | null; days: string[]; success: boolean }>(
    '/api/admin/finance/expenses',
    body,
    opts
  );
}

export function updateExpense(
  id: string,
  body: { category_id?: string; amount_iqd?: number; expense_day?: string; title?: string; note?: string },
  opts?: RequestOptions
): Promise<{ success: boolean }> {
  return api.patch<{ success: boolean }>(`/api/admin/finance/expenses/${encodeURIComponent(id)}`, body, opts);
}

/** VOID, not delete — a removed expense changes a net profit the owner may
 *  already have acted on, so the row and the reason stay. */
export function voidExpense(id: string, reason: string, opts?: RequestOptions): Promise<{ voided: boolean }> {
  return api.delete<{ voided: boolean; success: boolean }>(
    financePath(`/api/admin/finance/expenses/${encodeURIComponent(id)}`, { reason }),
    opts
  );
}

export function restoreExpense(id: string, opts?: RequestOptions): Promise<{ restored: boolean }> {
  return api.post<{ restored: boolean; success: boolean }>(
    `/api/admin/finance/expenses/${encodeURIComponent(id)}/restore`,
    undefined,
    opts
  );
}
