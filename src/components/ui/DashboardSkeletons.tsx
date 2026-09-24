/**
 * WORKSPACE SKELETONS — list rows, table rows, a KPI row, a form, a card.
 *
 * The shared skeletons (`Skeleton.tsx`) are commerce shapes: a product card,
 * a cart line. A dashboard waiting on its data needs its OWN shapes, and the
 * rule is the same one Skeleton.tsx states: each mirrors the real dimensions
 * of what replaces it (a 44px row stays a 44px row, a 46px input a 46px
 * input), so nothing jumps when the data lands, and none of them ever shows a
 * fake number, name or status.
 *
 * Each is one `SkeletonGroup` — `role="status"`, `aria-busy`, and ONE polite
 * «جارٍ تحميل المحتوى» for a screen reader — with the blocks hidden from it.
 * The shimmer is `animate-pulse`, off under reduced motion.
 *
 * A separate module from Skeleton.tsx on purpose: that one is in every
 * visitor's first load, and these are needed only by lazy workspace screens.
 */
import React from 'react';
import { Skeleton, SkeletonGroup } from './Skeleton';

/** Rows of a list or of DataList's cards: a thumbnail, two lines, a trailing action. */
export function ListRowsSkeleton({ rows = 5, thumbnail = true, className = '' }: { rows?: number; thumbnail?: boolean; className?: string }) {
  return (
    <SkeletonGroup className={`divide-y divide-border-subtle ${className}`}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} aria-hidden="true" className="flex min-h-16 items-center gap-3 px-4 py-3">
          {thumbnail && <Skeleton className="h-10 w-10 shrink-0 rounded-lg" />}
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className={`h-3.5 ${i % 2 ? 'w-2/3' : 'w-1/2'}`} />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
        </div>
      ))}
    </SkeletonGroup>
  );
}

/** Rows of DataList's table: one bar per column, numbers at the end. */
export function TableRowsSkeleton({ rows = 6, columns = 4, className = '' }: { rows?: number; columns?: number; className?: string }) {
  const cols = Math.max(1, columns);
  return (
    <SkeletonGroup className={className}>
      <div aria-hidden="true" className="divide-y divide-border-subtle">
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="grid min-h-12 items-center gap-4 px-4" style={{ gridTemplateColumns: `2fr repeat(${cols - 1}, minmax(0, 1fr))` }}>
            {Array.from({ length: cols }, (_, c) => (
              <Skeleton key={c} className={`h-3.5 ${c === 0 ? 'w-3/4' : 'w-1/2'} ${c === cols - 1 && c > 0 ? 'ms-auto' : ''}`} />
            ))}
          </div>
        ))}
      </div>
    </SkeletonGroup>
  );
}

/** A row of KpiTiles: label, figure, delta — the tile's own padding and height. */
export function KpiRowSkeleton({ count = 4, className = '' }: { count?: number; className?: string }) {
  return (
    <SkeletonGroup className={`grid grid-cols-2 gap-3 lg:grid-cols-4 ${className}`}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} aria-hidden="true" className="lv-surface p-4">
          <Skeleton className="h-3.5 w-20" />
          <Skeleton className="mt-3 h-7 w-28 rounded-md" />
          <Skeleton className="mt-2 h-3 w-16" />
        </div>
      ))}
    </SkeletonGroup>
  );
}

/** A form: a label over a 46px control, per field, and the action row. */
export function FormSkeleton({ fields = 4, className = '' }: { fields?: number; className?: string }) {
  return (
    <SkeletonGroup className={`space-y-5 ${className}`}>
      {Array.from({ length: fields }, (_, i) => (
        <div key={i} aria-hidden="true">
          <Skeleton className="mb-2 h-3.5 w-24" />
          <Skeleton className="h-[46px] w-full rounded-md" />
        </div>
      ))}
      <div aria-hidden="true" className="flex justify-end gap-2 pt-1">
        <Skeleton className="h-11 w-24 rounded-md" />
        <Skeleton className="h-11 w-28 rounded-md" />
      </div>
    </SkeletonGroup>
  );
}

/** A Card: its title row and a few lines. */
export function CardSkeleton({ lines = 3, className = '' }: { lines?: number; className?: string }) {
  return (
    <SkeletonGroup className={`lv-surface p-4 ${className}`}>
      <div aria-hidden="true">
        <Skeleton className="h-4 w-1/3" />
        <div className="mt-4 space-y-2.5">
          {Array.from({ length: lines }, (_, i) => (
            <Skeleton key={i} className={`h-3.5 ${i === lines - 1 ? 'w-1/2' : 'w-full'}`} />
          ))}
        </div>
      </div>
    </SkeletonGroup>
  );
}
