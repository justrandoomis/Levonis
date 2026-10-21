/**
 * THE PRINT REQUEST MODEL, V3 — ONE READ PATH, AND WRITERS THAT KEEP THE V1
 * ROW (Community V3 §4.1–§4.3, plan P1-04, docs/DECISIONS.md row 266;
 * migration 0208).
 *
 * A request is SOURCES (files, links, text references, copies of a project
 * post or a Studio revision) and PARTS (what is made: pieces per set, a
 * process, measured or stated size), each part in MATERIALS, each material in
 * COLOURS. The vocabulary and the limits are packages/contracts/src/
 * requestModel.ts.
 *
 * ONE READ PATH. `readRequestModel` answers the same shape for every request
 * there is:
 *
 *   schema_version 3  read from the tables, trusted while the v1 row is still
 *                     the mirror they were written with — the SQL fingerprint
 *                     `MIRROR_SQL` matches, or the row's v1 facts equal the v1
 *                     facts of the tables' mirror (a cosmetic rewrite, a D1
 *                     engine that formats JSON differently). A v3 row an older
 *                     build really changed is read as the v1 row it now is
 *                     (`stale`), never as tables that no longer describe it.
 *   schema_version 1  SYNTHESISED from the v1 row it already read, always —
 *                     never from rows in the tables (critique 1): a cache the
 *                     quarter-hour job built under an older synthesis must not
 *                     decide what a pending offer priced.
 *   no print row      a chat or direct request: its free text is carried as
 *                     `legacy_text`, verbatim, and never parsed into a
 *                     catalogue id.
 *
 * THE HASH FOLLOWS THE VERSION. A version-1 request is hashed by the v1
 * `canonicalFacts`, byte for byte as before 0208, so an offer priced against
 * it stays on the same revision. A version-3 request is hashed by
 * `canonicalFactsV3` (worker/lib/requestRevisions.ts), whose first element is
 * the string 'v3' and so can never equal a v1 string. The first v3 save of a
 * v1 request compares BOTH (`changed` in worker/routes/printRequests.ts): the
 * v3 strings, and the v1 facts of the row against the v1 facts of the new
 * mirror — so a save that would silently rewrite what the pending offer priced
 * revises honestly instead.
 *
 * EVERY WRITER WRITES THE V1 ROW TOO (`mirrorFromModel`), in the same batch,
 * then stamps `model_mirror` from the row as SQLite stored it. An older Worker
 * redeployed by hand reads a coherent single job: one material only when
 * there is exactly one, a colour only when exactly one was named, the largest
 * colour count of any one part (a four-part job in one colour each never asks
 * for a multicolour machine).
 */
import { badRequest, int, str } from './http';
import { newId, sha256Hex } from './crypto';
import { safeParse } from './types';
import { isMissingSchema } from './merchantApproval';
import { parseModelLink, type LinkProviderConfig } from './externalModels';
import {
  SOURCE_TYPES,
  canonicalFacts,
  effectiveSourceType,
  factsFromRows,
  parseDims,
  publicEstimate,
  readDims,
  snapshotSpec,
  type Dims,
  type PricedFacts,
  type RevisionFile,
  type RevisionSnapshot,
  type SourceType,
} from './requestRevisions';
import {
  CLIENT_SOURCE_KINDS,
  DEFAULT_SOURCE_ROLE,
  FILE_SOURCE_KINDS,
  REQUEST_COLOUR_MODES,
  REQUEST_FINISHES,
  REQUEST_MODEL_LIMITS as LIMITS,
  REQUEST_PALETTE,
  REQUEST_PROCESSES,
  REQUEST_REVIEW_STATES,
  REQUEST_SOURCE_KINDS,
  REQUEST_SOURCE_ROLES,
  type RequestColourMode,
  type RequestReviewState,
  type RequestSourceKind,
  type RequestSourceRole,
} from '@levonis/contracts/requestModel';

// ------------------------------------------------------------------- shapes

export interface ModelColour {
  mode: RequestColourMode;
  hex: string;
  label: string;
  /** The wizard palette key when the hex is one of the palette's; display only, never hashed. */
  palette: string;
  /** For `as_reference`: the source the colour is taken from ('' = the references in general). */
  ref: string;
}

export interface ModelSource {
  id: string;
  kind: RequestSourceKind;
  file_id: string | null;
  sha256: string;
  role: RequestSourceRole;
  url: string;
  canonical_url: string;
  provider: string;
  ref_text: string;
  origin_id: string;
  origin_ref: string;
  origin_hash: string;
  origin_meta: Record<string, unknown>;
  note: string;
  is_primary: boolean;
  position: number;
  created_at: string;
}

export interface ModelMaterial {
  id: string;
  position: number;
  material_id: string;
  material_unsure: boolean;
  colors: ModelColour[];
  finish: string;
  region_reference: string;
  requirements: string;
  colors_need_review: boolean;
  created_at: string;
  updated_at: string;
}

export interface ModelPart {
  id: string;
  position: number;
  name: string;
  /** Pieces per SET; the request's quantity is the number of sets. */
  quantity: number;
  process: '' | 'fdm' | 'resin';
  process_unsure: boolean;
  stated_dims: Dims | null;
  measured_file_id: string | null;
  notes: string;
  assembly_notes: string;
  /** JSON `{material, color, dimensions}` of a chat or direct request, verbatim. Never parsed. */
  legacy_text: string;
  review_state: RequestReviewState;
  review_reasons: string[];
  reviewed_by: string | null;
  reviewed_at: string | null;
  source_ids: string[];
  materials: ModelMaterial[];
  created_at: string;
  updated_at: string;
}

/** What the whole job shares. `source_type` is always the effective type (it is a v1 priced fact). */
export interface ModelJob {
  quantity: number;
  quality: string;
  infill_percent: number;
  supports: boolean;
  post_processing_minutes: number;
  source_type: SourceType;
}

/** The request-row facts the hash covers. */
export interface ModelRequestFacts {
  governorate: string;
  delivery_pref: string;
  deadline: string;
  customer_notes: string;
}

export interface ModelState {
  job: ModelJob;
  request: ModelRequestFacts;
  sources: ModelSource[];
  parts: ModelPart[];
}

export interface ModelSummary {
  parts_count: number;
  pieces_per_set: number;
  materials: string[];
  processes: string[];
  colors_total: number;
  multicolor_parts: number;
  review_state: RequestReviewState;
}

/** A request file as the model reads it: the revision file plus when it came, its digest and measurement. */
export interface ModelFile extends RevisionFile {
  created_at: string;
  sha256: string;
  analysis: string;
}

export interface RequestModelRead extends ModelState {
  request_id: string;
  /** The EFFECTIVE version: 3 only for a version-3 row still mirrored by its v1 row. */
  schema_version: 1 | 3;
  /** What the print row says, 1 on a database before 0208 or with no print row. */
  stored_version: number;
  origin: 'tables' | 'synthesized' | 'legacy';
  /** A version-3 row an older build changed since: read as the v1 row it now is. */
  stale: boolean;
  budget_visible: boolean;
  summary: ModelSummary;
  /** ALWAYS `factsFromRows` of the rows read: today's exact v1 facts. */
  v1: PricedFacts;
  files: RevisionFile[];
  modelFiles: ModelFile[];
  rows: { r: Record<string, unknown>; p: Record<string, unknown> | null };
  /** Migration 0208 is present on this database. */
  schema: boolean;
}

// ------------------------------------------------------------ small helpers

const s = (x: unknown): string => (x === null || x === undefined ? '' : String(x));
const bool = (x: unknown): boolean => x === true || Number(x) === 1;
const byJson = (a: unknown, b: unknown): number => {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  return x < y ? -1 : x > y ? 1 : 0;
};
const SHA256 = /^[0-9a-f]{64}$/;
const HEX6 = /^#[0-9a-fA-F]{6}$/;
const isFileKind = (k: string): boolean => (FILE_SOURCE_KINDS as readonly string[]).includes(k);
const finishKey = (f: string): string => (f === '' || f === 'standard' ? 'standard' : f);
const roleKey = (src: Pick<ModelSource, 'role' | 'kind'>): string => src.role || DEFAULT_SOURCE_ROLE[src.kind] || 'reference';
const isSpecific = (c: ModelColour): boolean => c.mode === 'catalogue' || c.mode === 'custom';

/** The palette key of a hex, matched lowercase and exactly; '' for any other colour. */
export function paletteKey(hex: string): string {
  const h = s(hex).toLowerCase();
  return REQUEST_PALETTE.find((c) => c.hex === h)?.key ?? '';
}

const anyColour = (): ModelColour => ({ mode: 'any', hex: '', label: '', palette: '', ref: '' });

/**
 * THE V1 COLOUR, KEPT AS STORED (critique 5). `catalogue` only when the stored
 * hex, lowercased, is exactly a palette hex; the hex and the name are carried
 * byte for byte (no trim, no case change, no word-to-hex guessing), so the
 * mirror of the synthesised model hashes to the row it came from.
 */
export function colourFromV1(hex: unknown, name: unknown): ModelColour {
  const h = s(hex);
  const n = s(name);
  const key = paletteKey(h);
  if (key) return { mode: 'catalogue', hex: h, label: n, palette: key, ref: '' };
  if (h || n) return { mode: 'custom', hex: h, label: n, palette: '', ref: '' };
  return anyColour();
}

/** `colors_count` colours: the stored one first, the rest «any colour». */
export function coloursFromV1(hex: unknown, name: unknown, count: unknown): ModelColour[] {
  const n = Math.max(1, Math.floor(Number(count ?? 1)) || 1);
  return [colourFromV1(hex, name), ...Array.from({ length: n - 1 }, anyColour)];
}

/** Why a part needs a technical look, from its content alone. */
export function reviewReasonsFor(part: Pick<ModelPart, 'materials'>): string[] {
  const reasons: string[] = [];
  const colours = part.materials.flatMap((m) => m.colors);
  if (colours.length > 1 && colours.some((c) => c.mode === 'any')) reasons.push('multicolor_unspecified');
  if (part.materials.length > 1) reasons.push('multi_material');
  return reasons;
}

/** The SQL fingerprint of the v1 columns the model mirrors. One expression, so writer and reader agree. */
export function MIRROR_SQL(alias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(alias)) throw new Error('requestModel: invalid SQL alias');
  const a = alias;
  return `json_array(${a}.process, ${a}.process_unsure, ${a}.material_id, ${a}.material_unsure, ${a}.color_hex, ${a}.color_name, ${a}.colors_count, ${a}.primary_file_id, ${a}.source_type, ${a}.source_kind, ${a}.source_url, ${a}.source_provider, ${a}.stated_dims)`;
}

/**
 * AN EFFECTIVE VERSION-3 ROW, in SQL (P1-05): stored as version 3 and still
 * the mirror its tables were written with. The batch readers (the matcher,
 * the board, the lists) read parts and a review only for such a row; any
 * other row is the v1 job it says.
 */
export function effectiveV3Sql(alias: string): string {
  return `(${alias}.schema_version = 3 AND ${alias}.model_mirror = ${MIRROR_SQL(alias)})`;
}

/**
 * THE REVIEW A READER SHOWS (P1-05, critique 6): the stored summary state of
 * an effective version-3 row only. A v1 row's derived «needs review» (several
 * colours) is informational and nobody can confirm it — no reader shows it.
 */
export function reviewStateSql(alias: string, schemaPresent: boolean): string {
  MIRROR_SQL(alias);
  return schemaPresent ? `COALESCE(CASE WHEN ${effectiveV3Sql(alias)} THEN ${alias}.review_state ELSE '' END, '')` : "''";
}

/**
 * A BOARD ROW'S SUMMARY, for a list that joins the print row as `alias`
 * (P1-05): `s_parts_count`, `s_pieces_per_set`, `s_review_state`, and the
 * job's chosen materials and technologies (`s_materials`, `s_processes`) —
 * through the fingerprint, the review for an effective v3 row only. A job in
 * several materials or technologies has a v1 mirror that names none of them
 * (material open, process open); its card reads these instead (review 3).
 */
export function boardSummarySql(alias: string, schemaPresent: boolean): string {
  const sum = requestSummarySql(alias, schemaPresent);
  return `${sum.parts_count} AS s_parts_count, ${sum.pieces_per_set} AS s_pieces_per_set, ${reviewStateSql(alias, schemaPresent)} AS s_review_state, `
    + `${sum.materials_json} AS s_materials, ${sum.processes_json} AS s_processes`;
}

const idList = (raw: unknown): string[] => {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
};

/** The summary a list row carries, or undefined when the row was read without it. */
export function boardSummaryOf(r: Record<string, unknown>): { parts_count: number; pieces_per_set: number; review_state: string; materials: string[]; processes: string[] } | undefined {
  if (r.s_parts_count === undefined) return undefined;
  return {
    parts_count: Number(r.s_parts_count ?? 1) || 1,
    pieces_per_set: Number(r.s_pieces_per_set ?? 1) || 1,
    review_state: String(r.s_review_state ?? ''),
    materials: idList(r.s_materials),
    processes: idList(r.s_processes).filter((x) => x === 'fdm' || x === 'resin'),
  };
}

/**
 * THE BOARD'S TECHNOLOGY AND MATERIAL FILTERS, for a list that joins the
 * request as `r` and its print row as `alias` (review 3). An effective
 * version-3 row is matched on its PARTS — a technology when some part is in
 * it or left open, a material when some part names it — so a job in two
 * materials is found by either; any other row on its v1 columns, as always.
 * `processParam` and `materialParam` are the bound parameters ('' = no filter).
 */
export function boardFilterSql(alias: string, schemaPresent: boolean, processParam: string, materialParam: string): string {
  MIRROR_SQL(alias);
  const a = alias;
  const v1Process = `(COALESCE(${a}.process_unsure, 0) = 1 OR ${a}.process = ${processParam})`;
  const v1Material = `(${a}.material_id = ${materialParam} AND COALESCE(${a}.material_unsure, 0) = 0)`;
  if (!schemaPresent) return `AND (${processParam} = '' OR ${v1Process}) AND (${materialParam} = '' OR ${v1Material})`;
  const v3 = effectiveV3Sql(a);
  const partProcess = `EXISTS (SELECT 1 FROM community_request_parts fp
                                WHERE fp.request_id = ${a}.request_id
                                  AND (fp.process_unsure = 1 OR fp.process NOT IN ('fdm','resin') OR fp.process = ${processParam}))`;
  const partMaterial = `EXISTS (SELECT 1 FROM community_request_part_materials fm
                                  JOIN community_request_parts fp ON fp.id = fm.part_id
                                 WHERE fp.request_id = ${a}.request_id
                                   AND fm.material_id = ${materialParam} AND COALESCE(fm.material_unsure, 0) = 0)`;
  return `AND (${processParam} = '' OR CASE WHEN COALESCE(${v3}, 0) THEN ${partProcess} ELSE ${v1Process} END)
        AND (${materialParam} = '' OR CASE WHEN COALESCE(${v3}, 0) THEN ${partMaterial} ELSE ${v1Material} END)`;
}

/**
 * THE SUMMARY COLUMNS, AS AN SQL READER MUST READ THEM: the stored value only
 * while the row's fingerprint matches, otherwise derived from the v1 columns
 * exactly as `summarize(synthesizeModel(row))` derives it; COALESCEd for a
 * request with no print row. Never read a summary column raw.
 */
export function requestSummarySql(alias: string, schemaPresent: boolean): Record<string, string> {
  MIRROR_SQL(alias);
  const a = alias;
  const derived = {
    parts_count: '1',
    pieces_per_set: '1',
    materials_json: `CASE WHEN ${a}.material_unsure = 1 OR ${a}.material_id = '' THEN '[]' ELSE json_array(${a}.material_id) END`,
    processes_json: `CASE WHEN ${a}.process_unsure = 1 OR ${a}.process = '' THEN '[]' ELSE json_array(${a}.process) END`,
    colors_total: `max(1, ${a}.colors_count)`,
    multicolor_parts: `CASE WHEN ${a}.colors_count > 1 THEN 1 ELSE 0 END`,
    review_state: `CASE WHEN ${a}.colors_count > 1 THEN 'needs_technical_review' ELSE '' END`,
  };
  const none = { parts_count: '1', pieces_per_set: '1', materials_json: "'[]'", processes_json: "'[]'", colors_total: '0', multicolor_parts: '0', review_state: "''" };
  const fresh = `${a}.model_mirror = ${MIRROR_SQL(a)}`;
  const pick = (k: keyof typeof derived) =>
    schemaPresent
      ? `COALESCE(CASE WHEN ${fresh} THEN ${a}.${k} ELSE ${derived[k]} END, ${none[k]})`
      : `COALESCE(${derived[k]}, ${none[k]})`;
  return {
    parts_count: pick('parts_count'),
    pieces_per_set: pick('pieces_per_set'),
    materials_json: pick('materials_json'),
    processes_json: pick('processes_json'),
    colors_total: pick('colors_total'),
    multicolor_parts: pick('multicolor_parts'),
    review_state: pick('review_state'),
  };
}

// -------------------------------------------------------------- synthesis

const fileSourceFor = (f: ModelFile, position: number): ModelSource => ({
  id: `rps_${f.id}`,
  kind: 'file',
  file_id: f.id,
  sha256: SHA256.test(f.sha256) ? f.sha256 : '',
  role: '',
  url: '',
  canonical_url: '',
  provider: '',
  ref_text: '',
  origin_id: '',
  origin_ref: '',
  origin_hash: '',
  origin_meta: {},
  note: '',
  is_primary: false,
  position,
  created_at: f.created_at,
});

const jobFromRows = (r: Record<string, unknown>, p: Record<string, unknown> | null, kinds: string[]): ModelJob => ({
  quantity: Number(r.quantity ?? 1),
  quality: String(p?.quality ?? 'standard'),
  infill_percent: Number(p?.infill_percent ?? 20),
  supports: Number(p?.supports ?? 1) === 1,
  post_processing_minutes: Number(p?.post_processing_minutes ?? 0),
  source_type: effectiveSourceType(p, kinds),
});

const requestFactsFrom = (r: Record<string, unknown>): ModelRequestFacts => ({
  governorate: String(r.governorate ?? ''),
  delivery_pref: String(r.delivery_pref ?? ''),
  deadline: String(r.deadline ?? ''),
  customer_notes: String(r.customer_notes ?? ''),
});

/**
 * THE V3 MODEL OF A V1 ROW — pure, and deterministic in its ids
 * (`rps_<fileId>`, `rps_<rid>_link`, `rpt_<rid>_1`, `rpm_<rid>_1_1`), so a
 * model synthesised on read and the same model materialised by the job are
 * one and the same. It never changes a stored value: the round trip
 * `canonicalFacts(mirrorFacts(synthesizeModel(row)))` is the row's own v1
 * string (tests/requestModelSynthesis.test.ts), save for two classes the
 * compatibility script counts: a `source_url` kept on a non-link row from
 * before 0130, and a `colors_count` below one.
 */
export function synthesizeModel(
  r: Record<string, unknown>,
  p: Record<string, unknown> | null,
  files: ModelFile[]
): ModelState & { origin: 'synthesized' | 'legacy' } {
  const rid = String(r.id ?? '');
  const kinds = files.map((f) => f.kind);
  const created = s(r.created_at);
  const updated = s(p?.updated_at ?? r.updated_at ?? r.created_at);
  const sources = files.map((f, i) => fileSourceFor(f, i));
  const job = jobFromRows(r, p, kinds);
  const request = requestFactsFrom(r);

  if (!p) {
    // The customer's own words, when there are any: a draft that has none carries none.
    const legacy = s(r.material) || s(r.color) || s(r.dimensions)
      ? JSON.stringify({ material: s(r.material), color: s(r.color), dimensions: s(r.dimensions) })
      : '';
    return {
      origin: 'legacy',
      job,
      request,
      sources,
      parts: [{
        id: `rpt_${rid}_1`, position: 0, name: '', quantity: 1, process: '', process_unsure: true, stated_dims: null,
        measured_file_id: null, notes: '', assembly_notes: '', legacy_text: legacy, review_state: '', review_reasons: [],
        reviewed_by: null, reviewed_at: null, source_ids: sources.map((x) => x.id),
        materials: [{
          id: `rpm_${rid}_1_1`, position: 0, material_id: '', material_unsure: true, colors: [], finish: '',
          region_reference: '', requirements: '', colors_need_review: false, created_at: created, updated_at: updated,
        }],
        created_at: created, updated_at: updated,
      }],
    };
  }

  const url = s(p.source_url);
  if (url) {
    sources.push({
      id: `rps_${rid}_link`, kind: 'link', file_id: null, sha256: '', role: '', url, canonical_url: url, provider: s(p.source_provider),
      ref_text: '', origin_id: '', origin_ref: '', origin_hash: '', origin_meta: {}, note: '', is_primary: false,
      position: sources.length, created_at: created,
    });
  }
  const primaryFile = p.primary_file_id ? s(p.primary_file_id) : '';
  const type = job.source_type;
  const primary =
    type === 'model' ? sources.find((x) => x.file_id === primaryFile)
      : type === 'link' ? sources.find((x) => x.kind === 'link')
        : type === 'images' ? sources.find((x) => x.file_id && files.find((f) => f.id === x.file_id)?.kind === 'reference')
          : undefined;
  if (primary) primary.is_primary = true;

  const unsureProcess = Number(p.process_unsure ?? 0) === 1;
  const unsureMaterial = Number(p.material_unsure ?? 0) === 1;
  const colours = coloursFromV1(p.color_hex, p.color_name, p.colors_count);
  const part: ModelPart = {
    id: `rpt_${rid}_1`,
    position: 0,
    name: '',
    quantity: 1,
    process: unsureProcess ? '' : p.process === 'resin' ? 'resin' : p.process === 'fdm' ? 'fdm' : '',
    process_unsure: unsureProcess,
    stated_dims: parseDims(p.stated_dims),
    measured_file_id: primaryFile || null,
    notes: '',
    assembly_notes: '',
    legacy_text: '',
    review_state: '',
    review_reasons: [],
    reviewed_by: null,
    reviewed_at: null,
    source_ids: sources.map((x) => x.id),
    materials: [{
      id: `rpm_${rid}_1_1`, position: 0, material_id: unsureMaterial ? '' : s(p.material_id), material_unsure: unsureMaterial,
      colors: colours, finish: '', region_reference: '', requirements: '', colors_need_review: false, created_at: created, updated_at: updated,
    }],
    created_at: created,
    updated_at: updated,
  };
  part.review_reasons = reviewReasonsFor(part);
  part.review_state = part.review_reasons.length ? 'needs_technical_review' : '';
  return { origin: 'synthesized', job, request, sources, parts: [part] };
}

/**
 * MERGE ON READ: a file of the request that no source names becomes a plain
 * `file` source (`rps_<fileId>`, after the last one, not primary, no note) and,
 * on a one-part job, a source of that part — whichever build attached it. A
 * source whose file is gone is dropped (the cascade does the same in the
 * tables), and a reference to a dropped source is cleared.
 */
export function mergeFiles<T extends ModelState>(m: T, files: ModelFile[]): T {
  const present = new Set(files.map((f) => f.id));
  const sources = m.sources.filter((x) => !isFileKind(x.kind) || (x.file_id !== null && present.has(x.file_id)));
  const named = new Set(sources.map((x) => x.file_id).filter(Boolean) as string[]);
  const added: ModelSource[] = [];
  for (const f of files) {
    if (named.has(f.id)) continue;
    added.push(fileSourceFor(f, sources.length + added.length));
  }
  const all = [...sources, ...added];
  const ids = new Set(all.map((x) => x.id));
  const parts = m.parts.map((part, i) => ({
    ...part,
    measured_file_id: part.measured_file_id && present.has(part.measured_file_id) ? part.measured_file_id : null,
    source_ids: [...part.source_ids.filter((id) => ids.has(id)), ...(m.parts.length === 1 && i === 0 ? added.map((x) => x.id) : [])],
    materials: part.materials.map((mat) => ({
      ...mat,
      colors: mat.colors.map((c) => (c.ref && !ids.has(c.ref) ? { ...c, ref: '' } : c)),
    })),
  }));
  return { ...m, sources: all.map((x, i) => ({ ...x, position: i })), parts };
}

// ---------------------------------------------------------------- summary

export function summarize(m: ModelState): ModelSummary {
  const effectiveProcesses = m.parts.map((p) => (p.process_unsure ? '' : p.process)).filter(Boolean);
  const materials = m.parts.flatMap((p) => p.materials).filter((x) => !x.material_unsure && x.material_id).map((x) => x.material_id);
  const perPart = m.parts.map((p) => p.materials.reduce((n, x) => n + x.colors.length, 0));
  const mixed = new Set(effectiveProcesses).size > 1;
  const states = m.parts.map((p) => p.review_state);
  // Confirmed once EVERY part is (P1-05): a request in several technologies
  // leaves review when a reviewer has confirmed each of its parts.
  const confirmed = states.length > 0 && states.every((x) => x === 'confirmed');
  return {
    parts_count: Math.max(1, m.parts.length),
    pieces_per_set: Math.max(1, m.parts.reduce((n, p) => n + p.quantity, 0)),
    materials: [...new Set(materials)].sort(),
    processes: [...new Set(effectiveProcesses)].sort(),
    colors_total: perPart.reduce((a, b) => a + b, 0),
    multicolor_parts: perPart.filter((n) => n > 1).length,
    review_state: confirmed
      ? 'confirmed'
      : mixed || states.includes('needs_technical_review') ? 'needs_technical_review' : '',
  };
}

/** The request-level reasons a review is for: every part's own, and the mix of technologies. */
export function reviewReasonsOf(m: ModelState): string[] {
  const out = new Set(m.parts.flatMap((p) => p.review_reasons));
  const processes = new Set(m.parts.map((p) => (p.process_unsure ? '' : p.process)).filter(Boolean));
  if (processes.size > 1) out.add('mixed_process');
  return [...out];
}

// ---------------------------------------------------------------- the hash

/** A colour as the hash knows it; `keys` are the model's source keys (an `as_reference` names one). */
const colourKeyOf = (keys: Map<string, string>) => (c: ModelColour): unknown[] =>
  c.mode === 'as_reference'
    ? ['as_reference', c.ref ? (keys.get(c.ref) ?? '') : '']
    : isSpecific(c) ? ['specific', s(c.hex).toLowerCase(), s(c.label).trim()] : ['any'];

/** A material as the hash knows it: never its id, position or review flag. */
const materialKeyOf = (x: ModelMaterial, colour: (c: ModelColour) => unknown[]): unknown[] => [
  x.material_unsure ? null : x.material_id || null,
  x.colors.length ? x.colors.map(colour) : [['any']],
  finishKey(s(x.finish)),
  s(x.region_reference).trim(),
  s(x.requirements).trim(),
];

/** A source as the hash knows it: what it IS, never its id, position or provenance. */
const sourceKey = (x: ModelSource): string =>
  JSON.stringify([x.kind, x.file_id || null, x.kind === 'link' ? s(x.canonical_url) || s(x.url) : '', s(x.ref_text).trim()]);

/**
 * The priced sections of a model, normalised: what a merchant prices and
 * nothing else. Shared by the hash and the revision diff.
 *
 *   excluded   ids, positions, part names, review state, sha256, origin_*,
 *              provider, the palette key, title, description, budget;
 *   collapsed  'catalogue' and 'custom' (a named colour either way), role ''
 *              and the kind's default, finish '' and 'standard', '' and null
 *              ids, an unsure material or process and one not chosen, no
 *              colour at all and «any colour»;
 *   ordered    sources, parts and materials are sets (sorted); the colours
 *              inside a material keep their order.
 */
export function pricedSections(m: Pick<ModelState, 'sources' | 'parts'>): { sources: unknown[]; parts: unknown[] } {
  const keys = new Map(m.sources.map((x) => [x.id, sourceKey(x)]));
  const colour = colourKeyOf(keys);
  const sources = m.sources.map((x) => [sourceKey(x), roleKey(x), x.is_primary ? 1 : 0, s(x.note).trim()]).sort(byJson);
  const parts = m.parts
    .map((p) => [
      Number(p.quantity),
      p.process_unsure ? null : p.process || null,
      p.stated_dims ? [p.stated_dims.x, p.stated_dims.y, p.stated_dims.z] : null,
      p.measured_file_id || null,
      s(p.notes).trim(),
      s(p.assembly_notes).trim(),
      s(p.legacy_text),
      p.source_ids.map((id) => keys.get(id) ?? '').sort(),
      p.materials.map((x) => materialKeyOf(x, colour)).sort(byJson),
    ])
    .sort(byJson);
  return { sources, parts };
}

/**
 * THE V3 CANONICAL STRING. Version-tagged ('v3' first: a v1 string always
 * starts with a number), and covering what is made: the job (sets, quality,
 * infill, supports, finishing time, the effective source type), where and
 * when, the customer's notes, and the priced sections above.
 */
export function canonicalFactsV3(m: ModelState): string {
  const j = m.job;
  const r = m.request;
  const { sources, parts } = pricedSections(m);
  return JSON.stringify([
    'v3',
    [Number(j.quantity), s(j.quality), Number(j.infill_percent), !!j.supports, Number(j.post_processing_minutes), j.source_type || null,
      s(r.governorate), s(r.delivery_pref), s(r.deadline), s(r.customer_notes).trim()],
    sources,
    parts,
  ]);
}

export async function factsHashV3(m: ModelState): Promise<string> {
  return sha256Hex(canonicalFactsV3(m));
}

// ---------------------------------------------------------------- the mirror

/** The v1 print-row columns a model is written as. */
export interface MirrorRow {
  process: 'fdm' | 'resin';
  process_unsure: 0 | 1;
  material_id: string;
  material_unsure: 0 | 1;
  color_hex: string;
  color_name: string;
  colors_count: number;
  primary_file_id: string | null;
  source_type: SourceType;
  source_kind: 'upload' | 'link';
  source_url: string;
  source_provider: string;
  stated_dims: Dims | null;
}

/** The file ids of a model's ORIGINALS (role `source`, Q5): never what its public job is about. */
export function originalFileIds(m: Pick<ModelState, 'sources'>): Set<string> {
  return new Set(m.sources.filter((x) => x.role === 'source' && x.file_id).map((x) => x.file_id as string));
}

/**
 * The type a model's sources say, when nobody named one. An original (role
 * `source`) says nothing: the job the board prices is what everyone may see.
 */
export function derivedSourceType(m: Pick<ModelState, 'sources' | 'parts'>, files: Array<Pick<ModelFile, 'id' | 'kind'>>): SourceType {
  const kindOf = (id: string | null) => (id ? files.find((f) => f.id === id)?.kind ?? '' : '');
  const originals = originalFileIds(m);
  const open = m.sources.filter((x) => x.role !== 'source');
  const primary = open.find((x) => x.is_primary);
  if (primary) {
    if (primary.kind === 'link') return 'link';
    if (primary.kind === 'text_ref') return 'description';
    const k = kindOf(primary.file_id);
    return k === 'model' ? 'model' : k === 'reference' ? 'images' : 'description';
  }
  if (m.parts.some((p) => p.measured_file_id && !originals.has(p.measured_file_id)) || open.some((x) => kindOf(x.file_id) === 'model')) return 'model';
  if (open.some((x) => kindOf(x.file_id) === 'reference')) return 'images';
  if (open.some((x) => x.kind === 'link')) return 'link';
  return 'description';
}

/**
 * THE V1 ROW OF A MODEL (§5 mirror rules): a coherent single job for any
 * reader that knows only v1. An original (role `source`, Q5) is never its
 * link nor its `primary_file_id`: those are what every board reader, the
 * matcher and the costing route read, and an eligible merchant may not open
 * an original.
 */
export function mirrorFromModel(m: ModelState, files: ReadonlyArray<Pick<RevisionFile, 'id' | 'kind'>>): MirrorRow {
  const procs = m.parts.map((p) => (p.process_unsure || !p.process ? null : p.process));
  const oneProcess = procs.length > 0 && procs.every((x) => x !== null && x === procs[0]) ? (procs[0] as 'fdm' | 'resin') : null;

  const rows = m.parts.flatMap((p) => p.materials);
  const unsure = rows.some((x) => x.material_unsure);
  const chosen = rows.filter((x) => !x.material_unsure && x.material_id);
  const distinct = new Set(chosen.map((x) => x.material_id));
  const material =
    distinct.size === 1 && !unsure && chosen.length === rows.length
      ? { material_id: chosen[0].material_id, material_unsure: 0 as const }
      : distinct.size === 0 && !unsure
        ? { material_id: '', material_unsure: 0 as const }
        : { material_id: '', material_unsure: 1 as const };

  const named = rows.flatMap((x) => x.colors).filter(isSpecific);
  const perPart = m.parts.map((p) => p.materials.reduce((n, x) => n + x.colors.length, 0));

  const type = m.job.source_type;
  const originals = originalFileIds(m);
  const open = m.sources.filter((x) => x.role !== 'source');
  const links = open.filter((x) => x.kind === 'link');
  const link = type === 'link' ? (links.find((x) => x.is_primary) ?? links[0]) : undefined;
  const primary = open.find((x) => x.is_primary);
  const measuredOf = (id: string | null | undefined) => (id && !originals.has(id) ? id : null);
  const measured = m.parts.map((p) => measuredOf(p.measured_file_id)).find((x) => x !== null) ?? null;

  const dims = m.parts.map((p) => p.stated_dims).filter((d): d is Dims => !!d);
  const stated: Dims | null =
    m.parts.length === 1
      ? m.parts[0].stated_dims
      : dims.length
        ? (() => {
            const sorted = dims.map((d) => [d.x, d.y, d.z].sort((a, b) => b - a));
            return { x: Math.max(...sorted.map((d) => d[0])), y: Math.max(...sorted.map((d) => d[1])), z: Math.max(...sorted.map((d) => d[2])) };
          })()
        : null;

  return {
    process: oneProcess ?? 'fdm',
    process_unsure: oneProcess ? 0 : 1,
    ...material,
    color_hex: named.length === 1 ? named[0].hex : '',
    color_name: named.length === 1 ? named[0].label : '',
    // At most the sixteen a v1 reader accepts (readSpec), so an older build can republish the row as stored.
    colors_count: Math.min(LIMITS.maxColoursPerMaterial, Math.max(1, ...perPart)),
    primary_file_id:
      measuredOf(m.parts[0]?.measured_file_id) || measured ||
      (primary && primary.file_id && files.find((f) => f.id === primary.file_id)?.kind === 'model' ? primary.file_id : null) || null,
    source_type: type,
    source_kind: type === 'link' ? 'link' : 'upload',
    source_url: link ? link.canonical_url || link.url : '',
    source_provider: link ? link.provider : '',
    stated_dims: stated,
  };
}

/** The mirror as a print row `factsFromRows` reads (only the columns it reads). */
export function mirrorPrintRow(m: ModelState, files: ReadonlyArray<Pick<RevisionFile, 'id' | 'kind'>>): Record<string, unknown> {
  const x = mirrorFromModel(m, files);
  return {
    process: x.process,
    process_unsure: x.process_unsure,
    material_id: x.material_id,
    material_unsure: x.material_unsure,
    color_hex: x.color_hex,
    color_name: x.color_name,
    quality: m.job.quality,
    infill_percent: m.job.infill_percent,
    supports: m.job.supports ? 1 : 0,
    colors_count: x.colors_count,
    post_processing_minutes: m.job.post_processing_minutes,
    primary_file_id: x.primary_file_id,
    source_kind: x.source_kind,
    source_url: x.source_url,
    source_provider: x.source_provider,
    source_type: x.source_type,
    stated_dims: x.stated_dims ? JSON.stringify(x.stated_dims) : '',
  };
}

/** The v1 facts an older build would read from a model's mirror. */
export function mirrorFacts(m: ModelState, files: RevisionFile[]): PricedFacts {
  const r = { quantity: m.job.quantity, ...m.request };
  return factsFromRows(r, mirrorPrintRow(m, files), files);
}

// ------------------------------------------- an old client's v1 body on v3

const sameDims = (a: Dims | null, b: Dims | null) =>
  (!a && !b) || (!!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z);

/**
 * AN OLDER CLIENT SENT A V1 BODY FOR A VERSION-3 REQUEST. The v1 facts are
 * folded into the model — the job and request fields always, the part and
 * its one material only when they differ from the model's own mirror, the
 * primary source only when the type, the model file or the link changed —
 * keeping every id, name, note and extra source. The caller accepts the fold
 * only when its mirror reproduces the v1 body exactly (that is what
 * «representable» means, critique 12); otherwise the answer is
 * REQUEST_MODEL_V3 and nothing is written.
 */
export function applyV1Facts(m: ModelState, f: PricedFacts, provider: string, files: ModelFile[], mint: () => string): ModelState | null {
  const before = mirrorFacts(m, files);
  const next: ModelState = JSON.parse(JSON.stringify(m)) as ModelState;
  next.job = {
    quantity: f.quantity, quality: f.quality, infill_percent: f.infill_percent, supports: f.supports,
    post_processing_minutes: f.post_processing_minutes,
    source_type: ((SOURCE_TYPES as readonly string[]).includes(f.source_type) ? f.source_type : m.job.source_type) as SourceType,
  };
  next.request = { governorate: f.governorate, delivery_pref: f.delivery_pref, deadline: f.deadline, customer_notes: f.customer_notes };

  const colourSame = before.color_hex.toLowerCase() === f.color_hex.toLowerCase() && before.color_name === f.color_name && before.colors_count === f.colors_count;
  const partSame = before.process === f.process && before.material_id === f.material_id && colourSame &&
    before.primary_file_id === f.primary_file_id && sameDims(before.stated_dims, f.stated_dims);
  if (!partSame) {
    if (next.parts.length !== 1 || next.parts[0].materials.length > 1) return null;
    const part = next.parts[0];
    if (before.process !== f.process) {
      part.process = f.process === 'resin' ? 'resin' : f.process === 'fdm' ? 'fdm' : '';
      part.process_unsure = f.process === null;
    }
    if (!sameDims(before.stated_dims, f.stated_dims)) part.stated_dims = f.stated_dims;
    if (before.primary_file_id !== f.primary_file_id) part.measured_file_id = f.primary_file_id;
    const mat: ModelMaterial = part.materials[0] ?? {
      id: `${part.id.replace(/^rpt_/, 'rpm_')}_1`, position: 0, material_id: '', material_unsure: false, colors: [anyColour()],
      finish: '', region_reference: '', requirements: '', colors_need_review: false, created_at: part.created_at, updated_at: part.updated_at,
    };
    if (before.material_id !== f.material_id) {
      mat.material_id = f.material_id ?? '';
      mat.material_unsure = f.material_id === null;
      if (mat.colors.some((c) => c.mode !== 'any')) mat.colors_need_review = true;
    }
    if (!colourSame) mat.colors = coloursFromV1(f.color_hex, f.color_name, f.colors_count);
    part.materials = [mat];
    part.review_reasons = reviewReasonsFor(part);
    part.review_state = part.review_reasons.length ? 'needs_technical_review' : '';
  }

  if (before.source_type !== f.source_type || before.primary_file_id !== f.primary_file_id || before.source_url !== f.source_url) {
    for (const x of next.sources) x.is_primary = false;
    if (f.source_type === 'link' && f.source_url) {
      let link = next.sources.find((x) => x.kind === 'link' && (x.canonical_url === f.source_url || x.url === f.source_url));
      if (!link) {
        link = {
          id: mint(), kind: 'link', file_id: null, sha256: '', role: '', url: f.source_url, canonical_url: f.source_url,
          provider: provider.slice(0, 60), ref_text: '', origin_id: '', origin_ref: '', origin_hash: '', origin_meta: {}, note: '',
          is_primary: false, position: next.sources.length, created_at: '',
        };
        next.sources.push(link);
        if (next.parts.length === 1) next.parts[0].source_ids.push(link.id);
      }
      link.is_primary = true;
    } else if (f.source_type === 'model' && f.primary_file_id) {
      const src = next.sources.find((x) => x.file_id === f.primary_file_id);
      if (src) src.is_primary = true;
    } else if (f.source_type === 'images') {
      const src = next.sources.find((x) => x.file_id && files.find((ff) => ff.id === x.file_id)?.kind === 'reference');
      if (src) src.is_primary = true;
    }
  }
  return next;
}

// ------------------------------------------------------------- projection

export type ModelAudience = 'owner' | 'admin' | 'accepted' | 'merchant' | 'public' | 'snapshot';

/**
 * WHAT EACH READER SEES OF A MODEL (the visibility registry in packages/
 * contracts/src/requestModel.ts). Provenance (`origin_*`, `sha256` — a
 * project post's digest would tie the request to its author, conflict 62)
 * and who reviewed a part go to the customer and an admin only. A `source`
 * file (owner decision Q5) is the customer's, an admin's and the ACCEPTED
 * merchant's: a merchant who may only offer, and the public, never see it.
 * The customer's identity is never in a model at all. A snapshot (a revision
 * row, read raw by the board) carries what the accepted merchant may read
 * and is re-projected for every other reader (`projectSpec`).
 */
export function projectModel(m: ModelState & Partial<Pick<RequestModelRead, 'schema_version' | 'summary'>>, audience: ModelAudience): Record<string, unknown> {
  const full = audience === 'owner' || audience === 'admin';
  const hideSource = audience === 'merchant' || audience === 'public';
  const hidden = new Set(hideSource ? m.sources.filter((x) => x.role === 'source').map((x) => x.id) : []);
  const hiddenFiles = hideSource ? originalFileIds(m) : new Set<string>();
  const sources = m.sources.filter((x) => !hidden.has(x.id)).map((x) => ({
    id: x.id, kind: x.kind, file_id: x.file_id, role: x.role, url: x.url, canonical_url: x.canonical_url, provider: x.provider,
    ref_text: x.ref_text, note: x.note, is_primary: x.is_primary, position: x.position,
    ...(full ? { sha256: x.sha256, origin_id: x.origin_id, origin_ref: x.origin_ref, origin_hash: x.origin_hash, origin_meta: x.origin_meta } : {}),
  }));
  const parts = m.parts.map((p) => ({
    id: p.id, position: p.position, name: p.name, quantity: p.quantity, process: p.process, process_unsure: p.process_unsure,
    stated_dims: p.stated_dims,
    measured_file_id: p.measured_file_id && hiddenFiles.has(p.measured_file_id) ? null : p.measured_file_id,
    notes: p.notes, assembly_notes: p.assembly_notes,
    legacy_text: p.legacy_text, review_state: p.review_state, review_reasons: p.review_reasons,
    ...(full ? { reviewed_by: p.reviewed_by, reviewed_at: p.reviewed_at } : {}),
    source_ids: p.source_ids.filter((id) => !hidden.has(id)),
    materials: p.materials.map((x) => ({
      id: x.id, position: x.position, material_id: x.material_id, material_unsure: x.material_unsure,
      colors: x.colors.map((c) => ({ mode: c.mode, hex: c.hex, label: c.label, palette: c.palette, ref: hidden.has(c.ref) ? '' : c.ref })),
      finish: x.finish, region_reference: x.region_reference, requirements: x.requirements, colors_need_review: x.colors_need_review,
    })),
  }));
  return {
    schema_version: m.schema_version ?? 3,
    job: { ...m.job },
    sources,
    parts,
    summary: m.summary ?? summarize(m),
  };
}

/**
 * A VERSION-1 REQUEST HAS NO REVIEW ANYBODY CAN CONFIRM (P1-05, critique 6):
 * its synthesised part's «several colours» is informational, and no reader
 * shows it as a review. A projection of an effective version-3 model is
 * returned as it is.
 */
export function withoutV1Review(m: Record<string, unknown>, v3: boolean): Record<string, unknown> {
  if (v3) return m;
  const parts = Array.isArray(m.parts) ? (m.parts as Array<Record<string, unknown>>) : [];
  const summary = (m.summary ?? {}) as Record<string, unknown>;
  return {
    ...m,
    parts: parts.map((p) => ({ ...p, review_state: '', review_reasons: [] })),
    summary: { ...summary, review_state: '' },
  };
}

/**
 * A REVISION'S SPEC FOR A READER WHO IS NOT A PARTY — the board's merchants
 * and accounts (critique 6). A role-`source` file leaves the model — as a
 * source, as a part's source, as a measured model and as a colour's
 * reference, exactly as `projectModel` leaves it — and any provenance a
 * snapshot should never have carried is dropped defensively. A v1 spec (no
 * `model`) is returned as it is.
 */
export function projectSpec(spec: Record<string, unknown>, audience: ModelAudience): Record<string, unknown> {
  const model = spec.model as Record<string, unknown> | undefined;
  if (!model || typeof model !== 'object' || audience === 'owner' || audience === 'admin' || audience === 'accepted') return spec;
  const m = model as { sources?: Array<Record<string, unknown>>; parts?: Array<Record<string, unknown>> };
  const originals = (m.sources ?? []).filter((x) => x.role === 'source');
  const hidden = new Set(originals.map((x) => String(x.id)));
  const hiddenFiles = new Set(originals.map((x) => x.file_id).filter((f) => typeof f === 'string' && f !== '').map(String));
  const strip = ({ sha256: _a, origin_id: _b, origin_ref: _c, origin_hash: _d, origin_meta: _e, ...rest }: Record<string, unknown>) => rest;
  const material = (x: Record<string, unknown>) => ({
    ...x,
    colors: Array.isArray(x.colors)
      ? (x.colors as Array<Record<string, unknown>>).map((c) => (c && typeof c === 'object' && hidden.has(String(c.ref ?? '')) ? { ...c, ref: '' } : c))
      : x.colors,
  });
  return {
    ...spec,
    model: {
      ...model,
      sources: (m.sources ?? []).filter((x) => !hidden.has(String(x.id))).map(strip),
      parts: (m.parts ?? []).map((p) => ({
        ...p,
        measured_file_id: typeof p.measured_file_id === 'string' && hiddenFiles.has(p.measured_file_id) ? null : p.measured_file_id,
        source_ids: Array.isArray(p.source_ids) ? (p.source_ids as unknown[]).filter((id) => !hidden.has(String(id))) : [],
        materials: Array.isArray(p.materials) ? (p.materials as Array<Record<string, unknown>>).map(material) : p.materials,
      })),
    },
  };
}

// ------------------------------------------------------------- reading rows

const FILES_SQL = `SELECT f.id, f.kind, f.content_type, f.size_bytes, f.file_name, f.created_at, f.analysis,
                          COALESCE(fo.sha256, '') AS sha256
                     FROM community_request_files f LEFT JOIN file_objects fo ON fo.object_key = f.file_key
                    WHERE f.request_id = ? ORDER BY f.created_at, f.id`;

const toModelFile = (f: Record<string, unknown>): ModelFile => ({
  id: String(f.id),
  kind: String(f.kind),
  content_type: String(f.content_type),
  size_bytes: Number(f.size_bytes ?? 0),
  file_name: String(f.file_name ?? ''),
  created_at: s(f.created_at),
  sha256: SHA256.test(s(f.sha256)) ? s(f.sha256) : '',
  analysis: s(f.analysis),
});

/** The revision file of a model file: exactly the five keys `readRevisionFiles` gives, so v1 bytes stay identical. */
export const revisionFile = (f: ModelFile): RevisionFile => ({
  id: f.id, kind: f.kind, content_type: f.content_type, size_bytes: f.size_bytes, file_name: f.file_name,
});

const colourFromJson = (raw: Record<string, unknown>): ModelColour => {
  const mode = (REQUEST_COLOUR_MODES as readonly string[]).includes(s(raw.mode)) ? (s(raw.mode) as RequestColourMode) : 'any';
  return { mode, hex: s(raw.hex), label: s(raw.label), palette: s(raw.palette), ref: s(raw.ref) };
};

/** A model as the four tables hold it (no merge: `mergeFiles` follows). */
export function modelFromTables(
  r: Record<string, unknown>,
  p: Record<string, unknown>,
  files: ModelFile[],
  rows: { sources: Record<string, unknown>[]; parts: Record<string, unknown>[]; links: Record<string, unknown>[]; materials: Record<string, unknown>[] }
): ModelState {
  const sources: ModelSource[] = rows.sources.map((x) => ({
    id: String(x.id),
    kind: s(x.kind) as RequestSourceKind,
    file_id: x.file_id === null || x.file_id === undefined ? null : String(x.file_id),
    sha256: s(x.sha256),
    role: s(x.role) as RequestSourceRole,
    url: s(x.url),
    canonical_url: s(x.canonical_url),
    provider: s(x.provider),
    ref_text: s(x.ref_text),
    origin_id: s(x.origin_id),
    origin_ref: s(x.origin_ref),
    origin_hash: s(x.origin_hash),
    origin_meta: safeParse<Record<string, unknown>>(x.origin_meta, {}) ?? {},
    note: s(x.note),
    is_primary: bool(x.is_primary),
    position: Number(x.position ?? 0),
    created_at: s(x.created_at),
  }));
  const order = new Map(sources.map((x, i) => [x.id, i]));
  const parts: ModelPart[] = rows.parts.map((x) => ({
    id: String(x.id),
    position: Number(x.position ?? 0),
    name: s(x.name),
    quantity: Number(x.quantity ?? 1),
    process: x.process === 'fdm' || x.process === 'resin' ? x.process : '',
    process_unsure: bool(x.process_unsure),
    stated_dims: parseDims(x.stated_dims),
    measured_file_id: x.measured_file_id ? String(x.measured_file_id) : null,
    notes: s(x.notes),
    assembly_notes: s(x.assembly_notes),
    legacy_text: s(x.legacy_text),
    review_state: s(x.review_state) as RequestReviewState,
    review_reasons: (safeParse<unknown[]>(x.review_reasons, []) ?? []).map(String),
    reviewed_by: x.reviewed_by ? String(x.reviewed_by) : null,
    reviewed_at: x.reviewed_at ? String(x.reviewed_at) : null,
    source_ids: rows.links
      .filter((l) => String(l.part_id) === String(x.id) && order.has(String(l.source_id)))
      .map((l) => String(l.source_id))
      .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)),
    materials: rows.materials
      .filter((mat) => String(mat.part_id) === String(x.id))
      .map((mat) => ({
        id: String(mat.id),
        position: Number(mat.position ?? 0),
        material_id: s(mat.material_id),
        material_unsure: bool(mat.material_unsure),
        colors: (safeParse<Record<string, unknown>[]>(mat.colors, []) ?? []).map(colourFromJson),
        finish: s(mat.finish),
        region_reference: s(mat.region_reference),
        requirements: s(mat.requirements),
        colors_need_review: bool(mat.colors_need_review),
        created_at: s(mat.created_at),
        updated_at: s(mat.updated_at),
      })),
    created_at: s(x.created_at),
    updated_at: s(x.updated_at),
  }));
  const job = jobFromRows(r, p, files.map((f) => f.kind));
  return { job, request: requestFactsFrom(r), sources, parts };
}

const TABLE_SQL = {
  sources: 'SELECT * FROM community_request_sources WHERE request_id = ? ORDER BY position, id',
  parts: 'SELECT * FROM community_request_parts WHERE request_id = ? ORDER BY position, id',
  links: `SELECT ps.part_id, ps.source_id FROM community_request_part_sources ps
            JOIN community_request_parts pt ON pt.id = ps.part_id WHERE pt.request_id = ?`,
  materials: `SELECT m.* FROM community_request_part_materials m
                JOIN community_request_parts pt ON pt.id = m.part_id WHERE pt.request_id = ? ORDER BY m.part_id, m.position, m.id`,
};

/**
 * THE ONE READ. Two round trips at most: the request, its print row (with the
 * freshness of its stamp) and its files; then, for a version-3 row only, the
 * four tables. A database before 0208 reads the v1 rows and synthesises. Null
 * for a request that does not exist.
 */
export async function readRequestModel(db: D1Database, requestId: string, opts: { restamp?: boolean } = {}): Promise<RequestModelRead | null> {
  let schema = true;
  let batch: D1Result<Record<string, unknown>>[];
  try {
    batch = (await db.batch([
      db.prepare('SELECT * FROM community_requests WHERE id = ?').bind(requestId),
      db.prepare(`SELECT p.*, (p.model_mirror = ${MIRROR_SQL('p')}) AS model_fresh FROM community_print_requests p WHERE p.request_id = ?`).bind(requestId),
      db.prepare(FILES_SQL).bind(requestId),
    ])) as D1Result<Record<string, unknown>>[];
  } catch (e) {
    if (!isMissingSchema(e)) throw e;
    schema = false;
    batch = (await db.batch([
      db.prepare('SELECT * FROM community_requests WHERE id = ?').bind(requestId),
      db.prepare('SELECT p.* FROM community_print_requests p WHERE p.request_id = ?').bind(requestId),
      db.prepare(FILES_SQL).bind(requestId),
    ])) as D1Result<Record<string, unknown>>[];
  }
  const r = batch[0]?.results?.[0] ? { ...batch[0].results[0] } : null;
  if (!r) return null;
  const pRaw = batch[1]?.results?.[0] ? { ...batch[1].results[0] } : null;
  const fresh = Number(pRaw?.model_fresh ?? 0) === 1;
  if (pRaw) delete pRaw.model_fresh;
  const p = pRaw;
  const modelFiles = (batch[2]?.results ?? []).map(toModelFile);
  const files = modelFiles.map(revisionFile);
  const v1 = factsFromRows(r, p, files);
  const storedVersion = Number(p?.schema_version ?? 1) || 1;
  const base = {
    request_id: requestId,
    stored_version: storedVersion,
    budget_visible: Number(r.budget_visible ?? 0) === 1,
    v1,
    files,
    modelFiles,
    rows: { r, p },
    schema,
  };

  if (p && storedVersion === 3 && schema) {
    try {
      const t = (await db.batch([
        db.prepare(TABLE_SQL.sources).bind(requestId),
        db.prepare(TABLE_SQL.parts).bind(requestId),
        db.prepare(TABLE_SQL.links).bind(requestId),
        db.prepare(TABLE_SQL.materials).bind(requestId),
      ])) as D1Result<Record<string, unknown>>[];
      const tables = mergeFiles(modelFromTables(r, p, modelFiles, {
        sources: t[0].results ?? [], parts: t[1].results ?? [], links: t[2].results ?? [], materials: t[3].results ?? [],
      }), modelFiles);
      const mirrored = tables.parts.length > 0 && (fresh || canonicalFacts(v1) === canonicalFacts(mirrorFacts(tables, files)));
      if (mirrored) {
        if (!fresh && opts.restamp !== false) await restamp(db, requestId, s(p.model_mirror));
        return { ...base, ...tables, schema_version: 3, origin: 'tables', stale: false, summary: summarize(tables) };
      }
      const synth = synthesizeModel(r, p, modelFiles);
      return { ...base, ...synth, schema_version: 1, origin: synth.origin, stale: true, summary: summarize(synth) };
    } catch (e) {
      if (!isMissingSchema(e)) throw e;
    }
  }
  const synth = synthesizeModel(r, p, modelFiles);
  return { ...base, ...synth, schema_version: 1, origin: synth.origin, stale: false, summary: summarize(synth) };
}

/** A version-3 row whose v1 row still mirrors its tables gets its stamp back. Never throws. */
async function restamp(db: D1Database, requestId: string, was: string): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE community_print_requests SET model_mirror = ${MIRROR_SQL('community_print_requests')}
          WHERE request_id = ? AND schema_version = 3 AND model_mirror = ?`
      )
      .bind(requestId, was)
      .run();
  } catch {
    /* the read stands without its stamp */
  }
}

// --------------------------------------------------------- writing the model

export interface ModelWriteEntry {
  request_id: string;
  model: ModelState;
  schema_version: 1 | 3;
  /** The job's race guard: the print row must still be exactly as it was read. */
  guard?: { updated_at: string; model_mirror: string };
}

const J = (path: string) => `json_extract(j.value, '$.${path}')`;

/**
 * THE MODEL'S SEVEN STATEMENTS, for the caller's batch: the old parts and
 * sources out (the cascade takes the links and materials), the new rows in
 * from one `json_each` parameter per table, and LAST the summary and the
 * stamp — `model_mirror` computed by SQLite from the print row as the same
 * batch left it. At most three bound parameters a statement, whatever the
 * number of requests.
 *
 * With `guard` on every entry (the quarter-hour job), each statement touches
 * only requests whose print row is still version 1 and exactly as it was read
 * (`updated_at`, `model_mirror`), so a writer that landed in between is never
 * overwritten.
 */
export function modelWriteStatements(db: D1Database, entries: ModelWriteEntry[], ts: string): D1PreparedStatement[] {
  if (!entries.length) return [];
  const guarded = entries.every((e) => !!e.guard);
  const ids = JSON.stringify(entries.map((e) => (guarded ? { rid: e.request_id, updated_at: e.guard!.updated_at, mirror: e.guard!.model_mirror } : { rid: e.request_id })));
  const ok = guarded
    ? `SELECT p.request_id FROM community_print_requests p JOIN json_each(?1) g
          ON p.request_id = json_extract(g.value, '$.rid') AND p.updated_at = json_extract(g.value, '$.updated_at')
         AND p.model_mirror = json_extract(g.value, '$.mirror') AND p.schema_version = 1`
    : `SELECT json_extract(g.value, '$.rid') FROM json_each(?1) g`;

  const sources: Record<string, unknown>[] = [];
  const parts: Record<string, unknown>[] = [];
  const links: Record<string, unknown>[] = [];
  const materials: Record<string, unknown>[] = [];
  const summaries: Record<string, unknown>[] = [];
  for (const e of entries) {
    const rid = e.request_id;
    e.model.sources.forEach((x, i) => sources.push({
      request_id: rid, id: x.id, kind: x.kind, file_id: x.file_id, sha256: SHA256.test(x.sha256) ? x.sha256 : '', role: x.role,
      url: x.url, canonical_url: x.canonical_url, provider: x.provider, ref_text: x.ref_text, origin_id: x.origin_id,
      origin_ref: x.origin_ref, origin_hash: x.origin_hash, origin_meta: JSON.stringify(x.origin_meta ?? {}), note: x.note,
      is_primary: x.is_primary ? 1 : 0, position: i, created_at: x.created_at || ts,
    }));
    e.model.parts.forEach((p, i) => {
      parts.push({
        request_id: rid, id: p.id, position: i, name: p.name, quantity: p.quantity, process: p.process,
        process_unsure: p.process_unsure ? 1 : 0, stated_dims: p.stated_dims ? JSON.stringify(p.stated_dims) : '',
        measured_file_id: p.measured_file_id, notes: p.notes, assembly_notes: p.assembly_notes, legacy_text: p.legacy_text,
        review_state: p.review_state, review_reasons: JSON.stringify(p.review_reasons), reviewed_by: p.reviewed_by,
        reviewed_at: p.reviewed_at, created_at: p.created_at || ts, updated_at: p.updated_at || ts,
      });
      for (const sid of p.source_ids) links.push({ request_id: rid, part_id: p.id, source_id: sid });
      p.materials.forEach((m, k) => materials.push({
        request_id: rid, id: m.id, part_id: p.id, position: k, material_id: m.material_id, material_unsure: m.material_unsure ? 1 : 0,
        colors: JSON.stringify(m.colors), finish: m.finish, region_reference: m.region_reference, requirements: m.requirements,
        colors_need_review: m.colors_need_review ? 1 : 0, created_at: m.created_at || ts, updated_at: m.updated_at || ts,
      }));
    });
    const sum = summarize(e.model);
    summaries.push({
      request_id: rid, schema_version: e.schema_version, parts_count: sum.parts_count, pieces_per_set: sum.pieces_per_set,
      materials_json: JSON.stringify(sum.materials), processes_json: JSON.stringify(sum.processes), colors_total: sum.colors_total,
      multicolor_parts: sum.multicolor_parts, review_state: sum.review_state,
    });
  }
  const insert = (table: string, cols: string[], rows: Record<string, unknown>[]) =>
    db
      .prepare(
        `INSERT INTO ${table} (${cols.join(', ')})
         SELECT ${cols.map((c) => J(c)).join(', ')} FROM json_each(?2) j
          WHERE json_extract(j.value, '$.request_id') IN (${ok})`
      )
      .bind(ids, JSON.stringify(rows));
  const SUM = ['schema_version', 'parts_count', 'pieces_per_set', 'materials_json', 'processes_json', 'colors_total', 'multicolor_parts', 'review_state'];
  return [
    db.prepare(`DELETE FROM community_request_parts WHERE request_id IN (${ok})`).bind(ids),
    db.prepare(`DELETE FROM community_request_sources WHERE request_id IN (${ok})`).bind(ids),
    insert('community_request_sources', ['id', 'request_id', 'kind', 'file_id', 'sha256', 'role', 'url', 'canonical_url', 'provider', 'ref_text',
      'origin_id', 'origin_ref', 'origin_hash', 'origin_meta', 'note', 'is_primary', 'position', 'created_at'], sources),
    insert('community_request_parts', ['id', 'request_id', 'position', 'name', 'quantity', 'process', 'process_unsure', 'stated_dims',
      'measured_file_id', 'notes', 'assembly_notes', 'legacy_text', 'review_state', 'review_reasons', 'reviewed_by', 'reviewed_at',
      'created_at', 'updated_at'], parts),
    db
      .prepare(
        `INSERT INTO community_request_part_sources (part_id, source_id)
         SELECT ${J('part_id')}, ${J('source_id')} FROM json_each(?2) j
          WHERE json_extract(j.value, '$.request_id') IN (${ok})`
      )
      .bind(ids, JSON.stringify(links)),
    insert('community_request_part_materials', ['id', 'part_id', 'position', 'material_id', 'material_unsure', 'colors', 'finish',
      'region_reference', 'requirements', 'colors_need_review', 'created_at', 'updated_at'], materials),
    db
      .prepare(
        `UPDATE community_print_requests SET
           (${SUM.join(', ')}) = (SELECT ${SUM.map((c) => J(c)).join(', ')} FROM json_each(?2) j
                                   WHERE json_extract(j.value, '$.request_id') = community_print_requests.request_id),
           model_mirror = ${MIRROR_SQL('community_print_requests')}
         WHERE request_id IN (${ok})`
      )
      .bind(ids, JSON.stringify(summaries)),
  ];
}

/**
 * A CUSTOMER SAVE NEVER UNDOES A REVIEW IT DID NOT SEE (P1-05, critique 5).
 * The model write deletes and re-inserts every part with the review state it
 * READ; a reviewer who confirmed (or reopened) a part after that read would
 * be silently reverted. For the caller's batch, after the request guard: the
 * request's `updated_at` goes NULL — the batch aborts as REQUEST_CHANGED —
 * when any part was reviewed later than the latest review the save read.
 * Only for a model read from the tables; a v1 request has no review to undo.
 */
export function reviewFenceStatement(db: D1Database, read: Pick<RequestModelRead, 'request_id' | 'schema_version' | 'parts'>): D1PreparedStatement[] {
  if (read.schema_version !== 3) return [];
  const seen = read.parts.map((p) => p.reviewed_at ?? '').reduce((a, b) => (b > a ? b : a), '');
  return [
    db
      .prepare(
        `UPDATE community_requests
            SET updated_at = CASE WHEN EXISTS (SELECT 1 FROM community_request_parts
                                                WHERE request_id = ?1 AND reviewed_at IS NOT NULL AND reviewed_at > ?2)
                                  THEN NULL ELSE updated_at END
          WHERE id = ?1`
      )
      .bind(read.request_id, seen),
  ];
}

/** SQLite's `length()` of a text: code points, where a JS length counts UTF-16 units. */
const sqlLength = (x: unknown): number => {
  let n = 0;
  for (const _ of s(x)) n++;
  return n;
};

/**
 * WHY THE FOUR TABLES WOULD REFUSE A MODEL — every CHECK, UNIQUE and
 * in-request reference migration 0208 declares, asked in code before a batch
 * is sent. The quarter-hour job marks a request whose synthesised model
 * fails here `error` up front, so one unwritable row never fails the batch it
 * would share with its page (worker/lib/requestModelBackfill.ts). `fileIds`
 * are the request's files as read (the composite file key, the measured
 * file's key). Null when every row would be accepted.
 */
export function modelRowProblem(m: ModelState, fileIds: ReadonlySet<string>): string | null {
  const sourceIds = new Set<string>();
  const files = new Set<string>();
  const links = new Set<string>();
  let primaries = 0;
  for (const x of m.sources) {
    const at = `source ${x.id || '?'}`;
    if (!x.id || sourceIds.has(x.id)) return `${at}: id missing or repeated`;
    sourceIds.add(x.id);
    if (!(REQUEST_SOURCE_KINDS as readonly string[]).includes(x.kind)) return `${at}: kind`;
    if (!(REQUEST_SOURCE_ROLES as readonly string[]).includes(x.role)) return `${at}: role`;
    if (isFileKind(x.kind) !== !!x.file_id) return `${at}: file`;
    if (x.file_id) {
      if (files.has(x.file_id) || !fileIds.has(x.file_id)) return `${at}: file repeated or not on the request`;
      files.add(x.file_id);
    }
    if (sqlLength(x.url) > LIMITS.linkCanonicalMax || sqlLength(x.canonical_url) > LIMITS.linkCanonicalMax) return `${at}: link too long`;
    if (sqlLength(x.provider) > 60 || sqlLength(x.ref_text) > LIMITS.textRefMax || sqlLength(x.note) > LIMITS.sourceNoteMax) return `${at}: text too long`;
    if (x.kind === 'link') {
      if (!x.canonical_url || links.has(x.canonical_url)) return `${at}: link empty or repeated`;
      links.add(x.canonical_url);
    }
    if (x.kind === 'text_ref' && !x.ref_text) return `${at}: empty reference`;
    if (x.is_primary) primaries++;
  }
  if (primaries > 1) return 'more than one primary source';
  const partIds = new Set<string>();
  const materialIds = new Set<string>();
  for (const p of m.parts) {
    const at = `part ${p.id || '?'}`;
    if (!p.id || partIds.has(p.id)) return `${at}: id missing or repeated`;
    partIds.add(p.id);
    if (!Number.isInteger(p.quantity) || p.quantity < 1 || p.quantity > LIMITS.partQuantityMax) return `${at}: quantity`;
    if (sqlLength(p.name) > LIMITS.partNameMax || sqlLength(p.notes) > LIMITS.partNotesMax || sqlLength(p.assembly_notes) > LIMITS.partNotesMax) {
      return `${at}: text too long`;
    }
    if (!(REQUEST_REVIEW_STATES as readonly string[]).includes(p.review_state)) return `${at}: review state`;
    if (p.measured_file_id && !fileIds.has(p.measured_file_id)) return `${at}: measured file not on the request`;
    if (new Set(p.source_ids).size !== p.source_ids.length || p.source_ids.some((id) => !sourceIds.has(id))) return `${at}: sources`;
    for (const x of p.materials) {
      if (!x.id || materialIds.has(x.id)) return `${at}: material id missing or repeated`;
      materialIds.add(x.id);
      if (sqlLength(x.region_reference) > LIMITS.regionReferenceMax || sqlLength(x.requirements) > LIMITS.requirementsMax) return `${at}: material text too long`;
    }
  }
  return null;
}

/**
 * A V1 WRITE OF THIS BUILD — a publish or a draft save of a v1 body —
 * rewrites the v1 columns a built version-1 cache was synthesised from: the
 * statement, for the same batch, that puts that cache back on the
 * quarter-hour job's work list (`model_mirror = ''`), as a file leaving does
 * (`restampAfterFileStatement`). `stored` is the print row the writer read
 * (`SELECT *`): without the column (a database before 0208) there is nothing
 * to reset, and nothing is sent. A version-3 row is written by the model and
 * never here.
 */
export function v1CacheResetStatements(db: D1Database, requestId: string, stored: Record<string, unknown> | null): D1PreparedStatement[] {
  if (!stored || !Object.prototype.hasOwnProperty.call(stored, 'model_mirror')) return [];
  return [
    db
      .prepare(`UPDATE community_print_requests SET model_mirror = '' WHERE request_id = ? AND schema_version = 1 AND model_mirror <> ''`)
      .bind(requestId),
  ];
}

// ------------------------------------------------------------ the snapshot

/**
 * A VERSION-3 REQUEST'S REVISION, as `composeSnapshot` records it: the v1
 * snapshot fields at the top level, unchanged in shape (old order screens
 * still render them), plus `schema_version: 3` and the snapshot projection of
 * the model — and the v3 hash.
 */
export async function modelSnapshot(read: RequestModelRead): Promise<RevisionSnapshot> {
  const { r, p } = read.rows;
  const analysis = safeParse<{ measured?: boolean; dimensions_mm?: Dims } | null>(p?.analysis, null);
  return {
    spec: modelSpec(r, read.v1, analysis?.measured && analysis.dimensions_mm ? analysis.dimensions_mm : null, read),
    files: read.files,
    estimate: publicEstimate(p?.estimate),
    hash: await factsHashV3(read),
  };
}

/** The spec of a version-3 revision. One function for the publish and for `composeSnapshot`, so both write the same bytes. */
export function modelSpec(
  r: Record<string, unknown>,
  facts: PricedFacts,
  measured: Dims | null,
  m: ModelState
): Record<string, unknown> {
  return { ...snapshotSpec(r, facts, measured), schema_version: 3, model: projectModel({ ...m, schema_version: 3 }, 'snapshot') };
}

/**
 * The model a revision's spec describes — its own `model`, or the one a v1
 * spec synthesises to — for the revision diff (critique 11): a first v3 save
 * diffed against a v1 revision shows only what really changed.
 */
export function modelOfSpec(spec: Record<string, unknown>, files: RevisionFile[]): Pick<ModelState, 'sources' | 'parts'> {
  const model = spec.model as Pick<ModelState, 'sources' | 'parts'> | undefined;
  if (model && Array.isArray(model.sources) && Array.isArray(model.parts)) return model;
  const p = {
    process: spec.process ?? 'fdm',
    process_unsure: spec.process === null ? 1 : 0,
    material_id: spec.material_id ?? '',
    material_unsure: spec.material_id === null ? 1 : 0,
    color_hex: spec.color_hex ?? '',
    color_name: spec.color_name ?? '',
    colors_count: spec.colors_count ?? 1,
    primary_file_id: spec.primary_file_id ?? null,
    source_url: spec.source_url ?? '',
    source_type: spec.source_type ?? '',
    source_kind: spec.source_type === 'link' ? 'link' : 'upload',
    stated_dims: spec.stated_dims ? JSON.stringify(spec.stated_dims) : '',
  };
  const mf = files.map((f) => ({ ...f, created_at: '', sha256: '', analysis: '' }));
  return synthesizeModel({ id: 'spec', quantity: spec.quantity }, p, mf);
}

// ----------------------------------------------------------- file policy

/**
 * The role of each file source of a request (Q5). Empty on a database before
 * 0208 — and ONLY there: any other failure is thrown, so a door that asks
 * fails closed (a 500) instead of serving an original to an eligible
 * merchant as if no file had a role.
 */
export async function fileSourceRoles(db: D1Database, requestId: string): Promise<Map<string, string>> {
  try {
    const { results } = await db
      .prepare(`SELECT file_id, role FROM community_request_sources WHERE request_id = ? AND file_id IS NOT NULL AND role <> ''`)
      .bind(requestId)
      .all<{ file_id: string; role: string }>();
    return new Map((results ?? []).map((x) => [String(x.file_id), String(x.role)]));
  } catch (e) {
    if (isMissingSchema(e)) return new Map();
    throw e;
  }
}

/**
 * A FILE IS LEAVING OR ARRIVING: the statement that re-stamps the
 * request's model in the same batch, read before it. A version-3 row whose
 * stamp was fresh is stamped from the v1 row the batch leaves (a delete's
 * cascade keeps the tables in step and its FK may null `primary_file_id`; a
 * new file is merged on read); a version-1 cache, built without the file or
 * with it, goes back to the job (`model_mirror = ''`). Guarded by the stamp
 * read here, so a writer that landed in between is left alone. Nothing on a
 * database before 0208.
 */
export async function restampAfterFileStatement(db: D1Database, requestId: string): Promise<D1PreparedStatement[]> {
  try {
    const row = await db
      .prepare(
        `SELECT model_mirror, schema_version, (model_mirror = ${MIRROR_SQL('p')}) AS fresh
           FROM community_print_requests p WHERE request_id = ?`
      )
      .bind(requestId)
      .first<{ model_mirror: string; schema_version: number; fresh: number }>();
    if (!row || Number(row.fresh) !== 1) return [];
    return [
      db
        .prepare(
          `UPDATE community_print_requests
              SET model_mirror = CASE WHEN schema_version = 3 THEN ${MIRROR_SQL('community_print_requests')} ELSE '' END
            WHERE request_id = ? AND model_mirror = ?`
        )
        .bind(requestId, String(row.model_mirror)),
    ];
  } catch (e) {
    if (isMissingSchema(e)) return [];
    throw e;
  }
}

// ------------------------------------------------------ reading a v3 body

/** A body in the v3 shape: it names a version, or carries parts or sources. Asked BEFORE the v1 reader (critique 12). */
export function isModelBody(body: Record<string, unknown>): boolean {
  return Number(body.schema_version) === 3 || Array.isArray(body.parts) || Array.isArray(body.sources);
}

export interface ModelInputContext {
  stored: RequestModelRead;
  files: ModelFile[];
  mats: ReadonlyArray<{ id: string; process: string }>;
  providers: LinkProviderConfig[];
  strict: boolean;
  ts: string;
  request: ModelRequestFacts;
  mint?: (prefix: string) => string;
}

const text = (v: unknown, name: string, max: number, code?: string): string => {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw badRequest(`${name} must be a string`);
  const t = v.trim();
  if (t.length > max) throw badRequest(`${name} is too long (max ${max} characters)`, code);
  return t;
};

const list = (v: unknown, name: string): Record<string, unknown>[] => {
  if (!Array.isArray(v)) throw badRequest(`${name} must be a list`);
  return v.map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {}));
};

/** What of a part decides its review: its priced content. */
const partContentKey = (p: ModelPart, sources: ModelSource[]) => JSON.stringify(pricedSections({ sources, parts: [p] }).parts);

/**
 * STABLE IDS ON A SAVE THAT CHANGES NOTHING (P1-05: an offer's coverage and
 * substitutions name part and material ROW ids). A part the body did not
 * echo — no id, or one the request never had — whose priced content equals a
 * stored part no echo claimed takes that part's id, its review and its
 * dates; and inside a kept part, a material the body did not echo takes the
 * id of the stored material it equals. So a client that drops ids, or a
 * customer who deletes a part and adds it back unchanged, saves a model the
 * hash calls unchanged (`replayed`, the offers stay pending) with the very
 * ids those offers name. Content that changed is a new part with a new id —
 * and a changed hash, which revises and supersedes.
 */
function keepStableIds(
  parts: ModelPart[],
  stored: Pick<ModelState, 'sources' | 'parts'>,
  sources: ModelSource[],
  mintedParts: ReadonlySet<ModelPart>,
  mintedMats: ReadonlySet<ModelMaterial>,
  ts: string
): void {
  const claimed = new Set(parts.filter((p) => !mintedParts.has(p)).map((p) => p.id));
  const storedById = new Map(stored.parts.map((p) => [p.id, p]));
  const colourNew = colourKeyOf(new Map(sources.map((x) => [x.id, sourceKey(x)])));
  const colourOld = colourKeyOf(new Map(stored.sources.map((x) => [x.id, sourceKey(x)])));
  for (const part of parts) {
    let twin = mintedParts.has(part) ? undefined : storedById.get(part.id);
    if (mintedParts.has(part)) {
      const key = partContentKey(part, sources);
      twin = stored.parts.find((p) => !claimed.has(p.id) && partContentKey(p, stored.sources) === key);
      if (!twin) continue;
      claimed.add(twin.id);
      part.id = twin.id;
      part.created_at = twin.created_at;
      part.review_state = twin.review_state;
      part.review_reasons = [...twin.review_reasons];
      part.reviewed_by = twin.reviewed_by;
      part.reviewed_at = twin.reviewed_at;
      part.updated_at = twin.name === part.name && twin.position === part.position ? twin.updated_at : ts;
    }
    if (!twin) continue;
    const taken = new Set(part.materials.filter((m) => !mintedMats.has(m)).map((m) => m.id));
    for (const mat of part.materials) {
      if (!mintedMats.has(mat)) continue;
      const key = JSON.stringify(materialKeyOf(mat, colourNew));
      const same = twin.materials.find((m) => !taken.has(m.id) && JSON.stringify(materialKeyOf(m, colourOld)) === key);
      if (!same) continue;
      taken.add(same.id);
      const coloursSame = JSON.stringify(same.colors) === JSON.stringify(mat.colors);
      mat.id = same.id;
      mat.created_at = same.created_at;
      mat.colors_need_review = same.colors_need_review && coloursSame;
      if (coloursSame && same.finish === mat.finish && same.region_reference === mat.region_reference &&
          same.requirements === mat.requirements && same.colors_need_review === mat.colors_need_review) {
        mat.updated_at = same.updated_at;
      }
    }
  }
}

/**
 * A V3 BODY, READ ONCE — for a draft save and for a publish.
 *
 * ABSENT IS CARRIED, NEVER DEFAULTED (R7): no `parts` keeps the stored parts,
 * no `sources` the stored sources, no job field the stored value. An id the
 * client echoes is kept only when the stored model (tables or synthesised)
 * has it with the same kind; any other id is minted, and a temporary id a
 * part or a colour points at is remapped. An echoed link whose URL did not
 * change keeps its stored URL, canonical form and provider verbatim — the
 * admin's provider list moving must not change a priced fact. A changed
 * material on a material with named colours sets `colors_need_review`; a part
 * whose priced content did not change keeps its review.
 *
 * Every file the request carries is a source afterwards (`mergeFiles`), so
 * the hash is taken on what `composeSnapshot` will read back.
 */
export function readModelInput(body: Record<string, unknown>, ctx: ModelInputContext): ModelState {
  const mint = ctx.mint ?? ((prefix: string) => newId(prefix));
  const { stored, files } = ctx;
  const fileById = new Map(files.map((f) => [f.id, f]));
  const storedById = new Map(stored.sources.map((x) => [x.id, x]));
  const storedByFile = new Map(stored.sources.filter((x) => x.file_id).map((x) => [x.file_id as string, x]));
  const idMap = new Map<string, string>();

  // ---- the job ------------------------------------------------------------
  const QUALITIES = ['draft', 'standard', 'fine', 'ultra'];
  const job: ModelJob = {
    quantity: body.quantity === undefined ? stored.job.quantity : int(body.quantity, 'quantity', { min: 1, max: 10000 }),
    quality: body.quality === undefined ? stored.job.quality : QUALITIES.includes(String(body.quality)) ? String(body.quality) : 'standard',
    infill_percent: body.infill_percent === undefined ? stored.job.infill_percent : int(body.infill_percent, 'infill_percent', { min: 0, max: 100 }),
    supports: body.supports === undefined ? stored.job.supports : body.supports !== false,
    post_processing_minutes: body.post_processing_minutes === undefined
      ? stored.job.post_processing_minutes
      : int(body.post_processing_minutes, 'post_processing_minutes', { min: 0, max: 600 }),
    source_type: stored.job.source_type,
  };

  // ---- the sources --------------------------------------------------------
  let sources: ModelSource[];
  if (body.sources === undefined) {
    sources = stored.sources.map((x) => ({ ...x, origin_meta: { ...x.origin_meta } }));
    for (const x of sources) idMap.set(x.id, x.id);
  } else {
    const raw = list(body.sources, 'sources');
    if (raw.length > 40) throw badRequest('sources: too many entries');
    sources = [];
    const seenFiles = new Set<string>();
    const echoedSources = new Set<string>();
    const minted = new Set<ModelSource>();
    for (const item of raw) {
      const bodyId = typeof item.id === 'string' ? item.id.slice(0, 80) : '';
      const kindIn = s(item.kind);
      // An id echoed twice is the stored source once: the second is a new one.
      let prev = bodyId && !echoedSources.has(bodyId) ? storedById.get(bodyId) : undefined;
      if (prev && kindIn && kindIn !== prev.kind) prev = undefined;
      if (prev) echoedSources.add(prev.id);
      const kind = (prev?.kind ?? kindIn) as RequestSourceKind;
      if (!prev && !(CLIENT_SOURCE_KINDS as readonly string[]).includes(kind)) {
        throw badRequest('A source is a file, a link or a text reference');
      }
      const note = item.note === undefined ? (prev?.note ?? '') : text(item.note, 'note', LIMITS.sourceNoteMax, 'SOURCE_NOTE_TOO_LONG');
      let role: RequestSourceRole = prev?.role ?? '';
      if (item.role !== undefined) {
        if (!(REQUEST_SOURCE_ROLES as readonly string[]).includes(s(item.role))) throw badRequest('role is not a source role');
        role = s(item.role) as RequestSourceRole;
      }
      const base: ModelSource = prev
        ? { ...prev, origin_meta: { ...prev.origin_meta } }
        : {
            id: '', kind, file_id: null, sha256: '', role: '', url: '', canonical_url: '', provider: '', ref_text: '',
            origin_id: '', origin_ref: '', origin_hash: '', origin_meta: {}, note: '', is_primary: false, position: 0, created_at: ctx.ts,
          };
      if (role === 'source' && !isFileKind(kind)) {
        throw badRequest('Only an uploaded file can be marked as the original', 'SOURCE_ROLE_INVALID');
      }
      const next: ModelSource = { ...base, kind, note, role, is_primary: item.is_primary === true };
      if (isFileKind(kind)) {
        const fileId = prev ? s(prev.file_id) : s(item.file_id);
        const f = fileById.get(fileId);
        if (!f) {
          if (prev) continue; // the file was deleted since: its source goes with it
          throw badRequest('That file does not belong to this request', 'FILE_NOT_FOUND');
        }
        if (seenFiles.has(fileId)) throw badRequest('A file is listed twice');
        seenFiles.add(fileId);
        const existing = storedByFile.get(fileId);
        next.id = prev?.id ?? existing?.id ?? `rps_${fileId}`;
        next.file_id = fileId;
        next.sha256 = prev?.sha256 || existing?.sha256 || f.sha256;
        if (!prev && existing) next.created_at = existing.created_at;
      } else if (kind === 'link') {
        const urlIn = item.url === undefined ? (prev?.url ?? '') : str(item.url, 'url', { max: LIMITS.linkUrlMax, required: false });
        if (prev && urlIn === prev.url) {
          next.url = prev.url;
          next.canonical_url = prev.canonical_url;
          next.provider = prev.provider;
        } else {
          const parsed = urlIn ? parseModelLink(urlIn, ctx.providers) : null;
          if (!parsed || parsed.canonical_url.length > LIMITS.linkCanonicalMax) throw badRequest('That link is not a valid https address', 'BAD_URL');
          next.url = urlIn;
          next.canonical_url = parsed.canonical_url;
          next.provider = parsed.provider.slice(0, 60);
        }
        next.id = prev?.id ?? mint('rps');
        if (!prev) minted.add(next);
      } else if (kind === 'text_ref') {
        next.ref_text = item.ref_text === undefined ? (prev?.ref_text ?? '') : text(item.ref_text, 'ref_text', LIMITS.textRefMax, 'SOURCE_NOTE_TOO_LONG');
        if (!next.ref_text) continue; // an empty reference box is no source
        next.id = prev?.id ?? mint('rps');
        if (!prev) minted.add(next);
      } else {
        next.id = prev!.id; // a server-made copy: carried, never re-pointed
      }
      if (bodyId) idMap.set(bodyId, next.id);
      idMap.set(next.id, next.id);
      sources.push(next);
    }
    // STABLE IDS: a link or a text reference the body did not echo keeps the
    // id of the stored one it equals (no other source of the body has it).
    const taken = new Set(sources.filter((x) => !minted.has(x)).map((x) => x.id));
    for (const x of minted) {
      const twin = stored.sources.find((y) => !taken.has(y.id) && y.kind === x.kind &&
        (x.kind === 'link' ? y.canonical_url === x.canonical_url : s(y.ref_text).trim() === s(x.ref_text).trim()));
      if (!twin) continue;
      taken.add(twin.id);
      for (const [k, v] of idMap) if (v === x.id) idMap.set(k, twin.id);
      idMap.delete(x.id);
      idMap.set(twin.id, twin.id);
      x.id = twin.id;
      x.created_at = twin.created_at;
    }
  }
  const links = sources.filter((x) => x.kind === 'link');
  if (links.length > LIMITS.maxLinks) throw badRequest(`Add at most ${LIMITS.maxLinks} links`, 'LINKS_TOO_MANY');
  if (new Set(links.map((x) => x.canonical_url)).size !== links.length) throw badRequest('This link is already added', 'LINK_DUPLICATE');
  if (sources.filter((x) => x.kind === 'text_ref').length > LIMITS.maxTextRefs) {
    throw badRequest(`Add at most ${LIMITS.maxTextRefs} text references`, 'TEXT_REFS_TOO_MANY');
  }
  if (sources.filter((x) => x.is_primary).length > 1) throw badRequest('Only one source can be the main one', 'SOURCE_PRIMARY_MULTIPLE');
  const finalIds = new Set(sources.map((x) => x.id));
  const resolveSource = (id: unknown, code: string, message: string): string => {
    const v = s(id);
    const to = idMap.get(v) ?? (finalIds.has(v) ? v : undefined);
    if (!to || !finalIds.has(to)) throw badRequest(message, code);
    return to;
  };

  // ---- the parts ----------------------------------------------------------
  const storedParts = new Map(stored.parts.map((p) => [p.id, p]));
  const matProcess = (id: string) => ctx.mats.find((m) => m.id === id)?.process ?? '';
  const echoed = new Set<string>();
  const echoedMats = new Set<string>();
  const mintedParts = new Set<ModelPart>();
  const mintedMats = new Set<ModelMaterial>();
  let parts: ModelPart[];
  if (body.parts === undefined) {
    parts = stored.parts.map((p) => ({
      ...p,
      source_ids: p.source_ids.filter((id) => finalIds.has(id)),
      materials: p.materials.map((m) => ({ ...m, colors: m.colors.map((c) => (c.ref && !finalIds.has(c.ref) ? { ...c, ref: '' } : { ...c })) })),
    }));
  } else {
    const raw = list(body.parts, 'parts');
    if (!raw.length) throw badRequest('Add at least one part', 'PARTS_EMPTY');
    if (raw.length > LIMITS.maxParts) throw badRequest(`A request can have at most ${LIMITS.maxParts} parts`, 'PARTS_TOO_MANY');
    parts = raw.map((item, index) => {
      // An id echoed twice is the stored part once: the second is a new part.
      const prev = typeof item.id === 'string' && !echoed.has(item.id) ? storedParts.get(item.id) : undefined;
      if (prev) echoed.add(prev.id);
      // process: «لست متأكدًا» is '' with the flag; a chosen material decides it below.
      let process: ModelPart['process'] = prev?.process ?? '';
      let processUnsure = prev?.process_unsure ?? true;
      if (item.process !== undefined || item.process_unsure !== undefined) {
        if (item.process === 'unsure' || item.process_unsure === true || item.process === '' || item.process === null) {
          process = '';
          processUnsure = true;
        } else if ((REQUEST_PROCESSES as readonly string[]).includes(s(item.process))) {
          process = s(item.process) as 'fdm' | 'resin';
          processUnsure = false;
        } else if (item.process !== undefined) {
          throw badRequest('process must be fdm, resin or unsure');
        }
      }
      let stated = prev?.stated_dims ?? null;
      const dimsIn = item.stated_dimensions_mm !== undefined ? item.stated_dimensions_mm : item.stated_dims;
      if (dimsIn !== undefined) {
        if (dimsIn === null || dimsIn === '') stated = null;
        else {
          stated = readDims(dimsIn);
          if (!stated) throw badRequest('Each dimension must be between 1 and 5000 mm', 'DIMENSIONS_INVALID');
        }
      }
      let measured = prev?.measured_file_id && fileById.has(prev.measured_file_id) ? prev.measured_file_id : null;
      if (item.measured_file_id !== undefined) {
        if (item.measured_file_id === null || item.measured_file_id === '') measured = null;
        else {
          const f = fileById.get(s(item.measured_file_id));
          if (!f || f.kind !== 'model') {
            throw badRequest("Choose a model file from this request's files", 'PART_MEASURED_FILE_INVALID');
          }
          measured = f.id;
        }
      }
      let sourceIds: string[];
      if (item.source_ids === undefined) {
        sourceIds = prev ? prev.source_ids.filter((id) => finalIds.has(id)) : raw.length === 1 ? sources.map((x) => x.id) : [];
      } else {
        if (!Array.isArray(item.source_ids)) throw badRequest('source_ids must be a list');
        sourceIds = [...new Set(item.source_ids.map((id) => resolveSource(id, 'PART_SOURCE_INVALID', 'A part points to a source that is not on this request')))];
      }

      let materials: ModelMaterial[];
      if (item.materials === undefined) {
        materials = (prev?.materials ?? []).map((m) => ({ ...m, colors: m.colors.map((c) => (c.ref && !finalIds.has(c.ref) ? { ...c, ref: '' } : { ...c })) }));
      } else {
        const rawMats = list(item.materials, 'materials');
        if (rawMats.length > LIMITS.maxMaterialsPerPart) {
          throw badRequest(`One part can take at most ${LIMITS.maxMaterialsPerPart} materials`, 'PART_MATERIALS_TOO_MANY');
        }
        materials = rawMats.map((m, k) => {
          const prevMat = typeof m.id === 'string' && !echoedMats.has(m.id) ? prev?.materials.find((x) => x.id === m.id) : undefined;
          let materialId = prevMat?.material_id ?? '';
          let materialUnsure = prevMat?.material_unsure ?? false;
          if (m.material_id !== undefined || m.material_unsure !== undefined) {
            if (m.material_id === 'unsure' || m.material_unsure === true) {
              materialId = '';
              materialUnsure = true;
            } else {
              materialId = str(m.material_id, 'material_id', { max: 60, required: false });
              materialUnsure = false;
            }
          }
          let colors: ModelColour[];
          if (m.colors === undefined) {
            colors = (prevMat?.colors ?? [anyColour()]).map((c) => (c.ref && !finalIds.has(c.ref) ? { ...c, ref: '' } : { ...c }));
          } else {
            const rawColours = list(m.colors, 'colors');
            if (rawColours.length > LIMITS.maxColoursPerMaterial) {
              throw badRequest(`One material can take at most ${LIMITS.maxColoursPerMaterial} colours`, 'COLOURS_TOO_MANY');
            }
            colors = rawColours.map((c, ci) => {
              const mode = s(c.mode) as RequestColourMode;
              if (!(REQUEST_COLOUR_MODES as readonly string[]).includes(mode)) throw badRequest('A colour mode is any, as_reference, catalogue or custom');
              if (mode === 'any') return anyColour();
              if (mode === 'as_reference') {
                const ref = c.ref === undefined || c.ref === '' || c.ref === null
                  ? ''
                  : resolveSource(c.ref, 'COLOUR_REF_INVALID', '"As in the reference" points to a source that is not there');
                return { mode, hex: '', label: '', palette: '', ref };
              }
              // A named colour. An echo of the stored one keeps its stored bytes.
              const was = prevMat?.colors[ci];
              const hexIn = s(c.hex);
              const labelIn = text(c.label, 'label', LIMITS.colourLabelMax);
              const echo = was && isSpecific(was) && s(was.hex).toLowerCase() === hexIn.toLowerCase() && s(was.label).trim() === labelIn;
              const hex = echo ? was!.hex : HEX6.test(hexIn) ? hexIn.toLowerCase() : '';
              const label = echo ? was!.label : labelIn;
              if (!hex && !label) return anyColour();
              const key = paletteKey(hex);
              return { mode: key ? 'catalogue' : 'custom', hex, label, palette: key, ref: '' } as ModelColour;
            });
            if (!colors.length) colors = [anyColour()];
          }
          let finish = prevMat?.finish ?? '';
          if (m.finish !== undefined) {
            const f = s(m.finish);
            if (f && !(REQUEST_FINISHES as readonly string[]).includes(f)) throw badRequest('finish is not one of the finishes');
            finish = f;
          }
          const region = m.region_reference === undefined ? (prevMat?.region_reference ?? '') : text(m.region_reference, 'region_reference', LIMITS.regionReferenceMax);
          const requirements = m.requirements === undefined ? (prevMat?.requirements ?? '') : text(m.requirements, 'requirements', LIMITS.requirementsMax);
          const materialChanged = !!prevMat && (prevMat.material_id !== materialId || prevMat.material_unsure !== materialUnsure);
          const coloursSame = !!prevMat && JSON.stringify(prevMat.colors) === JSON.stringify(colors);
          const needsReview = (materialChanged && colors.some((c) => c.mode !== 'any')) || (!!prevMat?.colors_need_review && coloursSame);
          const same = !!prevMat && !materialChanged && coloursSame && prevMat.finish === finish &&
            prevMat.region_reference === region && prevMat.requirements === requirements && prevMat.colors_need_review === needsReview;
          if (prevMat) echoedMats.add(prevMat.id);
          const out: ModelMaterial = {
            id: prevMat?.id ?? mint('rpm'),
            position: k,
            material_id: materialId,
            material_unsure: materialUnsure,
            colors,
            finish,
            region_reference: region,
            requirements,
            colors_need_review: needsReview,
            created_at: prevMat?.created_at || ctx.ts,
            updated_at: same ? prevMat!.updated_at : ctx.ts,
          };
          if (!prevMat) mintedMats.add(out);
          return out;
        });
      }
      if (!materials.length) {
        materials = [{
          id: mint('rpm'), position: 0, material_id: '', material_unsure: false, colors: [anyColour()], finish: '',
          region_reference: '', requirements: '', colors_need_review: false, created_at: ctx.ts, updated_at: ctx.ts,
        }];
      }
      // A chosen material decides the process (a material is FDM or resin), as v1's normalizeChoices does.
      const procs = [...new Set(materials.filter((m) => !m.material_unsure && m.material_id).map((m) => matProcess(m.material_id)).filter(Boolean))];
      if (procs.length === 1 && (procs[0] === 'fdm' || procs[0] === 'resin')) {
        process = procs[0];
        processUnsure = false;
      }
      const part: ModelPart = {
        id: prev?.id ?? mint('rpt'),
        position: index,
        name: item.name === undefined ? (prev?.name ?? '') : text(item.name, 'name', LIMITS.partNameMax),
        quantity: item.quantity === undefined ? (prev?.quantity ?? 1) : int(item.quantity, 'quantity', { min: 1, max: LIMITS.partQuantityMax }),
        process,
        process_unsure: processUnsure,
        stated_dims: stated,
        measured_file_id: measured,
        notes: item.notes === undefined ? (prev?.notes ?? '') : text(item.notes, 'notes', LIMITS.partNotesMax),
        assembly_notes: item.assembly_notes === undefined ? (prev?.assembly_notes ?? '') : text(item.assembly_notes, 'assembly_notes', LIMITS.partNotesMax),
        legacy_text: prev?.legacy_text ?? '',
        review_state: '',
        review_reasons: [],
        reviewed_by: null,
        reviewed_at: null,
        source_ids: sourceIds,
        materials,
        created_at: prev?.created_at || ctx.ts,
        updated_at: ctx.ts,
      };
      const unchanged = !!prev && partContentKey(prev, stored.sources) === partContentKey(part, sources);
      if (unchanged) {
        part.review_state = prev!.review_state;
        part.review_reasons = [...prev!.review_reasons];
        part.reviewed_by = prev!.reviewed_by;
        part.reviewed_at = prev!.reviewed_at;
        if (prev!.name === part.name && prev!.position === part.position) part.updated_at = prev!.updated_at;
      } else {
        part.review_reasons = reviewReasonsFor(part);
        part.review_state = part.review_reasons.length ? 'needs_technical_review' : '';
      }
      if (!prev) mintedParts.add(part);
      return part;
    });
    keepStableIds(parts, stored, sources, mintedParts, mintedMats, ctx.ts);
  }

  const merged = mergeFiles({ job, request: { ...ctx.request }, sources, parts }, files);

  // AN ORIGINAL IS NOT THE PUBLIC JOB (Q5): never the main source, never a
  // part's measured model — whichever of the two the body changed.
  const originals = originalFileIds(merged);
  if (merged.sources.some((x) => x.role === 'source' && x.is_primary) ||
      merged.parts.some((p) => p.measured_file_id && originals.has(p.measured_file_id))) {
    throw badRequest(
      'The original file is shown only to the merchant whose offer you accept, so it cannot be the main source or the model a part is measured from',
      'SOURCE_ORIGINAL_PRIVATE'
    );
  }

  // The effective source type: named in the body, else kept while the sources
  // and the primary are as stored, else what the sources now say.
  const explicit = (SOURCE_TYPES as readonly string[]).includes(s(body.source_type)) ? (s(body.source_type) as SourceType) : null;
  const primaryOf = (m: Pick<ModelState, 'sources'>) => m.sources.find((x) => x.is_primary)?.id ?? '';
  // A role is part of «the same sources»: marking a file the original can take the type it was.
  const roled = (x: ModelSource) => JSON.stringify([sourceKey(x), roleKey(x)]);
  const sourcesSame = JSON.stringify(stored.sources.map(roled).sort()) === JSON.stringify(merged.sources.map(roled).sort());
  merged.job.source_type = explicit ?? (sourcesSame && primaryOf(stored) === primaryOf(merged) ? stored.job.source_type : derivedSourceType(merged, files));

  if (ctx.strict && explicit) {
    const kindOf = (id: string | null) => (id ? fileById.get(id)?.kind ?? '' : '');
    const primary = merged.sources.find((x) => x.is_primary);
    if (explicit === 'model' && !merged.parts.some((p) => p.measured_file_id) && kindOf(primary?.file_id ?? null) !== 'model') {
      throw badRequest('Attach the model file this request is about', 'SOURCE_FILE_REQUIRED');
    }
    if (explicit === 'link' && !merged.sources.some((x) => x.kind === 'link')) {
      throw badRequest('Add the link to the model this request is about', 'SOURCE_LINK_REQUIRED');
    }
    if (explicit === 'images' && !files.some((f) => f.kind === 'reference')) {
      throw badRequest('Attach at least one picture of what you want made', 'SOURCE_IMAGES_REQUIRED');
    }
  }
  return merged;
}

/** The read of a model as the model state a writer starts from (the read's own fields only). */
export function stateOf(read: ModelState): ModelState {
  return { job: { ...read.job }, request: { ...read.request }, sources: read.sources, parts: read.parts };
}

