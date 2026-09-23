import { useChatPresence } from '../../lib/useChatPresence';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Paperclip, Send } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api, ApiError, uploadFile } from '../../lib/api';
import Spinner from '../ui/Spinner';
import { ErrorState } from '../ui/AsyncStates';

/**
 * `fileUrl`, AND THAT NAME IS THE WHOLE OF A BUG THIS PANEL SHIPPED WITH.
 *
 * This interface declared `url`. The server has always sent `fileUrl`
 * (worker/routes/chats.ts, `GET /:id/messages`), so `m.url` was `undefined`
 * for every picture that ever reached this screen, the `kind === 'image' &&
 * m.url` branch never ran, and an image message fell through to the text
 * branch — which rendered `m.body`, the EMPTY STRING an attachment-only
 * message stores. The customer sent a photograph of the thing they meant and
 * the admin packing the box saw a blank bubble with a timestamp. With
 * strictNullChecks off nothing warned about it, and no test looked at a
 * rendered bubble.
 */
interface ChatMessage {
  id: string;
  sender_id: string;
  kind: 'text' | 'image';
  body: string;
  created_at: string;
  fileUrl?: string | null;
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
 *
 * ---------------------------------------------------------------------------
 *  ATTACHMENTS: CAMERA AND FILE. THERE IS NO MICROPHONE, AND THAT IS NOT AN
 *  OVERSIGHT.
 * ---------------------------------------------------------------------------
 * «كاميرا/ملف/صوت». Two of the three are here, and they are one code path:
 * both inputs hand a `File` to `uploadFile(file, 'chat', chatId)`, which files
 * it under the CONVERSATION — the owner's own ordering, «الثاني الاسهل في فتح
 * المحادثه» — and the send then names the stored key. The camera input is the
 * same picker with `capture`, because on a phone that is the difference
 * between "take a photo of the damaged box" and "go find it in your gallery",
 * and on a desktop the attribute is simply ignored.
 *
 * A VOICE NOTE CANNOT BE STORED BY THIS SCHEMA. `chat_messages.kind` carries
 * `CHECK (kind IN ('text','image'))` from migrations/0001_init.sql:306, and
 * SQLite cannot alter a CHECK without rewriting the table — which this project
 * does not do to live rows. `worker/routes/uploads.ts` would refuse the bytes
 * first in any case: it sniffs magic numbers and admits images and MP4 only,
 * so a WebM or M4A recording is «Unsupported file type» before it reaches the
 * message. Both halves are outside this screen and both would have to change
 * together; a microphone button that produced a red line on every tap would be
 * a worse answer than none, and a voice note silently stored as `kind='image'`
 * would be a lie in the database. It is reported as BLOCKED rather than faked.
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
  const [attaching, setAttaching] = useState(false);
  const presence = useChatPresence(chatId, active && !error);
  const listRef = useRef<HTMLDivElement | null>(null);
  const openedFor = useRef<string | null>(null);
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

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

  /**
   * ONE PATH FOR BOTH BUTTONS: upload, then send the KEY.
   *
   * THE INPUT IS CLEARED FIRST (`e.target.value = ''`), before any await. A
   * file input fires no `change` when the same file is picked twice, so an
   * upload that failed could not be retried with the same photograph without
   * this — the admin taps, nothing happens, and there is nothing on screen to
   * explain why.
   *
   * THE REFUSAL IS SHOWN AS THE SERVER WROTE IT. An iPhone HEIC photograph has
   * its own sentence in three languages, and «تعذّر الإرسال» in place of it
   * would hide the one instruction that fixes it (export as JPEG).
   */
  const attach = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !chatId || attaching) return;
    setAttaching(true);
    setSendError(null);
    try {
      const uploaded = await uploadFile(file, 'chat', chatId);
      await api.post(`/api/chats/${chatId}/messages`, { kind: 'image', fileKey: uploaded.key });
      const msgs = await api.get<{ messages: ChatMessage[] }>(`/api/chats/${chatId}/messages`);
      setMessages(msgs.messages || []);
    } catch (err) {
      setSendError(
        err instanceof ApiError ? err.message : loc('تعذّر إرسال الصورة', 'Could not send the image') /* OWNER: Sorani by hand; loc() falls back to ar. */
      );
    } finally {
      setAttaching(false);
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
                {m.kind === 'image' && m.fileUrl ? (
                  <a href={m.fileUrl} target="_blank" rel="noopener noreferrer">
                    {/* Tapping opens the full object. The bubble is 75% of a
                        modal column, which is too small to read a serial
                        number or a damaged corner off. */}
                    <img
                      src={m.fileUrl}
                      alt={loc('صورة مرفقة', 'Attached image') /* OWNER: Sorani by hand. */}
                      className="rounded-lg max-w-full"
                      referrerPolicy="no-referrer"
                    />
                  </a>
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
          {/* HIDDEN INPUTS, VISIBLE BUTTONS. A bare `<input type="file">`
              cannot be styled to 44px or given an Arabic label — the browser
              writes «Choose file» in its own language — so the input carries
              the behaviour and the button carries the label. `capture` is what
              makes the first one open the camera on a phone; a desktop browser
              ignores the attribute and shows the ordinary picker, which is the
              right fallback rather than a button that does nothing. */}
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            data-order-chat-camera
            onChange={attach}
          />
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            data-order-chat-file
            onChange={attach}
          />
          <button
            type="button"
            disabled={attaching || sending}
            onClick={() => cameraRef.current?.click()}
            data-order-chat-camera-button
            title={loc('التقاط صورة', 'Take a photo') /* OWNER: Sorani by hand. */}
            aria-label={loc('التقاط صورة', 'Take a photo') /* OWNER: Sorani by hand. */}
            className="w-11 h-11 shrink-0 rounded-xl border border-zinc-700 text-zinc-300 flex items-center justify-center disabled:opacity-40 hover:bg-zinc-800 transition-colors"
          >
            {attaching ? <Spinner size="sm" /> : <Camera className="w-4 h-4" aria-hidden />}
          </button>
          <button
            type="button"
            disabled={attaching || sending}
            onClick={() => fileRef.current?.click()}
            data-order-chat-attach
            title={loc('إرفاق ملف', 'Attach a file') /* OWNER: Sorani by hand. */}
            aria-label={loc('إرفاق ملف', 'Attach a file') /* OWNER: Sorani by hand. */}
            className="w-11 h-11 shrink-0 rounded-xl border border-zinc-700 text-zinc-300 flex items-center justify-center disabled:opacity-40 hover:bg-zinc-800 transition-colors"
          >
            <Paperclip className="w-4 h-4" aria-hidden />
          </button>
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
