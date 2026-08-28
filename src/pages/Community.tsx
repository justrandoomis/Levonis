import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { queryDb } from '../lib/db';
import { 
  ArrowLeft, ArrowRight, Search, Gift, Box, Calculator, 
  MapPin, MessageSquare, Plus, ShoppingBag, Store, UserCircle, Star,
  BadgeCheck, Settings, MessageCircle
} from 'lucide-react';

export default function Community() {
  const navigate = useNavigate();
  const location = useLocation();
  const { t, lang, dir } = useLanguage();
  const { user, isAuthenticated } = useAuth();
  
  const queryParams = new URLSearchParams(location.search);
  const activeTab = queryParams.get('tab') || 'products';

  const [products, setProducts] = useState<any[]>([]);
  const [merchants, setMerchants] = useState<any[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    async function loadData() {
      setLoading(true);
      try {
        if (activeTab === 'products') {
          const p = await queryDb('SELECT * FROM community_products ORDER BY created_at DESC LIMIT 20');
          setProducts(p || []);
        } else if (activeTab === 'merchants') {
          const m = await queryDb('SELECT * FROM community_merchants ORDER BY created_at DESC LIMIT 20');
          setMerchants(m || []);
        } else if (activeTab === 'requests') {
          const r = await queryDb('SELECT * FROM community_requests ORDER BY created_at DESC LIMIT 20');
          setRequests(r || []);
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, [activeTab]);

  return (
    <div className="w-full pb-24 text-zinc-300 min-h-screen bg-black">
      <div className="sticky top-0 z-40 bg-black/80 backdrop-blur-xl border-b border-zinc-800/60 px-4 py-3 flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="p-2 bg-zinc-900 rounded-full hover:bg-zinc-800 transition-colors">
          {dir === 'rtl' ? <ArrowRight className="w-5 h-5" /> : <ArrowLeft className="w-5 h-5" />}
        </button>
        <div className="flex-1 relative">
          <input 
            type="text" 
            placeholder={dir === 'rtl' ? "بحث في المجتمع..." : "Search community..."}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-full py-2 px-4 ps-10 text-sm focus:outline-none focus:border-olive/50 text-white"
          />
          <Search className={`w-4 h-4 text-zinc-500 absolute top-2.5 ${dir === 'rtl' ? 'right-3' : 'left-3'}`} />
        </div>
      </div>

      <div className="p-4 flex flex-col gap-6">
        
        {/* Shortcuts */}
        <div className="grid grid-cols-4 gap-2">
           <div className="flex flex-col items-center gap-2 cursor-pointer group" onClick={() => navigate('/chats')}>
             <div className="w-12 h-12 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center group-hover:border-olive/50 transition-colors">
               <MessageSquare className="w-5 h-5 text-zinc-400 group-hover:text-olive transition-colors" />
             </div>
             <span className="text-[10px] font-medium text-zinc-400">{dir === 'rtl' ? 'الرسائل' : 'Messages'}</span>
           </div>
           <div className="flex flex-col items-center gap-2 cursor-pointer group" onClick={() => navigate('/community/customer/requests')}>
             <div className="w-12 h-12 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center group-hover:border-olive/50 transition-colors">
               <Box className="w-5 h-5 text-zinc-400 group-hover:text-olive transition-colors" />
             </div>
             <span className="text-[10px] font-medium text-zinc-400">{dir === 'rtl' ? 'طلباتي' : 'Requests'}</span>
           </div>
           <div className="flex flex-col items-center gap-2 cursor-pointer group" onClick={() => navigate('/community/new-request')}>
             <div className="w-12 h-12 rounded-2xl bg-olive/10 border border-olive/30 flex items-center justify-center group-hover:bg-olive/20 transition-colors">
               <Plus className="w-5 h-5 text-olive" />
             </div>
             <span className="text-[10px] font-medium text-olive">{dir === 'rtl' ? 'طلب جديد' : 'New Order'}</span>
           </div>
           <div className="flex flex-col items-center gap-2 cursor-pointer group" onClick={() => navigate('/profile')}>
             <div className="w-12 h-12 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center overflow-hidden">
               <img referrerPolicy="no-referrer" src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${user?.username || "Levonis"}&backgroundColor=fde047`} alt="Avatar" className="w-full h-full object-cover" />
             </div>
             <span className="text-[10px] font-medium text-zinc-400">{dir === 'rtl' ? 'ملفي' : 'Profile'}</span>
           </div>
        </div>

        {/* Banners */}
        <div className="flex overflow-x-auto hide-scrollbar gap-3 -mx-4 px-4 snap-x pb-2">
           <div className="shrink-0 w-[240px] h-24 rounded-2xl bg-gradient-to-r from-purple-900/50 to-indigo-900/50 border border-purple-500/20 p-4 flex flex-col justify-center snap-start relative overflow-hidden" onClick={() => navigate('/merchant-giveaways')}>
             <div className="absolute right-2 bottom-0 opacity-20">
               <Gift className="w-20 h-20" />
             </div>
             <h3 className="text-white font-bold text-sm mb-1">{dir === 'rtl' ? 'المساعدات والهدايا' : 'Giveaways'}</h3>
             <p className="text-xs text-purple-200/70">{dir === 'rtl' ? 'اكتشف الهدايا من التجار' : 'Discover merchant gifts'}</p>
           </div>
           <div className="shrink-0 w-[240px] h-24 rounded-2xl bg-gradient-to-r from-zinc-800 to-zinc-900 border border-zinc-700 p-4 flex flex-col justify-center snap-start relative overflow-hidden" onClick={() => navigate('/community/auto-levo')}>
             <div className="absolute right-2 bottom-0 opacity-20">
               <Calculator className="w-20 h-20" />
             </div>
             <h3 className="text-white font-bold text-sm mb-1">{dir === 'rtl' ? 'احسب سعر طباعتك' : 'Calculate Print Price'}</h3>
             <p className="text-xs text-zinc-400">{dir === 'rtl' ? 'من رابط مباشر' : 'From direct link'}</p>
           </div>
           <div className="shrink-0 w-[240px] h-24 rounded-2xl bg-gradient-to-r from-olive/20 to-black border border-olive/30 p-4 flex flex-col justify-center snap-start relative overflow-hidden" onClick={() => navigate('/community/stl-library')}>
             <div className="absolute right-2 bottom-0 opacity-20">
               <Box className="w-20 h-20 text-olive" />
             </div>
             <h3 className="text-white font-bold text-sm mb-1">{dir === 'rtl' ? 'مكتبة ملفات الطباعة' : '3D Models Library'}</h3>
             <p className="text-xs text-olive/70">{dir === 'rtl' ? 'حمل مجسماتك المفضلة' : 'Download your favorite models'}</p>
           </div>
        </div>

        {/* Explore Tabs */}
        <div className="border-b border-zinc-800 sticky top-[60px] z-30 bg-black/80 backdrop-blur-md">
          <div className="flex justify-between">
            <button 
              onClick={() => navigate('/community?tab=products')}
              className={`flex-1 py-3 text-sm font-medium text-center relative ${activeTab === 'products' ? 'text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              {dir === 'rtl' ? 'المنتجات' : 'Products'}
              {activeTab === 'products' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-olive rounded-t-full"></div>}
            </button>
            <button 
              onClick={() => navigate('/community?tab=merchants')}
              className={`flex-1 py-3 text-sm font-medium text-center relative ${activeTab === 'merchants' ? 'text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              {dir === 'rtl' ? 'التجار' : 'Merchants'}
              {activeTab === 'merchants' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-olive rounded-t-full"></div>}
            </button>
            <button 
              onClick={() => navigate('/community?tab=requests')}
              className={`flex-1 py-3 text-sm font-medium text-center relative ${activeTab === 'requests' ? 'text-white' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              {dir === 'rtl' ? 'الطلبات' : 'Requests'}
              {activeTab === 'requests' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-olive rounded-t-full"></div>}
            </button>
          </div>
        </div>

        {/* Tab Content */}
        <div className="min-h-[400px]">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="w-6 h-6 border-2 border-olive border-t-transparent rounded-full animate-spin"></div>
            </div>
          ) : (
            <>
              {activeTab === 'products' && (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {products.map(p => {
                    const images = Array.isArray(p.images) ? p.images : (function(){ try { return JSON.parse(p.images || '[]'); } catch(e) { return [p.images].filter(Boolean); } })();
                    const firstImage = images[0] || p.image_url || p.image || 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800';
                    const name = lang === 'ar' && p.name_ar ? p.name_ar : p.name;
                    return (
                      <Link to={`/product/${p.slug || p.id}`} key={p.id} className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden flex flex-col group hover:border-olive/50 transition-colors">
                        <div className="relative aspect-square overflow-hidden bg-black">
                          <img referrerPolicy="no-referrer" src={firstImage || undefined} alt={name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                        </div>
                        <div className="p-3">
                          <h3 className="text-white font-medium text-sm line-clamp-2 mb-1">{name}</h3>
                          <div className="text-white font-bold text-sm">{((p.base_price) || 0).toLocaleString()} د.ع</div>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}

              {activeTab === 'merchants' && (
                <div className="flex flex-col gap-3">
                  {merchants.map((m, i) => (
                    <div key={i} onClick={() => navigate(`/community/store/${m.id}`)} className="bg-zinc-900/40 border border-zinc-800/60 rounded-2xl p-4 flex flex-col gap-4 cursor-pointer hover:border-olive/50 transition-colors">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="w-12 h-12 bg-white rounded-full overflow-hidden flex items-center justify-center border border-zinc-700 shrink-0">
                            <img referrerPolicy="no-referrer" src={m.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(m.name)}&background=random`} alt={m.name} className="w-full h-full object-cover" />
                          </div>
                          <div>
                            <div className="flex items-center gap-1.5">
                              <h3 className="text-white font-bold text-sm">{m.name}</h3>
                              <BadgeCheck className="w-4 h-4 text-gold" />
                            </div>
                            <div className="flex items-center gap-1 text-xs text-zinc-400 mt-0.5">
                              <span className="text-white font-medium">{m.followers || 0}</span>
                              <span>{dir === 'rtl' ? 'متابع' : 'Followers'}</span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                          <button onClick={() => navigate(`/community/store/${m.id}`)} className="w-8 h-8 rounded-full border border-zinc-700 flex items-center justify-center text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors">
                            <Store className="w-4 h-4" />
                          </button>
                          <button onClick={() => navigate(`/chat/${m.id}`)} className="w-8 h-8 rounded-full border border-zinc-700 flex items-center justify-center text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors">
                            <MessageCircle className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                      {m.products && m.products.length > 0 && (
                        <div className="grid grid-cols-3 gap-2 mt-1">
                          {m.products.map((p: string, idx: number) => (
                            <div key={idx} className="aspect-square rounded-xl overflow-hidden bg-zinc-900 border border-zinc-800/50">
                              <img referrerPolicy="no-referrer" src={p || undefined} alt="" className="w-full h-full object-cover" />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {activeTab === 'requests' && (
                <div className="flex flex-col gap-3">
                  {requests.map((r, i) => (
                    <div key={i} className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4">
                       <h3 className="text-white font-medium mb-2">{r.title}</h3>
                       <div className="flex justify-between items-center text-xs text-zinc-500">
                         <span>{dir === 'rtl' ? 'بانتظار العروض' : 'Waiting for offers'}</span>
                         <button className="text-olive hover:text-olive/80">{dir === 'rtl' ? 'تقديم عرض' : 'Make Offer'}</button>
                       </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

      </div>
    </div>
  );
}
