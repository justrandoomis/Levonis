import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { WORKSPACE_API } from './types';
import { cs, refusalWords, type CsKey } from './costsStrings';
import { dayIn, fw, monthText, rangeText } from './overviewStrings';
import { rs } from './reportStrings';
import { Amount } from './Reports';
import { categoryName, categoryShares, editableHere, editPatch, entryDraft, groupEntries, inClosedMonth, KIND_LABEL, movedFields, rebaseDraft, type ExpenseEntryRow, type ExpensesAnswer } from './expenseKinds';
import { percentText } from './costFigures';

/**
 * «التكاليف ← المصاريف العامة» (redesign step 5, owner 2026-11-11; DECISIONS row 317) — rent and the like were hidden in a
 * collapsed box of «تكاليف الشهر».
 *
 * THE TOTAL IS THE STATEMENT'S: GET /expenses sums the period from the one statement /summary reads too, so «المصاريف العامة»
 * here, on the overview's statement line and in its drawer is one number (in dinars: this page is a dinar page whatever the
 * overview's currency). Under the «i», what counts as one: in full on the expense's own day (owner default 5.7.1), and an
 * entry tagged to a cost centre stays here, as today (5.7.3 is still open). Beside it, every entry of the period and where the
 * rest count — so the owner never reads two different numbers both called "expenses" (the plan's risk 5.6): the ledger's total
 * of every entry is the general figure plus what counts elsewhere. BY CATEGORY with share bars (the old report's expenses
 * card), then THE ENTRIES — day, category, description, amount, cost centre — each edited, voided or restored as in the
 * ledger (the same /api/admin/finance calls); a new one is added with the ledger's own form, which the old report still
 * shares until step 6. THE OTHER ENTRIES of the period apart, each labelled with where it counts and opening it: the month's
 * promotion, an order's wage or material, a courier's fee, a cost linked to a delivered order or to one on its way. The file:
 * `export.csv?view=expenses`.
 *
 * The independent review of step 5: whether there are general entries, the category bars and every group's sum and count
 * come from the period's totals — the server lists a page of entries (the general ones first), and a cut list says how much
 * of it is shown; an edit opens on the entry as it is now, sends only what changed, and closes back on «تعديل» (Escape too);
 * voiding asks first and says what leaves which figure; a voided promotion, wage or courier fee is brought back at its
 * source, never here; a month closed in accounting offers no edit; a refusal is said in the reader's language.
 */
type Lang = 'ar' | 'en' | 'ckb';
type OpenOrder = (id: string) => void;

/** A sentence of the table with nodes in its {placeholders}: an amount kept whole on one line, in its own direction. */
function csNodes(loc: (ar: string, en: string, ckb?: string) => string, key: CsKey, vars: Record<string, ReactNode>): ReactNode {
  return cs(loc, key).split(/\{(\w+)\}/g).map((part, i) => (i % 2 ? <bdi key={i} style={{ whiteSpace: 'nowrap' }}>{vars[part] ?? `{${part}}`}</bdi> : <Fragment key={i}>{part}</Fragment>));
}

type Actions = { onChanged: () => void; openOrder: OpenOrder; onPromotion: (month: string) => void };
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
export function ExpensesView({ data: shown, error, from, to, showVoided, onShowVoided, onChanged, openOrder, onPromotion }: Actions & {
  data: ExpensesAnswer | null; error: string; from: string; to: string; showVoided: boolean; onShowVoided: (show: boolean) => void;
}) {
  const { loc, lang, dir } = useLanguage();
  const L = lang as Lang;
  const s = useMemo(() => financeStrings(loc), [loc]);
  const [adding, setAdding] = useState(false);
  const [about, setAbout] = useState(false);
  const [categories, setCategories] = useState<ExpenseCategory[] | null>(null);
  // The categories, for an edit's select: read each time an editor opens, so one added on the form just now is offered too.
  const needCategories = useCallback(() => {
    fetchExpenseCategories().then((r) => setCategories(r.categories ?? [])).catch(() => setCategories((c) => c ?? []));
  }, []);
  const t = shown?.totals;
  const groups = useMemo(() => groupEntries(shown?.rows ?? [], shown?.totals), [shown]);
  const closed = shown?.closed_months ?? [];
  // Whether the period has a general expense is the totals' answer, never the listed rows' (the page lists the general ones
  // first, but only a page of entries): an empty state beside a total that is not zero is the review's own finding.
  const hasGeneral = !!t && (groups.generalEntries > 0 || t.general_iqd !== 0);
  const range = { from, to };
  const entry = (r: ExpenseEntryRow) => <EntryRow key={r.id} r={r} range={range} closed={closed} categories={categories} needCategories={needCategories} onChanged={onChanged} openOrder={openOrder} onPromotion={onPromotion} />;
  // «أضف» opens the ledger's form and closes it again, from the empty state too.
  const toggleAdd = () => setAdding((v) => !v);
  const form = adding && <Surface title={cs(loc, 'genAdd')}><ExpenseLedger formOnly from={from} to={to} s={s} latin={isLatin(lang)} dir={dir === 'rtl' ? 'rtl' : 'ltr'} onChanged={onChanged}
    categoryLabel={(c) => categoryName(lang, c)} categoryPrompt={cs(loc, 'genCategoryPick')} errorText={(e) => refusalWords(loc, lang, e, e instanceof ApiError && !e.code ? e.message : s.saveFailed)} /></Surface>;
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
          {t.all_iqd !== t.general_iqd && <p className="fw-note" data-finance-expenses-all>{csNodes(loc, 'genAll', { all: <Money value={t.all_iqd} />, general: <Money value={t.general_iqd} />, elsewhere: <Money value={t.all_iqd - t.general_iqd} /> })}</p>}
          {closed.length > 0 && <p className="fw-note" data-finance-expenses-closed>{cs(loc, 'genClosedNote', { months: closed.map((m) => monthText(L, m)).join(L === 'en' ? ', ' : '، ') })}</p>}
          {!hasGeneral ? <Empty title={cs(loc, 'genEmpty')} text={cs(loc, 'genEmptyNote')} action={<Button variant="primary" onClick={toggleAdd} aria-expanded={adding} data-finance-expenses-add-empty><Plus size={16} aria-hidden />{fw(loc, 'add')}</Button>} /> : <>
            {t.by_category.length > 0 && <><h3>{cs(loc, 'genByCategory')}</h3>
              <ul className="fw-rows" data-finance-expenses-categories>{categoryShares(t.by_category).map((c) => <li key={c.category_id}><div>
                <span className="fw-rows-a">{categoryName(lang, c)}</span><span className="fw-rows-b"><Money value={c.amount_iqd} /></span>
                <span className="fw-rows-c"><span className="fw-gbar" style={{ width: 120 }}><i style={{ width: `${(c.share * 100).toFixed(1)}%` }} /></span> <bdi dir="ltr" className="fw-num">{percentText(c.percent)}</bdi></span></div></li>)}</ul></>}
            <h3>{cs(loc, 'genEntries')}</h3>
            <ul className="fw-rows" data-finance-expenses-entries>{groups.general.map(entry)}</ul>
            {groups.general.length < groups.generalEntries && <p className="fw-note" data-finance-expenses-partial>{cs(loc, 'genPartial', { shown: groups.general.length, all: groups.generalEntries })}</p>}
          </>}
          <div className="fw-fields">
            {hasGeneral && <Button onClick={toggleAdd} aria-expanded={adding} data-finance-expenses-add><Plus size={16} aria-hidden />{cs(loc, 'genAdd')}</Button>}
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
        <ul className="fw-rows">{g.rows.map(entry)}</ul>
        {g.rows.length < g.entries && <p className="fw-note" data-finance-expenses-partial={g.kind}>{cs(loc, 'genPartial', { shown: g.rows.length, all: g.entries })}</p>}</section>)}</div>
    </Surface>}
  </>;
}

/** One entry: what, when, where it counts, and — for an entry kept here, in an open month — edit and void, or restore once voided. */
function EntryRow({ r, range, closed, categories, needCategories, onChanged, openOrder, onPromotion }: {
  r: ExpenseEntryRow; range: { from: string; to: string }; closed: readonly string[]; categories: ExpenseCategory[] | null; needCategories: () => void;
  onChanged: () => void; openOrder: OpenOrder; onPromotion: (month: string) => void;
}) {
  const { loc, lang } = useLanguage();
  const L = lang as Lang;
  const s = useMemo(() => financeStrings(loc), [loc]);
  const [editing, setEditing] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [draft, setDraft] = useState(() => entryDraft(r));
  // The entry the draft stands on: as the editor opened on it, then as each re-read finds it.
  const [base, setBase] = useState(r);
  const [moved, setMoved] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const editButton = useRef<HTMLSpanElement>(null);
  const voidBox = useRef<HTMLDivElement>(null);
  const voidButton = useRef<HTMLDivElement>(null);
  const asked = useRef(false);
  const voidId = useId();
  // The void's confirmation opens on its sentence; «تراجع» there gives the focus back to «ألغِ هذا القيد…».
  useEffect(() => {
    if (voiding) { asked.current = true; voidBox.current?.querySelector<HTMLElement>('p')?.focus(); }
    else if (asked.current) { asked.current = false; voidButton.current?.querySelector<HTMLButtonElement>('button')?.focus(); }
  }, [voiding]);
  const problem: ExpenseProblem = expenseProblem({ ...draft, repeat_months: 1 }, baghdadDay(Date.now()));
  const problems: Record<Exclude<ExpenseProblem, null>, string> = { no_category: s.errNoCategory, amount_not_a_number: s.errAmountNotNumber, amount_not_whole: s.errAmountNotWhole,
    amount_not_positive: s.errAmountNotPositive, amount_too_large: s.errAmountTooLarge, day_not_a_day: s.errDayNotADay, day_too_far: s.errDayTooFar, repeat_out_of_range: s.errRepeat };
  // A re-read while the editor is open, the entry changed elsewhere meanwhile: the fields the owner has not touched take its
  // new values, what they typed stays, and the patch is against the entry as it now is — a field they never touched is never
  // sent with its old value (the checker of step 5's review: an edit of the description wrote back a corrected amount).
  if (editing && movedFields(base, r).length > 0) { setDraft((d) => rebaseDraft(base, r, d)); setBase(r); setMoved(true); }
  const patch = editPatch(base, draft), changed = Object.keys(patch).length > 0;
  // The editor opens on the entry as it is now and closes back on its «تعديل», what was typed in it gone.
  const open = () => { setDraft(entryDraft(r)); setBase(r); setMoved(false); setReason(''); setVoiding(false); setError(''); setEditing(true); needCategories(); };
  const close = () => { setEditing(false); setVoiding(false); setError(''); setDraft(entryDraft(r)); editButton.current?.querySelector<HTMLButtonElement>('button')?.focus(); };
  const run = async (write: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await write(); close(); onChanged(); }
    catch (e) { setError(refusalWords(loc, lang, e, e instanceof ApiError && !e.code ? e.message : s.saveFailed)); }
    finally { setBusy(false); }
  };
  const save = () => { if (!busy && !problem && changed) void run(() => updateExpense(r.id, patch)); };
  const promotionMonth = r.promotion_month ?? r.expense_day.slice(0, 7);
  const orderLink = r.order_id ? <button type="button" className="fw-link" dir="ltr" onClick={() => openOrder(r.order_id!)} aria-label={rs(loc, 'openOrder', { id: r.order_id })}>{r.order_id}</button> : null;
  const where = r.kind === 'promotion' ? <><button type="button" className="fw-link" onClick={() => onPromotion(promotionMonth)} data-finance-expense-promotion={promotionMonth}>{rs(loc, 'openPromotion')}</button>
    {/* A promotion's expense linked to an order too counts twice (the link is refused since the review of step 5). */}
    {orderLink && <> · <Status tone="danger">{cs(loc, 'genPromoLinked')}</Status> {orderLink}</>}</> : orderLink;
  const locked = inClosedMonth(r, closed);
  const own = editableHere(r.kind) && !locked;
  return <li data-finance-expense={r.id} data-finance-expense-kind={r.kind}><div>
    <span className="fw-rows-a">{r.title || <span className="fw-muted">{cs(loc, 'genNoTitle')}</span>}</span>
    <span className="fw-rows-b" style={r.voided ? { textDecoration: 'line-through' } : undefined}><Money value={r.amount_iqd} /></span>
    <span className="fw-rows-c">{dayIn(L, r.expense_day, range)} · {categoryName(lang, r.category)}
      {r.center_name && <> · <Status>{cs(loc, 'genCentre', { name: r.center_name })}</Status></>}
      {r.kind === 'order_ended' && <> · <Status tone="warning">{cs(loc, 'kindOrderEnded')}</Status></>}
      {where && <> · {where}</>}
      {/* A disabled promotion's reason is the server's own Arabic: said here in the reader's language. */}
      {r.voided && <> · <Status tone="warning">{s.voidedBadge}{r.kind === 'promotion' ? ` — ${cs(loc, 'genPromoDisabled')}` : r.void_reason ? ` — ${r.void_reason}` : ''}</Status></>}
      {locked && <> · <Status>{cs(loc, 'genClosed')}</Status></>}
      {/* Its source's: said in the line, so the description keeps the row's width on a phone. */}
      {!editableHere(r.kind) && !(r.voided && r.kind === 'promotion') && <> · {cs(loc, 'genEditedElsewhere')}</>}</span>
    {own && <span className="fw-rows-e" ref={editButton}>{r.voided
      ? <Button variant="ghost" busy={busy} onClick={() => void run(() => restoreExpense(r.id))} data-finance-expense-restore><RotateCcw size={14} aria-hidden />{s.restoreAction}</Button>
      : <Button variant="ghost" aria-expanded={editing} onClick={() => (editing ? close() : open())} data-finance-expense-edit>{cs(loc, 'genEdit')}</Button>}</span>}
  </div>
    {error && !editing && <p className="fw-error" role="alert">{error}</p>}
    {/* A section, not a div: `.fw-rows li>div` is the row's own two-column grid. Escape closes it, Enter saves. */}
    {editing && <section className="fw-inline-editor" style={{ margin: '0 12px 12px' }} data-finance-expense-editor onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
      <form onSubmit={(e) => { e.preventDefault(); save(); }}>
        <div className="fw-fields">
          <Field label={s.fieldAmount}><input className="fw-input" dir="ltr" inputMode="numeric" value={draft.amount} onChange={(e) => setDraft((d) => ({ ...d, amount: e.target.value }))} /></Field>
          <Field label={s.fieldDay}><input className="fw-input" dir="ltr" type="date" lang={L === 'en' ? 'en-GB' : 'ar-IQ'} value={draft.expense_day} onChange={(e) => setDraft((d) => ({ ...d, expense_day: e.target.value }))} /></Field>
          <Field label={s.fieldCategory}><select className="fw-select" value={draft.category_id} onChange={(e) => setDraft((d) => ({ ...d, category_id: e.target.value }))}>
            {!(categories ?? []).some((c) => c.id === draft.category_id) && <option value={draft.category_id}>{categoryName(lang, r.category)}</option>}
            {(categories ?? []).filter((c) => c.active || c.id === draft.category_id).map((c) => <option key={c.id} value={c.id}>{categoryName(lang, c)}</option>)}</select></Field>
          <Field label={s.fieldTitle}><input className="fw-input" value={draft.title} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} /></Field>
        </div>
        {moved && <p className="fw-note" role="status" data-finance-expense-moved>{cs(loc, 'genEditMoved')}</p>}
        {problem && <p className="fw-error" role="alert">{problems[problem]}</p>}
        {!problem && !changed && <p className="fw-note">{cs(loc, 'genNothingChanged')}</p>}
        {error && <p className="fw-error" role="alert">{error}</p>}
        <div className="fw-inline-editor-actions">
          <Button variant="ghost" disabled={busy} onClick={close}>{cs(loc, 'genCancel')}</Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!!problem || !changed} data-finance-expense-save>{cs(loc, 'genSave')}</Button>
        </div>
      </form>
      <div className="fw-fields" ref={voidButton}>
        <Field label={s.voidReason}><input className="fw-input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        {!voiding && <Button variant="danger" disabled={busy} onClick={() => setVoiding(true)} data-finance-expense-void><Trash2 size={14} aria-hidden />{cs(loc, 'genVoidAction')}</Button>}
      </div>
      {voiding && <div className="fw-confirm" role="alertdialog" aria-labelledby={voidId} ref={voidBox} data-finance-expense-void-confirm>
        <p id={voidId} tabIndex={-1}>{cs(loc, 'genVoidAsk', { amount: formatMoney(r.amount_iqd) })}</p>
        <div className="fw-fields"><Button variant="ghost" disabled={busy} onClick={() => setVoiding(false)}>{cs(loc, 'genCancel')}</Button>
          <Button variant="danger" busy={busy} onClick={() => void run(() => voidExpense(r.id, reason))}>{cs(loc, 'genVoidConfirm')}</Button></div>
      </div>}
      <p className="fw-note">{s.voidMeans}</p>
    </section>}
  </li>;
}

/**
 * The figure drawer's «المصاريف العامة» line (redesign step 5): the period's general entries — day, category, description,
 * amount — and their total, the period's general figure, named for what it sums (every column). The review of step 5: a
 * list the server cut says how many of how many it shows; with the overview in dollars the entries stay in dinars, as
 * recorded, and their dollar total is the statement line's own cents.
 */
export function GeneralEntryList({ rows, total, from, to, entries, usdCents }: { rows: readonly ExpenseEntryRow[]; total: number; from: string; to: string; entries?: number; usdCents?: number | null }) {
  const { loc, lang } = useLanguage();
  const L = lang as Lang;
  const general = rows.filter((r) => r.counts_as_general && !r.voided);
  const all = Math.max(entries ?? general.length, general.length);
  return <div className="fw-list fw-chips-wrap" data-finance-drawer-entries={general.length}>
    <h3>{cs(loc, 'drawerEntries')}</h3>
    {all === 0 && total === 0 ? <p className="fw-note" role="status">{cs(loc, 'genEmpty')}</p> : <>
      {usdCents != null && <p className="fw-note" data-finance-drawer-entries-currency>{csNodes(loc, 'drawerInIqd', { usd: <Amount v={usdCents} usd /> })}</p>}
      <ul className="fw-rows">{general.map((r) => <li key={r.id} data-finance-drawer-entry={r.id}><div>
        <span className="fw-rows-a">{r.title || cs(loc, 'genNoTitle')}</span><span className="fw-rows-b"><Money value={r.amount_iqd} /></span>
        <span className="fw-rows-c">{dayIn(L, r.expense_day, { from, to })} · {categoryName(lang, r.category)}{r.center_name ? ` · ${cs(loc, 'genCentre', { name: r.center_name })}` : ''}</span></div></li>)}
        <li className="fw-rows-total" data-finance-drawer-entries-total><span>{cs(loc, 'drawerTotal')}</span><b><Money value={total} /></b></li></ul>
      {general.length < all && <p className="fw-note" data-finance-drawer-entries-partial>{cs(loc, 'genPartial', { shown: general.length, all })}</p>}
    </>}
  </div>;
}
/** The drawer's general entries, read for the period the drawer stands on; `usdCents`: the statement's dollar figure, when it shows dollars. */
export function DrawerGeneralEntries({ from, to, usdCents }: { from: string; to: string; usdCents?: number | null }) {
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
  const k = data.totals.by_kind;
  return <GeneralEntryList rows={data.rows} total={data.totals.general_iqd} from={from} to={to} entries={(k?.general?.entries ?? 0) + (k?.order_ended?.entries ?? 0)} usdCents={usdCents} />;
}
