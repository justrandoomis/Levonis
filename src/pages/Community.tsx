/**
 * LEVO COMMUNITY — /community. «مجتمع ليفو», typeset like an issue of a
 * maker magazine (docs/COMMUNITY_HOME_PLAN.md): a masthead, four verbs, one
 * cover story, then numbered sections in the owner's order — photographs on
 * the canvas separated by hairlines, never boxes on boxes.
 *
 * SIX SECTIONS, ONE SEARCH. «لك» is the issue (hub/ForYouPanel.tsx);
 * «أتابعهم» the feed of the makers and stores the viewer follows;
 * «المشاريع», «طلبات الطباعة», «المتاجر» and «الصنّاع» are directories a page
 * at a time from their own /api/community doors, and the search box searches
 * the list on screen ON THE SERVER — never a filter over the rows the page
 * happens to hold. The tab and the term live in the URL (`?tab=`, `?q=`;
 * hub/tabs.ts resolves the two old names), so Back, a reload and a shared
 * link all land on the same list. While a term is set, the cover, the verbs
 * and the rails step aside: the page is its results.
 *
 * EVERY CARD GOES SOMEWHERE REAL. A product opens the page it can be bought
 * on; a store opens the store; a request opens the request, where offers are
 * made and compared; a project opens the project; a maker opens their page.
 *
 * A NEW REQUEST IS THE WIZARD. «طلب طباعة» opens the four-step wizard on
 * /requests (docs/DECISIONS.md row 131), which is the one road onto the
 * board; «شارك مشروعًا» opens the project composer. A guest goes through
 * sign-in first and comes back to the door they chose.
 *
 * The page sits behind CommunityGate (src/App.tsx): while the owner keeps the
 * community under maintenance, a refused visitor never reaches it.
 */
import React, { Suspense, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useGoBack } from '../lib/useGoBack';
import { ArrowLeft, ArrowRight, Box, Calculator, ChevronLeft, ChevronRight, ClipboardList, Plus, Search, Store, X } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { STUDIO_URL } from '../translations';
import { useAuth } from '../AuthContext';
import { useSignInPrompt } from '../lib/guest';
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
import QuickActions from '../components/community/hub/QuickActions';
import ForYouPanel, { NEW_PROJECT_PATH } from '../components/community/hub/ForYouPanel';
import FollowingPanel from '../components/community/hub/FollowingPanel';
import { RequestListSkeleton, StoreListSkeleton, StoreMark } from '../components/community/hub/parts';
import { NoResults, SearchLine } from '../components/community/hub/search';
import { useHubStrings } from '../components/community/hub/strings';
import { TAB_IDS, canonicalParams, resolveTab, type CommunityTab } from '../components/community/hub/tabs';
import { useCommunityFeed, type CommunityFeed } from '../components/community/hub/useCommunityFeed';
import { forgetHome } from '../components/community/hub/useHomeData';
import { communityHubApi, type CommunityProduct, type CommunityRequest, type CommunityStore } from '../components/community/hub/api';
import { useSearchBox } from '../components/community/search/useSearchBox';

const ProjectsPanel = React.lazy(() => import('../components/community/hub/ProjectsPanel'));
const CreatorsPanel = React.lazy(() => import('../components/community/hub/CreatorsPanel'));
/** The cross-entity search under the bar (Phase 3) — fetched the first time the box is focused. */
const SearchOverlay = React.lazy(() => import('../components/community/search/SearchOverlay'));

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
  const { dir } = useLanguage();
  const s = useHubStrings();
  const { user, isAuthenticated } = useAuth();
  const [params, setParams] = useSearchParams();
  const { tab, list, legacy } = resolveTab(params);
  const q = (params.get('q') ?? '').trim().slice(0, 60);
  const viewer = user?.id ?? 'guest';

  // The two old names are rewritten in place, so Back never lands on them.
  useEffect(() => {
    if (legacy) setParams(canonicalParams(params), { replace: true });
  }, [legacy, params, setParams]);

  /**
   * THE BOX AND THE URL. What is typed shows at once; the URL — and so the
   * search — follows 300 ms after the last key. A term that arrives from the
   * URL (Back, a shared link) is written into the box, but never over what the
   * person is in the middle of typing.
   *
   * WHILE THE OVERLAY IS OPEN THE URL WAITS. The overlay already asks the
   * server twice per settled keystroke (suggestions and the sections); the
   * tab's own list behind a full-height panel would be a third read nobody
   * sees — and on «لك» it would swap the issue for the projects search under
   * the panel. So the debounce is suspended while the panel is open and
   * resumes the moment it steps aside (Escape, a tap outside): the box and
   * the URL then agree again within 300 ms; Enter writes it at once.
   */
  const box = useSearchBox(params, setParams);
  const [draft, setDraft] = useState(q);
  const pushed = useRef(q);
  useEffect(() => {
    if (q !== pushed.current) {
      pushed.current = q;
      setDraft(q);
    }
  }, [q]);
  useEffect(() => {
    if (box.open) return;
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
  }, [draft, q, setParams, box.open]);

  /**
   * THE OVERLAY IS THE CROSS-ENTITY VIEW; THE TAB IS THE DEEP LIST. The box
   * opens the overlay on focus (search/useSearchBox.ts); Enter — or a row of
   * the overlay that says «ابحث في…» — writes the term to the URL at once, on
   * the current tab, and the overlay steps aside so the tab's list answers.
   */
  const submitSearch = (term: string) => {
    const next = term.trim().slice(0, 60);
    setDraft(next);
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
    box.close();
  };

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

  // Tabs are history entries, as they were: Back walks back along them. A
  // tab change leaves the products list and the projects filters behind.
  const chooseTab = (id: string) => {
    const p = new URLSearchParams(params);
    p.set('tab', (TAB_IDS as readonly string[]).includes(id) ? id : 'foryou');
    p.delete('list');
    p.delete('kind');
    p.delete('tag');
    setParams(p);
  };

  /**
   * Which merchant this viewer is, for «طلبات تناسبك» and «متجرك» — asked only
   * with a session, and once per account: keyed on the id, not on the user
   * object, which a session refresh replaces without anyone having changed.
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

  // A guest goes through sign-in first and comes back to the door they chose.
  const newRequestLink = isAuthenticated
    ? { to: NEW_REQUEST_PATH }
    : { to: '/auth', state: { from: NEW_REQUEST_PATH } };
  const composerLink = isAuthenticated ? { to: NEW_PROJECT_PATH } : { to: '/auth', state: { from: NEW_PROJECT_PATH } };

  const placeholder =
    list === 'products'
      ? s.search.products
      : tab === 'stores'
        ? s.search.stores
        : tab === 'requests'
          ? s.search.requests
          : tab === 'creators'
            ? s.search.creators
            : s.search.projects;

  const lazyFallback = <StoreListSkeleton />;
  let panel: React.ReactNode;
  if (tab === 'foryou' && list === 'products') panel = <ProductsPanel q={q} viewer={viewer} onClear={clearSearch} />;
  else if (tab === 'foryou' && !q) panel = <ForYouPanel viewer={viewer} me={me} composerLink={composerLink} tools={<ToolsSection />} />;
  else if (tab === 'following' && !q) panel = <FollowingPanel viewer={viewer} composerLink={composerLink} />;
  else if (tab === 'requests') panel = <RequestsPanel q={q} viewer={viewer} onClear={clearSearch} newRequestLink={newRequestLink} />;
  else if (tab === 'stores') panel = <StoresPanel q={q} viewer={viewer} me={me} onClear={clearSearch} />;
  else if (tab === 'creators') panel = <CreatorsPanel q={q} viewer={viewer} onClear={clearSearch} />;
  // «لك» and «أتابعهم» while a term is set: the projects search.
  else panel = <ProjectsPanel q={q} />;

  return (
    <div className="w-full min-h-screen bg-canvas pb-28 text-text-primary">
      {/* The search bar is FLOATING CHROME: content passes under it, and a
          short gradient says so where the overlap is real (`.scroll-edge`).
          Its height is fixed (h-16) so the tab strip can stick exactly
          beneath it. */}
      <div className="material scroll-edge sticky top-0 z-40 h-16 px-4">
        <div className="mx-auto flex h-full max-w-6xl items-center gap-3">
          <button
            type="button"
            aria-label={s.back}
            onClick={goBack}
            className="press-scale -ms-2 flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {dir === 'rtl' ? <ArrowRight className="h-5 w-5" /> : <ArrowLeft className="h-5 w-5" />}
          </button>
          <form
            ref={box.barRef}
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              submitSearch(draft);
            }}
            className="relative min-w-0 flex-1 lg:max-w-2xl"
          >
            <label htmlFor="community-search" className="sr-only">
              {placeholder}
            </label>
            <Search aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
            <input
              id="community-search"
              type="search"
              enterKeyHint="search"
              autoComplete="off"
              // Latin runs left to right in an Arabic page, and stays put when the overlay closes.
              dir="auto"
              value={draft}
              maxLength={60}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={placeholder}
              data-community-search
              className="lv-input w-full rounded-full ps-10 pe-10 [&::-webkit-search-cancel-button]:appearance-none"
              {...box.inputProps}
            />
            {draft && (
              <button
                type="button"
                onClick={clearSearch}
                aria-label={s.clearSearch}
                className="absolute end-1.5 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full text-text-muted transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </form>
        </div>
      </div>

      {box.ever && (
        <Suspense fallback={null}>
          <SearchOverlay
            open={box.open}
            value={draft}
            onChange={setDraft}
            onSubmit={submitSearch}
            onClose={box.close}
            inputRef={box.inputRef}
            barRef={box.barRef}
            scopeLabel={list === 'products' ? s.communityProducts : s.tabs[tab]}
          />
        </Suspense>
      )}

      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 pt-5">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
          <header className="min-w-0">
            <p className="flex items-center gap-2 text-[11px] font-semibold text-gold">
              <span aria-hidden="true" className="h-px w-4 bg-gold" />
              {s.kicker}
            </p>
            <h1 className="mt-1 text-[24px] font-black leading-tight text-text-primary">{s.title}</h1>
          </header>
          {/* While a search is running, the page is its results: the verbs step
              aside so the answer is not pushed below the fold of a phone. */}
          {!q && <QuickActions newRequestLink={newRequestLink} composerLink={composerLink} />}
        </div>

        {/* The sections. ONE travelling underline (TabStrip), each tab wired
            to the panel it controls, and bodies that arrive from the side the
            change came from — in Arabic, "forward" is leftward. */}
        <div className="material material-thin scroll-edge sticky top-16 z-30 -mx-4 overflow-x-auto px-4 hide-scrollbar">
          <TabStrip
            group="community"
            panels
            fill={false}
            label={s.sections}
            value={tab}
            onChange={chooseTab}
            indicatorClassName="bg-gold"
            activeClassName="text-text-primary"
            idleClassName="text-text-muted hover:text-text-secondary"
            items={TAB_IDS.map((id) => ({ id, label: s.tabs[id] }))}
            className="mx-auto min-w-max max-w-6xl"
          />
        </div>

        <div className="min-h-[380px]">
          <TabPanels value={panelKey(tab, list, q)} order={[...TAB_IDS]} group="community">
            <Suspense fallback={lazyFallback}>{panel}</Suspense>
          </TabPanels>
        </div>
      </div>
    </div>
  );
}

/** The panel's identity for the slide: the tab, and whether it is showing the products list or a search. */
function panelKey(tab: CommunityTab, list: 'products' | null, q: string): string {
  return list ? `${tab}:products` : q && (tab === 'foryou' || tab === 'following') ? `${tab}:search` : tab;
}

// ------------------------------------------------------------------- pieces

/**
 * «أدوات الصانع» (mandate §9). LEVO Studio is a plain full-page navigation to
 * its own subdomain (STUDIO_URL, the one configurable constant in
 * src/translations.ts), opened in its own tab so the store behind it keeps
 * its cart and scroll — no iframe, no prefetch, no slicer code in this bundle
 * (tests/store-isolation.test.ts pins all of that). A working href is not a
 * claim that the Studio is deployed; publishing it is a separate owner step
 * (docs/DECISIONS.md row 30). The calculator prices from the shop's own
 * filament. The library is not built yet and says so.
 */
function ToolsSection() {
  const { t } = useLanguage();
  const s = useHubStrings();
  const tile = 'relative flex h-24 w-[200px] shrink-0 snap-start flex-col justify-center overflow-hidden rounded-2xl border bg-surface p-4 text-start';
  return (
    <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2 hide-scrollbar">
      <a
        href={STUDIO_URL}
        target="_blank"
        data-testid="community-studio-link"
        rel="noopener noreferrer"
        aria-label={`${t('studioCardTitle')} — ${t('studioOpen')}`}
        className={`${tile} border-sage/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`}
      >
        <div aria-hidden="true" className="absolute bottom-0 end-2 opacity-35">
          <Box aria-hidden="true" className="h-20 w-20 text-sage" />
        </div>
        <h3 className="mb-1 text-sm font-bold text-text-primary">{t('studioCardTitle')}</h3>
        <p className="text-xs font-medium text-sage">{t('studioOpen')}</p>
      </a>
      <Link
        to="/tools"
        className={`${tile} border-border-subtle/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`}
      >
        <div aria-hidden="true" className="absolute bottom-0 end-2 opacity-35">
          <Calculator className="h-20 w-20" />
        </div>
        <h3 className="mb-1 text-sm font-bold text-text-primary">{s.calculator}</h3>
        <p className="text-xs text-text-secondary">{s.openCalculator}</p>
      </Link>
      <div className={`${tile} border-border-subtle/60 opacity-70`} aria-disabled="true">
        <div aria-hidden="true" className="absolute bottom-0 end-2 opacity-35">
          <Box className="h-20 w-20" />
        </div>
        <h3 className="mb-1 text-sm font-bold text-text-primary">{s.library}</h3>
        <p className="text-xs text-text-muted">{t('comingSoon')}</p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- panels

function ProductsPanel({ q, viewer, onClear }: { q: string; viewer: string; onClear: () => void }) {
  const s = useHubStrings();
  const feed = useCommunityFeed<CommunityProduct>('products', q, viewer);
  if (feed.error) return <ErrorState error={feed.error} onRetry={feed.reload} />;
  if (!feed.rows) return <ProductGridSkeleton count={8} className={PRODUCT_GRID} />;
  if (feed.rows.length === 0) {
    return q ? (
      <NoResults q={q} onClear={onClear} />
    ) : (
      <EmptyState icon={<Box aria-hidden="true" className="h-6 w-6" />} title={s.noProducts} description={s.noProductsHint} />
    );
  }
  return (
    <div data-community-panel="products">
      {!q && <h2 className="mb-3 text-[22px] font-black leading-tight text-text-primary">{s.communityProducts}</h2>}
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
  const s = useHubStrings();
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
      forgetHome();
    } catch (e) {
      set(was, m.followers ?? 0);
      if (e instanceof ApiError && e.status === 401) signIn();
      else toast.error(s.followFailed);
    } finally {
      setBusy(null);
    }
  };

  let body: React.ReactNode;
  if (feed.error) body = <ErrorState error={feed.error} onRetry={feed.reload} />;
  else if (!feed.rows) body = <StoreListSkeleton />;
  else if (feed.rows.length === 0) {
    body = q ? <NoResults q={q} onClear={onClear} /> : <EmptyState icon={<Store aria-hidden="true" className="h-6 w-6" />} title={s.noStores} />;
  } else {
    body = (
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
      {body}
    </div>
  );
}

/**
 * The viewer's own place in the directory: their store, one tap from its
 * workspace — or, for a member whose plan lets them open one, the way to.
 * Nothing for anyone else: a button to a door that will not open is the dead
 * control the mandate forbids (src/components/merchant/StoreCta.tsx).
 */
function YourStore({ me }: { me: MerchantMe | null }) {
  const { dir } = useLanguage();
  const s = useHubStrings();
  if (!me || (!me.store && !me.eligible)) return null;
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const to = me.store ? merchantHref.home() : '/merchant/start';
  return (
    <Link
      to={to}
      data-community-your-store={me.store ? 'manage' : 'create'}
      className="mb-4 flex items-center gap-3 rounded-2xl border border-border-subtle/60 bg-surface px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      {me.store ? (
        <StoreMark src={me.store.logoUrl} />
      ) : (
        <span aria-hidden="true" className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-sage/40 bg-sage/10">
          <Plus className="h-5 w-5 text-sage" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-semibold text-text-primary">{me.store ? s.yourStore : s.createStore}</span>
        <span dir={me.store ? 'auto' : undefined} className="block truncate text-start text-[12px] text-text-secondary">
          {me.store ? me.store.name : s.yourStoreHint}
        </span>
      </span>
      <Chevron aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
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
  const { t } = useLanguage();
  const s = useHubStrings();
  const feed = useCommunityFeed<CommunityRequest>('requests', q, viewer);

  let body: React.ReactNode;
  if (feed.error) body = <ErrorState error={feed.error} onRetry={feed.reload} />;
  else if (!feed.rows) body = <RequestListSkeleton />;
  else if (feed.rows.length === 0) {
    body = q ? (
      <NoResults q={q} onClear={onClear} />
    ) : (
      <EmptyState
        icon={<ClipboardList aria-hidden="true" className="h-6 w-6" />}
        title={s.noOpenRequests}
        description={s.describeHint}
        action={
          <Link to={newRequestLink.to} state={newRequestLink.state} className="lv-button lv-button-primary mt-1 gap-2">
            <Plus aria-hidden="true" className="h-4 w-4" />
            {s.postRequest}
          </Link>
        }
      />
    );
  } else {
    body = (
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
        <p className="text-[12.5px] leading-relaxed text-text-secondary">{s.requestsHint}</p>
        <Link
          to="/requests"
          className="inline-flex min-h-11 shrink-0 items-center rounded-full px-2 text-[12.5px] font-semibold text-sage hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {t('seeAll')}
        </Link>
      </div>
      {body}
    </div>
  );
}
