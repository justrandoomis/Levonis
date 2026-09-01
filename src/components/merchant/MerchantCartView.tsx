/**
 * The cart when it belongs to a MERCHANT store (§14: one cart infrastructure,
 * two renderings). `/api/cart/scope` decided which view the /cart route
 * shows; this is the merchant one — the shop's name on top, the shop's own
 * delivery terms at checkout, and every price from the server.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2, Minus, Plus, ShoppingCart, Store, Trash2 } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { ApiError } from '../../lib/api';
import { storeCheckoutApi, iqd, type MerchantCartData } from '../../lib/merchant';

export default function MerchantCartView() {
  const { loc, dir } = useLanguage();
  const navigate = useNavigate();
  const [cart, setCart] = useState<MerchantCartData | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    storeCheckoutApi
      .cart()
      .then(setCart)
      .catch(() => setCart({ scope: null, store: null, items: [], subtotal_iqd: 0 }));
  }, []);
  useEffect(load, [load]);

  async function setQty(id: string, qty: number) {
    setBusy(id);
    setError('');
    try {
      const d = await storeCheckoutApi.setQty(id, qty);
      setCart(d);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : loc('تعذّر التحديث', 'Could not update', 'نەتوانرا'));
      load();
    } finally {
      setBusy('');
    }
  }

  async function remove(id: string) {
    setBusy(id);
    try {
      const d = await storeCheckoutApi.removeLine(id);
      setCart(d);
    } finally {
      setBusy('');
    }
  }

  if (!cart) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-gold animate-spin" />
      </div>
    );
  }

  const allAvailable = cart.items.every((i) => i.available);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-300 pb-36">
      <div className="sticky top-0 z-30 bg-[#0a0a0a]/95 backdrop-blur border-b border-white/5 px-4 py-3 flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="w-9 h-9 rounded-xl border border-white/10 flex items-center justify-center text-zinc-300">
          <ArrowLeft className={`w-4 h-4 ${dir === 'rtl' ? 'rotate-180' : ''}`} />
        </button>
        <h1 className="text-white font-bold text-[15px]">{loc('السلة', 'Cart', 'سەبەتە')}</h1>
      </div>

      <div className="max-w-2xl mx-auto px-4 sm:px-6 pt-4">
        {error && (
          <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 mb-3">
            <p className="text-red-300 text-[12px]">{error}</p>
          </div>
        )}

        {!cart.items.length ? (
          <div className="py-20 text-center">
            <ShoppingCart className="w-10 h-10 text-zinc-700 mx-auto mb-4" />
            <p className="text-zinc-500 text-[13px]">{loc('سلتك فارغة', 'Your cart is empty', 'سەبەتەکەت بەتاڵە')}</p>
          </div>
        ) : (
          <>
            {cart.store && (
              <div className="flex items-center gap-2 mb-3">
                <Store className="w-4 h-4 text-gold" />
                <span className="text-white text-[13px] font-bold">{cart.store.name}</span>
                <span className="text-zinc-600 text-[11px]">
                  {loc('يبيعه ويشحنه هذا المتجر', 'Sold and shipped by this store', 'لەم فرۆشگایەوە')}
                </span>
              </div>
            )}

            <div className="space-y-2.5">
              {cart.items.map((l) => (
                <div key={l.cart_item_id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-2.5 flex gap-3">
                  <div className="w-[72px] h-[72px] rounded-xl bg-black/40 overflow-hidden shrink-0">
                    {l.images[0] && <img src={l.images[0]} alt="" className="w-full h-full object-cover" />}
                  </div>
                  <div className="min-w-0 flex-1 flex flex-col">
                    <p className="text-zinc-100 text-[12.5px] font-semibold line-clamp-2 leading-snug">{l.name}</p>
                    <div className="flex items-baseline gap-1.5 mt-0.5" dir="ltr">
                      <span className="text-gold font-bold text-[13px]">{iqd(l.unit_price_iqd)}</span>
                      {l.original_price_iqd && l.original_price_iqd > l.unit_price_iqd && (
                        <span className="text-zinc-600 text-[10.5px] line-through">{iqd(l.original_price_iqd)}</span>
                      )}
                    </div>
                    {!l.available && (
                      <span className="text-amber-400 text-[10.5px] font-bold mt-0.5">
                        {loc('غير متوفر حاليًا — احذفه لإتمام الطلب', 'Unavailable — remove it to check out', 'بەردەست نییە')}
                      </span>
                    )}

                    <div className="flex items-center justify-between mt-auto pt-1.5">
                      <div className="flex items-center rounded-xl border border-white/10 bg-black/30">
                        <button
                          onClick={() => (l.qty <= 1 ? remove(l.cart_item_id) : setQty(l.cart_item_id, l.qty - 1))}
                          disabled={busy === l.cart_item_id}
                          className="w-8 h-8 flex items-center justify-center text-zinc-400 disabled:opacity-40"
                        >
                          {l.qty <= 1 ? <Trash2 className="w-3.5 h-3.5" /> : <Minus className="w-3.5 h-3.5" />}
                        </button>
                        <span className="w-7 text-center text-white text-[12.5px] font-bold">{l.qty}</span>
                        <button
                          onClick={() => setQty(l.cart_item_id, Math.min(99, l.qty + 1))}
                          disabled={busy === l.cart_item_id || (l.stock !== null && l.qty >= l.stock)}
                          className="w-8 h-8 flex items-center justify-center text-zinc-400 disabled:opacity-40"
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <button
                        onClick={() => remove(l.cart_item_id)}
                        disabled={busy === l.cart_item_id}
                        className="text-zinc-500 text-[11.5px] font-bold disabled:opacity-40"
                      >
                        {loc('حذف', 'Remove', 'سڕینەوە')}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <p className="text-zinc-600 text-[10.5px] mt-3">
              {loc(
                'أجرة التوصيل وكوبونات المتجر تُحسب في صفحة إتمام الطلب.',
                'Delivery and store coupons are applied at checkout.',
                'گەیاندن و کۆبۆن لە پەڕەی داواکاری دەژمێردرێن.'
              )}
            </p>
          </>
        )}
      </div>

      {cart.items.length > 0 && (
        <div className="fixed bottom-0 inset-x-0 z-40 border-t border-white/10 bg-[#0a0a0a]/95 backdrop-blur-xl px-4 sm:px-6 py-3">
          <div className="max-w-2xl mx-auto flex items-center gap-3">
            <div className="min-w-0">
              <p className="text-zinc-500 text-[10.5px]">{loc('المجموع', 'Subtotal', 'کۆ')}</p>
              <p className="text-white font-bold text-[15px]" dir="ltr">{iqd(cart.subtotal_iqd)}</p>
            </div>
            <button
              onClick={() => navigate('/store-checkout')}
              disabled={!allAvailable}
              className="flex-1 h-12 rounded-2xl bg-olive text-white font-bold text-[14px] disabled:opacity-40 active:scale-[0.99] transition-transform"
            >
              {loc('إتمام الطلب', 'Checkout', 'تەواوکردن')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
