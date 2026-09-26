import React, { Suspense, useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useLanguage } from '../LanguageContext';
import { PackageSearch } from 'lucide-react';
import { api, ApiProduct, PublicSettings, HomeTaxon, SiteMediaEntry, pickText } from '../lib/api';
import Hero from '../components/home/Hero';
import Marquee from '../components/home/Marquee';
import CategoryBento from '../components/home/v2/CategoryBento';
import PrinterFinder from '../components/home/v2/PrinterFinder';
import { EDITORIAL_SLOT, latestChips, resolveBento, resolveEditorial } from '../lib/homeLayout';
/**
 * HOMEPAGE V2 — the owner's spec board (docs/design/home-v2-*.png), in this
 * exact order: top controls → search → hero → ticker → «تسوق حسب الفئة» →
 * «محتار أي طابعة تناسبك؟» → «أحدث المنتجات» → two editorial banners →
 * services → the bottom bar. (Levo Community's project cards come between
 * the banners and the services in the spec; the shop has no community posts
 * with likes and comments to draw them from, so that section is not drawn —
 * see docs/DECISIONS.md.)
 *
 * The first two sections below the ticker are EAGER: on a phone they are on
 * the first screen. Everything after them is its own lazy chunk, so the first
 * paint every visitor waits on carries none of it — the budget in
 * tests/bundleBudget.test.ts measures exactly that closure.
 *
 * The shelves the previous home page stacked here (best sellers, flash deals,
 * bundles, combos, filament picks, open box, brands, discounts) are not part
 * of the owner's order and are no longer mounted; their components remain for
 * the pages that still use them.
 */
const LatestProducts = React.lazy(() => import('../components/home/v2/LatestProducts'));
const EditorialBanners = React.lazy(() => import('../components/home/v2/EditorialBanners'));
const ServicesGrid = React.lazy(() => import('../components/home/ServicesGrid'));
import { ErrorState, EmptyState } from '../components/ui/AsyncStates';
import { markHomeCriticalReady } from '../lib/appBootstrap';
import { readPageCache, writePageCache } from '../lib/pageCache';

/** One key: the home shelves are the same request for everybody signed in
 *  the same way, and AuthContext drops the lot when that changes. */
const HOME_CACHE_KEY = 'home';

export default function Home() {
  const { loc, lang } = useLanguage();

  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [categories, setCategories] = useState<HomeTaxon[]>([]);
  /** Site-media images the owner uploaded (banner slots), resolved by the server. */
  const [siteMedia, setSiteMedia] = useState<SiteMediaEntry[]>([]);
  /** Open box / used / refurbished, newest first — the server's own shelf. */
  const [openBox, setOpenBox] = useState<ApiProduct[]>([]);
  const [discountedProducts, setDiscountedProducts] = useState<ApiProduct[]>([]);
  const [newProducts, setNewProducts] = useState<ApiProduct[]>([]);
  /**
   * `/api/home/sections` — a SECOND request, fired alongside the first and
   * never awaited by it. It no longer draws shelves of its own; its products
   * widen what a filter chip can show before its own section request answers.
   */
  const [shelves, setShelves] = useState<{
    best_sellers?: ApiProduct[];
    flash_deals?: ApiProduct[];
    filament?: ApiProduct[];
    super_deals?: ApiProduct[];
  }>({});
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
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

  // Monotonic request id so a retried /api/home fetch ignores stale responses.
  const homeReqRef = useRef(0);

  /**
   * PAINTED FROM THE LAST ANSWER, THEN CORRECTED.
   *
   * «عند الرجوع للوراء لا يضطر أن يحمل الصفحة مرة ثانية.» Home is what `back`
   * lands on from a product page. The request still goes out immediately;
   * what the snapshot changes is whether the customer watches grey boxes
   * while it does. See src/lib/pageCache.ts.
   */
  const applyHome = useCallback((data: HomePayload) => {
    setSettings(data.settings);
    setDiscountedProducts(data.discounted || []);
    setNewProducts(data.latest || []);
    setCategories(data.categories || []);
    setSiteMedia(data.siteMedia || []);
    setOpenBox(data.open_box || []);
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
      // A failed fetch is an ERROR with retry — never rendered as "no
      // products" — unless a snapshot is already on screen, which is a better
      // answer than an error card over shelves the server really did send.
      if (snapshot) return;
      setLoadError(err);
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
  // silently costs a wider chip preview, never the page.
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
  }, []);

  // The app intro masks real bootstrap work, never a theatrical timeout.
  // A settled error counts as ready because the page then has honest retry UI.
  useEffect(() => {
    if (!initialLoading) markHomeCriticalReady();
  }, [initialLoading]);

  // The admin's visibility switches still apply to the sections that have
  // one; the ORDER is the owner's spec and no longer a setting.
  const layout = settings?.homeSections ?? [];
  const sectionVisible = (id: string) => {
    const s = layout.find((x) => x.id === id);
    return s ? s.isVisible : true;
  };
  const bannersFor = (slot: string) => (sectionVisible(slot) ? settings?.homeBanners?.[slot] ?? [] : []);
  // The hero takes the first banner slot the owner filled, then the second.
  const heroBanners = [...bannersFor('first_banner'), ...bannersFor('second_banner')];
  const homeAds = sectionVisible('ads_panel') ? settings?.homeAds ?? [] : [];

  /**
   * The photographs the bento and the banners borrow come ONLY from the
   * `/api/home` answer, which arrives in one piece — so a tile's picture is
   * chosen once and does not swap when the second request lands.
   */
  const homePool = useMemo(
    () => [...newProducts, ...discountedProducts, ...openBox],
    [newProducts, discountedProducts, openBox]
  );
  const bento = useMemo(() => resolveBento(categories, homePool, openBox), [categories, homePool, openBox]);
  const chips = useMemo(() => latestChips(bento), [bento]);
  const chipPool = useMemo(
    () => [
      ...homePool,
      ...(shelves.best_sellers ?? []),
      ...(shelves.super_deals ?? []),
      ...(shelves.filament ?? []),
    ],
    [homePool, shelves]
  );
  const editorialOwner = sectionVisible(EDITORIAL_SLOT) ? settings?.homeBanners?.[EDITORIAL_SLOT] : undefined;
  const editorial = useMemo(
    () =>
      resolveEditorial({
        ownerBanners: editorialOwner,
        lang,
        pickText,
        siteMedia,
        tree: categories,
        pool: homePool,
        avoid: new Set(bento.map((t) => t.imageProductId).filter((id): id is string => !!id)),
      }),
    [editorialOwner, lang, siteMedia, categories, homePool, bento]
  );
  const showEditorial = sectionVisible(EDITORIAL_SLOT);

  const catalogueEmpty =
    !initialLoading && loadError == null && newProducts.length === 0 && discountedProducts.length === 0;

  return (
    /**
     * `overflow-x: clip` lets a rail run to both screen edges without a
     * horizontal scrollbar — CLIP, not hidden: hidden would make this a
     * scroll container and silently kill `position: sticky` inside the page.
     * `data-home-v2` marks the page for the browser harness
     * (scripts/e2e-home-v2-shots.mjs).
     */
    <div data-home-v2 className="w-full overflow-x-clip bg-black text-zinc-300">
      <Hero banners={heroBanners} loading={initialLoading} />

      {/* The black cap over the hero: the ticker, flush with its top edge and
          running the whole width of the screen — unchanged. */}
      <div className="relative z-30 -mt-7 rounded-t-[28px] bg-black">
        {homeAds.length > 0 ? (
          <div className="rounded-t-[28px] bg-zinc-900/40 overflow-hidden">
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
        ) : (
          <div aria-hidden="true" className="h-4" />
        )}

        {/* The sections below the ticker sit on the page's own ground — ivory
            in the light theme, black in the dark one (src/index.css, THE TWO
            THEMES). Homepage v2 forced ivory here inside an otherwise black
            app; the owner asked for one theme everywhere instead. */}
        <div className="rounded-t-[24px] bg-canvas pb-8 pt-5 text-text-primary lg:rounded-t-[32px] lg:pt-10">
          {/* WIDE SCREENS USE THE WIDTH (owner, 2026-09-26: «في الشاشات الكبيرة
              يظهر هنالك فراغ كبير … اجعل الفراغ قليل جدا»). The column was capped
              at 1200 px, which left 360 px of empty cream on each side of a
              1920 px screen. Now it runs to 1920 px with 16/24/32 px gutters;
              the sections size themselves by proportion (bento rows, 12:5
              banners, more cards per rail), and the few text blocks keep their
              own measure. */}
          <div className="mx-auto flex max-w-[1920px] flex-col gap-8 px-4 sm:px-6 lg:gap-14 lg:px-8">
            {initialLoading ? (
              <div aria-hidden="true" className="flex flex-col gap-8">
                <div className="aspect-[2/1.1] rounded-2xl bg-zinc-800 animate-pulse motion-reduce:animate-none sm:aspect-auto sm:h-[240px] lg:h-[380px] xl:h-[420px] 2xl:h-[480px]" />
                <div className="h-[128px] rounded-2xl bg-zinc-800 animate-pulse motion-reduce:animate-none" />
              </div>
            ) : null}

            {!initialLoading && loadError != null ? (
              <div className="rounded-2xl bg-surface">
                <ErrorState error={loadError} onRetry={fetchHome} />
              </div>
            ) : null}

            {catalogueEmpty ? (
              <div className="rounded-2xl bg-surface">
                <EmptyState
                  icon={<PackageSearch aria-hidden="true" className="w-6 h-6" />}
                  title={loc('لا توجد منتجات بعد', 'No products yet', 'هێشتا هیچ بەرهەمێک نییە')}
                />
              </div>
            ) : null}

            {!initialLoading && sectionVisible('categories') ? <CategoryBento tiles={bento} /> : null}

            {!initialLoading && loadError == null ? <PrinterFinder /> : null}

            {newProducts.length > 0 ? (
              <Suspense fallback={<div aria-hidden="true" className="h-[330px]" />}>
                <LatestProducts latest={newProducts} pool={chipPool} chips={chips} />
              </Suspense>
            ) : null}

            {showEditorial && editorial.length > 0 ? (
              <Suspense fallback={<div aria-hidden="true" className="aspect-[7/6] sm:aspect-[32/9] lg:aspect-[24/5]" />}>
                <EditorialBanners cards={editorial} />
              </Suspense>
            ) : null}

            {!initialLoading ? (
              <Suspense fallback={null}>
                <ServicesGrid />
              </Suspense>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
