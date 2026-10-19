/**
 * LEAK AUDIT — notify-chat: the admin Telegram group's «📝 Orders direct»
 * topic is told the platform's commission on every community-store sale.
 *
 * THE CANDIDATE. `POST /api/store-orders` (worker/routes/storeOrders.ts) hands
 * `orderAnnouncement({ totalIqd, merchantReceivableIqd, … })` to
 * `announceAfterResponse(c, orderTopic('direct'), …)`, and
 * worker/lib/adminTopicRouting.ts prints `يستلم التاجر: …` beside
 * `الإجمالي: …`. The difference of the two lines is exactly
 * `orders.platform_fee_iqd` — Levonis's take on the sale, the figure
 * worker/routes/adminCommunity.ts calls «its profit» and nulls for every admin
 * without `canMoveMoney` (`store_sales.fees: null` for an assistant).
 *
 * WHO READS IT. `notifyAdminTopic` sends to the bound GROUP chat id — no
 * per-member check exists or can exist; membership is managed in Telegram. The
 * code itself says the group is read by non-owners: «an admin Telegram topic,
 * which assistants read» (worker/lib/notifications.ts, worker/lib/fx/notify.ts)
 * and «These messages land in a GROUP that staff read on their phones»
 * (worker/lib/adminTopicRouting.ts).
 *
 * THE TEST. A real store checkout (cart → quote → place) against every
 * migration, with a real `telegram_admin_config` binding and an
 * `orders_direct` topic, the Telegram API stubbed IN PROCESS (nothing leaves
 * the machine). The non-owner actor is the assistant admin: the HTTP side is
 * asked first and refuses the figure; then the group message — what that same
 * assistant reads in the group — is asserted to carry no commission and
 * nothing it can be derived from. LOCAL ONLY.
 *
 * Run: node --import tsx --test tests/leakAudit_notify-chat_telegram_admin_group_store_commission.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approveMerchants, asD1, get, json, pending, post, row, stubApp } from './fixtures/app';
import { leaks, OWNER, ROLES, seedRoleMatrix } from './fixtures/roleMatrix';
import { cartRoutes } from '../worker/routes/cart';
import { storeOrderRoutes } from '../worker/routes/storeOrders';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';

const GROUP = '-1009876543210';
const ORDERS_DIRECT_THREAD = 77;
const FUTURE = '2099-01-01T00:00:00.000Z';
/** 7% store commission, so the fee is a figure no price in the fixture equals. */
const STORE_PERCENT_X100 = 700;
const ENV = { TELEGRAM_ADMIN_BOT_TOKEN: '999:ADMINTOKEN', APP_ORIGIN: 'https://levonis.test' };

interface SentMessage {
  chat_id: string | number;
  message_thread_id?: number;
  text?: string;
  caption?: string;
}

/** Every Telegram Bot API call this process makes, answered locally. */
function stubTelegram(): { sent: Array<SentMessage & { href: string }>; restore: () => void } {
  const sent: Array<SentMessage & { href: string }> = [];
  const prev = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!/api\.telegram\.org/.test(href)) return prev(input as never, init as never);
    let body: SentMessage = { chat_id: '' };
    try {
      body = JSON.parse(String(init?.body ?? '{}')) as SentMessage;
    } catch {
      /* a multipart send: not the order message */
    }
    sent.push({ ...body, href: href.replace(/bot[^/]+/, 'bot<token>') });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: Number(GROUP) } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { sent, restore: () => { globalThis.fetch = prev; } };
}

function world() {
  // The role matrix's database: every non-owner role row (assistant, full,
  // legacy NULL, …), the owner with a verified address, and the costly
  // product with its sentinel costs — so the scanner below has something to
  // find if purchase cost ever rode along too.
  const raw = seedRoleMatrix();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,email_verified_at) VALUES
      ('u_buyer','Huda','huda@x.co','h','customer','2026-01-01T00:00:00.000Z');
    -- The role-matrix seed gives u_m a store of its own (DECISIONS row 220); this world brings its own.
    DELETE FROM merchant_printers WHERE merchant_id = 'cm_um';
    DELETE FROM merchant_stores WHERE id = 'st_um';
    DELETE FROM community_merchants WHERE id = 'cm_um';
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m_um','u_m','Noor 3D','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status,delivery_settings) VALUES
      ('s_um','m_um','u_m','noor3d','متجر النور','active','{}');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock,options,colors) VALUES
      ('cp_um','m_um','s_um','noor-lamp','مصباح مطبوع','active','active',100000,50,0,'[]','[]');
    INSERT INTO addresses (id,user_id,name,phone,address,governorate) VALUES ('a_buyer','u_buyer','Huda','+9647700000000','Street 1','basra');
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note) VALUES
      ('dep_buyer','u_buyer','deposit','USD',100000,'approved','seed');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at)
      VALUES ('mem_um','u_m','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityFeeStorePercentX100','${STORE_PERCENT_X100}');
    INSERT INTO telegram_admin_config (id, group_chat_id, group_title, configured_by, configured_by_tg)
      VALUES ('singleton', '${GROUP}', 'Levonis staff', 'usr_owner', 1);
    INSERT INTO telegram_admin_topics (topic_key, message_thread_id, enabled, configured_by, configured_by_tg)
      VALUES ('orders_direct', ${ORDERS_DIRECT_THREAD}, 1, 'usr_owner', 1);
  `);
  approveMerchants(raw);
  const db = asD1(raw);
  const buyer = stubApp(
    db,
    { id: 'u_buyer', role: 'customer', email: 'huda@x.co' },
    (a) => {
      a.route('/api/cart', cartRoutes);
      a.route('/api/store-orders', storeOrderRoutes);
    },
    { env: ENV }
  );
  const adminAs = (user: typeof OWNER) =>
    stubApp(db, user, (a) => a.route('/api/admin/community', adminCommunityRoutes), { env: ENV });
  return { raw, buyer, adminAs };
}

const digits = (s: string) => Number(s.replace(/,/g, ''));

test('the admin group is told no store-sale commission (nor anything to derive it from) that an assistant is refused over HTTP', async () => {
  const tg = stubTelegram();
  try {
    const { raw, buyer, adminAs } = world();

    // ---- a real community-store checkout, as the page does it
    const added = await post(buyer, '/api/cart/merchant-items', { productId: 'cp_um', qty: 2 });
    assert.equal(added.status, 201, JSON.stringify(await json(added)));
    const quote = await json(await post(buyer, '/api/store-orders/quote', {}));
    assert.ok(quote.quote?.quote_fingerprint, `quote: ${JSON.stringify(quote).slice(0, 400)}`);
    const placed = await post(buyer, '/api/store-orders', {
      idempotencyKey: 'leak-audit-store-commission-0001',
      addressId: 'a_buyer',
      quoteFingerprint: quote.quote.quote_fingerprint,
    });
    const placedBody = await json(placed);
    assert.equal(placed.status, 201, JSON.stringify(placedBody));
    const orderId = String(placedBody.order.id);
    while (pending.length) await Promise.all(pending.splice(0, pending.length));
    await new Promise((r) => setTimeout(r, 0));

    // ---- the private figure, as stored
    const stored = row<{ total_iqd: number; platform_fee_iqd: number; merchant_receivable_iqd: number }>(
      raw,
      'SELECT total_iqd, platform_fee_iqd, merchant_receivable_iqd FROM orders WHERE id = ?',
      orderId
    );
    assert.ok(stored && stored.platform_fee_iqd > 0, `the sale carries a commission: ${JSON.stringify(stored)}`);
    assert.equal(stored.total_iqd - stored.merchant_receivable_iqd, stored.platform_fee_iqd, 'total − receivable IS the commission');

    // ---- the non-owner actor over HTTP: the assistant is REFUSED the figure
    const asst = await json(await get(adminAs(ROLES.assistant as typeof OWNER), '/api/admin/community/overview'));
    assert.equal(asst.success, true, JSON.stringify(asst).slice(0, 300));
    assert.equal(asst.financial, false, 'an assistant is not a money role');
    assert.equal(asst.store_sales?.fees, null, 'HTTP hides the store-sale commission from an assistant');
    // …and the owner does get it — the scope the HTTP side enforces is real.
    const own = await json(await get(adminAs(OWNER), '/api/admin/community/overview'));
    assert.equal(own.store_sales?.fees, stored.platform_fee_iqd, 'the owner reads the commission over HTTP');

    // ---- the same assistant, reading the admin group
    const msg = tg.sent.find((m) => String(m.chat_id) === GROUP && m.message_thread_id === ORDERS_DIRECT_THREAD);
    assert.ok(
      msg,
      `the store sale must reach «📝 Orders direct» for this test to exercise the path; sent: ${JSON.stringify(tg.sent).slice(0, 600)}`
    );
    assert.ok(Number(GROUP) < 0, 'the destination is a GROUP chat (every member reads it), not the owner’s private chat');
    const text = String(msg.text ?? msg.caption ?? '');
    assert.match(text, new RegExp(orderId), 'it is this order’s message');

    // Purchase-cost sentinels of the costly product: none (the scanner's own job).
    assert.deepEqual(leaks({ text }), [], 'no purchase-cost sentinel in the group message');

    // THE CANDIDATE: the commission, or the receivable that subtracts to it.
    const total = /الإجمالي: ([\d,]+)/.exec(text);
    const receivable = /يستلم التاجر: ([\d,]+)/.exec(text);
    const derived = total && receivable ? digits(total[1]) - digits(receivable[1]) : null;
    const feeText = new Intl.NumberFormat('en-US').format(stored.platform_fee_iqd);
    assert.equal(
      receivable,
      null,
      `the admin group (read by assistant admins, who get store_sales.fees = null over HTTP) is sent «يستلم التاجر: ${receivable?.[1]}» ` +
        `beside «الإجمالي: ${total?.[1]}» for order ${orderId}: total − receivable = ${derived}, which IS orders.platform_fee_iqd ` +
        `(${stored.platform_fee_iqd}) — the platform commission on the sale reaches every group member per order`
    );
    assert.ok(!text.includes(feeText), `the commission ${feeText} is printed in the group message`);
  } finally {
    tg.restore();
  }
});
