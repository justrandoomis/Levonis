/**
 * The read models (`packages/contracts/src/http/analytics.ts`).
 *
 * `overview()` answers the counter half of today's `GET /api/admin/overview`
 * (`worker/routes/admin.ts:125-159`) from the rollups, with the field names
 * that route already returns, so the Phase-4 prefix flip is invisible to the
 * SPA. What Analytics CANNOT know is reported as zero and named here rather
 * than guessed:
 *
 *  - `users.total` counts the people who signed up since the bus started, not
 *    the rows in `users`. Analytics owns no user table and never will.
 *  - `users.investors` is 0: the investor flag travels on `RoleChanged`, which
 *    is `personal` and therefore never reaches this store (`03-EVENTS.md` §5
 *    rule 5). The Admin BFF composes it from Identity.
 *  - `orders.pending` is `created − delivered − cancelled` over the range, i.e.
 *    orders still in flight among the ones the range saw — not a live count of
 *    the `orders` table.
 *  - `wallet` counts deposits approved and wallet debits in USD cents; a COD
 *    settlement or an escrow release moves no wallet balance and is excluded.
 *
 * Callers that need the live truth of a table keep asking its owner. That is
 * the design (`01-TARGET.md` §9.2: "the pending-wallet and recent-order LISTS
 * stay with their owning services").
 */
import type { AnalyticsOverviewResponse, DailyMerchantPoint, DailyPlatformPoint } from '@levonis/contracts/http/analytics';
import { METRICS, tierMetric } from './metrics';
import { merchantDaily as merchantDailyRows, platformDaily, platformTotals, type DayRange } from './store';

export type Overview = Omit<AnalyticsOverviewResponse, 'success'>;

const at = (totals: Record<string, number>, metric: string): number => Math.max(0, Math.trunc(totals[metric] ?? 0));

export async function overview(db: D1Database, range: DayRange = {}): Promise<Overview> {
  const totals = await platformTotals(db, range);
  const created = at(totals, METRICS.ordersCreated);
  const delivered = at(totals, METRICS.ordersDelivered);
  const cancelled = at(totals, METRICS.ordersCancelled);
  return {
    orders: {
      total: created,
      pending: Math.max(0, created - delivered - cancelled),
      delivered,
      revenue_iqd: at(totals, METRICS.revenueIqd),
    },
    users: {
      total: at(totals, METRICS.usersCreated),
      pro: at(totals, tierMetric('pro')),
      prime: at(totals, tierMetric('prime')),
      plus: at(totals, tierMetric('plus')),
      investors: 0,
    },
    wallet: {
      incoming_usd_cents: at(totals, METRICS.walletIncomingUsdCents),
      outgoing_usd_cents: at(totals, METRICS.walletOutgoingUsdCents),
    },
    ...(range.from ? { from: range.from } : {}),
    ...(range.to ? { to: range.to } : {}),
  };
}

export async function daily(db: D1Database, opts: DayRange & { metric?: string; limit?: number }): Promise<DailyPlatformPoint[]> {
  return platformDaily(db, opts);
}

/** One merchant, always: a merchant panel may never read another store's numbers. */
export async function merchantDaily(
  db: D1Database,
  merchantId: string,
  opts: DayRange & { metric?: string; limit?: number }
): Promise<DailyMerchantPoint[]> {
  return merchantDailyRows(db, merchantId, opts);
}
