import AnimatedItem from '../components/AnimatedItem';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLanguage } from '../LanguageContext';
import { PackageSearch } from 'lucide-react';
import { api, ApiProduct, PublicSettings, HomeTaxon } from '../lib/api';
import Hero from '../components/home/Hero';
import ServicesGrid from '../components/home/ServicesGrid';
import ProductCard from '../components/home/ProductCard';
import SectionHeader from '../components/home/SectionHeader';
import { ItemStrip, CategoryChips, BrandChips } from '../components/home/Strips';
import Spinner from '../components/ui/Spinner';
import { Skeleton, SkeletonGroup, ProductCardSkeleton } from '../components/ui/Skeleton';
import { ErrorState, EmptyState } from '../components/ui/AsyncStates';

export default function Home() {
  const { t, dir, loc } = useLanguage();

  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [categories, setCategories] = useState<HomeTaxon[]>([]);
  const [brands, setBrands] = useState<HomeTaxon[]>([]);

  const [discountedProducts, setDiscountedProducts] = useState<ApiProduct[]>([]);
  const [newProducts, setNewProducts] = useState<ApiProduct[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);

  const [offset, setOffset] = useState(20);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<unknown>(null);
  const observerTarget = useRef<HTMLDivElement | null>(null);
  // Monotonic request id so a retried /api/home fetch ignores stale responses.
  const homeReqRef = useRef(0);

  const fetchHome = useCallback(async () => {
    const reqId = ++homeReqRef.current;
    setInitialLoading(true);
    setLoadError(null);
    try {
      const data = await api.get<{
        settings: PublicSettings;
        discounted: ApiProduct[];
        latest: ApiProduct[];
        categories?: HomeTaxon[];
        brands?: HomeTaxon[];
      }>('/api/home');
      if (homeReqRef.current !== reqId) return;
      setSettings(data.settings);
      setDiscountedProducts(data.discounted || []);
      setNewProducts(data.latest || []);
      setCategories(data.categories || []);
      setBrands(data.brands || []);
      setHasMore((data.latest || []).length >= 20);
    } catch (err) {
      console.error('Failed to fetch home products', err);
      if (homeReqRef.current !== reqId) return;
      // A failed fetch is an ERROR with retry — never rendered as "no products".
      setLoadError(err);
      setHasMore(false);
    } finally {
      if (homeReqRef.current === reqId) setInitialLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHome();
    return () => {
      homeReqRef.current += 1;
    };
  }, [fetchHome]);

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

  const bannersFor = (slot: string) =>
    sectionVisible(slot) ? settings?.homeBanners?.[slot] ?? [] : [];
  const itemsFor = (slot: string) =>
    sectionVisible(slot) ? settings?.homeSectionItems?.[slot] ?? [] : [];

  // The hero takes the first banner slot the owner filled; the second slot
  // keeps its own place further down the page, where the admin put it.
  const heroBanners = [...bannersFor('first_banner'), ...bannersFor('second_banner')];

  const homeAds = sectionVisible('ads_panel') ? settings?.homeAds ?? [] : [];

  return (
    <div className="w-full pb-24 text-zinc-300 bg-black">
      <Hero banners={heroBanners} loading={initialLoading} />

      <div className="relative z-30 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-8 sm:pt-10 pb-2 bg-black rounded-t-[28px] -mt-7">

        {/* Ads Marquee — gold separators mark where one notice ends and the
            next begins, which a plain gap never did once two ran together. */}
        {homeAds.length > 0 && (
          <div className="mb-8 sm:mb-10 overflow-hidden rounded-xl bg-zinc-900/40 border border-zinc-800">
            <style>{`@keyframes home-ads-marquee { from { transform: translateX(0); } to { transform: translateX(${dir === 'rtl' ? '' : '-'}50%); } }`}</style>
            <div
              className="flex items-center whitespace-nowrap py-2.5 w-max motion-reduce:animate-none"
              style={{ animation: 'home-ads-marquee 25s linear infinite' }}
            >
              {[...homeAds, ...homeAds].map((ad, i) => (
                <span key={`${ad.id}-${i}`} className="flex items-center text-[13px] text-zinc-300 shrink-0">
                  <span className="px-6">{ad.text}</span>
                  <span aria-hidden className="w-1 h-1 rounded-full bg-gold/60 shrink-0" />
                </span>
              ))}
            </div>
          </div>
        )}

        <ServicesGrid />

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
                <CategoryChips key="categories" categories={categories} />
              )
            ) : null,
          },
          {
            id: 'top_brands',
            order: orderOf('top_brands'),
            node: sectionVisible('top_brands') ? (
              itemsFor('top_brands').length > 0 ? (
                <ItemStrip
                  key="top_brands"
                  id="top_brands"
                  title={t('topBrands')}
                  accent="bg-gold"
                  items={itemsFor('top_brands')}
                />
              ) : (
                <BrandChips key="top_brands" brands={brands} />
              )
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
                  <div className="flex gap-3 sm:gap-4 overflow-x-auto overscroll-x-contain hide-scrollbar pb-2 -mx-4 px-4 sm:mx-0 sm:px-0 snap-x">
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
  );
}
