/**
 * FILES ON PRODUCTS (docs/COMMUNITY_ECOSYSTEM.md §9.4 "Files on products").
 *
 * Two routers in one file because they are two sides of one table:
 *
 *   merchantProductFileRoutes   /api/merchant/products/:id/files[…]
 *       the store owner attaches, renames, re-roles, reorders and removes the
 *       files of a product of THEIR store (requireStoreOwner + the product's
 *       merchant_id). A key is accepted only when `file_objects` says it is
 *       the owner's own PRIVATE upload with purpose product_file
 *       (worker/lib/fileOwnership.ts).
 *
 *   publicProductFileRoutes     /api/product-files/:slug/:productId[…]
 *       what a shopper sees: the files BY ROLE, as names and sizes, never a
 *       key and never a URL to the bytes; a viewer link for a `preview` file;
 *       and the download door, which opens only for a buyer holding a
 *       `product_file_grants` row (written by the store checkout's own batch,
 *       worker/routes/storeOrders.ts) or for the store owner.
 *
 * WHY ITS OWN PREFIX AND NOT /api/storefront: the storefront router is served
 * session-free (worker/lib/session.ts `sessionFreePublicGet`) so the colo can
 * cache it for guests. The viewer-token and download doors need to know who
 * is asking, so they live where the session is read; the list is wrapped in
 * `anonymousCached` itself, `perViewer` because a signed-in buyer's rows say
 * `granted`.
 *
 * THE ANSWERS A STRANGER GETS ARE ALL THE SAME. A file of a product this store
 * does not show is a 404; a download by a guest is a 404; a download by an
 * account that never bought a product the shopfront SHOWS is a 403
 * PRODUCT_FILE_NOT_GRANTED (that product page is public, so "you have not
 * bought this" reveals nothing); once the product is hidden or archived the
 * same account gets the list's 404 again, so a file id never says whether a
 * withdrawn product still exists. A buyer's grant outlives the hide.
 *
 * WHO IS A BUYER: an account holding a LIVE grant on any file of the product
 * (worker/lib/fileOwnership.ts `hasProductGrant`) — live meaning not expired
 * and not paid for by an order that was since cancelled and refunded. The
 * `preview` role is never granted (it is never downloadable), so the buyer's
 * `full` viewer token on it and its `granted: true` in the list come from the
 * grants on the product's other files.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { HttpError, badRequest, conflict, int, notFound, requireAuth, str } from '../lib/http';
import { newId } from '../lib/crypto';
import { rateLimit } from '../lib/ratelimit';
import { audit } from '../lib/audit';
import { requireStoreOwner, type StoreContext } from '../lib/merchantAuth';
import { anonymousCached, originOf, purgeAnonymousCache } from '../lib/edgePolicy';
import { rootDomainFrom, storeUrl } from '../lib/hosts';
import { getMediaObject } from '../lib/mediaStorage';
import { privateProductsReady } from '../lib/privateProducts';
import {
  GRANTED_ROLES,
  PRODUCT_FILES_MAX,
  PRODUCT_FILE_ROLES,
  activeGrant,
  attachmentResponse,
  hasProductGrant,
  liveGrantSql,
  ownedFileObject,
  type ProductFileRole,
} from '../lib/fileOwnership';
import {
  deriveModelPreview,
  mintViewerGrant,
  revokeProductFileViewerGrantsStatement,
  viewerSessionInput,
} from '../lib/viewerGrants';
import { servableStoreBySlug } from './storefront';

const nowIso = () => new Date().toISOString();

interface ProductFileRow {
  id: string;
  product_id: string;
  store_id: string;
  file_key: string;
  role: string;
  name: string;
  bytes: number;
  mime: string;
  kind: string;
  analysis: string | null;
  preview_key: string;
  position: number;
  created_at: string;
}

/** The public shape: no key, no URL to the bytes, no analysis JSON. */
function publicFile(f: ProductFileRow) {
  return {
    id: f.id,
    role: f.role as ProductFileRole,
    name: f.name,
    bytes: Number(f.bytes ?? 0),
    kind: f.kind,
    has_preview: !!f.preview_key,
  };
}

/** The owner's shape: the public one plus what the editor sends back. */
function ownerFile(f: ProductFileRow) {
  return {
    ...publicFile(f),
    file_key: f.file_key,
    mime: f.mime,
    position: Number(f.position ?? 0),
    created_at: f.created_at,
  };
}

async function listFiles(db: D1Database, productId: string): Promise<ProductFileRow[]> {
  const { results } = await db
    .prepare('SELECT * FROM product_files WHERE product_id = ? ORDER BY position, created_at, id')
    .bind(productId)
    .all<ProductFileRow>();
  return results ?? [];
}

// =========================================================== the merchant side

export const merchantProductFileRoutes = new Hono<AppContext>();
merchantProductFileRoutes.use('*', requireAuth);

/** The product, of THIS store, or a 404 that says nothing about other stores' products. */
async function ownProduct(c: Context<AppContext>, ctx: StoreContext): Promise<{ id: string; slug: string }> {
  const id = str(c.req.param('id'), 'id', { min: 1, max: 64 });
  const p = await c.env.DB.prepare('SELECT id, slug FROM community_products WHERE id = ? AND merchant_id = ? AND store_id = ?')
    .bind(id, ctx.merchant.id, ctx.store.id)
    .first<{ id: string; slug: string }>();
  if (!p) throw notFound('Product not found');
  return p;
}

/**
 * The guest-cached list of this product's files is dropped wherever the
 * shopfront is served — the request's host, the store's own host and the
 * root domain (the same three `afterStorefrontWrite` purges).
 */
async function purgeProductFiles(c: Context<AppContext>, ctx: StoreContext, productId: string): Promise<void> {
  const root = rootDomainFrom(c.env);
  const origins = new Set<string>([originOf(c)]);
  const own = storeUrl(ctx.store.slug, root, ctx.store.id);
  if (/^https?:\/\//.test(own)) origins.add(new URL(own).origin);
  if (root) origins.add(`https://${root}`);
  const path = `/api/product-files/${encodeURIComponent(ctx.store.slug)}/${encodeURIComponent(productId)}`;
  await Promise.all([...origins].map((o) => purgeAnonymousCache(o, [path])));
}

merchantProductFileRoutes.get('/products/:id/files', async (c) => {
  const ctx = await requireStoreOwner(c);
  const p = await ownProduct(c, ctx);
  const files = await listFiles(c.env.DB, p.id);
  return c.json({ success: true, files: files.map(ownerFile), max: PRODUCT_FILES_MAX });
});

/** Attach an uploaded file. The key must be the owner's own private `product_file` upload. */
merchantProductFileRoutes.post('/products/:id/files', async (c) => {
  await rateLimit(c, 'product-file-write', 120, 3600);
  const ctx = await requireStoreOwner(c);
  const p = await ownProduct(c, ctx);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const role = readRole(body.role);
  const key = str(body.file_key, 'file_key', { min: 5, max: 200 });
  const owned = await ownedFileObject(c.env.DB, key, ctx.store.user_id, ['product_file']);
  if (!owned) throw badRequest('That file is not one of your uploads', 'PRODUCT_FILE_NOT_OWNED');
  const existing = await listFiles(c.env.DB, p.id);
  if (existing.length >= PRODUCT_FILES_MAX) {
    throw conflict(`A product carries at most ${PRODUCT_FILES_MAX} files`, 'PRODUCT_FILE_LIMIT');
  }
  // The same object attached twice is the same row: idempotent for a retried tap.
  const dup = existing.find((f) => f.file_key === owned.key);
  if (dup) return c.json({ success: true, file: ownerFile(dup), replayed: true });

  const name = str(body.name, 'name', { min: 0, max: 120, required: false }) || owned.original_name || owned.key.split('/').pop() || 'file';
  const position = body.position === undefined ? existing.length : int(body.position, 'position', { min: 0, max: 1000 });
  const id = newId('pf');
  // A model gets its mesh now, best effort (worker/lib/viewerGrants.ts).
  const preview = owned.kind === 'model'
    ? await deriveModelPreview(c.env, {
        fileKey: owned.key, name, previewKey: `product-previews/${p.id}/${id}.lvm`,
        domain: 'merchants', ownerId: ctx.store.user_id, entityId: p.id,
      })
    : { preview_key: '', analysis: null };
  await c.env.DB.prepare(
    `INSERT INTO product_files (id, product_id, store_id, file_key, role, name, bytes, mime, kind, analysis, preview_key, position, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      id, p.id, ctx.store.id, owned.key, role, name, owned.bytes, owned.mime, owned.kind,
      preview.analysis ? JSON.stringify(preview.analysis) : null, preview.preview_key, position, nowIso()
    )
    .run();
  await audit(c.env.DB, ctx.store.user_id, 'merchant.product_file_added', id, { product: p.id, role, kind: owned.kind });
  await purgeProductFiles(c, ctx, p.id);
  const file = await c.env.DB.prepare('SELECT * FROM product_files WHERE id = ?').bind(id).first<ProductFileRow>();
  return c.json({ success: true, file: ownerFile(file!) }, 201);
});

/** Reorder: the ids in the order they should read. Ids not of this product are ignored, never moved. */
merchantProductFileRoutes.put('/products/:id/files/order', async (c) => {
  await rateLimit(c, 'product-file-write', 120, 3600);
  const ctx = await requireStoreOwner(c);
  const p = await ownProduct(c, ctx);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const raw = Array.isArray(body.ids) ? body.ids : [];
  const ids = [...new Set(raw.filter((x): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x)))];
  if (!ids.length || ids.length > PRODUCT_FILES_MAX) throw badRequest('Send the file ids in their new order', 'PRODUCT_FILE_ORDER_INVALID');
  await c.env.DB.batch(
    ids.map((fid, i) =>
      c.env.DB.prepare('UPDATE product_files SET position = ? WHERE id = ? AND product_id = ? AND store_id = ?').bind(i, fid, p.id, ctx.store.id)
    )
  );
  await purgeProductFiles(c, ctx, p.id);
  const files = await listFiles(c.env.DB, p.id);
  return c.json({ success: true, files: files.map(ownerFile) });
});

merchantProductFileRoutes.patch('/products/:id/files/:fid', async (c) => {
  await rateLimit(c, 'product-file-write', 120, 3600);
  const ctx = await requireStoreOwner(c);
  const p = await ownProduct(c, ctx);
  const fid = str(c.req.param('fid'), 'fid', { min: 1, max: 64 });
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.role !== undefined) {
    sets.push('role = ?');
    vals.push(readRole(body.role));
  }
  if (body.name !== undefined) {
    sets.push('name = ?');
    vals.push(str(body.name, 'name', { min: 1, max: 120 }));
  }
  if (body.position !== undefined) {
    sets.push('position = ?');
    vals.push(int(body.position, 'position', { min: 0, max: 1000 }));
  }
  if (!sets.length) throw badRequest('Nothing to update');
  const res = await c.env.DB.prepare(`UPDATE product_files SET ${sets.join(', ')} WHERE id = ? AND product_id = ? AND store_id = ?`)
    .bind(...vals, fid, p.id, ctx.store.id)
    .run();
  if (!res.meta.changes) throw new HttpError(404, 'File not found', 'PRODUCT_FILE_NOT_FOUND');
  // A file that stops being a `preview` stops being previewable through the links it had.
  if (body.role !== undefined && body.role !== 'preview') {
    await revokeProductFileViewerGrantsStatement(c.env.DB, [fid], nowIso()).run();
  }
  await audit(c.env.DB, ctx.store.user_id, 'merchant.product_file_updated', fid, { product: p.id, fields: sets.map((s) => s.split(' ')[0]) });
  await purgeProductFiles(c, ctx, p.id);
  const file = await c.env.DB.prepare('SELECT * FROM product_files WHERE id = ?').bind(fid).first<ProductFileRow>();
  return c.json({ success: true, file: ownerFile(file!) });
});

/**
 * Remove a file. Its grants go with it (CASCADE) — a buyer's right to a file
 * the merchant withdrew is the merchant's own decision, as the spec has it:
 * grants are per file row. The object itself stays in R2 for the ledger's
 * orphan sweep; nothing here deletes bytes.
 */
merchantProductFileRoutes.delete('/products/:id/files/:fid', async (c) => {
  await rateLimit(c, 'product-file-write', 120, 3600);
  const ctx = await requireStoreOwner(c);
  const p = await ownProduct(c, ctx);
  const fid = str(c.req.param('fid'), 'fid', { min: 1, max: 64 });
  const [, del] = await c.env.DB.batch([
    revokeProductFileViewerGrantsStatement(c.env.DB, [fid], nowIso()),
    c.env.DB.prepare('DELETE FROM product_files WHERE id = ? AND product_id = ? AND store_id = ?').bind(fid, p.id, ctx.store.id),
  ]);
  if (!del.meta.changes) throw new HttpError(404, 'File not found', 'PRODUCT_FILE_NOT_FOUND');
  await audit(c.env.DB, ctx.store.user_id, 'merchant.product_file_removed', fid, { product: p.id });
  await purgeProductFiles(c, ctx, p.id);
  return c.json({ success: true });
});

function readRole(v: unknown): ProductFileRole {
  if (typeof v !== 'string' || !(PRODUCT_FILE_ROLES as readonly string[]).includes(v)) {
    throw badRequest(`role must be one of: ${PRODUCT_FILE_ROLES.join(', ')}`, 'PRODUCT_FILE_ROLE_INVALID');
  }
  return v as ProductFileRole;
}

// ============================================================ the public side

export const publicProductFileRoutes = new Hono<AppContext>();

interface VisibleProduct {
  ctx: StoreContext;
  product: { id: string; slug: string; owner_id: string; published: boolean };
}

/**
 * The store, servable, and the product as the shopfront shows it — the same
 * `lifecycle = 'active' AND status = 'active'` rule storefront.ts applies,
 * plus 0152's private products, which only their one customer may see. The
 * store owner sees their own product in every state (they are looking at
 * their own editor's preview). `allowUnpublished` lets a caller decide the
 * hidden case itself (the download door: a buyer's grant outlives a hide);
 * `published` says which case it is.
 *
 * ONE WAVE, not two: the store and the product are read in parallel (the
 * product by its id, its `store_id` checked against the store afterwards),
 * so a shopper's read costs one dependent round trip less from a far primary.
 */
async function visibleProduct(c: Context<AppContext>, opts: { allowUnpublished?: boolean } = {}): Promise<VisibleProduct> {
  const slug = str(c.req.param('slug'), 'slug', { min: 1, max: 64 });
  const productId = str(c.req.param('productId'), 'productId', { min: 1, max: 64 });
  const viewer = c.get('user') ?? null;
  const [ctx, p] = await Promise.all([
    servableStoreBySlug(c.env.DB, slug),
    privateProductsReady(c.env.DB).then((privateReady) =>
      c.env.DB.prepare(
        `SELECT id, slug, store_id, lifecycle, status, ${privateReady ? 'audience_user_id' : 'NULL AS audience_user_id'}
           FROM community_products WHERE id = ?`
      )
        .bind(productId)
        .first<{ id: string; slug: string; store_id: string; lifecycle: string; status: string; audience_user_id: string | null }>()
    ),
  ]);
  if (!p || p.store_id !== ctx.store.id) throw notFound('Product not found');
  const owner = !!viewer && viewer.id === ctx.store.user_id;
  const published = p.lifecycle === 'active' && p.status === 'active';
  if (!owner && !opts.allowUnpublished && !published) throw notFound('Product not found');
  if (!owner && p.audience_user_id && (!viewer || viewer.id !== p.audience_user_id)) throw notFound('Product not found');
  return { ctx, product: { id: p.id, slug: p.slug, owner_id: ctx.store.user_id, published } };
}

async function productFile(db: D1Database, productId: string, fidRaw: unknown): Promise<ProductFileRow> {
  const fid = str(fidRaw, 'fid', { min: 1, max: 64 });
  const f = await db.prepare('SELECT * FROM product_files WHERE id = ? AND product_id = ?').bind(fid, productId).first<ProductFileRow>();
  if (!f) throw new HttpError(404, 'File not found', 'PRODUCT_FILE_NOT_FOUND');
  return f;
}

/**
 * The files by role. Never a key, never a URL to the bytes. For a signed-in
 * non-owner the viewer's live grants ride in the SAME statement as the files
 * (one wave), and «bought» — a live grant on any file of the product — marks
 * the preview row `granted` too: its viewer link then opens the full mesh.
 */
publicProductFileRoutes.get('/:slug/:productId', (c) => anonymousCached(c, { perViewer: true }, async () => {
  const { product } = await visibleProduct(c);
  const viewer = c.get('user') ?? null;
  const owner = !!viewer && viewer.id === product.owner_id;
  const askGrants = !!viewer && !owner;
  const { results } = await c.env.DB.prepare(
    `SELECT f.*, ${askGrants
      ? `EXISTS (SELECT 1 FROM product_file_grants g WHERE g.product_file_id = f.id AND g.user_id = ?2 AND ${liveGrantSql('g', '?3')})`
      : '0'} AS granted
       FROM product_files f WHERE f.product_id = ?1 ORDER BY f.position, f.created_at, f.id`
  )
    .bind(product.id, ...(askGrants ? [viewer!.id, nowIso()] : []))
    .all<ProductFileRow & { granted: number }>();
  const files = results ?? [];
  const bought = owner || files.some((f) => !!f.granted);
  return c.json({
    success: true,
    files: files.map((f) => ({
      ...publicFile(f),
      /** May THIS viewer download it now: the owner always, a buyer with a grant, never a guest. */
      downloadable: f.role !== 'preview' && (owner || !!f.granted),
      /** Does THIS viewer hold the file — the owner, or a buyer with a live grant (the preview row too: its viewer link then opens the full mesh). */
      granted: owner || !!f.granted || (f.role === 'preview' && bought),
    })),
  });
}));

/**
 * A viewer link for a `preview` file: 60 minutes, bound to the signed-in
 * viewer or to the guest's session hash. The store owner and a buyer holding
 * a grant on the file get the stored mesh; everyone else the coarse one.
 */
publicProductFileRoutes.post('/:slug/:productId/:fid/viewer-token', async (c) => {
  await rateLimit(c, 'viewer-token', 60, 3600);
  const { product } = await visibleProduct(c);
  const viewer = c.get('user') ?? null;
  const f = await productFile(c.env.DB, product.id, c.req.param('fid'));
  if (f.role !== 'preview') throw new HttpError(403, 'Only a preview file can be viewed', 'VIEWER_NOT_ALLOWED');
  if (!f.preview_key) throw conflict('This file has no 3D preview', 'NO_PREVIEW');
  const owner = !!viewer && viewer.id === product.owner_id;
  // «`full` for owner/buyer» (§4d): a buyer holds a live grant on the
  // product's OTHER files — the preview role itself is never granted.
  const bought = viewer && !owner ? await hasProductGrant(c.env.DB, product.id, viewer.id) : false;
  const minted = await mintViewerGrant(c.env.DB, {
    sourceType: 'product',
    sourceId: f.id,
    fileKey: f.file_key,
    grant: owner || bought ? 'full' : 'preview',
    user: viewer,
    session: viewerSessionInput(c),
  });
  return c.json({ success: true, ...minted });
});

/**
 * THE DOWNLOAD. A guest is told nothing (404); a signed-in account without a
 * grant is told why (403) while the product is on the shopfront, and gets the
 * list's own 404 once it is hidden or archived (a withdrawn product's file
 * ids are nobody's to probe); a buyer — or the owner — gets the bytes as an
 * attachment with `nosniff` and the sandboxing CSP, counted on their grant
 * and logged. The product need not still be published for THEM: a purchase
 * outlives a hide (grants are per file row; the merchant removes the file to
 * withdraw it). A grant whose order was cancelled and refunded is not live
 * (`activeGrant`), so a refunded buyer is a non-buyer again.
 */
publicProductFileRoutes.get('/:slug/:productId/:fid/download', async (c) => {
  const viewer = c.get('user') ?? null;
  if (!viewer) throw new HttpError(404, 'File not found', 'PRODUCT_FILE_NOT_FOUND');
  await rateLimit(c, 'product-file-download', 120, 3600);
  const { product } = await visibleProduct(c, { allowUnpublished: true });
  const f = await productFile(c.env.DB, product.id, c.req.param('fid'));
  const owner = viewer.id === product.owner_id;
  if (f.role === 'preview' && !owner) throw new HttpError(404, 'File not found', 'PRODUCT_FILE_NOT_FOUND');
  const grant = owner ? null : await activeGrant(c.env.DB, f.id, viewer.id);
  if (!owner && !grant) {
    if (!product.published) throw new HttpError(404, 'File not found', 'PRODUCT_FILE_NOT_FOUND');
    throw new HttpError(403, 'This file is available after purchase', 'PRODUCT_FILE_NOT_GRANTED');
  }
  const object = await getMediaObject(c.env, 'private', f.file_key);
  if (!object) throw new HttpError(404, 'The stored file is no longer available', 'PRODUCT_FILE_NOT_FOUND');
  if (grant) {
    await c.env.DB.prepare('UPDATE product_file_grants SET downloads = downloads + 1 WHERE id = ?').bind(grant.id).run();
  }
  await audit(c.env.DB, viewer.id, 'product_file.downloaded', f.id, { product: product.id, role: f.role, owner });
  return attachmentResponse(object, f.name, f.mime, f.bytes);
});

/** For the tests and the handoff: the roles a purchase opens. */
export { GRANTED_ROLES };
