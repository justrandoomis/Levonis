/**
 * «الطباعة بأكثر من لون» — WHAT A PRINTER CAN ACTUALLY DO WITH COLOUR, AND
 * WHAT EACH WAY OF BUYING IT CHANGES.
 *
 * «يظهر بعض المقارنات غير صحيحة خاصة للأجهزة التي يمكنها الطباعة بأكثر من لون
 *  بدون خسارة بالفلامنت مثل snapmaker u1 و h2c بسبعة ألوان و x2d بلونين لكنه
 *  لون ثنائي … كما أن الخيار نفسه يفرق من حيث أن الطابعة بدون ams بدون كومبو
 *  أو مع ams يختلف كذلك يختلف عن التي فيها ليزر.»
 *
 * The comparison and the finder used to read ONE number — `max_colors` — and
 * rank on it. That number is the ceiling WITH every AMS unit the machine can
 * take, so an X2D (25) beat a Snapmaker U1 (4) on «تعدد الألوان» although the
 * U1 prints its four colours from four independent toolheads with almost no
 * purge, and the X2D's 25 are one nozzle's worth of filament swaps. Both are
 * true; they answer different questions, and a buyer who wants «few colours,
 * no waste» was being told the opposite of the truth.
 *
 * So colour is modelled as FIVE facts, each an ordinary spec field of the
 * printer template (worker/lib/templateFamilies.ts, «خاص بطابعات FDM») so the
 * admin fills them in the same form, the import template carries them, and the
 * comparison renders them without a line of code here:
 *
 *   multicolor_method   none | ams_single_nozzle | dual_nozzle | tool_changer | multi_nozzle
 *   max_colors_native   colours printed WITHOUT swapping filament in one nozzle
 *   max_colors          (existing) the ceiling with every AMS / expansion unit
 *   purge_waste         near_zero | low | high — within the native colours
 *   multi_material      two materials in one print without the swap compromise
 *
 * A VARIANT IS A DIFFERENT MACHINE. The bare printer, the Combo with an AMS in
 * the box and the Laser Full Combo differ in price AND in what they do out of
 * the box. The differences live in ONE allow-listed multiline spec field,
 * `variant_specs`, one line per option:
 *
 *     a1-combo: ams_units_included=1, colors_out_of_box=4
 *     h2d-laser-full-combo-10w: ams_units_included=1, laser_module_power=10, cutting_module=Yes
 *
 * keyed by the option's `variant_key` (or its id). Weight and footprint come
 * from the option row's own physical overrides (0099), which the admin already
 * edits per option. Nothing here reads a product NAME: a fact that is not on
 * the sheet is not a fact.
 *
 * DERIVED, NEVER INVENTED. Where the sheet is silent, exactly one conclusion is
 * drawn, because it is physics rather than a spec: a machine with ONE extruder
 * that prints more than one colour does it by swapping filament in that one
 * nozzle, which purges. Everything else — a dual nozzle's waste, a tool
 * changer's native count — must be stated, and stays unknown until it is.
 */
import { foldDigits, readBoolean, readNumber } from './compareSpecs';

export type MulticolorMethod = 'none' | 'ams_single_nozzle' | 'dual_nozzle' | 'tool_changer' | 'multi_nozzle';
export type PurgeWaste = 'near_zero' | 'low' | 'high';

/** The template's option strings, in the order the admin form offers them. */
export const MULTICOLOR_METHOD_OPTIONS = [
  'None',
  'Single nozzle + AMS',
  'Dual nozzle',
  'Tool changer',
  'Multi-nozzle (hotend changer)',
] as const;

/** Least waste first — the ordinal scale the comparison ranks `purge_waste` on (lower wins). */
export const PURGE_WASTE_OPTIONS = ['Near zero', 'Low', 'High'] as const;

const METHOD_BY_WORD: Record<string, MulticolorMethod> = {
  none: 'none',
  'single colour': 'none',
  'single color': 'none',
  'single nozzle + ams': 'ams_single_nozzle',
  ams_single_nozzle: 'ams_single_nozzle',
  'ams single nozzle': 'ams_single_nozzle',
  'single nozzle': 'ams_single_nozzle',
  'dual nozzle': 'dual_nozzle',
  dual_nozzle: 'dual_nozzle',
  'tool changer': 'tool_changer',
  tool_changer: 'tool_changer',
  toolchanger: 'tool_changer',
  'multi-nozzle (hotend changer)': 'multi_nozzle',
  'multi-nozzle': 'multi_nozzle',
  'multi nozzle': 'multi_nozzle',
  multi_nozzle: 'multi_nozzle',
  'hotend changer': 'multi_nozzle',
};

const WASTE_BY_WORD: Record<string, PurgeWaste> = {
  'near zero': 'near_zero',
  near_zero: 'near_zero',
  'near-zero': 'near_zero',
  none: 'near_zero',
  low: 'low',
  high: 'high',
};

const raw = (specs: Record<string, unknown> | null | undefined, id: string): string => {
  const v = specs ? specs[id] : undefined;
  if (v === null || v === undefined || typeof v === 'object') return '';
  return String(v).trim();
};

export function readMethod(text: string): MulticolorMethod | null {
  return METHOD_BY_WORD[foldDigits(text).toLowerCase()] ?? null;
}

export function readWaste(text: string): PurgeWaste | null {
  return WASTE_BY_WORD[foldDigits(text).toLowerCase()] ?? null;
}

/** The stored option string for a method — what a derived value is written as. */
export function methodLabel(m: MulticolorMethod): string {
  switch (m) {
    case 'none':
      return 'None';
    case 'ams_single_nozzle':
      return 'Single nozzle + AMS';
    case 'dual_nozzle':
      return 'Dual nozzle';
    case 'tool_changer':
      return 'Tool changer';
    default:
      return 'Multi-nozzle (hotend changer)';
  }
}

export function wasteLabel(w: PurgeWaste): string {
  return w === 'near_zero' ? 'Near zero' : w === 'low' ? 'Low' : 'High';
}

/**
 * One printer's colour capability, as ONE CONFIGURATION is sold. `null` on any
 * field means the sheet does not say and nothing could be derived — the page
 * prints «غير مذكور», the finder scores it 0, and nobody is told a guess.
 */
export interface MulticolorProfile {
  method: MulticolorMethod | null;
  /** Colours printed without swapping filament through one nozzle. */
  native: number | null;
  /** The ceiling with every AMS / expansion unit the machine accepts. */
  with_ams: number | null;
  /** Purge waste within the native colours (for a single nozzle: any colour change). */
  waste: PurgeWaste | null;
  multi_material: boolean | null;
  /** Colours this configuration prints as bought, with nothing else bought. */
  out_of_box: number | null;
  /** AMS units in the box for this configuration. */
  ams_units: number | null;
  /** Which of the fields above were derived rather than stated. */
  derived: Array<'method' | 'native' | 'waste' | 'out_of_box'>;
}

const count = (specs: Record<string, unknown>, id: string): number | null => {
  const r = raw(specs, id);
  if (r === '') return null;
  const n = readNumber(r);
  return n !== null && n >= 0 ? n : null;
};

/**
 * The profile of one sheet — the product's, or a variant's after
 * `variantSheet`. Pure and total: any input, including `{}`, returns a profile.
 */
export function multicolorProfile(specs: Record<string, unknown> | null | undefined): MulticolorProfile {
  const s = specs ?? {};
  const derived: MulticolorProfile['derived'] = [];
  const extruders = count(s, 'extruders');
  const withAms = count(s, 'max_colors');
  let method = readMethod(raw(s, 'multicolor_method'));
  let native = count(s, 'max_colors_native');
  let waste = readWaste(raw(s, 'purge_waste'));
  const mm = raw(s, 'multi_material');
  const multiMaterial = mm === '' ? null : readBoolean(mm) === null ? null : readBoolean(mm) === 1;
  const amsUnits = count(s, 'ams_units_included');
  let outOfBox = count(s, 'colors_out_of_box');

  // THE ONE DERIVATION: one extruder, more than one colour ⇒ filament swaps
  // through that nozzle, which purges. One extruder and one colour ⇒ none.
  if (method === null && extruders === 1 && withAms !== null) {
    method = withAms > 1 ? 'ams_single_nozzle' : 'none';
    derived.push('method');
  }
  if (method === 'ams_single_nozzle' || method === 'none') {
    if (native === null) {
      native = 1;
      derived.push('native');
    }
    if (waste === null && method === 'ams_single_nozzle') {
      waste = 'high';
      derived.push('waste');
    }
    // No AMS in the box ⇒ one colour as bought. A unit in the box is NOT
    // turned into a slot count here: slots per unit is a fact about that unit.
    if (outOfBox === null && amsUnits === 0) {
      outOfBox = 1;
      derived.push('out_of_box');
    }
  }
  // Several heads and NO AMS in the box ⇒ each head is fed from its own spool,
  // so the configuration prints its native colours as bought (H2D: «the second
  // hotend able to use an external spool»). With an AMS in the box the count
  // depends on how that unit is wired to the heads, which is stated, not derived.
  const multiHead = method === 'dual_nozzle' || method === 'tool_changer' || method === 'multi_nozzle';
  if (multiHead && outOfBox === null && amsUnits === 0 && native !== null) {
    outOfBox = native;
    derived.push('out_of_box');
  }
  if (method === 'none' && outOfBox === null) {
    outOfBox = 1;
    derived.push('out_of_box');
  }
  return {
    method,
    native,
    with_ams: withAms,
    waste,
    multi_material: multiMaterial,
    out_of_box: outOfBox,
    ams_units: amsUnits,
    derived,
  };
}

/**
 * The derived fields written INTO a sheet, so the comparison table and the
 * finder's quoted reasons can show them through the ordinary field path. Only
 * what `multicolorProfile` derived is added; a stated value is never touched.
 */
export function withDerivedMulticolor(specs: Record<string, unknown>): Record<string, unknown> {
  const p = multicolorProfile(specs);
  if (p.derived.length === 0) return specs;
  const out: Record<string, unknown> = { ...specs };
  if (p.derived.includes('method') && p.method) out.multicolor_method = methodLabel(p.method);
  if (p.derived.includes('native') && p.native !== null) out.max_colors_native = String(p.native);
  if (p.derived.includes('waste') && p.waste) out.purge_waste = wasteLabel(p.waste);
  if (p.derived.includes('out_of_box') && p.out_of_box !== null) out.colors_out_of_box = String(p.out_of_box);
  return out;
}

// ------------------------------------------------------------------ variants

/**
 * The fields a variant line may set. Deliberately short: these are the facts
 * that genuinely change between «بدون AMS», «كومبو» and «ليزر». Anything else
 * on a line is ignored, so a typo cannot overwrite the product's build volume.
 */
export const VARIANT_SPEC_FIELDS = [
  'ams_units_included',
  'colors_out_of_box',
  'laser_module_power',
  'cutting_module',
] as const;
export type VariantSpecField = (typeof VARIANT_SPEC_FIELDS)[number];

const ALLOWED = new Set<string>(VARIANT_SPEC_FIELDS);

/**
 * `variant_specs` as a map: variant key → { field: value }. Lenient by design —
 * it parses what an admin actually types (Arabic digits, `=` or `:`, commas or
 * semicolons, blank lines) and drops anything it does not recognise.
 */
export function parseVariantSpecs(text: unknown): Map<string, Partial<Record<VariantSpecField, string>>> {
  const out = new Map<string, Partial<Record<VariantSpecField, string>>>();
  if (typeof text !== 'string' || text.trim() === '') return out;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([^:]{1,80}?)\s*:\s*(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    if (!key) continue;
    const fields: Partial<Record<VariantSpecField, string>> = out.get(key) ?? {};
    for (const pair of m[2].split(/[,;،؛]/)) {
      const kv = /^\s*([a-z_]+)\s*[=:]\s*(.+?)\s*$/i.exec(foldDigits(pair));
      if (!kv) continue;
      const field = kv[1].toLowerCase();
      if (!ALLOWED.has(field)) continue;
      fields[field as VariantSpecField] = kv[2].slice(0, 80);
    }
    if (Object.keys(fields).length) out.set(key, fields);
  }
  return out;
}

/** The option as this module needs it — id, key and the 0099 physical overrides. */
export interface VariantOption {
  id: string;
  variant_key?: string | null;
  net_weight_g?: number | null;
  width_mm?: number | null;
  depth_mm?: number | null;
  height_mm?: number | null;
}

/**
 * The spec sheet of ONE CONFIGURATION: the product's sheet, then the variant's
 * allow-listed line, then the option's own weight and footprint when the admin
 * set them. `variant_specs` itself is removed — it is an instruction, not a
 * spec, and must never reach a table. Then the one multicolour derivation.
 *
 * `option = null` is the product as a whole (a product with no options).
 */
export function variantSheet(product: Record<string, unknown>, option: VariantOption | null): Record<string, unknown> {
  const sheet: Record<string, unknown> = { ...product };
  delete sheet.variant_specs;
  if (option) {
    const lines = parseVariantSpecs(product.variant_specs);
    const line = lines.get(String(option.variant_key ?? '').toLowerCase()) ?? lines.get(option.id.toLowerCase());
    if (line) for (const [k, v] of Object.entries(line)) if (v !== undefined) sheet[k] = v;
    // «يختلف عن التي فيها ليزر». When the admin states the laser per option,
    // `has_laser_module` (a product-level «sold with a laser option») becomes
    // a fact about THIS configuration: the Laser Full Combo has one, the
    // Combo beside it does not.
    const laserPerOption = [...lines.values()].some((l) => l.laser_module_power !== undefined);
    if (laserPerOption) {
      const w = readNumber(String(line?.laser_module_power ?? ''), 'W');
      sheet.has_laser_module = w !== null && w > 0 ? 'Yes' : 'No';
      if (!(w !== null && w > 0)) delete sheet.laser_module_power;
    }
    const g = Number(option.net_weight_g);
    if (option.net_weight_g !== null && option.net_weight_g !== undefined && Number.isFinite(g) && g > 0) {
      sheet.weight = String(Math.round(g) / 1000);
    }
    const dims = [option.width_mm, option.depth_mm, option.height_mm].map((v) => Number(v));
    if (
      [option.width_mm, option.depth_mm, option.height_mm].every((v) => v !== null && v !== undefined) &&
      dims.every((v) => Number.isFinite(v) && v > 0)
    ) {
      sheet.dimensions = dims.join(' × ');
    }
  }
  return withDerivedMulticolor(sheet);
}

// --------------------------------------------------------- what the page shows

/**
 * The badge a column or a finder card wears, as CODES (the client writes the
 * words). Ordered by what a buyer asks first: how many colours with no waste,
 * then the ceiling with AMS and its cost in purge.
 */
export interface MulticolorBadge {
  kind: 'native' | 'ams' | 'single' | 'unknown';
  /** native: colours without swaps; ams: the AMS ceiling. */
  colors: number | null;
  waste: PurgeWaste | null;
  method: MulticolorMethod | null;
  /** The AMS ceiling, shown after a native claim («… وحتى 25 مع AMS»). */
  with_ams: number | null;
  out_of_box: number | null;
}

export function multicolorBadge(p: MulticolorProfile): MulticolorBadge {
  const base = { method: p.method, with_ams: p.with_ams, out_of_box: p.out_of_box, waste: p.waste };
  if (p.method === 'tool_changer' || p.method === 'multi_nozzle' || p.method === 'dual_nozzle') {
    return { kind: 'native', colors: p.native, ...base };
  }
  if (p.method === 'ams_single_nozzle') return { kind: 'ams', colors: p.with_ams, ...base };
  if (p.method === 'none') return { kind: 'single', colors: 1, ...base };
  return { kind: 'unknown', colors: p.with_ams, ...base };
}

/**
 * How well a machine meets a stated colour NEED, 0..1, from the profile only.
 *
 *   few   «ألوان قليلة بلا هدر» — native colours (capped at four, the need)
 *         and low waste lead; the AMS ceiling barely counts.
 *   many  «ألوان كثيرة» — the ceiling leads; waste and native still count.
 *   null  no stated need — a balance of the three.
 *
 * A missing part contributes 0 with its weight kept (the finder's
 * conservative rule), so an unknown can never rank a machine up.
 */
export type ColorNeed = 'few' | 'many';

/**
 * [native, waste, AMS ceiling, as sold] per colour need — ONE table for the
 * finder's colour criterion and the compare page's «تعدد الألوان» lens, so the
 * two can never rank the same machines differently.
 *   few   printing a handful of colours CLEANLY: native and waste lead.
 *   many  the ceiling leads, and having the AMS in the box.
 *   none  no stated need: a balance.
 */
export const COLOR_PART_WEIGHTS: Record<ColorNeed | 'none', [number, number, number, number]> = {
  few: [0.45, 0.35, 0.05, 0.15],
  many: [0.1, 0.05, 0.6, 0.25],
  none: [0.3, 0.25, 0.3, 0.15],
};

const WASTE_SCORE: Record<PurgeWaste, number> = { near_zero: 1, low: 0.7, high: 0.15 };

/** Each part on its own ABSOLUTE 0..1 scale (null = the sheet does not say). */
export function colorParts(p: MulticolorProfile): [number | null, number | null, number | null, number | null] {
  const upToFour = (n: number | null) => (n === null ? null : Math.max(0, (Math.min(n, 4) - 1) / 3));
  return [
    upToFour(p.native),
    p.waste === null ? null : WASTE_SCORE[p.waste],
    // log2 over 32 colours: 1 → 0, 4 → 0.4, 16 → 0.8, 25 → 0.93.
    p.with_ams === null ? null : Math.min(1, Math.log2(Math.max(1, p.with_ams)) / 5),
    upToFour(p.out_of_box),
  ];
}

/**
 * How well a machine meets a stated colour NEED, 0..1, from the profile only.
 * A missing part contributes 0 with its weight kept (the finder's conservative
 * rule), so an unknown can never rank a machine up.
 */
export function colorFit(p: MulticolorProfile, need: ColorNeed | null): number | null {
  const parts = colorParts(p);
  if (parts.every((v) => v === null)) return null;
  const w = COLOR_PART_WEIGHTS[need ?? 'none'];
  return parts.reduce<number>((acc, v, i) => acc + w[i] * (v ?? 0), 0);
}
