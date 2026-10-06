/**
 * REVIEW POINTS — moved verbatim out of worker/routes/reviews.ts so both
 * route files (reviews.ts: the automatic fallback points; gifts.ts: the admin
 * approval of a legacy `points` reward) read ONE definition. Owner: lane S1;
 * lane S2 only imports. Behaviour is pinned by tests/reviewMultiplier.test.ts.
 */
import { getTierStatus } from '../entitlements';
import { applyMultiplierX100, multiplierLabel, rewardMultiplierX100 } from '../pointsMultiplier';
import { safeParse } from '../types';

/**
 * Per-review point value for NON-printer approved reviews. Read generically
 * from admin_settings key 'reviewPointsConfig' — no invented number: a
 * missing/disabled/invalid config returns null and the award path renders an
 * honest not-configured state. (Key registration in worker/lib/settings.ts
 * SETTING_DEFAULTS is an orchestrator integration step; this reader works
 * with or without it.)
 */
export async function getReviewPointsValue(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare("SELECT value FROM admin_settings WHERE key = 'reviewPointsConfig'")
    .first<{ value: string }>();
  if (!row) return null;
  const v = safeParse<unknown>(row.value, null);
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  if (v && typeof v === 'object') {
    const o = v as { enabled?: unknown; points?: unknown };
    if (o.enabled === true && typeof o.points === 'number' && Number.isInteger(o.points) && o.points > 0) {
      return o.points;
    }
  }
  return null;
}

/**
 * THE REVIEW AWARD, AT THE REVIEWER'S SUBSCRIPTION MULTIPLIER.
 *
 * The owner's rule covers four surfaces — signing in, earning from tasks,
 * buying, and RATING — and this is the rating one. PREMIUM earns 1.5x and PRO
 * 2x on a review exactly as they do on a check-in, and for the same reason:
 * the multiplier belongs to the member, not to the kind of thing they did.
 *
 * SNAPSHOTTED, NEVER RECOMPUTED. The multiplier is resolved at the moment of
 * the award and the resulting number is what is written; an expired
 * subscription must not rewrite what a member already earned, and a new one
 * must not retroactively inflate it. That is the same discipline
 * `points_accruals` uses for a purchase.
 *
 * The 1x case is byte-identical to the previous behaviour, so a shop with no
 * subscribers sees no change at all.
 */
export async function reviewAward(
  db: D1Database,
  userId: string,
  basePoints: number
): Promise<{ points: number; base: number; multiplierX100: number }> {
  const status = await getTierStatus(db, userId);
  const multiplierX100 = rewardMultiplierX100(status);
  return { points: applyMultiplierX100(basePoints, multiplierX100), base: basePoints, multiplierX100 };
}

/**
 * THE NOTE THE CUSTOMER READS IN THEIR OWN WALLET.
 *
 * It has to add up. `2x base` described the whole award while the fallback
 * was the only multiplier in play; once a membership multiplies it again, a
 * PRO sees 100 points credited under a note that explains 50. The 1x string
 * is left byte-identical, so nothing changes for a shop with no subscribers.
 */
export function fallbackNote(multiplierX100: number): string {
  return multiplierX100 <= 100
    ? 'Valid manual review fallback (2x base)'
    : `Valid manual review fallback (2x base x ${multiplierLabel(multiplierX100)} membership)`;
}
