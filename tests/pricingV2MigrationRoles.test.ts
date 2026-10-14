/**
 * PRICING V2-5 — THE MIGRATION IS THE OWNER'S ALONE (spec §6.1, §6.5; owner
 * decision 2; DECISIONS rows 184 (2), 220).
 *
 *   - Every migration route is refused to every non-owner — guest, customer,
 *     merchant, assistant, full and legacy NULL-scope admins, the grantee
 *     while delegation is off, the employee, the investor, the support
 *     assistant — with COST_ACCESS_DENIED, the same bytes for a real id and an
 *     invented one; the owner's own unverified session hears
 *     OWNER_EMAIL_UNVERIFIED.
 *   - Nothing of a legacy snapshot or a proposal reaches anyone else: every
 *     non-owner GET of the product, pricing, storefront and public routers
 *     carries no `v2_*` key and no figure of the snapshot (the role matrix
 *     seeds its costly product's snapshot and V2 rows with V2_SENTINELS).
 *
 * Run: REQUIRE_DIST=1 node --import tsx --test tests/pricingV2MigrationRoles.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLES, OWNER, OWNER_UNVERIFIED, appFor, call, leaks, seededCopy, seededCopyUnverifiedOwner, sweepGets, type MountSpec, type Router } from './fixtures/roleMatrix';
import { V2_SENTINELS } from './fixtures/fxSentinels';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { adminProductsRoutes } from '../worker/routes/adminProducts';
import { productRoutes } from '../worker/routes/products';
import { publicApiRoutes } from '../worker/routes/publicApi';

const MOUNTS: readonly MountSpec[] = [['/api/admin/pricing', adminPricingRoutes as Router]];
const ROUTES = (id: string): Array<[string, string, unknown?]> => [
  ['GET', '/api/admin/pricing/v2/migration'],
  ['GET', `/api/admin/pricing/v2/migration/${id}`],
  ['POST', `/api/admin/pricing/v2/migration/${id}/preview`, { option: 'keep_usd' }],
  ['POST', `/api/admin/pricing/v2/migration/${id}/commit`, { option: 'keep_usd', preview_hash: 'a'.repeat(64) }],
  ['POST', '/api/admin/pricing/v2/migration/commit-unchanged', { items: [{ product_id: id, preview_hash: 'a'.repeat(64) }] }],
];

test('every migration route: every non-owner is refused at the door, one answer for a real id and an invented one', async () => {
  for (const [role, user] of Object.entries(ROLES)) {
    const app = appFor(seededCopy(), user ?? null, MOUNTS);
    for (const [k, [method, path, body]] of ROUTES('p_a1').entries()) {
      const real = await call(app, method, path, body);
      const invented = await call(app, method, ROUTES('zz-no-such-product')[k]![1], ROUTES('zz-no-such-product')[k]![2]);
      assert.ok(real.status === 401 || real.status === 403, `${role} ${method} ${path}: ${real.status}`);
      // An admin is refused by the cost door; anyone else never gets past the admin door.
      if (user?.role === 'admin') assert.equal((real.body as { code?: string }).code, 'COST_ACCESS_DENIED', `${role} ${method} ${path}`);
      assert.deepEqual(invented.body, real.body, `${role} ${method} ${path}: the same answer for a real and an invented id`);
      assert.deepEqual(leaks(real.body), []);
    }
  }
  const unverified = appFor(seededCopyUnverifiedOwner(), OWNER_UNVERIFIED, MOUNTS);
  for (const [method, path, body] of ROUTES('p_a1')) {
    const r = await call(unverified, method, path, body);
    assert.equal(r.status, 403);
    assert.equal((r.body as { code?: string }).code, 'OWNER_EMAIL_UNVERIFIED', `${method} ${path}`);
  }
  // …and the owner is not refused.
  const owner = appFor(seededCopy(), OWNER, MOUNTS);
  const list = await call(owner, 'GET', '/api/admin/pricing/v2/migration');
  assert.equal(list.status, 200, JSON.stringify(list.body).slice(0, 200));
});

test('no snapshot figure and no proposal key reaches anyone but the owner', async () => {
  const extra = { decimals: [...V2_SENTINELS], numbers: V2_SENTINELS.map(Number) };
  const mounts: readonly MountSpec[] = [
    ['/api/admin/products-v2', adminProductsRoutes as Router],
    ['/api/admin/pricing', adminPricingRoutes as Router],
    ['/api/products', productRoutes as Router],
    ['/api/public/v1', publicApiRoutes as Router],
  ];
  const sweep = await sweepGets({ mounts, extra });
  for (const [role, r] of Object.entries(sweep)) {
    assert.deepEqual(r.leaks, [], `${role}`);
    for (const [path, status] of Object.entries(r.statuses)) {
      if (path.includes('/v2/migration')) assert.ok(status === 401 || status === 403, `${role} ${path}: ${status}`);
    }
  }
});
