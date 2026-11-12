import type { CsKey } from './costsStrings';
import { sharePercents } from './costFigures';

/**
 * «التكاليف ← المصاريف العامة» — THE PERIOD'S ENTRIES BY WHERE THEY COUNT, PURE (redesign step 5, owner 2026-11-11;
 * DECISIONS row 317). The server classifies every entry (worker/lib/financeExpenseKinds.ts, the fragment /summary reads
 * too) and sums them; this module only arranges its answer for the page: the general entries apart from the rest, the rest
 * grouped by where they count in a fixed order, and each category's share of the general total. tests/financeCostsPages.test.ts.
 *
 * The independent review of step 5: the server lists at most a page of entries (the general ones first), so every sum and
 * every count a heading shows is the totals' — the period's — and a group says how many of its entries are listed; an edit
 * sends only what the owner changed; an entry of a month closed in accounting offers no edit.
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
export type ExpenseTotals = { general_iqd: number; waiting_iqd: number; all_iqd: number; entries: number; by_kind: Record<ExpenseKind, { amount_iqd: number; entries: number }>; by_category: ExpenseCategoryTotal[] };
export interface ExpensesAnswer {
  range: { from: string; to: string };
  rows: ExpenseEntryRow[];
  truncated: boolean;
  totals: ExpenseTotals;
  /** The period's months closed in accounting (absent from a server that predates the review of step 5). */
  closed_months?: string[];
}

/** Where each kind counts, in the words of the page (costsStrings.ts). */
export const KIND_LABEL: Record<ExpenseKind, CsKey> = { general: 'kindGeneral', order_ended: 'kindOrderEnded', promotion: 'kindPromotion', order_cost: 'kindOrderCost',
  collection_fee: 'kindCollectionFee', order_delivered: 'kindOrderDelivered', order_waiting: 'kindOrderWaiting' };
/** The entries that are not general expenses, in the order the page lists them (the plan's table). */
export const ELSEWHERE: readonly ExpenseKind[] = ['promotion', 'order_cost', 'collection_fee', 'order_delivered', 'order_waiting'];
/**
 * An entry the page edits, voids and restores itself. The month's promotion is edited (and stopped or brought back) on its
 * own page, an order's wage or material in its order and a courier's fee in its collection — their expense row is their
 * source's, the database refuses any other change to it, and editing it here would split them.
 */
export const editableHere = (kind: ExpenseKind) => !(['promotion', 'order_cost', 'collection_fee'] as ExpenseKind[]).includes(kind);
/** An entry of a month closed in accounting: nothing about it changes (the database refuses it), so the page offers nothing. */
export const inClosedMonth = (r: Pick<ExpenseEntryRow, 'expense_day'>, closed: readonly string[] = []) => closed.includes(r.expense_day.slice(0, 7));

export interface EntryGroups {
  /** The live entries the statement's «المصاريف العامة» sums, as the server listed them (newest first). */
  general: ExpenseEntryRow[];
  /** How many general entries the period has — more than `general` when the server's page cut them. */
  generalEntries: number;
  /** The other live entries by where they count, in ELSEWHERE's order, each with the period's own sum and count; empty kinds left out. */
  elsewhere: Array<{ kind: ExpenseKind; rows: ExpenseEntryRow[]; amount_iqd: number; entries: number }>;
  /** The voided entries (only when the page asked for them); in no sum. */
  voided: ExpenseEntryRow[];
}
/** The entries by where they count. With the answer's `totals`, each heading's sum and count are the period's, never the listed rows'. */
export function groupEntries(rows: readonly ExpenseEntryRow[], totals?: Pick<ExpenseTotals, 'by_kind'>): EntryGroups {
  const live = rows.filter((r) => !r.voided), general = live.filter((r) => r.counts_as_general);
  const kind = (k: ExpenseKind) => totals?.by_kind?.[k];
  return {
    general,
    generalEntries: totals ? (kind('general')?.entries ?? 0) + (kind('order_ended')?.entries ?? 0) : general.length,
    elsewhere: ELSEWHERE.map((k) => {
      const own = live.filter((r) => r.kind === k && !r.counts_as_general);
      return { kind: k, rows: own, amount_iqd: kind(k)?.amount_iqd ?? own.reduce((v, r) => v + r.amount_iqd, 0), entries: kind(k)?.entries ?? own.length };
    }).filter((g) => g.entries > 0 || g.rows.length > 0),
    voided: rows.filter((r) => r.voided),
  };
}

/** The draft of an entry's edit. */
export interface EntryDraft { category_id: string; amount: string; expense_day: string; title: string }
export const entryDraft = (r: Pick<ExpenseEntryRow, 'category_id' | 'amount_iqd' | 'expense_day' | 'title'>): EntryDraft => ({ category_id: r.category_id, amount: String(r.amount_iqd), expense_day: r.expense_day, title: r.title });
/**
 * WHAT AN EDIT SENDS: only the fields the owner changed (the review of step 5). PATCH /api/admin/finance/expenses/:id keeps
 * every field it is not sent, so an amount corrected elsewhere since the page was read is never written back by an edit
 * of the description. Empty: nothing changed.
 */
export function editPatch(r: EditedFields, d: EntryDraft): Partial<{ category_id: string; amount_iqd: number; expense_day: string; title: string }> {
  const out: Partial<{ category_id: string; amount_iqd: number; expense_day: string; title: string }> = {};
  if (d.category_id !== r.category_id) out.category_id = d.category_id;
  if (d.amount.trim() !== String(r.amount_iqd)) out.amount_iqd = Number(d.amount);
  if (d.expense_day !== r.expense_day) out.expense_day = d.expense_day;
  if (d.title !== r.title) out.title = d.title;
  return out;
}
/** The fields of an entry an edit changes. */
type EditedFields = Pick<ExpenseEntryRow, 'category_id' | 'amount_iqd' | 'expense_day' | 'title'>;
const DRAFT_FIELDS: ReadonlyArray<keyof EntryDraft> = ['category_id', 'amount', 'expense_day', 'title'];
/** A draft's field still holds `value` — an amount with spaces around it is the same amount, as editPatch reads it. */
const holds = (k: keyof EntryDraft, field: string, value: string) => (k === 'amount' ? field.trim() === value : field === value);
/** The fields one reading of an entry has with values another reading does not: what another screen changed meanwhile. */
export const movedFields = (before: EditedFields, now: EditedFields): Array<keyof EntryDraft> => {
  const was = entryDraft(before), is = entryDraft(now);
  return DRAFT_FIELDS.filter((k) => was[k] !== is[k]);
};
/**
 * AN EDITOR KEPT OPEN ACROSS A RE-READ (the checker of step 5's review). The page reads its entries again while an editor stays
 * open — «أظهر الملغاة», the refresh, another entry saved — and another screen may have changed the entry meanwhile: its
 * amount corrected, say. The draft still held the amount the editor opened on, and diffed against the entry read again, an
 * edit of the description sent that old amount back. So the draft follows the entry: each field the owner has not touched
 * (still what `before` had) takes the entry's value `now`, what they typed stays, and the editor diffs against `now`.
 */
export function rebaseDraft(before: EditedFields, now: EditedFields, d: EntryDraft): EntryDraft {
  const was = entryDraft(before), is = entryDraft(now), out = { ...d };
  for (const k of DRAFT_FIELDS) if (holds(k, d[k], was[k])) out[k] = is[k];
  return out;
}
/** What an edit sent, as the entry carries it once it lands (the route trims the description): the draft's own fields. */
export function sentFields(p: ReturnType<typeof editPatch>): Partial<EntryDraft> {
  const out: Partial<EntryDraft> = {};
  if (p.category_id !== undefined) out.category_id = p.category_id;
  if (p.amount_iqd !== undefined) out.amount = String(p.amount_iqd);
  if (p.expense_day !== undefined) out.expense_day = p.expense_day;
  if (p.title !== undefined) out.title = p.title.trim();
  return out;
}
/**
 * THE OWNER'S OWN SAVE IS NOT A CHANGE MADE ELSEWHERE (the checker of step 5's second review). The owner saves a description
 * and opens the editor again before the page's own re-read arrives: it stands on the entry as it was, and when the re-read
 * lands the description just saved read as moved — «تغيّر هذا القيد في مكان آخر» for nothing but the owner's own save.
 * `sent`: what this row last sent (or may have, when the answer never came), as `sentFields` writes it. The moved fields the
 * re-read brings with exactly those values are the owner's own; the rest changed elsewhere.
 */
export const movedElsewhere = (before: EditedFields, now: EditedFields, sent: Partial<EntryDraft>): Array<keyof EntryDraft> => {
  const is = entryDraft(now);
  return movedFields(before, now).filter((k) => sent[k] !== is[k]);
};

/** A category's name in the reader's language; the Arabic stands in for a name never written in English or Sorani. */
export const categoryName = (lang: string, c: ExpenseCategoryNames) => (lang === 'en' ? c.name_en : lang === 'ckb' ? c.name_ckb : '') || c.name_ar;

/** Each category with its share of the general total — the bar's width, 0..1 — and its percent; the percents add up to 100. */
export function categoryShares(categories: readonly ExpenseCategoryTotal[]): Array<ExpenseCategoryTotal & { share: number; percent: number }> {
  const total = categories.reduce((v, c) => v + Math.max(0, c.amount_iqd), 0), percents = sharePercents(categories.map((c) => c.amount_iqd));
  return categories.map((c, i) => ({ ...c, share: total > 0 ? Math.max(0, c.amount_iqd) / total : 0, percent: percents[i] }));
}
