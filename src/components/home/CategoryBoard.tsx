import React from 'react';
import { Link } from 'react-router-dom';
import { useLanguage } from '../../LanguageContext';
import type { HomeTaxon } from '../../lib/api';
import SectionHeader from './SectionHeader';

/**
 * THE SHOP'S OWN DEPARTMENTS — main sections, each opened up to show the
 * sub-sections that actually hold something.
 *
 * WHAT THIS REPLACES, AND WHY IT IS NOT A RAIL. The categories section used to
 * be a row of small chips, one per top-level catalog, in the same horizontal
 * rail every other shelf uses. Two things were wrong with that. The owner's
 * request was explicit — «ترتيب الأقسام الرئيسية ثم الأقسام الفرعية التي فيها
 * المنتجات» — and a flat row cannot express "then": a sub-section had nowhere
 * to be. And every shelf on the page looking identical is the thing they asked
 * to stop: «لا تجعلها كلها يتبع نفس النمط وهو الشريط الأفقي».
 *
 * So this is a GRID of panels, not a rail. A department is a destination, not
 * something you flick past, and a grid is what lets each one carry its own
 * sub-sections underneath without turning the page into a wall of chips.
 *
 * COUNTS ROLL UP. The number on a main section counts everything below it too
 * (worker/lib/catalogMembership.ts), so "Printers · 3" is true even when all
 * three products are filed under "FDM Printers". A section whose count is zero
 * never arrives here at all — the server drops it, because a department card
 * that opens onto an empty list is a dead end.
 *
 * NO ARTWORK IS INVENTED. The `catalogs` table has no image column. A monogram
 * tile is an honest stand-in; a stock photo of somebody else's printer is not.
 */

/** The first letter the shopper reads — the seed of a section's monogram. */
function monogramOf(name: string): string {
  return (name.trim()[0] || '•').toUpperCase();
}

/** How many sub-section chips fit before the rest become a "+N" pill. */
const VISIBLE_CHILDREN = 4;

function SubChip({ child, name }: { child: HomeTaxon; name: string }) {
  return (
    <Link
      to={`/products?category=${encodeURIComponent(child.id)}`}
      data-category-chip={child.id}
      data-category-level="sub"
      className="inline-flex items-center gap-1 rounded-lg border border-border-subtle bg-black/30 px-2 py-1 text-[11px] font-medium text-zinc-400 hover:border-gold/50 hover:text-white transition-colors min-w-0"
    >
      <span className="truncate max-w-[9rem]">{name}</span>
      <span className="text-[10px] text-zinc-600 tabular-nums">{child.product_count}</span>
    </Link>
  );
}

function CategoryPanel({ category }: { category: HomeTaxon }) {
  const { loc } = useLanguage();
  const name = loc(category.name_ar, category.name_en || category.name_ar, category.name_ckb);
  const children = category.children ?? [];
  const shown = children.slice(0, VISIBLE_CHILDREN);
  const rest = children.length - shown.length;

  return (
    <div
      data-category-panel={category.id}
      className="flex flex-col rounded-2xl border border-border-subtle bg-surface p-3 sm:p-4 min-w-0 transition-colors hover:border-gold/30"
    >
      {/* The whole head is the link to the main section. The sub-chips below
          are their own links, which is why this is not one big <Link> around
          everything — a link inside a link is not a thing the DOM allows. */}
      <Link
        to={`/products?category=${encodeURIComponent(category.id)}`}
        data-category-chip={category.id}
        data-category-level="main"
        className="group flex items-center gap-3 min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus rounded-xl"
      >
        <span
          aria-hidden
          className="w-11 h-11 sm:w-12 sm:h-12 rounded-xl shrink-0 flex items-center justify-center bg-olive/40 border border-gold/25 text-gold font-black text-lg"
        >
          {monogramOf(name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] sm:text-[15px] font-bold text-white truncate group-hover:text-gold transition-colors">
            {name}
          </span>
          <span className="block text-[11px] text-zinc-500 tabular-nums">{category.product_count}</span>
        </span>
      </Link>

      {shown.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3 pt-3 border-t border-border-subtle">
          {shown.map((child) => (
            <SubChip
              key={child.id}
              child={child}
              name={loc(child.name_ar, child.name_en || child.name_ar, child.name_ckb)}
            />
          ))}
          {rest > 0 && (
            <Link
              to={`/products?category=${encodeURIComponent(category.id)}`}
              className="inline-flex items-center rounded-lg border border-border-subtle bg-black/30 px-2 py-1 text-[11px] font-medium text-zinc-500 hover:text-white transition-colors tabular-nums"
            >
              +{rest}
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

export default function CategoryBoard({ categories }: { categories: HomeTaxon[] }) {
  const { t } = useLanguage();
  if (categories.length === 0) return null;
  return (
    <section data-home-section="categories" className="mb-10 sm:mb-12">
      <SectionHeader title={t('browseCategories')} accent="bg-olive" to="/products" />
      {/* Two columns on a phone so a department is a real tap target rather
          than a sliver, four on a desktop. Not `auto-fit`: the panels carry
          different numbers of sub-chips and a fixed column count keeps their
          heads on one baseline across the row. */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2.5 sm:gap-3">
        {categories.map((category) => (
          <CategoryPanel key={category.id} category={category} />
        ))}
      </div>
    </section>
  );
}
