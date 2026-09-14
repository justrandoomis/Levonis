import { createUnreadObserver } from '../../lib/mascot';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell,
  CheckCheck,
  CircleCheck,
  Loader2,
  Package,
  Printer,
  RotateCw,
  Tag,
} from 'lucide-react';
import { useAuth } from '../../AuthContext';
import { useLanguage } from '../../LanguageContext';
import { ApiError } from '../../lib/api';
import { Anchored, Sheet } from '../ui/Overlay';
import { listNotifications, markRead, unreadCount, type NotificationRow } from '../../lib/notifications';

/**
 * THE BELL — the app's first in-app inbox.
 *
 * FOUR DECISIONS WORTH THE WORDS:
 *
 *  1. THE BADGE IS POLLED, THE LIST IS NOT. `/unread-count` is a single indexed
 *     count and it is the only thing a person can see without opening anything,
 *     so it is the only thing worth asking for on a timer. The list is fetched
 *     when the panel opens — pulling twenty-five rows every minute to render
 *     nothing is bandwidth spent on a phone plan for no one's benefit.
 *
 *  2. POLLING STOPS WHEN THE TAB IS HIDDEN, and it stops by CLEARING THE
 *     INTERVAL rather than by ticking and returning early. A backgrounded tab
 *     on a phone should cost nothing; a timer that still fires and still
 *     decides not to act is a timer that still woke the CPU. Coming back to the
 *     tab asks immediately, because the interesting moment is the return.
 *
 *  3. A DROPDOWN ON A DESKTOP, A SHEET ON A PHONE — a real behavioural split,
 *     not a breakpoint on a width. A popover anchored to a 44px button is fine
 *     beside a pointer and miserable under a thumb at 390px, where the panel
 *     wants the bottom of the screen and a drag to throw it away. Both come
 *     from `ui/Overlay`, so both arrive and leave the same way everything else
 *     in the app does.
 *
 *  4. THE ROW IS OPTIMISTIC, THE COUNT IS THE SERVER'S. Tapping a notification
 *     marks it read locally and navigates at once — waiting on a round trip
 *     before following a link people already decided to follow is the delay
 *     that makes an inbox feel broken. The badge is then corrected from the
 *     `unread` the write returns, so an optimistic decrement can never drift.
 *
 * Signed out it renders NOTHING. Not an empty bell, not a disabled one: an
 * inbox belongs to an account, and offering the affordance to someone who
 * cannot have one is an invitation to a 401.
 */

/** Under this, the panel is a bottom sheet. Matches Tailwind's `sm`. */
const PHONE_QUERY = '(max-width: 639px)';

/** How often the badge is refreshed while the tab is in front. */
const POLL_MS = 60_000;

function usePhone(): boolean {
  const [phone, setPhone] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(PHONE_QUERY).matches
  );
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const onChange = () => setPhone(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return phone;
}

type Loc = (ar: string, en: string, ckb?: string) => string;

/**
 * Arabic counts its nouns in three shapes, and picking one of them for all of
 * it is the tell of a translated interface: «٢ دقيقة» is not a sentence an
 * Arabic speaker writes. One is bare, two is the dual, three-to-ten takes the
 * plural, and eleven upwards returns to the singular.
 */
function arCount(n: number, one: string, two: string, few: string): string {
  if (n === 1) return one;
  if (n === 2) return two;
  const digits = n.toLocaleString('ar');
  return n <= 10 ? `${digits} ${few}` : `${digits} ${one}`;
}

/** «قبل ٥ دقائق» / «5m ago» — coarse on purpose; an inbox is not a clock. */
function relTime(iso: string, loc: Loc): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  // A clock skewed a few seconds ahead of the server must not print "قبل -١".
  if (!Number.isFinite(min) || min < 1) return loc('الآن', 'now', 'ئێستا');
  if (min < 60) {
    return loc(`قبل ${arCount(min, 'دقيقة', 'دقيقتين', 'دقائق')}`, `${min}m ago`, `پێش ${min} خولەک`);
  }
  const h = Math.floor(min / 60);
  if (h < 24) {
    return loc(`قبل ${arCount(h, 'ساعة', 'ساعتين', 'ساعات')}`, `${h}h ago`, `پێش ${h} کاتژمێر`);
  }
  const d = Math.floor(h / 24);
  if (d < 30) {
    return loc(`قبل ${arCount(d, 'يوم', 'يومين', 'أيام')}`, `${d}d ago`, `پێش ${d} ڕۆژ`);
  }
  const mo = Math.floor(d / 30);
  return loc(`قبل ${arCount(mo, 'شهر', 'شهرين', 'أشهر')}`, `${mo}mo ago`, `پێش ${mo} مانگ`);
}

/** The kind is an open set (the server may add one), so this always answers. */
function kindIcon(kind: string) {
  switch (kind) {
    case 'print_request_match':
      return Printer;
    case 'offer_received':
      return Tag;
    case 'offer_accepted':
      return CircleCheck;
    case 'order_update':
      return Package;
    default:
      return Bell;
  }
}

interface RowProps {
  n: NotificationRow;
  /** Inside `Anchored` the container is a `role="menu"`, and a menu whose
   *  children are not menuitems is a menu no screen reader can walk. The sheet
   *  is a plain dialog, where the role would be a lie. */
  asMenu: boolean;
  onOpen: (n: NotificationRow) => void;
}

function Row({ n, asMenu, onOpen }: RowProps) {
  const { lang, loc } = useLanguage();
  // Sorani falls back to the ARABIC text, never to English: Arabic is the
  // source language the server stored, and it is the closer of the two.
  const title = lang === 'en' ? n.title_en : n.title_ar;
  const body = lang === 'en' ? n.body_en : n.body_ar;
  const Icon = kindIcon(n.kind);

  return (
    <button
      type="button"
      role={asMenu ? 'menuitem' : undefined}
      data-notif-item={n.id}
      data-notif-read={n.read ? '1' : '0'}
      onClick={() => onOpen(n)}
      className={`flex w-full items-start gap-2.5 px-3 py-3 text-start transition-colors hover:bg-white/[0.06] focus-visible:bg-white/[0.06] focus-visible:outline-none ${
        n.read ? '' : 'bg-gold/[0.06]'
      }`}
    >
      <span
        className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full border ${
          n.read ? 'border-zinc-700/70 bg-zinc-800/60 text-zinc-400' : 'border-gold/30 bg-gold/10 text-gold'
        }`}
      >
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>

      <span className="min-w-0 flex-1">
        <span className={`block text-[13px] leading-5 ${n.read ? 'text-zinc-300' : 'font-bold text-white'}`}>
          {title}
        </span>
        {body && <span className="mt-0.5 line-clamp-2 text-[12px] leading-5 text-zinc-400">{body}</span>}
        <time dateTime={n.created_at} className="mt-1 block text-[11px] text-zinc-500">
          {relTime(n.created_at, loc)}
        </time>
      </span>

      {!n.read && (
        <>
          {/* The dot carries the state visually; the word carries it to
              everyone else. Colour alone has never been an announcement. */}
          <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-gold" aria-hidden="true" />
          <span className="sr-only">{loc('غير مقروء', 'Unread', 'نەخوێندراوە')}</span>
        </>
      )}
    </button>
  );
}

export default function NotificationBell() {
  const { isAuthenticated, user } = useAuth();
  const { loc, dir } = useLanguage();
  const navigate = useNavigate();
  const phone = usePhone();
  const titleId = useId();
  const bellRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  /**
   * The session died under us (401). `useAuth` still believes it is signed in
   * until something refreshes it, so without this the poller would spend the
   * rest of the page's life asking a question it has already been refused.
   */
  const [expired, setExpired] = useState(false);

  const live = isAuthenticated && !expired;

  const mascotUnread = useRef(createUnreadObserver());
  const mascotAccount = useRef(user?.id);
  useEffect(() => { mascotAccount.current = user?.id; mascotUnread.current.reset(); }, [user?.id]);

  const refreshCount = useCallback(async () => {
    const account = mascotAccount.current;
    try {
      const count = await unreadCount();
      if (account !== mascotAccount.current) return;
      mascotUnread.current.observe(count);
      setUnread(count);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setExpired(true);
      // Anything else is a bad minute on a phone network: the badge keeps the
      // last number it was told rather than blanking itself into a lie.
    }
  }, []);

  const loadList = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const page = await listNotifications({ limit: 25 });
      setRows(page.notifications);
      setUnread(page.unread);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setExpired(true);
      else setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // The badge: once on mount, then once a minute for as long as the tab is
  // actually in front of somebody.
  useEffect(() => {
    if (!live) return;
    let timer: number | null = null;
    const tick = () => void refreshCount();
    const disarm = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const arm = () => {
      if (timer === null) timer = window.setInterval(tick, POLL_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        disarm();
      } else {
        // The return IS the interesting moment — whatever arrived while the
        // tab was away is exactly what this person came back to find.
        tick();
        arm();
      }
    };
    if (document.visibilityState === 'visible') {
      tick();
      arm();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disarm();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [live, refreshCount]);

  // A fresh sign-in is a fresh session: the 401 that hid the bell stopped being
  // the truth the moment somebody signed back in, so the poller is let go again.
  useEffect(() => {
    if (isAuthenticated) setExpired(false);
  }, [isAuthenticated]);

  // Opening is the only thing that fetches the list, so what is on screen was
  // read at most one tap ago.
  useEffect(() => {
    if (open && live) void loadList();
  }, [open, live, loadList]);

  // `Anchored` places the panel but does not move focus into it. Without this a
  // keyboard user opens a window and is left standing outside it.
  useEffect(() => {
    if (open && !phone) panelRef.current?.focus({ preventScroll: true });
  }, [open, phone]);

  /** Dismissal returns focus to the bell; navigation deliberately does not. */
  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) bellRef.current?.focus({ preventScroll: true });
  }, []);

  const openItem = useCallback(
    (n: NotificationRow) => {
      close(false);
      if (!n.read) {
        setRows((prev) => prev.map((r) => (r.id === n.id ? { ...r, read: true } : r)));
        setUnread((u) => Math.max(0, u - 1));
        // Fire-and-correct: the navigation must not wait on this, and the
        // server's own total replaces the guess when it lands.
        void markRead(n.id)
          .then((r) => setUnread(r.unread))
          .catch(() => void refreshCount());
      }
      if (n.link) navigate(n.link);
    },
    [close, navigate, refreshCount]
  );

  const markAll = useCallback(() => {
    setRows((prev) => prev.map((r) => ({ ...r, read: true })));
    setUnread(0);
    void markRead()
      .then((r) => setUnread(r.unread))
      // A failed write must not leave a screen claiming a clean inbox, so the
      // truth is re-read rather than assumed.
      .catch(() => void loadList());
  }, [loadList]);

  // Hooks first, then the door: an inbox belongs to an account.
  if (!live) return null;

  const label = loc('الإشعارات', 'Notifications', 'ئاگادارکردنەوە');
  const openLabel =
    unread > 0
      ? loc(`الإشعارات، ${unread.toLocaleString('ar')} غير مقروءة`, `Notifications, ${unread} unread`, `ئاگادارکردنەوە، ${unread} نەخوێندراوە`)
      : label;

  const body = (
    <div
      ref={panelRef}
      tabIndex={-1}
      data-notif="panel"
      dir={dir}
      className="flex max-h-[70vh] min-h-0 flex-col outline-none sm:max-h-[26rem]"
    >
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2.5">
        <h2 id={titleId} className="text-[13px] font-bold text-white">
          {label}
        </h2>
        <button
          type="button"
          data-notif="mark-all"
          onClick={markAll}
          disabled={unread === 0}
          className="flex min-h-[32px] items-center gap-1.5 rounded-full px-2.5 text-[12px] text-zinc-400 transition-colors hover:text-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:pointer-events-none disabled:opacity-40"
        >
          <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
          {loc('تعليم الكل كمقروء', 'Mark all read', 'هەموو وەک خوێندراوە')}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain divide-y divide-white/[0.06]">
        {loading && rows.length === 0 && (
          <div className="flex items-center justify-center gap-2 px-3 py-8 text-[12px] text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {loc('جارٍ التحميل…', 'Loading…', 'بارکردن…')}
          </div>
        )}

        {failed && rows.length === 0 && (
          <div className="px-3 py-8 text-center">
            <p className="text-[12px] text-zinc-400">
              {loc('تعذّر تحميل الإشعارات', 'Couldn’t load notifications', 'نەتوانرا ئاگادارکردنەوەکان باربکرێن')}
            </p>
            <button
              type="button"
              onClick={() => void loadList()}
              className="mt-2 inline-flex min-h-[36px] items-center gap-1.5 rounded-full border border-zinc-700 px-3 text-[12px] text-zinc-200 transition-colors hover:border-gold/50 hover:text-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
            >
              <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
              {loc('إعادة المحاولة', 'Try again', 'دووبارە هەوڵبدەرەوە')}
            </button>
          </div>
        )}

        {!loading && !failed && rows.length === 0 && (
          <p className="px-3 py-10 text-center text-[12px] text-zinc-500">
            {loc('لا توجد إشعارات', 'No notifications yet', 'هیچ ئاگادارکردنەوەیەک نییە')}
          </p>
        )}

        {rows.map((n) => (
          <Row key={n.id} n={n} asMenu={!phone} onOpen={openItem} />
        ))}
      </div>
    </div>
  );

  return (
    <div className="relative">
      <button
        ref={bellRef}
        type="button"
        data-notif="bell"
        data-notif-unread={unread}
        onClick={() => (open ? close(false) : setOpen(true))}
        aria-label={openLabel}
        aria-expanded={open}
        aria-haspopup={phone ? 'dialog' : 'menu'}
        className="relative flex h-11 w-11 items-center justify-center rounded-full border border-zinc-800/60 bg-zinc-900/80 text-zinc-300 shadow-sm transition-all hover:border-olive/50 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
      >
        <Bell className="h-5 w-5" strokeWidth={2} aria-hidden="true" />
        {unread > 0 && (
          <span
            data-notif="badge"
            dir="ltr"
            aria-hidden="true"
            className="absolute -top-1 -end-1 min-w-[18px] rounded-full bg-gold px-1 text-center text-[10px] font-bold leading-[18px] text-black"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {/* The badge is aria-hidden above because the count is already in the
          button's own label — announcing it twice is how a bell becomes noise. */}

      {phone ? (
        <Sheet
          open={open}
          onClose={() => close(true)}
          label={label}
          labelledBy={titleId}
          z={220}
          testId="notification-sheet"
          panelClassName="w-full max-w-md pb-[env(safe-area-inset-bottom)]"
        >
          {body}
        </Sheet>
      ) : (
        <Anchored
          open={open}
          onClose={() => close(true)}
          anchor={bellRef}
          align="end"
          label={label}
          testId="notification-panel"
          className="w-[22rem] max-w-[calc(100vw-1.5rem)] overflow-hidden"
        >
          {body}
        </Anchored>
      )}
    </div>
  );
}
