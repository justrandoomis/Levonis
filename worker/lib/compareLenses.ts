/**
 * «أفضل لـ» — THE COMPARE LENSES (docs/ux/CATALOG_DISCOVERY.md §10.2;
 * IMPLEMENTATION_PLAN.md S7-server).
 *
 * The comparison already knows who wins each ROW. A buyer asks a different
 * question — «أيها للأعمال؟», «أيها للمبتدئ؟» — and answering it by eye means
 * weighing twenty rows in your head. A lens is that weighing, done once, on the
 * same spec sheet, with the same parsers, under the same rules:
 *
 *   beginners  «للمبتدئين»     the finder's ease formula (§9.3); needs
 *                              `skill_level` or `assembly` known for ≥ 2.
 *   business   «للأعمال»       speed, size, enclosed, failure detection, air
 *                              filtration, warranty — equal weights over the
 *                              components KNOWN for that product.
 *   value      «أفضل قيمة»     the verdict's score per dinar.
 *   multicolor «تعدد الألوان»  max colours; extruders break a near tie.
 *   precision  «أعلى دقة»      finest layer height and Z accuracy (resin: XY).
 *
 * A LENS NAMES A WINNER ONLY BY A 5% MARGIN. Otherwise it is «متقاربة» — a
 * tie — because two machines 2% apart on a composite are the same machine for
 * that purpose and naming one would be inventing a verdict. Fewer than two
 * products with data: «لا توجد بيانات كافية». A missing value is never a loss
 * (compareSpecs D1): it is left out of that product's mean, and a product with
 * no known component has no score at all.
 *
 * Printers and laser machines only. A filament comparison gets no lens row.
 */
import type { CompareLens, CompareLensId } from '@levonis/catalog/discoveryTypes';
import { compareProducts, readBoolean, readNumber, type CompareInputProduct, type CompareResult } from './compareSpecs';
import { easeRaw, techGroup, valueText, volumeOf } from './printerFinder';

export const LENS_MARGIN = 0.05;
export const LENS_ORDER: CompareLensId[] = ['business', 'beginners', 'value', 'multicolor', 'precision'];

const raw = (specs: Record<string, unknown>, id: string): string => {
  const v = specs[id];
  if (v === null || v === undefined || typeof v === 'object') return '';
  return String(v).trim();
};

/** min-max over the known values; all-equal = 0.5. */
function minmax(values: Array<number | null>, lower = false): Array<number | null> {
  const known = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (!known.length) return values.map(() => null);
  const lo = Math.min(...known);
  const hi = Math.max(...known);
  return values.map((v) => (v === null ? null : hi - lo <= 1e-12 ? 0.5 : lower ? (hi - v) / (hi - lo) : (v - lo) / (hi - lo)));
}

/** The finest reading wins, as a RATIO (min/value), so a margin means something. */
function finestRatio(values: Array<number | null>): Array<number | null> {
  const known = values.filter((v): v is number => v !== null && v > 0);
  if (!known.length) return values.map(() => null);
  const best = Math.min(...known);
  return values.map((v) => (v === null || !(v > 0) ? null : best / v));
}

function meanKnown(columns: Array<Array<number | null>>, n: number): Array<number | null> {
  return Array.from({ length: n }, (_, i) => {
    const known = columns.map((c) => c[i]).filter((v): v is number => v !== null);
    return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
  });
}

const num = (s: Record<string, unknown>, id: string, unit = '') => {
  const r = raw(s, id);
  return r === '' ? null : readNumber(r, unit);
};

function airFiltration(s: Record<string, unknown>): number | null {
  const v = raw(s, 'air_filtration').toLowerCase();
  if (!v) return null;
  if (v === 'none') return 0;
  return v.includes('optional') ? 0.5 : 1;
}

interface Verdict {
  winner: number | null;
  state: CompareLens['state'];
}

/** The 5% rule. `tieBreak` may settle a near tie (multicolor: extruders). */
function decide(scores: Array<number | null>, tieBreak?: Array<number | null>): Verdict {
  const known = scores.map((v, i) => ({ v, i })).filter((x): x is { v: number; i: number } => x.v !== null);
  if (known.length < 2) return { winner: null, state: 'no_data' };
  known.sort((a, b) => b.v - a.v);
  const [first, second] = known;
  const margin = first.v === 0 ? 0 : (first.v - second.v) / Math.abs(first.v);
  if (margin >= LENS_MARGIN) return { winner: first.i, state: 'winner' };
  if (tieBreak) {
    const near = known.filter((x) => first.v === 0 ? x.v === 0 : (first.v - x.v) / Math.abs(first.v) < LENS_MARGIN);
    const tb = near.map((x) => ({ i: x.i, t: tieBreak[x.i] })).filter((x): x is { i: number; t: number } => x.t !== null);
    if (tb.length === near.length && tb.length >= 2) {
      tb.sort((a, b) => b.t - a.t);
      if (tb[0].t > tb[1].t) return { winner: tb[0].i, state: 'winner' };
    }
  }
  return { winner: null, state: 'tie' };
}

const scaled = (scores: Array<number | null>): Array<number | null> => {
  const known = scores.filter((v): v is number => v !== null);
  const max = known.length ? Math.max(...known) : 0;
  return scores.map((v) => (v === null ? null : max > 0 ? Math.round((v / max) * 1000) / 1000 : 0));
};

/** The claim for a winner, quoted from the first field (in order) that has a value. */
function claim(specs: Record<string, unknown>, code: string, fields: string[]): CompareLens['reason'] {
  for (const field of fields) {
    const text = valueText(specs, field);
    if (text !== null) return { code, field_id: field, value_text: text };
  }
  return null;
}

/**
 * The lenses for a comparison. `products` in the page's column order; `verdict`
 * is the comparison's own verdict (the value lens divides it by price).
 */
export function compareLenses(products: CompareInputProduct[], result: Pick<CompareResult, 'verdict'>): CompareLens[] {
  const n = products.length;
  if (n < 2) return [];
  if (!products.every((p) => p.product_type === 'printer' || p.product_type === 'laser')) return [];
  const specs = products.map((p) => p.spec_fields ?? {});

  const lens = (id: CompareLensId, scores: Array<number | null>, reasonOf: (i: number) => CompareLens['reason'], tieBreak?: Array<number | null>): CompareLens => {
    const v = decide(scores, tieBreak);
    return {
      id,
      winner: v.winner,
      state: v.state,
      scores: scaled(scores),
      reason: v.winner === null ? null : reasonOf(v.winner),
    };
  };

  // beginners — the ease mean, only where skill or assembly is stated.
  const easeKnown = specs.filter((s) => raw(s, 'skill_level') !== '' || raw(s, 'assembly') !== '').length;
  const ease = specs.map((s) => (raw(s, 'skill_level') !== '' || raw(s, 'assembly') !== '' ? easeRaw(s) : null));
  const beginners = easeKnown >= 2
    ? lens('beginners', ease, (i) => claim(specs[i], 'ease', ['skill_level', 'assembly']))
    : { id: 'beginners' as const, winner: null, state: 'no_data' as const, scores: specs.map(() => null), reason: null };

  // business — equal weights over the components known for each product.
  const speedPs = minmax(specs.map((s) => num(s, 'print_speed', 'mm/s')));
  const speedAcc = minmax(specs.map((s) => num(s, 'max_acceleration', 'mm/s²')));
  const speed = specs.map((_, i) =>
    speedPs[i] === null && speedAcc[i] === null ? null : 0.7 * (speedPs[i] ?? 0) + 0.3 * (speedAcc[i] ?? 0)
  );
  const longest = minmax(specs.map((s) => volumeOf(s)?.longest ?? null));
  const logVol = minmax(specs.map((s) => { const v = volumeOf(s); return v ? Math.log(v.volume) : null; }));
  const size = specs.map((_, i) => (longest[i] === null ? null : 0.6 * (longest[i] as number) + 0.4 * (logVol[i] ?? 0)));
  const business = meanKnown(
    [
      speed,
      size,
      specs.map((s) => readBoolean(raw(s, 'enclosed'))),
      specs.map((s) => readBoolean(raw(s, 'print_failure_detection'))),
      specs.map(airFiltration),
      minmax(specs.map((s) => num(s, 'warranty', 'months'))),
    ],
    n
  );
  const businessReason = (i: number): CompareLens['reason'] => {
    // Quote the component this product leads most on.
    const parts: Array<[number | null, string, string[]]> = [
      [speed[i], 'speed', ['print_speed', 'max_acceleration']],
      [size[i], 'size', ['build_volume']],
    ];
    parts.sort((a, b) => (b[0] ?? -1) - (a[0] ?? -1));
    for (const [v, code, fields] of parts) if (v !== null) {
      const c = claim(specs[i], code, fields);
      if (c) return c;
    }
    return claim(specs[i], 'reliability', ['print_failure_detection', 'enclosed', 'warranty']);
  };

  // value — the verdict's score per million IQD.
  const perDinar = products.map((p, i) => {
    const price = Number(p.price_iqd);
    const score = result.verdict.scores[i];
    return Number.isFinite(price) && price > 0 && typeof score === 'number' ? score / (price / 1_000_000) : null;
  });
  const valueReason = (i: number): CompareLens['reason'] => {
    const price = Number(products[i].price_iqd);
    return { code: 'value', field_id: 'price_iqd', value_text: `${price.toLocaleString('en-US')} IQD` };
  };

  // multicolor — max colours, extruders settle a near tie.
  const colors = specs.map((s) => num(s, 'max_colors'));
  const extruders = specs.map((s) => num(s, 'extruders'));

  // precision — finest layer and Z accuracy (resin: XY), as ratios to the finest.
  const isResin = products.map((p, i) => techGroup({ productType: p.product_type === 'laser' ? 'laser' : 'printer', specs: specs[i], sectionSlugs: p.section_slugs ?? [] }) === 'resin');
  const layer = finestRatio(specs.map((s, i) => (isResin[i] ? null : num(s, 'min_layer_height', 'mm'))));
  const xy = finestRatio(specs.map((s, i) => (isResin[i] ? num(s, 'xy_resolution', 'µm') : null)));
  const z = finestRatio(specs.map((s) => num(s, 'z_accuracy', 'mm')));
  const precision = meanKnown([layer.map((v, i) => v ?? xy[i]), z], n);

  const all: Record<CompareLensId, CompareLens> = {
    business: lens('business', business, businessReason),
    beginners,
    value: lens('value', perDinar, valueReason),
    multicolor: lens('multicolor', colors, (i) => claim(specs[i], 'colors', ['max_colors']), extruders),
    precision: lens('precision', precision, (i) => claim(specs[i], 'quality', isResin[i] ? ['xy_resolution', 'z_accuracy'] : ['min_layer_height', 'z_accuracy'])),
  };
  return LENS_ORDER.map((id) => all[id]);
}

/** `compareProducts` plus its lenses — what `/api/compare` serves. */
export function compareWithLenses(input: { products: CompareInputProduct[] }): CompareResult {
  const result = compareProducts(input);
  return { ...result, lenses: compareLenses(input.products, result) };
}
