/**
 * MERCHANT TEXT: what may be stored, and how it is shown.
 *
 * A layout's words are the merchant's own, in up to three languages they write
 * by hand — nothing here ever translates (docs/DECISIONS.md row 11). Text is
 * TEXT: the renderer puts it in React text nodes, so `<script>` typed into a
 * headline is shown as the characters `<script>` and never parsed. What this
 * module removes is the invisible machinery that text can smuggle: control
 * characters, the bidi embedding/override/isolate controls that can make a
 * line display in an order other than the one it was written in, stray byte
 * order marks and unpaired surrogates. The visible characters are kept
 * exactly as typed — including ZWJ/ZWNJ, which Kurdish and emoji need, and the
 * LRM/RLM/ALM marks a bilingual line legitimately uses.
 */

/** Merchant-authored text in the interface's three languages. */
export interface LocalizedText {
  ar: string;
  en: string;
  ckb: string;
}

export const EMPTY_TEXT: LocalizedText = Object.freeze({ ar: '', en: '', ckb: '' }) as LocalizedText;

/**
 * C0 (except TAB/LF, handled before this runs), DEL and C1 controls; the bidi
 * embeddings/overrides (LRE…RLO) and isolates (LRI…PDI); the BOM; and the
 * interlinear annotation marks. Nothing a merchant can see is in this class.
 */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\uFEFF\uFFF9-\uFFFB]/g;
/** A high surrogate with no low one after it, or a low one with no high before. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export interface CleanText {
  value: string;
  /** True when the text was cut to `max`. */
  truncated: boolean;
}

/**
 * One field of merchant text, cleaned and capped. Anything that is not a
 * string is the empty string. `max` counts UTF-16 units, the unit the caps
 * are written in; a cut never leaves half of a surrogate pair behind.
 */
export function cleanText(raw: unknown, max: number, multiline = false): CleanText {
  if (typeof raw !== 'string' || !raw) return { value: '', truncated: false };
  let s = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(/\t/g, ' ')
    .replace(INVISIBLE, '')
    .replace(LONE_SURROGATE, '');
  s = multiline ? s.replace(/[ \u00A0]+\n/g, '\n').replace(/\n{3,}/g, '\n\n') : s.replace(/\s*\n\s*/g, ' ');
  s = s.trim();
  if (s.length <= max) return { value: s, truncated: false };
  let cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return { value: cut.trimEnd(), truncated: true };
}

/** True when the author left every language blank. */
export function isBlank(t: LocalizedText | null | undefined): boolean {
  return !t || (!t.ar && !t.en && !t.ckb);
}

/**
 * The string to show in `lang`, falling back to the first language the author
 * actually wrote — never to a machine translation and never to a placeholder.
 * Sorani falls back to Arabic first (the policy's stand-in), then English.
 */
export function pickText(t: LocalizedText | null | undefined, lang: string): string {
  if (!t) return '';
  const order = lang === 'en' ? [t.en, t.ar, t.ckb] : lang === 'ckb' ? [t.ckb, t.ar, t.en] : [t.ar, t.en, t.ckb];
  for (const v of order) if (v) return v;
  return '';
}
