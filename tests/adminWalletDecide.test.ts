/**
 * A hold-backed withdrawal is decided by its own workflow, never by the
 * legacy "decide" button.
 *
 * Since the holds engine (migration 0015) a withdrawal reserves its money in
 * wallet_holds and walks requested → approved → processing → paid, committing
 * the hold and posting the debit in ONE transaction. The admin panel still
 * approved and rejected through the older POST /wallet-requests/:id/decide,
 * which flipped the ledger row alone and left the hold active for ever: the
 * customer's money stayed reserved for a payout that had already happened —
 * or, on a rejection, for one that never would. The route now refuses such
 * rows and the lists say which rows they are, so the panel can drive the
 * workflow routes instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ROOT, SqliteD1 } from './fixtures/d1';
import type { AppContext, Env } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';
import { adminRoutes } from '../worker/routes/admin';
import { requestWithdrawal } from '../worker/lib/walletOps';

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  raw.prepare("INSERT INTO users (id, email, username, name, role) VALUES ('boss','boss@levonis-iq.com','boss','Boss','admin')").run();
  raw.prepare("INSERT INTO users (id, email, username, name) VALUES ('u1','u1@example.com','u1','One')").run();
  raw.prepare(
    `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, created_by, decided_at)
     VALUES ('seed','u1','deposit','USD',100000,'approved','seed','admin',strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  ).run();
  const d1 = new SqliteD1(raw) as unknown as D1Database;
  const app = new Hono<AppContext>();
  app.use('*', async (c, next) => {
    c.env = { DB: d1, INITIAL_ADMIN_EMAIL: 'boss@levonis-iq.com' } as Env;
    c.set('user', raw.prepare("SELECT * FROM users WHERE id = 'boss'").get() as never);
    await next();
  });
  app.route('/api/admin', adminRoutes);
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ success: false, error: err.message, code: err.code, details: err.details }, err.status as 400);
    throw err;
  });
  return { raw, d1, app };
}

const decide = (app: Hono<AppContext>, id: string, status: 'approved' | 'rejected') =>
  app.request(`https://levonis-iq.com/api/admin/wallet-requests/${id}/decide`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
  });

test('the legacy decision refuses a hold-backed withdrawal — approve AND reject — and names the workflow', async () => {
  const { raw, d1, app } = setup();
  const w = await requestWithdrawal(d1, {
    userId: 'u1', amountCents: 60_000, eventKey: 'k1',
    destination: { kind: 'manual_transfer', account: '0770-000-0000', holder: 'One' },
  });
  assert.equal(w.ok, true);
  const { tx_id, id: wdId } = raw.prepare('SELECT tx_id, id FROM wallet_withdrawals').get() as { tx_id: string; id: string };

  for (const status of ['approved', 'rejected'] as const) {
    const res = await decide(app, tx_id, status);
    const body = (await res.json()) as { code: string; details: { withdrawal_id: string; state: string } };
    assert.equal(res.status, 409, status);
    assert.equal(body.code, 'USE_WITHDRAWAL_WORKFLOW');
    assert.deepEqual(body.details, { withdrawal_id: wdId, state: 'requested' });
  }
  // Nothing moved: the ledger row is still pending and the hold still active.
  assert.equal((raw.prepare('SELECT status FROM wallet_transactions WHERE id = ?').get(tx_id) as { status: string }).status, 'pending');
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM wallet_holds WHERE state = 'active'").get() as { n: number }).n, 1);
});

test('the lists tell the panel which rows belong to the workflow', async () => {
  const { raw, d1, app } = setup();
  await requestWithdrawal(d1, {
    userId: 'u1', amountCents: 10_000, eventKey: 'k2',
    destination: { kind: 'manual_transfer', account: '0770-000-0000', holder: 'One' },
  });
  raw.prepare(
    `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, created_by)
     VALUES ('dep1','u1','deposit','USD',5000,'pending','cash','user')`
  ).run();
  const res = await app.request('https://levonis-iq.com/api/admin/wallet-requests');
  const { requests } = (await res.json()) as { requests: Array<{ id: string; type: string; withdrawal: null | { id: string; state: string; needs_reconciliation: boolean; payout_reference: string | null } }> };
  const wd = requests.find((r) => r.type === 'withdrawal')!;
  const dep = requests.find((r) => r.id === 'dep1')!;
  assert.equal(wd.withdrawal?.state, 'requested');
  assert.match(wd.withdrawal?.id ?? '', /^wd/);
  assert.equal(wd.withdrawal?.needs_reconciliation, false);
  assert.equal(dep.withdrawal, null, 'a deposit has no workflow row');
});

test('deposits and pre-holds withdrawals are still decided the old way', async () => {
  const { raw, app } = setup();
  raw.prepare(
    `INSERT INTO wallet_transactions (id, user_id, type, currency, amount, status, note, created_by)
     VALUES ('dep1','u1','deposit','USD',5000,'pending','cash','user'),
            ('legacy_wd','u1','withdrawal','USD',20000,'pending','old','user')`
  ).run();
  assert.equal((await decide(app, 'dep1', 'approved')).status, 200);
  assert.equal((await decide(app, 'legacy_wd', 'approved')).status, 200, 'a withdrawal with no hold has nothing else to decide it');
  assert.equal((raw.prepare("SELECT status FROM wallet_transactions WHERE id = 'legacy_wd'").get() as { status: string }).status, 'approved');
});
