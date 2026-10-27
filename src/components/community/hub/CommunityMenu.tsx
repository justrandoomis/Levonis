/**
 * «الأقسام والحساب» — THE SECTIONS AND ACCOUNT MENU (community UI plan B2,
 * §3; IMG_8478). One menu with two doors: the home avatar (C1) and the
 * «الأقسام» button of every section header (kit/SectionPageHeader.tsx
 * `MenuDoor`, which downloads this module on the first press).
 *
 *   title row   the back chevron (closes), «الأقسام والحساب», and at the
 *               inline end «حسابي» with a 44px avatar (the profile, or the
 *               sign-in page for a guest)
 *   المجتمع     the community home and its five sections, then Levo Studio,
 *               a plain external link in a new tab (said aloud), no prefetch
 *   حسابك       the home, the chats, the cart, «طلباتي», the stores I follow,
 *               the saved projects, my store (or the way to open one), the
 *               language and appearance sheet, and the account
 *
 * The page on screen is the dimpled row with the gold start bar
 * (`aria-current="page"`, kit ListRow). A guest keeps every browsable row,
 * reaches the rows that need an account through the sign-in page (it brings
 * them back), and reads «تسجيل الدخول» where the account would be.
 *
 * THE GATE IS THE SERVER. While the community is shut to this viewer
 * (`useCommunityAccess().may_enter === false`), the «المجتمع» group, Studio
 * included, is not drawn, as the bottom bar hides its tab: presentation only.
 *
 * A SHEET ON A PHONE, A POPOVER FROM `lg`. Under 1024px it is the house
 * sheet (ui/Sheet, the large detent, the title row its handle, Escape and the
 * scrim close it, focus held inside and given back). From 1024px it is a
 * 360px popover anchored to its trigger (ui/Overlay `Anchored`): focus moves
 * to its first row, Escape or a press outside closes it and gives focus back
 * to the trigger, and Tab past its last row closes it too. Either way the
 * scope travels with the portal (scopePortals.ts), so it wears the
 * community palette in both themes.
 */
import React, { useCallback, useEffect, useId, useRef, useState, type ComponentType, type KeyboardEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Bookmark,
  Box,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Globe,
  Lightbulb,
  LogIn,
  MessageCircle,
  ShoppingCart,
  Store,
  User,
  Users,
  Wrench,
} from 'lucide-react';
import { useAuth } from '../../../AuthContext';
import { useLanguage } from '../../../LanguageContext';
import { STUDIO_URL, type Language } from '../../../translations';
import { merchantApi, type MerchantMe } from '../../../lib/merchant';
import { merchantHref } from '../../../lib/merchantRoutes';
import { authPathWithSupportRef } from '../../../lib/supportRef';
import { CENTER_REVEAL_MS, setThemePreference, useTheme, type ThemePreference } from '../../../lib/theme';
import { useMediaQuery } from '../../../lib/useMediaQuery';
import { useCommunityAccess } from '../../../pages/community/access';
import { Anchored } from '../../ui/Overlay';
import { Sheet } from '../../ui/Sheet';
import VariantImg from '../../ui/VariantImg';
import type { LangThemePanelProps } from '../../LangThemePanel';
import { ListRow } from '../kit/display';
import { useKitStrings } from '../kit/strings';
import { useSocialStrings } from '../social/strings';
import { useHubStrings } from './strings';

/**
 * The home glyph (the lucide house), drawn here: the house icon module is
 * already used by one lazy screen, and a second user would move it into the
 * shared icon chunk every store page downloads (vite.config.ts `iconChunk`).
 */
function HomeGlyph({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
      <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

/** From Tailwind `lg`: a popover anchored to its trigger. */
const DESKTOP_QUERY = '(min-width: 1024px)';

export interface CommunityMenuProps {
  open: boolean;
  onClose: () => void;
  /** The trigger: the popover grows from it, and focus goes back to it. */
  anchor: React.RefObject<HTMLElement | null>;
}

/** The community sections a row can be, by the address it opens. */
const SECTION_PATHS = {
  home: '/community',
  following: '/community/following',
  projects: '/community/projects',
  requests: '/requests',
  stores: '/community/stores',
  makers: '/community/makers',
} as const;
type SectionKey = keyof typeof SECTION_PATHS;

/** Which row is the page on screen: the longest section address the path starts with. */
export function currentSection(pathname: string): SectionKey | null {
  let best: SectionKey | null = null;
  for (const [key, path] of Object.entries(SECTION_PATHS) as Array<[SectionKey, string]>) {
    const hit = key === 'home' ? pathname === path : pathname === path || pathname.startsWith(`${path}/`);
    if (hit && (!best || path.length > SECTION_PATHS[best].length)) best = key;
  }
  return best;
}

/** The merchant standing behind «متجري», asked once per account per page load. */
const standing = new Map<string, Promise<MerchantMe | null>>();
function standingOf(userId: string): Promise<MerchantMe | null> {
  let p = standing.get(userId);
  if (!p) {
    p = merchantApi.me().catch(() => null);
    standing.set(userId, p);
  }
  return p;
}

export default function CommunityMenu({ open, onClose, anchor }: CommunityMenuProps) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const s = useKitStrings();
  const titleId = useId();
  const body = useRef<HTMLDivElement | null>(null);
  const first = useRef<HTMLButtonElement | null>(null);
  const langTheme = useLangThemeSheet();

  // Focus enters on open, on the first control (the back chevron that closes
  // it): the popover does not move focus by itself, and the sheet, mounted
  // already open on the first press, has no panel yet when it would.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => first.current?.focus({ preventScroll: true }), 50);
    return () => window.clearTimeout(t);
  }, [open, desktop]);

  const content = <MenuBody onNavigate={onClose} onLangTheme={langTheme.openSheet} />;

  return (
    <>
      {desktop ? (
        <Anchored open={open} onClose={onClose} anchor={anchor} align="end" role="dialog" label={s.sectionsAndAccount} testId="community-menu" className="w-full max-w-[360px]">
          <div
            ref={body}
            data-community-menu="popover"
            className="max-h-[85vh] overflow-y-auto overscroll-contain"
            onKeyDown={(e) => {
              if (e.key !== 'Tab' || e.shiftKey) return;
              const all = body.current?.querySelectorAll<HTMLElement>('a[href], button');
              if (all && document.activeElement === all[all.length - 1]) onClose();
            }}
          >
            <TitleRow titleId={titleId} onClose={onClose} firstRef={first} />
            {content}
          </div>
        </Anchored>
      ) : (
        <Sheet
          open={open}
          onClose={onClose}
          labelledBy={titleId}
          detents={['large']}
          solid
          testId="community-menu"
          panelClassName="bg-canvas sm:max-w-[440px] sm:w-[92vw]"
          header={<TitleRow titleId={titleId} onClose={onClose} firstRef={first} />}
        >
          <div data-community-menu="sheet">{content}</div>
        </Sheet>
      )}
      {langTheme.panel}
    </>
  );
}

/** «› الأقسام والحساب … حسابي ◯». */
function TitleRow({ titleId, onClose, firstRef }: { titleId: string; onClose: () => void; firstRef: React.RefObject<HTMLButtonElement | null> }) {
  const s = useKitStrings();
  const { dir } = useLanguage();
  const { user, isAuthenticated } = useAuth();
  const Back = dir === 'rtl' ? ChevronRight : ChevronLeft;
  const avatar = isAuthenticated && user?.avatar_key ? `/files/${user.avatar_key}` : '';
  const to = isAuthenticated ? '/profile' : authPathWithSupportRef('/profile');
  return (
    <div className="flex min-h-14 items-center gap-2 px-2 pb-1 pt-2">
      <button
        ref={firstRef}
        type="button"
        onClick={onClose}
        aria-label={s.close}
        className="relative inline-flex size-11 shrink-0 items-center justify-center rounded-full text-text-primary hover:bg-surface-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <Back aria-hidden="true" className="h-6 w-6" strokeWidth={2} />
      </button>
      <h2 id={titleId} className="min-w-0 flex-1 break-words text-[20px] font-extrabold leading-tight text-text-primary">
        {s.sectionsAndAccount}
      </h2>
      <Link
        to={to}
        onClick={onClose}
        data-community-menu-account
        className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full ps-2 text-[15px] text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {s.myAccount}
        <span aria-hidden="true" className="cm-line inline-flex size-11 items-center justify-center overflow-hidden rounded-full bg-surface-raised text-gold shadow-1">
          {avatar ? <VariantImg src={avatar} sizes="44px" alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" /> : <User className="h-5 w-5" fill="currentColor" strokeWidth={1.5} />}
        </span>
      </Link>
    </div>
  );
}

/** The two groups (the community one only while the community is open to this viewer). */
function MenuBody({ onNavigate, onLangTheme }: { onNavigate: () => void; onLangTheme: () => void }) {
  const s = useKitStrings();
  const hub = useHubStrings();
  const social = useSocialStrings();
  const { t } = useLanguage();
  const { user, isAuthenticated } = useAuth();
  const { access } = useCommunityAccess();
  const { pathname } = useLocation();
  const current = currentSection(pathname);
  const [me, setMe] = useState<MerchantMe | null>(null);
  const userId = user?.id ?? '';
  useEffect(() => {
    if (!userId) {
      setMe(null);
      return;
    }
    let alive = true;
    standingOf(userId).then((d) => alive && setMe(d));
    return () => {
      alive = false;
    };
  }, [userId]);

  // A row that needs an account takes a guest through sign-in, and back.
  const gated = (path: string) => (isAuthenticated ? path : authPathWithSupportRef(path));
  const glyph = 'h-5 w-5';
  const row = (key: string, label: string, icon: React.ReactNode, to: string, isCurrent = false) => (
    <ListRow key={key} label={label} icon={icon} to={to} current={isCurrent} onClick={onNavigate} />
  );
  const section = (key: SectionKey, label: string, Icon: ComponentType<{ className?: string }>) => row(key, label, <Icon className={glyph} />, SECTION_PATHS[key], current === key);

  const storeRow = !isAuthenticated
    ? null
    : me?.store
      ? row('store', s.myStore, <Store className={glyph} />, merchantHref.home())
      : me && (me.eligible || me.approved === false)
        ? row('store', s.openStore, <Store className={glyph} />, '/merchant/start')
        : null;

  return (
    <div className="flex flex-col gap-4 px-4 pb-4 pt-2">
      {access?.may_enter !== false && (
        <MenuGroup icon={<Users className="h-7 w-7" fill="currentColor" strokeWidth={1.5} />} title={s.community} hint={s.communityHint} id="community-menu-community">
          {section('home', s.communityHome, HomeGlyph)}
          {section('following', hub.tabs.following, Users)}
          {section('projects', hub.tabs.projects, Lightbulb)}
          {section('requests', hub.tabs.requests, Box)}
          {section('stores', hub.tabs.stores, Store)}
          {section('makers', hub.tabs.creators, Wrench)}
          <ListRow label="Levo Studio" icon={<Box className={glyph} />} href={STUDIO_URL} onClick={onNavigate} />
        </MenuGroup>
      )}
      <MenuGroup icon={<User className="h-7 w-7" fill="currentColor" strokeWidth={1.5} />} title={s.yourAccount} hint={s.yourAccountHint} id="community-menu-account">
        {row('home', t('home'), <HomeGlyph className={glyph} />, '/')}
        {row('chats', t('webCenter'), <MessageCircle className={glyph} />, '/chats')}
        {row('cart', t('cart'), <ShoppingCart className={glyph} />, gated('/cart'))}
        {row('mine', hub.myRequests, <ClipboardList className={glyph} />, gated('/requests?view=mine'))}
        {row('followed', s.storesIFollow, <Store className={glyph} />, gated('/followed-stores'))}
        {row('saved', social.savedTitle, <Bookmark className={glyph} />, gated('/community/saved'))}
        {storeRow}
        <button type="button" onClick={onLangTheme} className="cm-row relative flex min-h-14 w-full items-center gap-3 rounded-sm px-3 text-start text-text-primary hover:bg-surface-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus" aria-haspopup="dialog">
          <span aria-hidden="true" className="cm-line flex size-9 shrink-0 items-center justify-center rounded-sm bg-surface-raised text-gold shadow-1">
            <Globe className={glyph} />
          </span>
          <span className="min-w-0 flex-1 truncate text-base font-medium">{s.langTheme}</span>
        </button>
        {isAuthenticated
          ? row('profile', t('profile'), <User className={glyph} />, '/profile')
          : row('signin', hub.signIn, <LogIn className={glyph} />, authPathWithSupportRef(pathname))}
      </MenuGroup>
    </div>
  );
}

/** A group card: the gold glyph, the title over its hint (information, not raised), then the tray of rows. */
function MenuGroup({ icon, title, hint, id, children }: { icon: React.ReactNode; title: string; hint: string; id: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="cm-card rounded-xl p-3 shadow-sm">
      <div className="flex items-start gap-3 px-1 pb-3 pt-1">
        <span aria-hidden="true" className="mt-0.5 shrink-0 text-gold">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={id} className="text-[20px] font-extrabold leading-tight text-text-primary">
            {title}
          </h3>
          <p className="text-[13px] text-text-secondary">{hint}</p>
        </div>
      </div>
      <nav aria-labelledby={id} className="cm-line flex flex-col divide-y divide-border-subtle overflow-hidden rounded-lg bg-surface">
        {children}
      </nav>
    </section>
  );
}

// ----------------------------------------------------------- language and theme

type PanelComponent = ComponentType<LangThemePanelProps>;
let loadedPanel: PanelComponent | null = null;

/**
 * «اللغة والمظهر» from the menu: the same lazy sheet the header globe opens
 * (LangThemePanel), over the menu, with the same rules: a choice closes the
 * sheet and is made once it has gone; an arrow key only moves the pick. The
 * display currency is the header row alone (the dashboard keeps it out too).
 */
function useLangThemeSheet(): { openSheet: () => void; panel: React.ReactNode } {
  const { lang, setLang, loc, dir } = useLanguage();
  const { preference } = useTheme();
  const s = useKitStrings();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [Panel, setPanel] = useState<PanelComponent | null>(() => loadedPanel);
  const [langPick, setLangPick] = useState<Language>(lang);
  const [themePick, setThemePick] = useState<ThemePreference>(preference);
  const pending = useRef<null | (() => void)>(null);
  const fallback = useRef<number | undefined>(undefined);
  const navigating = useRef(false);

  const flush = useCallback(() => {
    window.clearTimeout(fallback.current);
    const run = pending.current;
    pending.current = null;
    run?.();
  }, []);
  useEffect(() => () => window.clearTimeout(fallback.current), []);

  const openSheet = () => {
    setLangPick(lang);
    setThemePick(preference);
    setOpen(true);
    if (loadedPanel) {
      setPanel(() => loadedPanel);
      return;
    }
    void import('../../LangThemePanel')
      .then((m) => {
        loadedPanel = m.default;
        setPanel(() => m.default);
      })
      .catch(() => setOpen(false));
  };

  /** Close, and make the change once the sheet has gone (or after 900ms, if a hidden tab never reports the exit). */
  const commit = (change: (() => void) | null) => {
    if (navigating.current) {
      navigating.current = false;
      return;
    }
    pending.current = change;
    setOpen(false);
    window.clearTimeout(fallback.current);
    if (change) fallback.current = window.setTimeout(flush, 900);
  };

  const panel = Panel ? (
    <Panel
      open={open}
      onClose={() => commit(null)}
      onExited={flush}
      titleId={titleId}
      title={s.langTheme}
      langLabel={loc('اللغة', 'Language', 'زمان')}
      themeLabel={loc('المظهر', 'Appearance', 'ڕووکار')}
      withCurrency={false}
      dir={dir}
      langPick={langPick}
      themePick={themePick}
      chooseLang={(id) => {
        const next = id as Language;
        setLangPick(next);
        commit(next === lang ? null : () => setLang(next));
      }}
      chooseTheme={(id) => {
        const next = id as ThemePreference;
        setThemePick(next);
        commit(next === preference ? null : () => setThemePreference(next, { origin: 'center', duration: CENTER_REVEAL_MS }));
      }}
      commit={commit}
      onRowKeyDownCapture={(e: KeyboardEvent) => {
        navigating.current = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key);
      }}
      onRowPointerDownCapture={() => {
        navigating.current = false;
      }}
    />
  ) : null;

  return { openSheet, panel };
}
