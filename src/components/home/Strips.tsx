import React from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../../LanguageContext';
import type { HomeSectionItem, HomeTaxon, SiteMediaEntry } from '../../lib/api';
import SafeImage from '../ui/SafeImage';
import SectionHeader from './SectionHeader';
import Marquee from './Marquee';
import { useRail } from '../../lib/useRail';

/**
 * The shared shelf scroller: a snap rail on phones that relaxes into a
 * wrapping row from `sm` up. One implementation so every home shelf swipes,
 * snaps and spaces identically. Wrapping — not a grid — because these
 * shelves hold however many taxa the store really has: three categories in
 * a six-column grid is one short row and five columns of dead black, while
 * a wrapped row is simply three cards.
 */
function Rail({ children }: { children: React.ReactNode }) {
  // `useRail` detaches itself above `sm`, where this becomes a wrapped grid —
  // a drag handler still listening on a layout it does not own would swallow
  // clicks on the category cards.
  const rail = useRail();
  return (
    <div
      ref={rail.ref}
      className="flex gap-2.5 overflow-x-auto overscroll-x-contain hide-scrollbar snap-x pb-1 -mx-4 px-4 sm:mx-0 sm:px-0 sm:pb-0 sm:flex-wrap sm:overflow-visible sm:gap-3"
    >
      {children}
    </div>
  );
}

/** An owner-authored card: picture, label, optional sub-line, optional link. */
function ItemCard({ item }: { item: HomeSectionItem }) {
  const body = (
    <>
      <div className="aspect-[4/3] bg-zinc-950 overflow-hidden">
        {item.image ? (
          <SafeImage src={item.image} alt={item.title} aspect="auto" className="w-full h-full" />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-olive-dark to-olive" />
        )}
      </div>
      <div className="p-3 min-w-0">
        <h3 className="text-white font-bold text-[13px] leading-snug line-clamp-2">{item.title}</h3>
        {item.subtitle && <p className="text-xs text-zinc-400 line-clamp-2 mt-0.5">{item.subtitle}</p>}
      </div>
    </>
  );
  const className =
    'w-[180px] sm:w-[210px] shrink-0 snap-start rounded-2xl overflow-hidden bg-zinc-900/50 border border-zinc-800 hover:border-olive/50 transition-colors';

  if (item.link && item.link.startsWith('/')) {
    return (
      <Link to={item.link} data-strip-item={item.id} className={className}>
        {body}
      </Link>
    );
  }
  if (item.link) {
    return (
      <a href={item.link} target="_blank" rel="noopener noreferrer" data-strip-item={item.id} className={className}>
        {body}
      </a>
    );
  }
  return (
    <div data-strip-item={item.id} className={className}>
      {body}
    </div>
  );
}

/**
 * A horizontal strip of owner-authored cards — the `coupons_offers` section
 * and any owner-authored `categories`/`top_brands` cards.
 *
 * These were configurable in the admin panel and rendered NOWHERE: an owner
 * could fill in coupons and top brands and the storefront would silently
 * ignore every one of them. Renders nothing when empty, so an unconfigured
 * section costs no vertical space rather than showing an empty shelf.
 */
export function ItemStrip({
  id,
  title,
  accent,
  items,
}: {
  id: string;
  title: string;
  accent: string;
  items: HomeSectionItem[];
}) {
  if (items.length === 0) return null;
  return (
    <section data-home-section={id} className="mb-10 sm:mb-12">
      <SectionHeader title={title} accent={accent} />
      <Rail>
        {items.map((item) => (
          <ItemCard key={item.id} item={item} />
        ))}
      </Rail>
    </section>
  );
}

/** The first letter the shopper reads — the seed of a taxon's monogram tile. */
function monogramOf(name: string): string {
  return (name.trim()[0] || '•').toUpperCase();
}

/**
 * The brands strip: a self-scrolling ticker of brand marks, at the owner's
 * request — logos only, no cards or counts, drifting sideways until a finger
 * or pointer rests on it and resuming when it leaves.
 *
 * TWO SOURCES, one look. Owner-authored `top_brands` cards win and their
 * pictures ARE the logos, shown in a light puck so dark marks survive the
 * dark page. With none authored it falls back to the real `brands` table
 * ordered by how many active products carry each brand — that table has no
 * image column, so a gold monogram puck stands in rather than a fake logo.
 *
 * The loop renders the set several times so the belt never shows a seam;
 * only the FIRST copy carries data attributes and keyboard focus, so tests
 * count real brands (not copies) and a keyboard user meets each brand once.
 * prefers-reduced-motion parks the belt and leaves a plain swipeable rail.
 */
interface MarqueeEntry {
  key: string;
  name: string;
  image: string;
  link: string;
  /** data attribute name for the first copy: strip item vs brand chip. */
  data: 'strip' | 'brand';
  id: string;
}

function MarqueeMark({ entry, first }: { entry: MarqueeEntry; first: boolean }) {
  const body = (
    <>
      <span
        aria-hidden={!!entry.image || undefined}
        className={`w-14 h-14 rounded-full shrink-0 flex items-center justify-center overflow-hidden border ${
          entry.image
            ? 'bg-zinc-100 border-zinc-300/40'
            : 'bg-gold/10 border-gold/30 text-gold font-black text-base'
        }`}
      >
        {entry.image ? (
          <img src={entry.image} alt="" width={56} height={56} loading="lazy" decoding="async" className="w-full h-full object-contain p-2" />
        ) : (
          monogramOf(entry.name)
        )}
      </span>
      <span className="block w-full text-center text-[10px] font-semibold text-zinc-400 truncate group-hover:text-white transition-colors">
        {entry.name}
      </span>
    </>
  );
  const cls = 'group w-[84px] shrink-0 flex flex-col items-center gap-1.5 min-w-0';
  const dataProps: Record<string, unknown> = first
    ? { [entry.data === 'brand' ? 'data-brand-chip' : 'data-strip-item']: entry.id }
    : { 'aria-hidden': true, tabIndex: -1 };
  if (entry.link.startsWith('/')) {
    return (
      <Link to={entry.link} className={cls} {...dataProps}>
        {body}
      </Link>
    );
  }
  if (entry.link) {
    return (
      <a href={entry.link} target="_blank" rel="noopener noreferrer" className={cls} {...dataProps}>
        {body}
      </a>
    );
  }
  return (
    <span className={cls} {...dataProps}>
      {body}
    </span>
  );
}

export function BrandMarquee({ items, brands, siteMedia = [] }: {
  items: HomeSectionItem[];
  brands: HomeTaxon[];
  siteMedia?: SiteMediaEntry[];
}) {
  const { t, loc } = useLanguage();

  /**
   * THREE SOURCES, IN DESCENDING ORDER OF HOW DELIBERATE THEY ARE.
   *
   * 1. Cards the owner authored for this section — an explicit editorial
   *    choice, so nothing overrides them.
   * 2. The main-page brand slots. These carry REAL LOGOS: the seven marks the
   *    owner uploaded to `UiUx/MainPage/`, resolved into URLs by the server.
   * 3. The `brands` taxonomy table. It has no logo column at all, so every
   *    entry it produces renders as a gold monogram letter — correct as a last
   *    resort, and not what a brand belt is for.
   *
   * The middle source is the one that was missing. Before it, a shop with
   * seven logos sitting in R2 and no authored cards fell straight through to
   * (3) and drew seven letters.
   */
  const brandSlots = siteMedia.filter((m) => m.group === 'brand' && m.url);

  const entries: MarqueeEntry[] =
    items.length > 0
      ? items.map((it) => ({
          key: it.id,
          name: it.title,
          image: it.image,
          link: it.link,
          data: 'strip' as const,
          id: it.id,
        }))
      : brandSlots.length > 0
      ? brandSlots.map((m) => ({
          key: m.slot,
          name: m.label,
          image: m.url,
          link: m.link,
          data: 'brand' as const,
          id: m.slot,
        }))
      : brands.map((b) => ({
          key: b.id,
          name: loc(b.name_ar, b.name_en || b.name_ar, b.name_ckb),
          image: '',
          link: `/products?search=${encodeURIComponent(b.name_en || b.name_ar)}`,
          data: 'brand' as const,
          id: b.id,
        }));
  if (entries.length === 0) return null;

  return (
    <section data-home-section="top_brands" className="mb-10 sm:mb-12">
      <SectionHeader title={t('topBrands')} accent="bg-gold" />
      {/* Marquee measures the screen and repeats the set until the belt is
          wider than any viewport, so ONE brand still fills an iPad edge to
          edge and the loop has no visible seam. The set carries its own
          trailing space (pe-3 = the internal gap) so every copy's stride is
          identical — that exactness is what makes the wrap invisible.

          `bleed-x` is what makes "edge to edge" true on a LARGE screen. The
          negative margins that were here before (-mx-4 … lg:-mx-8) only
          cancelled the column's own padding, so above 80rem the belt stopped
          at the column's edge and left a gutter on each side — the owner's
          «يظهر اليمين واليسار فارغا ومقصوصا». See index.css. */}
      <Marquee
        speed={34}
        className="bleed-x"
        renderSet={(first) => (
          <div className="flex items-start gap-3 pe-3">
            {entries.map((e) => (
              <MarqueeMark key={e.key} entry={e} first={first} />
            ))}
          </div>
        )}
      />
    </section>
  );
}
