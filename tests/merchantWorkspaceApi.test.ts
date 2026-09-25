/**
 * THE WORKSPACE'S TWO READS (W3-A) — GET /api/merchant/attention and
 * GET /api/merchant/search (worker/routes/merchantWorkspace.ts).
 *
 * What is pinned: owner isolation (merchant A never counts or finds B's rows,
 * whatever host the request arrives on), absent-not-zero (a source that
 * cannot answer leaves its field out), every deep link is a real workspace
 * address, the search's caps, codes and bound-parameter count.
 *
 * Run: node --import tsx --test tests/merchantWorkspaceApi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { asD1, get, json } from './fixtures/app';
import { OWNER, OWNER2, BUYER, addOrder, appOf, seedW2E } from './fixtures/merchantW2E';
import { merchantAttentionRoutes, merchantSearchRoutes, phoneDigits, SEARCH_LIMIT } from '../worker/routes/merchantWorkspace';
import { parseMerchantPath, readWorkspaceQuery } from '../packages/contracts/src/merchantRoutes';

const mount = (a: Parameters<Parameters<typeof appOf>[2]>[0]) => {
  a.route('/api/merchant/attention', merchantAttentionRoutes);
  a.route('/api/merchant/search', merchantSearchRoutes);
};

const soon = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

/** Two stores with parallel data, so every count below has a twin that must not leak in. */
function world(): DatabaseSync {
  const raw = seedW2E();
  raw.exec(`
    UPDATE users SET phone_e164 = '+9647701112233' WHERE id = 'buyer';
    UPDATE users SET phone_e164 = '+9647809998877' WHERE id = 'buyer2';
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
    UPDATE community_products SET publish_state = 'published' WHERE id IN ('cp1','cp2','cp9');
    UPDATE community_products SET publish_state = 'draft' WHERE id = 'cp3';
    UPDATE community_products SET stock = 2, low_stock_threshold = 3 WHERE id = 'cp1';
    UPDATE community_products SET stock = 0 WHERE id = 'cp2';
    UPDATE community_products SET stock = 1, low_stock_threshold = 3 WHERE id = 'cp9';
    UPDATE community_products SET stock = 0 WHERE id = 'cp3';
    UPDATE community_products SET sku = 'VASE-RED' WHERE id = 'cp1';
    UPDATE community_products SET name_ar = 'مصباح' WHERE id = 'cp2';
    INSERT INTO community_requests (id,customer_id,title,description,state,status,visibility,offer_count,expires_at) VALUES
      ('r1','buyer','Bracket','Print a bracket','receiving_offers','open','public',0,'2099-01-01T00:00:00.000Z'),
      ('r2','buyer','Hinge','Print a hinge','receiving_offers','open','public',1,'2099-01-01T00:00:00.000Z'),
      ('r3','buyer','Gear','Closed one','closed','closed','public',0,'2099-01-01T00:00:00.000Z');
    -- Verdicts for each request's current revision (1): since W5-B an older revision's verdict counts for nothing.
    INSERT INTO community_request_matches (id,request_id,merchant_id,eligible,revision) VALUES
      ('mt1','r1','m1',1,1), ('mt2','r2','m1',1,1), ('mt3','r3','m1',1,1), ('mt4','r1','m2',1,1), ('mt5','r2','m2',0,1);
    INSERT INTO community_offers (id,request_id,merchant_id,store_id,price_iqd,state) VALUES
      ('of1','r2','m1','s1',9000,'pending'), ('of9','r1','m2','s2',9000,'pending');
    INSERT INTO community_orders (id,request_id,offer_id,customer_id,merchant_id,store_id,state,price_iqd,platform_fee_iqd,merchant_receivable_iqd) VALUES
      ('co1','r2','of1','buyer','m1','s1','funded',9000,450,8550),
      ('co2','r1','of9','buyer','m2','s2','funded',9000,450,8550);
    INSERT INTO merchant_reviews (id,merchant_id,customer_id,community_order_id,rating,body) VALUES
      ('rv1','m1','buyer','co1',5,'great'), ('rv2','m2','buyer','co2',4,'ok');
    INSERT INTO merchant_coupons (id,store_id,merchant_id,code,kind,value,active,ends_at) VALUES
      ('cpn1','s1','m1','SOON','percent',10,1,'${soon(3)}'),
      ('cpn2','s1','m1','LATER','percent',10,1,'${soon(30)}'),
      ('cpn3','s2','m2','THEIRS','percent',10,1,'${soon(2)}');
    INSERT INTO user_notifications (id,user_id,kind,title_ar,title_en,link) VALUES
      ('un1','owner','new_review','x','x','/merchant/reviews'),
      ('un2','owner2','new_review','x','x','/merchant/reviews');
  `);
  addOrder(raw, { id: 'ORD-A1', status: 'pending' });
  addOrder(raw, { id: 'ORD-A2', status: 'pending', user: 'buyer2' });
  addOrder(raw, { id: 'ORD-A3', status: 'processing' });
  addOrder(raw, { id: 'ORD-A4', status: 'shipped' });
  addOrder(raw, { id: 'ORD-A5', status: 'delivered' });
  addOrder(raw, { id: 'ORD-B1', status: 'pending', merchant: 'm2', store: 's2' });
  addOrder(raw, { id: 'ORD-B2', status: 'confirmed', merchant: 'm2', store: 's2' });
  return raw;
}

const attention = async (raw: DatabaseSync, who = OWNER, host?: string) => {
  const res = await get(appOf(raw, who, mount, {}, host), '/api/merchant/attention');
  assert.equal(res.status, 200);
  return (await json(res)).attention as Record<string, any>;
};

/** Every string under a `link`/`links`/`link_*` key. */
function links(v: unknown, out: string[] = []): string[] {
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'string' && (k === 'link' || k.startsWith('link_'))) out.push(x);
      else if (k === 'links' && x && typeof x === 'object') out.push(...(Object.values(x) as string[]));
      else links(x, out);
    }
  }
  return out;
}

// ---------------------------------------------------------------- attention

test('attention: real counts, merchant A never counts merchant B', async () => {
  const raw = world();
  const a = await attention(raw);
  assert.deepEqual(a.orders.by_stage, { pending: 2, confirmed: 0, processing: 1 }, 'shipped waits on the customer; B has a pending and a confirmed');
  assert.equal(a.orders.total, 3);
  assert.equal(a.custom_orders.to_start, 1);
  assert.equal(a.requests.matching, 1, 'r1 only: r2 already has my offer, r3 is closed');
  assert.deepEqual([a.stock.low, a.stock.out], [1, 1], 'cp1 low, cp2 out; the draft cp3 and B\'s cp9 do not count');
  assert.deepEqual([a.reviews.new, a.reviews.unanswered], [1, 1]);
  assert.equal(a.coupons.ending_soon, 1, 'SOON ends in 3 days; LATER in 30; THEIRS is B\'s');
  assert.equal(a.notifications.unread, 1);
  assert.deepEqual(a.store.problems, [], 'an active store on an active PLUS has no problems');
  assert.equal(a.money.available_iqd, 0, 'a ledger with no lines is a real zero');
  assert.equal(a.payouts.in_flight, 0);

  const b = await attention(raw, OWNER2);
  assert.deepEqual(b.orders.by_stage, { pending: 1, confirmed: 1, processing: 0 });
  assert.equal(b.requests.matching, 0, 'B already offered on r1, and r2 was not a match for B');
  assert.equal(b.stock.low, 1);
  assert.equal(b.coupons.ending_soon, 1);
});

test('attention: the host never widens the scope — A on B\'s subdomain still reads A', async () => {
  const raw = world();
  const onB = await attention(raw, OWNER, 'zahra.levonis-iq.com');
  assert.deepEqual(onB.orders.by_stage, { pending: 2, confirmed: 0, processing: 1 });
  assert.equal(onB.coupons.ending_soon, 1);
});

test('attention: every deep link is a real workspace address (or the two main-site doors), and a stage link opens its filter', async () => {
  const raw = world();
  raw.exec(`UPDATE merchant_stores SET status = 'paused' WHERE id = 's1'; UPDATE memberships SET state = 'expired' WHERE user_id = 'owner';`);
  const a = await attention(raw);
  const all = links(a);
  assert.ok(all.length >= 12, `links found: ${all.length}`);
  for (const l of all) {
    if (l === '/subscription' || l === '/support') continue;
    assert.ok(parseMerchantPath(l), `${l} is not a workspace address`);
  }
  assert.equal(readWorkspaceQuery(a.orders.links.pending.split('?')[1]).status, 'pending');
  assert.deepEqual(readWorkspaceQuery(a.stock.link_low.split('?')[1]), { create: false, stock: 'low', state: 'published' });
  assert.deepEqual(a.store.problems.map((p: { code: string }) => p.code), ['store_paused', 'subscription_inactive']);
});

test('attention: a source that cannot answer is ABSENT, never 0', async () => {
  const raw = world();
  raw.exec('DROP TABLE merchant_payouts; DROP TABLE community_request_matches; DROP TABLE merchant_coupons;');
  const a = await attention(raw);
  assert.equal('payouts' in a, false);
  assert.equal('requests' in a, false);
  assert.equal('coupons' in a, false);
  // The others still answer.
  assert.equal(a.orders.total, 3);
  assert.equal(a.stock.low, 1);
});

test('attention: matching requests are absent while Levo Community is shut to the merchant', async () => {
  const raw = world();
  raw.exec(`INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":false,"allowed":[]}')`);
  const a = await attention(raw);
  assert.equal('requests' in a, false);
  assert.equal(a.orders.total, 3);
});

test('attention: an unpublished store-page draft is named, with its fix (no draft: no problem, test 1)', async () => {
  const raw = world();
  raw.exec(`INSERT INTO store_layout_drafts (store_id, layout_json) VALUES ('s1', '{"schema":1,"theme":"midnight","blocks":[{"id":"b1","type":"announcement","settings":{"text":{"ar":"مرحبا"}}}]}')`);
  const a = await attention(raw);
  assert.ok(a.store.problems.some((p: { code: string; link: string }) => p.code === 'layout_unpublished' && p.link === '/merchant/store/design'));
});

test('attention: signed out 401, no store 404', async () => {
  const raw = world();
  assert.equal((await get(appOf(raw, null, mount), '/api/merchant/attention')).status, 401);
  const none = await get(appOf(raw, BUYER, mount), '/api/merchant/attention');
  assert.equal(none.status, 404);
  assert.equal((await json(none)).code, 'NOT_FOUND');
});

// ------------------------------------------------------------------- search

const search = async (raw: DatabaseSync, q: string, who = OWNER, db?: D1Database) => {
  const app = db
    ? (await import('./fixtures/app')).stubApp(db, who, mount, { env: { STORE_ROOT_DOMAIN: 'levonis-iq.com' } })
    : appOf(raw, who, mount);
  return get(app, `/api/merchant/search?q=${encodeURIComponent(q)}`);
};

test('search: orders by number, products by name / SKU / Arabic name, owner-scoped', async () => {
  const raw = world();
  const byNumber = await json(await search(raw, 'ORD-'));
  assert.deepEqual(byNumber.orders.map((o: { id: string }) => o.id).sort(), ['ORD-A1', 'ORD-A2', 'ORD-A3', 'ORD-A4', 'ORD-A5']);
  assert.ok(byNumber.orders.every((o: { link: string }) => parseMerchantPath(o.link)?.section === 'orders'));
  const b = await json(await search(raw, 'ORD-B'));
  assert.deepEqual(b.orders, [], 'B\'s orders are never found by A');

  const vase = await json(await search(raw, 'vase-r'));
  assert.deepEqual(vase.products.map((p: { id: string }) => p.id), ['cp1'], 'SKU');
  assert.equal(vase.products[0].link, '/merchant/products/cp1');
  const lamp = await json(await search(raw, 'مصباح'));
  assert.deepEqual(lamp.products.map((p: { id: string }) => p.id), ['cp2'], 'Arabic name');
  const cup = await json(await search(raw, 'Cup'));
  assert.deepEqual(cup.products, [], 'B\'s product');
});

test('search: customers by name or phone — only people who ordered here, no id or phone returned', async () => {
  const raw = world();
  const byName = await json(await search(raw, 'sara'));
  assert.equal(byName.customers.length, 1);
  assert.equal(byName.customers[0].name, 'Sara Ahmed');
  assert.equal(byName.customers[0].order_count, 4);
  assert.equal(parseMerchantPath(byName.customers[0].link)?.section, 'orders');
  assert.deepEqual(Object.keys(byName.customers[0]).sort(), ['last_order_at', 'link', 'name', 'order_count']);

  // The phone the customer GAVE this store on an order (the address
  // snapshot), written the national way with Arabic-Indic digits. The
  // ACCOUNT phone is never matched (review W2-5 p7): before the order carries
  // it, the same search finds nobody.
  assert.deepEqual((await json(await search(raw, '٠٧٨٠٩٩٩'))).customers, []);
  raw.exec(`UPDATE orders SET address_snapshot = json_set(CASE WHEN json_valid(address_snapshot) THEN address_snapshot ELSE '{}' END, '$.phone', '0780 999 8877')
             WHERE user_id = 'buyer2' AND merchant_id = 'm1'`);
  const byPhone = await json(await search(raw, '٠٧٨٠٩٩٩'));
  assert.deepEqual(byPhone.customers.map((c: { name: string }) => c.name), ['Omar Najm']);
  // B's customers are not A's: Omar never bought from Zahra.
  const other = await json(await search(raw, 'omar', OWNER2));
  assert.deepEqual(other.customers, []);
  assert.equal(phoneDigits('+964 770-111'), '770111');
});

test('search: capped, coded refusals, and every statement binds at most 4 parameters', async () => {
  const raw = world();
  for (let i = 0; i < 12; i++) raw.exec(`INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd) VALUES ('px${i}','m1','s1','bulk-${i}','Bulk ${i}','active','active',100)`);
  const bulk = await json(await search(raw, 'bulk'));
  assert.equal(bulk.products.length, SEARCH_LIMIT);

  const short = await search(raw, 'a');
  assert.equal(short.status, 400);
  assert.equal((await json(short)).code, 'SEARCH_QUERY_TOO_SHORT');
  const long = await search(raw, 'x'.repeat(61));
  assert.equal((await json(long)).code, 'SEARCH_QUERY_TOO_LONG');

  // A wildcard typed by the merchant is literal.
  assert.deepEqual((await json(await search(raw, '%%'))).products, []);

  const binds: number[] = [];
  const d1 = asD1(raw) as unknown as { prepare: (sql: string) => { bind: (...v: unknown[]) => unknown } };
  const spy = new Proxy(d1, {
    get(target, prop, recv) {
      if (prop !== 'prepare') return Reflect.get(target, prop, recv);
      return (sql: string) => {
        const st = target.prepare(sql);
        return new Proxy(st, {
          get(s, p, r) {
            if (p !== 'bind') return Reflect.get(s, p, r);
            return (...v: unknown[]) => {
              binds.push(v.length);
              return (s as { bind: (...a: unknown[]) => unknown }).bind(...v);
            };
          },
        });
      };
    },
  }) as unknown as D1Database;
  const res = await search(raw, 'Sara', OWNER, spy);
  assert.equal(res.status, 200);
  assert.ok(binds.length >= 3 && Math.max(...binds) <= 4, `binds per statement: ${binds.join(',')}`);
});
