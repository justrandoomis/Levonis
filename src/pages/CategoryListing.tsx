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
import { cachedTree, loadCategory, loadSectionCounts, loadTree } from '../lib/catalog/data';
import { listingTarget, resolveListingRoute } from '../lib/catalog/listingModel';
import { listingFirstPagePath, parseListing } from '../lib/catalog/listingQuery';
import { listingCategory, listsBySlug, primeGet } from '../lib/bootFetch';
import { nodeDescription, nodeName } from '../lib/catalog/categoryPageModel';
import { nounKindFor, type SectionStock } from '../lib/catalog/copy';
import { bannerRows } from '../lib/catalog/explorerModel';
import { CATEGORY_PAGE_CAP, listingStockWord, rememberSectionStock, rememberedSectionStock, withStock } from '../lib/catalog/sectionStock';
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
 *
 * THE LIST DOES NOT WAIT FOR THE MAP. It is asked for by the section's slug —
 * the URL's own word — so it leaves beside the tree instead of after it
 * (speed audit 2026-10-16: tree 4.5 s → list 4.9–5.8 s on a phone); the
 * listing (src/components/listing/useListing.ts) takes that request when it
 * mounts. On a cold load or a press of the link both left earlier still
 * (src/lib/bootFetch.ts `categoryOpeningPaths`).
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

  // While the map loads, the list leaves too — by slug, with the URL's filters.
  // With the map already here the listing mounts at once and asks for itself.
  const listSlug = subCategorySlug === 'all' ? categorySlug : subCategorySlug;
  const listPath = listingFirstPagePath(parseListing(location.search), listSlug);
  useEffect(() => {
    if (!tree && listSlug && listsBySlug(listSlug)) primeGet(listPath);
  }, [tree, listPath, listSlug]);

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

  // THE SECTION'S STOCK, EXACT (owner, 2026-11-11; DECISIONS rows 309 and 311). The map stops counting stock
  // past its cap (worker/routes/catalog.ts TREE_AVAILABILITY_CAP; the live shop is past it), so its rows would
  // say nothing; the section's counts (`/api/catalog/:slug/counts`) count every product of its subtree from
  // the cards' own states, up to CATEGORY_PAGE_CAP — one small answer, the same for every viewer and cached
  // for all, not a build of the whole page. Asked only when the map did not count and the section is small
  // enough to be exact; a decoration, so a failure simply leaves the line without it.
  const stockSlug =
    shown && (typeof shown.available_count !== 'number' || shown.preorder_count === undefined) && shown.product_count <= CATEGORY_PAGE_CAP
      ? shown.slug
      : null;
  const [stock, setStock] = useState<{ slug: string; counts: Map<string, SectionStock> } | null>(null);
  useEffect(() => {
    if (!stockSlug || !shown) return;
    const ids = [shown.id, ...(shown.children ?? []).map((c) => c.id)];
    const known = rememberedSectionStock(ids);
    if (known) {
      setStock({ slug: stockSlug, counts: known });
      return;
    }
    let alive = true;
    // Silent, by id when the slug is too long to ask by: the page is already drawn, this only adds a word.
    // Every visible descendant comes with it, so opening a child from here asks nothing again for a minute.
    loadSectionCounts(listingCategory(shown))
      .then((p) => {
        rememberSectionStock(p.counts);
        if (!alive) return;
        const counts = new Map<string, SectionStock>();
        for (const n of p.counts) counts.set(n.id, n);
        setStock({ slug: stockSlug, counts });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [stockSlug, shown]);
  const rows = useBannerPhotos(
    useMemo(() => {
      const counts = stock && stock.slug === shown?.slug ? stock.counts : null;
      return bannerRows((shown?.children ?? []).map((c) => withStock(c, counts)), []);
    }, [shown, stock])
  );

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

  // From the map, or from the category route for a section the map leaves out (an inactive root's «all» too).
  const target = listingTarget(route, fallback);
  if (!target) {
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
  const { node, canonical } = target;

  if (decodeURIComponent(location.pathname).replace(/\/+$/, '') !== decodeURIComponent(canonical)) {
    return <Navigate replace to={`${canonical}${location.search}`} />;
  }

  const kind = nounKindFor(node.product_type, node.is_printer_catalog);
  const scope: ListingScope = {
    // By slug: the request that left beside the map is this one (by id when
    // the slug is too long to ask by, and nothing left early).
    category: listingCategory(node),
    title: nodeName(node, lang),
    description: nodeDescription(node, lang),
    kind,
    type: sectionTypeOf(node.product_type, node.is_printer_catalog),
    total: node.product_count,
    // «17 منتجًا · 1 متوفر الآن», «5 منتجات · بطلب مسبق» (row 309): only for a section, never a root's «all» —
    // the map's root or an inactive one the category route answered.
    stock: listingStockWord(target, stock && stock.slug === node.slug ? stock.counts : null, lang),
  };
  // Keyed by section: another section is another list, not a refinement of this one.
  return (
    <div data-page="category-listing" className="min-h-full w-full pb-10 text-text-primary">
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
    <div className="min-h-full w-full pb-10 text-text-primary">
      <PageTopBar title={title} fallback="/categories" />
      <div className="mx-auto w-full max-w-[1200px] px-4 sm:px-6 lg:px-8">{children}</div>
    </div>
  );
}

/** The listing's own shape while the section is resolved: bar, search, toolbar, grid. */
function ListingSkeleton() {
  return (
    <div className="min-h-full w-full pb-10" aria-busy="true">
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
          <Skeleton className="h-[38px] w-24 rounded-sm" />
          <Skeleton className="h-[38px] w-32 rounded-sm" />
        </div>
        <ProductGridSkeleton count={6} density="compact" className="mt-10 grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4 xl:grid-cols-5 lg:gap-4" />
      </div>
    </div>
  );
}
