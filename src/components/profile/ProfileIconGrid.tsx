import React from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * Uniform icon-button grid for the profile header (section 7 of the UI
 * mandate). Every cell has:
 *   - a FIXED icon box (same height for all items, aligned to the row top),
 *   - a clamped 2-line label area with a fixed min-height,
 * so a label that wraps to two lines ("خدمة العملاء") can no longer push
 * its own icon above its neighbours — no per-device negative margins.
 *
 * Touch targets are ≥44px in both axes, with visible focus and pressed
 * states that do not rely on color alone.
 */

export interface ProfileIconAction {
  key: string;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}

export default function ProfileIconGrid({
  items,
  compact = false,
  className = '',
}: {
  items: ProfileIconAction[];
  /** Compact: icon-only 44px buttons (sticky header). Labels become aria-labels. */
  compact?: boolean;
  className?: string;
}) {
  if (compact) {
    return (
      <div role="group" className={`flex items-center ${className}`}>
        {items.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={item.onClick}
            aria-label={item.label}
            className="w-11 h-11 flex items-center justify-center rounded-full text-black dark:text-white hover:bg-black/5 dark:hover:bg-white/10 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] transition-transform"
          >
            <item.icon className="w-5 h-5" strokeWidth={1.5} aria-hidden="true" />
          </button>
        ))}
      </div>
    );
  }

  return (
    // items-start: rows align at the TOP, so the shared fixed-height icon
    // box — not the tallest label — decides where every icon sits.
    <div role="group" className={`grid grid-flow-col auto-cols-fr items-start gap-0.5 ${className}`}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={item.onClick}
          className="flex flex-col items-center min-w-[56px] min-h-[56px] px-1 py-1.5 rounded-lg text-black dark:text-white hover:bg-black/5 dark:hover:bg-white/10 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#BAA369] transition-transform"
        >
          {/* Fixed icon box — identical for every cell. */}
          <span className="h-6 w-6 flex items-center justify-center shrink-0" aria-hidden="true">
            <item.icon className="w-5 h-5" strokeWidth={1.6} />
          </span>
          {/* Fixed 2-line label area: same height whether the text needs
              one line or two, in all three languages. */}
          <span className="mt-0.5 w-full text-[10px] font-medium leading-[12px] min-h-[24px] text-center line-clamp-2 break-words">
            {item.label}
          </span>
        </button>
      ))}
    </div>
  );
}
