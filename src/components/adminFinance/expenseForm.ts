/**
 * THE ENTRY FORM'S RULES, AS A PURE FUNCTION.
 *
 * `worker/routes/adminFinance.ts` and `worker/lib/financeLedger.ts` REFUSE the
 * numbers a human mistypes rather than coercing them: zero, negative,
 * fractional, absurdly large, a well-shaped non-day like '2026-02-31', a day
 * further than a year out. That server check is the real one and this is not a
 * substitute for it — it is the courtesy that turns a 400 and a form that
 * appears to have done nothing into a sentence under the field the owner is
 * looking at.
 *
 * It is a PURE FUNCTION and not a chain of `&&` inside the JSX for the reason
 * `honesty.ts` gives for the same choice: "the form refuses a negative amount"
 * is a promise that can be asserted as behaviour, while a condition buried in
 * a render tree can only be checked by a regex that passes just as happily
 * when the condition is inverted.
 *
 * A NEGATIVE EXPENSE IS NOT AN EXPENSE. It is a refund — a different fact, on
 * a different side of the ledger — and accepting one would let a mistyped
 * minus sign cancel a real cost with nothing on screen to show it happened.
 * The server says the same thing; both have to, because this file cannot be
 * the gate and that file cannot write the sentence.
 */
import { dayParts, isDay } from './period';

/** The ceiling the server enforces. Larger is a typo, not a transaction. */
export const MAX_EXPENSE_IQD = 999_999_999_999;

/** How far ahead an expense may be dated — prepaid rent is legitimate, '2226' is not. */
export const MAX_FUTURE_DAYS = 366;

/** The most months one entry may be repeated into REAL rows. */
export const MAX_REPEAT_MONTHS = 24;

export type ExpenseProblem =
  | 'no_category'
  | 'amount_not_a_number'
  | 'amount_not_whole'
  | 'amount_not_positive'
  | 'amount_too_large'
  | 'day_not_a_day'
  | 'day_too_far'
  | 'repeat_out_of_range'
  | null;

export interface ExpenseDraft {
  category_id: string;
  /** What is TYPED, not a number: '' and '12.5' are both states the field has. */
  amount: string;
  expense_day: string;
  repeat_months: number;
}

/**
 * The first thing wrong with this draft, or null.
 *
 * `today` is passed in rather than read from a clock, so the "too far ahead"
 * rule can be asserted at a fixed instant — and so this module never calls
 * `new Date()`, which is how a Baghdad day turns into a UTC one three hours a
 * night (see ./period.ts).
 */
export function expenseProblem(draft: ExpenseDraft, today: string): ExpenseProblem {
  if (!draft.category_id) return 'no_category';

  const raw = draft.amount.trim();
  // Number('') is 0 and Number(' ') is 0 — both would sail past a
  // `Number.isFinite` test and be refused later as "zero", which is a
  // confusing sentence to put under an empty field.
  if (raw === '') return 'amount_not_a_number';
  const amount = Number(raw);
  if (!Number.isFinite(amount)) return 'amount_not_a_number';
  if (!Number.isInteger(amount)) return 'amount_not_whole'; // dinars are integers, everywhere
  if (amount <= 0) return 'amount_not_positive';
  if (amount > MAX_EXPENSE_IQD) return 'amount_too_large';

  // `isDay` is a CALENDAR test, not a regex: '2026-02-31' has the right shape
  // and is not a day, and an expense filed on a day that does not exist lands
  // in a month nobody can reconcile.
  if (!isDay(draft.expense_day)) return 'day_not_a_day';
  const d = dayParts(draft.expense_day)!;
  const t = dayParts(today);
  if (t) {
    const ahead = Math.round(
      (Date.UTC(d.y, d.m - 1, d.d) - Date.UTC(t.y, t.m - 1, t.d)) / 86_400_000
    );
    if (ahead > MAX_FUTURE_DAYS) return 'day_too_far';
  }

  if (!Number.isInteger(draft.repeat_months) || draft.repeat_months < 1 || draft.repeat_months > MAX_REPEAT_MONTHS) {
    return 'repeat_out_of_range';
  }
  return null;
}
