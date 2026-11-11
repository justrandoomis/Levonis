import type { CsKey } from './costsStrings';
import { sharePercents } from './costFigures';

/**
 * «التكاليف ← المصاريف العامة» — THE PERIOD'S ENTRIES BY WHERE THEY COUNT, PURE (redesign step 5, owner 2026-11-11;
 * DECISIONS row 317). The server classifies every entry (worker/lib/financeExpenseKinds.ts, the fragment /summary reads
 * too) and sums them; this module only arranges its answer for the page: the general entries apart from the rest, the rest
 * grouped by where they count in a fixed order, and each category's share of the general total. tests/financeCostsPages.test.ts.
 */
export type ExpenseKind = 'general' | 'order_ended' | 'promotion' | 'order_cost' | 'collection_fee' | 'order_delivered' | 'order_waiting';
export interface ExpenseCategoryNames { name_ar: string; name_en: string; name_ckb: string }
/** One entry of GET /expenses. */
export interface ExpenseEntryRow {
  id: string; expense_day: string; amount_iqd: number; title: string; note: string; series_id: string | null;
  category_id: string; category: ExpenseCategoryNames; kind: ExpenseKind; counts_as_general: boolean;
  order_id: string | null; order_status: string | null; promotion_month: string | null; center_id: string | null; center_name: string | null;
  voided: boolean; void_reason: string;
}
export interface ExpenseCategoryTotal extends ExpenseCategoryNames { category_id: string; amount_iqd: number; entries: number }
export interface ExpensesAnswer {
  range: { from: string; to: string };
  rows: ExpenseEntryRow[];
  truncated: boolean;
  totals: { general_iqd: number; waiting_iqd: number; all_iqd: number; entries: number; by_kind: Record<ExpenseKind, { amount_iqd: number; entries: number }>; by_category: ExpenseCategoryTotal[] };
}

/** Where each kind counts, in the words of the page (costsStrings.ts). */
export const KIND_LABEL: Record<ExpenseKind, CsKey> = { general: 'kindGeneral', order_ended: 'kindOrderEnded', promotion: 'kindPromotion', order_cost: 'kindOrderCost',
  collection_fee: 'kindCollectionFee', order_delivered: 'kindOrderDelivered', order_waiting: 'kindOrderWaiting' };
/** The entries that are not general expenses, in the order the page lists them (the plan's table). */
export const ELSEWHERE: readonly ExpenseKind[] = ['promotion', 'order_cost', 'collection_fee', 'order_delivered', 'order_waiting'];
/**
 * An entry the page edits and voids itself. The month's promotion is edited on its own page, an order's wage or material in
 * its order and a courier's fee in its collection — their expense row is their source's, and editing it here would split them.
 */
export const editableHere = (kind: ExpenseKind) => !(['promotion', 'order_cost', 'collection_fee'] as ExpenseKind[]).includes(kind);

export interface EntryGroups {
  /** The live entries the statement's «المصاريف العامة» sums, as the server listed them (newest first). */
  general: ExpenseEntryRow[];
  /** The other live entries by where they count, in ELSEWHERE's order; empty kinds left out. */
  elsewhere: Array<{ kind: ExpenseKind; rows: ExpenseEntryRow[]; amount_iqd: number }>;
  /** The voided entries (only when the page asked for them); in no sum. */
  voided: ExpenseEntryRow[];
}
export function groupEntries(rows: readonly ExpenseEntryRow[]): EntryGroups {
  const live = rows.filter((r) => !r.voided);
  return {
    general: live.filter((r) => r.counts_as_general),
    elsewhere: ELSEWHERE.map((kind) => { const own = live.filter((r) => r.kind === kind && !r.counts_as_general); return { kind, rows: own, amount_iqd: own.reduce((v, r) => v + r.amount_iqd, 0) }; }).filter((g) => g.rows.length > 0),
    voided: rows.filter((r) => r.voided),
  };
}

/** A category's name in the reader's language; the Arabic stands in for a name never written in English or Sorani. */
export const categoryName = (lang: string, c: ExpenseCategoryNames) => (lang === 'en' ? c.name_en : lang === 'ckb' ? c.name_ckb : '') || c.name_ar;

/** Each category with its share of the general total — the bar's width, 0..1 — and its percent; the percents add up to 100. */
export function categoryShares(categories: readonly ExpenseCategoryTotal[]): Array<ExpenseCategoryTotal & { share: number; percent: number }> {
  const total = categories.reduce((v, c) => v + Math.max(0, c.amount_iqd), 0), percents = sharePercents(categories.map((c) => c.amount_iqd));
  return categories.map((c, i) => ({ ...c, share: total > 0 ? Math.max(0, c.amount_iqd) / total : 0, percent: percents[i] }));
}
