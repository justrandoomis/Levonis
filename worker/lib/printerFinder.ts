/**
 * «مرشد الطابعات» — THE SCORER (docs/ux/CATALOG_DISCOVERY.md §9; owner defaults
 * of 2026-09-25 Q3–Q7). Pure: same candidates and answers in, same ranking out.
 *
 * WHAT THIS IS NOT. It is not an opinion engine. `handleChoosePrinter` in the
 * support assistant deliberately refused to "invent a judgement about somebody's
 * money", and this keeps that promise by construction:
 *
 *   - Every criterion is read off the SHOP'S OWN SPEC SHEET through the compare
 *     engine's parsers (`readCompareValue`, `readDimensions`, `readBoolean`), so
 *     the finder and the compare page read one number the same way.
 *   - A MISSING OR UNREADABLE VALUE CONTRIBUTES 0 and its weight still counts in
 *     the denominator (conservative): a machine is never ranked up on a field
 *     nobody filled in. It is never a REASON, and when it is one of the
 *     customer's priorities it becomes a caveat and a coverage note instead.
 *   - Reasons and caveats are CODES plus the compare engine's value text; the
 *     client writes the words. No sentence here can be machine-invented.
 *   - The one stated preference — +0.06 for a printer available now — is the
 *     owner's (Q7) and is always said out loud as the `in_stock` reason.
 *
 * THE PIPELINE. Candidates → hard filters (technology, budget, sale) → if fewer
 * than 3 survive, relax ONE step at a time and label everything that needed it
 * (budget +20%, then pre-order allowed, then any technology) → normalise every
 * criterion 0..1 within the survivors (all-equal = 0.5) → weight by the answers
 * → a relaxed result never outranks a non-relaxed one → top 3 (a 4th only when
 * within 0.02 of the 3rd).
 */
import type {
  FinderAnswers,
  FinderLevel,
  FinderPriority,
  FinderUse,
} from '@levonis/catalog/discovery';
import { finderBudgetRange } from '@levonis/catalog/discovery';
import type {
  FinderCaveat,
  FinderCoverage,
  FinderCriterion,
  FinderExcluded,
  FinderReason,
  FinderRelaxation,
  FinderResult,
} from '@levonis/catalog/discoveryTypes';
import { readBoolean, readCompareValue, readDimensions, readList, readNumber } from './compareSpecs';
import { allTemplateGroups, type TemplateField } from './templateFamilies';

// ---------------------------------------------------------------- the inputs

export interface FinderCandidate<Card = Record<string, unknown>> {
  id: string;
  card: Card;
  /** `printer` or `laser` (the laser machines' own section). */
  productType: 'printer' | 'laser';
  /** The viewer's resolved «from» price. */
  price: number;
  /** Direct-sale units available now. */
  available: number;
  /** The branch the product is filed in, leaf first (a technology fallback). */
  sectionSlugs: string[];
  specs: Record<string, unknown>;
  /** A stable tie-break (the catalogue order). */
  rank: number;
}

export type FinderTechGroup = 'fdm' | 'resin' | 'laser' | null;

const FIELDS: Map<string, TemplateField> = (() => {
  const m = new Map<string, TemplateField>();
  for (const g of allTemplateGroups()) for (const f of g.fields) if (!m.has(f.id)) m.set(f.id, f);
  return m;
})();

const raw = (specs: Record<string, unknown>, id: string): string => {
  const v = specs[id];
  if (v === null || v === undefined || typeof v === 'object') return '';
  return String(v).trim();
};

/** The compare engine's display text for a field, or null when it is missing. */
export function valueText(specs: Record<string, unknown>, fieldId: string): string | null {
  const f = FIELDS.get(fieldId);
  const r = raw(specs, fieldId);
  if (!f || r === '') return null;
  const v = readCompareValue(f, r);
  return v.missing ? null : v.text;
}

/** Which technology a candidate is — the machine's own word first, then its shelf. */
export function techGroup(c: Pick<FinderCandidate, 'productType' | 'specs' | 'sectionSlugs'>): FinderTechGroup {
  if (c.productType === 'laser') return 'laser';
  const t = raw(c.specs, 'technology').toLowerCase();
  if (t.includes('fdm') || t.includes('fff')) return 'fdm';
  if (/resin|msla|sla|dlp|lcd/.test(t)) return 'resin';
  const slugs = c.sectionSlugs.map((s) => s.toLowerCase());
  if (slugs.some((s) => s.includes('fdm'))) return 'fdm';
  if (slugs.some((s) => s.includes('resin'))) return 'resin';
  return null;
}

/** Owner Q3: a printer sold with a laser module option counts for «Laser». */
export const hasLaserModule = (specs: Record<string, unknown>): boolean => readBoolean(raw(specs, 'has_laser_module')) === 1;

// ------------------------------------------------------------ the criteria

const CRITERIA: FinderCriterion[] = ['speed', 'colors', 'quality', 'quiet', 'ease', 'size', 'durable', 'reliability', 'use_fit'];

/** §9.4, verbatim. */
const BASE_WEIGHTS: Record<FinderUse, Record<FinderCriterion, number>> = {
  hobby: { speed: 1, colors: 1, quality: 1, quiet: 1.5, ease: 2, size: 0.5, durable: 0, reliability: 1, use_fit: 2 },
  business: { speed: 2, colors: 1, quality: 1, quiet: 0, ease: 0.5, size: 1.5, durable: 1.5, reliability: 2, use_fit: 2 },
  figures: { speed: 0, colors: 0.5, quality: 3, quiet: 0.5, ease: 1, size: 0, durable: 0, reliability: 0.5, use_fit: 2 },
  functional: { speed: 1, colors: 0, quality: 1, quiet: 0, ease: 0.5, size: 1, durable: 3, reliability: 1, use_fit: 2 },
  sell: { speed: 2, colors: 1, quality: 1.5, quiet: 0, ease: 0.5, size: 1, durable: 1, reliability: 2, use_fit: 2 },
  multicolor: { speed: 0.5, colors: 3.5, quality: 1, quiet: 0.5, ease: 1, size: 0.5, durable: 0, reliability: 1, use_fit: 2 },
  unsure: { speed: 1, colors: 1, quality: 1, quiet: 1, ease: 1.5, size: 1, durable: 0.5, reliability: 1, use_fit: 0 },
};

/** Q1 → the `use_cases` option that says "this printer suits it" (templateFamilies PRINTER_USE_CASES). */
const USE_CASE_OPTION: Record<FinderUse, string | null> = {
  hobby: 'hobby',
  business: 'business',
  figures: 'figures',
  functional: 'functional parts',
  sell: 'products to sell',
  multicolor: 'multicolour',
  unsure: null,
};

const SKILL_EASE: Record<string, number> = { beginner: 1, intermediate: 0.6, advanced: 0.3, professional: 0.15 };
const ASSEMBLY_EASE: Record<string, number> = { 'pre-assembled': 1, 'partially assembled': 0.6, kit: 0.2 };

const ENGINEERING = /(^|[^a-z])(pa\d*|pc|cf|gf|abs|asa)([^a-z]|$)/i;

/** One weighted part of a criterion: a raw reading (higher = better after `invert`) and the field it came from. */
interface Part {
  field: string;
  weight: number;
  /** Read the raw value; null = missing/unreadable. */
  read: (specs: Record<string, unknown>) => number | null;
  /** Lower raw is better. */
  lower?: boolean;
  /** Already on a 0..1 scale — used as is, not min-max'd. */
  absolute?: boolean;
}

const num = (id: string, unit = '') => (s: Record<string, unknown>) => {
  const r = raw(s, id);
  return r === '' ? null : readNumber(r, unit);
};
const bool = (id: string) => (s: Record<string, unknown>) => readBoolean(raw(s, id));

export function volumeOf(s: Record<string, unknown>): { longest: number; volume: number } | null {
  const d = readDimensions(raw(s, 'build_volume'), 'mm');
  if (!d || d.axes.length !== 3) return null;
  return { longest: Math.max(...d.axes), volume: d.magnitude };
}

/** The ease parts that are KNOWN on this sheet, each on its own 0..1 scale. */
function easeParts(s: Record<string, unknown>): Map<string, number> {
  const m = new Map<string, number>();
  const skill = SKILL_EASE[raw(s, 'skill_level').toLowerCase()];
  if (skill !== undefined) m.set('skill_level', skill);
  const assembly = ASSEMBLY_EASE[raw(s, 'assembly').toLowerCase()];
  if (assembly !== undefined) m.set('assembly', assembly);
  for (const id of ['auto_leveling', 'filament_sensor', 'power_loss_recovery', 'camera']) {
    const b = readBoolean(raw(s, id));
    if (b !== null) m.set(id, b);
  }
  return m;
}

export function easeRaw(s: Record<string, unknown>): number | null {
  const known: number[] = [];
  const skill = SKILL_EASE[raw(s, 'skill_level').toLowerCase()];
  if (skill !== undefined) known.push(skill);
  const assembly = ASSEMBLY_EASE[raw(s, 'assembly').toLowerCase()];
  if (assembly !== undefined) known.push(assembly);
  for (const id of ['auto_leveling', 'filament_sensor', 'power_loss_recovery', 'camera']) {
    const b = readBoolean(raw(s, id));
    if (b !== null) known.push(b);
  }
  return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
}

function engineeringCount(s: Record<string, unknown>): number | null {
  const text = raw(s, 'supported_filaments') || raw(s, 'supported_materials');
  if (!text) return null;
  return readList(text).filter((item) => ENGINEERING.test(item)).length;
}

function airFiltration(s: Record<string, unknown>): number | null {
  const v = raw(s, 'air_filtration').toLowerCase();
  if (!v) return null;
  if (v === 'none') return 0;
  if (v.includes('optional')) return 0.5;
  return 1;
}

/**
 * The parts of each criterion (§9.3). `quality` depends on the technology, so it
 * is chosen per candidate below.
 */
const PARTS: Record<Exclude<FinderCriterion, 'quality' | 'use_fit' | 'ease'>, Part[]> = {
  speed: [
    { field: 'print_speed', weight: 0.7, read: num('print_speed', 'mm/s') },
    { field: 'max_acceleration', weight: 0.3, read: num('max_acceleration', 'mm/s²') },
  ],
  colors: [{ field: 'max_colors', weight: 1, read: (s) => { const n = num('max_colors')(s); return n !== null && n > 0 ? Math.log2(n) : null; } }],
  quiet: [{ field: 'noise_level', weight: 1, read: num('noise_level', 'dB'), lower: true }],
  size: [
    { field: 'build_volume', weight: 0.6, read: (s) => volumeOf(s)?.longest ?? null },
    { field: 'build_volume', weight: 0.4, read: (s) => { const v = volumeOf(s); return v ? Math.log(v.volume) : null; } },
  ],
  durable: [
    { field: 'enclosed', weight: 1, read: bool('enclosed'), absolute: true },
    { field: 'chamber_temp_max', weight: 1, read: num('chamber_temp_max', '°C') },
    { field: 'bed_temp_max', weight: 1, read: num('bed_temp_max', '°C') },
    { field: 'supported_filaments', weight: 1, read: engineeringCount },
  ],
  reliability: [
    { field: 'print_failure_detection', weight: 1, read: bool('print_failure_detection'), absolute: true },
    { field: 'filament_sensor', weight: 1, read: bool('filament_sensor'), absolute: true },
    { field: 'power_loss_recovery', weight: 1, read: bool('power_loss_recovery'), absolute: true },
    { field: 'air_filtration', weight: 1, read: airFiltration, absolute: true },
    { field: 'warranty', weight: 1, read: num('warranty', 'months') },
  ],
};

const QUALITY_FDM: Part[] = [{ field: 'min_layer_height', weight: 1, read: num('min_layer_height', 'mm'), lower: true }];
const QUALITY_RESIN: Part[] = [{ field: 'xy_resolution', weight: 1, read: num('xy_resolution', 'µm'), lower: true }];

/** The field a claim about each criterion is quoted from, in preference order. */
const REASON_FIELDS: Record<FinderCriterion, string[]> = {
  speed: ['print_speed', 'max_acceleration'],
  colors: ['max_colors'],
  quality: ['min_layer_height', 'xy_resolution'],
  quiet: ['noise_level'],
  ease: ['skill_level', 'assembly', 'auto_leveling'],
  size: ['build_volume'],
  durable: ['chamber_temp_max', 'enclosed', 'bed_temp_max'],
  reliability: ['print_failure_detection', 'warranty', 'filament_sensor'],
  use_fit: ['use_cases'],
};

/** The field a PRIORITY is covered by (the coverage note names it). */
const PRIORITY_FIELD: Record<FinderPriority, string> = {
  quality: 'min_layer_height',
  speed: 'print_speed',
  quiet: 'noise_level',
  colors: 'max_colors',
  ease: 'skill_level',
  size: 'build_volume',
};

interface Scored<Card> {
  c: FinderCandidate<Card>;
  s: Record<FinderCriterion, number | null>;
  relaxed: FinderRelaxation[];
  total: number;
}

/** min-max within the set; all-equal (or a single known value) = 0.5. */
function normalise(values: Array<number | null>, lower = false): Array<number | null> {
  const known = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (known.length === 0) return values.map(() => null);
  const min = Math.min(...known);
  const max = Math.max(...known);
  return values.map((v) => {
    if (v === null || !Number.isFinite(v)) return null;
    if (max - min <= 1e-12) return 0.5;
    const t = (v - min) / (max - min);
    return lower ? 1 - t : t;
  });
}

/**
 * Per candidate, the fields that actually CONTRIBUTED a reading to a criterion,
 * with that part's 0..1 value. A claim (reason or weak-caveat) is only ever
 * quoted from one of these — never from a field that was blank or unreadable,
 * and never from a field that did not feed the score it explains.
 */
type Contributions = Array<Map<string, number>>;

/** A criterion from weighted parts: each part normalised, a missing part 0, weight kept. */
function criterionFromParts(set: Array<Record<string, unknown>>, parts: Part[], sink?: Contributions): Array<number | null> {
  const perPart = parts.map((p) => {
    const raws = set.map((s) => p.read(s));
    return p.absolute ? raws.map((v) => (v === null ? null : Math.min(1, Math.max(0, v)))) : normalise(raws, p.lower);
  });
  if (sink) {
    set.forEach((_, i) => {
      const m = sink[i] ?? new Map<string, number>();
      parts.forEach((p, k) => {
        const v = perPart[k][i];
        if (v !== null) m.set(p.field, Math.max(v, m.get(p.field) ?? -1));
      });
      sink[i] = m;
    });
  }
  const wsum = parts.reduce((a, p) => a + p.weight, 0);
  return set.map((_, i) => {
    let anyKnown = false;
    let acc = 0;
    parts.forEach((p, k) => {
      const v = perPart[k][i];
      if (v !== null) {
        anyKnown = true;
        acc += p.weight * v;
      }
    });
    return anyKnown ? acc / wsum : null;
  });
}

function useFit(s: Record<string, unknown>, use: FinderUse): number | null {
  const listed = readList(raw(s, 'use_cases')).map((x) => x.toLowerCase());
  if (listed.length === 0) return null;
  const want = USE_CASE_OPTION[use];
  if (!want) return null;
  return listed.includes(want) ? 1 : 0;
}

/** The weights for these answers (§9.4 then the priority and experience rules). */
export function finderWeights(answers: Pick<FinderAnswers, 'use' | 'prio' | 'level'>): Record<FinderCriterion, number> {
  const w = { ...BASE_WEIGHTS[answers.use ?? 'unsure'] };
  const prio = answers.prio ?? [];
  if (prio[0]) w[prio[0]] += 3;
  if (prio[1]) w[prio[1]] += 2;
  const level: FinderLevel | null = answers.level;
  if (level === 'beginner') w.ease += 2;
  else if (level === 'intermediate') w.ease += 0.5;
  else if (level === 'pro') {
    w.ease = 0;
    w.speed += 1;
    w.size += 1;
  }
  return w;
}

export const AVAILABLE_NOW_BONUS = 0.06;
export const VALUE_TIE_BREAK = 0.04;
export const FOURTH_WITHIN = 0.02;
export const REASON_MIN = 0.6;
export const CAVEAT_MAX = 0.4;

// --------------------------------------------------------------- the filters

interface Gate {
  tech: boolean;
  budgetMax: number | null;
  budgetMin: number | null;
  direct: boolean;
}

function techOk(c: FinderCandidate<unknown>, tech: FinderAnswers['tech']): boolean {
  const g = techGroup(c);
  switch (tech) {
    case 'fdm':
      return c.productType === 'printer' && g === 'fdm';
    case 'resin':
      return c.productType === 'printer' && g === 'resin';
    case 'laser':
      return c.productType === 'laser' || (c.productType === 'printer' && hasLaserModule(c.specs));
    default:
      return c.productType === 'printer';
  }
}

const inBudget = (c: FinderCandidate<unknown>, min: number | null, max: number | null) =>
  (min === null || c.price >= min) && (max === null || c.price <= max);

export interface FinderOutcome<Card> {
  total: number;
  tech_matches: number;
  results: FinderResult<Card>[];
  excluded: FinderExcluded;
  coverage: FinderCoverage[];
}

/**
 * THE WHOLE FINDER. `candidates` are every printer and laser machine the shop
 * sells, already priced for this viewer.
 */
export function runFinder<Card>(candidates: FinderCandidate<Card>[], answers: FinderAnswers): FinderOutcome<Card> {
  const tech = answers.tech ?? 'any';
  const budget = finderBudgetRange(answers.budget);
  const wantDirect = answers.sale === 'direct';
  // The universe: printers, plus the laser machines only when laser was asked.
  const universe = candidates.filter((c) => c.productType === 'printer' || tech === 'laser');
  const techMatches = universe.filter((c) => techOk(c, tech));

  const gate: Gate = { tech: true, budgetMin: budget?.min ?? null, budgetMax: budget?.max ?? null, direct: wantDirect };
  const passes = (c: FinderCandidate<Card>, g: Gate) =>
    (!g.tech || techOk(c, tech)) && inBudget(c, g.budgetMin, g.budgetMax) && (!g.direct || c.available > 0);

  // Relax ONE step at a time until 3 survive (§9.2).
  let survivors = universe.filter((c) => passes(c, gate));
  if (survivors.length < 3 && gate.budgetMax !== null) {
    gate.budgetMax = Math.round(gate.budgetMax * 1.2);
    survivors = universe.filter((c) => passes(c, gate));
  }
  if (survivors.length < 3 && gate.direct) {
    gate.direct = false;
    survivors = universe.filter((c) => passes(c, gate));
  }
  if (survivors.length < 3 && tech !== 'any') {
    gate.tech = false;
    survivors = universe.filter((c) => passes(c, gate));
  }

  const relaxationsOf = (c: FinderCandidate<Card>): FinderRelaxation[] => {
    const out: FinderRelaxation[] = [];
    if (budget && budget.max !== null && c.price > budget.max) out.push('budget_plus_20');
    if (wantDirect && !(c.available > 0)) out.push('allow_preorder');
    if (!techOk(c, tech)) out.push('any_tech');
    return out;
  };

  // ---- criteria within the survivors
  const specs = survivors.map((c) => c.specs);
  const claims = Object.fromEntries(CRITERIA.map((k) => [k, [] as Contributions])) as Record<FinderCriterion, Contributions>;
  const cols: Record<FinderCriterion, Array<number | null>> = {
    speed: criterionFromParts(specs, PARTS.speed, claims.speed),
    colors: (() => {
      const base = criterionFromParts(specs, PARTS.colors, claims.colors);
      return base.map((v, i) => {
        if (v === null) return null;
        const extruders = readNumber(raw(specs[i], 'extruders'));
        return Math.min(1, v + (extruders !== null && extruders >= 2 ? 0.1 : 0));
      });
    })(),
    quality: (() => {
      const fdmClaims: Contributions = [];
      const resinClaims: Contributions = [];
      const fdm = criterionFromParts(specs, QUALITY_FDM, fdmClaims);
      const resin = criterionFromParts(specs, QUALITY_RESIN, resinClaims);
      return survivors.map((c, i) => {
        const isResin = techGroup(c) === 'resin';
        claims.quality[i] = (isResin ? resinClaims[i] : fdmClaims[i]) ?? new Map();
        return isResin ? resin[i] : fdm[i];
      });
    })(),
    quiet: criterionFromParts(specs, PARTS.quiet, claims.quiet),
    ease: (() => {
      specs.forEach((sp, i) => (claims.ease[i] = easeParts(sp)));
      return normalise(specs.map(easeRaw));
    })(),
    size: criterionFromParts(specs, PARTS.size, claims.size),
    durable: criterionFromParts(specs, PARTS.durable, claims.durable),
    reliability: criterionFromParts(specs, PARTS.reliability, claims.reliability),
    use_fit: specs.map((sp, i) => {
      const v = useFit(sp, answers.use ?? 'unsure');
      claims.use_fit[i] = v === null ? new Map() : new Map([['use_cases', v]]);
      return v;
    }),
  };

  const weights = finderWeights(answers);
  // `use_cases` not filled on ANY survivor → the criterion does not exist yet
  // (plan rollout step 5): weight 0, not a zero for everyone.
  if (cols.use_fit.every((v) => v === null)) weights.use_fit = 0;
  const wsum = CRITERIA.reduce((a, k) => a + weights[k], 0);
  const budgetCeiling = budget?.max ?? (survivors.length ? Math.max(...survivors.map((c) => c.price)) : 1);

  const claimIndex = new Map(survivors.map((c, i) => [c.id, i]));
  const scored: Scored<Card>[] = survivors.map((c, i) => {
    const s = Object.fromEntries(CRITERIA.map((k) => [k, cols[k][i]])) as Record<FinderCriterion, number | null>;
    let total = wsum > 0 ? CRITERIA.reduce((a, k) => a + weights[k] * (s[k] ?? 0), 0) / wsum : 0;
    if (answers.level === 'beginner' && raw(c.specs, 'skill_level').toLowerCase() === 'professional') total *= 0.85;
    if (c.available > 0) total += AVAILABLE_NOW_BONUS;
    if (budgetCeiling > 0) total -= VALUE_TIE_BREAK * (c.price / budgetCeiling);
    return { c, s, relaxed: relaxationsOf(c), total };
  });

  scored.sort(
    (a, b) =>
      Number(a.relaxed.length > 0) - Number(b.relaxed.length > 0) || b.total - a.total || a.c.rank - b.c.rank
  );
  let take = Math.min(3, scored.length);
  if (scored.length > 3 && scored[2].total - scored[3].total <= FOURTH_WITHIN && scored[3].relaxed.length === scored[2].relaxed.length) take = 4;
  const shown = scored.slice(0, take);

  // ---- reasons and caveats
  const best: Record<FinderCriterion, number> = Object.fromEntries(
    CRITERIA.map((k) => [k, Math.max(-1, ...scored.map((x) => x.s[k] ?? -1))])
  ) as Record<FinderCriterion, number>;

  /**
   * The field a claim about criterion `k` is quoted from: among the fields that
   * CONTRIBUTED to this product's score (`claims`), the strongest part for a
   * reason and the weakest for a caveat; preference order breaks ties. A field
   * with no display text is never quoted.
   */
  const claimFor = (x: Scored<Card>, k: FinderCriterion, want: 'strong' | 'weak'): { field: string; text: string } | null => {
    const parts = claims[k][claimIndex.get(x.c.id) ?? -1] ?? new Map<string, number>();
    const pos = (field: string) => {
      const i = REASON_FIELDS[k].indexOf(field);
      return i < 0 ? REASON_FIELDS[k].length : i;
    };
    const ranked = [...parts]
      .filter(([field]) => valueText(x.c.specs, field) !== null)
      .sort((a, b) => (want === 'strong' ? b[1] - a[1] : a[1] - b[1]) || pos(a[0]) - pos(b[0]));
    const hit = ranked[0];
    return hit ? { field: hit[0], text: valueText(x.c.specs, hit[0]) as string } : null;
  };
  const reasonFor = (x: Scored<Card>, k: FinderCriterion): FinderReason | null => {
    const c = claimFor(x, k, 'strong');
    return c ? { code: k, field_id: c.field, value_text: c.text, top: (x.s[k] ?? -1) >= best[k] - 1e-9 } : null;
  };

  const results: FinderResult<Card>[] = shown.map((x, i) => {
    const reasons: FinderReason[] = [];
    if (x.c.available > 0) reasons.push({ code: 'in_stock', field_id: '', value_text: '', top: false, units: x.c.available });
    const strong = CRITERIA.filter((k) => weights[k] > 0 && (x.s[k] ?? -1) >= REASON_MIN)
      .sort((a, b) => weights[b] * (x.s[b] ?? 0) - weights[a] * (x.s[a] ?? 0));
    for (const k of strong) {
      if (reasons.length >= 3) break;
      const r = reasonFor(x, k);
      if (r) reasons.push(r);
    }
    if (reasons.length < 3 && budget && inBudget(x.c, budget.min, budget.max)) {
      reasons.push({ code: 'in_budget', field_id: '', value_text: '', top: false });
    }

    const caveats: FinderCaveat[] = [];
    if (x.relaxed.length) caveats.push({ code: 'relaxed', relaxation: x.relaxed[0] });
    else if (answers.level === 'beginner' && raw(x.c.specs, 'skill_level').toLowerCase() === 'professional') {
      caveats.push({ code: 'professional' });
    } else {
      // The WEAKEST of the customer's own priorities: missing first (it is the
      // honest gap), then the lowest reading at or under 0.4.
      let pick: FinderCaveat | null = null;
      let pickScore = Infinity;
      for (const p of answers.prio ?? []) {
        const v = x.s[p];
        const field = PRIORITY_FIELD[p];
        if (v === null) {
          pick = { code: 'missing', criterion: p, field_id: field };
          break;
        }
        if (v <= CAVEAT_MAX && v < pickScore) {
          const w = claimFor(x, p, 'weak');
          if (w) {
            pick = { code: 'weak', criterion: p, field_id: w.field, value_text: w.text };
            pickScore = v;
          }
        }
      }
      if (pick) caveats.push(pick);
    }
    return { card: x.c.card, rank: i + 1, score: Math.round(x.total * 10000) / 10000, relaxed: x.relaxed, reasons, caveats };
  });

  // ---- what was left out, and why (the first ORIGINAL filter it fails)
  const shownIds = new Set(shown.map((x) => x.c.id));
  const considered = new Set(survivors.map((c) => c.id));
  const excluded: FinderExcluded = { budget: [], tech: [], sale: [], ranked_lower: [] };
  for (const c of universe) {
    if (shownIds.has(c.id)) continue;
    // Considered and scored (possibly after a relaxation), just not in the top:
    // the honest reason is the ranking, not a filter that was lifted.
    if (considered.has(c.id)) excluded.ranked_lower.push(c.id);
    else if (!techOk(c, tech)) excluded.tech.push(c.id);
    else if (budget && !inBudget(c, budget.min, budget.max)) excluded.budget.push(c.id);
    else if (wantDirect && !(c.available > 0)) excluded.sale.push(c.id);
    else excluded.ranked_lower.push(c.id);
  }

  const coverage: FinderCoverage[] = (answers.prio ?? []).map((p) => ({
    criterion: p,
    field_id: PRIORITY_FIELD[p],
    known: scored.filter((x) => x.s[p] !== null).length,
    total: scored.length,
  }));

  return { total: universe.length, tech_matches: techMatches.length, results, excluded, coverage };
}
