/**
 * Services V2, S-P0 review findings F4–F6 (owner decision 3, DECISIONS row
 * 223): the money doors moneyAuthority did not reach, the approver who is the
 * beneficiary, and the price author who wrote the drop through PRO rules.
 *
 *   F4  an assistant moves no money anywhere: no promo code (a public code is
 *       the owner's alone), no gift grant or conversion, no review reward, no
 *       member price rule. Retiring a code and declining a reward stay open.
 *   F5  an admin approving money for their own account is a conflict of
 *       interest: the owner decides, with a reason (price protection, the
 *       trade-in estimate, a gift).
 *   F6  the four-eyes test sees a member price rule (and the PRO pricing
 *       policy) the approver wrote inside the claim window, not only a
 *       `price_history` row; the evidence sheet lists those rule changes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, post, send, get, row, stubApp, type StubUser } from './fixtures/app';
import { LimitD1 } from './fixtures/d1Limits';
import { adminRoutes } from '../worker/routes/admin';
import { giftRoutes } from '../worker/routes/gifts';
import { reviewRoutes } from '../worker/routes/reviews';
import { priceProtectionRoutes, returnRoutes } from '../worker/routes/returns';
import { adminMembershipBenefitRoutes } from '../worker/routes/adminMembershipBenefits';
import { ppWorld, PRE_V5 } from './sv2_price-protection_fixture';
import { legacyBox } from './fixtures/giftWorld';
import { adminApp, received, restoreFetch, seed, submitted } from './sv2_tradein_fixture';

test.after(restoreFetch);

const ASSISTANT: StubUser = { id: 'helper', role: 'admin', email: 'helper@x.co', admin_scope: 'assistant' };
const FINANCE: StubUser = { id: 'staff', role: 'admin', email: 'staff@x.co', admin_scope: 'full' };
const OWNER: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };

function world() {
  const raw = seed();
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role,email_verified_at,locale,admin_scope)
              VALUES ('helper','Helper','helper@x.co','h','admin','2026-01-01T00:00:00.000Z','ar','assistant');
            UPDATE gift_pools SET active = 1 WHERE id = 'gift_level_5';`);
  const app = (who: StubUser) =>
    stubApp(new LimitD1(raw) as unknown as D1Database, who, (a) => {
      a.route('/api/admin', adminRoutes);
      a.route('/api/gifts', giftRoutes);
      a.route('/api/reviews', reviewRoutes);
      a.route('/api/admin/membership-benefits', adminMembershipBenefitRoutes);
    });
  return { raw, app };
}

const code = async (res: Response) => (await json(res)).code as string | undefined;

test('F4: a public promo code is the owner’s — an assistant and a financial admin can neither create nor edit one', async () => {
  const { raw, app } = world();
  const body = { code: 'HELPER100', kind: 'percent', value: 100, max_per_user: 1000, max_global: 1000000 };
  const a = await post(app(ASSISTANT), '/api/admin/coupons', body);
  assert.deepEqual([a.status, await code(a)], [403, 'FINANCIAL_SCOPE_REQUIRED']);
  const f = await post(app(FINANCE), '/api/admin/coupons', body);
  assert.deepEqual([f.status, await code(f)], [403, 'OWNER_REQUIRED']);
  assert.equal(row(raw, "SELECT id FROM coupons WHERE code = 'HELPER100'"), undefined);

  const o = await post(app(OWNER), '/api/admin/coupons', { ...body, code: 'OWNER10', value: 10 });
  assert.equal(o.status, 200, await o.clone().text());
  const id = (await json(o)).id as string;
  for (const who of [ASSISTANT, FINANCE]) {
    const p = await send(app(who), 'PATCH', `/api/admin/coupons/${id}`, { kind: 'percent', value: 100, max_per_user: 1 });
    assert.equal(p.status, 403, who.id);
  }
  assert.equal(row<{ value: number }>(raw, 'SELECT value FROM coupons WHERE id = ?', id)!.value, 10);
  // Retiring a code gives nothing away: any admin may.
  const off = await send(app(ASSISTANT), 'DELETE', `/api/admin/coupons/${id}`);
  assert.equal(off.status, 200, await off.clone().text());
});

const grantBody = (userId: string, key: string) => ({
  userId, mode: 'product', level: 5, reason: 'admin_gift', idempotencyKey: key,
  product: { productId: 'p_p1s', optionValueIds: [], colorId: '', qty: 1, saleType: 'direct_sale' },
});

test('F4/F5: a gift is granted by a financial admin, never by an assistant, and never to the approver’s own account', async () => {
  const { raw, app } = world();
  const a = await post(app(ASSISTANT), '/api/gifts/admin/grants', grantBody('cust', 'helper-grant-0001'));
  assert.deepEqual([a.status, await code(a)], [403, 'FINANCIAL_SCOPE_REQUIRED']);
  // A financial admin granting their own account: the owner decides.
  const self = await post(app(FINANCE), '/api/gifts/admin/grants', grantBody('staff', 'staff-grant-self'));
  assert.deepEqual([self.status, await code(self)], [403, 'OWNER_REQUIRED']);
  assert.equal(row(raw, "SELECT id FROM gift_entitlements WHERE user_id IN ('cust','staff')"), undefined);
  const ok = await post(app(FINANCE), '/api/gifts/admin/grants', grantBody('cust', 'staff-grant-0001'));
  assert.equal(ok.status, 200, await ok.clone().text());
  const grantId = (await json(ok)).grant.id as string;
  // An assistant still edits the internal note, but not why the gift was given.
  const note = await send(app(ASSISTANT), 'PATCH', `/api/gifts/admin/grants/${grantId}`, { note: 'called the customer' });
  assert.equal(note.status, 200, await note.clone().text());
  const why = await send(app(ASSISTANT), 'PATCH', `/api/gifts/admin/grants/${grantId}`, { reason: 'compensation' });
  assert.deepEqual([why.status, await code(why)], [403, 'FINANCIAL_SCOPE_REQUIRED']);
});

test('F4: a legacy gift is converted (its level chosen) by a financial admin only', async () => {
  const { raw, app } = world();
  legacyBox(raw, 'ge_old', { userId: 'cust', maxLevel: 2 });
  const a = await post(app(ASSISTANT), '/api/gifts/admin/grants/ge_old/convert', { level: 5 });
  assert.deepEqual([a.status, await code(a)], [403, 'FINANCIAL_SCOPE_REQUIRED']);
  assert.equal(row<{ grant_mode: string | null }>(raw, "SELECT grant_mode FROM gift_entitlements WHERE id = 'ge_old'")!.grant_mode ?? 'legacy', 'legacy');
});

test('F4/F5: a review reward is approved by a financial admin, not by an assistant, and not by the reviewer', async () => {
  const { raw, app } = world();
  raw.exec(`INSERT INTO admin_settings (key,value) VALUES ('reviewPointsConfig','{"enabled":true,"points":25}')
              ON CONFLICT(key) DO UPDATE SET value = excluded.value;
            INSERT INTO reviews (id,user_id,product_id,order_item_id,order_id,stars,body,media,status,source,created_at)
              VALUES ('rev_c','cust','p_a1','oi_a1','ORD-OLD',5,'مراجعة مفصلة وصادقة عن المنتج','[]','published','user','2026-01-05T10:00:00.000Z'),
                     ('rev_s','staff','p_a1','oi_a1','ORD-OLD',5,'مراجعة مفصلة وصادقة عن المنتج','[]','published','user','2026-01-05T10:00:00.000Z');
            INSERT INTO review_rewards (id,review_id,user_id,kind,state,created_at)
              VALUES ('rr_c','rev_c','cust','points','submitted','2026-01-05T10:00:00.000Z'),
                     ('rr_s','rev_s','staff','points','submitted','2026-01-05T10:00:00.000Z');`);
  const a = await post(app(ASSISTANT), '/api/reviews/admin/rev_c/reward', { action: 'approve', reason: 'مراجعة جيدة ومفيدة' });
  assert.deepEqual([a.status, await code(a)], [403, 'FINANCIAL_SCOPE_REQUIRED']);
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM review_rewards WHERE id = 'rr_c'")!.state, 'submitted');
  const self = await post(app(FINANCE), '/api/reviews/admin/rev_s/reward', { action: 'approve', reason: 'مراجعة جيدة ومفيدة' });
  assert.deepEqual([self.status, await code(self)], [403, 'OWNER_REQUIRED']);
  // Asking for changes moves no money: an assistant still may.
  const ask = await post(app(ASSISTANT), '/api/reviews/admin/rev_c/reward', { action: 'request_changes', reason: 'أضف صورة' });
  assert.equal(ask.status, 200, await ask.clone().text());
  const ok = await post(app(FINANCE), '/api/reviews/admin/rev_c/reward', { action: 'approve', reason: 'مراجعة جيدة ومفيدة' });
  assert.equal(ok.status, 200, await ok.clone().text());
});

test('F4: member price rules are written by a financial admin, not by an assistant', async () => {
  const { raw, app } = world();
  const rule = { tier: 'pro', benefit_type: 'product_discount', scope: 'product', product_id: 'p_a1', discount_mode: 'percent', percent: 20 };
  const a = await post(app(ASSISTANT), '/api/admin/membership-benefits', rule);
  assert.deepEqual([a.status, await code(a)], [403, 'FINANCIAL_SCOPE_REQUIRED']);
  assert.equal(row(raw, "SELECT id FROM membership_benefit_rules WHERE product_id = 'p_a1'"), undefined);
  const f = await post(app(FINANCE), '/api/admin/membership-benefits', rule);
  assert.equal(f.status, 200, await f.clone().text());
});

test('F5: a financial admin who is the buyer cannot approve their own price-protection credit', async () => {
  const w = ppWorld();
  w.raw.exec(`UPDATE users SET role = 'admin', admin_scope = 'full' WHERE id = 'buyer';
              INSERT INTO products (id, slug, name, status, price_iqd, stock) VALUES ('p', 'p', 'Printer', 'active', 760000, 5);`);
  const me = stubApp(w.db, { id: 'buyer', role: 'admin', email: 's@x.co', admin_scope: 'full' }, (a) => {
    a.route('/api/price-protection', priceProtectionRoutes);
    a.route('/api/returns', returnRoutes);
  });
  const { itemId } = w.deliveredLine({ productId: 'p', unit: 1_000_000 });
  const filed = await json(await post(me, '/api/price-protection/claims', { orderItemId: itemId }));
  assert.equal(filed.success, true, JSON.stringify(filed));
  const sheet = await json(await get(me, `/api/price-protection/admin/claims/${filed.claim.id}`));
  assert.deepEqual([sheet.approval.needs_owner, sheet.approval.why], [true, 'beneficiary']);
  const decided = await post(me, `/api/price-protection/admin/claims/${filed.claim.id}/decide`, { decision: 'approved' });
  assert.deepEqual([decided.status, await code(decided)], [403, 'OWNER_REQUIRED']);
  assert.equal(w.n("SELECT COUNT(*) AS n FROM wallet_transactions WHERE user_id = 'buyer'"), 0);
  // The owner may, with a reason.
  const owner = await w.decide(w.owner, filed.claim.id, 'approved', 'checked the drop myself');
  assert.equal(owner.status, 200, JSON.stringify(owner.body));
});

test('F5: a financial admin who is the trade-in customer cannot approve their own estimate', async () => {
  const raw = seed({ deliveredDaysAgo: 20 });
  raw.exec(`UPDATE users SET role = 'admin', admin_scope = 'full' WHERE id = 'cust';`);
  const id = await submitted(raw);
  // S-P2: the device is received first (by a colleague: never on one's own request).
  const selfUser: StubUser = { id: 'cust', role: 'admin', email: 'sara@x.co', admin_scope: 'full' };
  const ownIntake = await post(adminApp(raw, selfUser), `/api/admin/trade-in/requests/${id}/intake`, { serial: 'SELF000001', handover: 'store' });
  assert.deepEqual([ownIntake.status, await code(ownIntake)], [403, 'TRADE_IN_OWN_REQUEST']);
  await received(raw, id);
  const self = await post(adminApp(raw, selfUser), `/api/admin/trade-in/requests/${id}/approve`);
  assert.deepEqual([self.status, await code(self)], [403, 'OWNER_REQUIRED']);
  assert.equal(row<{ status: string }>(raw, 'SELECT status FROM trade_in_requests WHERE id = ?', id)!.status, 'under_review');
  // Any other financial admin approves it as before.
  const other = await post(adminApp(raw, FINANCE), `/api/admin/trade-in/requests/${id}/approve`);
  assert.equal(other.status, 200, await other.clone().text());
});

test('F6: the author of a PRO rule that makes the drop does not approve the claim alone; the sheet shows the rule change', async () => {
  const w = ppWorld();
  w.raw.exec(`INSERT INTO users(id,name,email,password_hash,role,admin_scope) VALUES ('fin','Finance','fin@x.co','h','admin','full'), ('fin2','Finance 2','fin2@x.co','h','admin','full');
              INSERT INTO products (id, slug, name, status, price_iqd, stock) VALUES ('p', 'p', 'Printer', 'active', 1000000, 5);`);
  const as = (id: string) => stubApp(w.db, { id, role: 'admin', email: `${id}@x.co`, admin_scope: 'full' }, (a) => {
    a.route('/api/price-protection', priceProtectionRoutes);
    a.route('/api/admin/membership-benefits', adminMembershipBenefitRoutes);
  });
  // The order predates policy v5: since the clean start (DECISIONS row 222) every product a customer can
  // buy is V2- (engine-) priced, and a v5 order's claim compares the base price in USD (owner decision
  // 6), which a member rule never moves — under 10.4's dinar rule the PRO rule's drop is the claim.
  const { itemId } = w.deliveredLine({ productId: 'p', unit: 1_000_000, createdAt: PRE_V5, pricing: { applied_tier: 'pro', applied_iqd: 1_000_000, regular_iqd: 1_000_000 } });
  const rule = await post(as('fin'), '/api/admin/membership-benefits', { tier: 'pro', benefit_type: 'product_discount', scope: 'product', product_id: 'p', discount_mode: 'percent', percent: 20 });
  assert.equal(rule.status, 200, await rule.clone().text());
  const filed = await w.claim(itemId);
  assert.equal(filed.status, 200, JSON.stringify(filed.body));
  const sheet = await json(await get(as('fin'), `/api/price-protection/admin/claims/${filed.body.claim.id}`));
  assert.deepEqual([sheet.approval.needs_owner, sheet.approval.why], [true, 'price_author']);
  assert.ok(Array.isArray(sheet.rule_changes) && sheet.rule_changes.length >= 1, JSON.stringify(sheet.rule_changes));
  assert.equal(sheet.rule_changes[0].kind, 'member_rule');
  const alone = await post(as('fin'), `/api/price-protection/admin/claims/${filed.body.claim.id}/decide`, { decision: 'approved' });
  assert.deepEqual([alone.status, await code(alone)], [403, 'OWNER_REQUIRED']);
  // Another financial admin — four eyes — approves it.
  const other = await post(as('fin2'), `/api/price-protection/admin/claims/${filed.body.claim.id}/decide`, { decision: 'approved' });
  assert.equal(other.status, 200, await other.clone().text());
  assert.equal((await json(other)).credit.amount_iqd, 200_000);
});

test('F6: the PRO pricing policy written by the approver inside the window is the same conflict — for a member’s claim only', async () => {
  const w = ppWorld();
  w.raw.exec(`INSERT INTO users(id,name,email,password_hash,role,admin_scope) VALUES ('fin','Finance','fin@x.co','h','admin','full');
              INSERT INTO products (id, slug, name, status, price_iqd, stock) VALUES ('p', 'p', 'Printer', 'active', 1000000, 5);`);
  const fin = stubApp(w.db, { id: 'fin', role: 'admin', email: 'fin@x.co', admin_scope: 'full' }, (a) => {
    a.route('/api/price-protection', priceProtectionRoutes);
    a.route('/api/admin', adminRoutes);
  });
  const pro = w.deliveredLine({ productId: 'p', unit: 1_000_000, pricing: { applied_tier: 'pro', applied_iqd: 1_000_000, regular_iqd: 1_000_000 } });
  const regular = w.deliveredLine({ productId: 'p', unit: 1_000_000 });
  // The owner lowers the price; the financial admin edits the PRO pricing policy in the same days.
  w.raw.exec(`UPDATE products SET price_iqd = 800000 WHERE id = 'p'`);
  w.priceRow('p', '', 1_000_000, 800_000);
  const policy = await send(fin, 'PUT', '/api/admin/settings/proPricingPolicy', { value: { mode: 'global_percent', percent: 5 } });
  assert.equal(policy.status, 200, await policy.clone().text());
  const proClaim = await w.claim(pro.itemId);
  assert.equal(proClaim.status, 200, JSON.stringify(proClaim.body));
  const alone = await post(fin, `/api/price-protection/admin/claims/${proClaim.body.claim.id}/decide`, { decision: 'approved' });
  assert.deepEqual([alone.status, await code(alone)], [403, 'OWNER_REQUIRED']);
  const sheet = await json(await get(fin, `/api/price-protection/admin/claims/${proClaim.body.claim.id}`));
  assert.ok(sheet.rule_changes.some((r: { kind: string }) => r.kind === 'pro_policy'), JSON.stringify(sheet.rule_changes));
  // A regular buyer is compared with the regular price only: no conflict there.
  const regClaim = await w.claim(regular.itemId);
  assert.equal(regClaim.status, 200, JSON.stringify(regClaim.body));
  const ok = await post(fin, `/api/price-protection/admin/claims/${regClaim.body.claim.id}/decide`, { decision: 'approved' });
  assert.equal(ok.status, 200, await ok.clone().text());
});
