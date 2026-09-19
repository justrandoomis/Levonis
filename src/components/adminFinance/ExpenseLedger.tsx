import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import {
  ApiError,
  createExpense,
  createExpenseCategory,
  fetchExpenseCategories,
  fetchExpenses,
  isAborted,
  restoreExpense,
  updateExpenseCategory,
  voidExpense,
  type ExpenseCategory,
  type ExpenseEntry,
} from '../../lib/api';
import { countText, money } from './format';
import { baghdadDay } from './period';
import { expenseProblem, MAX_REPEAT_MONTHS, type ExpenseDraft, type ExpenseProblem } from './expenseForm';
import type { FinanceStrings } from './strings';

/**
 * THE SCREEN THE OWNER ACTUALLY ASKED FOR.
 *
 * «التكلفه على مستوى واحد في تفاصيل المنتج، لكن يستطيع الادمن في لوحه الاداره
 *  اضافه تكاليف اخرى ... لا علاقه لها بالمنتج الاساسي او ما يظهر للمستخدم،
 *  انها خاصه في لوحه الادمن»
 *
 * Product cost is ONE level and lives on the product. Everything else — rent,
 * salaries, advertising, customs, bank fees — is an OPERATING EXPENSE, belongs
 * to no product, is never shown to a customer, and is entered here.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE HAD TO EXIST BEFORE THE DASHBOARD COULD BE HONEST.
 *
 * The server grew eight endpoints for this and the dashboard grew a net-profit
 * hero that subtracts their total. With no screen to write a row, nothing ever
 * called them: `operating_expenses` stayed empty forever,
 * `operating_expenses_iqd` was permanently 0, and «الربح الصافي» equalled
 * «الربح الإجمالي» on every period — a net profit that silently ignores rent
 * and salaries, printed as the headline figure the owner prices against. The
 * honesty panel could not warn about it either: its `no_expense_ledger` notice
 * fires when the TABLE is missing, and the table was there and empty.
 *
 * ---------------------------------------------------------------------------
 * ONE PERIOD FOR BOTH VIEWS.
 *
 * This ledger is scoped by the SAME period control as the report, passed in
 * rather than owned here. A second date picker inside this panel is how the
 * owner ends up reading a March ledger beside an April profit and has no way
 * to know it. Writing a row calls `onChanged`, which re-fetches the report, so
 * the net profit on the other tab moves the moment the expense lands rather
 * than on the next reload.
 *
 * ---------------------------------------------------------------------------
 * REMOVAL IS A VOID AND IT SAYS SO ON THE SCREEN.
 *
 * The row stays with who removed it, when and why, and it can be restored.
 * That is the server's design and the UI must not dress it up as a delete: an
 * owner who believes they erased a row, and later finds it in a report with
 * `include_voided`, has lost trust in both screens at once.
 */

const FIELD = 'lv-input w-full text-[13px] leading-[1.6]';
const LABEL = 'block text-[12px] leading-[1.5] font-bold text-text-secondary';

export default function ExpenseLedger({
  from,
  to,
  s,
  latin,
  dir,
  onChanged,
}: {
  from: string;
  to: string;
  s: FinanceStrings;
  latin: boolean;
  dir: 'rtl' | 'ltr';
  /** The report reads these rows; a write here must move its net profit. */
  onChanged: () => void;
}) {
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [rows, setRows] = useState<ExpenseEntry[]>([]);
  const [totalIqd, setTotalIqd] = useState(0);
  const [count, setCount] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [includeVoided, setIncludeVoided] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  /** The void reason being typed against each row, keyed by expense id. */
  const [pendingReason, setPendingReason] = useState<Record<string, string>>({});

  // The server's own Baghdad day, mirrored client-side by the same arithmetic
  // the period control uses. NEVER `toISOString().slice(0,10)`, which answers
  // yesterday for the first three hours of every Iraqi night and would default
  // tonight's rent to the wrong month.
  const today = useMemo(() => baghdadDay(Date.now()), []);
  const [draft, setDraft] = useState<ExpenseDraft & { title: string; note: string }>(() => ({
    category_id: '',
    amount: '',
    expense_day: baghdadDay(Date.now()),
    repeat_months: 1,
    title: '',
    note: '',
  }));
  const [newCategoryName, setNewCategoryName] = useState('');

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    Promise.all([
      fetchExpenseCategories({ signal: ac.signal }),
      fetchExpenses({ from, to, include_voided: includeVoided, limit: 500 }, { signal: ac.signal }),
    ])
      .then(([cats, page]) => {
        setCategories(cats.categories ?? []);
        setRows(page.expenses ?? []);
        setTotalIqd(page.total_iqd ?? 0);
        setCount(page.count ?? (page.expenses ?? []).length);
        setTruncated(!!page.truncated);
        // The first active category is preselected so the commonest entry is
        // two fields, not three. An empty selection is still a refusal the
        // form explains rather than a silent default to whatever sorts first.
        setDraft((d) =>
          d.category_id ? d : { ...d, category_id: (cats.categories ?? []).find((c) => c.active)?.id ?? '' }
        );
      })
      .catch((e: unknown) => {
        if (isAborted(e)) return;
        setError(e instanceof ApiError ? e.message : s.loadFailed);
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [from, to, includeVoided, reloadKey, s.loadFailed]);

  const problem: ExpenseProblem = expenseProblem(draft, today);
  const problemText = (p: ExpenseProblem): string => {
    switch (p) {
      case 'no_category':
        return s.errNoCategory;
      case 'amount_not_a_number':
        return s.errAmountNotNumber;
      case 'amount_not_whole':
        return s.errAmountNotWhole;
      case 'amount_not_positive':
        return s.errAmountNotPositive;
      case 'amount_too_large':
        return s.errAmountTooLarge;
      case 'day_not_a_day':
        return s.errDayNotADay;
      case 'day_too_far':
        return s.errDayTooFar;
      case 'repeat_out_of_range':
        return s.errRepeat;
      default:
        return '';
    }
  };

  const refresh = useCallback(() => {
    setReloadKey((k) => k + 1);
    onChanged();
  }, [onChanged]);

  const submit = useCallback(async () => {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await createExpense({
        category_id: draft.category_id,
        amount_iqd: Number(draft.amount),
        expense_day: draft.expense_day,
        title: draft.title,
        note: draft.note,
        repeat_months: draft.repeat_months,
      });
      const months = res.ids?.length ?? 1;
      setNotice(months > 1 ? s.savedMany(countText(months, latin)) : s.savedOne);
      // The amount is cleared and the category, the day and the repeat are
      // kept: entering a month of expenses is the same category and day over
      // and over, and re-choosing them each time is how an owner stops using
      // the screen.
      setDraft((d) => ({ ...d, amount: '', title: '', note: '' }));
      refresh();
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.message : s.saveFailed);
    } finally {
      setBusy(false);
    }
  }, [problem, busy, draft, latin, refresh, s]);

  const addCategory = useCallback(async () => {
    const name = newCategoryName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createExpenseCategory({ name_ar: name });
      setNewCategoryName('');
      setNotice(s.categoryAdded);
      setDraft((d) => ({ ...d, category_id: res.category?.id ?? d.category_id }));
      setReloadKey((k) => k + 1);
    } catch (e: unknown) {
      setError(e instanceof ApiError ? e.message : s.saveFailed);
    } finally {
      setBusy(false);
    }
  }, [newCategoryName, busy, s]);

  const toggleCategory = useCallback(
    async (cat: ExpenseCategory) => {
      setBusy(true);
      try {
        await updateExpenseCategory(cat.id, { active: !cat.active });
        setReloadKey((k) => k + 1);
      } catch (e: unknown) {
        setError(e instanceof ApiError ? e.message : s.saveFailed);
      } finally {
        setBusy(false);
      }
    },
    [s.saveFailed]
  );

  const doVoid = useCallback(
    async (row: ExpenseEntry) => {
      // The reason is asked for in the row, not in a `window.confirm`: that
      // dialog cannot be translated and cannot be read right-to-left, so its
      // sentence would be the only part of this panel not in the admin's own
      // language. An empty reason is allowed by the server; the field says
      // what it is for and the audit records whatever was given.
      const reason = pendingReason[row.id] ?? '';
      setBusy(true);
      try {
        await voidExpense(row.id, reason);
        setPendingReason((p) => ({ ...p, [row.id]: '' }));
        refresh();
      } catch (e: unknown) {
        setError(e instanceof ApiError ? e.message : s.saveFailed);
      } finally {
        setBusy(false);
      }
    },
    [pendingReason, refresh, s.saveFailed]
  );

  const doRestore = useCallback(
    async (row: ExpenseEntry) => {
      setBusy(true);
      try {
        await restoreExpense(row.id);
        refresh();
      } catch (e: unknown) {
        setError(e instanceof ApiError ? e.message : s.saveFailed);
      } finally {
        setBusy(false);
      }
    },
    [refresh, s.saveFailed]
  );

  const activeCategories = categories.filter((c) => c.active);

  return (
    <section data-finance-ledger dir={dir} className="min-w-0 space-y-4">
      {/* ---------------------------------------------------- 1. WHAT THIS IS */}
      <header className="lv-surface p-3 sm:p-4">
        <h3 className="text-[15px] leading-[1.4] font-black text-text-primary">{s.ledgerTitle}</h3>
        <p className="mt-1 max-w-[70ch] text-[12px] leading-[1.8] text-text-muted">{s.ledgerIntro}</p>
      </header>

      {/* ------------------------------------------------- 2. THE ENTRY FORM */}
      <form
        data-finance-expense-form
        className="lv-surface space-y-3 p-3 sm:p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h4 className="text-[13px] leading-[1.5] font-black text-text-primary">{s.addExpense}</h4>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="min-w-0">
            <span className={LABEL}>{s.fieldCategory}</span>
            <select
              className={FIELD}
              value={draft.category_id}
              onChange={(e) => setDraft((d) => ({ ...d, category_id: e.target.value }))}
            >
              <option value="">—</option>
              {activeCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name_ar}
                </option>
              ))}
            </select>
          </label>

          <label className="min-w-0">
            <span className={LABEL}>{s.fieldAmount}</span>
            <input
              className={FIELD}
              dir="ltr"
              inputMode="numeric"
              value={draft.amount}
              onChange={(e) => setDraft((d) => ({ ...d, amount: e.target.value }))}
            />
          </label>

          <label className="min-w-0">
            <span className={LABEL}>{s.fieldDay}</span>
            <input
              className={FIELD}
              dir="ltr"
              type="date"
              value={draft.expense_day}
              onChange={(e) => setDraft((d) => ({ ...d, expense_day: e.target.value }))}
            />
          </label>

          <label className="min-w-0">
            <span className={LABEL}>{s.fieldRepeat}</span>
            <input
              className={FIELD}
              dir="ltr"
              inputMode="numeric"
              type="number"
              min={1}
              max={MAX_REPEAT_MONTHS}
              value={draft.repeat_months}
              onChange={(e) => setDraft((d) => ({ ...d, repeat_months: Number(e.target.value) || 1 }))}
            />
          </label>

          <label className="min-w-0 sm:col-span-2">
            <span className={LABEL}>{s.fieldTitle}</span>
            <input
              className={FIELD}
              value={draft.title}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
            />
          </label>

          <label className="min-w-0 sm:col-span-2">
            <span className={LABEL}>{s.fieldNote}</span>
            <input
              className={FIELD}
              value={draft.note}
              onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
            />
          </label>
        </div>

        <p className="max-w-[70ch] text-[11px] leading-[1.7] text-text-muted">{s.repeatMeans}</p>

        {/* The refusal is stated under the form, never as a disabled button
            with no explanation: a button that does nothing and says nothing is
            how an owner concludes the screen is broken. */}
        {problem && (
          <p data-finance-expense-problem className="text-[12px] leading-[1.6] text-danger">
            {problemText(problem)}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={!!problem || busy}
            className="lv-button lv-button-primary press-scale min-h-[44px] px-4 text-[13px] font-bold disabled:opacity-50"
          >
            <Plus className="h-4 w-4" aria-hidden />
            {busy ? s.saving : s.save}
          </button>
          {notice && <span className="text-[12px] leading-[1.6] text-success">{notice}</span>}
          {error && <span className="text-[12px] leading-[1.6] text-danger">{error}</span>}
        </div>
      </form>

      {/* ------------------------------------------------- 3. THE CATEGORIES */}
      <div className="lv-surface space-y-3 p-3 sm:p-4">
        <h4 className="text-[13px] leading-[1.5] font-black text-text-primary">{s.fieldCategory}</h4>
        <div className="flex flex-wrap items-center gap-2">
          {categories.map((c) => (
            <span
              key={c.id}
              className={`inline-flex items-center gap-2 rounded-full border border-border-subtle px-3 py-1 text-[12px] leading-[1.5] ${
                c.active ? 'text-text-primary' : 'text-text-muted line-through'
              }`}
            >
              {c.name_ar}
              <button
                type="button"
                onClick={() => void toggleCategory(c)}
                disabled={busy}
                className="text-[11px] font-bold text-text-muted underline disabled:opacity-50"
              >
                {c.active ? s.deactivate : s.activate}
              </button>
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className={`${FIELD} max-w-[18rem]`}
            placeholder={s.categoryNamePlaceholder}
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
          />
          <button
            type="button"
            onClick={() => void addCategory()}
            disabled={!newCategoryName.trim() || busy}
            className="lv-button lv-button-secondary lv-button-sm press-scale min-h-[44px] disabled:opacity-50"
          >
            {s.newCategory}
          </button>
        </div>
        <p className="text-[11px] leading-[1.7] text-text-muted">{s.noCategoryDelete}</p>
      </div>

      {/* ----------------------------------------------------- 4. THE LEDGER */}
      <div className="lv-surface p-3 sm:p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h4 className="text-[13px] leading-[1.5] font-black text-text-primary">
            {s.periodTotal}:{' '}
            <span dir="ltr" className="tabular-nums">
              {money(totalIqd)}
            </span>
          </h4>
          <label className="flex items-center gap-2 text-[12px] leading-[1.5] text-text-secondary">
            <input
              type="checkbox"
              checked={includeVoided}
              onChange={(e) => setIncludeVoided(e.target.checked)}
            />
            {s.showVoided}
          </label>
        </div>

        {/* The total above is the PERIOD's, from an unbounded SUM on the
            server; the list is a page. When they describe different sets the
            screen says so rather than letting the owner add the rows up and
            find a different number. */}
        {truncated && (
          <p className="mt-1 text-[11px] leading-[1.7] text-warning">
            {s.ledgerTruncated(countText(rows.length, latin), countText(count, latin))}
          </p>
        )}

        {loading && <p className="py-8 text-center text-[13px] text-text-muted">{s.loading}</p>}

        {!loading && rows.length === 0 && (
          <p data-finance-ledger-empty className="mx-auto max-w-[52ch] py-8 text-center text-[13px] leading-[1.9] text-text-secondary">
            {s.ledgerEmpty}
          </p>
        )}

        {!loading && rows.length > 0 && (
          <ul className="mt-2 divide-y divide-border-subtle/60">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2">
                <span dir="ltr" className="text-[12px] leading-[1.6] tabular-nums text-text-muted">
                  {row.expense_day}
                </span>
                <span className="text-[12px] leading-[1.6] font-bold text-text-primary">
                  {row.category_name_ar}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] leading-[1.6] text-text-secondary">
                  {row.title || row.note}
                </span>
                {row.voided && (
                  <span className="rounded-full border border-border-subtle px-2 text-[11px] leading-[1.6] text-warning">
                    {s.voidedBadge}
                    {row.void_reason ? ` — ${row.void_reason}` : ''}
                  </span>
                )}
                <span
                  dir="ltr"
                  className={`text-[12px] leading-[1.6] tabular-nums ${
                    row.voided ? 'text-text-muted line-through' : 'text-text-primary'
                  }`}
                >
                  {money(row.amount_iqd)}
                </span>
                {row.voided ? (
                  <button
                    type="button"
                    onClick={() => void doRestore(row)}
                    disabled={busy}
                    className="lv-button lv-button-secondary lv-button-sm press-scale disabled:opacity-50"
                  >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                    {s.restoreAction}
                  </button>
                ) : (
                  <span className="flex items-center gap-1.5">
                    <input
                      className="lv-input w-[10rem] text-[12px] leading-[1.6]"
                      placeholder={s.voidReason}
                      value={pendingReason[row.id] ?? ''}
                      onChange={(e) => setPendingReason((p) => ({ ...p, [row.id]: e.target.value }))}
                    />
                    <button
                      type="button"
                      onClick={() => void doVoid(row)}
                      disabled={busy}
                      className="lv-button lv-button-secondary lv-button-sm press-scale disabled:opacity-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      {s.voidAction}
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        <p className="mt-3 max-w-[70ch] text-[11px] leading-[1.7] text-text-muted">{s.voidMeans}</p>
      </div>
    </section>
  );
}
