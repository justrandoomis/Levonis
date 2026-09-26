import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { ApiError } from '../lib/api';
import { ErrorState, NotFoundState } from '../components/ui/AsyncStates';
import { ProductGridSkeleton, Skeleton } from '../components/ui/Skeleton';
import ListingView, { type ListingScope } from '../components/listing/ListingView';
import PageTopBar from '../components/catalog/PageTopBar';
import CategoryRowBanners from '../components/catalog/CategoryRowBanners';
import { useBannerPhotos } from '../components/catalog/useBannerPhotos';
import { cachedTree, loadCategory, loadTree } from '../lib/catalog/data';
import { resolveListingRoute } from '../lib/catalog/listingModel';
import { nodeDescription, nodeName } from '../lib/catalog/categoryPageModel';
import { nounKindFor } from '../lib/catalog/copy';
import { bannerRows } from '../lib/catalog/explorerModel';
import { sectionTypeOf } from '../lib/catalog/listingModel';
import type { CatalogTreeNode, CatalogTreeResponse } from '../lib/catalog/types';

/**
 * `/categories/:categorySlug/:subCategorySlug` — ONE SECTION, AS A LIST
 * (docs/ux/CATALOG_DISCOVERY.md §2, §7).
 *
 * WHICH SECTION. `:sub` is a descendant's slug, or the reserved `all` for the
 * whole of `:cat` (the smart shelves' «عرض الكل» land there with their preset
 * filter: `/categories/printers/all?avail=1`). The live tree (cached for every
 * visitor) answers it; the server resolves by the LAST segment, so a parent
 * that does not match — or a section that moved — is a `replace` to the
 * canonical path with the query kept, never a 404. A slug the tree does not
 * know is asked of the category route, which also knows renamed slugs (owner
 * default Q11); only a slug nobody knows is «هذه الفئة غير موجودة».
 *
 * A SECTION WITH SECTIONS OF ITS OWN (a third level — the admin allows any
 * depth: «مواد الطباعة ‹ فيلمنت FDM ‹ فيلمنت PLA»): its children are drawn as
 * hero banners, one per row, above its list (owner, 2026-09-26 — the category
 * page's rule, src/components/catalog/CategoryRowBanners). A grandchild's URL
 * is `/categories/<root>/<slug>` like any sub-section's
 * (worker/lib/catalogPresentation.ts `path`), resolved here by its slug. Not on
 * a root's «all»: that is the whole list, asked for as such.
 */
export default function CategoryListing() {
  const { categorySlug = '', subCategorySlug = '' } = useParams();
  const location = useLocation();
  const { lang, loc } = useLanguage();
  const [tree, setTree] = useState<CatalogTreeResponse | null>(() => cachedTree());
  const [treeError, setTreeError] = useState<unknown>(null);
  const [fallback, setFallback] = useState<{ node: CatalogTreeNode; root: boolean } | 'missing' | null>(null);
  const [fallbackError, setFallbackError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(() => {
    setTreeError(null);
    loadTree()
      .then(setTree)
      .catch((e) => {
        if (!cachedTree()) setTreeError(e);
      });
  }, []);
  useEffect(load, [load]);

  const route = tree ? resolveListingRoute(tree.roots, categorySlug, subCategorySlug) : null;
  const shown = route ? (route.all ? null : route.node) : fallback && fallback !== 'missing' && !fallback.root ? fallback.node : null;
  const rows = useBannerPhotos(useMemo(() => bannerRows(shown?.children ?? [], []), [shown]));

  // Not in the tree: an inactive section that still has products, or an old slug.
  const lookup = subCategorySlug === 'all' ? categorySlug : subCategorySlug;
  useEffect(() => {
    if (!tree || route) return;
    let alive = true;
    setFallback(null);
    setFallbackError(null);
    loadCategory(lookup)
      .then((p) => alive && setFallback({ node: p.node, root: !p.node.parent_id }))
      .catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 404) setFallback('missing');
        else setFallbackError(e);
      });
    return () => {
      alive = false;
    };
  }, [tree, route, lookup, attempt]);

  // OWNER: Sorani to be written by hand (every loc() in this file without a third argument).
  if (treeError && !tree) {
    return (
      <Shell title={loc('الفئة', 'Category')}>
        <ErrorState error={treeError} onRetry={load} className="mt-6" />
      </Shell>
    );
  }
  if (fallbackError && !route) {
    return (
      <Shell title={loc('الفئة', 'Category')}>
        <ErrorState error={fallbackError} onRetry={() => setAttempt((n) => n + 1)} className="mt-6" />
      </Shell>
    );
  }
  if (!tree || (!route && fallback === null)) return <ListingSkeleton />;

  let node: CatalogTreeNode;
  let canonical: string;
  if (route) {
    node = route.node;
    canonical = route.canonical;
  } else if (fallback && fallback !== 'missing') {
    node = fallback.node;
    canonical = fallback.root ? `${fallback.node.path}/all` : fallback.node.path;
  } else {
    return (
      <Shell title={loc('الفئة', 'Category')}>
        <NotFoundState
          className="mt-6"
          title={loc('هذه الفئة غير موجودة', 'This category does not exist')}
          description={loc('ربما تغيّر اسمها أو أُزيلت. تصفّح الفئات الموجودة.', 'It may have been renamed or removed. Browse the categories there are.')}
        />
        <div className="flex justify-center">
          <Link to="/categories" className="lv-button lv-button-secondary">
            {loc('كل الفئات', 'All categories')}
          </Link>
        </div>
      </Shell>
    );
  }

  if (decodeURIComponent(location.pathname).replace(/\/+$/, '') !== decodeURIComponent(canonical)) {
    return <Navigate replace to={`${canonical}${location.search}`} />;
  }

  const scope: ListingScope = {
    category: node.id,
    title: nodeName(node, lang),
    description: nodeDescription(node, lang),
    kind: nounKindFor(node.product_type, node.is_printer_catalog),
    type: sectionTypeOf(node.product_type, node.is_printer_catalog),
    total: node.product_count,
  };
  // Keyed by section: another section is another list, not a refinement of this one.
  return (
    <div data-page="category-listing" className="min-h-full w-full bg-canvas pb-10 text-text-primary">
      <ListingView
        key={node.id}
        scope={scope}
        sections={
          rows.length ? (
            <CategoryRowBanners rows={rows} heading={loc(`أقسام ${scope.title}`, `${scope.title} sections`)} label={scope.title} />
          ) : undefined
        }
      />
    </div>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-full w-full bg-canvas pb-10 text-text-primary">
      <PageTopBar title={title} fallback="/categories" />
      <div className="mx-auto w-full max-w-[1200px] px-4 sm:px-6 lg:px-8">{children}</div>
    </div>
  );
}

/** The listing's own shape while the section is resolved: bar, search, toolbar, grid. */
function ListingSkeleton() {
  return (
    <div className="min-h-full w-full bg-canvas pb-10" aria-busy="true">
      <div className="flex h-14 items-center gap-2 px-4">
        <Skeleton className="size-10 rounded-full" />
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-16" />
        </div>
      </div>
      <div className="mx-auto w-full max-w-[1200px] px-4 sm:px-6 lg:px-8">
        <Skeleton className="mt-1 h-3 w-4/5" />
        <Skeleton className="mt-4 h-11 w-full rounded-xl" />
        <div className="mt-2 flex gap-2 py-1.5">
          <Skeleton className="h-[38px] w-24 rounded-[11px]" />
          <Skeleton className="h-[38px] w-32 rounded-[11px]" />
        </div>
        <ProductGridSkeleton count={6} density="compact" className="mt-10 grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4 xl:grid-cols-5 lg:gap-4" />
      </div>
    </div>
  );
}
