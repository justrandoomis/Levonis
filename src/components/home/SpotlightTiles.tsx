import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, Flame } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { formatIqd, type ApiProduct } from '../../lib/api';
import SafeImage from '../ui/SafeImage';
import { productPrimaryImage } from '../../lib/productImage';
import { rankByAffinity, readRecentlyViewed } from '../../lib/recentlyViewed';

/**
 * THE TWO TILES THAT CHANGE WHILE YOU LOOK AT THEM — «سلكشن» and «سوبر ديلز».
 *
 * The owner asked for exactly this shape: two panels side by side, each
 * showing two products, the pair swapping every few seconds — "Selection"
 * chosen for the shopper, "Super Deals" chosen by the shop to move stock.
 *
 * SELECTION IS PERSONAL WITHOUT ANYBODY BEING TRACKED. This shop records no
 * browsing telemetry at all, and adding a views table on the busiest read path
 * for one tile would be a large change and a privacy question the owner has
 * not been asked. So the ranking happens HERE, over products the page has
 * already fetched, against a short list of recently opened products that lives
 * in this browser's own storage and is never sent anywhere. See
 * src/lib/recentlyViewed.ts. A first-time visitor sees the shop's own
 * rotation, not an empty tile.
 *
 * SUPER DEALS IS THE OWNER'S OWN LIST — `products.is_featured`, the flag the
 * product form already writes and `/api/products?type=featured` already
 * lists. «يختارها الأدمن لكي تعرض وتباع بسرعة».
 *
 * THE ROTATION, AND THE THREE THINGS THAT MAKE IT BEARABLE.
 *
 *   IT STOPS WHEN WATCHED. Hover, touch or keyboard focus anywhere in a tile
 *   pauses that tile. A pair that swaps out from under a thumb reaching for it
 *   is worse than no rotation at all.
 *
 *   IT DOES NOT MOVE THE PAGE. Both slots are fixed-aspect, so the tile's
 *   height never changes as pairs swap and nothing below it jumps.
 *
 *   IT RESPECTS prefers-reduced-motion by not rotating. Not by rotating
 *   without a transition — by holding the first pair still. Involuntary
 *   content change is exactly what that preference is about, and the dots
 *   below remain as a manual control so nothing becomes unreachable.
 */

/** Seven seconds: long enough to read two products, short enough to feel live. */
const ROTATE_MS = 7000;

function PricePlate({ p }: { p: ApiProduct }) {
  const display = p.display_price_iqd ?? p.price_iqd;
  const regular = p.display_regular_iqd ?? p.price_iqd;
  return (
    <span className="flex items-baseline gap-1 min-w-0">
      <span className="text-[12px] font-bold text-white tabular-nums truncate">{formatIqd(display)}</span>
      {display < regular && (
        <span className="text-[10px] text-zinc-500 line-through tabular-nums truncate">{formatIqd(regular)}</span>
      )}
    </span>
  );
}

function Slot({ p }: { p: ApiProduct }) {
  return (
    <Link
      to={`/product/${p.slug || p.id}`}
      data-spotlight-item={p.id}
      className="group flex flex-col gap-1.5 min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus rounded-lg"
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
  badge,
  icon,
  accent,
  products,
  to,
}: {
  title: string;
  badge: string;
  icon: React.ReactNode;
  accent: string;
  products: ApiProduct[];
  to: string;
}) {
  const [page, setPage] = useState(0);
  const [paused, setPaused] = useState(false);
  const reduced = useRef(false);

  // The pairs are fixed up front, so a re-render cannot reshuffle what the
  // shopper is mid-way through reading.
  const pairs = useMemo(() => {
    const out: ApiProduct[][] = [];
    for (let i = 0; i < products.length; i += 2) out.push(products.slice(i, i + 2));
    return out.filter((pair) => pair.length > 0);
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
    if (paused || reduced.current || pairs.length < 2) return;
    const timer = window.setInterval(() => setPage((n) => (n + 1) % pairs.length), ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [paused, pairs.length]);

  if (pairs.length === 0) return null;
  const current = pairs[Math.min(page, pairs.length - 1)];

  return (
    <div
      className="flex flex-col rounded-2xl border border-border-subtle bg-surface p-3 min-w-0"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
    >
      <div className="flex items-center justify-between gap-2 mb-2.5 min-w-0">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold text-white ${accent}`}>
            {icon}
            {badge}
          </span>
          <span className="text-[13px] font-bold text-white truncate">{title}</span>
        </span>
        <Link to={to} className="shrink-0 text-[11px] text-zinc-500 hover:text-white transition-colors px-1">
          ›
        </Link>
      </div>

      {/* aria-live is off on purpose: an automatic rotation announcing itself
          every seven seconds would talk over whatever the visitor is reading.
          The "see all" link above reaches the same products without it. */}
      <div className="grid grid-cols-2 gap-2 min-w-0">
        {current.map((p) => (
          <Slot key={p.id} p={p} />
        ))}
        {/* An odd last pair keeps the second slot's space so the tile's height
            never changes between pages. */}
        {current.length === 1 && <span aria-hidden className="block" />}
      </div>

      {pairs.length > 1 && (
        <div className="flex items-center justify-center gap-1.5 mt-2.5">
          {pairs.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setPage(i)}
              aria-label={`${title} ${i + 1}`}
              aria-current={i === page ? 'true' : undefined}
              className={`h-1.5 rounded-full transition-all ${
                i === page ? 'w-4 bg-gold' : 'w-1.5 bg-zinc-700 hover:bg-zinc-600'
              }`}
            />
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
  const selection = useMemo(
    () => rankByAffinity(selectionPool, history).slice(0, 8),
    [selectionPool, history]
  );

  if (selection.length === 0 && superDeals.length === 0) return null;

  return (
    <section data-home-section="spotlight" className="mb-10 sm:mb-12">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 sm:gap-3">
        <Tile
          title={t('homeSelection')}
          badge={t('homeSelection')}
          icon={<Sparkles aria-hidden className="w-3 h-3" />}
          accent="bg-olive border border-gold/30"
          products={selection}
          to="/products"
        />
        <Tile
          title={t('homeSuperDeals')}
          badge={t('homeSuperDeals')}
          icon={<Flame aria-hidden className="w-3 h-3" />}
          accent="bg-rose-500"
          products={superDeals.slice(0, 8)}
          to="/products?type=featured"
        />
      </div>
    </section>
  );
}
