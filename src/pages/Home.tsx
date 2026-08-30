import AnimatedItem from '../components/AnimatedItem';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLanguage } from '../LanguageContext';
import { Star, ChevronRight, ChevronLeft, PackageSearch } from 'lucide-react';
import { useAuth } from '../AuthContext';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiProduct, PublicSettings, HomeTaxon, formatIqd } from '../lib/api';
import Hero from '../components/home/Hero';
import ServicesGrid from '../components/home/ServicesGrid';
import { ItemStrip, CategoryChips, BrandChips } from '../components/home/Strips';
import Spinner from '../components/ui/Spinner';
import SafeImage from '../components/ui/SafeImage';
import { Skeleton, SkeletonGroup, ProductCardSkeleton } from '../components/ui/Skeleton';
import { ErrorState, EmptyState } from '../components/ui/AsyncStates';

export default function Home() {
  const navigate = useNavigate();

  const { t, dir, loc } = useLanguage();
  const { user } = useAuth();

  // Subscription plan comes exclusively from the server-side user record.
  const plan = user?.membership_tier ?? 'free';
  const planActive =
    !!user && plan !== 'free' && (user.subscription_expiry === 0 || user.subscription_expiry > Date.now());

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

  const renderProductCard = (p: ApiProduct, widthClass = 'w-[160px]') => {
    const images = Array.isArray(p.images) ? p.images : [];
    const firstImage = images[0] || '';
    // §3/§12: the product name is English in every language and is never translated.
    const name = p.name;

    const proPrice = p.membership_prices?.pro ?? null;
    const planPrice = planActive && (plan === 'plus' || plan === 'pro') ? p.membership_prices?.[plan] ?? null : null;
    // §4: compare-at is gone. A strikethrough is shown ONLY when the viewer's
    // own membership actually lowers the price — a real, server-resolved
    // comparison instead of a decorative one.
    const displayPrice = p.display_price_iqd ?? p.price_iqd;
    const regularPrice = p.display_regular_iqd ?? p.price_iqd;
    const hasSale = displayPrice < regularPrice;
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
                       <span className="text-zinc-500 text-[10px] line-through">{formatIqd(regularPrice)}</span>
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

      <div className="relative z-30 max-w-7xl mx-auto px-4 sm:px-10 py-10 sm:py-12 bg-black rounded-t-[36px] -mt-8">

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
            id: 'second_banner',
            order: orderOf('second_banner'),
            // The second banner slot only appears down here when the first
            // slot already supplied the hero; otherwise it IS the hero and
            // rendering it twice would show the same picture on one screen.
            node:
              bannersFor('first_banner').length > 0 && bannersFor('second_banner').length > 0 ? (
                <section key="second_banner" data-home-section="second_banner" className="mb-12">
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

        {/* Discounted Products — this IS the admin's `discounts_offers`
            section, whose visibility toggle the page used to ignore. */}
        {discountedProducts.length > 0 && sectionVisible('discounts_offers') && (
          <div data-home-section="discounts_offers" className="mb-12">
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
