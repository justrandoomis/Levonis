/**
 * MERCHANT DELIVERY ON THE SERVER — reading a store's delivery configuration,
 * saving it, and turning a customer's saved address into the delivery a
 * checkout charges (merchant platform W2-A; the rule itself is the pure
 * resolver in packages/shipping/src/merchantDelivery.ts).
 *
 * WHERE THE CONFIGURATION COMES FROM. `merchant_delivery_profiles` +
 * `merchant_delivery_rules` (migration 0120). A store with no profile row — one
 * opened after the migration and never configured — is priced from its legacy
 * `merchant_stores.delivery_settings` JSON as version 0, exactly as the
 * migration backfilled every older store; and a database a migration behind
 * (the Worker deployed first) degrades to the same JSON rather than failing a
 * checkout. Every save MIRRORS the default fee, threshold and note back into
 * that JSON, so a rollback of the code keeps each merchant's latest default.
 *
 * THE CLIENT NEVER CHOOSES ITS FEE. A checkout names only an address id (read
 * `WHERE id = ? AND user_id = ?`) and a fulfilment; the governorate comes from
 * the saved row, the fee from the merchant's rows. A legacy address with no
 * governorate is refused — never priced at the default.
 */
import {
  FULFILMENTS,
  canonicalLegacySettings,
  deliveryCoverage,
  deliveryTable,
  legacySettingsFromProfile,
  normalizeStoredProfile,
  normalizeStoredRule,
  profileFromLegacySettings,
  resolveMerchantDelivery,
  servedGovernorates,
  type DeliveryConfigInput,
  type Fulfilment,
  type MerchantDeliveryProfile,
  type MerchantDeliveryResolution,
  type MerchantDeliveryRule,
} from '@levonis/shipping/merchantDelivery';
import { normalizeGovernorate } from './iraqGovernorates';
import { badRequest, HttpError } from './http';
import { isSchemaMissing } from './membershipBenefits';

export interface StoredDeliveryConfig {
  profile: MerchantDeliveryProfile;
  rules: MerchantDeliveryRule[];
  /** A profile row exists (false: the legacy JSON stands in as version 0). */
  stored: boolean;
  /** The tables exist (false: a database a migration behind — no version fence is possible). */
  schema: boolean;
}

/** The store's delivery configuration: two reads, run together. */
export async function loadDeliveryConfig(
  db: D1Database,
  store: { id: string; delivery_settings?: unknown }
): Promise<StoredDeliveryConfig> {
  try {
    const [profileRow, ruleRows] = await Promise.all([
      db.prepare('SELECT * FROM merchant_delivery_profiles WHERE store_id = ?').bind(store.id).first<Record<string, unknown>>(),
      db.prepare('SELECT * FROM merchant_delivery_rules WHERE store_id = ?').bind(store.id).all<Record<string, unknown>>(),
    ]);
    const rules = (ruleRows.results ?? [])
      .map(normalizeStoredRule)
      .filter((r): r is MerchantDeliveryRule => r !== null);
    if (!profileRow) return { profile: profileFromLegacySettings(store.delivery_settings), rules, stored: false, schema: true };
    return { profile: normalizeStoredProfile(profileRow), rules, stored: true, schema: true };
  } catch (e) {
    if (!isSchemaMissing(e)) throw e;
    return { profile: profileFromLegacySettings(store.delivery_settings), rules: [], stored: false, schema: false };
  }
}

/** What GET/PUT /api/merchant/delivery answer: the configuration, and what it covers. */
export function deliveryConfigShape(cfg: StoredDeliveryConfig, storeOpen: boolean) {
  const coverage = deliveryCoverage(cfg.profile, cfg.rules);
  return {
    profile: cfg.profile,
    rules: cfg.rules,
    /** False until the merchant saves once: a never-configured store delivers free everywhere. */
    configured: cfg.stored,
    store_open: storeOpen,
    coverage,
  };
}

// ------------------------------------------------------------------ saving

/**
 * THE SAVE, as statements for ONE batch:
 *   1. the version FENCE, riding the rollback mirror: `delivery_settings` is
 *      NOT NULL, and it is written NULL — aborting everything below — unless
 *      the stored version is still the one the editor loaded. Two tabs cannot
 *      overwrite each other; the loser is 409 DELIVERY_VERSION_CONFLICT;
 *   2. the profile, at version + 1;
 *   3. the rules, replaced whole — inserted from one JSON parameter
 *      (`json_each`), so eighteen rules never approach D1's 100 bound values.
 * The caller appends the audit row to the same batch.
 */
export function saveDeliveryStatements(
  db: D1Database,
  p: {
    storeId: string;
    expectedVersion: number;
    profile: DeliveryConfigInput;
    rules: MerchantDeliveryRule[];
    userId: string;
    ts: string;
  }
): D1PreparedStatement[] {
  const next = p.expectedVersion + 1;
  const mirror = JSON.stringify(legacySettingsFromProfile({ ...p.profile, version: next }));
  return [
    db
      .prepare(
        `UPDATE merchant_stores
            SET delivery_settings = CASE WHEN COALESCE((SELECT version FROM merchant_delivery_profiles WHERE store_id = ?1), 0) = ?2
                                         THEN ?3 ELSE NULL END,
                updated_at = ?4
          WHERE id = ?1`
      )
      .bind(p.storeId, p.expectedVersion, mirror, p.ts),
    db
      .prepare(
        `INSERT INTO merchant_delivery_profiles
           (store_id, default_mode, default_fee_iqd, free_over_iqd, free_over_basis, pickup_enabled,
            pickup_governorate, pickup_note, prep_days, note, version, updated_by, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(store_id) DO UPDATE SET
           default_mode = excluded.default_mode, default_fee_iqd = excluded.default_fee_iqd,
           free_over_iqd = excluded.free_over_iqd, free_over_basis = excluded.free_over_basis,
           pickup_enabled = excluded.pickup_enabled, pickup_governorate = excluded.pickup_governorate,
           pickup_note = excluded.pickup_note, prep_days = excluded.prep_days, note = excluded.note,
           version = excluded.version, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
      )
      .bind(
        p.storeId,
        p.profile.default_mode,
        p.profile.default_fee_iqd,
        p.profile.free_over_iqd,
        p.profile.free_over_basis,
        p.profile.pickup_enabled ? 1 : 0,
        p.profile.pickup_governorate,
        p.profile.pickup_note,
        p.profile.prep_days,
        p.profile.note,
        next,
        p.userId,
        p.ts
      ),
    db.prepare('DELETE FROM merchant_delivery_rules WHERE store_id = ?').bind(p.storeId),
    db
      .prepare(
        `INSERT INTO merchant_delivery_rules
           (store_id, governorate_id, mode, fee_iqd, free_over_iqd, prep_days, eta_note, note, updated_at)
         SELECT ?1, json_extract(j.value, '$.governorate_id'), json_extract(j.value, '$.mode'),
                json_extract(j.value, '$.fee_iqd'), json_extract(j.value, '$.free_over_iqd'),
                json_extract(j.value, '$.prep_days'), json_extract(j.value, '$.eta_note'),
                json_extract(j.value, '$.note'), ?2
           FROM json_each(?3) j`
      )
      .bind(p.storeId, p.ts, JSON.stringify(p.rules)),
  ];
}

/** The abort the fence above raises, as the D1 message carries it. */
export const isDeliveryVersionAbort = (msg: string) =>
  /NOT NULL constraint failed: merchant_stores\.delivery_settings/i.test(msg);

/**
 * THE WAVE-1 DOOR STILL WORKS. `PATCH /api/merchant/store` accepts the old flat
 * `delivery_settings` from a build of the dashboard that predates the editor
 * (a cached app). That form sends the field on EVERY save, so an unchanged
 * echo must change nothing; a REAL edit is applied to the profile's default
 * fee, threshold and note (a disabled default stays disabled; rules and pickup
 * are untouched) and bumps the version, so an open checkout sees it as a
 * QUOTE_CHANGED rather than a silent new fee. Empty when nothing moved.
 */
export function legacyDoorStatements(
  db: D1Database,
  p: { storeId: string; storedJson: unknown; incoming: unknown; userId: string; ts: string }
): D1PreparedStatement[] {
  const before = canonicalLegacySettings(p.storedJson);
  const after = canonicalLegacySettings(p.incoming);
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const legacy = profileFromLegacySettings(after);
  return [
    db
      .prepare(
        `INSERT INTO merchant_delivery_profiles
           (store_id, default_mode, default_fee_iqd, free_over_iqd, note, version, updated_by, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7)
         ON CONFLICT(store_id) DO UPDATE SET
           default_mode = CASE WHEN merchant_delivery_profiles.default_mode = 'disabled' THEN 'disabled' ELSE excluded.default_mode END,
           default_fee_iqd = excluded.default_fee_iqd,
           free_over_iqd = excluded.free_over_iqd,
           note = excluded.note,
           version = merchant_delivery_profiles.version + 1,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`
      )
      .bind(p.storeId, legacy.default_mode, legacy.default_fee_iqd, legacy.free_over_iqd, legacy.note, p.userId, p.ts),
  ];
}

// ---------------------------------------------------------------- checkout

export interface CheckoutWhere {
  /** The saved address, read `WHERE id = ? AND user_id = ?` — null when the customer has none. */
  address: Record<string, unknown> | null;
  fulfilment: Fulfilment;
}

/**
 * WHAT A QUOTE OR AN ORDER IS FOR: the fulfilment (default delivery) and the
 * customer's OWN saved address. At the quote an absent `addressId` means the
 * customer's default address — how the page prices its first paint without a
 * round trip for the address book, and how a build of the app from before
 * this contract still quotes. Place-order has no default: it names the
 * address it ships to, and the fingerprint binds it.
 */
export async function checkoutWhere(
  db: D1Database,
  userId: string,
  body: Record<string, unknown>,
  mode: 'quote' | 'place'
): Promise<CheckoutWhere> {
  const rawFulfilment = body.fulfilment ?? 'delivery';
  if (!(FULFILMENTS as readonly unknown[]).includes(rawFulfilment)) {
    throw badRequest('Choose delivery or pickup', 'FULFILMENT_INVALID');
  }
  const fulfilment = rawFulfilment as Fulfilment;
  const rawId = body.addressId;
  if (rawId === undefined || rawId === null || rawId === '') {
    if (mode === 'place') throw badRequest('Choose a delivery address', 'ADDRESS_REQUIRED');
    const address = await db
      .prepare('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, created_at DESC LIMIT 1')
      .bind(userId)
      .first<Record<string, unknown>>();
    return { address: address ?? null, fulfilment };
  }
  if (typeof rawId !== 'string' || rawId.length > 60) throw badRequest('addressId must be a string', 'ADDRESS_NOT_FOUND');
  const address = await db
    .prepare('SELECT * FROM addresses WHERE id = ? AND user_id = ?')
    .bind(rawId, userId)
    .first<Record<string, unknown>>();
  if (!address) throw new HttpError(404, 'Address not found', 'ADDRESS_NOT_FOUND');
  return { address, fulfilment };
}

/** What the store offers, for a checkout that must say where it delivers and whether pickup exists. */
export interface DeliveryOffer {
  served: string[];
  pickup: { governorate: string; note: string } | null;
}

const offerOf = (cfg: StoredDeliveryConfig): DeliveryOffer => ({
  served: servedGovernorates(cfg.profile, cfg.rules),
  pickup: cfg.profile.pickup_enabled ? { governorate: cfg.profile.pickup_governorate, note: cfg.profile.pickup_note } : null,
});

/** The delivery a quote shows its customer — fees and words, never the merchant's other settings. */
export interface PublicQuoteDelivery extends DeliveryOffer {
  fulfilment: Fulfilment;
  address_id: string;
  governorate: string;
  rule: string;
  fee_iqd: number;
  base_fee_iqd: number;
  free_over_iqd: number | null;
  prep_days: number;
  eta_note: string;
  note: string;
}

export interface CheckoutDelivery {
  ok: true;
  resolution: MerchantDeliveryResolution;
  /** `orders.delivery_method_id`: the merchant's own delivery, or collection from the store. */
  method_id: 'merchant' | 'merchant_pickup';
  /** `orders.delivery_method_snapshot` minus the store name the caller adds. */
  snapshot: Record<string, unknown>;
  /** Preparation days shown and snapshotted: the rule's, or a product's own when longer. */
  prep_days: number;
  public: PublicQuoteDelivery;
  /** What the quote fingerprint binds: every input that moves the fee. */
  fingerprint: unknown[];
  /** The profile version the order batch fences on; null on a database without the tables. */
  fence_version: number | null;
}

export interface CheckoutDeliveryRefusal {
  ok: false;
  status: 409;
  code: 'ADDRESS_REQUIRED' | 'ADDRESS_GOVERNORATE_REQUIRED' | 'DELIVERY_UNAVAILABLE';
  message: string;
  details: Record<string, unknown>;
}

/**
 * THE DELIVERY A CHECKOUT CHARGES, from the address row and the merchant's
 * rows only. `merchandiseIqd` is the goods after the coupon (the threshold's
 * basis); `productPrepDays` the longest preparation any product in the cart
 * names. A refusal carries what the page needs to say where the store DOES
 * deliver and whether pickup exists — never a fee.
 */
export async function checkoutDelivery(
  db: D1Database,
  store: { id: string; delivery_settings?: unknown },
  where: CheckoutWhere,
  merchandiseIqd: number,
  productPrepDays: number
): Promise<CheckoutDelivery | CheckoutDeliveryRefusal> {
  const cfg = await loadDeliveryConfig(db, store);
  const offer = offerOf(cfg);
  if (!where.address) {
    return {
      ok: false,
      status: 409,
      code: 'ADDRESS_REQUIRED',
      message: 'Add a delivery address to check out',
      details: { ...offer, fulfilment: where.fulfilment },
    };
  }
  const addressId = String(where.address.id);
  const governorate = normalizeGovernorate(where.address.governorate);
  const r = resolveMerchantDelivery(cfg.profile, cfg.rules, governorate, merchandiseIqd, where.fulfilment);
  if (!r.available) {
    const legacy = r.reason === 'governorate_required';
    return {
      ok: false,
      status: 409,
      code: legacy ? 'ADDRESS_GOVERNORATE_REQUIRED' : 'DELIVERY_UNAVAILABLE',
      message: legacy
        ? 'This address has no governorate. Add it to see the delivery.'
        : r.reason === 'pickup_disabled'
          ? 'This store does not offer pickup'
          : 'This store does not deliver to that governorate',
      details: { ...offer, fulfilment: where.fulfilment, address_id: addressId, governorate, reason: r.reason },
    };
  }
  const prep = Math.max(r.prep_days, Math.max(0, Math.trunc(productPrepDays) || 0));
  const rule = cfg.rules.find((x) => x.governorate_id === r.governorate) ?? null;
  const snapshot: Record<string, unknown> = {
    fulfilment: r.fulfilment,
    governorate: r.governorate,
    rule: r.rule,
    fee_iqd: r.fee_iqd,
    base_fee_iqd: r.base_fee_iqd,
    free_over_iqd: r.free_over_iqd,
    free_over_basis: cfg.profile.free_over_basis,
    prep_days: prep,
    rule_prep_days: r.prep_days,
    eta_note: r.eta_note,
    note: r.note,
    pickup: where.fulfilment === 'pickup' ? offer.pickup : null,
    applied_rule: where.fulfilment === 'pickup' ? null : rule,
    default: { mode: cfg.profile.default_mode, fee_iqd: cfg.profile.default_fee_iqd },
    profile_version: r.profile_version,
    profile_source: cfg.stored ? 'profile' : 'legacy',
  };
  return {
    ok: true,
    resolution: r,
    method_id: where.fulfilment === 'pickup' ? 'merchant_pickup' : 'merchant',
    snapshot,
    prep_days: prep,
    public: {
      ...offer,
      fulfilment: r.fulfilment,
      address_id: addressId,
      governorate: r.governorate,
      rule: String(r.rule),
      fee_iqd: r.fee_iqd,
      base_fee_iqd: r.base_fee_iqd,
      free_over_iqd: r.free_over_iqd,
      prep_days: prep,
      eta_note: r.eta_note,
      note: r.note,
    },
    fingerprint: [r.fulfilment, addressId, r.governorate, r.rule, r.fee_iqd, r.profile_version],
    fence_version: cfg.schema ? r.profile_version : null,
  };
}

/**
 * THE ORDER BATCH'S DELIVERY FENCE: `delivery_method_snapshot` is NOT NULL and
 * is written NULL — aborting the order, its payment and its credit — unless the
 * store's profile is still at the version this order was priced at. The
 * fingerprint catches an edit made before the tap; this catches one landing
 * between the check and the commit.
 */
export function deliveryFenceStatement(db: D1Database, orderId: string, storeId: string, version: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE orders
          SET delivery_method_snapshot = CASE
                WHEN COALESCE((SELECT version FROM merchant_delivery_profiles WHERE store_id = ?2), 0) = ?3
                THEN delivery_method_snapshot ELSE NULL END
        WHERE id = ?1`
    )
    .bind(orderId, storeId, version);
}

export const isDeliveryFenceAbort = (msg: string) => /NOT NULL constraint failed: orders\.delivery_method_snapshot/i.test(msg);

// -------------------------------------------------------------- storefront

/** The store's delivery as a visitor may read it: where it delivers and for how much. No version, no editor state. */
export function publicDeliverySummary(cfg: StoredDeliveryConfig) {
  const table = deliveryTable(cfg.profile, cfg.rules);
  return {
    areas: table
      .filter((g) => g.mode !== 'disabled')
      .map((g) => ({ governorate: g.governorate, fee_iqd: g.fee_iqd, free: g.mode === 'free' || g.fee_iqd === 0, free_over_iqd: g.free_over_iqd, prep_days: g.prep_days, eta_note: g.eta_note })),
    pickup: cfg.profile.pickup_enabled ? { governorate: cfg.profile.pickup_governorate, note: cfg.profile.pickup_note } : null,
    prep_days: cfg.profile.prep_days,
    free_over_iqd: cfg.profile.free_over_iqd,
    note: cfg.profile.note,
  };
}

/** One governorate's answer, for the storefront's «التوصيل إلى …» line. Merchandise 0: the fee below any threshold. */
export function deliveryToGovernorate(cfg: StoredDeliveryConfig, governorate: string) {
  const r = resolveMerchantDelivery(cfg.profile, cfg.rules, governorate, 0, 'delivery');
  return {
    governorate: r.governorate || governorate,
    available: r.available,
    reason: r.reason,
    fee_iqd: r.fee_iqd,
    free: r.available && r.fee_iqd === 0,
    free_over_iqd: r.free_over_iqd,
    prep_days: r.prep_days,
    eta_note: r.eta_note,
  };
}

/** The signed-in visitor's default-address governorate, or '' (none, or a legacy address without one). */
export async function viewerGovernorate(db: D1Database, userId: string | null | undefined): Promise<string> {
  if (!userId) return '';
  const row = await db
    .prepare('SELECT governorate FROM addresses WHERE user_id = ? ORDER BY is_default DESC, created_at DESC LIMIT 1')
    .bind(userId)
    .first<{ governorate: string }>();
  return normalizeGovernorate(row?.governorate ?? '');
}

