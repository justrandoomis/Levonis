import React, { useState, useEffect } from 'react';
import { useLocation, Link, useNavigate } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { ArrowRight, ArrowLeft, Star } from 'lucide-react';
import { api, ApiProduct, formatIqd } from '../lib/api';

export default function Bundles() {
  const { t, lang, dir } = useLanguage();
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryParams = new URLSearchParams(location.search);
  const search = queryParams.get('search') || '';
  const category = queryParams.get('category') || '';

  // Subscription plan comes exclusively from the server-side user record.
  const plan = user?.subscription_plan ?? 'free';
  const planActive =
    !!user && plan !== 'free' && (user.subscription_expiry === 0 || user.subscription_expiry > Date.now());

  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function fetchProducts() {
      setLoading(true);
      setError('');
      try {
        const params = new URLSearchParams();
        params.set('type', 'bundle');
        if (search) params.set('search', search);
        if (category) params.set('category', category);
        params.set('limit', '50');
        const data = await api.get<{ products: ApiProduct[] }>(`/api/products?${params.toString()}`);
        if (!cancelled) setProducts(data.products || []);
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setProducts([]);
          setError(err instanceof Error ? err.message : 'Failed to load bundles');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchProducts();
    return () => {
      cancelled = true;
    };
  }, [search, category]);

  return (
    <div className="w-full pb-24 text-zinc-300 min-h-screen">
      <div className="sticky top-0 z-40 bg-black/80 backdrop-blur-xl border-b border-zinc-800/60 px-4 py-3 flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="p-2 bg-zinc-900 rounded-full hover:bg-zinc-800 transition-colors">
          {dir === 'rtl' ? <ArrowRight className="w-5 h-5" /> : <ArrowLeft className="w-5 h-5" />}
        </button>
        <h1 className="text-white font-bold text-lg">
          {search ? `${t('search')}: ${search}` : category ? `${dir === 'rtl' ? 'الفئة' : 'Category'}: ${category}` : dir === 'rtl' ? 'الباقات والعروض' : 'Bundles & Offers'}
        </h1>
      </div>

      <div className="p-4">
        {loading ? (
          <div className="text-center py-12 text-zinc-500">
            <div className="w-6 h-6 mx-auto border-2 border-olive border-t-transparent rounded-full animate-spin"></div>
          </div>
        ) : error ? (
          <div className="text-center py-12 text-red-400 bg-zinc-900/50 rounded-xl border border-zinc-800/50">
            {error}
          </div>
        ) : products.length === 0 ? (
          <div className="text-center py-12 text-zinc-500 bg-zinc-900/50 rounded-xl border border-zinc-800/50">
            {dir === 'rtl' ? 'لا توجد باقات أو عروض حالياً' : 'No bundles found.'}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
            {products.map(p => {
              const firstImage = (Array.isArray(p.images) ? p.images : [])[0] || '';
              const name = lang === 'ar' && p.name_ar ? p.name_ar : p.name;

              const proPrice = p.membership_prices?.pro ?? null;
              const planPrice =
                planActive && (plan === 'plus' || plan === 'pro') ? p.membership_prices?.[plan] ?? null : null;
              const hasSale = p.original_price_iqd !== null && p.original_price_iqd > p.price_iqd;
              const showPlanPrice = !!planPrice && planPrice > 0 && planPrice < p.price_iqd;

              return (
                <Link to={`/product/${p.slug || p.id}`} key={p.id} className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden flex flex-col group hover:border-olive/50 transition-colors">
                  <div className="relative aspect-square overflow-hidden bg-black">
                    {firstImage ? (
                      <img referrerPolicy="no-referrer" src={firstImage} alt={name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                    ) : (
                      <div className="w-full h-full bg-zinc-900" />
                    )}
                    {hasSale && (
                      <div className="absolute top-2 right-2 bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
                        Sale
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
            })}
          </div>
        )}
      </div>
    </div>
  );
}
