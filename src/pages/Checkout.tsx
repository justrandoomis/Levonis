import { MotionCharacterAnchor, MotionCharacterHome, useCharacterBusy } from '../components/bloub/MotionCharacterAnchor';
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
// The standalone `loc` — this helper runs outside the component, and the
// module-level translator is exactly what LanguageContext documents it for.
import { loc, useLanguage } from '../LanguageContext';
import {
  ArrowLeft, ArrowRight, Truck, Store,
  CreditCard, Wallet, Banknote,
  Check, Sparkles, MapPin, AlertCircle,
  Lock, CheckCircle2, Plus, Receipt, ShoppingCart, CalendarClock, Tag
} from 'lucide-react';
import { useWallet } from '../WalletContext';
import { api, ApiAddress, ApiError, ApiOrder, CartItem, newIdempotencyKey, usdCentsToIqd, formatIqd } from '../lib/api';
import type { DeliveryDayOption } from '../lib/api';
import DeliveryDayPicker from '../components/orders/DeliveryDayPicker';
/**
 * THE SAME THREE PURE FUNCTIONS THE SERVER USES, not a second implementation
 * of them — see `offeredCheckoutDays` below for why this one screen computes a
 * day at all. Both modules are leaves with no imports beyond each other, so
 * nothing of the Worker runtime enters the bundle; the precedent is
 * `src/lib/policyReader.ts`, which imports the search fold for the same
 * reason — one table cannot drift from a copy that does not exist.
 */
import { baghdadDay } from '../../worker/lib/baghdadTime';
import { dayLabel, deliveryWindow, resolveDeliveryDayPolicy } from '../../worker/lib/deliveryDay';
import { useFreshOnReturn, changedPrices } from '../lib/useFreshOnReturn';
import PromoCodeField, { readStoredPromo, storePromo } from '../components/PromoCodeField';
import Note from '../components/ui/Note';
import SummaryInfo from '../components/ui/SummaryInfo';
/**
 * THE TAX RATE THE «!» QUOTES IS THE RATE THE SERVER CHARGES.
 *
 * The delivery-company tax is explained to the customer in two numbers, and
 * those two numbers have to be the ones the server divides by. Typing «3,000
 * لكل 500,000» into a sentence here would make this screen a second, silent
 * copy of a rate nobody would remember to change.
 *
 * THE RATE IS THE ADMINISTRATOR'S NOW, so the constants are no longer the
 * answer — they are the FALLBACK, for a client talking to a server older than
 * the setting. The live pair comes from `/api/settings/public`, which is also
 * where the printer note and the exchange rate come from. The module stays
 * imported for that fallback and for nothing else; it is a pure leaf with no
 * imports at all, so nothing of the Worker runtime enters the bundle.
 */
import { COD_TAX_BLOCK_IQD, COD_TAX_PER_BLOCK_IQD } from '../../packages/shipping/src/codTax';
import BundleContents, { type BundleContentLine } from '../components/bundles/BundleContents';
import AddressForm from '../components/address/AddressForm';
/**
 * THE ORDER IS PLACED; THIS IS ABOUT WHAT HAPPENS NEXT.
 *
 * An order produces a stream of later messages — confirmed, in production, out
 * for delivery — and for an account with no outbound channel every one of them
 * lands only in the in-app inbox, a page the customer has to remember to open.
 * The window is rendered on the SUCCESS screen alone and is non-blocking; it
 * asks nothing before the payment and interrupts nothing after it.
 */
import ChannelNudge from '../components/notify/ChannelNudge';
import { apiRefusal } from '../lib/refusalStrings';
import { mascot } from '../lib/mascot';
/**
 * The tier's CUSTOMER-FACING NAME. `prime` is PREMIUM on every screen in the
 * store, and `tierMeta` is the one table that says so — nothing here branches
 * on a tier id or spells a label out.
 */
import { isPaidTier, tierLabel } from '../components/subscription/tierMeta';
import { useMoney } from '../CurrencyContext';

/**
 * The refusal codes validateCoupon can produce. A quote that fails with one
 * of these failed BECAUSE OF THE CODE, so the code is dropped and the quote
 * retried; anything else is a real quote failure and must be shown as one.
 * Kept as a literal rather than "any 4xx": swallowing an unrelated error as
 * "bad coupon" would hide a genuine problem behind a wrong explanation.
 */
const COUPON_FAILURES = new Set([
  'CODE_REQUIRED', 'CODE_NOT_FOUND', 'INACTIVE', 'NOT_STARTED', 'EXPIRED',
  'MIN_TOTAL_NOT_MET', 'TIER_REQUIRED', 'GLOBAL_LIMIT_REACHED',
  'PER_USER_LIMIT_REACHED', 'NO_DISCOUNT', 'COUPON_INVALID',
]);

// ---------------------------------------------------------------- server quote

interface ShippingQuoteDto {
  components: Array<{
    kind: string;
    fee_iqd: number;
    waived: boolean;
    units: number;
    advance_required: boolean;
    product_id?: string;
    product_name?: string;
    delivery_method?: 'standard' | 'personal';
    quantity_step?: number;
  }>;
  total_iqd: number;
  total_before_waiver_iqd: number;
  advance_due_iqd: number;
  pro_waiver_applied: boolean;
  prime_waiver_applied: boolean;
  waiver_source: 'none' | 'pro' | 'prime' | 'promotion';
  waiver_basis_iqd: number;
  needs_config: string[];
  assumptions: string[];
  reasons: string[];
}

/** One priced line of the quote — the number the order will actually charge. */
interface CheckoutQuoteLineDto {
  cart_item_id: string;
  product_id: string;
  name: string;
  name_ar: string;
  image?: string;
  variant: string;
  qty: number;
  unit_price_iqd: number;
  line_total_iqd: number;
  is_printer: boolean;
  /**
   * A BUNDLE'S PARTS, NESTED UNDER THE PRICED LINE (docs/BUNDLES_MYSTERY.md
   * §6.3). They are never quote lines of their own: this screen maps
   * `quote.lines` 1:1 with `key={l.cart_item_id}`, so a four-component bundle
   * arriving as five lines would render four extra 0 IQD rows naming the member
   * products under four duplicate React keys, on the last screen before
   * payment. `is_printer` is carried up onto the parent by the server so the
   * printer delivery note below still fires for a printer inside a bundle.
   */
  included?: Array<{ product_id: string | null; name: string; name_ar: string; image?: string; variant: string; qty: number; value_iqd: number }>;
  /** The disclosure's struck total and saving badge, on THIS line's basis —
   *  so the review screen never mixes a cart-basis figure with a quote-basis
   *  one on a pre-order bundle the quote re-priced. */
  component_total_iqd?: number | null;
  saving_percent?: number | null;
  /** A MYSTERY line says how many spools and nothing else (§8.2 row 20). */
  mystery?: { revealed: boolean; spools: number } | null;
  breakdown?: {
    applied_iqd: number;
    unit_subtotal_iqd: number;
    direct?: { surcharge_iqd: number; waived: boolean } | null;
    transport?: { method: string; commission_iqd: number; waived: boolean; waived_by?: string } | null;
    pricing_basis?: 'direct' | 'preorder';
  };
}

/**
 * WHAT THE MEMBERSHIP IS WORTH ON THIS ORDER (docs/MEMBERSHIP_BENEFITS.md §11).
 *
 * Every figure here is the server's. Nothing on this screen knows a
 * percentage, a threshold, a ceiling or a tier's entitlements — the rules live
 * in `membership_benefit_rules` and the resolver answers with the money.
 *
 * THE TWO DISCOUNT FIGURES ARE NOT INTERCHANGEABLE (§2).
 * `unit_discount_iqd` is already inside the line prices — and therefore inside
 * `subtotal_iqd`. `order_discount_iqd` is the part deducted AFTER the
 * subtotal, the way a coupon is. `discount_total_iqd` is their sum: the whole
 * saving, which is what the customer is told they saved, and which the running
 * column must never subtract — doing so would take the unit part off twice.
 */
interface MembershipBenefitsDto {
  tier: string;
  active: boolean;
  /** The whole saving on merchandise — the headline, never a summary row. */
  discount_total_iqd: number;
  /** The part already inside the line prices above. */
  unit_discount_iqd: number;
  /** The part deducted after the subtotal — the only part a row may subtract. */
  order_discount_iqd: number;
  lines: Array<{
    product_id: string;
    rule_id: string | null;
    scope: string | null;
    per_unit_iqd: number;
    eligible_qty: number;
    total_iqd: number;
    capped_by: 'none' | 'per_unit' | 'per_order' | 'quantity';
    applied_at: 'unit' | 'line';
  }>;
  shipping: {
    rule_id: string | null;
    eligible: boolean;
    reason: 'applied' | 'no_rule' | 'below_threshold' | 'method_not_covered';
    threshold_iqd: number | null;
    basis_iqd: number;
    methods: string[] | null;
    max_subsidy_iqd: number | null;
    /** The delivery fee as quoted, before the membership touched it. */
    fee_before_benefit_iqd: number;
    /** What the customer actually pays for delivery. */
    fee_paid_iqd: number;
    /** What the membership covered of it. */
    subsidy_iqd: number;
    /** A ceiling bit: the member pays the rest, and nothing is "free" (§3). */
    subsidy_capped: boolean;
  };
  cod_tax: {
    rule_id: string | null;
    exempt: boolean;
    before_exemption_iqd: number;
    exemption_iqd: number;
    charged_iqd: number;
  };
}

interface CheckoutQuoteDto {
  /**
   * THE PRICE AUTHORITY once it exists. The cart prices a pre-order line as
   * prepaid; these lines are priced for the payment method actually chosen
   * (cash on delivery prices a pre-order like a direct sale), so the summary
   * renders them — not the cart's numbers — the moment a quote is loaded.
   */
  lines: CheckoutQuoteLineDto[];
  merchandise_iqd: number;
  subtotal_iqd: number;
  /** §1: the journey this cart is on — unchanged by how it is paid. */
  shipping_type?: 'direct' | 'preorder_air' | 'preorder_sea' | 'preorder_land' | string;
  /** The payment ids the server allows for this cart; the screen offers exactly these. */
  allowed_payment_methods?: string[];
  bnpl?: {
    eligible: boolean;
    available_iqd?: number;
    outstanding_iqd?: number;
    financed_iqd?: number;
    due_at?: string | null;
  };
  priority_delivery?: { eligible: boolean; max_hours: 12; due_at: string | null; reason: string | null };
  /** 'direct' = priced by the direct-sale rule (a direct cart, or a pre-order
   *  paid cash on delivery); 'preorder' = the transport commission applies. */
  pricing_basis?: 'direct' | 'preorder';
  /** Cash on delivery changes a line's price on this cart (a pre-order line
   *  with a direct premium this customer pays). False → nothing to explain. */
  cod_reprices?: boolean;
  /** How much MORE the LINES cost paid cash at the door than prepaid from the
   *  wallet. The number the cash option prints, so «الفرق» is readable before
   *  it is chosen rather than after it is re-quoted. 0 = the two cost the same. */
  cod_surcharge_iqd?: number;
  /** A cash order the wallet settled in full was priced as the PREPAID
   *  pre-order it is — nothing is collected at the door. */
  prepaid_by_wallet?: boolean;
  /** Informational notes — never part of any total. */
  notes?: { printer_home_delivery_iqd: number | null };
  /** Every configured delivery method priced for THIS cart by the server —
   *  so a card can print a true fee before anything is selected.
   *  `fee_iqd: null` + `available: false` = the cart cannot use that method. */
  delivery_method_fees?: Array<{ id: string; fee_iqd: number | null; available: boolean }>;
  shipping: ShippingQuoteDto;
  is_pickup: boolean;
  /** The protected-delivery add-on: offered only when the owner priced it. */
  protected_delivery?: {
    available: boolean;
    selected: boolean;
    fee_iqd: number | null;
    waived: boolean;
  };
  coupon: { code?: string; discount_iqd?: number } | null;
  /** §3.3 attribution — always `discount_iqd: 0`; it is not a discount. */
  support: { referrer_username: string; ref: string; discount_iqd: number } | null;
  /**
   * The server sends all of this on every quote; the screen read two fields of
   * it and rendered one read-only line. `eligible_merchandise_iqd` is the
   * redemption CAP (points pay for merchandise, never shipping or fees), and
   * the `earn_*` fields are what this order pays back — none of which the
   * customer could see at the moment they were deciding.
   */
  points: {
    balance: number;
    applied_iqd: number;
    eligible_merchandise_iqd?: number;
    earn_eligible_iqd?: number;
    earn_pending?: number;
    iqd_per_point?: number;
    hold_days?: number;
  };
  wallet: { balance_iqd: number; applied_iqd: number; required_advance_iqd: number };
  /** Authoritative server-side COD tax, already included in total_iqd. */
  cod_tax_iqd: number;
  /**
   * §14 — THE TAX AS CALCULATED, AND AS WAIVED, AS TWO NUMBERS. The engine
   * runs on every order and the membership then exempts it; a single zero
   * would tell the customer nothing about what happened. Optional here only
   * so a worker that predates the benefit rules still renders a correct
   * screen — the fallback is the charged figure, never an invented one.
   */
  cod_tax_before_exemption_iqd?: number;
  cod_tax_exemption_iqd?: number;
  /** §11 — what the membership is worth on this order, itemised. */
  membership_benefits?: MembershipBenefitsDto;
  total_iqd: number;
  due_on_delivery_iqd: number;
  tier: { tier: string; active: boolean; at_approved_default_address: boolean; pro_benefits_context: boolean };
  policies: Array<{ key: string; version: number }>;
  blockers: string[];
  can_checkout: boolean;
}

// Local trilingual strings for the new quote/consent UI (page-scoped — the
// global dictionary is owned elsewhere).
const STRINGS = {
  ar: {
    quoteLoading: 'جارٍ حساب التوصيل...',
    quoteError: 'تعذّر حساب عرض السعر — سيُعاد التحقق عند تأكيد الطلب.',
    needsConfig: 'رسوم توصيل جزء من هذا الطلب (طابعة/كرتونة إضافية) لم تُهيَّأ من الإدارة بعد، لذلك لا يمكن إتمام الطلب حالياً. لا نختلق رسوماً.',
    // The day was refused at the door; the order itself is untouched and one
    // press away, so the sentence says what happens if they press again.
    dayRefused: 'لم يعد يوم التوصيل الذي اخترته متاحًا، فأُلغي الاختيار. اضغط «إتمام الطلب» مرة أخرى ليصلك في أقرب وقت، أو اختر يومًا آخر.',
    advanceDue: (v: string) => `رسوم توصيل الطابعة (${v}) تُدفع مقدماً من المحفظة.`,
    freeShipping: 'مجاناً',
    codTax: 'ضريبة شركة التوصيل',
    whyTitle: 'تفاصيل التوصيل',
    policyTitle: 'الموافقة على السياسات',
    policyAgree: 'قرأتُ وأوافق على:',
    policyRequired: 'الموافقة على السياسات المنشورة مطلوبة لإتمام الطلب.',
    blockEmpty: 'سلتك فارغة.',
    blockAddress: 'اختر عنوان التوصيل أولاً.',
    blockDelivery: 'اختر طريقة التوصيل.',
    blockPayment: 'اختر طريقة الدفع.',
    blockAdvance: 'الرصيد غير كافٍ للدفعة المقدمة المطلوبة — اشحن محفظتك أو اختر الاستلام من المخزن.',
    blockQuote: 'تعذّر تسعير هذا الطلب الآن. راجع التنبيه أعلاه — قد يكون أحد المنتجات غير متوفر.',
    blockedLabel: 'لا يمكن إتمام الطلب:',
    policyReset: 'تغيّر ملخص الطلب — يرجى تأكيد الموافقة مجدداً.',
    policyNames: { terms: 'شروط الاستخدام والبيع', privacy: 'سياسة الخصوصية' } as Record<string, string>,
    version: 'نسخة',
    invoiceNo: 'رقم الفاتورة',
    implicitNote: 'لا توجد سياسات منشورة تتطلب الموافقة حالياً.',
    supportLine: (name: string) => `كود دعم: ${name}`,
    supportZero: 'لا يغيّر سعر طلبك (0 د.ع)',
    protectedTitle: 'توصيل محمي',
    protectedDesc: 'تغليف وحماية إضافية للطرد أثناء النقل.',
    protectedFree: 'مجاني مع اشتراكك',
    paymentHint: {
      wallet: 'الدفع مقدمًا بالكامل من محفظتك',
      cash: 'تدفع المبلغ نقدًا عند الاستلام',
      bnpl: 'حصري لـ PRO المؤهل — يُسجّل المبلغ والموعد في حسابك',
    } as Record<string, string>,
    payCheapest: 'الأرخص',
    payCodMore: (v: string) => `+${v} د.ع عند الدفع عند الاستلام`,
    codDirectPricing: 'اختيار الدفع عند الاستلام يُسعَّر كبيع مباشر؛ يبقى طلبك طلبًا مسبقًا بمراحله ووسيلة نقله كما هي.',
    prepaidPreorder: 'الدفع مقدمًا يُبقي تسعير الطلب المسبق كما هو مُعدّ.',
    prepaidByWallet: 'مدفوع بالكامل من محفظتك — يُطبَّق تسعير الطلب المسبق.',
    printerNote: (v: string) => `عند طلب توصيل الطابعة إلى المنزل يُدفع ${v} مقدماً من المحفظة.`,
    printerAdvanceShort: (need: string, have: string) => `رصيد محفظتك ${have} ولا يغطي الدفعة المقدمة ${need}. اشحن المحفظة أو اختر الاستلام من المتجر.`,
  },
  en: {
    quoteLoading: 'Calculating delivery...',
    quoteError: 'The price quote could not be calculated — it will be re-checked when you place the order.',
    needsConfig: 'Delivery fees for part of this order (printer / extra carton) are not configured by the store yet, so the order cannot be completed right now. We never invent a fee.',
    dayRefused: 'The delivery day you chose is no longer available, so the choice was cleared. Press Place order again to have it as soon as possible, or pick another day.',
    advanceDue: (v: string) => `Printer delivery fees (${v}) are paid in advance from your wallet.`,
    freeShipping: 'Free',
    codTax: 'Delivery company tax',
    whyTitle: 'Delivery details',
    policyTitle: 'Policy consent',
    policyAgree: 'I have read and agree to:',
    policyRequired: 'Accepting the published policies is required to place the order.',
    blockEmpty: 'Your cart is empty.',
    blockAddress: 'Choose a delivery address first.',
    blockDelivery: 'Choose a delivery method.',
    blockPayment: 'Choose a payment method.',
    blockAdvance: 'Your balance does not cover the required advance — top up your wallet or choose store pickup.',
    blockQuote: 'This order could not be priced right now. See the notice above — an item may be out of stock.',
    blockedLabel: 'Cannot place the order:',
    policyReset: 'The order summary changed — please confirm your agreement again.',
    policyNames: { terms: 'Terms of Use & Sale', privacy: 'Privacy Policy' } as Record<string, string>,
    version: 'v',
    invoiceNo: 'Invoice number',
    implicitNote: 'No published policies currently require acceptance.',
    supportLine: (name: string) => `Support code: ${name}`,
    supportZero: 'does not change your price (0 IQD)',
    protectedTitle: 'Protected delivery',
    protectedDesc: 'Extra packaging and handling so the parcel survives the trip.',
    protectedFree: 'Free with your membership',
    paymentHint: {
      wallet: 'Pay the full amount in advance from your wallet',
      cash: 'Pay in cash when the order is delivered',
      bnpl: 'For eligible PRO members — amount and due date are recorded on your account',
    } as Record<string, string>,
    payCheapest: 'Cheapest',
    payCodMore: (v: string) => `+${v} IQD when paid cash on delivery`,
    codDirectPricing: 'Cash on delivery is priced as a direct sale; your order stays a pre-order, on its journey and its stages.',
    prepaidPreorder: 'Paying in advance keeps the configured pre-order pricing.',
    prepaidByWallet: 'Paid in full from your wallet — pre-order pricing applies.',
    printerNote: (v: string) => `When home delivery is requested for a printer, ${v} is paid in advance from your wallet.`,
    printerAdvanceShort: (need: string, have: string) => `Your wallet holds ${have}, which does not cover the ${need} advance. Top up your wallet, or choose store pickup.`,
  },
  ckb: {
    quoteLoading: 'حسابکردنی گەیاندن...',
    quoteError: 'نرخی گەیاندن حساب نەکرا — لە کاتی تەواوکردنی داواکاری دووبارە پشکنین دەکرێت.',
    needsConfig: 'کرێی گەیاندنی بەشێک لەم داواکارییە (پرینتەر/کارتۆنی زیادە) هێشتا لەلایەن بەڕێوەبەرایەتییەوە ڕێکنەخراوە، بۆیە ئێستا داواکارییەکە تەواو ناکرێت.',
    dayRefused: 'ئەو ڕۆژەی گەیاندن کە هەڵتبژاردبوو چیتر بەردەست نییە، بۆیە هەڵبژاردنەکە سڕایەوە. دووبارە «تەواوکردنی داواکاری» دابگرە بۆ ئەوەی لە زووترین کاتدا بگات، یان ڕۆژێکی تر هەڵبژێرە.',
    advanceDue: (v: string) => `کرێی گەیاندنی پرینتەر (${v}) پێشوەخت لە جزدانەکەتەوە دەدرێت.`,
    freeShipping: 'بەخۆڕایی',
    /* The Arabic and English names were changed to say WHO takes this tax
       («ضريبة شركة التوصيل»). The Sorani below is hand-written and still names
       the same charge; it is left exactly as a Kurdish speaker wrote it rather
       than machine-renamed to match, which is the store's standing rule. */
    codTax: 'باجی پارەدان لە کاتی گەیاندن',
    whyTitle: 'وردەکاری گەیاندن',
    policyTitle: 'ڕەزامەندی لەسەر سیاسەتەکان',
    policyAgree: 'خوێندمەوە و ڕازیم بە:',
    policyRequired: 'ڕەزامەندی لەسەر سیاسەتە بڵاوکراوەکان پێویستە بۆ تەواوکردنی داواکاری.',
    blockEmpty: 'سەبەتەکەت بەتاڵە.',
    blockAddress: 'سەرەتا ناونیشانی گەیاندن هەڵبژێرە.',
    blockDelivery: 'شێوازی گەیاندن هەڵبژێرە.',
    blockPayment: 'شێوازی پارەدان هەڵبژێرە.',
    blockAdvance: 'باڵانست پارەدانی پێشەکی پێویست ناگرێتەوە — جزدانەکەت پڕ بکەرەوە یان وەرگرتن لە فرۆشگا هەڵبژێرە.',
    blockQuote: 'ئێستا نرخی ئەم داواکارییە دیاری نەکرا. سەیری ئاگاداری سەرەوە بکە — لەوانەیە بەرهەمێک بەردەست نەبێت.',
    blockedLabel: 'داواکاری تەواو ناکرێت:',
    policyReset: 'پوختەی داواکارییەکە گۆڕا — تکایە دووبارە ڕەزامەندی دەربڕە.',
    policyNames: { terms: 'مەرجەکانی بەکارهێنان و فرۆشتن', privacy: 'سیاسەتی تایبەتمەندی' } as Record<string, string>,
    version: 'وەشان',
    invoiceNo: 'ژمارەی پسوولە',
    implicitNote: 'لە ئێستادا هیچ سیاسەتێکی بڵاوکراوە پێویستی بە ڕەزامەندی نییە.',
    supportLine: (name: string) => `کۆدی پاڵپشتی: ${name}`,
    supportZero: 'نرخەکەت ناگۆڕێت (0 د.ع)',
    protectedTitle: 'گەیاندنی پارێزراو',
    protectedDesc: 'پاکەتکردن و پاراستنی زیاتر بۆ پاکەتەکە لە کاتی گواستنەوە.',
    protectedFree: 'بێبەرامبەر لەگەڵ ئەندامێتییەکەت',
    paymentHint: {
      wallet: 'تەواوی بڕەکە پێشوەخت لە جزدانەکەتەوە بدە',
      cash: 'پارەکە بە کاش لە کاتی گەیاندن بدە',
      bnpl: 'تایبەت بە ئەندامی PRO ی شیاو — بڕ و بەرواری دانەوە تۆمار دەکرێت',
    } as Record<string, string>,
    payCheapest: 'هەرزانترین',
    payCodMore: (v: string) => `+${v} د.ع لە پارەدان لە کاتی گەیاندن`,
    codDirectPricing: 'پارەدان لە کاتی گەیاندن وەک فرۆشتنی ڕاستەوخۆ نرخ دەکرێت؛ داواکارییەکەت وەک پێش-داواکاری دەمێنێتەوە بە قۆناغەکانی و شێوازی گواستنەوەی خۆی.',
    prepaidPreorder: 'پارەدانی پێشوەخت نرخی پێش-داواکاری وەک ڕێکخراوە دەهێڵێتەوە.',
    prepaidByWallet: 'بە تەواوی لە جزدانەکەتەوە دراوە — نرخی پێش-داواکاری جێبەجێ دەبێت.',
    printerNote: (v: string) => `کاتێک گەیاندنی پرینتەر بۆ ماڵەوە داوا دەکرێت، ${v} پێشوەخت لە جزدانەکەتەوە دەدرێت.`,
    printerAdvanceShort: (need: string, have: string) => `جزدانەکەت ${have} هەیە، کە ${need}ی پێشەکی ناگرێتەوە. جزدان پڕ بکەرەوە یان وەرگرتن لە فرۆشگا هەڵبژێرە.`,
  },
};

/** What the server offers when no quote has answered yet (worker/lib/paymentPolicy.ts). */
const DEFAULT_OFFERED_PAYMENT_IDS = ['wallet', 'cash'];

/**
 * 0075 — WHICH COUNTER MOVED, AT THE LAST SCREEN BEFORE PAYMENT.
 *
 * Two counters sit behind one order: the shelf a direct sale comes off, and
 * the import quota a pre-order consumes. `apiRefusal` already gives the
 * customer the server's own sentence in their language; this adds the one fact
 * that sentence cannot carry — WHICH of the two ran out — because "sold out"
 * and "this month's pre-order quota is full" have different answers.
 *
 * `loc` is the app's translator and falls back to Arabic for Kurdish: the
 * Sorani here is the owner's to write by hand and is deliberately not invented.
 */
function counterNamed(code: string): string {
  if (code === 'PREORDER_CAPACITY_EXHAUSTED') {
    return loc(
      'العدّاد: حصة الطلب المسبق لهذا الاختيار — وليس مخزون البيع المباشر.',
      'The counter: this selection’s pre-order quota — not direct-sale stock.'
    );
  }
  if (code === 'OUT_OF_STOCK' || code === 'QTY_UNAVAILABLE') {
    return loc('العدّاد: مخزون البيع المباشر لهذا الاختيار.', 'The counter: direct-sale stock for this selection.');
  }
  return '';
}

/** The refusal as the server said it, followed by the counter it names. */
function refusalWithCounter(err: unknown, lang: string, fallback: string): string {
  const said = apiRefusal(err, lang as 'ar' | 'en' | 'ckb', fallback);
  const code = err instanceof ApiError ? err.code ?? '' : '';
  const counter = counterNamed(code);
  return counter ? `${said} ${counter}` : said;
}

/**
 * THE DAYS THIS CHECKOUT MAY OFFER — the one place in the app where the
 * browser works out a calendar day, and the reason is that there is nothing
 * yet to ask.
 *
 * Everywhere else the offer arrives ready-made: `GET /api/orders/:id` answers
 * with `delivery_date.days[]`, labels included, because the order exists and
 * the server knows its frozen ceiling. Before the order exists there is no row
 * to read a ceiling off, which is exactly why `deliveryDayPolicy` is on
 * `PUBLIC_SETTING_KEYS` — its comment there names this screen.
 *
 * WHAT IS AND IS NOT RISKED BY COMPUTING IT HERE. The bug the house rule
 * guards against is TIMEZONE-DEPENDENT parsing and formatting:
 * `new Date('2026-09-23')` is UTC midnight and renders as the twenty-second
 * west of Baghdad, and `toLocaleDateString` answers in the device's calendar.
 * Neither happens below. `baghdadDay` takes epoch milliseconds — a value with
 * no timezone in it — and adds Iraq's fixed +3, so a correct phone in New York
 * and a correct phone in Basra produce the same string. The only remaining
 * input is whether the DEVICE CLOCK is right to within a day, and the server
 * re-checks the chosen day against its own clock at the door
 * (`refuseUnlessOffered`), so a wrong clock produces a loud refusal we handle,
 * never a promise we cannot keep.
 *
 * The window is anchored on TODAY on both sides, which is what
 * `checkoutDeliveryDay` does with `baghdadDayOf(created_at)` a moment later:
 * an order is anchored on the day it is placed, so the offer here and the
 * ceiling frozen on the row are the same seven days.
 */
function offeredCheckoutDays(
  policy: { enabled: boolean; max_days: number; allow_same_day: boolean } | undefined,
  todayDay: string,
  lang: string
): DeliveryDayOption[] {
  const resolved = resolveDeliveryDayPolicy(policy);
  if (!resolved.enabled || !todayDay) return [];
  const window = deliveryWindow({ anchorDay: todayDay, todayDay, policy: resolved });
  return window.days.map((day) => ({ day, ...dayLabel(day, todayDay, lang) }));
}

export default function Checkout() {
  const { money, moneyBoth } = useMoney();
  const navigate = useNavigate();
  const location = useLocation();
  const { lang, dir, loc } = useLanguage();
  const {
    checkoutDeliveryMethods,
    checkoutPaymentMethods,
    balanceUsdCents,
    pointBalance,
    exchangeRate,
    refreshWallet,
    settings,
  } = useWallet();

  /**
   * THE RATE THE SENTENCE QUOTES — the administrator's, or the compiled
   * default when the server has not sent one.
   *
   * A positive integer or nothing: a zero block would make the explanation
   * «عن كل 0» and a negative one is not a rate. The server normalises the
   * same way before it charges, so the two cannot disagree about a value
   * either of them would refuse.
   */
  const settingRate = (value: unknown, fallback: number): number => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
  };
  const codTaxPerBlockIqd = settingRate(settings?.codTaxPerBlockIqd, COD_TAX_PER_BLOCK_IQD);
  const codTaxBlockIqd = settingRate(settings?.codTaxBlockIqd, COD_TAX_BLOCK_IQD);

  // Selected cart line ids and points choice arrive from the Cart page via
  // router state; with no state we fall back to the whole cart.
  const routeState = (location.state ?? {}) as { itemIds?: string[]; usePoints?: boolean; supportRef?: string };
  const requestedItemIds = Array.isArray(routeState.itemIds) ? routeState.itemIds : null;
  /**
   * POINTS ARE A DECISION, AND THIS IS WHERE IT IS MADE.
   *
   * This was a constant read once from router state and never settable: the
   * only control lived behind a collapsed accordion in the cart, a screen back.
   * Its sibling discount — the promo code — has always been on this page. The
   * customer could see a "Points Discount" line with no way to turn it off, no
   * way to turn it on if they arrived without it, and no sight of their balance
   * or of what this order would earn them.
   */
  const [usePoints, setUsePoints] = useState(routeState.usePoints === true);
  // §3.3 — the support code the cart resolved and the buyer kept. It is an
  // ATTRIBUTION, never a price input: it rides along to the quote and to the
  // order, the server re-resolves it and freezes it into
  // orders.support_snapshot, and it is worth exactly 0 IQD here. Nothing on
  // this page subtracts anything for it.
  const supportRef = typeof routeState.supportRef === 'string' ? routeState.supportRef.trim().slice(0, 60) : '';

  const [items, setItems] = useState<CartItem[]>([]);
  const [addresses, setAddresses] = useState<ApiAddress[]>([]);
  const [loading, setLoading] = useState(true);
  useCharacterBusy(loading);
  const [loadError, setLoadError] = useState('');

  const [placedOrder, setPlacedOrder] = useState<ApiOrder | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // True once a line's price moved while this screen was open, so the customer
  // is told rather than left to spot the total changing on its own.
  const [pricesMoved, setPricesMoved] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const [selectedAddressId, setSelectedAddressId] = useState('');
  const [deliveryMethod, setDeliveryMethod] = useState('');
  /**
   * THE DAY, AND IT IS OPTIONAL. `null` means «في أقرب وقت» and is where every
   * checkout starts, because that is what the great majority of orders want —
   * forcing a choice would add a sixth required step to a checkout that
   * already has five, to collect an answer the customer did not need to give.
   * It is sent as `requestedDeliveryDate` and the server freezes it onto the
   * row; it changes no price, which is why it is deliberately nowhere near the
   * quote.
   */
  const [requestedDay, setRequestedDay] = useState<string | null>(null);
  const [paymentMethod, setPaymentMethod] = useState('');
  /**
   * THE «استخدام كود خاص» DISCLOSURE. Closed by default — most orders carry no
   * code, and an empty input in the middle of a price column is a question
   * nobody asked. `promoOpen` below forces it open when the order already has
   * a code on it, so a customer who wants to REMOVE one is never hunting for
   * a field that collapsed itself.
   */
  const [showPromoField, setShowPromoField] = useState(false);
  const [useWalletBalance, setUseWalletBalance] = useState(false);

  // Server-authoritative quote (POST /api/orders/quote): re-fetched whenever
  // the address, cart lines, delivery/payment method or points choice change.
  // The promo code the SERVER has accepted for this quote — set only after a
  // quote came back priced with it, never straight from the input. A code
  // carried over from the cart still has to survive that check here.
  const [couponCode, setCouponCode] = useState<string>(() => readStoredPromo());
  const [couponError, setCouponError] = useState('');
  const [quote, setQuote] = useState<CheckoutQuoteDto | null>(null);
  /** The protected-delivery add-on. The SERVER prices and charges it; this is
   *  only the customer's answer to "do you want it?", sent with every quote. */
  const [protectedDelivery, setProtectedDelivery] = useState(false);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState('');
  // Versioned-policy consent: ALWAYS starts unchecked; any material quote
  // change (totals / shipping / required versions) resets it.
  const [policyAccepted, setPolicyAccepted] = useState(false);
  useEffect(() => { setPolicyAccepted(false); }, [lang]);
  const [consentResetNote, setConsentResetNote] = useState(false);
  const quoteSignatureRef = useRef('');
  const quoteSeqRef = useRef(0);
  /**
   * Whether the BUYER chose the payment method, as opposed to this screen
   * resting on a default. The wallet-first rule below moves the selection
   * exactly once, and never over an answer the buyer has already given.
   */
  const paymentPickedRef = useRef(false);
  const [placedInvoiceNo, setPlacedInvoiceNo] = useState<string | null>(null);

  const S = STRINGS[lang as keyof typeof STRINGS] ?? STRINGS.ar;

  // One stable idempotency key per checkout visit: retries after a network
  // failure can never create a duplicate order.
  const idempotencyKeyRef = useRef(newIdempotencyKey());

  const handleBack = () => navigate(-1);

  /**
   * ADDING AN ADDRESS NO LONGER EJECTS THE CUSTOMER FROM CHECKOUT.
   *
   * The button used to `navigate('/addresses')` — a bare push, no state, no
   * `next`. That unmounted this whole screen, so the delivery method, the
   * payment method, the coupon, the protected-delivery tick, the wallet toggle
   * and the policy acceptance were all discarded; and on return the mount
   * effect re-selected the OLD default, so the address they had just gone away
   * to create was not even the one being shipped to. The form is rendered here
   * instead, and its `onSaved` selects the new address — the pattern the
   * merchant checkout already used one file over.
   */
  const [addingAddress, setAddingAddress] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [cartData, addressData] = await Promise.all([
          api.get<{ items: CartItem[] }>('/api/cart'),
          api.get<{ addresses: ApiAddress[] }>('/api/addresses'),
        ]);
        if (cancelled) return;
        const all = cartData.items || [];
        const filtered =
          requestedItemIds && requestedItemIds.length > 0
            ? all.filter((i) => requestedItemIds.includes(i.id))
            : all;
        setItems(filtered);
        const addrs = addressData.addresses || [];
        setAddresses(addrs);
        const preferred = addrs.find((a) => a.is_default) ?? addrs[0];
        if (preferred) setSelectedAddressId(preferred.id);
      } catch (err) {
        if (!cancelled) setLoadError(apiRefusal(err, lang as 'ar' | 'en' | 'ckb', 'Failed to load checkout'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * COMING BACK TO CHECKOUT RE-READS THE LINES.
   *
   * This screen matters more than the cart: the order is priced on the server
   * at the moment it is placed, so a stale total here would show one number
   * and charge another. Only the LINES are re-read — the address, delivery and
   * payment choices the customer has already made are theirs and are never
   * touched, and the quote effect below re-runs on its own once a price moves.
   *
   * Paused while an order is being placed, so nothing shifts under a customer
   * who has already pressed the button.
   */
  const refreshLines = useCallback(async () => {
    const data = await api.get<{ items: CartItem[] }>('/api/cart');
    const all = data.items || [];
    const filtered =
      requestedItemIds && requestedItemIds.length > 0 ? all.filter((i) => requestedItemIds.includes(i.id)) : all;
    setItems((prev) => {
      const moved = changedPrices(prev, filtered);
      if (moved.size) setPricesMoved(true);
      return filtered;
    });
  }, [requestedItemIds]);

  useFreshOnReturn(refreshLines, { enabled: !submitting, minIntervalMs: 8_000, pollWhileVisibleMs: 60_000 });

  // Product delivery options are an allow-list. A method disabled by any
  // selected physical line is not presented as valid; pickup remains a
  // separate no-last-mile choice. The server repeats this check at the door.
  const availableDeliveryMethods = checkoutDeliveryMethods.filter((method) => {
    if (method.id === 'pickup') return true;
    if (method.id !== 'standard' && method.id !== 'personal') {
      return !items.some((item) => item.delivery_availability !== undefined);
    }
    return items.every((item) => item.delivery_availability?.[method.id] !== false);
  });
  const availableDeliveryKey = availableDeliveryMethods.map((method) => method.id).join(',');

  // Default the selector once settings/items arrive, and move away from a
  // method that became unavailable after a quantity/cart refresh.
  useEffect(() => {
    if (availableDeliveryMethods.length === 0) {
      if (deliveryMethod) setDeliveryMethod('');
      return;
    }
    if (!deliveryMethod || !availableDeliveryMethods.some((method) => method.id === deliveryMethod)) {
      setDeliveryMethod(availableDeliveryMethods[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableDeliveryKey, deliveryMethod]);

  // THE SCREEN OFFERS EXACTLY WHAT THE SERVER ALLOWS. The owner's rule is two
  // ways to pay — in advance from the wallet, or cash on delivery — for every
  // shipping type; the quote names them and the settings rows supply the
  // owner's own titles. An id the settings still list but the server does not
  // offer (a half advance) is simply not drawn. Cash is the resting default
  // because the wallet method REQUIRES the whole total to be covered, and a
  // screen that opens on a refusal is a poor first impression.
  const offeredPaymentIds = quote?.allowed_payment_methods ?? DEFAULT_OFFERED_PAYMENT_IDS;
  const filteredPaymentMethods = checkoutPaymentMethods.filter((m) => offeredPaymentIds.includes(m.id));
  const offeredKey = filteredPaymentMethods.map((m) => m.id).join(',');
  useEffect(() => {
    if (filteredPaymentMethods.length === 0) return;
    if (!paymentMethod || !filteredPaymentMethods.some((m) => m.id === paymentMethod)) {
      setPaymentMethod(filteredPaymentMethods.find((m) => m.id === 'cash')?.id ?? filteredPaymentMethods[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offeredKey, paymentMethod]);

  // Re-quote on every relevant selection change. The response is the ONLY
  // source of truth for shipping/waivers/policies — local math is a fallback
  // while the request is in flight.
  // The lines AND their prices. Keying on ids alone meant a price that moved
  // while this screen was open never re-quoted: the same lines were still the
  // same lines, so shipping, the coupon and the waiver kept answering for a
  // total that no longer existed. Quantity belongs here for the same reason.
  const itemIdsKey = items.map((i) => `${i.id}:${i.qty}:${i.unit_price_iqd}`).join(',');
  useEffect(() => {
    if (!selectedAddressId || !deliveryMethod || items.length === 0) {
      setQuote(null);
      return;
    }
    const seq = ++quoteSeqRef.current;
    setQuoteLoading(true);
    setQuoteError('');
    api
      .post<{ quote: CheckoutQuoteDto }>('/api/orders/quote', {
        addressId: selectedAddressId,
        deliveryMethodId: deliveryMethod,
        paymentMethodId: paymentMethod || undefined,
        itemIds: items.map((i) => i.id),
        usePoints,
        useWallet: useWalletBalance,
        protectedDelivery,
        supportCode: supportRef || undefined,
        couponCode: couponCode || undefined,
      })
      .then((data) => {
        if (seq !== quoteSeqRef.current) return;
        setQuote(data.quote);
        setCouponError('');
        // Material-change detection → consent reset (§7).
        const sig = [
          data.quote.total_iqd,
          data.quote.shipping.total_iqd,
          data.quote.due_on_delivery_iqd,
          data.quote.policies.map((p) => `${p.key}:${p.version}`).join('|'),
        ].join('~');
        if (quoteSignatureRef.current && quoteSignatureRef.current !== sig) {
          setPolicyAccepted((prev) => {
            if (prev) setConsentResetNote(true);
            return false;
          });
        }
        quoteSignatureRef.current = sig;
      })
      .catch((err) => {
        if (seq !== quoteSeqRef.current) return;
        // A coupon that stopped being valid between the cart and here must
        // not take the whole quote down with it: drop the code, say why, and
        // the effect re-runs without it. Everything else is a real quote
        // failure and is reported as one.
        const code = err instanceof ApiError ? err.code ?? '' : '';
        if (couponCode && COUPON_FAILURES.has(code)) {
          setCouponError(apiRefusal(err, lang as 'ar' | 'en' | 'ckb', ''));
          setCouponCode('');
          storePromo('');
          return;
        }
        setQuote(null);
        setQuoteError(refusalWithCounter(err, lang, 'quote failed'));
      })
      .finally(() => {
        if (seq === quoteSeqRef.current) setQuoteLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAddressId, deliveryMethod, paymentMethod, usePoints, useWalletBalance, protectedDelivery, itemIdsKey, supportRef, couponCode]);

  const walletBalanceIQD = usdCentsToIqd(balanceUsdCents, exchangeRate);

  /**
   * THE WALLET IS THE DEFAULT AS SOON AS IT IS A REAL ONE.
   *
   * The owner's rule for a pre-order is that the wallet is the cheaper door
   * and the one to land on. The paragraph above explains why the resting
   * default is still cash: the wallet method requires the WHOLE total to be
   * covered, and a screen that opens on a refusal is a poor first impression.
   * Both are true, so the choice is made from a fact instead of a preference —
   * once a quote has priced this cart, the wallet is selected if and only if
   * the balance covers that total.
   *
   * Read against the total the screen is CURRENTLY quoting, which is the cash
   * one while cash is selected and therefore the higher of the two: a balance
   * that covers the cash total certainly covers the wallet total, so this can
   * move the selection but can never oscillate. It is deliberately
   * conservative the other way — a balance that covers only the cheaper
   * wallet total leaves the selection alone, and the buyer is told about it by
   * the «الأرخص» badge and the `+N` on cash rather than by a refusal.
   *
   * `paymentPickedRef` makes it a DEFAULT and not an override: the moment the
   * buyer touches the radios this stops having an opinion, including if they
   * deliberately move back to cash.
   */
  useEffect(() => {
    if (paymentPickedRef.current) return;
    if (quoteLoading || !quote) return;
    if (paymentMethod === 'wallet') return;
    if (!filteredPaymentMethods.some((m) => m.id === 'wallet')) return;
    if (walletBalanceIQD < quote.total_iqd) return;
    setPaymentMethod('wallet');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote, quoteLoading, offeredKey, paymentMethod, walletBalanceIQD]);

  const getMethodIcon = (iconName: string, className: string = "w-5 h-5") => {
    switch (iconName) {
      case 'Truck': return <Truck className={className} strokeWidth={1.5} />;
      case 'Store': return <Store className={className} strokeWidth={1.5} />;
      case 'CreditCard': return <CreditCard className={className} strokeWidth={1.5} />;
      case 'Wallet': return <Wallet className={className} strokeWidth={1.5} />;
      case 'Banknote': return <Banknote className={className} strokeWidth={1.5} />;
      case 'CalendarClock': return <CalendarClock className={className} strokeWidth={1.5} />;
      default: return <CheckCircle2 className={className} strokeWidth={1.5} />;
    }
  };

  // Preview math mirrors the server's order pricing (worker/routes/orders.ts):
  // subtotal + delivery, minus points, then wallet. The authoritative amounts
  // come from the server quote whenever one is loaded; the order itself is
  // always recomputed server-side when placed.
  //
  // THE QUOTE'S LINES ARE THE PRICE AUTHORITY. The cart prices a pre-order
  // line as prepaid, but the server re-prices it for the payment method the
  // customer picked (cash on delivery prices a pre-order like a direct sale),
  // so once a quote exists both the per-line totals and the subtotal come from
  // it — showing cart-basis prices beside a quote-basis total would be two
  // different orders on one screen.
  const cartSubtotal = items.reduce((sum, item) => sum + item.unit_price_iqd * item.qty, 0);
  const total = quote ? quote.subtotal_iqd : cartSubtotal;
  const cartById = new Map(items.map((i) => [i.id, i] as const));
  const summaryLines: Array<{
    key: string;
    image: string;
    name: string;
    variant: string;
    qty: number;
    lineTotal: number;
    isPrinter: boolean;
    /** A bundle's parts, for the same disclosure the cart uses. */
    included?: BundleContentLine[];
    componentTotalIqd?: number | null;
    savingPercent?: number | null;
    mysterySpools?: number | null;
  }> =
    quote
      ? quote.lines.map((l) => {
          const cartLine = cartById.get(l.cart_item_id);
          return {
            key: l.cart_item_id,
            image: l.image ?? cartLine?.image ?? '',
            name: l.name,
            variant: l.variant,
            qty: l.qty,
            lineTotal: l.line_total_iqd,
            isPrinter: l.is_printer,
            // A MYSTERY line's parts are spools whose contents are not told
            // yet, so there is nothing to disclose and — since they all carry
            // the offer's own name and a null product id — nothing that would
            // even produce distinct React keys.
            included: l.mystery
              ? []
              : (l.included ?? []).map((k, n) => ({
                  key: `${l.cart_item_id}:${k.product_id ?? n}`,
                  name: k.name,
                  name_ar: k.name_ar,
                  variant: k.variant,
                  qty: k.qty,
                  value_iqd: k.value_iqd,
                })),
            // ONE BASIS PER SCREEN. The struck "bought separately" figure and
            // the saving badge come from the QUOTE, beside the quote's own line
            // total — reading them off the cart line put a cart-basis number
            // next to a quote-basis one on a pre-order bundle the quote had
            // re-priced for cash on delivery. The cart is only the fallback for
            // a payload that predates these two fields.
            componentTotalIqd: l.component_total_iqd ?? cartLine?.composition?.component_total_iqd ?? null,
            savingPercent: l.saving_percent ?? cartLine?.composition?.saving_percent ?? null,
            mysterySpools: l.mystery ? l.mystery.spools : (cartLine?.composition?.mystery?.spool_qty ?? null),
          };
        })
      : items.map((i) => ({
          key: i.id,
          // §3/§12: the product name is English in every language and is never translated.
          image: i.image,
          name: i.name,
          variant: i.variantLabel,
          qty: i.qty,
          lineTotal: i.unit_price_iqd * i.qty,
          isPrinter: i.is_printer === true,
          included: (i.composition?.components ?? [])
            .filter((k) => k.included)
            .map((k) => ({
              key: k.component_id,
              name: k.product.name,
              name_ar: k.product.name_ar,
              variant: k.variant,
              qty: k.qty_per_bundle,
              value_iqd: k.value_iqd,
            })),
          componentTotalIqd: i.composition?.component_total_iqd ?? null,
          savingPercent: i.composition?.saving_percent ?? null,
        }));
  // A pre-order cart: which pricing rule is in force, said once, in one line,
  // and ONLY when there is something to say. Read from the quote, never
  // inferred here: a cash order the wallet settled in full is a prepaid one
  // (`prepaid_by_wallet`); cash on delivery priced the lines as a direct sale
  // (`pricing_basis`); paying in advance kept the pre-order price where cash
  // WOULD have changed it (`cod_reprices`). A pre-order whose lines carry no
  // direct premium says nothing — the number is the same either way.
  const isPreorderCart = !!quote?.shipping_type && quote.shipping_type.startsWith('preorder_');
  const codDirectPricing = isPreorderCart && quote?.pricing_basis === 'direct';
  const prepaidByWallet = isPreorderCart && quote?.prepaid_by_wallet === true;
  const pricingBasisLine = !isPreorderCart || !quote || prepaidByWallet
    ? null
    : codDirectPricing
      ? S.codDirectPricing
      : quote.cod_reprices === true
        ? S.prepaidPreorder
        : null;
  // The printer note — the server echoes the amount only when a line is a
  // printer, a home delivery is requested and the owner configured a number.
  const printerNoteIqd = quote?.notes?.printer_home_delivery_iqd ?? null;
  /**
   * The printer advance is now a REQUIREMENT, not only a printed term: the
   * server folds it into `wallet.required_advance_iqd`, so an order it cannot
   * cover is refused at the door. `isBalanceSufficient` below already disables
   * the Complete button from the same field — this flag exists so the note can
   * say WHICH requirement is unmet rather than leaving a dead button and no
   * explanation.
   */
  const printerAdvanceUnmet =
    printerNoteIqd !== null &&
    quote !== null &&
    quote.wallet.applied_iqd < quote.wallet.required_advance_iqd;
  const selectedDelivery = checkoutDeliveryMethods.find(m => m.id === deliveryMethod);

  /**
   * WHO IS OFFERED A DAY — the same two facts `checkoutDeliveryDay` decides
   * from on the server, so the screen cannot draw a picker the door refuses.
   *
   *   1. THE METHOD MUST END AT THE CUSTOMER'S DOOR. `home_delivery` is what
   *      the method declares; `id !== 'pickup'` is only the fallback for a
   *      method stored before the flag existed. Testing the id alone is what
   *      breaks the day the owner adds «استلام من الفرع الثاني».
   *   2. THE CART MUST BE A DIRECT SALE. A pre-order earns its window later,
   *      at `at_levo_warehouse` — the first moment a last-mile day is a real
   *      choice rather than a guess about a container — so asking now would be
   *      collecting an answer the server is about to refuse.
   */
  const dayPolicy = settings?.deliveryDayPolicy;
  const todayDay = baghdadDay(Date.now());
  const offeredDays = useMemo(
    () => offeredCheckoutDays(dayPolicy, todayDay, lang),
    [dayPolicy, todayDay, lang]
  );
  const endsAtTheDoor = selectedDelivery
    ? typeof selectedDelivery.home_delivery === 'boolean'
      ? selectedDelivery.home_delivery
      : selectedDelivery.id !== 'pickup'
    : false;
  const dayChoiceOffered =
    settings !== null && endsAtTheDoor && quote?.shipping_type === 'direct' && offeredDays.length > 0;

  // A pick the offer no longer contains must not survive to the POST: the
  // customer switching to pickup, or leaving the tab open past midnight, would
  // otherwise send a day the server refuses at the very last button.
  useEffect(() => {
    if (!dayChoiceOffered) {
      setRequestedDay(null);
      return;
    }
    setRequestedDay((prev) => (prev && !offeredDays.some((d) => d.day === prev) ? null : prev));
  }, [dayChoiceOffered, offeredDays]);

  const deliveryPrice = selectedDelivery?.price_iqd || 0;
  const shippingIqd = quote ? quote.shipping.total_iqd : deliveryPrice;
  /** What the cash door costs over the wallet one, straight from the server.
   *  0 (and so nothing drawn) on a direct cart, or when the two are equal. */
  const codSurchargeIqd = quote?.cod_surcharge_iqd ?? 0;
  const codTaxIqd = quote?.cod_tax_iqd ?? 0;
  /**
   * §14 — THE CASH-ON-DELIVERY TAX IS CALCULATED, THEN EXEMPTED, AND BOTH
   * NUMBERS ARE SHOWN. The row carries what the tax engine worked out; the
   * exemption is its own row beneath it. Collapsing them into the charged
   * zero would hide the only place the customer ever sees what the exemption
   * was worth — and would leave a courier's cash sheet nothing to reconcile.
   */
  const codTaxBeforeExemption = quote?.cod_tax_before_exemption_iqd ?? codTaxIqd;
  const codTaxExemption = quote?.cod_tax_exemption_iqd ?? 0;

  /**
   * THE MEMBERSHIP, AS THE SERVER RESOLVED IT (§11).
   *
   * `active` is the entitlement answer from the memberships ledger — an
   * expired or admin-restricted membership comes back false and this screen
   * then says nothing about a membership at all, rather than advertising a
   * benefit the order will not carry.
   */
  const benefits = quote?.membership_benefits ?? null;
  const memberActive = !!benefits && benefits.active === true && isPaidTier(benefits.tier);
  const memberLabel = memberActive && benefits ? tierLabel(benefits.tier) : '';
  /**
   * §2 — WHICH FIGURE MAY GO IN THE COLUMN.
   *
   * Only `order_discount_iqd`: the part the server deducts after the subtotal.
   * `discount_total_iqd` also contains what `resolveUnitPrice` already took
   * off the line prices above, so putting it in the running total would
   * discount the same goods twice and the column would stop adding up.
   */
  const memberOrderDiscount = memberActive && benefits ? Math.max(0, benefits.order_discount_iqd) : 0;
  /** The whole saving — the headline, and never a row. */
  const memberSavingTotal = memberActive && benefits ? Math.max(0, benefits.discount_total_iqd) : 0;
  /** The part already inside the prices above, named when the two differ. */
  const memberUnitDiscount = memberActive && benefits ? Math.max(0, benefits.unit_discount_iqd) : 0;
  /** The membership's half of the delivery fee, when it has one. */
  const memberShipping =
    memberActive && benefits && benefits.shipping.eligible && benefits.shipping.subsidy_iqd > 0
      ? benefits.shipping
      : null;
  /**
   * THE TWO TAX ROWS ARE ONE DECISION, NOT TWO.
   *
   * The exemption is shown as its own row only when this screen is also
   * naming the membership that earned it, so the row ABOVE must carry the
   * figure the two net against — and the CHARGED figure whenever that row is
   * not going to appear. Reading the gross figure from one condition and the
   * exemption from another is how a column ends up overstating the total by
   * an exemption it never displayed: the three quote fields above are
   * deliberately optional, so a payload carrying the tax pair without a
   * resolvable `membership_benefits` is exactly the skew they exist to
   * survive.
   */
  const showCodExemption = memberActive && codTaxExemption > 0;
  const codTaxRowIqd = showCodExemption ? codTaxBeforeExemption : codTaxIqd;
  const shippingWaived = !!quote && quote.shipping.total_iqd < quote.shipping.total_before_waiver_iqd;
  const shippingNeedsConfig = !!quote && quote.shipping.needs_config.length > 0;
  const requiredPolicies = quote?.policies ?? [];
  const beforeDiscounts = total + shippingIqd;
  // THE SERVER'S NUMBER WINS THE MOMENT THERE IS ONE.
  //
  // The local arithmetic below is a placeholder for the second before the
  // first quote lands, and it is not the shop's pricing: it never subtracts
  // the coupon, so a customer with a valid code was shown the discount as a
  // line and then a total that ignored it — more than the server would
  // actually charge. `total_iqd` and `due_on_delivery_iqd` come from the same
  // function that prices the order at creation, so showing them is the only
  // way the screen and the charge can agree.
  const localPoints = usePoints ? Math.min(pointBalance, beforeDiscounts) : 0;
  const pointsDiscount = quote ? quote.points.applied_iqd : localPoints;
  const orderTotal = quote ? quote.total_iqd : beforeDiscounts - localPoints;

  // Advance payment logic: "pay in advance" is the wallet method (the legacy
  // `full_advance` id means the same thing), and it covers the whole total —
  // the server refuses a half advance (worker/lib/paymentPolicy.ts).
  /**
   * THE PROMO FIELD IS OPEN WHEN THERE IS SOMETHING TO SEE IN IT.
   *
   * A customer who already has a code on this order must be able to find it
   * and take it off; hiding the field behind a link they have no reason to
   * press would strand them. So the disclosure is a floor, not a gate: they
   * can open it, and a live coupon opens it for them.
   */
  const promoOpen = showPromoField || !!quote?.coupon || !!couponCode;

  const isPrepaidMethod = paymentMethod === 'wallet' || paymentMethod === 'full_advance';
  const isBnplMethod = paymentMethod === 'bnpl';
  const requiredAdvance = isPrepaidMethod ? orderTotal : 0;
  const isAdvanceRequired = requiredAdvance > 0;

  // Force wallet usage if advance is required
  useEffect(() => {
    if (isAdvanceRequired) {
      setUseWalletBalance(true);
    }
  }, [isAdvanceRequired]);

  // Calculate wallet discount
  const isWalletActive = isAdvanceRequired || useWalletBalance;
  const walletDiscount = quote
    ? quote.wallet.applied_iqd
    : isWalletActive
      ? Math.min(walletBalanceIQD, orderTotal)
      : 0;

  /**
   * THE WALLET FIGURE MUST BE THE ONE THE SERVER WILL CHARGE FROM.
   *
   * `walletDiscount` above already prefers the quote. The BALANCE shown beside
   * the toggle, and the toggle's own disabled test, still read
   * `balanceUsdCents` — the SETTLED balance out of `WalletContext`, with no
   * hold accounting at all. The server charges from the SPENDABLE balance
   * (`getAvailableBalances`: "pending deposits and pending points are NEVER
   * spendable") and refuses with INSUFFICIENT_BALANCE when the advance is not
   * covered. A customer with an open hold — a checkout they abandoned twenty
   * minutes ago — was shown a sufficient balance and an enabled button, and
   * was refused at the last step.
   *
   * `quote.wallet` carries the spendable balance, what was applied and what
   * the advance requires, all computed by the same function that prices the
   * order at creation. The context value survives only as the placeholder for
   * the second before the first quote lands.
   */
  const walletBalanceShown = quote ? quote.wallet.balance_iqd : walletBalanceIQD;
  const isBalanceSufficient = quote
    ? quote.wallet.applied_iqd >= quote.wallet.required_advance_iqd
    : walletDiscount >= requiredAdvance;
  const consentSatisfied = requiredPolicies.length === 0 || policyAccepted;
  /**
   * THE SERVER ALREADY ANSWERED "MAY THIS BE BOUGHT?".
   *
   * `can_checkout` comes back on every quote and was declared in the DTO but
   * never read, while the client re-derived the same verdict from its own
   * pieces. Two implementations of one rule is how a screen comes to enable a
   * button the door will refuse. The client conditions stay — they are what
   * disables the button BEFORE the first quote lands, and what explains why —
   * but the server's answer is the last word.
   */
  const serverAllows = quote ? quote.can_checkout !== false : true;

  /**
   * ═══ «عند الضغط على تأكيد الطلب لا يحدث شيء» ═══
   *
   * THE BUTTON AND THE REASON ARE NOW ONE EXPRESSION, and that is the whole
   * fix. There were eight conjuncts deciding whether the order could be
   * placed, the button was `disabled` on their conjunction, and `placeOrder`
   * ALSO early-returned on it — so any one of them going false produced a
   * grey button that did nothing and said nothing.
   *
   * The commonest way in was the printer advance. A cart with a printer going
   * to a home address folds 50,000 IQD into `required_advance_iqd`
   * (worker/routes/orders.ts, `printerHomeDeliveryAdvanceIqd`), so a customer
   * whose Levo wallet holds less than that fails `isBalanceSufficient` and can
   * never place the order. There WAS a sentence for it — in the document flow,
   * on a wide screen. On a phone the button lives in a fixed bottom bar and
   * the explanation was somewhere above the fold, which is indistinguishable
   * from a broken button.
   *
   * ORDER MATTERS: the list runs from what the customer can fix soonest to
   * what they can fix last, so the sentence names the NEXT thing to do rather
   * than the last thing that happens to be wrong.
   *
   * `quoteLoading` deliberately returns null: it disables the button (below)
   * but it is not a refusal, it is a wait, and the button already says
   * «جارٍ…» for it.
   */
  const blockReason: string | null = (() => {
    if (submitting || quoteLoading) return null;
    if (items.length === 0) return S.blockEmpty;
    if (!selectedAddressId) return S.blockAddress;
    if (!deliveryMethod) return S.blockDelivery;
    if (!paymentMethod) return S.blockPayment;
    if (shippingNeedsConfig) return S.needsConfig;
    if (!consentSatisfied) return S.policyRequired;
    if (!isBalanceSufficient) return S.blockAdvance;
    if (!serverAllows) return S.blockQuote;
    /**
     * A QUOTE THAT NEVER ARRIVED IS A REFUSAL, NOT A PERMISSION.
     *
     * `serverAllows` read `quote ? … : true` — open by default — so a quote
     * the server had REFUSED (an out-of-stock line makes it 400 rather than
     * price) left `quote === null` and the guard waved the order through to a
     * door that would throw. Closed by default is the honest direction: the
     * screen cannot claim an order is placeable when the only authority on
     * that question failed to answer.
     */
    if (!quote) return S.blockQuote;
    return null;
  })();

  const canCompleteOrder = blockReason === null && !submitting && !quoteLoading;

  /** One sentence, rendered wherever the button is — including the phone's
   *  fixed bar, which is the screen the owner reported this from. */
  const blockNotice =
    blockReason && !submitError ? (
      <p
        role="alert"
        data-checkout-block-reason
        className="text-[12px] leading-snug text-danger font-medium flex items-start gap-1.5"
      >
        <AlertCircle aria-hidden="true" className="w-3.5 h-3.5 shrink-0 mt-px" />
        <span>
          <span className="sr-only">{S.blockedLabel} </span>
          {blockReason}
        </span>
      </p>
    ) : null;

  const amountRemainingOnDelivery = quote ? quote.due_on_delivery_iqd : orderTotal - walletDiscount;
  const bnplFinancedIqd = isBnplMethod
    ? quote?.bnpl?.financed_iqd ?? Math.max(0, orderTotal - walletDiscount)
    : 0;

  const placeOrder = async () => {
    if (!canCompleteOrder) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      const data = await api.post<{ order: ApiOrder; invoice_no?: string | null }>('/api/orders', {
        addressId: selectedAddressId,
        deliveryMethodId: deliveryMethod,
        protectedDelivery,
        paymentMethodId: paymentMethod,
        useWallet: isWalletActive,
        usePoints,
        itemIds: items.map((i) => i.id),
        // The customer's day, or absent for «في أقرب وقت». It reaches the
        // server ONLY here: it changes no price, so putting it on the quote
        // would re-price the whole cart on every tap of a chip.
        requestedDeliveryDate: requestedDay || undefined,
        idempotencyKey: idempotencyKeyRef.current,
        // §3.3: attribution only — the server answers with the frozen
        // support snapshot and an unchanged total.
        supportCode: supportRef || undefined,
        // Only the code the QUOTE was already priced with, so the total the
        // customer just agreed to is the total the server computes.
        couponCode: couponCode || undefined,
        // Versioned consent (§7): only sent once the customer explicitly
        // checked the unchecked-by-default box for these exact versions.
        policyLocale: lang,
        policyAcceptance: policyAccepted
          ? requiredPolicies.map((p) => ({ key: p.key, version: p.version }))
          : [],
      });
      setPlacedInvoiceNo(data.invoice_no ?? null);
      setPlacedOrder(data.order);
      refreshWallet().catch(() => {});
      /**
       * §15 — THE ONE MOMENT THAT DESERVES MORE THAN THE HOUSE SUCCESS.
       *
       * Every mutation in the app already drives a small success face through
       * the request funnel, which is right for adding a filament to the cart
       * and much too small for the order it has been building towards. The
       * page names what happened; the controller decides what that looks like
       * and outranks the generic reaction it has already queued.
       */
      mascot.outcome('ordered');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        navigate('/auth');
        return;
      }
      /**
       * THE LAST SCREEN BEFORE PAYMENT SPEAKS THE CUSTOMER'S LANGUAGE (§15.3).
       *
       * `HttpError` carries one untranslated sentence, and this branch rendered
       * it verbatim — so an Arabic or Sorani customer read English prose
       * wrapped around an Arabic product name, with the machine code in
       * parentheses and no bidi isolation, at the highest-stakes moment in the
       * app. `apiRefusal` decodes the CODE from the trilingual table and falls
       * back to the server's sentence only for codes that already had one.
       */
      const msg = refusalWithCounter(err, lang, 'Order could not be placed. Please try again.');
      if (err instanceof ApiError && err.code === 'INSUFFICIENT_BALANCE') {
        setSubmitError(dir === 'rtl' ? `الرصيد غير كافٍ للدفع المقدم المطلوب — ${msg}` : msg);
      } else if (err instanceof ApiError && err.code === 'POLICY_ACCEPTANCE_REQUIRED') {
        setPolicyAccepted(false);
        setConsentResetNote(true);
        setSubmitError(S.policyRequired);
      } else if (err instanceof ApiError && err.code === 'SHIPPING_NEEDS_CONFIG') {
        setSubmitError(S.needsConfig);
      } else if (err instanceof ApiError && (err.code ?? '').startsWith('DELIVERY_DAY_')) {
        /**
         * THE DAY WAS REFUSED, AND THE ORDER IS ONE TAP FROM GOING THROUGH.
         *
         * The server checks the requested day against ITS Baghdad day and the
         * ceiling it is about to freeze, so this is what a device clock a day
         * out — or a checkout left open across midnight — arrives at. Clearing
         * the pick rather than retrying silently is the honest half: the
         * customer is told their day was not taken and that the order will now
         * go out as soon as possible, and they press the button again.
         */
        setRequestedDay(null);
        setSubmitError(S.dayRefused);
      } else {
        setSubmitError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  };

  // Versioned-policy consent block (§7): unchecked by default, links to the
  // published documents, resets on material quote changes. Rendered above
  // both CTAs. Nothing renders while no policy is published (honest empty).
  /**
   * ONE PLACE-ORDER BUTTON.
   *
   * There were two, and they had drifted: the mobile copy was missing the
   * "insufficient balance" explanation and the implicit-policy note, so a
   * phone customer got a disabled button and no reason for it. Worse, the
   * mobile copy lived INSIDE the form column, and below `lg` the root is
   * `flex-col` — so DOM order was visual order and the button rendered ABOVE
   * the entire order summary. The customer confirmed the purchase before ever
   * seeing the price; its own warning even read "the total above has been
   * updated" while the total was below it.
   *
   * The messages stay in the document flow, where they can be read and
   * scrolled to. The button is in the rail on a wide screen and in a fixed
   * bottom bar on a phone, so it is always after the summary and always
   * reachable.
   */
  const orderButton = (
    <button
      type="button"
      data-testid="checkout-place-order"
      onClick={placeOrder}
      disabled={!canCompleteOrder}
      className="lv-button lv-button-primary w-full min-h-[52px] text-base"
    >
      {submitting
        ? loc('جارٍ تأكيد الطلب…', 'Placing order…', 'داواکاری دەنێردرێت…')
        : loc('تأكيد الطلب', 'Place order', 'دڵنیاکردنەوەی داواکاری')}
    </button>
  );

  const consentBlock =
    requiredPolicies.length > 0 ? (
      <div className="mt-4 mb-4 p-4 rounded-xl bg-[#050505] border border-white/10 space-y-3">
        <div className="text-xs uppercase tracking-widest text-zinc-500">{S.policyTitle}</div>
        <label className="flex items-start gap-3 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={policyAccepted}
            onChange={(e) => {
              setPolicyAccepted(e.target.checked);
              if (e.target.checked) setConsentResetNote(false);
            }}
            className="mt-0.5 w-4 h-4 shrink-0 accent-white"
          />
          <span className="text-xs text-zinc-300 font-light leading-relaxed">
            {S.policyAgree}{' '}
            {requiredPolicies.map((p, i) => (
              <React.Fragment key={p.key}>
                {i > 0 && <span className="text-zinc-500"> · </span>}
                <a
                  href={`/policies/${encodeURIComponent(p.key)}?version=${p.version}&lang=${lang}`}
                  target="_blank"
                  rel="noreferrer"
                  className="underline text-white hover:text-zinc-300"
                >
                  {S.policyNames[p.key] ?? p.key}
                </a>
                <span className="text-zinc-500 text-[10px]"> ({S.version} {p.version})</span>
              </React.Fragment>
            ))}
          </span>
        </label>
        {consentResetNote && (
          <p className="text-xs text-amber-400/90 font-light flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
            {S.policyReset}
          </p>
        )}
        {!policyAccepted && !consentResetNote && (
          <p className="text-[11px] text-zinc-500 font-light">{S.policyRequired}</p>
        )}
      </div>
    ) : null;

  if (placedOrder) {
    return (
      <div className="h-full min-h-0 w-full overflow-y-auto bg-canvas text-text-primary flex flex-col font-sans selection:bg-white/20">
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center animate-in fade-in zoom-in-95 duration-700">
          {/*
            THE CHARACTER ARRIVES; THE CHECKMARK DOES NOT PULSE.

            This was a white disc with a `animate-ping` ring behind it — a
            decorative loop that ran for as long as the screen was open, which
            is exactly the kind of motion the motion system rules out: it says
            nothing, it cannot be interrupted, and it goes on saying nothing
            after the news has been read.

            A `stage` anchor replaces it. The character is docked in the header
            when the order is placed, so registering a destination HERE makes
            it travel down the page — the existing journey, with its wind-up,
            its deceleration and its settle squash, none of it written twice.
            The descent is the animation the owner asked for, and it is the
            mechanism the character already uses to go anywhere.

            `celebrate` is signalled beside it: priority 65 for 1.5s, above the
            notification the order will produce, then back to calm. Under
            reduced motion the engine cross-fades instead of travelling, and
            the character is simply already here.
          */}
          <div className="mb-8 flex items-center justify-center">
            <MotionCharacterAnchor kind="stage" />
          </div>

          <h2 className="text-2xl md:text-4xl font-normal mb-3 tracking-tight">
            {dir === 'rtl' ? 'تم استلام طلبك بنجاح' : 'Order Successfully Placed'}
          </h2>

          <p className="text-zinc-500 max-w-md mx-auto mb-10 text-base font-light">
            {dir === 'rtl'
              ? 'شكراً لك. سنقوم بمعالجة طلبك وإعلامك بآخر التحديثات قريباً.'
              : 'Thank you. We will process your order and notify you with updates soon.'}
          </p>

          <div className="bg-[#0a0a0a] border border-white/5 rounded-xl p-6 max-w-xs w-full mb-10 shadow-xl">
            <div className="text-xs text-zinc-500 mb-1 font-light">{dir === 'rtl' ? 'رقم الطلب' : 'Order Number'}</div>
            <div className="text-lg font-mono tracking-widest text-white">{placedOrder.id}</div>
            {placedInvoiceNo && (
              <div className="mt-4 pt-4 border-t border-white/5">
                <div className="text-xs text-zinc-500 mb-1 font-light">{S.invoiceNo}</div>
                <div className="text-sm font-mono tracking-wider text-white">{placedInvoiceNo}</div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/orders')}
              className="bg-white/10 text-white hover:bg-white/20 font-normal py-3 px-8 rounded-xl transition-all border border-white/10"
            >
              {dir === 'rtl' ? 'طلباتي' : 'My Orders'}
            </button>
            <button
              onClick={() => navigate('/')}
              className="bg-white text-black hover:bg-zinc-200 font-normal py-3 px-8 rounded-xl transition-all shadow-lg"
            >
              {dir === 'rtl' ? 'العودة للرئيسية' : 'Back to Home'}
            </button>
          </div>
        </div>

        {/* Last in the tree and non-blocking by construction: it portals to
            document.body, carries no scrim and takes no scroll lock, so the
            order number above stays readable and copyable underneath it. It
            decides for itself whether to appear at all — a customer who
            already has Telegram linked never sees it. */}
        <ChannelNudge context="order" active />
      </div>
    );
  }

  if (loading) {
    return (
      <div
        className="grid h-full min-h-0 w-full flex-1 place-items-center bg-canvas text-text-primary"
        data-testid="checkout-loading"
        aria-live="polite"
        aria-busy="true"
      >
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-text-muted border-t-transparent" aria-hidden="true" />
          <p className="text-sm text-text-secondary">
            {loc('جارٍ تجهيز صفحة الدفع…', 'Preparing checkout…', 'ئامادەکردنی پارەدان…')}
          </p>
        </div>
      </div>
    );
  }

  if (!loading && items.length === 0) {
    return (
      <div className="h-full min-h-0 w-full overflow-y-auto bg-canvas text-text-primary flex flex-col items-center justify-center p-6 text-center font-sans">
        <div className="w-16 h-16 rounded-full bg-white/5 border border-white/10 flex items-center justify-center mb-6">
          <ShoppingCart className="w-7 h-7 text-zinc-500" strokeWidth={1.5} />
        </div>
        <h2 className="text-xl font-normal mb-2 tracking-tight">
          {dir === 'rtl' ? 'لا توجد منتجات لإتمام الطلب' : 'Nothing to check out'}
        </h2>
        <p className="text-zinc-500 max-w-sm mx-auto mb-8 text-sm font-light">
          {loadError
            ? loadError
            : dir === 'rtl'
              ? 'اختر المنتجات من سلتك أولاً ثم عد لإتمام الطلب.'
              : 'Select items in your cart first, then come back to check out.'}
        </p>
        <button
          onClick={() => navigate('/cart')}
          className="bg-white text-black hover:bg-zinc-200 font-normal py-3 px-8 rounded-xl transition-all shadow-lg"
        >
          {dir === 'rtl' ? 'العودة إلى السلة' : 'Back to Cart'}
        </button>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 w-full overflow-y-auto bg-canvas text-text-primary font-sans selection:bg-white/20 flex flex-col lg:flex-row lg:overflow-hidden" data-checkout-viewport>

      {/* Left Form Area */}
      <div className="relative z-10 flex min-w-0 flex-col lg:h-full lg:min-h-0 lg:flex-1 lg:overflow-y-auto custom-scrollbar">
        <header className="lv-character-header sticky top-0 z-20 flex items-center justify-between border-b border-border-subtle bg-canvas/96 px-4 py-3 backdrop-blur-lg sm:px-6 lg:px-12 lg:py-6">
          <button
            onClick={handleBack}
            className="flex h-11 w-11 items-center justify-center rounded-lg bg-surface text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {dir === 'rtl' ? <ArrowRight className="w-5 h-5 text-white" strokeWidth={1.5} /> : <ArrowLeft className="w-5 h-5 text-white" strokeWidth={1.5} />}
          </button>
          <MotionCharacterHome />
          <div className="flex items-center gap-2 text-text-secondary px-2 py-2">
            <Lock className="w-4 h-4" strokeWidth={1.5} />
            <span className="text-xs font-semibold tracking-widest uppercase">
              {dir === 'rtl' ? 'دفع آمن' : 'Secure Checkout'}
            </span>
          </div>
        </header>

        <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-5 pb-10 sm:px-6 lg:space-y-10 lg:px-12 lg:pb-16">

          <div>
            <h1 className="text-2xl lg:text-3xl font-semibold tracking-tight mb-2">
              {dir === 'rtl' ? 'إتمام الطلب' : 'Checkout'}
            </h1>
            <p className="text-sm text-zinc-500 font-light">
              {dir === 'rtl' ? 'يرجى مراجعة وتأكيد تفاصيل طلبك أدناه.' : 'Please review and confirm your order details below.'}
            </p>
          </div>

          {/* Section: Address */}
          <section>
            <h2 className="text-xl font-normal text-white flex items-center gap-3 mb-5">
              <span className="w-6 h-6 rounded bg-white text-black flex items-center justify-center text-xs font-medium">1</span>
              {dir === 'rtl' ? 'عنوان التوصيل' : 'Shipping Address'}
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {addresses.map(addr => (
                <label key={addr.id} data-selected={selectedAddressId === addr.id} className="lv-choice relative flex cursor-pointer flex-col gap-2 p-4">
                  <input type="radio" name="address" className="sr-only" checked={selectedAddressId === addr.id} onChange={() => setSelectedAddressId(addr.id)} />
                  <div className="flex justify-between items-start">
                    <div className="flex items-center gap-2">
                      <MapPin className="w-4 h-4 text-text-muted" strokeWidth={1.5} />
                      <span className="font-normal text-white text-base">{addr.label}</span>
                    </div>
                    <span className="lv-choice-mark"><Check className="h-3 w-3" aria-hidden="true" /></span>
                  </div>
                  <p className="text-xs text-zinc-500 leading-relaxed pl-1 font-light">
                    {addr.name} — {addr.phone}
                    <br />
                    {addr.address}
                    {addr.landmark ? ` (${addr.landmark})` : ''}
                  </p>
                </label>
              ))}
              {!addingAddress ? (
                <button
                  type="button"
                  onClick={() => setAddingAddress(true)}
                  className="relative flex min-h-[100px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border-subtle bg-transparent p-4 text-text-muted transition-colors hover:bg-white/[0.03] hover:text-text-primary [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                >
                  <span className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center">
                    <Plus aria-hidden="true" className="w-4 h-4" strokeWidth={1.5} />
                  </span>
                  <span className="text-xs font-normal">
                    {loc('إضافة عنوان جديد', 'Add a new address', 'زیادکردنی ناونیشانی نوێ')}
                  </span>
                </button>
              ) : null}
            </div>
            {addingAddress ? (
              <div className="lv-surface mt-3 p-4">
                <AddressForm
                  dense
                  defaultWhenFirst={addresses.length === 0}
                  onCancel={() => setAddingAddress(false)}
                  onSaved={async (id) => {
                    // Re-read, then select the address that was just created —
                    // the step whose absence was the whole defect.
                    const d = await api.get<{ addresses: ApiAddress[] }>('/api/addresses');
                    setAddresses(d.addresses || []);
                    setSelectedAddressId(id);
                    setAddingAddress(false);
                  }}
                />
              </div>
            ) : null}
            {addresses.length === 0 && (
              <p className="text-xs text-amber-400/80 mt-3 font-light flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" strokeWidth={1.5} />
                {dir === 'rtl' ? 'أضف عنوان توصيل لإتمام الطلب.' : 'Add a delivery address to place your order.'}
              </p>
            )}
          </section>

          {/* Section: Delivery Method */}
          <section>
            <h2 className="text-xl font-normal text-white flex items-center gap-3 mb-5">
              <span className="w-6 h-6 rounded bg-white text-black flex items-center justify-center text-xs font-medium">2</span>
              {dir === 'rtl' ? 'طريقة الشحن' : 'Delivery Method'}
            </h2>
            <div className="grid grid-cols-1 gap-3">
              {availableDeliveryMethods.map(method => {
                const selected = deliveryMethod === method.id;
                const selectedQuote = selected ? quote?.shipping : null;
                /**
                 * THE SERVER'S FIGURE FOR *THIS* METHOD, not for the selected
                 * one and not a flat rate from settings.
                 *
                 * This line used to read `selectedQuote?.total_iqd ??
                 * method.price_iqd`: the selected card showed the real quote
                 * and every other card showed the configured base rate. On a
                 * cart whose delivery is priced per product and per quantity
                 * those differ, so choosing a method made its price jump and
                 * dropped the previous one back to its placeholder — two
                 * options appearing to swap prices. The server now prices
                 * every method in the same pass, with the same function that
                 * prices the order.
                 */
                const serverFee = quote?.delivery_method_fees?.find((f) => f.id === method.id);
                const unavailable = serverFee ? !serverFee.available : false;
                const displayedPrice = serverFee?.fee_iqd ?? selectedQuote?.total_iqd ?? null;
                const memberWaiver = selectedQuote?.waiver_source === 'pro' || selectedQuote?.waiver_source === 'prime';
                /**
                 * A method that does NOT end at the customer's door — read
                 * through the method's own `home_delivery` flag, with the
                 * legacy `id !== 'pickup'` only as the fallback for rows
                 * written before the flag existed. A bare id test is what
                 * breaks the day the owner adds «استلام من الفرع الثاني».
                 */
                const isPickupMethod =
                  typeof method.home_delivery === 'boolean' ? !method.home_delivery : method.id === 'pickup';
                const pickupMapUrl = isPickupMethod ? (method.map_url || '').trim() : '';
                return (
                <React.Fragment key={method.id}>
                <label data-selected={selected} className="lv-choice relative flex cursor-pointer items-center gap-3 p-4 sm:gap-4">
                  <input type="radio" name="delivery" className="sr-only" checked={selected} onChange={() => setDeliveryMethod(method.id)} />
                  <div className="flex-1 flex justify-between items-center">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-black/35 text-text-secondary">
                        {getMethodIcon(method.icon || '', "w-5 h-5")}
                      </div>
                      <div className="min-w-0">
                        <h3 className={`font-normal text-base ${selected ? 'text-white' : 'text-zinc-300'}`}>
                          {dir === 'rtl' ? method.titleAr : method.titleEn}
                        </h3>
                        <p className="text-xs text-zinc-500 mt-0.5 font-light">{dir === 'rtl' ? method.descAr : method.descEn}</p>
                        {/*
                          «بدل عرض كلمة محسوب حسب القطع بالكمية اجعل هناك
                           ملاحظة يظهر فيها عرض مكان المخزن على الخريطة».

                          «محسوب حسب القطع والكمية» explains a FEE, and a
                          pickup has none — on that card it was a sentence
                          about arithmetic that never happened. What the
                          customer needs from a method that asks them to drive
                          somewhere is WHERE, so the fee line gives way to the
                          address.

                          The link is drawn only when the owner has configured
                          one on this method (`map_url`, admin). Nothing here
                          knows the shop's address, and a guessed pin would
                          send customers to a place that does not exist — so
                          an unconfigured pickup card simply says nothing,
                          which is the honest version of not knowing.

                          `stopPropagation` because this sits inside the
                          <label> for the radio: without it, tapping the map
                          link would also select the method, which is a
                          delivery choice the customer did not make.
                        */}
                        {pickupMapUrl ? (
                          <a
                            href={pickupMapUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            data-pickup-map
                            onClick={(e) => e.stopPropagation()}
                            className="mt-1 inline-flex items-center gap-1.5 text-[11px] font-medium text-gold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] rounded"
                          >
                            <MapPin aria-hidden="true" className="w-3.5 h-3.5" />
                            {loc('عرض مكان المخزن على الخريطة', 'See the pickup location on the map', 'شوێنی وەرگرتن لەسەر نەخشە ببینە')}
                          </a>
                        ) : selectedQuote && !isPickupMethod ? (
                          <p className={`mt-1 text-[11px] font-medium ${memberWaiver ? 'text-emerald-400' : 'text-zinc-400'}`}>
                            {memberWaiver
                              ? loc('ميزة توصيل الأعضاء مطبّقة', 'Member delivery benefit applied', 'سوودی گەیاندنی ئەندام جێبەجێ کرا')
                              : loc('محسوب حسب القطع والكمية', 'Calculated for items and quantity', 'بەپێی پارچە و بڕ هەژمار کراوە')}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    {/* A fee we do not have yet is shown as a placeholder, never
                        as a number. Printing a stale or base figure here is the
                        defect this card is fixing. */}
                    <span
                      className={`font-medium text-sm shrink-0 tabular-nums ${
                        unavailable ? 'text-zinc-600' : displayedPrice === 0 ? 'text-emerald-400' : 'text-white'
                      }`}
                      data-delivery-fee={method.id}
                    >
                      {unavailable
                        ? loc('غير متاح', 'Unavailable', 'بەردەست نییە')
                        : displayedPrice === null
                          ? '—'
                          : displayedPrice === 0
                            ? loc('مجاناً', 'Free', 'بەخۆڕایی')
                            : money(displayedPrice)}
                    </span>
                  </div>
                  <span className="lv-choice-mark ms-1"><Check className="h-3 w-3" aria-hidden="true" /></span>
                </label>
                {/*
                  UNDER THE CHOSEN METHOD, and only that one. The day is a
                  property of the delivery that was just picked, so it belongs
                  against that card rather than in a section of its own — and
                  drawing a picker under every method would ask the same
                  question three times.
                */}
                {selected && dayChoiceOffered && (
                  <DeliveryDayPicker
                    days={offeredDays}
                    selected={requestedDay}
                    canChange
                    reason={null}
                    onPick={setRequestedDay}
                  />
                )}
                </React.Fragment>
                );
              })}
            </div>
            {quote?.priority_delivery?.eligible && (
              <div className="mt-3 rounded-xl border border-[#d6b866]/35 bg-gradient-to-r from-[#d6b866]/10 to-[#b03142]/10 p-3 flex items-start gap-3">
                <Sparkles className="w-5 h-5 text-[#e8c97a] shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-[#f2ddb0]">
                    {loc('توصيل أولوية PRO خلال 12 ساعة', 'PRO priority delivery within 12 hours', 'گەیاندنی پێشینەیی PRO لە ١٢ کاتژمێردا')}
                  </p>
                  <p className="text-xs text-zinc-400 mt-0.5">
                    {loc('تم التحقق من العنوان وطريقة التوصيل لهذا الطلب.', 'Address and delivery method are eligible for this order.', 'ناونیشان و شێوازی گەیاندن بۆ ئەم داواکارییە شیاون.')}
                  </p>
                </div>
              </div>
            )}
          </section>

          {/* Section: Payment Method */}
          <section>
            <h2 className="text-xl font-normal text-white flex items-center gap-3 mb-5">
              <span className="w-6 h-6 rounded bg-white text-black flex items-center justify-center text-xs font-medium">3</span>
              {dir === 'rtl' ? 'طريقة الدفع' : 'Payment Method'}
            </h2>
            <div className="grid grid-cols-1 gap-3">
              {filteredPaymentMethods.map(method => (
                <label key={method.id} data-selected={paymentMethod === method.id} className="lv-choice relative flex cursor-pointer items-center gap-4 p-4">
                  <input
                    type="radio"
                    name="payment"
                    className="sr-only"
                    checked={paymentMethod === method.id}
                    onChange={() => {
                      // From here on the wallet-first default has no opinion:
                      // the buyer has one.
                      paymentPickedRef.current = true;
                      setPaymentMethod(method.id);
                    }}
                  />
                  <div className="flex-1 flex items-center gap-4">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-black/35 text-text-secondary">
                      {getMethodIcon(method.icon || '', 'w-5 h-5')}
                    </div>
                    <div className="min-w-0">
                      <h3 className={`font-normal text-base ${paymentMethod === method.id ? 'text-white' : 'text-zinc-300'}`}>
                          {dir === 'rtl' ? method.titleAr : method.titleEn}
                      </h3>
                      {S.paymentHint[method.id] && (
                        <p className="text-xs text-zinc-500 mt-0.5 font-light">{S.paymentHint[method.id]}</p>
                      )}
                      {/*
                        «يجب توضيح هذا الفرق قبل أن يختار» — the difference, on
                        the two doors it is a difference between, before either
                        is opened. Drawn only when the server says the cart
                        actually prices differently, so a cart where the two
                        cost the same stays quiet instead of carrying a 0.

                        One cue per option and no second one: the amount on
                        cash, the word on the wallet. Both are quiet type
                        rather than a tinted block — the price of the order is
                        what this screen is for, and a badge that outshouts it
                        would be the wrong hierarchy.
                      */}
                      {codSurchargeIqd > 0 && method.id === 'cash' && (
                        <p data-cod-surcharge className="text-xs text-[#e8c97a] mt-1 font-normal tabular-nums">
                          {S.payCodMore(codSurchargeIqd.toLocaleString('en-US'))}
                        </p>
                      )}
                      {codSurchargeIqd > 0 && method.id === 'wallet' && (
                        <p data-cod-cheapest className="text-xs text-emerald-300/90 mt-1 font-normal">
                          {S.payCheapest}
                        </p>
                      )}
                    </div>
                  </div>
                  <span className="lv-choice-mark"><Check className="h-3 w-3" aria-hidden="true" /></span>
                </label>
              ))}
            </div>
          </section>

        </div>
      </div>

      {/* Right Summary Area. The phone's fixed action bar overlaps THIS column
          (it is last in the flow below `lg`), so the clearance belongs here. */}
      <div className="relative z-20 flex w-full shrink-0 flex-col bg-surface pb-[calc(84px+env(safe-area-inset-bottom))] lg:pb-0 lg:h-full lg:min-h-0 lg:w-[460px] lg:border-s lg:border-border-subtle">
        {/*
          THE SUMMARY COLUMN SCROLLS AS A WHOLE.

          It used to scroll only its ITEM LIST: the list carried
          `lg:flex-1 lg:overflow-y-auto` inside a `lg:h-full` column, and
          everything after it — the totals, the promo field, the points and
          wallet switches, the delivery breakdown, the consent checkbox and the
          place-order button — sat in the same fixed-height column with no
          overflow of its own. Whenever that tail was taller than the space the
          list left over, it ran past the bottom of the column and the root's
          `lg:overflow-hidden` clipped it. On an iPad the customer saw the
          policy checkbox at the very edge of the screen and the confirm button
          below the fold, with nothing to scroll.

          The fix is to put the scroll on THIS container and let the list take
          its natural height, so every row in the summary is reachable. The
          root stays `lg:overflow-hidden` on purpose — the two columns are
          independent panes, which is what keeps the form from scrolling the
          summary away.

          The button is NOT made sticky: the refusal messages under it
          (insufficient balance, a price that moved, the implicit-policy note)
          have to be readable, and the comment on `orderButton` records why
          they were moved out from under a fixed bar in the first place.
        */}
        <div className="flex min-h-0 flex-col p-4 sm:p-6 lg:h-full lg:overflow-y-auto lg:p-10 custom-scrollbar">

          <h2 className="text-xl font-normal text-white flex items-center gap-3 mb-6">
            <Receipt className="w-5 h-5 text-zinc-400" strokeWidth={1.5} />
            {dir === 'rtl' ? 'ملخص الطلب' : 'Order Summary'}
          </h2>

          {/* Natural height now — the column above owns the scrolling. A nested
              scroll area here would trap the wheel inside the item list and
              leave the totals below it unreachable all over again. */}
          <div className="mb-6 space-y-2">
            {summaryLines.map((line) => (
                <div key={line.key} data-checkout-line={line.key} className="group relative flex gap-3 overflow-hidden py-3 border-b border-border-subtle last:border-0">
                  <div className="w-16 h-16 rounded-lg bg-black overflow-hidden relative shrink-0">
                    {line.image ? (
                      <img referrerPolicy="no-referrer" src={line.image} alt={line.name} className="w-full h-full object-cover opacity-80 group-hover:scale-110 transition-transform duration-500" />
                    ) : (
                      <div className="w-full h-full bg-zinc-900" />
                    )}
                    <span className="absolute top-1 end-1 w-5 h-5 bg-white text-black rounded flex items-center justify-center text-[10px] font-medium shadow-md">{line.qty}</span>
                  </div>
                  <div className="flex-1 min-w-0 flex flex-col justify-center">
                    <h4 className="text-sm font-normal text-white line-clamp-1 mb-0.5">{line.name}</h4>
                    {line.variant && (
                      <p className="text-xs text-zinc-500 mb-1.5 font-light">{line.variant}</p>
                    )}
                    <span className="text-sm font-medium text-white tabular-nums">{money(line.lineTotal)}</span>
                    {line.mysterySpools ? (
                      <p className="mt-1 text-[11.5px] text-zinc-400">
                        {loc(
                          `${line.mysterySpools} قطعة عشوائية — يُكشف المحتوى لاحقًا`,
                          `${line.mysterySpools} random item(s) — revealed later`,
                          `${line.mysterySpools} دانەی هەڕەمەکی — دواتر ئاشکرا دەکرێت`
                        )}
                      </p>
                    ) : null}
                    {line.included && line.included.length > 0 && (
                      <BundleContents
                        className="mt-2"
                        lines={line.included}
                        componentTotalIqd={line.componentTotalIqd ?? null}
                        savingPercent={line.savingPercent ?? null}
                      />
                    )}
                  </div>
                </div>
            ))}
          </div>

          <div className="space-y-4 pt-6 border-t border-white/5 mt-auto text-sm">
            {/* ═══════════════════════════════════════════════════════════════
                §15 — THE MONEY COLUMN, IN THE ORDER A CUSTOMER READS IT.

                It used to run: subtotal, shipping, a note, the coupon FIELD,
                the points CARD, another note, the wallet. Three different
                KINDS of thing — figures, explanations and controls —
                interleaved, so nobody could tell where the price stopped and
                the choices began, and each note landed between two numbers it
                had nothing to do with. «هذا السلوك غير مناسب ويسبب ارتباك.»

                It now runs in four bands, and each band answers one question:

                  1. WHAT THE GOODS COST       subtotal, and what came off it
                  2. WHAT IT COSTS TO ARRIVE   delivery, its tax, its commission
                  3. WHAT YOU SHOULD KNOW      every note, together, once
                  4. WHAT SETTLES IT           the code, the wallet, the points

                Bands 1 and 2 carry the figures that add up to the total
                below — plus the one control that changes a fee in band 2
                itself, protected delivery, which is kept beside the delivery
                row it prices rather than exiled to band 4 away from its own
                number. Band 3 adds nothing to any total and is styled so it
                can never be mistaken for a row. Band 4 holds the three ways to
                settle the bill and no summed figure at all.

                Two figures carry a «!» — the delivery and the delivery
                company's tax — because they are the two the customer neither
                chose nor could predict. `SummaryInfo` opens its answer UNDER
                the row, so it never covers the next number.
                ═══════════════════════════════════════════════════════════════ */}

            {/* ── 1. WHAT THE GOODS COST ──────────────────────────────────── */}
            {/*
              THE MONEY LABELS BELOW READ `loc(ar, en)`, NOT `dir === 'rtl'`.

              `dir` is 'rtl' for Arabic AND for Kurdish, so the old ternary
              handed a Sorani reader the Arabic string while looking, in the
              source, like a language choice. It was not one: it was a
              DIRECTION choice standing in for a language, and every Kurdish
              gap in this column was invisible because of it.

              `loc` with two arguments falls back to Arabic for ckb by
              documented design (LanguageContext.tsx), so what renders today is
              byte-for-byte what rendered before — the missing Sorani is simply
              a visible empty slot now, which a Kurdish speaker can fill,
              rather than a ternary nobody would think to look inside. No
              Kurdish is invented here; the store writes its own.
            */}

            <div className="flex justify-between items-center text-zinc-400">
              <span className="font-light">{loc('المجموع الفرعي', 'Subtotal')}</span>
              <span className="text-white font-normal tabular-nums">{money(total)}</span>
            </div>

            {/*
              §11 — THE MEMBERSHIP, NAMED, IN THE COLUMN THAT ADDS UP.

              The ROW carries `order_discount_iqd` and nothing else: the rest of
              the saving is already inside the subtotal above, and a row
              carrying the whole figure would take it off a second time (§2).
              The SENTENCE under it carries `discount_total_iqd` — the whole
              saving — precisely because it is not a row and cannot be summed;
              when both halves exist the unit half is named, so the smaller row
              above is not read as a contradiction.

              The Sorani is the store's own: «داشکاندنی» from the promo field,
              «ئەندامێتی PRO» from the product page, «پاشەکەوتت کرد … ئەندامێتی»
              from the product page's member saving. The two-part sentence has
              no existing Sorani, so it reads in Arabic there rather than in
              invented Kurdish. Only the Latin tier name is ever a variable, and
              it comes from `tierMeta` — «PREMIUM», never `prime`.
            */}
            {memberActive && (memberOrderDiscount > 0 || memberSavingTotal > 0) && (
              <div>
                {memberOrderDiscount > 0 && (
                  <div className="flex justify-between items-center text-gold/90" data-checkout-member-discount>
                    <span className="font-light">
                      {loc(
                        `خصم عضوية ${memberLabel}`,
                        `${memberLabel} membership discount`,
                        `داشکاندنی ئەندامێتی ${memberLabel}`
                      )}
                    </span>
                    <span className="font-normal tabular-nums">-{money(memberOrderDiscount)}</span>
                  </div>
                )}
                {memberSavingTotal > 0 && memberSavingTotal !== memberOrderDiscount && (
                  <p
                    className="mt-1 text-[11.5px] leading-relaxed text-gold/90 tabular-nums"
                    data-checkout-member-saving
                  >
                    {memberOrderDiscount > 0 && memberUnitDiscount > 0
                      ? loc(
                          `وفّرت ${money(memberSavingTotal)} بعضوية ${memberLabel} — منها ${money(memberUnitDiscount)} مطبّقة في أسعار المنتجات أعلاه`,
                          `Saved ${money(memberSavingTotal)} with your ${memberLabel} membership — ${money(memberUnitDiscount)} of it is already in the prices above`
                        )
                      : loc(
                          `وفّرت ${money(memberSavingTotal)} بعضوية ${memberLabel}`,
                          `Saved ${money(memberSavingTotal)} with ${memberLabel} membership`,
                          `پاشەکەوتت کرد ${money(memberSavingTotal)} — ئەندامێتی ${memberLabel}`
                        )}
                  </p>
                )}
              </div>
            )}

            {quote?.coupon && Number(quote.coupon.discount_iqd) > 0 && (
              <div className="flex justify-between items-center text-emerald-400">
                <span className="font-light">
                  {loc('خصم الكود', 'Promo discount')}{' '}
                  <span dir="ltr" className="text-zinc-500 text-xs">{quote.coupon.code}</span>
                </span>
                <span className="font-normal">-{money(Number(quote.coupon.discount_iqd))}</span>
              </div>
            )}

            {pointsDiscount > 0 && (
              <div className="flex justify-between items-center text-gold/90">
                <span className="font-light">{loc('خصم النقاط', 'Points Discount')}</span>
                <span className="font-normal tabular-nums">-{money(pointsDiscount)}</span>
              </div>
            )}

            {/* §3.3/§5 — the support code appears in the money view with an
                explicit ZERO. The server echoes it from the resolved snapshot,
                so this line can never claim an attribution the order will not
                actually carry. */}
            {quote?.support && (
              <div
                data-testid="checkout-support-line"
                className="flex justify-between items-center gap-3 text-[13px] text-sky-300"
              >
                <span className="font-light truncate">{S.supportLine(quote.support.referrer_username || quote.support.ref)}</span>
                <span className="font-normal shrink-0 text-zinc-400">{S.supportZero}</span>
              </div>
            )}

            {/* ── 2. WHAT IT COSTS TO ARRIVE ──────────────────────────────── */}

            {/*
              «تكلفة التوصيل إلى البيت» — NOT «الشحن», by owner instruction, and
              the rename is the smaller half of the fix. The word «الشحن» is
              what a shop says when one flat fee covers the parcel; this fee is
              summed per product and per piece, which is why the customer could
              not reconcile it with anything and why the breakdown that explains
              it used to sit in a permanent box below, pushing the rest of the
              column down for every customer whether they wondered or not.

              The breakdown is now the ANSWER to the «!» — the same server
              components and the same server reasons, moved inside, shown to
              whoever asks and to nobody else.
            */}
            <SummaryInfo
              testId="delivery"
              label={loc('تكلفة التوصيل إلى البيت', 'Home delivery cost')}
              question={loc('كيف حُسبت تكلفة التوصيل؟', 'How is the delivery cost calculated?')}
              value={
                quoteLoading ? (
                  <span className="text-zinc-500 font-light text-xs">{S.quoteLoading}</span>
                ) : shippingIqd === 0 ? (
                  <span className="text-emerald-400 font-normal">
                    {shippingWaived && quote && quote.shipping.total_before_waiver_iqd > 0 && (
                      <span className="text-zinc-500 line-through font-light mx-2 text-xs">
                        {money(quote.shipping.total_before_waiver_iqd)}
                      </span>
                    )}
                    {S.freeShipping}
                  </span>
                ) : (
                  <span className="text-white font-normal tabular-nums">{money(shippingIqd)}</span>
                )
              }
              note={
                /*
                  §11 — WHOSE MEMBERSHIP DID IT, said under the figure it
                  explains, and ALWAYS visible: a ceiling that BINDS means the
                  customer paid part of the fee, so nothing here may call it
                  free (§3). What the membership covered, the fee it came off
                  and what is left to pay are all stated, and all three are the
                  server's own numbers. This is a fact about the price, not an
                  answer to a question, so it is not behind the «!».

                  The Sorani «گەیاندنی بێبەرامبەری PREMIUM» is the membership
                  ledger's own line; the covered-in-part sentence has no Sorani
                  equivalent in the store, so it reads in Arabic there rather
                  than in invented Kurdish.
                */
                memberShipping && !quoteLoading ? (
                  <p
                    className="mt-1 text-[11.5px] leading-relaxed text-gold/90 tabular-nums"
                    data-checkout-member-delivery={
                      memberShipping.fee_paid_iqd === 0 ? 'free' : memberShipping.subsidy_capped ? 'capped' : 'partial'
                    }
                  >
                    {memberShipping.fee_paid_iqd === 0
                      ? loc(
                          `التوصيل مجاني بفضل عضوية ${memberLabel}`,
                          `Delivery is free thanks to your ${memberLabel} membership`,
                          `گەیاندنی بێبەرامبەری ${memberLabel}`
                        )
                      : loc(
                          `عضوية ${memberLabel} غطّت ${money(memberShipping.subsidy_iqd)} من أجرة التوصيل البالغة ${money(memberShipping.fee_before_benefit_iqd)}، وتدفع ${money(memberShipping.fee_paid_iqd)}`,
                          `Your ${memberLabel} membership covered ${money(memberShipping.subsidy_iqd)} of the ${money(memberShipping.fee_before_benefit_iqd)} delivery fee — you pay ${money(memberShipping.fee_paid_iqd)}`
                        )}
                  </p>
                ) : null
              }
            >
              <p>{loc(
                'التوصيل يُحسب حسب كل منتج وعدد قطعه، لا مبلغاً واحداً للطلب — لذلك يتغيّر المبلغ كلما تغيّرت السلة.',
                'Delivery is charged per product and per number of pieces, not as one flat fee for the order — so it moves whenever the cart does.'
              )}</p>

              {quote && quote.shipping.components.length > 0 && (
                <div className="space-y-1.5 border-t border-white/5 pt-2">
                  {quote.shipping.components.map((component, index) => {
                    const names: Record<string, [string, string]> = {
                      ordinary: ['توصيل الطلب', 'Order delivery'],
                      protected: ['حماية وتغليف', 'Protected handling'],
                      printer_small: ['توصيل طابعة صغيرة', 'Small printer delivery'],
                      printer_large: ['توصيل طابعة كبيرة', 'Large printer delivery'],
                      carton: ['كرتونة كمية إضافية', 'Extra quantity carton'],
                      product: ['توصيل حسب المنتج', 'Product delivery'],
                    };
                    const name = component.product_name
                      ? [component.product_name, component.product_name]
                      : names[component.kind] ?? [component.kind, component.kind];
                    return (
                      <div key={`${component.kind}:${index}`} className="flex items-center justify-between gap-3">
                        <span className="text-zinc-500">
                          {loc(name[0], name[1])}
                          {component.units > 1 ? ` × ${component.units}` : ''}
                        </span>
                        <span className={`tabular-nums ${component.waived ? 'text-emerald-400' : 'text-zinc-300'}`}>
                          {component.waived ? S.freeShipping : money(component.fee_iqd)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Server quote transparency: WHY a fee/waiver applies (§6.3). */}
              {quote && quote.shipping.reasons.length > 0 && (
                <div className="border-t border-white/5 pt-2 space-y-1">
                  <div className="text-[11px] uppercase tracking-widest text-zinc-500">{S.whyTitle}</div>
                  {quote.shipping.reasons.map((r, i) => (
                    <p key={i} className="leading-relaxed">{r}</p>
                  ))}
                </div>
              )}
            </SummaryInfo>

            {/* Protected delivery — offered only when the owner priced it, so
                the customer never sees a switch that cannot be honoured. */}
            {quote?.protected_delivery?.available && (
              <label
                className="flex items-start gap-3 rounded-lg bg-white/[0.03] border border-white/5 p-3 cursor-pointer"
                data-checkout="protected-delivery"
              >
                <input
                  type="checkbox"
                  className="mt-1 shrink-0 accent-[#ef233c]"
                  checked={protectedDelivery}
                  onChange={(e) => setProtectedDelivery(e.target.checked)}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-white font-normal">{S.protectedTitle}</span>
                    <span className="text-xs font-normal shrink-0">
                      {quote.protected_delivery.waived ? (
                        <span className="text-emerald-400">{S.protectedFree}</span>
                      ) : (
                        <span className="text-zinc-300">
                          + {money(quote.protected_delivery.fee_iqd ?? 0)}
                        </span>
                      )}
                    </span>
                  </span>
                  <span className="block text-xs text-zinc-400 font-light mt-0.5">{S.protectedDesc}</span>
                </span>
              </label>
            )}

            {/*
              §14 — THE DELIVERY COMPANY'S TAX, AND ITS EXEMPTION, AS TWO ROWS.

              «ضريبة شركة التوصيل» — renamed by owner instruction from «ضريبة
              الدفع عند الاستلام». The old name said WHEN it is taken and never
              WHO takes it, so a customer reading it could only conclude the
              shop had invented a charge. It is the courier's, on a high cash
              amount, and the «!» now says so with the policy's own two numbers.

              The row shows what the tax engine calculated, which is the figure
              on the courier's cash sheet. The exemption beneath it is what the
              membership waived, and the two together come to what is charged —
              so the column still reaches the total, and the customer can see
              what the membership was worth instead of a silent zero.
            */}
            {codTaxRowIqd > 0 && (
              <SummaryInfo
                testId="cod-tax"
                label={S.codTax}
                question={loc('لماذا توجد ضريبة على التوصيل؟', 'Why is there a delivery tax?')}
                value={<span className="text-white font-normal tabular-nums">{money(codTaxRowIqd)}</span>}
              >
                <p>{loc(
                  'شركة التوصيل تأخذ ضريبة على الطلبات ذات المبلغ العالي المدفوع عند الاستلام — وهي ليست من المتجر.',
                  'The delivery company charges a tax on high amounts collected at the door — it is not the store’s.'
                )}</p>
                {/* The two numbers come from the policy module the server
                    charges by, never from a sentence typed here: if the rate
                    ever changes, this explanation changes with it instead of
                    quietly becoming a lie. */}
                <p className="tabular-nums">{loc(
                  /* A RATE, NOT A PRICE — so it does not follow the currency
                     switch. «6,000 د.ع عن كل 500,000 د.ع» is how the charge is
                     DEFINED, in the unit it is legislated and collected in, and
                     it is quoted from packages/shipping/src/codTax so the
                     sentence cannot drift from what the server actually
                     charges. Converting a definition would make the explanation
                     depend on a rate the shop can change tomorrow. */
                  `وقدرها ${formatIqd(codTaxPerBlockIqd)} عن كل ${formatIqd(codTaxBlockIqd)} من المبلغ المدفوع عند الاستلام.`,
                  `It is ${formatIqd(codTaxPerBlockIqd)} for every ${formatIqd(codTaxBlockIqd)} collected at the door.`
                )}</p>
                <p>{loc(
                  'اختيار الدفع من المحفظة أو الدفع المسبق يُلغيها بالكامل.',
                  'Paying from your wallet or in advance removes it entirely.'
                )}</p>
              </SummaryInfo>
            )}

            {showCodExemption && (
              <div>
                <div className="flex justify-between items-center text-gold/90" data-checkout-cod-tax-exemption>
                  <span className="font-light">
                    {loc(`إعفاء عضوية ${memberLabel}`, `${memberLabel} membership exemption`)}
                  </span>
                  <span className="font-normal tabular-nums">-{money(codTaxExemption)}</span>
                </div>
                <p className="mt-1 text-[11.5px] leading-relaxed text-gold/90" data-checkout-member-cod>
                  {loc('تم إعفاؤك من ضريبة الدفع عند الاستلام', 'You are exempt from the cash-on-delivery tax')}
                </p>
              </div>
            )}

            {/*
              «عمولة الدفع عند الاستلام للطلب المسبق» — shown, by owner
              instruction, BUT NEVER SUMMED, and the distinction is the whole
              point of this block.

              A pre-order paid at the door is priced as a direct sale
              (`pricing_basis === 'direct'`), so the difference is ALREADY
              inside the line prices in the subtotal above. Adding it here as
              an ordinary row would charge it a second time on screen and the
              column would stop reaching the total — the exact confusion this
              reorder exists to end. So it is drawn in the quiet tone reserved
              for figures that are not summed, and the «!» says where the money
              actually is. The customer still sees the number they asked to
              see; the arithmetic stays true.
            */}
            {codDirectPricing && codSurchargeIqd > 0 && (
              <SummaryInfo
                testId="cod-commission"
                tone="quiet"
                label={loc('عمولة الدفع عند الاستلام', 'Cash-on-delivery commission')}
                question={loc('ما هي عمولة الدفع عند الاستلام؟', 'What is the cash-on-delivery commission?')}
                value={
                  <span className="tabular-nums" data-checkout-cod-commission>
                    +{money(codSurchargeIqd)}
                  </span>
                }
              >
                <p>{loc(
                  'الطلب المسبق المدفوع عند الاستلام يُسعَّر كبيع مباشر، والفرق هو هذه العمولة.',
                  'A pre-order paid at the door is priced as a direct sale — this commission is the difference.'
                )}</p>
                <p>{loc(
                  'المبلغ محسوب أصلاً داخل أسعار المنتجات في المجموع الفرعي أعلاه، فهو معروض للتوضيح فقط ولا يُضاف مرة ثانية.',
                  'It is already inside the product prices in the subtotal above — shown here for clarity, never added twice.'
                )}</p>
                <p>{loc(
                  'الدفع من المحفظة أو الدفع المسبق يُعيد سعر الطلب المسبق ويُلغي هذه العمولة.',
                  'Paying from your wallet or in advance restores the pre-order price and removes it.'
                )}</p>
              </SummaryInfo>
            )}

            {/* ── 3. WHAT YOU SHOULD KNOW ─────────────────────────────────── */}

            {/*
              EVERY NOTE, TOGETHER, ONCE. These used to be scattered through
              the figures — the pricing rule above the delivery, the printer
              term between the coupon and the points — so each one interrupted
              an addition the customer was in the middle of. None of them is a
              row and none of them is summed; gathered here they read as what
              they are, terms of the sale, and the money column above them is
              left to add up uninterrupted.
            */}

            {/* One line about the pricing rule in force on a pre-order cart:
                cash on delivery prices the lines as a direct sale while the
                order keeps its journey; paying in advance keeps the configured
                pre-order price. Read from the quote, never inferred here, and
                only when cash on delivery would change the number at all. */}
            {pricingBasisLine && quote && (
              <p
                className="text-[11.5px] text-zinc-500 font-light leading-relaxed"
                data-checkout-pricing-basis={quote.pricing_basis}
              >
                {pricingBasisLine}
              </p>
            )}

            {/* The wallet settled the whole cash order: nothing is collected at
                the door, so the server priced it as the prepaid pre-order it
                is — and the customer is told why the total moved. */}
            {prepaidByWallet && (
              <Note tone="gold" icon={<Wallet className="w-4 h-4" strokeWidth={1.5} />} testId="checkout-prepaid-by-wallet">
                <span className="font-light">{S.prepaidByWallet}</span>
              </Note>
            )}

            {quote && quote.shipping.advance_due_iqd > 0 && (
              <p className="text-xs text-amber-400/90 font-light flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
                {S.advanceDue(money(quote.shipping.advance_due_iqd))}
              </p>
            )}

            {/* The printer home-delivery NOTE (owner mandate) — informational
                only, never added to a total. The amount is the server's
                (settings), echoed on the quote only for a printer line going
                to a home address; a store pickup gets no note. */}
            {printerNoteIqd !== null && summaryLines.some((l) => l.isPrinter) && (
              <Note
                tone={printerAdvanceUnmet ? 'amber' : 'zinc'}
                icon={<Truck className="w-4 h-4" strokeWidth={1.5} />}
                testId="checkout-printer-note"
              >
                <span className="font-light">{S.printerNote(money(printerNoteIqd))}</span>
                {/* Only once the quote says the balance cannot cover it. The
                    sentence above is a term of sale and stays quiet; this one
                    is the reason the Complete button is disabled, so it is
                    worth the tone change. */}
                {printerAdvanceUnmet && (
                  <span className="mt-1 block font-medium">
                    {S.printerAdvanceShort(money(printerNoteIqd), money(walletBalanceShown))}
                  </span>
                )}
              </Note>
            )}

            {shippingNeedsConfig && (
              <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 flex gap-2 text-amber-400">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
                <p className="text-xs leading-relaxed font-light">{S.needsConfig}</p>
              </div>
            )}

            {/* THE SERVER'S OWN SENTENCE, not a constant about it.
                `setQuoteError(refusalWithCounter(err, lang, 'quote failed'))`
                already computes the reason the server gave — and this line
                then rendered `S.quoteError` instead, a fixed «تعذّر حساب عرض
                السعر — سيُعاد التحقق عند تأكيد الطلب». The real reason was
                fetched, stored and thrown away, so a customer whose cart was
                refused for a nameable cause was told only that something went
                wrong and invited to confirm an order whose price nobody had
                computed. The constant stays as the fallback for a failure with
                no sentence of its own (a dropped connection). */}
            {quoteError && !quoteLoading && (
              <p className="text-xs text-zinc-500 font-light flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
                {typeof quoteError === 'string' && quoteError.trim() ? quoteError : S.quoteError}
              </p>
            )}

            {/* ── 4. WHAT SETTLES IT ──────────────────────────────────────── */}

            {/*
              THE THREE WAYS TO PAY LESS OR PAY DIFFERENTLY, and nothing else.

              Each used to shout from inside the money column: a headed promo
              input, a bordered points card, the wallet block — three boxes
              competing with the figures they were supposed to adjust. They are
              controls, so they belong AFTER the price, in the order the owner
              asked for: the code, then the wallet, then the points.

              The code is a QUIET LINE that expands
              («سطر ناعم استخدام كود خاص من تنقر عليه يتوسع لادخال الكود»),
              because most orders do not carry one and an empty input is a
              question nobody asked. It opens by itself when the order already
              has a code on it, so a customer who wants to remove one finds it
              open, not hidden.
            */}
            <div className="pt-1">
              {promoOpen ? (
                <div id="checkout-promo-field">
                  <PromoCodeField
                    lang={lang}
                    showLabel={false}
                    onApplied={(code) => {
                      setCouponError('');
                      setCouponCode(code);
                    }}
                  />
                  {couponError && (
                    <p role="alert" className="text-[#e4899a] text-[11px] mt-2">
                      {couponError}
                    </p>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowPromoField(true)}
                  aria-expanded={false}
                  aria-controls="checkout-promo-field"
                  data-checkout-promo-toggle
                  className="inline-flex items-center gap-2 text-[13px] font-light text-zinc-500 hover:text-zinc-300 transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369]"
                >
                  <Tag className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden="true" />
                  {loc('استخدام كود خاص', 'Use a special code')}
                </button>
              )}
            </div>

            {/* Wallet Block */}
            <div className={`mt-4 pt-4 border-t border-white/5 transition-all`}>
                <div className="flex items-center justify-between gap-4 mb-2">
                    <div className="flex items-center gap-3">
                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${isWalletActive ? 'bg-white text-black shadow-[0_0_10px_rgba(255,255,255,0.2)]' : 'bg-zinc-900 text-zinc-400'}`}>
                            <Wallet className="w-4 h-4" strokeWidth={1.5} />
                        </div>
                        <div>
                            <span className="font-normal text-white block text-sm">
                                {loc('استخدام المحفظة', 'Use Wallet')}
                            </span>
                            <span className="text-xs text-zinc-500 font-light block">
                                {loc('الرصيد:', 'Balance:')} <span className="text-zinc-300">{money(walletBalanceShown)}</span>
                            </span>
                        </div>
                    </div>

                    <button
                        type="button"
                        role="switch"
                        aria-checked={isWalletActive}
                        disabled={isAdvanceRequired || walletBalanceShown === 0}
                        onClick={() => setUseWalletBalance(!useWalletBalance)}
                        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                            isWalletActive ? 'bg-white' : 'bg-zinc-800'
                        } ${(isAdvanceRequired || walletBalanceShown === 0) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                    >
                        <span className={`inline-block h-4 w-4 transform rounded-full bg-black transition-transform ${
                            isWalletActive ? (dir === 'rtl' ? '-translate-x-6' : 'translate-x-6') : (dir === 'rtl' ? '-translate-x-1' : 'translate-x-1')
                        } ${!isWalletActive && 'bg-zinc-400'}`} />
                    </button>
                </div>

                {isAdvanceRequired && !isBalanceSufficient && (
                    <div className="mt-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20 flex gap-2 text-red-400">
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
                        <p className="text-xs leading-relaxed font-light">
                            {loc('الرصيد غير كافٍ للدفع المقدم.', 'Insufficient balance for advance.')}
                        </p>
                    </div>
                )}

                {!isAdvanceRequired && isWalletActive && walletDiscount > 0 && (
                     <div className="mt-3 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex gap-2 text-emerald-400">
                        <Sparkles className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
                        <p className="text-xs leading-relaxed font-light">
                            {loc(
                                `خصم ${walletDiscount.toLocaleString()} د.ع`,
                                `-${walletDiscount.toLocaleString()} IQD deduction`
                            )}
                        </p>
                    </div>
                )}
            </div>

            {/*
              POINTS, AS A QUIET LINE — «واسفله بسطر ناعم وهو استخدام النقاط».

              It was a bordered card the same weight as the wallet block above
              it, so two settlement controls of very different importance
              looked identical. The control is unchanged — the same switch, the
              same balance, the same cap — but it is now a line under the
              wallet rather than a second box beside it. Everything still comes
              from `quote.points`: the spendable balance, the redemption cap
              (points pay for merchandise, never for shipping or fees) and what
              this order earns back.
            */}
            {(quote?.points.balance ?? pointBalance) > 0 || pointsDiscount > 0 ? (
              <div className="pt-1">
                <label className="flex items-center justify-between gap-3 cursor-pointer">
                  <span className="min-w-0">
                    <span className="block text-[13px] font-light text-zinc-300">
                      {loc('استخدام النقاط', 'Use points', 'بەکارهێنانی خاڵ')}
                    </span>
                    <span className="block text-[11.5px] text-zinc-500 tabular-nums">
                      {loc('الرصيد', 'Balance', 'باڵانس')}: {money(quote?.points.balance ?? pointBalance)}
                      {quote?.points.eligible_merchandise_iqd != null
                        ? ` · ${loc('الحد الأقصى لهذا الطلب', 'Max for this order', 'زۆرترین بۆ ئەم داواکارییە')} ${money(quote.points.eligible_merchandise_iqd)}`
                        : ''}
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    className="peer sr-only"
                    checked={usePoints}
                    onChange={() => setUsePoints((v) => !v)}
                    disabled={(quote?.points.balance ?? pointBalance) === 0}
                  />
                  {/* The knob is a CHILD of the track, so `peer-checked:`
                      cannot reach it directly — the nested `[&>span]` selector
                      carries the state inward. It travels on
                      `inset-inline-start` rather than a translate so the switch
                      reads correctly in Arabic and Kurdish with one rule. */}
                  <span
                    aria-hidden="true"
                    className="relative shrink-0 w-11 h-6 rounded-full bg-zinc-800 transition-colors duration-200 peer-checked:bg-white peer-checked:[&>span]:start-[22px] peer-checked:[&>span]:bg-black peer-focus-visible:ring-2 peer-focus-visible:ring-focus peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-canvas"
                  >
                    <span className="absolute top-1 start-1 w-4 h-4 rounded-full bg-zinc-400 transition-[inset-inline-start] duration-200 ease-out" />
                  </span>
                </label>
                {quote?.points.earn_pending ? (
                  <p className="mt-2 text-[11.5px] text-zinc-500 tabular-nums">
                    {loc('ستكسب', 'You will earn', 'دەستت دەکەوێت')} {quote.points.earn_pending.toLocaleString()}{' '}
                    {loc('نقطة من هذا الطلب', 'points from this order', 'خاڵ لەم داواکارییە')}
                  </p>
                ) : null}
              </div>
            ) : null}

            {/*
              THE NUMBER THE CUSTOMER IS AGREEING TO PAY.

              It was not on this screen. The one headline figure was
              `due_on_delivery_iqd` (or the BNPL financed amount) at text-3xl —
              so a 100,000 order with 30,000 of wallet applied showed subtotal
              95,000, shipping 5,000, used balance −30,000, and then a 70,000
              headline. The 100,000 being committed to appeared nowhere and had
              to be summed by hand across six rows.

              The «رصيد مستخدم −30,000» row that used to sit directly above
              this block is gone (§15): it was the THIRD statement of
              `walletDiscount` on one screen — the wallet toggle announces it,
              and the settlement line below restates it as what it is, money
              already paid. Two places, each doing a different job.

              The total is the headline now, and what happens to it — paid from
              the wallet, financed, collected at the door — is the settlement
              block beneath it, which is what those numbers actually are.
            */}
            <div className="pt-5 mt-2 border-t border-border-subtle">
              <div className="flex justify-between items-baseline gap-3">
                <span className="text-text-primary font-bold text-[15px]">
                  {loc('إجمالي الطلب', 'Order total', 'کۆی داواکاری')}
                </span>
                {/*
                  THE ONE FIGURE THAT NEVER LEAVES DINARS.

                  Every price on this page follows the customer's chosen
                  currency (src/CurrencyContext.tsx), and this one does too —
                  but it keeps the dinar beside it, because the dinar is what
                  is actually charged. A converted figure, at a rate this shop
                  sets and can change tomorrow, is not the number the
                  customer's bank will see, and the screen with the pay button
                  on it is the last place to be approximate.
                */}
                <span data-testid="checkout-order-total" className="text-2xl font-black text-text-primary tabular-nums">
                  {moneyBoth(orderTotal)}
                </span>
              </div>

              <div className="mt-3 space-y-1.5 text-[13px]">
                {walletDiscount > 0 ? (
                  <div className="flex justify-between items-center text-text-secondary">
                    <span>{loc('مدفوع من المحفظة', 'Paid from your wallet', 'لە جزدان درا')}</span>
                    <span className="tabular-nums">−{money(walletDiscount)}</span>
                  </div>
                ) : null}

                {isBnplMethod ? (
                  <>
                    <div className="flex justify-between items-center">
                      <span className="text-text-secondary">
                        {loc('المبلغ المموّل عبر BNPL', 'Financed with BNPL', 'دابین کراو بە BNPL')}
                      </span>
                      <span data-testid="checkout-bnpl-financed" className="tabular-nums font-bold text-text-primary">
                        {money(bnplFinancedIqd)}
                      </span>
                    </div>
                    {quote?.bnpl?.due_at ? (
                      <div className="flex items-center gap-1.5 text-text-muted">
                        <CalendarClock aria-hidden="true" className="w-4 h-4" />
                        {loc('موعد السداد', 'Due', 'کاتی دانەوە')}{' '}
                        {new Date(quote.bnpl.due_at).toLocaleDateString(lang === 'ar' ? 'ar-IQ' : 'en-US')}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="flex justify-between items-center">
                    <span className={amountRemainingOnDelivery === 0 ? 'text-gold' : 'text-text-secondary'}>
                      {amountRemainingOnDelivery === 0
                        ? loc('مدفوع بالكامل', 'Fully paid', 'بە تەواوی درا')
                        : loc('يُدفع عند الاستلام', 'Due on delivery', 'لە کاتی وەرگرتن دەدرێت')}
                    </span>
                    <span
                      data-testid="checkout-due-on-delivery"
                      className={`tabular-nums font-bold ${amountRemainingOnDelivery === 0 ? 'text-gold' : 'text-text-primary'}`}
                    >
                      {money(amountRemainingOnDelivery)}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* THE FLOW HALF: consent, and every reason the button might refuse.
              These stay in the document so they can be read and scrolled to —
              a message under a fixed bar is a message nobody sees. */}
          <div className="pt-6">
            {consentBlock}
            {/* A price moved while this screen was open. It sits ABOVE the
                button, because a warning underneath the control it warns about
                is read after the tap. The order is priced on the server when
                it is placed, so the total shown is now the real one. */}
            {pricesMoved && (
              <p
                className="text-sm text-warning mb-3 font-medium flex items-center justify-center gap-2 text-center"
                data-prices-moved
              >
                <AlertCircle aria-hidden="true" className="w-4 h-4 shrink-0" />
                {loc(
                  'تغيّر سعر أحد المنتجات وحُدِّث المجموع. راجعه قبل التأكيد.',
                  'A price changed and the total has been updated. Please review it before confirming.',
                  'نرخی بەرهەمێک گۆڕا و کۆی گشتی نوێ کرایەوە. پێش دڵنیاکردنەوە پێداچوونەوەی بۆ بکە.'
                )}
              </p>
            )}

            {/* The wide-screen button sits here, at the end of the rail, with
                the reason DIRECTLY above it — above, because a warning printed
                underneath the control it warns about is read after the tap. */}
            <div className="hidden lg:block space-y-2">
              {blockNotice}
              {orderButton}
            </div>

            {submitError && (
              <p role="alert" className="text-center text-sm text-danger mt-4 font-medium flex items-center justify-center gap-2">
                <AlertCircle aria-hidden="true" className="w-4 h-4 shrink-0" />
                {submitError}
              </p>
            )}
            {requiredPolicies.length === 0 && (
              <p className="text-center text-xs text-text-muted mt-5 max-w-xs mx-auto leading-relaxed">
                {S.implicitNote}
              </p>
            )}
          </div>
        </div>
      </div>

      {/*
        THE PHONE'S ACTION BAR. Fixed, so it is outside the column order
        entirely and can never render above the summary again — and it carries
        the total, so the figure being agreed to is on screen at the moment of
        agreeing. The summary column reserves its height below.
      */}
      <div className="lg:hidden fixed inset-x-0 bottom-0 z-40 border-t border-border-subtle bg-canvas/95 backdrop-blur-xl px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto w-full max-w-[640px] space-y-2">
          {/* THE REASON TRAVELS WITH THE BUTTON. On a phone this bar is fixed
              and outside the document order, so a message left in the flow
              above is a message the customer never scrolls back to — which is
              exactly how a refusal reads as «لا يحدث شيء». */}
          {blockNotice}
          <div className="flex items-center gap-3">
            <div className="min-w-0 basis-[8.5rem] shrink-0">
              <div className="text-[11px] text-text-muted">{loc('إجمالي الطلب', 'Order total', 'کۆی داواکاری')}</div>
              <div className="text-text-primary font-black text-[15px] tabular-nums truncate">{money(orderTotal)}</div>
            </div>
            <div className="flex-1 min-w-0">{orderButton}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
