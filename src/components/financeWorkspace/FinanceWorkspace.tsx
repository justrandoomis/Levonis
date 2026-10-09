import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDownToLine, ArrowUpLeft, BookOpen, CalendarDays, CheckCircle2, ChevronLeft, CircleDollarSign, Layers3, LayoutGrid, Megaphone, Package, RefreshCw, Search, ShieldCheck, Users, Wallet } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import OwnerCostVerifyCard from '../auth/OwnerCostVerifyCard';
import { useFreshOnReturn } from '../../lib/useFreshOnReturn';
import { useLanguage } from '../../LanguageContext';
import { Button, Empty, Loading, Row, Sheet, Status, Surface, formatMoney } from './ui';
import { currentMonth, financeDay, financePreset, financeRangeFromSearch, validFinanceRange, statusName, WORKSPACE_API, type DisplayUsdOrders, type FinanceOrder, type FinanceProduct, type FinanceSection, type FinanceSummary, type UsdOrderCents } from './types';
import OrderProfitSheet from './OrderProfitSheet';
import MonthlyCosts from './MonthlyCosts';
import './finance-workspace.css';
import { orderFinancePresentation } from './orderFinancePresentation';
import ReportDeductions from './ReportDeductions';
import { CurrencyToggle, DisplayCurrencyContext, DisplayMoney, UsdBasisNote, centsAt, useDisplayCurrency, type DisplayCurrency } from './displayCurrency';

const PeoplePanel = lazy(() => import('../financePeople/PeoplePanel'));
const InvestorPanel = lazy(() => import('../financePeople/InvestorPanel'));
const WithdrawalPanel = lazy(() => import('../financePeople/WithdrawalPanel'));
const FinanceOperationsPanel = lazy(() => import('../adminOperations/FinanceOperationsPanel'));
const ParticipantCharts = lazy(() => import('./ParticipantCharts'));
const OverviewCharts = lazy(() => import('./OverviewCharts'));

const initialSection = (): FinanceSection => {
  if (typeof window === 'undefined') return 'overview';
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('finance') || params.get('section');
  const aliases: Record<string, FinanceSection> = { withdrawals: 'settlements', people: 'staff', monthlycosts: 'monthly' };
  const tab = raw ? aliases[raw] ?? raw : null;
  return ['overview', 'orders', 'products', 'monthly', 'staff', 'investors', 'settlements', 'accounting'].includes(tab ?? '') ? tab as FinanceSection : 'overview';
};

export default function FinanceWorkspace({ legacy }: { legacy?: ReactNode }) {
  const { loc, dir } = useLanguage();
  const [section, setSection] = useState<FinanceSection>(initialSection);
  const [month, setMonth] = useState(() => {
    const value = typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('financeMonth') ?? '';
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : currentMonth();
  });
  const [initialPeriod] = useState(() => financeRangeFromSearch(typeof window === 'undefined' ? '' : window.location.search));
  const [range, setRange] = useState(initialPeriod.range);
  const [draft, setDraft] = useState(initialPeriod.range);
  const [rangeError, setRangeError] = useState(initialPeriod.invalid);
  const [preset, setPreset] = useState('custom');
  const [data, setData] = useState<FinanceSummary | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  // The owner's own session before the address is verified (DECISIONS row 185
  // amendment): the refusal is rendered BY CODE as the way to open this screen.
  const [mustVerify, setMustVerify] = useState(false);
  const [revision, setRevision] = useState(0);
  const [automaticRevision, setAutomaticRevision] = useState(0);
  const summaryGeneration = useRef(0);
  const [orderId, setOrderId] = useState<string | null>(() => typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('order'));
  const [collections, setCollections] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [legacyOpen, setLegacyOpen] = useState(false);
  // «عملة العرض» (design P-A §8): IQD on every load, never stored, display only.
  const [currency, setCurrency] = useState<DisplayCurrency>('IQD');
  const showsCurrency = ['overview', 'orders', 'products'].includes(section);
  const display = currency === 'USD' ? '&display=USD' : '';
  const usesRange = ['overview', 'orders', 'products', 'accounting', 'staff', 'investors', 'settlements'].includes(section);
  const refresh = useCallback(() => setRevision((v) => v + 1), []);
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('finance', section); url.searchParams.set('from', range.from); url.searchParams.set('to', range.to);
    url.searchParams.set('financeMonth', month);
    window.history.replaceState(window.history.state, '', url);
  }, [section, range.from, range.to, month]);
  useEffect(() => {
    const controller = new AbortController();
    const generation = ++summaryGeneration.current;
    setBusy(true); setError(''); setData(null);
    api.get<FinanceSummary>(`${WORKSPACE_API}/summary?from=${range.from}&to=${range.to}${display}`, { signal: controller.signal })
      .then((r) => { if (!controller.signal.aborted) setData(r); })
      .catch((e) => {
        if (controller.signal.aborted) return;
        if (e instanceof ApiError && e.code === 'OWNER_EMAIL_UNVERIFIED') setMustVerify(true);
        else setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => { controller.abort(); summaryGeneration.current = generation + 1; };
  }, [range.from, range.to, revision, display]);
  // These reads only display work completed by the server. They never start a
  // financial posting and stop while hidden or while an editing sheet is open.
  useFreshOnReturn(async () => {
    const generation = summaryGeneration.current;
    const updated = await api.get<FinanceSummary>(`${WORKSPACE_API}/summary?from=${range.from}&to=${range.to}${display}`, { mascot: 'silent' });
    if (generation !== summaryGeneration.current) return;
    setData(updated); setAutomaticRevision(value => value + 1);
  }, { pollWhileVisibleMs: 30_000, minIntervalMs: 30_000,
    enabled: ['overview', 'orders', 'products'].includes(section) && (data?.totals.pending_costs ?? 0) > 0 && !busy && !orderId && !collections && !advanced && !legacyOpen });
  const tabs = [
    { id: 'overview', label: loc('نظرة عامة', 'Overview'), icon: LayoutGrid },
    { id: 'orders', label: loc('الطلبات المستلمة', 'Delivered orders'), icon: Layers3 },
    { id: 'products', label: loc('المنتجات', 'Products'), icon: Package },
    { id: 'monthly', label: loc('تكاليف الشهر', 'Monthly costs'), icon: Megaphone },
    { id: 'staff', label: loc('الموظفون', 'Staff'), icon: Users },
    { id: 'investors', label: loc('المستثمرون', 'Investors'), icon: CircleDollarSign },
    { id: 'settlements', label: loc('السحب والتسويات', 'Withdrawals'), icon: Wallet },
    { id: 'accounting', label: loc('المحاسبة', 'Accounting'), icon: BookOpen },
  ] as const;
  if (mustVerify) return <OwnerCostVerifyCard />;
  return <DisplayCurrencyContext.Provider value={showsCurrency || orderId ? currency : 'IQD'}><div className="fw fw-workspace" dir={dir} data-finance-workspace>
    <header className="fw-header"><div><div className="fw-eyebrow">LEVONIS / {loc('الإدارة المالية', 'Finance')}</div><h1>{loc('المال والأرباح', 'Money & profit')}</h1>
      <p>{loc('راقب الأداء، وافهم التكاليف، وراجع حصتك من كل طلب.', 'Track performance, understand costs and review your share of every order.')}</p></div>
      <div className="fw-header-tools">{showsCurrency && <CurrencyToggle value={currency} onChange={setCurrency} />}{section === 'monthly' && <label className="fw-month-control"><CalendarDays size={16} aria-hidden />
        <input type="month" value={month} aria-label={loc('شهر التكاليف والمستحقات', 'Costs and earnings month')} onChange={(e) => { if (/^\d{4}-(0[1-9]|1[0-2])$/.test(e.target.value)) setMonth(e.target.value); }} /></label>}
        <Button className="fw-icon-button" variant="secondary" busy={busy} onClick={refresh} aria-label={loc('تحديث المالية', 'Refresh finance')}>
          {!busy && <RefreshCw size={17} />}
        </Button></div>
    </header>
    <nav className="fw-navigation" aria-label={loc('أقسام المالية', 'Finance sections')}>
      {tabs.map(({ id, label, icon: Icon }) => <button key={id} type="button" className="fw-nav-item" aria-current={section === id ? 'page' : undefined}
        onClick={() => { setSection(id); setAdvanced(false); setLegacyOpen(false); }}><Icon aria-hidden />{label}</button>)}
    </nav>
    {usesRange && <form className="fw-period" onSubmit={(event) => { event.preventDefault(); if (!validFinanceRange(draft)) { setRangeError(true); return; } setRange(draft); setRangeError(false); }}>
      <label className="fw-field"><span>{loc('فترة التقرير', 'Report period')}</span><select className="fw-select" value={preset} onChange={(event) => {
        setPreset(event.target.value); if (event.target.value === 'custom') return;
        const next = financePreset(event.target.value as Parameters<typeof financePreset>[0]); setDraft(next); setRange(next); setRangeError(false);
      }}><option value="custom">{loc('فترة مخصصة', 'Custom range')}</option><option value="month">{loc('هذا الشهر حتى اليوم', 'Month to date')}</option><option value="7days">{loc('آخر ٧ أيام', 'Last 7 days')}</option><option value="30days">{loc('آخر ٣٠ يومًا', 'Last 30 days')}</option><option value="previous">{loc('الشهر السابق', 'Previous month')}</option><option value="year">{loc('هذه السنة حتى اليوم', 'Year to date')}</option></select></label>
      {(['from', 'to'] as const).map((key) => <label className="fw-field" key={key}><span>{key === 'from' ? loc('من', 'From') : loc('إلى', 'To')}</span><input type="date" className="fw-input" value={draft[key]} aria-invalid={rangeError || undefined} aria-describedby={rangeError ? 'fw-range-error' : undefined} onChange={(event) => { setDraft((v) => ({ ...v, [key]: event.target.value })); setPreset('custom'); }} /></label>)}
      <button className="fw-button fw-button--primary" type="submit">{loc('عرض الفترة', 'Apply range')}</button>
      {rangeError && <p id="fw-range-error" className="fw-error" role="alert">{loc('أدخل تاريخين صحيحين؛ البداية قبل النهاية والفترة لا تتجاوز سنة. يُعرض آخر نطاق صالح.', 'Enter valid dates in order, within one year. The last valid range remains displayed.')}</p>}
    </form>}
    <div className="fw-body">
      {error && <div className="fw-error" role="alert">{error}<Button variant="ghost" onClick={refresh}>{loc('إعادة المحاولة', 'Retry')}</Button></div>}
      {section === 'overview' && (busy && !data ? <Loading text={loc('تحميل أرقام الفترة…', 'Loading this period…')} /> : data && <Overview from={range.from} to={range.to} revision={revision} data={data} openOrder={setOrderId} onNavigate={setSection} onCollections={() => setCollections(true)} />)}
      {section === 'orders' && <Orders from={range.from} to={range.to} revision={revision + automaticRevision} openOrder={setOrderId} />}
      {section === 'products' && (busy && !data ? <Loading text={loc('تحميل المنتجات…', 'Loading products…')} /> : data && <Products data={data} onOpenOrders={() => setSection('orders')} />)}
      {section === 'monthly' && <MonthlyCosts key={month} month={month} onChanged={refresh} />}
      <Suspense fallback={<Loading text={loc('تحميل…', 'Loading…')} />}>
        {section === 'staff' && <PeoplePanel from={range.from} to={range.to} onChanged={refresh} />}
        {section === 'investors' && <InvestorPanel from={range.from} to={range.to} onChanged={refresh} />}
        {section === 'settlements' && <WithdrawalPanel from={range.from} to={range.to} onChanged={refresh} />}
        {section === 'accounting' && <>
          <Surface title={loc('المحاسبة', 'Accounting')} subtitle={loc('الأرصدة والقيود والتسويات المعتمدة', 'Balances, journals and verified settlements')}>
            <Row label={loc('دفتر القيود وميزان المراجعة', 'Journal and trial balance')} value={<ArrowUpLeft size={18} />} onClick={() => setAdvanced(true)} />
            <p className="fw-note">{loc('الأرقام اليومية تُحتسب تلقائيًا من العمليات. افتح هذه الأدوات لإدخال الأرصدة الافتتاحية ومراجعة الحسابات وإغلاق الشهر.', 'Daily figures follow operations automatically. Use these tools for opening balances, account review and closing the month.')}</p>
          </Surface>
          {advanced && <FinanceOperationsPanel from={range.from} to={range.to} initialTab="accounting" onChanged={refresh} />}
          {legacy && <details className="fw-advanced" onToggle={(e) => setLegacyOpen(e.currentTarget.open)}><summary>{loc('التقرير المحاسبي قبل توزيع الأرباح', 'Accounting report before profit distribution')}</summary>{legacyOpen && <><p className="fw-note">{loc('هذا التقرير يراجع النشاط المحاسبي قبل حصص المستثمرين والتصحيحات الخاصة بالطلبات. استخدم «صافي حصتك» في النظرة العامة لمعرفة حصتك بعد التوزيع وتكاليف الشهر.', 'This report reviews accounting activity before investor distributions and order-specific corrections. Use “Your net share” in Overview for your share after distributions and monthly costs.')}</p>{legacy}</>}</details>}
        </>}
      </Suspense>
    </div>
    {orderId && <OrderProfitSheet orderId={orderId} onClose={() => setOrderId(null)} onChanged={refresh} />}
    {collections && <Sheet title={loc('التحصيل وشركات التوصيل', 'Collections and couriers')} onClose={() => setCollections(false)}>
      <Suspense fallback={<Loading text={loc('تحميل…', 'Loading…')} />}><FinanceOperationsPanel from={range.from} to={range.to} initialTab="collections" onChanged={refresh} /></Suspense>
    </Sheet>}
  </div></DisplayCurrencyContext.Provider>;
}

function Overview({ data, from, to, revision, openOrder, onNavigate, onCollections }: { data: FinanceSummary; from: string; to: string; revision: number; openOrder: (id: string) => void; onNavigate: (section: FinanceSection) => void; onCollections: () => void }) {
  const { loc } = useLanguage();
  const t = data.totals;
  // Server cents when the owner chose USD and a rate exists; undefined keeps a figure in dinars.
  const currency = useDisplayCurrency();
  const u = currency === 'USD' && data.display_usd?.available ? data.display_usd : undefined;
  const ut = u?.totals;
  const c = (field: string) => centsAt(ut, field);
  const incomplete = (t.unknown_lines ?? 0) + (t.pending_costs ?? 0);
  const needsReview = incomplete > 0 || t.owner_period_net_iqd === null;
  const net = t.owner_period_net_iqd !== undefined ? t.owner_period_net_iqd : t.owner_net_iqd;
  const revenue = data.chart_data?.revenue_iqd;
  const margin = net != null && revenue != null && revenue > 0 ? `${(net / revenue * 100).toFixed(1)}%` : '—';
  const metrics = [
    { label: loc('صافي حصتك', 'Your net share'), value: net, cents: ut ? (t.owner_period_net_iqd !== undefined ? ut.owner_period_net_cents : ut.owner_net_cents) ?? null : undefined, note: `${loc('هامش حصتك', 'Your share margin')} ${margin}`, primary: true },
    { label: loc('الإيراد', 'Revenue'), value: revenue, cents: u?.chart ? u.chart.revenue_cents : undefined, note: loc('بعد المرتجعات، مع إيراد التوصيل والدفع', 'After refunds, including delivery and payment income') },
    { label: loc('إجمالي التكاليف', 'Total costs'), value: data.chart_data?.cost_iqd, cents: u?.chart ? u.chart.cost_cents : undefined, note: loc('البضاعة والتشغيل والترويج والمصاريف العامة', 'Goods, operations, promotion and general expenses') },
  ];
  const sum = (a: number | null | undefined, b: number | null | undefined) => a == null || b == null ? null : a + b;
  return <>
    <div className="fw-overview-caption"><h2>{loc('الأداء المالي للفترة', 'Financial performance')}</h2>{needsReview ? <Status tone="warning">{loc('الحساب يحتاج مراجعة', 'Figures need review')}</Status> : <Status><ShieldCheck size={13} />{loc('الطلبات المستلمة', 'Delivered orders')}</Status>}</div>
    {currency === 'USD' && <UsdBasisNote available={!!data.display_usd?.available} atTimeCount={data.display_usd?.at_time_count} todayCount={data.display_usd?.today_count} todayRate={data.display_usd?.today_rate} />}
    <div className="fw-metrics">{metrics.map((m) => <div className={`fw-metric${m.primary ? ' fw-metric--primary' : ''}`} key={m.label}><span>{m.label}</span><DisplayMoney iqd={m.value} cents={m.cents} /><small>{m.note}</small></div>)}
      <div className="fw-metric"><span>{loc('الطلبات المستلمة', 'Delivered orders')}</span><strong>{t.orders_count ?? data.orders.length}</strong><small>{t.units ?? 0} {loc('قطعة مباعة', 'units sold')} · <DisplayMoney iqd={revenue != null && (t.orders_count ?? 0) > 0 ? revenue / t.orders_count! : null} cents={u?.chart ? ((t.orders_count ?? 0) > 0 ? Math.round(u.chart.revenue_cents / t.orders_count!) : null) : undefined} compact /> {loc('متوسط الطلب', 'average order')}</small></div>
    </div>
    {data.truncated && <p className="fw-error" role="alert">{loc('عدد الطلبات يتجاوز حد التقرير؛ راجع الفترة قبل اعتماد الإجمالي.', 'Order count exceeds the report limit. Review the period before accepting totals.')}</p>}
    {needsReview && <p className="fw-note">{loc('الشرطة (—) تعني قيمة لم تكتمل، ولا تعني صفرًا. راجع التكاليف أو توزيع الأرباح قبل اعتماد الصافي.', 'A dash (—) means an incomplete value, not zero. Review costs or profit distribution before accepting the net figure.')}</p>}
    <Suspense fallback={<Loading text={loc('تحميل الرسوم المالية…', 'Loading financial charts…')} />}><OverviewCharts data={data} usd={u} /><ParticipantCharts from={from} to={to} revision={revision} /></Suspense>
    <details className="fw-advanced"><summary>{loc('تفصيل الحساب: من البيع إلى حصتك', 'Calculation breakdown: from sales to your share')}</summary><Surface>
      <Row label={loc('ربح البضاعة', 'Goods profit')} value={<DisplayMoney iqd={t.gross_profit_iqd} cents={c('gross_profit_iqd')} />} />
      <Row label={loc('أجور الموظفين', 'Staff earnings')} value={<DisplayMoney iqd={t.wages_iqd} cents={c('wages_iqd')} />} onClick={() => onNavigate('staff')} />
      <Row label={loc('المواد والتكاليف الإضافية', 'Materials and extra costs')} value={<DisplayMoney iqd={t.materials_iqd == null || t.manual_direct_iqd == null ? null : t.materials_iqd + t.manual_direct_iqd} cents={ut ? sum(c('materials_iqd'), c('manual_direct_iqd')) : undefined} />} />
      <Row label={loc('التوصيل على الزبائن', 'Delivery income')} value={<DisplayMoney iqd={t.shipping_income_iqd} cents={c('shipping_income_iqd')} />} />
      <Row label={loc('رسوم الدفع عند الاستلام', 'Cash-on-delivery income')} value={<DisplayMoney iqd={t.cod_tax_iqd} cents={c('cod_tax_iqd')} />} />
      <Row label={loc('أجور التوصيل والدفع', 'Courier and payment fees')} value={<DisplayMoney iqd={t.courier_fee_iqd == null || t.payment_fee_iqd == null ? null : t.courier_fee_iqd + t.payment_fee_iqd} cents={ut ? sum(c('courier_fee_iqd'), c('payment_fee_iqd')) : undefined} />} />
      <Row label={loc('ترويج الشهر', 'Monthly promotion')} value={<DisplayMoney iqd={t.promotion_iqd} cents={c('promotion_iqd')} />} onClick={() => onNavigate('monthly')} />
      {(t.unallocated_promotion_iqd ?? 0) > 0 && <Row label={loc('ترويج لم تُبع له قطع بعد', 'Promotion without sold units')} value={<DisplayMoney iqd={t.unallocated_promotion_iqd} cents={c('unallocated_promotion_iqd')} />} onClick={() => onNavigate('monthly')} />}
      <Row label={loc('حصة المستثمرين', 'Investor share')} value={<DisplayMoney iqd={t.investor_iqd} cents={c('investor_iqd')} />} onClick={() => onNavigate('investors')} hint={(t.investor_iqd ?? 0) < 0 ? loc('مساهمة المستثمر في الخسارة', 'Investor contribution to the loss') : undefined} />
      <Row label={loc('المصاريف العامة', 'General expenses')} value={<DisplayMoney iqd={t.general_expenses_iqd} cents={c('general_expenses_iqd')} />} onClick={() => onNavigate('monthly')} />
      <Row label={loc('صافي المالك', 'Owner net')} value={<DisplayMoney iqd={t.owner_period_net_iqd !== undefined ? t.owner_period_net_iqd : t.owner_net_iqd} cents={t.owner_period_net_iqd !== undefined ? c('owner_period_net_iqd') : c('owner_net_iqd')} />} prominent />
      <ReportDeductions totals={t} net={t.owner_period_net_after_report_adjustments_iqd} cents={ut ? { coupon: c('coupon_iqd'), credit: c('price_protection_iqd'), net: c('owner_period_net_after_report_adjustments_iqd') } : undefined} />
    </Surface></details>
    {data.kinds && <Surface title={loc('حسب نوع الطلب', 'By order type', 'بەپێی جۆری داواکاری')} subtitle={loc('الطلبات المستلمة في الفترة نفسها، مقسومة حسب طريقة إنشائها.', 'The same delivered orders, split by how each was placed.', 'هەمان داواکارییە گەیەندراوەکان، بەپێی شێوازی دروستکردنیان.')}>
      {data.kinds.map((k) => <Row key={k.kind} label={orderKindName(k.kind, loc)}
        hint={`${k.orders_count} ${loc('طلب', 'orders', 'داواکاری')} · ${loc('صافي البيع', 'Net sales', 'فرۆشی پوخت')} ${formatMoney(k.net_goods_iqd)}`}
        value={<DisplayMoney iqd={k.gross_profit_iqd} cents={u?.kinds ? centsAt(u.kinds[k.kind], 'gross_profit_iqd') : undefined} />} />)}
      <p className="fw-note">{loc('القيمة ربح البضاعة. الهدية تُطلب بـ0 د.ع وتبقى كلفة بضاعتها، فربحها السالب هو كلفة الهدايا. مبلغ الشراء السريع المحجوز في المحفظة ليس إيراداً؛ يدخل الطلب هنا بعد تسليمه فقط.', 'Values are goods profit. A gift is ordered at 0 IQD and keeps its goods cost, so its negative profit is what the gifts cost. A Quick Buy amount held in the wallet is not revenue; the order counts here only once delivered.', 'بەهاکان قازانجی کاڵایە. دیاری بە 0 دینار داوا دەکرێت و تێچووی کاڵاکەی دەمێنێتەوە، بۆیە قازانجە نەرێنییەکەی تێچووی دیارییەکانە. بڕی کڕینی خێرای گیراو لە جزدان داهات نییە؛ داواکاری تەنها دوای گەیاندن لێرە دەژمێردرێت.')}</p>
    </Surface>}
    <div className="fw-two-columns"><Surface title={loc('أحدث الطلبات المستلمة', 'Latest delivered orders')} action={<Button variant="ghost" onClick={() => onNavigate('orders')}>{loc('عرض الكل', 'View all')}<ArrowUpLeft size={15} /></Button>}>
      {data.orders?.length ? <div className="fw-list">{data.orders.slice(0, 3).map((o) => <OrderRow order={o} usd={u?.orders?.[o.order_id || o.id]} key={o.id} onClick={() => openOrder(o.order_id || o.id)} />)}</div> : <Empty title={loc('لا طلبات مستلمة في الفترة', 'No delivered orders in this range')} text={loc('يمكن أن تبقى المصاريف العامة والترويج مستحقين حتى دون مبيعات.', 'General expenses and promotion may still apply without sales.')} />}
    </Surface>
    <Surface title={loc('المتابعة', 'Follow-up')}>
      <Row label={loc('حصص المستثمرين', 'Investor shares')} value={<DisplayMoney iqd={t.investor_iqd} cents={c('investor_iqd')} />} onClick={() => onNavigate('investors')} />
      <Row label={loc('المبالغ المحصلة', 'Cash collected')} value={<DisplayMoney iqd={t.collected_iqd} cents={c('collected_iqd')} />} />
      <Row label={loc('فرق التحصيل', 'Collection difference')} value={<DisplayMoney iqd={t.collection_difference_iqd} cents={c('collection_difference_iqd')} />} onClick={onCollections} />
      {needsReview && <Row label={loc('تكاليف أو تسويات تحتاج مراجعة', 'Costs or settlements need review')} value={<Status tone="warning">{incomplete || loc('مراجعة', 'Review')}</Status>} onClick={() => onNavigate('orders')} />}
      <p className="fw-note">{loc('الربح يختلف عن النقد المحصل. المرتجعات وتصحيحات التكاليف تظهر في تفاصيل الطلب.', 'Profit differs from collected cash. Returns and financial corrections appear in order details.')}</p>
    </Surface></div>
  </>;
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
  return <Surface title={loc('أرباح الطلبات المستلمة', 'Delivered order profits')} subtitle={loc('الطلبات المكتملة بالتسليم فقط، حسب يوم التسليم. تشمل الأرباح والتكاليف أثر المرتجعات المسجلة.', 'Completed deliveries only, by delivery date. Profit and costs include recorded returns.')} action={<Button variant="ghost" onClick={() => { window.location.href = `${WORKSPACE_API}/export.csv?from=${from}&to=${to}`; }} aria-label={loc('تصدير التقرير', 'Export report')}><ArrowDownToLine size={17} /></Button>}>
    <div className="fw-toolbar"><div className="fw-search"><Search aria-hidden /><input className="fw-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={loc('ابحث برقم الطلب أو اسم الزبون', 'Search order number or customer')} aria-label={loc('البحث عن الطلب', 'Find an order')} /></div>
      <select className="fw-select" style={{ width: 'auto', flexShrink: 0 }} value={kind} onChange={(e) => setKind(e.target.value)} aria-label={loc('نوع الطلب', 'Order kind')} data-finance-order-kind>
        <option value="">{loc('كل الطلبات', 'All orders')}</option>
        <option value="normal">{loc('طلب عادي', 'Normal')}</option>
        <option value="quick_buy">{loc('شراء سريع', 'Quick Buy')}</option>
        <option value="gift">{loc('طلب هدية', 'Gift order')}</option>
      </select></div>
    {error && <p className="fw-error" role="alert">{error}</p>}
    {currency === 'USD' && usd && <UsdBasisNote available={usd.available} atTimeCount={usd.at_time_count} todayCount={usd.today_count} todayRate={usd.today_rate} />}
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
    {currency === 'USD' && <UsdBasisNote available={!!data.display_usd?.available} atTimeCount={data.display_usd?.at_time_count} todayCount={data.display_usd?.today_count} todayRate={data.display_usd?.today_rate} />}
    {rows.length ? <div className="fw-list">{rows.map((p) => { const pc = rowCents(p); const pcs = (field: string) => centsAt(pc, field); return <Surface key={`${p.level ?? 'product'}:${p.id}`} className="fw-line-item"><div className="fw-line-heading">
      {p.product_image || p.image_url ? <img className="fw-product-image" src={p.product_image || p.image_url} alt="" loading="lazy" /> : <span className="fw-order-icon"><Package size={20} /></span>}
      <div><h3>{p.name}</h3><p>{p.qty} {loc('قطعة مباعة', 'units sold')}{p.level === 'sub' ? ` · ${loc('قسم فرعي', 'Subsection')}` : p.level === 'main' ? ` · ${loc('قسم رئيسي', 'Main section')}` : ''}</p></div></div>
      <div className="fw-line-metrics"><div className="fw-line-metric"><span>{loc('صافي البيع', 'Net sales')}</span><DisplayMoney iqd={p.net_goods_iqd} cents={pcs('net_goods_iqd')} /></div><div className="fw-line-metric"><span>{loc('تكلفة البضاعة', 'Goods cost')}</span><DisplayMoney iqd={p.cogs_iqd} cents={pcs('cogs_iqd')} /></div><div className="fw-line-metric"><span>{loc('الأجور والمواد', 'Wages and materials')}</span><DisplayMoney iqd={p.wages_iqd == null || p.materials_iqd == null ? null : p.wages_iqd + p.materials_iqd} cents={pc ? (pcs('wages_iqd') == null || pcs('materials_iqd') == null ? null : pcs('wages_iqd')! + pcs('materials_iqd')!) : undefined} /></div><div className="fw-line-metric"><span>{loc('نصيب الترويج', 'Promotion share')}</span><DisplayMoney iqd={p.promotion_iqd} cents={pcs('promotion_iqd')} /></div></div>
      <Row label={loc('حصة المستثمر', 'Investor share')} value={<DisplayMoney iqd={p.investor_iqd} cents={pcs('investor_iqd')} />} />
      <Row label={loc('صافي المالك', 'Owner net')} value={<DisplayMoney iqd={p.owner_net_iqd} cents={pcs('owner_net_iqd')} />} prominent />
      <ReportDeductions totals={p} net={p.net_after_report_adjustments_iqd} cents={pc ? { coupon: pcs('coupon_iqd'), credit: pcs('price_protection_iqd'), net: pcs('net_after_report_adjustments_iqd') } : undefined} compact />
    </Surface>; })}</div> : <Empty title={loc('لا توجد منتجات في هذه الفترة', 'No products in this period')} text={loc('تظهر منتجات الطلبات المستلمة خلال الفترة هنا.', 'Products from orders delivered in the selected range appear here.')} />}
    <p className="fw-note">{loc('تكلفة الترويج توزيع إداري على المنتجات، وتُحمّل على المالك فقط.', 'Promotion shares are a management allocation borne by the owner only.')}</p>
    <Button variant="ghost" onClick={onOpenOrders}><CheckCircle2 size={16} />{loc('راجع الطلبات الأصلية', 'Review source orders')}</Button>
  </Surface>;
}

