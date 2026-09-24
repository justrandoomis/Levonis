/**
 * THE STORE'S INBOX — the conversations the store owns, newest activity first.
 *
 * Self-contained (reads /api/merchant/inbox only), so the wave-3 workspace can
 * mount it at `/merchant/inbox` unchanged; today it is the dashboard's
 * «الرسائل» tab. What it lists is decided by the server: the store's threads
 * the owner is a member of — a customer's message to the store, a store
 * order's thread, a custom request's thread. Search runs on the server (the
 * customer's name, the order or request number, and the words of the
 * messages), so a thread from last year is as findable as today's.
 *
 * A thread opens in the Chat page (attachments, voice notes, files as today).
 * On a store's own subdomain that page lives on the main site, which shares
 * the session.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageCircle, Search } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { useStore } from '../../../StoreContext';
import { listView } from '../../../lib/listView';
import { Segmented } from '../../ui/Segmented';
import { Badge, StatusChip } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Switch } from '../../ui/Switch';
import { Input } from '../../ui/Field';
import { EmptyState, ErrorState } from '../../ui/AsyncStates';
import { ListRowsSkeleton } from '../../ui/DashboardSkeletons';
import { useMainSiteHref } from '../dashboard/ui';
import { relTime } from '../notifications/notificationKinds';
import { merchantInboxApi, type InboxKind, type InboxThread } from './merchantInboxApi';

type KindFilter = 'all' | InboxKind;

export default function MerchantInbox({ focusThreadId }: { focusThreadId?: string | null }) {
  const { loc } = useLanguage();
  const { store: hostStore } = useStore();
  const mainHref = useMainSiteHref();
  const [kind, setKind] = useState<KindFilter>('all');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [rows, setRows] = useState<InboxThread[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const seq = useRef(0);

  // Server search, debounced: one request per pause, not per keystroke.
  useEffect(() => {
    const t = window.setTimeout(() => setTerm(q.trim()), 300);
    return () => window.clearTimeout(t);
  }, [q]);

  const params = useCallback(
    (c?: string | null) => ({ q: term, kind: kind === 'all' ? '' : kind, unread: unreadOnly, cursor: c, limit: 30 }) as const,
    [term, kind, unreadOnly]
  );

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const page = await merchantInboxApi.list(params());
      if (mine !== seq.current) return;
      setRows(page.threads);
      setCursor(page.next_cursor);
    } catch (e) {
      if (mine === seq.current) setError(e);
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [params]);

  useEffect(() => {
    void load();
  }, [load]);

  const more = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await merchantInboxApi.list(params(cursor));
      setRows((prev) => [...(prev ?? []), ...page.threads.filter((t) => !(prev ?? []).some((p) => p.id === t.id))]);
      setCursor(page.next_cursor);
    } catch (e) {
      setError(e);
    } finally {
      setLoadingMore(false);
    }
  };

  const view = listView(rows, loading, error);
  const contextLabel = (t: InboxThread) =>
    t.kind === 'order'
      ? loc(`طلب ${t.context_id}`, `Order ${t.context_id}`)
      : t.kind === 'request'
        ? loc('طلب مخصص', 'Custom request')
        : loc('رسالة مباشرة', 'Direct message');
  // OWNER: Sorani to be written by hand (the inbox's own lines).

  return (
    <section className="min-w-0" aria-labelledby="merchant-inbox-title" data-merchant-inbox>
      <h2 id="merchant-inbox-title" className="mb-3 text-[15px] font-bold text-text-primary">
        {loc('رسائل المتجر', 'Store messages')}
      </h2>

      <div className="mb-3 space-y-2">
        <label className="relative block">
          <span className="sr-only">{loc('ابحث في الرسائل', 'Search messages')}</span>
          <Search aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <Input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={loc('الاسم أو رقم الطلب أو كلمة', 'Customer name, order number, or a word from the chat')}
            className="ps-9"
            data-merchant-inbox-search
          />
        </label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Segmented
            size="sm"
            group="merchant-inbox-kind"
            label={loc('نوع المحادثة', 'Conversation type')}
            value={kind}
            onChange={(id) => setKind(id as KindFilter)}
            className="w-full min-w-0 sm:max-w-md"
            items={[
              { id: 'all', label: loc('الكل', 'All', 'هەموو') },
              { id: 'direct', label: loc('مباشرة', 'Direct') },
              { id: 'order', label: loc('طلبات', 'Orders') },
              { id: 'request', label: loc('مخصصة', 'Custom') },
            ]}
          />
          <Switch
            label={loc('غير المقروءة فقط', 'Unread only')}
            checked={unreadOnly}
            onChange={setUnreadOnly}
            className="shrink-0 self-end sm:self-auto"
          />
        </div>
      </div>

      {view === 'skeleton' && <ListRowsSkeleton rows={5} />}
      {view === 'error' && <ErrorState error={error} onRetry={() => void load()} compact />}
      {view === 'empty' && (
        <EmptyState
          compact
          icon={<MessageCircle aria-hidden="true" className="h-6 w-6" />}
          title={
            term || unreadOnly || kind !== 'all'
              ? loc('لا محادثات تطابق هذا', 'No conversations match this')
              : loc('لا رسائل بعد', 'No messages yet')
          }
          description={
            term || unreadOnly || kind !== 'all'
              ? undefined
              : loc(
                  'حين يراسل زبون متجرك، أو يسأل عن طلب، تظهر المحادثة هنا.',
                  'When a customer messages your store or asks about an order, the conversation appears here.'
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
        <>
          <ul className="lv-surface divide-y divide-border-subtle overflow-hidden" aria-busy={view === 'refreshing' || undefined}>
            {(rows ?? []).map((t) => {
              const name = t.customer?.name || t.customer?.username || loc('زبون', 'Customer');
              const path = `/chat/${encodeURIComponent(t.id)}`;
              const inner = (
                <>
                  <span aria-hidden="true" className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/[0.06] text-[14px] font-bold text-text-secondary">
                    {name.trim().slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className={`min-w-0 truncate text-[13.5px] ${t.unread ? 'font-bold text-text-primary' : 'text-text-secondary'}`}>
                        <bdi>{name}</bdi>
                      </span>
                      {t.last_message_at && (
                        <time dateTime={t.last_message_at} className="ms-auto shrink-0 text-[11.5px] text-text-muted">
                          {relTime(t.last_message_at, loc)}
                        </time>
                      )}
                    </span>
                    <span className="mt-1 flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-text-muted">
                        {t.last_from === 'store' && <span>{loc('أنت: ', 'You: ')}</span>}
                        <bdi>{t.last_message || '—'}</bdi>
                      </span>
                      {t.unread > 0 && (
                        <>
                          <Badge tone="accent">{t.unread}</Badge>
                          <span className="sr-only">{loc('رسائل غير مقروءة', 'unread messages')}</span>
                        </>
                      )}
                    </span>
                    <StatusChip tone={t.kind === 'order' ? 'info' : 'neutral'} className="mt-1.5">
                      <bdi>{contextLabel(t)}</bdi>
                    </StatusChip>
                  </span>
                </>
              );
              const cls = `flex min-h-16 items-start gap-3 px-3 py-3 transition-colors hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus ${
                focusThreadId === t.id ? 'bg-surface-selected' : ''
              }`;
              return (
                <li key={t.id} data-merchant-thread={t.kind}>
                  {hostStore ? (
                    <a href={mainHref(path)} className={cls}>
                      {inner}
                    </a>
                  ) : (
                    <Link to={path} className={cls}>
                      {inner}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
          {cursor && (
            <Button variant="secondary" block onClick={more} loading={loadingMore} className="mt-3">
              {loc('عرض المزيد', 'Show more', 'زیاتر')}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
