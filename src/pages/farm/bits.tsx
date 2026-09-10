import React from 'react';
import { Coins, Star } from 'lucide-react';
import { formatCoins } from './format';

export function CoinsChip({ value }: { value: number }) {
  return (
    <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-400 font-semibold text-xs">
      <Coins className="w-3.5 h-3.5" />
      <span>{formatCoins(value)}</span>
    </div>
  );
}

export function Stars({ value, max = 5 }: { value: number; max?: number }) {
  const rounded = Math.round(value);
  return (
    <div className="inline-flex items-center gap-1 text-amber-400">
      {Array.from({ length: max }).map((_, i) => (
        <Star
          key={i}
          className={`w-4 h-4 ${i < rounded ? 'fill-amber-400 text-amber-400' : 'text-zinc-600'}`}
        />
      ))}
    </div>
  );
}
