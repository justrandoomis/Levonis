import { useChatPresence } from '../../lib/useChatPresence';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api, ApiError } from '../../lib/api';
import Spinner from '../ui/Spinner';
import { ErrorState } from '../ui/AsyncStates';

interface ChatMessage {
  id: string;
  sender_id: string;
  kind: 'text' | 'image';
  body: string;
  created_at: string;
  url?: string;
}

/**
 * The conversation about ONE order, rendered inside the order modal.
 *
 * WHY IT IS NOT A LINK TO /chats. Answering "which colour did you mean?"
 * while packing a box should not cost the admin the screen they are packing
 * from. Navigating away loses the address, the item list and the total they
 * were reading, and coming back means finding the order again. So this is a
 * tab in the same modal: the admin flips between the order and the thread and
 * the order stays loaded behind it.
 *
 * The thread is scoped to the order (chats.order_id, migration 0026), so it is
 * a different conversation from the customer's general DM with support and
 * stays findable months later.
 */
export default function OrderChatPanel({ orderId, active }: { orderId: string; active: boolean }) {
  const { loc } = useLanguage();
  const [chatId, setChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const presence = useChatPresence(chatId, active && !error);
  const listRef = useRef<HTMLDivElement | null>(null);
  const openedFor = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Opening is idempotent: the server returns the existing thread when
      // there is one and creates it only the first time.
      const opened = await api.post<{ chatId: string }>('/api/chats/open', { orderId });
      setChatId(opened.chatId);
      const [msgs, me] = await Promise.all([
        api.get<{ messages: ChatMessage[] }>(`/api/chats/${opened.chatId}/messages`),
        api.get<{ user: { id: string } }>('/api/auth/me'),
      ]);
      setMessages(msgs.messages || []);
      setMeId(me.user?.id ?? null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  // Open the thread the first time the tab is actually shown — creating a
  // chat row for every order an admin merely glances at would litter the
  // customer's chat list with empty conversations.
  useEffect(() => {
    if (!active || openedFor.current === orderId) return;
    openedFor.current = orderId;
    load();
  }, [active, orderId, load]);

  // Scroll the MESSAGE LIST, not the element into view. scrollIntoView walks
  // every scrollable ancestor, and this panel lives inside the admin page's
  // own scroll container — so jumping to the newest message scrolled the page
  // behind the modal and dragged the modal itself off the bottom of the
  // screen. Setting scrollTop touches this list and nothing else.
  useEffect(() => {
    if (!active) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, active]);

  const send = async () => {
    const body = draft.trim();
    if (!body || !chatId || sending) return;
    presence.onStop();
    setSending(true);
    setSendError(null);
    try {
      await api.post(`/api/chats/${chatId}/messages`, { kind: 'text', body });
      setDraft('');
      const msgs = await api.get<{ messages: ChatMessage[] }>(`/api/chats/${chatId}/messages`);
      setMessages(msgs.messages || []);
    } catch (e) {
      // The draft is deliberately KEPT so a failed send does not lose what
      // the admin typed.
      setSendError(e instanceof ApiError ? e.message : loc('تعذّر الإرسال', 'Could not send', 'نەنێردرا'));
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center py-16">
        <Spinner size="md" />
      </div>
    );
  }
  if (error != null) {
    return (
      <div className="p-4">
        <ErrorState error={error} onRetry={load} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div ref={listRef} className="flex-1 overflow-y-auto p-4 space-y-2 min-h-0" data-order-chat>
        {messages.length === 0 && (
          <p className="text-center text-sm text-zinc-500 py-10">
            {loc(
              'لا رسائل بعد — اكتب أول رسالة بخصوص هذا الطلب.',
              'No messages yet — write the first one about this order.',
              'هێشتا هیچ نامەیەک نییە — یەکەم نامە دەربارەی ئەم داواکارییە بنووسە.'
            )}
          </p>
        )}
        {messages.map((m) => {
          const mine = m.sender_id === meId;
          return (
            <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[75%] rounded-2xl px-3.5 py-2 text-sm ${
                  mine ? 'bg-olive text-white' : 'bg-zinc-800 text-zinc-100'
                }`}
              >
                {m.kind === 'image' && m.url ? (
                  <img src={m.url} alt="" className="rounded-lg max-w-full" referrerPolicy="no-referrer" />
                ) : (
                  <span className="whitespace-pre-wrap break-words">{m.body}</span>
                )}
                <span className="block text-[10px] opacity-60 mt-1">
                  {new Date(m.created_at).toLocaleString()}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="border-t border-zinc-800 p-3 shrink-0">
        {presence.typing && <p role="status" className="text-xs text-text-secondary mb-2">{loc('يكتب الآن…', 'Typing…', 'دەنووسێت…')}</p>}
        {sendError && <p className="text-[12px] text-red-400 mb-2">{sendError}</p>}
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => { setDraft(e.target.value); presence.onEdit(e.target.value); }}
            onBlur={presence.onStop}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={1}
            data-order-chat-input
            placeholder={loc('اكتب رسالة…', 'Write a message…', 'نامەیەک بنووسە…')}
            className="flex-1 min-h-[44px] max-h-32 resize-y bg-zinc-900 border border-zinc-700 rounded-xl px-3 py-2.5 text-sm text-white placeholder-zinc-500 focus:border-olive outline-none"
          />
          <button
            type="submit"
            disabled={!draft.trim() || sending}
            data-order-chat-send
            className="w-11 h-11 shrink-0 rounded-xl bg-olive text-white flex items-center justify-center disabled:opacity-40 hover:bg-olive-light transition-colors"
            aria-label={loc('إرسال', 'Send', 'ناردن')}
          >
            {sending ? <Spinner size="sm" /> : <Send className="w-4 h-4" />}
          </button>
        </form>
      </div>
    </div>
  );
}
