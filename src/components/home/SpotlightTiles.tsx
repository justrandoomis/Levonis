import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, Flame, ChevronLeft, ChevronRight } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { formatIqd, type ApiProduct } from '../../lib/api';
import SafeImage from '../ui/SafeImage';
import { productPrimaryImage } from '../../lib/productImage';
import { rankByAffinity, readRecentlyViewed } from '../../lib/recentlyViewed';

/**
 * THE TWO TILES THAT CHANGE WHILE YOU LOOK AT THEM — «سلكشن» and «سوبر ديلز».
 *
 * The owner asked for exactly this shape: two panels side by side, each
 * showing a handful of products, the set swapping every few seconds —
 * "Selection" chosen for the shopper, "Super Deals" chosen by the shop to
 * move stock.
 *
 * WHY THEY ARE SIDE BY SIDE AT EVERY WIDTH, INCLUDING THE NARROWEST PHONE.
 * They were not. The outer grid was `grid-cols-1 sm:grid-cols-2`, so below
 * 640px each tile took the whole column and they STACKED, and inside each one
 * a two-column grid of square images made every thumbnail half the screen
 * wide. The owner reported it from their phone: «شكل البطاقتين في مختارة لك
 * وصفقات مميزة كبيرة جدا, يجب جعلها في سطر واحد صغيرة».
 *
 * THE ARITHMETIC, because it is what a future change would break. The home
 * column is `max-w-7xl mx-auto px-4` (src/pages/Home.tsx), so a 393px phone
 * gives 361px of content. Two tiles with `gap-2` → (361 − 8) / 2 = 176.5px
 * each; `p-2.5` inside → 156.5px; a two-column slot grid with `gap-2` →
 * 74.25px per product.
 *
 * 74px IS THE NUMBER THE PRICE HAD TO FIT IN. `formatIqd` emits grouped
 * digits plus a currency word — «1,525,000 د.ع» — which in Cairo at 11px
 * measures about 64px (7 digits at 0.56em, two commas, a space, and «د.ع» at
 * roughly 1.1em). It fits with room to spare, and the struck-through regular
 * price is held back to `sm` and up rather than squeezed in beside it.
 *
 * A TRUNCATED PRICE IS A WRONG PRICE, which is why `truncate` is gone from
 * PricePlate entirely. «1,525,0…» does not read as an unfinished number; it
 * reads as a smaller one. The plate wraps instead, and reserves its height so
 * a wrapping second line cannot change the tile's height between pages.
 *
 * THE SECTION NAME IS PRINTED ONCE. It used to be passed as both `badge` and
 * `title` — the same string, rendered twice — which at 156px of header could
 * not fit and silently truncated the second copy. One accent tick, one icon,
 * one name, one direction-aware chevron, borrowed from SectionHeader so the
 * page has one vocabulary for "this is a section and it leads somewhere".
 *
 * THE ROTATION, AND THE FOUR THINGS THAT MAKE IT BEARABLE.
 *
 *   IT STOPS WHEN WATCHED. Hover, touch or keyboard focus anywhere in a tile
 *   pauses that tile. A set that swaps out from under a thumb reaching for it
 *   is worse than no rotation at all.
 *
 *   A TOUCH IS NOT A HOVER. On a touch pointer the browser fires
 *   `pointerenter` immediately before `pointerdown` and `pointerleave`
 *   immediately after `pointerup`, so pause-on-hover alone paused the tile for
 *   about a tenth of a second — which is to say, not at all. A non-mouse
 *   pointer now arms a real hold, and the hold expires on its own so a tile
 *   touched once is not frozen for the rest of the visit.
 *
 *   IT DOES NOT MOVE THE PAGE. Every slot is fixed-aspect and a short last
 *   page keeps its empty slots, so the tile's height never changes as sets
 *   swap and nothing below it jumps.
 *
 *   IT RESPECTS prefers-reduced-motion by not rotating. Not by rotating
 *   without a transition — by holding the first set still. Involuntary
 *   content change is exactly what that preference is about, and the dots
 *   below remain as a manual control so nothing becomes unreachable. That is
 *   also why those dots are real 44px targets with a small dot drawn inside
 *   them: for a reduced-motion visitor they are the ONLY way to the rest of
 *   the products, and a 6px button is not a way to anything.
 */

/** Seven seconds: long enough to read a set, short enough to feel live. */
const ROTATE_MS = 7000;

/**
 * How long a touch hold keeps a tile paused. Long enough to read the set and
 * decide, short enough that a tile brushed on the way past starts moving again
 * without the visitor doing anything about it.
 */
const TOUCH_HOLD_MS = 15000;

/** Products per set. Two columns, two rows — the same shape at every width. */
const PER_PAGE = 4;

/**
 * At most this many sets per tile, so eight products are reachable and the dot
 * row stays small: two dots at 28px plus one 4px gap is 60px, well inside the
 * 152.5px a phone tile has.
 *
 * It is a CEILING, not a constant, and the difference matters: a shop with
 * three super deals gets one set and NO dots at all (the row only renders
 * above one page). The server may legitimately send twelve — the rest are
 * behind the section link, because dots are the wrong control for twelve
 * things and a second scroller inside a tile this size is worse.
 */
const MAX_PAGES = 2;

function PricePlate({ p }: { p: ApiProduct }) {
  const display = p.display_price_iqd ?? p.price_iqd;
  const regular = p.display_regular_iqd ?? p.price_iqd;
  const discounted = display < regular;
  return (
    // `min-h` reserves the second line so a wrapping price cannot change the
    // tile's height when the set rotates. `flex-wrap` rather than `truncate`:
    // see the note above — a clipped price is a different number.
    // `leading-4` (16px) on both spans is what makes the reserve exact. An
    // arbitrary `text-[11px]` sets the font size ONLY — the line height is
    // still inherited from the page's 1.5, so the line box would be 16.5px or
    // 18px depending on the breakpoint and a height reserved in `rem` would be
    // a guess. Pinning the leading makes one line exactly 16px, and that is
    // the number below.
    <span className="flex flex-wrap items-baseline gap-x-1 gap-y-0.5 content-start min-w-0 min-h-4">
      <span
        className={`text-[11px] sm:text-[12px] leading-4 font-bold tabular-nums whitespace-nowrap ${
          discounted ? 'text-gold' : 'text-white'
        }`}
      >
        {formatIqd(display)}
      </span>
      {/* The struck regular price needs about 58px of its own and there are
          only ~74 in a phone slot, so it is held back to `sm`. On a phone the
          gold display price is what says "this is less than it was" — the same
          signal, in the space that exists. */}
      {discounted && (
        <span className="hidden sm:inline text-[10px] leading-4 text-zinc-400 line-through tabular-nums whitespace-nowrap">
          {formatIqd(regular)}
        </span>
      )}
    </span>
  );
}

function Slot({ p }: { p: ApiProduct }) {
  return (
    <Link
      to={`/product/${p.slug || p.id}`}
      data-spotlight-item={p.id}
      className="group flex flex-col gap-1 min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus rounded-lg"
    >
      <span className="block aspect-square overflow-hidden rounded-lg bg-black">
        <SafeImage
          src={productPrimaryImage(p)}
          alt={p.name}
          aspect="auto"
          className="w-full h-full group-hover:scale-[1.05] transition-transform duration-500 motion-reduce:transition-none"
        />
      </span>
      <PricePlate p={p} />
    </Link>
  );
}

function Tile({
  title,
  icon,
  accent,
  products,
  to,
}: {
  title: string;
  icon: React.ReactNode;
  /** Tailwind background class for the accent tick, e.g. "bg-gold". */
  accent: string;
  products: ApiProduct[];
  to: string;
}) {
  const { dir } = useLanguage();
  const Chevron = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const [page, setPage] = useState(0);
  const [paused, setPaused] = useState(false);
  const reduced = useRef(false);
  const holdTimer = useRef<number | null>(null);

  // The sets are fixed up front, so a re-render cannot reshuffle what the
  // shopper is mid-way through reading.
  const pages = useMemo(() => {
    const out: ApiProduct[][] = [];
    for (let i = 0; i < products.length; i += PER_PAGE) out.push(products.slice(i, i + PER_PAGE));
    return out.filter((set) => set.length > 0);
  }, [products]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    try {
      reduced.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      reduced.current = false;
    }
  }, []);

  useEffect(() => {
    if (paused || reduced.current || pages.length < 2) return;
    const timer = window.setInterval(() => setPage((n) => (n + 1) % pages.length), ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [paused, pages.length]);

  // Clearing the hold on unmount, because a timer that outlives its component
  // calls setState on nothing and logs a warning nobody can act on.
  useEffect(
    () => () => {
      if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    },
    []
  );

  const holdPause = useCallback(() => {
    setPaused(true);
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null;
      setPaused(false);
    }, TOUCH_HOLD_MS);
  }, []);

  if (pages.length === 0) return null;
  const current = pages[Math.min(page, pages.length - 1)];

  return (
    <div
      className="flex flex-col rounded-2xl border border-border-subtle bg-surface p-2.5 sm:p-3 min-w-0"
      onPointerEnter={(e) => {
        if (e.pointerType === 'mouse') setPaused(true);
      }}
      onPointerLeave={(e) => {
        // A touch hold owns the pause until it expires; `pointerleave` fires
        // the instant the finger lifts, which is not the moment the visitor
        // stopped looking.
        if (e.pointerType === 'mouse' && holdTimer.current === null) setPaused(false);
      }}
      onPointerDown={(e) => {
        if (e.pointerType !== 'mouse') holdPause();
      }}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => {
        if (holdTimer.current === null) setPaused(false);
      }}
    >
      {/* ONE link, one name. SectionHeader's vocabulary at a smaller scale:
          the accent tick, the title, and a chevron that points the way the
          language reads. */}
      <Link
        to={to}
        className="flex items-center gap-1.5 min-h-[36px] mb-1.5 min-w-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <span aria-hidden className={`w-1 h-4 rounded-full shrink-0 ${accent}`} />
        {icon}
        {/* An h2, like every other shelf on this page. It was a plain span, so
            these two sections did not exist to heading navigation at all. */}
        <h2 className="text-[12px] sm:text-[13px] font-bold text-white truncate">{title}</h2>
        <Chevron aria-hidden className="w-4 h-4 shrink-0 ms-auto text-zinc-500" />
      </Link>

      {/* aria-live is off on purpose: an automatic rotation announcing itself
          every seven seconds would talk over whatever the visitor is reading.
          The section link above reaches the same products without it. */}
      <div className="grid grid-cols-2 gap-2 min-w-0">
        {current.map((p) => (
          <Slot key={p.id} p={p} />
        ))}
        {/* A short last set keeps its empty slots, so the tile's height never
            changes between pages and nothing below it jumps. */}
        {Array.from({ length: PER_PAGE - current.length }, (_, i) => (
          <span key={`spacer-${i}`} aria-hidden className="block" />
        ))}
      </div>

      {pages.length > 1 && (
        <div className="flex items-center justify-center gap-1 mt-1.5">
          {pages.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setPage(i)}
              aria-label={`${title} ${i + 1}`}
              aria-current={i === page ? 'true' : undefined}
              // A real target with a small dot drawn inside it. The negative
              // margin keeps the row visually tight without shrinking what a
              // finger has to hit — for a reduced-motion visitor these are the
              // only way to the rest of the products.
              className="flex items-center justify-center h-11 min-w-[28px] -my-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              <span
                aria-hidden
                className={`h-1.5 rounded-full transition-all motion-reduce:transition-none ${
                  i === page ? 'w-4 bg-gold' : 'w-1.5 bg-zinc-700'
                }`}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SpotlightTiles({
  selectionPool,
  superDeals,
}: {
  /** Products the page already has — re-ranked here, never re-fetched. */
  selectionPool: ApiProduct[];
  superDeals: ApiProduct[];
}) {
  const { t } = useLanguage();

  // Read the history once per mount. Re-reading on every render would make the
  // tile reorder itself while the shopper is looking at it.
  const [history] = useState(() => (typeof window === 'undefined' ? [] : readRecentlyViewed()));
  /**
   * DEDUPE BEFORE RANKING. `selectionPool` is best-sellers concatenated with
   * the newest arrivals, from two different endpoints, and a product that is
   * both appears twice. At four slots a tile that is showing eight products
   * can put the same one in two of them, side by side, which reads as a bug
   * rather than as a recommendation.
   */
  const selection = useMemo(() => {
    const seen = new Set<string>();
    const unique = selectionPool.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
    return rankByAffinity(unique, history).slice(0, PER_PAGE * MAX_PAGES);
  }, [selectionPool, history]);
  const deals = useMemo(() => superDeals.slice(0, PER_PAGE * MAX_PAGES), [superDeals]);

  if (selection.length === 0 && deals.length === 0) return null;

  return (
    <section data-home-section="spotlight" className="mb-10 sm:mb-12">
      {/* TWO COLUMNS AT EVERY WIDTH — the owner's «في سطر واحد». When only one
          tile has products the surviving tile spans both columns rather than
          sitting half-width beside an empty gap, which is the one case the old
          `grid-cols-1` hid by accident. */}
      <div className="grid grid-cols-2 gap-2 sm:gap-3">
        {selection.length > 0 && (
          <div className={deals.length === 0 ? 'col-span-2 min-w-0' : 'min-w-0'}>
            <Tile
              title={t('homeSelection')}
              icon={<Sparkles aria-hidden className="w-3.5 h-3.5 shrink-0 text-gold" />}
              accent="bg-gold"
              products={selection}
              to="/products"
            />
          </div>
        )}
        {deals.length > 0 && (
          <div className={selection.length === 0 ? 'col-span-2 min-w-0' : 'min-w-0'}>
            <Tile
              title={t('homeSuperDeals')}
              icon={<Flame aria-hidden className="w-3.5 h-3.5 shrink-0 text-rose-400" />}
              accent="bg-rose-500"
              products={deals}
              to="/products?type=featured"
            />
          </div>
        )}
      </div>
    </section>
  );
}
