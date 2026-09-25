/**
 * The cart when it belongs to a MERCHANT store (§14: one cart infrastructure,
 * two renderings). The `scope` on `GET /api/cart` decides which view the /cart
 * route shows; this is the merchant one — the shop's name on top, the shop's
 * own delivery terms at checkout, and every price from the server.
 *
 * A LINE THAT CANNOT BE BOUGHT SAYS WHY (audit 02 B25). The server answers
 * each line with the checkout's own verdict — hidden, sold out, the option
 * gone, the store closed, your own store, another store — and the line shows
 * it with the one thing to do about it, instead of a checkout button that
 * works until the last tap.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2, Minus, Plus, RotateCw, ShoppingCart, Store, Trash2 } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { storeCheckoutApi, iqd, type MerchantCartData, type MerchantCartLine } from '../../lib/merchant';
import { apiRefusal } from '../../lib/refusalStrings';
import { useFreshOnReturn } from '../../lib/useFreshOnReturn';

export default function MerchantCartView() {
  const { loc, dir, lang } = useLanguage();
  const navigate = useNavigate();
  const [cart, setCart] = useState<MerchantCartData | null>(null);
  /** The first read failed: say so and offer a retry — never «your cart is empty». */
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    storeCheckoutApi
      .cart()
      .then((d) => {
        setCart(d);
        setLoadFailed(false);
      })
      // A background refresh that fails keeps the cart on screen; only a
      // cart that never loaded shows the failure.
      .catch(() => setLoadFailed(true));
  }, []);
  useEffect(load, [load]);
  // Same rule as the platform cart: the merchant's prices are re-read when the
  // customer comes back to this screen, so a shop that changed a price is not
  // held to the old one by a tab that was never closed.
  useFreshOnReturn(load, { enabled: !busy, minIntervalMs: 8_000, pollWhileVisibleMs: 60_000 });

  async function setQty(id: string, qty: number) {
    setBusy(id);
    setError('');
    try {
      const d = await storeCheckoutApi.setQty(id, qty);
      setCart(d);
    } catch (e) {
      // The refusal's code in the customer's language — «only 2 left» with the
      // number — never the server's English sentence.
      setError(apiRefusal(e, lang, loc('تعذّر التحديث', 'Could not update', 'نەتوانرا')));
      load();
    } finally {
      setBusy('');
    }
  }

  async function remove(id: string) {
    setBusy(id);
    setError('');
    try {
      const d = await storeCheckoutApi.removeLine(id);
      setCart(d);
    } catch (e) {
      setError(apiRefusal(e, lang, loc('تعذّر التحديث', 'Could not update', 'نەتوانرا')));
      load();
    } finally {
      setBusy('');
    }
  }

  /** The line's own reason, and what to do about it. */
  function blockedText(l: MerchantCartLine): string {
    switch (l.unavailable_reason) {
      case 'out_of_stock':
        // OWNER: Sorani to be written by hand.
        return l.stock && l.stock > 0
          ? loc(`المتوفر ${l.stock} فقط — قلّل الكمية أو احذفه`, `Only ${l.stock} in stock — lower the quantity or remove it`)
          : loc('نفد من المخزون — احذفه لإتمام الطلب', 'Sold out — remove it to check out');
      case 'option_gone':
        // OWNER: Sorani to be written by hand.
        return loc('الخيار الذي اخترته لم يعد متاحًا — احذفه ثم أضفه من جديد', 'The option you chose is no longer offered — remove it, then add it again');
      case 'store_closed':
        // OWNER: Sorani to be written by hand.
        return loc('المتجر لا يستقبل طلبات حاليًا', 'The store is not taking orders right now');
      case 'own_store':
        // OWNER: Sorani to be written by hand.
        return loc('هذا من متجرك — لا يمكنك شراؤه', 'This is from your own store — you cannot buy it');
      case 'other_store':
        // OWNER: Sorani to be written by hand.
        return loc('من متجر آخر — احذفه لإتمام الطلب', 'From another store — remove it to check out');
      default:
        return loc('غير متوفر حاليًا — احذفه لإتمام الطلب', 'Unavailable — remove it to check out', 'بەردەست نییە');
    }
  }

  if (!cart) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center px-6">
        {loadFailed ? (
          <div role="alert" className="text-center">
            <p className="text-zinc-400 text-[13px] mb-3">
              {loc('تعذّر تحميل السلة', 'Could not load the cart', 'نەتوانرا')}
            </p>
            <button
              type="button"
              onClick={() => {
                setLoadFailed(false);
                load();
              }}
              className="lv-button lv-button-secondary min-h-11 text-[12.5px]"
            >
              <RotateCw className="w-4 h-4" aria-hidden="true" />
              {/* OWNER: Sorani to be written by hand. */}
              {loc('إعادة المحاولة', 'Try again')}
            </button>
          </div>
        ) : (
          <div role="status" aria-label={loc('جارٍ التحميل…', 'Loading…', 'باردەکرێت…')}>
            <Loader2 className="w-6 h-6 text-gold animate-spin" aria-hidden="true" />
          </div>
        )}
      </div>
    );
  }

  const allAvailable = cart.items.every((i) => i.available);
  /** Every unit of one product across its option lines — what its stock is judged against. */
  const unitsOf = (productId: string) =>
    cart.items.filter((i) => i.product_id === productId).reduce((n, i) => n + i.qty, 0);

  return (
    <div className="min-h-screen bg-black text-zinc-300 pb-36">
      <div className="sticky top-0 z-30 bg-black/95 backdrop-blur border-b border-white/5 px-4 py-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate(-1)}
          aria-label={loc('رجوع', 'Back', 'گەڕانەوە')}
          className="w-11 h-11 rounded-xl border border-white/10 flex items-center justify-center text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <ArrowLeft className={`w-4 h-4 ${dir === 'rtl' ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
        <h1 className="text-white font-bold text-[15px]">{loc('السلة', 'Cart', 'سەبەتە')}</h1>
      </div>

      <div className="max-w-2xl mx-auto px-4 sm:px-6 pt-4">
        {error && (
          <div role="alert" className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 mb-3">
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
                    {l.variant && <p className="text-zinc-500 text-[11px] truncate">{l.variant}</p>}
                    <div className="flex items-baseline gap-1.5 mt-0.5" dir="ltr">
                      <span className="text-gold font-bold text-[13px]">{iqd(l.unit_price_iqd)}</span>
                      {l.original_price_iqd && l.original_price_iqd > l.unit_price_iqd && (
                        <span className="text-zinc-600 text-[10.5px] line-through">{iqd(l.original_price_iqd)}</span>
                      )}
                    </div>
                    {!l.available && (
                      <span className="text-amber-400 text-[10.5px] font-bold mt-0.5">{blockedText(l)}</span>
                    )}

                    <div className="flex items-center justify-between mt-auto pt-1.5">
                      <div className="flex items-center rounded-xl border border-white/10 bg-black/30">
                        <button
                          type="button"
                          onClick={() => (l.qty <= 1 ? remove(l.cart_item_id) : setQty(l.cart_item_id, l.qty - 1))}
                          disabled={busy === l.cart_item_id}
                          aria-label={l.qty <= 1 ? loc('حذف', 'Remove', 'سڕینەوە') : loc('إنقاص الكمية', 'Decrease quantity')}
                          className="w-10 h-10 flex items-center justify-center text-zinc-400 disabled:opacity-40"
                        >
                          {l.qty <= 1 ? <Trash2 className="w-3.5 h-3.5" aria-hidden="true" /> : <Minus className="w-3.5 h-3.5" aria-hidden="true" />}
                        </button>
                        <span className="w-7 text-center text-white text-[12.5px] font-bold tabular-nums" aria-live="polite">{l.qty}</span>
                        <button
                          type="button"
                          onClick={() => setQty(l.cart_item_id, Math.min(99, l.qty + 1))}
                          disabled={busy === l.cart_item_id || (l.stock !== null && unitsOf(l.product_id) >= l.stock)}
                          aria-label={loc('زيادة الكمية', 'Increase quantity')}
                          className="w-10 h-10 flex items-center justify-center text-zinc-400 disabled:opacity-40"
                        >
                          <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => remove(l.cart_item_id)}
                        disabled={busy === l.cart_item_id}
                        className="min-h-10 px-2 text-zinc-500 text-[11.5px] font-bold disabled:opacity-40"
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
        <div className="fixed bottom-0 inset-x-0 z-40 border-t border-white/10 bg-black/95 backdrop-blur-xl px-4 sm:px-6 py-3">
          <div className="max-w-2xl mx-auto flex items-center gap-3">
            <div className="min-w-0">
              <p className="text-zinc-500 text-[10.5px]">{loc('المجموع', 'Subtotal', 'کۆ')}</p>
              <p className="text-white font-bold text-[15px]" dir="ltr">{iqd(cart.subtotal_iqd)}</p>
            </div>
            <button
              type="button"
              onClick={() => navigate('/store-checkout')}
              disabled={!allAvailable}
              aria-describedby={allAvailable ? undefined : 'merchant-cart-blocked'}
              className="flex-1 h-12 rounded-2xl bg-olive text-snow font-bold text-[14px] disabled:opacity-40 active:scale-[0.99] transition-transform"
            >
              {loc('إتمام الطلب', 'Checkout', 'تەواوکردن')}
            </button>
          </div>
          {!allAvailable && (
            <p id="merchant-cart-blocked" className="max-w-2xl mx-auto text-amber-400/90 text-[11px] text-center mt-1.5">
              {/* OWNER: Sorani to be written by hand. */}
              {loc('عالج المنتجات المعلَّمة أعلاه لإتمام الطلب', 'Sort out the flagged items above to check out')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
