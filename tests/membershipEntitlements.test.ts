/**
 * The paid-membership contract in one place. These tests deliberately call
 * the same helpers/routes used by checkout, merchant and community flows;
 * no browser-supplied tier participates in any verdict.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { freshDb, asD1, stubApp, get, json } from './fixtures/app';
import type { AppContext } from '../worker/lib/types';
import {
  ENTITLEMENT_MINIMUM_TIER,
  TIER_INHERITANCE,
  dailyRewardMultiplierX100,
  entitlementSnapshot,
  getTierStatus,
  type TierStatus,
} from '../worker/lib/entitlements';
import { membershipsRoutes } from '../worker/routes/memberships';

const status = (tier: TierStatus['tier'], active = true, gated_benefits: string[] = []): TierStatus => ({
  tier,
  active,
  expires_at: active ? '2099-01-01T00:00:00.000Z' : null,
  pending_launch: null,
  gated_benefits,
});

test('PLUS → PREMIUM → PRO is the one authoritative inheritance matrix', () => {
  assert.deepEqual(TIER_INHERITANCE, {
    free: ['free'],
    plus: ['free', 'plus'],
    prime: ['free', 'plus', 'prime'],
    pro: ['free', 'plus', 'prime', 'pro'],
  });

  const plus = entitlementSnapshot(status('plus'));
  assert.equal(plus.merchantStore, true);
  assert.equal(plus.merchantProducts, true);
  assert.equal(plus.merchantOrders, true);
  assert.equal(plus.merchantAnalytics, true);
  assert.equal(plus.merchantSubdomain, true);
  assert.equal(plus.communityOffers, true);
  assert.equal(plus.exclusiveSections, true);
  assert.equal(plus.premiumPricing, false);
  assert.equal(plus.bnpl, false, 'PLUS must never receive or tease BNPL');

  const premium = entitlementSnapshot(status('prime'));
  for (const [name, minimum] of Object.entries(ENTITLEMENT_MINIMUM_TIER)) {
    if (minimum === 'plus') assert.equal(premium[name as keyof typeof premium], true, `PREMIUM did not inherit ${name}`);
  }
  assert.equal(premium.premiumPricing, true);
  assert.equal(premium.premiumDelivery, true);
  assert.equal(premium.premiumRewards, true);
  assert.equal(premium.bnpl, false, 'PREMIUM must never receive BNPL');

  const pro = entitlementSnapshot(status('pro'));
  for (const name of Object.keys(ENTITLEMENT_MINIMUM_TIER)) {
    assert.equal(pro[name as keyof typeof pro], true, `PRO is missing ${name}`);
  }
  assert.equal(pro.priorityDelivery12h, true);
  assert.equal(pro.proMerchantBadge, true);
  assert.equal(pro.priorityService, true);
  assert.equal(pro.bnpl, true);

  assert.equal('customDomain' in ENTITLEMENT_MINIMUM_TIER, false, 'the retired custom-domain feature must not return');
  for (const value of Object.values(entitlementSnapshot(status('pro', false)))) assert.equal(value, false);
});

test('daily login rewards rise with the inherited tiers and PRO is doubled', () => {
  assert.equal(dailyRewardMultiplierX100(status('plus')), 100);
  assert.equal(dailyRewardMultiplierX100(status('prime')), 150);
  assert.equal(dailyRewardMultiplierX100(status('pro')), 200);
  assert.equal(dailyRewardMultiplierX100(status('pro', false)), 100);
});

test('expiry, upgrades, downgrades and cancellation change entitlements immediately', async () => {
  const raw = freshDb();
  const db = asD1(raw);
  raw.exec(`
    INSERT INTO users (id,email,password_hash) VALUES ('u','u@x.co','h'), ('expired','expired@x.co','h');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at) VALUES
      ('m_plus','u','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z'),
      ('m_expired','expired','pro_12mo','pro','active',12,'2019-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z');
  `);

  let resolved = await getTierStatus(db, 'u');
  assert.equal(resolved.tier, 'plus');
  assert.equal(entitlementSnapshot(resolved).merchantStore, true);

  raw.exec(`
    UPDATE memberships SET state='cancelled' WHERE id='m_plus';
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at)
      VALUES ('m_premium','u','prime_12mo','prime','active',12,'2026-02-01T00:00:00.000Z','2099-02-01T00:00:00.000Z');
  `);
  resolved = await getTierStatus(db, 'u');
  assert.equal(resolved.tier, 'prime');
  assert.equal(entitlementSnapshot(resolved).merchantStore, true, 'upgrade retains PLUS');
  assert.equal(entitlementSnapshot(resolved).premiumPricing, true);
  assert.equal(entitlementSnapshot(resolved).bnpl, false);

  raw.exec(`
    UPDATE memberships SET state='cancelled' WHERE id='m_premium';
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at)
      VALUES ('m_pro','u','pro_12mo','pro','active',12,'2026-03-01T00:00:00.000Z','2099-03-01T00:00:00.000Z');
  `);
  resolved = await getTierStatus(db, 'u');
  assert.equal(entitlementSnapshot(resolved).premiumPricing, true, 'PRO inherits PREMIUM');
  assert.equal(entitlementSnapshot(resolved).bnpl, true);

  raw.exec(`
    UPDATE memberships SET state='cancelled' WHERE id='m_pro';
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at)
      VALUES ('m_plus_2','u','plus_12mo','plus','active',12,'2026-04-01T00:00:00.000Z','2099-04-01T00:00:00.000Z');
  `);
  resolved = await getTierStatus(db, 'u');
  assert.equal(resolved.tier, 'plus');
  assert.equal(entitlementSnapshot(resolved).premiumPricing, false, 'downgrade removes PREMIUM');
  assert.equal(entitlementSnapshot(resolved).bnpl, false, 'downgrade removes BNPL');

  raw.exec("UPDATE memberships SET state='cancelled' WHERE id='m_plus_2'");
  resolved = await getTierStatus(db, 'u');
  assert.equal(resolved.tier, 'free');
  assert.equal(entitlementSnapshot(resolved).merchantStore, false, 'cancellation removes protected access');

  const lapsed = await getTierStatus(db, 'expired');
  assert.equal(lapsed.tier, 'free');
  assert.equal(raw.prepare("SELECT state FROM memberships WHERE id='m_expired'").get()!.state, 'expired');
  assert.equal(entitlementSnapshot(lapsed).bnpl, false);
});

test('the entitlement API requires authentication and ignores forged client labels', async () => {
  const raw = freshDb();
  const db = asD1(raw);
  raw.exec("INSERT INTO users (id,email,password_hash) VALUES ('free','free@x.co','h')");
  const mount = (a: Hono<AppContext>) => a.route('/api/memberships', membershipsRoutes);

  const anonymous = stubApp(db, null, mount);
  assert.equal((await get(anonymous, '/api/memberships/entitlements?tier=pro')).status, 401);

  const free = stubApp(db, { id: 'free', role: 'customer', email: 'free@x.co' }, mount);
  const body = await json(await get(free, '/api/memberships/entitlements?tier=pro&bnpl=true'));
  assert.equal(body.success, true);
  assert.equal(body.status.tier, 'free');
  assert.equal(body.entitlements.bnpl, false);
  assert.equal(body.entitlements.merchantStore, false);
});
