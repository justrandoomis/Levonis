/**
 * THE RECONCILIATION RUNNER MUST NOT SPEND THE OWNER'S FINANCE WRITE BUDGET
 * (S1 review D1).
 *
 * Every POST to a finance router draws on one per-user budget of 120 writes an
 * hour (`limitByMethod(['finance-read', 600], ['finance-write', 120])` on each
 * door). The staff reconciliation runner POSTs /staff/:id/reconcile once per
 * order, 1.2 s apart, so a recalculation of more than 120 orders locked the
 * owner out of approving and paying withdrawals, staff payments, expenses and
 * closing a period until the hour turned. /reconcile and /recheck now spend
 * their own `finance-reconcile` bucket INSTEAD of the shared one
 * (`limitInstead`, worker/lib/ratelimit.ts); the shared bucket still stops a
 * flood on every other write route.
 *
 * Run: node --import tsx --test tests/financeReconcileBudget.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, count, ctx, freshDb, get, json, post, row, stubApp, APEX } from './fixtures/app';
import { adminFinancePeopleRoutes } from '../worker/routes/adminFinancePeople';
import { financeEarningsRoutes } from '../worker/routes/financeEarnings';
import { baghdadDay } from '../worker/lib/operations';
import { sha256Hex } from '../worker/lib/crypto';
import worker from '../worker/index';

function setup() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope,email_verified_at) VALUES
    ('boss','boss@x.co','Owner','admin','full','2026-01-01T00:00:00.000Z'),('staff','staff@x.co','Sajjad','admin','assistant',NULL),('other','other@x.co','Other','customer',NULL,NULL);
    UPDATE finance_staff SET user_id='staff' WHERE id='staff_sajjad';
    INSERT INTO expense_categories(id,slug,name_ar) VALUES ('wages','test-wages','أجور');
    INSERT INTO products(id,name,slug,price_iqd,stock) VALUES ('p','Printer','budget-printer',50000,3);
    INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd)
    VALUES ('o','other','delivered','{}','standard','{}','cash',50000,1500,55000,55000);`);
  raw.prepare(`INSERT INTO finance_order_costs(id,order_id,rule_id,rule_version,rule_name,group_key,staff_id,category_id,milestone,base_iqd,qty,amount_iqd,cost_day,state,snapshot)
    VALUES ('cost','o','rule:cost',1,'تجهيز','prep','staff_sajjad','wages','delivered',40000,1,10000,?,'approved','{}')`).run(baghdadDay());
  // A finished recalculation: each POST /reconcile answers 200 with the job,
  // exactly as a page of a long run does, without needing hundreds of orders.
  raw.prepare(`INSERT INTO finance_staff_reconciliations(staff_id,revision,state,rules_json,actor_id,updated_at) VALUES ('staff_sajjad',1,'complete','[]','boss',?)`).run(new Date().toISOString());
  const db = asD1(raw);
  const make = (id: string, scope: string) =>
    stubApp(db, { id, email: `${id}@x.co`, role: 'admin', admin_scope: scope }, (a) => {
      a.route('/e', financeEarningsRoutes);
      a.route('/a', adminFinancePeopleRoutes);
    });
  const boss = make('boss', 'full');
  const self = make('staff', 'assistant');
  return { raw, boss, self };
}
const spent = (raw: ReturnType<typeof freshDb>, key: string) =>
  row<{ count: number }>(raw, 'SELECT count FROM rate_limits WHERE key = ?', key)?.count ?? 0;

test('200 reconciliation pages, then the owner still approves a withdrawal; the pages spent only their own bucket', async () => {
  const { raw, boss, self } = setup();
  assert.equal((await post(self, '/e/withdrawals', { operation_id: 'withdrawal-1', amount_iqd: 7000 })).status, 200);
  for (let i = 0; i < 200; i++) {
    const page = await post(boss, '/a/staff/staff_sajjad/reconcile', { revision: 1 });
    assert.equal(page.status, 200, `page ${i + 1}: ${JSON.stringify(await json(page))}`);
  }
  assert.equal(spent(raw, 'finance-reconcile:u:boss'), 200);
  assert.equal(spent(raw, 'finance-write:u:boss'), 0, 'the shared write budget is untouched');
  const approve = await post(boss, '/a/withdrawals/withdrawal-1/approve');
  assert.equal(approve.status, 200, JSON.stringify(await json(approve)));
  assert.equal(count(raw, "SELECT COUNT(*) n FROM finance_withdrawals WHERE id='withdrawal-1' AND state='approved'"), 1);
  assert.equal(spent(raw, 'finance-write:u:boss'), 1);
});

test('a recheck spends the paging bucket too; reading a job still spends the read bucket', async () => {
  const { raw, boss } = setup();
  const recheck = await post(boss, '/a/staff/staff_sajjad/recheck', { revision: 999, operation_id: 'recheck-op-1', reason: 'إعادة فحص تجريبية' });
  assert.notEqual(recheck.status, 429);
  assert.equal(spent(raw, 'finance-reconcile:u:boss'), 1);
  assert.equal(spent(raw, 'finance-write:u:boss'), 0);
  assert.equal((await get(boss, '/a/staff/staff_sajjad/reconcile')).status, 200);
  assert.equal(spent(raw, 'finance-read:u:boss'), 1);
  assert.equal(spent(raw, 'finance-reconcile:u:boss'), 1, 'a GET of the same path is a read, not a page');
});

test('the shared write budget still stops a flood on every other write route', async () => {
  const { raw, boss } = setup();
  for (let i = 0; i < 120; i++) {
    const r = await post(boss, '/a/withdrawals/no-such/reject');
    assert.notEqual(r.status, 429, `write ${i + 1} is inside the budget`);
  }
  const over = await post(boss, '/a/withdrawals/no-such/reject');
  assert.equal(over.status, 429);
  assert.equal((await json(over)).code, 'RATE_LIMITED');
  // …and the paging bucket is a separate allowance, not a way around it.
  assert.equal((await post(boss, '/a/staff/staff_sajjad/reconcile', { revision: 1 })).status, 200);
  assert.equal((await post(boss, '/a/withdrawals/no-such/approve')).status, 429, 'a page does not reset the write budget');
  assert.equal(spent(raw, 'finance-write:u:boss'), 122);
});

test('the paging bucket has its own ceiling, and spending it leaves the write budget whole', async () => {
  const { raw, boss, self } = setup();
  assert.equal((await post(self, '/e/withdrawals', { operation_id: 'withdrawal-1', amount_iqd: 7000 })).status, 200);
  const now = Math.floor(Date.now() / 1000);
  raw.prepare('INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, ?)').run('finance-reconcile:u:boss', now - (now % 3600), 3600);
  const refused = await post(boss, '/a/staff/staff_sajjad/reconcile', { revision: 1 });
  assert.equal(refused.status, 429, 'the 3601st page in an hour is refused — the runner leaves it to the cron');
  assert.equal((await post(boss, '/a/withdrawals/withdrawal-1/approve')).status, 200);
});

test('a refused caller (an assistant) spends the paging bucket, never the owner\'s or its own write budget', async () => {
  const { raw, self } = setup();
  const r = await post(self, '/a/staff/staff_sajjad/reconcile', { revision: 1 });
  assert.equal(r.status, 403);
  assert.equal(spent(raw, 'finance-reconcile:u:staff'), 1);
  assert.equal(spent(raw, 'finance-write:u:staff'), 0);
  assert.equal(spent(raw, 'finance-reconcile:u:boss') + spent(raw, 'finance-write:u:boss'), 0);
});

test('through the real Worker: 125 pages, then a finance write is still answered by its route, not the limiter', async () => {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role,email_verified_at) VALUES ('boss','Boss','boss@x.co','h','admin','2026-10-01T00:00:00.000Z')`);
  raw.prepare(`INSERT INTO finance_staff_reconciliations(staff_id,revision,state,rules_json,actor_id,updated_at) VALUES ('staff_sajjad',1,'complete','[]','boss',?)`).run(new Date().toISOString());
  const token = 'owner-session-token-budget-0001';
  raw.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').run(await sha256Hex(token), 'boss', new Date(Date.now() + 86_400_000).toISOString());
  const env = { DB: asD1(raw), STORE_ROOT_DOMAIN: APEX, APP_ORIGIN: `https://${APEX}`, INITIAL_ADMIN_EMAIL: 'boss@x.co', EXTRA_ALLOWED_ORIGINS: '', ASSETS: { fetch: async () => new Response('spa') } };
  const call = (path: string, body: unknown) =>
    worker.fetch(new Request(`https://${APEX}${path}`, { method: 'POST', headers: { Host: APEX, Origin: `https://${APEX}`, Cookie: `levonis_session=${token}`, 'content-type': 'application/json', 'CF-Connecting-IP': '9.9.9.9' }, body: JSON.stringify(body) }), env as never, ctx);
  const statuses = new Map<number, number>();
  for (let i = 0; i < 125; i++) {
    const r = await call('/api/admin/finance-people/staff/staff_sajjad/reconcile', { revision: 1 });
    statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
  }
  assert.deepEqual([...statuses], [[200, 125]]);
  const other = await call('/api/admin/finance-people/withdrawals/wd_x/approve', {});
  assert.notEqual(other.status, 429, 'before the fix this was 429 for the rest of the hour');
  assert.equal(spent(raw, 'finance-write:u:boss'), 1);
});
