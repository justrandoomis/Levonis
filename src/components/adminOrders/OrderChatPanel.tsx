import { useChatPresence } from '../../lib/useChatPresence';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Mic, Paperclip, Send, X } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { api, ApiError, uploadFile } from '../../lib/api';
import { formatElapsed, useVoiceRecorder } from '../../lib/voiceRecorder';
import ChatAttachment, { attachmentErrorText, attachmentKindOfFile, CHAT_FILE_ACCEPT, isAttachmentKind } from '../chat/ChatAttachment';
import Spinner from '../ui/Spinner';
import { ErrorState } from '../ui/AsyncStates';
import { mergeThread, pollWhileVisible } from '../../lib/supportThread';

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
  /** The attachment's real kind when there is one (worker/routes/chats.ts
   *  `chatMessagePublic`), else 'text'. */
  kind: 'text' | 'image' | 'video' | 'audio' | 'file';
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
 *  ATTACHMENTS: CAMERA, FILE AND VOICE — «كاميرا/ملف/بصمة صوتية»
 * ---------------------------------------------------------------------------
 * All three are one code path: a `File` goes to `uploadFile(file, 'chat',
 * chatId)`, which files it under the CONVERSATION — the owner's own ordering,
 * «الثاني الاسهل في فتح المحادثه» — and the send then names the stored key.
 *
 *  * CAMERA is the picker with `capture`, because on a phone that is the
 *    difference between "take a photo of the damaged box" and "go find it in
 *    your gallery"; on a desktop the attribute is simply ignored.
 *  * FILE takes a picture, a clip, an audio file or a PDF — what the upload
 *    route admits by magic bytes (`sniffChat`), and nothing it would refuse.
 *  * VOICE is recorded here (src/lib/voiceRecorder.ts): tap to record, the
 *    elapsed time while it runs, ✕ to throw it away, send to upload it. It is
 *    stored as what it is — migration 0110's `attachment_kind = 'audio'` —
 *    never disguised as an image, which is why this was blocked until that
 *    column existed. Where the browser has no recorder, no microphone is drawn.
 *
 * The server says what each attachment IS (the folder the upload was sniffed
 * into), and `ChatAttachment` draws it: a picture, a player, or a document
 * link. The customer's /chats page renders through the same component.
 */
const CHAT_POLL_MS = 8_000;

export default function OrderChatPanel({ orderId, active }: { orderId: string; active: boolean }) {
  const { loc, lang } = useLanguage();
  const voice = useVoiceRecorder();
  const [chatId, setChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  // A MERCHANT-STORE order's thread is the customer's and the seller's: staff
  // READ it (audited on the server) and never join or write (audit 04 B6).
  const [readOnly, setReadOnly] = useState(false);
  const presence = useChatPresence(readOnly ? null : chatId, active && !error && !readOnly);
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
      const opened = await api.post<{ chatId: string | null; readOnly?: boolean }>('/api/chats/open', { orderId });
      setReadOnly(!!opened.readOnly);
      setChatId(opened.chatId);
      if (!opened.chatId) {
        // A store order whose customer and seller have not talked yet: there
        // is nothing to read, and staff do not start their conversation.
        setMessages([]);
        return;
      }
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

  /**
   * THE OPEN THREAD REFRESHES ITSELF. Without this a customer line that
   * arrived while the admin had the thread open (the order modal, or the
   * support console's «الرسائل») stayed invisible until somebody went back
   * and reopened it — and because this GET is what stamps `last_read_at`,
   * it also stayed counted as unread. Silent, only while the tab is shown
   * and the page visible, merged by id so a reply being sent is not lost.
   */
  useEffect(() => {
    if (!active || !chatId || error != null) return;
    return pollWhileVisible(() => {
      api
        .get<{ messages: ChatMessage[] }>(`/api/chats/${chatId}/messages`, { mascot: 'silent' })
        .then((d) => setMessages((prev) => mergeThread(prev, d.messages || [])))
        .catch(() => {});
    }, CHAT_POLL_MS);
  }, [active, chatId, error]);

  /**
   * THE REPLY IS APPENDED, NOT RE-FETCHED. The send route answers with the
   * stored message in the read path's own shape, so the thread grows by one
   * bubble instead of reloading every message behind a spinner. A server that
   * predates that answer still gets the old full re-read.
   */
  const appendSent = async (res: { message?: ChatMessage }) => {
    if (res && res.message && res.message.id) {
      const sent = res.message;
      setMessages((prev) => (prev.some((m) => m.id === sent.id) ? prev : [...prev, sent]));
      return;
    }
    const msgs = await api.get<{ messages: ChatMessage[] }>(`/api/chats/${chatId}/messages`);
    setMessages(msgs.messages || []);
  };

  const send = async () => {
    const body = draft.trim();
    if (!body || !chatId || sending) return;
    presence.onStop();
    setSending(true);
    setSendError(null);
    try {
      const res = await api.post<{ message?: ChatMessage }>(`/api/chats/${chatId}/messages`, { kind: 'text', body });
      setDraft('');
      await appendSent(res);
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
  const sendFile = async (file: File) => {
    if (!chatId || attaching) return;
    setAttaching(true);
    setSendError(null);
    try {
      const uploaded = await uploadFile(file, 'chat', chatId);
      // The kind is a HINT; the server reads the real one from where it filed
      // the bytes.
      const res = await api.post<{ message?: ChatMessage }>(`/api/chats/${chatId}/messages`, {
        kind: attachmentKindOfFile(file),
        fileKey: uploaded.key,
      });
      await appendSent(res);
    } catch (err) {
      setSendError(
        attachmentErrorText(err, loc('تعذّر إرسال المرفق', 'Could not send the attachment')) /* OWNER: Sorani by hand; loc() falls back to ar. */
      );
    } finally {
      setAttaching(false);
    }
  };

  const attach = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await sendFile(file);
  };

  /** The microphone: the first tap records, send uploads it, ✕ discards it. */
  const startVoice = async () => {
    if (!chatId || attaching || sending) return;
    setSendError(null);
    await voice.start();
  };
  const sendVoice = async () => {
    const file = await voice.stop();
    if (file) await sendFile(file);
  };
  const voiceError =
    voice.error === 'denied'
      ? loc('لم يُسمح باستخدام الميكروفون — فعّله من إعدادات المتصفح.', 'Microphone access was refused — allow it in the browser settings.')
      : voice.error === 'failed'
        ? loc('تعذّر بدء التسجيل الصوتي.', 'The voice recording could not start.')
        : null;

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
            {readOnly
              ? loc(
                  'لم يتراسل الزبون والمتجر بخصوص هذا الطلب بعد.',
                  'The customer and the store have not written about this order yet.'
                ) /* OWNER: Sorani to be written by hand. */
              : loc(
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
                {isAttachmentKind(m.kind) && m.fileUrl ? (
                  <>
                    <ChatAttachment kind={m.kind} url={m.fileUrl} loc={loc} />
                    {m.body && <span className="mt-1 block whitespace-pre-wrap break-words">{m.body}</span>}
                  </>
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

      {readOnly ? (
        <p data-order-chat-read-only className="border-t border-zinc-800 p-3 shrink-0 text-center text-xs text-zinc-400">
          {loc(
            'للقراءة فقط — محادثة بين الزبون والمتجر. لا تنضم الإدارة إليها، وكل اطلاع عليها يُسجَّل.',
            'Read-only — a conversation between the customer and the store. Staff do not join it, and every view is recorded.'
          ) /* OWNER: Sorani to be written by hand. */}
        </p>
      ) : (
      <div className="border-t border-zinc-800 p-3 shrink-0">
        {presence.typing && <p role="status" className="text-xs text-text-secondary mb-2">{loc('يكتب الآن…', 'Typing…', 'دەنووسێت…')}</p>}
        {(sendError || voiceError) && <p className="text-[12px] text-red-400 mb-2">{sendError || voiceError}</p>}
        {voice.recording ? (
          /* RECORDING REPLACES THE COMPOSER, so there is one thing to do: send
             it or throw it away. The time runs so the admin can see the
             microphone is live. */
          <div className="flex items-center gap-2" data-order-chat-recording>
            <button
              type="button"
              onClick={voice.cancel}
              data-order-chat-voice-cancel
              aria-label={loc('إلغاء التسجيل', 'Discard the recording')}
              title={loc('إلغاء التسجيل', 'Discard the recording')}
              className="w-11 h-11 shrink-0 rounded-xl border border-zinc-700 text-zinc-300 flex items-center justify-center hover:bg-zinc-800 transition-colors"
            >
              <X className="w-4 h-4" aria-hidden />
            </button>
            <p role="status" aria-live="polite" className="flex-1 flex items-center gap-2 text-sm text-zinc-200">
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" aria-hidden />
              {loc('جارٍ التسجيل', 'Recording')}{' '}
              <span className="tabular-nums" dir="ltr">
                {formatElapsed(voice.elapsed, lang === 'en')}
              </span>
            </p>
            <button
              type="button"
              onClick={sendVoice}
              data-order-chat-voice-send
              aria-label={loc('إرسال الرسالة الصوتية', 'Send the voice message')}
              className="w-11 h-11 shrink-0 rounded-xl bg-olive text-white flex items-center justify-center hover:bg-olive-light transition-colors"
            >
              <Send className="w-4 h-4 rtl:-scale-x-100" aria-hidden />
            </button>
          </div>
        ) : (
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
            accept={CHAT_FILE_ACCEPT}
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
          {voice.supported && (
            <button
              type="button"
              disabled={attaching || sending}
              onClick={startVoice}
              data-order-chat-voice
              title={loc('تسجيل رسالة صوتية', 'Record a voice message')}
              aria-label={loc('تسجيل رسالة صوتية', 'Record a voice message')}
              className="w-11 h-11 shrink-0 rounded-xl border border-zinc-700 text-zinc-300 flex items-center justify-center disabled:opacity-40 hover:bg-zinc-800 transition-colors"
            >
              <Mic className="w-4 h-4" aria-hidden />
            </button>
          )}
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
        )}
      </div>
      )}
    </div>
  );
}
