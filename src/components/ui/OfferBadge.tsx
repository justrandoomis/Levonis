import React from 'react';
import { useLanguage } from '../../LanguageContext';
import { useMoney } from '../../CurrencyContext';

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
 *
 * CLAY (docs/DECISIONS.md row 209): information is flat. SALE is one solid
 * fill on the photograph; the inline saving and member pills are the opaque
 * `.lv-chip` tone mix (AA on any ground, both themes) instead of a
 * translucent tint plus a border — one cue, not two, and no glow.
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
    sale: 'bg-rose-600 text-snow',
    saving: 'lv-chip [--chip:var(--color-success)]',
    member: 'lv-chip [--chip:var(--color-gold)]',
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

/**
 * THE STRUCK PRICE OF A LIVE OFFER AND ITS «−N٪» (docs/ux/PRODUCT-DISCOUNT.md §8.3–§8.6, §8.9).
 *
 * It lives beside the badge it wears, so the two travel as one file (tests/motionLazy.test.ts: a
 * module of its own split the badge into a sub-1 KB chunk). One component for the product page, the cart, the checkout and the order: the price the offer
 * replaced, struck, with the server's percent beside it in the saving pill. Both numbers are the
 * server's (`offer_before_iqd`, `offer_saving_percent`) — the browser computes nothing, so a percent
 * here can never round differently from the one on the card.
 *
 * The amount is an LTR island with tabular digits; a screen reader hears «بدل 900,000» /
 * "instead of 900,000" / «لە جیاتی 900,000» and «تخفيض 17٪» / "17% off" / «17٪ داشکاندن».
 */
export type OfferLang = 'ar' | 'en' | 'ckb';

/** «−17٪» / "−17%" / «−17٪» — the badge text (D9: a whole percent, ≥ 1). */
export function offerPercentText(n: number, lang: OfferLang): string {
  return lang === 'en' ? `−${n}%` : `−${n}٪`;
}

/** The badge's screen-reader sentence. */
export function offerPercentSr(n: number, lang: OfferLang): string {
  return lang === 'en' ? `${n}% off` : lang === 'ckb' ? `${n}٪ داشکاندن` : `تخفيض ${n}٪`;
}

/** «بدل» before a struck amount (sr-only). */
export const INSTEAD_OF = { ar: 'بدل', en: 'instead of', ckb: 'لە جیاتی' } as const;

/** «سعر العرض» — the label of a price a live offer set (§8.3). */
export const SALE_PRICE = { ar: 'سعر العرض', en: 'Sale price', ckb: 'نرخی ئۆفەر' } as const;

export function OfferSaving({
  beforeIqd,
  percent,
  className = '',
}: {
  /** The struck amount (a unit price, or unit × qty on a line total). */
  beforeIqd: number;
  /** The server's percent; null or < 1 shows the strike alone. */
  percent: number | null | undefined;
  className?: string;
}) {
  const { money } = useMoney();
  const { lang } = useLanguage();
  const l: OfferLang = lang === 'en' || lang === 'ckb' ? lang : 'ar';
  if (!(beforeIqd > 0)) return null;
  const n = typeof percent === 'number' && percent >= 1 ? Math.round(percent) : null;
  return (
    <span data-offer-saving className={`inline-flex min-w-0 items-center gap-1.5 ${className}`}>
      <span className="sr-only">{INSTEAD_OF[l]} </span>
      <bdi dir="ltr" className="truncate text-[11px] text-text-muted line-through tabular-nums">
        {money(beforeIqd)}
      </bdi>
      {n !== null ? (
        <OfferBadge tone="saving">
          <bdi dir="ltr" aria-hidden>
            {offerPercentText(n, l)}
          </bdi>
          <span className="sr-only">{offerPercentSr(n, l)}</span>
        </OfferBadge>
      ) : null}
    </span>
  );
}
