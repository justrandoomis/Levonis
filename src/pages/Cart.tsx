import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import {
  ArrowLeft, ArrowRight, ChevronRight, Check, Minus, Plus, X, ShoppingCart, HeartHandshake, Info, Truck,
  ShieldCheck, FileText, Sparkles,
} from 'lucide-react';
import { useWallet } from '../WalletContext';
import { mascot } from '../lib/mascot';
import { api, ApiError, CartItem } from '../lib/api';
import type { CartWarrantyPlan } from '../lib/api';
import { shippingTypeLabel, type ShippingType } from '../lib/shippingType';
import { asLang, monthsLabel } from '../components/orders/format';
import Note from '../components/ui/Note';
import { useFreshOnReturn, changedPrices } from '../lib/useFreshOnReturn';
import PromoCodeField from '../components/PromoCodeField';
import Spinner from '../components/ui/Spinner';
import SafeImage from '../components/ui/SafeImage';
import BundleContents from '../components/bundles/BundleContents';
import { apiRefusal } from '../lib/refusalStrings';
import { CartSkeleton } from '../components/ui/Skeleton';
import { ErrorState } from '../components/ui/AsyncStates';
import { Sheet } from '../components/ui/Overlay';
import {
  readSupportRefState,
  captureSupportRefFromSearch,
  captureSupportRef,
  chooseSupportRef,
  removeSupportRef,
  normalizeSupportRef,
  type SupportRefState,
} from '../lib/supportRef';
import MerchantCartView from '../components/merchant/MerchantCartView';
import { isPaidTier, tierLabel } from '../components/subscription/tierMeta';
import { useMoney } from '../CurrencyContext';

/**
 * Component-local trilingual strings for the support-code block (§3.3).
 * Arabic is the source language; Sorani never falls back to a machine
 * translation — every line here is written, not generated.
 */
const SUPPORT_STRINGS = {
  ar: {
    title: 'كود الدعم',
    explain: 'كود الدعم ليس خصمًا: قيمته على طلبك صفر، ويمكن استخدامه مع كوبون الخصم والنقاط في الوقت نفسه. استخدامه اختياري تمامًا.',
    supportsPrefix: 'هذا الكود يدعم',
    supportsSuffix: 'ولا يغيّر سعر طلبك.',
    noPriceEffect: 'لا يغيّر السعر ولا رسوم التوصيل (0 د.ع)',
    eligibleLine: 'يحتوي طلبك على بند مؤهل لهدية المُحيل — تُدرس بعد التسليم وتحصيل الدفع، ولا تغيّر ما تدفعه.',
    fromProduct: 'جاء هذا الكود من:',
    remove: 'إزالة',
    none: 'لا يوجد كود دعم على هذا الطلب.',
    removedNote: 'أزلت كود الدعم — لن يُضاف تلقائيًا مرة أخرى. يمكنك إدخاله يدويًا متى شئت.',
    manualLabel: 'إدخال كود دعم يدويًا',
    manualPlaceholder: 'اسم المستخدم أو الكود',
    apply: 'تطبيق',
    resolving: 'جارٍ التحقق من الكود…',
    retry: 'إعادة المحاولة',
    chooseBadge: 'اختر',
    chooseTitle: 'وصلك رابطان بمُحيلين مختلفين — اختر من تريد دعمه في هذا الطلب:',
    errors: {
      invalid: 'صيغة الكود غير صالحة — استخدم اسم المستخدم أو الكود فقط.',
      unknown: 'لا يوجد مستخدم بهذا الكود:',
      self: 'لا يمكنك دعم نفسك:',
      network: 'تعذر التحقق من الكود الآن:',
    } as Record<string, string>,
  },
  en: {
    title: 'Support code',
    explain: 'A support code is not a discount: it is worth 0 on your order, and it works alongside a discount coupon and points at the same time. Using one is entirely optional.',
    supportsPrefix: 'This code supports',
    supportsSuffix: 'and does not change your order price.',
    noPriceEffect: 'No effect on price or delivery (0 IQD)',
    eligibleLine: 'Your order contains a line eligible for the referrer’s gift — assessed after delivery and payment collection, and it changes nothing you pay.',
    fromProduct: 'This code came from:',
    remove: 'Remove',
    none: 'No support code on this order.',
    removedNote: 'You removed the support code — it will not be added back automatically. You can enter it by hand whenever you want.',
    manualLabel: 'Enter a support code',
    manualPlaceholder: 'username or code',
    apply: 'Apply',
    resolving: 'Checking the code…',
    retry: 'Retry',
    chooseBadge: 'Choose',
    chooseTitle: 'Two links from different creators arrived — choose who to support on this order:',
    errors: {
      invalid: 'That code format is not valid — use the username or the code only.',
      unknown: 'No user matches this code:',
      self: 'You cannot support your own account:',
      network: 'The code could not be checked right now:',
    } as Record<string, string>,
  },
  ckb: {
    title: 'کۆدی پاڵپشتی',
    explain: 'کۆدی پاڵپشتی داشکاندن نییە: بەهاکەی لەسەر داواکاریەکەت سفرە، و لە هەمان کاتدا لەگەڵ کۆبۆنی داشکاندن و خاڵەکان کاردەکات. بەکارهێنانی بە تەواوی ئارەزوومەندانەیە.',
    supportsPrefix: 'ئەم کۆدە پاڵپشتی',
    supportsSuffix: 'دەکات و نرخی داواکاریەکەت ناگۆڕێت.',
    noPriceEffect: 'هیچ کاریگەرییەکی لەسەر نرخ و گەیاندن نییە (٠ د.ع)',
    eligibleLine: 'داواکاریەکەت بڕگەیەکی تێدایە کە شیاوی دیاری بانگهێشتکارە — دوای گەیاندن و کۆکردنەوەی پارە هەڵدەسەنگێنرێت و هیچ لە پارەدانەکەت ناگۆڕێت.',
    fromProduct: 'ئەم کۆدە لێرەوە هات:',
    remove: 'لابردن',
    none: 'هیچ کۆدێکی پاڵپشتی لەسەر ئەم داواکارییە نییە.',
    removedNote: 'کۆدی پاڵپشتیت لابرد — بەخۆکارانە زیاد ناکرێتەوە. هەر کاتێک بتەوێت بە دەست دەیتوانیت بینوسیت.',
    manualLabel: 'نووسینی کۆدی پاڵپشتی',
    manualPlaceholder: 'ناوی بەکارهێنەر یان کۆد',
    apply: 'جێبەجێکردن',
    resolving: 'پشکنینی کۆدەکە…',
    retry: 'دووبارە هەوڵ بدەوە',
    chooseBadge: 'هەڵبژێرە',
    chooseTitle: 'دوو لینک لە دوو کەسی جیاوازەوە هاتن — هەڵبژێرە کێ پاڵپشتی دەکەیت لەم داواکارییەدا:',
    errors: {
      invalid: 'شێوازی کۆدەکە دروست نییە — تەنها ناوی بەکارهێنەر یان کۆد بەکاربهێنە.',
      unknown: 'هیچ بەکارهێنەرێک بەم کۆدە نییە:',
      self: 'ناتوانیت پاڵپشتی هەژماری خۆت بکەیت:',
      network: 'ئێستا نەتوانرا کۆدەکە بپشکنرێت:',
    } as Record<string, string>,
  },
} as const;

/** The printer home-delivery note, beside a printer line (owner mandate: a note, never a fee). */
const PRINTER_NOTE = {
  ar: (v: string) => `عند طلب توصيل الطابعة إلى المنزل يُدفع ${v} عند الاستلام.`,
  en: (v: string) => `When home delivery is requested for a printer, ${v} is paid on delivery.`,
  ckb: (v: string) => `کاتێک گەیاندنی پرینتەر بۆ ماڵەوە داوا دەکرێت، ${v} لە کاتی گەیاندن دەدرێت.`,
} as const;

/**
 * The cart prices a pre-order line as PAID IN ADVANCE; cash on delivery is
 * priced as a direct sale at checkout (owner mandate). Said beside a line
 * ONLY when the server says the number would actually move there
 * (`cod_reprices`) — a pre-order with no direct premium keeps its commission
 * under either method, and a customer exempt from the premium pays the same
 * either way, so neither is told about a difference that does not exist.
 */
const COD_HINT = {
  ar: 'السعر المعروض للدفع مقدمًا من المحفظة؛ الدفع عند الاستلام يُسعَّر كبيع مباشر عند إتمام الطلب.',
  en: 'Shown as paid in advance from the wallet; cash on delivery is priced as a direct sale at checkout.',
  ckb: 'نرخەکە بۆ پارەدانی پێشوەخت لە جزدانەوەیە؛ پارەدان لە کاتی گەیاندن لە کاتی تەواوکردنی داواکاری وەک فرۆشتنی ڕاستەوخۆ نرخ دەکرێت.',
} as const;

/**
 * The EXTENDED WARRANTY disclosure on a PRINTER line (owner mandate): a small
 * collapsed row that opens into the extensions the store sells — +12 months
 * (24 in total) and +24 months (36 in total) — each priced by the SERVER
 * against this line's regular price, so the dinar beside an option is the
 * dinar the cart charges. One plan per line, applied to every unit of the
 * line; chosen here or on the product page, and only before the order is
 * placed — after checkout nothing can add one. Arabic is the source; Sorani
 * is written, never generated.
 */
const EXT_WARRANTY = {
  ar: {
    title: 'الضمان الممدد',
    none: 'بدون ضمان ممدد',
    noneHint: 'الضمان الأساسي فقط',
    plan: (ext: string) => `+${ext}`,
    total: (total: string) => `${total} إجمالًا`,
    includes: 'يشمل الضمان الممدد',
    perLine: (qty: number) =>
      qty > 1 ? `خطة واحدة للبند — تُطبَّق على كل وحدة من وحداته الـ${qty}.` : 'خطة واحدة للبند — تُطبَّق على كل وحدة فيه.',
    beforeOrder: 'تُشترى قبل إتمام الطلب فقط، ولا تُضاف بعد تأكيده.',
    policy: 'شروط الضمان الممدد',
    errors: {
      notPrinter: 'الضمان الممدد متاح للطابعات فقط.',
      planGone: 'هذه الخطة لم تعد معروضة — أعد تحميل السلة.',
      generic: 'تعذّر تحديث الضمان الممدد — حاول مجددًا.',
    },
  },
  en: {
    title: 'Extended Warranty',
    none: 'No extended warranty',
    noneHint: 'Base warranty only',
    plan: (ext: string) => `+${ext}`,
    total: (total: string) => `${total} total`,
    includes: 'Includes extended warranty',
    perLine: (qty: number) =>
      qty > 1 ? `One plan per line — it applies to each of the ${qty} units.` : 'One plan per line — it applies to every unit of the line.',
    beforeOrder: 'Bought before the order is placed only; it cannot be added afterwards.',
    policy: 'Extended warranty terms',
    errors: {
      notPrinter: 'Extended warranty is available for printers only.',
      planGone: 'This plan is no longer offered — reload the cart.',
      generic: 'Could not update the extended warranty — please try again.',
    },
  },
  ckb: {
    title: 'گەرەنتی درێژکراوە',
    none: 'بێ گەرەنتی درێژکراوە',
    noneHint: 'تەنها گەرەنتی بنەڕەتی',
    plan: (ext: string) => `+${ext}`,
    total: (total: string) => `${total} کۆی گشتی`,
    includes: 'گەرەنتی درێژکراوە لەخۆ دەگرێت',
    perLine: (qty: number) =>
      qty > 1 ? `یەک پلان بۆ بڕگەکە — بۆ هەر یەکێک لە ${qty} یەکەکە جێبەجێ دەبێت.` : 'یەک پلان بۆ بڕگەکە — بۆ هەموو یەکەکانی جێبەجێ دەبێت.',
    beforeOrder: 'تەنها پێش تەواوکردنی داواکاری دەکڕدرێت و دواتر زیاد ناکرێت.',
    policy: 'مەرجەکانی گەرەنتی درێژکراوە',
    errors: {
      notPrinter: 'گەرەنتی درێژکراوە تەنها بۆ پرینتەرەکانە.',
      planGone: 'ئەم پلانە چیتر پێشکەش ناکرێت — سەبەتەکە دووبارە بار بکە.',
      generic: 'نوێکردنەوەی گەرەنتی درێژکراوە سەرکەوتوو نەبوو — دووبارە هەوڵ بدەوە.',
    },
  },
} as const;

/**
 * The journey a cart line is on, from the column that has always held it.
 * Mirrors worker/lib/shippingType.ts typeForTransport: '' (or anything
 * unknown) is a direct line; air/sea/land is a pre-order.
 */
function typeForTransport(method: unknown): ShippingType {
  return method === 'air' ? 'preorder_air' : method === 'sea' ? 'preorder_sea' : method === 'land' ? 'preorder_land' : 'direct';
}

/** A composition line in one of these states cannot be sold; recreated per
 *  render before, which defeated every memo below it. */
const BLOCKING_STATES = new Set(['sold_out', 'ended', 'upcoming', 'locked', 'unconfigured']);

/* ------------------------------------------------ the membership's answer
 *
 * WHAT `GET /api/cart` SAYS A MEMBERSHIP IS WORTH ON THIS CART
 * (docs/MEMBERSHIP_BENEFITS.md §8; worker/routes/cart.ts, `loadCart`).
 *
 * This page used to declare the cart response as `{ items, scope }` and throw
 * the rest of it away, then rebuild the whole summary out of
 * `unit_price_iqd * qty` and `regular_iqd - applied_iqd`. Subtraction cannot
 * see a quantity limit or a per-order ceiling: a rule that covers "the first
 * two printers" saves less than the arithmetic claimed, and nothing on the
 * screen could say so. Every dinar the shapes below carry is the SERVER's,
 * and not one percentage, threshold or ceiling behind them lives in this file.
 */

type DeliveryMethodId = 'standard' | 'personal';

/** What ONE cart row's membership rule was worth, and which ceiling bit. */
interface MembershipLine {
  /** The product the benefit was resolved for — `CartItem.productId`. */
  product_id: string;
  rule_id: string | null;
  scope: string | null;
  discount_mode: 'percent' | 'fixed' | null;
  per_unit_iqd: number;
  /** How many of the line's units the rule covers, after `max_quantity`. */
  eligible_qty: number;
  /** The line's WHOLE saving, after every ceiling the rule carries. */
  total_iqd: number;
  capped_by: 'none' | 'per_unit' | 'per_order' | 'quantity';
  /**
   * WHERE THE MONEY ALREADY IS (§2).
   *
   * 'unit' — `total_iqd` is ALREADY inside `unit_price_iqd`, so naming it as
   * a deduction as well would take it twice.
   * 'line' — the unit price is the regular one and the saving comes off the
   * order exactly once.
   */
  applied_at: 'unit' | 'line';
}

/**
 * Free delivery, answered PER METHOD because the cart is where the customer
 * is still choosing one. `methods: null` means the rule covers every method.
 */
interface MembershipShipping {
  method: DeliveryMethodId;
  rule_id: string | null;
  eligible: boolean;
  threshold_iqd: number | null;
  /** The figure the threshold was tested against, for the whole cart. */
  basis_iqd: number;
  methods: DeliveryMethodId[] | null;
  max_subsidy_iqd: number | null;
  reason: 'applied' | 'no_rule' | 'below_threshold' | 'method_not_covered';
}

interface CartMembership {
  /** `prime` is the API id; PREMIUM is the name a customer reads, and
   *  `tierLabel` is the only thing that supplies it. */
  tier: string;
  active: boolean;
  /** The whole saving on merchandise, however it was applied. */
  discount_total_iqd: number;
  /** The part of it that is NOT yet in the unit prices. */
  order_discount_iqd: number;
  merchandise_iqd: number;
  lines: MembershipLine[];
  free_shipping: MembershipShipping[];
  cod_tax_exempt: boolean;
}

interface CartResponse {
  items: CartItem[];
  membership?: CartMembership | null;
  scope?: { seller_type?: string } | null;
}

/**
 * What a cart WRITE answers with. The mutation routes re-price and return the
 * whole cart, but they do not carry `membership` — so a saving that depends on
 * the quantity is re-read rather than left describing the quantity before the
 * tap. `membership` is declared optional so the day a route does carry it,
 * the answer is used instead of a second read.
 */
interface CartWriteResponse {
  items: CartItem[];
  membership?: CartMembership | null;
}

/**
 * The tier the non-member line invites the viewer to. PRO is the highest tier,
 * and the name comes from the one table that owns the customer-facing names.
 */
const PRO_LABEL = tierLabel('pro');

export default function Cart() {
  const { money } = useMoney();
  const navigate = useNavigate();
  const { t, lang, dir, loc } = useLanguage();
  const sc = SUPPORT_STRINGS[lang] ?? SUPPORT_STRINGS.ar;
  const { cartShippingMethods, checkoutDeliveryMethods, pointBalance, settings } = useWallet();
  // The owner's configured note amount; null = nothing to show, never a guess.
  const printerNoteIqd = (() => {
    const n = settings?.printerHomeDeliveryNoteIqd;
    return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null;
  })();
  const printerNoteText = PRINTER_NOTE[lang] ?? PRINTER_NOTE.ar;
  const codHint = COD_HINT[asLang(lang)];
  const ew = EXT_WARRANTY[asLang(lang)];
  // "+12 months → 24 months total": the arrow follows the reading direction,
  // so it points from the extension to the total in both scripts.
  const arrow = dir === 'rtl' ? '←' : '→';

  const [items, setItems] = useState<CartItem[]>([]);
  const [loading, setLoading] = useState(true);
  // One cart, one seller (§14): the server says whose cart this is, and a
  // merchant-store cart gets its own rendering with the shop's own terms.
  const [merchantScope, setMerchantScope] = useState<boolean | null>(null);
  // §10 — WHAT THE MEMBERSHIP IS WORTH ON THIS CART, exactly as the server
  // answered it. Nothing here is re-derived in the browser: the page pairs
  // each line back to the row it was resolved for and adds up the rows the
  // customer has actually ticked.
  const [membership, setMembership] = useState<CartMembership | null>(null);
  const membershipRef = useRef<CartMembership | null>(null);
  // Only the latest re-read may answer: three quantity taps fire three of them.
  const membershipSeqRef = useRef(0);
  // Action errors (qty/variant updates) show as a dismissible banner over the
  // existing content; a failed INITIAL load is a distinct full state below.
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState<unknown>(null);
  // Selection is a client-side concern; selected item ids are handed to
  // checkout via navigate('/checkout', { state: { itemIds, usePoints } }).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const firstLoadRef = useRef(true);
  const knownIdsRef = useRef<Set<string>>(new Set());
  // Lines whose price moved between one read of the cart and the next. The
  // new price is what the shop charges and it is applied without asking, but
  // a total that changes under the customer's eyes is told, not hidden.
  const [movedPrices, setMovedPrices] = useState<Map<string, { from: number; to: number }>>(new Map());
  const itemsRef = useRef<CartItem[]>([]);
  // A quantity tap or a delete is a write followed by a read. A refresh that
  // lands between the two would paint the pre-write cart back over the
  // customer's own change, so the wake is held for the length of the action.
  /**
   * HOW MANY CART WRITES ARE IN FLIGHT — a COUNTER, not a flag.
   *
   * As a boolean, two overlapping actions (a delete finishing while a quantity
   * PATCH is still open) had the first one to finish clear the flag for both,
   * so the revalidation effect at :409 could fire against a cart that was
   * still being written.
   */
  const actionBusyRef = useRef(0);
  /**
   * THE LATEST QUANTITY REQUEST PER LINE.
   *
   * Tapping + three times fires three PATCHes with no ordering guarantee, and
   * each one answers with the WHOLE cart. An earlier response landing last
   * rewrote the number backwards under the customer's finger. Every request
   * takes a ticket; a response whose ticket is no longer the latest for its
   * line is discarded.
   */
  const qtySeqRef = useRef(new Map<string, number>());

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

  // A mobile-safe, portalled sheet owns the warranty choices. Keeping this
  // out of the narrow product-detail column prevents RTL text or a long price
  // from widening the cart beyond the viewport.
  const [warrantyPickerId, setWarrantyPickerId] = useState<string | null>(null);
  const [warrantySavingId, setWarrantySavingId] = useState<string | null>(null);
  const [warrantyPendingPlan, setWarrantyPendingPlan] = useState<string>('');
  const [warrantyErrors, setWarrantyErrors] = useState<Record<string, string>>({});

  // ---------------------------------------------------------- support code
  //
  // §3.3 — a support code is NOT a discount. Nothing in this block feeds the
  // subtotal, the discount lines, the shipping preview or the total; it only
  // decides which handle rides along to checkout. A code the server cannot
  // resolve (or a self-support attempt) is shown as unusable and is never
  // sent, so the order can never carry an attribution that points nowhere.
  const location = useLocation();
  const [supportState, setSupportState] = useState<SupportRefState>(() => readSupportRefState());
  const [supportNames, setSupportNames] = useState<Record<string, { username: string | null; display_name: string }>>({});
  const [supportRefErrors, setSupportRefErrors] = useState<Record<string, string>>({});
  const [supportResolving, setSupportResolving] = useState(false);
  const [manualRef, setManualRef] = useState('');
  const [manualError, setManualError] = useState('');
  // §3.3: when a share link brought a code, the block opens on its own —
  // "add the support code automatically and VISIBLY, with the referrer's
  // name and a remove button". It is never forced on the order, only shown.
  const [supportOpen, setSupportOpen] = useState(() => {
    const initial = readSupportRefState();
    return !!(initial.current || initial.conflict);
  });
  const [supportRetry, setSupportRetry] = useState(0);

  const applyItems = useCallback((next: CartItem[], opts?: { detectPriceChange?: boolean }) => {
    // ONLY a background revalidation may say "the shop changed this price".
    // The customer's own edits — a different variant, a new quantity, a
    // removed line — also change the number on screen, and blaming the shop
    // for those would be a lie they can see through.
    if (opts?.detectPriceChange && !firstLoadRef.current) {
      const moved = changedPrices(itemsRef.current, next);
      if (moved.size) {
        setMovedPrices((prev) => {
          const merged = new Map(prev);
          for (const [id, m] of moved) {
            // Keep the price the customer actually SAW as the "from", even if
            // it has since moved twice.
            const seen = merged.get(id);
            merged.set(id, { from: seen ? seen.from : m.from, to: m.to });
          }
          // A price that came back to where it started is no longer news.
          for (const [id, m] of merged) if (m.from === m.to) merged.delete(id);
          return merged;
        });
      }
    }
    itemsRef.current = next;
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

  /** The server's answer, held where both the render and the next re-read can
   *  see it — a ref as well as state, so a refresh can ask whether there is
   *  anything on screen worth keeping true without re-creating itself. */
  const putMembership = useCallback((next: CartMembership | null) => {
    membershipRef.current = next;
    setMembership(next);
  }, []);

  /**
   * RE-READ WHAT THE MEMBERSHIP IS WORTH, after a write that moved the
   * quantities its rules were resolved against.
   *
   * The cart's PATCH and DELETE routes answer with the re-priced items but
   * without `membership`, so a saving carrying a quantity limit or a
   * per-order ceiling would otherwise still describe the cart as it stood
   * before the tap. It costs a read only for a customer who actually has a
   * live membership — for everyone else there is nothing on screen to correct.
   */
  const refreshMembership = useCallback(async () => {
    if (!membershipRef.current?.active) return;
    const seq = membershipSeqRef.current + 1;
    membershipSeqRef.current = seq;
    try {
      const data = await api.get<CartResponse>('/api/cart');
      if (membershipSeqRef.current !== seq) return;
      putMembership(data.membership ?? null);
    } catch {
      // Keep the last answer rather than blanking the summary under the
      // customer's eyes; the next full read of the cart corrects it.
    }
  }, [putMembership]);

  /** A write's answer: the re-priced cart, and what the membership is worth
   *  on it — from the response where the route sends it, by a re-read where
   *  it does not. */
  const applyCartWrite = useCallback(
    (data: CartWriteResponse) => {
      applyItems(data.items || []);
      if ('membership' in data) putMembership(data.membership ?? null);
      else void refreshMembership();
    },
    [applyItems, putMembership, refreshMembership]
  );

  /**
   * WHICH COUNTER MOVED.
   *
   * 0075 put two counters behind one basket: the shelf a direct sale comes off
   * and the import quota a pre-order consumes. A refusal that says only "that
   * is not available" leaves the customer unable to tell whether the thing is
   * gone or merely this month's quota is full — and those have different
   * answers (come back tomorrow versus buy it now instead). The decoded
   * sentence is never rewritten; the counter is named after it.
   *
   * The Kurdish is deliberately absent rather than invented: `loc` falls back
   * to the Arabic sentence, which is the documented behaviour of this app's
   * translator, and the owner writes the Sorani by hand.
   */
  const counterNamed = useCallback(
    (code: string): string =>
      code === 'PREORDER_CAPACITY_EXHAUSTED'
        ? loc(
            'العدّاد: حصة الطلب المسبق لهذا الاختيار — وليس مخزون البيع المباشر.',
            'The counter: this selection’s pre-order quota — not direct-sale stock.'
          )
        : code === 'OUT_OF_STOCK' || code === 'QTY_UNAVAILABLE'
          ? loc(
              'العدّاد: مخزون البيع المباشر لهذا الاختيار.',
              'The counter: direct-sale stock for this selection.'
            )
          : '',
    [loc]
  );

  /**
   * A refusal the customer can read, in their own language.
   *
   * `HttpError` carries one untranslated sentence, and this screen used to
   * render it verbatim — so a new server code arrived as English prose, or as
   * the bare identifier itself. `refusalText` answers from the trilingual table
   * (`src/lib/refusalStrings.ts`) for the codes it owns and falls back to the
   * server's own sentence for every code that already had one. Since 0075 the
   * counter that refused is named after it.
   */
  const cartRefusal = useCallback(
    (err: unknown, fallback: string): string => {
      const said = apiRefusal(err, lang as 'ar' | 'en' | 'ckb', fallback);
      const code = err instanceof ApiError ? err.code ?? '' : '';
      const counter = counterNamed(code);
      return counter ? `${said} ${counter}` : said;
    },
    [counterNamed, lang]
  );

  const loadCart = useCallback(async (opts?: { silent?: boolean }) => {
    try {
      const data = await api.get<CartResponse>('/api/cart');
      // The scope now rides on the cart itself, so the page knows which of the
      // two cart screens to render in the same tick it knows the items —
      // no second round trip, and no platform-cart flash before a merchant
      // cart swaps in.
      setMerchantScope(data.scope?.seller_type === 'merchant');
      applyItems(data.items || [], { detectPriceChange: !!opts?.silent });
      // §10: the server's own answer about what this membership saved, per
      // line and in total — null for a customer without one, and for one whose
      // membership has lapsed.
      putMembership(data.membership ?? null);
      setError('');
      setLoadError(null);
    } catch (err) {
      // A background refresh that fails must leave the screen alone. Painting
      // a red banner over a cart that is perfectly readable, because a wake
      // request timed out, is worse than showing a price a few seconds old.
      if (opts?.silent) return;
      if (firstLoadRef.current) {
        // Nothing on screen yet: a full error state (401 → sign-in prompt,
        // network/5xx → retry) instead of "your cart is empty" + a banner.
        setLoadError(err);
      } else {
        // The page already has content — keep it visible, show a banner.
        setError(cartRefusal(err, 'Failed to load cart'));
      }
    } finally {
      setLoading(false);
    }
  }, [applyItems, cartRefusal, putMembership]);

  const retryLoadCart = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    loadCart();
  }, [loadCart]);

  useEffect(() => {
    loadCart();
  }, [loadCart]);

  // COMING BACK TO THE CART RE-READS ITS PRICES.
  //
  // The server prices every line on every read, so the only way an old number
  // survives is a page that never asks again: a tab left open, an app switched
  // away from, or `back` restoring this screen from the bfcache without
  // remounting it. Asking again on return is what makes "the price changed"
  // reach the customer instead of stopping at the shelf.
  //
  // Held while a dialog is open so a reload never lands under a variant or
  // shipping choice the customer is in the middle of making.
  useFreshOnReturn(() => loadCart({ silent: true }), {
    enabled:
      !variantModalOpen &&
      !shippingModalOpen &&
      !variantSaving &&
      !shippingSaving &&
      warrantySavingId === null &&
      actionBusyRef.current === 0,
    minIntervalMs: 8_000,
    // For the customer who simply leaves the cart in front of them.
    pollWhileVisibleMs: 60_000,
  });

  // A ?ref= that lands on the cart URL itself is captured here; a product
  // link captures its own on the product page. Neither one ever REPLACES an
  // existing code — a second, different ref becomes an explicit choice.
  useEffect(() => {
    if (!location.search || location.search.indexOf('ref=') === -1) return;
    setSupportState(captureSupportRefFromSearch(location.search, { product: location.pathname }));
  }, [location.search, location.pathname]);

  const supportKey = `${supportState.current?.ref ?? ''}|${supportState.conflict?.ref ?? ''}`;

  useEffect(() => {
    if (supportState.current || supportState.conflict) setSupportOpen(true);
  }, [supportKey]);

  // Resolve every pending ref through the server — the browser never decides
  // who a code belongs to, and an unresolvable or self-support code is shown
  // as unusable instead of being quietly attached to the order.
  useEffect(() => {
    const refs = [supportState.current?.ref, supportState.conflict?.ref].filter((r): r is string => !!r);
    if (refs.length === 0) return;
    let cancelled = false;
    // AT MOST TWO REFS, RESOLVED TOGETHER. Serially, the conflict code waited
    // on the current code's whole round trip before its own started, so the
    // "which of these two?" prompt appeared one full RTT later than it needed
    // to. They are independent lookups; nothing about the second depends on
    // the first.
    (async () => {
      setSupportResolving(true);
      await Promise.all(refs.map(async (ref) => {
        const key = ref.toLowerCase();
        if (supportNames[key] || supportRefErrors[key]) return;
        try {
          const res = await api.get<{ ref: string; username: string | null; display_name: string }>(
            `/api/referrals/support/resolve?ref=${encodeURIComponent(ref)}`
          );
          if (cancelled) return;
          setSupportNames((prev) => ({ ...prev, [key]: { username: res.username, display_name: res.display_name } }));
        } catch (err) {
          if (cancelled) return;
          const kind =
            err instanceof ApiError && err.code === 'SELF_SUPPORT'
              ? 'self'
              : err instanceof ApiError && err.status === 404
                ? 'unknown'
                : err instanceof ApiError && (err.status === 0 || err.status >= 500)
                  ? 'network'
                  : 'unknown';
          setSupportRefErrors((prev) => ({ ...prev, [key]: kind }));
        }
      }));
      if (!cancelled) setSupportResolving(false);
    })();
    return () => {
      cancelled = true;
    };
    // supportNames / supportRefErrors are read through the closure on purpose:
    // re-running on every resolution would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supportKey, supportRetry]);

  /**
   * The per-line ceiling the SERVER published: a composition row's `max_qty`
   * (the scarcest component and the offer's per-order cap, §2.4), or an
   * ordinary row's resolved `availability.stock.max_qty`. `null` = unbounded.
   *
   * 0075 — `availability` AND NOT THE LEGACY `stock` COLUMN. `CartItem.stock`
   * is the product's BASE row, which is the wrong number whenever the product
   * tracks stock per option, colour or combination, and it is not a counter at
   * all for a pre-order line: a pre-order is limited by its capacity, which the
   * server has already folded into `max_qty` for exactly this reason. The old
   * expression let the stepper offer a quantity the door would refuse, and on a
   * pre-order line it offered the shelf's. The legacy column stays as the
   * fallback for a response from a Worker that predates the field.
   */
  const lineCap = (item: CartItem): number | null =>
    item.composition
      ? item.composition.max_qty
      : typeof item.availability?.stock?.max_qty === 'number'
        ? item.availability.stock.max_qty
        : (item.stock ?? null);

  /**
   * WHAT IS LEFT, ON THE COUNTER THIS LINE ACTUALLY CONSUMES.
   *
   * The order type decides which counter answers — `preorder` for a pre-order
   * line, the shelf for a direct sale — and the browser adds nothing together
   * and works nothing out: both figures are the server's own resolution for
   * this exact selection and route. `null` means no number is published
   * (untracked), which is not zero and must never be rendered as "0 left".
   */
  const lineRemaining = (item: CartItem): { left: number; preorder: boolean } | null => {
    const a = item.availability;
    if (!a || item.composition) return null;
    if (a.mode === 'preorder') {
      const cap = a.preorder?.capacity;
      return cap && cap.tracked && cap.available !== null ? { left: cap.available, preorder: true } : null;
    }
    const st = a.stock;
    return st && st.tracked && st.available !== null ? { left: st.available, preorder: false } : null;
  };

  /**
   * A LINE THE DOOR WILL REFUSE — and it is no longer only a bundle.
   *
   * «عندما يضع المنتج في السله ويتركه فتره اذا نفذ المخزون يجب ان يظهر نفذ
   *  المخزون ولا يمكنه طلبه.»
   *
   * This test was `!!item.composition && …` — a BUNDLES-ONLY check, written
   * when a composition line was the thing that could look normal and be
   * refused. An ordinary line could do exactly the same and nothing read it:
   * the server has been publishing `mode: 'unavailable'` and `qty_ok: false`
   * on the availability block all along, and `qty_ok` appeared nowhere in this
   * file. So a filament that sold out while the cart rested still carried an
   * enabled «إتمام الشراء», and the customer learned at the door.
   *
   * THE TWO ORDINARY CASES, and they are different sentences:
   *   · `mode === 'unavailable'` — nothing left at all. «نفد المخزون».
   *   · `qty_ok === false` — some left, but fewer than this line asks for.
   *     «بقي N فقط», and the customer fixes it by lowering the quantity.
   *
   * `qty_ok === false` is tested explicitly rather than `!qty_ok`, because the
   * key is absent on a response from a Worker that predates it and absent must
   * mean "no opinion", not "blocked". strictNullChecks is off here, so that
   * distinction is this comparison's job and not the compiler's.
   */
  const lineBlocked = (item: CartItem): boolean => {
    if (item.composition) return BLOCKING_STATES.has(item.composition.availability_state);
    const a = item.availability;
    if (!a) return false;
    return a.mode === 'unavailable' || a.qty_ok === false;
  };

  const clampQty = (item: CartItem, q: number) =>
    // A composition line is bounded by the server's own `max_qty` — the
    // scarcest component and the offer's per-order cap — not by a `stock`
    // column a bundle deliberately does not have (§2.4). An ordinary line is
    // bounded by the ceiling the server published for the counter it consumes
    // (0075), which is the same number the + button disables on.
    Math.max(1, Math.min(99, Math.min(q, lineCap(item) ?? 99)));

  const updateQuantity = async (item: CartItem, delta: number) => {
    if (item.qty + delta < 1) {
      deleteItem(item);
      return;
    }
    const newQty = clampQty(item, item.qty + delta);
    if (newQty === item.qty) return;
    // §11. Reported before the request, because the character is reacting to
    // what the USER did — and at the stock ceiling there is no request at all
    // (the line above returns), so waiting for one would make the escalation
    // stop working exactly where a large quantity becomes interesting.
    mascot.quantity(newQty, item.qty);
    // Optimistic update, reconciled with the server's returned cart.
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, qty: newQty } : i)));
    const seq = (qtySeqRef.current.get(item.id) ?? 0) + 1;
    qtySeqRef.current.set(item.id, seq);
    actionBusyRef.current += 1;
    try {
      const data = await api.patch<CartWriteResponse>(`/api/cart/items/${item.id}`, { qty: newQty });
      // A response that a newer tap has already superseded is thrown away
      // rather than allowed to rewrite the line backwards.
      if (qtySeqRef.current.get(item.id) !== seq) return;
      applyCartWrite(data);
    } catch (err) {
      if (qtySeqRef.current.get(item.id) !== seq) return;
      setError(cartRefusal(err, 'Failed to update quantity'));
      loadCart();
    } finally {
      actionBusyRef.current -= 1;
    }
  };

  const deleteItem = async (item: CartItem) => {
    actionBusyRef.current += 1;
    try {
      const data = await api.delete<CartWriteResponse>(`/api/cart/items/${item.id}`);
      applyCartWrite(data);
      // §14 — the funnel's blanket «a mutation succeeded» would congratulate
      // the customer for emptying their cart. The user asked for this: the
      // character notices it and does not celebrate it, and does not sulk
      // about it either.
      mascot.outcome('removed');
    } catch (err) {
      setError(cartRefusal(err, 'Failed to remove item'));
      loadCart();
    } finally {
      actionBusyRef.current -= 1;
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
      const data = await api.patch<CartWriteResponse>(`/api/cart/items/${item.id}`, {
        optionId: pendingOptionId,
        colorId: pendingColorId,
      });
      applyCartWrite(data);
      setVariantModalOpen(false);
    } catch (err) {
      setVariantError(cartRefusal(err, 'Failed to update variant'));
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
      const data = await api.patch<CartWriteResponse>(`/api/cart/items/${item.id}`, {
        shippingMethodId: methodId,
      });
      applyCartWrite(data);
      setShippingModalOpen(false);
    } catch (err) {
      setShippingError(cartRefusal(err, 'Failed to update shipping method'));
    } finally {
      setShippingSaving(false);
    }
  };

  // The line's JOURNEY, from `transport_method` — the column the server prices
  // and locks the cart on (§1). The legacy `shipping_method_id` is no longer
  // priced and used to mislabel every pre-order line as "direct".
  const shippingLabel = (item: CartItem) => shippingTypeLabel(typeForTransport(item.transport_method), lang);

  // ------------------------------------------------- extended warranty
  //
  // The server sends `warranty_plans` only for a printer line, each with its
  // fee already resolved against the line's regular price; a plan is set or
  // cleared with the same PATCH the variant and shipping sheets use, and the
  // returned cart (re-priced by the resolver) is what the screen paints.
  const chooseWarranty = async (item: CartItem, planId: string) => {
    if (warrantySavingId !== null) return;
    if ((item.warranty_plan_id ?? '') === planId) {
      setWarrantyPickerId(null);
      return;
    }
    setWarrantySavingId(item.id);
    setWarrantyPendingPlan(planId);
    setWarrantyErrors((prev) => {
      const next = { ...prev };
      delete next[item.id];
      return next;
    });
    actionBusyRef.current += 1;
    try {
      const data = await api.patch<CartWriteResponse>(`/api/cart/items/${item.id}`, { warrantyPlanId: planId });
      applyCartWrite(data);
      setWarrantyPickerId(null);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : '';
      const text = err instanceof Error ? err.message : '';
      const message =
        code === 'WARRANTY_NOT_PRINTER'
          ? ew.errors.notPrinter
          : text.includes('WARRANTY_PLAN_NOT_FOUND')
            ? ew.errors.planGone
            : ew.errors.generic;
      setWarrantyErrors((prev) => ({ ...prev, [item.id]: message }));
    } finally {
      setWarrantySavingId(null);
      setWarrantyPendingPlan('');
      actionBusyRef.current -= 1;
    }
  };

  /** "+12 months → 24 months total" for an extension; a legacy plan's title. */
  const warrantyPlanLabel = (w: Pick<CartWarrantyPlan, 'duration_months' | 'duration_kind' | 'total_months' | 'title_ar' | 'title_en' | 'title_ckb'>) => {
    if (w.duration_kind !== 'extension') {
      return loc(w.title_ar || w.title_en || '', w.title_en || w.title_ar || '', w.title_ckb || w.title_ar || '');
    }
    const ext = ew.plan(monthsLabel(w.duration_months, lang));
    return typeof w.total_months === 'number' && w.total_months > 0
      ? `${ext} ${arrow} ${ew.total(monthsLabel(w.total_months, lang))}`
      : ext;
  };

  // ------------------------------------------------- support-code handlers
  const supportInfoFor = (ref: string | undefined) => (ref ? supportNames[ref.toLowerCase()] : undefined);
  const supportErrorFor = (ref: string | undefined) => (ref ? supportRefErrors[ref.toLowerCase()] : undefined);

  const currentRef = supportState.current?.ref ?? '';
  const conflictRef = supportState.conflict?.ref ?? '';
  const currentInfo = supportInfoFor(currentRef);
  const currentError = supportErrorFor(currentRef);
  /** ONLY a server-resolved code travels to checkout. */
  const activeSupportRef = currentInfo ? currentRef : '';

  const applyManualRef = () => {
    const clean = normalizeSupportRef(manualRef);
    if (!clean) {
      setManualError('invalid');
      return;
    }
    setManualError('');
    // A manual entry is the user's explicit decision: it overrides a link
    // capture and undoes an earlier removal of that same code.
    setSupportRefErrors((prev) => {
      const next = { ...prev };
      delete next[clean.toLowerCase()];
      return next;
    });
    setSupportState(captureSupportRef(clean, { source: 'manual' }));
    setManualRef('');
    setSupportOpen(true);
  };

  const pickSupportRef = (ref: string) => setSupportState(chooseSupportRef(ref));

  const dropSupportRef = () => {
    setManualError('');
    setSupportState(removeSupportRef());
  };

  const retrySupportRef = (ref: string) => {
    setSupportRefErrors((prev) => {
      const next = { ...prev };
      delete next[ref.toLowerCase()];
      return next;
    });
    // The stored ref itself is unchanged, so the resolver is re-armed by an
    // explicit tick rather than by pretending the code changed.
    setSupportRetry((n) => n + 1);
  };

  const selectedItems = items.filter((i) => selectedIds.has(i.id));
  /**
   * Honest, non-promissory fact: whether a SELECTED line carries the explicit
   * support-gift eligibility flag (resolved server-side from admin fields).
   * It is about the REFERRER's later claim — the buyer is promised nothing
   * and pays nothing different either way.
   */
  const hasEligibleSelectedLine = selectedItems.some(
    (i) => (i as CartItem & { support_gift_eligible?: boolean }).support_gift_eligible === true
  );
  const subtotal = selectedItems.reduce((sum, item) => sum + item.unit_price_iqd * item.qty, 0);
  // §4: savings come from the server-resolved membership price (regular vs
  // applied), never from the retired compare-at column.
  const discounts = selectedItems.reduce((sum, item) => {
    const b = item.breakdown;
    if (!b) return sum;
    return sum + Math.max(0, b.regular_iqd - b.applied_iqd) * item.qty;
  }, 0);
  const totalOriginalPrice = subtotal + discounts;
  const selectedCount = selectedItems.reduce((sum, item) => sum + item.qty, 0);

  /** The membership that is actually worth something on this screen, and the
   *  name a customer reads for it — `prime` is PREMIUM, and `tierMeta` is the
   *  only thing in the store that says so. */
  const activeMembership = membership && membership.active && isPaidTier(membership.tier) ? membership : null;
  const memberLabel = activeMembership ? tierLabel(activeMembership.tier) : '';

  /**
   * THE MEMBERSHIP'S LINE, PAIRED BACK TO THE ROW IT WAS RESOLVED FOR.
   *
   * `membership.lines` carries one entry per cart row, in the order the server
   * priced them, keyed by `product_id`. Two rows of the SAME product — two
   * colours, two options — therefore share a key, so the entries are handed
   * out in order rather than looked up: the first row of a product takes the
   * first entry, the second takes the second. A line with no rule behind it is
   * not paired at all, so nothing is said about it.
   */
  const membershipByItemId = useMemo(() => {
    const paired = new Map<string, MembershipLine>();
    const queues = new Map<string, MembershipLine[]>();
    for (const line of activeMembership?.lines ?? []) {
      const queue = queues.get(line.product_id);
      if (queue) queue.push(line);
      else queues.set(line.product_id, [line]);
    }
    for (const item of items) {
      const next = queues.get(item.productId)?.shift();
      if (next && next.rule_id) paired.set(item.id, next);
    }
    return paired;
  }, [items, activeMembership]);

  /**
   * WHAT THE MEMBERSHIP IS WORTH ON THE LINES THE CUSTOMER HAS TICKED.
   *
   * The server answered for the WHOLE cart; which of its lines are being
   * bought is the one thing only this page knows. So these add up the
   * SERVER's per-line figures for the selected rows — no percentage, no
   * threshold and no ceiling is applied here. With every line ticked they come
   * to `membership.discount_total_iqd` and `order_discount_iqd` exactly.
   */
  const memberInsideUnitPrices = selectedItems.reduce((sum, item) => {
    const line = membershipByItemId.get(item.id);
    return sum + (line && line.applied_at === 'unit' ? line.total_iqd : 0);
  }, 0);
  const memberOffTheOrder = selectedItems.reduce((sum, item) => {
    const line = membershipByItemId.get(item.id);
    return sum + (line && line.applied_at === 'line' ? line.total_iqd : 0);
  }, 0);
  /**
   * §2 — WHY THE SUMMARY SPLITS THE SAVING IN TWO, AND STILL ADDS UP.
   *
   * The subtotal on screen is the REGULAR merchandise total, so the whole
   * membership saving is named as a deduction from it. The part that is
   * already inside the unit prices is taken OUT of the general "Levo discount"
   * line rather than deducted a second time, and only `memberOffTheOrder`
   * actually moves the total:
   *
   *   subtotal(regular) − other − membership − points + delivery = total
   */
  const memberAlreadyInPrices = Math.min(memberInsideUnitPrices, discounts);
  const memberNamedSaving = memberAlreadyInPrices + memberOffTheOrder;
  const otherDiscounts = discounts - memberAlreadyInPrices;
  /** The merchandise after the part of the membership the order takes off. */
  const merchandise = Math.max(0, subtotal - memberOffTheOrder);
  /** Everything the selected lines saved, however each part was applied. */
  const savedTotal = otherDiscounts + memberNamedSaving;

  // Shipping preview only — the standard delivery method's configured price,
  // a server setting. The final figure, and every waiver (PRO, PRIME, a
  // referred friend's printer), is the checkout quote's: the thresholds live
  // in the server's shipping policy and are not repeated here, because a
  // browser-side copy of them had already drifted from the real rule once.
  const standardDelivery =
    checkoutDeliveryMethods.find((m) => m.id === 'standard') ?? checkoutDeliveryMethods[0];
  const shipping = selectedCount > 0 ? standardDelivery?.price_iqd ?? 0 : 0;

  // §5: points come after the membership, against the merchandise the
  // membership has already reduced.
  const pointsDiscount = usePoints ? Math.min(pointBalance, merchandise) : 0;
  const total = merchandise + shipping - pointsDiscount;

  /** A delivery method in the store's OWN configured words (a setting, never a
   *  label typed here); `dir` picks the script, as the shipping sheet does. */
  const deliveryMethodName = (id: DeliveryMethodId) => {
    const configured = checkoutDeliveryMethods.find((m) => m.id === id);
    return configured ? (dir === 'rtl' ? configured.titleAr : configured.titleEn) : id;
  };

  /**
   * THE FIGURE A FREE-DELIVERY THRESHOLD IS TESTED AGAINST (§3, "The basis").
   *
   * NOT `subtotal`. `subtotal` is `unit_subtotal_iqd × qty` — the applied
   * price PLUS the transport commission, the direct-sale premium and the
   * extended-warranty fee — and a threshold has never been tested against a
   * fee. The door's basis is `Σ applied price × qty` ("product prices only",
   * `worker/routes/orders.ts`), less the order-level part of the membership,
   * which §3 says the basis comes after. Comparing `subtotal` would promise
   * free delivery on a cart that clears the threshold only because a warranty
   * plan was ticked, and the checkout would then charge for it.
   *
   * Both figures in it are the server's — the unit price it applied and the
   * per-line saving it resolved. Only WHICH ROWS are counted is this page's,
   * because the ticks are the one thing the server was not told.
   *
   * (§3 tests the PREMIUM rule after points as well. That is the door's
   * business, and the row above already says the fee is settled there, so this
   * preview states the configured `merchandise_after_coupon` basis and
   * branches on no tier name.)
   */
  const deliveryBasis = Math.max(
    0,
    selectedItems.reduce(
      (sum, item) => sum + (item.breakdown ? item.breakdown.applied_iqd : item.unit_price_iqd) * item.qty,
      0
    ) - memberOffTheOrder
  );

  /**
   * FREE DELIVERY — ONLY WHAT THE SERVER'S ANSWER SUPPORTS.
   *
   * Every entry in `free_shipping` comes from the SAME rule — `ruleFor` is
   * asked without a method and the method check happens after it — so the
   * threshold, the covered methods and the subsidy ceiling are read from the
   * first entry that has a rule at all.
   *
   * The threshold is re-tested against the SELECTED merchandise, because
   * ticking a line off is a decision the server has not been told about — with
   * the store's one operator, STRICTLY GREATER (§3): 75,000 does not qualify,
   * 75,001 does, so what is still missing is one dinar more than the
   * difference. The NUMBER is the server's; only the comparison happens here.
   *
   * A ceiling is a MAXIMUM — `shippingAfterBenefit` covers `min(fee, ceiling)`
   * — so one that BINDS means the member pays the difference and no component
   * may claim to be free (§3), and one that does NOT bind must not be read out
   * as though the whole of it had been spent on this order.
   */
  const deliveryBenefit = (() => {
    if (selectedCount === 0) return null;
    const answered = (activeMembership?.free_shipping ?? []).filter((s) => s.reason !== 'no_rule');
    if (answered.length === 0) return null;
    const covered = answered.filter((s) => s.reason !== 'method_not_covered');
    if (covered.length === 0) return null;
    const threshold = answered[0].threshold_iqd;
    return {
      qualifies: threshold === null || deliveryBasis > threshold,
      shortBy: threshold === null ? 0 : Math.max(1, threshold - deliveryBasis + 1),
      subsidy: answered[0].max_subsidy_iqd,
      /** Named only where the rule does NOT cover every method on offer. */
      methodNames: covered.length === answered.length ? [] : covered.map((s) => deliveryMethodName(s.method)),
    };
  })();

  /**
   * WHICH CEILING BIT, in one short phrase, so a line that saved less than its
   * percentage suggests says why. The ceiling's own VALUE is never repeated
   * here — the rule owns it, and the saving beside this phrase is already the
   * capped figure.
   *
   * The Sorani reuses this file's own wording: «زۆرترین … بۆ هەر داواکارییەک»
   * is the bundle per-order limit in the item list, «بۆ هەر یەکێک لە … یەکەکە»
   * the extended-warranty per-unit line, and «داشکاندن» the discount row in
   * the summary. Nothing here was translated.
   */
  const cappedPhrase = (line: MembershipLine): string => {
    if (line.capped_by === 'per_unit') {
      return loc('الخصم بحد أقصى لكل وحدة', 'The discount is capped per unit', 'زۆرترین داشکاندن بۆ هەر یەکێک');
    }
    if (line.capped_by === 'per_order') {
      return loc('الخصم بحد أقصى لكل طلب', 'The discount is capped per order', 'زۆرترین داشکاندن بۆ هەر داواکارییەک');
    }
    if (line.capped_by === 'quantity') {
      return loc(
        `الخصم على ${line.eligible_qty} من الكمية`,
        `The discount covers ${line.eligible_qty} of the quantity`,
        `داشکاندن بۆ هەر یەکێک لە ${line.eligible_qty} یەکەکە`
      );
    }
    return '';
  };

  const variantItem = items.find((i) => i.id === variantItemId) ?? null;
  const shippingItem = items.find((i) => i.id === shippingItemId) ?? null;
  const warrantyItem = items.find((i) => i.id === warrantyPickerId) ?? null;

  // THE SHEETS NOW HAVE AN EXIT, SO THEY NEED SOMETHING TO LEAVE WITH.
  //
  // While these were `fixed inset-0` divs mounted on a boolean, the line they
  // described could disappear from `items` in the same tick the boolean went
  // false and nobody could tell: the whole window was gone that frame. It now
  // animates out over ~0.3s, and a confirmed variant change is exactly the case
  // where the row id retires — the server merges the edited line into an
  // existing one — so a fresh lookup would empty the panel and then slide an
  // empty box away, which reads as a bug rather than as a dismissal. Holding
  // the last line each sheet was showing lets the window leave saying what it
  // said. The live `shippingItem` is still what the write handler uses, so a
  // tap landing during the exit can never patch a retired id.
  const lastVariantItem = useRef<CartItem | null>(null);
  if (variantItem) lastVariantItem.current = variantItem;
  const variantView = variantItem ?? lastVariantItem.current;

  const lastShippingItem = useRef<CartItem | null>(null);
  if (shippingItem) lastShippingItem.current = shippingItem;
  const shippingView = shippingItem ?? lastShippingItem.current;

  // §3/§12: the product name is English in every language and is never translated.
  const itemName = (item: CartItem) => item.name;

  // A merchant-store cart is the same table with a different seller — and a
  // different screen, priced by /api/cart/merchant and checked out through
  // /api/store-orders instead of the platform resolver.
  if (merchantScope) return <MerchantCartView />;

  return (
    // `min-h-dvh`, not `min-h-screen`: on mobile `100vh` is the tall viewport
    // including the browser chrome, so a `100vh` floor inside a `100dvh` shell
    // manufactured a screenful of empty scroll range at the bottom of every
    // short page. The bottom padding clears the summary bar (≈76px) and the
    // safe area, and nothing more — `pb-48` (192px) was reserving room for a
    // nav that is no longer on this route.
    <div className="w-full max-w-full overflow-x-clip pt-16 pb-[calc(var(--nav-stack)+148px)] sm:pb-[calc(var(--nav-stack)+92px)] text-text-secondary min-h-dvh bg-canvas flex flex-col font-sans">
      {/* Header */}
      {/* `backdrop-blur-xl` behind a fully opaque `bg-black` was a compositing
          layer blurring nothing. Translucent, like the product page's bar, so
          content passing underneath actually frosts. */}
      <div className="fixed inset-x-0 top-0 z-40 flex items-center justify-between border-b border-border-subtle bg-canvas/96 px-4 py-3 backdrop-blur-lg">
        <button type="button" onClick={() => navigate(-1)} className="flex h-10 w-10 items-center justify-center rounded-lg text-text-secondary hover:bg-white/[0.05] hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
          {dir === 'rtl' ? <ArrowRight className="w-6 h-6" /> : <ArrowLeft className="w-6 h-6" />}
        </button>
        <h1 className="text-white font-bold text-[17px]">
          {t('cart' as any) || loc('السلة', 'Cart', 'سەبەتە')}
        </h1>
        <button
          type="button"
          onClick={() => navigate('/profile')}
          className="text-[15px] text-zinc-300 hover:text-white font-medium"
        >
          {loc('المفضلة', 'Favorites', 'دڵخوازەکان')}
        </button>
      </div>

      {/* Main Content */}
      {/* A plain column. This declared `overflow-y-auto` inside the app's own
          scroll container while its flex parent had an indefinite height, so
          it never actually scrolled — dead weight that disabled scroll
          anchoring and would silently break any `position: sticky` child. */}
      <div className="mx-auto w-full max-w-4xl flex-1">
        {error && (
          <div className="lv-alert lv-alert-danger mx-4 mt-3 flex items-center justify-between gap-3 text-sm text-red-300">
            <span>{error}</span>
            <button type="button" onClick={() => setError('')} className="shrink-0 p-1 hover:text-white"><X className="w-4 h-4" /></button>
          </div>
        )}

        {loading ? (
          // The skeleton owns the screen while it is the screen. Without a
          // height of its own it was a 200px block on an otherwise empty page,
          // so where it appeared depended entirely on the scroll offset the
          // previous route left behind.
          <div className="min-h-[60dvh] pt-3">
            <CartSkeleton rows={3} />
          </div>
        ) : loadError != null ? (
          <div className="mx-4 mt-6">
            <ErrorState error={loadError} onRetry={retryLoadCart} next="/cart" />
          </div>
        ) : items.length === 0 ? (
          <div className="lv-surface mx-4 mt-6 flex flex-col items-center gap-4 py-14 text-center text-text-muted">
            <ShoppingCart className="w-10 h-10 text-zinc-700" />
            <p>{loc('سلتك فارغة', 'Your cart is empty.', 'سەبەتەکەت بەتاڵە.')}</p>
            <button
              type="button"
              onClick={() => navigate('/products')}
              className="lv-button lv-button-primary px-6"
            >
              {loc('تسوق الآن', 'Shop now', 'ئێستا بکڕە')}
            </button>
          </div>
        ) : (
        <>
        <div className="bg-surface pb-3 sm:mx-4 sm:mt-4 sm:rounded-xl">
          {/* Group Header */}
          <div className="px-4 py-3 flex items-center gap-2">
            <span className="text-zinc-300 text-[15px] font-medium">
              {loc('شحن بواسطة ليفو', 'Shipped by Levo', 'گەیاندن لەلایەن لیڤۆ')}
            </span>
          </div>

          {/* Items */}
          {items.map((item) => {
            const hasVariants = (item.options ?? []).length > 0 || (item.colors ?? []).length > 0;
            const hasShippingOptions = (item.shipping_methods ?? []).length > 0;
            const regularUnit = item.breakdown?.regular_iqd ?? null;
            const appliedUnit = item.breakdown?.applied_iqd ?? null;
            const hasSale = regularUnit !== null && appliedUnit !== null && appliedUnit < regularUnit;
            const discountPct = hasSale
              ? Math.round((1 - (appliedUnit as number) / (regularUnit as number)) * 100)
              : 0;
            /**
             * WHAT THE MEMBERSHIP TOOK OFF THIS LINE — the server's figure for
             * this row, not the difference between two unit prices.
             *
             * The percentage above describes the UNIT price, which is a fact
             * of the line whatever produced it (an offer window, a typed
             * member price, a membership rule that fits a unit price). It
             * cannot describe a rule that covers only the first two units, or
             * one held down by a per-order ceiling — and a rule applied at the
             * line leaves the unit price at the regular one, so it shows no
             * percentage at all. `total_iqd` is the whole line's true saving,
             * after every ceiling the rule carries.
             */
            const memberLine = membershipByItemId.get(item.id) ?? null;
            const memberSaving = memberLine && memberLine.total_iqd > 0 ? memberLine.total_iqd : 0;
            const selected = selectedIds.has(item.id);
            // A line the server will refuse at checkout because it never chose
            // an option or colour (a row written before the cart enforced it).
            const incomplete = item.availability?.selection ? !item.availability.selection.complete : false;
            return (
              // A hairline between rows: the list had no separation at all, so
              // three products read as one dense block. `last:` keeps the
              // group's own bottom edge clean.
              <div key={item.id} className="max-w-full px-2.5 sm:px-4 py-3.5 flex gap-1.5 sm:gap-3 border-b border-border-subtle last:border-b-0">
                {/* A 22px dot inside a 44px target: the dot is the design, the
                    target is what a thumb actually hits. It was a bare <div>
                    with an onClick — unreachable by keyboard and silent to a
                    screen reader. */}
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={selected}
                  aria-label={itemName(item)}
                  onClick={() => toggleSelect(item.id)}
                  className="shrink-0 w-9 sm:w-11 min-h-[44px] pt-4 sm:pt-6 flex items-start justify-center -ms-1 sm:-ms-2 [touch-action:manipulation]"
                >
                  <span
                    aria-hidden="true"
                    className={`w-[22px] h-[22px] rounded-md border flex items-center justify-center transition-colors ${
                      selected ? 'bg-surface-selected border-white/30' : 'border-zinc-600'
                    }`}
                  >
                    {selected && <Check className="w-3.5 h-3.5 text-gold" strokeWidth={3} />}
                  </span>
                </button>

                {/* Product Image */}
                <div
                  data-cart-item-image
                  className="w-[72px] h-[72px] min-[390px]:w-[80px] min-[390px]:h-[80px] sm:w-[100px] sm:h-[100px] shrink-0 rounded-md overflow-hidden bg-zinc-900 cursor-pointer"
                  onClick={() => navigate(`/product/${item.slug}`)}
                >
                  <SafeImage
                    src={item.image}
                    alt={itemName(item)}
                    aspect="auto"
                    className="w-full h-full"
                    /* The only pure-white surface in the entire app sat here,
                       as a 100×100 plate on a near-black page — and
                       `mix-blend-multiply` existed to hide the white edges of
                       product cutouts against it. A neutral dark plate needs
                       neither, and it is what every other image surface in the
                       app already uses. */
                    bgClassName="bg-zinc-900"
                    fallbackClassName="text-zinc-600"
                  />
                </div>

                {/* Product Details */}
                <div className="min-w-0 max-w-full flex-1 flex flex-col justify-between">
                  <div>
                    <h3 data-cart-item-title className="text-zinc-200 text-[13px] sm:text-[14px] font-medium leading-snug line-clamp-2 mb-1">{itemName(item)}</h3>

                    <div className="flex flex-wrap gap-1.5 mb-1.5">
                      {hasVariants && (
                        <button
                          type="button"
                          onClick={() => openVariantModal(item)}
                          aria-invalid={incomplete || undefined}
                          className={`rounded px-2 py-1 flex items-center gap-1 w-max border ${
                            incomplete ? 'bg-amber-500/10 border-amber-500/50' : 'bg-zinc-900 border-zinc-800'
                          }`}
                        >
                          <span className={`text-[12px] ${incomplete ? 'text-amber-200' : 'text-zinc-300'}`}>
                            {incomplete
                              ? loc('اختر الخيار أولًا', 'Choose an option first', 'سەرەتا هەڵبژاردەیەک هەڵبژێرە')
                              : item.variantLabel || loc('اختر الخيارات', 'Choose options', 'هەڵبژاردنەکان دیاری بکە')}
                          </span>
                          <ChevronRight className="w-3 h-3 text-zinc-500" />
                        </button>
                      )}

                      {/* The line's journey — direct, or pre-order by air /
                          sea / land — read from the transport the server
                          priced. The legacy shipping sheet stays reachable
                          only where a product still lists legacy methods. */}
                      {hasShippingOptions ? (
                        <button
                          type="button"
                          onClick={() => openShippingModal(item)}
                          className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 flex items-center gap-1 w-max"
                        >
                          <span className="text-[12px] text-zinc-300">{shippingLabel(item)}</span>
                          <ChevronRight className="w-3 h-3 text-zinc-500" />
                        </button>
                      ) : (
                        <span
                          data-cart-shipping-type={typeForTransport(item.transport_method)}
                          className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 flex items-center gap-1 w-max text-[12px] text-zinc-300"
                        >
                          {shippingLabel(item)}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="min-w-0 flex flex-wrap items-baseline gap-1.5 mb-2 mt-1">
                    <span className="max-w-full text-white font-semibold text-[15px] sm:text-[17px] tabular-nums">{money(item.unit_price_iqd)}</span>
                    {hasSale && (
                      <>
                        <span className="text-zinc-500 text-[12px] line-through">{(regularUnit as number).toLocaleString()}</span>
                        <span className="text-gold text-[12px] font-bold tabular-nums">−{discountPct}%</span>
                      </>
                    )}
                  </div>

                  {/* The membership named on the line it paid for. The Sorani
                      is this file's own «پاشەکەوتت کرد» (the summary bar) with
                      the Referrals page's «ئەندامێتی PRO»; only the Latin tier
                      name is a variable, as it is in every language. */}
                  {memberSaving > 0 && memberLabel && (
                    <p className="-mt-1 mb-2 text-[11.5px] leading-relaxed text-gold/90" data-cart-member-saving={item.id}>
                      <span className="tabular-nums">
                        {loc(
                          `وفّرت ${money(memberSaving)} بعضوية ${memberLabel}`,
                          `Saved ${money(memberSaving)} with ${memberLabel} membership`,
                          `پاشەکەوتت کرد ${money(memberSaving)} — ئەندامێتی ${memberLabel}`
                        )}
                      </span>
                      {memberLine && memberLine.capped_by !== 'none' && (
                        <span className="text-zinc-500"> · {cappedPhrase(memberLine)}</span>
                      )}
                    </p>
                  )}

                  {/* A BUNDLE IS ONE LINE WITH ITS CONTENTS UNDERNEATH
                      (docs/BUNDLES_MYSTERY.md §5.2). The parts are never
                      separate cart rows: the totals above already count the
                      bundle once, and the per-part figure below is that part's
                      STANDALONE value, labelled as such by the disclosure. */}
                  {/* A MYSTERY LINE HAS NO CONTENTS TO EXPAND, by design: its
                      spools are drawn at checkout and the pick is not told
                      before its milestone (§8.2 row 12). What it can honestly
                      say is how many, and when. */}
                  {item.composition?.mystery && (
                    <p
                      className="mb-2 flex items-center gap-1.5 text-[11.5px] text-zinc-400"
                      data-cart-mystery={item.id}
                    >
                      <Sparkles className="w-3 h-3 shrink-0 text-gold" aria-hidden="true" />
                      {/* HOW MANY, AND WHEN. The comment above promised both
                          and only the count was rendered, so the cart — the
                          screen where the customer is committing to a purchase
                          whose contents are hidden — told them the least about
                          it. The milestone is the SERVER's own sentence from
                          `stageLabel`, never a second stage table here. */}
                      <span className="truncate">
                        {loc(
                          `${item.composition.mystery.spool_qty} قطعة عشوائية`,
                          `${item.composition.mystery.spool_qty} random item(s)`,
                          `${item.composition.mystery.spool_qty} دانەی هەڕەمەکی`
                        )}
                        {item.composition.mystery.reveal_stage_label
                          ? ` — ${loc('يُكشف', 'revealed', 'ئاشکرا دەبێت')} ${item.composition.mystery.reveal_stage_label}`
                          : ''}
                      </span>
                    </p>
                  )}

                  {item.composition && (
                    <BundleContents
                      className="mb-2"
                      componentTotalIqd={item.composition.component_total_iqd}
                      savingPercent={item.composition.saving_percent}
                      lines={item.composition.components.map((k) => ({
                        key: k.component_id,
                        name: k.product.name,
                        name_ar: k.product.name_ar,
                        variant: k.variant,
                        qty: k.qty_per_bundle,
                        value_iqd: k.value_iqd,
                        optional: k.optional,
                        included: k.included,
                      }))}
                    />
                  )}

                  {/* The fee line: the unit price above already INCLUDES the
                      chosen extension, so this names the part of it that is
                      warranty — the resolver's dinar, never re-computed. */}
                  {item.breakdown?.warranty && (
                    <p className="-mt-1.5 mb-2 text-[11.5px] text-zinc-400 tabular-nums flex items-center gap-1.5" data-cart-warranty-fee={item.id}>
                      <ShieldCheck className="w-3 h-3 text-gold shrink-0" aria-hidden="true" />
                      <span className="truncate">
                        {ew.includes} · +{money(item.breakdown.warranty.fee_iqd)}
                      </span>
                    </p>
                  )}

                  {(item.warranty_plans ?? []).length > 0 && (() => {
                    const current = (item.warranty_plans ?? []).find((w) => w.id === (item.warranty_plan_id ?? '')) ?? null;
                    return (
                      <div className="mb-2" data-cart-ext-warranty={item.id}>
                        <button
                          type="button"
                          aria-haspopup="dialog"
                          onClick={() => setWarrantyPickerId(item.id)}
                          className="lv-choice w-full min-h-[40px] px-2.5 py-1.5 flex items-center gap-2 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                          data-selected={!!current}
                        >
                          <ShieldCheck className={`w-3.5 h-3.5 shrink-0 ${current ? 'text-gold' : 'text-zinc-400'}`} aria-hidden="true" />
                          <span className="min-w-0 flex-1">
                            <span className="block text-[12px] font-bold text-zinc-200 leading-tight">{ew.title}</span>
                            <span className={`block text-[11px] leading-tight truncate tabular-nums ${current ? 'text-gold/90' : 'text-zinc-500'}`}>
                              {current ? `${warrantyPlanLabel(current)} · +${money(current.fee_iqd)}` : ew.none}
                            </span>
                          </span>
                          <ChevronRight className={`w-3.5 h-3.5 text-zinc-500 shrink-0 ${dir === 'rtl' ? 'rotate-180' : ''}`} aria-hidden="true" />
                        </button>
                      </div>
                    );
                  })()}

                  {/* A pre-order line whose price would change under cash on
                      delivery: the server's `cod_reprices`, never inferred. */}
                  {item.cod_reprices === true && (
                    <p className="-mt-1 mb-2 text-[11px] text-zinc-500 leading-relaxed" data-cart-cod-hint={item.id}>
                      {codHint}
                    </p>
                  )}

                  {/* A printer going to a home address: the owner's note, from
                      the server's flag and the server's amount — shown, never
                      added to the total. Gold: the store's own terms, the
                      same tone the product page and the order use. */}
                  {item.is_printer && printerNoteIqd !== null && (
                    <Note tone="zinc" compact animate={false} icon={<Truck className="w-3.5 h-3.5" />} className="mb-2 !border-x-0 !border-e-0 !border-y-0 !rounded-none !bg-transparent !py-1.5 !ps-2.5 !pe-0 !text-[11px] text-text-muted" testId="cart-printer-note">
                      {printerNoteText(money(printerNoteIqd))}
                    </Note>
                  )}

                  {/* The price moved since this cart was opened. The new one is
                      what the shop charges, so it is already applied — this
                      only stops the customer wondering whether they misread it
                      the first time. */}
                  {movedPrices.has(item.id) && (
                    <p
                      className={`mb-2 -mt-1 text-[11.5px] font-semibold ${
                        movedPrices.get(item.id)!.to > movedPrices.get(item.id)!.from ? 'text-amber-300' : 'text-gold'
                      }`}
                      data-price-moved={item.id}
                    >
                      {(() => {
                        const m = movedPrices.get(item.id)!;
                        const was = money(m.from);
                        const up = m.to > m.from;
                        if (lang === 'en') {
                          return up
                            ? `The price went up from ${was} while this was in your cart.`
                            : `The price dropped from ${was} while this was in your cart.`;
                        }
                        if (lang === 'ckb') {
                          return up
                            ? `نرخەکە بەرزبووەتەوە لە ${was} کاتێک لە سەبەتەکەت بوو.`
                            : `نرخەکە داشکاوە لە ${was} کاتێک لە سەبەتەکەت بوو.`;
                        }
                        return up
                          ? `تغيّر السعر وارتفع من ${was} أثناء وجوده في السلة.`
                          : `تغيّر السعر وانخفض من ${was} أثناء وجوده في السلة.`;
                      })()}
                    </p>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2 mt-auto">
                    <div className="flex flex-wrap items-center gap-2">
                      {/* THE CAP IS THE SERVER'S, AND THE STEPPER DISABLES AT IT
                          (§10). A composition line's `stock` is NULL for ever by
                          design (§1.2), so the scarcity line below could never
                          fire for a bundle however scarce its blocking
                          component was — and tapping '+' at `max_qty` silently
                          did nothing at all, because `clampQty` clamped to the
                          same number and `updateQuantity` returned when the
                          clamp changed nothing. `BUNDLE_QTY_LIMIT` is
                          translated and wired, and could never be reached from
                          the UI. */}
                      {/* 28×28px before — every control in this row was under
                          the 44px floor the same file uses in four other
                          places. The minus no longer doubles as a delete: the
                          Delete button beside it is the one removal path, so a
                          mis-tap at qty 1 can no longer empty a line. */}
                      <div className="flex items-center rounded-lg bg-surface-raised overflow-hidden">
                        <button
                          type="button"
                          aria-label={loc('إنقاص الكمية', 'Decrease quantity', 'کەمکردنەوەی بڕ')}
                          data-mascot="qty-dec"
                          onClick={() => updateQuantity(item, -1)}
                          disabled={item.qty <= 1}
                          className="w-11 h-11 flex items-center justify-center text-text-secondary disabled:opacity-35 active:bg-white/[0.06] transition-colors [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                        >
                          <Minus aria-hidden="true" className="w-4 h-4" />
                        </button>
                        <span
                          aria-live="polite"
                          className="w-9 h-11 flex items-center justify-center text-[15px] font-bold text-white tabular-nums border-x border-border-subtle"
                        >
                          {item.qty}
                        </span>
                        <button
                          type="button"
                          aria-label={loc('زيادة الكمية', 'Increase quantity', 'زیادکردنی بڕ')}
                          data-mascot="qty-inc"
                          onClick={() => updateQuantity(item, 1)}
                          disabled={lineCap(item) !== null && item.qty >= (lineCap(item) as number)}
                          className="w-11 h-11 flex items-center justify-center text-text-secondary disabled:opacity-35 active:bg-white/[0.06] transition-colors [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                        >
                          <Plus aria-hidden="true" className="w-4 h-4" />
                        </button>
                      </div>
                      {item.composition ? (
                        item.qty >= item.composition.max_qty && (
                          <span className="text-amber-300/90 text-[12px]">
                            {loc(
                              `الحد الأقصى ${item.composition.max_qty} لكل طلب`,
                              `At most ${item.composition.max_qty} per order`,
                              `زۆرترین ${item.composition.max_qty} بۆ هەر داواکارییەک`
                            )}
                          </span>
                        )
                      ) : (
                        (() => {
                          /* 0075 — THE COUNTER THIS LINE CONSUMES, NAMED.
                             This read the legacy base `stock` column, so a
                             pre-order line advertised a shelf it does not
                             come off, and an option-tracked product showed
                             the wrong level entirely. Both numbers now come
                             from the server's resolution for this line. */
                          const rem = lineRemaining(item);
                          const cap = lineCap(item);
                          /**
                           * SOLD OUT IS NOT «متبقي 0 فقط».
                           *
                           * A line the door will refuse says so in red and
                           * names the fix, instead of quietly counting down to
                           * zero in amber beside an enabled checkout button.
                           * The two cases read differently because the
                           * remedies are different: nothing left is a line to
                           * remove, fewer left than asked for is a quantity to
                           * lower — so that one prints the number to lower it
                           * TO, which is the whole of what the customer has to
                           * do next.
                           */
                          if (lineBlocked(item) && !item.composition) {
                            const soldOut = item.availability?.mode === 'unavailable' || rem?.left === 0;
                            return (
                              <span className="text-danger text-[12px] font-medium" data-line-blocked={item.id}>
                                {soldOut
                                  ? loc('نفد المخزون', 'Out of stock', 'کۆگا بەتاڵە')
                                  : typeof cap === 'number'
                                    ? loc(
                                        `بقي ${cap} فقط — قلّل الكمية`,
                                        `Only ${cap} left — lower the quantity`,
                                        `تەنها ${cap} ماوە — بڕەکە کەم بکەرەوە`
                                      )
                                    : loc('الكمية المطلوبة غير متوفرة', 'That quantity is not available', 'ئەو بڕە بەردەست نییە')}
                              </span>
                            );
                          }
                          if (!rem || rem.left >= 10) return null;
                          return (
                            <span className="text-amber-300/90 text-[12px]" data-line-remaining={item.id}>
                              {rem.preorder
                                ? loc(
                                    `بقي ${rem.left} من حصة الطلب المسبق`,
                                    `${rem.left} left in the pre-order quota`
                                  )
                                : loc(`متبقي ${rem.left} فقط`, `Only ${rem.left} left`, `تەنها ${rem.left} ماوە`)}
                            </span>
                          );
                        })()
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => deleteItem(item)}
                      className="lv-button lv-button-ghost min-h-[44px] px-3 text-[13px] hover:text-danger [touch-action:manipulation]"
                    >
                      {loc('حذف', 'Delete', 'سڕینەوە')}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Deals Row */}
        <div className="mt-2 flex flex-col bg-surface sm:mx-4 sm:rounded-xl">
          <div onClick={() => setDealsExpanded(!dealsExpanded)} className="px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-zinc-900/30 transition-colors">
            <div className="flex items-center gap-2">
              <svg viewBox="0 0 24 24" className="w-5 h-5 text-zinc-400" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
              </svg>
              <span className="text-zinc-200 text-[15px] font-bold">{loc('العروض والخصومات', 'Deals & Discounts', 'ئۆفەر و داشکاندن')}</span>
              {(usePoints && pointsDiscount > 0) && (
                <span className="bg-gold/10 text-gold text-[11px] font-bold px-1.5 py-0.5 rounded">{loc('تم التطبيق', 'Applied', 'جێبەجێ کرا')}</span>
              )}
            </div>
            <ChevronRight className={`w-4 h-4 text-zinc-500 transition-transform ${dealsExpanded ? 'rotate-90' : ''}`} />
          </div>

          {dealsExpanded && (
            <div className="px-4 pb-4 pt-1 animate-in slide-in-from-top-2 fade-in duration-200">
              <p className="text-zinc-400 text-sm mb-3">{loc('استخدم نقاطك للحصول على خصم', 'Use your points for a discount', 'خاڵەکانت بۆ داشکاندن بەکاربهێنە')}</p>
              {/*
                POINTS — a switch, not a lit-up card.

                This was an emerald-bordered panel with an emerald-tinted fill,
                an emerald system checkbox and emerald bold text, on a page
                whose only other accent is gold. Four emerald signals for one
                boolean is the "AI-generated" look the owner named: colour used
                as decoration rather than as meaning.

                Now it reads like the rest of the store. The row is a quiet
                surface; the SWITCH is the only thing that lights, in the gold
                that means "a benefit is in force" everywhere else — the same
                gold as the PRO badge and the savings line.
              */}
              <div className="mb-4">
                <label
                  className={`flex items-center justify-between gap-3 min-h-[56px] px-3 rounded-xl border transition-colors ${
                    pointBalance === 0
                      ? 'border-zinc-800/60 bg-zinc-900/30 opacity-60'
                      : 'border-zinc-800 bg-zinc-900/50 cursor-pointer hover:border-zinc-600'
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block font-bold text-zinc-200 text-[14px]">
                      {loc('استخدام النقاط', 'Use Points', 'بەکارهێنانی خاڵ')}
                    </span>
                    <span className="block text-xs text-zinc-400 tabular-nums">
                      {loc(`رصيدك: ${pointBalance.toLocaleString()} نقطة = ${pointBalance.toLocaleString()} د.ع`, `Balance: ${pointBalance.toLocaleString()} pts = ${pointBalance.toLocaleString()} IQD`, `باڵانست: ${pointBalance.toLocaleString()} خاڵ = ${pointBalance.toLocaleString()} د.ع`)}
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    className="peer sr-only"
                    checked={usePoints}
                    onChange={() => setUsePoints(!usePoints)}
                    disabled={pointBalance === 0}
                  />
                  {/*
                    The knob is a CHILD of the track, not a sibling of the
                    input, so `peer-checked:` cannot reach it directly (the
                    peer variant compiles to a sibling combinator). The nested
                    `[&>span]` selector is what carries the state inward.

                    It travels on `inset-inline-start` rather than a translate
                    so the switch reads correctly in Arabic and Kurdish without
                    a second, mirrored rule — and it is the only property that
                    moves, on a 22px dot.
                  */}
                  <span
                    aria-hidden="true"
                    className="relative shrink-0 w-[46px] h-[28px] rounded-full bg-zinc-700 transition-colors duration-200 peer-checked:bg-gold peer-checked:[&>span]:start-[21px] peer-focus-visible:ring-2 peer-focus-visible:ring-gold peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-black"
                  >
                    <span className="absolute top-[3px] start-[3px] w-[22px] h-[22px] rounded-full bg-white transition-[inset-inline-start] duration-200 ease-out" />
                  </span>
                </label>
              </div>

              {/* The engine behind this has existed since migration 0002; the
                  box was disabled because nothing could create a code and
                  nothing could type one. Both halves exist now. */}
              <PromoCodeField lang={lang} />
            </div>
          )}
        </div>

        {/* ------------------------------------------------- Support code
            §3.3: separate from the discount coupon and from points, shown
            automatically when a share link brought one, removable for good,
            enterable by hand, and with ZERO effect on any amount below. */}
        <div className="mt-2 flex flex-col bg-surface sm:mx-4 sm:rounded-xl">
          <button
            type="button"
            onClick={() => setSupportOpen((v) => !v)}
            aria-expanded={supportOpen}
            aria-controls="support-code-panel"
            className="px-4 py-3 flex items-center justify-between text-start hover:bg-zinc-900/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
          >
            <div className="flex items-center gap-2 min-w-0">
              <HeartHandshake className="w-5 h-5 text-zinc-400 shrink-0" aria-hidden="true" />
              <span className="text-zinc-200 text-[15px] font-bold">{sc.title}</span>
              {activeSupportRef && currentInfo && (
                <span className="bg-gold/10 text-gold text-[11px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap">
                  @{currentInfo.username || activeSupportRef}
                </span>
              )}
              {conflictRef && (
                <span className="bg-amber-500/10 text-amber-400 text-[11px] font-medium px-1.5 py-0.5 rounded whitespace-nowrap">
                  {sc.chooseBadge}
                </span>
              )}
            </div>
            <ChevronRight className={`w-4 h-4 text-zinc-500 transition-transform shrink-0 ${supportOpen ? 'rotate-90' : ''}`} aria-hidden="true" />
          </button>

          <div id="support-code-panel" hidden={!supportOpen} className="px-4 pb-4 pt-1">
            <p className="text-[12.5px] text-zinc-400 leading-relaxed mb-3 flex items-start gap-1.5">
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
              <span>{sc.explain}</span>
            </p>

            {/* Two different links arrived — the user picks, nothing is swapped. */}
            {conflictRef && (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 mb-3">
                <p className="text-[13px] font-bold text-amber-300 mb-2">{sc.chooseTitle}</p>
                <div className="flex flex-col gap-2">
                  {[currentRef, conflictRef].filter(Boolean).map((ref) => {
                    const info = supportInfoFor(ref);
                    const err = supportErrorFor(ref);
                    return (
                      <button
                        key={ref}
                        type="button"
                        onClick={() => pickSupportRef(ref)}
                        disabled={!!err}
                        className="flex items-center justify-between gap-2 min-h-[44px] px-3 rounded-lg border border-zinc-700 bg-zinc-900/60 text-start text-zinc-200 hover:border-zinc-500 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
                      >
                        <span dir="ltr" className="font-mono text-[13px] truncate">@{info?.username || ref}</span>
                        <span className="text-[11px] text-zinc-500 truncate">
                          {err ? sc.errors[err] ?? sc.errors.unknown : info?.display_name || ''}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* The active code. */}
            {currentRef ? (
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3 mb-3">
                {currentInfo ? (
                  <>
                    <p className="text-[13px] text-zinc-200 leading-relaxed">
                      {sc.supportsPrefix}
                      <span dir="ltr" className="font-mono font-bold text-white mx-1">@{currentInfo.username || currentRef}</span>
                      {sc.supportsSuffix}
                    </p>
                    {currentInfo.display_name && (
                      <p className="text-[11.5px] text-zinc-500 mt-0.5">{currentInfo.display_name}</p>
                    )}
                  </>
                ) : currentError ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[13px] text-amber-400 flex-1 min-w-0">
                      {sc.errors[currentError] ?? sc.errors.unknown}
                      <span dir="ltr" className="font-mono text-zinc-400 ms-1">@{currentRef}</span>
                    </p>
                    {currentError === 'network' && (
                      <button
                        type="button"
                        onClick={() => retrySupportRef(currentRef)}
                        className="min-h-[36px] px-3 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-200 text-[12px] font-bold hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
                      >
                        {sc.retry}
                      </button>
                    )}
                  </div>
                ) : (
                  <p className="text-[13px] text-zinc-400 flex items-center gap-2">
                    <Spinner size="xs" delayMs={0} decorative />
                    {sc.resolving}
                  </p>
                )}
                {/* §3.3: the product the share came from is REMEMBERED, so a
                    multi-product cart is never re-attributed wholesale to the
                    last link the buyer happened to open. */}
                {supportState.current?.product && (
                  <p className="text-[11.5px] text-zinc-500 mt-1.5">
                    {sc.fromProduct} <span dir="ltr" className="font-mono">{supportState.current.product}</span>
                  </p>
                )}
                {currentInfo && hasEligibleSelectedLine && (
                  <p className="text-[11.5px] text-zinc-500 mt-1.5">{sc.eligibleLine}</p>
                )}
                <div className="flex items-center justify-between gap-2 mt-2">
                  <span className="text-[11.5px] text-zinc-400">{sc.noPriceEffect}</span>
                  <button
                    type="button"
                    onClick={dropSupportRef}
                    className="min-h-[36px] px-3 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-300 text-[12px] font-bold hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
                  >
                    {sc.remove}
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-[12.5px] text-zinc-500 mb-3">
                {supportState.dismissed.length > 0 ? sc.removedNote : sc.none}
              </p>
            )}

            {/* Manual entry — always available (§3.3: never mandatory). */}
            <label htmlFor="support-code-input" className="block text-[12.5px] text-zinc-300 font-bold mb-1.5">
              {sc.manualLabel}
            </label>
            <div className="flex gap-2">
              <input
                id="support-code-input"
                type="text"
                dir="ltr"
                inputMode="text"
                autoComplete="off"
                value={manualRef}
                onChange={(e) => { setManualRef(e.target.value); if (manualError) setManualError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyManualRef(); } }}
                placeholder={sc.manualPlaceholder}
                aria-invalid={!!manualError}
                aria-describedby={manualError ? 'support-code-error' : undefined}
                className="flex-1 min-w-0 bg-zinc-900 border border-zinc-800 rounded-lg px-3 min-h-[44px] text-white outline-none focus:border-[#BAA369] transition-colors text-sm font-mono text-start"
              />
              <button
                type="button"
                onClick={applyManualRef}
                disabled={supportResolving}
                className="bg-zinc-800 border border-zinc-700 text-zinc-100 font-bold px-4 min-h-[44px] rounded-lg text-sm hover:bg-zinc-700 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
              >
                {sc.apply}
              </button>
            </div>
            {manualError && (
              <p id="support-code-error" role="alert" className="text-[12px] text-red-400 mt-1.5">
                {sc.errors.invalid}
              </p>
            )}
          </div>
        </div>

        {/* Summary Details */}
        <div className="mt-2 bg-surface p-4 mb-4 flex flex-col gap-3 sm:mx-4 sm:rounded-xl">
          <h3 className="text-white font-bold text-[16px] mb-1">{loc('ملخص الطلب', 'Order Summary', 'کورتەی داواکاری')}</h3>

          <div className="flex justify-between items-center">
            <span className="text-zinc-400 text-[14px]">{loc('المجموع الفرعي', 'Subtotal', 'کۆی بەشی')}</span>
            <span className="text-zinc-200 text-[14px] font-medium">{money(totalOriginalPrice)}</span>
          </div>

          {otherDiscounts > 0 && (
            <div className="flex justify-between items-center text-gold/90">
              <div className="flex items-center gap-1">
                <span className="text-[14px]">{loc('خصم ليفو', 'Levo Discount', 'داشکاندنی لیڤۆ')}</span>
              </div>
              <span className="text-[14px] font-medium">- {money(otherDiscounts)}</span>
            </div>
          )}

          {/* THE MEMBERSHIP, NAMED. "خصم ليفو" said nothing about who earned
              the saving or why; the tier that did is on its own line now, with
              the WHOLE saving beside it — the part already inside the line
              prices and the part this order takes off. The row above carries
              only what the membership did not do, so the column still adds up
              to the total (§2). */}
          {memberNamedSaving > 0 && memberLabel && (
            <div className="flex justify-between items-center text-gold/90" data-cart-member-discount>
              <div className="flex items-center gap-1">
                <span className="text-[14px]">
                  {loc(
                    `خصم عضوية ${memberLabel}`,
                    `${memberLabel} membership discount`,
                    `داشکاندنی ئەندامێتی ${memberLabel}`
                  )}
                </span>
              </div>
              <span className="text-[14px] font-medium">- {money(memberNamedSaving)}</span>
            </div>
          )}

          {pointsDiscount > 0 && (
            <div className="flex justify-between items-center text-gold/90">
              <div className="flex items-center gap-1">
                <span className="text-[14px]">{loc('خصم النقاط', 'Points Discount', 'داشکاندنی خاڵ')}</span>
              </div>
              <span className="text-[14px] font-medium">- {money(pointsDiscount)}</span>
            </div>
          )}

          <div className="flex justify-between items-center">
            <span className="text-zinc-400 text-[14px]">
              {loc('التوصيل (يُحدد عند الدفع)', 'Shipping (final at checkout)', 'گەیاندن (لە کاتی پارەدان دیاری دەکرێت)')}
            </span>
            <span className="text-zinc-200 text-[14px] font-medium">
              {shipping === 0 ? (
                <span className="text-gold">{loc('مجاني', 'Free', 'بەخۆڕایی')}</span>
              ) : (
                money(shipping)
              )}
            </span>
          </div>

          {/* WHAT THE MEMBERSHIP DOES TO THE DELIVERY, beside the fee it
              applies to. The row above stays the store's preview and the
              checkout stays the authority on the figure; this only says what
              the server already resolved about the membership's half of it.
              The Sorani «گەیاندنی بێبەرامبەری PREMIUM» is the membership
              ledger's own line and «زیاد بکە» the reorder and shipping-conflict
              dialogs'. The capped-subsidy sentence has no Sorani anywhere, so
              it reads in Arabic there rather than in invented Kurdish — and it
              says «حتى / up to», because the ceiling is the most the
              membership can cover, not what it spent on this fee. */}
          {deliveryBenefit && memberLabel && (
            <p className="-mt-1 text-[12px] leading-relaxed text-gold/90 tabular-nums" data-cart-member-delivery>
              {deliveryBenefit.qualifies
                ? deliveryBenefit.subsidy === null
                  ? loc(
                      `التوصيل مجاني بفضل عضوية ${memberLabel}`,
                      `Delivery is free thanks to your ${memberLabel} membership`,
                      `گەیاندنی بێبەرامبەری ${memberLabel}`
                    )
                  : loc(
                      `عضوية ${memberLabel} تغطي حتى ${money(deliveryBenefit.subsidy)} من أجرة التوصيل`,
                      `Your ${memberLabel} membership covers up to ${money(deliveryBenefit.subsidy)} of the delivery fee`
                    )
                : loc(
                    `أضف ${money(deliveryBenefit.shortBy)} ليصبح التوصيل مجانيًا بعضوية ${memberLabel}`,
                    `Add ${money(deliveryBenefit.shortBy)} more for free delivery with your ${memberLabel} membership`,
                    `${money(deliveryBenefit.shortBy)} زیاد بکە بۆ گەیاندنی بێبەرامبەری ${memberLabel}`
                  )}
              {deliveryBenefit.methodNames.length > 0 &&
                ` (${deliveryBenefit.methodNames.join(loc('، ', ', '))})`}
            </p>
          )}

          {/* §4: the cash-on-delivery tax is still calculated on every order
              and then waived, so this says what happens rather than promising
              there is no tax. No Sorani equivalent exists for the waiver, so
              it reads in Arabic there rather than in invented Kurdish. */}
          {activeMembership?.cod_tax_exempt && memberLabel && (
            <p className="-mt-1 text-[12px] leading-relaxed text-gold/90" data-cart-member-cod>
              {loc('تم إعفاؤك من ضريبة الدفع عند الاستلام', 'You are exempt from the cash-on-delivery tax')}
            </p>
          )}

          {/* A signed-in customer with no membership on this cart: ONE line
              and a link, in the quiet colour the rest of the summary's notes
              use. It names no percentage, no threshold and no amount — the
              subscription page states those, from these very rules. */}
          {!activeMembership && (
            <p className="-mt-1 text-[12px] leading-relaxed text-text-muted" data-cart-member-teaser>
              {loc(
                `عضوية ${PRO_LABEL} توفّر على مشترياتك.`,
                `A ${PRO_LABEL} membership saves on what you buy.`
              )}{' '}
              <Link
                to="/subscription"
                className="rounded text-gold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                {loc('اشترك الآن', 'Subscribe', 'بەشداربە')}
              </Link>
            </p>
          )}

          <div className="h-[1px] w-full bg-zinc-800/50 my-1"></div>

          <div className="flex justify-between items-center">
            <span className="text-white font-bold text-[15px]">{loc('المجموع الكلي', 'Total', 'کۆی گشتی')}</span>
            <span className="text-white font-bold text-[17px]">{money(total)}</span>
          </div>
        </div>
        </>
        )}
      </div>

      {/*
        THE SUMMARY BAR — the one element on this page that must never move.

        THREE THINGS WERE WRONG WITH IT.

        1. It was OVER-CONSTRAINED: `left-2 right-2 md:left-1/2
           md:-translate-x-1/2 md:w-full md:max-w-md`. `right-2` carried no
           breakpoint prefix, so at md+ the element specified left, right AND
           width at once. CSS resolves that by dropping one edge — `right` in
           LTR, `left` in RTL — so the bar was centred in English and roughly
           184px off centre in Arabic, the store's primary language. It is
           centred here by `inset-x-0` plus `mx-auto`, which is symmetric and
           therefore identical in both scripts, and uses no transform.

        2. It SAT INSIDE THE NAV. At `bottom-[80px] z-40` it floated within the
           bottom nav's black gradient scrim (`z-[120]`, and the scrim overhangs
           the pills by 28px), so its lower edge faded to black — and on any
           device with a safe-area inset the pills covered part of it outright.
           `--nav-stack` (index.css) is now the one number for how much of the
           bottom edge the nav owns, and this clears it.

        3. It CHANGED HEIGHT while being used, because the savings line mounted
           and unmounted as items were ticked. Fixed row height below.
      */}
      {!loading && items.length > 0 && (
        <div
          data-testid="cart-summary-bar"
          className="fixed inset-x-3 bottom-[var(--nav-stack)] z-[130] rounded-xl border border-border-subtle bg-surface-raised/98 px-3 py-3 shadow-2xl sm:px-4 md:inset-x-0 md:mx-auto md:w-auto md:max-w-md"
        >
          {/* A FIXED ROW HEIGHT. The savings line used to mount and unmount as
              items were ticked, so the bar grew and shrank while being used. */}
          <div className="grid w-full min-h-[48px] grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 sm:flex sm:justify-between sm:gap-3">
            <button
              type="button"
              role="checkbox"
              aria-checked={allSelected}
              onClick={toggleSelectAll}
              className="flex items-center gap-2 shrink-0 min-h-[44px] -ms-1 ps-1 pe-1 rounded-lg [touch-action:manipulation]"
            >
              <span
                aria-hidden="true"
                className={`w-[22px] h-[22px] rounded-md border flex items-center justify-center transition-colors ${
                  allSelected ? 'bg-surface-selected border-white/30' : 'border-zinc-600'
                }`}
              >
                {allSelected && <Check className="w-3.5 h-3.5 text-gold" strokeWidth={3} />}
              </span>
              <span className="text-zinc-300 text-[14px] whitespace-nowrap">
                {loc('الكل', 'All', 'هەموو')}
              </span>
            </button>

            <div className="flex flex-col items-end flex-1 min-w-0 pe-1">
              <span className="text-white font-bold text-[17px] tabular-nums truncate w-full text-end">
                {money(total)}
              </span>
              {/* Always present, only sometimes visible — the row cannot
                  change the bar's height by appearing. */}
              <span
                className={`text-[11px] tabular-nums whitespace-nowrap ${
                  savedTotal > 0 ? 'text-gold/80' : 'invisible'
                }`}
              >
                {loc('وفّرت', 'Saved', 'پاشەکەوتت کرد')} {money(savedTotal)}
              </span>
            </div>

            <button
              data-testid="cart-checkout"
              type="button"
              onClick={() =>
                navigate('/checkout', {
                  // supportRef is an ATTRIBUTION, not a price input: checkout
                  // forwards it as `supportCode`, the server resolves it and
                  // freezes it into orders.support_snapshot. Only a code the
                  // server already resolved for this buyer is carried.
                  state: { itemIds: [...selectedIds], usePoints, supportRef: activeSupportRef || undefined },
                })
              }
              className="lv-button lv-button-primary col-span-2 w-full min-h-[48px] px-5 text-[15px] tabular-nums shrink-0 whitespace-nowrap active:scale-[0.985] [touch-action:manipulation] sm:col-auto sm:w-auto"
              disabled={
                selectedCount === 0 ||
                // The server refuses an incomplete line at checkout; say so here
                // instead of letting the button fail a page later.
                items.some((i) => selectedIds.has(i.id) && i.availability?.selection && !i.availability.selection.complete) ||
                // ANY selected line the door would refuse blocks the button —
                // a `sold_out` or `ended` BUNDLE, and now also an ordinary line
                // that went out of stock, or that asks for more than is left,
                // while the cart rested. `lineBlocked` is the one place that
                // decides, so the button and the line's own red sentence can
                // never disagree about whether this cart can be bought.
                items.some((i) => selectedIds.has(i.id) && lineBlocked(i))
              }
            >
              {loc('إتمام الطلب', 'Checkout', 'تەواوکردنی داواکاری')} ({selectedCount})
            </button>
          </div>
        </div>
      )}

      {/* Warranty choices are portalled above the bottom navigation and use
          the visual viewport instead of the narrow cart row. This is the
          shared mobile-safe selector path for 320px screens and RTL labels. */}
      <Sheet
        open={!!warrantyItem}
        onClose={() => warrantySavingId === null && setWarrantyPickerId(null)}
        label={ew.title}
        dismissOnEscape={warrantySavingId === null}
        dismissOnScrim={warrantySavingId === null}
        testId="cart-warranty-sheet"
        panelClassName="w-full max-w-full sm:max-w-md max-h-[min(82dvh,42rem)] overflow-hidden"
      >
        {warrantyItem && (() => {
          const plans = warrantyItem.warranty_plans ?? [];
          const current = plans.find((w) => w.id === (warrantyItem.warranty_plan_id ?? '')) ?? null;
          const saving = warrantySavingId === warrantyItem.id;
          const radio = (checked: boolean) =>
            `lv-choice w-full min-w-0 min-h-[48px] px-3 py-2.5 flex items-center justify-between gap-3 text-start text-[13px] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${checked ? 'bg-surface-selected' : ''}`;
          return (
            <div className="flex max-h-[min(78dvh,39rem)] min-w-0 flex-col">
              <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-1">
                <div className="min-w-0">
                  <h2 className="truncate text-[15px] font-semibold text-text-primary">{ew.title}</h2>
                  <p className="truncate text-[11px] text-text-muted">{itemName(warrantyItem)}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setWarrantyPickerId(null)}
                  disabled={saving}
                  aria-label={loc('إغلاق', 'Close', 'داخستن')}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              <div
                role="radiogroup"
                aria-label={ew.title}
                aria-busy={saving || undefined}
                className="min-w-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain px-3 pb-[max(1rem,env(safe-area-inset-bottom))]"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={!current}
                  disabled={saving}
                  onClick={() => chooseWarranty(warrantyItem, '')}
                  className={radio(!current)}
                  data-cart-warranty-plan=""
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-text-primary">{ew.none}</span>
                    <span className="block truncate text-[11px] font-normal text-text-muted">{ew.noneHint}</span>
                  </span>
                  {saving && warrantyPendingPlan === '' ? <Spinner size="xs" delayMs={0} decorative /> : <Check className={`h-4 w-4 shrink-0 ${!current ? 'text-text-primary' : 'invisible'}`} aria-hidden="true" />}
                </button>
                {plans.map((w) => {
                  const checked = current?.id === w.id;
                  return (
                    <button
                      key={w.id}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      disabled={saving}
                      onClick={() => chooseWarranty(warrantyItem, w.id)}
                      className={radio(checked)}
                      data-cart-warranty-plan={w.id}
                    >
                      <span className="min-w-0 truncate tabular-nums text-text-primary">{warrantyPlanLabel(w)}</span>
                      <span className="flex shrink-0 items-center gap-2 tabular-nums text-[12px] text-text-secondary">
                        {saving && warrantyPendingPlan === w.id ? <Spinner size="xs" delayMs={0} decorative /> : `+${money(w.fee_iqd)}`}
                        <Check className={`h-4 w-4 ${checked ? 'text-text-primary' : 'invisible'}`} aria-hidden="true" />
                      </span>
                    </button>
                  );
                })}
                <p className="px-1 pt-1 text-[11px] leading-relaxed text-text-muted">
                  {ew.perLine(warrantyItem.qty)} {ew.beforeOrder}
                </p>
                {warrantyErrors[warrantyItem.id] && (
                  <p role="alert" className="px-1 text-[11.5px] text-danger">{warrantyErrors[warrantyItem.id]}</p>
                )}
                <Link
                  to="/policies/extended_warranty"
                  onClick={() => setWarrantyPickerId(null)}
                  className="inline-flex min-h-[40px] items-center gap-1.5 rounded px-1 text-[11.5px] text-gold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  data-cart-warranty-policy
                >
                  <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                  {ew.policy}
                </Link>
              </div>
            </div>
          );
        })()}
      </Sheet>

      {/* ------------------------------------------------------ variant sheet
          A SHEET, NOT A DIALOG. This is a customer reconsidering the colour
          and the option of a line that is still on the screen behind it — it
          belongs to that line, it arrives from the bottom edge the way it
          always visually did, and the natural way to put it back is to push
          it back down. `Sheet` gives it that: the panel tracks the finger 1:1
          downward, resists upward, and decides on release by PROJECTED
          momentum, so a flick closes it and a slow drag that was decelerating
          springs back.

          WHAT IT USED TO BE. A `fixed inset-0` div mounted when
          `variantModalOpen` flipped, with `animate-in slide-in-from-bottom-full`
          for the arrival and nothing at all for the departure — a keyframe
          cannot run on an element that is already unmounted, so this window
          slid in politely and then vanished. The two halves now come from the
          same spring, which is also why the arrival is interruptible: dismiss
          it halfway open and it continues from where it actually is.

          MODAL is right here rather than `parallel`: the picker holds a
          PENDING choice that only `confirmVariant` writes, so the cart behind
          it must stay put — and the old window dimmed and blurred the page
          already, so the scrim is a preservation, not an addition.

          `dismissOnScrim={false}` PRESERVES what this window did: the old
          backdrop was a plain div with no click handler, so tapping outside
          never closed it, and a migration must not silently hand a window a
          dismissal it never had — especially one that would silently discard a
          half-made choice. The X, Escape and the downward drag are the ways
          out, all of which discard the pending selection exactly as the X
          always did. There was no Escape listener here to delete; the
          primitive owns that key now and this window simply gains it. */}
      <Sheet
        open={variantModalOpen && !!variantView}
        onClose={() => setVariantModalOpen(false)}
        label={loc('اختر الخيارات', 'Choose options', 'هەڵبژاردنەکان دیاری بکە')}
        z={60}
        dismissOnScrim={false}
        testId="cart-variant-sheet"
        // Geometry only — the material, the border and the rounding are the
        // primitive's. The height cap is new and deliberate: a product with
        // many colours AND many options used to grow past the top of the
        // viewport with nowhere to scroll, because the panel was pinned to the
        // bottom edge.
        panelClassName="w-full sm:max-w-md max-h-[85dvh] overflow-y-auto"
      >
        {variantView && (
          <div className="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] flex flex-col gap-4">
            <div className="flex items-start justify-between">
              <div className="flex gap-4">
                {variantView.image ? (
                  <img referrerPolicy="no-referrer" src={variantView.image} alt="" className="w-20 h-20 rounded-lg object-cover bg-white" />
                ) : (
                  <div className="w-20 h-20 rounded-lg bg-zinc-800" />
                )}
                <div>
                  <p className="text-white font-bold text-lg tabular-nums">{money(variantView.unit_price_iqd)}</p>
                  {variantView.stock !== null && (
                    <p className="text-sm text-zinc-400">{loc('المخزون', 'Stock', 'کۆگا')}: {variantView.stock}</p>
                  )}
                </div>
              </div>
              <button type="button" onClick={() => setVariantModalOpen(false)} className="p-2 bg-zinc-800 rounded-full hover:bg-zinc-700 text-zinc-300">
                <X className="w-5 h-5" />
              </button>
            </div>

            {(variantView.colors ?? []).length > 0 && (
              <div>
                <p className="text-white font-bold mb-2">{loc('اللون', 'Color', 'ڕەنگ')}</p>
                <div className="flex gap-2 flex-wrap">
                  {(variantView.colors ?? []).map((c) => {
                    // §7: colour and option names are English only.
                    const cName = c.name || c.id;
                    const active = pendingColorId === c.id;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => setPendingColorId(active ? '' : c.id)}
                        aria-pressed={active}
                        className="lv-choice flex items-center gap-2 px-4 py-2 text-sm"
                      >
                        <span
                          className="w-3.5 h-3.5 rounded-full border border-zinc-600 inline-block"
                          style={c.gradient ? { background: c.gradient } : { backgroundColor: c.hex || '#333' }}
                        ></span>
                        <span>{cName}</span>
                        <span className="lv-choice-mark"><Check aria-hidden="true" className="h-3 w-3" /></span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {(variantView.options ?? []).length > 0 && (
              <div>
                <p className="text-white font-bold mb-2">{loc('الخيارات', 'Options', 'هەڵبژاردنەکان')}</p>
                <div className="flex gap-2 flex-wrap">
                  {(variantView.options ?? []).map((o) => {
                    const oName = o.name || o.id;
                    const active = pendingOptionId === o.id;
                    return (
                      <button
                        key={o.id}
                        type="button"
                        onClick={() => setPendingOptionId(active ? '' : o.id)}
                        aria-pressed={active}
                        className="lv-choice flex items-center gap-2 px-4 py-2 text-sm"
                      >
                        <span>{oName}{typeof o.price_iqd === 'number' && o.price_iqd > 0 ? ` — ${money(o.price_iqd)}` : ''}</span>
                        <span className="lv-choice-mark"><Check aria-hidden="true" className="h-3 w-3" /></span>
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
              type="button"
              onClick={confirmVariant}
              disabled={variantSaving}
              className="lv-button lv-button-primary mt-4 w-full min-h-[48px]"
            >
              {variantSaving && <Spinner size="xs" delayMs={0} decorative />}
              {variantSaving ? loc('جارٍ الحفظ…', 'Saving…', 'پاشەکەوت دەکرێت…') : loc('تأكيد', 'Confirm', 'دڵنیاکردنەوە')}
            </button>
          </div>
        )}
      </Sheet>

      {/* ----------------------------------------------------- shipping sheet
          ALSO A GENUINE SHEET, and more obviously one than the variant picker:
          every row here commits immediately (`chooseShipping` patches the line
          and closes), so this is a short list of choices for a line the
          customer is looking at, not a task with its own state. It came from
          the bottom edge before and it still does — now with an exit down the
          same path, and with the drag that a bottom-edge window implies.

          MODAL for the same reason as above: the old window dimmed the page,
          and the write it starts belongs to a specific line that must not
          scroll away underneath it.

          `dismissOnScrim={false}` again preserves the old backdrop, which had
          no click handler. Escape and the X close it; neither cancels a patch
          that is already in flight, exactly as before — `chooseShipping`
          guards on `shippingSaving` and closes the window itself on success.

          `labelledBy` rather than `label`: the sheet's title is already on
          screen, so the screen reader should name the window with the same
          words everyone else reads instead of a second, invented string. */}
      <Sheet
        open={shippingModalOpen && !!shippingView}
        onClose={() => setShippingModalOpen(false)}
        labelledBy="cart-shipping-sheet-title"
        z={60}
        dismissOnScrim={false}
        testId="cart-shipping-sheet"
        panelClassName="w-full sm:max-w-md max-h-[85dvh] overflow-y-auto"
      >
        {shippingView && (
          <div className="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] flex flex-col gap-4">
            <div className="flex items-start justify-between">
              <div>
                <h3 id="cart-shipping-sheet-title" className="text-white font-bold text-[17px]">{loc('طريقة الشحن', 'Shipping Method', 'شێوازی گەیاندن')}</h3>
                <p className="text-zinc-400 text-sm mt-1">{loc('اختر طريقة الشحن المفضلة لهذا المنتج', 'Choose your preferred shipping method for this item', 'شێوازی گەیاندنی دڵخوازت بۆ ئەم بەرهەمە دیاری بکە')}</p>
              </div>
              <button type="button" onClick={() => setShippingModalOpen(false)} className="p-2 bg-zinc-800 rounded-full hover:bg-zinc-700 text-zinc-300">
                <X className="w-5 h-5" />
              </button>
            </div>

            {shippingError && (
              <p className="text-red-400 text-sm">{shippingError}</p>
            )}

            <div className="flex flex-col gap-3 mt-2">
              {(shippingView.shipping_methods ?? []).map((sm) => {
                const globalMethod = cartShippingMethods.find((m) => m.id === sm.id);
                const title = globalMethod
                  ? (dir === 'rtl' ? globalMethod.titleAr : globalMethod.titleEn)
                  : sm.method || sm.id;
                const desc = globalMethod
                  ? (dir === 'rtl' ? globalMethod.descAr : globalMethod.descEn)
                  : sm.delivery_time || '';
                const active = shippingView.shipping_method_id === sm.id;
                return (
                  <button
                    key={sm.id}
                    type="button"
                    // The LIVE line, not the one being rendered: the panel
                    // stays on screen for the length of its exit, and a tap
                    // that lands there must not patch a row the cart has
                    // already retired.
                    onClick={() => shippingItem && chooseShipping(shippingItem, sm.id)}
                    disabled={shippingSaving}
                    aria-pressed={active}
                    className="lv-choice flex w-full items-start justify-between gap-3 p-4 text-start disabled:opacity-60"
                  >
                    <div className="flex-1">
                      <p className="font-bold text-[15px] text-text-primary">
                        {title}
                      </p>
                      {desc && (
                        <p className="text-zinc-500 text-xs mt-1">{desc}</p>
                      )}
                      {typeof sm.price_iqd === 'number' && sm.price_iqd > 0 && (
                        <p className="text-[13px] mt-1.5 font-bold text-text-secondary">
                          {money(sm.price_iqd)}
                        </p>
                      )}
                    </div>
                    <span className="lv-choice-mark mt-0.5"><Check aria-hidden="true" className="h-3 w-3" /></span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </Sheet>
    </div>
  );
}
