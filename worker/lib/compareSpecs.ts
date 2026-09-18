/**
 * THE COMPARISON, AS ONE PURE FUNCTION (worker/lib/compareSpecs.ts).
 *
 * «المقارنة تكون بشكل ذكي واحترافي ... وهذه ما لا تتفوق على الأخرى». A table of
 * two strings side by side is not that. What makes a comparison professional is
 * that it READS the values — knows that 256 x 256 x 256 is a volume with three
 * axes, that 52 dB beats 58 dB and that "Optional" is not "Yes" — and that it
 * says so in both directions, wins AND losses, rather than leaving the reader to
 * infer a weakness from an absence.
 *
 * THE THIRD CONSUMER OF templateFamilies.ts. The admin form renders those
 * fields and the import template generates its columns from them; this module
 * judges them. It adds no vocabulary of its own: a field it cannot find in the
 * definitions is not shown at all, exactly as specGroupsFromFields already
 * decides, because a customer reading `max_flow_rate` as a row label is worse
 * off than one reading nothing. HOW to read a field lives on the field
 * (`TemplateField.compare`), so a spec cannot be added to the form and silently
 * mean nothing here.
 *
 * THE DEFECT THIS MODULE EXISTS TO PREVENT — a comparison that punishes the
 * product whose data entry was less complete. If printer A has no
 * `max_flow_rate` recorded and B does, the naive table shows an empty cell next
 * to a number and every reader scores it as a loss. It is not a loss. It is a
 * gap in the shop's own admin work, presented to a customer as a statement about
 * a machine. So a missing value is `missing: true`: shown as «غير مذكور»,
 * excluded from `winners`, excluded from the score denominator, and excluded
 * from every chart axis. The same applies to a value nobody could parse — a
 * number guessed out of a string we did not understand is the same defect with
 * extra steps.
 *
 * THE DEFAULT IS THE SAFE ONE. A field with no `compare` annotation is shown and
 * never scored, so a spec added to the family tomorrow is honest before anyone
 * gets round to judging it.
 *
 * PRICE IS SHOWN, NEVER SCORED. It is emitted as its own group so every surface
 * — the page, the assistant's compact table — renders the same row from the same
 * numbers, and it carries weight 0 so it can never produce the verdict "this one
 * wins because it is cheaper", which is a verdict a customer does not trust
 * twice.
 *
 * VALUES ARE ENGLISH-ONLY by house rule (§3) and LABELS are trilingual, so
 * `CompareValue.text` is one string for all three readers while `CompareRow
 * .label` carries ar/en/ckb. The definitions hold no Kurdish, so ckb falls back
 * to the English label — the same substitution specGroupsFromFields makes.
 */
import {
  allTemplateGroups,
  isProductType,
  narrowGroups,
  productType,
  productTypeForBranch,
  type ProductTypeId,
  type SpecCompare,
  type TemplateField,
} from './templateFamilies';

export type CompareBasis = 'same_section' | 'same_type' | 'mixed';

export interface Trilingual {
  ar: string;
  en: string;
  ckb: string;
}

export interface CompareValue {
  /** Exactly what the admin typed, for display. */
  raw: string;
  /** The comparable reading, or null when absent or unparseable. */
  num: number | null;
  /** A short display string in the reader's language (units applied). */
  text: string;
  /** true when the product simply has no value — NEVER a loss (D1). */
  missing: boolean;
  /**
   * The axes of a `dimensions` reading, as typed. Additive, and it exists so no
   * surface re-parses «256 × 256 × 256» to answer the question a buyer with a
   * tall part actually has, which is Z — not litres.
   */
  axes?: number[];
  /** The items of a `list` reading. Additive, for the same reason as `axes`. */
  items?: string[];
}

export interface CompareRow {
  field_id: string;
  label: Trilingual;
  unit: string;
  parse: SpecCompare['parse'];
  better: SpecCompare['better'];
  /** Per product, in the order the caller gave them. */
  values: CompareValue[];
  /** Indexes of the products that win this row. Empty = tie, or not scorable. */
  winners: number[];
  /**
   * Indexes that are beaten on this row. Additive, and NOT simply "everyone who
   * is not a winner": an `Optional` against a `Yes` is a near miss, not a loss,
   * and a cell painted as a defeat while the verdict says otherwise is the kind
   * of contradiction that makes a reader stop believing the page.
   */
  losers?: number[];
  /** This row's pull on the verdict. 0 = shown, never scored (price included). */
  weight?: number;
  /** true when every product answered and the answers differ. */
  decisive: boolean;
}

export interface CompareGroup {
  id: string;
  label: Trilingual;
  shared: boolean;
  rows: CompareRow[];
}

export interface CompareVerdict {
  /** Per product: the weighted share of scorable rows it won, 0..1. */
  scores: number[];
  /** Per product, the field_ids it wins — «فيمَ يتفوق». */
  wins: string[][];
  /** Per product, the field_ids it loses — «وهذه ما لا تتفوق فيه». REQUIRED BY THE OWNER. */
  losses: string[][];
  /** Rows nobody could be scored on because somebody had no value. */
  unscored: string[];
}

export interface CompareAxis {
  field_id: string;
  label: Trilingual;
}

export interface CompareResult {
  basis: CompareBasis;
  /** The section/type the comparison is grounded in, for the one-line caption. */
  basis_label: Trilingual;
  groups: CompareGroup[];
  verdict: CompareVerdict;
  /**
   * Normalised 0..1 per product per axis, for the chart. Only decisive, scorable
   * axes. `series[productIndex][axisIndex]`, aligned with `axes`, and always
   * "further out = better" — the lower-wins axes are inverted here so no legend
   * ever has to contradict the shape the reader is looking at.
   */
  chart: { axes: CompareAxis[]; series: number[][] };
}

export interface CompareInputProduct {
  id: string;
  product_type: string | null;
  section_slugs: string[];
  spec_fields: Record<string, unknown>;
  price_iqd: number;
}

/** A field nobody annotated: shown, read as text, never scored. */
const SHOWN_ONLY: SpecCompare = { parse: 'text', better: 'none' };

/** A radar with more spokes than this is a decoration, not a reading. */
const MAX_AXES = 8;

/** Relative tolerance, so 250 and 250.0000000001 are the tie they really are. */
const EPS = 1e-9;

const PRICE_FIELD_ID = 'price_iqd';

const PRICE_LABEL: Trilingual = { ar: 'السعر', en: 'Price', ckb: 'نرخ' };

const SHARED_LABEL: Trilingual = {
  ar: 'المواصفات المشتركة',
  en: 'Shared specifications',
  ckb: 'تایبەتمەندییە هاوبەشەکان',
};

/** The definitions carry no Kurdish (see the module header), so the four type
 *  names — the only labels this module authors rather than reads — do. */
const TYPE_CKB: Record<ProductTypeId, string> = {
  printer: 'پرینتەری سێ ڕەهەندی',
  parts: 'پارچە و پێداویستی',
  filament: 'فیلامێنت و مادە',
  accessory: 'ئێکسێسوار',
};

type Tech = 'fdm' | 'resin' | 'other' | null;

const TECH_LABEL: Record<'fdm' | 'resin' | 'other', Trilingual> = {
  fdm: { ar: 'FDM', en: 'FDM', ckb: 'FDM' },
  resin: { ar: 'راتنج', en: 'Resin', ckb: 'ڕەزین' },
  other: { ar: '', en: '', ckb: '' },
};

// --------------------------------------------------------------- normalising
//
// EVERY STRING HERE WAS TYPED BY A PERSON, on an Arabic keyboard as often as
// not, into a free-text box. The parsers below therefore fail soft by design:
// they return null far more readily than they return a number, because the cost
// of the two mistakes is not symmetric. An unread value is shown as typed and
// left out of the verdict; a misread one becomes a confident lie in a table a
// customer is using to spend a million dinars.

/**
 * Arabic-Indic (٠-٩) and Eastern Arabic-Indic (۰-۹) digits → ASCII, plus the
 * Arabic decimal and thousands marks and the invisible spaces a paste brings
 * with it. `phone.ts` has the same digit fold, and is deliberately not imported:
 * it pulls libphonenumber-js in behind it, and this module is on the storefront's
 * read path.
 */
export function foldDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
    // The Arabic thousands mark, the no-break space and the direction marks a
    // copy-paste out of a vendor PDF drags in with it.
    .replace(/[٬\u00a0\u202f\u200f\u200e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Units a human appends to a number. The field's OWN unit is tried first and
 * separately: «0.4mm» in a field already labelled mm is the commonest shape in
 * the data, and it must not survive into the display as «0.4 mm mm».
 */
const UNIT_TOKENS = [
  'mm³/s', 'mm3/s', 'mm^3/s', 'mm/s²', 'mm/s2', 'mm/s^2', 'g/cm³', 'g/cm3',
  'months', 'month', 'أشهر', 'شهر', 'inches', 'inch',
  'grams', 'gram', 'watts', 'watt', 'hours', 'hour',
  'µm', 'μm', 'um', 'nm', 'fps', 'rpm', 'ghz', 'mhz', 'khz', 'psi',
  'mm/s', 'mm', 'cm', 'ml', 'kg', 'db', '°c', 'ºc', 'hz', 'kw',
  'in', 'iqd', 'w', 'v', 'a', 'l', 'g', 's',
];

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Drop a trailing unit, repeatedly, and only when a digit is what sits in front
 * of it. That guard is the whole safety of this function: it strips the `s` of
 * «0.5s» and leaves the `s` of «Yes» alone.
 */
function stripUnit(input: string, unit: string): string {
  const tokens = [unit.trim().toLowerCase(), ...UNIT_TOKENS]
    .filter((tk) => tk !== '')
    .sort((a, b) => b.length - a.length);
  let out = input.trim();
  for (let guard = 0; guard < 4; guard += 1) {
    let cut = '';
    for (const tk of tokens) {
      if (out.length > tk.length && out.toLowerCase().endsWith(tk)) {
        const head = out.slice(0, out.length - tk.length).trimEnd();
        if (/\d$/.test(head)) {
          cut = head;
          break;
        }
      }
    }
    if (cut === '') return out;
    out = cut;
  }
  return out;
}

/** The qualifiers people type in front of a number without changing it. */
const LEADING_NOISE = /^(?:up\s*to|upto|max(?:imum)?\.?|min(?:imum)?\.?|about|approx(?:imately)?\.?|around|حتى|لغاية|أقصى|اقصى|حوالي|تقريبا|تقريباً)\s*/i;

/**
 * One number, or null. "up to 500", "500 mm/s", "8.5 kg", "~50", "12 months",
 * "±0.02", "١٢" all read; "0.4 / 0.6 / 0.8", "1920x1080" and "4K" do not —
 * there is more than one number in the first two and no number at all in the
 * third, and inventing 3840 out of "4K" is the guess this module refuses.
 */
export function readNumber(raw: string, unit = ''): number | null {
  let s = foldDigits(raw);
  if (s === '') return null;
  s = s.replace(LEADING_NOISE, '');
  s = s.replace(/^(?:\+\/-|±|~|≈|≃|<|>|≤|≥)\s*/, '');
  s = stripUnit(s, unit);
  const cleaned = s.replace(/[,\s]/g, '');
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export interface DimensionReading {
  axes: number[];
  /** Area for two axes, volume for three — the one number a row can rank on. */
  magnitude: number;
}

/**
 * "256x256x256", "256 × 256 × 256", "220*220*250", "1920x1080" and "1080p".
 *
 * The last shape is the reason `camera_resolution` and `lcd_resolution` are
 * annotated differently from each other: «1080p» is a count of LINES and
 * «1920x1080» is a count of PIXELS, and the two readings are not on one scale.
 * Both are read so both can be DISPLAYED; only the field that is quoted one way
 * consistently is scored.
 */
export function readDimensions(raw: string, unit = ''): DimensionReading | null {
  let s = foldDigits(raw).toLowerCase().replace(/[×✕✖х*·]/g, 'x').replace(/[⌀ø]/g, '');
  s = stripUnit(s, unit);
  const lines = /^(\d{3,5})\s*p$/.exec(s);
  if (lines) {
    const n = Number(lines[1]);
    return { axes: [n], magnitude: n };
  }
  const parts = s.split(/\s*x\s*/).map((p) => p.trim()).filter((p) => p !== '');
  if (parts.length < 2 || parts.length > 3) return null;
  const axes: number[] = [];
  for (const part of parts) {
    const n = readNumber(part, unit);
    if (n === null || !(n > 0)) return null;
    axes.push(n);
  }
  return { axes, magnitude: axes.reduce((a, b) => a * b, 1) };
}

const YES_WORDS = new Set([
  'yes', 'y', 'true', 'supported', 'support', 'available', 'included', 'built-in', 'builtin',
  'standard', 'نعم', 'مدعوم', 'موجود', 'متوفر', 'بەڵێ', 'هەیە',
]);
const OPTIONAL_WORDS = new Set([
  'optional', 'option', 'add-on', 'addon', 'upgrade', 'accessory', 'sold separately',
  'اختياري', 'إختياري', 'يباع منفصلا', 'هەڵبژاردەیی',
]);
const NO_WORDS = new Set([
  'no', 'n', 'false', 'none', 'not supported', 'unsupported', 'not available',
  'not included', '-', '--', 'لا', 'كلا', 'غير مدعوم', 'لا يوجد', 'نەخێر', 'نییە',
]);

/**
 * Yes → 1, Optional → 0.5, No → 0, anything else → null.
 *
 * `N/A` is deliberately absent from all three sets. It means "does not apply",
 * which is not the same statement as "does not have", and reading it as a No
 * would manufacture the loss this module exists to prevent.
 */
export function readBoolean(raw: string): number | null {
  const s = foldDigits(raw).toLowerCase().replace(/[.!؟?]+$/, '').trim();
  if (s === '') return null;
  if (YES_WORDS.has(s)) return 1;
  if (OPTIONAL_WORDS.has(s)) return 0.5;
  if (NO_WORDS.has(s)) return 0;
  return null;
}

/**
 * "PLA, PETG, ABS" and "0.2 / 0.4 / 0.6 / 0.8" are both lists; the separator a
 * person reaches for depends on the field. Duplicates are folded because a count
 * is what gets scored, and "PLA, PLA+" is two materials while "PLA, PLA" is one.
 */
export function readList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of foldDigits(raw).split(/[,،;؛/|\n\r]+/)) {
    const item = piece.trim().replace(/^[-•*]\s*/, '').trim();
    if (item === '' || item === '-') continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export interface RangeReading {
  min: number;
  max: number;
}

/** "0.01 - 0.2", "0.01–0.2", "0.01 to 0.2", "-20 to 60", and a bare number
 *  (a range of one, which is how half the data is actually typed). */
export function readRange(raw: string, unit = ''): RangeReading | null {
  const s = stripUnit(foldDigits(raw).toLowerCase(), unit).replace(/,/g, '');
  const m = /^(-?\d+(?:\.\d+)?)\s*(?:-|–|—|~|\.\.\.?|to|إلى|الى)\s*(-?\d+(?:\.\d+)?)$/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  const single = readNumber(raw, unit);
  return single === null ? null : { min: single, max: single };
}

// ----------------------------------------------------------------- formatting

function formatNumber(n: number): string {
  const rounded = Math.round(n * 1000) / 1000;
  const [whole, fraction] = String(rounded).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
}

/**
 * The unit goes on a QUANTITY and nowhere else. An admin who typed «high» into
 * the flow-rate box gets «high» back, not «high mm³/s» — a unit bolted onto a
 * word reads like a value the module understood, and it understood nothing.
 */
function withUnit(text: string, unit: string): string {
  const t = text.trim();
  const u = unit.trim();
  if (t === '' || u === '') return t;
  if (!/\d$/.test(t)) return t;
  if (new RegExp(`${escapeRe(u)}\\s*$`, 'i').test(t)) return t;
  return `${t} ${u}`;
}

// ------------------------------------------------------------- reading a cell

const fieldLabel = (f: TemplateField): Trilingual => ({
  ar: f.label_ar,
  en: f.label_en,
  ckb: f.label_en,
});

/** spec_fields holds whatever the admin typed; a nested object or a null is
 *  noise, not a value, and is treated as "not filled in". */
function rawOf(spec: Record<string, unknown> | null | undefined, id: string): string {
  const v = spec ? spec[id] : undefined;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return '';
  return String(v).trim();
}

const MISSING_TEXT = '';

/**
 * One product's answer for one field, read the way the field says to read it.
 * Exported because the parse shapes are the part of this module that can be
 * tested exhaustively and cheaply, and a test that has to build a whole
 * comparison to assert on "8.5 kg" tests the wrong thing.
 */
export function readCompareValue(field: TemplateField, raw: string): CompareValue {
  const unit = field.unit ?? '';
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { raw: '', num: null, text: MISSING_TEXT, missing: true };
  }
  const cmp = field.compare ?? SHOWN_ONLY;
  switch (cmp.parse) {
    case 'number': {
      const n = readNumber(trimmed, unit);
      return {
        raw: trimmed,
        num: n,
        text: n === null ? withUnit(trimmed, unit) : withUnit(formatNumber(n), unit),
        missing: false,
      };
    }
    case 'dimensions': {
      const d = readDimensions(trimmed, unit);
      if (!d) return { raw: trimmed, num: null, text: withUnit(trimmed, unit), missing: false };
      return {
        raw: trimmed,
        num: d.magnitude,
        text: withUnit(d.axes.map(formatNumber).join(' × '), unit),
        missing: false,
        axes: d.axes,
      };
    }
    case 'range': {
      const r = readRange(trimmed, unit);
      if (!r) return { raw: trimmed, num: null, text: withUnit(trimmed, unit), missing: false };
      const shown = r.min === r.max
        ? formatNumber(r.min)
        : `${formatNumber(r.min)} – ${formatNumber(r.max)}`;
      // Which END of a range is the comparable reading follows the direction:
      // the finest layer height a machine reaches is its minimum, the widest
      // temperature it tolerates is its maximum.
      const num = cmp.better === 'lower' ? r.min : cmp.better === 'higher' ? r.max : null;
      return { raw: trimmed, num, text: withUnit(shown, unit), missing: false };
    }
    case 'boolean': {
      const n = readBoolean(trimmed);
      // The raw word is kept as the display: the reader's language decides how
      // «Yes» is shown, and that decision belongs to the surface, not here.
      return { raw: trimmed, num: n, text: trimmed, missing: false };
    }
    case 'list': {
      const items = readList(trimmed);
      return {
        raw: trimmed,
        num: items.length > 0 ? items.length : null,
        text: items.length > 0 ? items.join('، ') : withUnit(trimmed, unit),
        missing: false,
        items,
      };
    }
    default:
      return { raw: trimmed, num: null, text: withUnit(trimmed, unit), missing: false };
  }
}

// ------------------------------------------------------------------- scoring

const same = (a: number, b: number): boolean =>
  Math.abs(a - b) <= EPS * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * D1, in one place. A row is only ever ranked when EVERY product answered it and
 * every answer could be read; one blank or one unreadable cell and the row is
 * shown, informative, and scored for nobody.
 */
function rankRow(
  better: SpecCompare['better'],
  parse: SpecCompare['parse'],
  values: CompareValue[]
): { winners: number[]; losers: number[] } {
  // A fresh pair each time: these arrays are handed straight to the response,
  // and one shared empty array behind forty rows is a bug waiting for the first
  // caller that pushes into it.
  const none = () => ({ winners: [] as number[], losers: [] as number[] });
  if (better === 'none' || values.length < 2) return none();
  const nums: number[] = [];
  for (const v of values) {
    if (v.num === null) return none();
    nums.push(v.num);
  }
  const best = better === 'lower' ? Math.min(...nums) : Math.max(...nums);
  if (nums.every((n) => same(n, best))) return none(); // a tie has no winner
  const winners: number[] = [];
  const losers: number[] = [];
  nums.forEach((n, i) => {
    if (same(n, best)) {
      winners.push(i);
      return;
    }
    // «Optional» against a «Yes» is a feature you can buy, not a feature the
    // machine lacks. It does not win the row and it is not recorded as a loss.
    if (parse === 'boolean' && n === 0.5 && best === 1) return;
    losers.push(i);
  });
  return { winners, losers };
}

function readingsDiffer(values: CompareValue[]): boolean {
  if (values.length < 2) return false;
  if (values.every((v) => v.num !== null)) {
    const first = values[0].num as number;
    return values.some((v) => !same(v.num as number, first));
  }
  const keys = new Set(values.map((v) => v.raw.toLowerCase().replace(/\s+/g, ' ')));
  return keys.size > 1;
}

// ------------------------------------------------------- resolving a product

interface Resolved {
  type: ProductTypeId | null;
  /** Field ids this product's own template declares, or null when unknown. */
  declares: Set<string> | null;
  tech: Tech;
}

/**
 * The product's own template, so the comparison can say which groups the two
 * sides genuinely SHARE (D2) rather than printing empty cells that read like
 * failures.
 *
 * `product_type` is trusted when it is set. When it is not, the branch decides —
 * and `productTypeForBranch` is asked twice, once per family, because the two
 * calls differ ONLY in the fallback they return when the branch named nothing.
 * Agreement therefore means the branch really did name a type; disagreement
 * means we are looking at two fallbacks and know nothing.
 */
function resolveProduct(p: CompareInputProduct): Resolved {
  const branch = (p.section_slugs ?? []).map((slug) => ({ id: slug, slug }));
  let type: ProductTypeId | null = null;
  if (isProductType(p.product_type)) {
    type = p.product_type;
  } else {
    const asDevice = productTypeForBranch('devices', branch);
    const asMaterial = productTypeForBranch('materials', branch);
    type = asDevice === asMaterial ? asDevice : null;
  }
  let declares: Set<string> | null = null;
  if (type) {
    declares = new Set<string>();
    for (const g of narrowGroups(type, branch)) for (const f of g.fields) declares.add(f.id);
  }
  return { type, declares, tech: resolveTech(p) };
}

function resolveTech(p: CompareInputProduct): Tech {
  const stated = rawOf(p.spec_fields, 'technology').toLowerCase();
  if (stated !== '') {
    if (stated.includes('fdm') || stated.includes('fff')) return 'fdm';
    if (/resin|msla|sla|dlp|lcd/.test(stated)) return 'resin';
    return 'other';
  }
  // No `technology` recorded: the branch the product is filed in is the other
  // place that statement lives (templateFamilies' printer-technology axis).
  const slugs = (p.section_slugs ?? []).map((s) => s.toLowerCase());
  if (slugs.some((s) => s.includes('fdm'))) return 'fdm';
  if (slugs.some((s) => s.includes('resin'))) return 'resin';
  return null;
}

function basisOf(resolved: Resolved[]): { basis: CompareBasis; basis_label: Trilingual } {
  if (resolved.length === 0) return { basis: 'mixed', basis_label: SHARED_LABEL };
  const first = resolved[0];
  const sameType = first.type !== null && resolved.every((r) => r.type === first.type);
  const sameTech = first.tech !== null && resolved.every((r) => r.tech === first.tech);
  if (!sameType) return { basis: 'mixed', basis_label: SHARED_LABEL };
  const def = productType(first.type as ProductTypeId);
  const typeLabel: Trilingual = {
    ar: def.label_ar,
    en: def.label_en,
    ckb: TYPE_CKB[def.id],
  };
  if (!sameTech) return { basis: 'same_type', basis_label: typeLabel };
  const tech = TECH_LABEL[first.tech as 'fdm' | 'resin' | 'other'];
  const join = (a: string, b: string) => (b === '' ? a : `${a} ${b}`);
  return {
    basis: 'same_section',
    basis_label: {
      ar: join(typeLabel.ar, tech.ar),
      en: join(typeLabel.en, tech.en),
      ckb: join(typeLabel.ckb, tech.ckb),
    },
  };
}

// ------------------------------------------------------------------ the chart

/** Numbers read as quantities before yes/no and before list counts: a radar
 *  made of booleans is a shape with no magnitude in it. */
const AXIS_KIND_RANK: Record<SpecCompare['parse'], number> = {
  number: 0,
  dimensions: 0,
  range: 0,
  boolean: 1,
  list: 2,
  text: 3,
};

/**
 * Normalise one axis so "further out = better" is true without exception.
 *
 * RATIO, not min-max. With two products min-max always paints one at the centre
 * and the other at the rim, so a 3% difference and a 300% difference draw the
 * same picture — the one thing a chart must never do. Ratios keep the magnitude:
 * 480 against 500 reads as 0.96.
 */
function normaliseAxis(nums: number[], better: SpecCompare['better'], parse: SpecCompare['parse']): number[] {
  if (parse === 'boolean') return nums.map((n) => clamp01(n));
  const max = Math.max(...nums);
  const min = Math.min(...nums);
  if (min > 0 && max > 0) {
    return better === 'lower' ? nums.map((n) => clamp01(min / n)) : nums.map((n) => clamp01(n / max));
  }
  // Zero or negative readings (a temperature range, a 0 dB typo) have no
  // meaningful ratio; fall back to the span, which is still ordered correctly.
  const span = max - min;
  if (span <= 0) return nums.map(() => 1);
  return nums.map((n) => clamp01(better === 'lower' ? (max - n) / span : (n - min) / span));
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

// -------------------------------------------------------------------- public

/**
 * THE WHOLE COMPARISON. Pure: same products in, same result out, no D1 and no
 * clock, which is what makes tests/compareSpecs.test.ts able to cover it
 * exhaustively.
 */
export function compareProducts(input: { products: CompareInputProduct[] }): CompareResult {
  const products = input.products ?? [];
  const n = products.length;
  const resolved = products.map(resolveProduct);
  const { basis, basis_label } = basisOf(resolved);

  const groups: CompareGroup[] = [];

  // PRICE FIRST, AND OUTSIDE THE SCORE (D3). Its own group, so the page and the
  // assistant render one row from one set of numbers; weight 0, so it can never
  // become the verdict. The IQD and per-cent difference the page prints is
  // `values[i].num` against the cheapest — derivable, and deliberately not
  // frozen into a second field that could disagree with the row.
  if (n > 0) {
    const priceValues: CompareValue[] = products.map((p) => {
      const iqd = Number(p.price_iqd);
      if (!Number.isFinite(iqd) || iqd <= 0) {
        return { raw: '', num: null, text: MISSING_TEXT, missing: true };
      }
      return { raw: String(iqd), num: iqd, text: `${formatNumber(iqd)} IQD`, missing: false };
    });
    const ranked = rankRow('lower', 'number', priceValues);
    groups.push({
      id: 'price',
      label: PRICE_LABEL,
      shared: true,
      rows: [{
        field_id: PRICE_FIELD_ID,
        label: PRICE_LABEL,
        unit: 'IQD',
        parse: 'number',
        better: 'lower',
        values: priceValues,
        winners: ranked.winners,
        losers: ranked.losers,
        weight: 0,
        decisive: priceValues.every((v) => !v.missing) && readingsDiffer(priceValues),
      }],
    });
  }

  // The SAME walk specGroupsFromFields makes — every group of both families in
  // definition order, a field id claimed by the first group that declares it —
  // so a row sits where the product page already taught the reader to look for
  // it, and an id that moved between families cannot appear twice.
  const claimed = new Set<string>();
  for (const g of allTemplateGroups()) {
    const rows: CompareRow[] = [];
    for (const f of g.fields) {
      if (claimed.has(f.id)) continue;
      const raws = products.map((p) => rawOf(p.spec_fields, f.id));
      // A row nobody filled teaches nothing; it is not shown as two «غير مذكور».
      if (raws.every((r) => r === '')) continue;
      claimed.add(f.id);
      const cmp = f.compare ?? SHOWN_ONLY;
      const values = raws.map((raw) => readCompareValue(f, raw));
      const { winners, losers } = rankRow(cmp.better, cmp.parse, values);
      const weight = cmp.better === 'none' ? 0 : cmp.weight ?? 0;
      rows.push({
        field_id: f.id,
        label: fieldLabel(f),
        unit: f.unit ?? '',
        parse: cmp.parse,
        better: cmp.better,
        values,
        winners,
        losers,
        weight,
        decisive: values.every((v) => !v.missing) && readingsDiffer(values),
      });
    }
    if (rows.length === 0) continue;
    // SHARED means both sides were ASKED these questions, not that both
    // answered them (D2). An FDM machine against a resin one keeps its own
    // group, labelled as its own — never a column of blanks that reads as a
    // column of failures.
    const shared = resolved.every((r, i) =>
      r.declares
        ? rows.some((row) => (r.declares as Set<string>).has(row.field_id))
        : rows.some((row) => !row.values[i].missing));
    groups.push({
      id: g.id,
      label: { ar: g.label_ar, en: g.label_en, ckb: g.label_en },
      shared,
      rows,
    });
  }

  // ------------------------------------------------------------- the verdict
  const allRows = groups.flatMap((grp) => grp.rows);
  const scored = allRows.filter((r) => (r.weight ?? 0) > 0 && r.better !== 'none');
  const unscored = scored.filter((r) => r.values.some((v) => v.num === null)).map((r) => r.field_id);
  // A tie separates nobody, so it belongs in neither half of the fraction — the
  // same reasoning as D1. Two identical machines score 0 and 0, and the page
  // says «متعادلتان» instead of inventing a winner out of rounding.
  const decisiveScored = scored.filter((r) => r.winners.length > 0);
  const denominator = decisiveScored.reduce((sum, r) => sum + (r.weight ?? 0), 0);

  const scores = new Array<number>(n).fill(0);
  const wins: string[][] = Array.from({ length: n }, () => []);
  const losses: string[][] = Array.from({ length: n }, () => []);
  for (const row of decisiveScored) {
    const w = row.weight ?? 0;
    // A shared first place splits the row rather than handing it to both, so the
    // scores stay shares of one whole.
    const share = w / row.winners.length;
    for (const i of row.winners) {
      scores[i] += share;
      wins[i].push(row.field_id);
    }
    for (const i of row.losers ?? []) losses[i].push(row.field_id);
  }
  if (denominator > 0) for (let i = 0; i < n; i += 1) scores[i] = scores[i] / denominator;

  // --------------------------------------------------------------- the chart
  const axisRows = scored
    .filter((r) => r.decisive && r.values.every((v) => v.num !== null))
    .map((r) => {
      const nums = r.values.map((v) => v.num as number);
      const max = Math.max(...nums);
      const min = Math.min(...nums);
      const spread = max > 0 ? (max - min) / max : 0;
      return { row: r, spread };
    })
    .sort((a, b) =>
      (b.row.weight ?? 0) - (a.row.weight ?? 0) ||
      AXIS_KIND_RANK[a.row.parse] - AXIS_KIND_RANK[b.row.parse] ||
      b.spread - a.spread)
    .slice(0, MAX_AXES);

  const axes: CompareAxis[] = axisRows.map(({ row }) => ({ field_id: row.field_id, label: row.label }));
  const series: number[][] = Array.from({ length: n }, () => []);
  for (const { row } of axisRows) {
    const normalised = normaliseAxis(row.values.map((v) => v.num as number), row.better, row.parse);
    normalised.forEach((v, i) => series[i].push(v));
  }

  return {
    basis,
    basis_label,
    groups,
    verdict: { scores, wins, losses, unscored },
    chart: { axes, series },
  };
}
