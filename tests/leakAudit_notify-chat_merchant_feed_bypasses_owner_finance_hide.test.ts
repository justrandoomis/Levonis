/**
 * LEAK AUDIT — notify-chat: the merchant notification centre bypasses the
 * owner-finance hide clause.
 *
 * «طلب سحب بقيمة X د.ع جاهز للمراجعة» is the OWNER's notice since S1: a
 * profit-percent wage withdrawal reveals profit (owner decision 2,
 * worker/lib/financeParticipants.ts adminNotices). Rows written BEFORE S1
 * went to every full and NULL-scope admin and are still in user_notifications,
 * so the bell (worker/routes/notifications.ts) reads the inbox through
 * HIDE_OWNER_FINANCE_NOTICES_SQL for anyone who may not see cost
 * (tests/costLeaksPhase0.test.ts guards that door).
 *
 * The store's notification centre (/api/merchant/notifications/*) reads the
 * SAME table by `user_id = ? AND kind IN (MERCHANT_KINDS)`, and
 * MERCHANT_KINDS includes 'payout_available'. A full or legacy NULL-scope
 * admin who opens a store (POST /api/merchant/onboard refuses no admin, and
 * requireStoreOwner checks only merchant_stores.user_id) reads the hidden
 * withdrawal amount there.
 *
 * The test opens the store through the real onboarding route, seeds the
 * pre-S1 notice in the exact shape adminNotices writes (through the real
 * notifyStatement writer), proves the bell hides it from the same user, and
 * then asserts the merchant feed, its kind filter and the unread badge do not
 * carry it. The withdrawal amount is a scanner sentinel, so `leaks()` finds
 * it in any string. A merchant-side payout notice (link under /merchant) is
 * the positive control that the feed is really being read.
 *
 * Run: node --import tsx --test tests/leakAudit_notify-chat_merchant_feed_bypasses_owner_finance_hide.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, get, json, post, row, stubApp, type StubUser } from './fixtures/app';
import { COST, leaks } from './fixtures/costlyProduct';
import { OWNER, ROLES, seedRoleMatrix } from './fixtures/roleMatrix';
import { notificationRoutes } from '../worker/routes/notifications';
import { merchantNotificationRoutes } from '../worker/routes/merchantNotifications';
import { merchantRoutes } from '../worker/routes/merchant';
import { notifyStatement } from '../worker/lib/notifications';
import { canViewCost } from '../worker/lib/adminScope';
import type { Env } from '../worker/lib/types';

const ENV = { STORE_ROOT_DOMAIN: 'levonis-iq.com' };
const FUTURE = '2099-01-01T00:00:00.000Z';
/** The withdrawal amount — a scanner sentinel, so leaks() catches it in any text. */
const AMOUNT = COST.incomingShipping;
const SHOWN = AMOUNT.toLocaleString('en-US');

/** The exact row adminNotices (financeParticipants.ts) wrote to every full/NULL admin before S1. */
async function preS1WithdrawalNotice(raw: DatabaseSync, userId: string, withdrawalId: string): Promise<string> {
  const { id, stmt } = notifyStatement(asD1(raw), {
    userId,
    kind: 'payout_available',
    title_ar: 'طلب سحب أرباح جديد',
    title_en: 'New earnings withdrawal request',
    body_ar: `طلب سحب بقيمة ${SHOWN} د.ع جاهز للمراجعة`,
    body_en: `A withdrawal request of ${SHOWN} IQD is ready for review`,
    link: '/admin?tab=finance&section=withdrawals',
    entity_type: 'payout',
    entity_id: withdrawalId,
    eventKey: `finance-withdrawal:${withdrawalId}`,
    meta: {
      title_ckb: 'داواکارییەکی نوێی کێشانەوەی قازانج',
      body_ckb: `داواکارییەکی کێشانەوە بە بڕی ${SHOWN} دینار ئامادەیە بۆ پێداچوونەوە`,
    },
  });
  await stmt.run();
  // Written before S1: dated before the S1 deploy.
  raw.prepare('UPDATE user_notifications SET created_at = ? WHERE id = ?').run('2026-09-01T00:00:00.000Z', id);
  return id;
}

/** The merchant's OWN payout notice — legitimately theirs, links under /merchant. */
function ownMerchantPayoutNotice(raw: DatabaseSync, userId: string): string {
  const id = `ntf_own_${userId}`;
  raw
    .prepare(
      `INSERT INTO user_notifications (id,user_id,kind,title_ar,title_en,body_ar,body_en,link,entity_type,entity_id,meta,event_key,created_at)
       VALUES (?,?,'payout_available','صار 25,000 د.ع متاحًا في رصيدك','25,000 IQD is now available in your balance',
               'يمكنك طلب تحويله من «الأرباح».','You can request a payout under Earnings.','/merchant/money','payout','src1','{}',?,?)`
    )
    .run(id, userId, `payout_available:src1:${userId}`, '2026-09-02T00:00:00.000Z');
  return id;
}

for (const roleName of ['full', 'legacy_null'] as const) {
  test(`${roleName} admin who opens a store: the merchant notification centre never carries the owner's pre-S1 withdrawal notice`, async () => {
    const user = ROLES[roleName] as StubUser;
    const raw = seedRoleMatrix();
    raw.exec(`
      INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at) VALUES
        ('mem_${user.id}','${user.id}','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}');
      INSERT INTO admin_settings (key, value) VALUES ('communityGate', '{"open":true}')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;
    `);
    // The admin is an APPROVED applicant (approved by another reviewer — no
    // self-approval): /onboard opens a store only after approval (DECISIONS row 256).
    raw
      .prepare(
        `INSERT INTO community_merchants (id, user_id, name, approved_at, approved_application_id)
         VALUES (?, ?, 'Admin Shop', '2026-01-01T00:00:00.000Z', ?)
         ON CONFLICT(user_id) DO UPDATE SET approved_at = excluded.approved_at`
      )
      .run(`cm_${user.id}`, user.id, `mapp_${user.id}`);

    // Precondition: this caller may not see cost (the role matrix's premise).
    const env = { DB: asD1(raw), INITIAL_ADMIN_EMAIL: 'boss@x.co' } as unknown as Env;
    assert.equal(
      canViewCost(env, { admin_scope: null, email_verified_at: '2026-01-01T00:00:00.000Z', ...user } as never),
      false,
      `${roleName} is not the owner`
    );
    assert.equal(canViewCost(env, { admin_scope: null, email_verified_at: '2026-01-01T00:00:00.000Z', ...OWNER } as never), true, 'the owner is');

    // 1) The approved admin opens a store through the REAL onboarding route.
    const shop = stubApp(asD1(raw), user, (a) => a.route('/api/merchant', merchantRoutes), { env: ENV });
    const onboard = await post(shop, '/api/merchant/onboard', { name: 'Admin Shop', slug: `shop-${roleName.replace('_', '')}` });
    assert.equal(onboard.status, 201, `${roleName} opened a store: ${JSON.stringify(await onboard.clone().json())}`);
    assert.ok(row(raw, 'SELECT id FROM merchant_stores WHERE user_id = ?', user.id), 'the store row exists');

    // 2) The owner-only notice they received before S1, plus their own merchant payout notice.
    const hidden = await preS1WithdrawalNotice(raw, user.id, `wd_${roleName}`);
    const own = ownMerchantPayoutNotice(raw, user.id);

    // 3) Control: the bell (the guarded door) hides it from the same caller.
    const bell = stubApp(asD1(raw), user, (a) => a.route('/api/notifications', notificationRoutes), { env: ENV });
    const bellBody = await json(await get(bell, '/api/notifications'));
    const bellIds = (bellBody.notifications as Array<{ id: string }>).map((n) => n.id);
    assert.ok(!bellIds.includes(hidden), 'the bell hides the owner withdrawal notice (S1 hide clause)');
    assert.deepEqual(leaks(bellBody), [], 'the bell carries no private value');

    // 4) The merchant notification centre, as the same caller.
    const centre = stubApp(asD1(raw), user, (a) => a.route('/api/merchant/notifications', merchantNotificationRoutes), { env: ENV });

    const feedRes = await get(centre, '/api/merchant/notifications/feed');
    assert.equal(feedRes.status, 200, 'the feed is reachable (path exercised)');
    const feed = await json(feedRes);
    const feedIds = (feed.notifications as Array<{ id: string }>).map((n) => n.id);
    assert.ok(feedIds.includes(own), 'positive control: the merchant’s own payout notice is listed');
    assert.deepEqual(
      leaks(feed),
      [],
      `${roleName}: GET /api/merchant/notifications/feed carries the owner-only withdrawal amount`
    );
    assert.ok(!feedIds.includes(hidden), `${roleName}: the feed lists the owner-only withdrawal notice ${hidden}`);
    assert.equal(feed.unread_by_kind?.payout_available ?? 0, 1, `${roleName}: the feed's payout_available badge counts the owner-only notice`);

    const filtered = await json(await get(centre, '/api/merchant/notifications/feed?kind=payout_available&unread=1'));
    assert.deepEqual(leaks(filtered), [], `${roleName}: ?kind=payout_available carries the owner-only withdrawal amount`);

    const badge = await json(await get(centre, '/api/merchant/notifications/unread-count'));
    assert.equal(badge.unread, 1, `${roleName}: /unread-count counts the owner-only notice`);
    assert.equal(badge.unread_by_kind?.payout_available ?? 0, 1, `${roleName}: /unread-count by kind counts the owner-only notice`);
  });
}
