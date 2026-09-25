/**
 * THE LIVE D1 REFUSES A STATEMENT WITH MORE THAN 100 BOUND PARAMETERS
 * (review of the live merchant platform, F1).
 *
 * The local engine allows 32 766, so an `IN (?, ?, …)` built one placeholder
 * per id passes every local test and fails in production the day a list grows
 * past 99 — the offers on a busy request (every offering workshop's PRO
 * badge), a customer who follows 150 shops, a page of 150 products. These run
 * each fixed door through `LimitD1` (tests/fixtures/d1Limits.ts), which throws
 * exactly as the live D1 does, with 150 ids; the lists now travel as ONE
 * `json_each(?)` parameter.
 *
 * Run: node --import tsx --test tests/d1BoundParamLists.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, stubApp, get, post, json } from './fixtures/app';
import { limitD1, violations } from './fixtures/d1Limits';
import { FUTURE } from './fixtures/reviewE2eWorld';
import { usersWithEntitlement } from '../worker/lib/entitlements';
import { getOrderPointsSnapshots } from '../worker/lib/pointsOps';
import { supportEligibleProductIds } from '../worker/lib/membershipOps';
import { loadRelationsViews } from '../worker/lib/productOverlay';
import { catalogsArePrinter } from '../worker/lib/warrantyPlans';
import { loadMaterialPhysics, loadMaterialPrices } from '../worker/lib/printQuote/repository';
import { communityRoutes } from '../worker/routes/community';
import { orderRoutes } from '../worker/routes/orders';
import { adminRoutes } from '../worker/routes/admin';
import type { Env } from '../worker/lib/types';

const ids = (prefix: string, n = 150) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

function seeded() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','Sara','s@x.co','h','customer'), ('boss','Boss','b@x.co','h','admin');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');`);
  // 150 shop owners, every third one a PRO member, each followed by the buyer.
  for (let i = 0; i < 150; i++) {
    raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES ('u${i}','U${i}','u${i}@x.co','h','customer');
      INSERT INTO community_merchants (id,user_id,name) VALUES ('mm${i}','u${i}','M${i}');
      INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('ss${i}','mm${i}','u${i}','shop${i}x','S${i}');
      INSERT INTO follows (user_id, merchant_id) VALUES ('buyer','mm${i}');`);
    if (i % 3 === 0) {
      raw.exec(`INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at)
        VALUES ('mem${i}','u${i}','pro_12mo','pro','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}');`);
    }
  }
  return raw;
}

test('usersWithEntitlement: 150 users in one call, on the live limits', async () => {
  const raw = seeded();
  const before = violations.length;
  const pro = await usersWithEntitlement(limitD1(raw), ids('u'), 'proMerchantBadge');
  assert.equal(violations.length, before, violations.slice(before).join('\n'));
  // Every entitled owner is found — the list was not truncated to fit.
  assert.deepEqual([...pro].sort(), ids('u').filter((_, i) => i % 3 === 0).sort());
});

test('GET /api/community/followed with 150 followed shops answers 200', async () => {
  const raw = seeded();
  const app = stubApp(limitD1(raw), { id: 'buyer', role: 'customer', email: 's@x.co' }, (a) => a.route('/api/community', communityRoutes));
  const res = await get(app, '/api/community/followed');
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 300));
  assert.equal(body.merchants.length, 150);
});

test('the other page-of-ids readers take 150 ids without passing 100 parameters', async () => {
  const raw = seeded();
  const db = limitD1(raw);
  const before = violations.length;
  await getOrderPointsSnapshots({ DB: db } as unknown as Env, ids('ord'));
  await supportEligibleProductIds(db, ids('prd'));
  await loadRelationsViews(db, ids('prd').map((id) => ({ id, inventory_mode: 'simple' })));
  await catalogsArePrinter(db, ids('cat'));
  await loadMaterialPhysics(db, ids('mat'));
  await loadMaterialPrices(db, 'mm0', ids('mat'));
  assert.deepEqual(violations.slice(before), []);
});

test('checkout with 100 selected cart lines is not a D1 error (user id + 100 ids)', async () => {
  const raw = seeded();
  raw.exec(`INSERT INTO addresses (id,user_id,name,phone,address,governorate) VALUES ('a1','buyer','Sara','+9647701234567','Street 1','baghdad');`);
  const app = stubApp(limitD1(raw), { id: 'buyer', role: 'customer', email: 's@x.co' }, (a) => a.route('/api/orders', orderRoutes));
  const before = violations.length;
  const res = await post(app, '/api/orders/quote', { addressId: 'a1', deliveryMethodId: 'standard', itemIds: ids('ci', 100) });
  assert.deepEqual(violations.slice(before), []);
  assert.notEqual(res.status, 500, JSON.stringify(await json(res)));
});

test('the admin label sheet takes 100 order ids (2 stages + 100 ids used to be 102 parameters)', async () => {
  const raw = seeded();
  const app = stubApp(limitD1(raw), { id: 'boss', role: 'admin', email: 'b@x.co' }, (a) => a.route('/api/admin', adminRoutes));
  const before = violations.length;
  const res = await get(app, `/api/admin/labels?ids=${ids('ord', 100).join(',')}`);
  assert.deepEqual(violations.slice(before), []);
  assert.notEqual(res.status, 500);
});
