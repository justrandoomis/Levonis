/**
 * ONE POINT PER 1,000 IQD — migration 0146 and the points still on hold.
 *
 * «في نظام النقاط اجعل لكل 1000 دينار نقطة واحدة وليس لكل 100 دينار … كذلك في
 * الأشخاص الذين لم يحصلوا على نقاط (لأنها تبقى معلقة لـ7 أيام) عدّل عليها قبل
 * أن يتم المطالبة للمستخدمين جميعهم» (owner, 2026-09-27).
 *
 * The accruals below are written by the REAL code at the v2 rate (100 IQD) on
 * a database migrated up to 0145, then 0146 runs. Proven:
 *   - every accrual still pending is re-rated to v3 before it can be released,
 *     with the multiplier it was frozen at — and the returns already netted
 *     against it are re-rated with it, so the release pays exactly
 *     floor(remaining / 1,000) × multiplier;
 *   - released points (already in the wallet) and cancelled accruals are
 *     history and are not touched;
 *   - a replay re-rates nothing twice, and new orders earn at v3.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, SqliteD1 } from './fixtures/d1';
import {
  buildPurchaseAccrualStatements,
  cancelPendingAccrualStatement,
  getPointsRuleConfig,
  releaseAccrualForOrder,
  resolvePointsRule,
  reversePointsForOrder,
  POINTS_RULE_DEFAULTS,
} from '../worker/lib/pointsOps';
import { checkinBasePoints } from '../worker/lib/pointsTasks';

const DAY = 86_400_000;
const MIGRATIONS = join(ROOT, 'migrations');
const MIGRATION = '0146_points_rate_v3.sql';
const files = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();

function before0146() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of files().filter((x) => x < MIGRATION)) raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES ('u1','Sara','a@x.co','h','customer')`);
  // Production's v2 began with migration 0014, long before these purchases;
  // a fresh database stamps it "now", which would make them v1.
  raw.exec(
    `UPDATE admin_settings SET value = json_set(value, '$.effective_at', '2026-01-01T00:00:00.000Z') WHERE key = 'pointsRuleConfig'`
  );
  const db = new SqliteD1(raw) as unknown as D1Database;
  return { raw, db, env: { DB: db } as never };
}

const run0146 = (raw: DatabaseSync) => raw.exec(readFileSync(join(MIGRATIONS, MIGRATION), 'utf8'));

function seedOrder(raw: DatabaseSync, id: string, merchandiseIqd: number) {
  raw
    .prepare(
      `INSERT INTO orders (id,user_id,address_snapshot,delivery_method_id,delivery_method_snapshot,
                           payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,merchandise_iqd)
       VALUES (?,'u1','{}','standard','{}','wallet',?,1400,?,0,?)`
    )
    .run(id, merchandiseIqd, merchandiseIqd, merchandiseIqd);
}

type Row = {
  id: string; kind: string; points: number; base_points: number | null; eligible_iqd: number;
  iqd_per_point: number; rule_version: string; state: string; multiplier_x100: number;
};
const rowsOf = (raw: DatabaseSync, orderId: string) =>
  raw
    .prepare(`SELECT * FROM points_accruals WHERE order_id = ? ORDER BY kind <> 'purchase', created_at, id`)
    .all(orderId) as unknown as Row[];
const pointBalance = (raw: DatabaseSync) =>
  (raw
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END), 0) AS n
         FROM wallet_transactions WHERE user_id='u1' AND currency='POINT' AND status='approved'`
    )
    .get() as { n: number }).n;

/** Writes one purchase accrual through the checkout's own builder, at the rate stored today. */
async function accrue(
  env: never,
  db: D1Database,
  orderId: string,
  eligibleIqd: number,
  o: { purchasedDaysAgo?: number; settled?: boolean; multiplierX100?: number; tier?: string } = {}
) {
  const purchaseAt = new Date(Date.now() - (o.purchasedDaysAgo ?? 1) * DAY).toISOString();
  const rule = resolvePointsRule(await getPointsRuleConfig(env), purchaseAt);
  const { statements } = buildPurchaseAccrualStatements(env, {
    orderId,
    userId: 'u1',
    purchaseAt,
    netEligibleIqd: eligibleIqd,
    rule,
    settledAtPurchase: o.settled ?? true,
    multiplierX100: o.multiplierX100 ?? 100,
    tier: o.tier ?? 'free',
  });
  await db.batch(statements);
}

/** Every order the owner's sentence is about, written at v2 exactly as production wrote it. */
async function seedV2() {
  const s = before0146();
  const { raw, db, env } = s;
  assert.equal((await getPointsRuleConfig(env)).iqd_per_point, 100, 'the database starts at v2');

  // A: a PREMIUM purchase (frozen ×1.5) still on hold, with two partial returns
  //    netted against it.
  seedOrder(raw, 'A', 75_500);
  await accrue(env, db, 'A', 75_500, { purchasedDaysAgo: 8, multiplierX100: 150, tier: 'prime' });
  await reversePointsForOrder(env, 'A', 'return', { portionIqd: 20_000, sourceRef: 'r1' });
  raw.exec(`UPDATE points_accruals SET created_at = '2026-09-25T10:00:00.000Z' WHERE source_ref = 'order:A:reverse:r1'`);
  await reversePointsForOrder(env, 'A', 'return', { portionIqd: 10_500, sourceRef: 'r2' });
  raw.exec(`UPDATE points_accruals SET created_at = '2026-09-26T10:00:00.000Z' WHERE source_ref = 'order:A:reverse:r2'`);

  // B: already released into the wallet at v2.
  seedOrder(raw, 'B', 30_000);
  await accrue(env, db, 'B', 30_000, { purchasedDaysAgo: 9 });
  assert.equal((await releaseAccrualForOrder(env, 'B')).points, 300);

  // C: a cash-on-delivery order not collected yet.
  seedOrder(raw, 'C', 9_999);
  await accrue(env, db, 'C', 9_999, { settled: false });

  // D: cancelled while on hold.
  seedOrder(raw, 'D', 50_000);
  await accrue(env, db, 'D', 50_000);
  await db.batch([cancelPendingAccrualStatement(env, 'D', 'cancelled', new Date().toISOString())]);

  // E: below one point at the new rate.
  seedOrder(raw, 'E', 999);
  await accrue(env, db, 'E', 999);
  return s;
}

test('at v2, the orders carry what production wrote (the starting point)', async () => {
  const { raw } = await seedV2();
  assert.deepEqual(rowsOf(raw, 'A').map((r) => r.points), [1133, -300, -158]);
  assert.equal(rowsOf(raw, 'C')[0].points, 99);
  assert.equal(rowsOf(raw, 'E')[0].points, 9);
  assert.equal(pointBalance(raw), 300);
});

test('0146 re-rates every pending accrual and the returns netted against it', async () => {
  const { raw, env } = await seedV2();
  run0146(raw);

  const a = rowsOf(raw, 'A');
  // 75,500 → 75 points × 1.5 = 113; after the first return 55,500 → 83; after
  // the second 45,000 → 68. Each return is the step between two targets.
  assert.deepEqual(
    a.map((r) => [r.kind, r.points, r.iqd_per_point, r.rule_version, r.state]),
    [
      ['purchase', 113, 1000, 'v3', 'pending'],
      ['reversal', -30, 1000, 'v3', 'pending'],
      ['reversal', -15, 1000, 'v3', 'pending'],
    ]
  );
  assert.equal(a[0].base_points, 75);
  assert.equal(a[0].multiplier_x100, 150, 'the multiplier stays the one frozen at the purchase');
  assert.deepEqual(a.map((r) => r.eligible_iqd), [75_500, -20_000, -10_500], 'the money basis is not touched');

  assert.equal(rowsOf(raw, 'C')[0].points, 9, '9,999 IQD → 9 points');
  assert.equal(rowsOf(raw, 'C')[0].iqd_per_point, 1000);
  assert.equal(rowsOf(raw, 'E')[0].points, 0, '999 IQD earns nothing at 1,000 per point');

  // History is history.
  const b = rowsOf(raw, 'B')[0];
  assert.deepEqual([b.points, b.iqd_per_point, b.rule_version, b.state], [300, 100, 'v2', 'released']);
  assert.equal(pointBalance(raw), 300, 'points already in the wallet stay there');
  const d = rowsOf(raw, 'D')[0];
  assert.deepEqual([d.points, d.iqd_per_point, d.state], [500, 100, 'cancelled']);

  // The rule itself.
  const config = await getPointsRuleConfig(env);
  assert.equal(config.iqd_per_point, 1000);
  assert.equal(config.version, 'v3');
  const stored = JSON.parse(
    (raw.prepare(`SELECT value FROM admin_settings WHERE key = 'pointsRuleConfig'`).get() as { value: string }).value
  );
  assert.equal(stored.previous_iqd_per_point, 100);
  assert.equal(stored.previous_version, 'v2');
  assert.deepEqual(resolvePointsRule(config, new Date().toISOString()), { iqd_per_point: 1000, version: 'v3', legacy: false });
});

test('the release then pays the re-rated net — and a further return is computed at v3', async () => {
  const { raw, env } = await seedV2();
  run0146(raw);

  // A third return on A, after the migration, through the ordinary code path.
  await reversePointsForOrder(env, 'A', 'return', { portionIqd: 5_000, sourceRef: 'r3' });
  // 40,000 → 40 × 1.5 = 60: the new row removes 68 − 60.
  assert.equal(rowsOf(raw, 'A').at(-1)!.points, -8);

  const released = await releaseAccrualForOrder(env, 'A');
  assert.equal(released.awarded, true);
  assert.equal(released.points, 60);
  assert.equal(pointBalance(raw), 360);
});

test('a replay of 0146 re-rates nothing twice', async () => {
  const { raw } = await seedV2();
  run0146(raw);
  const snapshot = () =>
    JSON.stringify([
      raw.prepare('SELECT * FROM points_accruals ORDER BY id').all(),
      raw.prepare(`SELECT value FROM admin_settings WHERE key = 'pointsRuleConfig'`).get(),
    ]);
  const once = snapshot();
  run0146(raw);
  assert.equal(snapshot(), once);
});

test('the code agrees without the row: v3 is the default rule', () => {
  assert.equal(POINTS_RULE_DEFAULTS.iqd_per_point, 1000);
  assert.equal(POINTS_RULE_DEFAULTS.version, 'v3');
});

test('the check-in pays 1, 2, 3, 4, 5, 6, then 7 from the seventh day on', () => {
  assert.deepEqual(
    Array.from({ length: 10 }, (_, i) => checkinBasePoints(i + 1)),
    [1, 2, 3, 4, 5, 6, 7, 7, 7, 7]
  );
  assert.equal(checkinBasePoints(0), 1, 'a broken streak starts again at one');
  assert.equal(checkinBasePoints(400), 7);
});
