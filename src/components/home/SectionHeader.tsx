import React from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';

/**
 * The one section header every home shelf uses: accent tick, a title that
 * stays smaller than the hero copy, and an optional real "see all" link.
 * RTL flips the chevron automatically; nothing here is decorative-only.
 */
export default function SectionHeader({
  title,
  accent,
  to,
}: {
  title: string;
  /** Tailwind background class for the tick, e.g. "bg-olive". */
  accent: string;
  /** Destination of the "see all" affordance; omit for none. */
  to?: string;
}) {
  const { t, dir } = useLanguage();
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;
  return (
    <div className="flex items-center justify-between gap-3 mb-4 sm:mb-5">
      <div className="flex items-center gap-2.5 min-w-0">
        <span aria-hidden className={`w-1 h-5 rounded-full shrink-0 ${accent}`} />
        <h2 className="text-[17px] sm:text-xl font-bold text-white truncate">{title}</h2>
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
