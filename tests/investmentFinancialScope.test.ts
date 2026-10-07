import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, post, stubApp } from './fixtures/app';
import { adminRoutes } from '../worker/routes/admin';

test('personal investor status does not grant an assistant access to investment administration', async () => {
  const raw = freshDb();
  const app = stubApp(asD1(raw), {
    id: 'assistant', role: 'admin', email: 'assistant@example.com', admin_scope: 'assistant', is_investor: 1,
  }, (a) => a.route('/api/admin', adminRoutes));
  for (const response of [
    await get(app, '/api/admin/invest/users'),
    await get(app, '/api/admin/invest/users/other-user'),
    await post(app, '/api/admin/invest/users/other-user/investments', { amount_usd_cents: 10000 }),
  ]) {
    assert.equal(response.status, 403);
    assert.equal((await json(response)).code, 'COST_ACCESS_DENIED');
  }
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM investments').get()?.n, 0);
  raw.close();
});

test('the legacy investment register is the owner\'s alone — a full admin is refused (owner decision 2)', async () => {
  const raw = freshDb();
  const full = stubApp(asD1(raw), {
    id: 'finance-admin', role: 'admin', email: 'finance@example.com', admin_scope: 'full',
  }, (a) => a.route('/api/admin', adminRoutes));
  const refused = await get(full, '/api/admin/invest/users');
  assert.equal(refused.status, 403);
  assert.equal((await json(refused)).code, 'COST_ACCESS_DENIED');
  const owner = stubApp(asD1(raw), { id: 'usr_owner', role: 'admin', email: 'boss@x.co' }, (a) => a.route('/api/admin', adminRoutes));
  const response = await get(owner, '/api/admin/invest/users');
  assert.equal(response.status, 200);
  assert.equal((await json(response)).success, true);
  raw.close();
});
