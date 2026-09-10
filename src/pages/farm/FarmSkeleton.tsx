import React from 'react';
import { Skeleton, SkeletonGroup } from '../../components/ui/Skeleton';

export function GamesPageSkeleton() {
  return (
    <div className="min-h-screen bg-black text-white p-6 max-w-3xl mx-auto">
      <SkeletonGroup>
        <div className="flex items-center gap-3 mb-6">
          <Skeleton className="w-10 h-10 rounded-xl" />
          <Skeleton className="w-40 h-8 rounded-lg" />
        </div>
        <Skeleton className="w-full h-48 rounded-2xl mb-6" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Skeleton className="h-32 rounded-2xl" />
          <Skeleton className="h-32 rounded-2xl" />
        </div>
      </SkeletonGroup>
    </div>
  );
}

export default function FarmSkeleton() {
  return <GamesPageSkeleton />;
}
