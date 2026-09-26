import React from 'react';

/**
 * Six segments that fill in the reading direction (a flex row, so RTL fills
 * right-to-left with no special case). One `progressbar` with real values; the
 * segments themselves are decoration.
 */
export default function FinderProgress({ current, total, label }: { current: number; total: number; label: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={current}
      className="flex gap-1.5"
    >
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className={`h-1 flex-1 rounded-full transition-colors duration-200 motion-reduce:transition-none ${
            i < current ? 'bg-text-primary' : 'bg-border-subtle'
          }`}
        />
      ))}
    </div>
  );
}
