/**
 * THE NIGHT THE FIRST SCREEN WENT DARK.
 *
 * A Worker carrying migration 0085's `products.condition_doc` reached
 * production over a database still at 0083. `/api/home` answered HTTP 500
 * `SERVICE_SETUP` — «جزء من المتجر قيد التجهيز» — and the storefront's entire
 * first screen was an error card. Not the graded shelf: the WHOLE page,
 * including the products, the categories and the brands, none of which had
 * anything to do with the missing column.
 *
 * Two separate faults, and this file pins both:
 *
 *   THE AMPLIFIER. `/api/home` gathers its strips with `Promise.all`, so the
 *   first rejection discards six good results. One optional shelf took the
 *   page with it.
 *
 *   THE UNNECESSARY FAULT. `condition_doc` is declared
 *   `NOT NULL DEFAULT '{}'`, and `'{}'` means "not graded". So on a database
 *   without the column, EVERY row would carry a value that puts it outside
 *   the shelf — the honest answer is an empty shelf, and there was never
 *   anything to fail about.
 *
 * WHY THIS IS A SUBSTITUTION AND NOT A DEGRADE, which matters because
 * `worker/lib/membershipBenefits.ts` forbids degrading on a missing COLUMN in
 * so many words: degrading answers "no rows" for a table that may be full,
 * and the module's example is a PRO member with three live discount rules
 * being told they have none and charged the regular price at HTTP 200. Here
 * the answer is not invented — it is the value the column's own migration
 * declares every row would hold. The same reasoning `cartLineProjection.ts`
 * is built on, and the negative tests below are what keep the two apart: a
 * missing TABLE, and any OTHER missing column, must still fail loudly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APEX, asD1, ctx, dbThrough, freshDb, hasColumn, json, stubApp } from './fixtures/app';
import { homeRoutes } from '../worker/routes/products';

/** The live database on the night of the outage: everything through 0083. */
const BEFORE_CONDITION = '0083';

const app = (db: unknown) =>
  stubApp(db as never, null, (a) => a.route('/api/home', homeRoutes), {
    host: APEX,
    env: { DB: db, INITIAL_ADMIN_EMAIL: 'boss@x.co', EXTRA_ALLOWED_ORIGINS: '' },
  });

const home = (a: ReturnType<typeof app>) =>
  a.request('/api/home', { headers: { 'CF-Connecting-IP': '1.2.3.4' } }, undefined, ctx);

function seedProduct(raw: ReturnType<typeof freshDb>, id: string, name: string) {
  raw.prepare(
    `INSERT INTO products (id, slug, name, description, price_iqd, status)
     VALUES (?, ?, ?, '', 100000, 'active')`
  ).run(id, id, name);
}

// =========================================================================
// THE OUTAGE
// =========================================================================

test('the fixture really is one migration behind — otherwise this whole file proves nothing', () => {
  const behind = dbThrough(BEFORE_CONDITION);
  const current = freshDb();
  assert.equal(hasColumn(behind, 'products', 'condition_doc'), false, 'the column must be absent');
  assert.equal(hasColumn(current, 'products', 'condition_doc'), true, 'and present once migrated');
});

test('HOME SURVIVES a database that has not had migration 0085 applied', async () => {
  const raw = dbThrough(BEFORE_CONDITION);
  seedProduct(raw, 'prd_1', 'Snapmaker U1');

  const res = await home(app(asD1(raw)));
  assert.equal(res.status, 200, 'the first screen must not be an error card because one shelf is unreadable');

  const b = await json(res);
  assert.equal(b.success, true);
  // The strips that had nothing to do with the missing column still answer.
  assert.equal(Array.isArray(b.latest), true);
  assert.equal(b.latest.length, 1, 'the products are still there');
  assert.equal(Array.isArray(b.categories), true);
  assert.equal(Array.isArray(b.brands), true);
  assert.ok(b.settings, 'and so are the settings the page is laid out from');
  // The graded shelf is EMPTY, which is the literal truth: with the column at
  // its declared default every row is ungraded.
  assert.deepEqual(b.open_box, [], 'an unreadable shelf is an empty shelf, not a dark page');
});

test('HOME on a fully migrated database is unchanged — the repair costs the fast path nothing', async () => {
  const raw = freshDb();
  seedProduct(raw, 'prd_new', 'New printer');
  seedProduct(raw, 'prd_used', 'Open box printer');
  raw.prepare("UPDATE products SET condition_doc = ? WHERE id = 'prd_used'").run(
    JSON.stringify({ kind: 'open_box', grade: 'like_new', warranty_months: 12 })
  );

  const b = await json(await home(app(asD1(raw))));
  assert.equal(b.success, true);
  assert.equal(b.open_box.length, 1, 'the graded shelf works exactly as before');
  assert.equal(b.open_box[0].id, 'prd_used');
  assert.equal(b.latest.length, 2);
});

// =========================================================================
// THE NEGATIVES — what must STILL fail loudly
// =========================================================================

test('a missing PRODUCTS TABLE is never hidden: the page fails rather than pretending the shop is empty', async () => {
  // The repair must key on "this one column is absent", not on "the statement
  // mentioned schema". A shop whose products table is gone has a problem no
  // empty shelf may paper over.
  const raw = dbThrough(BEFORE_CONDITION);
  raw.exec('PRAGMA foreign_keys = OFF; DROP TABLE products;');

  const res = await home(app(asD1(raw)));
  assert.equal(res.status, 500, 'a missing table is an outage and must read as one');
});

test('a DIFFERENT missing column still fails loudly — the repair is not a blanket catch', async () => {
  // The doctrine in worker/lib/membershipBenefits.ts: a missing column means
  // the table is there and MAY BE FULL, so answering "no rows" can hide real
  // data — a PRO member's live discount rules, a price. Only `condition_doc`
  // is repaired here, and only because its declared DEFAULT makes the empty
  // answer exact.
  const raw = dbThrough(BEFORE_CONDITION);
  /**
   * Rebuild products WITH condition_doc but WITHOUT a column another strip
   * names. The shelf is now readable; that other strip is not.
   *
   * The column used to be `original_price_iqd`, which is what the discounts
   * strip selected on — until that strip was found to be selecting on a
   * RETIRED concept and always returning nothing. It now reads the membership
   * prices, the same predicate `/api/products?type=discounted` uses, so
   * `pro_price_iqd` is the column the handler really depends on and therefore
   * the one this test has to remove to mean anything.
   */
  const MISSING = 'pro_price_iqd';
  const cols = (raw.prepare('PRAGMA table_info(products)').all() as { name: string }[]).map((r) => r.name);
  assert.ok(cols.includes(MISSING), 'the column this test removes must exist first');
  const kept = cols.filter((c) => c !== MISSING);
  raw.exec('PRAGMA foreign_keys = OFF;');
  raw.exec(`CREATE TABLE products_x AS SELECT ${kept.join(', ')} FROM products;`);
  raw.exec('DROP TABLE products; ALTER TABLE products_x RENAME TO products;');
  raw.exec("ALTER TABLE products ADD COLUMN condition_doc TEXT NOT NULL DEFAULT '{}';");
  assert.equal(hasColumn(raw, 'products', 'condition_doc'), true);
  assert.equal(hasColumn(raw, 'products', MISSING), false);

  const res = await home(app(asD1(raw)));
  assert.equal(res.status, 500, 'an unreadable column that is NOT the shelf must still stop the page');
});

// =========================================================================
// THE OTHER ROUTE THE SAME COLUMN TOOK DOWN
// =========================================================================

/**
 * `/api/returns` names `p.condition_doc` to decide whether a unit is an
 * open-box one that cannot be returned for change of mind. On a database
 * without the column that read refused too — so a customer whose printer
 * arrived faulty could not open a claim at all, which is the one thing a
 * returns route exists to let them do.
 *
 * The substituted default `'{}'` is read as "not graded", so the refusal
 * simply does not apply: exactly the behaviour this route had before open-box
 * existed, which is the correct behaviour on a database where open-box cannot
 * exist yet.
 */
function seedDeliveredOrder(raw: ReturnType<typeof freshDb>) {
  const now = new Date().toISOString();
  raw.prepare(
    `INSERT INTO users (id, name, email, username, password_hash, role)
     VALUES ('buyer','Buyer','buyer@example.com','buyer','h','customer')`
  ).run();
  seedProduct(raw, 'prd_printer', 'A printer');
  raw.prepare(
    `INSERT INTO orders (id, user_id, address_snapshot, delivery_method_id, delivery_method_snapshot,
       payment_method_id, subtotal_iqd, exchange_rate, total_iqd, due_on_delivery_iqd, status, delivered_at)
     VALUES ('ORD-R','buyer','{}','dm','{}','cod',100000,1400,100000,0,'delivered', ?)`
  ).run(now);
  raw.prepare(
    `INSERT INTO order_items (id, order_id, product_id, name_snapshot, qty, unit_price_iqd, line_total_iqd)
     VALUES ('oi_1','ORD-R','prd_printer','A printer',1,100000,100000)`
  ).run();
}

test('RETURNS survive the same unapplied migration — a faulty unit can still be claimed', async () => {
  const { returnRoutes } = await import('../worker/routes/returns');
  const raw = dbThrough(BEFORE_CONDITION);
  seedDeliveredOrder(raw);
  const db = asD1(raw);

  const a = stubApp(db, { id: 'buyer', role: 'customer', email: 'buyer@example.com' }, (x) =>
    x.route('/api/returns', returnRoutes), { host: APEX, env: { DB: db, INITIAL_ADMIN_EMAIL: 'b@x.co', EXTRA_ALLOWED_ORIGINS: '' } });

  const res = await a.request('/api/returns', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify({ orderItemId: 'oi_1', qty: 1, reason: 'defective' }),
  }, undefined, ctx);

  const body = await json(res);
  assert.notEqual(res.status, 500, `a missing column must not 500 the returns route: ${JSON.stringify(body)}`);
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
});

// =========================================================================
// THE DEFECT THE OUTAGE UNCOVERED — a grade that was never written at all
// =========================================================================

/**
 * `serializeDoc` has emitted `condition_doc` since the feature was built, but
 * both writers bind only the names in `PRODUCT_COLUMNS`
 * (`PRODUCT_COLUMNS.map((k) => record[k] ?? null)`, productPersistence.ts),
 * and that list did not carry it. So an owner marking a printer «مستعمل»
 * saved at HTTP 200, saw no error, and stored an ordinary new product — the
 * grade was produced, carried to the statement, and dropped on the floor.
 *
 * Every OTHER test of this feature passed while that was true, because they
 * all seeded `condition_doc` with raw SQL rather than saving a product the
 * way the admin panel does. The whole feature — the shelf, the price
 * comparison, the return refusal, the warranty rule — could never have fired
 * in production. THIS is the test that was missing: it goes through the door
 * the owner goes through.
 */
test('SAVING a graded product through the admin route actually stores the grade', async () => {
  const { adminProductsRoutes } = await import('../worker/routes/adminProducts');
  const raw = freshDb();
  raw.exec("INSERT INTO users (id,name,email,password_hash,role) VALUES ('adm','Admin','a@x.co','h','admin')");
  const db = asD1(raw);
  // products-v2 — the door the admin FORM posts to (worker/index.ts:217),
  // which is the one that goes through serializeDoc and PRODUCT_COLUMNS.
  const a = stubApp(db, { id: 'adm', role: 'admin', email: 'a@x.co', admin_scope: 'full' }, (x) =>
    x.route('/api/admin/products-v2', adminProductsRoutes), { host: APEX, env: { DB: db, INITIAL_ADMIN_EMAIL: 'a@x.co', EXTRA_ALLOWED_ORIGINS: '' } });

  const condition = {
    kind: 'open_box',
    grade: 'like_new',
    usage_hours: 100,
    warranty_months: 12,
    notes_ar: 'الصندوق مفتوح فقط',
  };
  const res = await a.request('/api/admin/products-v2', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify({
      slug: 'used-x2d',
      name_en: 'X2D Combo (open box)',
      name_ar: 'X2D كومبو (علبة مفتوحة)',
      price_iqd: 1_200_000,
      condition,
    }),
  }, undefined, ctx);

  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));

  const id = String((body.product as { id?: unknown } | undefined)?.id ?? body.id ?? '');
  assert.ok(id, `the route must say what it saved: ${JSON.stringify(body).slice(0, 300)}`);
  const stored = raw.prepare('SELECT condition_doc FROM products WHERE id = ?').get(id) as
    | { condition_doc: string }
    | undefined;
  assert.ok(stored, 'the product was saved');
  assert.notEqual(
    stored!.condition_doc,
    '{}',
    'the grade the owner chose must survive the save — this is the whole feature'
  );
  const back = JSON.parse(stored!.condition_doc) as Record<string, unknown>;
  assert.equal(back.kind, 'open_box');
  assert.equal(back.grade, 'like_new');
  assert.equal(back.usage_hours, 100);
  assert.equal(back.warranty_months, 12);
});

test('and an ordinary product still stores the column\'s declared default, never NULL', async () => {
  // `condition_doc` is NOT NULL. Adding it to PRODUCT_COLUMNS would break
  // every ordinary save if `serializeConditionDoc(null)` did not already
  // answer '{}'.
  const { adminProductsRoutes } = await import('../worker/routes/adminProducts');
  const raw = freshDb();
  raw.exec("INSERT INTO users (id,name,email,password_hash,role) VALUES ('adm','Admin','a@x.co','h','admin')");
  const db = asD1(raw);
  // products-v2 — the door the admin FORM posts to (worker/index.ts:217),
  // which is the one that goes through serializeDoc and PRODUCT_COLUMNS.
  const a = stubApp(db, { id: 'adm', role: 'admin', email: 'a@x.co', admin_scope: 'full' }, (x) =>
    x.route('/api/admin/products-v2', adminProductsRoutes), { host: APEX, env: { DB: db, INITIAL_ADMIN_EMAIL: 'a@x.co', EXTRA_ALLOWED_ORIGINS: '' } });

  const res = await a.request('/api/admin/products-v2', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify({ slug: 'plain-filament', name_en: 'PLA Basic', name_ar: 'PLA أساسي', price_iqd: 25_000 }),
  }, undefined, ctx);
  const body = await json(res);
  assert.equal(res.status, 200, JSON.stringify(body));
  const id = String((body.product as { id?: unknown } | undefined)?.id ?? body.id ?? '');
  const stored = raw.prepare('SELECT condition_doc FROM products WHERE id = ?').get(id) as { condition_doc: string };
  assert.equal(stored.condition_doc, '{}', 'a new product is ungraded, and that is a value rather than a NULL');
});

/**
 * THE TRAP THE FIRST FIX NEARLY SET.
 *
 * Adding `condition_doc` to `PRODUCT_COLUMNS` is what makes the grade survive
 * a save — and it also makes every save NAME that column. On a database one
 * migration behind, that turns `has no column named condition_doc` into the
 * answer for a price correction, a stock fix, a status change: the whole admin
 * product form, dead, in exchange for a graded shelf that could not work on
 * that database anyway.
 *
 * A shop that cannot change its own prices is worse than a shop with an empty
 * shelf. The write drops the column when the table does not have it, and the
 * row takes the `'{}'` its migration declares — the only thing a product on a
 * pre-0085 database can be.
 */
test('AN ORDINARY PRODUCT SAVE still works on a database without condition_doc', async () => {
  const { adminProductsRoutes } = await import('../worker/routes/adminProducts');
  const raw = dbThrough(BEFORE_CONDITION);
  assert.equal(hasColumn(raw, 'products', 'condition_doc'), false);
  raw.exec("INSERT INTO users (id,name,email,password_hash,role) VALUES ('adm','Admin','a@x.co','h','admin')");
  const db = asD1(raw);
  const a = stubApp(db, { id: 'adm', role: 'admin', email: 'a@x.co', admin_scope: 'full' }, (x) =>
    x.route('/api/admin/products-v2', adminProductsRoutes), { host: APEX, env: { DB: db, INITIAL_ADMIN_EMAIL: 'a@x.co', EXTRA_ALLOWED_ORIGINS: '' } });

  const create = await a.request('/api/admin/products-v2', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify({ slug: 'pla-basic', name_en: 'PLA Basic', name_ar: 'PLA أساسي', price_iqd: 25_000 }),
  }, undefined, ctx);
  const body = await json(create);
  assert.equal(create.status, 200, `the owner must still be able to file a product: ${JSON.stringify(body)}`);

  const id = String((body.product as { id?: unknown } | undefined)?.id ?? body.id ?? '');
  assert.ok(id);
  const stored = raw.prepare('SELECT price_iqd FROM products WHERE id = ?').get(id) as { price_iqd: number };
  assert.equal(stored.price_iqd, 25_000, 'and the row is really there');
});

// =========================================================================
// A MISSING TABLE IS THE OTHER HALF OF THE DOCTRINE
// =========================================================================

/**
 * `auth_otp` arrives with migration 0087. A missing TABLE holds no rows, so
 * "this sign-in method is not available" is the literal truth — that is the
 * DEGRADABLE half of worker/lib/membershipBenefits.ts, as opposed to the
 * missing-column half, which must fail loudly because the table may be full.
 *
 * The customer gets 503 OTP_NOT_AVAILABLE and can use another method, rather
 * than a generic 500 that says the shop is broken.
 */
test('SIGN-IN CODES report themselves unavailable when their table is not installed', async () => {
  const { authRoutes } = await import('../worker/routes/auth');
  const raw = dbThrough('0086'); // everything except auth_otp
  assert.equal(
    (raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='auth_otp'").get() as unknown) ?? null,
    null,
    'the table must be absent for this test to mean anything'
  );
  raw.prepare(
    `INSERT INTO users (id,name,email,username,password_hash,role,email_verified_at)
     VALUES ('u1','C','c@example.com','c','h','customer', ?)`
  ).run(new Date().toISOString());

  const db = asD1(raw);
  const a = stubApp(db, null, (x) => x.route('/api/auth', authRoutes), {
    host: APEX,
    env: {
      DB: db,
      EMAIL_API_KEY: 're_k',
      EMAIL_FROM: 'LEVONIS <no-reply@levonis-iq.com>',
      INITIAL_ADMIN_EMAIL: 'b@x.co',
      EXTRA_ALLOWED_ORIGINS: '',
    },
  });

  const start = await a.request('/api/auth/otp/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '10.5.5.5' },
    body: JSON.stringify({ channel: 'email', identifier: 'c@example.com' }),
  }, undefined, ctx);
  const sb = await json(start);
  assert.equal(start.status, 503, `not 500: ${JSON.stringify(sb)}`);
  assert.equal(sb.code, 'OTP_NOT_AVAILABLE');

  const verify = await a.request('/api/auth/otp/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '10.5.5.6' },
    body: JSON.stringify({ channel: 'email', identifier: 'c@example.com', code: '123456' }),
  }, undefined, ctx);
  assert.equal(verify.status, 503);
  assert.equal((await json(verify)).code, 'OTP_NOT_AVAILABLE');
});

/**
 * `search_tokens` arrives with migration 0089, and the product write path feeds
 * it in the SAME batch as the product row — which is the right thing for an
 * index that must never disagree with the catalogue, and exactly the thing that
 * kills the save when the table is one deploy behind the code.
 *
 * This shop has two deploy paths and only one of them applies migrations, so
 * that window is not hypothetical. The save drops the index rows and lands; the
 * backfill cron indexes the product as soon as the table exists. An owner who
 * cannot correct a price because of a search index they never asked about is
 * the failure this whole file is about.
 */
test('A PRODUCT SAVE still works on a database without the search index', async () => {
  const { adminProductsRoutes } = await import('../worker/routes/adminProducts');
  const raw = dbThrough('0088'); // everything except search_tokens
  assert.equal(
    (raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='search_tokens'").get() as unknown) ?? null,
    null,
    'the table must be absent for this test to mean anything'
  );
  raw.exec("INSERT INTO users (id,name,email,password_hash,role) VALUES ('adm','Admin','a@x.co','h','admin')");
  const db = asD1(raw);
  const a = stubApp(db, { id: 'adm', role: 'admin', email: 'a@x.co', admin_scope: 'full' }, (x) =>
    x.route('/api/admin/products-v2', adminProductsRoutes), { host: APEX, env: { DB: db, INITIAL_ADMIN_EMAIL: 'a@x.co', EXTRA_ALLOWED_ORIGINS: '' } });

  const create = await a.request('/api/admin/products-v2', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.9' },
    body: JSON.stringify({ slug: 'x2d-combo', name_en: 'Bambu Lab X2D Combo', name_ar: 'بامبو لاب X2D كومبو', price_iqd: 2_400_000 }),
  }, undefined, ctx);
  const body = await json(create);
  assert.equal(create.status, 200, `the save must survive a missing index: ${JSON.stringify(body)}`);

  const id = String((body.product as { id?: unknown } | undefined)?.id ?? body.id ?? '');
  assert.ok(id, 'and the product is really filed');

  // And the storefront still finds it, through the substring scan the index
  // was going to replace — a shop is not searchless for the length of a deploy.
  const { productRoutes } = await import('../worker/routes/products');
  const pub = stubApp(db, null, (x) => x.route('/api/products', productRoutes), { host: APEX, env: { DB: db, INITIAL_ADMIN_EMAIL: 'a@x.co', EXTRA_ALLOWED_ORIGINS: '' } });
  const found = await pub.request('/api/products?search=Bambu', undefined, undefined, ctx);
  const fb = await json(found);
  assert.equal(found.status, 200, JSON.stringify(fb));
  assert.deepEqual(
    (fb.products as Array<{ id: string }>).map((p) => p.id),
    [id],
    'the LIKE fallback answers while the index does not exist'
  );
});
