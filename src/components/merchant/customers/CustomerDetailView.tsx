/**
 * One customer of this store (W3-B): what they bought HERE — orders, spend,
 * average, first and last order, the governorate their latest order went to,
 * and the phone as this store already sees it on their orders. Each order
 * opens its own screen. Nothing of another store and nothing of the account.
 * OWNER: Sorani to be written by hand (every new line of this screen).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight, MapPin, Phone } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { ApiError } from '../../../lib/api';
import { formatFigure } from '../../../lib/localeNumber';
import { governorateName } from '../../../../packages/shipping/src/iraqGovernorates';
import { merchantHref } from '../../../lib/merchantRoutes';
import { KpiTile } from '../../ui/KpiTile';
import { Money } from '../../ui/Money';
import { StatusChip } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { ErrorState, NotFoundState } from '../../ui/AsyncStates';
import { CardSkeleton, KpiRowSkeleton } from '../../ui/DashboardSkeletons';
import { dateLocale } from '../../orders/format';
import { orderStatusLabel, orderStatusTone } from '../orders/labels';
import { customersApi, type CustomerDetail } from './api';

export default function CustomerDetailView({ customerKey, href }: { customerKey: string; href: (link: string) => string }) {
  const { loc, lang, dir } = useLanguage();
  const L = lang as 'ar' | 'en' | 'ckb';
  const [data, setData] = useState<CustomerDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [missing, setMissing] = useState(false);
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle');

  const load = useCallback(() => {
    setError(null);
    customersApi
      .one(customerKey)
      .then(setData)
      .catch((e) => (e instanceof ApiError && e.status === 404 ? setMissing(true) : setError(e)));
  }, [customerKey]);
  useEffect(load, [load]);

  const loadMore = async () => {
    if (!data?.next_cursor) return;
    setMore('loading');
    try {
      const d = await customersApi.one(customerKey, data.next_cursor);
      setData((prev) => (prev ? { ...prev, orders: [...prev.orders, ...d.orders.filter((o) => !prev.orders.some((p) => p.id === o.id))], next_cursor: d.next_cursor } : d));
      setMore('idle');
    } catch {
      setMore('error');
    }
  };

  const Back = dir === 'rtl' ? ArrowRight : ArrowLeft;
  const back = (
    <Link to={href(merchantHref.customers())} className="inline-flex min-h-11 items-center gap-1.5 text-[13px] font-semibold text-text-secondary hover:text-text-primary" data-customer-back>
      <Back aria-hidden="true" className="h-4 w-4" />
      {loc('كل الزبائن', 'All customers')}
    </Link>
  );
  const date = (iso: string | null) => (iso ? new Intl.DateTimeFormat(dateLocale(L), { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso)) : '—');

  if (missing) return <div className="space-y-3">{back}<NotFoundState title={loc('ليس من زبائن متجرك', 'Not a customer of your store')} /></div>;
  if (error && !data) return <div className="space-y-3">{back}<ErrorState error={error} onRetry={load} compact /></div>;
  if (!data) return <div className="space-y-3" aria-busy="true">{back}<KpiRowSkeleton count={4} /><CardSkeleton lines={4} /></div>;

  const c = data.customer;
  return (
    <div className="space-y-4" data-customer-detail={c.key}>
      {back}
      <header className="lv-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-[18px] font-bold text-text-primary">{c.name || '—'}</h1>
            <p className="mt-1 text-[12.5px] text-text-muted">
              {loc('أول طلب', 'First order')} <bdi>{date(c.first_order_at)}</bdi> · {loc('آخر طلب', 'Last order')} <bdi>{date(c.last_order_at)}</bdi>
            </p>
          </div>
          {c.returning && <StatusChip tone="accent">{loc('زبون عائد', 'Returning customer')}</StatusChip>}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
          {c.phone && (
            <a href={`tel:${c.phone}`} className="inline-flex min-h-11 items-center gap-2 text-text-primary" data-customer-phone>
              <Phone aria-hidden="true" className="h-4 w-4 text-text-muted" />
              <bdi dir="ltr" className="tabular-nums">{c.phone}</bdi>
            </a>
          )}
          {c.governorate && (
            <span className="inline-flex min-h-11 items-center gap-2 text-text-secondary">
              <MapPin aria-hidden="true" className="h-4 w-4 text-text-muted" />
              {governorateName(c.governorate, L)}
            </span>
          )}
        </div>
      </header>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <KpiTile label={loc('الطلبات', 'Orders', 'داواکاری')} value={formatFigure(c.order_count, L)} hint={c.cancelled_count ? loc(`و${formatFigure(c.cancelled_count, L)} ملغاة لم تُحتسب`, `and ${formatFigure(c.cancelled_count, L)} cancelled, not counted`) : undefined} />
        <KpiTile label={loc('أنفق هنا', 'Spent here')} value={<Money iqd={c.spent_iqd} />} />
        <KpiTile label={loc('متوسط الطلب', 'Average order', 'ناوەندی داواکاری')} value={c.average_order_iqd !== undefined ? <Money iqd={c.average_order_iqd} /> : null} />
        <KpiTile label={loc('زبون منذ', 'Customer since')} value={<bdi className="text-[17px]">{date(c.first_order_at)}</bdi>} />
      </div>
      <section className="lv-surface p-4" aria-labelledby="customer-orders">
        <h2 id="customer-orders" className="mb-2 text-[15px] font-bold text-text-primary">{loc('طلباته من متجرك', 'Their orders from your store')}</h2>
        <ul className="divide-y divide-border-subtle">
          {data.orders.map((o) => (
            <li key={o.id}>
              <Link to={href(o.link)} className="flex min-h-14 items-center justify-between gap-3 py-2.5 hover:bg-white/[0.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus" data-customer-order={o.id}>
                <span className="min-w-0">
                  <bdi dir="ltr" className="block text-[13px] font-semibold text-text-primary">{o.id}</bdi>
                  <span className="text-[12px] text-text-muted">
                    {date(o.created_at)} · {loc(`${formatFigure(o.item_count, L)} منتج`, `${formatFigure(o.item_count, L)} items`)}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <Money iqd={o.total_iqd} className="text-[13px] font-semibold text-text-primary" />
                  <StatusChip tone={orderStatusTone(o.status)}>{orderStatusLabel(o.status, loc)}</StatusChip>
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {data.next_cursor && (
          <Button variant="ghost" block onClick={loadMore} loading={more === 'loading'} className="mt-2">
            {more === 'error' ? loc('تعذر تحميل المزيد — إعادة المحاولة', 'Failed to load more — retry', 'زیاتر بارنەبوو — دووبارە هەوڵ بدەوە') : loc('عرض المزيد', 'Load more', 'زیاتر پیشان بدە')}
          </Button>
        )}
      </section>
    </div>
  );
}
