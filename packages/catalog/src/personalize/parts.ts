/**
 * PARTS AS STORE PRODUCTS — «يُستخدم داخل منتجات مطبوعة» (Programme C, phase
 * C1; docs/LEVO_PROJECT_PROGRAMME.md §B.3 and §0 row 7).
 *
 * ONE READER FOR BOTH CATALOGUES. A Levonis item's `printed_part` spec group
 * (worker/lib/templateFamilies.ts, stored in `products.spec_fields`) and a
 * merchant part's `community_products.part_spec` are the same flat map of
 * strings:
 *
 *   printed_use  part_kind  part_shape  diameter_mm  length_mm  width_mm
 *   height_mm  voltage  power_w  install_type  install_minutes  fits_family
 *   uses  source  variant_specs
 *
 * `variant_specs` follows the worker/lib/multicolor.ts precedent — one line
 * per option, keyed by the option's id: «ov_6x3: diameter_mm=6, height_mm=3».
 * `source` is `levonis:<products.id>#<option key>`, written by the server on
 * «From Levonis» and never by a client.
 *
 * DERIVED, NEVER INVENTED. A number is a finite positive number under a sane
 * cap or it is absent; an unknown kind is not a part (null); a variant line
 * whose id is not one of the product's option values is dropped. The one
 * default is the kind `other` for a Levonis item marked `printed_use = Yes`
 * with no kind chosen — «other» is what the admin form offers for «not said».
 *
 * Pure (the engine rule): no I/O, no DOM, no clock, no randomness. Lean: this
 * file counts against the personalize engine's 8 KB gzip budget.
 */

export const PART_KINDS = ['magnet', 'motor', 'led', 'nfc', 'screw', 'bearing', 'switch', 'module', 'insert', 'keyring', 'hook', 'cable', 'battery', 'other'] as const;
export type PartKind = (typeof PART_KINDS)[number];
export type PartShape = 'round' | 'square' | 'rect' | 'ring' | 'strip' | 'other';
export interface PartDims { shape?: PartShape; diameter_mm?: number; length_mm?: number; width_mm?: number; height_mm?: number; voltage?: number; power_w?: number; install?: string; install_minutes?: number }
export interface PartSpec extends PartDims { kind: PartKind; fits?: string[]; uses?: string[]; source?: string; variants?: Record<string, PartDims> }

export const PART_SHAPES: readonly PartShape[] = ['round', 'square', 'rect', 'ring', 'strip', 'other'];

type NumKey = 'diameter_mm' | 'length_mm' | 'width_mm' | 'height_mm' | 'voltage' | 'power_w' | 'install_minutes';

/** The numeric facts and their caps: millimetres ≤ 10 m, ≤ 400 V, ≤ 5 kW, ≤ a day of fitting. */
const CAPS: readonly (readonly [NumKey, number])[] = [
  ['diameter_mm', 1e4], ['length_mm', 1e4], ['width_mm', 1e4], ['height_mm', 1e4],
  ['voltage', 400], ['power_w', 5000], ['install_minutes', 1440],
];

const str = (v: unknown, max = 80): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : '';

/** Arabic-Indic and Persian digits fold to ASCII (U+0660.. and U+06F0.. both end in the digit's value). */
const fold = (s: string): string => s.replace(/[٠-٩۰-۹]/g, (d) => String(d.charCodeAt(0) & 15)).replace('٫', '.');

/** A number, optionally followed by its unit («6», «6 mm», «12V», «٣٫٧ فولت») — never a range, never a guess. */
function num(v: unknown, cap: number): number | undefined {
  let n = NaN;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string') {
    const m = /^\s*(\d+(?:\.\d+)?)\s*[^\d]{0,8}$/.exec(fold(v));
    if (m) n = Number(m[1]);
  }
  return Number.isFinite(n) && n > 0 && n <= cap ? n : undefined;
}

const clean = (s: string): string => s.replace(/[,;=:\n\r،؛]+/g, ' ').trim();

function dims(m: Record<string, unknown>): PartDims {
  const d: PartDims = {};
  const shape = str(m.part_shape).toLowerCase();
  const s = shape ? PART_SHAPES.find((x) => shape.startsWith(x)) : undefined;
  if (s) d.shape = s;
  for (const [k, cap] of CAPS) {
    const n = num(m[k], cap);
    if (n !== undefined) d[k] = n;
  }
  const install = clean(str(m.install_type, 60));
  if (install) d.install = install;
  return d;
}

function list(v: unknown): string[] | undefined {
  const raw: unknown[] = Array.isArray(v) ? v : str(v, 600).split(/[,،;؛\n]/);
  const out = [...new Set(raw.map((x) => clean(str(x, 40))).filter(Boolean))].slice(0, 12);
  return out.length ? out : undefined;
}

/** `variant_specs` lines → {option id: dims}; with `ids`, only those ids (matched case-insensitively, returned as given). */
function lines(text: unknown, ids?: readonly string[]): Record<string, PartDims> | undefined {
  const out: Record<string, PartDims> = {};
  for (const line of str(text, 4000).split(/\r?\n/)) {
    const m = /^\s*([^:=\s][^:=]{0,79}?)\s*:\s*(.+)$/.exec(line);
    if (!m) continue;
    const id = ids ? ids.find((x) => x.toLowerCase() === m[1].toLowerCase()) : m[1];
    if (!id) continue;
    const f: Record<string, string> = {};
    for (const pair of m[2].split(/[,;،؛]/)) {
      const kv = /^\s*([a-z_]+)\s*=\s*(.+?)\s*$/i.exec(pair);
      if (kv) f[kv[1].toLowerCase()] = kv[2];
    }
    const d = dims(f);
    if (Object.keys(d).length) out[id] = { ...out[id], ...d };
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * The typed part, or null when the map does not describe one. Accepts the
 * stored JSON text as well as the parsed map; `optionValueIds` limits the
 * variant lines to the product's own option values.
 */
export function readPartSpec(map: unknown, optionValueIds?: readonly string[]): PartSpec | null {
  let m = map;
  if (typeof m === 'string') {
    try {
      m = JSON.parse(m);
    } catch {
      return null;
    }
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const r = m as Record<string, unknown>;
  const use = r.printed_use === true ? 'yes' : str(r.printed_use).toLowerCase();
  if (use && use !== 'yes') return null;
  const k = str(r.part_kind).toLowerCase().replace(/[\s_-]/g, '');
  const kind = k ? PART_KINDS.find((x) => x === k) : use ? 'other' : undefined;
  if (!kind) return null;
  const spec: PartSpec = { kind, ...dims(r) };
  const fits = list(r.fits_family);
  if (fits) spec.fits = fits;
  const uses = list(r.uses);
  if (uses) spec.uses = uses;
  const source = str(r.source, 200);
  if (/^levonis:[^\s#]{1,80}(#\S{0,80})?$/.test(source)) spec.source = source;
  const variants = lines(r.variant_specs, optionValueIds);
  if (variants) spec.variants = variants;
  return spec;
}

function dimsToMap(d: PartDims): Record<string, string> {
  const o: Record<string, string> = {};
  if (d.shape) o.part_shape = d.shape;
  for (const [k] of CAPS) if (d[k] !== undefined) o[k] = String(d[k]);
  if (d.install) o.install_type = clean(d.install);
  return o;
}

/** The flat map a part is stored as — `readPartSpec(partSpecToMap(s))` gives `s` back. */
export function partSpecToMap(spec: PartSpec): Record<string, string> {
  const out: Record<string, string> = { printed_use: 'Yes', part_kind: spec.kind, ...dimsToMap(spec) };
  if (spec.fits?.length) out.fits_family = spec.fits.map(clean).join(', ');
  if (spec.uses?.length) out.uses = spec.uses.map(clean).join(', ');
  if (spec.source) out.source = spec.source;
  const v = Object.entries(spec.variants ?? {})
    .map(([id, d]) => [id, Object.entries(dimsToMap(d)).map(([k, x]) => `${k}=${x}`).join(', ')])
    .filter(([id, x]) => x && !/[:=\n]/.test(id))
    .map(([id, x]) => `${id}: ${x}`);
  if (v.length) out.variant_specs = v.join('\n');
  return out;
}

/** The part as ONE option value names it: the product's facts with that value's line over them. */
export function partDims(spec: PartSpec, variant?: string | null): PartSpec {
  const line = variant ? spec.variants?.[variant] : undefined;
  return line ? { ...spec, ...line } : spec;
}

/* The words, in PART_KINDS / PART_SHAPES order. Arabic adjectives follow the
   noun and agree with it (a first word ending in ة is feminine); Sorani joins
   the shape with the ezafe after the first word («گڵۆپی شریتی LED»). */
const WORDS = {
  ar: ['مغناطيس|محرك|ضوء LED|شريحة NFC|برغي|محمل|مفتاح تشغيل|وحدة إلكترونية|حشوة معدنية|حلقة مفاتيح|خطاف|كابل|بطارية|قطعة', 'دائري|مربع|مستطيل|حلقي|شريطي|', 'مم|فولت|واط'],
  en: ['Magnet|Motor|LED|NFC tag|Screw|Bearing|Switch|Module|Insert|Key ring|Hook|Cable|Battery|Part', 'Round|Square|Rectangular|Ring|Strip|', 'mm|V|W'],
  ckb: ['موگناتیس|مۆتۆڕ|گڵۆپی LED|چیپی NFC|بورغی|بێرینگ|سویچ|مۆدیوڵ|ئینسێرتی کانزایی|ئەڵقەی کلیل|قولاپ|کێبڵ|پاتری|پارچە', 'خڕ|چوارگۆشە|لاکێشە|ئەڵقە|شریت|', 'ملم|ڤۆڵت|وات'],
} as const;

export type PartLang = keyof typeof WORDS;

/** One kind's name alone («مغناطيس» · «Magnet» · «موگناتیس»). */
export function partKindWord(kind: PartKind, lang: PartLang): string {
  return WORDS[lang][0].split('|')[PART_KINDS.indexOf(kind)] ?? '';
}

/** One shape's word alone («دائري» · «Round» · «خڕ»); '' for `other`. */
export function partShapeWord(shape: PartShape, lang: PartLang): string {
  return WORDS[lang][1].split('|')[PART_SHAPES.indexOf(shape)] ?? '';
}

/**
 * The part in one short line: «مغناطيس دائري ٦ × ٣ مم», «Round magnet 6 × 3 mm»,
 * «موگناتیسی خڕ ٦ × ٣ ملم». Round parts read diameter × height (or length);
 * others length × width × height; then volts and watts when stated.
 */
export function partSpecWords(spec: PartSpec, lang: PartLang, variant?: string | null): string {
  const d = partDims(spec, variant);
  const [, , u] = WORDS[lang];
  const [mm, volt, watt] = u.split('|');
  const kind = partKindWord(d.kind, lang);
  const shape = d.shape ? partShapeWord(d.shape, lang) : '';
  const n = (x: number) => (lang === 'en' ? String(x) : String(x).replace(/\d/g, (c) => '٠١٢٣٤٥٦٧٨٩'[+c]).replace('.', '٫'));
  let head = kind;
  if (shape) {
    if (lang === 'en') head = `${shape} ${/^[A-Z][a-z]/.test(kind) ? kind[0].toLowerCase() + kind.slice(1) : kind}`;
    else if (lang === 'ar') head = `${kind} ${shape}${/ة$/.test(kind.split(' ')[0]) ? 'ة' : ''}`;
    else {
      const i = kind.indexOf(' ');
      head = i < 0 ? `${kind}ی ${shape}` : `${kind.slice(0, i)} ${shape}ی${kind.slice(i)}`;
    }
  }
  const size = (d.diameter_mm ? [d.diameter_mm, d.height_mm ?? d.length_mm] : [d.length_mm, d.width_mm, d.height_mm]).filter(
    (x): x is number => x !== undefined
  );
  return [
    head,
    size.length ? `${size.map(n).join(' × ')} ${mm}` : '',
    d.voltage ? `${n(d.voltage)} ${volt}` : '',
    d.power_w ? `${n(d.power_w)} ${watt}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** A slot's `accepts`: a value must equal (± 0.05) a number, or fall inside {min, max}. */
export type PartRange = number | { min?: number; max?: number };
export interface PartAccepts {
  kind?: PartKind | readonly PartKind[];
  shape?: PartShape | readonly PartShape[];
  diameter_mm?: PartRange;
  voltage?: PartRange;
}

const oneOf = (want: unknown, v: unknown): boolean => want === undefined || ([] as unknown[]).concat(want).includes(v);

function within(r: PartRange | undefined, v: number | undefined): boolean {
  if (r === undefined) return true;
  if (v === undefined) return false;
  if (typeof r === 'number') return Math.abs(r - v) <= 0.05;
  return (r.min === undefined || v >= r.min - 0.05) && (r.max === undefined || v <= r.max + 0.05);
}

/**
 * Whether a part (as one option value names it) goes into a slot. A fact the
 * slot asks about and the part does not state is a «no»: a fit is proven, not
 * assumed.
 */
export function fitsSlot(spec: PartSpec | null | undefined, accepts?: PartAccepts | null, variant?: string | null): boolean {
  if (!spec) return false;
  if (!accepts) return true;
  const d = partDims(spec, variant);
  return oneOf(accepts.kind, d.kind) && oneOf(accepts.shape, d.shape) && within(accepts.diameter_mm, d.diameter_mm) && within(accepts.voltage, d.voltage);
}
