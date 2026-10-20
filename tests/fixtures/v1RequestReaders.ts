/**
 * THE V1 READERS, FROZEN (P1-04, docs/DECISIONS.md row 266).
 *
 * A verbatim copy of the 58cd8ce4 functions an OLDER build uses to decide
 * whether a request changed: `factsFromRows`, `canonicalFacts`, the
 * `effective*` readers, `readDims` / `parseDims`, `snapshotSpec` (from
 * worker/lib/requestRevisions.ts) and `storedPublishBody` (from
 * worker/routes/printRequests.ts, with the `parseJson` it calls).
 *
 * `tests/requestModelCompat.test.ts` runs them against rows the NEW build
 * wrote: an older Worker redeployed by hand must read the same v1 job, and
 * hash an unchanged job to the same string, as the build that wrote it. Never
 * edit this file to make a test pass — the point is that it does not move.
 */
import { createHash } from 'node:crypto';

const SOURCE_TYPES = ['model', 'link', 'images', 'description'] as const;
type SourceType = (typeof SOURCE_TYPES)[number];

export interface Dims {
  x: number;
  y: number;
  z: number;
}

export interface PricedFacts {
  quantity: number;
  source_type: string;
  process: string | null;
  material_id: string | null;
  color_hex: string;
  color_name: string;
  quality: string;
  infill_percent: number;
  supports: boolean;
  colors_count: number;
  post_processing_minutes: number;
  primary_file_id: string | null;
  source_url: string;
  stated_dims: Dims | null;
  governorate: string;
  delivery_pref: string;
  deadline: string;
  customer_notes: string;
  file_ids: string[];
}

export interface RevisionFile {
  id: string;
  kind: string;
  content_type: string;
  size_bytes: number;
  file_name: string;
}

function safeParse<T>(s: unknown, fallback: T): T {
  if (typeof s !== 'string' || s === '') return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

const parseJson = <T>(raw: unknown, fallback: T): T => {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v === null || v === undefined ? fallback : (v as T);
  } catch {
    return fallback;
  }
};

/** sha256 hex of the canonical string, as worker/lib/crypto.ts `sha256Hex` answers it. */
export const v1Sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** A dimension triple the customer typed, or null. Each edge 1–5000 mm. */
export function readDims(raw: unknown): Dims | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const n = (v: unknown) => {
    const x = Number(v);
    return Number.isFinite(x) && x >= 1 && x <= 5000 ? Math.round(x * 10) / 10 : NaN;
  };
  const d = { x: n(r.x), y: n(r.y), z: n(r.z) };
  return Number.isNaN(d.x) || Number.isNaN(d.y) || Number.isNaN(d.z) ? null : d;
}

/** The stated dimensions column, parsed. '' and garbage are "none". */
export function parseDims(raw: unknown): Dims | null {
  return readDims(safeParse<unknown>(raw, null));
}

/** «لست متأكدًا» — the process a row really asks for, or null when unsure. */
export function effectiveProcess(p: Record<string, unknown> | null | undefined): 'fdm' | 'resin' | null {
  if (!p) return null;
  if (Number(p.process_unsure ?? 0) === 1) return null;
  return p.process === 'resin' ? 'resin' : p.process === 'fdm' ? 'fdm' : null;
}

/** The material a row really asks for, or null when unsure / not chosen. */
export function effectiveMaterial(p: Record<string, unknown> | null | undefined): string | null {
  if (!p) return null;
  if (Number(p.material_unsure ?? 0) === 1) return null;
  const id = String(p.material_id ?? '');
  return id || null;
}

/** What `source_type` a row carries; older rows are derived from 0045's `source_kind`. */
export function effectiveSourceType(p: Record<string, unknown> | null | undefined, fileKinds: string[] = []): SourceType {
  const t = String(p?.source_type ?? '');
  if ((SOURCE_TYPES as readonly string[]).includes(t)) return t as SourceType;
  if (p?.source_kind === 'link') return 'link';
  if (p?.primary_file_id || fileKinds.includes('model')) return 'model';
  if (fileKinds.includes('reference')) return 'images';
  return 'description';
}

/** The priced facts as a canonical string: fixed key order, sorted file ids. */
export function canonicalFacts(f: PricedFacts): string {
  return JSON.stringify([
    f.quantity, f.source_type, f.process, f.material_id, f.color_hex.toLowerCase(), f.color_name,
    f.quality, f.infill_percent, f.supports, f.colors_count, f.post_processing_minutes,
    f.primary_file_id, f.source_url, f.stated_dims ? [f.stated_dims.x, f.stated_dims.y, f.stated_dims.z] : null,
    f.governorate, f.delivery_pref, f.deadline, f.customer_notes.trim(), [...f.file_ids].sort(),
  ]);
}

/** The priced facts of a request as the database holds them now. */
export function factsFromRows(
  r: Record<string, unknown>,
  p: Record<string, unknown> | null,
  files: RevisionFile[]
): PricedFacts {
  return {
    quantity: Number(r.quantity ?? 1),
    source_type: effectiveSourceType(p, files.map((f) => f.kind)),
    process: effectiveProcess(p),
    material_id: effectiveMaterial(p),
    color_hex: String(p?.color_hex ?? ''),
    color_name: String(p?.color_name ?? ''),
    quality: String(p?.quality ?? 'standard'),
    infill_percent: Number(p?.infill_percent ?? 20),
    supports: Number(p?.supports ?? 1) === 1,
    colors_count: Number(p?.colors_count ?? 1),
    post_processing_minutes: Number(p?.post_processing_minutes ?? 0),
    primary_file_id: (p?.primary_file_id as string | null) ?? null,
    source_url: String(p?.source_url ?? ''),
    stated_dims: parseDims(p?.stated_dims),
    governorate: String(r.governorate ?? ''),
    delivery_pref: String(r.delivery_pref ?? ''),
    deadline: String(r.deadline ?? ''),
    customer_notes: String(r.customer_notes ?? ''),
    file_ids: files.map((f) => f.id),
  };
}

/** The spec half of a snapshot: the priced facts plus what describes the job. */
export function snapshotSpec(r: Record<string, unknown>, facts: PricedFacts, measured: Dims | null): Record<string, unknown> {
  return {
    title: String(r.title ?? ''),
    description: String(r.description ?? ''),
    budget_iqd: r.budget_iqd === null || r.budget_iqd === undefined ? null : Number(r.budget_iqd),
    ...facts,
    process_unsure: facts.process === null,
    material_unsure: facts.material_id === null,
    measured_dims: measured,
  };
}

export function storedPublishBody(stored: Record<string, unknown>, request: Record<string, unknown>): Record<string, unknown> {
  const estimate = parseJson<{ accessory_lines?: Array<{ id?: unknown; qty?: unknown }> }>(stored.estimate, {});
  const dims = parseDims(stored.stated_dims);
  return {
    process: Number(stored.process_unsure ?? 0) === 1 ? 'unsure' : stored.process,
    material_id: Number(stored.material_unsure ?? 0) === 1 ? 'unsure' : stored.material_id,
    quality: stored.quality,
    infill_percent: Number(stored.infill_percent ?? 20),
    supports: Number(stored.supports ?? 1) === 1,
    colors_count: Number(stored.colors_count ?? 1),
    post_processing_minutes: Number(stored.post_processing_minutes ?? 0),
    quantity: Number(request.quantity ?? 1),
    color_hex: stored.color_hex ?? '',
    color_name: stored.color_name ?? '',
    accessories: (estimate.accessory_lines ?? []).map((l) => ({ id: l.id, qty: l.qty })),
    primary_file_id: stored.primary_file_id ?? undefined,
    source_kind: stored.source_kind,
    ...((SOURCE_TYPES as readonly string[]).includes(String(stored.source_type ?? '')) ? { source_type: stored.source_type } : {}),
    source_url: stored.source_url ?? '',
    source_meta: parseJson<Record<string, unknown>>(stored.source_meta, {}),
    ...(dims ? { stated_dimensions_mm: dims } : {}),
  };
}
