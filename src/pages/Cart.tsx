import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { ArrowLeft, ArrowRight, Trash2, ChevronRight, Check, Minus, Plus, X, ShoppingCart } from 'lucide-react';
import { useAuth } from '../AuthContext';
import { useWallet } from '../WalletContext';
import { api, CartItem, formatIqd } from '../lib/api';
import Spinner from '../components/ui/Spinner';
import SafeImage from '../components/ui/SafeImage';
import { CartSkeleton } from '../components/ui/Skeleton';
import { ErrorState } from '../components/ui/AsyncStates';

export default function Cart() {
  const navigate = useNavigate();
  const { t, lang, dir } = useLanguage();
  const { user } = useAuth();
  const { cartShippingMethods, checkoutDeliveryMethods, pointBalance } = useWallet();

  // Subscription plan comes exclusively from the server-side user record.
  const plan = user?.subscription_plan ?? 'free';
  const planActive =
    !!user && plan !== 'free' && (user.subscription_expiry === 0 || user.subscription_expiry > Date.now());

  const [items, setItems] = useState<CartItem[]>([]);
  const [loading, setLoading] = useState(true);
  // Action errors (qty/variant updates) show as a dismissible banner over the
  // existing content; a failed INITIAL load is a distinct full state below.
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState<unknown>(null);
  // Selection is a client-side concern; selected item ids are handed to
  // checkout via navigate('/checkout', { state: { itemIds, usePoints } }).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const firstLoadRef = useRef(true);
  const knownIdsRef = useRef<Set<string>>(new Set());

  // Modals state
  const [variantModalOpen, setVariantModalOpen] = useState(false);
  const [variantItemId, setVariantItemId] = useState<string | null>(null);
  const [pendingOptionId, setPendingOptionId] = useState('');
  const [pendingColorId, setPendingColorId] = useState('');
  const [variantSaving, setVariantSaving] = useState(false);
  const [variantError, setVariantError] = useState('');

  const [shippingModalOpen, setShippingModalOpen] = useState(false);
  const [shippingItemId, setShippingItemId] = useState<string | null>(null);
  const [shippingSaving, setShippingSaving] = useState(false);
  const [shippingError, setShippingError] = useState('');

  const [dealsExpanded, setDealsExpanded] = useState(false);
  const [usePoints, setUsePoints] = useState(false);

  const applyItems = useCallback((next: CartItem[]) => {
    setItems(next);
    const existing = new Set(next.map((i) => i.id));
    const known = knownIdsRef.current;
    setSelectedIds((prev) => {
      if (firstLoadRef.current) {
        firstLoadRef.current = false;
        return new Set(existing); // select everything on first load
      }
      const kept = new Set([...prev].filter((id) => existing.has(id)));
      // Lines the page has never seen before (e.g. a variant change that
      // merged into a new row) start selected; deselected lines stay deselected.
      existing.forEach((id) => {
        if (!known.has(id)) kept.add(id);
      });
      return kept;
    });
    knownIdsRef.current = existing;
  }, []);

  const loadCart = useCallback(async () => {
    try {
      const data = await api.get<{ items: CartItem[] }>('/api/cart');
      applyItems(data.items || []);
      setError('');
      setLoadError(null);
    } catch (err) {
      if (firstLoadRef.current) {
        // Nothing on screen yet: a full error state (401 → sign-in prompt,
        // network/5xx → retry) instead of "your cart is empty" + a banner.
        setLoadError(err);
      } else {
        // The page already has content — keep it visible, show a banner.
        setError(err instanceof Error ? err.message : 'Failed to load cart');
      }
    } finally {
      setLoading(false);
    }
  }, [applyItems]);

  const retryLoadCart = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    loadCart();
  }, [loadCart]);

  useEffect(() => {
    loadCart();
  }, [loadCart]);

  const clampQty = (item: CartItem, q: number) => Math.max(1, Math.min(99, Math.min(q, item.stock ?? 99)));

  const updateQuantity = async (item: CartItem, delta: number) => {
    if (item.qty + delta < 1) {
      deleteItem(item);
      return;
    }
    const newQty = clampQty(item, item.qty + delta);
    if (newQty === item.qty) return;
    // Optimistic update, reconciled with the server's returned cart.
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, qty: newQty } : i)));
    try {
      const data = await api.patch<{ items: CartItem[] }>(`/api/cart/items/${item.id}`, { qty: newQty });
      applyItems(data.items || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update quantity');
      loadCart();
    }
  };

  const deleteItem = async (item: CartItem) => {
    try {
      const data = await api.delete<{ items: CartItem[] }>(`/api/cart/items/${item.id}`);
      applyItems(data.items || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove item');
      loadCart();
    }
  };

  const toggleSelect = (itemId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  const allSelected = items.length > 0 && items.every((i) => selectedIds.has(i.id));

  const toggleSelectAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(items.map((i) => i.id)));
  };

  const openVariantModal = (item: CartItem) => {
    setVariantItemId(item.id);
    setPendingOptionId(item.option_id || '');
    setPendingColorId(item.color_id || '');
    setVariantError('');
    setVariantModalOpen(true);
  };

  const confirmVariant = async () => {
    const item = items.find((i) => i.id === variantItemId);
    if (!item || variantSaving) return;
    if (pendingOptionId === (item.option_id || '') && pendingColorId === (item.color_id || '')) {
      setVariantModalOpen(false);
      return;
    }
    setVariantSaving(true);
    setVariantError('');
    try {
      const data = await api.patch<{ items: CartItem[] }>(`/api/cart/items/${item.id}`, {
        optionId: pendingOptionId,
        colorId: pendingColorId,
      });
      applyItems(data.items || []);
      setVariantModalOpen(false);
    } catch (err) {
      setVariantError(err instanceof Error ? err.message : 'Failed to update variant');
    } finally {
      setVariantSaving(false);
    }
  };

  const openShippingModal = (item: CartItem) => {
    setShippingItemId(item.id);
    setShippingError('');
    setShippingModalOpen(true);
  };

  const chooseShipping = async (item: CartItem, methodId: string) => {
    if (shippingSaving) return;
    setShippingSaving(true);
    setShippingError('');
    try {
      const data = await api.patch<{ items: CartItem[] }>(`/api/cart/items/${item.id}`, {
        shippingMethodId: methodId,
      });
      applyItems(data.items || []);
      setShippingModalOpen(false);
    } catch (err) {
      setShippingError(err instanceof Error ? err.message : 'Failed to update shipping method');
    } finally {
      setShippingSaving(false);
    }
  };

  const shippingLabel = (item: CartItem) => {
    const globalMethod = cartShippingMethods.find((m) => m.id === item.shipping_method_id);
    if (globalMethod) return dir === 'rtl' ? globalMethod.titleAr : globalMethod.titleEn;
    const own = (item.shipping_methods ?? []).find((m) => m.id === item.shipping_method_id);
    if (own?.method) return own.method;
    return dir === 'rtl' ? 'شحن مباشر' : 'Direct';
  };

  const selectedItems = items.filter((i) => selectedIds.has(i.id));
  const subtotal = selectedItems.reduce((sum, item) => sum + item.unit_price_iqd * item.qty, 0);
  const totalOriginalPrice = selectedItems.reduce(
    (sum, item) => sum + (item.original_price_iqd ?? item.unit_price_iqd) * item.qty,
    0
  );
  const discounts = totalOriginalPrice - subtotal;
  const selectedCount = selectedItems.reduce((sum, item) => sum + item.qty, 0);

  // Shipping preview only — the final shipping cost is the delivery method
  // chosen at checkout, priced server-side when the order is placed.
  const standardDelivery =
    checkoutDeliveryMethods.find((m) => m.id === 'standard') ?? checkoutDeliveryMethods[0];
  let shipping = selectedCount > 0 ? standardDelivery?.price_iqd ?? 0 : 0;
  let shippingMsg = '';

  if (planActive && plan === 'pro' && subtotal >= 50000) {
    shipping = 0;
    shippingMsg = dir === 'rtl' ? 'توصيل مجاني (Pro)' : 'Free Shipping (Pro)';
  } else if (planActive && plan === 'plus' && subtotal >= 150000) {
    shipping = 0;
    shippingMsg = dir === 'rtl' ? 'توصيل مجاني (Plus)' : 'Free Shipping (Plus)';
  }

  const pointsDiscount = usePoints ? Math.min(pointBalance, subtotal) : 0;
  const total = subtotal + shipping - pointsDiscount;

  const variantItem = items.find((i) => i.id === variantItemId) ?? null;
  const shippingItem = items.find((i) => i.id === shippingItemId) ?? null;

  const itemName = (item: CartItem) => (lang === 'ar' && item.name_ar ? item.name_ar : item.name);

  return (
    <div className="w-full pt-16 pb-48 text-zinc-300 min-h-screen bg-black flex flex-col font-sans">
      {/* Header */}
      <div className="fixed top-0 left-0 right-0 z-40 bg-black backdrop-blur-xl border-b border-zinc-900 px-4 py-4 flex items-center justify-between">
        <button onClick={() => navigate(-1)} className="p-1 hover:text-white transition-colors">
          {dir === 'rtl' ? <ArrowRight className="w-6 h-6" /> : <ArrowLeft className="w-6 h-6" />}
        </button>
        <h1 className="text-white font-bold text-[17px]">
          {t('cart' as any) || (dir === 'rtl' ? 'السلة' : 'Cart')}
        </h1>
        <button
          onClick={() => navigate('/profile')}
          className="text-[15px] text-zinc-300 hover:text-white font-medium"
        >
          {dir === 'rtl' ? 'المفضلة' : 'Favorites'}
        </button>
      </div>

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto bg-[#050505]">
        {error && (
          <div className="mx-4 mt-3 px-4 py-2.5 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm flex items-center justify-between gap-3">
            <span>{error}</span>
            <button onClick={() => setError('')} className="shrink-0 p-1 hover:text-white"><X className="w-4 h-4" /></button>
          </div>
        )}

        {loading ? (
          <div className="mt-3">
            <CartSkeleton rows={3} />
          </div>
        ) : loadError != null ? (
          <div className="mx-4 mt-6">
            <ErrorState error={loadError} onRetry={retryLoadCart} next="/cart" />
          </div>
        ) : items.length === 0 ? (
          <div className="mx-4 mt-6 text-center py-16 text-zinc-500 bg-[#0a0a0a] rounded-xl border border-zinc-900/50 flex flex-col items-center gap-4">
            <ShoppingCart className="w-10 h-10 text-zinc-700" />
            <p>{dir === 'rtl' ? 'سلتك فارغة' : 'Your cart is empty.'}</p>
            <button
              onClick={() => navigate('/products')}
              className="bg-[#ef233c] hover:bg-[#d90429] text-white font-bold py-2 px-6 rounded-lg text-sm transition-colors"
            >
              {dir === 'rtl' ? 'تسوق الآن' : 'Shop now'}
            </button>
          </div>
        ) : (
        <>
        <div className="bg-[#0a0a0a] border-y border-zinc-900/50 pb-4">
          {/* Group Header */}
          <div className="px-4 py-3 flex items-center gap-2">
            <span className="text-zinc-300 text-[15px] font-medium">
              {dir === 'rtl' ? 'شحن بواسطة ليفو' : 'Shipped by Levo'}
            </span>
          </div>

          {/* Items */}
          {items.map((item) => {
            const hasVariants = (item.options ?? []).length > 0 || (item.colors ?? []).length > 0;
            const hasShippingOptions = (item.shipping_methods ?? []).length > 0;
            const hasSale = item.original_price_iqd !== null && item.original_price_iqd > item.unit_price_iqd;
            const discountPct = hasSale
              ? Math.round((1 - item.unit_price_iqd / item.original_price_iqd!) * 100)
              : 0;
            const selected = selectedIds.has(item.id);
            return (
              <div key={item.id} className="px-4 py-2 flex gap-3">
                {/* Checkbox */}
                <div className="pt-8 shrink-0" onClick={() => toggleSelect(item.id)}>
                  <div className={`w-[22px] h-[22px] rounded-full border flex items-center justify-center transition-colors cursor-pointer ${
                    selected
                      ? 'bg-[#ef233c] border-[#ef233c]'
                      : 'border-zinc-500 hover:border-zinc-400'
                  }`}>
                    {selected && <Check className="w-3.5 h-3.5 text-white" strokeWidth={3} />}
                  </div>
                </div>

                {/* Product Image */}
                <div
                  className="w-[100px] h-[100px] shrink-0 rounded-lg overflow-hidden border border-zinc-800 cursor-pointer"
                  onClick={() => navigate(`/product/${item.slug}`)}
                >
                  <SafeImage
                    src={item.image}
                    alt={itemName(item)}
                    aspect="auto"
                    className="w-full h-full"
                    bgClassName="bg-white"
                    imgClassName="mix-blend-multiply"
                    fallbackClassName="text-zinc-500"
                  />
                </div>

                {/* Product Details */}
                <div className="flex-1 flex flex-col justify-between">
                  <div>
                    <h3 className="text-zinc-200 text-[14px] leading-snug line-clamp-2 mb-1">{itemName(item)}</h3>

                    <div className="flex flex-wrap gap-1.5 mb-1.5">
                      {hasVariants && (
                        <button
                          onClick={() => openVariantModal(item)}
                          className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 flex items-center gap-1 w-max"
                        >
                          <span className="text-[12px] text-zinc-300">
                            {item.variantLabel || (dir === 'rtl' ? 'اختر الخيارات' : 'Choose options')}
                          </span>
                          <ChevronRight className="w-3 h-3 text-zinc-500" />
                        </button>
                      )}

                      {hasShippingOptions && (
                        <button
                          onClick={() => openShippingModal(item)}
                          className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 flex items-center gap-1 w-max"
                        >
                          <span className="text-[12px] text-zinc-300">{shippingLabel(item)}</span>
                          <ChevronRight className="w-3 h-3 text-zinc-500" />
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="flex items-baseline gap-1.5 mb-2 mt-1">
                    <span className="text-[#ef233c] font-bold text-[17px]">{formatIqd(item.unit_price_iqd)}</span>
                    {hasSale && (
                      <>
                        <span className="text-zinc-500 text-[12px] line-through">{item.original_price_iqd!.toLocaleString()}</span>
                        <span className="text-[#ef233c] text-[12px]">-{discountPct}%</span>
                      </>
                    )}
                  </div>

                  <div className="flex items-center justify-between mt-auto">
                    <div className="flex items-center gap-3">
                      <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded">
                        <button onClick={() => updateQuantity(item, -1)} className="p-1.5 text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors">
                          {item.qty <= 1 ? <Trash2 className="w-4 h-4" /> : <Minus className="w-4 h-4" />}
                        </button>
                        <span className="w-8 text-center text-[14px] font-medium text-zinc-200 border-x border-zinc-800 py-1">{item.qty}</span>
                        <button onClick={() => updateQuantity(item, 1)} className="p-1.5 text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors">
                          <Plus className="w-4 h-4" />
                        </button>
                      </div>
                      {item.stock !== null && item.stock < 10 && (
                        <span className="text-[#ef233c] text-[12px]">
                          {dir === 'rtl' ? `متبقي ${item.stock} فقط` : `Only ${item.stock} left`}
                        </span>
                      )}
                    </div>
                    <button onClick={() => deleteItem(item)} className="px-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded text-[13px] font-medium text-zinc-300 hover:bg-zinc-800 transition-colors">
                      {dir === 'rtl' ? 'حذف' : 'Delete'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Deals Row */}
        <div className="mt-2 bg-[#0a0a0a] border-y border-zinc-900/50 flex flex-col">
          <div onClick={() => setDealsExpanded(!dealsExpanded)} className="px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-zinc-900/30 transition-colors">
            <div className="flex items-center gap-2">
              <svg viewBox="0 0 24 24" className="w-5 h-5 text-zinc-400" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
              </svg>
              <span className="text-zinc-200 text-[15px] font-bold">{dir === 'rtl' ? 'العروض والخصومات' : 'Deals & Discounts'}</span>
              {(usePoints && pointsDiscount > 0) && (
                <span className="bg-[#ef233c]/10 text-[#ef233c] text-[11px] font-medium px-1.5 py-0.5 rounded">{dir === 'rtl' ? 'تم التطبيق' : 'Applied'}</span>
              )}
            </div>
            <ChevronRight className={`w-4 h-4 text-zinc-500 transition-transform ${dealsExpanded ? 'rotate-90' : ''}`} />
          </div>

          {dealsExpanded && (
            <div className="px-4 pb-4 pt-1 animate-in slide-in-from-top-2 fade-in duration-200">
              <p className="text-zinc-400 text-sm mb-3">{dir === 'rtl' ? 'استخدم نقاطك للحصول على خصم' : 'Use your points for a discount'}</p>
              <div className="flex flex-col gap-2 mb-4">
                <label className={`flex items-center justify-between p-3 rounded-xl border cursor-pointer transition-colors ${usePoints ? 'border-emerald-500 bg-emerald-500/10' : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'}`}>
                  <div className="flex items-center gap-3">
                    <input type="checkbox" className="w-5 h-5 accent-emerald-500" checked={usePoints} onChange={() => setUsePoints(!usePoints)} disabled={pointBalance === 0} />
                    <div>
                      <p className={`font-bold ${usePoints ? 'text-emerald-400' : 'text-zinc-300'}`}>{dir === 'rtl' ? 'استخدام النقاط' : 'Use Points'}</p>
                      <p className="text-xs text-zinc-400">
                        {dir === 'rtl' ? `رصيدك: ${pointBalance.toLocaleString()} نقطة = ${pointBalance.toLocaleString()} د.ع` : `Balance: ${pointBalance.toLocaleString()} pts = ${pointBalance.toLocaleString()} IQD`}
                      </p>
                    </div>
                  </div>
                </label>
              </div>

              <div>
                <p className="text-white font-bold mb-2 text-sm">{dir === 'rtl' ? 'كود الخصم' : 'Promo Code'}</p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    disabled
                    placeholder={dir === 'rtl' ? 'أدخل الكود هنا' : 'Enter code here'}
                    className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-white outline-none focus:border-[#ef233c] transition-colors text-sm opacity-60 cursor-not-allowed"
                  />
                  {/* Promo codes have no backend yet — honestly disabled. */}
                  <button
                    disabled
                    title={dir === 'rtl' ? 'قريباً' : 'Coming soon'}
                    className="bg-zinc-800 text-zinc-500 font-bold px-4 py-2 rounded-lg border border-zinc-700 text-sm opacity-60 cursor-not-allowed"
                  >
                    {dir === 'rtl' ? 'قريباً' : 'Coming soon'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Summary Details */}
        <div className="mt-2 bg-[#0a0a0a] border-y border-zinc-900/50 p-4 mb-20 flex flex-col gap-3">
          <h3 className="text-white font-bold text-[16px] mb-1">{dir === 'rtl' ? 'ملخص الطلب' : 'Order Summary'}</h3>

          <div className="flex justify-between items-center">
            <span className="text-zinc-400 text-[14px]">{dir === 'rtl' ? 'المجموع الفرعي' : 'Subtotal'}</span>
            <span className="text-zinc-200 text-[14px] font-medium">{formatIqd(totalOriginalPrice)}</span>
          </div>

          {discounts > 0 && (
            <div className="flex justify-between items-center text-[#ef233c]">
              <div className="flex items-center gap-1">
                <span className="text-[14px]">{dir === 'rtl' ? 'خصم ليفو' : 'Levo Discount'}</span>
              </div>
              <span className="text-[14px] font-medium">- {formatIqd(discounts)}</span>
            </div>
          )}

          {pointsDiscount > 0 && (
            <div className="flex justify-between items-center text-emerald-400">
              <div className="flex items-center gap-1">
                <span className="text-[14px]">{dir === 'rtl' ? 'خصم النقاط' : 'Points Discount'}</span>
              </div>
              <span className="text-[14px] font-medium">- {formatIqd(pointsDiscount)}</span>
            </div>
          )}

          <div className="flex justify-between items-center">
            <span className="text-zinc-400 text-[14px]">
              {dir === 'rtl' ? 'التوصيل (يُحدد عند الدفع)' : 'Shipping (final at checkout)'}
            </span>
            <span className="text-zinc-200 text-[14px] font-medium">
              {shipping === 0 ? (
                <span className="text-green-500">{shippingMsg || (dir === 'rtl' ? 'مجاني' : 'Free')}</span>
              ) : (
                formatIqd(shipping)
              )}
            </span>
          </div>

          <div className="h-[1px] w-full bg-zinc-800/50 my-1"></div>

          <div className="flex justify-between items-center">
            <span className="text-white font-bold text-[15px]">{dir === 'rtl' ? 'المجموع الكلي' : 'Total'}</span>
            <span className="text-white font-bold text-[17px]">{formatIqd(total)}</span>
          </div>
        </div>
        </>
        )}
      </div>

      {/* Sticky Bottom Bar */}
      {!loading && items.length > 0 && (
      <div className="fixed bottom-[80px] sm:bottom-[100px] left-2 right-2 md:left-1/2 md:-translate-x-1/2 md:w-full md:max-w-md bg-zinc-900/90 backdrop-blur-xl border border-zinc-800 px-3 py-3 z-40 rounded-2xl shadow-[0_10px_30px_rgba(0,0,0,0.5)]">
        <div className="w-full flex items-center justify-between gap-2">

          <div className="flex items-center gap-2 cursor-pointer shrink-0" onClick={toggleSelectAll}>
            <div className={`w-5 h-5 sm:w-[22px] sm:h-[22px] rounded-full border flex items-center justify-center transition-colors ${
              allSelected
                ? 'bg-[#ef233c] border-[#ef233c]'
                : 'border-zinc-500'
            }`}>
              {allSelected && <Check className="w-3.5 h-3.5 text-white" strokeWidth={3} />}
            </div>
            <span className="text-zinc-300 text-[13px] sm:text-[14px] whitespace-nowrap">{dir === 'rtl' ? 'الكل' : 'All'}</span>
          </div>

          <div className="flex flex-col items-end flex-1 overflow-hidden pr-2">
            <div className="flex items-baseline gap-1.5 w-full justify-end">
              <span className="text-white font-bold text-[15px] sm:text-[17px] whitespace-nowrap truncate">{formatIqd(total)}</span>
            </div>
            {discounts > 0 && (
              <div className="flex items-center gap-1 text-[#ef233c] text-[10px] sm:text-[11px] whitespace-nowrap">
                <span>{dir === 'rtl' ? 'توفير' : 'Saved'} {discounts.toLocaleString()}</span>
              </div>
            )}
          </div>

          <button
            onClick={() => navigate('/checkout', { state: { itemIds: [...selectedIds], usePoints } })}
            className="bg-[#ef233c] hover:bg-[#d90429] text-white font-bold py-2 sm:py-2.5 px-3 sm:px-5 rounded-lg text-[13px] sm:text-[15px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0 whitespace-nowrap"
            disabled={selectedCount === 0}
          >
            {dir === 'rtl' ? `إتمام الطلب (${selectedCount})` : `Checkout (${selectedCount})`}
          </button>
        </div>
      </div>
      )}

      {/* Variant Modal — the product's real options and colors */}
      {variantModalOpen && variantItem && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-zinc-900 w-full max-w-md rounded-t-2xl p-5 border-t border-zinc-800 flex flex-col gap-4 animate-in slide-in-from-bottom-full duration-300">
            <div className="flex items-start justify-between">
              <div className="flex gap-4">
                {variantItem.image ? (
                  <img referrerPolicy="no-referrer" src={variantItem.image} alt="" className="w-20 h-20 rounded-lg object-cover bg-white" />
                ) : (
                  <div className="w-20 h-20 rounded-lg bg-zinc-800" />
                )}
                <div>
                  <p className="text-[#ef233c] font-bold text-lg">{formatIqd(variantItem.unit_price_iqd)}</p>
                  {variantItem.stock !== null && (
                    <p className="text-sm text-zinc-400">{dir === 'rtl' ? 'المخزون' : 'Stock'}: {variantItem.stock}</p>
                  )}
                </div>
              </div>
              <button onClick={() => setVariantModalOpen(false)} className="p-2 bg-zinc-800 rounded-full hover:bg-zinc-700 text-zinc-300">
                <X className="w-5 h-5" />
              </button>
            </div>

            {(variantItem.colors ?? []).length > 0 && (
              <div>
                <p className="text-white font-bold mb-2">{dir === 'rtl' ? 'اللون' : 'Color'}</p>
                <div className="flex gap-2 flex-wrap">
                  {(variantItem.colors ?? []).map((c) => {
                    const cName = lang === 'ar' && c.name_ar ? c.name_ar : c.name || c.id;
                    const active = pendingColorId === c.id;
                    return (
                      <button
                        key={c.id}
                        onClick={() => setPendingColorId(active ? '' : c.id)}
                        className={`px-4 py-2 rounded-lg border text-sm flex items-center gap-2 ${active ? 'border-[#ef233c] text-[#ef233c] bg-[#ef233c]/10' : 'border-zinc-700 text-zinc-300 bg-zinc-800'}`}
                      >
                        <span
                          className="w-3.5 h-3.5 rounded-full border border-zinc-600 inline-block"
                          style={c.gradient ? { background: c.gradient } : { backgroundColor: c.hex || '#333' }}
                        ></span>
                        {cName}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {(variantItem.options ?? []).length > 0 && (
              <div>
                <p className="text-white font-bold mb-2">{dir === 'rtl' ? 'الخيارات' : 'Options'}</p>
                <div className="flex gap-2 flex-wrap">
                  {(variantItem.options ?? []).map((o) => {
                    const oName = lang === 'ar' && o.name_ar ? o.name_ar : o.name || o.id;
                    const active = pendingOptionId === o.id;
                    return (
                      <button
                        key={o.id}
                        onClick={() => setPendingOptionId(active ? '' : o.id)}
                        className={`px-4 py-2 rounded-lg border text-sm ${active ? 'border-[#ef233c] text-[#ef233c] bg-[#ef233c]/10' : 'border-zinc-700 text-zinc-300 bg-zinc-800'}`}
                      >
                        {oName}
                        {typeof o.price_iqd === 'number' && o.price_iqd > 0 ? ` — ${formatIqd(o.price_iqd)}` : ''}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {variantError && (
              <p className="text-red-400 text-sm">{variantError}</p>
            )}

            <button
              onClick={confirmVariant}
              disabled={variantSaving}
              className="w-full mt-4 bg-[#ef233c] text-white font-bold py-3 rounded-xl hover:bg-[#d90429] transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {variantSaving && <Spinner size="xs" delayMs={0} decorative />}
              {variantSaving ? (dir === 'rtl' ? 'جارٍ الحفظ...' : 'Saving...') : (dir === 'rtl' ? 'تأكيد' : 'Confirm')}
            </button>
          </div>
        </div>
      )}

      {/* Shipping Modal — the item's real shipping methods */}
      {shippingModalOpen && shippingItem && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-zinc-900 w-full max-w-md rounded-t-2xl p-5 border-t border-zinc-800 flex flex-col gap-4 animate-in slide-in-from-bottom-full duration-300">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-white font-bold text-[17px]">{dir === 'rtl' ? 'طريقة الشحن' : 'Shipping Method'}</h3>
                <p className="text-zinc-400 text-sm mt-1">{dir === 'rtl' ? 'اختر طريقة الشحن المفضلة لهذا المنتج' : 'Choose your preferred shipping method for this item'}</p>
              </div>
              <button onClick={() => setShippingModalOpen(false)} className="p-2 bg-zinc-800 rounded-full hover:bg-zinc-700 text-zinc-300">
                <X className="w-5 h-5" />
              </button>
            </div>

            {shippingError && (
              <p className="text-red-400 text-sm">{shippingError}</p>
            )}

            <div className="flex flex-col gap-3 mt-2">
              {(shippingItem.shipping_methods ?? []).map((sm) => {
                const globalMethod = cartShippingMethods.find((m) => m.id === sm.id);
                const title = globalMethod
                  ? (dir === 'rtl' ? globalMethod.titleAr : globalMethod.titleEn)
                  : sm.method || sm.id;
                const desc = globalMethod
                  ? (dir === 'rtl' ? globalMethod.descAr : globalMethod.descEn)
                  : sm.delivery_time || '';
                const active = shippingItem.shipping_method_id === sm.id;
                return (
                  <button
                    key={sm.id}
                    onClick={() => chooseShipping(shippingItem, sm.id)}
                    disabled={shippingSaving}
                    className={`flex items-start justify-between p-4 rounded-xl border transition-all text-left w-full disabled:opacity-60 ${active ? 'border-[#ef233c] bg-[#ef233c]/10' : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'}`}
                  >
                    <div className="flex-1">
                      <p className={`font-bold text-[15px] ${active ? 'text-[#ef233c]' : 'text-zinc-200'}`}>
                        {title}
                      </p>
                      {desc && (
                        <p className="text-zinc-500 text-xs mt-1">{desc}</p>
                      )}
                      {typeof sm.price_iqd === 'number' && sm.price_iqd > 0 && (
                        <p className={`text-[13px] mt-1.5 font-bold ${active ? 'text-[#ef233c]' : 'text-zinc-300'}`}>
                          {formatIqd(sm.price_iqd)}
                        </p>
                      )}
                    </div>
                    <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5 ${active ? 'border-[#ef233c]' : 'border-zinc-600'}`}>
                      {active && <div className="w-2.5 h-2.5 rounded-full bg-[#ef233c]"></div>}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
