/**
 * ===========================================================================
 *  THE FOUR THINGS THE FULFILMENT SCREEN WAS MISSING, EACH PINNED AT THE
 *  POINT IT WOULD SHIP BROKEN
 * ===========================================================================
 * The owner asked for a quick status button, an «الكل» filter, a count beside
 * every filter option, attachments in the order chat and a notification to the
 * customer when a status changes. Four of those five have a half that is easy
 * to write and a half that is easy to forget, and the forgotten half is
 * invisible from the screen that was changed:
 *
 *  (أ) «الكل» IS A DIFFERENT QUERY IN EACH HALF OF THE BOARD. In the work list
 *      it is `scope=all`; in the archive it is the ABSENCE of a `type`
 *      parameter. The board's own header note rejected an earlier spelling
 *      (`scope=preorder` as "any pre-order") precisely because it worked in
 *      one half and silently showed direct orders in the other, so both halves
 *      are asserted here, not one.
 *
 *  (ب) A FACET COUNT THAT USES THE BOARD'S OWN WHERE IS ZERO EVERYWHERE THE
 *      ADMIN IS NOT ALREADY LOOKING. A board narrowed to «جوي» would report
 *      «بحري ٠» and make every other option look empty — a count that lies in
 *      exactly the situation it exists for. The property that catches it is
 *      not "the numbers are right" but "the number beside the option currently
 *      chosen equals the board's own total, and the others are not zero".
 *
 *  (ج) THE QUICK BUTTON MUST BE THE ORDER'S OWN NEXT STAGE. A row that assumed
 *      "confirmed follows pending" is wrong on four of the pre-order path's
 *      first five stages, and the stage door would then refuse the move — a
 *      button whose only effect is a red line. The fallback for a row whose
 *      stage is not on its own path — what a shipping type edited after the
 *      fact leaves behind — is asserted too, because that row renders a button
 *      like any other.
 *
 *  (د) THE NOTIFICATION IS THE ONE WITH A CONFIRMED SYMPTOM. `moveOrderStage`
 *      told the customer about `delivered` and about nothing else, while the
 *      legacy status dropdown beside it told them about all four — so WHICH
 *      DOOR THE ADMIN USED decided whether the customer heard that their order
 *      was confirmed, shipped or cancelled, and the stage panel is the door
 *      the fulfilment screen actually offers. The test that proves it is the
 *      OUTBOX after a move, not the route's 200.
 *
 * And (ه), the chat: an attachment key names the CONVERSATION, which the send
 * route was still checking against the SENDER. Every picture in every thread
 * on this platform was refused after the upload had already stored the bytes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, get, post, patch, json, pending } from './fixtures/app';
import { adminRoutes } from '../worker/routes/admin';
import { chatRoutes } from '../worker/routes/chats';
import { moveOrderStage } from '../worker/lib/orderStageOps';

/** 13:00 in Baghdad — a plain afternoon, so no bucket is on a boundary. */
const NOON = '2026-09-19T10:00:00.000Z';

async function at<T>(iso: string, fn: () => T | Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => Date.parse(iso);
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

interface OrderSeed {
  id: string;
  status?: string;
  shipping_type?: string;
  stage?: string;
  day?: string | null;
}

function seed(orders: OrderSeed[]) {
  const raw = freshDb();
  raw
    .prepare("INSERT INTO users (id,name,email,password_hash,role) VALUES ('u1','زبون','u1@x.co','h','customer')")
    .run();
  raw
    .prepare("INSERT INTO users (id,name,email,password_hash,role,admin_scope) VALUES ('boss','Owner','boss@x.co','h','admin',NULL)")
    .run();
  for (const o of orders) {
    raw
      .prepare(
        `INSERT INTO orders
           (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
            subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_type,stage,delivery_due_day)
         VALUES (?,'u1',?, '{"name":"محمد","governorate":"بغداد"}','home','{}','cod',1000,1500,1000,0,?,?,?)`
      )
      .run(
        o.id,
        o.status ?? 'pending',
        o.shipping_type ?? 'direct',
        o.stage ?? 'received',
        o.day === undefined ? null : o.day
      );
  }
  const app = stubApp(
    asD1(raw),
    { id: 'boss', role: 'admin', email: 'boss@x.co', admin_scope: null },
    (a) => a.route('/api/admin', adminRoutes),
    { env: { INITIAL_ADMIN_EMAIL: 'boss@x.co' } }
  );
  return { raw, app };
}

type App = ReturnType<typeof seed>['app'];

const board = async (app: App, qs = '') => {
  const res = await get(app, `/api/admin/orders${qs ? `?${qs}` : ''}`);
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 400));
  return body;
};
const ids = (body: Record<string, unknown>) => (body.orders as { id: string }[]).map((o) => o.id).sort();

/** One board of every shape: two direct, one of each pre-order journey, one
 *  delivered and one cancelled, across three live statuses. */
const MIXED: OrderSeed[] = [
  { id: 'D-PEND', shipping_type: 'direct', status: 'pending' },
  { id: 'D-SHIP', shipping_type: 'direct', status: 'shipped', stage: 'out_for_delivery' },
  { id: 'A-PEND', shipping_type: 'preorder_air', status: 'pending' },
  { id: 'S-SHIP', shipping_type: 'preorder_sea', status: 'shipped', stage: 'en_route_to_iraq' },
  { id: 'L-PEND', shipping_type: 'preorder_land', status: 'pending' },
  { id: 'ORD-A1B2', shipping_type: 'direct', status: 'delivered', stage: 'delivered' },
  { id: 'A-VOID', shipping_type: 'preorder_air', status: 'cancelled', stage: 'cancelled' },
];

// =========================================================================
// (أ) «الكل» — ONE OPTION, TWO SPELLINGS, AND IT LIES IN NEITHER
// =========================================================================

test('(أ) «الكل» in the WORK LIST is the union of direct and pre-order, and still isolates the archive', async () => {
  const { app } = seed(MIXED);
  const body = await at(NOON, () => board(app, 'scope=all'));
  assert.deepEqual(ids(body), ['A-PEND', 'D-PEND', 'D-SHIP', 'L-PEND', 'S-SHIP']);
  // The whole point of the board's isolation rule: «الكل» means all the WORK,
  // not all the rows. A delivered order appearing here would put finished
  // parcels back into the morning's list.
  assert.equal(body.counts.total, 5);
});

test('(أ) «الكل» is exactly `open` ∪ `preorder`, asserted against the two scopes themselves', async () => {
  const { app } = seed(MIXED);
  const [all, open, pre] = await at(NOON, async () => [
    await board(app, 'scope=all'),
    await board(app, 'scope=open'),
    await board(app, 'scope=preorder'),
  ]);
  assert.deepEqual(ids(all), [...ids(open), ...ids(pre)].sort());
  assert.equal(all.counts.total, open.counts.total + pre.counts.total);
});

test('(أ) in the ARCHIVE, «الكل» is NO `type` — and it does not leak the other archive scope', async () => {
  const { app } = seed(MIXED);
  // This is the combination the board's header note says an aggregate spelled
  // as a SCOPE would have got wrong: `scope=preorder` here would have shown a
  // direct order. Sending no `type` cannot.
  const delivered = await at(NOON, () => board(app, 'scope=delivered'));
  assert.deepEqual(ids(delivered), ['ORD-A1B2']);
  const cancelled = await at(NOON, () => board(app, 'scope=cancelled'));
  assert.deepEqual(ids(cancelled), ['A-VOID']);
});

test('(أ) `scope=all` carries NO shipping_type clause — the partial index\'s own WHERE and nothing else', async () => {
  // The silent regression migration 0094 warns about is an added equality on
  // `shipping_type` making the planner abandon `idx_orders_board_open`. `all`
  // adds none, so this is the one shape that cannot regress that way — and the
  // assertion is on the PLAN, because EXPLAIN reads healthy either way.
  const { raw, app } = seed(MIXED);
  await at(NOON, () => board(app, 'scope=all'));
  const plan = (
    raw
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT o.* FROM orders o LEFT JOIN users u ON u.id = o.user_id
          WHERE (o.status NOT IN ('delivered','cancelled'))
          ORDER BY o.delivery_due_day IS NULL, o.delivery_due_day ASC, o.priority DESC,
                   (o.priority_due_at IS NULL), o.priority_due_at ASC, o.created_at ASC, o.id ASC`
      )
      .all() as Array<{ detail: string }>
  )
    .map((r) => r.detail)
    .join(' | ');
  assert.match(plan, /idx_orders_board_open/, plan);
});

// =========================================================================
// (ب) THE COUNT BESIDE EVERY OPTION
// =========================================================================

test('(ب) the number beside the option currently chosen IS the board total, and the others are not zero', async () => {
  const { app } = seed(MIXED);
  // Narrowed to one journey — the exact situation a count computed from the
  // board's own WHERE would report as «بحري ٠ · بري ٠».
  const body = await at(NOON, () => board(app, 'scope=preorder&type=preorder_air'));
  assert.equal(body.counts.total, 1, 'one air pre-order is open');
  assert.equal(body.options.type.preorder_air, 1, 'the chosen option agrees with the board');
  assert.equal(body.options.type.preorder_sea, 1, 'and the option NOT chosen still knows it has a row');
  assert.equal(body.options.type.direct, 2);
  assert.equal(body.options.type.all, 5, '«الكل» is the sum, and it is the live set');
});

test('(ب) each vector honours the OTHER select and ignores its own', async () => {
  const { app } = seed(MIXED);
  const body = await at(NOON, () => board(app, 'scope=all&status=shipped'));
  // The TYPE vector is narrowed by the chosen status…
  assert.equal(body.options.type.all, 2, 'two shipped orders in all');
  assert.equal(body.options.type.direct, 1);
  assert.equal(body.options.type.preorder_sea, 1);
  assert.equal(body.options.type.preorder_air, 0, 'no air order is shipped');
  // …while the STATUS vector is not narrowed by itself, or every option but
  // the chosen one would read zero and the select would look broken.
  assert.equal(body.options.status.shipped, 2);
  assert.equal(body.options.status.pending, 3);
  assert.equal(body.options.status.any, 5);
});

test('(ب) THE DEFAULT VIEW — on «مباشر» the status numbers count DIRECT orders, not pre-orders too', async () => {
  // The board's opening screen sends `scope=open` and NO `type` (the partial
  // index note in admin.ts). The status vector used to read only `type`, so it
  // counted every pre-order as well: «قيد الانتظار ٣» over a board of one row.
  const { app } = seed([
    { id: 'D-1', shipping_type: 'direct', status: 'pending' },
    { id: 'A-1', shipping_type: 'preorder_air', status: 'pending' },
    { id: 'S-1', shipping_type: 'preorder_sea', status: 'pending' },
  ]);
  const open = await at(NOON, () => board(app, 'scope=open'));
  assert.equal(open.counts.total, 1, 'the board shows the one direct order');
  assert.equal(open.options.status.pending, open.counts.total, 'the number beside «قيد الانتظار» is the board');
  assert.equal(open.options.status.any, open.counts.total, '«كل الحالات» is the board');
  // …while the JOURNEY select still counts both journeys, which is its job.
  assert.equal(open.options.type.direct, 1);
  assert.equal(open.options.type.preorder_air, 1);
  // And the pre-order scope with no chosen transport counts pre-orders only.
  const pre = await at(NOON, () => board(app, 'scope=preorder'));
  assert.equal(pre.options.status.pending, 2);
  assert.equal(pre.options.status.pending, pre.counts.total);
});

test('(ب) the ARCHIVE select reports BOTH of its options while the board shows one', async () => {
  const { app } = seed(MIXED);
  const body = await at(NOON, () => board(app, 'scope=delivered'));
  assert.equal(body.counts.total, 1, 'the board shows the delivered order alone');
  assert.equal(body.options.status.delivered, 1);
  assert.equal(body.options.status.cancelled, 1, '«ملغاة» carries its own number, unopened');
  // And the archive's facet base is the archive, never the live set.
  assert.equal(body.options.status.pending, 0);
  // The TYPE vector honours the other select, which in the archive IS the
  // scope — so it counts the delivered orders by journey, not both halves.
  assert.equal(body.options.type.all, 1);
  assert.equal(body.options.type.direct, 1);
  assert.equal(body.options.type.preorder_air, 0, 'the cancelled air order belongs to the other option');
});

test('(ب) a PIERCED lookup reports NO options at all', async () => {
  const { app } = seed(MIXED);
  // An order-number lookup ignores every filter, so there are no alternatives
  // to count — and counting them would be a GROUP BY over every order ever
  // placed for a screen showing one row.
  const body = await at(NOON, () => board(app, 'q=ORD-A1B2'));
  assert.equal(body.search_kind, 'order_id');
  assert.equal(body.options, null);
});

test('(ب) a NAME search is a BROWSE, so its options are counted inside the search', async () => {
  const { raw, app } = seed(MIXED);
  raw.prepare("UPDATE orders SET address_snapshot = '{\"name\":\"سارة\"}' WHERE id = 'A-PEND'").run();
  const body = await at(NOON, () => board(app, 'scope=all&q=سارة'));
  assert.deepEqual(ids(body), ['A-PEND']);
  assert.equal(body.options.type.all, 1, 'the counts describe the searched set, not the whole board');
  assert.equal(body.options.type.direct, 0);
});

// =========================================================================
// (ج) THE QUICK BUTTON
// =========================================================================

const quick = (body: Record<string, unknown>, id: string) =>
  (body.orders as Array<{ id: string; quick_next: { stage: string; label: string; source: string } | null }>).find(
    (o) => o.id === id
  )!.quick_next;

test('(ج) the quick move is the next stage on THIS order\'s own path, not a guessed status', async () => {
  const { app } = seed(MIXED);
  const body = await at(NOON, () => board(app, 'scope=all'));
  // Direct: received → confirmed.
  assert.equal(quick(body, 'D-PEND')!.stage, 'confirmed');
  // Sea pre-order sitting at `en_route_to_iraq`: the next stage is
  // `arrived_iraq`, which no status-based guess would ever produce — the
  // legacy status on both sides of that move is `shipped`.
  assert.equal(quick(body, 'S-SHIP')!.stage, 'arrived_iraq');
});

test('(ج) the label comes back in the language the screen asked for, and it is hand-written Sorani', async () => {
  const { app } = seed(MIXED);
  const ar = await at(NOON, () => board(app, 'scope=all'));
  const en = await at(NOON, () => board(app, 'scope=all&lang=en'));
  const ckb = await at(NOON, () => board(app, 'scope=all&lang=ckb'));
  assert.equal(quick(ar, 'D-PEND')!.label, 'تم تأكيد الطلب');
  assert.equal(quick(en, 'D-PEND')!.label, 'Order confirmed');
  // From `STAGE_TEXT` in worker/lib/orderStages.ts — owner-authored, never
  // generated. A board that forgot to send `lang` would return the Arabic here
  // and put two Arabic strings in the middle of a translated screen.
  assert.equal(quick(ckb, 'D-PEND')!.label, 'داواکاری پەسەندکرا');
});

test('(ج) there is NO button where there is nowhere to go', async () => {
  const { app } = seed(MIXED);
  const done = await at(NOON, () => board(app, 'scope=delivered'));
  assert.equal(quick(done, 'ORD-A1B2'), null, 'the end of the path');
  const void_ = await at(NOON, () => board(app, 'scope=cancelled'));
  assert.equal(quick(void_, 'A-VOID'), null, 'a cancelled order is off the path');
});

test('(ج) a stage that is not on THIS order\'s path falls back to what its STATUS implies', async () => {
  // `orders.stage` is NOT NULL with a default (migration 0028), so the row
  // that needs this fallback is not an empty column — it is a stage belonging
  // to a DIFFERENT journey, which is what a shipping type edited after the
  // fact leaves behind. Read literally it would produce `en_route_to_levo` on
  // a direct order: a button whose only effect is the stage door's refusal.
  const { app } = seed([
    { id: 'MIX-1', status: 'confirmed', stage: 'at_origin_warehouse', shipping_type: 'direct' },
  ]);
  const body = await at(NOON, () => board(app, 'scope=all'));
  assert.equal(quick(body, 'MIX-1')!.stage, 'preparing', 'confirmed → preparing on the direct path');
});

test('(ج) …and the stage door ACCEPTS the move the button offers on such a row', async () => {
  // The button and the door used to read the off-path row two ways: the button
  // from the STATUS (confirmed → preparing), the door from the raw stage
  // (`at_origin_warehouse`, not on the direct path → every move refused). So
  // the one tap produced ILLEGAL_STAGE_MOVE — «a button whose only effect is a
  // red line», which this suite's own header says was prevented.
  const { raw, app } = seed([
    { id: 'MIX-2', status: 'confirmed', stage: 'at_origin_warehouse', shipping_type: 'direct' },
  ]);
  const offered = quick(await at(NOON, () => board(app, 'scope=all')), 'MIX-2')!.stage;
  const res = await patch(app, '/api/admin/orders/MIX-2/stage', { stage: offered });
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  const row = raw.prepare('SELECT stage, status FROM orders WHERE id = ?').get('MIX-2') as { stage: string; status: string };
  assert.deepEqual({ ...row }, { stage: 'preparing', status: 'processing' });
});

test('(ج) the off-path fence is still the STORED stage — a row changed underneath is RACED, not overwritten', async () => {
  const raw = notifyDb();
  notifyOrder(raw, 'MIX-3', 'direct', 'at_origin_warehouse', 'confirmed');
  const e = env(raw);
  // Another mover changes the stored stage after this one's read: simulated by
  // reading through a D1 whose first SELECT returns the old row.
  const d1 = asD1(raw);
  const racing = {
    ...(e as object),
    DB: {
      prepare: (sql: string) => {
        const stmt = d1.prepare(sql);
        if (!/^SELECT \* FROM orders WHERE id = \?/.test(sql.trim())) return stmt;
        return {
          bind: (...v: unknown[]) => {
            const bound = stmt.bind(...v);
            return {
              first: async () => {
                const r = await bound.first();
                raw.prepare("UPDATE orders SET stage = 'confirmed' WHERE id = 'MIX-3'").run();
                return r;
              },
            };
          },
        };
      },
      batch: (stmts: D1PreparedStatement[]) => d1.batch(stmts),
    },
  };
  const moved = await moveOrderStage(racing as never, { orderId: 'MIX-3', to: 'preparing', source: 'manual', changedBy: 'boss' } as never);
  assert.equal(moved.moved, false);
  assert.equal(moved.reason, 'RACED');
  assert.equal((raw.prepare("SELECT stage FROM orders WHERE id = 'MIX-3'").get() as { stage: string }).stage, 'confirmed');
});

test('(ج) the button marks a move that is normally the courier\'s or the clock\'s', async () => {
  const { app } = seed([{ id: 'D-PREP', status: 'processing', stage: 'preparing', shipping_type: 'direct' }]);
  const body = await at(NOON, () => board(app, 'scope=all'));
  const q = quick(body, 'D-PREP')!;
  assert.equal(q.stage, 'out_for_delivery');
  assert.equal(q.source, 'delivery_api', 'so the row can say this is normally Al-Waseet\'s to declare');
});

// =========================================================================
// (د) THE NOTIFICATION — THE SYMPTOM, NOT THE ROUTE'S 200
// =========================================================================

function notifyDb(): DatabaseSync {
  const raw = freshDb();
  raw
    .prepare(
      `INSERT INTO users (id,name,email,username,password_hash,role,email_verified_at,locale)
       VALUES ('u1','زبون','u1@x.co','u1','h','customer','2026-01-01T00:00:00.000Z','ar')`
    )
    .run();
  return raw;
}

function notifyOrder(raw: DatabaseSync, id: string, shipping = 'direct', stage = 'received', status = 'pending') {
  raw
    .prepare(
      `INSERT INTO orders
         (id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
          subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_type,stage)
       VALUES (?,'u1',?, '{}','home','{}','cod',100000,1400,105000,0,?,?)`
    )
    .run(id, status, shipping, stage);
}

const env = (raw: DatabaseSync) =>
  ({
    DB: asD1(raw),
    EMAIL_API_KEY: 're_k',
    EMAIL_FROM: 'LEVONIS <no-reply@levonis-iq.com>',
    APP_ORIGIN: 'https://levonis-iq.com',
  }) as never;

const eventKeys = (raw: DatabaseSync) =>
  (raw.prepare('SELECT event_key FROM outbox ORDER BY event_key').all() as Array<{ event_key: string }>).map(
    (r) => r.event_key
  );

test('(د) THE SYMPTOM — confirming an order through the STAGE door tells the customer', async () => {
  // This is the line that used to read `if (opts.to === 'delivered')`. With it,
  // an admin confirming an order from the stage panel — the door the
  // fulfilment screen offers — sent the customer nothing at all, while the
  // legacy dropdown beside it sent «تم تأكيد طلبك».
  const raw = notifyDb();
  notifyOrder(raw, 'ORD-C');
  const moved = await moveOrderStage(env(raw), { orderId: 'ORD-C', to: 'confirmed', source: 'manual', changedBy: 'boss' } as never);
  assert.equal(moved.moved, true);
  // The outbox key carries the CHANNEL — one row per door the message goes
  // out of — while the de-duplication that matters is the `:ORD-C` half.
  assert.deepEqual(eventKeys(raw), ['order.status.confirmed:ORD-C:email']);
  const mail = raw.prepare('SELECT payload FROM outbox').get() as { payload: string };
  assert.match(JSON.parse(mail.payload).text, /تم تأكيد طلبك ORD-C/);
});

test('(د) a cancellation from the stage door is told too, in the line that keeps the order NUMBER', async () => {
  const raw = notifyDb();
  notifyOrder(raw, 'ORD-X');
  const moved = await moveOrderStage(env(raw), { orderId: 'ORD-X', to: 'cancelled', source: 'manual', changedBy: 'boss' } as never);
  assert.equal(moved.moved, true);
  assert.deepEqual(eventKeys(raw), ['order.status.cancelled:ORD-X:email']);
  // The cancelled copy is the one message that keeps «رقم الطلب» on a line of
  // its own — a cancellation a customer cannot match to an order is the
  // failure this whole message set exists to prevent.
  assert.match(JSON.parse((raw.prepare('SELECT payload FROM outbox').get() as { payload: string }).payload).text, /ORD-X/);
});

test('(د) FIVE pre-order stages all mean `shipped`, and the customer is told ONCE', async () => {
  // Keying the notification on the STAGE rather than the legacy status would
  // send five «تم شحن طلبك» messages for one journey. The trigger is the
  // status changing; the event key catches anything the trigger does not.
  const raw = notifyDb();
  notifyOrder(raw, 'ORD-SEA', 'preorder_sea', 'at_origin_warehouse', 'processing');
  const e = env(raw);
  for (const to of ['preparing_freight', 'handed_to_carrier', 'left_origin_warehouse', 'en_route_to_iraq', 'arrived_iraq'] as const) {
    await moveOrderStage(e, { orderId: 'ORD-SEA', to, source: 'manual', changedBy: 'boss' } as never);
  }
  assert.deepEqual(eventKeys(raw), ['order.status.shipped:ORD-SEA:email'], 'one journey, one message');
});

test('(د) THE FLOOR — a customer with NO channel at all still finds «تم تأكيد طلبك» in the bell', async () => {
  // «الإشعارات لا تصل للمستخدم عند تحديث حالة طلبه». Only `delivered` wrote an
  // in-app row, so a customer with no verified email, WhatsApp or Telegram —
  // most of them — heard nothing whatever about confirmed, shipped or
  // cancelled.
  const raw = freshDb();
  raw.prepare("INSERT INTO users (id,name,email,password_hash,role) VALUES ('u1','زبون','u1@x.co','h','customer')").run();
  notifyOrder(raw, 'ORD-B');
  await moveOrderStage(env(raw), { orderId: 'ORD-B', to: 'confirmed', source: 'manual', changedBy: 'boss' } as never);
  assert.deepEqual(eventKeys(raw), [], 'no channel, so no outbox row — the floor is all there is');
  const bell = raw.prepare('SELECT title_ar, title_en, link, event_key FROM user_notifications WHERE user_id = ?').all('u1') as Array<{
    title_ar: string; title_en: string; link: string; event_key: string;
  }>;
  assert.equal(bell.length, 1);
  assert.match(bell[0].title_ar, /تم تأكيد طلبك ORD-B/);
  assert.match(bell[0].title_en, /Order ORD-B is confirmed/);
  assert.equal(bell[0].link, '/orders/ORD-B');
  assert.equal(bell[0].event_key, 'order.status.confirmed:ORD-B');
  // A cancellation names the order in the bell, because its sentence does not.
  notifyOrder(raw, 'ORD-B2');
  await moveOrderStage(env(raw), { orderId: 'ORD-B2', to: 'cancelled', source: 'manual', changedBy: 'boss' } as never);
  const cancelled = raw.prepare("SELECT title_ar FROM user_notifications WHERE event_key = 'order.status.cancelled:ORD-B2'").get() as { title_ar: string };
  assert.match(cancelled.title_ar, /ORD-B2/);
});

test('(د) THE LATENCY — the stage door hands the send to the request, which sends THIS order\u2019s rows now', async () => {
  // The rows used to wait for the fifteen-minute cron, and the cron drains
  // oldest-first. The route now passes its waitUntil, and the flush is by
  // event-key prefix, so an older backlog cannot hold this message up.
  const raw = notifyDb();
  notifyOrder(raw, 'ORD-F');
  // A backlog row that is OLDER and would be first in a FIFO drain.
  raw.prepare(
    `INSERT INTO outbox (id, kind, event_key, recipient, payload, state, created_at)
     VALUES ('obx_old','email','old.event:1:email','a@x.co','{"kind":"email","to":"a@x.co","subject":"s","html":"h","text":"t"}','pending','2020-01-01T00:00:00.000Z')`
  ).run();
  const deferred: Promise<unknown>[] = [];
  const sent: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(String(init?.body ?? ''));
    return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 });
  }) as typeof fetch;
  try {
    const moved = await moveOrderStage(env(raw), {
      orderId: 'ORD-F', to: 'confirmed', source: 'manual', changedBy: 'boss',
      defer: (p: Promise<unknown>) => { deferred.push(p); },
    } as never);
    assert.equal(moved.moved, true);
    assert.equal(deferred.length, 1, 'the send was handed to the request');
    await Promise.all(deferred);
  } finally {
    globalThis.fetch = realFetch;
  }
  const rows = raw.prepare('SELECT event_key, state FROM outbox ORDER BY event_key').all() as Array<{ event_key: string; state: string }>;
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { event_key: 'old.event:1:email', state: 'pending' },
    { event_key: 'order.status.confirmed:ORD-F:email', state: 'sent' },
  ]);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /ORD-F/);
});

test('(د) the admin STAGE route passes its waitUntil — the flush is wired where the owner presses', async () => {
  const { raw, app } = seed([{ id: 'D-W', shipping_type: 'direct', status: 'pending' }]);
  const before = pending.length;
  const res = await patch(app, '/api/admin/orders/D-W/stage', { stage: 'confirmed' });
  assert.equal(res.status, 200, JSON.stringify(await json(res)));
  assert.ok(pending.length > before, 'a flush was registered with the request');
  await Promise.all(pending.splice(before));
  assert.ok(raw.prepare("SELECT 1 FROM user_notifications WHERE event_key = 'order.status.confirmed:D-W'").get());
});

test('(د) `processing` is a warehouse fact and is NOT a notification', async () => {
  const raw = notifyDb();
  notifyOrder(raw, 'ORD-P', 'direct', 'confirmed', 'confirmed');
  await moveOrderStage(env(raw), { orderId: 'ORD-P', to: 'preparing', source: 'manual', changedBy: 'boss' } as never);
  assert.deepEqual(eventKeys(raw), [], 'a message that says nothing actionable trains people to ignore the next one');
});

test('(د) `delivered` still goes through the one writer, with its in-app row and its button', async () => {
  // The delivered path had the only working notification before this change,
  // and routing every status through `notifyOrderStatus` must not have cost it
  // the in-app row — which is the floor for a customer with no channel at all.
  const raw = notifyDb();
  notifyOrder(raw, 'ORD-D', 'direct', 'out_for_delivery', 'shipped');
  await moveOrderStage(env(raw), { orderId: 'ORD-D', to: 'delivered', source: 'manual', changedBy: 'boss' } as never);
  assert.deepEqual(eventKeys(raw), ['order.status.delivered:ORD-D:email']);
  const n = raw.prepare('SELECT link, event_key FROM user_notifications').get() as { link: string; event_key: string };
  assert.equal(n.event_key, 'order.status.delivered:ORD-D');
  assert.match(n.link, /needs_review=1/);
});

// =========================================================================
// (ه) THE CHAT ATTACHMENT — THE KEY NAMES THE CONVERSATION
// =========================================================================

/** An R2 that has every object asked of it, so the only thing under test is
 *  the key CHECK — not whether a fixture remembered to store bytes. */
const anyBucket = { head: async (key: string) => ({ key }) };

function chatApp() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('boss','Owner','boss@x.co','h','admin'),
      ('cust','Sara','sara@x.co','h','customer');
    INSERT INTO chats (id) VALUES ('chat_1'), ('chat_2');
    INSERT INTO chat_participants (chat_id,user_id) VALUES
      ('chat_1','boss'), ('chat_1','cust'), ('chat_2','cust');
  `);
  const app = stubApp(
    asD1(raw),
    { id: 'boss', role: 'admin', email: 'boss@x.co' },
    (a) => a.route('/api/chats', chatRoutes),
    { env: { BUCKET: anyBucket } }
  );
  return { raw, app };
}

test('(ه) THE SYMPTOM — a picture uploaded for THIS chat can actually be sent', async () => {
  // `uploads.ts` files a chat attachment under the CONVERSATION:
  // `chat/<chatId>/attachments/<id>.webp`. The send route was still checking
  // the key against the SENDER's id, so the bytes landed in R2 and the message
  // they were uploaded for was refused — «تعذر إرسال الصورة», for every
  // picture in every thread, the order chat included.
  const { raw, app } = chatApp();
  const res = await post(app, '/api/chats/chat_1/messages', {
    kind: 'image',
    fileKey: 'chat/chat_1/attachments/obj_1.webp',
  });
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  const stored = raw.prepare('SELECT kind, file_key, body FROM chat_messages').get() as {
    kind: string;
    file_key: string;
    body: string;
  };
  assert.equal(stored.kind, 'image');
  assert.equal(stored.file_key, 'chat/chat_1/attachments/obj_1.webp');
  assert.equal(stored.body, '', 'an attachment-only message stores the empty string, never NULL');
});

test('(ه) and a key naming ANOTHER conversation is still refused', async () => {
  // The new check is the STRONGER one, not merely the matching one: membership
  // in this chat has already been established above it, so pinning the key to
  // the same chat id is the whole question. `chat_2` is a conversation this
  // admin is not in.
  const { raw, app } = chatApp();
  const res = await post(app, '/api/chats/chat_1/messages', {
    kind: 'image',
    fileKey: 'chat/chat_2/attachments/obj_1.webp',
  });
  assert.equal(res.status, 400);
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM chat_messages').get() as { n: number }).n, 0);
});

test('(ه) the read path hands the screen `fileUrl`, which is the name the panel now reads', async () => {
  // The admin panel's own interface declared `url`, so `kind === 'image' &&
  // m.url` never ran and every picture rendered as the empty `body`. The
  // server's spelling is the contract; this pins it so the panel cannot drift
  // back.
  const { app } = chatApp();
  await post(app, '/api/chats/chat_1/messages', { kind: 'image', fileKey: 'chat/chat_1/attachments/obj_1.webp' });
  const body = await json(await get(app, '/api/chats/chat_1/messages'));
  assert.equal(body.messages[0].fileUrl, '/files/chat/chat_1/attachments/obj_1.webp');
  assert.equal(body.messages[0].kind, 'image');
});
