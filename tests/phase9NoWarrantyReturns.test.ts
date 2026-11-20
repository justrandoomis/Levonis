/**
 * «NO WARRANTY = NO FREE RETURN», ENFORCED (owner, 2026-11-20; DECISIONS row 365).
 *
 * Owner: «returns rules follow the new wording: no warranty = no free return». Until now that sentence was copy:
 * the returns door never read the printer's services, so a «Just Printer» buyer had the same seven days as
 * everyone. The matrix, through the real returns router:
 *
 *   line                                   customer's read            customer's request
 *   Just Printer (warranty none)           eligible: false + reason   409 NO_WARRANTY_NO_FREE_RETURN
 *   custom choice without a warranty       eligible: false + reason   409 NO_WARRANTY_NO_FREE_RETURN
 *   Smart Choice (12 months)               eligible: true             day 1–7 opens, day 8 RETURN_WINDOW_CLOSED
 *   PRO order + Just Printer               eligible: false + reason   409 (PRO's 14 days need a warranty)
 *   PRO order + Smart Choice               eligible: true             14 days
 *   kit / add-on line of a Just order      not listed (its own rules) opens as before
 *   printer sold before the services       not listed                 opens as before — byte-identical answers
 *
 * and the shop's way to honour a legal right or a goodwill case (damaged on arrival): THE OWNER opens the return
 * for such a line with a written reason, audited; any other staff member is refused in words.
 *
 * Run: node --import tsx --test tests/phase9NoWarrantyReturns.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, stubApp, post, get, json, type StubUser } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { returnRoutes } from '../worker/routes/returns';
import { seedCatalogue, orderBody } from './lib/bundles';
import { NO_WARRANTY_NO_FREE_RETURN, lineReturnRule, returnTermsFor } from '../worker/lib/returnWindow';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';

const DAY = 86_400_000;
const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
const OWNER: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };
const STAFF = { id: 'staff', role: 'admin', email: 'staff@x.co', admin_scope: 'full' } as StubUser;
const ASSISTANT = { id: 'helper', role: 'admin', email: 'helper@x.co', admin_scope: 'assistant' } as StubUser;
const appFor = (db: unknown, who: StubUser = buyer) =>
  stubApp(db, who, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/orders', orderRoutes);
    a.route('/api/returns', returnRoutes);
  });

/** The frozen services of a printer line, as checkout writes them (the fields the rule reads). */
const snapshot = (warranty: 0 | 12 | 24, pkg: 'just' | 'smart' | 'complete' | 'custom'): string =>
  JSON.stringify({
    v: 1, fee_iqd: 0, warranty_months: warranty, care_months: 0, care_total_months: 0, revision: 3,
    selection: {
      v: 1, package: pkg, warranty: warranty === 0 ? 'none' : `w${warranty}`, care: 'none', packaging: 'standard',
      inspection: 'none', academy: 'none', delivery: 'economy', confirmed: true, ack_no_warranty: warranty === 0,
    },
  });

interface World { raw: DatabaseSync; db: unknown; orderId: string; printer: string; kit: string }

/**
 * One delivered order of two lines: the «printer» (given `services`, or none for a printer sold before the
 * services existed) and a kit line beside it. Delivered `daysAgo` days ago; `tier` is the order's frozen tier.
 */
async function world(services: string | null, o: { daysAgo?: number; tier?: string } = {}): Promise<World> {
  const raw = seedCatalogue();
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role,admin_scope) VALUES
    ('staff','Staff','staff@x.co','h','admin','full'), ('helper','Helper','helper@x.co','h','admin','assistant')`);
  const db = asD1(raw);
  for (const productId of ['p_pla', 'p_nozzle']) {
    const added = await json(await post(appFor(db), '/api/cart/items', { productId, qty: 1 }));
    assert.equal(added.success, true, JSON.stringify(added));
  }
  const placed = await json(await post(appFor(db), '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed));
  const orderId = placed.order.id as string;
  const lines = raw.prepare('SELECT id, product_id FROM order_items WHERE order_id = ? ORDER BY rowid').all(orderId) as Array<{ id: string; product_id: string }>;
  const printer = lines.find((l) => l.product_id === 'p_pla')!.id;
  const kit = lines.find((l) => l.product_id === 'p_nozzle')!.id;
  if (services) raw.prepare('UPDATE order_items SET services_snapshot = ? WHERE id = ?').run(services, printer);
  if (o.tier) raw.prepare('UPDATE orders SET membership_tier_snapshot = ? WHERE id = ?').run(o.tier, orderId);
  const w = { raw, db, orderId, printer, kit };
  deliveredDaysAgo(w, o.daysAgo ?? 1);
  return w;
}
const deliveredDaysAgo = (w: World, days: number) =>
  w.raw.prepare("UPDATE orders SET status='delivered', stage='delivered', delivered_at=? WHERE id=?").run(new Date(Date.now() - days * DAY).toISOString(), w.orderId);
const read = async (w: World) => json(await get(appFor(w.db), `/api/returns?orderId=${w.orderId}`));
const ask = (w: World, orderItemId: string, who: StubUser = buyer) =>
  post(appFor(w.db, who), '/api/returns', { orderItemId, qty: 1, reason: 'defective' });
const cases = (w: World) => (w.raw.prepare('SELECT COUNT(*) AS n FROM return_cases').get() as { n: number }).n;
const INELIGIBLE = { eligible: false, reason: 'NO_WARRANTY_NO_FREE_RETURN' };

// ------------------------------------------------------------ the rule, pure

test('the rule: only a printer sold through the services with warranty NONE loses the customer’s return flow', () => {
  assert.equal(NO_WARRANTY_NO_FREE_RETURN, 'NO_WARRANTY_NO_FREE_RETURN');
  assert.deepEqual(lineReturnRule(snapshot(0, 'just')), { serviced: true, ...INELIGIBLE });
  assert.deepEqual(lineReturnRule(snapshot(0, 'custom')), { serviced: true, ...INELIGIBLE });
  assert.deepEqual(lineReturnRule(snapshot(12, 'smart')), { serviced: true, eligible: true });
  assert.deepEqual(lineReturnRule(snapshot(24, 'complete')), { serviced: true, eligible: true });
  // No snapshot, or one this code cannot read: sold without the services — nothing changes for it.
  for (const v of [null, undefined, '', '{}', 'garbage', JSON.stringify({ warranty_months: '0' }), JSON.stringify({ warranty_months: 6 })]) {
    assert.deepEqual(lineReturnRule(v), { serviced: false, eligible: true }, String(v));
  }
  // The order's terms are untouched by this round.
  assert.deepEqual(returnTermsFor('pro'), { window_days: 14, free_return: true });
  assert.deepEqual(returnTermsFor(null), { window_days: 7, free_return: false });
});

test('the refusal is words in three languages, with the consumer-rights sentence kept', () => {
  const s = REFUSAL_STRINGS.NO_WARRANTY_NO_FREE_RETURN;
  assert.equal(s.ar, 'بيعت هذه الطابعة بلا ضمان، ولذلك لا يشملها الإرجاع المجاني. تواصل مع الدعم إن وصلتك تالفة. حقوقك القانونية كمستهلك تبقى قائمة.');
  assert.match(s.en, /sold without a warranty/i);
  assert.match(s.en, /statutory consumer rights still apply/i);
  assert.notEqual(s.ckb, s.ar);
  assert.match(s.ckb, /گەرەنتی/);
  for (const code of ['RETURN_EXCEPTION_NOT_NEEDED', 'RETURN_EXCEPTION_REASON_REQUIRED'] as const) {
    assert.ok(REFUSAL_STRINGS[code].ar && REFUSAL_STRINGS[code].en && REFUSAL_STRINGS[code].ckb, code);
    assert.notEqual(REFUSAL_STRINGS[code].ckb, REFUSAL_STRINGS[code].ar, code);
  }
});

// ------------------------------------------------------------ the customer's door

test('Just Printer: the read says not eligible and why, the request is refused 409, and nothing is written', async () => {
  const w = await world(snapshot(0, 'just'));
  const listed = await read(w);
  assert.deepEqual(listed.terms, { window_days: 7, free_return: false });
  assert.deepEqual(listed.lines, [{ order_item_id: w.printer, ...INELIGIBLE }], 'only the serviced printer is listed');
  const refused = await ask(w, w.printer);
  const body = await json(refused);
  assert.equal(refused.status, 409, JSON.stringify(body));
  assert.equal(body.code, 'NO_WARRANTY_NO_FREE_RETURN');
  assert.match(body.error, /بلا ضمان/);
  assert.match(body.error, /حقوقك القانونية كمستهلك تبقى قائمة/);
  assert.equal(cases(w), 0);
  // Every accepted reason is refused alike — «damaged on arrival» goes to support (the owner's exception).
  for (const reason of ['manufacturing_fault', 'not_as_described', 'wrong_product', 'shipping_damage']) {
    const r = await post(appFor(w.db), '/api/returns', { orderItemId: w.printer, qty: 1, reason });
    assert.equal((await json(r)).code, 'NO_WARRANTY_NO_FREE_RETURN', reason);
  }
  assert.equal(cases(w), 0);
});

test('a custom choice without a warranty is refused the same way', async () => {
  const w = await world(snapshot(0, 'custom'));
  assert.deepEqual((await read(w)).lines, [{ order_item_id: w.printer, ...INELIGIBLE }]);
  const refused = await ask(w, w.printer);
  assert.equal(refused.status, 409);
  assert.equal((await json(refused)).code, 'NO_WARRANTY_NO_FREE_RETURN');
  assert.equal(cases(w), 0);
});

test('Smart Choice: eligible, opens on day 1 and on day 7, closed on day 8 — the window and reasons are unchanged', async () => {
  const w = await world(snapshot(12, 'smart'), { daysAgo: 1 });
  assert.deepEqual((await read(w)).lines, [{ order_item_id: w.printer, eligible: true }]);
  const day1 = await json(await ask(w, w.printer));
  assert.equal(day1.success, true, JSON.stringify(day1));
  assert.equal(day1.case.within_window, true);

  w.raw.exec('DELETE FROM return_cases');
  deliveredDaysAgo(w, 6.9);
  assert.equal((await json(await ask(w, w.printer))).success, true, 'the seventh day is inside');

  w.raw.exec('DELETE FROM return_cases');
  deliveredDaysAgo(w, 8);
  const day8 = await json(await ask(w, w.printer));
  assert.equal(day8.code, 'RETURN_WINDOW_CLOSED');
  assert.deepEqual(day8.details, { window_days: 7 });
});

test('PRO + Just Printer: refused — PRO’s fourteen days need a warranty on a serviced printer', async () => {
  const w = await world(snapshot(0, 'just'), { tier: 'pro', daysAgo: 3 });
  const listed = await read(w);
  assert.deepEqual(listed.terms, { window_days: 14, free_return: true }, 'the order’s terms still hold for its other lines');
  assert.deepEqual(listed.lines, [{ order_item_id: w.printer, ...INELIGIBLE }]);
  const refused = await ask(w, w.printer);
  assert.equal(refused.status, 409);
  assert.equal((await json(refused)).code, 'NO_WARRANTY_NO_FREE_RETURN');
  assert.equal(cases(w), 0);
});

test('PRO + Smart Choice: fourteen days — open on day 10, closed on day 15', async () => {
  const w = await world(snapshot(12, 'smart'), { tier: 'pro', daysAgo: 10 });
  assert.deepEqual((await read(w)).lines, [{ order_item_id: w.printer, eligible: true }]);
  assert.equal((await json(await ask(w, w.printer))).success, true);
  w.raw.exec('DELETE FROM return_cases');
  deliveredDaysAgo(w, 15);
  const late = await json(await ask(w, w.printer));
  assert.equal(late.code, 'RETURN_WINDOW_CLOSED');
  assert.deepEqual(late.details, { window_days: 14 });
});

test('the kit line of a Just Printer order keeps its own rules: it opens as before', async () => {
  const w = await world(snapshot(0, 'just'), { daysAgo: 2 });
  const opened = await json(await ask(w, w.kit));
  assert.equal(opened.success, true, JSON.stringify(opened));
  assert.equal(opened.case.order_item_id, w.kit);
  // …and on day 8 it is closed by the window, like any line.
  w.raw.exec('DELETE FROM return_cases');
  deliveredDaysAgo(w, 8);
  assert.equal((await json(await ask(w, w.kit))).code, 'RETURN_WINDOW_CLOSED');
});

test('a printer sold before the services (no snapshot): the read and the request answer exactly as they did', async () => {
  const w = await world(null, { daysAgo: 2 });
  const listed = await read(w);
  assert.deepEqual(Object.keys(listed), ['success', 'terms', 'cases'], 'no new field on an order without a serviced printer');
  assert.deepEqual(listed, { success: true, terms: { window_days: 7, free_return: false }, cases: [] });
  const opened = await json(await ask(w, w.printer));
  assert.equal(opened.success, true, JSON.stringify(opened));
  assert.deepEqual(Object.keys(opened), ['success', 'case']);
  // The staff queue carries no new field for it either.
  const queue = await json(await get(appFor(w.db, OWNER), '/api/returns/admin/queue'));
  assert.equal(queue.cases.length, 1);
  assert.equal('no_warranty' in queue.cases[0], false);
  assert.equal('owner_exception' in queue.cases[0], false);
  assert.equal(queue.cases[0].free_return, false);
  // The owner's exception door is for a printer sold without a warranty only.
  w.raw.exec('DELETE FROM return_cases');
  const notNeeded = await post(appFor(w.db, OWNER), '/api/returns/admin/exception', {
    orderItemId: w.printer, qty: 1, reason: 'shipping_damage', exception_reason: 'arrived with a cracked frame',
  });
  assert.equal(notNeeded.status, 409);
  assert.equal((await json(notNeeded)).code, 'RETURN_EXCEPTION_NOT_NEEDED');
  assert.equal(cases(w), 0);
});

// ------------------------------------------------------------ the owner's exception

test('the owner opens a return for a printer sold without a warranty — with a written reason, audited; the customer sees the case', async () => {
  const w = await world(snapshot(0, 'just'), { daysAgo: 2 });
  const exception = (who: StubUser, over: Record<string, unknown> = {}) =>
    post(appFor(w.db, who), '/api/returns/admin/exception', {
      orderItemId: w.printer, qty: 1, reason: 'shipping_damage', description: 'Frame cracked in transit; photos in the chat.',
      exception_reason: 'وصلت الطابعة تالفة — حق قانوني للزبون', ...over,
    });

  // A reason is required: five characters at least.
  for (const exception_reason of [undefined, '', '  ', 'abcd']) {
    const r = await exception(OWNER, { exception_reason });
    assert.equal(r.status, 400, String(exception_reason));
    assert.equal((await json(r)).code, 'RETURN_EXCEPTION_REASON_REQUIRED');
  }
  assert.equal(cases(w), 0);

  const res = await exception(OWNER);
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  assert.equal(body.owner_exception, true);
  const kase = w.raw.prepare('SELECT * FROM return_cases').get() as Record<string, unknown>;
  assert.equal(kase.id, body.case.id);
  assert.deepEqual(
    [kase.order_id, kase.order_item_id, kase.user_id, kase.qty, kase.reason, kase.state, kase.within_window],
    [w.orderId, w.printer, 'buyer', 1, 'shipping_damage', 'requested', 1],
    'the case is the CUSTOMER’s, in the ordinary pipeline'
  );
  const log = w.raw.prepare("SELECT actor_id, target, detail FROM audit_log WHERE action = 'return.owner_exception'").all() as Array<{ actor_id: string; target: string; detail: string }>;
  assert.equal(log.length, 1);
  assert.equal(log[0].actor_id, 'boss');
  assert.equal(log[0].target, body.case.id);
  const detail = JSON.parse(log[0].detail);
  assert.equal(detail.exception_reason, 'وصلت الطابعة تالفة — حق قانوني للزبون');
  assert.deepEqual([detail.order_id, detail.order_item_id, detail.customer_id, detail.rule, detail.reason], [w.orderId, w.printer, 'buyer', 'NO_WARRANTY_NO_FREE_RETURN', 'shipping_damage']);

  // The customer follows it on the order page; their own door stays closed for the line.
  const mine = await read(w);
  assert.equal(mine.cases.length, 1);
  assert.equal(mine.cases[0].id, body.case.id);
  assert.deepEqual(mine.lines, [{ order_item_id: w.printer, ...INELIGIBLE }]);
  assert.equal((await json(await ask(w, w.printer))).code, 'NO_WARRANTY_NO_FREE_RETURN');

  // The staff queue says what the line is and why a case exists on it.
  const queue = await json(await get(appFor(w.db, STAFF), '/api/returns/admin/queue'));
  assert.equal(queue.cases.length, 1);
  assert.equal(queue.cases[0].no_warranty, true);
  assert.equal(queue.cases[0].owner_exception.reason, 'وصلت الطابعة تالفة — حق قانوني للزبون');
  assert.equal(queue.cases[0].free_return, false);

  // One case per unit still: the ordinary quota holds for the exception too.
  const twice = await exception(OWNER);
  assert.equal((await json(twice)).code, 'QTY_EXCEEDED');
});

test('staff who are not the owner are refused in words, and nothing is written', async () => {
  const w = await world(snapshot(0, 'just'), { daysAgo: 2 });
  const body = { orderItemId: w.printer, qty: 1, reason: 'shipping_damage', exception_reason: 'arrived with a cracked frame' };
  const staff = await post(appFor(w.db, STAFF), '/api/returns/admin/exception', body);
  assert.equal(staff.status, 403);
  const staffBody = await json(staff);
  assert.equal(staffBody.code, 'OWNER_REQUIRED');
  assert.ok(String(staffBody.error).length > 10, 'a sentence, not a code');
  const helper = await post(appFor(w.db, ASSISTANT), '/api/returns/admin/exception', body);
  assert.equal(helper.status, 403);
  const customer = await post(appFor(w.db, buyer), '/api/returns/admin/exception', body);
  assert.ok(customer.status === 403 || customer.status === 401, String(customer.status));
  assert.equal(cases(w), 0);
  assert.equal((w.raw.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'return.owner_exception'").get() as { n: number }).n, 0);
});

test('the owner’s exception is the owner’s judgement on time as well: a late one is opened and recorded as outside the window', async () => {
  const w = await world(snapshot(0, 'just'), { tier: 'pro', daysAgo: 20 });
  const res = await post(appFor(w.db, OWNER), '/api/returns/admin/exception', {
    orderItemId: w.printer, qty: 1, reason: 'defective', exception_reason: 'reported on day 2 by phone, opened late',
  });
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.case.within_window, false, 'said as it is, never dressed up as timely');
  const detail = JSON.parse((w.raw.prepare("SELECT detail FROM audit_log WHERE action = 'return.owner_exception'").get() as { detail: string }).detail);
  assert.equal(detail.within_window, false);
  // PRO's fee-free return is not handed to a printer sold without a warranty.
  const queue = await json(await get(appFor(w.db, OWNER), '/api/returns/admin/queue'));
  assert.equal(queue.cases[0].free_return, false);
  // An undelivered order is still not returnable, exception or not.
  const u = await world(snapshot(0, 'just'));
  u.raw.prepare("UPDATE orders SET status='processing', stage='preparing', delivered_at=NULL WHERE id=?").run(u.orderId);
  const early = await post(appFor(u.db, OWNER), '/api/returns/admin/exception', {
    orderItemId: u.printer, qty: 1, reason: 'defective', exception_reason: 'not delivered yet',
  });
  assert.equal((await json(early)).code, 'NOT_DELIVERED');
});
