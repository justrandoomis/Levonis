/**
 * A merchant's public shop — what `ali3d.levonis-iq.com` renders.
 *
 * ONE APPLICATION, MANY STORES (§10). There is no per-merchant frontend; this
 * page is reached either because the hostname resolved to a store, or because
 * someone opened `/community/store/:slug` on the main site. Both paths end
 * here with the same component and the same data.
 *
 * VISUALLY IT IS LEVONIS. §12 and §93 are explicit that a merchant may brand
 * their shop but not escape the platform's design: the only thing a merchant
 * controls here is content — logo, banner, words, products — plus an accent
 * chosen from a fixed set of presets. No merchant string ever becomes a style
 * rule or raw HTML, which is why `accent` maps through a lookup below and
 * anything unrecognised falls back to the default.
 *
 * A customer arriving here is already signed in if they are signed in on the
 * main site — that is the shared cookie doing its job, and it is why this
 * page never asks anyone to log in again.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Store, Star, BadgeCheck, MapPin, Clock, ShoppingBag, Heart, MessageCircle,
  Loader2, PackageX,
} from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { useAuth } from '../AuthContext';
import { api, ApiError } from '../lib/api';
import { storefrontApi, badgeLabel, iqd, type MerchantStore, type MerchantProduct } from '../lib/merchant';
import { GOVERNORATE_LABELS } from '../lib/governorates';
import { useStore } from '../StoreContext';

/**
 * The accent presets. A NAME maps to classes chosen here — a merchant never
 * supplies a colour, so nothing they type can reach the stylesheet.
 */
const ACCENTS: Record<string, { ring: string; chip: string; glow: string }> = {
  default: { ring: 'border-gold/20', chip: 'bg-olive/30 text-gold', glow: 'bg-olive/15' },
  olive: { ring: 'border-olive-light/40', chip: 'bg-olive/40 text-gold', glow: 'bg-olive/20' },
  gold: { ring: 'border-gold/40', chip: 'bg-gold/15 text-gold', glow: 'bg-gold/10' },
  slate: { ring: 'border-slate-500/30', chip: 'bg-slate-500/15 text-slate-200', glow: 'bg-slate-500/10' },
  plum: { ring: 'border-purple-500/30', chip: 'bg-purple-500/15 text-purple-200', glow: 'bg-purple-500/10' },
  teal: { ring: 'border-teal-500/30', chip: 'bg-teal-500/15 text-teal-200', glow: 'bg-teal-500/10' },
};

type Tab = 'products' | 'reviews' | 'about';

export default function Storefront({ store: injected }: { store?: MerchantStore | null } = {}) {
  const { slug: routeSlug } = useParams<{ slug: string }>();
  const { loc, lang } = useLanguage();
  const { user } = useAuth();

  const [store, setStore] = useState<MerchantStore | null>(injected ?? null);
  const [loading, setLoading] = useState(!injected);
  const [notFound, setNotFound] = useState(false);
  const [tab, setTab] = useState<Tab>('products');

  const slug = store?.slug ?? routeSlug ?? '';

  useEffect(() => {
    if (injected) {
      setStore(injected);
      setLoading(false);
      return;
    }
    if (!routeSlug) return;
    let alive = true;
    setLoading(true);
    storefrontApi
      .store(routeSlug)
      .then((d) => alive && setStore(d.store))
      .catch(() => alive && setNotFound(true))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [routeSlug, injected]);

  const accent = ACCENTS[store?.accent ?? 'default'] ?? ACCENTS.default;

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-gold animate-spin" />
      </div>
    );
  }

  if (notFound || !store) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center px-6">
        <div className="text-center max-w-sm">
          <PackageX className="w-10 h-10 text-zinc-600 mx-auto mb-4" />
          <h1 className="text-gold font-bold text-lg mb-2">
            {loc('لا يوجد متجر هنا', 'No store here', 'هیچ فرۆشگایەک لێرە نییە')}
          </h1>
          <p className="text-zinc-500 text-[13px] mb-6">
            {loc(
              'قد يكون العنوان مكتوبًا بشكل خاطئ أو أن المتجر لم يعد موجودًا.',
              'The address may be mistyped, or the store no longer exists.',
              'لەوانەیە ناونیشانەکە هەڵە بێت یان فرۆشگاکە نەمابێت.'
            )}
          </p>
          <a
            href="https://levonis-iq.com"
            className="inline-flex items-center gap-2 min-h-[44px] px-5 rounded-2xl bg-olive text-white font-bold text-[13px]"
          >
            LEVONIS
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-300 pb-28">
      <div className={`fixed top-0 left-1/2 -translate-x-1/2 w-full max-w-2xl h-[420px] ${accent.glow} rounded-full blur-[120px] pointer-events-none z-0`} />

      {/* Banner + identity */}
      <div className="relative z-10">
        <div className="h-32 sm:h-44 w-full overflow-hidden bg-white/[0.03]">
          {store.bannerUrl && (
            <img src={store.bannerUrl} alt="" className="w-full h-full object-cover" loading="lazy" />
          )}
        </div>

        <div className="max-w-3xl mx-auto px-4 sm:px-6 -mt-10 relative">
          <div className="flex items-end gap-4 mb-4">
            <div className={`w-20 h-20 rounded-3xl bg-[#0a0a0a] border-2 ${accent.ring} overflow-hidden shrink-0 flex items-center justify-center`}>
              {store.logoUrl ? (
                <img src={store.logoUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <Store className="w-8 h-8 text-gold" />
              )}
            </div>
            <div className="min-w-0 pb-1">
              <div className="flex items-center gap-1.5">
                <h1 className="text-white font-bold text-lg truncate">{store.name}</h1>
                {store.merchant.verified && <BadgeCheck className="w-4.5 h-4.5 text-gold shrink-0" />}
              </div>
              {store.tagline && <p className="text-zinc-400 text-[12.5px] truncate">{store.tagline}</p>}
            </div>
          </div>

          {/* Trust signals. Real numbers or nothing — a store with no reviews
              says "no reviews yet", never a fabricated 5.0. */}
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full ${accent.chip}`}>
              {badgeLabel(store.merchant.badge, loc)}
            </span>
            {store.merchant.rating !== null ? (
              <span className="flex items-center gap-1 text-[11.5px] text-zinc-300">
                <Star className="w-3.5 h-3.5 text-gold fill-gold" />
                <span className="font-bold">{store.merchant.rating.toFixed(1)}</span>
                <span className="text-zinc-500">({store.merchant.rating_count})</span>
              </span>
            ) : (
              <span className="text-[11.5px] text-zinc-500">
                {loc('لا توجد تقييمات بعد', 'No reviews yet', 'هێشتا هەڵسەنگاندن نییە')}
              </span>
            )}
            {store.merchant.completed_orders > 0 && (
              <span className="text-[11.5px] text-zinc-500">
                {loc(
                  `${store.merchant.completed_orders} طلب مكتمل`,
                  `${store.merchant.completed_orders} completed orders`,
                  `${store.merchant.completed_orders} داواکاری تەواوکراو`
                )}
              </span>
            )}
            {store.governorate && (
              <span className="flex items-center gap-1 text-[11.5px] text-zinc-500">
                <MapPin className="w-3.5 h-3.5" />
                {GOVERNORATE_LABELS[store.governorate]?.[lang === 'ckb' ? 'ckb' : lang] ?? store.governorate}
              </span>
            )}
          </div>

          {/* A closed store says so, without saying why — that is between the
              merchant and Levonis (§51). */}
          {!store.open && (
            <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 mb-4">
              <p className="text-amber-200/90 text-[12.5px]">
                {loc(
                  'هذا المتجر لا يستقبل طلبات حاليًا.',
                  'This store is not taking orders right now.',
                  'ئەم فرۆشگایە لە ئێستادا داواکاری وەرناگرێت.'
                )}
              </p>
            </div>
          )}

          <div className="flex gap-2 mb-6">
            <FollowButton merchantId={store.merchant.id} signedIn={!!user} loc={loc} />
            <Link
              to={`/chats?merchant=${store.merchant.id}`}
              className="flex-1 min-h-[44px] rounded-2xl border border-white/10 bg-white/[0.03] text-zinc-200 font-semibold text-[13px] flex items-center justify-center gap-2 active:scale-[0.98] transition-transform"
            >
              <MessageCircle className="w-4 h-4" />
              {loc('راسل البائع', 'Message seller', 'نامە بۆ فرۆشیار')}
            </Link>
          </div>

          <div className="flex gap-1 border-b border-white/10 mb-5">
            {(['products', 'reviews', 'about'] as Tab[]).map((k) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`px-4 py-2.5 text-[13px] font-semibold border-b-2 -mb-px transition-colors ${
                  tab === k ? 'border-gold text-gold' : 'border-transparent text-zinc-500'
                }`}
              >
                {k === 'products'
                  ? loc('المنتجات', 'Products', 'بەرهەمەکان')
                  : k === 'reviews'
                    ? loc('التقييمات', 'Reviews', 'هەڵسەنگاندنەکان')
                    : loc('عن المتجر', 'About', 'دەربارە')}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 sm:px-6 relative z-10">
        {tab === 'products' && <ProductsTab slug={slug} open={!!store.open} />}
        {tab === 'reviews' && <ReviewsTab slug={slug} />}
        {tab === 'about' && <AboutTab store={store} />}
      </div>
    </div>
  );
}

// --------------------------------------------------------------- products

function ProductsTab({ slug, open }: { slug: string; open: boolean }) {
  const { loc } = useLanguage();
  const [products, setProducts] = useState<MerchantProduct[] | null>(null);

  useEffect(() => {
    let alive = true;
    storefrontApi
      .products(slug)
      .then((d) => alive && setProducts(d.products))
      .catch(() => alive && setProducts([]));
    return () => {
      alive = false;
    };
  }, [slug]);

  if (products === null) {
    return (
      <div className="py-12 flex justify-center">
        <Loader2 className="w-5 h-5 text-gold animate-spin" />
      </div>
    );
  }

  if (!products.length) {
    return (
      <Empty
        icon={<ShoppingBag className="w-8 h-8 text-zinc-600" />}
        text={loc('لا توجد منتجات بعد', 'No products yet', 'هێشتا بەرهەم نییە')}
      />
    );
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {products.map((p) => (
        <ProductCard key={p.id} slug={slug} product={p} storeOpen={open} />
      ))}
    </div>
  );
}

function ProductCard({ slug, product, storeOpen }: { slug: string; product: MerchantProduct; storeOpen: boolean }) {
  const { loc } = useLanguage();
  const { store: hostStore } = useStore();
  // On a merchant host the shop IS the site, so the product lives at /p/...
  // On the main site it needs the store in the path. Same page either way.
  const href = hostStore ? `/p/${product.slug}` : `/community/store/${slug}/p/${product.slug}`;
  const image = product.images[0];
  const discounted = product.original_price_iqd && product.original_price_iqd > product.price_iqd;
  const sellable = storeOpen && product.in_stock !== false;

  return (
    <Link
      to={href}
      className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden active:scale-[0.98] transition-transform"
    >
      <div className="aspect-square bg-black/40 overflow-hidden">
        {image ? (
          <img src={image} alt={product.name} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <ShoppingBag className="w-7 h-7 text-zinc-700" />
          </div>
        )}
      </div>
      <div className="p-2.5">
        <p className="text-white text-[12.5px] font-semibold line-clamp-2 leading-snug mb-1.5">{product.name}</p>
        <div className="flex items-baseline gap-1.5" dir="ltr">
          <span className="text-gold font-bold text-[13px]">{iqd(product.price_iqd)}</span>
          {discounted && (
            <span className="text-zinc-600 text-[11px] line-through">{iqd(product.original_price_iqd)}</span>
          )}
        </div>
        {!sellable && (
          <span className="inline-block mt-1.5 text-[10px] font-bold px-2 py-0.5 rounded-full bg-zinc-700/40 text-zinc-400">
            {loc('غير متوفر', 'Unavailable', 'بەردەست نییە')}
          </span>
        )}
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------- reviews

function ReviewsTab({ slug }: { slug: string }) {
  const { loc } = useLanguage();
  const [data, setData] = useState<Awaited<ReturnType<typeof storefrontApi.reviews>> | null>(null);

  useEffect(() => {
    let alive = true;
    storefrontApi
      .reviews(slug)
      .then((d) => alive && setData(d))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [slug]);

  if (!data) {
    return (
      <div className="py-12 flex justify-center">
        <Loader2 className="w-5 h-5 text-gold animate-spin" />
      </div>
    );
  }

  if (!data.count) {
    return (
      <Empty
        icon={<Star className="w-8 h-8 text-zinc-600" />}
        text={loc('لا توجد تقييمات بعد', 'No reviews yet', 'هێشتا هەڵسەنگاندن نییە')}
        hint={loc(
          'التقييمات تأتي من طلبات مكتملة فقط.',
          'Reviews come only from completed orders.',
          'هەڵسەنگاندنەکان تەنها لە داواکاریە تەواوکراوەکانەوە دێن.'
        )}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="flex items-center gap-4">
          <div className="text-center shrink-0">
            <div className="text-gold font-bold text-2xl">{data.average?.toFixed(1)}</div>
            <div className="text-zinc-500 text-[11px]">
              {loc(`${data.count} تقييم`, `${data.count} reviews`, `${data.count} هەڵسەنگاندن`)}
            </div>
          </div>
          <div className="flex-1 space-y-1">
            {[5, 4, 3, 2, 1].map((n) => {
              const count = data.distribution[String(n)] ?? 0;
              const pct = data.count ? (count / data.count) * 100 : 0;
              return (
                <div key={n} className="flex items-center gap-2" dir="ltr">
                  <span className="text-zinc-500 text-[10px] w-3">{n}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
                    <div className="h-full bg-gold/70 rounded-full" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-zinc-600 text-[10px] w-6 text-right">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {data.reviews.map((r) => (
        <div key={String(r.id)} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-white text-[13px] font-semibold truncate">{String(r.customer_name)}</span>
              {/* Every review here came from a completed transaction — the
                  database will not hold one that did not. */}
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shrink-0">
                {loc('شراء موثّق', 'Verified', 'کڕینی پشتڕاستکراو')}
              </span>
            </div>
            <div className="flex gap-0.5 shrink-0">
              {[1, 2, 3, 4, 5].map((n) => (
                <Star
                  key={n}
                  className={`w-3.5 h-3.5 ${n <= Number(r.rating) ? 'text-gold fill-gold' : 'text-zinc-700'}`}
                />
              ))}
            </div>
          </div>
          {!!r.body && <p className="text-zinc-300 text-[13px] leading-relaxed">{String(r.body)}</p>}
          {!!r.merchant_reply && (
            <div className="mt-3 ps-3 border-s-2 border-gold/30">
              <p className="text-gold/80 text-[11px] font-semibold mb-0.5">
                {loc('رد البائع', 'Seller reply', 'وەڵامی فرۆشیار')}
              </p>
              <p className="text-zinc-400 text-[12.5px] leading-relaxed">{String(r.merchant_reply)}</p>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ about

function AboutTab({ store }: { store: MerchantStore }) {
  const { loc } = useLanguage();
  const policies = useMemo(() => Object.entries(store.policies ?? {}), [store.policies]);
  const socials = useMemo(() => Object.entries(store.social_links ?? {}), [store.social_links]);

  return (
    <div className="space-y-4">
      {store.description && (
        <Section title={loc('عن المتجر', 'About the store', 'دەربارەی فرۆشگا')}>
          <p className="text-zinc-300 text-[13px] leading-relaxed whitespace-pre-wrap">{store.description}</p>
        </Section>
      )}

      {store.business_hours.length > 0 && (
        <Section title={loc('ساعات العمل', 'Business hours', 'کاتژمێری کارکردن')}>
          <div className="space-y-1.5">
            {store.business_hours.map((h, i) => (
              <div key={i} className="flex items-center justify-between text-[12.5px]">
                <span className="text-zinc-400 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5" />
                  {typeof h === 'string' ? h : h.day}
                </span>
                {typeof h !== 'string' && (
                  <span className="text-zinc-300" dir="ltr">
                    {h.open} – {h.close}
                  </span>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {store.contact_phone && (
        <Section title={loc('التواصل', 'Contact', 'پەیوەندی')}>
          <a href={`tel:${store.contact_phone}`} className="text-gold text-[13px] font-semibold" dir="ltr">
            {store.contact_phone}
          </a>
        </Section>
      )}

      {policies.length > 0 && (
        <Section title={loc('سياسات المتجر', 'Store policies', 'سیاسەتەکانی فرۆشگا')}>
          <div className="space-y-3">
            {policies.map(([k, v]) => (
              <div key={k}>
                <p className="text-zinc-400 text-[12px] font-semibold mb-0.5">{k}</p>
                <p className="text-zinc-300 text-[12.5px] leading-relaxed whitespace-pre-wrap">{v}</p>
              </div>
            ))}
          </div>
        </Section>
      )}

      {socials.length > 0 && (
        <Section title={loc('روابط', 'Links', 'بەستەرەکان')}>
          <div className="flex flex-wrap gap-2">
            {socials.map(([k, v]) => (
              // The server already reduced these to http(s) URLs, so a
              // javascript: href in a store profile cannot reach here.
              <a
                key={k}
                href={v}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="text-[12px] px-3 py-1.5 rounded-full border border-white/10 bg-white/[0.03] text-zinc-300"
              >
                {k}
              </a>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ bits

function FollowButton({
  merchantId,
  signedIn,
  loc,
}: {
  merchantId: string;
  signedIn: boolean;
  loc: (ar: string, en: string, ckb?: string) => string;
}) {
  const [following, setFollowing] = useState(false);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (!signedIn) {
      // Preserve where they were, so signing in returns them to this shop.
      window.location.href = `/auth?next=${encodeURIComponent(window.location.pathname)}`;
      return;
    }
    setBusy(true);
    try {
      if (following) {
        await api.delete(`/api/community-reviews/follow/${merchantId}`);
        setFollowing(false);
      } else {
        await api.post(`/api/community-reviews/follow/${merchantId}`);
        setFollowing(true);
      }
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      onClick={toggle}
      disabled={busy}
      className={`flex-1 min-h-[44px] rounded-2xl font-semibold text-[13px] flex items-center justify-center gap-2 active:scale-[0.98] transition-all disabled:opacity-50 ${
        following ? 'bg-olive/40 text-gold border border-gold/20' : 'bg-olive text-white'
      }`}
    >
      <Heart className={`w-4 h-4 ${following ? 'fill-gold' : ''}`} />
      {following ? loc('تتابعه', 'Following', 'شوێنی کەوتوویت') : loc('متابعة', 'Follow', 'شوێنکەوتن')}
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <h3 className="text-gold font-bold text-[13px] mb-3">{title}</h3>
      {children}
    </div>
  );
}

function Empty({ icon, text, hint }: { icon: React.ReactNode; text: string; hint?: string }) {
  return (
    <div className="py-14 text-center">
      <div className="flex justify-center mb-3">{icon}</div>
      <p className="text-zinc-400 text-[13px]">{text}</p>
      {hint && <p className="text-zinc-600 text-[11.5px] mt-1.5">{hint}</p>}
    </div>
  );
}
