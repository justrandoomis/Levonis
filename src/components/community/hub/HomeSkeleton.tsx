/**
 * The community home while its first reads (and its lazy body) are on their
 * way, at the heights of the cards that replace it, so nothing jumps
 * (community UI plan C1: the featured card 200px on a phone and 334px from
 * `lg`, the trending cards, two request rows, then the feed).
 */
import { Skeleton, SkeletonGroup } from '../../ui/Skeleton';

/** The main column and the aside: one column on a phone, the dashboard grid from `lg`. */
export const HOME_GRID = 'flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start';

/** The main column: the featured card and the trending cards. */
export function MainSkeleton({ wide }: { wide: boolean }) {
  return (
    <SkeletonGroup className="flex flex-col gap-6">
      <div className="flex" style={{ minHeight: wide ? 334 : 200 }}>
        <Skeleton className="w-full rounded-xl" />
      </div>
      <div className={`grid ${wide ? 'grid-cols-3 gap-4' : 'grid-cols-2 gap-3'}`}>
        {Array.from({ length: wide ? 3 : 2 }, (_, i) => (
          <Skeleton key={i} className={`${wide ? 'aspect-[3/2]' : 'aspect-video'} w-full rounded-lg`} />
        ))}
      </div>
    </SkeletonGroup>
  );
}

/** The aside: two request rows. */
export function AsideSkeleton() {
  return (
    <SkeletonGroup className="flex flex-col gap-3">
      {[0, 1].map((i) => (
        <div key={i} className="flex" style={{ minHeight: 88 }}>
          <Skeleton className="w-full rounded-xl" />
        </div>
      ))}
    </SkeletonGroup>
  );
}
