/**
 * THE LISTING STAYS INSIDE D1'S LIMITS (catalog discovery S1).
 *
 * The live D1 refuses a statement with more than 100 bound parameters, and the
 * local engine allows 32,766 — so the budget is asserted by COUNTING what the
 * route binds. Three brands and five facets bind fewer than 20 on every
 * statement, because a list is one json_each parameter and spec facets are
 * applied in memory. And a section with more candidates than the cap says so.
 *
 * Run: node --import tsx --test tests/listingParamBudget.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, stubApp } from './fixtures/app';
import { seedLiveCatalog } from './fixtures/liveCatalog';
import { LISTING_CANDIDATE_CAP, productRoutes } from '../worker/routes/products';

/** A D1 whose every bound statement reports its parameter count. */
function counting(db: D1Database) {
  const binds: Array<{ sql: string; n: number }> = [];
  const wrap = (st: D1PreparedStatement, sql: string): D1PreparedStatement =>
    new Proxy(st, {
      get(target, prop, recv) {
        if (prop === 'bind') {
          return (...args: unknown[]) => {
            binds.push({ sql, n: args.length });
            return wrap(target.bind(...args), sql);
          };
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  const proxy = new Proxy(db, {
    get(target, prop, recv) {
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql);
      const v = Reflect.get(target, prop, recv);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { db: proxy, binds };
}

test('three brands and five facets bind fewer than 20 parameters on every statement', async () => {
  const raw = freshDb();
  seedLiveCatalog(raw);
  const { db, binds } = counting(asD1(raw));
  const app = stubApp(db, null, (a) => a.route('/api/products', productRoutes));
  const url =
    '/api/products?category=cat_printers&search=bambu&brand=bambu-lab,snapmaker,levo' +
    '&f.max_colors=16-20,24-&f.enclosed=1&f.skill_level=beginner,professional&f.build_volume=standard,large&f.technology=fdm' +
    '&avail=1&sale=direct&price=500000-2500000&sort=price_asc';
  for (const extra of ['', '&facets=1']) {
    binds.length = 0;
    const res = await get(app, url + extra);
    assert.equal(res.status, 200);
    const max = Math.max(...binds.map((b) => b.n));
    assert.ok(binds.length > 0);
    assert.ok(max < 20, `largest bind was ${max}: ${binds.find((b) => b.n === max)?.sql.slice(0, 120)}`);
  }
});

test('above the candidate cap the listing says truncated:true, and pages inside the cap', async () => {
  const raw = freshDb();
  const ins = raw.prepare(
    "INSERT INTO products (id, slug, name, description, price_iqd, status, category_id, sub_category_id, stock, display_order) VALUES (?, ?, ?, '', ?, 'active', 'cat_makers', 'cat_makers_tools', 1, ?)"
  );
  for (let i = 0; i < LISTING_CANDIDATE_CAP + 5; i++) ins.run(`p${i}`, `tool-${i}`, `Tool ${i}`, 1000 + i, i);
  const app = stubApp(asD1(raw), null, (a) => a.route('/api/products', productRoutes));
  const b = await json(await get(app, '/api/products?category=cat_makers&sort=price_desc&limit=5'));
  assert.equal(b.truncated, true);
  assert.equal(b.total, LISTING_CANDIDATE_CAP);
  assert.equal(b.products.length, 5);
  const small = await json(await get(app, '/api/products?category=cat_makers_tools&avail=1&limit=5&search=nothing-matches-this'));
  assert.equal(small.truncated ?? false, false);
  // The plain listing is not capped and not annotated.
  const plain = await json(await get(app, '/api/products?category=cat_makers&limit=5&offset=300'));
  assert.equal(plain.products.length, 5);
  assert.equal('truncated' in plain, false);
});
