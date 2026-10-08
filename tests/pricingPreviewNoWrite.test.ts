/**
 * «التسعير والشحن» P1 WRITES NOTHING (MVP plan §6 P1, hard rule).
 *
 * Every route of /api/admin/pricing is called — the overview on every page,
 * every product's detail, the what-if with valid and invalid bodies, an
 * unknown id and a bundle — as the owner and as every other admin, over a
 * database holding the 41-product census fixture, the costly product with its
 * lot and delivered order, a price-history row and the rate profiles. Then:
 *
 *   - every table but `rate_limits` is byte-identical to before, after every
 *     single call (prices, costs, statuses, price_history, orders, wallet,
 *     lots, the finance clock, the schema itself);
 *   - every statement the router prepared is a SELECT (or WITH … SELECT),
 *     except the rate limiter's own counter — `INSERT … ON CONFLICT DO UPDATE`
 *     on `rate_limits` and its occasional stale-window `DELETE` — which is the
 *     ONE write a request causes, the same one every cost router pays.
 *
 * Run: node --import tsx --test tests/pricingPreviewNoWrite.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { SqliteD1, SqliteStatement } from './fixtures/d1';
import { OWNER, stubApp, type StubUser } from './fixtures/app';
import { ROLES, call, seededCopy, type MatrixApp } from './fixtures/roleMatrix';
import { seedLegacyCatalogue, seedProfileRates } from './fixtures/legacyCatalogue';
import { adminPricingRoutes } from '../worker/routes/adminPricing';
import { noStoreUnlessSet } from '../worker/lib/edgePolicy';

/** The D1 adapter, recording every statement the code prepares. */
class RecordingD1 {
  readonly statements: string[] = [];
  constructor(private readonly inner: SqliteD1) {}
  prepare(sql: string): SqliteStatement {
    this.statements.push(sql);
    return this.inner.prepare(sql);
  }
  batch(statements: SqliteStatement[]) {
    for (const s of statements) this.statements.push(s.sql);
    return this.inner.batch(statements);
  }
}

function world() {
  const raw = seededCopy();
  seedLegacyCatalogue(raw);
  seedProfileRates(raw);
  raw.exec(`
    INSERT INTO price_history (product_id, variant_key, field, old_iqd, new_iqd, changed_by) VALUES ('lp_05', '', 'regular', 290000, 300000, 'usr_owner');
    INSERT INTO products (id, slug, name, status, price_iqd, composition) VALUES ('bdl_1', 'starter-bundle', 'Starter bundle', 'active', 900000, 'bundle');
    UPDATE products SET prime_price_iqd = 280000 WHERE id = 'lp_08';
  `);
  const d1 = new RecordingD1(new SqliteD1(raw));
  return { raw, d1 };
}

const appAs = (d1: RecordingD1, user: StubUser | null): MatrixApp =>
  stubApp(d1, user, (a) => {
    a.use('/api/admin/*', noStoreUnlessSet);
    a.route('/api/admin/pricing', adminPricingRoutes);
  });

/** Every table but the rate limiter's, row by row, plus the schema. */
function snapshot(raw: DatabaseSync): Map<string, string> {
  const out = new Map<string, string>();
  const tables = raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'rate_limits' ORDER BY name")
    .all() as Array<{ name: string }>;
  for (const { name } of tables) {
    const rows = (raw.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all() as object[]).map((r) => JSON.stringify(r)).sort();
    out.set(name, createHash('sha256').update(rows.join('\n')).digest('hex'));
  }
  const schema = (raw.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all() as object[]).map((r) => JSON.stringify(r));
  out.set('#schema', createHash('sha256').update(schema.join('\n')).digest('hex'));
  return out;
}

const changedTables = (a: Map<string, string>, b: Map<string, string>) => [...a.keys()].filter((k) => a.get(k) !== b.get(k));
const rateLimitCount = (raw: DatabaseSync) => (raw.prepare('SELECT COALESCE(SUM(count), 0) AS n FROM rate_limits').get() as { n: number }).n;

/** The calls, in order: every route, every page, valid and invalid bodies. */
function calls(ids: readonly string[]): Array<{ method: 'GET' | 'POST'; path: string; body?: unknown }> {
  const out: Array<{ method: 'GET' | 'POST'; path: string; body?: unknown }> = [];
  for (const page of ['1', '2', '3', '4', 'zz', '-1']) out.push({ method: 'GET', path: `/api/admin/pricing/overview?page=${page}` });
  for (const id of [...ids, 'bdl_1', 'zz-no-such-id']) out.push({ method: 'GET', path: `/api/admin/pricing/products/${id}` });
  const bodies: unknown[] = [
    { supplier_cost: '412.5', currency: 'EUR' },
    { supplier_cost: '3150', currency: 'CNY', additional_cost_iqd: 5000 },
    { supplier_cost: '99.99', currency: 'USD', rates: { fx: { USD: '1310.5' } } },
    { supplier_cost: '2.25', currency: 'CNY', measures: { weight_g: 1250, length_mm: 300, width_mm: 200, height_mm: 100, shipping_profile: 'CHINA_SEA' } },
    { supplier_cost: '10', currency: 'EUR', measures: { manual_cbm: '0.0125' }, rates: { shipping: { CHINA_SEA: '360000.5' } } },
    { supplier_cost: 412.5, currency: 'EUR' },
    { supplier_cost: '-1', currency: 'EUR' },
    { supplier_cost: '1.12345', currency: 'EUR' },
    { supplier_cost: '10', currency: 'GBP' },
    { supplier_cost: '10', currency: 'EUR', price_iqd: 1 },
    { supplier_cost: '10', currency: 'EUR', option_id: 'zz-no-such-option' },
  ];
  for (const id of [ids[0]!, ids[6]!, ids[15]!, ids[30]!, ids[33]!, 'p_a1']) {
    for (const body of bodies) out.push({ method: 'POST', path: `/api/admin/pricing/products/${id}/what-if`, body });
  }
  out.push({ method: 'POST', path: '/api/admin/pricing/products/lp_04/what-if', body: { supplier_cost: '640', currency: 'EUR', option_id: 'lp_04_o1' } });
  out.push({ method: 'POST', path: '/api/admin/pricing/products/zz-no-such-id/what-if', body: { supplier_cost: '10', currency: 'EUR' } });
  out.push({ method: 'POST', path: '/api/admin/pricing/products/bdl_1/what-if', body: { supplier_cost: '10', currency: 'EUR' } });
  return out;
}

const WRITE = /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|ATTACH|PRAGMA)\b/i;
const RATE_LIMIT = /^\s*(INSERT INTO rate_limits\b|DELETE FROM rate_limits\b)/i;

test('the owner, every route: no table but rate_limits changes after any call, and every statement but the limiter’s is a read', async () => {
  const { raw, d1 } = world();
  const app = appAs(d1, OWNER);
  const ids = (raw.prepare("SELECT id FROM products WHERE id LIKE 'lp_%' ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);
  assert.equal(ids.length, 41);
  const before = snapshot(raw);
  const limiterBefore = rateLimitCount(raw);
  const statuses: Record<string, number> = {};
  let answered = 0;
  for (const c of calls(ids)) {
    const res = await call(app, c.method, c.path, c.body);
    statuses[`${c.method} ${c.path} ${JSON.stringify(c.body ?? null)}`] = res.status;
    if (res.status === 200) answered += 1;
    assert.ok(res.status < 500, `${c.method} ${c.path}: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
    assert.deepEqual(changedTables(before, snapshot(raw)), [], `${c.method} ${c.path} changed a table`);
  }
  // The calls really ran: answers, refusals, a 404 and the bundle's 409 among them.
  assert.ok(answered >= 41 + 4 + 30, `only ${answered} answered`);
  const codes = new Set(Object.values(statuses));
  for (const s of [200, 400, 404, 409]) assert.ok(codes.has(s), `no ${s} among the answers`);
  // The one write: the limiter's counter moved, once per request.
  assert.ok(rateLimitCount(raw) > limiterBefore, 'the rate limiter counted the requests');

  const writes = d1.statements.filter((sql) => WRITE.test(sql) && !RATE_LIMIT.test(sql));
  assert.deepEqual(writes, [], 'a statement other than the rate limiter writes');
  const reads = d1.statements.filter((sql) => !RATE_LIMIT.test(sql));
  for (const sql of reads) assert.match(sql, /^\s*(SELECT|WITH)\b/i, sql.slice(0, 120));
  assert.ok(reads.length > 100, `only ${reads.length} reads recorded — the recorder is not wired`);
});

test('every other admin and every other caller: refused, and still nothing but the limiter writes', async () => {
  const { raw, d1 } = world();
  const ids = (raw.prepare("SELECT id FROM products WHERE id LIKE 'lp_%' ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);
  const before = snapshot(raw);
  for (const role of ['assistant', 'full', 'legacy_null', 'grantee_off', 'support_assistant', 'customer', 'merchant', 'guest'] as const) {
    const app = appAs(d1, ROLES[role]);
    for (const c of calls(ids).filter((_, i) => i % 9 === 0)) {
      const res = await call(app, c.method, c.path, c.body);
      assert.ok(res.status === 401 || res.status === 403, `${role} ${c.method} ${c.path}: ${res.status}`);
    }
  }
  assert.deepEqual(changedTables(before, snapshot(raw)), []);
  const writes = d1.statements.filter((sql) => WRITE.test(sql) && !RATE_LIMIT.test(sql));
  assert.deepEqual(writes, []);
  // A refused caller never reaches a product read: only the limiter and the session-free door ran.
  assert.deepEqual(d1.statements.filter((sql) => /FROM products\b/i.test(sql)), []);
});
