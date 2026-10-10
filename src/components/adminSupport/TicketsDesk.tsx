import { useState, useEffect, useCallback, useRef } from 'react';
import { useLanguage } from '../../LanguageContext';
import { api, ApiError, uploadFile } from '../../lib/api';
import { RefreshCw, MessageSquare, Paperclip, ChevronLeft } from 'lucide-react';
import { STRINGS, shortDate, type S } from '../adminMemberships/strings';
import { consoleStrings } from './strings';
import MessageMedia from './MessageMedia';
import { refreshSupportCounts } from './supportCounts';
import { mergeThread, pollWhileVisible, settleThread, useThreadScroll } from '../../lib/supportThread';

/**
 * «التذاكر» — the ticket queue and the thread an agent answers from.
 *
 * It was the whole of the support console until the console grew two more
 * queues (src/components/adminSupport/SupportQueue.tsx); the queue itself is
 * unchanged — PRO priority, then age, age always visible — and what changed is
 * the thread, which had the three defects the owner reported on the
 * customer's «تذاكري» and which this screen had identically:
 *
 *   1. THE COMPOSER WAS NOT PINNED. Paperclip, input and «رد» were ordinary
 *      flow content after the last bubble, inside the admin page's own
 *      scrolling panel, so on a long ticket the agent scrolled past every
 *      message to reach the box and nothing brought the newest message into
 *      view. The thread is now a height-bounded column: a scrolling list with
 *      a ref, and the composer as a `shrink-0` sibling that never moves. The
 *      list is scrolled with `scrollTop`, never `scrollIntoView` — that walks
 *      every scrollable ancestor and would drag the admin page itself (the
 *      reason OrderChatPanel.tsx gives for the same choice).
 *   2. THE THREAD NEVER REFRESHED. A customer line that arrived while the
 *      ticket was open was invisible until the agent went back and reopened
 *      it. It now polls silently every ten seconds while visible, and merges
 *      by id so a bubble being sent is never dropped or doubled
 *      (src/lib/supportThread.ts).
 *   3. A PICKED FILE SHOWED NOTHING UNTIL IT HAD UPLOADED. On a 40 MB clip over
 *      mobile data that is a long time with no sign anything happened, and
 *      the agent picks it again. The bubble now appears with the local preview
 *      BEFORE the upload starts, and is removed if the upload fails.
 */

interface AdminTicket {
  id: string;
  subject: string;
  order_id: string | null;
  unit_id: string | null;
  priority: number;
  state: 'open' | 'waiting_customer' | 'waiting_staff' | 'resolved';
  created_at: string;
  updated_at: string;
  message_count?: number;
  user_id?: string;
  email?: string | null;
  username?: string | null;
}
interface TicketMsg {
  id: string;
  body: string;
  is_staff: boolean;
  created_at: string;
  /** 'text' on every message written before migration 0107. */
  kind?: 'text' | 'image' | 'video';
  /** `/files/<key>`, composed by the server. Null for a typed message. */
  file_url?: string | null;
  /** On screen, not yet acknowledged by the server. */
  pending?: boolean;
}

/** A state is information: a flat chip in its tone (build plan §5). */
const STATE_STYLES: Record<AdminTicket['state'], string> = {
  open: 'lv-chip [--chip:var(--color-info)]',
  waiting_customer: 'lv-chip [--chip:var(--color-warning)]',
  waiting_staff: 'lv-chip [--chip:var(--color-gold)]',
  resolved: 'lv-chip [--chip:var(--color-success)]',
};

function ticketStateLabel(s: S, state: AdminTicket['state']): string {
  if (state === 'open') return s.stateOpen;
  if (state === 'waiting_customer') return s.stateWaitingCustomer;
  if (state === 'waiting_staff') return s.stateWaitingStaff;
  return s.stateResolved;
}

function ageOf(iso: string, s: S): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)} ${s.days}`;
}

/** How often an open thread and the queue re-read themselves, silently. */
const THREAD_POLL_MS = 10_000;
const QUEUE_POLL_MS = 30_000;

export default function TicketsDesk() {
  const { lang } = useLanguage();
  const s: S = STRINGS[lang] ?? STRINGS.ar;
  const cs = consoleStrings(lang);
  const [stateFilter, setStateFilter] = useState('');
  const [tickets, setTickets] = useState<AdminTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [thread, setThread] = useState<{ ticket: AdminTicket; messages: TicketMsg[] } | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [threadError, setThreadError] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const tempCounter = useRef(0);

  /** `silent` for the background re-read: no spinner, no error banner. */
  const load = useCallback(
    async (silent = false) => {
      if (!silent) {
        setLoading(true);
        setError('');
      }
      try {
        const qs = stateFilter ? `?state=${encodeURIComponent(stateFilter)}` : '';
        const d = await api.get<{ tickets: AdminTicket[] }>(`/api/support/admin/tickets${qs}`, silent ? { mascot: 'silent' } : undefined);
        setTickets(d.tickets || []);
      } catch (e) {
        if (!silent) setError(e instanceof ApiError ? e.message : s.loadError);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [stateFilter, s.loadError]
  );

  useEffect(() => {
    load();
  }, [load]);

  // The queue re-reads itself while it is on screen, so a new ticket appears
  // without the agent pressing refresh.
  useEffect(() => {
    if (openId) return;
    return pollWhileVisible(() => void load(true), QUEUE_POLL_MS);
  }, [openId, load]);

  /** Opening a thread is the one moment a spinner is honest. Replying is not. */
  const openThread = useCallback(
    async (id: string) => {
      setOpenId(id);
      setThread(null);
      setThreadError('');
      setThreadLoading(true);
      try {
        const d = await api.get<{ ticket: AdminTicket; messages: TicketMsg[] }>(`/api/support/admin/tickets/${id}`);
        setThread({ ticket: d.ticket, messages: d.messages || [] });
      } catch (e) {
        setThreadError(e instanceof ApiError ? e.message : s.loadError);
      } finally {
        setThreadLoading(false);
      }
    },
    [s.loadError]
  );

  /**
   * THE SILENT RE-READ OF AN OPEN THREAD. `mascot:'silent'` keeps the
   * character still on every tick, the answer is merged rather than swapped
   * in, and an answer for a ticket that is no longer open is dropped.
   */
  useEffect(() => {
    if (!openId || threadLoading) return;
    const id = openId;
    return pollWhileVisible(() => {
      api
        .get<{ ticket: AdminTicket; messages: TicketMsg[] }>(`/api/support/admin/tickets/${id}`, { mascot: 'silent' })
        .then((d) => {
          setThread((prev) =>
            prev && prev.ticket.id === id
              ? {
                  ticket: prev.ticket.state === d.ticket.state && prev.ticket.updated_at === d.ticket.updated_at ? prev.ticket : { ...prev.ticket, ...d.ticket },
                  messages: mergeThread(prev.messages, d.messages || []),
                }
              : prev
          );
        })
        .catch(() => undefined);
    }, THREAD_POLL_MS);
  }, [openId, threadLoading]);

  // The newest message is the one worth seeing — on open, on every append,
  // and again once a photo in it has loaded (src/lib/supportThread.ts).
  const messageCount = thread ? thread.messages.length : 0;
  const lastPending = !!thread?.messages[thread.messages.length - 1]?.pending;
  useThreadScroll(listRef, `${openId ?? ''}:${threadLoading ? 1 : 0}`, messageCount, lastPending);

  const nextTempId = () => {
    tempCounter.current += 1;
    return `temp-${Date.now()}-${tempCounter.current}`;
  };

  /** Put a bubble on screen before anything leaves; returns its temporary id. */
  const addPending = (ticketId: string, optimistic: { body: string; kind: 'text' | 'image' | 'video'; file_url: string | null }) => {
    const tempId = nextTempId();
    setThread((prev) =>
      prev && prev.ticket.id === ticketId
        ? {
            ...prev,
            messages: [
              ...prev.messages,
              {
                id: tempId,
                body: optimistic.body,
                is_staff: true,
                created_at: new Date().toISOString(),
                kind: optimistic.kind,
                file_url: optimistic.file_url,
                pending: true,
              },
            ],
          }
        : prev
    );
    return tempId;
  };

  const dropPending = (ticketId: string, tempId: string) =>
    setThread((prev) =>
      prev && prev.ticket.id === ticketId ? { ...prev, messages: prev.messages.filter((m) => m.id !== tempId) } : prev
    );

  /**
   * The staff twin of the customer's `commitReply`. Same contract: the bubble
   * is on screen before the request leaves, the server's own row replaces it,
   * and a failure REMOVES it rather than leaving a message in the thread that
   * the customer will never receive.
   */
  const commitReply = async (ticketId: string, tempId: string, payload: { body?: string; fileKey?: string }, fallback: TicketMsg) => {
    const res = await api.post<{ message?: TicketMsg; ticket_state?: AdminTicket['state']; updated_at?: string }>(
      `/api/support/admin/tickets/${ticketId}/messages`,
      payload
    );
    setThread((prev) => {
      if (!prev || prev.ticket.id !== ticketId) return prev;
      const settled: TicketMsg = res?.message ? { ...res.message, pending: false } : { ...fallback, id: tempId, pending: false };
      return {
        ticket: { ...prev.ticket, state: res?.ticket_state ?? 'waiting_customer', updated_at: res?.updated_at ?? prev.ticket.updated_at },
        messages: settleThread(prev.messages, tempId, settled),
      };
    });
    setTickets((prev) =>
      prev.map((t) =>
        t.id === ticketId
          ? {
              ...t,
              state: res?.ticket_state ?? 'waiting_customer',
              updated_at: res?.updated_at ?? t.updated_at,
              message_count: typeof t.message_count === 'number' ? t.message_count + 1 : t.message_count,
            }
          : t
      )
    );
    void refreshSupportCounts();
  };

  const sendReply = async () => {
    const text = reply.trim();
    const ticketId = openId;
    if (!ticketId || text.length === 0 || busy) return;
    setBusy(true);
    setReply('');
    setThreadError('');
    const tempId = addPending(ticketId, { body: text, kind: 'text', file_url: null });
    try {
      await commitReply(ticketId, tempId, { body: text }, { id: tempId, body: text, is_staff: true, created_at: new Date().toISOString(), kind: 'text', file_url: null });
    } catch (e) {
      dropPending(ticketId, tempId);
      setReply(text);
      setThreadError(e instanceof ApiError ? e.message : s.loadError);
    } finally {
      setBusy(false);
    }
  };

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    const ticketId = openId;
    if (!file || !ticketId || uploading || busy) return;
    const localUrl = URL.createObjectURL(file);
    const kind: 'image' | 'video' = file.type.startsWith('video/') ? 'video' : 'image';
    setUploading(true);
    setThreadError('');
    // BEFORE the upload: the preview is the proof something is happening.
    const tempId = addPending(ticketId, { body: '', kind, file_url: localUrl });
    try {
      const uploaded = await uploadFile(file, 'support', ticketId);
      await commitReply(ticketId, tempId, { fileKey: uploaded.key }, { id: tempId, body: '', is_staff: true, created_at: new Date().toISOString(), kind, file_url: uploaded.url });
    } catch (err) {
      dropPending(ticketId, tempId);
      setThreadError(err instanceof ApiError ? err.message : s.loadError);
    } finally {
      setUploading(false);
      // The server's `/files/…` has replaced the local preview (or the bubble
      // is gone); either way nothing still points at the object URL.
      URL.revokeObjectURL(localUrl);
    }
  };

  /**
   * A STATE CHANGE STILL REFRESHES THE QUEUE — and that is not the defect the
   * reply had. Moving a ticket to «محلولة» removes it from the default queue,
   * so the list genuinely has to be re-read; the thread is patched in place.
   */
  const changeState = async (next: string) => {
    if (!openId || !next) return;
    setBusy(true);
    setThreadError('');
    try {
      await api.patch(`/api/support/admin/tickets/${openId}`, { state: next });
      setThread((prev) => (prev ? { ...prev, ticket: { ...prev.ticket, state: next as AdminTicket['state'] } } : prev));
      void refreshSupportCounts();
      await load(true);
    } catch (e) {
      setThreadError(e instanceof ApiError ? e.message : s.loadError);
    } finally {
      setBusy(false);
    }
  };

  if (openId) {
    return (
      /* THE HEIGHT IS BOUNDED so the list can scroll inside it and the
         composer can sit under it. 12.5rem is the admin topbar, the page and
         panel padding and the console's own tab row; the floor keeps the
         thread usable in a landscape phone. */
      <div className="flex h-[calc(100dvh-12.5rem)] min-h-[380px] flex-col gap-2" data-support-thread>
        <div className="shrink-0 space-y-2">
          <button onClick={() => setOpenId(null)} className="inline-flex min-h-9 items-center gap-1 text-xs font-bold text-text-secondary hover:text-text-primary">
            <ChevronLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
            {s.tabQueue}
          </button>
          {thread && (
            <div className="space-y-1 lv-surface p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="break-words text-sm font-bold text-text-primary">{thread.ticket.subject}</span>
                {thread.ticket.priority === 1 && (
                  <span className="rounded-full px-2 py-0.5 text-[10px] font-bold lv-chip [--chip:var(--color-gold)]">{s.proBadge}</span>
                )}
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${STATE_STYLES[thread.ticket.state]}`}>
                  {ticketStateLabel(s, thread.ticket.state)}
                </span>
                <span className="text-[10px] font-bold text-text-muted">
                  {s.colAge}: {ageOf(thread.ticket.created_at, s)}
                </span>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0 text-xs text-text-muted">
                  <span className="break-all">{thread.ticket.email || thread.ticket.username || thread.ticket.user_id}</span>
                  {thread.ticket.order_id && <span className="font-mono"> · {thread.ticket.order_id}</span>}
                </div>
                <select
                  className="lv-input w-auto min-h-9 px-2 py-1.5 text-xs disabled:opacity-50"
                  value=""
                  disabled={busy}
                  onChange={(e) => changeState(e.target.value)}
                  aria-label={s.moveTo}
                >
                  <option value="" disabled>
                    {s.moveTo}
                  </option>
                  {(['open', 'waiting_customer', 'waiting_staff', 'resolved'] as const)
                    .filter((st) => st !== thread.ticket.state)
                    .map((st) => (
                      <option key={st} value={st}>
                        {ticketStateLabel(s, st)}
                      </option>
                    ))}
                </select>
              </div>
            </div>
          )}
        </div>

        <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain rounded-xl lv-well p-2" data-support-thread-messages>
          {threadLoading ? (
            <div className="py-8 text-center text-text-muted">{s.loading}</div>
          ) : thread ? (
            thread.messages.map((m) => (
              <div key={m.id} className={`flex ${m.is_staff ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[85%] whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-sm ${
                    m.is_staff ? 'border border-iris/30 bg-iris/10 text-text-primary' : 'border border-border-subtle bg-surface-raised text-text-primary'
                  } ${m.pending ? 'opacity-60' : ''}`}
                >
                  <div className="mb-0.5 text-[10px] text-text-muted">
                    {m.is_staff ? s.staffLabel : s.customer} · {m.pending && m.kind !== 'text' ? s.uploading : shortDate(m.created_at)}
                  </div>
                  <MessageMedia kind={m.kind} url={m.file_url} openLabel={cs.openImage} />
                  {m.body}
                </div>
              </div>
            ))
          ) : (
            <div className="py-8 text-center text-sm text-danger">{threadError || s.loadError}</div>
          )}
        </div>

        {thread && (
          <div className="shrink-0 space-y-1.5 border-t border-border-subtle bg-surface pt-2" data-support-thread-composer>
            {threadError && (
              <div role="alert" className="text-xs text-danger">
                {threadError}
              </div>
            )}
            <div className="flex gap-2">
              <input ref={fileRef} type="file" accept="image/*,video/*" className="hidden" onChange={onPickFile} />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={uploading || busy}
                aria-label={s.attach}
                title={s.attach}
                className="lv-button lv-button-secondary w-11 shrink-0 px-0"
              >
                <Paperclip className="h-4 w-4" />
              </button>
              <input
                className="lv-input min-w-0 flex-1 text-sm"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') sendReply();
                }}
                maxLength={4000}
                placeholder={uploading ? s.uploading : s.replyPlaceholder}
                aria-label={s.replyPlaceholder}
              />
              <button
                onClick={sendReply}
                disabled={busy || uploading || reply.trim().length === 0}
                className="lv-button lv-button-primary shrink-0"
              >
                {s.reply}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-black text-text-primary">{s.queueTitle}</h3>
        <div className="flex items-center gap-2">
          <select
            className="lv-input w-auto min-h-9 px-2 py-1.5 text-xs"
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value)}
            aria-label={s.qState}
          >
            <option value="">{s.unresolved}</option>
            <option value="all">{s.all}</option>
            {(['open', 'waiting_customer', 'waiting_staff', 'resolved'] as const).map((st) => (
              <option key={st} value={st}>
                {ticketStateLabel(s, st)}
              </option>
            ))}
          </select>
          <button onClick={() => load()} aria-label={s.retry} className="lv-button lv-button-secondary w-11 px-0">
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error && (
        <div className="lv-alert lv-alert-danger text-sm text-text-primary">
          {error}{' '}
          <button onClick={() => load()} className="underline">
            {s.retry}
          </button>
        </div>
      )}

      {/* A phone gets rows it can read without scrolling sideways; the table
          stays for the tablet and the desk, where its columns fit. */}
      <div className="lv-surface divide-y divide-border-subtle overflow-hidden md:hidden">
        {tickets.map((t) => (
          <button
            key={t.id}
            onClick={() => openThread(t.id)}
            className="w-full p-3 text-start transition-colors hover:bg-surface-raised"
          >
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0 break-words text-sm font-bold text-text-primary">{t.subject}</span>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${STATE_STYLES[t.state]}`}>{ticketStateLabel(s, t.state)}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-text-muted">
              <span className="break-all">{t.email || t.username || '—'}</span>
              <span>· {ageOf(t.created_at, s)}</span>
              {t.priority === 1 && <span className="font-bold text-gold">{s.proBadge}</span>}
              <span className="flex items-center gap-1">
                <MessageSquare className="h-3 w-3" /> {t.message_count ?? 0}
              </span>
            </div>
          </button>
        ))}
        {!loading && tickets.length === 0 && <div className="py-10 text-center text-text-muted">{s.ticketsEmpty}</div>}
        {loading && tickets.length === 0 && <div className="py-10 text-center text-text-muted">{s.loading}</div>}
      </div>

      <div className="hidden lv-surface overflow-hidden md:block">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse">
            <thead>
              <tr className="border-b border-border-subtle bg-surface-raised">
                {[s.colTicket, s.colCustomer, s.colPriority, s.colAge, s.qState, s.colMsgs].map((h) => (
                  <th key={h} className="px-4 py-3 text-start text-xs font-bold uppercase tracking-wider text-text-secondary">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tickets.map((t) => (
                <tr key={t.id} onClick={() => openThread(t.id)} className="cursor-pointer border-b border-border-subtle transition-colors hover:bg-surface-raised">
                  <td className="px-4 py-3">
                    <div className="max-w-[260px] break-words text-sm font-bold text-text-primary">{t.subject}</div>
                    <div className="font-mono text-[10px] text-text-muted">{t.id}</div>
                  </td>
                  <td className="px-4 py-3 text-xs text-text-secondary">{t.email || t.username || '—'}</td>
                  <td className="px-4 py-3">
                    {t.priority === 1 ? (
                      <span className="rounded-full px-2 py-0.5 text-[10px] font-bold lv-chip [--chip:var(--color-gold)]">{s.proBadge}</span>
                    ) : (
                      <span className="text-xs text-text-muted">{s.ordinary}</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm font-black text-text-primary">{ageOf(t.created_at, s)}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${STATE_STYLES[t.state]}`}>{ticketStateLabel(s, t.state)}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-text-secondary">
                    <span className="flex items-center gap-1">
                      <MessageSquare className="h-3 w-3" /> {t.message_count ?? 0}
                    </span>
                  </td>
                </tr>
              ))}
              {!loading && tickets.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-text-muted">
                    {s.ticketsEmpty}
                  </td>
                </tr>
              )}
              {loading && tickets.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-text-muted">
                    {s.loading}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
