import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
import { fw, rangeText, type FwKey } from './overviewStrings';
import ExpenseLedger from '../adminFinance/ExpenseLedger';
import { financeStrings } from '../adminFinance/strings';
import { isLatin } from '../adminFinance/format';

const PeoplePanel = lazy(() => import('../financePeople/PeoplePanel'));
const InvestorPanel = lazy(() => import('../financePeople/InvestorPanel'));
const WithdrawalPanel = lazy(() => import('../financePeople/WithdrawalPanel'));
const FinanceOperationsPanel = lazy(() => import('../adminOperations/FinanceOperationsPanel'));
const MissingCostsSheet = lazy(() => import('./MissingCostsSheet'));

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
 * Kept between tabs: the period's summary is read once and serves the overview, the products
 * and the badges; the comparison is read once per period and comparison; and a page the owner
 * leaves stays mounted, hidden and holding its refreshes (FreshOnReturnHold), so coming back
 * shows it at once instead of reading it again — until the period changes.
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
  const [data, setData] = useState<FinanceSummary | null>(null);
  const [prev, setPrev] = useState<{ key: string; data: FinanceSummary } | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState('');
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
  const showsCurrency = ['overview', 'orders', 'products'].includes(section);
  const display = currency === 'USD' ? '&display=USD' : '';
  const refresh = useCallback(() => setRevision((v) => v + 1), []);
  // The pages the owner left in this period, kept mounted and hidden; another period starts afresh.
  const keepKey = `${range.from}|${range.to}`;
  const [kept, setKept] = useState<{ key: string; pages: FinanceSection[] }>({ key: keepKey, pages: [] });
  const keptPages = kept.key === keepKey ? kept.pages : [];
  const setSection = (next: FinanceSection) => {
    if (next === section) return;
    setKept({ key: keepKey, pages: [...keptPages.filter((p) => p !== section && p !== next), section].filter((p) => KEPT.includes(p)) });
    setSectionState(next); setAdvanced(false); setLegacyOpen(false);
  };
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('finance', section); url.searchParams.set('from', range.from); url.searchParams.set('to', range.to);
    url.searchParams.set('financeMonth', month);
    window.history.replaceState(window.history.state, '', url);
  }, [section, range.from, range.to, month]);
  // One read of the period serves every section: switching pages never reloads it, and a new
  // period keeps the old figures on screen (dimmed) until its own arrive.
  useEffect(() => {
    const controller = new AbortController();
    const generation = ++summaryGeneration.current;
    setBusy(true); setError('');
    api.get<FinanceSummary>(`${WORKSPACE_API}/summary?from=${range.from}&to=${range.to}${display}`, { signal: controller.signal })
      .then((r) => { if (!controller.signal.aborted) { setData(r); setUpdatedAt(clock()); } })
      .catch((e) => {
        if (controller.signal.aborted) return;
        if (e instanceof ApiError && e.code === 'OWNER_EMAIL_UNVERIFIED') setMustVerify(true);
        else setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => { controller.abort(); summaryGeneration.current = generation + 1; };
  }, [range.from, range.to, revision, display]);
  // The comparison period, read once per period, comparison, currency and refresh — when the overview first needs it.
  const compareKey = compared ? `${compared.from}|${compared.to}|${display}|${revision}` : '';
  const comparison = prev && prev.key === compareKey ? prev.data : null;
  const wantsComparison = main === 'overview' && !!compareKey && !comparison;
  useEffect(() => {
    if (!wantsComparison) return;
    const [from, to, query] = compareKey.split('|');
    const controller = new AbortController();
    api.get<FinanceSummary>(`${WORKSPACE_API}/summary?from=${from}&to=${to}${query}`, { signal: controller.signal, mascot: 'silent' })
      .then((r) => { if (!controller.signal.aborted) setPrev({ key: compareKey, data: r }); }).catch(() => { /* no comparison: the cards say nothing of a change */ });
    return () => controller.abort();
  }, [compareKey, wantsComparison]);
  // These reads only display work completed by the server. They never start a
  // financial posting and stop while hidden or while an editing sheet is open.
  useFreshOnReturn(async () => {
    const generation = summaryGeneration.current;
    const updated = await api.get<FinanceSummary>(`${WORKSPACE_API}/summary?from=${range.from}&to=${range.to}${display}`, { mascot: 'silent' });
    if (generation !== summaryGeneration.current) return;
    setData(updated); setUpdatedAt(clock()); if (section === 'orders') setOrdersPoll((value) => value + 1);
  }, { pollWhileVisibleMs: 30_000, minIntervalMs: 30_000,
    enabled: ['overview', 'orders', 'products'].includes(section) && (data?.totals.pending_costs ?? 0) > 0 && !busy && !orderId && !collections && !advanced && !legacyOpen });
  const apply = (event: React.FormEvent) => { event.preventDefault(); if (!validFinanceRange(draft)) { setRangeError(true); return; } setRange(draft); setRangeError(false); setPreset(presetOf(draft)); };
  const missingLines = data?.missing_costs?.lines ?? 0;
  const loading = <Loading text={fw(loc, 'loading')} />;
  /** A page of the workspace: the one shown, or one the owner left in this period, kept hidden and holding its refreshes. */
  const page = (id: FinanceSection, body: () => ReactNode) => (id === section || keptPages.includes(id)) && <FreshOnReturnHold.Provider key={id} value={id !== section}>
    <div className="fw-body" style={id === section ? undefined : { display: 'none' }} data-finance-page={id}>{body()}</div></FreshOnReturnHold.Provider>;
  if (mustVerify) return <OwnerCostVerifyCard />;
  return <DisplayCurrencyContext.Provider value={showsCurrency || orderId ? currency : 'IQD'}><div className="fw fw-workspace" dir={dir} data-finance-workspace>
    <header className="fw-top">
      <div><div className="fw-muted">LEVONIS / {fw(loc, 'crumb')}</div><h1>{fw(loc, 'title')}</h1>
        {section !== 'monthly' && <p data-finance-range><bdi>{rangeText(L, range.from, range.to)}</bdi>{compared && main === 'overview' && <span className="fw-muted"> · {fw(loc, 'vs', { range: rangeText(L, compared.from, compared.to) })}</span>}</p>}</div>
      <div className="fw-top-tools">{updatedAt && <span className="fw-muted fw-updated">{fw(loc, 'updated', { time: updatedAt })}</span>}
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
      {page('overview', () => busy && !data ? loading : data && <div className={busy ? 'fw-reloading' : undefined}>
        <Overview data={data} prev={compared ? comparison : null} compareFrom={compared?.from} compareTo={compared?.to} revision={revision} openOrder={(id, step) => openOrderAt(id, step)}
          onNavigate={setSection} onCollections={() => setCollections(true)} onMissing={() => setSection('missing')} /></div>)}
      {page('orders', () => <Orders from={range.from} to={range.to} revision={revision + ordersPoll} openOrder={setOrderId} />)}
      {page('products', () => busy && !data ? loading : data && <Products data={data} onOpenOrders={() => setSection('orders')} />)}
      {page('missing', () => <Suspense fallback={loading}><MissingCostsSheet inline reload={peopleRevision} from={range.from} to={range.to} onClose={() => setSection('overview')} onChanged={refresh} openOrder={(id, step, line) => openOrderAt(id, step, line)} /></Suspense>)}
      {page('monthly', () => <><label className="fw-chip" style={{ justifySelf: 'start' }}><CalendarDays size={16} aria-hidden />
        <input type="month" className="fw-input" value={month} aria-label={loc('شهر التكاليف والمستحقات', 'Costs and earnings month', 'مانگی تێچوو و شایستەکان')} onChange={(e) => { if (/^\d{4}-(0[1-9]|1[0-2])$/.test(e.target.value)) setMonth(e.target.value); }} /></label>
        <MonthlyCosts key={month} month={month} onChanged={refresh} /></>)}
      {page('expenses', () => <Surface title={fw(loc, 'expenses')}><ExpenseLedger from={range.from} to={range.to} s={financeStrings(loc)} latin={isLatin(lang)} dir={dir === 'rtl' ? 'rtl' : 'ltr'} onChanged={refresh} /></Surface>)}
      {page('staff', () => <Suspense fallback={loading}><PeoplePanel from={range.from} to={range.to} onChanged={refresh} openOrder={openOrderAt} revision={peopleRevision} /></Suspense>)}
      {page('investors', () => <Suspense fallback={loading}><InvestorPanel from={range.from} to={range.to} onChanged={refresh} openOrder={openOrderAt} revision={peopleRevision} /></Suspense>)}
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

function Orders({ from, to, revision, openOrder }: { from: string; to: string; revision: number; openOrder: (id: string) => void }) {
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
  return <Surface title={loc('أرباح الطلبات المستلمة', 'Delivered order profits')} subtitle={loc('الطلبات المكتملة بالتسليم فقط، حسب يوم التسليم. تشمل الأرباح والتكاليف أثر المرتجعات المسجلة.', 'Completed deliveries only, by delivery date. Profit and costs include recorded returns.')}>
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
  </Surface>;
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

