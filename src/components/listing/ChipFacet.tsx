import React from 'react';
import { Check } from 'lucide-react';

export interface ChipOption {
  value: string;
  label: string;
  count: number | null;
  /** A CSS colour for a swatch dot (SwatchFacet), from the admin's own colour name. */
  swatch?: string;
}

/**
 * A multi-select facet drawn as chips (§7): «4 ألوان 2 · 16–20 لونًا 0 · 24
 * لونًا فأكثر 2». Each chip is a toggle (`aria-pressed`) with its disjunctive
 * count. An option that would give nothing is DIMMED and `aria-disabled`,
 * never removed — the row does not reshuffle under the thumb — and it can
 * still be turned off if it is on. Selected = a press (well fill) plus a check: one cue,
 * not a colour alone.
 */
export default function ChipFacet({
  options,
  selected,
  onToggle,
  labelledBy,
}: {
  options: ChipOption[];
  selected: string[];
  onToggle: (value: string) => void;
  labelledBy: string;
}) {
  return (
    <div role="group" aria-labelledby={labelledBy} className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = selected.includes(o.value);
        const dead = !on && o.count === 0;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            aria-disabled={dead || undefined}
            data-facet-option={o.value}
            onClick={() => {
              if (!dead) onToggle(o.value);
            }}
            className={`inline-flex min-h-11 items-center focus-visible:outline-none ${dead ? 'cursor-not-allowed' : ''} group`}
          >
            <span
              className={`inline-flex h-[34px] items-center gap-1.5 rounded-full px-3.5 text-[12.5px] font-bold transition-colors group-focus-visible:ring-2 group-focus-visible:ring-focus ${
                // Clay filter chip (docs/DECISIONS.md row 209): flush at rest,
                // PRESSED when chosen (the well fill and the press) plus the
                // check — selection is a press, never an inverted fill.
                on
                  ? 'border border-transparent bg-[var(--clay-well-bg)] text-text-primary shadow-press'
                  : `border border-border-subtle bg-surface-raised text-text-secondary shadow-xs ${dead ? 'opacity-45' : 'group-hover:text-text-primary'}`
              }`}
            >
              {on ? <Check aria-hidden="true" className="size-3.5" strokeWidth={2.6} /> : null}
              {o.swatch ? (
                <span aria-hidden="true" className="size-3.5 rounded-full ring-1 ring-inset ring-text-primary/15" style={{ background: o.swatch }} />
              ) : null}
              <span>{o.label}</span>
              {o.count !== null ? (
                <span className="font-semibold tabular-nums text-text-muted">{o.count}</span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
