import React, { useMemo } from 'react';
import { useLanguage } from '../../LanguageContext';
import {
  rowIndex,
  columnName,
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
 * THE BAR IS NOT THE VALUE, AND THE NUMBER BESIDE IT IS.
 *
 * «في المحاور الحاسمة بالإضافة إلى الشريط اجعل هنالك رقما يكتب — مثلا أقصى
 *  معدل تدفق — يكتب مع الشريط أمامه رقم وليس فقط شريط.»
 *
 * 0..1 is a RATIO against the best answer on that axis (the server's
 * `normaliseAxis`), not a percentage of anything a customer can buy, so the
 * ratio is still never printed: «78%» would be a number that answers no
 * question. What is printed is the machine's OWN typed figure with its unit —
 * «32 mm³/s», «300 °C» — read from the row the server already sent for that
 * field (`rowIndex`). The bar keeps doing the comparing at a glance; the
 * figure answers "how much, exactly" without a scroll to the table.
 *
 * Reading the value from the row rather than re-deriving it is the whole
 * safety of this: the chart and the table below it cannot come to disagree,
 * because they are printing the same string.
 *
 * A machine with no answer on an axis shows «—», not a zero. The server sends
 * `missing: true` for "nobody wrote this down", and a 0 there would read as a
 * measured zero — which on «أقصى معدل تدفق» is a very different claim.
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
  // field_id → the row the figure lives in. Built once per comparison.
  const rows = useMemo(() => rowIndex(result), [result]);

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
                <span className="text-[var(--color-text-secondary)]">{columnName(product, l)}</span>
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
                    const cell = rows.get(axis.field_id)?.values[p];
                    const figure = cell && !cell.missing && cell.text ? cell.text : '—';
                    return (
                      <div
                        key={product.id}
                        className="flex items-center gap-2"
                        role="img"
                        aria-label={`${columnName(product, l)} — ${tri(axis.label, l)}: ${figure}`}
                      >
                        <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--color-surface-selected)]">
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
                        {/*
                          ALWAYS LTR, and a fixed minimum width. The figure is
                          digits plus a Latin unit («32 mm³/s»); left to the
                          page's RTL the browser would reorder the unit around
                          the number. `tabular-nums` and the floor keep the
                          column of figures aligned down the axis instead of
                          jittering with each value's width.
                        */}
                        <span
                          dir="ltr"
                          className="shrink-0 text-end text-[11px] tabular-nums text-[var(--color-text-secondary)]"
                          style={{ minInlineSize: '4.5rem' }}
                        >
                          {figure}
                        </span>
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
