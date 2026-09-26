import React from 'react';
import { Check } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import type { QuickChip } from '../../lib/catalog/listingModel';
import type { ListingState } from '../../lib/catalog/types';

/**
 * One-tap filters (§7 item 5): «متوفر الآن», «طلب مسبق», «هيكل مغلق», «متعدد
 * الألوان» and the top brand for printers; the materials and «1.75 مم» for
 * filament. A chip is a toggle (`aria-pressed`) drawn 32 px and hit 44 px;
 * on = ink fill plus a check. The row scrolls sideways and bleeds to the
 * screen edge. Chips that would not change the list are not offered
 * (src/lib/catalog/listingModel.ts `quickChips`).
 */
export default function QuickFilterChips({ chips, onChange }: { chips: QuickChip[]; onChange: (next: ListingState) => void }) {
  const { loc } = useLanguage();
  if (chips.length === 0) return null;
  return (
    <div
      role="group"
      // OWNER: Sorani to be written by hand.
      aria-label={loc('تصفية سريعة', 'Quick filters')}
      data-quick-chips
      className="-mx-4 flex gap-1.5 overflow-x-auto overscroll-x-contain px-4 hide-scrollbar sm:-mx-6 sm:px-6 lg:mx-0 lg:flex-wrap lg:px-0"
    >
      {chips.map((c) => (
        <button
          key={c.id}
          type="button"
          aria-pressed={c.active}
          data-quick-chip={c.id}
          onClick={() => onChange(c.next)}
          className="group inline-flex min-h-11 shrink-0 items-center focus-visible:outline-none"
        >
          <span
            className={`inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-full px-3.5 text-[12.5px] font-bold transition-colors group-focus-visible:ring-2 group-focus-visible:ring-focus ${
              c.active ? 'bg-text-primary text-canvas' : 'border border-border-subtle bg-surface text-text-secondary group-hover:text-text-primary'
            }`}
          >
            {c.active ? <Check aria-hidden="true" className="size-3.5" strokeWidth={2.6} /> : null}
            {c.label}
          </span>
        </button>
      ))}
    </div>
  );
}
