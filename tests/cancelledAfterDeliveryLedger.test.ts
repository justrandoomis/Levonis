/**
 * AN ORDER CANCELLED AFTER DELIVERY IS REVERSED IN THE JOURNAL LIKE A RETURN (owner 2026-11-11, ruling 6.7.2;
 * DECISIONS row 318).
 *
 * Until now a delivered order walked back and cancelled kept its sale (1100/2300 against 4000/4100) and its goods
 * cost (5000 against 1200) in the books for ever, while the stock went back to its lot, the wallet money back to the
 * customer, its wages (row 307) and its investor share (row 308) were taken back, and every screen dropped it. Now the
 * minute scan finds it — with no wage and no investor too — and reconcileFinanceOrder posts, on the day it runs, a
 * mirrored `order-cancel:` reversal of each native entry (source `order_cancel`, `reversal_of` set) and zeroes the
 * owner's overlays of net goods, goods cost, delivery and the cash-on-delivery fee. A re-delivery (R-b: a cash order of
 * untracked products can be re-opened, row 310) re-posts the sale that day; a second cancel reverses it once more.
 *
 * Orders are placed, delivered and cancelled through the real doors: the status door, the stage panel, a forced courier
 * sync (a stub courier, as tests/deliverySync.test.ts), and the customer's own cancel after a walk-back to pending (a
 * store's order and a free order are written as rows: no door makes them so). Invented data only.
 *
 * Run: node --import tsx --test tests/cancelledAfterDeliveryLedger.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { all, asD1, count, get, json, post, row, stubApp } from './fixtures/app';
import { appsFor, giftWorld, paidLine, patch, placeOrder } from './fixtures/giftWorld';
import { previousMonth, usd } from './fixtures/financeWorld';
import { adminFinanceWorkspaceRoutes } from '../worker/routes/adminFinanceWorkspace';
import { adminFinanceOperationsRoutes } from '../worker/routes/adminFinanceOperations';
import { adminInvestmentFinanceRoutes } from '../worker/routes/adminInvestmentFinance';
import { drainOrderFinanceRecovery } from '../worker/lib/financeOrderRecovery';
import { reconcileFinanceOrder } from '../worker/lib/financeReconcile';
import { reverseCancelledSale, runOrderFinancialEffects } from '../worker/lib/orderFinance';
import { runFinanceChecks } from '../worker/lib/financeChecks';
import { continueStaffReconciliation } from '../worker/lib/financeStaffAccrual';
import { participantOverview } from '../worker/lib/financeParticipants';
import { setStatusMapping, upsertRemoteStatuses } from '../worker/lib/delivery/statusMap';
import { syncOrderDelivery } from '../worker/lib/delivery/sync';
import { baghdadDay, journalPlan } from '../worker/lib/operations';
import { drill, STATEMENT_FIGURES, drillParts } from '../src/components/financeWorkspace/drill';
import type { DeliveryDriver, DriverResult, RemoteShipmentStatus, RemoteStatus, CreatedShipment } from '../worker/lib/delivery/types';
import type { FinanceSummary } from '../src/components/financeWorkspace/types';
import type { Env } from '../worker/lib/types';

const ACCOUNTS = ['1100', '2200', '2300', '4000', '4100', '1200', '5000', '2990'] as const;
type Entry = { id: string; event_key: string; entry_day: string; source_type: string; reversal_of: string | null };

/** A courier that answers one status for every shipment (tests/deliverySync.test.ts). */
class StubCourier implements DeliveryDriver {
  readonly provider = 'alwaseet';
  constructor(private statusId: string) {}
  async listStatuses(): Promise<DriverResult<RemoteStatus[]>> { return { ok: true, value: [{ id: this.statusId, text: 'راجع' }] }; }
  async createShipment(): Promise<DriverResult<CreatedShipment>> { return { ok: false, retryable: false, error: 'not used' }; }
  async getShipment(): Promise<DriverResult<RemoteShipmentStatus>> { return { ok: true, value: { remoteId: 'AW-T1', statusId: this.statusId, statusText: 'راجع' } }; }
}

/** The gift world with a priced stock batch (3 × 6,000) for the nozzle cleaner, so a delivery posts its goods cost. */
function world(opts: { people?: boolean } = {}) {
  const raw = giftWorld();
  raw.exec(`UPDATE users SET admin_scope='full' WHERE id='boss';
    INSERT INTO inventory_lots(id,product_id,scope,scope_id,qty_received,qty_remaining,unit_cost_iqd,total_cost_iqd,cost_basis,received_at)
    VALUES ('lot_plain','p_plain','base','',3,3,6000,18000,'received','2026-01-01');
    INSERT INTO products (id,slug,name,name_ar,name_ku,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,inventory_mode)
    VALUES ('p_loose','loose-part','Loose part','قطعة سائبة','پارچەی سەربەست',12000,'active',NULL,'[]','[]','direct_sale','["direct_sale"]','[]','[]','BASE');`);
  if (opts.people) raw.exec(`INSERT INTO users(id,email,name,role,admin_scope) VALUES ('packer','packer@x.co','Packer','admin','assistant'),('investor','investor@x.co','Investor','admin','assistant');
    UPDATE finance_staff SET user_id='packer',start_work_date='2026-09-01' WHERE id='staff_hussein';
    INSERT INTO inventory_suppliers(id,name) VALUES ('supplier','Supplier');
    INSERT INTO incoming_inventory(id,product_id,scope,scope_id,qty_ordered,qty_received,purchase_unit_iqd,shipping_total_iqd,internal_delivery_total_iqd,supplier_id,status,created_by)
      VALUES ('inc_plain','p_plain','base','',3,3,6000,0,0,'supplier','received','boss');
    UPDATE inventory_lots SET incoming_id='inc_plain',supplier_id='supplier' WHERE id='lot_plain';`);
  const db = asD1(raw), a = appsFor(db), env = { DB: db } as Env;
  const boss = { id: 'boss', email: 'boss@x.co', role: 'admin' as const, admin_scope: 'full' };
  const fin = stubApp(db, boss, (x) => { x.route('/f', adminFinanceWorkspaceRoutes); x.route('/ops', adminFinanceOperationsRoutes); x.route('/i', adminInvestmentFinanceRoutes); });
  const ok = async (res: Response, what: string) => { const body = await json(res.clone()); assert.equal(res.status, 200, `${what}: ${JSON.stringify(body)}`); return body; };
  /** The status door, as the order board moves an order. */
  const move = async (id: string, status: string) => ok(await patch(a.admin, `/api/admin/orders/${id}`, { status }), status);
  /** The stage panel. */
  const stage = async (id: string, to: string) => ok(await patch(a.admin, `/api/admin/orders/${id}/stage`, { stage: to }), to);
  async function placed(cart: string, over: Record<string, unknown> = {}, product = 'p_plain') {
    paidLine(raw, cart, product, { qty: 1 });
    return (await placeOrder(a.buyer, over)).id as string;
  }
  async function delivered(cart: string, over: Record<string, unknown> = {}, product = 'p_plain') {
    const id = await placed(cart, over, product);
    await move(id, 'confirmed');
    await move(id, 'delivered');
    return id;
  }
  const entries = (id: string) => all<Entry>(raw, `SELECT id,event_key,entry_day,source_type,reversal_of FROM accounting_entries
    WHERE source_id=? OR source_id IN (SELECT id FROM finance_collections WHERE order_id=?) ORDER BY created_at,event_key`, id, id).map((e) => ({ ...e }));
  /** What the order leaves on each account: its own entries, its cash collections and its overlays. */
  const nets = (id: string) => Object.fromEntries(ACCOUNTS.map((code) => [code, count(raw, `SELECT COALESCE(SUM(l.debit_iqd-l.credit_iqd),0) n
    FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id WHERE e.state='posted' AND l.account_code=?
      AND (e.source_id=? OR e.source_id IN (SELECT id FROM finance_collections WHERE order_id=?))`, code, id, id)]));
  const zero = Object.fromEntries(ACCOUNTS.map((code) => [code, 0]));
  const trial = () => count(raw, "SELECT COALESCE(SUM(l.debit_iqd-l.credit_iqd),0) n FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id WHERE e.state='posted'");
  const journal = () => all(raw, 'SELECT * FROM accounting_entries ORDER BY id').map((e) => ({ ...e }));
  /** The minute scan, run until it has nothing left (a pass takes two orders). */
  async function drainAll() {
    const reports = [];
    for (let i = 0; i < 6; i++) { const r = await drainOrderFinanceRecovery(env); reports.push(r); if (!r.scanned) break; }
    return reports;
  }
  return { raw, db, a, env, fin, ok, move, stage, placed, delivered, entries, nets, zero, trial, journal, drainAll };
}
type World = ReturnType<typeof world>;

/** One `order-cancel:` entry per native entry, reversing it, source order_cancel, dated today; the order nets to 0
 * (its receivable to minus the cash it collected, when some was recorded before the cancel: `collected`). */
function assertReversed(w: World, id: string, natives: string[], collected = 0) {
  const list = w.entries(id);
  const native = list.filter((e) => natives.some((k) => e.event_key === `${k}:${id}`));
  assert.deepEqual(native.map((e) => e.event_key.split(':')[0]).sort(), [...natives].sort(), JSON.stringify(list));
  const reversals = list.filter((e) => e.event_key.startsWith('order-cancel:'));
  assert.deepEqual(reversals.map((e) => e.reversal_of).sort(), native.map((e) => e.id).sort(), 'one reversal per native entry, reversal_of set');
  assert.deepEqual(reversals.map((e) => e.event_key).sort(), native.map((e) => `order-cancel:${e.id}`).sort());
  for (const r of reversals) assert.deepEqual([r.source_type, r.entry_day], ['order_cancel', baghdadDay()]);
  assert.deepEqual(w.nets(id), { ...w.zero, 1100: 0 - collected }, 'the order nets to 0 on 1100, 2200, 2300, 4000, 4100, 1200, 5000 and 2990');
  assert.equal(w.trial(), 0, 'the trial balance is 0');
}

test('the status door (delivered → shipped → cancelled): the scan reverses the sale and its goods cost once, today', async () => {
  const w = world();
  const id = await w.delivered('cart_status');
  // What the delivery posted: the sale on the receivable and the goods cost out of stock.
  assert.deepEqual(w.nets(id), { ...w.zero, 1100: 20000, 4000: -15000, 4100: -5000, 5000: 6000, 1200: -6000 });
  await w.move(id, 'shipped');
  await w.move(id, 'cancelled');
  assert.deepEqual(row(w.raw, 'SELECT status,delivered_at IS NOT NULL kept FROM orders WHERE id=?', id), { status: 'cancelled', kept: 1 });
  assert.equal(count(w.raw, "SELECT qty_remaining n FROM inventory_lots WHERE id='lot_plain'"), 3, 'the unit is back in its batch');
  const reports = await w.drainAll();
  assert.deepEqual([reports[0].scanned, reports[0].completed, reports[0].failed], [1, 1, 0], JSON.stringify(reports[0]));
  assertReversed(w, id, ['sale', 'cogs']);
  // The reversal's lines mirror the delivery's, debit for credit.
  const lines = all<{ key: string; account_code: string; debit_iqd: number; credit_iqd: number }>(w.raw, `SELECT e.event_key key,l.account_code,l.debit_iqd,l.credit_iqd
    FROM accounting_lines l JOIN accounting_entries e ON e.id=l.entry_id WHERE e.source_id=?`, id).map((l) => [l.key.split(':')[0], l.account_code, l.debit_iqd, l.credit_iqd])
    .sort((x, y) => String(x).localeCompare(String(y)));
  assert.deepEqual(lines, [['cogs', '1200', 0, 6000], ['cogs', '5000', 6000, 0], ['order-cancel', '1100', 0, 20000], ['order-cancel', '1200', 6000, 0],
    ['order-cancel', '4000', 15000, 0], ['order-cancel', '4100', 5000, 0], ['order-cancel', '5000', 0, 6000], ['sale', '1100', 20000, 0], ['sale', '4000', 0, 15000], ['sale', '4100', 0, 5000]]);
  // Idempotent: the scan does not come back, and a replayed reconciliation changes nothing.
  const journal = w.journal();
  assert.equal((await drainOrderFinanceRecovery(w.env)).scanned, 0);
  assert.equal((await reconcileFinanceOrder(w.db, id)).complete, true);
  assert.equal(await reverseCancelledSale(w.db, id, baghdadDay()), 0, 'nothing left to reverse');
  assert.deepEqual(w.journal(), journal);
});

test('the stage panel (delivered → out_for_delivery → cancelled): the same reversal', async () => {
  const w = world();
  const id = await w.delivered('cart_stage');
  await w.stage(id, 'out_for_delivery');
  await w.stage(id, 'cancelled');
  assert.equal(row(w.raw, 'SELECT status FROM orders WHERE id=?', id)?.status, 'cancelled');
  assert.equal((await w.drainAll())[0].completed, 1);
  assertReversed(w, id, ['sale', 'cogs']);
});

test('a forced courier sync (a status mapped to cancelled takes a delivered order straight to cancelled): the same reversal', async () => {
  const w = world();
  const id = await w.delivered('cart_courier');
  w.raw.prepare("UPDATE orders SET delivery_provider='alwaseet',delivery_remote_id='AW-T1' WHERE id=?").run(id);
  const now = new Date().toISOString();
  await upsertRemoteStatuses(w.db, 'alwaseet', [{ id: '17', text: 'راجع' }], now);
  await setStatusMapping(w.db, 'alwaseet', '17', 'cancelled', now);
  const sync = await syncOrderDelivery(w.env, new StubCourier('17'), id);
  assert.deepEqual([sync.outcome, sync.stage], ['moved', 'cancelled'], JSON.stringify(sync));
  assert.equal(row(w.raw, 'SELECT status FROM orders WHERE id=?', id)?.status, 'cancelled');
  assert.equal((await w.drainAll())[0].completed, 1);
  assertReversed(w, id, ['sale', 'cogs']);
});

test('the customer\'s own cancel, after the team walked the delivered order back to pending: the same reversal', async () => {
  const w = world();
  const id = await w.delivered('cart_customer');
  await w.move(id, 'shipped');
  await w.move(id, 'pending');
  const cancel = await post(w.a.buyer, `/api/orders/${id}/cancel`, {});
  assert.equal(cancel.status, 200, JSON.stringify(await json(cancel.clone())));
  assert.equal(row(w.raw, 'SELECT status FROM orders WHERE id=?', id)?.status, 'cancelled');
  assert.equal((await w.drainAll())[0].completed, 1);
  assertReversed(w, id, ['sale', 'cogs']);
});

test('a wallet-paid order: after the cancel gives the wallet back and the sale is reversed, 2300 and 2200 net to 0', async () => {
  const w = world();
  const id = await w.delivered('cart_wallet', { useWallet: true });
  assert.deepEqual(row(w.raw, 'SELECT wallet_applied_iqd,due_on_delivery_iqd FROM orders WHERE id=?', id), { wallet_applied_iqd: 20000, due_on_delivery_iqd: 0 });
  await w.move(id, 'shipped');
  await w.move(id, 'cancelled');
  assert.ok(w.entries(id).some((e) => e.event_key === `cancel-wallet:${id}`), 'the cancel returned the wallet money');
  // What the live books showed until now: the customers' advance account 20,000 in debit.
  assert.equal(w.nets(id)['2300'], 20000);
  assert.equal((await w.drainAll())[0].completed, 1);
  assertReversed(w, id, ['sale', 'cogs']);
  assert.deepEqual([w.nets(id)['2300'], w.nets(id)['2200']], [0, 0]);
});

/** A D1 whose first batch waits until `between` has run: another writer landing between this one's read and its write. */
function racing(db: D1Database, between: () => Promise<unknown>) {
  let raced = false;
  return { prepare: (sql: string) => db.prepare(sql), batch: async (s: D1PreparedStatement[]) => { if (!raced) { raced = true; await between(); } return db.batch(s); } } as D1Database;
}

test('two writers racing make exactly one reversal (UNIQUE event_key and reversal_of); a re-open in between makes none', async () => {
  const w = world();
  const id = await w.delivered('cart_race');
  await w.move(id, 'shipped');
  await w.move(id, 'cancelled');
  let other = -1;
  // The second writer reads the same journal, then commits first.
  const mine = await reverseCancelledSale(racing(w.db, async () => { other = await reverseCancelledSale(w.db, id, baghdadDay()); }), id, baghdadDay());
  assert.deepEqual([other, mine], [2, 0], 'one writer posted both reversals, the other found them done');
  assert.equal(count(w.raw, "SELECT COUNT(*) n FROM accounting_entries WHERE event_key LIKE 'order-cancel:%'"), 2);
  assertReversed(w, id, ['sale', 'cogs']);
  assert.equal((await drainOrderFinanceRecovery(w.env)).scanned, 0, 'the scan has nothing left to do');
  // The order re-opened between the read and the write: the order's fence refuses the batch, nothing is posted.
  const reopened = await w.delivered('cart_race_reopen');
  await w.move(reopened, 'shipped');
  await w.move(reopened, 'cancelled');
  const journal = w.journal();
  const refused = await reverseCancelledSale(racing(w.db, async () => { w.raw.prepare("UPDATE orders SET status='pending' WHERE id=?").run(reopened); }), reopened, baghdadDay());
  assert.equal(refused, 0);
  assert.deepEqual(w.journal(), journal);
});

test('not reversed: a walk-back with no cancel, a cancel before delivery, a merchant\'s order; a free order with no sale lets the scan complete', async () => {
  const w = world();
  // Walked back only: still owed, still a sale in the books until it is cancelled or delivered again.
  const back = await w.delivered('cart_back');
  await w.move(back, 'shipped');
  // Cancelled before it was ever delivered: nothing was posted, nothing to reverse.
  const early = await w.placed('cart_early');
  await w.move(early, 'confirmed');
  await w.move(early, 'cancelled');
  // A community store's order: never a Levonis sale (here with an invented sale entry, to prove the guard).
  w.raw.exec(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,delivered_at,seller_type)
    VALUES ('ORD-T-STORE','buyer','cancelled','{}','standard','{}','cash',9000,1500,9000,9000,'2026-10-01T10:00:00.000Z','2026-10-02T10:00:00.000Z','merchant')`);
  await w.db.batch(journalPlan(w.db, { key: 'sale:ORD-T-STORE', day: baghdadDay(), title: 'Invented', source: 'order', sourceId: 'ORD-T-STORE' },
    [{ account: '1100', debit: 9000 }, { account: '4000', credit: 9000 }]).statements);
  // A free order (a replacement): no sale entry; a delivery marker left behind makes it a candidate.
  w.raw.exec(`INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,created_at,delivered_at)
      VALUES ('ORD-T-FREE','buyer','delivered','{}','standard','{}','cash',0,1500,0,0,'2026-10-01T10:00:00.000Z','2026-10-02T10:00:00.000Z');
    INSERT INTO order_items(id,order_id,product_id,name_snapshot,qty,unit_price_iqd,line_total_iqd,cost_iqd,cost_basis) VALUES ('line:ORD-T-FREE','ORD-T-FREE','p_other','Other',1,0,0,0,'snapshot');`);
  await runOrderFinancialEffects(w.env, 'ORD-T-FREE', 'delivered');
  assert.equal(count(w.raw, "SELECT COUNT(*) n FROM accounting_entries WHERE source_id='ORD-T-FREE'"), 0, 'a free order books no sale');
  w.raw.exec(`UPDATE orders SET status='cancelled' WHERE id='ORD-T-FREE';
    INSERT INTO finance_posting_errors(event_key,order_id,message,last_attempt_at) VALUES ('delivered:ORD-T-FREE','ORD-T-FREE','posting pending','2026-10-02T10:00:00.000Z');`);
  const journal = w.journal();
  const report = await drainOrderFinanceRecovery(w.env);
  assert.deepEqual([report.scanned, report.completed, report.failed], [1, 1, 0], JSON.stringify(report));
  assert.equal(count(w.raw, "SELECT COUNT(*) n FROM finance_posting_errors WHERE order_id='ORD-T-FREE'"), 0);
  assert.equal((await drainOrderFinanceRecovery(w.env)).scanned, 0);
  for (const id of [back, early, 'ORD-T-STORE', 'ORD-T-FREE']) {
    await reconcileFinanceOrder(w.db, id);
    assert.equal(await reverseCancelledSale(w.db, id, baghdadDay()), 0, id);
  }
  assert.deepEqual(w.journal(), journal, 'nothing was posted for any of them');
  assert.deepEqual(w.entries(back).map((e) => e.event_key.split(':')[0]).sort(), ['cogs', 'sale'], 'the walked-back order keeps its sale and cost');
  assert.equal(count(w.raw, "SELECT COUNT(*) n FROM accounting_entries WHERE event_key LIKE 'order-cancel:%'"), 0);
});

test('delivered in a month since closed: the reversal posts in today\'s open month and nothing is written to the closed one', async () => {
  const w = world();
  const month = previousMonth(), at = `${month}-15T10:00:00.000Z`;
  const id = await w.placed('cart_october');
  await w.move(id, 'confirmed');
  // Delivered last month (the delivery door's own effects, on that delivery's day).
  w.raw.prepare("UPDATE orders SET status='delivered',stage='delivered',delivered_at=? WHERE id=?").run(at, id);
  await runOrderFinancialEffects(w.env, id, 'delivered');
  assert.deepEqual(w.entries(id).map((e) => [e.event_key.split(':')[0], e.entry_day]).sort(), [['cogs', `${month}-15`], ['sale', `${month}-15`]]);
  w.raw.prepare('INSERT INTO accounting_periods(month,closed_at,closed_by) VALUES (?,?,?)').run(month, new Date().toISOString(), 'boss');
  const closed = count(w.raw, 'SELECT COUNT(*) n FROM accounting_entries WHERE substr(entry_day,1,7)=?', month);
  await w.move(id, 'shipped');
  await w.move(id, 'cancelled');
  assert.equal((await w.drainAll())[0].completed, 1);
  assertReversed(w, id, ['sale', 'cogs']);
  assert.equal(count(w.raw, 'SELECT COUNT(*) n FROM accounting_entries WHERE substr(entry_day,1,7)=?', month), closed, 'the closed month is untouched');
});

/** A world where an employee (the seeded staff row) earns 2,500 a delivered order and an investor funds the nozzle cleaner's batch; one more order stays delivered. */
async function peopleWorld(cancelAfterDelivery: boolean) {
  const w = world({ people: true });
  const rule = await post(w.fin, '/ops/rules', { staff_id: 'staff_hussein', basis: 'order', amount: 2500, milestone: 'delivered' });
  await w.ok(rule, 'rule');
  for (let i = 0; i < 20; i++) if ((await continueStaffReconciliation(w.env, 'staff_hussein'))?.state === 'complete') break;
  const contract = { operation_id: 'twin-contract-01', incoming_id: 'inc_plain', user_id: 'investor', name: 'تمويل منظفات', principal_iqd: 18000, capital_share_bps: 10000, profit_share_bps: 3500, loss_share_bps: 0 };
  await w.ok(await post(w.fin, '/i/contracts', contract), 'contract');
  await w.ok(await post(w.fin, `/i/contracts/${contract.operation_id}/funding`, { operation_id: 'twin-funding-01', amount_iqd: 18000, payment_day: baghdadDay(), reference: 'cash receipt' }), 'funding');
  const kept = await w.delivered('cart_kept');
  let gone: string;
  if (cancelAfterDelivery) {
    gone = await w.delivered('cart_gone');
    // Its cash came in before the cancel (no courier fee).
    await w.ok(await post(w.fin, '/ops/collections', { operation_id: 'twin-cash-0001', order_id: gone, amount_iqd: 20000, fee_iqd: 0, collection_day: baghdadDay(), payer: 'customer' }), 'collection');
    await w.move(gone, 'shipped');
    await w.move(gone, 'cancelled');
  } else {
    gone = await w.placed('cart_gone');
    await w.move(gone, 'confirmed');
    await w.move(gone, 'cancelled');
  }
  await w.drainAll();
  // The shop's dollar rate since January (set after the checkout, which prices at the fixture's rate).
  usd(w.raw);
  return { ...w, kept, gone };
}

test('every screen and every person agree with a twin where the order was never delivered', async () => {
  const [a, b] = [await peopleWorld(true), await peopleWorld(false)];
  assertReversed(a, a.gone, ['sale', 'cogs'], 20000);
  const day = baghdadDay(), range = `from=${day}&to=${day}`;
  const read = async (w: World, path: string) => w.ok(await get(w.fin, path), path);
  // The kept order has its own ids, checkout key and timestamps in each world: name them the same before comparing.
  const own = (w: World & { kept: string }) => [w.kept, ...all<{ v: string }>(w.raw, `SELECT id v FROM order_items WHERE order_id=?1 UNION ALL SELECT id FROM order_item_inventory_allocations WHERE order_id=?1
    UNION ALL SELECT client_idempotency_key FROM orders WHERE id=?1 AND client_idempotency_key<>''`, w.kept).map((r) => r.v)];
  const plain = (s: string, w: World & { kept: string }) => own(w).reduce((t, v, i) => t.split(v).join(`KEPT${i}`), s).replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'T');
  const same = (x: unknown, w: World & { kept: string }) => JSON.parse(plain(JSON.stringify(x), w));
  const [sa, sb] = [await read(a, `/f/summary?${range}`), await read(b, `/f/summary?${range}`)];
  assert.deepEqual(same(sa, a), same(sb, b), 'the summary, whole');
  assert.deepEqual(sa.orders.map((o: { id: string }) => o.id), [a.kept], 'the period lists the kept order alone');
  // The files, whole.
  const text = async (w: World, path: string) => { const r = await get(w.fin, path); assert.equal(r.status, 200, path); return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await r.arrayBuffer()); };
  for (const view of ['days', 'products', 'sections', 'orders', 'lines']) {
    const [fa, fb] = [await text(a, `/f/export.csv?view=${view}&${range}`), await text(b, `/f/export.csv?view=${view}&${range}`)];
    assert.equal(plain(fa, a), plain(fb, b), view);
  }
  const lines = await text(a, `/f/export.csv?view=lines&${range}`);
  assert.ok(lines.includes(a.kept) && !lines.includes(a.gone), 'the lines file has the kept order alone');
  // The drawer: every figure of the statement opens on the same total.
  for (const key of [...STATEMENT_FIGURES, 'cashDue', 'cashOpen'] as const) {
    for (const part of drillParts(sa as unknown as FinanceSummary, key)) {
      const [da, db] = [drill(sa as unknown as FinanceSummary, key, part), drill(sb as unknown as FinanceSummary, key, part)];
      assert.deepEqual([da.total, da.rows.length], [db.total, db.rows.length], `${key} ${String(part)}`);
    }
  }
  // In dollars too.
  const [ua, ub] = [await read(a, `/f/summary?${range}&display=USD`), await read(b, `/f/summary?${range}&display=USD`)];
  assert.equal(ua.display_usd.available, true);
  assert.deepEqual(same(ua.display_usd, a), same(ub.display_usd, b), 'the dollars, whole');
  // The people: the wage of the cancelled order is 0 (row 307), its investor share 0 (row 308).
  const wage = (w: World, id: string) => count(w.raw, `SELECT COALESCE(SUM(c.amount_iqd+COALESCE((SELECT SUM(delta_iqd) FROM finance_cost_adjustments x WHERE x.cost_id=c.id),0)),0) n
    FROM finance_order_costs c WHERE c.order_id=? AND c.staff_id='staff_hussein'`, id);
  assert.deepEqual([wage(a, a.gone), wage(a, a.kept), wage(b, b.kept)], [0, 2500, 2500]);
  const share = (w: World, id: string) => count(w.raw, 'SELECT COALESCE(SUM(r.profit_iqd),0) n FROM investor_allocation_results r JOIN order_item_inventory_allocations x ON x.id=r.allocation_id WHERE x.order_id=?', id);
  assert.equal(share(a, a.gone), 0);
  assert.ok(share(a, a.kept) > 0);
  assert.equal(share(a, a.kept), share(b, b.kept));
  const [ha, hb] = [(await participantOverview(a.db, 'packer')).summary, (await participantOverview(b.db, 'packer')).summary];
  assert.deepEqual([ha.staff_iqd, ha.staff_available_iqd], [hb.staff_iqd, hb.staff_available_iqd]);
  const [ia, ib] = [(await participantOverview(a.db, 'investor')).summary, (await participantOverview(b.db, 'investor')).summary];
  assert.deepEqual([ia.investor_profit_iqd, ia.investor_profit_available_iqd, ia.capital_iqd], [ib.investor_profit_iqd, ib.investor_profit_available_iqd, ib.capital_iqd]);
  // Receivables: the cancelled order is not listed; its receivable is 0 less the cash it collected — to give back.
  const receivables = await read(a, '/ops/receivables');
  assert.deepEqual(receivables.orders.map((o: { id: string }) => o.id).filter((id: string) => id === a.gone), []);
  assert.deepEqual([a.nets(a.gone)['1100'], a.nets(a.gone)['4000'], a.nets(a.gone)['5000']], [-20000, 0, 0]);
  assert.equal(a.trial(), 0);
});

test('with no cash recorded, the cancelled order\'s receivable is 0 and the receivables list does not name it', async () => {
  const w = world();
  const id = await w.delivered('cart_receivable');
  assert.ok(((await w.ok(await get(w.fin, '/ops/receivables'), 'receivables')).orders as Array<{ id: string }>).some((o) => o.id === id), 'owed while delivered');
  await w.move(id, 'shipped');
  await w.move(id, 'cancelled');
  await w.drainAll();
  assert.deepEqual(((await w.ok(await get(w.fin, '/ops/receivables'), 'receivables')).orders as Array<{ id: string }>).map((o) => o.id), []);
  assert.equal(w.nets(id)['1100'], 0);
});

test('a goods cost the owner verified through «التكاليف الناقصة» is taken back too: its overlays end at 0, and 5000 nets 0', async () => {
  const w = world();
  // An untracked part with no purchase price: delivered, its cost waits.
  const id = await w.delivered('cart_overlay', {}, 'p_loose');
  assert.equal(count(w.raw, 'SELECT COUNT(*) n FROM accounting_entries WHERE event_key=?', `cogs:${id}`), 0, 'no goods cost entry: the price is unknown');
  const line = row<{ id: string }>(w.raw, 'SELECT id FROM order_items WHERE order_id=?', id)!.id;
  const verified = await post(w.fin, '/f/missing-costs/lines', { order_id: id, line_id: line, unit_iqd: 4000, cost_qty: 1, operation_id: 'overlay-cost-001' });
  await w.ok(verified, 'missing cost');
  const overlay = () => all<{ field: string; total: number }>(w.raw, 'SELECT field,SUM(delta_iqd) total FROM finance_workspace_postings WHERE order_id=? GROUP BY field ORDER BY field', id).map((r) => [r.field, r.total]);
  assert.deepEqual(overlay(), [['cogs_iqd', 4000]]);
  assert.equal(w.nets(id)['5000'], 4000);
  await w.move(id, 'shipped');
  await w.move(id, 'cancelled');
  assert.equal((await w.drainAll())[0].completed, 1);
  assertReversed(w, id, ['sale']);
  assert.deepEqual(overlay(), [['cogs_iqd', 0]], 'the overlay is taken back by a negative posting');
  const zeroing = all<{ source_type: string; entry_day: string }>(w.raw, `SELECT e.source_type,e.entry_day FROM finance_workspace_postings p JOIN accounting_entries e ON e.id=p.journal_id
    WHERE p.order_id=? AND p.delta_iqd<0`, id).map((e) => ({ ...e }));
  assert.deepEqual(zeroing, [{ source_type: 'order_workspace', entry_day: baghdadDay() }]);
  assert.equal(w.nets(id)['5000'], 0);
  assert.equal(w.nets(id)['2990'], 0);
  // Idempotent: nothing more on a replay.
  const journal = w.journal();
  assert.equal(await reverseCancelledSale(w.db, id, baghdadDay()), 0);
  await reconcileFinanceOrder(w.db, id);
  assert.deepEqual(w.journal(), journal);
});

test('R-b: re-opened and delivered again, the sale is back in the books today; a second cancel reverses it once more', async () => {
  const w = world();
  // A cash order of an untracked part with a recorded cost: the only kind that can be re-opened (row 310).
  const id = await w.placed('cart_again', {}, 'p_loose');
  w.raw.prepare("UPDATE order_items SET cost_iqd=4000,cost_basis='snapshot',estimated_cost_iqd=NULL WHERE order_id=?").run(id);
  await w.move(id, 'confirmed');
  await w.move(id, 'delivered');
  const first = row<{ delivered_at: string }>(w.raw, 'SELECT delivered_at FROM orders WHERE id=?', id)!.delivered_at;
  assert.deepEqual(w.nets(id), { ...w.zero, 1100: 17000, 4000: -12000, 4100: -5000, 5000: 4000, 1200: -4000 });
  await w.move(id, 'shipped');
  await w.move(id, 'cancelled');
  await w.drainAll();
  assertReversed(w, id, ['sale', 'cogs']);
  // Re-opened and delivered again through the same door.
  await w.move(id, 'pending');
  await w.move(id, 'confirmed');
  await w.move(id, 'delivered');
  assert.equal(row<{ delivered_at: string }>(w.raw, 'SELECT delivered_at FROM orders WHERE id=?', id)!.delivered_at, first, 'the first delivery day stays');
  const redelivered = w.entries(id).filter((e) => e.event_key.startsWith('order-redeliver:'));
  const reversals = w.entries(id).filter((e) => e.event_key.startsWith('order-cancel:'));
  assert.equal(redelivered.length, 2, 'one re-posting each for the sale and its cost');
  assert.deepEqual(redelivered.map((e) => e.reversal_of).sort(), reversals.map((e) => e.id).sort(), 'each reverses its reversal');
  for (const e of redelivered) assert.deepEqual([e.source_type, e.entry_day, e.event_key], ['order_cancel', baghdadDay(), `order-redeliver:${e.reversal_of}`]);
  // Delivered: exactly one sale and one goods cost in the books.
  assert.deepEqual(w.nets(id), { ...w.zero, 1100: 17000, 4000: -12000, 4100: -5000, 5000: 4000, 1200: -4000 });
  const live = count(w.raw, `SELECT COUNT(*) n FROM accounting_entries e WHERE e.source_id=? AND (e.event_key IN (?,?) OR e.event_key LIKE 'order-redeliver:%')
    AND NOT EXISTS(SELECT 1 FROM accounting_entries r WHERE r.reversal_of=e.id)`, id, `sale:${id}`, `cogs:${id}`);
  assert.equal(live, 2, 'one live sale and one live cost');
  await drainOrderFinanceRecovery(w.env);
  await reconcileFinanceOrder(w.db, id);
  assert.equal(w.entries(id).filter((e) => e.event_key.startsWith('order-redeliver:')).length, 2, 'a replay posts nothing more');
  // Cancelled again: the re-posting is reversed, once.
  await w.move(id, 'shipped');
  await w.move(id, 'cancelled');
  const report = (await w.drainAll())[0];
  assert.deepEqual([report.scanned, report.completed], [1, 1], JSON.stringify(report));
  const again = w.entries(id).filter((e) => e.event_key.startsWith('order-cancel:') && redelivered.some((r) => r.id === e.reversal_of));
  assert.equal(again.length, 2);
  assert.deepEqual(w.nets(id), w.zero);
  assert.equal(count(w.raw, 'SELECT COUNT(*) n FROM accounting_entries WHERE source_id=?', id), 8, 'sale, cost, two reversals, two re-postings, two reversals');
  assert.equal(count(w.raw, 'SELECT COUNT(DISTINCT event_key) n FROM accounting_entries WHERE source_id=?', id), 8);
  assert.equal((await drainOrderFinanceRecovery(w.env)).scanned, 0);
});

test('R-b, the shape the live store can reach: an untracked part whose cost is not recorded books a sale alone, and gets one re-posting', async () => {
  const w = world();
  const id = await w.delivered('cart_again_plain', {}, 'p_loose');
  assert.deepEqual(w.entries(id).map((e) => e.event_key.split(':')[0]), ['sale']);
  await w.move(id, 'shipped');
  await w.move(id, 'cancelled');
  await w.drainAll();
  assertReversed(w, id, ['sale']);
  const reopen = await patch(w.a.admin, `/api/admin/orders/${id}`, { status: 'pending' });
  assert.equal(reopen.status, 200, 'a cash order of an untracked part re-opens (row 310)');
  await w.move(id, 'confirmed');
  await w.move(id, 'delivered');
  const redelivered = w.entries(id).filter((e) => e.event_key.startsWith('order-redeliver:'));
  assert.equal(redelivered.length, 1);
  assert.deepEqual([redelivered[0].entry_day, redelivered[0].source_type], [baghdadDay(), 'order_cancel']);
  assert.deepEqual(w.nets(id), { ...w.zero, 1100: 17000, 4000: -12000, 4100: -5000 }, 'one sale in the books while delivered');
  await w.move(id, 'shipped');
  await w.move(id, 'cancelled');
  await w.drainAll();
  assert.equal(w.entries(id).filter((e) => e.reversal_of === redelivered[0].id).length, 1, 'the second cancel reverses the re-posting once');
  assert.deepEqual(w.nets(id), w.zero);
});

/**
 * The owner's read-only check before the deploy (paste into the D1 console as it is): every order the scan will reverse
 * on the deploy day, what each reversal takes out — goods sale (4000), delivery income (4100), goods cost (5000), the
 * owner's verified cost overlay — the cash recorded on it (to give back) and its refunded returns (a refund already
 * paid stays: the double refund the cancel door still allows, DECISIONS row 318). After the scan has run it lists none.
 */
const OWNER_CHECK = `SELECT o.id, o.delivered_at, o.cancelled_at,
  (SELECT COUNT(*) FROM accounting_entries e WHERE e.event_key IN ('sale:'||o.id,'membership-sale:'||o.id,'cogs:'||o.id) AND e.state='posted') AS entries,
  (SELECT COALESCE(SUM(l.credit_iqd-l.debit_iqd),0) FROM accounting_entries e JOIN accounting_lines l ON l.entry_id=e.id
     WHERE e.event_key IN ('sale:'||o.id,'membership-sale:'||o.id) AND e.state='posted' AND l.account_code='4000') AS goods_iqd,
  (SELECT COALESCE(SUM(l.credit_iqd-l.debit_iqd),0) FROM accounting_entries e JOIN accounting_lines l ON l.entry_id=e.id
     WHERE e.event_key IN ('sale:'||o.id,'membership-sale:'||o.id) AND e.state='posted' AND l.account_code='4100') AS delivery_iqd,
  (SELECT COALESCE(SUM(l.debit_iqd-l.credit_iqd),0) FROM accounting_entries e JOIN accounting_lines l ON l.entry_id=e.id
     WHERE e.event_key='cogs:'||o.id AND e.state='posted' AND l.account_code='5000') AS cost_iqd,
  (SELECT COALESCE(SUM(p.delta_iqd),0) FROM finance_workspace_postings p WHERE p.order_id=o.id AND p.field='cogs_iqd') AS verified_cost_iqd,
  (SELECT COALESCE(SUM(c.amount_iqd),0) FROM finance_collections c WHERE c.order_id=o.id) AS cash_iqd,
  (SELECT COUNT(*) FROM finance_refund_facts f WHERE f.order_id=o.id) AS refunds
FROM orders o
WHERE o.seller_type='levonis' AND o.status='cancelled' AND o.delivered_at<>''
  AND EXISTS(SELECT 1 FROM accounting_entries e WHERE e.event_key IN ('sale:'||o.id,'membership-sale:'||o.id,'cogs:'||o.id) AND e.state='posted'
    AND NOT EXISTS(SELECT 1 FROM accounting_entries r WHERE r.reversal_of=e.id))
ORDER BY o.delivered_at;`;

test('the owner\'s read-only check names exactly the orders the scan reverses on the deploy day, and none once it has run', async () => {
  const w = world();
  const cash = await w.delivered('cart_check_cash');
  await w.ok(await post(w.fin, '/ops/collections', { operation_id: 'check-cash-0001', order_id: cash, amount_iqd: 20000, fee_iqd: 0, collection_day: baghdadDay(), payer: 'customer' }), 'collection');
  const wallet = await w.delivered('cart_check_wallet', { useWallet: true });
  const back = await w.delivered('cart_check_back');
  for (const id of [cash, wallet, back]) await w.move(id, 'shipped');
  for (const id of [cash, wallet]) await w.move(id, 'cancelled');
  const early = await w.placed('cart_check_early');
  await w.move(early, 'confirmed');
  await w.move(early, 'cancelled');
  const rows = all<Record<string, unknown>>(w.raw, OWNER_CHECK).map((r) => ({ ...r }));
  assert.deepEqual(rows.map((r) => r.id).sort(), [cash, wallet].sort(), 'the two cancelled after delivery; not the walk-back nor the early cancel');
  for (const r of rows) assert.deepEqual([r.entries, r.goods_iqd, r.delivery_iqd, r.cost_iqd, r.verified_cost_iqd, r.cash_iqd, r.refunds], [2, 15000, 5000, 6000, 0, r.id === cash ? 20000 : 0, 0]);
  await w.drainAll();
  assert.deepEqual(all(w.raw, OWNER_CHECK), [], 'after the scan: nothing left to reverse');
  for (const id of [cash, wallet]) assertReversed(w, id, ['sale', 'cogs'], id === cash ? 20000 : 0);
});

test('the D1 budget: a reversal is one read and one batch; the delivery path keeps its two journal lookups and no more', async (context) => {
  const w = world();
  const id = await w.delivered('cart_budget');
  // The delivery path, replayed: the sale and the goods cost are each looked up by one statement, as before.
  const seen: string[] = [];
  let batches = 0;
  const spy = { prepare(sql: string) { seen.push(sql); return w.db.prepare(sql); }, batch(s: D1PreparedStatement[]) { batches++; return w.db.batch(s); } } as D1Database;
  await runOrderFinancialEffects({ DB: spy } as Env, id, 'delivered');
  assert.equal(seen.filter((s) => s.startsWith('WITH RECURSIVE chain(id,depth)')).length, 2);
  assert.equal(seen.filter((s) => s === 'SELECT id FROM accounting_entries WHERE event_key=?').length, 0);
  assert.equal(seen.some((s) => s.includes("'cogs:'||?1) AND state='posted'")), false, 'the delivered path never runs the reversal read');
  await w.move(id, 'shipped');
  await w.move(id, 'cancelled');
  seen.length = 0; batches = 0;
  assert.equal(await reverseCancelledSale(spy, id, baghdadDay()), 2);
  // One read; the batch: the order's fence (2), the sale's reversal (1 + 3 lines + 1), the cost's (1 + 2 + 1).
  context.diagnostic(`a reversal of a sale and its cost: ${seen.length} prepared statements in ${batches} batch`);
  assert.deepEqual([seen.length, batches], [12, 1]);
  assert.equal(seen.filter((s) => s.includes('periodOpen') || s.startsWith('SELECT month FROM accounting_periods')).length, 0, 'no period read of its own');
});

test('the books check (DECISIONS row 327) names an order cancelled after delivery while its sale is still in the journal, and nothing once the scan reversed it', async () => {
  const w = world();
  const found = async () => (await runFinanceChecks(w.db)).checks.find((c) => c.key === 'cancelled_after_delivery_in_journal')!;
  const id = await w.delivered('cart_books');
  assert.equal((await found()).count, 0, 'delivered: nothing to look at');
  await w.move(id, 'shipped');
  await w.move(id, 'cancelled');
  const before = await found();
  assert.deepEqual([before.count, before.sample], [1, [id]], 'cancelled after delivery, its sale still in the journal');
  await w.drainAll();
  assert.equal((await found()).count, 0, 'reversed like a return: off the list');
});
