import AnimatedItem from '../components/AnimatedItem';
import { useRail } from '../lib/useRail';
import React, { Suspense, useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useLanguage } from '../LanguageContext';
import { PackageSearch } from 'lucide-react';
import { api, ApiProduct, PublicSettings, HomeTaxon, SiteMediaEntry } from '../lib/api';
import Hero from '../components/home/Hero';
import ServicesGrid from '../components/home/ServicesGrid';
import OpenBoxShelf from '../components/home/OpenBoxShelf';
import ProductCard from '../components/home/ProductCard';
import SectionHeader from '../components/home/SectionHeader';
import Marquee from '../components/home/Marquee';
import { ItemStrip, BrandMarquee } from '../components/home/Strips';
import CategoryBoard from '../components/home/CategoryBoard';
/**
 * THE BUNDLES SHELF IS LAZY (docs/BUNDLES_MYSTERY.md §14). This page is the
 * storefront's first paint, so importing the bundle card — and with it the
 * countdown, the offer badge and the tier metadata — would put all of them
 * into the entry chunk of every first visit and undo the split that moving
 * `Bundles` off the eager list just achieved.
 */
const BundlesShelf = React.lazy(() => import('../components/home/BundlesShelf'));
/**
 * The same reasoning, for the same reason: the combo card reads
 * `BundleCard`'s composition block, so eager-importing it would pull the
 * bundle payload's whole surface into the first-paint chunk.
 * `tests/bundleBudget.test.ts` measures exactly that closure.
 */
const ComboShelf = React.lazy(() => import('../components/home/ComboShelf'));
/**
 * THE SHELVES BELOW THE FOLD ARE THEIR OWN CHUNKS AND THEIR OWN REQUEST.
 * None of them is on the first screen, and each renders null until it has
 * cards — so a slow or failed second fetch costs the shopper nothing they are
 * currently looking at.
 */
const BestSellersRail = React.lazy(() => import('../components/home/BestSellersRail'));
const FlashDealsBoard = React.lazy(() => import('../components/home/FlashDealsBoard'));
const FilamentShelf = React.lazy(() => import('../components/home/FilamentShelf'));
const SpotlightTiles = React.lazy(() => import('../components/home/SpotlightTiles'));
import Spinner from '../components/ui/Spinner';
import { Skeleton, SkeletonGroup, ProductCardSkeleton } from '../components/ui/Skeleton';
import { ErrorState, EmptyState } from '../components/ui/AsyncStates';
import { markHomeCriticalReady } from '../lib/appBootstrap';
import { readPageCache, writePageCache } from '../lib/pageCache';

/** One key: the home shelves are the same request for everybody signed in
 *  the same way, and AuthContext drops the lot when that changes. */
const HOME_CACHE_KEY = 'home';

export default function Home() {
  const { t, loc } = useLanguage();
  // The flagship product rail. Its cards are AnimatedItem wrappers, which is
  // exactly why useRail measures snap points from offsetWidth: those wrappers
  // hold a scale transform until they scroll into view.
  const discountsRail = useRail();

  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [categories, setCategories] = useState<HomeTaxon[]>([]);
  const [brands, setBrands] = useState<HomeTaxon[]>([]);
  /**
   * The first screen's own artwork, already resolved by the server into
   * `/files/...` URLs — brand marks and service icons. Empty until /api/home
   * answers, and every consumer below treats empty as "draw what you drew
   * before", so a slow or failed fetch degrades to the previous design rather
   * than to holes.
   */
  const [siteMedia, setSiteMedia] = useState<SiteMediaEntry[]>([]);
  /** Open box / used / refurbished, newest first — the server's own shelf. */
  const [openBox, setOpenBox] = useState<ApiProduct[]>([]);

  const [discountedProducts, setDiscountedProducts] = useState<ApiProduct[]>([]);
  const [newProducts, setNewProducts] = useState<ApiProduct[]>([]);
  /**
   * The below-the-fold shelves, from `/api/home/sections` — a SECOND request,
   * deliberately. Folding these queries into `/api/home` would make the first
   * paint every visitor waits on slower in order to serve the part most of
   * them scroll past. An empty object is the honest default: every shelf
   * renders nothing until it has cards.
   */
  const [shelves, setShelves] = useState<{
    best_sellers?: ApiProduct[];
    flash_deals?: ApiProduct[];
    filament?: ApiProduct[];
    super_deals?: ApiProduct[];
  }>({});
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);

  const [offset, setOffset] = useState(20);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<unknown>(null);
  /** The whole of what `GET /api/home` answers — one snapshot, one apply. */
  type HomePayload = {
    settings: PublicSettings;
    discounted: ApiProduct[];
    latest: ApiProduct[];
    categories?: HomeTaxon[];
    brands?: HomeTaxon[];
    siteMedia?: SiteMediaEntry[];
    open_box?: ApiProduct[];
  };

  const observerTarget = useRef<HTMLDivElement | null>(null);
  // Monotonic request id so a retried /api/home fetch ignores stale responses.
  const homeReqRef = useRef(0);

  /**
   * PAINTED FROM THE LAST ANSWER, THEN CORRECTED.
   *
   * «عند الرجوع للوراء لا يضطر أن يحمل الصفحة مرة ثانية.» Home is what `back`
   * lands on from a product page, and it used to start at `initialLoading =
   * true` every single time — full skeleton, full round trip — for a shelf the
   * customer was reading four seconds earlier. The request still goes out
   * immediately; what the snapshot changes is whether they watch grey boxes
   * while it does. See src/lib/pageCache.ts.
   */
  const applyHome = useCallback((data: HomePayload) => {
    setSettings(data.settings);
    setDiscountedProducts(data.discounted || []);
    setNewProducts(data.latest || []);
    setCategories(data.categories || []);
    setBrands(data.brands || []);
    setSiteMedia(data.siteMedia || []);
    setOpenBox(data.open_box || []);
    setHasMore((data.latest || []).length >= 20);
  }, []);

  const fetchHome = useCallback(async () => {
    const reqId = ++homeReqRef.current;
    const snapshot = readPageCache<HomePayload>(HOME_CACHE_KEY);
    if (snapshot) applyHome(snapshot);
    setInitialLoading(!snapshot);
    setLoadError(null);
    try {
      const data = await api.get<HomePayload>('/api/home');
      if (homeReqRef.current !== reqId) return;
      applyHome(data);
      writePageCache(HOME_CACHE_KEY, data);
    } catch (err) {
      console.error('Failed to fetch home products', err);
      if (homeReqRef.current !== reqId) return;
      // A failed fetch is an ERROR with retry — never rendered as "no products".
      // UNLESS a snapshot is already on screen: replacing shelves the server
      // really did send with an error card is a worse answer than leaving the
      // last good one up, and the next wake asks again within the minute.
      if (snapshot) return;
      setLoadError(err);
      setHasMore(false);
    } finally {
      if (homeReqRef.current === reqId) setInitialLoading(false);
    }
  }, [applyHome]);

  useEffect(() => {
    fetchHome();
    return () => {
      homeReqRef.current += 1;
    };
  }, [fetchHome]);

  // Fired alongside the critical fetch but never awaited by it: a failure here
  // silently costs the shelves, never the page.
  useEffect(() => {
    let cancelled = false;
    api
      .get<typeof shelves>('/api/home/sections')
      .then((data) => {
        if (!cancelled) setShelves(data ?? {});
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The app intro masks real bootstrap work, never a theatrical timeout.
  // A settled error counts as ready because the page then has honest retry UI.
  useEffect(() => {
    if (!initialLoading) markHomeCriticalReady();
  }, [initialLoading]);

  const loadMore = useCallback(
    async (retry = false) => {
      if (isLoadingMore || !hasMore || initialLoading) return;
      // After a failure, don't auto-retry in a loop from the intersection
      // observer — the user retries explicitly via the button.
      if (loadMoreError && !retry) return;
      setIsLoadingMore(true);
      setLoadMoreError(null);
      try {
        const data = await api.get<{ products: ApiProduct[] }>(`/api/products?limit=20&offset=${offset}`);
        const fetched = data.products || [];
        setNewProducts((prev) => {
          const seen = new Set(prev.map((p) => p.id));
          return [...prev, ...fetched.filter((p) => !seen.has(p.id))];
        });
        setOffset((o) => o + fetched.length);
        if (fetched.length < 20) setHasMore(false);
      } catch (e) {
        console.error(e);
        setLoadMoreError(e);
      } finally {
        setIsLoadingMore(false);
      }
    },
    [isLoadingMore, hasMore, initialLoading, offset, loadMoreError]
  );

  useEffect(() => {
    const target = observerTarget.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadMore();
        }
      },
      { threshold: 0.1 }
    );
    observer.observe(target);
    return () => {
      observer.unobserve(target);
    };
  }, [loadMore]);

  // The admin-configured home layout: which sections show, and IN WHICH
  // ORDER. The order was draggable in the admin panel and the storefront
  // ignored it entirely, rendering a hard-coded sequence — so reordering
  // sections changed nothing a customer could see. It is honoured now.
  const layout = settings?.homeSections ?? [];
  const sectionVisible = (id: string) => {
    const s = layout.find((x) => x.id === id);
    return s ? s.isVisible : true;
  };
  /** Sort key for a section, falling back to the end for unknown ids. */
  const orderOf = (id: string) => {
    const i = layout.findIndex((x) => x.id === id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };

  /**
   * The products the category rails borrow a cover photo from.
   *
   * Memoised HERE rather than built inline at the call site: a fresh array
   * literal in JSX is a new reference on every Home render, which would defeat
   * the `useMemo` inside CategoryBoard and rebuild the cover map on every
   * scroll tick this page already re-renders for.
   */
  const coverPool = useMemo(
    () => [...newProducts, ...discountedProducts, ...openBox],
    [newProducts, discountedProducts, openBox]
  );

  const bannersFor = (slot: string) =>
    sectionVisible(slot) ? settings?.homeBanners?.[slot] ?? [] : [];
  const itemsFor = (slot: string) =>
    sectionVisible(slot) ? settings?.homeSectionItems?.[slot] ?? [] : [];

  // The hero takes the first banner slot the owner filled; the second slot
  // keeps its own place further down the page, where the admin put it.
  const heroBanners = [...bannersFor('first_banner'), ...bannersFor('second_banner')];

  const homeAds = sectionVisible('ads_panel') ? settings?.homeAds ?? [] : [];

  return (
    /**
     * `overflow-x: clip` is what lets a child run to both screen edges without
     * adding a horizontal scrollbar — see the `bleed-x` utility in index.css.
     * CLIP, not hidden: hidden would make this a scroll container and silently
     * kill `position: sticky` anywhere inside the page.
     */
    <div className="w-full pb-24 text-zinc-300 bg-black overflow-x-clip">
      <Hero banners={heroBanners} loading={initialLoading} />

      {/* THE BLACK PANEL IS THE FULL WIDTH OF THE SCREEN; only its CONTENT is
          a centred column. It used to be `max-w-7xl mx-auto` itself, so every
          full-bleed attempt inside it could only reach 80rem — which is why
          the ads ticker and the brands belt stopped short of the edges on a
          large screen while the hero above them did not. */}
      <div className="relative z-30 pt-8 sm:pt-10 pb-2 bg-black rounded-t-[28px] -mt-7">

        {/* Ads Marquee — the cap of the black panel: flush with its top edge,
            running the whole width of the screen, no rule underneath (the
            owner asked the line gone). Marquee measures the viewport and
            repeats the notices until the belt is wider than any screen, so it
            loops endlessly with no visible edge even when the owner wrote a
            single short line. */}
        {homeAds.length > 0 && (
          <div className="-mt-8 sm:-mt-10 mb-8 sm:mb-10 rounded-t-[28px] bg-zinc-900/40 overflow-hidden">
            <Marquee speed={42}>
              <div className="flex items-center whitespace-nowrap py-2.5">
                {homeAds.map((ad) => (
                  <span key={ad.id} className="flex items-center text-[13px] text-zinc-300 shrink-0">
                    <span className="px-6">{ad.text}</span>
                    <span aria-hidden className="w-1 h-1 rounded-full bg-gold/60 shrink-0" />
                  </span>
                ))}
              </div>
            </Marquee>
          </div>
        )}

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">

        <ServicesGrid siteMedia={siteMedia} />

        {/* The owner-configurable sections, in the ORDER the admin panel
            shows them. Each renders nothing when it has no content, so an
            unconfigured section costs no space instead of showing an empty
            shelf. `categories` and `top_brands` fall back to the REAL
            catalogue and brand tables when the owner has authored no cards of
            their own — those two are data the store already has, and making
            the owner retype their own taxonomy to see it was the reason the
            sections stayed blank. */}
        {[
          {
            id: 'coupons_offers',
            order: orderOf('coupons_offers'),
            node: (
              <ItemStrip
                key="coupons_offers"
                id="coupons_offers"
                title={t('couponsOffers')}
                accent="bg-rose-500"
                items={itemsFor('coupons_offers')}
              />
            ),
          },
          {
            id: 'categories',
            order: orderOf('categories'),
            node: sectionVisible('categories') ? (
              itemsFor('categories').length > 0 ? (
                <ItemStrip
                  key="categories"
                  id="categories"
                  title={t('browseCategories')}
                  accent="bg-olive"
                  items={itemsFor('categories')}
                />
              ) : (
                // The covers are borrowed from products this page has
                // already fetched — no second request, and a section with no
                // product on screen simply shows its monogram.
                <CategoryBoard key="categories" categories={categories} products={coverPool} />
              )
            ) : null,
          },
          {
            id: 'open_box',
            order: orderOf('open_box'),
            // Renders nothing when the shop has no graded stock, so an empty
            // shelf costs no vertical space on the first screen.
            node: sectionVisible('open_box') ? <OpenBoxShelf key="open_box" products={openBox} /> : null,
          },
          {
            id: 'top_brands',
            order: orderOf('top_brands'),
            // One rendering for both sources: the owner's authored cards
            // become the belt's logos; the real brands table is the
            // fallback. The belt drifts, pauses under a finger or pointer,
            // and resumes when it leaves.
            node: sectionVisible('top_brands') ? (
              <BrandMarquee key="top_brands" items={itemsFor('top_brands')} brands={brands} siteMedia={siteMedia} />
            ) : null,
          },
          {
            id: 'discounts_offers',
            order: orderOf('discounts_offers'),
            // This IS the admin's `discounts_offers` section: its visibility
            // toggle was honoured before, its ORDER handle was not — the rail
            // rendered at a hard-coded spot below everything sortable. It now
            // rides the same ordered list as its siblings.
            node:
              discountedProducts.length > 0 && sectionVisible('discounts_offers') ? (
                <section key="discounts_offers" data-home-section="discounts_offers" className="mb-10 sm:mb-12">
                  <SectionHeader title={t('homeDiscounts')} accent="bg-rose-500" to="/products" />
                  <div
                    ref={discountsRail.ref}
                    className="flex gap-3 sm:gap-4 overflow-x-auto overscroll-x-contain hide-scrollbar pb-2 -mx-4 px-4 sm:mx-0 sm:px-0 snap-x"
                  >
                    {discountedProducts.map((p, index) => (
                      <AnimatedItem key={p.id} index={index} className="snap-start shrink-0">
                        <ProductCard p={p} widthClass="w-[164px] sm:w-[190px]" />
                      </AnimatedItem>
                    ))}
                  </div>
                </section>
              ) : null,
          },
          {
            id: 'best_sellers',
            order: orderOf('best_sellers'),
            // A RANKED rail, not another row of identical cards — the position
            // is the only thing this shelf knows that the catalogue does not.
            node:
              sectionVisible('best_sellers') && (shelves.best_sellers?.length ?? 0) > 0 ? (
                <Suspense key="best_sellers" fallback={null}>
                  <BestSellersRail products={shelves.best_sellers!} />
                </Suspense>
              ) : null,
          },
          {
            id: 'flash_deals',
            order: orderOf('flash_deals'),
            // A BOARD with a lead tile and live countdowns: a deal has a clock,
            // and a clock has to be read rather than flicked past.
            node:
              sectionVisible('flash_deals') && (shelves.flash_deals?.length ?? 0) > 0 ? (
                <Suspense key="flash_deals" fallback={null}>
                  <FlashDealsBoard products={shelves.flash_deals!} />
                </Suspense>
              ) : null,
          },
          {
            id: 'spotlight',
            order: orderOf('spotlight'),
            /**
             * The two rotating tiles. «سلكشن» is ranked HERE, in the browser,
             * over products this page already fetched — the shop records no
             * browsing telemetry and none is added for a tile. See
             * src/lib/recentlyViewed.ts.
             */
            node:
              sectionVisible('spotlight') &&
              ((shelves.super_deals?.length ?? 0) > 0 || newProducts.length > 0) ? (
                <Suspense key="spotlight" fallback={null}>
                  <SpotlightTiles
                    selectionPool={[...(shelves.best_sellers ?? []), ...newProducts].slice(0, 24)}
                    superDeals={shelves.super_deals ?? []}
                  />
                </Suspense>
              ) : null,
          },
          {
            id: 'combos',
            order: orderOf('combos'),
            // Newegg-shaped: [part] + [part] = [price], with the saving called
            // out above it. Its own request, like the bundles shelf.
            node: sectionVisible('combos') ? (
              <Suspense key="combos" fallback={null}>
                <ComboShelf />
              </Suspense>
            ) : null,
          },
          {
            id: 'filament',
            order: orderOf('filament'),
            // A dense swatch wall: filament is chosen by comparison, and a
            // rail hides most of the range behind a swipe.
            node:
              sectionVisible('filament') && (shelves.filament?.length ?? 0) > 0 ? (
                <Suspense key="filament" fallback={null}>
                  <FilamentShelf products={shelves.filament!} />
                </Suspense>
              ) : null,
          },
          {
            id: 'bundles',
            order: orderOf('bundles'),
            // Registered in INITIAL_SECTIONS + SECTION_ICONS as well
            // (src/components/AdminHomeSettings.tsx): a section id missing from
            // those gets orderOf = MAX_SAFE_INTEGER — pinned to the bottom of
            // the page for ever — sectionVisible = true (impossible to hide)
            // and no row in the admin's drag-to-reorder list.
            //
            // The shelf renders null until it has cards, so an unconfigured
            // section costs no space; the fallback is null for the same reason.
            node: sectionVisible('bundles') ? (
              <Suspense key="bundles" fallback={null}>
                <BundlesShelf />
              </Suspense>
            ) : null,
          },
          {
            id: 'second_banner',
            order: orderOf('second_banner'),
            // The second banner slot only appears down here when the first
            // slot already supplied the hero; otherwise it IS the hero and
            // rendering it twice would show the same picture on one screen.
            node:
              bannersFor('first_banner').length > 0 && bannersFor('second_banner').length > 0 ? (
                <section key="second_banner" data-home-section="second_banner" className="mb-10 sm:mb-12">
                  <div className="rounded-2xl overflow-hidden">
                    <Hero banners={bannersFor('second_banner')} loading={false} />
                  </div>
                </section>
              ) : null,
          },
        ]
          .filter((x) => x.node !== null)
          .sort((a, b) => a.order - b.order)
          .map((x) => x.node)}

        {/* Skeletons mirror the real sections (horizontal row + grid) —
            reserved dimensions, no fake names or prices. */}
        {initialLoading && (
          <SkeletonGroup>
            <div className="mb-10 sm:mb-12" aria-hidden="true">
              <div className="flex items-center gap-2.5 mb-4 sm:mb-5">
                <div className="w-1 h-5 bg-zinc-800 rounded-full"></div>
                <Skeleton className="h-6 w-40" />
              </div>
              <div className="flex gap-3 sm:gap-4 overflow-hidden pb-2">
                {Array.from({ length: 4 }, (_, i) => (
                  <ProductCardSkeleton key={i} className="w-[164px] sm:w-[190px] shrink-0" />
                ))}
              </div>
            </div>
            <div className="mb-12" aria-hidden="true">
              <div className="flex items-center gap-2.5 mb-4 sm:mb-5">
                <div className="w-1 h-5 bg-zinc-800 rounded-full"></div>
                <Skeleton className="h-6 w-48" />
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4">
                {Array.from({ length: 8 }, (_, i) => (
                  <ProductCardSkeleton key={i} />
                ))}
              </div>
            </div>
          </SkeletonGroup>
        )}

        {/* Failed home load: an honest error with retry — not "no products". */}
        {!initialLoading && loadError != null && (
          <ErrorState error={loadError} onRetry={fetchHome} />
        )}

        {/* New arrivals — the infinite grid. Not an admin slot: it is the
            catalogue itself and always closes the page. */}
        {newProducts.length > 0 && (
          <div data-home-section="new_arrivals" className="mb-12">
            <SectionHeader title={t('homeNewArrivals')} accent="bg-olive" to="/products" />

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4">
              {newProducts.map((p, index) => (
                <AnimatedItem key={p.id} index={index}>
                  <ProductCard p={p} widthClass="w-full" />
                </AnimatedItem>
              ))}
            </div>
            {hasMore && (
              <div ref={observerTarget} className="w-full h-20 flex items-center justify-center mt-4">
                {loadMoreError != null ? (
                  <button
                    type="button"
                    onClick={() => loadMore(true)}
                    className="min-h-[44px] px-5 rounded-xl bg-zinc-900 border border-zinc-800 text-sm font-bold text-zinc-300 hover:text-white hover:bg-zinc-800 transition-colors"
                  >
                    {loc('تعذر تحميل المزيد — إعادة المحاولة', 'Failed to load more — retry', 'زیاتر بارنەبوو — دووبارە هەوڵ بدەوە')}
                  </button>
                ) : (
                  <Spinner size="md" />
                )}
              </div>
            )}
          </div>
        )}

        {/* Genuinely empty catalog — only when the load actually succeeded. */}
        {!initialLoading && loadError == null && discountedProducts.length === 0 && newProducts.length === 0 && (
          <EmptyState
            icon={<PackageSearch aria-hidden="true" className="w-6 h-6" />}
            title={loc('لا توجد منتجات بعد', 'No products yet', 'هێشتا هیچ بەرهەمێک نییە')}
          />
        )}
      </div>
      </div>
    </div>
  );
}
