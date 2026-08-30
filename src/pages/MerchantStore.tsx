import React, { useState, useEffect } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { api, ApiError, formatIqd } from '../lib/api';
import {
  ArrowLeft, ArrowRight, Star, Store as StoreIcon, BadgeCheck, Box
} from 'lucide-react';

interface StoreMerchant {
  id: string;
  /** The account behind the store — the only thing /api/chats/open accepts. */
  user_id: string;
  name: string;
  bio: string;
  avatarUrl: string | null;
  verified: boolean;
  created_at: string;
}

interface StoreProduct {
  id: string;
  slug: string;
  name: string;
  name_ar: string;
  images: string[];
  price_iqd: number;
  original_price_iqd: number | null;
  created_at: string;
}

export default function MerchantStore() {
  const navigate = useNavigate();
  const { id } = useParams();
  const { dir, lang } = useLanguage();
  const [activeTab, setActiveTab] = useState('products');
  const [merchant, setMerchant] = useState<StoreMerchant | null>(null);
  const [products, setProducts] = useState<StoreProduct[]>([]);
  const [followers, setFollowers] = useState(0);
  const [isFollowing, setIsFollowing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [followBusy, setFollowBusy] = useState(false);
  const [messageBusy, setMessageBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    api
      .get<{ merchant: StoreMerchant; products: StoreProduct[]; followers: number; following: boolean }>(
        `/api/community/store/${id}`
      )
      .then((data) => {
        if (cancelled) return;
        setMerchant(data.merchant);
        setProducts(data.products || []);
        setFollowers(data.followers || 0);
        setIsFollowing(!!data.following);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(
          err instanceof ApiError && err.status === 404
            ? (dir === 'rtl' ? 'المتجر غير موجود' : 'Store not found')
            : (err instanceof ApiError && err.message) || (dir === 'rtl' ? 'تعذر تحميل المتجر' : 'Failed to load store')
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  /**
   * Opens (or re-opens) the direct conversation with this merchant.
   *
   * The endpoint is idempotent for a pair — it returns the existing GENERAL
   * thread rather than creating a second one, and it will not hand back an
   * order thread as if it were a direct message — so tapping twice cannot
   * fork the conversation.
   */
  const openChat = async () => {
    if (messageBusy || !merchant?.user_id) return;
    setMessageBusy(true);
    try {
      const { chatId } = await api.post<{ chatId: string }>('/api/chats/open', { userId: merchant.user_id });
      navigate(`/chat/${chatId}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        navigate(`/auth?next=${encodeURIComponent(`/community/store/${merchant.id}`)}`);
        return;
      }
      console.error(err);
    } finally {
      setMessageBusy(false);
    }
  };

  const toggleFollow = async () => {
    if (followBusy || !merchant) return;
    setFollowBusy(true);
    try {
      if (isFollowing) {
        await api.delete(`/api/community/store/${merchant.id}/follow`);
        setIsFollowing(false);
        setFollowers((n) => Math.max(0, n - 1));
      } else {
        await api.post(`/api/community/store/${merchant.id}/follow`);
        setIsFollowing(true);
        setFollowers((n) => n + 1);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        navigate('/auth');
      } else {
        console.error(err);
      }
    } finally {
      setFollowBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-olive border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  if (loadError || !merchant) {
    return (
      <div className="min-h-screen bg-black text-white flex flex-col items-center justify-center gap-4 p-8">
        <StoreIcon className="w-14 h-14 text-zinc-700" />
        <p className="text-zinc-400 text-center">{loadError || (dir === 'rtl' ? 'المتجر غير موجود' : 'Store not found')}</p>
        <button onClick={() => navigate(-1)} className="border border-zinc-700 bg-zinc-900 text-white rounded-full px-6 py-2.5 font-bold hover:bg-zinc-800 transition-colors">
          {dir === 'rtl' ? 'رجوع' : 'Go Back'}
        </button>
      </div>
    );
  }

  const joined = merchant.created_at
    ? new Date(merchant.created_at).toLocaleDateString(lang === 'ar' ? 'ar' : 'en-US', { year: 'numeric', month: 'long' })
    : null;

  return (
    <div className="w-full min-h-screen bg-black text-white font-sans">
      {/* Header */}
      <div className="fixed top-0 left-0 right-0 z-50 bg-black/90 backdrop-blur-md px-4 py-3 flex items-center justify-between">
        <button onClick={() => navigate(-1)} className="p-2 bg-zinc-900 rounded-full hover:bg-zinc-800 transition-colors">
          {dir === 'rtl' ? <ArrowRight className="w-5 h-5 text-white" /> : <ArrowLeft className="w-5 h-5 text-white" />}
        </button>
      </div>

      <div className="px-5 pt-[76px] pb-32">
        {/* Profile Info */}
        <div className="flex items-center gap-4 mb-4">
          <div className="w-20 h-20 rounded-full overflow-hidden bg-zinc-900 border border-zinc-800 flex items-center justify-center shrink-0">
            {merchant.avatarUrl ? (
              <img referrerPolicy="no-referrer" src={merchant.avatarUrl} alt={merchant.name} className="w-full h-full object-cover" />
            ) : (
              <StoreIcon className="w-8 h-8 text-zinc-600" />
            )}
          </div>
          <div className="relative z-0">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold">{merchant.name}</h1>
              {merchant.verified && <BadgeCheck className="w-5 h-5 text-gold" />}
            </div>
            {joined && (
              <p className="text-zinc-400 text-sm">{dir === 'rtl' ? 'انضم في' : 'Joined'} {joined}</p>
            )}
          </div>
        </div>

        {merchant.bio && <h2 className="text-lg font-medium mb-3 text-white">{merchant.bio}</h2>}

        <div className="flex items-center gap-1 text-sm font-medium mb-6 text-zinc-300">
          <span>{followers} {dir === 'rtl' ? 'متابعين' : 'followers'}</span>
          <span className="text-zinc-600 mx-1">·</span>
          <span>{products.length} {dir === 'rtl' ? 'منتجات' : 'products'}</span>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2 mb-8">
          <button
            onClick={toggleFollow}
            disabled={followBusy}
            className={`flex-1 rounded-full py-3 font-bold transition-colors disabled:opacity-60 ${isFollowing ? 'border border-zinc-700 bg-black text-white hover:bg-zinc-900' : 'bg-white text-black hover:bg-zinc-200'}`}
          >
            {isFollowing ? (dir === 'rtl' ? 'تمت المتابعة' : 'Following') : (dir === 'rtl' ? 'متابعة' : 'Follow')}
          </button>
          {/* Was disabled with "قريباً" on it. Direct chats have existed
              since the first migration; nothing was wired to open one. */}
          <button
            type="button"
            onClick={() => void openChat()}
            disabled={messageBusy || !merchant.user_id}
            className="flex-1 border border-zinc-700 bg-zinc-900 text-white rounded-full py-3 font-bold hover:bg-zinc-800 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {messageBusy ? (dir === 'rtl' ? 'جارٍ الفتح…' : 'Opening…') : dir === 'rtl' ? 'مراسلة' : 'Message'}
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-zinc-800 mb-6 overflow-x-auto hide-scrollbar sticky top-[60px] z-40 bg-black pt-2">
          <button
            onClick={() => setActiveTab('products')}
            className={`flex-none px-4 pb-3 text-center font-bold text-sm border-b-2 transition-colors flex items-center justify-center gap-2 ${activeTab === 'products' ? 'border-white text-white' : 'border-transparent text-zinc-500 hover:text-zinc-400'}`}
          >
            {dir === 'rtl' ? 'المنتجات' : 'Products'} <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${activeTab === 'products' ? 'bg-zinc-800 text-white' : 'bg-zinc-900 text-zinc-400'}`}>{products.length}</span>
          </button>
          <button
            onClick={() => setActiveTab('reviews')}
            className={`flex-none px-4 pb-3 text-center font-bold text-sm border-b-2 transition-colors ${activeTab === 'reviews' ? 'border-white text-white' : 'border-transparent text-zinc-500 hover:text-zinc-400'}`}
          >
            {dir === 'rtl' ? 'التقييمات' : 'Reviews'}
          </button>
          <button
            onClick={() => setActiveTab('about')}
            className={`flex-none px-4 pb-3 text-center font-bold text-sm border-b-2 transition-colors ${activeTab === 'about' ? 'border-white text-white' : 'border-transparent text-zinc-500 hover:text-zinc-400'}`}
          >
            {dir === 'rtl' ? 'حول' : 'About'}
          </button>
        </div>

        {/* Tab Content */}
        <div className="relative z-0">
          {activeTab === 'products' && (
            products.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-zinc-500">
                <Box className="w-12 h-12 mb-3 opacity-40" />
                <p className="text-sm">{dir === 'rtl' ? 'لا توجد منتجات بعد' : 'No products yet'}</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {products.map((p) => {
                  const firstImage = (p.images && p.images[0]) || null;
                  const name = lang === 'ar' && p.name_ar ? p.name_ar : p.name;
                  return (
                    <Link to={`/product/${p.slug}`} key={p.id} className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden flex flex-col group hover:border-olive/50 transition-colors">
                      <div className="relative aspect-square overflow-hidden bg-black">
                        {firstImage ? (
                          <img referrerPolicy="no-referrer" src={firstImage} alt={name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-zinc-700">
                            <Box className="w-10 h-10" />
                          </div>
                        )}
                      </div>
                      <div className="p-3">
                        <h3 className="text-white font-medium text-sm line-clamp-2 mb-1">{name}</h3>
                        <div className="flex items-baseline gap-2">
                          <div className="text-white font-bold text-sm">{formatIqd(p.price_iqd || 0)}</div>
                          {p.original_price_iqd != null && p.original_price_iqd > p.price_iqd && (
                            <div className="text-zinc-500 text-xs line-through">{formatIqd(p.original_price_iqd)}</div>
                          )}
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
            )
          )}

          {activeTab === 'reviews' && (
            <div className="flex flex-col items-center justify-center py-16 text-zinc-500">
              <Star className="w-12 h-12 mb-3 opacity-40" />
              <p className="text-sm">{dir === 'rtl' ? 'لا توجد تقييمات بعد' : 'No reviews yet'}</p>
            </div>
          )}

          {activeTab === 'about' && (
            <div className="space-y-6">
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
                <h3 className="font-bold text-white mb-2">{dir === 'rtl' ? 'عن التاجر' : 'About the Merchant'}</h3>
                {merchant.bio ? (
                  <p className="text-sm text-zinc-400 leading-relaxed">{merchant.bio}</p>
                ) : (
                  <p className="text-sm text-zinc-500">{dir === 'rtl' ? 'لم يضف التاجر وصفاً بعد' : 'This merchant has not added a description yet.'}</p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3">
                {joined && (
                  <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-col justify-center">
                    <div className="text-zinc-500 text-xs mb-1">{dir === 'rtl' ? 'انضم' : 'Joined'}</div>
                    <div className="font-bold text-white">{joined}</div>
                  </div>
                )}
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-col justify-center">
                  <div className="text-zinc-500 text-xs mb-1">{dir === 'rtl' ? 'المنتجات' : 'Products'}</div>
                  <div className="font-bold text-white">{products.length}</div>
                </div>
                <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 flex flex-col justify-center">
                  <div className="text-zinc-500 text-xs mb-1">{dir === 'rtl' ? 'المتابعون' : 'Followers'}</div>
                  <div className="font-bold text-white">{followers}</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
