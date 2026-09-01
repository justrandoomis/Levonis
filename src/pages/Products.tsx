import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation, Link, useNavigate } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { ArrowRight, ArrowLeft, PackageSearch } from 'lucide-react';
import { api, ApiProduct } from '../lib/api';
import Spinner from '../components/ui/Spinner';
import SafeImage from '../components/ui/SafeImage';
import { ProductGridSkeleton } from '../components/ui/Skeleton';
import { ErrorState, EmptyState } from '../components/ui/AsyncStates';
import CardPrice from '../components/CardPrice';

export default function Products() {
  const { t, dir, loc } = useLanguage();
  const location = useLocation();
  const navigate = useNavigate();
  const queryParams = new URLSearchParams(location.search);
  const search = queryParams.get('search') || '';
  const category = queryParams.get('category') || '';

  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  // Monotonic request id: when the query changes mid-flight, the stale
  // response is ignored so a previous query's results never flash in.
  const reqIdRef = useRef(0);

  const fetchProducts = useCallback(async () => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (category) params.set('category', category);
      params.set('limit', '50');
      const data = await api.get<{ products: ApiProduct[] }>(`/api/products?${params.toString()}`);
      if (reqIdRef.current !== reqId) return;
      setProducts(data.products || []);
    } catch (err) {
      console.error(err);
      if (reqIdRef.current !== reqId) return;
      setError(err);
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

  return (
    <div className="w-full pb-24 text-zinc-300 min-h-screen">
      <div className="sticky top-0 z-40 bg-black/80 backdrop-blur-xl border-b border-zinc-800/60 px-4 py-3 flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="p-2 bg-zinc-900 rounded-full hover:bg-zinc-800 transition-colors">
          {dir === 'rtl' ? <ArrowRight className="w-5 h-5" /> : <ArrowLeft className="w-5 h-5" />}
        </button>
        <h1 className="text-white font-bold text-lg">
          {search ? `${t('search')}: ${search}` : category ? `${dir === 'rtl' ? 'الفئة' : 'Category'}: ${category}` : t('products' as any) || 'Products'}
        </h1>
      </div>

      <div className="p-4">
        {loading && products.length === 0 ? (
          <ProductGridSkeleton count={8} />
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
            className={`grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4 transition-opacity ${loading ? 'opacity-50 pointer-events-none' : ''}`}
          >
            {products.map(p => {
              const firstImage = (Array.isArray(p.images) ? p.images : [])[0] || '';
              // §3/§12: the product name is English in every language and is never translated.
              const name = p.name;
              // §4: compare-at is gone; the SALE badge appears only when the
              // server's tier-resolved display price genuinely undercuts the
              // regular one. Price rendering itself is CardPrice — one block
              // shared with the home rails and the bundles grid.
              const displayPrice = p.display_price_iqd ?? p.price_iqd;
              const regularPrice = p.display_regular_iqd ?? p.price_iqd;
              const hasSale = displayPrice < regularPrice;

              return (
                <Link to={`/product/${p.slug || p.id}`} key={p.id} className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden flex flex-col group hover:border-olive/50 transition-colors">
                  <div className="relative aspect-square overflow-hidden bg-black">
                    <SafeImage
                      src={firstImage}
                      alt={name}
                      aspect="auto"
                      className="w-full h-full group-hover:scale-105 transition-transform duration-500"
                    />
                    {hasSale && (
                      <div className="absolute top-2 right-2 bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
                        Sale
                      </div>
                    )}
                  </div>
                  <div className="p-3 flex flex-col flex-1">
                    <h3 className="text-white font-medium text-sm line-clamp-2 mb-1">{name}</h3>
                    <div className="mt-auto pt-2">
                      <CardPrice p={p} />
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
          </div>
        )}
      </div>
    </div>
  );
}
