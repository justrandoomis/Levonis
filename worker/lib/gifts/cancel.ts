/**
 * CANCELLING A GIFT — the one writer of a gift's `cancelled` state by the shop (docs/GIFTS_QUICK_BUY.md
 * §1.2). The admin's «إلغاء الهدية» and the Levo Care draw's «إلغاء الجائزة» (worker/lib/careDraw.ts,
 * DECISIONS row 359) both build their statements here, so a gift is never cancelled without its fence
 * (the state and version read), its cart line removed, its points returned when it was bought with
 * points, and its audit row — all in the caller's one batch.
 *
 * A gift already inside an order is not cancelled here: the order is, and the gift then comes back.
 */
import { conflict } from '../http';
import { auditStatements } from '../audit';
import { pointsBackStatements } from '../rewards/shopItems';
import { changedExactlyOne } from './fence';

const text = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

/** May the shop still cancel this gift row? `ordered` has its own answer (cancel the order instead). */
export function giftCancellable(g: Record<string, unknown>): boolean {
  const legacy = text(g.grant_mode || 'legacy') === 'legacy';
  const state = text(g.state);
  return legacy ? state === 'available' : ['granted', 'ready_to_redeem', 'redeemed'].includes(state);
}

/**
 * The statements that cancel gift row `g` (as `loadGiftRow` read it): the fenced UPDATE first, then the
 * cart line, the points, the audit row. Throws the refusal when the gift can no longer be cancelled.
 * A batch that loses the race fails on the fence (`isLostRace`) and writes nothing.
 */
export async function planGiftCancel(
  db: D1Database,
  g: Record<string, unknown>,
  actorId: string,
  reason: string,
  now: string,
  auditExtra: Record<string, unknown> = {}
): Promise<D1PreparedStatement[]> {
  const id = text(g.id);
  const state = text(g.state);
  if (state === 'ordered') {
    throw conflict('This gift is in an order — cancel the order instead; the gift then comes back to the customer.', 'GIFT_ALREADY_ORDERED');
  }
  if (!giftCancellable(g)) throw conflict('This gift can no longer be cancelled.', 'GIFT_STATE');
  const audit = await auditStatements(db, actorId, 'gift.cancel', id, {
    user_id: text(g.user_id),
    level: g.level ?? g.max_level ?? null,
    actor: actorId,
    from: state,
    reason,
    product_id: g.gift_product_id ?? null,
    ...(Number(g.points_spent) > 0 ? { points_returned: Number(g.points_spent), points_tx_id: g.points_tx_id ?? null } : {}),
    ...auditExtra,
  });
  return [
    db
      .prepare(
        `UPDATE gift_entitlements
            SET state = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND state = ? AND version = ?`
      )
      .bind(now, actorId, reason, now, id, state, Number(g.version)),
    ...changedExactlyOne(db),
    db.prepare('DELETE FROM cart_items WHERE gift_entitlement_id = ?').bind(id),
    ...pointsBackStatements(db, g, now),
    ...audit.statements,
  ];
}
