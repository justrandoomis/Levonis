import React from 'react';
import { useLanguage } from '../../LanguageContext';
import type { CompareLens, CompareLensId } from '../../lib/compare';
import { onGroupKeyDown } from '../finder/choiceKeys';
import { lensStrings } from './lensStrings';

/**
 * «الكل · للأعمال · للمبتدئين · أفضل قيمة · الألوان · الدقة» — the lens chips
 * (§10.2). A `radiogroup`: one lens at a time, «الكل» for none. Choosing one
 * highlights its row in the summary and tints the table rows it rests on, and
 * the page writes `?lens=` (replace, so the choice is shareable without
 * filling the back stack). The row wraps rather than scrolling sideways.
 */
export default function LensBar({
  lenses,
  value,
  onChange,
}: {
  lenses: CompareLens[];
  value: CompareLensId | null;
  onChange: (next: CompareLensId | null) => void;
}) {
  const { lang, dir } = useLanguage();
  const ls = lensStrings(lang);
  const options: Array<{ id: CompareLensId | null; label: string }> = [
    { id: null, label: ls.lensAll },
    ...lenses.map((l) => ({ id: l.id, label: ls.lensChip[l.id] })),
  ];
  return (
    <div role="radiogroup" aria-label={ls.lensGroup} onKeyDown={(e) => onGroupKeyDown(e, dir)} className="flex flex-wrap gap-2">
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id ?? 'all'}
            type="button"
            role="radio"
            aria-checked={on}
            data-choice={o.id ?? 'all'}
            data-lens-chip={o.id ?? 'all'}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.id)}
            className={`inline-flex min-h-10 items-center rounded-full border px-4 text-[13.5px] font-bold transition-[background-color,border-color,color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas lv-hit relative motion-reduce:transition-none ${
              on
                ? 'border-text-primary bg-text-primary text-canvas'
                : 'border-border-subtle bg-surface text-text-secondary hover:bg-surface-raised hover:text-text-primary'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
