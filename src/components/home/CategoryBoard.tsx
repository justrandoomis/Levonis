import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../../LanguageContext';
import type { ApiProduct, HomeTaxon } from '../../lib/api';
import SafeImage from '../ui/SafeImage';
import SectionHeader from './SectionHeader';
import { productPrimaryImage } from '../../lib/productImage';
import { useRail } from '../../lib/useRail';

/**
 * THE SHOP'S OWN DEPARTMENTS — one heading per main section, with the
 * sub-sections underneath it as a rail you swipe.
 *
 * WHAT THIS REPLACES, AND WHY. It was a grid of panels: one small card per
 * department with its sub-sections crushed into 11px chips inside it. The
 * owner's verdict was «البطاقات في تصفح حسب القسم سيئة جدا جدا، يجب تغييرها
 * بشكل جذري», and their next sentence said exactly what to build instead:
 * «يكون اسم القسم كما هو في (تصفح حسب الأقسام أو أبرز العلامات) يكون اسم القسم
 * الرئيسي وأسفله يكون تمرير أفقي ببطاقات بالأقسام الفرعية» — the main
 * section's name at heading altitude, and below it a horizontal scroll of
 * cards for the sub-sections.
 *
 * Those chips were about 24px tall, which is a third of the 44px this app
 * holds everywhere a finger is expected, and their only content was a
 * truncated name beside a bare unlabelled numeral. A department name never
 * appeared as a heading at all.
 *
 * THERE IS NO BLOCK HEADING ANY MORE, and that is deliberate. «تصفّح حسب
 * القسم» above «الطابعات» is a heading over a heading; with the live
 * catalogue — one department — it would be two lines of chrome introducing one
 * rail. The words survive as this region's accessible name, so the block is
 * still announced as one thing.
 *
 * WHERE THE PICTURES COME FROM, and what they do not promise. `catalogs` has
 * no image column and never has had (migrations/0002), so a sub-section
 * borrows the photo of a product already on this page, keyed by the
 * classification column the product form actually writes. That column is not
 * the same relation as the count: `product_count` rolls up through the union
 * of classification and `product_catalogs` across every descendant
 * (worker/lib/catalogMembership.ts), so a sub-section can truthfully say «4
 * منتجات» and still have nothing here to take a picture from. Every card is
 * built to be right with no picture — the monogram is the designed state, not
 * an error state — and no artwork is ever invented for a section that has
 * none.
 *
 * A DEPARTMENT WITH NO SUB-SECTIONS gets a door instead of a rail. Its
 * products are filed at its own level, so there is nothing to put in a rail,
 * and a heading over an empty strip is a dead end. The seeded taxonomy has
 * one such department today (`cat_accessories`), so this is a real case.
 */

/** The first letter the shopper reads — the seed of a section's monogram. */
function monogramOf(name: string): string {
  return (name.trim()[0] || '•').toUpperCase();
}

/**
 * A stable tint per section, so a rail of image-less cards does not read as a
 * rendering fault.
 *
 * Sibling sections often share a first letter — «الطابعات», «طابعات FDM» and
 * «طابعات Resin» all seed «ط» — so the monogram alone cannot tell them apart.
 * The hash is over the id, which is stable across renders and across reloads;
 * two siblings can still collide, which is why the NAME under the tile is
 * what identifies it and the tint is only there to break up the row.
 */
const TINTS = [
  'from-olive/40 to-olive-dark/20 text-gold',
  'from-gold/25 to-olive/20 text-gold',
  'from-zinc-700/50 to-zinc-800/30 text-zinc-200',
  'from-rose-500/20 to-olive/20 text-rose-200',
  'from-sky-500/20 to-olive/20 text-sky-200',
] as const;

function tintOf(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return TINTS[h % TINTS.length];
}

/**
 * One sub-section, as a card big enough to aim at.
 *
 * 132px wide and a 4:3 plate: wide enough for a real product photo to be
 * recognisable at a glance and for two Arabic words to sit on one line, and
 * narrow enough that a phone shows two and a half of them — the half is the
 * affordance that says the rail scrolls.
 */
function SubCard({ node, cover }: { node: HomeTaxon; cover?: string }) {
  const { loc, t } = useLanguage();
  const name = loc(node.name_ar, node.name_en || node.name_ar, node.name_ckb);
  return (
    <div role="listitem" className="snap-start shrink-0">
      <Link
        to={`/products?category=${encodeURIComponent(node.id)}`}
        data-category-chip={node.id}
        data-category-level="sub"
        className="group flex w-[132px] sm:w-[150px] flex-col overflow-hidden rounded-xl border border-border-subtle bg-surface hover:bg-surface-raised hover:border-gold/40 transition-colors min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <span className="block aspect-[4/3] overflow-hidden bg-black">
          {cover ? (
            <SafeImage
              src={cover}
              alt=""
              aspect="auto"
              className="w-full h-full group-hover:scale-[1.04] transition-transform duration-500 motion-reduce:transition-none"
            />
          ) : (
            <span
              aria-hidden
              className={`w-full h-full grid place-items-center bg-gradient-to-br font-black text-2xl ${tintOf(node.id)}`}
            >
              {monogramOf(name)}
            </span>
          )}
        </span>
        <span className="p-2.5 flex flex-col gap-0.5 min-w-0">
          <span className="text-[13px] font-bold text-white leading-snug line-clamp-2 min-h-[2.2em]">{name}</span>
          <span className="text-[11px] text-zinc-500 tabular-nums">
            {node.product_count} {t('productCount')}
          </span>
        </span>
      </Link>
    </div>
  );
}

/**
 * A department whose products are filed at its own level — no sub-sections to
 * scroll, so the card IS the way in rather than a strip of nothing.
 */
function DoorCard({ category, cover }: { category: HomeTaxon; cover?: string }) {
  const { loc, t } = useLanguage();
  const name = loc(category.name_ar, category.name_en || category.name_ar, category.name_ckb);
  return (
    <Link
      to={`/products?category=${encodeURIComponent(category.id)}`}
      data-category-chip={category.id}
      data-category-level="main"
      className="group flex items-center gap-3 rounded-xl border border-border-subtle bg-surface hover:bg-surface-raised hover:border-gold/40 transition-colors p-2.5 min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <span className="block w-16 h-16 shrink-0 overflow-hidden rounded-lg bg-black">
        {cover ? (
          <SafeImage src={cover} alt="" aspect="auto" className="w-full h-full" />
        ) : (
          <span
            aria-hidden
            className={`w-full h-full grid place-items-center bg-gradient-to-br font-black text-xl ${tintOf(category.id)}`}
          >
            {monogramOf(name)}
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-bold text-white truncate group-hover:text-gold transition-colors">
          {name}
        </span>
        <span className="block text-[11px] text-zinc-500 tabular-nums">
          {category.product_count} {t('productCount')}
        </span>
      </span>
    </Link>
  );
}

/** One department: its name as a heading, its sub-sections as a rail. */
function CategoryShelf({
  category,
  coverOf,
}: {
  category: HomeTaxon;
  coverOf: (id: string) => string | undefined;
}) {
  const { loc } = useLanguage();
  // `useRail` owns the RTL scroll conventions, the snap padding and the
  // overscroll containment that stops a flick at the start of an Arabic rail
  // from navigating the browser back out of the page. Every rail on this page
  // goes through it, so they all behave the same way.
  const rail = useRail();
  const name = loc(category.name_ar, category.name_en || category.name_ar, category.name_ckb);
  const children = category.children ?? [];
  const headingId = `cat-${category.id}`;
  const to = `/products?category=${encodeURIComponent(category.id)}`;

  return (
    <section data-category-shelf={category.id} aria-labelledby={headingId} className="mb-7 sm:mb-9 last:mb-0">
      <SectionHeader id={headingId} title={name} accent="bg-olive" count={category.product_count} to={to} />
      {children.length > 0 ? (
        <div
          ref={rail.ref}
          role="list"
          // The `-mx-4 px-4` bleed is SYMMETRIC on purpose and must not become
          // `-ms-4 ps-4` in a later logical-properties sweep: a one-sided bleed
          // leaves the other edge unbled and causes a horizontal page scroll in
          // exactly one direction, which is the hardest kind to notice.
          className="flex gap-2.5 sm:gap-3 overflow-x-auto overscroll-x-contain hide-scrollbar pb-2 -mx-4 px-4 sm:mx-0 sm:px-0 snap-x"
        >
          {children.map((child) => (
            <SubCard key={child.id} node={child} cover={coverOf(child.id)} />
          ))}
        </div>
      ) : (
        <DoorCard category={category} cover={coverOf(category.id)} />
      )}
    </section>
  );
}

export default function CategoryBoard({
  categories,
  products = [],
}: {
  categories: HomeTaxon[];
  /**
   * Products the page has ALREADY fetched. Nothing is requested for this
   * component; the covers are borrowed from what is on screen anyway, and a
   * section the page happens to hold no product for simply shows its
   * monogram.
   */
  products?: ApiProduct[];
}) {
  const { t } = useLanguage();

  // First writer wins, so the cover for a section is stable within a render
  // rather than flickering between products as arrays re-order.
  const covers = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of products) {
      const image = productPrimaryImage(p);
      if (!image) continue;
      for (const key of [p.sub_category_id, p.category_id]) {
        if (key && !map.has(key)) map.set(key, image);
      }
    }
    return map;
  }, [products]);

  if (categories.length === 0) return null;

  return (
    // Named by `aria-label` rather than a visible heading — see the note at
    // the top of this file. If that label is ever dropped, this becomes an
    // unnamed run of h2s with nothing saying they belong together.
    <section data-home-section="categories" aria-label={t('browseCategories')} className="mb-10 sm:mb-12">
      {categories.map((category) => (
        <CategoryShelf key={category.id} category={category} coverOf={(id) => covers.get(id)} />
      ))}
    </section>
  );
}
