import type { Env } from './types';
import { processOutbox } from './outbox';
import { pumpOutbox, pruneOutbox, type RetentionReport } from './eventBus';
import { releaseDueAccruals } from './pointsOps';
import type { ReleaseSweepReport } from './pointsOps';
import { processWalletNotifications } from './walletNotify';
import type { ProcessReport } from './walletNotify';
import { reconcileWallets } from './walletOps';
import { reconcileSupportGifts } from './membershipOps';
import { sweepDueStages } from './orderStageOps';
import type { SweepReport } from './orderStageOps';
import { alwaseetDriver } from './delivery/alwaseet';
import { sweepDeliveryStatuses } from './delivery/sync';
import { getSetting } from './settings';
import { sweepExpiredOrders } from './orderExpirySweep';
import type { OrderExpiryReport } from './orderExpirySweep';
import { resolveOrderExpiry } from './orderExpiry';
import type { SupportGiftReconciliation } from './membershipOps';
import { sweepBnplOverdue, type BnplOverdueReport } from './bnpl';
import { sweepAutomaticReviews, type AutomaticReviewSweepReport } from './reviewAutoSweep';
import { sweepCancelledOrders, type CancelledOrderSweepReport } from './orderDeletion';
import {
  sweepStockAlerts,
  pruneFinishedStockAlerts,
  FINISHED_RETENTION_DAYS,
  PRUNE_RUN_LIMIT,
  type StockAlertSweepReport,
  type StockAlertPruneReport,
} from './stockAlerts';
import { runGuardedMediaCleanup } from './mediaRefs';
import { checkSchemaDrift, type DriftAlarmReport } from './schemaDriftAlarm';
import { planSearchIndex, searchIndexInstalled } from './search/store';
import { toSearchDoc } from './search/document';

/**
 * Durable scheduled jobs (final-phase §11): one entrypoint the Worker wires
 * to its cron trigger (scheduled handler + ctx.waitUntil) and that can also
 * be invoked opportunistically. Every step is independent and never throws —
 * one failing step must not starve the others; failures surface sanitized in
 * the returned report and the logs.
 */

export interface DurableJobsReport {
  ran_at: string;
  /**
   * Step 0 (02-MIGRATION-PLAN.md 1.6): the event bus's cron sweep — the ONLY
   * holder of `pump_lock`. `null` whenever there is nothing to do: the bus is
   * off, no consumer is bound, the outbox table is absent, or another run holds
   * the lock. On the live Worker today it is always null.
   */
  event_pump: { selected: number; delivered: number; retried: number; dead: number; budget_hit: boolean } | null;
  /**
   * Step 0b: outbox retention. `core_outbox_events` keeps a full signed
   * envelope per event and `core_audit_details` a second copy of every audit
   * body, both in the shared customer database — so a bus that is on and never
   * pruned is unbounded growth against D1's 10 GB cap. `null` while the bus is
   * off or the tables are absent, which is the live Worker today.
   */
  event_retention: RetentionReport | null;
  outbox: { sent: number; failed: number };
  expired_link_challenges: number;
  pruned_otp_challenges: number;
  /** Email/WhatsApp sign-in codes pruned (auth_otp, migration 0087). */
  pruned_auth_otp: number;
  /** Spent or expired sign-up proofs pruned (signup_tickets, migration 0090). */
  pruned_signup_tickets: number;
  /**
   * Products indexed for search this run (search_tokens, migration 0089).
   *
   * The index is written with every product save, so this only ever has work
   * to do for rows that predate migration 0089 — the backfill, done in small
   * chunks across cron runs rather than as one statement in the migration
   * itself, because indexing needs the brand and section NAMES and a
   * migration cannot call the tokeniser.
   */
  search_indexed: number;
  pruned_email_tokens: number;
  pruned_reset_tokens: number;
  pruned_sessions: number;
  /** Purchase-points accruals released this run (mandate §4.3). */
  points_accruals: ReleaseSweepReport;
  /** Admin-group wallet notifications delivered/retried (§12.1). */
  wallet_notifications: ProcessReport;
  /** Wallet invariant check (§11.4) — reports, never repairs. `committed_holds_without_debit`
   *  counts holds committed without their ledger debit (the pre-settlement-rule leak). */
  wallet_reconciliation: { anomalies: number; sums_match: boolean; committed_holds_without_debit: number };
  /** Support-gift entitlement re-evaluation (§3.4). */
  support_gifts: SupportGiftReconciliation;
  /**
   * Order tracking stages promoted this run. This is the whole automation
   * engine's heartbeat: the owner ruled out timers in the browser, so the
   * only thing that ever advances an order on the clock is this sweep.
   */
  order_stages: SweepReport;
  order_expiry: OrderExpiryReport;
  /** Cancelled, never-fulfilled orders permanently removed after 30 days. */
  cancelled_order_retention: CancelledOrderSweepReport;
  /**
   * Local-courier status sync. Separate from order_stages because it is the
   * only thing allowed to move an order to "في الطريق إليك" or "تم التوصيل":
   * the clock never may, and this only does when the courier says so AND the
   * owner has mapped that status.
   */
  delivery_sync: { configured: boolean; scanned: number; moved: number; unmapped: number; errors: number };
  /** PRO BNPL accounts whose oldest unpaid instalment passed its due date. */
  bnpl_overdue: BnplOverdueReport;
  /** Seven-day system ratings; these never create reward records. */
  automatic_reviews: AutomaticReviewSweepReport;
  /**
   * «خبرني لما يرجع» — the back-in-stock sweep (0092). This is the ONLY thing
   * that answers a customer's standing restock request: availability rises
   * about sixteen ways in this catalogue and only five of them write to
   * `inventory_ledger`, so there is no write path to hang it on that would not
   * silently miss most of them (worker/lib/stockAlerts.ts states each one).
   */
  stock_alerts: StockAlertSweepReport;
  /**
   * Finished alert rows erased («الصفوف المنتهية ... اجعل الخادم يمحيها
   * تلقائيا»). An alert waits as long as it has to, fires once, and is then
   * over — and the customer has no way to clear the rows it leaves behind,
   * because DELETE /:id is guarded on the live states so that a re-arm finds
   * the same row. This is the server doing it for them.
   */
  stock_alert_prune: StockAlertPruneReport;
  /**
   * The SECOND outbox drain, at the very end of the run. Reported separately
   * from `outbox` above so an operator can see whether a match found this run
   * was also delivered this run, rather than having the two drains add up into
   * one number that answers neither question.
   */
  outbox_final: { sent: number; failed: number };
  /**
   * THE R2 CLEANUP QUEUE — the step without which the whole leak fix is inert.
   *
   * When an admin removes one picture from a saved product, the save no longer
   * abandons the object in R2: it writes a `media_cleanup_jobs` row. But a row
   * is not a deletion. Until this step existed, nothing anywhere emptied that
   * queue — the only drain was an admin calling the maintenance endpoint by
   * hand — so the owner was paying for the same bytes as before AND carrying a
   * growing queue table with no way in the product to empty it.
   *
   * IT IS SAFE INSIDE A CRON, which is why it can run unattended at all:
   * `runGuardedMediaCleanup` rebuilds the full reference set immediately
   * before it touches the bucket and refuses to delete anything it cannot
   * prove is unreferenced — a key that came back is closed `skipped_shared`
   * and its bytes survive. If the reference set cannot be proven complete it
   * deletes NOTHING and leaves every job pending for the next tick.
   */
  media_cleanup: {
    attempted: number;
    deleted: number;
    still_referenced: number;
    dead_lettered: number;
    retrying: number;
    refusals: string[];
  };
  /**
   * The watchdog on code-versus-schema drift. `null` only if the step threw,
   * which `step()` also records in `errors` — a report that says nothing about
   * the watchdog is a report that cannot tell "no drift" from "never ran".
   */
  schema_drift: DriftAlarmReport | null;
  errors: string[];
}

/** Rows already expired are kept this long for support/audit before pruning. */
const PRUNE_GRACE_DAYS = 7;

export async function runDurableJobs(env: Env): Promise<DurableJobsReport> {
  const nowIso = new Date().toISOString();
  const pruneBefore = new Date(Date.now() - PRUNE_GRACE_DAYS * 86_400_000).toISOString();
  const report: DurableJobsReport = {
    ran_at: nowIso,
    event_pump: null,
    event_retention: null,
    outbox: { sent: 0, failed: 0 },
    expired_link_challenges: 0,
    pruned_otp_challenges: 0,
    pruned_auth_otp: 0,
    pruned_signup_tickets: 0,
    search_indexed: 0,
    pruned_email_tokens: 0,
    pruned_reset_tokens: 0,
    pruned_sessions: 0,
    points_accruals: { scanned: 0, released: 0, points: 0, skipped: 0 },
    wallet_notifications: { sent: 0, failed: 0, dead: 0 },
    wallet_reconciliation: { anomalies: 0, sums_match: true, committed_holds_without_debit: 0 },
    support_gifts: { scanned: 0, cancelled: 0, became_due: 0, flagged: 0 },
    order_stages: { scanned: 0, promoted: 0, skipped: 0, errors: [] },
    order_expiry: { configured: false, scanned: 0, cancelled: 0, skipped: 0, errors: 0 },
    cancelled_order_retention: { retention_days: 30, scanned: 0, deleted: 0, skipped: 0, errors: 0 },
    delivery_sync: { configured: false, scanned: 0, moved: 0, unmapped: 0, errors: 0 },
    bnpl_overdue: { scanned: 0, overdue: 0, suspended: 0 },
    automatic_reviews: { scanned: 0, created: 0, skipped: 0 },
    stock_alerts: { scanned: 0, matched: 0, notified: 0, dead: 0, deferred: 0 },
    stock_alert_prune: { deleted: 0, bound_hit: false },
    outbox_final: { sent: 0, failed: 0 },
    media_cleanup: { attempted: 0, deleted: 0, still_referenced: 0, dead_lettered: 0, retrying: 0, refusals: [] },
    schema_drift: null,
    errors: [],
  };

  const step = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`durable job step "${name}" failed:`, msg);
      report.errors.push(`${name}: ${msg.slice(0, 200)}`);
    }
  };

  // 0. Deliver whatever the per-request pumps missed. FIRST, and its own step:
  //    a producer whose events sit undelivered is a producer nobody can trust,
  //    and the lock means two overlapping cron runs cannot double-deliver.
  await step('event_pump', async () => {
    const pump = await pumpOutbox(env, `cron:${nowIso}`);
    report.event_pump = pump
      ? { selected: pump.selected, delivered: pump.delivered, retried: pump.retried, dead: pump.dead, budget_hit: pump.budget_hit }
      : null;
  });

  // 0b. Retention for what the pump leaves behind. After the pump, so a row
  //     acked in this very run is a candidate the moment its window passes,
  //     and bounded per run so a first pass over a large table cannot time the
  //     whole cron out.
  await step('event_retention', async () => {
    report.event_retention = await pruneOutbox(env);
  });

  // 1. Deliver pending outbox notifications (email/telegram) with retries.
  await step('outbox', async () => {
    report.outbox = await processOutbox(env, 25);
  });

  // 2. Expire stale Telegram linking challenges — an expired challenge can
  //    never advance to a verified/linked state later.
  await step('link_challenges', async () => {
    const res = await env.DB.prepare(
      `UPDATE link_challenges SET state = 'expired'
        WHERE state IN ('pending','contact_received','phone_verified','browser_confirmed')
          AND expires_at < ? AND consumed_at IS NULL`
    )
      .bind(nowIso)
      .run();
    report.expired_link_challenges = res.meta.changes ?? 0;
  });

  // 3. Prune long-expired OTP challenges (expiry itself is enforced at read
  //    time; this keeps the table small while retaining a short window for
  //    support review). Only protected verifiers are stored — never codes.
  await step('otp_challenges', async () => {
    const res = await env.DB.prepare('DELETE FROM otp_challenges WHERE expires_at < ?').bind(pruneBefore).run();
    report.pruned_otp_challenges = res.meta.changes ?? 0;
  });

  // 3b. The same, for the EMAIL and WHATSAPP sign-in codes (auth_otp,
  //     migration 0087). Migration 0087's own header called
  //     `idx_auth_otp_expires` "the sweeper's index" while no sweeper existed,
  //     so the table accumulated every expired challenge — and every decoy row
  //     the anti-enumeration path writes for an address with no account, which
  //     is one per probe. A security table that only grows is a slow leak of
  //     exactly the addresses and phone numbers somebody went looking for.
  await step('auth_otp', async () => {
    const res = await env.DB.prepare('DELETE FROM auth_otp WHERE expires_at < ?').bind(pruneBefore).run();
    report.pruned_auth_otp = res.meta.changes ?? 0;
  });

  // 3c. And the sign-up proofs those codes are exchanged for (signup_tickets,
  //     migration 0090). Same reasoning as above and the same mistake not to
  //     repeat: a table of proofs that is never swept is a growing list of the
  //     numbers and addresses somebody went through a sign-up with.
  await step('signup_tickets', async () => {
    const res = await env.DB.prepare('DELETE FROM signup_tickets WHERE expires_at < ?').bind(pruneBefore).run();
    report.pruned_signup_tickets = res.meta.changes ?? 0;
  });

  /**
   * 3b. BACKFILL THE SEARCH INDEX, a chunk at a time.
   *
   * Every product save writes its own index rows, so this is only for the
   * catalogue that existed before migration 0089. It is not in the migration
   * because indexing reads the brand and section NAMES and runs them through
   * the tokeniser — work SQL cannot do — and because a shop with thousands of
   * products cannot be indexed inside one invocation, so pretending otherwise
   * would mean a backfill that silently stops halfway.
   *
   * Bounded per run and resumable: it takes the products with no rows in the
   * index, oldest id first, and does fifty. A shop of any size converges in a
   * few hours of cron, and a shop that is already indexed does one cheap query
   * that returns nothing.
   */
  await step('search_index_backfill', async () => {
    // A Worker can be live one migration ahead of the database. `step` would
    // catch the "no such table", but it would also report an error on every
    // cron run until the migration lands, which is noise in the one place an
    // operator looks for real failures.
    if (!(await searchIndexInstalled(env.DB))) return;
    const { results } = await env.DB.prepare(
      `SELECT p.id, p.name, p.name_ar, p.name_ku, p.description, p.hashtags, p.sku, p.brand_id,
              p.category_id, p.sub_category_id
         FROM products p
        WHERE p.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM search_tokens t WHERE t.product_id = p.id)
        ORDER BY p.id
        LIMIT 50`
    ).all<Record<string, unknown>>();
    if (!results || results.length === 0) return;

    const nameIds = [
      ...new Set(
        results.flatMap((r) => [r.brand_id, r.category_id, r.sub_category_id]).filter((x): x is string => typeof x === 'string' && x !== '')
      ),
    ];
    const names = new Map<string, string>();
    if (nameIds.length > 0) {
      const ph = nameIds.map(() => '?').join(',');
      const { results: rows } = await env.DB.prepare(
        `SELECT id, COALESCE(NULLIF(name_en,''), name_ar) AS n FROM brands WHERE id IN (${ph})
         UNION ALL
         SELECT id, COALESCE(NULLIF(name_en,''), name_ar) AS n FROM catalogs WHERE id IN (${ph})`
      )
        .bind(...nameIds, ...nameIds)
        .all<{ id: string; n: string }>();
      for (const r of rows ?? []) names.set(String(r.id), String(r.n ?? ''));
    }

    const stmts: D1PreparedStatement[] = [];
    for (const r of results) {
      stmts.push(
        ...planSearchIndex(
          env.DB,
          toSearchDoc({
            id: String(r.id),
            name: r.name,
            name_ar: r.name_ar,
            name_ku: r.name_ku,
            description: r.description,
            hashtags: r.hashtags,
            sku: r.sku,
            brandName: names.get(String(r.brand_id ?? '')) ?? null,
            categoryNames: [names.get(String(r.category_id ?? '')) ?? '', names.get(String(r.sub_category_id ?? '')) ?? ''].filter(Boolean),
          })
        )
      );
    }
    if (stmts.length > 0) await env.DB.batch(stmts);
    report.search_indexed = results.length;
  });

  // 4. Prune consumed/long-expired email-verification tokens.
  await step('email_verification_tokens', async () => {
    const res = await env.DB.prepare(
      'DELETE FROM email_verification_tokens WHERE expires_at < ? OR (used = 1 AND created_at < ?)'
    )
      .bind(pruneBefore, pruneBefore)
      .run();
    report.pruned_email_tokens = res.meta.changes ?? 0;
  });

  // 5. Prune consumed/long-expired password-reset tokens.
  await step('password_reset_tokens', async () => {
    const res = await env.DB.prepare(
      'DELETE FROM password_reset_tokens WHERE expires_at < ? OR (used = 1 AND created_at < ?)'
    )
      .bind(pruneBefore, pruneBefore)
      .run();
    report.pruned_reset_tokens = res.meta.changes ?? 0;
  });

  // 6. Drop expired sessions (they are already rejected at read time).
  await step('sessions', async () => {
    const res = await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(nowIso).run();
    report.pruned_sessions = res.meta.changes ?? 0;
  });

  // 7. Release due purchase-points accruals (mandate §4.3). The ONLY place
  //    pending points become spendable: never a page open, never a client
  //    call. An accrual is released solely when BOTH its available_at
  //    (purchase + 7×24h, fixed at purchase) has passed AND a payment
  //    settlement was recorded — so an uncollected COD order keeps waiting,
  //    and a day-9 collection releases on day 9 without a new seven-day
  //    clock. Every release is idempotent and single-winner (conditional
  //    UPDATE + token-guarded ledger insert in one D1 batch), so a retried
  //    cron, an overlapping run or a concurrent settlement-triggered release
  //    can never credit the same points twice.
  await step('points_accruals', async () => {
    report.points_accruals = await releaseDueAccruals(env, 200);
  });

  // 8. Deliver (and retry) the admin-group wallet notifications (§12.1). Each
  //    row is claimed with a compare-and-swap on `attempts`, so an overlapping
  //    run never sends the same operation twice, and a permanently failing row
  //    is parked as `dead` instead of looping forever. This step moves NO
  //    money — the decision buttons it carries call the same guarded service
  //    the site route calls.
  await step('wallet_notifications', async () => {
    report.wallet_notifications = await processWalletNotifications(env, 10);
  });

  // 9. Wallet reconciliation (§11.4). It READS the ledger, the holds and the
  //    withdrawal rows and writes at most ONE audit row when an invariant is
  //    broken. It never releases a hold, never posts a ledger row and never
  //    "fixes" a balance — an anomaly is escalated to a human, not repaired
  //    by a cron job.
  await step('wallet_reconciliation', async () => {
    const rec = await reconcileWallets(env);
    report.wallet_reconciliation = {
      anomalies: rec.anomalies.length,
      sums_match: rec.sums_match,
      committed_holds_without_debit: rec.committed_holds_without_debit,
    };
  });

  // 10. Support-gift entitlements (§3.4): re-evaluate the claims still waiting
  //     on delivery + collection, so a gift becomes due (or is cancelled after
  //     a refund/return) without anyone opening a page. Each order is
  //     re-evaluated through the same idempotent evaluator the delivered
  //     transition uses — UNIQUE(order_id) means a second claim cannot exist.
  await step('support_gifts', async () => {
    report.support_gifts = await reconcileSupportGifts(env, 200);
  });

  // 11. Order tracking stages whose configured wait has elapsed. The sweep
  //     only sees orders that already carry a next_stage_at, and that column
  //     is only ever written for a stage whose successor is `automatic` — so
  //     this can never confirm an order, declare it out for delivery, or
  //     declare it delivered. Those three belong to a person or to the
  //     courier's API, which is exactly what the owner specified.
  await step('order_stages', async () => {
    report.order_stages = await sweepDueStages(env, 200, nowIso);
  });

  // 11b. Abandoned checkouts let go of the stock they were holding (owner
  //      decision 5). AFTER the stage sweep, so an order the clock is about to
  //      promote is judged at its current stage, and reported as unconfigured
  //      — not as an error — while the owner has not turned it on, exactly as
  //      delivery_sync reports an unset courier. The selection refuses
  //      anything paid, confirmed, collected, humanly moved, revealed or owned
  //      by a merchant store; see orderExpirySweep.ts for the four layers.
  await step('order_expiry', async () => {
    report.order_expiry = await sweepExpiredOrders(
      env,
      resolveOrderExpiry(await getSetting(env.DB, 'orderExpiryConfig')),
      nowIso
    );
  });

  // 11c. A cancelled order remains visible for support for exactly thirty
  //      days. Afterwards only orders that never reached fulfilment are
  //      removed; serialized/delivered records remain for warranty integrity.
  await step('cancelled_order_retention', async () => {
    report.cancelled_order_retention = await sweepCancelledOrders(env.DB, nowIso, 30, 100);
  });

  /**
   * 11d. «خبرني لما يرجع» — answer the standing restock requests (0092).
   *
   * PLACED HERE, AFTER THE EXPIRY SWEEP, ON PURPOSE. Step 11b releases the
   * units an abandoned checkout was holding, and a release raises availability
   * through `stock_reserved` without touching `stock` at all — one of the
   * paths a ledger hook would never see. Running the alert sweep after it in
   * the SAME tick means a customer whose colour came back because somebody
   * else's basket timed out is told this run rather than next.
   *
   * The two bounds are different questions and are sized differently. 200 alert
   * rows is the write/notify budget; 60 products is the CATALOGUE budget, and
   * it is the smaller of the two because `loadAlertContexts` is seven chunked
   * reads plus the mystery-pool membership read per pass — flat in N, but the
   * rows it pulls back are not. Rows whose product misses the product budget
   * keep their old `last_checked_at` and sort to the front of the next pass, so
   * bounding costs latency and never coverage.
   */
  await step('stock_alerts', async () => {
    report.stock_alerts = await sweepStockAlerts(env, 60, 200);
  });

  // 12. Ask the local courier what happened to the shipments we handed them.
  //     Skipped entirely, and reported as unconfigured rather than as an
  //     error, when the credentials are not set — an unconfigured courier is
  //     a setting nobody has filled in, not a failure worth alerting on.
  await step('delivery_sync', async () => {
    const driver = alwaseetDriver(env, await getSetting(env.DB, 'deliveryConfig'));
    if ('configured' in driver) return;
    const r = await sweepDeliveryStatuses(env, driver, 100, nowIso);
    report.delivery_sync = {
      configured: true, scanned: r.scanned, moved: r.moved, unmapped: r.unmapped, errors: r.errors,
    };
  });

  // 13. Enforce overdue PRO BNPL balances. This is an account-credit action,
  //     never an order-state transition, and is safe under overlapping crons.
  await step('bnpl_overdue', async () => {
    report.bnpl_overdue = await sweepBnplOverdue(env.DB, nowIso, 100);
  });

  // 14. Add the clearly marked system rating once a delivered line has gone
  //     seven days without a customer review. It never enters reward logic.
  await step('automatic_reviews', async () => {
    report.automatic_reviews = await sweepAutomaticReviews(env.DB, nowIso, 200);
  });

  /**
   * 15. DRAIN THE OUTBOX AGAIN, LAST.
   *
   * WHY A SECOND DRAIN AND NOT A BIGGER FIRST ONE. Step 1 runs EARLY — it is
   * the first thing after the event pump, and deliberately so: rows enqueued by
   * REQUESTS since the last tick have been waiting up to fifteen minutes and go
   * out before this run does anything else. But every step after it that
   * enqueues — the wallet notifications, the stage promotions, and now the
   * stock alerts — writes rows the early drain has already walked past. Without
   * a second drain a restock matched at step 11d waits for the NEXT tick, and
   * the cron fires every fifteen minutes, so the shopper's «رجع!» takes up to half an hour to
   * arrive for a fact the shop knew in the first minute. This is the same
   * shape, and the same reason, as the event pump running first and event
   * retention second.
   *
   * AND WHY IT IS BOUNDED RATHER THAN RAISED. `processOutbox` is strict FIFO
   * over one table shared with order invoices and OTP references. A single
   * popular restock with three hundred subscribers puts three hundred alert
   * rows into that queue; raising step 1's limit to swallow them would make
   * EVERY tick pay for the worst case, and would still leave the next order's
   * invoice queued behind three hundred alert messages. A separate bounded
   * drain keeps the normal path's latency where it was and lets a large
   * fan-out spill across a few ticks — which is the right trade for a message
   * that says "it is back" and the wrong one for a receipt.
   */
  await step('outbox_final', async () => {
    report.outbox_final = await processOutbox(env, 25);
  });

  /**
   * 15b. ERASE THE ALERT ROWS WHOSE WORK IS OVER (0092).
   *
   * The owner's ruling: «الصفوف المنتهية ... اجعل الخادم يمحيها تلقائيا». An
   * alert has no deadline — it waits until the product is back, ninety days or
   * a year — but it does have an end: it fires once, and then it is finished.
   * The customer cannot clear what it leaves behind, because DELETE /:id is
   * guarded on the live states so a re-arm finds the SAME row — and «تنبيهاتي»
   * offers the bin only where the server will honour it, so there is no button
   * to press at all. `notified` and `dead` therefore pile up on that page
   * against its hard LIMIT 100; `cancelled` never appears on it (the list route
   * excludes that state) and is pruned as table hygiene. This step is the
   * server doing the clearing instead.
   *
   * ITS OWN STEP, AND AFTER THE SWEEP — both on purpose.
   *
   * Notifying is the feature; pruning is housekeeping, and the two must never
   * compete. Running as a separate `step()` means a prune that throws is
   * caught, named `stock_alert_prune:` and left in `report.errors` while step
   * 11d has ALREADY notified this tick's customers — a throw here cannot reach
   * the sweep, because the sweep is behind it and separately contained. Folded
   * into 11d it would have shared that step's fate in both directions.
   *
   * Placed late, beside `media_cleanup`, for the same reason that one is last:
   * if a tick is going to run out of CPU budget, losing a day of row cleanup
   * costs nothing anybody can see, and losing a customer's «رجع!» does not
   * compare. A partial prune resumes on the next tick with no cursor to keep.
   */
  await step('stock_alert_prune', async () => {
    report.stock_alert_prune = await pruneFinishedStockAlerts(
      env.DB,
      nowIso,
      FINISHED_RETENTION_DAYS,
      PRUNE_RUN_LIMIT
    );
  });

  /**
   * 16. DRAIN THE MEDIA CLEANUP QUEUE, LAST, AND DELIBERATELY SO.
   *
   * It is the only step that talks to R2, it is bounded
   * (`MEDIA_CLEANUP_RUN_LIMIT`), and nothing else in this run depends on its
   * result — so if the Worker's CPU budget is going to run out on a tick, this
   * is the right step to lose. Losing it costs a fifteen-minute delay on
   * reclaiming disk; losing a customer's «رجع!» message does not compare.
   */
  await step('media_cleanup', async () => {
    const outcome = await runGuardedMediaCleanup(env);
    report.media_cleanup = {
      attempted: outcome.attempted,
      deleted: outcome.deleted.length,
      still_referenced: outcome.still_referenced.length,
      dead_lettered: outcome.dead_lettered.length,
      retrying: outcome.retrying.length,
      refusals: outcome.refusals,
    };
  });

  /**
   * THE WATCHDOG, LAST AND ON PURPOSE.
   *
   * Last because it must not consume budget a customer's notification needs,
   * and because it depends on nothing above it. Its own step, because a
   * watchdog that can take the outbox down with it has made the reliability
   * worse than the fault it watches for.
   *
   * It reads `d1_migrations` and `admin_settings` — D1's own table and one that
   * has existed since migration 0001 — so it still works in precisely the
   * condition it reports, a database behind the code. See
   * worker/lib/schemaDriftAlarm.ts.
   */
  await step('schema_drift', async () => {
    report.schema_drift = await checkSchemaDrift(env);
  });

  return report;
}
