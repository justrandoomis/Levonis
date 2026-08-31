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
 *     choose deliberately.
 *
 * The clearing happens as ONE request (the add is re-sent with replaceCart),
 * so a cart can never be left emptied with nothing added because a second
 * call failed.
 */

import { Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
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

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-4"
        onClick={onCancel}
      >
        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 24, scale: 0.98 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-sm rounded-[24px] border border-white/10 bg-[#0f0f0f] p-5 shadow-[0_20px_60px_-15px_rgba(0,0,0,0.8)]"
        >
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
              {loc('العودة إلى سلتي', 'Go to my cart', 'گەڕانەوە بۆ سەبەتەکەم')}
            </Link>

            {/* Destructive, and deliberately not the default. */}
            <button
              onClick={onReplace}
              disabled={busy}
              className="w-full min-h-[48px] rounded-2xl border border-red-500/30 bg-red-500/10 text-red-300 font-semibold text-[13.5px] active:scale-[0.98] transition-transform disabled:opacity-50"
            >
              {busy
                ? loc('جارٍ…', 'Working…', 'لە کارکردندا…')
                : loc('أفرغ السلة وابدأ من هنا', 'Clear the cart and shop here', 'سەبەتە بەتاڵ بکە و لێرە دەست پێ بکە')}
            </button>

            <button
              onClick={onCancel}
              disabled={busy}
              className="w-full min-h-[44px] rounded-2xl text-zinc-500 font-semibold text-[13px] disabled:opacity-50"
            >
              {loc('إلغاء', 'Cancel', 'هەڵوەشاندنەوە')}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
