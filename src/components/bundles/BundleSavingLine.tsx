import React from 'react';
import { useLanguage } from '../../LanguageContext';
import { formatIqd } from '../../lib/api';
import OfferBadge from '../ui/OfferBadge';

/**
 * THE BUNDLE'S ORIGINAL TOTAL AND ITS SAVING (docs/BUNDLES_MYSTERY.md §13.2).
 *
 * `CardPrice` provably cannot render either of these: its strikethrough is
 * `display_regular_iqd` — the bundle's OWN regular price — while what makes a
 * bundle worth buying is what the same parts cost separately
 * (`component_total_iqd`). The two are different numbers with different
 * meanings, and putting the component total into `display_regular_iqd` would
 * make a member's "your membership saved you this" line compare a bundle price
 * against a parts total.
 *
 * So this one line sits BESIDE `CardPrice`, and every figure in it is the
 * server's: the component total and the percentage both come out of the
 * `composition` block, computed from the same resolution pass that priced the
 * bundle. The browser computes nothing — a percentage recomputed here would
 * round differently from the one the offer page shows.
 */
export default function BundleSavingLine({
  componentTotalIqd,
  savingPercent,
  className = '',
}: {
  componentTotalIqd: number;
  savingPercent: number;
  className?: string;
}) {
  const { loc } = useLanguage();
  // A saving that is not real is not shown — the same rule compare-at follows.
  if (!(savingPercent > 0) || !(componentTotalIqd > 0)) return null;

  return (
    <div className={`flex items-center gap-2 min-w-0 ${className}`}>
      <span className="text-zinc-500 text-[11px] line-through tabular-nums truncate">
        {formatIqd(componentTotalIqd)}
      </span>
      <OfferBadge tone="saving">
        {loc(`وفّر ${savingPercent}٪`, `Save ${savingPercent}%`, `${savingPercent}٪ پاشەکەوت`)}
      </OfferBadge>
    </div>
  );
}
