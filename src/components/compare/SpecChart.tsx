import React from 'react';
import { useLanguage } from '../../LanguageContext';
import {
  tri,
  type CompareLang,
  type CompareProductCard,
  type CompareResult,
} from '../../lib/compare';
import { compareStrings } from './strings';
import { productTone } from './tones';

/**
 * ONE CHART, OVER THE AXES THE SERVER ALREADY CHOSE.
 *
 * WHAT IS DRAWN. `result.chart` is the whole input: up to eight axes the server
 * selected (decisive, scorable, every product answered) and a 0..1 value per
 * product per axis, already normalised so that FURTHER IS ALWAYS BETTER — the
 * lower-wins axes were inverted there. Nothing is re-read, re-scaled or
 * re-ordered here. A chart that normalises its own numbers is a chart that can
 * disagree with the verdict printed above it.
 *
 * WHY A GROUPED BAR AND NOT A RADAR. A radar is the prettier answer and the
 * wrong one for this shop. Eight spokes carrying Arabic labels — «أقصى درجة
 * حرارة المنصة», «أدنى ارتفاع طبقة» — at 360px either collide, truncate to
 * nothing, or get replaced by numbers and a legend, which is a lookup table
 * wearing a chart's clothes. That is precisely «متشابكة وخربطة ولا يستطيع
 * المستخدم فهم». A grouped bar gives each axis a full-width line for its label
 * and puts the bars underneath it, so the label is never the thing that breaks;
 * it reads identically at two products and at four; and the comparison the
 * reader actually makes — this machine against that one, on THIS axis — is two
 * bars that start at the same edge.
 *
 * WHY NO CHART LIBRARY. Drawn as bars, this is a `div` with an inline size. A
 * charting library would add a lazy vendor chunk to buy an SVG renderer, a
 * tooltip layer and an axis engine none of which is used here — and recharts in
 * particular has no notion of writing direction, so every bar would have to be
 * fought back to the right edge in RTL. `inline-size` and logical properties do
 * that for free and correctly, in both directions.
 *
 * THE BAR IS NOT THE VALUE. 0..1 is a RATIO against the best answer on that
 * axis (the server's `normaliseAxis`), not a percentage of anything a customer
 * can buy, so no number is printed on the bar. The real, typed figure for every
 * axis is a row in the table below, which is where a reader who wants the
 * number goes.
 */
export default function SpecChart({
  products,
  result,
}: {
  products: CompareProductCard[];
  result: CompareResult;
}) {
  const { lang } = useLanguage();
  const s = compareStrings(lang);
  const l = lang as CompareLang;
  const { axes, series } = result.chart;

  return (
    <section aria-labelledby="lv-compare-chart" className="lv-section">
      <h2 id="lv-compare-chart" className="text-sm font-bold text-[var(--color-text-primary)]">
        {s.chartTitle}
      </h2>

      {axes.length === 0 ? (
        /* Silence here would read as a chart that failed to load, so the empty
           case says which of the two honest reasons it is. */
        <p className="mt-2 text-[12px] leading-5 text-[var(--color-text-muted)]">{s.chartNone}</p>
      ) : (
        <>
          <p className="mt-1 text-[11px] leading-5 text-[var(--color-text-muted)]">{s.chartLegend}</p>

          {/* The legend names the colours once. Every bar below is also
              labelled for a screen reader, so colour is never the only carrier
              of which machine a bar belongs to. */}
          <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
            {products.map((product, i) => (
              <li key={product.id} className="flex items-center gap-1.5 text-[11px]">
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: productTone(i).color }}
                />
                <span className="text-[var(--color-text-secondary)]">{tri(product.name, l)}</span>
              </li>
            ))}
          </ul>

          <ul className="mt-4 space-y-4">
            {axes.map((axis, a) => (
              <li key={axis.field_id}>
                <p className="text-[12px] font-bold text-[var(--color-text-primary)]">
                  {tri(axis.label, l)}
                </p>
                <div className="mt-1.5 space-y-1">
                  {products.map((product, p) => {
                    const value = series[p]?.[a] ?? 0;
                    const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);
                    const tone = productTone(p);
                    return (
                      <div
                        key={product.id}
                        className="h-2 overflow-hidden rounded-full bg-[var(--color-surface-selected)]"
                        role="img"
                        aria-label={`${tri(product.name, l)} — ${tri(axis.label, l)}: ${percent}%`}
                      >
                        <div
                          className="h-full rounded-full transition-[width] duration-300 ease-out"
                          style={{
                            // `inline-size`, not `width`: in RTL the bar has to
                            // grow from the right edge, and that is what a
                            // logical property means. A `width` here would grow
                            // every bar out of the left edge in Arabic.
                            inlineSize: `${Math.max(percent, 2)}%`,
                            backgroundColor: tone.color,
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
