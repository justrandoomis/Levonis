/**
 * EVERYTHING AN ORDER EARNS BY REACHING `delivered` — whichever door it came
 * through.
 *
 * WHY THIS LEFT worker/routes/admin.ts. These grants lived in the admin
 * route's `deliveredEffects`, reached only from the two ADMIN doors (the
 * legacy status dropdown and the stage panel). But `delivered` is a
 * `delivery_api` stage (worker/lib/orderStages.ts): its normal door is the
 * courier. When Al-Waseet reported a parcel delivered, `syncOrderDelivery`
 * called `moveOrderStage`, the order read «تم التسليم» — and no device unit
 * was created, no warranty clock started, no purchase points were released
 * and no referral milestone was recorded. The customer then found nothing to
 * link under «من طلباتي» (GET /api/devices/eligible lists units), could not
 * open a warranty claim on the printer they had just received, and the
 * admin's warranty section said «لا توجد وحدات قابلة للضمان» until somebody
 * happened to press «إنشاء الوحدات» on the serials screen. The cron sweep and
 * the Telegram confirm door had the same hole.
 *
 * So the grants are now a library function that takes `env`, not a Hono
 * context, and `moveOrderStage` — the ONE function every stage door calls —
 * runs it whenever it actually moves an order into `delivered`. The admin
 * doors still call it too; that second call is a no-op by construction.
 *
 * EVERY STEP IS IDEMPOTENT, WHICH IS WHAT MAKES TWO CALLERS SAFE:
 *   · units   — UNIQUE(order_item_id, unit_index) + ON CONFLICT DO NOTHING;
 *               a replayed delivery never duplicates a unit or restarts a
 *               clock (existing rows are left untouched);
 *   · points  — points_awards / points_accruals keyed by the order;
 *   · referral— UNIQUE(campaign, source_ref) on referral_rewards, and the
 *               support-code gift carries its own double-payout guard.
 *
 * TOTAL. It runs after the delivery has committed; an order that IS delivered
 * must never be reported as a failed move because a grant could not be
 * written. Each step is contained on its own, so one failing does not cost
 * the customer the others, and the unit step's failure is REPORTED
 * (`deviceUnitsWarning`) because a missing warranty clock is something the
 * admin must go and fix, not something to log and forget.
 *
 * WHAT IS NOT HERE: the customer's «تم التسليم» message. `moveOrderStage`
 * already sends it for every legacy-status change (`notifyOrderStatus`), and
 * the admin doors send it themselves; its event key is the status, so it is
 * one message however many doors ask.
 */

import type { Env } from './types';
import { createUnitsOnDelivery, type CreateUnitsResult } from './deviceOps';
import { awardOrderPoints } from './pointsOps';
import { onOrderDelivered } from './membershipOps';

export interface DeliveredEffectsResult {
  deviceUnits: CreateUnitsResult | null;
  deviceUnitsWarning: string | null;
}

export const DEVICE_UNITS_WARNING =
  'Device units were not created — retry from Admin → Serials & Devices (backfill), otherwise warranty clocks for this order are missing.';

export async function runOrderDeliveredEffects(
  env: Env,
  orderId: string,
  opts: {
    /**
     * The request's `waitUntil`, when there is a request: the referral
     * milestone is then recorded after the response instead of holding it.
     * Absent for the courier sync and the cron, which simply await it.
     */
    defer?: (work: Promise<unknown>) => void;
  } = {}
): Promise<DeliveredEffectsResult> {
  let deviceUnits: CreateUnitsResult | null = null;
  let deviceUnitsWarning: string | null = null;

  // Mandate §4: one device record per PHYSICAL unit of every serialized
  // product, clocked to the delivered_at the move just stamped (the flip keeps
  // an existing one, so a re-delivery never restarts a clock). Awaited:
  // warranty clocks are account state, not a fire-and-forget message.
  try {
    const row = await env.DB.prepare('SELECT delivered_at FROM orders WHERE id = ?')
      .bind(orderId)
      .first<{ delivered_at: string | null }>();
    deviceUnits = await createUnitsOnDelivery(env, orderId, row?.delivered_at || new Date().toISOString());
  } catch (e) {
    console.error('device unit creation failed for order', orderId, e instanceof Error ? e.message : String(e));
    // Honest partial outcome: the order IS delivered, units are missing.
    deviceUnitsWarning = DEVICE_UNITS_WARNING;
  }

  // Purchase points (decision row 20 defaults). Awaited — points are account
  // state — and idempotent per order, so a replayed delivery never
  // double-awards.
  try {
    await awardOrderPoints(env, orderId);
  } catch (e) {
    console.error('points award failed for order', orderId, e instanceof Error ? e.message : String(e));
  }

  // Referral 9.1 milestone and the support-code gift: delivered_at-based
  // eligibility, idempotent per order.
  const referral = onOrderDelivered(env, orderId).catch((e: unknown) => {
    console.error('referral milestone failed for order', orderId, e instanceof Error ? e.message : String(e));
  });
  if (opts.defer) opts.defer(referral);
  else await referral;

  /*
   * NO AUTOMATIC PRINTER-GIFT MEMBERSHIP AT DELIVERY — «الهديه تعطى يدويا وليس
   * تلقائيا». A membership somebody did not buy and nobody granted is a
   * subscriber by the ledger and not by anyone's intent, and every benefit in
   * the shop believes the ledger. Granting the gift stays one deliberate click
   * on the memberships screen, from whichever door the order was delivered.
   */

  return { deviceUnits, deviceUnitsWarning };
}
