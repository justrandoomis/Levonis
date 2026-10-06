/**
 * «الشراء السريع» END TO END, against real migrations and the real checkout
 * (owner brief 2026-10-06 §3–§23, docs/GIFTS_QUICK_BUY.md §3, §5).
 *
 * The acceptance scenario of §23 step by step, then the races of §19. Every
 * assertion that matters is about MONEY and STOCK agreeing: what the wallet
 * holds equals what the session says, what is reserved equals what is in it,
 * and when the 30 minutes end exactly one ordinary order exists with exactly
 * the held money captured.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, patch, put, get, send, json, row, all, count, spendable } from './fixtures/app';
import { orderRoutes } from '../worker/routes/orders';
import { quickBuyRoutes, quickBuyAdminRoutes } from '../worker/routes/quickBuy';
import { adminRoutes } from '../worker/routes/admin';
import { QUICK_BUY_POLICY_KEYS, requiredPolicies } from '../worker/lib/policyOps';
import { finalizeDueQuickBuySessions } from '../worker/lib/quickBuy/finalize';
import type { Env } from '../worker/lib/types';

const RATE = 1400;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;
const cents = (iqd: number) => Math.ceil((iqd * 100) / RATE);

function world(fundIqd = 2_000_000): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'),
      ('other','Omar','o@x.co','h','customer'),
      ('boss','Boss','boss@x.co','h','admin');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default,governorate,area) VALUES
      ('addr','buyer','Home','Sara','+9647701234567','Karrada 12','Near the bridge',1,'Baghdad','Karrada'),
      ('addr2','buyer','Work','Sara','+9647701234567','Mansour 3','',0,'Baghdad','Mansour'),
      ('addr_o','other','Home','Omar','+9647701234568','Adhamiya 4','',1,'Baghdad','Adhamiya');
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,category_id,sub_category_id,sku) VALUES
      ('p_printer','a1-combo','A1 Combo','A1 كومبو',600000,'active',3,'[]','[]','direct_sale','["direct_sale"]','[]','[]','cat_printers','cat_printers_fdm','A1C'),
      ('p_pla','pla-basic','PLA Basic','PLA أساسي',25000,'active',10,'[]','[]','direct_sale','["direct_sale"]','[]','[]','cat_materials','cat_materials_fdm','PLA1'),
      ('p_nozzle','nozzle','Hardened nozzle','فوهة مقساة',8000,'active',1,'[]','[]','direct_sale','["direct_sale"]','[]','[]',NULL,NULL,'NZ1');
    INSERT INTO product_catalogs (product_id,catalog_id,position) VALUES
      ('p_printer','cat_printers_fdm',0), ('p_pla','cat_materials_fdm',0);
  `);
  if (fundIqd > 0) {
    raw.exec(`INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
              VALUES ('wt_fund','buyer','deposit','USD',${cents(fundIqd)},'approved','test funding')`);
  }
  raw.exec(`INSERT INTO wallet_transactions (id,user_id,type,currency,amount,status,note)
            VALUES ('wt_fund_o','other','deposit','USD',${cents(2_000_000)},'approved','test funding')`);
  return raw;
}

const mount = (a: Parameters<Parameters<typeof stubApp>[2]>[0]) => {
  a.route('/api/quick-buy', quickBuyRoutes);
  a.route('/api/orders', orderRoutes);
  a.route('/api/admin/quick-buy', quickBuyAdminRoutes);
  a.route('/api/admin', adminRoutes);
};
const as = (raw: DatabaseSync, id = 'buyer', role: 'customer' | 'admin' = 'customer') =>
  stubApp(asD1(raw), { id, role, email: `${id}@x.co` }, mount);

let seq = 0;
const key = () => `qb-test-key-${++seq}`;
const consent = () => requiredPolicies(QUICK_BUY_POLICY_KEYS);
const PRINTER_ACK = { accepted: true, version: 1 };

async function activate(raw: DatabaseSync, user = 'buyer', addressId = 'addr') {
  const res = await json(
    await post(as(raw, user), '/api/quick-buy/activate', {
      policyAcceptance: consent(),
      walletConsent: true,
      addressId,
      idempotencyKey: key(),
    })
  );
  assert.equal(res.success, true, JSON.stringify(res));
  return res.profile;
}

const add = (raw: DatabaseSync, productId: string, qty = 1, extra: Record<string, unknown> = {}, user = 'buyer') =>
  post(as(raw, user), '/api/quick-buy/items', { productId, qty, idempotencyKey: key(), ...extra });

const session = (raw: DatabaseSync, user = 'buyer') =>
  row<Row>(raw, `SELECT * FROM quick_buy_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`, user)!;
const activeHolds = (raw: DatabaseSync, user = 'buyer') =>
  all<{ id: string; amount_cents: number }>(raw, `SELECT id, amount_cents FROM wallet_holds WHERE user_id = ? AND state = 'active'`, user);
const reserved = (raw: DatabaseSync, productId: string) =>
  row<{ stock: number; stock_reserved: number }>(raw, 'SELECT stock, stock_reserved FROM products WHERE id = ?', productId)!;
const expire = (raw: DatabaseSync, user = 'buyer') =>
  raw
    .prepare(`UPDATE quick_buy_sessions SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') WHERE user_id = ? AND state = 'open'`)
    .run(user);
const cron = (raw: DatabaseSync) => {
  const waited: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { waited.push(p.catch(() => undefined)); }, passThroughOnException() {} } as unknown as ExecutionContext;
  return finalizeDueQuickBuySessions({ DB: asD1(raw) } as Env, ctx).then(async (out) => {
    await Promise.all(waited);
    return out;
  });
};

/** The one invariant every state must satisfy: the wallet holds exactly what the session says. */
function assertMoneyAgrees(raw: DatabaseSync, user = 'buyer') {
  const s = session(raw, user);
  const holds = activeHolds(raw, user);
  if (s.state === 'open') {
    assert.equal(holds.length, 1, 'an open session holds exactly one wallet hold');
    assert.equal(holds[0].id, s.hold_id);
    assert.equal(holds[0].amount_cents, s.held_cents);
  } else {
    assert.equal(holds.length, 0, `a ${s.state} session holds nothing`);
  }
}

// ═══════════════════════════════════════════ acceptance scenario 1 (§23)

test('§23 scenario 1: activate in two steps, printer, filament from another page, reduce, timer ends, captured, reserved under the order, free delivery', async () => {
  const raw = world();
  const walletBefore = spendable(raw, 'buyer');

  // Not active yet: a quick purchase is refused, never half-done.
  const early = await add(raw, 'p_printer', 1, { printerStandardDeliveryAcceptance: PRINTER_ACK });
  assert.equal(early.status, 409);
  assert.equal((await json(early)).code, 'QUICK_BUY_NOT_ACTIVE');

  // Step 1 refused without the wallet consent; step 1 + 2 accepted together.
  const noWallet = await post(as(raw), '/api/quick-buy/activate', { policyAcceptance: consent(), walletConsent: false, addressId: 'addr', idempotencyKey: key() });
  assert.equal(noWallet.status, 400);
  const profile = await activate(raw);
  assert.equal(profile.active, true);
  assert.equal(profile.address.id, 'addr');
  assert.equal(profile.consent.policy_version, consent().find((c) => c.key === 'quick_buy')!.version);
  assert.equal(count(raw, `SELECT COUNT(*) n FROM policy_acceptances WHERE user_id = 'buyer' AND context = 'quick_buy'`), 3);

  // The printer: a 30-minute session opens and the whole total is held.
  const first = await json(await add(raw, 'p_printer', 1, { printerStandardDeliveryAcceptance: PRINTER_ACK }));
  assert.equal(first.success, true, JSON.stringify(first));
  const s1 = first.session;
  assert.equal(s1.items.length, 1);
  assert.equal(s1.shipping_iqd, 0, 'printer ≥ 500,000 paid fully from the wallet: free standard delivery');
  assert.equal(s1.shipping_before_iqd, 10_000);
  assert.equal(s1.free_delivery.applied, true);
  assert.equal(s1.total_iqd, 600_000);
  assert.equal(s1.held_iqd, 600_000);
  const window = Date.parse(s1.expires_at) - Date.parse(s1.started_at);
  assert.equal(window, 30 * 60 * 1000);
  assert.ok(s1.remaining_ms > 29 * 60 * 1000);
  assert.equal(reserved(raw, 'p_printer').stock_reserved, 1, 'the printer is reserved for the session');
  assert.equal(walletBefore - spendable(raw, 'buyer'), session(raw).held_cents, 'available balance drops by the hold at once');
  assertMoneyAgrees(raw);

  // Filament ×3 from another page: the SAME session, the timer not reset.
  const second = await json(await add(raw, 'p_pla', 3));
  assert.equal(second.session.id, s1.id);
  assert.equal(second.session.expires_at, s1.expires_at, 'adding never extends the window');
  assert.equal(second.session.items.length, 2);
  assert.equal(second.session.total_iqd, 675_000);
  assert.equal(reserved(raw, 'p_pla').stock_reserved, 3);
  assertMoneyAgrees(raw);

  // Reduce the filament to 1: a partial release of money and stock.
  const plaLine = second.session.items.find((i: { product_id: string }) => i.product_id === 'p_pla');
  const reduced = await json(await patch(as(raw), `/api/quick-buy/items/${plaLine.id}`, { qty: 1, idempotencyKey: key() }));
  assert.equal(reduced.session.total_iqd, 625_000);
  assert.equal(reserved(raw, 'p_pla').stock_reserved, 1, 'two units back on the shelf');
  assertMoneyAgrees(raw);
  const trail = all<{ kind: string }>(raw, `SELECT kind FROM quick_buy_events WHERE session_id = ? ORDER BY created_at, rowid`, s1.id).map((e) => e.kind);
  assert.ok(trail.includes('unreserve') && trail.includes('release') && trail.includes('hold'));

  // Edits after the timer are refused; then the cron submits it with every browser closed.
  expire(raw);
  const late = await patch(as(raw), `/api/quick-buy/items/${plaLine.id}`, { qty: 2, idempotencyKey: key() });
  assert.equal(late.status, 409);
  assert.equal((await json(late)).code, 'QUICK_BUY_EXPIRED');
  await cron(raw);

  const s = session(raw);
  assert.equal(s.state, 'submitted');
  const order = row<Row>(raw, 'SELECT * FROM orders WHERE id = ?', s.order_id)!;
  assert.ok(order, 'exactly the reserved order id exists');
  assert.equal(order.order_kind, 'quick_buy');
  assert.equal(order.quick_buy_session_id, s.id);
  assert.equal(order.status, 'pending', 'an ordinary order in the normal workflow, visible to the admin');
  assert.equal(order.payment_method_id, 'wallet');
  assert.equal(order.total_iqd, 625_000);
  assert.equal(order.shipping_iqd, 0);
  assert.equal(order.shipping_before_benefit_iqd, 10_000);
  assert.equal(JSON.parse(order.benefit_snapshot).wallet_free_delivery.applied, true);
  assert.equal(order.due_on_delivery_iqd, 0);
  assert.equal(JSON.parse(order.address_snapshot).id, 'addr');
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM order_items WHERE order_id = ?', s.order_id), 2);
  // Money: hold gone, one debit of the order's own cents, nothing else.
  assertMoneyAgrees(raw);
  const debit = row<{ amount: number; amount_iqd: number }>(raw, `SELECT amount, amount_iqd FROM wallet_transactions WHERE ref = ? AND type = 'withdrawal'`, s.order_id)!;
  assert.equal(debit.amount_iqd, 625_000);
  assert.equal(walletBefore - spendable(raw, 'buyer'), debit.amount, 'the wallet lost exactly the order — captured from the hold, nothing more');
  // Stock: the same units, now held for the order exactly as a cart checkout holds them.
  assert.equal(reserved(raw, 'p_printer').stock_reserved, 1);
  assert.equal(reserved(raw, 'p_pla').stock_reserved, 1);
  assert.equal(count(raw, `SELECT COUNT(*) n FROM inventory_ledger WHERE order_id = ? AND kind = 'reserve'`, s.order_id), 2);
  // Consent recorded against the order, and the customer told.
  assert.equal(count(raw, `SELECT COUNT(*) n FROM policy_acceptances WHERE order_id = ? AND event = 'quick_buy.policy.accepted'`, s.order_id), 3);
  assert.equal(count(raw, `SELECT COUNT(*) n FROM user_notifications WHERE user_id = 'buyer' AND kind = 'quick_buy_submitted'`), 1);
  // The cart was never touched, and the customer's view says it was sent.
  const view = await json(await get(as(raw), '/api/quick-buy/session'));
  assert.equal(view.session, null);
  assert.equal(view.recent.state, 'submitted');
  assert.equal(view.recent.order.id, s.order_id);

  // A second tick, or a lazy finaliser, changes nothing.
  await cron(raw);
  assert.equal(count(raw, `SELECT COUNT(*) n FROM orders WHERE user_id = 'buyer'`), 1);
});

// ═══════════════════════════════════ §13: after 00:00 it is an ordinary order

test('§13: after 00:00 the order is ordinary — listed like any order, cancelled, refunded and restocked by Orders alone; confirmed, the normal rule refuses', async () => {
  const raw = world();
  const walletBefore = spendable(raw, 'buyer');
  await activate(raw);
  assert.equal((await json(await add(raw, 'p_pla', 2))).success, true);
  expire(raw);
  await cron(raw);
  const s = session(raw);
  assert.equal(s.state, 'submitted');
  const events = count(raw, 'SELECT COUNT(*) n FROM quick_buy_events WHERE session_id = ?', s.id);
  const notice = row<Row>(raw, `SELECT * FROM user_notifications WHERE user_id = 'buyer' AND kind = 'quick_buy_submitted'`)!;
  assert.match(notice.body_ar, /طلباً عادياً/);
  assert.equal(notice.link, `/orders/${s.order_id}`);

  // The customer's own list and detail: the same payload as any order; the kind is a label.
  const list = await json(await get(as(raw), '/api/orders'));
  const listed = list.orders.find((o: Row) => o.id === s.order_id);
  assert.ok(listed, 'listed with the ordinary orders');
  assert.equal(listed.status, 'pending');
  assert.equal(listed.order_kind, 'quick_buy');
  const detail = await json(await get(as(raw), `/api/orders/${s.order_id}`));
  assert.equal(detail.success, true, JSON.stringify(detail));
  assert.equal(detail.order.status, 'pending');

  // The normal cancel: refund to the wallet, stock back, nothing through Quick Buy.
  const cancelled = await post(as(raw), `/api/orders/${s.order_id}/cancel`, {});
  assert.equal(cancelled.status, 200, JSON.stringify(await json(cancelled.clone())));
  assert.equal(row<Row>(raw, 'SELECT status FROM orders WHERE id = ?', s.order_id)!.status, 'cancelled');
  assert.equal(spendable(raw, 'buyer'), walletBefore, 'the wallet is whole again');
  assert.equal(count(raw, `SELECT COUNT(*) n FROM wallet_transactions WHERE id = ?`, `wtx_refund_${s.order_id}_usd`), 1);
  assert.equal(reserved(raw, 'p_pla').stock_reserved, 0, 'the reservation went back with the order');
  assert.equal(session(raw).state, 'submitted', 'the Quick Buy session is history; Orders did the cancel');
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM quick_buy_events WHERE session_id = ?', s.id), events);
  assertMoneyAgrees(raw);
  const summary = await json(await get(as(raw, 'boss', 'admin'), '/api/admin/quick-buy/summary'));
  assert.equal(summary.refunded.n, 1, 'reports show the refund against Quick Buy');

  // A new purchase is a new session and a new order; once the admin confirms, the normal rule applies.
  assert.equal((await json(await add(raw, 'p_pla', 1))).success, true);
  const s2 = session(raw);
  assert.notEqual(s2.id, s.id);
  assert.notEqual(s2.order_id, s.order_id);
  expire(raw);
  await cron(raw);
  assert.equal((await patch(as(raw, 'boss', 'admin'), `/api/admin/orders/${s2.order_id}`, { status: 'confirmed' })).status, 200);
  const refused = await post(as(raw), `/api/orders/${s2.order_id}/cancel`, {});
  assert.equal(refused.status, 400);
  assert.equal((await json(refused)).code, 'ORDER_NOT_CANCELLABLE');
  assert.equal(row<Row>(raw, 'SELECT status FROM orders WHERE id = ?', s2.order_id)!.status, 'confirmed');
});

test('a product in an open Quick Buy order cannot be deleted under it; once submitted, the delete goes through and the session keeps its snapshot', async () => {
  const raw = world();
  await activate(raw);
  assert.equal((await json(await add(raw, 'p_pla', 1))).success, true);
  const admin = as(raw, 'boss', 'admin');

  const refused = await send(admin, 'DELETE', '/api/admin/products/p_pla');
  assert.equal(refused.status, 409);
  assert.equal((await json(refused)).code, 'PRODUCT_IN_QUICK_BUY');
  assert.ok(row(raw, `SELECT id FROM products WHERE id = 'p_pla'`), 'the product is still there');
  assertMoneyAgrees(raw);

  expire(raw);
  await cron(raw);
  const s = session(raw);
  assert.equal(s.state, 'submitted');
  const deleted = await send(admin, 'DELETE', '/api/admin/products/p_pla');
  assert.equal(deleted.status, 200, JSON.stringify(await json(deleted.clone())));
  assert.equal(row(raw, `SELECT id FROM products WHERE id = 'p_pla'`), undefined);
  // The closed session is history: its line and snapshot stay readable.
  const view = await json(await get(admin, `/api/admin/quick-buy/sessions/${s.id}`));
  assert.equal(view.session.items.length, 1);
  assert.match(view.session.items[0].name, /PLA/);
});

// ═══════════════════════════════════════════════════════ the races (§19)

test('double click and network retry: one key, one change, one hold', async () => {
  const raw = world();
  await activate(raw);
  const body = { productId: 'p_pla', qty: 1, idempotencyKey: 'same-key-double-click' };
  const [a, b] = await Promise.all([post(as(raw), '/api/quick-buy/items', body), post(as(raw), '/api/quick-buy/items', body)]);
  const ra = await json(a);
  const rb = await json(b);
  assert.equal(ra.success && rb.success, true, JSON.stringify([ra, rb]));
  const again = await json(await post(as(raw), '/api/quick-buy/items', body));
  assert.equal(again.replay, true);
  assert.equal(count(raw, `SELECT COALESCE(SUM(qty),0) n FROM quick_buy_items WHERE user_id = 'buyer'`), 1);
  assert.equal(reserved(raw, 'p_pla').stock_reserved, 1);
  assertMoneyAgrees(raw);
  const reused = await post(as(raw), '/api/quick-buy/items', { ...body, qty: 2 });
  assert.equal(reused.status, 409);
  assert.equal((await json(reused)).code, 'IDEMPOTENCY_KEY_REUSED');
});

test('two devices at once: never two sessions, money and stock always agree', async () => {
  const raw = world();
  await activate(raw);
  const results = await Promise.all([add(raw, 'p_pla', 1), add(raw, 'p_pla', 2), add(raw, 'p_nozzle', 1)]);
  const bodies = await Promise.all(results.map((r) => json(r)));
  for (const b of bodies) assert.ok(b.success || ['QUICK_BUY_BUSY', 'OUT_OF_STOCK'].includes(b.code), JSON.stringify(b));
  assert.equal(count(raw, `SELECT COUNT(*) n FROM quick_buy_sessions WHERE user_id = 'buyer' AND state = 'open'`), 1);
  const s = session(raw);
  const units = count(raw, `SELECT COALESCE(SUM(qty),0) n FROM quick_buy_items WHERE session_id = ? AND product_id = 'p_pla'`, s.id);
  assert.equal(reserved(raw, 'p_pla').stock_reserved, units);
  assertMoneyAgrees(raw);
});

test('an edit the clock overtakes inside its own request is rolled back whole', async () => {
  const raw = world();
  await activate(raw);
  await json(await add(raw, 'p_pla', 2));
  const before = session(raw);
  // The database's clock passes expires_at between the price check and the write.
  const db = asD1(raw) as unknown as { batch: (s: unknown[]) => Promise<unknown> };
  const realBatch = db.batch.bind(db);
  db.batch = async (stmts: unknown[]) => {
    expire(raw);
    return realBatch(stmts);
  };
  const app = stubApp(db, { id: 'buyer', role: 'customer', email: 'b@x.co' }, mount);
  const item = row<{ id: string }>(raw, 'SELECT id FROM quick_buy_items WHERE session_id = ?', before.id)!;
  const res = await patch(app, `/api/quick-buy/items/${item.id}`, { qty: 5, idempotencyKey: key() });
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'QUICK_BUY_EXPIRED');
  const after = session(raw);
  assert.equal(after.rev, before.rev, 'nothing moved');
  assert.equal(after.held_cents, before.held_cents);
  assert.equal(reserved(raw, 'p_pla').stock_reserved, 2);
  assertMoneyAgrees(raw);
});

test('sold out and insufficient balance refuse without holding anything', async () => {
  const raw = world(100_000);
  await activate(raw);
  const poor = await add(raw, 'p_printer', 1, { printerStandardDeliveryAcceptance: PRINTER_ACK });
  assert.equal(poor.status, 409);
  const body = await json(poor);
  assert.equal(body.code, 'QUICK_BUY_INSUFFICIENT_BALANCE');
  assert.equal(body.details.required_iqd, 600_000, 'the full price, free standard delivery included — the rule is how it is paid, not whether the balance suffices');
  // What the wallet really holds after the deposit's own cent conversion (within one cent).
  assert.ok(Math.abs(body.details.available_iqd - 100_000) <= 14, String(body.details.available_iqd));
  assert.equal(count(raw, 'SELECT COUNT(*) n FROM quick_buy_sessions'), 0);
  assert.equal(activeHolds(raw).length, 0);
  assert.equal(reserved(raw, 'p_printer').stock_reserved, 0);

  // One nozzle on the shelf; the other customer takes it first.
  await activate(raw, 'other', 'addr_o');
  assert.equal((await json(await add(raw, 'p_nozzle', 1, {}, 'other'))).success, true);
  const late = await add(raw, 'p_nozzle', 1);
  assert.equal(late.status, 400);
  const lateBody = await json(late);
  assert.equal(lateBody.code, 'OUT_OF_STOCK');
  assert.equal(lateBody.details.available, 0);
});

test('price and delivery changes after the add: the customer never pays more than was held', async () => {
  const raw = world();
  await activate(raw);
  await json(await add(raw, 'p_pla', 2));
  const held = session(raw).held_iqd;
  assert.equal(held, 50_000, 'filament from the wallet: free delivery');
  // The owner raises the price and switches the free delivery off mid-session.
  raw.exec(`UPDATE products SET price_iqd = 40000 WHERE id = 'p_pla'`);
  const admin = as(raw, 'boss', 'admin');
  const off = await put(admin, '/api/admin/settings/walletFreeDelivery', {
    value: { enabled: false, require_full_wallet: true, methods: ['standard'], rules: [] },
  });
  assert.equal(off.status, 200);
  expire(raw);
  await cron(raw);
  const s = session(raw);
  assert.equal(s.state, 'submitted');
  const order = row<Row>(raw, 'SELECT * FROM orders WHERE id = ?', s.order_id)!;
  assert.equal(order.total_iqd, 50_000, 'the locked unit price and the quoted delivery fee');
  assert.equal(order.shipping_iqd, 0);
  assertMoneyAgrees(raw);
});

test('a lower price at the end is honoured, and the address is the one frozen at the start', async () => {
  const raw = world();
  await activate(raw);
  await json(await add(raw, 'p_pla', 1));
  raw.exec(`UPDATE products SET price_iqd = 20000 WHERE id = 'p_pla'`);
  const moved = await json(await put(as(raw), '/api/quick-buy/profile', { addressId: 'addr2', idempotencyKey: key() }));
  assert.equal(moved.profile.address.id, 'addr2');
  expire(raw);
  await cron(raw);
  const s = session(raw);
  const order = row<Row>(raw, 'SELECT * FROM orders WHERE id = ?', s.order_id)!;
  assert.equal(order.total_iqd, 20_000);
  assert.equal(JSON.parse(order.address_snapshot).id, 'addr', 'a changed default applies to the next session only');
  const debit = row<{ amount_iqd: number }>(raw, `SELECT amount_iqd FROM wallet_transactions WHERE ref = ? AND type = 'withdrawal'`, s.order_id)!;
  assert.equal(debit.amount_iqd, 20_000, 'the remainder of the hold went back to the customer');
  assertMoneyAgrees(raw);
});

test('removing the last item, and cancelling everything, release every unit and every dinar', async () => {
  const raw = world();
  const before = spendable(raw, 'buyer');
  await activate(raw);
  const s1 = await json(await add(raw, 'p_pla', 2));
  const line = s1.session.items[0];
  const gone = await json(await send(as(raw), 'DELETE', `/api/quick-buy/items/${line.id}`, { idempotencyKey: key() }));
  assert.equal(gone.success, true);
  assert.equal(gone.session, null);
  assert.equal(session(raw).state, 'cancelled');
  assert.equal(reserved(raw, 'p_pla').stock_reserved, 0);
  assert.equal(spendable(raw, 'buyer'), before);
  assertMoneyAgrees(raw);

  await json(await add(raw, 'p_pla', 1));
  await json(await add(raw, 'p_nozzle', 1));
  const cancel = await json(await post(as(raw), '/api/quick-buy/session/cancel', { idempotencyKey: key() }));
  assert.equal(cancel.success, true);
  assert.equal(session(raw).state, 'cancelled');
  assert.equal(reserved(raw, 'p_pla').stock_reserved, 0);
  assert.equal(reserved(raw, 'p_nozzle').stock_reserved, 0);
  assert.equal(spendable(raw, 'buyer'), before);
  assert.equal(count(raw, `SELECT COUNT(*) n FROM orders WHERE user_id = 'buyer'`), 0);
});

test('a re-consent is required after a policy version moves, and direct sale only', async () => {
  const raw = world();
  await activate(raw);
  raw.exec(`UPDATE quick_buy_profiles SET policy_version = policy_version - 1 WHERE user_id = 'buyer'`);
  const res = await add(raw, 'p_pla', 1);
  assert.equal(res.status, 409);
  assert.equal((await json(res)).code, 'QUICK_BUY_RECONSENT_REQUIRED');
  await activate(raw);
  raw.exec(`UPDATE products SET composition = 'bundle' WHERE id = 'p_nozzle'`);
  const bundle = await add(raw, 'p_nozzle', 1);
  assert.equal(bundle.status, 409);
  assert.equal((await json(bundle)).code, 'QUICK_BUY_DIRECT_ONLY');
});

test('two finalisers at once make one order; the admin sees open sessions read-only until then', async () => {
  const raw = world();
  await activate(raw);
  await json(await add(raw, 'p_pla', 1));
  const admin = as(raw, 'boss', 'admin');
  const open = await json(await get(admin, '/api/admin/quick-buy/sessions?state=open'));
  assert.equal(open.sessions.length, 1);
  assert.equal(count(raw, `SELECT COUNT(*) n FROM orders`), 0, 'nothing reaches the order queue before the 30 minutes end');
  expire(raw);
  await Promise.all([cron(raw), cron(raw), get(as(raw), '/api/quick-buy/session')]);
  assert.equal(count(raw, `SELECT COUNT(*) n FROM orders WHERE user_id = 'buyer'`), 1);
  assert.equal(session(raw).state, 'submitted');
  assertMoneyAgrees(raw);
});

test('a session that cannot be submitted keeps its money held, fails after its retries, and the admin cancels or retries it', async () => {
  const raw = world();
  const before = spendable(raw, 'buyer');
  await activate(raw);
  await json(await add(raw, 'p_pla', 2));
  // The product is withdrawn mid-session: the order door refuses it every time.
  raw.exec(`UPDATE products SET status = 'draft' WHERE id = 'p_pla'`);
  expire(raw);
  for (let i = 0; i < 10; i++) {
    await cron(raw);
    raw.exec(`UPDATE quick_buy_sessions SET lease_until = NULL WHERE user_id = 'buyer'`);
  }
  const failed = session(raw);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.finalize_attempts, 10);
  assert.equal(count(raw, `SELECT COUNT(*) n FROM orders`), 0);
  assert.equal(activeHolds(raw).length, 1, 'the money is still held, never lost and never taken');
  assert.equal(reserved(raw, 'p_pla').stock_reserved, 2);
  assert.equal(count(raw, `SELECT COUNT(*) n FROM user_notifications WHERE user_id = 'buyer' AND kind = 'quick_buy_failed'`), 1);

  const admin = as(raw, 'boss', 'admin');
  const listed = await json(await get(admin, '/api/admin/quick-buy/sessions?state=failed'));
  assert.equal(listed.sessions.length, 1);
  const summary = await json(await get(admin, '/api/admin/quick-buy/summary'));
  assert.equal(summary.held_now.iqd, 50_000, 'held, and reported as held — not as revenue');
  assert.equal(summary.captured.iqd, 0);

  // Product back on sale: the admin's retry submits it as the ordinary order.
  raw.exec(`UPDATE products SET status = 'active' WHERE id = 'p_pla'`);
  const retried = await json(await post(admin, `/api/admin/quick-buy/sessions/${failed.id}/retry`, {}));
  assert.equal(retried.outcome.status, 'submitted', JSON.stringify(retried));
  assertMoneyAgrees(raw);
  const after = await json(await get(admin, '/api/admin/quick-buy/summary'));
  assert.equal(after.held_now.iqd, 0);
  assert.equal(after.captured.iqd, 50_000);
  assert.ok(after.orders_by_kind.some((k: { kind: string; n: number }) => k.kind === 'quick_buy' && k.n === 1));

  // A second customer's failed session is cancelled instead: everything comes back.
  await activate(raw, 'other', 'addr_o');
  const otherBefore = spendable(raw, 'other');
  await json(await add(raw, 'p_nozzle', 1, {}, 'other'));
  raw.exec(`UPDATE quick_buy_sessions SET state = 'failed', expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') WHERE user_id = 'other'`);
  const otherSession = session(raw, 'other');
  const cancelled = await post(admin, `/api/admin/quick-buy/sessions/${otherSession.id}/cancel`, {});
  assert.equal(cancelled.status, 200);
  assert.equal(session(raw, 'other').state, 'cancelled');
  assert.equal(spendable(raw, 'other'), otherBefore);
  assert.equal(reserved(raw, 'p_nozzle').stock_reserved, 0);
  assert.ok(spendable(raw, 'buyer') < before);
});

test('the order is never charged above the hold: a higher final total waits for the team instead', async () => {
  const raw = world();
  await activate(raw);
  await json(await add(raw, 'p_pla', 2));
  // As if a membership discount had lapsed in the window: the hold is now short.
  raw.exec(`UPDATE quick_buy_sessions SET held_iqd = held_iqd - 1000 WHERE user_id = 'buyer'`);
  expire(raw);
  const [outcome] = await cron(raw);
  assert.equal(outcome.status, 'retry');
  assert.equal((outcome as { code: string }).code, 'QUICK_BUY_TOTAL_ABOVE_HOLD');
  assert.equal(count(raw, `SELECT COUNT(*) n FROM orders`), 0);
  assert.equal(session(raw).state, 'open');
  assert.equal(activeHolds(raw).length, 1);
  assert.equal(reserved(raw, 'p_pla').stock_reserved, 2);
});

test('a retried removal of the last line replays instead of failing', async () => {
  const raw = world();
  await activate(raw);
  const s = await json(await add(raw, 'p_pla', 1));
  const body = { idempotencyKey: 'remove-last-line-once' };
  const first = await json(await send(as(raw), 'DELETE', `/api/quick-buy/items/${s.session.items[0].id}`, body));
  const again = await json(await send(as(raw), 'DELETE', `/api/quick-buy/items/${s.session.items[0].id}`, body));
  assert.equal(first.success, true);
  assert.equal(again.success, true, JSON.stringify(again));
  assert.equal(again.replay, true);
  assert.equal(session(raw).state, 'cancelled');
  assertMoneyAgrees(raw);
});
