/**
 * THE SERVER ERASES A FINISHED ALERT — «الصفوف المنتهية ... اجعل الخادم يمحيها
 * تلقائيا».
 *
 * WHAT IS BEING GUARDED. An alert («خبرني لما يرجع», migration 0092) has no
 * deadline: it waits until the product is buyable again, ninety days or a year,
 * and then it fires ONCE and is over. It never re-arms itself — only a fresh
 * «نبّهني» makes a new one. So `notified`, `cancelled` and `dead` are rows with
 * no future, and the customer cannot clear a single one of them: DELETE /:id is
 * guarded on `state IN ('armed','firing')` deliberately, so that a re-arm finds
 * the SAME row rather than starting a second beside it. Left alone, «تنبيهاتي»
 * becomes a history the person cannot empty, against the route's hard LIMIT 100.
 *
 * `pruneFinishedStockAlerts` is the server doing the clearing. The properties
 * asserted here are the ones that make it safe rather than merely effective:
 *
 *  - a finished row survives its retention window and is erased after it — both
 *    halves, because a prune that deletes too early wipes the list the customer
 *    is opening from the notification they just received;
 *  - an `armed` row is NEVER erased, at any age. It is the promise itself;
 *  - a `firing` row is NEVER erased, at any age. A notification is in flight and
 *    `settleFiring` is the only thing allowed to judge it;
 *  - the run is BOUNDED and a partial prune resumes on the next tick, because a
 *    first pass over a year of history that tries to do it all in one
 *    invocation dies on CPU — and then dies identically on every tick after;
 *  - a prune that THROWS does not stop customers being notified. Notifying is
 *    the feature; pruning is housekeeping.
 *
 * TECHNIQUE. A real SQLite database built from the REAL migration files
 * (`tests/fixtures/app.ts`, the same harness tests/stockAlertDegraded.test.ts
 * uses), never a hand-written copy of the schema — the CHECK constraint on
 * `state` and the unique index on the target are part of what is being tested.
 * The containment test goes through `runDurableJobs`, so the claim "the sweep
 * still notified" is executed rather than argued.
 *
 * WHAT IT CANNOT PROVE: D1's real CPU limit (the bound is reasoned about in
 * worker/lib/stockAlerts.ts, not executed here), and Cloudflare firing the cron.
 *
 * Run: node --import tsx --test tests/stockAlertPrune.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

import { freshDb, asD1, all, count } from './fixtures/app';
import { SqliteD1 } from './fixtures/d1';
import {
  pruneFinishedStockAlerts,
  FINISHED_RETENTION_DAYS,
  PRUNE_RUN_LIMIT,
} from '../worker/lib/stockAlerts';
import { runDurableJobs } from '../worker/lib/jobs';
import type { Env } from '../worker/lib/types';

// A fixed instant, so "thirty-one days ago" means the same thing on every run
// and a test that passes today cannot fail at midnight.
const NOW_MS = Date.UTC(2026, 5, 1, 12, 0, 0);
const NOW = new Date(NOW_MS).toISOString();
const daysAgo = (n: number) => new Date(NOW_MS - n * 86_400_000).toISOString();

/**
 * A customer, and a product with two models — one of them on the shelf. Copied
 * in shape from tests/stockAlertDegraded.test.ts so the sweep in the last test
 * is judging a product this repo already agrees is buyable.
 */
function seed(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash) VALUES ('u1','Sara','s@x.co','h');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,selling_type,sale_types,inventory_mode,stock)
      VALUES ('p1','a1','A1 printer','طابعة A1',900000,'active','direct_sale','["direct_sale"]','OPTION',NULL);
    INSERT INTO product_option_groups (id,product_id,name_en,active,sort)
      VALUES ('g1','p1','Model',1,0);
    INSERT INTO product_option_values (id,product_id,group_id,name_en,name_ar,active,stock,sort)
      VALUES ('v_big','p1','g1','Large','كبير',1,5,0),
             ('v_small','p1','g1','Small','صغير',1,0,1);
  `);
}

/**
 * One alert row, written the way the app writes them.
 *
 * `option_value_id` carries NO foreign key (0092 says why: the '' sentinel is
 * not a row in any table), so a synthetic id is a legal way to make many
 * distinct rows for one customer on one product — the unique index is over
 * (user_id, product_id, kind, option_value_id, color_id), and those ids are
 * what makes each row a different wish.
 */
function alert(
  raw: DatabaseSync,
  id: string,
  state: string,
  lastCheckedAt: string,
  optionValueId = id
): void {
  raw
    .prepare(
      `INSERT INTO product_stock_alerts
         (id, user_id, product_id, kind, option_value_id, color_id, state, arm_seq,
          last_available, last_buyable, armed_channel, armed_at, last_checked_at,
          notified_at, expires_at, dead_reason)
       VALUES (?, 'u1', 'p1', 'option_value', ?, '', ?, 1, 0, 0, 'inapp', ?, ?, '', '', '')`
    )
    .run(id, optionValueId, state, daysAgo(120), lastCheckedAt);
}

const idsLeft = (raw: DatabaseSync): string[] =>
  all<{ id: string }>(raw, 'SELECT id FROM product_stock_alerts ORDER BY id').map((r) => r.id);

// --------------------------------------------------------------- retention

test('a finished row is erased AFTER the retention window, and not one day before', async () => {
  const raw = freshDb();
  seed(raw);

  // Past the window — the customer has had a month to read them.
  alert(raw, 'old_notified', 'notified', daysAgo(31));
  alert(raw, 'old_cancelled', 'cancelled', daysAgo(45));
  alert(raw, 'old_dead', 'dead', daysAgo(400));
  // Inside the window. `fresh_notified` is the case that forbids a zero
  // retention: the phone buzzed «رجع للبيع» yesterday and this is the row the
  // customer sees when they tap it.
  alert(raw, 'fresh_notified', 'notified', daysAgo(1));
  alert(raw, 'edge_notified', 'notified', daysAgo(29));

  const report = await pruneFinishedStockAlerts(asD1(raw), NOW, FINISHED_RETENTION_DAYS, PRUNE_RUN_LIMIT);

  assert.equal(report.deleted, 3, 'all three finished states are erased, and only past the window');
  assert.equal(report.bound_hit, false, 'three rows is nowhere near the budget');
  assert.deepEqual(idsLeft(raw), ['edge_notified', 'fresh_notified'], 'the recent history survives');
});

test('an armed row is never erased — not at ninety days, not at four hundred', async () => {
  const raw = freshDb();
  seed(raw);
  alert(raw, 'armed_old', 'armed', daysAgo(400));
  alert(raw, 'armed_never_checked', 'armed', '');
  alert(raw, 'gone', 'notified', daysAgo(400));

  // Retention ZERO — the harshest setting the knob allows. Even then the live
  // promise is untouchable: the alert has no deadline, only an end, and it has
  // not ended.
  const report = await pruneFinishedStockAlerts(asD1(raw), NOW, 0, PRUNE_RUN_LIMIT);

  assert.equal(report.deleted, 1);
  assert.deepEqual(idsLeft(raw), ['armed_never_checked', 'armed_old'], 'the standing requests remain');
});

test('a firing row is never erased — its message is still in flight', async () => {
  const raw = freshDb();
  seed(raw);
  // Old enough to be past any retention, and stuck: `settleFiring` re-arms a
  // row like this after six hours. Deleting it instead would destroy the alert
  // while its outbox rows are still being retried — the customer then gets a
  // message whose alert no longer exists, or nothing at all, and can never
  // learn which.
  alert(raw, 'firing_stale', 'firing', daysAgo(365));

  const report = await pruneFinishedStockAlerts(asD1(raw), NOW, 0, PRUNE_RUN_LIMIT);

  assert.equal(report.deleted, 0);
  assert.deepEqual(idsLeft(raw), ['firing_stale']);
});

test('the DELETE names the three finished states rather than negating the live ones', async () => {
  // The rule stated as a property: every state 0092's CHECK constraint allows
  // is present, and exactly the three finished ones go. A future fifth state
  // must be swept in by somebody who decided it should be — not by the absence
  // of its name from a negation.
  const raw = freshDb();
  seed(raw);
  for (const state of ['armed', 'firing', 'notified', 'cancelled', 'dead']) {
    alert(raw, `s_${state}`, state, daysAgo(200));
  }

  await pruneFinishedStockAlerts(asD1(raw), NOW, FINISHED_RETENTION_DAYS, PRUNE_RUN_LIMIT);

  assert.deepEqual(idsLeft(raw), ['s_armed', 's_firing']);
});

test('and it names them LITERALLY — the negation is what a future state falls into', () => {
  /*
   * THE ASSERTION ABOVE CANNOT FAIL FOR THE REASON THE RULE EXISTS, and that is
   * worth saying plainly rather than trusting the test above to cover it.
   * 0092's CHECK constraint allows exactly five states, so over ANY seed of
   * those five `state IN ('notified','cancelled','dead')` and
   * `state NOT IN ('armed','firing')` select the identical rows. Swap one for
   * the other in production and every behavioural test here still passes.
   *
   * The defect the rule exists to prevent is not observable today at all: it is
   * a SIXTH state added to 0092 next year — a second in-flight state, a
   * 'paused', a 'held' — being swept into a DELETE by the absence of its name
   * from a negation, and the first anybody hears of it is a customer's alert
   * gone. The only thing that can fail on that edit is a test that reads the
   * statement, so this one does.
   *
   * Comments are stripped first: the function's own note QUOTES the negation in
   * order to forbid it.
   */
  const src = readFileSync(new URL('../worker/lib/stockAlerts.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const fn = /export async function pruneFinishedStockAlerts\([\s\S]*?\n}/.exec(src);
  assert.ok(fn, 'pruneFinishedStockAlerts is still where the prune lives');
  assert.match(
    fn[0],
    /state IN \('notified','cancelled','dead'\)/,
    'the DELETE still names the three finished states one by one'
  );
  assert.doesNotMatch(
    fn[0],
    /state NOT IN/,
    'and never selects its victims by what they are NOT — that is a standing order to delete a state nobody has written yet'
  );
});

test('a finished row with no recorded finish instant is left alone, not erased instantly', async () => {
  // '' sorts BEFORE every ISO timestamp, so a plain `< cutoff` would delete
  // such a row on the first tick. No code path produces one — every transition
  // into a finished state writes `last_checked_at` — so it is hand-edited or
  // half-migrated, and a row we cannot date is a row we do not erase.
  const raw = freshDb();
  seed(raw);
  alert(raw, 'undated', 'notified', '');

  const report = await pruneFinishedStockAlerts(asD1(raw), NOW, 0, PRUNE_RUN_LIMIT);

  assert.equal(report.deleted, 0);
  assert.deepEqual(idsLeft(raw), ['undated']);
});

// ------------------------------------------------------------- the bound

test('the run is bounded, says so, and the leftovers are cleared by the next tick', async () => {
  const raw = freshDb();
  seed(raw);
  for (let i = 0; i < 5; i += 1) alert(raw, `n${i}`, 'notified', daysAgo(100));

  const db = asD1(raw);
  const first = await pruneFinishedStockAlerts(db, NOW, FINISHED_RETENTION_DAYS, 2);
  assert.equal(first.deleted, 2, 'the budget is a ceiling, not a suggestion');
  assert.equal(first.bound_hit, true, 'and the report says a backlog remains');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_stock_alerts'), 3);

  // RESUMABLE WITH NO CURSOR: the rows it deleted are gone, so the identical
  // query finds the next ones. Nothing is starved, because a candidate only
  // ever LEAVES the set.
  const second = await pruneFinishedStockAlerts(db, NOW, FINISHED_RETENTION_DAYS, 2);
  assert.equal(second.deleted, 2);
  const third = await pruneFinishedStockAlerts(db, NOW, FINISHED_RETENTION_DAYS, 2);
  assert.equal(third.deleted, 1);
  assert.equal(third.bound_hit, false, 'the backlog is cleared');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_stock_alerts'), 0);

  const empty = await pruneFinishedStockAlerts(db, NOW, FINISHED_RETENTION_DAYS, 2);
  assert.equal(empty.deleted, 0, 'and an empty backlog is one cheap statement, not an error');
});

test('the bound the cron actually passes is the exported one, and it holds', async () => {
  const raw = freshDb();
  seed(raw);
  const total = PRUNE_RUN_LIMIT + 3;
  for (let i = 0; i < total; i += 1) alert(raw, `b${String(i).padStart(4, '0')}`, 'notified', daysAgo(90));

  const report = await pruneFinishedStockAlerts(asD1(raw), NOW, FINISHED_RETENTION_DAYS, PRUNE_RUN_LIMIT);

  assert.equal(report.deleted, PRUNE_RUN_LIMIT, 'one invocation never exceeds its budget');
  assert.equal(report.bound_hit, true);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM product_stock_alerts'), 3, 'the rest wait for the next tick');
});

// --------------------------------------------------------- the containment

/**
 * A database whose DELETE against the alerts table fails the way a real one
 * does — and nothing else. Same technique as tests/mediaCleanupSchedule.test.ts,
 * and for the same reason: "the step is contained internally" and "the step
 * cannot take the run down" are different claims, and only the second one is
 * worth a test.
 */
function brokenDeleteDb(raw: DatabaseSync): D1Database {
  const real = new SqliteD1(raw);
  return {
    prepare(sql: string) {
      const stmt = real.prepare(sql);
      const guard = () => {
        if (/DELETE\s+FROM\s+product_stock_alerts/i.test(sql)) {
          throw new Error('D1_ERROR: Network connection lost');
        }
      };
      const wrap = (bound: ReturnType<SqliteD1['prepare']>) => ({
        bind: (...values: unknown[]) => wrap(bound.bind(...values)),
        run: async () => { guard(); return bound.run(); },
        first: async () => { guard(); return bound.first(); },
        all: async () => { guard(); return bound.all(); },
      });
      return wrap(stmt) as unknown as D1PreparedStatement;
    },
    batch: (statements: unknown[]) => real.batch(statements as never[]),
  } as unknown as D1Database;
}

test('a prune that throws never costs a customer their «رجع!» — the sweep still notifies', async () => {
  const raw = freshDb();
  seed(raw);

  // The live promise: armed on the model that IS on the shelf, with
  // `last_buyable = 0`, which is the edge the sweep fires on.
  raw
    .prepare(
      `INSERT INTO product_stock_alerts
         (id, user_id, product_id, kind, option_value_id, color_id, state, arm_seq,
          last_available, last_buyable, armed_channel, armed_at, last_checked_at,
          notified_at, expires_at, dead_reason)
       VALUES ('live','u1','p1','option_value','v_big','','armed',1,0,0,'inapp',?,'','','','')`
    )
    .run(daysAgo(95));
  // And a finished row the prune would have erased if it could.
  alert(raw, 'history', 'notified', daysAgo(200), 'v_small');

  const env = { DB: brokenDeleteDb(raw) } as unknown as Env;

  const logged: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  let report;
  try {
    report = await runDurableJobs(env);
  } finally {
    console.error = realError;
  }

  // THE FEATURE RAN. Ninety-five days of waiting, answered on the tick that the
  // housekeeping failed on.
  assert.equal(report.stock_alerts.matched, 1, 'the sweep found the edge');
  assert.equal(report.stock_alerts.notified, 1, 'and consumed the alert as delivered (in-app is the floor)');
  assert.equal(
    (raw.prepare("SELECT state FROM product_stock_alerts WHERE id = 'live'").get() as { state: string }).state,
    'notified'
  );
  assert.equal(
    count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'u1' AND kind = 'stock_back'"),
    1,
    'the in-app row the customer can still find tomorrow'
  );
  assert.ok(!report.errors.some((e) => e.startsWith('stock_alerts:')), 'the sweep itself did not fail');

  // AND THE HOUSEKEEPING FAILED LOUDLY, in its own name, without taking
  // anything with it.
  assert.ok(
    report.errors.some((e) => e.startsWith('stock_alert_prune:')),
    `the prune's failure is attributed to its own step, got ${JSON.stringify(report.errors)}`
  );
  assert.ok(logged.some((l) => l.includes('stock_alert_prune')), 'and logged where an operator looks');
  assert.deepEqual(report.stock_alert_prune, { deleted: 0, bound_hit: false }, 'the report keeps its shape');
  assert.equal(
    count(raw, "SELECT COUNT(*) AS n FROM product_stock_alerts WHERE id = 'history'"),
    1,
    'a table it could not delete from is a table it must not have half-emptied'
  );
  assert.ok(report.ran_at, 'and the run completed and dated itself');
});
