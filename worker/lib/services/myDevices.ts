/**
 * «أجهزتي» — ONE ANSWER TO «WHERE IS THIS DEVICE, AND WHAT IS OPEN ON IT?» FOR EVERY SERVICE
 * (Services S-P2 spec §6.2; plan §1.3 «one money process per unit», correction 5; DECISIONS row 238).
 *
 *   openReturnSql / openServiceSql / openProtectionSql
 *       the three «a process holds this unit» questions the trade-in fences ask inside their
 *       writes (moved here from worker/lib/tradeIn.ts, same text, same `?2` line / `?3` slot units);
 *   inShopSql(alias)
 *       the device is WITH THE SHOP: a trade-in received it (intake) and it was neither completed
 *       (then `tradedInSql` holds) nor handed back after a cancel or a decline. From that moment no
 *       return, no warranty claim and no perk counts it (§6.14, correction 5);
 *   printerPerkEligibleSql(alias, nowBind)
 *       the printer-perk predicate later phases (S-P4 / S-P6) read — built and tested now (X10);
 *   listMyDevices / publicDevice / servicesSummary
 *       the customer's devices and the «خدماتي» card (`GET /api/me/services`), allow-listed:
 *       never a paid split, never a serial beyond its last four, never a cost.
 *
 * Every read here names its columns; a database without 0192 has no intake (in-shop is never true),
 * and one without 0178 no unit closure (the device routes' own `serialAssignmentsInstalled` rule).
 */
import type { Env } from '../types';
import { closedClaimSql } from '../deviceOps';
import { MAX_REPLACEMENT_HOPS, tradedInSql } from '../deviceCustody';
import { tradeInV2Installed } from '../tradeInSchema';
import { serialAssignmentsInstalled } from '../serialPolicy';
import { catalogIndexFor } from '../catalogPresentation';
// A cycle (tradeIn.ts imports the fence SQL below): safe, because neither module reads the other's
// bindings while it is first evaluated — only inside functions, at call time.
import { familyOfProduct } from '../tradeIn';
import { stageOf, type TradeInStage, type TradeInStatus } from '@levonis/pricing/tradeIn';
import type { DeviceFacts, PublicDevice, ServicesSummary, ServicesNextAction } from '../../../packages/contracts/src/myDevices';

// ------------------------------------------------------------------ the three open processes

/**
 * An OPEN return case holding the slot's device: a case that names one of the slot's devices; or a
 * case that names no device when the line's open cases and its traded slots need more devices than
 * the line holds — the return door's own count rule. `?2` the line, `?3` the slot's unit ids (JSON).
 */
export const openReturnSql = `(EXISTS (SELECT 1 FROM return_cases rc
     WHERE rc.order_item_id = ?2 AND rc.state NOT IN ('rejected','resolved') AND rc.unit_id IN (SELECT value FROM json_each(?3)))
  OR (EXISTS (SELECT 1 FROM return_cases rc WHERE rc.order_item_id = ?2 AND rc.state NOT IN ('rejected','resolved') AND rc.unit_id IS NULL)
      AND (SELECT COALESCE(SUM(rc.qty), 0) FROM return_cases rc WHERE rc.order_item_id = ?2 AND rc.state NOT IN ('rejected','resolved'))
        + (SELECT COUNT(DISTINCT tc.unit_index) FROM trade_in_claims tc WHERE tc.order_item_id = ?2)
        > (SELECT qty FROM order_items WHERE id = ?2)))`;
/** An open warranty claim on one of the slot's devices (or a legacy claim on the line itself). */
export const openServiceSql = `EXISTS (SELECT 1 FROM warranty_claims wc
   WHERE (wc.unit_id IN (SELECT value FROM json_each(?3)) OR (wc.unit_id IS NULL AND wc.order_item_id = ?2))
     AND NOT ${closedClaimSql('wc')})`;
/** A price-protection claim on the line still being decided. */
export const openProtectionSql = `EXISTS (SELECT 1 FROM price_protection_claims pc WHERE pc.order_item_id = ?2 AND pc.state IN ('requested','approved'))`;

// ------------------------------------------------------------------ in the shop

/** The `unit_index` of the `hops`-th unit `alias` replaced (the deviceCustody slot walk). */
function replacedSlotSql(alias: string, hops: number): string {
  const joins: string[] = [];
  for (let i = 2; i <= hops; i++) joins.push(`JOIN order_item_units isr${i} ON isr${i}.id = isr${i - 1}.replacement_of_unit_id`);
  return `(SELECT isr${hops}.unit_index FROM order_item_units isr1 ${joins.join(' ')} WHERE isr1.id = ${alias}.replacement_of_unit_id)`;
}

/** A request still holds a received device: from intake until completed, or handed back after a cancel / decline. */
export const IN_SHOP_REQUEST = (t: string) =>
  `${t}.intake_at IS NOT NULL AND ${t}.scope <> 'ams_only' AND ${t}.status <> 'completed'
   AND (${t}.status NOT IN ('cancelled','customer_rejected') OR ${t}.device_returned_at IS NULL)`;

/**
 * When the unit `alias` reached the shop (the intake of the request holding it), or NULL — a scalar
 * over `alias.order_item_id` / `alias.unit_index` / `alias.replacement_of_unit_id`, the same slot
 * walk as `tradedInSql`. On a database without 0192 it is always NULL (`v2 = false`).
 */
export const inShopSql = (alias: string, v2 = true) => {
  if (!v2) return '(SELECT NULL)';
  const slots = [`${alias}.unit_index`];
  for (let h = 1; h <= MAX_REPLACEMENT_HOPS; h++) slots.push(replacedSlotSql(alias, h));
  return `(SELECT t.intake_at FROM trade_in_requests t
     WHERE t.order_item_id = ${alias}.order_item_id AND t.unit_index IN (${slots.join(', ')})
       AND ${IN_SHOP_REQUEST('t')}
     ORDER BY t.intake_at LIMIT 1)`;
};

// ------------------------------------------------------------------ X10: the printer perk

/**
 * THE PRINTER-PERK PREDICATE (plan §3.1; S-P4 / S-P6 read it): the unit `alias` is a printer bought
 * HERE (a platform order, delivered — the cash at the door collected), not a gift, delivered at
 * least 7 days before `nowBind`, inside 12 months of its warranty start, not closed, not in the shop
 * (a received trade-in drops it at once), not traded in. `nowBind` is an ISO instant placeholder.
 */
export const printerPerkEligibleSql = (alias: string, nowBind: string, v2 = true) => `(
  EXISTS (SELECT 1 FROM product_catalogs ppc JOIN catalogs pcat ON pcat.id = ppc.catalog_id AND pcat.is_printer_catalog = 1 WHERE ppc.product_id = ${alias}.product_id)
  AND EXISTS (SELECT 1 FROM orders po JOIN order_items poi ON poi.order_id = po.id
               WHERE po.id = ${alias}.order_id AND poi.id = ${alias}.order_item_id AND po.status = 'delivered'
                 AND COALESCE(po.seller_type, 'levonis') <> 'merchant' AND poi.gift_entitlement_id IS NULL)
  AND ${alias}.delivered_at IS NOT NULL AND julianday(${alias}.delivered_at) <= julianday(${nowBind}) - 7
  AND COALESCE(${alias}.warranty_start_at, ${alias}.delivered_at) IS NOT NULL
  AND julianday(${nowBind}) < julianday(COALESCE(${alias}.warranty_start_at, ${alias}.delivered_at), '+12 months')
  AND ${alias}.warranty_closed_at IS NULL AND ${alias}.replaced_by_unit_id IS NULL
  AND ${inShopSql(alias, v2)} IS NULL AND ${tradedInSql(alias)} IS NULL)`;

// ------------------------------------------------------------------ the customer's devices

const monthsLeft = (end: string | null, nowMs: number) => (end && Date.parse(end) > nowMs ? Math.floor((Date.parse(end) - nowMs) / (30 * 86_400_000)) : 0);

/**
 * The caller's delivered LEVONIS devices, each with what is open on it — one read per fact family
 * (units, products, catalogue, returns, claims, protection, trade-ins, serials): at most 8 statements.
 */
export async function listMyDevices(env: Env, userId: string, nowIso = new Date().toISOString()): Promise<DeviceFacts[]> {
  const db = env.DB;
  const [v2, closure] = await Promise.all([tradeInV2Installed(db), serialAssignmentsInstalled(db)]);
  // A unit's closure (a returned device) is migration 0178's column — the device routes' own rule.
  const closedAt = closure ? 'u.warranty_closed_at' : 'NULL AS warranty_closed_at';
  const { results: units } = await db
    .prepare(
      `SELECT u.id, u.order_id, u.order_item_id, u.unit_index, u.product_id, u.delivered_at, u.warranty_end_at, ${closedAt},
              oi.name_snapshot, oi.option_snapshot, oi.image_snapshot, oi.gift_entitlement_id,
              ${tradedInSql('u')} AS traded_in_at, ${inShopSql('u', v2)} AS in_shop_at
         FROM order_item_units u
         JOIN orders o ON o.id = u.order_id
         JOIN order_items oi ON oi.id = u.order_item_id
        WHERE u.owner_user_id = ? AND o.user_id = ? AND o.status = 'delivered' AND COALESCE(o.seller_type, 'levonis') <> 'merchant'
          AND u.replaced_by_unit_id IS NULL
        ORDER BY u.delivered_at DESC LIMIT 200`
    )
    .bind(userId, userId)
    .all<{
      id: string; order_id: string; order_item_id: string; unit_index: number; product_id: string | null; delivered_at: string | null;
      warranty_end_at: string | null; warranty_closed_at: string | null; name_snapshot: string; option_snapshot: string | null;
      image_snapshot: string | null; gift_entitlement_id: string | null; traded_in_at: string | null; in_shop_at: string | null;
    }>();
  const list = (units ?? []).filter((u) => !u.traded_in_at && !u.warranty_closed_at);
  if (!list.length) return [];
  const unitIds = JSON.stringify(list.map((u) => u.id));
  const lineIds = JSON.stringify([...new Set(list.map((u) => u.order_item_id))]);
  const productIds = JSON.stringify([...new Set(list.map((u) => u.product_id).filter((x): x is string => !!x))]);
  const nowMs = Date.parse(nowIso);
  const [idx, products, returns, claims, protection, tradeIns, serials] = await Promise.all([
    catalogIndexFor(db),
    db
      .prepare('SELECT id, template_family, category_id, sub_category_id, name, name_ar FROM products WHERE id IN (SELECT value FROM json_each(?))')
      .bind(productIds)
      .all<{ id: string; template_family: string | null; category_id: string | null; sub_category_id: string | null; name: string | null; name_ar: string | null }>(),
    db
      .prepare(`SELECT order_item_id, unit_id FROM return_cases WHERE order_item_id IN (SELECT value FROM json_each(?)) AND state NOT IN ('rejected','resolved')`)
      .bind(lineIds)
      .all<{ order_item_id: string; unit_id: string | null }>(),
    db
      .prepare(`SELECT wc.unit_id, wc.order_item_id FROM warranty_claims wc WHERE (wc.unit_id IN (SELECT value FROM json_each(?1)) OR wc.order_item_id IN (SELECT value FROM json_each(?2))) AND NOT ${closedClaimSql('wc')}`)
      .bind(unitIds, lineIds)
      .all<{ unit_id: string | null; order_item_id: string | null }>(),
    db
      .prepare(`SELECT order_item_id FROM price_protection_claims WHERE order_item_id IN (SELECT value FROM json_each(?)) AND state IN ('requested','approved')`)
      .bind(lineIds)
      .all<{ order_item_id: string }>(),
    db
      .prepare(
        `SELECT t.id, t.order_item_id, t.unit_index, t.status, t.cancel_reason, ${v2 ? 't.intake_at, t.device_returned_at' : 'NULL AS intake_at, NULL AS device_returned_at'},
                EXISTS (SELECT 1 FROM coupons c JOIN coupon_redemptions r ON r.coupon_id = c.id JOIN orders o ON o.id = r.order_id
                         WHERE c.trade_in_id = t.id AND r.state = 'active' AND o.status <> 'cancelled') AS live_order
           FROM trade_in_requests t
          WHERE t.user_id = ? AND t.status <> 'draft' AND t.order_item_id IN (SELECT value FROM json_each(?))
          ORDER BY t.created_at DESC LIMIT 100`
      )
      .bind(userId, lineIds)
      .all<{ id: string; order_item_id: string; unit_index: number; status: TradeInStatus; cancel_reason: string; intake_at: string | null; device_returned_at: string | null; live_order: number }>(),
    db
      .prepare('SELECT unit_id, serial_norm FROM device_serials WHERE unit_id IN (SELECT value FROM json_each(?))')
      .bind(unitIds)
      .all<{ unit_id: string; serial_norm: string }>(),
  ]);
  const productOf = new Map((products.results ?? []).map((p) => [p.id, p]));
  const serialOf = new Map((serials.results ?? []).map((s) => [s.unit_id, String(s.serial_norm)]));
  const out: DeviceFacts[] = [];
  for (const u of list) {
    const p = u.product_id ? productOf.get(u.product_id) : undefined;
    const family = p ? familyOfProduct(p, idx) : null;
    const request = (tradeIns.results ?? []).find((t) => t.order_item_id === u.order_item_id && Number(t.unit_index) === Number(u.unit_index)) ?? null;
    const stage: TradeInStage | null = request ? stageOf(request, request.live_order === 1, false) : null;
    const openTrade = request && !['completed', 'cancelled', 'rejected', 'offer_expired', 'credit_expired'].includes(stage ?? '') ? request : null;
    const serial = serialOf.get(u.id) ?? '';
    out.push({
      key: `${u.order_item_id}:${u.unit_index}`,
      unit_id: u.id,
      order_id: u.order_id,
      order_item_id: u.order_item_id,
      unit_index: Number(u.unit_index),
      product_id: u.product_id,
      family,
      name: u.name_snapshot,
      variant: u.option_snapshot ?? '',
      image: u.image_snapshot ?? '',
      delivered_at: u.delivered_at,
      warranty_months_left: monthsLeft(u.warranty_end_at, nowMs),
      serial_last4: serial ? serial.slice(-4) : null,
      gift: !!u.gift_entitlement_id,
      open: {
        return: (returns.results ?? []).some((r) => r.order_item_id === u.order_item_id && (r.unit_id === null || r.unit_id === u.id)),
        service: (claims.results ?? []).some((c) => c.unit_id === u.id || (c.unit_id === null && c.order_item_id === u.order_item_id)),
        protection: (protection.results ?? []).some((c) => c.order_item_id === u.order_item_id),
        trade_in: openTrade ? { request_id: openTrade.id, stage: stage! } : null,
      },
      in_shop: !!u.in_shop_at,
    });
  }
  return out;
}

/** What the customer reads of a device: everything but the internal unit and product ids. */
export function publicDevice(f: DeviceFacts): PublicDevice {
  return {
    key: f.key,
    order_id: f.order_id,
    order_item_id: f.order_item_id,
    unit_index: f.unit_index,
    family: f.family,
    name: f.name,
    variant: f.variant,
    image: f.image,
    delivered_at: f.delivered_at,
    warranty_months_left: f.warranty_months_left,
    serial_last4: f.serial_last4,
    gift: f.gift,
    open: { return: f.open.return, service: f.open.service, protection: f.open.protection, trade_in: f.open.trade_in },
    in_shop: f.in_shop,
  };
}

/**
 * THE «خدماتي» CARD (`GET /api/me/services`): how many devices and open cases, and the ONE next thing
 * the customer's trade-ins ask of them (hand the device in, decide on a value, spend the credit,
 * collect the device back, a credit given back), with its date. Price protection and perks arrive
 * with their phases (null now).
 *
 * A database without 0192 (code ahead of its migration, CLAUDE.md rule 2) answers the same card
 * from what it has: the devices without the 0192 facts, and its trade-ins counted while open. The
 * old flow has no stages — no intake, no offer window, no credit given back — so no next thing is
 * named there (`listMine` gives its requests no stage either).
 */
export async function servicesSummary(env: Env, userId: string, nowIso = new Date().toISOString()): Promise<ServicesSummary> {
  const db = env.DB;
  const [devices, v2] = await Promise.all([listMyDevices(env, userId, nowIso), tradeInV2Installed(db)]);
  const openCases = devices.filter((d) => d.open.return || d.open.service || d.open.protection).length;
  if (!v2) {
    // Open exactly as `stageOf` reads a request with no intake and no credit given back.
    const old = await db
      .prepare(`SELECT COUNT(*) AS n FROM trade_in_requests WHERE user_id = ? AND status NOT IN ('draft','completed','cancelled','customer_rejected')`)
      .bind(userId)
      .first<{ n: number }>();
    return {
      devices: { count: devices.length, open_cases: openCases },
      trade_in: { open: Number(old?.n ?? 0), next_action: null, next_at: null },
      protection: null,
      perks: null,
    };
  }
  const { results } = await db
    .prepare(
      `SELECT t.id, t.status, t.cancel_reason, t.intake_at, t.device_returned_at, t.offer_expires_at,
              (SELECT c.ends_at FROM coupons c WHERE c.id = t.coupon_id) AS credit_ends_at,
              (SELECT MAX(x.ends_at) FROM trade_in_credit_reissues x WHERE x.request_id = t.id AND x.ends_at > ?2) AS reissue_ends_at,
              EXISTS (SELECT 1 FROM coupons c JOIN coupon_redemptions r ON r.coupon_id = c.id JOIN orders o ON o.id = r.order_id
                       WHERE c.trade_in_id = t.id AND r.state = 'active' AND o.status <> 'cancelled') AS live_order
         FROM trade_in_requests t
        WHERE t.user_id = ?1 AND t.status <> 'draft'
        ORDER BY t.updated_at DESC LIMIT 50`
    )
    .bind(userId, nowIso)
    .all<{ id: string; status: TradeInStatus; cancel_reason: string; intake_at: string | null; device_returned_at: string | null; offer_expires_at: string | null; credit_ends_at: string | null; reissue_ends_at: string | null; live_order: number }>();
  const ORDER: ServicesNextAction[] = ['decide', 'hand_in', 'pay', 'collect_device', 'reissued'];
  let next: { action: ServicesNextAction; at: string | null } | null = null;
  let open = 0;
  for (const r of results ?? []) {
    const stage = stageOf(r, r.live_order === 1, !!r.reissue_ends_at && r.live_order !== 1);
    let action: ServicesNextAction | null = null;
    let at: string | null = null;
    if (stage === 'decision') action = 'decide';
    else if (stage === 'awaiting_device') [action, at] = ['hand_in', r.offer_expires_at];
    else if (stage === 'credit_ready') [action, at] = ['pay', r.credit_ends_at];
    else if (stage === 'device_to_collect') action = 'collect_device';
    else if (stage === 'credit_reissued') [action, at] = ['reissued', r.reissue_ends_at];
    if (!['completed', 'cancelled', 'rejected', 'offer_expired', 'credit_expired'].includes(stage)) open += 1;
    if (action && (!next || ORDER.indexOf(action) < ORDER.indexOf(next.action))) next = { action, at };
  }
  return {
    devices: { count: devices.length, open_cases: openCases },
    trade_in: { open, next_action: next?.action ?? null, next_at: next?.at ?? null },
    protection: null,
    perks: null,
  };
}

/**
 * The devices of one line the shop holds for a trade-in (received, not handed back): their unit
 * ids (each slot with its warranty replacements) and how many requests hold them — the return
 * door's read, and the count its batch asks again (§6.14). None on a database without 0192.
 */
export async function inShopOnLine(db: D1Database, orderItemId: string): Promise<{ unitIds: string[]; slots: number }> {
  if (!(await tradeInV2Installed(db))) return { unitIds: [], slots: 0 };
  const { results } = await db
    .prepare(`SELECT DISTINCT t.unit_index FROM trade_in_requests t WHERE t.order_item_id = ? AND ${IN_SHOP_REQUEST('t')}`)
    .bind(orderItemId)
    .all<{ unit_index: number }>();
  const { slotOf } = await import('../tradeIn');
  const slots = await Promise.all((results ?? []).map((r) => slotOf(db, orderItemId, Number(r.unit_index))));
  return { unitIds: slots.flatMap((s) => s.unitIds), slots: slots.length };
}

/** SQL counting the in-shop slots of line `?` (one positional parameter) — the return batch's fence. */
export const inShopSlotsSql = `(SELECT COUNT(DISTINCT t.unit_index) FROM trade_in_requests t WHERE t.order_item_id = ? AND ${IN_SHOP_REQUEST('t')})`;
