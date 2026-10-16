/**
 * TEXT THAT MAY MIX ARABIC OR SORANI WITH ENGLISH, IN READING ORDER
 * (docs/bambu-import/I18N-DESIGN.md §B; the rules: src/lib/bidi.ts).
 *
 * Every line gets `dir` from its SCRIPT — Arabic-script present: `rtl`, else
 * `ltr` — so an English fallback paragraph on the Arabic page reads left to
 * right and a translation that starts with a Latin name still reads right to
 * left. Inside an RTL line every Latin / number run is an LTR isolate
 * (`<bdi dir="ltr">`), so «389 × 389 × 458 mm», «220-240 V» and «X1 Series»
 * keep their order. An element carrying `dir` is a bidi isolate (the HTML
 * user-agent rule), so neighbouring lines never reorder each other. It
 * behaves the same in `ar` and `ckb`; English text is plain `ltr`.
 *
 * `multiline` splits on `\n` into one block line each (replacing
 * `whitespace-pre-line`), aligned to the line's own start.
 */
import { createElement, Fragment, type ReactNode } from 'react';
import { ltrRuns, scriptDir } from '../../lib/bidi';

export type BidiTag = 'span' | 'p' | 'div' | 'dd' | 'li' | 'bdi' | 'h5';

export interface BidiTextProps {
  text: string;
  as?: BidiTag;
  multiline?: boolean;
  className?: string;
  /** Classes of each line (multiline only). */
  lineClassName?: string;
}

/** One line's content: plain in an LTR line; in an RTL line every Latin / number run isolated LTR. */
export function bidiContent(line: string): ReactNode {
  if (scriptDir(line) === 'ltr') return line;
  const runs = ltrRuns(line);
  if (!runs.some((r) => r.ltr)) return line;
  return createElement(
    Fragment,
    null,
    ...runs.map((r, i) => (r.ltr ? createElement('bdi', { key: i, dir: 'ltr' }, r.text) : createElement(Fragment, { key: i }, r.text)))
  );
}

export default function BidiText({ text, as = 'span', multiline = false, className, lineClassName }: BidiTextProps) {
  const value = String(text ?? '');
  if (!multiline) return createElement(as, { dir: scriptDir(value), className }, bidiContent(value));
  const lines = value.split('\n');
  return createElement(
    as,
    { className },
    ...lines.map((line, i) =>
      line.trim() === ''
        ? createElement('span', { key: i, className: 'block h-[0.75em]', 'aria-hidden': true })
        : createElement('span', { key: i, dir: scriptDir(line), className: `block text-start${lineClassName ? ` ${lineClassName}` : ''}` }, bidiContent(line))
    )
  );
}
