import React from 'react';
import { Check, type LucideIcon } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { fromPointer, onGroupKeyDown } from './choiceKeys';

export interface TileOption<V extends string> {
  value: V;
  title: string;
  sub: string;
  Icon: LucideIcon;
  /** Spans the row, drawn horizontally («لا أعرف بعد»). */
  wide?: boolean;
}

/**
 * QUESTION 1 AS TILES (mockup 5): two columns on a phone, three on a wide
 * screen, the «not sure» answer across the row. A `radiogroup`.
 *
 * SELECTED = ONE CUE: an ink border plus a check disc (CATALOG_DISCOVERY §1.6;
 * apple-design §3) — the icon well turns ink too, so the choice reads at a
 * glance, but no gold, no glow, and the text keeps its colour.
 */
export default function ChoiceTiles<V extends string>({
  labelledBy,
  options,
  value,
  onChoose,
}: {
  labelledBy: string;
  options: TileOption<V>[];
  value: V | null;
  onChoose: (value: V, viaPointer: boolean) => void;
}) {
  const { dir } = useLanguage();
  const tabbable = value ?? options[0]?.value;
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      onKeyDown={(e) => onGroupKeyDown(e, dir)}
      className="grid grid-cols-2 gap-3 sm:grid-cols-3"
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            data-choice={o.value}
            tabIndex={o.value === tabbable ? 0 : -1}
            onClick={(e) => onChoose(o.value, fromPointer(e))}
            className={`group relative flex rounded-[18px] border bg-surface p-4 text-start transition-[border-color,box-shadow,transform,background-color] duration-150 active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas motion-reduce:transition-none motion-reduce:active:scale-100 ${
              on
                ? 'border-text-primary shadow-[0_0_0_1px_var(--color-text-primary),var(--shadow-2)]'
                : 'border-border-subtle hover:border-text-muted/40 hover:bg-surface-raised'
            } ${o.wide ? 'col-span-2 min-h-[76px] flex-row items-center gap-3.5 sm:col-span-3' : 'min-h-[120px] flex-col'}`}
          >
            <span
              aria-hidden="true"
              className={`grid size-10 shrink-0 place-items-center rounded-xl transition-colors duration-150 ${
                on ? 'bg-text-primary text-canvas' : 'bg-surface-selected text-text-primary'
              }`}
            >
              <o.Icon className="size-5" strokeWidth={1.9} />
            </span>
            <span className={`min-w-0 ${o.wide ? 'flex-1' : 'mt-3'}`}>
              <span className="block text-[15px] font-bold leading-[21px] text-text-primary">{o.title}</span>
              <span className="mt-1 block text-[12.5px] leading-[18px] text-text-secondary">{o.sub}</span>
            </span>
            <span
              aria-hidden="true"
              className={`absolute end-3 top-3 grid size-6 place-items-center rounded-full bg-text-primary text-canvas transition-[opacity,transform] duration-150 motion-reduce:transition-none ${
                on ? 'scale-100 opacity-100' : 'scale-75 opacity-0'
              }`}
            >
              <Check className="size-3.5" strokeWidth={3} />
            </span>
          </button>
        );
      })}
    </div>
  );
}
