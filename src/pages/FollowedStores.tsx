import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { api, ApiError } from '../lib/api';
import { storeHref } from '../lib/merchant';
import ProMerchantBadge from '../components/merchant/ProMerchantBadge';
import { ArrowLeft, ArrowRight, Store, BadgeCheck } from 'lucide-react';

interface FollowedMerchant {
  id: string;
  name: string;
  bio: string;
  avatarUrl: string | null;
  verified: boolean;
  pro_badge?: boolean;
  created_at: string;
  store_slug?: string | null;
  /** The shop's own address — a card click is a full navigation there. */
  store_url?: string | null;
  /**
   * Levonis has sanctioned this shop (review S5): the server sends its id and
   * nothing the merchant wrote, and the card says only that it is unavailable
   * — the customer can still unfollow it.
   */
  unavailable?: boolean;
}

export default function FollowedStores() {
  const navigate = useNavigate();
  const { dir, loc } = useLanguage();
  const [stores, setStores] = useState<FollowedMerchant[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ merchants: FollowedMerchant[] }>('/api/community/followed')
      .then((data) => {
        if (!cancelled) setStores(data.merchants || []);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          navigate('/auth');
          return;
        }
        setLoadError(
          (err instanceof ApiError && err.message) || (dir === 'rtl' ? 'تعذر التحميل' : 'Failed to load')
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const unfollow = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (busyId) return;
    setBusyId(id);
    try {
      await api.delete(`/api/community/store/${id}/follow`);
      setStores((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        navigate('/auth');
      } else {
        console.error(err);
      }
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="w-full min-h-screen bg-black text-white font-sans">
      <div className="sticky top-0 z-40 bg-black/80 backdrop-blur-xl border-b border-zinc-800/60 px-4 py-3 flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="p-2 bg-zinc-900 rounded-full hover:bg-zinc-800 transition-colors">
          {dir === 'rtl' ? <ArrowRight className="w-5 h-5" /> : <ArrowLeft className="w-5 h-5" />}
        </button>
        <h1 className="font-bold text-lg">{dir === 'rtl' ? 'متاجري' : 'My Stores'}</h1>
      </div>

      <div className="p-4 flex flex-col gap-3">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-6 h-6 border-2 border-olive border-t-transparent rounded-full animate-spin"></div>
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center justify-center py-20 text-zinc-500">
            <Store className="w-16 h-16 mb-4 opacity-50" />
            <p>{loadError}</p>
          </div>
        ) : stores.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-zinc-500">
            <Store className="w-16 h-16 mb-4 opacity-50" />
            <p>{dir === 'rtl' ? 'لا توجد متاجر تمت متابعتها' : 'No followed stores yet'}</p>
          </div>
        ) : (
          stores.map((store) =>
            store.unavailable ? (
              // A sanctioned shop: nothing of it is shown and there is nowhere
              // to go — only the way to stop following it.
              <div
                key={store.id}
                data-store-unavailable-card
                className="bg-zinc-900/30 border border-zinc-800/40 rounded-xl p-4 flex items-center gap-4"
              >
                <div className="w-12 h-12 rounded-full bg-zinc-800/60 border border-zinc-700/60 flex items-center justify-center shrink-0">
                  <Store className="w-5 h-5 text-zinc-600" aria-hidden="true" />
                </div>
                <div className="flex-1 min-w-0">
                  {/* OWNER: Sorani to be written by hand. */}
                  <h3 className="font-bold truncate text-zinc-400">{loc('متجر غير متاح', 'Store unavailable')}</h3>
                  <div className="text-sm text-zinc-500 truncate">
                    {loc('هذا المتجر غير متاح حاليًا.', 'This store is not available right now.')}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={(e) => unfollow(e, store.id)}
                  disabled={busyId === store.id}
                  className="border border-zinc-700 text-zinc-300 hover:text-white hover:bg-zinc-800 rounded-full px-4 min-h-[44px] text-sm font-medium transition-colors disabled:opacity-50 shrink-0"
                >
                  {/* OWNER: Sorani to be written by hand. */}
                  {busyId === store.id ? '...' : loc('إلغاء المتابعة', 'Unfollow')}
                </button>
              </div>
            ) : (
            <div
              key={store.id}
              onClick={() => {
                // The shop's own subdomain opens in its own tab; the in-site
                // page otherwise. The shared cookie keeps the session either way.
                const href = storeHref(store.store_url, store.id);
                if (href.startsWith('http')) window.open(href, '_blank', 'noopener,noreferrer');
                else navigate(href);
              }}
              className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4 flex items-center gap-4 cursor-pointer hover:bg-zinc-800/50 transition-colors"
            >
              <div className="w-12 h-12 rounded-full overflow-hidden bg-zinc-800 border border-zinc-700 flex items-center justify-center shrink-0">
                {store.avatarUrl ? (
                  <img referrerPolicy="no-referrer" src={store.avatarUrl} alt={store.name} className="w-full h-full object-cover" />
                ) : (
                  <Store className="w-5 h-5 text-zinc-500" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <h3 className="font-bold truncate">{store.name}</h3>
                  {store.verified && <BadgeCheck className="w-4 h-4 text-gold shrink-0" />}
                  {store.pro_badge && <ProMerchantBadge compact />}
                </div>
                {store.bio && <div className="text-sm text-zinc-400 truncate">{store.bio}</div>}
              </div>
              <button
                onClick={(e) => unfollow(e, store.id)}
                disabled={busyId === store.id}
                className="border border-zinc-700 text-zinc-300 hover:text-white hover:bg-zinc-800 rounded-full px-4 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 shrink-0"
              >
                {busyId === store.id
                  ? (dir === 'rtl' ? '...' : '...')
                  : (dir === 'rtl' ? 'إلغاء المتابعة' : 'Unfollow')}
              </button>
            </div>
            )
          )
        )}
      </div>
    </div>
  );
}
