import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { queryDb } from '../lib/db';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { ArrowRight, ArrowLeft, ShoppingCart, Star, Check, Share2, Heart, Clock, Package, ChevronUp, ChevronDown, Repeat, MessageSquare, ThumbsUp, Flag, Minus, Plus, Trash2, X, MoreHorizontal, Info, FileText, Image as ImageIcon, PlayCircle, Settings2 } from 'lucide-react';

export default function Product() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const { t, lang, dir } = useLanguage();
  const { user } = useAuth();
  
  const [product, setProduct] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  
  // Accordion states
  const [shippingOpen, setShippingOpen] = useState(true);
  const [optionsOpen, setOptionsOpen] = useState(true);
  const [colorsOpen, setColorsOpen] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [specsOpen, setSpecsOpen] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [selectedOption, setSelectedOption] = useState<'full' | 'refill'>('full');
  
  const [quantity, setQuantity] = useState(1);
  const [cartModalOpen, setCartModalOpen] = useState(false);
  const [orderType, setOrderType] = useState<'pre_order' | 'direct'>('direct');

  const [cartCount, setCartCount] = useState(0);
  const [isAnimatingCart, setIsAnimatingCart] = useState(false);
  const [flyingItems, setFlyingItems] = useState<{id: number, startX: number, startY: number, endX: number, endY: number, image: string}[]>([]);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        if (slug && slug.startsWith('merchant-')) {
          setProduct({
            id: slug,
            slug: slug,
            name: 'Custom 3D Print / Design Asset',
            name_ar: 'منتج طباعة ثلاثية الأبعاد مخصص',
            description: 'This is a premium product offered by the merchant. Includes high quality materials and custom manufacturing options.',
            description_ar: 'هذا منتج مميز يقدمه التاجر. يشمل مواد عالية الجودة وخيارات تصنيع مخصصة.',
            base_price: 35.00,
            images: JSON.stringify([
              'https://images.unsplash.com/photo-1629236715082-f5dc817293e6?w=800',
              'https://images.unsplash.com/photo-1631427962232-803d4f30c64f?w=800'
            ]),
            category_id: 1,
            seller_id: 1,
            is_active: 1
          });
          return;
        }

        let res = await queryDb('SELECT * FROM products WHERE slug = ?', [slug]);
        if (!res || res.length === 0) {
          res = await queryDb('SELECT * FROM community_products WHERE slug = ?', [slug]);
        }
        if (res && res.length > 0) {
          setProduct(res[0]);
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    if (slug) load();
  }, [slug]);

  useEffect(() => {
    if (cartModalOpen) {
      document.body.style.overflow = 'hidden';
      document.documentElement.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
      document.documentElement.style.overflow = 'unset';
    }
    return () => {
      document.body.style.overflow = 'unset';
      document.documentElement.style.overflow = 'unset';
    };
  }, [cartModalOpen]);

  if (loading) return <div className="p-8 text-center text-zinc-500">Loading...</div>;
  if (!product) return <div className="p-8 text-center text-zinc-500">Product not found.</div>;

  const images = JSON.parse(product.images || '[]');
  const firstImage = images[0] || 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800';
  const name = lang === 'ar' && product.name_ar ? product.name_ar : product.name;
  const description = lang === 'ar' && product.description_ar ? product.description_ar : product.description;

  let proPrice = null;
  if (product && product.membership_prices) {
    try {
      const parsed = typeof product.membership_prices === 'string' ? JSON.parse(product.membership_prices) : product.membership_prices;
      if (parsed.pro) proPrice = parsed.pro;
    } catch (e) {}
  }
  
  const isPro = user?.subscription_plan === 'pro';
  const displayPrice = isPro && proPrice ? proPrice : product.base_price;
  let productColors: any[] = [];
  try {
    if (product && product.colors) {
      productColors = typeof product.colors === 'string' ? JSON.parse(product.colors) : product.colors;
    }
  } catch (e) {
    console.error('Failed to parse colors', e);
  }


  const handleAddToCart = (e: React.MouseEvent) => {
    const btn = e.currentTarget.getBoundingClientRect();
    const cartBtn = document.getElementById('cart-icon-btn')?.getBoundingClientRect();
    
    // Fallback coordinates if cartBtn is not found
    const endX = cartBtn ? cartBtn.left + cartBtn.width / 2 : 40;
    const endY = cartBtn ? cartBtn.top + cartBtn.height / 2 : window.innerHeight - 40;
    
    const startX = btn.left + btn.width / 2;
    const startY = btn.top + btn.height / 2;
    
    const id = Date.now();
    setFlyingItems(prev => [...prev, { id, startX, startY, endX, endY, image: firstImage }]);
    
    setTimeout(() => {
      setFlyingItems(prev => prev.filter(item => item.id !== id));
      setCartCount(c => c + quantity);
      setIsAnimatingCart(true);
      setTimeout(() => setIsAnimatingCart(false), 300);
    }, 800);
  };

  return (
    <div className="w-full min-h-[100dvh] bg-black text-zinc-300 font-sans" dir={dir}>
      <div className={`fixed top-0 inset-x-0 z-50 bg-black/90 backdrop-blur-xl px-4 py-3 flex items-center justify-between transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] ${
        cartModalOpen ? '-translate-y-[400px]' : 'translate-y-0'
      }`} dir={dir}>
        <button onClick={() => navigate(-1)} className="p-2 bg-zinc-900/50 rounded-full hover:bg-zinc-800/50 transition-colors">
          {dir === 'rtl' ? <ArrowRight className="w-5 h-5 text-white" /> : <ArrowLeft className="w-5 h-5 text-white" />}
        </button>
      </div>

      <div 
        className={`w-full pt-[60px] pb-[84px] min-h-[100dvh] text-zinc-300 font-sans transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] ${
          cartModalOpen ? '-translate-y-[400px] pointer-events-none' : 'translate-y-0'
        }`}
        dir={dir}
      >
        <div className="w-full h-80 bg-zinc-900 relative rounded-b-3xl overflow-hidden flex items-center justify-center">
        <img src={firstImage || undefined} alt={name} className="max-w-full max-h-full object-contain p-4" />
      </div>

      <div className="px-4 py-5">
        <div className="flex justify-between items-center mb-2">
          <div className="flex items-center gap-2">
            <button className="w-10 h-10 rounded-full bg-zinc-900/80 flex items-center justify-center text-zinc-300 hover:text-white hover:bg-zinc-800 transition-colors">
              <Share2 className="w-5 h-5" />
            </button>
            <button className="w-10 h-10 rounded-full bg-zinc-900/80 flex items-center justify-center text-zinc-300 hover:text-white hover:bg-zinc-800 transition-colors">
              <Heart className="w-5 h-5" />
            </button>
          </div>
          <span className="border border-zinc-600 rounded-full px-3 py-0.5 text-xs text-zinc-300">
            PLA
          </span>
        </div>
        
        <h1 className="text-2xl font-bold text-white mb-3 text-right">{name}</h1>
        
        <div className="flex justify-end mb-4">
          <span className="bg-[#b59045]/20 text-[#b59045] px-3 py-1 rounded-full text-xs font-medium flex items-center gap-1">
             292 قطعة مباعة 🔥
          </span>
        </div>

        <p className="text-sm text-zinc-400 leading-relaxed text-right mb-6">
          التعبئة تتوفر فقط للألوان الأساسية مثل: أسود، أبيض، رمادي، فضي، أحمر، أزرق، أزرق داكن، أخضر، أصفر، برتقالي، بني، وردي
        </p>

        <div className="flex flex-col mb-6 gap-3">
          {isPro ? (
             <div className="bg-gradient-to-r from-gold/20 to-gold/5 border border-gold/30 rounded-2xl p-4 flex flex-col gap-2 relative overflow-hidden">
                <div className="absolute -right-4 -top-4 w-16 h-16 bg-gold/20 blur-2xl rounded-full"></div>
                <div className="flex justify-between items-center w-full relative z-10">
                  <span className="text-gold font-black text-3xl flex items-center gap-2 drop-shadow-[0_0_8px_rgba(186,163,105,0.4)]">
                    {(proPrice || product.base_price).toLocaleString()} د.ع
                  </span>
                  <span className="bg-gradient-to-r from-gold to-gold-light text-black px-3 py-1.5 rounded-lg text-xs font-black uppercase tracking-widest shadow-lg flex items-center gap-1.5">
                    <Star className="w-3.5 h-3.5 fill-black" />
                    عضوية PRO
                  </span>
                </div>
                <span className="text-zinc-400 font-medium text-sm line-through relative z-10">
                  {(product.base_price).toLocaleString()} د.ع (السعر العادي)
                </span>
             </div>
          ) : (
             <div className="flex flex-col gap-3">
                <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-2xl p-4 flex justify-between items-center w-full">
                  <span className="text-white font-bold text-2xl">{(product.base_price).toLocaleString()} د.ع</span>
                  <span className="bg-zinc-800 text-zinc-400 px-3 py-1 rounded-lg text-xs font-bold uppercase tracking-wider">السعر العادي</span>
                </div>
                {proPrice && (
                  <button 
                    onClick={() => navigate('/subscription')}
                    className="flex justify-between items-center w-full mt-1 group"
                  >
                    <span className="text-zinc-500 font-medium text-sm flex items-center gap-1.5 group-hover:text-gold transition-colors">
                      <Star className="w-3.5 h-3.5 text-zinc-500 group-hover:text-gold transition-colors" />
                      {(proPrice).toLocaleString()} د.ع (لأعضاء PRO)
                    </span>
                    <span className="text-zinc-600 text-xs font-bold opacity-80 group-hover:opacity-100 group-hover:text-gold transition-colors">اشترك الآن</span>
                  </button>
                )}
             </div>
          )}
        </div>

        {/* Order Types */}
        <div className="flex gap-3 mb-6">
          <button 
            onClick={() => setOrderType('pre_order')}
            className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl border transition-colors ${orderType === 'pre_order' ? 'bg-[#b59045] text-black border-[#b59045] font-bold' : 'bg-zinc-900/50 text-zinc-300 border-zinc-800/50 font-medium'}`}
          >
            <span>طلب مسبق</span>
            <Clock className="w-4 h-4" />
          </button>
          <button 
            onClick={() => setOrderType('direct')}
            className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl border transition-colors ${orderType === 'direct' ? 'bg-[#b59045] text-black border-[#b59045] font-bold' : 'bg-zinc-900/50 text-zinc-300 border-zinc-800/50 font-medium'}`}
          >
            <span>مباشر</span>
            <Package className="w-4 h-4" />
          </button>
        </div>

        {/* Shipping Type - Only for Pre-Order */}
        {orderType === 'pre_order' && (
          <div className="border border-zinc-800/50 rounded-xl bg-zinc-900/50 mb-4 overflow-hidden">
            <button 
              className="w-full p-4 flex justify-between items-center text-white font-bold"
              onClick={() => setShippingOpen(!shippingOpen)}
            >
              <div className="flex items-center gap-2">
                <Package className="w-5 h-5 text-zinc-400" />
                <span>نوع الشحن</span>
              </div>
              {shippingOpen ? <ChevronUp className="w-5 h-5 text-zinc-400" /> : <ChevronDown className="w-5 h-5 text-zinc-400" />}
            </button>
            {shippingOpen && (
              <div className="px-4 pb-4">
                <div className="flex justify-between items-center border border-zinc-700/50 rounded-lg p-3">
                   <div className="bg-zinc-800/50 text-white px-3 py-1 rounded-full text-xs">مجاني</div>
                   <div className="flex items-center gap-3">
                     <div className="text-right">
                       <div className="text-white font-bold text-sm">اقتصادي</div>
                       <div className="text-zinc-500 text-xs">توصيل خلال 45-55 يوم</div>
                     </div>
                     <div className="w-5 h-5 rounded-full bg-[#b59045] flex items-center justify-center">
                       <Check className="w-3 h-3 text-black" />
                     </div>
                   </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Available Options */}
        <div className="border border-zinc-800/50 rounded-xl bg-zinc-900/50 mb-4 overflow-hidden">
          <button 
            className="w-full p-4 flex justify-between items-center text-white font-bold"
            onClick={() => setOptionsOpen(!optionsOpen)}
          >
            <div className="flex items-center gap-2">
              <Package className="w-5 h-5 text-zinc-400" />
              <span>الخيارات المتاحة</span>
            </div>
            {optionsOpen ? <ChevronUp className="w-5 h-5 text-zinc-400" /> : <ChevronDown className="w-5 h-5 text-zinc-400" />}
          </button>
          {optionsOpen && (
            <div className="px-4 pb-4 flex flex-col gap-2">
              <div 
                className={`flex justify-between items-center border rounded-lg p-3 cursor-pointer transition-colors ${selectedOption === 'full' ? 'border-[#b59045] bg-[#b59045]/10' : 'border-zinc-700/50 hover:bg-zinc-800/50'}`}
                onClick={() => setSelectedOption('full')}
              >
                 <div className={`text-xs ${selectedOption === 'full' ? 'text-[#b59045] font-bold' : 'text-zinc-400'}`}>12,320 د.ع</div>
                 <div className="flex items-center gap-3">
                   <span className={`text-sm ${selectedOption === 'full' ? 'text-[#b59045] font-bold' : 'text-white'}`}>بكرة كاملة</span>
                   <div className={`w-5 h-5 rounded-full flex items-center justify-center transition-colors ${selectedOption === 'full' ? 'bg-[#b59045]' : 'border border-zinc-600'}`}>
                     {selectedOption === 'full' && <Check className="w-3 h-3 text-black" />}
                   </div>
                 </div>
              </div>
              <div 
                className={`flex justify-between items-center border rounded-lg p-3 cursor-pointer transition-colors ${selectedOption === 'refill' ? 'border-[#b59045] bg-[#b59045]/10' : 'border-zinc-700/50 hover:bg-zinc-800/50'}`}
                onClick={() => setSelectedOption('refill')}
              >
                 <div></div>
                 <div className="flex items-center gap-3">
                   <span className={`text-sm ${selectedOption === 'refill' ? 'text-[#b59045] font-bold' : 'text-white'}`}>تعبئة بدون روله</span>
                   <div className={`w-5 h-5 rounded-full flex items-center justify-center transition-colors ${selectedOption === 'refill' ? 'bg-[#b59045]' : 'border border-zinc-600'}`}>
                     {selectedOption === 'refill' && <Check className="w-3 h-3 text-black" />}
                   </div>
                 </div>
              </div>
            </div>
          )}
        </div>

        {/* Colors */}
        <div className="border border-zinc-800/50 rounded-xl bg-zinc-900/50 mb-6 overflow-hidden">
          <button 
            className="w-full p-4 flex justify-between items-center text-white font-bold"
            onClick={() => setColorsOpen(!colorsOpen)}
          >
            <div className="flex items-center gap-2">
              <div className="w-5 h-5 rounded-full border border-zinc-400 flex items-center justify-center">
                <div className="w-3 h-3 rounded-full bg-red-500"></div>
              </div>
              <span>الألوان المتاحة</span>
            </div>
            {colorsOpen ? <ChevronUp className="w-5 h-5 text-zinc-400" /> : <ChevronDown className="w-5 h-5 text-zinc-400" />}
          </button>
          {colorsOpen && (
            <div className="px-4 pb-4">
              <div className="flex flex-wrap justify-end gap-x-2 gap-y-4">
                {productColors.map((c, i) => (
                  <div key={i} className="flex flex-col items-center justify-center w-[48px] h-[64px] bg-zinc-800/50 rounded-lg border border-zinc-700/30 p-1">
                    <div className="w-6 h-6 rounded-full border border-zinc-600 mb-1" style={{ backgroundColor: c.hex }}></div>
                    <span className="text-[9px] text-center text-zinc-300 leading-tight w-full break-words truncate px-0.5">{c.name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Product Details Section */}
        <div className="border border-zinc-800/50 rounded-xl bg-zinc-900/50 mb-4 overflow-hidden">
          <button 
            className="w-full p-4 flex justify-between items-center text-white font-bold"
            onClick={() => setDetailsOpen(!detailsOpen)}
          >
            <div className="flex items-center gap-2 flex-row-reverse">
              <FileText className="w-5 h-5 text-zinc-400" />
              <span>وصف المنتج</span>
            </div>
            {detailsOpen ? <ChevronUp className="w-5 h-5 text-zinc-400" /> : <ChevronDown className="w-5 h-5 text-zinc-400" />}
          </button>
          {detailsOpen && (
            <div className="px-4 pb-4 text-sm text-zinc-400 text-right leading-relaxed">
              <p className="mb-2">هذا المنتج مصنوع بدقة باستخدام أحدث تقنيات الطباعة ثلاثية الأبعاد. يتميز بجودة عالية وتفاصيل دقيقة تلبي جميع احتياجاتك.</p>
              <p>نستخدم أفضل أنواع مواد الطباعة (PLA, PETG, Resin) لضمان المتانة والصلابة المثالية للمنتج النهائي.</p>
            </div>
          )}
        </div>

        {/* Product Specs Section */}
        <div className="border border-zinc-800/50 rounded-xl bg-zinc-900/50 mb-4 overflow-hidden">
          <button 
            className="w-full p-4 flex justify-between items-center text-white font-bold"
            onClick={() => setSpecsOpen(!specsOpen)}
          >
            <div className="flex items-center gap-2 flex-row-reverse">
              <Settings2 className="w-5 h-5 text-zinc-400" />
              <span>المواصفات التقنية</span>
            </div>
            {specsOpen ? <ChevronUp className="w-5 h-5 text-zinc-400" /> : <ChevronDown className="w-5 h-5 text-zinc-400" />}
          </button>
          {specsOpen && (
            <div className="px-4 pb-4">
              <div className="flex flex-col gap-2 text-sm text-right">
                <div className="flex justify-between border-b border-zinc-800 pb-2">
                   <span className="text-white">PLA / Resin</span>
                   <span className="text-zinc-500">المادة</span>
                </div>
                <div className="flex justify-between border-b border-zinc-800 pb-2">
                   <span className="text-white">0.1mm - 0.2mm</span>
                   <span className="text-zinc-500">دقة الطباعة</span>
                </div>
                <div className="flex justify-between border-b border-zinc-800 pb-2">
                   <span className="text-white">20% - 100%</span>
                   <span className="text-zinc-500">كثافة الحشو (Infill)</span>
                </div>
                <div className="flex justify-between pb-2">
                   <span className="text-white">15cm x 15cm x 20cm</span>
                   <span className="text-zinc-500">الأبعاد القصوى</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Media & Gallery Section */}
        <div className="border border-zinc-800/50 rounded-xl bg-zinc-900/50 mb-6 overflow-hidden">
          <button 
            className="w-full p-4 flex justify-between items-center text-white font-bold"
            onClick={() => setMediaOpen(!mediaOpen)}
          >
            <div className="flex items-center gap-2 flex-row-reverse">
              <ImageIcon className="w-5 h-5 text-zinc-400" />
              <span>الصور والفيديو</span>
            </div>
            {mediaOpen ? <ChevronUp className="w-5 h-5 text-zinc-400" /> : <ChevronDown className="w-5 h-5 text-zinc-400" />}
          </button>
          {mediaOpen && (
            <div className="px-4 pb-4">
               <div className="grid grid-cols-2 gap-2 mb-3">
                  <div className="aspect-square rounded-lg overflow-hidden bg-zinc-800 border border-zinc-700/50">
                    <img src="https://images.unsplash.com/photo-1629236715082-f5dc817293e6?w=400" alt="Detail 1" className="w-full h-full object-cover" />
                  </div>
                  <div className="aspect-square rounded-lg overflow-hidden bg-zinc-800 border border-zinc-700/50 relative">
                    <img src="https://images.unsplash.com/photo-1631427962232-803d4f30c64f?w=400" alt="Video thumbnail" className="w-full h-full object-cover opacity-70" />
                    <div className="absolute inset-0 flex items-center justify-center">
                       <PlayCircle className="w-8 h-8 text-white drop-shadow-md" />
                    </div>
                  </div>
               </div>
               <div className="aspect-video rounded-lg overflow-hidden bg-zinc-800 border border-zinc-700/50 relative w-full flex items-center justify-center">
                  <img src="https://images.unsplash.com/photo-1615820468979-3733c707d0f1?w=800" alt="Process" className="w-full h-full object-cover opacity-60" />
                  <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                     <PlayCircle className="w-12 h-12 text-white drop-shadow-lg hover:scale-110 transition-transform cursor-pointer" />
                  </div>
                  <div className="absolute bottom-2 right-2 bg-black/60 px-2 py-1 rounded text-xs text-white">01:45</div>
               </div>
            </div>
          )}
        </div>

        {/* Exchange Banner */}
        <div className="bg-zinc-800/50/50 border border-olive/20 rounded-xl p-4 flex items-center justify-between mb-8 cursor-pointer hover:bg-zinc-800/50 transition-colors">
          <div className="text-right flex-1">
             <div className="text-green-500 font-bold text-sm mb-1">استبدل طابعتك القديمة واحصل على خصم</div>
             <div className="text-zinc-400 text-xs">قدم طابعتك القديمة للتقييم واحصل على كوبون خصم على شراء هذه الطابعة الجديدة</div>
          </div>
          <div className="ml-3 w-10 h-10 rounded-full bg-olive/20 flex items-center justify-center">
            <Repeat className="w-5 h-5 text-green-500" />
          </div>
        </div>

        {/* Reviews Section */}
        <div className="mb-4">
          <div className="flex items-center justify-end gap-2 mb-4">
             <span className="bg-zinc-800/50 text-zinc-400 px-2 py-1 rounded-full text-[10px]">+20</span>
             <h2 className="text-white font-bold flex items-center gap-2">
               التقييمات والمراجعات <MessageSquare className="w-5 h-5 text-zinc-400" />
             </h2>
          </div>
          
          {/* Rating Summary */}
          <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-6 mb-4">
            <div className="flex gap-4 flex-row-reverse items-center justify-between">
               <div className="flex flex-col items-end">
                 <div className="flex items-center gap-1 mb-1">
                   {[1,2,3,4,5].map(s => <Star key={s} className="w-4 h-4 text-[#b59045] fill-[#b59045]" />)}
                 </div>
                 <span className="text-zinc-400 text-xs">37 تقييم</span>
               </div>
               
               <div className="flex-1 flex flex-col gap-1">
                 {[5,4,3,2,1].map(star => (
                   <div key={star} className="flex items-center gap-2 flex-row-reverse text-xs text-zinc-400">
                     <div className="w-4 flex justify-center">{star} <Star className="w-3 h-3 ml-1" /></div>
                     <div className="flex-1 h-1.5 bg-zinc-800/50 rounded-full overflow-hidden">
                       <div className="h-full bg-[#b59045]" style={{ width: star === 5 ? '90%' : '0%' }}></div>
                     </div>
                     <div className="w-4 text-left">{star === 5 ? '37' : '0'}</div>
                   </div>
                 ))}
               </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <span className="bg-zinc-800/50 text-white px-3 py-1 rounded-full text-xs">توصيل سريع (2)</span>
              <span className="bg-zinc-800/50 text-white px-3 py-1 rounded-full text-xs">جودة ممتازة (4)</span>
            </div>
          </div>

          {/* Customer Photos */}
          <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4 mb-4">
             <div className="flex justify-between items-center mb-4">
                <span className="text-white text-sm font-bold flex items-center gap-2 flex-row-reverse">
                   معرض صور المشترين (1) <Package className="w-4 h-4 text-zinc-400" />
                </span>
             </div>
             <div className="flex justify-end">
                <img src={firstImage || undefined} className="w-16 h-16 rounded-lg object-cover" />
             </div>
          </div>

          {/* Reviews Filters */}
          <div className="flex justify-between items-center mb-4 flex-row-reverse overflow-x-auto pb-2 no-scrollbar">
             <div className="flex gap-2 flex-row-reverse shrink-0">
               <button className="bg-[#b59045] text-black px-4 py-1.5 rounded-full text-sm font-bold">الكل (37)</button>
               <button className="bg-zinc-900/50 border border-zinc-800/50 text-zinc-300 px-4 py-1.5 rounded-full text-sm">صور/فيديو (1)</button>
               <button className="bg-zinc-900/50 border border-zinc-800/50 text-zinc-300 px-4 py-1.5 rounded-full text-sm">إيجابي (37)</button>
               <button className="bg-zinc-900/50 border border-zinc-800/50 text-zinc-300 px-4 py-1.5 rounded-full text-sm">محايد (0)</button>
               <button className="bg-zinc-900/50 border border-zinc-800/50 text-zinc-300 px-4 py-1.5 rounded-full text-sm">سلبي (0)</button>
             </div>
          </div>

          {/* Review Items */}
          <div className="flex flex-col gap-4">
             {[1, 2].map((review, idx) => (
                <div key={idx} className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-4 text-right relative">
                   <div className="flex justify-between items-start mb-3">
                      <div className="flex gap-3 flex-row-reverse items-center">
                         <div className="w-10 h-10 rounded-full bg-[#b59045] flex items-center justify-center text-black font-bold">A</div>
                         <div>
                            <div className="text-white font-bold text-sm mb-1">User {idx + 1}</div>
                            <div className="flex items-center gap-2 flex-row-reverse">
                              <div className="flex items-center">
                                {[1,2,3,4,5].map(s => <Star key={s} className="w-3 h-3 text-[#b59045] fill-[#b59045]" />)}
                              </div>
                              <span className="text-zinc-500 text-xs">منذ 4 أشهر</span>
                            </div>
                         </div>
                      </div>
                      <div className="text-red-500/70 p-1 bg-red-500/10 rounded-lg">
                        <Flag className="w-4 h-4" />
                      </div>
                   </div>
                   <p className="text-zinc-300 text-sm mb-3">
                     {idx === 0 ? 'تعامل راقي وفلمنت جيد' : 'ورد أكثر من 22 فلمنت طلبت ممتاز'}
                   </p>
                   <div className="flex justify-end mb-4">
                     <span className="bg-zinc-800/50 text-zinc-400 text-xs px-2 py-1 rounded flex items-center gap-1 flex-row-reverse">
                        <Repeat className="w-3 h-3" /> تم إعادة الطلب {idx === 0 ? '4' : '2'} من المرات
                     </span>
                   </div>
                   <div className="border-t border-zinc-800/50 pt-3 flex items-center justify-between flex-row-reverse text-sm text-zinc-400">
                      <div className="flex items-center gap-4 flex-row-reverse">
                         <button className="flex items-center gap-1 flex-row-reverse hover:text-white"><ThumbsUp className="w-4 h-4" /> مفيد ({idx === 0 ? '2' : '1'})</button>
                         <button className="flex items-center gap-1 flex-row-reverse hover:text-white"><Share2 className="w-4 h-4" /> مشاركة</button>
                         <button className="flex items-center gap-1 flex-row-reverse hover:text-white"><Flag className="w-4 h-4" /> إبلاغ</button>
                      </div>
                   </div>
                </div>
             ))}
          </div>
        </div>
      </div>
      </div>
      {cartModalOpen && (
        <div 
          className="fixed inset-0 z-[115] touch-none" 
          onClick={() => setCartModalOpen(false)}
        ></div>
      )}

      {/* Integrated Bottom Bar and Cart Modal */}
      <div 
        className="fixed inset-x-0 bottom-0 z-[120] mx-auto w-full sm:max-w-[440px] flex flex-col transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] rounded-t-[32px] bg-[#0F0F0F]"
        style={{ transform: cartModalOpen ? 'translateY(0)' : 'translateY(calc(100% - 84px))' }}
      >
        {/* Sticky Bar (Always visible) */}
        <div 
          className="bg-black flex items-center justify-between mx-auto shrink-0 z-10 rounded-t-[32px] p-3 pb-4 h-[84px] w-full shadow-[0_-10px_40px_rgba(0,0,0,0.5)]"
          dir="ltr"
        >
          <div className={`transition-all duration-300 shrink-0 ${cartCount > 0 || flyingItems.length > 0 ? 'w-[48px] opacity-100 ml-1' : 'w-0 opacity-0 pointer-events-none'}`}>
            <button 
               id="cart-icon-btn"
               onClick={() => setCartModalOpen(true)}
               className={`w-[48px] h-[48px] relative rounded-full border border-zinc-700/80 flex items-center justify-center text-zinc-300 shrink-0 hover:bg-zinc-800 transition-all ${isAnimatingCart ? 'scale-110 bg-zinc-800 text-gold' : 'scale-100'}`}
            >
              <ShoppingCart className="w-5 h-5" />
              {cartCount > 0 && (
                <span className="absolute -top-1 -right-1 bg-gold text-black text-[10px] font-bold w-4 h-4 flex items-center justify-center rounded-full">
                  {cartCount}
                </span>
              )}
            </button>
          </div>

          <div 
            className="flex-1 flex flex-col justify-center items-center cursor-pointer px-2"
            onClick={handleAddToCart}
          >
             <span className="text-white font-bold text-[14px] mb-0.5">أضف للسلة</span>
             <span className="text-[#d4a849] font-bold text-[13px] tracking-tight">{(displayPrice * quantity).toLocaleString()} د.ع</span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0 mr-1">
            <div className="flex items-center gap-2 bg-[#1A1A1C] rounded-full p-1 pl-4 h-[48px]">
              <button onClick={() => setQuantity(q => Math.max(1, q - 1))} className="flex items-center justify-center text-zinc-400 hover:text-white transition-colors">
                <Minus className="w-[18px] h-[18px]" />
              </button>
              <span className="text-white font-bold text-[15px] min-w-[24px] text-center">{quantity}</span>
              <button onClick={() => setQuantity(q => q + 1)} className="w-[40px] h-[40px] bg-[#d4a849] rounded-full flex items-center justify-center text-black hover:brightness-110 transition-all">
                <Plus className="w-[20px] h-[20px]" />
              </button>
            </div>
          </div>
        </div>

        {/* Modal Content */}
        <div className="w-full flex flex-col justify-between pt-2 pb-2 transition-all duration-500 z-0 h-[400px]">
          <div className="bg-[#1C1C1E] rounded-[24px] p-4 mx-4 mb-4 relative flex flex-col shadow-xl shrink-0">
            {/* Store Info */}
            <div className="flex items-center gap-3 mb-4 shrink-0" dir="ltr">
              <div className="w-10 h-10 bg-[#8E8E93] rounded-[10px] flex items-center justify-center shrink-0">
                 <span className="text-white font-bold text-xs tracking-tight">rhode</span>
              </div>
              <div className="flex flex-col">
                 <span className="text-white font-medium text-sm">rhode</span>
                 <span className="text-zinc-400 text-xs font-medium">4.7 <Star className="inline w-3 h-3 text-white fill-white mb-0.5" /> (161.5K)</span>
              </div>
            </div>
            
            {/* Product Info */}
            <div className="flex gap-4 mb-4 shrink-0" dir="ltr">
              <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-[12px] bg-white flex items-center justify-center shrink-0 p-2">
                 <img src={firstImage || undefined} className="max-w-full max-h-full object-contain" />
              </div>
              <div className="flex flex-col flex-1 justify-center py-1">
                <div className="flex justify-between items-start gap-2 mb-2">
                   <h3 className="text-white text-sm font-medium line-clamp-2 leading-snug">{name}</h3>
                   <span className="text-white whitespace-nowrap text-sm font-bold text-[#b59045]">{displayPrice.toLocaleString()} د.ع</span>
                </div>
                
                <div className="flex justify-between items-center">
                   <div className="flex items-center bg-[#0F0F0F] rounded-[8px] h-8 overflow-hidden">
                      <button 
                         onClick={() => setQuantity(q => Math.max(1, q - 1))} 
                         className="w-8 h-full flex items-center justify-center text-white hover:bg-zinc-800 transition-colors"
                      >
                         {quantity === 1 ? <Trash2 className="w-3.5 h-3.5" /> : <Minus className="w-3.5 h-3.5" />}
                      </button>
                      <span className="w-6 text-center text-white font-bold text-xs">{quantity}</span>
                      <button 
                         onClick={() => setQuantity(q => q + 1)} 
                         className="w-8 h-full flex items-center justify-center text-white hover:bg-zinc-800 transition-colors"
                      >
                         <Plus className="w-3.5 h-3.5" />
                      </button>
                   </div>
                   <button className="w-8 h-8 rounded-[8px] bg-[#0F0F0F] flex items-center justify-center text-white hover:bg-zinc-800 transition-colors">
                      <MoreHorizontal className="w-4 h-4" />
                   </button>
                </div>
              </div>
            </div>
            
            {/* Progress Bar */}
            <div className="mb-3 shrink-0" dir="ltr">
               <div className="flex justify-between text-xs mb-2">
                  <span className="text-white font-medium">Add $27.00 for free shipping</span>
                  <span className="text-white font-bold cursor-pointer">Add items</span>
               </div>
               <div className="w-full h-1 bg-[#3A3A3C] rounded-full overflow-hidden">
                  <div className="h-full bg-white w-[30%] rounded-full"></div>
               </div>
            </div>
            
            {/* Subtotal */}
            <div className="flex justify-between items-center mb-4 text-white text-sm font-medium shrink-0" dir="ltr">
               <span>Subtotal</span>
               <span className="text-[#b59045]">{(displayPrice * quantity).toLocaleString()} د.ع</span>
            </div>
            
            {/* Checkout Button */}
            <button 
               onClick={() => { setCartModalOpen(false); navigate('/cart'); }} 
               className="w-full py-3.5 rounded-[12px] bg-[#5833FF] text-white font-bold text-sm hover:bg-[#4B29C9] transition-all text-center shrink-0"
            >
               Continue to checkout
            </button>
          </div>
          
          {/* Bottom Close Button */}
          <div className="pb-2 flex justify-center items-center shrink-0">
             <button 
                onClick={() => setCartModalOpen(false)}
                className="w-10 h-10 rounded-full bg-[#2C2C2E] flex items-center justify-center text-zinc-400 hover:text-white transition-colors"
             >
                <X className="w-5 h-5" />
             </button>
          </div>
        </div>
      </div>

      {/* Flying Items */}
      {flyingItems.map(item => (
        <div
          key={item.id}
          className="fixed z-[9999] pointer-events-none animate-fly-to-cart"
          style={{
            '--start-x': `${item.startX}px`,
            '--start-y': `${item.startY}px`,
            '--end-x': `${item.endX}px`,
            '--end-y': `${item.endY}px`,
          } as React.CSSProperties}
        >
          <div className="w-16 h-16 rounded-2xl bg-white p-2 shadow-2xl flex items-center justify-center animate-spin-shrink">
            <img src={item.image || undefined} className="max-w-full max-h-full object-contain" />
          </div>
        </div>
      ))}
    </div>
  );
}
