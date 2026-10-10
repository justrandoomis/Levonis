/**
 * THE DECOYS — owner brief 2026-10-10 («يتم اكتشافهم عن طريق ملفات وهمية»),
 * DECISIONS row 206, worker/routes/decoys.ts through the REAL Worker.
 *
 *   each decoy     answers fake data with its own type and nothing else a file
 *                  would not carry (no cookie, no no-store, no robots header),
 *                  no script, at most 8 KB; HEAD writes nothing; the WordPress
 *                  sign-in POST "succeeds" (302 /wp-admin/); paths a real
 *                  exposed server would not have answer 404 (fix round m2)
 *   one answer     a tool, a browser, an image tag, a claimed crawler, a forged
 *                  Sec-Fetch header and a staff account all get the same answer
 *                  (fix round B1, M2, M8): only what is written differs
 *   canaries       every answer carries verifiable trap tokens no two of which
 *                  share a visible substring; two answers, two batches;
 *                  renderDecoy is pure per batch; no key, no trap data (M3)
 *   synthetic      seeded real products, users and cost sentinels never appear
 *                  in any answer, and a decoy reads no catalogue table
 *   not deceived   the owner (bell), a probe account and a crawler Cloudflare
 *                  verified get a plain 404 and no block
 *   linkable       a browser opening a decoy — however many — is never blocked
 *                  for it (fix round BLOCKER, M5): an attacker can post links
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
import { json } from './fixtures/app';
import { CLICKED, INDUCED, KEYED, OPENED, SCRIPT, TOOL, TYPED, blocks, deceptionEvents, deceptionWorld, ownerBells, setCookieValue } from './fixtures/deception';
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

test('each decoy answers 200 with fake data: its type and nothing a file would not carry, no script, ≤ 8 KB — and a tool\'s hit is an incident', async () => {
  for (const [path, code, type] of PATHS) {
    const w = await deceptionWorld();
    const res = await w.call(path, { headers: TOOL });
    const body = await res.text();
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type') ?? '', type, path);
    assert.equal(res.headers.get('cache-control'), null, `${path}: a decoy says no-store where a file would not`);
    assert.equal(res.headers.get('x-robots-tag'), null, path);
    assert.equal(setCookieValue(res, 'lv_pref'), null, `${path}: the deceiving answer carries no cookie (the block answer does)`);
    assert.ok(body.length > 10 && body.length <= 8192, `${path}: ${body.length} bytes`);
    assert.doesNotMatch(body, /<script/i, path);
    // The incident: the address is blocked for tools from the next request on.
    const rows = blocks(w.raw);
    assert.deepEqual(rows.map((b) => b.actor_kind), ['network'], path);
    assert.equal(rows[0]!.reason, 'decoy_hit', path);
    assert.equal(deceptionEvents(w.raw, 'DECOY_HIT').length, 1, path);
    const ev = JSON.parse(String(deceptionEvents(w.raw, 'DECOY_HIT')[0]!.detail));
    assert.equal(ev.decoy, code, path);
    // The incident's canary batch is recorded so a later use can be linked to it.
    assert.equal((w.raw.prepare('SELECT COUNT(*) AS n FROM security_canaries').get() as { n: number }).n, 1, path);
    assert.equal((await w.call('/api/products', { headers: TOOL })).status, 403, `${path}: the next request meets the block`);
  }
});

test('ONE ANSWER FOR EVERYONE: a tool, a browser, an image tag, a claimed crawler, a forged Sec-Fetch header and a staff account get the same answer', async () => {
  const shapes: Array<[string, Record<string, string>, 'full' | null]> = [
    ['tool', TOOL, null],
    ['typed', TYPED, null],
    ['image', INDUCED[0]!, null],
    ['claimed googlebot', { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' }, null],
    ['cross-site alone', { 'Sec-Fetch-Site': 'cross-site' }, null],
    ['unknown dest', { 'Sec-Fetch-Dest': 'x' }, null],
    ['staff', SCRIPT, 'full'],
  ];
  const seen: Array<{ who: string; status: number; headers: string; shape: string }> = [];
  for (const [who, headers, as] of shapes) {
    const w = await deceptionWorld();
    const res = await w.call('/.env', { headers, as });
    const body = await res.text();
    seen.push({
      who,
      status: res.status,
      headers: [...(res.headers as unknown as Iterable<[string, string]>)].map(([k]) => k).sort().join(','),
      shape: body
        .split('\n')
        .map((l) => l.replace(/=.*/, '='))
        .join('|'),
    });
  }
  for (const x of seen) {
    assert.equal(x.status, 200, x.who);
    assert.equal(x.headers, seen[0]!.headers, `${x.who}: the headers tell it apart`);
    assert.equal(x.shape, seen[0]!.shape, `${x.who}: the body tells it apart`);
  }
});

test('FORGED Sec-Fetch headers are a tool\'s: a lone or unknown header does not make a scanner an image tag (fix round B1)', async () => {
  const forged: Array<Record<string, string>> = [
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Dest': 'x' },
    { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'banana' },
    { ...INDUCED[0]!, 'Sec-Fetch-User': '?1' },
  ];
  for (const headers of forged) {
    const w = await deceptionWorld();
    assert.equal((await w.call('/.env', { headers })).status, 200);
    assert.deepEqual(
      blocks(w.raw).map((b) => b.actor_kind),
      ['network'],
      JSON.stringify(headers)
    );
  }
  // The real image tag: recorded, nothing written.
  const w = await deceptionWorld();
  assert.equal((await w.call('/.env', { headers: INDUCED[0]! })).status, 200);
  assert.equal(blocks(w.raw).length, 0);
  assert.equal(deceptionEvents(w.raw, 'DECOY_INDUCED').length, 1);
});

test('A PATH A REAL EXPOSED SERVER WOULD NOT HAVE answers 404 — git objects, unknown internal APIs — and a page past the first is empty (fix round m2)', async () => {
  const w = await deceptionWorld();
  const idx = await w.call('/.git/index', { headers: TYPED });
  assert.equal(idx.status, 404);
  assert.equal(await idx.text(), 'Not Found');
  const ref = await w.call('/.git/refs/heads/main', { headers: TYPED });
  assert.match(await ref.text(), /^[0-9a-f]{40}\n$/);
  const nope = await w.call('/api/v0/whatever/else', { headers: TYPED });
  assert.equal(nope.status, 404);
  assert.deepEqual(await json(nope), { success: false, error: 'Not found' });
  const users = await json(await w.call('/api/v0/users', { headers: TYPED }));
  assert.equal(users.users.length, 1);
  assert.match(users.users[0].email, /^ops\.[0-9a-f]{18}@/);
  const p2 = await json(await w.call('/api/internal/pricing/costs?page=2', { headers: TYPED }));
  assert.equal(p2.page, 2);
  assert.deepEqual(p2.products, []);
  const p1 = await json(await w.call('/api/internal/pricing/costs', { headers: TYPED }));
  assert.equal(p1.page, 1);
  assert.ok(p1.products.length >= 8);
  // A tool asking for a git object still asked for a trap: the 404 is its answer, the incident is still opened.
  const tool = await deceptionWorld();
  assert.equal((await tool.call('/.git/index', { headers: TOOL })).status, 404);
  assert.deepEqual(blocks(tool.raw).map((b) => b.actor_kind), ['network']);
  assert.equal((tool.raw.prepare('SELECT COUNT(*) AS n FROM security_canaries').get() as { n: number }).n, 0, 'no trap data was handed out');
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
  const found = await findCanaries(KEYED, [[a, 'body']]);
  assert.ok(found.length >= 2, JSON.stringify(found));
  assert.ok(found.every((f) => f.batch === found[0]!.batch));
  const other = await findCanaries(KEYED, [[b, 'body']]);
  assert.notEqual(other[0]!.batch, found[0]!.batch);
  // The SQL dump's product ids are product-shaped canaries.
  const w3 = await deceptionWorld();
  const sql = await (await w3.call('/backup.sql', { headers: TYPED })).text();
  const ids = [...sql.matchAll(/'(prd_[0-9a-f]{20})'/g)].map((m) => m[1]!);
  assert.ok(ids.length >= 8 && ids.length <= 15, `${ids.length} product rows`);
  const verified = await findCanaries(KEYED, ids.slice(0, 3).map((id) => [id, 'url'] as const));
  assert.ok(verified.every((f) => f.kind === 'p'));
  assert.equal(verified.length, 1, 'one batch, de-duplicated');
});

test('NOTHING VISIBLE TIES THE TOKENS OF ONE ANSWER TOGETHER: no shared substring, no counter in the product ids (fix round M3)', async () => {
  for (const batch of ['73a4471902', '0000000000', 'ffffffffff']) {
    const shape = batchShape(batch);
    const t = await mintBatch(KEYED, batch, 'levonis-iq.com', 16, shape.keyNoise);
    const parts = [t.apiKey.slice(9, 33), t.email.slice(4, 22), t.password.slice(3), t.dbPassword.slice(3), t.session.slice(4), ...t.productIds.map((p) => p.slice(4))];
    assert.ok(!parts.some((p) => p.includes(batch)), `${batch}: the batch is visible`);
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        for (let k = 0; k + 8 <= parts[i]!.length; k++) {
          assert.ok(!parts[j]!.includes(parts[i]!.slice(k, k + 8)), `${batch}: tokens ${i} and ${j} share ${parts[i]!.slice(k, k + 8)}`);
        }
      }
    }
    // Product ids: the shape of newId('prd'), no common prefix.
    for (const id of t.productIds) assert.match(id, /^prd_[0-9a-f]{20}$/);
    assert.ok(new Set(t.productIds.map((p) => p.slice(4, 8))).size >= 12, 'product ids share their leading hex');
  }
});

test('NO KEY, NO TRAP DATA: without a secret the decoy still answers its fake data, but nothing in it verifies and no tag is minted (fix round M3)', async () => {
  const w = await deceptionWorld({ env: { SECURITY_CANARY_KEY: undefined } });
  const res = await w.call('/config.json', { headers: TOOL });
  assert.equal(res.status, 200);
  const cfg = JSON.parse(await res.text()) as { api: { key: string } };
  assert.match(cfg.api.key, /^lvk_live_[0-9a-f]{32}$/);
  assert.deepEqual(await findCanaries({}, [[cfg.api.key, 'header']]), []);
  const use = await w.call('/api/products', { ip: '192.0.2.200', headers: { 'X-API-Key': cfg.api.key } });
  assert.equal(use.status, 200, 'an unkeyed token is no canary');
  // A key derived from one of the Worker's own secrets arms it.
  const derived = await deceptionWorld({ env: { SECURITY_CANARY_KEY: undefined, TELEGRAM_WEBHOOK_SECRET: 'a-webhook-secret' } });
  const cfg2 = JSON.parse(await (await derived.call('/config.json', { headers: TOOL })).text()) as { api: { key: string } };
  const blocked = await derived.call('/api/products', { ip: '192.0.2.201', headers: { 'X-API-Key': cfg2.api.key } });
  assert.equal(blocked.status, 403);
  assert.ok(setCookieValue(blocked, 'lv_pref'));
});


test('renderDecoy is pure per batch: the console regenerates exactly what was served', async () => {
  for (const code of DECOY_CODES) {
    const shape = batchShape('0a1b2c3d4e');
    const t1 = await mintBatch(KEYED, '0a1b2c3d4e', 'levonis-iq.com', shape.productCount, shape.keyNoise);
    const t2 = await mintBatch(KEYED, '0a1b2c3d4e', 'levonis-iq.com', shape.productCount, shape.keyNoise);
    const ctx = { host: 'levonis-iq.com', rootDomain: 'levonis-iq.com', method: 'GET', path: DECOYS[code].exact[0] ?? `${DECOYS[code].prefixes[0]}x` };
    assert.deepEqual(renderDecoy(code, t1, ctx), renderDecoy(code, t2, ctx), code);
  }
  const s1 = batchShape('0a1b2c3d4e');
  const other = await mintBatch(KEYED, '9f8e7d6c5b', 'levonis-iq.com', s1.productCount, s1.keyNoise);
  const mine = await mintBatch(KEYED, '0a1b2c3d4e', 'levonis-iq.com', s1.productCount, s1.keyNoise);
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

test('NOT DECEIVED: the owner, a probe account and a crawler Cloudflare verified get a plain 404 and no block', async () => {
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
  // A registered probe account: nothing at all.
  {
    const w = await deceptionWorld();
    const res = await w.call('/.env', { as: 'probe', headers: TYPED });
    assert.equal(res.status, 404);
    assert.equal(blocks(w.raw).length, 0);
    assert.equal(deceptionEvents(w.raw).length, 0);
  }
  // A crawler Cloudflare verified (Telegram fetches pasted links whatever robots.txt says).
  {
    const w = await deceptionWorld();
    const res = await w.call('/.git/config', { headers: { 'User-Agent': 'TelegramBot (like TwitterBot)' }, cf: { verifiedBotCategory: 'Page Preview' } });
    assert.equal(res.status, 404);
    assert.equal(blocks(w.raw).length, 0);
    assert.equal(JSON.parse(String(deceptionEvents(w.raw, 'DECOY_HIT')[0]!.detail)).ex, 'crawler');
    assert.equal(w.raw.prepare('SELECT COUNT(*) AS n FROM security_scores').get()!.n, 0);
  }
});

test('A CRAWLER BY CLAIM ONLY is deceived like anyone and recorded — never exempt, but it follows links, so one decoy does not block it (fix round M2)', async () => {
  for (const ua of ['TelegramBot (like TwitterBot)', 'Mozilla/5.0 (compatible; Googlebot/2.1)', 'WhatsApp/2.23', 'facebookexternalhit/1.1']) {
    const w = await deceptionWorld();
    const res = await w.call('/.git/config', { headers: { 'User-Agent': ua } });
    assert.equal(res.status, 200, ua);
    assert.match(await res.text(), /\[remote "origin"\]/, ua);
    assert.equal(blocks(w.raw).length, 0, ua);
    assert.equal(JSON.parse(String(deceptionEvents(w.raw, 'DECOY_HIT')[0]!.detail)).ex, 'crawler');
    assert.equal((w.raw.prepare('SELECT COUNT(*) AS n FROM security_canaries').get() as { n: number }).n, 1, `${ua}: its batch is recorded`);
    const sc = w.raw.prepare("SELECT score FROM security_scores WHERE actor_key LIKE 'n:%'").get() as { score: number };
    assert.ok(sc.score > 0 && sc.score < 100, `${ua}: ${sc.score}`);
  }
  // …and the claim buys nothing once it USES the trap data where no link puts it.
  const w = await deceptionWorld();
  const cfg = JSON.parse(await (await w.call('/config.json', { headers: { 'User-Agent': 'Googlebot/2.1' } })).text()) as { api: { key: string } };
  const use = await w.call('/api/products', { headers: { 'User-Agent': 'Googlebot/2.1', Authorization: `Bearer ${cfg.api.key}` } });
  assert.equal(use.status, 403);
  assert.ok(blocks(w.raw).some((b) => b.actor_kind === 'network'), 'a claimed crawler using trap data loses its address');
});

test('A STAFF ACCOUNT is deceived like anyone, its batch issued to it, the owner told — and using the trap data blocks it (fix round M8)', async () => {
  const w = await deceptionWorld();
  const res = await w.call('/config.json', { as: 'assistant', headers: TYPED });
  assert.equal(res.status, 200);
  const cfg = JSON.parse(await res.text()) as { api: { key: string } };
  assert.equal(blocks(w.raw).length, 0);
  assert.equal(JSON.parse(String(deceptionEvents(w.raw, 'DECOY_HIT')[0]!.detail)).ex, 'admin');
  const row = w.raw.prepare('SELECT issued_to FROM security_canaries').get() as { issued_to: string };
  assert.equal(JSON.parse(row.issued_to).u, 'usr_asst');
  const bells = ownerBells(w.raw);
  assert.equal(bells.length, 1);
  assert.equal(bells[0]!.title_en, 'A staff account opened a decoy file');
  // A stolen staff session using the key it was handed: blocked like anyone (a confirmed canary).
  const use = await w.call('/api/admin/users', { as: 'assistant', headers: { 'X-API-Key': cfg.api.key } });
  assert.equal(use.status, 403);
  assert.ok(blocks(w.raw).some((b) => b.actor_kind === 'account' && b.actor_key === 'usr_asst' && b.actor_class === 'assistant_admin'));
});

test('AN INDUCED REQUEST — an image, a cross-site fetch, a navigation without a click, a frame — is recorded only, and its viewer is never blocked', async () => {
  for (const headers of INDUCED) {
    for (const as of [null, 'customer'] as const) {
      const w = await deceptionWorld();
      const res = await w.call('/.env', { headers, as });
      assert.equal(res.status, 200, JSON.stringify(headers));
      assert.equal(blocks(w.raw).length, 0, JSON.stringify(headers));
      assert.equal(deceptionEvents(w.raw, 'DECOY_INDUCED').length, 1);
      const next = await w.call('/api/products', { as, headers: SCRIPT });
      assert.equal(next.status, 200, 'an <img src="/.env"> in a post never blocks the viewer');
    }
  }
});

test('LINKS NEVER BLOCK: a customer opening planted decoy links — clicked, typed, opened from another app — is never blocked for it; using the trap data is (fix round BLOCKER, M5)', async () => {
  const w = await deceptionWorld();
  const a = await w.call('/admin/export/costs.csv', { as: 'customer', headers: CLICKED });
  assert.equal(a.status, 200);
  assert.equal(setCookieValue(a, 'lv_pref'), null);
  for (const [path, headers] of [
    ['/wp-admin/', CLICKED],
    ['/.env', TYPED],
    ['/backup.sql', TYPED],
    ['/config.json', OPENED],
  ] as const) {
    assert.equal((await w.call(path, { as: 'customer', headers })).status, 200, path);
  }
  assert.equal(blocks(w.raw).length, 0, 'five decoy links opened, nobody blocked');
  const sc = (w.raw.prepare("SELECT score FROM security_scores WHERE actor_key = 'u:usr_cust'").get() as { score: number }).score;
  assert.equal(sc, 99, 'linkable evidence stops just short of the threshold');
  assert.equal((await w.call('/api/products', { as: 'customer', headers: SCRIPT })).status, 200);
  // The trap data he was handed, used where no link puts it (the sign-in form): blocked at once.
  const cfg = JSON.parse(await (await w.call('/config.json', { as: 'customer', headers: TYPED })).text()) as { admin: { email: string; password: string } };
  const login = await w.call('/api/auth/login', { as: 'customer', headers: SCRIPT, body: { identifier: cfg.admin.email, password: cfg.admin.password } });
  assert.equal(login.status, 403);
  assert.equal((await json(login)).code, 'ACCESS_BLOCKED');
  assert.ok(blocks(w.raw).some((b) => b.actor_kind === 'account' && b.actor_key === 'usr_cust'));
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
