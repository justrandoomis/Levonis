import type { Env } from './types';
import { processOutbox } from './outbox';
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
import type { SupportGiftReconciliation } from './membershipOps';

/**
 * Durable scheduled jobs (final-phase §11): one entrypoint the Worker wires
 * to its cron trigger (scheduled handler + ctx.waitUntil) and that can also
 * be invoked opportunistically. Every step is independent and never throws —
 * one failing step must not starve the others; failures surface sanitized in
 * the returned report and the logs.
 */

export interface DurableJobsReport {
  ran_at: string;
  outbox: { sent: number; failed: number };
  expired_link_challenges: number;
  pruned_otp_challenges: number;
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
  /**
   * Local-courier status sync. Separate from order_stages because it is the
   * only thing allowed to move an order to "في الطريق إليك" or "تم التوصيل":
   * the clock never may, and this only does when the courier says so AND the
   * owner has mapped that status.
   */
  delivery_sync: { configured: boolean; scanned: number; moved: number; unmapped: number; errors: number };
  /** BNPL overdue enforcement is intentionally disabled — see below. */
  bnpl_overdue: 'disabled';
  errors: string[];
}

/** Rows already expired are kept this long for support/audit before pruning. */
const PRUNE_GRACE_DAYS = 7;

export async function runDurableJobs(env: Env): Promise<DurableJobsReport> {
  const nowIso = new Date().toISOString();
  const pruneBefore = new Date(Date.now() - PRUNE_GRACE_DAYS * 86_400_000).toISOString();
  const report: DurableJobsReport = {
    ran_at: nowIso,
    outbox: { sent: 0, failed: 0 },
    expired_link_challenges: 0,
    pruned_otp_challenges: 0,
    pruned_email_tokens: 0,
    pruned_reset_tokens: 0,
    pruned_sessions: 0,
    points_accruals: { scanned: 0, released: 0, points: 0, skipped: 0 },
    wallet_notifications: { sent: 0, failed: 0, dead: 0 },
    wallet_reconciliation: { anomalies: 0, sums_match: true, committed_holds_without_debit: 0 },
    support_gifts: { scanned: 0, cancelled: 0, became_due: 0, flagged: 0 },
    order_stages: { scanned: 0, promoted: 0, skipped: 0, errors: [] },
    delivery_sync: { configured: false, scanned: 0, moved: 0, unmapped: 0, errors: 0 },
    bnpl_overdue: 'disabled',
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

  // 13. BNPL overdue checks — DELIBERATELY DISABLED STUB.
  await step('bnpl_overdue', async () => {
    report.bnpl_overdue = await bnplOverdueCheckStub();
  });

  return report;
}

/**
 * BNPL overdue enforcement stub — the Buy-Now-Pay-Later feature is gated OFF
 * (docs/DECISIONS.md row 21: clock-start event, exposure components and the
 * one-month escalation reference are unresolved owner decisions). Until the
 * owner supplies those rules NOTHING here restricts any account: this stub
 * exists so the scheduled pipeline is already wired when the feature lands,
 * and so nobody mistakes the absence of a job for a finished feature.
 * It reads nothing and writes nothing.
 */
async function bnplOverdueCheckStub(): Promise<'disabled'> {
  return 'disabled';
}
