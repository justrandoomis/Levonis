import { lazy, Suspense, useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { ArrowDownToLine, CalendarDays, CheckCircle2, ChevronLeft, Layers3, Package, RefreshCw, Search } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import OwnerCostVerifyCard from '../auth/OwnerCostVerifyCard';
import { FreshOnReturnHold, useFreshOnReturn } from '../../lib/useFreshOnReturn';
import { useLanguage } from '../../LanguageContext';
import { Button, Empty, Loading, Row, Sheet, Status, Surface } from './ui';
import { currentMonth, financeDay, financePreset, financeRangeFromSearch, validFinanceRange, statusName, WORKSPACE_API, type DisplayUsdOrders, type FinanceOrder, type FinanceProduct, type FinanceSection, type FinanceSummary, type UsdOrderCents } from './types';
import OrderProfitSheet, { type OrderFocus } from './OrderProfitSheet';
import MonthlyCosts from './MonthlyCosts';
import './finance-workspace.css';
import { orderFinancePresentation } from './orderFinancePresentation';
import ReportDeductions from './ReportDeductions';
import { CurrencyToggle, DisplayCurrencyContext, DisplayMoney, UsdBasisNote, centsAt, useDisplayCurrency, type DisplayCurrency } from './displayCurrency';
import VariantImg from '../ui/VariantImg';
import Overview from './Overview';
import { compareRange, defaultCompare, type CompareMode } from './compare';
import { comparisonFor, keepKey, keptPages, missingBadge, navigate, NO_SUMMARY, NOTHING_KEPT, pageMount, summaryKey, summaryReducer, summaryShown, type ComparisonRead, type Kept } from './frameState';
import { fw, rangeText, type FwKey } from './overviewStrings';
import ExpenseLedger from '../adminFinance/ExpenseLedger';
import { financeStrings } from '../adminFinance/strings';
import { isLatin } from '../adminFinance/format';

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
 * products); التكاليف (missing costs, the month's promotion, general expenses — rent and the
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
 */
type Main = 'overview' | 'reports' | 'costs' | 'people' | 'accounting';
const MAIN_OF: Record<FinanceSection, Main> = { overview: 'overview', orders: 'reports', products: 'reports', missing: 'costs', monthly: 'costs', expenses: 'costs',
  staff: 'people', investors: 'people', settlements: 'people', accounting: 'accounting' };
const PAGES: Record<Main, FinanceSection[]> = { overview: ['overview'], reports: ['orders', 'products'], costs: ['missing', 'monthly', 'expenses'],
  people: ['staff', 'investors', 'settlements'], accounting: ['accounting'] };
const LABEL: Record<FinanceSection | Main, FwKey> = { overview: 'overview', reports: 'reports', costs: 'costs', people: 'people', accounting: 'accounting',
  orders: 'orders', products: 'products', missing: 'missing', monthly: 'promotion', expenses: 'expenses', staff: 'staff', investors: 'investors', settlements: 'withdrawals' };
const SECTIONS = Object.keys(MAIN_OF) as FinanceSection[];
// Accounting is not kept: its journal tools and the old report open on demand and pause the summary's refresh.
const KEPT: FinanceSection[] = SECTIONS.filter((s) => s !== 'accounting');
const keepable = (page: FinanceSection) => KEPT.includes(page);
// The pages drawn in the display currency; every other page is in dinars whatever the toggle says.
const CURRENCY_PAGES: FinanceSection[] = ['overview', 'orders', 'products'];
const PRESETS: Array<['month' | '7days' | '30days' | 'previous' | 'year', FwKey]> = [['month', 'presetMonth'], ['7days', 'preset7'], ['30days', 'preset30'], ['previous', 'presetPrevious'], ['year', 'presetYear']];

const initialSection = (): FinanceSection => {
  if (typeof window === 'undefined') return 'overview';
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('finance') || params.get('section');
  const aliases: Record<string, FinanceSection> = { withdrawals: 'settlements', people: 'staff', monthlycosts: 'monthly', reports: 'orders', costs: 'missing', promotion: 'monthly' };
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
  const [month, setMonth] = useState(() => {
    const value = typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('financeMonth') ?? '';
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : currentMonth();
  });
  const [initialPeriod] = useState(() => financeRangeFromSearch(typeof window === 'undefined' ? '' : window.location.search));
  const [range, setRange] = useState(initialPeriod.range);
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
  // The orders list re-reads after a background refresh of the summary only while it is the page shown.
  const [ordersPoll, setOrdersPoll] = useState(0);
  const summaryGeneration = useRef(0);
  const [orderId, setOrderId] = useState<string | null>(() => typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('order'));
  const [collections, setCollections] = useState(false);
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
    url.searchParams.set('financeMonth', month);
    window.history.replaceState(window.history.state, '', url);
  }, [section, range.from, range.to, month]);
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
    dispatch({ type: 'loaded', key, data: updated, at: clock() }); if (section === 'orders') setOrdersPoll((value) => value + 1);
  }, { pollWhileVisibleMs: 30_000, minIntervalMs: 30_000,
    enabled: showsCurrency && shown.current && (data?.totals.pending_costs ?? 0) > 0 && !busy && !orderId && !collections && !advanced && !legacyOpen });
  const apply = (event: React.FormEvent) => { event.preventDefault(); if (!validFinanceRange(draft)) { setRangeError(true); return; } setRange(draft); setRangeError(false); setPreset(presetOf(draft)); };
  const missingLines = missingBadge(summary, range.from, range.to);
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
      {PAGES[main].map((p) => <button key={p} type="button" className="fw-pill" aria-pressed={section === p} data-finance-subpage={p} onClick={() => setSection(p)}>{fw(loc, LABEL[p])}{p === 'missing' && missingLines > 0 ? ` · ${missingLines}` : ''}</button>)}
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
      {(main === 'overview' || main === 'reports') && <a className="fw-button fw-button--ghost" href={`${WORKSPACE_API}/export.csv?from=${range.from}&to=${range.to}`} aria-label={fw(loc, 'exportCsv')} data-finance-export><ArrowDownToLine size={16} aria-hidden /><span>{fw(loc, 'exportCsv')}</span></a>}
      {rangeError && <p id="fw-range-error" className="fw-error" role="alert">{fw(loc, 'rangeError')}</p>}
    </form>}
    <div className="fw-body">
      {error && <div className="fw-error" role="alert">{error}<Button variant="ghost" onClick={refresh}>{fw(loc, 'retry')}</Button></div>}
      {/* The comparison only beside this period's own figures: never old figures against the new period's comparison. */}
      {page('overview', () => figures((d) => <Overview data={d} prev={shown.current ? comparison.data : null} compareFrom={compared?.from} compareTo={compared?.to} revision={revision} openOrder={(id, step) => openOrderAt(id, step)}
        onNavigate={setSection} onCollections={() => setCollections(true)} onMissing={() => setSection('missing')} />))}
      {page('orders', () => <Orders from={range.from} to={range.to} revision={revision + ordersPoll} openOrder={setOrderId} kinds={shown.current ? data : null} />)}
      {page('products', () => figures((d) => <Products data={d} onOpenOrders={() => setSection('orders')} />))}
      {page('missing', () => <Suspense fallback={loading}><MissingCostsSheet inline reload={peopleRevision} from={range.from} to={range.to} onClose={() => setSection('overview')} onChanged={refresh} openOrder={(id, step, line) => openOrderAt(id, step, line)} /></Suspense>)}
      {page('monthly', () => <><label className="fw-chip" style={{ justifySelf: 'start' }}><CalendarDays size={16} aria-hidden />
        <input type="month" className="fw-input" value={month} aria-label={loc('شهر التكاليف والمستحقات', 'Costs and earnings month', 'مانگی تێچوو و شایستەکان')} onChange={(e) => { if (/^\d{4}-(0[1-9]|1[0-2])$/.test(e.target.value)) setMonth(e.target.value); }} /></label>
        <MonthlyCosts key={month} month={month} onChanged={refresh} /></>)}
      {page('expenses', () => <Surface title={fw(loc, 'expenses')}><ExpenseLedger from={range.from} to={range.to} s={financeStrings(loc)} latin={isLatin(lang)} dir={dir === 'rtl' ? 'rtl' : 'ltr'} onChanged={refresh} /></Surface>)}
      {page('staff', () => <Suspense fallback={loading}><PeoplePanel from={range.from} to={range.to} onChanged={refresh} openOrder={openOrderAt} revision={peopleRevision} /></Suspense>)}
      {page('investors', () => <Suspense fallback={loading}><InvestorPanel from={range.from} to={range.to} onChanged={refresh} openOrder={openOrderAt} revision={peopleRevision} />
        <PeriodCharts from={range.from} to={range.to} revision={revision} /></Suspense>)}
      {page('settlements', () => <Suspense fallback={loading}><WithdrawalPanel from={range.from} to={range.to} onChanged={refresh} /></Suspense>)}
      {section === 'accounting' && <Suspense fallback={loading}>
        <Surface title={fw(loc, 'accounting')} subtitle={loc('الأرصدة والقيود والتسويات المعتمدة', 'Balances, journals and verified settlements', 'باڵانس و تۆمار و یەکلاکردنەوە پەسەندکراوەکان')}>
          <Row label={loc('دفتر القيود وميزان المراجعة', 'Journal and trial balance', 'دەفتەری تۆمارەکان و هاوسەنگیی پێداچوونەوە')} value={null} onClick={() => setAdvanced(true)} />
          <p className="fw-note">{loc('الأرقام اليومية تُحتسب تلقائيًا من العمليات. افتح هذه الأدوات لإدخال الأرصدة الافتتاحية ومراجعة الحسابات وإغلاق الشهر.', 'Daily figures follow operations automatically. Use these tools for opening balances, account review and closing the month.', 'ژمارە ڕۆژانەکان خۆکارانە لە کارەکانەوە دەژمێردرێن. ئەم ئامرازانە بکەرەوە بۆ باڵانسی سەرەتایی و پێداچوونەوەی حیسابەکان و داخستنی مانگ.')}</p>
        </Surface>
        {advanced && <FinanceOperationsPanel from={range.from} to={range.to} initialTab="accounting" onChanged={refresh} />}
        {legacy && <details className="fw-advanced" onToggle={(e) => setLegacyOpen(e.currentTarget.open)}><summary>{loc('التقرير المحاسبي قبل توزيع الأرباح', 'Accounting report before profit distribution', 'ڕاپۆرتی ژمێریاری پێش دابەشکردنی قازانج')}</summary>{legacyOpen && <><p className="fw-note">{loc('هذا التقرير يراجع النشاط المحاسبي قبل حصص المستثمرين والتصحيحات الخاصة بالطلبات. استخدم «صافي حصتك» في النظرة العامة لمعرفة حصتك بعد التوزيع وتكاليف الشهر.', 'This report reviews accounting activity before investor distributions and order-specific corrections. Use “Your net share” in Overview for your share after distributions and monthly costs.', 'ئەم ڕاپۆرتە چالاکیی ژمێریاری پێش بەشی وەبەرهێنەران و ڕاستکردنەوەکانی داواکاری پێداچوونەوە دەکات. «سافی بەشی تۆ» لە تێڕوانینی گشتی بەکاربهێنە بۆ زانینی بەشەکەت دوای دابەشکردن و تێچووی مانگ.')}</p>{legacy}</>}</details>}
      </Suspense>}
    </div>
    {orderId && <OrderProfitSheet key={`${orderId}:${orderFocus.step ?? ''}:${orderFocus.line ?? ''}`} orderId={orderId} focus={orderFocus.step} focusLine={orderFocus.line}
      onClose={() => { setOrderId(null); setOrderFocus({}); if (orderChanged.current) { orderChanged.current = false; setPeopleRevision((v) => v + 1); } }}
      onChanged={refresh} onSaved={() => { orderChanged.current = true; }} />}
    {collections && <Sheet title={loc('التحصيل وشركات التوصيل', 'Collections and couriers', 'وەرگرتن و کۆمپانیاکانی گەیاندن')} onClose={() => setCollections(false)}>
      <Suspense fallback={loading}><FinanceOperationsPanel from={range.from} to={range.to} initialTab="collections" onChanged={refresh} /></Suspense>
    </Sheet>}
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

/** The order types of 0174, as every screen names them. */
function orderKindName(kind: string, loc: (ar: string, en: string, ckb?: string) => string): string {
  return kind === 'quick_buy' ? `⚡ ${loc('شراء سريع', 'Quick Buy', 'کڕینی خێرا')}`
    : kind === 'gift' ? `🎁 ${loc('هدية', 'Gift', 'دیاری')}`
    : loc('طلب عادي', 'Regular order', 'داواکاری ئاسایی');
}

function OrderRow({ order, usd, onClick }: { order: FinanceOrder; usd?: UsdOrderCents; onClick: () => void }) {
  const { loc } = useLanguage();
  const view = orderFinancePresentation(order);
  const reasons = [...new Set(view.reviewReasons.map((issue) => ({
    fifo_missing: loc('تكلفة القطع غير مثبتة', 'Unit cost missing'),
    fifo_quantity_incomplete: loc('تخصيص المخزون غير مكتمل', 'Inventory allocation incomplete'),
    fifo_cost_missing: loc('تكلفة الدفعة ناقصة', 'Lot cost missing'),
    historical_cost_unverified: loc('تكلفة تاريخية غير معتمدة', 'Historical cost unverified'),
    return_cost_missing: loc('تكلفة المرتجع ناقصة', 'Return cost missing'),
    refund_amount_missing: loc('مبلغ الاسترداد ناقص', 'Refund amount missing'),
    verified_goods_cost_required: loc('نسبة الأجر تنتظر التكلفة', 'Profit-based pay awaits cost'),
    wage_reconciliation_pending: loc('الحساب التلقائي للأجر لم يكتمل', 'Automatic wage calculation incomplete'),
  } as Record<string, string>)[issue.code] ?? loc('بيانات تحتاج مراجعة', 'Details need review')))];
  return <button type="button" className="fw-order-row" onClick={onClick}>
    <div className="fw-order-identity"><span className="fw-order-icon"><Layers3 size={18} strokeWidth={1.6} /></span><div><h3>{order.customer_name || `${loc('طلب', 'Order')} ${order.order_id || order.id}`}</h3>
      <p>{(order.order_id || order.id).slice(-12)} · {financeDay(order.delivered_at || order.created_at)}</p>
      <Status tone={order.status === 'delivered' ? 'positive' : 'neutral'}>{statusName(order.status, loc)}</Status>
      {order.order_kind && order.order_kind !== 'normal' && <Status>{orderKindName(order.order_kind, loc)}</Status>}
      {view.needsReview && <><Status tone="warning">{loc('يحتاج مراجعة', 'Needs review')}</Status><p>{reasons.length ? reasons.slice(0, 2).join(' · ') : loc('افتح الطلب لمعرفة البنود المعلقة', 'Open the order to review pending lines')}{reasons.length > 2 ? ` · +${reasons.length - 2}` : ''}</p></>}
    </div></div><div className="fw-order-values">{view.amountKind === 'not_earned' ? <Status>{loc('غير مستحق', 'Not earned')}</Status> : <DisplayMoney iqd={view.amount} cents={view.amountKind === 'owner_net' && usd ? centsAt(usd.cents, 'owner_net_iqd') : undefined} />}<small>{view.amountKind === 'projected_goods_margin' ? loc('هامش البضاعة المتوقع · قبل المصاريف وغير مستحق', 'Forecast goods margin · before expenses, not earned') : view.amountKind === 'owner_net' ? loc('صافي المالك', 'Owner net') : loc('لا ربح مستحق من هذا الطلب', 'No earned profit from this order')}</small><ChevronLeft size={15} className="fw-muted" aria-hidden /></div>
  </button>;
}

/**
 * «حسب نوع الطلب»: the period's delivered orders split by what made them (0174) — the cart, a Quick Buy, gifts only —
 * from the summary. It stood on the old overview; the redesign keeps it with the orders (independent review, 2026-11-11).
 */
function OrderKinds({ data }: { data: FinanceSummary }) {
  const { loc } = useLanguage();
  const currency = useDisplayCurrency();
  const u = currency === 'USD' && data.display_usd?.available ? data.display_usd : undefined;
  if (!data.kinds?.length) return null;
  const cents = (kind: string, field: string) => (u ? centsAt(u.kinds?.[kind] ?? {}, field) : undefined);
  return <Surface title={loc('حسب نوع الطلب', 'By order type', 'بەپێی جۆری داواکاری')} subtitle={loc('الطلبات المستلمة في الفترة نفسها، مقسومة حسب طريقة إنشائها.', 'The same delivered orders, split by how each was placed.', 'هەمان داواکارییە گەیەندراوەکان، بەپێی شێوازی دروستکردنیان.')}>
    <div className="fw-table-wrap"><table className="fw-table" data-finance-kinds>
      <thead><tr><th scope="col">{loc('النوع', 'Type', 'جۆر')}</th><th scope="col">{loc('الطلبات', 'Orders', 'داواکارییەکان')}</th><th scope="col">{loc('صافي البيع', 'Net sales', 'فرۆشی پوخت')}</th><th scope="col">{loc('ربح البضاعة', 'Gross profit', 'قازانجی کاڵا')}</th></tr></thead>
      <tbody>{data.kinds.map((k) => <tr key={k.kind}><th scope="row">{orderKindName(k.kind, loc)}</th><td>{k.orders_count}</td>
        <td><DisplayMoney iqd={k.net_goods_iqd} cents={cents(k.kind, 'net_goods_iqd')} compact /></td><td><DisplayMoney iqd={k.gross_profit_iqd} cents={cents(k.kind, 'gross_profit_iqd')} compact /></td></tr>)}</tbody>
    </table></div>
    <p className="fw-note">{loc('الهدية تُطلب بـ0 د.ع وتبقى كلفة بضاعتها، فربحها السالب هو كلفة الهدايا. مبلغ الشراء السريع المحجوز في المحفظة ليس إيراداً؛ يدخل الطلب هنا بعد تسليمه فقط.', 'A gift is ordered at 0 IQD and keeps its goods cost, so its negative profit is what the gifts cost. A Quick Buy amount held in the wallet is not revenue; the order counts here only once delivered.', 'دیاری بە 0 دینار داوا دەکرێت و تێچووی کاڵاکەی دەمێنێتەوە، بۆیە قازانجە نەرێنییەکەی تێچووی دیارییەکانە. بڕی کڕینی خێرای گیراو لە جزدان داهات نییە؛ داواکاری تەنها دوای گەیاندن لێرە دەژمێردرێت.')}</p>
  </Surface>;
}

function Orders({ from, to, revision, openOrder, kinds }: { from: string; to: string; revision: number; openOrder: (id: string) => void; kinds?: FinanceSummary | null }) {
  const { loc } = useLanguage();
  const currency = useDisplayCurrency();
  const [usd, setUsd] = useState<DisplayUsdOrders | undefined>(undefined);
  const pageSize = 100;
  const [search, setSearch] = useState('');
  // What made the order (0174 order_kind): every kind, or one of them.
  const [kind, setKind] = useState('');
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<FinanceOrder[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => { setOffset(0); setRows([]); setTotal(0); }, [from, to, search, kind]);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError('');
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ from, to, q: search, offset: String(offset), ...(kind ? { kind } : {}), ...(currency === 'USD' ? { display: 'USD' } : {}) });
      api.get<{ orders: FinanceOrder[]; total: number; display_usd?: DisplayUsdOrders }>(`${WORKSPACE_API}/orders?${query}`, { signal: controller.signal })
        .then((r) => { if (!controller.signal.aborted) { setRows(r.orders ?? []); setTotal(r.total ?? r.orders?.length ?? 0); setUsd(r.display_usd); } })
        .catch((e) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); })
        .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    }, search ? 220 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [from, to, search, kind, offset, revision, currency]);
  return <>{kinds && <OrderKinds data={kinds} />}<Surface title={loc('أرباح الطلبات المستلمة', 'Delivered order profits')} subtitle={loc('الطلبات المكتملة بالتسليم فقط، حسب يوم التسليم. تشمل الأرباح والتكاليف أثر المرتجعات المسجلة.', 'Completed deliveries only, by delivery date. Profit and costs include recorded returns.')}>
    {/* The export is the period bar's «تصدير CSV», labelled, for every report (redesign step 2). */}
    <div className="fw-toolbar"><div className="fw-search"><Search aria-hidden /><input className="fw-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={loc('ابحث برقم الطلب أو اسم الزبون', 'Search order number or customer')} aria-label={loc('البحث عن الطلب', 'Find an order')} /></div>
      <select className="fw-select" style={{ width: 'auto', flexShrink: 0 }} value={kind} onChange={(e) => setKind(e.target.value)} aria-label={loc('نوع الطلب', 'Order kind')} data-finance-order-kind>
        <option value="">{loc('كل الطلبات', 'All orders')}</option>
        <option value="normal">{loc('طلب عادي', 'Normal')}</option>
        <option value="quick_buy">{loc('شراء سريع', 'Quick Buy')}</option>
        <option value="gift">{loc('طلب هدية', 'Gift order')}</option>
      </select></div>
    {error && <p className="fw-error" role="alert">{error}</p>}
    {currency === 'USD' && usd && <UsdBasisNote available={usd.available} atTimeCount={usd.at_time_count} todayCount={usd.today_count} todayRate={usd.today_rate} batchLines={usd.batch_cost_lines} />}
    {busy && !rows.length ? <Loading text={loc('تحميل الطلبات…', 'Loading orders…')} /> : rows.length ? <div className="fw-list" aria-busy={busy}>{rows.map((o) => <OrderRow order={o} usd={currency === 'USD' && usd?.available ? usd.orders?.[o.order_id || o.id] : undefined} key={o.id} onClick={() => openOrder(o.order_id || o.id)} />)}</div> : <Empty title={loc('لا توجد طلبات مستلمة مطابقة', 'No matching delivered orders')} text={loc('ابحث عن طلب مكتمل بالتسليم أو اختر فترة تسليم مختلفة.', 'Search for a completed delivery or choose another delivery date range.')} />}
    {total > pageSize && <div className="fw-pagination"><Button variant="ghost" disabled={busy || offset === 0} onClick={() => setOffset((v) => Math.max(0, v - pageSize))}>{loc('السابق', 'Previous')}</Button><span>{Math.floor(offset / pageSize) + 1} / {Math.ceil(total / pageSize)}</span><Button variant="ghost" disabled={busy || offset + rows.length >= total} onClick={() => setOffset((v) => v + pageSize)}>{loc('التالي', 'Next')}</Button></div>}
  </Surface></>;
}

function Products({ data, onOpenOrders }: { data: FinanceSummary; onOpenOrders: () => void }) {
  const { loc } = useLanguage();
  const currency = useDisplayCurrency();
  const u = currency === 'USD' && data.display_usd?.available ? data.display_usd : undefined;
  const rowCents = (p: FinanceProduct) => !u ? undefined : (p.level === 'main' ? u.categories?.main : p.level === 'sub' ? u.categories?.sub : u.products)?.[p.id] ?? {};
  const [q, setQ] = useState('');
  const [view, setView] = useState<'products' | 'categories'>('products');
  const rows = (view === 'products' ? data.products : data.categories)?.filter((p) => !q || p.name.toLocaleLowerCase().includes(q.toLocaleLowerCase())) ?? [];
  return <Surface title={loc('ربح المنتجات', 'Product profit')} subtitle={loc('منتجات الطلبات المستلمة في الفترة المحددة، بعد المرتجعات ونصيبها من التكاليف.', 'Products from delivered orders in this range, after returns and each product’s cost share.')}>
    <div className="fw-toolbar"><div className="fw-search"><Search aria-hidden /><input className="fw-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={loc('ابحث عن منتج أو قسم', 'Find a product or category')} /></div></div>
    <div className="fw-filter-pills"><button type="button" className="fw-pill" aria-pressed={view === 'products'} onClick={() => setView('products')}>{loc('المنتجات', 'Products')}</button><button type="button" className="fw-pill" aria-pressed={view === 'categories'} onClick={() => setView('categories')}>{loc('الأقسام', 'Categories')}</button></div>
    {currency === 'USD' && <UsdBasisNote available={!!data.display_usd?.available} atTimeCount={data.display_usd?.at_time_count} todayCount={data.display_usd?.today_count} todayRate={data.display_usd?.today_rate} batchLines={data.display_usd?.batch_cost_lines} />}
    {rows.length ? <div className="fw-list">{rows.map((p) => { const pc = rowCents(p); const pcs = (field: string) => centsAt(pc, field); return <Surface key={`${p.level ?? 'product'}:${p.id}`} className="fw-line-item"><div className="fw-line-heading">
      {p.product_image || p.image_url ? <VariantImg sizes="48px" className="fw-product-image" src={p.product_image || p.image_url} alt="" loading="lazy" /> : <span className="fw-order-icon"><Package size={20} /></span>}
      <div><h3>{p.name}</h3><p>{p.qty} {loc('قطعة مباعة', 'units sold')}{p.level === 'sub' ? ` · ${loc('قسم فرعي', 'Subsection')}` : p.level === 'main' ? ` · ${loc('قسم رئيسي', 'Main section')}` : ''}</p></div></div>
      <div className="fw-line-metrics"><div className="fw-line-metric"><span>{loc('صافي البيع', 'Net sales')}</span><DisplayMoney iqd={p.net_goods_iqd} cents={pcs('net_goods_iqd')} /></div><div className="fw-line-metric"><span>{loc('تكلفة البضاعة', 'Goods cost')}</span><DisplayMoney iqd={p.cogs_iqd} cents={pcs('cogs_iqd')} /></div><div className="fw-line-metric"><span>{loc('الأجور والمواد', 'Wages and materials')}</span><DisplayMoney iqd={p.wages_iqd == null || p.materials_iqd == null ? null : p.wages_iqd + p.materials_iqd} cents={pc ? (pcs('wages_iqd') == null || pcs('materials_iqd') == null ? null : pcs('wages_iqd')! + pcs('materials_iqd')!) : undefined} /></div><div className="fw-line-metric"><span>{loc('نصيب الترويج', 'Promotion share')}</span><DisplayMoney iqd={p.promotion_iqd} cents={pcs('promotion_iqd')} /></div></div>
      <Row label={loc('حصة المستثمر', 'Investor share')} value={<DisplayMoney iqd={p.investor_iqd} cents={pcs('investor_iqd')} />} />
      <Row label={loc('صافي المالك', 'Owner net')} value={<DisplayMoney iqd={p.owner_net_iqd} cents={pcs('owner_net_iqd')} />} prominent />
      <ReportDeductions totals={p} net={p.net_after_report_adjustments_iqd} cents={pc ? { coupon: pcs('coupon_iqd'), credit: pcs('price_protection_iqd'), tradeIn: pcs('trade_in_credit_returned_iqd'), net: pcs('net_after_report_adjustments_iqd') } : undefined} compact />
    </Surface>; })}</div> : <Empty title={loc('لا توجد منتجات في هذه الفترة', 'No products in this period')} text={loc('تظهر منتجات الطلبات المستلمة خلال الفترة هنا.', 'Products from orders delivered in the selected range appear here.')} />}
    <p className="fw-note">{loc('تكلفة الترويج توزيع إداري على المنتجات، وتُحمّل على المالك فقط.', 'Promotion shares are a management allocation borne by the owner only.')}</p>
    <Button variant="ghost" onClick={onOpenOrders}><CheckCircle2 size={16} />{loc('راجع الطلبات الأصلية', 'Review source orders')}</Button>
  </Surface>;
}

