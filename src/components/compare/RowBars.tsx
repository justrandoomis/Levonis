import React from 'react';

/**
 * ONE CELL'S BAR (CATALOG_DISCOVERY §10.1; the dataviz mark spec).
 *
 * A 4 px bar under the value, grown from the inline-start baseline, rounded at
 * the data end and square at the baseline, on a faint track of the same
 * neutral. Length is `barRatio` (lib/compare.ts) — value/max, or min/value
 * where lower is better — so the best reading is always the full bar.
 *
 * COLOUR IS STATUS, NOT IDENTITY: the row's winner is `success`, every other
 * bar a recessive neutral (text-muted at 70% over the surface). The pair was
 * run through the dataviz validator for both themes: normal-vision ΔE 19.2
 * (light) and 24.9 (dark), CVD ΔE ≥ 14.6; the neutral's contrast is below 3:1
 * on dark by design (it is de-emphasis), and is relieved because every bar
 * sits under its value printed as text. The winner is also said in words
 * («الأفضل», screen readers) and drawn with a check disc — never colour alone.
 * Values never wear the bar's colour.
 */
export default function RowBar({ ratio, winner }: { ratio: number | null; winner: boolean }) {
  if (ratio === null) return null;
  const pct = Math.max(4, Math.min(100, ratio * 100));
  return (
    <span
      aria-hidden="true"
      className="mt-2 block h-1 w-full overflow-hidden rounded-full bg-[color-mix(in_oklab,var(--color-text-muted)_16%,var(--color-surface))]"
    >
      <span
        className={`block h-full rounded-e-full transition-[width] duration-300 motion-reduce:transition-none ${
          winner ? 'bg-success' : 'bg-[color-mix(in_oklab,var(--color-text-muted)_70%,var(--color-surface))]'
        }`}
        style={{ width: `${pct}%` }}
      />
    </span>
  );
}
