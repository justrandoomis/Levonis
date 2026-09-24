/**
 * «آخر ٣٠ يومًا» — the store's traffic and its funnel, from real events only.
 *
 * Reads GET /api/merchant/analytics/report (worker/routes/merchantAnalytics.ts).
 * A figure the server did not return is not drawn — no zero stands in for
 * «not counted yet»: before the first counted visit the card says counting
 * has started and shows only the orders, which have always been recorded.
 * Self-contained, so the wave-3 analytics screen can mount it unchanged.
 */
import { useEffect, useState } from 'react';
import { useLanguage } from '../../../LanguageContext';
import { api } from '../../../lib/api';
import { formatFigure, formatPercent } from '../../../lib/localeNumber';
import { KpiTile } from '../../ui/KpiTile';
import { KpiRowSkeleton } from '../../ui/DashboardSkeletons';
import { ErrorState } from '../../ui/AsyncStates';

interface Report {
  range: { from: string; to: string; days: number };
  traffic?: {
    since: string;
    counted_from: string;
    totals: { visitors: number; store_views: number; product_views: number; add_to_cart: number; checkout_started: number };
    sources: { direct: number; search: number; social: number; other: number };
  };
  funnel?: { orders: number; conversion_percent?: number };
  orders: { totals: { orders: number } };
}

export default function StoreTrafficCard() {
  const { loc, lang } = useLanguage();
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = () => {
    setError(null);
    api.get<{ success: true } & Report>('/api/merchant/analytics/report').then(setData).catch(setError);
  };
  useEffect(load, []);

  const n = (v: number) => formatFigure(v, lang);
  // OWNER: Sorani to be written by hand (this card's lines).
  return (
    <section aria-labelledby="store-traffic-title" data-store-traffic className="space-y-2">
      <div className="flex items-baseline justify-between gap-2 px-0.5">
        <h2 id="store-traffic-title" className="text-[14px] font-bold text-text-primary">
          {loc('زيارات متجرك — آخر ٣٠ يومًا', 'Your store\'s visits — last 30 days')}
        </h2>
      </div>
      {error && !data ? (
        <ErrorState error={error} onRetry={load} compact />
      ) : !data ? (
        <KpiRowSkeleton count={4} />
      ) : data.traffic ? (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <KpiTile label={loc('زوّار', 'Visitors')} value={n(data.traffic.totals.visitors)} />
            <KpiTile label={loc('مشاهدات المنتجات', 'Product views')} value={n(data.traffic.totals.product_views)} />
            <KpiTile label={loc('أضافوا إلى السلة', 'Added to cart')} value={n(data.traffic.totals.add_to_cart)} />
            <KpiTile
              label={loc('طلبات', 'Orders')}
              value={n(data.funnel?.orders ?? 0)}
              hint={
                data.funnel?.conversion_percent !== undefined
                  ? loc(`تحويل ${formatPercent(data.funnel.conversion_percent, lang)}`, `${formatPercent(data.funnel.conversion_percent, lang)} conversion`)
                  : undefined
              }
            />
          </div>
          <p className="px-0.5 text-[11.5px] leading-relaxed text-text-muted">
            {loc(
              `كل زائر يُحسب مرة في اليوم؛ لا تُحسب زياراتك لمتجرك ولا محركات البحث الآلية. من أين جاؤوا: مباشر ${n(data.traffic.sources.direct)} · بحث ${n(data.traffic.sources.search)} · تواصل اجتماعي ${n(data.traffic.sources.social)} · أخرى ${n(data.traffic.sources.other)}.`,
              `Each visitor counts once a day; your own visits and crawlers are not counted. Where they came from: direct ${n(data.traffic.sources.direct)} · search ${n(data.traffic.sources.search)} · social ${n(data.traffic.sources.social)} · other ${n(data.traffic.sources.other)}.`
            )}
            {data.traffic.counted_from > data.range.from && (
              <> {loc(`العدّ بدأ في ${data.traffic.counted_from}.`, `Counting began on ${data.traffic.counted_from}.`)}</>
            )}
          </p>
        </>
      ) : (
        <div className="lv-surface p-4 text-[12.5px] leading-relaxed text-text-muted">
          {loc(
            `بدأ عدّ زيارات متجرك الآن — تظهر الأرقام مع أول زيارة. الطلبات في هذه الفترة: ${n(data.orders.totals.orders)}.`,
            `Counting your store's visits has started — figures appear with the first visit. Orders in this period: ${n(data.orders.totals.orders)}.`
          )}
        </div>
      )}
    </section>
  );
}
