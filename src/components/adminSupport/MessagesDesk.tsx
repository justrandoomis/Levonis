import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, FileText, ImageIcon, MessageCircle, Mic, RefreshCw, Video } from 'lucide-react';
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
          <button onClick={back} className="inline-flex min-h-9 items-center gap-1 text-xs font-bold text-zinc-400 hover:text-white">
            <ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
            {cs.back}
          </button>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2.5">
            <span className="min-w-0 break-words text-sm font-bold text-white">{who}</span>
            <span className="font-mono text-xs text-zinc-400">
              {cs.order} {open.order_id}
            </span>
            {open.customer.email && open.customer.email !== who && <span className="break-all text-xs text-zinc-500">{open.customer.email}</span>}
          </div>
        </div>
        {/* The panel is `h-full` inside its parent; this box is the parent,
            and it is what bounds the list so the composer stays on screen. */}
        <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/40">
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
          <p className="mt-0.5 text-xs text-zinc-500">{cs.messagesHint}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-zinc-700 bg-zinc-800 p-0.5" role="group">
            {(['all', 'unread'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
                className={`min-h-8 rounded-md px-3 text-xs font-bold transition-colors ${
                  filter === f ? 'bg-zinc-600 text-white' : 'text-zinc-400 hover:text-white'
                }`}
              >
                {f === 'all' ? cs.allThreads : cs.unreadOnly}
              </button>
            ))}
          </div>
          <button onClick={() => void load()} aria-label={cs.refresh} title={cs.refresh} className="rounded-lg border border-zinc-700 bg-zinc-800 p-2 text-zinc-300 hover:text-white">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{error}</div>}

      {rows === null ? (
        <div className="py-10 text-center text-zinc-500">…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 py-10 text-center text-sm text-zinc-500">{cs.messagesEmpty}</div>
      ) : (
        <ul className="space-y-2" data-support-chat-list>
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
                  className={`flex w-full items-start gap-3 rounded-xl border p-3 text-start transition-colors hover:bg-zinc-800/60 ${
                    r.unread > 0 ? 'border-sky-500/30 bg-sky-500/[0.06]' : 'border-zinc-800 bg-zinc-900'
                  }`}
                >
                  <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-zinc-800 text-zinc-300">
                    <MessageCircle className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className={`min-w-0 truncate text-sm ${r.unread > 0 ? 'font-bold text-white' : 'text-zinc-200'}`}>{who}</span>
                      <span className="shrink-0 text-[11px] text-zinc-500">{shortDate(r.last_message.at)}</span>
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-400">
                      {!r.last_message.from_customer && <span className="shrink-0 text-zinc-500">{cs.fromTeam}:</span>}
                      {k === 'image' && <ImageIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                      {k === 'video' && <Video className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                      {k === 'audio' && <Mic className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                      {k === 'file' && <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                      <span className="min-w-0 truncate">{preview}</span>
                    </span>
                    <span className="mt-1 flex items-center gap-2 text-[11px] text-zinc-500">
                      <span className="font-mono">
                        {cs.order} {r.order_id}
                      </span>
                      {r.unread > 0 && (
                        <span className="rounded-full bg-sky-500/15 px-2 py-0.5 font-bold text-sky-300">{cs.unreadBadge(r.unread)}</span>
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
