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
import { adminRoutes } from '../worker/routes/admin';
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

/**
 * EVERY ADMIN ROUTE, CLASSIFIED BY HAND (review S6).
 *
 * The walk used to trust a path word — `/payout|escrow|finance|…/` — so a
 * money route with a neutral name slipped past it: the admin ORDER doors in
 * worker/routes/admin.ts refund a paid store order and claw back a released
 * merchant credit, and an assistant-scope admin could do both. Now every route
 * both admin routers declare is listed here with what it does to money, and a
 * route that is not listed fails the walk — adding one is a decision somebody
 * writes down.
 *
 *   guard     moves or shows money; refuses an assistant ON THE DECLARATION
 *             (`requireFinancialScope`) — checked structurally below;
 *   handler   moves money on one branch; the handler refuses an assistant
 *             there — each one exercised by a request below;
 *   projected shows aggregates with the financial figures projected away for
 *             an assistant (`canViewFinancials`);
 *   desk      shows or moves CUSTOMER money as the operations desk, open to an
 *             assistant by the platform's pre-wave-1 rule — listed by name so
 *             that each one is a visible choice the owner can revisit;
 *   none      neither moves nor shows money.
 *
 * Product COST and margin are a separate rule with their own tests
 * (tests/adminScope.test.ts); this list is about money that moves.
 */
type MoneyClass = 'guard' | 'handler' | 'projected' | 'desk' | 'none';

const ADMIN_COMMUNITY_ROUTES: Record<string, MoneyClass> = {
  'GET /overview': 'projected',
  'GET /settings': 'none',
  'PATCH /settings': 'guard',
  'GET /gate': 'none',
  'GET /gate/lookup': 'none',
  'PUT /gate': 'none',
  'GET /merchants': 'none',
  'POST /merchants/:id/verify': 'none',
  'POST /merchants/:id/status': 'none',
  'POST /merchants/:id/badge': 'none',
  'POST /stores/:id/status': 'none',
  'GET /merchants/:id/products': 'none',
  'POST /products/:id/hide': 'none',
  'POST /reviews/:id/hide': 'none',
  'POST /requests/:id/remove': 'none',
  'GET /requests': 'none',
  // The moderation desk reads the one order's escrow to handle a complaint;
  // it cannot move it (resolve is `guard`).
  'GET /requests/:id': 'desk',
  'POST /offers/:id/reject': 'none',
  'GET /reviews': 'none',
  'GET /merchants/:id/reputation': 'none',
  'POST /merchants/:id/reputation': 'none',
  'GET /complaints': 'none',
  'GET /complaints/:id': 'desk',
  'POST /complaints/:id/status': 'none',
  'POST /complaints/:id/messages': 'none',
  'POST /escrows/:id/resolve': 'guard',
  'GET /merchants/:id/finance': 'guard',
  'GET /reconciliation/store-orders': 'guard',
  'POST /reconciliation/store-orders/:id/refund': 'guard',
  'POST /reconciliation/store-orders/:id/reverse-credit': 'guard',
  'POST /merchants/:id/payout': 'guard',
  // The merchant ledger's payout queue, adjustments and backfill parity (W2-B).
  'GET /payouts': 'guard',
  'POST /payouts/:id/approve': 'guard',
  'POST /payouts/:id/paid': 'guard',
  'POST /payouts/:id/fail': 'guard',
  'POST /merchants/:id/adjustment': 'guard',
  'GET /ledger/parity': 'guard',
};

const ADMIN_ROUTES: Record<string, MoneyClass> = {
  'GET /providers': 'none',
  'GET /overview': 'projected',
  'POST /telegram/test': 'none',
  'POST /providers/test': 'none',
  'GET /users': 'none',
  'GET /users/lookup': 'none',
  'GET /users/:id/detail': 'projected',
  'PATCH /users/:id': 'none',
  'GET /products': 'none',
  'POST /products': 'none',
  'DELETE /products/:id': 'none',
  // The deposit and withdrawal desk: reviewing a customer's transfer is the
  // assistant desk's daily work under the platform's existing rule.
  'GET /wallet-requests': 'desk',
  'POST /wallet-requests/:id/decide': 'desk',
  'POST /wallet/credit': 'handler',
  'GET /orders': 'none',
  'DELETE /orders/:id': 'none',
  'GET /orders/:id': 'none',
  'GET /orders/:id/stages': 'none',
  'GET /orders/:id/receipt': 'none',
  'GET /orders/:id/warranty-receipt': 'none',
  'GET /orders/:id/label': 'none',
  'GET /labels': 'none',
  'GET /delivery/config': 'none',
  'POST /delivery/statuses/refresh': 'none',
  'GET /delivery/statuses': 'none',
  'PUT /delivery/statuses/:remoteId': 'none',
  'POST /orders/:id/delivery': 'none',
  'POST /orders/:id/delivery/sync': 'none',
  'POST /delivery/sync': 'none',
  'POST /orders/sweep-stages': 'none',
  'POST /orders/:id/gini-receipt': 'none',
  // A community-STORE order's cancel refunds and claws back: financial scope
  // (review S6). A Levonis order's cancellation refund stays the shop desk's.
  'PATCH /orders/:id/stage': 'handler',
  'PATCH /orders/:id': 'handler',
  'GET /coupons': 'none',
  'POST /coupons': 'none',
  'PATCH /coupons/:id': 'none',
  'DELETE /coupons/:id': 'none',
  'GET /settings': 'none',
  'GET /site-media': 'none',
  'POST /site-media/:slot': 'none',
  'DELETE /site-media/:slot': 'none',
  // Includes the exchange rate every wallet's dinar reading depends on.
  'PUT /settings/:key': 'desk',
  'GET /warranty-claims': 'none',
  'PATCH /warranty-claims/:id': 'none',
  // Investor positions: records of money held outside the wallet.
  'GET /invest/users': 'desk',
  'GET /invest/users/:userId': 'desk',
  'POST /invest/users/:userId/investments': 'desk',
  'PATCH /invest/investments/:id': 'desk',
  'DELETE /invest/investments/:id': 'desk',
  'POST /invest/investments/:id/items': 'desk',
  'DELETE /invest/items/:id': 'desk',
  'POST /invest/users/:userId/messages': 'none',
  'GET /blocked-terms': 'none',
  'POST /blocked-terms': 'none',
  'DELETE /blocked-terms/:term': 'none',
};

function walk(router: { routes: Array<{ method: string; path: string; handler: unknown }> }) {
  const guarded = new Set<string>();
  const declared = new Set<string>();
  for (const r of router.routes) {
    if (r.method === 'ALL') continue;
    declared.add(`${r.method} ${r.path}`);
    if (r.handler === requireFinancialScope) guarded.add(`${r.method} ${r.path}`);
  }
  return { declared, guarded };
}

test('EVERY admin route is classified — a new one, whatever its name, fails until somebody decides what it does to money', () => {
  for (const [name, router, list] of [
    ['adminCommunity.ts', adminCommunityRoutes, ADMIN_COMMUNITY_ROUTES],
    ['admin.ts', adminRoutes, ADMIN_ROUTES],
  ] as const) {
    const { declared } = walk(router as never);
    const unclassified = [...declared].filter((r) => !(r in list));
    assert.deepEqual(unclassified, [], `${name}: classify these routes in tests/communityMoneyScope.test.ts`);
    const stale = Object.keys(list).filter((r) => !declared.has(r));
    assert.deepEqual(stale, [], `${name}: the list names routes that no longer exist`);
  }
});

test('the guard sits on the ROUTE DECLARATION of every `guard` route — and only a `guard` route carries it', () => {
  for (const [name, router, list] of [
    ['adminCommunity.ts', adminCommunityRoutes, ADMIN_COMMUNITY_ROUTES],
    ['admin.ts', adminRoutes, ADMIN_ROUTES],
  ] as const) {
    const { guarded } = walk(router as never);
    for (const [route, cls] of Object.entries(list)) {
      if (cls === 'guard') assert.ok(guarded.has(route), `${name} ${route} must carry requireFinancialScope`);
      else assert.ok(!guarded.has(route), `${name} ${route} carries the guard but is classified ${cls} — reclassify it`);
    }
  }
});

// ------------------------------------------------ the `handler` routes, run

const ADMIN_ASSISTANT: StubUser = { id: 'aide', role: 'admin', email: 'aide@x.co', admin_scope: 'assistant' };

function seedStoreOrder() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,admin_scope) VALUES
      ('buyer','Sara','buyer@x.co','h','customer',NULL), ('owner','Ali','ali@x.co','h','merchant',NULL),
      ('aide','Aide','aide@x.co','h','admin','assistant');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Ali 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('s1','m1','owner','ali3d','Ali 3D');
    INSERT INTO orders (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
                        subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,wallet_applied_iqd,wallet_applied_usd_cents,
                        seller_type,merchant_id,store_id,origin,stage)
      VALUES ('ORD-S1','buyer','confirmed','{}','merchant','{}','wallet',14000,1400,14000,0,14000,1000,
              'merchant','m1','s1','store_product','confirmed');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note,ref)
      VALUES ('dep','buyer','deposit','USD',5000,'approved','seed',''), ('wtx_hold_h1','buyer','withdrawal','USD',1000,'approved','pay','ORD-S1');
    INSERT INTO merchant_payout_ledger (id,merchant_id,kind,amount_iqd,state,order_id,idempotency_key)
      VALUES ('pl1','m1','sale_credit',13300,'pending','ORD-S1','sale:ORD-S1');
  `);
  return raw;
}

test('`handler` routes refuse an assistant exactly where money moves: the store-order cancel (both doors) and the manual wallet credit', async () => {
  const raw = seedStoreOrder();
  const aide = stubApp(asD1(raw), ADMIN_ASSISTANT, (a) => a.route('/api/admin', adminRoutes));
  for (const [path, body] of [
    ['/api/admin/orders/ORD-S1', { status: 'cancelled' }],
    ['/api/admin/orders/ORD-S1/stage', { stage: 'cancelled' }],
  ] as const) {
    const res = await patch(aide, path, body);
    assert.equal(res.status, 403, path);
    assert.equal((await json(res)).code, 'FINANCIAL_SCOPE_REQUIRED', path);
  }
  assert.equal(row<{ status: string }>(raw, "SELECT status FROM orders WHERE id = 'ORD-S1'")!.status, 'confirmed');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM wallet_transactions WHERE id = 'wtx_refund_ORD-S1_usd'"), 0, 'no refund');
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM merchant_payout_ledger WHERE id = 'pl1'")!.state, 'pending');
  // A move that moves no money stays the assistant desk's.
  const moved = await patch(aide, '/api/admin/orders/ORD-S1', { status: 'processing' });
  assert.equal(moved.status, 200, JSON.stringify(await json(moved.clone())));

  const credit = await post(aide, '/api/admin/wallet/credit', {
    userId: 'buyer', currency: 'USD', amount: 100, note: 'goodwill', idempotencyKey: 'aide-credit-1',
  });
  assert.equal(credit.status, 403);
  assert.equal((await json(credit)).code, 'FINANCIAL_SCOPE_REQUIRED');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM wallet_transactions WHERE created_by = 'admin'"), 0);
});
