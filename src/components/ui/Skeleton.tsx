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
export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`bg-zinc-800/60 rounded animate-pulse motion-reduce:animate-none ${className}`}
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
 * Mirrors the storefront product card (Products.tsx / Home.tsx renderProductCard):
 * square image, two title lines, one price line.
 */
export function ProductCardSkeleton({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden flex flex-col ${className}`}
    >
      <div className="aspect-square bg-zinc-800/60 animate-pulse motion-reduce:animate-none" />
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
}: {
  count?: number;
  className?: string;
}) {
  return (
    <SkeletonGroup className={className}>
      {Array.from({ length: count }, (_, i) => (
        <ProductCardSkeleton key={i} />
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
 * Mirrors the Product detail page: h-80 hero, action row, title/description
 * lines, price card, the two order-type buttons and two accordion headers.
 */
export function ProductDetailSkeleton() {
  return (
    <SkeletonGroup>
      <div aria-hidden="true">
        <div className="w-full h-80 bg-zinc-900 rounded-b-3xl overflow-hidden">
          <div className="w-full h-full bg-zinc-800/40 animate-pulse motion-reduce:animate-none" />
        </div>
        <div className="px-4 py-5">
          <div className="flex justify-between items-center mb-4">
            <div className="flex items-center gap-2">
              <Skeleton className="w-10 h-10 rounded-full" />
              <Skeleton className="w-10 h-10 rounded-full" />
            </div>
            <Skeleton className="w-16 h-6 rounded-full" />
          </div>
          <Skeleton className="h-7 w-3/4 mb-3 ml-auto" />
          <Skeleton className="h-4 w-full mb-2" />
          <Skeleton className="h-4 w-5/6 mb-6 ml-auto" />
          <Skeleton className="h-[76px] w-full rounded-2xl mb-6" />
          <div className="flex gap-3 mb-6">
            <Skeleton className="flex-1 h-12 rounded-xl" />
            <Skeleton className="flex-1 h-12 rounded-xl" />
          </div>
          {/* The buy box's selection blocks — options, then the extended-warranty
              fieldset a printer carries (legend, intro line, three 44px radios,
              policy link ≈ 236px). Reserved so a printer page does not jump
              when its plans arrive. */}
          <Skeleton className="h-14 w-full rounded-xl mb-4" />
          <Skeleton className="h-[236px] w-full rounded-2xl mb-4" />
          <Skeleton className="h-14 w-full rounded-xl" />
        </div>
      </div>
    </SkeletonGroup>
  );
}

/** Mirrors the Cart list: group header + item rows (checkbox, 100px image, lines). */
export function CartSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <SkeletonGroup className="bg-[#0a0a0a] border-y border-zinc-900/50 pb-4">
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
      className={`bg-zinc-900/50 border border-zinc-800/50 rounded-xl overflow-hidden flex flex-col ${className}`}
    >
      <div className="aspect-square bg-zinc-800/60 animate-pulse motion-reduce:animate-none" />
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
      <div aria-hidden="true" className="h-64 sm:h-80 bg-zinc-800/60 animate-pulse motion-reduce:animate-none" />
      <div className="p-4 space-y-4">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-2xl p-4 space-y-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="space-y-2">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 bg-zinc-900/40 border border-zinc-800/50 rounded-xl p-3">
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
