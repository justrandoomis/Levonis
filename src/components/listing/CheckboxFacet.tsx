import React from 'react';
import { Check } from 'lucide-react';

/**
 * «العلامة التجارية» (§7): one row per brand, a check box, the brand as it
 * writes its name, and its disjunctive count at the far end. A 44 px row is
 * the target; the box is drawn 22 px. A brand that would give nothing is
 * dimmed and `aria-disabled` (still removable when on).
 */
export default function CheckboxFacet({
  options,
  selected,
  onToggle,
  labelledBy,
}: {
  options: Array<{ value: string; label: string; count: number }>;
  selected: string[];
  onToggle: (value: string) => void;
  labelledBy: string;
}) {
  return (
    <ul role="group" aria-labelledby={labelledBy} className="flex flex-col">
      {options.map((o) => {
        const on = selected.includes(o.value);
        const dead = !on && o.count === 0;
        return (
          <li key={o.value}>
            <label
              data-facet-option={o.value}
              className={`flex min-h-11 cursor-pointer items-center gap-3 ${dead ? 'cursor-not-allowed opacity-45' : ''}`}
            >
              <input
                type="checkbox"
                className="peer sr-only"
                checked={on}
                aria-disabled={dead || undefined}
                onChange={() => {
                  if (!dead) onToggle(o.value);
                }}
              />
              <span
                aria-hidden="true"
                className={`grid size-[22px] shrink-0 place-items-center rounded-md border-[1.5px] transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-focus peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface-raised ${
                  on ? 'border-text-primary bg-text-primary text-canvas' : 'border-zinc-700 bg-surface'
                }`}
              >
                {on ? <Check className="size-3.5" strokeWidth={3} /> : null}
              </span>
              <span dir="ltr" className="min-w-0 flex-1 truncate text-start text-[13.5px] font-bold text-text-primary rtl:text-right">
                {o.label}
              </span>
              <span className="shrink-0 text-[12.5px] tabular-nums text-text-muted">{o.count}</span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
