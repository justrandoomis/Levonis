import React, { useState, useEffect, useRef } from 'react';
import { Search, Check, Globe, ShieldCheck } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { Anchored } from './ui/Overlay';

export default function Header() {
  const { lang, setLang, t, dir } = useLanguage();
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


  const [isLangOpen, setIsLangOpen] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);

  // The language menu grows out of THIS button, so the primitive needs a handle
  // on it: it reads the trigger's box once, on open, to point the panel's
  // transform-origin at the control the person actually pressed.
  const langButtonRef = useRef<HTMLButtonElement>(null);

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

  if (location.pathname !== '/') {
    return null;
  }

  return (
    <header className={`fixed top-0 left-0 right-0 z-[100] flex flex-col pointer-events-none transition-all duration-500 px-4 ${
      isScrolled ? 'bg-black/80 backdrop-blur-2xl pt-2.5 pb-2.5 shadow-lg' : 'bg-gradient-to-b from-black/80 via-black/40 to-transparent pt-4 pb-2'
    }`}>
      <div className={`flex items-center justify-between pointer-events-auto transition-all duration-500 ease-in-out origin-top ${
        isScrolled ? 'h-0 opacity-0 mb-0 scale-95 overflow-hidden' : 'h-11 opacity-100 mb-3 scale-100'
      }`}>
        {/* Left: Profile/Brand Pill + Admin Button */}
        <div className="flex items-center gap-2">
          <Link to={isAuthenticated ? "/profile" : "/auth"} className="flex items-center gap-2.5 bg-zinc-900/80 rounded-full p-1.5 pe-4 border border-zinc-800/60 hover:border-olive/50 transition-colors shadow-sm min-w-0 shrink">
            <div className="w-8 h-8 rounded-full shrink-0 bg-olive flex items-center justify-center text-white font-bold text-sm shadow-inner overflow-hidden">
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
              className="flex items-center gap-1.5 bg-gradient-to-r from-[#6B46FF] to-[#A855F7] text-white px-3.5 py-1.5 rounded-full text-xs font-black shadow-lg shadow-[#6B46FF]/30 border border-white/20 hover:brightness-110 transition-all hover:scale-105 active:scale-95 shrink-0"
              title={dir === 'rtl' ? 'لوحة التحكم بالإدارة' : 'Admin Dashboard'}
            >
              <ShieldCheck className="w-4 h-4 text-white animate-pulse" />
              <span className="text-[11px] sm:text-xs font-bold">{dir === 'rtl' ? 'لوحة الأدمن' : 'Admin'}</span>
            </Link>
          )}
        </div>
        
        {/* Right: Actions */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Language Toggle */}
          <div className="relative">
            <button
              ref={langButtonRef}
              type="button"
              onClick={() => setIsLangOpen(!isLangOpen)}
              aria-label={dir === 'rtl' ? 'تغيير اللغة' : 'Change language'}
              aria-expanded={isLangOpen}
              aria-haspopup="menu"
              className="w-11 h-11 rounded-full bg-zinc-900/80 border border-zinc-800/60 flex items-center justify-center text-zinc-300 hover:text-white hover:border-olive/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold transition-all shadow-sm"
            >
              <Globe className="w-5 h-5" strokeWidth={2} aria-hidden="true" />
            </button>

            {/* NOT A WINDOW. This transparent full-screen layer is the pointer
                click-catcher that makes "tap anywhere else to dismiss" work,
                and it also swallows the press that would otherwise reach the
                page behind the open menu. It has no material, no content and
                nothing to arrive from, so it stays a plain div rather than
                being forced through the overlay primitive. It sits at z-40,
                below the menu's z-50, exactly as before. */}
            {isLangOpen && (
              <div
                className="fixed inset-0 z-40"
                onClick={() => setIsLangOpen(false)}
              />
            )}

            {/* THE LANGUAGE MENU. It used to be a hand-rolled motion.div that
                animated its own HEIGHT from 0 with an eased 200ms tween — an
                unfolding blind, not a window, and a tween cannot be caught: a
                second tap during the 200ms restarts from the top instead of
                continuing from where the panel actually is.

                `Anchored` is the right primitive here rather than `Overlay`.
                This is not a task that takes the page over — it is three
                radio-ish choices that belong to the globe button, so it must
                stay welded to that button: no scrim, no page dimming, no
                portal, and it scales OUT OF the trigger (`anchor`) so the
                relationship between the control and what it produced is
                visible. Routing it through `Overlay` would have centred it in
                the viewport and dimmed the store behind it, which is a much
                heavier promise than picking a language deserves.

                RTL: the old code branched on `dir` to pick left-0 vs right-0.
                `align="end"` says the same thing logically — the menu hangs
                from the trigger's trailing edge — and mirrors itself, so there
                is no second rule to keep in sync for Arabic and Kurdish.

                The primitive owns Escape and outside-mousedown dismissal, which
                this menu never had; the geometry it does not own (its 8rem
                width, and the overflow clip that keeps the first and last rows
                inside the corner radius) stays here in className. */}
            <Anchored
              open={isLangOpen}
              onClose={() => setIsLangOpen(false)}
              anchor={langButtonRef}
              align="end"
              label={dir === 'rtl' ? 'تغيير اللغة' : 'Change language'}
              testId="header-language-menu"
              className="w-32 overflow-hidden"
            >
              {/* role=menuitem to match the role=menu the primitive supplies —
                  the trigger already advertised aria-haspopup="menu", so this
                  finishes a pairing the old markup only half-declared. */}
              <button role="menuitem" onClick={() => { setLang('en'); setIsLangOpen(false); }} className={`block w-full text-left px-4 py-2.5 text-sm ${lang === 'en' ? 'bg-olive/20 text-gold font-bold' : 'text-zinc-300 hover:bg-zinc-800 transition-colors'}`}>English</button>
              <button role="menuitem" onClick={() => { setLang('ar'); setIsLangOpen(false); }} className={`block w-full text-left px-4 py-2.5 text-sm ${lang === 'ar' ? 'bg-olive/20 text-gold font-bold' : 'text-zinc-300 hover:bg-zinc-800 transition-colors'}`}>العربية</button>
              <button role="menuitem" onClick={() => { setLang('ckb'); setIsLangOpen(false); }} className={`block w-full text-left px-4 py-2.5 text-sm ${lang === 'ckb' ? 'bg-olive/20 text-gold font-bold' : 'text-zinc-300 hover:bg-zinc-800 transition-colors'}`}>کوردی</button>
            </Anchored>
          </div>

          {/* Subscription Button — the plans page is browsable signed out now,
              so a guest goes straight to it. Sending them through /auth first
              asked for an account before showing what it costs. */}
          <Link
            to="/subscription"
            className={`relative rounded-full overflow-hidden flex items-center h-11 group ${
              subTier !== 'free' ? 'p-[1.5px]' : 'border border-zinc-800/60'
            }`}
          >
            {subTier !== 'free' && (
              <div 
                className="absolute top-1/2 left-1/2 w-[300%] h-[300%] -translate-x-1/2 -translate-y-1/2 animate-spin pointer-events-none"
                style={{ 
                  backgroundImage: subTier === 'pro' ? 'conic-gradient(from 0deg, transparent 70%, #7f1d1d 85%, #B03142 100%)' : 'conic-gradient(from 0deg, transparent 70%, var(--color-olive-light) 85%, #59A846 100%)',
                  animationDuration: '3s'
                }}
              />
            )}
            
            <div className={`relative h-full px-4 rounded-full flex items-center gap-1.5 z-10 w-full transition-colors ${
              subTier !== 'free' 
                ? 'bg-black hover:bg-zinc-900' 
                : 'bg-zinc-900/80 hover:bg-zinc-800/80'
            }`}>
              <span className={`text-[13px] tracking-wide capitalize ${
                subTier !== 'free' ? 'text-white font-bold' : 'text-zinc-300 font-medium'
              }`}>
                {subTier}
              </span>
              {subTier !== 'free' && <Check className={`w-4 h-4 ${subTier === 'pro' ? 'text-[#B03142]' : 'text-[#59A846]'}`} strokeWidth={3} />}
            </div>
          </Link>
        </div>
      </div>

      {/* Search Bar — a real form: submits on Enter/Go on mobile keyboards
          AND via the (44px) icon button, and lands on the products page
          with the query actually applied (?search=). */}
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (searchQuery.trim()) {
            navigate('/products?search=' + encodeURIComponent(searchQuery.trim()));
            setSearchQuery('');
          }
        }}
        className={`relative w-full max-w-4xl mx-auto pointer-events-auto transition-all duration-500 ease-in-out ${isScrolled ? 'mt-0' : 'mt-1'}`}
      >
        <button
          type="submit"
          aria-label={t('search')}
          className="absolute top-1/2 -translate-y-1/2 start-0 w-11 h-11 flex items-center justify-center text-zinc-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold rounded-full transition-colors"
        >
          <Search className={`transition-all duration-500 ${isScrolled ? 'w-4 h-4' : 'w-5 h-5'}`} strokeWidth={2.5} aria-hidden="true" />
        </button>
        <input
          type="search"
          enterKeyHint="search"
          placeholder={t('search')}
          aria-label={t('search')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className={`w-full backdrop-blur-xl border border-white/10 rounded-full pe-4 text-white placeholder-zinc-400 focus:border-olive focus:ring-1 focus:ring-olive focus:outline-none transition-all duration-500 font-medium shadow-sm ${
            isScrolled
              ? 'h-[44px] ps-11 text-[14px] bg-zinc-900/60 focus:bg-zinc-800/80'
              : 'h-[52px] ps-12 text-[15px] bg-black/40 focus:bg-black/60'
          }`}
        />
      </form>

      {/* Subscription-based border line when scrolled */}
      <div className={`absolute bottom-0 left-0 right-0 h-[2px] w-full overflow-hidden transition-opacity duration-500 ${isScrolled ? 'opacity-100' : 'opacity-0'}`}>
         {subTier === 'free' ? (
           <div className="w-full h-full bg-zinc-800/80" />
         ) : (
           <div 
             className="w-[200%] h-full" 
             style={{ 
               background: subTier === 'pro'
                 ? 'linear-gradient(to right, #ff0000, #ff4d4d, #B03142, #7f1d1d, #B03142, #ff4d4d, #ff0000)'
                 : 'linear-gradient(to right, #59A846, #a3e635, var(--color-olive-light), var(--color-olive), var(--color-olive-light), #a3e635, #59A846)',
               backgroundSize: '50% 100%',
               animation: 'rainbow 3s linear infinite'
             }} 
           />
         )}
      </div>
    </header>
  );
}
