import React, { useEffect, useId, useState } from 'react';
import { useLanguage } from '../../LanguageContext';
import { groupedNumber, parseLocaleNumber } from '../../lib/localeNumber';
import { binsInRange, priceStep } from '../../lib/catalog/listingModel';
import type { PriceRange } from '../../lib/catalog/types';
import '../../styles/catalog.css';

/**
 * «السعر (د.ع)» (§7): a histogram of what is actually on offer, a two-knob
 * range over it, and «من / إلى» fields for a number typed exactly.
 *
 *   THE PRICES ARE THE VIEWER'S. The bounds and the bars are the server's
 *   resolved `display_price_iqd` for this shopper (a PRO member's histogram is
 *   a PRO member's), counted with every OTHER filter applied.
 *   THE BARS IN RANGE ARE INK, the rest a quiet line colour — the shape of
 *   what the range keeps, visible while dragging.
 *   RTL: native range inputs, so in Arabic the low end is on the right and the
 *   arrow keys follow the reading direction.
 *   THE FIELDS take Arabic-Indic or Western digits and grouping marks
 *   (`parseLocaleNumber`), show the number grouped, and commit on blur or
 *   Enter — a half-typed «50» is never applied while the fingers are moving.
 *
 * `onChange(null)` when the range covers everything: an untouched filter is
 * not a filter.
 */
export default function PriceFacet({
  min,
  max,
  histogram,
  value,
  onChange,
}: {
  min: number;
  max: number;
  histogram: number[];
  value: PriceRange | null;
  onChange: (next: PriceRange | null) => void;
}) {
  const { loc } = useLanguage();
  // OWNER: Sorani to be written by hand (every loc() in this file).
  const uid = useId();
  const step = priceStep(min, max);
  const lo = clamp(value?.min ?? min, min, max);
  const hi = clamp(value?.max ?? max, min, max);
  const [draft, setDraft] = useState({ lo, hi });
  useEffect(() => setDraft({ lo, hi }), [lo, hi]);

  const emit = (a: number, b: number) => {
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    onChange(low <= min && high >= max ? null : { min: low <= min ? null : low, max: high >= max ? null : high });
  };

  const span = Math.max(1, max - min);
  const pct = (v: number) => ((clamp(v, min, max) - min) / span) * 100;
  const inRange = binsInRange(histogram.length, min, max, draft.lo, draft.hi);
  const peak = Math.max(1, ...histogram);

  return (
    <div>
      <div aria-hidden="true" className="mx-0.5 flex h-10 items-end gap-0.5">
        {histogram.map((n, i) => (
          <span
            key={i}
            className={`block flex-1 rounded-t-[3px] transition-colors ${inRange[i] ? 'bg-text-primary' : 'bg-zinc-700'}`}
            style={{ height: `${n === 0 ? 8 : 18 + (n / peak) * 82}%` }}
          />
        ))}
      </div>
      <div className="relative mx-0.5 h-11">
        <span aria-hidden="true" className="absolute inset-x-0 top-[21px] h-0.5 rounded-full bg-zinc-700" />
        <span
          aria-hidden="true"
          className="absolute top-[21px] h-0.5 rounded-full bg-text-primary"
          style={{ insetInlineStart: `${pct(draft.lo)}%`, insetInlineEnd: `${100 - pct(draft.hi)}%` }}
        />
        <input
          type="range"
          className="lv-range"
          min={min}
          max={max}
          step={step}
          value={draft.lo}
          aria-label={loc('أقل سعر', 'Lowest price')}
          aria-valuetext={`${groupedNumber(draft.lo)} ${loc('د.ع', 'IQD')}`}
          onChange={(e) => setDraft((d) => ({ ...d, lo: Math.min(Number(e.target.value), d.hi) }))}
          onPointerUp={() => emit(draft.lo, draft.hi)}
          onKeyUp={() => emit(draft.lo, draft.hi)}
          onBlur={() => (draft.lo !== lo ? emit(draft.lo, draft.hi) : undefined)}
        />
        <input
          type="range"
          className="lv-range"
          min={min}
          max={max}
          step={step}
          value={draft.hi}
          aria-label={loc('أعلى سعر', 'Highest price')}
          aria-valuetext={`${groupedNumber(draft.hi)} ${loc('د.ع', 'IQD')}`}
          onChange={(e) => setDraft((d) => ({ ...d, hi: Math.max(Number(e.target.value), d.lo) }))}
          onPointerUp={() => emit(draft.lo, draft.hi)}
          onKeyUp={() => emit(draft.lo, draft.hi)}
          onBlur={() => (draft.hi !== hi ? emit(draft.lo, draft.hi) : undefined)}
        />
      </div>
      <div className="mt-1 flex gap-2">
        <PriceField id={`${uid}-from`} label={loc('من', 'From')} value={draft.lo} onCommit={(v) => emit(clamp(v, min, max), draft.hi)} />
        <PriceField id={`${uid}-to`} label={loc('إلى', 'To')} value={draft.hi} onCommit={(v) => emit(draft.lo, clamp(v, min, max))} />
      </div>
    </div>
  );
}

function PriceField({ id, label, value, onCommit }: { id: string; label: string; value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(groupedNumber(value));
  useEffect(() => setText(groupedNumber(value)), [value]);
  const commit = () => {
    const parsed = parseLocaleNumber(text);
    if (parsed.valid && parsed.value !== null) onCommit(parsed.value);
    else setText(groupedNumber(value));
  };
  return (
    <label
      htmlFor={id}
      className="flex min-h-11 flex-1 cursor-text flex-col justify-center rounded-[10px] border border-border-subtle bg-surface px-2.5 focus-within:border-text-muted focus-within:ring-2 focus-within:ring-focus"
    >
      <span className="text-[10.5px] leading-3 text-text-muted">{label}</span>
      <input
        id={id}
        inputMode="numeric"
        dir="ltr"
        autoComplete="off"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
        className="w-full bg-transparent text-start text-[13.5px] font-bold tabular-nums leading-5 text-text-primary outline-none rtl:text-right"
      />
    </label>
  );
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
