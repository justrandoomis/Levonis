import React, { useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { useLanguage } from '../../LanguageContext';
import {
  LENS_FIELDS,
  barRatio,
  columnName,
  identicalRowCount,
  litres,
  priceDeltas,
  priceRow,
  rowDiffers,
  rowHasBars,
  rowHint,
  specGroups,
  tri,
  type CompareLang,
  type CompareLensId,
  type CompareProductCard,
  type CompareResult,
  type CompareRow,
  type CompareValue,
} from '../../lib/compare';
import { Switch } from '../ui/Switch';
import { specValue } from '../finder/strings';
import { compareStrings, type CompareStrings } from './strings';
import { lensStrings, type LensStrings } from './lensStrings';
import RowBar from './RowBars';
import { columnsTemplate } from './grid';
import { useIsWide } from './useIsWide';

/**
 * THE TABLE (CATALOG_DISCOVERY §10.1, §10.3; mockup 8).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE GRID, ALIGNED UNDER THE STICKY PRODUCT COLUMNS.
 *
 * Every row is the label line, then one cell per product on a single grid row
 * whose columns are the sticky header's columns (./grid.ts) — so a value sits
 * under its product's photograph at any scroll depth, and every product's
 * answer to the row being read is on screen at once. Nothing scrolls
 * sideways: at four columns the cells narrow and wrap rather than hiding half
 * the answer behind a gesture (and no RTL `scrollLeft` is ever driven — see
 * the header of src/lib/useRail.ts for why that matters here). On a wide
 * screen the label becomes the first column.
 *
 * It is an ARIA table (`role="table"` → `row` → `rowheader` / `cell`, with a
 * column-header row naming the products) rather than a `<table>` element, so
 * the phone's stacked label line and the desktop's label column are one DOM,
 * read once by a screen reader. Only one tree is mounted.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE TABLE SAYS, AND WHO DECIDED IT.
 *
 * Winners, directions, ties and "not scored" are the SERVER's
 * (`compareSpecs.ts`); the page adds no rule. A winner is written in 800-weight
 * ink with a filled check disc and the word «الأفضل» for screen readers — the
 * value never wears a colour. Numbers get a bar (./RowBars.tsx), a build volume
 * its litres, the price its difference from the cheapest. A MISSING VALUE IS
 * «غير مذكور», NEVER A DASH, and never a loss. Only winners are marked.
 *
 * «الفروقات فقط» hides rows whose every value is equal (a present-versus-
 * missing row IS a difference — `rowDiffers`), says how many it hid, and
 * offers «إظهار الكل». It starts ON for three or more columns; the page owns
 * the switch so the choice survives a column being added.
 *
 * A chosen «أفضل لـ» lens tints the rows it rests on (a gold edge at the
 * inline start and a faint wash), so the reader can check the verdict.
 */

function WinnerMark({ s }: { s: CompareStrings }) {
  return (
    <>
      <span aria-hidden="true" className="grid size-[15px] shrink-0 place-items-center rounded-full bg-success text-canvas">
        <Check className="size-2.5" strokeWidth={3.4} />
      </span>
      <span className="sr-only">{s.best}: </span>
    </>
  );
}

/** Characters past which a text answer is clamped to three lines. */
const LONG_TEXT = 48;

const isNumeric = (row: CompareRow) => row.parse === 'number' || row.parse === 'dimensions' || row.parse === 'range';

function ValueText({ row, value, lang }: { row: CompareRow; value: CompareValue; lang: CompareLang }) {
  if (isNumeric(row)) return <bdi dir="ltr">{value.text}</bdi>;
  const shown = row.parse === 'boolean' || row.parse === 'text' ? specValue(value.text, lang) : value.text;
  // A Latin value (an English option, a model name) is an LTR island inside Arabic.
  return /[A-Za-z]/.test(shown) && !/[؀-ۿ]/.test(shown) ? <bdi dir="ltr">{shown}</bdi> : <>{shown}</>;
}

function Cell({
  row,
  i,
  s,
  ls,
  lang,
  bars,
  delta,
  clamp,
}: {
  row: CompareRow;
  i: number;
  s: CompareStrings;
  ls: LensStrings;
  lang: CompareLang;
  bars: boolean;
  delta?: { cheapest: boolean; moreIqd: number | null };
  /** Long text is held to three lines until the row is opened («المزيد»). */
  clamp: boolean;
}) {
  const value = row.values[i];
  const won = row.winners.includes(i) || !!delta?.cheapest;
  const l = litres(row, i);
  return (
    <div role="cell" className="min-w-0">
      {value.missing ? (
        <span className="text-[12.5px] leading-5 text-text-muted">{s.missing}</span>
      ) : (
        <span className={`inline-flex max-w-full items-center gap-1.5 text-[13px] leading-5 [overflow-wrap:anywhere] ${won ? 'font-extrabold text-text-primary' : 'font-medium text-text-secondary'}`}>
          {won ? <WinnerMark s={s} /> : null}
          {/* `dir="auto"`: a clamped English answer ends in its own ellipsis
              («…Vision»), not one hung on the Arabic side. */}
          <span dir="auto" className={`min-w-0 tabular-nums rtl:text-right ${clamp ? 'line-clamp-3' : ''}`}>
            <ValueText row={row} value={value} lang={lang} />
          </span>
        </span>
      )}
      {delta ? (
        delta.cheapest ? (
          <span className="mt-0.5 block text-[11px] font-bold text-success">{ls.cheapest}</span>
        ) : delta.moreIqd !== null && delta.moreIqd > 0 ? (
          <bdi dir="ltr" className="mt-0.5 block text-[11px] tabular-nums text-text-muted">
            +{delta.moreIqd.toLocaleString('en-US')}
          </bdi>
        ) : null
      ) : null}
      {l !== null ? (
        <span className="mt-0.5 block text-[11px] tabular-nums text-text-muted">{ls.litres(l.toFixed(1))}</span>
      ) : null}
      {bars ? <RowBar ratio={barRatio(row, i)} winner={row.winners.includes(i)} /> : null}
    </div>
  );
}

function hintText(row: CompareRow, ls: LensStrings): string {
  const h = rowHint(row);
  return h === 'higher' ? ls.hintHigher : h === 'lower' ? ls.hintLower : h === 'informational' ? ls.hintInfo : ls.hintUnscored;
}

function Row({
  row,
  products,
  wide,
  s,
  ls,
  lang,
  tinted,
  isPrice = false,
}: {
  row: CompareRow;
  products: CompareProductCard[];
  wide: boolean;
  s: CompareStrings;
  ls: LensStrings;
  lang: CompareLang;
  tinted: boolean;
  isPrice?: boolean;
}) {
  const bars = !isPrice && rowHasBars(row);
  const deltas = isPrice ? priceDeltas(row) : null;
  // A long free-text answer («Auto Flow Dynamics Calibration via …») would make
  // one row a screen tall; it is held to three lines, and «المزيد» opens the row.
  const long = !isNumeric(row) && row.values.some((v) => !v.missing && v.text.length > LONG_TEXT);
  const [open, setOpen] = useState(false);
  return (
    <div
      role="row"
      data-field={row.field_id}
      data-lens-row={tinted || undefined}
      className={`grid gap-x-3 gap-y-2 border-b border-border-subtle py-3.5 ps-3 pe-1 transition-colors ${
        tinted ? 'border-s-[3px] border-s-gold bg-[color-mix(in_oklab,var(--color-gold)_7%,transparent)]' : 'border-s-[3px] border-s-transparent'
      }`}
      style={{ gridTemplateColumns: columnsTemplate(products.length, wide) }}
    >
      <div role="rowheader" className={`${wide ? 'flex flex-col gap-0.5' : 'col-span-full flex items-baseline justify-between gap-3'} min-w-0`}>
        <span className="min-w-0 text-[13px] font-bold leading-5 text-text-primary">
          {tri(row.label, lang)}
        </span>
        <span className="shrink-0 text-[11px] font-medium text-text-muted">{isPrice ? ls.priceHint : hintText(row, ls)}</span>
      </div>
      {products.map((p, i) => (
        <Cell key={p.id} row={row} i={i} s={s} ls={ls} lang={lang} bars={bars} delta={deltas ? deltas[i] : undefined} clamp={long && !open} />
      ))}
      {long ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="col-span-full -mb-1 justify-self-start rounded-full px-1 text-[12px] font-bold text-text-secondary underline-offset-4 hover:text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus min-h-8"
        >
          {open ? ls.less : ls.more}
        </button>
      ) : null}
    </div>
  );
}

export default function SpecTable({
  products,
  result,
  diffOnly,
  onDiffOnly,
  lens = null,
}: {
  products: CompareProductCard[];
  result: CompareResult;
  diffOnly: boolean;
  onDiffOnly: (next: boolean) => void;
  lens?: CompareLensId | null;
}) {
  const { lang } = useLanguage();
  const s = compareStrings(lang);
  const ls = lensStrings(lang);
  const l = lang as CompareLang;
  const wide = useIsWide();

  const groups = useMemo(() => specGroups(result), [result]);
  const price = useMemo(() => priceRow(result), [result]);
  const hiddenTotal = useMemo(() => identicalRowCount(result), [result]);
  const lensFields = lens ? LENS_FIELDS[lens] : [];

  const visible = useMemo(
    () =>
      groups
        .map((group) => ({ group, rows: diffOnly ? group.rows.filter(rowDiffers) : group.rows }))
        .filter((entry) => entry.rows.length > 0),
    [groups, diffOnly]
  );

  return (
    <section aria-labelledby="lv-compare-specs" data-compare-specs className="lv-section">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 id="lv-compare-specs" className="text-[20px] font-extrabold tracking-[-0.01em] text-text-primary">
          {s.specsTitle}
        </h2>
        <div data-diff-toggle className="min-w-[180px]">
          <Switch checked={diffOnly} onChange={onDiffOnly} label={ls.onlyDiffs} />
        </div>
      </div>

      <div role="table" aria-labelledby="lv-compare-specs" className="mt-2">
        {/* The column headers the cells are read against; the sticky photo
            header above is the visual version of this row. */}
        <div role="row" className="sr-only">
          <span role="columnheader">{s.specsTitle}</span>
          {products.map((p) => (
            <span key={p.id} role="columnheader">
              {columnName(p, l)}
            </span>
          ))}
        </div>

        {price ? (
          <div role="rowgroup">
            <Row row={price} products={products} wide={wide} s={s} ls={ls} lang={l} tinted={lensFields.includes('price_iqd')} isPrice />
          </div>
        ) : null}

        {visible.length === 0 ? (
          <p className="mt-3 text-[12.5px] leading-5 text-text-muted">{s.diffOnlyNone}</p>
        ) : (
          visible.map(({ group, rows }) => (
            <div key={group.id} role="rowgroup" className="mt-5">
              <div role="row" className="flex flex-wrap items-baseline gap-2 pb-1 ps-3">
                <h3 role="columnheader" className="text-[13px] font-extrabold text-gold">
                  {tri(group.label, l)}
                </h3>
                {group.shared ? null : (
                  <span className="rounded-full bg-[color-mix(in_oklab,var(--color-warning)_14%,var(--color-surface))] px-2 py-0.5 text-[10.5px] font-bold text-warning">
                    {s.narrowGroup}
                  </span>
                )}
              </div>
              {group.shared ? null : <p className="ps-3 text-[11.5px] leading-5 text-text-muted">{s.narrowGroupNote}</p>}
              {rows.map((row) => (
                <Row key={row.field_id} row={row} products={products} wide={wide} s={s} ls={ls} lang={l} tinted={lensFields.includes(row.field_id)} />
              ))}
            </div>
          ))
        )}
      </div>

      {diffOnly && hiddenTotal > 0 ? (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl bg-surface-selected px-4 py-2.5">
          <p aria-live="polite" className="text-[12.5px] font-semibold leading-5 text-text-secondary">
            {ls.hiddenRows(hiddenTotal, products.length)}
          </p>
          <button
            type="button"
            onClick={() => onDiffOnly(false)}
            className="min-h-11 shrink-0 rounded-full px-3 text-[13px] font-extrabold text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {ls.showAll}
          </button>
        </div>
      ) : null}
    </section>
  );
}
