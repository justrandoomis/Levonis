import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowLeft, ArrowRight, BadgePercent, Check } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { api, type ApiProduct, type ProductsListResponse } from '../lib/api';
import ProductCard from '../components/home/ProductCard';
import OccasionTag from '../components/ui/OccasionTag';
import Spinner from '../components/ui/Spinner';
import { IconButton } from '../components/ui/Button';
import { ProductGridSkeleton } from '../components/ui/Skeleton';
import { EmptyState, ErrorState } from '../components/ui/AsyncStates';
import { readPageCache, writePageCache } from '../lib/pageCache';
import { useFreshOnReturn } from '../lib/useFreshOnReturn';
import { useGoBack } from '../lib/useGoBack';
import { gridImageLoading } from '../lib/productCard';
import { countNoun } from '../lib/catalog/copy';
import { isOfferOccasionKey, occasionWords } from '../../packages/contracts/src/offerOccasions';

/**
 * «العروض» — EVERY PRODUCT ON SALE RIGHT NOW, BY OCCASION (DECISIONS row 294; docs/ux/PRODUCT-DISCOUNT.md §16.6).
 *
 * THE WAYS IN: the home rail «أحدث المنتجات», whose «العروض» chip appears while a sale is live and whose
 * «عرض الكل» then lands here (src/components/home/v2/LatestProducts.tsx — the retired «عروض سريعة» board
 * that this page was first meant for is no longer on the home page); a link the owner puts on a banner;
 * and the support chat, later: /offers?occasion=black_friday lists the Black Friday products alone. A
 * shared link opens in a fresh tab, so «رجوع» falls back to the home page (`useGoBack`).
 *
 * EVERYTHING HERE IS THE SERVER'S. `GET /api/products?type=offers` lists the products a LIVE, priced sale
 * lowers for this viewer, narrowed in SQL so the listing's candidate cap walks sales only and can hide
 * none (worker/routes/products.ts `listCatalogProducts`): exactly the cards that show the sale — the
 * card's own «from» lowered, the rule of «عليها عرض» (§8.8); a sale on a dearer model alone is named on
 * its product page, on that model, but its card shows no sale and it is not listed here. `occasions`
 * counts each occasion on them before `occasion=` narrows the list, so the chips stay put. Each card is
 * the shop's own compact card: its occasion tag, its «−N٪» and its struck price are the card's.
 *
 * Page copy lives in this file, not in `src/translations.ts` (which every visitor downloads).
 */

const STRINGS = {
  ar: {
    title: 'العروض',
    intro: 'كل ما عليه تخفيض الآن — اختر مناسبة لترى عروضها وحدها.',
    all: 'الكل',
    custom: 'عروض خاصة',
    empty: 'لا توجد عروض الآن',
    emptyHint: 'تظهر العروض هنا فور بدئها.',
    emptyOccasion: (name: string) => `لا توجد عروض «${name}» الآن`,
    emptyOccasionHint: 'هذه المناسبة ليس عليها تخفيض الآن — العروض الأخرى في «الكل».',
    seeAll: 'كل العروض',
    browse: 'تصفح المنتجات',
    more: 'عرض المزيد',
    back: 'رجوع',
    // The counted noun agrees with the number (src/lib/catalog/copy.ts): «3 منتجات», «14 منتجًا», «100 منتج», «103 منتجات».
    count: (n: number) => (n === 1 ? 'منتج واحد عليه تخفيض' : n === 2 ? 'منتجان عليهما تخفيض' : `${countNoun(n, 'product', 'ar')} عليها تخفيض`),
  },
  en: {
    title: 'Deals',
    intro: 'Everything on sale right now — pick an occasion to see its deals alone.',
    all: 'All',
    custom: 'Special deals',
    empty: 'No deals right now',
    emptyHint: 'Deals appear here as soon as they start.',
    emptyOccasion: (name: string) => `No ${name} deals right now`,
    emptyOccasionHint: 'Nothing is on sale for this occasion right now — the other deals are under All.',
    seeAll: 'All deals',
    browse: 'Browse products',
    more: 'Load more',
    back: 'Back',
    count: (n: number) => (n === 1 ? '1 product on sale' : `${n} products on sale`),
  },
  ckb: {
    title: 'ئۆفەرەکان',
    intro: 'هەموو ئەوەی ئێستا داشکاندنی لەسەرە — بۆنەیەک هەڵبژێرە بۆ بینینی ئۆفەرەکانی بە تەنها.',
    all: 'هەموو',
    custom: 'ئۆفەرە تایبەتەکان',
    empty: 'ئێستا هیچ ئۆفەرێک نییە',
    emptyHint: 'ئۆفەرەکان هەر کە دەستپێدەکەن لێرە دەردەکەون.',
    emptyOccasion: (name: string) => `ئێستا هیچ ئۆفەرێکی «${name}» نییە`,
    emptyOccasionHint: 'ئێستا هیچ داشکاندنێک بۆ ئەم بۆنەیە نییە — ئۆفەرەکانی تر لە «هەموو»دان.',
    seeAll: 'هەموو ئۆفەرەکان',
    browse: 'بەرهەمەکان ببینە',
    more: 'زیاتر پیشان بدە',
    back: 'گەڕانەوە',
    count: (n: number) => (n === 1 ? 'یەک بەرهەم داشکاندنی لەسەرە' : `${n} بەرهەم داشکاندنیان لەسەرە`),
  },
} as const;

/** One page of the listing. */
const PAGE = 24;
/** The cards on a 360×800 phone's first screen. */
const FIRST_SCREEN_CARDS = 6;

type Occasions = NonNullable<ProductsListResponse['occasions']>;
type OffersSnapshot = { products: ApiProduct[]; occasions: Occasions; total: number; hasMore: boolean };

// The filter-chip recipe (Bundles.tsx, build plan §5): flush at rest, PRESSED into a well when on, with a
// leading check as the one secondary cue.
const CHIP = 'shrink-0 min-h-[36px] px-3 rounded-full border text-[12px] font-bold transition-colors inline-flex items-center gap-1.5';
const CHIP_ON = 'border-border-subtle bg-[var(--clay-well-bg)] shadow-press text-text-primary';
const CHIP_OFF = 'border-border-subtle bg-surface-raised shadow-xs text-text-secondary hover:text-text-primary';
const chipMark = (on: boolean) => (on ? <Check aria-hidden className="w-3.5 h-3.5 shrink-0" /> : null);

export default function Offers() {
  const { lang, dir } = useLanguage();
  const l = lang === 'en' || lang === 'ckb' ? lang : 'ar';
  const s = STRINGS[l];
  // A deep link (the chat's, a banner's) has no earlier entry of the shop's: back goes home, never out of it.
  const goBack = useGoBack('/');
  const location = useLocation();
  const raw = new URLSearchParams(location.search).get('occasion') ?? '';
  const occasion = raw.trim();

  const cacheKey = `offers:${occasion}`;
  const [initialSnapshot] = useState(() => readPageCache<OffersSnapshot>(cacheKey));
  const [products, setProducts] = useState<ApiProduct[]>(initialSnapshot?.products ?? []);
  const [occasions, setOccasions] = useState<Occasions>(initialSnapshot?.occasions ?? []);
  const [total, setTotal] = useState<number | null>(initialSnapshot?.total ?? null);
  const [hasMore, setHasMore] = useState(initialSnapshot?.hasMore ?? false);
  const [loading, setLoading] = useState(!initialSnapshot);
  const [error, setError] = useState<unknown>(null);
  const [more, setMore] = useState<'idle' | 'loading'>('idle');
  // Monotonic request id: a chip tapped mid-flight never paints the previous chip's answer.
  const reqIdRef = useRef(0);

  const fetchPage = useCallback(
    (offset: number) => {
      const qs = new URLSearchParams({ type: 'offers', limit: String(PAGE) });
      if (offset > 0) qs.set('offset', String(offset));
      if (occasion) qs.set('occasion', occasion);
      return api.get<ProductsListResponse>(`/api/products?${qs.toString()}`);
    },
    [occasion]
  );

  const load = useCallback(async () => {
    const reqId = ++reqIdRef.current;
    /**
     * THE FIRST PAGE, AS IT WAS LEFT (src/lib/pageCache.ts): `back` from a product paints the deals the
     * customer was reading, for the same occasion, and the request still goes out behind them.
     */
    const cacheKey = `offers:${occasion}`;
    const snapshot = readPageCache<OffersSnapshot>(cacheKey);
    if (snapshot) {
      setProducts(snapshot.products);
      setOccasions(snapshot.occasions);
      setTotal(snapshot.total);
      setHasMore(snapshot.hasMore);
    }
    setLoading(!snapshot);
    setError(null);
    try {
      const res = await fetchPage(0);
      if (reqIdRef.current !== reqId) return;
      const next: OffersSnapshot = {
        products: res.products ?? [],
        occasions: res.occasions ?? [],
        total: res.total ?? (res.products ?? []).length,
        hasMore: res.has_more === true,
      };
      setProducts(next.products);
      setOccasions(next.occasions);
      setTotal(next.total);
      setHasMore(next.hasMore);
      writePageCache(cacheKey, next);
    } catch (err) {
      if (reqIdRef.current !== reqId) return;
      // The server's own last answer for this exact list stays rather than an error card.
      if (snapshot) return;
      setError(err);
    } finally {
      if (reqIdRef.current === reqId) setLoading(false);
    }
  }, [fetchPage, occasion]);

  const loadMore = useCallback(async () => {
    const reqId = reqIdRef.current;
    setMore('loading');
    try {
      const res = await fetchPage(products.length);
      if (reqIdRef.current !== reqId) return;
      setProducts((prev) => [...prev, ...(res.products ?? [])]);
      setHasMore(res.has_more === true);
    } catch {
      // A failed page costs that page, never the grid on screen.
      setHasMore(false);
    } finally {
      setMore('idle');
    }
  }, [fetchPage, products.length]);

  useEffect(() => {
    void load();
    return () => {
      reqIdRef.current += 1;
    };
  }, [load]);

  // A sale starts and ends on its own clock: coming back to the tab asks the server again.
  useFreshOnReturn(load, { enabled: !loading, minIntervalMs: 8_000 });

  const nameOf = (key: string, text?: { ar: string; en?: string; ckb?: string }) =>
    key === 'custom' && !text ? s.custom : occasionWords(key, text ?? null, l)?.name ?? s.custom;
  const chosen = occasion ? occasions.find((o) => o.key === occasion) ?? null : null;
  const chosenName = occasion && isOfferOccasionKey(occasion) ? nameOf(occasion, chosen?.badge_text) : '';
  const to = (key: string) => (key ? `/offers?occasion=${encodeURIComponent(key)}` : '/offers');

  return (
    <div className="w-full pb-24 text-text-secondary min-h-screen" data-offers-page>
      <div className="sticky top-0 z-40 lv-canvas border-b border-border-subtle px-4 py-2.5 flex items-center gap-3">
        <IconButton
          variant="secondary"
          onClick={goBack}
          label={s.back}
          icon={dir === 'rtl' ? <ArrowRight className="w-5 h-5" /> : <ArrowLeft className="w-5 h-5" />}
        />
        <h1 className="min-w-0 flex-1 truncate text-text-primary font-bold text-lg leading-tight">{s.title}</h1>
      </div>

      <div className="p-4 space-y-4">
        <p className="text-[13px] leading-relaxed">{s.intro}</p>

        {/* THE OCCASIONS ON TODAY'S SALES, each in its own design — links, so a chip is a page the chat can share. */}
        {occasions.length > 0 || occasion ? (
          <nav aria-label={s.title} className="-mx-4 flex gap-2 overflow-x-auto hide-scrollbar px-4 pb-1" data-offers-occasions>
            <Link to={to('')} replace aria-current={!occasion ? 'page' : undefined} className={`${CHIP} ${!occasion ? CHIP_ON : CHIP_OFF}`}>
              {chipMark(!occasion)}
              {s.all}
            </Link>
            {occasions.map((o) => {
              const on = o.key === occasion;
              return (
                <Link
                  key={o.key}
                  to={to(o.key)}
                  replace
                  aria-current={on ? 'page' : undefined}
                  aria-label={`${nameOf(o.key, o.badge_text)} (${o.count})`}
                  className={`${CHIP} ${on ? CHIP_ON : CHIP_OFF}`}
                  data-offers-occasion={o.key}
                >
                  {chipMark(on)}
                  {o.key === 'custom' && !o.badge_text ? (
                    <span className="truncate">{s.custom}</span>
                  ) : (
                    <OccasionTag badge={o.key} name={o.badge_text} lang={l} size="picker" />
                  )}
                  <bdi dir="ltr" className="tabular-nums text-text-muted" aria-hidden>
                    {o.count}
                  </bdi>
                </Link>
              );
            })}
          </nav>
        ) : null}

        {loading && products.length === 0 ? (
          <ProductGridSkeleton count={8} density="compact" className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4 xl:grid-cols-5" />
        ) : error != null ? (
          <ErrorState error={error} onRetry={() => void load()} />
        ) : products.length === 0 ? (
          <EmptyState
            icon={<BadgePercent aria-hidden="true" className="w-6 h-6" />}
            title={chosenName ? s.emptyOccasion(chosenName) : s.empty}
            description={occasion ? s.emptyOccasionHint : s.emptyHint}
            action={
              <Link to={occasion ? '/offers' : '/products'} className="lv-button lv-button-secondary px-5">
                {occasion ? s.seeAll : s.browse}
              </Link>
            }
          />
        ) : (
          <div className="relative">
            {total !== null ? (
              <p className="mb-3 text-[12px] font-bold text-text-muted" aria-live="polite" data-offers-count>
                {s.count(total)}
              </p>
            ) : null}
            <div
              aria-busy={loading}
              className={`grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4 xl:grid-cols-5 transition-opacity ${loading ? 'opacity-50 pointer-events-none' : ''}`}
            >
              {products.map((p, i) => (
                <div key={p.id} className="flex">
                  <ProductCard p={p} density="compact" compareToggle {...gridImageLoading(i, FIRST_SCREEN_CARDS)} />
                </div>
              ))}
            </div>
            {hasMore && !loading ? (
              <div className="mt-5 flex justify-center">
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={more === 'loading'}
                  aria-busy={more === 'loading'}
                  className="lv-button lv-button-secondary px-5 text-[13px]"
                >
                  {more === 'loading' && <Spinner size="sm" />}
                  {s.more}
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
