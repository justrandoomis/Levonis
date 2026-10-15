/**
 * Admin product/taxonomy API v2 — mounted at /api/admin/products-v2.
 *
 * Works exclusively on the canonical ProductDoc (worker/lib/productModel.ts):
 *  - GET  /            bounded LISTING projection (never an edit payload)
 *  - GET  /:id         FULL document (projectAdmin) + catalog_ids — the edit payload
 *  - POST /            create/update with slug stability, stale-edit protection
 *                      and translation staleness tracking
 *  - DELETE /:id       archive policy (hide when referenced by orders, else delete)
 *  - POST /:id/quote   admin price preview via the central resolver (costs included)
 *  - /brands, /catalogs taxonomy CRUD (deactivate, never delete)
 *  - PUT  /:id/catalogs, POST /catalogs/:catalogId/reorder catalog placement
 *
 * All routes require an admin session (server-side role check). Sensitive
 * mutations are written to the audit log.
 */

import { likePattern, sqlLikeClause } from '../lib/sqlLike';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import {
  requireAdmin,
  badRequest,
  notFound,
  int,
  str,
  pickFrom,
  HttpError,
} from '../lib/http';
import { audit } from '../lib/audit';
import { purgeCatalogueAfterWrite } from '../lib/edgePolicy';
import { completenessAfterWrite } from '../lib/completenessHooks';
import { registerCompletenessRoutes } from './adminCompleteness';
import { completenessInstalled } from '../lib/listing';
import { priceRequestsInstalled } from '../lib/priceRequests';
import { parseMissing, projectItems } from '../lib/productCompleteness';
import { newId } from '../lib/crypto';
import { DIMENSION_FIELDS, parseProductRow, validateProductDoc, projectAdmin } from '../lib/productModel';
import type { ProductDoc, TranslationMeta } from '../lib/productModel';
import { resolveUnitPrice, proPolicyFrom } from '../lib/pricing';
import { applyRelations, loadRelationsView } from '../lib/productOverlay';
import { optionValueIdsInRelationOrder } from '../lib/cartSelectionIdentity';
import { pinnedRows, type PinnedPriceRow } from '../lib/pinnedPrices';
import type { Tier } from '../lib/pricing';
import { getSettings } from '../lib/settings';
import { getAppliedUsdRate, getDisplayUsdRate, iqdToUsdCentsAtRate } from '../lib/fx/displayRate';
import { transportDefaultsFrom } from './products';
import {
  attemptedFinancialWrites,
  canMoveMoney,
  canViewCost,
  canWriteCost,
  carryStoredCostForward,
  isOwner,
  projectForAdmin,
} from '../lib/adminScope';
import { costRefusal } from '../lib/costAccess';
import {
  pricingV2Installed,
  productEngineDirectOnly,
  productEngineManaged,
  productEngineV2,
  productV2Flag,
  v2Managed,
} from '../lib/engineInstalled';
import { serverMessage } from '../../packages/contracts/src/costRefusals';
import { engineDbRefusal } from '../lib/pricingDbRefusals';
import { limitRoute } from '../lib/ratelimit';
import { SESSION_CACHE_CONTROL } from '../lib/edgePolicy';
import { jsonObject } from '../lib/http';
import { pinV2PriceFields, previewDraft } from '../lib/pricingEngine/v2/draft';
import { holdLegacyDocMoney, holdLegacyRelationMoney, nullLegacyPricesDeep } from '../lib/pricingEngine/v2/legacyMoney';
import { planV2ProductSave, type V2SaveOutcome } from '../lib/pricingEngine/v2/productSave';
import {
  desiredFor,
  evaluateDesired,
  gateV2,
  defaultMethodOf,
  loadV2Read,
  parseV2Wire,
  storedMethodOf,
  v2Answer,
  v2BatchOutcome,
  v2Body,
  v2PriceKey,
  v2ViewerOf,
  uninstalledAnswer,
  type V2Read,
} from '../lib/pricingEngine/v2/api';
import { firstWriteStatements, foldedReviewOf } from '../lib/pricingEngine/v2/firstWrite';
import { V2_PRICING_STATEMENT_CAP, v2DataStatements, v2StructureStatements, v2WriteStatements } from '../lib/pricingEngine/v2/write';
import { needsPricingAnswer, QUEUE_FILTERS, type QueueFilter } from '../lib/pricingEngine/v2/queue';
import { applyPurchaseReview, dismissPurchaseReview, loadPurchaseReview, previewPurchaseReview, reviewView } from '../lib/pricingEngine/v2/purchaseReview';
import { belowMinProfitBell, productNameOf } from '../lib/pricingEngine/v2/bell';
import { inputInvalid } from '../lib/pricingEngine/whatIf';
import { applyPrinterWarrantyRules, mergeOpsPolicy, readOpsWarranty } from '../lib/warrantyPlans';
import {
  catalogEditRefusal,
  catalogEditScope,
  catalogEditSerialFlips,
  isCatalogEdit,
  serialAnswerFence,
  serializedWriteVerdict,
  type CatalogEdit,
  type SerialAnswerFence,
} from '../lib/serialPolicy';
import { isLostRace } from '../lib/gifts/fence';
import { refuse as serialRefuse } from '../lib/serialAssignments';
import { bundlesUsing, compositionConflict } from '../lib/bundleComposition';
import { deleteProductPermanently, invalidateMediaCache, scanProductOrphans } from '../lib/productDeletion';
/**
 * The full map of where an R2 key can live, and the gate that refuses the
 * destructive sweep until that map is provably complete for the live schema.
 * `productDeletion`'s reference set answers a narrower question — what one
 * PRODUCT points at — and using it to decide what the BUCKET may lose is the
 * defect this import exists to correct.
 */
import {
  deleteSweptObjects,
  markObjectsDeleted,
  partitionSweepCandidates,
  runGuardedMediaCleanup,
  runGuardedMediaCleanupJobs,
  verifyMediaCoverage,
} from '../lib/mediaRefs';
import {
  localizeRespectingAuthored,
  preflightProductSave,
  readTranslationOverrides,
  planProductSave,
  priceHistoryDeltas as sharedPriceHistoryDeltas,
  reloadForVerification,
  saveProductAtomic,
  type ProductWriteIntent,
} from '../lib/productPersistence';
import { ProductMediaIngestError, verifyStoredProductMedia, type ProductMediaReference } from '../lib/productMediaIngest';
import { loadAuthoritativeProductImages } from '../lib/productSelectionImage';
import { loadPrinterFitIds, printerOptions } from '../lib/printerFits';

/** Kept under its old name: the diff is now the contract's (productPersistence). */
export const priceHistoryDeltas = sharedPriceHistoryDeltas;

export const adminProductsRoutes = new Hono<AppContext>();

adminProductsRoutes.use('*', requireAdmin);
// P2 review: a product saved, hidden, repriced or deleted drops the guests'
// listing, home shelves and (when the slug is known) the product page from
// this colo's cache (worker/lib/edgePolicy.ts) instead of ageing out.
adminProductsRoutes.use('*', purgeCatalogueAfterWrite);
// Owner brief 2026-10-10: after the purge middleware so it runs FIRST on the way
// out — the product is re-evaluated against the required-field list (and a
// product whose customer visibility flipped is purged) before the listing goes.
adminProductsRoutes.use('*', completenessAfterWrite);

// Pricing a selection from its purchase writes a price derived from cost: the owner's (decision 2).
// «تحديث سعر هذا الخيار في المتجر» — retired by the clean start (addendum A.6): a selection's price is
// its V2 write's. The cost gate still answers first (a non-owner learns nothing more than before).
adminProductsRoutes.post('/:id/selection-price', async (c) => {
  const user = c.get('user')!;
  if (!canWriteCost(c.env, user)) throw costRefusal(c.env, user);
  throw v2Managed(5);
});

// ---------------------------------------------------------------- helpers

/**
 * R2 is authoritative for product-media metadata. The verifier returns those
 * facts, rather than blessing the values a caller supplied, so copy them onto
 * the request objects BEFORE `planProductSave` binds its D1 statements.
 *
 * Relation rows persist all five facts. ProductDoc media has no byte/MIME
 * fields, so its canonical key and decoded dimensions are the applicable
 * subset. The caller has already supplied JSON objects, hence mutating these
 * request-local records cannot affect shared state.
 */
async function normalizeVerifiedProductMedia(
  env: AppContext['Bindings'],
  rows: Array<Record<string, unknown>>,
  keyField: 'key' | 'r2_key'
): Promise<void> {
  if (rows.length === 0) return;
  const verified = await verifyStoredProductMedia(env, rows as ProductMediaReference[]);
  const byUrl = new Map(verified.map((media) => [media.url, media]));
  for (const row of rows) {
    const media = byUrl.get(typeof row.url === 'string' ? row.url : '');
    if (!media) {
      throw new ProductMediaIngestError(
        'IMAGE_REFERENCE_INVALID',
        'Product media verification did not return every requested reference'
      );
    }
    row.url = media.url;
    row[keyField] = media.key;
    row.width = media.width;
    row.height = media.height;
    if (keyField === 'r2_key') {
      row.bytes = media.bytes;
      row.content_type = media.content_type;
    }
  }
}

function throwProductMediaVerificationError(error: unknown): never {
  if (error instanceof ProductMediaIngestError) {
    const unavailable = error.code === 'IMAGE_STORAGE_FAILED' || error.code === 'IMAGE_CONVERT_UNAVAILABLE';
    throw new HttpError(unavailable ? 503 : 400, error.message, error.code);
  }
  throw error;
}

/** Same charset the v1 admin used: latin + digits + Arabic block, dash-joined.
 *  Exported so the bundles panel derives a slug through the SAME rule rather
 *  than a second one that would drift. */
export function slugToken(input: unknown): string {
  return String(input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

type SluggedTable = 'products' | 'brands' | 'catalogs';

export async function uniqueSlugIn(
  db: D1Database,
  table: SluggedTable,
  base: string,
  excludeId: string | null
): Promise<string> {
  const taken = async (s: string): Promise<boolean> => {
    const stmt = excludeId
      ? db.prepare(`SELECT id FROM ${table} WHERE slug = ? AND id <> ?`).bind(s, excludeId)
      : db.prepare(`SELECT id FROM ${table} WHERE slug = ?`).bind(s);
    return !!(await stmt.first());
  };
  if (!(await taken(base))) return base;
  for (let i = 2; i <= 30; i++) {
    const cand = `${base}-${i}`;
    if (!(await taken(cand))) return cand;
  }
  return `${base}-${newId().slice(0, 6)}`;
}

/**
 * §29 (serial scan, 0178; critique-1 #23): refuses, for anyone but the owner,
 * a new placement that would flip whether a product with no `serialized`
 * word of its own needs a serial at preparation (a printer catalog, or a
 * section whose serial policy is 'required'). A product with its own word
 * keeps it wherever it is filed, so nothing is asked of it. The one rule is
 * `serializedWriteVerdict` (worker/lib/serialPolicy.ts), with the stored word
 * as the request: the placement route changes the filing and nothing else.
 */
async function refuseSerializedDrift(
  db: D1Database,
  prev: { id: string; ops_policy: unknown },
  catalogIds: string[],
  categoryIds: Array<string | null | undefined>
): Promise<SerialAnswerFence> {
  const verdict = await serializedWriteVerdict(db, {
    prev,
    requested: readOpsWarranty(prev.ops_policy).serialized,
    placement: { catalogIds, categoryIds },
  });
  if (verdict.refuse) throw serialRefuse(403, 'OWNER_ONLY', { field: 'serialized', via: 'placement' });
  // The verdict read the flags and policies of the old and new shelves; the
  // write re-checks the product's answer inside its batch (round 4 R2).
  return serialAnswerFence(db, { productId: prev.id });
}

async function catalogIdsFor(db: D1Database, productId: string): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT catalog_id FROM product_catalogs WHERE product_id = ? ORDER BY catalog_id')
    .bind(productId)
    .all<{ catalog_id: string }>();
  return results.map((r) => r.catalog_id);
}

/** Fields whose per-language state is tracked. English is the SOURCE. */
const TRACKED_FIELDS = [
  { key: 'name', en: 'name_en', ar: 'name_ar', ckb: 'name_ckb' },
  { key: 'description', en: 'description_en', ar: 'description_ar', ckb: 'description_ckb' },
] as const;

/**
 * Translation bookkeeping, ENGLISH-SOURCED (product-form mandate §3, which
 * replaces the earlier Arabic-sourced scheme).
 *
 *  - The admin types English only. `localizeProductDoc` fills every ar/ckb slot
 *    from the local deterministic engine — no network, no AI — and reports the
 *    fields it could not cover.
 *  - The product NAME is copied, never translated, so it reads identically in
 *    all three languages (§3, §12).
 *  - `translation_meta` records, per field and language, whether the stored
 *    text came out of the engine ('machine'), still needs a human
 *    ('review_needed'), or was approved by one ('approved' — set only through
 *    the future review page, and preserved here as long as the English source
 *    is unchanged).
 *  - content_rev bumps once when any tracked ENGLISH source changed.
 */
function applyTranslationTracking(
  doc: ProductDoc,
  prev: ProductDoc | null,
  review: string[]
): void {
  // The localiser already seeded `doc.translation_meta` from the stored one
  // (and demoted the authored marks whose English source changed), so that is
  // the starting point; a caller that skipped it starts from the stored meta.
  const storedMeta: TranslationMeta = Object.keys(doc.translation_meta ?? {}).length
    ? doc.translation_meta
    : prev?.translation_meta ?? {};
  const meta: TranslationMeta = {};
  for (const key of Object.keys(storedMeta)) meta[key] = { ...storedMeta[key] };

  const text = (d: ProductDoc, field: string): string => (d as unknown as Record<string, string>)[field] ?? '';

  let contentRev = prev ? prev.content_rev : doc.content_rev || 1;
  const englishChanged = prev
    ? TRACKED_FIELDS.some((f) => text(doc, f.en) !== text(prev, f.en))
    : true;
  if (prev && englishChanged) contentRev += 1;

  const needsReview = new Set(review);
  for (const f of TRACKED_FIELDS) {
    const entry = meta[f.key] ?? {};
    const sourceChanged = !prev || text(doc, f.en) !== text(prev, f.en);
    entry.en = { status: text(doc, f.en).trim() ? 'imported' : 'missing', src_rev: contentRev };
    for (const lang of ['ar', 'ckb'] as const) {
      const cur = entry[lang];
      // A human approval survives while the English source is unchanged.
      if (!sourceChanged && cur && cur.status === 'approved') continue;
      if (!text(doc, f.en).trim()) {
        entry[lang] = { status: 'missing', src_rev: contentRev };
      } else if (needsReview.has(f.key)) {
        entry[lang] = { status: 'stale', src_rev: contentRev };
      } else {
        entry[lang] = { status: 'imported', src_rev: contentRev };
      }
    }
    meta[f.key] = entry;
  }

  doc.content_rev = contentRev;
  doc.translation_meta = meta;
}

function brandOut(r: Record<string, unknown>) {
  return {
    id: r.id,
    slug: r.slug,
    name_ar: r.name_ar,
    name_en: r.name_en,
    name_ckb: r.name_ckb,
    active: !!r.active,
    created_at: r.created_at,
  };
}

function catalogOut(r: Record<string, unknown>) {
  return {
    id: r.id,
    parent_id: (r.parent_id as string | null) ?? null,
    slug: r.slug,
    name_ar: r.name_ar,
    name_en: r.name_en,
    name_ckb: r.name_ckb,
    sort: r.sort,
    is_printer_catalog: !!r.is_printer_catalog,
    active: !!r.active,
    created_at: r.created_at,
  };
}

// NOTE: static routes (/brands, /catalogs) are registered BEFORE /:id so a
// brand/catalog request never resolves as a product id.

// ---------------------------------------------------------------- brands

adminProductsRoutes.get('/brands', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM brands ORDER BY name_ar, created_at').all<
    Record<string, unknown>
  >();
  return c.json({ success: true, brands: results.map(brandOut) });
});

adminProductsRoutes.post('/brands', async (c) => {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const nameAr = str(body.name_ar, 'name_ar', { min: 1, max: 200 });
  const nameEn = str(body.name_en, 'name_en', { max: 200, required: false });
  const nameCkb = str(body.name_ckb, 'name_ckb', { max: 200, required: false });
  const id = newId('brd');
  const base = slugToken(nameEn) || slugToken(nameAr) || `brand-${id.slice(-6)}`;
  const slug = await uniqueSlugIn(c.env.DB, 'brands', base, null);
  await c.env.DB.prepare('INSERT INTO brands (id, slug, name_ar, name_en, name_ckb, active) VALUES (?, ?, ?, ?, ?, 1)')
    .bind(id, slug, nameAr, nameEn, nameCkb)
    .run();
  await audit(c.env.DB, admin.id, 'brand.create', id, { slug, name_ar: nameAr });
  const row = await c.env.DB.prepare('SELECT * FROM brands WHERE id = ?').bind(id).first<Record<string, unknown>>();
  return c.json({ success: true, brand: brandOut(row!) });
});

adminProductsRoutes.patch('/brands/:id', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const sets: string[] = [];
  const params: unknown[] = [];
  if (body.name_ar !== undefined) {
    sets.push('name_ar = ?');
    params.push(str(body.name_ar, 'name_ar', { min: 1, max: 200 }));
  }
  if (body.name_en !== undefined) {
    sets.push('name_en = ?');
    params.push(str(body.name_en, 'name_en', { max: 200, required: false }));
  }
  if (body.name_ckb !== undefined) {
    sets.push('name_ckb = ?');
    params.push(str(body.name_ckb, 'name_ckb', { max: 200, required: false }));
  }
  if (body.active !== undefined) {
    sets.push('active = ?');
    params.push(body.active ? 1 : 0); // deactivate only — brands are never deleted
  }
  if (!sets.length) throw badRequest('Nothing to update (name_ar, name_en, name_ckb, active)');
  const res = await c.env.DB.prepare(`UPDATE brands SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...params, id)
    .run();
  if (res.meta.changes === 0) throw notFound('Brand not found');
  await audit(c.env.DB, admin.id, 'brand.update', id, body);
  const row = await c.env.DB.prepare('SELECT * FROM brands WHERE id = ?').bind(id).first<Record<string, unknown>>();
  return c.json({ success: true, brand: brandOut(row!) });
});

// ---------------------------------------------------------------- catalogs

adminProductsRoutes.get('/catalogs', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM catalogs ORDER BY sort, name_ar').all<
    Record<string, unknown>
  >();
  return c.json({ success: true, catalogs: results.map(catalogOut) });
});

adminProductsRoutes.post('/catalogs', async (c) => {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const nameAr = str(body.name_ar, 'name_ar', { min: 1, max: 200 });
  const nameEn = str(body.name_en, 'name_en', { max: 200, required: false });
  const nameCkb = str(body.name_ckb, 'name_ckb', { max: 200, required: false });
  const parentId = typeof body.parent_id === 'string' && body.parent_id ? body.parent_id : null;
  if (parentId) {
    const parent = await c.env.DB.prepare('SELECT id FROM catalogs WHERE id = ?').bind(parentId).first();
    if (!parent) throw badRequest('parent_id: unknown catalog');
  }
  const sort = int(body.sort, 'sort', { min: -100_000, max: 100_000, def: 0 });
  // §29 (serial scan, 0178): the printer flag is the owner's only where it
  // FLIPS a product's answer (`printerFlagSerialFlips`, landing round 3 F1).
  // A new catalog holds no product, so its flag is anyone's to set.
  const id = newId('cat');
  const base = slugToken(nameEn) || slugToken(nameAr) || `catalog-${id.slice(-6)}`;
  const slug = await uniqueSlugIn(c.env.DB, 'catalogs', base, null);
  await c.env.DB.prepare(
    'INSERT INTO catalogs (id, parent_id, slug, name_ar, name_en, name_ckb, sort, is_printer_catalog, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)'
  )
    .bind(id, parentId, slug, nameAr, nameEn, nameCkb, sort, body.is_printer_catalog ? 1 : 0)
    .run();
  await audit(c.env.DB, admin.id, 'catalog.create', id, { slug, name_ar: nameAr, parent_id: parentId });
  const row = await c.env.DB.prepare('SELECT * FROM catalogs WHERE id = ?').bind(id).first<Record<string, unknown>>();
  return c.json({ success: true, catalog: catalogOut(row!) });
});

adminProductsRoutes.patch('/catalogs/:id', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const sets: string[] = [];
  const params: unknown[] = [];
  if (body.name_ar !== undefined) {
    sets.push('name_ar = ?');
    params.push(str(body.name_ar, 'name_ar', { min: 1, max: 200 }));
  }
  if (body.name_en !== undefined) {
    sets.push('name_en = ?');
    params.push(str(body.name_en, 'name_en', { max: 200, required: false }));
  }
  if (body.name_ckb !== undefined) {
    sets.push('name_ckb = ?');
    params.push(str(body.name_ckb, 'name_ckb', { max: 200, required: false }));
  }
  if (body.parent_id !== undefined) {
    const parentId = typeof body.parent_id === 'string' && body.parent_id ? body.parent_id : null;
    if (parentId) {
      if (parentId === id) throw badRequest('parent_id: a catalog cannot be its own parent');
      // Reject cycles by walking up the proposed ancestor chain.
      let cursor: string | null = parentId;
      for (let depth = 0; cursor && depth < 25; depth++) {
        if (cursor === id) throw badRequest('parent_id: would create a catalog cycle');
        const parentRow: { parent_id: string | null } | null = await c.env.DB
          .prepare('SELECT parent_id FROM catalogs WHERE id = ?')
          .bind(cursor)
          .first<{ parent_id: string | null }>();
        if (parentRow === null && cursor === parentId) throw badRequest('parent_id: unknown catalog');
        cursor = parentRow?.parent_id ?? null;
      }
    }
    sets.push('parent_id = ?');
    params.push(parentId);
  }
  if (body.sort !== undefined) {
    sets.push('sort = ?');
    params.push(int(body.sort, 'sort', { min: -100_000, max: 100_000 }));
  }
  if (body.is_printer_catalog !== undefined) {
    sets.push('is_printer_catalog = ?');
    params.push(body.is_printer_catalog ? 1 : 0);
  }
  if (body.active !== undefined) {
    sets.push('active = ?');
    params.push(body.active ? 1 : 0); // deactivate only — catalogs are never deleted
  }
  if (!sets.length) throw badRequest('Nothing to update');
  // §29 (serial scan, 0178): a printer flag or a re-parent that FLIPS
  // whether a product filed under this catalog needs a serial is the
  // owner's — the same rule as the taxonomy editor. Only a change that flips
  // at least one product is an attempt: an echo, or a flag on a catalog whose
  // products all keep their answer, passes (landing round 3 F1). A request
  // that changes both is judged as ONE edit (round 4 R1), and the write
  // re-checks inside its batch that it flipped nothing (R2,
  // `serialAnswerFence`). The owner's edit is neither judged nor fenced.
  let guard: SerialAnswerFence | null = null;
  if (!isOwner(c.env, admin) && (body.is_printer_catalog !== undefined || body.parent_id !== undefined)) {
    const current = await c.env.DB.prepare('SELECT is_printer_catalog, parent_id FROM catalogs WHERE id = ?')
      .bind(id)
      .first<{ is_printer_catalog: number | null; parent_id: string | null }>();
    if (current) {
      const edit: CatalogEdit = {};
      if (body.is_printer_catalog !== undefined && Number(current.is_printer_catalog ?? 0) !== (body.is_printer_catalog ? 1 : 0)) {
        edit.flag = !!body.is_printer_catalog;
      }
      const parentId = typeof body.parent_id === 'string' && body.parent_id ? body.parent_id : null;
      if (body.parent_id !== undefined && (current.parent_id ?? null) !== parentId) edit.parentId = parentId;
      if (isCatalogEdit(edit)) {
        const flips = await catalogEditSerialFlips(c.env.DB, id, edit);
        if (flips > 0) throw serialRefuse(403, 'OWNER_ONLY', catalogEditRefusal(edit, flips));
        guard = await serialAnswerFence(c.env.DB, catalogEditScope(id, edit));
      }
    }
  }
  const update = c.env.DB.prepare(`UPDATE catalogs SET ${sets.join(', ')} WHERE id = ?`).bind(...params, id);
  let changes: number;
  if (guard) {
    const stmts = guard.around([update]);
    try {
      const results = await c.env.DB.batch(stmts);
      changes = Number(results[stmts.indexOf(update)]?.meta?.changes ?? 0);
    } catch (e) {
      if (isLostRace(e)) throw serialRefuse(409, 'SERIAL_FILING_CHANGED');
      throw e;
    }
  } else {
    changes = (await update.run()).meta.changes;
  }
  if (changes === 0) throw notFound('Catalog not found');
  await audit(c.env.DB, admin.id, 'catalog.update', id, body);
  const row = await c.env.DB.prepare('SELECT * FROM catalogs WHERE id = ?').bind(id).first<Record<string, unknown>>();
  return c.json({ success: true, catalog: catalogOut(row!) });
});

/**
 * Atomic insert-at reorder. All rows of the catalog jump to a temporary high
 * range first, then take their final 1..count positions — inside one D1 batch
 * (a transaction), so UNIQUE(catalog_id, position) can never conflict mid-shift.
 */
adminProductsRoutes.post('/catalogs/:catalogId/reorder', async (c) => {
  const admin = c.get('user')!;
  const catalogId = c.req.param('catalogId');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const productId = str(body.product_id, 'product_id', { min: 1, max: 60 });

  const { results: rows } = await c.env.DB.prepare(
    'SELECT product_id, position FROM product_catalogs WHERE catalog_id = ? ORDER BY position'
  )
    .bind(catalogId)
    .all<{ product_id: string; position: number }>();
  if (!rows.length) throw notFound('Catalog has no products (or does not exist)');
  const cur = rows.findIndex((r) => r.product_id === productId);
  if (cur === -1) throw notFound('Product is not in this catalog');

  const position = int(body.position, 'position', { min: 1, max: rows.length });

  if (cur + 1 !== position) {
    const order = rows.map((r) => r.product_id);
    order.splice(cur, 1);
    order.splice(position - 1, 0, productId);
    const OFFSET = 1_000_000;
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE product_catalogs SET position = position + ? WHERE catalog_id = ?').bind(
        OFFSET,
        catalogId
      ),
      ...order.map((pid, i) =>
        c.env.DB.prepare('UPDATE product_catalogs SET position = ? WHERE catalog_id = ? AND product_id = ?').bind(
          i + 1,
          catalogId,
          pid
        )
      ),
    ]);
  }
  await audit(c.env.DB, admin.id, 'catalog.reorder', catalogId, { product_id: productId, position });
  return c.json({ success: true, position });
});

// ---------------------------------------------------------------- products

/**
 * Bounded listing projection — for tables/search only, NEVER for editing.
 * The management screen's filters and sorts run here, server-side: every
 * user value is a bound parameter and the sort key maps through a fixed
 * whitelist before it can reach the SQL text. The bare call keeps its
 * original behaviour and shape.
 */
adminProductsRoutes.get('/', async (c) => {
  const q = c.req.query();
  const search = str(q.search, 'search', { max: 100, required: false });
  const limit = int(q.limit, 'limit', { min: 1, max: 100, def: 30 });
  const offset = int(q.offset, 'offset', { min: 0, max: 100_000, def: 0 });

  // The list used to read `products.stock`, even though direct inventory now
  // lives on options or exact option×colour variants. That made a perfectly
  // tracked product appear “unlimited”. These expressions project the same
  // authoritative level the storefront uses, aggregated only for the compact
  // management list. NULL at a required direct level is mapped to sold out in
  // the response below — never to unlimited.
  const hasDirectSql = `(CASE
    WHEN EXISTS (SELECT 1 FROM product_option_fulfillment af WHERE af.product_id = products.id)
      THEN EXISTS (
        SELECT 1 FROM product_option_fulfillment df
         WHERE df.product_id = products.id AND df.fulfillment_type = 'direct_sale' AND df.enabled = 1
      )
    ELSE selling_type IN ('direct_sale', 'bundle') OR sale_types LIKE '%direct_sale%' OR sale_types LIKE '%bundle%'
  END)`;
  const displayStockSql = `(CASE inventory_mode
    WHEN 'OPTION' THEN (
      SELECT CASE
        WHEN COUNT(*) = 0 OR SUM(CASE WHEN ov.stock IS NULL THEN 1 ELSE 0 END) > 0 THEN NULL
        ELSE SUM(ov.stock)
      END
      FROM product_option_values ov
      WHERE ov.product_id = products.id AND ov.active = 1
        AND EXISTS (
          SELECT 1 FROM product_option_fulfillment df
           WHERE df.product_id = products.id AND df.option_id = ov.id
             AND df.fulfillment_type = 'direct_sale' AND df.enabled = 1
        )
    )
    WHEN 'COLOR' THEN (
      SELECT CASE
        WHEN COUNT(*) = 0 OR SUM(CASE WHEN pc.stock IS NULL THEN 1 ELSE 0 END) > 0 THEN NULL
        ELSE SUM(pc.stock)
      END
      FROM product_colors pc WHERE pc.product_id = products.id AND pc.active = 1
    )
    WHEN 'VARIANT_COMBINATION' THEN (
      SELECT CASE
        WHEN COUNT(*) = 0 OR SUM(CASE WHEN pv.stock IS NULL THEN 1 ELSE 0 END) > 0 THEN NULL
        ELSE SUM(pv.stock)
      END
      FROM product_variants pv
      WHERE pv.product_id = products.id AND pv.active = 1
        AND EXISTS (
          SELECT 1 FROM product_option_fulfillment df
           WHERE df.product_id = products.id AND df.fulfillment_type = 'direct_sale' AND df.enabled = 1
             AND instr('|' || pv.combo_key || '|', '|o:' || df.option_id || '|') > 0
        )
    )
    ELSE stock
  END)`;
  const displayReservedSql = `(CASE inventory_mode
    WHEN 'OPTION' THEN COALESCE((
      SELECT SUM(COALESCE(ov.reserved, 0)) FROM product_option_values ov
      WHERE ov.product_id = products.id AND ov.active = 1
        AND EXISTS (
          SELECT 1 FROM product_option_fulfillment df
           WHERE df.product_id = products.id AND df.option_id = ov.id
             AND df.fulfillment_type = 'direct_sale' AND df.enabled = 1
        )
    ), 0)
    WHEN 'COLOR' THEN COALESCE((
      SELECT SUM(COALESCE(pc.reserved, 0)) FROM product_colors pc
       WHERE pc.product_id = products.id AND pc.active = 1
    ), 0)
    WHEN 'VARIANT_COMBINATION' THEN COALESCE((
      SELECT SUM(COALESCE(pv.reserved, 0)) FROM product_variants pv
      WHERE pv.product_id = products.id AND pv.active = 1
        AND EXISTS (
          SELECT 1 FROM product_option_fulfillment df
           WHERE df.product_id = products.id AND df.fulfillment_type = 'direct_sale' AND df.enabled = 1
             AND instr('|' || pv.combo_key || '|', '|o:' || df.option_id || '|') > 0
        )
    ), 0)
    ELSE stock_reserved
  END)`;

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (search) {
    // SKU is searchable too: §4 made it a real identifier, and an admin who
    // has a packing slip in hand has the SKU, not the Arabic name.
    clauses.push(`(${sqlLikeClause(['name', 'name_ar', 'name_ku', 'slug', 'sku'])} OR EXISTS(SELECT 1 FROM product_variants pv WHERE pv.product_id=products.id AND pv.sku=?) OR EXISTS(SELECT 1 FROM product_option_values ov WHERE ov.product_id=products.id AND ov.sku_part=?) OR EXISTS(SELECT 1 FROM product_colors pc WHERE pc.product_id=products.id AND pc.sku_part=?))`);
    const like = likePattern(search);
    params.push(like, like, like, like, like,search,search,search);
  }
  if (['draft', 'active', 'hidden'].includes(q.status ?? '')) {
    clauses.push('status = ?');
    params.push(q.status);
  }
  if (q.brand) {
    clauses.push('brand_id = ?');
    params.push(str(q.brand, 'brand', { max: 60 }));
  }
  if (q.catalog) {
    clauses.push('EXISTS (SELECT 1 FROM product_catalogs pc WHERE pc.product_id = products.id AND pc.catalog_id = ?)');
    params.push(str(q.catalog, 'catalog', { max: 60 }));
  }
  if (q.stock === 'in') clauses.push(`(${hasDirectSql} AND ${displayStockSql} IS NOT NULL AND ${displayStockSql} - ${displayReservedSql} > 0)`);
  else if (q.stock === 'out') clauses.push(`(${hasDirectSql} AND (${displayStockSql} IS NULL OR ${displayStockSql} - ${displayReservedSql} <= 0))`);
  else if (q.stock === 'low')
    clauses.push(`(${hasDirectSql} AND ${displayStockSql} IS NOT NULL AND ${displayStockSql} - ${displayReservedSql} > 0 AND ${displayStockSql} - ${displayReservedSql} <= 5)`);
  else if (q.stock === 'preorder') clauses.push(`(NOT ${hasDirectSql})`);
  if (q.days !== undefined) {
    clauses.push('created_at >= ?');
    params.push(new Date(Date.now() - int(q.days, 'days', { min: 1, max: 3650 }) * 86_400_000).toISOString());
  }
  if (q.featured === '1') clauses.push('is_featured = 1');
  // «يحتاج تسعيرًا» (the clean start, A.5/A.8): not V2-published — hidden from every customer.
  const v2Cols = await pricingV2Installed(c.env.DB);
  const v2PublishedSql = v2Cols
    ? `EXISTS (SELECT 1 FROM product_pricing_state vs WHERE vs.product_id = products.id AND vs.mode = 'engine' AND vs.pricing_method IS NOT NULL
         AND EXISTS (SELECT 1 FROM pricing_v2_sku_results vr WHERE vr.product_id = products.id))`
    : '0';
  if (q.needs_pricing === '1') clauses.push(`NOT ${v2PublishedSql}`);
  // The price band and the price sorts read the V2 from-price (the lowest final price its V2 results sell at),
  // NULL while the product needs pricing — never the legacy `price_iqd` of a hidden product, which a narrowing
  // band would otherwise disclose to any admin (review 2026-10-14).
  const v2FromSql = v2Cols
    ? `(CASE WHEN ${v2PublishedSql} THEN (SELECT MIN(fr.final_price_iqd) FROM pricing_v2_sku_results fr WHERE fr.product_id = products.id) END)`
    : 'NULL';
  if (q.price_min !== undefined) {
    clauses.push(`${v2FromSql} >= ?`);
    params.push(int(q.price_min, 'price_min', { min: 0, max: 1_000_000_000 }));
  }
  if (q.price_max !== undefined) {
    clauses.push(`${v2FromSql} <= ?`);
    params.push(int(q.price_max, 'price_max', { min: 0, max: 1_000_000_000 }));
  }
  // «ناقص» (owner brief 2026-10-10, migration 0184): the products the central
  // required-field list finds incomplete. Without 0184 there is nothing to
  // filter by and the column reads null.
  const completeness = await completenessInstalled(c.env.DB);
  if (q.incomplete === '1' && completeness) {
    clauses.push('EXISTS (SELECT 1 FROM product_completeness pcf WHERE pcf.product_id = products.id AND pcf.complete = 0)');
  }
  /**
   * «طلبات السعر» (DECISIONS row 240, migration 0193): the distinct people with an open request, a sort by
   * them and a filter. Published products with an open per-SKU request show here too (the queue lists only
   * the unpublished ones, default D9). Without 0193 the column reads null, the sort is `updated` and the
   * filter answers nothing (`requests_unavailable`).
   */
  const requestsInstalled = await priceRequestsInstalled(c.env.DB);
  const requestersSql = '(SELECT st.requesters FROM product_price_request_stats st WHERE st.product_id = products.id)';
  if (q.requested === '1') clauses.push(requestsInstalled ? `COALESCE(${requestersSql}, 0) > 0` : '0');
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const requestCols = requestsInstalled ? `,
              ${requestersSql} AS price_requests` : '';
  const completenessCols = completeness
    ? `,
              (SELECT pcl.missing_json FROM product_completeness pcl WHERE pcl.product_id = products.id) AS completeness_missing,
              (SELECT pcl.held FROM product_completeness pcl WHERE pcl.product_id = products.id) AS completeness_held`
    : '';
  const seesPrivate = canViewCost(c.env, c.get('user'));

  const ORDERS: Record<string, string> = {
    updated: 'updated_at DESC',
    newest: 'created_at DESC',
    oldest: 'created_at ASC',
    // Needs-pricing rows (no from-price) last, whichever way (A.5).
    price_asc: `${v2FromSql} IS NULL, ${v2FromSql} ASC, updated_at DESC`,
    price_desc: `${v2FromSql} IS NULL, ${v2FromSql} DESC, updated_at DESC`,
    sales: 'sold DESC, updated_at DESC',
    stock: `${displayStockSql} IS NULL, ${displayStockSql} - ${displayReservedSql} ASC, updated_at DESC`,
    // The most-requested first, then the latest request (DECISIONS row 240); `updated` without 0193.
    requests: requestsInstalled
      ? `COALESCE(${requestersSql}, 0) DESC, COALESCE((SELECT st.last_request_at FROM product_price_request_stats st WHERE st.product_id = products.id), '') DESC, updated_at DESC`
      : 'updated_at DESC',
  };
  // Own-property lookup only: a plain object literal would otherwise answer
  // ?sort=constructor with a stringified builtin inside the SQL text.
  const sortKey = q.sort ?? 'updated';
  const orderBy = pickFrom(ORDERS, sortKey, ORDERS.updated);

  const [list, count] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, slug, sku, status, name, name_ar, price_iqd, pro_price_iqd,
              ${displayStockSql} AS display_stock, ${displayReservedSql} AS display_reserved,
              ${hasDirectSql} AS has_direct_sale,
              low_stock_threshold, is_featured, brand_id, created_at, updated_at, doc_version,
              composition,
              ${v2PublishedSql} AS v2_published,
              ${v2FromSql} AS v2_from_iqd,
              COALESCE((SELECT SUM(i.qty) FROM order_items i
                         JOIN orders o ON o.id = i.order_id
                        WHERE i.product_id = products.id AND o.status != 'cancelled'), 0) AS sold${completenessCols}${requestCols}
         FROM products${where}
        ORDER BY ${orderBy} LIMIT ? OFFSET ?`
    )
      .bind(...params, limit, offset)
      .all<Record<string, unknown>>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM products${where}`)
      .bind(...params)
      .first<{ n: number }>(),
  ]);
  const images = await loadAuthoritativeProductImages(
    c.env.DB,
    list.results.map((product) => String(product.id))
  );

  return c.json({
    success: true,
    total: count?.n ?? 0,
    limit,
    offset,
    ...(q.requested === '1' && !requestsInstalled ? { requests_unavailable: true } : {}),
    products: list.results.map((r) => {
      return {
        id: r.id,
        slug: r.slug,
        sku: (r.sku as string | null) ?? null,
        status: r.status,
        name_ar: r.name_ar,
        name_en: r.name,
        // A product still waiting for its first V2 write shows no dinar figure (its stored ladder is legacy).
        price_iqd: Number(r.v2_published ?? 0) === 1 ? r.price_iqd : null,
        pro_price_iqd: Number(r.v2_published ?? 0) === 1 ? ((r.pro_price_iqd as number | null) ?? null) : null,
        // No NULL is ever exposed for an enabled direct sale. A missing row
        // is a configuration error and therefore sold out until fixed.
        stock: r.has_direct_sale ? Number(r.display_stock ?? 0) : null,
        stock_reserved: r.has_direct_sale ? Number(r.display_reserved ?? 0) : 0,
        has_direct_sale: !!r.has_direct_sale,
        low_stock_threshold: (r.low_stock_threshold as number | null) ?? null,
        sold: Number(r.sold ?? 0),
        is_featured: !!r.is_featured,
        // '' on every ordinary product; 'bundle' / 'mystery' on a composition
        // row, so the grid BADGES it and sends the admin to the bundles panel
        // instead of opening an editor that will refuse (COMPOSITION_PRODUCT).
        composition: String(r.composition ?? ''),
        // The clean start (A.5): hidden from customers until its first complete V2 write; and the
        // lowest final price its V2 results sell at (null while it needs pricing) — never a legacy figure.
        needs_pricing: Number(r.v2_published ?? 0) !== 1,
        from_iqd: Number(r.v2_published ?? 0) === 1 && r.v2_from_iqd !== null && r.v2_from_iqd !== undefined ? Number(r.v2_from_iqd) : null,
        // The required-field verdict, projected for this viewer (a non-owner
        // counts the private fields as ONE «owner data» item): null = not
        // evaluated yet (or no 0184). `held`: hidden from customers by the
        // owner's switch.
        missing_count:
          r.completeness_missing === null || r.completeness_missing === undefined
            ? null
            : projectItems(parseMissing(r.completeness_missing), seesPrivate).length,
        held: Number(r.completeness_held ?? 0) === 1,
        // Distinct people with an open «طلب السعر» (a count, never who): null without 0193.
        price_requests: requestsInstalled ? Number(r.price_requests ?? 0) : null,
        brand_id: (r.brand_id as string | null) ?? null,
        image: images.get(String(r.id)) ?? '',
        created_at: (r.created_at as string | null) ?? null,
        updated_at: r.updated_at,
        doc_version: r.doc_version,
      };
    }),
  });
});

/**
 * The management screen's stat feed — real aggregates only. Weekly buckets
 * come from created_at (the only per-product history that exists); sales
 * come from actual order lines for the platform's own goods. Gross revenue
 * is a financial figure, so scoped admins get the units without it. There
 * is no view counter on platform products, and none is invented.
 */
/**
 * «يحتاج تسعيرًا» (the clean start, addendum A.8): every product hidden until its
 * first complete V2 write, with its state and the grouped missing items — codes,
 * counts and names only, projected per viewer (`v2/queue.ts`). No bulk publish.
 */
adminProductsRoutes.get('/needs-pricing', limitRoute('pricing-read', 1200), async (c) => {
  const q = c.req.query();
  const page = int(q.page, 'page', { min: 1, max: 1000, def: 1 });
  const raw = q.filter ?? 'all';
  const filter = (QUEUE_FILTERS as readonly string[]).includes(raw) ? (raw as QueueFilter) : 'all';
  return c.json(await needsPricingAnswer(c, { page, filter }));
});

/**
 * D1 — THE PURCHASE REVIEW (addendum A.10): a confirmed stock purchase's costs wait here until the
 * owner previews the price change and applies it (or keeps the current cost). Owner-only: the
 * review is cost; everyone else gets the cost refusal by name, the same for a real and an invented id.
 */
const requireReviewOwner = (c: Context<AppContext>) => {
  const user = c.get('user')!;
  if (!canWriteCost(c.env, user) || !canViewCost(c.env, user)) throw costRefusal(c.env, user, { fields: ['purchase_review'] });
};
adminProductsRoutes.get('/:id/purchase-review', limitRoute('pricing-read', 1200), async (c) => {
  requireReviewOwner(c);
  const row = await loadPurchaseReview(c.env.DB, c.req.param('id'));
  c.header('Cache-Control', 'private, no-store');
  return c.json({ success: true, purchase_review: row ? reviewView(row) : null });
});
adminProductsRoutes.post('/:id/purchase-review/:reviewId/preview', limitRoute('pricing-read', 1200), async (c) => {
  requireReviewOwner(c);
  c.header('Cache-Control', 'private, no-store');
  return c.json(await previewPurchaseReview(c, c.req.param('id'), c.req.param('reviewId')));
});
adminProductsRoutes.post('/:id/purchase-review/:reviewId/apply', limitRoute('pricing-write', 600), async (c) => {
  requireReviewOwner(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const result = await applyPurchaseReview(c, c.req.param('id'), c.req.param('reviewId'), body);
  const slug = await c.env.DB.prepare('SELECT slug FROM products WHERE id = ?').bind(c.req.param('id')).first<{ slug: string }>();
  if (slug?.slug) c.set('catalogueSlug', slug.slug);
  c.header('Cache-Control', 'private, no-store');
  return c.json(result);
});
adminProductsRoutes.post('/:id/purchase-review/:reviewId/dismiss', limitRoute('pricing-write', 600), async (c) => {
  requireReviewOwner(c);
  c.header('Cache-Control', 'private, no-store');
  return c.json(await dismissPurchaseReview(c, c.req.param('id'), c.req.param('reviewId')));
});

adminProductsRoutes.get('/stats', async (c) => {
  const db = c.env.DB;
  const since12w = new Date(Date.now() - 12 * 7 * 86_400_000).toISOString();
  const since30d = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const since14d = new Date(Date.now() - 14 * 86_400_000).toISOString();

  const [totals, weekly, sales30, salesDaily] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft,
              SUM(CASE WHEN status = 'hidden' THEN 1 ELSE 0 END) AS hidden,
              SUM(CASE WHEN stock IS NOT NULL AND stock - stock_reserved <= 0 THEN 1 ELSE 0 END) AS out_of_stock,
              SUM(CASE WHEN is_featured = 1 THEN 1 ELSE 0 END) AS featured
         FROM products`
    ).first<Record<string, number>>(),
    db.prepare(
      `SELECT substr(created_at, 1, 10) AS day,
              COUNT(*) AS added,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_added,
              SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft_added,
              SUM(CASE WHEN status = 'hidden' THEN 1 ELSE 0 END) AS hidden_added
         FROM products WHERE created_at >= ?
        GROUP BY day ORDER BY day`
    ).bind(since12w).all(),
    db.prepare(
      `SELECT COALESCE(SUM(i.qty), 0) AS units, COUNT(DISTINCT o.id) AS orders,
              COALESCE(SUM(i.line_total_iqd), 0) AS gross
         FROM order_items i JOIN orders o ON o.id = i.order_id
        WHERE i.product_id IS NOT NULL AND o.status != 'cancelled' AND o.created_at >= ?`
    ).bind(since30d).first<Record<string, number>>(),
    db.prepare(
      `SELECT substr(o.created_at, 1, 10) AS day, COUNT(DISTINCT o.id) AS orders, COALESCE(SUM(i.qty), 0) AS units
         FROM order_items i JOIN orders o ON o.id = i.order_id
        WHERE i.product_id IS NOT NULL AND o.status != 'cancelled' AND o.created_at >= ?
        GROUP BY day ORDER BY day`
    ).bind(since14d).all(),
  ]);

  // Fixed windows, zero-filled: the sparklines describe the WHOLE 12-week /
  // 14-day span, and an empty bucket is a real zero — never a shrunken series
  // that makes two lonely data points look like a trend.
  const now = Date.now();
  const weeks = Array.from({ length: 12 }, (_, i) => ({
    week: new Date(now - (12 - i) * 7 * 86_400_000).toISOString().slice(0, 10),
    added: 0,
    active_added: 0,
    draft_added: 0,
    hidden_added: 0,
  }));
  for (const w of weekly.results ?? []) {
    const age = now - new Date(`${w.day}T00:00:00Z`).getTime();
    const idx = 11 - Math.floor(age / (7 * 86_400_000));
    const bucket = weeks[Math.min(11, Math.max(0, idx))];
    bucket.added += Number(w.added ?? 0);
    bucket.active_added += Number(w.active_added ?? 0);
    bucket.draft_added += Number(w.draft_added ?? 0);
    bucket.hidden_added += Number(w.hidden_added ?? 0);
  }
  const dayRows = new Map((salesDaily.results ?? []).map((r) => [String(r.day), r]));
  const days = Array.from({ length: 14 }, (_, i) => {
    const day = new Date(now - (13 - i) * 86_400_000).toISOString().slice(0, 10);
    const r = dayRows.get(day);
    return { day, orders: Number(r?.orders ?? 0), units: Number(r?.units ?? 0) };
  });

  // «ناقص» / «مخفي عن الزبائن» counts (owner brief 2026-10-10), ordinary products only.
  const completenessTotals = (await completenessInstalled(db))
    ? await db
        .prepare(
          `SELECT TOTAL(pc.complete = 0) AS incomplete, TOTAL(pc.held = 1) AS held
             FROM product_completeness pc JOIN products p ON p.id = pc.product_id
            WHERE COALESCE(p.composition, '') = ''`
        )
        .first<{ incomplete: number; held: number }>()
    : null;
  // The clean start (C5, review 2026-10-14): an ACTIVE product still «يحتاج تسعيرًا» is hidden from every
  // customer — the Active tile says how many of its products customers cannot see yet (a count, never a figure).
  const activeNeedsPricing = (await pricingV2Installed(db))
    ? await db
        .prepare(
          `SELECT COUNT(*) AS n FROM products p
            WHERE p.status = 'active'
              AND NOT EXISTS (SELECT 1 FROM product_pricing_state vs WHERE vs.product_id = p.id AND vs.mode = 'engine' AND vs.pricing_method IS NOT NULL
                                AND EXISTS (SELECT 1 FROM pricing_v2_sku_results vr WHERE vr.product_id = p.id))`
        )
        .first<{ n: number }>()
        .then((r) => Number(r?.n ?? 0))
        .catch(() => null)
    : null;
  // Revenue is a MONEY figure, not a cost (owner decision 2 keeps it with
  // full-scope admins).
  const financial = canMoveMoney(c.env, c.get('user'));
  return c.json({
    success: true,
    totals: {
      total: totals?.total ?? 0,
      active: totals?.active ?? 0,
      draft: totals?.draft ?? 0,
      hidden: totals?.hidden ?? 0,
      out_of_stock: totals?.out_of_stock ?? 0,
      featured: totals?.featured ?? 0,
      incomplete: completenessTotals ? Number(completenessTotals.incomplete ?? 0) : null,
      held: completenessTotals ? Number(completenessTotals.held ?? 0) : null,
      active_needs_pricing: activeNeedsPricing,
    },
    weekly: weeks,
    sales_30d: {
      units: sales30?.units ?? 0,
      orders: sales30?.orders ?? 0,
      ...(financial ? { gross_iqd: sales30?.gross ?? 0 } : {}),
    },
    sales_daily: days,
  });
});

// «ناقص» and «إخفاء المنتجات الناقصة عن الزبائن» (owner brief 2026-10-10):
// before every `/:id` route so `/completeness/*` is never read as a product id.
registerCompletenessRoutes(adminProductsRoutes);

/**
 * THE RESIDUE FROM EVERY DELETE THAT CAME BEFORE THIS ONE.
 *
 * A DRY RUN AND NOTHING ELSE. It reports the rows whose product is already
 * gone, and the R2 objects under `products/` that no row references — table by
 * table, with sample ids and a byte total — and it removes nothing.
 *
 * Destructive cleanup is a SEPARATE call which refuses to run unless it is
 * handed the counts from a dry run it can still reproduce. That is not
 * ceremony: it is what makes "I looked at the report first" a fact the server
 * can check rather than a promise the client makes.
 */
adminProductsRoutes.get('/maintenance/orphans', async (c) => {
  const report = await scanProductOrphans(c.env.DB, c.env.R2_PUBLIC ?? c.env.BUCKET ?? null, { dryRun: true });

  /**
   * THE REPORT TELLS THE TRUTH ABOUT ITSELF NOW.
   *
   * `scanProductOrphans` calls an object an orphan when the PRODUCT tables do
   * not name it. That is not the same question as "is anything on this site
   * still showing it", and the difference had a list: the home-page banners
   * (their pointers live in a JSON blob in `admin_settings`) and every past
   * order's thumbnail (`order_items.image_snapshot`). Both are stored under
   * `products/`, which is the prefix this scan lists, so both were reported as
   * orphans and would have been deleted.
   *
   * The wide reference set (worker/lib/mediaRefs.ts) is applied here, and what
   * it rescues is reported as `r2_objects_protected` rather than quietly
   * dropped — the admin should be able to SEE that the old report was wrong,
   * on the screen, before deciding anything.
   *
   * This call stays read-only whatever the coverage says. Only the delete is
   * gated; a report that refuses to run helps nobody diagnose anything.
   */
  const coverage = await verifyMediaCoverage(c.env.DB);
  const partition = partitionSweepCandidates(report.orphan_r2_objects, coverage.scan.keys);

  return c.json({
    success: true,
    ...report,
    orphan_r2_objects: partition.removable,
    r2_objects_protected: partition.protected_keys,
    /**
     * Uploaded too recently to be judged. An admin with a product form open
     * has pictures in R2 that no row names yet, and they are not orphans —
     * they are halfway through being saved. See `SWEEP_MIN_AGE_MS`.
     */
    r2_objects_too_new: partition.staged_keys,
    totals: {
      ...report.totals,
      orphan_r2_objects: partition.removable.length,
      orphan_bytes: partition.removable.reduce((n, o) => n + o.bytes, 0),
      r2_objects_protected: partition.protected_keys.length,
      r2_objects_too_new: partition.staged_keys.length,
    },
    reference_coverage: {
      ok: coverage.ok,
      refusals: coverage.refusals,
      unclassified_columns: coverage.audit.unclassified,
      sources_scanned: coverage.scan.scanned.length,
      sources_absent: coverage.scan.absent,
      sources_failed: coverage.scan.failed,
      referenced_keys: coverage.scan.keys.size,
      cleanup_allowed: coverage.ok,
    },
    scanned_at: new Date().toISOString(),
  });
});

adminProductsRoutes.post('/maintenance/orphans/cleanup', async (c) => {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as { confirm?: unknown; expect?: unknown };
  if (body.confirm !== 'DELETE-ORPHANS') {
    throw badRequest('Run the dry run first, then send confirm: "DELETE-ORPHANS".', 'ORPHAN_CLEANUP_UNCONFIRMED');
  }
  const bucket = c.env.R2_PUBLIC ?? c.env.BUCKET ?? null;

  /**
   * THE BUTTON REFUSES ITSELF UNTIL THE REFERENCE SET IS PROVABLY COMPLETE.
   *
   * The narrowing that made the banners invisible was not a typo — it was a
   * reference set that nobody had checked against the schema. So the check is
   * the gate: every column in the live schema that can hold an object key must
   * be classified in `worker/lib/mediaRefs.ts`, as a source that is scanned or
   * as an exclusion with a written reason, and every one of those scans must
   * have actually run. A migration that adds a key-bearing column makes this
   * refuse on the next request, naming the column.
   *
   * A refusal, never a silent no-op and never a partial sweep: nothing is
   * deleted, the reason is the response body, and the read-only report above
   * still works so the admin can see exactly what is unverified.
   */
  /**
   * THE BUCKET IS LISTED FIRST AND THE REFERENCES ARE READ SECOND. ALWAYS.
   *
   * This is an ordering, not a preference, and getting it the other way round
   * is the one arrangement that can destroy a live image through pure timing.
   * Suppose the references are read first: a key is absent from that snapshot,
   * correctly, because nothing names it at that instant. A product save then
   * commits and writes `product_images.r2_key = <key>`. The bucket listing
   * that runs afterwards returns the key, the partition asks the OLDER
   * snapshot, gets a miss, and the object is destroyed while a live row names
   * it. Listing first inverts the window: anything already in the candidate
   * list has its references read AFTER it, so a reference written during the
   * gap is still seen and the object is protected. The read-only report above
   * has always been ordered this way; this handler had not been.
   */
  const preview = await scanProductOrphans(c.env.DB, bucket, { dryRun: true });
  const coverage = await verifyMediaCoverage(c.env.DB);
  if (!coverage.ok) {
    throw new HttpError(
      409,
      'لا يمكن تشغيل التنظيف: مجموعة المراجع غير مكتملة لهذا المخطط. ' +
        'Refusing the destructive sweep: the reference set is not provably complete for the current schema. / ' +
        'ناتوانرێت پاککردنەوە جێبەجێ بکرێت: کۆمەڵەی ئاماژەکان بۆ ئەم پێکهاتەیە تەواو نییە.',
      'ORPHAN_CLEANUP_COVERAGE_INCOMPLETE',
      {
        refusals: coverage.refusals,
        unclassified_columns: coverage.audit.unclassified,
        sources_failed: coverage.scan.failed,
        remedy: 'Classify each column in MEDIA_REFERENCE_SOURCES or NON_MEDIA_COLUMNS (worker/lib/mediaRefs.ts).',
      }
    );
  }

  // Compare against what the admin was shown. If the database moved under
  // them, the numbers differ and nothing is deleted. The comparison is
  // against the WIDENED count, which is the one the report displays.
  const partition = partitionSweepCandidates(preview.orphan_r2_objects, coverage.scan.keys);
  const expect = (body.expect ?? {}) as { orphan_rows?: unknown; orphan_r2_objects?: unknown };
  if (
    Number(expect.orphan_rows) !== preview.totals.orphan_rows ||
    Number(expect.orphan_r2_objects) !== partition.removable.length
  ) {
    throw new HttpError(
      409,
      'The database changed since the dry run — re-run the report and confirm the new numbers.',
      'ORPHAN_REPORT_STALE',
      {
        current: { orphan_rows: preview.totals.orphan_rows, orphan_r2_objects: partition.removable.length },
        expected: { orphan_rows: expect.orphan_rows, orphan_r2_objects: expect.orphan_r2_objects },
      }
    );
  }

  /**
   * THE ROWS AND THE OBJECTS ARE REMOVED BY DIFFERENT HANDS, ON PURPOSE.
   *
   * The dangling-row half of `scanProductOrphans` is correct and is reused
   * exactly as it is — passing `null` for the bucket runs it and nothing else.
   * The R2 half is NOT reused, because it deletes from its own narrow
   * reference set and that is the defect: it would remove the banners no
   * matter what this route checked first. The objects are removed here, from
   * the partition the wide reference set cleared, and nowhere else.
   */
  const report = await scanProductOrphans(c.env.DB, null, { dryRun: false });

  /**
   * ONE LAST READ OF THE REFERENCES, IMMEDIATELY BEFORE THE BUCKET IS TOUCHED.
   *
   * The staleness check above is computed before the row-delete pass, and the
   * row-delete pass walks every owned table — so a save committing in that gap
   * is guarded by nothing at all. This is the same re-check the queue performs
   * for its own jobs (`runGuardedMediaCleanup`), applied to the sweep: the set
   * is rebuilt, the candidates are strained through it a second time, and
   * anything that came back in the meantime is reported as protected instead
   * of deleted. It costs one more coverage scan on a button pressed a few
   * times a year. An image deleted by mistake does not come back.
   */
  const recheck = await verifyMediaCoverage(c.env.DB);
  if (!recheck.ok) {
    throw new HttpError(
      409,
      'أُلغي حذف الملفات: تعذّر إثبات اكتمال مجموعة المراجع قبل الحذف مباشرة — لم يُحذف أي ملف. / ' +
        'Aborted before touching the bucket: the reference set could not be proven complete on the final check, so no object was deleted. / ' +
        'پێش دەستلێدان بە کۆگاکە ڕاگیرا: کۆمەڵەی ئاماژەکان نەسەلمێنرا، هیچ فایلێک نەسڕایەوە.',
      'ORPHAN_CLEANUP_COVERAGE_INCOMPLETE',
      { refusals: recheck.refusals, rows_removed: report.removed?.rows_by_table ?? {} }
    );
  }
  const finalPartition = partitionSweepCandidates(partition.removable, recheck.scan.keys);
  const swept = await deleteSweptObjects(c.env, finalPartition.removable);
  await markObjectsDeleted(c.env.DB, swept.deleted);
  const invalidated = await invalidateMediaCache(new URL(c.req.url).origin, swept.deleted);

  const protectedKeys = [...partition.protected_keys, ...finalPartition.protected_keys];
  await audit(c.env.DB, admin.id, 'product_v2.orphan_cleanup', 'maintenance', {
    rows: report.removed?.rows_by_table ?? {},
    r2_objects: swept.deleted.length,
    r2_objects_protected: protectedKeys.length,
    r2_objects_saved_by_recheck: finalPartition.protected_keys.length,
    r2_objects_too_new: partition.staged_keys.length,
    r2_objects_failed: swept.failed.length,
  });
  return c.json({
    success: true,
    ...report,
    orphan_r2_objects: finalPartition.removable,
    r2_objects_protected: protectedKeys,
    /** Saved by the FINAL re-check: a row started naming them mid-sweep. */
    r2_objects_saved_by_recheck: finalPartition.protected_keys,
    r2_objects_too_new: partition.staged_keys,
    /**
     * `report` comes from the row-only scan (`bucket = null`), so its own
     * totals count zero objects and zero bytes. Spreading it and then
     * overriding only `orphan_r2_objects` left the body contradicting itself:
     * twelve keys listed as removed beside `totals.orphan_r2_objects: 0`. The
     * GET handler already overrides `totals`; so does this one now, because
     * `totals` is the shape any admin screen reads for a headline number.
     */
    totals: {
      ...report.totals,
      orphan_r2_objects: finalPartition.removable.length,
      orphan_bytes: finalPartition.removable.reduce((n, o) => n + o.bytes, 0),
      r2_objects_protected: protectedKeys.length,
      r2_objects_too_new: partition.staged_keys.length,
      r2_scanned: preview.r2_scanned,
    },
    r2_scanned: preview.r2_scanned,
    removed: { rows_by_table: report.removed?.rows_by_table ?? {}, r2_objects: swept.deleted },
    r2_delete_failures: swept.failed,
    cache_keys_invalidated: invalidated,
  });
});

/**
 * DRAIN THE QUEUE — the removals a product delete could not finish, AND the
 * images an ordinary product save detached.
 *
 * `runGuardedMediaCleanup` replaces the bare `runMediaCleanup` here for two
 * reasons the queue now depends on:
 *
 *   1. IT RE-CHECKS. A job queued when an admin removed a picture from a
 *      product may, minutes later, name a key that the same admin has attached
 *      to another product or pasted into a home banner. The question the
 *      bucket delete answers is "is this unreferenced NOW", not "was it
 *      unreferenced when we queued it". A key that came back is closed as
 *      `skipped_shared` and its bytes are left alone.
 *   2. IT STOPS. `runMediaCleanup` bumps `attempts` and leaves the job pending
 *      however often it fails, so a key R2 will never accept is retried for
 *      ever. Past `MEDIA_CLEANUP_MAX_ATTEMPTS` the job moves to `failed` with
 *      its last error, where a human can read it.
 *
 * Full-product deletion now uses the same global gate: the product may be
 * gone while a banner, receipt or immutable order snapshot still owns its
 * bytes.
 */
adminProductsRoutes.post('/maintenance/media-cleanup/retry', async (c) => {
  const admin = c.get('user')!;
  const outcome = await runGuardedMediaCleanup(c.env);
  if (!outcome.ran) {
    throw new HttpError(
      409,
      'لا يمكن تشغيل التنظيف: مجموعة المراجع غير مكتملة لهذا المخطط. / ' +
        'Refusing to delete queued objects: the reference set is not provably complete, so a queued key cannot be shown to be unreferenced. / ' +
        'ناتوانرێت فایلە ڕیزکراوەکان بسڕدرێنەوە: کۆمەڵەی ئاماژەکان تەواو نییە.',
      'MEDIA_CLEANUP_COVERAGE_INCOMPLETE',
      { refusals: outcome.refusals, pending: outcome.attempted }
    );
  }
  const invalidated = await invalidateMediaCache(new URL(c.req.url).origin, outcome.deleted);
  if (outcome.attempted) {
    await audit(c.env.DB, admin.id, 'product_v2.media_cleanup_retry', 'maintenance', {
      attempted: outcome.attempted,
      deleted: outcome.deleted.length,
      still_referenced: outcome.still_referenced.length,
      dead_lettered: outcome.dead_lettered.length,
      retrying: outcome.retrying.length,
    });
  }
  return c.json({
    success: true,
    attempted: outcome.attempted,
    r2_objects_deleted: outcome.deleted,
    r2_objects_still_referenced: outcome.still_referenced,
    r2_cleanup_dead_lettered: outcome.dead_lettered,
    r2_cleanup_pending: outcome.retrying.length,
    /** One per chunk: which reference snapshot each delete was judged against. */
    reference_snapshots: outcome.verified_at,
    /** A ledger write that failed after the bucket had already answered. */
    bookkeeping_failures: outcome.bookkeeping_failures,
    cache_keys_invalidated: invalidated,
  });
});

/**
 * Status-only change for the management screen's quick hide/publish. The
 * full save demands the whole validated document and the legacy upsert
 * rewrites every column from whatever body it gets, so neither is safe for a
 * one-field toggle: this touches status (and updated_at) and nothing else.
 */
adminProductsRoutes.patch('/:id/status', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as { status?: unknown } | null;
  const status = body?.status;
  if (status !== 'draft' && status !== 'active' && status !== 'hidden') {
    throw badRequest('status must be draft, active or hidden');
  }
  const res = await c.env.DB.prepare('UPDATE products SET status = ?, updated_at = ? WHERE id = ?')
    .bind(status, new Date().toISOString(), id)
    .run();
  if (res.meta.changes === 0) throw notFound('Product not found');
  await audit(c.env.DB, admin.id, 'product_v2.status', id, { status });
  return c.json({ success: true, id, status });
});

/** The FULL canonical document + catalog placement — the edit payload. */
/**
 * «يناسب الطابعات» — every printer in the catalogue, for the product form's
 * picker (0148, worker/lib/printerFits.ts). Every status: a part can be linked
 * to a printer before that printer is published. Registered before `/:id`,
 * which would otherwise read «printer-options» as a product id.
 */
adminProductsRoutes.get('/printer-options', async (c) => {
  return c.json({ success: true, printers: await printerOptions(c.env.DB) });
});

// ---------------------------------------------------------------- Pricing V2-3b
//
// The V2 state of a product, its draft-capable preview and its prices-only
// apply (implementation spec §4; worker/lib/pricingEngine/v2/api.ts). On the
// products router because price editors reach them (C-7); the owner-only
// fields are enforced per field and every answer is built from an allow-list
// (v2/dto.ts). Private and never stored. A preview writes nothing.

const COMPOSITION_REFUSAL = () => new HttpError(409, serverMessage('COMPOSITION_NOT_PRICEABLE'), 'COMPOSITION_NOT_PRICEABLE', { section: 3 });

/** The stored product as V2 reads it; 404 for an unknown id, 409 for a bundle (never V2-priced). */
async function v2ReadOf(c: Context<AppContext>, id: string): Promise<V2Read> {
  const read = await loadV2Read(c.env.DB, id);
  if (!read) throw notFound('Product not found');
  if ((read.loaded.doc.composition ?? '') !== '') throw COMPOSITION_REFUSAL();
  return read;
}

/**
 * The product's V2 answer as stored, for this caller (the store laid over
 * nothing: the same set a preview with no field prices). A product with no
 * method yet — every product of the clean start (DECISIONS row 222, addendum
 * A.7) — answers its PREFILL in the method it is shown in: its stored cost
 * inputs, minimum profit and folded purchase overlay; never an old dinar price.
 */
async function v2StoredAnswer(c: Context<AppContext>, id: string) {
  const read = await v2ReadOf(c, id);
  const viewer = v2ViewerOf(c.env, c.get('user'));
  // The reader's own desired set: an editor's evaluation folds no purchase review and its hash binds no cost (C-14).
  const o = { viewer, env: c.env, user: c.get('user'), now: new Date().toISOString() };
  const method = storedMethodOf(read);
  if (method) return v2Answer({ viewer, read, ev: await evaluateDesired(read, desiredFor(read, { sent: [] }, o)) });
  // A database before 0189 (a deploy ahead of its migration) prices nothing: the flag alone.
  if (!(await pricingV2Installed(c.env.DB))) return uninstalledAnswer(read, viewer);
  const defaultMethod = await defaultMethodOf(read, viewer, o);
  const ev = await evaluateDesired(read, desiredFor(read, { method: defaultMethod, sent: ['method'] }, o));
  return v2Answer({ viewer, read, ev, defaultMethod });
}

adminProductsRoutes.get('/:id/pricing', limitRoute('pricing-read', 1200), async (c) => {
  c.header('Cache-Control', SESSION_CACHE_CONTROL);
  return c.json({ success: true, ...(await v2StoredAnswer(c, c.req.param('id'))) });
});

adminProductsRoutes.post('/pricing/preview', limitRoute('pricing-read', 1200), async (c) => {
  c.header('Cache-Control', SESSION_CACHE_CONTROL);
  const body = v2Body(await jsonObject(c), ['product_id', 'seq', 'structure', 'pricing']);
  const wire = parseV2Wire(body.pricing);
  const viewer = v2ViewerOf(c.env, c.get('user'));
  const db = c.env.DB;
  let read: V2Read;
  let draft = false;
  if (body.product_id === null || body.product_id === undefined) {
    // Add-product: the draft's structure is priced before the first save (its ids are the save's).
    if (body.structure === undefined || body.structure === null) throw inputInvalid('structure');
    const loaded = await previewDraft(c, body.structure, null);
    read = (await loadV2Read(db, loaded.id, loaded))!;
    draft = true;
  } else {
    if (typeof body.product_id !== 'string' || !body.product_id) throw inputInvalid('product_id');
    const stored = await v2ReadOf(c, body.product_id);
    if (body.structure === undefined || body.structure === null) read = stored;
    else {
      const loaded = await previewDraft(c, body.structure, { row: stored.loaded.row, loaded: stored.loaded });
      read = (await loadV2Read(db, loaded.id, loaded))!;
    }
  }
  const desired = desiredFor(read, wire, { viewer, env: c.env, user: c.get('user'), now: new Date().toISOString() });
  const ev = await evaluateDesired(read, desired);
  return c.json({ success: true, ...v2Answer({ viewer, read, ev, draft }) });
});

adminProductsRoutes.put('/:id/pricing', limitRoute('pricing-write', 600), async (c) => {
  c.header('Cache-Control', SESSION_CACHE_CONTROL);
  const db = c.env.DB;
  const id = c.req.param('id');
  const read = await v2ReadOf(c, id);
  const method = storedMethodOf(read);
  // A product's FIRST V2 write needs 0189's tables (a deploy ahead of its migration writes nothing).
  if (!method && !(await pricingV2Installed(db))) throw new HttpError(503, serverMessage('PRICING_NOT_INSTALLED'), 'PRICING_NOT_INSTALLED', { section: 3 });
  const body = v2Body(await jsonObject(c), ['seq', 'pricing', 'preview_hash', 'confirm_large_change']);
  if (body.confirm_large_change !== undefined && typeof body.confirm_large_change !== 'boolean') throw inputInvalid('confirm_large_change');
  const seq = v2Body(body.seq, ['inputs_seq', 'write_seq']);
  const whole = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  if (!whole(seq.inputs_seq) || !whole(seq.write_seq)) throw inputInvalid('seq');
  const wire = parseV2Wire(body.pricing);
  const viewer = v2ViewerOf(c.env, c.get('user'));
  const user = c.get('user')!;
  const now = new Date().toISOString();
  // §4.3 step 1 before step 2: a replay of a saved preview answers as the first save did.
  const pid = read.loaded.id;
  if ((seq.inputs_seq !== (read.stored.state?.inputs_seq ?? 0) || seq.write_seq !== (read.stored.state?.write_seq ?? 0))) {
    if (typeof body.preview_hash === 'string' && (await db.prepare('SELECT 1 AS hit FROM pricing_audit WHERE idempotency_key = ?').bind(v2PriceKey(pid, body.preview_hash)).first())) {
      return c.json({ success: true, already: true, ...(await v2StoredAnswer(c, pid)) });
    }
    throw new HttpError(409, serverMessage('PRICING_CHANGED'), 'PRICING_CHANGED', { section: 3 });
  }
  const desired = desiredFor(read, wire, { viewer, env: c.env, user, now });
  const ev = await evaluateDesired(read, desired);
  const verdict = await gateV2({
    c,
    ev,
    hash: body.preview_hash,
    confirm: body.confirm_large_change,
    priceChange: true,
    publishing: false,
    prices_only: true,
    preview: async () => v2Answer({ viewer, read, ev }),
  });
  if (verdict === 'already') return c.json({ success: true, already: true, ...(await v2StoredAnswer(c, pid)) });
  if (verdict === 'noop') return c.json({ success: true, unchanged: true, ...v2Answer({ viewer, read, ev }) });
  // Q3 (DECISIONS row 222): a price editor's publish below cost + minimum profit rings the owner in the same batch.
  const bell = verdict === 'data' ? [] : await belowMinProfitBell(c.env, ev, viewer, productNameOf(read.loaded.row));
  const opts = {
    actor: user.id,
    now,
    source: 'product_pricing',
    idempotencyKey: v2PriceKey(pid, ev.hash ?? newId()),
    // The clean start: a product's first complete V2 write retires its Direct Sale Extra and purchase overlay.
    ...(ev.kind === 'v2_create' ? { firstWrite: firstWriteStatements(db, read.stored, foldedReviewOf(read, viewer, user.id, now)) } : {}),
    ...(bell.length ? { extraAudits: bell } : {}),
  };
  const statements = verdict === 'data' ? await v2DataStatements(db, ev, opts) : await v2WriteStatements(db, ev, opts);
  if (statements.length > V2_PRICING_STATEMENT_CAP) throw new HttpError(409, serverMessage('PRICING_SET_TOO_LARGE'), 'PRICING_SET_TOO_LARGE', { section: 3 });
  try {
    await db.batch(statements);
  } catch (e) {
    const outcome = v2BatchOutcome(e);
    if (outcome === 'already') return c.json({ success: true, already: true, ...(await v2StoredAnswer(c, pid)) });
    if (outcome) throw outcome;
    const refusal = engineDbRefusal(e);
    if (refusal) throw refusal;
    throw e;
  }
  const slug = typeof read.loaded.row.slug === 'string' ? read.loaded.row.slug : null;
  if (slug) c.set('catalogueSlug', slug);
  return c.json({ success: true, already: false, saved: verdict === 'data' ? 'data' : 'prices', ...(await v2StoredAnswer(c, pid)) });
});

adminProductsRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  // THE PRODUCT AS IT ACTUALLY IS: the relational overlay, inactive rows
  // included, so `doc.options/colors/media` and the relations endpoint never
  // disagree on screen (docs/TXT_IMPORT_PARITY.md §5.3.1). A product with no
  // relational rows falls through to its JSON columns, exactly as before.
  const stored = await reloadForVerification(c.env.DB, id);
  if (!stored) throw notFound('Product not found');
  // A BUNDLE IS NOT EDITED HERE (docs/BUNDLES_MYSTERY.md §16). Its stock is
  // NULL by design, it has no options or colours of its own, and its price
  // rule lives in `bundle_config` — an editor that opened it would show a
  // product with no stock and then be refused by `planProductSave` on save.
  // The 409 names the panel that owns it instead.
  if (stored.row.composition !== '') throw compositionConflict(id, stored.row.slug);
  const pricingV2 = await productV2Flag(c.env.DB, id);
  return c.json({
    success: true,
    // §11: an assistant admin gets the same document with every financial
    // field removed on the SERVER — reading the raw response reveals nothing.
    // The clean start: a product still «يحتاج تسعيرًا» answers its old dinar prices EMPTY (archive only).
    product: projectForAdmin(c.env, c.get('user'), pricingV2.needs_pricing ? nullLegacyPricesDeep(stored.document) : stored.document),
    // Owner decision 8: the engine prices this product — its price cells are read only in the form
    // (a flag, not a cost: every admin may know it, and the old price writers refuse).
    engine_managed: await productEngineManaged(c.env.DB, id),
    // DI-2: the engine prices direct sale only; model, colour and pre-order prices stay editable.
    engine_direct_only: await productEngineDirectOnly(c.env.DB, id),
    // Pricing V2 (spec §5.1 as amended by addendum A.7): a flag, never a figure — every admin may know it.
    // `needs_pricing`: not V2-published (no method, or no complete V2 write yet), so no customer sees it.
    pricing_v2: pricingV2,
  });
});

/**
 * Create/update from a ProductDoc-ish body.
 *  - Slug stability: updates keep the stored slug unless allow_slug_change===true
 *    with an explicit slug; creates derive one from name_en (fallback name_ar).
 *  - Stale-edit: expected_updated_at mismatch → 409 with the current doc.
 *  - Persists ONLY the canonical PRODUCT_COLUMNS, so legacy v1 columns
 *    (brand text, categories, shipping_methods, stores, features, ...) are
 *    preserved, never overwritten.
 */
/**
 * The variant rows that carry their own price. Variants live only in the
 * relational table — there is no JSON mirror for them — so they need a read
 * of their own before the save response can honestly say how many rows will
 * ignore the new base price.
 */
async function relPriceRows(db: D1Database, productId: string, table: string) {
  const { results } = await db
    .prepare(
      `SELECT id, ${table === 'product_variants' ? 'combo_key AS name_en' : 'name_en'},
              regular_price_iqd, prime_price_iqd, pro_price_iqd, active
         FROM ${table} WHERE product_id = ?`
    )
    .bind(productId)
    .all<Record<string, unknown>>();
  return (results ?? []).map((r) => ({
    id: String(r.id),
    name_en: String(r.name_en ?? ''),
    active: Number(r.active) !== 0,
    regular_price_iqd: r.regular_price_iqd === null ? null : Number(r.regular_price_iqd),
    prime_price_iqd: r.prime_price_iqd === null ? null : Number(r.prime_price_iqd),
    pro_price_iqd: r.pro_price_iqd === null ? null : Number(r.pro_price_iqd),
  }));
}

/**
 * The pinned rows a base-price change would leave behind, counted ONCE.
 *
 * Options and colours live in two places: the JSON columns on `products` and
 * the relational tables. They are mirrors of each other, and the cart reads
 * the relational one when it exists (applyRelations in worker/lib/pricing's
 * callers). Counting both would tell the owner "4 options" for a product that
 * has two, so the relational store wins wherever it has rows and the JSON is
 * used only for products that never grew one.
 */
async function pinnedForProduct(db: D1Database, doc: { id: string; options?: unknown; colors?: unknown }) {
  const [relOptions, relColors, relVariants] = await Promise.all([
    relPriceRows(db, doc.id, 'product_option_values'),
    relPriceRows(db, doc.id, 'product_colors'),
    relPriceRows(db, doc.id, 'product_variants'),
  ]);
  return pinnedRows({
    options: (relOptions.length ? relOptions : (doc.options as never)) ?? null,
    colors: (relColors.length ? relColors : (doc.colors as never)) ?? null,
    variants: relVariants,
  });
}

adminProductsRoutes.post('/', async (c) => {
  const admin = c.get('user')!;
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') throw badRequest('JSON product document required');

  const existingRow =
    typeof body.id === 'string' && body.id
      ? await c.env.DB.prepare('SELECT * FROM products WHERE id = ?')
          .bind(body.id)
          .first<Record<string, unknown>>()
      : null;
  const prev = existingRow ? parseProductRow(existingRow) : null;
  // The same door as the GET above, on the write side: a composition row is
  // created and edited by the bundles panel alone. `planProductSave` refuses
  // it too (COMPOSITION_NOT_ALLOWED) — this answer is the one that can name
  // the panel and the slug.
  if (prev && prev.composition !== '') throw compositionConflict(prev.id, prev.slug);

  // THE CLEAN START (addendum A.6, DECISIONS row 222): no save types a dinar price. A legacy money
  // field the request leaves out keeps the stored value; one it carries must equal it; anything else
  // is 409 PRICING_V2_MANAGED {section, field}. Costs are judged only for an actor who may write them.
  const judgesCost = canWriteCost(c.env, admin) && !(prev !== null && body.cost_loaded === false);
  holdLegacyDocMoney(body, prev, { costs: judgesCost });

  const doc = validateProductDoc(body);

  // Product-level dimensions follow the same partial-update contract as the
  // selector rows: an omitted field preserves the stored measurement, while
  // an explicit null clears only that field. `validateProductDoc` accepts both
  // the form's nested `dimensions` object and the import/API flat shape, but
  // necessarily parses an absent value as null; carry omissions forward here
  // where the previous document is available.
  if (prev) {
    const nested = body.dimensions;
    const dimensionSource =
      nested && typeof nested === 'object' && !Array.isArray(nested)
        ? (nested as Record<string, unknown>)
        : body;
    for (const field of DIMENSION_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(dimensionSource, field)) {
        doc.dimensions[field] = prev.dimensions[field];
      }
    }
  }

  // §11 is an authorization rule in BOTH directions: nobody but the owner
  // reads cost or writes it (owner decision 2). A request that CARRIES a cost
  // value is refused — with the field NAMES, so the form can say which inputs
  // were refused, and never a value. The decision reads the request alone,
  // never the stored cost: refusing only a number that differs from it told
  // a non-owner when a guess was right.
  //
  // A FORM THAT NEVER SAW THE COST KEEPS IT (DECISIONS row 185 amendment of
  // 2026-10-08). `cost_loaded: false` says the editor read this document while
  // its session could not see cost — the owner before the address was
  // verified — so every cost it holds is a blank that means "not shown", not
  // "clear it". The owner can verify in another tab and come back to the same
  // form, now allowed to write cost; that save is written like an assistant's:
  // the stored product, option, colour, variant, order-type and route costs all
  // stay. The flag can only narrow what a save writes, never widen it.
  const costBlind = prev !== null && body.cost_loaded === false;
  const writesCost = canWriteCost(c.env, admin) && !costBlind;
  if (!canWriteCost(c.env, admin)) {
    const attempted = attemptedFinancialWrites(body);
    if (attempted.length) throw costRefusal(c.env, admin, { fields: attempted });
    // Carry the stored cost forward untouched so an assistant's save cannot
    // blank a value they were never shown.
    carryStoredCostForward(doc, prev);
  } else if (costBlind) {
    carryStoredCostForward(doc, prev);
  }

  // The stored ops_policy rides along under the two device fields the form
  // edits, so a save from a client that never saw size_class cannot erase it.
  if (prev) doc.ops_policy = { ...prev.ops_policy, ...doc.ops_policy };

  // §29 (serial scan, 0178): whether a product needs a serial at preparation
  // — and gets a warranty unit at delivery — is the OWNER's, on a create as
  // on an update (S1 review #1), whichever key carries it (`serialized`, or
  // `ops_policy.serialized`). Only a CHANGE of the effective answer is an
  // attempt: the form echoes the stored value on every save, and that must
  // keep working for any admin — but an echo of an INHERITED answer is not
  // written down as the product's own (S1 review #4). RE-FILING a product
  // whose own word is silent is the same change by another door (critique-1
  // #23): its answer comes from its placement. One rule for every product
  // door: `serializedWriteVerdict`.
  let answerGuard: SerialAnswerFence | null = null;
  if (!isOwner(c.env, admin)) {
    const recategorised = !prev || doc.category_id !== prev.category_id || doc.sub_category_id !== prev.sub_category_id;
    const sentCatalogs = Array.isArray(body.catalog_ids)
      ? (body.catalog_ids as unknown[]).filter((x): x is string => typeof x === 'string')
      : null;
    const verdict = await serializedWriteVerdict(c.env.DB, {
      prev: prev ? { id: prev.id, ops_policy: prev.ops_policy } : null,
      requested: readOpsWarranty(mergeOpsPolicy(doc.ops_policy ?? {}, { serialized: doc.serialized })).serialized,
      placement:
        sentCatalogs || recategorised
          ? {
              catalogIds: sentCatalogs ?? (prev ? await catalogIdsFor(c.env.DB, prev.id) : []),
              categoryIds: [doc.category_id, doc.sub_category_id],
            }
          : undefined,
    });
    if (verdict.refuse) throw serialRefuse(403, 'OWNER_ONLY', { field: 'serialized', via: verdict.refuse });
    doc.serialized = verdict.keep;
    if (verdict.keep === null) delete doc.ops_policy.serialized;
    else doc.ops_policy.serialized = verdict.keep;
    // …and the save re-checks the stored product's answer inside its batch
    // (round 4 R2): a flag, placement or word changed since these reads
    // cannot make this save flip it. A create has no answer to keep.
    if (prev) answerGuard = await serialAnswerFence(c.env.DB, { productId: prev.id });
  }

  // THE SAME GUARD FOR THE CONDITION DOCUMENT.
  //
  // `validateProductDoc` reads `body.condition` and an absent key parses to
  // null, which means NEW — so a panel that predates open-box listings, or any
  // client that sends a partial document, would silently turn a graded unit
  // back into a new one and take its warranty length and no-return rule with
  // it. Omitting the key keeps what is stored; sending `condition: null`
  // explicitly is how a listing is deliberately un-graded.
  if (prev && !('condition' in body)) doc.condition = prev.condition;
  // «الصورة الرئيسية للوضع الفاتح» (0138), the same rule: a client that never
  // heard of the field keeps the stored picture; `light_image: ''` removes it.
  if (prev && !('light_image' in body)) doc.light_image = prev.light_image ?? '';

  // EXTENDED WARRANTY IS FOR PRINTERS (owner mandate). The catalog placement
  // this save states — or, when it states none, the stored one — decides:
  // a non-printer carrying plans is refused, a printer's plans must be the
  // +12 / +24 extensions, and a printer is defaulted to serialized with a
  // 12-month base so its delivered units can record 24/36 months.
  await applyPrinterWarrantyRules(
    c.env.DB,
    doc,
    Array.isArray(body.catalog_ids) ? (body.catalog_ids as unknown[]).filter((x): x is string => typeof x === 'string') : undefined
  );

  // Stale-edit protection: the editor echoes the updated_at it loaded.
  if (prev && typeof body.expected_updated_at === 'string' && body.expected_updated_at) {
    const currentUpdated = existingRow?.updated_at ? String(existingRow.updated_at) : '';
    if (body.expected_updated_at !== currentUpdated) {
      return c.json(
        {
          success: false,
          code: 'STALE_EDIT',
          error: 'This product was modified by someone else since you opened it. Review the current version below.',
          current: projectForAdmin(c.env, admin, {
            ...projectAdmin(prev),
            catalog_ids: await catalogIdsFor(c.env.DB, prev.id),
            printer_fit_ids: await loadPrinterFitIds(c.env.DB, prev.id),
          }),
        },
        409
      );
    }
  }

  // Slug stability.
  if (prev) {
    if (body.allow_slug_change === true && typeof body.slug === 'string' && slugToken(body.slug)) {
      const want = slugToken(body.slug);
      if (want !== prev.slug) {
        const clash = await c.env.DB.prepare('SELECT id FROM products WHERE slug = ? AND id <> ?')
          .bind(want, doc.id)
          .first();
        if (clash) throw badRequest('slug: already used by another product', 'SLUG_TAKEN');
      }
      doc.slug = want;
    } else {
      doc.slug = prev.slug; // links stay stable no matter what the body says
    }
  } else {
    const base =
      slugToken(doc.name_en) || slugToken(doc.name_ar) || `product-${doc.id.replace(/^prd_/, '').slice(0, 8)}`;
    doc.slug = await uniqueSlugIn(c.env.DB, 'products', base, null);
  }

  // §3: English in, ar/ckb generated locally — except the copies a human
  // wrote (a TXT-imported Arabic description, an approved translation), which
  // survive as long as their English source is unchanged. Mutates the doc in
  // place BEFORE serialization, so the row that gets written already carries
  // the generated text and the storefront needs no runtime translation.
  //
  // TRANSLATIONS THE ADMIN TYPED. §3 forbids inventing prose, so a description
  // written as sentences — or an English box filled in Arabic — can only be
  // made correct by a human writing the Arabic and Kurdish copies. This is the
  // channel that carries them; everything else is still generated locally.
  const overrides = readTranslationOverrides(body.translation_overrides);
  const localized = localizeRespectingAuthored(doc, prev, overrides);
  applyTranslationTracking(doc, prev, localized.review_needed);

  // ONE CONTRACT, ONE BATCH. The row, the catalog placement, the price-history
  // rows, the hashtag vocabulary, the translation rows and — when the client
  // sends them — the relations all land together or not at all
  // (worker/lib/productPersistence.ts). A body without `relations` leaves the
  // relation tables exactly as they are: the form still PUTs them separately.
  const relations =
    body.relations && typeof body.relations === 'object' && !Array.isArray(body.relations)
      ? (body.relations as Record<string, unknown>)
      : null;
  await holdLegacyRelationMoney(c.env.DB, prev?.id ?? null, relations, { costs: judgesCost });

  // PRICING V2-3b (spec §3.5, §4.1): a V2 product's save — or a save with a `pricing_v2` block: a
  // product created V2 from birth, or an existing product's FIRST V2 write (the clean start, DECISIONS
  // row 222, addendum A.7) — writes its structure INSIDE the V2 writer's batch, with its prices. The
  // price fields of the document are not the client's: the stored ladder stays until the V2 writer
  // replaces it in the same batch, and no route carries a commission. A bundle is never V2-priced (Q7).
  const v2Block = body.pricing_v2;
  const v2Sent = v2Block !== undefined && v2Block !== null;
  if (v2Sent && (doc.composition ?? '') !== '') {
    throw new HttpError(409, serverMessage('COMPOSITION_NOT_PRICEABLE'), 'COMPOSITION_NOT_PRICEABLE', { section: 3 });
  }
  const v2Stored = prev ? await productEngineV2(c.env.DB, prev.id) : false;
  const v2Installed = v2Stored || (await pricingV2Installed(c.env.DB));
  // A database before 0189 (a deploy ahead of its migration) has nowhere to put a V2 product's prices.
  if (v2Sent && !v2Installed) {
    throw new HttpError(503, serverMessage('PRICING_NOT_INSTALLED'), 'PRICING_NOT_INSTALLED', { section: 3 });
  }
  // The clean start (A.6): EVERY ordinary product save is a V2 save. A product with no method and no
  // `pricing_v2` block (a description edit of a product still in the «يحتاج تسعيرًا» queue) saves its
  // structure only, under the price token, and stays hidden until its first complete V2 write.
  const v2Save = (doc.composition ?? '') === '' && v2Installed;
  const structureOnly = v2Save && !v2Stored && !v2Sent;
  pinV2PriceFields(doc, prev);

  const saveIntent: ProductWriteIntent = {
    mode: prev ? 'update' : 'create',
    doc,
    prev,
    relations,
    catalogIds: Array.isArray(body.catalog_ids)
      ? (body.catalog_ids as unknown[]).filter((x): x is string => typeof x === 'string')
      : undefined,
    // 0148 — «يناسب الطابعات». Absent = the links stay exactly as they are,
    // so a client that never heard of the field cannot clear them.
    printerFits: Array.isArray(body.printer_fit_ids)
      ? (body.printer_fit_ids as unknown[]).filter((x): x is string => typeof x === 'string')
      : undefined,
    actor: { adminId: admin.id, money: writesCost },
    translations: localized.fields,
    // V2 writes its own SKU-level price history (the V2 batch); the document's ladder is pinned.
    ...(v2Save ? { priceHistory: false } : {}),
  };

  // The media verifier protects every accepted object in D1. Reject the
  // complete product/relations shape while this request is still read-only,
  // so an invalid binding cannot leave a guard behind for a product that was
  // never saved. The authoritative media metadata below changes bound values,
  // therefore the disposable preflight plan is rebuilt afterwards.
  try {
    await preflightProductSave(c.env.DB, saveIntent);
  } catch (e) {
    if (e instanceof HttpError && e.code === 'RELATIONS_VALIDATION') {
      const errors = Array.isArray(e.details?.errors) ? (e.details!.errors as string[]) : [e.message];
      return c.json({ success: false, code: 'VALIDATION', errors }, 400);
    }
    throw e;
  }

  // A `/files/<key>.webp` string is only an address-shaped claim. Prove every
  // caller-supplied object and replace its duplicate metadata with the facts
  // read from R2/decoded bytes BEFORE the planner binds INSERT/UPDATE values.
  // Malformed/non-array relation collections are left to the planner so they
  // keep returning the ordinary RELATIONS_VALIDATION response.
  try {
    if (relations) {
      const images = relations.images;
      if (
        Array.isArray(images) &&
        images.length <= 400 &&
        images.every((image) => !!image && typeof image === 'object' && !Array.isArray(image))
      ) {
        await normalizeVerifiedProductMedia(
          c.env,
          images as Array<Record<string, unknown>>,
          'r2_key'
        );
      }
    } else {
      await normalizeVerifiedProductMedia(
        c.env,
        doc.media as unknown as Array<Record<string, unknown>>,
        'key'
      );
    }
  } catch (error) {
    throwProductMediaVerificationError(error);
  }

  let plan;
  try {
    plan = await planProductSave(c.env.DB, saveIntent);
  } catch (e) {
    if (e instanceof HttpError && e.code === 'RELATIONS_VALIDATION') {
      const errors = Array.isArray(e.details?.errors) ? (e.details!.errors as string[]) : [e.message];
      return c.json({ success: false, code: 'VALIDATION', errors }, 400);
    }
    throw e;
  }

  if (answerGuard) plan.statements = answerGuard.around(plan.statements);
  // PRICING V2-3b: the V2 gates, then one batch — the planner's statements inside the V2 writer's.
  let v2Outcome: V2SaveOutcome | null = null;
  if (structureOnly) {
    v2Outcome = {
      kind: 'data',
      priced: false,
      statements: v2StructureStatements(c.env.DB, doc.id, {
        structure: plan.statements,
        newProduct: !prev,
        updatedAt: existingRow?.updated_at === undefined || existingRow?.updated_at === null ? null : String(existingRow.updated_at),
      }),
    };
    plan.statements = v2Outcome.statements;
  } else if (v2Save) {
    v2Outcome = await planV2ProductSave(c, {
      plan,
      prev,
      updatedAt: existingRow?.updated_at === undefined || existingRow?.updated_at === null ? null : String(existingRow.updated_at),
      block: v2Block,
      status: doc.status,
    });
    if (v2Outcome.kind === 'already') {
      const current = await reloadForVerification(c.env.DB, doc.id);
      c.set('catalogueSlug', doc.slug);
      return c.json({ success: true, already: true, created: false, product: current ? projectForAdmin(c.env, admin, current.document) : null });
    }
    plan.statements = v2Outcome.statements;
  }
  try {
    await saveProductAtomic(c.env.DB, plan, [
      {
        action: prev ? 'product_v2.update' : 'product_v2.create',
        detail: {
          name_en: doc.name_en,
          slug: doc.slug,
          status: doc.status,
          // No price in the audit detail: a product still «يحتاج تسعيرًا» carries only its old dinar price here
          // (review 2026-10-14); a V2 price is recorded by the pricing audit, never in audit_log.
          content_rev: doc.content_rev,
        },
      },
    ]);
  } catch (e) {
    if (answerGuard && isLostRace(e)) throw serialRefuse(409, 'SERIAL_FILING_CHANGED');
    if (v2Outcome) {
      const outcome = v2BatchOutcome(e);
      if (outcome === 'already') {
        const current = await reloadForVerification(c.env.DB, doc.id);
        return c.json({ success: true, already: true, created: false, product: current ? projectForAdmin(c.env, admin, current.document) : null });
      }
      if (outcome) throw outcome;
      const refusal = engineDbRefusal(e);
      if (refusal) throw refusal;
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('UNIQUE') && msg.includes('slug')) throw badRequest('slug: already used by another product', 'SLUG_TAKEN');
    // The race backstop for the named SKU check in `planProductSave` — the
    // same answer the TXT path gives, so neither surface says «Something went
    // wrong» for a duplicate SKU.
    if (msg.includes('UNIQUE') && msg.includes('products.sku')) {
      throw badRequest('sku: already used by another product / رمز المنتج مستخدم في منتج آخر', 'SKU_TAKEN');
    }
    throw e;
  }
  const translationWarning: string | null = null;
  const priceHistoryWarning: string | null = null;

  // THE BASE PRICE MOVED, BUT NOT EVERYTHING MOVED WITH IT.
  //
  // An option, colour or variant that carries its own regular price REPLACES
  // the base (worker/lib/pricing.ts), so a base-price edit leaves those rows
  // exactly where they were and the cart keeps charging the old number while
  // the storefront headline shows the new one. That is not a bug in the cart —
  // it re-prices on every read — and it is not something to fix by rewriting
  // prices the owner typed on purpose. It is something they have to be TOLD,
  // with the count and the rows, so they can decide. The form asks; every
  // other client at least learns that it happened.
  let pinnedAfterPriceChange: { from: number; to: number; count: number; rows: PinnedPriceRow[] } | null = null;
  if (prev && typeof prev.price_iqd === 'number' && prev.price_iqd !== doc.price_iqd) {
    const rows = await pinnedForProduct(c.env.DB, doc);
    if (rows.length) {
      pinnedAfterPriceChange = { from: prev.price_iqd, to: doc.price_iqd, count: rows.length, rows };
    }
  }

  const stored = await reloadForVerification(c.env.DB, doc.id);
  c.set('catalogueSlug', doc.slug); // the product page is purged with the listing
  return c.json({
    success: true,
    created: !prev,
    product: projectForAdmin(c.env, admin, stored!.document),
    ...(plan.relations ? { relations: plan.relations.summary } : {}),
    ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
    ...(pinnedAfterPriceChange ? { pinned_prices: pinnedAfterPriceChange } : {}),
    // Named honestly rather than hidden behind a green tick: these fields kept
    // their English text because the local engine could not translate them
    // safely (§3). The product is saved and live either way.
    translation_review_needed: localized.review_needed,
    // The same fields WITH the reason each one could not be translated, so the
    // form can say "this is Arabic in the English box" instead of listing 66
    // opaque keys under a sentence that was not even true.
    translation_review: localized.review_details,
    ...(priceHistoryWarning ? { price_history_warning: priceHistoryWarning } : {}),
    ...(translationWarning ? { translation_warning: translationWarning } : {}),
    // V2-3b: whether this save wrote prices (`priced`) or stored its data only (incomplete).
    ...(v2Outcome && 'priced' in v2Outcome && !structureOnly ? { pricing_v2: { priced: v2Outcome.priced } } : {}),
  });
});

/**
 * MOVE THE PINNED PRICES — retired by the clean start (addendum A.6, DECISIONS
 * row 222): no dinar price is typed or moved any more; a product's prices are
 * its V2 write's. Refused for every product (a stale admin bundle gets the
 * sentence and the section), deleted with the V1 doors in V2-7.
 */
adminProductsRoutes.post('/:id/reprice', async () => {
  throw v2Managed(3);
});

/**
 * DELETE, IN TWO HONEST MODES.
 *
 * WITHOUT `?permanent=true` — the historical behaviour, unchanged: a product
 * named by a past order is hidden rather than removed, because that is the
 * conservative thing to do when an admin presses a plain Delete.
 *
 * WITH `?permanent=true` — the owner's "حذف نهائي". The product and EVERY row
 * that exists only to describe it are deleted; order history is kept and its
 * product link nulled; the product's own R2 objects are removed unless another
 * product still references them. What the response reports is measured, not
 * asserted: `rows_deleted_by_table` comes from each statement's `meta.changes`,
 * and `r2_objects_deleted` lists the keys the bucket actually accepted.
 *
 * PRESSING IT TWICE IS NOT AN ERROR. The second call finds no product and
 * answers `already_deleted: true` with a 200 — an admin who did not see the
 * first response must not be shown a 500.
 */
/**
 * RUN THE DELETE AND, IF IT FAILS, SAY WHAT FAILED.
 *
 * A destructive admin action that answers "Something went wrong. Please try
 * again." is telling the owner to repeat an action that will fail again, for a
 * reason only the logs hold — and the owner does not have the logs. That is
 * what the screenshot showed, three times in a row.
 *
 * So the database's own words are carried out, trimmed, under a stable code.
 * They are not a leak: an admin is already authorised to read every row this
 * could name, the message is a schema fact rather than customer data, and the
 * alternative is a shop whose owner cannot delete a product and cannot find out
 * why.
 */
async function deleteOrExplain(
  db: D1Database,
  id: string,
  newIdFn: () => string
): Promise<Awaited<ReturnType<typeof deleteProductPermanently>>> {
  try {
    return await deleteProductPermanently(db, id, { newId: newIdFn });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error(`product delete failed for ${id}:`, reason);
    throw new HttpError(
      500,
      `تعذّر حذف المنتج: ${reason.slice(0, 300)} / could not delete the product: ${reason.slice(0, 300)}`,
      'DELETE_FAILED',
      { reason: reason.slice(0, 300) }
    );
  }
}

/**
 * THE HALF THAT RUNS AFTER THE COMMIT, AND CANNOT UNDO IT.
 *
 * The rows are gone by the time these run. An R2 call, a cache purge or an
 * audit insert that throws here would surface as "delete failed" for a product
 * that is already deleted — the worst possible answer, because the owner then
 * presses the button again on an id that no longer exists.
 *
 * The exact jobs run through the global guarded cleanup, so a non-product
 * reference (banner, immutable order snapshot, invoice, merchant page, …)
 * can veto the R2 delete after the product transaction commits.
 */
async function afterCommit(
  c: Context<AppContext>,
  adminId: string,
  id: string,
  result: Awaited<ReturnType<typeof deleteProductPermanently>>,
  action: string
): Promise<{
  deleted: string[];
  shared: string[];
  failed: Array<{ key: string; error: string }>;
  invalidated: string[];
  warnings: string[];
}> {
  const warnings: string[] = [];
  let cleanup: { deleted: string[]; shared: string[]; failed: Array<{ key: string; error: string }> } = {
    deleted: [],
    shared: [],
    failed: [],
  };
  try {
    cleanup = await runGuardedMediaCleanupJobs(c.env, result.media_jobs);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('media cleanup threw after a committed delete:', msg);
    warnings.push(`media cleanup: ${msg.slice(0, 200)}`);
    cleanup.failed = result.media_jobs.map((job) => ({ key: job.key, error: msg.slice(0, 400) }));
  }
  let invalidated: string[] = [];
  try {
    invalidated = await invalidateMediaCache(new URL(c.req.url).origin, cleanup.deleted);
  } catch (e) {
    console.error('cache invalidation threw after a committed delete:', e instanceof Error ? e.message : String(e));
  }
  try {
    await audit(c.env.DB, adminId, action, id, {
      rows_deleted_by_table: result.rows_deleted_by_table,
      rows_unlinked_by_table: result.rows_unlinked_by_table,
      r2_objects_deleted: cleanup.deleted.length,
      r2_objects_shared_skipped: result.r2_objects_shared_skipped.length + cleanup.shared.length,
      r2_cleanup_pending: cleanup.failed.length,
    });
  } catch (e) {
    // An audit row is a record of something that already happened. Losing it is
    // worth a log line, never worth telling the owner their delete failed.
    console.error('audit row failed after a committed delete:', e instanceof Error ? e.message : String(e));
    warnings.push('audit row not written');
  }
  return {
    deleted: cleanup.deleted,
    shared: cleanup.shared,
    failed: cleanup.failed,
    invalidated,
    warnings,
  };
}

adminProductsRoutes.delete('/:id', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const permanent = /^(1|true|yes)$/i.test(c.req.query('permanent') ?? '');

  const row = await c.env.DB.prepare('SELECT id, name_ar, name, slug FROM products WHERE id = ?')
    .bind(id)
    .first<Record<string, unknown>>();
  if (typeof row?.slug === 'string') c.set('catalogueSlug', row.slug); // its cached page goes with it

  if (!row) {
    // Idempotency, and only for the permanent path: a plain Delete on a
    // missing id is still a 404, because nothing claims to have removed it.
    if (permanent) {
      return c.json({
        success: true,
        permanent: true,
        already_deleted: true,
        product_deleted: false,
        rows_deleted_by_table: {},
        rows_unlinked_by_table: {},
        r2_objects_deleted: [],
        r2_objects_shared_skipped: [],
        r2_cleanup_pending: 0,
        cache_keys_invalidated: [],
      });
    }
    throw notFound('Product not found');
  }

  // A MEMBER OF A BUNDLE IS NEVER DELETED SILENTLY.
  // `bundle_components.member_product_id` is ON DELETE RESTRICT on purpose, so
  // the raw delete below would fail on a foreign key with a message no admin
  // can read. This names the bundles instead — one indexed read through
  // idx_bundle_components_member.
  const usedBy = await bundlesUsing(c.env.DB, id);
  if (usedBy.length) {
    throw new HttpError(
      409,
      `هذا المنتج مكوّن في ${usedBy.length} حزمة / this product is a component of ${usedBy.length} bundle(s): ${usedBy
        .map((b) => b.name)
        .join(', ')}`,
      'COMPOSITION_PRODUCT',
      { bundles: usedBy }
    );
  }

  if (permanent) {
    const result = await deleteOrExplain(c.env.DB, id, () => newId('mcj'));
    if (result.blocked) {
      throw new HttpError(409, result.blocked.remedy, result.blocked.code, {
        table: result.blocked.table,
        count: result.blocked.count,
      });
    }

    // R2 AFTER THE COMMIT, NEVER INSIDE IT. A bucket failure here leaves a
    // pending job, not a half-deleted product — and never a failed response for
    // a delete that already happened.
    const after = await afterCommit(c, admin.id, id, result, 'product_v2.delete_permanent');
    const invalidated = after.invalidated;
    const shared = [...new Set([...result.r2_objects_shared_skipped, ...after.shared])];

    return c.json({
      ...(after.warnings.length ? { warnings: after.warnings } : {}),
      success: true,
      permanent: true,
      already_deleted: false,
      product_deleted: result.product_deleted,
      rows_deleted_by_table: result.rows_deleted_by_table,
      rows_unlinked_by_table: result.rows_unlinked_by_table,
      media_keys_found: result.media_keys_found,
      r2_objects_deleted: after.deleted,
      r2_objects_shared_skipped: shared,
      r2_cleanup_pending: after.failed.length,
      ...(after.failed.length ? { r2_cleanup_errors: after.failed } : {}),
      cache_keys_invalidated: invalidated,
    });
  }

  const ref = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM order_items WHERE product_id = ?')
    .bind(id)
    .first<{ n: number }>();
  const refs = ref?.n ?? 0;

  if (refs > 0) {
    await c.env.DB.prepare(
      "UPDATE products SET status = 'hidden', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    )
      .bind(id)
      .run();
    await audit(c.env.DB, admin.id, 'product_v2.archive', id, { order_item_refs: refs });
    return c.json({
      success: true,
      archived: true,
      deleted: false,
      order_item_refs: refs,
      reason: 'Referenced by past orders — hidden instead of deleted.',
    });
  }

  // No order history: the same engine, so a plain Delete leaves no residue
  // either. It is only the ARCHIVE decision above that differs between modes.
  const result = await deleteOrExplain(c.env.DB, id, () => newId('mcj'));
  if (result.blocked) {
    throw new HttpError(409, result.blocked.remedy, result.blocked.code, {
      table: result.blocked.table,
      count: result.blocked.count,
    });
  }
  const after = await afterCommit(c, admin.id, id, result, 'product_v2.delete');
  const invalidated = after.invalidated;
  const shared = [...new Set([...result.r2_objects_shared_skipped, ...after.shared])];
  return c.json({
    ...(after.warnings.length ? { warnings: after.warnings } : {}),
    success: true,
    archived: false,
    deleted: true,
    product_deleted: result.product_deleted,
    rows_deleted_by_table: result.rows_deleted_by_table,
    rows_unlinked_by_table: result.rows_unlinked_by_table,
    r2_objects_deleted: after.deleted,
    r2_objects_shared_skipped: shared,
    r2_cleanup_pending: after.failed.length,
    ...(after.failed.length ? { r2_cleanup_errors: after.failed } : {}),
    cache_keys_invalidated: invalidated,
  });
});

/** Replace this product's catalog placements with exactly catalog_ids. */
adminProductsRoutes.put('/:id/catalogs', async (c) => {
  const admin = c.get('user')!;
  const id = c.req.param('id');
  const existingRow = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!existingRow) throw notFound('Product not found');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!Array.isArray(body.catalog_ids)) throw badRequest('catalog_ids must be an array of catalog ids');
  const prevDoc = parseProductRow(existingRow);
  // §29 (0178): a placement that changes whether the product needs a serial
  // is the owner's — judged on the reads, and fenced in the write (round 4 R2).
  const guard = isOwner(c.env, admin)
    ? null
    : await refuseSerializedDrift(
        c.env.DB,
        prevDoc,
        (body.catalog_ids as unknown[]).filter((x): x is string => typeof x === 'string'),
        [prevDoc.category_id, prevDoc.sub_category_id]
      );
  // The placement alone, through the same contract as every other write.
  const plan = await planProductSave(c.env.DB, {
    mode: 'update',
    doc: null,
    prev: prevDoc,
    relations: null,
    catalogIds: (body.catalog_ids as unknown[]).filter((x): x is string => typeof x === 'string'),
    actor: { adminId: admin.id, money: canWriteCost(c.env, admin) },
  });
  if (guard) plan.statements = guard.around(plan.statements);
  try {
    await saveProductAtomic(c.env.DB, plan, [{ action: 'product_v2.catalogs', detail: { catalog_ids: plan.catalogIds ?? [] } }]);
  } catch (e) {
    if (guard && isLostRace(e)) throw serialRefuse(409, 'SERIAL_FILING_CHANGED');
    throw e;
  }
  return c.json({ success: true, catalog_ids: await catalogIdsFor(c.env.DB, id) });
});

/**
 * Admin price preview: full resolver output INCLUDING cost fields, plus a
 * USD preview at THE SHOP'S rate, never the wallet's `exchangeRate` (owner
 * decision 9: 1,400 is the wallet's own rate). WHICH shop rate depends on who
 * asks (DECISIONS row 220): the OWNER reads the APPLIED USD/IQD the prices are
 * built at (`getAppliedUsdRate` — market + his adjustment, or the rate he
 * typed), so the dollar figure is the dollar price he set, as it always was;
 * every other admin reads the PUBLIC market figure customers read dollars at
 * (`getDisplayUsdRate`) — beside it the applied rate would be the adjustment.
 * Before the owner approves a first USD/IQD value `usd_preview` is null.
 * `tier` may be supplied to preview what a member of that tier would pay
 * (server data only otherwise).
 */
adminProductsRoutes.post('/:id/quote', async (c) => {
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!row) throw notFound('Product not found');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  // THE PREVIEW PRICES WHAT THE CUSTOMER WOULD PAY, which means reading the
  // product the way the cart reads it: the relational option/colour/variant
  // rows win over the JSON mirrors on `products` wherever they exist. Without
  // this, the one screen the owner uses to check a price was the one screen
  // reading the other store — so a mirror that had drifted showed the owner a
  // number no customer would ever be charged.
  const relations = await loadRelationsView(c.env.DB, String(row.id), row.inventory_mode);
  const doc = relations ? applyRelations(parseProductRow(row), relations) : parseProductRow(row);
  const tier: Tier =
    body.tier === 'plus' || body.tier === 'pro' || body.tier === 'prime' ? body.tier : 'free';

  const owner = canViewCost(c.env, c.get('user'));
  const [settings, displayRate] = await Promise.all([
    getSettings(c.env.DB, ['proPricingPolicy', 'preorderTransportDefaults']),
    owner ? getAppliedUsdRate(c.env.DB) : getDisplayUsdRate(c.env.DB),
  ]);
  // FX-7 (0183): the WHOLE selection, one value per option group, names the exact SKU whose stored
  // engine price the cart charges — ordered as the cart orders it (the model first). A product
  // priced per colour or variant previewed with its first group alone would show the ladder beneath
  // the rung: the model's HIGHEST SKU. Bounded and string-only; an absent list is `[optionId]`.
  const optionValueIds = Array.isArray(body.optionValueIds)
    ? optionValueIdsInRelationOrder(body.optionValueIds.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 120).slice(0, 12), relations)
    : [];
  const optionId = optionValueIds[0] ?? (typeof body.optionId === 'string' && body.optionId ? body.optionId : null);
  const resolved = resolveUnitPrice({
    product: doc,
    optionId,
    ...(optionValueIds.length ? { optionValueIds } : {}),
    colorId: typeof body.colorId === 'string' && body.colorId ? body.colorId : null,
    transportMethod: typeof body.transportMethod === 'string' ? body.transportMethod : null,
    warrantyPlanId: typeof body.warrantyPlanId === 'string' && body.warrantyPlanId ? body.warrantyPlanId : null,
    tier,
    tierActive: tier !== 'free', // admin preview assumes the previewed tier is active
    proPolicy: proPolicyFrom(settings.proPricingPolicy),
    transportDefaults: transportDefaultsFrom(settings.preorderTransportDefaults),
  });

  // Exact, floored to the cent as the storefront reads it; null without a shop rate.
  const toUsd = (iqd: number, rate: string): number | null => {
    const cents = iqdToUsdCentsAtRate(iqd, rate);
    return cents === null ? null : cents / 100;
  };
  const applied = displayRate === null ? null : toUsd(resolved.applied_iqd, displayRate);
  const subtotal = displayRate === null ? null : toUsd(resolved.unit_subtotal_iqd, displayRate);

  // §11: cost is financial data. An assistant admin gets the same quote with
  // it removed — the check is here, on the server, not in the panel.
  const quoteResolved = owner
    ? resolved
    : { ...resolved, cost_iqd: undefined };
  return c.json({
    success: true,
    quote: {
      ...quoteResolved,
      usd_preview:
        displayRate !== null && applied !== null && subtotal !== null
          ? { exchange_rate_iqd_per_usd: displayRate, applied_usd: applied, unit_subtotal_usd: subtotal }
          : null,
    },
  });
});
