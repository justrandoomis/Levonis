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
// customer rating, a warranty term, an arrival or a return to stock needs
// evidence the app supplied.
//
// These are PATTERN checks over a detection skeleton, not a proof: they catch
// the usual ways of writing each claim in Arabic, English and Sorani, and the
// system prompt remains the first defence.
// ---------------------------------------------------------------------------

/** Characters that draw nothing or only decorate a letter: default-ignorables, nonspacing marks (harakat) and tatweel. */
const DETECT_DROP = /[\p{Default_Ignorable_Code_Point}\p{Mn}\u0640]/gu;
const EASTERN_DIGIT = /[\u0660-\u0669\u06F0-\u06F9]/g;
const ALEF_FORMS = /[\u0622\u0623\u0625\u0671]/g;

/**
 * The text the guards below read — never what is stored or drawn. NFKC folds
 * fullwidth characters and Arabic presentation forms to plain ones and
 * composes the letters that carry a mark; zero-width and other
 * default-ignorable characters, tatweel and the remaining nonspacing marks
 * (harakat) are dropped, since they render with no width, so one between two
 * digits or two letters must not hide a price, a link or a claim word;
 * Arabic-Indic and Persian digits read as ASCII, and the hamza/madda forms of
 * alef as a plain alef.
 */
export function detectionText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(DETECT_DROP, '')
    .replace(EASTERN_DIGIT, (d) => {
      const c = d.charCodeAt(0);
      return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
    })
    .replace(ALEF_FORMS, '\u0627');
}

// The patterns below read the skeleton: ASCII digits, plain alef, no harakat.
const NUMBER_WORD = '(?:الف|الاف|مليون|ملايين|هەزار|ملیۆن)';
/** A currency named on its own is a price, with or without digits ("مليون دينار", "899K IQD", "IQD 900"). */
const CURRENCY_TOKEN = /(?<!\p{L})(?:دينار|دنانير|دینار|دیناری|dinars?|IQD|USD|دولار|dollars?)(?!\p{L})|\$|(?<!\p{L})د\s?\.\s?ع(?!\p{L})/iu;
/** The undotted dinar abbreviation counts only after a number or a number word ("250 دع"), never inside a word ("4 دعامات"). */
const NUMBER_DINAR = new RegExp(`[0-9][0-9,.٬٫،]*\\s*(?:[km]\\s*)?(?:${NUMBER_WORD}\\s*)?د\\s?ع(?!\\p{L})|(?<!\\p{L})${NUMBER_WORD}\\s*د\\s?ع(?!\\p{L})`, 'iu');
/** A number right after a price word ("السعر 250 ألف", "بسعر 900"). */
const PRICE_CUE = /(?<!\p{L})(?:و?ب?(?:ال)?سعر(?:ها|ه)?|ب?نرخ(?:ی|ەکەی)?|price[sd]?)\s*:?\s*(?:فقط\s*|only\s*)?[0-9]/iu;
/** A unit right after a number makes it a measurement, not a price ("20,000 مم/ث²", "10,000 ساعة", "350W"). */
const UNIT_AFTER = String.raw`\s*(?:مم|ملم|mm|سم|cm|متر|كم|km|م\/ث|ساع|ثاني|دقيق|hours?|hrs?|h(?![a-z])|واط|وات|w(?![a-z])|kw|غرام|جرام|غم|غ(?!\p{L})|g(?![a-z])|kg|كغ|كيلو|لون|الوان|colou?rs?|رەنگ|کاتژمێر|گرام|%|٪|×|x(?![a-z])|rpm|dpi|ppi|mah|°|درج|بكسل|px|نقط|طبق|layers?|مر[ةه]|cycles?|دور[ةه]|ms|mb|gb|tb)`;
/** A grouped number of 4+ digits ("1,250,000", "١٬٢٥٠", "1.250.000") reads as a price even without a currency word — unless a unit follows it. */
const GROUPED_BIG_NUMBER = new RegExp(String.raw`(?<![0-9.,٬])[0-9]{1,3}(?:[,٬][0-9]{3})+(?![0-9]|[,٬.٫][0-9]|${UNIT_AFTER})`, 'iu');
const DOT_GROUPED_NUMBER = new RegExp(String.raw`(?<![0-9.,٬])[0-9]{1,3}(?:\.[0-9]{3}){2,}(?![0-9]|[,٬.٫][0-9]|${UNIT_AFTER})`, 'iu');

/** True when a piece of free text states a price — which only a price binding may do. */
export function containsPriceLike(text: string): boolean {
  const s = detectionText(text);
  return CURRENCY_TOKEN.test(s) || NUMBER_DINAR.test(s) || PRICE_CUE.test(s) || GROUPED_BIG_NUMBER.test(s) || DOT_GROUPED_NUMBER.test(s);
}

export type ClaimKind =
  | 'discount' | 'cheapest' | 'last_piece' | 'rating' | 'free' | 'warranty_term' | 'limited_time' | 'superlative'
  | 'arrival' | 'back_in_stock' | 'availability';

const YEARS = '(?:سن[ةه]|سنتين|سنتان|سنوات|عام|عامين|عامان|اعوام|شهر|شهرين|اشهر|شهور)';
const WARRANTY = '(?:ضمان|كفال[ةه])';

const CLAIMS: ReadonlyArray<readonly [ClaimKind, RegExp]> = [
  // A percentage alone is a spec (infill 15%), not a discount: it needs a discount word next to it.
  ['discount', /خصم|تخفيض|تنزيلات|عرض\s+خاص|داشکاندن|(?<!\p{L})[وب]?(?:نص|نصف|ربع)\s+(?:ال)?سعر|\bsale\b|\bdiscount|[0-9]\s*[%٪]?\s*off\b|\bsave\s+(?:up\s+to\s+)?[0-9]+\s*[%٪]|\bhalf[-\s]price\b/iu],
  ['cheapest', /ارخص|اقل\s+(?:سعر|الاسعار)|افضل\s+(?:سعر|الاسعار)|\bcheapest\b|\blowest\s+prices?\b|\bbest\s+prices?\b|هەرزانترین/iu],
  ['last_piece', /اخر\s+(?:قطع|حب)|كمي[ةه]\s+محدود|نفا[دذ]\s+(?:ال)?كمي|حتى\s+نفا[دذ]|(?<!\p{L})[وب]?(?:باقي|بقي|تبقى|متبقي)\s+(?:فقط\s+)?(?:قطع|حب|[0-9]+(?!\s*(?:دقيق|دقائق|ساع|ثوان|ثاني|يوم|ايام|%|٪)))|\blast\s+(?:piece|one|units?)\b|\blimited\s+(?:stock|quantit)|\bonly\s+[0-9]+\s+left\b|\bwhile\s+(?:stocks?|supplies)\s+last|دوایین\s+(?:دانە|پارچە)/iu],
  ['rating', /★|⭐|تقييم|نجوم|\b5\s*\/\s*5\b|\b[0-9]\.[0-9]\s*\/\s*5\b|\breviews?\b(?!\s+(?:your|the|each|every|it|this|these))|\brated\b(?!\s+(?:power|voltage|current|capacity|output|input|speed|load|wattage|temperature))|\btestimonials?\b|هەڵسەنگاندن/iu],
  ['free', /مجان|ببلاش|(?<![-\w])(?<!feel\s)free\b(?!\s+from\b)|بەخۆڕایی/iu],
  ['warranty_term', new RegExp(
    `${WARRANTY}\\s*(?:لمد[ةه]\\s*|مدت(?:ه|ها)\\s*|ل)?(?:[0-9]|${YEARS}|مدى\\s+الحيا[ةه])`
    + `|${YEARS}\\s*(?:من\\s+)?(?:ال)?${WARRANTY}`
    + '|گەرەنتی'
    + '|\\bwarranty\\s*(?:of\\s*|for\\s*)?(?:[0-9]|one\\b|two\\b|three\\b|five\\b|ten\\b|lifetime\\b)'
    + '|\\b(?:[0-9]+|one|two|three|five|ten)[-\\s]?(?:years?|months?)\\s*(?:of\\s+)?warranty'
    + '|\\blifetime\\s+warranty',
    'iu',
  )],
  ['limited_time', /لفتر[ةه]\s+محدود|لوقت\s+محدود|اليوم\s+فقط|ينتهي|\blimited\s+time\b|\btoday\s+only\b|\bends\s+(?:soon|today)\b/iu],
  ['superlative', /الافضل\s+في|(?<!\p{L})(?:ال)?رقم\s*(?:1|واحد)(?![0-9])|الاول\s+في\s+العراق|\bbest\s+in\b|#\s?1(?![0-9])|\bnumber\s+one\b/iu],
  ['arrival', /وصل(?:ت|نا)?\s+(?:حديثا|للتو|مؤخرا|جديدا)|(?<!\p{L})وصول\s+جديد|\bnew\s+arrivals?\b|\bnewly\s+arrived\b|\bjust\s+(?:arrived|landed)\b|تازە\s+گەیشت/iu],
  ['back_in_stock', /(?:عاد|رجع)(?:ت)?\s+(?:الى\s+ال|لل|ل)توفر|متوفر[ةه]?\s+(?:من\s+جديد|مر[ةه]\s+اخرى)|توفر(?:ت)?\s+من\s+جديد|\bback\s+in\s+stock\b|\brestocked\b|دووبارە\s+بەردەست/iu],
  // Availability is drawn by the binding (spec §34-2: a pre-order is never "available now"); free text never states it.
  ['availability', /متوفر[ةه]?\s+(?:الان|حاليا|الحين|هسه|بالمخزن|في\s+المخزن)|متاح[ةه]?\s+(?:الان|حاليا)|(?<!\bback\s{1,3})\bin\s+stock\b|\bavailable\s+now\b|\bnow\s+available\b|ئێستا\s+بەردەست/iu],
];

/** The claim kinds a text makes. The caller checks each against the evidence the request carried. */
export function claimsIn(text: string): ClaimKind[] {
  const s = detectionText(text);
  const out: ClaimKind[] = [];
  for (const [kind, re] of CLAIMS) if (re.test(s)) out.push(kind);
  return out;
}

/**
 * Which evidence makes which claim allowed. `free` needs an approved service
 * claim (free delivery is a policy, not a slogan); `discount`/`limited_time`
 * need a live offer; `warranty_term` needs an approved warranty claim;
 * `arrival`/`back_in_stock` need the catalogue watch's record. `cheapest`,
 * `last_piece`, `rating` and `superlative` are never allowed from a model: no
 * evidence the app has proves them. `availability` is never free text: the
 * bound availability layer says it.
 */
export const CLAIM_EVIDENCE: Readonly<Record<ClaimKind, ReadonlyArray<'offer' | 'service_claim' | 'arrival' | 'back_in_stock' | 'never'>>> = Object.freeze({
  discount: ['offer'],
  limited_time: ['offer'],
  free: ['service_claim'],
  warranty_term: ['service_claim'],
  arrival: ['arrival'],
  back_in_stock: ['back_in_stock'],
  cheapest: ['never'],
  last_piece: ['never'],
  rating: ['never'],
  superlative: ['never'],
  availability: ['never'],
});

/**
 * The evidence a request carried for the claims its text may make (spec §9,
 * §10). It is computed by the Worker from the store and the studio's own
 * records at request time — never from what a model wrote. An absent flag is
 * false.
 */
export interface ClaimEvidence {
  /** A live public offer on the bound product. */
  offer: boolean;
  /** An approved, current service claim bound to the design. */
  serviceClaim: boolean;
  /** A documented arrival (recorded by the catalogue watch after its baseline pass). */
  arrival?: boolean;
  /** A documented unavailable → available transition (recorded by the catalogue watch). */
  backInStock?: boolean;
}

/** The claims in `text` that the supplied evidence does not cover. */
export function unsupportedClaims(text: string, evidence: ClaimEvidence): ClaimKind[] {
  return claimsIn(text).filter((kind) => {
    const needs = CLAIM_EVIDENCE[kind];
    if (needs.includes('never')) return true;
    if (needs.includes('offer') && evidence.offer) return false;
    if (needs.includes('service_claim') && evidence.serviceClaim) return false;
    if (needs.includes('arrival') && evidence.arrival === true) return false;
    if (needs.includes('back_in_stock') && evidence.backInStock === true) return false;
    return true;
  });
}

/** Links and URLs a model might fabricate — refused in model text (spec §15: no invented links). */
export function containsUrl(text: string): boolean {
  return /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|iq|io|co|app|store|shop)\b)/i.test(detectionText(text));
}
