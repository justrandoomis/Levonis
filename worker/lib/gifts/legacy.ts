/**
 * THE LEGACY REVIEW BOXES — kept working for the customers who hold them
 * (docs/GIFTS_QUICK_BUY.md D1, D2, D4).
 *
 * Before 0175 an approved printer-review reward created an entitlement in state
 * `available`; its owner picked ONE box of levels 1..N, the server drew the
 * contents from the label-only `gift_pool_items` rows and decremented their
 * private `stock`, and an admin handed the box over outside the order system.
 * Those rows survive the rebuild as `grant_mode = 'legacy'` and keep their four
 * states. This module is that code, moved out of worker/routes/reviews.ts
 * unchanged in behaviour, with one rule added: a legacy read of
 * `gift_pool_items` names `product_id IS NULL`, so a level item of the new
 * flow (a real product) is never drawn into a box.
 *
 * New gifts never come here. An admin can CONVERT an `available` row into a
 * level grant of the new flow (POST /api/gifts/admin/grants/:id/convert).
 */
import { safeParse } from '../types';
import { HttpError, badRequest, conflict, int, notFound, str, unavailable } from '../http';

export type GiftKind = 'accessory' | 'filament' | 'nozzle' | 'plate' | 'other';

/** Composition of each legacy gift box level (owner catalog, mandate §5). */
export const LEVEL_COMPOSITION: Readonly<Record<number, readonly GiftKind[]>> = {
  1: ['accessory'],
  2: ['filament'],
  3: ['filament', 'accessory'],
  4: ['nozzle'],
  5: ['nozzle', 'plate'],
};

/** The legacy rows only: label-only, never a real product (D2). */
export const LEGACY_POOL_FILTER = 'product_id IS NULL';

export interface PoolItemRow {
  id: string;
  level: number;
  kind: GiftKind;
  label_ar: string;
  label_en: string;
  label_ckb: string;
  brand: string;
  material: string;
  color: string;
  option_value: string;
  compat_products: string;
  stock: number;
  active: number;
}

function itemFitsPrinter(item: PoolItemRow, printerProductId: string): boolean {
  const compat = safeParse<string[]>(item.compat_products, []);
  return Array.isArray(compat) && compat.includes(printerProductId);
}

function contentsSnapshot(item: PoolItemRow) {
  return {
    item_id: item.id,
    kind: item.kind,
    label_ar: item.label_ar,
    label_en: item.label_en,
    label_ckb: item.label_ckb,
    brand: item.brand,
    material: item.material,
    color: item.color,
    option_value: item.option_value,
  };
}

/** Unbiased random index via WebCrypto. */
function randomIndex(n: number): number {
  if (n <= 1) return 0;
  const buf = new Uint32Array(1);
  const limit = Math.floor(0xffffffff / n) * n;
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

export interface LegacyLevelAvailability {
  level: number;
  available: boolean;
  reason: 'ok' | 'pool_unconfigured' | 'compat_unconfigured';
  nozzle_sizes: string[];
  plates: Array<{ id: string; label_ar: string; label_en: string; label_ckb: string; brand: string }>;
}

/**
 * Availability of one box level for one entitlement, computed from live pool
 * stock. Never fabricates availability: unconfigured pools and unconfigured
 * nozzle/plate compatibility surface as explicit honest states.
 */
export function levelAvailability(items: PoolItemRow[], level: number, printerProductId: string): LegacyLevelAvailability {
  const pool = items.filter((i) => i.level === level && i.active === 1 && i.stock > 0);
  const composition = LEVEL_COMPOSITION[level] ?? [];
  const out: LegacyLevelAvailability = { level, available: true, reason: 'ok', nozzle_sizes: [], plates: [] };

  for (const slot of composition) {
    const slotItems = pool.filter((i) => i.kind === slot);
    if (slotItems.length === 0) {
      out.available = false;
      out.reason = 'pool_unconfigured';
      continue;
    }
    if (slot === 'nozzle' || slot === 'plate') {
      const compatible = slotItems.filter((i) => itemFitsPrinter(i, printerProductId));
      if (compatible.length === 0) {
        out.available = false;
        if (out.reason === 'ok') out.reason = 'compat_unconfigured';
        continue;
      }
      if (slot === 'nozzle') {
        out.nozzle_sizes = [...new Set(compatible.map((i) => i.option_value).filter(Boolean))];
        if (out.nozzle_sizes.length === 0) {
          out.available = false;
          if (out.reason === 'ok') out.reason = 'pool_unconfigured'; // nozzles without a size are not selectable
        }
      } else {
        out.plates = compatible.map((i) => ({
          id: i.id, label_ar: i.label_ar, label_en: i.label_en, label_ckb: i.label_ckb, brand: i.brand,
        }));
      }
    }
  }
  return out;
}

/** The live label-only pool rows the legacy boxes may draw from. */
export async function legacyPoolItems(db: D1Database, level?: number): Promise<PoolItemRow[]> {
  const { results } = await (level === undefined
    ? db.prepare(`SELECT * FROM gift_pool_items WHERE active = 1 AND stock > 0 AND ${LEGACY_POOL_FILTER}`)
    : db.prepare(`SELECT * FROM gift_pool_items WHERE level = ? AND active = 1 AND stock > 0 AND ${LEGACY_POOL_FILTER}`).bind(level)
  ).all<PoolItemRow>();
  return results ?? [];
}

/** A legacy entitlement with the reviewed printer it was granted for. */
export async function loadLegacyEntitlement(db: D1Database, entitlementId: string) {
  return db
    .prepare(
      `SELECT ge.*, rr.review_id, r.product_id,
              p.name AS product_name, p.name_ar AS product_name_ar
         FROM gift_entitlements ge
         LEFT JOIN review_rewards rr ON rr.id = ge.reward_id
         LEFT JOIN reviews r ON r.id = rr.review_id
         LEFT JOIN products p ON p.id = r.product_id
        WHERE ge.id = ?`
    )
    .bind(entitlementId)
    .first<Record<string, unknown>>();
}

/** The pre-0175 customer shape of one entitlement — what an old cached client renders. */
export function legacyEntitlementView(ge: Record<string, unknown>, redemption: Record<string, unknown> | null) {
  return {
    id: ge.id,
    max_level: Number(ge.max_level),
    chosen_level: ge.chosen_level != null ? Number(ge.chosen_level) : null,
    chosen_options: safeParse(ge.chosen_options, {}),
    contents: safeParse(ge.contents, []),
    state: ge.state, // available | selected | fulfilled | cancelled
    created_at: ge.created_at,
    selected_at: ge.selected_at ?? null,
    fulfilled_at: ge.fulfilled_at ?? null,
    product: { id: ge.product_id ?? null, name: ge.product_name ?? null, name_ar: ge.product_name_ar ?? null },
    redeemed: !!redemption,
  };
}

function isUniqueViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes('UNIQUE') || msg.includes('PRIMARY KEY');
}

/**
 * REDEEM A LEGACY BOX — choose exactly ONE box with level L <= quality score.
 * Contents are picked SERVER-side from real in-stock label rows, persisted
 * once (the gift_redemptions primary key aborts replays) and never rerolled;
 * stock decrements atomically (CHECK stock >= 0 aborts the whole batch on
 * concurrent depletion). Unchanged from the pre-0175 route except that the
 * pool reads name `product_id IS NULL`.
 */
export async function redeemLegacyBox(
  db: D1Database,
  userId: string,
  entId: string,
  body: Record<string, unknown>
): Promise<{ gift: ReturnType<typeof legacyEntitlementView>; replay: boolean }> {
  const ge = await loadLegacyEntitlement(db, entId);
  if (!ge || ge.user_id !== userId) throw new HttpError(404, 'Gift not found', 'GIFT_NOT_FOUND');
  if (String(ge.grant_mode ?? 'legacy') !== 'legacy') throw conflict('This gift is redeemed from your gifts page.', 'GIFT_STATE');

  const redemptionOf = () =>
    db.prepare('SELECT * FROM gift_redemptions WHERE entitlement_id = ?').bind(entId).first<Record<string, unknown>>();
  const existingRedemption = await redemptionOf();
  if (existingRedemption) {
    // Already redeemed — return the persisted selection, never reroll.
    const fresh = (await loadLegacyEntitlement(db, entId))!;
    return { gift: legacyEntitlementView(fresh, existingRedemption), replay: true };
  }
  if (ge.state !== 'available') throw conflict('This gift can no longer be redeemed', 'GIFT_STATE');

  const level = int(body.level, 'level', { min: 1, max: 5 });
  const maxLevel = Number(ge.max_level);
  if (level > maxLevel) {
    throw badRequest(`Your quality score unlocks boxes 1 to ${maxLevel} — box ${level} is locked`, 'LEVEL_LOCKED');
  }
  const opts = (body.options && typeof body.options === 'object' ? body.options : {}) as Record<string, unknown>;
  const nozzleSize = str(opts.nozzleSize, 'options.nozzleSize', { max: 20, required: false });
  const plateItemId = str(opts.plateItemId, 'options.plateItemId', { max: 60, required: false });

  const printerProductId = String(ge.product_id ?? '');
  const pool = await legacyPoolItems(db, level);

  const composition = LEVEL_COMPOSITION[level];
  const picks: PoolItemRow[] = [];
  for (const slot of composition) {
    const slotItems = pool.filter((i) => i.kind === slot);
    if (slotItems.length === 0) {
      throw unavailable(
        `The level ${level} gift pool is not stocked/configured yet — your gift stays reserved, please try later or contact support`,
        'GIFT_POOL_UNCONFIGURED'
      );
    }
    if (slot === 'nozzle') {
      const compatible = slotItems.filter((i) => itemFitsPrinter(i, printerProductId));
      if (compatible.length === 0) {
        throw unavailable(
          'Nozzle compatibility for your printer model is not configured yet — your gift stays reserved',
          'GIFT_COMPAT_UNCONFIGURED'
        );
      }
      const sizes = [...new Set(compatible.map((i) => i.option_value).filter(Boolean))];
      if (!nozzleSize) throw badRequest(`Please choose a nozzle size (${sizes.join(', ')})`, 'NOZZLE_SIZE_REQUIRED');
      const sized = compatible.filter((i) => i.option_value === nozzleSize);
      if (sized.length === 0) {
        throw badRequest(`Nozzle size not available — choose one of: ${sizes.join(', ')}`, 'NOZZLE_SIZE_UNAVAILABLE');
      }
      picks.push(sized[randomIndex(sized.length)]);
    } else if (slot === 'plate') {
      const compatible = slotItems.filter((i) => itemFitsPrinter(i, printerProductId));
      if (compatible.length === 0) {
        throw unavailable(
          'Plate compatibility for your printer model is not configured yet — your gift stays reserved',
          'GIFT_COMPAT_UNCONFIGURED'
        );
      }
      let plate: PoolItemRow | undefined;
      if (plateItemId) plate = compatible.find((i) => i.id === plateItemId);
      else if (compatible.length === 1) plate = compatible[0];
      if (!plate) throw badRequest('Please choose a plate from the available options', 'PLATE_CHOICE_REQUIRED');
      picks.push(plate);
    } else {
      // accessory / filament: random server-side pick from real stock.
      picks.push(slotItems[randomIndex(slotItems.length)]);
    }
  }

  const now = new Date().toISOString();
  const optionsJson = JSON.stringify({ nozzle_size: nozzleSize || null, plate_item_id: plateItemId || null });
  const contentsJson = JSON.stringify(picks.map(contentsSnapshot));

  const stmts = [
    // PK(entitlement_id): a concurrent/replayed redeem aborts the whole batch.
    db.prepare(
      `INSERT INTO gift_redemptions (entitlement_id, user_id, level, options, contents, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(entId, userId, level, optionsJson, contentsJson, now),
    ...picks.map((p) =>
      // CHECK (stock >= 0) aborts if another redemption took the last unit.
      db.prepare(`UPDATE gift_pool_items SET stock = stock - 1 WHERE id = ? AND ${LEGACY_POOL_FILTER}`).bind(p.id)
    ),
    db.prepare(
      `UPDATE gift_entitlements SET state = 'selected', chosen_level = ?, chosen_options = ?, contents = ?, selected_at = ?
        WHERE id = ? AND state = 'available' AND grant_mode = 'legacy'`
    ).bind(level, optionsJson, contentsJson, now, entId),
  ];

  try {
    await db.batch(stmts);
  } catch (e) {
    if (isUniqueViolation(e)) {
      const red = await redemptionOf();
      const fresh = (await loadLegacyEntitlement(db, entId))!;
      return { gift: legacyEntitlementView(fresh, red), replay: true };
    }
    if ((e instanceof Error ? e.message : String(e)).includes('CHECK')) {
      throw conflict('Gift stock changed while redeeming — nothing was consumed, please try again');
    }
    console.error('gift redeem failed', e instanceof Error ? e.message : e);
    throw badRequest('Redemption failed. Please try again.');
  }

  const fresh = await loadLegacyEntitlement(db, entId);
  if (!fresh) throw notFound('Gift not found');
  return { gift: legacyEntitlementView(fresh, await redemptionOf()), replay: false };
}

// ------------------------------------------------- the legacy pools editor

export function poolItemView(i: PoolItemRow) {
  return {
    id: i.id,
    level: i.level,
    kind: i.kind,
    label_ar: i.label_ar,
    label_en: i.label_en,
    label_ckb: i.label_ckb,
    brand: i.brand,
    material: i.material,
    color: i.color,
    option_value: i.option_value,
    compat_products: safeParse<string[]>(i.compat_products, []),
    stock: i.stock,
    active: !!i.active,
  };
}

export function parsePoolItemBody(body: Record<string, unknown>, partial: boolean) {
  const out: Record<string, unknown> = {};
  const oneOfKind = (v: unknown) => {
    const allowed = ['accessory', 'filament', 'nozzle', 'plate', 'other'];
    if (typeof v !== 'string' || !allowed.includes(v)) throw badRequest(`kind must be one of: ${allowed.join(', ')}`);
    return v;
  };
  if (!partial || body.level !== undefined) out.level = int(body.level, 'level', { min: 1, max: 5 });
  if (!partial || body.kind !== undefined) out.kind = oneOfKind(body.kind);
  if (!partial || body.label_ar !== undefined) out.label_ar = str(body.label_ar, 'label_ar', { min: 1, max: 200 });
  if (!partial || body.label_en !== undefined) out.label_en = str(body.label_en, 'label_en', { max: 200, required: false });
  if (!partial || body.label_ckb !== undefined) out.label_ckb = str(body.label_ckb, 'label_ckb', { max: 200, required: false });
  if (!partial || body.brand !== undefined) out.brand = str(body.brand, 'brand', { max: 100, required: false });
  if (!partial || body.material !== undefined) out.material = str(body.material, 'material', { max: 100, required: false });
  if (!partial || body.color !== undefined) out.color = str(body.color, 'color', { max: 100, required: false });
  if (!partial || body.option_value !== undefined) out.option_value = str(body.option_value, 'option_value', { max: 40, required: false });
  if (!partial || body.compat_products !== undefined) {
    const list = Array.isArray(body.compat_products) ? body.compat_products.map(String).slice(0, 100) : [];
    out.compat_products = JSON.stringify(list);
  }
  if (!partial || body.stock !== undefined) out.stock = int(body.stock, 'stock', { min: 0, max: 100000 });
  if (!partial || body.active !== undefined) out.active = body.active === false ? 0 : 1;
  return out;
}
