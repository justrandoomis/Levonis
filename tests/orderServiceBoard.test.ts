/**
 * «خدمات الطابعة» ON THE ADMIN ORDER BOARD AND WINDOW (owner, 2026-11-21; DECISIONS row 364).
 *
 *  - the list route says what each order holds of the printer services (`service_flags`), offers NO
 *    one-tap move into a hand-over while a bought inspection is open, and filters by service;
 *  - «أكاديمية للجدولة» also lists a delivered order (the session is arranged after delivery);
 *  - a service task reads in three languages, never «(0 د.ع)», and a cancelled order's tasks are closed;
 *  - the screens draw it: kit AND add-on lines under their printer, the named breakdown rows, the
 *    services block, the inspection note, and words for every ORDER_SERVICE_TASK_* code.
 *
 * Run: node --import tsx --test tests/orderServiceBoard.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { addPrinter, appAs, json, liveConfig, orderBody, pending, post, setup, type Json } from './fixtures/printerOffers';
import { ROOT } from './fixtures/d1';
import { stubApp, get as appGet, json as appJson, post as appPost } from './fixtures/app';
import { adminRoutes } from '../worker/routes/admin';
import { adminOrderServiceTaskRoutes } from '../worker/routes/adminPrinterServices';
import { serviceTaskText } from '../worker/lib/printerServices';
import { boardServiceClause, BOARD_SERVICE_FILTERS, isPhysicalLine, receiptServiceNotes } from '../worker/lib/orderServiceBoard';
import { REFUSAL_STRINGS } from '../src/lib/refusalStrings';
import { itemsSummary } from '../src/components/adminOrders/OrderBoardRow';
import { DEFAULT_PRINTER_SERVICES, presetSelection, type ServiceSelection } from '../packages/pricing/src/printerServices';

const adminOf = (db: D1Database) =>
  stubApp(db, { id: 'owner', role: 'admin', email: 'owner@x.co' }, (a) => {
    a.route('/api/admin', adminRoutes);
    a.route('/api/admin/order-service-tasks', adminOrderServiceTaskRoutes);
  }, { publishV2: false, env: { INITIAL_ADMIN_EMAIL: 'owner@x.co' } });
const pkg = (id: 'just' | 'smart' | 'complete', delivery: ServiceSelection['delivery'] = 'economy'): ServiceSelection =>
  ({ ...presetSelection(DEFAULT_PRINTER_SERVICES, id, delivery), confirmed: true, ack_no_warranty: id === 'just', ...(id === 'complete' ? { academy: 'live_whatsapp' as const } : {}) });

async function place(raw: DatabaseSync, a: ReturnType<typeof appAs>, services: ServiceSelection, over: Record<string, unknown> = {}) {
  await addPrinter(a, { services });
  const res = await post(a, '/api/orders', orderBody(over));
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 500));
  // Out of «تم استلام الطلب»: the next stage on the direct path is then the hand-over the inspection guards.
  return body.order.id as string;
}
const board = async (db: D1Database, query = '') => {
  const res = await appGet(adminOf(db), `/api/admin/orders?scope=all&lang=ar${query}`);
  const body = await appJson(res);
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 400));
  return body as Json;
};

test('the board: flags per order, no one-tap hand-over while the inspection is open, filters and counts; the task closes it', async () => {
  const { db, raw } = setup({ config: liveConfig({ price_anchor: 'smart' }) });
  const a = appAs(db, 'buyer');
  const complete = await place(raw, a, pkg('complete'));
  const just = await place(raw, a, pkg('just'), { deliveryMethodId: 'pickup' });
  // An ordinary order beside them.
  await post(a, '/api/cart/items', { productId: 'p_pla', qty: 1 });
  const plain = (await json(await post(a, '/api/orders', orderBody()))).order.id as string;

  const all = await board(db);
  const row = (id: string) => all.orders.find((o: Json) => o.id === id) as Json;
  assert.deepEqual(row(complete).service_flags, {
    printer_services: true, package: 'complete', care: true, no_warranty: false, pickup: false, inspection_open: true, academy_open: true, membership: null,
  });
  assert.deepEqual(row(just).service_flags, {
    printer_services: true, package: 'just', care: false, no_warranty: true, pickup: true, inspection_open: false, academy_open: false, membership: null,
  });
  assert.equal('service_flags' in row(plain), false, 'an ordinary order carries no new field');
  assert.deepEqual(all.service_counts, { inspection: 1, academy: 1, membership_pending: 0 });

  // Each filter lists exactly its orders.
  const ids = async (service: string) => (await board(db, `&service=${service}`)).orders.map((o: Json) => o.id).sort();
  assert.deepEqual(await ids('printer_services'), [complete, just].sort());
  assert.deepEqual(await ids('inspection'), [complete]);
  assert.deepEqual(await ids('academy'), [complete]);
  assert.deepEqual(await ids('care'), [complete]);
  assert.deepEqual(await ids('pickup'), [just]);
  assert.deepEqual(await ids('membership_pending'), []);
  assert.equal((await appGet(adminOf(db), '/api/admin/orders?service=teleport')).status, 400, 'a typo is refused, never a silent default');

  // The hand-over is not offered while the inspection is open; once the order stands one step before it.
  raw.prepare("UPDATE orders SET stage = 'preparing', status = 'processing' WHERE id IN (?, ?)").run(complete, just);
  const held = await board(db);
  const heldRow = held.orders.find((o: Json) => o.id === complete) as Json;
  const freeRow = held.orders.find((o: Json) => o.id === just) as Json;
  assert.equal(heldRow.quick_next, null, 'the row offers no move the inspection gate can only refuse');
  assert.ok(freeRow.quick_next, 'an order with no inspection keeps its one-tap move');

  // The window: tasks in three languages, the inspection flag; closing the task frees the row.
  const admin = adminOf(db);
  const detail = (await appJson(await appGet(admin, `/api/admin/orders/${complete}?lang=ar`))).order as Json;
  assert.equal(detail.inspection_open, true);
  assert.equal(detail.service_tasks_open, true);
  assert.deepEqual(detail.service_tasks.map((t: Json) => t.kind).sort(), ['academy', 'inspection', 'packaging']);
  const inspection = detail.service_tasks.find((t: Json) => t.kind === 'inspection') as Json;
  const closed = await appJson(await appPost(admin, `/api/admin/order-service-tasks/${inspection.id}/done`, { result_note: 'checked the bed and the nozzle' }));
  const after = closed.tasks.find((t: Json) => t.id === inspection.id) as Json;
  assert.deepEqual([after.status, after.done_by_name, !!after.text?.ckb], ['done', 'Owner', true], 'the answer is the same view: words and the closer\'s name');
  assert.ok((await board(db)).orders.find((o: Json) => o.id === complete).quick_next, 'the hand-over is offered again');

  // Delivered: off the live board, still under «أكاديمية للجدولة» — the session is arranged after delivery.
  raw.prepare("UPDATE order_service_tasks SET status = 'done', done_by = 'owner', done_at = '2026-11-21T08:00:00.000Z' WHERE order_id = ? AND kind = 'packaging'").run(complete);
  raw.prepare("UPDATE orders SET stage = 'delivered', status = 'delivered', delivered_at = '2026-11-22T09:00:00.000Z' WHERE id = ?").run(complete);
  assert.equal((await board(db)).orders.some((o: Json) => o.id === complete), false);
  assert.deepEqual(await ids('academy'), [complete]);

  // Cancelled: its tasks are closed to staff, and the refusal has words.
  raw.prepare("UPDATE orders SET stage = 'cancelled', status = 'cancelled' WHERE id = ?").run(just);
  const ended = (await appJson(await appGet(admin, `/api/admin/orders/${just}?lang=ar`))).order as Json;
  assert.equal(ended.service_tasks_open, false);
  const refused = await appPost(admin, `/api/admin/order-service-tasks/${ended.service_tasks[0].id}/done`, {});
  assert.equal((await appJson(refused)).code, 'ORDER_SERVICE_TASK_ORDER_ENDED');
  await Promise.allSettled(pending);
});

test('a database behind the services answers «no order» for every filter instead of failing the board', async () => {
  const none = { prepare: () => ({ first: async () => { throw new Error('D1_ERROR: no such table: order_service_tasks'); } }) } as unknown as D1Database;
  for (const f of BOARD_SERVICE_FILTERS) assert.equal(await boardServiceClause(none, f), '0', f);
});

test('task words: three languages, the fee and lead days from the frozen line, «×N» in words, and no «(0 د.ع)»', () => {
  const snap = JSON.stringify({ lines: [{ service: 'packaging', choice: 'extra', fee_iqd: 10_000 }], inspection_lead_business_days: [2, 3] });
  const extra = serviceTaskText({ kind: 'packaging', choice: 'extra', qty: 2 }, snap)!;
  assert.match(extra.ar, /دفع الزبون 10,000 د\.ع — لكل طابعة من الـ2/);
  assert.match(extra.en, /the customer paid 10,000 IQD — for each of the 2 printers/);
  assert.match(extra.ckb, /10,000 د\.ع/);
  const std = serviceTaskText({ kind: 'packaging', choice: 'standard' })!;
  assert.doesNotMatch(`${std.ar}${std.en}${std.ckb}`, /0 د\.ع|0 IQD/);
  assert.match(serviceTaskText({ kind: 'inspection', choice: 'full' }, snap)!.ar, /لا تُسلَّم للمندوب قبل إكماله \(يضيف 2–3 أيام عمل للتجهيز\)/);
  for (const choice of ['live_whatsapp', 'live_in_person']) {
    const t = serviceTaskText({ kind: 'academy', choice })!;
    assert.ok(t.ar && t.en && t.ckb && t.ckb !== t.ar && t.ckb !== t.en, choice);
  }
  assert.equal(serviceTaskText({ kind: 'something_new', choice: 'x' }), null, 'an unknown kind falls back to the stored note');
  assert.doesNotMatch(readFileSync(join(ROOT, 'worker/lib/printerServices.ts'), 'utf8'), /\(0 د\.ع\)/);
});

test('the waybill, the sticker and the receipt: the membership is not a piece; a gift is; the receipt names what was bought', () => {
  assert.equal(isPhysicalLine({ line_kind: 'membership' }), false);
  assert.equal(isPhysicalLine({ gift_entitlement_id: 'g1' }), true, 'a gift and a draw prize ship');
  assert.equal(isPhysicalLine({}), true);
  const notes = receiptServiceNotes({}, { selection: { package: 'just' }, lines: [{ service: 'packaging', choice: 'standard' }], warranty_months: 0, care_total_months: 0, delivery: 'pickup' }, 0);
  assert.deepEqual(notes.map((n) => n.ar), ['الباقة: الطابعة فقط', 'بلا ضمان — بموافقة الزبون', 'استلام من المخزن']);
  assert.deepEqual(receiptServiceNotes({ gift_entitlement_id: 'g' }, null, 0).map((n) => n.en), ['Gift — 0 IQD']);
  assert.deepEqual(receiptServiceNotes({ kit_parent_item_id: 'p', addon_id: 'n' }, null, 2_000).map((n) => n.ar), ['إضافة مع الطابعة', 'خصم ليفو كير على قطعة: -2,000 د.ع']);
});

test('the row summary groups a printer\'s kit and add-ons under it and marks the membership', () => {
  const loc = (ar: string) => ar;
  const order = { items: [
    { id: 'p', name: 'طابعة A1', variant: '', qty: 1 },
    { id: 'k', name: 'PLA', variant: 'أبيض', qty: 2, kit: { printer_item_id: 'p', kit_id: 'x' } },
    { id: 'n', name: 'فوهة', variant: '', qty: 1, addon: { printer_item_id: 'p', addon_id: 'n' } },
    { id: 'm', name: 'عضوية بريميوم', variant: '', qty: 1, kind: 'membership' },
    { id: 'g', name: 'خيط', variant: '', qty: 1, is_gift: true },
  ] } as never;
  assert.equal(itemsSummary(order, true, loc), 'طابعة A1 ×1 + معها: PLA (أبيض) ×2, فوهة ×1 · عضوية: عضوية بريميوم · 🎁 خيط ×1');
});

test('the screens draw it, in three languages, and every task refusal has words', () => {
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  const modal = read('src/components/adminOrders/OrderDetailModal.tsx');
  // Add-on lines are grouped under their printer too.
  assert.match(modal, /\.kit\?\.printer_item_id \?\? \(it as PhaseTwoLine\)\.addon\?\.printer_item_id \?\? null/);
  assert.match(modal, /<OrderServicesBlock\s+services=\{it\.services\}/);
  assert.match(modal, /breakdown\.rows\.map/);
  assert.match(modal, /data-inspection-hold-note/);
  assert.match(modal, /sv\.drawPrize/);
  assert.doesNotMatch(modal, /detail\.membership_gift\.label_ar \|\| detail\.membership_gift\.product_id/, 'never a raw product id');
  const block = read('src/components/orders/OrderServicesBlock.tsx');
  assert.match(block, /typeof services\.net_fee_iqd === 'number' \? services\.net_fee_iqd : services\.fee_iqd/, 'the charge is net_fee_iqd');
  assert.match(read('src/pages/OrderDetail.tsx'), /audience="customer"/);
  const board = read('src/components/adminOrders/OrdersBoard.tsx');
  for (const f of BOARD_SERVICE_FILTERS) assert.ok(board.includes(`['${f}', loc(`), `the board offers the «${f}» filter`);
  assert.doesNotMatch(read('src/components/adminOrders/ServiceTasksSection.tsx'), /e\.message/, 'never the server\'s raw sentence');
  for (const code of ['ORDER_SERVICE_TASK_CLOSED', 'ORDER_SERVICE_TASK_ORDER_ENDED', 'ORDER_SERVICE_TASK_NOTE_REQUIRED']) {
    const e = REFUSAL_STRINGS[code];
    assert.ok(e && e.ar && e.en && e.ckb && e.ckb !== e.ar, code);
  }
});
