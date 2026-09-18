import React from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';

/**
 * The one section header every home shelf uses: accent tick, a title that
 * stays smaller than the hero copy, and an optional real "see all" link.
 * RTL flips the chevron automatically; nothing here is decorative-only.
 *
 * `id` and `count` are additive and inert for every existing caller. They
 * exist for the category rails, where each department is its own labelled
 * region: `id` lets that region point `aria-labelledby` at its own heading,
 * and `count` puts the section's size beside its name — with a unit, because
 * a bare numeral beside a word says nothing about what is being counted.
 */
export default function SectionHeader({
  title,
  accent,
  to,
  id,
  count,
}: {
  title: string;
  /** Tailwind background class for the tick, e.g. "bg-olive". */
  accent: string;
  /** Destination of the "see all" affordance; omit for none. */
  to?: string;
  /** DOM id for the <h2>, so a region can be labelled by it. */
  id?: string;
  /** How many products this section holds; omit to show nothing. */
  count?: number;
}) {
  const { t, dir } = useLanguage();
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;
  return (
    <div className="flex items-center justify-between gap-3 mb-4 sm:mb-5">
      <div className="flex items-center gap-2.5 min-w-0">
        <span aria-hidden className={`w-1 h-5 rounded-full shrink-0 ${accent}`} />
        <h2 id={id} className="text-[17px] sm:text-xl font-bold text-white truncate">
          {title}
        </h2>
        {typeof count === 'number' && (
          <span className="shrink-0 text-[12px] font-medium text-zinc-500 tabular-nums">
            {count} {t('productCount')}
          </span>
        )}
      </div>
      {to && (
        <Link
          to={to}
          className="shrink-0 min-h-[44px] flex items-center gap-1 text-[13px] font-medium text-zinc-400 hover:text-white transition-colors px-2 -me-2"
        >
          <span>{t('seeAll')}</span>
          <Chevron aria-hidden className="w-4 h-4" />
        </Link>
      )}
    </div>
  );
}
