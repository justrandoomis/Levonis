import React, { useState, useEffect, useRef } from 'react';
import { Check, ShieldCheck } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { tierLabel, tierMetaFor } from './subscription/tierMeta';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import LangThemeButton from './LangThemeSheet';
import NotificationBell from './notifications/NotificationBell';
import LiveSearch from './search/LiveSearch';

export default function Header() {
  const { t, dir } = useLanguage();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const { isAuthenticated, user } = useAuth();

  // Admin visibility comes exclusively from the server-side role.
  const isAdminUser = !!user?.isAdmin;

  // Plan/expiry come from the server-side user only.
  const now = Date.now();
  const subTier =
    user &&
    user.membership_tier !== 'free' &&
    (user.subscription_expiry === 0 || user.subscription_expiry > now)
      ? user.membership_tier
      : 'free';
  // The tier's own colours, from the one table every surface reads — PRIME is
  // gold here as everywhere else, not PLUS green (it used to be a pro/else
  // test on the hex values).
  const tierMeta = tierMetaFor(subTier);


  const [isScrolled, setIsScrolled] = useState(false);

  const headerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const handleScroll = () => {
      const mainContainer = document.getElementById('main-scroll-container');
      if (mainContainer) {
        setIsScrolled(mainContainer.scrollTop > 30);
      }
    };

    // Check initial scroll position after a short delay to ensure DOM is ready
    setTimeout(handleScroll, 100);
    
    const container = document.getElementById('main-scroll-container');
    if (container) {
      container.addEventListener('scroll', handleScroll);
      return () => container.removeEventListener('scroll', handleScroll);
    } else {
      window.addEventListener('scroll', handleScroll, true);
      return () => window.removeEventListener('scroll', handleScroll, true);
    }
  }, [location.pathname]);

  /**
   * THE HEADER PUBLISHES ITS OWN HEIGHT.
   *
   * It is `position: fixed`, so it is out of flow and the scroll container
   * begins underneath it — anything rendered at the top of that container is
   * COVERED. Hero already clears it, with a hand-tuned `pt-[132px]`; the email
   * verification banner did not, which is exactly why it was reported as
   * appearing "behind the search bar".
   *
   * Rather than copy that magic number to a second place, the header measures
   * itself into `--app-header-height` — the token index.css already declares
   * and Product.tsx already maintains the same way — so anything that needs to
   * clear it reads one live value. The observer follows the collapse on scroll
   * too, so the offset shrinks with the bar instead of stranding a gap.
   */
  React.useLayoutEffect(() => {
    const element = headerRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const write = () => {
      document.documentElement.style.setProperty(
        '--app-header-height',
        `${Math.ceil(element.getBoundingClientRect().height)}px`
      );
    };
    write();
    const observer = new ResizeObserver(write);
    observer.observe(element);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--app-header-height');
    };
  }, [location.pathname]);

  if (location.pathname !== '/') {
    return null;
  }

  return (
    <header ref={headerRef} className={`fixed top-0 inset-x-0 z-[100] flex flex-col pointer-events-none transition-all duration-500 px-4 ${
      // `lv-topbar-*` (src/index.css, THE TOP AND BOTTOM BARS): on the dark
      // theme exactly these utilities; on the light one a clean ivory bar with
      // a hairline, and no scrim over the hero at all.
      isScrolled ? 'lv-topbar-solid material material-thin pt-2.5 pb-2.5 shadow-lg' : 'lv-topbar-scrim bg-gradient-to-b from-black/88 via-black/48 to-transparent pt-4 pb-2'
    }`}>
      <div className={`flex items-center justify-between pointer-events-auto transition-all duration-500 ease-in-out origin-top ${
        isScrolled ? 'h-0 opacity-0 mb-0 scale-95 overflow-hidden' : 'h-11 opacity-100 mb-3 scale-100'
      }`}>
        {/* Left: Profile/Brand Pill + Admin Button */}
        <div className="flex items-center gap-2">
          <Link to={isAuthenticated ? "/profile" : "/auth"} className="flex min-w-0 shrink items-center gap-2.5 rounded-xl bg-surface/95 p-1.5 pe-3.5 text-text-primary transition-colors hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
            <div className="w-8 h-8 rounded-full shrink-0 bg-olive flex items-center justify-center text-snow font-bold text-sm shadow-inner overflow-hidden">
              {isAuthenticated ? (
                 <img
                   referrerPolicy="no-referrer"
                   src={user?.avatar_key
                     ? `/files/${user.avatar_key}`
                     : `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(user?.username || user?.name || 'Levonis')}`}
                   alt="Avatar"
                   className="w-full h-full object-cover"
                 />
              ) : (
                 <span>SU</span>
              )}
            </div>
            <span className="text-white text-[13px] font-bold tracking-tight truncate">
              {isAuthenticated ? (user?.username || 'User') : t('signUp')}
            </span>
          </Link>

          {/* Admin Dashboard Button */}
          {isAdminUser && (
            <Link 
              to="/admin" 
              className="flex items-center gap-1.5 bg-gradient-to-r from-[#6B46FF] to-[#A855F7] text-snow px-3.5 py-1.5 rounded-full text-xs font-black shadow-lg shadow-iris/30 border border-white/20 hover:brightness-110 transition-all hover:scale-105 active:scale-95 shrink-0"
              title={dir === 'rtl' ? 'لوحة التحكم بالإدارة' : 'Admin Dashboard'}
            >
              <ShieldCheck className="w-4 h-4 text-white animate-pulse" />
              <span className="text-[11px] sm:text-xs font-bold">{dir === 'rtl' ? 'لوحة الأدمن' : 'Admin'}</span>
            </Link>
          )}
        </div>
        
        {/* Right: Actions */}
        <div className="flex items-center gap-2 shrink-0">
          {/* The inbox. It renders nothing at all for a signed-out visitor —
              there is no such thing as a guest's notifications, and a bell that
              always says zero is furniture. Placed before the language toggle
              so it sits closest to the content it refers to. */}
          <NotificationBell />

          {/* «اللغة والمظهر» — the globe opens one bottom sheet with two rows,
              the language and the appearance (src/components/LangThemeSheet.tsx).
              It replaced a language-only dropdown. */}
          <LangThemeButton variant="home" />

          {/* Subscription Button — the plans page is browsable signed out now,
              so a guest goes straight to it. Sending them through /auth first
              asked for an account before showing what it costs. */}
          <Link
            to="/subscription"
            className={`relative rounded-full overflow-hidden flex items-center h-11 group ${
              subTier !== 'free' ? 'p-[1.5px]' : 'border border-zinc-800/60'
            }`}
          >
            {tierMeta && (
              <div
                className="absolute top-1/2 left-1/2 w-[300%] h-[300%] -translate-x-1/2 -translate-y-1/2 animate-spin pointer-events-none"
                style={{
                  backgroundImage: `conic-gradient(from 0deg, transparent 70%, ${tierMeta.accentDeep} 85%, ${tierMeta.hex} 100%)`,
                  animationDuration: '3s'
                }}
              />
            )}
            
            <div className={`relative h-full px-4 rounded-full flex items-center gap-1.5 z-10 w-full transition-colors ${
              subTier !== 'free' 
                ? 'bg-surface hover:bg-surface-raised'
                : 'bg-surface/95 hover:bg-surface-raised'
            }`}>
              <span className={`text-[13px] tracking-wide capitalize ${
                subTier !== 'free' ? 'text-white font-bold' : 'text-zinc-300 font-medium'
              }`}>
                {subTier === 'free' ? subTier : tierLabel(subTier)}
              </span>
              {tierMeta && <Check className="w-4 h-4" style={{ color: tierMeta.hex }} strokeWidth={3} aria-hidden="true" />}
            </div>
          </Link>
        </div>
      </div>

      {/* Search Bar — a real form: submits on Enter/Go on mobile keyboards
          AND via the (44px) icon button, and lands on the products page
          with the query actually applied (?search=). While the shopper types
          it answers in a panel that grows down out of the field, and completes
          the word under the caret in grey (Space takes it) — see
          src/components/search/LiveSearch.tsx. The header is
          pointer-events-none so the page scrolls under it; the field and its
          panel opt back in. */}
      <LiveSearch
        value={searchQuery}
        onChange={setSearchQuery}
        onSubmit={(query) => {
          navigate('/products?search=' + encodeURIComponent(query));
          setSearchQuery('');
        }}
        onPick={() => setSearchQuery('')}
        size={isScrolled ? 'compact' : 'regular'}
        className={`w-full max-w-4xl mx-auto pointer-events-auto transition-[margin] duration-500 ease-in-out ${isScrolled ? 'mt-0' : 'mt-1'}`}
      />

      {/* Subscription-based border line when scrolled */}
      <div className={`absolute bottom-0 left-0 right-0 h-[2px] w-full overflow-hidden transition-opacity duration-500 ${isScrolled ? 'opacity-100' : 'opacity-0'}`}>
         {!tierMeta ? (
           <div className="w-full h-full bg-zinc-800/80" />
         ) : (
           <div
             className="w-[200%] h-full"
             style={{
               background: `linear-gradient(to right, ${tierMeta.hex}, ${tierMeta.accentLight}, ${tierMeta.accentDeep}, ${tierMeta.hex}, ${tierMeta.accentDeep}, ${tierMeta.accentLight}, ${tierMeta.hex})`,
               backgroundSize: '50% 100%',
               animation: 'rainbow 3s linear infinite'
             }}
           />
         )}
      </div>
    </header>
  );
}
