/**
 * SERVICES V2, STAGE S-P0 — the money gates and the fences between the four
 * services, on the real routes (plan §4.3: X3, X4, X5, X19 for this stage).
 *
 *   X19  who may move money (owner decision 3, DECISIONS row 223): an
 *        assistant never; a financial admin up to the figure the server
 *        computed; above it, an owner-only act or the author of the price,
 *        the owner — with a recorded reason above a ceiling
 *   §1.3 one money process per device: return ↔ warranty case ↔ trade-in ↔
 *        price protection, each asked inside the write that would move money
 *   d.2  the trade-in credit ends (owner decision 2), and a cancelled order
 *        gives back the time it held the credit, no more
 *
 * LOCAL ONLY (fresh in-memory databases, every migration).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, count, get, json, patch, post, row, send, stubApp, type StubUser } from './fixtures/app';
import { LimitD1 } from './fixtures/d1Limits';
import { deviceRoutes } from '../worker/routes/devices';
import { priceProtectionRoutes, returnRoutes } from '../worker/routes/returns';
import { validateCoupon } from '../worker/lib/membershipOps';
import { TRADE_IN_CREDIT_VALID_DAYS } from '../worker/lib/tradeIn';
import { OWNER, STAFF, adminApp, approvedAndOrdered, customerApp, daysAgo, received, restoreFetch, seed, submitted, CUSTOMER } from './sv2_tradein_fixture';
import { ppWorld } from './sv2_price-protection_fixture';
import { repriceV2 } from './fixtures/v2Publish';
import type { Env } from '../worker/lib/types';

test.after(restoreFetch);

const ASSISTANT: StubUser = { id: 'helper', role: 'admin', email: 'helper@x.co', admin_scope: 'assistant' };
const DAY = 86_400_000;

/** The trade-in world plus an assistant, the device linked to Sara, and the device, return and protection doors. */
function world(opts: Parameters<typeof seed>[0] = {}) {
  const raw = seed(opts);
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role,email_verified_at,locale,admin_scope)
              VALUES ('helper','Helper','helper@x.co','h','admin','2026-01-01T00:00:00.000Z','ar','assistant');
            INSERT INTO device_registrations (unit_id, user_id) VALUES ('unit_a1','cust');`);
  const as = (who: StubUser) =>
    stubApp(new LimitD1(raw) as unknown as D1Database, who, (a) => {
      a.route('/api/devices', deviceRoutes);
      a.route('/api/returns', returnRoutes);
      a.route('/api/price-protection', priceProtectionRoutes);
    });
  return { raw, as };
}

const fileClaim = (w: ReturnType<typeof world>, key: string) =>
  post(w.as(CUSTOMER), '/api/devices/units/unit_a1/claims', {
    subject: 'Extruder clicks',
    description: 'The extruder clicks and under-extrudes on every print.',
    idempotencyKey: key,
  });

const code = async (res: Response) => [res.status, (await json(res)).code] as const;

// ===================================================================== X19

test('X19 an assistant moves no money on any service door: trade-in, warranty, return refund, price protection', async () => {
  const w = world({ deliveredDaysAgo: 2 });
  const id = await submitted(w.raw);
  const before = row(w.raw, 'SELECT status, admin_value_iqd FROM trade_in_requests WHERE id = ?', id);
  for (const path of ['inspect', 'approve', 'complete']) {
    assert.deepEqual(await code(await post(adminApp(w.raw, ASSISTANT), `/api/admin/trade-in/requests/${id}/${path}`)), [403, 'FINANCIAL_SCOPE_REQUIRED'], path);
  }
  assert.deepEqual(await code(await post(adminApp(w.raw, ASSISTANT), `/api/admin/trade-in/requests/${id}/value`, { value_iqd: 100_000 })), [403, 'FINANCIAL_SCOPE_REQUIRED']);
  assert.deepEqual(await code(await send(adminApp(w.raw, ASSISTANT), 'PUT', '/api/admin/trade-in/rules/fdm', { rules: {} })), [403, 'FINANCIAL_SCOPE_REQUIRED']);
  assert.deepEqual(row(w.raw, 'SELECT status, admin_value_iqd FROM trade_in_requests WHERE id = ?', id), before);

  const helper = w.as(ASSISTANT);
  const unit = () => row(w.raw, 'SELECT delivered_at, warranty_ext_months, warranty_end_at, replaced_by_unit_id FROM order_item_units WHERE id = ?', 'unit_a1');
  const unitBefore = unit();
  assert.deepEqual(await code(await patch(helper, '/api/devices/admin/units/unit_a1/warranty', { base_months: 12, ext_months: 24, reason: 'goodwill for a loyal customer' })), [403, 'FINANCIAL_SCOPE_REQUIRED']);
  assert.deepEqual(await code(await patch(helper, '/api/devices/admin/units/unit_a1/delivery', { delivered_at: daysAgo(1), reason: 'the courier says yesterday' })), [403, 'FINANCIAL_SCOPE_REQUIRED']);
  assert.deepEqual(await code(await post(helper, '/api/devices/admin/units/unit_a1/replace', { reason: 'swap the whole unit' })), [403, 'FINANCIAL_SCOPE_REQUIRED']);
  assert.deepEqual(unit(), unitBefore);

  // A warranty decision: the assistant receives and diagnoses; accepting or rejecting is a money act.
  const claim = await json(await fileClaim(w, 'sv2-x19-claim-0001'));
  assert.equal(claim.success, true, JSON.stringify(claim));
  assert.deepEqual(await code(await patch(helper, `/api/devices/admin/claims/${claim.id}`, { stage: 'diagnosing' })), [200, undefined]);
  for (const stage of ['approved', 'rejected']) {
    assert.deepEqual(await code(await patch(helper, `/api/devices/admin/claims/${claim.id}`, { stage, reason: 'Inspected on the bench' })), [403, 'FINANCIAL_SCOPE_REQUIRED'], stage);
  }

  // A return refund and a price-protection credit.
  w.raw.exec(`INSERT INTO return_cases (id,order_id,order_item_id,user_id,qty,reason,state,within_window) VALUES ('ret_x','ORD-OLD','oi_a1','cust',1,'defective','inspected',1);
              INSERT INTO price_protection_claims (id,user_id,order_id,order_item_id,original_unit_iqd,observed_unit_iqd,qty,credited_iqd,state)
                VALUES ('ppc_x','cust','ORD-OLD','oi_a1',850000,800000,1,0,'requested');`);
  assert.deepEqual(await code(await post(helper, '/api/returns/admin/ret_x/transition', { to: 'resolved', resolution: 'refund' })), [403, 'FINANCIAL_SCOPE_REQUIRED']);
  assert.deepEqual(await code(await post(helper, '/api/price-protection/admin/claims/ppc_x/decide', { decision: 'approved' })), [403, 'FINANCIAL_SCOPE_REQUIRED']);
  assert.deepEqual(await code(await post(helper, '/api/price-protection/admin/claims/ppc_x/decide', { decision: 'rejected', reason: 'no drop' })), [403, 'FINANCIAL_SCOPE_REQUIRED']);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM wallet_transactions WHERE user_id = 'cust'"), 0);
  assert.equal(row<{ state: string }>(w.raw, "SELECT state FROM return_cases WHERE id = 'ret_x'")!.state, 'inspected');
});

test('X19 trade-in: a financial admin values up to the estimate; above it only the owner, with a private reason that is recorded and flagged', async () => {
  const w = world();
  const id = await submitted(w.raw);
  const est = row<{ estimated_iqd: number }>(w.raw, 'SELECT estimated_iqd FROM trade_in_requests WHERE id = ?', id)!.estimated_iqd;
  assert.ok(est > 0);
  assert.deepEqual(await code(await post(adminApp(w.raw, STAFF), `/api/admin/trade-in/requests/${id}/value`, { value_iqd: est + 5_000 })), [403, 'OWNER_REQUIRED']);
  assert.deepEqual(await code(await post(adminApp(w.raw, OWNER), `/api/admin/trade-in/requests/${id}/value`, { value_iqd: est + 5_000 })), [400, 'OWNER_REASON_REQUIRED']);
  const reasonText = 'mint condition with every original accessory';
  const raised = await post(adminApp(w.raw, OWNER), `/api/admin/trade-in/requests/${id}/value`, { value_iqd: est + 5_000, reason: '', owner_reason: reasonText });
  assert.equal(raised.status, 200, await raised.clone().text());
  const audit = JSON.parse(row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action = 'trade_in.change_value' AND target = ? ORDER BY id DESC", id)!.detail);
  assert.deepEqual(
    { tier: audit.authority.tier, above: audit.authority.above_ceiling, reason: audit.authority.owner_reason, ceiling: audit.authority.ceiling_iqd },
    { tier: 'owner', above: true, reason: reasonText, ceiling: est }
  );
  // The customer reads the offer, never the owner's reason or the ceiling it went above.
  const mine = JSON.stringify(await json(await get(customerApp(w.raw), `/api/trade-in/requests/${id}`)));
  assert.ok(!mine.includes(reasonText) && !mine.includes('above_estimate') && !mine.includes('owner_reason'), mine.slice(0, 300));
  // A financial admin may still lower it, down to or below the estimate.
  assert.equal((await post(adminApp(w.raw, STAFF), `/api/admin/trade-in/requests/${id}/value`, { value_iqd: est - 10_000, reason: 'scratches' })).status, 200);

  // The rules that set every estimate are the owner's.
  assert.deepEqual(await code(await send(adminApp(w.raw, STAFF), 'PUT', '/api/admin/trade-in/rules/fdm', { rules: {} })), [403, 'OWNER_REQUIRED']);
});

test('X19 warranty: lengthening, a later delivery date and a whole-unit replacement are the owner’s; a correction that shortens is not', async () => {
  const w = world();
  const staff = w.as(STAFF);
  const owner = w.as(OWNER);
  assert.deepEqual(await code(await patch(staff, '/api/devices/admin/units/unit_a1/warranty', { base_months: 12, ext_months: 12, reason: 'goodwill extension' })), [403, 'OWNER_REQUIRED']);
  assert.deepEqual(await code(await patch(staff, '/api/devices/admin/units/unit_a1/delivery', { delivered_at: daysAgo(10), reason: 'the courier said later' })), [403, 'OWNER_REQUIRED']);
  assert.deepEqual(await code(await post(staff, '/api/devices/admin/units/unit_a1/replace', { reason: 'swap the whole unit' })), [403, 'OWNER_REQUIRED']);
  // An EARLIER date shortens the window: any admin's correction, as before.
  const earlier = await patch(staff, '/api/devices/admin/units/unit_a1/delivery', { delivered_at: daysAgo(25), reason: 'the courier delivered earlier' });
  assert.equal(earlier.status, 200, await earlier.clone().text());
  // The owner lengthens, and the audit row says under what authority.
  const longer = await patch(owner, '/api/devices/admin/units/unit_a1/warranty', { base_months: 12, ext_months: 12, reason: 'goodwill extension' });
  assert.equal(longer.status, 200, await longer.clone().text());
  assert.equal(row<{ warranty_ext_months: number }>(w.raw, "SELECT warranty_ext_months FROM order_item_units WHERE id = 'unit_a1'")!.warranty_ext_months, 12);
  const audit = row<{ detail: string }>(w.raw, "SELECT detail FROM audit_log WHERE action LIKE '%warranty%' AND target = 'unit_a1' ORDER BY id DESC");
  assert.match(String(audit?.detail), /"act":"warranty_lengthen"/);
});

test('X19 price protection: a financial admin approves up to 250,000; above it, or as the author of the price, the owner decides with a reason', async () => {
  const w = ppWorld();
  w.raw.exec(`INSERT INTO users (id,name,email,password_hash,role,admin_scope) VALUES ('staff','Staff','staff@x.co','h','admin','full')`);
  const staff = stubApp(w.db, { id: 'staff', role: 'admin', email: 'staff@x.co', admin_scope: 'full' }, (a) => a.route('/api/price-protection', priceProtectionRoutes));
  w.raw.exec(`INSERT INTO products (id, slug, name, status, price_iqd, stock) VALUES
                ('small','small','Spool','active',40000,5), ('big','big','Printer','active',1700000,5), ('authored','authored','Printer B','active',90000,5)`);
  // Within the line: a financial admin credits it.
  const small = await w.claim(w.deliveredLine({ productId: 'small', unit: 50_000 }).itemId);
  const ok = await w.decide(staff, small.body.claim.id);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.credit.amount_iqd, 10_000);
  // Above the owner line (300,000 > 250,000).
  const big = await w.claim(w.deliveredLine({ productId: 'big', unit: 2_000_000 }).itemId);
  assert.equal(big.status, 200, JSON.stringify(big.body));
  assert.deepEqual([(await w.decide(staff, big.body.claim.id)).body.code], ['OWNER_REQUIRED']);
  assert.deepEqual([(await w.decide(w.owner, big.body.claim.id)).body.code], ['OWNER_REASON_REQUIRED']);
  const owned = await w.decide(w.owner, big.body.claim.id, 'approved', 'verified the supplier price cut');
  assert.equal(owned.status, 200, JSON.stringify(owned.body));
  assert.equal(owned.body.credit.amount_iqd, 300_000);
  // The approver wrote the price row that made the drop: four eyes.
  const line = w.deliveredLine({ productId: 'authored', unit: 100_000 });
  w.raw.prepare(`INSERT INTO price_history (product_id, variant_key, field, old_iqd, new_iqd, changed_by, changed_at) VALUES ('authored','','regular',100000,90000,'staff',?)`)
    .run(new Date(Date.now() - 30_000).toISOString());
  const authored = await w.claim(line.itemId);
  assert.equal(authored.status, 200, JSON.stringify(authored.body));
  assert.equal((await w.decide(staff, authored.body.claim.id)).body.code, 'OWNER_REQUIRED');
  assert.equal(w.n("SELECT COUNT(*) n FROM wallet_transactions WHERE id = ?", `wtx_pp_${authored.body.claim.id}`), 0);
});

// ===================================================================== §1.3 fences

test('X4/X5 a device whose price-protection claim or warranty case is open is not valued, and a case opened mid-way stops the credit inside the batch', async () => {
  // A protection claim being decided: the trade-in waits for it.
  const a = world({ deliveredDaysAgo: 2 });
  a.raw.exec(`INSERT INTO price_protection_claims (id,user_id,order_id,order_item_id,original_unit_iqd,observed_unit_iqd,qty,credited_iqd,state)
                VALUES ('ppc_open','cust','ORD-OLD','oi_a1',850000,800000,1,0,'requested')`);
  const units = (await json(await get(customerApp(a.raw), '/api/trade-in/eligible'))).units as Array<{ order_item_id: string; reason: string | null }>;
  assert.equal(units.find((u) => u.order_item_id === 'oi_a1')!.reason, 'TRADE_IN_PROTECTION_OPEN');
  assert.deepEqual(await code(await post(customerApp(a.raw), '/api/trade-in/requests', { order_item_id: 'oi_a1', unit_index: 1, scope: 'whole' })), [409, 'TRADE_IN_PROTECTION_OPEN']);

  // A live trade-in: the device is not price-protected (PP-B8, through the real doors).
  const b = world({ deliveredDaysAgo: 2 });
  await submitted(b.raw);
  // The price falls through the V2 writer (the clean start, DECISIONS row 222: the engine locks refuse an UPDATE).
  await repriceV2(b.raw, 'p_a1', 800_000);
  assert.deepEqual(await code(await post(b.as(CUSTOMER), '/api/price-protection/claims', { orderItemId: 'oi_a1' })), [400, 'TRADE_IN_UNIT']);

  // A warranty case opened between the submit and the approval: no credit is minted.
  const c = world();
  const id = await submitted(c.raw);
  assert.equal((await json(await fileClaim(c, 'sv2-x5-claim-0001'))).success, true);
  assert.deepEqual(await code(await post(adminApp(c.raw), `/api/admin/trade-in/requests/${id}/approve`)), [409, 'TRADE_IN_SERVICE_OPEN']);
  assert.equal(count(c.raw, 'SELECT COUNT(*) AS n FROM coupons WHERE trade_in_id = ?', id), 0);
  assert.equal(row<{ status: string }>(c.raw, 'SELECT status FROM trade_in_requests WHERE id = ?', id)!.status, 'submitted');
});

test('one door per defect: an open return and an open warranty case never run side by side, and no refund while the repair desk has the device', async () => {
  const w = world({ deliveredDaysAgo: 2 });
  // Return first: the warranty door sends the customer to it.
  w.raw.exec(`INSERT INTO return_cases (id,order_id,order_item_id,unit_id,user_id,qty,reason,state,within_window) VALUES ('ret_1','ORD-OLD','oi_a1','unit_a1','cust',1,'defective','requested',1)`);
  assert.deepEqual(await code(await fileClaim(w, 'sv2-door-claim-0001')), [409, 'RETURN_CASE_OPEN']);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM warranty_claims'), 0);
  // Once the return is rejected, the claim goes through.
  w.raw.exec(`UPDATE return_cases SET state = 'rejected' WHERE id = 'ret_1'`);
  assert.equal((await json(await fileClaim(w, 'sv2-door-claim-0002'))).success, true);
  // Claim first: the return door refuses, the refund refuses.
  assert.deepEqual(
    await code(await post(w.as(CUSTOMER), '/api/returns', { orderItemId: 'oi_a1', unitId: 'unit_a1', qty: 1, reason: 'defective', description: 'It stopped heating.' })),
    [409, 'WARRANTY_CLAIM_OPEN']
  );
  w.raw.exec(`INSERT INTO return_cases (id,order_id,order_item_id,unit_id,user_id,qty,reason,state,within_window) VALUES ('ret_2','ORD-OLD','oi_a1','unit_a1','cust',1,'defective','inspected',1)`);
  assert.deepEqual(await code(await post(w.as(OWNER), '/api/returns/admin/ret_2/transition', { to: 'resolved', resolution: 'refund' })), [400, 'WARRANTY_CLAIM_OPEN']);
  assert.equal(count(w.raw, "SELECT COUNT(*) AS n FROM wallet_transactions WHERE user_id = 'cust'"), 0);
});

test('a return wins over a trade-in whose credit is not spent — and is refused once an order holds the credit', async () => {
  const w = world({ deliveredDaysAgo: 2 });
  const id = await submitted(w.raw);
  const opened = await post(w.as(CUSTOMER), '/api/returns', { orderItemId: 'oi_a1', unitId: 'unit_a1', qty: 1, reason: 'defective', description: 'It stopped heating.' });
  assert.equal(opened.status, 200, await opened.clone().text());
  assert.equal(row<{ status: string }>(w.raw, 'SELECT status FROM trade_in_requests WHERE id = ?', id)!.status, 'cancelled');
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM trade_in_claims WHERE request_id = ?', id), 0);
  assert.equal(count(w.raw, `SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'cust' AND event_key = ?`, `trade_in:${id}:cancelled`), 1);

  const v = world({ deliveredDaysAgo: 2 });
  const id2 = await submitted(v.raw);
  await approvedAndOrdered(v.raw, id2);
  assert.deepEqual(
    await code(await post(v.as(CUSTOMER), '/api/returns', { orderItemId: 'oi_a1', unitId: 'unit_a1', qty: 1, reason: 'defective', description: 'It stopped heating.' })),
    [409, 'TRADE_IN_ACTIVE']
  );
  assert.equal(row<{ status: string }>(v.raw, 'SELECT status FROM trade_in_requests WHERE id = ?', id2)!.status, 'awaiting_payment');
  assert.equal(count(v.raw, "SELECT COUNT(*) AS n FROM return_cases WHERE order_item_id = 'oi_a1'"), 0);
});

test('X3 what the customer paid comes net of a protection credit already given, and of the order’s coupon and points', async () => {
  const w = world();
  w.raw.exec(`UPDATE orders SET coupon_snapshot = '{"coupon_id":"cp_y","code":"SAVE50","discount_iqd":50000}', points_discount_iqd = 20000, total_iqd = 780000 WHERE id = 'ORD-OLD';
              INSERT INTO price_protection_claims (id,user_id,order_id,order_item_id,original_unit_iqd,observed_unit_iqd,qty,credited_iqd,state)
                VALUES ('ppc_c','cust','ORD-OLD','oi_a1',850000,820000,1,30000,'credited');`);
  const units = (await json(await get(customerApp(w.raw), '/api/trade-in/eligible'))).units as Array<{ order_item_id: string; paid_iqd: number }>;
  assert.equal(units.find((u) => u.order_item_id === 'oi_a1')!.paid_iqd, 850_000 - 50_000 - 20_000 - 30_000);
});

// ===================================================================== decision 2

test('the trade-in credit lasts seven days; an expired one closes «إتمام الدفع»; a cancelled order gives back the time it held it', async () => {
  const w = world();
  const id = await submitted(w.raw);
  const t0 = Date.now();
  await received(w.raw, id);
  await post(adminApp(w.raw), `/api/admin/trade-in/requests/${id}/approve`);
  const coupon = row<{ id: string; code: string; ends_at: string }>(w.raw, 'SELECT id, code, ends_at FROM coupons WHERE trade_in_id = ?', id)!;
  const end = Date.parse(coupon.ends_at);
  assert.ok(Math.abs(end - (t0 + TRADE_IN_CREDIT_VALID_DAYS * DAY)) < 60_000, coupon.ends_at);
  const view = (await json(await get(customerApp(w.raw), `/api/trade-in/requests/${id}`))).request;
  assert.equal(view.credit_expires_at, coupon.ends_at);
  assert.equal(view.credit_expired, false);
  assert.equal(view.can.pay, true);

  // A week later, unused.
  w.raw.prepare('UPDATE coupons SET ends_at = ? WHERE id = ?').run(new Date(Date.now() - 60_000).toISOString(), coupon.id);
  const lapsed = (await json(await get(customerApp(w.raw), `/api/trade-in/requests/${id}`))).request;
  assert.deepEqual([lapsed.credit_expired, lapsed.can.pay], [true, false]);
  assert.deepEqual(await code(await post(customerApp(w.raw), `/api/trade-in/requests/${id}/checkout`)), [409, 'TRADE_IN_CREDIT_EXPIRED']);
  const check = await validateCoupon({ DB: asD1(w.raw) } as unknown as Env, 'cust', coupon.code, 2_000_000);
  assert.deepEqual([check.ok, check.reason], [false, 'EXPIRED']);
});

test('a cancelled order gives the same credit back with the time that order held it — never a fresh week, never a second coupon', async () => {
  const w = world();
  const id = await submitted(w.raw);
  const { orderId } = await approvedAndOrdered(w.raw, id);
  const old = row<{ id: string; code: string }>(w.raw, 'SELECT id, code FROM coupons WHERE trade_in_id = ? AND active = 1', id)!;
  // The order has held the credit for one day; the credit's own end has since passed.
  const ownEnd = new Date(Date.now() - 60 * 60_000).toISOString();
  w.raw.prepare('UPDATE orders SET created_at = ? WHERE id = ?').run(new Date(Date.now() - DAY).toISOString(), orderId);
  w.raw.prepare('UPDATE coupons SET ends_at = ? WHERE id = ?').run(ownEnd, old.id);
  // Cancelled now (0191's trigger: the use comes back, the end moves by the day the order held it).
  w.raw.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(orderId);
  const after = row<{ id: string; code: string; ends_at: string; active: number }>(w.raw, 'SELECT id, code, ends_at, active FROM coupons WHERE trade_in_id = ?', id)!;
  assert.deepEqual([after.id, after.code, after.active], [old.id, old.code, 1], 'the same coupon, the same code');
  assert.ok(Math.abs(Date.parse(after.ends_at) - (Date.parse(ownEnd) + DAY)) < 60_000, after.ends_at);
  assert.equal(row<{ state: string }>(w.raw, 'SELECT state FROM coupon_redemptions WHERE order_id = ?', orderId)!.state, 'released');
  const again = await post(customerApp(w.raw), `/api/trade-in/requests/${id}/checkout`);
  assert.equal(again.status, 200, await again.clone().text());
  assert.equal((await json(again)).coupon_code, old.code);
  assert.equal(count(w.raw, 'SELECT COUNT(*) AS n FROM coupons WHERE trade_in_id = ?', id), 1);
});

// ===================================================================== G-3 / G-4

test('a claim’s decision follows its stage, and «replaced» follows the owner’s replacement', async () => {
  const w = world();
  const owner = w.as(OWNER);
  const helper = w.as(ASSISTANT);
  const claim = await json(await fileClaim(w, 'sv2-g34-claim-0001'));
  const decision = () => row<{ decision: string | null; stage: string }>(w.raw, 'SELECT decision, stage FROM warranty_claims WHERE id = ?', claim.id)!;
  assert.deepEqual(await code(await patch(owner, `/api/devices/admin/claims/${claim.id}`, { stage: 'approved', decision: 'misuse', reason: 'Bench test done' })), [400, 'CLAIM_DECISION_MISMATCH']);
  assert.equal((await patch(owner, `/api/devices/admin/claims/${claim.id}`, { stage: 'rejected', reason: 'Dropped, cracked frame' })).status, 200);
  assert.deepEqual(decision(), { decision: 'reject', stage: 'rejected' });
  // Reopened for another look: the old «reject» no longer describes it.
  assert.equal((await patch(owner, `/api/devices/admin/claims/${claim.id}`, { stage: 'diagnosing' })).status, 200);
  assert.deepEqual(decision(), { decision: null, stage: 'diagnosing' });
  assert.equal((await patch(owner, `/api/devices/admin/claims/${claim.id}`, { stage: 'approved', decision: 'replace', reason: 'Mainboard failure confirmed' })).status, 200);
  // The assistant carries an accepted claim forward; the decision stays the accountable admin's.
  assert.equal((await patch(helper, `/api/devices/admin/claims/${claim.id}`, { stage: 'repairing' })).status, 200);
  assert.deepEqual(decision(), { decision: 'replace', stage: 'repairing' });
  assert.deepEqual(await code(await patch(owner, `/api/devices/admin/claims/${claim.id}`, { stage: 'replaced', reason: 'Swapped the unit' })), [409, 'CLAIM_REPLACEMENT_REQUIRED']);
  assert.equal((await post(owner, '/api/devices/admin/units/unit_a1/replace', { reason: 'Mainboard dead, new unit' })).status, 200);
  assert.equal((await patch(owner, `/api/devices/admin/claims/${claim.id}`, { stage: 'replaced', reason: 'Swapped the unit' })).status, 200);
  assert.deepEqual(decision(), { decision: 'replace', stage: 'replaced' });
  assert.equal((await patch(helper, `/api/devices/admin/claims/${claim.id}`, { stage: 'resolved', reason: 'Customer collected it' })).status, 200);
});

