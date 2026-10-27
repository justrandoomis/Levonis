/**
 * TEXT: cleaning, direction, wrapping, money and the claims a model may not make.
 *
 * Arabic is never reversed or split by hand here (spec §8, §43). Wrapping
 * breaks only at spaces and explicit newlines and hands WHOLE lines to the
 * renderer, which shapes each line with the browser's own text engine
 * (HarfBuzz in Chromium) under the line's base direction. That is the path the
 * engine test proved pixel-identical to the DOM (docs/CREATIVE_STUDIO.md §2).
 * The layout and the renderer use the SAME line breaks — the renderer draws
 * `lines`, it never re-wraps — so the overflow the quality check measures is
 * the overflow the export shows.
 */

// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\uFEFF\uFFF9-\uFFFB]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * One field of text, cleaned and capped: control characters, bidi
 * embeddings/overrides/isolates (which can make a line display in an order
 * other than the one it was typed in), BOMs and lone surrogates are removed.
 * ZWJ/ZWNJ and the LRM/RLM/ALM marks a bilingual line legitimately uses are
 * kept. Same rules as `packages/storeLayout/src/text.ts` (copied: a pure
 * package imports nothing outside itself).
 */
export function cleanText(raw: unknown, max: number, multiline = false): { value: string; truncated: boolean } {
  if (typeof raw !== 'string' || !raw) return { value: '', truncated: false };
  let s = raw.replace(/\r\n?/g, '\n').replace(/[\u2028\u2029]/g, '\n').replace(/\t/g, ' ').replace(INVISIBLE, '').replace(LONE_SURROGATE, '');
  s = multiline ? s.replace(/[ \u00A0]+\n/g, '\n').replace(/\n{3,}/g, '\n\n') : s.replace(/\s*\n\s*/g, ' ');
  s = s.replace(/[ \u00A0]{2,}/g, ' ').trim();
  if (s.length <= max) return { value: s, truncated: false };
  let cut = s.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return { value: cut.trimEnd(), truncated: true };
}

// ---------------------------------------------------------------------------
// Direction
// ---------------------------------------------------------------------------

const STRONG_RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const STRONG_LTR = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/;

/** The first strong character decides (Unicode P2/P3); text with none is `fallback`. */
export function detectDirection(text: string, fallback: 'rtl' | 'ltr'): 'rtl' | 'ltr' {
  for (const ch of text) {
    if (STRONG_RTL.test(ch)) return 'rtl';
    if (STRONG_LTR.test(ch)) return 'ltr';
  }
  return fallback;
}

export function resolveDirection(direction: 'rtl' | 'ltr' | 'auto', text: string, docDirection: 'rtl' | 'ltr'): 'rtl' | 'ltr' {
  return direction === 'auto' ? detectDirection(text, docDirection) : direction;
}

/** `start`/`end` to the physical alignment a canvas understands, for a line of this direction. */
export function physicalAlign(align: 'start' | 'center' | 'end', dir: 'rtl' | 'ltr'): 'left' | 'center' | 'right' {
  if (align === 'center') return 'center';
  return (align === 'start') === (dir === 'rtl') ? 'right' : 'left';
}

// ---------------------------------------------------------------------------
// Measuring and wrapping
// ---------------------------------------------------------------------------

/** Width in px of one line of text in one font. The browser implements it with canvas `measureText`; tests use a fake. */
export type TextMeasurer = (text: string, font: { family: string; weight: number; size: number }) => number;

export interface WrapResult {
  lines: string[];
  /** The widest line, px. */
  width: number;
  /** A single word wider than the box (it is kept whole on its own line, and reported). */
  overlongWord: boolean;
}

/**
 * Greedy wrapping at spaces, honouring explicit newlines. A word is never cut
 * (cutting Arabic mid-word breaks joining and meaning); a word wider than the
 * box stays whole and `overlongWord` says so.
 */
export function wrapText(text: string, maxWidth: number, font: { family: string; weight: number; size: number }, measure: TextMeasurer): WrapResult {
  const lines: string[] = [];
  let overlongWord = false;
  for (const para of text.split('\n')) {
    const words = para.split(' ').filter((w) => w.length > 0);
    if (!words.length) { lines.push(''); continue; }
    let line = words[0];
    if (measure(line, font) > maxWidth) overlongWord = true;
    for (let i = 1; i < words.length; i++) {
      const candidate = `${line} ${words[i]}`;
      if (measure(candidate, font) <= maxWidth) {
        line = candidate;
      } else {
        lines.push(line);
        line = words[i];
        if (measure(line, font) > maxWidth) overlongWord = true;
      }
    }
    lines.push(line);
  }
  const width = lines.reduce((m, l) => Math.max(m, measure(l, font)), 0);
  return { lines, width, overlongWord };
}

export interface FitResult {
  size: number;
  lines: string[];
  /** Height of the laid-out lines: lines × size × lineHeight. */
  height: number;
  width: number;
  fits: boolean;
  overlongWord: boolean;
}

/**
 * The largest size in [minSize, maxSize] whose wrapped text fits `maxLines`
 * and `maxHeight` (2px steps — the brand scale is coarse anyway). When even
 * `minSize` does not fit, the result is the `minSize` layout with
 * `fits: false`: the caller reports a conflict instead of shrinking past the
 * readable floor (spec §8: «لا تعالج المشكلة بتصغير غير مقروء»).
 */
export function fitText(
  text: string,
  font: { family: string; weight: number; lineHeight: number },
  box: { width: number; maxHeight: number; maxLines: number },
  sizes: { max: number; min: number },
  measure: TextMeasurer,
): FitResult {
  const min = Math.max(1, Math.min(sizes.min, sizes.max));
  let last: FitResult | null = null;
  for (let size = sizes.max; size >= min; size -= 2) {
    const r = wrapText(text, box.width, { family: font.family, weight: font.weight, size }, measure);
    const height = r.lines.length * size * font.lineHeight;
    last = { size, lines: r.lines, height, width: r.width, fits: r.lines.length <= box.maxLines && height <= box.maxHeight + 0.5 && !r.overlongWord, overlongWord: r.overlongWord };
    if (last.fits) return last;
  }
  if (!last || last.size !== min) {
    const r = wrapText(text, box.width, { family: font.family, weight: font.weight, size: min }, measure);
    const height = r.lines.length * min * font.lineHeight;
    last = { size: min, lines: r.lines, height, width: r.width, fits: r.lines.length <= box.maxLines && height <= box.maxHeight + 0.5 && !r.overlongWord, overlongWord: r.overlongWord };
  }
  return last;
}

/**
 * A deterministic stand-in measurer for tests and for the Worker (which has
 * no canvas): every character is `size × 0.55` wide, a space `size × 0.28`.
 * Never used for an export.
 */
export const approximateMeasurer: TextMeasurer = (text, font) => {
  let w = 0;
  for (const ch of text) w += ch === ' ' ? font.size * 0.28 : font.size * 0.55;
  return w;
};

// ---------------------------------------------------------------------------
// Money — the ONE formatter for a price drawn into an ad. Digits and the
// currency label are brand settings, never the viewer's browser locale
// (the codebase mixes conventions; an export must not depend on them).
// ---------------------------------------------------------------------------

export type DigitStyle = 'latn' | 'arab';
export type CurrencyLabel = 'د.ع' | 'IQD';

const ARABIC_INDIC = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];

export function toDigits(s: string, digits: DigitStyle): string {
  return digits === 'arab' ? s.replace(/[0-9]/g, (d) => ARABIC_INDIC[Number(d)]) : s;
}

/** 1250000 → "1,250,000" (Latin) or "١٬٢٥٠٬٠٠٠" (Arabic-Indic with the Arabic thousands separator). */
export function groupInteger(n: number, digits: DigitStyle): string {
  const s = String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const signed = n < 0 ? `-${s}` : s;
  return digits === 'arab' ? toDigits(signed, 'arab').replace(/,/g, '\u066C') : signed;
}

/**
 * An IQD amount as drawn in an ad. `د.ع` follows the number ("1,250,000 د.ع",
 * which the RTL line orders correctly); `IQD` precedes it in an LTR run.
 * Never called with null — an unpriced product has no number to format.
 */
export function formatIqd(amount: number, opts: { digits: DigitStyle; label: CurrencyLabel }): string {
  const n = groupInteger(amount, opts.digits);
  return opts.label === 'IQD' ? `IQD ${n}` : `${n} د.ع`;
}

// ---------------------------------------------------------------------------
// Words a model may not put in an ad on its own (spec §9, §10, §28; DECISIONS
// row 262). A price is a binding; a discount, "cheapest", "last piece", a
// customer rating or a warranty term needs evidence the app supplied.
// ---------------------------------------------------------------------------

const CURRENCY_WORDS = '(?:د\\.?\\s?ع|دينار|دنانير|IQD|USD|\\$|دولار|ألف|الف|آلاف|الاف|مليون|ملايين|دینار|هەزار|ملیۆن)';
const NUMBER = '[0-9٠-٩][0-9٠-٩,٬.،]*';
const PRICE_LIKE = new RegExp(`(?:${NUMBER}\\s*${CURRENCY_WORDS})|(?:${CURRENCY_WORDS}\\s*${NUMBER})`, 'i');
/** A grouped number of 4+ digits ("1,250,000", "١٬٢٥٠") reads as a price even without a currency word. */
const GROUPED_BIG_NUMBER = /[0-9٠-٩]{1,3}(?:[,٬][0-9٠-٩]{3})+/;

/** True when a piece of free text states a price — which only a price binding may do. */
export function containsPriceLike(text: string): boolean {
  return PRICE_LIKE.test(text) || GROUPED_BIG_NUMBER.test(text);
}

export type ClaimKind = 'discount' | 'cheapest' | 'last_piece' | 'rating' | 'free' | 'warranty_term' | 'limited_time' | 'superlative';

const CLAIMS: ReadonlyArray<readonly [ClaimKind, RegExp]> = [
  ['discount', /خصم|تخفيض|تنزيلات|عرض\s+خاص|٪|%|\boff\b|\bsale\b|discount|داشکاندن/i],
  ['cheapest', /الأرخص|الارخص|أرخص|ارخص|أقل\s+سعر|اقل\s+سعر|cheapest|lowest\s+price|هەرزانترین/i],
  ['last_piece', /آخر\s+قطعة|اخر\s+قطعة|آخر\s+قطع|كمية\s+محدودة|نفاد|last\s+(piece|one|units?)|limited\s+stock|دوایین/i],
  ['rating', /★|⭐|تقييم|نجوم|5\/5|review|rated|testimonial|هەڵسەنگاندن/i],
  ['free', /مجان|مجّان|ببلاش|\bfree\b|بەخۆڕایی/i],
  ['warranty_term', /ضمان\s*(?:لمدة\s*)?[0-9٠-٩]|[0-9٠-٩]+\s*(?:سنة|سنوات|شهر|أشهر|اشهر)\s*ضمان|warranty\s*(?:of\s*)?[0-9]|[0-9]+\s*(?:year|month)s?\s*warranty|گەرەنتی/i],
  ['limited_time', /لفترة\s+محدودة|لوقت\s+محدود|اليوم\s+فقط|ينتهي|limited\s+time|today\s+only|ends\s+(soon|today)/i],
  ['superlative', /الأفضل\s+في|الافضل\s+في|رقم\s*1|الأول\s+في\s+العراق|best\s+in|#1|number\s+one/i],
];

/** The claim kinds a text makes. The caller checks each against the evidence the request carried. */
export function claimsIn(text: string): ClaimKind[] {
  const out: ClaimKind[] = [];
  for (const [kind, re] of CLAIMS) if (re.test(text)) out.push(kind);
  return out;
}

/**
 * Which evidence makes which claim allowed. `free` needs an approved service
 * claim (free delivery is a policy, not a slogan); `discount`/`limited_time`
 * need a live offer; `warranty_term` needs an approved warranty claim.
 * `cheapest`, `last_piece`, `rating` and `superlative` are never allowed from
 * a model: no evidence the app has proves them.
 */
export const CLAIM_EVIDENCE: Readonly<Record<ClaimKind, ReadonlyArray<'offer' | 'service_claim' | 'never'>>> = Object.freeze({
  discount: ['offer'],
  limited_time: ['offer'],
  free: ['service_claim'],
  warranty_term: ['service_claim'],
  cheapest: ['never'],
  last_piece: ['never'],
  rating: ['never'],
  superlative: ['never'],
});

/** The claims in `text` that the supplied evidence does not cover. */
export function unsupportedClaims(text: string, evidence: { offer: boolean; serviceClaim: boolean }): ClaimKind[] {
  return claimsIn(text).filter((kind) => {
    const needs = CLAIM_EVIDENCE[kind];
    if (needs.includes('never')) return true;
    if (needs.includes('offer') && evidence.offer) return false;
    if (needs.includes('service_claim') && evidence.serviceClaim) return false;
    return true;
  });
}

/** Links and URLs a model might fabricate — refused in model text (spec §15: no invented links). */
export function containsUrl(text: string): boolean {
  return /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|iq|io|co|app|store|shop)\b)/i.test(text);
}
