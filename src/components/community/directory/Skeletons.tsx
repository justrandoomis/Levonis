/**
 * The community list skeletons: the directory cards (community UI plan C5)
 * and the feed card v2 (C2.1). Each mirrors its card, so the page does not
 * jump when the first page arrives. Their own module, so a section page
 * shows them while the directory or the feed chunk is still on its way
 * without loading the cards first; one module, because each alone was a
 * chunk under 1 KB of its own (one more request; tests/motionLazy.test.ts
 * counts them).
 */
import { Skeleton, SkeletonGroup } from '../../ui/Skeleton';

/** Mirrors the card: the button, three lines and the disc, three tiles, the hairline, the footer. */
export function StoreDirectorySkeleton({ count = 3 }: { count?: number }) {
  return (
    <SkeletonGroup className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} aria-hidden="true" className="cm-card flex flex-col gap-3 rounded-xl p-3">
          <div className="flex items-start gap-3">
            <Skeleton className="h-9 w-20 rounded-lg" />
            <div className="flex-1 space-y-2 pt-1">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="h-3 w-3/5" />
            </div>
            <Skeleton className="h-14 w-14 rounded-full" />
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {[0, 1, 2].map((t) => (
              <Skeleton key={t} className="aspect-square rounded-lg" />
            ))}
          </div>
          <div className="h-px bg-border-subtle" />
          <Skeleton className="h-4 w-24" />
        </div>
      ))}
    </SkeletonGroup>
  );
}

/** Mirrors the card: the button, two lines and the link, the 64px disc, three tiles. */
export function MakerDirectorySkeleton({ count = 3 }: { count?: number }) {
  return (
    <SkeletonGroup className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} aria-hidden="true" className="cm-card flex flex-col gap-3 rounded-xl p-3">
          <div className="flex items-start gap-3">
            <Skeleton className="h-9 w-20 rounded-lg" />
            <div className="flex-1 space-y-2 pt-1">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-3/5" />
              <Skeleton className="h-3 w-1/3" />
            </div>
            <Skeleton className="h-16 w-16 rounded-full" />
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {[0, 1, 2].map((t) => (
              <Skeleton key={t} className="aspect-video rounded-lg" />
            ))}
          </div>
        </div>
      ))}
    </SkeletonGroup>
  );
}

/** The feed card v2 while it loads: the same box, the author row, the title, the 16:9 cover and the row of four cells. */
export function FeedCardSkeleton({ count = 2 }: { count?: number }) {
  return (
    <SkeletonGroup className="flex flex-col gap-3">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} aria-hidden="true" className="cm-card flex flex-col gap-3 rounded-xl p-3 shadow-sm">
          <div className="flex items-center gap-3">
            <Skeleton className="h-12 w-12 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-1/3" />
              <Skeleton className="h-3 w-1/4" />
            </div>
            <Skeleton className="h-8 w-20 rounded-full" />
          </div>
          <Skeleton className="h-5 w-3/5" />
          <Skeleton className="h-3 w-4/5" />
          <Skeleton className="aspect-video w-full rounded-lg" />
          <Skeleton className="h-11 w-full" />
        </div>
      ))}
    </SkeletonGroup>
  );
}
