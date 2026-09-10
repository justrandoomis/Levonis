import React from 'react';
import { Bookmark, Package } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';

export default function SavedProducts() {
  const { loc } = useLanguage();

  return (
    <div className="min-h-screen bg-black text-white pb-24">
      <div className="max-w-xl mx-auto px-4 py-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-3 rounded-2xl bg-olive/20 border border-olive/40 text-olive">
            <Bookmark className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl font-black text-white">
              {loc('المنتجات المحفوظة', 'Saved Items', 'بەرهەمە پاشەکەوتکراوەکان')}
            </h1>
            <p className="text-xs text-zinc-400 mt-0.5">
              {loc('قائمة رغباتك والمنتجات التي حفظتها لاحقاً', 'Your saved products and wishlist', 'لیستی ئەو بەرهەمانەی پاشەکەوتت کردوون')}
            </p>
          </div>
        </div>

        <div className="p-12 rounded-3xl bg-zinc-900/40 border border-zinc-800 text-center text-zinc-500">
          <Package className="w-12 h-12 mx-auto mb-3 text-zinc-700" />
          <p className="font-semibold text-zinc-300 text-sm mb-1">
            {loc('لا توجد منتجات محفوظة حالياً', 'No saved products yet', 'هیچ بەرهەمێک پاشەکەوت نەکراوە')}
          </p>
          <p className="text-xs text-zinc-500 mb-6">
            {loc('تصفح المتجر واضغط على زر الحفظ لإضافة المنتجات إلى هذه القائمة.', 'Browse the store and tap bookmark to add items here.', 'سەیری فرۆشگا بکە و بەرهەمەکان زیادبکە.')}
          </p>
          <Link
            to="/products"
            className="px-5 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white font-semibold text-xs border border-zinc-700 inline-block"
          >
            {loc('تصفح المنتجات', 'Browse Catalog', 'گەڕان لە بەرهەمەکان')}
          </Link>
        </div>
      </div>
    </div>
  );
}
