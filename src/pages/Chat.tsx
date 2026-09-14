import { useChatPresence } from '../lib/useChatPresence';
import { mascot } from '../lib/mascot';
import { MotionCharacterHome, useCharacterBusy } from '../components/bloub/MotionCharacterAnchor';
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { api, ApiError, uploadFile } from '../lib/api';
import {
  ArrowLeft, ArrowRight, Mic, Smile, Plus,
  Image as ImageIcon, Camera, Store as StoreIcon, Gift, MapPin, UserCircle, Wallet, Send, MessageSquare
} from 'lucide-react';

interface ChatMessage {
  id: string;
  sender_id: string;
  mine: boolean;
  kind: 'text' | 'image';
  body: string | null;
  fileUrl: string | null;
  created_at: string;
}

interface PendingMessage {
  tempId: string;
  serverId: string | null;
  kind: 'text' | 'image';
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

  const presence = useChatPresence(id, !!user && !notFound);
  useCharacterBusy(loading || uploading);
  const seenRemote = useRef<{ chat: string | undefined; ids: Set<string> | null }>({ chat: id, ids: null });
  useEffect(() => { seenRemote.current = { chat: id, ids: null }; }, [id]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const tempCounter = useRef(0);

  const comingSoon = dir === 'rtl' ? 'قريباً' : 'Coming soon';
  const emojis = ['😀','😂','😅','😍','😊','😎','🤔','😭','👍','🙏','❤️','🔥','✨','🎉','💯'];

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages.length, pending.length]);

  const fetchMessages = useCallback(async () => {
    if (!id) return;
    try {
      const data = await api.get<{ messages: ChatMessage[] }>(`/api/chats/${id}/messages`, { mascot: 'silent' });
      if (seenRemote.current.chat !== id) return;
      const remoteIds = new Set((data.messages || []).filter(m => !m.mine).map(m => m.id));
      if (seenRemote.current.ids && [...remoteIds].some(messageId => !seenRemote.current.ids!.has(messageId))) mascot.trigger('notify');
      seenRemote.current.ids = remoteIds;
      setMessages(data.messages || []);
      // Drop optimistic messages the server now knows about.
      const serverIds = new Set((data.messages || []).map((m) => m.id));
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

  // Initial load + 5s polling while mounted.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMessages([]);
    setPending([]);
    setNotFound(false);
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

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    setIsPlusMenuOpen(false);
    if (!file || !id || uploading) return;
    setSendError(null);
    setUploading(true);
    const tempId = nextTempId();
    const localUrl = URL.createObjectURL(file);
    setPending((prev) => [
      ...prev,
      { tempId, serverId: null, kind: 'image', body: null, fileUrl: localUrl, created_at: new Date().toISOString(), failed: false },
    ]);
    try {
      const uploaded = await uploadFile(file, 'chat');
      const res = await api.post<{ id: string }>(`/api/chats/${id}/messages`, { kind: 'image', fileKey: uploaded.key });
      setPending((prev) => prev.map((p) => (p.tempId === tempId ? { ...p, serverId: res.id } : p)));
    } catch (err) {
      setPending((prev) => prev.filter((p) => p.tempId !== tempId));
      setSendError(
        (err instanceof ApiError && err.message) || (dir === 'rtl' ? 'تعذر إرسال الصورة' : 'Failed to send image')
      );
    } finally {
      setUploading(false);
    }
  };

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

  const renderBubble = (kind: 'text' | 'image', body: string | null, fileUrl: string | null, mine: boolean, faded = false) => {
    if (kind === 'image') {
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
        data-chat-messages
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
        {sendError && (
          <div role="alert" className="lv-alert lv-alert-danger self-center text-xs">{sendError}</div>
        )}
        {actionNotice && (
          <div role="status" className="text-center text-xs text-text-muted font-medium">{actionNotice}</div>
        )}
        <div ref={messagesEndRef} className="h-px shrink-0" aria-hidden="true" />
      </div>

      {/* Bottom Area */}
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
        <div className="px-3 sm:px-4 py-2 flex items-end gap-2">
          {/* Voice messages have no backend yet — shown honestly as disabled. */}
          <button
            type="button"
            disabled
            aria-label={dir === 'rtl' ? 'الرسائل الصوتية غير متاحة بعد' : 'Voice messages are not available yet'}
            title={dir === 'rtl' ? 'الرسائل الصوتية قريباً' : `Voice messages ${comingSoon.toLowerCase()}`}
            className="min-w-11 min-h-11 inline-flex items-center justify-center text-text-muted opacity-45 cursor-not-allowed"
          >
            <Mic className="w-5 h-5" strokeWidth={1.5} />
          </button>

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
               className="min-w-11 min-h-11 inline-flex items-center justify-center text-[#101114] bg-[#ece8dc] rounded-md hover:bg-[#fffaf0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
               onClick={handleSendMessage}
             >
               <Send className="w-4 h-4 rtl:-scale-x-100" strokeWidth={2.2} />
             </button>
          ) : (
            <button
              type="button"
              data-chat-plus
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
    </div>
  );
}
