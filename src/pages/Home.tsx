import AnimatedItem from '../components/AnimatedItem';
import React, { useState, useEffect, useRef } from 'react';
import TrueFocus from '../components/TrueFocus';
import CircularGallery from '../components/CircularGallery';
import { useLanguage } from '../LanguageContext';
import { ShoppingCart, Star, CheckCircle, ChevronRight, ChevronLeft, Pause, Play, Percent, Truck, ShoppingBag, Store, Clock, Zap } from 'lucide-react';
import { useAuth } from '../AuthContext';
import { Link, useNavigate } from 'react-router-dom';
import { queryDb } from '../lib/db';







export default function Home() {
  const navigate = useNavigate();

  const { t, dir, lang } = useLanguage();
  const { user } = useAuth();
  
  const currentPlan = user?.subscription_plan && user?.subscription_plan !== 'free' ? user.subscription_plan : (localStorage.getItem('levo_subscription') || 'free');
  const subExpirationStr = localStorage.getItem('levo_sub_expiration');
  const now = Date.now();
  const dbExpiry = user?.subscription_expiry;
  const subExpiration = dbExpiry || (subExpirationStr ? parseInt(subExpirationStr, 10) : 0);
  
  const subTier = (currentPlan !== 'free' && subExpiration > now) 
    ? currentPlan 
    : 'free';

  const [activeIndex, setActiveIndex] = useState(0);
  const [customAds, setCustomAds] = useState<{id: string, text: string, animation: string}[]>([]);

  useEffect(() => {
    const saved = localStorage.getItem('levo_home_ads');
    if (saved) {
      try {
        setCustomAds(JSON.parse(saved));
      } catch (e) {}
    }
  }, []);

  const [isAutoPlaying, setIsAutoPlaying] = useState(true);
  const touchStartX = useRef(0);
  const touchEndX = useRef(0);
  
  const [discountedProducts, setDiscountedProducts] = useState<any[]>([]);
  const [newProducts, setNewProducts] = useState<any[]>([]);

  
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const observerTarget = useRef(null);

  useEffect(() => {
    async function fetchHomeProducts() {
      try {
        const discounted = await queryDb('SELECT * FROM products WHERE original_price > base_price ORDER BY created_at DESC LIMIT 10');
        setDiscountedProducts(discounted || []);
        
        const newest = await queryDb('SELECT * FROM products ORDER BY created_at DESC LIMIT 20 OFFSET 0');
        setNewProducts(newest || []);
      } catch (err) {
        console.error('Failed to fetch home products', err);
        setDiscountedProducts([]);
        setNewProducts([]);
      }
    }
    fetchHomeProducts();
  }, []);

  const loadMore = async () => {
    if (isLoadingMore || !hasMore) return;
    setIsLoadingMore(true);
    try {
      const nextPage = page + 1;
      const offset = (nextPage - 1) * 20;
      const newest = await queryDb('SELECT * FROM products ORDER BY created_at DESC LIMIT 20 OFFSET ?', [offset]);
      if (newest && newest.length > 0) {
        setNewProducts(prev => [...prev, ...newest]);
        setPage(nextPage);
      } else {
        setHasMore(false);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoadingMore(false);
    }
  };

  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting) {
          loadMore();
        }
      },
      { threshold: 0.1 }
    );

    if (observerTarget.current) {
      observer.observe(observerTarget.current);
    }

    return () => {
      if (observerTarget.current) {
        observer.unobserve(observerTarget.current);
      }
    };
  }, [observerTarget.current, isLoadingMore, hasMore, page]);



  const renderProductCard = (p: any, widthClass = "w-[160px]") => {
    const images = Array.isArray(p.images) ? p.images : (function(){ try { return JSON.parse(p.images || '[]'); } catch(e) { return [p.images].filter(Boolean); } })();
    console.log('p.images:', p.images, 'images:', images, 'firstImage:', images[0]);
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
      <Link to={`/product/${p.slug || p.id}`} key={p.id} className={`${widthClass} shrink-0 bg-zinc-900/50/50 rounded-xl overflow-hidden flex flex-col group hover:border-olive/50 transition-colors`}>
        <div className="relative aspect-square overflow-hidden bg-black">
          <img referrerPolicy="no-referrer" src={firstImage || undefined} alt={name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
          {p.original_price > p.base_price && (
            <div className="absolute top-2 right-2 bg-rose-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
              SALE
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
  };

  const displayBanners: any[] = [];

  const nextSlide = () => {};

  const prevSlide = () => {};

  useEffect(() => {
    if (!isAutoPlaying) return;
    const interval = setInterval(nextSlide, 4000);
    return () => clearInterval(interval);
  }, [isAutoPlaying]);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.targetTouches[0].clientX;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    touchEndX.current = e.targetTouches[0].clientX;
  };

  const handleTouchEnd = () => {
    if (!touchStartX.current || !touchEndX.current) return;
    const distance = touchStartX.current - touchEndX.current;
    const isLeftSwipe = distance > 50;
    const isRightSwipe = distance < -50;
    
    if (isLeftSwipe) {
      dir === 'rtl' ? prevSlide() : nextSlide();
    } else if (isRightSwipe) {
      dir === 'rtl' ? nextSlide() : prevSlide();
    }
    
    touchStartX.current = 0;
    touchEndX.current = 0;
  };

  return (
    <div className="w-full pb-24 text-zinc-300 bg-black">
      {/* Banner Carousel */}
      <div 
        className="relative w-full h-[320px] md:h-[420px] overflow-hidden -mt-0"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <div 
          className="flex transition-transform duration-500 ease-out h-full"
          style={{ transform: `translateX(${dir === 'rtl' ? (activeIndex * 100) : -(activeIndex * 100)}%)` }}
        >
          {displayBanners.map((banner) => (
            <div key={banner.id} className={`w-full h-full flex-shrink-0 ${banner.bgColor} relative`}>
              <div className="absolute inset-0 flex items-center justify-between px-8 md:px-16 pt-[120px]">
                <div className="z-10 text-white pb-6">
                  <h2 className="text-4xl md:text-5xl font-black mb-2 tracking-tight">
                    {/* Use TrueFocus for banner title if we want, or from admin settings later */}
                    <TrueFocus sentence={banner.title} blurAmount={2} borderColor="#6B46FF" glowColor="rgba(107, 70, 255, 0.6)" animationDuration={0.8} pauseBetweenAnimations={0.5} />
                  </h2>
                  <div className="flex items-center gap-2 text-lg md:text-xl font-medium">
                    <span>{banner.subtitle}</span>
                    <div className="bg-white rounded-full p-0.5 text-black">
                      {dir === 'rtl' ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </div>
                  </div>
                </div>
                <img referrerPolicy="no-referrer" src={banner.image || undefined} alt={banner.title} className="w-32 h-32 md:w-48 md:h-48 object-cover rounded-[32px] mix-blend-luminosity opacity-80 z-0 shadow-2xl" />
              </div>
            </div>
          ))}
        </div>
        
        {/* Controls overlay */}
        <div className="absolute bottom-[40px] left-0 right-0 flex items-center justify-between px-6 z-20">
          <div className="flex-1"></div>
          
          {/* Pagination Dots */}
          <div className="flex items-center gap-1.5 bg-white px-3 py-1.5 rounded-full shadow-md">
            {displayBanners.map((_, idx) => (
              <button 
                key={idx} 
                onClick={() => setActiveIndex(idx)}
                className={`rounded-full transition-all ${activeIndex === idx ? 'w-5 h-1.5 bg-zinc-800' : 'w-1.5 h-1.5 bg-zinc-300 hover:bg-zinc-400'}`}
              />
            ))}
          </div>
          
          {/* Play/Pause */}
          <div className="flex-1 flex justify-end">
            <button 
              onClick={() => setIsAutoPlaying(!isAutoPlaying)}
              className="w-9 h-9 rounded-full bg-white text-black flex items-center justify-center hover:bg-zinc-200 transition-colors shadow-lg"
            >
              {isAutoPlaying ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current ml-0.5" />}
            </button>
          </div>
        </div>
      </div>

      <div className="relative z-30 max-w-7xl mx-auto px-4 sm:px-10 py-12 bg-black rounded-t-[36px] -mt-10">
        


        {/* Discounted Products - Horizontal Scroll */}
        {discountedProducts.length > 0 && (
          <div className="mb-12">
            <div className="flex items-center justify-between gap-3 mb-6">
              <div className="flex items-center gap-3">
                <div className="w-1 h-6 bg-rose-500 rounded-full"></div>
                <h2 className="text-xl md:text-2xl font-bold text-white">
                  Discounted Products
                </h2>
              </div>
              <button onClick={() => navigate('/products')} className="text-zinc-400 hover:text-white transition-colors flex items-center gap-1 text-sm bg-zinc-900/80 px-3 py-1.5 rounded-full">
                <span>more</span>
                {dir === 'rtl' ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </button>
            </div>
            
            <div className="flex gap-4 overflow-x-auto hide-scrollbar pb-4 -mx-4 px-4 sm:mx-0 sm:px-0 snap-x">
              {discountedProducts.map((p, index) => (
                <AnimatedItem key={p.id} index={index} className="snap-start shrink-0">
                  {renderProductCard(p, "w-[180px] md:w-[200px]")}
                </AnimatedItem>
              ))}
            </div>
          </div>
        )}

        {/* Try Something New - Vertical Infinite Grid */}
        {newProducts.length > 0 && (
          <div className="mb-12">
            <div className="flex items-center justify-between gap-3 mb-6">
              <div className="flex items-center gap-3">
                <div className="w-1 h-6 bg-olive rounded-full"></div>
                <h2 className="text-xl md:text-2xl font-bold text-white">
                  Try something new
                </h2>
              </div>
              <button onClick={() => navigate('/products')} className="w-8 h-8 rounded-full bg-zinc-900 flex items-center justify-center hover:bg-zinc-800 transition-colors">
                {dir === 'rtl' ? <ChevronLeft className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
              </button>
            </div>
            
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
              {newProducts.map((p, index) => (<AnimatedItem key={p.id} index={index}>{renderProductCard(p, "w-full")}</AnimatedItem>))}
            </div>
            {hasMore && (
              <div ref={observerTarget} className="w-full h-20 flex items-center justify-center mt-4">
                <div className="w-6 h-6 border-2 border-olive border-t-transparent rounded-full animate-spin"></div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
