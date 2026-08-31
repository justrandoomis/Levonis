/**
 * A merchant's product page, and the place a merchant sale actually starts.
 *
 * THE ADD IS THE INTERESTING PART. It goes to `/api/cart/merchant-items`,
 * which is the SAME cart the platform uses — one cart infrastructure, one
 * checkout, one order history (§14, §94). What differs is the seller, and
 * the server refuses to mix two of them.
 *
 * When it refuses, this page does not swallow the error and it does not
 * silently empty the cart. It shows the customer both shops by name and the
 * two real ways forward. Clearing, if they choose it, is the same request
 * re-sent with `replaceCart: true` — one call, so a cart can never end up
 * emptied with nothing added.
 *
 * PRICE IS NEVER SENT. The client posts a product id and a quantity; every
 * figure on this page came from the server and every figure that decides
 * money is read again server-side at add and at checkout (§17).
 */

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { motion } from 'motion/react';
import {
  ShoppingBag, Store, ChevronLeft, Loader2, PackageX, Minus, Plus, Check, Clock, BadgeCheck,
} from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { api, ApiError } from '../lib/api';
import { storefrontApi, iqd, type MerchantProduct, type MerchantStore } from '../lib/merchant';
import SellerConflictDialog, { type SellerConflict } from '../components/merchant/SellerConflictDialog';
import { useStore } from '../StoreContext';

export default function StorefrontProduct() {
  const { slug: routeSlug, productSlug } = useParams<{ slug: string; productSlug: string }>();
  const { store: hostStore } = useStore();
  const { loc } = useLanguage();
  const { user } = useAuth();
  const navigate = useNavigate();

  // On a merchant host the store is already known; on the main site it comes
  // from the URL. Both end here with the same data.
  const slug = hostStore?.slug ?? routeSlug ?? '';

  const [product, setProduct] = useState<MerchantProduct | null>(null);
  const [store, setStore] = useState<MerchantStore | null>(hostStore ?? null);
  const [loading, setLoading] = useState(true);
  const [qty, setQty] = useState(1);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<SellerConflict | null>(null);

  useEffect(() => {
    if (!slug || !productSlug) return;
    let alive = true;
    storefrontApi
      .product(slug, productSlug)
      .then((d) => {
        if (!alive) return;
        setProduct(d.product);
        setStore(d.store);
      })
      .catch(() => alive && setProduct(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [slug, productSlug]);

  async function addToCart(replaceCart = false) {
    if (!product) return;
    if (!user) {
      navigate(`/auth?next=${encodeURIComponent(window.location.pathname)}`);
      return;
    }
    setAdding(true);
    setError('');
    try {
      await api.post('/api/cart/merchant-items', {
        productId: product.id,
        qty,
        replaceCart,
      });
      setConflict(null);
      setAdded(true);
      setTimeout(() => setAdded(false), 2500);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CART_SELLER_CONFLICT') {
        // The server named both shops in `details`; the dialogue uses them.
        setConflict((e.details ?? {}) as unknown as SellerConflict);
      } else if (e instanceof ApiError) {
        setError(e.message);
      } else {
        setError(loc('تعذّرت الإضافة', 'Could not add to cart', 'نەتوانرا زیاد بکرێت'));
      }
    } finally {
      setAdding(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-gold animate-spin" />
      </div>
    );
  }

  if (!product || !store) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center px-6">
        <div className="text-center">
          <PackageX className="w-10 h-10 text-zinc-600 mx-auto mb-4" />
          <p className="text-zinc-400 text-[13px]">
            {loc('هذا المنتج غير متاح', 'This product is not available', 'ئەم بەرهەمە بەردەست نییە')}
          </p>
        </div>
      </div>
    );
  }

  const storeHome = hostStore ? '/' : `/community/store/${slug}`;
  const sellable = store.open !== false && product.in_stock !== false;
  const discounted = product.original_price_iqd && product.original_price_iqd > product.price_iqd;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-300 pb-32">
      <div className="max-w-2xl mx-auto">
        <div className="px-4 sm:px-6 pt-4">
          <Link to={storeHome} className="inline-flex items-center gap-1.5 text-zinc-400 text-[13px] mb-4">
            <ChevronLeft className="w-4 h-4 rtl:rotate-180" />
            {store.name}
          </Link>
        </div>

        <div className="aspect-square sm:aspect-[4/3] bg-black/40 overflow-hidden">
          {product.images[0] ? (
            <img src={product.images[0]} alt={product.name} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <ShoppingBag className="w-12 h-12 text-zinc-700" />
            </div>
          )}
        </div>

        {product.images.length > 1 && (
          <div className="flex gap-2 overflow-x-auto hide-scrollbar px-4 sm:px-6 py-3">
            {product.images.slice(1).map((img, i) => (
              <img key={i} src={img} alt="" className="w-16 h-16 rounded-xl object-cover shrink-0 border border-white/10" />
            ))}
          </div>
        )}

        <div className="px-4 sm:px-6 pt-4">
          <h1 className="text-white font-bold text-[18px] leading-snug mb-2">{product.name}</h1>

          <div className="flex items-baseline gap-2 mb-4" dir="ltr">
            <span className="text-gold font-bold text-xl">{iqd(product.price_iqd)}</span>
            {discounted && (
              <span className="text-zinc-600 text-[14px] line-through">{iqd(product.original_price_iqd)}</span>
            )}
          </div>

          <Link
            to={storeHome}
            className="flex items-center gap-2.5 rounded-2xl border border-white/10 bg-white/[0.03] p-3 mb-4"
          >
            <div className="w-9 h-9 rounded-xl bg-olive/30 overflow-hidden flex items-center justify-center shrink-0">
              {store.logoUrl ? (
                <img src={store.logoUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <Store className="w-4 h-4 text-gold" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1">
                <span className="text-white text-[13px] font-semibold truncate">{store.name}</span>
                {store.merchant.verified && <BadgeCheck className="w-3.5 h-3.5 text-gold shrink-0" />}
              </div>
              {store.merchant.rating !== null && (
                <span className="text-zinc-500 text-[11.5px]">
                  {store.merchant.rating.toFixed(1)} ★ ({store.merchant.rating_count})
                </span>
              )}
            </div>
          </Link>

          {product.prep_days > 0 && (
            <div className="flex items-center gap-2 text-zinc-400 text-[12.5px] mb-4">
              <Clock className="w-4 h-4" />
              {loc(
                `يجهّز خلال ${product.prep_days} يوم`,
                `Prepared in ${product.prep_days} days`,
                `لە ${product.prep_days} ڕۆژدا ئامادە دەکرێت`
              )}
            </div>
          )}

          {product.description && (
            <p className="text-zinc-300 text-[13.5px] leading-relaxed whitespace-pre-wrap mb-6">
              {product.description}
            </p>
          )}

          {error && (
            <div className="rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 mb-4">
              <p className="text-red-300 text-[12.5px]">{error}</p>
            </div>
          )}
        </div>
      </div>

      {/* Buy bar */}
      <div className="fixed bottom-0 inset-x-0 z-40 border-t border-white/10 bg-[#0a0a0a]/95 backdrop-blur-xl px-4 sm:px-6 py-3">
        <div className="max-w-2xl mx-auto flex items-center gap-3">
          <div className="flex items-center gap-1 rounded-2xl border border-white/10 bg-white/[0.03] shrink-0">
            <button
              onClick={() => setQty((q) => Math.max(1, q - 1))}
              className="w-11 h-11 flex items-center justify-center text-zinc-400"
              aria-label={loc('أقل', 'Less', 'کەمتر')}
            >
              <Minus className="w-4 h-4" />
            </button>
            <span className="w-8 text-center text-white font-bold text-[14px]">{qty}</span>
            <button
              onClick={() => setQty((q) => Math.min(99, q + 1))}
              className="w-11 h-11 flex items-center justify-center text-zinc-400"
              aria-label={loc('أكثر', 'More', 'زیاتر')}
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>

          <motion.button
            whileTap={sellable ? { scale: 0.98 } : undefined}
            onClick={() => addToCart(false)}
            disabled={!sellable || adding}
            className="flex-1 min-h-[48px] rounded-2xl bg-olive text-white font-bold text-[14px] flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {adding ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : added ? (
              <>
                <Check className="w-4 h-4" />
                {loc('أُضيف', 'Added', 'زیادکرا')}
              </>
            ) : !sellable ? (
              loc('غير متوفر', 'Unavailable', 'بەردەست نییە')
            ) : (
              <>
                <ShoppingBag className="w-4 h-4" />
                {loc('أضف إلى السلة', 'Add to cart', 'زیادکردن بۆ سەبەتە')}
              </>
            )}
          </motion.button>
        </div>
      </div>

      <SellerConflictDialog
        conflict={conflict}
        busy={adding}
        onCancel={() => setConflict(null)}
        // The same add, re-sent with the customer's confirmation attached.
        onReplace={() => addToCart(true)}
      />
    </div>
  );
}
