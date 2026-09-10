import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Store as StoreIcon, BadgeCheck, MessageCircle, Package, MapPin, Share2 } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { formatIqd } from '../lib/api';
import type { MerchantStore as StoreShape } from '../lib/merchant';
import SafeImage from '../components/ui/SafeImage';

interface StorefrontProps {
  store?: StoreShape | null;
  profileProducts?: Array<Record<string, unknown>>;
}

export default function Storefront({ store: propStore, profileProducts }: StorefrontProps) {
  const { dir, loc } = useLanguage();
  const [activeTab, setActiveTab] = useState<'products' | 'about'>('products');
  const store = propStore;

  const displayName = store?.name || (dir === 'rtl' ? 'متجر معتمد' : 'Verified Store');
  const tagline = store?.tagline || (dir === 'rtl' ? 'طباعة ثلاثية الأبعاد وحلول مخصصة' : '3D Printing & Custom Solutions');
  const description = store?.description || '';

  return (
    <div className="min-h-screen bg-black text-white pb-24">
      {/* Banner */}
      <div className="relative h-48 sm:h-64 bg-gradient-to-br from-zinc-800 to-zinc-950 overflow-hidden">
        {store?.bannerUrl && (
          <SafeImage
            src={store.bannerUrl}
            alt={displayName}
            className="w-full h-full object-cover"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/40 to-transparent" />
      </div>

      <div className="max-w-4xl mx-auto px-4 -mt-16 relative z-10">
        {/* Store Header Info */}
        <div className="flex flex-col sm:flex-row items-start sm:items-end justify-between gap-4 mb-6">
          <div className="flex items-end gap-4">
            <div className="w-24 h-24 sm:w-28 sm:h-28 rounded-2xl bg-zinc-900 border-2 border-zinc-700 overflow-hidden shadow-xl flex items-center justify-center">
              {store?.logoUrl ? (
                <SafeImage
                  src={store.logoUrl}
                  alt={displayName}
                  className="w-full h-full object-cover"
                />
              ) : (
                <StoreIcon className="w-12 h-12 text-zinc-500" />
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl font-black text-white">{displayName}</h1>
                <BadgeCheck className="w-5 h-5 text-emerald-400" />
              </div>
              <p className="text-sm text-zinc-400 mt-0.5">{tagline}</p>
              {store?.governorate && (
                <div className="flex items-center gap-1 text-xs text-zinc-500 mt-1">
                  <MapPin className="w-3.5 h-3.5" />
                  <span>{store.governorate}</span>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto">
            <button
              type="button"
              onClick={() => {
                if (navigator.share) {
                  navigator.share({ title: displayName, url: window.location.href });
                }
              }}
              className="px-4 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-white font-semibold text-sm flex items-center gap-2"
            >
              <Share2 className="w-4 h-4" />
              <span>{loc('مشاركة', 'Share', 'هاوبەشکردن')}</span>
            </button>
            <Link
              to="/chats"
              className="flex-1 sm:flex-none px-5 py-2 rounded-xl bg-gradient-to-r from-olive to-emerald-600 hover:from-emerald-500 hover:to-emerald-600 text-white font-bold text-sm flex items-center justify-center gap-2 shadow-lg"
            >
              <MessageCircle className="w-4 h-4" />
              <span>{loc('مراسلة المتجر', 'Contact Store', 'نامە ناردن')}</span>
            </Link>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center gap-2 border-b border-zinc-800 mb-6">
          <button
            type="button"
            onClick={() => setActiveTab('products')}
            className={`px-4 py-3 font-bold text-sm border-b-2 transition-colors ${
              activeTab === 'products'
                ? 'border-emerald-500 text-white'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {loc('المنتجات', 'Products', 'بەرهەمەکان')}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('about')}
            className={`px-4 py-3 font-bold text-sm border-b-2 transition-colors ${
              activeTab === 'about'
                ? 'border-emerald-500 text-white'
                : 'border-transparent text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {loc('عن المتجر', 'About', 'دەربارەی فرۆشگا')}
          </button>
        </div>

        {/* Tab Content */}
        {activeTab === 'products' ? (
          <div>
            {profileProducts && profileProducts.length > 0 ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                {profileProducts.map((p: any, idx) => (
                  <Link
                    key={p.id || idx}
                    to={`/product/${p.slug || p.id}`}
                    className="group block p-3 rounded-2xl bg-zinc-900/60 border border-zinc-800/80 hover:border-zinc-700 transition-all"
                  >
                    <div className="aspect-square rounded-xl bg-zinc-950 overflow-hidden mb-3">
                      {p.images?.[0] ? (
                        <SafeImage
                          src={p.images[0]}
                          alt={p.name || ''}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-zinc-700">
                          <Package className="w-8 h-8" />
                        </div>
                      )}
                    </div>
                    <h3 className="font-bold text-sm text-white line-clamp-1 group-hover:text-emerald-400 transition-colors">
                      {p.name || p.title || 'Product'}
                    </h3>
                    <div className="text-emerald-400 font-extrabold text-sm mt-1">
                      {formatIqd(p.price_iqd || p.price || 0)}
                    </div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="py-16 text-center text-zinc-500">
                <Package className="w-12 h-12 mx-auto mb-3 opacity-40" />
                <p>{loc('لا توجد منتجات معروضة حالياً', 'No products listed yet', 'هیچ بەرهەمێک بەردەست نییە')}</p>
              </div>
            )}
          </div>
        ) : (
          <div className="p-6 rounded-2xl bg-zinc-900/60 border border-zinc-800 space-y-4">
            <h3 className="font-bold text-lg text-white">{loc('نبذة عن المتجر', 'About the Store', 'دەربارە')}</h3>
            <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-line">
              {description || loc('لا توجد معلومات إضافية متوفرة.', 'No additional details provided.', 'هیچ زانیارییەکی تر بەردەست نییە.')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
