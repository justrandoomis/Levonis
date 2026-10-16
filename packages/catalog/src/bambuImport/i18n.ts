/**
 * THE CATALOGUE TRANSLATION MEMORY'S SHARED RULES (docs/bambu-import/I18N-DESIGN.md
 * §A.1, §C.3, §D, §E; DECISIONS rows 2 and 183).
 *
 * The imported English (descriptions, spec values, box items, content blocks)
 * reaches an Arabic or Sorani reader through a translation memory: rows of
 * `catalog_translations` (migration 0196) keyed by the SHA-256 of the
 * normalized English, written by us — never by an external service (row 2) —
 * committed as reviewed data under data/bambu-import/translations/ and loaded
 * through the import door. One module decides, for every party:
 *
 *   - how an English string is normalized and keyed (`normalizeSource`,
 *     `sourceHash`): the extraction script that lists the strings, the
 *     assembler that writes the parts, the Worker's loader that re-proves each
 *     row, and the display overlay that looks a string up;
 *   - how a multi-line slot is cut into translatable segments
 *     (`translateLines`: a bullet prefix is kept verbatim, a content-block
 *     table row is split into its `' | '` cells, a line without a translation
 *     keeps its English) and how a whole value is looked up (`translateWhole`);
 *   - what a valid row is (`validateTranslationRow`) — the same function for
 *     the assembler, the CI data test and the loader;
 *   - when a text is nothing but names (`namesOnly`): a compatibility statement
 *     that only repeats its chips, a string the extraction never offers.
 *
 * Pure: this package's own normalisation and hash, no binding, no I/O.
 * Names, option and colour names, model numbers, part codes, units and brand
 * names stay Latin in every language (worker/lib/translate/localizeProduct.ts,
 * mandate §3/§7); a Sorani string is never a copy of the Arabic (row 183); no
 * translation may add a price, cost, stock or shipping-time fact.
 */
import { sha256Hex } from './hash';
import { cleanText, labelKey } from './normalize';

// ---------------------------------------------------------------- the key

/**
 * Every run of whitespace, NBSP, ZWSP, LS, PS, BOM → one space; trimmed; then
 * Unicode NFC — exactly normalize.ts `cleanText`, the form every imported
 * string is stored in. A row's `en` is stored in this form.
 */
export function normalizeSource(s: string): string {
  return cleanText(s);
}

/** sha256 (hash.ts, FIPS 180-4) over the UTF-8 bytes of `normalizeSource(en)`: 64 lowercase hex. */
export function sourceHash(en: string): string {
  return sha256Hex(normalizeSource(en));
}

// ---------------------------------------------------------------- segments

/** A translation of one English segment. */
export interface Tr {
  ar: string;
  ckb: string;
}

/** A bullet a line starts with: kept verbatim, never translated. */
export const BULLET = /^(\s*(?:[•·▪◦*]|-)\s+)/;
/** How a content-block table row joins its cells (payload.ts `withoutMoneyColumns`). */
export const CELL_SEP = ' | ';

/** One line of a multi-line slot, cut the way the extraction and the overlay both cut it. */
export interface LineParts {
  /** The bullet prefix, verbatim ('' for none). */
  prefix: string;
  /** The segments to look up: one, or a table row's cells. */
  segments: string[];
  /** True when `segments` are a table row's cells (rejoined with `CELL_SEP`). */
  cells: boolean;
}

/** A line's prefix and its translatable segments (blank segments included, so a rebuild keeps the shape). */
export function lineParts(line: string): LineParts {
  const m = BULLET.exec(line);
  const prefix = m ? m[1] : '';
  const rest = line.slice(prefix.length);
  if (rest.includes(CELL_SEP)) return { prefix, segments: rest.split(CELL_SEP), cells: true };
  return { prefix, segments: [rest], cells: false };
}

/**
 * The normalized English segments of a multi-line slot, in order (blank ones
 * dropped): what the extraction lists and the overlay looks up.
 */
export function slotSegments(text: string): string[] {
  const out: string[] = [];
  for (const line of String(text ?? '').split('\n')) {
    for (const seg of lineParts(line).segments) {
      const n = normalizeSource(seg);
      if (n) out.push(n);
    }
  }
  return out;
}

/**
 * A multi-line slot in Arabic and in Sorani: each line rebuilt as its bullet
 * prefix plus its translated segment (or its cells joined by `' | '`). A
 * segment the lookup misses keeps its English, in that language too. `hit` is
 * how many segments were translated, `total` how many there are; with
 * `hit === 0` the caller leaves the slot untouched.
 */
export function translateLines(text: string, lookup: (normEn: string) => Tr | null): { ar: string; ckb: string; hit: number; total: number } {
  const ar: string[] = [];
  const ckb: string[] = [];
  let hit = 0;
  let total = 0;
  for (const line of String(text ?? '').split('\n')) {
    const parts = lineParts(line);
    const segAr: string[] = [];
    const segCkb: string[] = [];
    let lineHit = 0;
    for (const seg of parts.segments) {
      const n = normalizeSource(seg);
      if (!n) {
        segAr.push(seg);
        segCkb.push(seg);
        continue;
      }
      total += 1;
      const t = lookup(n);
      if (t && t.ar && t.ckb) {
        hit += 1;
        lineHit += 1;
        // A cell keeps the spaces around it inside the table row; a whole line is the translation alone.
        const lead = parts.cells ? /^\s*/.exec(seg)![0] : '';
        const trail = parts.cells ? /\s*$/.exec(seg)![0] : '';
        segAr.push(`${lead}${t.ar}${trail}`);
        segCkb.push(`${lead}${t.ckb}${trail}`);
      } else {
        segAr.push(seg);
        segCkb.push(seg);
      }
    }
    if (lineHit === 0) {
      ar.push(line);
      ckb.push(line);
      continue;
    }
    const join = parts.cells ? CELL_SEP : '';
    ar.push(`${parts.prefix}${segAr.join(join)}`);
    ckb.push(`${parts.prefix}${segCkb.join(join)}`);
  }
  return { ar: ar.join('\n'), ckb: ckb.join('\n'), hit, total };
}

/** One whole value (a spec value, a list item, a box item, a label, a title): normalized, then looked up. */
export function translateWhole(text: string, lookup: (normEn: string) => Tr | null): Tr | null {
  const n = normalizeSource(String(text ?? ''));
  if (!n) return null;
  const t = lookup(n);
  return t && t.ar && t.ckb ? { ar: t.ar, ckb: t.ckb } : null;
}

// ---------------------------------------------------------------- names

/** The words that join names in a statement («X1 Series and P1 Series», «A1 / A1 mini»). */
const CONNECTORS = new Set(['and', 'or', 'with', 'series', 'printers', 'printer', 'compatible', 'compatibility', 'for', 'the', 'all']);

/**
 * True when `text` says nothing beyond the `names`: remove every name
 * (`labelKey`, longest first, word-bounded) and the connectors
 * (`and or & / , ; + with series printers compatible compatibility`); if no
 * Latin word of two or more letters is left, the text is only names. A text
 * with no Latin word at all is not "only names" (there was nothing to match).
 */
export function namesOnly(text: string, names: Iterable<string>): boolean {
  const key = labelKey(String(text ?? ''));
  if (!/[a-z]{2,}/.test(key)) return false;
  const forms = [...new Set([...names].map((n) => labelKey(String(n ?? ''))).filter(Boolean))].sort((a, b) => b.length - a.length);
  let k = ` ${key} `;
  for (const f of forms) {
    const needle = ` ${f} `;
    while (k.includes(needle)) k = k.split(needle).join(' ');
  }
  const words = k.split(' ').filter(Boolean);
  return !words.some((w) => /^[a-z][a-z'’-]*$/.test(w) && w.length >= 2 && !CONNECTORS.has(w));
}

// ---------------------------------------------------------------- rows

/** What a string is, where the extraction found it (§D). */
export const TM_KINDS = [
  'short_description',
  'usage_title',
  'usage_body',
  'spec_value_text',
  'spec_list_item',
  'spec_label',
  'box_item',
  'test_method',
  'doc_title',
  'relation_label',
  'block_title',
  'block_line',
  'block_cell',
  'faq_q',
  'faq_a',
] as const;
export type TmKind = (typeof TM_KINDS)[number];

/** `reviewed` and `machine` are shown; `needs_review` is stored and never shown (and is how a row is withdrawn). */
export const TM_STATUSES = ['reviewed', 'machine', 'needs_review'] as const;
export type TmStatus = (typeof TM_STATUSES)[number];

/** One row of a committed part file (§E), keys in this order. */
export interface TranslationRow {
  h: string;
  en: string;
  ar: string;
  ckb: string;
  kind: TmKind;
  status: TmStatus;
  products: string[];
}

export const TRANSLATION_ROW_KEYS = ['h', 'en', 'ar', 'ckb', 'kind', 'status', 'products'] as const;

export type TranslationRowCode =
  | 'SHAPE'
  | 'HASH'
  | 'NOT_NORMALIZED'
  | 'KIND'
  | 'STATUS'
  | 'EMPTY'
  | 'TOO_LONG'
  | 'AR_SCRIPT'
  | 'CKB_SCRIPT'
  | 'CKB_COPIES_AR'
  | 'DIGITS'
  | 'TOKEN_LOST'
  | 'NAME_TRANSLATED'
  | 'BIDI_CONTROL'
  | 'MONEY_ADDED'
  | 'PRODUCTS';

export interface ValidateContext {
  /** Names that must survive verbatim (manifest titles, compat labels): the assembler and the CI test pass them. */
  names?: ReadonlySet<string>;
  /** Terms that read the same in every language (the dictionary's IDENTITY_TERMS, lower case). */
  identity?: ReadonlySet<string>;
}

export const EN_MAX = 4000;
export const TR_MAX = 8000;
export const PRODUCTS_MAX = 2000;
const PRODUCT_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** Any Arabic-script letter (Arabic, Arabic Supplement, Extended-A, the presentation forms). */
export const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const ARABIC_LETTER = /[\u0620-\u064A\u066E-\u06D3\u06D5\u06EE\u06EF\u06FA-\u06FC\u06FF\u0750-\u077F\u08A0-\u08FF]/;
/** Letters Sorani writes and Arabic does not. */
const SORANI_ONLY = /[\u06D5\u06CE\u06C6\u06B5\u0695\u06CA]/;
const SORANI_MARK = /[\u06D5\u06CE\u06C6\u06B5\u0695]/;
/** Bidi controls: never in data — isolation is the renderer's job (§B.1 rule 8). */
const BIDI_CONTROLS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const EASTERN_DIGITS = /[\u0660-\u0669\u06F0-\u06F9]/;

/** A code, model or part token: a digit and an upper-case letter (A1, X1C, SA011, 4-Pin, M3*21.5), or `^[A-Z]{2,}\d`. */
const CODE_TOKEN = /^(?=.*\d)(?=.*[A-Z])[A-Za-z0-9][A-Za-z0-9.*/+×-]*[A-Za-z0-9]$|^[A-Z]{2,}\d[A-Za-z0-9-]*$/;
/** A unit written right after a number (`10mA`, `24 V`, `0.4 mm`): the symbol units, never an English word. */
const ATTACHED_UNIT =
  /(\d+(?:[.,]\d+)?)\s?(mm³\/s|mm\/s²|mm\/s|kJ\/m²|g\/cm³|mm³|mm²|mm|cm|μm|µm|nm|kg|mg|g|lbs|lb|mAh|mA|μA|µA|kWh|Wh|kW|mW|W|kVA|VA|VAC|VDC|V|kHz|MHz|GHz|Hz|MPa|GPa|dBA|dB|°C|℃|°F|mL|ml|Nm|rpm|kΩ|Ω)(?![A-Za-z0-9])/g;

const MONEY_MARKERS: ReadonlyArray<{ re: RegExp; unlessEn?: RegExp }> = [
  { re: /د\.ع/ },
  { re: /دينار/ },
  { re: /دۆلار/ },
  { re: /\$/, unlessEn: /\$/ },
  { re: /\bUSD\b/, unlessEn: /\bUSD\b/ },
  { re: /\bIQD\b/, unlessEn: /\bIQD\b/ },
  { re: /سعر|أسعار/ },
  { re: /نرخ/ },
  { re: /(^|[\s،؛.:()«»])(ال)?مخزون/ },
  { re: /(^|[\s،؛.:()«»])کۆگا(کە|ی|دا)?($|[\s،؛.:()«»])/ },
  { re: /الشحن خلال/ },
  { re: /التوصيل خلال/ },
];

const digitRuns = (s: string): string[] => (s.match(/[0-9]+/g) ?? []).sort();
const sameMultiset = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** The tokens of `en` that must reach both translations verbatim: codes, identity terms, units on numbers. */
export function protectedTokens(en: string, identity?: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const raw of en.split(/\s+/)) {
    const tok = raw.replace(/^[("'“‘[]+|[)"'”’\],.;:!?]+$/g, '');
    if (!tok) continue;
    if (CODE_TOKEN.test(tok) && !/^\d+(st|nd|rd|th)$/i.test(tok)) out.add(tok);
    else if (identity && /^[A-Z][A-Z0-9+-]*[A-Z0-9+]$/.test(tok) && identity.has(tok.toLowerCase())) out.add(tok);
  }
  for (const m of en.matchAll(ATTACHED_UNIT)) out.add(`${m[1]}\u0000${m[2]}`);
  return [...out];
}

function hasToken(text: string, token: string): boolean {
  if (token.includes('\u0000')) {
    const [num, unit] = token.split('\u0000');
    return text.includes(`${num}${unit}`) || text.includes(`${num} ${unit}`) || text.includes(`${num}\u00a0${unit}`);
  }
  return text.includes(token);
}

/** The names of `names` the English states (case-sensitive, word-bounded). */
export function namesIn(en: string, names: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const n of names) {
    if (!n || n.length < 2 || !en.includes(n)) continue;
    const re = new RegExp(`(^|[^A-Za-z0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9])`);
    if (re.test(en)) out.push(n);
  }
  return out;
}

/**
 * One translation row as committed (§E): the same function for the assembler,
 * the CI data test and the Worker's loader. The hash proof is per row:
 * `h === sourceHash(en)` and `en === normalizeSource(en)`.
 */
export function validateTranslationRow(row: unknown, ctx: ValidateContext = {}): { ok: true; row: TranslationRow } | { ok: false; code: TranslationRowCode } {
  const fail = (code: TranslationRowCode) => ({ ok: false as const, code });
  if (!row || typeof row !== 'object' || Array.isArray(row)) return fail('SHAPE');
  const r = row as Record<string, unknown>;
  const keys = Object.keys(r);
  if (keys.length !== TRANSLATION_ROW_KEYS.length || !TRANSLATION_ROW_KEYS.every((k) => keys.includes(k))) return fail('SHAPE');
  if (typeof r.h !== 'string' || typeof r.en !== 'string' || typeof r.ar !== 'string' || typeof r.ckb !== 'string') return fail('SHAPE');
  if (typeof r.kind !== 'string' || typeof r.status !== 'string' || !Array.isArray(r.products)) return fail('SHAPE');
  const { h, en, ar, ckb } = r as { h: string; en: string; ar: string; ckb: string };
  if (!en || !ar || !ckb) return fail('EMPTY');
  if (en !== normalizeSource(en) || ar !== normalizeSource(ar) || ckb !== normalizeSource(ckb)) return fail('NOT_NORMALIZED');
  if (!/^[0-9a-f]{64}$/.test(h) || h !== sourceHash(en)) return fail('HASH');
  if (!(TM_KINDS as readonly string[]).includes(r.kind)) return fail('KIND');
  if (!(TM_STATUSES as readonly string[]).includes(r.status)) return fail('STATUS');
  const cap = Math.min(TR_MAX, Math.max(3 * en.length, en.length + 200));
  if (en.length > EN_MAX || ar.length > cap || ckb.length > cap) return fail('TOO_LONG');
  if (BIDI_CONTROLS.test(ar) || BIDI_CONTROLS.test(ckb)) return fail('BIDI_CONTROL');
  if (!ARABIC_LETTER.test(ar) || SORANI_ONLY.test(ar)) return fail('AR_SCRIPT');
  if (ckb === ar) return fail('CKB_COPIES_AR');
  if (!ARABIC_LETTER.test(ckb)) return fail('CKB_SCRIPT');
  const ckbWords = ckb.split(/\s+/).filter((w) => ARABIC_LETTER.test(w));
  if (ckbWords.length >= 2 && !SORANI_MARK.test(ckb)) return fail('CKB_SCRIPT');
  if (EASTERN_DIGITS.test(ar) || EASTERN_DIGITS.test(ckb)) return fail('DIGITS');
  const digits = digitRuns(en);
  if (!sameMultiset(digits, digitRuns(ar)) || !sameMultiset(digits, digitRuns(ckb))) return fail('DIGITS');
  for (const t of protectedTokens(en, ctx.identity)) if (!hasToken(ar, t) || !hasToken(ckb, t)) return fail('TOKEN_LOST');
  if (ctx.names) for (const n of namesIn(en, ctx.names)) if (!ar.includes(n) || !ckb.includes(n)) return fail('NAME_TRANSLATED');
  for (const m of MONEY_MARKERS) {
    if (m.unlessEn && m.unlessEn.test(en)) continue;
    if (m.re.test(ar) || m.re.test(ckb)) return fail('MONEY_ADDED');
  }
  const products = r.products as unknown[];
  if (products.length === 0 || products.length > PRODUCTS_MAX) return fail('PRODUCTS');
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    if (typeof p !== 'string' || !PRODUCT_ID.test(p)) return fail('PRODUCTS');
    if (i > 0 && !((products[i - 1] as string) < p)) return fail('PRODUCTS');
  }
  return {
    ok: true,
    row: { h, en, ar, ckb, kind: r.kind as TmKind, status: r.status as TmStatus, products: products as string[] },
  };
}

/** A row as one line of a part file: keys in the committed order. */
export function serializeTranslationRow(row: TranslationRow): string {
  return JSON.stringify({ h: row.h, en: row.en, ar: row.ar, ckb: row.ckb, kind: row.kind, status: row.status, products: row.products });
}

/** A part file's exact text: a JSON array, one row per line, LF, a trailing newline. */
export function serializeTranslationPart(rows: readonly TranslationRow[]): string {
  if (!rows.length) return '[]\n';
  return `[\n${rows.map(serializeTranslationRow).join(',\n')}\n]\n`;
}
