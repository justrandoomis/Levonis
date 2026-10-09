/**
 * «الأرباح والتكاليف» IN DOLLARS — A DISPLAY, NEVER AN ACCOUNT (owner brief
 * 2026-10-09, "Accounting Currency"; design P-A §8 and §12).
 *
 * «عند اختيار USD: تغيير عرض فقط؛ لا تغير البيانات الأصلية… للسجلات التاريخية
 * استخدم exchange_rate_snapshot الخاص بوقت العملية… مثال: Actual Profit 320,000
 * IQD، USD/IQD وقت العملية 1,600 → Display $200، والقيمة المحاسبية الأصلية تبقى
 * 320,000 IQD».
 *
 * Pinned here: the IQD answer is byte-identical with or without the block; an
 * order converts at the SHOP's effective rate in force when it was CREATED
 * (never the wallet's 1,400, never today's when the log knows better); an
 * order older than the first applied rate falls back to today's, marked; no
 * applied rate (or no 0179) means no USD; cents are exact and derived
 * figures add up to the cent; the door, the 400 and the CSV are unchanged.
 *
 * Run: node --import tsx --test tests/financeUsdDisplay.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, dbThrough, freshDb, get, json, stubApp } from './fixtures/app';
import { adminFinanceWorkspaceRoutes } from '../worker/routes/adminFinanceWorkspace';
import { centsOf, iqdToCents, sumCents } from '../worker/lib/financeUsdDisplay';
import { usdRateAt } from '../worker/lib/fx/historyRate';

const OWNER = { id: 'boss', email: 'boss@x.co', role: 'admin' as const, admin_scope: 'full' };
const ASSISTANT = { id: 'helper', email: 'helper@x.co', role: 'admin' as const, admin_scope: 'assistant' };
const PERIOD = 'from=2026-03-01&to=2026-03-31';

function world(opts: { rates?: boolean; raw?: ReturnType<typeof freshDb> } = {}) {
  const raw = opts.raw ?? freshDb();
  raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES ('boss','boss@x.co','Owner','admin','full'),('helper','helper@x.co','Helper','admin','assistant'),('buyer','buyer@x.co','Buyer','customer',NULL);
    INSERT INTO products(id,name,slug,price_iqd,product_cost_iqd) VALUES ('p','Printer','usd-display-printer',320000,1);
    INSERT OR REPLACE INTO admin_settings(key,value) VALUES ('exchangeRate','1400');`);
  const order = (id: string, created: string, delivered: string, goods: number, cost: number) => {
    raw.prepare(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,shipping_iqd,created_at,delivered_at)
      VALUES (?,'buyer','delivered','{}','standard','{}','cash',?,1400,?,?,0,?,?)`).run(id, goods, goods, goods, created, delivered);
    raw.prepare(`INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES (?,?,'p','Printer',1,?,?,?,'snapshot')`).run(`${id}:1`, id, goods, goods, cost);
  };
  // Created 28 Feb — BEFORE the range — and delivered inside it (L6): its rate is February's.
  order('feb', '2026-02-28T10:00:00.000Z', '2026-03-05T10:00:00.000Z', 320000, 0);
  // Created after the March change.
  order('late', '2026-03-25T10:00:00.000Z', '2026-03-26T10:00:00.000Z', 165000, 99001);
  // Created before the first applied rate: today's, marked «≈».
  order('old', '2026-01-10T10:00:00.000Z', '2026-03-06T10:00:00.000Z', 33000, 16501);
  if (opts.rates !== false) {
    raw.exec(`UPDATE fx_rate_pairs SET effective_rate='1650', effective_version=1, drift_anchor_rate='1650', effective_source='provider' WHERE pair='USD_IQD';
      INSERT INTO fx_rate_log(id,pair,event,trigger_kind,effective_before,effective_after,result,created_at) VALUES
        ('l1','USD_IQD','review_approved','owner',NULL,'1600','APPLIED','2026-02-01T00:00:00.000Z'),
        ('l2','USD_IQD','check','cron','1600','1600','UNCHANGED','2026-02-15T00:00:00.000Z'),
        ('l3','USD_IQD','apply','cron','1600','1650','APPLIED','2026-03-20T00:00:00.000Z');`);
  }
  const app = (user = OWNER) => stubApp(asD1(raw), user, (a) => a.route('/f', adminFinanceWorkspaceRoutes));
  return { raw, app };
}
const read = async (app: ReturnType<ReturnType<typeof world>['app']>, path: string) => {
  const res = await get(app, path);
  const body = await json(res);
  assert.equal(res.status, 200, `${path}: ${JSON.stringify(body)}`);
  return body;
};

test('cents are exact: 320,000 at 1,600 is $200.00, half away from zero both ways, a fractional rate, null for unusable input', () => {
  assert.equal(iqdToCents(320000, '1600'), 20000);
  assert.equal(iqdToCents(-1250, '2000'), -63, '−62.5 cents rounds away from zero');
  assert.equal(iqdToCents(1250, '2000'), 63);
  assert.equal(iqdToCents(-1250, '1600'), -78, '−78.125 is −78');
  assert.equal(iqdToCents(1612, '1612.5'), 100, '1612 / 1612.5 = 0.99969 → 100 cents');
  assert.equal(iqdToCents(null, '1600'), null);
  assert.equal(iqdToCents(1.5, '1600'), null);
  assert.equal(iqdToCents(100, 'abc'), null);
  // Derived from the cents, so revenue − cost = profit to the cent even where
  // converting each figure alone would not (1 + 1 ≠ 3 at a third of a cent).
  const c = centsOf({ net_goods_iqd: 25, refund_iqd: 0, cogs_iqd: 8, retained_revenue_iqd: 25, gross_profit_iqd: 17 }, '1600');
  assert.equal(c.gross_profit_cents, c.retained_revenue_cents! - c.cogs_cents!);
  assert.deepEqual(sumCents([{ a_cents: 1 }, { a_cents: null }]), { a_cents: null }, 'a null makes the column «—»');
});

test('the rate in force at a moment: the last change at or before it; before the first, today\'s; none at all, none', () => {
  const steps = { steps: [{ at: 100, rate: '1600' }, { at: 200, rate: '1650' }], today: '1650' };
  assert.deepEqual(usdRateAt(steps, 150), { rate: '1600', basis: 'at_time' });
  assert.deepEqual(usdRateAt(steps, 200), { rate: '1650', basis: 'at_time' });
  assert.deepEqual(usdRateAt(steps, 50), { rate: '1650', basis: 'today' });
  assert.deepEqual(usdRateAt(steps, null), { rate: '1650', basis: 'today' });
  assert.equal(usdRateAt({ steps: [], today: null }, 150), null);
  assert.equal(usdRateAt(null, 150), null);
});

test('display=USD leaves every IQD field deep-equal and adds one block: each order at the shop\'s rate when it was created, never the wallet\'s', async () => {
  const { app } = world();
  for (const path of [`/f/summary?${PERIOD}`, `/f/orders?${PERIOD}`, '/f/orders/feb']) {
    const iqd = await read(app(), path);
    const usd = await read(app(), `${path}${path.includes('?') ? '&' : '?'}display=USD`);
    const { display_usd, ...rest } = usd;
    assert.ok(display_usd, path);
    assert.deepEqual(rest, iqd, `${path}: the IQD answer is unchanged`);
    assert.equal(iqd.display_usd, undefined);
    assert.deepEqual(await read(app(), `${path}${path.includes('?') ? '&' : '?'}display=IQD`), iqd, 'display=IQD is the default');
  }

  const s = await read(app(), `/f/summary?${PERIOD}&display=USD`);
  const u = s.display_usd;
  assert.equal(u.available, true);
  assert.equal(u.today_rate, '1650');
  // Created 28 Feb at 1,600 although delivered in March after nothing changed then — not 1,400, not 1,650.
  assert.deepEqual({ basis: u.orders.feb.usd_basis, rate: u.orders.feb.fx_rate_snapshot }, { basis: 'at_time', rate: '1600' });
  assert.equal(u.orders.feb.cents.net_goods_cents, 20000, '320,000 at 1,600 → $200.00');
  assert.equal(u.orders.feb.cents.gross_profit_cents, 20000);
  assert.deepEqual({ basis: u.orders.late.usd_basis, rate: u.orders.late.fx_rate_snapshot }, { basis: 'at_time', rate: '1650' });
  assert.deepEqual({ basis: u.orders.old.usd_basis, rate: u.orders.old.fx_rate_snapshot }, { basis: 'today', rate: '1650' });
  assert.equal(u.at_time_count, 2);
  assert.equal(u.today_count, 1);
  assert.equal(u.approximate, true);
  assert.doesNotMatch(JSON.stringify(u), /"1400"|:1400\b/, 'the wallet rate is nowhere');

  // Every row: gross = retained revenue − COGS, to the cent; groups and totals are sums of rows.
  for (const o of Object.values(u.orders) as Array<{ cents: Record<string, number> }>) {
    assert.equal(o.cents.gross_profit_cents, o.cents.retained_revenue_cents - o.cents.cogs_cents);
    assert.equal(o.cents.retained_revenue_cents, o.cents.net_goods_cents - o.cents.refund_cents);
  }
  const ordersSum = (Object.values(u.orders) as Array<{ cents: Record<string, number> }>).reduce((v, o) => v + o.cents.net_goods_cents, 0);
  assert.equal(u.totals.net_goods_cents, ordersSum);
  assert.equal(u.products.p.net_goods_cents, ordersSum);
  assert.equal(u.kinds.normal.net_goods_cents, ordersSum);
  assert.equal(u.totals.owner_period_net_cents, u.totals.owner_net_cents - u.totals.general_expenses_cents - u.totals.unallocated_promotion_cents);
  assert.equal(u.chart.daily['2026-03-05'].revenue_cents, 20000);
  // Margins and every IQD figure stay what they were.
  assert.equal(s.totals.net_goods_iqd, 320000 + 165000 + 33000);

  const detail = await read(app(), '/f/orders/late?display=USD');
  assert.equal(detail.display_usd.usd_basis, 'at_time');
  assert.equal(detail.display_usd.fx_rate_snapshot, '1650');
  const line = detail.display_usd.lines['late:1'];
  assert.equal(line.net_goods_cents, 10000, '165,000 at 1,650');
  assert.equal(line.cogs_cents, iqdToCents(99001, '1650'));
  assert.equal(line.gross_profit_cents, line.net_goods_cents - line.cogs_cents);
});

test('no applied rate → USD unavailable; no 0179 → unavailable, never an error', async () => {
  const none = world({ rates: false });
  for (const path of [`/f/summary?${PERIOD}&display=USD`, `/f/orders?${PERIOD}&display=USD`, '/f/orders/feb?display=USD']) {
    assert.deepEqual((await read(none.app(), path)).display_usd, { available: false }, path);
  }
  const behind = world({ rates: false, raw: dbThrough('0178') });
  assert.deepEqual((await read(behind.app(), `/f/summary?${PERIOD}&display=USD`)).display_usd, { available: false });
  assert.equal((await read(behind.app(), '/f/promotions?month=2026-03')).rate_suggestion, null);
});

test('the door is the owner\'s, an unknown display is 400, the CSV stays IQD, and the promotion suggestion is the shop\'s rate on the month\'s first day', async () => {
  const { app } = world();
  const refused = await get(app(ASSISTANT), `/f/summary?${PERIOD}&display=USD`);
  assert.equal(refused.status, 403);
  assert.equal((await json(refused)).code, 'COST_ACCESS_DENIED');
  for (const bad of ['EUR', 'usd', '1']) {
    const res = await get(app(), `/f/summary?${PERIOD}&display=${bad}`);
    assert.equal(res.status, 400, bad);
    assert.equal((await json(res)).code, 'DISPLAY_CURRENCY_INVALID');
  }
  const csv = await (await get(app(), `/f/export.csv?${PERIOD}&display=USD`)).text();
  assert.match(csv, /320000/);
  assert.doesNotMatch(csv, /\$|_cents|20000\.00/);
  const promotions = await read(app(), '/f/promotions?month=2026-03');
  assert.deepEqual(promotions.rate_suggestion, { rate: '1600', date: '2026-03-01', usd_basis: 'at_time' });
  assert.deepEqual((await read(app(), '/f/promotions?month=2026-01')).rate_suggestion, { rate: '1650', date: '2026-01-01', usd_basis: 'today' });
});
