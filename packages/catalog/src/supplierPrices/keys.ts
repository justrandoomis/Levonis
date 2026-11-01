/**
 * Matching keys (docs/SMART_PRICING.md §3.5): what the matcher reads out of a
 * supplier item and out of a Levonis product, and the index rows the upload
 * writes into `supplier_price_keys`.
 *
 *   Colour code   \b\d{5}\b, kept only in a colour-kind option or a title (battery sizes and
 *                 figures followed by a unit are not colours)
 *   Part code     \b(?:B-)?[A-Z]{2,3}\d{3,4}(?:-V\d+)?\b, upper case, the leading B- removed;
 *                 a -V<n> revision is kept apart, so FAP023-V1 equals FAP023 "revision stripped"
 *   SKU code      the store's Bambu SKU code (A00-W1-1.75-1000-SPLFREE); a compound code
 *                 (B-SA001+B-QA013) is a kit of parts
 *   Model token   A1, A1 mini, P1S, P1P, P2S, X1C, X1E, H2D, H2S, X2D, AMS 2 Pro, AMS HT, AMS lite …
 *   Material      PLA Basic, PLA Matte, PETG HF, ABS, ASA, TPU 95A, PA6-CF … (dictionary.ts)
 *   Pack, weight  10件装, N卷, ×N, 净重10kg, 1kg, 500g (packOf)
 *
 * Pure: no I/O; vocabularies come from dictionary.ts.
 */
import {
  ADDON_SKU,
  CN_NUMERALS,
  COLOUR_GROUP_NAMES,
  HIGH_FLOW_WORDS,
  LISTING_FLAG_RULES,
  MATERIAL_TOKENS,
  MODEL_TOKENS,
  NAME_STOPWORDS,
  NOZZLE_MATERIALS,
  PACK_BRACKET_WORDS,
  PACK_MEASURE_WORDS,
  PLACEHOLDER_SKU,
  PLATE_GENERATIONS,
  PLATE_TYPES,
  SPOOL_WORDS,
  WEIGHT_UNITS,
  type ListingFlag,
  type NozzleMaterial,
  type PlateType,
  type TokenEntry,
} from './dictionary';
import type { SupplierSource } from './format';

// ---------------------------------------------------------------- text

/** NFKC, lower case; every character other than a letter, digit, `+`, `-`, `&` or `/` becomes a space. */
export function wordsOf(text: string): string {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+\-&/]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** An option label as two stores compare it: NFKC, lower case, letters and digits only ("H2D / standard" → "h2d standard"). */
export function labelKeyOf(text: string): string {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const ASCII_WORD = /[a-z0-9]/;
const hasCjk = (s: string) => /[㐀-鿿豈-﫿]/.test(s);

/**
 * Every occurrence of `form` in `text` (both from wordsOf) as a whole word: a Latin edge needs a
 * non-alphanumeric neighbour; a CJK edge needs none (Chinese has no spaces).
 */
function occurrences(text: string, form: string): number[] {
  const out: number[] = [];
  for (let at = text.indexOf(form); at >= 0; at = text.indexOf(form, at + 1)) {
    const before = at > 0 ? text[at - 1]! : ' ';
    const after = at + form.length < text.length ? text[at + form.length]! : ' ';
    const okBefore = !ASCII_WORD.test(form[0]!) || !ASCII_WORD.test(before);
    const okAfter = !ASCII_WORD.test(form[form.length - 1]!) || !ASCII_WORD.test(after);
    if (okBefore && okAfter) out.push(at);
  }
  return out;
}

const sortedForms = (entries: readonly TokenEntry[]) =>
  entries.flatMap((e) => e.forms.map((f) => [wordsOf(f) || f, e] as const)).sort((a, b) => b[0].length - a[0].length);

const MODEL_FORMS = sortedForms(MODEL_TOKENS);
const MATERIAL_FORMS = sortedForms(MATERIAL_TOKENS);

/** The canonical tokens named in the texts, longest form first, never two tokens from one span. */
function tokensIn(forms: ReadonlyArray<readonly [string, TokenEntry]>, texts: readonly string[], skip?: (text: string, at: number) => boolean): string[] {
  const out: string[] = [];
  for (const raw of texts) {
    let t = wordsOf(raw);
    for (const [form, e] of forms) {
      for (const at of occurrences(t, form)) {
        if (skip?.(t, at)) continue;
        for (const tok of e.tokens) if (!out.includes(tok)) out.push(tok);
        t = t.slice(0, at) + ' '.repeat(form.length) + t.slice(at + form.length);
      }
    }
  }
  return out;
}

/** Bambu Lab model tokens named in the texts (`X1/P1系列` → X1 series, P1 series). */
export function modelTokensIn(...texts: string[]): string[] {
  return tokensIn(MODEL_FORMS, texts);
}

/** Filament lines named in the texts. "1 PC" (one piece) is not polycarbonate. */
export function materialTokensIn(...texts: string[]): string[] {
  return tokensIn(MATERIAL_FORMS, texts, (t, at) => t.startsWith('pc', at) && /[0-9]\s?$/.test(t.slice(0, at)));
}

// ---------------------------------------------------------------- codes

const BATTERY_SIZES = new Set(['10440', '14500', '16340', '18650', '21700', '26650']);

/** 5-digit Bambu colour codes in a text: not a battery size, not part of a decimal, not a figure with a unit. */
export function colourCodesIn(text: string): string[] {
  const s = String(text ?? '').normalize('NFKC');
  const out: string[] = [];
  for (const m of s.matchAll(/\b\d{5}\b/g)) {
    const code = m[0];
    const at = m.index ?? 0;
    const after = s.slice(at + 5);
    if (BATTERY_SIZES.has(code)) continue;
    if (s[at - 1] === '.' || /^\.\d/.test(after)) continue;
    if (/^\s*(?:v|mah|mm|cm|w|rpm|kg|g|ml|mw)\b/i.test(after)) continue;
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

/** The colour code a store option value carries in brackets ("Jade White (10100)"), as the import reads it. */
export function bracketColourCode(value: string): string | null {
  const m = /\((\d{5})\)/.exec(String(value ?? '').normalize('NFKC'));
  return m ? m[1]! : null;
}

export interface PartCode {
  /** Upper case, the leading B- and any -V<n> revision removed: the comparison key. */
  code: string;
  /** The revision (`V1`), '' when none. */
  revision: string;
}

const PART_CODE = /\b(?:B-)?([A-Z]{2,3}\d{3,4})(?:-(V\d+))?\b/g;

/** Part and kit codes in a text (ZH122, B-ZH171 → ZH171, FAP023-V1 → FAP023 + V1). */
export function partCodesIn(text: string): PartCode[] {
  const s = String(text ?? '').normalize('NFKC');
  const out: PartCode[] = [];
  for (const m of s.matchAll(PART_CODE)) {
    const pc = { code: m[1]!, revision: m[2] ?? '' };
    if (!out.some((x) => x.code === pc.code && x.revision === pc.revision)) out.push(pc);
  }
  return out;
}

/** One code as written anywhere (a stored part_code, a capture's `codes` entry): normalised, or null when it is no part code. */
export function normalizePartCode(raw: string): PartCode | null {
  const s = String(raw ?? '').normalize('NFKC').trim().toUpperCase();
  const m = /^(?:B-)?([A-Z]{2,3}\d{3,4})(?:-(V\d+))?$/.exec(s);
  return m ? { code: m[1]!, revision: m[2] ?? '' } : null;
}

/**
 * The parts a Bambu SKU code names: "B-KC008" → [KC008]; "FAP023-V1" → [FAP023 V1];
 * "B-SA001+B-QA013" → a compound (a kit) of two parts; a filament code (A00-W1-1.75-1000-SPL) → none.
 */
export function skuCodeParts(skuCode: string): { parts: PartCode[]; compound: boolean } {
  const pieces = String(skuCode ?? '')
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  const parts: PartCode[] = [];
  for (const p of pieces) {
    const pc = normalizePartCode(p);
    if (pc && !parts.some((x) => x.code === pc.code)) parts.push(pc);
  }
  return { parts, compound: pieces.length > 1 && parts.length > 1 };
}

/** The spool state a Bambu SKU code ends with (-SPLFREE refill, -SPL with spool). */
export function spoolOfSkuCode(skuCode: string): 'spool' | 'refill' | null {
  const s = String(skuCode ?? '').toUpperCase();
  if (/-SPLFREE$/.test(s)) return 'refill';
  if (/-SPL$/.test(s)) return 'spool';
  return null;
}

/** Whether an option group name holds colours (颜色 / 颜色分类 / Colour). */
export function isColourGroupName(name: string): boolean {
  const k = String(name ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s(（].*$/u, '')
    .trim();
  return COLOUR_GROUP_NAMES.includes(k);
}

// ---------------------------------------------------------------- options by kind

/** Whether a form occurs in a wordsOf text as a whole word (CJK forms: anywhere). */
function containsForm(text: string, form: string): boolean {
  return occurrences(text, wordsOf(form) || form).length > 0;
}

function removeForm(text: string, form: string): string {
  const f = wordsOf(form) || form;
  let t = text;
  for (const at of occurrences(t, f).reverse()) t = t.slice(0, at) + ' '.repeat(f.length) + t.slice(at + f.length);
  return t;
}

/** One text's spool answer: refill words first (无料盘 holds 料盘); a text that says both says nothing. */
function spoolOfText(raw: string): 'spool' | 'refill' | null {
  let t = wordsOf(raw);
  let refill = false;
  for (const f of SPOOL_WORDS.refill) {
    if (containsForm(t, f)) {
      refill = true;
      t = removeForm(t, f);
    }
  }
  const spool = SPOOL_WORDS.spool.some((f) => containsForm(t, f));
  if (refill && spool) return null;
  return refill ? 'refill' : spool ? 'spool' : null;
}

/** The spool state the first text that states one states (with spool | refill), or null. */
export function spoolOf(...texts: string[]): 'spool' | 'refill' | null {
  for (const t of texts) {
    const s = spoolOfText(t);
    if (s) return s;
  }
  return null;
}

export interface NozzleFacts {
  /** The diameter as written without a unit ("0.4"), or null. */
  diameter: string | null;
  material: NozzleMaterial | null;
  flow: 'high' | 'standard';
}

function oneOrNull<T>(values: T[]): T | null {
  const set = [...new Set(values)];
  return set.length === 1 ? set[0]! : null;
}

/** A nozzle's diameter, material and flow, each from the first text that states exactly one. */
export function nozzleOf(...texts: string[]): NozzleFacts {
  let diameter: string | null = null;
  let material: NozzleMaterial | null = null;
  let flow: 'high' | 'standard' = 'standard';
  for (const raw of texts) {
    const s = String(raw ?? '').normalize('NFKC');
    const t = wordsOf(s);
    if (diameter === null) {
      // "0.4/0.6/0.8mm" names three diameters, not 0.8.
      const found = [...s.matchAll(/(?<![0-9.])((?:0\.[0-9]{1,2}|1\.0|1\.2)(?:\s*[/、,，]\s*(?:0\.[0-9]{1,2}|1\.0|1\.2))*)\s*(?:mm|毫米)/gi)].flatMap((m) =>
        m[1]!.split(/[/、,，]/).map((x) => String(Number(x.trim())))
      );
      diameter = oneOrNull(found);
    }
    if (material === null) material = oneOrNull(NOZZLE_MATERIALS.filter((m) => m.forms.some((f) => containsForm(t, f))).map((m) => m.key));
    if (HIGH_FLOW_WORDS.some((f) => containsForm(t, f))) flow = 'high';
  }
  return { diameter, material, flow };
}

export interface PlateFacts {
  type: PlateType | null;
  generation: number | null;
}

/** A build plate's type and generation, each from the first text that states exactly one. */
export function plateOf(...texts: string[]): PlateFacts {
  let type: PlateType | null = null;
  let generation: number | null = null;
  for (const raw of texts) {
    let t = wordsOf(raw);
    if (type === null) {
      const found: PlateType[] = [];
      for (const p of PLATE_TYPES) {
        for (const f of p.forms) {
          if (containsForm(t, f)) {
            found.push(p.key);
            t = removeForm(t, f);
          }
        }
      }
      type = oneOrNull(found);
    }
    if (generation === null) generation = oneOrNull(PLATE_GENERATIONS.filter((g) => g.forms.some((f) => containsForm(wordsOf(raw), f))).map((g) => g.gen));
  }
  return { type, generation };
}

// ---------------------------------------------------------------- pack and weight

export interface PackFacts {
  /** How many units one offer holds (10件装 → 10); 1 when nothing says otherwise. 0218: 1..1000. */
  pack_units: number;
  /** The offer's net weight in grams (净重10kg → 10000, 1kg → 1000), or null. 0218: 1..100,000,000. */
  net_weight_g: number | null;
  /** Whether a text stated the unit count (an unstated count reads as 1 but proves nothing). */
  units_stated: boolean;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MEASURE = PACK_MEASURE_WORDS.map(escapeRe).join('|');
const BRACKET_WORD = PACK_BRACKET_WORDS.map(escapeRe).join('|');
const NUMERALS = Object.keys(CN_NUMERALS).join('');
const COUNT_RES: readonly RegExp[] = [
  new RegExp(`(?<![0-9.])([0-9]{1,4})\\s*(?:${MEASURE})`, 'g'),
  new RegExp(`([${NUMERALS}])\\s*(?:${MEASURE})`, 'g'),
  new RegExp(`[(（]\\s*([0-9]{1,4})\\s*(?:${BRACKET_WORD})\\s*[)）]`, 'gi'),
  /\b([0-9]{1,4})\s*-?\s*(?:pcs|pc|pieces|packs?|rolls|spools|units?)\b/gi,
  /\b(?:pack|set|box) of ([0-9]{1,4})\b/gi,
];

const units = (n: number) => (Number.isInteger(n) && n >= 1 && n <= 1000 ? n : null);

/** The unit counts one text states outright (件装, 卷, (20个), 20 pcs, pack of 3). */
function countsIn(s: string): number[] {
  const out: number[] = [];
  for (const re of COUNT_RES) {
    for (const m of s.matchAll(re)) {
      const raw = m[1]!;
      const n = units(/^[0-9]+$/.test(raw) ? Number(raw) : (CN_NUMERALS[raw] ?? NaN));
      if (n !== null) out.push(n);
    }
  }
  return out;
}

/**
 * A multiplier sign after a word, never after a figure (2x18 mm, M2.5x6) or a measure (370mm*1):
 * `*`, `×`, or a lower-case `x` standing alone (" x3"), so a model (X1, X2D) is never a count.
 */
const MULTIPLIER = /([*×]|(?<=\s|^)x)\s*([0-9]{1,4})(?![0-9.]|\s*(?:mm|cm|m\b|kg|g\b|ml))(?![A-Za-z])/g;

/**
 * The multipliers of one text. A +-joined list with a count on every term adds up only for
 * filament, rolls by colour (黑*5+白*5 → 10); any other such list names the different parts of
 * one set (膜*2+弹簧钢板*1), and its counts are not the offer's units.
 */
function multipliersIn(s: string, filament: boolean): number[] | null {
  const terms = s.split('+');
  const one = (part: string): number[] => {
    const out: number[] = [];
    for (const m of part.matchAll(MULTIPLIER)) {
      const at = m.index ?? 0;
      const before = part.slice(0, at);
      if (/[0-9.]\s*$/.test(before)) continue;
      if (/[0-9]\s*(?:mm|cm|m|kg|g|ml)\s*$/i.test(before)) continue;
      if (m[1] !== '*' && m[1] !== '×' && /[a-z]$/i.test(before)) continue;
      const n = units(Number(m[2]));
      if (n !== null) out.push(n);
    }
    return out;
  };
  const per = terms.map(one);
  if (terms.length > 1 && per.every((x) => x.length === 1)) return filament ? [per.reduce((a, x) => a + x[0]!, 0)] : null;
  const all = per.flat();
  return all.length ? all : null;
}

/** The weights one text states (净重 first), in grams. */
function weightsIn(s: string): number[] {
  const unit = Object.keys(WEIGHT_UNITS).map(escapeRe).join('|');
  const net = [...s.matchAll(new RegExp(`净重\\s*([0-9]+(?:\\.[0-9]+)?)\\s*(${unit})(?![a-z])`, 'gi'))];
  const found = net.length ? net : [...s.matchAll(new RegExp(`(?<![0-9.])([0-9]+(?:\\.[0-9]+)?)\\s*(${unit})(?![a-z])`, 'gi'))];
  const out: number[] = [];
  // "净重3kg/4kg" offers two weights: it states none.
  if (net.some((m) => /^\s*[/、或]\s*[0-9]/.test(s.slice((m.index ?? 0) + m[0].length)))) return [-1, -2];
  for (const m of found) {
    const factor = WEIGHT_UNITS[m[2]!.toLowerCase()] ?? WEIGHT_UNITS[m[2]!];
    if (!factor) continue;
    if (m[2] === 'G') continue; // 5G is a network, not 5 grams
    const g = Math.round(Number(m[1]) * factor);
    if (g >= 1 && g <= 100_000_000) out.push(g);
  }
  return out;
}

/**
 * The pack and weight one offer states, from its texts in order (a SKU's option values first,
 * then its item's title): the first text that states a unit count outright (10件装, 6卷, (20个),
 * 20 pcs) decides the units; only when none does, the first multiplier (黑*10, ×3, 黑*5+白*5 → 10;
 * the parts of a set, 膜*2+弹簧钢板*1, are no count); else 1. The offer is filament when a text
 * names a filament line or a spool state. The weight is the first text's single stated weight
 * (净重 first); a text that states two different weights (净重3kg/4kg) says nothing. A pack price
 * is never divided here.
 */
export function packOf(texts: readonly string[]): PackFacts {
  const norm = texts.map((t) => String(t ?? '').normalize('NFKC'));
  let packUnits: number | null = null;
  for (const s of norm) {
    const c = oneOrNull(countsIn(s));
    if (c !== null) {
      packUnits = c;
      break;
    }
  }
  if (packUnits === null) {
    const filament = norm.some((s) => materialTokensIn(s).length > 0 || spoolOf(s) !== null);
    for (const s of norm) {
      const m = multipliersIn(s, filament);
      const one = m ? oneOrNull(m) : null;
      if (one !== null) {
        packUnits = one;
        break;
      }
    }
  }
  let weight: number | null = null;
  for (const s of norm) {
    const w = weightsIn(s);
    if (w.length) {
      weight = oneOrNull(w);
      if (weight !== null) break;
    }
  }
  return { pack_units: packUnits ?? 1, net_weight_g: weight, units_stated: packUnits !== null };
}

// ---------------------------------------------------------------- listings and names

/** The listing flags a title carries (refurbished, placeholder, promotion …). */
export function listingFlagsOf(...texts: string[]): ListingFlag[] {
  const t = texts.map((x) => String(x ?? '').normalize('NFKC')).join(' ');
  return LISTING_FLAG_RULES.filter(([, re]) => re.test(t)).map(([f]) => f);
}

/** A SKU the page shows but does not sell ("补货时间待定 … 勿拍此项，下单不发货"). */
export function isPlaceholderSku(options: Readonly<Record<string, string>>): boolean {
  return Object.values(options ?? {}).some((v) => PLACEHOLDER_SKU.test(String(v).normalize('NFKC')));
}

/** A SKU that is another product offered beside the item (【推荐加购】 glue beside a plate). */
export function isAddonSku(options: Readonly<Record<string, string>>): boolean {
  return Object.values(options ?? {}).some((v) => ADDON_SKU.test(String(v).normalize('NFKC')));
}

/**
 * The words that name a product (English): wordsOf split at + - & /, stop words, model tokens
 * and Chinese runs dropped, a plain plural reduced (fans → fan). The model tokens are compared
 * on their own.
 */
export function nameTokensOf(text: string): string[] {
  let t = wordsOf(text);
  for (const [form] of MODEL_FORMS) for (const at of occurrences(t, form).reverse()) t = t.slice(0, at) + ' '.repeat(form.length) + t.slice(at + form.length);
  const out: string[] = [];
  for (const w0 of t.split(/[\s+\-&/]+/)) {
    if (!w0 || hasCjk(w0) || NAME_STOPWORDS.has(w0)) continue;
    const w = w0.length > 3 && w0.endsWith('s') && !w0.endsWith('ss') ? w0.slice(0, -1) : w0;
    if (NAME_STOPWORDS.has(w)) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

/** Token Jaccard of two name token lists (0 when either is empty). */
export function nameJaccard(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

// ---------------------------------------------------------------- the index (supplier_price_keys)

export const KEY_TYPES = ['variant_id', 'sku_code', 'part_code', 'color_code', 'handle', 'model_token', 'name_token'] as const;
export type KeyType = (typeof KEY_TYPES)[number];

export interface IndexKey {
  key_type: KeyType;
  key_value: string;
  /** The SKU the key belongs to, '' for the item itself. */
  sku_key: string;
}

/** What a catalogue item offers the index (the parsed file's shape, or the stored rows'). */
export interface KeyedItem {
  item_key: string;
  title: string;
  name_en: string;
  codes?: readonly string[];
  skus: ReadonlyArray<{
    sku_key: string;
    options: Readonly<Record<string, string>>;
    options_en?: Readonly<Record<string, string>>;
    sku_code?: string;
    codes?: readonly string[];
  }>;
}

const isStore = (source: SupplierSource) => source === 'bambu_eu' || source === 'bambu_us';

/** The colour codes of one catalogue SKU: in colour-kind options (Tmall: 颜色; stores: "Name (10100)") and its own 5-digit codes. */
export function skuColourCodes(source: SupplierSource, sku: KeyedItem['skus'][number]): string[] {
  const out: string[] = [];
  const add = (c: string) => {
    if (!out.includes(c)) out.push(c);
  };
  for (const [group, value] of Object.entries(sku.options ?? {})) {
    if (isStore(source)) {
      const c = bracketColourCode(value);
      if (c) add(c);
    } else if (isColourGroupName(group)) {
      for (const c of colourCodesIn(value)) add(c);
    }
  }
  for (const c of sku.codes ?? []) if (/^\d{5}$/.test(c)) add(c);
  return out;
}

/** The part codes of one catalogue SKU: in its option values, its SKU code and its own codes. */
export function skuPartCodes(sku: KeyedItem['skus'][number]): PartCode[] {
  const out: PartCode[] = [];
  const add = (pc: PartCode | null) => {
    if (pc && !out.some((x) => x.code === pc.code && x.revision === pc.revision)) out.push(pc);
  };
  for (const v of Object.values(sku.options ?? {})) for (const pc of partCodesIn(v)) add(pc);
  for (const pc of skuCodeParts(sku.sku_code ?? '').parts) add(pc);
  for (const c of sku.codes ?? []) add(normalizePartCode(c));
  return out;
}

/** The part codes of an item's title and its own codes (5-digit codes there may sit in any option, so they are no colours). */
export function itemPartCodes(item: Pick<KeyedItem, 'title' | 'codes'>): PartCode[] {
  const out = partCodesIn(item.title);
  for (const c of item.codes ?? []) {
    const pc = normalizePartCode(c);
    if (pc && !out.some((x) => x.code === pc.code && x.revision === pc.revision)) out.push(pc);
  }
  return out;
}

const keyValue = (v: string) => (v.length >= 1 && v.length <= 120 ? v : null);

/**
 * The index rows of one catalogue item: its handle and variant ids (stores), SKU codes, part
 * codes, colour codes, model tokens and name tokens (with its filament line). Deduplicated.
 */
export function catalogueKeysOf(source: SupplierSource, item: KeyedItem): IndexKey[] {
  const out: IndexKey[] = [];
  const seen = new Set<string>();
  const add = (key_type: KeyType, value: string, sku_key: string) => {
    const v = keyValue(value);
    const id = `${key_type}\u0000${v}\u0000${sku_key}`;
    if (v && !seen.has(id)) {
      seen.add(id);
      out.push({ key_type, key_value: v, sku_key });
    }
  };
  if (isStore(source)) add('handle', item.item_key, '');
  for (const pc of itemPartCodes(item)) add('part_code', pc.code, '');
  for (const c of colourCodesIn(item.title)) add('color_code', c, '');
  for (const sku of item.skus) {
    if (isStore(source) && /^[0-9]{1,40}$/.test(sku.sku_key)) add('variant_id', sku.sku_key, sku.sku_key);
    if (sku.sku_code) add('sku_code', sku.sku_code.toUpperCase(), sku.sku_key);
    for (const pc of skuPartCodes(sku)) add('part_code', pc.code, sku.sku_key);
    for (const c of skuColourCodes(source, sku)) add('color_code', c, sku.sku_key);
  }
  for (const m of modelTokensIn(item.title, item.name_en)) add('model_token', m.toLowerCase(), '');
  for (const m of materialTokensIn(item.title, item.name_en)) add('name_token', m.toLowerCase(), '');
  for (const w of nameTokensOf(item.name_en || item.title)) add('name_token', w, '');
  return out;
}
