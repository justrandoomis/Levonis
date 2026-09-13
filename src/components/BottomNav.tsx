import React from 'react';
import { Users, MessageCircle, ShoppingCart, User } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { api } from '../lib/api';
import { cartCountStore, setCartCount, countCartItems } from '../lib/cartCount';
import { signalBloub } from './bloub/AppIntro';

/**
 * Routes on which the floating bottom nav does not render. Exported so the
 * app shell (App.tsx) can reserve bottom clearance for the nav only when it
 * is actually visible — one source of truth, no duplicated route lists.
 * Do not change the route set here without checking the shell's padding.
 */
export function isBottomNavHidden(pathname: string): boolean {
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
  const { isAuthenticated } = useAuth();
  /**
   * THE CART BADGE. Adding a product used to change nothing anywhere in the
   * chrome, so the only way to learn whether a tap had worked was to open the
   * cart. The number comes from the shared store (src/lib/cartCount.ts), which
   * every cart response writes to, so the badge is the server's count and
   * never an optimistic guess.
   */
  const cartCount = React.useSyncExternalStore(cartCountStore.subscribe, cartCountStore.snapshot, () => null);

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
      .get<{ items: Array<{ qty?: number | null }> }>('/api/cart')
      .then((d) => {
        if (!cancelled) setCartCount(countCartItems(d.items ?? []));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  const leftItems = [
    { icon: User, label: t('profile'), path: '/profile' },
    { icon: ShoppingCart, label: t('cart'), path: '/cart' },
  ];
  const rightItems = [
    { icon: MessageCircle, label: t('webCenter'), path: '/chats' },
    { icon: Users, label: t('community'), path: '/community' },
  ];
  type NavItem = (typeof leftItems)[number];

  if (isBottomNavHidden(location.pathname)) return null;

  const linkTarget = (path: string) =>
    !isAuthenticated && PROTECTED_PATHS.has(path)
      ? `/auth?next=${encodeURIComponent(path)}`
      : path;

  const renderItem = (item: NavItem) => {
    const isActive = location.pathname === item.path;
    const badge = item.path === '/cart' && cartCount ? cartCount : 0;
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
          <item.icon
            className="h-5 w-5 sm:h-[22px] sm:w-[22px]"
            strokeWidth={isActive ? 2.5 : 2}
            aria-hidden="true"
          />
          {badge > 0 ? (
            // Absolutely positioned so appearing and changing never moves the
            // tab, and the label is already on the link — the pill itself is
            // decorative.
            <span
              aria-hidden="true"
              className="absolute -top-1.5 -end-2 min-w-[16px] h-[16px] px-1 rounded-full bg-danger text-white text-[10px] font-black leading-[16px] text-center tabular-nums"
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
        onClick={() => signalBloub('tap', 480)}
        className={`relative flex h-16 w-16 shrink-0 items-center justify-center rounded-full border shadow-2xl pointer-events-auto transition-[background-color,border-color,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus active:scale-[0.96] sm:h-[68px] sm:w-[68px] ${
          location.pathname === '/'
            ? 'border-gold/30 bg-surface-selected'
            : 'border-border-subtle bg-surface-raised hover:bg-surface-selected'
        }`}
      >
        <span
          data-bloub-home-target
          aria-hidden="true"
          className="block h-11 w-11 sm:h-12 sm:w-12"
        />
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
