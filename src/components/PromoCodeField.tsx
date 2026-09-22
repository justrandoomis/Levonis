/**
 * The promo-code box, working.
 *
 * IT USED TO SAY "قريباً" AND BE DISABLED — which was wrong twice over: the
 * validation engine has existed since migration 0002 (tiers, date windows,
 * global and per-user limits, fixed and percentage discounts, all enforced
 * server-side at checkout), and the only missing pieces were a way for an
 * admin to create a code and a box for a customer to type one into.
 *
 * WHAT THIS BOX PROMISES, AND WHAT IT DOES NOT. The cart has no address and
 * no delivery method yet, so the final discount cannot be known here. The
 * server answers the question it CAN answer — does the code exist, is it
 * live, is it for my tier, have I used it up — against the merchandise total
 * it computes itself, and returns the figure labelled as an estimate. The
 * checkout quote is the authority, and it re-checks before a single dinar
 * moves.
 *
 * The code is remembered in sessionStorage so it survives the walk from the
 * cart to the checkout. That is a convenience, not a grant: the checkout
 * re-validates it from scratch, and a code that stopped being valid in
 * between is refused there.
 */
import { useState } from 'react';
import { Tag, Check, X, Loader2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { mascot } from '../lib/mascot';
import { useMoney } from '../CurrencyContext';

export const PROMO_STORAGE_KEY = 'levonis.promo_code';

/** Reads the remembered code. Storage can throw in a private window. */
export function readStoredPromo(): string {
  try {
    return sessionStorage.getItem(PROMO_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function storePromo(code: string): void {
  try {
    if (code) sessionStorage.setItem(PROMO_STORAGE_KEY, code);
    else sessionStorage.removeItem(PROMO_STORAGE_KEY);
  } catch {
    /* a private window refuses; the code simply is not remembered */
  }
}

interface CheckResult {
  valid: boolean;
  code?: string;
  reason?: string;
  estimated_discount_iqd?: number;
  min_total_iqd?: number | null;
  tier_required?: string | null;
  cart_total_iqd?: number;
}

const STRINGS = {
  ar: {
    label: 'كود الخصم',
    placeholder: 'أدخل الكود هنا',
    apply: 'تطبيق',
    remove: 'إزالة',
    checking: 'جارٍ التحقق…',
    applied: 'تم قبول الكود',
    estimate: 'خصم تقديري',
    finalAtCheckout: 'يُحتسب الخصم النهائي عند إتمام الطلب بعد إضافة التوصيل.',
    reasons: {
      CODE_REQUIRED: 'اكتب الكود أولًا',
      CODE_NOT_FOUND: 'هذا الكود غير موجود',
      INACTIVE: 'هذا الكود غير مفعّل',
      NOT_STARTED: 'لم يبدأ العمل بهذا الكود بعد',
      EXPIRED: 'انتهت صلاحية هذا الكود',
      MIN_TOTAL_NOT_MET: 'قيمة السلة أقل من الحد الأدنى لهذا الكود',
      TIER_REQUIRED: 'هذا الكود لأعضاء عضوية أعلى',
      GLOBAL_LIMIT_REACHED: 'استُنفد هذا الكود',
      PER_USER_LIMIT_REACHED: 'استخدمت هذا الكود من قبل',
      NO_DISCOUNT: 'لا ينتج عن هذا الكود أي خصم على سلتك',
      CART_EMPTY: 'سلتك فارغة',
    } as Record<string, string>,
    minIs: 'الحد الأدنى',
  },
  en: {
    label: 'Promo code',
    placeholder: 'Enter your code',
    apply: 'Apply',
    remove: 'Remove',
    checking: 'Checking…',
    applied: 'Code accepted',
    estimate: 'Estimated discount',
    finalAtCheckout: 'The final discount is calculated at checkout, once delivery is included.',
    reasons: {
      CODE_REQUIRED: 'Enter a code first',
      CODE_NOT_FOUND: 'That code does not exist',
      INACTIVE: 'That code is not active',
      NOT_STARTED: 'That code has not started yet',
      EXPIRED: 'That code has expired',
      MIN_TOTAL_NOT_MET: 'Your cart is below this code’s minimum',
      TIER_REQUIRED: 'That code is for a higher membership tier',
      GLOBAL_LIMIT_REACHED: 'That code has been fully used',
      PER_USER_LIMIT_REACHED: 'You have already used that code',
      NO_DISCOUNT: 'That code produces no discount on your cart',
      CART_EMPTY: 'Your cart is empty',
    } as Record<string, string>,
    minIs: 'Minimum',
  },
  ckb: {
    label: 'کۆدی داشکاندن',
    placeholder: 'کۆدەکەت بنووسە',
    apply: 'جێبەجێکردن',
    remove: 'لابردن',
    checking: 'پشکنین دەکرێت…',
    applied: 'کۆد وەرگیرا',
    estimate: 'داشکاندنی خەمڵێنراو',
    finalAtCheckout: 'داشکاندنی کۆتایی لە کاتی تەواوکردنی داواکاری دیاری دەکرێت.',
    reasons: {
      CODE_REQUIRED: 'سەرەتا کۆد بنووسە',
      CODE_NOT_FOUND: 'ئەم کۆدە بوونی نییە',
      INACTIVE: 'ئەم کۆدە چالاک نییە',
      NOT_STARTED: 'ئەم کۆدە هێشتا دەستی پێنەکردووە',
      EXPIRED: 'ماوەی ئەم کۆدە تەواو بووە',
      MIN_TOTAL_NOT_MET: 'سەبەتەکەت لە کەمترین بڕی ئەم کۆدە کەمترە',
      TIER_REQUIRED: 'ئەم کۆدە بۆ ئەندامێتی باڵاترە',
      GLOBAL_LIMIT_REACHED: 'ئەم کۆدە تەواو بەکارهێنراوە',
      PER_USER_LIMIT_REACHED: 'پێشتر ئەم کۆدەت بەکارهێناوە',
      NO_DISCOUNT: 'ئەم کۆدە هیچ داشکاندنێک ناکات',
      CART_EMPTY: 'سەبەتەکەت بەتاڵە',
    } as Record<string, string>,
    minIs: 'کەمترین',
  },
} as const;

export default function PromoCodeField({
  lang,
  onApplied,
  showLabel = true,
}: {
  lang: string;
  // The formatter used to be a PROP, passed down from whichever page hosted
  // this field. It is a context now (src/CurrencyContext.tsx), so the field
  // follows the customer's chosen currency wherever it is mounted and no
  // caller can hand it a different one by mistake.
  /** Told the accepted code, or '' when it was removed. */
  onApplied?: (code: string) => void;
  /**
   * False where the CALLER already names this control — checkout puts the
   * field behind a «استخدام كود خاص» disclosure, so the heading here would be
   * the same words twice, one under the other. The cart, which shows the field
   * outright with nothing else naming it, keeps its heading.
   */
  showLabel?: boolean;
}) {
  const { money } = useMoney();
  const s = STRINGS[(lang as keyof typeof STRINGS) in STRINGS ? (lang as keyof typeof STRINGS) : 'ar'];
  const [input, setInput] = useState('');
  const [applied, setApplied] = useState<CheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const apply = async () => {
    const code = input.trim();
    if (!code || busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.post<CheckResult>('/api/cart/coupon-check', { code });
      if (!res.valid) {
        // The server's own reason, translated — never a generic "invalid".
        // A customer refused for a minimum spend needs to know the minimum.
        const reason = s.reasons[res.reason ?? ''] ?? s.reasons.CODE_NOT_FOUND;
        setError(
          res.reason === 'MIN_TOTAL_NOT_MET' && typeof res.min_total_iqd === 'number'
            ? `${reason} — ${s.minIs}: ${money(res.min_total_iqd)}`
            : reason
        );
        setApplied(null);
        storePromo('');
        onApplied?.('');
        // THE REQUEST SUCCEEDED AND THE THING THE USER WANTED DID NOT HAPPEN.
        // This route answers a refused code with a 200, so the client's blanket
        // «a mutation that returned is a success» rule cannot see the
        // difference and deliberately stays out of it. Only this screen knows,
        // so this screen says so — the face reads the application result,
        // which is what the brief's §13 asks for.
        mascot.outcome('rejected');
        return;
      }
      setApplied(res);
      storePromo(res.code ?? code);
      onApplied?.(res.code ?? code);
      mascot.outcome('saved');
    } catch (err) {
      const code2 = err instanceof ApiError ? err.code ?? '' : '';
      setError(s.reasons[code2] ?? (err instanceof Error ? err.message : ''));
      setApplied(null);
    } finally {
      setBusy(false);
    }
  };

  const remove = () => {
    setApplied(null);
    setInput('');
    setError('');
    storePromo('');
    onApplied?.('');
  };

  return (
    <div data-promo-field>
      {showLabel && (
        <p className="text-white font-bold mb-2 text-sm flex items-center gap-1.5">
          <Tag className="w-4 h-4 text-zinc-400" aria-hidden />
          {s.label}
        </p>
      )}
      {applied ? (
        <div className="flex items-center justify-between gap-3 bg-[#59A846]/10 border border-[#59A846]/40 rounded-lg px-3 py-2.5">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[#8fd07c] font-bold text-sm">
              <Check className="w-4 h-4 shrink-0" aria-hidden />
              <span dir="ltr" className="truncate">{applied.code}</span>
            </div>
            {typeof applied.estimated_discount_iqd === 'number' && (
              <p className="text-zinc-300 text-[11px] mt-0.5">
                {s.estimate}: <span dir="ltr">{money(applied.estimated_discount_iqd)}</span>
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={remove}
            className="shrink-0 text-zinc-400 hover:text-white p-2 rounded-lg hover:bg-white/5"
            aria-label={s.remove}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <input
            type="text"
            dir="ltr"
            value={input}
            onChange={(e) => setInput(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void apply();
              }
            }}
            placeholder={s.placeholder}
            className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-white outline-none focus:border-[#BAA369] transition-colors text-sm"
          />
          <button
            type="button"
            onClick={() => void apply()}
            disabled={busy || !input.trim()}
            data-mascot="coupon"
            className="bg-white text-black font-bold px-4 py-2 rounded-lg text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-zinc-200 transition-colors min-w-[88px]"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin mx-auto" aria-label={s.checking} /> : s.apply}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-[#e4899a] text-[11px] mt-2">
          {error}
        </p>
      )}
      {applied && <p className="text-zinc-500 text-[10px] mt-2 leading-snug">{s.finalAtCheckout}</p>}
    </div>
  );
}
