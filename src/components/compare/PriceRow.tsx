import React from 'react';
import { BadgeDollarSign } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import {
  priceDeltas,
  tri,
  type CompareLang,
  type CompareProductCard,
  type CompareRow,
} from '../../lib/compare';
import { compareStrings } from './strings';
import { productTone } from './tones';

/**
 * PRICE ON ITS OWN, AS A TRADE-OFF — NEVER AS A WIN.
 *
 * THE ROW IS THE SERVER'S. `worker/lib/compareSpecs.ts` emits a synthetic price
 * group as `groups[0]` with `weight: 0` — shown, never scored — for exactly one
 * reason: so that every surface renders the same figure from the same numbers.
 * This component takes that row and prints `values[i].text`. It does not read
 * `product.price_iqd`, which is a different read of a different column and is
 * one deploy away from disagreeing with the row beside it. A page that
 * contradicts its own verdict about which machine is cheaper is a page nobody
 * checks twice.
 *
 * THE DIFFERENCE IS DERIVED, AND DERIVED FROM THIS ROW. The server deliberately
 * does not freeze the delta into a second field ("derivable, and deliberately
 * not frozen into a second field that could disagree with the row"), so
 * `priceDeltas` computes it from `values[i].num` — the very numbers `text` was
 * printed from.
 *
 * WHY IT IS NOT SCORED, SAID OUT LOUD. A verdict that let price in would always
 * hand the win to the cheapest machine, which is a verdict a customer does not
 * trust twice. The footnote states that plainly rather than leaving a reader to
 * notice that the «الأرخص» badge did not move the score.
 *
 * «يبدأ من» IS NOT DECORATION. `CompareProductCard.price_iqd` is the BASE price
 * by this shop's own rule — every model, colour and delivery route is an
 * increase on it — so the page has to say so. Without that line a reader
 * compares two machines on figures neither of them will actually cost.
 */
export default function PriceRow({
  products,
  row,
}: {
  products: CompareProductCard[];
  row: CompareRow;
}) {
  const { lang } = useLanguage();
  const s = compareStrings(lang);
  const l = lang as CompareLang;
  const deltas = priceDeltas(row);

  return (
    <section aria-labelledby="lv-compare-price" className="lv-section">
      <h2
        id="lv-compare-price"
        className="flex items-center gap-2 text-sm font-bold text-[var(--color-text-primary)]"
      >
        <BadgeDollarSign aria-hidden="true" className="h-4 w-4 text-[var(--color-text-muted)]" />
        {s.priceTitle}
      </h2>

      <ul className="mt-3 space-y-2">
        {products.map((product, i) => {
          const value = row.values[i];
          const delta = deltas[i];
          const tone = productTone(i);
          return (
            <li
              key={product.id}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-[var(--radius-md)] px-3 py-2"
              style={{ backgroundColor: tone.tint }}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: tone.color }}
                />
                <span className="truncate text-[12px] text-[var(--color-text-secondary)]">
                  {tri(product.name, l)}
                </span>
              </span>

              <span className="flex items-baseline gap-2">
                {value.missing ? (
                  <span className="text-[13px] text-[var(--color-text-muted)]">{s.missing}</span>
                ) : (
                  <span dir="ltr" className="text-[13px] font-bold tabular-nums text-[var(--color-text-primary)]">
                    {value.text}
                  </span>
                )}
                {delta.cheapest ? (
                  <span className="text-[11px] font-bold text-[var(--color-success)]">{s.cheapest}</span>
                ) : delta.moreIqd !== null && delta.morePercent !== null ? (
                  <span dir="ltr" className="text-[11px] tabular-nums text-[var(--color-text-muted)]">
                    {s.moreThanCheapest(delta.moreIqd.toLocaleString('en-US'), delta.morePercent)}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>

      <p className="mt-2 text-[11px] leading-5 text-[var(--color-text-muted)]">{s.priceFrom}</p>
      <p className="mt-1 text-[11px] leading-5 text-[var(--color-text-muted)]">{s.priceNotScored}</p>
    </section>
  );
}
