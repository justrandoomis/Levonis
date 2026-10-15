import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, post, json, row } from './fixtures/app';
import { priceProtectionRoutes, returnRoutes } from '../worker/routes/returns';

function world() {
  const raw = freshDb();
  raw.exec(`INSERT INTO users(id,name,email,password_hash,role) VALUES
    ('buyer','Buyer','buyer@x.co','h','customer'),('boss','Admin','boss@x.co','h','admin');
    INSERT INTO products(id,slug,name,price_iqd,status,stock,inventory_mode,selling_type,sale_types)
      VALUES('p','p','Product',40000,'active',5,'BASE','direct_sale','["direct_sale"]');
    INSERT INTO orders(id,user_id,status,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,
      subtotal_iqd,shipping_iqd,exchange_rate,total_iqd,due_on_delivery_iqd,delivered_at)
      VALUES('ord','buyer','delivered','{}','standard','{}','cash',50000,0,1400,50000,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    INSERT INTO order_items(id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd)
      VALUES('item','ord','p','Product','',1,50000,50000);`);
  const native = asD1(raw);
  let tail: Promise<unknown> = Promise.resolve();
  const db = { prepare: native.prepare.bind(native), batch: (statements: D1PreparedStatement[]) => {
    const next = tail.then(() => native.batch(statements));
    tail = next.catch(() => undefined);
    return next;
  } } as unknown as D1Database;
  // A requested claim, written the way a database older than 0191 can hold it:
  // a duplicate «requested» claim on one line exists only in data older than
  // 0191's ppc_one_open (G3), which refuses a second requested INSERT — so the
  // row goes in as 'rejected' and is moved to 'requested' (no trigger stops an UPDATE).
  const claim = (id = 'pp', drop = 10000, item = 'item') => {
    raw.prepare(`INSERT INTO price_protection_claims
      (id,user_id,order_id,order_item_id,original_unit_iqd,observed_unit_iqd,qty,state)
      VALUES(?,'buyer','ord',?,50000,?,1,'rejected')`).run(id, item, 50000 - drop);
    raw.prepare("UPDATE price_protection_claims SET state = 'requested' WHERE id = ?").run(id);
  };
  const returnCase = (id = 'ret', item = 'item') => raw.prepare(`INSERT INTO return_cases
    (id,order_id,order_item_id,user_id,qty,reason,state,within_window)
    VALUES(?,'ord',?,'buyer',1,'defective','inspected',1)`).run(id, item);
  const creditTotal = () => Number(raw.prepare("SELECT COALESCE(SUM(amount_iqd),0) n FROM wallet_transactions WHERE id LIKE 'wtx_pp_%' OR id LIKE 'wtx_ret_%'").get()!.n);
  return { raw, native, db, claim, returnCase, creditTotal };
}
const adminApp = (db: D1Database) => stubApp(db, { id: 'boss', role: 'admin', email: 'boss@x.co' }, a => {
  a.route('/api/price-protection', priceProtectionRoutes); a.route('/api/returns', returnRoutes);
});
const approve = (db: D1Database, id = 'pp') => post(adminApp(db), `/api/price-protection/admin/claims/${id}/decide`, { decision: 'approved' });
const refund = (db: D1Database, id = 'ret') => post(adminApp(db), `/api/returns/admin/${id}/transition`, { to: 'resolved', resolution: 'refund' });

/** Both callers finish planning before either money batch starts. D1 then
 * serializes complete transactions; this adapter does not nest SQLite BEGINs. */
function raceDb(w: ReturnType<typeof world>, first: 'protection' | 'return', onFirstWaiting?: () => void) {
  const waiting: Array<{ kind: string; statements: D1PreparedStatement[]; resolve: (value: unknown) => void; reject: (reason: unknown) => void }> = [];
  let released = false;
  return { prepare: w.native.prepare.bind(w.native), batch: (statements: D1PreparedStatement[]) => {
    const sql = statements.map(s => (s as unknown as { sql: string }).sql).join('\n');
    const kind = sql.includes("'financial_guard'") ? 'protection'
      : sql.includes("SELECT ?,?,?,?,-1,'defective','inspected'") ? 'return' : null;
    if (!kind || released) return w.db.batch(statements);
    return new Promise((resolve, reject) => {
      waiting.push({ kind, statements, resolve, reject });
      if (waiting.length === 1) onFirstWaiting?.();
      if (waiting.length === 2) {
        released = true;
        void (async () => {
          waiting.sort((a, b) => Number(b.kind === first) - Number(a.kind === first));
          const outcomes: Array<{ ok: boolean; value: unknown }> = [];
          for (const item of waiting) {
            try { outcomes.push({ ok: true, value: await w.native.batch(item.statements) }); }
            catch (error) { outcomes.push({ ok: false, value: error }); }
          }
          waiting.forEach((item, i) => outcomes[i].ok ? item.resolve(outcomes[i].value) : item.reject(outcomes[i].value));
        })();
      }
    });
  } } as unknown as D1Database;
}

test('price protection below one wallet cent stays requested for review, with no claimed payment', async () => {
  const w = world(); w.claim('tiny', 1);
  const res = await approve(w.db, 'tiny');
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'PRICE_PROTECTION_REVIEW_REQUIRED');
  assert.deepEqual(row(w.raw, "SELECT state,credited_iqd FROM price_protection_claims WHERE id='tiny'"), { state: 'requested', credited_iqd: 0 });
  assert.equal(w.creditTotal(), 0);
});

test('a failed wallet credit rolls back the protection decision and a retry pays exactly once', async () => {
  const w = world(); w.claim();
  w.raw.exec("CREATE TRIGGER fail_protection BEFORE INSERT ON wallet_transactions WHEN NEW.id='wtx_pp_pp' BEGIN SELECT RAISE(ABORT,'synthetic credit failure'); END");
  assert.equal((await approve(w.db)).status, 500);
  assert.deepEqual(row(w.raw, "SELECT state,credited_iqd FROM price_protection_claims WHERE id='pp'"), { state: 'requested', credited_iqd: 0 });
  assert.equal(w.creditTotal(), 0);
  w.raw.exec('DROP TRIGGER fail_protection');
  assert.equal((await approve(w.db)).status, 200);
  assert.equal(w.creditTotal(), 10000);
  assert.equal((await approve(w.db)).status, 400);
  assert.equal(w.creditTotal(), 10000);
});

test('an unexplained existing wallet credit is preserved and does not mark a requested claim paid', async () => {
  const w = world(); w.claim();
  w.raw.exec("INSERT INTO wallet_transactions(id,user_id,type,currency,amount,status,amount_iqd,exchange_rate_snapshot) VALUES('wtx_pp_pp','buyer','deposit','USD',100,'approved',1400,1400)");
  const res = await approve(w.db);
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'PRICE_PROTECTION_REVIEW_REQUIRED');
  assert.equal(row(w.raw, "SELECT state FROM price_protection_claims WHERE id='pp'")!.state, 'requested');
  assert.equal(w.creditTotal(), 1400);
});

test('concurrent protection claims recheck the common cumulative cap in their transactions', async () => {
  const w = world(); w.claim('first', 10000); w.claim('second', 15000);
  const db = raceDb(w, 'protection');
  const responses = await Promise.all([approve(db, 'first'), approve(db, 'second')]);
  assert.deepEqual(responses.map(r => r.status), [200, 400]);
  assert.equal((await json(responses[1])).code, 'PRICE_PROTECTION_RETRY');
  assert.equal(w.creditTotal(), 10000);
  assert.equal((await approve(w.db, 'second')).status, 200);
  assert.equal(w.creditTotal(), 15000);
  assert.equal(row(w.raw, "SELECT SUM(credited_iqd) n FROM price_protection_claims")!.n, 15000);
});

test('a return after protection requires quantity/compensation review and preserves the earlier credit', async () => {
  // The return is opened after protection paid; an open return before the
  // approval holds the approval instead (review 2026-10-13, PF-1).
  const w = world(); w.claim();
  assert.equal((await approve(w.db)).status, 200);
  w.returnCase();
  const res = await refund(w.db);
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'PRICE_PROTECTION_RETURN_REVIEW');
  assert.equal(row(w.raw, "SELECT state FROM return_cases WHERE id='ret'")!.state, 'inspected');
  assert.equal(w.creditTotal(), 10000);
});

test('a returned item cannot later receive protection through an existing or a new claim', async () => {
  const w = world(); w.claim(); w.returnCase();
  assert.equal((await refund(w.db)).status, 200);
  const res = await approve(w.db);
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'PRICE_PROTECTION_RETURN_REVIEW');
  const customer = stubApp(w.db, { id: 'buyer', role: 'customer', email: 'buyer@x.co' }, a => a.route('/api/price-protection', priceProtectionRoutes));
  const created = await post(customer, '/api/price-protection/claims', { orderItemId: 'item' });
  assert.equal(created.status, 400);
  assert.equal((await json(created)).code, 'PRICE_PROTECTION_RETURN_REVIEW');
  assert.equal(w.creditTotal(), 50000);
});

/* Since PF-1 (review 2026-10-13) an open return holds the approval before it
 * plans, so the race that remains is a return that reaches the store after the
 * approval planned and before its batch commits. The approval's in-batch guard
 * sees the open (or refunded) return in either order: the return decides the
 * line and pays, and protection stays requested. */
for (const first of ['protection', 'return'] as const) {
  test(`a concurrent return and protection cannot both pay when ${first} commits first`, async () => {
    const w = world(); w.claim();
    let refunding: ReturnType<typeof refund> | undefined;
    const db = raceDb(w, first, () => { w.returnCase(); refunding = refund(db); });
    const approving = approve(db);
    const approved = await approving;
    const refunded = await refunding!;
    assert.deepEqual([approved.status, refunded.status], [400, 200]);
    assert.equal((await json(approved)).code, 'PRICE_PROTECTION_RETRY');
    assert.equal(w.creditTotal(), 50000);
    assert.equal(row(w.raw, "SELECT state FROM return_cases WHERE id='ret'")!.state, 'resolved');
    assert.equal(row(w.raw, "SELECT state FROM price_protection_claims WHERE id='pp'")!.state, 'requested');
    assert.equal(row(w.raw, "SELECT COUNT(*) n FROM price_protection_claims WHERE state='financial_guard'")!.n, 0);
  });
}

test('partial returns require review only on the overlapping item, not another item of the same order', async () => {
  const w = world();
  w.raw.exec(`UPDATE order_items SET qty=2,line_total_iqd=100000 WHERE id='item';
    INSERT INTO order_items(id,order_id,product_id,name_snapshot,option_snapshot,qty,unit_price_iqd,line_total_iqd)
      VALUES('other','ord','p','Other','',1,50000,50000);
    UPDATE orders SET subtotal_iqd=150000,total_iqd=150000 WHERE id='ord';`);
  // An open return of another line does not hold this line's protection; a
  // return of this line opened after protection pays needs review (PF-1).
  w.claim(); w.returnCase('unrelated', 'other');
  assert.equal((await approve(w.db)).status, 200);
  w.returnCase('overlap');
  assert.equal((await refund(w.db, 'overlap')).status, 400);
  assert.equal((await refund(w.db, 'unrelated')).status, 200);
  assert.equal(w.creditTotal(), 60000);
});

test('atomic protection approval does not require the newer operations guard table', async () => {
  const w = world(); w.claim();
  // A database without ops_guards (0162) predates the import guard triggers of
  // 0195 too, which read it on every write to the money tables: drop them with it.
  for (const { name } of w.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_import_guard_%'").all() as Array<{ name: string }>) {
    w.raw.exec(`DROP TRIGGER ${name}`);
  }
  w.raw.exec('DROP TABLE ops_guards');
  assert.equal((await approve(w.db)).status, 200);
  assert.equal(w.creditTotal(), 10000);
});


test('an older claim stranded in approved requires review before another claim can pay', async () => {
  const w = world(); w.claim('legacy'); w.claim('next', 15000);
  w.raw.exec("UPDATE price_protection_claims SET state='approved' WHERE id='legacy'");
  const res = await approve(w.db, 'next');
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'PRICE_PROTECTION_REVIEW_REQUIRED');
  assert.equal(w.creditTotal(), 0);
  assert.equal(row(w.raw, "SELECT state FROM price_protection_claims WHERE id='legacy'")!.state, 'approved');
  assert.equal(row(w.raw, "SELECT state FROM price_protection_claims WHERE id='next'")!.state, 'requested');
});

test('a changed accepted invoice total cannot pay against a stale protection basis', async () => {
  const w = world(); w.claim();
  let changed = false;
  const db = { prepare: w.db.prepare.bind(w.db), batch: (statements: D1PreparedStatement[]) => {
    if (!changed && statements.some(s => (s as unknown as { sql: string }).sql.includes("'financial_guard'"))) {
      changed = true;
      w.raw.exec("UPDATE orders SET total_iqd=25000,price_adjustment_iqd=-25000 WHERE id='ord'");
    }
    return w.db.batch(statements);
  } } as unknown as D1Database;
  const res = await approve(db);
  assert.equal(res.status, 400);
  assert.equal((await json(res)).code, 'PRICE_PROTECTION_RETRY');
  assert.equal(w.creditTotal(), 0);
  assert.equal(row(w.raw, "SELECT state FROM price_protection_claims WHERE id='pp'")!.state, 'requested');
  const retry = await approve(w.db);
  assert.equal(retry.status, 400);
  assert.equal((await json(retry)).code, 'NO_ELIGIBLE_DROP');
});
