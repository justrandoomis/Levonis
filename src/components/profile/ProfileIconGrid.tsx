import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { IconButton } from '../ui/Button';

/** Compact profile shortcuts. Artwork stays quiet while every hit target is
 * at least 44px; identity, not utility chrome, remains the header's focus. */

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
          <IconButton
            key={item.key}
            onClick={item.onClick}
            label={item.label}
            icon={<item.icon className="h-[18px] w-[18px]" strokeWidth={1.7} aria-hidden="true" />}
          />
        ))}
      </div>
    );
  }

  return (
    <div role="group" className={`grid grid-cols-3 items-stretch gap-1 ${className}`}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={item.onClick}
          aria-label={item.label}
          className="flex min-h-[44px] min-w-0 items-center justify-center gap-1.5 rounded-md px-1.5 py-1 transition-colors active:bg-[var(--clay-well-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus text-text-secondary hover:text-text-primary hover:bg-white/[0.06]"
        >
          <span className="flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden="true">
            <item.icon className="h-[18px] w-[18px]" strokeWidth={1.7} />
          </span>
          <span className="min-w-0 truncate text-[10px] font-medium leading-4 sm:text-[11px]">
            {item.label}
          </span>
        </button>
      ))}
    </div>
  );
}
