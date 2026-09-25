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
    codes: {
      OPTION_REQUIRED: 'يلزم اختيار خيار للمنتج أولًا',
      COLOR_REQUIRED: 'يلزم اختيار لون أولًا',
      TRANSPORT_REQUIRED: 'يلزم اختيار طريقة شحن للطلب المسبق',
      TRANSPORT_NOT_OFFERED: 'طريقة الشحن هذه لم تعد متاحة لهذا المنتج',
      SELECTION_INCOMPLETE: 'اختيار المنتج غير مكتمل — افتح صفحة المنتج واختر من جديد',
      CART_SHIPPING_CONFLICT: 'نوع شحنه يختلف عمّا في سلتك',
      CART_SELLER_CONFLICT: 'من متجر يختلف عمّا في سلتك',
      CART_WARRANTY_CONFLICT: 'هذه الطابعة في سلتك بخيار ضمان ممدد مختلف — غيّره من السلة',
      UNAVAILABLE: 'غير متاح للطلب حاليًا',
      OUT_OF_STOCK: 'نفدت الكمية',
      QTY_UNAVAILABLE: 'الكمية المطلوبة غير متاحة حاليًا',
    } as Record<string, string>,
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
    codes: {
      OPTION_REQUIRED: 'An option has to be chosen first',
      COLOR_REQUIRED: 'A colour has to be chosen first',
      TRANSPORT_REQUIRED: 'A shipping method has to be chosen for the pre-order',
      TRANSPORT_NOT_OFFERED: 'That shipping method is no longer offered for this product',
      SELECTION_INCOMPLETE: 'The selection is incomplete — open the product page and choose again',
      CART_SHIPPING_CONFLICT: 'Its shipping type differs from your cart',
      CART_SELLER_CONFLICT: 'It comes from a different store than your cart',
      CART_WARRANTY_CONFLICT: 'This printer is already in your cart with a different extended-warranty choice — change it from the cart',
      UNAVAILABLE: 'Not available to order right now',
      OUT_OF_STOCK: 'Out of stock',
      QTY_UNAVAILABLE: 'The requested quantity is not available right now',
    } as Record<string, string>,
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
    codes: {
      OPTION_REQUIRED: 'سەرەتا پێویستە هەڵبژاردەیەک هەڵبژێردرێت',
      COLOR_REQUIRED: 'سەرەتا پێویستە ڕەنگێک هەڵبژێردرێت',
      TRANSPORT_REQUIRED: 'پێویستە ڕێگای گەیاندن بۆ پێشداواکاری هەڵبژێردرێت',
      TRANSPORT_NOT_OFFERED: 'ئەم ڕێگای گەیاندنە بۆ ئەم کاڵایە بەردەست نەماوە',
      SELECTION_INCOMPLETE: 'هەڵبژاردنەکە تەواو نییە — پەڕەی کاڵاکە بکەرەوە و دووبارە هەڵبژێرە',
      CART_SHIPPING_CONFLICT: 'جۆری گەیاندنی لەگەڵ سەبەتەکەت جیاوازە',
      CART_SELLER_CONFLICT: 'لە فرۆشگایەکی جیاوازە لە سەبەتەکەت',
      CART_WARRANTY_CONFLICT: 'ئەم پرینتەرە پێشتر لە سەبەتەکەتدایە بە هەڵبژاردەیەکی جیاوازی گەرەنتی درێژکراوە — لە سەبەتەوە بیگۆڕە',
      UNAVAILABLE: 'ئێستا بۆ داواکردن بەردەست نییە',
      OUT_OF_STOCK: 'کۆگا بەتاڵە',
      QTY_UNAVAILABLE: 'ژمارەی داواکراو ئێستا بەردەست نییە',
    } as Record<string, string>,
  },
} as const;

type Strings = (typeof STRINGS)[keyof typeof STRINGS];

/**
 * Selection codes the resolver (pricing.ts / products.ts) can raise. Most
 * reach the client as the refusal's own `code`; a pricing-resolver failure
 * travels as code VALIDATION with the codes only inside the message
 * ("Invalid selection: TRANSPORT_REQUIRED"), so that message is scanned for
 * exactly these words.
 */
const SELECTION_CODES = ['OPTION_REQUIRED', 'COLOR_REQUIRED', 'TRANSPORT_REQUIRED', 'TRANSPORT_NOT_OFFERED', 'SELECTION_INCOMPLETE'] as const;

/**
 * A refused line is named in the customer's language when the server's code
 * is one this component knows; an unknown code keeps the server's own words —
 * a specific refusal in English beats a vague one in the right language.
 */
function lineError(e: unknown, s: Strings): string {
  if (e instanceof ApiError) {
    const known = e.code ? s.codes[e.code] : undefined;
    if (known) return known;
    if (e.code === 'NOT_FOUND' || e.status === 404) return s.gone;
    if (e.code === 'VALIDATION') {
      const hit = SELECTION_CODES.find((c) => new RegExp(`\\b${c}\\b`).test(e.message));
      if (hit) return s.codes[hit];
    }
    return e.message || s.failed;
  }
  return e instanceof Error && e.message ? e.message : s.failed;
}

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
        out.push({ item: it, ok: false, error: lineError(e, s) });
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
        className="w-full min-h-[46px] rounded-xl bg-[#ef233c] text-snow text-[13.5px] font-bold hover:brightness-110 transition-[filter] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-60 inline-flex items-center justify-center gap-2"
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
                className="flex-1 min-h-[40px] rounded-lg border border-zinc-700 text-zinc-200 text-[12.5px] font-bold hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
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
                className="mt-3 inline-flex items-center gap-1.5 min-h-[40px] px-3 rounded-lg border border-zinc-700 text-zinc-200 text-[12.5px] font-bold hover:bg-zinc-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
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
