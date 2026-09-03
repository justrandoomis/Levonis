/**
 * Admin / merchant dashboard shell (mandate §6.2).
 *
 * Three things this file is responsible for and used to get wrong:
 *
 * 1. STACKING. The scrolling content column used to carry `relative z-0`.
 *    A z-index other than `auto` opens a stacking context, so ANY
 *    `position:fixed` overlay rendered inside page content (the product
 *    import dialog, editor dialogs, dropdowns) was painted *inside* that
 *    context — i.e. under the sidebar (z-20) and the topbar. No amount of
 *    z-index inside the dialog could escape it. The column is now a plain
 *    `relative` (no z-index) and dialogs portal to document.body; the only
 *    z-indexes left here are the shell's own three layers.
 * 2. GRID. Content is a `min-w-0 flex-1` column beside a real, measured
 *    sidebar width — the sidebar never pushes content off-screen, and it
 *    collapses to an icon rail (≥lg) or a drawer (<lg) on iPad/phone.
 * 3. DENSITY + RTL. One consistent scale (no page-wide transform:scale, no
 *    arbitrary font shrinking) and CSS logical properties (border-e, ps/pe,
 *    ms/me, start/end) so Arabic and English lay out from the same classes.
 */

import React, { ReactNode, useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Bell, Menu, User, ArrowLeft, ArrowRight, Globe, LogOut, X,
  Settings as SettingsIcon, ChevronsLeft, ChevronsRight,
} from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../AuthContext';
import { api } from '../lib/api';

interface SidebarItem {
  id: string;
  icon: React.ElementType;
  label: string;
}

interface DashboardLayoutProps {
  title?: string;
  sidebarItems: SidebarItem[];
  activeTab: string;
  onTabChange: (id: string) => void;
  children: ReactNode;
  /**
   * Compact topbar: no community/dashboard links; instead an empty slot
   * (#dash-topbar-slot) the active page may fill through a portal — the
   * admin products page puts its breadcrumb and ⌘K quick-find there, so the
   * bar reads breadcrumb · search · language · notifications · account.
   */
  topbarSlot?: boolean;
}

const STRINGS = {
  ar: {
    mainMenu: 'القائمة الرئيسية',
    community: 'مجتمع ليفو',
    dashboard: 'لوحة التحكم',
    notifications: 'الإشعارات',
    noNotifications: 'لا توجد إشعارات',
    myStore: 'متجري',
    settings: 'الإعدادات',
    logout: 'تسجيل الخروج',
    viewPage: 'عرض صفحتي في ليفو',
    setupPage: 'إعداد صفحتي في ليفو',
    openMenu: 'فتح القائمة',
    closeMenu: 'إغلاق القائمة',
    collapse: 'طيّ الشريط الجانبي',
    expand: 'توسيع الشريط الجانبي',
    language: 'اللغة',
  },
  en: {
    mainMenu: 'MAIN MENU',
    community: 'Levo Community',
    dashboard: 'Dashboard',
    notifications: 'Notifications',
    noNotifications: 'No notifications',
    myStore: 'My Store',
    settings: 'Settings',
    logout: 'Logout',
    viewPage: 'View My Levo Page',
    setupPage: 'Set Up My Levo Page',
    openMenu: 'Open menu',
    closeMenu: 'Close menu',
    collapse: 'Collapse sidebar',
    expand: 'Expand sidebar',
    language: 'Language',
  },
  ckb: {
    mainMenu: 'لیستی سەرەکی',
    community: 'کۆمەڵگای لێڤۆ',
    dashboard: 'داشبۆرد',
    notifications: 'ئاگادارکردنەوەکان',
    noNotifications: 'هیچ ئاگادارکردنەوەیەک نییە',
    myStore: 'فرۆشگاکەم',
    settings: 'ڕێکخستنەکان',
    logout: 'دەرچوون',
    viewPage: 'بینینی پەڕەکەم لە لێڤۆ',
    setupPage: 'ڕێکخستنی پەڕەکەم لە لێڤۆ',
    openMenu: 'کردنەوەی لیست',
    closeMenu: 'داخستنی لیست',
    collapse: 'نوقاندنی لای لیست',
    expand: 'فراوانکردنی لای لیست',
    language: 'زمان',
  },
} as const;

const COLLAPSE_KEY = 'levo_dash_sidebar_collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

export default function DashboardLayout({ title = 'LEVO', sidebarItems, activeTab, onTabChange, children, topbarSlot }: DashboardLayoutProps) {
  const { dir, lang, setLang } = useLanguage();
  const t = STRINGS[lang] ?? STRINGS.ar;
  const navigate = useNavigate();
  const { isAuthenticated, logout } = useAuth();
  const [showNotifications, setShowNotifications] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showLangMenu, setShowLangMenu] = useState(false);
  const [showMobileSidebar, setShowMobileSidebar] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [myStoreId, setMyStoreId] = useState<string | null>(null);

  const userMenuRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const langRef = useRef<HTMLDivElement>(null);
  const drawerButtonRef = useRef<HTMLButtonElement>(null);

  // The user-menu "Settings" entry only makes sense when this shell actually
  // has a settings tab; the admin shell calls it 'store_settings'.
  const settingsTabId =
    sidebarItems.find((i) => i.id === 'settings')?.id ??
    sidebarItems.find((i) => i.id === 'store_settings')?.id ??
    null;

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setShowUserMenu(false);
      }
      if (notifRef.current && !notifRef.current.contains(event.target as Node)) {
        setShowNotifications(false);
      }
      if (langRef.current && !langRef.current.contains(event.target as Node)) {
        setShowLangMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Escape closes whichever menu is open (dialogs handle their own Escape).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setShowUserMenu(false);
      setShowNotifications(false);
      setShowLangMenu(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Rotating an iPad to landscape crosses the lg breakpoint and hides the
  // drawer by CSS — without this the drawer would stay "open" in state and
  // leave the body scroll locked behind an invisible dialog.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const sync = () => { if (mq.matches) setShowMobileSidebar(false); };
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        /* storage unavailable — the choice just does not persist */
      }
      return next;
    });
  };

  // Resolve the signed-in user's real community store id (if any) so the
  // "My Store" links can point at the actual page.
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    api
      .get<{ merchant: { id: string } | null }>('/api/community/my-store')
      .then((data) => {
        if (!cancelled && data.merchant) setMyStoreId(data.merchant.id);
      })
      .catch(() => { /* no store or transient error — fall back below */ });
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  const goToMyStore = () => {
    if (myStoreId) {
      navigate(`/community/store/${myStoreId}`);
    } else {
      navigate('/edit-profile');
    }
  };

  const handleLogout = async () => {
    try {
      await logout();
    } finally {
      navigate('/auth');
    }
  };

  const closeDrawer = useCallback(() => {
    setShowMobileSidebar(false);
    drawerButtonRef.current?.focus({ preventScroll: true });
  }, []);

  const CollapseIcon = collapsed
    ? (dir === 'rtl' ? ChevronsLeft : ChevronsRight)
    : (dir === 'rtl' ? ChevronsRight : ChevronsLeft);

  return (
    // h-dvh (not h-screen): on iPad Safari the browser chrome makes 100vh
    // taller than the visible area, which is what pushed the bottom of the
    // content column — and any footer inside it — off screen.
    <div className="flex h-dvh w-full bg-[#18181b] overflow-hidden font-sans" dir={dir}>
      {/* ------------------------------------------------ desktop sidebar */}
      <aside
        className={`hidden lg:flex flex-col shrink-0 bg-[#09090b] text-zinc-300 shadow-[4px_0_24px_rgba(0,0,0,0.3)] z-20 border-e border-zinc-800 transition-[width] duration-200 ${
          collapsed ? 'w-[4.5rem]' : 'w-[13.5rem] xl:w-[15.5rem]'
        }`}
      >
        <div className="px-3 py-4 flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={() => navigate('/')}
            className="flex items-center gap-2 min-w-0 flex-1 hover:opacity-80 transition-opacity text-start"
          >
            <span className="w-9 h-9 shrink-0 rounded-full bg-gradient-to-tr from-[#708238] to-[#9fae63] flex items-center justify-center font-bold text-base text-white shadow-lg">
              L
            </span>
            {!collapsed && (
              <span className="font-bold text-xs tracking-widest uppercase border border-zinc-700 px-2 py-1 rounded-lg text-white truncate">
                {title}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={toggleCollapsed}
            title={collapsed ? t.expand : t.collapse}
            aria-label={collapsed ? t.expand : t.collapse}
            className="shrink-0 p-2 rounded-lg text-zinc-500 hover:text-white hover:bg-zinc-800 transition-colors"
          >
            <CollapseIcon className="w-4 h-4" />
          </button>
        </div>

        {!collapsed && (
          <div className="px-4 pb-1 text-[10px] font-bold text-zinc-500 tracking-widest uppercase">
            {t.mainMenu}
          </div>
        )}

        <nav className="flex-1 min-h-0 px-2 py-2 space-y-1 overflow-y-auto">
          {sidebarItems.map((item) => (
            <button
              key={item.id}
              // Stable hook: the tab is local state, not a URL, so browser
              // verification needs a way to reach a known panel.
              data-tab={item.id}
              onClick={() => onTabChange(item.id)}
              title={collapsed ? item.label : undefined}
              aria-current={activeTab === item.id ? 'page' : undefined}
              className={`w-full flex items-center gap-3 min-h-11 rounded-xl transition-colors font-medium text-start ${
                collapsed ? 'justify-center px-2 py-2.5' : 'px-3 py-2.5'
              } ${
                activeTab === item.id
                  ? 'bg-[#708238] text-white shadow-[0_4px_15px_rgba(112,130,56,0.3)]'
                  : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-white'
              }`}
            >
              <item.icon className="w-5 h-5 shrink-0" />
              {!collapsed && <span className="text-[13px] truncate min-w-0">{item.label}</span>}
            </button>
          ))}
        </nav>

        <div className="p-3 mt-auto shrink-0">
          <button
            type="button"
            onClick={goToMyStore}
            title={myStoreId ? t.viewPage : t.setupPage}
            className={`w-full rounded-2xl bg-gradient-to-br from-zinc-800 to-zinc-900 border border-zinc-700 shadow-lg flex flex-col items-center justify-center group hover:border-[#D4AF37] transition-all ${
              collapsed ? 'p-2.5' : 'p-4'
            }`}
          >
            <User className={`text-[#D4AF37] group-hover:scale-110 transition-transform ${collapsed ? 'w-5 h-5' : 'w-8 h-8 mb-2'}`} />
            {!collapsed && (
              <span className="text-[11px] font-bold text-white text-center leading-snug">
                {myStoreId ? t.viewPage : t.setupPage}
              </span>
            )}
          </button>
        </div>
      </aside>

      {/* --------------------------------------------------- mobile drawer */}
      {showMobileSidebar && (
        <MobileDrawer
          title={title}
          items={sidebarItems}
          activeTab={activeTab}
          dir={dir}
          closeLabel={t.closeMenu}
          menuLabel={t.mainMenu}
          onSelect={(id) => { onTabChange(id); closeDrawer(); }}
          onClose={closeDrawer}
        />
      )}

      {/* ---------------------------------------------------- content column */}
      {/* `relative` with NO z-index: a z-index here would open a stacking
          context and trap every dialog rendered inside the page. */}
      <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden relative bg-[#18181b]">
        {/* Topbar — above the sidebar so its dropdowns are never clipped by it. */}
        <header className="h-14 sm:h-16 flex items-center gap-3 px-3 sm:px-5 shrink-0 z-30 w-full bg-[#18181b]/95 backdrop-blur-md border-b border-zinc-800/50">
          <button
            ref={drawerButtonRef}
            data-action="open-sidebar"
            onClick={() => setShowMobileSidebar(true)}
            aria-label={t.openMenu}
            aria-expanded={showMobileSidebar}
            className="lg:hidden p-2 min-h-11 min-w-11 flex items-center justify-center bg-zinc-800 rounded-xl text-zinc-300 hover:text-white transition-colors shrink-0"
          >
            <Menu className="w-5 h-5" />
          </button>

          {topbarSlot ? (
            <div id="dash-topbar-slot" className="flex-1 min-w-0 flex items-center gap-3 sm:gap-5" />
          ) : (
            <div className="hidden lg:flex items-center gap-6 text-[13px] font-semibold text-zinc-400 min-w-0">
              <button
                onClick={() => navigate('/community')}
                className="hover:text-white transition-colors flex items-center gap-2 whitespace-nowrap"
              >
                {dir === 'rtl' ? <ArrowRight className="w-4 h-4" /> : <ArrowLeft className="w-4 h-4" />}
                {t.community}
              </button>
              <span className="text-white font-bold border-b-2 border-[#D4AF37] py-1 whitespace-nowrap">
                {t.dashboard}
              </span>
            </div>
          )}

          <div className="flex items-center gap-2 sm:gap-4 ms-auto text-zinc-400 shrink-0">
            {/* Language */}
            <div className="relative" ref={langRef}>
              <button
                onClick={() => setShowLangMenu(!showLangMenu)}
                aria-label={t.language}
                aria-expanded={showLangMenu}
                className="hover:text-[#D4AF37] transition-colors flex items-center gap-1.5 min-h-11 px-1"
              >
                <Globe className="w-5 h-5 stroke-[2]" />
                <span className="text-xs font-bold uppercase hidden sm:block">{lang}</span>
              </button>
              {showLangMenu && (
                <div className="absolute top-11 end-0 w-32 bg-zinc-900 border border-zinc-800 rounded-xl shadow-xl py-1.5 z-50">
                  {(['en', 'ar', 'ckb'] as const).map((l) => (
                    <button
                      key={l}
                      onClick={() => { setLang(l); setShowLangMenu(false); }}
                      className={`w-full text-start px-3 py-2 text-sm hover:bg-zinc-800 ${lang === l ? 'text-[#D4AF37] font-bold' : 'text-zinc-400'}`}
                    >
                      {l === 'en' ? 'English' : l === 'ar' ? 'العربية' : 'کوردی'}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Notifications — no notification backend exists, so no fake badge */}
            <div className="relative" ref={notifRef}>
              <button
                onClick={() => setShowNotifications(!showNotifications)}
                aria-label={t.notifications}
                aria-expanded={showNotifications}
                className="hover:text-[#D4AF37] transition-colors min-h-11 px-1 flex items-center"
              >
                <Bell className="w-5 h-5 stroke-[2]" />
              </button>
              {showNotifications && (
                <div className="absolute top-11 end-0 w-64 max-w-[80vw] bg-zinc-900 border border-zinc-800 rounded-2xl shadow-xl py-1.5 z-50">
                  <div className="px-3 py-2 border-b border-zinc-800 font-bold text-white text-sm">{t.notifications}</div>
                  <div className="px-3 py-5 text-center text-sm text-zinc-500">{t.noNotifications}</div>
                </div>
              )}
            </div>

            {/* User menu */}
            <div className="relative" ref={userMenuRef}>
              <button
                onClick={() => setShowUserMenu(!showUserMenu)}
                aria-label={t.myStore}
                aria-expanded={showUserMenu}
                className="w-9 h-9 rounded-full bg-zinc-800 flex items-center justify-center overflow-hidden shadow-sm border border-zinc-600 hover:border-[#D4AF37] transition-colors"
              >
                <User className="w-5 h-5 text-zinc-400" />
              </button>
              {showUserMenu && (
                <div className="absolute top-11 end-0 w-48 bg-zinc-900 border border-zinc-800 rounded-2xl shadow-xl py-1.5 z-50">
                  <button onClick={() => { setShowUserMenu(false); goToMyStore(); }} className="w-full text-start px-3 py-2.5 text-sm hover:bg-zinc-800 text-zinc-300 flex items-center gap-2">
                    <User className="w-4 h-4" /> {t.myStore}
                  </button>
                  {settingsTabId && (
                    <button onClick={() => { setShowUserMenu(false); onTabChange(settingsTabId); }} className="w-full text-start px-3 py-2.5 text-sm hover:bg-zinc-800 text-zinc-300 flex items-center gap-2">
                      <SettingsIcon className="w-4 h-4" /> {t.settings}
                    </button>
                  )}
                  <div className="h-px bg-zinc-800 my-1" />
                  <button onClick={handleLogout} className="w-full text-start px-3 py-2.5 text-sm hover:bg-zinc-800 text-red-400 flex items-center gap-2">
                    <LogOut className="w-4 h-4" /> {t.logout}
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* Scrollable content. min-w-0/min-h-0 stop wide tables and long
            columns from forcing horizontal page scroll or clipping.

            THE BOTTOM PADDING IS PUBLISHED as --admin-main-pb. A sticky
            footer inside a screen (the product form's save bar) can only
            travel to the bottom of ITS OWN box, which this padding holds
            short of the glass — so a screen that wants a bar on the bottom
            edge cancels exactly this much, and cannot drift out of sync with
            it by hard-coding a number. */}
        <main
          className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden px-3 sm:px-5 xl:px-8 py-4 sm:py-6 custom-scrollbar relative"
          style={
            {
              '--admin-main-pb': 'max(1rem, env(safe-area-inset-bottom))',
              paddingBottom: 'var(--admin-main-pb)',
            } as React.CSSProperties
          }
        >
          {children}
        </main>
      </div>
    </div>
  );
}

/**
 * Sidebar drawer for iPad/phone. Portaled to document.body for the same
 * reason dialogs are: no ancestor can clip it or trap it in a stacking
 * context. Escape closes it, focus starts inside and returns to the opener.
 */
function MobileDrawer({
  title, items, activeTab, dir, closeLabel, menuLabel, onSelect, onClose,
}: {
  title: string;
  items: SidebarItem[];
  activeTab: string;
  dir: 'ltr' | 'rtl';
  closeLabel: string;
  menuLabel: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      dir={dir}
      className="fixed inset-0 z-[900] lg:hidden"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={menuLabel}
        className="absolute inset-y-0 start-0 w-72 max-w-[85%] bg-[#09090b] text-zinc-300 flex flex-col border-e border-zinc-800 shadow-2xl p-4"
        style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
      >
        <div className="flex items-center justify-between gap-2 mb-4 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-9 h-9 shrink-0 rounded-full bg-gradient-to-tr from-[#708238] to-[#9fae63] flex items-center justify-center font-bold text-base text-white">
              L
            </span>
            <span className="font-bold text-sm uppercase text-white truncate">{title}</span>
          </div>
          <button
            onClick={onClose}
            aria-label={closeLabel}
            className="p-2 min-h-11 min-w-11 flex items-center justify-center text-zinc-400 hover:text-white rounded-lg hover:bg-zinc-800 shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav className="flex-1 min-h-0 space-y-1 overflow-y-auto">
          {items.map((item) => (
            <button
              key={item.id}
              // Same hook as the desktop sidebar, so verification can reach a
              // panel at any viewport width.
              data-tab={item.id}
              onClick={() => onSelect(item.id)}
              aria-current={activeTab === item.id ? 'page' : undefined}
              className={`w-full flex items-center gap-3 min-h-11 px-3 py-2.5 rounded-xl font-medium transition-colors text-start ${
                activeTab === item.id ? 'bg-[#708238] text-white' : 'text-zinc-400 hover:bg-zinc-800'
              }`}
            >
              <item.icon className="w-5 h-5 shrink-0" />
              <span className="text-sm truncate min-w-0">{item.label}</span>
            </button>
          ))}
        </nav>
      </div>
    </div>,
    document.body
  );
}
