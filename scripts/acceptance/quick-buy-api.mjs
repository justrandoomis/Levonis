/**
 * Scenario 1 (§23) over HTTP against the REAL local Worker and D1: every
 * money and stock figure is read back from the database, not from the
 * responses alone. Run with the stack started (stack.mjs start).
 */
import { BASE, TOKENS, sql } from './stack.mjs';
const REPO = process.argv[2];
let passed = 0, failed = 0;
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ok  ${name}`); } else { failed++; console.log(`FAIL  ${name} ${extra}`); } };
// A dropped connection is retried ONCE with the very same body — the same
// idempotency key — which is exactly what the app does on a network failure.
let retries = 0;
const call = async (who, method, path, body, attempt = 0) => {
  let res;
  try {
    res = await fetch(BASE + path, {
      method, headers: { cookie: `levonis_session=${TOKENS[who]}`, 'content-type': 'application/json', origin: BASE, connection: 'close' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    if (attempt > 0) throw e;
    retries++;
    return call(who, method, path, body, 1);
  }
  let data = null; try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
};
const key = (() => { let n = 0; const run = Date.now().toString(36); return () => `e2e-${run}-${++n}`; })();
const one = (q) => sql(REPO, q)[0] ?? null;
const spendableCents = () => {
  const r = one(`SELECT
      (SELECT COALESCE(SUM(CASE WHEN type='deposit' THEN amount ELSE -amount END),0) FROM wallet_transactions WHERE user_id='u_sara' AND currency='USD' AND status='approved')
    - (SELECT COALESCE(SUM(amount_cents),0) FROM wallet_holds WHERE user_id='u_sara' AND state='active') AS c`);
  return Number(r.c);
};

const before = spendableCents();
console.log(`spendable before: ${before} cents`);

// 1. Not active → refused.
let r = await call('sara', 'POST', '/api/quick-buy/items', { productId: 'p_e2e_pla', qty: 1, idempotencyKey: key() });
check('a buy before activation is refused', r.status === 409 && r.data?.code === 'QUICK_BUY_NOT_ACTIVE', JSON.stringify(r));

// 2. Activate in two steps (consent + address).
r = await call('sara', 'GET', '/api/quick-buy/profile');
const req = r.data?.profile?.required ?? {};
check('the profile names the versions to accept', req.terms > 0 && req.privacy > 0 && req.quick_buy > 0, JSON.stringify(r.data));
r = await call('sara', 'POST', '/api/quick-buy/activate', {
  policyAcceptance: [{ key: 'terms', version: req.terms }, { key: 'privacy', version: req.privacy }, { key: 'quick_buy', version: req.quick_buy }],
  walletConsent: true, addressId: 'addr_home', idempotencyKey: key(),
});
check('activation with consent + address', r.status === 200 && r.data?.profile?.active === true, JSON.stringify(r));

// 3. The printer: the session opens, the whole total is held.
r = await call('sara', 'POST', '/api/quick-buy/items', { productId: 'p_e2e_printer', qty: 1, idempotencyKey: key(), printerStandardDeliveryAcceptance: { accepted: true, version: 1 } });
check('printer bought with Quick Buy', r.status === 200 && r.data?.session?.items?.length === 1, JSON.stringify(r).slice(0, 400));
const s1 = r.data?.session ?? {};
check('free standard delivery applies (printer ≥ 500,000, wallet)', s1.shipping_iqd === 0 && s1.free_delivery?.applied === true, JSON.stringify({ shipping: s1.shipping_iqd, before: s1.shipping_before_iqd, fd: s1.free_delivery }));
check('30-minute window', Date.parse(s1.expires_at) - Date.parse(s1.started_at) === 30 * 60 * 1000);
check('the wallet holds the total', s1.held_iqd === s1.total_iqd && s1.total_iqd === 600000, JSON.stringify({ held: s1.held_iqd, total: s1.total_iqd }));
let row = one(`SELECT stock_reserved FROM products WHERE id='p_e2e_printer'`);
check('the printer is reserved in D1', Number(row.stock_reserved) === 1, JSON.stringify(row));

// 4. Filament ×3 from another page: same session, window not extended.
r = await call('sara', 'POST', '/api/quick-buy/items', { productId: 'p_e2e_pla', qty: 3, idempotencyKey: key() });
const s2 = r.data?.session ?? {};
check('filament joins the same session', s2.id === s1.id && s2.items?.length === 2 && s2.expires_at === s1.expires_at, JSON.stringify(r).slice(0, 300));
check('total 675,000 held', s2.total_iqd === 675000 && s2.held_iqd === 675000);

// 5. Reduce filament to 1: partial release.
const pla = s2.items.find((i) => i.product_id === 'p_e2e_pla');
r = await call('sara', 'PATCH', `/api/quick-buy/items/${pla.id}`, { qty: 1, idempotencyKey: key() });
check('reduced to 625,000', r.data?.session?.total_iqd === 625000 && r.data?.session?.held_iqd === 625000, JSON.stringify(r).slice(0, 300));
row = one(`SELECT stock_reserved FROM products WHERE id='p_e2e_pla'`);
check('two filament units back on the shelf', Number(row.stock_reserved) === 1, JSON.stringify(row));
const holds = sql(REPO, `SELECT amount_cents FROM wallet_holds WHERE user_id='u_sara' AND state='active'`);
const sess = one(`SELECT held_cents, hold_id, order_id FROM quick_buy_sessions WHERE user_id='u_sara' AND state='open'`);
check('one active hold equal to the session', holds.length === 1 && Number(holds[0].amount_cents) === Number(sess.held_cents), JSON.stringify({ holds, sess }));
check('spendable dropped by exactly the hold', before - spendableCents() === Number(sess.held_cents));

// 6. Double click: same key twice → one change.
const k = key();
const [a, b] = await Promise.all([
  call('sara', 'PATCH', `/api/quick-buy/items/${pla.id}`, { qty: 2, idempotencyKey: k }),
  call('sara', 'PATCH', `/api/quick-buy/items/${pla.id}`, { qty: 2, idempotencyKey: k }),
]);
check('double click: both answered', [a.status, b.status].every((x) => x === 200 || x === 409), JSON.stringify([a.status, b.status, a.data?.code, b.data?.code]));
row = one(`SELECT SUM(qty) q FROM quick_buy_items WHERE session_id='${s1.id}' AND product_id='p_e2e_pla'`);
check('double click: one change only', Number(row.q) === 2, JSON.stringify(row));
r = await call('sara', 'PATCH', `/api/quick-buy/items/${pla.id}`, { qty: 1, idempotencyKey: key() });
check('back to one filament', r.data?.session?.total_iqd === 625000);

// 7. Time runs out; the MINUTE CRON submits it — no request of the customer's
//    is made until it has (wrangler's scheduled handler, not the SPA path).
sql(REPO, `UPDATE quick_buy_sessions SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') WHERE id = '${s1.id}'`);
const cron = await fetch(`${BASE}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent('* * * * *')}`);
check('the minute cron ran', cron.status === 200, String(cron.status));
let done = null;
for (let i = 0; i < 20; i++) { done = one(`SELECT state, order_id, finalize_attempts FROM quick_buy_sessions WHERE id = '${s1.id}'`); if (done.state !== 'open') break; await new Promise((res) => setTimeout(res, 500)); }
check('session submitted by the cron alone (one attempt)', done.state === 'submitted' && Number(done.finalize_attempts) === 1, JSON.stringify(done));
r = await call('sara', 'PATCH', `/api/quick-buy/items/${pla.id}`, { qty: 3, idempotencyKey: key() });
check('an edit after 00:00 is refused', r.status === 409 || r.status === 404, JSON.stringify(r));
const order = one(`SELECT id, status, order_kind, total_iqd, shipping_iqd, shipping_before_benefit_iqd, payment_method_id, due_on_delivery_iqd FROM orders WHERE id = '${done.order_id}'`);
check('an ordinary pending order, kind quick_buy', order?.status === 'pending' && order?.order_kind === 'quick_buy', JSON.stringify(order));
check('order total 625,000, delivery 0 of 10,000 (wallet waiver), nothing due on delivery',
  Number(order?.total_iqd) === 625000 && Number(order?.shipping_iqd) === 0 && Number(order?.due_on_delivery_iqd) === 0, JSON.stringify(order));
const debit = one(`SELECT amount, amount_iqd FROM wallet_transactions WHERE ref = '${done.order_id}' AND type = 'withdrawal'`);
check('captured: one debit of 625,000 IQD', Number(debit?.amount_iqd) === 625000, JSON.stringify(debit));
check('no hold left', sql(REPO, `SELECT 1 FROM wallet_holds WHERE user_id='u_sara' AND state='active'`).length === 0);
check('spendable fell by exactly the order', before - spendableCents() === Number(debit?.amount), JSON.stringify({ before, now: spendableCents(), debit }));
const reservedNow = sql(REPO, `SELECT id, stock, stock_reserved FROM products WHERE id IN ('p_e2e_printer','p_e2e_pla') ORDER BY id`);
check('stock reserved under the order (printer 1, filament 1)', reservedNow.every((p) => Number(p.stock_reserved) === 1), JSON.stringify(reservedNow));
const ledger = one(`SELECT COUNT(*) n FROM inventory_ledger WHERE order_id = '${done.order_id}' AND kind = 'reserve'`);
check('the reservation is the order\'s', Number(ledger.n) === 2, JSON.stringify(ledger));

// 8. The admin sees it in the normal list, labelled.
r = await call('owner', 'GET', '/api/admin/orders?scope=all&kind=quick_buy');
check('admin lists it under Quick Buy', (r.data?.orders ?? []).some((o) => o.id === done.order_id), JSON.stringify(r).slice(0, 300));
r = await call('owner', 'GET', '/api/admin/quick-buy/summary');
check('admin summary: captured once, released ≥ 1', r.data?.captured?.n === 1 && r.data?.released?.n >= 1, JSON.stringify(r.data));

// 9. The customer: an ordinary order; the bell says so.
r = await call('sara', 'GET', '/api/orders');
check('in the customer\'s order list', (r.data?.orders ?? []).some((o) => o.id === done.order_id && o.order_kind === 'quick_buy'));
const notice = one(`SELECT title_ar, body_ar, link FROM user_notifications WHERE user_id='u_sara' AND kind='quick_buy_submitted'`);
check('notified: «… أصبح طلبك … طلباً عادياً»', /طلباً عادياً/.test(notice?.body_ar ?? '') && notice?.link === `/orders/${done.order_id}`, JSON.stringify(notice));
r = await call('sara', 'GET', '/api/wallet');
const tx = (r.data?.transactions ?? []).find((t) => t.ref === done.order_id);
check('wallet row labelled quick_buy', tx?.order_kind === 'quick_buy', JSON.stringify(tx));

console.log(`\n${passed} passed, ${failed} failed (${retries} dropped connection(s) retried with the same key)`);
process.exit(failed ? 1 : 0);
