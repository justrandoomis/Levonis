import React from 'react';
import { Skeleton, SkeletonGroup } from '../../components/ui/Skeleton';

/**
 * Eager and tiny: the Suspense fallback for the lazy farm chunk AND the
 * first-load state, so the layout never jumps. Mirrors the real page: the
 * header bar, the room, three machine rows and the bottom tab bar.
 */
export default function FarmSkeleton() {
  return (
    <div className="w-full flex-1 min-h-0 flex flex-col bg-black" data-farm-skeleton>
      <SkeletonGroup className="flex-1 min-h-0 flex flex-col">
        <div className="h-[56px] px-4 flex items-center gap-3 border-b border-zinc-900" aria-hidden="true">
          <Skeleton className="w-9 h-9 rounded-full" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="ms-auto h-8 w-24 rounded-full" />
        </div>
        <div className="p-4 space-y-4 max-w-2xl mx-auto w-full" aria-hidden="true">
          <Skeleton className="w-full aspect-[4/3] rounded-2xl" />
          <Skeleton className="h-14 w-full rounded-2xl" />
          <Skeleton className="h-14 w-full rounded-2xl" />
          <Skeleton className="h-14 w-full rounded-2xl" />
        </div>
        <div className="mt-auto px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]" aria-hidden="true">
          <Skeleton className="h-[60px] w-full rounded-[28px]" />
        </div>
      </SkeletonGroup>
    </div>
  );
}

/** The hub / leaderboard / profile pages while their chunk loads. */
export function GamesPageSkeleton() {
  return (
    <div className="w-full flex-1 min-h-0 flex flex-col bg-black">
      <SkeletonGroup>
        <div className="h-[56px] px-4 flex items-center gap-3 border-b border-zinc-900" aria-hidden="true">
          <Skeleton className="w-9 h-9 rounded-full" />
          <Skeleton className="h-4 w-24" />
        </div>
        <div className="p-4 space-y-4 max-w-2xl mx-auto w-full" aria-hidden="true">
          <Skeleton className="h-44 w-full rounded-2xl" />
          <Skeleton className="h-16 w-full rounded-2xl" />
          <Skeleton className="h-16 w-full rounded-2xl" />
        </div>
      </SkeletonGroup>
    </div>
  );
}
