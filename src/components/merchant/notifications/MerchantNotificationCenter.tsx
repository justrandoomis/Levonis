/**
 * THE STORE'S NOTIFICATION CENTRE — what happened to the business, each item a
 * door to the object it is about.
 *
 * Self-contained: it reads /api/merchant/notifications/* and needs nothing
 * from the page that mounts it, so the wave-3 workspace can mount it at
 * `/merchant/notifications` unchanged. Today it is the dashboard's
 * «الإشعارات» tab.
 *
 * WHAT IT PROMISES.
 *   - Every row opens its object: the stored link is a workspace address
 *     (`/merchant/orders/…`), re-based for a store's own host (`hostPath`).
 *     Opening marks the row read, optimistically; the count shown afterwards
 *     is the server's.
 *   - Loading, failure, empty and «no unread» are four different screens
 *     (`listView`): a failed request never reads as «لا إشعارات».
 *   - Unread is carried by weight, a dot AND the words «غير مقروء» for a
 *     screen reader — never by colour alone.
 *   - Newest first, grouped by day; older pages by cursor («عرض المزيد»).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCheck, ChevronLeft } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { useStore } from '../../../StoreContext';
import { hostPath } from '../../../lib/merchantRoutes';
import { listView } from '../../../lib/listView';
import { Button } from '../../ui/Button';
import { Segmented } from '../../ui/Segmented';
import { Badge } from '../../ui/Badge';
import { EmptyState, ErrorState } from '../../ui/AsyncStates';
import { ListRowsSkeleton } from '../../ui/DashboardSkeletons';
import { useToast } from '../../ui/Toast';
import { merchantNotificationsApi, type MerchantNotification } from './merchantNotificationsApi';
import { ATTENTION_KINDS, IsolatedText, dayBucket, kindIcon, relTime } from './notificationKinds';

export interface MerchantNotificationCenterProps {
  /** Told the new unread total after every change, e.g. to update a badge. */
  onUnreadChange?: (unread: number) => void;
  className?: string;
}

type Filter = 'all' | 'unread';

export default function MerchantNotificationCenter({ onUnreadChange, className = '' }: MerchantNotificationCenterProps) {
  const { loc, lang } = useLanguage();
  const { store: hostStore } = useStore();
  const onStoreHost = !!hostStore;
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>('all');
  const [rows, setRows] = useState<MerchantNotification[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const seq = useRef(0);
  const unreadCb = useRef(onUnreadChange);
  unreadCb.current = onUnreadChange;

  const report = useCallback((n: number) => {
    setUnread(n);
    unreadCb.current?.(n);
  }, []);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const page = await merchantNotificationsApi.feed({ unread: filter === 'unread', limit: 25 });
      if (mine !== seq.current) return;
      setRows(page.notifications);
      setCursor(page.next_cursor);
      report(page.unread);
    } catch (e) {
      if (mine === seq.current) setError(e);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [filter, report]);

  useEffect(() => {
    void load();
  }, [load]);

  const more = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await merchantNotificationsApi.feed({ unread: filter === 'unread', cursor, limit: 25 });
      setRows((prev) => [...(prev ?? []), ...page.notifications.filter((n) => !(prev ?? []).some((p) => p.id === n.id))]);
      setCursor(page.next_cursor);
      report(page.unread);
    } catch {
      toast.error(loc('تعذّر تحميل المزيد', 'Could not load more'), { action: { label: loc('إعادة المحاولة', 'Try again'), onClick: () => void more() } });
      // OWNER: Sorani to be written by hand.
    } finally {
      setLoadingMore(false);
    }
  };

  const open = (n: MerchantNotification) => {
    if (n.read) return;
    setRows((prev) => prev?.map((r) => (r.id === n.id ? { ...r, read: true } : r)) ?? prev);
    report(Math.max(0, unread - 1));
    void merchantNotificationsApi
      .markRead(n.id)
      .then((r) => report(r.unread))
      .catch(() => undefined);
  };

  const markAll = async () => {
    const before = rows;
    setRows((prev) => prev?.map((r) => ({ ...r, read: true })) ?? prev);
    try {
      const r = await merchantNotificationsApi.markRead();
      report(r.unread);
      if (filter === 'unread') setRows([]);
    } catch {
      setRows(before);
      toast.error(loc('تعذّر التعليم كمقروء', 'Could not mark as read')); // OWNER: Sorani to be written by hand.
    }
  };

  const view = listView(rows, loading, error);
  const groups = useMemo(() => {
    const out: Array<{ key: 'today' | 'yesterday' | 'earlier'; items: MerchantNotification[] }> = [];
    for (const n of rows ?? []) {
      const key = dayBucket(n.created_at);
      const last = out[out.length - 1];
      if (last && last.key === key) last.items.push(n);
      else out.push({ key, items: [n] });
    }
    return out;
  }, [rows]);

  const groupLabel = (k: 'today' | 'yesterday' | 'earlier') =>
    k === 'today' ? loc('اليوم', 'Today', 'ئەمڕۆ') : k === 'yesterday' ? loc('أمس', 'Yesterday', 'دوێنێ') : loc('سابقًا', 'Earlier');

  return (
    <section className={`min-w-0 ${className}`} aria-labelledby="merchant-notifications-title" data-merchant-notifications>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <h2 id="merchant-notifications-title" className="text-[15px] font-bold text-text-primary">
            {loc('إشعارات المتجر', 'Store notifications')}
            {/* OWNER: Sorani to be written by hand. */}
          </h2>
          {unread > 0 && <Badge tone="accent">{unread}</Badge>}
        </div>
        <Button
          variant="ghost"
          size="sm"
          icon={<CheckCheck className="h-4 w-4" aria-hidden="true" />}
          onClick={markAll}
          disabled={unread === 0}
          data-merchant-notifications-mark-all
        >
          {loc('تعليم الكل كمقروء', 'Mark all read', 'هەموو وەک خوێندراوە')}
        </Button>
      </div>

      <Segmented
        size="sm"
        group="merchant-notif-filter"
        label={loc('عرض الإشعارات', 'Show notifications')}
        value={filter}
        onChange={(id) => setFilter(id as Filter)}
        className="mb-3 max-w-[16rem]"
        items={[
          { id: 'all', label: loc('الكل', 'All', 'هەموو') },
          { id: 'unread', label: loc('غير المقروءة', 'Unread'), badge: unread > 0 ? <Badge tone="accent">{unread}</Badge> : undefined },
        ]}
      />

      {view === 'skeleton' && <ListRowsSkeleton rows={5} />}
      {view === 'error' && <ErrorState error={error} onRetry={() => void load()} compact />}
      {view === 'empty' && (
        <EmptyState
          compact
          title={
            filter === 'unread'
              ? loc('لا جديد — قرأت كل شيء', 'Nothing new — you are all caught up')
              : loc('لا إشعارات بعد', 'No notifications yet')
          }
          description={
            filter === 'unread'
              ? undefined
              : loc(
                  'هنا تصلك الطلبات الجديدة والرسائل والتقييمات والمبالغ المتاحة، وكل إشعار يفتح ما يخصّه.',
                  'New orders, messages, reviews and money that became available arrive here, each one opening what it is about.'
                )
          }
        />
      )}
      {view === 'stale' && (
        <p role="status" className="mb-2 text-[12px] text-warning">
          {loc('تعذّر التحديث — هذه آخر نسخة محمّلة.', 'Could not refresh — this is the last loaded copy.')}
        </p>
      )}

      {(view === 'rows' || view === 'refreshing' || view === 'stale') && (
        <div className="space-y-4" aria-busy={view === 'refreshing' || undefined}>
          {groups.map((g) => (
            <div key={g.key}>
              <h3 className="mb-1.5 px-1 text-[12px] font-semibold text-text-muted">{groupLabel(g.key)}</h3>
              <ul className="lv-surface divide-y divide-border-subtle overflow-hidden">
                {g.items.map((n) => {
                  const Icon = kindIcon(n.kind);
                  const title = lang === 'en' ? n.title_en : lang === 'ckb' ? n.title_ckb || n.title_ar : n.title_ar;
                  const body = lang === 'en' ? n.body_en : lang === 'ckb' ? n.body_ckb || n.body_ar : n.body_ar;
                  const attention = ATTENTION_KINDS.has(n.kind);
                  return (
                    <li key={n.id}>
                      <Link
                        to={hostPath(n.link || '/merchant', onStoreHost)}
                        onClick={() => open(n)}
                        data-merchant-notification={n.kind}
                        data-read={n.read ? '1' : '0'}
                        className="flex min-h-14 items-start gap-3 px-3 py-3 transition-colors hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
                      >
                        <span
                          aria-hidden="true"
                          className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full ${
                            attention ? 'bg-warning/10 text-warning' : n.read ? 'bg-white/[0.05] text-text-muted' : 'bg-gold/10 text-gold'
                          }`}
                        >
                          <Icon className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className={`block text-[13.5px] leading-5 ${n.read ? 'text-text-secondary' : 'font-bold text-text-primary'}`}>
                            <IsolatedText text={title} />
                          </span>
                          {body && (
                            <span className="mt-0.5 line-clamp-2 block text-[12.5px] leading-5 text-text-muted">
                              <IsolatedText text={body} />
                            </span>
                          )}
                          <time dateTime={n.created_at} className="mt-1 block text-[11.5px] text-text-muted">
                            {relTime(n.created_at, loc)}
                          </time>
                        </span>
                        {!n.read && (
                          <>
                            <span aria-hidden="true" className="mt-2 h-2 w-2 shrink-0 rounded-full bg-gold" />
                            <span className="sr-only">{loc('غير مقروء', 'Unread', 'نەخوێندراوە')}</span>
                          </>
                        )}
                        <ChevronLeft aria-hidden="true" className="mt-2 h-4 w-4 shrink-0 text-text-muted ltr:rotate-180" />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
          {cursor && (
            <Button variant="secondary" block onClick={more} loading={loadingMore}>
              {loc('عرض المزيد', 'Show more', 'زیاتر')}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
