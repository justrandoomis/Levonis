import React from 'react';

/**
 * «10 طابعات» at the start, what the order means at the end (§7 item 7). The
 * count is a polite live region, so a screen reader hears the new number after
 * a chip, a filter or a sort — once, not on every keystroke of the search.
 */
export default function ResultCount({ count, explanation, busy }: { count: string; explanation: string; busy: boolean }) {
  return (
    <div data-result-count className="flex items-baseline justify-between gap-3 pb-2 pt-1 text-[12px] text-text-muted lg:text-[13px]">
      <p aria-live="polite" aria-busy={busy || undefined} className="font-extrabold tabular-nums text-text-primary">
        {count}
      </p>
      <p className="truncate">{explanation}</p>
    </div>
  );
}
