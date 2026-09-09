import React from 'react';

/**
 * THE ONE SALE / SAVING BADGE (docs/BUNDLES_MYSTERY.md §13.2).
 *
 * It was the SALE pill inside `src/components/home/ProductCard.tsx`, with a
 * second, differently styled copy in `src/pages/Products.tsx`. Promoted here so
 * a product card, a bundle card and a bundle page all wear the same badge —
 * two styles for one meaning is how a storefront starts looking assembled from
 * parts.
 *
 * ONE REAL CHANGE ON THE WAY UP: `tracking-wide` is now CONDITIONAL ON LATIN
 * CONTENT. Letter-spacing is harmless on "SALE" and wrong the moment the same
 * badge reads «وفّر ٢٤٪» — Arabic letters join, and spacing them apart breaks
 * the joins and renders the word as disconnected glyphs. §13.3 states the rule
 * ("no letter-spacing on Arabic text"); this is where the badge obeys it,
 * rather than every call site remembering to.
 */

const LATIN_ONLY = /^[\x20-\x7E]*$/;

export default function OfferBadge({
  children,
  tone = 'sale',
  className = '',
}: {
  children: React.ReactNode;
  /** `sale` is the rose pill on a card image; `saving` is the quieter inline
   *  pill that sits beside a struck-through total. */
  tone?: 'sale' | 'saving' | 'member';
  className?: string;
}) {
  const text = typeof children === 'string' ? children : '';
  const latin = LATIN_ONLY.test(text);

  const tones: Record<string, string> = {
    sale: 'bg-rose-600/95 text-white',
    saving: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30',
    member: 'bg-gold/15 text-gold border border-gold/30',
  };

  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-bold ${
        latin ? 'tracking-wide' : ''
      } ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
