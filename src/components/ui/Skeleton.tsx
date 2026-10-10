import React from 'react';
import { useLanguage } from '../../LanguageContext';

/**
 * Unified skeleton system. Every skeleton mirrors the REAL dimensions of the
 * content it stands in for (aspect ratios reserved) so nothing jumps when the
 * data arrives, and none of them ever shows fake prices, names or ratings.
 *
 * Shimmer is Tailwind's subtle `animate-pulse`, disabled under
 * prefers-reduced-motion via `motion-reduce:animate-none`. Groups carry
 * aria-busy plus one polite, localized status message for screen readers;
 * the blocks themselves are aria-hidden.
 */

const STRINGS = {
  ar: { loading: 'جارٍ تحميل المحتوى' },
  en: { loading: 'Loading content' },
  ckb: { loading: 'ناوەڕۆک باردەکرێت' },
} as const;

/** Base shimmer block. Purely decorative — hidden from screen readers. */
/**
 * A `<span>`, not a `<div>`: the page skeletons draw their bars inside the
 * page's own `<p>` line boxes (so the loaded text lands on the same pixels),
 * and a `<p>` may hold phrasing content only — React warns «<div> cannot be a
 * descendant of <p>» and the HTML parser would close the paragraph early. It
 * lays out as a block unless the caller's classes set the display themselves
 * (`inline-block` for a line inside text).
 */
export function Skeleton({ className = '' }: { className?: string }) {
  const display = /(?:^|\s)(?:inline-block|inline-flex|inline|flex|grid|hidden)(?:\s|$)/.test(className) ? '' : 'block ';
  return (
    <span
      aria-hidden="true"
      className={`${display}bg-surface-selected rounded animate-pulse motion-reduce:animate-none ${className}`}
    />
  );
}

/** Accessibility wrapper: aria-busy container + one polite status message. */
export function SkeletonGroup({
  label,
  className = '',
  children,
}: {
  label?: string;
  className?: string;
  children: React.ReactNode;
}) {
  const { lang } = useLanguage();
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={className}>
      <span className="sr-only">{label || STRINGS[lang].loading}</span>
      {children}
    </div>
  );
}

/**
 * Mirrors the storefront product card (src/components/home/ProductCard.tsx).
 * `regular`: square image, two title lines, one price line. `compact`: the
 * compact card's exact geometry — 6:5 photo in its 4 px tray, 34 px name box, the price row,
 * the member row and the availability row — so the real card replaces it
 * without a single pixel of shift (262 px tall at 174 px wide).
 */
export function ProductCardSkeleton({
  className = '',
  density = 'regular',
}: {
  className?: string;
  density?: 'regular' | 'compact';
}) {
  if (density === 'compact') {
    return (
      <div
        aria-hidden="true"
        data-product-card-skeleton="compact"
        className={`flex flex-col overflow-hidden rounded-xl border border-border-subtle bg-surface ${className}`}
      >
        <div className="mx-1 mt-1 aspect-[6/5] rounded-lg bg-surface-selected animate-pulse motion-reduce:animate-none" />
        <div className="flex flex-1 flex-col px-2.5 pb-2.5 pt-[9px]">
          <div className="flex h-[34px] flex-col justify-center gap-1.5">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
          <div className="mt-1.5 flex h-5 items-center">
            <Skeleton className="h-3.5 w-24" />
          </div>
          <div className="mt-px flex h-[15px] items-center">
            <Skeleton className="h-2.5 w-20" />
          </div>
          <div className="mt-auto flex h-[22px] items-end">
            <Skeleton className="h-3 w-16" />
          </div>
        </div>
      </div>
    );
  }
  return (
    <div
      aria-hidden="true"
      className={`bg-surface border border-border-subtle rounded-xl overflow-hidden flex flex-col ${className}`}
    >
      <div className="aspect-square bg-surface-selected animate-pulse motion-reduce:animate-none" />
      <div className="p-3 flex flex-col flex-1 gap-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
        <div className="mt-auto pt-2">
          <Skeleton className="h-4 w-20" />
        </div>
      </div>
    </div>
  );
}

/** Mirrors the storefront product grid layout. */
export function ProductGridSkeleton({
  count = 8,
  className = 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4',
  density = 'regular',
}: {
  count?: number;
  className?: string;
  density?: 'regular' | 'compact';
}) {
  return (
    <SkeletonGroup className={className}>
      {Array.from({ length: count }, (_, i) => (
        <ProductCardSkeleton key={i} density={density} />
      ))}
    </SkeletonGroup>
  );
}

/** Mirrors the horizontal product row on Home (w-[180px] md:w-[200px] cards). */
export function ProductRowSkeleton({ count = 4 }: { count?: number }) {
  return (
    <SkeletonGroup className="flex gap-4 overflow-hidden pb-4">
      {Array.from({ length: count }, (_, i) => (
        <ProductCardSkeleton key={i} className="w-[180px] md:w-[200px] shrink-0" />
      ))}
    </SkeletonGroup>
  );
}

/**
 * Mirrors the Product detail page (src/pages/Product.tsx) box for box, so the
 * swap from loading to content moves nothing (P1c, docs/PERFORMANCE_LOG.md):
 * the page's own shell (`max-w-[1540px] px-4 pt-2`, the lg two-column grid),
 * the gallery frame at its responsive height, the thumbnail row, then every
 * text row drawn INSIDE a real line box — the same type classes around a
 * zero-width space — so it is exactly as tall as the words will be at every
 * breakpoint. Measured at 360: gallery 281, thumbs 68, title 28, store line
 * 18, signal chips 27, price card 66.
 */
const ZW = '\u200b';
function Line({ w, h = 'h-3' }: { w: string; h?: string }) {
  return (
    <>
      <Skeleton className={`inline-block align-middle ${h} ${w}`} />
      {ZW}
    </>
  );
}

export function ProductDetailSkeleton() {
  return (
    <SkeletonGroup>
      <div aria-hidden="true" className="mx-auto w-full max-w-[1540px] px-4 sm:px-6 xl:px-8 pt-2">
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_400px] xl:grid-cols-[minmax(0,1fr)_440px] lg:gap-8 xl:gap-12 lg:items-start">
          <div className="min-w-0">
            <div className="w-full h-[min(78vw,340px)] sm:h-[420px] lg:h-[520px] xl:h-[560px] rounded-2xl border border-border-subtle bg-surface overflow-hidden">
              <div className="w-full h-full bg-surface-selected animate-pulse motion-reduce:animate-none" />
            </div>
            <div className="mt-3 flex gap-2 pb-1">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="w-16 h-16 rounded-xl shrink-0" />
              ))}
            </div>
            <div className="mt-5">
              <p className="text-xl sm:text-2xl leading-snug">
                <Line w="w-3/4" h="h-5" />
              </p>
              <p className="mt-2 text-[12px] flex items-center gap-1.5">
                <Line w="w-32" h="h-2.5" />
              </p>
              <div className="mt-3 flex items-center gap-x-2 gap-y-1.5 flex-wrap">
                <span className="inline-flex items-center border border-border-subtle rounded-full px-2.5 py-1 text-[11px] leading-normal">
                  <Line w="w-16" h="h-2.5" />
                </span>
                <span className="inline-flex items-center border border-border-subtle rounded-full px-2.5 py-1 text-[11px] leading-normal">
                  <Line w="w-20" h="h-2.5" />
                </span>
              </div>
            </div>
            {/* The phone purchase panel: the price card, then the selection
                blocks and the order-type buttons a product carries. */}
            <div className="mt-5 space-y-3 lg:hidden">
              <div className="lv-surface p-4">
                <p className="text-2xl sm:text-3xl">
                  <Line w="w-1/2" h="h-6" />
                </p>
              </div>
              <Skeleton className="h-14 w-full rounded-xl" />
              <div className="flex gap-3">
                <Skeleton className="flex-1 h-12 rounded-xl" />
                <Skeleton className="flex-1 h-12 rounded-xl" />
              </div>
            </div>
            <div className="mt-6 space-y-3 max-w-[68ch]">
              <Skeleton className="h-14 w-full rounded-xl" />
              <Skeleton className="h-14 w-full rounded-xl" />
            </div>
          </div>
          {/* The desktop purchase panel's column. */}
          <div className="hidden lg:block">
            <div className="lv-surface p-4">
              <p className="text-2xl sm:text-3xl">
                <Line w="w-1/2" h="h-6" />
              </p>
            </div>
            <Skeleton className="mt-3 h-14 w-full rounded-xl" />
            <Skeleton className="mt-3 h-12 w-full rounded-xl" />
          </div>
        </div>
      </div>
    </SkeletonGroup>
  );
}

/** Mirrors the Cart list: group header + item rows (checkbox, 100px image, lines). */
export function CartSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <SkeletonGroup className="bg-black border-y border-zinc-900/50 pb-4">
      <div className="px-4 py-3" aria-hidden="true">
        <Skeleton className="h-5 w-28" />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="px-4 py-2 flex gap-3" aria-hidden="true">
          <div className="pt-8 shrink-0">
            <Skeleton className="w-[22px] h-[22px] rounded-full" />
          </div>
          <Skeleton className="w-[100px] h-[100px] rounded-lg shrink-0" />
          <div className="flex-1 flex flex-col gap-2 pt-1">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-5 w-24 mt-1" />
            {/* The journey chip and, on a printer line, the collapsed
                "Extended Warranty" disclosure (36px) — mirrored so the row
                keeps its height when the line turns out to be a printer. */}
            <Skeleton className="h-9 w-40 rounded-lg" />
            <div className="flex items-center justify-between mt-auto">
              <Skeleton className="h-8 w-24" />
              <Skeleton className="h-8 w-14" />
            </div>
          </div>
        </div>
      ))}
    </SkeletonGroup>
  );
}

/**
 * Mirrors the bundle card (src/pages/Bundles.tsx): square cover, two title
 * lines, the included-items strip, and TWO price lines — the bundle price and
 * the struck component total beneath it. A one-line price skeleton under a
 * two-line price block is a jump on every card in the grid.
 */
export function BundleCardSkeleton({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`bg-surface border border-border-subtle rounded-xl overflow-hidden flex flex-col ${className}`}
    >
      <div className="aspect-square bg-surface-selected animate-pulse motion-reduce:animate-none" />
      <div className="p-3 flex flex-col flex-1 gap-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
        <div className="flex gap-1.5 pt-1">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="w-8 h-8 rounded-lg" />
          ))}
        </div>
        <div className="mt-auto pt-2 flex flex-col gap-1.5">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3 w-16" />
        </div>
      </div>
    </div>
  );
}

/** Mirrors the bundle grid layout of src/pages/Bundles.tsx. */
export function BundleGridSkeleton({
  count = 6,
  className = 'grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4',
}: {
  count?: number;
  className?: string;
}) {
  return (
    <SkeletonGroup className={className}>
      {Array.from({ length: count }, (_, i) => (
        <BundleCardSkeleton key={i} />
      ))}
    </SkeletonGroup>
  );
}

/**
 * Mirrors the bundle detail page: hero, title, price block, the "what is
 * inside" list (four component rows) and the sticky purchase bar's height.
 */
export function BundleDetailSkeleton() {
  return (
    <SkeletonGroup className="w-full">
      <div aria-hidden="true" className="h-64 sm:h-80 bg-surface-selected animate-pulse motion-reduce:animate-none" />
      <div className="p-4 space-y-4">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <div className="bg-surface border border-border-subtle rounded-2xl p-4 space-y-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="space-y-2">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 bg-surface border border-border-subtle rounded-xl p-3">
              <Skeleton className="w-12 h-12 rounded-lg shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </SkeletonGroup>
  );
}
