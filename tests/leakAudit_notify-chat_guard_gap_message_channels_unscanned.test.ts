/**
 * LEAK AUDIT — notify-chat: the MESSAGE CHANNELS were never swept for cost.
 *
 * THE CANDIDATE (guard gap). Every cost guard reads HTTP bodies:
 * tests/costRoleMatrix.test.ts sweeps GETs and writes, the phase-0 suite reads
 * /api/notifications, tests/costDeployAhead.test.ts checks who RECEIVES the
 * withdrawal notice and tests/fxNotify reads the FX texts. Nothing drives a
 * real order through its life with the sentinel costs in place and then reads
 * what the MESSAGES carried: the admin Telegram group (one chat id, read by
 * every member — assistants included, worker/lib/adminTopicRouting.ts), the
 * customer's Telegram / WhatsApp / e-mail (outbox payloads and the bodies put
 * on the wire), the in-app bell rows (user_notifications), the admin-group
 * caption ledger (tg_admin_notifications) and the chat card snapshots
 * (chat_messages). A cost figure put into any of those texts would fail no
 * test.
 *
 * THE TEST. The role-matrix world (tests/fixtures/roleMatrix.ts): the costly
 * product with a different sentinel cost on every level (product, option,
 * order-type cell, route, colour), a received lot, an open purchase, an
 * investor contract and a profit-share wage rule. On top of it: the customer
 * is reachable on every channel (verified e-mail, E.164 phone, linked
 * Telegram), the admin group is bound with every topic, and EVERY outbound
 * fetch is answered in-process and recorded (Telegram Bot API, WasenderAPI,
 * Resend) — nothing leaves the machine.
 *
 * The real routes are then driven as the NON-OWNER actors that drive them in
 * production:
 *   customer   checkout of the costly product (option + colour, lot-backed);
 *   full admin confirm → processing → shipped → delivered (COGS, staff and
 *              investor accruals are computed here);
 *   customer   return request, price-protection claim (after a real price
 *              drop) and a competitor price report;
 *   full admin walks the return to a refund (stock + COGS come back) and
 *              approves the claim;
 *   customer   a second checkout; full admin proposes a new total; the customer
 *              approves it; the customer cancels the order (lot restored);
 *   assistant  receives the open purchase (an operations act);
 *   cron       the outbox is drained to the wire.
 *
 * Then every message artefact — every wire body, every row of every table
 * whose name says notif/outbox/message/announce/caption, every HTTP answer
 * the actors got on the way, and the bell as five non-owner roles read it — is
 * walked with `leaks()` (sentinels, cost-named numbers, FINANCIAL_FIELDS keys)
 * AND with a digit scan for every private figure the run itself WROTE (the new
 * orders' cost snapshots, COGS, allocation unit costs, lot costs, per-line
 * profit) — `leaks()` matches only the fixed sentinels inside text, and a
 * checkout's cost snapshot is a derived number.
 *
 * Positive controls: each step's message is asserted to EXIST (so the scan is
 * reading real traffic, not an empty list), the private figures are asserted
 * to be IN the database (so there was something to leak), and the scanner is
 * shown to catch a sentinel — and the delivered line's own cost snapshot —
 * formatted the way these texts format money.
 *
 * RESULT ON THE AUDITED TREE: green. The gap was real (no committed test read
 * these channels with the scanner); no figure leaks through them today. Not
 * reached here: tg_admin_notifications (wallet captions — no cost input) and
 * chat_messages (store/community chats — no owner cost input); both tables
 * are still walked, empty. The merchant feed read by an admin who opens a
 * store is its own audit (leakAudit_notify-chat_merchant_feed_bypasses_owner_finance_hide).
 *
 * LOCAL ONLY. Run:
 *   node --import tsx --test tests/leakAudit_notify-chat_guard_gap_message_channels_unscanned.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { all, asD1, count, ctx, pending, row, stubApp, type StubUser } from './fixtures/app';
import { COST, SENTINELS, isGeneratedId, leaks } from './fixtures/costlyProduct';
import { BASE_MOUNTS, OWNER, ROLES, seedRoleMatrix } from './fixtures/roleMatrix';
import { acceptedPolicies } from './lib/policies';
import { processOutbox } from '../worker/lib/outbox';
import { canViewCost } from '../worker/lib/adminScope';
import type { Env } from '../worker/lib/types';

const GROUP = '-1005550001111';
const THREADS: Record<string, number> = {
  general: 11,
  review: 12,
  report: 13,
  merchant_verification: 14,
  wallet: 15,
  orders_preorder: 16,
  orders_direct: 17,
  support: 18,
  warranty: 19,
};
const CUSTOMER_CHAT = 70_001;
const PHONE = '+9647701234567';
const ENV = {
  TELEGRAM_BOT_TOKEN: '111:CUSTOMERTOKEN',
  TELEGRAM_ADMIN_BOT_TOKEN: '999:ADMINTOKEN',
  EMAIL_API_KEY: 're_test_key',
  EMAIL_FROM: 'LEVONIS <no-reply@levonis.test>',
  WASENDER_API_KEY: 'wa_test_key',
  APP_ORIGIN: 'https://levonis.test',
  STORE_ROOT_DOMAIN: 'levonis-iq.com',
};

// ---------------------------------------------------------------- the wire

interface Wire {
  host: string;
  path: string;
  body: unknown;
}

/** Every outbound request, recorded and answered in-process. Nothing leaves the machine. */
function stubWire(): { wire: Wire[]; restore: () => void } {
  const wire: Wire[] = [];
  const prev = globalThis.fetch;
  let mid = 1000;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(href);
    const raw = init?.body;
    let body: unknown = null;
    if (typeof raw === 'string') {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    } else if (raw instanceof FormData) {
      const o: Record<string, string> = {};
      raw.forEach((v, k) => (o[k] = typeof v === 'string' ? v : '<file>'));
      body = o;
    } else if (raw != null) body = String(raw);
    wire.push({ host: u.hostname, path: u.pathname.replace(/\/bot[^/]+/, '/bot<token>'), body });
    if (u.hostname === 'api.telegram.org') {
      const chat = Number((body as { chat_id?: unknown } | null)?.chat_id) || 0;
      return Response.json({ ok: true, result: { message_id: ++mid, chat: { id: chat } } });
    }
    if (u.hostname.endsWith('wasenderapi.com')) return Response.json({ success: true, data: { msgId: ++mid, status: 'in_progress' } });
    if (u.hostname === 'api.resend.com') return Response.json({ id: `re_${++mid}` });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { wire, restore: () => { globalThis.fetch = prev; } };
}

// ---------------------------------------------------------------- the world

function world(): DatabaseSync {
  const raw = seedRoleMatrix();
  const now = new Date().toISOString();
  const topics = Object.entries(THREADS)
    .map(([k, t]) => `('${k}', ${t}, 1, 'usr_owner', 1)`)
    .join(',');
  raw.exec(`
    UPDATE users SET email_verified_at = '${now}', phone_e164 = '${PHONE}', locale = 'ar', username = 'sara' WHERE id = 'u1';
    INSERT INTO telegram_links (user_id, telegram_user_id, chat_id, phone_e164, verified_at)
      VALUES ('u1', ${CUSTOMER_CHAT}, ${CUSTOMER_CHAT}, '${PHONE}', '${now}');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,governorate,area,is_default)
      VALUES ('addr_u1','u1','Home','Sara','${PHONE}','Karrada 12, house 7','near the mosque','بغداد','الكرادة',1);
    INSERT INTO telegram_admin_config (id, group_chat_id, group_title, configured_by, configured_by_tg)
      VALUES ('singleton', '${GROUP}', 'Levonis staff', 'usr_owner', 1);
    INSERT INTO telegram_admin_topics (topic_key, message_thread_id, enabled, configured_by, configured_by_tg) VALUES ${topics};
  `);
  return raw;
}

function appAs(raw: DatabaseSync, user: StubUser | null) {
  return stubApp(asD1(raw), user, (a) => {
    for (const [prefix, router] of BASE_MOUNTS) a.route(prefix, router);
  }, { env: ENV });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    while (pending.length) await Promise.all(pending.splice(0, pending.length));
    await new Promise((r) => setTimeout(r, 0));
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

async function call(
  raw: DatabaseSync,
  user: StubUser | null,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: Json }> {
  const app = appAs(raw, user);
  const init: RequestInit = { method, headers: { 'CF-Connecting-IP': '1.2.3.4' } };
  if (method !== 'GET') {
    init.headers = { ...init.headers, 'content-type': 'application/json', origin: 'https://levonis-iq.com' };
    init.body = JSON.stringify(body ?? {});
  }
  const res = await app.request(path, init, undefined, ctx);
  const text = await res.text();
  let parsed: Json = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { text };
  }
  await settle();
  return { status: res.status, body: parsed };
}

const ok = (r: { status: number; body: unknown }, what: string) =>
  assert.ok(r.status >= 200 && r.status < 300, `${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 600)}`);

// ---------------------------------------------------------------- scanning

/** Every row of every table that stores a message, a caption, a notice or a chat card. */
function messageTables(raw: DatabaseSync): Record<string, Array<Record<string, unknown>>> {
  const names = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
    .map((r) => r.name)
    .filter((n) => /notif|outbox|message|announce|caption/i.test(n) && !/^sqlite_/.test(n));
  const out: Record<string, Array<Record<string, unknown>>> = {};
  for (const n of names) {
    const rows = all(raw, `SELECT * FROM ${n}`);
    // A JSON column (payload, meta, card_snapshot) is walked as JSON, not as one opaque string.
    out[n] = rows.map((r) => {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        if (typeof v === 'string' && /^[[{]/.test(v)) {
          try {
            o[k] = JSON.parse(v);
            continue;
          } catch {
            /* plain text */
          }
        }
        o[k] = v;
      }
      return o;
    });
  }
  return out;
}

/**
 * The private figures THIS RUN wrote: cost snapshots, COGS and allocation unit
 * costs of every order line, lot costs, and each line's profit (line total −
 * cost). `leaks()` only matches the fixed sentinels inside text; these are
 * derived numbers, so they are looked for as digit groups in every string.
 * A figure that is also a final price somewhere in the run is dropped — a
 * coincidence there cannot be told apart from a price.
 */
function privateFigures(raw: DatabaseSync): Set<number> {
  const out = new Set<number>(SENTINELS);
  const add = (v: unknown) => {
    const n = Number(v);
    if (Number.isSafeInteger(n) && n >= 1000) out.add(n);
  };
  for (const r of all(raw, 'SELECT cost_iqd, line_total_iqd, qty FROM order_items')) {
    add(r.cost_iqd);
    if (Number(r.cost_iqd) > 0) {
      add(Number(r.line_total_iqd) - Number(r.cost_iqd) * Math.max(1, Number(r.qty) || 1));
      add(Number(r.line_total_iqd) - Number(r.cost_iqd));
    }
  }
  for (const r of all(raw, 'SELECT unit_cost_iqd, cogs_iqd FROM order_item_inventory_allocations')) {
    add(r.unit_cost_iqd);
    add(r.cogs_iqd);
  }
  for (const r of all(raw, 'SELECT unit_cost_iqd, purchase_unit_iqd, shipping_share_iqd, total_cost_iqd FROM inventory_lots')) {
    for (const v of Object.values(r)) add(v);
  }
  // Final prices the customer legitimately sees: never treated as private.
  for (const r of all(raw, 'SELECT total_iqd, subtotal_iqd, due_on_delivery_iqd FROM orders')) for (const v of Object.values(r)) out.delete(Number(v));
  for (const r of all(raw, 'SELECT unit_price_iqd, line_total_iqd FROM order_items')) for (const v of Object.values(r)) out.delete(Number(v));
  for (const r of all(raw, 'SELECT price_iqd FROM products')) out.delete(Number(r.price_iqd));
  return out;
}

/** Digit groups (1,234,567 or 1234567) inside any string that spell a private figure. */
function digitLeaks(value: unknown, figures: Set<number>, path = '$'): string[] {
  const out: string[] = [];
  const walk = (v: unknown, p: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, `${p}.${k}`);
    else if (typeof v === 'number' && figures.has(v)) out.push(`${p} = ${v}`);
    else if (typeof v === 'string' && !isGeneratedId(v)) {
      // Arabic-Indic and Persian digits read as Latin; a run glued to letters (an id) is not a figure.
      const latin = v.replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
      for (const m of latin.match(/(?<![A-Za-z0-9])\d[\d,٬]{3,}(?:\.\d+)?(?![A-Za-z0-9])/g) ?? []) {
        const n = Number(m.replace(/[,٬]/g, '').replace(/\.\d+$/, ''));
        if (figures.has(n)) out.push(`${p} ⊃ "${m}"`);
      }
    }
  };
  walk(value, path);
  return out;
}

// ---------------------------------------------------------------- the test

test('scanner control: a sentinel cost formatted the way these texts format money is caught', () => {
  const text = `🛒 طلب جديد\nالكلفة: ${COST.option.toLocaleString('en-US')} د.ع`;
  assert.notDeepEqual(leaks({ text }), [], 'leaks() catches a grouped sentinel inside a Telegram text');
  assert.notDeepEqual(digitLeaks({ text: 'cost 277,778 IQD' }, new Set([277_778])), [], 'the digit scan catches a derived figure');
});

test('every message channel a real order life writes carries no private cost to any non-owner reader', async () => {
  const raw = world();
  const tg = stubWire();
  const customer = ROLES.customer!;
  const full = ROLES.full!;
  const assistant = ROLES.support_assistant!;
  const steps: Record<string, string> = {};
  /** Every answer a non-owner actor received while driving the flows — scanned with the messages. */
  const answers: Array<{ what: string; body: unknown }> = [];
  const act = async (user: StubUser, method: string, path: string, body?: unknown) => {
    const r = await call(raw, user, method, path, body);
    answers.push({ what: `${method} ${path} as ${user.id} → ${r.status}`, body: r.body });
    return r;
  };
  try {
    // Premise: none of the actors may see cost.
    const env = { DB: asD1(raw), INITIAL_ADMIN_EMAIL: 'boss@x.co' } as unknown as Env;
    for (const u of [customer, full, assistant]) {
      assert.equal(canViewCost(env, { admin_scope: null, email_verified_at: '2026-01-01T00:00:00.000Z', ...u } as never), false, `${u.id} is not the owner`);
    }
    assert.equal(canViewCost(env, { admin_scope: null, email_verified_at: '2026-01-01T00:00:00.000Z', ...OWNER } as never), true);

    // 1) CHECKOUT — the costly product, option + colour, lot-backed.
    const checkout = (key: string) =>
      act(customer, 'POST', '/api/orders', {
        addressId: 'addr_u1',
        deliveryMethodId: 'standard',
        paymentMethodId: 'cash',
        useWallet: false,
        usePoints: false,
        itemIds: [],
        idempotencyKey: key,
        policyAcceptance: acceptedPolicies(),
      });
    const placed = await checkout(`leak-notify-1-${Date.now()}`);
    ok(placed, 'checkout');
    const orderId = String(placed.body.order?.id ?? placed.body.orderId ?? placed.body.id ?? '');
    assert.ok(orderId, `checkout answered an order id: ${JSON.stringify(placed.body).slice(0, 300)}`);
    steps.checkout = orderId;

    // 2) FULL ADMIN walks it to delivered.
    for (const status of ['confirmed', 'processing', 'shipped', 'delivered']) {
      const r = await act(full, 'PATCH', `/api/admin/orders/${orderId}`, { status });
      ok(r, `full admin → ${status}`);
    }
    const item = row<{ id: string; cost_iqd: number | null }>(raw, 'SELECT id, cost_iqd FROM order_items WHERE order_id = ?', orderId)!;

    // 3) CUSTOMER — return request on the delivered line.
    const ret = await act(customer, 'POST', '/api/returns', { orderItemId: item.id, qty: 1, reason: 'defective', description: 'does not heat' });
    ok(ret, 'return request');
    steps.return = String(ret.body.case?.id ?? ret.body.id ?? 'ok');

    // 4) CUSTOMER — price-protection claim after a real price drop, on a
    // delivered line of its own: the published policy pays a return OR price
    // protection on one unit, never both (PRICE_PROTECTION_RETURN_REVIEW), and
    // the return of 3) is refunded below.
    raw.exec(`INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
              VALUES ('ci_pp','u1','p_a1','v_a1','["v_a1"]','c_blk','','','',1);`);
    const forClaim = await checkout(`leak-notify-pp-${Date.now()}`);
    ok(forClaim, 'checkout for the claim');
    const claimOrder = String(forClaim.body.order?.id ?? forClaim.body.orderId ?? forClaim.body.id ?? '');
    for (const status of ['confirmed', 'processing', 'shipped', 'delivered']) {
      ok(await act(full, 'PATCH', `/api/admin/orders/${claimOrder}`, { status }), `full admin → ${status} (claim order)`);
    }
    const claimItem = row<{ id: string }>(raw, 'SELECT id FROM order_items WHERE order_id = ?', claimOrder)!;
    raw.exec(`
      UPDATE products SET price_iqd = 850000 WHERE id = 'p_a1';
      INSERT INTO price_history (product_id, variant_key, field, old_iqd, new_iqd, changed_by)
        VALUES ('p_a1', '', 'regular', 900000, 850000, 'usr_owner');
    `);
    const claim = await act(customer, 'POST', '/api/price-protection/claims', { orderItemId: claimItem.id });
    steps.claim = `${claim.status} ${claim.body.code ?? claim.body.claim?.id ?? ''}`;

    // 4b) FULL ADMIN walks the return to a refund (stock and COGS come back) and approves the claim.
    const caseId = steps.return;
    for (const t of [{ to: 'approved' }, { to: 'received' }, { to: 'inspected' }, { to: 'resolved', resolution: 'refund' }]) {
      const r = await act(full, 'POST', `/api/returns/admin/${caseId}/transition`, t);
      steps[`return_${t.to}`] = String(r.status);
    }
    const claimId = String(claim.body.claim?.id ?? '');
    if (claimId) {
      const d = await act(full, 'POST', `/api/price-protection/admin/claims/${claimId}/decide`, { decision: 'approved' });
      steps.claim_decide = String(d.status);
    }

    // 5) CUSTOMER — a competitor price report.
    const report = await act(customer, 'POST', '/api/price-reports', { productId: 'p_a1', priceIqd: 800000, sellerName: 'Shop', note: 'cheaper' });
    ok(report, 'price report');

    // 6) A SECOND ORDER: full admin re-prices it, the customer approves, then cancels.
    raw.exec(`INSERT INTO cart_items (id,user_id,product_id,option_id,option_value_ids,color_id,shipping_method_id,transport_method,warranty_plan_id,qty)
              VALUES ('ci2','u1','p_a1','v_a1','["v_a1"]','c_blk','','','',1);`);
    const second = await checkout(`leak-notify-2-${Date.now()}`);
    ok(second, 'second checkout');
    const order2 = String(second.body.order?.id ?? second.body.orderId ?? second.body.id ?? '');
    const total2 = Number(row<{ t: number }>(raw, 'SELECT total_iqd AS t FROM orders WHERE id = ?', order2)!.t);
    const proposal = await act(full, 'POST', `/api/admin/orders/${order2}/price-adjustment`, {
      new_total_iqd: total2 + 15_000,
      reason: 'سعر المورد تغيّر',
      idempotencyKey: `leak-notify-adj-${Date.now()}`,
    });
    ok(proposal, 'full admin proposes a new total');
    const pid = String(proposal.body.adjustment?.id ?? proposal.body.proposal?.id ?? proposal.body.id ?? '');
    const approve = await act(customer, 'POST', `/api/orders/${order2}/price-adjustment/${pid}/approve`);
    ok(approve, 'customer approves the new total');
    const cancel = await act(customer, 'POST', `/api/orders/${order2}/cancel`, { reason: 'changed my mind' });
    steps.cancel = String(cancel.status);

    // 7) ASSISTANT receives the open purchase (operations).
    const recv = await act(assistant, 'POST', '/api/admin/procurement/documents/po1/receive', {
      operation_id: 'leak-notify-recv',
      lines: [{ line_id: 'pl1', qty: 1 }],
    });
    steps.receive = String(recv.status);

    // 8) THE CRON drains the outbox to the wire.
    const env2 = { DB: asD1(raw), INITIAL_ADMIN_EMAIL: 'boss@x.co', ...ENV } as unknown as Env;
    for (let i = 0; i < 10; i++) await processOutbox(env2, 50);
    await settle();

    // ---------------------------------------------------------------- controls
    const group = tg.wire.filter((w) => w.host === 'api.telegram.org' && String((w.body as { chat_id?: unknown })?.chat_id) === GROUP);
    const groupText = group.map((w) => String((w.body as { text?: string; caption?: string }).text ?? (w.body as { caption?: string }).caption ?? '')).join('\n---\n');
    assert.match(groupText, new RegExp(orderId), 'the group heard the new order');
    assert.match(groupText, /Return request/, 'the group heard the return');
    assert.match(groupText, /Price report/, 'the group heard the price report');
    assert.match(groupText, /Price-protection claim/, 'the group heard the price-protection claim');
    assert.match(groupText, new RegExp(`وافق الزبون على السعر الجديد — ${order2}`), 'the group heard the customer approve the new total');
    for (const [k, v] of Object.entries(steps)) if (/^(return_|claim_decide|cancel|receive)/.test(k)) assert.equal(v, '200', `${k} succeeded`);
    assert.ok(count(raw, "SELECT COUNT(*) AS n FROM outbox WHERE state = 'sent'") >= 15, 'the outbox carried the customer messages to the wire');
    assert.ok(count(raw, "SELECT COUNT(*) AS n FROM order_item_inventory_allocations WHERE cogs_iqd IS NOT NULL AND order_id <> 'ord1'") > 0, 'the delivered order drew COGS from the lot');
    const toCustomer = tg.wire.filter((w) => String((w.body as { chat_id?: unknown })?.chat_id ?? '') === String(CUSTOMER_CHAT));
    assert.ok(toCustomer.length > 0, 'the customer heard on Telegram');
    assert.ok(tg.wire.some((w) => w.host.endsWith('wasenderapi.com')), 'the customer heard on WhatsApp');
    assert.ok(tg.wire.some((w) => w.host === 'api.resend.com'), 'the customer heard by e-mail');
    const bell = all(raw, 'SELECT user_id, kind FROM user_notifications');
    assert.ok(bell.some((n) => n.user_id === 'u1'), 'the customer has bell rows');
    // There WAS something to leak: the run wrote private figures.
    assert.ok(Number(item.cost_iqd) > 0, 'the delivered line carries a cost snapshot');
    const figures = privateFigures(raw);
    // …and the scan knows it: this line's own cost snapshot, printed the way a message prints money, is caught.
    assert.notDeepEqual(
      digitLeaks({ text: `الكلفة ${Number(item.cost_iqd).toLocaleString('en-US')} د.ع` }, figures),
      [],
      'the digit scan recognises the delivered line’s real cost snapshot'
    );

    // ---------------------------------------------------------------- the scan
    const tables = messageTables(raw);
    const found: string[] = [];
    for (const w of tg.wire) {
      for (const l of [...leaks(w.body), ...digitLeaks(w.body, figures)]) found.push(`wire ${w.host}${w.path}  ${l}`);
    }
    for (const [name, rows] of Object.entries(tables)) {
      for (const l of [...leaks(rows), ...digitLeaks(rows, figures)]) found.push(`table ${name}  ${l}`);
    }
    for (const a of answers) {
      for (const l of [...leaks(a.body), ...digitLeaks(a.body, figures)]) found.push(`answer ${a.what}  ${l}`);
    }
    // What a non-owner reads of those rows through the doors that serve them.
    for (const [who, user, path] of [
      ['customer', customer, '/api/notifications'],
      ['full', full, '/api/notifications'],
      ['assistant', assistant, '/api/notifications'],
      ['employee', ROLES.employee!, '/api/notifications'],
      ['investor', ROLES.investor!, '/api/notifications'],
      ['customer', customer, `/api/orders/${orderId}`],
    ] as const) {
      const r = await call(raw, user, 'GET', path);
      for (const l of [...leaks(r.body), ...digitLeaks(r.body, figures)]) found.push(`GET ${path} as ${who}  ${l}`);
    }

    assert.deepEqual(
      found,
      [],
      `private cost reached a message channel (steps ${JSON.stringify(steps)}; tables ${Object.keys(tables).join(',')}; ${tg.wire.length} wire sends)`
    );
  } finally {
    tg.restore();
  }
});
