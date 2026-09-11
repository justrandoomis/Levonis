/**
 * QUICK EDIT NEVER WRITES A ROW THE PRODUCT FORM WOULD REFUSE (M2).
 *
 * The PATCH handler used to run only parseAmount / negative / profit-guard
 * checks, so `pro_adjust +10,000` on the +25,000 option of a product with no
 * base PRO was stored, the grid showed PRO 185,000 on a 175,000 row, and the
 * next save from the product form was refused on a field the form does not
 * display. The routes now judge the product AS IT WOULD READ after the change
 * with the validator the relations PUT runs, and answer that PUT's envelope.
 *
 * The real router runs against the real migrations through the SQLite
 * adapter; only the session is stubbed (tests/ordersCustomer.test.ts pattern).
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ROOT, SqliteD1 } from './fixtures/d1';
import type { AppContext } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';
import { adminPriceGridRoutes } from '../worker/routes/adminPriceGrid';
import type { PricingProduct } from '../worker/lib/pricing';
import { LADDER_FIXTURES } from './pricingLadderFixtures';

// --------------------------------------------------------------- harness

function freshDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  raw.exec(`INSERT INTO users (id,name,email,password_hash,role) VALUES ('boss','Admin','a@x.co','h','admin');`);
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

/** The owner's base row: 150,000 / PRIME 125,000 / PRO 100,000 unless told otherwise. */
function seedProduct(raw: DatabaseSync, over: { prime?: number | null; pro?: number | null } = {}) {
  const prime = over.prime === undefined ? 125_000 : over.prime;
  const pro = over.pro === undefined ? 100_000 : over.pro;
  raw.exec(`
    INSERT INTO products (id,slug,name,name_ar,price_iqd,prime_price_iqd,pro_price_iqd,images)
      VALUES ('p1','p1','Printer','طابعة',150000,${prime === null ? 'NULL' : prime},${pro === null ? 'NULL' : pro},'[]');
    INSERT INTO product_option_groups (id,product_id,name_en) VALUES ('g1','p1','Model');
  `);
}

function seedOption(raw: DatabaseSync, id: string, cols: Record<string, number | null>) {
  const keys = Object.keys(cols);
  raw.exec(
    `INSERT INTO product_option_values (id,product_id,group_id,name_en${keys.map((k) => `,${k}`).join('')})
       VALUES ('${id}','p1','g1','${id}'${keys.map((k) => `,${cols[k] === null ? 'NULL' : cols[k]}`).join('')});`
  );
}

function seedColour(raw: DatabaseSync, id: string, linked: string[], cols: Record<string, number | null>) {
  const keys = Object.keys(cols);
  raw.exec(
    `INSERT INTO product_colors (id,product_id,name_en,hex${keys.map((k) => `,${k}`).join('')})
       VALUES ('${id}','p1','${id}','#000000'${keys.map((k) => `,${cols[k] === null ? 'NULL' : cols[k]}`).join('')});`
  );
  for (const o of linked) raw.exec(`INSERT INTO product_color_option_links (color_id,option_value_id,group_id) VALUES ('${id}','${o}','g1');`);
}

function adminApp(db: D1Database) {
  const app = new Hono<AppContext>();
  app.use('*', async (c, next) => {
    c.set('user', { id: 'boss', role: 'admin', email: 'a@x.co' } as never);
    c.env = { DB: db, INITIAL_ADMIN_EMAIL: '' } as never;
    await next();
  });
  app.route('/api/admin/products', adminPriceGridRoutes);
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ success: false, error: err.message, code: err.code }, err.status as 400);
    throw err;
  });
  return app;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response) => (await res.json()) as Record<string, any>;
const send = (app: ReturnType<typeof adminApp>, method: string, path: string, body: unknown) =>
  app.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const patch = (app: ReturnType<typeof adminApp>, cells: unknown[]) => send(app, 'PATCH', '/api/admin/products/p1/price-grid', { cells });
type Row = { level: string; id: string; cells: Record<string, { effective: number | null; mode: string }> };
const rowOf = (rows: Row[], id: string) => rows.find((r) => r.id === id)!;

// ------------------------------------------------------------------ PATCH

test('M2: a PRO adjustment that lifts PRO above the row\'s regular price is refused with the form\'s message, and nothing is written', async () => {
  const { raw, db } = freshDb();
  seedProduct(raw, { prime: null, pro: null });
  seedOption(raw, 'o1', { regular_adjust_iqd: 25_000 });
  const res = await patch(adminApp(db), [{ level: 'option', id: 'o1', field: 'pro', mode: 'adjust', value: '10000' }]);
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.equal(body.code, 'VALIDATION', 'the relations PUT\'s envelope');
  assert.deepEqual(body.errors, ['o1: the PRO price this row resolves to (185000) is above its regular price (175000)']);
  assert.equal(body.error, body.errors[0]);
  assert.equal(raw.prepare('SELECT pro_adjust_iqd FROM product_option_values WHERE id = ?').get('o1')!.pro_adjust_iqd, null, 'not stored');
  assert.equal((raw.prepare('SELECT COUNT(*) AS n FROM price_history').get() as { n: number }).n, 0, 'no history row for a refused write');
});

test('a valid PATCH still writes, and the grid it returns is the resolver\'s numbers', async () => {
  const { raw, db } = freshDb();
  seedProduct(raw);
  seedOption(raw, 'o1', { regular_adjust_iqd: 25_000 });
  const res = await patch(adminApp(db), [{ level: 'option', id: 'o1', field: 'pro', mode: 'adjust', value: '-10000' }]);
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.changed, 1);
  const row = rowOf(body.rows, 'o1');
  assert.deepEqual([row.cells.regular.effective, row.cells.prime.effective, row.cells.pro.effective], [175_000, 150_000, 115_000]);
  assert.equal(raw.prepare('SELECT pro_adjust_iqd FROM product_option_values WHERE id = ?').get('o1')!.pro_adjust_iqd, -10_000);
});

test('H1 via Quick Edit: a PRIME price below the PRO the row carries is refused', async () => {
  const { raw, db } = freshDb();
  seedProduct(raw);
  seedOption(raw, 'o1', { regular_adjust_iqd: 25_000 });
  const res = await patch(adminApp(db), [{ level: 'option', id: 'o1', field: 'prime', mode: 'fixed', value: '120000' }]);
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.match(body.errors[0], /^o1: the PRIME price this row resolves to \(120000\) is below the PRO price it resolves to \(125000\)/);
});

test('M3 via Quick Edit: a colour price that swallows its option\'s own PRO is refused, naming the option and the colour', async () => {
  const { raw, db } = freshDb();
  seedProduct(raw);
  seedOption(raw, 'o1', { regular_adjust_iqd: 100_000, pro_price_iqd: 40_000 });
  seedColour(raw, 'c1', ['o1'], {});
  const res = await patch(adminApp(db), [{ level: 'color', id: 'c1', field: 'regular', mode: 'fixed', value: '130000' }]);
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.match(body.errors[0], /^c1: with option "o1", the reduction is larger than the PRO price this colour inherits \(40000\) — state a PRO price for it, or reduce less/);
  // Stating the colour's own PRO in the same request is accepted.
  const ok = await patch(adminApp(db), [
    { level: 'color', id: 'c1', field: 'regular', mode: 'fixed', value: '130000' },
    { level: 'color', id: 'c1', field: 'pro', mode: 'fixed', value: '100000' },
  ]);
  assert.equal(ok.status, 200);
  const row = rowOf((await json(ok)).rows, 'c1');
  assert.deepEqual([row.cells.regular.effective, row.cells.prime.effective, row.cells.pro.effective], [130_000, 105_000, 100_000]);
});

test('a base-row change re-checks every row: raising the base PRO past an option\'s own PRIME is refused on that option', async () => {
  const { raw, db } = freshDb();
  seedProduct(raw);
  seedOption(raw, 'o1', { regular_adjust_iqd: 25_000, prime_price_iqd: 140_000 });
  // Base PRO 100,000 → carried 125,000 ≤ 140,000 today. At 130,000 it would
  // carry 155,000 and invert the untouched option.
  const res = await patch(adminApp(db), [{ level: 'product', id: '', field: 'pro', mode: 'fixed', value: '130000' }]);
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.ok(body.errors.some((e: string) => /^o1: the PRIME price this row resolves to \(140000\) is below the PRO price it resolves to \(155000\)/.test(e)), body.errors.join('\n'));
  assert.equal(raw.prepare('SELECT pro_price_iqd FROM products WHERE id = ?').get('p1')!.pro_price_iqd, 100_000, 'the base is untouched');
});

test('the base row itself is judged: PRO above PRIME on the product is refused', async () => {
  const { raw, db } = freshDb();
  seedProduct(raw);
  const res = await patch(adminApp(db), [{ level: 'product', id: '', field: 'pro', mode: 'fixed', value: '130000' }]);
  assert.equal(res.status, 400);
  assert.match((await json(res)).errors[0], /the PRO price must not be above the PRIME price/);
});

test('an option change re-checks the colours sold with it — and only those', async () => {
  const { raw, db } = freshDb();
  seedProduct(raw);
  seedOption(raw, 'o1', { regular_adjust_iqd: 25_000 });
  seedOption(raw, 'o2', { regular_adjust_iqd: 25_000 });
  seedColour(raw, 'c1', ['o1'], { regular_price_iqd: 130_000 }); // fine under o1 today
  seedColour(raw, 'c2', ['o2'], { regular_price_iqd: 130_000 });
  // Giving o1 its own PRO of 40,000 makes c1 swallow it; c2 is not sold with o1.
  const res = await patch(adminApp(db), [{ level: 'option', id: 'o1', field: 'pro', mode: 'fixed', value: '40000' }]);
  assert.equal(res.status, 400);
  const body = await json(res);
  assert.equal(body.errors.length, 1);
  assert.match(body.errors[0], /^c1: with option "o1"/);
  // The same PRO on o2 is refused because of c2, not c1.
  const other = await json(await patch(adminApp(db), [{ level: 'option', id: 'o2', field: 'pro', mode: 'fixed', value: '40000' }]));
  assert.match(other.errors[0], /^c2: with option "o2"/);
});

test('a legacy row that is already wrong elsewhere does not block an unrelated edit', async () => {
  const { raw, db } = freshDb();
  seedProduct(raw);
  seedOption(raw, 'o1', { regular_adjust_iqd: 25_000 });
  seedOption(raw, 'bad', { prime_price_iqd: 120_000, pro_price_iqd: 130_000 }); // inverted, written before the rule
  const res = await patch(adminApp(db), [{ level: 'option', id: 'o1', field: 'cost', mode: 'fixed', value: '90000' }]);
  assert.equal(res.status, 200, 'o1\'s ladder did not move; "bad" is not re-judged');
  // …but touching "bad" itself is.
  const touched = await patch(adminApp(db), [{ level: 'option', id: 'bad', field: 'cost', mode: 'fixed', value: '90000' }]);
  assert.equal(touched.status, 400);
});

// -------------------------------------------------------------- bulk/copy

test('a bulk apply that would invert a row is refused, and the preview already lists the errors', async () => {
  const { raw, db } = freshDb();
  seedProduct(raw);
  seedOption(raw, 'o1', { regular_adjust_iqd: 25_000 });
  seedOption(raw, 'o2', { regular_adjust_iqd: 25_000 });
  const app = adminApp(db);
  // Setting PRO to 160,000 on both options: above their carried PRIME 150,000.
  const req = { op: 'set', fields: ['pro'], value: '160000', scope: { levels: ['option'] } };
  const preview = await json(await send(app, 'POST', '/api/admin/products/p1/price-grid/bulk', req));
  assert.equal(preview.success, true);
  assert.equal(preview.preview.changes.length, 2, 'the preview still shows what the move would do');
  assert.deepEqual(
    preview.errors,
    [
      'o1: the PRIME price this row resolves to (150000) is below the PRO price it resolves to (160000) — PRO ≤ PRIME ≤ Regular',
      'o2: the PRIME price this row resolves to (150000) is below the PRO price it resolves to (160000) — PRO ≤ PRIME ≤ Regular',
    ]
  );
  const apply = await send(app, 'POST', '/api/admin/products/p1/price-grid/bulk', { ...req, apply: true });
  assert.equal(apply.status, 400);
  assert.equal((await json(apply)).code, 'VALIDATION');
  assert.equal(raw.prepare('SELECT pro_price_iqd FROM product_option_values WHERE id = ?').get('o1')!.pro_price_iqd, null);
  // A legal bulk goes through.
  const ok = await send(app, 'POST', '/api/admin/products/p1/price-grid/bulk', { ...req, value: '120000', apply: true });
  assert.equal(ok.status, 200);
  assert.equal(raw.prepare('SELECT pro_price_iqd FROM product_option_values WHERE id = ?').get('o1')!.pro_price_iqd, 120_000);
});

// ------------------------------------------- the shared fixture list, end to end

/** The JSON-column store, so a whole fixture is one INSERT. */
function seedJsonProduct(raw: DatabaseSync, p: PricingProduct) {
  raw.prepare(
    `INSERT INTO products (id,slug,name,name_ar,price_iqd,prime_price_iqd,pro_price_iqd,product_cost_iqd,images,options,colors)
       VALUES ('p1','p1','P','م',?,?,?,?,'[]',?,?)`
  ).run(p.price_iqd, p.prime_price_iqd, p.pro_price_iqd, p.product_cost_iqd, JSON.stringify(p.options), JSON.stringify(p.colors));
}

test('INVARIANT: the route accepts and refuses exactly the fixtures the four validators and the client mirror do', async () => {
  for (const f of LADDER_FIXTURES) {
    const { raw, db } = freshDb();
    seedJsonProduct(raw, f.product);
    // A cost on the base row touches the base, so every row is re-judged —
    // without moving any selling price.
    const res = await patch(adminApp(db), [{ level: 'product', id: '', field: 'cost', mode: 'fixed', value: '7' }]);
    const body = await json(res);
    if (f.verdict === 'accept') assert.equal(res.status, 200, `route refused "${f.name}": ${JSON.stringify(body.errors ?? body.error)}`);
    else {
      assert.equal(res.status, 400, `route accepted "${f.name}"`);
      assert.equal(body.code, 'VALIDATION');
      for (const n of f.names ?? []) assert.ok((body.errors as string[]).join('\n').includes(n), `route on "${f.name}" does not name "${n}": ${body.errors}`);
    }
  }
});
