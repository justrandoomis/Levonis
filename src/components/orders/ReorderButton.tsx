/**
 * "Buy again": every line of the order goes back into the cart with the
 * SELECTION that was bought — option, colour, transport, warranty plan —
 * through the same POST /api/cart/items the product page uses, one line at a
 * time so a failure is named per line and never hides behind the others.
 *
 * ONE SHIPPING TYPE PER CART is the server's rule (cart.ts). When the first
 * line is refused with CART_SHIPPING_CONFLICT or CART_SELLER_CONFLICT and
 * nothing has been added yet, the customer is offered the one honest way
 * through: `replaceCart: true` on that first line, which empties the cart and
 * adds in the same request. Once a line is in, later lines never carry the
 * flag — they would wipe what was just added.
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { RotateCcw, ShoppingCart, AlertTriangle } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import type { ApiOrderItem } from '../../lib/api';
import { useLanguage } from '../../LanguageContext';
import Spinner from '../ui/Spinner';
import { asLang } from './format';

const STRINGS = {
  ar: {
    buyAgain: 'إعادة الشراء',
    adding: 'جارٍ الإضافة إلى السلة…',
    conflictTitle: 'سلتك تحوي نوع شحن مختلفًا',
    conflictBody: (cart: string, incoming: string) => `سلتك الحالية (${cart}) لا يمكن أن تُجمع مع هذا الطلب (${incoming}). يمكنك تفريغ السلة وإضافة هذا الطلب، أو الإبقاء على سلتك.`,
    sellerConflict: 'سلتك تحوي منتجات من متجر آخر. يمكنك تفريغها وإضافة هذا الطلب، أو الإبقاء عليها.',
    replace: 'تفريغ السلة والإضافة',
    keep: 'الإبقاء على سلتي',
    partial: 'أُضيفت بعض المنتجات، وتعذّرت إضافة ما يلي:',
    none: 'تعذّرت إضافة أي منتج:',
    gone: 'المنتج لم يعد متاحًا',
    goCart: 'الانتقال إلى السلة',
    types: { direct: 'مباشر', preorder_air: 'طلب مسبق جوي', preorder_sea: 'طلب مسبق بحري', preorder_land: 'طلب مسبق بري' } as Record<string, string>,
    failed: 'تعذّرت الإضافة',
  },
  en: {
    buyAgain: 'Buy again',
    adding: 'Adding to cart…',
    conflictTitle: 'Your cart holds a different shipping type',
    conflictBody: (cart: string, incoming: string) => `Your current cart (${cart}) cannot be combined with this order (${incoming}). You can empty the cart and add this order, or keep your cart as it is.`,
    sellerConflict: 'Your cart holds items from another store. You can empty it and add this order, or keep it.',
    replace: 'Empty cart and add',
    keep: 'Keep my cart',
    partial: 'Some items were added; these could not be:',
    none: 'No item could be added:',
    gone: 'Product no longer available',
    goCart: 'Go to cart',
    types: { direct: 'direct', preorder_air: 'air pre-order', preorder_sea: 'sea pre-order', preorder_land: 'land pre-order' } as Record<string, string>,
    failed: 'Could not add',
  },
  ckb: {
    buyAgain: 'دووبارە کڕین',
    adding: 'زیادکردن بۆ سەبەتە…',
    conflictTitle: 'سەبەتەکەت جۆری گەیاندنی جیاواز تێدایە',
    conflictBody: (cart: string, incoming: string) => `سەبەتەی ئێستات (${cart}) ناتوانرێت لەگەڵ ئەم داواکارییە (${incoming}) کۆبکرێتەوە. دەتوانیت سەبەتەکە بەتاڵ بکەیت و ئەم داواکارییە زیاد بکەیت، یان سەبەتەکەت بهێڵیتەوە.`,
    sellerConflict: 'سەبەتەکەت کاڵای فرۆشگایەکی دیکەی تێدایە. دەتوانیت بەتاڵی بکەیت و ئەم داواکارییە زیاد بکەیت، یان بیهێڵیتەوە.',
    replace: 'بەتاڵکردنی سەبەتە و زیادکردن',
    keep: 'سەبەتەکەم بهێڵەوە',
    partial: 'هەندێک کاڵا زیادکران؛ ئەمانە نەکران:',
    none: 'هیچ کاڵایەک زیاد نەکرا:',
    gone: 'کاڵاکە بەردەست نەماوە',
    goCart: 'بڕۆ بۆ سەبەتە',
    types: { direct: 'ڕاستەوخۆ', preorder_air: 'پێشداواکاری ئاسمانی', preorder_sea: 'پێشداواکاری دەریایی', preorder_land: 'پێشداواکاری وشکانی' } as Record<string, string>,
    failed: 'زیاد نەکرا',
  },
} as const;

interface LineResult {
  item: ApiOrderItem;
  ok: boolean;
  error?: string;
}

interface Conflict {
  code: string;
  message: string;
  cartType?: string;
  incomingType?: string;
}

function cartBody(it: ApiOrderItem, replaceCart: boolean): Record<string, unknown> {
  const sel = it.selection;
  const body: Record<string, unknown> = { productId: it.product_id, qty: it.qty };
  if (sel?.option_id) body.optionId = sel.option_id;
  if (sel?.option_value_ids && sel.option_value_ids.length > 0) body.optionValueIds = sel.option_value_ids;
  if (sel?.color_id) body.colorId = sel.color_id;
  if (sel?.transport_method) body.transportMethod = sel.transport_method;
  if (sel?.warranty_plan_id) body.warrantyPlanId = sel.warranty_plan_id;
  if (replaceCart) body.replaceCart = true;
  return body;
}

export default function ReorderButton({ items, className = '' }: { items: ApiOrderItem[]; className?: string }) {
  const { lang } = useLanguage();
  const s = STRINGS[asLang(lang)];
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [results, setResults] = useState<LineResult[] | null>(null);

  const run = async (replace: boolean) => {
    if (busy) return;
    setBusy(true);
    setConflict(null);
    setResults(null);
    const out: LineResult[] = [];
    let addedAny = false;
    for (const it of items) {
      if (!it.product_id) {
        out.push({ item: it, ok: false, error: s.gone });
        continue;
      }
      try {
        await api.post('/api/cart/items', cartBody(it, replace && !addedAny));
        out.push({ item: it, ok: true });
        addedAny = true;
      } catch (e) {
        const isConflict = e instanceof ApiError && (e.code === 'CART_SHIPPING_CONFLICT' || e.code === 'CART_SELLER_CONFLICT');
        if (isConflict && !addedAny) {
          // Nothing is in the cart from this order yet, so replacing it is a
          // clean choice — offered, never assumed.
          const err = e as ApiError;
          setConflict({
            code: err.code ?? '',
            message: err.message,
            cartType: typeof err.details?.cart_shipping_type === 'string' ? err.details.cart_shipping_type : undefined,
            incomingType: typeof err.details?.incoming_shipping_type === 'string' ? err.details.incoming_shipping_type : undefined,
          });
          setBusy(false);
          return;
        }
        out.push({ item: it, ok: false, error: e instanceof Error && e.message ? e.message : s.failed });
      }
    }
    setBusy(false);
    const failed = out.filter((r) => !r.ok);
    if (addedAny && failed.length === 0) {
      navigate('/cart');
      return;
    }
    setResults(out);
  };

  const typeName = (t?: string) => (t && s.types[t]) || t || '';
  const failed = results?.filter((r) => !r.ok) ?? [];
  const addedAny = results?.some((r) => r.ok) ?? false;

  return (
    <div className={className} data-reorder>
      <button
        type="button"
        onClick={() => run(false)}
        disabled={busy || items.length === 0}
        data-buy-again
        className="w-full min-h-[46px] rounded-xl bg-[#ef233c] text-white text-[13.5px] font-bold hover:brightness-110 transition-[filter] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-60 inline-flex items-center justify-center gap-2"
      >
        {busy ? <Spinner size="sm" delayMs={0} decorative className="text-white" /> : <RotateCcw className="w-4 h-4" aria-hidden />}
        {busy ? s.adding : s.buyAgain}
      </button>

      <div role="status" aria-live="polite">
        {conflict && (
          <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
            <p className="text-amber-200 text-[13px] font-bold inline-flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4" aria-hidden />
              {s.conflictTitle}
            </p>
            <p className="text-amber-100/80 text-[12.5px] mt-1 leading-relaxed">
              {conflict.code === 'CART_SELLER_CONFLICT'
                ? s.sellerConflict
                : conflict.cartType && conflict.incomingType
                  ? s.conflictBody(typeName(conflict.cartType), typeName(conflict.incomingType))
                  : conflict.message}
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => setConflict(null)}
                className="flex-1 min-h-[40px] rounded-lg border border-zinc-700 text-zinc-200 text-[12.5px] font-bold hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
              >
                {s.keep}
              </button>
              <button
                type="button"
                onClick={() => run(true)}
                data-replace-cart
                className="flex-1 min-h-[40px] rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-100 text-[12.5px] font-bold hover:bg-amber-500/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
              >
                {s.replace}
              </button>
            </div>
          </div>
        )}

        {results && failed.length > 0 && (
          <div className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3">
            <p className="text-red-200 text-[12.5px] font-bold">{addedAny ? s.partial : s.none}</p>
            <ul className="mt-1.5 flex flex-col gap-1">
              {failed.map((r) => (
                <li key={r.item.id} className="text-[12px] text-red-100/80 truncate">
                  <span className="text-red-100">{r.item.name}</span> — {r.error}
                </li>
              ))}
            </ul>
            {addedAny && (
              <Link
                to="/cart"
                className="mt-3 inline-flex items-center gap-1.5 min-h-[40px] px-3 rounded-lg border border-zinc-700 text-zinc-200 text-[12.5px] font-bold hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
              >
                <ShoppingCart className="w-3.5 h-3.5" aria-hidden />
                {s.goCart}
              </Link>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
