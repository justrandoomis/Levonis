import React, { useState, useEffect } from 'react';
import { useLocation, Link, useNavigate } from 'react-router-dom';
import { queryDb } from '../lib/db';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { ChevronLeft, Package, ArrowRight, ArrowLeft, Star } from 'lucide-react';

export default function Products() {
  const { t, lang, dir } = useLanguage();
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryParams = new URLSearchParams(location.search);
  const search = queryParams.get('search') || '';
  const category = queryParams.get('category') || '';

  const [products, setProducts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchProducts() {
      setLoading(true);
      try {
        let sql = 'SELECT * FROM products WHERE 1=1';
        let params: any[] = [];
        
        if (search) {
          sql += ' AND (name LIKE ? OR name_ar LIKE ? OR description LIKE ?)';
          params.push(`%${search}%`, `%${search}%`, `%${search}%`);
        }
        
        if (category) {
          sql += ' AND subcategory_id = ?';
          params.push(category);
        }
        
        sql += ' ORDER BY created_at DESC';
        
        const res = await queryDb(sql, params);
        setProducts(res || []);
      } catch (err) {
        console.error(err);
        setProducts([]);
      } finally {
        setLoading(false);
      }
    }
    
    fetchProducts();
  }, [search, category]);

  return (
    <div className="w-full pb-24 text-zinc-300 min-h-screen">
      <div className="sticky top-0 z-40 bg-black/80 backdrop-blur-xl border-b border-zinc-800/60 px-4 py-3 flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="p-2 bg-zinc-900 rounded-full hover:bg-zinc-800 transition-colors">
          {dir === 'rtl' ? <ArrowRight className="w-5 h-5" /> : <ArrowLeft className="w-5 h-5" />}
        </button>
        <h1 className="text-white font-bold text-lg">
          {search ? `${t('search')}: ${search}` : category ? `${t('category')}: ${category}` : t('products' as any) || 'Products'}
        </h1>
      </div>

      <div className="p-4">
        {loading ? (
          <div className="text-center py-12 text-zinc-500">Loading...</div>
        ) : products.length === 0 ? (
          <div className="text-center py-12 text-zinc-500 bg-zinc-900/50 rounded-xl border border-zinc-800/50">
            No products found.
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
            {products.map(p => {
              const images = Array.isArray(p.images) ? p.images : (function(){ try { return JSON.parse(p.images || '[]'); } catch(e) { return [p.images].filter(Boolean); } })();
              const firstImage = images[0] || p.image_url || p.image || 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800';
              const name = lang === 'ar' && p.name_ar ? p.name_ar : p.name;
              
              let proPrice = null;
              if (p && p.membership_prices) {
                try {
                  const parsed = typeof p.membership_prices === 'string' ? JSON.parse(p.membership_prices) : p.membership_prices;
                  if (parsed.pro) proPrice = parsed.pro;
                } catch (e) {}
              }
              const isPro = user?.subscription_plan === 'pro';
              
              return (
                <Link to={`/product/${p.slug || p.id}`} key={p.id} className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden flex flex-col group hover:border-olive/50 transition-colors">
                  <div className="relative aspect-square overflow-hidden bg-black">
                    <img referrerPolicy="no-referrer" src={firstImage || undefined} alt={name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                    {p.original_price > p.base_price && (
                      <div className="absolute top-2 right-2 bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
                        Sale
                      </div>
                    )}
                  </div>
                  <div className="p-3 flex flex-col flex-1">
                    <h3 className="text-white font-medium text-sm line-clamp-2 mb-1">{name}</h3>
                    <div className="mt-auto pt-2 flex items-center justify-between">
                      <div className="flex flex-col gap-0.5">
                        {(isPro && proPrice) ? (
                          <>
                             <div className="flex flex-col">
                                <span className="text-zinc-500 text-[10px] line-through">{((p.base_price) || 0).toLocaleString()} د.ع</span>
                                <span className="text-gold font-extrabold text-[15px] flex items-center gap-1 drop-shadow-[0_0_8px_rgba(186,163,105,0.4)]">
                                   <Star className="w-3.5 h-3.5 fill-gold" />
                                   {((proPrice) || 0).toLocaleString()} د.ع
                                </span>
                             </div>
                          </>
                        ) : (
                          <>
                             <div className="flex flex-col">
                               {p.original_price > p.base_price && (
                                 <span className="text-zinc-500 text-[10px] line-through">{((p.original_price) || 0).toLocaleString()} د.ع</span>
                               )}
                               <span className="text-white font-bold text-sm">{((p.base_price) || 0).toLocaleString()} د.ع</span>
                             </div>
                             {proPrice && (
                               <div className="flex items-center gap-1 mt-0.5">
                                  <Star className="w-2.5 h-2.5 text-zinc-500" />
                                  <span className="text-zinc-500 font-medium text-[10px]">
                                    {((proPrice) || 0).toLocaleString()} د.ع (للمشتركين)
                                  </span>
                               </div>
                             )}
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
