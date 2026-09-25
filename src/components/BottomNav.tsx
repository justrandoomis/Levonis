import React from 'react';
import { AccountIcon, BagIcon, ChatsIcon, CommunityIcon } from './nav/NavIcons';
import { useLanguage } from '../LanguageContext';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { api } from '../lib/api';
import { cartCountStore, setCartCount, cartResponseCount } from '../lib/cartCount';
import { signalBloub } from './bloub/events';
import { MotionCharacterAnchor } from './bloub/MotionCharacterAnchor';
import { authPathWithSupportRef } from '../lib/supportRef';
import { useCommunityAccess } from '../pages/community/access';

/**
 * Routes on which the floating bottom nav does not render. Exported so the
 * app shell (App.tsx) can reserve bottom clearance for the nav only when it
 * is actually visible — one source of truth, no duplicated route lists.
 * Do not change the route set here without checking the shell's padding.
 */
export function isBottomNavHidden(pathname: string): boolean {
  pathname = pathname.toLowerCase();
  return (
    pathname === '/admin' ||
    pathname === '/edit-profile' ||
    pathname.startsWith('/product/') ||
    // A bundle's detail page uses the product page's sticky bottom purchase
    // bar, and two floating bars stacked on a phone hide each other.
    pathname.startsWith('/bundles/') ||
    pathname.startsWith('/chat/')
  );
}

/**
 * The tabs that still need an account, so the nav can send a guest straight
 * to /auth?next=<dest> and land them back on the tab they tapped.
 *
 * Everything else in the bar is browsable signed out. /community is open, and
 * /chats has always been (App.tsx routes it without a guard, and the page
 * renders an honest signed-out state) — it was listed here anyway, which sent
 * visitors to a sign-in screen for a page they could simply read. The cart is
 * the one that genuinely cannot exist without an account.
 */
const PROTECTED_PATHS = new Set(['/cart']);

export default function BottomNav() {
  const { t, dir } = useLanguage();
  const location = useLocation();

  const navigate = useNavigate();

  /**
   * «في bloub اجعل عند الضغط ٣ مرات او اكثر يفتح الدعم الالي /support —
   *  مره او مرتين واجهه رئيسيه، ٣ مرات او اكثر يفتح /support».
   *
   * A shortcut, not a replacement: one tap and two taps are still Home,
   * which is what the button says it is and what every visitor who has
   * never heard of this will get. The third rapid tap is the only one that
   * changes the destination.
   *
   * RAPID is the whole distinction, and it is why this is a gap between
   * taps rather than a count since mount. Without the window, three
   * separate visits to Home over an afternoon would land the customer in
   * the support chat, and they would have no idea why.
   */
  const bloubTapsRef = React.useRef({ count: 0, at: 0 });
  const BLOUB_MULTI_TAP_MS = 700;
  const BLOUB_TAPS_FOR_SUPPORT = 3;
  const onBloubTap = (e: React.MouseEvent) => {
    const now = Date.now();
    const run = bloubTapsRef.current;
    run.count = now - run.at <= BLOUB_MULTI_TAP_MS ? run.count + 1 : 1;
    run.at = now;
    if (run.count >= BLOUB_TAPS_FOR_SUPPORT) {
      // The run ends here. Without the reset a fourth and fifth tap would
      // each re-navigate to a page the customer is already standing on.
      run.count = 0;
      run.at = 0;
      e.preventDefault();
      signalBloub('tap', 210);
      navigate('/support');
      return;
    }
    signalBloub('tap', 210);
  };
  const { isAuthenticated } = useAuth();
  /**
   * THE CART BADGE. Adding a product used to change nothing anywhere in the
   * chrome, so the only way to learn whether a tap had worked was to open the
   * cart. The number comes from the shared store (src/lib/cartCount.ts), which
   * every cart response writes to, so the badge is the server's count and
   * never an optimistic guess.
   */
  const cartCount = React.useSyncExternalStore(cartCountStore.subscribe, cartCountStore.snapshot, () => null);
  const [messageUnreadCount, setMessageUnreadCount] = React.useState(0);

  // One small request, once, and only for someone who can have a cart. A
  // failure is silent by design: a missing badge is a badge that is merely
  // absent, while a wrong one is a lie about the customer's basket.
  React.useEffect(() => {
    if (!isAuthenticated) {
      setCartCount(null);
      return;
    }
    if (cartCountStore.snapshot() !== null) return;
    let cancelled = false;
    api
      .get<{ items: Array<{ qty?: number | null }>; item_count?: number }>('/api/cart', { mascot: 'silent' })
      .then((d) => {
        // `item_count` counts a store cart too; `items` is the Levonis half.
        if (!cancelled) setCartCount(cartResponseCount(d) ?? 0);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  // Chats already return an authoritative unread count per conversation.
  // Reuse that contract for the shell badge instead of introducing a second
  // counter or guessing from the most recent message.
  React.useEffect(() => {
    if (!isAuthenticated) {
      setMessageUnreadCount(0);
      return;
    }
    let cancelled = false;
    api
      .get<{ chats: Array<{ unread?: number | null }> }>('/api/chats', { mascot: 'silent' })
      .then((d) => {
        if (cancelled) return;
        setMessageUnreadCount(
          (d.chats ?? []).reduce((sum, chat) => sum + Math.max(0, Math.trunc(Number(chat.unread) || 0)), 0)
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, location.pathname]);

  const leftItems = [
    { icon: AccountIcon, label: t('profile'), path: '/profile' },
    { icon: BagIcon, label: t('cart'), path: '/cart' },
  ];
  /**
   * THE COMMUNITY TAB DISAPPEARS WHEN THE SERVER SAYS THE COMMUNITY IS SHUT.
   *
   * Presentation only: the refusal is worker/lib/communityGate.ts, and a tab
   * still tapped from a stale bundle lands on the maintenance card. What this
   * buys is that nobody is invited into a door that will not open. An answer
   * that has not arrived yet, or one that failed, keeps the tab — the bar must
   * not flicker a tab away on a dropped request, and an unknown state is not a
   * refusal.
   */
  const { access: communityAccess } = useCommunityAccess();
  const communityShut = communityAccess?.may_enter === false;
  const rightItems = [
    { icon: ChatsIcon, label: t('webCenter'), path: '/chats' },
    ...(communityShut ? [] : [{ icon: CommunityIcon, label: t('community'), path: '/community' }]),
  ];
  type NavItem = (typeof leftItems)[number];

  if (isBottomNavHidden(location.pathname)) return null;

  const linkTarget = (path: string) =>
    !isAuthenticated && PROTECTED_PATHS.has(path)
      ? authPathWithSupportRef(path)
      : path;

  const renderItem = (item: NavItem) => {
    const isActive = location.pathname === item.path;
    const badge = item.path === '/cart'
      ? (cartCount ?? 0)
      : item.path === '/chats'
        ? messageUnreadCount
        : 0;
    return (
      <Link
        key={item.path}
        to={linkTarget(item.path)}
        dir={dir}
        aria-label={badge > 0 ? `${item.label} (${badge})` : item.label}
        aria-current={isActive ? 'page' : undefined}
        className={`relative flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-0.5 transition-[color,background-color,opacity,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus active:scale-[0.98] ${
          isActive ? 'bg-white/[0.07] text-text-primary' : 'text-text-muted hover:bg-white/[0.04] hover:text-text-secondary'
        }`}
      >
        {isActive && (
          <span
            aria-hidden="true"
            className="absolute start-1/2 top-0 h-0.5 w-5 -translate-x-1/2 rtl:translate-x-1/2 rounded-full bg-gold"
          />
        )}
        <span className="relative">
          <item.icon className="h-[22px] w-[22px] sm:h-6 sm:w-6" strokeWidth={isActive ? 1.9 : 1.55} />
          {badge > 0 ? (
            // Absolutely positioned so appearing and changing never moves the
            // tab, and the label is already on the link — the pill itself is
            // decorative.
            <span
              aria-hidden="true"
              data-nav-badge={item.path === '/cart' ? 'cart' : item.path === '/chats' ? 'messages' : undefined}
              className="absolute -top-1.5 -end-2 min-w-[16px] h-[16px] px-1 rounded-full bg-danger text-snow text-[10px] font-black leading-[16px] text-center tabular-nums"
            >
              {badge > 99 ? '99+' : badge}
            </span>
          ) : null}
        </span>
        <span className={`max-w-full truncate text-[9px] sm:text-[10px] ${isActive ? 'font-bold text-text-primary' : 'font-medium'}`}>{item.label}</span>
      </Link>
    );
  };

  return (
    <nav
      aria-label="LEVONIS"
      data-bottom-nav
      dir="ltr"
      className="fixed bottom-[max(0.625rem,env(safe-area-inset-bottom))] sm:bottom-[max(1rem,env(safe-area-inset-bottom))] inset-x-0 z-[120] flex items-center justify-center gap-1.5 px-2 pointer-events-none transition-[opacity,transform] duration-200 sm:gap-3 sm:px-4"
    >
      {/* A scrim under the whole bar. The page scrolls UNDER a floating nav by
          design, and at 20% black the text passing behind it stayed perfectly
          legible — so a price or a heading appeared sliced in half by the bar
          and the screen read as broken. This fades the page out beneath the
          nav instead of letting it collide with it. It sits behind the pills,
          takes no pointer events, and is decorative. */}
      <div
        aria-hidden="true"
        data-nav-scrim
        className="pointer-events-none absolute inset-x-0 bottom-[calc(-1*max(0.625rem,env(safe-area-inset-bottom)))] sm:bottom-[calc(-1*max(1rem,env(safe-area-inset-bottom)))] h-[calc(100%+max(0.625rem,env(safe-area-inset-bottom))+20px)] -z-10 bg-gradient-to-t from-black via-black/94 to-transparent"
      />

      {/* Two compact groups restore Levonis' established navigation grammar.
          The centre is deliberately independent, not a raised fifth cell in
          one long bar. `dir=ltr` keeps the physical groups stable; each link
          restores the document direction for its Arabic/English label. */}
      <div
        data-bottom-nav-group="account-cart"
        className="material material-thin flex h-16 min-w-0 max-w-[160px] flex-1 items-center gap-0.5 rounded-2xl border border-border-subtle p-1.5 shadow-2xl pointer-events-auto sm:h-[68px] sm:max-w-[180px] sm:p-2"
      >
        {leftItems.map(renderItem)}
      </div>

      <Link
        to="/"
        dir={dir}
        aria-label={t('home')}
        aria-current={location.pathname === '/' ? 'page' : undefined}
        onClick={onBloubTap}
        data-bloub-home-button
        data-bloub-support-taps={BLOUB_TAPS_FOR_SUPPORT}
        className="lv-character-bottom-home relative shrink-0 rounded-xl pointer-events-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <MotionCharacterAnchor kind="bottom-home" />
        {location.pathname === '/' ? (
          <span aria-hidden="true" className="absolute -bottom-0.5 h-1 w-1 rounded-full bg-gold" />
        ) : null}
      </Link>

      <div
        data-bottom-nav-group="messages-community"
        className="material material-thin flex h-16 min-w-0 max-w-[160px] flex-1 items-center gap-0.5 rounded-2xl border border-border-subtle p-1.5 shadow-2xl pointer-events-auto sm:h-[68px] sm:max-w-[180px] sm:p-2"
      >
        {rightItems.map(renderItem)}
      </div>
    </nav>
  );
}
