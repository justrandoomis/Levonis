import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, PackageSearch, Search, Sparkles } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { api, type HomeTaxon } from '../lib/api';
import { useFreshOnReturn } from '../lib/useFreshOnReturn';
import { useRail } from '../lib/useRail';
import SectionHeader from '../components/home/SectionHeader';
import BundleTile, { type BundleCard } from '../components/bundles/BundleTile';
import { BundleGridSkeleton } from '../components/ui/Skeleton';
import { EmptyState, ErrorState } from '../components/ui/AsyncStates';

/**
 * الباقات — bundles and mystery offers (docs/BUNDLES_MYSTERY.md §13).
 *
 * EVERYTHING ON THIS PAGE IS A SERVER VERDICT. The card state, the price, the
 * saving, the lock and the schedule all arrive computed; this file renders
 * them and classifies nothing. A browser that decided "low stock" or "you are
 * a member" would be a second opinion the cart and the door would then
 * contradict.
 *
 * WHAT CHANGED FROM THE FIRST VERSION OF THIS PAGE, AND WHY.
 *
 *  - It is no longer members-only. Gating is now per offer (§9): an ungated
 *    bundle is public — guests included — and only a gated one renders a lock.
 *    The old page asked the server one question ("are you entitled?") and hid
 *    the whole section on a no.
 *
 *  - The hand-rolled spinner and the red error div are gone, replaced by
 *    `AsyncStates` and `BundleGridSkeleton`, so a 401 is a sign-in prompt and
 *    never "no bundles", and a network failure is retryable rather than a
 *    dead-end sentence.
 *
 *  - It is not one wall of cards. A featured rail, a search box, a category
 *    facet and the filter-chip row reuse the `GET /api/products` parameter
 *    shapes and the `Products.tsx` chip layout — a shop with forty bundles
 *    must not be an offset-paginated wall.
 *
 * Page copy lives in this file, not in `src/translations.ts`, which every
 * visitor downloads as `vendor-i18n` (§13.3).
 */

const STRINGS = {
  ar: {
    title: 'الباقات والعروض',
    search: 'ابحث في الباقات',
    all: 'الكل',
    bundles: 'باقات',
    mystery: 'عروض غامضة',
    available: 'متوفر الآن',
    members: 'للمشتركين',
    allCategories: 'كل الأقسام',
    featured: 'عروض مختارة',
    empty: 'لا توجد باقات مطابقة',
    emptyHint: 'جرّب كلمة بحث أو قسمًا آخر.',
    lockedCta: 'اشترك للوصول',
    signIn: 'سجّل الدخول',
  },
  en: {
    title: 'Bundles & offers',
    search: 'Search bundles',
    all: 'All',
    bundles: 'Bundles',
    mystery: 'Mystery offers',
    available: 'In stock',
    members: 'Members only',
    allCategories: 'All categories',
    featured: 'Featured offers',
    empty: 'No bundles match',
    emptyHint: 'Try a different search or category.',
    lockedCta: 'Subscribe to unlock',
    signIn: 'Sign in',
  },
  ckb: {
    title: 'پاکێج و پێشنیارەکان',
    search: 'گەڕان لە پاکێجەکان',
    all: 'هەموو',
    bundles: 'پاکێجەکان',
    mystery: 'پێشنیاری نهێنی',
    available: 'بەردەستە',
    members: 'تەنها ئەندامان',
    allCategories: 'هەموو هاوپۆلەکان',
    featured: 'پێشنیارە هەڵبژێردراوەکان',
    empty: 'هیچ پاکێجێک نەدۆزرایەوە',
    emptyHint: 'وشەیەکی تر یان هاوپۆلێکی تر تاقی بکەوە.',
    lockedCta: 'بەشداری بکە',
    signIn: 'چوونەژوورەوە',
  },
} as const;

/** The 0034 response keys, preserved: `entitled` still means "this viewer
 *  holds a paid membership" — it just no longer decides whether the list has
 *  anything in it (§9). */
export interface BundlesResponse {
  entitled: boolean;
  signed_in: boolean;
  bundles: BundleCard[];
}

export type { BundleCard };

const CHIP =
  'shrink-0 min-h-[36px] px-3 rounded-full border text-[12px] font-bold transition-colors inline-flex items-center';
const CHIP_ON = 'bg-olive text-black border-olive';
const CHIP_OFF = 'bg-zinc-900/60 text-zinc-300 border-zinc-800 hover:border-zinc-600';

export default function Bundles() {
  const { dir, lang, loc } = useLanguage();
  const s = STRINGS[lang];
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const featuredRail = useRail();

  const kind = params.get('kind') ?? '';
  const category = params.get('category_id') ?? '';
  const onlyAvailable = params.get('available') === '1';
  const onlyMembers = params.get('members') === '1';
  const search = params.get('search') ?? '';
  const [searchDraft, setSearchDraft] = useState(search);

  const [data, setData] = useState<BundlesResponse | null>(null);
  const [categories, setCategories] = useState<HomeTaxon[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  // Monotonic request id: when the query changes mid-flight, the stale
  // response is ignored so a previous query's cards never flash in.
  const reqIdRef = useRef(0);
  /**
   * A SHOP WITH MORE THAN ONE PAGE OF OFFERS IS NOT SILENTLY TRUNCATED.
   *
   * The listing asked for 48 with no offset and no way to see any more, so
   * offer 49 simply did not exist for a customer. `GET /api/bundles` already
   * accepts `offset`; this pages through it and appends, and the page resets to
   * zero whenever the query changes.
   */
  const PAGE = 24;
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchPage = useCallback(
    async (offset: number) => {
      const qs = new URLSearchParams();
      if (kind) qs.set('kind', kind);
      if (search) qs.set('search', search);
      if (category) qs.set('category_id', category);
      qs.set('limit', String(PAGE));
      if (offset > 0) qs.set('offset', String(offset));
      return api.get<BundlesResponse>(`/api/bundles?${qs.toString()}`);
    },
    [kind, search, category]
  );

  const load = useCallback(async () => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchPage(0);
      if (reqIdRef.current !== reqId) return;
      setData(res);
      setMore((res.bundles ?? []).length >= PAGE);
    } catch (err) {
      if (reqIdRef.current !== reqId) return;
      setError(err);
    } finally {
      if (reqIdRef.current === reqId) setLoading(false);
    }
  }, [fetchPage]);

  const loadMore = useCallback(async () => {
    const reqId = reqIdRef.current;
    setLoadingMore(true);
    try {
      const offset = data?.bundles.length ?? 0;
      const res = await fetchPage(offset);
      if (reqIdRef.current !== reqId) return;
      const next = res.bundles ?? [];
      setData((prev) => (prev ? { ...prev, bundles: [...prev.bundles, ...next] } : res));
      setMore(next.length >= PAGE);
    } catch {
      // A failed "load more" costs the extra page, never the page already on
      // screen — the grid stays exactly as the customer left it.
      setMore(false);
    } finally {
      setLoadingMore(false);
    }
  }, [data, fetchPage]);

  useEffect(() => {
    load();
    return () => {
      reqIdRef.current += 1;
    };
  }, [load]);

  // The category facet reuses the taxonomy the home page already publishes;
  // a failure here silently costs the facet, never the page.
  useEffect(() => {
    let cancelled = false;
    api
      .get<{ categories?: HomeTaxon[] }>('/api/home')
      .then((r) => {
        if (!cancelled) setCategories(r.categories ?? []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Coming back to the tab — and a countdown reaching zero — re-ask the server
  // rather than leaving a stale lock or a negative clock on screen.
  useFreshOnReturn(load, { enabled: !loading, minIntervalMs: 8_000 });

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const all = useMemo(() => data?.bundles ?? [], [data]);
  /** The two client-side chips filter the SERVER'S OWN verdicts — they never
   *  compute one. `available` reads the state the server sent; `members` reads
   *  the gate it sent. */
  const shown = useMemo(
    () =>
      all.filter((b) => {
        if (onlyAvailable && !['in_stock', 'low', 'preorder', 'ending_soon', 'member_exclusive'].includes(b.availability_state)) {
          return false;
        }
        if (onlyMembers && b.offer.required_tiers.length === 0) return false;
        return true;
      }),
    [all, onlyAvailable, onlyMembers]
  );
  const featured = useMemo(() => shown.filter((b) => b.is_featured), [shown]);

  return (
    <div className="w-full pb-24 text-zinc-300 min-h-screen">
      <div className="sticky top-0 z-40 bg-black/80 backdrop-blur-xl border-b border-zinc-800/60 px-4 py-3 flex items-center gap-3">
        <button
          onClick={() => navigate(-1)}
          aria-label={loc('رجوع', 'Back', 'گەڕانەوە')}
          className="p-2 bg-zinc-900 rounded-full hover:bg-zinc-800 transition-colors"
        >
          {dir === 'rtl' ? <ArrowRight className="w-5 h-5" /> : <ArrowLeft className="w-5 h-5" />}
        </button>
        <h1 className="text-white font-bold text-lg">{s.title}</h1>
      </div>

      <div className="p-4 space-y-4">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setParam('search', searchDraft.trim());
          }}
          className="relative"
        >
          <Search aria-hidden className="absolute top-1/2 -translate-y-1/2 start-3 w-4 h-4 text-zinc-500" />
          <input
            type="search"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder={s.search}
            aria-label={s.search}
            className="w-full min-h-11 ps-9 pe-3 rounded-xl bg-zinc-900/60 border border-zinc-800 text-[14px] text-white placeholder:text-zinc-500 focus:border-olive focus:outline-none"
          />
        </form>

        <div className="flex gap-2 overflow-x-auto hide-scrollbar pb-1">
          <button className={`${CHIP} ${!kind ? CHIP_ON : CHIP_OFF}`} onClick={() => setParam('kind', '')}>
            {s.all}
          </button>
          <button className={`${CHIP} ${kind === 'bundle' ? CHIP_ON : CHIP_OFF}`} onClick={() => setParam('kind', 'bundle')}>
            {s.bundles}
          </button>
          <button className={`${CHIP} ${kind === 'mystery' ? CHIP_ON : CHIP_OFF}`} onClick={() => setParam('kind', 'mystery')}>
            {s.mystery}
          </button>
          <span aria-hidden className="w-px bg-zinc-800 shrink-0 my-1" />
          <button
            aria-pressed={onlyAvailable}
            className={`${CHIP} ${onlyAvailable ? CHIP_ON : CHIP_OFF}`}
            onClick={() => setParam('available', onlyAvailable ? '' : '1')}
          >
            {s.available}
          </button>
          <button
            aria-pressed={onlyMembers}
            className={`${CHIP} ${onlyMembers ? CHIP_ON : CHIP_OFF}`}
            onClick={() => setParam('members', onlyMembers ? '' : '1')}
          >
            {s.members}
          </button>
        </div>

        {categories.length > 0 && (
          <div className="flex gap-2 overflow-x-auto hide-scrollbar pb-1">
            <button className={`${CHIP} ${!category ? CHIP_ON : CHIP_OFF}`} onClick={() => setParam('category_id', '')}>
              {s.allCategories}
            </button>
            {categories.map((cat) => (
              <button
                key={cat.id}
                className={`${CHIP} ${category === cat.id ? CHIP_ON : CHIP_OFF}`}
                onClick={() => setParam('category_id', category === cat.id ? '' : cat.id)}
              >
                {lang === 'en' ? cat.name_en || cat.name_ar : lang === 'ckb' ? cat.name_ckb || cat.name_ar : cat.name_ar}
              </button>
            ))}
          </div>
        )}

        {loading && all.length === 0 ? (
          <BundleGridSkeleton count={6} />
        ) : error != null ? (
          <ErrorState error={error} onRetry={load} next="/bundles" />
        ) : shown.length === 0 ? (
          <EmptyState
            icon={<PackageSearch aria-hidden="true" className="w-6 h-6" />}
            title={s.empty}
            description={s.emptyHint}
          />
        ) : (
          <>
            {/* ONE featured offer is still a featured offer. `> 1` hid the
                rail the owner had explicitly marked a bundle for. */}
            {featured.length > 0 && (
              <section aria-label={s.featured}>
                <SectionHeader title={s.featured} accent="bg-gold" />
                <div
                  ref={featuredRail.ref}
                  className="flex gap-3 sm:gap-4 overflow-x-auto overscroll-x-contain hide-scrollbar pb-2 -mx-4 px-4 snap-x"
                >
                  {featured.map((b) => (
                    <div key={b.id} className="snap-start shrink-0 w-[164px] sm:w-[190px]">
                      <BundleTile b={b} onRevalidate={load} />
                    </div>
                  ))}
                </div>
              </section>
            )}

            <div
              aria-busy={loading}
              className={`grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4 transition-opacity ${
                loading ? 'opacity-50 pointer-events-none' : ''
              }`}
            >
              {shown.map((b) => (
                <BundleTile key={b.id} b={b} onRevalidate={load} />
              ))}
            </div>

            {/* The offset the route already accepts, given a control. */}
            {more && shown.length === all.length && (
              <div className="pt-4 text-center">
                <button
                  type="button"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  className="inline-flex items-center justify-center min-h-11 px-5 rounded-xl border border-zinc-700 bg-zinc-900 text-[13px] font-bold text-zinc-200 hover:border-zinc-500 transition-colors disabled:opacity-60"
                >
                  {loadingMore
                    ? loc('جارٍ التحميل…', 'Loading…', 'بارکردن…')
                    : loc('عرض المزيد', 'Load more', 'زیاتر پیشان بدە')}
                </button>
              </div>
            )}
          </>
        )}

        {/* The subscribe path stays exactly where it was for a signed-out or
            free viewer — but it is now an INVITATION beside a browsable page,
            not the whole page. */}
        {data && !data.entitled && all.some((b) => b.locked) && (
          <div className="max-w-md mx-auto text-center py-8 px-6 bg-zinc-900/50 rounded-2xl border border-zinc-800/50">
            <span className="mx-auto mb-3 w-11 h-11 rounded-2xl bg-gold/10 border border-gold/30 grid place-items-center">
              <Sparkles className="w-5 h-5 text-gold" />
            </span>
            <p className="text-[13px] text-zinc-400 mb-4 leading-relaxed">
              {loc(
                'بعض العروض هنا حصرية للمشتركين — الباقي متاح للجميع.',
                'Some offers here are members-only — the rest are open to everyone.',
                'هەندێک لەم پێشنیارانە تەنها بۆ ئەندامانن — ئەوانی تر بۆ هەمووانە.'
              )}
            </p>
            <Link
              to={data.signed_in ? '/subscription' : '/auth?next=/bundles'}
              className="inline-flex items-center justify-center min-h-11 px-5 rounded-xl bg-gold text-black text-sm font-black hover:brightness-110 transition-all"
            >
              {data.signed_in ? s.lockedCta : s.signIn}
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
