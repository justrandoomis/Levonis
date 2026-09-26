import React, { useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { Scale } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { compareHref, compareTray } from '../../lib/compareTray';
import { badgeLabel } from './trayStrings';

/**
 * THE TRAY, AS A TOP-BAR ICON (owner default Q8). On the product page the
 * floating tray would cover the sticky purchase bar, so the tray is not drawn
 * there; this 44 px icon in the page's top bar stands in for it — a scale with
 * the count pinned to its corner, linking to the comparison of what the tray
 * holds. It draws nothing while the tray is empty.
 *
 * The count is decorative; the link's name says it («قارن الآن (3)»).
 */
export default function CompareBadge({ className = '' }: { className?: string }) {
  const { lang } = useLanguage();
  const state = useSyncExternalStore(compareTray.subscribe, compareTray.getSnapshot, compareTray.getSnapshot);
  const count = state.items.length;
  if (!count) return null;
  const label = badgeLabel(count, lang);
  return (
    <Link
      to={compareHref(state)}
      aria-label={label}
      title={label}
      data-compare-badge={count}
      className={`relative inline-flex size-11 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ${className}`}
    >
      <Scale aria-hidden="true" className="size-5" />
      <span
        aria-hidden="true"
        className="absolute -top-0.5 -end-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full border-2 border-canvas bg-text-primary px-1 text-[10.5px] font-extrabold tabular-nums leading-none text-canvas"
      >
        {count}
      </span>
    </Link>
  );
}
