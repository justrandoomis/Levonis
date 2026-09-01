/**
 * The visitor's saved store products — where the storefront hearts land.
 * A card click walks back into the product on the store's own site (its
 * subdomain when it has one, the in-site page otherwise), and the heart
 * here removes the save in place. Same skeleton as FollowedStores.
 */

import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { ApiError } from '../lib/api';
import { communityFavoritesApi, type SavedProduct } from '../lib/merchant';
import { ArrowLeft, ArrowRight, ShoppingBag, Heart } from 'lucide-react';

export default function SavedProducts() {
  const navigate = useNavigate();
  const { dir, loc } = useLanguage();
  const [items, setItems] = useState<SavedProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    communityFavoritesApi
      .list()
      .then((data) => {
        if (!cancelled) setItems(data.items || []);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          navigate('/auth');
          return;
        }
        setLoadError(
          (err instanceof ApiError && err.message) || loc('تعذر التحميل', 'Failed to load', 'بارنەبوو')
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const remove = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (busyId) return;
    setBusyId(id);
    try {
      await communityFavoritesApi.remove(id);
      setItems((prev) => prev.filter((p) => p.product_id !== id));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) navigate('/auth');
    } finally {
      setBusyId(null);
    }
  };

  const openProduct = (p: SavedProduct) => {
    if (p.store_url && /^https?:\/\//.test(p.store_url)) {
      window.location.href = `${p.store_url.replace(/\/$/, '')}/p/${p.slug}`;
    } else {
      navigate(`/community/store/${p.store_slug}/p/${p.slug}`);
    }
  };

  return (
    <div className="w-full min-h-screen bg-black text-white font-sans">
      <div className="sticky top-0 z-40 bg-black/80 backdrop-blur-xl border-b border-zinc-800/60 px-4 py-3 flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="p-2 bg-zinc-900 rounded-full hover:bg-zinc-800 transition-colors">
          {dir === 'rtl' ? <ArrowRight className="w-5 h-5" /> : <ArrowLeft className="w-5 h-5" />}
        </button>
        <h1 className="font-bold text-lg">{loc('منتجات محفوظة', 'Saved products', 'بەرهەمە پاشەکەوتکراوەکان')}</h1>
      </div>

      <div className="p-4 flex flex-col gap-3">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-6 h-6 border-2 border-olive border-t-transparent rounded-full animate-spin"></div>
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center justify-center py-20 text-zinc-500">
            <ShoppingBag className="w-16 h-16 mb-4 opacity-50" />
            <p>{loadError}</p>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-zinc-500 text-center px-6">
            <Heart className="w-16 h-16 mb-4 opacity-50" />
            <p>{loc('لا توجد منتجات محفوظة بعد', 'Nothing saved yet', 'هیچ پاشەکەوت نەکراوە')}</p>
            <p className="text-[12px] text-zinc-600 mt-1.5">
              {loc('اضغط القلب على أي منتج داخل متجر لحفظه هنا.', 'Tap the heart on any store product to keep it here.', 'قڵبەکە دابگرە بۆ پاشەکەوتکردن.')}
            </p>
          </div>
        ) : (
          items.map((p) => (
            <div
              key={p.product_id}
              onClick={() => openProduct(p)}
              className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-3 flex items-center gap-3.5 cursor-pointer hover:bg-zinc-800/50 transition-colors"
            >
              <div className="w-14 h-14 rounded-lg overflow-hidden bg-zinc-800 border border-zinc-700 flex items-center justify-center shrink-0">
                {p.image ? (
                  <img src={p.image} alt={p.name} className="w-full h-full object-cover" />
                ) : (
                  <ShoppingBag className="w-5 h-5 text-zinc-500" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-[13.5px] truncate" dir="auto">
                  {dir === 'rtl' && p.name_ar ? p.name_ar : p.name}
                </h3>
                <div className="text-[12px] text-zinc-400 truncate">{p.store_name}</div>
                <div className="text-[12px] text-zinc-300 mt-0.5" dir="ltr">
                  {Number(p.price_iqd).toLocaleString('en-US')} IQD
                  {!p.in_stock && (
                    <span className="text-zinc-500"> · {loc('غير متوفر', 'Unavailable', 'بەردەست نییە')}</span>
                  )}
                </div>
              </div>
              <button
                onClick={(e) => remove(e, p.product_id)}
                disabled={busyId === p.product_id}
                className="w-9 h-9 rounded-full border border-zinc-700 flex items-center justify-center shrink-0 disabled:opacity-50"
                aria-label={loc('إزالة من المحفوظات', 'Remove from saved', 'لابردن')}
              >
                <Heart className="w-4 h-4 text-rose-500 fill-rose-500" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
