import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import {
  ArrowLeft, ArrowRight, Truck, Store,
  CreditCard, Wallet, Banknote,
  Check, Sparkles, MapPin, AlertCircle,
  Lock, CheckCircle2, Plus, Receipt, ShoppingCart
} from 'lucide-react';
import { useWallet } from '../WalletContext';
import { api, ApiAddress, ApiError, ApiOrder, CartItem, formatIqd, newIdempotencyKey, usdCentsToIqd } from '../lib/api';

// ---------------------------------------------------------------- server quote

interface ShippingQuoteDto {
  components: Array<{ kind: string; fee_iqd: number; waived: boolean; units: number; advance_required: boolean }>;
  total_iqd: number;
  total_before_waiver_iqd: number;
  advance_due_iqd: number;
  pro_waiver_applied: boolean;
  needs_config: string[];
  assumptions: string[];
  reasons: string[];
}

interface CheckoutQuoteDto {
  merchandise_iqd: number;
  subtotal_iqd: number;
  shipping: ShippingQuoteDto;
  is_pickup: boolean;
  coupon: { code?: string; discount_iqd?: number } | null;
  /** §3.3 attribution — always `discount_iqd: 0`; it is not a discount. */
  support: { referrer_username: string; ref: string; discount_iqd: number } | null;
  points: { balance: number; applied_iqd: number };
  wallet: { balance_iqd: number; applied_iqd: number; required_advance_iqd: number };
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
    advanceDue: (v: string) => `رسوم توصيل الطابعة (${v}) تُدفع مقدماً من المحفظة.`,
    freeShipping: 'مجاناً',
    whyTitle: 'تفاصيل التوصيل',
    policyTitle: 'الموافقة على السياسات',
    policyAgree: 'قرأتُ وأوافق على:',
    policyRequired: 'الموافقة على السياسات المنشورة مطلوبة لإتمام الطلب.',
    policyReset: 'تغيّر ملخص الطلب — يرجى تأكيد الموافقة مجدداً.',
    policyNames: { terms: 'شروط الاستخدام والبيع', privacy: 'سياسة الخصوصية' } as Record<string, string>,
    version: 'نسخة',
    invoiceNo: 'رقم الفاتورة',
    implicitNote: 'لا توجد سياسات منشورة تتطلب الموافقة حالياً.',
    supportLine: (name: string) => `كود دعم: ${name}`,
    supportZero: 'لا يغيّر سعر طلبك (0 د.ع)',
  },
  en: {
    quoteLoading: 'Calculating delivery...',
    quoteError: 'The price quote could not be calculated — it will be re-checked when you place the order.',
    needsConfig: 'Delivery fees for part of this order (printer / extra carton) are not configured by the store yet, so the order cannot be completed right now. We never invent a fee.',
    advanceDue: (v: string) => `Printer delivery fees (${v}) are paid in advance from your wallet.`,
    freeShipping: 'Free',
    whyTitle: 'Delivery details',
    policyTitle: 'Policy consent',
    policyAgree: 'I have read and agree to:',
    policyRequired: 'Accepting the published policies is required to place the order.',
    policyReset: 'The order summary changed — please confirm your agreement again.',
    policyNames: { terms: 'Terms of Use & Sale', privacy: 'Privacy Policy' } as Record<string, string>,
    version: 'v',
    invoiceNo: 'Invoice number',
    implicitNote: 'No published policies currently require acceptance.',
    supportLine: (name: string) => `Support code: ${name}`,
    supportZero: 'does not change your price (0 IQD)',
  },
  ckb: {
    quoteLoading: 'حسابکردنی گەیاندن...',
    quoteError: 'نرخی گەیاندن حساب نەکرا — لە کاتی تەواوکردنی داواکاری دووبارە پشکنین دەکرێت.',
    needsConfig: 'کرێی گەیاندنی بەشێک لەم داواکارییە (پرینتەر/کارتۆنی زیادە) هێشتا لەلایەن بەڕێوەبەرایەتییەوە ڕێکنەخراوە، بۆیە ئێستا داواکارییەکە تەواو ناکرێت.',
    advanceDue: (v: string) => `کرێی گەیاندنی پرینتەر (${v}) پێشوەخت لە جزدانەکەتەوە دەدرێت.`,
    freeShipping: 'بەخۆڕایی',
    whyTitle: 'وردەکاری گەیاندن',
    policyTitle: 'ڕەزامەندی لەسەر سیاسەتەکان',
    policyAgree: 'خوێندمەوە و ڕازیم بە:',
    policyRequired: 'ڕەزامەندی لەسەر سیاسەتە بڵاوکراوەکان پێویستە بۆ تەواوکردنی داواکاری.',
    policyReset: 'پوختەی داواکارییەکە گۆڕا — تکایە دووبارە ڕەزامەندی دەربڕە.',
    policyNames: { terms: 'مەرجەکانی بەکارهێنان و فرۆشتن', privacy: 'سیاسەتی تایبەتمەندی' } as Record<string, string>,
    version: 'وەشان',
    invoiceNo: 'ژمارەی پسوولە',
    implicitNote: 'لە ئێستادا هیچ سیاسەتێکی بڵاوکراوە پێویستی بە ڕەزامەندی نییە.',
    supportLine: (name: string) => `کۆدی پاڵپشتی: ${name}`,
    supportZero: 'نرخەکەت ناگۆڕێت (0 د.ع)',
  },
};

export default function Checkout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { lang, dir } = useLanguage();
  const {
    checkoutDeliveryMethods,
    checkoutPaymentMethods,
    balanceUsdCents,
    pointBalance,
    exchangeRate,
    refreshWallet,
  } = useWallet();
  const filteredPaymentMethods = checkoutPaymentMethods.filter(m => m.id !== 'card' && m.id !== 'wallet');

  // Selected cart line ids and points choice arrive from the Cart page via
  // router state; with no state we fall back to the whole cart.
  const routeState = (location.state ?? {}) as { itemIds?: string[]; usePoints?: boolean; supportRef?: string };
  const requestedItemIds = Array.isArray(routeState.itemIds) ? routeState.itemIds : null;
  const usePoints = routeState.usePoints === true;
  // §3.3 — the support code the cart resolved and the buyer kept. It is an
  // ATTRIBUTION, never a price input: it rides along to the quote and to the
  // order, the server re-resolves it and freezes it into
  // orders.support_snapshot, and it is worth exactly 0 IQD here. Nothing on
  // this page subtracts anything for it.
  const supportRef = typeof routeState.supportRef === 'string' ? routeState.supportRef.trim().slice(0, 60) : '';

  const [items, setItems] = useState<CartItem[]>([]);
  const [addresses, setAddresses] = useState<ApiAddress[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [placedOrder, setPlacedOrder] = useState<ApiOrder | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  const [selectedAddressId, setSelectedAddressId] = useState('');
  const [deliveryMethod, setDeliveryMethod] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('');
  const [useWalletBalance, setUseWalletBalance] = useState(false);

  // Server-authoritative quote (POST /api/orders/quote): re-fetched whenever
  // the address, cart lines, delivery/payment method or points choice change.
  const [quote, setQuote] = useState<CheckoutQuoteDto | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState('');
  // Versioned-policy consent: ALWAYS starts unchecked; any material quote
  // change (totals / shipping / required versions) resets it.
  const [policyAccepted, setPolicyAccepted] = useState(false);
  const [consentResetNote, setConsentResetNote] = useState(false);
  const quoteSignatureRef = useRef('');
  const quoteSeqRef = useRef(0);
  const [placedInvoiceNo, setPlacedInvoiceNo] = useState<string | null>(null);

  const S = STRINGS[lang as keyof typeof STRINGS] ?? STRINGS.ar;

  // One stable idempotency key per checkout visit: retries after a network
  // failure can never create a duplicate order.
  const idempotencyKeyRef = useRef(newIdempotencyKey());

  const handleBack = () => navigate(-1);

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
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Failed to load checkout');
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

  // Default the selectors once settings arrive.
  useEffect(() => {
    if (!deliveryMethod && checkoutDeliveryMethods.length > 0) setDeliveryMethod(checkoutDeliveryMethods[0].id);
  }, [checkoutDeliveryMethods, deliveryMethod]);
  useEffect(() => {
    if (!paymentMethod && filteredPaymentMethods.length > 0) setPaymentMethod(filteredPaymentMethods[0].id);
  }, [filteredPaymentMethods, paymentMethod]);

  // Re-quote on every relevant selection change. The response is the ONLY
  // source of truth for shipping/waivers/policies — local math is a fallback
  // while the request is in flight.
  const itemIdsKey = items.map((i) => i.id).join(',');
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
        supportCode: supportRef || undefined,
      })
      .then((data) => {
        if (seq !== quoteSeqRef.current) return;
        setQuote(data.quote);
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
        setQuote(null);
        setQuoteError(err instanceof Error ? err.message : 'quote failed');
      })
      .finally(() => {
        if (seq === quoteSeqRef.current) setQuoteLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAddressId, deliveryMethod, paymentMethod, usePoints, useWalletBalance, itemIdsKey, supportRef]);

  const walletBalanceIQD = usdCentsToIqd(balanceUsdCents, exchangeRate);

  const getMethodIcon = (iconName: string, className: string = "w-5 h-5") => {
    switch (iconName) {
      case 'Truck': return <Truck className={className} strokeWidth={1.5} />;
      case 'Store': return <Store className={className} strokeWidth={1.5} />;
      case 'CreditCard': return <CreditCard className={className} strokeWidth={1.5} />;
      case 'Wallet': return <Wallet className={className} strokeWidth={1.5} />;
      case 'Banknote': return <Banknote className={className} strokeWidth={1.5} />;
      default: return <CheckCircle2 className={className} strokeWidth={1.5} />;
    }
  };

  // Preview math mirrors the server's order pricing (worker/routes/orders.ts):
  // subtotal + delivery, minus points, then wallet. The authoritative amounts
  // come from the server quote whenever one is loaded; the order itself is
  // always recomputed server-side when placed.
  const total = items.reduce((sum, item) => sum + item.unit_price_iqd * item.qty, 0);
  const selectedDelivery = checkoutDeliveryMethods.find(m => m.id === deliveryMethod);
  const deliveryPrice = selectedDelivery?.price_iqd || 0;
  const shippingIqd = quote ? quote.shipping.total_iqd : deliveryPrice;
  const shippingWaived = !!quote && quote.shipping.total_iqd < quote.shipping.total_before_waiver_iqd;
  const shippingNeedsConfig = !!quote && quote.shipping.needs_config.length > 0;
  const requiredPolicies = quote?.policies ?? [];
  const beforeDiscounts = total + shippingIqd;
  const pointsDiscount = usePoints ? Math.min(pointBalance, beforeDiscounts) : 0;
  const orderTotal = beforeDiscounts - pointsDiscount;

  // Advance payment logic
  let requiredAdvance = 0;
  if (paymentMethod === 'half_advance') requiredAdvance = Math.ceil(orderTotal / 2);
  if (paymentMethod === 'full_advance') requiredAdvance = orderTotal;
  const isAdvanceRequired = requiredAdvance > 0;

  // Force wallet usage if advance is required
  useEffect(() => {
    if (isAdvanceRequired) {
      setUseWalletBalance(true);
    }
  }, [isAdvanceRequired]);

  // Calculate wallet discount
  const isWalletActive = isAdvanceRequired || useWalletBalance;
  const walletDiscount = isWalletActive ? Math.min(walletBalanceIQD, orderTotal) : 0;

  // Verify if balance is sufficient for required advance
  const isBalanceSufficient = walletDiscount >= requiredAdvance;
  const consentSatisfied = requiredPolicies.length === 0 || policyAccepted;
  const canCompleteOrder =
    isBalanceSufficient && !submitting && items.length > 0 && !!selectedAddressId && !!deliveryMethod && !!paymentMethod &&
    !quoteLoading && !shippingNeedsConfig && consentSatisfied;

  const amountRemainingOnDelivery = orderTotal - walletDiscount;

  const placeOrder = async () => {
    if (!canCompleteOrder) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      const data = await api.post<{ order: ApiOrder; invoice_no?: string | null }>('/api/orders', {
        addressId: selectedAddressId,
        deliveryMethodId: deliveryMethod,
        paymentMethodId: paymentMethod,
        useWallet: isWalletActive,
        usePoints,
        itemIds: items.map((i) => i.id),
        idempotencyKey: idempotencyKeyRef.current,
        // §3.3: attribution only — the server answers with the frozen
        // support snapshot and an unchanged total.
        supportCode: supportRef || undefined,
        // Versioned consent (§7): only sent once the customer explicitly
        // checked the unchecked-by-default box for these exact versions.
        policyAcceptance: policyAccepted
          ? requiredPolicies.map((p) => ({ key: p.key, version: p.version }))
          : [],
      });
      setPlacedInvoiceNo(data.invoice_no ?? null);
      setPlacedOrder(data.order);
      refreshWallet().catch(() => {});
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        navigate('/auth');
        return;
      }
      const msg = err instanceof Error ? err.message : 'Order could not be placed. Please try again.';
      if (err instanceof ApiError && err.code === 'INSUFFICIENT_BALANCE') {
        setSubmitError(dir === 'rtl' ? `الرصيد غير كافٍ للدفع المقدم المطلوب — ${msg}` : msg);
      } else if (err instanceof ApiError && err.code === 'POLICY_ACCEPTANCE_REQUIRED') {
        setPolicyAccepted(false);
        setConsentResetNote(true);
        setSubmitError(S.policyRequired);
      } else if (err instanceof ApiError && err.code === 'SHIPPING_NEEDS_CONFIG') {
        setSubmitError(S.needsConfig);
      } else {
        setSubmitError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const itemName = (item: CartItem) => (lang === 'ar' && item.name_ar ? item.name_ar : item.name);

  // Versioned-policy consent block (§7): unchecked by default, links to the
  // published documents, resets on material quote changes. Rendered above
  // both CTAs. Nothing renders while no policy is published (honest empty).
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
                  href={`/policies/${p.key}`}
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
      <div className="w-full min-h-screen bg-[#030303] text-white flex flex-col font-sans selection:bg-white/20">
        <div className="flex-1 flex flex-col items-center justify-center p-6 text-center animate-in fade-in zoom-in-95 duration-700">
          <div className="w-24 h-24 mb-8 relative flex items-center justify-center">
            <div className="absolute inset-0 bg-white/20 rounded-full animate-ping opacity-50" />
            <div className="relative w-16 h-16 bg-white rounded-full flex items-center justify-center">
              <Check className="w-8 h-8 text-black" strokeWidth={3} />
            </div>
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
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#030303] text-white flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-white/40 border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!loading && items.length === 0) {
    return (
      <div className="min-h-screen bg-[#030303] text-white flex flex-col items-center justify-center p-6 text-center font-sans">
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
    <div className="min-h-screen bg-[#030303] text-white font-sans selection:bg-white/20 flex flex-col lg:flex-row">

      {/* Left Form Area */}
      <div className="flex-1 flex flex-col lg:max-h-screen lg:overflow-y-auto custom-scrollbar relative z-10">
        <header className="px-6 lg:px-12 py-8 flex items-center justify-between sticky top-0 bg-[#030303]/90 backdrop-blur-xl z-20 border-b border-white/5 lg:border-none">
          <button
            onClick={handleBack}
            className="w-10 h-10 rounded-full flex items-center justify-center hover:bg-white/10 transition-colors border border-white/10 bg-white/5"
          >
            {dir === 'rtl' ? <ArrowRight className="w-5 h-5 text-white" strokeWidth={1.5} /> : <ArrowLeft className="w-5 h-5 text-white" strokeWidth={1.5} />}
          </button>
          <div className="flex items-center gap-2 text-zinc-400 bg-white/5 px-4 py-2 rounded-full border border-white/5">
            <Lock className="w-4 h-4" strokeWidth={1.5} />
            <span className="text-xs font-semibold tracking-widest uppercase">
              {dir === 'rtl' ? 'دفع آمن' : 'Secure Checkout'}
            </span>
          </div>
        </header>

        <div className="px-6 lg:px-12 py-4 max-w-3xl mx-auto w-full space-y-12 pb-32 lg:pb-16">

          <div>
            <h1 className="text-2xl lg:text-3xl font-medium tracking-tight mb-2">
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
                <label key={addr.id} className={`relative p-4 rounded-xl border cursor-pointer transition-all flex flex-col gap-2 ${
                    selectedAddressId === addr.id ? 'border-white bg-white/5 shadow-[0_0_15px_rgba(255,255,255,0.05)]' : 'border-white/5 bg-[#0a0a0a] hover:border-white/20'
                }`}>
                  <input type="radio" name="address" className="sr-only" checked={selectedAddressId === addr.id} onChange={() => setSelectedAddressId(addr.id)} />
                  <div className="flex justify-between items-start">
                    <div className="flex items-center gap-2">
                      <MapPin className={`w-4 h-4 ${selectedAddressId === addr.id ? 'text-white' : 'text-zinc-500'}`} strokeWidth={1.5} />
                      <span className="font-normal text-white text-base">{addr.label}</span>
                    </div>
                    <div className={`w-4 h-4 rounded-full border flex items-center justify-center transition-colors ${selectedAddressId === addr.id ? 'border-white' : 'border-zinc-700'}`}>
                      {selectedAddressId === addr.id && <div className="w-2 h-2 rounded-full bg-white" />}
                    </div>
                  </div>
                  <p className="text-xs text-zinc-500 leading-relaxed pl-1 font-light">
                    {addr.name} — {addr.phone}
                    <br />
                    {addr.address}
                    {addr.landmark ? ` (${addr.landmark})` : ''}
                  </p>
                </label>
              ))}
              <button
                onClick={() => navigate('/addresses')}
                className="relative p-4 rounded-xl border border-dashed border-white/10 bg-transparent hover:bg-white/5 hover:border-white/20 transition-all flex flex-col items-center justify-center gap-2 text-zinc-500 hover:text-white min-h-[100px]"
              >
                <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center">
                  <Plus className="w-4 h-4" strokeWidth={1.5} />
                </div>
                <span className="text-xs font-normal">{dir === 'rtl' ? 'إضافة عنوان جديد' : 'Add New Address'}</span>
              </button>
            </div>
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
              {checkoutDeliveryMethods.map(method => (
                <label key={method.id} className={`relative p-4 rounded-xl border cursor-pointer transition-all flex items-center gap-4 ${
                  deliveryMethod === method.id ? 'border-white bg-white/5 shadow-[0_0_15px_rgba(255,255,255,0.05)]' : 'border-white/5 bg-[#0a0a0a] hover:border-white/20'
                }`}>
                  <input type="radio" name="delivery" className="sr-only" checked={deliveryMethod === method.id} onChange={() => setDeliveryMethod(method.id)} />
                  <div className="flex-1 flex justify-between items-center">
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 transition-colors ${deliveryMethod === method.id ? 'bg-white text-black' : 'bg-zinc-900 text-zinc-400'}`}>
                        {getMethodIcon(method.icon || '', "w-5 h-5")}
                      </div>
                      <div>
                        <h3 className={`font-normal text-base ${deliveryMethod === method.id ? 'text-white' : 'text-zinc-300'}`}>
                          {dir === 'rtl' ? method.titleAr : method.titleEn}
                        </h3>
                        <p className="text-xs text-zinc-500 mt-0.5 font-light">{dir === 'rtl' ? method.descAr : method.descEn}</p>
                      </div>
                    </div>
                    <span className={`font-medium text-sm ${method.price_iqd === 0 ? 'text-emerald-400' : 'text-white'}`}>
                      {method.price_iqd === 0 ? (dir === 'rtl' ? 'مجاناً' : 'Free') : formatIqd(method.price_iqd)}
                    </span>
                  </div>
                  <div className={`w-4 h-4 rounded-full border flex items-center justify-center transition-colors shrink-0 ml-2 ${deliveryMethod === method.id ? 'border-white' : 'border-zinc-700'}`}>
                    {deliveryMethod === method.id && <div className="w-2 h-2 rounded-full bg-white" />}
                  </div>
                </label>
              ))}
            </div>
          </section>

          {/* Section: Payment Method */}
          <section>
            <h2 className="text-xl font-normal text-white flex items-center gap-3 mb-5">
              <span className="w-6 h-6 rounded bg-white text-black flex items-center justify-center text-xs font-medium">3</span>
              {dir === 'rtl' ? 'طريقة الدفع' : 'Payment Method'}
            </h2>
            <div className="grid grid-cols-1 gap-3">
              {filteredPaymentMethods.map(method => (
                <label key={method.id} className={`relative p-4 rounded-xl border cursor-pointer transition-all flex items-center gap-4 ${
                  paymentMethod === method.id ? 'border-white bg-white/5 shadow-[0_0_15px_rgba(255,255,255,0.05)]' : 'border-white/5 bg-[#0a0a0a] hover:border-white/20'
                }`}>
                  <input type="radio" name="payment" className="sr-only" checked={paymentMethod === method.id} onChange={() => setPaymentMethod(method.id)} />
                  <div className="flex-1 flex items-center gap-4">
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 transition-colors ${paymentMethod === method.id ? 'bg-white text-black' : 'bg-zinc-900 text-zinc-400'}`}>
                      {getMethodIcon(method.icon || '', 'w-5 h-5')}
                    </div>
                    <div>
                      <h3 className={`font-normal text-base ${paymentMethod === method.id ? 'text-white' : 'text-zinc-300'}`}>
                          {dir === 'rtl' ? method.titleAr : method.titleEn}
                      </h3>
                    </div>
                  </div>
                  <div className={`w-4 h-4 rounded-full border flex items-center justify-center transition-colors shrink-0 ${paymentMethod === method.id ? 'border-white' : 'border-zinc-700'}`}>
                      {paymentMethod === method.id && <div className="w-2 h-2 rounded-full bg-white" />}
                  </div>
                </label>
              ))}
            </div>
          </section>

          {/* Mobile CTA */}
          <div className="pt-6 lg:hidden">
            {consentBlock}
            <button
              onClick={placeOrder}
              disabled={!canCompleteOrder}
              className="w-full bg-white text-black hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed font-normal py-4 rounded-xl transition-all text-base shadow-[0_0_20px_rgba(255,255,255,0.05)]"
            >
              {submitting
                ? (dir === 'rtl' ? 'جارٍ تأكيد الطلب...' : 'Placing Order...')
                : (dir === 'rtl' ? 'تأكيد الطلب' : 'Place Order')}
            </button>
            {submitError && (
              <p className="text-center text-sm text-red-400 mt-4 font-medium flex items-center justify-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {submitError}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Right Summary Area */}
      <div className="w-full lg:w-[460px] bg-[#0a0a0a] lg:border-l border-white/5 flex flex-col shrink-0 relative z-20">
        <div className="p-6 lg:p-10 lg:sticky lg:top-0 lg:h-screen flex flex-col">

          <h2 className="text-xl font-normal text-white flex items-center gap-3 mb-6">
            <Receipt className="w-5 h-5 text-zinc-400" strokeWidth={1.5} />
            {dir === 'rtl' ? 'ملخص الطلب' : 'Order Summary'}
          </h2>

          <div className="flex-1 overflow-y-auto custom-scrollbar lg:pr-2 mb-8 space-y-3">
            {items.map(item => (
                <div key={item.id} className="flex gap-4 p-3 rounded-xl bg-[#050505] border border-white/5 relative overflow-hidden group">
                  <div className="w-16 h-16 rounded-lg bg-black overflow-hidden relative shrink-0 border border-white/5">
                    {item.image ? (
                      <img referrerPolicy="no-referrer" src={item.image} alt={itemName(item)} className="w-full h-full object-cover opacity-80 group-hover:scale-110 transition-transform duration-500" />
                    ) : (
                      <div className="w-full h-full bg-zinc-900" />
                    )}
                    <span className="absolute top-1 right-1 w-5 h-5 bg-white text-black rounded flex items-center justify-center text-[10px] font-medium shadow-md">{item.qty}</span>
                  </div>
                  <div className="flex-1 min-w-0 flex flex-col justify-center">
                    <h4 className="text-sm font-normal text-white line-clamp-1 mb-0.5">{itemName(item)}</h4>
                    {item.variantLabel && (
                      <p className="text-xs text-zinc-500 mb-1.5 font-light">{item.variantLabel}</p>
                    )}
                    <span className="text-sm font-medium text-white">{formatIqd(item.unit_price_iqd * item.qty)}</span>
                  </div>
                </div>
            ))}
          </div>

          <div className="space-y-4 pt-6 border-t border-white/5 mt-auto text-sm">
            <div className="flex justify-between items-center text-zinc-400">
              <span className="font-light">{dir === 'rtl' ? 'المجموع الفرعي' : 'Subtotal'}</span>
              <span className="text-white font-normal">{formatIqd(total)}</span>
            </div>
            <div className="flex justify-between items-center text-zinc-400">
              <span className="font-light">{dir === 'rtl' ? 'الشحن' : 'Shipping'}</span>
              {quoteLoading ? (
                <span className="text-zinc-500 font-light text-xs">{S.quoteLoading}</span>
              ) : shippingIqd === 0 ? (
                <span className="text-emerald-400 font-normal">
                  {shippingWaived && quote && quote.shipping.total_before_waiver_iqd > 0 && (
                    <span className="text-zinc-500 line-through font-light mx-2 text-xs">
                      {formatIqd(quote.shipping.total_before_waiver_iqd)}
                    </span>
                  )}
                  {S.freeShipping}
                </span>
              ) : (
                <span className="text-white font-normal">{formatIqd(shippingIqd)}</span>
              )}
            </div>

            {/* Server quote transparency: WHY a fee/waiver applies (§6.3). */}
            {quote && quote.shipping.reasons.length > 0 && (
              <div className="rounded-lg bg-white/[0.03] border border-white/5 p-3 space-y-1">
                <div className="text-[11px] uppercase tracking-widest text-zinc-500">{S.whyTitle}</div>
                {quote.shipping.reasons.map((r, i) => (
                  <p key={i} className="text-xs text-zinc-400 font-light leading-relaxed">{r}</p>
                ))}
              </div>
            )}
            {quote && quote.shipping.advance_due_iqd > 0 && (
              <p className="text-xs text-amber-400/90 font-light flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
                {S.advanceDue(formatIqd(quote.shipping.advance_due_iqd))}
              </p>
            )}
            {shippingNeedsConfig && (
              <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 flex gap-2 text-amber-400">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
                <p className="text-xs leading-relaxed font-light">{S.needsConfig}</p>
              </div>
            )}
            {quoteError && !quoteLoading && (
              <p className="text-xs text-zinc-500 font-light flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
                {S.quoteError}
              </p>
            )}

            {pointsDiscount > 0 && (
              <div className="flex justify-between items-center text-emerald-400">
                <span className="font-light">{dir === 'rtl' ? 'خصم النقاط' : 'Points Discount'}</span>
                <span className="font-normal">-{formatIqd(pointsDiscount)}</span>
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

            {/* Wallet Block */}
            <div className={`mt-4 pt-4 border-t border-white/5 transition-all`}>
                <div className="flex items-center justify-between gap-4 mb-2">
                    <div className="flex items-center gap-3">
                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${isWalletActive ? 'bg-white text-black shadow-[0_0_10px_rgba(255,255,255,0.2)]' : 'bg-zinc-900 text-zinc-400'}`}>
                            <Wallet className="w-4 h-4" strokeWidth={1.5} />
                        </div>
                        <div>
                            <span className="font-normal text-white block text-sm">
                                {dir === 'rtl' ? 'استخدام المحفظة' : 'Use Wallet'}
                            </span>
                            <span className="text-xs text-zinc-500 font-light block">
                                {dir === 'rtl' ? 'الرصيد:' : 'Balance:'} <span className="text-zinc-300">{formatIqd(walletBalanceIQD)}</span>
                            </span>
                        </div>
                    </div>

                    <button
                        type="button"
                        role="switch"
                        aria-checked={isWalletActive}
                        disabled={isAdvanceRequired || walletBalanceIQD === 0}
                        onClick={() => setUseWalletBalance(!useWalletBalance)}
                        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                            isWalletActive ? 'bg-white' : 'bg-zinc-800'
                        } ${(isAdvanceRequired || walletBalanceIQD === 0) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
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
                            {dir === 'rtl'
                                ? 'الرصيد غير كافٍ للدفع المقدم.'
                                : 'Insufficient balance for advance.'}
                        </p>
                    </div>
                )}

                {!isAdvanceRequired && isWalletActive && walletDiscount > 0 && (
                     <div className="mt-3 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex gap-2 text-emerald-400">
                        <Sparkles className="w-4 h-4 shrink-0 mt-0.5" strokeWidth={1.5} />
                        <p className="text-xs leading-relaxed font-light">
                            {dir === 'rtl'
                                ? `خصم ${walletDiscount.toLocaleString()} د.ع`
                                : `-${walletDiscount.toLocaleString()} IQD deduction`}
                        </p>
                    </div>
                )}
            </div>

            {walletDiscount > 0 && (
              <div className="flex justify-between items-center text-emerald-400 bg-emerald-500/5 p-3 rounded-lg border border-emerald-500/10">
                <span className="flex items-center gap-2 font-normal text-sm"><Sparkles className="w-4 h-4" /> {dir === 'rtl' ? 'رصيد مستخدم' : 'Used Balance'}</span>
                <span className="font-medium text-sm">-{formatIqd(walletDiscount)}</span>
              </div>
            )}

            <div className="pt-6 border-t border-white/5 flex justify-between items-end mt-2">
              <div>
                <span className="text-white font-normal block mb-1 text-base">
                  {dir === 'rtl' ? 'المبلغ المستحق الدفع' : 'Amount Due'}
                </span>
                {amountRemainingOnDelivery > 0 && (
                  <span className="text-zinc-500 text-sm">
                    {dir === 'rtl' ? 'يدفع عند الاستلام' : 'To pay on delivery'}
                  </span>
                )}
                {amountRemainingOnDelivery === 0 && (
                  <span className="text-emerald-400 text-sm font-medium flex items-center gap-1">
                    <CheckCircle2 className="w-4 h-4" />
                    {dir === 'rtl' ? 'مدفوع بالكامل' : 'Fully Paid'}
                  </span>
                )}
              </div>
              <div className="text-right">
                <span className="text-3xl font-normal text-white tracking-tight">
                  {amountRemainingOnDelivery.toLocaleString()} <span className="text-lg text-zinc-500 font-light ml-1">د.ع</span>
                </span>
              </div>
            </div>
          </div>

          <div className="pt-8 hidden lg:block">
            {consentBlock}
            <button
              onClick={placeOrder}
              disabled={!canCompleteOrder}
              className="w-full bg-white text-black hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed font-normal py-4 rounded-xl transition-all text-base shadow-[0_0_20px_rgba(255,255,255,0.05)]"
            >
              {submitting
                ? (dir === 'rtl' ? 'جارٍ تأكيد الطلب...' : 'Placing Order...')
                : (dir === 'rtl' ? 'تأكيد الطلب' : 'Place Order')}
            </button>
            {submitError && (
              <p className="text-center text-sm text-red-400 mt-4 font-medium flex items-center justify-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {submitError}
              </p>
            )}
            {!submitError && !isBalanceSufficient && (
              <p className="text-center text-sm text-red-400 mt-4 font-medium flex items-center justify-center gap-2">
                <AlertCircle className="w-4 h-4" />
                {dir === 'rtl' ? 'الرصيد غير كافٍ لإتمام الدفع' : 'Insufficient balance'}
              </p>
            )}
            {requiredPolicies.length === 0 && (
              <p className="text-center text-xs text-zinc-600 mt-5 max-w-xs mx-auto leading-relaxed">
                {S.implicitNote}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
