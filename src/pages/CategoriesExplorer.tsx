import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { LayoutGrid } from 'lucide-react';
import { useLanguage } from '../LanguageContext';
import { api, fetchGradedStock, type ApiProduct } from '../lib/api';
import { ErrorState, EmptyState } from '../components/ui/AsyncStates';
import { Skeleton, SkeletonGroup } from '../components/ui/Skeleton';
import PageTopBar from '../components/catalog/PageTopBar';
import TopBarSearch from '../components/catalog/TopBarSearch';
import CategoryRowBanners, { CategoryRowBanner } from '../components/catalog/CategoryRowBanners';
import { useBannerPhotos } from '../components/catalog/useBannerPhotos';
import DiscoveryFooterTiles from '../components/catalog/DiscoveryFooterTiles';
import { useScrolledPast } from '../components/catalog/useScrolledPast';
import { cachedTree, loadPhotoPool, loadTree } from '../lib/catalog/data';
import { bannerRows, photoOf, type BannerPhoto, type PhotoCandidate } from '../lib/catalog/explorerModel';
import { countNoun, explorerSubline } from '../lib/catalog/copy';
import type { CatalogTreeResponse } from '../lib/catalog/types';

/**
 * «كل الفئات» — THE CATEGORY EXPLORER (docs/ux/CATALOG_DISCOVERY.md §5,
 * mockup 04). The owner: «Category Explorer Page وليست مجرد صفحة روابط», and
 * on 2026-09-26: «تظهر الفئات بشكل مستطيل مثل الهيرو بانر … في سطر واحد لكل
 * فئة» — a wide hero banner per category, ONE PER ROW, with a strong
 * photograph, its name, its counts and a «استكشف ←» pill
 * (src/components/catalog/CategoryRowBanners).
 *
 * WHAT IS DRAWN COMES FROM THE LIVE TREE (`GET /api/catalog/tree`): one banner
 * per root that holds products, in the admin's order. A root's sub-sections
 * are its own page's banners, not chips here. «المستعمل» and «الباقات» join
 * the stack only while they have stock (owner default Q10). Nothing empty is
 * ever drawn.
 *
 * PHOTOGRAPHS ARRIVE SECOND. The tree carries the admin's own pictures; a
 * section without one borrows a product photograph (available now first, never
 * the same product twice) from one shared read of the catalogue, and a section
 * that read did not cover asks for its own four. The banners are drawn — words,
 * counts and all — before any photograph lands, and each picture fades into a
 * box whose size never changes.
 *
 * STATES: banner-shaped skeletons (one per row) while the tree loads; the
 * last snapshot with a quiet note if a refresh fails; `ErrorState` with retry
 * when there is nothing to show; «لا توجد فئات بعد» with a way to every product
 * when the shop has no stocked section at all.
 */
export default function CategoriesExplorer() {
  const { lang, loc } = useLanguage();
  const [tree, setTree] = useState<CatalogTreeResponse | null>(() => cachedTree());
  const [error, setError] = useState<unknown>(null);
  const [stale, setStale] = useState(false);
  const [pool, setPool] = useState<PhotoCandidate[]>([]);
  const [poolSettled, setPoolSettled] = useState(false);
  const [heading, setHeading] = useState<HTMLHeadingElement | null>(null);
  const headingGone = useScrolledPast(heading);
  const [extras, setExtras] = useState<{ used: ApiProduct[]; bundles: Array<{ id: string; image: string }> }>({ used: [], bundles: [] });

  const load = useCallback(async () => {
    setError(null);
    try {
      setTree(await loadTree());
      setStale(false);
    } catch (e) {
      // A snapshot on screen is a real answer; keep it and say it is the last one.
      if (cachedTree()) setStale(true);
      else setError(e);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Photographs and the two conditional banners: after the map, never before it.
  useEffect(() => {
    let alive = true;
    loadPhotoPool()
      .then((p) => alive && setPool(p))
      .catch(() => undefined)
      .finally(() => alive && setPoolSettled(true));
    fetchGradedStock({ mascot: 'silent' })
      .then((used) => alive && setExtras((x) => ({ ...x, used: used as ApiProduct[] })))
      .catch(() => undefined);
    api
      .get<{ bundles?: Array<{ id: string; image: string }> }>('/api/bundles?limit=4', { mascot: 'silent' })
      .then((b) => alive && setExtras((x) => ({ ...x, bundles: Array.isArray(b.bundles) ? b.bundles : [] })))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const roots = useMemo(() => tree?.roots ?? [], [tree]);
  const baseRows = useMemo(() => bannerRows(roots, pool), [roots, pool]);
  // A section the shared pool did not cover asks for its own photographs.
  const rows = useBannerPhotos(baseRows, poolSettled);

  const title = loc('كل الفئات', 'All categories');
  // OWNER: Sorani to be written by hand (every loc() in this page without a third argument).
  const productTotal = tree?.totals.products ?? 0;

  const extraBanners: Array<{ id: string; to: string; title: string; description: string; count: string; photo: BannerPhoto | null }> = [];
  if (extras.used.length > 0) {
    const first = extras.used.find((p) => photoOf(p));
    extraBanners.push({
      id: 'used',
      to: '/used-printers',
      title: loc('المنتجات المستعملة', 'Pre-owned'),
      description: loc('مستعمل ومجدّد و Open Box، بحالة موصوفة بصدق.', 'Used, refurbished and open box, honestly graded.'),
      count: countNoun(extras.used.length, 'product', lang),
      photo: first ? { src: photoOf(first), productPhoto: true, productId: first.id } : null,
    });
  }
  if (extras.bundles.length > 0) {
    const first = extras.bundles.find((b) => b.image);
    extraBanners.push({
      id: 'bundles',
      to: '/bundles',
      title: loc('الباقات', 'Bundles'),
      description: loc('طابعة مع ما تحتاجه معها، بسعر واحد.', 'A printer with what it needs, at one price.'),
      count: countNoun(extras.bundles.length, 'product', lang),
      photo: first ? { src: first.image, productPhoto: true, productId: null } : null,
    });
  }

  return (
    <div data-page="categories-explorer" className="min-h-full w-full bg-canvas pb-10 text-text-primary">
      <PageTopBar title={title} titleVisible={headingGone} actions={<TopBarSearch />} />

      <div className="mx-auto w-full max-w-[1200px] px-4 sm:px-6 lg:px-8">
        <header className="pb-1 pt-1.5 lg:pb-3 lg:pt-4">
          <h1 ref={setHeading} className="text-[27px] font-extrabold leading-[38px] tracking-[-0.01em] text-text-primary lg:text-[40px] lg:leading-[52px]">{title}</h1>
          <p aria-live="polite" className="min-h-5 text-[13px] leading-5 text-text-muted lg:text-[15px] lg:leading-6">
            {tree ? explorerSubline(roots.length, productTotal, lang) : ' '}
          </p>
          {stale ? (
            <p role="status" className="mt-2 inline-flex rounded-full bg-surface-selected px-3 py-1 text-[12px] font-semibold text-text-secondary">
              {loc('تعرض آخر نسخة محفوظة', 'Showing the last saved copy')}
            </p>
          ) : null}
        </header>

        {!tree && !error ? (
          <ExplorerSkeleton />
        ) : error ? (
          <ErrorState error={error} onRetry={load} className="mt-6" />
        ) : rows.length === 0 ? (
          <EmptyState
            className="mt-6"
            icon={<LayoutGrid aria-hidden="true" className="size-6" />}
            title={loc('لا توجد فئات بعد', 'No categories yet')}
            action={
              <Link
                to="/products"
                className="lv-button lv-button-secondary mt-1"
              >
                {loc('كل المنتجات', 'All products', 'هەموو بەرهەمەکان')}
              </Link>
            }
          />
        ) : (
          <div className="mt-3 flex flex-col gap-2.5 lg:mt-4 lg:gap-4">
            <CategoryRowBanners rows={rows} label={title} eagerFirst />
            {extraBanners.length ? (
              <ul className="flex flex-col gap-2.5 lg:gap-4">
                {extraBanners.map((x) => (
                  <li key={x.id}>
                    <CategoryRowBanner
                      to={x.to}
                      title={x.title}
                      line={x.count}
                      detail={x.description}
                      cta={loc('تسوق الآن', 'Shop now')}
                      photo={x.photo}
                      rowKey={x.id}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}

        {tree && rows.length > 0 ? (
          <div className="mt-7 lg:mt-12">
            <DiscoveryFooterTiles />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ExplorerSkeleton() {
  return (
    <SkeletonGroup className="mt-3 flex flex-col gap-2.5 lg:mt-4 lg:gap-4">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="aspect-[8/3] max-h-[150px] min-h-[112px] w-full rounded-2xl sm:aspect-[4/1] sm:max-h-[170px] lg:aspect-[5/1] lg:max-h-[200px] lg:rounded-[20px]" />
      ))}
    </SkeletonGroup>
  );
}
