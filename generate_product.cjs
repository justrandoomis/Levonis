const fs = require('fs');

const code = `import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { queryDb } from '../lib/db';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { DUMMY_PRODUCTS } from '../data';
import { 
  ArrowRight, ArrowLeft, ShoppingCart, Star, Check, Share2, 
  Heart, Clock, Package, ChevronUp, ChevronDown, Repeat, 
  MessageSquare, ThumbsUp, Flag, Minus, Plus, Trash2, X, 
  MoreHorizontal, Info, FileText, Image as ImageIcon, PlayCircle, Settings2 
} from 'lucide-react';

export default function Product() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const { t, lang, dir } = useLanguage();
  const { user } = useAuth();
  
  const [product, setProduct] = useState<any>(null);
  const [loading, setLoading] = useState(true);
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
            description: 'This is a premium product offered by the merchant.',
            description_ar: 'هذا منتج مميز يقدمه التاجر.',
            base_price: 35.00,
            images: JSON.stringify([
              'https://images.unsplash.com/photo-1629236715082-f5dc817293e6?w=800',
              'https://images.unsplash.com/photo-1631427962232-803d4f30c64f?w=800'
            ]),
          });
          return;
        }
        
        const res = await queryDb('SELECT * FROM products WHERE slug = ? OR id = ?', [slug, slug]);
        if (res && res.length > 0) {
          setProduct(res[0]);
        } else {
          // Fallback to dummy
          const dummy = DUMMY_PRODUCTS.find(p => String(p.slug) === String(slug) || String(p.id) === String(slug));
          if (dummy) {
            setProduct(dummy);
          } else {
            setProduct({
              ...DUMMY_PRODUCTS[0],
              id: slug,
              slug: slug,
              name: (slug || '').includes('merchant') ? 'منتج متجر' : DUMMY_PRODUCTS[0].name,
              name_ar: (slug || '').includes('merchant') ? 'منتج متجر' : DUMMY_PRODUCTS[0].name_ar,
              name_en: (slug || '').includes('merchant') ? 'Merchant Product' : DUMMY_PRODUCTS[0].name_en,
            });
          }
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

  const images = Array.isArray(product.images) ? product.images : (function(){ try { return JSON.parse(product.images || '[]'); } catch(e) { return [product.images].filter(Boolean); } })();
  const firstImage = images[0] || product.image_url || product.image || 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800';
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

  const handleAddToCart = (e: React.MouseEvent) => {
    const button = e.currentTarget;
    const rect = button.getBoundingClientRect();
    const cartIcon = document.getElementById('cart-icon-target');
    
    let endX = window.innerWidth / 2;
    let endY = 20;
    if (cartIcon) {
      const cartRect = cartIcon.getBoundingClientRect();
      endX = cartRect.left + cartRect.width / 2;
      endY = cartRect.top + cartRect.height / 2;
    }

    const id = Date.now();
    setFlyingItems(prev => [...prev, {
      id,
      startX: rect.left + rect.width / 2,
      startY: rect.top + rect.height / 2,
      endX,
      endY,
      image: firstImage
    }]);

    setTimeout(() => {
      setFlyingItems(prev => prev.filter(item => item.id !== id));
      setCartCount(c => c + quantity);
      setIsAnimatingCart(true);
      setTimeout(() => setIsAnimatingCart(false), 300);
    }, 800);
  };

  return (
    <div className={\`w-full min-h-[100dvh] bg-black text-zinc-300 font-sans pb-[100px] transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] \${cartModalOpen ? '-translate-y-[400px] pointer-events-none' : 'translate-y-0'}\`} dir={dir}>
      
      {/* Header */}
      <div className="fixed top-0 inset-x-0 z-50 bg-black/90 backdrop-blur-xl px-4 py-3 flex items-center justify-between">
        <button onClick={() => navigate(-1)} className="p-2 bg-zinc-900/50 rounded-full hover:bg-zinc-800/50 transition-colors">
          {dir === 'rtl' ? <ArrowRight className="w-5 h-5 text-white" /> : <ArrowLeft className="w-5 h-5 text-white" />}
        </button>
        <div className="flex items-center gap-3">
          <button className="w-10 h-10 rounded-full bg-zinc-900/50 flex items-center justify-center relative hover:bg-zinc-800 transition-colors">
            <ShoppingCart className={\`w-5 h-5 \${isAnimatingCart ? 'text-gold animate-bounce' : 'text-white'}\`} id="cart-icon-target" />
            {cartCount > 0 && (
              <span className="absolute -top-1 -right-1 w-5 h-5 bg-gold text-black rounded-full text-[10px] font-bold flex items-center justify-center">
                {cartCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* Main Image */}
      <div className="w-full pt-[60px] h-80 bg-zinc-900 relative rounded-b-3xl overflow-hidden flex items-center justify-center">
        <img referrerPolicy="no-referrer" src={firstImage} alt={name} className="max-w-full max-h-full object-contain p-4" />
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
            {product.brand || 'منتج مميز'}
          </span>
        </div>

        <h1 className="text-2xl font-bold text-white mb-2 leading-tight">
          {name}
        </h1>

        <div className="flex items-center gap-2 mb-4 text-sm">
          <div className="flex items-center text-yellow-500">
            <Star className="w-4 h-4 fill-current" />
            <Star className="w-4 h-4 fill-current" />
            <Star className="w-4 h-4 fill-current" />
            <Star className="w-4 h-4 fill-current" />
            <Star className="w-4 h-4 fill-current opacity-50" />
          </div>
          <span className="text-white font-bold">4.8</span>
          <span className="text-zinc-500">(1,245 تقييم)</span>
        </div>

        <div className="flex flex-col mb-6 gap-3">
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold text-white">{(displayPrice || 0).toLocaleString()} <span className="text-lg">د.ع</span></span>
            {product.original_price && (
               <span className="text-zinc-500 line-through text-sm">{(product.original_price || 0).toLocaleString()} د.ع</span>
            )}
          </div>
        </div>

        {/* Options */}
        <div className="mb-6">
          <button onClick={() => setOptionsOpen(!optionsOpen)} className="flex items-center justify-between w-full mb-3">
            <h2 className="text-white font-bold text-lg">الخيارات</h2>
            {optionsOpen ? <ChevronUp className="w-5 h-5 text-zinc-500" /> : <ChevronDown className="w-5 h-5 text-zinc-500" />}
          </button>
          {optionsOpen && (
            <div className="flex flex-col gap-3">
              <div 
                onClick={() => setSelectedOption('full')}
                className={\`bg-zinc-900/50 border \${selectedOption === 'full' ? 'border-gold bg-gold/5' : 'border-zinc-800/50'} rounded-2xl p-4 flex justify-between items-center w-full cursor-pointer\`}
              >
                <div className="flex flex-col gap-1">
                  <span className={\`font-bold \${selectedOption === 'full' ? 'text-gold' : 'text-white'}\`}>المنتج كامل</span>
                  <span className="text-zinc-500 text-xs">احصل على المنتج بجميع ملحقاته</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-white font-bold">{(displayPrice || 0).toLocaleString()}</span>
                  <div className={\`w-6 h-6 rounded-full border-2 flex items-center justify-center \${selectedOption === 'full' ? 'border-gold bg-gold' : 'border-zinc-600'}\`}>
                    {selectedOption === 'full' && <Check className="w-4 h-4 text-black" />}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Details Accordion */}
        <div className="mb-4">
          <button onClick={() => setDetailsOpen(!detailsOpen)} className="flex justify-between items-center w-full bg-zinc-900/40 p-4 rounded-xl border border-zinc-800">
            <div className="flex items-center gap-3">
              <Info className="w-5 h-5 text-gold" />
              <span className="font-bold text-white">تفاصيل المنتج</span>
            </div>
            {detailsOpen ? <ChevronUp className="w-5 h-5 text-zinc-400" /> : <ChevronDown className="w-5 h-5 text-zinc-400" />}
          </button>
          {detailsOpen && (
            <div className="p-4 bg-zinc-900/20 border border-t-0 border-zinc-800 rounded-b-xl -mt-2 pt-4 text-sm text-zinc-400 leading-relaxed">
               {description}
            </div>
          )}
        </div>

      </div>

      {/* Cart Modal overlay trigger area */}
      <div className="fixed bottom-0 inset-x-0 h-24 bg-gradient-to-t from-black to-transparent pointer-events-none z-40"></div>
      
      {/* Bottom Bar Action */}
      <div className="fixed bottom-4 inset-x-4 z-50">
        <div className="bg-zinc-900/90 backdrop-blur-xl border border-zinc-800 rounded-2xl p-2 flex items-center justify-between shadow-2xl">
          <div className="flex items-center gap-2 px-2">
            <button onClick={() => setQuantity(Math.max(1, quantity - 1))} className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center text-white hover:bg-zinc-700">
              <Minus className="w-4 h-4" />
            </button>
            <span className="text-white font-bold w-6 text-center">{quantity}</span>
            <button onClick={() => setQuantity(quantity + 1)} className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center text-white hover:bg-zinc-700">
              <Plus className="w-4 h-4" />
            </button>
          </div>
          
          <button onClick={handleAddToCart} className="flex-1 bg-white text-black font-bold py-3 px-6 rounded-xl flex items-center justify-center gap-2 hover:bg-zinc-200 transition-colors ml-2 shadow-[0_0_20px_rgba(255,255,255,0.1)]">
            <ShoppingCart className="w-5 h-5" />
            <span>إضافة للسلة</span>
          </button>
        </div>
      </div>

      {/* Flying Items Animation Layer */}
      {flyingItems.map(item => (
        <div
          key={item.id}
          className="fixed z-[100] pointer-events-none"
          style={{
            animation: 'fly-to-cart 0.8s cubic-bezier(0.2, 1, 0.3, 1) forwards',
            '--start-x': \`\${item.startX}px\`,
            '--start-y': \`\${item.startY}px\`,
            '--end-x': \`\${item.endX}px\`,
            '--end-y': \`\${item.endY}px\`,
          } as React.CSSProperties}
        >
          <div className="w-16 h-16 rounded-2xl bg-white p-2 shadow-2xl flex items-center justify-center animate-spin-shrink">
            <img referrerPolicy="no-referrer" src={item.image} className="max-w-full max-h-full object-contain" />
          </div>
        </div>
      ))}
    </div>
  );
}
`;

fs.writeFileSync('src/pages/Product.tsx', code);
console.log('Generated Product.tsx successfully.');
