/**
 * «تسوية الأجور» — THE OWNER'S SCREEN SIDE (DECISIONS row 306).
 *
 * The server (worker/lib/staffSettlement.ts) agrees ONE amount still owed for
 * every order an employee earned on before a day. This module is what the
 * dialog sends and how it reads the answer: the day bounds it allows, the
 * preview, the apply (with the preview's `owed_before_iqd` and one operation
 * id, so a retried request returns the settlement it made), and the server's
 * refusals by code. No React and no stylesheet, so the tests drive it against
 * a test database (tests/wageSettlementDialog.test.ts).
 */
import { api, ApiError } from '../../lib/api';
import type { Language } from '../../translations';
import type { SettleRefusalKey } from '../../lib/personFinanceStrings';

/** The finance people routes (shared.tsx's PEOPLE; that module pulls a stylesheet). */
const settlePath = (staffId: string) => `/api/admin/finance-people/staff/${encodeURIComponent(staffId)}/settle`;

export interface SettlementInput { through_day: string; owed_iqd: number; reason: string }
export interface SettlementInvestor { user_id: string; name: string; share_bps: number[]; order_ids: string[]; wage_change_iqd: number; profit_change_iqd: number }
export interface SettlementPreview {
  staff_id: string; through_day: string; owed_iqd: number;
  earned_before_iqd: number; paid_before_iqd: number; owed_before_iqd: number;
  rows: number; adjusted: number; reversed: number; change_iqd: number;
  order_changes: Array<{ order_id: string; before_iqd: number; after_iqd: number }>;
  investors: SettlementInvestor[];
}
export interface SettlementDone { already: boolean; through_day: string; owed_iqd: number }
export interface LastSettlement { through_day: string; owed_iqd: number }

/** Today in Baghdad, the day the server compares `through_day` with. */
export const baghdadToday = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Baghdad', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const shift = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
/** A settlement covers orders delivered BEFORE its day: the last settled day is the one before. */
export const lastSettledDay = (throughDay: string) => shift(throughDay, -1);

/** The days the owner may choose: after the last settlement, today at most. `open` is false when none is left today. */
export function settlementDays(today: string, last: LastSettlement | null) {
  const min = last ? shift(last.through_day, 1) : null;
  return { min, max: today, open: !min || min <= today };
}

export type SettlementProblem = 'day' | 'future' | 'settled' | 'amount' | 'reason';
/** What keeps the form from a preview, if anything (the server checks again). */
export function settlementProblem(input: { through_day: string; owed_iqd: number | null; reason: string }, days: ReturnType<typeof settlementDays>): SettlementProblem | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.through_day) || Number.isNaN(Date.parse(`${input.through_day}T00:00:00Z`))) return 'day';
  if (input.through_day > days.max) return 'future';
  if (days.min && input.through_day < days.min) return 'settled';
  if (input.owed_iqd === null || !Number.isSafeInteger(input.owed_iqd) || input.owed_iqd < 0) return 'amount';
  if (input.reason.trim().length < 3) return 'reason';
  return null;
}

const body = (input: SettlementInput) => ({ through_day: input.through_day, owed_iqd: input.owed_iqd, reason: input.reason.trim() });

/** What the settlement would change; writes nothing. */
export async function previewSettlement(staffId: string, input: SettlementInput): Promise<SettlementPreview> {
  const answer = await api.post<{ preview: SettlementPreview }>(settlePath(staffId), { ...body(input), preview: true }, { mascot: 'silent' });
  return { ...answer.preview, investors: answer.preview.investors ?? [] };
}

/** Applies exactly the previewed settlement (its day and amount). The server
 * refuses if the wages moved since the preview (`expected_owed_before_iqd`), and
 * answers a retry with the same `operation_id` with the settlement it already made. */
export async function applySettlement(staffId: string, preview: SettlementPreview, reason: string, operationId: string): Promise<SettlementDone> {
  const answer = await api.post<{ already?: boolean; settlement: { through_day: string; owed_iqd: number } }>(settlePath(staffId), {
    ...body({ through_day: preview.through_day, owed_iqd: preview.owed_iqd, reason }), preview: false, expected_owed_before_iqd: preview.owed_before_iqd, operation_id: operationId,
  });
  return { already: answer.already === true, through_day: answer.settlement.through_day, owed_iqd: answer.settlement.owed_iqd };
}

const REFUSALS: Record<string, SettleRefusalKey> = {
  SETTLE_WITHDRAWAL_OPEN: 'withdrawal',
  SETTLE_ADVANCE_OPEN: 'advance',
  SETTLE_RECALCULATING: 'recalculation',
  SETTLE_ALREADY_SETTLED: 'settled',
  SETTLE_CHANGED: 'changed',
  SETTLE_FUTURE_DAY: 'future',
  SETTLE_NO_WAGES: 'noWages',
  SETTLE_PAID_UNPRICED: 'unpriced',
  SETTLE_OPERATION_REUSED: 'reused',
};
/** The refusal the dialog says in the reader's language, or null (the server's own words then). */
export function settlementRefusal(error: unknown): SettleRefusalKey | null {
  return error instanceof ApiError && error.code ? REFUSALS[error.code] ?? null : null;
}

/** «75,000 د.ع» / «75,000 IQD», as the screen's Money writes it. */
export const moneyText = (value: number, lang: Language) => `${value.toLocaleString('en-US')} ${lang === 'en' ? 'IQD' : 'د.ع'}`;
/** A day as the people screens write it (shared.tsx dateLabel). */
export const dayText = (day: string, lang: Language) => new Date(`${day}T00:00:00Z`).toLocaleDateString(lang === 'en' ? 'en-GB' : 'ar-IQ', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Baghdad' });
