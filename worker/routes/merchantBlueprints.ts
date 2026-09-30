/**
 * «التخصيص · Customization · خۆگونجاندن» — THE MERCHANT'S BLUEPRINT BUILDER
 * DOORS (Programme C, phase C1; docs/LEVO_PROJECT_PROGRAMME.md §B.1 hop 1,
 * §B.2 items 1–6, §B.8; the builder UI is src/components/merchant/catalog/
 * blueprint/**, behind ONE lazy door in ProductEditorSheet).
 *
 *   GET  /api/merchant/products/:id/blueprint           the builder's state
 *   PUT  /api/merchant/products/:id/blueprint/model     {keys: string[1..12]}
 *   GET  /api/merchant/products/:id/blueprint/mesh      the full draft mesh (?rev=)
 *   PUT  /api/merchant/products/:id/blueprint/draft     {spec, rev?}
 *   PUT  /api/merchant/products/:id/blueprint/look      {poster, idmap, quads, camera}
 *   POST /api/merchant/products/:id/blueprint/publish   {rev}
 *   POST /api/merchant/products/:id/blueprint/pause
 *
 * THE GATES, on every door: the caller's OWN store with its selling
 * privileges (`requireSellingPrivileges` — the builder is a selling tool), the
 * switch or a pilot list for this store (a platform admin may always build),
 * the owner's `customizableProducts` entitlement — else 404
 * PERSONALIZATION_UNAVAILABLE: the door does not exist for them — and the
 * product: the caller's own (404 otherwise), not private and not archived
 * (409 BLUEPRINT_PRODUCT_INELIGIBLE). Every answer is the merchant's own:
 * private, no-store.
 *
 * MOUNTED at /api/merchant beside the catalogue router, WITHOUT a `'*'`
 * middleware: Hono runs a router's `'*'` middleware for every path under its
 * mount, so one here would run for the whole of /api/merchant. The two path
 * middlewares below cover exactly this router's paths. The catalogue router's
 * own `'*'` purge (worker/lib/edgePolicy.ts `purgeStorefrontAfterWrite`)
 * already drops the store's cached pages after every successful write here;
 * a publish and a pause also drop the product's blueprint read and page on
 * every host (`afterBlueprintWrite`).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { badRequest, int, notFound, requireAuth } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { requireSellingPrivileges, type StoreContext } from '../lib/merchantAuth';
import { getMediaObject } from '../lib/mediaStorage';
import { getSetting } from '../lib/settings';
import { getTierStatus, hasEntitlement } from '../lib/entitlements';
import { builderOpen, customizationSettings, personalizationUnavailable, type CustomizationConfig } from '../lib/personalize/access';
import {
  afterBlueprintWrite,
  analysisOf,
  attachSource,
  eligibleProduct,
  loadRevisions,
  partsOf,
  pause,
  productRow,
  publish,
  readiness,
  retiredHistory,
  revisionOut,
  saveDraft,
  saveLook,
  specOf,
  suggestionsFor,
  type BlueprintProduct,
} from '../lib/personalize/blueprints';
import { buildPreviewBlueprint } from '../lib/personalize/publicSpec';
import { MESH_CONTENT_TYPE } from '../lib/personalize/compile';

export const merchantBlueprintRoutes = new Hono<AppContext>();
merchantBlueprintRoutes.use('/products/:id/blueprint', requireAuth);
merchantBlueprintRoutes.use('/products/:id/blueprint/*', requireAuth);

interface Builder {
  ctx: StoreContext;
  cfg: CustomizationConfig;
  product: BlueprintProduct;
}

/**
 * The gates (see the header), in the order that says the least to a stranger:
 * the selling privileges, then the switch and the entitlement (the one 404 of
 * `assertBuilderOpen`), then the product. What does not depend on the store —
 * the switch, the caller's tier, the product row — is read in the same wave.
 */
async function builder(c: Context<AppContext>): Promise<Builder> {
  const db = c.env.DB;
  const [ctx, cfg, tier, row] = await Promise.all([
    requireSellingPrivileges(c),
    customizationSettings(db),
    getTierStatus(db, c.get('user')!.id),
    productRow(db, c.req.param('id') ?? ''),
  ]);
  // The store is the caller's own (requireStoreOwner), so the caller's tier is the owner's.
  if (!builderOpen(c, cfg, ctx.store.id) || !hasEntitlement(tier, 'customizableProducts')) throw personalizationUnavailable();
  return { ctx, cfg, product: eligibleProduct(row, ctx.merchant.id) };
}

/**
 * THE BUILDER'S STATE — every door answers it, so the screen never re-reads:
 * the draft and the live revision (the merchant's own spec with its private
 * notes, the part NAMES, the mesh door, the look card), the retired history
 * (the newest 20, `retired_more` when there are older ones),
 * the compile's warnings and what a publish still needs (machine words the
 * builder says in ar/en/ckb), suggestions (a role per part from its name;
 * grams of plastic per size), and the studio preview of the draft.
 */
async function builderState(c: Context<AppContext>, b: Builder) {
  const db = c.env.DB;
  const [revs, history, media, materials] = await Promise.all([
    loadRevisions(db, b.product.id),
    retiredHistory(db, b.product.id),
    db.prepare('SELECT id, media_key AS key FROM community_product_media WHERE product_id = ?1 ORDER BY position, id').bind(b.product.id).all<{ id: string; key: string }>(),
    getSetting(db, 'printMaterials'),
  ]);
  const current = revs.draft ?? revs.live ?? revs.latest;
  const spec = current ? specOf(current) : null;
  const parts = current ? partsOf(current) : [];
  const warnings: string[] = [];
  if (current) {
    const a = analysisOf(current);
    if (current.mesh_state === 'failed') warnings.push('MESH_FAILED', ...(a.hint ? [`HINT_${a.hint.toUpperCase()}`] : []));
    for (const w of a.warnings ?? []) warnings.push(w);
    if (current.state === 'draft') for (const m of await readiness(current, spec)) warnings.push(`NEEDS_${m.toUpperCase()}`);
  }
  const densities = new Map<string, number>();
  for (const m of (materials as unknown as Array<Record<string, unknown>>) ?? []) {
    if (m && typeof m.id === 'string') densities.set(m.id, Number(m.density_g_cm3) || 1.24);
  }
  const list = media.results ?? [];
  return {
    success: true,
    product_id: b.product.id,
    draft: revs.draft ? revisionOut(revs.draft, list) : null,
    live: revs.live ? revisionOut(revs.live, list) : null,
    retired: history.items,
    retired_more: history.more,
    mesh_state: current?.mesh_state ?? 'none',
    parts,
    warnings,
    suggestions: suggestionsFor(parts, spec, densities),
    preview: await buildPreviewBlueprint(db, revs.draft ?? revs.live, {
      product: {
        ...b.product,
        lifecycle: b.product.publish_state === 'published' ? 'active' : b.product.publish_state,
        status: b.product.publish_state === 'published' ? 'active' : 'hidden',
        audience_user_id: null,
      },
      store: b.ctx.store,
      merchant: b.ctx.merchant,
    }).catch(() => null),
    limits: { max_triangles: b.cfg.max_triangles, max_blueprints_per_store: b.cfg.max_blueprints_per_store, source_files: 12 },
  };
}

const privateJson = (c: Context<AppContext>, body: unknown, status: 200 | 201 = 200) => {
  const res = c.json(body as Record<string, unknown>, status);
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
};

merchantBlueprintRoutes.get('/products/:id/blueprint', async (c) => {
  const b = await builder(c);
  return privateJson(c, await builderState(c, b));
});

/** The model: 1–12 of the merchant's own `product_file` uploads, compiled inline (worker/lib/personalize/blueprints.ts `attachSource`). */
merchantBlueprintRoutes.put('/products/:id/blueprint/model', async (c) => {
  await rateLimit(c, 'blueprint-derive', 20, 3600);
  const b = await builder(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const keys = body.keys;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 12 || !keys.every((k) => typeof k === 'string' && k.length >= 5 && k.length <= 300)) {
    throw badRequest('Send the keys of 1 to 12 of your uploaded model files', 'BLUEPRINT_INVALID', { path: 'keys', errors: [{ path: 'keys', code: 'INVALID' }] });
  }
  await attachSource(c.env.DB, c.env, { ctx: b.ctx, product: b.product, keys: keys as string[], cfg: b.cfg, actorId: c.get('user')!.id });
  return privateJson(c, await builderState(c, b));
});

/**
 * The merchant's own FULL mesh of a revision (the draft by default; `?rev=`
 * another) — every part, hidden ones included — as stored: gzip, which the
 * studio's loader inflates. Never a public URL (the draft key is private).
 */
merchantBlueprintRoutes.get('/products/:id/blueprint/mesh', async (c) => {
  await rateLimit(c, 'blueprint-mesh', 600, 3600);
  const b = await builder(c);
  const revRaw = c.req.query('rev');
  const rev = revRaw ? int(revRaw, 'rev', { min: 1, max: 1_000_000 }) : null;
  const revs = await loadRevisions(c.env.DB, b.product.id, { rev });
  const row = rev !== null ? revs.all.find((r) => r.rev === rev) : revs.draft ?? revs.live ?? revs.latest;
  if (!row?.draft_mesh_key) throw notFound('No model yet');
  const object = await getMediaObject(c.env, 'private', row.draft_mesh_key);
  if (!object) throw notFound('No model yet');
  const bytes = new Uint8Array(await object.arrayBuffer());
  return new Response(bytes, {
    headers: {
      'Content-Type': MESH_CONTENT_TYPE,
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
});

/** The draft: {spec, rev?} — normalised and checked against this product, this store's parts, the catalogue and the printers. */
merchantBlueprintRoutes.put('/products/:id/blueprint/draft', async (c) => {
  await rateLimit(c, 'blueprint-write', 120, 3600);
  const b = await builder(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const rev = body.rev === undefined || body.rev === null ? null : int(body.rev, 'rev', { min: 1, max: 1_000_000 });
  await saveDraft(c.env.DB, { ctx: b.ctx, product: b.product, raw: body.spec, rev, cfg: b.cfg, actorId: c.get('user')!.id });
  return privateJson(c, await builderState(c, b));
});

/** The look card the builder captured from the draft: {poster (base64 ≤ 400 KB), idmap (base64 ≤ 8 KB), quads, camera}. */
merchantBlueprintRoutes.put('/products/:id/blueprint/look', async (c) => {
  await rateLimit(c, 'blueprint-write', 120, 3600);
  const b = await builder(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  await saveLook(c.env.DB, c.env, { ctx: b.ctx, product: b.product, body, actorId: c.get('user')!.id });
  return privateJson(c, await builderState(c, b));
});

/** Publish {rev}: the draft (or a paused revision, as it was) goes live — strict, readiness, the public mesh, one fenced batch. */
merchantBlueprintRoutes.post('/products/:id/blueprint/publish', async (c) => {
  await rateLimit(c, 'blueprint-publish', 30, 3600);
  const b = await builder(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const rev = int(body.rev, 'rev', { min: 1, max: 1_000_000 });
  await publish(c.env.DB, c.env, { ctx: b.ctx, product: b.product, rev, cfg: b.cfg, actorId: c.get('user')!.id });
  await afterBlueprintWrite(c, b.ctx.store, b.product);
  return privateJson(c, await builderState(c, b));
});

/** Pause: the live revision retires — customers stop seeing the personalisation; the revision is kept (a second press is a no-op). */
merchantBlueprintRoutes.post('/products/:id/blueprint/pause', async (c) => {
  await rateLimit(c, 'blueprint-publish', 30, 3600);
  const b = await builder(c);
  if (await pause(c.env.DB, { ctx: b.ctx, product: b.product, actorId: c.get('user')!.id })) await afterBlueprintWrite(c, b.ctx.store, b.product);
  return privateJson(c, await builderState(c, b));
});
