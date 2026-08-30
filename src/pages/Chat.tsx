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
  const { dir, lang } = useLanguage();
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
      const data = await api.get<{ messages: ChatMessage[] }>(`/api/chats/${id}/messages`);
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
      fetchMessages();
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
      <div className="w-full bg-[#f2f2f2] dark:bg-[#000000] min-h-screen flex flex-col items-center justify-center gap-4 p-8 font-sans">
        <MessageSquare className="w-16 h-16 text-[#999] opacity-50" strokeWidth={1} />
        <p className="text-[#666] dark:text-[#999] text-center">
          {dir === 'rtl' ? 'المحادثة غير موجودة أو لا يمكنك الوصول إليها' : 'Conversation not found or you do not have access to it'}
        </p>
        <button
          onClick={() => navigate('/chats')}
          className="bg-white dark:bg-[#1a1a1a] border border-black/5 dark:border-white/10 text-black dark:text-white rounded-full px-6 py-2.5 font-bold shadow-sm hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
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
        <div className={`${mine ? 'ltr:rounded-tr-sm rtl:rounded-tl-sm' : 'ltr:rounded-tl-sm rtl:rounded-tr-sm'} rounded-2xl shadow-sm max-w-[65%] mt-1 overflow-hidden border border-black/5 dark:border-white/5 ${faded ? 'opacity-60' : ''}`}>
          {fileUrl ? (
            <img referrerPolicy="no-referrer" src={fileUrl} alt="" className="w-full h-auto object-cover max-h-[300px]" />
          ) : (
            <div className="w-40 h-28 bg-zinc-200 dark:bg-zinc-800 flex items-center justify-center">
              <ImageIcon className="w-6 h-6 text-zinc-400" />
            </div>
          )}
        </div>
      );
    }
    return (
      <div className={`${mine ? 'bg-[#FFF0D6] dark:bg-[#3d3119] text-black dark:text-[#fde2b4] ltr:rounded-tr-sm rtl:rounded-tl-sm' : 'bg-white dark:bg-[#1a1a1a] text-black dark:text-white ltr:rounded-tl-sm rtl:rounded-tr-sm'} px-4 py-3 rounded-2xl text-[15px] shadow-sm max-w-[75%] mt-1 whitespace-pre-wrap break-words ${faded ? 'opacity-60' : ''}`}>
        {body}
      </div>
    );
  };

  const renderAvatar = (mine: boolean) => (
    <div className="w-10 h-10 rounded-full bg-zinc-200 dark:bg-zinc-800 flex items-center justify-center shrink-0 overflow-hidden border border-black/5 dark:border-white/5">
      <span className="text-sm font-bold text-black dark:text-white">{mine ? myInitial : otherInitial}</span>
    </div>
  );

  return (
    <div className="w-full bg-[#f2f2f2] dark:bg-[#000000] min-h-screen flex flex-col font-sans text-[#333] dark:text-[#ccc]">
      <input type="file" accept="image/*" className="hidden" ref={fileInputRef} onChange={handleFileSelect} />
      <input type="file" accept="image/*" capture="environment" className="hidden" ref={cameraInputRef} onChange={handleFileSelect} />

      {/* Header */}
      <div className="fixed top-0 left-0 right-0 z-50 bg-[#f2f2f2] dark:bg-[#000000] px-4 py-2 flex items-center justify-between border-b border-black/5 dark:border-white/5">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="p-2 -ms-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition-colors text-black dark:text-white">
            {dir === 'rtl' ? <ArrowRight className="w-6 h-6" strokeWidth={2} /> : <ArrowLeft className="w-6 h-6" strokeWidth={2} />}
          </button>
          <div className="flex flex-col">
            <h1 className="font-bold text-lg leading-tight text-black dark:text-white">
              {otherName || (dir === 'rtl' ? 'محادثة' : 'Chat')}
            </h1>
          </div>
        </div>
      </div>

      {/* Chat Area */}
      <div className="flex-1 overflow-y-auto px-4 pt-20 pb-[160px] flex flex-col gap-6" onClick={() => { setIsPlusMenuOpen(false); setShowEmojiPicker(false); }}>
        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="w-6 h-6 border-2 border-[#ff5000] border-t-transparent rounded-full animate-spin"></div>
          </div>
        ) : messages.length === 0 && pending.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-[#999] gap-2">
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
                    <div className="text-center text-[11px] text-[#999] font-medium tracking-wide">{time}</div>
                  )}
                  <div className={`flex items-start gap-3 ${msg.mine ? 'justify-end' : ''}`}>
                    {!msg.mine && renderAvatar(false)}
                    {renderBubble(msg.kind, msg.body, msg.fileUrl, msg.mine)}
                    {msg.mine && renderAvatar(true)}
                  </div>
                </React.Fragment>
              );
            })}
            {pending.map((msg) => (
              <div key={msg.tempId} className="flex items-start gap-3 justify-end">
                {renderBubble(msg.kind, msg.body, msg.fileUrl, true, true)}
                {renderAvatar(true)}
              </div>
            ))}
          </>
        )}
        {sendError && (
          <div className="text-center text-[11px] text-red-500 font-medium">{sendError}</div>
        )}
        {actionNotice && (
          <div role="status" className="text-center text-[11px] text-[#999] font-medium">{actionNotice}</div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Bottom Area */}
      <div className="fixed bottom-0 left-0 right-0 z-40 bg-[#f7f7f7] dark:bg-[#0a0a0a] border-t border-black/5 dark:border-white/5 pb-safe transition-all duration-300">

        {/* Emoji Picker Overlay */}
        {showEmojiPicker && (
          <div className="px-4 py-3 bg-white dark:bg-[#1a1a1a] border-b border-black/5 dark:border-white/5">
            <div className="flex flex-wrap gap-2 justify-between">
              {emojis.map((emoji, i) => (
                <button key={i} className="text-2xl hover:scale-110 transition-transform" onClick={() => setInputText(prev => prev + emoji)}>
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Suggestions */}
        {!showEmojiPicker && (
          <div className="flex overflow-x-auto px-4 py-3 gap-2.5 hide-scrollbar w-full">
            {suggestions.map((s, i) => (
              <button
                key={i}
                onClick={() => sendText(s)}
                className="whitespace-nowrap bg-white dark:bg-[#1a1a1a] border border-black/5 dark:border-white/10 px-3.5 py-1.5 rounded-full text-[13px] text-black dark:text-white shadow-sm font-medium hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {/* Input Bar */}
        <div className="px-4 py-2.5 flex items-center gap-3">
          {/* Voice messages have no backend yet — shown honestly as disabled. */}
          <button
            disabled
            title={dir === 'rtl' ? 'الرسائل الصوتية قريباً' : `Voice messages ${comingSoon.toLowerCase()}`}
            className="text-zinc-400 dark:text-zinc-600 cursor-not-allowed"
          >
            <Mic className="w-6 h-6" strokeWidth={1.5} />
          </button>

          <div className="flex-1 bg-white dark:bg-[#1a1a1a] rounded-full h-10 flex items-center px-4 border border-black/5 dark:border-white/5 shadow-sm relative overflow-hidden">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
              placeholder={dir === 'rtl' ? 'اكتب رسالة...' : 'Type a message...'}
              className="flex-1 bg-transparent border-none outline-none text-[15px] h-full text-black dark:text-white"
            />

            <button
              className={`${showEmojiPicker ? 'text-[#ff5000]' : 'text-black dark:text-white'} hover:opacity-70 transition-colors ms-2`}
              onClick={() => {
                setShowEmojiPicker(!showEmojiPicker);
                setIsPlusMenuOpen(false);
              }}
            >
              <Smile className="w-6 h-6" strokeWidth={1.5} />
            </button>
          </div>

          {inputText.trim() ? (
             <button className="text-white bg-[#ff5000] p-1.5 rounded-full hover:opacity-90 transition-opacity" onClick={handleSendMessage}>
               <Send className="w-4 h-4 rtl:-scale-x-100" strokeWidth={2} />
             </button>
          ) : (
            <button
              data-chat-plus
              aria-label={dir === 'rtl' ? 'إرفاق' : 'Attach'}
              aria-expanded={isPlusMenuOpen}
              className="text-black dark:text-white hover:opacity-70 transition-transform duration-300 relative"
              onClick={() => {
                setIsPlusMenuOpen(!isPlusMenuOpen);
                setShowEmojiPicker(false);
              }}
            >
              <div className={`transition-transform duration-300 ${isPlusMenuOpen ? 'rotate-45' : 'rotate-0'}`}>
                <Plus className="w-6 h-6" strokeWidth={1.5} />
              </div>
            </button>
          )}
        </div>

        {/* Plus Menu Grid */}
        {isPlusMenuOpen && (
          <div className="px-4 py-6 grid grid-cols-4 gap-y-6 gap-x-4 bg-[#f7f7f7] dark:bg-[#0a0a0a] animate-in slide-in-from-bottom-5 fade-in duration-300">
            {plusMenuOptions.map((opt, idx) => (
              <button
                key={idx}
                onClick={opt.disabled ? undefined : opt.onClick}
                disabled={opt.disabled || (uploading && !opt.disabled)}
                className={`flex flex-col items-center gap-2 group ${opt.disabled ? 'cursor-not-allowed opacity-40' : ''}`}
              >
                <div className={`w-[60px] h-[60px] bg-white dark:bg-[#1a1a1a] rounded-2xl flex items-center justify-center shadow-sm border border-black/5 dark:border-white/5 ${opt.disabled ? '' : 'group-hover:scale-95 transition-transform'}`}>
                  <opt.icon className="w-7 h-7 text-black dark:text-white" strokeWidth={1.5} />
                </div>
                <span className="text-[11px] text-[#666] dark:text-[#999] text-center leading-tight">{opt.label}</span>
              </button>
            ))}
          </div>
        )}

        {!isPlusMenuOpen && <div className="h-4"></div>}
      </div>
    </div>
  );
}
