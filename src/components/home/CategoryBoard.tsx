import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../../LanguageContext';
import type { ApiProduct, HomeTaxon } from '../../lib/api';
import SectionHeader from './SectionHeader';
import { itemCountLabel } from '../orders/format';
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
 * TWO HEADING LEVELS, NOT ONE. «تصفّح حسب القسم» stays as the block's h2 and
 * each department is an h3 beneath it. The owner's sentence asks for the
 * department name to read «كما هو في تصفح حسب الأقسام» — at that altitude,
 * alongside it — not instead of it, and dropping the block heading would put
 * «تصفّح حسب القسم» nowhere while five department names arrived as siblings of
 * every other shelf on the page. A heading over a heading is only clutter when
 * they are the same size; these are not.
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
 * what identifies it and the tint is only there to break up the row. Nothing
 * here carries meaning by colour alone.
 *
 * THESE COLOURS ARE NOT DECORATIVE CHOICES, they are measured ones. The first
 * attempt used the olive tokens, and olive on this page is nearly black:
 * `--color-olive` is #1B2010 and `--color-olive-dark` is #0F1208, so
 * `from-olive/40` over `--color-surface` (#131519) composites to #161915 — a
 * contrast of 1.03:1 against the card it sits in, which is to say invisible.
 * The tint would have been a no-op and every plate would have read as an
 * empty black rectangle with a letter in it.
 *
 * Each entry below composites to between 1.50:1 and 1.68:1 against the card,
 * which is enough to read as a panel, and the monogram over it lands between
 * 4.4:1 and 4.9:1, which is enough to read as a letter. They separate by HUE
 * rather than by luminance, on purpose: a row of plates at five different
 * brightnesses would imply a ranking that does not exist.
 */
const TINTS = [
  'from-gold/25 to-gold/10 text-gold',
  'from-sky-400/25 to-sky-400/10 text-sky-200',
  'from-rose-400/25 to-rose-400/10 text-rose-200',
  'from-emerald-400/25 to-emerald-400/10 text-emerald-200',
  'from-violet-400/25 to-violet-400/10 text-violet-200',
] as const;

function tintOf(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return TINTS[h % TINTS.length];
}

/**
 * The picture, or the monogram when there is not one — and when there is one
 * that does not load.
 *
 * THIS IS NOT SafeImage, and that is the point. SafeImage's failure state
 * renders a RETRY BUTTON (src/components/ui/SafeImage.tsx:128-136), and these
 * plates live inside a `<Link>`: a button inside an anchor is interactive
 * content nested in interactive content, which no browser agrees on and no
 * keyboard user can escape cleanly. A broken cover here has a better answer
 * anyway — the monogram, which is already the designed state for a section
 * with no photo at all. A shopper cannot tell the two apart, and should not
 * have to.
 */
function CoverPlate({
  cover,
  tint,
  monogram,
  className,
  imgClassName = '',
}: {
  cover?: string;
  tint: string;
  monogram: string;
  className: string;
  imgClassName?: string;
}) {
  const [broken, setBroken] = useState(false);
  const usable = cover && !broken;
  return (
    <span className={`block overflow-hidden bg-black ${className}`}>
      {usable ? (
        <img
          src={cover}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setBroken(true)}
          className={`w-full h-full object-cover ${imgClassName}`}
        />
      ) : (
        <span aria-hidden className={`w-full h-full grid place-items-center bg-gradient-to-br font-black ${tint}`}>
          {monogram}
        </span>
      )}
    </span>
  );
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
  const { loc, lang } = useLanguage();
  const name = loc(node.name_ar, node.name_en || node.name_ar, node.name_ckb);
  return (
    <Link
      to={`/products?category=${encodeURIComponent(node.id)}`}
      data-category-chip={node.id}
      data-category-level="sub"
      className="group snap-start shrink-0 flex w-[132px] sm:w-[150px] flex-col overflow-hidden rounded-xl border border-border-subtle bg-surface hover:bg-surface-raised hover:border-gold/40 transition-colors min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <CoverPlate
        cover={cover}
        tint={`text-2xl ${tintOf(node.id)}`}
        monogram={monogramOf(name)}
        className="aspect-[4/3]"
        imgClassName="group-hover:scale-[1.04] transition-transform duration-500 motion-reduce:transition-none"
      />
      <span className="p-2.5 flex flex-col gap-0.5 min-w-0">
        <span className="text-[13px] font-bold text-white leading-snug line-clamp-2 min-h-[2.2em]">{name}</span>
        {/* zinc-400, not zinc-500: at 11px on `--color-surface` zinc-500 is
            about 3.8:1, under the 4.5:1 that small text needs. */}
        <span className="text-[11px] text-zinc-400 tabular-nums">{itemCountLabel(node.product_count, lang)}</span>
      </span>
    </Link>
  );
}

/**
 * A department whose products are filed at its own level — no sub-sections to
 * scroll, so this card IS the way in rather than a strip of nothing.
 *
 * It deliberately does NOT repeat the department's name or its count: both are
 * three millimetres above it in the heading this sits under, and a card that
 * says the same two things again is the redundancy the old panels were made
 * of. Its accessible name carries the department, because «عرض الكل» on its
 * own is not a destination.
 */
function DoorCard({ category, cover }: { category: HomeTaxon; cover?: string }) {
  const { loc, t } = useLanguage();
  const name = loc(category.name_ar, category.name_en || category.name_ar, category.name_ckb);
  return (
    <Link
      to={`/products?category=${encodeURIComponent(category.id)}`}
      data-category-chip={category.id}
      data-category-level="main"
      aria-label={loc(`عرض كل ${name}`, `See all ${name}`, `هەموو ${name}`)}
      className="group flex items-center gap-3 rounded-xl border border-border-subtle bg-surface hover:bg-surface-raised hover:border-gold/40 transition-colors p-2.5 min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <CoverPlate
        cover={cover}
        tint={`text-xl ${tintOf(category.id)}`}
        monogram={monogramOf(name)}
        className="w-16 h-16 shrink-0 rounded-lg"
      />
      <span aria-hidden className="text-[14px] font-bold text-zinc-300 group-hover:text-white transition-colors">
        {t('seeAll')}
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
    // A plain div, not a <section aria-labelledby>. A named section is an ARIA
    // LANDMARK, and five departments would put five new landmarks on a page
    // whose every other shelf is an unnamed <section>. The h2/h3 hierarchy
    // already carries the structure, and a screen reader navigates it by
    // heading like every other shelf here.
    <div data-category-shelf={category.id} className="mb-7 sm:mb-9 last:mb-0">
      <SectionHeader
        level="h3"
        id={headingId}
        title={name}
        accent="bg-olive"
        to={to}
        linkLabel={loc(`عرض كل ${name}`, `See all ${name}`, `هەموو ${name}`)}
        // The count rides the HEADING only when there are no cards below to
        // carry it. With sub-sections the roll-up would sit three millimetres
        // above the same numbers broken down — and on the live shop, where one
        // department holds one sub-section, it would print «3 منتجات» twice.
        count={children.length > 0 ? undefined : category.product_count}
      />
      {children.length > 0 ? (
        <div
          ref={rail.ref}
          // The `-mx-4 px-4` bleed is SYMMETRIC on purpose and must not become
          // `-ms-4 ps-4` in a later logical-properties sweep: a one-sided bleed
          // leaves the other edge unbled and causes a horizontal page scroll in
          // exactly one direction, which is the hardest kind to notice.
          //
          // `pt-1` is not spacing. `overflow-x-auto` forces the computed
          // `overflow-y` to `auto`, so without it a card's 2px focus ring is
          // clipped along its top edge — visible only to whoever is using the
          // keyboard, which is exactly who needs it.
          className="flex gap-2.5 sm:gap-3 overflow-x-auto overscroll-x-contain hide-scrollbar pt-1 pb-2 -mx-4 px-4 sm:mx-0 sm:px-0 snap-x"
        >
          {children.map((child) => (
            <SubCard key={child.id} node={child} cover={coverOf(child.id)} />
          ))}
        </div>
      ) : (
        <DoorCard category={category} cover={coverOf(category.id)} />
      )}
    </div>
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
    <section data-home-section="categories" className="mb-10 sm:mb-12">
      {/* The block keeps its own heading. Each department below is an h3 under
          it, so «تصفّح حسب القسم» is still somewhere in the outline and the
          department names sit at the altitude the owner asked for without
          replacing the thing they were meant to sit beside. */}
      <SectionHeader title={t('browseCategories')} accent="bg-olive" to="/products" />
      {categories.map((category) => (
        <CategoryShelf key={category.id} category={category} coverOf={(id) => covers.get(id)} />
      ))}
    </section>
  );
}
