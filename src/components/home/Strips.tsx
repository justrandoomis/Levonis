import React from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import type { HomeSectionItem, HomeTaxon } from '../../lib/api';
import SafeImage from '../ui/SafeImage';

/** Section header with an optional "see all" affordance. */
function Heading({ title, accent, to }: { title: string; accent: string; to?: string }) {
  const { t, dir } = useLanguage();
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;
  return (
    <div className="flex items-center justify-between gap-3 mb-6">
      <div className="flex items-center gap-3 min-w-0">
        <div className={`w-1 h-6 rounded-full shrink-0 ${accent}`} />
        <h2 className="text-xl md:text-2xl font-bold text-white truncate">{title}</h2>
      </div>
      {to && (
        <Link
          to={to}
          className="shrink-0 min-h-[44px] flex items-center gap-1 text-sm text-zinc-400 hover:text-white transition-colors bg-zinc-900/80 px-3 rounded-full"
        >
          <span>{t('seeAll')}</span>
          <Chevron className="w-4 h-4" />
        </Link>
      )}
    </div>
  );
}

/** An owner-authored card: picture, label, optional sub-line, optional link. */
function ItemCard({ item }: { item: HomeSectionItem }) {
  const body = (
    <>
      <div className="aspect-[4/3] bg-black/40 overflow-hidden">
        {item.image ? (
          <SafeImage src={item.image} alt={item.title} aspect="auto" className="w-full h-full" />
        ) : (
          <div className="w-full h-full bg-gradient-to-br from-olive-dark to-olive" />
        )}
      </div>
      <div className="p-3 min-w-0">
        <h3 className="text-white font-bold text-sm line-clamp-2">{item.title}</h3>
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
 * A horizontal strip of owner-authored cards — the `coupons_offers` and
 * `top_brands` sections of the home layout.
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
    <section data-home-section={id} className="mb-12">
      <Heading title={title} accent={accent} />
      <div className="flex gap-3 sm:gap-4 overflow-x-auto hide-scrollbar pb-2 -mx-4 px-4 sm:mx-0 sm:px-0 snap-x">
        {items.map((item) => (
          <ItemCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}

/**
 * The real catalogue, as chips that filter the product list.
 *
 * Sourced from the `catalogs` table rather than from owner-typed items, so it
 * is right the day a section is added and cannot drift out of step with the
 * taxonomy. /api/home already filters out catalogs with no active product —
 * a category chip that leads to an empty list is a dead end.
 */
export function CategoryChips({ categories }: { categories: HomeTaxon[] }) {
  const { t, loc } = useLanguage();
  if (categories.length === 0) return null;
  return (
    <section data-home-section="categories" className="mb-12">
      <Heading title={t('browseCategories')} accent="bg-olive" to="/products" />
      <div className="flex flex-wrap gap-2">
        {categories.map((c) => (
          <Link
            key={c.id}
            to={`/products?category=${encodeURIComponent(c.id)}`}
            data-category-chip={c.id}
            className="min-h-[44px] flex items-center gap-2 px-4 rounded-full bg-zinc-900/60 border border-zinc-800 hover:border-olive/60 hover:bg-olive/10 transition-colors min-w-0"
          >
            <span className="text-sm font-bold text-white truncate max-w-[12rem]">
              {loc(c.name_ar, c.name_en || c.name_ar, c.name_ckb)}
            </span>
            <span className="text-[11px] text-zinc-500 shrink-0">{c.product_count}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

/**
 * Top brands from the real `brands` table, ordered by how many active
 * products actually carry them. Used only when the owner has authored no
 * `top_brands` cards of their own — theirs can carry a logo, this cannot,
 * since the brands table has no image column.
 */
export function BrandChips({ brands }: { brands: HomeTaxon[] }) {
  const { t, loc } = useLanguage();
  if (brands.length === 0) return null;
  return (
    <section data-home-section="top_brands" className="mb-12">
      <Heading title={t('topBrands')} accent="bg-gold" />
      <div className="flex flex-wrap gap-2">
        {brands.map((b) => (
          <Link
            key={b.id}
            to={`/products?search=${encodeURIComponent(b.name_en || b.name_ar)}`}
            data-brand-chip={b.id}
            className="min-h-[44px] flex items-center gap-2 px-4 rounded-full bg-zinc-900/60 border border-zinc-800 hover:border-gold/60 transition-colors min-w-0"
          >
            <span className="text-sm font-bold text-white truncate max-w-[12rem]">
              {loc(b.name_ar, b.name_en || b.name_ar, b.name_ckb)}
            </span>
            <span className="text-[11px] text-zinc-500 shrink-0">{b.product_count}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
