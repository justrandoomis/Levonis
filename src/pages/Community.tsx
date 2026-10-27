/**
 * LEVO COMMUNITY — /community, the community home (community UI plan C1;
 * IMG_8487 on a phone, IMG_8462 from `lg`).
 *
 *   top bar   the wordmark «LEVONIS» and the page h1 «مجتمع ليفو», the chats
 *             with their unread badge, the bell, and the avatar that opens
 *             the sections and account menu (hub/TopBar.tsx). From `lg` it
 *             carries the search in its middle, and the h1 is the large title
 *             under it with the line «ما يطبعه الصنّاع. وما تحتاجه الورش.»
 *   search    one cross-entity box, «ابحث عن مشروع، صانع أو متجر»: focus opens
 *             the overlay of every kind of result; Enter writes `?q=` and the
 *             home becomes the projects that answer it
 *   verbs     «اطلب طباعة», the one gold primary, and «شارك مشروعًا»
 *             (hub/HubActions.tsx)
 *   sections  six links, one per section page, «لك» the page on screen
 *             (hub/SectionNav.tsx: a 3 by 2 grid on a phone, a track from `lg`)
 *   the home  the featured project, trending, requests, makers, Levo Studio and
 *             what follows them (hub/ForYouPanel.tsx)
 *
 * EVERY SECTION HAS ITS OWN PAGE NOW (D-7). The home tabs are gone; an old
 * `?tab=` address is sent to its page with `replace`, the term kept
 * (hub/tabs.ts). `?list=products` is the home own list of community products.
 * While a term is set, the issue steps aside: the page is its results.
 *
 * A NEW REQUEST IS THE EDITOR. «اطلب طباعة» opens /requests/new; «شارك
 * مشروعًا» opens the project composer. A guest goes through sign-in first and
 * comes back to the door they chose.
 *
 * The page sits behind CommunityGate (src/App.tsx): while the owner keeps the
 * community under maintenance, a refused visitor never reaches it.
 */
import React, { Suspense, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { Box, Calculator, Search, X } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { merchantApi, type MerchantMe } from '../lib/merchant';
import { useMediaQuery } from '../lib/useMediaQuery';
import { AsideSkeleton, HOME_GRID, MainSkeleton } from '../components/community/hub/HomeSkeleton';
import { PostSkeleton, StoreListSkeleton } from '../components/community/hub/parts';
import HubActions from '../components/community/hub/HubActions';
import SectionNav from '../components/community/hub/SectionNav';
import TopBar from '../components/community/hub/TopBar';
import { useHubStrings } from '../components/community/hub/strings';
import { legacyTabTarget } from '../components/community/hub/tabs';
import { warmHome } from '../components/community/hub/useHomeData';
import { BoardRailFrame, boardRailRemembered, workshopHint } from '../components/community/hub/boardFrame';
import { useSearchBox } from '../components/community/search/useSearchBox';
import CommunitySurface from '../components/community/CommunitySurface';

/**
 * THE HOME BODY IS A CHUNK OF ITS OWN (hub/ForYouPanel.tsx: the main column,
 * the aside, and what follows them). The entry names every chunk the first
 * chunk of this page needs (its preload list, on every visit); the body uses
 * the community kit, the like and save buttons and the request card, and
 * those stay out of that list (plan R6). The page starts the reads of the body
 * (hub/useHomeData.ts) while the chunk is on its way, holds the skeleton at
 * the cards' heights meanwhile, and keeps the sections and the workshop
 * board mounted throughout.
 */
const loadHome = () => import('../components/community/hub/ForYouPanel');
const HomeMain = React.lazy(() => loadHome().then((m) => ({ default: m.HomeMain })));
const HomeAside = React.lazy(() => loadHome().then((m) => ({ default: m.HomeAside })));
const HomeBelow = React.lazy(() => loadHome().then((m) => ({ default: m.HomeBelow })));
/** The home own list of community products (`?list=products`). */
const ProductsPanel = React.lazy(() => import('../components/community/hub/ProductsPanel'));
/** The home with a term: the projects that answer it. */
const ProjectsPanel = React.lazy(() => import('../components/community/hub/ProjectsPanel'));
/** The cross-entity search under the bar (Phase 3) — fetched the first time the box is focused. */
const SearchOverlay = React.lazy(() => import('../components/community/search/SearchOverlay'));
/** «طلبات تناسبك» (Phase 5d): the workshop's own board, leading a merchant's home — a lazy chunk nobody else fetches. */
const BoardRail = React.lazy(() => import('../components/community/hub/BoardRail'));

/**
 * THE SECTION PAGES ARE REACHED THROUGH THIS CHUNK (community UI plan B4):
 * src/App.tsx names it for /community/following, /community/stores and
 * /community/makers, and the door loads the page (./community/Sections.tsx).
 */
export { default as CommunitySections } from './community/Sections';

/** The request editor (community UI plan B4, C4). */
const NEW_REQUEST_PATH = '/requests/new';
/** The project composer. */
const NEW_PROJECT_PATH = '/community/projects/new';

/** From `lg`: the desktop dashboard (IMG_8462). */
const WIDE_QUERY = '(min-width: 1024px)';

/** An old `?tab=` address goes to its section page, once and without a history entry. */
export default function Community() {
  const [params] = useSearchParams();
  const moved = legacyTabTarget(params);
  return moved ? <Navigate to={moved} replace /> : <CommunityHome />;
}

function CommunityHome() {
  const s = useHubStrings();
  const { user, isAuthenticated } = useAuth();
  const [params, setParams] = useSearchParams();
  const list = params.get('list') === 'products' ? 'products' : null;
  const q = (params.get('q') ?? '').trim().slice(0, 60);
  const viewer = user?.id ?? 'guest';
  const wide = useMediaQuery(WIDE_QUERY);

  /**
   * THE BOX AND THE URL. What is typed shows at once; the URL — and so the
   * search — follows 300 ms after the last key. A term that arrives from the
   * URL (Back, a shared link) is written into the box, but never over what the
   * person is in the middle of typing.
   *
   * WHILE THE OVERLAY IS OPEN THE URL WAITS. The overlay already asks the
   * server twice per settled keystroke (suggestions and the sections); the
   * home own results behind a full-height panel would be a third read nobody
   * sees, and would swap the home for the projects search under the panel.
   * So the debounce is suspended while the panel is open and resumes the
   * moment it steps aside (Escape, a tap outside): the box and the URL then
   * agree again within 300 ms; Enter writes it at once.
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
   * THE OVERLAY IS THE CROSS-ENTITY VIEW; THE HOME RESULTS ARE THE PROJECTS.
   * The box opens the overlay on focus (search/useSearchBox.ts); Enter — or a
   * row of the overlay that says «ابحث في…» — writes the term to the URL at
   * once, and the overlay steps aside so the results answer.
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

  /**
   * Which merchant this viewer is, for «طلبات تناسبك» — asked only with a
   * session, and once per account: keyed on the id, not on the user object,
   * which a session refresh replaces without anyone having changed.
   */
  const userId = user?.id ?? null;
  const [me, setMe] = useState<MerchantMe | null>(null);
  // Whether `me` has been ANSWERED yet — the first-paint workshop hint stands only until it is.
  const [meAsked, setMeAsked] = useState(false);
  useEffect(() => {
    if (!userId) {
      setMe(null);
      setMeAsked(true);
      return;
    }
    setMeAsked(false);
    let alive = true;
    merchantApi
      .me()
      .then((d) => {
        if (!alive) return;
        setMe(d);
        setMeAsked(true);
      })
      .catch(() => {
        if (!alive) return;
        setMe(null);
        setMeAsked(true);
      });
    return () => {
      alive = false;
    };
  }, [userId]);

  // The reads of the home body start with the page, not after its chunk (it is lazy).
  const issue = list !== 'products' && !q;
  useEffect(() => {
    if (issue) warmHome(viewer);
  }, [issue, viewer]);

  // A guest goes through sign-in first and comes back to the door they chose.
  const newRequestLink = isAuthenticated ? { to: NEW_REQUEST_PATH } : { to: '/auth', state: { from: NEW_REQUEST_PATH } };
  const composerLink = isAuthenticated ? { to: NEW_PROJECT_PATH } : { to: '/auth', state: { from: NEW_PROJECT_PATH } };

  const placeholder = list === 'products' ? s.search.products : s.searchAll;
  const searchForm = (
    <form
      ref={box.barRef}
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        submitSearch(draft);
      }}
      className="relative min-w-0"
    >
      <label htmlFor="community-search" className="sr-only">
        {placeholder}
      </label>
      <Search aria-hidden="true" className="pointer-events-none absolute start-4 top-1/2 h-5 w-5 -translate-y-1/2 text-text-muted" />
      <input
        id="community-search"
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        // Latin runs left to right in an Arabic page, and stays put when the overlay closes.
        dir="auto"
        className={`lv-input w-full ps-12 pe-11 [&::-webkit-search-cancel-button]:appearance-none ${wide ? 'rounded-full' : 'rounded-md'}`}
        value={draft}
        maxLength={60}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={placeholder}
        data-community-search
        {...box.inputProps}
      />
      {draft && (
        <button
          type="button"
          onClick={clearSearch}
          aria-label={s.clearSearch}
          className="absolute end-1 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full text-text-muted transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </form>
  );

  const nav = <SectionNav variant={wide ? 'track' : 'grid'} />;
  let panel: React.ReactNode;
  if (list === 'products' || q) {
    panel = (
      <div className="flex flex-col gap-6">
        {nav}
        <Suspense fallback={<StoreListSkeleton />}>{list === 'products' ? <ProductsPanel q={q} viewer={viewer} onClear={clearSearch} /> : <ProjectsPanel q={q} />}</Suspense>
      </div>
    );
  } else {
    /**
     * «طلبات تناسبك» (Phase 5d, docs/COMMUNITY_ECOSYSTEM.md §9.5): a signed-in
     * WORKSHOP's home leads with the open requests its printers can make (GET
     * /api/community/requests?for=me, hub/BoardRail.tsx), under the sections.
     * Decided at FIRST paint where the device already knows (review
     * 2026-09-30): the frame of the rail is there before the home paints,
     * not pushed above it later. The own «طلبات الطباعة» of the home is the
     * newest of the board, for everyone.
     */
    const workshop = isAuthenticated && (!!me?.store || boardRailRemembered(viewer) || (!meAsked && workshopHint(viewer)));
    panel = (
      <div data-community-panel="foryou" className="flex flex-col gap-8">
        <div className={HOME_GRID}>
          <div className="flex min-w-0 flex-col gap-6">
            {nav}
            {workshop && (
              <Suspense fallback={<BoardRailFrame />}>
                <BoardRail viewer={viewer} me={me} />
              </Suspense>
            )}
            <Suspense fallback={<MainSkeleton wide={wide} />}>
              <HomeMain viewer={viewer} wide={wide} />
            </Suspense>
          </div>
          <div className="flex min-w-0 flex-col gap-6">
            <Suspense fallback={<AsideSkeleton />}>
              <HomeAside viewer={viewer} wide={wide} />
            </Suspense>
          </div>
        </div>
        <Suspense fallback={<PostSkeleton />}>
          <HomeBelow viewer={viewer} composerLink={composerLink} tools={<ToolsSection />} />
        </Suspense>
      </div>
    );
  }

  return (
    <CommunitySurface className="w-full min-h-screen pb-28 text-text-primary">
      <TopBar wide={wide} search={wide ? searchForm : undefined} />

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
            scopeLabel={list === 'products' ? s.communityProducts : s.tabs.projects}
          />
        </Suspense>
      )}

      <div className={`mx-auto flex max-w-6xl flex-col px-4 ${wide ? 'gap-6 pt-6' : 'gap-3 pt-3'}`}>
        {wide ? (
          <div className="flex items-center justify-between gap-6">
            <header className="min-w-0">
              <h1 className="text-4xl font-black leading-tight text-text-primary">{s.title}</h1>
              <p className="mt-1 text-lg text-text-secondary">{s.dek}</p>
            </header>
            {/* While a search is running, the page is its results: the verbs step aside. */}
            {!q && <HubActions wide newRequestLink={newRequestLink} composerLink={composerLink} />}
          </div>
        ) : (
          <>
            {searchForm}
            {!q && <HubActions wide={false} newRequestLink={newRequestLink} composerLink={composerLink} />}
          </>
        )}
        <div className={`min-h-[380px] ${wide ? '' : 'pt-1'}`}>{panel}</div>
      </div>
    </CommunitySurface>
  );
}

// ------------------------------------------------------------------- pieces

/**
 * «أدوات الصانع»: the calculator prices from the shop's own filament; the
 * library is not built yet and says so. Levo Studio has its own card in the
 * home (hub/StudioCard.tsx).
 */
function ToolsSection() {
  const { t } = useLanguage();
  const s = useHubStrings();
  // Link cards on the canvas: resting clay (22px, `--clay-1`) that dents while
  // held; the rail pads their cast in, since a sideways scroller clips it.
  const tile = 'lv-surface relative flex h-24 w-[200px] shrink-0 snap-start flex-col justify-center overflow-hidden p-4 text-start';
  return (
    <div className="-mx-4 -my-2 flex snap-x gap-3 overflow-x-auto px-4 pt-2 pb-3 hide-scrollbar">
      <Link
        to="/tools"
        className={`${tile} active:shadow-press focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus`}
      >
        <div aria-hidden="true" className="absolute bottom-0 end-2 opacity-35">
          <Calculator className="h-20 w-20" />
        </div>
        <h3 className="mb-1 text-sm font-bold text-text-primary">{s.calculator}</h3>
        <p className="text-xs text-text-secondary">{s.openCalculator}</p>
      </Link>
      <div className={`${tile} opacity-70 shadow-none`} aria-disabled="true">
        <div aria-hidden="true" className="absolute bottom-0 end-2 opacity-35">
          <Box className="h-20 w-20" />
        </div>
        <h3 className="mb-1 text-sm font-bold text-text-primary">{s.library}</h3>
        <p className="text-xs text-text-muted">{t('comingSoon')}</p>
      </div>
    </div>
  );
}
