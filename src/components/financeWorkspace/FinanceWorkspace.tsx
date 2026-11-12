import { lazy, Suspense, useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { ArrowDownToLine, CalendarDays, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import OwnerCostVerifyCard from '../auth/OwnerCostVerifyCard';
import { FreshOnReturnHold, useFreshOnReturn } from '../../lib/useFreshOnReturn';
import { useLanguage } from '../../LanguageContext';
import { Button, Loading, Row, Sheet, Surface } from './ui';
import { financePreset, financeRangeFromSearch, validFinanceRange, WORKSPACE_API, type FinanceRange, type FinanceSection, type FinanceSummary } from './types';
import OrderProfitSheet, { type OrderFocus } from './OrderProfitSheet';
import PromotionPage from './PromotionPage';
import GeneralExpenses from './GeneralExpenses';
import AccountingChecks from './AccountingChecks';
import AccountingActivity from './AccountingActivity';
import CourierMoney from './CourierMoney';
import PayoutStatements from './PayoutStatements';
import './finance-workspace.css';
import { CurrencyToggle, DisplayCurrencyContext, type DisplayCurrency } from './displayCurrency';
import Overview from './Overview';
import { DaysReport, GroupsReport, OrdersReport } from './Reports';
import FigureDrawer from './FigureDrawer';
import type { FigureKey } from './drill';
import type { ScopeRef } from './reportTable';
import { compareRange, defaultCompare, type CompareMode } from './compare';
import { comparisonFor, keepKey, keptPages, missingBadge, navigate, NO_SUMMARY, NOTHING_KEPT, pageMount, summaryKey, summaryReducer, summaryShown, type ComparisonRead, type Kept } from './frameState';
import { fw, rangeText, type FwKey } from './overviewStrings';

const PeoplePanel = lazy(() => import('../financePeople/PeoplePanel'));
const InvestorPanel = lazy(() => import('../financePeople/InvestorPanel'));
const WithdrawalPanel = lazy(() => import('../financePeople/WithdrawalPanel'));
const FinanceOperationsPanel = lazy(() => import('../adminOperations/FinanceOperationsPanel'));
const MissingCostsSheet = lazy(() => import('./MissingCostsSheet'));
const ParticipantCharts = lazy(() => import('./ParticipantCharts'));

/**
 * «المال والأرباح» — THE FRAME (redesign step 2, owner 2026-11-11; DECISIONS row 315).
 *
 * Five sections instead of eight tabs, each page one of them: نظرة عامة; التقارير (orders,
 * products, sections, days — redesign step 4, DECISIONS row 316); التكاليف (missing costs, the month's promotion, general expenses — rent and the
 * like were hidden in a collapsed box); الأشخاص والدفعات (staff, investors, withdrawals —
 * their screens unchanged); المحاسبة. One compact bar for all of them: the period (a preset,
 * or two dates for a custom range), what the overview compares it with, the display currency
 * and the export. The `finance=` link value of every earlier tab still opens its page.
 *
 * Kept between tabs (frameState.ts): the period's summary is read once and serves the overview,
 * the products and the badges, and is shown only under the period and currency it was read for;
 * the comparison is read once per period, comparison, currency and refresh; and a page the owner
 * leaves stays mounted, hidden and holding its refreshes (FreshOnReturnHold), so coming back
 * shows it at once instead of reading it again — until the period, the currency or any figure
 * changes (a save anywhere, «تحديث»), or it was left more than two minutes ago.
 *
 * Step 4 adds the reports' tables (Reports.tsx), read from the same summary, and the figure drawer (FigureDrawer.tsx):
 * a card, a statement line or a cash figure of the overview opens on the orders that make it. Each report exports its own
 * table as it is shown, from its toolbar (`view=orders|products|sections|days` and its filters); the bar's export is the
 * overview's line file. The drawer opens only on the figures of the period on screen (`shown.current`): never while another
 * period or currency loads, and it closes when the read it stood on goes (the independent review of step 4); a card's open that
 * lands after the owner moved to another read or page opens nothing (`openOn`, the fourth).
 */
type Main = 'overview' | 'reports' | 'costs' | 'people' | 'accounting';
const MAIN_OF: Record<FinanceSection, Main> = { overview: 'overview', orders: 'reports', products: 'reports', sections: 'reports', days: 'reports', missing: 'costs', monthly: 'costs', expenses: 'costs',
  staff: 'people', investors: 'people', settlements: 'people', statements: 'people', accounting: 'accounting', courier: 'accounting' };
const PAGES: Record<Main, FinanceSection[]> = { overview: ['overview'], reports: ['orders', 'products', 'sections', 'days'], costs: ['missing', 'monthly', 'expenses'],
  people: ['staff', 'investors', 'settlements', 'statements'], accounting: ['accounting', 'courier'] };
const LABEL: Record<FinanceSection | Main, FwKey> = { overview: 'overview', reports: 'reports', costs: 'costs', people: 'people', accounting: 'accounting',
  orders: 'orders', products: 'products', sections: 'sectionsPage', days: 'daysPage', missing: 'missing', monthly: 'promotion', expenses: 'expenses', staff: 'staff', investors: 'investors', settlements: 'withdrawals', statements: 'statementsPage', courier: 'courier' };
/** A page's own name among its tab's pages, where it differs from the tab's: the books under «المحاسبة». */
const PILL: Partial<Record<FinanceSection, FwKey>> = { accounting: 'books' };
const SECTIONS = Object.keys(MAIN_OF) as FinanceSection[];
// Accounting is not kept: its journal tools and the old report open on demand and pause the summary's refresh.
const KEPT: FinanceSection[] = SECTIONS.filter((s) => s !== 'accounting' && s !== 'courier');
const keepable = (page: FinanceSection) => KEPT.includes(page);
// The pages drawn in the display currency; every other page is in dinars whatever the toggle says.
const CURRENCY_PAGES: FinanceSection[] = ['overview', 'orders', 'products', 'sections', 'days'];
const PRESETS: Array<['month' | '7days' | '30days' | 'previous' | 'year', FwKey]> = [['month', 'presetMonth'], ['7days', 'preset7'], ['30days', 'preset30'], ['previous', 'presetPrevious'], ['year', 'presetYear']];

const initialSection = (): FinanceSection => {
  if (typeof window === 'undefined') return 'overview';
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('finance') || params.get('section');
  const aliases: Record<string, FinanceSection> = { withdrawals: 'settlements', people: 'staff', monthlycosts: 'monthly', reports: 'orders', costs: 'missing', promotion: 'monthly', categories: 'sections' };
  const tab = raw ? aliases[raw] ?? raw : null;
  return SECTIONS.includes(tab as FinanceSection) ? tab as FinanceSection : 'overview';
};
const presetOf = (r: { from: string; to: string }) => PRESETS.find(([p]) => { const x = financePreset(p); return x.from === r.from && x.to === r.to; })?.[0] ?? 'custom';
/** The time of a read in Baghdad, Latin digits. */
const clock = () => { const d = new Date(Date.now() + 3 * 3600000); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };

export default function FinanceWorkspace({ legacy }: { legacy?: ReactNode }) {
  const { loc, dir, lang } = useLanguage();
  const L = lang as 'ar' | 'en' | 'ckb';
  const [section, setSectionState] = useState<FinanceSection>(initialSection);
  // «التكاليف ← ترويج الشهر» shows one month: the period's (its last), unless the owner picked another on that page — a pick
  // the address keeps (`financeMonth`) until the period changes, when the month follows the period again (redesign step 5).
  const [monthPick, setMonthPick] = useState<string | null>(() => {
    const value = typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('financeMonth') ?? '';
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : null;
  });
  const [initialPeriod] = useState(() => financeRangeFromSearch(typeof window === 'undefined' ? '' : window.location.search));
  const [range, setRangeState] = useState(initialPeriod.range);
  const setRange = (next: FinanceRange) => { setRangeState(next); setMonthPick(null); };
  const month = monthPick ?? range.to.slice(0, 7);
  const [draft, setDraft] = useState(initialPeriod.range);
  const [rangeError, setRangeError] = useState(initialPeriod.invalid);
  // The select names the range it shows: a preset when the dates are one, else «فترة مخصصة».
  const [preset, setPreset] = useState<string>(() => presetOf(initialPeriod.range));
  // The comparison follows the period (same days last month inside one month, else the period before) until the owner picks one.
  const [comparePick, setComparePick] = useState<CompareMode | 'auto'>('auto');
  const compareMode: CompareMode = comparePick === 'auto' ? defaultCompare(range) : comparePick;
  const compared = compareRange(range, compareMode);
  // Every read of the summary tagged with its period and currency (frameState.ts): never one period's figures under another's dates.
  // It opens loading the period of the address (the spinner from the first paint, not after the first effect).
  const [summary, dispatch] = useReducer(summaryReducer, initialPeriod.range, (r) => ({ ...NO_SUMMARY, loading: summaryKey(r.from, r.to, 'IQD') }));
  const [prev, setPrev] = useState<ComparisonRead>(null);
  // The owner's own session before the address is verified (DECISIONS row 185
  // amendment): the refusal is rendered BY CODE as the way to open this screen.
  const [mustVerify, setMustVerify] = useState(false);
  const [revision, setRevision] = useState(0);
  const summaryGeneration = useRef(0);
  const [orderId, setOrderId] = useState<string | null>(() => typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('order'));
  // The collections sheet: closed (null), every order (''), or one order's («لم يُسجَّل» on Reports → Orders).
  const [collections, setCollections] = useState<string | null>(null);
  // Redesign step 4: the figure open in the drawer; the orders page opened on a product's, a section's or a day's orders
  // (the row it was opened from, whose orders each summary names again); the sections' level.
  const [figure, setFigure] = useState<FigureKey | null>(null);
  const [scope, setScope] = useState<ScopeRef | null>(null);
  const [level, setLevel] = useState<'main' | 'sub'>('main');
  // A held investor sale opens its order at the step that releases it (PersonFinanceView «سجّل استلام النقد» / «أدخل تكلفة القطع»);
  // a line of «التكاليف الناقصة» opens on that line.
  const [orderFocus, setOrderFocus] = useState<{ step?: OrderFocus; line?: string }>({});
  const openOrderAt = (id: string, step?: OrderFocus, line?: string) => { setOrderId(id); setOrderFocus({ step, line }); };
  // The people screens and the missing-costs page re-read their figures in place (scroll, open lists
  // kept) after an order sheet in which the owner saved something closes (a held sale released, a cost priced).
  const [peopleRevision, setPeopleRevision] = useState(0);
  const orderChanged = useRef(false);
  const [advanced, setAdvanced] = useState(false);
  const [legacyOpen, setLegacyOpen] = useState(false);
  // «عملة العرض» (design P-A §8): IQD on every load, never stored, display only.
  const [currency, setCurrency] = useState<DisplayCurrency>('IQD');
  const main = MAIN_OF[section];
  const showsCurrency = CURRENCY_PAGES.includes(section);
  const display = currency === 'USD' ? '&display=USD' : '';
  const readKey = summaryKey(range.from, range.to, currency);
  // The figures shown: this period's and currency's; while another loads, the last ones dimmed; after its read failed, none.
  const shown = summaryShown(summary, readKey), data = shown.data, busy = summary.loading !== null, error = summary.error;
  const refresh = useCallback(() => setRevision((v) => v + 1), []);
  // The pages the owner left, kept mounted and hidden while nothing they show can have changed (frameState.ts).
  const kept = keepKey(range.from, range.to, currency, revision);
  const [keptState, setKept] = useState<Kept>(NOTHING_KEPT);
  const hidden = keptPages(keptState, kept);
  const setSection = (next: FinanceSection) => {
    if (next === section) return;
    setKept((state) => navigate(state, kept, section, next, Date.now(), keepable));
    setSectionState(next); setAdvanced(false); setLegacyOpen(false);
  };
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('finance', section); url.searchParams.set('from', range.from); url.searchParams.set('to', range.to);
    if (monthPick) url.searchParams.set('financeMonth', monthPick); else url.searchParams.delete('financeMonth');
    window.history.replaceState(window.history.state, '', url);
  }, [section, range.from, range.to, monthPick]);
  // One read of the period serves every section: switching pages never reloads it, and a new
  // period or currency keeps the old figures on screen (dimmed) until its own arrive — or its read fails.
  useEffect(() => {
    const controller = new AbortController();
    const generation = ++summaryGeneration.current;
    const key = summaryKey(range.from, range.to, currency);
    dispatch({ type: 'start', key });
    api.get<FinanceSummary>(`${WORKSPACE_API}/summary?from=${range.from}&to=${range.to}${currency === 'USD' ? '&display=USD' : ''}`, { signal: controller.signal })
      .then((r) => { if (!controller.signal.aborted) dispatch({ type: 'loaded', key, data: r, at: clock() }); })
      .catch((e) => {
        if (controller.signal.aborted) return;
        // The owner before the address is verified: the whole workspace becomes the card that verifies it.
        if (e instanceof ApiError && e.code === 'OWNER_EMAIL_UNVERIFIED') setMustVerify(true);
        else dispatch({ type: 'failed', key, error: e instanceof Error ? e.message : String(e) });
      });
    return () => { controller.abort(); summaryGeneration.current = generation + 1; };
  }, [range.from, range.to, revision, currency]);
  // The comparison period, read once per period, comparison, currency and refresh — when the overview first needs it.
  const compareKey = compared ? `${compared.from}|${compared.to}|${currency}|${revision}` : '';
  const comparison = comparisonFor(prev, compareKey);
  const wantsComparison = main === 'overview' && comparison.wanted;
  useEffect(() => {
    if (!wantsComparison) return;
    const [from, to, money] = compareKey.split('|');
    const controller = new AbortController();
    api.get<FinanceSummary>(`${WORKSPACE_API}/summary?from=${from}&to=${to}${money === 'USD' ? '&display=USD' : ''}`, { signal: controller.signal, mascot: 'silent' })
      .then((r) => { if (!controller.signal.aborted) setPrev({ key: compareKey, data: r }); })
      // No comparison: the header says it could not be read, and the cards show no change.
      .catch(() => { if (!controller.signal.aborted) setPrev({ key: compareKey, data: null }); });
    return () => controller.abort();
  }, [compareKey, wantsComparison]);
  // These reads only display work completed by the server. They never start a
  // financial posting and stop while hidden or while an editing sheet is open.
  useFreshOnReturn(async () => {
    const generation = summaryGeneration.current, key = readKey;
    const updated = await api.get<FinanceSummary>(`${WORKSPACE_API}/summary?from=${range.from}&to=${range.to}${display}`, { mascot: 'silent' });
    if (generation !== summaryGeneration.current) return;
    dispatch({ type: 'loaded', key, data: updated, at: clock() });
  }, { pollWhileVisibleMs: 30_000, minIntervalMs: 30_000,
    enabled: showsCurrency && shown.current && (data?.totals.pending_costs ?? 0) > 0 && !busy && !orderId && collections === null && !figure && !advanced && !legacyOpen });
  const apply = (event: React.FormEvent) => { event.preventDefault(); if (!validFinanceRange(draft)) { setRangeError(true); return; } setRange(draft); setRangeError(false); setPreset(presetOf(draft)); };
  const missingLines = missingBadge(summary, range.from, range.to);
  // The drawer stands on one read: another period or currency, or a read that failed, closes it — it never opens again by itself.
  useEffect(() => { setFigure(null); }, [readKey]);
  useEffect(() => { if (!data) setFigure(null); }, [data]);
  // A card's open waits out a double click (ui.tsx cardClick): asked on one read and page, it opens only there. The owner who moves on
  // within the wait — another period, currency or page — gets no drawer, neither over the page he went to nor by itself once the next
  // read lands (the fourth review of step 4).
  const screen = `${readKey}|${section}`, onScreen = useRef(screen);
  onScreen.current = screen;
  const openOn = (asked: string) => (key: FigureKey) => { if (onScreen.current === asked) setFigure(key); };
  const openOrders = (next: ScopeRef) => { setScope(next); setSection('orders'); };
  // The overview and the drawer open the orders page on the period's orders («الطلبات المستلمة»), never on a row's left from before.
  const toPage = (next: FinanceSection) => { if (next === 'orders') setScope(null); setSection(next); };
  const loading = <Loading text={fw(loc, 'loading')} />;
  /** The figures of the shown period, dimmed while a read is in flight; nothing (the error above says why) when there are none. */
  const figures = (body: (d: FinanceSummary) => ReactNode) => !data ? busy && loading : <div className={busy ? 'fw-reloading' : undefined}>{body(data)}</div>;
  /**
   * A page of the workspace: the one shown, or one the owner left that is still kept, hidden and holding its refreshes.
   * Each page carries its own display currency, so moving between sections never flips a kept page's currency.
   */
  const page = (id: FinanceSection, body: () => ReactNode) => (id === section || hidden.includes(id)) && <FreshOnReturnHold.Provider key={pageMount(keptState, id)} value={id !== section}>
    <DisplayCurrencyContext.Provider value={CURRENCY_PAGES.includes(id) ? currency : 'IQD'}>
      <div className="fw-body" style={id === section ? undefined : { display: 'none' }} data-finance-page={id}>{body()}</div></DisplayCurrencyContext.Provider></FreshOnReturnHold.Provider>;
  if (mustVerify) return <OwnerCostVerifyCard />;
  return <DisplayCurrencyContext.Provider value={showsCurrency || orderId ? currency : 'IQD'}><div className="fw fw-workspace" dir={dir} data-finance-workspace>
    <header className="fw-top">
      <div><div className="fw-muted">LEVONIS / {fw(loc, 'crumb')}</div><h1>{fw(loc, 'title')}</h1>
        {section !== 'monthly' && <p data-finance-range><bdi>{rangeText(L, range.from, range.to)}</bdi>{compared && main === 'overview' && <span className="fw-muted" data-finance-compared={comparison.failed ? 'failed' : undefined}> · {fw(loc, comparison.failed ? 'vsFailed' : 'vsHeader', { range: rangeText(L, compared.from, compared.to) })}</span>}</p>}</div>
      <div className="fw-top-tools">{shown.at && <span className="fw-muted fw-updated">{fw(loc, 'updated', { time: shown.at })}</span>}
        <Button className="fw-icon-button" variant="secondary" busy={busy} onClick={refresh} aria-label={fw(loc, 'refresh')}>{!busy && <RefreshCw size={17} aria-hidden />}</Button></div>
    </header>
    <nav className="fw-tabs" aria-label={fw(loc, 'sections')}>
      {(Object.keys(PAGES) as Main[]).map((m) => <button key={m} type="button" className="fw-tab" aria-current={main === m ? 'page' : undefined} data-finance-section={m}
        onClick={() => { if (main !== m) setSection(PAGES[m][0]); }}>{fw(loc, LABEL[m])}{m === 'costs' && missingLines > 0 && <span className="fw-missing">{missingLines}</span>}</button>)}
    </nav>
    {PAGES[main].length > 1 && <div className="fw-filter-pills" role="group" aria-label={fw(loc, LABEL[main])}>
      {PAGES[main].map((p) => <button key={p} type="button" className="fw-pill" aria-pressed={section === p} data-finance-subpage={p} onClick={() => setSection(p)}>{fw(loc, PILL[p] ?? LABEL[p])}{p === 'missing' && missingLines > 0 ? ` · ${missingLines}` : ''}</button>)}
    </div>}
    {section !== 'monthly' && <form className="fw-bar" onSubmit={apply} data-finance-period>
      <label className="fw-chip"><CalendarDays size={16} aria-hidden /><select className="fw-select" value={preset} aria-label={fw(loc, 'period')} onChange={(event) => {
        setPreset(event.target.value); if (event.target.value === 'custom') return;
        const next = financePreset(event.target.value as Parameters<typeof financePreset>[0]); setDraft(next); setRange(next); setRangeError(false);
      }}><option value="custom">{fw(loc, 'presetCustom')}</option>{PRESETS.map(([p, k]) => <option key={p} value={p}>{fw(loc, k)}</option>)}</select></label>
      {/* Two dates only for a custom range: the header already says which days a preset is. */}
      {(preset === 'custom' || rangeError) && <>
        {(['from', 'to'] as const).map((key) => <label className="fw-chip" key={key}><span className="fw-muted">{fw(loc, key)}</span><input type="date" className="fw-input" lang={L === 'en' ? 'en-GB' : 'ar-IQ'} value={draft[key]} aria-invalid={rangeError || undefined} aria-describedby={rangeError ? 'fw-range-error' : undefined}
          onChange={(event) => { setDraft((v) => ({ ...v, [key]: event.target.value })); setPreset('custom'); }} /></label>)}
        {(draft.from !== range.from || draft.to !== range.to || rangeError) && <button className="fw-button fw-button--primary" type="submit">{fw(loc, 'apply')}</button>}
      </>}
      {main === 'overview' && <label className="fw-chip fw-compare"><span className="fw-muted">{fw(loc, 'compare')}</span><select className="fw-select" value={compareMode} data-finance-compare onChange={(event) => setComparePick(event.target.value as CompareMode)}>
        <option value="month">{fw(loc, 'compareMonth')}</option><option value="previous">{fw(loc, 'comparePrevious')}</option><option value="none">{fw(loc, 'compareNone')}</option></select></label>}
      {showsCurrency && <CurrencyToggle value={currency} onChange={setCurrency} />}
      {/* The overview's export is the period's line file; each report exports its own table, as shown, from its toolbar (Reports.tsx). */}
      {main === 'overview' && <a className="fw-button fw-button--ghost" href={`${WORKSPACE_API}/export.csv?from=${range.from}&to=${range.to}`} aria-label={fw(loc, 'exportCsv')} data-finance-export><ArrowDownToLine size={16} aria-hidden /><span>{fw(loc, 'exportCsv')}</span></a>}
      {rangeError && <p id="fw-range-error" className="fw-error" role="alert">{fw(loc, 'rangeError')}</p>}
    </form>}
    <div className="fw-body">
      {error && <div className="fw-error" role="alert">{error}<Button variant="ghost" onClick={refresh}>{fw(loc, 'retry')}</Button></div>}
      {/* The comparison only beside this period's own figures: never old figures against the new period's comparison. */}
      {page('overview', () => figures((d) => <Overview data={d} prev={shown.current ? comparison.data : null} compareFrom={compared?.from} compareTo={compared?.to} revision={revision} openOrder={(id, step) => openOrderAt(id, step)}
        onNavigate={toPage} onCollections={() => setCollections('')} onMissing={() => setSection('missing')} onFigure={shown.current ? openOn(screen) : undefined} />))}
      {page('orders', () => figures((d) => <OrdersReport data={d} scope={scope} onClearScope={() => setScope(null)} openOrder={openOrderAt} onMissing={() => setSection('missing')} onCollections={setCollections} />))}
      {page('products', () => figures((d) => <GroupsReport data={d} level="product" onOpenOrders={openOrders} onMissing={() => setSection('missing')} />))}
      {page('sections', () => figures((d) => <GroupsReport data={d} level={level} onLevel={setLevel} onOpenOrders={openOrders} onMissing={() => setSection('missing')} />))}
      {page('days', () => figures((d) => <DaysReport data={d} onOpenOrders={openOrders} />))}
      {page('missing', () => <Suspense fallback={loading}><MissingCostsSheet inline reload={peopleRevision} from={range.from} to={range.to} onClose={() => setSection('overview')} onChanged={refresh} openOrder={(id, step, line) => openOrderAt(id, step, line)} /></Suspense>)}
      {/* Redesign step 5 (DECISIONS row 317): the month's promotion, its month following the period — mounted once per month, so
          nothing typed for one month stands in another's form (the review of step 5); the general expenses of the period, whose
          promotion entry opens its own month. */}
      {page('monthly', () => <PromotionPage key={month} month={month} onMonth={setMonthPick} from={range.from} to={range.to} revision={revision} onChanged={refresh} />)}
      {page('expenses', () => <GeneralExpenses from={range.from} to={range.to} revision={revision} onChanged={refresh} openOrder={(id) => openOrderAt(id)}
        onPromotion={(m) => { setMonthPick(m); setSection('monthly'); }} />)}
      {page('staff', () => <Suspense fallback={loading}><PeoplePanel from={range.from} to={range.to} onChanged={refresh} openOrder={openOrderAt} revision={peopleRevision} /></Suspense>)}
      {page('investors', () => <Suspense fallback={loading}><InvestorPanel from={range.from} to={range.to} onChanged={refresh} openOrder={openOrderAt} revision={peopleRevision} />
        <PeriodCharts from={range.from} to={range.to} revision={revision} /></Suspense>)}
      {page('settlements', () => <Suspense fallback={loading}><WithdrawalPanel from={range.from} to={range.to} onChanged={refresh} /></Suspense>)}
      {page('statements', () => <PayoutStatements from={range.from} to={range.to} />)}
      {section === 'accounting' && <Suspense fallback={loading}>
        <AccountingChecks onOpenOrder={(id) => openOrderAt(id)} />
        <AccountingActivity from={range.from} to={range.to} onOpenOrder={(id) => openOrderAt(id)} />
        <Surface title={fw(loc, 'accounting')} subtitle={loc('الأرصدة والقيود والتسويات المعتمدة', 'Balances, journals and verified settlements', 'باڵانس و تۆمار و یەکلاکردنەوە پەسەندکراوەکان')}>
          <Row label={loc('دفتر القيود وميزان المراجعة', 'Journal and trial balance', 'دەفتەری تۆمارەکان و هاوسەنگیی پێداچوونەوە')} value={null} onClick={() => setAdvanced(true)} />
          <p className="fw-note">{loc('الأرقام اليومية تُحتسب تلقائيًا من العمليات. افتح هذه الأدوات لإدخال الأرصدة الافتتاحية ومراجعة الحسابات وإغلاق الشهر.', 'Daily figures follow operations automatically. Use these tools for opening balances, account review and closing the month.', 'ژمارە ڕۆژانەکان خۆکارانە لە کارەکانەوە دەژمێردرێن. ئەم ئامرازانە بکەرەوە بۆ باڵانسی سەرەتایی و پێداچوونەوەی حیسابەکان و داخستنی مانگ.')}</p>
        </Surface>
        {advanced && <FinanceOperationsPanel from={range.from} to={range.to} initialTab="accounting" onChanged={refresh} />}
        {legacy && <details className="fw-advanced" onToggle={(e) => setLegacyOpen(e.currentTarget.open)}><summary>{loc('التقرير المحاسبي قبل توزيع الأرباح', 'Accounting report before profit distribution', 'ڕاپۆرتی ژمێریاری پێش دابەشکردنی قازانج')}</summary>{legacyOpen && <><p className="fw-note">{loc('هذا التقرير يراجع النشاط المحاسبي قبل حصص المستثمرين والتصحيحات الخاصة بالطلبات. استخدم «صافي حصتك» في النظرة العامة لمعرفة حصتك بعد التوزيع وتكاليف الشهر.', 'This report reviews accounting activity before investor distributions and order-specific corrections. Use “Your net share” in Overview for your share after distributions and monthly costs.', 'ئەم ڕاپۆرتە چالاکیی ژمێریاری پێش بەشی وەبەرهێنەران و ڕاستکردنەوەکانی داواکاری پێداچوونەوە دەکات. «سافی بەشی تۆ» لە تێڕوانینی گشتی بەکاربهێنە بۆ زانینی بەشەکەت دوای دابەشکردن و تێچووی مانگ.')}</p>{legacy}</>}</details>}
      </Suspense>}
      {section === 'courier' && <Suspense fallback={loading}><CourierMoney onOpenOrder={(id) => openOrderAt(id)} onChanged={refresh} /></Suspense>}
    </div>
    {orderId && <OrderProfitSheet key={`${orderId}:${orderFocus.step ?? ''}:${orderFocus.line ?? ''}`} orderId={orderId} focus={orderFocus.step} focusLine={orderFocus.line}
      onClose={() => { setOrderId(null); setOrderFocus({}); if (orderChanged.current) { orderChanged.current = false; setPeopleRevision((v) => v + 1); } }}
      onChanged={refresh} onSaved={() => { orderChanged.current = true; }} />}
    {collections !== null && <Sheet title={loc('التحصيل وشركات التوصيل', 'Collections and couriers', 'وەرگرتن و کۆمپانیاکانی گەیاندن')} onClose={() => setCollections(null)}>
      <Suspense fallback={loading}><FinanceOperationsPanel from={range.from} to={range.to} initialTab="collections" initialOrderId={collections} onChanged={refresh} /></Suspense>
    </Sheet>}
    {/* The figure drawer, over the overview in the overview's currency, on the figures of the period on screen only; an order opened from it stacks on top. */}
    {figure && data && shown.current && <DisplayCurrencyContext.Provider value={currency}><FigureDrawer data={data} figure={figure} from={data.range?.from ?? range.from} to={data.range?.to ?? range.to} onClose={() => setFigure(null)}
      openOrder={openOrderAt} onNavigate={toPage} /></DisplayCurrencyContext.Provider>}
  </div></DisplayCurrencyContext.Provider>;
}

/**
 * The old overview's four charts of the period's people and batches (ParticipantCharts), behind a summary: the chart
 * library and their read load only when the owner opens it, and close again with the page (independent review, 2026-11-11).
 */
function PeriodCharts({ from, to, revision }: { from: string; to: string; revision: number }) {
  const { loc } = useLanguage();
  const [open, setOpen] = useState(false);
  return <details className="fw-advanced" onToggle={(e) => setOpen(e.currentTarget.open)} data-finance-period-charts>
    <summary>{loc('الاستحقاق والتسديد، رأس المال، التسويات وحركة الدفعات في الفترة', 'Accrual and payments, capital, corrections and batch movement in the period', 'شایستە و پارەدان، سەرمایە، ڕاستکردنەوەکان و جووڵەی بارەکان لەم ماوەیەدا')}</summary>
    {open && <Suspense fallback={<Loading text={fw(loc, 'loading')} />}><ParticipantCharts from={from} to={to} revision={revision} /></Suspense>}
  </details>;
}
