import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDownToLine, Info, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { api, ApiError, type ExpenseCategory } from '../../lib/api';
import { fetchExpenseCategories, restoreExpense, updateExpense, voidExpense } from '../../lib/financeApi';
import { useLanguage } from '../../LanguageContext';
import ExpenseLedger from '../adminFinance/ExpenseLedger';
import { financeStrings } from '../adminFinance/strings';
import { isLatin } from '../adminFinance/format';
import { baghdadDay } from '../adminFinance/period';
import { expenseProblem, type ExpenseProblem } from '../adminFinance/expenseForm';
import { Button, Empty, Field, formatMoney, Loading, Money, Status, Surface } from './ui';
import { WORKSPACE_API, type FinanceSection } from './types';
import { cs } from './costsStrings';
import { dayIn, fw, rangeText } from './overviewStrings';
import { rs } from './reportStrings';
import { categoryName, categoryShares, editableHere, groupEntries, KIND_LABEL, type ExpenseEntryRow, type ExpensesAnswer } from './expenseKinds';
import { percentText } from './costFigures';

/**
 * «التكاليف ← المصاريف العامة» (redesign step 5, owner 2026-11-11; DECISIONS row 317) — rent and the like were hidden in a
 * collapsed box of «تكاليف الشهر».
 *
 * THE TOTAL IS THE STATEMENT'S: GET /expenses sums the period from the one statement /summary reads too, so «المصاريف العامة»
 * here, on the overview's statement line and in its drawer is one number. Under the «i», what counts as one: in full on the
 * day it is entered (owner default 5.7.1), and an entry tagged to a cost centre stays here, as today (5.7.3 is still open).
 * Beside it, every entry of the period and where the rest count — so the owner never reads two different numbers both
 * called "expenses" (the plan's risk 5.6): the ledger's total of every entry is the general figure plus what counts elsewhere.
 * BY CATEGORY with share bars (the old report's expenses card), then THE ENTRIES — day, category, description, amount, cost
 * centre — each edited, voided or restored as in the ledger (the same /api/admin/finance calls); a new one is added with
 * the ledger's own form, which the old report still shares until step 6. THE OTHER ENTRIES of the period apart, each labelled
 * with where it counts and opening it: the month's promotion, an order's wage or material, a courier's fee, a cost linked to a
 * delivered order or to one on its way. The file: `export.csv?view=expenses`.
 */
type Lang = 'ar' | 'en' | 'ckb';
type OpenOrder = (id: string) => void;

type Actions = { onChanged: () => void; openOrder: OpenOrder; onNavigate: (section: FinanceSection) => void };
export default function GeneralExpenses({ from, to, revision = 0, ...actions }: Actions & { from: string; to: string; revision?: number }) {
  const [data, setData] = useState<ExpensesAnswer | null>(null);
  const [error, setError] = useState('');
  const [showVoided, setShowVoided] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    api.get<ExpensesAnswer>(`${WORKSPACE_API}/expenses?from=${from}&to=${to}${showVoided ? '&include_voided=1' : ''}`, { signal: controller.signal })
      .then((r) => { if (!controller.signal.aborted) setData(r); })
      .catch((e) => { if (!controller.signal.aborted) { setData(null); setError(e instanceof Error ? e.message : String(e)); } });
    return () => controller.abort();
  }, [from, to, showVoided, revision]);
  // Only the read of the period on screen: another period's entries never stand under these dates.
  const shown = data && data.range?.from === from && data.range?.to === to ? data : null;
  return <ExpensesView data={shown} error={error} from={from} to={to} showVoided={showVoided} onShowVoided={setShowVoided} {...actions} />;
}

/** The page drawn from one answer of GET /expenses (its own component, so a test can draw it on a server answer). */
export function ExpensesView({ data: shown, error, from, to, showVoided, onShowVoided, onChanged, openOrder, onNavigate }: Actions & {
  data: ExpensesAnswer | null; error: string; from: string; to: string; showVoided: boolean; onShowVoided: (show: boolean) => void;
}) {
  const { loc, lang, dir } = useLanguage();
  const L = lang as Lang;
  const s = useMemo(() => financeStrings(loc), [loc]);
  const [adding, setAdding] = useState(false);
  const [about, setAbout] = useState(false);
  const [categories, setCategories] = useState<ExpenseCategory[] | null>(null);
  // The categories, for an edit's select: read once, when the owner first edits an entry.
  const needCategories = useCallback(() => {
    if (categories) return;
    fetchExpenseCategories().then((r) => setCategories(r.categories ?? [])).catch(() => setCategories([]));
  }, [categories]);
  const groups = useMemo(() => groupEntries(shown?.rows ?? []), [shown]);
  const t = shown?.totals;
  const entry = (r: ExpenseEntryRow) => <EntryRow key={r.id} r={r} categories={categories} needCategories={needCategories} onChanged={onChanged} openOrder={openOrder} onNavigate={onNavigate} />;
  const form = adding && <Surface title={cs(loc, 'genAdd')}><ExpenseLedger formOnly from={from} to={to} s={s} latin={isLatin(lang)} dir={dir === 'rtl' ? 'rtl' : 'ltr'} onChanged={onChanged} /></Surface>;
  return <>
    <Surface title={fw(loc, 'expenses')} subtitle={<bdi>{rangeText(L, from, to)}</bdi>}
      action={<a className="fw-button fw-button--ghost" href={`${WORKSPACE_API}/export.csv?from=${from}&to=${to}&view=expenses`} data-finance-expenses-export><ArrowDownToLine size={16} aria-hidden /><span>{fw(loc, 'exportCsv')}</span></a>}>
      <div className="fw-list fw-chips-wrap" data-finance-expenses>
        {error && <div className="fw-error" role="alert">{error}</div>}
        {!shown && !error && <Loading text={cs(loc, 'genLoading')} />}
        {shown && t && <>
          <div className="fw-drawer-total" data-finance-expenses-total={t.general_iqd}><strong><Money value={t.general_iqd} /></strong><small className="fw-muted">{cs(loc, 'genSame')}</small>
            <button type="button" className="fw-pill" aria-expanded={about} aria-label={cs(loc, 'genWhat')} title={cs(loc, 'genWhat')} onClick={() => setAbout((v) => !v)} data-finance-expenses-about><Info size={15} aria-hidden /></button></div>
          {about && <p className="fw-formula" data-finance-expenses-definition>{cs(loc, 'genDefinition')} {cs(loc, 'genCentreRule')}</p>}
          {t.all_iqd !== t.general_iqd && <p className="fw-note" data-finance-expenses-all>{cs(loc, 'genAll', { all: formatMoney(t.all_iqd), general: formatMoney(t.general_iqd), elsewhere: formatMoney(t.all_iqd - t.general_iqd) })}</p>}
          {!groups.general.length ? <Empty title={cs(loc, 'genEmpty')} text={cs(loc, 'genEmptyNote')} action={<Button variant="primary" onClick={() => setAdding(true)} data-finance-expenses-add-empty><Plus size={16} aria-hidden />{fw(loc, 'add')}</Button>} /> : <>
            <h3>{cs(loc, 'genByCategory')}</h3>
            <ul className="fw-rows" data-finance-expenses-categories>{categoryShares(t.by_category).map((c) => <li key={c.category_id}><div>
              <span className="fw-rows-a">{categoryName(lang, c)}</span><span className="fw-rows-b"><Money value={c.amount_iqd} /></span>
              <span className="fw-rows-c"><span className="fw-gbar" style={{ width: 120 }}><i style={{ width: `${(c.share * 100).toFixed(1)}%` }} /></span> <bdi dir="ltr" className="fw-num">{percentText(c.percent)}</bdi></span></div></li>)}</ul>
            <h3>{cs(loc, 'genEntries')}</h3>
            <ul className="fw-rows" data-finance-expenses-entries>{groups.general.map(entry)}</ul>
          </>}
          {shown.truncated && <p className="fw-note">{cs(loc, 'genTruncated', { n: shown.rows.length })}</p>}
          <div className="fw-fields">
            {groups.general.length > 0 && <Button onClick={() => setAdding((v) => !v)} aria-expanded={adding} data-finance-expenses-add><Plus size={16} aria-hidden />{cs(loc, 'genAdd')}</Button>}
            <label className="fw-chip"><input type="checkbox" checked={showVoided} onChange={(e) => onShowVoided(e.target.checked)} />{s.showVoided}</label>
          </div>
          {groups.voided.length > 0 && <ul className="fw-rows" data-finance-expenses-voided>{groups.voided.map(entry)}</ul>}
        </>}
      </div>
    </Surface>
    {form}
    {groups.elsewhere.length > 0 && <Surface title={cs(loc, 'genElsewhere')} subtitle={cs(loc, 'genElsewhereNote')}>
      <div className="fw-list fw-chips-wrap" data-finance-expenses-elsewhere>{groups.elsewhere.map((g) => <section key={g.kind} className="fw-list" data-finance-expense-kind={g.kind}>
        <h3><Status>{cs(loc, KIND_LABEL[g.kind])}</Status> <Money value={g.amount_iqd} /></h3>
        <ul className="fw-rows">{g.rows.map(entry)}</ul></section>)}</div>
    </Surface>}
  </>;
}

/** One entry: what, when, where it counts, and — for an entry kept here — edit and void, or restore once voided. */
function EntryRow({ r, categories, needCategories, onChanged, openOrder, onNavigate }: {
  r: ExpenseEntryRow; categories: ExpenseCategory[] | null; needCategories: () => void; onChanged: () => void; openOrder: OpenOrder; onNavigate: (section: FinanceSection) => void;
}) {
  const { loc, lang } = useLanguage();
  const L = lang as Lang;
  const s = useMemo(() => financeStrings(loc), [loc]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ category_id: r.category_id, amount: String(r.amount_iqd), expense_day: r.expense_day, title: r.title });
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const problem: ExpenseProblem = expenseProblem({ ...draft, repeat_months: 1 }, baghdadDay(Date.now()));
  const problems: Record<Exclude<ExpenseProblem, null>, string> = { no_category: s.errNoCategory, amount_not_a_number: s.errAmountNotNumber, amount_not_whole: s.errAmountNotWhole,
    amount_not_positive: s.errAmountNotPositive, amount_too_large: s.errAmountTooLarge, day_not_a_day: s.errDayNotADay, day_too_far: s.errDayTooFar, repeat_out_of_range: s.errRepeat };
  const run = async (write: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await write(); setEditing(false); onChanged(); }
    catch (e) { setError(e instanceof ApiError ? e.message : s.saveFailed); }
    finally { setBusy(false); }
  };
  const where = r.kind === 'promotion' ? <button type="button" className="fw-link" onClick={() => onNavigate('monthly')}>{rs(loc, 'openPromotion')}</button>
    : r.order_id ? <button type="button" className="fw-link" dir="ltr" onClick={() => openOrder(r.order_id!)} aria-label={rs(loc, 'openOrder', { id: r.order_id })}>{r.order_id}</button> : null;
  const own = editableHere(r.kind);
  return <li data-finance-expense={r.id} data-finance-expense-kind={r.kind}><div>
    <span className="fw-rows-a">{r.title || <span className="fw-muted">{cs(loc, 'genNoTitle')}</span>}</span>
    <span className="fw-rows-b" style={r.voided ? { textDecoration: 'line-through' } : undefined}><Money value={r.amount_iqd} /></span>
    <span className="fw-rows-c">{dayIn(L, r.expense_day)} · {categoryName(lang, r.category)}
      {r.center_name && <> · <Status>{cs(loc, 'genCentre', { name: r.center_name })}</Status></>}
      {r.kind === 'order_ended' && <> · <Status tone="warning">{cs(loc, 'kindOrderEnded')}</Status></>}
      {where && <> · {where}</>}
      {r.voided && <> · <Status tone="warning">{s.voidedBadge}{r.void_reason ? ` — ${r.void_reason}` : ''}</Status></>}
      {/* Its source's: said in the line, so the description keeps the row's width on a phone. */}
      {!own && !r.voided && <> · {cs(loc, 'genEditedElsewhere')}</>}</span>
    {(r.voided || own) && <span className="fw-rows-e">{r.voided
      ? <Button variant="ghost" busy={busy} onClick={() => void run(() => restoreExpense(r.id))}><RotateCcw size={14} aria-hidden />{s.restoreAction}</Button>
      : <Button variant="ghost" aria-expanded={editing} onClick={() => { setEditing((v) => !v); needCategories(); }} data-finance-expense-edit>{cs(loc, 'genEdit')}</Button>}</span>}
  </div>
    {error && !editing && <p className="fw-error" role="alert">{error}</p>}
    {/* A section, not a div: `.fw-rows li>div` is the row's own two-column grid. */}
    {editing && <section className="fw-inline-editor" style={{ margin: '0 12px 12px' }} data-finance-expense-editor>
      <div className="fw-fields">
        <Field label={s.fieldAmount}><input className="fw-input" dir="ltr" inputMode="numeric" value={draft.amount} onChange={(e) => setDraft((d) => ({ ...d, amount: e.target.value }))} /></Field>
        <Field label={s.fieldDay}><input className="fw-input" dir="ltr" type="date" lang={L === 'en' ? 'en-GB' : 'ar-IQ'} value={draft.expense_day} onChange={(e) => setDraft((d) => ({ ...d, expense_day: e.target.value }))} /></Field>
        <Field label={s.fieldCategory}><select className="fw-select" value={draft.category_id} onChange={(e) => setDraft((d) => ({ ...d, category_id: e.target.value }))}>
          {!(categories ?? []).some((c) => c.id === draft.category_id) && <option value={draft.category_id}>{categoryName(lang, r.category)}</option>}
          {(categories ?? []).filter((c) => c.active || c.id === draft.category_id).map((c) => <option key={c.id} value={c.id}>{categoryName(lang, c)}</option>)}</select></Field>
        <Field label={s.fieldTitle}><input className="fw-input" value={draft.title} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} /></Field>
      </div>
      {problem && <p className="fw-error" role="alert">{problems[problem]}</p>}
      {error && <p className="fw-error" role="alert">{error}</p>}
      <div className="fw-inline-editor-actions">
        <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>{cs(loc, 'genCancel')}</Button>
        <Button variant="primary" busy={busy} disabled={!!problem} onClick={() => void run(() => updateExpense(r.id, { category_id: draft.category_id, amount_iqd: Number(draft.amount), expense_day: draft.expense_day, title: draft.title }))}>{cs(loc, 'genSave')}</Button>
      </div>
      <div className="fw-fields">
        <Field label={s.voidReason}><input className="fw-input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <Button variant="danger" busy={busy} onClick={() => void run(() => voidExpense(r.id, reason))} data-finance-expense-void><Trash2 size={14} aria-hidden />{s.voidAction}</Button>
      </div>
      <p className="fw-note">{s.voidMeans}</p>
    </section>}
  </li>;
}

/**
 * The figure drawer's «المصاريف العامة» line (redesign step 5): the period's general entries — day, category, description,
 * amount — and their total, the period's general figure. In step 4 the line only linked to this page.
 */
export function GeneralEntryList({ rows, total, from, to }: { rows: readonly ExpenseEntryRow[]; total: number; from: string; to: string }) {
  const { loc, lang } = useLanguage();
  const L = lang as Lang;
  const general = rows.filter((r) => r.counts_as_general && !r.voided);
  return <div className="fw-list fw-chips-wrap" data-finance-drawer-entries={general.length}>
    <h3>{cs(loc, 'drawerEntries')}</h3>
    <p className="fw-note">{cs(loc, 'drawerEntriesNote', { total: formatMoney(total) })}</p>
    {general.length ? <ul className="fw-rows">{general.map((r) => <li key={r.id} data-finance-drawer-entry={r.id}><div>
      <span className="fw-rows-a">{r.title || cs(loc, 'genNoTitle')}</span><span className="fw-rows-b"><Money value={r.amount_iqd} /></span>
      <span className="fw-rows-c">{dayIn(L, r.expense_day, { from, to })} · {categoryName(lang, r.category)}{r.center_name ? ` · ${cs(loc, 'genCentre', { name: r.center_name })}` : ''}</span></div></li>)}
      <li className="fw-rows-total"><span>{rs(loc, 'total')}</span><b><Money value={total} /></b></li></ul>
      : <p className="fw-note" role="status">{cs(loc, 'genEmpty')}</p>}
  </div>;
}
/** The drawer's general entries, read for the period the drawer stands on. */
export function DrawerGeneralEntries({ from, to }: { from: string; to: string }) {
  const { loc } = useLanguage();
  const [data, setData] = useState<ExpensesAnswer | null>(null);
  const [failed, setFailed] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    api.get<ExpensesAnswer>(`${WORKSPACE_API}/expenses?from=${from}&to=${to}`, { signal: controller.signal, mascot: 'silent' })
      .then((r) => { if (!controller.signal.aborted) setData(r); })
      .catch((e) => { if (!controller.signal.aborted) setFailed(e instanceof Error ? e.message : String(e)); });
    return () => controller.abort();
  }, [from, to]);
  if (failed) return <p className="fw-error" role="alert">{failed}</p>;
  if (!data) return <Loading text={cs(loc, 'genLoading')} />;
  return <GeneralEntryList rows={data.rows} total={data.totals.general_iqd} from={from} to={to} />;
}
