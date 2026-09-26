import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { PackageSearch } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { ErrorState, EmptyState } from '../ui/AsyncStates';
import { ProductGridSkeleton } from '../ui/Skeleton';
import Spinner from '../ui/Spinner';
import CompareBadge from '../compare/CompareBadge';
import PageTopBar from '../catalog/PageTopBar';
import ListingToolbar, { type ListingView as ViewMode } from './ListingToolbar';
import QuickFilterChips from './QuickFilterChips';
import AppliedFilterChips from './AppliedFilterChips';
import ResultCount from './ResultCount';
import ProductGrid from './ProductGrid';
import ProductList from './ProductList';
import LoadMore from './LoadMore';
import EmptyFiltered from './EmptyFiltered';
import ScopedSearch from './ScopedSearch';
import SortSheet from './SortSheet';
import ShareButton from './ShareButton';
import { useListing } from './useListing';
import { activeFilterCount, hasListingFilters } from '../../lib/catalog/listingQuery';
import {
  appliedChips,
  clearFilters,
  quickChips,
  sheetSections,
  sortExplanation,
  undoOptions,
  type SectionType,
} from '../../lib/catalog/listingModel';
import { countNoun, resultCountLabel, type NounKind } from '../../lib/catalog/copy';

const loadFilterSheet = () => import('./FilterSheet');
const FilterSheet = React.lazy(loadFilterSheet);
const FilterPanel = React.lazy(() => import('./FilterPanel'));

/** What a listing lists and how it talks about it. */
export interface ListingScope {
  /** The `/api/products?category=` value (a catalog id), or null for every product. */
  category: string | null;
  title: string;
  description: string;
  kind: NounKind;
  type: SectionType;
  /** The section's unfiltered product count, for «4 من 10»; null when unknown. */
  total: number | null;
}

const VIEW_KEY = 'levonis.listing.view.v1';

function readView(): ViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

/**
 * THE SPECIALISED LISTING (docs/ux/CATALOG_DISCOVERY.md §7, mockups 03a/03b).
 * The owner: «عملية جدًا وسهلة على الجوال».
 *
 *   top bar      title, the live count («4 من 10 طابعات»), share, the compare
 *                badge — or, embedded in a category page, that page's own bar;
 *   intro        the section's description;
 *   search       scoped to this section;
 *   toolbar      sticky: «التصفية» (+ badge), «الترتيب: …», grid / list;
 *   chips        the one-tap filters, then what is applied (removable);
 *   count        «10 طابعات» · what the order means (a live region);
 *   results      the compact-card grid (the «بطلب مسبق» divider under the
 *                default order) or the list, «عرض المزيد», or — at zero — the
 *                way back, one filter at a time, with counts.
 *
 * From 1024 px the filters are a sticky side column (the same sections, live)
 * and the sheet is not used. Every control writes the URL (useListing), so
 * «back» from a product restores the filters, the loaded pages and the
 * scroll offset.
 */
export default function ListingView({
  scope,
  ownTopBar = true,
  hero,
  sections,
}: {
  scope: ListingScope;
  /** False when the page around it (a category page) draws its own top bar. */
  ownTopBar?: boolean;
  /** A compact hero drawn above the search, for a category that is its own listing. */
  hero?: React.ReactNode;
  /**
   * The section's own sub-sections as banner rows
   * (src/components/catalog/CategoryRowBanners), drawn under the hero and the
   * description, above the search: the doors further in come before the list.
   */
  sections?: React.ReactNode;
}) {
  const { lang, loc } = useLanguage();
  const { state, commit, data, loading, error, retry, loadMore, more } = useListing(scope.category);
  const wide = useMediaQuery('(min-width: 1024px)');
  const [view, setView] = useState<ViewMode>(() => readView());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filtersArmed, setFiltersArmed] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const filterButton = useRef<HTMLButtonElement>(null);

  const chooseView = useCallback((v: ViewMode) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* private mode: the choice lasts the visit */
    }
  }, []);

  // The sheet is a phone and tablet control; a window widened past 1024 px closes it.
  useEffect(() => {
    if (wide) setFiltersOpen(false);
  }, [wide]);

  const facets = data?.facets ?? null;
  const filtered = hasListingFilters(state);
  // A section whose products do not differ on anything has nothing to filter by:
  // no button to an empty sheet, no empty column.
  const canFilter = !facets || filtered || sheetSections(scope.type, facets, state).length > 0;
  const column = wide && canFilter;
  const narrowed = filtered || state.q.trim() !== '';
  const ctx = useMemo(() => ({ lang, facets }), [lang, facets]);
  const quick = useMemo(() => quickChips(scope.type, facets, state, lang), [scope.type, facets, state, lang]);
  const applied = useMemo(() => appliedChips(state, ctx), [state, ctx]);
  const total = data?.total ?? null;
  const countText = total === null ? '' : resultCountLabel(total, narrowed ? scope.total : null, scope.kind, lang);
  const clear = () => commit(clearFilters(state));

  // OWNER: Sorani to be written by hand (every loc() in this file without a third argument).
  const placeholder =
    lang === 'en' ? `Search ${scope.title}` : `ابحث في ${scope.title}`;

  let results: React.ReactNode;
  if (!data && error) {
    results = <ErrorState error={error} onRetry={retry} className="mt-4" />;
  } else if (!data) {
    results = (
      <ProductGridSkeleton
        count={8}
        density="compact"
        className={`grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 ${column ? 'lg:grid-cols-3 xl:grid-cols-4' : 'lg:grid-cols-4 xl:grid-cols-5'} lg:gap-4`}
      />
    );
  } else if (data.total === 0 && !loading) {
    results = filtered ? (
      <EmptyFiltered options={undoOptions(state, ctx)} category={scope.category} kind={scope.kind} onChange={commit} onClear={clear} />
    ) : state.q ? (
      <EmptyState
        className="mt-4"
        icon={<PackageSearch aria-hidden="true" className="size-6" />}
        title={loc(`لا نتائج لـ «${state.q}» هنا`, `Nothing for “${state.q}” here`)}
        description={loc('جرّب كلمة أخرى، أو ابحث في المتجر كله.', 'Try another word, or search the whole shop.')}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <button type="button" className="lv-button lv-button-secondary" onClick={() => commit({ ...state, q: '' })}>
              {loc('مسح البحث', 'Clear search')}
            </button>
            <Link className="lv-button lv-button-ghost" to={`/products?search=${encodeURIComponent(state.q)}`}>
              {loc('ابحث في المتجر كله', 'Search the whole shop')}
            </Link>
          </div>
        }
      />
    ) : (
      <EmptyState
        className="mt-4"
        icon={<PackageSearch aria-hidden="true" className="size-6" />}
        title={loc('لا توجد منتجات في هذا القسم بعد', 'Nothing in this section yet')}
        description={loc('تصفّح الفئات الأخرى، وسنضيف هنا قريبًا.', 'Browse the other categories in the meantime.')}
        action={
          <Link className="lv-button lv-button-secondary" to="/categories">
            {loc('كل الفئات', 'All categories')}
          </Link>
        }
      />
    );
  } else {
    const list =
      view === 'list' ? (
        <ProductList products={data.products} />
      ) : (
        <ProductGrid products={data.products} divider={state.sort === 'relevance' && !state.q} withColumn={column} />
      );
    results = (
      <div className="relative">
        {loading ? (
          <div className="pointer-events-none absolute inset-x-0 top-10 z-10 flex justify-center">
            <Spinner size="md" className="rounded-full bg-surface-raised p-2 shadow-2" />
          </div>
        ) : null}
        <div aria-busy={loading || undefined} className={`transition-opacity duration-150 ${loading ? 'pointer-events-none opacity-50' : ''}`}>
          {list}
        </div>
        {data.truncated ? (
          <p className="mt-4 text-center text-[12px] text-text-muted">
            {loc('تعرض القائمة أول 300 منتج من هذا القسم. ضيّق البحث لترى ما بعدها.', 'This list covers the first 300 products here. Narrow it to see the rest.')}
          </p>
        ) : null}
        <LoadMore remaining={Math.max(0, data.total - data.products.length)} state={more} onMore={loadMore} />
      </div>
    );
  }

  return (
    <div data-listing className="w-full">
      {ownTopBar ? (
        <PageTopBar
          title={scope.title}
          subtitle={countText || (scope.total !== null ? countNoun(scope.total, scope.kind, lang) : undefined)}
          actions={
            <>
              <CompareBadge className="border border-border-subtle bg-surface text-text-primary" />
              <ShareButton title={scope.title} />
            </>
          }
          fallback="/categories"
        />
      ) : null}

      <div className="mx-auto w-full max-w-[1200px] px-4 sm:px-6 lg:px-8">
        {hero ? <div className="pt-1.5">{hero}</div> : null}
        {ownTopBar && scope.description ? (
          <p className="line-clamp-2 pt-1 text-[12.5px] leading-[19px] text-text-muted lg:max-w-[70ch] lg:text-[14px] lg:leading-6">{scope.description}</p>
        ) : null}
        {sections ? <div className="pt-4 lg:pt-6">{sections}</div> : null}

        <div className="pt-3">
          <ScopedSearch value={state.q} placeholder={placeholder} onChange={(q) => commit({ ...state, q })} />
        </div>

        <div className="sticky top-14 z-20 -mx-4 bg-canvas/[0.92] px-4 py-1 backdrop-blur-lg sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
          <ListingToolbar
            ref={filterButton}
            activeCount={activeFilterCount(state)}
            sort={state.sort}
            view={view}
            showFilterButton={!wide && canFilter}
            onFilters={() => {
              setFiltersArmed(true);
              setFiltersOpen(true);
            }}
            onFiltersIntent={() => void loadFilterSheet()}
            onSort={() => setSortOpen(true)}
            onView={chooseView}
          />
        </div>

        <div className={column ? 'grid grid-cols-[264px_minmax(0,1fr)] items-start gap-8' : ''}>
          {column ? (
            <aside
              aria-label={loc('التصفية', 'Filters')}
              data-filter-column
              className="sticky top-[118px] max-h-[calc(100dvh-140px)] overflow-y-auto overscroll-contain rounded-2xl border border-border-subtle bg-surface px-4 pb-2 pt-3 hide-scrollbar"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-[15px] font-extrabold text-text-primary">{loc('التصفية', 'Filters')}</h2>
                {filtered ? (
                  <button type="button" onClick={clear} className="min-h-11 rounded-lg px-1 text-[12.5px] font-bold text-gold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                    {loc('مسح الكل', 'Clear all')}
                  </button>
                ) : null}
              </div>
              {facets ? (
                <Suspense fallback={<div className="h-40" />}>
                  <FilterPanel facets={facets} state={state} onChange={commit} type={scope.type} />
                </Suspense>
              ) : (
                <div className="flex h-40 items-center justify-center">
                  <Spinner size="sm" />
                </div>
              )}
            </aside>
          ) : null}

          <div className="min-w-0">
            <div className="flex flex-col gap-0">
              <QuickFilterChips chips={quick} onChange={commit} />
              <AppliedFilterChips chips={applied} onChange={commit} onClear={clear} />
            </div>
            {data && !(data.total === 0 && !loading) ? (
              <ResultCount count={countText} explanation={sortExplanation(state.sort, !!state.q, lang)} busy={loading} />
            ) : (
              <div className="h-8" />
            )}
            {results}
          </div>
        </div>
      </div>

      {filtersArmed && facets ? (
        <Suspense fallback={null}>
          <FilterSheet
            open={filtersOpen}
            onClose={() => setFiltersOpen(false)}
            applied={state}
            facets={facets}
            category={scope.category}
            type={scope.type}
            kind={scope.kind}
            onApply={commit}
          />
        </Suspense>
      ) : null}
      <SortSheet open={sortOpen} onClose={() => setSortOpen(false)} value={state.sort} hasQuery={!!state.q} onChange={(sort) => commit({ ...state, sort })} />
    </div>
  );
}
