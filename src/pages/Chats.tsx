/**
 * Chats (integrated mandate §8).
 *
 * The two support entries at the top are PERMANENT: they render before the
 * list loads, when the list is empty, when it fails, and for a signed-out
 * visitor. They are the only guaranteed way into support from this screen.
 *
 *  1. «المساعد الآلي» → /support — the existing deterministic assistant
 *     (rules + the viewer's own data). No AI service, no promise of one.
 *  2. «تواصل مع الدعم» → the REAL ticket flow on /api/support/tickets.
 *     Re-tapping never files a second ticket: the sheet first reads the
 *     viewer's tickets and, when one is still open (state ≠ resolved), it
 *     reuses that ticket and appends a message instead of creating another.
 *     A single in-flight guard also blocks a double tap in the same tick.
 *
 * The list states are DISTINCT and never conflated: loading, empty, network
 * failure, expired session (401) and other errors each say what happened.
 * Staff availability is never faked — no invented "online" agent and no
 * invented working hours; the honest line is that the message is recorded as
 * a ticket the team sees.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { api, ApiError } from '../lib/api';
import { classifyError, ErrorState, EmptyState, UnauthorizedState } from '../components/ui/AsyncStates';
import { Sheet } from '../components/ui/Overlay';
import { Search, MessageSquare, X, Bot, LifeBuoy, ChevronLeft, ChevronRight, Send, Loader2 } from 'lucide-react';

const STRINGS = {
  ar: {
    title: 'مركز المحادثات',
    search: 'بحث في المحادثات...', searchOpen: 'فتح البحث', searchClose: 'إغلاق البحث',
    assistant: 'المساعد الآلي', assistantDesc: 'إجابات فورية من بيانات حسابك وسياسات المتجر',
    contact: 'تواصل مع الدعم', contactDesc: 'تذكرة حقيقية يراها فريق الدعم',
    noChats: 'لا توجد محادثات بعد',
    noChatsDesc: 'ابدأ من مدخلي الدعم أعلاه، أو راسل تاجرًا من صفحة متجره.',
    noResults: 'لا توجد نتائج',
    guestTitle: 'سجّل الدخول لعرض محادثاتك',
    guestDesc: 'مدخلا الدعم أعلاه يعملان قبل الدخول؛ قائمة المحادثات الخاصة بك تحتاج جلسة.',
    signIn: 'تسجيل الدخول',
    user: 'مستخدم', noMessages: 'لا توجد رسائل بعد',
    sheetTitle: 'تواصل مع الدعم',
    close: 'إغلاق',
    checking: 'نتحقق من تذاكرك المفتوحة…',
    openTicket: 'لديك تذكرة مفتوحة',
    ticketState: 'الحالة',
    stateOpen: 'مفتوحة', stateWaitingStaff: 'بانتظار الدعم',
    stateWaitingCustomer: 'بانتظار ردك', stateResolved: 'مغلقة',
    reuseNote: 'سنضيف رسالتك إلى هذه التذكرة بدل فتح تذكرة جديدة.',
    subject: 'الموضوع', subjectPh: 'مثال: استفسار عن حالة طلبي',
    message: 'الرسالة', messagePh: 'اشرح المشكلة بالتفصيل…',
    subjectShort: 'الموضوع قصير جدًا (٣ أحرف على الأقل).',
    messageShort: 'الرسالة قصيرة جدًا (٥ أحرف على الأقل).',
    create: 'إنشاء تذكرة دعم', send: 'إرسال الرسالة', sending: 'جارٍ الإرسال…',
    created: 'تم إنشاء التذكرة',
    sent: 'أُرسلت رسالتك إلى الدعم',
    viewTickets: 'عرض التذاكر في صفحة الدعم',
    honesty: 'لا نعرض حالة اتصال الموظفين. رسالتك تُسجَّل كتذكرة مع وقتها وتظهر لفريق الدعم؛ يمكنك ترك رسالتك الآن والرد يصلك هنا وفي صفحة الدعم.',
    noMoney: 'الدعم عبر المحادثة لا يعتمد إضافة رصيد أو سحبًا أو استرجاعًا ماليًا — تلك تمر بمسارها المصرّح في المحفظة.',
    signInFirst: 'سجّل الدخول لفتح تذكرة دعم.',
  },
  en: {
    title: 'Chats',
    search: 'Search chats...', searchOpen: 'Open search', searchClose: 'Close search',
    assistant: 'Automated assistant', assistantDesc: 'Instant answers from your own data and store policies',
    contact: 'Contact support', contactDesc: 'A real ticket the support team sees',
    noChats: 'No chats yet',
    noChatsDesc: 'Start from the two support entries above, or message a merchant from their store page.',
    noResults: 'No results',
    guestTitle: 'Sign in to see your chats',
    guestDesc: 'Both support entries above work before signing in; your own chat list needs a session.',
    signIn: 'Sign in',
    user: 'User', noMessages: 'No messages yet',
    sheetTitle: 'Contact support',
    close: 'Close',
    checking: 'Checking your open tickets…',
    openTicket: 'You already have an open ticket',
    ticketState: 'State',
    stateOpen: 'Open', stateWaitingStaff: 'Waiting for support',
    stateWaitingCustomer: 'Waiting for you', stateResolved: 'Resolved',
    reuseNote: 'Your message is added to that ticket instead of opening a new one.',
    subject: 'Subject', subjectPh: 'e.g. Question about my order status',
    message: 'Message', messagePh: 'Describe the issue in detail…',
    subjectShort: 'Subject is too short (3 characters minimum).',
    messageShort: 'Message is too short (5 characters minimum).',
    create: 'Create support ticket', send: 'Send message', sending: 'Sending…',
    created: 'Ticket created',
    sent: 'Your message was sent to support',
    viewTickets: 'View tickets on the support page',
    honesty: 'We do not display staff presence. Your message is recorded as a timestamped ticket the support team sees; you can leave it now and the reply appears here and on the support page.',
    noMoney: 'Chat support never approves a top-up, withdrawal or refund — those go through the authorised wallet path.',
    signInFirst: 'Sign in to open a support ticket.',
  },
  ckb: {
    title: 'ناوەندی گفتوگۆ',
    search: 'گەڕان لە گفتوگۆکان...', searchOpen: 'کردنەوەی گەڕان', searchClose: 'داخستنی گەڕان',
    assistant: 'یاریدەدەری خۆکار', assistantDesc: 'وەڵامی خێرا لە داتای هەژمارەکەت و سیاسەتەکانی فرۆشگا',
    contact: 'پەیوەندی بە پشتگیری', contactDesc: 'تیکێتێکی ڕاستەقینە کە تیمی پشتگیری دەیبینێت',
    noChats: 'هێشتا گفتوگۆ نییە',
    noChatsDesc: 'لە دوو دەروازەی پشتگیری سەرەوە دەست پێبکە، یان لە پەڕەی فرۆشگا نامە بۆ فرۆشیار بنێرە.',
    noResults: 'هیچ ئەنجامێک نییە',
    guestTitle: 'بچۆ ژوورەوە بۆ بینینی گفتوگۆکانت',
    guestDesc: 'هەردوو دەروازەی پشتگیری پێش چوونەژوورەوە کار دەکەن؛ لیستی گفتوگۆکانت پێویستی بە دانیشتن هەیە.',
    signIn: 'چوونەژوورەوە',
    user: 'بەکارهێنەر', noMessages: 'هێشتا نامە نییە',
    sheetTitle: 'پەیوەندی بە پشتگیری',
    close: 'داخستن',
    checking: 'تیکێتە کراوەکانت دەپشکنین…',
    openTicket: 'تیکێتێکی کراوەت هەیە',
    ticketState: 'دۆخ',
    stateOpen: 'کراوە', stateWaitingStaff: 'چاوەڕوانی پشتگیری',
    stateWaitingCustomer: 'چاوەڕوانی تۆ', stateResolved: 'داخراوە',
    reuseNote: 'نامەکەت بۆ هەمان تیکێت زیاد دەکرێت، نەک تیکێتێکی نوێ.',
    subject: 'بابەت', subjectPh: 'نموونە: پرسیار دەربارەی دۆخی داواکارییەکەم',
    message: 'نامە', messagePh: 'کێشەکە بە وردی ڕوون بکەرەوە…',
    subjectShort: 'بابەت زۆر کورتە (لانیکەم ٣ پیت).',
    messageShort: 'نامە زۆر کورتە (لانیکەم ٥ پیت).',
    create: 'دروستکردنی تیکێتی پشتگیری', send: 'ناردنی نامە', sending: 'دەنێردرێت…',
    created: 'تیکێت دروستکرا',
    sent: 'نامەکەت بۆ پشتگیری نێردرا',
    viewTickets: 'بینینی تیکێتەکان لە پەڕەی پشتگیری',
    honesty: 'ئامادەبوونی ستاف پیشان نادەین. نامەکەت وەک تیکێتێکی کاتدار تۆمار دەکرێت کە تیمی پشتگیری دەیبینێت؛ دەتوانیت ئێستا بینێریت و وەڵامەکە لێرە و لە پەڕەی پشتگیری دەردەکەوێت.',
    noMoney: 'پشتگیری گفتوگۆ هەرگیز زیادکردنی باڵانس، دەرکردن یان گەڕاندنەوەی پارە پەسەند ناکات — ئەوانە ڕێگای ڕێپێدراوی جزدان دەگرن.',
    signInFirst: 'بچۆ ژوورەوە بۆ کردنەوەی تیکێتی پشتگیری.',
  },
} as const;

interface ChatListItem {
  id: string;
  last_message: string | null;
  last_at: string | null;
  unread: number;
  other_username: string | null;
  other_name: string | null;
}

interface Ticket {
  id: string;
  subject: string;
  state: 'open' | 'waiting_customer' | 'waiting_staff' | 'resolved' | string;
  created_at: string;
  updated_at: string;
}

function formatChatTime(iso: string | null, lang: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (isNaN(date.getTime())) return '';
  const now = new Date();
  const locale = lang === 'ar' ? 'ar' : lang === 'ckb' ? 'ckb' : 'en-US';
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function Chats() {
  const navigate = useNavigate();
  const { t, dir, lang } = useLanguage();
  const { isAuthenticated, isLoaded } = useAuth();
  const s = STRINGS[lang];

  const [chats, setChats] = useState<ChatListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [showSearch, setShowSearch] = useState(false);
  const [search, setSearch] = useState('');

  // ------------------------------------------------------- support sheet
  const [sheetOpen, setSheetOpen] = useState(false);
  const [ticketsLoading, setTicketsLoading] = useState(false);
  const [ticketsError, setTicketsError] = useState<unknown>(null);
  const [openTicket, setOpenTicket] = useState<Ticket | null>(null);
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const submitLock = useRef(false);
  const [done, setDone] = useState('');

  useEffect(() => {
    if (!isLoaded || !isAuthenticated) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    api
      .get<{ chats: ChatListItem[] }>('/api/chats')
      .then((data) => {
        if (!cancelled) setChats(data.chats || []);
      })
      .catch((err) => {
        // An expired session, a dropped connection and a server fault are
        // three different states — none of them is "you have no chats".
        if (!cancelled) setLoadError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isAuthenticated, retryToken]);

  /** Reads the viewer's tickets and reuses the open one (never creates here). */
  const loadOpenTicket = useCallback(async () => {
    setTicketsLoading(true);
    setTicketsError(null);
    try {
      const data = await api.get<{ tickets: Ticket[] }>('/api/support/tickets');
      const list = data.tickets || [];
      const live = list.find((tk) => tk.state !== 'resolved') ?? null;
      setOpenTicket(live);
    } catch (err) {
      setOpenTicket(null);
      setTicketsError(err);
    } finally {
      setTicketsLoading(false);
    }
  }, []);

  const openSupportSheet = () => {
    if (!isAuthenticated) {
      navigate(`/auth?next=${encodeURIComponent('/chats')}`);
      return;
    }
    setSheetOpen(true);
    setFormError('');
    setDone('');
    void loadOpenTicket();
  };

  const submitSupport = async () => {
    if (submitLock.current) return; // double-tap guard (same-tick safe)
    const body = message.trim();
    if (body.length < 5) {
      setFormError(s.messageShort);
      return;
    }
    if (!openTicket && subject.trim().length < 3) {
      setFormError(s.subjectShort);
      return;
    }
    submitLock.current = true;
    setSubmitting(true);
    setFormError('');
    try {
      if (openTicket) {
        // Reuse: one more message on the SAME ticket — no second ticket.
        await api.post(`/api/support/tickets/${openTicket.id}/messages`, { body });
        setDone(s.sent);
      } else {
        const res = await api.post<{ ticket: Ticket }>('/api/support/tickets', {
          confirm: true, // explicit confirmation step, required by the API
          source: 'manual',
          subject: subject.trim(),
          body,
        });
        setOpenTicket(res.ticket);
        setDone(`${s.created} · ${res.ticket.id}`);
      }
      setMessage('');
      setSubject('');
      // Re-read so the sheet shows the server's real state, not an assumption.
      await loadOpenTicket();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        navigate(`/auth?next=${encodeURIComponent('/chats')}`);
        return;
      }
      setFormError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  };

  const stateLabel = (state: string) =>
    state === 'waiting_staff'
      ? s.stateWaitingStaff
      : state === 'waiting_customer'
        ? s.stateWaitingCustomer
        : state === 'resolved'
          ? s.stateResolved
          : s.stateOpen;

  const q = search.trim().toLowerCase();
  const filtered = q
    ? chats.filter((c) => {
        const name = c.other_name || c.other_username || '';
        return name.toLowerCase().includes(q) || (c.last_message || '').toLowerCase().includes(q);
      })
    : chats;

  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;

  // ------------------------------------------------------------- list body
  let listBody: React.ReactNode;
  if (!isLoaded) {
    listBody = (
      <div className="flex items-center justify-center py-16">
        <Loader2 aria-hidden="true" className="w-6 h-6 animate-spin text-gold" />
      </div>
    );
  } else if (!isAuthenticated) {
    listBody = (
      <div className="px-4">
        <EmptyState
          icon={<MessageSquare aria-hidden="true" className="w-6 h-6" />}
          title={s.guestTitle}
          description={s.guestDesc}
          action={
            <Link
              to={`/auth?next=${encodeURIComponent('/chats')}`}
              className="mt-1 min-h-[44px] px-5 rounded-xl bg-gold text-black text-sm font-bold flex items-center"
            >
              {s.signIn}
            </Link>
          }
        />
      </div>
    );
  } else if (loading) {
    listBody = (
      <div className="flex items-center justify-center py-16">
        <Loader2 aria-hidden="true" className="w-6 h-6 animate-spin text-gold" />
      </div>
    );
  } else if (loadError) {
    listBody = (
      <div className="px-4">
        {classifyError(loadError) === 'unauthorized' ? (
          <UnauthorizedState next="/chats" />
        ) : (
          <ErrorState error={loadError} onRetry={() => setRetryToken((n) => n + 1)} next="/chats" />
        )}
      </div>
    );
  } else if (filtered.length === 0) {
    listBody = (
      <div className="px-4">
        <EmptyState
          icon={<MessageSquare aria-hidden="true" className="w-6 h-6" />}
          title={q ? s.noResults : s.noChats}
          description={q ? undefined : s.noChatsDesc}
        />
      </div>
    );
  } else {
    listBody = (
      <div className="flex flex-col">
        {filtered.map((chat) => {
          const name = chat.other_name || chat.other_username || s.user;
          return (
            <button
              key={chat.id}
              onClick={() => navigate(`/chat/${chat.id}`)}
              className="flex items-center gap-4 px-4 py-3 min-h-[64px] transition-colors border-b text-start w-full hover:bg-white/5 border-white/5"
            >
              <div className="relative">
                <div className="w-14 h-14 rounded-full flex items-center justify-center shrink-0 overflow-hidden border bg-zinc-800 border-white/5">
                  <span className="text-lg font-bold text-white">{name.charAt(0).toUpperCase()}</span>
                </div>
                {chat.unread > 0 && (
                  <span className="absolute top-0 end-0 bg-[#ff5000] text-white text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center border-2 border-canvas">
                    {chat.unread > 99 ? '99+' : chat.unread}
                  </span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex justify-between items-center mb-1">
                  <h3 className="text-[16px] font-bold truncate text-white">{name}</h3>
                  <span className="text-[12px] text-zinc-500 whitespace-nowrap ms-2">{formatChatTime(chat.last_at, lang)}</span>
                </div>
                <p className="text-[14px] truncate text-zinc-400">{chat.last_message || s.noMessages}</p>
              </div>
            </button>
          );
        })}
      </div>
    );
  }

  /*
    THIS PAGE IS DARK, FULL STOP — «صفحة المحادثات + صفحة الحساب بال light
    mode حل المشكلة».

    The app has no light theme and no theme switch: `html` is pinned
    `color-scheme: dark` and `#0b0c0f`, and every shared component is
    tokenised for that one ground. But this page and /profile were written
    as a hand-rolled light/dark PAIR — `bg-[#f2f2f2] dark:bg-[#000000]` —
    and Tailwind v4 with no config compiles `dark:` to
    `@media (prefers-color-scheme: dark)`. On a phone set to LIGHT the dark
    half simply evaporated: these two pages repainted themselves cream
    inside a permanently black app, with every shared component still
    painting dark on top. That is the grey-on-grey the owner photographed.

    The light half is gone rather than completed. There is no light theme
    to complete it into, and inventing one would be a new feature rather
    than a fix — so these pages now use the same tokens as the shell they
    live in, and read identically at every OS setting.
  */
  return (
    <div
      className="w-full min-h-screen flex flex-col font-sans bg-canvas text-text-secondary"
      dir={dir}
    >
      {/* Header */}
      <div className="sticky top-0 z-40 px-4 py-3 flex items-center justify-between border-b bg-canvas/95 backdrop-blur border-border-subtle/60">
        <h1 className="font-bold text-2xl text-white">{t('webCenter') || s.title}</h1>
        <button
          onClick={() => {
            setShowSearch((v) => !v);
            setSearch('');
          }}
          aria-label={showSearch ? s.searchClose : s.searchOpen}
          aria-expanded={showSearch}
          className="w-11 h-11 -me-2 flex items-center justify-center rounded-full transition-colors hover:bg-white/10 text-white"
        >
          {showSearch ? <X aria-hidden="true" className="w-6 h-6" /> : <Search aria-hidden="true" className="w-6 h-6" />}
        </button>
      </div>

      {showSearch && (
        <div className="px-4 py-2 border-b bg-canvas border-white/5">
          <input
            type="text"
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={s.search}
            aria-label={s.search}
            className="w-full min-h-[44px] border rounded-full py-2 px-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-gold bg-[#1a1a1a] border-white/10 text-white"
          />
        </div>
      )}

      {/* PERMANENT support entries — rendered before, during and after every
          list state, and for signed-out visitors too. */}
      <div className="px-4 pt-3 pb-1 flex flex-col gap-2">
        <button
          type="button"
          data-testid="chats-assistant"
          onClick={() => navigate('/support')}
          className="w-full min-h-[64px] flex items-center gap-3 rounded-2xl border px-4 py-3 text-start hover:border-gold/60 transition-colors border-zinc-800 bg-zinc-900/60"
        >
          <span className="w-11 h-11 rounded-xl bg-gold/15 border border-gold/30 flex items-center justify-center shrink-0">
            <Bot aria-hidden="true" className="w-5 h-5 text-gold" />
          </span>
          <span className="flex-1 min-w-0">
            <span className="block font-bold text-[15px] text-white">{s.assistant}</span>
            <span className="block text-[12px] truncate text-zinc-400">{s.assistantDesc}</span>
          </span>
          <Chevron aria-hidden="true" className="w-5 h-5 text-zinc-400 shrink-0" />
        </button>

        <button
          type="button"
          data-testid="chats-contact"
          onClick={openSupportSheet}
          className="w-full min-h-[64px] flex items-center gap-3 rounded-2xl border px-4 py-3 text-start hover:border-gold/60 transition-colors border-zinc-800 bg-zinc-900/60"
        >
          <span className="w-11 h-11 rounded-xl bg-olive/20 border border-olive/40 flex items-center justify-center shrink-0">
            <LifeBuoy aria-hidden="true" className="w-5 h-5 text-olive" />
          </span>
          <span className="flex-1 min-w-0">
            <span className="block font-bold text-[15px] text-white">{s.contact}</span>
            <span className="block text-[12px] truncate text-zinc-400">{s.contactDesc}</span>
          </span>
          <Chevron aria-hidden="true" className="w-5 h-5 text-zinc-400 shrink-0" />
        </button>
        {!isAuthenticated && isLoaded ? (
          <p className="text-[12px] text-zinc-500 px-1">{s.signInFirst}</p>
        ) : null}
      </div>

      <div className="flex-1 pt-2">{listBody}</div>

      {/* ---------------------------------------------------- support sheet
          A SHEET, so it can be thrown away rather than only closed with the X:
          `Sheet` tracks the finger 1:1, resists upward, and decides on release
          by projected momentum. It used to be a `fixed inset-0` div that was
          mounted when a boolean flipped — no arrival, and no exit at all. */}
      <Sheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        label={s.sheetTitle}
        z={150}
        testId="chats-support-sheet"
        panelClassName="w-full sm:max-w-lg max-h-[88dvh] overflow-y-auto"
      >
        <div className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))]" dir={dir}>
            <div className="flex items-center justify-between gap-3 mb-3">
              <h2 className="text-white font-bold text-[16px]">{s.sheetTitle}</h2>
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                aria-label={s.close}
                className="w-11 h-11 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-300"
              >
                <X aria-hidden="true" className="w-5 h-5" />
              </button>
            </div>

            {ticketsLoading ? (
              <p className="text-zinc-400 text-sm flex items-center gap-2 py-6">
                <Loader2 aria-hidden="true" className="w-4 h-4 animate-spin" />
                {s.checking}
              </p>
            ) : ticketsError ? (
              <ErrorState error={ticketsError} onRetry={() => void loadOpenTicket()} next="/chats" compact />
            ) : (
              <>
                {openTicket ? (
                  <div className="rounded-2xl border border-olive/40 bg-olive/10 p-3 mb-3">
                    <p className="text-white text-[14px] font-bold">
                      {s.openTicket} · <span className="font-mono text-[12px]">{openTicket.id}</span>
                    </p>
                    <p className="text-zinc-300 text-[12px] mt-1">
                      {openTicket.subject} — {s.ticketState}: {stateLabel(openTicket.state)}
                    </p>
                    <p className="text-zinc-400 text-[12px] mt-1">{s.reuseNote}</p>
                  </div>
                ) : (
                  <label className="block mb-3">
                    <span className="block text-zinc-300 text-[13px] font-bold mb-1">{s.subject}</span>
                    <input
                      type="text"
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                      placeholder={s.subjectPh}
                      maxLength={200}
                      className="w-full min-h-[44px] bg-zinc-900 border border-zinc-800 rounded-xl px-3 text-sm text-white outline-none focus-visible:ring-2 focus-visible:ring-gold"
                    />
                  </label>
                )}

                <label className="block">
                  <span className="block text-zinc-300 text-[13px] font-bold mb-1">{s.message}</span>
                  <textarea
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder={s.messagePh}
                    rows={4}
                    maxLength={4000}
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-sm text-white outline-none focus-visible:ring-2 focus-visible:ring-gold resize-y"
                  />
                </label>

                {formError ? (
                  <p role="alert" className="mt-2 text-red-300 text-[13px] bg-red-500/10 border border-red-500/25 rounded-xl px-3 py-2">
                    {formError}
                  </p>
                ) : null}
                {done ? (
                  <p className="mt-2 text-emerald-300 text-[13px] bg-emerald-500/10 border border-emerald-500/25 rounded-xl px-3 py-2">
                    {done}
                  </p>
                ) : null}

                <button
                  type="button"
                  onClick={submitSupport}
                  disabled={submitting}
                  className="mt-3 w-full min-h-[48px] rounded-2xl bg-gold text-black font-black text-[15px] flex items-center justify-center gap-2 disabled:opacity-50 transition-all"
                >
                  {submitting ? (
                    <Loader2 aria-hidden="true" className="w-5 h-5 animate-spin" />
                  ) : (
                    <Send aria-hidden="true" className="w-5 h-5" />
                  )}
                  {submitting ? s.sending : openTicket ? s.send : s.create}
                </button>

                <Link
                  to="/support"
                  className="mt-3 block text-center text-zinc-300 text-[13px] font-bold underline underline-offset-4 min-h-[44px] leading-[44px]"
                >
                  {s.viewTickets}
                </Link>

                <p className="mt-2 text-[12px] text-zinc-500 leading-relaxed">{s.honesty}</p>
                <p className="mt-1 text-[12px] text-zinc-500 leading-relaxed">{s.noMoney}</p>
              </>
            )}
        </div>
      </Sheet>
    </div>
  );
}
