import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router-dom';
import { useLanguage } from '../LanguageContext';
import { ApiError, type ApiProduct } from '../lib/api';
import { ErrorState, NotFoundState } from '../components/ui/AsyncStates';
import { Skeleton, SkeletonGroup, ProductCardSkeleton } from '../components/ui/Skeleton';
import CompareBadge from '../components/compare/CompareBadge';
import PageTopBar from '../components/catalog/PageTopBar';
import TopBarSearch from '../components/catalog/TopBarSearch';
import CategoryHero from '../components/catalog/CategoryHero';
import ShelfJumpChips from '../components/catalog/ShelfJumpChips';
import ProductShelf from '../components/catalog/ProductShelf';
import BrandShelf from '../components/catalog/BrandShelf';
import FinderBand from '../components/catalog/FinderBand';
import RelatedCategories from '../components/catalog/RelatedCategories';
import CategoryRowBanners from '../components/catalog/CategoryRowBanners';
import { useBannerPhotos } from '../components/catalog/useBannerPhotos';
import { useScrolledPast } from '../components/catalog/useScrolledPast';
import ListingView from '../components/listing/ListingView';
import { cachedCategory, loadCategory } from '../lib/catalog/data';
import {
  categoryRedirect,
  heroPhoto,
  isPrinterNode,
  jumpChips,
  nodeDescription,
  nodeName,
  relatedHeading,
  shelfDomId,
  shelfSubline,
  shelfTitle,
} from '../lib/catalog/categoryPageModel';
import { bannerRows, type PhotoCandidate } from '../lib/catalog/explorerModel';
import { nounKindFor } from '../lib/catalog/copy';
import { sectionTypeOf } from '../lib/catalog/listingModel';
import type { CategoryPayload } from '../lib/catalog/types';
import '../styles/catalog.css';

/**
 * `/categories/:categorySlug` — A DEPARTMENT TO EXPLORE, NOT A LIST
 * (docs/ux/CATALOG_DISCOVERY.md §6, mockup 02). The owner: «صفحة استكشاف فئة،
 * وليست مجرد قائمة منتجات بسيطة» — a hero with a short description, then
 * organised sections, each with a title, «عرض الكل» and a horizontal shelf.
 *
 * ONE REQUEST. `GET /api/catalog/:slug` returns the section, its path, its
 * non-empty children and the shelves already grouped from one product read,
 * priced for this viewer. The page draws, in order: the hero; the section's
 * children as hero banners, ONE PER ROW (owner, 2026-09-26: «عند الضغط على
 * فيلمنت … تظهر فئات فرعية مثل فيلمنت PLA، PETG، ASA … بشكل هيرو بانر بسطر
 * واحد مستطيل» — src/components/catalog/CategoryRowBanners); the sticky shelf
 * index (with ≥ 2 shelves); one shelf per non-empty child; the smart shelves
 * the server found worth drawing («جاهزة للتسليم الآن», «للطباعة بأكثر من
 * لون», «حسب المادة»); the brands; the finder band (printers); and the other
 * departments. A section with nothing in it is never drawn — no Resin or Laser
 * frame waits for products that are not there.
 *
 * A DEPARTMENT WITH NO SUB-SECTIONS IS ITS OWN LISTING (§6, §15.2): ≤ 1
 * non-empty child and fewer than 8 products → a compact hero, its child's
 * banner, then the full listing (search, filters, sort) of the whole
 * department.
 *
 * REDIRECTS, NEVER DEAD ENDS: an old slug (renamed in the admin) replaces to
 * the canonical path; a leaf section replaces to its listing.
 */
export default function CategoryPage() {
  const { categorySlug = '' } = useParams();
  const location = useLocation();
  const { lang, loc } = useLanguage();
  const [payload, setPayload] = useState<CategoryPayload | null>(() => cachedCategory(categorySlug));
  const [error, setError] = useState<unknown>(null);
  const [heroEl, setHeroEl] = useState<HTMLElement | null>(null);
  const heroGone = useScrolledPast(heroEl);

  const load = useCallback(() => {
    const snap = cachedCategory(categorySlug);
    setPayload(snap);
    setError(null);
    loadCategory(categorySlug)
      .then(setPayload)
      .catch((e) => {
        if (!snap) setError(e);
      });
  }, [categorySlug]);
  useEffect(load, [load]);

  const chips = useMemo(() => (payload ? jumpChips(payload.shelves, lang) : []), [payload, lang]);
  // The children's banners borrow photographs from the page's own shelves,
  // never the product the hero already shows while another will do.
  const childRows = useMemo(() => {
    if (!payload) return [];
    const hero = heroPhoto(payload)?.productId;
    const cards = payload.shelves.flatMap((s) => (s.products ?? []) as PhotoCandidate[]);
    return bannerRows(payload.children, cards, new Set(hero ? [hero] : []));
  }, [payload]);
  const rows = useBannerPhotos(childRows);

  // OWNER: Sorani to be written by hand (every loc() in this page without a third argument).
  if (error) {
    const missing = error instanceof ApiError && error.status === 404;
    return (
      <div className="min-h-full w-full bg-canvas pb-10 text-text-primary">
        <PageTopBar title={loc('الفئة', 'Category')} fallback="/categories" />
        <div className="mx-auto w-full max-w-[1200px] px-4 sm:px-6 lg:px-8">
          {missing ? (
            <>
              <NotFoundState
                className="mt-6"
                title={loc('هذه الفئة غير موجودة', 'This category does not exist')}
                description={loc('ربما تغيّر اسمها أو أُزيلت، أو ليس فيها منتجات الآن.', 'It may have been renamed or removed, or it has no products right now.')}
              />
              <div className="flex justify-center">
                <Link to="/categories" className="lv-button lv-button-secondary">
                  {loc('كل الفئات', 'All categories')}
                </Link>
              </div>
            </>
          ) : (
            <ErrorState error={error} onRetry={load} className="mt-6" />
          )}
        </div>
      </div>
    );
  }
  if (!payload) return <CategorySkeleton />;

  const redirect = categoryRedirect(payload, decodeURIComponent(location.pathname));
  if (redirect && redirect !== location.pathname) return <Navigate replace to={`${redirect}${location.search}`} />;

  const { node } = payload;
  const name = nodeName(node, lang);
  const kind = nounKindFor(node.product_type, node.is_printer_catalog);
  const photo = heroPhoto(payload);
  const sectionsHeading = loc(`أقسام ${name}`, `${name} sections`);
  const topBar = (
    <PageTopBar
      title={name}
      titleVisible={heroGone}
      fallback="/categories"
      actions={
        <>
          <CompareBadge className="border border-border-subtle bg-surface text-text-primary" />
          <TopBarSearch />
        </>
      }
    />
  );

  if (payload.layout === 'listing') {
    return (
      <div data-page="category" data-layout="listing" className="min-h-full w-full bg-canvas pb-10 text-text-primary">
        {topBar}
        <ListingView
          key={node.id}
          ownTopBar={false}
          hero={<CategoryHero ref={setHeroEl} payload={payload} photo={photo} compact />}
          sections={rows.length ? <CategoryRowBanners rows={rows} heading={sectionsHeading} label={sectionsHeading} /> : undefined}
          scope={{
            category: node.id,
            title: name,
            description: nodeDescription(node, lang),
            kind,
            type: sectionTypeOf(node.product_type, node.is_printer_catalog),
            total: node.product_count,
          }}
        />
      </div>
    );
  }

  const brands = payload.brands;
  return (
    <div data-page="category" data-layout="shelves" className="min-h-full w-full bg-canvas pb-10 text-text-primary">
      {topBar}
      <div className="mx-auto w-full max-w-[1200px] px-4 sm:px-6 lg:px-8">
        <div className="pt-1.5">
          <CategoryHero ref={setHeroEl} payload={payload} photo={photo} />
        </div>

        <CategoryRowBanners rows={rows} heading={sectionsHeading} label={sectionsHeading} className="mt-5 lg:mt-8" />

        <div className="mt-2">
          <ShelfJumpChips chips={chips} label={loc(`أقسام ${name}`, `${name} sections`)} />
        </div>

        <div className="mt-4 flex flex-col gap-7 lg:mt-8 lg:gap-12">
          {payload.shelves.map((shelf) => {
            const id = shelfDomId(shelf);
            if (shelf.kind === 'brand') {
              return brands.length >= 2 ? (
                <ProductShelf key={shelf.id} id={id} title={shelfTitle(shelf, lang)}>
                  <BrandShelf brands={brands} basePath={node.path} kind={kind} />
                </ProductShelf>
              ) : null;
            }
            if (shelf.kind === 'material') {
              return (
                <ProductShelf key={shelf.id} id={id} title={shelfTitle(shelf, lang)} seeAll={shelf.see_all}>
                  <ul className="flex flex-wrap gap-1.5">
                    {(shelf.chips ?? []).map((c) => (
                      <li key={c.value}>
                        <Link to={c.see_all} className="group inline-flex min-h-11 items-center focus-visible:outline-none">
                          <span className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border-subtle bg-surface px-3.5 text-[13px] font-bold text-text-primary transition-colors group-hover:bg-surface-raised group-focus-visible:ring-2 group-focus-visible:ring-focus">
                            <span dir="ltr">{c.value}</span>
                            <span className="font-semibold tabular-nums text-text-muted">{c.count}</span>
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </ProductShelf>
              );
            }
            return (
              <ProductShelf
                key={shelf.id}
                id={id}
                title={shelfTitle(shelf, lang)}
                count={shelf.count}
                subline={shelfSubline(shelf, lang)}
                seeAll={shelf.see_all}
                products={shelf.products as ApiProduct[]}
              />
            );
          })}

          {isPrinterNode(node) ? <FinderBand /> : null}

          {payload.related.length ? (
            <section aria-labelledby="related-title">
              <h2 id="related-title" className="mb-3 text-[17px] font-extrabold leading-[26px] text-text-primary lg:mb-5 lg:text-[22px] lg:leading-8">
                {relatedHeading(node, lang)}
              </h2>
              <RelatedCategories nodes={payload.related} />
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The hero and two shelves, at their real sizes, so nothing moves when the page lands. */
function CategorySkeleton() {
  return (
    <div className="min-h-full w-full bg-canvas pb-10">
      <div className="flex h-14 items-center gap-2 px-4">
        <Skeleton className="size-10 rounded-full" />
      </div>
      <SkeletonGroup className="mx-auto w-full max-w-[1200px] px-4 pt-1.5 sm:px-6 lg:px-8">
        <Skeleton className="h-[252px] rounded-[22px] lg:h-[320px] lg:rounded-[28px]" />
        <div className="mt-3 flex gap-1.5 py-1.5">
          <Skeleton className="h-8 w-28 rounded-full" />
          <Skeleton className="h-8 w-24 rounded-full" />
          <Skeleton className="h-8 w-28 rounded-full" />
        </div>
        {[0, 1].map((k) => (
          <div key={k} className="mt-6 lg:mt-10">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="mt-2 h-3 w-64" />
            <div className="mt-3 flex gap-2.5 overflow-hidden lg:grid lg:grid-cols-5 lg:gap-4">
              {[0, 1, 2, 3, 4].map((i) => (
                <ProductCardSkeleton key={i} density="compact" className={`w-[148px] shrink-0 lg:w-auto ${i > 2 ? 'hidden lg:flex' : ''}`} />
              ))}
            </div>
          </div>
        ))}
      </SkeletonGroup>
    </div>
  );
}
