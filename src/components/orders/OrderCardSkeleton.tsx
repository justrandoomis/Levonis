import { Skeleton, SkeletonGroup } from '../ui/Skeleton';

/** Mirrors OrderCard: image stack + two lines, a total row, an action row. */
export default function OrderCardSkeleton({ count = 3 }: { count?: number }) {
  return (
    <SkeletonGroup className="flex flex-col gap-4">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} aria-hidden="true" className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
          <div className="absolute inset-x-0 top-0 h-px bg-zinc-800/70" />
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex">
                <Skeleton className="w-12 h-12 rounded-xl" />
                <Skeleton className="w-12 h-12 rounded-xl -ms-3" />
                <Skeleton className="w-12 h-12 rounded-xl -ms-3" />
              </div>
              <div className="flex flex-col gap-2">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-3 w-36" />
              </div>
            </div>
            <Skeleton className="h-6 w-20 rounded-full" />
          </div>
          <div className="mt-4 flex items-end justify-between">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-3 w-12" />
              <Skeleton className="h-5 w-24" />
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <Skeleton className="h-10 w-24 rounded-xl" />
            <Skeleton className="h-10 w-24 rounded-xl" />
          </div>
        </div>
      ))}
    </SkeletonGroup>
  );
}
