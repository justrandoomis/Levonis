/**
 * MIGRATION 0218 AGAINST EVERY NULL FENCE THE WORKER WRITES.
 *
 * A fence writes `<column> = CASE WHEN <still true> THEN <column> ELSE NULL END`
 * into a NOT NULL column. When the race is lost, the NOT NULL check aborts the
 * batch and the caller maps that message (orderDeletion answers ORDER_CHANGED;
 * the refund, stage and 0140 doors re-read). A BEFORE trigger runs before that
 * check, so a 0218 trigger that reads the NULL as a real value answers first
 * with its own code. T9 did, because `NULL IS NOT 'cancelled'` is true (review
 * findings schema-1 / orders-5).
 *
 * This file finds those fences in worker/ and keeps the ones on a table a 0218
 * trigger watches. It runs both branches of each fence on every row of a world
 * that holds estimate orders in every state: the lost branch must fail on
 * NOT NULL, and the held branch must pass and leave every estimate line as it was.
 *
 * LOCAL ONLY: in-memory SQLite, no network.
 *
 * Run: node --import tsx --test tests/migration0218Fences.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ROOT } from './fixtures/d1';
import { freshDb } from './fixtures/app';
import { estimateCheckoutGuardId } from '../worker/lib/priceEstimateGate';

const SQL = readFileSync(join(ROOT, 'migrations', '0218_price_estimates.sql'), 'utf8');
const NOW = '2026-10-31T12:00:00.000Z';

/** The tables 0218's triggers watch. */
const WATCHED = new Set(
  [...SQL.matchAll(/CREATE TRIGGER IF NOT EXISTS \w+\s+(?:BEFORE|AFTER)\s+(?:INSERT|UPDATE|DELETE)(?:\s+OF\s+[\w\s,]+?)?\s+ON\s+(\w+)/g)].map((m) => m[1])
);

interface Fence {
  at: string;
  table: string;
  column: string;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|mjs|js)$/.test(e.name) ? [join(dir, e.name)] : []
  );
}

/** Every `<column> = CASE … THEN <column> ELSE NULL END` in worker/, with the table its UPDATE names. */
function workerNullFences(): Fence[] {
  const out: Fence[] = [];
  for (const file of walk(join(ROOT, 'worker'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bTHEN\s+(?:\w+\.)?(\w+)\s+ELSE\s+NULL\s+END\b/g)) {
      const end = m.index ?? 0;
      const head = src.slice(Math.max(0, end - 2000), end);
      // The assignment this CASE closes; a CASE in a SELECT list assigns nothing.
      const assign = [...head.matchAll(new RegExp(`\\b${m[1]}\\s*=\\s*CASE\\b`, 'g'))].at(-1);
      const update = assign && [...head.slice(0, assign.index ?? 0).matchAll(/\bUPDATE\s+"?(\w+)"?\s+SET\b/g)].at(-1);
      if (!update) continue;
      const line = src.slice(0, end).split('\n').length;
      out.push({ at: `${relative(ROOT, file).replaceAll('\\', '/')}:${line}`, table: update[1], column: m[1] });
    }
  }
  return out;
}

/** Runs `sql` in a savepoint that is always rolled back: its error message, or what `inspect` reads. */
function trial(db: DatabaseSync, sql: string, inspect: () => string = () => 'ok'): string {
  db.exec('SAVEPOINT trial');
  try {
    db.exec(sql);
    return inspect();
  } catch (e) {
    return String((e as Error).message);
  } finally {
    db.exec('ROLLBACK TO trial');
    db.exec('RELEASE trial');
  }
}

const estimateLines = (db: DatabaseSync) => JSON.stringify(db.prepare('SELECT * FROM order_price_estimates ORDER BY order_item_id').all());

// ------------------------------------------------------------------ the world

function order(db: DatabaseSync, id: string, items: string[]): void {
  db.prepare(
    `INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot, payment_method_id,
       subtotal_iqd, exchange_rate, total_iqd, due_on_delivery_iqd, created_at, updated_at)
     VALUES (?, 'u1', 'pending', '{}', 'delivery', '{}', 'cod', 17500, 1500, 17500, 17500, ?, ?)`
  ).run(id, NOW, NOW);
  if (items.length === 0) {
    db.exec(`INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd)
             VALUES ('${id}_plain', '${id}', 'p_plain', 'Plain', 1, 17500, 17500)`);
    return;
  }
  // The estimate checkout's shape: the token, the lines, their estimate rows, the token gone.
  const token = estimateCheckoutGuardId(id);
  db.exec(`INSERT INTO ops_guards (id, ok) VALUES ('${token}', 1);
    ${items
      .map(
        (i) => `INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd)
                 VALUES ('${i}', '${id}', 'p_est', 'Estimated', 1, 17500, 17500);
               INSERT INTO order_price_estimates (order_item_id, order_id, product_id, combo_key, channel, qty, estimate_unit_iqd, notice_version, created_at)
                 VALUES ('${i}', '${id}', 'p_est', '', 'pre_order_sea', 1, 17500, 1, '${NOW}');`
      )
      .join('\n')}
    DELETE FROM ops_guards WHERE id = '${token}';`);
}

/** A 0140 proposal on `orderId` whose line `item` is proposed under it (the row only, as the 0218 test writes it). */
function proposal(db: DatabaseSync, id: string, orderId: string, item: string): void {
  db.prepare(
    `INSERT INTO order_price_adjustments (id, order_id, user_id, state, old_total_iqd, new_total_iqd, delta_iqd, old_due_iqd, new_due_iqd,
       old_wallet_iqd, new_wallet_iqd, wallet_refund_iqd, reason, proposed_by, idempotency_key)
     VALUES (?, ?, 'u1', 'pending', 17500, 18000, 500, 17500, 18000, 0, 0, 0, 'Final price', 'admin', ?)`
  ).run(id, orderId, `key-${id}`);
  db.exec(`UPDATE order_price_estimates SET state = 'proposed', final_unit_iqd = 18000, adjustment_id = '${id}' WHERE order_item_id = '${item}'`);
}

const decide = (db: DatabaseSync, id: string, to: string) =>
  db.exec(`UPDATE order_price_adjustments SET state = '${to}', decided_at = '${NOW}', decided_by = 'u1' WHERE id = '${id}' AND state = 'pending'`);

function world(): DatabaseSync {
  const db = freshDb();
  db.exec(`
    INSERT INTO users (id, email) VALUES ('u1', 'customer@example.test');
    INSERT INTO products (id, slug, name, status) VALUES ('p_est', 'p-est', 'Estimated', 'active'), ('p_plain', 'p-plain', 'Plain', 'active');
    INSERT INTO ops_guards (id, ok) VALUES ('engine-price:p_est', 1);
    UPDATE products SET price_estimate = 1 WHERE id = 'p_est';
    DELETE FROM ops_guards WHERE id = 'engine-price:p_est';
  `);
  // Pending at «تم الاستلام», the gate closed: one line open, one proposed (0140 pending), one rejected.
  // 0140 allows one pending proposal per order, so the rejected one is decided first.
  order(db, 'o_unsettled', ['u_open', 'u_prop', 'u_rej']);
  proposal(db, 'padj_rejected', 'o_unsettled', 'u_rej');
  decide(db, 'padj_rejected', 'rejected');
  proposal(db, 'padj_pending', 'o_unsettled', 'u_prop');
  // Settled (confirmed, approved), so the gate is open and the order moved on.
  order(db, 'o_settled', ['s_conf', 's_appr']);
  db.exec(`UPDATE order_price_estimates SET state = 'confirmed', final_unit_iqd = 17500, decided_by = 'admin', decided_at = '${NOW}' WHERE order_item_id = 's_conf'`);
  proposal(db, 'padj_approved', 'o_settled', 's_appr');
  decide(db, 'padj_approved', 'approved');
  db.exec("UPDATE orders SET status = 'confirmed', stage = 'confirmed' WHERE id = 'o_settled'");
  // Cancelled while open (the line is void), and cancelled after its line was settled (history).
  order(db, 'o_void', ['v_line']);
  order(db, 'o_cancel_settled', ['c_conf']);
  db.exec(`UPDATE order_price_estimates SET state = 'confirmed', final_unit_iqd = 17500, decided_by = 'admin', decided_at = '${NOW}' WHERE order_item_id = 'c_conf'`);
  // Orders with no estimate line, pending and cancelled.
  order(db, 'o_plain', []);
  order(db, 'o_plain_cancelled', []);
  db.exec("UPDATE orders SET status = 'cancelled', stage = 'cancelled' WHERE id IN ('o_void', 'o_cancel_settled', 'o_plain_cancelled')");
  return db;
}

// ------------------------------------------------------------------ the tests

test('the world holds estimate orders in every state the 0218 triggers read', () => {
  const db = world();
  const shape = new Map<string, string[]>();
  const rows = db
    .prepare(
      `SELECT o.id || ' ' || o.status || ' ' || o.stage AS o, e.state AS line
         FROM orders o LEFT JOIN order_price_estimates e ON e.order_id = o.id
        ORDER BY o.id, e.order_item_id`
    )
    .all() as Array<{ o: string; line: string | null }>;
  for (const r of rows) shape.set(r.o, [...(shape.get(r.o) ?? []), ...(r.line === null ? [] : [r.line])]);
  assert.deepEqual(Object.fromEntries(shape), {
    'o_cancel_settled cancelled cancelled': ['confirmed'],
    'o_plain pending received': [],
    'o_plain_cancelled cancelled cancelled': [],
    'o_settled confirmed confirmed': ['approved', 'confirmed'],
    'o_unsettled pending received': ['open', 'proposed', 'rejected'],
    'o_void cancelled cancelled': ['void'],
  });
  assert.deepEqual(
    db.prepare('SELECT id, state FROM order_price_adjustments ORDER BY id').all().map((r) => `${(r as { id: string }).id} ${(r as { state: string }).state}`),
    ['padj_approved approved', 'padj_pending pending', 'padj_rejected rejected']
  );
});

test('every NULL fence the worker writes on a table 0218 watches fails on NOT NULL, whatever estimate state its row is in', () => {
  const watched = workerNullFences().filter((f) => WATCHED.has(f.table));
  // Not vacuous: the deletion fence of the review finding, the cancel fences and 0140's proposal fences are found.
  for (const file of ['worker/lib/orderDeletion.ts', 'worker/lib/orderCancelOps.ts', 'worker/lib/orderPriceAdjust.ts', 'worker/lib/orderEstimates.ts']) {
    assert.ok(watched.some((f) => f.at.startsWith(`${file}:`)), `no NULL fence found in ${file}: the scan no longer reads it`);
  }
  const pairs = new Map<string, Fence[]>();
  for (const f of watched) pairs.set(`${f.table}.${f.column}`, [...(pairs.get(`${f.table}.${f.column}`) ?? []), f]);
  assert.ok(pairs.has('orders.status') && pairs.has('order_price_adjustments.state'), [...pairs.keys()].join(', '));

  const db = world();
  for (const [pair, sites] of pairs) {
    const [table, column] = pair.split('.');
    const where = (sites.map((s) => s.at).join(', ')).slice(0, 400);
    const rows = db.prepare(`SELECT rowid AS r FROM "${table}" ORDER BY rowid`).all().map((x) => Number((x as { r: number }).r));
    assert.ok(rows.length > 0, `${pair} is fenced (${where}) but the world holds no ${table} row: add one`);
    for (const r of rows) {
      const label = `${pair} on ${JSON.stringify(db.prepare(`SELECT * FROM "${table}" WHERE rowid = ?`).get(r)).slice(0, 120)} (${where})`;
      const fenced = (held: 0 | 1) => `UPDATE "${table}" SET "${column}" = CASE WHEN ${held} THEN "${column}" ELSE NULL END WHERE rowid = ${r}`;
      assert.equal(trial(db, fenced(0)), `NOT NULL constraint failed: ${table}.${column}`, `lost: ${label}`);
      const before = estimateLines(db);
      assert.equal(trial(db, fenced(1), () => estimateLines(db)), before, `held: ${label}`);
    }
  }
});
