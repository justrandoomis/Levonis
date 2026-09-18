import React from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { itemCountLabel } from '../orders/format';

/**
 * The one section header every home shelf uses: accent tick, a title that
 * stays smaller than the hero copy, and an optional real "see all" link.
 * RTL flips the chevron automatically; nothing here is decorative-only.
 *
 * The four optional props are additive and inert for every existing caller.
 * They exist for the category rails, where the page finally has two heading
 * levels:
 *
 *   `level`     — a department sits UNDER «تصفّح حسب القسم», so it is an h3.
 *                 Defaulting to h2 keeps every shelf that came before it
 *                 exactly where it was in the outline.
 *   `id`        — so a wrapper can point `aria-labelledby` at this heading.
 *   `count`     — the section's size, with a UNIT. A bare numeral beside a
 *                 word says nothing about what is being counted, and Arabic
 *                 does not pluralise by appending an «s»: `itemCountLabel`
 *                 already carries the dual and both plurals, and reinventing
 *                 it here would get «3 منتج» wrong for the commonest counts a
 *                 small shop has.
 *   `linkLabel` — five sections each ending in a link whose entire accessible
 *                 name is «عرض الكل» are five indistinguishable rows in a
 *                 screen reader's link list.
 */
export default function SectionHeader({
  title,
  accent,
  to,
  id,
  count,
  level = 'h2',
  linkLabel,
}: {
  title: string;
  /** Tailwind background class for the tick, e.g. "bg-olive". */
  accent: string;
  /** Destination of the "see all" affordance; omit for none. */
  to?: string;
  /** DOM id for the heading, so a wrapper can be labelled by it. */
  id?: string;
  /** How many products this section holds; omit to show nothing. */
  count?: number;
  /** Heading level. h2 is the page's shelf level; h3 sits under one. */
  level?: 'h2' | 'h3';
  /** Accessible name for the "see all" link, when «عرض الكل» alone is ambiguous. */
  linkLabel?: string;
}) {
  const { t, dir, lang } = useLanguage();
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const Heading = level;
  return (
    <div className={`flex items-center justify-between gap-3 ${level === 'h3' ? 'mb-3' : 'mb-4 sm:mb-5'}`}>
      <div className="flex items-center gap-2.5 min-w-0">
        <span aria-hidden className={`${level === 'h3' ? 'w-1 h-4' : 'w-1 h-5'} rounded-full shrink-0 ${accent}`} />
        <Heading
          id={id}
          className={`font-bold text-white truncate ${level === 'h3' ? 'text-[15px] sm:text-[17px]' : 'text-[17px] sm:text-xl'}`}
        >
          {title}
        </Heading>
        {typeof count === 'number' && (
          // `text-zinc-400`, not `text-zinc-500`: at 12px on `--color-surface`
          // zinc-500 measures about 3.8:1, under the 4.5:1 small text needs.
          <span className="shrink-0 text-[12px] font-medium text-zinc-400 tabular-nums">
            {itemCountLabel(count, lang)}
          </span>
        )}
      </div>
      {to && (
        <Link
          to={to}
          aria-label={linkLabel}
          className="shrink-0 min-h-[44px] flex items-center gap-1 text-[13px] font-medium text-zinc-400 hover:text-white transition-colors px-2 -me-2"
        >
          <span>{t('seeAll')}</span>
          <Chevron aria-hidden className="w-4 h-4" />
        </Link>
      )}
    </div>
  );
}
