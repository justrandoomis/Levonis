import React, { forwardRef } from 'react';
import { ArrowDownUp, LayoutGrid, List, SlidersHorizontal } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { Segmented } from '../ui/Segmented';
import { sortLabel } from '../../lib/catalog/listingModel';
import type { ListingSort } from '../../lib/catalog/types';

export type ListingView = 'grid' | 'list';

/**
 * The listing's toolbar (§7 item 4), sticky under the top bar: «التصفية» with
 * a badge counting the filters on, «الترتيب: الأنسب», and the grid / list
 * switch at the far end. 38 px controls with 44 px targets. From 1024 px the
 * filters live in a side column, so the filter button is not drawn there.
 */
const ListingToolbar = forwardRef<HTMLButtonElement, {
  activeCount: number;
  sort: ListingSort;
  view: ListingView;
  onFilters: () => void;
  onFiltersIntent: () => void;
  onSort: () => void;
  onView: (v: ListingView) => void;
  showFilterButton: boolean;
}>(function ListingToolbar({ activeCount, sort, view, onFilters, onFiltersIntent, onSort, onView, showFilterButton }, filterRef) {
  const { lang, loc } = useLanguage();
  const tb =
    'group relative inline-flex min-h-11 shrink-0 items-center focus-visible:outline-none';
  const face =
    'inline-flex h-[38px] items-center gap-1.5 whitespace-nowrap rounded-[11px] border border-border-subtle bg-surface px-3 text-[13px] font-extrabold text-text-primary transition-colors group-hover:bg-surface-raised group-focus-visible:ring-2 group-focus-visible:ring-focus';
  // OWNER: Sorani to be written by hand (every loc() in this file without a third argument).
  const sortText = sort === 'newest' ? loc('الأحدث', 'Newest', 'نوێترین') : sortLabel(sort, lang);
  return (
    <div data-listing-toolbar className="flex items-center gap-2">
      {showFilterButton ? (
        <button
          ref={filterRef}
          type="button"
          onClick={onFilters}
          onPointerDown={onFiltersIntent}
          onFocus={onFiltersIntent}
          aria-haspopup="dialog"
          data-open-filters
          aria-label={activeCount ? loc(`التصفية، ${activeCount} مفعّلة`, `Filters, ${activeCount} on`) : loc('التصفية', 'Filters')}
          className={tb}
        >
          <span className={face}>
            <SlidersHorizontal aria-hidden="true" className="size-4" />
            {loc('التصفية', 'Filters')}
            {activeCount ? (
              <span aria-hidden="true" className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-text-primary px-1 text-[10.5px] font-extrabold tabular-nums text-canvas">
                {activeCount}
              </span>
            ) : null}
          </span>
        </button>
      ) : null}
      <button type="button" onClick={onSort} aria-haspopup="dialog" data-open-sort className={`${tb.replace('shrink-0', 'shrink')} min-w-0`}>
        <span className={`${face} min-w-0 max-w-full`}>
          <ArrowDownUp aria-hidden="true" className="size-4 shrink-0" />
          {/* With a filter badge beside it a phone has no room for both words; the icon says «sort». */}
          <span className={`shrink-0 font-semibold text-text-muted ${activeCount || lang === 'en' ? 'max-sm:sr-only' : ''}`}>{loc('الترتيب:', 'Sort:')}</span>
          <span className="truncate">{sortText}</span>
        </span>
      </button>
      <div className="ms-auto w-[78px] shrink-0">
        <Segmented
          group="listing-view"
          size="sm"
          label={loc('طريقة العرض', 'View')}
          value={view}
          onChange={(id) => onView(id === 'list' ? 'list' : 'grid')}
          items={[
            { id: 'grid', label: <><LayoutGrid aria-hidden="true" className="size-4" /><span className="sr-only">{loc('شبكة', 'Grid')}</span></>, accent: ACCENT },
            { id: 'list', label: <><List aria-hidden="true" className="size-4" /><span className="sr-only">{loc('قائمة', 'List')}</span></>, accent: ACCENT },
          ]}
        />
      </div>
    </div>
  );
});

const ACCENT = { indicator: 'bg-surface-selected border-transparent', text: 'text-text-primary' };

export default ListingToolbar;
