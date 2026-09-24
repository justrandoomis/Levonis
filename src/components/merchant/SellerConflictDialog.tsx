/**
 * "Your cart has items from another store."
 *
 * §14 is unusually specific about this moment, and for good reason: a cart is
 * work a customer has already done. The rules it sets are all about not
 * throwing that work away:
 *
 *   - NEVER silently clear a cart. The server refuses the add outright unless
 *     the request carries `replaceCart: true`, which only this dialogue sets.
 *   - Name BOTH shops. "Items from another store" makes the customer guess
 *     which of the shops they were browsing is in the way.
 *   - Offer both real ways out — go back to what is already there, or clear
 *     it and start here — and make the destructive one the one you have to
 *     choose deliberately. The two labels are the owner's own words
 *     (docs/MERCHANT_PLATFORM.md §2 decision 1).
 *
 * The clearing happens as ONE request (the add is re-sent with replaceCart),
 * so a cart can never be left emptied with nothing added because a second
 * call failed.
 */

import { Link } from 'react-router-dom';
import { Overlay } from '../ui/Overlay';
import { ShoppingBag, AlertTriangle } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';

export interface SellerConflict {
  cart_seller_name: string | null;
  incoming_seller_name: string | null;
  cart_seller_type: string;
}

export default function SellerConflictDialog({
  conflict,
  onCancel,
  onReplace,
  busy,
}: {
  conflict: SellerConflict | null;
  onCancel: () => void;
  onReplace: () => void;
  busy?: boolean;
}) {
  const { loc } = useLanguage();
  if (!conflict) return null;

  // A name if the server gave one; otherwise a truthful generic. Never a
  // fabricated shop name.
  const current =
    conflict.cart_seller_name ||
    (conflict.cart_seller_type === 'levonis'
      ? 'LEVONIS'
      : loc('متجر آخر', 'another store', 'فرۆشگایەکی تر'));
  const incoming = conflict.incoming_seller_name || loc('هذا المتجر', 'this store', 'ئەم فرۆشگایە');

  // THIS ONE MUST BE ANSWERED. It is the only window in the app that refuses
  // Escape and a scrim tap: both remaining choices change the cart, and
  // dismissing by accident would leave the customer looking at a store they
  // cannot buy from with no idea why. Everything else — the arrival, the
  // symmetric exit, the material, the reduced-motion cross-fade — comes from
  // the shared primitive, so this file is now only the decision it asks.
  return (
    <Overlay
      open
      onClose={onCancel}
      label={loc('سلتك تخص متجرًا آخر', 'Your cart belongs to another store', 'سەبەتەکەت هی فرۆشگایەکی ترە')}
      placement="bottom"
      z={100}
      dismissOnEscape={false}
      dismissOnScrim={false}
      testId="seller-conflict"
      panelClassName="w-full max-w-sm"
    >
        <div className="p-5">
          <div className="w-11 h-11 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center mb-4">
            <AlertTriangle className="w-5 h-5 text-amber-400" />
          </div>

          <h2 className="text-white font-bold text-[16px] mb-2">
            {loc('سلتك تخص متجرًا آخر', 'Your cart belongs to another store', 'سەبەتەکەت هی فرۆشگایەکی ترە')}
          </h2>

          <p className="text-zinc-400 text-[13px] leading-relaxed mb-5">
            {loc(
              `سلتك تحتوي على منتجات من ${current}. للشراء من ${incoming}، أكمل طلبك الحالي أو أفرغ السلة.`,
              `Your cart currently contains items from ${current}. To shop from ${incoming}, complete the current order or clear the cart first.`,
              `سەبەتەکەت بەرهەمی ${current} تێدایە. بۆ کڕین لە ${incoming}، سەرەتا داواکارییەکەت تەواو بکە یان سەبەتەکە بەتاڵ بکە.`
            )}
          </p>

          <div className="space-y-2">
            {/* The safe option first, and visually primary. */}
            <Link
              to="/cart"
              className="w-full min-h-[48px] rounded-2xl bg-olive text-white font-bold text-[14px] flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
            >
              <ShoppingBag className="w-4 h-4" />
              {loc('العودة إلى السلة الحالية', 'Back to my current cart', 'گەڕانەوە بۆ سەبەتەکەم')}
            </Link>

            {/* Destructive, and deliberately not the default. */}
            <button
              onClick={onReplace}
              disabled={busy}
              className="w-full min-h-[48px] rounded-2xl border border-red-500/30 bg-red-500/10 text-red-300 font-semibold text-[13.5px] active:scale-[0.98] transition-transform disabled:opacity-50"
            >
              {busy
                ? loc('جارٍ…', 'Working…', 'لە کارکردندا…')
                : loc('إفراغ السلة والتحول للبائع الجديد', 'Empty the cart and switch to this seller', 'سەبەتە بەتاڵ بکە و لێرە دەست پێ بکە')}
            </button>

            <button
              onClick={onCancel}
              disabled={busy}
              className="w-full min-h-[44px] rounded-2xl text-zinc-500 font-semibold text-[13px] disabled:opacity-50"
            >
              {loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە')}
            </button>
          </div>
        </div>
    </Overlay>
  );
}
