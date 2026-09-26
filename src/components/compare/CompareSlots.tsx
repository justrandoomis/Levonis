import React from 'react';
import { Link } from 'react-router-dom';
import { X, Repeat, ChevronLeft, ChevronRight, Plus, ExternalLink } from 'lucide-react';
import SafeImage from '../ui/SafeImage';
import { useLanguage } from '../../LanguageContext';
import {
  MAX_COMPARE_IDS,
  columnName,
  type CompareLang,
  type CompareProductCard,
} from '../../lib/compare';
import { compareStrings } from './strings';
import { productTone } from './tones';
import { lensStrings } from './lensStrings';

/**
 * WHAT IS IN THE COMPARISON, AND THE THREE VERBS THAT CHANGE IT.
 *
 * REMOVE, REPLACE AND REORDER ALL GO THROUGH THE URL. Every one of these
 * buttons hands a new id list to the page, which writes it to `?ids=` as a
 * history PUSH. That is the whole contract: back undoes the last change, a
 * shared link reproduces exactly what its sender was looking at, and the column
 * order in the link is the column order on the screen (the server preserves the
 * request order deliberately — «the visitor put one machine on the right and
 * one on the left»). Holding any of this in component state instead would give
 * a back button that leaves the page and a link that shows the recipient a
 * different comparison.
 *
 * WHY REORDER IS TWO BUTTONS AND NOT A DRAG. At two to four items a drag
 * handle is a gesture to discover, a pointer-capture problem and — on a
 * horizontally arranged RTL list — a direction bug waiting to happen. «انقل
 * يمينًا / يسارًا» (catalog discovery S7) move a column one place toward the
 * start or the end, the same verbs as the sticky column header, and both are
 * reachable by keyboard, which a drag is not.
 *
 * THE ADD BUTTON DISAPPEARS AT FOUR rather than refusing at five. The server
 * caps the comparison by name (`COMPARE_TOO_MANY`), and a control that is
 * always there and always fails is worse than a control that is not there; the
 * cap is stated as a sentence instead.
 */
export default function CompareSlots({
  products,
  onRemove,
  onReplace,
  onMove,
  onAdd,
  addLabel,
}: {
  products: CompareProductCard[];
  onRemove: (index: number) => void;
  onReplace: (index: number) => void;
  /** −1 one place toward the start, +1 toward the end. */
  onMove: (index: number, delta: -1 | 1) => void;
  onAdd: () => void;
  /** «أضف طابعة رابعة» when the page knows the kind; the generic label otherwise. */
  addLabel?: string;
}) {
  const { lang, dir } = useLanguage();
  const s = compareStrings(lang);
  const ls = lensStrings(lang);
  const StartIcon = dir === 'rtl' ? ChevronRight : ChevronLeft;
  const EndIcon = dir === 'rtl' ? ChevronLeft : ChevronRight;
  const l = lang as CompareLang;
  const full = products.length >= MAX_COMPARE_IDS;

  return (
    <section aria-labelledby="lv-compare-slots" className="lv-section">
      <h2 id="lv-compare-slots" className="sr-only">
        {s.slotsTitle}
      </h2>

      <ul className="space-y-2">
        {products.map((product, i) => {
          const name = columnName(product, l);
          const tone = productTone(i);
          return (
            <li
              key={product.id}
              className="lv-surface flex flex-wrap items-center gap-x-2 gap-y-0 p-2"
              style={{ borderColor: tone.edge }}
            >
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: tone.color }}
              />
              <SafeImage
                src={product.image}
                alt=""
                aspect="square"
                fit="contain"
                className="w-10 shrink-0 overflow-hidden rounded-[var(--radius-sm)]"
                bgClassName="bg-[var(--color-surface-raised)]"
              />
              <Link
                to={`/product/${product.slug}`}
                dir="ltr"
                className="min-w-0 flex-1 basis-[55%] truncate text-start text-[12px] font-bold text-[var(--color-text-primary)] rtl:text-right"
                title={`${name} — ${s.openProduct}`}
              >
                {name.split(' / ')[0]}
                <ExternalLink aria-hidden="true" className="ms-1 inline h-3 w-3 align-[-1px] text-[var(--color-text-muted)]" />
              </Link>

              <span className="ms-auto flex shrink-0 items-center">
              <button
                type="button"
                onClick={() => onMove(i, -1)}
                disabled={i === 0}
                aria-label={ls.moveStart(name)}
                title={ls.moveStart(name)}
                className="lv-button lv-button-ghost min-h-[44px] min-w-[44px] px-0 disabled:opacity-30"
              >
                <StartIcon aria-hidden="true" className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => onMove(i, 1)}
                disabled={i === products.length - 1}
                aria-label={ls.moveEnd(name)}
                title={ls.moveEnd(name)}
                className="lv-button lv-button-ghost min-h-[44px] min-w-[44px] px-0 disabled:opacity-30"
              >
                <EndIcon aria-hidden="true" className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => onReplace(i)}
                aria-label={s.replaceProduct(name)}
                title={s.replaceProduct(name)}
                className="lv-button lv-button-ghost min-h-[44px] min-w-[44px] px-0"
              >
                <Repeat aria-hidden="true" className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => onRemove(i)}
                aria-label={s.removeProduct(name)}
                title={s.removeProduct(name)}
                className="lv-button lv-button-ghost min-h-[44px] min-w-[44px] px-0"
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </button>
              </span>
            </li>
          );
        })}
      </ul>

      {full ? (
        <p className="mt-2 text-[11px] text-[var(--color-text-muted)]">{s.full(MAX_COMPARE_IDS)}</p>
      ) : (
        <button type="button" onClick={onAdd} className="lv-button lv-button-secondary mt-2 w-full">
          <Plus aria-hidden="true" className="h-4 w-4" />
          {addLabel ?? s.addProduct}
        </button>
      )}
    </section>
  );
}
