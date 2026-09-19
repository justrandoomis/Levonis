import React, { useState } from 'react';
import { ChevronDown, Plug } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import { tri, type CompareLang, type CompareProductCard, type PowerAdvice } from '../../lib/compare';

/**
 * «كم تستهلك الطابعة من كهرباء في العراق على 220 فولت … بالأمبيرية وكم تحتاج من
 * الـ UPS الأونلاين وما فرقه عن الأوفلاين» — THE MAINS ANSWER, ON THE PAGE.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS COMPONENT EXISTS AT ALL.
 *
 * worker/lib/powerAdvice.ts computes the whole thing and GET /api/compare has
 * been shipping it under `power` — trilingual, ordered, aligned index-for-index
 * with `products` — and NOTHING RENDERED IT. A feature that reaches the wire
 * and stops there is a feature the customer does not have; the arithmetic that
 * decides whether a ten-hour print survives the evening cut was sitting in a
 * JSON key nobody read.
 *
 * ---------------------------------------------------------------------------
 * POINTS, NOT A TABLE. «لا يتم وضعها بشكل جداول وهوسه وخربطه».
 *
 * The server already shaped the answer as ordered sentences, each one complete
 * and each one carrying its own caveat. This component renders those sentences
 * in the order it was given them and adds NOTHING: no figure is pulled out of
 * the object and re-rendered on its own, because every bare number in that
 * object — the UPS size, the runtime minutes, the suggested breaker — is a
 * number whose caveat lives in the sentence beside it. An MCB rating shown
 * without «راجع كهربائي» is a fire-safety claim this shop is not making.
 *
 * ---------------------------------------------------------------------------
 * AND NOTHING IS DRAWN FOR A MACHINE NOBODY ENTERED WATTS FOR.
 *
 * `known: false` is the server saying our data entry is incomplete, not saying
 * something about the machine. A panel headed «الكهرباء» containing «غير مذكور»
 * reads as the first; leaving it out is the only honest rendering. The column
 * is skipped, and when no column knows anything the whole block is absent.
 *
 * The assumptions are behind a disclosure rather than on the page: they are the
 * ARITHMETIC — 220 V, the 0.6 UPS output factor, the battery pack, the 80%
 * headroom — and a reader who wants to check the working must be able to, while
 * a reader who wants the answer must not have to wade through five paragraphs
 * to find it.
 */
export default function PowerBlock({
  products,
  power,
}: {
  products: CompareProductCard[];
  power: PowerAdvice[] | undefined;
}) {
  const { lang, loc } = useLanguage();
  const l = lang as CompareLang;

  // ALIGNED INDEX-FOR-INDEX, and checked rather than trusted: a shorter array
  // would otherwise pair one machine's wattage with another machine's name,
  // which is the one way this block could tell an outright lie.
  const columns = (power ?? [])
    .map((advice, i) => ({ advice, product: products[i] }))
    .filter((c) => c.product && c.advice && c.advice.known && c.advice.points.length > 0);

  if (columns.length === 0) return null;

  return (
    <section className="lv-surface p-4" data-compare-power>
      <h2 className="mb-1 flex items-center gap-2 text-[14px] font-bold leading-5 text-[var(--color-text-primary)]">
        <Plug aria-hidden="true" className="h-4 w-4 text-[var(--color-text-muted)]" />
        {loc('الكهرباء والـ UPS', 'Power and UPS', 'کارەبا و UPS')}
      </h2>
      <p className="mb-4 text-[12px] leading-5 text-[var(--color-text-muted)]">
        {loc(
          'محسوبة على كهرباء العراق 220 فولت و50 هرتز.',
          'Computed for the Iraqi mains: 220 V, 50 Hz.',
          'ژمێردراوە بۆ کارەبای عێراق: 220 ڤۆڵت و 50 هێرتز.'
        )}
      </p>

      <div className="flex flex-col gap-5">
        {columns.map(({ advice, product }) => (
          <div key={product.id} className="min-w-0">
            {/* The machine's name is ALWAYS shown, including on a single
                column: this block also renders for one product, and a list of
                wattages with no name above it is a list the reader cannot
                attribute. The name is English in every language, like every
                other product name in the shop. */}
            <h3 dir="ltr" className="mb-2 text-[13px] font-semibold leading-5 text-[var(--color-text-primary)] text-start">
              {tri(product.name, l)}
            </h3>
            <ul className="flex flex-col gap-2">
              {advice.points.map((point) => (
                <li
                  key={point.id}
                  className="flex items-start gap-2 text-[13px] leading-6 text-[var(--color-text-secondary)]"
                >
                  <span
                    aria-hidden="true"
                    className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-text-muted)]"
                  />
                  {/* dir="auto" per point: a sentence that opens with «1 kVA»
                      and continues in Arabic is bidi-mixed, and letting the
                      browser resolve each one on its own is what keeps the
                      Latin runs from being reordered across the whole list. */}
                  <span dir="auto" className="min-w-0">
                    {tri(point.text, l)}
                  </span>
                </li>
              ))}
            </ul>
            {advice.assumptions.length > 0 ? <Assumptions advice={advice} lang={l} /> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

/** The working, on request. Closed by default, and never a modal: this is
 *  reference text a reader checks a figure against, not a decision. */
function Assumptions({ advice, lang }: { advice: PowerAdvice; lang: CompareLang }) {
  const { loc } = useLanguage();
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex min-h-[44px] items-center gap-1.5 text-[12px] font-semibold leading-5 text-[var(--color-text-muted)]"
      >
        <ChevronDown
          aria-hidden="true"
          className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
        />
        {loc('على أي أساس حُسبت؟', 'What is this based on?', 'لەسەر چی ژمێردراوە؟')}
      </button>
      {open ? (
        <ul className="mt-1 flex flex-col gap-2 border-s border-[var(--color-border)] ps-3">
          {advice.assumptions.map((a) => (
            <li key={a.id} dir="auto" className="text-[12px] leading-5 text-[var(--color-text-muted)]">
              {tri(a.text, lang)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
