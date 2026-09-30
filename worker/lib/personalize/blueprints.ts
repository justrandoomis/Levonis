/**
 * THE BLUEPRINT STORE — what a merchant defines, saved, compiled, published
 * (Programme C, phase C1; docs/LEVO_PROJECT_PROGRAMME.md §B.1 hop 1, §B.2
 * items 1–6, §B.7 row customization_core, §0 rows 5–7, 21 and 39).
 *
 * ONE REVISION TABLE (migrations/0164_customization_core.sql). A product has
 * at most one `draft` (the one the builder edits), at most one `live` (the
 * one customers see) and any number of `retired` ones (paused or replaced —
 * kept, because an order may name them). Content is written only while a
 * revision is a draft; the database refuses anything else (`trg_blueprint_locked`,
 * BLUEPRINT_LOCKED). A save on a product whose newest revision is live or
 * retired opens the NEXT draft revision, starting as a copy of it (mesh,
 * parts, look and all), so the merchant never re-uploads to change a fee.
 *
 * THE GATES A SAVE AND A PUBLISH PASS (`validateBlueprint`):
 *   · the engine's `normalizeBlueprint` (packages/catalog/src/personalize/
 *     spec.ts) with everything the database knows: the mesh's part count and
 *     box, the product's OWN option groups and values (0126 — the axes annotate
 *     them), the product's own pictures → BLUEPRINT_INVALID {path, errors} or
 *     BLUEPRINT_PRICE_INVALID (every error a fee);
 *   · every look's material is one of the print materials catalogue
 *     (`printMaterials`), every size fits the workshop's largest bed
 *     (`merchant_request_prefs.max_build_mm`, any orientation) → BLUEPRINT_INVALID;
 *   · every slot option and fixed part is THIS store's part (L6's
 *     PART_BUYABLE_SQL through `loadStoreParts`) that fits its slot, and a
 *     Levonis item only once `parts_levonis` is on → BLUEPRINT_COMPONENT_NOT_ELIGIBLE.
 *
 * THE MODEL (`attachSource`): the merchant's own `product_file` uploads (≤ 12,
 * never `product_files` rows — P16) compiled INLINE by L4's
 * `compileBlueprintSource` into LVM1 + LVR1, stored gzip under the PRIVATE
 * draft key. BLUEPRINT_TOO_HEAVY {triangles, max} stores nothing;
 * BLUEPRINT_MODEL_UNREADABLE {format, hint} marks a draft that had no mesh
 * `failed` and keeps a working one as it was.
 *
 * THE LOOK CARD (`saveLook`): the builder's capture — a poster ≤ 400 KB
 * (PNG, WebP or JPEG, checked by its bytes), an RLE region-id map ≤ 8 KB, the
 * area quads and the camera — stored beside the public mesh and stamped with
 * the `basis` it was captured from (the draft mesh and the regions' and areas'
 * geometry): a publish refuses a card whose basis moved (BLUEPRINT_NOT_READY
 * {missing: ['look']}).
 *
 * PUBLISH: strict again, then the public mesh (the draft minus the hidden
 * parts, L4's `withoutParts`, every index kept) under the content-addressed
 * public key, and ONE batch — the old live row retired and this one live,
 * fenced on its state and rev (`ux_blueprint_live` makes two live revisions
 * impossible), `from_iqd` (the engine's price of the default configuration
 * of the cheapest variant), family, tags, the part refs, the audit row.
 */
import type { Context } from 'hono';
import type { AppContext, Env } from '../types';
import { safeParse } from '../types';
import { HttpError, notFound, badRequest } from '../http';
import { newId } from '../crypto';
import { auditStatements } from '../audit';
import { getSetting, type CustomizationConfig } from '../settings';
import { fitsInBuild } from '../eligibility';
import { ownedFileObject } from '../fileOwnership';
import { MODEL_MAX_BYTES } from '../attachments';
import { deleteMediaObject, getMediaObject, headMediaObject, putMediaObjectIfAbsent } from '../mediaStorage';
import { sniffImageBytes } from '../imageConvert';
import { rasterDimensions, validRasterDimensions } from '../imageMetadata';
import { purgeAnonymousCache, originOf } from '../edgePolicy';
import { rootDomainFrom, storeUrl } from '../hosts';
import { loadStoreParts, type StorePart } from './parts';
import {
  compileBlueprintSource,
  draftMeshKey,
  gunzipBytes,
  gzipBytes,
  meshHash,
  publicMeshKey,
  readLvr1,
  withoutParts,
  MESH_CONTENT_TYPE,
  type CompiledPart,
  type StlSourceFile,
} from './compile';
import { normalizeBlueprint, hiddenParts, isPhotoOnly } from '@levonis/catalog/personalize/spec';
import { canonicalJson, sha256Hex } from '@levonis/catalog/personalize/canonical';
import { defaultConfig } from '@levonis/catalog/personalize/config';
import { fitsSlot, partSpecToMap, readPartSpec, type PartSpec } from '@levonis/catalog/personalize/parts';
import { priceConfig, priceContext } from '@levonis/catalog/personalize/price';
import type { BlueprintSpec, EngineIssue, Quad, Vec3 } from '@levonis/catalog/personalize/types';

const nowIso = () => new Date().toISOString();

// ------------------------------------------------------------------ rows

/** One revision as stored (0164). JSON columns stay text here; `specOf` and friends read them. */
export interface BlueprintRow {
  id: string;
  product_id: string;
  store_id: string;
  merchant_id: string;
  rev: number;
  state: 'draft' | 'live' | 'retired';
  spec: string;
  private_json: string;
  source_keys: string;
  parts: string;
  analysis: string | null;
  mesh_state: 'none' | 'pending' | 'ready' | 'failed' | 'photo';
  draft_mesh_key: string | null;
  mesh_key: string | null;
  mesh_hash: string | null;
  mesh_bytes: number | null;
  triangles: number | null;
  look: string | null;
  photo_keys: string;
  family: string | null;
  tags: string;
  from_iqd: number | null;
  referenced_at: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  retired_at: string | null;
}

export const BLUEPRINT_COLUMNS =
  'id, product_id, store_id, merchant_id, rev, state, spec, private_json, source_keys, parts, analysis, mesh_state, draft_mesh_key, ' +
  'mesh_key, mesh_hash, mesh_bytes, triangles, look, photo_keys, family, tags, from_iqd, referenced_at, created_at, updated_at, published_at, retired_at';

/** The compile's facts (`analysis`): the source's format and box, and the draft mesh's own figures. */
export interface BlueprintAnalysis {
  format?: string;
  dims_mm?: Vec3;
  bbox_mm?: number[];
  snap_mm?: number;
  warnings?: string[];
  /** The DRAFT (full) mesh: SHA-256 of the uncompressed LVM, gzip bytes, triangles. */
  hash?: string;
  bytes?: number;
  triangles?: number;
  /** A source that could not be read. */
  hint?: string;
}

/** The look card as stored (`look`). */
export interface LookCard {
  poster_key: string;
  w: number;
  h: number;
  /** base64 of the RLE region-id map (≤ 8 KB decoded) — the builder's format, carried as is. */
  idmap: string;
  quads: Record<string, Quad>;
  camera: number[];
  /** What it was captured from (`lookBasis`). */
  basis: string;
}

export const analysisOf = (row: Pick<BlueprintRow, 'analysis'>): BlueprintAnalysis => safeParse<BlueprintAnalysis>(row.analysis, {});
export const partsOf = (row: Pick<BlueprintRow, 'parts'>): CompiledPart[] => safeParse<CompiledPart[]>(row.parts, []);
export const lookOf = (row: Pick<BlueprintRow, 'look'>): LookCard | null => safeParse<LookCard | null>(row.look, null);
export const photoKeysOf = (row: Pick<BlueprintRow, 'photo_keys'>): Record<string, string> => safeParse<Record<string, string>>(row.photo_keys, {});

/** The full BlueprintSpec a row holds (its public part and its private one), or null for a draft whose spec was never saved. */
export function specOf(row: Pick<BlueprintRow, 'spec' | 'private_json'>): BlueprintSpec | null {
  const spec = safeParse<Record<string, unknown> | null>(row.spec, null);
  if (!spec || spec.v !== 1) return null;
  return { ...(spec as unknown as BlueprintSpec), private: safeParse<BlueprintSpec['private']>(row.private_json, {}) };
}

// -------------------------------------------------------------- refusals

/** 400 BLUEPRINT_INVALID {path, errors: [{path, code}]} — or BLUEPRINT_PRICE_INVALID when every error is a fee. */
export function blueprintInvalid(errors: readonly EngineIssue[], code: 'BLUEPRINT_INVALID' | 'BLUEPRINT_PRICE_INVALID' = 'BLUEPRINT_INVALID'): HttpError {
  return new HttpError(
    400,
    code === 'BLUEPRINT_PRICE_INVALID' ? 'A price in the customization is not valid — check the highlighted fee.' : 'The customization has something to fix — check the highlighted fields.',
    code,
    { path: errors[0]?.path ?? '', errors: errors.slice(0, 50) }
  );
}

/** 400 BLUEPRINT_COMPONENT_NOT_ELIGIBLE {path, errors} — a slot option or fixed part that is not this store's part, or does not fit its slot. */
export function componentNotEligible(errors: readonly EngineIssue[]): HttpError {
  return new HttpError(400, 'A part in the customization is not one of your store\'s parts, or does not fit its slot.', 'BLUEPRINT_COMPONENT_NOT_ELIGIBLE', {
    path: errors[0]?.path ?? '',
    errors: errors.slice(0, 50),
  });
}

export const blueprintNotReady = (missing: readonly string[]): HttpError =>
  new HttpError(409, 'The customization is not ready to publish yet.', 'BLUEPRINT_NOT_READY', { missing: [...missing] });

export const blueprintIneligible = (reason: string): HttpError =>
  new HttpError(409, 'This product cannot be customized — a private or archived product stays as it is.', 'BLUEPRINT_PRODUCT_INELIGIBLE', { reason });

export const blueprintLocked = (details: Record<string, unknown> = {}): HttpError =>
  new HttpError(409, 'A published revision is never edited — reload to continue with the current draft.', 'BLUEPRINT_LOCKED', details);

export const blueprintLimit = (max: number): HttpError =>
  new HttpError(409, `Your store can have at most ${max} customizable products.`, 'BLUEPRINT_LIMIT', { max });

export const modelUnreadable = (format: string, hint: string): HttpError =>
  new HttpError(422, 'This model could not be read — export it again as a mesh file and try once more.', 'BLUEPRINT_MODEL_UNREADABLE', { format, hint });

export const modelTooHeavy = (triangles: number, max: number): HttpError =>
  new HttpError(413, 'This model is too detailed to show customers — export a lighter file, or use your product photos instead.', 'BLUEPRINT_TOO_HEAVY', {
    triangles,
    max,
  });

/**
 * A 0164 trigger's abort, as the refusal it names — so a race the code did
 * not see still answers in the builder's vocabulary, never a 500.
 */
export function triggerRefusal(e: unknown): HttpError | null {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('BLUEPRINT_LOCKED')) return blueprintLocked();
  if (msg.includes('BLUEPRINT_PRODUCT_INELIGIBLE')) return blueprintIneligible('private');
  if (/UNIQUE constraint failed: product_blueprints/.test(msg)) return blueprintLocked({ reason: 'changed' });
  // A batch's own fence (`fenceStatement`): the revision moved under the write.
  if (/NOT NULL constraint failed: product_blueprints\.state/.test(msg)) return blueprintLocked({ reason: 'changed' });
  return null;
}

/**
 * THE BATCH FENCE: rewrites the row's `state` to itself when the write before
 * it landed (the row is in `state` and carries `updatedAt`), else to NULL — and
 * the NOT NULL constraint then aborts the WHOLE batch, part refs and audit row
 * included (the idiom of worker/lib/orderCancelOps.ts). `triggerRefusal` reads
 * the abort as BLUEPRINT_LOCKED {reason: 'changed'}.
 */
function fenceStatement(db: D1Database, id: string, state: BlueprintRow['state'], updatedAt: string): D1PreparedStatement {
  return db
    .prepare(`UPDATE product_blueprints SET state = CASE WHEN state = ?2 AND updated_at = ?3 THEN state ELSE NULL END WHERE id = ?1`)
    .bind(id, state, updatedAt);
}

async function guarded<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (e) {
    throw triggerRefusal(e) ?? e;
  }
}

// ---------------------------------------------------------------- product

/** The product a blueprint belongs to, as the builder needs it. */
export interface BlueprintProduct {
  id: string;
  slug: string;
  name: string;
  merchant_id: string;
  store_id: string;
  price_iqd: number;
  prep_days: number;
  publish_state: string;
  variant_mode: string;
  track_stock: number;
  stock: number;
}

/**
 * The caller's OWN product, eligible for a blueprint: 404 for anyone else's
 * (nothing is confirmed), 409 BLUEPRINT_PRODUCT_INELIGIBLE for a private
 * (0152) or archived one, or one still on the pre-0126 option lists.
 */
export async function blueprintProduct(db: D1Database, merchantId: string, productId: string): Promise<BlueprintProduct> {
  return eligibleProduct(await productRow(db, productId), merchantId);
}

/** The product row a builder door names, whoever owns it (the owner is checked by `eligibleProduct`) — so the gate can read it in its first wave. */
export type ProductRow = BlueprintProduct & { audience_user_id: string | null };
export async function productRow(db: D1Database, productId: string): Promise<ProductRow | null> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(productId)) return null;
  return db
    .prepare(
      `SELECT id, slug, name, merchant_id, store_id, price_iqd, prep_days, publish_state, variant_mode, track_stock, stock, audience_user_id
         FROM community_products WHERE id = ?1`
    )
    .bind(productId)
    .first<ProductRow>();
}

/** 404 for a missing or another merchant's product (nothing is confirmed), else the 409s of `blueprintProduct`. */
export function eligibleProduct(p: ProductRow | null, merchantId: string): BlueprintProduct {
  if (!p || p.merchant_id !== merchantId) throw notFound('Product not found');
  if (p.audience_user_id) throw blueprintIneligible('private');
  if (p.publish_state === 'archived') throw blueprintIneligible('archived');
  if (p.variant_mode === 'legacy') throw blueprintIneligible('legacy_options');
  return p;
}

// ------------------------------------------------------------- revisions

export interface Revisions {
  /** The rows read (at most four: the draft, the live one, the newest, and `rev` when asked) — never the whole history. */
  all: BlueprintRow[];
  draft: BlueprintRow | null;
  live: BlueprintRow | null;
  /** The newest revision, whatever its state. */
  latest: BlueprintRow | null;
  maxRev: number;
}

/**
 * The revisions a write decides on — the draft, the live one, the newest
 * (whose number the next draft follows) and, when asked, revision `rev` — in
 * ONE bounded read: a product's retired history can grow with every publish
 * and is never loaded whole (`retiredHistory` pages it for the builder).
 */
export async function loadRevisions(db: D1Database, productId: string, opts: { rev?: number | null } = {}): Promise<Revisions> {
  const { results } = await db
    .prepare(
      `SELECT ${BLUEPRINT_COLUMNS} FROM product_blueprints
        WHERE product_id = ?1
          AND (state IN ('draft', 'live') OR rev = ?2
               OR rev = (SELECT MAX(x.rev) FROM product_blueprints x WHERE x.product_id = ?1))
        ORDER BY rev DESC`
    )
    .bind(productId, opts.rev ?? null)
    .all<BlueprintRow>();
  return revisionsFrom(results ?? []);
}

/** The builder's history of retired revisions, newest first: `RETIRED_PAGE` of them and whether there are more (limit + 1). */
export const RETIRED_PAGE = 20;
export async function retiredHistory(
  db: D1Database,
  productId: string
): Promise<{ items: Array<{ id: string; rev: number; published_at: string | null; retired_at: string | null }>; more: boolean }> {
  const { results } = await db
    .prepare(
      `SELECT id, rev, published_at, retired_at FROM product_blueprints
        WHERE product_id = ?1 AND state = 'retired' ORDER BY rev DESC LIMIT ?2`
    )
    .bind(productId, RETIRED_PAGE + 1)
    .all<{ id: string; rev: number; published_at: string | null; retired_at: string | null }>();
  const rows = results ?? [];
  return { items: rows.slice(0, RETIRED_PAGE), more: rows.length > RETIRED_PAGE };
}

export function revisionsFrom(all: BlueprintRow[]): Revisions {
  const sorted = [...all].sort((a, b) => b.rev - a.rev);
  return {
    all: sorted,
    draft: sorted.find((r) => r.state === 'draft') ?? null,
    live: sorted.find((r) => r.state === 'live') ?? null,
    latest: sorted[0] ?? null,
    maxRev: sorted[0]?.rev ?? 0,
  };
}

// ------------------------------------------------------------ references

/** What the database knows that a spec is checked against. */
export interface BlueprintRefs {
  /** The product's own option groups (0126) → their value ids. */
  groups: Record<string, string[]>;
  /** The product's pictures and clips. */
  media: Array<{ id: string; key: string; kind: 'image' | 'video' }>;
  /** Active material ids of the `printMaterials` catalogue. */
  materials: Map<string, number>;
  /** The workshop's largest bed on each axis (mm), null when it has no printer on record. */
  bed: Vec3 | null;
  /** This store's parts named by the spec (PART_BUYABLE), one row per sellable unit. */
  parts: StorePart[];
  /** The product's active variants: price by resolveCatalogLine's rule, stock, values by group. */
  variants: Array<{ id: string; price_iqd: number; in_stock: boolean; values: Record<string, string> }>;
}

/** Every part product id a (raw or normalised) spec names — slot options and fixed parts. */
export function partIdsIn(raw: unknown): string[] {
  const out = new Set<string>();
  const o = (raw ?? {}) as { slots?: unknown; fixed?: unknown };
  for (const s of Array.isArray(o.slots) ? o.slots : []) {
    for (const opt of Array.isArray((s as { options?: unknown })?.options) ? (s as { options: unknown[] }).options : []) {
      const p = (opt as { part?: { p?: unknown } })?.part?.p;
      if (typeof p === 'string' && p.length <= 64) out.add(p);
    }
  }
  for (const f of Array.isArray(o.fixed) ? o.fixed : []) {
    const p = (f as { part?: { p?: unknown } })?.part?.p;
    if (typeof p === 'string' && p.length <= 64) out.add(p);
  }
  return [...out].slice(0, 200);
}

export async function loadBlueprintRefs(db: D1Database, product: BlueprintProduct, partIds: readonly string[]): Promise<BlueprintRefs> {
  const [values, media, materials, prefs, parts, variants] = await Promise.all([
    db
      .prepare(
        `SELECT x.id, x.option_id FROM community_product_option_values x
           JOIN community_product_options o ON o.id = x.option_id
          WHERE x.product_id = ?1 ORDER BY o.position, x.position, x.id`
      )
      .bind(product.id)
      .all<{ id: string; option_id: string }>(),
    db
      .prepare('SELECT id, media_key, kind FROM community_product_media WHERE product_id = ?1 ORDER BY position, id')
      .bind(product.id)
      .all<{ id: string; media_key: string; kind: string }>(),
    getSetting(db, 'printMaterials'),
    db
      .prepare(
        `SELECT pr.max_build_mm FROM merchant_request_prefs pr WHERE pr.merchant_id = ?1`
      )
      .bind(product.merchant_id)
      .first<{ max_build_mm: string | null }>()
      .catch(() => null),
    partIds.length ? loadStoreParts(db, product.store_id, { ids: partIds }) : Promise.resolve([] as StorePart[]),
    productVariants(db, product),
  ]);
  const groups: Record<string, string[]> = {};
  for (const v of values.results ?? []) (groups[v.option_id] ??= []).push(v.id);
  const mats = new Map<string, number>();
  for (const m of (materials as unknown as Array<Record<string, unknown>>) ?? []) {
    if (m && typeof m.id === 'string' && m.active !== false) mats.set(m.id, Number(m.density_g_cm3) || 1.24);
  }
  const b = safeParse<Record<string, unknown>>(prefs?.max_build_mm, {});
  const x = Number(b.x) || 0;
  const y = Number(b.y) || 0;
  const z = Number(b.z) || 0;
  return {
    groups,
    media: (media.results ?? []).map((m) => ({ id: m.id, key: m.media_key, kind: m.kind === 'video' ? 'video' : 'image' })),
    materials: mats,
    bed: x > 0 && y > 0 && z > 0 ? [x, y, z] : null,
    parts,
    variants,
  };
}

/** The product's active variants, priced and stocked the way the cart prices them (resolveCatalogLine). */
export async function productVariants(
  db: D1Database,
  product: Pick<BlueprintProduct, 'id' | 'price_iqd' | 'variant_mode' | 'track_stock'>
): Promise<Array<{ id: string; price_iqd: number; in_stock: boolean; values: Record<string, string> }>> {
  if (product.variant_mode !== 'variants') return [];
  const { results } = await db
    .prepare(
      `SELECT v.id, v.price_iqd, v.stock,
              (SELECT json_group_object(x.option_id, x.id) FROM community_product_option_values x
                WHERE x.id IN (v.value1_id, v.value2_id, v.value3_id)) AS vals
         FROM community_product_variants v
        WHERE v.product_id = ?1 AND v.active = 1
        ORDER BY v.position, v.id`
    )
    .bind(product.id)
    .all<{ id: string; price_iqd: number | null; stock: number; vals: string }>();
  const tracked = Number(product.track_stock) === 1;
  return (results ?? []).map((v) => ({
    id: v.id,
    price_iqd: v.price_iqd === null || v.price_iqd === undefined ? Math.max(0, Math.trunc(Number(product.price_iqd) || 0)) : Math.max(0, Math.trunc(Number(v.price_iqd) || 0)),
    in_stock: !tracked || Number(v.stock) > 0,
    values: safeParse<Record<string, string>>(v.vals, {}),
  }));
}

// ------------------------------------------------------------- validation

export interface ValidateOptions {
  /** Parts in the draft mesh (its LVR1 ranges); unknown before a model is attached. */
  partCount?: number;
  /** The mesh's extents (mm). */
  bboxMm?: Vec3;
}

/** The mesh facts a revision's spec is checked against. */
export function meshFactsOf(row: BlueprintRow | null): ValidateOptions {
  if (!row || row.mesh_state !== 'ready') return {};
  const a = analysisOf(row);
  const dims = Array.isArray(a.dims_mm) && a.dims_mm.length === 3 && a.dims_mm.every((n) => Number.isFinite(n)) ? (a.dims_mm as Vec3) : undefined;
  return { partCount: partsOf(row).length || undefined, bboxMm: dims };
}

/**
 * THE GATE: the engine's normaliser with what the database knows, then the
 * references only the database can answer. Returns the normalised spec and the
 * pictures it names ({media_id: key}); throws the builder's refusals.
 */
export function validateBlueprint(
  raw: unknown,
  refs: BlueprintRefs,
  cfg: Pick<CustomizationConfig, 'parts_levonis'>,
  product: Pick<BlueprintProduct, 'id'>,
  opts: ValidateOptions = {}
): { spec: BlueprintSpec; photoKeys: Record<string, string> } {
  const images = refs.media.filter((m) => m.kind === 'image');
  const out = normalizeBlueprint(raw, {
    partCount: opts.partCount,
    bboxMm: opts.bboxMm,
    variantGroups: refs.groups,
    mediaIds: images.map((m) => m.id),
  });
  if (!out.ok) throw blueprintInvalid(out.errors ?? [{ path: out.path ?? '', code: 'INVALID' }], out.code === 'BLUEPRINT_PRICE_INVALID' ? 'BLUEPRINT_PRICE_INVALID' : 'BLUEPRINT_INVALID');
  const spec = out.value;

  const errors: EngineIssue[] = [];
  for (const [id, v] of Object.entries(spec.axes.look?.values ?? {})) {
    if (!refs.materials.has(v.material_id)) errors.push({ path: `axes.look.values.${id}.material_id`, code: 'UNKNOWN_REF' });
  }
  if (refs.bed) {
    const bed = refs.bed;
    for (const [id, v] of Object.entries(spec.axes.size?.values ?? {})) {
      if (!fitsInBuild({ x: v.dims_mm[0], y: v.dims_mm[1], z: v.dims_mm[2] }, { build_x_mm: bed[0], build_y_mm: bed[1], build_z_mm: bed[2] })) {
        errors.push({ path: `axes.size.values.${id}.dims_mm`, code: 'RANGE' });
      }
    }
  }
  if (errors.length) throw blueprintInvalid(errors);

  const parts: EngineIssue[] = [];
  const rowFor = (p: string, v: string | null): StorePart | undefined => refs.parts.find((r) => r.product_id === p && r.variant_id === (v ?? null));
  spec.slots.forEach((slot, i) => {
    slot.options.forEach((o, j) => {
      const path = `slots.${i}.options.${j}.part`;
      if (o.part.src === 'levonis') {
        if (!cfg.parts_levonis) parts.push({ path: `${path}.src`, code: 'NOT_ALLOWED' });
        return;
      }
      if (o.part.p === product.id) return void parts.push({ path, code: 'INVALID' });
      const row = rowFor(o.part.p, o.part.v);
      if (!row) return void parts.push({ path, code: 'UNKNOWN_REF' });
      if (!fitsSlot(row.spec, { kind: slot.kind, ...(slot.accepts ?? {}) })) parts.push({ path, code: 'INVALID' });
    });
  });
  spec.fixed.forEach((f, i) => {
    const path = `fixed.${i}.part`;
    if (f.part.src === 'levonis') {
      if (!cfg.parts_levonis) parts.push({ path: `${path}.src`, code: 'NOT_ALLOWED' });
      return;
    }
    if (f.part.p === product.id || !rowFor(f.part.p, f.part.v)) parts.push({ path, code: 'UNKNOWN_REF' });
  });
  if (parts.length) throw componentNotEligible(parts);

  const photoKeys: Record<string, string> = {};
  const named = new Set<string>([
    ...spec.photos.map((p) => p.media_id),
    ...spec.areas.flatMap((a) => (a.photo_frame ? [a.photo_frame.media_id] : [])),
  ]);
  for (const id of named) {
    const m = images.find((x) => x.id === id);
    if (m) photoKeys[id] = m.key;
  }
  return { spec, photoKeys };
}

/** The spec's public part and its private part, as the two columns store them. */
export function specColumns(spec: BlueprintSpec): { spec: string; private_json: string } {
  const { private: priv, ...pub } = spec;
  return { spec: canonicalJson(pub), private_json: canonicalJson(priv ?? {}) };
}

/** The derived part index of one revision: delete, then one row per slot option and fixed part (Levonis items are not store rows). */
export function partRefStatements(db: D1Database, productId: string, rev: number, spec: BlueprintSpec | null): D1PreparedStatement[] {
  const stmts = [db.prepare('DELETE FROM blueprint_part_refs WHERE product_id = ?1 AND rev = ?2').bind(productId, rev)];
  if (!spec) return stmts;
  const insert = (slot: string, option: string, p: string, v: string | null, qty: number) =>
    db
      .prepare(
        `INSERT OR REPLACE INTO blueprint_part_refs (product_id, rev, slot_key, option_key, part_product_id, part_variant_id, qty)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE EXISTS (SELECT 1 FROM community_products WHERE id = ?5)`
      )
      .bind(productId, rev, slot, option, p, v ?? '', qty);
  for (const s of spec.slots) for (const o of s.options) if (o.part.src !== 'levonis') stmts.push(insert(s.id, o.key, o.part.p, o.part.v, s.qty));
  spec.fixed.forEach((f, i) => {
    if (f.part.src !== 'levonis') stmts.push(insert('~fixed', String(i), f.part.p, f.part.v, f.qty));
  });
  return stmts;
}

// ----------------------------------------------------------------- drafts

export interface BuilderStore {
  store: { id: string; slug: string; user_id: string };
  merchant: { id: string };
}

/**
 * THE DRAFT, opened if there is none: the next revision, starting as a copy
 * of `from` (the published revision the builder was editing), else of the
 * live one, else of the newest — so a fee change never asks for the model
 * again. The first draft of a product counts against
 * `max_blueprints_per_store` (BLUEPRINT_LIMIT). Two builders racing to open it
 * meet at `ux_blueprint_draft` / UNIQUE (product_id, rev): the loser re-reads.
 */
export async function ensureDraft(
  db: D1Database,
  ctx: BuilderStore,
  product: BlueprintProduct,
  cfg: Pick<CustomizationConfig, 'max_blueprints_per_store'>,
  known?: Revisions,
  from?: BlueprintRow
): Promise<{ row: BlueprintRow; revs: Revisions; created: boolean }> {
  let revs = known;
  for (let attempt = 0; attempt < 3; attempt++) {
    revs ??= await loadRevisions(db, product.id);
    if (revs.draft) return { row: revs.draft, revs, created: false };
    if (!revs.latest) {
      const used = await db
        .prepare('SELECT COUNT(DISTINCT product_id) AS n FROM product_blueprints WHERE store_id = ?1')
        .bind(product.store_id)
        .first<{ n: number }>();
      if (Number(used?.n ?? 0) >= cfg.max_blueprints_per_store) throw blueprintLimit(cfg.max_blueprints_per_store);
    }
    const base = (from && from.state !== 'draft' ? from : null) ?? revs.live ?? revs.latest;
    const a = base ? analysisOf(base) : {};
    const ts = nowIso();
    const row: BlueprintRow = {
      id: newId('bp'),
      product_id: product.id,
      store_id: product.store_id,
      merchant_id: product.merchant_id,
      rev: revs.maxRev + 1,
      state: 'draft',
      spec: base?.spec ?? '{}',
      private_json: base?.private_json ?? '{}',
      source_keys: base?.source_keys ?? '[]',
      parts: base?.parts ?? '[]',
      analysis: base?.analysis ?? null,
      mesh_state: base?.mesh_state ?? 'none',
      draft_mesh_key: base?.draft_mesh_key ?? null,
      mesh_key: null,
      // A live/retired row's figures are its PUBLIC mesh's; the draft's own are in `analysis`.
      mesh_hash: base ? (base.state === 'draft' ? base.mesh_hash : a.hash ?? null) : null,
      mesh_bytes: base ? (base.state === 'draft' ? base.mesh_bytes : a.bytes ?? null) : null,
      triangles: base ? (base.state === 'draft' ? base.triangles : a.triangles ?? null) : null,
      look: base?.look ?? null,
      photo_keys: base?.photo_keys ?? '{}',
      family: base?.family ?? null,
      tags: base?.tags ?? '[]',
      from_iqd: null,
      referenced_at: null,
      created_at: ts,
      updated_at: ts,
      published_at: null,
      retired_at: null,
    };
    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO product_blueprints (id, product_id, store_id, merchant_id, rev, state, spec, private_json, source_keys, parts, analysis,
                                             mesh_state, draft_mesh_key, mesh_hash, mesh_bytes, triangles, look, photo_keys, family, tags,
                                             created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'draft', ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?20)`
          )
          .bind(
            row.id, row.product_id, row.store_id, row.merchant_id, row.rev, row.spec, row.private_json, row.source_keys, row.parts, row.analysis,
            row.mesh_state === 'pending' ? 'none' : row.mesh_state, row.draft_mesh_key, row.mesh_hash, row.mesh_bytes, row.triangles, row.look,
            row.photo_keys, row.family, row.tags, ts
          ),
        ...partRefStatements(db, row.product_id, row.rev, specOf(row)),
      ]);
      return { row, revs: revisionsFrom([row, ...revs.all]), created: true };
    } catch (e) {
      const refusal = triggerRefusal(e);
      if (!refusal || refusal.code !== 'BLUEPRINT_LOCKED') throw refusal ?? e;
      revs = undefined;
    }
  }
  throw blueprintLocked({ reason: 'changed' });
}

/**
 * An UPDATE of the draft row, fenced on it still being that draft; 409 when it
 * was published or replaced meanwhile. The `extra` statements (the part refs,
 * the audit row) land only with it: the batch fence aborts them all otherwise,
 * so a save that lost a race to a publish never rewrites a LIVE revision's refs.
 */
async function updateDraft(db: D1Database, draft: BlueprintRow, set: Record<string, unknown>, extra: D1PreparedStatement[] = []): Promise<void> {
  const fields: Record<string, unknown> = { ...set, updated_at: typeof set.updated_at === 'string' ? set.updated_at : nowIso() };
  const names = Object.keys(fields);
  const stmt = db
    .prepare(
      `UPDATE product_blueprints SET ${names.map((n, i) => `${n} = ?${i + 1}`).join(', ')}
        WHERE id = ?${names.length + 1} AND state = 'draft'`
    )
    .bind(...names.map((n) => fields[n]), draft.id);
  const res = await guarded(db.batch([stmt, fenceStatement(db, draft.id, 'draft', String(fields.updated_at)), ...extra]));
  if (!res[0]?.meta?.changes) throw blueprintLocked({ reason: 'changed' });
}

/**
 * PUT …/blueprint/draft {spec, rev?} — validate and store the draft (opening
 * one when needed). `rev`, when sent, is the revision the builder was editing:
 * a live or retired one opens the next draft from it; a draft other than the
 * current one is BLUEPRINT_LOCKED {draft_rev} (someone else opened it — reload).
 */
export async function saveDraft(
  db: D1Database,
  input: { ctx: BuilderStore; product: BlueprintProduct; raw: unknown; rev?: number | null; cfg: CustomizationConfig; actorId: string }
): Promise<BlueprintRow> {
  const { ctx, product, cfg } = input;
  const named = input.rev !== undefined && input.rev !== null ? input.rev : null;
  // One wave: the revisions and everything the spec is checked against.
  const [revs, refs] = await Promise.all([loadRevisions(db, product.id, { rev: named }), loadBlueprintRefs(db, product, partIdsIn(input.raw))]);
  // The published revision the builder was editing: the next draft starts from it.
  let from: BlueprintRow | undefined;
  if (named !== null) {
    const was = revs.all.find((r) => r.rev === named);
    if (!was) throw blueprintLocked({ rev: named, draft_rev: revs.draft?.rev ?? null });
    if (was.state === 'draft' ? was.id !== revs.draft?.id : revs.draft && revs.draft.rev !== named) {
      throw blueprintLocked({ rev: named, draft_rev: revs.draft?.rev ?? null });
    }
    if (was.state !== 'draft') from = was;
  }
  const base = revs.draft ?? from ?? revs.live ?? revs.latest;
  const { spec, photoKeys } = validateBlueprint(input.raw, refs, cfg, product, meshFactsOf(base));
  const { row } = await ensureDraft(db, input.ctx, product, cfg, revs, from);
  const cols = specColumns(spec);
  const photoOnly = isPhotoOnly(spec);
  const meshState = photoOnly && row.mesh_state !== 'ready' ? 'photo' : !photoOnly && row.mesh_state === 'photo' ? 'none' : row.mesh_state;
  const ts = nowIso();
  const audit = await auditStatements(db, input.actorId, 'blueprint.draft_saved', product.id, { store: ctx.store.id, rev: row.rev });
  await updateDraft(
    db,
    row,
    {
      spec: cols.spec,
      private_json: cols.private_json,
      photo_keys: canonicalJson(photoKeys),
      family: spec.family,
      tags: canonicalJson(spec.tags),
      mesh_state: meshState,
      updated_at: ts,
    },
    [...partRefStatements(db, product.id, row.rev, spec), ...audit.statements]
  );
  return { ...row, ...cols, photo_keys: canonicalJson(photoKeys), family: spec.family, tags: canonicalJson(spec.tags), mesh_state: meshState, updated_at: ts };
}

// ------------------------------------------------------------------ model

/**
 * PUT …/blueprint/model {keys} — the merchant's own `product_file` uploads
 * (1–12: one 3MF/OBJ/GLB/AMF, or up to twelve STL pieces) compiled INLINE
 * into the private draft mesh. Every key must be the caller's own private
 * `product_file` object under their prefix (400 PRODUCT_FILE_NOT_OWNED); the
 * set is read only when each object and their sum fit MODEL_MAX_BYTES.
 */
export async function attachSource(
  db: D1Database,
  env: Env,
  input: { ctx: BuilderStore; product: BlueprintProduct; keys: string[]; cfg: CustomizationConfig; actorId: string }
): Promise<BlueprintRow> {
  const { ctx, product, cfg } = input;
  const uid = ctx.store.user_id;
  const keys = [...new Set(input.keys)];
  const owned = await Promise.all(
    keys.map((k) => ownedFileObject(db, k, uid, ['product_file'], { exactPurpose: true, prefix: `merchants/${uid}/product-files/` }))
  );
  const missing = keys.filter((_, i) => !owned[i]);
  if (missing.length) throw badRequest('That file is not one of your uploads', 'PRODUCT_FILE_NOT_OWNED', { key: missing[0] });
  const files = owned.map((o) => o!);
  if (files.some((f) => f.kind !== 'model')) throw modelUnreadable('unknown', 'export_mesh');
  const heads = await Promise.all(files.map((f) => headMediaObject(env, 'private', f.key)));
  if (heads.some((h) => !h)) throw modelUnreadable('unknown', 'damaged');
  const sizes = heads.map((h) => Number(h!.size) || 0);
  if (sizes.some((s) => s > MODEL_MAX_BYTES) || sizes.reduce((a, b) => a + b, 0) > MODEL_MAX_BYTES) throw modelUnreadable('unknown', 'too_heavy');
  const sources: StlSourceFile[] = [];
  for (const f of files) {
    const obj = await getMediaObject(env, 'private', f.key);
    if (!obj) throw modelUnreadable('unknown', 'damaged');
    sources.push({ name: f.original_name || f.key.slice(f.key.lastIndexOf('/') + 1), bytes: new Uint8Array(await obj.arrayBuffer()) });
  }

  const compiled = await compileBlueprintSource(sources, { maxTriangles: cfg.max_triangles });
  const revs = await loadRevisions(db, product.id);
  if (!compiled.ok) {
    if (compiled.code === 'BLUEPRINT_TOO_HEAVY') throw modelTooHeavy(compiled.triangles, compiled.max);
    // A draft with no working mesh remembers why; a working one is kept as it was.
    const draft = revs.draft;
    if (draft && draft.mesh_state !== 'ready') {
      await updateDraft(db, draft, {
        mesh_state: 'failed',
        analysis: canonicalJson({ format: compiled.format, hint: compiled.hint }),
        source_keys: canonicalJson(keys),
        updated_at: nowIso(),
      }).catch(() => undefined);
    }
    throw modelUnreadable(compiled.format, compiled.hint);
  }

  // The draft first: a store over its blueprint limit (BLUEPRINT_LIMIT) stores no bytes.
  const { row } = await ensureDraft(db, ctx, product, cfg, revs);
  const gz = await gzipBytes(compiled.lvm);
  const key = draftMeshKey(uid, product.id, compiled.hash);
  await putMediaObjectIfAbsent(
    env,
    { key, visibility: 'private', domain: 'merchants', mime: MESH_CONTENT_TYPE, bytes: gz.byteLength, ownerId: uid, entityId: product.id },
    gz,
    { httpMetadata: { contentType: MESH_CONTENT_TYPE, cacheControl: 'private, max-age=0' } }
  );
  const analysis: BlueprintAnalysis = {
    format: compiled.format,
    dims_mm: compiled.dims_mm,
    bbox_mm: compiled.bbox_mm,
    snap_mm: compiled.snap_mm,
    warnings: compiled.warnings,
    hash: compiled.hash,
    bytes: gz.byteLength,
    triangles: compiled.triangles,
  };
  const ts = nowIso();
  const set = {
    source_keys: canonicalJson(keys),
    parts: JSON.stringify(compiled.parts),
    analysis: canonicalJson(analysis),
    mesh_state: 'ready',
    draft_mesh_key: key,
    mesh_hash: compiled.hash,
    mesh_bytes: gz.byteLength,
    triangles: compiled.triangles,
    updated_at: ts,
  };
  const audit = await auditStatements(db, input.actorId, 'blueprint.model_attached', product.id, {
    store: ctx.store.id,
    rev: row.rev,
    files: keys.length,
    triangles: compiled.triangles,
    parts: compiled.parts.length,
  });
  await updateDraft(db, row, set, audit.statements);
  // The replaced draft mesh goes when no revision (of this product or a copy of it) still names it.
  if (row.draft_mesh_key && row.draft_mesh_key !== key) await forgetIfUnreferenced(db, env, 'private', row.draft_mesh_key, 'draft_mesh_key');
  return { ...row, ...set, mesh_state: 'ready' };
}

/** Delete a stored object once no revision names it in `column` (best effort: the media sweep is the backstop). */
async function forgetIfUnreferenced(db: D1Database, env: Env, visibility: 'public' | 'private', key: string, column: 'draft_mesh_key' | 'look'): Promise<void> {
  try {
    const still = await db
      .prepare(
        column === 'look'
          ? `SELECT 1 AS x FROM product_blueprints WHERE json_valid(look) AND json_extract(look, '$.poster_key') = ?1 LIMIT 1`
          : 'SELECT 1 AS x FROM product_blueprints WHERE draft_mesh_key = ?1 LIMIT 1'
      )
      .bind(key)
      .first();
    if (!still) await deleteMediaObject(env, visibility, key);
  } catch (e) {
    console.error('blueprint object not forgotten (the media sweep will)', key, e instanceof Error ? e.message : String(e));
  }
}

// ------------------------------------------------------------------- look

/** The poster's ceiling — the store layout's poster cap. */
export const LOOK_POSTER_MAX_BYTES = 400 * 1024;
/** The RLE region-id map's ceiling (decoded). */
export const LOOK_IDMAP_MAX_BYTES = 8 * 1024;

const POSTER_EXT: Record<string, string> = { 'image/png': 'png', 'image/webp': 'webp', 'image/jpeg': 'jpg' };

/**
 * What a look card was captured from: the draft mesh, and the regions' parts
 * and the areas' frames. A publish refuses a card whose basis moved.
 */
export async function lookBasis(spec: BlueprintSpec, meshHashHex: string | null): Promise<string> {
  return sha256Hex(
    canonicalJson({
      mesh: meshHashHex ?? '',
      regions: spec.regions.map((r) => ({ id: r.id, parts: r.parts })),
      areas: spec.areas.map((a) => ({ id: a.id, kind: a.kind, region: a.region, frame: a.frame ?? null })),
    })
  );
}

function decodeBase64(v: unknown, max: number): Uint8Array | null {
  if (typeof v !== 'string' || !v || v.length > Math.ceil(max / 3) * 4 + 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return null;
  try {
    const bin = atob(v);
    if (bin.length > max) return null;
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** A base64 text whose decoded size would pass `max` (so the refusal says TOO_LARGE, not TYPE). */
const tooLong = (v: unknown, max: number): boolean => typeof v === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(v) && Math.floor((v.length * 3) / 4) > max;

const isQuad = (q: unknown): q is Quad =>
  Array.isArray(q) && q.length === 4 && q.every((p) => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1));

/**
 * PUT …/blueprint/look {poster, idmap, quads, camera} — the builder's capture
 * of the draft: `poster` base64 PNG/WebP/JPEG ≤ 400 KB (its size read from its
 * own bytes), `idmap` base64 ≤ 8 KB, `quads` {areaId: [[x,y]×4] in 0..1} for
 * every area of the draft, `camera` 16 numbers (clip-from-mm, column-major).
 * The poster is stored PUBLIC and content-addressed beside the public mesh
 * (merchants/<uid>/public/bp/<id>-look-<sha12>.<ext>).
 */
export async function saveLook(
  db: D1Database,
  env: Env,
  input: { ctx: BuilderStore; product: BlueprintProduct; body: Record<string, unknown>; actorId: string }
): Promise<BlueprintRow> {
  const { ctx, product, body } = input;
  const revs = await loadRevisions(db, product.id);
  const draft = revs.draft;
  const spec = draft ? specOf(draft) : null;
  if (!draft || !spec) throw blueprintNotReady(['spec']);
  if (draft.mesh_state !== 'ready' || isPhotoOnly(spec)) throw blueprintNotReady(['mesh']);

  const errors: EngineIssue[] = [];
  const poster = decodeBase64(body.poster, LOOK_POSTER_MAX_BYTES);
  const sniffed = poster ? sniffImageBytes(poster) : null;
  const ext = sniffed ? POSTER_EXT[sniffed.mime] : undefined;
  const dims = poster && sniffed ? rasterDimensions(poster, sniffed.mime) : null;
  if (!poster) errors.push({ path: 'poster', code: tooLong(body.poster, LOOK_POSTER_MAX_BYTES) ? 'TOO_LARGE' : 'TYPE' });
  else if (!ext || !validRasterDimensions(dims) || dims.width > 4096 || dims.height > 4096) errors.push({ path: 'poster', code: 'TYPE' });
  const idmap = decodeBase64(body.idmap, LOOK_IDMAP_MAX_BYTES);
  if (!idmap) errors.push({ path: 'idmap', code: tooLong(body.idmap, LOOK_IDMAP_MAX_BYTES) ? 'TOO_LARGE' : 'TYPE' });
  const quadsIn = body.quads;
  const quads: Record<string, Quad> = {};
  if (typeof quadsIn !== 'object' || quadsIn === null || Array.isArray(quadsIn)) errors.push({ path: 'quads', code: 'TYPE' });
  else {
    const areaIds = new Set(spec.areas.map((a) => a.id));
    for (const [id, q] of Object.entries(quadsIn as Record<string, unknown>)) {
      if (!areaIds.has(id)) errors.push({ path: `quads.${id.slice(0, 64)}`, code: 'UNKNOWN_REF' });
      else if (!isQuad(q)) errors.push({ path: `quads.${id}`, code: 'TYPE' });
      else quads[id] = q;
    }
    for (const id of areaIds) if (!(id in quads) && !errors.some((e) => e.path === `quads.${id}`)) errors.push({ path: `quads.${id}`, code: 'REQUIRED' });
  }
  const camera = body.camera;
  if (!Array.isArray(camera) || camera.length !== 16 || !camera.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    errors.push({ path: 'camera', code: 'TYPE' });
  }
  if (errors.length) throw blueprintInvalid(errors);

  const digest = await meshHash(poster!);
  const key = `merchants/${ctx.store.user_id}/public/bp/${draft.id}-look-${digest.slice(0, 12)}.${ext}`;
  await putMediaObjectIfAbsent(
    env,
    { key, visibility: 'public', domain: 'merchants', mime: sniffed!.mime, bytes: poster!.byteLength, ownerId: ctx.store.user_id, entityId: product.id, width: dims!.width, height: dims!.height },
    poster!,
    { httpMetadata: { contentType: sniffed!.mime, cacheControl: 'public, max-age=31536000, immutable' } }
  );
  const card: LookCard = {
    poster_key: key,
    w: dims!.width,
    h: dims!.height,
    idmap: String(body.idmap),
    quads,
    camera: camera as number[],
    basis: await lookBasis(spec, analysisOf(draft).hash ?? draft.mesh_hash),
  };
  const before = lookOf(draft);
  const ts = nowIso();
  const audit = await auditStatements(db, input.actorId, 'blueprint.look_saved', product.id, { store: ctx.store.id, rev: draft.rev });
  await updateDraft(db, draft, { look: canonicalJson(card), updated_at: ts }, audit.statements);
  if (before?.poster_key && before.poster_key !== key) await forgetIfUnreferenced(db, env, 'public', before.poster_key, 'look');
  return { ...draft, look: canonicalJson(card), updated_at: ts };
}

// ---------------------------------------------------------------- publish

/** What a revision still lacks before it can go live (photo-only: nothing about a mesh or a look). */
export async function readiness(row: BlueprintRow, spec: BlueprintSpec | null): Promise<string[]> {
  if (!spec) return ['spec'];
  if (isPhotoOnly(spec)) return [];
  const missing: string[] = [];
  if (row.mesh_state !== 'ready' || !row.draft_mesh_key) missing.push('mesh');
  const look = lookOf(row);
  if (!look) missing.push('look');
  else if (look.basis !== (await lookBasis(spec, analysisOf(row).hash ?? row.mesh_hash)) || spec.areas.some((a) => !look.quads[a.id])) missing.push('look');
  return missing;
}

/**
 * The cheapest the product can be personalised for: the engine's price of the
 * default configuration on each variant (in stock first), the least of them.
 * Null when nothing can be priced (a required part has no live price).
 */
export function fromIqd(
  spec: BlueprintSpec,
  product: Pick<BlueprintProduct, 'id' | 'price_iqd'>,
  rev: number,
  variants: BlueprintRefs['variants'],
  parts: readonly StorePart[]
): number | null {
  const pool = variants.length ? (variants.some((v) => v.in_stock) ? variants.filter((v) => v.in_stock) : variants) : [null];
  let best: number | null = null;
  for (const v of pool) {
    try {
      const config = defaultConfig(spec, v ? v.id : null, { p: product.id, rev });
      const unit = priceConfig(spec, config, priceContext(v ? v.price_iqd : Math.max(0, Math.trunc(Number(product.price_iqd) || 0)), parts)).unit_iqd;
      if (best === null || unit < best) best = unit;
    } catch {
      /* an unpriceable variant is not the cheapest */
    }
  }
  return best;
}

/**
 * POST …/blueprint/publish {rev} — the named draft (or a retired revision,
 * republished exactly as it was) goes live. Strict: the spec re-validated
 * against today's catalogue, parts and printers; readiness (a mesh and a
 * look card captured from it, unless photo-only) else BLUEPRINT_NOT_READY
 * {missing}. The public mesh is the draft minus its hidden parts; the flip is
 * one batch fenced on the revision's state and rev.
 */
export async function publish(
  db: D1Database,
  env: Env,
  input: { ctx: BuilderStore; product: BlueprintProduct; rev: number; cfg: CustomizationConfig; actorId: string }
): Promise<BlueprintRow> {
  const { ctx, product, cfg } = input;
  const revs = await loadRevisions(db, product.id, { rev: input.rev });
  const target = revs.all.find((r) => r.rev === input.rev);
  if (!target) throw notFound('Revision not found');
  if (target.state === 'live') return target;
  const spec = specOf(target);
  const missing = await readiness(target, spec);
  if (missing.length) throw blueprintNotReady(missing);
  const refs = await loadBlueprintRefs(db, product, partIdsIn(spec));
  // Re-validated against today's catalogue, parts and printers (a retired revision too).
  validateBlueprint(spec, refs, cfg, product, meshFactsOf(target));
  const photoOnly = isPhotoOnly(spec!);

  const ts = nowIso();
  const from = fromIqd(spec!, product, target.rev, refs.variants, refs.parts);
  let set: Record<string, unknown> = { state: 'live', published_at: ts, updated_at: ts, from_iqd: from };
  if (target.state === 'draft') {
    set = { ...set, family: spec!.family, tags: canonicalJson(spec!.tags) };
    if (photoOnly) set.mesh_state = 'photo';
    else {
      const stored = await getMediaObject(env, 'private', target.draft_mesh_key!);
      if (!stored) throw blueprintNotReady(['mesh']);
      const full = await gunzipBytes(new Uint8Array(await stored.arrayBuffer()));
      const pub = withoutParts(full, hiddenParts(spec!, partsOf(target).length || (readLvr1(full)?.ranges.length ?? 1)));
      const lvr = readLvr1(pub);
      if (!lvr || lvr.triangles === 0) throw blueprintNotReady(['mesh']);
      const hash = await meshHash(pub);
      const gz = await gzipBytes(pub);
      const key = publicMeshKey(ctx.store.user_id, target.id, target.rev, hash);
      await putMediaObjectIfAbsent(
        env,
        { key, visibility: 'public', domain: 'merchants', mime: MESH_CONTENT_TYPE, bytes: gz.byteLength, ownerId: ctx.store.user_id, entityId: product.id },
        gz,
        { httpMetadata: { contentType: MESH_CONTENT_TYPE, cacheControl: 'public, max-age=31536000, immutable' } }
      );
      set = { ...set, mesh_key: key, mesh_hash: hash, mesh_bytes: gz.byteLength, triangles: lvr.triangles };
    }
  }
  const names = Object.keys(set);
  const n = names.length;
  const audit = await auditStatements(db, input.actorId, 'blueprint.published', product.id, { store: ctx.store.id, rev: target.rev, from_iqd: from });
  const results = await guarded(
    db.batch([
      // The old live revision retires only if THIS one is still what was validated:
      // the same state and rev, untouched since it was read (updated_at, spec).
      db
        .prepare(
          `UPDATE product_blueprints SET state = 'retired', retired_at = ?1, updated_at = ?1
            WHERE product_id = ?2 AND state = 'live' AND id <> ?3
              AND EXISTS (SELECT 1 FROM product_blueprints t
                           WHERE t.id = ?3 AND t.state = ?4 AND t.rev = ?5 AND t.updated_at = ?6 AND t.spec = ?7)`
        )
        .bind(ts, product.id, target.id, target.state, target.rev, target.updated_at, target.spec),
      db
        .prepare(
          `UPDATE product_blueprints SET ${names.map((k, i) => `${k} = ?${i + 1}`).join(', ')}
            WHERE id = ?${n + 1} AND state = ?${n + 2} AND rev = ?${n + 3} AND updated_at = ?${n + 4} AND spec = ?${n + 5}`
        )
        .bind(...names.map((k) => set[k]), target.id, target.state, target.rev, target.updated_at, target.spec),
      // A flip that did not land aborts the whole batch — refs and audit row included.
      fenceStatement(db, target.id, 'live', ts),
      ...partRefStatements(db, product.id, target.rev, spec),
      ...audit.statements,
    ])
  );
  if (!results[1]?.meta?.changes) throw blueprintLocked({ reason: 'changed' });
  return { ...target, ...(set as Partial<BlueprintRow>), state: 'live' };
}

/** POST …/blueprint/pause — the live revision retires; the product is no longer personalised (true when one was live). */
export async function pause(db: D1Database, input: { ctx: BuilderStore; product: BlueprintProduct; actorId: string }): Promise<boolean> {
  const ts = nowIso();
  const res = await guarded(
    db
      .prepare(`UPDATE product_blueprints SET state = 'retired', retired_at = ?1, updated_at = ?1 WHERE product_id = ?2 AND state = 'live'`)
      .bind(ts, input.product.id)
      .run()
  );
  const paused = !!res?.meta?.changes;
  // Audited only when a revision actually retired (a second press is a no-op).
  if (paused) {
    const audit = await auditStatements(db, input.actorId, 'blueprint.paused', input.product.id, { store: input.ctx.store.id });
    await db.batch(audit.statements).catch((e) => console.error('audit write failed', 'blueprint.paused', e));
  }
  return paused;
}

// ------------------------------------------------------------------ purge

/** The guest answers a blueprint write changes: its public read and the product's page. */
export function blueprintPaths(store: { slug: string }, product: { id: string; slug: string }): string[] {
  return [`/api/personalize/blueprints/${product.id}`, `/api/storefront/${store.slug}/products/${product.slug}`];
}

/**
 * After a publish or a pause: the public blueprint read and the product page,
 * on the request's host, the store's own host and the apex (per colo; the
 * rest age out within the read's 60 s s-maxage — P13). `?rev=` entries are
 * revisions, which never change.
 */
export async function afterBlueprintWrite(c: Context<AppContext>, store: { slug: string; id: string }, product: { id: string; slug: string }): Promise<void> {
  const root = rootDomainFrom(c.env);
  const origins = new Set<string>([originOf(c)]);
  const own = storeUrl(store.slug, root, store.id);
  if (/^https?:\/\//.test(own)) origins.add(new URL(own).origin);
  if (root) origins.add(`https://${root}`);
  const paths = blueprintPaths(store, product);
  await Promise.all([...origins].map((o) => purgeAnonymousCache(o, paths)));
}

// -------------------------------------------------------------- duplicate

export interface DuplicateIdMap {
  groups: Record<string, string>;
  values: Record<string, string>;
  media: Record<string, string>;
}

/** The old → new ids of a product copy, by position (groups and their values) and by key (pictures). */
export function duplicateIdMap(
  src: { option_groups: Array<{ id: string; values: Array<{ id: string }> }>; media: Array<{ id: string; key: string }> },
  dst: { option_groups: Array<{ id: string; values: Array<{ id: string }> }>; media: Array<{ id: string; key: string }> }
): DuplicateIdMap {
  const map: DuplicateIdMap = { groups: {}, values: {}, media: {} };
  src.option_groups.forEach((g, i) => {
    const n = dst.option_groups[i];
    if (!n) return;
    map.groups[g.id] = n.id;
    g.values.forEach((v, j) => {
      if (n.values[j]) map.values[v.id] = n.values[j].id;
    });
  });
  for (const m of src.media) {
    const n = dst.media.find((x) => x.key === m.key);
    if (n) map.media[m.id] = n.id;
  }
  return map;
}

/** A spec with its option group/value and picture ids moved through `map` (an id the map lacks is kept — the next save names it). */
export function remapSpecIds(spec: BlueprintSpec, map: DuplicateIdMap): BlueprintSpec {
  const g = (id: string) => map.groups[id] ?? id;
  const v = (id: string) => map.values[id] ?? id;
  const m = (id: string) => map.media[id] ?? id;
  const axis = <T>(a: { group: string; values: Record<string, T> } | undefined) =>
    a ? { group: g(a.group), values: Object.fromEntries(Object.entries(a.values).map(([id, x]) => [v(id), x])) } : undefined;
  const axes: BlueprintSpec['axes'] = {};
  if (spec.axes.size) axes.size = axis(spec.axes.size);
  if (spec.axes.look) axes.look = axis(spec.axes.look);
  if (spec.axes.tier) axes.tier = axis(spec.axes.tier);
  return {
    ...spec,
    axes,
    photos: spec.photos.map((p) => ({ ...p, media_id: m(p.media_id), ...(p.value_id !== undefined ? { value_id: v(p.value_id) } : {}) })),
    areas: spec.areas.map((a) => (a.photo_frame ? { ...a, photo_frame: { ...a.photo_frame, media_id: m(a.photo_frame.media_id) } } : a)),
    rules: spec.rules.map((r) => ({
      ...r,
      if: 'value' in r.if ? { value: v(r.if.value) } : r.if,
      then: 'size_at_least' in r.then ? { size_at_least: v(r.then.size_at_least) } : r.then,
    })),
    prep_days_add: {
      ...spec.prep_days_add,
      ...(spec.prep_days_add.size ? { size: Object.fromEntries(Object.entries(spec.prep_days_add.size).map(([id, d]) => [v(id), d])) } : {}),
    },
  };
}

/**
 * THE COPY'S BLUEPRINT (POST /api/merchant/products/:id/duplicate): a new
 * DRAFT (rev 1) on the copy, carrying the source's live revision (else its
 * newest) with the copy's own option and picture ids — the mesh, the look and
 * the sources referenced by key, never uploaded again. Counts against
 * `max_blueprints_per_store` (no copy of the blueprint over it).
 */
export async function duplicateBlueprint(
  db: D1Database,
  input: { fromProductId: string; to: BlueprintProduct; map: DuplicateIdMap; cfg: Pick<CustomizationConfig, 'max_blueprints_per_store'> }
): Promise<{ copied: boolean; reason?: 'none' | 'limit' }> {
  const revs = await loadRevisions(db, input.fromProductId);
  const src = revs.live ?? revs.latest;
  if (!src) return { copied: false, reason: 'none' };
  const used = await db
    .prepare('SELECT COUNT(DISTINCT product_id) AS n FROM product_blueprints WHERE store_id = ?1')
    .bind(input.to.store_id)
    .first<{ n: number }>();
  if (Number(used?.n ?? 0) >= input.cfg.max_blueprints_per_store) return { copied: false, reason: 'limit' };
  const spec = specOf(src);
  const moved = spec ? remapSpecIds(spec, input.map) : null;
  const cols = moved ? specColumns(moved) : { spec: src.spec, private_json: src.private_json };
  const keys = photoKeysOf(src);
  const photoKeys = Object.fromEntries(Object.entries(keys).map(([id, key]) => [input.map.media[id] ?? id, key]));
  const a = analysisOf(src);
  const ts = nowIso();
  const id = newId('bp');
  await guarded(
    db.batch([
      db
        .prepare(
          `INSERT INTO product_blueprints (id, product_id, store_id, merchant_id, rev, state, spec, private_json, source_keys, parts, analysis,
                                           mesh_state, draft_mesh_key, mesh_hash, mesh_bytes, triangles, look, photo_keys, family, tags,
                                           created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, 1, 'draft', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?19)`
        )
        .bind(
          id, input.to.id, input.to.store_id, input.to.merchant_id, cols.spec, cols.private_json, src.source_keys, src.parts, src.analysis,
          src.mesh_state === 'pending' ? 'none' : src.mesh_state, src.draft_mesh_key,
          src.state === 'draft' ? src.mesh_hash : a.hash ?? null,
          src.state === 'draft' ? src.mesh_bytes : a.bytes ?? null,
          src.state === 'draft' ? src.triangles : a.triangles ?? null,
          src.look, canonicalJson(photoKeys), src.family, src.tags, ts
        ),
      ...partRefStatements(db, input.to.id, 1, moved),
    ])
  );
  return { copied: true };
}

// ------------------------------------------------------ the merchant's view

/** Region roles guessed from the file's part names (en/ar/ckb words); the biggest unnamed piece is the body. */
const ROLE_WORDS: Array<[RegExp, string]> = [
  [/\b(base|stand|foot|plinth)\b|قاعدة|بنکە|بنچینە/i, 'base'],
  [/\b(name|letters?|text|word)\b|اسم|نص|ناو|دەق/i, 'name'],
  [/\b(border|frame|rim|edge|outline)\b|إطار|حافة|چوارچێوە/i, 'border'],
  [/\blogo\b|شعار|لۆگۆ/i, 'logo'],
  [/\b(icon|symbol|emblem)\b|أيقونة|رمز|هێما/i, 'icon'],
  [/\b(insert|nut|thread)\b|حشوة|ئینسێرت/i, 'insert'],
  [/\b(led|light|lamp|motor|ring|chain|hook|magnet)\b|ضوء|محرك|حلقة|مغناطيس|گڵۆپ|مۆتۆڕ/i, 'accessory'],
  [/\b(accent|detail|trim|stripe)\b|زخرفة|تفصيل/i, 'accent'],
];

export interface BuilderSuggestions {
  roles: Array<{ n: number; role: string }>;
  /** Grams of plastic per size value (volume × scale³ × the look's density), or at scale 1 as `'1'`. */
  grams: Record<string, number>;
}

export function suggestionsFor(parts: readonly CompiledPart[], spec: BlueprintSpec | null, materials: Map<string, number>): BuilderSuggestions {
  const biggest = parts.reduce<CompiledPart | null>((best, p) => (!best || p.share > best.share ? p : best), null);
  const roles = parts.map((p) => {
    const hit = ROLE_WORDS.find(([re]) => re.test(p.name));
    return { n: p.n, role: hit ? hit[1] : p === biggest ? 'body' : 'accent' };
  });
  const hidden = spec ? new Set(hiddenParts(spec, parts.length)) : new Set<number>();
  const volume = parts.filter((p) => !hidden.has(p.n)).reduce((s, p) => s + Math.max(0, p.volume_mm3 || 0), 0);
  const firstLook = spec?.axes.look ? Object.values(spec.axes.look.values)[0] : undefined;
  const density = (firstLook && materials.get(firstLook.material_id)) || materials.get('pla') || 1.24;
  const grams: Record<string, number> = {};
  const size = spec?.axes.size;
  if (size) for (const [id, v] of Object.entries(size.values)) grams[id] = Math.round(((volume * v.scale ** 3) / 1000) * density);
  else if (volume > 0) grams['1'] = Math.round((volume / 1000) * density);
  return { roles, grams };
}

/**
 * THE BUILDER SEES TODAY'S PICTURE IDS. 0126 re-mints a product's media rows
 * on every gallery save, so a spec saved yesterday may name ids that are gone;
 * `photo_keys` remembers which picture each one was, and the builder gets the
 * spec back with the ids of today's rows holding the same pictures.
 */
export function withCurrentMediaIds(spec: BlueprintSpec, photoKeys: Record<string, string>, media: ReadonlyArray<{ id: string; key: string }>): BlueprintSpec {
  const map: Record<string, string> = {};
  for (const [id, key] of Object.entries(photoKeys)) {
    if (media.some((m) => m.id === id)) continue;
    const now = media.find((m) => m.key === key);
    if (now) map[id] = now.id;
  }
  return Object.keys(map).length ? remapSpecIds(spec, { groups: {}, values: {}, media: map }) : spec;
}

/** The merchant's own mesh door for a revision (the full draft mesh, hidden parts included). */
export const draftMeshUrl = (productId: string, rev: number): string => `/api/merchant/products/${productId}/blueprint/mesh?rev=${rev}`;

/** One revision as the builder reads it — the merchant's own facts (part names, private notes) included. */
export function revisionOut(row: BlueprintRow, media: ReadonlyArray<{ id: string; key: string }>) {
  const spec = specOf(row);
  const look = lookOf(row);
  const a = analysisOf(row);
  return {
    id: row.id,
    rev: row.rev,
    state: row.state,
    spec: spec ? withCurrentMediaIds(spec, photoKeysOf(row), media) : null,
    mesh_state: row.mesh_state,
    mesh:
      row.mesh_state === 'ready' && row.draft_mesh_key
        ? { url: draftMeshUrl(row.product_id, row.rev), public_url: row.mesh_key ? `/files/${row.mesh_key}` : null, hash: a.hash ?? row.mesh_hash, bytes: a.bytes ?? row.mesh_bytes, triangles: a.triangles ?? row.triangles, dims_mm: a.dims_mm ?? null }
        : null,
    look: look ? { poster_url: `/files/${look.poster_key}`, w: look.w, h: look.h, idmap: look.idmap, quads: look.quads, camera: look.camera } : null,
    analysis: a,
    source_keys: safeParse<string[]>(row.source_keys, []),
    parts: partsOf(row),
    family: row.family,
    tags: safeParse<string[]>(row.tags, []),
    from_iqd: row.from_iqd,
    created_at: row.created_at,
    updated_at: row.updated_at,
    published_at: row.published_at,
    retired_at: row.retired_at,
  };
}

// ------------------------------------------------- the catalogue's gates

/** 409 PART_IN_USE {products} — a part a LIVE revision builds in is not deleted (archive it, or publish without it). */
export const partInUse = (products: readonly string[]): HttpError =>
  new HttpError(409, 'This part is used inside a customizable product — pause that product or publish it without this part first.', 'PART_IN_USE', {
    products: [...products],
  });

/** 409 BLUEPRINT_AXIS_IN_USE {group, value?} — an option group or value the live revision annotates stays until it is paused or republished without it. */
export const axisInUse = (group: string, value?: string): HttpError =>
  new HttpError(409, 'This option is part of your published customization — pause it or publish a version without this option first.', 'BLUEPRINT_AXIS_IN_USE', {
    group,
    ...(value ? { value } : {}),
  });

/**
 * SQL fence, over a product row aliased `alias`: a LIVE revision of some
 * product builds it in. A delete statement adds `AND NOT <this>` so a publish
 * that lands between the route's check and its write still wins.
 */
export const LIVE_PART_USE_SQL = (alias: string): string =>
  `EXISTS (SELECT 1 FROM blueprint_part_refs r
             JOIN product_blueprints b ON b.product_id = r.product_id AND b.rev = r.rev AND b.state = 'live'
            WHERE r.part_product_id = ${alias}.id)`;

/** Part product id → the products whose LIVE revision builds it in. */
export async function liveUsesOf(db: D1Database, partIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!partIds.length) return out;
  const { results } = await db
    .prepare(
      `SELECT DISTINCT r.part_product_id AS part, r.product_id AS product
         FROM blueprint_part_refs r
         JOIN product_blueprints b ON b.product_id = r.product_id AND b.rev = r.rev AND b.state = 'live'
        WHERE r.part_product_id IN (SELECT value FROM json_each(?1))
        ORDER BY r.product_id`
    )
    .bind(JSON.stringify([...new Set(partIds)]))
    .all<{ part: string; product: string }>();
  for (const r of results ?? []) out.set(r.part, [...(out.get(r.part) ?? []), r.product]);
  return out;
}

/** DELETE /api/merchant/products/:id — refused while a live revision uses the product as a part. */
export async function assertPartNotInUse(db: D1Database, productId: string): Promise<void> {
  const uses = (await liveUsesOf(db, [productId])).get(productId);
  if (uses?.length) throw partInUse(uses);
}

/**
 * PATCH /api/merchant/products/:id with a `variant_model` — every group and
 * value the LIVE revision's axes annotate must survive the write: 0126 keeps
 * an id only where the model names it by that id (`variantModelStatements`).
 * New groups and values are welcome (the builder asks for their annotation
 * before the next publish; until then the studio does not offer them).
 */
export async function assertBlueprintAxesKept(db: D1Database, productId: string, model: { groups: Array<{ ref: string; values: Array<{ ref: string }> }> } | undefined): Promise<void> {
  if (!model) return;
  const live = await db
    .prepare(`SELECT spec, private_json FROM product_blueprints WHERE product_id = ?1 AND state = 'live'`)
    .bind(productId)
    .first<{ spec: string; private_json: string }>();
  const spec = live ? specOf(live) : null;
  if (!spec) return;
  const groups = new Set(model.groups.map((g) => g.ref));
  const values = new Set(model.groups.flatMap((g) => g.values.map((v) => v.ref)));
  for (const axis of [spec.axes.size, spec.axes.look, spec.axes.tier]) {
    if (!axis) continue;
    if (!groups.has(axis.group)) throw axisInUse(axis.group);
    for (const id of Object.keys(axis.values)) if (!values.has(id)) throw axisInUse(axis.group, id);
  }
}

// ------------------------------------------------- the copy of a product

/** The part facts of a copy: the source's, minus the server-owned `source`, each option line moved to the copy's value id. */
export function copiedPartSpec(
  partSpec: Record<string, string> | null | undefined,
  oldValueIds: readonly string[],
  values: Record<string, string>
): string | null {
  if (!partSpec) return null;
  const read = readPartSpec(partSpec, oldValueIds);
  if (!read) return null;
  const { source: _source, variants, ...rest } = read;
  const moved: PartSpec = { ...rest };
  const lines = Object.entries(variants ?? {}).flatMap(([id, d]) => (values[id] ? [[values[id], d] as const] : []));
  if (lines.length) moved.variants = Object.fromEntries(lines);
  return JSON.stringify(partSpecToMap(moved));
}

/** The facts of a product detail (worker/lib/catalog/product.ts `readProductDetail`) a copy needs. */
export interface CopySide {
  /** The product id (readProductDetail types it loosely). */
  id: unknown;
  store_id?: string;
  part_spec?: Record<string, string> | null;
  option_groups: Array<{ id: string; values: Array<{ id: string }> }>;
  media: Array<{ id: string; key: string }>;
}

/**
 * THE DUPLICATE ROUTE'S SECOND STEP (POST /api/merchant/products/:id/duplicate,
 * after the copy's own batch): the part facts (L6's `part_spec`, minus
 * `source`, its option lines remapped) and the blueprint as a DRAFT with the
 * copy's own ids (`duplicateBlueprint`). Answers what it copied.
 */
export async function duplicateCustomization(
  db: D1Database,
  input: { src: CopySide; dst: CopySide; merchantId: string; cfg: Pick<CustomizationConfig, 'max_blueprints_per_store'> }
): Promise<{ part_spec: Record<string, string> | null; blueprint: { copied: boolean; reason?: 'none' | 'limit' } }> {
  const map = duplicateIdMap(input.src, input.dst);
  const spec = copiedPartSpec(input.src.part_spec, input.src.option_groups.flatMap((g) => g.values.map((v) => v.id)), map.values);
  if (spec) {
    await db.prepare('UPDATE community_products SET part_spec = ?1 WHERE id = ?2 AND merchant_id = ?3').bind(spec, String(input.dst.id), input.merchantId).run();
  }
  const to = await db
    .prepare(
      `SELECT id, slug, name, merchant_id, store_id, price_iqd, prep_days, publish_state, variant_mode, track_stock, stock
         FROM community_products WHERE id = ?1 AND merchant_id = ?2`
    )
    .bind(String(input.dst.id), input.merchantId)
    .first<BlueprintProduct>();
  const blueprint = to ? await duplicateBlueprint(db, { fromProductId: String(input.src.id), to, map, cfg: input.cfg }) : { copied: false as const, reason: 'none' as const };
  return { part_spec: spec ? (JSON.parse(spec) as Record<string, string>) : null, blueprint };
}
