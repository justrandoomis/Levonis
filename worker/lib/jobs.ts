import type { Env } from './types';
import { processOutbox } from './outbox';

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

  // 7. BNPL overdue checks — DELIBERATELY DISABLED STUB.
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
