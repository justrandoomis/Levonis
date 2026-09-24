/**
 * `/merchant/analytics` — the store's lifetime figures and its traffic.
 *
 * This is the old dashboard's Overview tab, moved here unchanged in what it
 * shows (the lifetime totals of GET /api/merchant/analytics, the store's
 * 30-day traffic card from W2-E, custom-order earnings, offers) now that
 * `/merchant` is the Command Center. The full analytics screen with charts
 * belongs to a later stream; until then this is what the address opens.
 *
 * One change, on purpose (audit 01 B17): the figures are PLUS, and a lapsed
 * merchant used to get the server's raw error sentence where the numbers
 * were. Now they get one line that says why, and every other screen stays.
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { useLanguage } from '../../../../LanguageContext';
import { ApiError } from '../../../../lib/api';
import { merchantApi, iqd } from '../../../../lib/merchant';
import { ErrorState } from '../../../ui/AsyncStates';
import { KpiRowSkeleton } from '../../../ui/DashboardSkeletons';
import { Card, Stat } from '../../dashboard/ui';

const StoreTrafficCard = lazy(() => import('../../analytics/StoreTrafficCard'));

export default function AnalyticsSection() {
  const { loc } = useLanguage();
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [locked, setLocked] = useState(false);

  const load = () => {
    setError(null);
    merchantApi
      .analytics()
      .then(setData)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) setLocked(true);
        else setError(e);
      });
  };
  useEffect(load, []);

  if (locked) {
    return (
      <p className="text-[13px] leading-relaxed text-text-muted" data-analytics-locked>
        {/* OWNER: Sorani to be written by hand. */}
        {loc('الأرقام جزء من LEVO PLUS. طلباتك وأرباحك كلها محفوظة وتراها في صفحاتها — جدّد الاشتراك لتعود الأرقام.', 'The figures are part of LEVO PLUS. Your orders and earnings are all kept and visible on their screens — renew to see the figures again.')}
      </p>
    );
  }
  if (error) return <ErrorState error={error} onRetry={load} compact />;
  if (!data) return <KpiRowSkeleton count={4} />;

  const orders = data.orders as Record<string, number | null>;
  const products = data.products as Record<string, number>;
  const offers = data.offers as Record<string, number | null>;
  const custom = data.custom_orders as Record<string, number> | undefined;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Stat label={loc('إجمالي المبيعات', 'Gross sales', 'کۆی فرۆشتن')} value={iqd(orders.gross_iqd)} />
        <Stat label={loc('صافي أرباحك', 'Your earnings', 'قازانجی تۆ')} value={iqd(orders.receivable_iqd)} accent />
        <Stat label={loc('الطلبات', 'Orders', 'داواکاری')} value={String(orders.total ?? 0)} />
        <Stat
          label={loc('متوسط الطلب', 'Average order', 'ناوەندی داواکاری')}
          // null means "no orders yet", which is a different answer from 0.
          value={orders.average_order_iqd === null ? loc('لا بيانات', 'No data', 'داتا نییە') : iqd(orders.average_order_iqd)}
        />
      </div>
      {/* What the four figures count, said once (audit 04 #12): a cancelled
          store order is refunded in full, so it is not a sale, an earning or
          part of the average — and the count of them is shown, not hidden. */}
      <p className="text-zinc-500 text-[11px] leading-relaxed px-0.5" data-analytics-basis>
        {loc(
          'المبيعات والأرباح والمتوسط من الطلبات غير الملغاة فقط.',
          'Sales, earnings and the average count only orders that were not cancelled.'
        ) /* OWNER: Sorani to be written by hand. */}
        {Number(orders.cancelled ?? 0) > 0 && (
          <>
            {' '}
            <span className="tabular-nums">
              {loc(`(${orders.cancelled} ملغاة لم تُحتسب)`, `(${orders.cancelled} cancelled, not counted)`) /* OWNER: Sorani to be written by hand. */}
            </span>
          </>
        )}
      </p>
      {/* The store's traffic and funnel from real, deduped events (W2-E). */}
      <Suspense fallback={<KpiRowSkeleton count={2} />}>
        <StoreTrafficCard />
      </Suspense>

      {Number(custom?.completed ?? 0) > 0 && (
        <Stat
          label={loc('طلبات مخصصة مكتملة — صافيها', 'Completed custom orders — your share') /* OWNER: Sorani to be written by hand. */}
          value={`${custom!.completed} · ${iqd(custom!.receivable_iqd)}`}
          small
        />
      )}

      <div className="grid grid-cols-3 gap-2">
        <Stat label={loc('منتجات', 'Products', 'بەرهەم')} value={`${products.active ?? 0}/${products.total ?? 0}`} small />
        <Stat label={loc('متابعون', 'Followers', 'شوێنکەوتوو')} value={String(data.followers ?? 0)} small />
        <Stat label={loc('مشاهدات', 'Views', 'بینین')} value={String(products.views ?? 0)} small />
      </div>

      {Number(offers.sent ?? 0) > 0 && (
        <Card title={loc('عروضك على الطلبات', 'Your offers on requests', 'ئۆفەرەکانت')}>
          <div className="flex items-center justify-between text-[12.5px]">
            <span className="text-zinc-400">
              {loc('مقبولة', 'Accepted', 'پەسەندکراو')}: <span className="text-white font-bold">{offers.accepted ?? 0}</span>
              <span className="text-zinc-600"> / {offers.sent}</span>
            </span>
            {offers.win_rate !== null && <span className="text-gold font-bold">{offers.win_rate}%</span>}
          </div>
        </Card>
      )}
    </div>
  );
}
