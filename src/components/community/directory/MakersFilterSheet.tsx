/**
 * «تصفية» FOR THE MAKERS (community UI plan C5; IMG_8476): the order of the
 * list and two conditions, each answered by the server (plan B3: `sort`,
 * `has_store`, `approved`), never a control with nothing behind it. No place
 * filter: a person has no public governorate (plan R11).
 *
 *   الترتيب      a radio group of three: الأحدث نشاطًا / الأكثر مشاريع /
 *                الأكثر متابعين. The checked one is the order on screen
 *                (with no choice made, the featured order without a search
 *                and the newest activity with one). The arrows move the
 *                check and apply it at once, as a radio group does.
 *   إظهار        «لديهم متجر» and «مزوّد معتمد», two pressed chips.
 *
 * Every change is written to the address at once (the list behind the sheet
 * follows); «تم» and Escape close it, focus back on the filter button.
 */
import { useRef, type KeyboardEvent } from 'react';
import { Check, ShieldCheck, Store } from 'lucide-react';
import type { CreatorSort } from '../../../../packages/contracts/src/communityFilters';
import { useLanguage } from '../../../LanguageContext';
import { Sheet } from '../../ui/Sheet';
import FilterChip from '../FilterChip';
import { GoldButton } from '../kit/buttons';
import type { MakerFilterState } from './filters';
import { useDirectoryStrings } from './strings';

export interface MakersFilterSheetProps {
  open: boolean;
  onClose: () => void;
  filters: MakerFilterState;
  /** The order on screen (the chosen one, or the default for the search). */
  sort: CreatorSort;
  onSort: (sort: CreatorSort) => void;
  onToggle: (key: 'has_store' | 'approved') => void;
}

export default function MakersFilterSheet({ open, onClose, filters, sort, onSort, onToggle }: MakersFilterSheetProps) {
  const { dir } = useLanguage();
  const d = useDirectoryStrings();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const checkedRef = useRef<HTMLButtonElement | null>(null);
  const sorts: Array<{ id: CreatorSort; label: string }> = [
    { id: 'recent', label: d.sortRecent },
    { id: 'featured', label: d.sortFeatured },
    { id: 'followers', label: d.sortFollowers },
  ];

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = Math.max(0, sorts.findIndex((o) => o.id === sort));
    const forward = dir === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
    const back = dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    let next = -1;
    if (e.key === 'ArrowDown' || e.key === forward) next = (at + 1) % sorts.length;
    else if (e.key === 'ArrowUp' || e.key === back) next = (at - 1 + sorts.length) % sorts.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = sorts.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onSort(sorts[next].id);
    refs.current[next]?.focus();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      label={d.filter}
      detents={['medium', 'large']}
      dragHandle
      initialFocus={checkedRef}
      testId="makers-filter-sheet"
      header={<h2 className="px-4 pb-2 pt-1 text-[16px] font-bold text-text-primary">{d.filter}</h2>}
      footer={
        <GoldButton block onClick={onClose} data-makers-filter-done>
          {d.done}
        </GoldButton>
      }
    >
      <div className="flex flex-col gap-4 px-4 pb-4">
        <section className="flex flex-col gap-2">
          <h3 id="makers-sort" className="text-[13px] font-semibold text-text-secondary">
            {d.sort}
          </h3>
          <div role="radiogroup" aria-labelledby="makers-sort" onKeyDown={onKeyDown} className="flex flex-col gap-1" data-makers-sort>
            {sorts.map((o, i) => {
              const on = o.id === sort;
              return (
                <button
                  key={o.id}
                  ref={(el) => {
                    refs.current[i] = el;
                    if (on) checkedRef.current = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  tabIndex={on ? 0 : -1}
                  data-sort={o.id}
                  onClick={() => onSort(o.id)}
                  className={`cm-sel flex min-h-12 w-full items-center gap-3 rounded-md border px-3 text-start text-[15px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${on ? '' : 'border-transparent text-text-primary hover:bg-surface-selected'}`}
                >
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {on && <Check aria-hidden="true" className="h-4 w-4 shrink-0" strokeWidth={2.6} />}
                </button>
              );
            })}
          </div>
        </section>
        <section className="flex flex-col gap-2">
          <h3 id="makers-show" className="text-[13px] font-semibold text-text-secondary">
            {d.show}
          </h3>
          <div role="group" aria-labelledby="makers-show" className="flex flex-wrap gap-2">
            <FilterChip shape="rect" on={filters.has_store === '1'} aria-pressed={filters.has_store === '1'} icon={<Store aria-hidden="true" className="h-4 w-4" />} onClick={() => onToggle('has_store')} data-makers-filter="has_store">
              {d.hasStore}
            </FilterChip>
            <FilterChip shape="rect" on={filters.approved === '1'} aria-pressed={filters.approved === '1'} icon={<ShieldCheck aria-hidden="true" className="h-4 w-4" />} onClick={() => onToggle('approved')} data-makers-filter="approved">
              {d.approved}
            </FilterChip>
          </div>
        </section>
      </div>
    </Sheet>
  );
}
