import { MotionCharacterHome } from '../components/bloub/MotionCharacterAnchor';
import OrderCelebration from '../components/bloub/OrderCelebration';
/**
 * Checkout for a MERCHANT-STORE cart — /store-checkout on both apps.
 *
 * The platform checkout resolves membership tiers, transports, warranties and
 * points; none of that applies to a merchant's own goods, so this page talks
 * to /api/store-orders instead (§74). What it shares with the platform is
 * exactly what is genuinely shared: the address book, the wallet, and the one
 * order history.
 *
 * EVERY NUMBER COMES FROM THE QUOTE. The client sends a coupon code and an
 * address id; prices, delivery and the discount are computed server-side and
 * rendered here verbatim.
 *
 * THE ORDER IS THE QUOTE THE CUSTOMER SAW (audit 02 B12). Placing it sends the
 * quote's fingerprint back; if anything that costs money moved in between, the
 * server refuses `409 QUOTE_CHANGED` with the fresh quote, and this screen
 * names the old and the new total and asks for the new one to be confirmed.
 * The checkout key follows the agreement: the same total reuses it — a double
 * tap cannot buy twice — and a new total mints a new one.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Check, Loader2, MapPin, Plus, Store, Tag, Wallet as WalletIcon, ShoppingBag,
} from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { api, ApiError, type ApiAddress } from '../lib/api';
import { storeCheckoutApi, iqd, type StoreQuote } from '../lib/merchant';
import { apiRefusal } from '../lib/refusalStrings';
import { useFreshOnReturn } from '../lib/useFreshOnReturn';
import AddressForm from '../components/address/AddressForm';
import { useStore } from '../StoreContext';
import { useBusy } from '../lib/busy';
import { mascot } from '../lib/mascot';

/** A fresh checkout key — one per agreed quote (see `keyFor`). */
const newCheckoutKey = () => `sc-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;

/** Refusals whose remedy is in the cart, not on this screen. */
const CART_REMEDY = new Set([
  'OUT_OF_STOCK',
  'PRODUCT_UNAVAILABLE',
  'OPTION_UNAVAILABLE',
  'CART_SELLER_CONFLICT',
  'CART_EMPTY',
  'STORE_CLOSED',
  'OWN_STORE_PURCHASE',
]);

export default function StoreCheckout() {
  const { loc, dir, lang } = useLanguage();
  const navigate = useNavigate();
  const { store: hostStore } = useStore();

  const [quote, setQuote] = useState<StoreQuote | null>(null);
  const [quoteError, setQuoteError] = useState('');
  const [addresses, setAddresses] = useState<ApiAddress[] | null>(null);
  const [addressId, setAddressId] = useState('');
  const [addingAddress, setAddingAddress] = useState(false);
  const [couponInput, setCouponInput] = useState('');
  const [coupon, setCoupon] = useState('');
  const [couponError, setCouponError] = useState('');
  const [placing, setPlacing] = useState(false);
  /**
   * THE SECOND ORDER DOOR GETS THE SAME BLOCKING WAIT AS THE FIRST.
   *
   * This page has its own `POST /api/store-orders` and its own inline
   * `Loader2`, and an inline spinner inside a button protects that button and
   * nothing else — not the header, not the bottom navigation, not a link in
   * the summary above it. `placing` is already the authority (the button is
   * disabled on it and it is cleared in the request's own settlement); the
   * overlay only makes the refusal cover the whole screen. It is not a
   * precondition for placing: the idempotency key — one per agreed quote,
   * `keyFor` below — stays the real duplicate guard, as the header says.
   */
  useBusy(placing, 'order');
  const [placeError, setPlaceError] = useState('');
  /** What the customer can do about `placeError`, when there is something. */
  const [placeRemedy, setPlaceRemedy] = useState<'topup' | 'cart' | null>(null);
  const [done, setDone] = useState<string | null>(null);
  /**
   * THE TOTAL MOVED UNDER THE CUSTOMER — said, never absorbed (B12).
   *
   * Set when place-order answers QUOTE_CHANGED, and when a background
   * re-quote (not the customer's own coupon change) comes back with a
   * different total. The bar above the button names both figures and the
   * button asks for the NEW one to be confirmed.
   */
  const [priceMoved, setPriceMoved] = useState<{ from: number; to: number } | null>(null);
  const quoteRef = useRef<StoreQuote | null>(null);
  quoteRef.current = quote;

  /**
   * THE RE-QUOTE HAD NO WAIT AT ALL, AND «تأكيد الطلب» STAYED LIVE THROUGH IT.
   *
   * Applying or removing a coupon, and the refresh on return, all re-price
   * the cart through `loadQuote` — and nothing marked the request in flight.
   * The Place button was enabled on the OLD quote, and `place()` sends the
   * `coupon` state, which only changes once the new quote lands: a customer
   * could confirm the total on screen while the server was about to price a
   * different one. Now the request is a state. While it is out, Place and the
   * coupon buttons are refused, and a re-quote the CUSTOMER asked for (the
   * coupon controls — never the silent refresh, which polls while the tab is
   * open) holds the screen as a `quote` wait, the same rule the platform
   * checkout follows.
   *
   * The sequence number is the other half: a refresh that set off before a
   * coupon was applied and answers after it must not put the old total back.
   */
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteAskedFor, setQuoteAskedFor] = useState(false);
  const quoteSeq = useRef(0);
  useBusy(quoteLoading && quote !== null && quoteAskedFor, 'quote');

  /**
   * ONE CHECKOUT KEY PER AGREEMENT, not per visit.
   *
   * A retry of the SAME quote — a double tap, a dropped connection — reuses
   * the key, so the server replays the order instead of placing a second one
   * and reuses the wallet reservation it already took. A DIFFERENT quote is a
   * different agreement and gets a new key: the server refuses a key it has
   * seen with another amount (IDEMPOTENCY_KEY_REUSED), so carrying the old one
   * forward would fail the corrected order.
   */
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const keyFor = (fingerprint: string) => {
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, key: newCheckoutKey() };
    return attempt.current.key;
  };

  const loadQuote = useCallback(
    async (code: string, askedFor = false) => {
      const seq = ++quoteSeq.current;
      setQuoteLoading(true);
      setQuoteAskedFor(askedFor);
      setCouponError('');
      try {
        const d = await storeCheckoutApi.quote(code);
        if (seq !== quoteSeq.current) return false;
        setQuote(d.quote);
        // A total that moved on its own is named; one the customer moved with
        // a coupon is theirs, and clears any older notice. (`quoteRef` still
        // holds the quote on screen until the next render.)
        const before = quoteRef.current;
        if (askedFor) setPriceMoved(null);
        else if (before && before.total_iqd !== d.quote.total_iqd) {
          setPriceMoved({ from: before.total_iqd, to: d.quote.total_iqd });
        }
        setCoupon(code);
        setQuoteError('');
        return true;
      } catch (e) {
        if (seq !== quoteSeq.current) return false;
        if (e instanceof ApiError && e.code === 'COUPON_INVALID') {
          setCouponError(loc('هذا الكود غير صالح لهذا الطلب', 'This code cannot be used on this order', 'ئەم کۆدە بەکارناهێت'));
          return false;
        }
        // The refusal's CODE, in the customer's language — never the server's
        // English sentence (src/lib/refusalStrings.ts).
        setQuoteError(apiRefusal(e, lang, loc('تعذّر تسعير السلة', 'Could not price the cart', 'نەتوانرا')));
        return false;
      } finally {
        if (seq === quoteSeq.current) setQuoteLoading(false);
      }
    },
    [lang, loc]
  );

  useEffect(() => {
    loadQuote('');
    api
      .get<{ addresses: ApiAddress[] }>('/api/addresses')
      .then((d) => {
        setAddresses(d.addresses);
        const def = d.addresses.find((a) => a.is_default) ?? d.addresses[0];
        if (def) setAddressId(def.id);
      })
      .catch(() => setAddresses([]));
  }, [loadQuote]);

  // The merchant order is re-quoted when the customer comes back to this
  // screen, for the same reason the platform checkout is: the total on the
  // button is the number they are about to agree to, and a shop that changed
  // a price while the tab sat open must not be held to the old one. The
  // coupon in force is carried through, and nothing runs mid-submit — nor
  // while a quote is already out: the refresh would take the newest sequence
  // number with the OLD coupon and silently discard the one being applied.
  const couponRef = useRef('');
  couponRef.current = coupon;
  const quoteLoadingRef = useRef(false);
  quoteLoadingRef.current = quoteLoading;
  useFreshOnReturn(async () => {
    if (quoteLoadingRef.current) return;
    await loadQuote(couponRef.current);
  }, {
    enabled: !placing && !quoteLoading,
    minIntervalMs: 8_000,
    pollWhileVisibleMs: 60_000,
  });

  async function place() {
    // `quoteLoading` too: the total on the button is about to change.
    if (!addressId || !quote || quoteLoading) return;
    // The quote on screen IS the agreement: its fingerprint, its coupon, its key.
    const agreed = quote;
    setPlacing(true);
    setPlaceError('');
    setPlaceRemedy(null);
    try {
      const r = await storeCheckoutApi.place({
        addressId,
        idempotencyKey: keyFor(agreed.quote_fingerprint),
        quoteFingerprint: agreed.quote_fingerprint,
        ...(agreed.coupon_code ? { couponCode: agreed.coupon_code } : {}),
      });
      setPriceMoved(null);
      setDone(String(r.order.id));
      // The same moment the platform checkout names: the order went through.
      // The confirmation below raises the stage the character appears on.
      mascot.outcome('ordered');
    } catch (e) {
      const code = e instanceof ApiError ? e.code ?? '' : '';
      if (code === 'QUOTE_CHANGED') {
        // Nothing was charged. The refusal carries the fresh quote: show it,
        // name both totals, and let the customer confirm the new one — a new
        // agreement, so the next tap sends a new key.
        const fresh = e instanceof ApiError ? (e.details?.quote as StoreQuote | undefined) : undefined;
        if (fresh && typeof fresh.quote_fingerprint === 'string') {
          quoteSeq.current += 1; // a re-quote still in flight is older than this one
          setQuoteLoading(false);
          setQuote(fresh);
          setCoupon(fresh.coupon_code || '');
          setPriceMoved({ from: agreed.total_iqd, to: fresh.total_iqd });
        } else {
          setPlaceError(apiRefusal(e, lang, loc('تعذّر إتمام الطلب', 'Could not place the order', 'نەتوانرا')));
          void loadQuote(coupon);
        }
        return;
      }
      if (code === 'IDEMPOTENCY_KEY_REUSED') {
        // This key is spent — a reservation for another figure, or one already
        // handed back. A fresh key and a fresh quote, and then the customer
        // taps again: never a second charge attempt nobody asked for.
        attempt.current = null;
        setPlaceError(
          // OWNER: Sorani to be written by hand.
          loc(
            'لم تكتمل المحاولة السابقة. راجع الإجمالي ثم أكّد الطلب من جديد.',
            'The previous attempt did not complete. Review the total, then place the order again.'
          )
        );
        void loadQuote(coupon);
        return;
      }
      if (code === 'INSUFFICIENT_FUNDS') {
        setPlaceError(
          loc(
            'رصيد محفظتك لا يغطي هذا الطلب. اشحن المحفظة ثم أكمل الطلب.',
            'Your wallet balance does not cover this order. Top up, then finish the order.',
            'باڵانسی جزدانەکەت بەش ناکات. پڕی بکەرەوە.'
          )
        );
        setPlaceRemedy('topup');
        return;
      }
      setPlaceError(apiRefusal(e, lang, loc('تعذّر إتمام الطلب', 'Could not place the order', 'نەتوانرا')));
      if (CART_REMEDY.has(code)) setPlaceRemedy('cart');
    } finally {
      setPlacing(false);
    }
  }

  /**
   * The one action that changes a short balance — and it has to leave this
   * hostname to do it.
   *
   * A merchant subdomain serves the storefront app, which routes the cart,
   * the checkout and the order history but NOT the wallet (§94). A relative
   * `/wallet` from there falls through to the shop's catch-all, so the link
   * the customer needs most would quietly land them back in the catalogue.
   * The server hands us the absolute url; on the main site we keep the
   * in-app navigation, because a full page load there would throw the
   * checkout away for no reason.
   */
  function topUpLink(label: string) {
    const cls =
      'lv-button lv-button-ghost min-h-11 mt-1.5 text-[12px] font-bold text-gold';
    return hostStore ? (
      <a href={quote?.wallet_topup_url ?? '/wallet'} className={cls}>
        {label}
      </a>
    ) : (
      <Link to="/wallet" className={cls}>
        {label}
      </Link>
    );
  }

  if (done) {
    return (
      <div className="h-full min-h-0 overflow-y-auto bg-canvas flex items-center justify-center px-6">
        <div className="text-center max-w-sm">
          {/* The same success moment as the platform checkout: the character
              appears on this stage and celebrates, with the burst behind it
              (src/components/bloub/OrderCelebration.tsx). It replaces a static
              green tick — the heading below still says it in words. */}
          <div className="mb-6 flex items-center justify-center">
            <OrderCelebration />
          </div>
          <h1 className="text-white font-bold text-[17px] mb-1.5">
            {loc('تم استلام طلبك', 'Your order is in', 'داواکاریەکەت وەرگیرا')}
          </h1>
          <p className="text-zinc-500 text-[12.5px] mb-1" dir="ltr">{done}</p>
          <p className="text-zinc-400 text-[12.5px] mb-6">
            {loc(
              'المتجر استلم طلبك وسيبدأ بتجهيزه. تابع حالته من طلباتك.',
              'The store received your order and will start preparing it. Track it in your orders.',
              'فرۆشگاکە داواکاریەکەتی وەرگرت.'
            )}
          </p>
          <Link
            to="/orders"
            className="lv-button lv-button-primary"
          >
            <ShoppingBag className="w-4 h-4" />
            {loc('طلباتي', 'My orders', 'داواکاریەکانم')}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 bg-canvas text-text-secondary flex flex-col">
      <div className="lv-character-header shrink-0 bg-canvas/96 backdrop-blur border-b border-border-subtle/70 px-3 sm:px-4 py-2 flex items-center gap-3">
        <button type="button" aria-label={loc('رجوع', 'Back', 'گەڕانەوە')} onClick={() => navigate(-1)} className="w-11 h-11 rounded-md flex items-center justify-center text-text-secondary hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
          <ArrowLeft className={`w-4 h-4 ${dir === 'rtl' ? 'rotate-180' : ''}`} />
        </button>
        <MotionCharacterHome busy={!quote && !quoteError} />
        <h1 className="text-white font-bold text-[15px]">{loc('إتمام الطلب', 'Checkout', 'تەواوکردنی داواکاری')}</h1>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain w-full">
      <div className="max-w-2xl mx-auto px-3 sm:px-6 py-4 space-y-3">
        {quoteError && (
          <div className="lv-alert lv-alert-danger">
            <p className="text-text-secondary text-[12.5px]">{quoteError}</p>
            <Link to="/cart" className="text-gold text-[12px] font-bold mt-1 inline-block">
              {loc('العودة إلى السلة', 'Back to the cart', 'گەڕانەوە بۆ سەبەتە')}
            </Link>
          </div>
        )}

        {!quote && !quoteError && (
          <div role="status" className="py-16 flex flex-col items-center justify-center gap-3 text-text-muted">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-xs">{loc('جارٍ تجهيز دفع المتجر…', 'Preparing store checkout…', 'ئامادەکردنی پارەدان…')}</span>
          </div>
        )}

        {quote && (
          <>
            <section className="lv-surface p-3.5">
              <div className="flex items-center gap-2 mb-2.5">
                <Store className="w-4 h-4 text-gold" />
                <h2 className="text-white font-bold text-[13px]">{quote.store_name}</h2>
              </div>
              <div className="space-y-2">
                {quote.lines.map((l) => (
                  <div key={l.cart_item_id} className="flex items-center gap-2.5 text-[12.5px]">
                    <div className="w-10 h-10 rounded-lg bg-black/40 overflow-hidden shrink-0">
                      {l.image && <img src={l.image} alt="" className="w-full h-full object-cover" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-zinc-200 truncate">{l.name}</p>
                      {/* The option the store will prepare, in the store's own words. */}
                      {l.variant && <p className="text-zinc-500 text-[11px] truncate">{l.variant}</p>}
                    </div>
                    <span className="text-zinc-500 shrink-0" dir="ltr">×{l.qty}</span>
                    <span className="text-zinc-200 font-semibold shrink-0" dir="ltr">{iqd(l.line_total_iqd)}</span>
                  </div>
                ))}
              </div>
            </section>

            {/* Delivery address — the platform's own address book. */}
            <section className="lv-surface p-3.5">
              <div className="flex items-center justify-between mb-2.5">
                <h2 className="text-white font-bold text-[13px] flex items-center gap-1.5">
                  <MapPin className="w-4 h-4 text-gold" />
                  {loc('عنوان التوصيل', 'Delivery address', 'ناونیشانی گەیاندن')}
                </h2>
                {!addingAddress && (
                  <button type="button" onClick={() => setAddingAddress(true)} className="lv-button lv-button-ghost min-h-9 px-2 text-[11.5px]">
                    <Plus className="w-3.5 h-3.5" />
                    {loc('عنوان جديد', 'New address', 'ناونیشانی نوێ')}
                  </button>
                )}
              </div>

              {addresses === null ? (
                <Loader2 className="w-4 h-4 text-gold animate-spin" />
              ) : addingAddress ? (
                <AddressForm
                  dense
                  defaultWhenFirst
                  onSaved={async (id) => {
                    setAddingAddress(false);
                    const d = await api.get<{ addresses: ApiAddress[] }>('/api/addresses');
                    setAddresses(d.addresses);
                    setAddressId(id);
                  }}
                  onCancel={() => setAddingAddress(false)}
                />
              ) : !addresses.length ? (
                <p className="text-zinc-500 text-[12px]">
                  {loc('أضف عنوانك الأول لإتمام الطلب.', 'Add your first address to finish the order.', 'ناونیشانێک زیاد بکە.')}
                </p>
              ) : (
                <div className="space-y-2">
                  {addresses.map((a) => (
                    <button
                      type="button"
                      key={a.id}
                      onClick={() => setAddressId(a.id)}
                      aria-pressed={addressId === a.id}
                      data-selected={addressId === a.id}
                      className="lv-choice w-full text-start p-2.5"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className="lv-choice-mark"
                        >
                          <Check className="w-3 h-3" aria-hidden="true" />
                        </span>
                        <span className="text-white text-[12.5px] font-semibold">{a.label || a.name}</span>
                        <span className="text-zinc-500 text-[11px]" dir="ltr">{a.phone}</span>
                      </div>
                      <p className="text-zinc-400 text-[11.5px] mt-1 ps-6">{a.address}</p>
                    </button>
                  ))}
                </div>
              )}
            </section>

            {/*
              PAYMENT — A STATEMENT, NOT A CHOICE.
              This section used to offer two buttons, and "cash on delivery"
              was the one selected by default. It wrote the order as `cod`
              with the whole total due at the door — an order with nobody to
              collect it, because a merchant ships their own goods and
              Levonis holds neither their stock nor their cash. There is one
              way to pay here, so the screen says so and then answers the
              only question that is actually open: does the wallet cover it.
            */}
            <section className="lv-surface p-3.5">
              <h2 className="text-white font-bold text-[13px] mb-1.5 flex items-center gap-1.5">
                <WalletIcon className="w-4 h-4 text-gold" />
                {loc('الدفع من المحفظة', 'Paid from your wallet', 'پارەدان لە جزدان')}
              </h2>
              <p className="text-zinc-400 text-[11.5px] leading-[1.6] mb-2.5">
                {loc(
                  'طلبات متاجر المجتمع تُدفع مقدمًا. لا دفع عند الاستلام ولا استلام من المخزن.',
                  'Community-store orders are prepaid — no cash on delivery and no warehouse pickup.',
                  'داواکاری فرۆشگاکانی کۆمەڵگە پێشوەخت دەدرێن.'
                )}
              </p>
              <div className="flex items-center justify-between gap-2 text-[12.5px]">
                <span className="text-zinc-400">{loc('الرصيد المتاح', 'Available balance', 'باڵانسی بەردەست')}</span>
                <span
                  className={`font-bold tabular-nums ${quote.wallet_covers ? 'text-zinc-200' : 'text-amber-400'}`}
                  dir="ltr"
                >
                  {iqd(quote.wallet_available_iqd)}
                </span>
              </div>

              {!quote.wallet_covers && (
                <div className="mt-2.5 rounded-xl border border-amber-400/25 bg-amber-400/[0.07] p-2.5">
                  <p className="text-amber-300 text-[12px] font-semibold">
                    {loc('ينقصك', 'Short by', 'کەمته')}{' '}
                    <span dir="ltr" className="tabular-nums">{iqd(quote.wallet_shortfall_iqd)}</span>
                  </p>
                  {topUpLink(loc('شحن المحفظة', 'Top up the wallet', 'پڕکردنەوەی جزدان'))}
                </div>
              )}
            </section>

            {/* The store's own coupon. */}
            <section className="lv-surface p-3.5">
              <h2 className="text-white font-bold text-[13px] mb-2.5 flex items-center gap-1.5">
                <Tag className="w-4 h-4 text-gold" />
                {loc('كوبون المتجر', 'Store coupon', 'کۆبۆنی فرۆشگا')}
              </h2>
              {quote.coupon_code ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-emerald-400 text-[12.5px] font-bold" dir="ltr">
                    {quote.coupon_code} — {iqd(quote.discount_iqd)}
                  </span>
                  <button
                    onClick={() => {
                      setCouponInput('');
                      loadQuote('', true);
                    }}
                    disabled={quoteLoading}
                    className="text-zinc-500 text-[11.5px] font-bold"
                  >
                    {loc('إزالة', 'Remove', 'لابردن')}
                  </button>
                </div>
              ) : (
                <div>
                  <label htmlFor="store-coupon-code" className="mb-1.5 block text-xs text-text-muted">
                    {loc('رمز الكوبون', 'Coupon code', 'کۆدی کۆبۆن')}
                  </label>
                  <div className="flex gap-2">
                  <input
                    id="store-coupon-code"
                    value={couponInput}
                    onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
                    dir="ltr"
                    placeholder={loc('الكود', 'Code', 'کۆد')}
                    className="lv-input flex-1 min-w-0 text-[13px] font-mono"
                  />
                  <button
                    onClick={() => couponInput.trim() && loadQuote(couponInput.trim(), true)}
                    disabled={!couponInput.trim() || quoteLoading}
                    className="lv-button lv-button-secondary text-[12.5px]"
                  >
                    {loc('تطبيق', 'Apply', 'جێبەجێ')}
                  </button>
                  </div>
                </div>
              )}
              {couponError && <p role="alert" className="lv-field-error text-warning">{couponError}</p>}
            </section>

            {/* Totals — the server's numbers, verbatim. */}
            <section className="lv-surface p-3.5 space-y-1.5 text-[12.5px]">
              <div className="flex justify-between">
                <span className="text-zinc-400">{loc('المنتجات', 'Items', 'بەرهەمەکان')}</span>
                <span className="text-zinc-200" dir="ltr">{iqd(quote.subtotal_iqd)}</span>
              </div>
              {quote.discount_iqd > 0 && (
                <div className="flex justify-between text-emerald-400">
                  <span>{loc('خصم الكوبون', 'Coupon discount', 'داشکاندن')}</span>
                  <span dir="ltr">− {iqd(quote.discount_iqd)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-zinc-400">{loc('التوصيل', 'Delivery', 'گەیاندن')}</span>
                <span className="text-zinc-200" dir="ltr">
                  {quote.delivery_iqd === 0 ? (
                    <span className="text-emerald-400">{loc('مجاني', 'Free', 'بەخۆڕایی')}</span>
                  ) : (
                    iqd(quote.delivery_iqd)
                  )}
                </span>
              </div>
              <div className="h-px bg-white/10 my-1" />
              <div className="flex justify-between text-[14px]">
                <span className="text-white font-bold">{loc('الإجمالي', 'Total', 'کۆی گشتی')}</span>
                <span className="text-gold font-bold" dir="ltr">{iqd(quote.total_iqd)}</span>
              </div>
            </section>

          </>
        )}
      </div>
      </div>

      {quote && (
        <div className="shrink-0 border-t border-border-subtle/70 bg-surface-raised/98 px-3 sm:px-6 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="max-w-2xl mx-auto">
            {/* What changed, and what went wrong, are said HERE — beside the
                button the customer is about to press, not at the foot of a
                scroll area they may not be looking at. */}
            {priceMoved && (
              <p role="status" data-quote-changed className="lv-alert lv-alert-warning mb-2 text-[12px] leading-relaxed text-text-primary">
                {priceMoved.from === priceMoved.to ? (
                  // OWNER: Sorani to be written by hand.
                  loc('تغيّرت تفاصيل طلبك. راجعها ثم أكّد.', 'Your order details changed. Review them, then confirm.')
                ) : (
                  <>
                    {/* OWNER: Sorani to be written by hand. */}
                    {loc('تغيّر الإجمالي من', 'The total changed from')}{' '}
                    <bdi className="tabular-nums line-through opacity-70">{iqd(priceMoved.from)}</bdi>{' '}
                    {loc('إلى', 'to')} <bdi className="tabular-nums font-bold">{iqd(priceMoved.to)}</bdi>.{' '}
                    {loc('راجعه ثم أكّد الطلب.', 'Review it, then confirm.')}
                  </>
                )}
              </p>
            )}
            {placeError && (
              <div role="alert" className="lv-alert lv-alert-danger mb-2">
                <p className="text-text-secondary text-[12.5px]">{placeError}</p>
                {placeRemedy === 'topup' && topUpLink(loc('شحن المحفظة', 'Top up the wallet', 'پڕکردنەوەی جزدان'))}
                {placeRemedy === 'cart' && (
                  <Link to="/cart" className="text-gold text-[12px] font-bold mt-1 inline-block">
                    {loc('العودة إلى السلة', 'Back to the cart', 'گەڕانەوە بۆ سەبەتە')}
                  </Link>
                )}
              </div>
            )}
            {/* The wallet is the only way to pay here, so a balance that
                cannot cover the total is as blocking as a missing address —
                and is said in the same place, before the tap rather than
                after it. */}
            <button
              onClick={place}
              disabled={placing || quoteLoading || !addressId || !quote.wallet_covers}
              aria-busy={placing || quoteLoading}
              className="lv-button lv-button-primary w-full min-h-12 text-[14px]"
            >
              {placing || quoteLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              {priceMoved
                ? // OWNER: Sorani to be written by hand.
                  loc('تأكيد الإجمالي الجديد', 'Confirm the new total')
                : loc('تأكيد الطلب', 'Place the order', 'دووپاتکردنەوە')}
              <span dir="ltr">· {iqd(quote.total_iqd)}</span>
            </button>
            {!addressId ? (
              <p className="text-amber-400/90 text-[11px] text-center mt-1.5">
                {loc('اختر عنوان التوصيل أولًا', 'Choose a delivery address first', 'سەرەتا ناونیشان هەڵبژێرە')}
              </p>
            ) : !quote.wallet_covers ? (
              <p className="text-amber-400/90 text-[11px] text-center mt-1.5">
                {loc('اشحن المحفظة لإتمام الطلب', 'Top up the wallet to finish', 'جزدان پڕ بکەرەوە')}
              </p>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

/*
 * `NewAddressForm` LIVED HERE. It is now
 * `src/components/address/AddressForm.tsx`, shared with the platform checkout
 * and the address book.
 *
 * It was the third address form in the app, and the three agreed on nothing:
 * this one posted a raw phone with no country and let the governorate stay
 * empty, the address book prepended a literal `'+964-'` to whatever was typed,
 * and the platform checkout had no form at all — it pushed `/addresses` and
 * discarded every other choice the customer had made. One form, one set of
 * required fields, one contract with the server.
 */
