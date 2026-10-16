/**
 * LOGISTICS, KEPT SEPARATE, WITH CBM DERIVED (spec §B.7).
 *
 * Product, package, shipment and carton measures are typed spec rows (group
 * 'logistics'), never products.package_* / net_weight_g (Pricing V2 freight
 * inputs, refused by the 0195 guard triggers). CBM (`package.volume_m3`) is
 * derived only from three package edges of ONE source, scope and region, and
 * never from a multi-box shipment or a US-only (110 V) printer box.
 */
import { toStored, round, UNIT_TOKEN } from './registry/units';

export interface Measure {
  value: number;
  /** 'mm' | 'g' after conversion. */
  unit: string;
  written: string;
  /** A weight's number as the source wrote it, in `written` (31 for «31 kg»); `value` is the stored grams. */
  published?: number;
}

/** Edge 1–3,000 mm; weight 1 g–200 kg (§B.7 plausibility). */
export const plausibleEdge = (mm: number) => mm >= 1 && mm <= 3000;
export const plausibleWeight = (g: number) => g >= 1 && g <= 200_000;

const NUM = String.raw`(\d+(?:[.,]\d+)?)`;
const SEP = String.raw`\s*[*xX×]\s*`;
const LEN_UNIT = String.raw`(mm³|mm3|mm\^3|mm|cm|m|in(?:ch(?:es)?)?|")?`;
const INNER_UNIT = String.raw`\s*(?:mm|cm)?`;
const DIMS_RE = new RegExp(`${NUM}${INNER_UNIT}${SEP}${NUM}${INNER_UNIT}${SEP}${NUM}\\s*${LEN_UNIT}`, 'gi');
const WEIGHT_RE = /(\d+(?:[.,]\d+)?)\s*(kg|kgs|g|gr|grams?|lbs?)(?![a-z])/gi;

/** A written number: "20,000" is a thousands group, "13,5" a decimal comma. */
export const num = (s: string) => (/^\d{1,3}(?:,\d{3})+$/.test(s) ? Number(s.replace(/,/g, '')) : Number(s.replace(',', '.')));

export interface DimsHit {
  values: [number, number, number];
  /** The written unit, or '' when none was written (a later sibling may supply it). */
  written: string;
  index: number;
  length: number;
}

/** Every `a*b*c unit` triple in a text, in order, in the written unit. */
export function findDims(text: string): DimsHit[] {
  const out: DimsHit[] = [];
  DIMS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DIMS_RE.exec(text))) {
    out.push({ values: [num(m[1]), num(m[2]), num(m[3])], written: (m[4] ?? '').replace(/^"$/, 'in'), index: m.index, length: m[0].length });
  }
  return out;
}

/** The triple in mm, or null when the unit is unknown or an edge is implausible. */
export function dimsToMm(hit: DimsHit, fallbackUnit = ''): Measure[] | null {
  const unit = hit.written || fallbackUnit;
  if (!unit) return null;
  const out: Measure[] = [];
  for (const v of hit.values) {
    const s = toStored(v, unit.replace(/³|3|\^3/g, ''));
    if (!s || s.unit !== 'mm' || !plausibleEdge(s.value)) return null;
    out.push({ value: s.value, unit: 'mm', written: unit });
  }
  return out;
}

export interface WeightHit {
  value: number;
  written: string;
  index: number;
}

/** Every `n unit` weight in a text. */
export function findWeights(text: string): WeightHit[] {
  const out: WeightHit[] = [];
  WEIGHT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WEIGHT_RE.exec(text))) out.push({ value: num(m[1]), written: m[2], index: m.index });
  return out;
}

export function weightToG(value: number, written: string): Measure | null {
  const s = toStored(value, written);
  if (!s || s.unit !== 'g' || !plausibleWeight(s.value)) return null;
  return { value: round(s.value, 3), unit: 'g', written, published: value };
}

const WEIGHT_WORD: Readonly<Record<string, string>> = { kg: 'kg', kgs: 'kg', g: 'g', gr: 'g', gram: 'g', grams: 'g', lb: 'lb', lbs: 'lb' };

/**
 * A weight's text AS PUBLISHED — the source's own number in its own unit
 * («31 kg», «1 kg» from «1kg», «500 g») — for `value_text` (the page shows it,
 * §G.2 "the unit as published"); `value_num` stays in grams (§B.7).
 */
export function publishedWeight(m: Measure): string {
  const unit = WEIGHT_WORD[m.written.toLowerCase()];
  return m.published !== undefined && unit ? `${m.published} ${unit}` : `${m.value} g`;
}

/** A bare number (no unit written) followed later by a unit: "40.6; 44.2; 48.2 kg". */
export function bareNumbers(text: string): Array<{ value: number; index: number }> {
  const out: Array<{ value: number; index: number }> = [];
  const re = /(\d+(?:[.,]\d+)?)(?!\s*(?:[*xX×]|\d|[A-Za-z°℃%³"]))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ value: num(m[1]), index: m.index });
  return out;
}

/** The first number with a unit token in a text (`300 °C`, `500mm/s`, `1320 W`). */
export function firstNumberWithUnit(text: string): { value: number; unit: string; max?: number } | null {
  const range = new RegExp(String.raw`(\d+(?:[.,]\d+)?)\s*(?:-|–|—|~|to)\s*(\d+(?:[.,]\d+)?)\s*` + UNIT_TOKEN.source, 'i').exec(text);
  if (range) return { value: num(range[1]), max: num(range[2]), unit: range[3] };
  const m = new RegExp(String.raw`(\d+(?:[.,]\d+)?)\s*` + UNIT_TOKEN.source, 'i').exec(text);
  return m ? { value: num(m[1]), unit: m[2] } : null;
}

// ---------------------------------------------------------------- CBM

export interface EdgeRow {
  key: string;
  scopeKind: 'product' | 'option_value' | 'variant';
  scopeId: string;
  region: string;
  valueNum: number | null;
  sourceKind: string;
  sourceLocator: string;
}

export interface CbmDecision {
  scopeKind: 'product' | 'option_value' | 'variant';
  scopeId: string;
  region: string;
  /** Derived volume in m³, or null with the reason it was not derived. */
  volume: number | null;
  reason: '' | 'multi_box' | 'us_110v_only' | 'incomplete_edges' | 'mixed_sources';
  derivedFrom: string;
}

/**
 * Decides CBM per (scope, region) group of package edges. `multiBoxScopes`
 * holds the scope ids whose shipment is several boxes; `isPrinter` turns on
 * the us_110v rule (§C.6: no CBM from a US-only printer box).
 */
export function deriveCbm(rows: readonly EdgeRow[], opts: { multiBoxScopes: ReadonlySet<string>; isPrinter: boolean }): CbmDecision[] {
  const groups = new Map<string, EdgeRow[]>();
  for (const r of rows) {
    if (!/^package\.(length|width|height)$/.test(r.key)) continue;
    const k = `${r.scopeKind}|${r.scopeId}|${r.region}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out: CbmDecision[] = [];
  for (const [k, list] of groups) {
    const [scopeKind, scopeId, region] = k.split('|') as [CbmDecision['scopeKind'], string, string];
    const edge = (name: string) => list.find((r) => r.key === `package.${name}`);
    const l = edge('length');
    const w = edge('width');
    const h = edge('height');
    const base = { scopeKind, scopeId, region, derivedFrom: '' };
    if (opts.multiBoxScopes.has(scopeId)) {
      out.push({ ...base, volume: null, reason: 'multi_box' });
      continue;
    }
    if (opts.isPrinter && region === 'us_110v') {
      out.push({ ...base, volume: null, reason: 'us_110v_only' });
      continue;
    }
    if (!l?.valueNum || !w?.valueNum || !h?.valueNum) {
      out.push({ ...base, volume: null, reason: 'incomplete_edges' });
      continue;
    }
    if (new Set([l, w, h].map((r) => `${r.sourceKind}|${r.sourceLocator}`)).size !== 1) {
      out.push({ ...base, volume: null, reason: 'mixed_sources' });
      continue;
    }
    out.push({
      ...base,
      volume: round((l.valueNum * w.valueNum * h.valueNum) / 1e9, 6),
      reason: '',
      derivedFrom: `package.length × package.width × package.height (${l.sourceLocator})`,
    });
  }
  return out;
}

/** A variant note announcing a shipment in several boxes (§B.7, §C.3). */
export function isMultiBoxNote(text: string): boolean {
  return /\b(separate|multiple|several|two|2|three|3)\s+(boxes|packages|parcels|shipments)\b|\bshipped separately\b/i.test(text);
}
