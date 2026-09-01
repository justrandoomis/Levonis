import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { ArrowRight, ArrowLeft, Lock, Package } from 'lucide-react';
import { api, formatIqd } from '../lib/api';
import SafeImage from '../components/ui/SafeImage';

/**
 * الباقات — members-only bundles (owner's mandate: «هذه الميزه تظهر لمشتركين
 * فقط البلس والبريميوم والبرو»).
 *
 * The GATE IS THE SERVER'S: /api/bundles answers `entitled: false` with an
 * EMPTY list for a signed-out or free viewer — this page only renders the
 * honest lock state and the subscribe path. Bundle totals arrive computed
 * from the members' live tier-resolved prices, so the number a PRIME member
 * sees here is the same one their cart would charge, product by product.
 */

interface BundleCard {
  id: string;
  slug?: string;
  name: string;
  images?: string[];
  price_iqd?: number;
  display_price_iqd?: number;
  display_regular_iqd?: number;
  display_from?: boolean;
}

interface BundleView {
  id: string;
  name: string;
  description: string;
  image: string;
  items: Array<{ qty: number; product: BundleCard }>;
  total_display_iqd: number;
  total_regular_iqd: number;
  total_from: boolean;
}

interface BundlesResponse {
  entitled: boolean;
  signed_in: boolean;
  bundles: BundleView[];
}

export default function Bundles() {
  const { dir, loc } = useLanguage();
  const navigate = useNavigate();

  const [data, setData] = useState<BundlesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const res = await api.get<BundlesResponse>('/api/bundles');
        if (!cancelled) setData(res);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load bundles');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="w-full pb-24 text-zinc-300 min-h-screen">
      <div className="sticky top-0 z-40 bg-black/80 backdrop-blur-xl border-b border-zinc-800/60 px-4 py-3 flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="p-2 bg-zinc-900 rounded-full hover:bg-zinc-800 transition-colors">
          {dir === 'rtl' ? <ArrowRight className="w-5 h-5" /> : <ArrowLeft className="w-5 h-5" />}
        </button>
        <h1 className="text-white font-bold text-lg">
          {loc('الباقات — للمشتركين', 'Bundles — members only', 'پاکێجەکان — بۆ ئەندامان')}
        </h1>
      </div>

      <div className="p-4">
        {loading ? (
          <div className="text-center py-12 text-zinc-500">
            <div className="w-6 h-6 mx-auto border-2 border-olive border-t-transparent rounded-full animate-spin"></div>
          </div>
        ) : error ? (
          <div className="text-center py-12 text-red-400 bg-zinc-900/50 rounded-xl border border-zinc-800/50">{error}</div>
        ) : !data?.entitled ? (
          <div className="max-w-md mx-auto text-center py-12 px-6 bg-zinc-900/50 rounded-2xl border border-zinc-800/50">
            <span className="mx-auto mb-4 w-12 h-12 rounded-2xl bg-gold/10 border border-gold/30 grid place-items-center">
              <Lock className="w-5 h-5 text-gold" />
            </span>
            <h2 className="text-white font-bold text-base mb-2">
              {loc('ميزة خاصة بالمشتركين', 'A members-only feature', 'تایبەتە بە ئەندامان')}
            </h2>
            <p className="text-[13px] text-zinc-400 mb-5 leading-relaxed">
              {loc(
                'الباقات مجموعات منتجات مختارة تظهر لمشتركي PLUS وPRIME وPRO فقط.',
                'Bundles are curated product groups visible to PLUS, PRIME and PRO members only.',
                'پاکێجەکان کۆمەڵە بەرهەمی هەڵبژێردراون تەنها بۆ ئەندامانی PLUS و PRIME و PRO.'
              )}
            </p>
            {data?.signed_in ? (
              <Link
                to="/subscription"
                className="inline-flex items-center justify-center min-h-11 px-5 rounded-xl bg-gold text-black text-sm font-black hover:brightness-110 transition-all"
              >
                {loc('اشترك الآن', 'Subscribe now', 'ئێستا بەشداری بکە')}
              </Link>
            ) : (
              <Link
                to="/auth?next=/bundles"
                className="inline-flex items-center justify-center min-h-11 px-5 rounded-xl bg-gold text-black text-sm font-black hover:brightness-110 transition-all"
              >
                {loc('سجّل الدخول', 'Sign in', 'چوونەژوورەوە')}
              </Link>
            )}
          </div>
        ) : data.bundles.length === 0 ? (
          <div className="text-center py-12 text-zinc-500 bg-zinc-900/50 rounded-xl border border-zinc-800/50">
            {loc('لا توجد باقات حالياً', 'No bundles right now.', 'ئێستا هیچ پاکێجێک نییە')}
          </div>
        ) : (
          <div className="space-y-4 max-w-3xl mx-auto">
            {data.bundles.map((b) => (
              <div key={b.id} className="bg-zinc-900/50 border border-zinc-800/60 rounded-2xl overflow-hidden">
                {b.image ? (
                  <div className="h-36 sm:h-44 overflow-hidden bg-black">
                    <SafeImage src={b.image} alt={b.name} aspect="auto" className="w-full h-full object-cover" />
                  </div>
                ) : null}
                <div className="p-4">
                  <div className="flex items-start justify-between gap-3 mb-1">
                    <h2 dir="ltr" className="text-white font-bold text-[15px] text-start">{b.name}</h2>
                    <div className="text-end shrink-0">
                      <div className="text-gold font-black text-[15px] tabular-nums">
                        {b.total_from && (
                          <span className="text-[10px] font-medium text-zinc-500 me-1">
                            {loc('يبدأ من', 'from', 'لە')}
                          </span>
                        )}
                        {formatIqd(b.total_display_iqd)}
                      </div>
                      {b.total_display_iqd < b.total_regular_iqd && (
                        <div className="text-zinc-500 text-[11px] line-through tabular-nums">
                          {formatIqd(b.total_regular_iqd)}
                        </div>
                      )}
                    </div>
                  </div>
                  {b.description ? (
                    <p dir="ltr" className="text-[12px] text-zinc-400 mb-3 text-start">{b.description}</p>
                  ) : null}
                  <p className="text-[11px] text-zinc-500 mb-2">
                    {loc('محتويات الباقة', 'Included products', 'ناوەڕۆکی پاکێج')} · {b.items.length}
                  </p>
                  <div className="flex gap-2.5 overflow-x-auto hide-scrollbar pb-1">
                    {b.items.map(({ product: p, qty }) => (
                      <Link
                        key={p.id}
                        to={`/product/${p.slug || p.id}`}
                        className="min-w-[110px] w-[110px] shrink-0 bg-zinc-950/60 border border-zinc-800 rounded-xl p-2 hover:border-zinc-600 transition-colors"
                      >
                        <div className="relative w-full aspect-square rounded-lg overflow-hidden bg-zinc-900 mb-1.5">
                          {p.images?.[0] ? (
                            <SafeImage src={p.images[0]} alt={p.name} aspect="auto" className="w-full h-full" />
                          ) : (
                            <span className="w-full h-full grid place-items-center">
                              <Package className="w-5 h-5 text-zinc-700" />
                            </span>
                          )}
                          {qty > 1 && (
                            <span className="absolute top-1 end-1 bg-zinc-950/90 border border-zinc-700 text-zinc-200 text-[10px] font-bold px-1.5 py-0.5 rounded">
                              ×{qty}
                            </span>
                          )}
                        </div>
                        <span dir="ltr" className="block text-[10px] font-bold text-white line-clamp-2 leading-tight mb-1 text-start">
                          {p.name}
                        </span>
                        <span className="block text-[11px] text-zinc-400 font-bold tabular-nums">
                          {formatIqd(p.display_price_iqd ?? p.price_iqd ?? 0)}
                        </span>
                      </Link>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
