/**
 * Asking the courier what happened, and acting on the answer — carefully.
 *
 * THE RULE THAT SHAPES EVERYTHING HERE: "إذا تعذر اتصال Al-Waseet API: لا
 * تغيّر حالة الطلب خطأً. سجل الخطأ. أعد المحاولة لاحقًا. اسمح للإدمن
 * بالتحديث اليدوي كـ fallback."
 *
 * So there are exactly four outcomes of a sync, and three of them leave the
 * order's stage untouched:
 *
 *   error      — the courier could not be reached, or answered with a
 *                failure. The message is stored on the order so an admin can
 *                see it, and the next sweep tries again. The stage does not
 *                move. This is the case that makes a naive implementation
 *                dangerous: a 500 from a courier is not "not delivered yet",
 *                it is "we do not know", and those are different.
 *   unmapped   — the courier answered with a status nobody has mapped. The
 *                status is recorded so the admin can map it, and the stage
 *                does not move. Never guessed from the status text.
 *   unchanged  — the mapped stage is the one the order is already in.
 *   moved      — the mapped stage is a real move, made through the same
 *                moveOrderStage every other caller uses, with source
 *                `delivery_api` so the history says who decided it.
 */

import type { Env } from '../types';
import type { DeliveryDriver } from './types';
import { stageForRemoteStatus } from './statusMap';
import { moveOrderStage } from '../orderStageOps';
import { STAGE_LEGACY_STATUS, type OrderStage } from '../orderStages';

export type SyncOutcome = 'moved' | 'unchanged' | 'unmapped' | 'error' | 'no_shipment';

export interface SyncResult {
  orderId: string;
  outcome: SyncOutcome;
  remoteStatusId?: string;
  remoteStatusText?: string;
  stage?: string;
  error?: string;
}

/**
 * Syncs one order against the courier.
 *
 * `now` is injected so a test can be deterministic; nothing here reads a clock
 * of its own.
 */
export async function syncOrderDelivery(
  env: Env,
  driver: DeliveryDriver,
  orderId: string,
  now = new Date().toISOString()
): Promise<SyncResult> {
  const order = await env.DB.prepare(
    'SELECT id, stage, delivery_provider, delivery_remote_id FROM orders WHERE id = ?'
  )
    .bind(orderId)
    .first<{ id: string; stage: string; delivery_provider: string; delivery_remote_id: string }>();
  if (!order) return { orderId, outcome: 'error', error: 'Order not found' };
  if (!order.delivery_remote_id) return { orderId, outcome: 'no_shipment' };

  const res = await driver.getShipment(order.delivery_remote_id);
  if (!res.ok) {
    // Recorded, not acted on. The order keeps the stage it had.
    await env.DB.prepare(
      'UPDATE orders SET delivery_error = ?, delivery_synced_at = ? WHERE id = ?'
    )
      .bind(res.error.slice(0, 500), now, orderId)
      .run();
    return { orderId, outcome: 'error', error: res.error };
  }

  const remote = res.value;
  // The courier's own word is stored whatever we decide to do with it, so an
  // admin looking at a stuck order can see exactly what the courier is saying.
  await env.DB.prepare(
    `UPDATE orders
        SET delivery_status_id = ?, delivery_status_text = ?, delivery_synced_at = ?,
            delivery_error = '',
            delivery_tracking_no = CASE WHEN ? != '' THEN ? ELSE delivery_tracking_no END
      WHERE id = ?`
  )
    .bind(
      remote.statusId, remote.statusText.slice(0, 200), now,
      remote.trackingNo ?? '', remote.trackingNo ?? '',
      orderId
    )
    .run();

  const mapped = await stageForRemoteStatus(env.DB, driver.provider, remote.statusId);
  if (!mapped) {
    return {
      orderId, outcome: 'unmapped',
      remoteStatusId: remote.statusId, remoteStatusText: remote.statusText,
    };
  }
  // A mapping to a stage this build does not know is a typo in the owner's
  // mapping table, not an instruction. Treated as unmapped rather than
  // written into a column with a CHECK constraint behind it.
  if (!(mapped in STAGE_LEGACY_STATUS)) {
    return {
      orderId, outcome: 'unmapped',
      remoteStatusId: remote.statusId, remoteStatusText: remote.statusText,
      error: `Mapped to unknown stage "${mapped}"`,
    };
  }
  if (mapped === order.stage) {
    return { orderId, outcome: 'unchanged', remoteStatusId: remote.statusId, stage: mapped };
  }

  const move = await moveOrderStage(env, {
    orderId,
    to: mapped as OrderStage,
    source: 'delivery_api',
    changedBy: '',
    note: `${driver.provider}: ${remote.statusText}`.slice(0, 500),
    // The courier reports what HAPPENED. Judging it against our path would
    // reject a real event because our own bookkeeping was a step behind —
    // a parcel does not un-deliver because we forgot to tick "out for
    // delivery". The history row records that the courier said so.
    force: true,
    now,
  });
  return {
    orderId,
    outcome: move.moved ? 'moved' : 'unchanged',
    remoteStatusId: remote.statusId,
    remoteStatusText: remote.statusText,
    stage: mapped,
  };
}

export interface DeliverySweepReport {
  scanned: number;
  moved: number;
  unchanged: number;
  unmapped: number;
  errors: number;
  details: SyncResult[];
}

/**
 * Syncs every order that has a live shipment and is not finished.
 *
 * Runs from the cron — "اجعل المزامنة دورية من الـBackend/Cron" — and from
 * the admin's "مزامنة حالة الوسيط" button, which calls it for one order.
 *
 * One failing order never stops the sweep: a courier that 500s on one
 * shipment usually answers fine for the next, and stopping would leave every
 * later order unsynced because of one bad row.
 */
export async function sweepDeliveryStatuses(
  env: Env,
  driver: DeliveryDriver,
  limit = 100,
  now = new Date().toISOString()
): Promise<DeliverySweepReport> {
  const report: DeliverySweepReport = { scanned: 0, moved: 0, unchanged: 0, unmapped: 0, errors: 0, details: [] };
  const { results } = await env.DB.prepare(
    `SELECT id FROM orders
      WHERE delivery_provider = ? AND delivery_remote_id != ''
        AND stage NOT IN ('delivered','cancelled')
      ORDER BY COALESCE(delivery_synced_at, '') ASC
      LIMIT ?`
  )
    .bind(driver.provider, limit)
    .all<{ id: string }>();

  for (const row of results ?? []) {
    report.scanned++;
    try {
      const r = await syncOrderDelivery(env, driver, row.id, now);
      report.details.push(r);
      if (r.outcome === 'moved') report.moved++;
      else if (r.outcome === 'unmapped') report.unmapped++;
      else if (r.outcome === 'error') report.errors++;
      else report.unchanged++;
    } catch (e) {
      report.errors++;
      report.details.push({ orderId: row.id, outcome: 'error', error: e instanceof Error ? e.message : 'failed' });
    }
  }
  return report;
}
