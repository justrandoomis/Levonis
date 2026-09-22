import React from 'react';
import { Trophy, Check, Minus, Tag } from 'lucide-react';
import SafeImage from '../ui/SafeImage';
import { useLanguage } from '../../LanguageContext';
import { useRail } from '../../lib/useRail';
import {
  leaders,
  columnName,
  tri,
  type CompareLang,
  type CompareProductCard,
  type CompareResult,
  type Trilingual,
} from '../../lib/compare';
import { compareStrings } from './strings';
import { productTone } from './tones';

/**
 * THE ANSWER, BEFORE THE DATA.
 *
 * «قارن» is asked by someone holding a question — «أي وحدة أشتري؟» — and the
 * ordinary failure of a comparison page is to answer it with forty rows and
 * leave the reader to do the arithmetic. So the first screen is a verdict: each
 * machine, its share of the decisive axes, what it WINS on, and — the owner
 * asked for this in so many words — «وهذه ما لا تتفوق عليه». Someone who reads
 * only this band has their answer; everything below it is the working.
 *
 * WHY LOSSES ARE PRINTED AT ALL. A page that lists only strengths reads as
 * marketing for whichever machine is listed first, and a reader who senses that
 * stops trusting the wins too. Naming the weaknesses of BOTH is what makes the
 * strengths credible. The list comes from `verdict.losses`, which the server
 * builds deliberately narrower than "everyone who did not win" — an `Optional`
 * against a `Yes` is a near miss and is in neither list.
 *
 * WHY A TIE IS SAID OUT LOUD. With every score at zero the server is telling us
 * nobody separated on a scored axis. Rendering four empty bars there would look
 * like a page that failed to load; `tiedNote` says the true thing instead.
 *
 * THE RAIL IS FOR THREE AND FOUR COLUMNS ON A PHONE. Two cards fit side by side
 * at 360px; four do not, and shrinking them to fit turns each into a name and a
 * number with the win/loss lists cut off — which is the one part of this band
 * that carries the answer. So at narrow widths the cards keep their readable
 * width and the band scrolls, through `useRail`, which owns the three
 * incompatible RTL `scrollLeft` conventions this app has already been bitten
 * by. At `sm` the same nodes become a grid and the hook detaches itself,
 * because the element is no longer a scroller.
 */

/** How many win/loss labels fit before the card becomes a list. */
const MAX_LABELS = 4;

function LabelList({
  ids,
  labels,
  lang,
  tone,
  icon,
  title,
  empty,
  more,
}: {
  ids: string[];
  labels: Map<string, Trilingual>;
  lang: CompareLang;
  tone: string;
  icon: React.ReactNode;
  title: string;
  empty: string;
  more: (n: number) => string;
}) {
  const named = ids.map((id) => tri(labels.get(id), lang)).filter(Boolean);
  const shown = named.slice(0, MAX_LABELS);
  const rest = named.length - shown.length;

  return (
    <div className="mt-3">
      <div className="flex items-center gap-1.5 text-[11px] font-bold" style={{ color: tone }}>
        {icon}
        <span>{title}</span>
      </div>
      {shown.length === 0 ? (
        <p className="mt-1 text-[12px] leading-5 text-[var(--color-text-muted)]">{empty}</p>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {shown.map((label) => (
            <li key={label} className="text-[12px] leading-5 text-[var(--color-text-secondary)]">
              {label}
            </li>
          ))}
          {rest > 0 ? (
            <li className="text-[12px] leading-5 text-[var(--color-text-muted)]">{more(rest)}</li>
          ) : null}
        </ul>
      )}
    </div>
  );
}

export default function VerdictBand({
  products,
  result,
  labels,
}: {
  products: CompareProductCard[];
  result: CompareResult;
  labels: Map<string, Trilingual>;
}) {
  const { lang } = useLanguage();
  const s = compareStrings(lang);
  const l = lang as CompareLang;
  // Snap off: the cards are of one width and a free scroll reads better than a
  // rail that fights a half-swipe. Drag on, so a mouse can move it at all.
  const rail = useRail({ items: '[data-verdict-card]', snap: false });

  const ahead = leaders(result.verdict);
  const everyoneLevel = ahead.length === 0 || ahead.length === products.length;

  return (
    <section aria-labelledby="lv-compare-verdict" className="lv-section pt-0">
      <h2 id="lv-compare-verdict" className="text-sm font-bold text-[var(--color-text-primary)]">
        {s.verdictTitle}
      </h2>

      {everyoneLevel ? (
        <p className="mt-2 text-[12px] leading-5 text-[var(--color-text-muted)]">{s.tiedNote}</p>
      ) : null}

      <div
        ref={rail.ref}
        className="
          mt-3 flex gap-3 overflow-x-auto pb-1 -mx-4 px-4
          [scrollbar-width:none] [&::-webkit-scrollbar]:hidden
          sm:mx-0 sm:px-0 sm:overflow-visible sm:grid sm:gap-3
          sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(15rem,1fr))]
        "
      >
        {products.map((product, i) => {
          const tone = productTone(i);
          const score = Math.round((result.verdict.scores[i] ?? 0) * 100);
          const isAhead = !everyoneLevel && ahead.includes(i);

          return (
            <article
              key={product.id}
              data-verdict-card
              className="lv-surface-raised shrink-0 w-[15rem] max-w-[82vw] p-3 sm:w-auto sm:max-w-none"
              style={{ borderColor: tone.edge }}
            >
              <div className="flex items-start gap-3">
                <SafeImage
                  src={product.image}
                  alt=""
                  aspect="square"
                  fit="contain"
                  className="w-14 shrink-0 rounded-[var(--radius-sm)] overflow-hidden"
                  bgClassName="bg-[var(--color-surface)]"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: tone.color }}
                    />
                    <h3 className="truncate text-[13px] font-bold text-[var(--color-text-primary)]">
                      {columnName(product, l)}
                    </h3>
                  </div>
                  {product.graded ? (
                    <p className="mt-1 flex items-center gap-1 text-[11px] text-[var(--color-warning)]">
                      <Tag aria-hidden="true" className="h-3 w-3" />
                      {s.graded}
                    </p>
                  ) : null}
                  {isAhead ? (
                    <p
                      className="mt-1 flex items-center gap-1 text-[11px] font-bold"
                      style={{ color: tone.color }}
                    >
                      <Trophy aria-hidden="true" className="h-3 w-3" />
                      {s.leads}
                    </p>
                  ) : null}
                </div>
              </div>

              {/* The score is a share of the decisive axes, so it is printed as
                  a bar AND as a number: the bar answers "who is ahead" at a
                  glance, the number stops a 51/49 reading as a rout. */}
              <div className="mt-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[11px] text-[var(--color-text-muted)]">{s.score}</span>
                  <span
                    dir="ltr"
                    className="text-[13px] font-bold tabular-nums"
                    style={{ color: tone.color }}
                  >
                    {score}%
                  </span>
                </div>
                <div
                  className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-selected)]"
                  role="img"
                  aria-label={`${s.score} ${score}%`}
                >
                  <div
                    className="h-full rounded-full transition-[width] duration-300 ease-out"
                    style={{ inlineSize: `${score}%`, backgroundColor: tone.color }}
                  />
                </div>
              </div>

              <LabelList
                ids={result.verdict.wins[i] ?? []}
                labels={labels}
                lang={l}
                tone={tone.color}
                icon={<Check aria-hidden="true" className="h-3.5 w-3.5" />}
                title={s.winsIn}
                empty={s.winsNone}
                more={s.more}
              />
              <LabelList
                ids={result.verdict.losses[i] ?? []}
                labels={labels}
                lang={l}
                tone="var(--color-text-muted)"
                icon={<Minus aria-hidden="true" className="h-3.5 w-3.5" />}
                title={s.losesIn}
                empty={s.losesNone}
                more={s.more}
              />
            </article>
          );
        })}
      </div>
    </section>
  );
}
