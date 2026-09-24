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
 * EVERY NUMBER COMES FROM THE QUOTE. The client sends a coupon code, an
 * address id and delivery-or-pickup; prices, delivery and the discount are
 * computed server-side and rendered here verbatim.
 *
 * DELIVERY BY GOVERNORATE (W2-A). The merchant prices their own delivery per
 * governorate; the server reads the chosen SAVED address, and every change of
 * address or of delivery/pickup re-quotes. An address the store does not
 * deliver to, one saved without a governorate, or no address at all comes back
 * as a refusal carrying the cart's summary (`DeliveryRefusal`): the goods stay
 * on screen, the panel says what to do, and there is no Place button to press.
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
  ArrowLeft, Check, Loader2, MapPin, Plus, Store, Tag, Truck, Wallet as WalletIcon, ShoppingBag,
} from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { api, ApiError, type ApiAddress } from '../lib/api';
import {
  storeCheckoutApi, iqd, DELIVERY_REFUSALS,
  type DeliveryRefusal, type Fulfilment, type StorePreview, type StoreQuote,
} from '../lib/merchant';
import CheckoutDeliveryPanel, { governorateText } from '../components/merchant/delivery/CheckoutDeliveryPanel';
import { Segmented } from '../components/ui/Segmented';
import { GOVERNORATES } from '../lib/governorates';
import { apiRefusal } from '../lib/refusalStrings';
import { useFreshOnReturn } from '../lib/useFreshOnReturn';
import AddressForm from '../components/address/AddressForm';
import { useStore } from '../StoreContext';
import { trackStoreEvent } from '../lib/storeBeacon';
import { useBusy } from '../lib/busy';
import { mascot } from '../lib/mascot';

const GOVERNORATE_IDS = new Set(GOVERNORATES.map((g) => g.id));

/** A refusal that asks for another address or fulfilment — the cart's summary rides along (W2-A). */
function deliveryRefusal(e: unknown): DeliveryRefusal | null {
  if (!(e instanceof ApiError)) return null;
  const code = e.code ?? '';
  if (!(DELIVERY_REFUSALS as readonly string[]).includes(code)) return null;
  const d = (e.details ?? {}) as Record<string, unknown>;
  if (!d.preview || typeof d.preview !== 'object') return null;
  return {
    code: code as DeliveryRefusal['code'],
    fulfilment: d.fulfilment === 'pickup' ? 'pickup' : 'delivery',
    address_id: typeof d.address_id === 'string' ? d.address_id : undefined,
    governorate: typeof d.governorate === 'string' ? d.governorate : undefined,
    reason: d.reason as DeliveryRefusal['reason'],
    served: Array.isArray(d.served) ? (d.served as string[]) : [],
    pickup: (d.pickup as DeliveryRefusal['pickup']) ?? null,
    preview: d.preview as StorePreview,
  };
}

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
  // Another tab placed (or emptied) this cart while this one was confirming.
  'CART_CHANGED',
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
  /**
   * DELIVERY BY GOVERNORATE (W2-A). `fulfilment` is the customer's choice
   * when the store offers pickup; `blocked` is the server's refusal for the
   * current choice (no address, no governorate, not delivered there), and
   * `preview` the cart summary it carried — shown in place of a quote, never
   * placeable. `editing` is a saved address being completed in place.
   */
  const [fulfilment, setFulfilment] = useState<Fulfilment>('delivery');
  const [blocked, setBlocked] = useState<DeliveryRefusal | null>(null);
  const [preview, setPreview] = useState<StorePreview | null>(null);
  const [editing, setEditing] = useState<ApiAddress | null>(null);
  const addressRef = useRef('');
  addressRef.current = addressId;
  const fulfilmentRef = useRef<Fulfilment>('delivery');
  fulfilmentRef.current = fulfilment;
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
  // First-party analytics (W2-E): reaching the store checkout, once per visitor per day.
  useEffect(() => trackStoreEvent(quote?.store_id, 'checkout_started'), [quote?.store_id]);

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
        // The attempt's own key rides along: a reservation a failed attempt
        // left behind is still this checkout's money, and the server counts
        // it back so the button is not disabled by it (review F6).
        const d = await storeCheckoutApi.quote(code, attempt.current?.key ?? '', {
          addressId: addressRef.current || undefined,
          fulfilment: fulfilmentRef.current,
        });
        if (seq !== quoteSeq.current) return false;
        setQuote(d.quote);
        setBlocked(null);
        setPreview(null);
        // The first quote priced the default address: that is the one selected.
        if (!addressRef.current && d.quote.delivery?.address_id) setAddressId(d.quote.delivery.address_id);
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
        // Not delivered there, no governorate, no address: the goods stay on
        // screen from the refusal's summary, and the panel asks for a change.
        const refused = deliveryRefusal(e);
        if (refused) {
          setQuote(null);
          setPreview(refused.preview);
          setBlocked(refused);
          setCoupon(refused.preview.coupon_code || '');
          setQuoteError('');
          if (!addressRef.current && refused.address_id) setAddressId(refused.address_id);
          if (refused.code === 'ADDRESS_REQUIRED') setAddingAddress(true);
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

  /** A different saved address — a new delivery answer, asked for by the customer. */
  function chooseAddress(id: string) {
    if (id === addressRef.current && !blocked) return;
    addressRef.current = id;
    setAddressId(id);
    void loadQuote(couponRef.current, true);
  }

  /** Delivery or pickup — only offered when the store offers pickup. */
  function chooseFulfilment(next: Fulfilment) {
    if (next === fulfilmentRef.current) return;
    fulfilmentRef.current = next;
    setFulfilment(next);
    void loadQuote(couponRef.current, true);
  }

  /** The address book again, after an address was added or completed here. */
  async function afterAddressSaved(id: string) {
    setAddingAddress(false);
    setEditing(null);
    const d = await api.get<{ addresses: ApiAddress[] }>('/api/addresses');
    setAddresses(d.addresses);
    addressRef.current = id;
    setAddressId(id);
    await loadQuote(couponRef.current, true);
  }

  async function place() {
    // `quoteLoading` too: the total on the button is about to change.
    if (!addressId || !quote || quoteLoading) return;
    // The quote on screen IS the agreement: its fingerprint, its coupon, its key,
    // and the address and fulfilment it priced.
    const agreed = quote;
    setPlacing(true);
    setPlaceError('');
    setPlaceRemedy(null);
    try {
      const r = await storeCheckoutApi.place({
        addressId: agreed.delivery?.address_id || addressId,
        fulfilment: agreed.delivery?.fulfilment ?? fulfilment,
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
      // The address or the store's delivery moved under the tap: not
      // delivered there any more, or the address lost its governorate.
      const refused = deliveryRefusal(e);
      if (refused) {
        setQuote(null);
        setPreview(refused.preview);
        setBlocked(refused);
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

  // What is on screen: the placeable quote, or the refusal's summary of the cart.
  const summary: StorePreview | null = quote ?? preview;
  const offer = quote?.delivery ?? blocked;
  const served = new Set(offer?.served ?? []);
  const pickupOffered = !!offer?.pickup;
  const merchandise = summary ? summary.subtotal_iqd - summary.discount_iqd : 0;

  return (
    <div className="h-full min-h-0 bg-canvas text-text-secondary flex flex-col">
      <div className="lv-character-header shrink-0 bg-canvas/96 backdrop-blur border-b border-border-subtle/70 px-3 sm:px-4 py-2 flex items-center gap-3">
        <button type="button" aria-label={loc('رجوع', 'Back', 'گەڕانەوە')} onClick={() => navigate(-1)} className="w-11 h-11 rounded-md flex items-center justify-center text-text-secondary hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
          <ArrowLeft className={`w-4 h-4 ${dir === 'rtl' ? 'rotate-180' : ''}`} />
        </button>
        <MotionCharacterHome busy={!summary && !quoteError} />
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

        {!summary && !quoteError && (
          <div role="status" className="py-16 flex flex-col items-center justify-center gap-3 text-text-muted">
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="text-xs">{loc('جارٍ تجهيز دفع المتجر…', 'Preparing store checkout…', 'ئامادەکردنی پارەدان…')}</span>
          </div>
        )}

        {summary && (
          <>
            <section className="lv-surface p-3.5">
              <div className="flex items-center gap-2 mb-2.5">
                <Store className="w-4 h-4 text-gold" />
                <h2 className="text-white font-bold text-[13px]">{summary.store_name}</h2>
              </div>
              <div className="space-y-2">
                {summary.lines.map((l) => (
                  <div key={l.cart_item_id} className="flex items-center gap-2.5 text-[12.5px]">
                    <div className="w-10 h-10 rounded-lg bg-black/40 overflow-hidden shrink-0">
                      {l.image && <img src={l.image} alt="" width={40} height={40} className="w-full h-full object-cover" />}
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

            {/* DELIVERY — the customer's own address book, and the store's own
                price for the governorate of the address chosen (W2-A). */}
            <section className="lv-surface p-3.5 space-y-3" aria-labelledby="store-delivery-title" data-store-delivery>
              <div className="flex items-center justify-between gap-2">
                <h2 id="store-delivery-title" className="text-white font-bold text-[13px] flex items-center gap-1.5">
                  <MapPin className="w-4 h-4 text-gold" aria-hidden="true" />
                  {fulfilment === 'pickup'
                    ? // OWNER: Sorani to be written by hand.
                      loc('الاستلام وبيانات التواصل', 'Pickup and contact')
                    : loc('عنوان التوصيل', 'Delivery address', 'ناونیشانی گەیاندن')}
                </h2>
                {!addingAddress && !editing && (
                  <button type="button" onClick={() => setAddingAddress(true)} className="lv-button lv-button-ghost min-h-11 px-2 text-[11.5px]">
                    <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                    {loc('عنوان جديد', 'New address', 'ناونیشانی نوێ')}
                  </button>
                )}
              </div>

              {/* Delivery or pickup: offered only when the store offers pickup. */}
              {pickupOffered && (
                <Segmented
                  group="store-fulfilment"
                  // OWNER: Sorani to be written by hand.
                  label={loc('طريقة الاستلام', 'How you get it')}
                  value={fulfilment}
                  onChange={(v) => chooseFulfilment(v as Fulfilment)}
                  items={[
                    { id: 'delivery', label: loc('توصيل', 'Delivery', 'گەیاندن'), icon: <Truck className="w-4 h-4" aria-hidden="true" /> },
                    // OWNER: Sorani to be written by hand.
                    { id: 'pickup', label: loc('من المتجر', 'Pickup'), icon: <Store className="w-4 h-4" aria-hidden="true" /> },
                  ]}
                />
              )}

              {addresses === null ? (
                <Loader2 className="w-4 h-4 text-gold animate-spin" aria-hidden="true" />
              ) : addingAddress || editing ? (
                <AddressForm
                  dense
                  defaultWhenFirst
                  initial={editing}
                  onSaved={(id) => void afterAddressSaved(id)}
                  onCancel={() => {
                    setAddingAddress(false);
                    setEditing(null);
                  }}
                />
              ) : !addresses.length ? (
                <p className="text-zinc-500 text-[12px]">
                  {loc('أضف عنوانك الأول لإتمام الطلب.', 'Add your first address to finish the order.', 'ناونیشانێک زیاد بکە.')}
                </p>
              ) : (
                <div className="space-y-2">
                  {addresses.map((a) => {
                    const gov = a.governorate && GOVERNORATE_IDS.has(a.governorate) ? a.governorate : '';
                    // Said on the address itself, before it is chosen: where the store delivers.
                    const notServed = fulfilment === 'delivery' && !!offer && !!gov && !served.has(gov);
                    return (
                      <button
                        type="button"
                        key={a.id}
                        onClick={() => chooseAddress(a.id)}
                        aria-pressed={addressId === a.id}
                        data-selected={addressId === a.id}
                        className="lv-choice w-full text-start p-2.5"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="lv-choice-mark">
                            <Check className="w-3 h-3" aria-hidden="true" />
                          </span>
                          <span className="text-white text-[12.5px] font-semibold truncate">{a.label || a.name}</span>
                          <span className="text-zinc-500 text-[11px] shrink-0" dir="ltr">{a.phone}</span>
                        </div>
                        <p className="text-zinc-400 text-[11.5px] mt-1 ps-6 break-words">
                          {gov ? <span className="text-text-secondary">{governorateText(gov, lang)}</span> : null}
                          {gov ? ' · ' : ''}
                          {a.address}
                        </p>
                        {!gov && fulfilment === 'delivery' && (
                          <p className="text-warning text-[11px] mt-1 ps-6">
                            {/* OWNER: Sorani to be written by hand. */}
                            {loc('بلا محافظة — أضفها لمعرفة أجرة التوصيل', 'No governorate — add it to price the delivery')}
                          </p>
                        )}
                        {notServed && (
                          <p className="text-text-muted text-[11px] mt-1 ps-6">
                            {/* OWNER: Sorani to be written by hand. */}
                            {loc('المتجر لا يوصل إلى هذه المحافظة', 'The store does not deliver here')}
                          </p>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}

              {!addingAddress && !editing && (
                <div aria-live="polite">
                  <CheckoutDeliveryPanel
                    delivery={quote?.delivery ?? null}
                    blocked={blocked}
                    merchandiseIqd={merchandise}
                    onChoosePickup={() => chooseFulfilment('pickup')}
                    onFixAddress={() => {
                      const a = addresses?.find((x) => x.id === (blocked?.address_id || addressId));
                      if (a) setEditing(a);
                    }}
                  />
                </div>
              )}
              {fulfilment === 'pickup' && quote && (
                <p className="text-text-muted text-[11.5px] leading-relaxed">
                  {/* OWNER: Sorani to be written by hand. */}
                  {loc(
                    'يتواصل المتجر معك على رقم هذا العنوان عندما يصبح طلبك جاهزًا.',
                    'The store contacts you on this address’s number when your order is ready.'
                  )}
                </p>
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
            {quote && (
            <section className="lv-surface p-3.5">
              <h2 className="text-white font-bold text-[13px] mb-1.5 flex items-center gap-1.5">
                <WalletIcon className="w-4 h-4 text-gold" />
                {loc('الدفع من المحفظة', 'Paid from your wallet', 'پارەدان لە جزدان')}
              </h2>
              <p className="text-zinc-400 text-[11.5px] leading-[1.6] mb-2.5">
                {/* OWNER: Sorani to be written by hand. */}
                {loc(
                  'طلبات متاجر المجتمع تُدفع مقدمًا من المحفظة، ولا دفع عند الاستلام.',
                  'Community-store orders are prepaid from your wallet — no cash on delivery.'
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
            )}

            {/* The store's own coupon. */}
            <section className="lv-surface p-3.5">
              <h2 className="text-white font-bold text-[13px] mb-2.5 flex items-center gap-1.5">
                <Tag className="w-4 h-4 text-gold" />
                {loc('كوبون المتجر', 'Store coupon', 'کۆبۆنی فرۆشگا')}
              </h2>
              {summary.coupon_code ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-emerald-400 text-[12.5px] font-bold" dir="ltr">
                    {summary.coupon_code} — {iqd(summary.discount_iqd)}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setCouponInput('');
                      loadQuote('', true);
                    }}
                    disabled={quoteLoading}
                    className="lv-button lv-button-ghost min-h-11 px-2 text-zinc-400 text-[11.5px] font-bold"
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
                    name="store-coupon-code"
                    autoComplete="off"
                    spellCheck={false}
                    value={couponInput}
                    onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
                    dir="ltr"
                    placeholder={loc('الكود', 'Code', 'کۆد')}
                    className="lv-input flex-1 min-w-0 text-[13px] font-mono"
                  />
                  <button
                    type="button"
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
                <span className="text-zinc-200 tabular-nums" dir="ltr">{iqd(summary.subtotal_iqd)}</span>
              </div>
              {summary.discount_iqd > 0 && (
                <div className="flex justify-between text-emerald-400">
                  <span>{loc('خصم الكوبون', 'Coupon discount', 'داشکاندن')}</span>
                  <span className="tabular-nums" dir="ltr">− {iqd(summary.discount_iqd)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-zinc-400">
                  {fulfilment === 'pickup'
                    ? // OWNER: Sorani to be written by hand.
                      loc('الاستلام من المتجر', 'Pickup')
                    : loc('التوصيل', 'Delivery', 'گەیاندن')}
                </span>
                <span className="text-zinc-200 tabular-nums" dir="ltr">
                  {!quote ? (
                    '—'
                  ) : quote.delivery_iqd === 0 ? (
                    <span className="text-emerald-400">{loc('مجاني', 'Free', 'بەخۆڕایی')}</span>
                  ) : (
                    iqd(quote.delivery_iqd)
                  )}
                </span>
              </div>
              <div className="h-px bg-white/10 my-1" />
              <div className="flex justify-between text-[14px]">
                <span className="text-white font-bold">{loc('الإجمالي', 'Total', 'کۆی گشتی')}</span>
                <span className="text-gold font-bold tabular-nums" dir="ltr">{quote ? iqd(quote.total_iqd) : '—'}</span>
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
              type="button"
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

      {/* NOTHING TO PLACE YET: the current address or choice is not one the
          store can deliver (W2-A). No live button — the reason, and the one
          thing that changes it, are in the delivery section above. */}
      {!quote && blocked && (
        <div data-store-checkout-blocked className="shrink-0 border-t border-border-subtle/70 bg-surface-raised/98 px-3 sm:px-6 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="max-w-2xl mx-auto">
            <button type="button" disabled aria-describedby="store-checkout-blocked-why" className="lv-button lv-button-primary w-full min-h-12 text-[14px]">
              {quoteLoading ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Check className="w-4 h-4" aria-hidden="true" />}
              {loc('تأكيد الطلب', 'Place the order', 'دووپاتکردنەوە')}
            </button>
            <p id="store-checkout-blocked-why" className="text-amber-400/90 text-[11px] text-center mt-1.5">
              {blocked.code === 'ADDRESS_REQUIRED'
                ? loc('أضف عنوانك الأول لإتمام الطلب.', 'Add your first address to finish the order.', 'ناونیشانێک زیاد بکە.')
                : blocked.code === 'ADDRESS_GOVERNORATE_REQUIRED'
                  ? // OWNER: Sorani to be written by hand.
                    loc('أضف المحافظة إلى العنوان أولًا', 'Add the governorate to the address first')
                  : blocked.reason === 'pickup_disabled'
                    ? // OWNER: Sorani to be written by hand.
                      loc('اختر التوصيل', 'Choose delivery')
                    : // OWNER: Sorani to be written by hand.
                      loc('اختر عنوانًا يوصل إليه المتجر', 'Choose an address the store delivers to')}
            </p>
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
