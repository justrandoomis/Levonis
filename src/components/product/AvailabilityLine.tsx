import React from 'react';
import { useLanguage } from '../../LanguageContext';
import { cardAvailability, type CardProduct } from '../../lib/productCard';

/**
 * THE AVAILABILITY LINE of the compact product card (CATALOG_DISCOVERY §4.1).
 *
 * It replaces `DirectStockEdge` inside compact cards: that was an 8 px strip on
 * the card's bottom edge «that nobody can read on a phone». This is a line of
 * text — a dot AND a word, never colour alone:
 *
 *   ● متوفر الآن        5 قطع    success, filled dot with a halo
 *   ● متوفر الآن        بقي 2    the quantity turns warning at the threshold
 *   ○ طلب مسبق                   warning, hollow dot
 *   ● غير متوفر                  muted, grey dot
 *
 * It is plain text inside the card's link, so a screen reader hears it as part
 * of the link («…، متوفر الآن، 5 قطع»). The row is always drawn — empty when
 * the card was not told the product's sale types — so every card in a grid
 * keeps one height.
 */
export default function AvailabilityLine({ product, className = '' }: { product: CardProduct; className?: string }) {
  const { loc } = useLanguage();
  const a = cardAvailability(product);

  let word = '';
  let tone = '';
  let dot: React.ReactNode = null;
  if (a.state === 'available') {
    word = loc('متوفر الآن', 'In stock', 'بەردەستە');
    tone = 'text-success';
    dot = <i aria-hidden="true" className="block size-1.5 shrink-0 rounded-full bg-success shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-success)_16%,transparent)]" />;
  } else if (a.state === 'preorder') {
    word = loc('طلب مسبق', 'Pre-order', 'پێش-داواکاری');
    tone = 'text-warning';
    dot = <i aria-hidden="true" className="block size-[7px] shrink-0 rounded-full border-[1.5px] border-warning" />;
  } else if (a.state === 'unavailable') {
    word = loc('غير متوفر', 'Unavailable', 'بەردەست نییە');
    tone = 'text-text-muted';
    dot = <i aria-hidden="true" className="block size-1.5 shrink-0 rounded-full bg-text-muted/60" />;
  }

  let qty = '';
  if (a.state === 'available' && a.qty !== null) {
    const n = a.qty;
    // The same digits the price beside it is written in (formatIqd uses the
    // runtime's locale), so one card never mixes ٥ and 5.
    const num = (x: number) => x.toLocaleString();
    // OWNER: Sorani to be written by hand (the two quantity phrases).
    qty = a.low
      ? loc(`بقي ${num(n)}`, `Only ${n} left`)
      : n > 99
        ? `${num(99)}+`
        : // Arabic counts 3–10 take the plural, 11 and up the singular.
          loc(`${num(n)} ${n <= 10 ? 'قطع' : 'قطعة'}`, `${n} units`);
  }

  return (
    <div
      data-availability={a.state}
      className={`flex min-h-[15px] items-center justify-between gap-1.5 text-[11px] font-bold leading-[15px] ${className}`}
    >
      {word ? (
        <span className={`inline-flex shrink-0 items-center gap-[5px] whitespace-nowrap ${tone}`}>
          {dot}
          <span>{word}</span>
        </span>
      ) : (
        <span />
      )}
      {qty ? (
        <span className={`min-w-0 truncate whitespace-nowrap text-[10.5px] tabular-nums ${a.low ? 'font-bold text-warning' : 'font-semibold text-text-muted'}`}>
          <span className="sr-only">، </span>
          {/* «99+» is an LTR island, or RTL carries the plus to the far side. */}
          {a.qty !== null && a.qty > 99 && !a.low ? <bdi dir="ltr">{qty}</bdi> : qty}
        </span>
      ) : null}
    </div>
  );
}
