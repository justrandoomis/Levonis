/**
 * OFFER LIMITS — the two-layer pattern, docs/BUNDLES_MYSTERY.md §1.8 and §9.
 *
 * The read-time count is ADVICE for a friendly message. `trg_offer_redemption_limits`
 * (migration 0060) is THE DECISION, and its ABORT rolls the caller's whole batch
 * back — the same contract the coupon limits already follow. So the tests here
 * run the redemption INSERT inside a real `db.batch` beside real money rows and
 * assert that the loser's WHOLE batch disappears, not just its redemption.
 *
 * `UNIQUE (subject_type, subject_id, order_id)` is the other half: an order may
 * legitimately hold two lines of the same bundle (two different colour choices),
 * so checkout writes ONE row per (subject, order) with `qty` summed. Writing one
 * row per line would abort the batch with a message the checkout's catch block
 * does not map — a permanent generic failure on a cart that could never succeed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, count, all } from './fixtures/app';
import { offerLimitAdvice, offerRedemptionStatement, type Subject } from '../worker/lib/offers';

const SUBJECT: Subject = ['product', 'prd_bundle'];

function seed(raw: DatabaseSync, limits: { per_user: number | null; global: number | null }) {
  raw.exec(`
    INSERT INTO users (id,email) VALUES ('u1','a@x.co'),('u2','b@x.co');
    INSERT INTO products (id,slug,name,price_iqd,composition) VALUES ('prd_bundle','b','Bundle',145000,'bundle');
    INSERT INTO orders (id,user_id,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd) VALUES
      ('ORD-1','u1','{}','dm','{}','cod',145000,1400,145000,0),
      ('ORD-2','u1','{}','dm','{}','cod',145000,1400,145000,0),
      ('ORD-3','u2','{}','dm','{}','cod',145000,1400,145000,0);
  `);
  raw
    .prepare('INSERT INTO offer_limits (subject_type,subject_id,max_per_user,max_global) VALUES (?,?,?,?)')
    .run(SUBJECT[0], SUBJECT[1], limits.per_user, limits.global);
}

test('a per-user limit refuses the row that would cross it, and takes the whole batch with it', async () => {
  const raw = freshDb();
  seed(raw, { per_user: 2, global: null });
  const db = asD1(raw);

  await db.batch([offerRedemptionStatement(db, SUBJECT, 'u1', 'ORD-1', 2)]);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM offer_redemptions'), 1);

  let message = '';
  try {
    await db.batch([
      offerRedemptionStatement(db, SUBJECT, 'u1', 'ORD-2', 1),
      db
        .prepare(
          `INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
           VALUES ('wtx_2','u1','withdrawal','USD',10000,'approved','second order')`
        ),
    ]);
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  assert.match(message, /OFFER_PER_USER_LIMIT/);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM offer_redemptions'), 1, 'nothing was added');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM wallet_transactions'), 0, 'the money in the same batch rolled back too');

  // Another user is unaffected by someone else's per-user limit.
  await db.batch([offerRedemptionStatement(db, SUBJECT, 'u2', 'ORD-3', 2)]);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM offer_redemptions'), 2);
});

test('two concurrent checkouts against max_global = 1 produce exactly one redemption', async () => {
  const raw = freshDb();
  seed(raw, { per_user: null, global: 1 });
  const db = asD1(raw);

  // Both callers read "one left" and both proceed — which is exactly why the
  // advice may not be the decision.
  const adviceA = await offerLimitAdvice(db, SUBJECT, 'u1', 1);
  const adviceB = await offerLimitAdvice(db, SUBJECT, 'u2', 1);
  assert.equal(adviceA.ok, true);
  assert.equal(adviceB.ok, true);

  // Both batches were planned against the same "one left" reading; the database
  // serialises them and the LOSER is decided by the trigger, not by the advice.
  // (The harness runs one transaction at a time — which is exactly what D1 does
  // to two writers of the same row.)
  const results: Array<'ok' | string> = [];
  for (const [user, order] of [
    ['u1', 'ORD-1'],
    ['u2', 'ORD-3'],
  ] as const) {
    try {
      await db.batch([offerRedemptionStatement(db, SUBJECT, user, order, 1)]);
      results.push('ok');
    } catch (e) {
      results.push(e instanceof Error ? e.message : String(e));
    }
  }
  assert.equal(results.filter((r) => r === 'ok').length, 1, 'exactly one order');
  assert.match(results.find((r) => r !== 'ok')!, /OFFER_GLOBAL_LIMIT/);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM offer_redemptions'), 1);
});

test('the advisory count agrees with the trigger’s verdict, before and after', async () => {
  const raw = freshDb();
  seed(raw, { per_user: 2, global: 3 });
  const db = asD1(raw);

  assert.equal((await offerLimitAdvice(db, SUBJECT, 'u1', 2)).ok, true);
  assert.equal((await offerLimitAdvice(db, SUBJECT, 'u1', 3)).reason, 'PER_USER_LIMIT_REACHED');

  await db.batch([offerRedemptionStatement(db, SUBJECT, 'u1', 'ORD-1', 2)]);
  assert.equal((await offerLimitAdvice(db, SUBJECT, 'u1', 1)).reason, 'PER_USER_LIMIT_REACHED');
  // ...and the trigger says the same thing.
  await assert.rejects(
    () => db.batch([offerRedemptionStatement(db, SUBJECT, 'u1', 'ORD-2', 1)]),
    /OFFER_PER_USER_LIMIT/
  );

  // The global limit is the one u2 meets, not the per-user one.
  assert.equal((await offerLimitAdvice(db, SUBJECT, 'u2', 2)).reason, 'GLOBAL_LIMIT_REACHED');
  await db.batch([offerRedemptionStatement(db, SUBJECT, 'u2', 'ORD-3', 1)]);
  assert.equal(count(raw, 'SELECT COALESCE(SUM(qty),0) AS n FROM offer_redemptions'), 3);
});

test('one row per (subject, order) with qty SUMMED — a second row for the same order is refused', async () => {
  const raw = freshDb();
  seed(raw, { per_user: null, global: null });
  const db = asD1(raw);

  // Two lines of the same bundle in one order (two colour choices) = ONE row.
  await db.batch([offerRedemptionStatement(db, SUBJECT, 'u1', 'ORD-1', 3)]);
  await assert.rejects(
    () => db.batch([offerRedemptionStatement(db, SUBJECT, 'u1', 'ORD-1', 1)]),
    /UNIQUE/,
    'a per-LINE row would abort the batch with a message the catch block cannot map'
  );
  const rows = all<{ qty: number }>(raw, 'SELECT qty FROM offer_redemptions');
  assert.deepEqual(rows, [{ qty: 3 }]);
});

test('no limits row at all means no limit, and the tables stay inert', async () => {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,email) VALUES ('u1','a@x.co');
    INSERT INTO orders (id,user_id,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd)
      VALUES ('ORD-1','u1','{}','dm','{}','cod',1,1400,1,0);
  `);
  const db = asD1(raw);
  assert.equal((await offerLimitAdvice(db, SUBJECT, 'u1', 99)).ok, true);
  await db.batch([offerRedemptionStatement(db, SUBJECT, 'u1', 'ORD-1', 99)]);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM offer_redemptions'), 1);
});

test('a cancelled order does not free the slot — the same rule coupons follow', async () => {
  const raw = freshDb();
  seed(raw, { per_user: 1, global: null });
  const db = asD1(raw);
  await db.batch([offerRedemptionStatement(db, SUBJECT, 'u1', 'ORD-1', 1)]);
  raw.exec("UPDATE orders SET status = 'cancelled' WHERE id = 'ORD-1'");
  // Deliberate: a mystery buyer revealed at 'paid' could otherwise self-cancel
  // and re-roll for ever (§7.3).
  await assert.rejects(() => db.batch([offerRedemptionStatement(db, SUBJECT, 'u1', 'ORD-2', 1)]), /OFFER_PER_USER_LIMIT/);
});
