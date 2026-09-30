/**
 * THE CUSTOMER'S PERSONALISATION DOORS — /api/personalize (Programme C, phase
 * C1; docs/LEVO_PROJECT_PROGRAMME.md §0 rows 3, 27 and 28, §B.1 hops 1–3,
 * P2, P5, P6, P11, P13).
 *
 *   GET  /status                   {on, may_use, may_build, cart, create, social} — per viewer
 *   GET  /blueprints/:productId    PublicBlueprint (?rev= a published revision) — guests too
 *   POST /configs                  {product_id, configuration} → a configuration minted
 *   GET  /configs/:id              the owner's configuration with its live price and check
 *   GET  /assets/<key>             the owner's own design picture, inline
 *
 * ONE PREFIX, OUTSIDE /api/community: these are commerce doors, and a store
 * host keeps selling personalised products while the community is closed
 * (§0 row 28). Creation and social doors (C4, C12) mount their own
 * `requireCommunityOpen` route by route.
 *
 * DARK BY DEFAULT (§B.8, P13): while `customizationConfig` is off every door
 * answers 404 PERSONALIZATION_UNAVAILABLE — at once for a signed-in reader
 * and for every write; a platform admin and the product's own merchant may
 * PREVIEW (a signed-in answer: `private, no-store`, never in the edge cache).
 * A guest's blueprint read is edge-cached with the declared params ['rev']
 * and the lifetime 60/60/60, so a colo that did not take the switch's write
 * keeps its stored 200 for at most two minutes.
 *
 * NOTHING HERE IS A PRICE THE CLIENT CHOSE (P1): the configuration carries
 * ids and words; the unit is the engine's, from the live rows.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppContext } from '../lib/types';
import { isPlatformAdmin, notFound, requireAuth } from '../lib/http';
import { rateLimit } from '../lib/ratelimit';
import { anonymousCached, type EdgeLifetime } from '../lib/edgePolicy';
import { ownedFileObject } from '../lib/fileOwnership';
import { getMediaObject } from '../lib/mediaStorage';
import { sniffImageBytes } from '../lib/imageConvert';
import {
  customizationSettings,
  personalizationStateFor,
  personalizationUnavailable,
  type CustomizationConfig,
} from '../lib/personalize/access';
import { loadBlueprintHead, productOnShelf, projectBlueprint, type BlueprintHead } from '../lib/personalize/publicSpec';
import { configOf, judge, mintConfig, optionNames, ownConfig, wordsFrom, type ConfigWords } from '../lib/personalize/configs';
import { loadOwnerTerms } from '../lib/decency';
import type { PublicBlueprint } from '@levonis/catalog/personalize/types';

export const personalizeRoutes = new Hono<AppContext>();

/** P13: a guest's cached blueprint read outlives a switch-off by at most s-maxage + swr = two minutes. */
export const PERSONALIZE_LIFETIME: EdgeLifetime = { maxAge: 60, sMaxAge: 60, staleWhileRevalidate: 60 };
/** The only query parameter the blueprint read's edge key reads. */
export const BLUEPRINT_READ_PARAMS: readonly string[] = ['rev'];

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `?rev=` → a revision number, null when absent, false when it names nothing (the door's 404). */
function readRev(raw: string | undefined): number | null | false {
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 && n <= 1_000_000 ? n : false;
}

/**
 * THE ONE DECISION every product door makes: the switch (or a pilot list) for
 * this store and viewer, or a preview by a platform admin / the product's own
 * merchant; never a private or archived product; for anyone but a previewer,
 * a product on the shelf of a store taking orders. Everything else is the one
 * 404 — dark, paused, private, closed: the door says nothing about which.
 */
async function readable(
  c: Context<AppContext>,
  cfg: CustomizationConfig,
  head: BlueprintHead | null
): Promise<{ blueprint: PublicBlueprint; preview: boolean; head: BlueprintHead }> {
  if (!head) throw personalizationUnavailable();
  const user = c.get('user');
  const admin = isPlatformAdmin(c);
  const own = !!user && user.id === head.store.user_id;
  const previewer = admin || own;
  const state = personalizationStateFor(cfg, { userId: user?.id ?? null, admin, storeId: head.store.id, productMerchantUserId: head.store.user_id });
  if (!state.may_use) throw personalizationUnavailable();
  if (head.product.audience_user_id || head.product.publish_state === 'archived') throw personalizationUnavailable();
  // Off the shelf: 404 before the second wave for anyone but a previewer.
  const onShelf = productOnShelf(head);
  if (!previewer && !onShelf) throw personalizationUnavailable();
  const out = await projectBlueprint(c.env.DB, head);
  if (!out) throw personalizationUnavailable();
  if (!previewer && !out.takingOrders) throw personalizationUnavailable();
  // A preview is whatever a customer would not see right now: dark here, off the shelf, or a store not selling.
  return { blueprint: out.blueprint, preview: state.preview || (previewer && (!onShelf || !out.takingOrders)), head };
}

// ------------------------------------------------------------------ status

/**
 * What this viewer may do: the switch (`on` — `enabled`, or a pilot list
 * naming them), the studio (`may_use`: on, or an admin's preview), the
 * builder (`may_build`: they own a store its switch opens — the entitlement
 * is /api/merchant/me.can.customize's), and the later switches. Per viewer:
 * the guest answer is edge-cached (one entry, `Vary: Cookie` for the
 * browser); purged in the writing colo by the settings write
 * (`pathsChangedBySetting('customizationConfig')`).
 */
personalizeRoutes.get('/status', (c) =>
  anonymousCached(c, { perViewer: true, lifetime: PERSONALIZE_LIFETIME }, async () => {
    const user = c.get('user');
    const [, cfg, store] = await Promise.all([
      rateLimit(c, 'personalize-read', 600, 3600),
      customizationSettings(c.env.DB),
      user ? c.env.DB.prepare('SELECT id FROM merchant_stores WHERE user_id = ?1').bind(user.id).first<{ id: string }>() : Promise.resolve(null),
    ]);
    const s = personalizationStateFor(cfg, { userId: user?.id ?? null, admin: isPlatformAdmin(c), ownStoreId: store?.id ?? null });
    return c.json({ success: true, on: s.on, may_use: s.may_use, may_build: s.may_build, cart: s.cart, create: s.create, social: s.social });
  })
);

// --------------------------------------------------------- the blueprint

/**
 * THE PUBLIC BLUEPRINT of a product: its live revision, or `?rev=` one that
 * was published (a paused product's revision still renders the cart line
 * that named it; without `rev` a paused product is 404). Two D1 waves:
 * the revision ⋈ product ⋈ store beside the switch, then the variants, the
 * shelf, the parts, the printer and the owner's plan (worker/lib/personalize/
 * publicSpec.ts). A preview answers `preview: true`, private, no-store.
 */
personalizeRoutes.get('/blueprints/:productId', (c) =>
  anonymousCached(c, { params: BLUEPRINT_READ_PARAMS, lifetime: PERSONALIZE_LIFETIME }, async () => {
    const productId = c.req.param('productId');
    const rev = readRev(c.req.query('rev'));
    if (!ID.test(productId) || rev === false) throw personalizationUnavailable();
    const [, cfg, head] = await Promise.all([
      rateLimit(c, 'personalize-read', 600, 3600),
      customizationSettings(c.env.DB),
      loadBlueprintHead(c.env.DB, productId, rev),
    ]);
    const out = await readable(c, cfg, head);
    const res = c.json({ success: true, preview: out.preview, blueprint: out.blueprint });
    if (c.get('user')) res.headers.set('Cache-Control', 'private, no-store');
    return res;
  })
);

// ------------------------------------------------------- configurations

/**
 * MINT A CONFIGURATION: {product_id, configuration} — the customer's
 * choices as ids and words, validated strictly against the LIVE revision,
 * the owner's pictures, decency and the check (worker/lib/personalize/
 * configs.ts `mintConfig`). Equal choices by the same owner answer the same
 * id (200); a new one is 201. Private, no-store.
 */
personalizeRoutes.post('/configs', requireAuth, async (c) => {
  const user = c.get('user')!;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const productId = typeof body.product_id === 'string' && ID.test(body.product_id) ? body.product_id : null;
  if (!productId) {
    await rateLimit(c, 'config-mint', 240, 3600);
    throw personalizationUnavailable();
  }
  // One wave: the limit, the switch, the revision ⋈ product ⋈ store, the value names, the owner's blocked terms.
  const [, cfg, head, names, terms] = await Promise.all([
    rateLimit(c, 'config-mint', 240, 3600),
    customizationSettings(c.env.DB),
    loadBlueprintHead(c.env.DB, productId, null),
    optionNames(c.env.DB, productId),
    loadOwnerTerms(c.env.DB),
  ]);
  const { blueprint } = await readable(c, cfg, head);
  const minted = await mintConfig(c.env.DB, c.env, { userId: user.id, pub: blueprint, raw: body.configuration, terms });
  const res = c.json(
    {
      success: true,
      config_id: minted.config_id,
      twin_code: minted.twin_code,
      unit_iqd: minted.unit_iqd,
      adds: minted.adds,
      words: wordsFrom(blueprint, minted.config, names),
      check: minted.check,
      config: minted.config,
    },
    minted.created ? 201 : 200
  );
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});

/**
 * THE OWNER'S CONFIGURATION: its choices and words, and — when it was made
 * against the product's live revision — the price and check as they stand
 * now. Another person's id is 404 (P2). `changed` says the shop published a
 * new revision since (the studio migrates it); `live_rev` which.
 */
personalizeRoutes.get('/configs/:id', requireAuth, async (c) => {
  const user = c.get('user')!;
  const [, row] = await Promise.all([rateLimit(c, 'personalize-read', 600, 3600), ownConfig(c.env.DB, user.id, c.req.param('id') ?? '')]);
  const config = row ? configOf(row) : null;
  if (!row || !config) throw notFound('Design not found');
  const [cfg, own, live, names] = await Promise.all([
    customizationSettings(c.env.DB),
    loadBlueprintHead(c.env.DB, row.product_id, row.rev),
    loadBlueprintHead(c.env.DB, row.product_id, null),
    optionNames(c.env.DB, row.product_id),
  ]);
  const head = own ?? live;
  const state = head
    ? personalizationStateFor(cfg, { userId: user.id, admin: isPlatformAdmin(c), storeId: head.store.id, productMerchantUserId: head.store.user_id })
    : null;
  if (!state?.may_use) throw personalizationUnavailable();

  let price: { unit_iqd: number; adds: unknown[] } | null = null;
  let check: { verdict: string; issues: unknown[] } | null = null;
  let words: ConfigWords | null = null;
  const changed = !live || live.row.rev !== row.rev;
  if (!changed) {
    const out = await readable(c, cfg, live).catch(() => null);
    if (out) {
      const judged = judge(out.blueprint, config);
      price = judged.price ? { unit_iqd: judged.price.unit_iqd, adds: judged.price.adds } : null;
      check = { verdict: judged.verdict, issues: judged.issues };
      words = wordsFrom(out.blueprint, config, names);
    }
  } else if (own && own.product.publish_state !== 'archived' && !own.product.audience_user_id) {
    const out = await projectBlueprint(c.env.DB, own).catch(() => null);
    if (out) words = wordsFrom(out.blueprint, config, names);
  }
  const res = c.json({
    success: true,
    config_id: row.id,
    twin_code: row.twin_code,
    product_id: row.product_id,
    rev: row.rev,
    live_rev: live?.row.rev ?? null,
    changed,
    config,
    unit_iqd: price?.unit_iqd ?? null,
    adds: price?.adds ?? [],
    check,
    words,
    created_at: row.created_at,
  });
  res.headers.set('Cache-Control', 'private, no-store');
  return res;
});

// ------------------------------------------------------ the owner's assets

/**
 * THE OWNER'S OWN DESIGN PICTURE, inline — a logo or photo they uploaded
 * (purpose `design_asset`, users/<uid>/design-assets/…, which `/files`
 * never serves). Only its owner, only while personalisation is on for the
 * product it was uploaded for (or they may preview it); the type is read from
 * the bytes, never the name; `nosniff` and a sandboxing CSP like `/files`.
 * Anything else is one 404 (P5: the key appears only in the owner's answers).
 */
personalizeRoutes.get('/assets/:key{.+}', requireAuth, async (c) => {
  await rateLimit(c, 'design-asset-read', 600, 3600);
  const user = c.get('user')!;
  const key = c.req.param('key') ?? '';
  const [owned, cfg, filed] = await Promise.all([
    ownedFileObject(c.env.DB, key, user.id, ['design_asset'], { exactPurpose: true, prefix: `users/${user.id}/design-assets/` }),
    customizationSettings(c.env.DB),
    c.env.DB
      .prepare(
        `SELECT p.store_id, s.user_id AS owner_user_id
           FROM file_objects fo
           JOIN community_products p ON p.id = fo.entity_id
           JOIN merchant_stores s ON s.id = p.store_id
          WHERE fo.object_key = ?1 AND fo.owner_id = ?2`
      )
      .bind(key, user.id)
      .first<{ store_id: string; owner_user_id: string }>(),
  ]);
  if (!owned || owned.kind !== 'image') throw notFound();
  const state = personalizationStateFor(cfg, {
    userId: user.id,
    admin: isPlatformAdmin(c),
    storeId: filed?.store_id ?? null,
    productMerchantUserId: filed?.owner_user_id ?? null,
  });
  if (!state.may_use) throw personalizationUnavailable();
  const object = await getMediaObject(c.env, 'private', owned.key);
  if (!object) throw notFound();
  const bytes = new Uint8Array(await object.arrayBuffer());
  const sniffed = sniffImageBytes(bytes);
  if (!sniffed) throw notFound();
  return new Response(bytes, {
    headers: {
      'Content-Type': sniffed.mime,
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    },
  });
});
