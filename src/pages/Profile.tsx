import React, { useState, useEffect } from 'react';
import { useLanguage } from '../LanguageContext';
import { useNavigate } from 'react-router-dom';
import { 
  Headset, Settings, MapPin, QrCode, Store,
  Wallet, Package, Truck, MessageSquare, RefreshCcw,
  Star, Clock, Heart, Gamepad2, Coins, Leaf, Zap, Shield,
  ChevronRight, ChevronLeft, Search, MoreHorizontal,
  X, Menu, AlignJustify, Layers, Printer, Cpu
} from 'lucide-react';
import { useWallet } from '../WalletContext';
import { useAuth } from '../AuthContext';
import { queryDb } from '../lib/db';

export default function Profile() {
  const [suggestedProducts, setSuggestedProducts] = useState<any[]>([]);
  const [bundles, setBundles] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState('suggested');
  const [scrolled, setScrolled] = useState(false);
  const { t, dir, lang } = useLanguage();
  const navigate = useNavigate();
  const { balance, pointBalance } = useWallet();
  const { isAuthenticated, user } = useAuth();

  useEffect(() => {
    queryDb('SELECT * FROM products ORDER BY RANDOM() LIMIT 6').then(res => setSuggestedProducts(res || []));
    queryDb('SELECT * FROM products WHERE (selling_type = "bundle" OR name LIKE "%bundle%" OR description LIKE "%bundle%") ORDER BY RANDOM() LIMIT 4').then(res => setBundles(res || []));
    
    const handleScroll = () => {
      const mainContainer = document.getElementById('main-scroll-container');
      if (mainContainer) {
        setScrolled(mainContainer.scrollTop > 40);
      } else {
        setScrolled(window.scrollY > 40);
      }
    };
    
    // Check initial scroll position
    setTimeout(handleScroll, 100);

    const container = document.getElementById('main-scroll-container');
    if (container) {
      container.addEventListener('scroll', handleScroll, { passive: true });
      return () => container.removeEventListener('scroll', handleScroll);
    } else {
      window.addEventListener('scroll', handleScroll, { passive: true });
      return () => window.removeEventListener('scroll', handleScroll);
    }
  }, []);

  const isPro = user?.subscription_plan === 'pro';

  return (
    <div className="w-full bg-[#f2f2f2] dark:bg-[#111] min-h-screen font-sans pb-[80px] text-[#333] dark:text-[#ddd] relative">
      
      {/* Top Background Gradient */}
      <div className="absolute top-0 left-0 right-0 h-[240px] bg-gradient-to-b from-[#ffe3cc] via-[#ffebd9] to-[#f2f2f2] dark:from-[#2a1a10] dark:via-[#1a0f08] dark:to-[#111] z-0 pointer-events-none"></div>

      {/* Sticky Header */}
      <div className={`fixed top-0 left-0 right-0 z-[110] transition-all duration-300 flex items-center justify-between ${scrolled ? 'bg-[#ffe3cc] dark:bg-[#2a1a10] shadow-md py-2 px-3 opacity-100 pointer-events-auto' : 'bg-transparent py-3 px-3 opacity-0 pointer-events-none'}`}>
        <div className="flex items-center gap-2">
           <div className="w-7 h-7 rounded-full bg-white overflow-hidden border border-black/10 shrink-0">
             <img referrerPolicy="no-referrer" src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${user?.username || "Levonis"}&backgroundColor=fde047`} alt="Avatar" className="w-full h-full object-cover" />
           </div>
           <span className="font-bold text-[13px] truncate max-w-[100px] text-black dark:text-white">{user?.username || 'levonisiq'}</span>
        </div>

        <div className="flex items-center gap-4 text-black dark:text-white">
          <div onClick={() => navigate('/addresses')} className="flex flex-col items-center cursor-pointer hover:opacity-70">
            <MapPin className="w-5 h-5 mb-0.5" strokeWidth={1.5} />
          </div>
          <div onClick={() => navigate('/chat/2')} className="flex flex-col items-center cursor-pointer hover:opacity-70">
            <Headset className="w-5 h-5 mb-0.5" strokeWidth={1.5} />
          </div>
          <div onClick={() => navigate('/settings')} className="flex flex-col items-center cursor-pointer hover:opacity-70">
            <Settings className="w-5 h-5 mb-0.5" strokeWidth={1.5} />
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-3 relative z-10 pt-4">
        
        {/* User Info Header (In Flow) */}
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-[64px] h-[64px] rounded-full bg-[#fce5a1] border border-white/50 flex items-center justify-center overflow-hidden shrink-0 shadow-sm relative">
              <img referrerPolicy="no-referrer" src={`https://api.dicebear.com/7.x/avataaars/svg?seed=${user?.username || "Levonis"}&backgroundColor=fde047`} alt="Avatar" className="w-full h-full object-cover" />
            </div>
            <div className="flex flex-col">
              <div className="flex items-center gap-1.5 mb-1.5">
                <h1 className="font-bold text-[17px] leading-tight text-black dark:text-white">{user?.username || 'levonisiq'}</h1>
                <QrCode className="w-[14px] h-[14px] text-zinc-700 dark:text-zinc-300" strokeWidth={2} />
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2">
                <div className="bg-[#ebd197] text-[#5c3e03] text-[10px] px-1.5 py-0.5 rounded-[4px] flex items-center gap-0.5 font-bold shadow-sm">
                  <span>{dir === 'rtl' ? 'عضو ذهبي' : 'Gold Member'}</span>
                </div>
                <div onClick={() => navigate('/followed-stores')} className="bg-white/50 dark:bg-black/30 backdrop-blur-sm text-[10px] px-1.5 py-0.5 rounded-[4px] flex items-center gap-1 font-medium shadow-sm text-black dark:text-white cursor-pointer hover:bg-white/70 dark:hover:bg-black/50 transition-colors">
                  <Store className="w-[10px] h-[10px]" strokeWidth={2} />
                  {dir === 'rtl' ? 'المتاجر التي يتابعها' : 'Followed Stores'}
                </div>
              </div>
            </div>
          </div>

          {/* Icons on top right */}
          <div className={`flex items-center gap-4 mt-2 text-black dark:text-white transition-opacity duration-300 ${scrolled ? 'opacity-0' : 'opacity-100'}`}>
            <div onClick={() => navigate('/addresses')} className="flex flex-col items-center cursor-pointer hover:opacity-70">
              <MapPin className="w-6 h-6 mb-0.5" strokeWidth={1.5} />
              <span className="text-[10px] font-medium">{dir === 'rtl' ? 'العنوان' : 'Address'}</span>
            </div>
            <div onClick={() => navigate('/chat/2')} className="flex flex-col items-center cursor-pointer hover:opacity-70">
              <Headset className="w-6 h-6 mb-0.5" strokeWidth={1.5} />
              <span className="text-[10px] font-medium">{dir === 'rtl' ? 'خدمة العملاء' : 'Support'}</span>
            </div>
            <div onClick={() => navigate('/settings')} className="flex flex-col items-center cursor-pointer hover:opacity-70">
              <Settings className="w-6 h-6 mb-0.5" strokeWidth={1.5} />
              <span className="text-[10px] font-medium">{dir === 'rtl' ? 'الاعدادات' : 'Settings'}</span>
            </div>
          </div>
        </div>

        {/* First Card: Membership Center */}
        <div className="bg-white dark:bg-[#1a1a1a] rounded-xl p-3 mb-3 shadow-sm">
          {/* Top section of the card */}
          <div className="flex justify-between items-center mb-3 pb-3 border-b border-black/5 dark:border-white/5 overflow-hidden">
            <div className="flex items-center gap-1 cursor-pointer shrink-0">
              <span className="font-bold text-[10px] text-black dark:text-white whitespace-nowrap">{dir === 'rtl' ? 'وفرت هذا الشهر' : 'Saved this month'}</span>
              <span className="font-bold text-[10px] text-black dark:text-white whitespace-nowrap">{isPro ? '200,000' : '0'} {dir === 'rtl' ? 'د.ع' : 'IQD'}</span>
              {dir === 'rtl' ? <ChevronLeft className="w-3 h-3 text-zinc-400 shrink-0" /> : <ChevronRight className="w-3 h-3 text-zinc-400 shrink-0" />}
            </div>
            <div className="flex gap-2 shrink-0">
              <div className="flex flex-col items-center relative rtl:pl-2 ltr:pr-2 after:content-[''] after:absolute rtl:after:left-0 ltr:after:right-0 after:top-1/2 after:-translate-y-1/2 after:w-[1px] after:h-4 after:bg-zinc-200">
                <span className="text-[#ff5000] font-bold text-[9px] whitespace-nowrap">{dir === 'rtl' ? 'مركز الأعضاء' : 'Member Center'}</span>
                <span className="text-[8px] text-zinc-500 whitespace-nowrap">{dir === 'rtl' ? '16 ميزة' : '16 benefits'}</span>
              </div>
              <div className="flex flex-col items-center shrink-0">
                <span className="text-[#ff5000] font-bold text-[9px] whitespace-nowrap">{dir === 'rtl' ? 'بطاقة التوفير' : 'Savings Card'}</span>
                <span className="text-[8px] text-zinc-500 whitespace-nowrap">{dir === 'rtl' ? 'مجاناً' : 'Free'}</span>
              </div>
            </div>
          </div>
          
          {/* Middle row: Stats */}
          <div className="flex justify-between items-center mb-3 text-black dark:text-white">
            <div className="flex flex-col items-center flex-1" onClick={() => navigate('/points')}>
              <span className="text-[11px] font-medium mb-1 whitespace-nowrap">{dir === 'rtl' ? 'النقاط' : 'Points'}</span>
              <span className="text-[12px] font-bold font-mono">{pointBalance || 0}</span>
            </div>
            <div className="flex flex-col items-center flex-1 relative pr-2 after:content-[''] after:absolute after:right-0 after:top-1/2 after:-translate-y-1/2 after:w-[1px] after:h-6 after:bg-zinc-200" onClick={() => navigate('/wallet')}>
              <span className="text-[11px] font-medium mb-1 whitespace-nowrap">{dir === 'rtl' ? 'الرصيد' : 'Balance'}</span>
              <span className="text-[12px] font-bold font-mono">{dir === 'rtl' ? 'د.ع' : 'IQD'} {(balance || 0).toLocaleString()}</span>
            </div>
            <div className="flex flex-col items-center flex-1 relative pr-2 after:content-[''] after:absolute after:right-0 after:top-1/2 after:-translate-y-1/2 after:w-[1px] after:h-6 after:bg-zinc-200">
               <span className="text-[11px] font-medium mb-1 whitespace-nowrap">{dir === 'rtl' ? 'الحماية' : 'Protection'}</span>
               <span className="text-[10px] font-bold whitespace-nowrap flex items-center gap-0.5 text-green-500"><Shield className="w-3 h-3" /> {dir === 'rtl' ? 'مفعل' : 'Active'}</span>
            </div>
          </div>

          {/* Bottom game tickets row */}
          {(user?.subscription_plan === 'pro' || user?.subscription_plan === 'plus') && (
            <div className="bg-[#fff6f5] dark:bg-[#2a1111] rounded-lg p-2 flex justify-between items-center mt-3">
               <div className="flex items-center gap-1.5">
                 <Gamepad2 className="w-4 h-4 text-[#ff5000]" />
                 <span className="text-[11px] text-[#ff5000] font-medium whitespace-nowrap">
                   {dir === 'rtl' 
                     ? `${user?.subscription_plan === 'pro' ? 5 : 3} تذاكر ألعاب مجانية يومياً` 
                     : `${user?.subscription_plan === 'pro' ? 5 : 3} Free daily game tickets`}
                 </span>
               </div>
               <button onClick={() => navigate('/games')} className="bg-gradient-to-r from-[#ff0036] to-[#ff5000] text-white text-[11px] px-3 py-1 rounded-full font-bold whitespace-nowrap">
                 {dir === 'rtl' ? 'العب الان' : 'Play Now'}
               </button>
            </div>
          )}
        </div>

        {/* Second Card: 4 Buttons */}
        <div className="bg-white dark:bg-[#1a1a1a] rounded-xl p-4 mb-3 shadow-sm flex justify-around items-center text-black dark:text-white">
          <div className="flex flex-col items-center gap-2 cursor-pointer hover:opacity-70" onClick={() => navigate('/orders?status=processing')}>
            <Package className="w-6 h-6" strokeWidth={1.5} />
            <span className="text-[11px] whitespace-nowrap">{dir === 'rtl' ? 'الشحن' : 'Shipping'}</span>
          </div>
          <div className="flex flex-col items-center gap-2 cursor-pointer hover:opacity-70">
            <Star className="w-6 h-6" strokeWidth={1.5} />
            <span className="text-[11px] whitespace-nowrap">{dir === 'rtl' ? 'المفضلة' : 'Favorites'}</span>
          </div>
          <div onClick={() => navigate('/followed-stores')} className="flex flex-col items-center gap-2 cursor-pointer hover:opacity-70">
            <Store className="w-6 h-6" strokeWidth={1.5} />
            <span className="text-[11px] whitespace-nowrap">{dir === 'rtl' ? 'متاجري' : 'Stores'}</span>
          </div>
          <div className="flex flex-col items-center gap-2 cursor-pointer hover:opacity-70">
            <Clock className="w-6 h-6" strokeWidth={1.5} />
            <span className="text-[11px] whitespace-nowrap">{dir === 'rtl' ? 'سجل المشاهدات' : 'History'}</span>
          </div>
        </div>

        {/* Third Card: My Orders */}
        <div className="bg-white dark:bg-[#1a1a1a] rounded-xl p-3 mb-3 shadow-sm text-black dark:text-white">
          <div className="flex justify-between items-center mb-4">
            <h2 className="font-bold text-[14px]">{dir === 'rtl' ? 'طلباتي' : 'My Orders'}</h2>
            <div className="flex items-center text-[11px] text-zinc-500 cursor-pointer" onClick={() => navigate('/orders')}>
              {dir === 'rtl' ? 'الكل' : 'All'}
              {dir === 'rtl' ? <ChevronLeft className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            </div>
          </div>
          <div className="flex justify-between items-start pt-1 pb-2 gap-1 overflow-hidden">
            {[
              { icon: Wallet, label: dir === 'rtl' ? 'بانتظار الدفع' : 'Pending Payment', badge: 0 },
              { icon: Package, label: dir === 'rtl' ? 'بانتظار الشحن' : 'To Ship', badge: 3 },
              { icon: Truck, label: dir === 'rtl' ? 'مشحونة' : 'Shipped', badge: 1 },
              { icon: MessageSquare, label: dir === 'rtl' ? 'بانتظار المراجعة' : 'To Review', badge: 19 },
              { icon: RefreshCcw, label: dir === 'rtl' ? 'استرجاع/خدمات' : 'Returns', badge: 0 },
            ].map((item, i) => (
              <div key={i} className="flex flex-col items-center gap-1.5 flex-1 cursor-pointer hover:opacity-70 relative">
                <div className="relative">
                  <item.icon className="w-[24px] h-[24px]" strokeWidth={1.5} />
                  {item.badge > 0 && (
                    <span className="absolute -top-1 -right-1 bg-[#ff5000] text-white text-[9px] font-bold px-1 min-w-[14px] h-[14px] rounded-full flex items-center justify-center border-2 border-white dark:border-[#1a1a1a]">
                      {item.badge}
                    </span>
                  )}
                </div>
                <span className="text-[9px] sm:text-[10px] text-center leading-tight mt-1 whitespace-nowrap">{item.label}</span>
              </div>
            ))}
          </div>
          {/* Order Status Banner */}
          <div className="bg-[#f7f7f7] dark:bg-[#222] rounded-lg p-2.5 mt-2 flex items-center gap-2">
            <div className="w-8 h-8 rounded shrink-0 overflow-hidden">
               <img referrerPolicy="no-referrer" src="https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=100" className="w-full h-full object-cover" />
            </div>
            <div className="flex items-center gap-2 text-[12px]">
              <span className="font-bold whitespace-nowrap">{dir === 'rtl' ? 'بانتظار المراجعة' : 'To review'}</span>
              <span className="text-zinc-600 dark:text-zinc-400 truncate">{dir === 'rtl' ? 'هل نسخة اللعبة جديدة؟' : 'Is the game version new?'}</span>
            </div>
          </div>
        </div>

        {/* Fourth Card: Games (Horizontal Scroll) */}
        <div className="bg-white dark:bg-[#1a1a1a] rounded-xl p-4 mb-3 shadow-sm overflow-hidden relative">
          <div className="flex overflow-x-auto gap-5 hide-scrollbar">
            {[
              { icon: Leaf, label: dir === 'rtl' ? 'المزرعة' : 'Farm', color: 'text-green-500', bg: 'bg-green-100 dark:bg-green-900/30' },
              { icon: Coins, label: dir === 'rtl' ? 'جمع العملات' : 'Collect Coins', color: 'text-yellow-500', bg: 'bg-yellow-100 dark:bg-yellow-900/30' },
              { icon: Zap, label: dir === 'rtl' ? 'تسجيل الدخول' : 'Daily Sign-in', color: 'text-red-500', bg: 'bg-red-100 dark:bg-red-900/30' },
              { icon: Gamepad2, label: dir === 'rtl' ? 'الالعاب' : 'Games', color: 'text-purple-500', bg: 'bg-purple-100 dark:bg-purple-900/30' },
              { icon: Star, label: dir === 'rtl' ? 'المكافآت' : 'Rewards', color: 'text-orange-500', bg: 'bg-orange-100 dark:bg-orange-900/30' },
            ].map((game, i) => (
              <div key={i} className="flex flex-col items-center gap-2 min-w-[56px] cursor-pointer hover:scale-105 transition-transform">
                <div className={`w-[44px] h-[44px] rounded-full flex items-center justify-center ${game.bg}`}>
                  <game.icon className={`w-[22px] h-[22px] ${game.color}`} strokeWidth={2} />
                </div>
                <span className="text-[11px] text-black dark:text-white text-center whitespace-nowrap">{game.label}</span>
              </div>
            ))}
          </div>
          <button className="absolute top-2 right-2 text-zinc-400 hover:text-zinc-600">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Fifth Card: Limited Time Pro Discounts (Bundles) */}
        {isPro && (
          <div className="bg-white dark:bg-[#1a1a1a] rounded-xl p-3 mb-3 shadow-sm text-black dark:text-white">
            <div className="flex justify-between items-center mb-3">
              <h2 className="font-bold text-[14px] flex items-center gap-1 text-[#ff0036]">
                <span className="italic font-black text-base">PRO BUNDLE</span>
                <span className="text-black dark:text-white ml-1 text-[13px]">{dir === 'rtl' ? 'مركز الخصومات الحصرية' : 'Exclusive Discounts'}</span>
              </h2>
              <div className="text-[11px] text-zinc-500 cursor-pointer" onClick={() => navigate('/bundles')}>{dir === 'rtl' ? 'المزيد >' : 'More >'}</div>
            </div>
            <div className="flex gap-2.5 overflow-x-auto hide-scrollbar pb-1">
              {bundles.length > 0 ? bundles.map((bundle, i) => (
                <div key={i} onClick={() => navigate(`/product/${bundle.slug}`)} className="min-w-[85px] w-[85px] bg-[#fff0f2] dark:bg-[#331118] border border-[#ffb3c1] dark:border-[#801a2c] rounded-lg p-1.5 flex flex-col shrink-0 cursor-pointer">
                  <div className="w-full aspect-square bg-zinc-200 dark:bg-zinc-800 rounded mb-1.5 overflow-hidden">
                    <img referrerPolicy="no-referrer" src={(Array.isArray(bundle.images) ? bundle.images : (function(){ try { return JSON.parse(bundle.images || '[]'); } catch(e) { return [bundle.images].filter(Boolean); } })())[0] || 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=200&h=200&fit=crop'} alt={bundle.name} className="w-full h-full object-cover" />
                  </div>
                  <span className="text-[9px] font-bold text-black dark:text-white line-clamp-2 leading-tight mb-1">{bundle.name}</span>
                  <div className="text-[#ff0036] font-bold flex items-baseline gap-0.5 mt-auto">
                    <span className="text-[9px]">{dir === 'rtl' ? 'د.ع' : 'IQD'}</span>
                    <span className="text-[12px] leading-none">{(bundle.base_price || 0).toLocaleString()}</span>
                  </div>
                </div>
              )) : (
                <div className="text-[11px] text-zinc-500 py-4 w-full text-center">
                  {dir === 'rtl' ? 'لا توجد عروض حالياً' : 'No bundles available'}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tabs for Bottom Section */}
        <div className="flex items-center gap-6 mt-4 mb-3 sticky top-[48px] z-40 bg-[#f2f2f2] dark:bg-[#111] py-2 px-1">
          {[
            { id: 'suggested', label: dir === 'rtl' ? 'المنتجات المقترحة' : 'Suggested' },
            { id: 'collection', label: dir === 'rtl' ? 'مجموعتي' : 'My Collection' },
            { id: 'reviews', label: dir === 'rtl' ? 'مراجعاتي' : 'My Reviews', badge: 1 },
          ].map(tab => (
            <div 
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`cursor-pointer font-bold text-[14px] relative transition-colors ${activeTab === tab.id ? 'text-[#ff5000]' : 'text-black dark:text-white'}`}
            >
              {tab.label}
              {tab.badge && (
                <span className="absolute -top-1.5 -right-2 bg-[#ff5000] text-white text-[9px] font-bold px-1 min-w-[14px] h-[14px] rounded-full flex items-center justify-center">
                  {tab.badge}
                </span>
              )}
              {activeTab === tab.id && (
                <div className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-4 h-[3px] bg-[#ff5000] rounded-full"></div>
              )}
            </div>
          ))}
        </div>

        {/* Product Grid */}
        {activeTab === 'suggested' && (
          <div className="grid grid-cols-2 gap-2.5 mb-6">
            {suggestedProducts.map(p => {
              const images = Array.isArray(p.images) ? p.images : (function(){ try { return JSON.parse(p.images || '[]'); } catch(e) { return [p.images].filter(Boolean); } })();
              const firstImage = images[0] || p.image_url || p.image || 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800';
              const name = lang === 'ar' && p.name_ar ? p.name_ar : p.name;
              
              return (
                <div onClick={() => navigate('/product/' + p.slug)} key={p.id} className="bg-white dark:bg-[#1a1a1a] rounded-[10px] overflow-hidden flex flex-col cursor-pointer border border-black/5 dark:border-white/5 shadow-sm pb-2">
                  <div className="relative aspect-square overflow-hidden bg-zinc-100 dark:bg-zinc-800">
                    <img referrerPolicy="no-referrer" src={firstImage || undefined} alt={name} className="w-full h-full object-cover" />
                  </div>
                  <div className="p-2.5 flex flex-col flex-1 text-black dark:text-white">
                    <h3 className="font-medium text-[13px] line-clamp-2 mb-2 leading-[1.3]">{name}</h3>
                    
                    {/* Tags */}
                    <div className="flex flex-wrap gap-1 mb-2">
                       <span className="text-[#ff5000] border border-[#ff5000]/30 bg-[#ff5000]/5 text-[10px] px-1 rounded-sm">{dir === 'rtl' ? 'دعم محدود 1 د.ع' : 'Limited 1 IQD Subsidy'}</span>
                    </div>

                    <div className="mt-auto flex items-baseline justify-between">
                       <span className="text-[#ff5000] font-bold text-[18px] flex items-baseline gap-0.5">
                         <span className="text-[12px]">¥</span>
                         {((p.base_price) || 0).toLocaleString()}
                       </span>
                       <span className="text-[11px] text-zinc-500">{dir === 'rtl' ? 'بيع 500+' : '500+ Sold'}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Collection Tab */}
        {activeTab === 'collection' && (
          <div className="mb-6">
             {/* Filters */}
             <div className="flex items-center justify-between mb-4 mt-2">
                <div className="flex items-center gap-2 overflow-x-auto hide-scrollbar">
                  {[
                    { id: 'discount', label: dir === 'rtl' ? 'يوجد خصم' : 'Discount' },
                    { id: 'category', label: dir === 'rtl' ? 'الفئة' : 'Category' },
                    { id: 'status', label: dir === 'rtl' ? 'الحالة' : 'Status' },
                    { id: 'time', label: dir === 'rtl' ? 'تاريخ الحفظ' : 'Time' },
                  ].map(sub => (
                    <div key={sub.id} className="px-3 py-1.5 rounded-full bg-white dark:bg-[#1a1a1a] text-[11px] text-black dark:text-white whitespace-nowrap flex items-center gap-1 shadow-sm border border-black/5 dark:border-white/5">
                      {sub.label}
                      {(sub.id === 'category' || sub.id === 'status' || sub.id === 'time') && <ChevronRight className={`w-3 h-3 ${dir === 'rtl' ? '-rotate-90' : 'rotate-90'}`} />}
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-3 text-zinc-500 pl-3 shrink-0 border-l border-zinc-200 dark:border-zinc-800 ml-2">
                  <Menu className="w-[18px] h-[18px]" />
                  <AlignJustify className="w-[18px] h-[18px]" />
                </div>
             </div>

             {/* Collection List */}
             <div className="flex flex-col gap-3">
               {[
                 {
                   id: 1,
                   image: 'https://images.unsplash.com/photo-1605901309584-818e25960b8f?w=400', 
                   title: dir === 'rtl' ? 'بطاقة شحن متجر نينتندو سويتش eShop' : 'Nintendo eShop Switch Gift Card',
                   stats: dir === 'rtl' ? '9 أشخاص يشترون الآن، 300+ تقييم' : '9 buying, 300+ reviews',
                   price: '0.7',
                   store: dir === 'rtl' ? 'متجر الألعاب الرقمية' : 'Digital Games Store',
                   saved: '394',
                   tags: ['Official', 'eShop Top-up']
                 },
                 {
                   id: 2,
                   image: 'https://images.unsplash.com/photo-1611996575749-79a3a250f948?w=400',
                   title: dir === 'rtl' ? 'لعبة اللوح الذكية للاطفال' : 'SmartGames Logic Board Game',
                   stats: dir === 'rtl' ? 'خصم إضافي 12%' : 'Extra 12% off',
                   price: '115.55',
                   store: dir === 'rtl' ? 'المتجر العالمي المعتمد' : 'Global Official Store',
                   saved: '2452',
                   tags: ['PRO BUNDLE', 'Official']
                 },
                 {
                   id: 3,
                   image: 'https://images.unsplash.com/photo-1552820728-8b83bb6b773f?w=400',
                   title: dir === 'rtl' ? 'لعبة بيندي وآلة الحبر نسخة نينتندو سويتش' : 'Bendy and the Ink Machine Switch',
                   stats: dir === 'rtl' ? 'خصم 0.5 للعملات الذهبية' : '0.5 coins discount',
                   price: '18.5',
                   store: dir === 'rtl' ? 'متجر الاحلام للالعاب' : 'Dream Games Store',
                   saved: '51',
                   tags: []
                 },
                 {
                   id: 4,
                   image: 'https://images.unsplash.com/photo-1538481199705-c710c4e965fc?w=400',
                   title: dir === 'rtl' ? 'لعبة قصة طاعون: ريكويم نسخة رقمية' : 'A Plague Tale: Requiem Digital',
                   stats: dir === 'rtl' ? 'خصم 0.7 للعملات الذهبية' : '0.7 coins discount',
                   price: '34.3',
                   store: dir === 'rtl' ? 'متجر الكوكب الصغير' : 'Little Planet Store',
                   saved: '121',
                   tags: ['Gaming']
                 }
               ].map((item) => (
                 <div key={item.id} className="bg-white dark:bg-[#1a1a1a] rounded-[10px] p-2.5 flex gap-3 shadow-sm border border-black/5 dark:border-white/5 relative">
                   <div className="w-[110px] h-[110px] rounded-lg overflow-hidden shrink-0 bg-zinc-100 dark:bg-zinc-800">
                     <img referrerPolicy="no-referrer" src={item.image || undefined} alt={item.title} className="w-full h-full object-cover" />
                   </div>
                   <div className="flex flex-col flex-1 min-w-0">
                     <h3 className="font-bold text-[13px] leading-[1.3] mb-1.5 text-black dark:text-white line-clamp-2">
                       {item.tags.length > 0 && item.tags.map((tag, i) => (
                         <span key={i} className="inline-block bg-gradient-to-r from-[#ff0036] to-[#ff5000] text-white text-[9px] px-1 rounded-sm mr-1 align-middle">{tag}</span>
                       ))}
                       {item.title}
                     </h3>
                     <span className="text-[#ff5000] text-[11px] font-medium mb-1.5">{item.stats}</span>
                     
                     <div className="flex items-baseline gap-0.5 text-[#ff0036] font-bold mb-1.5">
                       <span className="text-[12px]">¥</span>
                       <span className="text-[18px] leading-none">{item.price}</span>
                     </div>
                     
                     <div className="text-zinc-500 text-[11px] flex items-center gap-0.5 mb-2">
                       {item.store} <ChevronRight className="w-3 h-3" />
                     </div>

                     <div className="flex items-center justify-between mt-auto pt-1">
                       <span className="text-zinc-500 text-[10px] whitespace-nowrap">{dir === 'rtl' ? `${item.saved} شخص حفظها` : `${item.saved} saved`}</span>
                       <div className="flex items-center gap-1.5">
                         <button className="border border-zinc-200 dark:border-zinc-700 rounded-full px-2 py-0.5 text-[10px] font-medium text-black dark:text-white whitespace-nowrap hover:bg-zinc-50 dark:hover:bg-zinc-800">
                           {dir === 'rtl' ? 'تنبيه السعر' : 'Alert'}
                         </button>
                         <button className="border border-zinc-200 dark:border-zinc-700 rounded-full px-2 py-0.5 text-[10px] font-medium text-black dark:text-white whitespace-nowrap hover:bg-zinc-50 dark:hover:bg-zinc-800">
                           {dir === 'rtl' ? 'منتجات مشابهة' : 'Similar'}
                         </button>
                       </div>
                     </div>
                   </div>
                 </div>
               ))}
             </div>
          </div>
        )}

        {/* Reviews Tab */}
        {activeTab === 'reviews' && (
          <div className="mb-6">
             {/* Sub Tabs */}
             <div className="flex items-center gap-2 mb-4 overflow-x-auto hide-scrollbar">
                {[
                  { id: 'my', label: dir === 'rtl' ? 'مراجعاتي' : 'My' },
                  { id: 'square', label: dir === 'rtl' ? 'الساحة' : 'Square' },
                  { id: 'notice', label: dir === 'rtl' ? 'اشعارات' : 'Notice' },
                  { id: 'liked', label: dir === 'rtl' ? 'اعجابات' : 'Liked' },
                ].map(sub => (
                  <div key={sub.id} className={`px-4 py-1.5 rounded-full text-[13px] font-bold cursor-pointer whitespace-nowrap ${sub.id === 'my' ? 'bg-[#ffefe6] text-[#ff5000] dark:bg-[#3a1d0f]' : 'bg-transparent text-zinc-500'}`}>
                    {sub.label}
                  </div>
                ))}
             </div>

             {/* Stats */}
             <div className="flex justify-between items-center mb-6 text-black dark:text-white px-2">
                <div className="flex flex-col items-center">
                  <span className="font-bold text-[18px] leading-tight">4704</span>
                  <span className="text-[11px] text-zinc-500 mt-0.5">{dir === 'rtl' ? 'المشاهدات' : 'Viewed'}</span>
                </div>
                <div className="flex flex-col items-center">
                  <span className="font-bold text-[18px] leading-tight">1</span>
                  <span className="text-[11px] text-zinc-500 mt-0.5 flex items-center">{dir === 'rtl' ? 'الاعجابات' : 'Liked'} <ChevronRight className={`w-3 h-3 ${dir === 'rtl' ? 'rotate-180' : ''}`} /></span>
                </div>
                <div className="flex flex-col items-center">
                  <span className="font-bold text-[18px] leading-tight">0</span>
                  <span className="text-[11px] text-zinc-500 mt-0.5 flex items-center">{dir === 'rtl' ? 'التعليقات' : 'Commented'} <ChevronRight className={`w-3 h-3 ${dir === 'rtl' ? 'rotate-180' : ''}`} /></span>
                </div>
                <div className="flex flex-col items-center">
                  <Clock className="w-5 h-5 mb-0.5" strokeWidth={1.5} />
                  <span className="text-[11px] text-zinc-500 flex items-center mt-0.5">{dir === 'rtl' ? 'السجل' : 'History'} <ChevronRight className={`w-3 h-3 ${dir === 'rtl' ? 'rotate-180' : ''}`} /></span>
                </div>
             </div>

             {/* Reviews Grid */}
             <div className="grid grid-cols-2 gap-2.5">
               {[
                  {
                    id: 1,
                    image: 'https://images.unsplash.com/photo-1620641788421-7a1c342ea42e?w=400', 
                    text: dir === 'rtl' ? 'اللون جميل، تأثير الطباعة جيد، الجودة جيدة' : 'Color looks great, good print quality, nice product',
                    user: 'l**q',
                    avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=lqq&backgroundColor=fde047`,
                    likes: 0,
                    liked: false
                  },
                  {
                    id: 2,
                    image: 'https://images.unsplash.com/photo-1581092580497-e0d23cbdf1dc?w=400',
                    text: dir === 'rtl' ? 'اللون جميل جداً، جودة الطباعة ممتازة' : 'Very beautiful color, excellent print quality',
                    user: 'l**q',
                    avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=lqq&backgroundColor=fde047`,
                    likes: 0,
                    liked: false
                  },
                  {
                    id: 3,
                    image: 'https://images.unsplash.com/photo-1593642632823-8f785ba67e45?w=400',
                    text: dir === 'rtl' ? 'جودة جيدة، سهل الاستخدام، سعر رخيص واللون جميل' : 'Good quality, easy to use, cheap price and nice color',
                    user: 'l**q',
                    avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=lqq&backgroundColor=fde047`,
                    likes: 1,
                    liked: true
                  },
                  {
                    id: 4,
                    image: 'https://images.unsplash.com/photo-1612815154858-60aa4c59eaa6?w=400',
                    text: dir === 'rtl' ? 'اللون جميل، جودة جيدة، تأثير الطباعة ممتاز' : 'Beautiful color, good quality, great printing effect',
                    user: 'l**q',
                    avatar: `https://api.dicebear.com/7.x/avataaars/svg?seed=lqq&backgroundColor=fde047`,
                    likes: 0,
                    liked: false
                  }
               ].map((review) => (
                 <div key={review.id} className="bg-white dark:bg-[#1a1a1a] rounded-[10px] overflow-hidden flex flex-col shadow-sm border border-black/5 dark:border-white/5 pb-2">
                   <div className="relative aspect-square overflow-hidden bg-zinc-100 dark:bg-zinc-800">
                     <img referrerPolicy="no-referrer" src={review.image || undefined} alt="Review" className="w-full h-full object-cover" />
                     {/* Photo count indicator */}
                     <div className="absolute bottom-1 right-1 bg-black/40 backdrop-blur-sm rounded-full px-1.5 py-0.5 flex items-center gap-1">
                        <span className="text-white text-[10px] font-bold">@ {review.id}</span>
                     </div>
                   </div>
                   <div className="p-2 flex flex-col flex-1 text-black dark:text-white">
                     <p className="text-[13px] font-medium leading-[1.4] line-clamp-3 mb-2 flex-1">{review.text}</p>
                     <div className="flex items-center justify-between mt-auto">
                        <div className="flex items-center gap-1.5">
                          <div className="w-5 h-5 rounded-full overflow-hidden bg-zinc-200">
                            <img referrerPolicy="no-referrer" src={review.avatar || undefined} alt={review.user} className="w-full h-full object-cover" />
                          </div>
                          <span className="text-[11px] text-zinc-500">{review.user}</span>
                        </div>
                        <div className="flex items-center gap-0.5 text-zinc-500 cursor-pointer">
                          <Heart className={`w-[14px] h-[14px] ${review.liked ? 'fill-[#ff5000] text-[#ff5000]' : ''}`} strokeWidth={2} />
                          {review.likes > 0 && <span className={`text-[11px] ${review.liked ? 'text-[#ff5000]' : ''}`}>{review.likes}</span>}
                        </div>
                     </div>
                   </div>
                 </div>
               ))}
             </div>
          </div>
        )}

      </div>
    </div>
  );
}
