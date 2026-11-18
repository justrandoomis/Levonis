/**
 * THE STORE'S CART SHEET — what the dock's cart icon slides up (owner,
 * 2026-11-18: «a slide-up page, Apple design, with products from this store
 * only»).
 *
 * An iOS sheet: the shared Sheet v2 (src/components/ui/Sheet.tsx) with a
 * grabber, resting at half the screen and dragged up to all of it, the body
 * scrolling on its own, dismissed by a flick down, the scrim or Escape. A
 * large title, the store's name under it, the lines as cards, and the subtotal
 * with «إتمام الطلب» pinned at the bottom.
 *
 * ONLY THIS STORE'S LINES (route.tsx `storeLines`). A cart holds one seller at
 * a time; when it is locked to another shop, the sheet says so and offers the
 * full cart instead of listing someone else's goods here.
 *
 * The lines are edited through the merchant cart's own doors (the same as
 * /cart's MerchantCartView): quantity, remove, and the server's verdict on a
 * line that cannot be bought. Every price is the server's.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, ShoppingBag, X } from 'lucide-react';
import { useAuth } from '../../AuthContext';
import { useLanguage } from '../../LanguageContext';
import { ApiError } from '../../lib/api';
import { storeCheckoutApi, iqd, type MerchantCartData, type MerchantCartLine } from '../../lib/merchant';
import { apiRefusal } from '../../lib/refusalStrings';
import { LINE_QTY_MAX } from '../../../packages/pricing/src/quantity';
import { Sheet } from '../ui/Sheet';
import { QuantityInput } from '../ui/QuantityInput';
import VariantImg from '../ui/VariantImg';
import { announceStoreCartChanged, storeLines, storeUnits } from './route';

export default function StoreCartSheet({
  storeId,
  open,
  onClose,
  onCount,
}: {
  storeId: string;
  open: boolean;
  onClose: () => void;
  /** This store's units after every read or edit — the dock's badge. */
  onCount: (n: number) => void;
}) {
  const { loc, dir, lang } = useLanguage();
  const { user } = useAuth();
  const navigate = useNavigate();
  const titleId = useId();
  const [cart, setCart] = useState<MerchantCartData | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const take = useCallback(
    (d: MerchantCartData) => {
      setCart(d);
      setFailed(false);
      onCount(storeUnits(d, storeId));
    },
    [onCount, storeId]
  );

  useEffect(() => {
    if (!open || !user) return;
    let alive = true;
    storeCheckoutApi
      .cart()
      .then((d) => alive && take(d))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [open, user, take]);

  const failText = loc('تعذّر التحديث', 'Could not update', 'نەتوانرا');
  async function setQty(id: string, qty: number) {
    setBusy(id);
    setError('');
    try {
      take(await storeCheckoutApi.setQty(id, qty));
      announceStoreCartChanged();
    } catch (e) {
      // Fewer left than asked for: the line takes what there is (the cart page's rule).
      const left =
        e instanceof ApiError && (e.code === 'OUT_OF_STOCK' || e.code === 'QTY_UNAVAILABLE')
          ? Number(e.details?.available ?? e.details?.max_qty)
          : NaN;
      if (Number.isInteger(left) && left >= 1 && left < qty) {
        try {
          take(await storeCheckoutApi.setQty(id, left));
          setError(apiRefusal(e, lang, ''));
          return;
        } catch {
          /* the ordinary refusal below */
        }
      }
      setError(apiRefusal(e, lang, failText));
    } finally {
      setBusy('');
    }
  }

  async function remove(id: string) {
    setBusy(id);
    setError('');
    try {
      take(await storeCheckoutApi.removeLine(id));
      announceStoreCartChanged();
    } catch (e) {
      setError(apiRefusal(e, lang, failText));
    } finally {
      setBusy('');
    }
  }

  const lines: MerchantCartLine[] = storeLines(cart, storeId);
  const otherStore = !!cart?.store && cart.store.id !== storeId && cart.items.length > 0 ? cart.store.name : null;
  const subtotal = lines.reduce((n, l) => n + l.line_total_iqd, 0);
  const allAvailable = lines.every((l) => l.available);
  const unitsOf = (productId: string) => lines.filter((i) => i.product_id === productId).reduce((n, i) => n + i.qty, 0);
  const nameOf = (l: MerchantCartLine) => (lang === 'ar' ? l.name_ar || l.name : l.name || l.name_ar);
  const go = (to: string) => {
    onClose();
    navigate(to);
  };

  const body = () => {
    if (!user) {
      return (
        <div className="py-10 text-center">
          <ShoppingBag className="w-10 h-10 text-text-muted mx-auto mb-4" strokeWidth={1.5} aria-hidden="true" />
          <p className="text-text-secondary text-[13px] mb-4">
            {loc('سجّل الدخول لترى سلتك', 'Sign in to see your cart') /* OWNER: Sorani to be written by hand. */}
          </p>
          <button
            type="button"
            onClick={() => go(`/auth?next=${encodeURIComponent(window.location.pathname)}`)}
            className="lv-button lv-button-primary h-12 rounded-full px-6 text-[14px]"
          >
            {loc('تسجيل الدخول', 'Sign in', 'چوونەژوورەوە')}
          </button>
        </div>
      );
    }
    if (!cart) {
      return (
        <div className="py-10 flex justify-center" role={failed ? 'alert' : 'status'}>
          {failed ? (
            <p className="text-text-secondary text-[13px]">{loc('تعذّر تحميل السلة', 'Could not load the cart', 'نەتوانرا')}</p>
          ) : (
            <Loader2 className="w-6 h-6 text-gold animate-spin" aria-label={loc('جارٍ التحميل…', 'Loading…', 'باردەکرێت…')} />
          )}
        </div>
      );
    }
    if (!lines.length) {
      return (
        <div className="py-10 text-center">
          <ShoppingBag className="w-10 h-10 text-text-muted mx-auto mb-4" strokeWidth={1.5} aria-hidden="true" />
          <p className="text-text-secondary text-[13px]">
            {loc('لا توجد منتجات من هذا المتجر في سلتك', 'Nothing from this store in your cart yet') /* OWNER: Sorani to be written by hand. */}
          </p>
          {otherStore && (
            <>
              <p className="text-text-muted text-[11.5px] mt-2" dir="auto">
                {loc(`سلتك الآن فيها منتجات من «${otherStore}»`, `Your cart now holds items from «${otherStore}»`) /* OWNER: Sorani to be written by hand. */}
              </p>
              <button type="button" onClick={() => go('/cart')} className="lv-button lv-button-secondary min-h-11 text-[12.5px] mt-4">
                {loc('عرض السلة', 'View cart') /* OWNER: Sorani to be written by hand. */}
              </button>
            </>
          )}
        </div>
      );
    }
    return (
      <div className="space-y-2.5">
        {lines.map((l) => (
          <div key={l.cart_item_id} className="lv-surface p-2.5 flex gap-3" data-store-cart-line>
            <div className="w-[72px] h-[72px] rounded-lg bg-surface-raised overflow-hidden shrink-0">
              {l.images[0] && <VariantImg sizes="72px" src={l.images[0]} alt="" className="w-full h-full object-cover" />}
            </div>
            <div className="min-w-0 flex-1 flex flex-col">
              <p className="text-text-primary text-[12.5px] font-semibold line-clamp-2 leading-snug" dir="auto">
                {nameOf(l)}
              </p>
              {l.variant && <p className="text-text-muted text-[11px] truncate">{l.variant}</p>}
              <div className="flex items-baseline gap-1.5 mt-0.5" dir="ltr">
                <span className="text-gold font-bold text-[13px]">{iqd(l.unit_price_iqd)}</span>
                {l.original_price_iqd && l.original_price_iqd > l.unit_price_iqd && (
                  <span className="text-text-muted text-[10.5px] line-through">{iqd(l.original_price_iqd)}</span>
                )}
              </div>
              {!l.available && (
                <span className="text-amber-400 text-[10.5px] font-bold mt-0.5">
                  {loc('غير متوفر حاليًا — احذفه لإتمام الطلب', 'Unavailable — remove it to check out', 'بەردەست نییە')}
                </span>
              )}
              <div className="flex items-center justify-between mt-auto pt-1.5">
                <QuantityInput
                  size="sm"
                  hintPlacement="above"
                  value={l.qty}
                  max={l.stock === null ? LINE_QTY_MAX : Math.min(LINE_QTY_MAX, Math.max(1, l.stock - (unitsOf(l.product_id) - l.qty)))}
                  limitKind={l.stock === null ? 'per_order' : 'stock'}
                  disabled={busy === l.cart_item_id}
                  onChange={(next) => setQty(l.cart_item_id, next)}
                />
                <button
                  type="button"
                  onClick={() => remove(l.cart_item_id)}
                  disabled={busy === l.cart_item_id}
                  className="min-h-10 px-2 text-text-muted hover:text-text-primary text-[11.5px] font-bold disabled:opacity-40"
                >
                  {loc('حذف', 'Remove', 'سڕینەوە')}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      detents={['medium', 'large']}
      panelClassName="sm:max-w-[620px] sm:w-[92vw]"
      testId="store-cart-sheet"
      header={
        <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-2 pb-2 pt-1" dir={dir}>
          <div className="min-w-0 px-2">
            <h2 id={titleId} className="min-w-0 break-words text-[16px] font-extrabold text-text-primary">
              {loc('السلة', 'Cart', 'سەبەتە')}
            </h2>
            {cart?.store && cart.store.id === storeId && (
              <p className="text-text-muted text-[11px] truncate" dir="auto">
                {cart.store.name}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={loc('إغلاق', 'Close', 'داخستن')}
            className="grid size-11 shrink-0 place-items-center rounded-full text-text-primary hover:bg-surface-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <X aria-hidden="true" className="size-5" />
          </button>
        </div>
      }
      footer={
        lines.length > 0 ? (
          <div className="px-4 pb-3 pt-2" dir={dir}>
            <div className="flex items-center gap-3">
              <div className="min-w-0">
                <p className="text-text-muted text-[10.5px]">{loc('المجموع', 'Subtotal', 'کۆ')}</p>
                <p className="text-text-primary font-bold text-[15px]" dir="ltr">
                  {iqd(subtotal)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => go('/store-checkout')}
                disabled={!allAvailable}
                className="lv-button lv-button-primary flex-1 h-12 rounded-full text-[14px]"
              >
                {loc('إتمام الطلب', 'Checkout', 'تەواوکردن')}
              </button>
            </div>
            <p className="text-text-muted text-[10.5px] mt-1.5">
              {loc(
                'أجرة التوصيل وكوبونات المتجر تُحسب في صفحة إتمام الطلب.',
                'Delivery and store coupons are applied at checkout.',
                'گەیاندن و کۆبۆن لە پەڕەی داواکاری دەژمێردرێن.'
              )}
            </p>
          </div>
        ) : null
      }
    >
      <div className="px-4 pb-4 pt-3" dir={dir}>
        {error && (
          <div role="alert" className="lv-alert lv-alert-danger mb-3">
            <p className="text-red-300 text-[12px]">{error}</p>
          </div>
        )}
        {body()}
      </div>
    </Sheet>
  );
}
