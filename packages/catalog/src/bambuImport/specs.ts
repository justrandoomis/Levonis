/**
 * SPECIFICATIONS WITH PROVENANCE (spec §C.6, §B.7, §C.2, §C.5 feature bullets).
 *
 * Deterministic table parsing is the bulk: 4-cell rows give two pairs, 2-cell
 * rows one, `[group, label, value]` rows one (rowspan/colspan expanded by
 * html.tableGrid). Composite logistics cells go through the labelled
 * sub-value parser (`compositeCell`), which scopes package and shipment
 * measures to the version value a segment names. The region rule marks every
 * region-dependent value of a US (100–120 V) table `us_110v` and `unverified`.
 * Labels map to registry keys case- and punctuation-insensitively; an unknown
 * label keeps its words as `x.<slug>`, unverified. An absent EXPECTED key is a
 * `not_found` row naming the sources actually checked — never 0 or false.
 */
import { H } from './hash';
import { collapseWs, labelKey, slugOf } from './normalize';
import type { Described } from './describe';
import type { TableGrid } from './html';
import { parseHtml, findAll, textOf, type ElementNode } from './html';
import { sourceTextOf, type OptionModel } from './options';
import { keyForLabel, specKey, expectedKeys, isRegionDependent, type SpecDataType } from './registry/specKeys';
import { isMachine, type ProductType } from './registry/types';
import { modelsInText } from './registry/models';
import { US_VERSION_CONDITION } from './registry/labels';
import { toStored, round } from './registry/units';
import {
  bareNumbers,
  deriveCbm,
  dimsToMm,
  findDims,
  findWeights,
  isMultiBoxNote,
  weightToG,
  type Measure,
} from './logistics';
import { classifySentence, scrubProse } from './sentences';

export type SpecStatus = 'verified' | 'unverified' | 'not_found' | 'not_published' | 'not_applicable' | 'unknown';
export type ScopeKind = 'product' | 'option_value' | 'variant';
export type Region = '' | 'us_110v' | 'intl_220v';

/** One product_spec_values row (0194), minus product_id and timestamps. */
export interface SpecRow {
  id: string;
  key: string;
  group: string;
  scopeKind: ScopeKind;
  scopeId: string;
  region: Region;
  dataType: SpecDataType;
  originalLabel: string;
  originalValue: string;
  valueText: string;
  valueNum: number | null;
  valueNumMax: number | null;
  valueBool: 0 | 1 | null;
  valueList: unknown[];
  unit: string;
  status: SpecStatus;
  confidence: 'official_variant' | 'official_doc' | 'official_page' | 'component_maker' | 'independent' | 'derived';
  sourceKind: 'store_page' | 'store_messages' | 'store_doc' | 'tds' | 'sds' | 'manual' | 'wiki' | 'curated' | 'derived';
  sourceRef: string;
  sourceTitle: string;
  sourceLocator: string;
  sourceExcerpt: string;
  testMethod: string;
  testCondition: string;
  derivedFrom: string;
  missingReason: '' | 'not_found_in_checked_sources' | 'not_published_by_manufacturer' | 'not_applicable';
  checkedSources: Array<{ kind: string; url: string; title: string }>;
  visibility: 'public' | 'owner';
  conflict: string;
  sort: number;
}

export interface SpecNote {
  kind: 'spec_sources_disagree' | 'region_value' | 'sentence_withheld' | 'translation_review';
  field: string;
  detail: string;
}

export interface SpecContext {
  productId: string;
  productType: ProductType;
  canonicalUrl: string;
  retrievedAt: string;
  model: OptionModel;
  /** identity.model token ('' when unknown): "AMS Combo:" scopes to "H2D AMS Combo" on an H2D. */
  modelToken: string;
}

export interface SpecResult {
  rows: SpecRow[];
  notes: SpecNote[];
  /** True when a US (100–120 V) table was read. */
  usTable: boolean;
  /** Region purchase advice and voltage bullets (recorded, not shown). */
  regionEvidence: string[];
  /** Feature bullets that are neither specs nor relation evidence: the "Highlights" block. */
  highlights: string[];
  /** Feature bullets that are relation evidence (compatibility, requirements). */
  relationBullets: string[];
  /** Matrix and comparison tables kept as text (for curation). */
  matrixTables: number;
  /** Unknown labels (x.* keys), for the P0 label-coverage report. */
  unknownLabels: string[];
}

const STORE_TITLE = 'Bambu Lab US store product page';
const MAX_EXCERPT = 200;
const cut = (s: string, n = MAX_EXCERPT) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

export const specRowId = (productId: string, key: string, scopeKind: ScopeKind, scopeId: string, region: Region) =>
  `sv_${H(`${productId}:${key}:${scopeKind}:${scopeId}:${region}`)}`;

const US_TABLE = /100\s*[-–~]\s*120\s*V|@\s*110\s*V\b|\b110\s*V(?:AC)?\b|\b120\s*V(?:AC)?\b/i;

function baseRow(ctx: SpecContext, key: string, init: Partial<SpecRow>): SpecRow {
  const def = specKey(key);
  const row: SpecRow = {
    id: '',
    key,
    group: def?.group ?? (key.startsWith('x.') ? 'other' : key.split('.')[0]),
    scopeKind: 'product',
    scopeId: '',
    region: '',
    dataType: def?.type ?? 'string',
    originalLabel: '',
    originalValue: '',
    valueText: '',
    valueNum: null,
    valueNumMax: null,
    valueBool: null,
    valueList: [],
    unit: def?.unit ?? '',
    status: 'unverified',
    confidence: 'official_page',
    sourceKind: 'store_page',
    sourceRef: ctx.canonicalUrl,
    sourceTitle: STORE_TITLE,
    sourceLocator: '',
    sourceExcerpt: '',
    testMethod: '',
    testCondition: '',
    derivedFrom: '',
    missingReason: '',
    checkedSources: [],
    visibility: def?.ownerOnly ? 'owner' : 'public',
    conflict: '',
    sort: 0,
    ...init,
  };
  row.originalValue = cut(row.originalValue, 1000);
  row.sourceLocator = cut(row.sourceLocator);
  row.sourceExcerpt = cut(row.sourceExcerpt);
  return row;
}

/** Applies the §C.6 region rule to a row read from a US table. */
function applyRegion(row: SpecRow, ctx: SpecContext, us: boolean): SpecRow {
  if (us && isRegionDependent(row.key, ctx.productType)) {
    row.region = 'us_110v';
    if (row.status === 'verified') row.status = 'unverified';
    row.testCondition = US_VERSION_CONDITION;
  }
  return row;
}

// ---------------------------------------------------------------- typed values

interface Typed {
  valueText: string;
  valueNum: number | null;
  valueNumMax: number | null;
  valueBool: 0 | 1 | null;
  valueList: unknown[];
  unit: string;
  ambiguous: boolean;
}

const YES = /^(yes|supported|support|equipped|included|available|✓|√|enabled)\b/i;
const NO = /^(no|not supported|none|n\/a|not available|not included|×|✗|unsupported)\b/i;

/** Types a value by its key's data type. `ambiguous` means more than one reading. */
export function typeValue(text: string, type: SpecDataType, keyUnit: string): Typed {
  const t = collapseWs(text.replace(/\n/g, ' / '));
  const base: Typed = { valueText: t, valueNum: null, valueNumMax: null, valueBool: null, valueList: [], unit: keyUnit, ambiguous: false };
  if (!t) return { ...base, ambiguous: true };
  switch (type) {
    case 'number':
    case 'range': {
      const all = [...t.replace(/(\d),(?=\d{3}(?!\d))/g, '$1').matchAll(/(\d+(?:[.,]\d+)?)\s*(?:-|–|~|to)?\s*(\d+(?:[.,]\d+)?)?\s*(mm\/s²|mm\/s2|mm\/s|mm³\/s|kJ\/m²|g\/cm³|°C|℃|ºC|MPa|GPa|mAh|mA|kW|kg|lbs?|mm|cm|g|W|V|A|Hz|%|h|min|dB)?/gi)];
      const readings = all
        .map((m) => {
          const v = Number(m[1].replace(',', '.'));
          const max = m[2] ? Number(m[2].replace(',', '.')) : null;
          const unit = m[3] ?? '';
          const conv = unit ? toStored(v, unit) : null;
          const convMax = unit && max !== null ? toStored(max, unit) : null;
          return { v: conv ? conv.value : v, max: convMax ? convMax.value : max, unit: conv ? conv.unit : unit };
        })
        .filter((r) => r.unit || !keyUnit);
      if (!readings.length) return { ...base, ambiguous: true };
      const distinct = new Set(readings.map((r) => `${r.v}|${r.max}|${r.unit}`));
      const r = readings[0];
      const unitOk = !keyUnit || r.unit === keyUnit || (keyUnit === '°C' && r.unit === '°C');
      return {
        ...base,
        valueNum: round(r.v, 4),
        valueNumMax: r.max !== null ? round(r.max, 4) : null,
        unit: r.unit || keyUnit,
        ambiguous: distinct.size > 1 || !unitOk,
      };
    }
    case 'boolean': {
      if (YES.test(t)) return { ...base, valueBool: 1 };
      if (NO.test(t)) return { ...base, valueBool: 0 };
      return { ...base, ambiguous: true };
    }
    case 'list': {
      const items = text
        .split(/\n|;|,(?![^(]*\))/)
        .map((s) => collapseWs(s))
        .filter(Boolean);
      return { ...base, valueList: items };
    }
    case 'object': {
      const dims = findDims(t);
      const mm = dims.length ? dimsToMm(dims[0]) : null;
      if (!mm) return { ...base, ambiguous: true };
      return {
        ...base,
        valueList: mm.map((m) => m.value),
        valueText: `${mm.map((m) => m.value).join(' × ')} mm`,
        unit: 'mm',
        ambiguous: dims.length > 1,
      };
    }
    default:
      return base;
  }
}

// ---------------------------------------------------------------- the composite cell (§C.6)

export type CompositeTarget =
  | 'product_dims'
  | 'package_dims'
  | 'carton_dims'
  | 'physical.recommended_space'
  | 'product.net_weight'
  | 'package.weight'
  | 'shipment.gross_weight'
  | 'carton.weight';

const SUB_LABELS: ReadonlyArray<[RegExp, CompositeTarget]> = [
  [/\b(?:package|packaging|packing|packed|box|shipping box)\s*(?:size|dimensions?)\b/i, 'package_dims'],
  [/\bcarton\s*(?:size|dimensions?)\b/i, 'carton_dims'],
  [/\brecommended\s+space\b/i, 'physical.recommended_space'],
  [/\b(?:product|printer|machine|item|body)\s*(?:size|dimensions?)\b/i, 'product_dims'],
  [/\bgross\s+weight\b/i, 'shipment.gross_weight'],
  [/\b(?:package|packaging|packing)\s+weight\b/i, 'package.weight'],
  [/\bcarton\s+weight\b/i, 'carton.weight'],
  [/\bnet\s+weight\b/i, 'product.net_weight'],
];

/** The default target of a logistics row label, or null when the row is not a logistics row. */
export function logisticsTargetOfLabel(label: string): CompositeTarget | null {
  const k = labelKey(label);
  if (/^(physical dimensions?|dimensions?|product size|product dimensions?|size|overall dimensions?|printer dimensions?|machine size|body size)$/.test(k)) return 'product_dims';
  if (/^(packag(e|ing) size|packag(e|ing) dimensions?|box size|packing size)$/.test(k)) return 'package_dims';
  if (/^(packag(e|ing) weight|packing weight|packaged weight)$/.test(k)) return 'package.weight';
  if (/^(net weight|weight|product weight|printer weight|item weight)$/.test(k)) return 'product.net_weight';
  if (/^gross weight$/.test(k)) return 'shipment.gross_weight';
  if (/^carton (size|dimensions?)$/.test(k)) return 'carton_dims';
  if (/^carton weight$/.test(k)) return 'carton.weight';
  if (/^recommended space/.test(k)) return 'physical.recommended_space';
  return null;
}

export interface CompositeSegment {
  target: CompositeTarget;
  /** The option value the segment is scoped to, '' for product level, 'FOREIGN' for a version this product does not offer. */
  scope: string;
  measures: Measure[];
  excerpt: string;
  note: string;
}

const SCOPABLE: ReadonlySet<CompositeTarget> = new Set(['package_dims', 'package.weight', 'shipment.gross_weight', 'carton_dims', 'carton.weight']);
const DIMS_TARGETS: ReadonlySet<CompositeTarget> = new Set(['product_dims', 'package_dims', 'carton_dims', 'physical.recommended_space']);

/** The version value a segment prefix names, '' when it is not a scope, 'FOREIGN' when it names a version this product does not have. */
export function scopeOfPrefix(prefix: string, model: OptionModel, modelToken: string): string {
  const p = labelKey(prefix);
  if (!p) return '';
  const token = labelKey(modelToken);
  for (const g of model.groups) {
    if (g.kind !== 'version' && g.kind !== 'printer' && g.kind !== 'other') continue;
    for (const v of g.values) {
      const name = labelKey(sourceTextOf(v)); // the table names the version in the source's words
      if (name === p) return v.id;
      if (token && (name === `${token} ${p}` || name.replace(new RegExp(`^${token}\\s+`), '') === p)) return v.id;
    }
  }
  if (SUB_LABELS.some(([re]) => re.test(prefix))) return '';
  if (modelsInText(prefix).length || /\b(combo|bundle|edition|version|standard|kit)\b/i.test(prefix)) return 'FOREIGN';
  return '';
}

/**
 * The labelled sub-value parser: splits a cell at line breaks, `;`, a comma
 * before a word, and parenthesised groups; recognises sub-labels and version
 * prefixes; applies a trailing unit to every bare number of its list.
 */
export function compositeCell(cell: string, rowTarget: CompositeTarget, model: OptionModel, modelToken: string): CompositeSegment[] {
  // Soft line wraps are not segment breaks: "596*536*325\nmm³", "Gross\nweight", "Package size :\n596…".
  cell = cell.replace(/[ \t]*\n[ \t]*(?=[a-z(（³])/g, ' ').replace(/([:：,])[ \t]*\n[ \t]*/g, '$1 ');
  const pieces: string[] = [];
  let buf = '';
  for (let i = 0; i < cell.length; i++) {
    const ch = cell[i];
    if (ch === '(' || ch === ')' || ch === '\n' || ch === ';' || ch === '（' || ch === '）') {
      pieces.push(buf, ch === '（' ? '(' : ch === '）' ? ')' : ch);
      buf = '';
    } else if (ch === ',' && /^\s*[A-Za-z]/.test(cell.slice(i + 1)) && !/\d$/.test(buf.trimEnd().slice(-1) + '') ) {
      pieces.push(buf, ',');
      buf = '';
    } else buf += ch;
  }
  pieces.push(buf);

  interface Ctx { scope: string; label: CompositeTarget | null }
  const stack: Ctx[] = [{ scope: '', label: null }];
  const parenStart: number[] = [];
  const parenHadContent: Array<{ label: CompositeTarget | null; values: boolean; text: string }> = [];
  const out: Array<CompositeSegment & { bare: number[]; depth: number; unitless: boolean }> = [];
  let pendingNote = '';
  const cur = () => stack[stack.length - 1];

  for (const raw of pieces) {
    if (raw === '(') {
      stack.push({ ...cur() });
      parenStart.push(out.length);
      parenHadContent.push({ label: null, values: false, text: '' });
      continue;
    }
    if (raw === ')') {
      const info = parenHadContent.pop();
      const start = parenStart.pop() ?? out.length;
      if (stack.length > 1) stack.pop();
      if (info && !info.values) {
        if (info.label && start > 0) {
          // "700*700*1100 mm³ (Recommended Space for Printer)": a trailing label for the value before it.
          const prev = out[start - 1];
          if (prev && DIMS_TARGETS.has(prev.target) === DIMS_TARGETS.has(info.label)) prev.target = info.label;
        } else if (!info.label && info.text) {
          pendingNote = info.text;
        }
      }
      continue;
    }
    if (raw === '\n' || raw === ';' || raw === ',') {
      if (stack.length === 1) {
        if (raw !== ',') cur().scope = '';
        cur().label = null;
      } else {
        cur().scope = stack[stack.length - 2].scope;
      }
      continue;
    }
    let t = collapseWs(raw);
    if (!t) continue;
    if (parenHadContent.length) parenHadContent[parenHadContent.length - 1].text += (parenHadContent[parenHadContent.length - 1].text ? ' ' : '') + t;
    // Prefixes: "A1 Combo :", "Package size :", "Gross weight", "H2D AMS Combo:".
    for (let guard = 0; guard < 4; guard++) {
      const m = /^([^:：\d][^:：]{0,60}?)\s*[:：]\s*/.exec(t);
      if (m) {
        const scope = scopeOfPrefix(m[1], model, modelToken);
        if (scope) {
          cur().scope = scope;
          t = t.slice(m[0].length);
          continue;
        }
        const sub = SUB_LABELS.find(([re]) => re.test(m[1]));
        if (sub) {
          cur().label = sub[1];
          if (parenHadContent.length) parenHadContent[parenHadContent.length - 1].label = sub[1];
          t = t.slice(m[0].length);
          continue;
        }
      }
      const lead = SUB_LABELS.map(([re, target]) => ({ m: new RegExp(`^(?:${re.source})\\s*`, 'i').exec(t), target })).find((x) => x.m);
      if (lead?.m) {
        cur().label = lead.target;
        if (parenHadContent.length) parenHadContent[parenHadContent.length - 1].label = lead.target;
        t = t.slice(lead.m[0].length);
        continue;
      }
      break;
    }
    // A trailing sub-label without a colon ("… mm³ Recommended Space for Printer") labels this piece.
    const trailing = SUB_LABELS.find(([re]) => re.test(t));
    let target = cur().label ?? rowTarget;
    if (trailing && findDims(t).length + findWeights(t).length > 0) target = trailing[1];
    const wantsDims = DIMS_TARGETS.has(target);
    const measures: Measure[] = [];
    let unitless = false;
    const bare: number[] = [];
    if (wantsDims) {
      const d = findDims(t);
      if (d.length) {
        const mm = dimsToMm(d[0]) ?? dimsToMm(d[0], 'mm');
        if (mm) measures.push(...mm);
        unitless = !d[0].written;
      }
    } else {
      const w = findWeights(t);
      if (w.length) {
        const g = weightToG(w[0].value, w[0].written);
        if (g) measures.push(g);
      } else {
        for (const b of bareNumbers(t)) bare.push(b.value);
        unitless = bare.length > 0;
      }
    }
    if (parenHadContent.length && (measures.length || bare.length)) parenHadContent[parenHadContent.length - 1].values = true;
    if (!measures.length && !bare.length) continue;
    out.push({ target, scope: SCOPABLE.has(target) ? cur().scope : '', measures, excerpt: raw.trim(), note: pendingNote, bare, depth: stack.length, unitless });
    pendingNote = '';
  }
  // Trailing unit: bare numbers take the unit of the next (else previous) weight segment.
  out.forEach((s, i) => {
    if (s.measures.length || !s.bare.length) return;
    const later = out.slice(i + 1).find((x) => x.measures.length && !DIMS_TARGETS.has(x.target));
    const earlier = [...out.slice(0, i)].reverse().find((x) => x.measures.length && !DIMS_TARGETS.has(x.target));
    const unit = (later ?? earlier)?.measures[0]?.written;
    if (!unit) return;
    const g = weightToG(s.bare[0], unit);
    if (g) s.measures.push(g);
  });
  return out
    .filter((s) => s.measures.length)
    .map(({ target, scope, measures, excerpt, note }) => ({ target, scope, measures, excerpt, note }));
}

/** Spec rows of one composite segment. */
function rowsOfSegment(seg: CompositeSegment, ctx: SpecContext, base: Partial<SpecRow>): SpecRow[] {
  const scope: Partial<SpecRow> = seg.scope && seg.scope !== 'FOREIGN' ? { scopeKind: 'option_value', scopeId: seg.scope } : {};
  const common = { ...base, ...scope, sourceExcerpt: seg.excerpt, testCondition: seg.note };
  const verified = (r: SpecRow) => ({ ...r, status: 'verified' as SpecStatus });
  switch (seg.target) {
    case 'product_dims':
    case 'package_dims':
    case 'carton_dims': {
      const prefix = seg.target === 'product_dims' ? 'product' : seg.target === 'package_dims' ? 'package' : 'carton';
      return ['length', 'width', 'height'].map((edge, i) =>
        verified(baseRow(ctx, `${prefix}.${edge}`, { ...common, dataType: 'number', valueNum: seg.measures[i].value, unit: 'mm', valueText: `${seg.measures[i].value} mm` }))
      );
    }
    case 'physical.recommended_space':
      return [
        verified(
          baseRow(ctx, 'physical.recommended_space', {
            ...common,
            dataType: 'object',
            valueList: seg.measures.map((m) => m.value),
            valueText: `${seg.measures.map((m) => m.value).join(' × ')} mm`,
            unit: 'mm',
          })
        ),
      ];
    default:
      return [verified(baseRow(ctx, seg.target, { ...common, dataType: 'number', valueNum: seg.measures[0].value, unit: 'g', valueText: `${seg.measures[0].value} g` }))];
  }
}

// ---------------------------------------------------------------- tables

/** Rows that are one item of a [group, label, value] matrix ("Supported Filament": PLA… — Ideal); finalize joins them. */
const MATRIX_ITEMS = new WeakSet<SpecRow>();

export interface Pair {
  label: string;
  value: string;
  group: string;
  locator: string;
}

const HEADER_WORDS = /^(item|items|specification|specifications|parameter|parameters|spec|specs|value|values|name|details)$/i;

/** Label/value pairs of a key/value table, or null for a matrix / comparison table. */
export function pairsOfGrid(grid: TableGrid, where: string): { pairs: Pair[]; notes: string[] } | null {
  const pairs: Pair[] = [];
  const notes: string[] = [];
  const width = Math.max(0, ...grid.rows.map((r) => r.length));
  if (width === 0) return { pairs, notes };
  if (width > 4) return null;
  grid.rows.forEach((row, r) => {
    if (r < grid.headerRows) return;
    const cells = row.map((c) => c.trim());
    const orig = grid.original[r] ?? [];
    const loc = `${where} › row ${r + 1}`;
    const distinct = cells.filter((c, i) => i === 0 || c !== cells[i - 1]);
    if (distinct.length === 1) {
      if (cells[0]) notes.push(cells[0]);
      return;
    }
    if (cells.every((c) => HEADER_WORDS.test(c) || /specification$/i.test(c))) return;
    if (width === 4 && orig[1] && orig[2]) {
      if (cells[0] && !HEADER_WORDS.test(cells[0])) pairs.push({ label: cells[0], value: cells[1], group: '', locator: `${loc} › pair 1` });
      if (cells[2] && cells[3] !== undefined) pairs.push({ label: cells[2], value: cells[3], group: '', locator: `${loc} › pair 2` });
      return;
    }
    if (width === 2) {
      if (cells[0] && !HEADER_WORDS.test(cells[0])) pairs.push({ label: cells[0], value: cells[1] ?? '', group: '', locator: loc });
      return;
    }
    if (width === 3 || width === 4) {
      // [label (colspan 2), value] → label=cells[0]; [label, value (colspan 2)] → value=cells[1]; else [group, label, value].
      if (cells[0] === cells[1] && !orig[1]) pairs.push({ label: cells[0], value: cells[2] ?? '', group: '', locator: loc });
      else if (cells[1] === cells[2] && !orig[2]) pairs.push({ label: cells[0], value: cells[1], group: '', locator: loc });
      else pairs.push({ label: cells[1], value: cells[2] ?? '', group: cells[0], locator: loc });
      return;
    }
  });
  return { pairs, notes };
}

/** Rows of one label/value pair. */
function rowsOfPair(rawPair: Pair, ctx: SpecContext, us: boolean, sourceKind: SpecRow['sourceKind'], sort: number, out: SpecResult): SpecRow[] {
  const pair = { ...rawPair, group: collapseWs(rawPair.group) };
  const label = collapseWs(pair.label.replace(/\*+$/, ''));
  if (!label) return [];
  const base: Partial<SpecRow> = {
    originalLabel: pair.group && pair.group !== label ? `${pair.group} › ${label}` : label,
    originalValue: pair.value,
    sourceKind,
    sourceLocator: pair.locator,
    sourceExcerpt: collapseWs(pair.value.replace(/\n/g, ' ')),
    sort,
  };
  // Every sentence of the cell is classified (§C.10): money, promotion and policy sentences are removed,
  // voltage purchase advice is region evidence, warranty sentences are withheld; the rest is the value.
  const scrubbed = scrubProse(pair.value);
  out.regionEvidence.push(...scrubbed.region.map((r) => collapseWs(r)));
  if (scrubbed.withheld.length) out.notes.push({ kind: 'sentence_withheld', field: label, detail: 'a manufacturer warranty / return sentence in a spec cell was withheld (L-19)' });
  if (!scrubbed.kept.trim()) return [];
  if (scrubbed.kept !== pair.value) {
    pair.value = scrubbed.kept;
    base.originalValue = scrubbed.kept;
    base.sourceExcerpt = collapseWs(scrubbed.kept.replace(/\n/g, ' '));
  }
  const target = logisticsTargetOfLabel(label);
  if (target) {
    const segs = compositeCell(pair.value, target, ctx.model, ctx.modelToken);
    const rows: SpecRow[] = [];
    // Several measures of one target with nothing naming whose they are (PEI plate: three package
    // sizes for three plate sizes): not attributable, so one unverified text row per key, no number.
    const perTarget = new Map<string, CompositeSegment[]>();
    for (const s of segs) {
      if (s.scope === 'FOREIGN' && SCOPABLE.has(s.target)) continue;
      perTarget.set(`${s.target}|${s.scope}`, [...(perTarget.get(`${s.target}|${s.scope}`) ?? []), s]);
    }
    const unattributed = new Set<CompositeSegment>();
    for (const list of perTarget.values()) if (list.length > 1) for (const s of list) unattributed.add(s);
    for (const [tk, list] of perTarget) {
      if (list.length < 2) continue;
      const [tgt] = tk.split('|') as [CompositeTarget];
      const keys =
        tgt === 'product_dims' || tgt === 'package_dims' || tgt === 'carton_dims'
          ? ['length', 'width', 'height'].map((e) => `${tgt === 'product_dims' ? 'product' : tgt === 'package_dims' ? 'package' : 'carton'}.${e}`)
          : [tgt];
      keys.forEach((key, i) => {
        const vals = list.map((s) => (keys.length === 3 ? s.measures[i]?.value : s.measures[0]?.value)).filter((v) => v !== undefined);
        const unit = tgt === 'physical.recommended_space' || keys.length === 3 ? 'mm' : 'g';
        rows.push(
          applyRegion(
            baseRow(ctx, key, {
              ...base,
              dataType: 'string',
              valueText: `${vals.join(' / ')} ${unit}`,
              unit,
              status: 'unverified',
              testCondition: 'several values, not attributable to one option value',
            }),
            ctx,
            us
          )
        );
      });
    }
    for (const s of segs) {
      if (unattributed.has(s)) continue;
      if (s.scope === 'FOREIGN' && SCOPABLE.has(s.target)) {
        out.notes.push({ kind: 'region_value', field: s.target, detail: 'a measure scoped to a version this product does not offer was not written' });
        continue;
      }
      rows.push(...rowsOfSegment(s, ctx, base).map((r) => applyRegion(r, ctx, us)));
    }
    if (rows.length) return rows;
  }
  // A group label that is a key and a label that is not (the "Supported Filament" matrix): a list item.
  // "Chamber Temperature Control › Max Temperature": the group's first word qualifies a generic label.
  let def = keyForLabel(label, ctx.productType) ?? (pair.group ? keyForLabel(`${pair.group.split(/\s+/)[0]} ${label}`, ctx.productType) : null);
  let value = pair.value;
  let matrixItem = false;
  if (!def && pair.group) {
    const g = keyForLabel(pair.group, ctx.productType);
    if (g && (g.type === 'list' || g.type === 'string')) {
      def = g;
      value = `${collapseWs(label.replace(/\n/g, ' '))} — ${collapseWs(pair.value.replace(/\n/g, ' '))}`;
      base.originalLabel = pair.group;
      matrixItem = true;
    }
  }
  if (!def) {
    const slug = slugOf(label, 70);
    out.unknownLabels.push(label);
    return [applyRegion(baseRow(ctx, `x.${slug}`, { ...base, dataType: 'string', valueText: collapseWs(value.replace(/\n/g, ' / ')), status: 'unverified' }), ctx, us)];
  }
  const typed = matrixItem ? { ...typeValue(value, 'string', ''), valueList: [value] } : typeValue(value, def.type, def.unit);
  const status: SpecStatus = typed.ambiguous ? 'unverified' : 'verified';
  const row = applyRegion(
      baseRow(ctx, def.key, {
        ...base,
        dataType: def.type,
        valueText: typed.valueText,
        valueNum: typed.valueNum,
        valueNumMax: typed.valueNumMax,
        valueBool: typed.valueBool,
        valueList: typed.valueList,
        unit: typed.unit,
        status,
      }),
      ctx,
      us
    );
  if (matrixItem) MATRIX_ITEMS.add(row);
  return [row];
}

// ---------------------------------------------------------------- feature bullets (§C.5)

const COMPAT_BULLET = /\bcompatib|\bworks with\b|\bfits\b/i;
const REQUIRE_BULLET = /\b(needs? to be used with|must be used with|requires?|required)\b/i;
const VOLTAGE_BULLET = /\bvoltage\b|\b\d{2,3}\s*-\s*\d{2,3}\s*V\b/i;

function featureBullets(features: ReadonlyArray<{ title: string; html: string }>): string[] {
  const out: string[] = [];
  for (const f of features) {
    if (!f.html) continue;
    const nodes = parseHtml(f.html);
    for (const li of findAll(nodes, (n) => n.type === 'el' && n.tag === 'li')) out.push(textOf((li as ElementNode).children));
    // Notes outside lists ("Note: The refill needs to be used with a spool.")
    for (const p of findAll(nodes, (n) => n.type === 'el' && (n.tag === 'p' || n.tag === 'div') && !findAll(n.children, (x) => x.type === 'el' && (x.tag === 'ul' || x.tag === 'div' || x.tag === 'li')).length)) {
      const t = textOf((p as ElementNode).children);
      if (t && !out.includes(t)) out.push(t);
    }
  }
  return out.map((s) => collapseWs(s)).filter(Boolean);
}

function rowsOfBullets(bullets: string[], ctx: SpecContext, featuresTitle: string, out: SpecResult): SpecRow[] {
  const rows: SpecRow[] = [];
  bullets.forEach((b, i) => {
    const locator = `${featuresTitle || 'Product Features'} › bullet ${i + 1}`;
    if (VOLTAGE_BULLET.test(b)) {
      out.regionEvidence.push(b);
      if (/100\s*[-–]\s*120/.test(b)) {
        const m = /^([^:]+):\s*(.+)$/.exec(b);
        rows.push(
          baseRow(ctx, 'electrical.voltage', {
            originalLabel: m?.[1] ?? 'Voltage',
            originalValue: b,
            valueText: collapseWs(m?.[2] ?? b),
            region: 'us_110v',
            status: 'unverified',
            testCondition: US_VERSION_CONDITION,
            sourceLocator: locator,
            sourceExcerpt: b,
          })
        );
      }
      return;
    }
    if (COMPAT_BULLET.test(b) || REQUIRE_BULLET.test(b)) {
      out.relationBullets.push(b);
      return;
    }
    const m = /^([^:：]{2,40})\s*[:：]\s*(.+)$/.exec(b);
    if (m) {
      const label = collapseWs(m[1].replace(/^note$/i, ''));
      const value = m[2];
      if (/^diameter$/i.test(label)) {
        const d = /(\d+(?:\.\d+)?)\s*mm\s*(?:\+\/-|±|\+-)\s*(\d+(?:\.\d+)?)\s*mm/i.exec(value);
        if (d) {
          rows.push(
            baseRow(ctx, 'material.diameter', { originalLabel: label, originalValue: value, dataType: 'number', valueNum: Number(d[1]), unit: 'mm', valueText: `${d[1]} mm`, status: 'verified', sourceLocator: locator, sourceExcerpt: b, sort: 500 + i }),
            baseRow(ctx, 'material.diameter_tolerance', { originalLabel: label, originalValue: value, dataType: 'number', valueNum: Number(d[2]), unit: 'mm', valueText: `± ${d[2]} mm`, status: 'verified', sourceLocator: locator, sourceExcerpt: b, sort: 501 + i })
          );
          return;
        }
      }
      const def = label ? keyForLabel(label, ctx.productType) : null;
      if (def) {
        const typed = typeValue(value, def.type, def.unit);
        rows.push(
          baseRow(ctx, def.key, {
            originalLabel: label,
            originalValue: value,
            dataType: def.type,
            valueText: typed.valueText,
            valueNum: typed.valueNum,
            valueNumMax: typed.valueNumMax,
            valueBool: typed.valueBool,
            valueList: typed.valueList,
            unit: typed.unit,
            status: typed.ambiguous ? 'unverified' : 'verified',
            sourceLocator: locator,
            sourceExcerpt: b,
            sort: 500 + i,
          })
        );
        return;
      }
    }
    out.highlights.push(b);
  });
  return rows;
}

// ---------------------------------------------------------------- option values (§C.2, §C.6)

function rowsOfOptions(ctx: SpecContext): SpecRow[] {
  const rows: SpecRow[] = [];
  for (const g of ctx.model.groups) {
    for (const v of g.values) {
      // A value with a reviewed label (§E.1) shows a name the source did not write: nothing is parsed out of it.
      if (v.labelled) continue;
      const scope = { scopeKind: 'option_value' as const, scopeId: v.id, confidence: 'official_variant' as const, sourceLocator: `option ${g.sourceLabel} › ${v.nameEn}`, sourceExcerpt: v.nameEn, originalLabel: g.sourceLabel, originalValue: v.nameEn };
      if (g.canonical === 'net_weight') {
        const w = findWeights(v.nameEn)[0];
        const gram = w ? weightToG(w.value, w.written) : null;
        if (gram) rows.push(baseRow(ctx, ctx.productType === 'filament' ? 'material.net_weight' : 'product.net_weight', { ...scope, dataType: 'number', valueNum: gram.value, unit: 'g', valueText: `${gram.value} g`, status: 'verified' }));
      }
      if (g.kind === 'nozzle') {
        const m = /(\d(?:\.\d+)?)\s*mm\s*(.*)$/i.exec(v.nameEn);
        if (m) {
          rows.push(baseRow(ctx, 'nozzle.diameter', { ...scope, dataType: 'number', valueNum: Number(m[1]), unit: 'mm', valueText: `${m[1]} mm`, status: 'verified' }));
          // "(Standard Included)" (bambu-hotend-x1c) says what ships, not what the nozzle is made of.
          const material = collapseWs(m[2].replace(/\([^)]*\)/g, ' ').replace(/\b(nozzle|hotend)\b/gi, ''));
          if (material) rows.push(baseRow(ctx, 'nozzle.material', { ...scope, dataType: 'string', valueText: material, status: 'verified' }));
        }
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------- the whole product

export interface SpecInputs {
  described: Described;
  features: ReadonlyArray<{ title: string; html: string }>;
  featuresTitle: string;
}

/** Every spec row the store page supports for one product, finalised (deduplicated, not_found, CBM). */
export function buildSpecs(inp: SpecInputs, ctx: SpecContext): SpecResult {
  const out: SpecResult = { rows: [], notes: [], usTable: false, regionEvidence: [], highlights: [], relationBullets: [], matrixTables: 0, unknownLabels: [] };
  let sort = 0;
  const raw: SpecRow[] = [];
  // A bundle page (build-plate combo) holds one specification table per COMPONENT, each under its own
  // top-level section: those rows describe a component, not the product, so they keep the component's
  // name in an x.* key and never feed the product's keys or its CBM.
  const rootOf = (path: string) => /^(sections\[\d+\])\s+(.*?)(?:\s›\s\d+)?$/.exec(path);
  const specRoots = new Set(
    inp.described.sections.filter((s) => s.kind === 'specs' && s.blocks.some((b) => b.t === 'table')).map((s) => rootOf(s.path)?.[1] ?? '')
  );
  const componentMode = specRoots.size > 1 && !specRoots.has('');
  const pageUs = inp.described.sections.some((s) => s.blocks.some((b) => b.t === 'table' && b.grid.rows.some((r) => r.some((c) => US_TABLE.test(c)))));
  for (const s of inp.described.sections) {
    const component = componentMode ? (rootOf(s.path)?.[2] ?? '') : '';
    for (const b of s.blocks) {
      if (b.t !== 'table') continue;
      const grid = b.grid;
      const parsed = s.kind === 'specs' || s.kind === 'other' ? pairsOfGrid(grid, `${s.title || 'Specifications'}`) : null;
      if (!parsed) {
        out.matrixTables++;
        continue;
      }
      // A US (100–120 V) table marks every table of a machine's page: its continuation tables describe the same US box.
      const us = grid.rows.some((r) => r.some((c) => US_TABLE.test(c))) || (pageUs && isMachine(ctx.productType));
      if (us) out.usTable = true;
      for (const n of [...parsed.notes, ...(b.note ? [b.note] : [])]) {
        const cls = classifySentence(n);
        if (cls === 'region') out.regionEvidence.push(n);
      }
      for (const p of parsed.pairs) {
        const rows = rowsOfPair(p, ctx, us, 'store_page', sort++, out);
        if (component && s.kind === 'specs') {
          for (const r of rows) {
            r.key = `x.${slugOf(`${component} ${r.key.replace(/^x\./, '')}`, 76)}`;
            r.group = 'other';
            r.originalLabel = cut(`${component} › ${r.originalLabel}`);
            r.sourceLocator = cut(`${component} › ${r.sourceLocator}`);
            r.status = 'unverified';
          }
        }
        raw.push(...rows);
      }
    }
  }
  if (inp.described.specPairs.length) {
    for (const p of inp.described.specPairs) {
      raw.push(...rowsOfPair({ label: p.label, value: p.value, group: p.group, locator: p.locator }, ctx, false, 'store_messages', sort++, out));
    }
  }
  raw.push(...rowsOfBullets(featureBullets(inp.features), ctx, inp.featuresTitle, out));
  raw.push(...rowsOfOptions(ctx));
  out.rows = finalize(raw, ctx, out);
  out.unknownLabels = [...new Set(out.unknownLabels.map((l) => collapseWs(l)))];
  return out;
}

/** Variant notes (§C.3): classified; what remains is a variant-scoped note; a multi-box note stops CBM for its versions. */
export function variantNoteRows(ctx: SpecContext): { rows: SpecRow[]; multiBoxScopes: Set<string>; withheld: string[] } {
  const rows: SpecRow[] = [];
  const multiBoxScopes = new Set<string>();
  const withheld: string[] = [];
  for (const v of ctx.model.variants) {
    if (!v.note) continue;
    const text = textOf(parseHtml(v.note), { lines: true });
    if (!text) continue;
    const scrub = scrubProse(text);
    withheld.push(...scrub.withheld);
    if (isMultiBoxNote(text)) {
      multiBoxScopes.add(v.id);
      for (const id of v.valueIds) {
        const g = ctx.model.groups.find((gr) => gr.values.some((x) => x.id === id));
        if (g && (g.kind === 'version' || g.kind === 'other')) multiBoxScopes.add(id);
      }
    }
    if (scrub.kept) {
      rows.push(baseRow(ctx, 'variant.note', { scopeKind: 'variant', scopeId: v.id, valueText: scrub.kept, originalValue: text, status: 'unverified', sourceLocator: `variant ${v.sourceId} › description`, sourceExcerpt: scrub.kept }));
    }
  }
  return { rows, multiBoxScopes, withheld };
}

/** Two readings agree when the numbers of one are a leading run of the other's ("100-120 V" / "100-120 VAC, 50/60 Hz"). */
function agrees(a: string, b: string): boolean {
  const na = a.match(/\d+(?:\.\d+)?/g) ?? [];
  const nb = b.match(/\d+(?:\.\d+)?/g) ?? [];
  if (!na.length || !nb.length) return false;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  return short.every((x, i) => x === long[i]);
}

function finalize(raw: SpecRow[], ctx: SpecContext, out: SpecResult): SpecRow[] {
  const byKey = new Map<string, SpecRow>();
  const ordered: SpecRow[] = [];
  for (const r of raw) {
    let key = r.key;
    let k = `${key}|${r.scopeKind}|${r.scopeId}|${r.region}`;
    const prev = byKey.get(k);
    if (prev) {
      const table = (loc: string) => (loc.includes(' › row ') ? loc.slice(0, loc.indexOf(' › row ')) : '');
      const sameTableOtherLabel = !key.startsWith('x.') && !!table(prev.sourceLocator) && table(prev.sourceLocator) === table(r.sourceLocator) && prev.originalLabel !== r.originalLabel;
      const same = prev.valueText === r.valueText && prev.valueNum === r.valueNum;
      if (same && !sameTableOtherLabel) continue;
      if (!sameTableOtherLabel && agrees(prev.valueText, r.valueText)) continue;
      if (MATRIX_ITEMS.has(prev) && MATRIX_ITEMS.has(r) && prev.sourceKind === r.sourceKind) {
        prev.valueList = [...prev.valueList, ...r.valueList];
        prev.valueText = `${prev.valueText}\n${r.valueText}`;
        prev.originalValue = cut(`${prev.originalValue}\n${r.originalValue}`, 1000);
        prev.sourceLocator = cut(`${prev.sourceLocator}; ${r.sourceLocator.replace(/^.* › /, '')}`);
        continue;
      }
      if (sameTableOtherLabel) {
        // Two different labels of one table that mean the same key ("Live View Camera", "Nozzle Camera"): the later keeps its own words.
        key = `x.${slugOf(r.originalLabel.replace(/ › /g, ' '), 70)}`;
        r.key = key;
        r.status = 'unverified';
        out.unknownLabels.push(r.originalLabel);
        k = `${key}|${r.scopeKind}|${r.scopeId}|${r.region}`;
        if (byKey.has(k)) {
          let n = 2;
          while (byKey.has(`${key}_${n}|${r.scopeKind}|${r.scopeId}|${r.region}`)) n++;
          key = `${key}_${n}`;
          r.key = key;
          k = `${key}|${r.scopeKind}|${r.scopeId}|${r.region}`;
        }
        byKey.set(k, r);
        ordered.push(r);
        continue;
      }
      if (key.startsWith('x.')) {
        // Two different unknown labels with the same slug: keep both, numbered.
        let n = 2;
        while (byKey.has(`${key}_${n}|${r.scopeKind}|${r.scopeId}|${r.region}`)) n++;
        key = `${key}_${n}`;
        k = `${key}|${r.scopeKind}|${r.scopeId}|${r.region}`;
        r.key = key;
      } else {
        prev.conflict = cut(`also published as: ${r.valueText}`, 300);
        if (prev.status === 'verified') prev.status = 'unverified';
        out.notes.push({ kind: 'spec_sources_disagree', field: r.key, detail: `${r.sourceLocator} differs from ${prev.sourceLocator}` });
        continue;
      }
    }
    byKey.set(k, r);
    ordered.push(r);
  }
  // CBM (§B.7), owner-only (L-4).
  const multi = variantNoteRows(ctx).multiBoxScopes;
  for (const c of deriveCbm(
    ordered.map((r) => ({ key: r.key, scopeKind: r.scopeKind, scopeId: r.scopeId, region: r.region, valueNum: r.valueNum, sourceKind: r.sourceKind, sourceLocator: r.sourceLocator })),
    { multiBoxScopes: multi, isPrinter: isMachine(ctx.productType) }
  )) {
    if (c.volume === null) {
      if (c.reason === 'multi_box' || c.reason === 'us_110v_only') out.notes.push({ kind: 'region_value', field: 'package.volume_m3', detail: `CBM not derived: ${c.reason}` });
      continue;
    }
    ordered.push(
      baseRow(ctx, 'package.volume_m3', {
        scopeKind: c.scopeKind,
        scopeId: c.scopeId,
        region: c.region as Region,
        dataType: 'number',
        valueNum: c.volume,
        unit: 'm³',
        valueText: `${c.volume} m³`,
        status: 'unverified',
        confidence: 'derived',
        sourceKind: 'derived',
        derivedFrom: c.derivedFrom,
        visibility: 'owner',
      })
    );
  }
  // Expected keys no checked source supplied (§C.6).
  const present = new Set(ordered.map((r) => r.key));
  for (const def of expectedKeys(ctx.productType)) {
    if (present.has(def.key)) continue;
    ordered.push(
      baseRow(ctx, def.key, {
        status: 'not_found',
        missingReason: 'not_found_in_checked_sources',
        checkedSources: [{ kind: 'store_page', url: ctx.canonicalUrl, title: STORE_TITLE }],
        sourceRef: '',
        sourceTitle: '',
        valueText: '',
        valueNum: null,
      })
    );
  }
  ordered.forEach((r, i) => {
    r.sort = i;
    r.id = specRowId(ctx.productId, r.key, r.scopeKind, r.scopeId, r.region);
  });
  return ordered;
}
