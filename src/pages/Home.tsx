import AnimatedItem from '../components/AnimatedItem';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLanguage } from '../LanguageContext';
import { Star, ChevronRight, ChevronLeft, Pause, Play, PackageSearch, Layers } from 'lucide-react';
import { STUDIO_URL } from '../translations';
import { useAuth } from '../AuthContext';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiProduct, PublicSettings, formatIqd } from '../lib/api';
import Spinner from '../components/ui/Spinner';
import SafeImage from '../components/ui/SafeImage';
import { Skeleton, SkeletonGroup, ProductCardSkeleton } from '../components/ui/Skeleton';
import { ErrorState, EmptyState } from '../components/ui/AsyncStates';

export default function Home() {
  const navigate = useNavigate();

  const { t, dir, lang, loc } = useLanguage();
  const { user } = useAuth();

  // Subscription plan comes exclusively from the server-side user record.
  const plan = user?.subscription_plan ?? 'free';
  const planActive =
    !!user && plan !== 'free' && (user.subscription_expiry === 0 || user.subscription_expiry > Date.now());

  const [activeIndex, setActiveIndex] = useState(0);
  const [settings, setSettings] = useState<PublicSettings | null>(null);

  const [isAutoPlaying, setIsAutoPlaying] = useState(true);
  const touchStartX = useRef(0);
  const touchEndX = useRef(0);

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
      const data = await api.get<{ settings: PublicSettings; discounted: ApiProduct[]; latest: ApiProduct[] }>(
        '/api/home'
      );
      if (homeReqRef.current !== reqId) return;
      setSettings(data.settings);
      setDiscountedProducts(data.discounted || []);
      setNewProducts(data.latest || []);
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

  const renderProductCard = (p: ApiProduct, widthClass = 'w-[160px]') => {
    const images = Array.isArray(p.images) ? p.images : [];
    const firstImage = images[0] || '';
    const name = lang === 'ar' && p.name_ar ? p.name_ar : p.name;

    const proPrice = p.membership_prices?.pro ?? null;
    const planPrice = planActive && (plan === 'plus' || plan === 'pro') ? p.membership_prices?.[plan] ?? null : null;
    const hasSale = p.original_price_iqd !== null && p.original_price_iqd > p.price_iqd;
    const showPlanPrice = !!planPrice && planPrice > 0 && planPrice < p.price_iqd;

    return (
      <Link to={`/product/${p.slug || p.id}`} key={p.id} className={`${widthClass} shrink-0 bg-zinc-900/50/50 rounded-xl overflow-hidden flex flex-col group hover:border-olive/50 transition-colors`}>
        <div className="relative aspect-square overflow-hidden bg-black">
          <SafeImage
            src={firstImage}
            alt={name}
            aspect="auto"
            className="w-full h-full group-hover:scale-105 transition-transform duration-500"
          />
          {hasSale && (
            <div className="absolute top-2 right-2 bg-rose-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
              SALE
            </div>
          )}
        </div>
        <div className="p-3 flex flex-col flex-1">
          <h3 className="text-white font-medium text-sm line-clamp-2 mb-1">{name}</h3>
          <div className="mt-auto pt-2 flex items-center justify-between">
            <div className="flex flex-col gap-0.5">
              {showPlanPrice ? (
                <>
                   <div className="flex flex-col">
                      <span className="text-zinc-500 text-[10px] line-through">{formatIqd(p.price_iqd)}</span>
                      <span className="text-gold font-extrabold text-[15px] flex items-center gap-1 drop-shadow-[0_0_8px_rgba(186,163,105,0.4)]">
                         <Star className="w-3.5 h-3.5 fill-gold" />
                         {formatIqd(planPrice!)}
                      </span>
                   </div>
                </>
              ) : (
                <>
                   <div className="flex flex-col">
                     {hasSale && (
                       <span className="text-zinc-500 text-[10px] line-through">{formatIqd(p.original_price_iqd!)}</span>
                     )}
                     <span className="text-white font-bold text-sm">{formatIqd(p.price_iqd)}</span>
                   </div>
                   {proPrice ? (
                     <div className="flex items-center gap-1 mt-0.5">
                        <Star className="w-2.5 h-2.5 text-zinc-500" />
                        <span className="text-zinc-500 font-medium text-[10px]">
                          {formatIqd(proPrice)} (للمشتركين)
                        </span>
                     </div>
                   ) : null}
                </>
              )}
            </div>
          </div>
        </div>
      </Link>
    );
  };

  // Section visibility from the admin-configured home layout.
  const sectionVisible = (id: string) => {
    const s = settings?.homeSections?.find((x) => x.id === id);
    return s ? s.isVisible : true;
  };

  const displayBanners = [
    ...(sectionVisible('first_banner') ? settings?.homeBanners?.['first_banner'] ?? [] : []),
    ...(sectionVisible('second_banner') ? settings?.homeBanners?.['second_banner'] ?? [] : []),
  ].filter((b) => b && b.image);

  const homeAds = sectionVisible('ads_panel') ? settings?.homeAds ?? [] : [];

  const bannerCount = displayBanners.length;

  // Keep the index valid when banners load or change.
  useEffect(() => {
    if (bannerCount === 0) {
      setActiveIndex(0);
    } else {
      setActiveIndex((i) => (i >= bannerCount ? 0 : i));
    }
  }, [bannerCount]);

  const nextSlide = useCallback(() => {
    if (bannerCount === 0) return;
    setActiveIndex((i) => (i + 1) % bannerCount);
  }, [bannerCount]);

  const prevSlide = useCallback(() => {
    if (bannerCount === 0) return;
    setActiveIndex((i) => (i - 1 + bannerCount) % bannerCount);
  }, [bannerCount]);

  useEffect(() => {
    if (!isAutoPlaying || bannerCount < 2) return;
    const interval = setInterval(nextSlide, 4000);
    return () => clearInterval(interval);
  }, [isAutoPlaying, nextSlide, bannerCount]);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.targetTouches[0].clientX;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    touchEndX.current = e.targetTouches[0].clientX;
  };

  const handleTouchEnd = () => {
    if (!touchStartX.current || !touchEndX.current) return;
    const distance = touchStartX.current - touchEndX.current;
    const isLeftSwipe = distance > 50;
    const isRightSwipe = distance < -50;

    if (isLeftSwipe) {
      dir === 'rtl' ? prevSlide() : nextSlide();
    } else if (isRightSwipe) {
      dir === 'rtl' ? nextSlide() : prevSlide();
    }

    touchStartX.current = 0;
    touchEndX.current = 0;
  };

  const renderBannerMedia = (banner: { id: string; image: string; link: string }) => {
    // Banners live in a translated carousel row — lazy loading would leave
    // blank slides mid-swipe, so they load eagerly with an explicit fallback.
    const img = (
      <SafeImage
        src={banner.image}
        alt=""
        aspect="auto"
        eager
        className="w-full h-full"
      />
    );
    if (banner.link && banner.link.startsWith('/')) {
      return (
        <Link to={banner.link} className="block w-full h-full">
          {img}
        </Link>
      );
    }
    if (banner.link) {
      return (
        <a href={banner.link} target="_blank" rel="noopener noreferrer" className="block w-full h-full">
          {img}
        </a>
      );
    }
    return img;
  };

  return (
    <div className="w-full pb-24 text-zinc-300 bg-black">
      {/* Reserve the banner area while /api/home loads so the page doesn't
          jump when the configured banners arrive. */}
      {initialLoading && bannerCount === 0 && (
        <div
          aria-hidden="true"
          className="w-full h-[320px] md:h-[420px] bg-zinc-900/80 animate-pulse motion-reduce:animate-none"
        />
      )}
      {/* Banner Carousel (hidden when no banners are configured) */}
      {bannerCount > 0 && (
        <div
          className="relative w-full h-[320px] md:h-[420px] overflow-hidden -mt-0"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          <div
            className="flex transition-transform duration-500 ease-out h-full"
            style={{ transform: `translateX(${dir === 'rtl' ? (activeIndex * 100) : -(activeIndex * 100)}%)` }}
          >
            {displayBanners.map((banner) => (
              <div key={banner.id} className="w-full h-full flex-shrink-0 bg-zinc-900 relative">
                {renderBannerMedia(banner)}
              </div>
            ))}
          </div>

          {/* Controls overlay */}
          <div className="absolute bottom-[40px] left-0 right-0 flex items-center justify-between px-6 z-20">
            <div className="flex-1"></div>

            {/* Pagination Dots */}
            <div className="flex items-center gap-1.5 bg-white px-3 py-1.5 rounded-full shadow-md">
              {displayBanners.map((_, idx) => (
                <button
                  key={idx}
                  onClick={() => setActiveIndex(idx)}
                  className={`rounded-full transition-all ${activeIndex === idx ? 'w-5 h-1.5 bg-zinc-800' : 'w-1.5 h-1.5 bg-zinc-300 hover:bg-zinc-400'}`}
                />
              ))}
            </div>

            {/* Play/Pause */}
            <div className="flex-1 flex justify-end">
              <button
                onClick={() => setIsAutoPlaying(!isAutoPlaying)}
                className="w-9 h-9 rounded-full bg-white text-black flex items-center justify-center hover:bg-zinc-200 transition-colors shadow-lg"
              >
                {isAutoPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current ml-0.5" />}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className={`relative z-30 max-w-7xl mx-auto px-4 sm:px-10 py-12 bg-black ${bannerCount > 0 || initialLoading ? 'rounded-t-[36px] -mt-10' : ''}`}>

        {/* Ads Marquee */}
        {homeAds.length > 0 && (
          <div className="mb-10 overflow-hidden rounded-xl bg-zinc-900/50 border border-zinc-800/50">
            <style>{`@keyframes home-ads-marquee { from { transform: translateX(0); } to { transform: translateX(${dir === 'rtl' ? '' : '-'}50%); } }`}</style>
            <div
              className="flex whitespace-nowrap py-2.5 w-max"
              style={{ animation: 'home-ads-marquee 25s linear infinite' }}
            >
              {[...homeAds, ...homeAds].map((ad, i) => (
                <span key={`${ad.id}-${i}`} className="text-sm text-zinc-300 px-8 shrink-0">
                  {ad.text}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Services — LEVO Studio entry. A PLAIN full-page navigation to the
            standalone subdomain (STUDIO_URL): no iframe, no embedding, no
            prefetch/preload of any Studio asset, and no slicer code in this
            bundle (docs/STUDIO_PLAN.md decision 6 — pinned by
            tests/store-isolation.test.ts). Opening in a new tab stays the
            user's own choice. */}
        <div className="mb-12">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-1 h-6 bg-olive rounded-full"></div>
            <h2 className="text-xl md:text-2xl font-bold text-white">{t('services')}</h2>
          </div>
          <a
            href={STUDIO_URL}
            className="group flex items-center gap-4 rounded-2xl bg-gradient-to-r from-olive/15 to-zinc-900/60 border border-olive/30 p-4 sm:p-5 hover:border-olive/60 transition-colors"
          >
            <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl bg-olive/15 border border-olive/30 flex items-center justify-center shrink-0">
              <Layers aria-hidden="true" className="w-6 h-6 sm:w-7 sm:h-7 text-olive" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="text-white font-bold text-sm sm:text-base mb-0.5">{t('studioCardTitle')}</h3>
              <p className="text-xs sm:text-sm text-zinc-400 line-clamp-2">{t('studioCardSubtitle')}</p>
            </div>
            <span className="shrink-0 flex items-center gap-1 text-olive text-xs sm:text-sm font-bold">
              <span className="hidden sm:inline">{t('studioOpen')}</span>
              {dir === 'rtl' ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </span>
          </a>
        </div>

        {/* Skeletons mirror the real sections (horizontal row + grid) —
            reserved dimensions, no fake names or prices. */}
        {initialLoading && (
          <SkeletonGroup>
            <div className="mb-12" aria-hidden="true">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-1 h-6 bg-zinc-800 rounded-full"></div>
                <Skeleton className="h-7 w-44" />
              </div>
              <div className="flex gap-4 overflow-hidden pb-4">
                {Array.from({ length: 4 }, (_, i) => (
                  <ProductCardSkeleton key={i} className="w-[180px] md:w-[200px] shrink-0" />
                ))}
              </div>
            </div>
            <div className="mb-12" aria-hidden="true">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-1 h-6 bg-zinc-800 rounded-full"></div>
                <Skeleton className="h-7 w-52" />
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
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

        {/* Discounted Products - Horizontal Scroll */}
        {discountedProducts.length > 0 && (
          <div className="mb-12">
            <div className="flex items-center justify-between gap-3 mb-6">
              <div className="flex items-center gap-3">
                <div className="w-1 h-6 bg-rose-500 rounded-full"></div>
                <h2 className="text-xl md:text-2xl font-bold text-white">
                  Discounted Products
                </h2>
              </div>
              <button onClick={() => navigate('/products')} className="text-zinc-400 hover:text-white transition-colors flex items-center gap-1 text-sm bg-zinc-900/80 px-3 py-1.5 rounded-full">
                <span>more</span>
                {dir === 'rtl' ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </button>
            </div>

            <div className="flex gap-4 overflow-x-auto hide-scrollbar pb-4 -mx-4 px-4 sm:mx-0 sm:px-0 snap-x">
              {discountedProducts.map((p, index) => (
                <AnimatedItem key={p.id} index={index} className="snap-start shrink-0">
                  {renderProductCard(p, "w-[180px] md:w-[200px]")}
                </AnimatedItem>
              ))}
            </div>
          </div>
        )}

        {/* Try Something New - Vertical Infinite Grid */}
        {newProducts.length > 0 && (
          <div className="mb-12">
            <div className="flex items-center justify-between gap-3 mb-6">
              <div className="flex items-center gap-3">
                <div className="w-1 h-6 bg-olive rounded-full"></div>
                <h2 className="text-xl md:text-2xl font-bold text-white">
                  Try something new
                </h2>
              </div>
              <button onClick={() => navigate('/products')} className="w-8 h-8 rounded-full bg-zinc-900 flex items-center justify-center hover:bg-zinc-800 transition-colors">
                {dir === 'rtl' ? <ChevronLeft className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
              </button>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
              {newProducts.map((p, index) => (<AnimatedItem key={p.id} index={index}>{renderProductCard(p, "w-full")}</AnimatedItem>))}
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
