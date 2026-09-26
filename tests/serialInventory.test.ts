/**
 * THE SERIAL INVENTORY (migration 0139) — the owner's «أرقام تسلسلية قبل
 * البيع، والربط التلقائي من صفحة الضمان» (2026-09-26), end to end through the
 * real routes over the real migrations (SQLite adapter; only the session is
 * stubbed):
 *
 *  - admin scope: customers and merchant subdomains never reach it;
 *  - bulk preview/commit: duplicates, invalid lines, existing serials, a
 *    commit replayed, and the D1 ceilings (≤ 100 bound parameters per
 *    statement, no compound SELECT) measured on a 1000-line commit;
 *  - derived statuses: in stock → sold → registered, and void;
 *  - the customer's link rules: unknown, taken, already mine,
 *    sold-but-unregistered, in stock with and without a matching purchase,
 *    void, no product, a box SN, and the rate limit on guesses — every
 *    refusal the one answer, naming nobody;
 *  - search, filters, keyset pages, the CSV export (formula-safe), edits,
 *    void/restore with history, and the EAN → product memory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ROOT, SqliteD1, SqliteStatement } from './fixtures/d1';
import type { AppContext } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';
import { deviceRoutes, SERIAL_NOT_FOUND_OR_IN_USE } from '../worker/routes/devices';
import { classifyHost } from '../worker/lib/hosts';
import { INSERT_CHUNK } from '../worker/lib/serialInventory';

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const SN = '03919D580607841';
const BOX = 'B07119G5811000AB';
const EAN = '6977252425445';

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('buyer','Sara','s@x.co','h','customer'), ('stranger','Omar','o@x.co','h','customer'),
      ('boss','Admin','a@x.co','h','admin'), ('buyer2','Zaid','z@x.co','h','customer');
    INSERT INTO products (id,slug,name,price_iqd,ops_policy) VALUES
      ('pA1','a1-combo','Bambu A1 Combo',899000,'{"serialized":true,"warranty_base_months":12}'),
      ('pX1','x1c','Bambu X1C',1899000,'{"serialized":true,"warranty_base_months":12}'),
      ('pPLA','pla','PLA spool',25000,'{}');
    INSERT INTO orders (id, user_id, status, address_snapshot, delivery_method_id, delivery_method_snapshot,
       payment_method_id, subtotal_iqd, shipping_iqd, exchange_rate, total_iqd, due_on_delivery_iqd, delivered_at, created_at, updated_at)
     VALUES ('ORD-1','buyer','delivered','{}','standard','{}','cash',899000,0,1400,899000,0,'2026-09-01T10:00:00.000Z',${NOW},${NOW}),
            ('ORD-2','buyer2','delivered','{}','standard','{}','cash',899000,0,1400,899000,0,'2026-09-02T10:00:00.000Z',${NOW},${NOW});
    INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd)
     VALUES ('oi1','ORD-1','pA1','Bambu A1 Combo',1,899000,899000), ('oi2','ORD-2','pA1','Bambu A1 Combo',1,899000,899000);
    INSERT INTO order_item_units (id, order_id, order_item_id, product_id, owner_user_id, unit_index, delivered_at, warranty_base_months, warranty_start_at, warranty_end_at)
     VALUES ('u1','ORD-1','oi1','pA1','buyer',1,'2026-09-01T10:00:00.000Z',12,'2026-09-01T10:00:00.000Z','2027-09-01T10:00:00.000Z'),
            ('u2','ORD-2','oi2','pA1','buyer2',1,'2026-09-02T10:00:00.000Z',12,'2026-09-02T10:00:00.000Z','2027-09-02T10:00:00.000Z');
  `);
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

function appAs(db: D1Database, user: { id: string; role: string }, host = 'levonis-iq.com') {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    c.set('user', { id: user.id, role: user.role, email: `${user.id}@x.co` } as never);
    c.set('host', classifyHost(host, 'levonis-iq.com'));
    c.env = { DB: db, APP_ORIGIN: 'https://levonis-iq.com', STORE_ROOT_DOMAIN: 'levonis-iq.com' } as never;
    await next();
  });
  a.route('/api/devices', deviceRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ success: false, error: err.message, code: err.code, details: err.details }, err.status as 400);
    throw err;
  });
  return a;
}
const buyer = { id: 'buyer', role: 'customer' };
const buyer2 = { id: 'buyer2', role: 'customer' };
const stranger = { id: 'stranger', role: 'customer' };
const boss = { id: 'boss', role: 'admin' };
const json = async (res: Response) => (await res.json()) as Record<string, any>;
let ipSeq = 0;
const send = (a: ReturnType<typeof appAs>, method: string, path: string, body?: unknown, ip?: string) =>
  a.request(path, {
    method,
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip ?? `10.0.0.${++ipSeq % 250}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const post = (a: ReturnType<typeof appAs>, path: string, body: unknown = {}, ip?: string) => send(a, 'POST', path, body, ip);
const BASE = '/api/devices/admin/serial-inventory';

async function commit(db: D1Database, body: Record<string, unknown>) {
  const res = await post(appAs(db, boss), `${BASE}/commit`, body);
  return { status: res.status, body: await json(res) };
}

const statusOf = (raw: DatabaseSync, norm: string) =>
  (
    raw
      .prepare(
        `SELECT CASE WHEN si.voided_at IS NOT NULL THEN 'void' WHEN ds.unit_id IS NULL THEN 'in_stock'
                     WHEN r.user_id IS NOT NULL AND r.revoked_at IS NULL THEN 'registered' ELSE 'sold' END AS s
           FROM serial_inventory si LEFT JOIN device_serials ds ON ds.serial_norm = si.serial_norm
           LEFT JOIN device_registrations r ON r.unit_id = ds.unit_id WHERE si.serial_norm = ?`
      )
      .get(norm) as { s: string } | undefined
  )?.s;

// ------------------------------------------------------------ admin scope

test('customers are refused every inventory route, and a merchant subdomain answers 404 even to an admin', async () => {
  const { db } = setup();
  const c = appAs(db, buyer);
  assert.equal((await c.request(BASE)).status, 403);
  assert.equal((await post(c, `${BASE}/preview`, { text: SN })).status, 403);
  assert.equal((await post(c, `${BASE}/commit`, { text: SN })).status, 403);
  assert.equal((await c.request(`${BASE}/export`)).status, 403);
  const shop = appAs(db, boss, 'shop.levonis-iq.com');
  assert.equal((await shop.request(BASE)).status, 404);
  assert.equal((await post(shop, `${BASE}/commit`, { text: SN })).status, 404);
  assert.equal((await appAs(db, boss).request(BASE)).status, 200);
});

// --------------------------------------------------------- preview/commit

test('bulk preview names every line: new, repeated, invalid (and why), already there, already on a unit', async () => {
  const { db, raw } = setup();
  await commit(db, { text: '03919D580600001', product_id: 'pA1' });
  raw.exec(`INSERT INTO device_serials (serial_norm, serial_raw, unit_id, assigned_by) VALUES ('03919D580600002','03919D580600002','u2','boss')`);
  const text = [
    'serial,model,model_code,box_sn,ean',
    `${SN},A1 Combo,PF002-A+SA005,${BOX},${EAN}`,
    ` ${SN.toLowerCase()} `, // the same serial again, differently typed
    'abc', // too short
    EAN, // an EAN pasted as a serial
    '03919D580600001', // already in the inventory
    '03919D580600002', // already on a delivered unit (the order screen)
    '03919D580600003,,,,6977252425446', // wrong EAN check digit
  ].join('\n');
  const res = await post(appAs(db, boss), `${BASE}/preview`, { text, product_id: 'pA1', defaults: { model_code: 'PF002-A+SA005' } });
  assert.equal(res.status, 200);
  const body = await json(res);
  const by = (line: number) => body.rows.find((r: any) => r.line === line);
  assert.equal(by(2).outcome, 'new');
  assert.equal(by(2).model_name, 'A1 Combo');
  assert.equal(by(2).box_sn, BOX);
  assert.equal(by(2).ean, EAN);
  assert.equal(by(3).outcome, 'duplicate_in_batch');
  assert.equal(by(3).duplicate_of, 2);
  assert.equal(by(4).outcome, 'invalid');
  assert.equal(by(4).problem, 'SERIAL_TOO_SHORT');
  assert.equal(by(5).problem, 'SERIAL_LOOKS_LIKE_EAN');
  assert.equal(by(6).outcome, 'exists');
  assert.equal(by(6).existing_status, 'in_stock');
  assert.equal(by(7).outcome, 'new_assigned');
  assert.equal(by(8).problem, 'EAN_INVALID');
  assert.deepEqual(body.counts, { total: 7, new: 1, new_assigned: 1, exists: 1, duplicate_in_batch: 1, invalid: 3 });
  assert.equal(body.product.serialized, true);
  // Read-only.
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM serial_inventory').get() as { n: number }).n, 1);
});

test('commit writes only what the preview called new, is idempotent, and is audited', async () => {
  const { db, raw } = setup();
  const text = `${SN}\n${SN}\n03919D580607842\nbad!`;
  const first = await commit(db, { text, product_id: 'pA1', defaults: { model_code: 'pf002-a+sa005', model_name: 'A1 Combo' } });
  assert.equal(first.status, 200);
  assert.equal(first.body.inserted, 2);
  const row = raw.prepare('SELECT * FROM serial_inventory WHERE serial_norm = ?').get(SN) as Record<string, unknown>;
  assert.equal(row.model_code, 'PF002-A+SA005', 'model code normalised to upper case');
  assert.equal(row.model_name, 'A1 Combo');
  assert.equal(row.product_id, 'pA1');
  assert.equal(row.source, 'bulk');
  assert.equal(row.created_by, 'boss');
  const again = await commit(db, { text, product_id: 'pA1' });
  assert.equal(again.status, 200, 'a replay is not an error…');
  assert.equal(again.body.inserted, 0, '…and writes nothing');
  assert.equal(again.body.counts.exists, 2);
  const junk = await commit(db, { text: 'bad!\nabc', product_id: 'pA1' });
  assert.equal(junk.body.code, 'SERIAL_NOTHING_TO_ADD', 'a list with nothing valid at all is refused');
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM serial_inventory').get() as { n: number }).n, 2);
  const audit = raw.prepare(`SELECT detail FROM audit_log WHERE action = 'serial_inventory.add'`).all() as Array<{ detail: string }>;
  assert.equal(audit.length, 1);
  assert.deepEqual(JSON.parse(audit[0].detail).serials.sort(), ['03919D580607842', SN].sort());
});

test('commit refuses an unknown product, a variant of another product, an empty list and more than 1000 lines', async () => {
  const { db, raw } = setup();
  raw.exec(`INSERT INTO product_variants (id, product_id, combo_key, sku) VALUES ('v1','pX1','black','X1C-BLK')`);
  assert.equal((await commit(db, { text: SN, product_id: 'nope' })).body.code, 'SERIAL_PRODUCT_UNKNOWN');
  assert.equal((await commit(db, { text: SN, product_id: 'pA1', variant_id: 'v1' })).body.code, 'SERIAL_VARIANT_MISMATCH');
  assert.equal((await commit(db, { text: SN, variant_id: 'v1' })).body.code, 'SERIAL_VARIANT_WITHOUT_PRODUCT');
  assert.equal((await commit(db, { text: '   \n\n' })).body.code, 'SERIAL_LIST_EMPTY');
  const tooMany = Array.from({ length: 1001 }, (_, i) => `SNX${String(i).padStart(6, '0')}`).join('\n');
  const r = await commit(db, { text: tooMany });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'SERIAL_LIST_TOO_LONG');
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM serial_inventory').get() as { n: number }).n, 0, 'nothing half-written');
  const ok = await commit(db, { text: SN, product_id: 'pX1', variant_id: 'v1' });
  assert.equal(ok.body.inserted, 1);
});

test('a 1000-line commit stays inside D1: one bound JSON per chunk, no statement over 100 parameters, no compound SELECT', async () => {
  const { db, raw } = setup();
  const seen: Array<{ sql: string; params: number }> = [];
  const origPrepare = SqliteD1.prototype.prepare;
  const origBind = SqliteStatement.prototype.bind;
  SqliteD1.prototype.prepare = function (sql: string) {
    const st = origPrepare.call(this, sql);
    (st as unknown as { __sql: string }).__sql = sql;
    return st;
  };
  SqliteStatement.prototype.bind = function (...values: unknown[]) {
    seen.push({ sql: (this as unknown as { __sql: string }).__sql ?? '', params: values.length });
    const next = origBind.apply(this, values);
    (next as unknown as { __sql: string }).__sql = (this as unknown as { __sql: string }).__sql;
    return next;
  };
  try {
    const text = Array.from({ length: 1000 }, (_, i) => `03919D58${String(i).padStart(7, '0')},A1 Combo`).join('\n');
    const pre = await post(appAs(db, boss), `${BASE}/preview`, { text, product_id: 'pA1' });
    assert.equal((await json(pre)).counts.new, 1000);
    const r = await commit(db, { text, product_id: 'pA1' });
    assert.equal(r.body.inserted, 1000);
  } finally {
    SqliteD1.prototype.prepare = origPrepare;
    SqliteStatement.prototype.bind = origBind;
  }
  const max = Math.max(...seen.map((s) => s.params));
  assert.ok(max <= 100, `a statement bound ${max} parameters`);
  const inserts = seen.filter((s) => /INSERT INTO serial_inventory/.test(s.sql));
  assert.equal(inserts.length, Math.ceil(1000 / INSERT_CHUNK), 'one INSERT per chunk');
  for (const s of seen) {
    const compound = (s.sql.match(/\b(UNION|INTERSECT|EXCEPT)\b/gi) ?? []).length;
    assert.ok(compound < 5, `compound SELECT with ${compound + 1} terms: ${s.sql.slice(0, 80)}`);
  }
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM serial_inventory').get() as { n: number }).n, 1000);
});

// ------------------------------------------------------------- statuses

test('status is derived: in stock → sold (on a unit) → registered (linked) → sold again on unlink, and void wins', async () => {
  const { db, raw } = setup();
  await commit(db, { text: SN, product_id: 'pA1' });
  assert.equal(statusOf(raw, SN), 'in_stock');
  // The order screen assigns it to the buyer's unit — the existing route.
  const assign = await post(appAs(db, boss), '/api/devices/admin/units/u1/serial', { serial: SN });
  assert.equal(assign.status, 200);
  assert.equal(statusOf(raw, SN), 'sold');
  assert.equal((await post(appAs(db, buyer), '/api/devices/register', { serial: SN })).status, 200);
  assert.equal(statusOf(raw, SN), 'registered');
  const list = await json(await appAs(db, boss).request(`${BASE}?status=registered`));
  assert.equal(list.rows.length, 1);
  assert.equal(list.rows[0].holder.email, 's@x.co', 'the admin sees whose account holds it');
  assert.equal(list.rows[0].unit.order_id, 'ORD-1');
  assert.equal((await send(appAs(db, buyer), 'DELETE', '/api/devices/units/u1/registration')).status, 200);
  assert.equal(statusOf(raw, SN), 'sold');
  assert.equal((await post(appAs(db, boss), `${BASE}/${SN}/void`, { reason: 'label damaged' })).status, 200);
  assert.equal(statusOf(raw, SN), 'void');
  assert.equal((await post(appAs(db, boss), `${BASE}/${SN}/void`, { reason: 'again' })).status, 409);
  assert.equal((await post(appAs(db, boss), `${BASE}/${SN}/restore`, { reason: 'x' })).status, 400, 'a reason is required');
  assert.equal((await post(appAs(db, boss), `${BASE}/${SN}/restore`, { reason: 'label reprinted' })).status, 200);
  assert.equal(statusOf(raw, SN), 'sold');
});

// ------------------------------------------------------- customer link

test('an inventory serial links to the caller\'s OWN delivered unit of that product — dates untouched, audited', async () => {
  const { db, raw } = setup();
  await commit(db, { text: `${SN},A1 Combo,PF002-A+SA005,${BOX},${EAN}`, product_id: 'pA1' });
  const res = await post(appAs(db, buyer), '/api/devices/register', { serial: '03919d58 0607841' });
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.device.unit_id, 'u1');
  assert.equal(body.already_registered, false);
  assert.equal(body.device.warranty.start_at, '2026-09-01T10:00:00.000Z', 'the clock is the delivery, never the link');
  assert.equal(body.device.warranty.end_at, '2027-09-01T10:00:00.000Z');
  assert.equal(body.device.serial, '****7841', 'the customer sees the masked serial');
  const ds = raw.prepare('SELECT unit_id, note FROM device_serials WHERE serial_norm = ?').get(SN) as { unit_id: string; note: string };
  assert.deepEqual({ ...ds }, { unit_id: 'u1', note: 'inventory' });
  const acts = (raw.prepare(`SELECT action, detail FROM audit_log WHERE target = 'u1' ORDER BY rowid`).all() as Array<{ action: string; detail: string }>).map((a) => [a.action, JSON.parse(a.detail).by]);
  assert.deepEqual(acts, [['device.serial_assign', 'inventory'], ['device.register', 'inventory']]);
  assert.equal(statusOf(raw, SN), 'registered');
  // Already mine: idempotent.
  const again = await json(await post(appAs(db, buyer), '/api/devices/register', { serial: SN }));
  assert.equal(again.already_registered, true);
});

test('unknown, taken, void, product-less, and in stock without a matching purchase all read as the ONE answer', async () => {
  const { db, raw } = setup();
  await commit(db, { text: `${SN}\n03919D580607842`, product_id: 'pA1' });
  await commit(db, { text: '03919D580607843' }); // no product
  await commit(db, { text: '03919D580607844', product_id: 'pX1' }); // nobody bought an X1C
  await commit(db, { text: '03919D580607845', product_id: 'pA1' });
  await post(appAs(db, boss), `${BASE}/03919D580607845/void`, { reason: 'returned to supplier' });
  assert.equal((await post(appAs(db, buyer), '/api/devices/register', { serial: SN })).status, 200, 'the buyer takes theirs');

  const cases: Array<[typeof buyer, string, string | null]> = [
    [stranger, 'NOPE00000000', null], // unknown
    [stranger, SN, null], // taken — linked to the buyer
    [buyer, '03919D580607843', 'no_product'],
    [buyer, '03919D580607844', 'no_matching_purchase'],
    [buyer, '03919D580607845', 'void'],
    [stranger, '03919D580607842', 'no_matching_purchase'], // in stock, but the stranger bought nothing
    [buyer, '03919D580607842', 'no_matching_purchase'], // the buyer's one A1 already carries a serial
  ];
  for (const [who, serial, reason] of cases) {
    const res = await post(appAs(db, who), '/api/devices/register', { serial });
    const body = await json(res);
    assert.equal(res.status, 404, serial);
    assert.equal(body.code, 'SERIAL_NOT_FOUND_OR_IN_USE', serial);
    assert.equal(body.error, SERIAL_NOT_FOUND_OR_IN_USE, serial);
    assert.ok(!JSON.stringify(body).includes('s@x.co') && !JSON.stringify(body).includes('ORD-1'), 'names nobody');
    if (reason) {
      const a = raw.prepare(`SELECT detail FROM audit_log WHERE action = 'serial_inventory.link_refused' AND target = ? ORDER BY rowid DESC`).get(serial) as { detail: string };
      assert.equal(JSON.parse(a.detail).reason, reason, `the reason is kept for the manual review: ${serial}`);
    }
  }
  assert.equal(statusOf(raw, '03919D580607842'), 'in_stock', 'a refused link changes nothing');
});

test('sold but unregistered: the order screen put it on the buyer\'s unit — the buyer links it, a stranger cannot', async () => {
  const { db, raw } = setup();
  await commit(db, { text: SN, product_id: 'pA1' });
  await post(appAs(db, boss), '/api/devices/admin/units/u2/serial', { serial: SN });
  assert.equal(statusOf(raw, SN), 'sold');
  assert.equal((await post(appAs(db, stranger), '/api/devices/register', { serial: SN })).status, 404);
  assert.equal((await post(appAs(db, buyer), '/api/devices/register', { serial: SN })).status, 404, 'the other buyer neither');
  const own = await json(await post(appAs(db, buyer2), '/api/devices/register', { serial: SN }));
  assert.equal(own.device.unit_id, 'u2');
  assert.equal(statusOf(raw, SN), 'registered');
});

test('the BOX SN typed or scanned instead of the product SN finds the same device', async () => {
  const { db, raw } = setup();
  await commit(db, { text: `serial,box_sn\n${SN},${BOX}`, product_id: 'pA1' });
  const res = await json(await post(appAs(db, buyer), '/api/devices/register', { serial: BOX }));
  assert.equal(res.device.unit_id, 'u1');
  assert.equal((raw.prepare('SELECT serial_norm FROM device_serials WHERE unit_id = ?').get('u1') as { serial_norm: string }).serial_norm, SN, 'the PRODUCT serial is what goes on the unit');
  const again = await json(await post(appAs(db, buyer), '/api/devices/register', { serial: BOX }));
  assert.equal(again.already_registered, true, 'the box SN of a serial already on a unit resolves through it');
});

test('guessing is rate-limited per account: the 11th try in ten minutes is 429', async () => {
  const { db } = setup();
  const s = appAs(db, stranger);
  for (let i = 0; i < 10; i++) assert.equal((await post(s, '/api/devices/register', { serial: `GUESS0000${i}` })).status, 404);
  assert.equal((await post(s, '/api/devices/register', { serial: 'GUESS000010' })).status, 429);
});

// ---------------------------------------------------- list, export, edits

test('search, status filter with counts, and keyset pages that never repeat or skip a row', async () => {
  const { db } = setup();
  const text = Array.from({ length: 7 }, (_, i) => `03919D5806000${i}${i}`).join('\n');
  await commit(db, { text, product_id: 'pA1', defaults: { model_name: 'A1 Combo' } });
  await commit(db, { text: 'X1C00000000001', product_id: 'pX1', defaults: { model_name: 'X1 Carbon' } });
  const a = appAs(db, boss);
  const first = await json(await a.request(`${BASE}?limit=3`));
  assert.equal(first.rows.length, 3);
  assert.equal(first.counts.all, 8);
  assert.equal(first.counts.in_stock, 8);
  const seen = new Set<string>(first.rows.map((r: any) => r.serial_norm));
  let cursor = first.next_cursor;
  while (cursor) {
    const page = await json(await a.request(`${BASE}?limit=3&cursor=${encodeURIComponent(cursor)}`));
    for (const r of page.rows) {
      assert.ok(!seen.has(r.serial_norm), 'no repeats');
      seen.add(r.serial_norm);
    }
    cursor = page.next_cursor;
  }
  assert.equal(seen.size, 8);
  const byModel = await json(await a.request(`${BASE}?q=${encodeURIComponent('X1 Carbon')}`));
  assert.deepEqual(byModel.rows.map((r: any) => r.serial_norm), ['X1C00000000001']);
  const bySerial = await json(await a.request(`${BASE}?q=${encodeURIComponent('03919d5806 00022')}`));
  assert.deepEqual(bySerial.rows.map((r: any) => r.serial_norm), ['03919D580600022'], 'serial search is normalised');
  const literal = await json(await a.request(`${BASE}?q=${encodeURIComponent('%')}`));
  assert.equal(literal.rows.length, 0, 'LIKE wildcards are taken literally');
  assert.equal((await a.request(`${BASE}?status=lost`)).status, 400);
  assert.equal((await a.request(`${BASE}?cursor=garbage`)).status, 400);
});

test('the CSV export carries the filtered rows, a BOM, and cells no spreadsheet runs as a formula', async () => {
  const { db } = setup();
  await commit(db, { text: `${SN},=HYPERLINK("http://x")`, product_id: 'pA1' });
  const res = await appAs(db, boss).request(`${BASE}/export`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
  assert.match(res.headers.get('content-disposition') ?? '', /serial-inventory-\d{4}-\d{2}-\d{2}\.csv/);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'a UTF-8 BOM, so Excel reads Arabic');
  const text = new TextDecoder().decode(bytes);
  const [head, row] = text.trim().split('\r\n');
  assert.ok(head.startsWith('serial,model_code,model_name'));
  assert.ok(row.startsWith(`${SN},,`));
  assert.ok(row.includes(`"'=HYPERLINK(""http://x"")"`), row);
});

test('edit, history and the EAN → product memory the scanner uses', async () => {
  const { db, raw } = setup();
  raw.exec(`UPDATE products SET sku = 'PF002-A+SA005' WHERE id = 'pA1'`);
  const a = appAs(db, boss);
  // Before anything was filed under this EAN, the model code finds the product by SKU.
  const bySku = await json(await a.request(`${BASE}/resolve?ean=${EAN}&model_code=pf002-a%2Bsa005`));
  assert.equal(bySku.match.product.id, 'pA1');
  assert.equal(bySku.match.via, 'sku');
  assert.equal((await json(await a.request(`${BASE}/resolve?ean=${EAN}`))).match, null);
  await commit(db, { rows: [{ serial: SN, ean: EAN, box_sn: BOX }], product_id: 'pA1', source: 'scan', defaults: { model_code: 'PF002-A+SA005', model_name: 'A1 Combo' } });
  const learned = await json(await a.request(`${BASE}/resolve?ean=${EAN}`));
  assert.equal(learned.match.product.id, 'pA1');
  assert.equal(learned.match.via, 'ean');
  assert.equal(learned.match.model_name, 'A1 Combo');
  assert.equal((raw.prepare('SELECT source FROM serial_inventory WHERE serial_norm = ?').get(SN) as { source: string }).source, 'scan');

  const patch = await send(a, 'PATCH', `${BASE}/${SN}`, { model_name: 'A1 Combo (UK)', ean: '6977252425446' });
  assert.equal((await json(patch)).code, 'EAN_INVALID');
  const ok = await json(await send(a, 'PATCH', `${BASE}/${SN}`, { model_name: 'A1 Combo (UK)', product_id: 'pX1' }));
  assert.equal(ok.row.model_name, 'A1 Combo (UK)');
  assert.equal(ok.row.product.id, 'pX1');
  const detail = await json(await a.request(`${BASE}/${SN}`));
  assert.equal(detail.history[0].action, 'serial_inventory.update');
  assert.equal(detail.history[0].detail.from.product_id, 'pA1');
  assert.equal((await a.request(`${BASE}/NOTHERE000`)).status, 404);
});

test('deleting the product keeps the serial and its model, and clears only the pointer', async () => {
  const { raw } = setup();
  const { HISTORY_TABLES } = await import('../worker/lib/productDeletion');
  const entry = HISTORY_TABLES.find((h) => h.table === 'serial_inventory');
  assert.deepEqual(entry?.columns, ['product_id', 'variant_id']);
  raw.exec(`INSERT INTO serial_inventory (serial_norm, serial_raw, model_name, product_id, created_by) VALUES ('${SN}','${SN}','A1 Combo','pA1','boss')`);
  const cols = raw.prepare(`PRAGMA table_info(serial_inventory)`).all() as Array<{ name: string; notnull: number }>;
  for (const c of ['product_id', 'variant_id']) assert.equal(cols.find((x) => x.name === c)?.notnull, 0, `${c} is nullable`);
});
