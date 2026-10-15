/**
 * RELATIONS FROM EVIDENCE ONLY (spec §B.6).
 *
 * A relation exists only because the source NAMES its target: an option value
 * (`Printer Model`, `Compatibility`), a compatibility section, a spec row, a
 * feature bullet ("All AMS Series Compatible") or a requirement sentence ("The
 * refill needs to be used with a spool"). Name similarity never creates one.
 *
 * Labels resolve only through the reviewed `data/bambu-import/compat-targets.json`
 * (passed in; this module reads no file):
 *   - `to.levonis_product_id`  → `resolved` at once;
 *   - `to.source_handle`       → `pending` on that handle (resolved by the target's own batch);
 *   - `family` + `members`     → one row per member, each pending or resolved, all carrying the
 *                                family key and the source's own label;
 *   - `alias_of`               → the aliased entry;
 *   - a `compounds` entry      → its atoms (compatible) and not-atoms (not compatible);
 *   - `reviewed_unresolvable`  → no row (reviewed: not a product target);
 *   - anything else            → one `unresolvable` row keeping the label, plus a
 *                                `relation_unresolvable` note.
 */
import { H } from './hash';
import { collapseWs, labelKey } from './normalize';
import { sourceTextOf, type OptionModel } from './options';
import type { Described } from './describe';
import { splitSentences } from './sentences';
import { modelsInText } from './registry/models';
import { parseHtml, textOf } from './html';

export type RelationKind =
  | 'compatible_with'
  | 'not_compatible_with'
  | 'requires'
  | 'recommended_with'
  | 'related'
  | 'replacement_for'
  | 'included_in'
  | 'includes';
export type TargetKind = 'printer' | 'ams' | 'hub' | 'buffer' | 'laser_module' | 'toolhead' | 'spool' | 'family' | 'part' | 'material' | 'other';
export type EvidenceKind = 'option_value' | 'compat_section' | 'spec_row' | 'feature_bullet' | 'description_text' | 'wiki_table' | 'manual' | 'curated';

/** One product_relations row (0194), minus product_id and timestamps. */
export interface RelationRow {
  id: string;
  scopeKind: 'product' | 'option_value' | 'variant';
  scopeId: string;
  relation: RelationKind;
  targetKind: TargetKind;
  targetProductId: string | null;
  targetSource: '' | 'bambu_us';
  targetSourceHandle: string;
  targetFamily: string;
  /** The source's own words. */
  targetLabel: string;
  state: 'resolved' | 'pending' | 'unresolvable';
  evidenceKind: EvidenceKind;
  /** ≤ 300 chars. */
  evidenceText: string;
}

export interface RelationNote {
  kind: 'relation_unresolvable';
  field: string;
  detail: string;
}

interface TargetRef {
  source_handle?: string;
  levonis_product_id?: string | null;
  levonis_model?: string;
}
export interface CompatEntry {
  kind?: string;
  reason?: string;
  to?: TargetRef;
  family?: string;
  members?: readonly TargetRef[];
  alias_of?: string;
  qualifier?: string;
}
/** The reviewed label file (only the fields this module reads). */
export interface CompatTargets {
  version: number;
  labels: Readonly<Record<string, CompatEntry>>;
  compounds?: Readonly<Record<string, { atoms: readonly string[]; not_atoms?: readonly string[]; relation?: string }>>;
  reviewed_unresolvable?: Readonly<Record<string, { reason?: string }>>;
  requirement_targets?: Readonly<Record<string, CompatEntry>>;
  requirement_unresolvable?: Readonly<Record<string, { reason?: string }>>;
}

export interface RelationResult {
  rows: RelationRow[];
  notes: RelationNote[];
  /** Labels the file lists as reviewed-unresolvable (no row written), for the report. */
  reviewedSkipped: string[];
}

export interface RelationInputs {
  productId: string;
  handle: string;
  model: OptionModel;
  described: Described;
  /** Feature bullets the spec parser classed as relation evidence (SpecResult.relationBullets). */
  relationBullets: readonly string[];
  /** Variant notes (HTML), scanned for requirement sentences scoped to their variant. */
  variantNotes?: ReadonlyArray<{ variantId: string; html: string }>;
  /** Spec rows that state compatibility (`compat.statement`). */
  compatStatements?: ReadonlyArray<{ text: string; locator: string }>;
  targets: CompatTargets | null;
}

const TARGET_KINDS: ReadonlySet<string> = new Set(['printer', 'ams', 'hub', 'buffer', 'laser_module', 'toolhead', 'spool', 'family', 'part', 'material', 'other']);
const asTargetKind = (k: string | undefined): TargetKind => (k && TARGET_KINDS.has(k) ? (k as TargetKind) : 'other');

const NOT_COMPATIBLE = /\bnot\s+compatible\b|\bincompatible\b|\bnot\s+(?:supported|recommended)\b|\bdoes\s+not\s+(?:fit|work)\b/i;
const REQUIRE = /\b(needs? to be used with|must be used with|requires?|required|is needed|are needed)\b/i;

export const relationRowId = (productId: string, r: Pick<RelationRow, 'relation' | 'scopeKind' | 'scopeId' | 'targetSourceHandle' | 'targetProductId' | 'targetFamily' | 'targetLabel'>) =>
  `pr_${H(`${productId}:${r.relation}:${r.scopeKind}:${r.scopeId}:${r.targetProductId ?? ''}:${r.targetSourceHandle}:${r.targetFamily}:${labelKey(r.targetLabel)}`)}`;

/** Case- and punctuation-insensitive index of a label table. */
function indexOf<T>(table: Readonly<Record<string, T>> | undefined): Map<string, [string, T]> {
  const m = new Map<string, [string, T]>();
  for (const [label, v] of Object.entries(table ?? {})) m.set(labelKey(label), [label, v]);
  return m;
}

/** The longest labels of an index found in a text, word-bounded, without overlap (longest first). */
function labelsInText(text: string, labels: ReadonlyMap<string, unknown>): string[] {
  let k = ` ${labelKey(text)} `;
  const found: string[] = [];
  for (const key of [...labels.keys()].sort((a, b) => b.length - a.length)) {
    if (!key) continue;
    const needle = ` ${key} `;
    if (k.includes(needle)) {
      found.push(key);
      k = k.split(needle).join(' '.repeat(needle.length));
    }
  }
  return found;
}

/** Builds every relation row a product's source evidence supports. */
export function buildRelations(inp: RelationInputs): RelationResult {
  const out: RelationResult = { rows: [], notes: [], reviewedSkipped: [] };
  const t = inp.targets ?? { version: 1, labels: {} };
  const labels = indexOf(t.labels);
  const compounds = indexOf(t.compounds);
  const reviewed = indexOf(t.reviewed_unresolvable);
  const reqTargets = indexOf(t.requirement_targets);
  const reqReviewed = indexOf(t.requirement_unresolvable);
  const seen = new Set<string>();
  const selfHandle = inp.handle;
  const compatKeys = new Map<string, unknown>([...labels, ...compounds, ...reviewed] as Array<[string, unknown]>);
  const requireKeys = new Map<string, unknown>([...reqTargets, ...reqReviewed] as Array<[string, unknown]>);

  const push = (r: Omit<RelationRow, 'id'>) => {
    const row: RelationRow = { ...r, evidenceText: cut(r.evidenceText), id: relationRowId(inp.productId, r) };
    if (seen.has(row.id)) return;
    seen.add(row.id);
    out.rows.push(row);
  };

  type Scope = { scopeKind: RelationRow['scopeKind']; scopeId: string };

  /** Rows for one resolved label entry. */
  const fromEntry = (label: string, entry: CompatEntry, relation: RelationKind, scope: Scope, ev: EvidenceKind, evText: string, table: Map<string, [string, CompatEntry]>, depth = 0): void => {
    if (entry.alias_of && depth < 4) {
      const target = table.get(labelKey(entry.alias_of)) ?? labels.get(labelKey(entry.alias_of));
      if (target) return fromEntry(label, target[1], relation, scope, ev, evText, table, depth + 1);
    }
    const base = { ...scope, relation, targetSource: '' as const, targetSourceHandle: '', targetFamily: '', targetLabel: label, evidenceKind: ev, evidenceText: evText };
    const one = (ref: TargetRef, kind: TargetKind, family: string): boolean => {
      if (ref.levonis_product_id) {
        push({ ...base, targetKind: kind, targetProductId: ref.levonis_product_id, targetFamily: family, state: 'resolved' });
        return true;
      }
      if (ref.source_handle) {
        if (ref.source_handle === selfHandle) return true; // a product is not related to itself
        push({ ...base, targetKind: kind, targetProductId: null, targetSource: 'bambu_us', targetSourceHandle: ref.source_handle, targetFamily: family, state: 'pending' });
        return true;
      }
      return false;
    };
    if (entry.to && one(entry.to, asTargetKind(entry.kind), '')) return;
    if (entry.members?.length) {
      let any = false;
      for (const m of entry.members) {
        const ok = one(m, 'family', entry.family ?? labelKey(label).replace(/\s+/g, '_'));
        // A member the reviewed file names without a resolvable id yet (an existing Levonis model awaiting the snapshot).
        if (!ok) out.notes.push({ kind: 'relation_unresolvable', field: relation, detail: 'family member without a resolvable target' });
        any = ok || any;
      }
      if (any) return;
    }
    unresolvable(label, relation, scope, ev, evText, entry.kind);
  };

  const unresolvable = (label: string, relation: RelationKind, scope: Scope, ev: EvidenceKind, evText: string, kind?: string) => {
    push({ ...scope, relation, targetKind: asTargetKind(kind), targetProductId: null, targetSource: '', targetSourceHandle: '', targetFamily: '', targetLabel: label, state: 'unresolvable', evidenceKind: ev, evidenceText: evText });
    out.notes.push({ kind: 'relation_unresolvable', field: relation, detail: `label not in compat-targets.json (${ev})` });
  };

  /**
   * A compatibility label, exactly as the source wrote it (an option value or a matched phrase).
   * `shown` is a reviewed display label (manifest value_labels): the lookup still reads the source's
   * words, but a label kept as unresolvable text shows the reviewed one, never refused source wording.
   */
  const compatLabel = (raw: string, relation: RelationKind, scope: Scope, ev: EvidenceKind, evText: string, splitUnknown: boolean, atom = false, shown = ''): void => {
    const label = collapseWs(raw);
    if (!label) return;
    const key = labelKey(label);
    // A compound ("X1 Series and P1 Series", "X1 and X1C (not for X1E)") expands to its reviewed atoms; atoms are labels, never compounds again.
    const compound = atom ? undefined : compounds.get(key);
    if (compound) {
      const flip = (r: RelationKind): RelationKind => (r === 'compatible_with' ? 'not_compatible_with' : r);
      for (const a of compound[1].atoms) compatLabel(a, relation, scope, ev, evText, false, true);
      for (const a of compound[1].not_atoms ?? []) compatLabel(a, flip(relation), scope, ev, evText, false, true);
      return;
    }
    const hit = labels.get(key);
    if (hit) return fromEntry(hit[0], hit[1], relation, scope, ev, evText, labels);
    if (reviewed.has(key)) {
      out.reviewedSkipped.push(reviewed.get(key)![0]);
      return;
    }
    if (splitUnknown && !shown) {
      // "X1 Series and P1 Series", "H2D/H2S", "A1, A1 mini": the parts, each by the file.
      const parts = label.split(/\s*(?:\/|,|;|&|\band\b|\bor\b)\s*/i).map((s) => s.trim()).filter(Boolean);
      if (parts.length > 1) {
        for (const p of parts) compatLabel(p, relation, scope, ev, evText, false, true);
        return;
      }
    }
    unresolvable(shown || label, relation, scope, ev, evText);
  };

  // 1. Option values naming a target: looked up by the source's own words (compat-targets.json is keyed by
  //    them); the evidence quotes the value as the product shows it (a reviewed label, when it has one).
  for (const g of inp.model.groups) {
    if (g.kind !== 'printer' && g.canonical !== 'compatibility' && g.canonical !== 'printer') continue;
    for (const v of g.values) {
      const shown = v.labelled ? v.nameEn : '';
      compatLabel(sourceTextOf(v), 'compatible_with', { scopeKind: 'option_value', scopeId: v.id }, 'option_value', `${g.sourceLabel}: ${v.nameEn}`, true, false, shown);
    }
  }

  // 2. Free text that names targets: compatibility sections, compatibility spec rows, feature bullets.
  const scanCompat = (text: string, ev: EvidenceKind) => {
    for (const s of splitSentences(text)) {
      const relation: RelationKind = NOT_COMPATIBLE.test(s) ? 'not_compatible_with' : 'compatible_with';
      const found = labelsInText(s, compatKeys);
      for (const key of found) {
        const label = (compounds.get(key) ?? labels.get(key) ?? reviewed.get(key))![0];
        compatLabel(label, relation, { scopeKind: 'product', scopeId: '' }, ev, s, false);
      }
      // A model the registry knows but the file does not list: kept as unresolvable, never guessed.
      if (!found.length) {
        for (const m of modelsInText(s)) {
          if (m.kind === 'spool') continue;
          compatLabel(m.token, relation, { scopeKind: 'product', scopeId: '' }, ev, s, false);
        }
      }
    }
  };
  for (const sec of inp.described.sections) {
    if (sec.kind !== 'compat') continue;
    for (const b of sec.blocks) {
      if (b.t === 'text') scanCompat(b.text, 'compat_section');
      else if (b.t === 'list') for (const i of b.items) scanCompat(i, 'compat_section');
    }
  }
  for (const s of inp.compatStatements ?? []) scanCompat(s.text, 'spec_row');

  // 3. Requirement sentences (bullets and description text) through requirement_targets.
  const scanRequire = (text: string, ev: EvidenceKind, scope: Scope = { scopeKind: 'product', scopeId: '' }) => {
    for (const s of splitSentences(text)) {
      if (!REQUIRE.test(s)) continue;
      for (const key of labelsInText(s, requireKeys)) {
        const hit = reqTargets.get(key);
        if (hit) fromEntry(hit[0], hit[1], 'requires', scope, ev, s, reqTargets);
        else out.reviewedSkipped.push(reqReviewed.get(key)![0]);
      }
    }
  };
  for (const b of inp.relationBullets) {
    if (REQUIRE.test(b)) scanRequire(b, 'feature_bullet');
    else scanCompat(b, 'feature_bullet');
  }
  for (const sec of inp.described.sections) {
    for (const b of sec.blocks) {
      if (b.t === 'text') scanRequire(b.text, 'description_text');
      else if (b.t === 'list') for (const i of b.items) scanRequire(i, 'description_text');
    }
  }
  for (const n of inp.variantNotes ?? []) scanRequire(textOf(parseHtml(n.html), { lines: true }), 'description_text', { scopeKind: 'variant', scopeId: n.variantId });
  for (const sec of inp.described.sections) {
    for (const b of sec.blocks) if (b.t === 'faq') scanRequire(b.answer, 'description_text');
  }
  out.reviewedSkipped = [...new Set(out.reviewedSkipped)];
  return out;
}

const cut = (s: string, n = 300) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
