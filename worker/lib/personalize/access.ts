/**
 * WHO MAY SEE, USE AND BUILD PERSONALISATION — THE SWITCH, THE PILOTS AND THE
 * PREVIEW (Programme C, phase C1; docs/LEVO_PROJECT_PROGRAMME.md §B.8, §B.1
 * P13, §0 rows 3 and 26–28).
 *
 * C1 SHIPS DARK. `customizationConfig.enabled` is false by default, and while
 * it is, every /api/personalize door and the merchant builder answer 404
 * (PERSONALIZATION_UNAVAILABLE) — except:
 *
 *   · a PLATFORM ADMIN (a role on a host where administration is served,
 *     `isPlatformAdmin`), who may preview anything;
 *   · the PRODUCT'S OWN MERCHANT, who may preview their own product's live
 *     blueprint read (a signed-in answer: private, no-store, never cached);
 *   · a PILOT: `pilot_store_ids` open the STORE PATH (that store's products
 *     for everyone, and its builder) — safe for the edge cache, because the
 *     product in the path names the store; `pilot_user_ids` open it for one
 *     signed-in PERSON (per viewer: a signed-in answer is never cached).
 *
 * The builder also needs the entitlement `customizableProducts` (PLUS until
 * the owner's E20): `mayBuild` and `canCustomize` ask both.
 *
 * Every rule here reads the normalised setting (`normalizeCustomizationConfig`
 * in worker/lib/settings.ts) — never PUBLIC_SETTING_KEYS: the client learns the
 * switches only from GET /api/personalize/status and /api/merchant/me.can.
 */
import type { Context } from 'hono';
import type { AppContext } from '../types';
import { safeParse } from '../types';
import { getSetting, type CustomizationConfig } from '../settings';
import { HttpError, isPlatformAdmin } from '../http';
import { getTierStatus, hasEntitlement, type TierStatus } from '../entitlements';
import type { StoreContext } from '../merchantAuth';

export type { CustomizationConfig };

/** The normalised `customizationConfig` (one D1 read). */
export async function customizationSettings(db: D1Database): Promise<CustomizationConfig> {
  return getSetting(db, 'customizationConfig');
}

/**
 * 404 PERSONALIZATION_UNAVAILABLE — ONE answer for «dark», «not customizable»,
 * «paused», «private», «the store is not selling»: a door that is off says
 * nothing about what exists behind it.
 */
export const personalizationUnavailable = (): HttpError =>
  new HttpError(404, 'This product cannot be personalised right now.', 'PERSONALIZATION_UNAVAILABLE');

/** Does the switch — or a pilot list — open personalisation for this store and/or person? */
export function switchOpen(cfg: CustomizationConfig, who: { storeId?: string | null; userId?: string | null }): boolean {
  if (cfg.enabled) return true;
  if (who.storeId && cfg.pilot_store_ids.includes(who.storeId)) return true;
  return !!who.userId && cfg.pilot_user_ids.includes(who.userId);
}

export interface PersonalizationState {
  /** The switch or a pilot list opens it here (for this store / this person). */
  on: boolean;
  /** Dark here, but the viewer may look anyway: a platform admin, or the product's own merchant. */
  preview: boolean;
  /** The studio may open for this viewer: `on || preview`. */
  may_use: boolean;
  /** The viewer has a store and the switch (or a pilot list, or being an admin) opens its builder. The entitlement is `/me.can.customize`'s. */
  may_build: boolean;
  /** Each later switch, only where `on`: add to cart (C3), Create (C4), social (C12). */
  cart: boolean;
  create: boolean;
  social: boolean;
}

export interface StateInputs {
  userId?: string | null;
  admin?: boolean;
  /** The store of the product the request is about (the store path). */
  storeId?: string | null;
  /** The user id owning that product's store (`merchant_stores.user_id`). */
  productMerchantUserId?: string | null;
  /** The viewer's own store, when they have one (for `may_build`). */
  ownStoreId?: string | null;
}

/** The pure verdict — what `personalizationState` answers, given the setting and the facts. */
export function personalizationStateFor(cfg: CustomizationConfig, v: StateInputs): PersonalizationState {
  const on = switchOpen(cfg, { storeId: v.storeId, userId: v.userId });
  const own = !!v.userId && !!v.productMerchantUserId && v.userId === v.productMerchantUserId;
  const preview = !on && (!!v.admin || own);
  const may_build = !!v.ownStoreId && (!!v.admin || switchOpen(cfg, { storeId: v.ownStoreId, userId: v.userId }));
  return { on, preview, may_use: on || preview, may_build, cart: on && cfg.cart, create: on && cfg.create, social: on && cfg.social };
}

/**
 * The request's verdict: the viewer from the session (admin = a platform
 * admin on a host that serves administration), the rest from `opts`.
 */
export async function personalizationState(
  c: Context<AppContext>,
  opts: Omit<StateInputs, 'userId' | 'admin'> = {},
  cfg?: CustomizationConfig
): Promise<PersonalizationState> {
  const settings = cfg ?? (await customizationSettings(c.env.DB));
  const user = c.get('user');
  return personalizationStateFor(settings, { ...opts, userId: user?.id ?? null, admin: isPlatformAdmin(c) });
}

/** The builder's switch for a store: open, piloted (store or its owner), or the caller is a platform admin. */
export function builderOpen(c: Context<AppContext>, cfg: CustomizationConfig, storeId: string): boolean {
  if (isPlatformAdmin(c)) return true;
  return switchOpen(cfg, { storeId, userId: c.get('user')?.id ?? null });
}

/**
 * `/api/merchant/me` `can.customize`: the builder is switched on for this
 * store AND its owner holds `customizableProducts` (the tier /me already read).
 */
export async function canCustomize(c: Context<AppContext>, storeId: string, tier: TierStatus): Promise<boolean> {
  if (!hasEntitlement(tier, 'customizableProducts')) return false;
  return builderOpen(c, await customizationSettings(c.env.DB), storeId);
}

/**
 * THE BUILDER'S GATE (and the parts doors', worker/routes/merchantParts.ts):
 * the switch or a pilot for this store (a platform admin always), AND the
 * owner's `customizableProducts` — else the one 404, the door does not exist
 * for this store. Returns the setting it read.
 */
export async function assertBuilderOpen(c: Context<AppContext>, store: StoreContext): Promise<CustomizationConfig> {
  const [cfg, tier] = await Promise.all([customizationSettings(c.env.DB), getTierStatus(c.env.DB, store.store.user_id)]);
  if (!builderOpen(c, cfg, store.store.id) || !hasEntitlement(tier, 'customizableProducts')) throw personalizationUnavailable();
  return cfg;
}

/** May this store use the builder: the switch/pilot (or an admin caller) AND the owner's entitlement. */
export async function mayBuild(c: Context<AppContext>, store: StoreContext, cfg?: CustomizationConfig): Promise<boolean> {
  const settings = cfg ?? (await customizationSettings(c.env.DB));
  if (!builderOpen(c, settings, store.store.id)) return false;
  return hasEntitlement(await getTierStatus(c.env.DB, store.store.user_id), 'customizableProducts');
}

// ------------------------------------------------------ the design-asset door

/**
 * THE `design_asset` UPLOAD DOOR (worker/lib/uploadEntity.ts): a person's own
 * logo or photo for a personalised product. It opens exactly where its
 * consumer (`mintConfig`, worker/lib/personalize/configs.ts) does: the entity
 * is a PRODUCT whose blueprint asks for a logo or a photo — its LIVE revision
 * for anyone personalisation is on for, or its draft too for a previewer (a
 * platform admin, the product's own merchant). Anything else is the same 404
 * as a missing product. The file-count quota (`design_quota`) is asked here;
 * the byte quota is `uploadQuotas.design_asset_gb` (assertQuota).
 *
 * The product is recorded on the ledger row (`file_objects.entity_id`); the
 * picture itself is the PERSON'S (users/<uid>/design-assets/…), so a logo
 * uploaded for one product may be reused on another of theirs.
 */
export async function assertDesignAssetDoor(db: D1Database, user: { id: string; role: string }, productId: string): Promise<void> {
  const [cfg, rows, used] = await Promise.all([
    customizationSettings(db),
    db
      .prepare(
        `SELECT b.state, b.spec, p.store_id, s.user_id AS owner_user_id
           FROM product_blueprints b
           JOIN community_products p ON p.id = b.product_id
           JOIN merchant_stores s ON s.id = p.store_id
          WHERE b.product_id = ?1 AND b.state IN ('live', 'draft') AND p.audience_user_id IS NULL`
      )
      .bind(productId)
      .all<{ state: string; spec: string; store_id: string; owner_user_id: string }>(),
    db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM file_objects WHERE owner_id = ?1 AND purpose = 'design_asset' AND deleted_at IS NULL)
              + (SELECT COUNT(*) FROM upload_sessions WHERE owner_id = ?1 AND purpose = 'design_asset' AND state = 'open' AND expires_at > ?2) AS n`
      )
      .bind(user.id, new Date().toISOString())
      .first<{ n: number }>()
      .catch(() => ({ n: 0 })),
  ]);
  const list = rows.results ?? [];
  const head = list[0];
  if (!head) throw personalizationUnavailable();
  const state = personalizationStateFor(cfg, {
    userId: user.id,
    admin: user.role === 'admin',
    storeId: head.store_id,
    productMerchantUserId: head.owner_user_id,
  });
  const usable = list.filter((r) => r.state === 'live' || (state.preview && r.state === 'draft'));
  const asks = usable.some((r) => {
    const areas = (safeParse<{ areas?: Array<{ kind?: unknown }> }>(r.spec, {}).areas ?? []);
    return Array.isArray(areas) && areas.some((a) => a?.kind === 'logo' || a?.kind === 'photo');
  });
  if (!state.may_use || !asks) throw personalizationUnavailable();
  const count = Number(used?.n ?? 0);
  if (count >= cfg.design_quota) {
    throw new HttpError(400, 'You have kept as many design pictures as we can hold — remove one you no longer need', 'UPLOAD_QUOTA_EXCEEDED', {
      limit_files: cfg.design_quota,
      used_files: count,
      purpose: 'design_asset',
    });
  }
}
