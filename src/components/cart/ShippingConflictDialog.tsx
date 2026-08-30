/**
 * "السلة الحالية تحتوي منتجات بنوع شحن مختلف. يجب إفراغ السلة لإضافة هذا المنتج."
 *
 * The owner wrote that sentence and the two buttons under it, so both are
 * here verbatim rather than paraphrased. The dialog appears only when the
 * SERVER refuses an add with CART_SHIPPING_CONFLICT — the client never
 * pre-judges the cart, because a cart read a second ago can already be stale
 * (another tab, another device) and a client-side guess would either block a
 * legal add or let an illegal one through to a 400 the customer never asked
 * for.
 *
 * Portalled to document.body: the product page sits inside transformed and
 * backdrop-filtered ancestors, under which `position: fixed` stops meaning
 * "the viewport" and the overlay would be clipped into a corner.
 */
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';
import { shippingTypeLabel } from '../../lib/shippingType';

const STRINGS = {
  ar: {
    title: 'نوع شحن مختلف',
    body: 'السلة الحالية تحتوي منتجات بنوع شحن مختلف. يجب إفراغ السلة لإضافة هذا المنتج.',
    current: 'نوع السلة الحالية',
    incoming: 'نوع هذا المنتج',
    confirm: 'إفراغ السلة وإضافة المنتج',
    cancel: 'إلغاء',
    working: 'جارٍ التنفيذ…',
  },
  en: {
    title: 'A different shipping type',
    body: 'Your cart holds products with a different shipping type. It must be emptied before this product can be added.',
    current: 'Cart shipping type',
    incoming: 'This product',
    confirm: 'Empty the cart and add the product',
    cancel: 'Cancel',
    working: 'Working…',
  },
  ckb: {
    title: 'جۆرێکی گەیاندنی جیاواز',
    body: 'سەبەتەکەت بەرهەمی جۆری گەیاندنی جیاوازی تێدایە. پێویستە بەتاڵ بکرێتەوە بۆ زیادکردنی ئەم بەرهەمە.',
    current: 'جۆری سەبەتە',
    incoming: 'ئەم بەرهەمە',
    confirm: 'سەبەتە بەتاڵ بکەرەوە و بەرهەمەکە زیاد بکە',
    cancel: 'پاشگەزبوونەوە',
    working: 'جێبەجێ دەکرێت…',
  },
} as const;

export interface ShippingConflictDialogProps {
  open: boolean;
  lang: string;
  dir: 'rtl' | 'ltr';
  /** From the server's refusal details — may be absent on an old build. */
  cartType?: unknown;
  incomingType?: unknown;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ShippingConflictDialog({
  open,
  lang,
  dir,
  cartType,
  incomingType,
  busy = false,
  onConfirm,
  onCancel,
}: ShippingConflictDialogProps) {
  if (!open) return null;
  const s = STRINGS[(lang as keyof typeof STRINGS) in STRINGS ? (lang as keyof typeof STRINGS) : 'ar'];
  const currentLabel = shippingTypeLabel(cartType, lang);
  const incomingLabel = shippingTypeLabel(incomingType, lang);

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-end sm:items-center justify-center bg-black/80 backdrop-blur-sm p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shipping-conflict-title"
      dir={dir}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        data-shipping-conflict
        className="w-full sm:max-w-md bg-zinc-950 border border-zinc-800 rounded-t-3xl sm:rounded-3xl p-5 sm:p-6 shadow-2xl"
      >
        <div className="flex items-start gap-3">
          <span className="shrink-0 w-11 h-11 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center">
            <AlertTriangle className="w-5 h-5 text-amber-400" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 id="shipping-conflict-title" className="text-white font-bold text-base sm:text-lg">
              {s.title}
            </h2>
            <p className="text-zinc-300 text-sm mt-1.5 leading-relaxed">{s.body}</p>
          </div>
        </div>

        {/* Only rendered when the server actually named the two types — an
            older worker build would omit details, and an empty row reading
            "Cart shipping type: —" tells the customer nothing. */}
        {(currentLabel || incomingLabel) && (
          <dl className="mt-4 rounded-2xl bg-zinc-900/70 border border-zinc-800 divide-y divide-zinc-800 text-sm">
            {currentLabel && (
              <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                <dt className="text-zinc-400">{s.current}</dt>
                <dd className="text-white font-semibold">{currentLabel}</dd>
              </div>
            )}
            {incomingLabel && (
              <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                <dt className="text-zinc-400">{s.incoming}</dt>
                <dd className="text-white font-semibold">{incomingLabel}</dd>
              </div>
            )}
          </dl>
        )}

        <div className="mt-5 flex flex-col-reverse sm:flex-row gap-2.5">
          <button
            type="button"
            data-shipping-conflict-cancel
            onClick={onCancel}
            disabled={busy}
            className="flex-1 min-h-[48px] rounded-2xl border border-zinc-700 text-zinc-200 font-semibold hover:bg-zinc-900 disabled:opacity-50 transition-colors"
          >
            {s.cancel}
          </button>
          <button
            type="button"
            data-shipping-conflict-confirm
            onClick={onConfirm}
            disabled={busy}
            className="flex-1 min-h-[48px] rounded-2xl bg-white text-black font-bold hover:bg-zinc-200 disabled:opacity-50 transition-colors"
          >
            {busy ? s.working : s.confirm}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
