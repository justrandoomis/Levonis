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
 *
 * VARIANTS (W2-F). A product sold by variant shows one picker per option
 * group (src/components/catalog/VariantPicker.tsx); the add names the chosen
 * VARIANT by id and nothing else — its price is the server's, read again at
 * add and at checkout. The price shown follows the choice (a range until the
 * choice is complete), and so do the stock state and the picture.
 *
 * SPEED. The refusal sentences (src/lib/refusalStrings.ts, ~9 KB gzip) are
 * loaded on the first refusal, not with the page: most visits never see one.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { motion } from 'motion/react';
import {
  ShoppingBag, Store, ChevronLeft, Loader2, PackageX, Minus, Plus, Check, Clock, BadgeCheck, Truck,
} from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { api, ApiError } from '../lib/api';
import { storefrontApi, iqd } from '../lib/storefrontApi';
import type { MerchantProduct, MerchantStore } from '../lib/merchant';
import SellerConflictDialog, { type SellerConflict } from '../components/merchant/SellerConflictDialog';
import ProMerchantBadge from '../components/merchant/ProMerchantBadge';
import StoreUnavailable from '../components/merchant/StoreUnavailable';
import { useStore } from '../StoreContext';
import { trackStoreEvent } from '../lib/storeBeacon';
import StoreTheme from '../components/storefront/StoreTheme';
import '../components/storefront/styles';
import type { StorefrontStore } from '../components/storefront/types';
import { deliveryToYou } from '../components/storefront/parts';
import { VariantPicker } from '../components/catalog/VariantPicker';
import { ProductGallery, type GalleryItem } from '../components/catalog/ProductGallery';
import { ProductFacts } from '../components/catalog/ProductFacts';
import { findVariant, initialSelection, priceRange } from '../../packages/catalog/src/variants';

export default function StorefrontProduct() {
  const { slug: routeSlug, productSlug } = useParams<{ slug: string; productSlug: string }>();
  const { store: hostStore, unknownStore: hostUnknown, unavailableStore: hostUnavailable } = useStore();
  const { loc, lang } = useLanguage();
  const { user } = useAuth();
  const navigate = useNavigate();

  // On a merchant host the store is already known; on the main site it comes
  // from the URL. Both end here with the same data.
  const slug = hostStore?.slug ?? routeSlug ?? '';

  const [product, setProduct] = useState<MerchantProduct | null>(null);
  const [store, setStore] = useState<MerchantStore | null>(hostStore ?? null);
  // Nothing to fetch on a host already answered "unknown" or "unavailable".
  const [loading, setLoading] = useState(!hostUnknown && !hostUnavailable);
  const [unavailable, setUnavailable] = useState(false);
  const [qty, setQty] = useState(1);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<SellerConflict | null>(null);
  const [selection, setSelection] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!slug || !productSlug) return;
    let alive = true;
    storefrontApi
      .product(slug, productSlug)
      .then((d) => {
        if (!alive) return;
        setProduct(d.product);
        setStore(d.store);
        // The first combination that can be bought, chosen for the customer.
        setSelection(initialSelection(d.product.option_groups ?? [], d.product.variants ?? []));
        trackStoreEvent(d.store?.id, 'product_view', d.product?.id); // W2-E analytics beacon
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setProduct(null);
        // An admin-suspended store: the product is not served, and neither is
        // anything else of the shop (owner decision 2026-09-24).
        if (e instanceof ApiError && e.code === 'STORE_UNAVAILABLE') setUnavailable(true);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [slug, productSlug]);

  // THE CHOICE (W2-F). Computed before any early return: hooks below.
  const groups = product?.option_groups ?? [];
  const variantList = product?.variants ?? [];
  const isVariants = product?.variant_mode === 'variants' && groups.length > 0 && variantList.length > 0;
  const chosen = isVariants ? findVariant(groups, variantList, selection) : null;
  const gallery = useMemo<GalleryItem[]>(() => {
    if (!product) return [];
    const alt = (m: { alt: string; alt_ar: string }) => (lang === 'en' ? m.alt || m.alt_ar : m.alt_ar || m.alt);
    if (product.media?.length) return product.media.map((m) => ({ kind: m.kind, url: m.url, alt: alt(m) }));
    return product.images.map((url) => ({ kind: 'image' as const, url, alt: '' }));
  }, [product, lang]);

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
        // The chosen variant's ID — never its price (the server prices it).
        ...(chosen ? { variantId: chosen.id } : {}),
        qty,
        replaceCart,
      });
      setConflict(null);
      setAdded(true);
      trackStoreEvent(store?.id, 'add_to_cart', product.id); // W2-E analytics beacon
      setTimeout(() => setAdded(false), 2500);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CART_SELLER_CONFLICT') {
        // The server named both shops in `details`; the dialogue uses them.
        setConflict((e.details ?? {}) as unknown as SellerConflict);
      } else {
        // The CODE, in the customer's language — OWN_STORE_PURCHASE,
        // STORE_CLOSED, OUT_OF_STOCK (with how many are left), OPTION_INVALID…
        // — never the server's English sentence (src/lib/refusalStrings.ts).
        const fallback = loc('تعذّرت الإضافة', 'Could not add to cart', 'نەتوانرا زیاد بکرێت');
        if (!(e instanceof ApiError)) setError(fallback);
        else {
          // Loaded on the first refusal only (see the header).
          const { apiRefusal } = await import('../lib/refusalStrings');
          setError(apiRefusal(e, lang, fallback));
        }
      }
    } finally {
      setAdding(false);
    }
  }

  if (hostUnavailable || unavailable) return <StoreUnavailable />;

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
  // A variant product is sellable when the CHOSEN variant is in stock; until
  // the choice is complete the button asks for it instead.
  const choiceMissing = isVariants && !chosen;
  const sellable = store.open !== false && (isVariants ? !!chosen?.in_stock : product.in_stock !== false);
  const range = isVariants ? priceRange(product.price_iqd, variantList) : null;
  const shownPrice = chosen ? chosen.price_iqd : product.price_iqd;
  const shownCompare = chosen ? chosen.compare_at_iqd : product.original_price_iqd;
  const toYou = deliveryToYou(store as StorefrontStore, loc, lang);
  // The store's THEME (merchant platform W2-C): the product answer carries the
  // published layout's tokens; on the store's own host the resolve answer does.
  type Tokens = NonNullable<StorefrontStore['layout_theme']>['tokens'];
  const themeTokens: Tokens =
    (store as StorefrontStore).layout_theme?.tokens ??
    ((hostStore as StorefrontStore | null)?.layout as { tokens?: Tokens } | undefined)?.tokens;
  const discounted = !!shownCompare && shownCompare > shownPrice;

  return (
    <StoreTheme tokens={themeTokens ?? null} storeAccent={store.accent} className="min-h-screen text-zinc-300 pb-32">
      <div className="max-w-2xl mx-auto">
        <div className="px-4 sm:px-6 pt-4">
          <Link to={storeHome} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg text-zinc-400 text-[13px] mb-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
            <ChevronLeft className="w-4 h-4 rtl:rotate-180" />
            {store.name}
          </Link>
        </div>

        <ProductGallery
          items={gallery}
          focusUrl={chosen?.image ?? null}
          productName={product.name}
          videoLabel={loc('فيديو', 'Video') /* OWNER: Sorani to be written by hand. */}
          showLabel={(n) => loc(`عرض ${n}`, `Show ${n}`) /* OWNER: Sorani to be written by hand. */}
        />

        <div className="px-4 sm:px-6 pt-4">
          <h1 className="text-white font-bold text-[18px] leading-snug mb-2">{product.name}</h1>

          <div className="flex items-baseline gap-2 mb-4 tabular-nums" dir="ltr" aria-live="polite" data-product-price>
            <span className="text-gold font-bold text-xl">
              {!chosen && range && range.min !== range.max ? `${iqd(range.min)} – ${iqd(range.max)}` : iqd(shownPrice)}
            </span>
            {discounted && <span className="text-zinc-600 text-[14px] line-through">{iqd(shownCompare)}</span>}
          </div>

          {isVariants && (
            <div className="mb-5">
              <VariantPicker
                groups={groups}
                variants={variantList}
                selection={selection}
                onChange={(next) => {
                  setSelection(next);
                  setError('');
                }}
                lang={lang}
                soldOutLabel={loc('نفد', 'Sold out', 'تەواو بوو')}
              />
              {chosen && !chosen.in_stock && (
                <p className="mt-2 text-[12.5px] text-amber-300" role="status">
                  {loc('هذا الاختيار نفد حاليًا.', 'This choice is sold out for now.') /* OWNER: Sorani to be written by hand. */}
                </p>
              )}
            </div>
          )}

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
                {store.merchant.pro_badge && <ProMerchantBadge compact />}
              </div>
              {store.merchant.rating !== null && (
                <span className="text-zinc-500 text-[11.5px]">
                  {store.merchant.rating.toFixed(1)} ★ ({store.merchant.rating_count})
                </span>
              )}
            </div>
          </Link>

          {toYou && (
            <div className={`flex items-center gap-2 text-[12.5px] mb-3 ${toYou.available ? 'text-zinc-400' : 'text-amber-300'}`} data-delivery-to-you>
              <Truck className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>
                {toYou.title}: <span className="tabular-nums">{toYou.subtitle}</span>
              </span>
            </div>
          )}

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

          <ProductFacts attributes={product.attributes} loc={loc} lang={lang} />

          {product.description && (
            <p className="text-zinc-300 text-[13.5px] leading-relaxed whitespace-pre-wrap mb-6">
              {product.description}
            </p>
          )}

        </div>
      </div>

      {/* Buy bar */}
      <div className="fixed bottom-0 inset-x-0 z-40 border-t border-white/10 bg-[#0a0a0a]/95 backdrop-blur-xl px-4 sm:px-6 py-3">
        {/* The refusal sits beside the button that caused it: in the page body
            it could be scrolled away under this fixed bar and never seen. */}
        <p
          role="alert"
          aria-live="assertive"
          className={error ? 'max-w-2xl mx-auto mb-2 text-red-300 text-[12.5px] leading-snug' : 'sr-only'}
        >
          {error}
        </p>
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
            ) : choiceMissing ? (
              loc('اختر من الخيارات', 'Choose an option') /* OWNER: Sorani to be written by hand. */
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
    </StoreTheme>
  );
}
