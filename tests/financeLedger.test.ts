/**
 * THE COST BASIS OF A SALE, AND THE LEDGER THAT IS NOT A PRODUCT COST.
 *
 * Four things are proven here, and each one is a defect this change would
 * otherwise ship:
 *
 *  1. THE COST AT THE MOMENT OF SALE IS WRITTEN DOWN. Before migration 0095 it
 *     was recorded nowhere — worker/routes/orders.ts stripped `cost_iqd` out of
 *     the persisted pricing snapshot (rightly: that snapshot is served back to
 *     the buyer) and `order_items` had no cost column — so profit could only be
 *     computed against the product's CURRENT cost, and one edit to a supplier
 *     price silently rewrote the profit of sales already banked. The test buys,
 *     then TRIPLES the cost in the catalogue, and the order's recorded cost
 *     must not move.
 *
 *  2. THE COST STILL NEVER REACHES THE CUSTOMER. It moved from "not stored" to
 *     "stored on a column no customer-facing serializer selects", and that is
 *     the single most likely way this change causes harm. The whole customer
 *     payload is searched for the number and for the field name.
 *
 *  3. THE ESTIMATE FLAG IS SET EXACTLY WHEN THERE IS NO SNAPSHOT. A row whose
 *     profit would be computed against today's catalogue is an ESTIMATE and
 *     must be flagged as one in the DATA, not only in a comment, so the
 *     dashboard can label it «تقدير». An estimate presented as a fact is the
 *     failure the whole track exists to prevent.
 *
 *  4. AN ASSISTANT ADMIN IS REFUSED ON EVERY EXPENSE ROUTE. §11: «cost وجميع
 *     تفاصيل الربح متاحة فقط للمالك/الدور المالي. مساعد الأدمن العادي لا يراها
 *     في API ولا في HTML ولا في export». Knowing the shop's rent and salaries
 *     IS its cost base. Every method and every path, not a sample.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, stubApp, post, patch, get, send, json, all, row, type StubUser } from './fixtures/app';
import { cartRoutes } from '../worker/routes/cart';
import { orderRoutes } from '../worker/routes/orders';
import { adminFinanceRoutes } from '../worker/routes/adminFinance';
import { telegramRoutes } from '../worker/routes/telegram';
import { addBundle, seedCatalogue, orderBody } from './lib/bundles';
import { addMysteryOffer, seedMysteryPool, POOL_PRODUCTS } from './lib/mysteryOffer';
import {
  COST_BASIS,
  costConfidenceOf,
  costProjectionSql,
  costSnapshot,
  expenseSeriesDays,
  expenseSlug,
} from '../worker/lib/financeLedger';

const buyer: StubUser = { id: 'buyer', role: 'customer', email: 's@x.co' };
const shopApp = (db: unknown) =>
  stubApp(db, buyer, (a) => {
    a.route('/api/cart', cartRoutes);
    a.route('/api/orders', orderRoutes);
  });

/** The owner: INITIAL_ADMIN_EMAIL in the fixture, so always financial. */
const owner: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };
/** An admin assistant: an administrator with no financial scope at all. */
const assistant: StubUser = { id: 'helper', role: 'admin', email: 'help@x.co', admin_scope: 'assistant' };

const financeApp = (db: unknown, who: StubUser) =>
  stubApp(db, who, (a) => {
    a.route('/api/admin/finance', adminFinanceRoutes);
  });

interface ItemCostRow {
  id: string;
  product_id: string | null;
  cost_iqd: number | null;
  cost_basis: string;
  bundle_parent_item_id: string | null;
}
const itemCosts = (raw: DatabaseSync, orderId: string) =>
  all<ItemCostRow>(
    raw,
    'SELECT id, product_id, cost_iqd, cost_basis, bundle_parent_item_id FROM order_items WHERE order_id = ? ORDER BY rowid',
    orderId
  );

// ═══════════════════════════════════════════ 1 & 2 — the snapshot, and the leak

test('the unit cost at the moment of sale is written onto the order item, and does not move afterwards', async () => {
  const raw = seedCatalogue();
  // 25,000 sells for a cost of 9,000 today. Tomorrow the supplier price moves.
  raw.exec("UPDATE products SET product_cost_iqd = 9000 WHERE id = 'p_pla'");
  const db = asD1(raw);

  const added = await json(await post(shopApp(db), '/api/cart/items', { productId: 'p_pla', qty: 2 }));
  assert.equal(added.success, true, JSON.stringify(added));
  const placed = await json(await post(shopApp(db), '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed));
  const orderId = placed.order.id as string;

  const before = itemCosts(raw, orderId);
  assert.equal(before.length, 1);
  assert.equal(before[0].cost_iqd, 9000, 'the resolved cost must be frozen onto the row');
  assert.equal(before[0].cost_basis, COST_BASIS.snapshot);

  // THE CATALOGUE MOVES UNDER THE SOLD ORDER — the exact event that used to
  // rewrite last month's profit.
  raw.exec("UPDATE products SET product_cost_iqd = 27000, price_iqd = 90000 WHERE id = 'p_pla'");
  const after = itemCosts(raw, orderId);
  assert.equal(after[0].cost_iqd, 9000, 'a supplier price edited today must not rewrite a sale already made');
  assert.equal(after[0].cost_basis, COST_BASIS.snapshot);
});

test('the stored cost never reaches the customer — not in the order payload, not in the snapshot', async () => {
  const raw = seedCatalogue();
  // A cost nobody could mistake for a price, a quantity or a total, so a match
  // anywhere in the payload is unambiguous.
  raw.exec("UPDATE products SET product_cost_iqd = 7431 WHERE id = 'p_pla'");
  const db = asD1(raw);
  await post(shopApp(db), '/api/cart/items', { productId: 'p_pla', qty: 1 });
  const placed = await json(await post(shopApp(db), '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed));
  const orderId = placed.order.id as string;

  // It IS on the row…
  assert.equal(itemCosts(raw, orderId)[0].cost_iqd, 7431);

  // …and it is in NONE of the three customer surfaces: the checkout response,
  // the order detail, and the order list.
  const detail = await json(await get(shopApp(db), `/api/orders/${orderId}`));
  assert.equal(detail.success, true, JSON.stringify(detail));
  const list = await json(await get(shopApp(db), '/api/orders'));
  for (const [label, payload] of [
    ['checkout response', placed],
    ['order detail', detail],
    ['order list', list],
  ] as const) {
    const text = JSON.stringify(payload);
    assert.equal(text.includes('7431'), false, `${label} leaked the cost VALUE`);
    assert.equal(text.includes('cost_iqd'), false, `${label} leaked the cost FIELD`);
    assert.equal(text.includes('cost_basis'), false, `${label} leaked the cost basis`);
  }

  // The persisted pricing snapshot is the one the customer is served verbatim,
  // so the strip in orders.ts must still be doing its job.
  const stored = row<{ pricing_snapshot: string }>(
    raw,
    'SELECT pricing_snapshot FROM order_items WHERE order_id = ?',
    orderId
  );
  assert.equal(String(stored?.pricing_snapshot).includes('cost_iqd'), false, 'the snapshot must stay cost-free');
});

// ═════════════════════════════════════════════════ 3 — the estimate flag

test('the basis is `unpriced` when the sale found no cost, and `unrecorded` for a pre-0095 row', async () => {
  const raw = seedCatalogue();
  // p_nozzle deliberately keeps product_cost_iqd NULL.
  const db = asD1(raw);
  await post(shopApp(db), '/api/cart/items', { productId: 'p_nozzle', qty: 1 });
  const placed = await json(await post(shopApp(db), '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed));
  const sold = itemCosts(raw, placed.order.id as string)[0];
  assert.equal(sold.cost_iqd, null);
  assert.equal(
    sold.cost_basis,
    COST_BASIS.unpriced,
    'a sale that found no cost is a RECORDED absence, not a gap in our records'
  );

  // A ROW WRITTEN BEFORE THIS MIGRATION: the INSERT names no cost column, so
  // the ALTER's DEFAULT decides — and it must decide `unrecorded`, the only
  // value the dashboard is allowed to estimate against today's catalogue.
  raw.exec(`
    INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd)
    VALUES ('oi_legacy', '${placed.order.id}', 'p_pla', 'Old sale', 1, 25000, 25000)
  `);
  const legacy = row<ItemCostRow>(raw, "SELECT * FROM order_items WHERE id = 'oi_legacy'");
  assert.equal(legacy?.cost_iqd, null);
  assert.equal(legacy?.cost_basis, COST_BASIS.unrecorded);

  // And the four bases resolve to the three confidences the screen must
  // distinguish. `unpriced` is UNKNOWN even when the product has a cost today:
  // that number was typed after the sale.
  assert.equal(costConfidenceOf(COST_BASIS.snapshot, null), 'recorded');
  assert.equal(costConfidenceOf(COST_BASIS.composed, 9000), 'recorded');
  assert.equal(costConfidenceOf(COST_BASIS.unpriced, 9000), 'unknown');
  assert.equal(costConfidenceOf(COST_BASIS.unrecorded, 9000), 'estimated');
  assert.equal(costConfidenceOf(COST_BASIS.unrecorded, null), 'unknown');
  // An unreadable value resolves to the least confident answer it can, never to
  // "recorded" — the same rule adminScope applies to an unrecognised scope.
  assert.equal(costConfidenceOf('something-a-later-build-wrote', 9000), 'estimated');
});

test('costSnapshot refuses a cost that is not whole dinars rather than storing one', () => {
  assert.deepEqual(costSnapshot(9000), { cost_iqd: 9000, cost_basis: COST_BASIS.snapshot });
  assert.deepEqual(costSnapshot(0), { cost_iqd: 0, cost_basis: COST_BASIS.snapshot });
  assert.deepEqual(costSnapshot(null), { cost_iqd: null, cost_basis: COST_BASIS.unpriced });
  assert.deepEqual(costSnapshot(undefined), { cost_iqd: null, cost_basis: COST_BASIS.unpriced });
  assert.deepEqual(costSnapshot(-5), { cost_iqd: null, cost_basis: COST_BASIS.unpriced });
  assert.deepEqual(costSnapshot(12.5), { cost_iqd: null, cost_basis: COST_BASIS.unpriced });
});

// ═════════════════════════════════════════ a bundle: goods on the components

test('a bundle records its cost on the COMPONENT rows and zero on the parent, so nothing is counted twice', async () => {
  const raw = seedCatalogue();
  raw.exec(`
    UPDATE products SET product_cost_iqd = 200000 WHERE id = 'p_printer';
    UPDATE products SET product_cost_iqd = 9000   WHERE id = 'p_pla';
    -- A cost typed on the BUNDLE product itself, which must be ignored: the
    -- goods are the components, and recording both double-counts them.
    UPDATE products SET product_cost_iqd = 999999 WHERE id = 'prd_b1';
  `);
  addBundle(raw, {
    id: 'prd_b1',
    slug: 'starter',
    priceIqd: 400_000,
    window: { ends_at: '2099-01-01T00:00:00.000Z' },
    components: [
      { id: 'bc_printer', product: 'p_printer', qty: 1 },
      { id: 'bc_pla', product: 'p_pla', qty: 2 },
    ],
  });
  const db = asD1(raw);
  const added = await json(await post(shopApp(db), '/api/cart/items', { productId: 'prd_b1', qty: 1 }));
  assert.equal(added.success, true, JSON.stringify(added));
  const placed = await json(await post(shopApp(db), '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed));

  const rows = itemCosts(raw, placed.order.id as string);
  const parent = rows.find((r) => r.bundle_parent_item_id === null)!;
  const components = rows.filter((r) => r.bundle_parent_item_id !== null);
  assert.equal(parent.cost_basis, COST_BASIS.composed, 'the parent carries the money, not the goods');
  assert.equal(parent.cost_iqd, null, "the bundle product's own typed cost must not be recorded");
  assert.equal(components.length, 2);
  assert.deepEqual(
    components.map((r) => [r.product_id, r.cost_iqd, r.cost_basis]).sort(),
    [
      ['p_pla', 9000, COST_BASIS.snapshot],
      ['p_printer', 200000, COST_BASIS.snapshot],
    ].sort()
  );

  // …and still nothing about cost reaches the buyer.
  const detail = await json(await get(shopApp(db), `/api/orders/${placed.order.id}`));
  const text = JSON.stringify(detail);
  assert.equal(text.includes('200000'), false, 'a component cost leaked into the customer payload');
  assert.equal(text.includes('cost_iqd'), false);
});

// ═══════════════════════════════════ 4 — the scope gate on every expense route

/** Every route this router exposes, as [method, path]. If a route is added and
 *  not listed here, the count assertion below fails — a gate test that silently
 *  stops covering a new route is worse than no gate test. */
const EXPENSE_ROUTES: ReadonlyArray<[string, string]> = [
  ['GET', '/api/admin/finance/expense-categories'],
  ['POST', '/api/admin/finance/expense-categories'],
  ['PATCH', '/api/admin/finance/expense-categories/exc_1'],
  ['GET', '/api/admin/finance/expenses'],
  ['POST', '/api/admin/finance/expenses'],
  ['PATCH', '/api/admin/finance/expenses/exp_1'],
  ['DELETE', '/api/admin/finance/expenses/exp_1'],
  ['POST', '/api/admin/finance/expenses/exp_1/restore'],
];

test('an assistant admin is refused on EVERY expense route, read and write alike', async () => {
  const raw = seedCatalogue();
  const db = asD1(raw);
  assert.equal(EXPENSE_ROUTES.length, 8, 'a route was added or removed — cover it here');
  for (const [method, path] of EXPENSE_ROUTES) {
    const app = financeApp(db, assistant);
    // A GET carries no body; everything else sends one, so a refusal cannot be
    // mistaken for a validation error on an empty payload.
    const res = method === 'GET' ? await get(app, path) : await send(app, method, path, { amount_iqd: 1000 });
    assert.equal(res.status, 403, `${method} ${path} must refuse an assistant, got ${res.status}`);
    const body = await json(res);
    assert.equal(body.success, false);
    assert.equal(body.code, 'FORBIDDEN');
  }
  // …and the assistant's attempts wrote nothing at all.
  assert.deepEqual(all(raw, 'SELECT id FROM operating_expenses'), []);
  assert.deepEqual(all(raw, 'SELECT id FROM expense_categories'), []);
});

test('a customer and a merchant cannot reach the expense ledger either', async () => {
  const db = asD1(seedCatalogue());
  for (const who of [buyer, { id: 'm', role: 'merchant' as const, email: 'm@x.co' }]) {
    const res = await get(financeApp(db, who), '/api/admin/finance/expenses');
    assert.equal(res.status, 403, 'only an administrator reaches an admin route at all');
  }
});

// ═══════════════════════════════════════════════ the ledger itself, end to end

test('the owner records an expense, repeats it monthly as REAL rows, and voids one without losing it', async () => {
  const raw = seedCatalogue();
  const db = asD1(raw);
  const app = financeApp(db, owner);

  // The default categories appear once, as ordinary rows the owner can edit.
  const cats = await json(await get(app, '/api/admin/finance/expense-categories'));
  assert.equal(cats.success, true, JSON.stringify(cats));
  assert.ok(cats.categories.length >= 5);
  const rent = cats.categories.find((x: { slug: string }) => x.slug === 'rent');
  assert.ok(rent, 'the seeded defaults must include rent');
  // Asking twice must not create them twice.
  await get(app, '/api/admin/finance/expense-categories');
  assert.equal(all(raw, "SELECT id FROM expense_categories WHERE slug = 'rent'").length, 1);

  // Twelve months of rent, entered once, written as twelve visible rows.
  const created = await json(
    await post(app, '/api/admin/finance/expenses', {
      category_id: rent.id,
      amount_iqd: 600_000,
      expense_day: '2026-01-31',
      title: 'إيجار المعرض',
      repeat_months: 12,
    })
  );
  assert.equal(created.success, true, JSON.stringify(created));
  assert.equal(created.ids.length, 12);
  assert.ok(created.series_id, 'a repeat is grouped so the owner can find the other months');
  // 31 January + 1 month is 28 February, NOT 3 March: a month is the period
  // this ledger reports on, so a row may never drift into the next one.
  assert.equal(created.days[1], '2026-02-28');
  assert.equal(created.days[2], '2026-03-31');
  assert.equal(created.days[11], '2026-12-31');
  assert.equal(all(raw, 'SELECT id FROM operating_expenses').length, 12);

  // The period read: January alone is one month of rent.
  const jan = await json(await get(app, '/api/admin/finance/expenses?from=2026-01-01&to=2026-01-31'));
  assert.equal(jan.expenses.length, 1);
  assert.equal(jan.total_iqd, 600_000);

  // A void REMOVES IT FROM THE REPORT AND KEEPS THE ROW. A deleted expense
  // changes a net profit the owner may already have acted on, with nothing left
  // to say why.
  const voided = await send(app, 'DELETE', `/api/admin/finance/expenses/${created.ids[0]}?reason=مكرر`, {});
  assert.equal(voided.status, 200);
  const janAfter = await json(await get(app, '/api/admin/finance/expenses?from=2026-01-01&to=2026-01-31'));
  assert.equal(janAfter.expenses.length, 0, 'a voided row is out of the report');
  assert.equal(janAfter.total_iqd, 0);
  const stored = row<{ voided_by: string; void_reason: string }>(
    raw,
    'SELECT voided_by, void_reason FROM operating_expenses WHERE id = ?',
    created.ids[0]
  );
  assert.equal(stored?.voided_by, 'boss', 'the row survives, and says who removed it');
  assert.equal(stored?.void_reason, 'مكرر');

  // …and the ledger screen can still see it.
  const withVoided = await json(
    await get(app, '/api/admin/finance/expenses?from=2026-01-01&to=2026-01-31&include_voided=1')
  );
  assert.equal(withVoided.expenses.length, 1);
  assert.equal(withVoided.expenses[0].voided, true);
  assert.equal(withVoided.total_iqd, 0, 'a voided row is never counted, even when it is shown');

  // A restore brings it back, audited.
  const restored = await post(app, `/api/admin/finance/expenses/${created.ids[0]}/restore`, {});
  assert.equal(restored.status, 200);
  const janBack = await json(await get(app, '/api/admin/finance/expenses?from=2026-01-01&to=2026-01-31'));
  assert.equal(janBack.total_iqd, 600_000);

  // Every write is audited, because an expense moves a reported profit.
  const actions = all<{ action: string }>(raw, 'SELECT action FROM audit_log ORDER BY rowid').map((r) => r.action);
  for (const a of [
    'finance.expense_category.seed',
    'finance.expense.create',
    'finance.expense.void',
    'finance.expense.restore',
  ]) {
    assert.ok(actions.includes(a), `${a} must be audited — got ${JSON.stringify(actions)}`);
  }
});

test('an expense belongs to the day the owner names, not the day it was typed, and a correction is auditable', async () => {
  const raw = seedCatalogue();
  const db = asD1(raw);
  const app = financeApp(db, owner);
  const cats = await json(await get(app, '/api/admin/finance/expense-categories'));
  const other = cats.categories.find((x: { slug: string }) => x.slug === 'other');

  // A January invoice, entered today. It belongs to January.
  const created = await json(
    await post(app, '/api/admin/finance/expenses', {
      category_id: other.id,
      amount_iqd: 125_000,
      expense_day: '2026-01-15',
      note: 'فاتورة كانون الثاني، دُفعت في آذار',
    })
  );
  assert.equal(created.success, true, JSON.stringify(created));
  const stored = row<{ expense_day: string; created_at: string }>(
    raw,
    'SELECT expense_day, created_at FROM operating_expenses WHERE id = ?',
    created.ids[0]
  );
  assert.equal(stored?.expense_day, '2026-01-15');
  assert.notEqual(stored?.expense_day, String(stored?.created_at).slice(0, 10));

  // A correction records BOTH values, so a net profit that changed between two
  // readings can be explained.
  const fixed = await patch(app, `/api/admin/finance/expenses/${created.ids[0]}`, { amount_iqd: 152_000 });
  assert.equal(fixed.status, 200);
  const detail = row<{ detail: string }>(
    raw,
    "SELECT detail FROM audit_log WHERE action = 'finance.expense.update' ORDER BY rowid DESC LIMIT 1"
  );
  assert.ok(String(detail?.detail).includes('125000'), 'the audit must carry the value before the correction');
  assert.ok(String(detail?.detail).includes('152000'));
});

test('the ledger refuses the numbers a human mistypes rather than storing them', async () => {
  const raw = seedCatalogue();
  const db = asD1(raw);
  const app = financeApp(db, owner);
  const cats = await json(await get(app, '/api/admin/finance/expense-categories'));
  const id = cats.categories[0].id;

  for (const [body, why] of [
    [{ category_id: id, amount_iqd: 0, expense_day: '2026-01-01' }, 'zero is not an expense'],
    [{ category_id: id, amount_iqd: -5000, expense_day: '2026-01-01' }, 'a minus sign must not cancel a real cost'],
    [{ category_id: id, amount_iqd: 1000.5, expense_day: '2026-01-01' }, 'money is whole dinars here'],
    [{ category_id: id, amount_iqd: 1000, expense_day: '2026-02-31' }, 'a well-shaped non-day is still not a day'],
    [{ category_id: id, amount_iqd: 1000, expense_day: '2226-01-01' }, 'a mistyped year would hide in a period nobody opens'],
    [{ category_id: 'exc_nope', amount_iqd: 1000, expense_day: '2026-01-01' }, 'an unknown category'],
  ] as const) {
    const res = await post(app, '/api/admin/finance/expenses', body);
    assert.equal(res.status, 400, `${why}: expected a refusal, got ${res.status}`);
  }
  assert.deepEqual(all(raw, 'SELECT id FROM operating_expenses'), []);
});

// ══════════════════════════════════════════════════════════ the small rules

test('a monthly repeat clamps to the end of a short month instead of overflowing into the next one', () => {
  assert.deepEqual(expenseSeriesDays('2026-01-31', 3), ['2026-01-31', '2026-02-28', '2026-03-31']);
  // A leap February, which is the case a hand-written month table gets wrong.
  assert.deepEqual(expenseSeriesDays('2028-01-31', 2), ['2028-01-31', '2028-02-29']);
  // A year boundary.
  assert.deepEqual(expenseSeriesDays('2026-11-30', 3), ['2026-11-30', '2026-12-30', '2027-01-30']);
  assert.deepEqual(expenseSeriesDays('2026-01-15', 1), ['2026-01-15']);
  assert.deepEqual(expenseSeriesDays('not-a-day', 3), []);
  // Bounded: a repeat writes real rows, so an unbounded repeat is an unbounded
  // batch.
  assert.equal(expenseSeriesDays('2026-01-01', 900).length, 24);
});

test('a category slug keeps Arabic letters and stays inside the 50-byte pattern limit D1 enforces', () => {
  assert.equal(expenseSlug('Rent', 'exc_x'), 'rent');
  assert.equal(expenseSlug('Bank fees', 'exc_x'), 'bank-fees');
  assert.equal(expenseSlug('إيجار المعرض', 'exc_x'), 'إيجار-المعرض');
  assert.equal(expenseSlug('!!!', 'exc_x'), 'exc_x');
  // Arabic is two bytes a letter, so a long Arabic name must be cut by BYTES.
  const long = expenseSlug('ا'.repeat(80), 'exc_x');
  assert.ok(new TextEncoder().encode(long).length <= 40, `slug was ${new TextEncoder().encode(long).length} bytes`);
});

// ═══════════════════════════════ what track B embeds, run against real SQL

test('the cost projection track B embeds runs, and tells a fact from an estimate', async () => {
  const raw = seedCatalogue();
  raw.exec("UPDATE products SET product_cost_iqd = 9000 WHERE id = 'p_pla'");
  const db = asD1(raw);
  await post(shopApp(db), '/api/cart/items', { productId: 'p_pla', qty: 1 });
  const placed = await json(await post(shopApp(db), '/api/orders', orderBody()));
  const orderId = placed.order.id as string;
  // Three rows the dashboard must treat differently: a real sale (recorded), a
  // pre-0095 row on a product that HAS a cost today (estimate), and one on a
  // product that does not (unknown).
  raw.exec(`
    INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd)
    VALUES ('oi_old_priced', '${orderId}', 'p_pla', 'Old', 1, 25000, 25000),
           ('oi_old_free',   '${orderId}', 'p_nozzle', 'Old', 1, 5000, 5000);
  `);
  const rows = all<{ id: string; unit_cost_iqd: number | null; cost_confidence: string }>(
    raw,
    `SELECT oi.id, ${costProjectionSql('oi', 'p')}
       FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ? ORDER BY oi.rowid`,
    orderId
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(byId.get('oi_old_priced')!.cost_confidence, 'estimated');
  assert.equal(byId.get('oi_old_priced')!.unit_cost_iqd, 9000, "an estimate is the product's cost TODAY");
  assert.equal(byId.get('oi_old_free')!.cost_confidence, 'unknown');
  assert.equal(byId.get('oi_old_free')!.unit_cost_iqd, null);
  const sold = rows.find((r) => r.id !== 'oi_old_priced' && r.id !== 'oi_old_free')!;
  assert.equal(sold.cost_confidence, 'recorded');
  assert.equal(sold.unit_cost_iqd, 9000);

  // THE POINT OF THE WHOLE TRACK: move the catalogue, and only the ESTIMATE
  // moves. The recorded sale does not.
  raw.exec("UPDATE products SET product_cost_iqd = 21000 WHERE id = 'p_pla'");
  const after = all<{ id: string; unit_cost_iqd: number | null }>(
    raw,
    `SELECT oi.id, ${costProjectionSql('oi', 'p')}
       FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ? ORDER BY oi.rowid`,
    orderId
  );
  const afterById = new Map(after.map((r) => [r.id, r]));
  assert.equal(afterById.get('oi_old_priced')!.unit_cost_iqd, 21000, 'an estimate follows the catalogue');
  assert.equal(afterById.get(sold.id)!.unit_cost_iqd, 9000, 'a recorded sale never does');

  // THE TS TWIN IS CHECKED AGAINST THE SQL THAT RAN, ROW BY ROW.
  //
  // `costConfidenceOf` used to be asserted on its own, with hand-written
  // arguments — which proved only that the function agrees with itself, and
  // could not be broken by any change to the SQL every screen actually
  // executes. The two are a pair: the day they disagree, a ledger screen and
  // a dashboard report different confidence for the same line, and nothing
  // anywhere says which is right. So the TS answer is derived from the SAME
  // rows SQLite just answered for, and must match.
  const costsToday = new Map(
    all<{ id: string; product_cost_iqd: number | null }>(
      raw,
      `SELECT oi.id AS id, p.product_cost_iqd AS product_cost_iqd
         FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ?`,
      orderId
    ).map((r) => [r.id, r.product_cost_iqd])
  );
  const bases = new Map(
    all<{ id: string; cost_basis: string }>(
      raw,
      'SELECT id, cost_basis FROM order_items WHERE order_id = ?',
      orderId
    ).map((r) => [r.id, r.cost_basis])
  );
  const afterConfidence = all<{ id: string; cost_confidence: string }>(
    raw,
    `SELECT oi.id, ${costProjectionSql('oi', 'p')}
       FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ?`,
    orderId
  );
  assert.ok(afterConfidence.length >= 3);
  for (const row of afterConfidence) {
    assert.equal(
      costConfidenceOf(bases.get(row.id), costsToday.get(row.id)),
      row.cost_confidence,
      `the TypeScript rule disagrees with the SQL for ${row.id}`
    );
  }
});

test('a Worker deployed AHEAD of migration 0095 refuses checkout honestly instead of 500ing', async () => {
  // The window between `wrangler deploy` and `d1 migrations apply`. The
  // codebase already has one answer for it and this change must land inside it
  // rather than inventing a second: 503 SERVICE_SETUP, «هذه ليست مشكلة في
  // سلتك», with no table or column name in the message — the same answer
  // tests/checkoutSchemaResilience.test.ts pins for a missing points column.
  const raw = seedCatalogue();
  raw.exec(`
    DROP INDEX IF EXISTS idx_order_items_cost_basis;
    DROP TRIGGER IF EXISTS trg_mystery_allocation_cost;
    ALTER TABLE order_items DROP COLUMN cost_iqd;
    ALTER TABLE order_items DROP COLUMN cost_basis;
  `);
  const db = asD1(raw);
  await post(shopApp(db), '/api/cart/items', { productId: 'p_pla', qty: 1 });
  const res = await post(shopApp(db), '/api/orders', orderBody());
  assert.equal(res.status, 503);
  const body = await json(res);
  assert.equal(body.code, 'SERVICE_SETUP');
  assert.doesNotMatch(String(body.error), /cost_iqd|cost_basis|order_items|SQLITE|D1_ERROR/i);
  assert.deepEqual(all(raw, 'SELECT id FROM orders'), [], 'and no half-written order is left behind');
});

// ══════════════════════════════════════ the gap 0096 CLOSED

test('a mystery spool freezes the drawn filament\u2019s cost at the draw, and still hides the pick', async () => {
  const raw = seedCatalogue();
  seedMysteryPool(raw);
  // Every pool member has a real cost, and migration 0096 now freezes it onto
  // the spool at the INSTANT OF THE DRAW — an AFTER INSERT trigger on
  // `mystery_allocations`, running inside the checkout's own batch, so the cost
  // lands with the order or the order does not exist. This is NOT the second
  // derivation §0095 forbids: for a mystery spool the resolver produces no cost
  // at all, so there is exactly one derivation and it happens at the sale.
  //
  // WHAT MUST NOT CHANGE IS §7.7: the row's `product_id` stays NULL, so the
  // cost arrives without the pick arriving with it. That assertion below is
  // the load-bearing one and it is asserted FIRST for that reason.
  for (const p of POOL_PRODUCTS) {
    raw.prepare('UPDATE products SET product_cost_iqd = 11000 WHERE id = ?').run(p.id);
  }
  const offerId = addMysteryOffer(raw);
  const db = asD1(raw);
  const added = await json(await post(shopApp(db), '/api/cart/items', { productId: offerId, qty: 1 }));
  assert.equal(added.success, true, JSON.stringify(added));
  const placed = await json(await post(shopApp(db), '/api/orders', orderBody()));
  assert.equal(placed.success, true, JSON.stringify(placed).slice(0, 400));

  const rows = itemCosts(raw, placed.order.id as string);
  const spools = rows.filter((r) => r.bundle_parent_item_id !== null);
  assert.ok(spools.length > 0, 'the offer sells spools');
  for (const sp of spools) {
    assert.equal(sp.product_id, null, '§7.7 — the drawn product never reaches the row');
    assert.equal(sp.cost_iqd, 11000, 'the cost ladder was walked at the draw and the base product cost frozen');
    assert.equal(
      sp.cost_basis,
      COST_BASIS.snapshot,
      'a snapshot, not zero: a bound 0 would report a mystery box as pure profit, which the owner would price against'
    );
    // And because the cost is recorded, the dashboard stops printing "unknown"
    // for this row — which is the whole reason the owner asked for it.
    assert.equal(costConfidenceOf(sp.cost_basis, sp.cost_iqd), 'recorded');
  }
});

// ════════════════ Telegram approval authority is financial authority

test('an assistant admin cannot bind, read or revoke a Telegram payment-approval identity', async () => {
  // §12.2's own words: "Verify callback_query.from.id and match it to a KNOWN
  // administrative user with real approval authority." A row in
  // `admin_tg_identities` IS that authority — `resolveAdminActor` resolves the
  // «موافقة» button through exactly this table — so creating one hands out the
  // power to approve wallet deposits.
  //
  // These three routes carried `requireAdmin` ALONE, and both writes tested
  // only that the TARGET has `users.role = 'admin'` — which an assistant is.
  // So a restricted admin could bind their own numeric id and approve real
  // money from the bot: the one authority mandate §11 exists to withhold,
  // reachable by the account it withholds it from.
  const raw = seedCatalogue();
  raw.exec(`
    INSERT OR IGNORE INTO users (id, name, email, password_hash, role)
    VALUES ('helper','Assistant','help@x.co','h','admin');
    UPDATE users SET admin_scope = 'assistant' WHERE id = 'helper';
  `);
  const db = asD1(raw);
  const tgApp = (who: StubUser) => stubApp(db, who, (a) => a.route('/api/telegram', telegramRoutes));

  const routes: Array<[string, string]> = [
    ['GET', '/api/telegram/admin/tg-identities'],
    ['POST', '/api/telegram/admin/tg-identities'],
    ['POST', '/api/telegram/admin/tg-identities/6404042791/revoke'],
  ];
  for (const [method, path] of routes) {
    const res =
      method === 'GET'
        ? await get(tgApp(assistant), path)
        : await send(tgApp(assistant), method, path, { userId: 'helper', telegramUserId: 6404042791, reason: 'mine now' });
    assert.equal(res.status, 403, `${method} ${path} must refuse an assistant, got ${res.status}`);
  }
  // And nothing was written — the refusal is before the handler, not inside it.
  assert.deepEqual(all(raw, 'SELECT telegram_user_id FROM admin_tg_identities'), []);

  // The owner is not blocked by the same gate.
  const ok = await post(tgApp(owner), '/api/telegram/admin/tg-identities', {
    userId: 'boss',
    telegramUserId: 6404042791,
    label: 'owner',
  });
  assert.equal(ok.status, 200);
});

// ═══════════════════════════ the ledger's own totals, and its audit trail

test('the period total is the PERIOD, not the page, and a voided row is never in it', async () => {
  const raw = seedCatalogue();
  const db = asD1(raw);
  const app = financeApp(db, owner);
  await get(app, '/api/admin/finance/expense-categories'); // seeds the defaults
  const cats = await json(await get(app, '/api/admin/finance/expense-categories'));
  const catId = cats.categories[0].id as string;

  // Six rows of 100,000 in one month, then a page of three.
  for (let i = 1; i <= 6; i++) {
    await post(app, '/api/admin/finance/expenses', {
      category_id: catId,
      amount_iqd: 100_000,
      expense_day: `2026-07-0${i}`,
    });
  }
  const page = await json(await get(app, '/api/admin/finance/expenses?from=2026-07-01&to=2026-07-31&limit=3'));
  assert.equal(page.expenses.length, 3);
  // THE DEFECT THIS PINS: the total used to be the sum of the returned rows,
  // labelled as the period's. A year of daily entries then printed a figure
  // short by everything past the limit, while the dashboard — which sums in
  // SQL with no limit — printed the right one. Two screens disagreeing about
  // one month is how an owner stops believing both.
  assert.equal(page.total_iqd, 600_000, 'the total is the whole period');
  assert.equal(page.page_total_iqd, 300_000, 'and the list still adds up to its own figure');
  assert.equal(page.truncated, true);
  assert.equal(page.count, 6);
});

test('a second void writes no second audit record, and a restore that restored nothing writes none', async () => {
  const raw = seedCatalogue();
  const db = asD1(raw);
  const app = financeApp(db, owner);
  await get(app, '/api/admin/finance/expense-categories');
  const cats = await json(await get(app, '/api/admin/finance/expense-categories'));
  const created = await json(
    await post(app, '/api/admin/finance/expenses', {
      category_id: cats.categories[0].id,
      amount_iqd: 250_000,
      expense_day: '2026-07-10',
    })
  );
  const id = created.ids[0] as string;

  const first = await send(app, 'DELETE', `/api/admin/finance/expenses/${id}?reason=مكرر`, undefined);
  assert.equal(first.status, 200);
  assert.equal((await json(first)).voided, true);

  // The UPDATE is fenced with `AND voided_at IS NULL` so a double click cannot
  // overwrite the first void's author — but the audit call used to run anyway,
  // writing a second void record naming a second admin against a row that
  // still records the first. The trail is the only place a changed net profit
  // can be explained; two voids for one voided row makes that unreadable.
  const second = await send(app, 'DELETE', `/api/admin/finance/expenses/${id}?reason=مرة ثانية`, undefined);
  assert.equal(second.status, 200);
  assert.equal((await json(second)).voided, false, 'nothing changed, and the response says so');

  const voids = all(raw, "SELECT id FROM audit_log WHERE action = 'finance.expense.void'");
  assert.equal(voids.length, 1, 'one void happened, so one void is recorded');

  await post(app, `/api/admin/finance/expenses/${id}/restore`, {});
  const again = await post(app, `/api/admin/finance/expenses/${id}/restore`, {});
  assert.equal((await json(again)).restored, false);
  const restores = all(raw, "SELECT id FROM audit_log WHERE action = 'finance.expense.restore'");
  assert.equal(restores.length, 1, 'a restore that restored nothing is not an entry');
});
