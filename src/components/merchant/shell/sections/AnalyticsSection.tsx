/**
 * `/merchant/analytics` — the store's analytics over a range (W3-B).
 *
 * ONE FILTER ROW ABOVE EVERYTHING: 7 / 30 / 90 days or a custom range, in
 * Baghdad days; every tile, chart and table below answers for the same slice
 * (GET /api/merchant/analytics/report). While a new range loads, the page
 * keeps its previous render dimmed — no skeleton flash, no layout jump.
 *
 * EVERY FIGURE FROM THE SERVER, AND A MISSING ONE IS ABSENT, NEVER 0:
 *   - the visit figures, the funnel, the traffic sources and the
 *     most/least-viewed lists exist only once the storefront beacon has
 *     counted; before that the page says counting has begun and shows what
 *     has always been recorded (orders);
 *   - a change against the previous period is shown only when the server
 *     returned the previous period for that figure (the store existed; the
 *     traffic was counted on every day of both) and it was above zero;
 *   - an average over no orders, a win rate over no offers, a conversion over
 *     no visitors are not drawn.
 *
 * THE CHARTS (../../analytics/charts.tsx) are in-house SVG: views and orders
 * are two small multiples, never one dual-axis chart; each has a table view.
 * A lapsed PLUS keeps every other screen and gets one sentence here
 * (`data-analytics-locked`), never the server's raw error.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CalendarRange } from 'lucide-react';
import { useLanguage } from '../../../../LanguageContext';
import { ApiError } from '../../../../lib/api';
import { formatFigure, formatPercent } from '../../../../lib/localeNumber';
import { formatMoney } from '../../../../lib/money';
import { governorateName } from '../../../../../packages/shipping/src/iraqGovernorates';
import { ErrorState } from '../../../ui/AsyncStates';
import { KpiRowSkeleton, CardSkeleton } from '../../../ui/DashboardSkeletons';
import { KpiTile, type KpiDelta } from '../../../ui/KpiTile';
import { Money } from '../../../ui/Money';
import { Segmented } from '../../../ui/Segmented';
import { Field, Input } from '../../../ui/Field';
import { Button } from '../../../ui/Button';
import { BarList, ChartCard, DailyChart, DataTable, StackedBar } from '../../analytics/charts';
import {
  SERIES,
  baghdadToday,
  customRangeProblem,
  funnelSteps,
  periodDelta,
  rangeFor,
  type RangePreset,
} from '../../analytics/chartMath';
import { fetchReport, type AnalyticsReport } from '../../analytics/report';
import { dateLocale } from '../../../orders/format';
import { useWorkspace } from '../context';
import { merchantHref } from '../../../../lib/merchantRoutes';

type Lang = 'ar' | 'en' | 'ckb';

export default function AnalyticsSection() {
  const { loc, lang } = useLanguage();
  const ws = useWorkspace();
  const [preset, setPreset] = useState<RangePreset>('30');
  const [range, setRange] = useState(() => rangeFor('30'));
  const [draft, setDraft] = useState(() => rangeFor('30'));
  const [draftError, setDraftError] = useState('');
  const [data, setData] = useState<AnalyticsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [locked, setLocked] = useState(false);
  const seq = useRef(0);

  const load = useCallback(() => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    fetchReport(range.from, range.to)
      .then((d) => {
        if (mine !== seq.current) return;
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        if (mine !== seq.current) return;
        setLoading(false);
        if (e instanceof ApiError && (e.status === 403 || e.code === 'ANALYTICS_NOT_INCLUDED')) setLocked(true);
        else setError(e);
      });
  }, [range.from, range.to]);
  useEffect(load, [load]);

  const choosePreset = (p: string) => {
    const next = p as RangePreset;
    setPreset(next);
    setDraftError('');
    if (next !== 'custom') setRange(rangeFor(next));
    else setDraft(range);
  };

  const applyCustom = () => {
    const problem = customRangeProblem(draft.from, draft.to);
    if (problem) {
      // OWNER: Sorani to be written by hand.
      setDraftError(
        problem === 'order'
          ? loc('يجب أن يكون تاريخ البداية قبل تاريخ النهاية أو مساويًا له.', 'The start must be on or before the end.')
          : problem === 'future'
            ? loc('لا يمكن أن تنتهي الفترة بعد اليوم.', 'The range cannot end after today.')
            : problem === 'too_long'
              ? loc('أطول فترة ممكنة 366 يومًا.', 'The longest range is 366 days.')
              : loc('اختر تاريخي البداية والنهاية.', 'Choose a start and an end date.')
      );
      return;
    }
    setDraftError('');
    setRange({ ...draft });
  };

  if (locked) {
    return (
      <p className="text-[13px] leading-relaxed text-text-muted" data-analytics-locked>
        {/* OWNER: Sorani to be written by hand. */}
        {loc('الأرقام جزء من LEVO PLUS. طلباتك وأرباحك كلها محفوظة وتراها في صفحاتها — جدّد الاشتراك لتعود الأرقام.', 'The figures are part of LEVO PLUS. Your orders and earnings are all kept and visible on their screens — renew to see the figures again.')}
      </p>
    );
  }

  const L = lang as Lang;
  const presetItems = [
    { id: '7', label: loc('7 أيام', '7 days') },
    { id: '30', label: loc('30 يومًا', '30 days') },
    { id: '90', label: loc('90 يومًا', '90 days') },
    { id: 'custom', label: loc('مخصّص', 'Custom') },
  ]; // OWNER: Sorani to be written by hand.

  return (
    <div className="space-y-4" data-analytics>
      {/* THE FILTER ROW — one, above everything it scopes. */}
      <div className="space-y-3" data-analytics-filters>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Segmented
            size="sm"
            group="analytics-range"
            label={loc('الفترة', 'Range') /* OWNER: Sorani to be written by hand. */}
            value={preset}
            onChange={choosePreset}
            items={presetItems}
            dataAttr="data-range"
            className="w-full max-w-[360px] sm:w-[340px]"
          />
          {data && (
            <p className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-text-muted" data-range-text>
              <CalendarRange aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0">
                <RangeText from={data.range.from} to={data.range.to} lang={L} />
                {data.previous?.orders || data.previous?.traffic ? (
                  <>
                    {' · '}
                    {loc('مقارنة بـ', 'compared with') /* OWNER: Sorani to be written by hand. */}{' '}
                    <RangeText from={data.previous.range.from} to={data.previous.range.to} lang={L} />
                  </>
                ) : null}
              </span>
            </p>
          )}
        </div>
        {preset === 'custom' && (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              applyCustom();
            }}
            data-custom-range
          >
            <Field label={loc('من', 'From') /* OWNER: Sorani to be written by hand. */} className="w-[160px]">
              <Input ltr type="date" value={draft.from} max={baghdadToday()} onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))} />
            </Field>
            <Field label={loc('إلى', 'To') /* OWNER: Sorani to be written by hand. */} className="w-[160px]">
              <Input ltr type="date" value={draft.to} max={baghdadToday()} onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))} />
            </Field>
            <Button type="submit" variant="primary">
              {loc('عرض', 'Show') /* OWNER: Sorani to be written by hand. */}
            </Button>
            {draftError && (
              <p role="alert" className="lv-field-error w-full">
                {draftError}
              </p>
            )}
          </form>
        )}
      </div>

      {error && !data ? (
        <ErrorState error={error} onRetry={load} compact />
      ) : !data ? (
        <div className="space-y-3" aria-busy="true">
          <KpiRowSkeleton count={4} />
          <CardSkeleton lines={5} />
        </div>
      ) : (
        <div
          className={`space-y-4 transition-opacity duration-200 ${loading ? 'opacity-50' : ''}`}
          aria-busy={loading || undefined}
          data-analytics-body
        >
          {error ? <ErrorState error={error} onRetry={load} compact /> : null}
          <Report data={data} lang={L} customerHref={ws.href(merchantHref.customers())} />
        </div>
      )}
    </div>
  );
}

function RangeText({ from, to, lang }: { from: string; to: string; lang: Lang }) {
  const f = (d: string) => new Intl.DateTimeFormat(dateLocale(lang), { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00.000Z`));
  return (
    <bdi>
      {f(from)} – {f(to)}
    </bdi>
  );
}

// ------------------------------------------------------------------ the report

function Report({ data, lang, customerHref }: { data: AnalyticsReport; lang: Lang; customerHref: string }) {
  const { loc } = useLanguage();
  const n = (v: number) => formatFigure(v, lang);
  const money = (v: number) => formatMoney(v, lang);
  const dayFmt = useMemo(() => {
    const short = new Intl.DateTimeFormat(dateLocale(lang), { day: 'numeric', month: 'numeric', timeZone: 'UTC' });
    const long = new Intl.DateTimeFormat(dateLocale(lang), { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    return (day: string, isShort: boolean) => (isShort ? short : long).format(new Date(`${day}T00:00:00.000Z`));
  }, [lang]);
  // OWNER: Sorani to be written by hand (every new line of this screen).
  const vsLabel = loc('عن الفترة السابقة', 'vs the previous period');
  const delta = (cur: number | null | undefined, prev: number | null | undefined, good: KpiDelta['good'] = 'up'): KpiDelta | null => {
    const d = periodDelta(cur, prev);
    return d ? { value: d.percent, format: 'percent', label: vsLabel, good } : null;
  };

  const t = data.traffic;
  const prevT = data.previous?.traffic;
  const prevO = data.previous?.orders;
  const totals = data.orders.totals;
  const conv = data.funnel?.conversion_percent;

  return (
    <>
      {/* ---- the KPI row */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" data-analytics-kpis>
        {t && (
          <>
            <KpiTile label={loc('الزوّار', 'Visitors')} value={n(t.totals.visitors)} delta={delta(t.totals.visitors, prevT?.visitors)} />
            <KpiTile label={loc('مشاهدات المنتجات', 'Product views')} value={n(t.totals.product_views)} delta={delta(t.totals.product_views, prevT?.product_views)} />
            <KpiTile label={loc('أُضيف إلى السلة', 'Added to cart')} value={n(t.totals.add_to_cart)} delta={delta(t.totals.add_to_cart, prevT?.add_to_cart)} />
            <KpiTile label={loc('بدأوا الدفع', 'Checkouts started')} value={n(t.totals.checkout_started)} delta={delta(t.totals.checkout_started, prevT?.checkout_started)} />
          </>
        )}
        {/* Review F6: not the Money page's «مبيعات مسجّلة» — defined in the basis line below. */}
        <KpiTile className="col-span-2 sm:col-span-1" label={loc('إجمالي المدفوع', 'Total paid')} value={<Money iqd={totals.gross_iqd} />} delta={delta(totals.gross_iqd, prevO?.gross_iqd)} hint={
          totals.average_order_iqd !== undefined ? <>{loc('متوسط الطلب', 'Average order', 'ناوەندی داواکاری')} <Money iqd={totals.average_order_iqd} /></> : undefined
        } />
        <KpiTile label={loc('الطلبات', 'Orders', 'داواکاری')} value={n(totals.orders)} delta={delta(totals.orders, prevO?.orders)} />
        {conv !== undefined && (
          <KpiTile
            label={loc('نسبة التحويل', 'Conversion')}
            value={<bdi>{formatPercent(conv, lang)}</bdi>}
            delta={delta(conv, prevT?.conversion_percent)}
            hint={loc('طلبات لكل 100 زائر', 'Orders per 100 visitors')}
          />
        )}
      </div>
      <p className="px-0.5 text-[11.5px] leading-relaxed text-text-muted" data-analytics-basis>
        {/* OWNER: Sorani to be written by hand. */}
        {loc(
          '«إجمالي المدفوع» ما دفعه الزبائن: مجموع الطلبات مع التوصيل وبعد الخصم، دون الملغاة — لذلك يختلف عن «مبيعات مسجّلة» في الأرباح.',
          '“Total paid” is what customers paid: order totals including delivery, after coupons, excluding cancelled orders — so it differs from “Recorded sales” under Earnings.'
        )}
        {totals.cancelled > 0 && <> {loc(`(${n(totals.cancelled)} ملغاة لم تُحتسب)`, `(${n(totals.cancelled)} cancelled, not counted)`)}</>}{' '}
        {t
          ? loc('كل زائر يُحسب مرة في اليوم؛ لا تُحسب زياراتك لمتجرك ولا الزواحف الآلية.', 'Each visitor counts once a day; your own visits and crawlers are not counted.')
          : null}
        {t && t.counted_from > data.range.from ? <> {loc(`عدّ الزيارات بدأ في ${t.counted_from}.`, `Visits have been counted since ${t.counted_from}.`)}</> : null}
      </p>
      {!t && (
        <div className="lv-surface p-4 text-[13px] leading-relaxed text-text-muted" data-traffic-absent>
          {loc(
            'عدّ زيارات متجرك يبدأ مع أول زيارة مسجّلة — تظهر الزيارات ومسار الشراء ومصادر الزوّار عندها. الطلبات أدناه مسجّلة دائمًا.',
            'Counting your store\'s visits begins with the first recorded visit — visits, the funnel and traffic sources appear then. The orders below have always been recorded.'
          )}
        </div>
      )}

      {/* ---- daily: two small multiples, one axis each */}
      <div className={`grid gap-3 ${t ? 'lg:grid-cols-2' : ''}`}>
        {t && (
          <ChartCard
            id="daily-visitors"
            title={loc('الزوّار يوميًا', 'Visitors per day')}
            description={t.counted_from > data.range.from ? loc(`منذ ${t.counted_from}`, `Since ${t.counted_from}`) : undefined}
            table={
              <DataTable
                caption={loc('الزوّار يوميًا', 'Visitors per day')}
                columns={[{ label: loc('اليوم', 'Day') }, { label: loc('الزوّار', 'Visitors'), numeric: true }, { label: loc('مشاهدات المنتجات', 'Product views'), numeric: true }]}
                rows={t.series.map((r) => [dayFmt(r.day, false), n(r.visitors), n(r.product_views)])}
              />
            }
          >
            <DailyChart
              kind="line"
              series={t.series.map((r) => ({ day: r.day, value: r.visitors }))}
              label={loc('زوّار', 'visitors')}
              format={n}
              dayLabel={dayFmt}
              color={SERIES[0]}
              summary={loc(
                `الزوّار يوميًا من ${t.series[0]?.day ?? ''} إلى ${data.range.to}، المجموع ${n(t.totals.visitors)}`,
                `Visitors per day from ${t.series[0]?.day ?? ''} to ${data.range.to}, ${n(t.totals.visitors)} in total`
              )}
            />
          </ChartCard>
        )}
        <ChartCard
          id="daily-orders"
          title={loc('الطلبات يوميًا', 'Orders per day')}
          table={
            <DataTable
              caption={loc('الطلبات يوميًا', 'Orders per day')}
              columns={[{ label: loc('اليوم', 'Day') }, { label: loc('الطلبات', 'Orders', 'داواکاری'), numeric: true }, { label: loc('المبيعات', 'Revenue'), numeric: true }]}
              rows={data.orders.series.map((r) => [dayFmt(r.day, false), n(r.orders), money(r.gross_iqd)])}
            />
          }
        >
          <DailyChart
            kind="columns"
            series={data.orders.series.map((r) => ({ day: r.day, value: r.orders }))}
            label={loc('طلبات', 'orders')}
            format={n}
            dayLabel={dayFmt}
            color={SERIES[0]}
            summary={loc(
              `الطلبات يوميًا من ${data.range.from} إلى ${data.range.to}، المجموع ${n(totals.orders)}`,
              `Orders per day from ${data.range.from} to ${data.range.to}, ${n(totals.orders)} in total`
            )}
          />
        </ChartCard>
      </div>

      {/* ---- the funnel and where visitors came from */}
      {t && data.funnel && (
        <div className="grid gap-3 lg:grid-cols-2 lg:items-start">
          <FunnelCard funnel={data.funnel} lang={lang} />
          <SourcesCard sources={t.sources} lang={lang} />
        </div>
      )}

      {/* ---- products */}
      <div className="grid gap-3 lg:grid-cols-2 lg:items-start">
        <ChartCard
          id="top-products"
          title={loc('الأكثر مبيعًا', 'Best sellers')}
          description={loc('بالمبيعات قبل الخصم في الفترة', 'By revenue before coupons in the range')}
          table={
            <DataTable
              caption={loc('الأكثر مبيعًا', 'Best sellers')}
              columns={[{ label: loc('المنتج', 'Product') }, { label: loc('القطع', 'Units'), numeric: true }, { label: loc('الطلبات', 'Orders', 'داواکاری'), numeric: true }, { label: loc('المبيعات قبل الخصم', 'Revenue before coupons'), numeric: true }]}
              rows={data.products.top.map((p) => [p.name || '—', n(p.units), n(p.orders), money(p.revenue_iqd)])}
            />
          }
        >
          {data.products.top.length ? (
            <BarList
              ariaLabel={loc('الأكثر مبيعًا', 'Best sellers')}
              rows={data.products.top.map((p) => ({
                key: p.id,
                label: p.name || '—',
                value: p.revenue_iqd,
                valueText: money(p.revenue_iqd),
                hint: loc(`${n(p.units)} قطعة · ${n(p.orders)} طلب`, `${n(p.units)} units · ${n(p.orders)} orders`),
              }))}
            />
          ) : (
            <Quiet>{loc('لا مبيعات في هذه الفترة.', 'No sales in this range.')}</Quiet>
          )}
        </ChartCard>
        {data.products.most_viewed || data.products.least_viewed ? (
          <ViewsCard most={data.products.most_viewed ?? []} least={data.products.least_viewed ?? []} lang={lang} />
        ) : null}
      </div>

      {/* ---- customers and where orders went */}
      <div className="grid gap-3 lg:grid-cols-2 lg:items-start">
        <CustomersCard customers={data.customers} lang={lang} href={customerHref} />
        <GovernoratesCard rows={data.governorates} unspecified={data.governorates_unspecified} lang={lang} />
      </div>

      <CouponsCard coupons={data.coupons} lang={lang} />
      <RequestsCard requests={data.requests} lang={lang} />
    </>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-[13px] text-text-muted">{children}</p>;
}

function FunnelCard({ funnel, lang }: { funnel: NonNullable<AnalyticsReport['funnel']>; lang: Lang }) {
  const { loc } = useLanguage();
  const n = (v: number) => formatFigure(v, lang);
  const labels: Record<string, string> = {
    visitors: loc('زاروا المتجر', 'Visited'),
    add_to_cart: loc('أضافوا إلى السلة', 'Added to cart'),
    checkout_started: loc('بدأوا الدفع', 'Started checkout'),
    orders: loc('طلبوا', 'Ordered'),
  };
  // Product VIEWS are views, not people — one visitor views many products —
  // so they are not a funnel stage (a stage bigger than the one before it
  // reads as nonsense); they are their own KPI tile above.
  const steps = funnelSteps([
    { key: 'visitors', value: funnel.visitors },
    { key: 'add_to_cart', value: funnel.add_to_cart },
    { key: 'checkout_started', value: funnel.checkout_started },
    { key: 'orders', value: funnel.orders },
  ]);
  const step = (v: number | null) => (v === null ? '—' : formatPercent(v, lang));
  return (
    <ChartCard
      id="funnel"
      title={loc('مسار الشراء', 'Purchase funnel')}
      description={loc('كل مرحلة ونسبتها من التي قبلها', 'Each stage and its share of the one before')}
      table={
        <DataTable
          caption={loc('مسار الشراء', 'Purchase funnel')}
          columns={[{ label: loc('المرحلة', 'Stage') }, { label: loc('العدد', 'Count'), numeric: true }, { label: loc('من السابقة', 'Of previous'), numeric: true }, { label: loc('من الزوار', 'Of visitors'), numeric: true }]}
          rows={steps.map((s) => [labels[s.key], n(s.value), step(s.ofPrevious), step(s.ofFirst)])}
        />
      }
    >
      <BarList
        ariaLabel={loc('مسار الشراء', 'Purchase funnel')}
        color={SERIES[0]}
        rows={steps.map((s) => ({
          key: s.key,
          label: labels[s.key],
          value: s.value,
          valueText: n(s.value),
          hint: s.ofPrevious !== null ? loc(`${step(s.ofPrevious)} من المرحلة السابقة`, `${step(s.ofPrevious)} of the stage before`) : undefined,
        }))}
      />
    </ChartCard>
  );
}

function SourcesCard({ sources, lang }: { sources: NonNullable<AnalyticsReport['traffic']>['sources']; lang: Lang }) {
  const { loc } = useLanguage();
  const n = (v: number) => formatFigure(v, lang);
  // Fixed slots: a source keeps its colour whatever its rank.
  const parts = [
    { key: 'direct', label: loc('مباشر', 'Direct'), value: sources.direct, color: SERIES[0] },
    { key: 'search', label: loc('بحث', 'Search'), value: sources.search, color: SERIES[1] },
    { key: 'social', label: loc('تواصل اجتماعي', 'Social'), value: sources.social, color: SERIES[2] },
    { key: 'other', label: loc('أخرى', 'Other'), value: sources.other, color: SERIES[3] },
  ].map((p) => ({ ...p, valueText: n(p.value) }));
  const total = parts.reduce((s, p) => s + p.value, 0);
  return (
    <ChartCard
      id="sources"
      title={loc('من أين جاء الزوّار', 'Where visitors came from')}
      description={loc('من اسم الموقع الذي أحالهم فقط', 'From the referring site\'s name only')}
      table={
        <DataTable
          caption={loc('مصادر الزوّار', 'Traffic sources')}
          columns={[{ label: loc('المصدر', 'Source') }, { label: loc('الزوّار', 'Visitors'), numeric: true }]}
          rows={parts.map((p) => [p.label, p.valueText])}
        />
      }
    >
      {total > 0 ? (
        <StackedBar parts={parts} ariaLabel={parts.map((p) => `${p.label} ${p.valueText}`).join('، ')} />
      ) : (
        <Quiet>{loc('لا زوّار في هذه الفترة.', 'No visitors in this range.')}</Quiet>
      )}
    </ChartCard>
  );
}

function ViewsCard({ most, least, lang }: { most: NonNullable<AnalyticsReport['products']['most_viewed']>; least: NonNullable<AnalyticsReport['products']['least_viewed']>; lang: Lang }) {
  const { loc } = useLanguage();
  const n = (v: number) => formatFigure(v, lang);
  const [which, setWhich] = useState<'most' | 'least'>('most');
  const rows = which === 'most' ? most : least;
  return (
    <ChartCard
      id="views"
      title={loc('مشاهدات المنتجات', 'Product views')}
      table={
        <DataTable
          caption={loc('مشاهدات المنتجات', 'Product views')}
          columns={[{ label: loc('المنتج', 'Product') }, { label: loc('مشاهدات', 'Views', 'بینین'), numeric: true }, { label: loc('إلى السلة', 'To cart'), numeric: true }]}
          rows={rows.map((p) => [p.name || '—', n(p.views), n(p.add_to_cart)])}
        />
      }
    >
      <Segmented
        size="sm"
        group="views-which"
        label={loc('أي المنتجات', 'Which products')}
        value={which}
        onChange={(v) => setWhich(v as 'most' | 'least')}
        items={[
          { id: 'most', label: loc('الأكثر مشاهدة', 'Most viewed') },
          { id: 'least', label: loc('الأقل مشاهدة', 'Least viewed') },
        ]}
        className="mb-3 w-full max-w-[280px]"
      />
      {rows.length ? (
        <BarList
          ariaLabel={which === 'most' ? loc('الأكثر مشاهدة', 'Most viewed') : loc('الأقل مشاهدة', 'Least viewed')}
          rows={rows.map((p) => ({
            key: p.id,
            label: p.name || '—',
            value: p.views,
            valueText: n(p.views),
            hint: p.add_to_cart ? loc(`${n(p.add_to_cart)} إضافة إلى السلة`, `${n(p.add_to_cart)} added to cart`) : undefined,
          }))}
        />
      ) : (
        <Quiet>{loc('لم يُشاهَد أي منتج في هذه الفترة.', 'No product was viewed in this range.')}</Quiet>
      )}
    </ChartCard>
  );
}

function CustomersCard({ customers, lang, href }: { customers: AnalyticsReport['customers']; lang: Lang; href: string }) {
  const { loc } = useLanguage();
  const n = (v: number) => formatFigure(v, lang);
  const parts = [
    { key: 'returning', label: loc('عادوا للشراء', 'Returning'), value: customers.returning, color: SERIES[0] },
    { key: 'new', label: loc('جدد', 'New'), value: customers.new, color: SERIES[1] },
  ].map((p) => ({ ...p, valueText: n(p.value) }));
  return (
    <ChartCard
      id="customers"
      title={loc('المشترون', 'Buyers')}
      description={
        <>
          {loc(`${n(customers.customers)} مشترٍ في الفترة — «عاد» من اشترى قبلها أو أكثر من مرة فيها.`, `${n(customers.customers)} buyers in the range — «returning» bought before it, or more than once in it.`)}{' '}
          <Link to={href} className="text-text-secondary underline decoration-border-subtle underline-offset-2 hover:text-text-primary">
            {loc('كل الزبائن', 'All customers')}
          </Link>
        </>
      }
      table={
        <DataTable
          caption={loc('المشترون', 'Buyers')}
          columns={[{ label: loc('النوع', 'Kind') }, { label: loc('العدد', 'Count'), numeric: true }]}
          rows={parts.map((p) => [p.label, p.valueText])}
        />
      }
    >
      {customers.customers > 0 ? (
        <StackedBar parts={parts} ariaLabel={parts.map((p) => `${p.label} ${p.valueText}`).join('، ')} />
      ) : (
        <Quiet>{loc('لا مشترين في هذه الفترة.', 'No buyers in this range.')}</Quiet>
      )}
    </ChartCard>
  );
}

function GovernoratesCard({ rows, unspecified, lang }: { rows: AnalyticsReport['governorates']; unspecified?: number; lang: Lang }) {
  const { loc } = useLanguage();
  const n = (v: number) => formatFigure(v, lang);
  const money = (v: number) => formatMoney(v, lang);
  return (
    <ChartCard
      id="governorates"
      title={loc('المحافظات', 'Governorates')}
      description={loc('أين ذهبت الطلبات', 'Where the orders went')}
      table={
        <DataTable
          caption={loc('المحافظات', 'Governorates')}
          columns={[{ label: loc('المحافظة', 'Governorate') }, { label: loc('الطلبات', 'Orders', 'داواکاری'), numeric: true }, { label: loc('المبيعات', 'Revenue'), numeric: true }]}
          rows={rows.map((g) => [governorateName(g.governorate, lang), n(g.orders), money(g.gross_iqd)])}
        />
      }
    >
      {rows.length ? (
        <BarList
          ariaLabel={loc('المحافظات', 'Governorates')}
          rows={rows.map((g) => ({ key: g.governorate, label: governorateName(g.governorate, lang), value: g.orders, valueText: n(g.orders), hint: money(g.gross_iqd) }))}
        />
      ) : (
        <Quiet>{loc('لا طلبات في هذه الفترة.', 'No orders in this range.')}</Quiet>
      )}
      {unspecified ? (
        <p className="mt-3 text-[12px] text-text-muted">
          {loc(`${n(unspecified)} طلب بعنوان بلا محافظة (عناوين قديمة).`, `${n(unspecified)} orders had an address without a governorate (older addresses).`)}
        </p>
      ) : null}
    </ChartCard>
  );
}

function CouponsCard({ coupons, lang }: { coupons: AnalyticsReport['coupons']; lang: Lang }) {
  const { loc } = useLanguage();
  const n = (v: number) => formatFigure(v, lang);
  const money = (v: number) => formatMoney(v, lang);
  const date = (iso: string | null | undefined) =>
    iso ? new Intl.DateTimeFormat(dateLocale(lang), { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso)) : '—';
  return (
    <section className="lv-surface min-w-0 p-4" aria-labelledby="coupons-title" data-chart-card="coupons">
      <h3 id="coupons-title" className="text-[15px] font-bold text-text-primary">
        {loc('أداء الكوبونات', 'Coupon performance')}
      </h3>
      <p className="mb-3 mt-0.5 text-[12.5px] text-text-muted">{loc('الطلبات التي استُخدم فيها كل كوبون في الفترة', 'Orders that used each coupon in the range')}</p>
      {coupons.length ? (
        <DataTable
          caption={loc('أداء الكوبونات', 'Coupon performance')}
          columns={[
            { label: loc('الكوبون', 'Coupon') },
            { label: loc('الطلبات', 'Orders', 'داواکاری'), numeric: true },
            { label: loc('الخصم', 'Discount'), numeric: true },
            { label: loc('المبيعات', 'Revenue'), numeric: true },
            { label: loc('الاستخدام', 'Uses'), numeric: true },
            { label: loc('ينتهي', 'Ends') },
          ]}
          rows={coupons.map((k) => [
            <bdi key="c" dir="ltr" className="font-semibold text-text-primary">{k.code}</bdi>,
            n(k.orders),
            money(k.discount_iqd),
            money(k.gross_iqd),
            k.used_count === undefined ? '—' : k.max_uses ? `${n(k.used_count)} / ${n(k.max_uses)}` : n(k.used_count),
            k.coupon_id ? date(k.ends_at) : loc('حُذف', 'Deleted'),
          ])}
        />
      ) : (
        <Quiet>{loc('لم يُستخدم أي كوبون في هذه الفترة.', 'No coupon was used in this range.')}</Quiet>
      )}
    </section>
  );
}

function RequestsCard({ requests, lang }: { requests: AnalyticsReport['requests']; lang: Lang }) {
  const { loc } = useLanguage();
  const n = (v: number) => formatFigure(v, lang);
  return (
    <section aria-labelledby="requests-title" data-chart-card="requests" className="space-y-2">
      <h3 id="requests-title" className="px-0.5 text-[15px] font-bold text-text-primary">
        {loc('طلبات الطباعة والعروض', 'Print requests and offers')}
      </h3>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <KpiTile label={loc('طلبات تناسبك', 'Matching requests')} value={n(requests.matched)} hint={loc(`أُبلغت بـ ${n(requests.notified)}`, `${n(requests.notified)} notified`)} />
        <KpiTile label={loc('عروض أرسلتها', 'Offers sent')} value={n(requests.offers_sent)} />
        <KpiTile
          label={loc('عروض قُبلت', 'Offers accepted')}
          value={n(requests.offers_accepted)}
          hint={requests.win_rate_percent !== undefined ? loc(`نسبة القبول ${formatPercent(requests.win_rate_percent, lang, 0)}`, `${formatPercent(requests.win_rate_percent, lang, 0)} win rate`) : undefined}
        />
        <KpiTile label={loc('طلبات مخصّصة أُنجزت', 'Custom jobs done')} value={n(requests.custom_orders_completed)} />
        <KpiTile label={loc('صافيها لك', 'Your share of them')} value={<Money iqd={requests.custom_orders_receivable_iqd} />} />
      </div>
    </section>
  );
}
