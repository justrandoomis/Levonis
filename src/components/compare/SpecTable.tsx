import React, { useMemo, useState } from 'react';
import { Check, SlidersHorizontal } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import {
  rowDiffers,
  rowScoring,
  specGroups,
  columnName,
  tri,
  type CompareLang,
  type CompareGroup,
  type CompareProductCard,
  type CompareResult,
  type CompareRow,
  type CompareValue,
} from '../../lib/compare';
import { compareStrings, type CompareStrings } from './strings';
import { productTone } from './tones';
import { useIsWide } from './useIsWide';

/**
 * THE TABLE — AND THE PHONE DECISION, WHICH IS THE HARD PART OF THIS PAGE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LAYOUT DECISION, AND WHY.
 *
 * Two to four spec columns in RTL at 360px is where a comparison page goes
 * wrong, and there were two ways to survive it:
 *
 *   A. A STICKY FIRST COLUMN with the value area scrolled horizontally.
 *   B. A PER-ROW CARD at narrow widths: the spec name as a heading, then one
 *      line per product underneath it.
 *
 * THIS PAGE TAKES B, below 640px, and a real `<table>` at and above it.
 *
 * Against A, in this app specifically. A horizontally scrolled value area means
 * that at four products the reader can never see the comparison — the thing the
 * page exists for — without a gesture, on every single row, and half the answer
 * is always off-screen. That is «متشابكة وخربطة» with a scrollbar attached. It
 * is also the single most dangerous widget this codebase has: an Arabic-first
 * app driving `scrollLeft` across three incompatible engine conventions (see
 * the header of `src/lib/useRail.ts`, which documents all three and the
 * synthetic-probe bug that made every RTL write clamp to zero). Putting forty
 * spec rows behind that, rather than one verdict rail, is a lot of risk bought
 * for a layout that is worse anyway.
 *
 * For B, plainly. Nothing scrolls sideways, so nothing can be hidden by a
 * missed gesture. Every product's answer to the row the reader is looking at is
 * on screen at once, which is exactly the question a phone reader is asking.
 * It reads identically at two products and at four — no reflow cliff, no cells
 * narrower than the words «غير مذكور» — and it stays legible when a value is
 * long, because a value gets a whole line instead of a 78px cell. The cost is
 * vertical length, which is what the «الفروقات فقط» filter below is for.
 *
 * ONE STRUCTURE IS MOUNTED, NOT TWO. The usual `hidden sm:block` trick would
 * put every specification in the DOM twice and read the whole comparison twice
 * to a screen reader, so the branch is a media query in JavaScript
 * (`useIsWide`) and only one tree exists at a time.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OTHER TWO RULES THIS FILE ENFORCES.
 *
 * A MISSING VALUE IS «غير مذكور», NEVER A DASH. A dash reads as a zero, and a
 * zero reads as a machine that lacks the feature — when what is actually
 * missing is a line in the shop's own admin form. The server already excludes
 * such a row from `winners`, from the score and from every chart axis; this is
 * the half of that decision the reader can see, and the row carries a «غير
 * محتسب» chip so the exclusion is visible rather than merely true.
 *
 * ONLY WINNERS ARE MARKED. `losers` exists on the row and is used in the
 * verdict band's «وهذه ما لا تتفوق عليه», but no cell is painted as a defeat:
 * an `Optional` against a `Yes` is in neither list, and a cell coloured as a
 * loss while the verdict says otherwise is the contradiction that makes a
 * reader stop believing the page.
 */

function ScoringChip({ row, s }: { row: CompareRow; s: CompareStrings }) {
  const kind = rowScoring(row);
  if (kind === 'winner') return null;
  const label =
    kind === 'unscored' ? s.notScored : kind === 'tie' ? s.tieRow : s.informational;
  return (
    <span className="ms-2 whitespace-nowrap rounded-full bg-[var(--color-surface-selected)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--color-text-muted)]">
      {label}
    </span>
  );
}

function Value({
  value,
  won,
  toneColor,
  s,
}: {
  value: CompareValue;
  won: boolean;
  toneColor: string;
  s: CompareStrings;
}) {
  if (value.missing) {
    return (
      <span className="text-[12px] text-[var(--color-text-muted)]">{s.missing}</span>
    );
  }
  return (
    <span className="inline-flex items-baseline gap-1.5">
      {won ? (
        <>
          <Check
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 self-center"
            style={{ color: toneColor }}
          />
          <span className="sr-only">{s.best}</span>
        </>
      ) : null}
      <span
        className={`text-[12px] leading-5 ${won ? 'font-bold text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]'}`}
        style={won ? { color: toneColor } : undefined}
      >
        {value.text}
      </span>
    </span>
  );
}

function RowLabel({ row, s }: { row: CompareRow; s: CompareStrings }) {
  const { lang } = useLanguage();
  return (
    <>
      <span className="text-[12px] leading-5 text-[var(--color-text-secondary)]">
        {tri(row.label, lang as CompareLang)}
      </span>
      <ScoringChip row={row} s={s} />
    </>
  );
}

/** ≥ 640px: a real table, with the product names sticking to the top of the
 *  scroller while the reader works down a long group. */
function WideGroup({
  group,
  products,
  rows,
  s,
}: {
  group: CompareGroup;
  products: CompareProductCard[];
  rows: CompareRow[];
  s: CompareStrings;
}) {
  const { lang } = useLanguage();
  const l = lang as CompareLang;
  return (
    <table className="w-full table-fixed border-collapse">
      <caption className="sr-only">{tri(group.label, l)}</caption>
      <colgroup>
        <col style={{ inlineSize: '30%' }} />
        {products.map((p) => (
          <col key={p.id} />
        ))}
      </colgroup>
      <thead>
        <tr>
          <th scope="col" className="sticky top-0 z-[1] bg-[var(--color-canvas)] p-0 text-start" />
          {products.map((product, i) => (
            <th
              key={product.id}
              scope="col"
              className="sticky top-0 z-[1] bg-[var(--color-canvas)] px-2 py-2 text-start align-bottom"
            >
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: productTone(i).color }}
                />
                <span className="truncate text-[11px] font-bold text-[var(--color-text-primary)]">
                  {columnName(product, l)}
                </span>
              </span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.field_id} className="border-t border-[color-mix(in_oklab,var(--color-border-subtle)_60%,transparent)]">
            <th scope="row" className="py-2 pe-3 text-start align-top font-normal">
              <RowLabel row={row} s={s} />
            </th>
            {products.map((product, i) => (
              <td key={product.id} className="break-words px-2 py-2 align-top">
                <Value
                  value={row.values[i]}
                  won={row.winners.includes(i)}
                  toneColor={productTone(i).color}
                  s={s}
                />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** < 640px: one card per spec row. See the file header for why. */
function NarrowGroup({
  products,
  rows,
  s,
}: {
  products: CompareProductCard[];
  rows: CompareRow[];
  s: CompareStrings;
}) {
  const { lang } = useLanguage();
  const l = lang as CompareLang;
  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <li key={row.field_id} className="lv-surface p-3">
          <p className="flex flex-wrap items-center">
            <RowLabel row={row} s={s} />
          </p>
          <ul className="mt-2 space-y-1.5">
            {products.map((product, i) => {
              const tone = productTone(i);
              const won = row.winners.includes(i);
              return (
                <li key={product.id} className="flex items-start justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: tone.color }}
                    />
                    <span className="truncate text-[11px] text-[var(--color-text-muted)]">
                      {columnName(product, l)}
                    </span>
                  </span>
                  <span className="min-w-0 text-end">
                    <Value value={row.values[i]} won={won} toneColor={tone.color} s={s} />
                  </span>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export default function SpecTable({
  products,
  result,
}: {
  products: CompareProductCard[];
  result: CompareResult;
}) {
  const { lang } = useLanguage();
  const s = compareStrings(lang);
  const l = lang as CompareLang;
  const wide = useIsWide();
  /**
   * «الفروقات فقط».
   *
   * On two machines of one family most rows are equal, and the differences are
   * the entire reason the page exists — so this is the control the reader
   * reaches for, and it defaults OFF only because a page that opens
   * pre-filtered hides the fact that there is anything to unfold.
   *
   * It is deliberately NOT in the URL. A shared link is a shared COMPARISON;
   * carrying one reader's filter into another reader's first screen would hide
   * rows they never chose to hide.
   */
  const [diffOnly, setDiffOnly] = useState(false);

  const groups = useMemo(() => specGroups(result), [result]);

  const visible = useMemo(
    () =>
      groups
        .map((group) => ({
          group,
          rows: diffOnly ? group.rows.filter(rowDiffers) : group.rows,
          hidden: diffOnly ? group.rows.filter((row) => !rowDiffers(row)).length : 0,
        }))
        .filter((entry) => entry.rows.length > 0),
    [groups, diffOnly]
  );

  const hiddenTotal = useMemo(
    () => (diffOnly ? groups.reduce((n, g) => n + g.rows.filter((r) => !rowDiffers(r)).length, 0) : 0),
    [groups, diffOnly]
  );

  return (
    <section aria-labelledby="lv-compare-specs" className="lv-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="lv-compare-specs" className="text-sm font-bold text-[var(--color-text-primary)]">
          {s.specsTitle}
        </h2>
        <button
          type="button"
          onClick={() => setDiffOnly((v) => !v)}
          aria-pressed={diffOnly}
          className="lv-choice inline-flex min-h-[44px] items-center gap-2 px-3 text-[12px] font-bold"
        >
          <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
          {s.diffOnly}
          <span className="lv-choice-mark">
            <Check aria-hidden="true" className="h-3 w-3" />
          </span>
        </button>
      </div>

      {diffOnly && hiddenTotal > 0 ? (
        <p aria-live="polite" className="mt-2 text-[11px] text-[var(--color-text-muted)]">
          {s.identicalRows(hiddenTotal)}
        </p>
      ) : null}

      {visible.length === 0 ? (
        <p className="mt-3 text-[12px] leading-5 text-[var(--color-text-muted)]">{s.diffOnlyNone}</p>
      ) : (
        <div className="mt-3 space-y-6">
          {visible.map(({ group, rows }) => (
            <div key={group.id}>
              <div className="flex flex-wrap items-baseline gap-2">
                <h3 className="text-[13px] font-bold text-[var(--color-text-primary)]">
                  {tri(group.label, l)}
                </h3>
                {/* A group that does not apply to everyone is LABELLED, never
                    silently full of blanks: the blanks there are the template's
                    doing, not a machine's shortcoming. */}
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                    group.shared
                      ? 'bg-[var(--color-surface-selected)] text-[var(--color-text-muted)]'
                      : 'bg-[color-mix(in_oklab,var(--color-warning)_16%,var(--color-surface))] text-[var(--color-warning)]'
                  }`}
                >
                  {group.shared ? s.sharedGroup : s.narrowGroup}
                </span>
              </div>
              {group.shared ? null : (
                <p className="mt-1 text-[11px] leading-5 text-[var(--color-text-muted)]">
                  {s.narrowGroupNote}
                </p>
              )}

              <div className="mt-2">
                {wide ? (
                  <WideGroup group={group} products={products} rows={rows} s={s} />
                ) : (
                  <NarrowGroup products={products} rows={rows} s={s} />
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
