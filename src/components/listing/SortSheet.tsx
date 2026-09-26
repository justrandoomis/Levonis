import React, { useId, useRef } from 'react';
import { Check } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { Sheet } from '../ui/Sheet';
import { SORT_ORDER, sortExplanation, sortLabel } from '../../lib/catalog/listingModel';
import type { ListingSort } from '../../lib/catalog/types';

/**
 * «الترتيب» (§7 «Sort sheet»): the seven orders as a radio list, a check on the
 * one in use, each with the line that says what it means. A tap chooses and
 * closes — sorting is one decision, not a draft. Arrow keys move between the
 * options (a real `radiogroup` with a roving tab stop).
 */
export default function SortSheet({
  open,
  onClose,
  value,
  hasQuery,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  value: ListingSort;
  hasQuery: boolean;
  onChange: (sort: ListingSort) => void;
}) {
  const { lang, loc } = useLanguage();
  const titleId = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = Math.max(0, SORT_ORDER.indexOf(value));

  const choose = (s: ListingSort) => {
    onChange(s);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const at = refs.current.findIndex((b) => b === document.activeElement);
    const next = (Math.max(0, at) + step + SORT_ORDER.length) % SORT_ORDER.length;
    refs.current[next]?.focus();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      dragHandle
      panelClassName="sm:max-w-[440px] sm:w-[92vw]"
      testId="sort-sheet"
      header={
        <h2 id={titleId} className="border-b border-border-subtle px-4 pb-3 pt-1 text-center text-[16px] font-extrabold text-text-primary">
          {loc('الترتيب', 'Sort', 'ڕیزکردن')}
        </h2>
      }
    >
      <div role="radiogroup" aria-labelledby={titleId} onKeyDown={onKeyDown} className="px-2 py-1.5">
        {SORT_ORDER.map((s, i) => {
          const on = s === value;
          return (
            <button
              key={s}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={i === index ? 0 : -1}
              data-sort-option={s}
              onClick={() => choose(s)}
              className="flex min-h-[52px] w-full items-center gap-3 rounded-xl px-3 text-start transition-colors hover:bg-surface-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <span className="min-w-0 flex-1">
                <span className={`block text-[14px] leading-5 ${on ? 'font-extrabold text-text-primary' : 'font-semibold text-text-secondary'}`}>
                  {s === 'newest' ? loc('الأحدث', 'Newest', 'نوێترین') : sortLabel(s, lang)}
                </span>
                <span className="block text-[11.5px] leading-4 text-text-muted">{sortExplanation(s, hasQuery, lang)}</span>
              </span>
              <span aria-hidden="true" className={`grid size-6 shrink-0 place-items-center rounded-full ${on ? 'bg-text-primary text-canvas' : ''}`}>
                {on ? <Check className="size-3.5" strokeWidth={3} /> : null}
              </span>
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}
