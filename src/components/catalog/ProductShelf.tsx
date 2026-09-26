import React from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../../LanguageContext';
import ProductCard from '../home/ProductCard';
import { ArrowGlyph } from '../home/v2/SectionHead';
import { prefetchProps } from '../../lib/catalog/prefetch';
import type { ApiProduct } from '../../lib/api';

/**
 * ONE SHELF OF A CATEGORY PAGE (docs/ux/CATALOG_DISCOVERY.md §6 item 4).
 *
 * A title with its count, «عرض الكل» to the full listing, one line saying what
 * the shelf is, and a rail of up to ten compact cards — available now first,
 * as the server ordered them. On a phone the rail is 148 px cards, two and a
 * half in view, which invites the swipe; from 1024 px it becomes a five-column
 * grid of the first five, and «عرض الكل» carries the rest.
 *
 * Every card offers the compare toggle (§4.1: shelves are an entry point to
 * the tray). `id` is the anchor the jump chips scroll to; the heading takes
 * focus when they do.
 */
export default function ProductShelf({
  id,
  title,
  count,
  subline,
  seeAll,
  children,
  products,
}: {
  id: string;
  title: string;
  count?: number | null;
  subline?: string;
  seeAll?: string;
  products?: ApiProduct[];
  /** Instead of cards: brand tiles, material chips. */
  children?: React.ReactNode;
}) {
  const { loc, t } = useLanguage();
  // OWNER: Sorani to be written by hand («عرض الكل»).
  const headingId = `${id}-title`;
  return (
    <section id={id} aria-labelledby={headingId} data-shelf={id} className="scroll-mt-[112px]">
      <div className="flex items-center justify-between gap-3">
        <h2 id={headingId} tabIndex={-1} className="min-w-0 truncate text-[17px] font-extrabold leading-[26px] text-text-primary focus:outline-none lg:text-[22px] lg:leading-8">
          {title}
          {count != null ? <span className="ms-1.5 text-[12px] [unicode-bidi:isolate] font-semibold tabular-nums text-text-muted lg:text-[14px]">{count}</span> : null}
        </h2>
        {seeAll ? (
          <Link
            to={seeAll}
            {...prefetchProps(seeAll)}
            aria-label={`${t('seeAll')}: ${title}`}
            className="-me-2 inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[13px] font-bold text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <span>{loc('عرض الكل', 'See all')}</span>
            <ArrowGlyph />
          </Link>
        ) : null}
      </div>
      {subline ? <p className="-mt-1 mb-2.5 line-clamp-1 text-[12px] leading-[18px] text-text-muted lg:mb-4 lg:text-[13.5px]">{subline}</p> : <div className="h-1.5" />}
      {products && products.length ? (
        <ul className="-mx-4 flex snap-x gap-2.5 overflow-x-auto overscroll-x-contain px-4 pb-1 hide-scrollbar sm:-mx-6 sm:px-6 lg:mx-0 lg:grid lg:grid-cols-5 lg:gap-4 lg:overflow-visible lg:px-0">
          {products.map((p, i) => (
            <li key={p.id} className={`flex shrink-0 snap-start ${i >= 5 ? 'lg:hidden' : ''}`}>
              <ProductCard p={p} density="compact" compareToggle widthClass="w-[148px] shrink-0 lg:w-full" />
            </li>
          ))}
        </ul>
      ) : null}
      {children}
    </section>
  );
}
