import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, FileText, ImageIcon, MessageCircle, Mic, RefreshCw, Video } from 'lucide-react';
import { IconButton } from '../ui/Button';
import { useLanguage } from '../../LanguageContext';
import { api, ApiError } from '../../lib/api';
import { STRINGS, shortDate } from '../adminMemberships/strings';
import OrderChatPanel from '../adminOrders/OrderChatPanel';
import { consoleStrings, previewLabel } from './strings';
import { refreshSupportCounts } from './supportCounts';
import { pollWhileVisible } from '../../lib/supportThread';

/**
 * «الرسائل» — every customer who wrote in «محادثة حول هذا الطلب», in one list.
 *
 * Until this screen the only door into an order's thread was that order's own
 * modal, so a customer's message was seen when somebody happened to open the
 * right order, and not otherwise. The list comes from /api/admin/chats
 * (worker/routes/adminChats.ts): the shop's own order threads, the ones waiting
 * on staff first, each with how many customer lines nobody on the team has
 * read.
 *
 * THE THREAD IS THE ORDER MODAL'S OWN PANEL, not a copy of it. `OrderChatPanel`
 * opens the thread through `/api/chats/open`, which joins this admin as a
 * participant, and reading it stamps `last_read_at` — which is what clears the
 * unread count here. One panel means the camera, the file picker and whatever
 * the order chat learns next arrive in both places at once.
 */
interface ChatRow {
  id: string;
  order_id: string;
  order_status: string;
  customer: { id: string; name: string | null; username: string | null; email: string | null };
  last_message: { body: string; kind: string; at: string; from_customer: boolean };
  message_count: number;
  unread: number;
}

const LIST_POLL_MS = 20_000;

export default function MessagesDesk() {
  const { lang } = useLanguage();
  const cs = consoleStrings(lang);
  const loadError = (STRINGS[lang] ?? STRINGS.ar).loadError;
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [rows, setRows] = useState<ChatRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<ChatRow | null>(null);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) {
        setLoading(true);
        setError('');
      }
      try {
        const d = await api.get<{ chats: ChatRow[] }>(
          `/api/admin/chats${filter === 'unread' ? '?filter=unread' : ''}`,
          silent ? { mascot: 'silent' } : undefined
        );
        setRows(d.chats || []);
      } catch (e) {
        if (!silent) setError(e instanceof ApiError ? e.message : loadError);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [filter, loadError]
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (open) return;
    return pollWhileVisible(() => void load(true), LIST_POLL_MS);
  }, [open, load]);

  /**
   * Opening a thread reads it, and reading it is what clears the badge — so
   * the counts are asked for again once the panel has had time to load, and
   * the list is re-read on the way back so the row stops saying «غير مقروءة».
   */
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => void refreshSupportCounts(), 2500);
    return () => clearTimeout(t);
  }, [open]);

  const back = () => {
    setOpen(null);
    void load(true);
    void refreshSupportCounts();
  };

  if (open) {
    const who = open.customer.name || open.customer.username || open.customer.email || open.customer.id;
    return (
      <div className="flex h-[calc(100dvh-12.5rem)] min-h-[380px] flex-col gap-2" data-support-chat-thread>
        <div className="shrink-0 space-y-2">
          <button onClick={back} className="inline-flex min-h-9 items-center gap-1 text-xs font-bold text-text-secondary hover:text-white">
            <ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
            {cs.back}
          </button>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border-subtle bg-surface px-3 py-2.5">
            <span className="min-w-0 break-words text-sm font-bold text-white">{who}</span>
            <span className="font-mono text-xs text-text-secondary">
              {cs.order} {open.order_id}
            </span>
            {open.customer.email && open.customer.email !== who && <span className="break-all text-xs text-text-muted">{open.customer.email}</span>}
          </div>
        </div>
        {/* The panel is `h-full` inside its parent; this box is the parent,
            and it is what bounds the list so the composer stays on screen. */}
        <div className="lv-surface min-h-0 flex-1 overflow-hidden">
          <OrderChatPanel orderId={open.order_id} active />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-black text-white">{cs.messagesTitle}</h3>
          <p className="mt-0.5 text-xs text-text-muted">{cs.messagesHint}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="lv-well flex rounded-full border border-border-subtle p-0.5" role="group">
            {(['all', 'unread'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
                className={`min-h-8 rounded-full border px-3 text-xs font-bold transition-colors ${
                  filter === f ? 'border-border-subtle bg-surface-raised text-text-primary shadow-1' : 'border-transparent text-text-secondary hover:text-text-primary'
                }`}
              >
                {f === 'all' ? cs.allThreads : cs.unreadOnly}
              </button>
            ))}
          </div>
          <IconButton
            variant="secondary"
            onClick={() => void load()}
            label={cs.refresh}
            icon={<RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />}
          />
        </div>
      </div>

      {error && <div className="lv-alert lv-alert-danger text-sm text-text-primary">{error}</div>}

      {rows === null ? (
        <div className="py-10 text-center text-text-muted">…</div>
      ) : rows.length === 0 ? (
        <div className="lv-surface py-10 text-center text-sm text-text-muted">{cs.messagesEmpty}</div>
      ) : (
        <ul className="lv-surface divide-y divide-border-subtle overflow-hidden" data-support-chat-list>
          {rows.map((r) => {
            const who = r.customer.name || r.customer.username || r.customer.email || r.customer.id;
            const k = r.last_message.kind;
            const preview = r.last_message.body || previewLabel(k, cs);
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setOpen(r)}
                  data-chat-id={r.id}
                  className={`flex w-full items-start gap-3 p-3 text-start transition-colors hover:bg-surface-selected ${
                    r.unread > 0 ? 'bg-surface-raised' : ''
                  }`}
                >
                  <span className="lv-well mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full text-text-secondary">
                    <MessageCircle className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className={`min-w-0 truncate text-sm ${r.unread > 0 ? 'font-bold text-white' : 'text-text-primary'}`}>{who}</span>
                      <span className="shrink-0 text-[11px] text-text-muted">{shortDate(r.last_message.at)}</span>
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-xs text-text-secondary">
                      {!r.last_message.from_customer && <span className="shrink-0 text-text-muted">{cs.fromTeam}:</span>}
                      {k === 'image' && <ImageIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                      {k === 'video' && <Video className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                      {k === 'audio' && <Mic className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                      {k === 'file' && <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                      <span className="min-w-0 truncate">{preview}</span>
                    </span>
                    <span className="mt-1 flex items-center gap-2 text-[11px] text-text-muted">
                      <span className="font-mono">
                        {cs.order} {r.order_id}
                      </span>
                      {r.unread > 0 && (
                        <span className="lv-chip rounded-full px-2 py-0.5 font-bold [--chip:var(--color-info)]">{cs.unreadBadge(r.unread)}</span>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
