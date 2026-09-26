import React from 'react';
import { Check, type LucideIcon } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { fromPointer, onGroupKeyDown } from './choiceKeys';

export interface RowOption<V extends string> {
  value: V;
  title: string;
  /** The line under the title. */
  sub?: string;
  Icon: LucideIcon;
  /** A quiet figure at the trailing edge — the live count on the budget step. */
  meta?: string;
  /** The shop cannot serve this today: drawn dimmed with a reason, still choosable (§8). */
  dimmedNote?: string;
  /** The title is a brand/technology word: isolate it as LTR. */
  ltrTitle?: boolean;
}

/**
 * THE LIST FORM OF A QUESTION (mockup 6): questions 2–6.
 *
 * `mode="single"` is a `radiogroup` with a radio mark; `mode="ordered"` is the
 * priorities question — a `group` of toggle buttons (`aria-pressed`) whose
 * trailing mark is the RANK («1», «2»), and whose accessible name carries it
 * («السرعة، الأولوية 1»). Selected = ink border + a filled mark; one cue.
 */
export default function ChoiceRows<V extends string>({
  labelledBy,
  options,
  mode,
  selected,
  onChoose,
  rankLabel,
}: {
  labelledBy: string;
  options: RowOption<V>[];
  mode: 'single' | 'ordered';
  /** single: the one value; ordered: the values in rank order. */
  selected: V[];
  onChoose: (value: V, viaPointer: boolean) => void;
  /** ordered: «السرعة، الأولوية 1». */
  rankLabel?: (title: string, rank: number) => string;
}) {
  const { dir } = useLanguage();
  const single = mode === 'single';
  const tabbable = single ? (selected[0] ?? options[0]?.value) : null;
  return (
    <div
      role={single ? 'radiogroup' : 'group'}
      aria-labelledby={labelledBy}
      onKeyDown={(e) => onGroupKeyDown(e, dir)}
      className="flex flex-col gap-2.5"
    >
      {options.map((o) => {
        const rank = selected.indexOf(o.value) + 1;
        const on = rank > 0;
        const name = !single && on && rankLabel ? rankLabel(o.title, rank) : undefined;
        return (
          <button
            key={o.value}
            type="button"
            role={single ? 'radio' : undefined}
            aria-checked={single ? on : undefined}
            aria-pressed={single ? undefined : on}
            aria-label={name}
            data-choice={o.value}
            tabIndex={single ? (o.value === tabbable ? 0 : -1) : 0}
            onClick={(e) => onChoose(o.value, fromPointer(e))}
            className={`group flex min-h-[68px] w-full items-center gap-3.5 rounded-[18px] border bg-surface px-4 py-3 text-start transition-[border-color,box-shadow,transform,background-color] duration-150 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas motion-reduce:transition-none motion-reduce:active:scale-100 ${
              on
                ? 'border-text-primary shadow-[0_0_0_1px_var(--color-text-primary),var(--shadow-1)]'
                : 'border-border-subtle hover:border-text-muted/40 hover:bg-surface-raised'
            }`}
          >
            <span
              aria-hidden="true"
              className={`grid size-10 shrink-0 place-items-center rounded-xl transition-colors duration-150 ${
                on ? 'bg-text-primary text-canvas' : 'bg-surface-selected text-text-primary'
              } ${o.dimmedNote && !on ? 'opacity-60' : ''}`}
            >
              <o.Icon className="size-5" strokeWidth={1.9} />
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block text-[15px] font-bold leading-[21px] ${o.dimmedNote && !on ? 'text-text-secondary' : 'text-text-primary'}`}>
                {o.ltrTitle ? <bdi dir="ltr">{o.title}</bdi> : o.title}
              </span>
              {o.sub ? <span className="mt-0.5 block text-[12.5px] leading-[18px] text-text-secondary">{o.sub}</span> : null}
              {o.dimmedNote ? <span className="mt-1 block text-[12px] leading-[17px] text-warning">{o.dimmedNote}</span> : null}
            </span>
            {o.meta ? (
              <span className="shrink-0 text-[12px] font-semibold tabular-nums text-text-muted">{o.meta}</span>
            ) : null}
            <span
              aria-hidden="true"
              className={`grid size-6 shrink-0 place-items-center rounded-full border-[1.5px] transition-colors duration-150 ${
                on ? 'border-text-primary bg-text-primary text-canvas' : 'border-border-subtle bg-surface'
              }`}
            >
              {on ? (
                single ? (
                  <Check className="size-3.5" strokeWidth={3} />
                ) : (
                  <span className="text-[12px] font-extrabold leading-none tabular-nums">{rank}</span>
                )
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
