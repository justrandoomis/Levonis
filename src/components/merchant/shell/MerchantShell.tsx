/**
 * THE MERCHANT WORKSPACE — the frame every workspace screen lives in.
 *
 * A full-screen tree of its own (src/App.tsx `isFullScreenRoute`), not a page
 * inside the customer shell: no customer bottom bar, no mascot, one scroll
 * owner (`data-scroll-owner`, which the overlay lock knows —
 * src/components/ui/Overlay.tsx `acquireModalLock`).
 *
 *   desktop (≥1024)  a collapsible, grouped sidebar + a top bar
 *   tablet (640–1023) the same sidebar as an icon rail
 *   phone (<640)     a compact top bar and an in-flow bottom bar:
 *                    Overview · Orders · Products · Store · More
 *
 * Every one of those reads ONE nav table (./nav.ts), and so does the command
 * palette (⌘K / Ctrl+K, or the search field). The top bar carries the store —
 * its identity and a status pill from `/api/merchant/me` that says WHY when it
 * is not open — global search, quick create (real routes only), «عرض المتجر»
 * (the store's own address), «تصميم المتجر», and the store's bell with the
 * real unread count.
 *
 * WHAT MUST SURVIVE FROM THE OLD PAGE (MerchantDashboardPage's header):
 *   · READING NEVER STOPS — every screen stays reachable when PLUS lapses or
 *     the store is paused; the banner under the top bar says why selling is
 *     off, and each screen's own controls say why they are disabled;
 *   · capabilities are the server's (`me.can`, `me.selling`), never a tier
 *     string read here;
 *   · on a store's own subdomain the same tree lives under `/admin`, and only
 *     for that store's owner (the page checks before this renders — B16).
 *
 * Each screen is `React.lazy` (./sections.tsx) behind its own skeleton and a
 * chunk boundary, so a screen that fails to download cannot blank the frame.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ChevronsLeft, ChevronsRight, ExternalLink, MoreHorizontal, Palette, Plus, Search, Store } from 'lucide-react';
import { useLanguage } from '../../../LanguageContext';
import { api } from '../../../lib/api';
import { formatMoney } from '../../../lib/money';
import type { MerchantMe } from '../../../lib/merchant';
import {
  MERCHANT_BASE, STORE_HOST_BASE, hostPath, merchantHref, parseMerchantPath, readWorkspaceQuery, type MerchantSection,
} from '../../../lib/merchantRoutes';
import { useIsPhone } from '../../../lib/useMediaQuery';
import ChunkBoundary from '../../ChunkBoundary';
import { IconButton } from '../../ui/Button';
import { Menu, type MenuEntry } from '../../ui/Menu';
import { Toaster } from '../../ui/Toast';
import MerchantNotificationBell from '../notifications/MerchantNotificationBell';
import { useAttention, type Attention } from './attention';
import { WorkspaceContext, type WorkspaceValue } from './context';
import { NAV, PHONE_TABS, badgeCount, moreEntries, navEntry, navGroups, phoneTabFor, sectionPath, type NavEntry } from './nav';
import { SEARCH_DEBOUNCE_MS, isPaletteKey, paletteGroups, searchable, type QuickAction, type SearchResults } from './paletteModel';
import { resolveWorkspaceRoute } from './routeTable';
import { SECTIONS } from './sections';
import SectionFallback from './SectionFallback';
import { storeStatus } from './status';
import { W, say } from './strings';

// Fetched the first time they are opened — neither is needed to draw the frame.
const CommandPalette = lazy(() => import('../../ui/CommandPalette').then((m) => ({ default: m.CommandPalette })));
const MoreSheet = lazy(() => import('./MoreSheet'));

const COLLAPSE_KEY = 'levo_merchant_sidebar_collapsed';
/** The phone tab bar's height; toasts and sticky bars sit above it. */
const TAB_BAR_PX = 64;

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

const TONE: Record<'success' | 'warning' | 'danger', string> = {
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-danger/10 text-danger',
};
const DOT: Record<'success' | 'warning' | 'danger', string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

export interface MerchantShellProps {
  me: MerchantMe;
  reloadMe: () => void;
  /** This page is the store's own subdomain (`/admin`), not the platform's `/merchant`. */
  onStoreHost: boolean;
  /** The platform's own address, for pages the workspace links out to. */
  mainOrigin: string | null;
}

export default function MerchantShell({ me, reloadMe, onStoreHost, mainOrigin }: MerchantShellProps) {
  const { loc } = useLanguage();
  const location = useLocation();
  const navigate = useNavigate();
  const isPhone = useIsPhone();
  const store = me.store!;
  const canSell = me.selling.canSell;
  const base = onStoreHost ? STORE_HOST_BASE : MERCHANT_BASE;

  const route = resolveWorkspaceRoute(location.pathname, base);
  const section: MerchantSection | null = route.kind === 'section' ? route.section : null;
  const id = route.kind === 'section' ? route.id : undefined;
  const query = useMemo(() => readWorkspaceQuery(location.search), [location.search]);

  const attention = useAttention();
  const [bellUnread, setBellUnread] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreMounted, setMoreMounted] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMounted, setPaletteMounted] = useState(false);
  const scroller = useRef<HTMLDivElement | null>(null);

  const mainHref = useCallback(
    (path: string) => (onStoreHost && mainOrigin ? `${mainOrigin}${path}` : path),
    [onStoreHost, mainOrigin]
  );
  const href = useCallback((link: string) => hostPath(link, onStoreHost), [onStoreHost]);
  const resolveLink = useCallback(
    (link: string) => {
      if (parseMerchantPath(link) || parseMerchantPath(link, base)) return { internal: true, to: hostPath(link, onStoreHost) };
      // A platform page: from a store's subdomain it is another site.
      return onStoreHost ? { internal: false, to: mainHref(link) } : { internal: true, to: link };
    },
    [base, onStoreHost, mainHref]
  );
  const go = useCallback(
    (link: string, opts?: { replace?: boolean }) => {
      const t = resolveLink(link);
      if (t.internal) navigate(t.to, { replace: !!opts?.replace });
      else window.location.assign(t.to);
    },
    [navigate, resolveLink]
  );
  const clearQuery = useCallback(() => {
    const params = new URLSearchParams(location.search);
    if (!params.has('new')) return;
    params.delete('new');
    const rest = params.toString();
    navigate(`${location.pathname}${rest ? `?${rest}` : ''}`, { replace: true });
  }, [location.pathname, location.search, navigate]);

  // ---- the router's verdicts that are not a screen
  const created = !!(location.state as { created?: string } | null)?.created;
  useEffect(() => {
    if (route.kind === 'redirect') navigate(route.to, { replace: true });
    else if (route.kind === 'away') go(route.to, { replace: true });
    // A brand-new store lands on its printers, not on an empty Command Center:
    // they decide whether Levonis can ever match a print request to this shop.
    else if (created && route.section === 'home') navigate(sectionPath('printers', base), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  // ---- a new screen starts at its top, and the counts are re-read (at most every 15 s)
  const refreshAttention = attention.refresh;
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
    refreshAttention();
  }, [section, id, refreshAttention]);

  // ---- ⌘K / Ctrl+K anywhere in the workspace
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isPaletteKey(e)) return;
      e.preventDefault();
      setPaletteMounted(true);
      setPaletteOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- the phone tab bar owns the bottom edge: toasts sit above it
  useEffect(() => {
    if (!isPhone) return;
    const root = document.documentElement;
    const before = root.style.getPropertyValue('--shell-bottom-inset');
    root.style.setProperty('--shell-bottom-inset', `${TAB_BAR_PX}px`);
    return () => {
      if (before) root.style.setProperty('--shell-bottom-inset', before);
      else root.style.removeProperty('--shell-bottom-inset');
    };
  }, [isPhone]);

  // ---- the tab's title says where the merchant is
  const current = section ? navEntry(section) : undefined;
  useEffect(() => {
    const previous = document.title;
    document.title = `${current ? say(loc, current.label) : say(loc, W.overview)} · ${store.name}`;
    return () => {
      document.title = previous;
    };
  }, [current, loc, store.name]);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
      } catch {
        /* a remembered sidebar is a convenience */
      }
      return !c;
    });
  };

  const openPalette = () => {
    setPaletteMounted(true);
    setPaletteOpen(true);
  };

  const ws: WorkspaceValue = {
    me,
    store,
    canSell,
    base,
    onStoreHost,
    href,
    mainHref,
    resolveLink,
    go,
    query,
    clearQuery,
    reloadMe,
    attention,
    setBellUnread,
  };

  const status = storeStatus(me);
  const a = attention.data;
  const Screen = section ? SECTIONS[section] : null;

  return (
    <WorkspaceContext.Provider value={ws}>
      <div className="flex h-[100dvh] w-full min-w-0 flex-1 overflow-hidden bg-canvas text-text-primary" data-merchant-shell data-section={section ?? ''}>
        <a
          href="#ws-content"
          className="sr-only focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-[300] focus:rounded-md focus:bg-surface-raised focus:px-3 focus:py-2 focus:text-[13px]"
        >
          {say(loc, W.skipToContent)}
        </a>

        <SideNav base={base} current={section} collapsed={collapsed} onToggle={toggleCollapsed} attention={a} store={store} status={status} />

        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar
            store={store}
            status={status}
            collapsed={collapsed}
            canSell={canSell}
            sellingReason={status.reason(loc)}
            onSearch={openPalette}
            bell={<MerchantNotificationBell onOpen={() => navigate(sectionPath('notifications', base))} unread={bellUnread} />}
            base={base}
            href={href}
          />

          <div
            ref={scroller}
            id="ws-content"
            data-scroll-owner
            role={onStoreHost ? 'main' : undefined}
            tabIndex={-1}
            className="min-h-0 flex-1 overflow-y-auto overflow-x-clip overscroll-contain focus:outline-none"
          >
            <div className="mx-auto w-full max-w-6xl px-4 pb-10 pt-5 sm:px-6 lg:px-8 lg:pt-7">
              {status.key !== 'open' && section !== 'home' && (
                <p
                  role="note"
                  data-selling-off={status.key}
                  className="mb-5 rounded-e-2xl border-s-2 border-s-warning/70 bg-warning/[0.06] py-2.5 pe-4 ps-3.5 text-[13px] leading-relaxed text-text-secondary"
                >
                  {status.reason(loc)}{' '}
                  {/* The data is never what stops: said once, under the reason. */}
                  {loc(
                    'البيع متوقّف حاليًا، لكن كل بياناتك وطلباتك وأرباحك محفوظة ويمكنك متابعتها.',
                    'Selling is paused, but all your data, orders and earnings are kept and still visible.',
                    'فرۆشتن ڕاگیراوە، بەڵام هەموو داتاکانت پارێزراون.'
                  )}
                </p>
              )}
              {current && section !== 'home' && (
                <h1 className={current.ownHeading ? 'sr-only' : 'mb-5 text-[20px] font-bold leading-tight text-text-primary'} data-section-title>
                  {say(loc, current.label)}
                </h1>
              )}
              {Screen && section ? (
                <ChunkBoundary>
                  <Suspense key={section} fallback={<SectionFallback section={section} />}>
                    <Screen id={id} />
                  </Suspense>
                </ChunkBoundary>
              ) : (
                <SectionFallback section="home" />
              )}
            </div>
          </div>

          <BottomTabs base={base} current={section} attention={a} onMore={() => {
            setMoreMounted(true);
            setMoreOpen(true);
          }} />
        </div>

        {moreMounted && (
          <Suspense fallback={null}>
            <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} base={base} current={section} attention={a} />
          </Suspense>
        )}
        {paletteMounted && (
          <Suspense fallback={null}>
            <WorkspacePalette open={paletteOpen} onOpenChange={setPaletteOpen} base={base} storeUrl={store.url} canSell={canSell} href={href} recentKey={`levo_merchant_palette_${store.id}`} />
          </Suspense>
        )}
        <Toaster />
      </div>
    </WorkspaceContext.Provider>
  );
}

// ------------------------------------------------------------------ sidebar

function CountBadge({ n, compact }: { n: number | null; compact?: boolean }) {
  if (!n) return null;
  if (compact) return <span aria-hidden="true" className="absolute end-2 top-2 h-2 w-2 rounded-full bg-gold ring-2 ring-surface" />;
  return (
    <span aria-hidden="true" className="ms-auto shrink-0 rounded-full bg-white/[0.08] px-2 text-[12px] font-semibold leading-6 tabular-nums text-text-primary" dir="ltr">
      {n > 99 ? '99+' : n}
    </span>
  );
}

function NavLink({ entry, base, active, count, labelClass, compactBadge }: { entry: NavEntry; base: string; active: boolean; count: number | null; labelClass: string; compactBadge: string }) {
  const { loc } = useLanguage();
  const label = say(loc, entry.label);
  const Icon = entry.icon;
  return (
    <Link
      to={sectionPath(entry.id, base)}
      aria-current={active ? 'page' : undefined}
      // The count is part of the name a screen reader hears, not only a painted pill.
      aria-label={count ? `${label} (${count})` : undefined}
      title={label}
      data-nav={entry.id}
      className={`relative flex min-h-11 items-center gap-3 rounded-lg px-3 text-[14px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
        active ? 'bg-surface-selected font-semibold text-text-primary' : 'text-text-secondary hover:bg-white/[0.04] hover:text-text-primary'
      }`}
    >
      {active && <span aria-hidden="true" className="absolute inset-y-2 start-0 w-0.5 rounded-full bg-gold" />}
      <Icon aria-hidden="true" className={`h-[18px] w-[18px] shrink-0 ${active ? 'text-text-primary' : 'text-text-muted'}`} />
      <span className={`min-w-0 flex-1 truncate ${labelClass}`}>{label}</span>
      <span className={labelClass}>
        <CountBadge n={count} />
      </span>
      <span className={compactBadge}>
        <CountBadge n={count} compact />
      </span>
    </Link>
  );
}

function StoreMark({ store, size = 'md' }: { store: MerchantMe['store'] & object; size?: 'sm' | 'md' }) {
  const box = size === 'sm' ? 'h-8 w-8 rounded-lg' : 'h-9 w-9 rounded-xl';
  return (
    <span className={`${box} flex shrink-0 items-center justify-center overflow-hidden bg-surface-raised`}>
      {store.logoUrl ? <img src={store.logoUrl} alt="" className="h-full w-full object-cover" /> : <Store aria-hidden="true" className="h-4 w-4 text-gold" />}
    </span>
  );
}

function SideNav({
  base,
  current,
  collapsed,
  onToggle,
  attention,
  store,
  status,
}: {
  base: string;
  current: MerchantSection | null;
  collapsed: boolean;
  onToggle: () => void;
  attention: Attention | null;
  store: MerchantMe['store'] & object;
  status: ReturnType<typeof storeStatus>;
}) {
  const { loc } = useLanguage();
  // Tablet: always the rail. Desktop: the full sidebar, or the rail when collapsed.
  const labelClass = collapsed ? 'sr-only' : 'sr-only lg:not-sr-only';
  const compactBadge = collapsed ? '' : 'lg:hidden';
  const groupLabel = collapsed ? 'hidden' : 'hidden lg:block';
  return (
    <aside
      data-sidebar={collapsed ? 'collapsed' : 'expanded'}
      className={`hidden shrink-0 flex-col border-e border-border-subtle bg-surface sm:flex sm:w-[72px] ${collapsed ? '' : 'lg:w-64'}`}
    >
      <div className={`flex h-16 shrink-0 items-center gap-2.5 border-b border-border-subtle px-[18px] ${collapsed ? '' : 'lg:px-4'}`}>
        <StoreMark store={store} />
        <span className={`min-w-0 flex-1 ${labelClass}`}>
          <span className="block truncate text-[14px] font-semibold text-text-primary">{store.name}</span>
          <span className="flex items-center gap-1.5 text-[12px] text-text-muted">
            <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${DOT[status.tone]}`} />
            {say(loc, status.label)}
          </span>
        </span>
      </div>
      <nav aria-label={say(loc, W.mainMenu)} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">
        {navGroups(NAV).map((g, gi) => (
          <div key={g.id} className={gi > 0 && g.label ? 'mt-4' : gi > 0 ? 'mt-1' : ''}>
            {g.label && (
              <>
                <p className={`px-3 pb-1 text-[12px] font-medium text-text-muted ${groupLabel}`}>{say(loc, g.label)}</p>
                <div aria-hidden="true" className={`mx-3 mb-1 h-px bg-border-subtle ${collapsed ? '' : 'lg:hidden'}`} />
              </>
            )}
            <ul className="space-y-0.5">
              {g.entries.map((e) => (
                <li key={e.id}>
                  <NavLink entry={e} base={base} active={current === e.id} count={badgeCount(e.badge, attention)} labelClass={labelClass} compactBadge={compactBadge} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="hidden shrink-0 border-t border-border-subtle p-3 lg:block">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={say(loc, collapsed ? W.expand : W.collapse)}
          title={say(loc, collapsed ? W.expand : W.collapse)}
          className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-[13px] text-text-muted hover:bg-white/[0.04] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {collapsed ? <ChevronsLeft aria-hidden="true" className="h-[18px] w-[18px] shrink-0 ltr:-scale-x-100" /> : <ChevronsRight aria-hidden="true" className="h-[18px] w-[18px] shrink-0 ltr:-scale-x-100" />}
          <span className={labelClass}>{say(loc, W.collapse)}</span>
        </button>
      </div>
    </aside>
  );
}

// ------------------------------------------------------------------ top bar

function TopBar({
  store,
  status,
  collapsed,
  canSell,
  sellingReason,
  onSearch,
  bell,
  base,
  href,
}: {
  store: MerchantMe['store'] & object;
  status: ReturnType<typeof storeStatus>;
  collapsed: boolean;
  canSell: boolean;
  sellingReason: string;
  onSearch: () => void;
  bell: ReactNode;
  base: string;
  href: (link: string) => string;
}) {
  const { loc } = useLanguage();
  const statusText = say(loc, status.label);
  const statusName = `${say(loc, W.storeStatus)}: ${statusText}${status.key === 'open' ? '' : ` — ${status.reason(loc)}`}`;
  // Quick create — the section, with its «new» form open. Each one makes a
  // new commitment, so with selling off it stays in the menu and says why.
  const create: MenuEntry[] = [
    { id: 'new-product', label: say(loc, W.newProduct), href: href(merchantHref.newProduct()), disabled: !canSell, hint: canSell ? undefined : sellingReason },
    { id: 'new-coupon', label: say(loc, W.newCoupon), href: href(merchantHref.newCoupon()), disabled: !canSell, hint: canSell ? undefined : sellingReason },
    { id: 'new-collection', label: say(loc, W.newCollection), href: href(merchantHref.newCollection()), disabled: !canSell, hint: canSell ? undefined : sellingReason },
  ];
  // Identity sits here whenever the sidebar is not showing it: phone, tablet, and a collapsed desktop.
  const identity = collapsed ? '' : 'lg:hidden';
  return (
    <header className="flex h-16 shrink-0 items-center gap-2 border-b border-border-subtle bg-canvas px-2 sm:gap-3 sm:px-4 lg:px-6" data-workspace-topbar>
      <div className={`flex min-w-0 items-center gap-2.5 ps-1 sm:flex-none ${identity} max-sm:flex-1`}>
        <span className="relative shrink-0">
          <StoreMark store={store} size="sm" />
          <span aria-hidden="true" className={`absolute -bottom-0.5 -end-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-canvas sm:hidden ${DOT[status.tone]}`} />
        </span>
        <span className="min-w-0 truncate text-[14.5px] font-semibold text-text-primary sm:max-w-[10rem]">{store.name}</span>
      </div>

      <Link
        to={sectionPath('store_settings', base)}
        aria-label={statusName}
        title={status.key === 'open' ? statusText : status.reason(loc)}
        data-store-status={status.key}
        className={`lv-hit relative hidden min-h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus sm:inline-flex ${collapsed ? '' : 'lg:hidden'} ${TONE[status.tone]}`}
      >
        <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${DOT[status.tone]}`} />
        {statusText}
      </Link>

      {/* The search field is a button: it opens the palette, where the typing happens. */}
      <button
        type="button"
        onClick={onSearch}
        aria-haspopup="dialog"
        aria-keyshortcuts="Control+K Meta+K"
        data-workspace-search
        className="hidden min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-xl border border-border-subtle bg-surface px-3 text-start text-[13.5px] text-text-muted transition-colors hover:border-text-muted/40 hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus sm:flex sm:max-w-md"
      >
        <Search aria-hidden="true" className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{say(loc, W.searchPlaceholder)}</span>
        <kbd aria-hidden="true" dir="ltr" className="hidden shrink-0 rounded border border-border-subtle px-1.5 font-sans text-[11px] lg:inline">
          ⌘K
        </kbd>
      </button>

      <div className="ms-auto flex shrink-0 items-center gap-1 sm:gap-1.5">
        <span className="sm:hidden">
          <IconButton label={say(loc, W.search)} icon={<Search className="h-5 w-5" />} onClick={onSearch} data-workspace-search-icon />
        </span>
        <span className="hidden sm:inline-flex">
          <Menu
            label={say(loc, W.create)}
            items={create}
            align="end"
            trigger={(props) => (
              <button
                {...props}
                type="button"
                data-quick-create
                className="lv-button lv-button-secondary lv-button-sm"
              >
                <Plus aria-hidden="true" className="h-4 w-4" />
                <span className="hidden md:inline">{say(loc, W.create)}</span>
                <span className="sr-only md:hidden">{say(loc, W.create)}</span>
              </button>
            )}
          />
        </span>
        <Link
          to={sectionPath('store_design', base)}
          title={say(loc, W.storeDesign)}
          className="hidden min-h-11 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-text-secondary hover:bg-white/[0.04] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus xl:inline-flex"
          data-design-store
        >
          <Palette aria-hidden="true" className="h-4 w-4" />
          {say(loc, W.storeDesign)}
        </Link>
        <a
          href={store.url}
          target="_blank"
          rel="noopener noreferrer"
          title={say(loc, W.viewStore)}
          aria-label={say(loc, W.viewStore)}
          data-view-store
          className="inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-text-secondary hover:bg-white/[0.04] hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <ExternalLink aria-hidden="true" className="h-4 w-4" />
          <span className="hidden lg:inline">{say(loc, W.viewStore)}</span>
        </a>
        {bell}
      </div>
    </header>
  );
}

// ------------------------------------------------------------------ phone tabs

function BottomTabs({ base, current, attention, onMore }: { base: string; current: MerchantSection | null; attention: Attention | null; onMore: () => void }) {
  const { loc } = useLanguage();
  const lit = current ? phoneTabFor(current) : 'home';
  const moreCount = moreEntries().some((e) => (badgeCount(e.badge, attention) ?? 0) > 0);
  const tabClass = (active: boolean) =>
    `relative flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-lg text-[11px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${
      active ? 'text-text-primary' : 'text-text-muted'
    }`;
  return (
    <nav
      aria-label={say(loc, W.mainMenu)}
      data-bottom-tabs
      className="flex shrink-0 items-stretch gap-1 border-t border-border-subtle bg-surface px-2 pt-1.5 sm:hidden"
      style={{ minHeight: TAB_BAR_PX, paddingBottom: 'max(0.375rem, env(safe-area-inset-bottom))' }}
    >
      {PHONE_TABS.map((t) => {
        const entry = navEntry(t.section)!;
        const Icon = entry.icon;
        const active = lit === t.tab;
        const count = t.tab === 'orders' ? badgeCount('orders', attention) : t.tab === 'products' ? badgeCount('stock', attention) : null;
        const label = say(loc, t.label);
        return (
          <Link key={t.tab} to={sectionPath(t.section, base)} aria-current={active ? 'page' : undefined} aria-label={count ? `${label} (${count})` : undefined} data-tab={t.tab} className={tabClass(active)}>
            <span className="relative">
              {t.tab === 'store' ? <Store aria-hidden="true" className="h-5 w-5" /> : <Icon aria-hidden="true" className="h-5 w-5" />}
              {count ? <span aria-hidden="true" className="absolute -end-1.5 -top-1 h-2 w-2 rounded-full bg-gold ring-2 ring-surface" /> : null}
            </span>
            <span className="max-w-full truncate">{label}</span>
            {active && <span aria-hidden="true" className="absolute inset-x-5 top-0 h-0.5 rounded-full bg-gold" />}
          </Link>
        );
      })}
      <button type="button" onClick={onMore} aria-haspopup="dialog" data-tab="more" className={tabClass(lit === 'more')}>
        <span className="relative">
          <MoreHorizontal aria-hidden="true" className="h-5 w-5" />
          {moreCount && <span aria-hidden="true" className="absolute -end-1.5 -top-1 h-2 w-2 rounded-full bg-gold ring-2 ring-surface" />}
        </span>
        <span>{say(loc, W.more)}</span>
        {lit === 'more' && <span aria-hidden="true" className="absolute inset-x-5 top-0 h-0.5 rounded-full bg-gold" />}
      </button>
    </nav>
  );
}

// ------------------------------------------------------------------ palette

function WorkspacePalette({
  open,
  onOpenChange,
  base,
  storeUrl,
  canSell,
  href,
  recentKey,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  base: string;
  storeUrl: string;
  canSell: boolean;
  href: (link: string) => string;
  recentKey: string;
}) {
  const { loc, lang } = useLanguage();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  // One request per pause in typing; an answer to an older query is dropped.
  useEffect(() => {
    const q = query.trim();
    if (!open || !searchable(q)) {
      setLoading(false);
      return;
    }
    const mine = ++seq.current;
    setLoading(true);
    const t = window.setTimeout(() => {
      api
        .get<{ success: true } & SearchResults>(`/api/merchant/search?q=${encodeURIComponent(q)}`)
        .then((r) => {
          if (mine === seq.current) setResults(r);
        })
        .catch(() => {
          // The local destinations still answer; a failed search is not a dead palette.
          if (mine === seq.current) setResults(null);
        })
        .finally(() => {
          if (mine === seq.current) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query, open]);

  const actions: QuickAction[] = [
    ...(canSell
      ? [
          { id: 'new-product', label: say(loc, W.newProduct), href: href(merchantHref.newProduct()), icon: <Plus className="h-4 w-4" /> },
          { id: 'new-coupon', label: say(loc, W.newCoupon), href: href(merchantHref.newCoupon()), icon: <Plus className="h-4 w-4" /> },
          { id: 'new-collection', label: say(loc, W.newCollection), href: href(merchantHref.newCollection()), icon: <Plus className="h-4 w-4" /> },
        ]
      : []),
    {
      id: 'view-store',
      label: say(loc, W.viewStore),
      icon: <ExternalLink className="h-4 w-4" />,
      onSelect: () => window.open(storeUrl, '_blank', 'noopener,noreferrer'),
    },
  ];

  const groups = paletteGroups({
    loc,
    lang,
    base,
    query,
    results,
    actions,
    money: (iqd) => formatMoney(iqd, lang),
    href,
    icon: (Icon) => <Icon className="h-4 w-4" />,
  });

  return (
    <CommandPalette
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setQuery('');
      }}
      groups={groups}
      recentKey={recentKey}
      label={say(loc, W.search)}
      placeholder={say(loc, W.searchPlaceholder)}
      onQueryChange={setQuery}
      loading={loading}
    />
  );
}
