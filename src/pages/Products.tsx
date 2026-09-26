import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { ArrowRight, ArrowLeft, PackageSearch } from 'lucide-react';
import { api, ApiProduct, ResolvedCategory, ProductsListResponse } from '../lib/api';
import Spinner from '../components/ui/Spinner';
import { Skeleton, ProductGridSkeleton } from '../components/ui/Skeleton';
import { ErrorState, EmptyState } from '../components/ui/AsyncStates';
import { readPageCache, writePageCache } from '../lib/pageCache';
import ProductCard from '../components/home/ProductCard';
import { availableFirst, cardAvailability } from '../lib/productCard';
import LiveSearch from '../components/search/LiveSearch';

/** One page of the listing. The route's own ceiling (`limit` max 50). */
const PAGE_SIZE = 50;

export default function Products() {
  const { t, dir, loc } = useLanguage();
  const location = useLocation();
  const navigate = useNavigate();
  const queryParams = new URLSearchParams(location.search);
  const search = queryParams.get('search') || '';
  const category = queryParams.get('category') || '';

  /** What this page needs to paint: the grid and the resolved section name. */
  type ProductsSnapshot = { products: ApiProduct[]; category: ResolvedCategory | null };

  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  /**
   * THREE STATES, NOT TWO — and that is what keeps the id off the screen.
   *
   * The heading used to print the URL parameter: «الفئة: cat_printers_fdm»,
   * which the owner photographed. There is now no branch in which the
   * parameter is rendered, because the parameter was never an answer.
   *
   *   undefined — not told yet (first paint, or a request in flight). The
   *               heading shows a placeholder rather than a guess.
   *   null      — the server looked and there is no such catalog: a deleted
   *               section, or a pre-taxonomy free-text token that still has
   *               real products behind it. The heading shows the plain word.
   *   an object — the name, localized.
   */
  const [categoryRef, setCategoryRef] = useState<ResolvedCategory | null | undefined>(undefined);
  // Monotonic request id: when the query changes mid-flight, the stale
  // response is ignored so a previous query's results never flash in.
  const reqIdRef = useRef(0);
  /**
   * THE REST OF A LONG ANSWER. The grid asked for fifty and stopped there, so a
   * search for a brand with more products than that silently ended at fifty
   * with nothing to say there were more. `exhausted` is "the last page came
   * back short"; until then a «عرض المزيد» asks for the next fifty at the
   * route's `offset`, which keeps the search ranking across pages.
   */
  const [exhausted, setExhausted] = useState(true);
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle');
  /**
   * WHAT IS IN THE SEARCH FIELD ON THIS PAGE. The results page had no field at
   * all — the header only exists on Home — so refining «H» into «H2D» meant
   * going back first. It starts as the query being shown and follows the URL
   * when the shopper searches again from here.
   */
  const [draft, setDraft] = useState(search);
  useEffect(() => setDraft(search), [search]);

  const fetchProducts = useCallback(async () => {
    const reqId = ++reqIdRef.current;
    /**
     * THE SAME QUERY, PAINTED FROM THE LAST ANSWER. «يرجع للوراء خلال ثواني
     * معدودة يضطر إلى تحميل الصفحة من جديد.» The key carries both parameters,
     * so coming back to «طابعات» shows «طابعات» and never the previous
     * section's grid. The request still goes out; the snapshot only decides
     * whether a skeleton is shown while it is in flight. src/lib/pageCache.ts.
     */
    const cacheKey = `products:${search}|${category}`;
    const snapshot = readPageCache<ProductsSnapshot>(cacheKey);
    if (snapshot) {
      setProducts(snapshot.products);
      setCategoryRef(snapshot.category);
    } else {
      // Reset on every query change, so a previous section's name can never sit
      // above a new section's grid.
      setCategoryRef(undefined);
    }
    setLoading(!snapshot);
    setError(null);
    setMore('idle');
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (category) params.set('category', category);
      params.set('limit', String(PAGE_SIZE));
      const data = await api.get<ProductsListResponse>(`/api/products?${params.toString()}`);
      if (reqIdRef.current !== reqId) return;
      const resolved = category ? data.category ?? null : null;
      setProducts(data.products || []);
      setExhausted((data.products || []).length < PAGE_SIZE);
      setCategoryRef(resolved);
      writePageCache(cacheKey, { products: data.products || [], category: resolved });
    } catch (err) {
      console.error(err);
      if (reqIdRef.current !== reqId) return;
      // A snapshot already on screen is a real answer the server gave for this
      // exact query; an error card that replaces it is a worse one.
      if (snapshot) return;
      setError(err);
      // A failed request must not leave the heading pulsing for ever behind
      // the error card.
      setCategoryRef(null);
    } finally {
      if (reqIdRef.current === reqId) setLoading(false);
    }
  }, [search, category]);

  useEffect(() => {
    fetchProducts();
    return () => {
      // Unmount: invalidate any in-flight request.
      reqIdRef.current += 1;
    };
  }, [fetchProducts]);

  const loadMore = async () => {
    const reqId = reqIdRef.current;
    setMore('loading');
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (category) params.set('category', category);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(products.length));
      const data = await api.get<ProductsListResponse>(`/api/products?${params.toString()}`);
      // A new query started while this page was in flight: it is not ours.
      if (reqIdRef.current !== reqId) return;
      const next = data.products || [];
      setProducts((have) => {
        const seen = new Set(have.map((p) => p.id));
        return [...have, ...next.filter((p) => !seen.has(p.id))];
      });
      setExhausted(next.length < PAGE_SIZE);
      setMore('idle');
    } catch (err) {
      console.error(err);
      if (reqIdRef.current === reqId) setMore('error');
    }
  };

  // The word above the heading — «القسم», the same word «تصفّح حسب القسم» uses
  // on the board the customer just tapped. One shop, one word for one thing.
  const kicker = search ? t('search') : category ? loc('القسم', 'Category', 'بەش') : '';
  const heading = search
    ? search
    : category
    ? categoryRef
      ? loc(categoryRef.name_ar, categoryRef.name_en || categoryRef.name_ar, categoryRef.name_ckb)
      : // Resolved, and there is nothing to name. The honest word, never the id.
        loc('القسم', 'Category', 'بەش')
    : // There is no `products` key in translations.ts, so `t('products' as any)`
      // returned undefined and every Arabic and Kurdish shopper read the
      // English word "Products" at the top of the catalogue.
      loc('كل المنتجات', 'All products', 'هەموو بەرهەمەکان');
  const headingPending = !!category && !search && categoryRef === undefined;

  /**
   * «الأولوية بصريًا لمنتجات البيع المباشر والمتوفرة». Outside search (where
   * the server's relevance ranking is the order), what can be bought for
   * direct sale today comes first — a STABLE partition, so each group keeps
   * the shop's own order — and a quiet divider names the second group.
   */
  const ordered = search ? { items: products, splitAt: -1 } : availableFirst(products);
  const laterLabel =
    ordered.splitAt > 0 && ordered.items.slice(ordered.splitAt).every((p) => cardAvailability(p).state === 'preorder')
      ? loc('بطلب مسبق', 'Pre-order')
      : loc('ليست في المخزون الآن', 'Not in stock right now');
  // OWNER: Sorani to be written by hand (the two divider labels above).

  return (
    <div className="w-full pb-24 text-zinc-300 min-h-screen">
      <div className="sticky top-0 z-40 bg-black/80 backdrop-blur-xl border-b border-zinc-800/60 px-4 py-2.5 flex items-center gap-3">
        {/* 44px, because a finger is expected here, and `shrink-0` because the
            heading beside it is the thing that gives way — never the way back. */}
        <button
          onClick={() => navigate(-1)}
          aria-label={loc('رجوع', 'Back', 'گەڕانەوە')}
          className="shrink-0 w-11 h-11 inline-flex items-center justify-center bg-zinc-900 rounded-full hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          {dir === 'rtl' ? <ArrowRight className="w-5 h-5" /> : <ArrowLeft className="w-5 h-5" />}
        </button>
        {search ? (
          <>
            {/* The page still has a heading for a screen reader; the field IS
                the heading visually, holding the words that were searched. */}
            <h1 className="sr-only">{`${loc('نتائج البحث', 'Search results', 'ئەنجامەکانی گەڕان')}: ${search}`}</h1>
            <LiveSearch
              value={draft}
              onChange={setDraft}
              onSubmit={(query) =>
                // REPLACE, so the back button leaves search the way it came
                // rather than stepping through every refinement.
                navigate(`/products?search=${encodeURIComponent(query)}`, { replace: true })
              }
              size="compact"
              tone="bar"
              openOnFocus={false}
              className="min-w-0 flex-1"
            />
          </>
        ) : (
        /* `min-w-0` on the flex CHILD is what makes `truncate` work at all:
            without it the item's automatic minimum size is its content, the row
            overflows instead of truncating, and in RTL it is the back button
            that leaves the screen. */
        <div className="min-w-0 flex-1">
          {kicker && <span className="block text-[11px] font-medium text-zinc-500 leading-tight truncate">{kicker}</span>}
          {headingPending ? (
            // The name is one round trip away. A placeholder is the honest
            // stand-in; printing the id was the bug, and flashing a wrong word
            // would be a smaller version of the same lie. Skeleton honours
            // prefers-reduced-motion by not animating.
            <Skeleton className="h-5 w-40 mt-0.5" />
          ) : (
            <h1 className="text-white font-bold text-lg leading-tight truncate">{heading}</h1>
          )}
        </div>
        )}
      </div>

      <div className="p-4">
        {loading && products.length === 0 ? (
          <ProductGridSkeleton count={8} density="compact" className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4 xl:grid-cols-5" />
        ) : error != null ? (
          <ErrorState error={error} onRetry={fetchProducts} />
        ) : !loading && products.length === 0 ? (
          <EmptyState
            icon={<PackageSearch aria-hidden="true" className="w-6 h-6" />}
            title={loc('لا توجد منتجات', 'No products found', 'هیچ بەرهەمێک نەدۆزرایەوە')}
            description={
              search || category
                ? loc('جرّب كلمة بحث أو فئة أخرى.', 'Try a different search or category.', 'وشەیەکی تر یان هاوپۆلێکی تر تاقی بکەوە.')
                : undefined
            }
          />
        ) : (
          <div className="relative">
            {/* Refetch with data already on screen: keep the content visible,
                dim it, and show a small delayed spinner — no full takeover. */}
            {loading && (
              <div className="absolute inset-x-0 top-8 z-10 flex justify-center pointer-events-none">
                <Spinner size="md" className="bg-black/70 rounded-full p-2" />
              </div>
            )}
          <div
            aria-busy={loading}
            className={`grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4 xl:grid-cols-5 transition-opacity ${loading ? 'opacity-50 pointer-events-none' : ''}`}
          >
            {/* ONE CARD (CATALOG_DISCOVERY §4): the grid renders the shop's
                compact ProductCard — two to a row on a phone — instead of a
                second copy of it. The card links a composition row to where
                it can be bought (§10, /bundles/<slug>) and every
                other row to its product page (src/lib/productCard.ts). */}
            {ordered.items.map((p, i) => (
              <React.Fragment key={p.id}>
                {i === ordered.splitAt && (
                  <div role="separator" className="col-span-full flex items-center gap-3 pb-0.5 pt-2 text-[12px] font-bold text-text-muted">
                    <span className="h-px flex-1 bg-border-subtle" />
                    <span>{laterLabel}</span>
                    <span className="h-px flex-1 bg-border-subtle" />
                  </div>
                )}
                <ProductCard p={p} density="compact" compareToggle eager={i < 4} />
              </React.Fragment>
            ))}
          </div>
          {!exhausted && !loading && (
            <div className="mt-5 flex justify-center">
              <button
                type="button"
                onClick={loadMore}
                disabled={more === 'loading'}
                aria-busy={more === 'loading'}
                className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border-subtle bg-surface px-5 text-[13px] font-semibold text-text-primary transition-colors hover:bg-surface-raised disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                {more === 'loading' && <Spinner size="sm" />}
                {more === 'error' ? t('retry') : loc('عرض المزيد', 'Load more', 'زیاتر پیشان بدە')}
              </button>
            </div>
          )}
          </div>
        )}
      </div>
    </div>
  );
}
