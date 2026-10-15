/**
 * FINGERPRINTS (spec §I.1.2, §B.2 product_source_refs.fingerprint).
 *
 * Two kinds:
 *
 *   - `extractionFingerprint`: sha256 of the canonical JSON of one page's
 *     normalised extraction (stored on product_source_refs; compared at a
 *     re-fetch, R-2).
 *   - the PUBLIC fingerprint: sha256 of a canonical projection of what a
 *     customer can read — the anonymous site answer (`GET /api/products/<slug>`,
 *     its `relations`) plus the knowledge answer (`GET /api/products/<slug>/knowledge`).
 *     The runner computes the EXPECTED value from its payload, the `/write`
 *     answer and the `/media` results with the same projection, and the live
 *     answers must hash to it. The projection holds: group, value and variant
 *     ids, order and combo keys; default values; image URLs with bindings and
 *     the primary; swatch URLs; public spec keys, scopes, regions, statuses,
 *     units and numbers; document kinds and URLs; relation labels and targets.
 *     Owner-only rows are not public, so they are not projected.
 */
import { sha256Hex } from './hash';
import type { Extraction } from './extract';
import type { ImportPayload } from './payload';

/** JSON with object keys sorted at every depth (arrays keep their order). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x)).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

/** sha256 of the normalised extraction (product_source_refs.fingerprint). */
export function extractionFingerprint(x: Extraction): string {
  return sha256Hex(canonicalJson(x));
}

// ---------------------------------------------------------------- the public projection

export interface Projection {
  groups: Array<{ id: string; sort: number; default_value_id: string; values: Array<{ id: string; sort: number }> }>;
  variants: Array<{ id: string; combo_key: string }>;
  images: Array<{ id: string; url: string; is_primary: boolean; option_value_id: string; variant_id: string }>;
  swatches: Array<{ value_id: string; url: string }>;
  specs: Array<{ key: string; scope_kind: string; scope_id: string; region: string; status: string; unit: string; value_num: number | null }>;
  documents: Array<{ kind: string; url: string }>;
  relations: Array<{ relation: string; scope_kind: string; scope_id: string; label: string; state: string; target: string }>;
}

const num = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : null);

/** A media URL by its object path, so `/files/x.webp` and `https://host/files/x.webp` compare equal. */
export function mediaPath(url: string | null | undefined): string {
  const u = (url ?? '').trim();
  const i = u.indexOf('/files/');
  return i >= 0 ? u.slice(i).split(/[?#]/)[0] : u.split(/[?#]/)[0];
}

/** Sorts every list into a canonical order (the projection is a set of facts, not a page layout). */
export function normaliseProjection(p: Projection): Projection {
  const by = <T>(xs: T[], key: (x: T) => string) => [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return {
    groups: by(
      p.groups.map((g) => ({ ...g, values: by(g.values, (v) => `${String(v.sort).padStart(6, '0')}|${v.id}`) })),
      (g) => `${String(g.sort).padStart(6, '0')}|${g.id}`
    ),
    variants: by(p.variants, (v) => v.id),
    images: by(p.images.map((i) => ({ ...i, url: mediaPath(i.url) })), (i) => i.id),
    swatches: by(p.swatches.map((s) => ({ ...s, url: mediaPath(s.url) })), (s) => s.value_id),
    specs: by(
      p.specs.map((s) => ({ ...s, value_num: num(s.value_num) })),
      (s) => `${s.key}|${s.scope_kind}|${s.scope_id}|${s.region}`
    ),
    documents: by(p.documents, (d) => `${d.kind}|${d.url}`),
    relations: by(p.relations, (r) => `${r.relation}|${r.scope_kind}|${r.scope_id}|${r.label}|${r.target}`),
  };
}

export function projectionFingerprint(p: Projection): string {
  return sha256Hex(canonicalJson(normaliseProjection(p)));
}

/** What `/media` answered for each staged medium. */
export interface MediaResult {
  source_media_id: string;
  r2_key: string;
}

/** The EXPECTED projection: the payload, the `/write` answer's product id and the `/media` results. */
export function projectionFromPayload(payload: ImportPayload, media: readonly MediaResult[]): Projection {
  const urlOf = new Map(media.map((m) => [m.source_media_id, `/files/${m.r2_key}`]));
  return {
    groups: payload.groups.map((g) => ({ id: g.id, sort: g.sort, default_value_id: g.default_value_id, values: g.values.map((v) => ({ id: v.id, sort: v.sort })) })),
    variants: payload.variants.map((v) => ({ id: v.id, combo_key: v.combo_key })),
    images: payload.images.map((i) => ({
      id: i.id,
      url: urlOf.get(i.source_media_id) ?? '',
      is_primary: i.is_primary,
      option_value_id: i.option_value_id ?? '',
      variant_id: i.variant_id ?? '',
    })),
    swatches: payload.swatches.map((s) => ({ value_id: s.value_id, url: urlOf.get(s.source_media_id) ?? '' })),
    specs: payload.specs
      .filter((s) => s.visibility === 'public')
      .map((s) => ({ key: s.key, scope_kind: s.scope_kind, scope_id: s.scope_id, region: s.region, status: s.status, unit: s.unit, value_num: s.value_num })),
    documents: payload.documents.map((d) => ({ kind: d.kind, url: d.url })),
    relations: payload.relations.map((r) => ({
      relation: r.relation,
      scope_kind: r.scope_kind,
      scope_id: r.scope_id,
      label: r.target_label,
      state: r.state,
      target: r.target_product_id ?? (r.target_source_handle ? `handle:${r.target_source_handle}` : ''),
    })),
  };
}

/** The anonymous site answer's `relations` (worker/lib/productOverlay.ts publicRelations), as far as the projection reads it. */
export interface SiteRelations {
  option_groups: Array<{ id: string; sort: number; default_value_id?: string; values: Array<{ id: string; sort: number }> }>;
  variants: Array<{ id: string; combo_key: string }>;
  images: Array<{ id: string; url: string; is_primary: boolean; option_value_id: string | null; variant_id: string | null }>;
}

/** The knowledge answer (`/api/products/<slug>/knowledge`), as far as the projection reads it. Owner rows never appear in it. */
export interface KnowledgeAnswer {
  swatches: Array<{ option_value_id: string; url: string }>;
  specs: Array<{ key: string; scope_kind: string; scope_id: string; region: string; status: string; unit: string; value_num: number | null }>;
  documents: Array<{ kind: string; url: string }>;
  relations: Array<{ relation: string; scope_kind: string; scope_id: string; target_label: string; state: string; target_product_id: string | null; target_source_handle?: string }>;
}

/** The LIVE projection: what the two public answers say. */
export function projectionFromSite(site: SiteRelations, knowledge: KnowledgeAnswer): Projection {
  return {
    groups: site.option_groups.map((g) => ({ id: g.id, sort: g.sort, default_value_id: g.default_value_id ?? '', values: g.values.map((v) => ({ id: v.id, sort: v.sort })) })),
    variants: site.variants.map((v) => ({ id: v.id, combo_key: v.combo_key })),
    images: site.images.map((i) => ({ id: i.id, url: i.url, is_primary: i.is_primary, option_value_id: i.option_value_id ?? '', variant_id: i.variant_id ?? '' })),
    swatches: knowledge.swatches.map((s) => ({ value_id: s.option_value_id, url: s.url })),
    specs: knowledge.specs.map((s) => ({ key: s.key, scope_kind: s.scope_kind, scope_id: s.scope_id, region: s.region, status: s.status, unit: s.unit, value_num: s.value_num })),
    documents: knowledge.documents.map((d) => ({ kind: d.kind, url: d.url })),
    relations: knowledge.relations.map((r) => ({
      relation: r.relation,
      scope_kind: r.scope_kind,
      scope_id: r.scope_id,
      label: r.target_label,
      state: r.state,
      target: r.target_product_id ?? (r.target_source_handle ? `handle:${r.target_source_handle}` : ''),
    })),
  };
}
