import React from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../../../LanguageContext';

/**
 * The heading row of every light section on the home page: a title and, when
 * there is a real page to go to, «عرض الكل ←» on the far side.
 *
 * The arrow is the owner's own glyph and is drawn as a mirrored SVG rather
 * than typed, so it points the way the reading direction continues in Arabic
 * AND in English. No accent bar beside the title — on the ivory ground a
 * coloured tick next to every heading is decoration, and the title's weight
 * already carries the hierarchy.
 */
export default function SectionHead({
  title,
  to,
  linkLabel,
  id,
}: {
  title: string;
  to?: string;
  linkLabel?: string;
  id?: string;
}) {
  const { t } = useLanguage();
  return (
    <div className="flex items-center justify-between gap-3 mb-3 lg:mb-5">
      <h2 id={id} className="min-w-0 truncate text-[17px] leading-7 font-bold text-ink lg:text-[22px] lg:leading-8">
        {title}
      </h2>
      {to ? (
        <Link
          to={to}
          className="-me-2 inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[13px] font-semibold text-ink-2 transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-muted"
        >
          <span>{linkLabel ?? t('seeAll')}</span>
          <ArrowGlyph />
        </Link>
      ) : null}
    </div>
  );
}

/** «←» in Arabic, «→» in English: the arrow follows the reading direction. */
export function ArrowGlyph({ className = 'h-3.5 w-3.5' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`${className} shrink-0 rtl:-scale-x-100`}
    >
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  );
}
