import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowDownToLine, ArrowUpLeft, BookOpen, CalendarDays, CheckCircle2, ChevronLeft, CircleDollarSign, Layers3, LayoutGrid, Megaphone, Package, RefreshCw, Search, ShieldCheck, Users, Wallet } from 'lucide-react';
import { api } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import { Button, Empty, Loading, Money, Row, Sheet, Status, Surface } from './ui';
import { currentMonth, financeDay, financePreset, financeRangeFromSearch, validFinanceRange, statusName, WORKSPACE_API, type FinanceOrder, type FinanceSection, type FinanceSummary } from './types';
import OrderProfitSheet from './OrderProfitSheet';
import MonthlyCosts from './MonthlyCosts';
import './finance-workspace.css';

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
  const [revision, setRevision] = useState(0);
  const [orderId, setOrderId] = useState<string | null>(() => typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('order'));
  const [collections, setCollections] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [legacyOpen, setLegacyOpen] = useState(false);
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
    setBusy(true); setError(''); setData(null);
    api.get<FinanceSummary>(`${WORKSPACE_API}/summary?from=${range.from}&to=${range.to}`, { signal: controller.signal })
      .then((r) => { if (!controller.signal.aborted) setData(r); })
      .catch((e) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [range.from, range.to, revision]);
  const tabs = [
    { id: 'overview', label: loc('نظرة عامة', 'Overview'), icon: LayoutGrid },
    { id: 'orders', label: loc('الطلبات', 'Orders'), icon: Layers3 },
    { id: 'products', label: loc('المنتجات', 'Products'), icon: Package },
    { id: 'monthly', label: loc('تكاليف الشهر', 'Monthly costs'), icon: Megaphone },
    { id: 'staff', label: loc('الموظفون', 'Staff'), icon: Users },
    { id: 'investors', label: loc('المستثمرون', 'Investors'), icon: CircleDollarSign },
    { id: 'settlements', label: loc('السحب والتسويات', 'Withdrawals'), icon: Wallet },
    { id: 'accounting', label: loc('المحاسبة', 'Accounting'), icon: BookOpen },
  ] as const;
  return <div className="fw fw-workspace" dir={dir} data-finance-workspace>
    <header className="fw-header"><div><div className="fw-eyebrow">LEVONIS / {loc('الإدارة المالية', 'Finance')}</div><h1>{loc('المال والأرباح', 'Money & profit')}</h1>
      <p>{loc('راقب الأداء، وافهم التكاليف، وراجع حصتك من كل طلب.', 'Track performance, understand costs and review your share of every order.')}</p></div>
      <div className="fw-header-tools">{section === 'monthly' && <label className="fw-month-control"><CalendarDays size={16} aria-hidden />
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
      {section === 'orders' && <Orders from={range.from} to={range.to} revision={revision} openOrder={setOrderId} />}
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
  </div>;
}

function Overview({ data, from, to, revision, openOrder, onNavigate, onCollections }: { data: FinanceSummary; from: string; to: string; revision: number; openOrder: (id: string) => void; onNavigate: (section: FinanceSection) => void; onCollections: () => void }) {
  const { loc } = useLanguage();
  const t = data.totals;
  const incomplete = (t.unknown_lines ?? 0) + (t.pending_costs ?? 0);
  const needsReview = incomplete > 0 || t.owner_period_net_iqd === null;
  const net = t.owner_period_net_iqd !== undefined ? t.owner_period_net_iqd : t.owner_net_iqd;
  const revenue = data.chart_data?.revenue_iqd;
  const margin = net != null && revenue != null && revenue > 0 ? `${(net / revenue * 100).toFixed(1)}%` : '—';
  const metrics = [
    { label: loc('صافي حصتك', 'Your net share'), value: net, note: `${loc('هامش حصتك', 'Your share margin')} ${margin}`, primary: true },
    { label: loc('الإيراد', 'Revenue'), value: revenue, note: loc('بعد المرتجعات، مع إيراد التوصيل والدفع', 'After refunds, including delivery and payment income') },
    { label: loc('إجمالي التكاليف', 'Total costs'), value: data.chart_data?.cost_iqd, note: loc('البضاعة والتشغيل والترويج والمصاريف العامة', 'Goods, operations, promotion and general expenses') },
  ];
  return <>
    <div className="fw-overview-caption"><h2>{loc('الأداء المالي للفترة', 'Financial performance')}</h2>{needsReview ? <Status tone="warning">{loc('الحساب يحتاج مراجعة', 'Figures need review')}</Status> : <Status><ShieldCheck size={13} />{loc('الطلبات المستلمة', 'Delivered orders')}</Status>}</div>
    <div className="fw-metrics">{metrics.map((m) => <div className={`fw-metric${m.primary ? ' fw-metric--primary' : ''}`} key={m.label}><span>{m.label}</span><Money value={m.value} /><small>{m.note}</small></div>)}
      <div className="fw-metric"><span>{loc('الطلبات المستلمة', 'Delivered orders')}</span><strong>{t.orders_count ?? data.orders.length}</strong><small>{t.units ?? 0} {loc('قطعة مباعة', 'units sold')} · <Money value={revenue != null && (t.orders_count ?? 0) > 0 ? revenue / t.orders_count! : null} compact /> {loc('متوسط الطلب', 'average order')}</small></div>
    </div>
    {data.truncated && <p className="fw-error" role="alert">{loc('عدد الطلبات يتجاوز حد التقرير؛ راجع الفترة قبل اعتماد الإجمالي.', 'Order count exceeds the report limit. Review the period before accepting totals.')}</p>}
    {needsReview && <p className="fw-note">{loc('الشرطة (—) تعني قيمة لم تكتمل، ولا تعني صفرًا. راجع التكاليف أو توزيع الأرباح قبل اعتماد الصافي.', 'A dash (—) means an incomplete value, not zero. Review costs or profit distribution before accepting the net figure.')}</p>}
    <Suspense fallback={<Loading text={loc('تحميل الرسوم المالية…', 'Loading financial charts…')} />}><OverviewCharts data={data} /><ParticipantCharts from={from} to={to} revision={revision} /></Suspense>
    <details className="fw-advanced"><summary>{loc('تفصيل الحساب: من البيع إلى حصتك', 'Calculation breakdown: from sales to your share')}</summary><Surface>
      <Row label={loc('ربح البضاعة', 'Goods profit')} value={<Money value={t.gross_profit_iqd} />} />
      <Row label={loc('أجور الموظفين', 'Staff earnings')} value={<Money value={t.wages_iqd} />} onClick={() => onNavigate('staff')} />
      <Row label={loc('المواد والتكاليف الإضافية', 'Materials and extra costs')} value={<Money value={t.materials_iqd == null || t.manual_direct_iqd == null ? null : t.materials_iqd + t.manual_direct_iqd} />} />
      <Row label={loc('التوصيل على الزبائن', 'Delivery income')} value={<Money value={t.shipping_income_iqd} />} />
      <Row label={loc('رسوم الدفع عند الاستلام', 'Cash-on-delivery income')} value={<Money value={t.cod_tax_iqd} />} />
      <Row label={loc('أجور التوصيل والدفع', 'Courier and payment fees')} value={<Money value={t.courier_fee_iqd == null || t.payment_fee_iqd == null ? null : t.courier_fee_iqd + t.payment_fee_iqd} />} />
      <Row label={loc('ترويج الشهر', 'Monthly promotion')} value={<Money value={t.promotion_iqd} />} onClick={() => onNavigate('monthly')} />
      {(t.unallocated_promotion_iqd ?? 0) > 0 && <Row label={loc('ترويج لم تُبع له قطع بعد', 'Promotion without sold units')} value={<Money value={t.unallocated_promotion_iqd} />} onClick={() => onNavigate('monthly')} />}
      <Row label={loc('حصة المستثمرين', 'Investor share')} value={<Money value={t.investor_iqd} />} onClick={() => onNavigate('investors')} hint={(t.investor_iqd ?? 0) < 0 ? loc('مساهمة المستثمر في الخسارة', 'Investor contribution to the loss') : undefined} />
      <Row label={loc('المصاريف العامة', 'General expenses')} value={<Money value={t.general_expenses_iqd} />} onClick={() => onNavigate('monthly')} />
      <Row label={loc('صافي المالك', 'Owner net')} value={<Money value={t.owner_period_net_iqd !== undefined ? t.owner_period_net_iqd : t.owner_net_iqd} />} prominent />
    </Surface></details>
    <div className="fw-two-columns"><Surface title={loc('أحدث الطلبات المستلمة', 'Latest delivered orders')} action={<Button variant="ghost" onClick={() => onNavigate('orders')}>{loc('عرض الكل', 'View all')}<ArrowUpLeft size={15} /></Button>}>
      {data.orders?.length ? <div className="fw-list">{data.orders.slice(0, 3).map((o) => <OrderRow order={o} key={o.id} onClick={() => openOrder(o.order_id || o.id)} />)}</div> : <Empty title={loc('لا طلبات مستلمة في الفترة', 'No delivered orders in this range')} text={loc('يمكن أن تبقى المصاريف العامة والترويج مستحقين حتى دون مبيعات.', 'General expenses and promotion may still apply without sales.')} />}
    </Surface>
    <Surface title={loc('المتابعة', 'Follow-up')}>
      <Row label={loc('حصص المستثمرين', 'Investor shares')} value={<Money value={t.investor_iqd} />} onClick={() => onNavigate('investors')} />
      <Row label={loc('المبالغ المحصلة', 'Cash collected')} value={<Money value={t.collected_iqd} />} />
      <Row label={loc('فرق التحصيل', 'Collection difference')} value={<Money value={t.collection_difference_iqd} />} onClick={onCollections} />
      {needsReview && <Row label={loc('تكاليف أو تسويات تحتاج مراجعة', 'Costs or settlements need review')} value={<Status tone="warning">{incomplete || loc('مراجعة', 'Review')}</Status>} onClick={() => onNavigate('orders')} />}
      <p className="fw-note">{loc('الربح يختلف عن النقد المحصل. المرتجعات وتصحيحات التكاليف تظهر في تفاصيل الطلب.', 'Profit differs from collected cash. Returns and financial corrections appear in order details.')}</p>
    </Surface></div>
  </>;
}

function OrderRow({ order, onClick }: { order: FinanceOrder; onClick: () => void }) {
  const { loc } = useLanguage();
  const reasons = [...new Set((order.review_reasons ?? []).map((issue) => ({
    fifo_missing: loc('تكلفة القطع غير مثبتة', 'Unit cost missing'),
    fifo_quantity_incomplete: loc('تخصيص المخزون غير مكتمل', 'Inventory allocation incomplete'),
    fifo_cost_missing: loc('تكلفة الدفعة ناقصة', 'Lot cost missing'),
    historical_cost_unverified: loc('تكلفة تاريخية غير معتمدة', 'Historical cost unverified'),
    return_cost_missing: loc('تكلفة المرتجع ناقصة', 'Return cost missing'),
    refund_amount_missing: loc('مبلغ الاسترداد ناقص', 'Refund amount missing'),
    verified_goods_cost_required: loc('نسبة الأجر تنتظر التكلفة', 'Profit-based pay awaits cost'),
    wage_reconciliation_pending: loc('تسوية الأجر معلقة', 'Wage reconciliation pending'),
  } as Record<string, string>)[issue.code] ?? loc('بيانات تحتاج مراجعة', 'Details need review')))];
  const incomplete = reasons.length > 0 || (order.unknown_lines ?? 0) + (order.pending_costs ?? 0) > 0;
  return <button type="button" className="fw-order-row" onClick={onClick}>
    <div className="fw-order-identity"><span className="fw-order-icon"><Layers3 size={18} strokeWidth={1.6} /></span><div><h3>{order.customer_name || `${loc('طلب', 'Order')} ${order.order_id || order.id}`}</h3>
      <p>{(order.order_id || order.id).slice(-12)} · {financeDay(order.delivered_at || order.created_at)}</p>
      <Status tone={incomplete ? 'warning' : order.status === 'delivered' ? 'positive' : 'neutral'}>{incomplete ? loc('يحتاج مراجعة', 'Needs review') : statusName(order.status, loc)}</Status>
      {incomplete && <p>{reasons.length ? reasons.slice(0, 2).join(' · ') : loc('افتح الطلب لمعرفة البنود المعلقة', 'Open the order to review pending lines')}{reasons.length > 2 ? ` · +${reasons.length - 2}` : ''}</p>}
    </div></div><div className="fw-order-values"><Money value={order.owner_net_iqd} /><small>{order.status === 'delivered' ? loc('صافي المالك', 'Owner net') : order.status === 'cancelled' ? loc('ملغى · غير مستحق', 'Cancelled · not earned') : loc('تقديري · غير مستحق', 'Projected · not earned')}</small><ChevronLeft size={15} className="fw-muted" aria-hidden /></div>
  </button>;
}

function Orders({ from, to, revision, openOrder }: { from: string; to: string; revision: number; openOrder: (id: string) => void }) {
  const { loc } = useLanguage();
  const pageSize = 100;
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<FinanceOrder[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => { setOffset(0); setRows([]); setTotal(0); }, [from, to, search, status]);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError('');
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ from, to, q: search, status, offset: String(offset) });
      api.get<{ orders: FinanceOrder[]; total: number }>(`${WORKSPACE_API}/orders?${query}`, { signal: controller.signal })
        .then((r) => { if (!controller.signal.aborted) { setRows(r.orders ?? []); setTotal(r.total ?? r.orders?.length ?? 0); } })
        .catch((e) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); })
        .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    }, search ? 220 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [from, to, search, status, offset, revision]);
  const filters = [ ['', loc('كل الطلبات', 'All orders')], ['delivered', loc('المستلمة', 'Delivered')], ['pending', loc('الجديدة', 'New')], ['cancelled', loc('الملغاة', 'Cancelled')] ];
  return <Surface title={loc('الطلبات والأرباح', 'Orders & profits')} subtitle={loc('افتح الطلب لمعرفة ربح كل منتج وتعديل تكاليفه.', 'Open an order to inspect each product’s profit or adjust its costs.')} action={<Button variant="ghost" onClick={() => { window.location.href = `${WORKSPACE_API}/export.csv?from=${from}&to=${to}`; }} aria-label={loc('تصدير التقرير', 'Export report')}><ArrowDownToLine size={17} /></Button>}>
    <div className="fw-toolbar"><div className="fw-search"><Search aria-hidden /><input className="fw-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={loc('ابحث برقم الطلب أو اسم الزبون', 'Search order number or customer')} aria-label={loc('البحث عن الطلب', 'Find an order')} /></div></div>
    <div className="fw-filter-pills">{filters.map(([value, label]) => <button key={value} type="button" className="fw-pill" aria-pressed={status === value} onClick={() => setStatus(value)}>{label}</button>)}</div>
    {error && <p className="fw-error" role="alert">{error}</p>}
    {busy && !rows.length ? <Loading text={loc('تحميل الطلبات…', 'Loading orders…')} /> : rows.length ? <div className="fw-list" aria-busy={busy}>{rows.map((o) => <OrderRow order={o} key={o.id} onClick={() => openOrder(o.order_id || o.id)} />)}</div> : <Empty title={loc('لا توجد طلبات مطابقة', 'No matching orders')} text={loc('جرّب اسمًا آخر أو اختر فترة مختلفة.', 'Try another name or date range.')} />}
    {total > pageSize && <div className="fw-pagination"><Button variant="ghost" disabled={busy || offset === 0} onClick={() => setOffset((v) => Math.max(0, v - pageSize))}>{loc('السابق', 'Previous')}</Button><span>{Math.floor(offset / pageSize) + 1} / {Math.ceil(total / pageSize)}</span><Button variant="ghost" disabled={busy || offset + rows.length >= total} onClick={() => setOffset((v) => v + pageSize)}>{loc('التالي', 'Next')}</Button></div>}
  </Surface>;
}

function Products({ data, onOpenOrders }: { data: FinanceSummary; onOpenOrders: () => void }) {
  const { loc } = useLanguage();
  const [q, setQ] = useState('');
  const [view, setView] = useState<'products' | 'categories'>('products');
  const rows = (view === 'products' ? data.products : data.categories)?.filter((p) => !q || p.name.toLocaleLowerCase().includes(q.toLocaleLowerCase())) ?? [];
  return <Surface title={loc('ربح المنتجات', 'Product profit')} subtitle={loc('أداء المنتجات في الفترة المحددة، بعد نصيبها من التكاليف.', 'Performance in the selected range after each product’s cost share.')}>
    <div className="fw-toolbar"><div className="fw-search"><Search aria-hidden /><input className="fw-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={loc('ابحث عن منتج أو قسم', 'Find a product or category')} /></div></div>
    <div className="fw-filter-pills"><button type="button" className="fw-pill" aria-pressed={view === 'products'} onClick={() => setView('products')}>{loc('المنتجات', 'Products')}</button><button type="button" className="fw-pill" aria-pressed={view === 'categories'} onClick={() => setView('categories')}>{loc('الأقسام', 'Categories')}</button></div>
    {rows.length ? <div className="fw-list">{rows.map((p) => <Surface key={`${p.level ?? 'product'}:${p.id}`} className="fw-line-item"><div className="fw-line-heading">
      {p.product_image || p.image_url ? <img className="fw-product-image" src={p.product_image || p.image_url} alt="" loading="lazy" /> : <span className="fw-order-icon"><Package size={20} /></span>}
      <div><h3>{p.name}</h3><p>{p.qty} {loc('قطعة مباعة', 'units sold')}{p.level === 'sub' ? ` · ${loc('قسم فرعي', 'Subsection')}` : p.level === 'main' ? ` · ${loc('قسم رئيسي', 'Main section')}` : ''}</p></div></div>
      <div className="fw-line-metrics"><div className="fw-line-metric"><span>{loc('صافي البيع', 'Net sales')}</span><Money value={p.net_goods_iqd} /></div><div className="fw-line-metric"><span>{loc('تكلفة البضاعة', 'Goods cost')}</span><Money value={p.cogs_iqd} /></div><div className="fw-line-metric"><span>{loc('الأجور والمواد', 'Wages and materials')}</span><Money value={p.wages_iqd == null || p.materials_iqd == null ? null : p.wages_iqd + p.materials_iqd} /></div><div className="fw-line-metric"><span>{loc('نصيب الترويج', 'Promotion share')}</span><Money value={p.promotion_iqd} /></div></div>
      <Row label={loc('حصة المستثمر', 'Investor share')} value={<Money value={p.investor_iqd} />} />
      <Row label={loc('صافي المالك', 'Owner net')} value={<Money value={p.owner_net_iqd} />} prominent />
    </Surface>)}</div> : <Empty title={loc('لا توجد منتجات في هذه الفترة', 'No products in this period')} text={loc('تظهر المنتجات المرتبطة بطلبات الفترة هنا.', 'Products sold in the selected range appear here.')} />}
    <p className="fw-note">{loc('تكلفة الترويج توزيع إداري على المنتجات، وتُحمّل على المالك فقط.', 'Promotion shares are a management allocation borne by the owner only.')}</p>
    <Button variant="ghost" onClick={onOpenOrders}><CheckCircle2 size={16} />{loc('راجع الطلبات الأصلية', 'Review source orders')}</Button>
  </Surface>;
}
