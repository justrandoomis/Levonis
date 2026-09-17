/**
 * «خطأ في الخادم / حدث خطأ من جهتنا» ON THE CART SCREEN — THE STATE THAT
 * PRODUCES IT, AND THE LINE BETWEEN DEGRADING AND REFUSING.
 *
 * WHAT THE OWNER SAW. The cart page rendered
 * `src/components/ui/AsyncStates.tsx`'s `serverTitle` with a retry button,
 * while the orders, points and farm pages rendered normally on the same
 * account in the same session. So the worker was alive and the session was
 * valid, and something specific to `GET /api/cart` was throwing.
 *
 * WHAT IT WAS. A deployment that is one migration ahead of its database.
 * `GET /api/cart` is the only customer screen that both PRICES A MEMBERSHIP
 * (`membership_benefit_rules`, 0074) and READS A CART LINE (`cart_items`,
 * widened by 0002, 0023 and 0073), so it names schema no other screen on that
 * account touches. One `no such table` or `no such column` refuses the whole
 * statement, the route catches nothing, and `app.onError` turns it into the
 * 500 the customer reads.
 *
 * THE LINE THIS FILE PINS, which is the part that is easy to get wrong:
 *
 *   A MISSING OPTIONAL FEATURE DEGRADES. A table that does not exist holds no
 *   rows, and every reader involved already has a correct answer for "no
 *   rows" — no rule means the regular price, no window means the regular
 *   price, no pool means no product is a pool member. The cart prices with no
 *   membership benefit instead of refusing to load, and every figure it shows
 *   is right.
 *
 *   ANY OTHER FAILURE STILL 500s. A lock, a busy database, an I/O error: rows
 *   may exist and simply not have been read. Answering "no rows" there would
 *   charge a PRO member the regular price while their discount sat unread —
 *   a silent wrong price, which is worse than an error page.
 *
 * Nothing here is stubbed but the session: real migrations on real SQLite, the
 * real cart router, the real pricing, entitlement and benefit resolvers.
 *
 * Run: npx tsx --test tests/cartServerError.test.ts
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
import { cartRoutes } from '../worker/routes/cart';
import { isSchemaMissing, safeErrorCode } from '../worker/lib/membershipBenefits';
import { serverCause } from '../src/components/ui/AsyncStates';
import { ApiError } from '../src/lib/api';

// ------------------------------------------------------------------ fixture

const MIGRATIONS = join(ROOT, 'migrations');

/**
 * One PRO member with an approved default address (so the PRO purchase
 * context is live and a rule can actually reach the price), one ordinary
 * customer, one printer section and one product in it, one line in each cart.
 */
function seed(): DatabaseSync {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('plain','Sara','sara@x.co','h','customer'),
      ('promem','Omar','omar@x.co','h','customer');
    INSERT INTO addresses (id,user_id,label,name,phone,address,landmark,is_default) VALUES
      ('a_plain','plain','Home','Sara','+9647701234567','Baghdad, Karrada 12','',1),
      ('a_pro','promem','Home','Omar','+9647709876543','Erbil, Ankawa 4','',1);
    INSERT INTO approved_addresses (id,user_id,version,name,phone_e164,address,landmark,state)
      VALUES ('ap_pro','promem',1,'Omar','+9647709876543','Erbil, Ankawa 4','','approved');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,price_paid_iqd,starts_at,expires_at)
      VALUES ('m_pro','promem','pro_12mo','pro','active',12,499000,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
    INSERT INTO catalogs (id,parent_id,slug,name_ar,name_en,is_printer_catalog) VALUES
      ('cse_printers',NULL,'cse-printers','طابعات','Printers',1);
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,selling_type,sale_types,preorder_transports,images,category_id)
      VALUES ('p_printer','cse-a1','Bambu A1','بامبو A1',1000000,'active',20,'[]','[]','direct_sale','["direct_sale"]','[]','[]','cse_printers');
    INSERT INTO product_catalogs (product_id,catalog_id,position) VALUES ('p_printer','cse_printers',0);
    INSERT INTO cart_items (id,user_id,product_id,qty) VALUES
      ('ci_plain','plain','p_printer',1),
      ('ci_pro','promem','p_printer',1);
  `);
  return raw;
}

/** Whatever the owner's database is missing, expressed the way a database
 *  missing it actually looks: the objects are simply not there. */
function without(raw: DatabaseSync, opts: { tables?: string[]; columns?: Array<[string, string]> }): DatabaseSync {
  raw.exec('PRAGMA foreign_keys = OFF;');
  for (const t of opts.tables ?? []) raw.exec(`DROP TABLE IF EXISTS ${t};`);
  for (const [t, c] of opts.columns ?? []) {
    if (t === 'cart_items' && c === 'option_value_ids') {
      raw.exec('DROP INDEX IF EXISTS idx_cart_levonis_line_v2; DROP INDEX IF EXISTS idx_cart_levonis_line;');
    }
    raw.exec(`ALTER TABLE ${t} DROP COLUMN ${c};`);
  }
  raw.exec('PRAGMA foreign_keys = ON;');
  return raw;
}

/** Exactly what an unapplied 0074 leaves behind: neither table, and none of
 *  the columns it adds to `orders` / `order_items`. */
const NO_0074 = {
  tables: ['membership_benefit_rules', 'membership_benefit_versions'],
  columns: [
    ['orders', 'benefit_version_id'],
    ['orders', 'membership_discount_iqd'],
    ['orders', 'shipping_before_benefit_iqd'],
    ['orders', 'shipping_benefit_iqd'],
    ['orders', 'cod_tax_before_exemption_iqd'],
    ['orders', 'cod_tax_exemption_iqd'],
    ['orders', 'benefit_snapshot'],
    ['order_items', 'membership_discount_iqd'],
    ['order_items', 'membership_rule_id'],
  ] as Array<[string, string]>,
};

const ctx = { waitUntil: () => {}, passThroughOnException() {} } as unknown as ExecutionContext;

function appFor(db: D1Database, userId: string) {
  const app = new Hono<AppContext>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, role: 'customer', email: `${userId}@x.co`, username: userId, locale: 'ar' } as never);
    c.set('host', { kind: 'main' } as never);
    c.env = { DB: db } as never;
    await next();
  });
  app.route('/api/cart', cartRoutes);
  // The same two-branch shape as worker/index.ts: a refusal keeps its code, an
  // escaped throw becomes a coded 500 through `safeErrorCode`.
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ success: false, error: err.message, code: err.code }, err.status as 400);
    const code = safeErrorCode(err);
    return c.json({ success: false, error: 'Something went wrong. Please try again.', ...(code ? { code } : {}) }, 500);
  });
  return app;
}

interface CartBody {
  success?: boolean;
  code?: string;
  error?: string;
  items?: Array<Record<string, unknown>>;
  tier?: string;
  membership?: { tier: string; active: boolean; discount_total_iqd: number; order_discount_iqd: number } | null;
}

async function getCart(raw: DatabaseSync, userId: string, db?: D1Database) {
  const app = appFor(db ?? (new SqliteD1(raw) as unknown as D1Database), userId);
  const res = await app.request('/api/cart', { method: 'GET' }, undefined, ctx);
  return { status: res.status, body: (await res.json()) as CartBody };
}

// --------------------------------------------------- the reported defect

test('CONTROL: a fully migrated database renders the cart', async () => {
  const raw = seed();
  const { status, body } = await getCart(raw, 'plain');
  assert.equal(status, 200);
  assert.equal(body.items?.length, 1);
  assert.equal(body.items?.[0].unit_price_iqd, 1000000);
  raw.close();
});

test('0074 not applied: the cart RENDERS instead of answering 500', async () => {
  const raw = without(seed(), NO_0074);
  const { status, body } = await getCart(raw, 'plain');
  assert.equal(status, 200, 'the missing benefit-rule table must not take the cart screen down');
  assert.equal(body.items?.length, 1);
  // And it renders the REGULAR price, which with no rules configured is the
  // only price there is — nothing has been guessed.
  assert.equal(body.items?.[0].unit_price_iqd, 1000000);
  raw.close();
});

test('0074 not applied, PRO member: priced with no benefit, and honest about it', async () => {
  const raw = without(seed(), NO_0074);
  const { status, body } = await getCart(raw, 'promem');
  assert.equal(status, 200);
  assert.equal(body.tier, 'pro');
  assert.equal(body.items?.[0].unit_price_iqd, 1000000, 'no rule exists, so the regular price IS the member price');
  assert.equal(body.membership?.discount_total_iqd, 0);
  assert.equal(body.membership?.order_discount_iqd, 0);
  raw.close();
});

test('0074 APPLIED: the same PRO member gets the rule — the guard did not switch the feature off', async () => {
  const raw = seed();
  raw.exec(`
    INSERT INTO membership_benefit_rules (id,tier,benefit_type,scope,discount_mode,percent,enabled,priority,label)
    VALUES ('cse-pro-10','pro','product_discount','global','percent',10,1,0,'PRO 10%');
  `);
  const { status, body } = await getCart(raw, 'promem');
  assert.equal(status, 200);
  assert.equal(body.items?.[0].unit_price_iqd, 900000, 'a configured rule must still reach the price');
  assert.equal(body.membership?.discount_total_iqd, 100000);
  raw.close();
});

test('0060 not applied (special offers): the cart renders at the ladder price', async () => {
  const raw = without(seed(), { tables: ['offer_redemptions', 'offer_limits', 'offer_windows'] });
  const { status, body } = await getCart(raw, 'plain');
  assert.equal(status, 200);
  assert.equal(body.items?.[0].unit_price_iqd, 1000000);
  raw.close();
});

test('0061 not applied (mystery pools): the cart renders, and no stock is masked because no pool exists', async () => {
  const raw = without(seed(), { tables: ['mystery_pool_entries', 'mystery_offers', 'mystery_pools'] });
  const { status, body } = await getCart(raw, 'plain');
  assert.equal(status, 200);
  // Masking exists to hide a live pool's candidates. With no pool table there
  // is no pool, so the ordinary stock figure is the honest one.
  assert.equal(body.items?.[0].stock, 20);
  raw.close();
});

test('0073 not applied (cart_items.fulfillment_type): the line still loads, as a legacy line', async () => {
  const raw = without(seed(), { columns: [['cart_items', 'fulfillment_type']] });
  const { status, body } = await getCart(raw, 'plain');
  assert.equal(status, 200, 'a column no row has ever stored a value for must not take the screen down');
  assert.equal(body.items?.length, 1);
  assert.equal(body.items?.[0].unit_price_iqd, 1000000);
  raw.close();
});

test('0023 not applied (cart_items.option_value_ids): the line still loads', async () => {
  const raw = without(seed(), { columns: [['cart_items', 'option_value_ids']] });
  const { status, body } = await getCart(raw, 'plain');
  assert.equal(status, 200);
  assert.deepEqual(body.items?.[0].option_value_ids, []);
  raw.close();
});

// ------------------------------------------- the other side of the line

/** A database that answers one statement with a failure that is NOT "the
 *  table is not there" — a lock, which is the realistic one. */
class LockedOn extends SqliteD1 {
  constructor(
    raw: DatabaseSync,
    private readonly match: RegExp,
    private readonly failure: Error
  ) {
    super(raw);
  }
  prepare(sql: string): SqliteStatement {
    if (!this.match.test(sql)) return super.prepare(sql);
    const fail = () => Promise.reject(this.failure);
    return {
      bind: () => this.prepare(sql),
      run: fail,
      first: fail,
      all: fail,
    } as unknown as SqliteStatement;
  }
}

test('a LOCKED benefit-rule table still 500s — a discount that exists is never silently skipped', async () => {
  const raw = seed();
  raw.exec(`
    INSERT INTO membership_benefit_rules (id,tier,benefit_type,scope,discount_mode,percent,enabled,priority,label)
    VALUES ('cse-pro-10','pro','product_discount','global','percent',10,1,0,'PRO 10%');
  `);
  const db = new LockedOn(
    raw,
    /FROM membership_benefit_rules/,
    new Error('D1_ERROR: database is locked: SQLITE_BUSY')
  ) as unknown as D1Database;
  const { status, body } = await getCart(raw, 'promem', db);
  assert.equal(status, 500, 'rows that exist but could not be read must never be reported as "no rows"');
  assert.equal(body.code, 'SERVICE_BUSY');
  raw.close();
});

test('a REQUIRED table is not degraded: a cart with no products table refuses', async () => {
  const raw = without(seed(), { tables: ['cart_items'] });
  const { status, body } = await getCart(raw, 'plain');
  assert.equal(status, 500);
  assert.equal(body.code, 'SERVICE_SETUP');
  raw.close();
});

// --------------------------------------------- what the customer is told

test('isSchemaMissing recognises a missing table or column, and nothing else', () => {
  assert.equal(isSchemaMissing(new Error('D1_ERROR: no such table: membership_benefit_rules: SQLITE_ERROR')), true);
  assert.equal(isSchemaMissing(new Error('no such column: ci.fulfillment_type')), true);
  assert.equal(isSchemaMissing(new Error('D1_ERROR: database is locked: SQLITE_BUSY')), false);
  assert.equal(isSchemaMissing(new Error('database disk image is malformed')), false);
  assert.equal(isSchemaMissing(new Error('UNIQUE constraint failed: cart_items.id')), false);
  assert.equal(isSchemaMissing(new Error('boom')), false);
  // Workers wrap; the cause chain must be walked.
  assert.equal(isSchemaMissing(new Error('query failed', { cause: new Error('no such table: offer_windows') })), true);
});

test('safeErrorCode names only the two causes that are safe to name', () => {
  assert.equal(safeErrorCode(new Error('no such table: membership_benefit_rules')), 'SERVICE_SETUP');
  assert.equal(safeErrorCode(new Error('no such column: ci.fulfillment_type')), 'SERVICE_SETUP');
  assert.equal(safeErrorCode(new Error('D1_ERROR: database is locked: SQLITE_BUSY')), 'SERVICE_BUSY');
  assert.equal(safeErrorCode(new Error('SQLITE_LOCKED: database table is locked')), 'SERVICE_BUSY');
  assert.equal(safeErrorCode(new Error('Cannot read properties of undefined')), null);
});

test('the coded 500 leaks no table name, column name or SQL to the customer', async () => {
  const raw = without(seed(), NO_0074);
  raw.exec('PRAGMA foreign_keys = OFF; DROP TABLE admin_settings;');
  const { status, body } = await getCart(raw, 'plain');
  assert.equal(status, 500);
  const shown = `${body.error ?? ''} ${body.code ?? ''}`;
  for (const secret of ['admin_settings', 'membership_benefit_rules', 'SELECT', 'SQLITE', 'no such table']) {
    assert.equal(shown.includes(secret), false, `the refusal must not mention "${secret}"`);
  }
  raw.close();
});

test('the storefront turns that code into the sentence that fits it', () => {
  assert.equal(serverCause(new ApiError(500, 'Something went wrong. Please try again.', 'SERVICE_SETUP')), 'setup');
  assert.equal(serverCause(new ApiError(500, 'Something went wrong. Please try again.', 'SERVICE_BUSY')), 'busy');
  // An uncoded 500, or a code from a worker this build does not know, keeps
  // the generic server state it has always had.
  assert.equal(serverCause(new ApiError(500, 'Something went wrong.')), null);
  assert.equal(serverCause(new ApiError(500, 'x', 'SOMETHING_ELSE')), null);
  // And this is a 500 story only: a 4xx already shows the server's own words.
  assert.equal(serverCause(new ApiError(409, 'Cart conflict', 'SERVICE_BUSY')), null);
  assert.equal(serverCause(new Error('boom')), null);
});

test('the ckb strings for the new states are the ARABIC text, awaiting the owner', () => {
  const src = readFileSync(join(ROOT, 'src/components/ui/AsyncStates.tsx'), 'utf8');
  const block = (lang: string) => {
    const start = src.indexOf(`  ${lang}: {`);
    assert.ok(start >= 0, `${lang} block missing`);
    return src.slice(start, src.indexOf('\n  },', start));
  };
  const ar = block('ar');
  const ckb = block('ckb');
  for (const key of ['setupTitle', 'setupDesc', 'busyTitle', 'busyDesc']) {
    const line = (b: string) => {
      const m = new RegExp(`${key}: ('[^']*')`).exec(b);
      assert.ok(m, `${key} missing`);
      return m[1];
    };
    assert.equal(line(ckb), line(ar), `ckb.${key} must carry the Arabic text — Sorani is the owner's to write`);
  }
  assert.match(ckb, /owner writes these four by\n\s*\/\/ hand/);
});

// ============ THE DOORS THE CART FIX DID NOT REACH ON ITS OWN
//
// The cart learning to survive an uninstalled optional feature is only half a
// shop. A customer who reaches a cart that renders and then cannot pay is
// worse served than one refused at the door — and a cart holding a BUNDLE was
// still dying, because the composition SELECT joins `offer_windows` into the
// row itself. A LEFT JOIN to a table that does not exist is not a null; it is
// a hard error.

/** 0060 = offers; 0061 = mystery pools. Both optional, both joined or read on
 *  paths that have nothing to do with them. */
const NO_0060 = { tables: ['offer_windows', 'offer_limits', 'offer_redemptions'] };
const NO_0061 = { tables: ['mystery_pool_entries', 'mystery_pools', 'mystery_offers'] };

test('a cart holding a BUNDLE still loads when the offers table is not installed', async () => {
  const raw = seed();
  raw.exec(`
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,
                          selling_type,sale_types,preorder_transports,images,composition)
      VALUES ('p_kit','starter-kit','Starter Kit','حزمة',900000,'active',NULL,'[]','[]',
              'direct_sale','["direct_sale"]','[]','[]','bundle');
    INSERT INTO bundle_config (product_id,price_mode,min_price_iqd,max_qty_per_order)
      VALUES ('p_kit','fixed',1,5);
    INSERT INTO bundle_components (id,bundle_product_id,member_product_id,qty,optional,sort)
      VALUES ('bc1','p_kit','p_printer',1,0,0);
    INSERT INTO cart_items (id,user_id,product_id,qty) VALUES ('ci_kit','plain','p_kit',1);
  `);
  without(raw, NO_0060);

  const { status, body } = await getCart(raw, 'plain');
  assert.equal(status, 200, `a bundle line must not take the cart down: ${JSON.stringify(body)}`);
  assert.ok(
    (body.items ?? []).some((i) => String(i.productId ?? i.product_id) === 'p_kit'),
    'and the bundle must still BE in the cart — degrading it out of existence is not honest'
  );
});

test('the composition select drops only the offer join, and keeps every other column', async () => {
  // Proves the fallback is a narrowing, not a different query: the bundle's own
  // config still arrives, so it still prices. If the fallback had dropped more
  // than the join, max_qty_per_order would come back at its default.
  const { compositionSelect } = await import('../worker/lib/bundleRead');
  const raw = seed();
  raw.exec(`
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status,stock,options,colors,
                          selling_type,sale_types,preorder_transports,images,composition)
      VALUES ('p_kit','starter-kit','Starter Kit','حزمة',900000,'active',NULL,'[]','[]',
              'direct_sale','["direct_sale"]','[]','[]','bundle');
    INSERT INTO bundle_config (product_id,price_mode,min_price_iqd,max_qty_per_order)
      VALUES ('p_kit','fixed',1,7);
  `);
  without(raw, NO_0060);
  const db = new SqliteD1(raw) as unknown as D1Database;

  const rows = await compositionSelect(
    db,
    (cols, from) => `SELECT ${cols} ${from} WHERE p.id = ?`,
    ['p_kit']
  );
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].cfg_max_qty_per_order), 7, 'the config half of the row survived the fallback');
  assert.equal(rows[0].ofw_id ?? null, null, 'and there is simply no offer, which is the truth');
});

test('the CHECKOUT survives the same states the cart now survives', async () => {
  // The failure this closes: cart renders, customer presses pay, 500. Each of
  // the three optional features is dropped on its own and the checkout is
  // asked to price — the same question it answers before taking money.
  const { orderRoutes } = await import('../worker/routes/orders');
  for (const [label, missing] of [
    ['0074 membership benefits', NO_0074],
    ['0060 offers', NO_0060],
    ['0061 mystery pools', NO_0061],
  ] as const) {
    const raw = without(seed(), missing);
    const app = new Hono<AppContext>();
    app.use('*', async (c, next) => {
      c.set('user', { id: 'plain', role: 'customer', email: 'p@x.co', username: 'plain', locale: 'ar' } as never);
      c.set('host', { kind: 'main' } as never);
      c.env = { DB: new SqliteD1(raw) as unknown as D1Database } as never;
      await next();
    });
    app.route('/api/orders', orderRoutes);
    app.onError((err, c) => {
      if (err instanceof HttpError) return c.json({ success: false, error: err.message, code: err.code }, err.status as 400);
      return c.json({ success: false, error: String((err as Error)?.message ?? err) }, 500);
    });

    const res = await app.request(
      '/api/orders/quote',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ addressId: 'a_plain', deliveryMethodId: 'standard', paymentMethodId: 'cash' }) },
      undefined,
      ctx
    );
    // A 404 means this build has no quote route — then the check is vacuous and
    // must say so rather than passing quietly.
    assert.notEqual(res.status, 404, 'the quote route moved; this test needs updating, not deleting');
    assert.notEqual(
      res.status,
      500,
      `with ${label} missing the checkout answered 500: ${await res.text()}`
    );
  }
});
