import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { ArrowRight, ArrowLeft, ShoppingCart, Star, Check, Share2, Heart, Clock, Package, ChevronUp, ChevronDown, MessageSquare, Minus, Plus, Trash2, X, FileText, Image as ImageIcon, Settings2 } from 'lucide-react';
import { api, ApiError, ApiProduct, CartItem, formatIqd } from '../lib/api';

type ProductSource = 'catalog' | 'community';

export default function Product() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const { lang, dir } = useLanguage();
  const { user, isAuthenticated } = useAuth();

  const [product, setProduct] = useState<ApiProduct | null>(null);
  const [source, setSource] = useState<ProductSource>('catalog');
  const [favorite, setFavorite] = useState(false);
  const [favBusy, setFavBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  // Accordion states
  const [shippingOpen, setShippingOpen] = useState(true);
  const [optionsOpen, setOptionsOpen] = useState(true);
  const [colorsOpen, setColorsOpen] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [specsOpen, setSpecsOpen] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);

  const [selectedOptionId, setSelectedOptionId] = useState('');
  const [selectedColorId, setSelectedColorId] = useState('');
  const [selectedShippingId, setSelectedShippingId] = useState('');

  const [quantity, setQuantity] = useState(1);
  const [cartModalOpen, setCartModalOpen] = useState(false);
  const [orderType, setOrderType] = useState<'pre_order' | 'direct'>('direct');

  const [cartCount, setCartCount] = useState(0);
  const [isAnimatingCart, setIsAnimatingCart] = useState(false);
  const [addingToCart, setAddingToCart] = useState(false);
  const [actionError, setActionError] = useState('');
  const [flyingItems, setFlyingItems] = useState<{id: number, startX: number, startY: number, endX: number, endY: number, image: string}[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const data = await api.get<{ product: ApiProduct; source: ProductSource; favorite: boolean }>(
          `/api/products/${slug}`
        );
        if (cancelled) return;
        setProduct(data.product);
        setSource(data.source);
        setFavorite(data.favorite);
        if (data.product.selling_type === 'pre_order') setOrderType('pre_order');
        setSelectedShippingId((data.product.shipping_methods ?? [])[0]?.id ?? '');
      } catch (err) {
        console.error(err);
        if (!cancelled) setProduct(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    if (slug) load();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Real cart badge: reflect the server cart for signed-in users.
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    api
      .get<{ items: CartItem[] }>('/api/cart')
      .then((data) => {
        if (!cancelled) setCartCount(data.items.reduce((s, it) => s + it.qty, 0));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

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

  const images = Array.isArray(product.images) ? product.images : [];
  const firstImage = images[0] || '';
  const name = lang === 'ar' && product.name_ar ? product.name_ar : product.name;
  const description = lang === 'ar' && product.description_ar ? product.description_ar : product.description;

  const options = product.options ?? [];
  const productColors = product.colors ?? [];
  const shippingMethods = product.shipping_methods ?? [];
  const specifications = product.specifications ?? [];
  const descriptionImages = product.description_images ?? [];
  const descriptionVideos = product.description_videos ?? [];

  // Subscription plan comes exclusively from the server-side user record.
  const plan = user?.subscription_plan ?? 'free';
  const planActive =
    !!user && plan !== 'free' && (user.subscription_expiry === 0 || user.subscription_expiry > Date.now());
  const proPrice = product.membership_prices?.pro ?? null;

  /**
   * Mirrors the server-side unit pricing (worker/routes/cart.ts):
   * base price, replaced by the selected option/color price, replaced by the
   * shipping-method price, lowered by the active plan's membership price.
   * The price actually charged is always recomputed server-side.
   */
  const computeUnitPrice = (): { price: number; planApplied: boolean } => {
    let price = product.price_iqd;
    const opt = options.find((o) => o.id === selectedOptionId);
    if (opt && typeof opt.price_iqd === 'number' && opt.price_iqd > 0) price = opt.price_iqd;
    const col = productColors.find((c) => c.id === selectedColorId);
    if (col && typeof col.price_iqd === 'number' && col.price_iqd > 0) price = col.price_iqd;
    if (orderType === 'pre_order' && selectedShippingId) {
      const sm = shippingMethods.find((s) => s.id === selectedShippingId);
      if (sm && typeof sm.price_iqd === 'number' && sm.price_iqd > 0) price = sm.price_iqd;
    }
    let planApplied = false;
    if (planActive && (plan === 'plus' || plan === 'pro')) {
      const planPrice = product.membership_prices?.[plan];
      if (typeof planPrice === 'number' && planPrice > 0 && planPrice < price) {
        price = planPrice;
        planApplied = true;
      }
    }
    return { price, planApplied };
  };

  const unit = computeUnitPrice();
  const displayPrice = unit.price;
  const regularPrice = (() => {
    // Same computation without the membership discount, for the strikethrough.
    let price = product.price_iqd;
    const opt = options.find((o) => o.id === selectedOptionId);
    if (opt && typeof opt.price_iqd === 'number' && opt.price_iqd > 0) price = opt.price_iqd;
    const col = productColors.find((c) => c.id === selectedColorId);
    if (col && typeof col.price_iqd === 'number' && col.price_iqd > 0) price = col.price_iqd;
    if (orderType === 'pre_order' && selectedShippingId) {
      const sm = shippingMethods.find((s) => s.id === selectedShippingId);
      if (sm && typeof sm.price_iqd === 'number' && sm.price_iqd > 0) price = sm.price_iqd;
    }
    return price;
  })();

  const outOfStock = product.stock !== null && product.stock !== undefined && product.stock <= 0;
  const maxQty = Math.min(99, product.stock ?? 99);
  const clampQty = (q: number) => Math.max(1, Math.min(maxQty, q));

  const handleShare = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: name, url: window.location.href });
      } else {
        await navigator.clipboard.writeText(window.location.href);
        setActionError(dir === 'rtl' ? 'تم نسخ الرابط' : 'Link copied');
        setTimeout(() => setActionError(''), 2000);
      }
    } catch {
      /* user cancelled the share sheet */
    }
  };

  const toggleFavorite = async () => {
    if (favBusy || source !== 'catalog') return;
    if (!isAuthenticated) {
      navigate('/auth');
      return;
    }
    setFavBusy(true);
    setActionError('');
    try {
      if (favorite) {
        await api.delete(`/api/profile/favorites/${product.id}`);
        setFavorite(false);
      } else {
        await api.put(`/api/profile/favorites/${product.id}`);
        setFavorite(true);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        navigate('/auth');
        return;
      }
      setActionError(err instanceof Error ? err.message : 'Failed to update favorites');
    } finally {
      setFavBusy(false);
    }
  };

  const handleAddToCart = async (e: React.MouseEvent) => {
    if (addingToCart || outOfStock) return;
    setActionError('');

    // Capture coordinates before the request; the fly animation starts on success.
    const btn = e.currentTarget.getBoundingClientRect();
    const cartBtn = document.getElementById('cart-icon-btn')?.getBoundingClientRect();
    const endX = cartBtn ? cartBtn.left + cartBtn.width / 2 : 40;
    const endY = cartBtn ? cartBtn.top + cartBtn.height / 2 : window.innerHeight - 40;
    const startX = btn.left + btn.width / 2;
    const startY = btn.top + btn.height / 2;

    setAddingToCart(true);
    try {
      const body: Record<string, unknown> = { productId: product.id, qty: quantity };
      if (selectedOptionId) body.optionId = selectedOptionId;
      if (selectedColorId) body.colorId = selectedColorId;
      if (orderType === 'pre_order' && selectedShippingId) body.shippingMethodId = selectedShippingId;

      const data = await api.post<{ items: CartItem[] }>('/api/cart/items', body);
      const serverCount = data.items.reduce((s, it) => s + it.qty, 0);

      const id = Date.now();
      setFlyingItems(prev => [...prev, { id, startX, startY, endX, endY, image: firstImage }]);
      setTimeout(() => {
        setFlyingItems(prev => prev.filter(item => item.id !== id));
        // Badge reflects the real server cart, only after the API succeeded.
        setCartCount(serverCount);
        setIsAnimatingCart(true);
        setTimeout(() => setIsAnimatingCart(false), 300);
      }, 800);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        navigate('/auth');
        return;
      }
      setActionError(err instanceof Error ? err.message : 'Failed to add to cart');
    } finally {
      setAddingToCart(false);
    }
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
        {firstImage ? (
          <img src={firstImage} alt={name} className="max-w-full max-h-full object-contain p-4" />
        ) : (
          <Package className="w-16 h-16 text-zinc-700" />
        )}
      </div>

      <div className="px-4 py-5">
        <div className="flex justify-between items-center mb-2">
          <div className="flex items-center gap-2">
            <button onClick={handleShare} className="w-10 h-10 rounded-full bg-zinc-900/80 flex items-center justify-center text-zinc-300 hover:text-white hover:bg-zinc-800 transition-colors">
              <Share2 className="w-5 h-5" />
            </button>
            <button
              onClick={toggleFavorite}
              disabled={favBusy || source !== 'catalog'}
              title={source !== 'catalog' ? (dir === 'rtl' ? 'قريباً' : 'Coming soon') : undefined}
              className={`w-10 h-10 rounded-full bg-zinc-900/80 flex items-center justify-center transition-colors ${
                favorite ? 'text-rose-500' : 'text-zinc-300 hover:text-white hover:bg-zinc-800'
              } ${source !== 'catalog' ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
              <Heart className={`w-5 h-5 ${favorite ? 'fill-rose-500' : ''}`} />
            </button>
          </div>
          {product.brand ? (
            <span className="border border-zinc-600 rounded-full px-3 py-0.5 text-xs text-zinc-300">
              {product.brand}
            </span>
          ) : null}
        </div>

        <h1 className="text-2xl font-bold text-white mb-3 text-right">{name}</h1>

        {outOfStock && (
          <div className="flex justify-end mb-4">
            <span className="bg-red-500/10 text-red-400 px-3 py-1 rounded-full text-xs font-medium">
              {dir === 'rtl' ? 'نفد المخزون' : 'Out of stock'}
            </span>
          </div>
        )}

        {description ? (
          <p className="text-sm text-zinc-400 leading-relaxed text-right mb-6 whitespace-pre-line">
            {description}
          </p>
        ) : (
          <p className="text-sm text-zinc-400 leading-relaxed text-right mb-6">
            التعبئة تتوفر فقط للألوان الأساسية مثل: أسود، أبيض، رمادي، فضي، أحمر، أزرق، أزرق داكن، أخضر، أصفر، برتقالي، بني، وردي
          </p>
        )}

        <div className="flex flex-col mb-6 gap-3">
          {unit.planApplied ? (
             <div className="bg-gradient-to-r from-gold/20 to-gold/5 border border-gold/30 rounded-2xl p-4 flex flex-col gap-2 relative overflow-hidden">
                <div className="absolute -right-4 -top-4 w-16 h-16 bg-gold/20 blur-2xl rounded-full"></div>
                <div className="flex justify-between items-center w-full relative z-10">
                  <span className="text-gold font-black text-3xl flex items-center gap-2 drop-shadow-[0_0_8px_rgba(186,163,105,0.4)]">
                    {formatIqd(displayPrice)}
                  </span>
                  <span className="bg-gradient-to-r from-gold to-gold-light text-black px-3 py-1.5 rounded-lg text-xs font-black uppercase tracking-widest shadow-lg flex items-center gap-1.5">
                    <Star className="w-3.5 h-3.5 fill-black" />
                    {plan === 'pro' ? 'عضوية PRO' : 'عضوية PLUS'}
                  </span>
                </div>
                <span className="text-zinc-400 font-medium text-sm line-through relative z-10">
                  {formatIqd(regularPrice)} (السعر العادي)
                </span>
             </div>
          ) : (
             <div className="flex flex-col gap-3">
                <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-2xl p-4 flex justify-between items-center w-full">
                  <span className="text-white font-bold text-2xl">{formatIqd(displayPrice)}</span>
                  <span className="bg-zinc-800 text-zinc-400 px-3 py-1 rounded-lg text-xs font-bold uppercase tracking-wider">السعر العادي</span>
                </div>
                {proPrice && !planActive ? (
                  <button
                    onClick={() => navigate('/subscription')}
                    className="flex justify-between items-center w-full mt-1 group"
                  >
                    <span className="text-zinc-500 font-medium text-sm flex items-center gap-1.5 group-hover:text-gold transition-colors">
                      <Star className="w-3.5 h-3.5 text-zinc-500 group-hover:text-gold transition-colors" />
                      {formatIqd(proPrice)} (لأعضاء PRO)
                    </span>
                    <span className="text-zinc-600 text-xs font-bold opacity-80 group-hover:opacity-100 group-hover:text-gold transition-colors">اشترك الآن</span>
                  </button>
                ) : null}
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
        {orderType === 'pre_order' && shippingMethods.length > 0 && (
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
              <div className="px-4 pb-4 flex flex-col gap-2">
                {shippingMethods.map((sm) => {
                  const selected = selectedShippingId === sm.id;
                  return (
                    <div
                      key={sm.id}
                      onClick={() => setSelectedShippingId(sm.id)}
                      className={`flex justify-between items-center border rounded-lg p-3 cursor-pointer transition-colors ${selected ? 'border-[#b59045] bg-[#b59045]/10' : 'border-zinc-700/50 hover:bg-zinc-800/50'}`}
                    >
                       <div className="bg-zinc-800/50 text-white px-3 py-1 rounded-full text-xs">
                         {typeof sm.price_iqd === 'number' && sm.price_iqd > 0 ? formatIqd(sm.price_iqd) : 'مجاني'}
                       </div>
                       <div className="flex items-center gap-3">
                         <div className="text-right">
                           <div className={`font-bold text-sm ${selected ? 'text-[#b59045]' : 'text-white'}`}>{sm.method || sm.id}</div>
                           {sm.delivery_time ? <div className="text-zinc-500 text-xs">{sm.delivery_time}</div> : null}
                         </div>
                         <div className={`w-5 h-5 rounded-full flex items-center justify-center transition-colors ${selected ? 'bg-[#b59045]' : 'border border-zinc-600'}`}>
                           {selected && <Check className="w-3 h-3 text-black" />}
                         </div>
                       </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Available Options */}
        {options.length > 0 && (
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
                {options.map((opt) => {
                  const selected = selectedOptionId === opt.id;
                  const optName = lang === 'ar' && opt.name_ar ? opt.name_ar : opt.name || opt.id;
                  return (
                    <div
                      key={opt.id}
                      className={`flex justify-between items-center border rounded-lg p-3 cursor-pointer transition-colors ${selected ? 'border-[#b59045] bg-[#b59045]/10' : 'border-zinc-700/50 hover:bg-zinc-800/50'}`}
                      onClick={() => setSelectedOptionId(selected ? '' : opt.id)}
                    >
                       <div className={`text-xs ${selected ? 'text-[#b59045] font-bold' : 'text-zinc-400'}`}>
                         {typeof opt.price_iqd === 'number' && opt.price_iqd > 0 ? formatIqd(opt.price_iqd) : ''}
                       </div>
                       <div className="flex items-center gap-3">
                         <span className={`text-sm ${selected ? 'text-[#b59045] font-bold' : 'text-white'}`}>{optName}</span>
                         <div className={`w-5 h-5 rounded-full flex items-center justify-center transition-colors ${selected ? 'bg-[#b59045]' : 'border border-zinc-600'}`}>
                           {selected && <Check className="w-3 h-3 text-black" />}
                         </div>
                       </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Colors */}
        {productColors.length > 0 && (
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
                  {productColors.map((c) => {
                    const selected = selectedColorId === c.id;
                    const colorName = lang === 'ar' && c.name_ar ? c.name_ar : c.name || '';
                    return (
                      <button
                        key={c.id}
                        onClick={() => setSelectedColorId(selected ? '' : c.id)}
                        className={`flex flex-col items-center justify-center w-[48px] h-[64px] rounded-lg border p-1 transition-colors ${
                          selected ? 'bg-[#b59045]/10 border-[#b59045]' : 'bg-zinc-800/50 border-zinc-700/30'
                        }`}
                      >
                        <div
                          className="w-6 h-6 rounded-full border border-zinc-600 mb-1"
                          style={c.gradient ? { background: c.gradient } : { backgroundColor: c.hex || '#333' }}
                        ></div>
                        <span className={`text-[9px] text-center leading-tight w-full break-words truncate px-0.5 ${selected ? 'text-[#b59045] font-bold' : 'text-zinc-300'}`}>{colorName}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

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
              {description ? (
                <p className="whitespace-pre-line">{description}</p>
              ) : (
                <>
                  <p className="mb-2">هذا المنتج مصنوع بدقة باستخدام أحدث تقنيات الطباعة ثلاثية الأبعاد. يتميز بجودة عالية وتفاصيل دقيقة تلبي جميع احتياجاتك.</p>
                  <p>نستخدم أفضل أنواع مواد الطباعة (PLA, PETG, Resin) لضمان المتانة والصلابة المثالية للمنتج النهائي.</p>
                </>
              )}
            </div>
          )}
        </div>

        {/* Product Specs Section */}
        {specifications.length > 0 && (
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
                  {specifications.map((spec, i) => (
                    <div key={i} className={`flex justify-between pb-2 ${i < specifications.length - 1 ? 'border-b border-zinc-800' : ''}`}>
                       <span className="text-white">{spec.value}</span>
                       <span className="text-zinc-500">{spec.key}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Media & Gallery Section */}
        {(descriptionImages.length > 0 || descriptionVideos.length > 0) && (
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
                 {descriptionImages.length > 0 && (
                   <div className="grid grid-cols-2 gap-2 mb-3">
                      {descriptionImages.map((img, i) => (
                        <div key={i} className="aspect-square rounded-lg overflow-hidden bg-zinc-800 border border-zinc-700/50">
                          <img src={img} alt="" className="w-full h-full object-cover" />
                        </div>
                      ))}
                   </div>
                 )}
                 {descriptionVideos.map((video, i) => (
                   <div key={i} className="aspect-video rounded-lg overflow-hidden bg-zinc-800 border border-zinc-700/50 relative w-full mb-2 last:mb-0">
                      <video src={video} controls className="w-full h-full object-contain bg-black" />
                   </div>
                 ))}
              </div>
            )}
          </div>
        )}

        {/* Reviews Section — reviews are not implemented server-side yet. */}
        <div className="mb-4">
          <div className="flex items-center justify-end gap-2 mb-4">
             <h2 className="text-white font-bold flex items-center gap-2">
               التقييمات والمراجعات <MessageSquare className="w-5 h-5 text-zinc-400" />
             </h2>
          </div>

          <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-xl p-8 text-center">
            <MessageSquare className="w-8 h-8 text-zinc-700 mx-auto mb-3" />
            <p className="text-zinc-500 text-sm">
              {dir === 'rtl' ? 'لا توجد تقييمات بعد' : 'No reviews yet'}
            </p>
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

      {/* Inline action error / notice */}
      {actionError && (
        <div className="fixed bottom-[92px] inset-x-0 z-[130] flex justify-center px-4 pointer-events-none">
          <div className="bg-zinc-900 border border-red-500/40 text-red-400 text-xs px-4 py-2 rounded-full shadow-lg">
            {actionError}
          </div>
        </div>
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
            className={`flex-1 flex flex-col justify-center items-center px-2 ${outOfStock || addingToCart ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            onClick={handleAddToCart}
          >
             <span className="text-white font-bold text-[14px] mb-0.5">
               {outOfStock ? (dir === 'rtl' ? 'نفد المخزون' : 'Out of stock') : addingToCart ? (dir === 'rtl' ? 'جارٍ الإضافة...' : 'Adding...') : 'أضف للسلة'}
             </span>
             <span className="text-[#d4a849] font-bold text-[13px] tracking-tight">{formatIqd(displayPrice * quantity)}</span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0 mr-1">
            <div className="flex items-center gap-2 bg-[#1A1A1C] rounded-full p-1 pl-4 h-[48px]">
              <button onClick={() => setQuantity(q => clampQty(q - 1))} className="flex items-center justify-center text-zinc-400 hover:text-white transition-colors">
                <Minus className="w-[18px] h-[18px]" />
              </button>
              <span className="text-white font-bold text-[15px] min-w-[24px] text-center">{quantity}</span>
              <button onClick={() => setQuantity(q => clampQty(q + 1))} className="w-[40px] h-[40px] bg-[#d4a849] rounded-full flex items-center justify-center text-black hover:brightness-110 transition-all">
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
                 <span className="text-white font-bold text-xs tracking-tight">
                   {source === 'community' && product.merchant ? product.merchant.name.substring(0, 2).toUpperCase() : 'LV'}
                 </span>
              </div>
              <div className="flex flex-col">
                 <span className="text-white font-medium text-sm flex items-center gap-1.5">
                   {source === 'community' && product.merchant ? product.merchant.name : 'Levonis'}
                   {source === 'community' && product.merchant?.verified && (
                     <span className="w-4 h-4 rounded-full bg-blue-500 flex items-center justify-center">
                       <Check className="w-3 h-3 text-white" strokeWidth={3} />
                     </span>
                   )}
                 </span>
                 <span className="text-zinc-400 text-xs font-medium">
                   {source === 'community'
                     ? (dir === 'rtl' ? 'متجر مجتمع' : 'Community store')
                     : (dir === 'rtl' ? 'المتجر الرسمي' : 'Official store')}
                 </span>
              </div>
            </div>

            {/* Product Info */}
            <div className="flex gap-4 mb-4 shrink-0" dir="ltr">
              <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-[12px] bg-white flex items-center justify-center shrink-0 p-2">
                 {firstImage ? <img src={firstImage} className="max-w-full max-h-full object-contain" /> : <Package className="w-8 h-8 text-zinc-400" />}
              </div>
              <div className="flex flex-col flex-1 justify-center py-1">
                <div className="flex justify-between items-start gap-2 mb-2">
                   <h3 className="text-white text-sm font-medium line-clamp-2 leading-snug">{name}</h3>
                   <span className="whitespace-nowrap text-sm font-bold text-[#b59045]">{formatIqd(displayPrice)}</span>
                </div>

                <div className="flex justify-between items-center">
                   <div className="flex items-center bg-[#0F0F0F] rounded-[8px] h-8 overflow-hidden">
                      <button
                         onClick={() => setQuantity(q => clampQty(q - 1))}
                         className="w-8 h-full flex items-center justify-center text-white hover:bg-zinc-800 transition-colors"
                      >
                         {quantity === 1 ? <Trash2 className="w-3.5 h-3.5" /> : <Minus className="w-3.5 h-3.5" />}
                      </button>
                      <span className="w-6 text-center text-white font-bold text-xs">{quantity}</span>
                      <button
                         onClick={() => setQuantity(q => clampQty(q + 1))}
                         className="w-8 h-full flex items-center justify-center text-white hover:bg-zinc-800 transition-colors"
                      >
                         <Plus className="w-3.5 h-3.5" />
                      </button>
                   </div>
                </div>
              </div>
            </div>

            {/* Subtotal */}
            <div className="flex justify-between items-center mb-4 text-white text-sm font-medium shrink-0" dir="ltr">
               <span>Subtotal</span>
               <span className="text-[#b59045]">{formatIqd(displayPrice * quantity)}</span>
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
            {item.image ? <img src={item.image} className="max-w-full max-h-full object-contain" /> : <Package className="w-8 h-8 text-zinc-400" />}
          </div>
        </div>
      ))}
    </div>
  );
}
