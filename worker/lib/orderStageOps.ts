/**
 * Moving an order between tracking stages — the one place it happens.
 *
 * Three callers need this and must not each have their own version of it:
 * the admin panel (a person confirms something), the cron sweep (a
 * configured wait elapsed), and the courier sync (Al-Waseet says the parcel
 * was delivered). If any of them had its own copy, the day they disagreed
 * would be the day an order's history stopped matching what the customer was
 * shown.
 *
 * WHAT A MOVE HAS TO DO, ALL OF IT OR NONE:
 *
 *   1. Refuse an illegal move (canMoveStage), unless the caller is repairing.
 *   2. Flip the stage CONDITIONALLY on the stage it was read at, so two
 *      concurrent movers cannot both win.
 *   3. Keep the legacy `status` column in step, because the stock lifecycle,
 *      the invoice writer and every existing filter still read it.
 *   4. Re-arm the alarm clock from the NEW entry time — which is how a manual
 *      change cancels the automatic transition that was pending. The pending
 *      one is overwritten, not remembered and ignored.
 *   5. Append to order_status_history. Append, never rewrite: "we told the
 *      customer it had shipped" stays true even after an admin takes it back.
 *   6. Cross the stock boundary if the legacy status crossed it.
 *
 * Step 6 is a real edge case, not a theoretical one. No AUTOMATIC promotion
 * crosses it — every clock-driven stage sits at or after `confirmed`, whose
 * legacy status is already inside STOCK_DEDUCTED_STATES — but an admin
 * jumping an unconfirmed order straight to a warehouse stage does cross it,
 * and skipping the deduction there would ship goods the inventory still
 * believes are on the shelf.
 */

import type { Env } from './types';
import { safeParse } from './types';
import type { ShippingType } from './shippingType';
import { typeForTransport } from './shippingType';
import { addDays, baghdadDayOf } from './baghdadTime';
import {
  type OrderStage,
  type StageSource,
  STAGE_LEGACY_STATUS,
  STAGE_SOURCE,
  canMoveStage,
  nextStageOf,
  resolveDurations,
  scheduleFrom,
  spreadFor,
  stageForLegacyStatus,
  stagesFor,
} from './orderStages';
import { deductOrderStock, returnOrderStock, stockReturnNote } from './orderInventory';
import { emitEvent, eventsEnabled } from './eventBus';
import { OrderStatusChangedV1 } from '@levonis/contracts/events/v1/OrderStatusChanged';
import { OrderDeliveredV1 } from '@levonis/contracts/events/v1/OrderDelivered';
import { deliversToHome, getSetting } from './settings';
import { reachedMilestones, revealStampStatement } from './mysteryReveal';
import { reclaimOrderRedemptionsStatement } from './offers';
import { notifyOrderStatus } from './orderNotify';
import { runOrderDeliveredEffects } from './orderDeliveredEffects';

/** Mirrors STOCK_DEDUCTED_STATES in the admin route — the same four statuses. */
const STOCK_DEDUCTED_STATES = new Set(['confirmed', 'processing', 'shipped', 'delivered']);

export interface OrderStageRow {
  id: string;
  stage: OrderStage;
  status: string;
  shipping_type: ShippingType;
  stage_changed_at: string;
  next_stage: string;
  next_stage_at: string | null;
  stage_source: string;
}

function asStage(v: unknown, fallback: OrderStage = 'received'): OrderStage {
  return typeof v === 'string' && v in STAGE_LEGACY_STATUS ? (v as OrderStage) : fallback;
}

function asShippingType(v: unknown): ShippingType {
  return v === 'preorder_air' || v === 'preorder_sea' || v === 'preorder_land' || v === 'direct'
    ? v
    : typeForTransport(v);
}

export function stageRowFrom(row: Record<string, unknown>): OrderStageRow {
  return {
    id: String(row.id),
    stage: asStage(row.stage),
    status: String(row.status ?? 'pending'),
    shipping_type: asShippingType(row.shipping_type),
    // An order written before 0028 could carry an empty entry time. Falling
    // back to created_at keeps the clock honest instead of measuring from the
    // epoch and promoting the order the instant the sweep first sees it.
    stage_changed_at: String(row.stage_changed_at || row.updated_at || row.created_at || ''),
    next_stage: String(row.next_stage ?? ''),
    next_stage_at: (row.next_stage_at as string | null) ?? null,
    stage_source: String(row.stage_source ?? 'automatic'),
  };
}

export interface MoveResult {
  moved: boolean;
  from: OrderStage;
  to: OrderStage;
  legacy_from: string;
  legacy_to: string;
  next_stage: OrderStage | null;
  next_stage_at: string | null;
  /** Honest partial outcomes — the move happened, something beside it did not. */
  notes: string[];
  /** Why a move was refused, when moved === false. */
  reason?: 'ILLEGAL_MOVE' | 'RACED' | 'NOT_FOUND' | 'OFFER_LIMIT_REACHED';
}

export interface MoveOptions {
  orderId: string;
  to: OrderStage;
  source: StageSource | 'system';
  changedBy?: string;
  note?: string;
  /**
   * Skips the legality check. Only for a repair path that already knows what
   * it is doing (a courier status arriving out of order, a backfill). The
   * history row still records who did it and why.
   */
  force?: boolean;
  /** Injected so tests can move an order through weeks in milliseconds. */
  now?: string;
  /**
   * The request's `waitUntil`, when there is a request. The customer's message
   * about this move is then SENT right after the response instead of waiting
   * for the fifteen-minute outbox cron (`notifyOrderStatus`'s `defer`).
   * Absent for the sweep and the courier sync, which keep the cron.
   */
  defer?: (work: Promise<unknown>) => void;
}

export function newHistoryId(orderId: string, at: string): string {
  // Deterministic enough to be greppable, unique enough for a primary key:
  // two moves of the same order in the same millisecond are not a thing the
  // conditional UPDATE below allows.
  return `osh_${orderId.slice(-12)}_${at.replace(/[^0-9]/g, '')}`;
}

// ------------------------------------------- the delivery day, at two moments

/**
 * DOES THIS ORDER END AT A CUSTOMER'S DOOR? — asked of a row that already
 * exists, so never of today's settings.
 *
 * Read off the order's OWN frozen `delivery_method_snapshot` rather than
 * `checkoutDeliveryMethods`, for the reason the snapshot exists: the array is
 * admin-editable, and a method deleted or re-flagged while a container was at
 * sea must not change the answer for an order already placed under it.
 *
 * MERCHANT ORDERS ARE REFUSED BY NAME, not left to `deliversToHome`. They
 * insert into this same table with `delivery_method_id = 'merchant'` and a
 * snapshot of `{by, store}` that carries no id at all — so the id fallback
 * (`id !== 'pickup'`) would answer "yes, home delivery" for every one of them.
 * settings.ts states the same rule on `deliversToHome` itself: a caller that
 * cannot resolve the method must decide for itself and must not fall through
 * to true.
 *
 * IT LIVES HERE, beside the move that opens a pre-order's window, because the
 * customer route asks the same question about the same row and a second copy
 * of this rule is how the two start disagreeing about whose order gets a
 * picker. It cannot live in `deliveryDay.ts`, which is a leaf that may not
 * import `settings.ts` (its own header says why).
 */
export function orderEndsAtTheDoor(row: Record<string, unknown>): boolean {
  if (String(row.seller_type ?? '') === 'merchant') return false;
  const methodId = String(row.delivery_method_id ?? '');
  if (methodId === 'merchant' || methodId === '') return false;
  const snap = safeParse<Record<string, unknown>>(row.delivery_method_snapshot, {});
  const flag = snap?.home_delivery;
  return deliversToHome({
    id: typeof snap?.id === 'string' && snap.id ? snap.id : methodId,
    home_delivery: typeof flag === 'boolean' ? flag : undefined,
  });
}

/** Extra `SET` clauses for the flip, and the values they bind. */
interface DayPatch {
  sql: string;
  binds: unknown[];
}

const NO_DAY_PATCH: DayPatch = { sql: '', binds: [] };

/**
 * THE TWO MOMENTS A STAGE MOVE TOUCHES THE DELIVERY DAY — and why both ride
 * inside the flip statement instead of running as a second UPDATE.
 *
 * A separate write is not fenced on anything. `moveOrderStage` can lose its
 * race and return RACED, and a window opened by a follow-up UPDATE would have
 * opened on an order the caller never actually moved — a customer offered a
 * delivery day because somebody ELSE's move to `at_levo_warehouse` won.
 * Riding the flip means the window exists exactly when the move that earns it
 * exists.
 *
 *  1. THE PRE-ORDER WINDOW OPENS AT `at_levo_warehouse`. A pre-order cannot be
 *     given its week at checkout: the goods are thirty or ninety days away and
 *     every day in that window would be a day we cannot deliver on. A picker
 *     disabled for three months is worse than no picker. The stage where the
 *     container reaches the LEVO warehouse is the first moment a last-mile day
 *     is a real choice, so that is where the ceiling is anchored — from TODAY,
 *     not from the order date, which is the only anchor that means anything by
 *     then.
 *
 *     Only when the order is not already schedulable, so an admin stepping
 *     back to `en_route_to_levo` and forward again does not hand the customer
 *     a fresh week each time. The ceiling is frozen once, exactly as
 *     checkout's is.
 *
 *  2. RE-OPENING FROM CANCELLED RE-ANCHORS IT. `canMoveStage` lets a cancelled
 *     order back to `confirmed` with no time limit, and an order cancelled in
 *     September and re-opened in December carries a ceiling that shut months
 *     ago — the customer opens the picker and every chip in it is illegal. So
 *     the day is cleared (nobody has chosen one for THIS attempt) and the
 *     ceiling is measured from today.
 *
 * NEITHER IS GATED ON `policy.enabled`. The flag answers "may this order have
 * a day at all", which is a fact about the delivery method; whether a day is
 * OFFERED is a live question the read side asks of the policy. Freezing the
 * policy's off switch into the row would leave these orders permanently
 * unschedulable after the owner switched it back on.
 */
async function deliveryDayPatch(
  env: Env,
  row: Record<string, unknown>,
  to: OrderStage,
  reopening: boolean,
  nowIso: string
): Promise<DayPatch> {
  const schedulable = Number(row.delivery_day_schedulable) === 1;
  const opening =
    to === 'at_levo_warehouse' &&
    !schedulable &&
    String(row.shipping_type ?? '').startsWith('preorder_') &&
    orderEndsAtTheDoor(row);
  const reanchoring = reopening && schedulable;
  if (!opening && !reanchoring) return NO_DAY_PATCH;

  // `baghdadDayOf`, never `nowIso.slice(0, 10)`: between 21:00 and 24:00 UTC
  // the two disagree by a whole day, and the short one sells the customer a
  // six-day week (worker/lib/baghdadTime.ts).
  const policy = await getSetting(env.DB, 'deliveryDayPolicy');
  const windowEnd = addDays(baghdadDayOf(nowIso), policy.max_days);
  // An unparseable clock yields '' — leave every column alone rather than
  // write a ceiling no comparison can read.
  if (!windowEnd) return NO_DAY_PATCH;

  if (opening) {
    return {
      sql: ', delivery_day_schedulable = 1, delivery_day_window_end = ?',
      binds: [windowEnd],
    };
  }
  return {
    sql: `, delivery_due_day = NULL, delivery_day_window_end = ?,
            delivery_day_source = '', delivery_day_changed_at = ?`,
    binds: [windowEnd, nowIso],
  };
}

/**
 * Moves one order to `to`. Returns { moved: false } rather than throwing when
 * the move is illegal or lost a race — the sweep processes many orders and
 * one of them being overtaken by an admin is normal, not an error.
 */
export async function moveOrderStage(env: Env, opts: MoveOptions): Promise<MoveResult> {
  const nowIso = opts.now ?? new Date().toISOString();
  const row = await env.DB.prepare('SELECT * FROM orders WHERE id = ?')
    .bind(opts.orderId)
    .first<Record<string, unknown>>();
  if (!row) {
    return { moved: false, from: 'received', to: opts.to, legacy_from: '', legacy_to: '', next_stage: null, next_stage_at: null, notes: [], reason: 'NOT_FOUND' };
  }
  const order = stageRowFrom(row);
  /**
   * A STAGE THAT IS NOT ON THIS ORDER'S OWN PATH IS JUDGED BY ITS STATUS.
   *
   * `orders.stage` can hold a stage from the OTHER journey — a shipping type
   * edited after the fact leaves `at_origin_warehouse` on a direct order — and
   * `canMoveStage` finds no index for it on the direct path and refuses every
   * move. The board's quick button (`quickNextOf`, worker/routes/admin.ts) and
   * the customer's tracker both read such a row through
   * `stageForLegacyStatus`, so the button offered «جارٍ تجهيز الطلب» and this
   * door answered ILLEGAL_STAGE_MOVE: a button whose only effect was a red
   * line. The two readings now agree.
   *
   * THE FENCE STAYS ON THE RAW STORED STRING (`storedStage` below). The derived
   * stage is only how legality is judged; the conditional flip must still match
   * the row exactly as it was read, or two movers could both win. `cancelled`
   * is left alone — it is on no path by design, and `canMoveStage` has its own
   * rule for leaving it.
   */
  const storedStage = String(row.stage ?? '');
  const onPath =
    storedStage === 'cancelled' || (stagesFor(order.shipping_type) as readonly string[]).includes(storedStage);
  const from: OrderStage = onPath ? order.stage : stageForLegacyStatus(order.status, order.shipping_type);
  const legacyFrom = order.status;
  const legacyTo = STAGE_LEGACY_STATUS[opts.to];

  if (!opts.force && !canMoveStage(from, opts.to, order.shipping_type)) {
    return { moved: false, from, to: opts.to, legacy_from: legacyFrom, legacy_to: legacyTo, next_stage: null, next_stage_at: null, notes: [], reason: 'ILLEGAL_MOVE' };
  }
  /*
   * A COMMUNITY-STORE ORDER NEVER ENTERS OR LEAVES `cancelled` HERE — not even
   * forced. A stage move into `cancelled` refunds nothing (see below), and a
   * store order's cancellation must refund the buyer, restock the store and
   * reverse the merchant's credit together: that is `cancelStoreOrder`
   * (worker/lib/storeOrderOps.ts), which every door calls instead. Leaving
   * `cancelled` would re-open an order whose money went back to the customer.
   */
  if (String(row.seller_type ?? '') === 'merchant' && legacyFrom !== legacyTo && (legacyTo === 'cancelled' || legacyFrom === 'cancelled')) {
    return { moved: false, from, to: opts.to, legacy_from: legacyFrom, legacy_to: legacyTo, next_stage: null, next_stage_at: null, notes: [], reason: 'ILLEGAL_MOVE' };
  }

  const durations = resolveDurations(await getSetting(env.DB, 'orderStageDurations'));
  const schedule = scheduleFrom(opts.to, order.shipping_type, durations, nowIso, spreadFor(order.id));

  // Computed here so the two delivery-day moments can ride the flip below.
  // `reopening` is read twice — by the offer re-claim further down, as it
  // always was, and by the day patch — and both mean the same thing: the
  // order was cancelled and is coming back.
  const reopening = legacyFrom === 'cancelled' && legacyTo !== 'cancelled';
  const dayPatch = await deliveryDayPatch(env, row, opts.to, reopening, nowIso);

  // Conditional on BOTH the stage AND the status we read. Two movers arriving
  // together — the sweep and an admin, or two sweeps — leave exactly one
  // winner, and the loser reports RACED instead of writing a second history
  // row for a move that never happened.
  //
  // THE STATUS HALF IS NOT DECORATION. Every cancellation path — the
  // customer's, the admin's and the expiry sweep's — flips `status` to
  // 'cancelled' and leaves `stage` exactly where it was, so a flip fenced on
  // the stage alone still matches an order that was cancelled a millisecond
  // ago: the admin's confirm lands on a refunded, stock-released order and
  // resurrects it, `reopening` is false because it was computed from the
  // stale row, so the offer slot released by the cancel is never re-claimed,
  // and `deductOrderStock` then runs against units that were already released
  // — eating another order's reservation where one exists. Fencing on the
  // status the caller actually read collapses all of that into a clean RACED.
  // `delivered_at` is stamped ONCE on a platform order (the warranty and the
  // return window start there) and on EVERY move into delivered on a
  // community-store order, where it starts the three days before the merchant
  // is paid — a store delivery walked back was not a delivery (review F5).
  const flipStatement = env.DB.prepare(
    `UPDATE orders
        SET stage = ?, stage_changed_at = ?, stage_source = ?,
            next_stage = ?, next_stage_at = ?, status = ?,
            delivered_at = CASE WHEN ? = 'delivered'
                                THEN CASE WHEN seller_type = 'merchant' THEN ? ELSE COALESCE(NULLIF(delivered_at,''), ?) END
                                ELSE delivered_at END,
            updated_at = ?${dayPatch.sql}
      WHERE id = ? AND stage = ? AND status = ?`
  ).bind(
    opts.to, nowIso, opts.source === 'system' ? 'manual' : opts.source,
    schedule.next_stage ?? '', schedule.next_stage_at, legacyTo,
    opts.to, nowIso, nowIso, nowIso,
    ...dayPatch.binds,
    // The STORED stage, never the derived `from` — see the note where `from`
    // is computed.
    order.id, storedStage, legacyFrom
  );

  /**
   * THE REVEAL STAMP (docs/BUNDLES_MYSTERY.md §8.1), in the SAME transaction
   * as the flip that earns it — this function is the single writer of
   * `orders.stage`, so it is the single place a stage-driven milestone can be
   * crossed, and a stamp written outside the flip could survive a flip that
   * rolled back.
   *
   * `paid: false` on purpose: a stage move establishes nothing about payment.
   * The `'paid'` milestone is stamped by the checkout batch for a fully
   * prepaid order and by `POST /api/orders/:id/settlement` for a cash one.
   *
   * The stamp's own `WHERE` re-reads `orders.stage` inside the transaction, so
   * a mover that LOST the race — its flip matched zero rows — stamps nothing,
   * and `revealed_at IS NULL` makes a winner's stamp idempotent under replay.
   */
  const milestones = reachedMilestones(
    { stage: opts.to, status: legacyTo, shipping_type: order.shipping_type },
    false
  );
  const stamp = revealStampStatement(env.DB, order.id, milestones, nowIso, opts.to);
  // RE-OPENING FROM CANCELLED. The offer slot the cancellation released comes
  // back in the SAME batch as the flip (§17 decision 4): if the customer spent
  // that slot elsewhere meanwhile, `trg_offer_redemption_reclaim` aborts and
  // the move does not happen either, which is the honest outcome. This is only
  // a re-claim — a stage move INTO cancelled releases nothing, because it
  // refunds nothing (it calls returnOrderStock alone, never
  // cancelledOrderRefundStatements), and the owner's rule frees a slot only
  // for an order that was genuinely cancelled AND refunded.
  const moveStatements = [flipStatement];
  if (stamp) moveStatements.push(stamp);
  if (reopening) moveStatements.push(reclaimOrderRedemptionsStatement(env.DB, order.id));
  let flipResult;
  try {
    [flipResult] = await env.DB.batch(moveStatements);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('OFFER_PER_USER_LIMIT') || msg.includes('OFFER_GLOBAL_LIMIT')) {
      return {
        moved: false, from, to: opts.to, legacy_from: legacyFrom, legacy_to: legacyTo,
        next_stage: null, next_stage_at: null, notes: [], reason: 'OFFER_LIMIT_REACHED',
      };
    }
    throw e;
  }
  const flip = flipResult as unknown as { meta: { changes: number } };
  if (flip.meta.changes === 0) {
    return { moved: false, from, to: opts.to, legacy_from: legacyFrom, legacy_to: legacyTo, next_stage: null, next_stage_at: null, notes: [], reason: 'RACED' };
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO order_status_history (id, order_id, stage, status, source, changed_at, changed_by, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      newHistoryId(order.id, nowIso), order.id, opts.to, legacyTo,
      opts.source, nowIso, opts.changedBy ?? '', opts.note ?? ''
    )
    .run();

  // The order aggregate's events (03-EVENTS.md §3.12/§3.13) — emitted from the
  // ONE place a stage move happens, after the conditional flip has proved this
  // caller won the race, so a losing mover publishes nothing. Both are written
  // outside the flip's statement (there is no batch here to ride in) and are
  // delivered by the pump; neither can fail the move.
  if (eventsEnabled(env)) {
    if (legacyFrom !== legacyTo) {
      await emitEvent(
        env.DB,
        OrderStatusChangedV1,
        {
          order_id: order.id,
          from: legacyFrom,
          to: legacyTo,
          stage: opts.to,
          cause: STAGE_EVENT_CAUSE[opts.source] ?? 'system',
          actor_id: opts.changedBy || null,
          at: nowIso,
        },
        { aggregateId: order.id, actorId: opts.changedBy || null }
      );
    }
    if (opts.to === 'delivered') await emitOrderDelivered(env, row, order.id, nowIso, opts.source);
  }

  /*
   * WHAT `delivered` EARNS — device units and their warranty clocks, purchase
   * points, the referral milestone — for EVERY door, not only the admin's.
   * `delivered` is a courier stage: Al-Waseet's sync, the cron sweep and the
   * Telegram door all arrive here and nowhere else, and before this line an
   * order they delivered created no device unit at all, so the printer never
   * appeared under «من طلباتي» and could not carry a warranty claim.
   * Outside the `eventsEnabled` switch for the reason given below. Total and
   * idempotent (worker/lib/orderDeliveredEffects.ts): the admin doors run it
   * again and nothing is granted twice.
   */
  if (opts.to === 'delivered') await runOrderDeliveredEffects(env, order.id, { defer: opts.defer });

  /*
   * THE STAGE DOOR TELLS THE CUSTOMER — and the courier sync with it, because
   * this is the function `worker/lib/delivery/sync.ts` calls.
   *
   * OUTSIDE the `eventsEnabled` block above, deliberately. That block is a
   * DEPLOYMENT SWITCH, off on the live Worker, so a parcel Al-Waseet reported
   * delivered would otherwise grant points and create warranty units in total
   * silence — which is exactly what happens today.
   *
   * Before the stock block below, so a deduction that needs a human cannot
   * also cost the customer their message. `notifyOrderStatus` never throws and
   * the event key is the STATUS, so the admin door's own call for the same
   * order is a no-op rather than a second message.
   *
   * ==========================================================================
   *  IT IS EVERY STATUS, NOT ONLY `delivered`. THIS WAS THE HOLE.
   * ==========================================================================
   * This line used to read `if (opts.to === 'delivered')`, and the legacy
   * `PATCH /api/admin/orders/:id` dropdown next to it called
   * `notifyOrderStatus` for all four. So WHICH DOOR THE ADMIN HAPPENED TO USE
   * decided whether the customer was told their order was confirmed, shipped
   * or cancelled — and the stage panel is the door the fulfilment screen
   * actually offers, the one the modal's own note calls "already the
   * authority". Confirming an order from the panel, or Al-Waseet reporting a
   * parcel picked up, told the customer nothing at all.
   *
   * THE TRIGGER IS THE LEGACY STATUS CHANGING, not the stage. Fourteen stages
   * map onto six statuses — five of the pre-order path's stages are all
   * `shipped` — so keying on the stage would send five «تم شحن طلبك» messages
   * for one journey. `legacyFrom !== legacyTo` sends one, and
   * `notifyOrderStatus` ignores everything that is not one of the four worth a
   * customer's attention (`processing` is a warehouse fact). The event key
   * carries the status, so an order that legitimately reaches `shipped` twice
   * — reversed and re-shipped — still notifies once.
   */
  if (legacyFrom !== legacyTo) await notifyOrderStatus(env, order.id, legacyTo, { defer: opts.defer });

  const notes: string[] = [];
  const wasDeducted = STOCK_DEDUCTED_STATES.has(legacyFrom);
  const nowDeducted = STOCK_DEDUCTED_STATES.has(legacyTo);
  if (!wasDeducted && nowDeducted) {
    // NULL, never the string 'system': `inventory_ledger.actor_user_id` is a
    // foreign key to `users` and no such user exists, so an automatic move
    // with no `changedBy` would abort on the FK. Found by the expiry sweep's
    // tests, which hit exactly this on their first run.
    const res = await deductOrderStock(env.DB, order.id, opts.changedBy || null);
    if (res.rejected > 0) {
      notes.push(`Stock could not be deducted for ${res.rejected} line(s) — check the product's stock before shipping.`);
    }
  } else if (legacyTo === 'cancelled') {
    const res = await returnOrderStock(env.DB, order.id, opts.changedBy || null);
    const note = stockReturnNote(res.kind, res.applied);
    if (note) notes.push(note);
  }

  return {
    moved: true,
    from,
    to: opts.to,
    legacy_from: legacyFrom,
    legacy_to: legacyTo,
    next_stage: schedule.next_stage,
    next_stage_at: schedule.next_stage_at,
    notes,
  };
}

/** Who moved it, as the event catalogue names causes and actors. */
const STAGE_EVENT_CAUSE: Record<string, 'stage' | 'admin' | 'courier' | 'system'> = {
  manual: 'admin',
  automatic: 'stage',
  delivery_api: 'courier',
  system: 'system',
};
const STAGE_EVENT_BY: Record<string, 'admin' | 'merchant' | 'courier' | 'customer_confirm'> = {
  manual: 'admin',
  automatic: 'admin',
  delivery_api: 'courier',
  system: 'admin',
};

/**
 * `OrderDelivered` — the canonical "it reached the customer" fact Devices,
 * Loyalty, Referrals, Reviews and Merchants all hang off. Item REFERENCES
 * only: the frozen warranty/ops snapshots are fetched by the consumer through
 * `OrdersEntrypoint.itemSnapshots`, which keeps the envelope small.
 */
async function emitOrderDelivered(
  env: Env,
  orderRow: Record<string, unknown>,
  orderId: string,
  deliveredAt: string,
  source: StageSource | 'system'
): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT oi.id, oi.product_id, oi.qty, oi.unit_price_iqd, oi.warranty_snapshot,
            EXISTS (SELECT 1 FROM product_catalogs pc
                      JOIN catalogs c ON c.id = pc.catalog_id AND c.is_printer_catalog = 1
                     WHERE pc.product_id = oi.product_id) AS is_printer
       FROM order_items oi WHERE oi.order_id = ? LIMIT 200`
  )
    .bind(orderId)
    .all<{ id: string; product_id: string | null; qty: number; unit_price_iqd: number; warranty_snapshot: string | null; is_printer: number }>();
  const cod = Number(orderRow.due_on_delivery_iqd ?? 0);
  await emitEvent(
    env.DB,
    OrderDeliveredV1,
    {
      order_id: orderId,
      user_id: String(orderRow.user_id ?? ''),
      seller_type: String(orderRow.seller_type ?? '') === 'merchant' ? 'merchant' : 'platform',
      merchant_id: orderRow.merchant_id ? String(orderRow.merchant_id) : null,
      delivered_at: deliveredAt,
      items: (results ?? []).map((r) => ({
        order_item_id: String(r.id),
        // A mystery spool's order_items row stores product_id = NULL by design
        // (docs/BUNDLES_MYSTERY.md §7.7). `String(null)` wrote the literal
        // string "null" as a product id — a value no consumer could tell from a
        // real one, and one the widened `orderItemRef` no longer needs.
        product_id: String(r.product_id ?? '') || null,
        qty: Math.max(1, Number(r.qty) || 1),
        unit_price_iqd: Math.max(0, Math.round(Number(r.unit_price_iqd) || 0)),
        is_printer: !!Number(r.is_printer),
        warranty_plan_id: warrantyPlanIdOf(r.warranty_snapshot),
        ops_policy_id: null,
      })),
      payment_method: String(orderRow.payment_method_id ?? '') === 'cash' ? 'cash' : 'wallet',
      cod_amount_iqd: cod > 0 ? cod : null,
      by: STAGE_EVENT_BY[source] ?? 'admin',
    },
    { aggregateId: orderId, actorId: null }
  );
}

function warrantyPlanIdOf(snapshot: string | null): string | null {
  if (!snapshot) return null;
  try {
    const parsed = JSON.parse(snapshot) as { plan_id?: unknown };
    return typeof parsed.plan_id === 'string' && parsed.plan_id ? parsed.plan_id : null;
  } catch {
    return null;
  }
}

/**
 * Gives an order its first schedule. Called once, at checkout, so a brand new
 * order carries the same alarm clock as one that has been moved by hand.
 */
export async function initOrderStage(env: Env, orderId: string, shippingType: ShippingType, at: string): Promise<void> {
  const durations = resolveDurations(await getSetting(env.DB, 'orderStageDurations'));
  const schedule = scheduleFrom('received', shippingType, durations, at, spreadFor(orderId));
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE orders SET stage = 'received', stage_changed_at = ?, stage_source = 'automatic',
              next_stage = ?, next_stage_at = ? WHERE id = ?`
    ).bind(at, schedule.next_stage ?? '', schedule.next_stage_at, orderId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO order_status_history (id, order_id, stage, status, source, changed_at, changed_by, note)
       VALUES (?, ?, 'received', 'pending', 'automatic', ?, '', '')`
    ).bind(newHistoryId(orderId, at), orderId, at),
  ]);
}

export interface SweepReport {
  scanned: number;
  promoted: number;
  skipped: number;
  errors: string[];
}

/**
 * The cron's job: promote every order whose configured wait has elapsed.
 *
 * Deliberately narrow. It only touches orders that ALREADY carry a
 * next_stage_at, which `scheduleFrom` only ever writes for a stage whose
 * successor is `automatic`. A stage waiting on an admin or on the courier has
 * a null next_stage_at and is invisible to this query, so the sweep cannot
 * confirm an order, cannot declare it out for delivery, and cannot declare it
 * delivered — exactly as the owner required.
 */
export async function sweepDueStages(env: Env, limit = 200, now?: string): Promise<SweepReport> {
  const nowIso = now ?? new Date().toISOString();
  const report: SweepReport = { scanned: 0, promoted: 0, skipped: 0, errors: [] };
  const { results } = await env.DB.prepare(
    `SELECT id, stage, status, shipping_type, stage_changed_at, next_stage, next_stage_at, stage_source
       FROM orders
      WHERE next_stage_at IS NOT NULL AND next_stage_at <= ? AND next_stage != ''
        AND status NOT IN ('cancelled','delivered')
      ORDER BY next_stage_at
      LIMIT ?`
  )
    .bind(nowIso, limit)
    .all<Record<string, unknown>>();

  for (const raw of results ?? []) {
    report.scanned++;
    const order = stageRowFrom(raw);
    const target = asStage(order.next_stage, order.stage);
    // Re-checked here and not trusted from the column: a stored next_stage
    // could have been written by an older build, or by a path that has since
    // changed. Only a clock-owned stage may be promoted by the clock.
    if (STAGE_SOURCE[target] !== 'automatic' || target === order.stage) {
      report.skipped++;
      continue;
    }
    if (nextStageOf(order.stage, order.shipping_type) !== target) {
      report.skipped++;
      continue;
    }
    try {
      const res = await moveOrderStage(env, {
        orderId: order.id,
        to: target,
        source: 'automatic',
        changedBy: '',
        note: 'Automatic transition — scheduled wait elapsed',
        now: nowIso,
      });
      if (res.moved) report.promoted++;
      else report.skipped++;
    } catch (e) {
      report.errors.push(`${order.id}: ${e instanceof Error ? e.message : 'failed'}`);
    }
  }
  return report;
}

/** The stage path an order is on, with each stage's source and whether it is done. */
export interface StageView {
  stage: OrderStage;
  source: StageSource;
  reached: boolean;
  current: boolean;
  at: string | null;
}

export function stagePath(
  shippingType: ShippingType,
  current: OrderStage,
  history: Array<{ stage: string; changed_at: string }>
): StageView[] {
  const path = stagesFor(shippingType);
  const currentIndex = path.indexOf(current);
  // The FIRST time each stage was entered. A stage reversed and re-entered
  // keeps its original timestamp, which is what the customer was told.
  const firstAt = new Map<string, string>();
  for (const h of history) if (!firstAt.has(h.stage)) firstAt.set(h.stage, h.changed_at);
  return path.map((stage, i) => ({
    stage,
    source: STAGE_SOURCE[stage],
    reached: currentIndex >= 0 && i <= currentIndex,
    current: stage === current,
    at: firstAt.get(stage) ?? null,
  }));
}
