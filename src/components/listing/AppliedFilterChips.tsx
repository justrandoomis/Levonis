import React from 'react';
import { X } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import type { AppliedChip } from '../../lib/catalog/listingModel';
import type { ListingState } from '../../lib/catalog/types';

/**
 * What is applied, one removable chip per value (§7 item 6): «متوفر الآن ✕»,
 * «Bambu Lab ✕», then «مسح الكل». Each chip's name says what tapping it does
 * («أزل: Bambu Lab»). Drawn only while something is applied.
 */
export default function AppliedFilterChips({
  chips,
  onChange,
  onClear,
}: {
  chips: AppliedChip[];
  onChange: (next: ListingState) => void;
  onClear: () => void;
}) {
  const { loc } = useLanguage();
  if (chips.length === 0) return null;
  // OWNER: Sorani to be written by hand (the two strings below).
  return (
    <div
      role="group"
      aria-label={loc('عوامل التصفية المطبّقة', 'Applied filters')}
      data-applied-chips
      className="-mx-4 flex items-center gap-1.5 overflow-x-auto overscroll-x-contain px-4 hide-scrollbar sm:-mx-6 sm:px-6 lg:mx-0 lg:flex-wrap lg:px-0"
    >
      {chips.map((c) => (
        <button
          key={c.id}
          type="button"
          data-applied-chip={c.id}
          aria-label={loc(`أزل: ${c.label}`, `Remove: ${c.label}`)}
          onClick={() => onChange(c.next)}
          className="group inline-flex min-h-11 shrink-0 items-center focus-visible:outline-none"
        >
          <span className="inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-full bg-surface-selected pe-2 ps-3 text-[12.5px] font-bold text-text-primary transition-colors group-hover:bg-zinc-800 group-focus-visible:ring-2 group-focus-visible:ring-focus">
            <bdi>{c.label}</bdi>
            <X aria-hidden="true" className="size-3.5 text-text-muted" strokeWidth={2.4} />
          </span>
        </button>
      ))}
      <button
        type="button"
        onClick={onClear}
        data-clear-filters
        className="inline-flex min-h-11 shrink-0 items-center rounded-lg px-2 text-[12.5px] font-bold text-text-secondary underline-offset-4 hover:text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {loc('مسح الكل', 'Clear all')}
      </button>
    </div>
  );
}
