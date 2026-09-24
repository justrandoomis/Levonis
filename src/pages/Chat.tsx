import { useChatPresence } from '../lib/useChatPresence';
import { mascot } from '../lib/mascot';
import { MotionCharacterHome, useCharacterBusy } from '../components/bloub/MotionCharacterAnchor';
import React, { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import { useThreadScroll } from '../lib/supportThread';
import { mergeNewestPage, prependOlder } from '../lib/chatPaging';
import { useNavigate, useParams } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { api, ApiError, uploadFile } from '../lib/api';
import { formatElapsed, useVoiceRecorder } from '../lib/voiceRecorder';
import ChatAttachment, {
  attachmentErrorText,
  attachmentKindOfFile,
  CHAT_FILE_ACCEPT,
  isAttachmentKind,
  type ChatAttachmentKind,
} from '../components/chat/ChatAttachment';
import {
  ArrowLeft, ArrowRight, Mic, Smile, Plus, X, FileText,
  Image as ImageIcon, Camera, Store as StoreIcon, Gift, MapPin, UserCircle, Wallet, Send, MessageSquare
} from 'lucide-react';

/** 'text', or the attachment's real kind (worker/routes/chats.ts `chatMessagePublic`). */
type MessageKind = 'text' | ChatAttachmentKind;

interface ChatMessage {
  id: string;
  sender_id: string;
  mine: boolean;
  kind: MessageKind;
  body: string | null;
  fileUrl: string | null;
  created_at: string;
}

interface PendingMessage {
  tempId: string;
  serverId: string | null;
  kind: MessageKind;
  body: string | null;
  fileUrl: string | null;
  created_at: string;
  failed: boolean;
}

interface ChatListItem {
  id: string;
  other_username: string | null;
  other_name: string | null;
}

function formatMsgTime(iso: string, lang: string): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return '';
  const locale = lang === 'ar' ? 'ar' : lang === 'ku' ? 'ckb' : 'en-US';
  return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

export default function Chat() {
  const navigate = useNavigate();
  const { id } = useParams();
  const { dir, lang, loc } = useLanguage();
  const { user } = useAuth();

  const [isPlusMenuOpen, setIsPlusMenuOpen] = useState(false);
  const [inputText, setInputText] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // Attachment feedback (a denied location prompt, a lookup in progress).
  // Separate from sendError: that one is about a message the server refused.
  const [actionNotice, setActionNotice] = useState('');
  const [otherName, setOtherName] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  // THE THREAD IN PAGES (audit 04 B5): the newest page first, older ones on
  // the way up. `olderCursor` is where the next older page starts, or null
  // when the whole thread is on screen.
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);
  // Staff reading a merchant↔customer thread they are not part of: the
  // server answers it READ-ONLY, and so does the screen.
  const [readOnly, setReadOnly] = useState(false);
  const pagedBack = useRef(false);
  const prependAnchor = useRef<{ height: number; top: number } | null>(null);

  const presence = useChatPresence(id, !!user && !notFound);
  // «بصمة صوتية» — the microphone that used to say «قريباً».
  const voice = useVoiceRecorder();
  useCharacterBusy(loading || uploading);
  const seenRemote = useRef<{ chat: string | undefined; ids: Set<string> | null }>({ chat: id, ids: null });
  useEffect(() => { seenRemote.current = { chat: id, ids: null }; }, [id]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const tempCounter = useRef(0);

  const comingSoon = dir === 'rtl' ? 'قريباً' : 'Coming soon';
  const emojis = ['😀','😂','😅','😍','😊','😎','🤔','😭','👍','🙏','❤️','🔥','✨','🎉','💯'];

  // The newest message stays in view — but only for a reader who is AT the
  // bottom, and never by `scrollIntoView` (which walked every scrollable
  // ancestor and yanked a reader who had scrolled up). The same hook the
  // support threads use (src/lib/supportThread.ts).
  useThreadScroll(listRef, id ?? '', messages.length + pending.length, pending.length > 0);

  // An older page lands ABOVE what the reader is looking at: keep their place
  // by moving the scroll position down by exactly the height it added.
  useLayoutEffect(() => {
    const el = listRef.current;
    const anchor = prependAnchor.current;
    if (!el || !anchor) return;
    prependAnchor.current = null;
    el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
  }, [messages]);

  const fetchMessages = useCallback(async () => {
    if (!id) return;
    try {
      const data = await api.get<{ messages: ChatMessage[]; older_cursor?: string | null; read_only?: boolean }>(
        `/api/chats/${id}/messages`,
        { mascot: 'silent' }
      );
      if (seenRemote.current.chat !== id) return;
      const page = data.messages || [];
      const remoteIds = new Set(page.filter(m => !m.mine).map(m => m.id));
      if (seenRemote.current.ids && [...remoteIds].some(messageId => !seenRemote.current.ids!.has(messageId))) mascot.trigger('notify');
      seenRemote.current.ids = remoteIds;
      const hasOlder = !!data.older_cursor;
      let reset = false;
      setMessages((prev) => {
        const merged = mergeNewestPage(prev, page, hasOlder);
        reset = merged.reset;
        return merged.messages;
      });
      // Until the reader pages back, the cursor follows the newest page; after
      // that it is theirs — unless the poll had to restart the list.
      if (!pagedBack.current || reset) {
        pagedBack.current = false;
        setOlderCursor(data.older_cursor ?? null);
      }
      setReadOnly(!!data.read_only);
      // Drop optimistic messages the server now knows about.
      const serverIds = new Set(page.map((m) => m.id));
      setPending((prev) => prev.filter((p) => !(p.serverId && serverIds.has(p.serverId))));
      setNotFound(false);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        setNotFound(true);
      } else if (err instanceof ApiError && err.status === 401) {
        navigate('/auth');
      }
      // transient network errors: keep the current view
    }
  }, [id, navigate]);

  /** The page before the oldest one on screen — on scroll-up, or the button. */
  const loadOlder = useCallback(async () => {
    if (!id || !olderCursor || loadingOlder) return;
    setLoadingOlder(true);
    setOlderFailed(false);
    try {
      const data = await api.get<{ messages: ChatMessage[]; older_cursor?: string | null }>(
        `/api/chats/${id}/messages?before=${encodeURIComponent(olderCursor)}`,
        { mascot: 'silent' }
      );
      if (seenRemote.current.chat !== id) return;
      const el = listRef.current;
      prependAnchor.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
      pagedBack.current = true;
      setMessages((prev) => prependOlder(prev, data.messages || []));
      setOlderCursor(data.older_cursor ?? null);
    } catch {
      setOlderFailed(true);
    } finally {
      setLoadingOlder(false);
    }
  }, [id, olderCursor, loadingOlder]);

  // Near the top of the thread, fetch the page above before the reader hits it.
  const onListScroll = useCallback(() => {
    const el = listRef.current;
    if (el && el.scrollTop < 120 && olderCursor && !loadingOlder && !olderFailed) void loadOlder();
  }, [olderCursor, loadingOlder, olderFailed, loadOlder]);

  // Initial load + 5s polling while mounted.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMessages([]);
    setPending([]);
    setNotFound(false);
    setOlderCursor(null);
    setOlderFailed(false);
    setReadOnly(false);
    pagedBack.current = false;
    fetchMessages().finally(() => {
      if (!cancelled) setLoading(false);
    });
    const interval = setInterval(() => {
      if (!document.hidden) fetchMessages();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [fetchMessages]);

  // The other participant's name comes from the chat list.
  useEffect(() => {
    let cancelled = false;
    api
      .get<{ chats: ChatListItem[] }>('/api/chats')
      .then((data) => {
        if (cancelled) return;
        const chat = (data.chats || []).find((c) => c.id === id);
        if (chat) setOtherName(chat.other_name || chat.other_username || null);
      })
      .catch(() => {
        /* the header just shows nothing if the list fails */
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const nextTempId = () => {
    tempCounter.current += 1;
    return `temp-${Date.now()}-${tempCounter.current}`;
  };

  const sendText = async (text: string) => {
    const body = text.trim();
    if (!body || !id) return;
    presence.onStop();
    setSendError(null);
    const tempId = nextTempId();
    setPending((prev) => [
      ...prev,
      { tempId, serverId: null, kind: 'text', body, fileUrl: null, created_at: new Date().toISOString(), failed: false },
    ]);
    setInputText('');
    setShowEmojiPicker(false);
    setIsPlusMenuOpen(false);
    try {
      const res = await api.post<{ id: string }>(`/api/chats/${id}/messages`, { kind: 'text', body });
      setPending((prev) => prev.map((p) => (p.tempId === tempId ? { ...p, serverId: res.id } : p)));
    } catch (err) {
      setPending((prev) => prev.filter((p) => p.tempId !== tempId));
      setInputText(body);
      setSendError(
        (err instanceof ApiError && err.message) || (dir === 'rtl' ? 'تعذر إرسال الرسالة' : 'Failed to send message')
      );
    }
  };

  const handleSendMessage = () => {
    sendText(inputText);
  };

  /**
   * ONE PATH FOR EVERY ATTACHMENT — a photo, a clip, a document or a voice
   * note. The bubble appears at once from the local file and is replaced by
   * the server's copy on the next poll; the kind sent is only a hint, the
   * server reads the real one from where it filed the bytes.
   */
  const sendAttachment = async (file: File) => {
    if (!id || uploading) return;
    setSendError(null);
    setUploading(true);
    const tempId = nextTempId();
    const kind = attachmentKindOfFile(file);
    const localUrl = URL.createObjectURL(file);
    setPending((prev) => [
      ...prev,
      { tempId, serverId: null, kind, body: null, fileUrl: localUrl, created_at: new Date().toISOString(), failed: false },
    ]);
    try {
      // The conversation, not the sender: a chat file is filed under the chat
      // so one thread's pictures sit in one folder, and the server checks that
      // this account is in it before storing anything.
      const uploaded = await uploadFile(file, 'chat', id);
      const res = await api.post<{ id: string }>(`/api/chats/${id}/messages`, { kind, fileKey: uploaded.key });
      setPending((prev) => prev.map((p) => (p.tempId === tempId ? { ...p, serverId: res.id } : p)));
    } catch (err) {
      setPending((prev) => prev.filter((p) => p.tempId !== tempId));
      setSendError(
        attachmentErrorText(err, dir === 'rtl' ? 'تعذر إرسال المرفق' : 'Failed to send the attachment')
      );
    } finally {
      setUploading(false);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    setIsPlusMenuOpen(false);
    if (!file) return;
    await sendAttachment(file);
  };

  /** Tap the microphone to record; ✕ throws it away, send uploads it. */
  const startVoice = async () => {
    if (!id || uploading) return;
    setSendError(null);
    setIsPlusMenuOpen(false);
    setShowEmojiPicker(false);
    presence.onStop();
    await voice.start();
  };
  const sendVoice = async () => {
    const file = await voice.stop();
    if (file) await sendAttachment(file);
  };
  const voiceError =
    voice.error === 'denied'
      ? dir === 'rtl' ? 'لم يُسمح باستخدام الميكروفون — فعّله من إعدادات المتصفح' : 'Microphone access was refused — allow it in your browser settings'
      : voice.error === 'failed'
        ? dir === 'rtl' ? 'تعذّر بدء التسجيل الصوتي' : 'The voice recording could not start'
        : '';

  const suggestions = dir === 'rtl' ? [
    "شكراً 🙏", "تمام 👍", "كم السعر؟", "متى يكون جاهزاً؟"
  ] : [
    "Thanks 🙏", "Sounds good 👍", "How much is it?", "When will it be ready?"
  ];

  /**
   * Shares where the sender is, as a maps link.
   *
   * Geolocation needs the browser's permission and a secure origin, and it
   * fails for perfectly ordinary reasons — a denied prompt, no GPS indoors,
   * a timeout. Every one of those gets its own message rather than a silent
   * no-op: a button that appears to do nothing is worse than one that says
   * why it could not.
   */
  const shareLocation = async () => {
    if (!navigator.geolocation) {
      setActionNotice(dir === 'rtl' ? 'المتصفح لا يدعم تحديد الموقع' : 'This browser cannot share a location');
      return;
    }
    setActionNotice(dir === 'rtl' ? 'جارٍ تحديد الموقع…' : 'Finding your location…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        setActionNotice('');
        // Coordinates, not an address: a reverse-geocoded street name would
        // be a guess, and a driver needs the pin.
        void sendText(`https://maps.google.com/?q=${latitude.toFixed(6)},${longitude.toFixed(6)}`);
      },
      (err) => {
        setActionNotice(
          err.code === err.PERMISSION_DENIED
            ? dir === 'rtl' ? 'رُفض إذن الموقع' : 'Location permission was denied'
            : dir === 'rtl' ? 'تعذّر تحديد الموقع' : 'Your location could not be determined'
        );
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  };

  /**
   * Sends the sender's card.
   *
   * ONLY A LINK THAT EXISTS. There is no public `/u/:username` route in this
   * app, so linking to one would put a 404 in someone's conversation — the
   * exact kind of thing that looks finished and is not. A merchant gets their
   * real store link; everyone else gets their name and handle as plain text,
   * which is what a card is when there is no page behind it.
   */
  const sendProfileCard = async () => {
    const name = (user?.name || user?.username || '').trim();
    let link = '';
    try {
      // The endpoint answers { merchant: null } for someone with no store,
      // which is not an error — it is the common case.
      const mine = await api.get<{ merchant: { id?: string } | null }>('/api/community/my-store');
      const storeId = mine?.merchant?.id ?? '';
      if (storeId) link = `${window.location.origin}/community/store/${storeId}`;
    } catch {
      /* no store, or not reachable — the card is still worth sending */
    }
    const handle = user?.username ? ` (@${user.username})` : '';
    await sendText(link ? `${name}${handle}\n${link}` : `${name}${handle}`.trim() || (dir === 'rtl' ? 'بطاقتي' : 'My card'));
  };

  const plusMenuOptions: Array<{ icon: any; label: string; onClick?: () => void; disabled?: boolean }> = [
    {
      icon: ImageIcon,
      label: dir === 'rtl' ? 'الألبوم' : 'Album',
      onClick: () => fileInputRef.current?.click(),
    },
    {
      icon: Camera,
      label: dir === 'rtl' ? 'تصوير' : 'Camera',
      onClick: () => cameraInputRef.current?.click(),
    },
    // A document or an audio file — «ملف». The server admits PDFs and sound
    // by magic bytes (worker/routes/uploads.ts `sniffChat`).
    {
      icon: FileText,
      label: dir === 'rtl' ? 'ملف' : 'File',
      onClick: () => documentInputRef.current?.click(),
    },
    // Three of these were disabled with "قريباً" on them and did not need to
    // be: each is a message with a link in it, which the existing pipeline
    // already sends. They are sent as ordinary text so the other side reads
    // them on any client, including a notification.
    {
      icon: StoreIcon,
      label: dir === 'rtl' ? 'المتجر' : 'Store',
      onClick: () => void sendText(`${window.location.origin}/products`),
    },
    {
      icon: MapPin,
      label: dir === 'rtl' ? 'الموقع' : 'Location',
      onClick: () => void shareLocation(),
    },
    {
      icon: UserCircle,
      label: dir === 'rtl' ? 'بطاقة شخصية' : 'Profile Card',
      onClick: () => void sendProfileCard(),
    },
    // These two MOVE MONEY between users. That is not a missing button, it is
    // a policy the owner has not set — eligibility, limits, reversal, and
    // what happens when a transfer is disputed. Left visibly off rather than
    // built on assumptions about someone else's money.
    { icon: Gift, label: dir === 'rtl' ? `مغلف أحمر (${comingSoon})` : `Red Envelope (${comingSoon})`, disabled: true },
    { icon: Wallet, label: dir === 'rtl' ? `إرسال أموال (${comingSoon})` : `Send Money (${comingSoon})`, disabled: true },
  ];

  if (notFound) {
    return (
      <div className="h-full min-h-0 w-full bg-canvas flex flex-col items-center justify-center gap-4 p-8 font-sans">
        <MessageSquare className="w-14 h-14 text-text-muted opacity-60" strokeWidth={1} />
        <p className="max-w-md text-text-secondary text-center leading-relaxed">
          {dir === 'rtl' ? 'المحادثة غير موجودة أو لا يمكنك الوصول إليها' : 'Conversation not found or you do not have access to it'}
        </p>
        <button
          type="button"
          onClick={() => navigate('/chats')}
          className="lv-button lv-button-secondary"
        >
          {dir === 'rtl' ? 'رجوع إلى المحادثات' : 'Back to Chats'}
        </button>
      </div>
    );
  }

  const myInitial = (user?.name || user?.username || '?').charAt(0).toUpperCase();
  const otherInitial = (otherName || '?').charAt(0).toUpperCase();

  const renderBubble = (kind: MessageKind, body: string | null, fileUrl: string | null, mine: boolean, faded = false) => {
    if ((kind === 'audio' || kind === 'video' || kind === 'file') && fileUrl) {
      // A voice note, a clip or a document, drawn by the same component the
      // admin's order panel uses — so what one side sends, the other can play.
      return (
        <div
          className={`${mine ? 'bg-surface-selected ltr:rounded-tr-sm rtl:rounded-tl-sm' : 'bg-surface ltr:rounded-tl-sm rtl:rounded-tr-sm'} rounded-lg max-w-[min(80%,24rem)] mt-1 p-2 text-[14px] text-text-primary ${faded ? 'opacity-60' : ''}`}
        >
          <ChatAttachment kind={kind} url={fileUrl} loc={loc} />
          {body && <p dir="auto" className="mt-1 px-1 whitespace-pre-wrap break-words">{body}</p>}
        </div>
      );
    }
    if (isAttachmentKind(kind)) {
      return (
        <div className={`${mine ? 'ltr:rounded-tr-sm rtl:rounded-tl-sm' : 'ltr:rounded-tl-sm rtl:rounded-tr-sm'} rounded-lg max-w-[min(76%,24rem)] mt-1 overflow-hidden bg-surface ${faded ? 'opacity-60' : ''}`}>
          {fileUrl ? (
            <img referrerPolicy="no-referrer" src={fileUrl} alt="" className="w-full h-auto object-cover max-h-[300px]" />
          ) : (
            <div className="w-40 h-28 bg-surface-raised flex items-center justify-center">
              <ImageIcon className="w-6 h-6 text-text-muted" />
            </div>
          )}
        </div>
      );
    }
    return (
      <div
        dir="auto"
        className={`${mine ? 'bg-surface-selected text-text-primary ltr:rounded-tr-sm rtl:rounded-tl-sm' : 'bg-surface text-text-primary ltr:rounded-tl-sm rtl:rounded-tr-sm'} px-3.5 py-2.5 rounded-lg text-[14px] sm:text-[15px] leading-relaxed max-w-[min(80%,34rem)] mt-1 whitespace-pre-wrap break-words ${faded ? 'opacity-60' : ''}`}
      >
        {body}
      </div>
    );
  };

  const renderAvatar = (mine: boolean) => (
    <div className="w-8 h-8 rounded-full bg-surface-raised flex items-center justify-center shrink-0 overflow-hidden">
      <span className="text-xs font-bold text-text-secondary">{mine ? myInitial : otherInitial}</span>
    </div>
  );

  return (
    <div data-chat-layout className="h-full min-h-0 w-full bg-canvas flex flex-col font-sans text-text-secondary">
      <input type="file" accept="image/*" className="hidden" ref={fileInputRef} onChange={handleFileSelect} />
      <input type="file" accept="image/*" capture="environment" className="hidden" ref={cameraInputRef} onChange={handleFileSelect} />
      <input type="file" accept={CHAT_FILE_ACCEPT} className="hidden" ref={documentInputRef} onChange={handleFileSelect} data-chat-document-input />

      {/* Header */}
      <header className="lv-character-header shrink-0 bg-canvas px-3 sm:px-4 py-2 items-center border-b border-border-subtle/70">
        <div className="flex items-center gap-3">
          <button
            type="button"
            aria-label={dir === 'rtl' ? 'رجوع' : 'Back'}
            onClick={() => navigate(-1)}
            className="min-w-11 min-h-11 -ms-2 rounded-md inline-flex items-center justify-center hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus text-text-primary"
          >
            {dir === 'rtl' ? <ArrowRight className="w-5 h-5" strokeWidth={2} /> : <ArrowLeft className="w-5 h-5" strokeWidth={2} />}
          </button>
          <div className="flex flex-col">
            <h1 className="font-bold text-base sm:text-lg leading-tight text-text-primary">
              {otherName || (dir === 'rtl' ? 'محادثة' : 'Chat')}
            </h1>
          </div>
        </div>
        <MotionCharacterHome busy={loading} />
        <span role="status" aria-live="polite" className="text-xs text-text-secondary">
          {presence.typing ? loc('يكتب الآن…', 'Typing…', 'دەنووسێت…') : ''}
        </span>
      </header>

      {/* Chat Area */}
      <div
        ref={listRef}
        data-chat-messages
        onScroll={onListScroll}
        style={{ overflowAnchor: 'none' }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 sm:px-5 py-4 flex flex-col gap-4 scroll-pb-6"
        onClick={() => { setIsPlusMenuOpen(false); setShowEmojiPicker(false); }}
      >
        {loading ? (
          <div role="status" className="flex-1 flex flex-col items-center justify-center gap-3 text-text-muted">
            <div className="w-5 h-5 border-2 border-text-muted border-t-transparent rounded-full animate-spin" />
            <span className="text-xs">{dir === 'rtl' ? 'جارٍ تحميل المحادثة…' : 'Loading conversation…'}</span>
          </div>
        ) : messages.length === 0 && pending.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-text-muted gap-2 px-6 text-center">
            <MessageSquare className="w-12 h-12 opacity-40" strokeWidth={1} />
            <p className="text-sm">{dir === 'rtl' ? 'لا توجد رسائل بعد — ابدأ المحادثة' : 'No messages yet — say hello'}</p>
          </div>
        ) : (
          <>
            {/* The way up. Scrolling near the top fetches it on its own; the
                button is the same action for a keyboard, a screen reader or a
                failed fetch — never a gesture-only control. */}
            {(olderCursor || loadingOlder) && (
              <div className="flex justify-center" data-chat-older>
                <button
                  type="button"
                  onClick={() => { setOlderFailed(false); void loadOlder(); }}
                  disabled={loadingOlder}
                  aria-busy={loadingOlder}
                  className="lv-button lv-button-ghost lv-button-sm"
                >
                  {loadingOlder
                    ? loc('جارٍ تحميل الرسائل الأقدم…', 'Loading earlier messages…')
                    : olderFailed
                      ? loc('تعذّر التحميل — حاول مجددًا', 'Could not load — try again')
                      : loc('عرض الرسائل الأقدم', 'Show earlier messages')}
                  {/* OWNER: Sorani to be written by hand. */}
                </button>
              </div>
            )}
            {messages.map((msg, index) => {
              const time = formatMsgTime(msg.created_at, lang);
              const prevTime = index > 0 ? formatMsgTime(messages[index - 1].created_at, lang) : null;
              return (
                <React.Fragment key={msg.id}>
                  {(index === 0 || prevTime !== time) && (
                    <div className="text-center text-[11px] text-text-muted font-medium tracking-wide">{time}</div>
                  )}
                  <div className={`flex items-start gap-2 ${msg.mine ? 'justify-end' : ''}`}>
                    {!msg.mine && renderAvatar(false)}
                    {renderBubble(msg.kind, msg.body, msg.fileUrl, msg.mine)}
                    {msg.mine && renderAvatar(true)}
                  </div>
                </React.Fragment>
              );
            })}
            {pending.map((msg) => (
              <div key={msg.tempId} className="flex items-start gap-2 justify-end" aria-label={dir === 'rtl' ? 'جارٍ الإرسال' : 'Sending'}>
                {renderBubble(msg.kind, msg.body, msg.fileUrl, true, true)}
                {renderAvatar(true)}
              </div>
            ))}
          </>
        )}
        {(sendError || voiceError) && (
          <div role="alert" className="lv-alert lv-alert-danger self-center text-xs">{sendError || voiceError}</div>
        )}
        {actionNotice && (
          <div role="status" className="text-center text-xs text-text-muted font-medium">{actionNotice}</div>
        )}
      </div>

      {/* A thread this viewer may read but not write in (staff on a
          merchant↔customer order thread): no composer, and it says why. */}
      {readOnly && (
        <div data-chat-read-only className="shrink-0 border-t border-border-subtle/70 bg-surface px-4 py-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] text-center text-xs text-text-secondary">
          {loc(
            'للقراءة فقط — هذه محادثة بين الزبون والمتجر، وكل اطلاع عليها يُسجَّل.',
            'Read-only — this conversation is between the customer and the store, and every view of it is recorded.'
          )}
          {/* OWNER: Sorani to be written by hand. */}
        </div>
      )}

      {/* Bottom Area */}
      {!readOnly && (
      <div data-chat-composer className="relative z-10 shrink-0 bg-surface border-t border-border-subtle/70 pb-[max(env(safe-area-inset-bottom),0.5rem)]">

        {/* Emoji choices remain part of the composer flow. They can expand
            the control but never cover the last message or sit behind it. */}
        {showEmojiPicker && (
          <div className="px-3 sm:px-4 py-3 border-b border-border-subtle/60 max-h-[28dvh] overflow-y-auto">
            <div className="flex flex-wrap gap-1.5 justify-between" aria-label={dir === 'rtl' ? 'الرموز التعبيرية' : 'Emoji'}>
              {emojis.map((emoji, i) => (
                <button
                  type="button"
                  key={i}
                  className="min-w-11 min-h-11 rounded-md text-xl hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  onClick={() => setInputText(prev => prev + emoji)}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Suggestions */}
        {!showEmojiPicker && (
          <div data-chat-suggestions className="flex overflow-x-auto overscroll-x-contain px-3 sm:px-4 py-2 gap-2 hide-scrollbar w-full" aria-label={dir === 'rtl' ? 'ردود سريعة' : 'Quick replies'}>
            {suggestions.map((s, i) => (
              <button
                type="button"
                key={i}
                onClick={() => sendText(s)}
                className="whitespace-nowrap min-h-9 bg-surface-raised px-3 py-1.5 rounded-full text-xs text-text-secondary font-semibold hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {/* Input Bar */}
        {voice.recording ? (
          /* RECORDING REPLACES THE BAR: one thing to do — send it, or throw it
             away — and the running time says the microphone is live. */
          <div data-chat-recording className="px-3 sm:px-4 py-2 flex items-center gap-2">
            <button
              type="button"
              onClick={voice.cancel}
              aria-label={dir === 'rtl' ? 'إلغاء التسجيل' : 'Discard the recording'}
              className="min-w-11 min-h-11 inline-flex items-center justify-center rounded-md text-text-secondary hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <X className="w-5 h-5" strokeWidth={1.5} />
            </button>
            <p role="status" aria-live="polite" className="flex-1 min-h-11 flex items-center gap-2 text-sm text-text-primary">
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" aria-hidden="true" />
              {dir === 'rtl' ? 'جارٍ التسجيل' : 'Recording'}
              <span className="tabular-nums" dir="ltr">{formatElapsed(voice.elapsed, lang === 'en')}</span>
            </p>
            <button
              type="button"
              onClick={sendVoice}
              aria-label={dir === 'rtl' ? 'إرسال الرسالة الصوتية' : 'Send the voice message'}
              data-mascot="send"
              className="min-w-11 min-h-11 inline-flex items-center justify-center text-[#101114] bg-[#ece8dc] rounded-md hover:bg-[#fffaf0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <Send className="w-4 h-4 rtl:-scale-x-100" strokeWidth={2.2} />
            </button>
          </div>
        ) : (
        <div className="px-3 sm:px-4 py-2 flex items-end gap-2">
          {/* A browser with no recorder gets no microphone, rather than one
              that fails on every tap. */}
          {voice.supported && (
            <button
              type="button"
              disabled={uploading}
              onClick={startVoice}
              data-chat-voice
              aria-label={dir === 'rtl' ? 'تسجيل رسالة صوتية' : 'Record a voice message'}
              title={dir === 'rtl' ? 'تسجيل رسالة صوتية' : 'Record a voice message'}
              className="min-w-11 min-h-11 inline-flex items-center justify-center rounded-md text-text-secondary hover:text-text-primary hover:bg-surface-raised disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <Mic className="w-5 h-5" strokeWidth={1.5} />
            </button>
          )}

          <div className="flex-1 min-h-11 bg-surface-raised rounded-lg flex items-center px-3 border border-border-subtle relative">
            <input
              type="text"
              value={inputText}
              onChange={(e) => { setInputText(e.target.value); presence.onEdit(e.target.value); }}
              onBlur={presence.onStop}
              onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
              placeholder={dir === 'rtl' ? 'اكتب رسالة...' : 'Type a message...'}
              aria-label={dir === 'rtl' ? 'نص الرسالة' : 'Message text'}
              className="min-w-0 flex-1 bg-transparent border-none outline-none text-[15px] h-11 text-text-primary placeholder:text-text-muted"
            />

            <button
              type="button"
              aria-label={dir === 'rtl' ? 'الرموز التعبيرية' : 'Emoji'}
              aria-expanded={showEmojiPicker}
              className={`${showEmojiPicker ? 'text-gold' : 'text-text-secondary'} min-w-10 min-h-10 inline-flex items-center justify-center hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus rounded-md ms-1`}
              onClick={() => {
                setShowEmojiPicker(!showEmojiPicker);
                setIsPlusMenuOpen(false);
              }}
            >
              <Smile className="w-5 h-5" strokeWidth={1.5} />
            </button>
          </div>

          {inputText.trim() ? (
             <button
               type="button"
               aria-label={dir === 'rtl' ? 'إرسال الرسالة' : 'Send message'}
               data-mascot="send"
               className="min-w-11 min-h-11 inline-flex items-center justify-center text-[#101114] bg-[#ece8dc] rounded-md hover:bg-[#fffaf0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
               onClick={handleSendMessage}
             >
               <Send className="w-4 h-4 rtl:-scale-x-100" strokeWidth={2.2} />
             </button>
          ) : (
            <button
              type="button"
              data-chat-plus
              data-mascot="upload"
              aria-label={dir === 'rtl' ? 'إرفاق' : 'Attach'}
              aria-expanded={isPlusMenuOpen}
              className="min-w-11 min-h-11 inline-flex items-center justify-center rounded-md text-text-primary hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus relative"
              onClick={() => {
                setIsPlusMenuOpen(!isPlusMenuOpen);
                setShowEmojiPicker(false);
              }}
            >
              <div className={`transition-transform duration-200 ${isPlusMenuOpen ? 'rotate-45' : 'rotate-0'}`}>
                <Plus className="w-5 h-5" strokeWidth={1.5} />
              </div>
            </button>
          )}
        </div>
        )}

        {/* Plus Menu Grid */}
        {isPlusMenuOpen && (
          <div className="px-3 sm:px-4 py-4 grid grid-cols-4 gap-y-4 gap-x-2 bg-surface max-h-[min(42dvh,21rem)] overflow-y-auto animate-in slide-in-from-bottom-2 fade-in duration-200">
            {plusMenuOptions.map((opt, idx) => (
              <button
                type="button"
                key={idx}
                onClick={opt.disabled ? undefined : opt.onClick}
                disabled={opt.disabled || (uploading && !opt.disabled)}
                className={`min-h-20 rounded-md flex flex-col items-center justify-center gap-1.5 group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${opt.disabled ? 'cursor-not-allowed opacity-40' : 'hover:bg-surface-raised'}`}
              >
                <div className="w-10 h-10 bg-surface-raised rounded-md flex items-center justify-center">
                  <opt.icon className="w-5 h-5 text-text-primary" strokeWidth={1.5} />
                </div>
                <span className="text-[11px] text-text-muted text-center leading-tight line-clamp-2">{opt.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      )}
    </div>
  );
}
