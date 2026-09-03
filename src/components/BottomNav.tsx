import React from 'react';
import { Home, Users, MessageCircle, ShoppingCart, User } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../AuthContext';

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
  const { t } = useLanguage();
  const location = useLocation();
  const { isAuthenticated } = useAuth();

  const navItems = [
    { icon: Users, label: t('community'), path: '/community' },
    { icon: MessageCircle, label: t('webCenter'), path: '/chats' },
    { icon: Home, label: t('home'), path: '/' },
    { icon: ShoppingCart, label: t('cart'), path: '/cart' },
    { icon: User, label: t('profile'), path: '/profile' },
  ];

  const leftItems = navItems.slice(0, 2);
  const homeItem = navItems[2];
  const rightItems = navItems.slice(3, 5);

  if (isBottomNavHidden(location.pathname)) return null;

  const linkTarget = (path: string) =>
    !isAuthenticated && PROTECTED_PATHS.has(path)
      ? `/auth?next=${encodeURIComponent(path)}`
      : path;

  const renderItem = (item: (typeof navItems)[number]) => {
    const isActive = location.pathname === item.path;
    return (
      <Link
        key={item.path}
        to={linkTarget(item.path)}
        aria-label={item.label}
        aria-current={isActive ? 'page' : undefined}
        className={`flex flex-col items-center justify-center flex-1 h-full rounded-full transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold active:scale-95 ${
          isActive ? 'bg-olive/20 text-gold shadow-sm' : 'text-zinc-500 hover:text-gold'
        }`}
      >
        <item.icon
          className={`w-[18px] h-[18px] sm:w-[22px] sm:h-[22px] mb-0.5 sm:mb-1 ${isActive ? 'text-gold' : ''}`}
          strokeWidth={isActive ? 2.5 : 2}
          aria-hidden="true"
        />
        <span className={`text-[9px] sm:text-[11px] font-medium whitespace-nowrap ${isActive ? 'text-gold font-bold' : ''}`}>{item.label}</span>
      </Link>
    );
  };

  return (
    <nav aria-label="LEVONIS" className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] sm:bottom-[max(1.5rem,env(safe-area-inset-bottom))] left-0 right-0 z-[120] flex items-center justify-center gap-1.5 sm:gap-3 px-2 sm:px-4 pointer-events-none">
      {/* A scrim under the whole bar. The page scrolls UNDER a floating nav by
          design, and at 20% black the text passing behind it stayed perfectly
          legible — so a price or a heading appeared sliced in half by the bar
          and the screen read as broken. This fades the page out beneath the
          nav instead of letting it collide with it. It sits behind the pills,
          takes no pointer events, and is decorative. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-[calc(-1*max(1rem,env(safe-area-inset-bottom)))] sm:bottom-[calc(-1*max(1.5rem,env(safe-area-inset-bottom)))] h-[calc(100%+max(1rem,env(safe-area-inset-bottom))+28px)] -z-10 bg-gradient-to-t from-black via-black/95 to-transparent"
      />

      {/* Left Pill */}
      <div className="bg-zinc-950/95 backdrop-blur-2xl border border-white/10 rounded-[36px] p-1 sm:p-2 flex items-center shadow-xl h-[60px] sm:h-[72px] pointer-events-auto flex-1 max-w-[160px] sm:max-w-[180px] justify-between">
        {leftItems.map(renderItem)}
      </div>

      {/* Center Home Circle */}
      <Link
        to={homeItem.path}
        aria-label={homeItem.label}
        aria-current={location.pathname === homeItem.path ? 'page' : undefined}
        className={`w-[60px] h-[60px] sm:w-[72px] sm:h-[72px] rounded-full flex items-center justify-center shadow-xl transition-transform hover:scale-105 active:scale-95 border border-white/10 shrink-0 pointer-events-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold ${
          location.pathname === homeItem.path
            ? 'bg-olive text-gold border-olive/50 shadow-olive/20'
            : 'bg-zinc-950/95 backdrop-blur-2xl text-zinc-500 hover:text-gold border-white/10'
        }`}
      >
        <homeItem.icon
          className="w-6 h-6 sm:w-7 sm:h-7"
          strokeWidth={location.pathname === homeItem.path ? 2.5 : 2}
          aria-hidden="true"
        />
      </Link>

      {/* Right Pill */}
      <div className="bg-zinc-950/95 backdrop-blur-2xl border border-white/10 rounded-[36px] p-1 sm:p-2 flex items-center shadow-xl h-[60px] sm:h-[72px] pointer-events-auto flex-1 max-w-[160px] sm:max-w-[180px] justify-between">
        {rightItems.map(renderItem)}
      </div>
    </nav>
  );
}
