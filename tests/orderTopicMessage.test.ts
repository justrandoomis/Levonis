/**
 * WHAT THE OWNER ACTUALLY SEES WHEN AN ORDER LANDS IN «📝 Orders».
 *
 * THE SYMPTOM THIS PINS. The order notification was one English template
 * literal written inline at the checkout call site, and it emitted seven facts:
 * an id, a username, «Items: 3», a total, one due line and a fulfilment token.
 * No product name. No option, no colour, no per-line quantity. No transport, no
 * customer name, no area. So the message could tell the owner that an order
 * existed and nothing whatsoever about what was in it — «Items: 3» is a prompt
 * to go and open the admin panel, which is the panel doing the notification's
 * job.
 *
 * SO THE FIRST TEST IS NOT A UNIT TEST. It runs the REAL checkout route against
 * real migrations, with a real `telegram_admin_config` row and real topic
 * bindings, and asserts on the BODY OF THE HTTP REQUEST that would have gone to
 * Telegram. That is the owner's question — "does the message name the thing I
 * sold?" — rather than "was a builder called". Twice before, work in this area
 * was reported done while the symptom survived because only half the path was
 * changed; a test that stops at the builder cannot tell the difference.
 *
 * THE SECOND HALF IS THE PRIVACY CONTRACT (worker/lib/adminTopicRouting.ts
 * header). The message is allowed the customer's name, a MASKED phone and the
 * area — and is not allowed the street line, the full phone or the email. Those
 * are assertions here because a group chat gets forwarded and screenshotted,
 * and nothing else in the system would notice the day the street appeared.
 *
 * Run: node --import tsx --test tests/orderTopicMessage.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ROOT, SqliteD1 } from './fixtures/d1';
import type { AppContext } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';
import { orderRoutes } from '../worker/routes/orders';
import { orderAnnouncement } from '../worker/lib/adminTopicRouting';
import { SHIPPING_TYPE_LABELS } from '../worker/lib/shippingType';
import { maskPhone } from '../worker/lib/phone';
import { acceptedPolicies } from './lib/policies';
import { resetPolicyCorpusMemo } from '../worker/lib/policySync';

// =========================================================================
// THE BUILDER, ON ITS OWN
// =========================================================================

test('THE LINES — the message names the products, the option/colour and the money', () => {
  const text = orderAnnouncement({
    orderId: 'ORD-ABC123',
    customerName: 'سارة',
    shippingType: 'direct',
    totalIqd: 275_000,
    lines: [
      { name: 'Bambu A1', name_ar: 'بامبو A1', variant: 'أسود / 1.75mm', qty: 2, line: 200_000 },
      { name: 'PLA Basic', name_ar: 'PLA أساسي', variant: '', qty: 3, line: 75_000 },
    ],
  });
  // The whole point of the change: the owner can read what was sold without
  // opening anything.
  assert.match(text, /بامبو A1 — أسود \/ 1\.75mm × 2 — 200,000 د\.ع/);
  assert.match(text, /PLA أساسي × 3 — 75,000 د\.ع/);
  assert.match(text, /الأصناف \(2\):/);
  assert.match(text, /الإجمالي: 275,000 د\.ع/);
});

test('THE ARABIC NAME WINS, and the English one is the fallback rather than a second line', () => {
  const ar = orderAnnouncement({ lines: [{ name: 'Bambu A1', name_ar: 'بامبو A1', qty: 1, line: 1 }] });
  assert.match(ar, /• بامبو A1 ×/);
  assert.doesNotMatch(ar, /Bambu A1/, 'one name per line — the group reads Arabic');
  const en = orderAnnouncement({ lines: [{ name: 'Bambu A1', name_ar: '', qty: 1, line: 1 }] });
  assert.match(en, /• Bambu A1 ×/, 'a product with no Arabic name still has to be readable');
});

test('BUNDLE COMPONENTS ARE NOT LINES — the owner sees the bundle, not its parts at zero', () => {
  // The count this message replaced already filtered on exactly this field;
  // printing components would show a five-line order for a two-item cart, three
  // of those lines priced at nothing.
  const text = orderAnnouncement({
    lines: [
      { name_ar: 'حزمة البداية', qty: 1, line: 150_000 },
      { name_ar: 'قطعة داخل الحزمة', qty: 1, line: 0, bundle_parent_item_id: 'oi_parent' },
      { name_ar: 'قطعة أخرى', qty: 1, line: 0, bundle_parent_item_id: 'oi_parent' },
    ],
  });
  assert.match(text, /الأصناف \(1\):/);
  assert.match(text, /حزمة البداية/);
  assert.doesNotMatch(text, /قطعة داخل الحزمة/);
});

test('§8.2 — a mystery spool prints its SNAPSHOT, never the product that was actually drawn', () => {
  /**
   * `ComputedLine.mystery_spool` sits on a line whose sibling `name` and
   * `product_id` carry the REAL pick, because `planInventory` needs them. Every
   * other surface is protected structurally — the `order_items` INSERT binds
   * NULL — but this one is handed the in-memory line, so it is the one place
   * the reveal could leak, into the one artefact that gets forwarded.
   */
  const text = orderAnnouncement({
    lines: [
      {
        name: 'Bambu X1 Carbon',
        name_ar: 'بامبو X1 كاربون',
        variant: 'أسود',
        qty: 1,
        line: 90_000,
        mystery_spool: { name_snapshot: 'صندوق الحظ', variant_snapshot: 'مفاجأة' },
      },
    ],
  });
  assert.match(text, /صندوق الحظ — مفاجأة × 1/);
  assert.doesNotMatch(text, /بامبو X1 كاربون/, 'the drawn product must not reach the group');
  assert.doesNotMatch(text, /Bambu X1 Carbon/);
});

test('THE TRANSPORT LINE IS THE OWNER’S OWN WORDING, never a second copy of it', () => {
  for (const type of ['direct', 'preorder_air', 'preorder_sea', 'preorder_land'] as const) {
    const text = orderAnnouncement({ shippingType: type, lines: [] });
    assert.match(text, new RegExp(`النقل: ${SHIPPING_TYPE_LABELS[type].ar}`));
  }
  // Same normalisation as `orderTopic`: anything unreadable reads as direct, so
  // the headline can never disagree with the topic the message was filed in.
  assert.match(orderAnnouncement({ shippingType: 'nonsense' }), /النقل: شحن مباشر/);
  assert.match(orderAnnouncement({}), /النقل: شحن مباشر/);
});

test('THE PAYMENT LINE reuses the customer summary\u2019s own Arabic, and never guesses', () => {
  // `allowedPaymentMethods` admits wallet and cash (plus the stored
  // `full_advance` alias). The words are lifted from PaymentBreakdown.tsx so
  // the group and the customer read one vocabulary.
  assert.match(orderAnnouncement({ paymentMethodId: 'cash' }), /الدفع: الدفع عند الاستلام/);
  assert.match(orderAnnouncement({ paymentMethodId: 'wallet' }), /الدفع: من المحفظة/);
  assert.match(orderAnnouncement({ paymentMethodId: 'full_advance' }), /الدفع: من المحفظة/);
  // An id nobody has written Arabic for prints AS ITSELF. Guessing «من
  // المحفظة» for it would be a lie about where the money is.
  assert.match(orderAnnouncement({ paymentMethodId: 'gini' }), /الدفع: gini/);
  assert.doesNotMatch(orderAnnouncement({}), /الدفع:/, 'no id, no line — not an empty label');
  // The id arrives from a request body and the label table is a plain object,
  // which answers 'constructor' with a function: a bare lookup would paste a
  // function body into the owner's group.
  for (const evil of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const text = orderAnnouncement({ paymentMethodId: evil });
    assert.equal(text.includes('function'), false, `${evil} leaked a function into the message`);
    assert.match(text, new RegExp(`الدفع: ${evil.replace(/[_]/g, '_')}`));
  }
});

test('PRO PRIORITY is flagged with the board\u2019s own badge, and standard says nothing', () => {
  // 'PRO' / 'PRO · 12H' is what src/components/adminOrders/OrderBoardBadges.tsx
  // already prints for this column: language-neutral, so no new wording in any
  // language — and none in Sorani, which must never be generated.
  assert.match(orderAnnouncement({ fulfilmentService: 'pro_priority_12h' }), /⚡ PRO · 12H/);
  assert.match(orderAnnouncement({ fulfilmentService: 'pro_priority' }), /⚡ PRO/);
  assert.doesNotMatch(orderAnnouncement({ fulfilmentService: 'standard' }), /PRO/);
});

test('PRIVACY — the phone is masked and the street is not a parameter at all', () => {
  const text = orderAnnouncement({
    customerName: 'سارة',
    phone: '+9647701234567',
    governorate: 'بغداد',
    area: 'الكرادة',
    landmark: 'قرب الجامع',
    lines: [],
  });
  assert.match(text, new RegExp(maskPhone('+9647701234567').replace(/[+*]/g, (ch) => `\\${ch}`)));
  assert.doesNotMatch(text, /\+9647701234567/, 'the full number must never reach the group');
  assert.match(text, /المنطقة: بغداد — الكرادة · قرب الجامع/);
  // The builder has no `address` parameter; passing one changes nothing, which
  // is what makes the contract structural rather than a habit.
  const withStreet = orderAnnouncement({
    governorate: 'بغداد',
    lines: [],
    ...({ address: 'Baghdad, Karrada 12, house 7' } as Record<string, unknown>),
  });
  assert.doesNotMatch(withStreet, /house 7/);
});

test('SANITIZING — a product name cannot forge a line or reorder the message', () => {
  const text = orderAnnouncement({
    orderId: 'ORD-1',
    lines: [{ name_ar: 'خيط‮مقلوب\nالإجمالي: 9,000,000 د.ع', qty: 1, line: 5_000 }],
    totalIqd: 5_000,
  });
  assert.doesNotMatch(text, /‮/, 'a bidi override would reorder every line around it');
  assert.equal(text.split('\n').filter((l) => l.startsWith('الإجمالي:')).length, 1, 'one total, and it is ours');
  assert.match(text, /الإجمالي: 5,000 د\.ع/);
});

test('THE LIST IS CAPPED, because a silent 4000-character truncation eats the TOTAL', () => {
  const lines = Array.from({ length: 40 }, (_, i) => ({ name_ar: `صنف ${i}`, qty: 1, line: 1_000 }));
  const text = orderAnnouncement({ orderId: 'ORD-BIG', totalIqd: 40_000, lines });
  assert.equal(text.split('\n').filter((l) => l.startsWith('• ')).length, 15);
  assert.match(text, /و 25 سطر آخر/);
  assert.match(text, /الأصناف \(40\):/, 'the count is still honest');
  assert.match(text, /الإجمالي: 40,000 د\.ع/);
  assert.ok(text.length < 4000, `sendMessageToChat slices at 4000; this was ${text.length}`);
});

test('THE BUILDER CANNOT THROW ON THE REQUEST OF A CUSTOMER WHO ALREADY PAID', () => {
  /**
   * The header of adminTopicRouting.ts is explicit that `text` is evaluated
   * EAGERLY by the caller, outside the wrapper's try/catch, so a throw here
   * lands on a checkout that has already committed. `strictNullChecks` is OFF,
   * so nothing but this test enforces it.
   */
  assert.doesNotThrow(() => orderAnnouncement());
  assert.doesNotThrow(() => orderAnnouncement({}));
  assert.doesNotThrow(() => orderAnnouncement({ lines: null as never }));
  assert.doesNotThrow(() =>
    orderAnnouncement({
      totalIqd: undefined,
      bnplIqd: NaN,
      lines: [null as never, { qty: 'x', line: undefined } as never],
    })
  );
  assert.match(orderAnnouncement({ totalIqd: undefined, lines: [] }), /الإجمالي: 0 د\.ع/);
});

test('THE MONEY LINES — BNPL replaces the door figure, and a store sale names the merchant', () => {
  const bnpl = orderAnnouncement({ totalIqd: 500_000, bnplIqd: 300_000, bnplDueAt: '2026-11-01', dueOnDeliveryIqd: 0 });
  assert.match(bnpl, /الأقساط المؤجلة: 300,000 د\.ع — يستحق 2026-11-01/);
  assert.doesNotMatch(bnpl, /المستحق عند التسليم/, 'two due lines would be two answers to one question');

  const cod = orderAnnouncement({ totalIqd: 500_000, bnplIqd: 0, dueOnDeliveryIqd: 500_000 });
  assert.match(cod, /المستحق عند التسليم: 500,000 د\.ع/);

  const store = orderAnnouncement({
    orderId: 'ORD-S1',
    storeName: 'متجر النور',
    totalIqd: 60_000,
    dueOnDeliveryIqd: 0,
    merchantReceivableIqd: 54_000,
  });
  assert.match(store, /🛒 طلب متجر جديد — ORD-S1/);
  assert.match(store, /المتجر: متجر النور/);
  assert.match(store, /يستلم التاجر: 54,000 د\.ع/);
});

// =========================================================================
// THE WHOLE PATH — a real checkout, a real topic binding, a real send body
// =========================================================================

const GROUP = '-1001234567890';
const ORDERS_DIRECT_THREAD = 88;

function setup() {
  // A new database is a new archive: `ensurePolicyCorpus` memoises a completed
  // mirror per isolate, and one test process holds many databases.
  resetPolicyCorpusMemo();
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('buyer','سارة','s@x.co','h','customer');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,governorate,area,is_default) VALUES
      ('addr_b','buyer','Home','سارة','+9647701234567','Baghdad, Karrada 12, house 7','قرب الجامع','بغداد','الكرادة',1);
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images)
      VALUES ('p_a1','a1','Bambu A1','بامبو A1',100000,'active',10,'[]','[]','direct_sale','["direct_sale"]','[]','[]');
    INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
      VALUES ('ci1','buyer','p_a1','','[]','','','','',2);
    INSERT INTO telegram_admin_config (id, group_chat_id, group_title, configured_by, configured_by_tg)
      VALUES ('singleton', '${GROUP}', 'Levonis', 'boss', 1);
    INSERT INTO telegram_admin_topics (topic_key, message_thread_id, enabled, configured_by, configured_by_tg)
      VALUES ('orders_direct', ${ORDERS_DIRECT_THREAD}, 1, 'boss', 1);
  `);
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

interface SentMessage {
  chat_id: string;
  message_thread_id?: number;
  text: string;
}

function stubTelegram(): { sent: SentMessage[]; restore: () => void } {
  const sent: SentMessage[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (!href.includes('api.telegram.org')) return real(url as never, init as never);
    sent.push(JSON.parse(String(init?.body ?? '{}')) as SentMessage);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 9, chat: { id: Number(GROUP) } } }), {
      status: 200,
    });
  }) as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = real; } };
}

test('END TO END — the message a real checkout sends names the product, the area and a masked phone', async () => {
  const { db } = setup();
  const tg = stubTelegram();
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => undefined)); },
    passThroughOnException() {},
  } as unknown as ExecutionContext;

  try {
    const app = new Hono<AppContext>();
    app.use('*', async (c, next) => {
      c.set('user', { id: 'buyer', role: 'customer', email: 's@x.co', username: 'sara', name: 'سارة' } as never);
      c.env = { DB: db, TELEGRAM_ADMIN_BOT_TOKEN: '999:ADMINTOKEN' } as never;
      await next();
    });
    app.route('/api/orders', orderRoutes);
    app.onError((err, c) => {
      if (err instanceof HttpError) {
        return c.json({ success: false, error: err.message, code: err.code }, err.status as 400);
      }
      throw err;
    });

    const res = await app.request(
      '/api/orders',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          addressId: 'addr_b',
          deliveryMethodId: 'standard',
          paymentMethodId: 'cash',
          useWallet: false,
          usePoints: false,
          itemIds: [],
          idempotencyKey: `otm-${Date.now()}`,
          policyAcceptance: acceptedPolicies(),
        }),
      },
      undefined,
      ctx
    );
    assert.equal(res.status, 200, await res.text());
    while (pending.length) await Promise.all(pending.splice(0, pending.length));
    await new Promise((r) => setTimeout(r, 0));

    const order = tg.sent.find((m) => m.message_thread_id === ORDERS_DIRECT_THREAD);
    assert.ok(order, `nothing reached «📝 Orders direct»; got ${JSON.stringify(tg.sent)}`);
    // THE SYMPTOM. Before this change the whole body was «🛒 New order … Items: 1 …».
    assert.match(order.text, /بامبو A1/, 'the owner must be able to read what was sold');
    assert.match(order.text, /× 2/, 'and how many');
    assert.match(order.text, /الأصناف \(1\):/);
    assert.match(order.text, /النقل: شحن مباشر/);
    assert.match(order.text, /المنطقة: بغداد — الكرادة · قرب الجامع/);
    assert.match(order.text, /الزبون: سارة/);
    // AND THE CONTRACT. The street line is in `addresses.address` on this very
    // row and in the order's own snapshot; it does not reach the group.
    assert.doesNotMatch(order.text, /house 7/);
    assert.doesNotMatch(order.text, /Karrada 12/);
    assert.doesNotMatch(order.text, /\+9647701234567/);
    assert.doesNotMatch(order.text, /s@x\.co/);
    assert.match(order.text, /\*/, 'the phone is present, masked — a reviewer recognises a number they hold');
  } finally {
    tg.restore();
  }
});
