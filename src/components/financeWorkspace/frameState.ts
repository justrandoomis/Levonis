import type { FinanceSection, FinanceSummary } from './types';

/**
 * WHAT THE FRAME OF «المال والأرباح» REMEMBERS (redesign step 2, owner 2026-11-11; DECISIONS row 315).
 * Pure, so tests/financeOverviewScreen.test.ts drives it exactly as the screen does.
 *
 * THE PERIOD'S SUMMARY. One read of /summary serves the overview, the products and the badges.
 * Each read is tagged with what it was read for — the period and the display currency — and a
 * read is shown only under that period and currency. While another one loads, the last figures
 * stay on screen, dimmed and without a comparison; if that read fails they go, and the error
 * stands alone: the owner never sees one period's figures under another's dates, nor dinars
 * under the dollar toggle (independent review, 2026-11-11). A refresh of the SAME period that
 * fails keeps its figures — they are that period's — with the time they were read.
 *
 * THE KEPT PAGES. A page the owner leaves stays mounted and hidden, so coming back to it is
 * instant and costs no read — until what it shows may have changed: another period or currency,
 * any save in the workspace or «تحديث» (the refresh revision), or KEEP_MS since it was left (a
 * withdrawal request or a payment made elsewhere). Then it is read afresh when shown. Accounting
 * is never kept: its tools open on demand.
 */
export const summaryKey = (from: string, to: string, display: string) => `${from}|${to}|${display}`;
export interface SummaryRead { key: string; data: FinanceSummary; at: string }
/** The last successful read, the read in flight (its key), and the last read's error. */
export interface SummaryState { read: SummaryRead | null; loading: string | null; error: string }
export type SummaryEvent = { type: 'start'; key: string } | { type: 'loaded'; key: string; data: FinanceSummary; at: string } | { type: 'failed'; key: string; error: string };
export const NO_SUMMARY: SummaryState = { read: null, loading: null, error: '' };

export function summaryReducer(state: SummaryState, event: SummaryEvent): SummaryState {
  switch (event.type) {
    case 'start': return { ...state, loading: event.key, error: '' };
    case 'loaded': return { read: { key: event.key, data: event.data, at: event.at }, loading: state.loading === event.key ? null : state.loading, error: '' };
    // A failed read of another period or currency drops the figures it would have replaced.
    case 'failed': return { read: state.read?.key === event.key ? state.read : null, loading: state.loading === event.key ? null : state.loading, error: event.error };
  }
}

/** What the screen shows under `key`: its own read (`current`); while `key` loads, the last read, dimmed; otherwise nothing. */
export function summaryShown(state: SummaryState, key: string): { data: FinanceSummary | null; current: boolean; at: string } {
  if (state.read?.key === key) return { data: state.read.data, current: true, at: state.read.at };
  if (state.read && state.loading === key) return { data: state.read.data, current: false, at: '' };
  return { data: null, current: false, at: '' };
}

/** The badges («التكاليف 19») count the period's lines whatever the currency: a dollar read in flight does not hide them. */
export function missingBadge(state: SummaryState, from: string, to: string): number {
  return state.read?.key.startsWith(`${from}|${to}|`) ? state.read.data.missing_costs?.lines ?? 0 : 0;
}

export const KEEP_MS = 2 * 60_000;
/** Kept pages last while the period, the currency and every figure (the refresh revision) stay as they were. */
export const keepKey = (from: string, to: string, display: string, revision: number) => `${from}|${to}|${display}|${revision}`;
/** The pages kept hidden under `key`, each with when it was left; and how many times each page has been read afresh. */
export interface Kept { key: string; left: Partial<Record<FinanceSection, number>>; mounts: Partial<Record<FinanceSection, number>> }
export const NOTHING_KEPT: Kept = { key: '', left: {}, mounts: {} };

/**
 * The owner moves from page `from` to page `to` at `now` under `key`: `from` is kept (unless it is
 * never kept); `to` is shown, and read afresh — mounted again — when it was kept longer than KEEP_MS.
 */
export function navigate(kept: Kept, key: string, from: FinanceSection, to: FinanceSection, now: number, keepable: (page: FinanceSection) => boolean): Kept {
  const left = { ...(kept.key === key ? kept.left : {}) };
  const leftAt = left[to];
  delete left[to];
  if (from !== to && keepable(from)) left[from] = now;
  const stale = leftAt !== undefined && now - leftAt > KEEP_MS;
  return { key, left, mounts: stale ? { ...kept.mounts, [to]: (kept.mounts[to] ?? 0) + 1 } : kept.mounts };
}
/** The pages kept, hidden, under `key` (none once the key has moved on). */
export const keptPages = (kept: Kept, key: string): FinanceSection[] => (kept.key === key ? Object.keys(kept.left) as FinanceSection[] : []);
/** A page's React key: a new one mounts it again, which reads it afresh. */
export const pageMount = (kept: Kept, page: FinanceSection) => `${page}:${kept.mounts[page] ?? 0}`;

/**
 * The comparison period's read, kept per comparison key (period, comparison, currency, refresh); `data`
 * null when it failed — the overview then says there is no comparison rather than staying silent.
 */
export type ComparisonRead = { key: string; data: FinanceSummary | null } | null;
export function comparisonFor(read: ComparisonRead, key: string): { data: FinanceSummary | null; failed: boolean; wanted: boolean } {
  if (!key) return { data: null, failed: false, wanted: false };
  if (read?.key !== key) return { data: null, failed: false, wanted: true };
  return { data: read.data, failed: read.data === null, wanted: false };
}
