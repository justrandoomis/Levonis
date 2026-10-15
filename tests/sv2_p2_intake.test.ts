/**
 * Services S-P2 (DECISIONS row 238; spec §6.5, §13.3, §13.4) — «استلام الجهاز»: the device reaches
 * the shop. Any admin receives (an assistant too: no money moves), never their own request; the
 * serial is checked against the unit sold (a mismatch is the owner's, with a recorded reason; no
 * serial on record is accepted, flagged, and approved by the owner only); the hours above what was
 * declared are flagged; the ceiling is recomputed; a credit fixed on photos before S-P2 is re-valued
 * on the SAME coupon row. LOCAL ONLY.
 *
 * Run: node --import tsx --test tests/sv2_p2_intake.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { count, get, json, post, row, stubApp, ctx, type StubUser } from './fixtures/app';
import { serialD1 } from './fixtures/serialD1';
import { RaceD1 } from './fixtures/raceD1';
import { adminTradeInRoutes, tradeInRoutes } from '../worker/routes/tradeIn';
import { fileRoutes } from '../worker/routes/uploads';
import { CUSTOMER, OWNER, STAFF, adminApp, customerApp, daysAgo, daysAhead, received, restoreFetch, seed, settle, submitted } from './sv2_tradein_fixture';

test.after(restoreFetch);

const ASSISTANT: StubUser = { id: 'helper', role: 'admin', email: 'helper@x.co', admin_scope: 'assistant' };
const helperRow = (raw: DatabaseSync) =>
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role,admin_scope) VALUES ('helper','Mona','helper@x.co','h','admin','assistant')`);
const code = async (res: Response) => [res.status, (await json(res)).code] as const;
const req = (raw: DatabaseSync, id: string) => row<Record<string, any>>(raw, 'SELECT * FROM trade_in_requests WHERE id = ?', id)!;
const serialOnRecord = (raw: DatabaseSync, serial = 'A1SERIAL0001') =>
  raw.prepare("INSERT INTO device_serials (serial_norm, serial_raw, unit_id, assigned_by) VALUES (?, ?, 'unit_a1', 'staff')").run(serial, serial);
const intake = (raw: DatabaseSync, id: string, who: StubUser, body: Record<string, unknown>) =>
  post(adminApp(raw, who), `/api/admin/trade-in/requests/${id}/intake`, { handover: 'store', ...body });

test('match: an ASSISTANT receives the device (no money moves); the ceiling is the offer on the same facts; the customer reads «received», never the ceiling', async () => {
  const raw = seed();
  helperRow(raw);
  serialOnRecord(raw, 'A1SERIAL0001');
  const id = await submitted(raw);
  const offer = req(raw, id).offer_iqd as number;
  // The scanner hands back what the label says: dashes and spaces normalise away.
  const res = await intake(raw, id, ASSISTANT, { serial: 'a1-serial 0001', hours: 40, findings: 'Clean, light scuff on the bed' });
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  const r = req(raw, id);
  assert.deepEqual([r.status, r.intake_serial_match, r.intake_serial_norm, r.intake_by, r.ceiling_iqd], ['under_review', 'match', 'A1SERIAL0001', 'helper', offer]);
  assert.ok(r.intake_at && r.ceiling_at && r.inspected_at);
  assert.equal(body.request.intake.serial_match, 'match');
  assert.equal(body.request.intake.hours_flag, false);
  assert.equal(body.request.ceiling_iqd, offer);
  // The owner's record of the computation.
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM trade_in_valuations WHERE request_id = ? AND phase = 'intake'", id), 1);
  // The customer: the stage and «serial matched», nothing of the desk's record.
  const mine = (await json(await get(customerApp(raw), `/api/trade-in/requests/${id}`))).request;
  assert.equal(mine.stage, 'inspecting');
  assert.deepEqual(mine.intake, { received_at: r.intake_at, serial_matched: true });
  for (const k of ['ceiling_iqd', 'above_ceiling', 'intake_json', 'intake_photos', 'previews']) assert.ok(!(k in mine), k);
  assert.ok(!JSON.stringify(mine).includes('intake_inputs'));
  const notice = row<{ title_ar: string; meta: string }>(raw, "SELECT title_ar, meta FROM user_notifications WHERE event_key = ?", `trade_in:${id}:received`)!;
  assert.equal(notice.title_ar, 'استلمنا جهازك وطابق رقمه التسلسلي');
  assert.equal(JSON.parse(notice.meta).title_ckb, 'ئامێرەکەتمان وەرگرت و ژمارە زنجیرەییەکەی گونجا');
  // An assistant still puts no number on it.
  assert.deepEqual(await code(await post(adminApp(raw, ASSISTANT), `/api/admin/trade-in/requests/${id}/approve`)), [403, 'FINANCIAL_SCOPE_REQUIRED']);
  assert.deepEqual(await code(await post(adminApp(raw, ASSISTANT), `/api/admin/trade-in/requests/${id}/value`, { value_iqd: 1000 })), [403, 'FINANCIAL_SCOPE_REQUIRED']);
  // Once is all (0192 trg_trade_in_intake_once behind the door).
  assert.deepEqual(await code(await intake(raw, id, STAFF, { serial: 'A1SERIAL0001' })), [409, 'TRADE_IN_ALREADY_RECEIVED']);
  assert.throws(() => raw.prepare('UPDATE trade_in_requests SET intake_at = ? WHERE id = ?').run(new Date().toISOString(), id), /TRADE_IN_ALREADY_RECEIVED/);
});

test('mismatch: the desk is refused; only the owner receives it, with a recorded reason, and approving it is the owner’s', async () => {
  const raw = seed();
  serialOnRecord(raw, 'A1SERIAL0001');
  const id = await submitted(raw);
  assert.deepEqual(await code(await intake(raw, id, STAFF, { serial: 'OTHER000099' })), [409, 'TRADE_IN_SERIAL_MISMATCH']);
  assert.deepEqual(await code(await intake(raw, id, STAFF, { serial: 'OTHER000099', serial_override_reason: 'board replaced under warranty' })), [403, 'OWNER_REQUIRED']);
  assert.equal(req(raw, id).intake_at, null);
  const ok = await intake(raw, id, OWNER, { serial: 'OTHER000099', serial_override_reason: 'board replaced under warranty' });
  assert.equal(ok.status, 200, await ok.clone().text());
  const r = req(raw, id);
  assert.equal(r.intake_serial_match, 'mismatch');
  assert.equal(JSON.parse(r.intake_json).serial_override, true);
  const audit = JSON.parse(row<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action = 'trade_in.intake' AND target = ?", id)!.detail);
  assert.equal(audit.serial_override_reason, 'board replaced under warranty');
  // The money on a device received over a mismatch is the owner's, with a reason (§16 D-5).
  assert.deepEqual(await code(await post(adminApp(raw, STAFF), `/api/admin/trade-in/requests/${id}/approve`)), [403, 'OWNER_REQUIRED']);
  assert.deepEqual(await code(await post(adminApp(raw, OWNER), `/api/admin/trade-in/requests/${id}/approve`)), [400, 'OWNER_REASON_REQUIRED']);
  const approved = await post(adminApp(raw, OWNER), `/api/admin/trade-in/requests/${id}/approve`, { owner_reason: 'verified the replacement board' });
  assert.equal(approved.status, 200, await approved.clone().text());
  assert.equal(req(raw, id).status, 'awaiting_payment');
});

test('unrecorded: a unit with no serial on record is received and flagged; approving it is the owner’s', async () => {
  const raw = seed();
  const id = await submitted(raw);
  assert.deepEqual(await code(await intake(raw, id, STAFF, { serial: '' })), [400, 'TRADE_IN_INPUTS_INVALID']);
  const res = await intake(raw, id, STAFF, { serial: 'SCANNED00042' });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual([req(raw, id).intake_serial_match, req(raw, id).intake_serial_norm], ['unrecorded', 'SCANNED00042']);
  assert.equal((await json(res)).request.intake.serial_match, 'unrecorded');
  assert.deepEqual(await code(await post(adminApp(raw, STAFF), `/api/admin/trade-in/requests/${id}/approve`)), [403, 'OWNER_REQUIRED']);
  assert.equal((await post(adminApp(raw, OWNER), `/api/admin/trade-in/requests/${id}/approve`, { owner_reason: 'serial read off the plate' })).status, 200);
});

test('hours above what was declared beyond the tolerance are flagged for the desk, and the condition the desk records prices the ceiling', async () => {
  const raw = seed();
  serialOnRecord(raw);
  const id = await submitted(raw);
  const offer = req(raw, id).offer_iqd as number;
  const res = await intake(raw, id, STAFF, {
    serial: 'A1SERIAL0001',
    hours: 900,
    components: { device: { cleanliness: 2, exterior: 2, scratches: 2 } },
    findings: 'Heavy wear',
  });
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.request.intake.hours_flag, true);
  assert.equal(body.request.intake.hours_seen, 900);
  assert.equal(body.request.intake.hours_declared, 0);
  assert.ok(body.request.ceiling_iqd < offer, `ceiling ${body.request.ceiling_iqd} < offer ${offer}`);
  assert.equal(JSON.parse(row<{ intake_inputs_json: string }>(raw, "SELECT intake_inputs_json FROM trade_in_components WHERE request_id = ? AND role = 'device'", id)!.intake_inputs_json).hours, 900);
  // The customer's own answers are untouched.
  assert.equal(JSON.parse(row<{ inputs_json: string }>(raw, "SELECT inputs_json FROM trade_in_components WHERE request_id = ? AND role = 'device'", id)!.inputs_json).hours, 0);
  const mine = JSON.stringify((await json(await get(customerApp(raw), `/api/trade-in/requests/${id}`))).request);
  assert.ok(!mine.includes('hours_flag') && !mine.includes('Heavy wear'), mine.slice(0, 200));
});

test('never on one’s own request; never after the offer ended; never before the request was sent', async () => {
  const raw = seed();
  serialOnRecord(raw);
  const id = await submitted(raw);
  // An admin who is the trade-in's customer (the same account).
  const self: StubUser = { id: 'cust', role: 'admin', email: 'sara@x.co', admin_scope: 'full' };
  assert.deepEqual(await code(await intake(raw, id, self, { serial: 'A1SERIAL0001' })), [403, 'TRADE_IN_OWN_REQUEST']);
  // §16 D-3: no grace.
  raw.prepare('UPDATE trade_in_requests SET offer_expires_at = ? WHERE id = ?').run(daysAgo(1), id);
  assert.deepEqual(await code(await intake(raw, id, STAFF, { serial: 'A1SERIAL0001' })), [409, 'TRADE_IN_OFFER_EXPIRED']);
  // A draft has nothing to receive.
  const raw2 = seed();
  const a = customerApp(raw2);
  const draft = (await json(await post(a, '/api/trade-in/requests', { order_item_id: 'oi_a1', unit_index: 1, scope: 'whole' }))).request.id as string;
  assert.deepEqual(await code(await intake(raw2, draft, STAFF, { serial: 'X12345678' })), [409, 'TRADE_IN_BAD_STATE']);
});

test('cancel after intake: the device goes back to its customer («device_to_collect»), handed back once by any admin', async () => {
  const raw = seed();
  helperRow(raw);
  const id = await submitted(raw);
  await received(raw, id);
  const cancelled = await json(await post(customerApp(raw), `/api/trade-in/requests/${id}/cancel`, { reason: 'changed my mind' }));
  assert.equal(cancelled.request.status, 'cancelled');
  assert.equal(cancelled.request.stage, 'device_to_collect');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM user_notifications WHERE event_key = ?', `trade_in:${id}:device_ready`), 1);
  const back = await post(adminApp(raw, ASSISTANT), `/api/admin/trade-in/requests/${id}/device-returned`);
  assert.equal(back.status, 200, await back.clone().text());
  assert.equal((await json(back)).request.stage, 'cancelled');
  assert.ok(req(raw, id).device_returned_at);
  assert.equal((await post(adminApp(raw, ASSISTANT), `/api/admin/trade-in/requests/${id}/device-returned`)).status, 409);
});

test('intake photographs are the desk’s: any admin adds them; the customer can neither list nor open them', async () => {
  const raw = seed();
  helperRow(raw);
  const id = await submitted(raw);
  const form = new FormData();
  form.set('file', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]) as unknown as BlobPart], 'p.jpg', { type: 'image/jpeg' }));
  form.set('component', 'device');
  form.set('proves', 'serial');
  const up = await adminApp(raw, ASSISTANT).request(`/api/admin/trade-in/requests/${id}/photos`, { method: 'POST', body: form }, undefined, ctx);
  const photo = (await json(up)).photo;
  assert.equal(up.status, 201, JSON.stringify(photo));
  assert.match(photo.url, new RegExp(`^/files/trade-in/${id}/intake/`));
  await received(raw, id);
  const staff = (await json(await get(adminApp(raw, ASSISTANT), `/api/admin/trade-in/requests/${id}`))).request;
  assert.equal(staff.intake_photos.length, 1);
  const mine = (await json(await get(customerApp(raw), `/api/trade-in/requests/${id}`))).request;
  assert.ok(!JSON.stringify(mine).includes('/intake/'));
  const files = stubApp(new (await import('./fixtures/d1Limits')).LimitD1(raw) as unknown as D1Database, CUSTOMER, (a) => a.route('/files', fileRoutes));
  assert.equal((await files.request(photo.url, {}, undefined, ctx)).status, 403);
});

test('a credit fixed on photos before S-P2 and worth more than the ceiling goes back to the customer — on the SAME coupon row', async () => {
  const raw = seed();
  serialOnRecord(raw);
  const id = await submitted(raw);
  const offer = req(raw, id).offer_iqd as number;
  const legacy = offer + 100_000;
  raw.exec(`
    INSERT INTO coupons (id, code, kind, value, min_total_iqd, max_global, max_per_user, active, created_at, assigned_user_id, scope,
                         product_id, fulfillment_types, applies_to, cap_scope, max_quantity, stacks, trade_in_id, ends_at)
      VALUES ('cpn_old', 'TIOLDCREDIT1', 'fixed_iqd', ${legacy}, 0, 1, 1, 1, '${daysAgo(3)}', 'cust', 'product', 'p_p1s', '["direct_sale"]',
              'merchandise', 'per_order', 1, 0, '${id}', NULL);
    UPDATE trade_in_requests SET status = 'awaiting_payment', valuation_version = 1, offer_iqd = NULL, estimated_iqd = ${legacy}, final_value_iqd = ${legacy},
                                 credit_iqd = ${legacy}, difference_iqd = ${1_500_000 - legacy}, coupon_id = 'cpn_old' WHERE id = '${id}';
  `);
  const res = await intake(raw, id, STAFF, { serial: 'A1SERIAL0001' });
  assert.equal(res.status, 200, await res.clone().text());
  await settle();
  const r = req(raw, id);
  assert.deepEqual([r.status, r.admin_value_iqd, r.offer_no, r.ceiling_iqd], ['value_changed', offer, 1, offer]);
  assert.equal(row<{ active: number }>(raw, "SELECT active FROM coupons WHERE id = 'cpn_old'")!.active, 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM user_notifications WHERE event_key = ?', `trade_in:${id}:offer:1`), 1);
  // The customer accepts: the one coupon for life comes back with the new figure and a fresh week.
  const accepted = await json(await post(customerApp(raw), `/api/trade-in/requests/${id}/accept`, { offer_no: 1 }));
  assert.equal(accepted.request.status, 'awaiting_payment', JSON.stringify(accepted));
  const c = row<{ id: string; code: string; value: number; active: number; ends_at: string }>(raw, "SELECT id, code, value, active, ends_at FROM coupons WHERE trade_in_id = ?", id)!;
  assert.deepEqual([c.id, c.code, c.value, c.active], ['cpn_old', 'TIOLDCREDIT1', offer, 1]);
  assert.ok(Date.parse(c.ends_at) > Date.now() + 6 * 86_400_000);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM coupons WHERE trade_in_id = ?', id), 1);
  assert.equal(req(raw, id).coupon_id, 'cpn_old');
});

test('a credit fixed before S-P2 and already spent on a live order: the device is received without re-valuing money that moved', async () => {
  const raw = seed();
  serialOnRecord(raw);
  const id = await submitted(raw);
  const offer = req(raw, id).offer_iqd as number;
  raw.exec(`
    INSERT INTO orders (id,user_id,status,stage,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd)
      VALUES ('ORD-NEW','cust','pending','received','{}','standard','{}','cash',1500000,0,1400,${1_500_000 - offer},${1_500_000 - offer});
    INSERT INTO coupons (id, code, kind, value, min_total_iqd, max_global, max_per_user, active, created_at, assigned_user_id, scope, product_id, trade_in_id, ends_at)
      VALUES ('cpn_spent', 'TISPENT00001', 'fixed_iqd', ${offer}, 0, 1, 1, 1, '${daysAgo(3)}', 'cust', 'product', 'p_p1s', '${id}', '${daysAhead(4)}');
    UPDATE trade_in_requests SET status = 'awaiting_payment', final_value_iqd = ${offer}, credit_iqd = ${offer}, coupon_id = 'cpn_spent' WHERE id = '${id}';
  `);
  // The use itself predates 0192's trigger (a credit spent on photos): written with the trigger aside.
  raw.exec('DROP TRIGGER trg_trade_in_credit_needs_intake');
  raw.exec(`INSERT INTO coupon_redemptions (id, coupon_id, user_id, order_id, amount_iqd) VALUES ('red_old', 'cpn_spent', 'cust', 'ORD-NEW', ${offer})`);
  const res = await intake(raw, id, STAFF, { serial: 'A1SERIAL0001' });
  assert.equal(res.status, 200, await res.clone().text());
  const r = req(raw, id);
  assert.deepEqual([r.status, r.final_value_iqd, r.coupon_id], ['awaiting_payment', offer, 'cpn_spent']);
  assert.ok(r.intake_at);
});

test('concurrency: two desks receive the same device at once — one wins, the other hears TRADE_IN_ALREADY_RECEIVED', async () => {
  const raw = seed();
  serialOnRecord(raw);
  const id = await submitted(raw);
  const db = serialD1(raw);
  const app = (who: StubUser) => stubApp(db, who, (a) => a.route('/api/admin/trade-in', adminTradeInRoutes));
  const [a, b] = await Promise.all([
    post(app(STAFF), `/api/admin/trade-in/requests/${id}/intake`, { serial: 'A1SERIAL0001', handover: 'store' }),
    post(app(OWNER), `/api/admin/trade-in/requests/${id}/intake`, { serial: 'A1SERIAL0001', handover: 'store' }),
  ]);
  const answers = [await code(a), await code(b)].map((x) => x.join(' ')).sort();
  assert.deepEqual(answers, ['200 ', '409 TRADE_IN_ALREADY_RECEIVED'].sort());
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM trade_in_events WHERE request_id = ? AND action = 'intake'", id), 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM trade_in_valuations WHERE request_id = ? AND phase = 'intake'", id), 1);
});

test('concurrency: the customer cancels while the desk is receiving — the intake lands nothing (TRADE_IN_STALE)', async () => {
  const raw = seed();
  serialOnRecord(raw);
  const id = await submitted(raw);
  const race = new RaceD1(raw);
  race.when = (sqls) => sqls.some((s) => /SET intake_at = \?2/.test(s));
  race.hook = async () => {
    const r = await post(customerApp(raw), `/api/trade-in/requests/${id}/cancel`, { reason: 'sold it elsewhere' });
    assert.equal(r.status, 200, await r.clone().text());
  };
  const res = await post(stubApp(race as unknown as D1Database, STAFF, (a) => a.route('/api/admin/trade-in', adminTradeInRoutes)), `/api/admin/trade-in/requests/${id}/intake`, { serial: 'A1SERIAL0001', handover: 'store' });
  assert.deepEqual(await code(res), [409, 'TRADE_IN_STALE']);
  const r = req(raw, id);
  assert.deepEqual([r.status, r.intake_at], ['cancelled', null]);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM trade_in_valuations WHERE request_id = ? AND phase = ?', id, 'intake'), 0);
  void tradeInRoutes;
});
