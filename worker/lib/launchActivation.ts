/**
 * TURNING A RESERVATION INTO A RUNNING MEMBERSHIP — the one implementation.
 *
 * «الموقع يعمل — اجعل البطاقات والاشتراكات تعمل». Before the owner's launch a
 * paid card was written as `prepaid_pending_launch`: full duration reserved,
 * clock not started, and — because `getTierStatus` only ever counts an
 * `active` row — NO benefit at all. The site is live, so there is nothing left
 * to wait for, and a reservation that still exists is a customer who paid and
 * is getting nothing.
 *
 * Two callers share this function, so the dedupe below is written once:
 *
 *   - `POST /api/memberships/admin/activate-launch` sweeps every account, and
 *     stays the owner's button for whatever the lazy path has not reached yet
 *     (an account that has not been seen since the deploy).
 *   - `getTierStatus` (worker/lib/entitlements.ts) converts ONE account the
 *     moment it is read after the launch is live, so no admin action is
 *     needed for a customer to start getting what they paid for. It imports
 *     this module lazily: this file needs `addMonths` from membershipOps,
 *     which itself imports entitlements, and a static import would close that
 *     loop.
 *
 * ONE ACTIVE ROW PER ACCOUNT (migration 0052) is honoured on legacy data, so
 * a conversion can never violate the index half-way through:
 *   - several reservations → the HIGHEST tier starts (tie: the latest
 *     purchase) and the others are cancelled;
 *   - a running row of a lower or equal tier (a 'migrated' row, or one bought
 *     before this rule) is superseded — cancelled — by the reservation the
 *     customer later paid for;
 *   - a running row of a HIGHER tier than the reservation (not reachable
 *     through the purchase rules; legacy admin data only) keeps the
 *     reservation waiting for a human to refund or cancel it — an automatic
 *     downgrade would take away what they hold.
 *
 * THE CLOCK STARTS WHEN THE ROW DOES. `starts_at` is the moment of THIS
 * conversion, never the original launch timestamp: a reservation converted a
 * week after the launch (a straggler, or an account first seen today) used to
 * be backdated to the launch and silently lost that week. On the first
 * activation the two are the same instant.
 *
 * Every write is conditional on the state that was read, one batch per
 * account, so a retry, a concurrent request or the admin sweep racing the
 * lazy path converts a row exactly once.
 */
import { addMonths } from './membershipOps';
import { audit } from './audit';

type PaidTier = 'plus' | 'prime' | 'pro';

const RANK: Record<PaidTier, number> = { plus: 1, prime: 2, pro: 3 };
const rank = (tier: string): number => RANK[tier as PaidTier] ?? 0;

export interface LaunchDeferral {
  user_id: string;
  membership_id: string;
  tier: PaidTier;
  active_id: string;
  active_tier: PaidTier;
}

export interface LaunchConversion {
  /** Reservations that became `active` in this call. */
  converted: number;
  /** Reservations left waiting because the account runs a higher tier. */
  deferred: LaunchDeferral[];
  /** Accounts whose tier changed — their `users.*` cache wants a refresh. */
  affectedUsers: string[];
}

interface PrepaidRow {
  id: string;
  user_id: string;
  tier: PaidTier;
  duration_months: number;
  created_at: string;
}

/**
 * Convert every `prepaid_pending_launch` row — or only `userId`'s — to
 * `active`, starting now.
 *
 * `actorId` is the admin who pressed the button, or null for the automatic
 * per-account conversion. `auditDeferred` is false on the lazy path: a
 * deferred reservation is re-read on every request that resolves that
 * account's tier, and one audit row per page view would bury the one that
 * matters. The admin sweep reports every deferral it sees.
 */
export async function convertLaunchReservations(
  db: D1Database,
  opts: { actorId: string | null; nowIso: string; userId?: string; auditDeferred?: boolean }
): Promise<LaunchConversion> {
  const { actorId, nowIso, userId } = opts;
  const forUser = userId ? ' AND user_id = ?' : '';
  const binds = userId ? [userId] : [];
  const [{ results: prepaid }, { results: running }] = await Promise.all([
    db
      .prepare(
        `SELECT id, user_id, tier, duration_months, created_at FROM memberships
          WHERE state = 'prepaid_pending_launch'${forUser} ORDER BY user_id, created_at`
      )
      .bind(...binds)
      .all<PrepaidRow>(),
    db
      .prepare(
        `SELECT id, user_id, tier FROM memberships
          WHERE state = 'active'${forUser}
            AND user_id IN (SELECT user_id FROM memberships WHERE state = 'prepaid_pending_launch')`
      )
      .bind(...binds)
      .all<{ id: string; user_id: string; tier: PaidTier }>(),
  ]);

  const activeByUser = new Map<string, { id: string; tier: PaidTier }>();
  for (const r of running) activeByUser.set(r.user_id, { id: r.id, tier: r.tier });
  const byUser = new Map<string, PrepaidRow[]>();
  for (const m of prepaid) {
    const list = byUser.get(m.user_id) ?? [];
    list.push(m);
    byUser.set(m.user_id, list);
  }

  let converted = 0;
  const affected = new Set<string>();
  const deferred: LaunchDeferral[] = [];
  for (const [uid, rows] of byUser) {
    const ranked = [...rows].sort((x, y) => rank(y.tier) - rank(x.tier) || y.created_at.localeCompare(x.created_at));
    const winner = ranked[0];
    const losers = ranked.slice(1);
    const active = activeByUser.get(uid) ?? null;
    if (active && rank(active.tier) > rank(winner.tier)) {
      deferred.push({ user_id: uid, membership_id: winner.id, tier: winner.tier, active_id: active.id, active_tier: active.tier });
      continue;
    }
    const stmts: D1PreparedStatement[] = [];
    for (const l of losers) {
      stmts.push(db.prepare("UPDATE memberships SET state = 'cancelled' WHERE id = ? AND state = 'prepaid_pending_launch'").bind(l.id));
    }
    if (active) {
      stmts.push(db.prepare("UPDATE memberships SET state = 'cancelled' WHERE id = ? AND state = 'active'").bind(active.id));
    }
    stmts.push(
      db
        .prepare(
          "UPDATE memberships SET state = 'active', starts_at = ?, expires_at = ? WHERE id = ? AND state = 'prepaid_pending_launch'"
        )
        .bind(nowIso, addMonths(nowIso, winner.duration_months), winner.id)
    );
    let flipped = 0;
    try {
      const res = await db.batch(stmts);
      flipped = res[res.length - 1].meta.changes || 0;
    } catch (e) {
      // One account's batch lost a race (another live row landed between the
      // read and the write, and the one-active index refused it). It rolled
      // back whole; the next read of that account, or the next sweep, tries
      // again against the state that won. The other accounts carry on.
      console.error('launch conversion skipped an account', uid, e instanceof Error ? e.message : String(e));
      continue;
    }
    converted += flipped;
    if (flipped > 0) affected.add(uid);
    if (flipped > 0 && (losers.length > 0 || active)) {
      await audit(db, actorId, 'membership.launch_dedupe', winner.id, {
        user_id: uid,
        activated: { id: winner.id, tier: winner.tier },
        cancelled_prepaid: losers.map((l) => ({ id: l.id, tier: l.tier })),
        superseded_active: active ? { id: active.id, tier: active.tier } : null,
      });
    }
    if (flipped > 0 && actorId === null) {
      // The lazy path has no admin to credit, so it says what it did on its
      // own line — the owner can see every reservation that started by itself.
      await audit(db, null, 'membership.launch_converted', winner.id, {
        user_id: uid,
        tier: winner.tier,
        starts_at: nowIso,
      });
    }
  }
  if (opts.auditDeferred !== false) {
    for (const d of deferred) {
      await audit(db, actorId, 'membership.launch_activation_deferred', d.membership_id, {
        ...d,
        note: 'reservation is a LOWER tier than the running membership — refund or cancel it by hand',
      });
    }
  }
  return { converted, deferred, affectedUsers: [...affected] };
}

/**
 * How many reservations are still waiting — the admin panel's button count.
 *
 * `waiting` is only what the sweep CAN start. A reservation whose account
 * already runs a higher tier is left alone by `convertLaunchReservations`
 * (starting it would be a downgrade), and so are that account's other
 * reservations; counting them kept the button lit forever at «(1)» over a
 * sweep that always reports 0. They are `deferred` instead: the panel shows
 * them as needing a refund or a cancel by hand.
 */
export async function countLaunchReservations(db: D1Database): Promise<{ waiting: number; deferred: number }> {
  const rankOf = (col: string) =>
    `CASE ${col} WHEN 'plus' THEN ${RANK.plus} WHEN 'prime' THEN ${RANK.prime} WHEN 'pro' THEN ${RANK.pro} ELSE 0 END`;
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN EXISTS (
                SELECT 1 FROM memberships a
                 WHERE a.user_id = p.user_id AND a.state = 'active'
                   AND ${rankOf('a.tier')} > (
                     SELECT MAX(${rankOf('q.tier')}) FROM memberships q
                      WHERE q.user_id = p.user_id AND q.state = 'prepaid_pending_launch')
              ) THEN 1 ELSE 0 END), 0) AS deferred
         FROM memberships p
        WHERE p.state = 'prepaid_pending_launch'`
    )
    .first<{ total: number; deferred: number }>();
  const total = Number(row?.total) || 0;
  const deferred = Number(row?.deferred) || 0;
  return { waiting: total - deferred, deferred };
}
