/**
 * SELLING UNUSED MATERIAL BACK (docs/PRINT_CLOUD.md §8.2).
 *
 * Buyback is decided PER CATEGORY: filament may be enabled at a rate (e.g.
 * 50 % of what was paid), accessories are configured separately and never
 * inherit the filament rule. The value is computed on the PURCHASE LOTS the
 * units come from — the same oldest-first order consumption uses — so 500 g
 * left of a 1 kg lot bought for 24,250 IQD at 50 % is
 *   (24,250 − 12,125) × 5,000 / 10,000 = 6,062.5 → 6,063 IQD.
 *
 * A request RESERVES the units (no print can use them meanwhile). Approval
 * settles the reservation as 'buyback' — the units leave the customer's
 * inventory and return to the workshop's sellable stock without moving — and
 * records the value owed (paid out manually until the Levonis wallet
 * adapter is connected). Rejection or cancellation releases them, once.
 */
import { one, fence, runBatch, type Planned, type Stmt } from './db';
import { invalid, pcError } from './errors';
import { integrationEvent } from './adapters';
import { pcAudit } from './audit';
import { inventoryAccountId, inventoryLots, releaseInventory, reserveInventory, settleInventory, type InventoryReservationRow } from './inventory';
import { planDraws } from './lots';
import { pcNotify, type NoticeMaterial } from './notify';
import { deallocate } from './warehouse';
import { iso, mulDivRound, pcId } from './util';

async function rule(db: D1Database, variantId: string) {
  const r = await one<{ buyback_enabled: number; buyback_rate_bps: number; unit_code: string; name_ar: string; name_en: string; name_ckb: string }>(
    db,
    `SELECT c.buyback_enabled, c.buyback_rate_bps, v.unit_code, v.name_ar, v.name_en, v.name_ckb
       FROM pc_variants v JOIN pc_products p ON p.id = v.product_id JOIN pc_product_categories c ON c.code = p.category_code
      WHERE v.id = ?`,
    variantId
  );
  if (!r) throw pcError('NOT_FOUND', { field: 'variant_id' });
  if (!r.buyback_enabled || r.buyback_rate_bps <= 0) throw pcError('BUYBACK_NOT_ALLOWED');
  return r;
}

/** What selling `qty` back would pay, lot by lot. Reads only. */
export async function buybackQuote(db: D1Database, userId: string, variantId: string, qty: number) {
  const r = await rule(db, variantId);
  const acct = await one<{ available_qty: number }>(db, 'SELECT available_qty FROM pc_inventory_accounts WHERE id = ?', inventoryAccountId(userId, variantId));
  const available = Number(acct?.available_qty ?? 0);
  if (qty > available) throw pcError('INSUFFICIENT_INVENTORY', { available });
  const plan = planDraws(await inventoryLots(db, inventoryAccountId(userId, variantId)), qty);
  if (plan.shortfall > 0) throw pcError('INSUFFICIENT_INVENTORY', { available });
  const lots = plan.draws.map((d) => ({ lot_id: d.lotId, qty: d.qty, purchase_value_iqd: d.value }));
  return {
    variant_id: variantId,
    qty,
    unit_code: r.unit_code,
    rate_bps: r.buyback_rate_bps,
    purchase_value_iqd: plan.value,
    estimated_value_iqd: mulDivRound(plan.value, r.buyback_rate_bps, 10000),
    eligible_qty: available,
    lots,
  };
}

/**
 * A sell-back request, PLANNED: the units are reserved (ck_pc_inventory_available
 * refuses grams the customer no longer has free) and the request recorded at
 * the quote's value. POST /buybacks runs it under the customer's
 * Idempotency-Key (db.ts `idempotent`): the key's operation row is the batch's
 * first statement, so a retry after a lost answer replays the first answer
 * instead of reserving the units a second time.
 */
export async function planBuybackRequest(
  db: D1Database,
  userId: string,
  variantId: string,
  qty: number,
  now: Date
): Promise<Planned<Awaited<ReturnType<typeof buybackQuote>> & { buyback_id: string; status: 'requested' }>> {
  if (!Number.isSafeInteger(qty) || qty <= 0) throw invalid('qty', 'integer_required');
  const quote = await buybackQuote(db, userId, variantId, qty);
  const id = pcId('pcbb');
  const r = reserveInventory(db, { userId, variantId, qty, purpose: 'buyback', refId: id, actorId: userId, now });
  return {
    statements: [
      ...r.statements,
      db
        .prepare(
          `INSERT INTO pc_buyback_requests (id, user_id, variant_id, qty, rate_bps, estimated_value_iqd, lots_json, reservation_id, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?)`
        )
        .bind(id, userId, variantId, qty, quote.rate_bps, quote.estimated_value_iqd, JSON.stringify(quote.lots), r.reservationId, iso(now), iso(now)),
      ...(await pcAudit(db, userId, 'buyback.request', id, { variant_id: variantId, qty, estimated_value_iqd: quote.estimated_value_iqd })),
    ],
    result: { buyback_id: id, status: 'requested', ...quote },
  };
}

interface BuybackRow {
  id: string;
  user_id: string;
  variant_id: string;
  qty: number;
  rate_bps: number;
  status: string;
  reservation_id: string;
}

async function load(db: D1Database, id: string, userId?: string): Promise<{ b: BuybackRow; res: InventoryReservationRow }> {
  const b = await one<BuybackRow>(db, `SELECT id, user_id, variant_id, qty, rate_bps, status, reservation_id FROM pc_buyback_requests WHERE id = ? ${userId ? 'AND user_id = ?' : ''}`, ...(userId ? [id, userId] : [id]));
  if (!b) throw pcError('NOT_FOUND');
  const res = await one<InventoryReservationRow>(
    db,
    'SELECT id, account_id, user_id, variant_id, purpose, ref_id, qty_reserved, qty_consumed, qty_released, state FROM pc_inventory_reservations WHERE id = ?',
    b.reservation_id
  );
  if (!res) throw pcError('NOT_FOUND', { reason: 'reservation_missing' });
  return { b, res };
}

/** The variant a decision notice names, with its unit's labels: each language reads its own words. */
function material(db: D1Database, variantId: string) {
  return one<NoticeMaterial>(
    db,
    `SELECT v.name_ar, v.name_en, v.name_ckb, v.unit_code, u.label_ar, u.label_ckb
       FROM pc_variants v LEFT JOIN pc_units u ON u.code = v.unit_code
      WHERE v.id = ?`,
    variantId
  );
}

function flip(db: D1Database, b: BuybackRow, to: string, extra: { value?: number | null; payout?: string; decidedBy: string; note: string }, now: Date): Stmt[] {
  return [
    db
      .prepare(
        `UPDATE pc_buyback_requests SET status = ?, final_value_iqd = COALESCE(?, final_value_iqd), payout_status = COALESCE(?, payout_status),
                decided_by = ?, decided_at = ?, note = ?, updated_at = ? WHERE id = ? AND status = 'requested'`
      )
      .bind(to, extra.value ?? null, extra.payout ?? null, extra.decidedBy, iso(now), extra.note.slice(0, 500), iso(now), b.id),
    fence(db, 'STATE_CHANGED', '(SELECT status FROM pc_buyback_requests WHERE id = ?) = ?', [b.id, to]),
  ];
}

/** Approve: the units leave the customer and return to sellable stock; the value owed is recorded. */
export async function approveBuyback(db: D1Database, id: string, actorId: string, now: Date, note = '') {
  const { b, res } = await load(db, id);
  if (b.status !== 'requested') throw pcError('INVALID_TRANSITION', { from: b.status, to: 'approved' });
  const out = await settleInventory(db, res, b.qty, { type: 'buyback', policy: 'cap_at_reserved', actorId, now, note: `buyback ${b.id}` });
  const value = mulDivRound(out.value, b.rate_bps, 10000);
  const v = await material(db, b.variant_id);
  await runBatch(db, [
    ...flip(db, b, 'approved', { value, payout: 'pending', decidedBy: actorId, note }, now),
    ...out.statements,
    ...deallocate(db, {
      variantId: b.variant_id,
      qty: b.qty,
      type: 'buyback_in',
      userId: b.user_id,
      refType: 'buyback',
      refId: b.id,
      entryKey: `buyback_in:${b.id}`,
      actorId,
      now,
    }),
    pcNotify(db, {
      userId: b.user_id,
      notice: 'buyback_approved',
      entity: 'print_cloud_buyback',
      entityId: b.id,
      link: '/account/buyback',
      vars: { qty: String(b.qty), value: String(value) },
      material: v,
      eventKey: `buyback_approved:${b.id}`,
    }),
    integrationEvent(db, { adapter: 'accounting', kind: 'buyback.approved', refId: b.id, payload: { value_iqd: value, purchase_value_iqd: out.value, qty: b.qty }, now }),
    ...(await pcAudit(db, actorId, 'buyback.approve', b.id, { value_iqd: value, purchase_value_iqd: out.value })),
  ]);
  return { buyback_id: b.id, status: 'approved', value_iqd: value, purchase_value_iqd: out.value };
}

export async function rejectBuyback(db: D1Database, id: string, actorId: string, now: Date, note: string) {
  const { b, res } = await load(db, id);
  if (b.status !== 'requested') throw pcError('INVALID_TRANSITION', { from: b.status, to: 'rejected' });
  const v = await material(db, b.variant_id);
  await runBatch(db, [
    ...flip(db, b, 'rejected', { decidedBy: actorId, note }, now),
    ...releaseInventory(db, res, actorId, now, 'buyback rejected'),
    pcNotify(db, {
      userId: b.user_id,
      notice: 'buyback_rejected',
      entity: 'print_cloud_buyback',
      entityId: b.id,
      link: '/account/buyback',
      material: v,
      eventKey: `buyback_rejected:${b.id}`,
    }),
    ...(await pcAudit(db, actorId, 'buyback.reject', b.id, { note })),
  ]);
  return { buyback_id: b.id, status: 'rejected' };
}

export async function cancelBuyback(db: D1Database, id: string, userId: string, now: Date) {
  const { b, res } = await load(db, id, userId);
  if (b.status !== 'requested') throw pcError('INVALID_TRANSITION', { from: b.status, to: 'cancelled' });
  await runBatch(db, [...flip(db, b, 'cancelled', { decidedBy: userId, note: 'cancelled by customer' }, now), ...releaseInventory(db, res, userId, now, 'buyback cancelled')]);
  return { buyback_id: b.id, status: 'cancelled' };
}

/** The owed value was paid out (cash or transfer): recorded, audited, once. */
export async function markBuybackPaid(db: D1Database, id: string, actorId: string, reference: string, now: Date) {
  const b = await one<{ status: string; payout_status: string }>(db, 'SELECT status, payout_status FROM pc_buyback_requests WHERE id = ?', id);
  if (!b) throw pcError('NOT_FOUND');
  if (b.status !== 'approved' || b.payout_status !== 'pending') throw pcError('INVALID_TRANSITION', { status: b.status, payout_status: b.payout_status });
  await runBatch(db, [
    db.prepare("UPDATE pc_buyback_requests SET payout_status = 'paid', note = ?, updated_at = ? WHERE id = ? AND payout_status = 'pending'").bind(reference.slice(0, 500), iso(now), id),
    fence(db, 'STATE_CHANGED', "(SELECT payout_status FROM pc_buyback_requests WHERE id = ?) = 'paid'", [id]),
    ...(await pcAudit(db, actorId, 'buyback.paid', id, { reference })),
  ]);
}
