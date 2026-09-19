/**
 * ONE PRESS OF «نبّهني», ONE MESSAGE — THE TWO WAYS THAT WAS NOT TRUE.
 *
 * The owner's lifecycle is a one-shot promise: an alert waits as long as it
 * takes, fires ONCE, and is then finished. Nothing in this suite is about the
 * lifecycle itself (tests/stockAlertLifecycle.test.ts holds that); it is about
 * the two ways the sweep could send the SAME restock twice, both of which are
 * invisible afterwards — «تنبيهاتي» shows one row, the shop's report shows one
 * match, and only the customer's phone knows it buzzed twice.
 *
 *   1. TWO OVERLAPPING CRON RUNS. `runDurableJobs` is handed to
 *      `ctx.waitUntil` with no lock, so a run that outlives the fifteen-minute
 *      gap overlaps the next. Both passes SELECT the same armed row, both see
 *      the edge, and both fire — and neither is deduped, because every key this
 *      module writes carries the FIRING INSTANT and the two passes computed
 *      different instants. The old state guard (`WHERE id = ? AND state =
 *      'armed'`) protected the row and never the message: the loser's UPDATE
 *      matched nothing, which is not an error, so its batch committed the
 *      notification sitting beside it anyway.
 *
 *      The answer is the CLAIM — 'armed' -> 'firing' before anything is
 *      composed — and its recovery half: the claim leaves `notified_at` EMPTY,
 *      so a pass that dies between the claim and the message leaves a shape
 *      `settleFiring` can recognise and re-arm. The grace window is what keeps
 *      it from re-arming a fire that is merely in flight, which would buy back
 *      the very duplicate the claim removed.
 *
 *   2. ONE GROUP CUT IN HALF BY THE PAGE. The sweep reads `LIMIT ?` and writes
 *      one message per (customer, product). A customer may hold up to twenty
 *      wishes on one product; if the page boundary falls inside that set, the
 *      half on the page fires now and the half left behind — untouched, still
 *      buyable — fires as a "fresh" group on the next tick. Two messages, one
 *      restock, fifteen minutes apart. The rule is the one the product budget
 *      already keeps one level up: judge a group whole or not at all.
 *
 * TECHNIQUE. A real SQLite database built from the real migrations
 * (tests/fixtures/app.ts), the real sweep, and no channels configured — so the
 * in-app `user_notifications` row IS the message, and counting those rows
 * counts lock-screen buzzes.
 *
 * Run: node --import tsx --test tests/stockAlertConcurrency.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';

import { freshDb, asD1, count } from './fixtures/app';
import { SqliteD1 } from './fixtures/d1';
import { sweepStockAlerts } from '../worker/lib/stockAlerts';
import type { Env } from '../worker/lib/types';

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

/**
 * Two customers and one product with three models, all three on the shelf, so
 * every wish below is genuinely buyable and a pass that declines to fire is
 * declining for the reason under test rather than for want of stock.
 */
function seed(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash)
      VALUES ('u1','Sara','s@x.co','h'), ('u2','Dana','d@x.co','h');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,selling_type,sale_types,inventory_mode,stock)
      VALUES ('p1','a1','A1 printer','طابعة A1',900000,'active','direct_sale','["direct_sale"]','OPTION',NULL);
    INSERT INTO product_option_groups (id,product_id,name_en,active,sort)
      VALUES ('g1','p1','Model',1,0);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,active,stock,sort)
      VALUES ('v_big','p1','g1','Large','كبير',1,5,0),
             ('v_mid','p1','g1','Medium','وسط',1,3,1),
             ('v_small','p1','g1','Small','صغير',1,7,2);
  `);
}

/** One row, exactly as the arm upsert writes one: the edge un-crossed
 *  (`last_buyable = 0`) and never examined (`last_checked_at = ''`). */
function alert(
  raw: DatabaseSync,
  id: string,
  userId: string,
  wish: { kind: string; optionValueId: string },
  over: { state?: string; lastCheckedAt?: string; notifiedAt?: string } = {}
): void {
  raw
    .prepare(
      `INSERT INTO product_stock_alerts
         (id, user_id, product_id, kind, option_value_id, color_id, state, arm_seq,
          last_available, last_buyable, armed_channel, armed_at, last_checked_at,
          notified_at, expires_at, dead_reason)
       VALUES (?, ?, 'p1', ?, ?, '', ?, 1, 0, 0, 'inapp', '2026-01-01T00:00:00.000Z', ?, ?, '', '')`
    )
    .run(
      id,
      userId,
      wish.kind,
      wish.optionValueId,
      over.state ?? 'armed',
      over.lastCheckedAt ?? '',
      over.notifiedAt ?? ''
    );
}

const buzzes = (raw: DatabaseSync, userId: string): number =>
  count(
    raw,
    `SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = '${userId}' AND kind = 'stock_back'`
  );

const stateOf = (raw: DatabaseSync, id: string) =>
  raw
    .prepare('SELECT state, notified_at, last_checked_at, arm_seq, last_buyable FROM product_stock_alerts WHERE id = ?')
    .get(id) as { state: string; notified_at: string; last_checked_at: string; arm_seq: number; last_buyable: number };

// ------------------------------------------------- 1. the overlapping passes

/**
 * A database in which the CLAIM loses. The moment this pass tries to take its
 * rows, the rows are already `firing` — which is exactly what the other
 * invocation's claim, committed a millisecond earlier, would have done. Nothing
 * else about the database is changed, so everything the pass does around the
 * claim executes for real.
 */
function stolenClaimDb(raw: DatabaseSync): D1Database {
  const real = new SqliteD1(raw);
  let stolen = false;
  const steal = (sql: string) => {
    if (stolen || !/SET state = 'firing', notified_at = ''/.test(sql)) return;
    stolen = true;
    raw.exec("UPDATE product_stock_alerts SET state = 'firing' WHERE state = 'armed'");
  };
  return {
    prepare(sql: string) {
      const wrap = (bound: ReturnType<SqliteD1['prepare']>) =>
        ({
          bind: (...values: unknown[]) => wrap(bound.bind(...values)),
          run: async () => {
            steal(sql);
            return bound.run();
          },
          first: async () => bound.first(),
          all: async () => bound.all(),
        }) as unknown as D1PreparedStatement;
      return wrap(real.prepare(sql));
    },
    batch: (statements: unknown[]) => real.batch(statements as never[]),
  } as unknown as D1Database;
}

test('a pass that loses the claim writes NO message — the second buzz never happens', async () => {
  // WHAT BREAKS THIS: deleting the claim, or restoring the old `WHERE id = ?
  // AND state = 'armed'` guard on the fire's own UPDATE and trusting it to
  // stop the message. It never did: a zero-row UPDATE is not an error, so the
  // notification beside it in the same batch commits regardless.
  const raw = freshDb();
  seed(raw);
  alert(raw, 'a1', 'u1', { kind: 'option_value', optionValueId: 'v_big' });

  const report = await sweepStockAlerts({ DB: stolenClaimDb(raw) } as unknown as Env, 60, 200);

  assert.equal(buzzes(raw, 'u1'), 0, 'the pass that did not own the arming said nothing');
  assert.equal(report.matched, 0, 'and did not count a fire it never made');
  assert.equal(report.notified, 0);
  assert.equal(stateOf(raw, 'a1').state, 'firing', 'the row belongs to the invocation that claimed it');
});

test('and the pass that DOES own the arming still fires, exactly once', async () => {
  // The control. Without it the test above passes just as well on a sweep that
  // has stopped notifying anybody at all, which is the worse failure.
  const raw = freshDb();
  seed(raw);
  alert(raw, 'a1', 'u1', { kind: 'option_value', optionValueId: 'v_big' });

  const env = { DB: asD1(raw) } as unknown as Env;
  const first = await sweepStockAlerts(env, 60, 200);
  assert.equal(first.matched, 1, 'the edge was found');
  assert.equal(buzzes(raw, 'u1'), 1, 'and the customer was told');
  assert.equal(stateOf(raw, 'a1').state, 'notified', 'in-app only, so there is nothing to wait for');

  // The owner's own example: the alert is spent, and nothing but a fresh tap
  // may ever wake it. A second pass over the same shelf says nothing.
  const second = await sweepStockAlerts(env, 60, 200);
  assert.equal(second.matched, 0);
  assert.equal(buzzes(raw, 'u1'), 1, 'one arming, one message — for ever');
});

// ------------------------------------ the claim's recovery half, and its risk

test('a claim abandoned mid-flight is returned to armed, so the promise survives a crash', async () => {
  // The shape a dead invocation leaves: claimed (`firing`) with no instant,
  // because the claim deliberately writes none until the message is written
  // beside it. Older than the grace, so it is wreckage rather than a fire in
  // flight.
  const raw = freshDb();
  seed(raw);
  alert(raw, 'a1', 'u1', { kind: 'option_value', optionValueId: 'v_big' }, {
    state: 'firing',
    notifiedAt: '',
    lastCheckedAt: minutesAgo(90),
  });

  const env = { DB: asD1(raw) } as unknown as Env;
  await sweepStockAlerts(env, 60, 200);

  const row = stateOf(raw, 'a1');
  assert.equal(row.state, 'armed', 'the standing request is alive again');
  assert.equal(row.last_buyable, 0, 'with the edge reset, or it could never fire again');
  assert.equal(row.arm_seq, 2, 'and the arming counted');

  // And it really does go on to fire — a recovery that only tidies the state
  // column would be indistinguishable from this one until a customer complained.
  await sweepStockAlerts(env, 60, 200);
  assert.equal(buzzes(raw, 'u1'), 1, 'the message the crash nearly ate');
});

test('a claim still inside its grace is left completely alone — writes nothing at all', async () => {
  /*
   * WHAT BREAKS THIS: shortening the grace to nothing, or "tidying" the settle
   * so that an undated `firing` row is always re-armed. Either one lets an
   * overlapping invocation re-arm a row whose message is being written at that
   * moment: `last_buyable` goes back to 0 under a fire that then commits, the
   * edge is re-detected on the next tick, and the customer is told twice.
   *
   * `last_checked_at` is asserted unchanged because the grace is measured from
   * it. A settle that refreshed it while waiting would make every abandoned
   * claim look permanently fresh, and the test above — the crash recovery —
   * would become unreachable in production without failing here.
   */
  const raw = freshDb();
  seed(raw);
  const claimedAt = minutesAgo(1);
  alert(raw, 'a1', 'u1', { kind: 'option_value', optionValueId: 'v_big' }, {
    state: 'firing',
    notifiedAt: '',
    lastCheckedAt: claimedAt,
  });

  await sweepStockAlerts({ DB: asD1(raw) } as unknown as Env, 60, 200);

  const row = stateOf(raw, 'a1');
  assert.equal(row.state, 'firing', 'the fire in flight keeps its row');
  assert.equal(row.arm_seq, 1, 'it was not re-armed');
  assert.equal(row.last_checked_at, claimedAt, 'and nothing refreshed the clock the grace is read from');
});

// --------------------------------------------- 2. the group cut by the page

test('a customer whose wishes straddle the page boundary is not told twice', async () => {
  /*
   * u1 holds three wishes on one product; u2 holds one. Ordered by
   * `last_checked_at ASC, id ASC` with every row unexamined, the ids place two
   * of u1's rows and u2's row on a page of three, leaving u1's third behind.
   *
   * WHAT BREAKS THIS: removing the completeness check, after which pass one
   * fires for two of u1's rows and pass two fires again for the third — one
   * restock, two «رجع للبيع».
   */
  const raw = freshDb();
  seed(raw);
  alert(raw, 'a1', 'u1', { kind: 'option_value', optionValueId: 'v_big' });
  alert(raw, 'a2', 'u1', { kind: 'option_value', optionValueId: 'v_mid' });
  alert(raw, 'b1', 'u2', { kind: 'product', optionValueId: '' });
  alert(raw, 'c1', 'u1', { kind: 'option_value', optionValueId: 'v_small' });

  const env = { DB: asD1(raw) } as unknown as Env;
  const first = await sweepStockAlerts(env, 60, 3);

  assert.equal(buzzes(raw, 'u2'), 1, 'the whole group on the page is judged and fires');
  assert.equal(buzzes(raw, 'u1'), 0, 'the split group is not fired in halves');
  assert.equal(first.matched, 1, 'and only the complete group counted as matched');
  for (const id of ['a1', 'a2', 'c1']) {
    const row = stateOf(raw, id);
    assert.equal(row.state, 'armed', `${id} is untouched`);
    assert.equal(row.last_checked_at, '', `${id} keeps its place at the front of the next pass`);
  }

  // Next tick: u2's row is spent and out of the driving set, so all three of
  // u1's rows fit — one group, judged whole, ONE message naming all three.
  await sweepStockAlerts(env, 60, 3);
  assert.equal(buzzes(raw, 'u1'), 1, 'told once, about everything that came back');
  assert.equal(buzzes(raw, 'u2'), 1, 'and nobody was told again');
});

test('a page that is full but cuts nothing still fires — the check defers, it does not stall', async () => {
  // The other half of the rule. A group that exactly fills its budget is whole,
  // and a completeness check that could not tell "full" from "cut" would defer
  // it every pass for ever: permanent silence, which is worse than the
  // duplicate it was added to prevent.
  const raw = freshDb();
  seed(raw);
  alert(raw, 'a1', 'u1', { kind: 'option_value', optionValueId: 'v_big' });
  alert(raw, 'a2', 'u1', { kind: 'option_value', optionValueId: 'v_mid' });

  const report = await sweepStockAlerts({ DB: asD1(raw) } as unknown as Env, 60, 2);

  assert.equal(report.matched, 2, 'both rows judged');
  assert.equal(buzzes(raw, 'u1'), 1, 'and one message for the pair');
});

test('a budget too small for one group fires it anyway, rather than never', async () => {
  // The last resort, stated as a property. Three wishes cannot be judged whole
  // inside a budget of two, and deferring for ever would mean the customer is
  // never told at all. A duplicate is a nuisance; silence is a broken promise.
  const raw = freshDb();
  seed(raw);
  alert(raw, 'a1', 'u1', { kind: 'option_value', optionValueId: 'v_big' });
  alert(raw, 'a2', 'u1', { kind: 'option_value', optionValueId: 'v_mid' });
  alert(raw, 'a3', 'u1', { kind: 'option_value', optionValueId: 'v_small' });

  await sweepStockAlerts({ DB: asD1(raw) } as unknown as Env, 60, 2);

  assert.equal(buzzes(raw, 'u1'), 1, 'the pass spoke rather than stalling');
});

// ------------------------------------------------------- the claim, in source

test('the fire claims before it composes, and the claim carries no instant', () => {
  /*
   * Two lines of production text that no behavioural test above can pin on its
   * own, and both are the whole defence:
   *
   *   - the fire's own UPDATE is guarded on the state the CLAIM left, not on
   *     'armed'. Restore 'armed' there and two overlapping passes both match
   *     again;
   *   - the claim writes `notified_at = ''`. Give it the instant instead and a
   *     crash between the claim and the message leaves a row `settleFiring`
   *     reads as a delivered fire with no outbox rows — which it settles as
   *     `notified`, consuming an alert nobody was ever told about. That is the
   *     one failure the shopper can neither see nor repair.
   *
   * Comments stripped: the notes around both lines quote what they forbid.
   */
  const src = readFileSync(new URL('../worker/lib/stockAlerts.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const fire = /async function fireGroup\([\s\S]*?\n}/.exec(src);
  assert.ok(fire, 'fireGroup is still the fire');
  assert.match(
    fire[0],
    /SET state = 'firing', notified_at = '', last_checked_at = \?\s*\n\s*WHERE id = \? AND state = 'armed'/,
    'the claim is a compare-and-swap out of armed that writes no firing instant'
  );
  assert.match(
    fire[0],
    /WHERE id = \? AND state = 'firing' AND notified_at = ''/,
    "the message's own UPDATE is guarded on the claim this pass took"
  );
});
