/**
 * MANIPULATION SIGNALS AND SCORES (worker/lib/deception/signals.ts, gate.ts;
 * DECISIONS row 206), through the REAL Worker.
 *
 *   price fields   a price, cost, total or discount sent to the cart, the
 *                  checkout or a quote: recorded by NAME (never the value),
 *                  50 points — and the server still charges its own price; a
 *                  second try blocks
 *   legitimate     the bodies src/ sends score nothing
 *   injection      SQL / script / traversal shapes in the URL score; Arabic
 *   and tamper     and Sorani search text never does; role / admin / debug /
 *                  cost-revealing switches on a customer API route score
 *   linkable       whatever a link can carry — from a browser — stops at 99:
 *                  an innocent behind a carrier address an attacker primed is
 *                  never tagged for it (fix round CGNAT carry-over)
 *   others' data   repeated refusals on other people's orders: a tool reaches
 *                  the threshold, a browser stops at 99; one refusal writes no
 *                  event
 *   brute force    a 429 on a sign-in bucket is recorded and never scores the
 *                  shared address (a carrier's subscribers share that bucket)
 *   decay          one halving per six hours, the SQL upsert agreeing with
 *                  the TypeScript model; the linkable cap in the same upsert
 *   live probes    workflow 7's own anonymous probes, replayed from one address
 *                  through many isolates, keep their statuses and never block
 *
 * Local only. Run: node --import tsx --test tests/deceptionSignals.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { json } from './fixtures/app';
import { seedCostlyProduct } from './fixtures/costlyProduct';
import { seedLiveCatalog } from './fixtures/liveCatalog';
import { asD1 } from './fixtures/app';
import { OTHER_IP, SCRIPT, TOOL, blocks, deceptionEvents, deceptionWorld, setCookieValue, type World } from './fixtures/deception';
import { LINKABLE_CAP, THRESHOLD, WEIGHTS, bumpScore, decayed, injectionIn, priceFieldsIn, tamperParams } from '../worker/lib/deception/signals';
// @ts-expect-error - plain ESM script shared with workflow 7, no types
import * as probesScript from '../scripts/live-cost-probes.mjs';
const { fillPath, loadProbeFiles, pick } = probesScript;

const score = (w: World, key: string) => (w.raw.prepare('SELECT score FROM security_scores WHERE actor_key = ?').get(key) as { score: number } | undefined)?.score ?? 0;

function seedPlainProduct(w: World) {
  w.raw.exec(`INSERT INTO products (id,slug,name,price_iqd,status,stock) VALUES ('p_plain','plain-nozzle','Plain nozzle',5000,'active',50)`);
}

test('pure: price-like keys by name at depth ≤ 3; injection and tamper shapes; Arabic and Sorani search never match', () => {
  assert.deepEqual(priceFieldsIn({ productId: 'p', qty: 1, unit_price_iqd: 1 }), ['unit_price_iqd']);
  assert.deepEqual(priceFieldsIn({ productId: 'p', priceIqd: 1, nested: { finalPrice: 2, deeper: { discount: 3 } } }).sort(), ['discount', 'finalPrice', 'priceIqd']);
  assert.deepEqual(priceFieldsIn({ a: { b: { c: { total: 1 } } } }), [], 'depth 4 is not read');
  assert.deepEqual(priceFieldsIn({ price: null, cost: undefined }), [], 'a null is not a field sent');
  for (const legit of [
    { productId: 'p', qty: 1, optionId: 'o', optionValueIds: ['v'], colorId: 'c', transportMethod: 'air', warrantyPlanId: 'w', replaceCart: true },
    { addressId: 'a', deliveryMethodId: 'd', paymentMethodId: 'p', itemIds: ['i'], usePoints: true, useWallet: false, protectedDelivery: false, couponCode: 'X', supportCode: 'y', idempotencyKey: 'k', policyAcceptance: [{ key: 'k', version: 1 }] },
    { giftId: 'g', replaceCart: true },
    { code: 'SAVE10' },
    { couponCode: 'X', idempotencyKey: 'k', addressId: 'a', fulfilment: 'delivery', quoteFingerprint: 'f' },
  ]) {
    assert.deepEqual(priceFieldsIn(legit), [], JSON.stringify(legit));
  }
  for (const bad of ["/api/products?search=' OR 1=1--", '/api/products?q=1 UNION SELECT password FROM users', '/api/x?a=<script>alert(1)</script>', '/api/x?f=../../etc/passwd', '/api/x?u=${jndi:ldap://x}', '/api/x?s=1;DROP TABLE users', '/api/x?n=%00', '/api/x?q=sleep(5)']) {
    assert.ok(injectionIn(`https://levonis-iq.com${bad}`), bad);
  }
  for (const ok of ['/api/products?search=طابعة ثلاثية الأبعاد', '/api/products?search=چاپکەری سێ ڕەهەندی', '/api/products?search=PLA+or+PETG', "/api/products?search=O'Reilly", '/api/products?category=filament&sort=price']) {
    assert.equal(injectionIn(`https://levonis-iq.com${ok}`), false, ok);
  }
  assert.deepEqual(tamperParams('/api/products', new URLSearchParams('role=admin&debug=1')).sort(), ['debug', 'role']);
  assert.deepEqual(tamperParams('/api/products', new URLSearchParams('include=cost&fields=supplier_price')).sort(), ['fields', 'include']);
  assert.deepEqual(tamperParams('/api/products', new URLSearchParams('include=images&limit=3&search=role')), []);
  assert.deepEqual(tamperParams('/api/admin/users', new URLSearchParams('role=admin')), [], 'the admin filters are not tampering');
});

test('PRICE FIELDS in the cart: recorded by name, 50 points, the line still at the server\'s price — a second try blocks', async () => {
  const w = await deceptionWorld();
  seedPlainProduct(w);
  const first = await w.call('/api/cart/items', { as: 'customer', body: { productId: 'p_plain', qty: 1, unit_price_iqd: 1, priceIqd: 1 }, headers: SCRIPT });
  assert.equal(first.status, 200, await first.clone().text());
  const items = (await json(first)).items as Array<{ product_id?: string; unit_price_iqd?: number; price_iqd?: number }>;
  assert.ok(items.length === 1);
  const line = JSON.stringify(items[0]);
  assert.ok(/5000/.test(line), `the cart line keeps the server's price: ${line}`);
  assert.ok(!/"(unit_price_iqd|price_iqd)":1\b/.test(line), line);
  const ev = deceptionEvents(w.raw, 'CLIENT_PRICE_FIELDS');
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.kind, 'private_input_dropped');
  assert.deepEqual(JSON.parse(String(ev[0]!.detail)).fields.sort(), ['priceIqd', 'unit_price_iqd']);
  assert.ok(!String(ev[0]!.detail).includes('"1"') && !/:1[,}]/.test(String(ev[0]!.detail)), 'never the value');
  assert.equal(score(w, 'u:usr_cust'), WEIGHTS.CLIENT_PRICE_FIELDS);
  assert.equal(blocks(w.raw).length, 0);
  const second = await w.call('/api/cart/items', { as: 'customer', body: { productId: 'p_plain', qty: 1, discount: 99 }, headers: SCRIPT });
  assert.ok(setCookieValue(second, 'lv_pref'), 'the crossing tags the browser on its own answer');
  assert.ok(blocks(w.raw).some((b) => b.actor_kind === 'account' && b.reason === 'score_threshold' && b.signal === 'CLIENT_PRICE_FIELDS'));
  assert.equal((await w.call('/api/cart', { as: 'customer', headers: SCRIPT })).status, 403);
});

test('PRICE FIELDS at checkout, the quote and Quick Buy are recorded too; the bodies src/ sends score nothing', async () => {
  for (const [path, body] of [
    ['/api/orders', { itemIds: ['x'], total: 1, idempotencyKey: 'k1' }],
    ['/api/orders/quote', { itemIds: ['x'], subtotal: 1 }],
    ['/api/quick-buy/items', { productId: 'p_plain', qty: 1, finalPrice: 1, idempotencyKey: 'k2' }],
    ['/api/cart/coupon-check', { code: 'X', discount: 100 }],
  ] as const) {
    const w = await deceptionWorld();
    seedPlainProduct(w);
    const res = await w.call(path, { as: 'customer', body, headers: SCRIPT });
    assert.ok(res.status < 500, `${path}: ${res.status}`);
    assert.equal(deceptionEvents(w.raw, 'CLIENT_PRICE_FIELDS').length, 1, path);
    assert.equal(score(w, 'u:usr_cust'), 50, path);
  }
  const w = await deceptionWorld();
  seedPlainProduct(w);
  for (const [path, body] of [
    ['/api/cart/items', { productId: 'p_plain', qty: 1 }],
    ['/api/cart/coupon-check', { code: 'SAVE10' }],
    ['/api/orders/quote', { addressId: 'a', deliveryMethodId: 'd', itemIds: ['x'], usePoints: false, useWallet: false, protectedDelivery: false }],
  ] as const) {
    await w.call(path, { as: 'customer', body, headers: SCRIPT });
  }
  assert.equal(score(w, 'u:usr_cust'), 0);
  assert.equal(deceptionEvents(w.raw).length, 0);
});

test('INJECTION and TAMPER on public routes score; Arabic and Sorani search does not; four injections block an anonymous scanner for an hour', async () => {
  const w = await deceptionWorld();
  for (const q of ['طابعة ثلاثية الأبعاد', 'چاپکەری سێ ڕەهەندی', 'PLA']) {
    assert.equal((await w.call(`/api/products?search=${encodeURIComponent(q)}`, { ip: OTHER_IP, headers: SCRIPT })).status, 200);
  }
  assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM security_scores').get()!.n, 0);
  await w.call('/api/products?role=admin&include=cost', { as: 'customer', headers: SCRIPT });
  assert.equal(score(w, 'u:usr_cust'), WEIGHTS.TAMPER_PARAMS);
  assert.deepEqual(JSON.parse(String(deceptionEvents(w.raw, 'TAMPER_PARAMS')[0]!.detail)).fields.sort(), ['include', 'role']);
  let last: Response | null = null;
  for (let i = 0; i < 4; i++) last = await w.call(`/api/products?search=${encodeURIComponent(`x' UNION SELECT ${i} FROM users--`)}`, { headers: TOOL });
  assert.ok(setCookieValue(last!, 'lv_pref'));
  const net = blocks(w.raw).find((b) => b.actor_kind === 'network')!;
  const hours = (Date.parse(String(net.expires_at)) - Date.parse(String(net.created_at))) / 3_600_000;
  assert.ok(hours > 0.99 && hours < 1.01, `a score-only network block lasts one hour: ${hours}`);
  assert.equal((await w.call('/api/products', { headers: TOOL })).status, 403);
  assert.equal((await w.call('/api/products', { as: 'neighbour', headers: TOOL })).status, 200, 'the signed-in neighbour is untouched');
  assert.equal((await w.call('/api/products', { headers: SCRIPT })).status, 200, 'and so is every browser on the address');
});

test('LINKABLE STOPS AT 99: an injection-shaped link opened in a browser never blocks; an attacker priming a shared address never gets the innocent behind it tagged (fix round CGNAT carry-over)', async () => {
  const w = await deceptionWorld();
  const CGNAT = '100.64.10.20';
  // A victim opens links with injection shapes and admin paths, over and over.
  for (let i = 0; i < 8; i++) await w.call(`/api/products?search=${encodeURIComponent(`x' UNION SELECT ${i} FROM users--`)}`, { ip: CGNAT, headers: SCRIPT });
  assert.equal(blocks(w.raw).length, 0);
  const n = w.raw.prepare("SELECT score FROM security_scores WHERE actor_key LIKE 'n:%'").get() as { score: number };
  assert.equal(n.score, LINKABLE_CAP);
  // An attacker's tool on the same address primes it just short of the threshold…
  for (let i = 0; i < 3; i++) await w.call(`/api/home?q=${encodeURIComponent(`<script>${i}`)}`, { ip: CGNAT, headers: TOOL });
  // …then the innocent behind it mistypes her password until the shared sign-in bucket refuses.
  let tagged = false;
  for (let i = 0; i < 24; i++) {
    const r = await w.call('/api/auth/login', { ip: CGNAT, headers: SCRIPT, body: { identifier: 'nb@x.co', password: `wrong-${i}` } });
    if (setCookieValue(r, 'lv_pref')) tagged = true;
  }
  assert.equal(tagged, false, 'the innocent browser is never tagged');
  assert.equal((await w.call('/api/home', { ip: CGNAT, headers: SCRIPT })).status, 200, 'and browses on');
  // The attacker's tool, whose own request crossed the line, is the one blocked.
  assert.equal((await w.call('/api/home', { ip: CGNAT, headers: TOOL })).status, 403);
});

test('OTHERS\' RECORDS: one refusal writes no event; a tool walking ids reaches the threshold, a browser (a link to someone\'s order) stops at 99', async () => {
  const w = await deceptionWorld();
  await w.call('/api/orders/ORD-NOTYOURS1', { as: 'customer', headers: SCRIPT });
  assert.equal(deceptionEvents(w.raw).length, 0, 'an ordinary 404 is not a log row');
  assert.equal(score(w, 'u:usr_cust'), WEIGHTS.IDOR_PROBE);
  for (let i = 0; i < 30; i++) await w.call(`/api/orders/ORD-LINK${i}`, { as: 'customer', headers: SCRIPT });
  assert.equal(blocks(w.raw).length, 0);
  assert.equal(score(w, 'u:usr_cust'), LINKABLE_CAP);
  for (let i = 0; i < 25 && blocks(w.raw).length === 0; i++) await w.call(`/api/orders/ORD-GUESS${i}`, { as: 'neighbour', headers: TOOL });
  assert.ok(deceptionEvents(w.raw, 'IDOR_PROBE').length >= 1, 'recorded once the score passes 50');
  assert.ok(blocks(w.raw).some((b) => b.actor_key === 'usr_neighbour' && b.signal === 'IDOR_PROBE'));
});

test('BRUTE FORCE: a 429 on the sign-in bucket is recorded — and never scores the shared address', async () => {
  const w = await deceptionWorld();
  let saw429 = false;
  for (let i = 0; i < 24; i++) {
    const res = await w.call('/api/auth/login', { ip: OTHER_IP, body: { identifier: `nobody${i}@x.co`, password: 'wrong-password-1' }, headers: SCRIPT });
    if (res.status === 429) saw429 = true;
  }
  assert.ok(saw429);
  const ev = deceptionEvents(w.raw, 'AUTH_BRUTE_FORCE');
  assert.ok(ev.length >= 1);
  assert.equal(ev[0]!.kind, 'rate_limited');
  assert.equal(JSON.parse(String(ev[0]!.detail)).bucket, 'login');
  assert.equal((w.raw.prepare("SELECT COUNT(*) AS n FROM security_scores WHERE actor_key LIKE 'n:%'").get() as { n: number }).n, 0, 'a carrier\'s subscribers share the sign-in bucket');
});

test('DECAY: one halving per six hours — the SQL upsert agrees with the model', async () => {
  const w = await deceptionWorld();
  const db = w.env.DB as D1Database;
  const t0 = Date.parse('2026-10-10T00:00:00.000Z');
  assert.equal(await bumpScore(db, 'u:x', 'TEST', 80, new Date(t0)), 80);
  for (const [hours, expectSteps] of [[5, 0], [6, 1], [13, 2], [30, 5]] as const) {
    w.raw.exec(`UPDATE security_scores SET score = 80, updated_at = '${new Date(t0).toISOString()}' WHERE actor_key = 'u:x'`);
    const at = t0 + hours * 3_600_000;
    const sql = await bumpScore(db, 'u:x', 'TEST', 0, new Date(at));
    assert.equal(sql, decayed(80, t0, at), `${hours} h`);
    assert.equal(sql, Math.floor(80 / 2 ** expectSteps), `${hours} h`);
  }
  assert.equal(decayed(200, t0, t0 + 10 * 86_400_000), 0, 'thirty halvings at most, never negative');
  // The linkable cap: a linkable signal raises a score to 99 at most and never lowers one above it.
  assert.equal(await bumpScore(db, 'u:cap', 'TEST', 80, new Date(t0), LINKABLE_CAP), 80);
  assert.equal(await bumpScore(db, 'u:cap', 'TEST', 60, new Date(t0), LINKABLE_CAP), LINKABLE_CAP);
  assert.equal(await bumpScore(db, 'u:cap', 'TEST', 60, new Date(t0), LINKABLE_CAP), LINKABLE_CAP);
  assert.equal(await bumpScore(db, 'u:cap', 'TEST', 30, new Date(t0)), 129, 'hard evidence carries it over');
  assert.equal(await bumpScore(db, 'u:cap', 'TEST', 60, new Date(t0), LINKABLE_CAP), 129, 'and a linkable signal never lowers it');
  assert.equal(await bumpScore(db, 'u:cap2', 'TEST', 500, new Date(t0), LINKABLE_CAP), LINKABLE_CAP, 'a first linkable signal starts capped');
  const sig = JSON.parse(String((w.raw.prepare("SELECT signals FROM security_scores WHERE actor_key = 'u:x'").get() as { signals: string }).signals));
  assert.equal(sig.TEST, 5);
  assert.equal(THRESHOLD, 100);
});

test('THE LIVE PROBES NEVER BLOCK: workflow 7\'s anonymous probes and verify paths, from one address through many isolates and deploys, keep their statuses', async () => {
  const w = await deceptionWorld();
  w.raw.exec('PRAGMA foreign_keys = OFF;');
  seedCostlyProduct(w.raw);
  seedLiveCatalog(w.raw);
  const files = loadProbeFiles(join(ROOT, 'scripts/live-cost-probes.d')) as Array<{ spec: { probes: Array<{ path: string; status: number[] }>; vars?: Record<string, { from: string; pick: string }> } }>;
  const ua = { 'User-Agent': 'levonis-live-cost-probes/1 (read-only)', accept: 'application/json' };
  const ip = '140.82.112.3';
  const verify: Array<[string, number]> = [['/api/health', 200], ['/api/home', 200], ['/api/products?limit=3', 200], ['/api/memberships/plans', 200]];
  for (let round = 0; round < 6; round++) {
    // Each round a fresh isolate: the per-isolate quiet windows start over (fix round MINOR multi-isolate).
    w.env.DB = asD1(w.raw);
    for (const [path, want] of verify) {
      const res = await w.call(path, { ip, headers: ua });
      assert.equal(res.status, want, `round ${round}: ${path}`);
    }
    for (const { spec } of files) {
      const vars: Record<string, string> = {};
      for (const [name, def] of Object.entries(spec.vars ?? {})) vars[name] = pick(JSON.parse(await (await w.call(def.from, { ip, headers: ua })).text()), def.pick);
      for (const p of spec.probes) {
        const res = await w.call(fillPath(p.path, vars), { ip, headers: ua });
        assert.ok(p.status.includes(res.status), `round ${round}: ${p.path} answered ${res.status}, want ${p.status}`);
      }
    }
  }
  assert.deepEqual(blocks(w.raw), [], 'the deploy\'s own probes never block its runner');
  const top = w.raw.prepare('SELECT MAX(score) AS m FROM security_scores').get() as { m: number | null };
  assert.ok((top.m ?? 0) < THRESHOLD, `the probes scored ${top.m}`);
});
