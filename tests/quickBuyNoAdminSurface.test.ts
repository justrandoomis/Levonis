/**
 * «الشراء السريع» HAS NO ADMIN SURFACE (owner, 2026-10-08; docs/DECISIONS.md
 * row 188).
 *
 * The owner's words: «الأدمن لا يحتاج إلى إدارة طلبات الشراء السريع فيتم من
 * النظام تلقائيا وبدون تدخل الإدارة لأن عند انتهاء المهلة ٣٠ دقيقة يتحول إلى
 * طلب عادي». So:
 *
 *   1. there is no Quick Buy tab, component or `/api/admin/quick-buy` route —
 *      in the panel, the Worker, the gateway or the route registries;
 *   2. the per-minute schedule still finalises a session on its own and the
 *      result is an ORDINARY order (the board, the counts, the Telegram
 *      announcement), with no Quick Buy badge on the board;
 *   3. while a session collects, nothing of it reaches an admin view: not the
 *      board, not its counts, not the overview, not an admin message;
 *   4. no setting moves: the fixed rules keep their numbers, the stored
 *      settings keep their values, the customer's own Quick Buy settings stay
 *      theirs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index';
import { freshDb, asD1, stubApp, post, get, json, row, all, count, spendable } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import * as quickBuyRouteModule from '../worker/routes/quickBuy';
import { orderRoutes } from '../worker/routes/orders';
import { adminRoutes } from '../worker/routes/admin';
import { QUICK_BUY_POLICY_KEYS, requiredPolicies } from '../worker/lib/policyOps';
import {
  QUICK_BUY_FINALIZE_MAX_ATTEMPTS,
  QUICK_BUY_LEASE_MS,
  QUICK_BUY_MAX_LINES,
  QUICK_BUY_MAX_QTY,
  QUICK_BUY_WINDOW_MS,
} from '../worker/lib/quickBuy/model';
import { WALLET_FREE_DELIVERY_DEFAULT } from '../worker/lib/walletFreeDelivery';
import { matchRoute } from '../services/gateway/src/routes';
import type { Env } from '../worker/lib/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;
const RATE = 1400;
const cents = (iqd: number) => Math.ceil((iqd * 100) / RATE);
const code = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const ADMIN_CHAT = '-1009988776655';
const CUSTOMER_BOT = '1111:CUSTOMER-BOT-TOKEN';
/** The legacy admin destination: TELEGRAM_ADMIN_CHAT_ID through the customer bot. */
const TELEGRAM_ENV = { TELEGRAM_BOT_TOKEN: CUSTOMER_BOT, TELEGRAM_ADMIN_CHAT_ID: ADMIN_CHAT };

/** A stored walletFreeDelivery that differs from the code default, so "unchanged" means something. */
const STORED_FREE_DELIVERY = {
  enabled: true,
  require_full_wallet: true,
  methods: ['standard'],
  rules: [{ catalog_id: 'cat_materials_fdm', min_products_iqd: 40_000, enabled: true }],
};

function world(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'),
      ('boss','Boss','boss@x.co','h','admin');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default,governorate,area) VALUES
      ('addr','buyer','Home','Sara','+9647701234567','Karrada 12','Near the bridge',1,'Baghdad','Karrada');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,category_id,sub_category_id,sku) VALUES
      ('p_pla','pla-basic','PLA Basic','PLA أساسي',25000,'active',10,'[]','[]','direct_sale','["direct_sale"]','[]','[]','cat_materials','cat_materials_fdm','PLA1');
    INSERT INTO product_catalogs (product_id,catalog_id,position) VALUES ('p_pla','cat_materials_fdm',0);
    INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
      VALUES ('wt_fund','buyer','deposit','USD',${cents(2_000_000)},'approved','test funding');
  `);
  raw
    .prepare(`INSERT INTO admin_settings (key, value) VALUES ('walletFreeDelivery', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(JSON.stringify(STORED_FREE_DELIVERY));
  return raw;
}

const asBuyer = (raw: DatabaseSync, env: Record<string, unknown> = {}) =>
  stubApp(asD1(raw), { id: 'buyer', role: 'customer', email: 'buyer@x.co' }, (a) => {
    a.route('/api/quick-buy', quickBuyRouteModule.quickBuyRoutes);
    a.route('/api/orders', orderRoutes);
  }, { env });
const asAdmin = (raw: DatabaseSync) =>
  stubApp(asD1(raw), { id: 'boss', role: 'admin', email: 'boss@x.co' }, (a) => a.route('/api/admin', adminRoutes));

let seq = 0;
const key = () => `qb-noadmin-key-${++seq}`;

async function openSession(raw: DatabaseSync, env: Record<string, unknown> = {}) {
  const act = await json(
    await post(asBuyer(raw, env), '/api/quick-buy/activate', {
      policyAcceptance: requiredPolicies(QUICK_BUY_POLICY_KEYS),
      walletConsent: true,
      addressId: 'addr',
      idempotencyKey: key(),
    })
  );
  assert.equal(act.success, true, JSON.stringify(act));
  const added = await json(await post(asBuyer(raw, env), '/api/quick-buy/items', { productId: 'p_pla', qty: 2, idempotencyKey: key() }));
  assert.equal(added.success, true, JSON.stringify(added));
  return added.session as Row;
}

const expire = (raw: DatabaseSync) =>
  raw.exec(`UPDATE quick_buy_sessions SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') WHERE state = 'open'`);

/** The real Worker's scheduled handler on its every-minute trigger, as Cloudflare calls it. */
async function minuteTick(env: Env) {
  const waited: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { waited.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext;
  worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now(), noRetry() {} } as unknown as ScheduledEvent, env, ctx);
  // The order door hands its admin announcement to waitUntil too: settle until nothing new arrives.
  for (let seen = -1; seen !== waited.length; ) {
    seen = waited.length;
    await Promise.allSettled([...waited]);
  }
}

/** Telegram stubbed at fetch: every message the admin destination would receive. */
function stubTelegram() {
  const sent: Array<{ chat_id: string; text: string }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!/api\.telegram\.org\/bot/.test(url)) return real(input as RequestInfo, init);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (/\/sendMessage$/.test(url)) sent.push({ chat_id: String(body.chat_id ?? ''), text: String(body.text ?? '') });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 7, chat: { id: Number(ADMIN_CHAT) } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { toAdmin: () => sent.filter((m) => m.chat_id === ADMIN_CHAT), restore: () => { globalThis.fetch = real; } };
}

/** Every stored setting. `__`-prefixed rows are job cursors (the finance recovery the same tick runs), not settings. */
const settingsSnapshot = (raw: DatabaseSync) =>
  all<Row>(raw, `SELECT key, value FROM admin_settings WHERE substr(key, 1, 2) <> '__' ORDER BY key`);

// ════════════════════════════════════════════════ 1. no tab, no route

test('no Quick Buy tab: the component is gone and the panel neither imports nor lists it', () => {
  assert.equal(existsSync(join(ROOT, 'src/components/adminQuickBuy')), false, 'src/components/adminQuickBuy is deleted');
  const admin = code('src/pages/Admin.tsx');
  assert.doesNotMatch(admin, /adminQuickBuy|AdminQuickBuy/, 'no lazy import of the old panel');
  assert.doesNotMatch(admin, /id:\s*'quick_buy'/, 'no sidebar entry');
  assert.doesNotMatch(admin, /activeTab === 'quick_buy'/, 'no render branch');
  assert.doesNotMatch(admin, /\|\s*'quick_buy'/, 'not a tab id any more');
  // No other screen calls the old route.
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.(tsx?|mjs)$/.test(e.name) && code(rel).includes('/api/admin/quick-buy')) offenders.push(rel);
    }
  };
  walk('src');
  walk('worker');
  assert.deepEqual(offenders, []);
});

test('no admin Quick Buy route: not exported, not mounted, not routed by the gateway, and the admin prefix answers 404', async () => {
  assert.equal('quickBuyAdminRoutes' in quickBuyRouteModule, false, 'worker/routes/quickBuy.ts exports the customer router only');
  const index = code('worker/index.ts');
  assert.doesNotMatch(index, /app\.route\(\s*'\/api\/admin\/quick-buy'/);
  assert.match(index, /app\.route\('\/api\/quick-buy', quickBuyRoutes\)/, 'the customer surface stays mounted');
  // The gateway has no rule of its own for it any more; the path falls to the
  // generic admin rule like any unknown admin path.
  assert.notEqual(matchRoute('/api/admin/quick-buy/sessions', 'GET')?.prefix, '/api/admin/quick-buy');
  assert.equal(matchRoute('/api/quick-buy/session', 'GET')?.prefix, '/api/quick-buy');
  for (const rel of ['tests/routeClass/money.ts', 'tests/fixtures/roleMatrix.ts', 'services/gateway/test/routing.test.ts']) {
    assert.doesNotMatch(code(rel), /\/api\/admin\/quick-buy/, `${rel} no longer registers the route`);
  }
  // Behaviourally: the admin router has nothing there.
  const raw = world();
  for (const path of ['/api/admin/quick-buy/sessions', '/api/admin/quick-buy/summary']) {
    assert.equal((await get(asAdmin(raw), path)).status, 404, path);
  }
});

test('a finalised Quick Buy order carries no Quick Buy badge on the admin board — only the gift badge remains', () => {
  const badges = code('src/components/adminOrders/OrderBoardBadges.tsx');
  const kindBadge = badges.slice(badges.indexOf('export function OrderKindBadge'));
  assert.doesNotMatch(kindBadge, /quick_buy|شراء سريع|Quick Buy|کڕینی خێرا/);
  assert.match(kindBadge, /order\.order_kind !== 'gift'/);
});

// ═══════════ 2 + 3. the schedule finalises it; until then the admin sees nothing

test('while a session collects nothing reaches the admin; the minute schedule then makes it an ordinary order on the board, in the counts and in one ordinary announcement', async () => {
  const raw = world();
  const tg = stubTelegram();
  try {
    const opened = await openSession(raw, TELEGRAM_ENV);
    assert.equal(opened.state, 'open');
    assert.equal(count(raw, `SELECT COUNT(*) n FROM wallet_holds WHERE user_id = 'buyer' AND state = 'active'`), 1, 'the money is held');
    assert.equal(row<Row>(raw, `SELECT stock_reserved FROM products WHERE id = 'p_pla'`)!.stock_reserved, 2, 'the units are reserved');

    // In the window: the board (every scope, the kind filter), its counts, the overview, admin messages.
    const admin = asAdmin(raw);
    for (const path of ['/api/admin/orders', '/api/admin/orders?scope=all', '/api/admin/orders?scope=all&kind=quick_buy']) {
      const board = await json(await get(admin, path));
      assert.equal(board.success, true, JSON.stringify(board));
      assert.deepEqual(board.orders, [], `${path}: no row while the session collects`);
      assert.equal(board.total, 0, path);
      assert.equal(board.counts.total, 0, path);
    }
    const overview = await json(await get(admin, '/api/admin/overview'));
    assert.equal(overview.stats.orders_total, 0);
    assert.equal(overview.stats.orders_pending, 0);
    assert.equal(overview.stats.pending_wallet_requests, 0, 'a hold is not a wallet request');
    assert.deepEqual(overview.recent_orders ?? [], []);
    assert.equal(tg.toAdmin().length, 0, 'no admin message while the session collects');
    assert.equal(count(raw, 'SELECT COUNT(*) n FROM orders'), 0);

    // Not yet due: the minute tick leaves it alone.
    await minuteTick({ DB: asD1(raw), ...TELEGRAM_ENV } as unknown as Env);
    assert.equal(row<Row>(raw, `SELECT state FROM quick_buy_sessions WHERE id = ?`, opened.id)!.state, 'open');
    assert.equal(count(raw, 'SELECT COUNT(*) n FROM orders'), 0);

    // The 30 minutes end with every browser closed: the Worker's own schedule submits it.
    expire(raw);
    await minuteTick({ DB: asD1(raw), ...TELEGRAM_ENV } as unknown as Env);
    const s = row<Row>(raw, `SELECT * FROM quick_buy_sessions WHERE id = ?`, opened.id)!;
    assert.equal(s.state, 'submitted');
    const order = row<Row>(raw, 'SELECT * FROM orders WHERE id = ?', s.order_id)!;
    assert.ok(order, 'the reserved order id now exists');
    assert.equal(order.status, 'pending', 'the ordinary workflow, from its first status');
    assert.equal(order.payment_method_id, 'wallet');

    // The board: one ordinary row, in the default (open) scope and the counts.
    const board = await json(await get(admin, '/api/admin/orders'));
    assert.deepEqual(board.orders.map((o: Row) => o.id), [s.order_id]);
    assert.equal(board.orders[0].status, 'pending');
    assert.equal(board.total, 1);
    assert.equal(board.counts.total, 1);
    const after = await json(await get(admin, '/api/admin/overview'));
    assert.equal(after.stats.orders_total, 1);
    assert.equal(after.stats.orders_pending, 1);

    // One admin message: the ordinary new-order announcement, nothing Quick Buy about it.
    const told = tg.toAdmin();
    assert.equal(told.length, 1, JSON.stringify(told));
    assert.ok(told[0].text.includes(s.order_id), told[0].text);
    assert.doesNotMatch(told[0].text, /شراء سريع|Quick Buy/);

    // The money and the units moved under the order, exactly as a checkout's.
    assert.equal(count(raw, `SELECT COUNT(*) n FROM wallet_holds WHERE user_id = 'buyer' AND state = 'active'`), 0);
    assert.equal(count(raw, `SELECT COUNT(*) n FROM inventory_ledger WHERE order_id = ? AND kind = 'reserve'`, s.order_id), 1);
    assert.equal(row<Row>(raw, `SELECT stock_reserved FROM products WHERE id = 'p_pla'`)!.stock_reserved, 2);
  } finally {
    tg.restore();
  }
});

// ═══════════════════════════════════════════ 4. no setting moves

test('no setting moves: the fixed rules keep their numbers, stored settings and the customer’s Quick Buy settings come through a whole session unchanged, and nothing Quick Buy is an admin setting', async () => {
  // The fixed rules — code constants, never admin settings — as they were live.
  assert.equal(QUICK_BUY_WINDOW_MS, 30 * 60 * 1000);
  assert.equal(QUICK_BUY_MAX_LINES, 20);
  assert.equal(QUICK_BUY_MAX_QTY, 99);
  assert.equal(QUICK_BUY_FINALIZE_MAX_ATTEMPTS, 10);
  assert.equal(QUICK_BUY_LEASE_MS, 2 * 60 * 1000);
  assert.deepEqual(WALLET_FREE_DELIVERY_DEFAULT, {
    enabled: true,
    require_full_wallet: true,
    methods: ['standard'],
    rules: [
      { catalog_id: 'cat_printers', min_products_iqd: 500_000, enabled: true },
      { catalog_id: 'cat_materials_fdm', min_products_iqd: 0, enabled: true },
    ],
  });

  const raw = world();
  const before = settingsSnapshot(raw);
  const opened = await openSession(raw);
  // The stored waiver applied (filament from 40,000, paid in full from the wallet): its value is live.
  assert.equal(opened.shipping_iqd, 0);
  assert.equal(opened.free_delivery.applied, true);
  const profile = row<Row>(raw, `SELECT * FROM quick_buy_profiles WHERE user_id = 'buyer'`)!;
  assert.equal(profile.enabled, 1, 'the customer switched it on in their own Settings');

  expire(raw);
  await minuteTick({ DB: asD1(raw) } as unknown as Env);
  assert.equal(row<Row>(raw, `SELECT state FROM quick_buy_sessions WHERE id = ?`, opened.id)!.state, 'submitted');

  assert.deepEqual(settingsSnapshot(raw), before, 'no stored setting was written or rewritten');
  assert.deepEqual(row<Row>(raw, `SELECT * FROM quick_buy_profiles WHERE user_id = 'buyer'`), profile, 'the customer’s Quick Buy settings are untouched');
  const settings = (await json(await get(asAdmin(raw), '/api/admin/settings'))).settings as Record<string, unknown>;
  assert.deepEqual(settings.walletFreeDelivery, STORED_FREE_DELIVERY, 'the admin reads the stored value back as it was');
  assert.deepEqual(Object.keys(settings).filter((k) => /quick/i.test(k)), [], 'there is no Quick Buy admin setting');
  assert.ok(spendable(raw, 'buyer') > 0);

  // And no migration drops or reshapes the Quick Buy tables: holds, reservations and history stay.
  for (const f of readdirSync(join(ROOT, 'migrations')).filter((n) => n.endsWith('.sql'))) {
    assert.doesNotMatch(code(`migrations/${f}`), /DROP\s+TABLE\s+(IF\s+EXISTS\s+)?quick_buy_/i, f);
  }
});
