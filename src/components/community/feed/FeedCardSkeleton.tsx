/**
 * The feed card v2 while it loads (community UI plan C2.1): the same box, the
 * author row, the title, the 16:9 cover and the row of four cells, so nothing
 * jumps when the posts arrive. Its own module: «أتابعهم» shows it before the
 * feed chunk (and PostCard with it) has arrived.
 */
import { Skeleton, SkeletonGroup } from '../../ui/Skeleton';

export default function FeedCardSkeleton({ count = 2 }: { count?: number }) {
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
