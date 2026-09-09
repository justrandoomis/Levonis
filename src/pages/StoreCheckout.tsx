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
 * rendered here verbatim. Placing the order is idempotent on a random key
 * minted once per visit, so a double tap cannot buy twice.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Check, Loader2, MapPin, Plus, Store, Tag, Wallet as WalletIcon, Banknote, ShoppingBag,
} from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { api, ApiError, type ApiAddress } from '../lib/api';
import { storeCheckoutApi, iqd, type StoreQuote } from '../lib/merchant';
import { useFreshOnReturn } from '../lib/useFreshOnReturn';
import AddressForm from '../components/address/AddressForm';
import { useStore } from '../StoreContext';

export default function StoreCheckout() {
  const { loc, dir } = useLanguage();
  const navigate = useNavigate();
  const { store: hostStore } = useStore();

  const [quote, setQuote] = useState<StoreQuote | null>(null);
  const [quoteError, setQuoteError] = useState('');
  const [addresses, setAddresses] = useState<ApiAddress[] | null>(null);
  const [addressId, setAddressId] = useState('');
  const [addingAddress, setAddingAddress] = useState(false);
  const [payWithWallet, setPayWithWallet] = useState(false);
  const [couponInput, setCouponInput] = useState('');
  const [coupon, setCoupon] = useState('');
  const [couponError, setCouponError] = useState('');
  const [placing, setPlacing] = useState(false);
  const [placeError, setPlaceError] = useState('');
  const [done, setDone] = useState<string | null>(null);

  // One key per visit: refreshing mints a new one, retrying does not.
  const idemKey = useRef(`sc-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`);

  const loadQuote = useCallback(
    async (code: string) => {
      setCouponError('');
      try {
        const d = await storeCheckoutApi.quote(code);
        setQuote(d.quote);
        setCoupon(code);
        setQuoteError('');
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.code === 'COUPON_INVALID') {
          setCouponError(loc('هذا الكود غير صالح لهذا الطلب', 'This code cannot be used on this order', 'ئەم کۆدە بەکارناهێت'));
          return false;
        }
        setQuoteError(e instanceof ApiError ? e.message : loc('تعذّر تسعير السلة', 'Could not price the cart', 'نەتوانرا'));
        return false;
      }
    },
    [loc]
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
  // coupon in force is carried through, and nothing runs mid-submit.
  const couponRef = useRef('');
  couponRef.current = coupon;
  useFreshOnReturn(async () => {
    await loadQuote(couponRef.current);
  }, {
    enabled: !placing,
    minIntervalMs: 8_000,
    pollWhileVisibleMs: 60_000,
  });

  async function place() {
    if (!addressId || !quote) return;
    setPlacing(true);
    setPlaceError('');
    try {
      const r = await storeCheckoutApi.place({
        addressId,
        payWithWallet,
        idempotencyKey: idemKey.current,
        ...(coupon ? { couponCode: coupon } : {}),
      });
      setDone(String((r.order as Record<string, unknown>).id));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'INSUFFICIENT_FUNDS') {
        setPlaceError(
          loc(
            'رصيد محفظتك لا يغطي هذا الطلب — اختر الدفع عند الاستلام أو اشحن المحفظة.',
            'Your wallet balance does not cover this order — choose cash on delivery or top up.',
            'باڵانسی جزدانەکەت بەش ناکات.'
          )
        );
      } else {
        setPlaceError(e instanceof ApiError ? e.message : loc('تعذّر إتمام الطلب', 'Could not place the order', 'نەتوانرا'));
      }
    } finally {
      setPlacing(false);
    }
  }

  if (done) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center px-6">
        <div className="text-center max-w-sm">
          <div className="w-14 h-14 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center mx-auto mb-4">
            <Check className="w-7 h-7 text-emerald-400" />
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
            className="inline-flex items-center gap-2 h-11 px-6 rounded-2xl bg-olive text-white font-bold text-[13.5px]"
          >
            <ShoppingBag className="w-4 h-4" />
            {loc('طلباتي', 'My orders', 'داواکاریەکانم')}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-300 pb-36">
      <div className="sticky top-0 z-30 bg-[#0a0a0a]/95 backdrop-blur border-b border-white/5 px-4 py-3 flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="w-9 h-9 rounded-xl border border-white/10 flex items-center justify-center text-zinc-300">
          <ArrowLeft className={`w-4 h-4 ${dir === 'rtl' ? 'rotate-180' : ''}`} />
        </button>
        <h1 className="text-white font-bold text-[15px]">{loc('إتمام الطلب', 'Checkout', 'تەواوکردنی داواکاری')}</h1>
      </div>

      <div className="max-w-2xl mx-auto px-4 sm:px-6 pt-4 space-y-3">
        {quoteError && (
          <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3">
            <p className="text-red-300 text-[12.5px]">{quoteError}</p>
            <Link to="/cart" className="text-gold text-[12px] font-bold mt-1 inline-block">
              {loc('العودة إلى السلة', 'Back to the cart', 'گەڕانەوە بۆ سەبەتە')}
            </Link>
          </div>
        )}

        {!quote && !quoteError && (
          <div className="py-16 flex justify-center">
            <Loader2 className="w-6 h-6 text-gold animate-spin" />
          </div>
        )}

        {quote && (
          <>
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3.5">
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
                    <p className="text-zinc-200 flex-1 min-w-0 truncate">{l.name}</p>
                    <span className="text-zinc-500 shrink-0" dir="ltr">×{l.qty}</span>
                    <span className="text-zinc-200 font-semibold shrink-0" dir="ltr">{iqd(l.line_total_iqd)}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Delivery address — the platform's own address book. */}
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3.5">
              <div className="flex items-center justify-between mb-2.5">
                <h2 className="text-white font-bold text-[13px] flex items-center gap-1.5">
                  <MapPin className="w-4 h-4 text-gold" />
                  {loc('عنوان التوصيل', 'Delivery address', 'ناونیشانی گەیاندن')}
                </h2>
                {!addingAddress && (
                  <button onClick={() => setAddingAddress(true)} className="text-gold text-[11.5px] font-bold inline-flex items-center gap-1">
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
                      key={a.id}
                      onClick={() => setAddressId(a.id)}
                      className={`w-full text-start rounded-xl border p-2.5 transition-colors ${
                        addressId === a.id ? 'border-gold/50 bg-gold/5' : 'border-white/10 bg-black/20'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center ${
                            addressId === a.id ? 'border-gold' : 'border-zinc-600'
                          }`}
                        >
                          {addressId === a.id && <span className="w-2 h-2 rounded-full bg-gold" />}
                        </span>
                        <span className="text-white text-[12.5px] font-semibold">{a.label || a.name}</span>
                        <span className="text-zinc-500 text-[11px]" dir="ltr">{a.phone}</span>
                      </div>
                      <p className="text-zinc-400 text-[11.5px] mt-1 ps-6">{a.address}</p>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Payment */}
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3.5">
              <h2 className="text-white font-bold text-[13px] mb-2.5">{loc('طريقة الدفع', 'Payment', 'پارەدان')}</h2>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setPayWithWallet(false)}
                  className={`h-11 rounded-xl border text-[12.5px] font-bold flex items-center justify-center gap-1.5 transition-colors ${
                    !payWithWallet ? 'border-gold/50 bg-gold/10 text-gold' : 'border-white/10 bg-black/20 text-zinc-400'
                  }`}
                >
                  <Banknote className="w-4 h-4" />
                  {loc('عند الاستلام', 'Cash on delivery', 'لە کاتی گەیاندن')}
                </button>
                <button
                  onClick={() => setPayWithWallet(true)}
                  className={`h-11 rounded-xl border text-[12.5px] font-bold flex items-center justify-center gap-1.5 transition-colors ${
                    payWithWallet ? 'border-gold/50 bg-gold/10 text-gold' : 'border-white/10 bg-black/20 text-zinc-400'
                  }`}
                >
                  <WalletIcon className="w-4 h-4" />
                  {loc('من المحفظة', 'From wallet', 'لە جزدان')}
                </button>
              </div>
            </div>

            {/* The store's own coupon. */}
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3.5">
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
                      loadQuote('');
                    }}
                    className="text-zinc-500 text-[11.5px] font-bold"
                  >
                    {loc('إزالة', 'Remove', 'لابردن')}
                  </button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <input
                    value={couponInput}
                    onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
                    dir="ltr"
                    placeholder={loc('الكود', 'Code', 'کۆد')}
                    className="flex-1 min-w-0 h-10 rounded-xl bg-black/40 border border-white/10 px-3 text-white text-[13px] font-mono outline-none focus:border-gold/40"
                  />
                  <button
                    onClick={() => couponInput.trim() && loadQuote(couponInput.trim())}
                    disabled={!couponInput.trim()}
                    className="h-10 px-4 rounded-xl bg-white/[0.05] border border-white/10 text-zinc-200 text-[12.5px] font-bold disabled:opacity-40"
                  >
                    {loc('تطبيق', 'Apply', 'جێبەجێ')}
                  </button>
                </div>
              )}
              {couponError && <p className="text-amber-400 text-[11.5px] mt-1.5">{couponError}</p>}
            </div>

            {/* Totals — the server's numbers, verbatim. */}
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-3.5 space-y-1.5 text-[12.5px]">
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
            </div>

            {placeError && (
              <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3">
                <p className="text-red-300 text-[12.5px]">{placeError}</p>
                {payWithWallet && !hostStore && (
                  <Link to="/wallet" className="text-gold text-[12px] font-bold mt-1 inline-block">
                    {loc('شحن المحفظة', 'Top up the wallet', 'پڕکردنەوەی جزدان')}
                  </Link>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {quote && (
        <div className="fixed bottom-0 inset-x-0 z-40 border-t border-white/10 bg-[#0a0a0a]/95 backdrop-blur-xl px-4 sm:px-6 py-3">
          <div className="max-w-2xl mx-auto">
            <button
              onClick={place}
              disabled={placing || !addressId}
              className="w-full h-12 rounded-2xl bg-olive text-white font-bold text-[14px] flex items-center justify-center gap-2 disabled:opacity-40 active:scale-[0.99] transition-transform"
            >
              {placing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              {loc('تأكيد الطلب', 'Place the order', 'دووپاتکردنەوە')}
              <span dir="ltr">· {iqd(quote.total_iqd)}</span>
            </button>
            {!addressId && (
              <p className="text-amber-400/90 text-[11px] text-center mt-1.5">
                {loc('اختر عنوان التوصيل أولًا', 'Choose a delivery address first', 'سەرەتا ناونیشان هەڵبژێرە')}
              </p>
            )}
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
