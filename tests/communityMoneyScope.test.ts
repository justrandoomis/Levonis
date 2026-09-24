/**
 * THE COMMUNITY'S MONEY IS BEHIND THE FINANCIAL SCOPE (audit 04 B2).
 *
 * `worker/routes/adminCommunity.ts` checked the admin ROLE and nothing else,
 * so an assistant-scope admin — who may not even see a product's cost — could
 * resolve a disputed escrow (release or refund real money), record a payout to
 * a merchant, read a merchant's ledger, and change the platform's commission.
 * The platform's own rule is the 403 `walletAdjust.ts` answers such an admin.
 *
 * The routes run for real against every migration; only the session is
 * stubbed. The assertions are about what did NOT happen as much as the status:
 * a refused payout wrote no ledger row, a refused commission change left the
 * setting alone, a refused settlement moved no escrow.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, post, patch, get, json, count, row, type StubUser } from './fixtures/app';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';
import { requireFinancialScope } from '../worker/lib/walletAdjust';

const ASSISTANT: StubUser = { id: 'aide', role: 'admin', email: 'aide@x.co', admin_scope: 'assistant' };
const FULL: StubUser = { id: 'fin', role: 'admin', email: 'fin@x.co', admin_scope: 'full' };
// The site owner is financial whatever their stored scope says (adminScope.ts).
const OWNER_AS_ASSISTANT: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co', admin_scope: 'assistant' };

function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','buyer@x.co','h','customer'), ('owner','Ali','ali@x.co','h','merchant'),
      ('aide','Aide','aide@x.co','h','admin'), ('fin','Fin','fin@x.co','h','admin'), ('boss','Boss','boss@x.co','h','admin');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Ali 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('s1','m1','owner','ali3d','Ali 3D');
    INSERT INTO merchant_payout_ledger (id, merchant_id, kind, amount_iqd, state, idempotency_key)
      VALUES ('l1','m1','sale_credit',10000,'available','k1');
    INSERT INTO community_requests (id,customer_id,title,state) VALUES ('r1','buyer','Bracket','disputed');
    INSERT INTO community_offers (id,request_id,merchant_id,store_id,price_iqd,state) VALUES ('o1','r1','m1','s1',50000,'accepted');
    INSERT INTO community_orders (id,request_id,offer_id,customer_id,merchant_id,store_id,state,price_iqd,platform_fee_iqd,merchant_receivable_iqd)
      VALUES ('co1','r1','o1','buyer','m1','s1','disputed',50000,2500,47500);
    INSERT INTO community_escrows (id,community_order_id,customer_id,merchant_id,gross_iqd,platform_fee_iqd,merchant_receivable_iqd,state)
      VALUES ('e1','co1','buyer','m1',50000,2500,47500,'disputed');
  `);
  return raw;
}

const app = (raw: ReturnType<typeof freshDb>, user: StubUser) =>
  stubApp(asD1(raw), user, (a) => a.route('/api/admin/community', adminCommunityRoutes));

test('an ASSISTANT-scope admin gets 403 FINANCIAL_SCOPE_REQUIRED on every community money route — and nothing moves', async () => {
  const raw = seed();
  const a = app(raw, ASSISTANT);

  const payout = await post(a, '/api/admin/community/merchants/m1/payout', { amount_iqd: 5000, idempotencyKey: 'payout-assist-1' });
  assert.equal(payout.status, 403);
  assert.equal((await json(payout)).code, 'FINANCIAL_SCOPE_REQUIRED');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM merchant_payout_ledger WHERE kind = 'payout'"), 0, 'no payout row');

  const resolve = await post(a, '/api/admin/community/escrows/e1/resolve', { decision: 'release', reason: 'looks fine' });
  assert.equal(resolve.status, 403);
  assert.equal((await json(resolve)).code, 'FINANCIAL_SCOPE_REQUIRED');
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM community_escrows WHERE id = 'e1'")!.state, 'disputed');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_escrow_events'), 0, 'no escrow event');

  const settings = await patch(a, '/api/admin/community/settings', { communityFeeStorePercentX100: 0 });
  assert.equal(settings.status, 403);
  assert.equal((await json(settings)).code, 'FINANCIAL_SCOPE_REQUIRED');
  assert.equal(
    count(raw, "SELECT COUNT(*) AS n FROM admin_settings WHERE key = 'communityFeeStorePercentX100' AND value = '0'"),
    0,
    'the commission is untouched'
  );

  const finance = await get(a, '/api/admin/community/merchants/m1/finance');
  assert.equal(finance.status, 403);
  assert.equal((await json(finance)).code, 'FINANCIAL_SCOPE_REQUIRED');
});

test('a FULL-scope admin, and the owner whatever their stored scope, pass the same routes', async () => {
  for (const user of [FULL, OWNER_AS_ASSISTANT]) {
    const raw = seed();
    const a = app(raw, user);
    const finance = await get(a, '/api/admin/community/merchants/m1/finance');
    assert.equal(finance.status, 200, `${user.id}: finance`);
    const settings = await patch(a, '/api/admin/community/settings', { communityFeeStorePercentX100: 450 });
    assert.equal(settings.status, 200, `${user.id}: settings`);
    const payout = await post(a, '/api/admin/community/merchants/m1/payout', { amount_iqd: 5000, idempotencyKey: `payout-${user.id}-1` });
    assert.notEqual(payout.status, 403, `${user.id}: payout is not refused on scope`);
    const resolve = await post(a, '/api/admin/community/escrows/e1/resolve', { decision: 'release', reason: 'delivered as agreed' });
    assert.notEqual(resolve.status, 403, `${user.id}: settlement is not refused on scope`);
  }
});

test('the overview withholds the platform commission from an assistant, and shows it to a financial admin', async () => {
  const raw = seed();
  const aide = await json(await get(app(raw, ASSISTANT), '/api/admin/community/overview'));
  assert.equal(aide.financial, false);
  assert.equal(aide.orders.fees, null, 'commission is profit — §11');
  assert.equal(aide.store_sales.fees, null);
  const fin = await json(await get(app(raw, FULL), '/api/admin/community/overview'));
  assert.equal(fin.financial, true);
  assert.equal(typeof fin.orders.fees, 'number');
});

test('the guard sits on the ROUTE DECLARATION of every money route, and a new money route cannot skip it', () => {
  // Hono lists each handler of a route as its own entry, the middleware
  // included, so the guard is visible here without a request.
  const guarded = new Set(
    adminCommunityRoutes.routes
      .filter((r) => r.handler === requireFinancialScope)
      .map((r) => `${r.method} ${r.path}`)
  );
  for (const expected of [
    'PATCH /settings',
    'POST /escrows/:id/resolve',
    'GET /merchants/:id/finance',
    'POST /merchants/:id/payout',
  ]) {
    assert.ok(guarded.has(expected), `${expected} must carry requireFinancialScope`);
  }
  // Anything whose path names money must be in the guarded set.
  const money = /payout|escrow|finance|ledger|refund|release|commission/i;
  for (const r of adminCommunityRoutes.routes) {
    if (r.method === 'ALL') continue;
    if (!money.test(r.path)) continue;
    assert.ok(guarded.has(`${r.method} ${r.path}`), `${r.method} ${r.path} moves or shows money and is not guarded`);
  }
});
