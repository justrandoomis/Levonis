/**
 * THE MERCHANT LEDGER CANNOT BE MISUSED INTO DOUBLE-SPEND OR A NEGATIVE
 * BALANCE — by the database itself, whatever a future route forgets
 * (migration 0121).
 *
 *   · a line is never updated or deleted;
 *   · the kind decides the sign and the bucket;
 *   · no new line overdraws a bucket (a customer refund excepted);
 *   · a payout leg moves exactly its payout's amount, for its merchant, from
 *     the state the leg belongs to;
 *   · a payout's amount, merchant and key never change, its states only move
 *     forward, and it is never deleted.
 *
 * Run: node --import tsx --test tests/merchantLedgerSchema.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, count } from './fixtures/app';

function seed(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('ali','Ali','a@x.co','h','merchant'), ('zed','Zed','z@x.co','h','merchant');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','ali','Ali'), ('m2','zed','Zed');
    INSERT INTO merchant_ledger_entries (id,merchant_id,order_id,kind,bucket,amount_iqd,event_key) VALUES
      ('l1','m1','ORD-1','sale_gross','available',10000,'k1');
  `);
  return raw;
}

const line = (raw: DatabaseSync, cols: Record<string, unknown>) => {
  const keys = Object.keys(cols);
  raw.prepare(`INSERT INTO merchant_ledger_entries (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(
    ...(Object.values(cols) as never[])
  );
};

test('append-only: a ledger line is never updated or deleted', () => {
  const raw = seed();
  assert.throws(() => raw.exec("UPDATE merchant_ledger_entries SET amount_iqd = 99999 WHERE id = 'l1'"), /LEDGER_APPEND_ONLY/);
  assert.throws(() => raw.exec("UPDATE merchant_ledger_entries SET bucket = 'pending' WHERE id = 'l1'"), /LEDGER_APPEND_ONLY/);
  assert.throws(() => raw.exec("DELETE FROM merchant_ledger_entries WHERE id = 'l1'"), /LEDGER_APPEND_ONLY/);
  assert.equal(count(raw, "SELECT COUNT(*) n FROM merchant_ledger_entries WHERE amount_iqd = 10000"), 1);
});

test('the kind decides the sign and the bucket: a positive commission, a release into reserved, a zero line cannot be written', () => {
  const raw = seed();
  const bad: Array<Record<string, unknown>> = [
    { id: 'b1', merchant_id: 'm1', order_id: 'O', kind: 'commission', bucket: 'pending', amount_iqd: 500, event_key: 'b1' },
    { id: 'b2', merchant_id: 'm1', order_id: 'O', kind: 'release', bucket: 'reserved', amount_iqd: 500, event_key: 'b2' },
    { id: 'b3', merchant_id: 'm1', order_id: 'O', kind: 'sale_gross', bucket: 'pending', amount_iqd: 0, event_key: 'b3' },
    { id: 'b4', merchant_id: 'm1', kind: 'sale_gross', bucket: 'pending', amount_iqd: 10, event_key: 'b4' },
    { id: 'b5', merchant_id: 'm1', kind: 'adjustment', bucket: 'available', amount_iqd: 10, event_key: 'b5', note: '' },
    { id: 'b6', merchant_id: 'm1', kind: 'payout', bucket: 'available', amount_iqd: -10, event_key: 'b6' },
    { id: 'b7', merchant_id: 'm1', order_id: 'O', kind: 'refund', bucket: 'paid', amount_iqd: -10, event_key: 'b7' },
    { id: 'b8', merchant_id: 'm1', kind: 'escrow_release', bucket: 'pending', amount_iqd: 10, event_key: 'b8' },
  ];
  // (A payout line with no payout is refused by the payout-leg trigger before the CHECK is reached.)
  for (const cols of bad) assert.throws(() => line(raw, cols), /CHECK constraint failed|LEDGER_PAYOUT_MISMATCH/, String(cols.id));
  // The same event twice is one event.
  assert.throws(() => line(raw, { id: 'dup', merchant_id: 'm1', order_id: 'ORD-1', kind: 'sale_gross', bucket: 'pending', amount_iqd: 5, event_key: 'k1' }), /UNIQUE/);
});

test('no new line takes a bucket below zero — except a customer refund, which the platform owes whatever was withdrawn', () => {
  const raw = seed();
  // An adjustment of −10,001 from 10,000.
  assert.throws(
    () => line(raw, { id: 'a1', merchant_id: 'm1', kind: 'adjustment', bucket: 'available', amount_iqd: -10001, event_key: 'a1', note: 'too much' }),
    /LEDGER_BUCKET_OVERDRAWN/
  );
  // Another merchant's money does not count.
  assert.throws(
    () => line(raw, { id: 'a2', merchant_id: 'm2', kind: 'adjustment', bucket: 'available', amount_iqd: -1, event_key: 'a2', note: 'not theirs' }),
    /LEDGER_BUCKET_OVERDRAWN/
  );
  line(raw, { id: 'a3', merchant_id: 'm1', kind: 'adjustment', bucket: 'available', amount_iqd: -10000, event_key: 'a3', note: 'all of it' });
  // A claw-back may leave a debt.
  line(raw, { id: 'r1', merchant_id: 'm1', order_id: 'ORD-1', kind: 'refund', bucket: 'available', amount_iqd: -700, event_key: 'r1' });
  assert.equal(count(raw, "SELECT SUM(amount_iqd) n FROM merchant_ledger_entries WHERE merchant_id = 'm1' AND bucket = 'available'"), -700);
});

test('a payout leg moves exactly its payout, for its merchant, from its state — and a payout never changes its amount or goes back', () => {
  const raw = seed();
  raw.exec(`INSERT INTO merchant_payouts (id,merchant_id,amount_iqd,state,event_key) VALUES ('p1','m1',4000,'requested','m1:key-1')`);
  const leg = (id: string, cols: Record<string, unknown>) =>
    line(raw, { id, merchant_id: 'm1', payout_id: 'p1', kind: 'payout', event_key: id, ...cols });
  assert.throws(() => leg('x1', { bucket: 'available', amount_iqd: -9000 }), /LEDGER_PAYOUT_MISMATCH/, 'more than the payout');
  assert.throws(() => line(raw, { id: 'x2', merchant_id: 'm2', payout_id: 'p1', kind: 'payout', bucket: 'available', amount_iqd: -4000, event_key: 'x2' }), /LEDGER_PAYOUT_MISMATCH|LEDGER_BUCKET_OVERDRAWN/, 'another merchant');
  assert.throws(() => leg('x3', { bucket: 'paid', amount_iqd: 4000 }), /LEDGER_PAYOUT_MISMATCH/, 'paid before it is paid');
  assert.throws(() => line(raw, { id: 'x4', merchant_id: 'm1', payout_id: 'p1', kind: 'payout_reversal', bucket: 'available', amount_iqd: 4000, event_key: 'x4' }), /LEDGER_PAYOUT_MISMATCH/, 'returned while still requested');
  leg('ok1', { bucket: 'available', amount_iqd: -4000 });
  leg('ok2', { bucket: 'reserved', amount_iqd: 4000 });

  assert.throws(() => raw.exec("UPDATE merchant_payouts SET amount_iqd = 1 WHERE id = 'p1'"), /PAYOUT_IMMUTABLE/);
  assert.throws(() => raw.exec("UPDATE merchant_payouts SET merchant_id = 'm2' WHERE id = 'p1'"), /PAYOUT_IMMUTABLE/);
  assert.throws(() => raw.exec("UPDATE merchant_payouts SET state = 'paid', reference = 'r' WHERE id = 'p1'"), /PAYOUT_STATE_TRANSITION/, 'paid needs approved first');
  raw.exec("UPDATE merchant_payouts SET state = 'approved' WHERE id = 'p1'");
  assert.throws(() => raw.exec("UPDATE merchant_payouts SET state = 'paid' WHERE id = 'p1'"), /CHECK constraint failed/, 'paid needs a reference');
  raw.exec("UPDATE merchant_payouts SET state = 'paid', reference = 'ZC-1' WHERE id = 'p1'");
  assert.throws(() => raw.exec("UPDATE merchant_payouts SET state = 'failed' WHERE id = 'p1'"), /PAYOUT_STATE_TRANSITION/, 'a paid payout never fails');
  assert.throws(() => raw.exec("UPDATE merchant_payouts SET state = 'requested' WHERE id = 'p1'"), /PAYOUT_STATE_TRANSITION/);
  assert.throws(() => raw.exec("DELETE FROM merchant_payouts WHERE id = 'p1'"), /PAYOUT_APPEND_ONLY/);
});

test('no route writes the old merchant_payout_ledger any more — it is read-only for the code (0121)', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { ROOT } = await import('./fixtures/d1');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') && /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+merchant_payout_ledger\b/i.test(readFileSync(p, 'utf8'))) offenders.push(p);
    }
  };
  walk(join(ROOT, 'worker'));
  assert.deepEqual(offenders, []);
});
