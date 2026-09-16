/**
 * Durable-jobs wiring tests (worker/lib/jobs.ts).
 *
 * The integrated mandate adds three steps to the scheduled pipeline that no
 * user action can trigger: delivering the admin-group wallet notifications
 * (§12.1), the wallet reconciliation that ALERTS but never repairs (§11.4),
 * and the support-gift re-evaluation sweep (§3.4). This file proves the
 * wiring itself, against a REAL SQLite database built from the REAL
 * migration files — not a mock:
 *
 *  - every new step actually runs and reports its own numbers;
 *  - reconciliation writes exactly ONE audit row when an invariant is broken,
 *    and NOTHING at all when the books balance — it never moves money, never
 *    releases a hold and never "fixes" a balance;
 *  - one failing step never starves the others (a missing table earlier in
 *    the pipeline still leaves the later steps with real results).
 *
 * What it cannot prove: Cloudflare's cron scheduler firing the handler in
 * production, and Telegram delivery (no bot token, no network here).
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDurableJobs } from '../worker/lib/jobs';
import type { Env } from '../worker/lib/types';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// --------------------------------------------------------------- D1 adapter
type Row = Record<string, unknown>;

class SqliteStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: unknown[] = []
  ) {}
  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.db, this.sql, values);
  }
  private args(): never[] {
    return this.params as never[];
  }
  async run() {
    const res = this.db.prepare(this.sql).run(...this.args());
    return {
      success: true,
      results: [],
      meta: { changes: Number(res.changes), last_row_id: Number(res.lastInsertRowid), duration: 0 },
    };
  }
  async first<T = Row>(): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.args());
    return (row === undefined ? null : (row as T)) as T | null;
  }
  async all<T = Row>() {
    const rows = this.db.prepare(this.sql).all(...this.args()) as T[];
    return { success: true, results: rows, meta: { changes: 0, duration: 0 } };
  }
}

class SqliteD1 {
  constructor(private readonly db: DatabaseSync) {}
  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.db, sql);
  }
  async batch(statements: SqliteStatement[]) {
    this.db.exec('BEGIN');
    try {
      const out = [];
      for (const s of statements) out.push(await s.run());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}

/** Lifts one CREATE TABLE block out of a migration file, verbatim. */
function createTableSql(file: string, table: string): string {
  const src = readFileSync(join(ROOT, 'migrations', file), 'utf8');
  const start = src.indexOf(`CREATE TABLE ${table} (`);
  assert.ok(start >= 0, `${table} not found in ${file}`);
  const end = src.indexOf('\n);', start);
  assert.ok(end > start, `${table} block not terminated in ${file}`);
  return `${src.slice(start, end)}\n);`;
}

/**
 * A database carrying ONLY the tables the three new steps read. The steps
 * that come earlier in the pipeline (outbox, challenge expiry, token pruning,
 * points release) therefore hit missing tables — which is exactly the
 * isolation this file asserts: their failure must not stop the rest.
 */
function freshDb(): { env: Env; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  // Minimal identity table: the wallet/gift tables carry real foreign keys.
  raw.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, username TEXT)');
  raw.prepare('INSERT INTO users (id, email, username) VALUES (?,?,?)').run('u1', 'u1@example.com', 'u1');
  raw.exec(createTableSql('0001_init.sql', 'wallet_transactions'));
  raw.exec(createTableSql('0001_init.sql', 'audit_log'));
  raw.exec(readFileSync(join(ROOT, 'migrations', '0015_wallet_holds.sql'), 'utf8'));
  raw.exec(createTableSql('0016_support_code.sql', 'support_gift_entitlements'));
  raw.exec(createTableSql('0017_tg_actions.sql', 'tg_admin_notifications'));
  // 0080 added three columns to that table: WHICH BOT carries the message, the
  // forum topic it goes in, and which topic the router chose. This fixture
  // hand-picks CREATE TABLE statements, so the later ALTERs have to be replayed
  // here or the table is not the one production has.
  raw.exec(`
    ALTER TABLE tg_admin_notifications ADD COLUMN bot TEXT NOT NULL DEFAULT 'customer';
    ALTER TABLE tg_admin_notifications ADD COLUMN message_thread_id INTEGER;
    ALTER TABLE tg_admin_notifications ADD COLUMN topic_key TEXT NOT NULL DEFAULT '';
  `);
  const env = { DB: new SqliteD1(raw) as unknown as D1Database } as unknown as Env;
  return { env, raw };
}

const auditRows = (raw: DatabaseSync, action: string) =>
  raw.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get(action) as { n: number };

test('the scheduled pipeline reports every new step, and balanced books raise NOTHING', async () => {
  const { env, raw } = freshDb();
  const report = await runDurableJobs(env);

  // The three integrated-mandate steps ran and reported real shapes.
  assert.deepEqual(report.wallet_notifications, { sent: 0, failed: 0, dead: 0 });
  assert.deepEqual(report.support_gifts, { scanned: 0, cancelled: 0, became_due: 0, flagged: 0 });
  assert.equal(report.wallet_reconciliation.anomalies, 0);
  assert.equal(report.wallet_reconciliation.sums_match, true);

  // Nothing to alert about ⇒ no audit noise at all.
  assert.equal(auditRows(raw, 'wallet.reconciliation.anomalies').n, 0);
});

test('a step whose table is missing fails alone — the later steps still run', async () => {
  const { env } = freshDb();
  const report = await runDurableJobs(env);

  // The earlier steps have no tables here, so they must be recorded as
  // errors…
  assert.ok(report.errors.length > 0, 'expected the table-less steps to record errors');
  assert.ok(
    report.errors.some((e) => e.startsWith('outbox:') || e.startsWith('link_challenges:')),
    `expected an early-step failure, got ${JSON.stringify(report.errors)}`
  );
  // …and the LATER steps must still have produced their results.
  assert.ok(!report.errors.some((e) => e.startsWith('wallet_reconciliation:')));
  assert.ok(!report.errors.some((e) => e.startsWith('wallet_notifications:')));
  assert.ok(!report.errors.some((e) => e.startsWith('support_gifts:')));
  assert.deepEqual(report.bnpl_overdue, { scanned: 0, overdue: 0, suspended: 0 });
  assert.ok(report.errors.some((e) => e.startsWith('bnpl_overdue:')));
});

test('reconciliation ALERTS on a broken invariant with exactly one audit row — and repairs nothing', async () => {
  const { env, raw } = freshDb();

  // NOTE: "paid without a payout reference" cannot even be written — a CHECK
  // constraint in migration 0015 rejects it, which is a stronger guarantee
  // than a sweep. The reachable break planted here is a payout marked paid
  // while its hold is still ACTIVE and its ledger debit still PENDING: the
  // money would be reserved and spent at the same time.
  raw
    .prepare(
      `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, created_by)
       VALUES ('wtx_p1', 'u1', 'withdrawal', 'USD', 5000, 'pending', 'seed', 'user')`
    )
    .run();
  raw
    .prepare(
      `INSERT INTO wallet_holds (id, user_id, kind, amount_cents, state, tx_id, event_key)
       VALUES ('hld_p1', 'u1', 'withdrawal', 5000, 'active', 'wtx_p1', 'evt_p1')`
    )
    .run();
  raw
    .prepare(
      `INSERT INTO wallet_withdrawals (id, user_id, amount_cents, fee_cents, net_cents, state, destination_kind,
                                       destination_account, hold_id, tx_id, payout_reference,
                                       payout_actor, payout_at)
       VALUES ('wd_p1', 'u1', 5000, 0, 5000, 'paid', 'manual_transfer', '0770-000-0000', 'hld_p1', 'wtx_p1', 'REF-1',
               'admin_1', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    )
    .run();

  const before = raw.prepare('SELECT state, payout_reference FROM wallet_withdrawals WHERE id = ?').get('wd_p1');
  const holdBefore = raw.prepare('SELECT state, amount_cents FROM wallet_holds WHERE id = ?').get('hld_p1');
  const txBefore = raw.prepare('SELECT status, amount FROM wallet_transactions WHERE id = ?').get('wtx_p1');

  const report = await runDurableJobs(env);

  assert.ok(report.wallet_reconciliation.anomalies >= 1, 'the broken row must be reported');
  assert.equal(auditRows(raw, 'wallet.reconciliation.anomalies').n, 1, 'exactly one alert per run');

  // The whole point of §11.4: it REPORTS. Nothing was repaired, released,
  // credited or debited by the sweep.
  assert.deepEqual(raw.prepare('SELECT state, payout_reference FROM wallet_withdrawals WHERE id = ?').get('wd_p1'), before);
  assert.deepEqual(raw.prepare('SELECT state, amount_cents FROM wallet_holds WHERE id = ?').get('hld_p1'), holdBefore);
  assert.deepEqual(raw.prepare('SELECT status, amount FROM wallet_transactions WHERE id = ?').get('wtx_p1'), txBefore);

  // A second run alerts again (the condition still holds) and still moves
  // nothing — the sweep is safe to repeat.
  await runDurableJobs(env);
  assert.equal(auditRows(raw, 'wallet.reconciliation.anomalies').n, 2);
  assert.deepEqual(raw.prepare('SELECT status, amount FROM wallet_transactions WHERE id = ?').get('wtx_p1'), txBefore);
});

test('a pending admin notification is claimed, and stays reviewable when delivery is unconfigured', async () => {
  const { env, raw } = freshDb();
  raw
    .prepare(
      `INSERT INTO tg_admin_notifications (id, event_key, request_kind, request_id, target_chat, photo_key, caption, state)
       VALUES ('tgn1', 'evt1', 'deposit', 'wtx_x', '-100200300', '', 'synthetic caption', 'pending')`
    )
    .run();

  const errors: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  let report;
  try {
    report = await runDurableJobs(env);
  } finally {
    console.error = realError;
  }
  // No bot token and no admin group in this process, so there is nowhere to
  // send — the honest outcome is a row that stays reviewable, never a silent
  // drop and never a "sent" claim.
  assert.equal(report.wallet_notifications.sent, 0);
  assert.equal(report.wallet_notifications.failed, 1, 'the miss is counted, not swallowed');
  const row = raw
    .prepare('SELECT state, attempts, last_error FROM tg_admin_notifications WHERE id = ?')
    .get('tgn1') as { state: string; attempts: number; last_error: string };
  assert.equal(row.state, 'pending', 'it waits for a destination rather than dead-lettering');
  // 0080: a CONFIGURATION gap must not spend the retry budget. Five sweeps with
  // no group bound used to burn all five attempts and dead-letter a deposit
  // that nothing was ever wrong with; the destination is re-resolved on every
  // attempt now, so the message delivers itself the moment a group exists.
  assert.equal(row.attempts, 0, 'a missing destination is not a failed delivery attempt');
  assert.equal(row.last_error, 'NO_ADMIN_DESTINATION');
  const logged = errors.map((e) => { try { return JSON.parse(e) as Record<string, unknown>; } catch { return null; } });
  assert.ok(
    logged.some((l) => l?.event === 'telegram_admin_routing_error' && l?.topic === 'wallet'),
    'and §9 requires the routing miss to be REPORTED'
  );
});
