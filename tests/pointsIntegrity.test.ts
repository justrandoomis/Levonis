/**
 * POINTS INTEGRITY — the adversarial suite.
 *
 * Everything here runs against the REAL migrations, the REAL route module and
 * the REAL points libraries through the node:sqlite D1 adapter. Nothing in
 * this file mocks the code under test: the CHECK constraints, the UNIQUE
 * indexes, the conditional UPDATEs and the "a batch is one transaction"
 * rollback are all genuinely executing.
 *
 * The attacker these tests model is a signed-in customer with devtools open
 * and a copy of the API. They can send any body, any header, any number of
 * concurrent requests, from a device whose clock says anything. What they
 * cannot do is write to the database — so where a test needs SERVER TIME TO
 * HAVE PASSED it reaches into the database and backdates the server's own
 * `started_at`, which is precisely the thing an attacker has no way to touch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, failingD1, freshDb, stubApp, post, get, json, row, all, count, settledPoints, type StubUser } from './fixtures/app';
import { rewardRoutes } from '../worker/routes/rewards';
import { getTierStatus } from '../worker/lib/entitlements';
import {
  applyMultiplierX100,
  multiplierLabel,
  multiplierSql,
  multipliedPointsSql,
  rewardMultiplierX100,
  tierNameSql,
} from '../worker/lib/pointsMultiplier';
import { baghdadDay, checkinBasePoints, readStreak } from '../worker/lib/pointsTasks';
import {
  buildPurchaseAccrual,
  buildPurchaseAccrualStatements,
  recomputeReversal,
  releaseAccrualForOrder,
  resolvePointsRule,
  POINTS_RULE_DEFAULTS,
} from '../worker/lib/pointsOps';

const buyer: StubUser = { id: 'u1', role: 'customer', email: 'a@x.co' };
const appFor = (db: unknown) => stubApp(db, buyer, (a) => a.route('/api/rewards', rewardRoutes));

type Tier = 'plus' | 'prime' | 'pro';

interface Seed {
  tier?: Tier | null;
  /** An 'active' membership row whose expires_at is already in the past. */
  expired?: boolean;
  /** Entitlement names paused by an ACTIVE restriction case. */
  gates?: string[];
  /** admin_settings rewardTaskConfig JSON. */
  taskConfig?: Record<string, unknown>;
  adVideoUrl?: string | null;
}

const PLAN: Record<Tier, string> = { plus: 'plus_12mo', prime: 'prime_12mo', pro: 'pro_12mo' };

function seed(o: Seed = {}): DatabaseSync {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES ('u1','Sara','a@x.co','h','customer')`);
  if (o.tier) {
    const expires = o.expired
      ? new Date(Date.now() - 86_400_000).toISOString()
      : new Date(Date.now() + 365 * 86_400_000).toISOString();
    raw
      .prepare(
        `INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at)
         VALUES ('m1','u1',?,?, 'active',12,?,?)`
      )
      .run(PLAN[o.tier], o.tier, new Date().toISOString(), expires);
  }
  if (o.gates?.length) {
    raw
      .prepare(`INSERT INTO restriction_cases (id,user_id,kind,state,benefit_flags) VALUES ('rc1','u1','other','active',?)`)
      .run(JSON.stringify(o.gates));
  }
  if (o.taskConfig) {
    raw
      .prepare(`INSERT INTO admin_settings (key,value) VALUES ('rewardTaskConfig',?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify(o.taskConfig));
  }
  if (o.adVideoUrl !== null) {
    raw
      .prepare(`INSERT INTO admin_settings (key,value) VALUES ('adVideoUrl',?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify(o.adVideoUrl ?? 'https://cdn.example.com/ad.mp4'));
  }
  return raw;
}

const claims = (raw: DatabaseSync) =>
  all<{
    mission: string; day: string; state: string; points: number; base_points: number | null;
    multiplier_x100: number; tier_at_award: string; streak_day: number | null; idempotency_key: string;
    wallet_tx_id: string; awarded_at: string | null; started_at: string | null; required_seconds: number;
  }>(raw, 'SELECT * FROM reward_claims WHERE user_id = ? ORDER BY rowid', 'u1');

const pointRows = (raw: DatabaseSync) =>
  all<{ id: string; amount: number; note: string; ref: string; type: string }>(
    raw,
    "SELECT id, amount, note, ref, type FROM wallet_transactions WHERE user_id='u1' AND currency='POINT' ORDER BY rowid"
  );

/** Simulates SERVER time having passed — the one thing an attacker cannot do. */
const backdateTicket = (raw: DatabaseSync, mission: string, seconds: number) =>
  raw
    .prepare(
      `UPDATE reward_claims SET started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)
        WHERE user_id='u1' AND mission = ? AND state='started'`
    )
    .run(`-${seconds} seconds`, mission);

// ===========================================================================
// 1. THE MULTIPLIER LADDER — one policy, two evaluators, proven equal
// ===========================================================================

const MATRIX: Seed[] = [
  {},
  { tier: 'plus' },
  { tier: 'prime' },
  { tier: 'pro' },
  { tier: 'prime', expired: true },
  { tier: 'pro', expired: true },
  { tier: 'prime', gates: ['premiumRewards'] },
  { tier: 'pro', gates: ['premiumRewards'] },
  { tier: 'pro', gates: ['priorityService'] },
  { tier: 'pro', gates: ['premiumRewards', 'priorityService'] },
  { tier: 'pro', gates: ['freeDelivery'] },
  { tier: 'plus', gates: ['premiumRewards'] },
];

test('the SQL multiplier and the TypeScript multiplier agree on every tier × expiry × restriction', async () => {
  for (const s of MATRIX) {
    const raw = seed(s);
    const db = asD1(raw);
    const now = new Date().toISOString();
    const status = await getTierStatus(db, 'u1');
    const ts = rewardMultiplierX100(status);
    const sql = row<{ m: number; t: string }>(
      raw,
      `SELECT ${multiplierSql("'u1'", '?')} AS m, ${tierNameSql("'u1'", '?')} AS t`,
      now,
      now
    )!;
    const label = `${s.tier ?? 'free'}${s.expired ? ' expired' : ''}${s.gates ? ` gated:${s.gates}` : ''}`;
    assert.equal(sql.m, ts, `SQL and TS disagree for ${label}`);
    assert.equal(sql.t, status.active ? status.tier : 'free', `tier snapshot wrong for ${label}`);
  }
});

test('the ladder is exactly PREMIUM 1.5× / PRO 2× / everyone else 1×', async () => {
  const cases: Array<[Seed, number, string]> = [
    [{}, 100, '1x'],
    [{ tier: 'plus' }, 100, '1x'],
    [{ tier: 'prime' }, 150, '1.5x'],
    [{ tier: 'pro' }, 200, '2x'],
    // An expired subscription is not a subscription.
    [{ tier: 'pro', expired: true }, 100, '1x'],
    // An admin restriction pauses the benefit without touching the membership.
    [{ tier: 'pro', gates: ['premiumRewards'] }, 100, '1x'],
    // PRO whose priority benefit alone is paused keeps the PREMIUM rate.
    [{ tier: 'pro', gates: ['priorityService'] }, 150, '1.5x'],
  ];
  for (const [s, expected, label] of cases) {
    const status = await getTierStatus(asD1(seed(s)), 'u1');
    assert.equal(rewardMultiplierX100(status), expected, JSON.stringify(s));
    assert.equal(multiplierLabel(expected), label);
  }
});

// ===========================================================================
// 2. ROUNDING — the decision, its boundary, and SQL parity
// ===========================================================================

test('1.5× rounds HALF UP, and the SQL does the identical arithmetic', () => {
  const raw = freshDb();
  // The boundary: every base whose ×1.5 lands on a .5.
  const halves: Array<[number, number]> = [
    [1, 2],   // 1.5  → 2
    [3, 5],   // 4.5  → 5
    [5, 8],   // 7.5  → 8   ← the owner's example: a 5-point check-in at 1.5×
    [7, 11],  // 10.5 → 11
    [15, 23], // 22.5 → 23  (bankers' rounding would say 22 — it does not)
  ];
  for (const [base, expected] of halves) {
    assert.equal(applyMultiplierX100(base, 150), expected, `base ${base} at 1.5x`);
    assert.equal(
      row<{ v: number }>(raw, `SELECT ${multipliedPointsSql('?', '150')} AS v`, base)!.v,
      expected,
      `SQL disagrees for base ${base} at 1.5x`
    );
  }
  // Exact multiples never round at all.
  for (const base of [0, 2, 4, 10, 20, 50]) {
    assert.equal(applyMultiplierX100(base, 150), (base * 3) / 2);
    assert.equal(applyMultiplierX100(base, 200), base * 2);
    assert.equal(applyMultiplierX100(base, 100), base);
    assert.equal(row<{ v: number }>(raw, `SELECT ${multipliedPointsSql('?', '200')} AS v`, base)!.v, base * 2);
  }
});

test('a missing, corrupt or below-1 multiplier degrades to 1× and never shrinks an award', () => {
  for (const bad of [0, -500, NaN, 99, 1]) {
    assert.equal(applyMultiplierX100(20, bad as number), 20);
  }
  assert.equal(applyMultiplierX100(-5, 200), 0, 'a negative base is zero, never a negative award');
});

// ===========================================================================
// 3. THE CLIENT MAY NAME A TASK. IT MAY NEVER NAME AN AMOUNT.
// ===========================================================================

/** Everything a motivated customer would try to stuff into the request. */
const HOSTILE_BODY = {
  points: 999_999,
  base_points: 999_999,
  amount: 999_999,
  multiplier_x100: 10_000,
  multiplier: 100,
  streak: 7,
  streak_day: 7,
  day: '2099-01-01',
  date: '2099-01-01',
  today: '2099-01-01',
  awarded_at: '2099-01-01T00:00:00.000Z',
  started_at: '2000-01-01T00:00:00.000Z',
  required_seconds: 0,
  seconds: 99_999,
  state: 'awarded',
  tier: 'pro',
  tier_at_award: 'pro',
  user_id: 'someone-else',
  mission: 'checkin',
};

test('a crafted body cannot change the amount, the day, the streak or the tier', async () => {
  const raw = seed();
  const res = await post(appFor(asD1(raw)), '/api/rewards/checkin', HOSTILE_BODY);
  const body = await json(res);
  assert.equal(res.status, 200);
  assert.equal(body.points, 5, 'the server ladder decided the amount, not the request');
  assert.equal(body.base_points, 5);
  assert.equal(body.multiplier_x100, 100, 'a free account cannot ask to be PRO');
  assert.equal(body.day, 1, 'the request asked for day 7 and got day 1');

  const [c] = claims(raw);
  assert.equal(c.points, 5);
  assert.equal(c.day, baghdadDay(), 'the row carries the SERVER day, not the 2099 the request sent');
  assert.equal(c.streak_day, 1);
  assert.equal(c.tier_at_award, 'free');
  assert.equal(
    count(raw, 'SELECT COUNT(*) n FROM reward_claims'), 1,
    'the request named another user_id and got no row of its own'
  );
  assert.equal(settledPoints(raw, 'u1'), 5);
  assert.equal(settledPoints(raw, 'someone-else'), 0);
});

test('a PRO account is paid double, and a free account sending tier:pro is not', async () => {
  const proRaw = seed({ tier: 'pro' });
  const pro = await json(await post(appFor(asD1(proRaw)), '/api/rewards/checkin', {}));
  assert.equal(pro.base_points, 5);
  assert.equal(pro.points, 10, 'PRO earns 2× on the daily check-in');
  assert.equal(pro.multiplier_x100, 200);

  const freeRaw = seed();
  const free = await json(await post(appFor(asD1(freeRaw)), '/api/rewards/checkin', { tier: 'pro', multiplier_x100: 200 }));
  assert.equal(free.points, 5, 'claiming to be PRO in the body buys nothing');
});

test('a PREMIUM account is paid 1.5× with the half-up boundary applied end to end', async () => {
  const raw = seed({ tier: 'prime' });
  const body = await json(await post(appFor(asD1(raw)), '/api/rewards/checkin', {}));
  assert.equal(body.base_points, 5);
  assert.equal(body.points, 8, '5 × 1.5 = 7.5, rounded half up');
  assert.equal(body.multiplier_x100, 150);
  const [c] = claims(raw);
  assert.equal(c.multiplier_x100, 150);
  assert.equal(c.tier_at_award, 'prime');
  // The ledger row says WHY it is 8 rather than 5 — the owner's requirement
  // that a subscriber sees the multiplier, not just a bigger number.
  const [tx] = pointRows(raw);
  assert.equal(tx.amount, 8);
  assert.match(tx.note, /5 × 1\.5 \(PRIME\)/);
});

// ===========================================================================
// 4. IDEMPOTENCY — a replay moves nothing, and says so
// ===========================================================================

test('replaying a check-in moves nothing the second time', async () => {
  const raw = seed();
  const app = appFor(asD1(raw));
  assert.equal((await post(app, '/api/rewards/checkin')).status, 200);
  const after = { claims: claims(raw), ledger: pointRows(raw), balance: settledPoints(raw, 'u1') };

  for (let i = 0; i < 3; i++) {
    const res = await post(app, '/api/rewards/checkin');
    assert.equal(res.status, 409, 'a replay is refused, not silently re-paid');
  }
  assert.deepEqual(claims(raw), after.claims, 'no second claim row');
  assert.deepEqual(pointRows(raw), after.ledger, 'no second ledger row');
  assert.equal(settledPoints(raw, 'u1'), after.balance, 'balance unmoved');
  assert.equal(after.balance, 5);
});

test('the one-time push mission is idempotent for the life of the account, not just for today', async () => {
  const raw = seed();
  const app = appFor(asD1(raw));
  assert.equal((await post(app, '/api/rewards/push')).status, 200);
  assert.equal((await post(app, '/api/rewards/push')).status, 409);
  // Move the row to "a different day" the way the calendar would; the period
  // slot is the constant 'once', so nothing reopens.
  raw.exec("UPDATE reward_claims SET created_at = '2020-01-01T00:00:00.000Z' WHERE mission='push'");
  assert.equal((await post(app, '/api/rewards/push')).status, 409);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM reward_claims WHERE mission='push'"), 1);
  assert.equal(settledPoints(raw, 'u1'), 50);
});

test('every award carries the codebase idempotency key and exactly one ledger row', async () => {
  const raw = seed();
  const app = appFor(asD1(raw));
  await post(app, '/api/rewards/checkin');
  await post(app, '/api/rewards/push');
  const today = baghdadDay();
  const rows = claims(raw);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].idempotency_key, `reward:u1:checkin:${today}`);
  assert.equal(rows[1].idempotency_key, 'reward:u1:push:once');
  for (const c of rows) {
    const tx = row<{ amount: number; ref: string }>(
      raw, 'SELECT amount, ref FROM wallet_transactions WHERE id = ?', c.wallet_tx_id
    );
    assert.ok(tx, `claim ${c.mission} has no ledger row`);
    assert.equal(tx!.amount, c.points, 'the credited amount is the claim row, by construction');
    assert.equal(tx!.ref, c.idempotency_key);
  }
  assert.equal(pointRows(raw).length, 2, 'no ledger row without a claim');
});

test('a check-in row written BEFORE migration 0076 still blocks a replay, and the backfilled key matches', async () => {
  const raw = seed();
  const today = baghdadDay();
  // Exactly the columns the pre-0076 code wrote: no state, no idempotency_key,
  // no multiplier, no streak_day. `state` takes its DEFAULT 'awarded', which is
  // the truth about such a row — it is a paid award.
  raw
    .prepare("INSERT INTO reward_claims (id,user_id,mission,day,points) VALUES ('rc_legacy','u1','checkin',?,5)")
    .run(today);
  raw
    .prepare(
      `INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note,ref,created_by,decided_at)
       VALUES ('wtx_legacy','u1','deposit','POINT',5,'approved','Daily Check-in (Day 1)',?, 'system', ?)`
    )
    .run(`mission:checkin:${today}`, new Date().toISOString());

  const res = await post(appFor(asD1(raw)), '/api/rewards/checkin');
  assert.equal(res.status, 409, 'the composite UNIQUE still guards a row the key backfill has not touched');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM reward_claims WHERE mission='checkin'"), 1);
  assert.equal(settledPoints(raw, 'u1'), 5, 'no second credit');

  // And migration 0076\u2019s own backfill derives exactly the key the code writes.
  raw.exec(
    "UPDATE reward_claims SET idempotency_key = 'reward:' || user_id || ':' || mission || ':' || day WHERE idempotency_key IS NULL"
  );
  assert.equal(
    row<{ k: string }>(raw, "SELECT idempotency_key k FROM reward_claims WHERE id='rc_legacy'")!.k,
    `reward:u1:checkin:${today}`
  );
  assert.equal((await post(appFor(asD1(raw)), '/api/rewards/checkin')).status, 409);
});

test('a legacy row is reported as today\u2019s check-in, not as a missing one', async () => {
  const raw = seed();
  const today = baghdadDay();
  raw.prepare("INSERT INTO reward_claims (id,user_id,mission,day,points) VALUES ('rc_l2','u1','checkin',?,15)").run(today);
  raw.exec("UPDATE users SET checkin_streak = 5, last_checkin_day = '" + today + "' WHERE id='u1'");
  const body = await json(await get(appFor(asD1(raw)), '/api/rewards'));
  assert.equal(body.checked_in_today, true);
  assert.equal(body.streak, 5, 'a pre-0076 streak is carried over from the users counter, not reset');
});

// ===========================================================================
// 5. CONCURRENCY — two requests racing leave ONE row
// ===========================================================================

/**
 * HOW THE RACES BELOW ARE RUN, AND WHY IT IS STRONGER THAN Promise.all.
 *
 * The node:sqlite adapter runs a D1 batch as a real BEGIN/COMMIT, and it is a
 * single process — firing four overlapping requests at it produces "cannot
 * start a transaction within a transaction", which is the HARNESS's limit and
 * not the product's. Worse, the interleaving would be whatever the event loop
 * happened to choose, so a green run would prove nothing.
 *
 * `FailingD1.beforeBatch` pins the interleaving instead: the rival request is
 * made to win in the exact window that matters — AFTER this request has read
 * the streak and decided its amount, and BEFORE its own write lands. That is
 * the worst possible moment, chosen deliberately, every run.
 */
function rivalAward(
  raw: DatabaseSync,
  mission: string,
  period: string,
  points: number,
  multiplier = 100,
  tier = 'free'
) {
  const now = new Date().toISOString();
  const id = `rc_rival_${mission}`;
  raw
    .prepare(
      `INSERT INTO reward_claims
         (id,user_id,mission,day,points,base_points,multiplier_x100,tier_at_award,state,awarded_at,idempotency_key,wallet_tx_id)
       VALUES (?,'u1',?,?,?,?,?,?, 'awarded',?,?, 'wtx_rc_' || ?)`
    )
    .run(id, mission, period, points, Math.round((points * 100) / multiplier), multiplier, tier, now,
         `reward:u1:${mission}:${period}`, id);
  raw
    .prepare(
      `INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note,ref,created_by,decided_at)
       VALUES ('wtx_rc_' || ?, 'u1','deposit','POINT',?,'approved','rival',?, 'system', ?)`
    )
    .run(id, points, `reward:u1:${mission}:${period}`, now);
}

test('a concurrent double check-in takes the award exactly once', async () => {
  const raw = seed({ tier: 'pro' });
  const { failing, db } = failingD1(raw);
  const app = stubApp(db, buyer, (a) => a.route('/api/rewards', rewardRoutes));

  let injected = false;
  failing.beforeBatch = (stmts) => {
    if (injected || !stmts.some((s) => s.sql.includes('INSERT INTO reward_claims'))) return;
    injected = true;
    rivalAward(raw, 'checkin', baghdadDay(), 10, 200, 'pro');
  };

  const res = await post(app, '/api/rewards/checkin');
  assert.equal(injected, true, 'the rival really did land inside the window');
  assert.equal(res.status, 409, 'the losing request is refused, not served a second credit');
  assert.equal(count(raw, "SELECT COUNT(*) n FROM reward_claims WHERE mission='checkin'"), 1, 'one row, not two');
  assert.equal(pointRows(raw).length, 1, 'one credit, not two');
  assert.equal(settledPoints(raw, 'u1'), 10, 'PRO: 5 × 2, once');
});

test('a concurrent double push claim takes the award exactly once', async () => {
  const raw = seed();
  const { failing, db } = failingD1(raw);
  const app = stubApp(db, buyer, (a) => a.route('/api/rewards', rewardRoutes));

  let injected = false;
  failing.beforeBatch = (stmts) => {
    if (injected || !stmts.some((s) => s.sql.includes('INSERT INTO reward_claims'))) return;
    injected = true;
    rivalAward(raw, 'push', 'once', 50);
  };

  assert.equal((await post(app, '/api/rewards/push')).status, 409);
  assert.equal(injected, true);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM reward_claims WHERE mission='push'"), 1);
  assert.equal(settledPoints(raw, 'u1'), 50);
});

test('the claim is filed against the SERVER Baghdad day, whatever the device says', async () => {
  const raw = seed();
  const app = appFor(asD1(raw));
  await post(app, '/api/rewards/checkin', { day: '1999-01-01', today: '2099-12-31' });
  const [c] = claims(raw);
  assert.equal(c.day, baghdadDay());
  assert.ok(c.awarded_at && Math.abs(Date.parse(c.awarded_at) - Date.now()) < 60_000, 'awarded_at is now, on the server');
});

test('Baghdad day is UTC+3 and is computed from the server clock alone', () => {
  // 21:30 UTC is already tomorrow in Baghdad; 20:30 UTC is not.
  assert.equal(baghdadDay(0, Date.parse('2026-09-05T21:30:00.000Z')), '2026-09-06');
  assert.equal(baghdadDay(0, Date.parse('2026-09-05T20:30:00.000Z')), '2026-09-05');
  assert.equal(baghdadDay(-1, Date.parse('2026-09-05T21:30:00.000Z')), '2026-09-05');
});

// ===========================================================================
// 7. THE STREAK AND THE DAY COUNTER — the owner's screenshot
// ===========================================================================

test('the streak day is read from the award history, not from the users cache', async () => {
  const raw = seed();
  const db = asD1(raw);
  const today = baghdadDay();
  const yesterday = baghdadDay(-1);
  raw
    .prepare(
      `INSERT INTO reward_claims (id,user_id,mission,day,points,base_points,streak_day,state,awarded_at,idempotency_key,wallet_tx_id)
       VALUES ('rc_y','u1','checkin',?,15,15,5,'awarded',?,?,'wtx_rc_rc_y')`
    )
    .run(yesterday, `${yesterday}T12:00:00.000Z`, `reward:u1:checkin:${yesterday}`);
  // A tampered cache — the number the OLD code would have trusted and paid on.
  raw.exec("UPDATE users SET checkin_streak = 999, last_checkin_day = NULL WHERE id='u1'");

  const streak = await readStreak(db, 'u1', today, yesterday);
  assert.equal(streak.nextDay, 6, 'day 5 yesterday → day 6 today, from the row');

  const body = await json(await post(appFor(db), '/api/rewards/checkin'));
  assert.equal(body.day, 6);
  assert.equal(body.points, checkinBasePoints(6));
  assert.equal(body.points, 15);
});

test('breaking the streak can never pay MORE than continuing it — the ladder is monotonic', () => {
  // The "Day 1 on 9/13 and again on 9/5" in the owner's screenshot is a RESET,
  // and a reset is a loss: day 1 is the cheapest rung there is. There is no day
  // number a customer can manufacture that beats simply carrying on.
  let previous = 0;
  for (let day = 1; day <= 40; day++) {
    const pts = checkinBasePoints(day);
    assert.ok(pts >= previous, `the ladder dips at day ${day}`);
    previous = pts;
  }
  assert.equal(checkinBasePoints(1), 5, 'a reset lands on the cheapest rung');
  assert.equal(checkinBasePoints(7), 20, 'continuing reaches the best rung');
  assert.ok(checkinBasePoints(1) < checkinBasePoints(7));
});

test('a gap in the history resets the counter to 1 and the row records it honestly', async () => {
  const raw = seed();
  const old = baghdadDay(-5);
  raw
    .prepare(
      `INSERT INTO reward_claims (id,user_id,mission,day,points,base_points,streak_day,state,awarded_at,idempotency_key,wallet_tx_id)
       VALUES ('rc_o','u1','checkin',?,20,20,9,'awarded',?,?,'wtx_rc_rc_o')`
    )
    .run(old, `${old}T12:00:00.000Z`, `reward:u1:checkin:${old}`);
  const body = await json(await post(appFor(asD1(raw)), '/api/rewards/checkin'));
  assert.equal(body.day, 1);
  assert.equal(body.points, 5);
  const fresh = claims(raw).find((c) => c.day === baghdadDay())!;
  assert.equal(fresh.streak_day, 1, 'the row says which day number it paid for');
});

test('the history tells the truth: the Baghdad day it credited AND the instant it happened', async () => {
  const raw = seed({ tier: 'prime' });
  const app = appFor(asD1(raw));
  await post(app, '/api/rewards/checkin');
  const body = await json(await get(app, '/api/rewards'));
  assert.equal(body.history.length, 1);
  const h = body.history[0];
  assert.equal(h.mission, 'checkin');
  assert.equal(h.day, baghdadDay(), 'the day credited');
  assert.equal(h.points, 8);
  assert.equal(h.base_points, 5);
  assert.equal(h.multiplier_x100, 150, 'the history explains the number instead of just showing it');
  assert.equal(h.tier_at_award, 'prime');
  assert.equal(h.streak_day, 1);
  assert.ok(Date.parse(h.awarded_at) > 0, 'and when it actually happened');
});

// ===========================================================================
// 8. TASKS THE SERVER TIMES — "Watch Ad"
// ===========================================================================

test('a bare POST to the ad claim pays nothing without a server-issued ticket', async () => {
  const raw = seed();
  const res = await post(appFor(asD1(raw)), '/api/rewards/video', { watched: true, seconds: 99999 });
  const body = await json(res);
  assert.equal(res.status, 400);
  assert.equal(body.code, 'NO_TICKET');
  assert.equal(settledPoints(raw, 'u1'), 0, 'curl -X POST is worth zero');
  assert.equal(claims(raw).length, 0);
});

test('the ad claim is refused until the SERVER says the seconds have passed', async () => {
  const raw = seed({ taskConfig: { video_enabled: true, video_min_seconds: 30, browse_enabled: true, push_enabled: true } });
  const app = appFor(asD1(raw));
  const start = await json(await post(app, '/api/rewards/video/start'));
  assert.equal(start.required_seconds, 30);

  const early = await post(app, '/api/rewards/video', { started_at: '2000-01-01T00:00:00.000Z', required_seconds: 0 });
  assert.equal(early.status, 409);
  assert.equal((await json(early)).code, 'TOO_SOON');
  assert.equal(settledPoints(raw, 'u1'), 0);
  assert.equal(claims(raw)[0].state, 'started', 'still a ticket, never an award');
  assert.equal(pointRows(raw).length, 0);

  backdateTicket(raw, 'video', 30);
  const ok = await json(await post(app, '/api/rewards/video'));
  assert.equal(ok.points, 20);
  assert.equal(claims(raw)[0].state, 'awarded');
  assert.equal(settledPoints(raw, 'u1'), 20);

  assert.equal((await post(app, '/api/rewards/video')).status, 409, 'and only once');
  assert.equal(settledPoints(raw, 'u1'), 20);
});

test('restarting the ad cannot shorten or reset the wait, and cannot mint a second ticket', async () => {
  const raw = seed({ taskConfig: { video_enabled: true, video_min_seconds: 60, browse_enabled: true, push_enabled: true } });
  const app = appFor(asD1(raw));
  await post(app, '/api/rewards/video/start');
  backdateTicket(raw, 'video', 59);
  const firstStart = claims(raw)[0].started_at;

  // Press start again: the earliest start of the day is kept, so the customer
  // neither loses the 59 seconds already waited nor gains a fresh window.
  await post(app, '/api/rewards/video/start');
  assert.equal(claims(raw).length, 1, 'one ticket per day, not one per click');
  assert.equal(claims(raw)[0].started_at, firstStart, 'the clock was not restarted');

  assert.equal((await post(app, '/api/rewards/video')).status, 409, '59 < 60');
  backdateTicket(raw, 'video', 60);
  assert.equal((await post(app, '/api/rewards/video')).status, 200);
  assert.equal(settledPoints(raw, 'u1'), 20);
});

test('concurrent ad claims on one ripe ticket credit exactly once', async () => {
  const raw = seed({ tier: 'prime', taskConfig: { video_enabled: true, video_min_seconds: 10, browse_enabled: true, push_enabled: true } });
  const { failing, db } = failingD1(raw);
  const app = stubApp(db, buyer, (a) => a.route('/api/rewards', rewardRoutes));
  await post(app, '/api/rewards/video/start');
  backdateTicket(raw, 'video', 999);

  // The rival redeems the SAME ticket in the window before this request's own
  // batch. The redemption is a conditional UPDATE on state='started', so the
  // loser matches nothing; its ledger insert is keyed to its own awarded_at
  // token, so that matches nothing either. It writes nothing at all.
  let injected = false;
  failing.beforeBatch = (stmts) => {
    if (injected || !stmts.some((s) => s.sql.includes('UPDATE reward_claims'))) return;
    injected = true;
    const now = new Date().toISOString();
    raw
      .prepare(
        `UPDATE reward_claims SET state='awarded', awarded_at=?, points=30, base_points=20,
                multiplier_x100=150, tier_at_award='prime'
          WHERE user_id='u1' AND mission='video' AND state='started'`
      )
      .run(now);
    raw
      .prepare(
        `INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note,ref,created_by,decided_at)
         SELECT rc.wallet_tx_id,'u1','deposit','POINT',rc.points,'approved','rival',rc.idempotency_key,'system',rc.awarded_at
           FROM reward_claims rc WHERE rc.user_id='u1' AND rc.mission='video'`
      )
      .run();
  };

  const res = await post(app, '/api/rewards/video');
  assert.equal(injected, true);
  assert.equal(res.status, 409, 'the loser is told it is already claimed');
  assert.equal(pointRows(raw).length, 1, 'one credit, not two');
  assert.equal(settledPoints(raw, 'u1'), 30, 'PREMIUM: 20 × 1.5, once');
});

test('the owner can switch an unprovable task off, and it then pays nothing', async () => {
  const raw = seed({ taskConfig: { video_enabled: false, video_min_seconds: 15, browse_enabled: true, push_enabled: true } });
  const app = appFor(asD1(raw));
  const start = await post(app, '/api/rewards/video/start');
  assert.equal(start.status, 503);
  assert.equal((await json(start)).code, 'TASK_DISABLED');
  assert.equal((await post(app, '/api/rewards/video')).status, 503);
  assert.equal(settledPoints(raw, 'u1'), 0);
  const view = await json(await get(app, '/api/rewards'));
  assert.equal(view.missions.video.available, false);
});

// ===========================================================================
// 9. TASKS THE SERVER TIMES — "Browse products"
// ===========================================================================

test('the browse reward needs a started session and the full server wall clock', async () => {
  const raw = seed();
  const app = appFor(asD1(raw));

  const noSession = await post(app, '/api/rewards/browse/ping', { seconds: 999 });
  assert.equal(noSession.status, 400);

  await post(app, '/api/rewards/browse/start');
  // Six pings, each preceded by backdating the server's own last_ping — the
  // only way real seconds accrue. Sending 200 pings in a burst accrues nothing.
  for (let i = 0; i < 20; i++) await post(app, '/api/rewards/browse/ping', { seconds: 9999 });
  assert.ok(
    (row<{ seconds: number }>(raw, "SELECT seconds FROM browse_sessions WHERE user_id='u1'")!.seconds) < 30,
    'a burst of pings buys no time'
  );
  assert.equal(settledPoints(raw, 'u1'), 0);

  for (let i = 0; i < 6; i++) {
    raw.exec("UPDATE browse_sessions SET last_ping = last_ping - 30 WHERE user_id='u1'");
    backdateTicket(raw, 'browse', 180);
    await post(app, '/api/rewards/browse/ping');
  }
  const done = await json(await post(app, '/api/rewards/browse/ping'));
  assert.equal(done.done, true);
  assert.equal(settledPoints(raw, 'u1'), 20);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM reward_claims WHERE mission='browse' AND state='awarded'"), 1);

  // Further pings on a completed mission report honestly and pay nothing.
  const again = await json(await post(app, '/api/rewards/browse/ping'));
  assert.equal(again.awarded, false);
  assert.equal(again.reason, 'already_claimed');
  assert.equal(settledPoints(raw, 'u1'), 20);
});

test('the browse ticket refuses to pay when the accumulated counter outruns the server clock', async () => {
  const raw = seed();
  const app = appFor(asD1(raw));
  await post(app, '/api/rewards/browse/start');
  // Force the progress counter to full without the ticket's own clock having
  // run — the shape a tampered or drifted counter would take. The award UPDATE
  // checks `started_at` INDEPENDENTLY, so nothing is paid.
  raw.exec("UPDATE browse_sessions SET seconds = 180 WHERE user_id='u1'");
  const res = await json(await post(app, '/api/rewards/browse/ping'));
  assert.equal(res.done, true);
  assert.equal(res.awarded, false, 'two server clocks must agree before a point is paid');
  assert.equal(settledPoints(raw, 'u1'), 0);
  assert.equal(pointRows(raw).length, 0);
});

test('restarting the browse mission does not reset the day’s first start', async () => {
  const raw = seed();
  const app = appFor(asD1(raw));
  await post(app, '/api/rewards/browse/start');
  raw.exec("UPDATE browse_sessions SET started_at = started_at - 100, seconds = 40 WHERE user_id='u1'");
  const before = row<{ started_at: number; seconds: number }>(raw, "SELECT started_at, seconds FROM browse_sessions WHERE user_id='u1'")!;
  await post(app, '/api/rewards/browse/start');
  const after = row<{ started_at: number; seconds: number }>(raw, "SELECT started_at, seconds FROM browse_sessions WHERE user_id='u1'")!;
  assert.equal(after.started_at, before.started_at, 'the day’s first start is kept');
  assert.equal(after.seconds, before.seconds, 'progress is kept');
});

// ===========================================================================
// 10. THE PAGE IS TOLD THE TRUTH
// ===========================================================================

test('GET /api/rewards states the multiplier, what it applies to, and what is unprovable', async () => {
  const raw = seed({ tier: 'pro' });
  const body = await json(await get(appFor(asD1(raw)), '/api/rewards'));
  assert.equal(body.multiplier.x100, 200);
  assert.equal(body.multiplier.label, '2x');
  assert.equal(body.multiplier.tier, 'pro');
  assert.deepEqual(body.multiplier.applies_to, ['checkin', 'tasks', 'purchases', 'reviews']);

  // Amounts are server-computed, base and credited, so the page never guesses.
  assert.equal(body.checkin.base_points, 5);
  assert.equal(body.checkin.points, 10);
  assert.equal(body.missions.push.base_points, 50);
  assert.equal(body.missions.push.points, 100);
  assert.equal(body.missions.video.points, 40);
  assert.equal(body.missions.browse.points, 40);

  // The ladder the page draws is the server's, at the server's multiplier.
  assert.deepEqual(
    body.checkin.ladder.map((d: { day: number; points: number }) => [d.day, d.points]),
    [[1, 10], [2, 10], [3, 20], [4, 20], [5, 30], [6, 30], [7, 40]]
  );

  assert.equal(body.checkin.verification, 'server_timed');
  assert.equal(body.missions.video.verification, 'client_asserted');
  assert.equal(body.missions.browse.verification, 'client_asserted');
  assert.equal(body.missions.push.verification, 'client_asserted');
  assert.match(body.missions.video.proof, /cannot prove/);
  assert.ok(Date.parse(body.server_time) > 0, 'the page is given the server clock');
});

test('a PREMIUM member sees 1.5×, and the ladder shows the half-up amounts', async () => {
  const raw = seed({ tier: 'prime' });
  const body = await json(await get(appFor(asD1(raw)), '/api/rewards'));
  assert.equal(body.multiplier.label, '1.5x');
  assert.deepEqual(
    body.checkin.ladder.map((d: { points: number }) => d.points),
    [8, 8, 15, 15, 23, 23, 30]
  );
});

// ===========================================================================
// 11. PURCHASE POINTS — the multiplier is FROZEN at the purchase instant
// ===========================================================================

function seedOrder(raw: DatabaseSync, id: string, totalIqd = 75_000) {
  raw
    .prepare(
      `INSERT INTO orders (id,user_id,address_snapshot,delivery_method_id,delivery_method_snapshot,
                           payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,merchandise_iqd)
       VALUES (?,'u1','{}','standard','{}','wallet',?,1400,?,0,?)`
    )
    .run(id, totalIqd, totalIqd, totalIqd);
}

const accrual = (raw: DatabaseSync, orderId: string) =>
  row<{ points: number; base_points: number; multiplier_x100: number; tier_at_award: string; state: string }>(
    raw,
    "SELECT points, base_points, multiplier_x100, tier_at_award, state FROM points_accruals WHERE order_id = ? AND kind='purchase'",
    orderId
  )!;

test('a PRO purchase freezes ×2 on the accrual row, in the checkout transaction', async () => {
  const raw = seed({ tier: 'pro' });
  const db = asD1(raw);
  seedOrder(raw, 'ORD-1');
  const now = new Date(Date.now() - 8 * 86_400_000).toISOString();
  const rule = resolvePointsRule(POINTS_RULE_DEFAULTS, now);
  const { statements } = buildPurchaseAccrualStatements({ DB: db } as never, {
    orderId: 'ORD-1', userId: 'u1', purchaseAt: now, netEligibleIqd: 75_000, rule, settledAtPurchase: true,
  });
  await db.batch(statements);

  const a = accrual(raw, 'ORD-1');
  assert.equal(a.base_points, 750, '75,000 IQD at 100 IQD per point');
  assert.equal(a.multiplier_x100, 200);
  assert.equal(a.tier_at_award, 'pro');
  assert.equal(a.points, 1500, 'PRO earns double on purchases');
});

test('a subscription that lapses during the seven-day hold cannot rewrite history', async () => {
  const raw = seed({ tier: 'pro' });
  const db = asD1(raw);
  seedOrder(raw, 'ORD-2');
  const purchasedAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
  const rule = resolvePointsRule(POINTS_RULE_DEFAULTS, purchasedAt);
  const { statements } = buildPurchaseAccrualStatements({ DB: db } as never, {
    orderId: 'ORD-2', userId: 'u1', purchaseAt: purchasedAt, netEligibleIqd: 75_000, rule, settledAtPurchase: true,
  });
  await db.batch(statements);
  assert.equal(accrual(raw, 'ORD-2').points, 1500);

  // The membership expires BEFORE the accrual releases.
  raw.exec("UPDATE memberships SET expires_at = '2020-01-01T00:00:00.000Z' WHERE user_id='u1'");
  assert.equal(rewardMultiplierX100(await getTierStatus(db, 'u1')), 100, 'no longer PRO today');

  const released = await releaseAccrualForOrder({ DB: db } as never, 'ORD-2');
  assert.equal(released.awarded, true);
  assert.equal(released.points, 1500, 'the customer keeps what they earned when they bought');
  assert.equal(settledPoints(raw, 'u1'), 1500);
  assert.equal(accrual(raw, 'ORD-2').multiplier_x100, 200, 'the row still says which multiplier paid it');
});

test('a subscription bought AFTER the purchase cannot inflate a pending accrual either', async () => {
  const raw = seed();
  const db = asD1(raw);
  seedOrder(raw, 'ORD-3');
  const purchasedAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
  const { statements } = buildPurchaseAccrualStatements({ DB: db } as never, {
    orderId: 'ORD-3', userId: 'u1', purchaseAt: purchasedAt, netEligibleIqd: 75_000,
    rule: resolvePointsRule(POINTS_RULE_DEFAULTS, purchasedAt), settledAtPurchase: true,
  });
  await db.batch(statements);
  assert.equal(accrual(raw, 'ORD-3').points, 750);

  raw
    .prepare(
      `INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at)
       VALUES ('m9','u1','pro_12mo','pro','active',12,?,?)`
    )
    .run(new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString());

  const released = await releaseAccrualForOrder({ DB: db } as never, 'ORD-3');
  assert.equal(released.points, 750, 'buying PRO later does not re-price an order already placed');
});

test('the async builder reports the exact multiplied figure before the batch runs', async () => {
  const raw = seed({ tier: 'prime' });
  const db = asD1(raw);
  seedOrder(raw, 'ORD-4');
  const now = new Date().toISOString();
  const { statements, accrual: plan } = await buildPurchaseAccrual({ DB: db } as never, {
    orderId: 'ORD-4', userId: 'u1', purchaseAt: now, netEligibleIqd: 75_099,
    rule: resolvePointsRule(POINTS_RULE_DEFAULTS, now), settledAtPurchase: true,
  });
  assert.equal(plan.base_points, 750);
  assert.equal(plan.multiplier_x100, 150);
  assert.equal(plan.points, 1125, '750 × 1.5');
  assert.equal(plan.tier_at_award, 'prime');
  await db.batch(statements);
  assert.equal(accrual(raw, 'ORD-4').points, 1125, 'the plan and the row agree');
});

test('a partial return removes only the multiplied points that were actually returned', () => {
  // 75,000 IQD earned 1,500 points at PRO. Returning half must leave 750 —
  // the other half's earnings — not 375, which is what recomputing from the
  // base rate alone would have clawed back.
  const half = recomputeReversal(1500, 75_000, 37_500, 100, 200);
  assert.equal(half.targetPoints, 750);
  assert.equal(half.removePoints, 750);
  const full = recomputeReversal(1500, 75_000, undefined, 100, 200);
  assert.equal(full.removePoints, 1500);
  assert.equal(full.targetPoints, 0);
  // Without a multiplier the behaviour is exactly what it always was.
  assert.equal(recomputeReversal(750, 75_000, 37_500, 100).removePoints, 375);
});

// ===========================================================================
// 12. POINTS CAN NEVER GO NEGATIVE, AND A SPEND CANNOT INTERLEAVE INTO VALUE
// ===========================================================================

test('the POINT ledger cannot hold a zero or negative amount', () => {
  const raw = seed();
  for (const amount of [0, -5]) {
    assert.throws(
      () =>
        raw
          .prepare(
            `INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,created_by)
             VALUES ('x','u1','deposit','POINT',?,'approved','system')`
          )
          .run(amount),
      /CHECK/,
      `amount ${amount} must be refused by the database`
    );
  }
});

test('a spend races an award without ever creating value or a negative balance', async () => {
  const raw = seed({ tier: 'pro' });
  const db = asD1(raw);
  const app = appFor(db);
  await post(app, '/api/rewards/checkin');
  assert.equal(settledPoints(raw, 'u1'), 10);

  // The codebase's balance-guarded withdrawal: the amount turns negative when
  // the live balance does not cover it, so the CHECK aborts the transaction.
  const spend = (id: string, points: number) =>
    db
      .prepare(
        `INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note,created_by,decided_at)
         SELECT ?1, 'u1', 'withdrawal', 'POINT',
           CASE WHEN (SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END),0)
                        FROM wallet_transactions WHERE user_id='u1' AND currency='POINT' AND status='approved') >= ?2
                THEN ?2 ELSE -1 END,
           'approved', 'spend', 'system', ?3`
      )
      .bind(id, points, new Date().toISOString())
      .run();

  await spend('w1', 10);
  assert.equal(settledPoints(raw, 'u1'), 0);
  await assert.rejects(spend('w2', 1), /CHECK/, 'a spend beyond the balance is refused by the database');
  assert.equal(settledPoints(raw, 'u1'), 0, 'never negative');

  // A replayed award after the spend still cannot re-credit the same day.
  assert.equal((await post(app, '/api/rewards/checkin')).status, 409);
  assert.equal(settledPoints(raw, 'u1'), 0, 'a spend and an award cannot interleave into value');
});

test('every awarded claim has exactly one ledger row and every ledger row has its claim', async () => {
  const raw = seed({ tier: 'prime', taskConfig: { video_enabled: true, video_min_seconds: 5, browse_enabled: true, push_enabled: true } });
  const app = appFor(asD1(raw));
  await post(app, '/api/rewards/checkin');
  await post(app, '/api/rewards/push');
  await post(app, '/api/rewards/video/start');
  backdateTicket(raw, 'video', 10);
  await post(app, '/api/rewards/video');

  const awarded = claims(raw).filter((c) => c.state === 'awarded');
  assert.equal(awarded.length, 3);
  const ledger = pointRows(raw);
  assert.equal(ledger.length, 3, 'no orphan credits');
  assert.equal(
    ledger.reduce((n, t) => n + t.amount, 0),
    awarded.reduce((n, c) => n + c.points, 0),
    'the ledger total is the awards total'
  );
  assert.equal(settledPoints(raw, 'u1'), 8 + 75 + 30, 'PREMIUM: 5→8, 50→75, 20→30');
  for (const c of awarded) {
    assert.equal(count(raw, 'SELECT COUNT(*) n FROM wallet_transactions WHERE id = ?', c.wallet_tx_id), 1);
    assert.equal(c.base_points !== null, true, 'every award records its base');
    assert.ok(c.multiplier_x100 >= 100, 'every award records its multiplier');
    assert.equal(c.points, applyMultiplierX100(c.base_points!, c.multiplier_x100), 'points = base × multiplier');
  }
});
