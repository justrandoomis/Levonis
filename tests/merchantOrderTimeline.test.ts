/**
 * ONE STORE ORDER AS A STORY (W3-B): GET /api/merchant/orders/:id/timeline.
 *
 * Every event is a row that already exists (history, the admin's audit row,
 * the ledger, the refund, the receipt, disputes, the chat); nothing is
 * invented; the order is oldest first with the expected release last; no
 * free text or staff identity leaves; another store's order is a 404.
 *
 * Run: node --import tsx --test tests/merchantOrderTimeline.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { get, json } from './fixtures/app';
import { OWNER, OWNER2, addOrder, appOf, seedW2E } from './fixtures/merchantW2E';
import { merchantOrderRoutes, buildOrderTimeline, orderMoney, type TimelineInput } from '../worker/routes/merchantOrders';

const timeline = async (raw: DatabaseSync, id: string, user = OWNER) => {
  const res = await get(appOf(raw, user, (a) => a.route('/api/merchant/orders', merchantOrderRoutes)), `/api/merchant/orders/${id}/timeline`);
  return { status: res.status, body: await json(res) };
};

const ledger = (raw: DatabaseSync, rows: Array<[string, string, string, number, string, string | null]>) => {
  const st = raw.prepare(
    `INSERT INTO merchant_ledger_entries (id, merchant_id, store_id, order_id, kind, bucket, amount_iqd, event_key, created_at, created_by)
     VALUES (?, 'm1', 's1', ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const [id, order, kind, amount, at, by] of rows) {
    const bucket = id.endsWith('_avail') ? 'available' : 'pending';
    st.run(id, order, kind, bucket, amount, `ev:${id}`, at, by);
  }
};

function deliveredStory(raw: DatabaseSync) {
  addOrder(raw, { id: 'ORD-T', at: '2026-09-01T08:00:00.000Z', total: 23000, status: 'delivered' });
  raw.exec(`
    UPDATE orders SET delivered_at = '2026-09-03T12:00:00.000Z', shipping_iqd = 3000,
           delivery_governorate = 'basra', delivery_rule = 'override', delivery_prep_days = 2,
           delivery_method_snapshot = '{"fulfilment":"delivery","governorate":"basra","rule":"override","fee_iqd":3000,"base_fee_iqd":5000,"free_over_iqd":50000,"note":"secret internal"}',
           admin_note = 'ADMIN PRIVATE NOTE'
     WHERE id = 'ORD-T';
    INSERT INTO order_items (id,order_id,community_product_id,variant_id,name_snapshot,option_snapshot,sku_snapshot,qty,unit_price_iqd,line_total_iqd,seller_type)
      VALUES ('it1','ORD-T','cp1','v-red','Vase','Red / L','VASE-R-L',2,10000,20000,'merchant');
    INSERT INTO order_status_history (id, order_id, stage, status, source, changed_at, changed_by, note) VALUES
      ('h1','ORD-T','confirmed','confirmed','manual','2026-09-01T09:00:00.000Z','owner','Moved by the store'),
      ('h2','ORD-T','shipped','shipped','manual','2026-09-02T09:00:00.000Z','owner','Moved by the store'),
      ('h3','ORD-T','delivered','delivered','delivery_api','2026-09-03T12:00:00.000Z','','courier said so');
    INSERT INTO audit_log (actor_id, action, target, detail, created_at) VALUES
      ('boss','order.status','ORD-T','{"from":"confirmed","to":"processing"}','2026-09-01T10:00:00.000Z'),
      ('boss','order.stage','ORD-T','{"to":"x"}','2026-09-01T10:30:00.000Z');
    INSERT INTO community_complaints (id, reporter_id, merchant_id, store_id, order_id, category, description, status, created_at)
      VALUES ('cc1','buyer','m1','s1','ORD-T','delivery','THE CUSTOMER TEXT','under_review','2026-09-04T10:00:00.000Z');
    INSERT INTO chats (id, created_at, order_id, context_type, context_id, merchant_id, store_id) VALUES ('chat1','2026-09-01T08:30:00.000Z','ORD-T','store_order','ORD-T','m1','s1');
    INSERT INTO chat_participants (chat_id, user_id) VALUES ('chat1','owner'), ('chat1','buyer');
  `);
  ledger(raw, [
    ['l_g', 'ORD-T', 'sale_gross', 20000, '2026-09-01T08:00:00.000Z', null],
    ['l_c', 'ORD-T', 'commission', -1000, '2026-09-01T08:00:00.000Z', null],
    ['l_d', 'ORD-T', 'delivery_fee', 3000, '2026-09-01T08:00:00.000Z', null],
  ]);
}

test('a delivered order: every recorded fact, oldest first, the expected release last and frozen by the open complaint', async () => {
  const raw = seedW2E();
  deliveredStory(raw);
  const { status, body } = await timeline(raw, 'ORD-T');
  assert.equal(status, 200, JSON.stringify(body));
  const kinds = body.events.map((e: { kind: string; status?: string }) => (e.kind === 'status' ? `status:${e.status}` : e.kind));
  assert.deepEqual(kinds, [
    'placed',
    'credit_recorded',
    'chat_started',
    'status:confirmed',
    'status:processing',
    'status:shipped',
    'status:delivered',
    'dispute_opened',
    'release_due',
  ]);
  const byKind = (k: string) => body.events.filter((e: { kind: string }) => e.kind === k);
  assert.deepEqual(
    body.events.filter((e: { kind: string }) => e.kind === 'status').map((e: { actor: string }) => e.actor),
    ['store', 'levonis', 'store', 'courier'],
    'actors are roles: the store, the admin (as Levonis), the courier'
  );
  assert.deepEqual(byKind('credit_recorded')[0].lines, [
    { kind: 'sale_gross', amount_iqd: 20000 },
    { kind: 'commission', amount_iqd: -1000 },
    { kind: 'delivery_fee', amount_iqd: 3000 },
  ]);
  const due = byKind('release_due')[0];
  assert.deepEqual([due.at, due.expected, due.frozen], ['2026-09-06T12:00:00.000Z', true, true]);
  assert.deepEqual(body.money, {
    gross_iqd: 20000, commission_iqd: -1000, delivery_fee_iqd: 3000, reversed_iqd: 0, adjustments_iqd: 0,
    net_iqd: 22000, pending_iqd: 22000, available_iqd: 0,
  });
  assert.equal(body.disputed, true);
  assert.deepEqual(body.delivery, {
    recorded: true, fulfilment: 'delivery', governorate: 'basra', rule: 'override', fee_iqd: 3000,
    base_fee_iqd: 5000, free_over_iqd: 50000, prep_days: 2, shipping_type: 'direct',
  });
  assert.deepEqual(body.items, [
    { id: 'it1', product_id: 'cp1', variant_id: 'v-red', name: 'Vase', image: null, option: 'Red / L', sku: 'VASE-R-L', qty: 2, unit_price_iqd: 10000, line_total_iqd: 20000 },
  ]);
  assert.deepEqual(body.chat, { id: 'chat1', link: '/merchant/inbox/chat1' });
  // Nothing a third party wrote, and nobody's id.
  const text = JSON.stringify(body);
  for (const secret of ['ADMIN PRIVATE NOTE', 'THE CUSTOMER TEXT', 'courier said so', 'Moved by the store', 'secret internal', '"boss"', '"buyer"']) {
    assert.ok(!text.includes(secret), `${secret} leaked`);
  }
});

test('confirmed receipt: the release is a fact (by the customer), not an expectation; the money sits in available', async () => {
  const raw = seedW2E();
  deliveredStory(raw);
  raw.exec(`
    UPDATE orders SET receipt_confirmed_at = '2026-09-04T09:00:00.000Z' WHERE id = 'ORD-T';
    UPDATE community_complaints SET status = 'resolved', resolved_at = '2026-09-05T09:00:00.000Z' WHERE id = 'cc1';
  `);
  ledger(raw, [
    ['l_r', 'ORD-T', 'release', -22000, '2026-09-04T09:00:00.000Z', 'buyer'],
    ['l_r_avail', 'ORD-T', 'release', 22000, '2026-09-04T09:00:00.000Z', 'buyer'],
  ]);
  const { body } = await timeline(raw, 'ORD-T');
  const kinds = body.events.map((e: { kind: string }) => e.kind);
  assert.deepEqual(kinds.filter((k: string) => k !== 'status'), ['placed', 'credit_recorded', 'chat_started', 'receipt_confirmed', 'credit_released', 'dispute_opened', 'dispute_closed']);
  assert.equal(kinds.includes('release_due'), false, 'confirmed: nothing is expected any more');
  const rel = body.events.find((e: { kind: string }) => e.kind === 'credit_released');
  assert.deepEqual([rel.amount_iqd, rel.actor], [22000, 'customer']);
  assert.ok(kinds.indexOf('receipt_confirmed') < kinds.indexOf('credit_released'));
  assert.ok(kinds.indexOf('dispute_opened') < kinds.indexOf('dispute_closed'));
  assert.equal(body.money.available_iqd, 22000);
  assert.equal(body.money.pending_iqd, 0);
  assert.equal(body.money.net_iqd, 22000, 'the release pair nets to zero');
  assert.equal(body.credit_state, 'available');
});

test('a cancelled order: the one cancellation, the reversal lines and the customer refund — each once', async () => {
  const raw = seedW2E();
  addOrder(raw, { id: 'ORD-X', at: '2026-09-01T08:00:00.000Z', total: 10000, status: 'cancelled' });
  raw.exec(`
    INSERT INTO order_status_history (id, order_id, stage, status, source, changed_at, changed_by, note)
      VALUES ('osh_cancel_ORD-X','ORD-X','cancelled','cancelled','manual','2026-09-01T11:00:00.000Z','buyer','Cancelled by the customer: changed my mind');
    INSERT INTO wallet_transactions (id, user_id, type, amount, currency, status, ref, created_at)
      VALUES ('wtx_refund_ORD-X_usd','buyer','deposit',700,'USD','approved','ORD-X','2026-09-01T11:00:00.000Z');
  `);
  ledger(raw, [
    ['x_g', 'ORD-X', 'sale_gross', 10000, '2026-09-01T08:00:00.000Z', null],
    ['x_c', 'ORD-X', 'commission', -500, '2026-09-01T08:00:00.000Z', null],
    ['x_rf', 'ORD-X', 'refund', -10000, '2026-09-01T11:00:00.000Z', null],
    ['x_cr', 'ORD-X', 'commission_refund', 500, '2026-09-01T11:00:00.000Z', null],
  ]);
  const { status, body } = await timeline(raw, 'ORD-X');
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.events.map((e: { kind: string }) => e.kind), ['placed', 'credit_recorded', 'cancelled', 'credit_reversed', 'refunded']);
  assert.equal(body.events[2].actor, 'customer');
  assert.equal(body.money.net_iqd, 0);
  assert.equal(body.delivery.recorded, false, 'an order before delivery by governorate says so');
  assert.equal(body.delivery.rule, null);
  assert.ok(!JSON.stringify(body).includes('changed my mind'));
});

test('another store\'s order, a made-up id and a path-like id are the same 404; an order without ledger lines has no money block', async () => {
  const raw = seedW2E();
  deliveredStory(raw);
  addOrder(raw, { id: 'ORD-Z', merchant: 'm2', store: 's2' });
  const theirs = await timeline(raw, 'ORD-Z');
  const mine = await timeline(raw, 'ORD-T', OWNER2);
  const none = await timeline(raw, 'NOPE');
  for (const r of [theirs, mine, none]) assert.deepEqual([r.status, r.body.code], [404, 'ORDER_NOT_FOUND']);
  assert.equal((await timeline(raw, 'ORD-Z', OWNER2)).status, 200);
  assert.equal('money' in (await timeline(raw, 'ORD-Z', OWNER2)).body, false, 'no ledger lines: absent, not zeros');
  assert.deepEqual((await timeline(raw, 'bad%20id')).body.code, 'ORDER_NOT_FOUND', 'an id outside the contract shape is not even looked up');
});

test('the chat is offered only when the owner is IN it', async () => {
  const raw = seedW2E();
  deliveredStory(raw);
  raw.exec(`DELETE FROM chat_participants WHERE chat_id = 'chat1' AND user_id = 'owner'`);
  const { body } = await timeline(raw, 'ORD-T');
  assert.equal('chat' in body, false);
  assert.equal(body.events.some((e: { kind: string }) => e.kind === 'chat_started'), false);
});

// ------------------------------------------------------------------ pure logic

const base = (over: Partial<TimelineInput> = {}): TimelineInput => ({
  order: { id: 'O', user_id: 'cust', status: 'pending', created_at: '2026-09-01T00:00:00.000Z', delivered_at: null, receipt_confirmed_at: null, total_iqd: 1000 },
  ownerUserId: 'own',
  history: [],
  adminMoves: [],
  ledger: [],
  refundAt: null,
  disputes: [],
  chatAt: null,
  creditState: null,
  ...over,
});

test('buildOrderTimeline: ties at one instant follow the real order; unknown statuses and the placement row are not repeated', () => {
  const at = '2026-09-01T00:00:00.000Z';
  const ev = buildOrderTimeline(
    base({
      history: [
        { id: 'p', stage: 'placed', status: 'pending', source: 'automatic', changed_at: at, changed_by: '' },
        { id: 'w', stage: 'weird', status: 'teleported', source: 'manual', changed_at: at, changed_by: 'own' },
        { id: 'c', stage: 'confirmed', status: 'confirmed', source: 'automatic', changed_at: at, changed_by: '' },
      ],
      ledger: [{ id: 'g', kind: 'sale_gross', bucket: 'pending', amount_iqd: 1000, created_at: at, created_by: null }],
      adminMoves: [{ detail: '{"to":"delivered; DROP"}', created_at: at }, { detail: 'not json', created_at: at }],
    })
  );
  assert.deepEqual(ev.map((e) => e.kind), ['placed', 'credit_recorded', 'status']);
  assert.equal((ev[2] as { actor: string }).actor, 'system');
});

test('buildOrderTimeline: the expected release needs delivered + pending + no receipt; it is always last', () => {
  const delivered = { ...base().order, status: 'delivered', delivered_at: '2026-09-02T00:00:00.000Z' };
  assert.equal(buildOrderTimeline(base({ order: delivered, creditState: 'pending' })).at(-1)!.kind, 'release_due');
  assert.equal(buildOrderTimeline(base({ order: delivered, creditState: 'available' })).some((e) => e.kind === 'release_due'), false);
  assert.equal(
    buildOrderTimeline(base({ order: { ...delivered, receipt_confirmed_at: '2026-09-02T01:00:00.000Z' }, creditState: 'pending' })).some((e) => e.kind === 'release_due'),
    false
  );
  // A later real event never lands after the expectation.
  const ev = buildOrderTimeline(base({ order: delivered, creditState: 'pending', chatAt: '2027-01-01T00:00:00.000Z' }));
  assert.equal(ev.at(-1)!.kind, 'release_due');
});

test('orderMoney: absent without lines; the release pair nets to zero; an adjustment counts', () => {
  assert.equal(orderMoney([]), null);
  const m = orderMoney([
    { id: '1', kind: 'sale_gross', bucket: 'pending', amount_iqd: 100, created_at: 'a', created_by: null },
    { id: '2', kind: 'release', bucket: 'pending', amount_iqd: -100, created_at: 'b', created_by: null },
    { id: '3', kind: 'release', bucket: 'available', amount_iqd: 100, created_at: 'b', created_by: null },
    { id: '4', kind: 'adjustment', bucket: 'available', amount_iqd: -10, created_at: 'c', created_by: null },
  ])!;
  assert.deepEqual([m.net_iqd, m.pending_iqd, m.available_iqd, m.adjustments_iqd], [90, 0, 90, -10]);
});
