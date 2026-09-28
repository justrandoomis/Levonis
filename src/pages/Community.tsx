/**
 * LEVO COMMUNITY — /community. «مجتمع ليفو»: the print shops of Levonis, what
 * they make, and the custom print requests they answer.
 *
 * THREE LISTS, ONE SEARCH. Products, stores and requests each come from their
 * own /api/community door a page at a time, and the search box searches the
 * list on screen ON THE SERVER. It used to filter the twenty rows the page
 * happened to hold, so a product on page two was «لا توجد نتائج». The tab and
 * the term live in the URL (`?tab=`, `?q=`), so Back, a reload and a shared
 * link all land on the same list.
 *
 * EVERY CARD GOES SOMEWHERE REAL. A product opens the page it can be bought on
 * (its store's product page — it used to open the platform catalogue's page,
 * which calls a community listing «not sold through the store cart»); a store
 * opens the store; a request opens the request, where offers are made and
 * compared (it used to open nothing at all).
 *
 * A NEW REQUEST IS THE WIZARD. The quick title-and-description sheet published
 * a request with nothing a workshop could price — no quantity, no material, no
 * file — straight onto the board. «طلب طباعة» now opens the four-step wizard
 * on /requests (drafts, files, the estimate; docs/DECISIONS.md row 131), which
 * is the one road onto the board. `POST /api/community/requests` stays for any
 * client that still calls it.
 *
 * The page sits behind CommunityGate (src/App.tsx): while the owner keeps the
 * community under maintenance, a refused visitor never reaches it.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useGoBack } from '../lib/useGoBack';
import {
  ArrowLeft, ArrowRight, Box, Calculator, ChevronLeft, ChevronRight, ClipboardList,
  Heart, MessageSquare, PackageSearch, Plus, Search, Store, X,
} from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { STUDIO_URL } from '../translations';
import { useAuth } from '../AuthContext';
import { useSignInPrompt } from '../lib/guest';
import { useRail } from '../lib/useRail';
import { ApiError } from '../lib/api';
import { merchantApi, type MerchantMe } from '../lib/merchant';
import { merchantHref } from '../lib/merchantRoutes';
import { TabStrip, TabPanels } from '../components/ui/Tabs';
import { EmptyState, ErrorState } from '../components/ui/AsyncStates';
import { ProductGridSkeleton } from '../components/ui/Skeleton';
import { toast } from '../components/ui/Toast';
import LoadMore from '../components/listing/LoadMore';
import ProductTile from '../components/community/hub/ProductTile';
import StoreCard from '../components/community/hub/StoreCard';
import RequestCard from '../components/community/hub/RequestCard';
import WorksRail from '../components/community/hub/WorksRail';
import { RequestListSkeleton, StoreListSkeleton, StoreMark } from '../components/community/hub/parts';
import { useCommunityFeed, type CommunityFeed } from '../components/community/hub/useCommunityFeed';
import { resultsLabel } from '../components/community/hub/copy';
import {
  communityHubApi,
  type CommunityProduct,
  type CommunityRequest,
  type CommunityStore,
} from '../components/community/hub/api';

const TABS = ['products', 'merchants', 'requests'] as const;
type Tab = (typeof TABS)[number];
const asTab = (v: string | null): Tab => ((TABS as readonly string[]).includes(v ?? '') ? (v as Tab) : 'products');

/** The wizard, on the requests page. */
const NEW_REQUEST_PATH = '/requests?view=new';

const PRODUCT_GRID = 'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5';

/** How many «عرض المزيد» can honestly promise: the first page's total, less what is shown. */
function remaining(feed: CommunityFeed<{ id: string }>): number {
  if (!feed.hasMore || !feed.rows) return 0;
  return Math.max(1, (feed.total ?? 0) - feed.rows.length);
}

export default function Community() {
  // A visitor who came from another page goes back to it; one who opened
  // the community by its link goes home (it used to leave the site).
  const goBack = useGoBack('/');
  const { loc, dir } = useLanguage();
  const { user, isAuthenticated } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = asTab(params.get('tab'));
  const q = (params.get('q') ?? '').trim().slice(0, 60);
  const viewer = user?.id ?? 'guest';

  /**
   * THE BOX AND THE URL. What is typed shows at once; the URL — and so the
   * search — follows 300 ms after the last key. A term that arrives from the
   * URL (Back, a shared link) is written into the box, but never over what the
   * person is in the middle of typing.
   */
  const [draft, setDraft] = useState(q);
  const pushed = useRef(q);
  useEffect(() => {
    if (q !== pushed.current) {
      pushed.current = q;
      setDraft(q);
    }
  }, [q]);
  useEffect(() => {
    const next = draft.trim().slice(0, 60);
    if (next === q) return;
    const timer = window.setTimeout(() => {
      pushed.current = next;
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (next) p.set('q', next);
          else p.delete('q');
          return p;
        },
        { replace: true }
      );
    }, 300);
    return () => window.clearTimeout(timer);
  }, [draft, q, setParams]);

  const clearSearch = () => {
    setDraft('');
    pushed.current = '';
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.delete('q');
        return p;
      },
      { replace: true }
    );
  };

  // Tabs are history entries, as they were: Back walks back along them.
  const chooseTab = (id: string) => {
    const p = new URLSearchParams(params);
    p.set('tab', asTab(id));
    setParams(p);
  };

  /**
   * Which merchant this viewer is, for «متجرك» / «أنشئ متجرك» — asked only with
   * a session, and once per account: keyed on the id, not on the user object,
   * which a session refresh replaces without anyone having changed.
   */
  const userId = user?.id ?? null;
  const [me, setMe] = useState<MerchantMe | null>(null);
  useEffect(() => {
    if (!userId) {
      setMe(null);
      return;
    }
    let alive = true;
    merchantApi
      .me()
      .then((d) => {
        if (alive) setMe(d);
      })
      .catch(() => {
        if (alive) setMe(null);
      });
    return () => {
      alive = false;
    };
  }, [userId]);

  // A guest goes through sign-in first and comes back to the wizard itself.
  const newRequestLink = isAuthenticated
    ? { to: NEW_REQUEST_PATH }
    : { to: '/auth', state: { from: NEW_REQUEST_PATH } };

  const placeholder =
    tab === 'merchants'
      ? loc('ابحث عن متجر أو ورشة', 'Search stores and workshops')
      : tab === 'requests'
        ? loc('ابحث في طلبات الطباعة', 'Search print requests')
        : loc('ابحث في منتجات المجتمع', 'Search community products');

  return (
    <div className="w-full min-h-screen bg-black pb-28 text-zinc-300">
      {/* The search bar is FLOATING CHROME: content passes under it, and a
          short gradient says so where the overlap is real (`.scroll-edge`).
          Its height is fixed (h-16) so the tab strip can stick exactly
          beneath it. */}
      <div className="material scroll-edge sticky top-0 z-40 h-16 px-4">
        <div className="mx-auto flex h-full max-w-6xl items-center gap-3">
          <button
            type="button"
            aria-label={loc('رجوع', 'Back')}
            onClick={goBack}
            className="press-scale shrink-0 rounded-full bg-zinc-900 p-2 transition-colors hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {dir === 'rtl' ? <ArrowRight className="h-5 w-5" /> : <ArrowLeft className="h-5 w-5" />}
          </button>
          <form role="search" onSubmit={(e) => e.preventDefault()} className="relative min-w-0 flex-1 lg:max-w-2xl">
            <label htmlFor="community-search" className="sr-only">
              {placeholder}
            </label>
            <Search aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            <input
              id="community-search"
              type="search"
              enterKeyHint="search"
              autoComplete="off"
              value={draft}
              maxLength={60}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={placeholder}
              data-community-search
              className="w-full rounded-full border border-zinc-800 bg-zinc-900 py-2 ps-10 pe-10 text-sm text-white placeholder:text-zinc-500 focus:border-olive/50 focus:outline-none [&::-webkit-search-cancel-button]:appearance-none"
            />
            {draft && (
              <button
                type="button"
                onClick={clearSearch}
                aria-label={loc('مسح البحث', 'Clear search')}
                className="absolute end-1.5 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </form>
        </div>
      </div>

      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 pt-5">
        <header>
          {/* OWNER: Sorani to be written by hand. */}
          <h1 className="text-[20px] font-bold leading-tight text-white">{loc('مجتمع ليفو', 'Levo Community')}</h1>
          <p className="mt-1 text-balance text-[13px] leading-relaxed text-zinc-400">
            {loc(
              'متاجر الطباعة ثلاثية الأبعاد ومنتجاتها، وطلبات الطباعة المخصّصة.',
              '3D-printing shops, what they make, and custom print requests.'
            )}
          </p>
        </header>

        {/* While a search is running, the page is its results: the shortcuts
            and the tools step aside so the answer is not pushed below the
            fold of a phone. Clearing the search brings them back. */}
        {!q && <Shortcuts newRequestLink={newRequestLink} />}
        {!q && <ToolsRail />}

        {/* The sections. ONE travelling underline (TabStrip), each tab wired
            to the panel it controls, and bodies that arrive from the side the
            change came from — in Arabic, "forward" is leftward. */}
        <div className="material material-thin scroll-edge sticky top-16 z-30 -mx-4 px-4">
          <TabStrip
            group="community"
            panels
            label={loc('أقسام المجتمع', 'Community sections')}
            value={tab}
            onChange={chooseTab}
            items={[
              { id: 'products', label: loc('المنتجات', 'Products') },
              { id: 'merchants', label: loc('المتاجر', 'Stores') },
              { id: 'requests', label: loc('الطلبات', 'Requests') },
            ]}
            className="mx-auto max-w-6xl justify-between"
          />
        </div>

        <div className="min-h-[400px]">
          <TabPanels value={tab} order={[...TABS]} group="community">
            {tab === 'products' && <ProductsPanel q={q} viewer={viewer} onClear={clearSearch} />}
            {tab === 'merchants' && <StoresPanel q={q} viewer={viewer} me={me} onClear={clearSearch} />}
            {tab === 'requests' && <RequestsPanel q={q} viewer={viewer} onClear={clearSearch} newRequestLink={newRequestLink} />}
          </TabPanels>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- pieces

/**
 * The community's four doors. Real links, so a keyboard, a screen reader and
 * a long press all know where each goes. «طلب طباعة» is the page's one primary
 * action and carries its one accent. «ملفي» is gone from here: the bottom bar
 * already carries «الحساب», and this row is for the community's own places.
 */
function Shortcuts({ newRequestLink }: { newRequestLink: { to: string; state?: unknown } }) {
  const { loc, t } = useLanguage();
  return (
    <nav aria-label={loc('اختصارات المجتمع', 'Community shortcuts')} className="grid grid-cols-4 gap-2 sm:max-w-lg">
      <Shortcut to="/chats" icon={MessageSquare} label={t('webCenter')} />
      <Shortcut {...newRequestLink} icon={Plus} label={loc('طلب طباعة', 'Print request')} primary testId="community-new-request" />
      <Shortcut to="/requests?view=mine" icon={ClipboardList} label={loc('طلباتي', 'My requests', 'داواکاریەکانم')} />
      <Shortcut to="/followed-stores" icon={Heart} label={loc('متاجر أتابعها', 'Following', 'شوێنکەوتن')} />
    </nav>
  );
}

/**
 * Tools (mandate §9). LEVO Studio is a plain full-page navigation to its own
 * subdomain (STUDIO_URL, the one configurable constant in src/translations.ts),
 * opened in its own tab so the store behind it keeps its cart and scroll — no
 * iframe, no prefetch, no slicer code in this bundle (tests/store-isolation.
 * test.ts pins all of that). A working href is not a claim that the Studio is
 * deployed; publishing it is a separate owner step (docs/DECISIONS.md row 30).
 * The calculator prices from the shop's own filament. The library is not built
 * yet and says so.
 */
function ToolsRail() {
  const { loc, t } = useLanguage();
  const featureRail = useRail();
  return (
    <div ref={featureRail.ref} className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2 hide-scrollbar">
      <a
        href={STUDIO_URL}
        target="_blank"
        data-testid="community-studio-link"
        rel="noopener noreferrer"
        aria-label={`${t('studioCardTitle')} — ${t('studioOpen')}`}
        className="lv-community-tile relative flex h-24 w-[240px] shrink-0 snap-start flex-col justify-center overflow-hidden rounded-2xl border border-olive/50 bg-gradient-to-r from-olive/25 to-black p-4 transition-colors hover:border-olive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
      >
        <div aria-hidden="true" className="absolute bottom-0 end-2 opacity-20">
          <Box aria-hidden="true" className="h-20 w-20 text-olive" />
        </div>
        <h3 className="mb-1 text-sm font-bold text-white">{t('studioCardTitle')}</h3>
        <p className="text-xs font-medium text-sage">{t('studioOpen')}</p>
      </a>
      <Link
        to="/tools"
        className="lv-community-tile relative flex h-24 w-[240px] shrink-0 snap-start flex-col justify-center overflow-hidden rounded-2xl border border-zinc-700 bg-gradient-to-r from-zinc-800 to-zinc-900 p-4 text-start transition-colors hover:border-zinc-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
      >
        <div aria-hidden="true" className="absolute bottom-0 end-2 opacity-20">
          <Calculator className="h-20 w-20" />
        </div>
        <h3 className="mb-1 text-sm font-bold text-white">{loc('احسب سعر طباعتك', 'Calculate Print Price')}</h3>
        <p className="text-xs text-zinc-300">{loc('افتح الحاسبة', 'Open the calculator')}</p>
      </Link>
      <div
        className="lv-community-tile relative flex h-24 w-[240px] shrink-0 snap-start flex-col justify-center overflow-hidden rounded-2xl border border-olive/30 bg-gradient-to-r from-olive/20 to-black p-4 opacity-70"
        aria-disabled="true"
      >
        <div aria-hidden="true" className="absolute bottom-0 end-2 opacity-20">
          <Box className="h-20 w-20 text-olive" />
        </div>
        <h3 className="mb-1 text-sm font-bold text-white">{loc('مكتبة ملفات الطباعة', '3D Models Library')}</h3>
        <p className="text-xs text-text-muted">{t('comingSoon')}</p>
      </div>
    </div>
  );
}

function Shortcut({
  to,
  state,
  icon: Icon,
  label,
  primary = false,
  testId,
}: {
  to: string;
  state?: unknown;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' }>;
  label: string;
  primary?: boolean;
  testId?: string;
}) {
  return (
    <Link
      to={to}
      state={state}
      data-testid={testId}
      className="press-scale group flex min-w-0 flex-col items-center gap-2 rounded-2xl py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <span
        className={`flex h-12 w-12 items-center justify-center rounded-2xl border transition-colors ${
          primary ? 'border-sage/40 bg-sage/10 group-hover:bg-sage/20' : 'border-zinc-800 bg-zinc-900 group-hover:border-zinc-700'
        }`}
      >
        <Icon aria-hidden="true" className={`h-5 w-5 ${primary ? 'text-sage' : 'text-zinc-400 group-hover:text-zinc-200'}`} />
      </span>
      <span className={`w-full truncate text-center text-[11px] font-medium ${primary ? 'text-sage' : 'text-zinc-400'}`}>{label}</span>
    </Link>
  );
}

/** «3 نتائج لـ «تنين»» — the search's answer, above the list it describes. */
function SearchLine({ q, total }: { q: string; total: number | null }) {
  const { loc } = useLanguage();
  if (!q || total === null) return null;
  return (
    <p role="status" className="mb-3 text-[12.5px] text-zinc-400">
      {/* OWNER: Sorani to be written by hand. */}
      {loc(`${resultsLabel(total, 'ar')} لـ «${q}»`, `${resultsLabel(total, 'en')} for “${q}”`)}
    </p>
  );
}

/** A search that found nothing — say so, and offer the way back. */
function NoResults({ q, onClear }: { q: string; onClear: () => void }) {
  const { loc } = useLanguage();
  return (
    <EmptyState
      icon={<PackageSearch aria-hidden="true" className="h-6 w-6" />}
      // OWNER: Sorani to be written by hand.
      title={loc(`لا نتائج لـ «${q}»`, `No results for “${q}”`)}
      description={loc('جرّب كلمة أقصر، أو ابحث في قسم آخر.', 'Try a shorter word, or search another section.')}
      action={
        <button
          type="button"
          onClick={onClear}
          className="mt-1 min-h-[44px] rounded-full border border-zinc-700 px-5 text-[13px] font-semibold text-zinc-200 transition-colors hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {loc('مسح البحث', 'Clear search')}
        </button>
      }
    />
  );
}

// ------------------------------------------------------------------- panels

function ProductsPanel({ q, viewer, onClear }: { q: string; viewer: string; onClear: () => void }) {
  const { loc } = useLanguage();
  const feed = useCommunityFeed<CommunityProduct>('products', q, viewer);
  if (feed.error) return <ErrorState error={feed.error} onRetry={feed.reload} />;
  if (!feed.rows) return <ProductGridSkeleton count={8} className={PRODUCT_GRID} />;
  if (feed.rows.length === 0) {
    return q ? (
      <NoResults q={q} onClear={onClear} />
    ) : (
      <EmptyState
        icon={<Box aria-hidden="true" className="h-6 w-6" />}
        title={loc('لا منتجات في المجتمع بعد', 'No community products yet')}
        description={loc('ما تنشره المتاجر يظهر هنا أولًا بأول.', 'What the stores publish appears here as it goes up.')}
      />
    );
  }
  return (
    <div data-community-panel="products">
      <SearchLine q={q} total={feed.total} />
      <div className={PRODUCT_GRID}>
        {feed.rows.map((p, i) => (
          <ProductTile key={p.id} product={p} eager={i < 4} />
        ))}
      </div>
      <LoadMore remaining={remaining(feed)} state={feed.more} onMore={feed.loadMore} />
    </div>
  );
}

function StoresPanel({ q, viewer, me, onClear }: { q: string; viewer: string; me: MerchantMe | null; onClear: () => void }) {
  const { loc } = useLanguage();
  const { user, isAuthenticated } = useAuth();
  const { signIn } = useSignInPrompt();
  const feed = useCommunityFeed<CommunityStore>('merchants', q, viewer);
  const [busy, setBusy] = useState<string | null>(null);

  /**
   * «متابعة» answers at once and is put back if the server says no. A guest is
   * asked to sign in and brought back here; a follow is never sent that is sure
   * to fail (docs/DECISIONS.md row 89).
   */
  const toggleFollow = async (m: CommunityStore) => {
    if (!isAuthenticated) {
      signIn();
      return;
    }
    if (busy) return;
    const was = !!m.following;
    const set = (following: boolean, followers: number) =>
      feed.patch((rows) => rows.map((r) => (r.id === m.id ? { ...r, following, followers } : r)));
    setBusy(m.id);
    set(!was, Math.max(0, (m.followers ?? 0) + (was ? -1 : 1)));
    try {
      await (was ? communityHubApi.unfollow(m.id) : communityHubApi.follow(m.id));
      feed.forgetOthers();
    } catch (e) {
      set(was, m.followers ?? 0);
      if (e instanceof ApiError && e.status === 401) signIn();
      // OWNER: Sorani to be written by hand.
      else toast.error(loc('تعذّر تحديث المتابعة. حاول مرة أخرى.', 'Could not update the follow. Try again.'));
    } finally {
      setBusy(null);
    }
  };

  let list: React.ReactNode;
  if (feed.error) list = <ErrorState error={feed.error} onRetry={feed.reload} />;
  else if (!feed.rows) list = <StoreListSkeleton />;
  else if (feed.rows.length === 0) {
    list = q ? (
      <NoResults q={q} onClear={onClear} />
    ) : (
      <EmptyState
        icon={<Store aria-hidden="true" className="h-6 w-6" />}
        title={loc('لا متاجر في المجتمع بعد', 'No community stores yet')}
      />
    );
  } else {
    list = (
      <>
        <SearchLine q={q} total={feed.total} />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {feed.rows.map((m) => (
            <StoreCard key={m.id} store={m} canFollow={m.user_id !== user?.id} busy={busy === m.id} onToggleFollow={toggleFollow} />
          ))}
        </div>
        <LoadMore remaining={remaining(feed)} state={feed.more} onMore={feed.loadMore} />
      </>
    );
  }

  return (
    <div data-community-panel="merchants">
      {!q && <WorksRail />}
      {!q && <YourStore me={me} />}
      {list}
    </div>
  );
}

/**
 * The viewer's own place in the directory: their store, one tap from its
 * workspace — or, for a member whose plan lets them open one, the way to.
 * Nothing for anyone else: a button to a door that will not open is the dead
 * control the mandate forbids (src/components/merchant/StoreCta.tsx). The
 * words are StoreCta's own, Sorani included.
 */
function YourStore({ me }: { me: MerchantMe | null }) {
  const { loc, dir } = useLanguage();
  if (!me || (!me.store && !me.eligible)) return null;
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const to = me.store ? merchantHref.home() : '/merchant/start';
  return (
    <Link
      to={to}
      data-community-your-store={me.store ? 'manage' : 'create'}
      className="mb-4 flex items-center gap-3 rounded-2xl border border-zinc-800/60 bg-zinc-900/40 px-4 py-3 transition-colors hover:border-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      {me.store ? (
        <StoreMark src={me.store.logoUrl} />
      ) : (
        <span aria-hidden="true" className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-sage/40 bg-sage/10">
          <Plus className="h-5 w-5 text-sage" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-semibold text-white">
          {me.store
            ? loc('متجرك في مجتمع ليفو', 'Your store in the Levo community', 'فرۆشگاکەت لە کۆمەڵگەی Levo')
            : loc('أنشئ متجرك في ليفو', 'Create your Levo store', 'فرۆشگای Levo خۆت دروست بکە')}
        </span>
        <span dir={me.store ? 'auto' : undefined} className="block truncate text-start text-[12px] text-zinc-400">
          {/* OWNER: Sorani to be written by hand. */}
          {me.store ? me.store.name : loc('اعرض منتجاتك واستقبل طلبات الطباعة.', 'Sell your prints and take print requests.')}
        </span>
      </span>
      <Chevron aria-hidden="true" className="h-4 w-4 shrink-0 text-zinc-500" />
    </Link>
  );
}

function RequestsPanel({
  q,
  viewer,
  onClear,
  newRequestLink,
}: {
  q: string;
  viewer: string;
  onClear: () => void;
  newRequestLink: { to: string; state?: unknown };
}) {
  const { loc, t } = useLanguage();
  const feed = useCommunityFeed<CommunityRequest>('requests', q, viewer);

  let list: React.ReactNode;
  if (feed.error) list = <ErrorState error={feed.error} onRetry={feed.reload} />;
  else if (!feed.rows) list = <RequestListSkeleton />;
  else if (feed.rows.length === 0) {
    list = q ? (
      <NoResults q={q} onClear={onClear} />
    ) : (
      <EmptyState
        icon={<ClipboardList aria-hidden="true" className="h-6 w-6" />}
        title={loc('لا توجد طلبات مفتوحة', 'No open requests', 'هیچ داواکارییەکی کراوە نییە')}
        // OWNER: Sorani to be written by hand.
        description={loc('صف ما تريد طباعته، وتصلك عروض الورش.', 'Describe what you want printed and the workshops will send offers.')}
        action={
          <Link
            to={newRequestLink.to}
            state={newRequestLink.state}
            className="mt-1 inline-flex min-h-[44px] items-center gap-2 rounded-full bg-olive px-5 text-[13px] font-bold text-snow transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            {loc('انشر طلب طباعة', 'Post a print request')}
          </Link>
        }
      />
    );
  } else {
    list = (
      <>
        <SearchLine q={q} total={feed.total} />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {feed.rows.map((r) => (
            <RequestCard key={r.id} request={r} />
          ))}
        </div>
        <LoadMore remaining={remaining(feed)} state={feed.more} onMore={feed.loadMore} />
      </>
    );
  }

  return (
    <div data-community-panel="requests">
      <div className="mb-4 flex items-center justify-between gap-3">
        {/* OWNER: Sorani to be written by hand. */}
        <p className="text-[12.5px] leading-relaxed text-zinc-400">
          {loc('طلبات طباعة تنتظر عروض الورش.', 'Print requests waiting for offers from workshops.')}
        </p>
        <Link
          to="/requests"
          className="shrink-0 rounded-full px-2 py-1 text-[12.5px] font-semibold text-sage hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {t('seeAll')}
        </Link>
      </div>
      {list}
    </div>
  );
}
