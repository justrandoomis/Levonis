/**
 * THE DECOYS — owner brief 2026-10-10 («يتم اكتشافهم عن طريق ملفات وهمية»),
 * DECISIONS row 206, worker/routes/decoys.ts through the REAL Worker.
 *
 *   each decoy     answers fake data with its own type, no-store, noindex, its
 *                  own script-free policy, at most 8 KB; HEAD writes nothing;
 *                  the WordPress sign-in POST "succeeds" (302 /wp-admin/)
 *   canaries       every answer carries verifiable trap tokens; two answers,
 *                  two batches; renderDecoy is pure per batch
 *   synthetic      seeded real products, users and cost sentinels never appear
 *                  in any answer, and a decoy reads no catalogue table
 *   not deceived   the owner (bell), another admin (scored), a probe account,
 *                  a crawler, and an INDUCED request get a plain 404 and no block
 *   no shadowing   no decoy path is a real route; /admin still reaches the SPA
 *
 * Local only. Run: node --import tsx --test tests/deceptionDecoys.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { asD1 } from './fixtures/app';
import { COST, seedCostlyProduct } from './fixtures/costlyProduct';
import { LIVE_PRODUCTS, seedLiveCatalog } from './fixtures/liveCatalog';
import { CLICKED, INDUCED, SCRIPT, TYPED, blocks, deceptionEvents, deceptionWorld, ownerBells, setCookieValue } from './fixtures/deception';
import { findCanaries, mintBatch } from '../worker/lib/deception/canary';
import {
  DECOYS,
  DECOY_CODES,
  DECOY_ROUTE_PATTERNS,
  DECOY_WORKER_FIRST,
  batchShape,
  decoyFor,
  renderDecoy,
  type DecoyCode,
} from '../worker/lib/deception/decoys';
import { codeOf } from './fixtures/source';

/** One path per decoy, and the variants that answer differently. */
const PATHS: ReadonlyArray<[string, DecoyCode, RegExp]> = [
  ['/.env', 'env', /^text\/plain/],
  ['/.env.production', 'env', /^text\/plain/],
  ['/.git/config', 'git_config', /^text\/plain/],
  ['/.git/HEAD', 'git_config', /^text\/plain/],
  ['/config.json', 'config_json', /^application\/json/],
  ['/backup.sql', 'sql_dump', /^application\/sql/],
  ['/database.sql', 'sql_dump', /^application\/sql/],
  ['/admin/export/costs.csv', 'costs_export', /^text\/csv/],
  ['/api/internal/pricing/costs', 'internal_costs', /^application\/json/],
  ['/api/v0/admin/products?include=cost', 'v0_admin', /^application\/json/],
  ['/wp-login.php', 'wp_login', /^text\/html/],
  ['/wp-admin/', 'wp_login', /^text\/html/],
  ['/xmlrpc.php', 'wp_login', /^text\/xml/],
  ['/phpmyadmin/', 'phpmyadmin', /^text\/html/],
];

test('every decoy code has a path here, and every path names its decoy', () => {
  assert.deepEqual([...new Set(PATHS.map(([, c]) => c))].sort(), [...DECOY_CODES].sort());
  for (const [path, code] of PATHS) assert.equal(decoyFor(path.split('?')[0]!), code, path);
  assert.equal(decoyFor('/admin'), null);
  assert.equal(decoyFor('/api/products'), null);
  assert.equal(decoyFor('/.environment'), null);
});

test('each decoy answers 200 with fake data: its type, no-store, noindex, no script, its own policy, ≤ 8 KB — and an incident', async () => {
  for (const [path, code, type] of PATHS) {
    const w = await deceptionWorld();
    const res = await w.call(path, { headers: TYPED });
    const body = await res.text();
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type') ?? '', type, path);
    assert.match(res.headers.get('cache-control') ?? '', /no-store/, path);
    assert.match(res.headers.get('x-robots-tag') ?? '', /noindex/, path);
    assert.ok(body.length > 10 && body.length <= 8192, `${path}: ${body.length} bytes`);
    assert.doesNotMatch(body, /<script/i, path);
    if (/html/.test(type.source)) {
      const csp = res.headers.get('content-security-policy') ?? '';
      assert.match(csp, /default-src 'none'/, path);
      assert.doesNotMatch(csp, /script-src/, path);
    }
    assert.ok(setCookieValue(res, 'lv_pref'), `${path}: the device tag is set on the deceiving answer`);
    const rows = blocks(w.raw);
    assert.ok(rows.some((b) => b.actor_kind === 'device' && b.reason === 'decoy_hit'), path);
    assert.equal(deceptionEvents(w.raw, 'DECOY_HIT').length, 1, path);
    const ev = JSON.parse(String(deceptionEvents(w.raw, 'DECOY_HIT')[0]!.detail));
    assert.equal(ev.decoy, code, path);
    // The incident's canary batch is recorded so a later use can be linked to it.
    assert.equal((w.raw.prepare('SELECT COUNT(*) AS n FROM security_canaries').get() as { n: number }).n, 1, path);
  }
});

test('the fake WordPress sign-in "succeeds": POST /wp-login.php → 302 /wp-admin/, whose page links the cost export with a key', async () => {
  const w = await deceptionWorld();
  const res = await w.call('/wp-login.php', { method: 'POST', body: { log: 'admin', pwd: 'x' }, headers: SCRIPT });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/wp-admin/');
  const page = await deceptionWorld().then((w2) => w2.call('/wp-admin/', { headers: TYPED }));
  assert.match(await page.text(), /\/admin\/export\/costs\.csv\?token=lvk_live_[0-9a-f]{32}/);
  const pma = await deceptionWorld().then((w3) => w3.call('/phpmyadmin/index.php', { method: 'POST', body: {}, headers: SCRIPT }));
  assert.equal(pma.status, 200);
  assert.match(await pma.text(), /product_costs/);
});

test('HEAD gets the headers and writes nothing', async () => {
  const w = await deceptionWorld();
  const res = await w.call('/.env', { method: 'HEAD', headers: TYPED });
  assert.equal(res.status, 200);
  assert.equal((await res.text()).length, 0);
  assert.equal(blocks(w.raw).length, 0);
  assert.equal(deceptionEvents(w.raw).length, 0);
});

test('every answer carries trap tokens that verify; two answers carry two different batches', async () => {
  const w1 = await deceptionWorld();
  const a = await (await w1.call('/.env', { headers: TYPED })).text();
  const w2 = await deceptionWorld();
  const b = await (await w2.call('/.env', { headers: TYPED })).text();
  const found = await findCanaries({}, [[a, 'body']]);
  assert.ok(found.length >= 2, JSON.stringify(found));
  assert.ok(found.every((f) => f.batch === found[0]!.batch));
  const other = await findCanaries({}, [[b, 'body']]);
  assert.notEqual(other[0]!.batch, found[0]!.batch);
  // The SQL dump's product ids are product-shaped canaries.
  const w3 = await deceptionWorld();
  const sql = await (await w3.call('/backup.sql', { headers: TYPED })).text();
  const ids = [...sql.matchAll(/'(prd_[0-9a-f]{20})'/g)].map((m) => m[1]!);
  assert.ok(ids.length >= 8 && ids.length <= 15, `${ids.length} product rows`);
  const verified = await findCanaries({}, ids.slice(0, 3).map((id) => [id, 'url'] as const));
  assert.ok(verified.every((f) => f.kind === 'p'));
  assert.equal(verified.length, 1, 'one batch, de-duplicated');
});

test('renderDecoy is pure per batch: the console regenerates exactly what was served', async () => {
  for (const code of DECOY_CODES) {
    const shape = batchShape('0a1b2c3d4e');
    const t1 = await mintBatch({}, '0a1b2c3d4e', 'levonis-iq.com', shape.productCount, shape.keyNoise);
    const t2 = await mintBatch({}, '0a1b2c3d4e', 'levonis-iq.com', shape.productCount, shape.keyNoise);
    const ctx = { host: 'levonis-iq.com', rootDomain: 'levonis-iq.com', method: 'GET', path: DECOYS[code].exact[0] ?? `${DECOYS[code].prefixes[0]}x` };
    assert.deepEqual(renderDecoy(code, t1, ctx), renderDecoy(code, t2, ctx), code);
  }
  const s1 = batchShape('0a1b2c3d4e');
  const other = await mintBatch({}, '9f8e7d6c5b', 'levonis-iq.com', s1.productCount, s1.keyNoise);
  const mine = await mintBatch({}, '0a1b2c3d4e', 'levonis-iq.com', s1.productCount, s1.keyNoise);
  assert.notEqual(renderDecoy('env', other, { host: 'h', rootDomain: 'h', method: 'GET', path: '/.env' }).body, renderDecoy('env', mine, { host: 'h', rootDomain: 'h', method: 'GET', path: '/.env' }).body);
  // A different secret mints different tokens for the same batch.
  const keyed = await mintBatch({ SECURITY_CANARY_KEY: 'another-key' }, '0a1b2c3d4e', 'levonis-iq.com', s1.productCount, s1.keyNoise);
  assert.notEqual(keyed.apiKey, mine.apiKey);
});

test('NO REAL DATA EVER APPEARS IN A DECOY: seeded products, users and cost sentinels are absent, and no catalogue table is read', async () => {
  const w = await deceptionWorld();
  w.raw.exec('PRAGMA foreign_keys = OFF;');
  seedCostlyProduct(w.raw);
  seedLiveCatalog(w.raw);
  const seededUsers = (w.raw.prepare('SELECT id, email, name FROM users').all() as Array<{ id: string; email: string; name: string }>).map((u) => ({ ...u }));
  const real = (w.raw.prepare('SELECT id, slug, name, price_iqd FROM products').all() as Array<{ id: string; slug: string; name: string; price_iqd: number }>).map((p) => ({ ...p }));
  assert.ok(real.length >= 10);
  // Record every statement the decoy requests prepare.
  const seen: string[] = [];
  const db = asD1(w.raw);
  w.env.DB = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') return (sql: string) => (seen.push(sql), (target as D1Database).prepare(sql));
      return Reflect.get(target, prop, receiver);
    },
  });
  const bodies: string[] = [];
  for (const [path] of PATHS) {
    const res = await w.call(path, { headers: TYPED, ip: `198.18.0.${bodies.length + 1}` });
    bodies.push(await res.text());
  }
  for (const pma of ['/phpmyadmin/index.php']) {
    bodies.push(await (await w.call(pma, { method: 'POST', body: {}, headers: SCRIPT, ip: '198.18.1.1' })).text());
  }
  const all = bodies.join('\n');
  // A whole token, not a substring of random hex: `a1` is a slug and also two characters of any key.
  const holds = (needle: string) => new RegExp(`(?<![A-Za-z0-9_-])${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`).test(all);
  for (const p of [...real, ...LIVE_PRODUCTS]) {
    assert.ok(!holds(p.id), `product id ${p.id}`);
    assert.ok(!holds(p.slug), `product slug ${p.slug}`);
    assert.ok(!holds(p.name), `product name ${p.name}`);
  }
  for (const u of seededUsers) {
    assert.ok(!holds(u.email), `user ${u.email}`);
    assert.ok(!holds(u.id), `user id ${u.id}`);
  }
  for (const v of Object.values(COST)) assert.ok(!new RegExp(`\\b${v}\\b`).test(all), `cost sentinel ${v}`);
  // No third-party secret format, no resolvable outside host.
  assert.doesNotMatch(all, /AKIA[0-9A-Z]{12}|ghp_[A-Za-z0-9]{20}|sk_live_|xox[bp]-/);
  const tables = new Set(seen.flatMap((sql) => [...sql.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+([a-z_]+)/gi)].map((m) => m[1]!.toLowerCase())));
  for (const t of tables) {
    assert.ok(/^(security_|user_notifications$|users$|sessions$|audit_log$|rate_limits$)/.test(t) || t === 'select' || t === 'set', `a decoy request touched ${t}`);
  }
  assert.ok(!tables.has('products') && !tables.has('inventory_lots') && !tables.has('orders'));
});

test('NOT DECEIVED: the owner, another admin, a probe account, a crawler and an induced request get a plain 404 and no block', async () => {
  // The owner: recorded, the bell rings, never blocked.
  {
    const w = await deceptionWorld();
    const res = await w.call('/.env', { as: 'owner', headers: TYPED });
    assert.equal(res.status, 404);
    assert.doesNotMatch(await res.text(), /LEVONIS_API_KEY/);
    assert.equal(setCookieValue(res, 'lv_pref'), null);
    assert.equal(blocks(w.raw).length, 0);
    assert.equal(JSON.parse(String(deceptionEvents(w.raw, 'DECOY_HIT')[0]!.detail)).ex, 'owner');
    assert.equal(ownerBells(w.raw).length, 1, 'the owner hears that a decoy was opened from the account');
  }
  // Another admin: recorded and scored, never blocked by a decoy alone.
  {
    const w = await deceptionWorld();
    const res = await w.call('/backup.sql', { as: 'full', headers: TYPED });
    assert.equal(res.status, 404);
    assert.equal(blocks(w.raw).length, 0);
    assert.equal(JSON.parse(String(deceptionEvents(w.raw, 'DECOY_HIT')[0]!.detail)).ex, 'admin');
    assert.ok(Number((w.raw.prepare("SELECT score FROM security_scores WHERE actor_key = 'u:usr_full'").get() as { score: number }).score) >= 100);
  }
  // A registered probe account: nothing at all.
  {
    const w = await deceptionWorld();
    const res = await w.call('/.env', { as: 'probe', headers: TYPED });
    assert.equal(res.status, 404);
    assert.equal(blocks(w.raw).length, 0);
    assert.equal(deceptionEvents(w.raw).length, 0);
  }
  // Crawlers and preview bots (Telegram fetches pasted links whatever robots.txt says).
  for (const ua of ['TelegramBot (like TwitterBot)', 'Mozilla/5.0 (compatible; Googlebot/2.1)', 'WhatsApp/2.23', 'facebookexternalhit/1.1']) {
    const w = await deceptionWorld();
    const res = await w.call('/.git/config', { headers: { 'User-Agent': ua } });
    assert.equal(res.status, 404, ua);
    assert.equal(blocks(w.raw).length, 0, ua);
    assert.equal(JSON.parse(String(deceptionEvents(w.raw, 'DECOY_HIT')[0]!.detail)).ex, 'crawler');
    assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM security_scores').get()!.n, 0, ua);
  }
  // Induced: an image, a cross-site link, a navigation without a click, a frame.
  for (const headers of INDUCED) {
    for (const as of [null, 'customer'] as const) {
      const w = await deceptionWorld();
      const res = await w.call('/.env', { headers, as });
      assert.equal(res.status, 404, JSON.stringify(headers));
      assert.equal(blocks(w.raw).length, 0, JSON.stringify(headers));
      assert.equal(deceptionEvents(w.raw, 'DECOY_INDUCED').length, 1);
      const next = await w.call('/api/products', { as, headers: SCRIPT });
      assert.equal(next.status, 200, 'an <img src="/.env"> in a post never blocks the viewer');
    }
  }
});

test('a CLICKED same-site link gets the fake data and 60 points — no block from one click', async () => {
  const w = await deceptionWorld();
  const res = await w.call('/admin/export/costs.csv', { as: 'customer', headers: CLICKED });
  assert.equal(res.status, 200);
  assert.equal(setCookieValue(res, 'lv_pref'), null);
  assert.equal(blocks(w.raw).length, 0);
  assert.equal((w.raw.prepare("SELECT score FROM security_scores WHERE actor_key = 'u:usr_cust'").get() as { score: number }).score, 60);
  assert.equal((await w.call('/api/products', { as: 'customer', headers: SCRIPT })).status, 200);
  // A second click crosses 100: blocked.
  const again = await w.call('/admin/export/costs.csv', { as: 'customer', headers: CLICKED });
  assert.equal(again.status, 200);
  assert.ok(setCookieValue(again, 'lv_pref'));
  assert.equal((await w.call('/api/products', { as: 'customer', headers: SCRIPT })).status, 403);
});

test('NO SHADOWING: no decoy path is a real route, /admin still reaches the app, and every decoy is routed to the Worker in all three environments', async () => {
  const index = codeOf('worker/index.ts');
  const mounts = [...index.matchAll(/app\.(?:route|get|all|use)\(\s*'([^']+)'/g)].map((m) => m[1]!).filter((p) => p !== '/' && p !== '*');
  for (const pattern of DECOY_ROUTE_PATTERNS) {
    const p = pattern.replace(/\*$/, '');
    for (const m of mounts) {
      const prefix = m.replace(/\/\*$/, '');
      if (prefix === '/api') continue;
      assert.ok(!(p === prefix || p.startsWith(`${prefix}/`) && prefix !== '/api'), `${pattern} sits under the mount ${m}`);
    }
  }
  const w = await deceptionWorld();
  for (const path of ['/admin', '/admin?tab=security', '/']) {
    const res = await w.call(path, { as: 'customer', headers: TYPED });
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), /<title>LEVONIS<\/title>/, path);
  }
  assert.equal(blocks(w.raw).length, 0);
  const wrangler = readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8');
  const routed = wrangler.match(/"run_worker_first"\s*:\s*\[[^\]]*\]/g) ?? [];
  assert.equal(routed.length, 3);
  for (const block of routed) for (const path of DECOY_WORKER_FIRST) assert.ok(block.includes(`"${path}"`), `${path} missing from a run_worker_first block`);
});

test('a decoy on a merchant subdomain deceives too (scanners hit every host)', async () => {
  const w = await deceptionWorld();
  const res = await w.call('/.env', { host: 'somestore.levonis-iq.com', headers: TYPED });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /APP_URL=https:\/\/somestore\.levonis-iq\.com/);
});
