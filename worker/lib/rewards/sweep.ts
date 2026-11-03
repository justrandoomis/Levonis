/**
 * THE REWARDS PROGRAMME'S QUARTER-HOUR WORK (worker/lib/jobs.ts step
 * `reward_coupons`), bounded so it fits the tick's share of D1's 1,000
 * statements (worker/lib/quarterHourBudget.ts):
 *
 *   1. CATCH-UP. `runOrderDeliveredEffects` issues a printer's coupons the
 *      moment its order is delivered, and contains its own failure; this
 *      retries an order whose issue did not happen. Never retroactive: only
 *      orders delivered AFTER migration 0220 reached this database (its own
 *      `d1_migrations.applied_at`) and in the last two days — so turning the
 *      programme on cannot hand coupons to deliveries it was never promised to
 *      (DECISIONS row 106: nothing is granted after the fact without the
 *      owner). A database that cannot say when 0220 arrived catches up
 *      nothing.
 *   2. THE 24-HOUR REMINDER. One in-app notice per customer for the reward
 *      coupons that end within a day and are still unused, then marked so it
 *      is never sent twice.
 *
 * Both halves are idempotent: the catch-up through `source_ref`, the reminder
 * through `reminded_at` and the notice's event key.
 */
import type { Env } from '../types';
import { isSchemaMissing } from '../membershipBenefits';
import { notifyStatement } from '../notifications';
import { issuePrinterRewards } from './coupons';
import { rewardText } from './strings';

export const REWARD_MIGRATION = '0220_rewards_program.sql';
export const CATCH_UP_WINDOW_MS = 2 * 86_400_000;
export const CATCH_UP_LIMIT = 5;
export const REMINDER_LIMIT = 25;
export const REMINDER_LEAD_MS = 86_400_000;

export interface RewardSweepReport {
  installed: boolean;
  catch_up: { scanned: number; issued: number; errors: number };
  reminders: { coupons: number; customers: number };
}

/** When 0220 reached this database, or null when the bookkeeping cannot say. */
export async function programStartedAt(db: D1Database): Promise<string | null> {
  try {
    const row = await db.prepare('SELECT applied_at FROM d1_migrations WHERE name = ?').bind(REWARD_MIGRATION).first<{ applied_at: string | null }>();
    if (!row?.applied_at) return null;
    // D1 records `CURRENT_TIMESTAMP` («2026-11-04 10:15:00», UTC, no zone).
    const t = Date.parse(/T/.test(row.applied_at) ? row.applied_at : `${row.applied_at.replace(' ', 'T')}Z`);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  } catch {
    return null;
  }
}

export async function runRewardSweep(env: Env, nowIso = new Date().toISOString()): Promise<RewardSweepReport> {
  const report: RewardSweepReport = {
    installed: true,
    catch_up: { scanned: 0, issued: 0, errors: 0 },
    reminders: { coupons: 0, customers: 0 },
  };
  try {
    await catchUp(env, nowIso, report);
    await remind(env.DB, nowIso, report);
  } catch (e) {
    if (isSchemaMissing(e)) return { ...report, installed: false };
    throw e;
  }
  return report;
}

async function catchUp(env: Env, nowIso: string, report: RewardSweepReport): Promise<void> {
  const started = await programStartedAt(env.DB);
  if (!started) return;
  const since = new Date(Math.max(Date.parse(started), Date.parse(nowIso) - CATCH_UP_WINDOW_MS)).toISOString();
  const { results } = await env.DB
    .prepare(
      `SELECT o.id FROM orders o
        WHERE o.status = 'delivered' AND o.delivered_at >= ?1
          AND COALESCE(o.seller_type, 'levonis') <> 'merchant'
          AND NOT EXISTS (SELECT 1 FROM reward_grants g WHERE g.order_id = o.id AND g.source = 'printer')
          AND EXISTS (SELECT 1 FROM order_items oi
                       WHERE oi.order_id = o.id AND oi.product_id IS NOT NULL AND oi.gift_entitlement_id IS NULL
                         AND EXISTS (SELECT 1 FROM product_catalogs pc JOIN catalogs c ON c.id = pc.catalog_id AND c.is_printer_catalog = 1
                                      WHERE pc.product_id = oi.product_id))
        ORDER BY o.delivered_at ASC
        LIMIT ?2`
    )
    .bind(since, CATCH_UP_LIMIT)
    .all<{ id: string }>();
  for (const r of results ?? []) {
    report.catch_up.scanned += 1;
    try {
      const out = await issuePrinterRewards(env, r.id, nowIso);
      report.catch_up.issued += out.issued;
    } catch (e) {
      report.catch_up.errors += 1;
      console.error('reward catch-up failed for order', r.id, e instanceof Error ? e.message : String(e));
    }
  }
}

async function remind(db: D1Database, nowIso: string, report: RewardSweepReport): Promise<void> {
  const until = new Date(Date.parse(nowIso) + REMINDER_LEAD_MS).toISOString();
  const { results } = await db
    .prepare(
      `SELECT g.id, g.user_id, c.ends_at
         FROM reward_grants g JOIN coupons c ON c.id = g.coupon_id
        WHERE g.revoked_at IS NULL AND g.reminded_at IS NULL
          AND g.expires_at > ?1 AND g.expires_at <= ?2
          AND c.active = 1 AND c.ends_at > ?1
          AND NOT EXISTS (SELECT 1 FROM coupon_redemptions r WHERE r.coupon_id = g.coupon_id AND r.state = 'active')
        ORDER BY g.expires_at ASC
        LIMIT ?3`
    )
    .bind(nowIso, until, REMINDER_LIMIT)
    .all<{ id: string; user_id: string; ends_at: string }>();
  const rows = results ?? [];
  if (!rows.length) return;
  const byUser = new Map<string, { ids: string[]; until: string }>();
  for (const r of rows) {
    const day = String(r.ends_at).slice(0, 10);
    const cur = byUser.get(r.user_id) ?? { ids: [], until: day };
    cur.ids.push(r.id);
    if (day < cur.until) cur.until = day;
    byUser.set(r.user_id, cur);
  }
  const statements: D1PreparedStatement[] = [];
  for (const [userId, g] of byUser) {
    const text = rewardText({ kind: 'coupons_expiring', count: g.ids.length, until: g.until });
    statements.push(
      notifyStatement(db, {
        userId,
        kind: 'reward',
        title_ar: text.title.ar,
        title_en: text.title.en,
        body_ar: text.body.ar,
        body_en: text.body.en,
        link: '/points#coupons',
        entity_type: 'reward_grant',
        entity_id: g.ids[0],
        meta: { title_ckb: text.title.ckb, body_ckb: text.body.ckb, grants: g.ids },
        eventKey: `reward:expiring:${g.until}`,
      }).stmt,
      db
        .prepare('UPDATE reward_grants SET reminded_at = ?1 WHERE reminded_at IS NULL AND id IN (SELECT value FROM json_each(?2))')
        .bind(nowIso, JSON.stringify(g.ids))
    );
  }
  await db.batch(statements);
  report.reminders.coupons = rows.length;
  report.reminders.customers = byUser.size;
}
