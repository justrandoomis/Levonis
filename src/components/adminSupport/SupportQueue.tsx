import { useState, useEffect, useCallback, useRef } from 'react';
import { useLanguage } from '../../LanguageContext';
import { api, ApiError, uploadFile } from '../../lib/api';
import { RefreshCw, MessageSquare, Paperclip } from 'lucide-react';
import { STRINGS, shortDate, type S } from '../adminMemberships/strings';

/**
 * THE SUPPORT CONSOLE — the screen an agent answers a customer from.
 *
 * WHY IT IS ITS OWN FILE AND ITS OWN SIDEBAR ENTRY.
 * «لا توجد صفحة في الادارة للرد على رسائل المستخدمين والشكاوى والتذاكر.»
 * The screen existed. It was the SECOND TAB of «الأعضاء والدعم», a membership
 * panel filed under «العضويات والتسويق»/Growth — so the only way to reach the
 * place where customers are answered was to know that support lives inside
 * memberships, inside marketing. Nothing in the sidebar said «الدعم» and
 * nothing in the dashboard ever said a ticket was waiting. A feature nobody
 * can find is, to the person looking for it, a feature that does not exist,
 * and that is the honest reading of the report.
 *
 * It is still mounted from the memberships panel too, so the tab an admin may
 * have bookmarked keeps working; both mount this same component, so the queue
 * cannot fork into two consoles that drift apart.
 *
 * WHAT ELSE CHANGED WHILE IT MOVED — the two defects the customer side had,
 * which this console had identically:
 *   1. a reply used to `openThread()` + `load()`, blanking the whole thread
 *      behind a spinner and re-fetching the queue, for one sent sentence. The
 *      server now returns the row it wrote, so the reply APPENDS.
 *   2. it could not send a picture. Staff answering «طلعت الطباعة خربانة» had
 *      no way to send back a photograph of the correct setting or of the
 *      replacement part. Attachments are filed under the ticket and read back
 *      through the same authorised `/files/` route as the customer's.
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

const STATE_STYLES: Record<AdminTicket['state'], string> = {
  open: 'bg-blue-500/20 text-blue-300',
  waiting_customer: 'bg-amber-500/20 text-amber-300',
  waiting_staff: 'bg-purple-500/20 text-purple-300',
  resolved: 'bg-emerald-500/20 text-emerald-300',
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

export default function SupportQueue() {
  const { lang } = useLanguage();
  const s: S = STRINGS[lang] ?? STRINGS.ar;
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
  const tempCounter = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const qs = stateFilter ? `?state=${encodeURIComponent(stateFilter)}` : '';
      const d = await api.get<{ tickets: AdminTicket[] }>(`/api/support/admin/tickets${qs}`);
      setTickets(d.tickets || []);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : s.loadError);
    } finally {
      setLoading(false);
    }
  }, [stateFilter, s.loadError]);

  useEffect(() => {
    load();
  }, [load]);

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

  const nextTempId = () => {
    tempCounter.current += 1;
    return `temp-${Date.now()}-${tempCounter.current}`;
  };

  /**
   * The staff twin of the customer's `commitReply`. Same contract: the bubble
   * is on screen before the request leaves, the server's own row replaces it,
   * and a failure REMOVES it rather than leaving a message in the thread that
   * the customer will never receive.
   */
  const commitReply = async (
    payload: { body?: string; fileKey?: string },
    optimistic: { body: string; kind: 'text' | 'image' | 'video'; file_url: string | null },
    onFailure?: () => void
  ) => {
    const ticketId = openId;
    if (!ticketId) return;
    const tempId = nextTempId();
    setThreadError('');
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
    try {
      const res = await api.post<{ message?: TicketMsg; ticket_state?: AdminTicket['state']; updated_at?: string }>(
        `/api/support/admin/tickets/${ticketId}/messages`,
        payload
      );
      setThread((prev) => {
        if (!prev || prev.ticket.id !== ticketId) return prev;
        const settled: TicketMsg = res?.message
          ? { ...res.message, pending: false }
          : {
              id: tempId,
              body: optimistic.body,
              is_staff: true,
              created_at: new Date().toISOString(),
              kind: optimistic.kind,
              file_url: optimistic.file_url,
              pending: false,
            };
        return {
          ticket: { ...prev.ticket, state: res?.ticket_state ?? 'waiting_customer', updated_at: res?.updated_at ?? prev.ticket.updated_at },
          messages: prev.messages.map((m) => (m.id === tempId ? settled : m)),
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
    } catch (e) {
      setThread((prev) =>
        prev && prev.ticket.id === ticketId ? { ...prev, messages: prev.messages.filter((m) => m.id !== tempId) } : prev
      );
      setThreadError(e instanceof ApiError ? e.message : s.loadError);
      onFailure?.();
    }
  };

  const sendReply = async () => {
    const text = reply.trim();
    if (!openId || text.length === 0 || busy) return;
    setBusy(true);
    setReply('');
    try {
      await commitReply({ body: text }, { body: text, kind: 'text', file_url: null }, () => setReply(text));
    } finally {
      setBusy(false);
    }
  };

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !openId || uploading || busy) return;
    const localUrl = URL.createObjectURL(file);
    const kind: 'image' | 'video' = file.type.startsWith('video/') ? 'video' : 'image';
    setUploading(true);
    setThreadError('');
    try {
      const uploaded = await uploadFile(file, 'support', openId);
      await commitReply({ fileKey: uploaded.key }, { body: '', kind, file_url: localUrl });
    } catch (err) {
      setThreadError(err instanceof ApiError ? err.message : s.loadError);
    } finally {
      setUploading(false);
      URL.revokeObjectURL(localUrl);
    }
  };

  /**
   * A STATE CHANGE STILL REFRESHES — and that is not the defect the reply had.
   * Moving a ticket to «محلولة» removes it from the default queue, so the list
   * genuinely has to be re-read; the thread is patched in place rather than
   * blanked, so the conversation does not flash.
   */
  const changeState = async (next: string) => {
    if (!openId || !next) return;
    setBusy(true);
    setThreadError('');
    try {
      await api.patch(`/api/support/admin/tickets/${openId}`, { state: next });
      setThread((prev) => (prev ? { ...prev, ticket: { ...prev.ticket, state: next as AdminTicket['state'] } } : prev));
      await load();
    } catch (e) {
      setThreadError(e instanceof ApiError ? e.message : s.loadError);
    } finally {
      setBusy(false);
    }
  };

  if (openId) {
    return (
      <div className="space-y-3">
        <button onClick={() => setOpenId(null)} className="text-xs text-zinc-400 hover:text-white font-bold">
          ← {s.tabQueue}
        </button>
        {threadLoading ? (
          <div className="text-center py-8 text-zinc-500">{s.loading}</div>
        ) : thread ? (
          <>
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-white font-bold text-sm break-words">{thread.ticket.subject}</span>
                {thread.ticket.priority === 1 && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-yellow-500/20 text-yellow-300">{s.proBadge}</span>
                )}
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${STATE_STYLES[thread.ticket.state]}`}>
                  {ticketStateLabel(s, thread.ticket.state)}
                </span>
                <span className="text-[10px] text-zinc-500 font-bold">
                  {s.colAge}: {ageOf(thread.ticket.created_at, s)}
                </span>
              </div>
              <div className="text-xs text-zinc-500">
                {thread.ticket.email || thread.ticket.username || thread.ticket.user_id}
                {thread.ticket.order_id && <span className="font-mono"> · {thread.ticket.order_id}</span>}
              </div>
              <div className="flex items-center gap-2 pt-1">
                <select
                  value=""
                  disabled={busy}
                  onChange={(e) => changeState(e.target.value)}
                  className="bg-zinc-800 border border-zinc-700 text-white text-xs rounded-lg px-2 py-1.5 focus:outline-none disabled:opacity-50"
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
            <div className="space-y-2">
              {thread.messages.map((m) => (
                <div key={m.id} className={`flex ${m.is_staff ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[85%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap break-words ${
                      m.is_staff ? 'bg-[#6B46FF]/10 border border-[#6B46FF]/30 text-zinc-100' : 'bg-zinc-900 border border-zinc-800 text-zinc-200'
                    } ${m.pending ? 'opacity-60' : ''}`}
                  >
                    <div className="text-[10px] text-zinc-500 mb-0.5">
                      {m.is_staff ? s.staffLabel : s.customer} · {shortDate(m.created_at)}
                    </div>
                    {m.kind === 'image' && m.file_url && (
                      <img referrerPolicy="no-referrer" src={m.file_url} alt="" className="mb-1 max-h-[300px] w-full rounded-lg object-cover" />
                    )}
                    {m.kind === 'video' && m.file_url && (
                      <video src={m.file_url} controls playsInline className="mb-1 max-h-[300px] w-full rounded-lg" />
                    )}
                    {m.body}
                  </div>
                </div>
              ))}
            </div>
            {threadError && <div className="text-xs text-red-400">{threadError}</div>}
            <div className="flex gap-2">
              <input ref={fileRef} type="file" accept="image/*,video/*" className="hidden" onChange={onPickFile} />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={uploading || busy}
                aria-label={s.attach}
                title={s.attach}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-zinc-900 border border-zinc-700 text-zinc-300 hover:text-white disabled:opacity-50"
              >
                <Paperclip className="w-4 h-4" />
              </button>
              <input
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') sendReply();
                }}
                maxLength={4000}
                placeholder={uploading ? s.uploading : s.replyPlaceholder}
                className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-zinc-600 focus:outline-none"
              />
              <button
                onClick={sendReply}
                disabled={busy || uploading || reply.trim().length === 0}
                className="px-4 rounded-xl bg-[#2CE59B] text-black text-sm font-black disabled:opacity-50"
              >
                {s.reply}
              </button>
            </div>
          </>
        ) : (
          <div className="text-center py-8 text-red-400 text-sm">{threadError || s.loadError}</div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-sm font-black text-white">{s.queueTitle}</h3>
        <div className="flex items-center gap-2">
          <select
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value)}
            className="bg-zinc-800 border border-zinc-700 text-white text-xs rounded-lg px-2 py-1.5 focus:outline-none"
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
          <button onClick={load} aria-label={s.retry} className="p-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-300 hover:text-white">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl p-3 text-sm">
          {error}{' '}
          <button onClick={load} className="underline">
            {s.retry}
          </button>
        </div>
      )}

      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse min-w-[760px]">
            <thead>
              <tr className="bg-zinc-800/50 border-b border-zinc-700">
                {[s.colTicket, s.colCustomer, s.colPriority, s.colAge, s.qState, s.colMsgs].map((h) => (
                  <th key={h} className="py-3 px-4 text-xs font-bold text-zinc-400 uppercase tracking-wider text-start">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tickets.map((t) => (
                <tr
                  key={t.id}
                  onClick={() => openThread(t.id)}
                  className="border-b border-zinc-800 hover:bg-zinc-800/30 transition-colors cursor-pointer"
                >
                  <td className="py-3 px-4">
                    <div className="text-sm text-white font-bold break-words max-w-[260px]">{t.subject}</div>
                    <div className="text-[10px] text-zinc-600 font-mono">{t.id}</div>
                  </td>
                  <td className="py-3 px-4 text-xs text-zinc-400">{t.email || t.username || '—'}</td>
                  <td className="py-3 px-4">
                    {t.priority === 1 ? (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-yellow-500/20 text-yellow-300">{s.proBadge}</span>
                    ) : (
                      <span className="text-xs text-zinc-500">{s.ordinary}</span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-sm font-black text-white whitespace-nowrap">{ageOf(t.created_at, s)}</td>
                  <td className="py-3 px-4">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${STATE_STYLES[t.state]}`}>
                      {ticketStateLabel(s, t.state)}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-xs text-zinc-400">
                    <span className="flex items-center gap-1">
                      <MessageSquare className="w-3 h-3" /> {t.message_count ?? 0}
                    </span>
                  </td>
                </tr>
              ))}
              {!loading && tickets.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-zinc-500">
                    {s.ticketsEmpty}
                  </td>
                </tr>
              )}
              {loading && tickets.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-zinc-500">
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
