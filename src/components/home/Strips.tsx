import React from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../../LanguageContext';
import type { HomeSectionItem, HomeTaxon } from '../../lib/api';
import SafeImage from '../ui/SafeImage';
import SectionHeader from './SectionHeader';

/**
 * The shared shelf scroller: a snap rail on phones that relaxes into a
 * wrapping row from `sm` up. One implementation so every home shelf swipes,
 * snaps and spaces identically. Wrapping — not a grid — because these
 * shelves hold however many taxa the store really has: three categories in
 * a six-column grid is one short row and five columns of dead black, while
 * a wrapped row is simply three cards.
 */
function Rail({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5 overflow-x-auto overscroll-x-contain hide-scrollbar snap-x pb-1 -mx-4 px-4 sm:mx-0 sm:px-0 sm:pb-0 sm:flex-wrap sm:overflow-visible sm:gap-3">
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
 * The real catalogue, as a browsing rail near the top of the page.
 *
 * Sourced from the `catalogs` table rather than from owner-typed items, so it
 * is right the day a section is added and cannot drift out of step with the
 * taxonomy. /api/home already filters out catalogs with no active product —
 * a category card that leads to an empty list is a dead end. The table has no
 * image column, so each card carries a monogram tile instead of pretending
 * to have artwork.
 */
export function CategoryChips({ categories }: { categories: HomeTaxon[] }) {
  const { t, loc } = useLanguage();
  if (categories.length === 0) return null;
  return (
    <section data-home-section="categories" className="mb-10 sm:mb-12">
      <SectionHeader title={t('browseCategories')} accent="bg-olive" to="/products" />
      <Rail>
        {categories.map((c) => {
          const name = loc(c.name_ar, c.name_en || c.name_ar, c.name_ckb);
          return (
            <Link
              key={c.id}
              to={`/products?category=${encodeURIComponent(c.id)}`}
              data-category-chip={c.id}
              className="w-[148px] sm:w-[190px] shrink-0 snap-start flex items-center gap-2.5 rounded-xl border border-zinc-800 bg-zinc-900/50 p-2.5 min-h-[60px] hover:border-olive/60 hover:bg-olive/10 transition-colors min-w-0"
            >
              <span
                aria-hidden
                className="w-9 h-9 rounded-lg shrink-0 flex items-center justify-center bg-olive/20 border border-olive/30 text-olive-light font-black text-sm"
              >
                {monogramOf(name)}
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-bold text-white truncate">{name}</span>
                <span className="block text-[11px] text-zinc-500">{c.product_count}</span>
              </span>
            </Link>
          );
        })}
      </Rail>
    </section>
  );
}

/**
 * Top brands from the real `brands` table, ordered by how many active
 * products actually carry them. Used only when the owner has authored no
 * `top_brands` cards of their own — theirs can carry a logo, this cannot,
 * since the brands table has no image column; a gold monogram medallion
 * stands in, at a constant size so the rail never ragged-edges.
 */
export function BrandChips({ brands }: { brands: HomeTaxon[] }) {
  const { t, loc } = useLanguage();
  if (brands.length === 0) return null;
  return (
    <section data-home-section="top_brands" className="mb-10 sm:mb-12">
      <SectionHeader title={t('topBrands')} accent="bg-gold" />
      <Rail>
        {brands.map((b) => {
          const name = loc(b.name_ar, b.name_en || b.name_ar, b.name_ckb);
          return (
            <Link
              key={b.id}
              to={`/products?search=${encodeURIComponent(b.name_en || b.name_ar)}`}
              data-brand-chip={b.id}
              className="w-[120px] sm:w-[136px] shrink-0 snap-start flex flex-col items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/50 px-3 py-3.5 min-h-[104px] hover:border-gold/50 transition-colors min-w-0"
            >
              <span
                aria-hidden
                className="w-11 h-11 rounded-full shrink-0 flex items-center justify-center bg-gold/10 border border-gold/30 text-gold font-black"
              >
                {monogramOf(b.name_en || b.name_ar)}
              </span>
              <span className="min-w-0 w-full text-center">
                <span className="block text-[12px] font-bold text-white truncate">{name}</span>
                <span className="block text-[10px] text-zinc-500">{b.product_count}</span>
              </span>
            </Link>
          );
        })}
      </Rail>
    </section>
  );
}
