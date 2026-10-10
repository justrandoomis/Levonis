/**
 * DECEIVE, THEN BLOCK — the gate (worker/lib/deception/gate.ts) and the block
 * store (blocks.ts) through the REAL Worker. DECISIONS row 206.
 *
 *   deceive then block   the decoy hit itself gets the fake data and a device
 *                        tag; from the NEXT request: 403 ACCESS_BLOCKED with a
 *                        reference and the three languages, the block page for
 *                        a document — never the reason, the expiry or the kind
 *   who is blocked       the tag; the account (30 days, from a fresh browser
 *                        too); the network for an ANONYMOUS request only — a
 *                        signed-in neighbour on the same CGNAT address passes,
 *                        and a network block expires
 *   always reachable     sign-in under a device or network block; the owner on
 *                        a tagged device; the static paths and /api/health
 *   the tag              forged, expired or lifted tags block nothing; a lifted
 *                        tag's cookie is deleted
 *   speed                with a warm snapshot an ordinary request issues no
 *                        statement of this layer; a cold one without a tag
 *                        waits for nothing; static paths are never checked
 *   deploy ahead         a database without 0185: no 500, the decoys answer,
 *                        the stateless tag blocks, account and network blocks
 *                        are off
 *   the owner            the table refuses an owner block row
 *
 * Local only. Run: node --import tsx --test tests/deceptionBlocking.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, json } from './fixtures/app';
import { ATTACKER_IP, OTHER_IP, SCRIPT, TYPED, blocks, deceptionWorld, setCookieValue, type World } from './fixtures/deception';
import { mintTag } from '../worker/lib/deception/actors';
import { snapshotFor } from '../worker/lib/deception/blocks';

/** The attacker's first request: a decoy, deliberately (a tool, no Sec-Fetch headers). */
async function hit(w: World, opts: { as?: 'customer' | null; ip?: string } = {}) {
  const res = await w.call('/.env', { as: opts.as ?? null, ip: opts.ip ?? ATTACKER_IP });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /LEVONIS_API_KEY=lvk_live_/);
  const tag = setCookieValue(res, 'lv_pref');
  assert.ok(tag, 'the deceiving answer carries the device tag');
  return tag!;
}

function counting(w: World) {
  const seen: string[] = [];
  const db = w.env.DB as D1Database;
  w.env.DB = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') return (sql: string) => (seen.push(sql), (target as D1Database).prepare(sql));
      if (prop === 'batch') return (stmts: D1PreparedStatement[]) => (seen.push('BATCH'), (target as D1Database).batch(stmts));
      return Reflect.get(target, prop, receiver);
    },
  });
  return seen;
}

test('DECEIVE, THEN BLOCK: fake data on the decoy, then ACCESS_BLOCKED with a reference in three languages — and nothing about why', async () => {
  const w = await deceptionWorld();
  const tag = await hit(w);
  const res = await w.call('/api/products', { cookies: { lv_pref: tag }, headers: SCRIPT });
  assert.equal(res.status, 403);
  assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  const body = await json(res);
  assert.equal(body.code, 'ACCESS_BLOCKED');
  assert.match(body.details.reference, /^LV-[0-9A-Z]{8}$/);
  assert.match(body.details.message.ar, /تم رصد نشاط مشبوه وحظر هذا الوصول/);
  assert.match(body.details.message.en, /Suspicious activity was detected/);
  assert.match(body.details.message.ckb, /چالاکییەکی گوماناوی/);
  assert.notEqual(body.details.message.ckb, body.details.message.ar);
  const text = JSON.stringify(body);
  for (const secret of ['decoy', 'score', 'expires', 'network', 'device', 'account', '.env', 'lvk_live_']) assert.ok(!text.includes(secret), `the block answer says ${secret}`);
  // The same reference on every block row of the incident.
  const refs = new Set(blocks(w.raw).map((b) => b.reference));
  assert.deepEqual([...refs], [body.details.reference]);
  // A document gets the block page: 403, the reference, no script, its own policy.
  const doc = await w.call('/', { cookies: { lv_pref: tag }, headers: TYPED });
  assert.equal(doc.status, 403);
  assert.match(doc.headers.get('content-type') ?? '', /text\/html/);
  const html = await doc.text();
  assert.match(html, new RegExp(body.details.reference));
  assert.match(html, /تم رصد نشاط مشبوه وحظر هذا الوصول/);
  assert.match(html, /ئەم دەستگەیشتنە قەدەغە کرا/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(doc.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  // Another decoy answers the block page now, not more fake data.
  const again = await w.call('/backup.sql', { cookies: { lv_pref: tag } });
  assert.equal(again.status, 403);
});

test('NETWORK: the same address without the tag is blocked when anonymous; a signed-in neighbour with a clean account is not; the block expires', async () => {
  const w = await deceptionWorld();
  await hit(w);
  const anon = await w.call('/api/products', { ip: ATTACKER_IP, headers: SCRIPT });
  assert.equal(anon.status, 403, 'a fresh browser on the attacker\'s address');
  const neighbour = await w.call('/api/products', { as: 'neighbour', ip: ATTACKER_IP, headers: SCRIPT });
  assert.equal(neighbour.status, 200, 'a customer on the same CGNAT address, signed in, is never blocked by the network');
  const neighbourCart = await w.call('/api/cart', { as: 'neighbour', ip: ATTACKER_IP, headers: SCRIPT });
  assert.equal(neighbourCart.status, 200);
  const elsewhere = await w.call('/api/products', { ip: OTHER_IP, headers: SCRIPT });
  assert.equal(elsewhere.status, 200);
  // A bogus session cookie does not dodge it where the session is read.
  const bogus = await w.call('/api/cart', { ip: ATTACKER_IP, cookies: { levonis_session: 'nope' }, headers: SCRIPT });
  assert.equal(bogus.status, 403);
  // Network blocks are 24 hours, never longer; a /24 is never the key.
  const net = blocks(w.raw).find((b) => b.actor_kind === 'network')!;
  const hours = (Date.parse(String(net.expires_at)) - Date.parse(String(net.created_at))) / 3_600_000;
  assert.ok(hours > 23.9 && hours <= 24.01, `${hours} hours`);
  assert.match(String(net.actor_key), /^[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(blocks(w.raw)).includes(ATTACKER_IP), 'no address is stored');
  // Another isolate (a fresh snapshot of the same database), once warm, honours the block it reads…
  w.env.DB = asD1(w.raw);
  await w.call('/api/products', { ip: OTHER_IP, headers: SCRIPT });
  assert.equal(snapshotFor(w.env.DB)?.status, 'ready');
  assert.equal((await w.call('/api/products', { ip: ATTACKER_IP, headers: SCRIPT })).status, 403, 'a new isolate reads the block');
  // …and once it has expired, lets the address through.
  w.raw.exec(`UPDATE security_blocks SET created_at = '2026-01-01T00:00:00.000Z', expires_at = '2026-01-02T00:00:00.000Z', updated_at = '2026-01-02T00:00:00.000Z' WHERE actor_kind = 'network'`);
  w.env.DB = asD1(w.raw);
  await w.call('/api/products', { ip: OTHER_IP, headers: SCRIPT });
  assert.equal(snapshotFor(w.env.DB)?.status, 'ready');
  const later = await w.call('/api/products', { ip: ATTACKER_IP, headers: SCRIPT });
  assert.equal(later.status, 200, 'an expired network block blocks nobody');
});

test('ACCOUNT: a signed-in customer\'s decoy hit blocks the account and the device for 30 days — the account from a fresh browser too; no network block', async () => {
  const w = await deceptionWorld();
  const tag = await hit(w, { as: 'customer' });
  const kinds = blocks(w.raw).map((b) => b.actor_kind).sort();
  assert.deepEqual(kinds, ['account', 'device']);
  for (const b of blocks(w.raw)) {
    const days = (Date.parse(String(b.expires_at)) - Date.parse(String(b.created_at))) / 86_400_000;
    assert.ok(days > 29.9 && days < 30.1, `${b.actor_kind}: ${days} days`);
    assert.equal(b.actor_class, 'customer');
  }
  assert.equal((await w.call('/api/cart', { as: 'customer', cookies: { lv_pref: tag }, headers: SCRIPT })).status, 403);
  // A fresh browser, another address, same account: blocked — and that browser is tagged too.
  const fresh = await w.call('/api/cart', { as: 'customer', ip: OTHER_IP, headers: SCRIPT });
  assert.equal(fresh.status, 403);
  const newTag = setCookieValue(fresh, 'lv_pref');
  assert.ok(newTag, 'the account-blocked answer tags the new browser');
  assert.equal((await w.call('/api/products', { ip: OTHER_IP, cookies: { lv_pref: newTag! }, headers: SCRIPT })).status, 403, 'signing out does not undo it');
  // Logging out stays reachable.
  assert.notEqual((await w.call('/api/auth/logout', { as: 'customer', method: 'POST', body: {}, ip: OTHER_IP, headers: SCRIPT })).status, 403);
  // Another customer on the attacker's address is untouched (no network block for a signed-in hit).
  assert.equal((await w.call('/api/products', { ip: ATTACKER_IP, headers: SCRIPT })).status, 200);
});

test('ALWAYS REACHABLE: sign-in under a device and a network block; the owner on a tagged device; a non-owner on it stays blocked', async () => {
  const w = await deceptionWorld();
  const tag = await hit(w);
  const login = await w.call('/api/auth/login', { body: { identifier: 'nb@x.co', password: 'wrong-password' }, cookies: { lv_pref: tag }, headers: SCRIPT });
  assert.notEqual(login.status, 403, 'the sign-in door answers for itself');
  assert.notEqual((await json(login)).code, 'ACCESS_BLOCKED');
  assert.equal((await w.call('/api/settings/public', { cookies: { lv_pref: tag } })).status, 200);
  assert.equal((await w.call('/api/auth/me', { cookies: { lv_pref: tag } })).status, 200);
  // The owner signs in on the tagged device: never blocked, on session-loaded and session-free paths alike.
  assert.equal((await w.call('/api/admin/security/summary', { as: 'owner', cookies: { lv_pref: tag }, headers: SCRIPT })).status, 200);
  assert.equal((await w.call('/api/products', { as: 'owner', cookies: { lv_pref: tag }, headers: SCRIPT })).status, 200);
  assert.equal((await w.call('/api/storefront/resolve', { as: 'owner', cookies: { lv_pref: tag }, headers: SCRIPT })).status, 200);
  assert.equal((await w.call('/', { as: 'owner', cookies: { lv_pref: tag }, headers: TYPED })).status, 200);
  // A non-owner who signs in on that device stays blocked.
  assert.equal((await w.call('/api/cart', { as: 'neighbour', cookies: { lv_pref: tag }, headers: SCRIPT })).status, 403);
  assert.equal((await w.call('/api/storefront/resolve', { as: 'neighbour', cookies: { lv_pref: tag }, headers: SCRIPT })).status, 403);
});

test('STATIC AND MACHINE PATHS are never checked: health, robots, sitemap, manifest, store icons, files', async () => {
  const w = await deceptionWorld();
  const tag = await hit(w);
  const seen = counting(w);
  for (const path of ['/api/health', '/robots.txt', '/sitemap.xml', '/manifest.webmanifest', '/store-icon/favicon-32.png']) {
    const res = await w.call(path, { cookies: { lv_pref: tag } });
    assert.notEqual(res.status, 403, path);
  }
  const files = await w.call('/files/public/x.webp', { cookies: { lv_pref: tag } });
  assert.notEqual((await files.text()).includes('ACCESS_BLOCKED'), true);
  assert.ok(!seen.some((sql) => /security_/.test(sql)), 'no statement of the deception layer on a static path');
});

test('THE TAG: a forged, an expired, a malformed and a lifted tag block nothing; the lifted one is deleted', async () => {
  const w = await deceptionWorld();
  const real = await hit(w, { ip: '192.0.2.50' });
  const [id, exp36] = real.split('.');
  const forged = `${id}.${exp36}.0123456789abcdef`;
  for (const cookie of [forged, 'nonsense', `${id}.${exp36}`]) {
    assert.equal((await w.call('/api/products', { ip: OTHER_IP, cookies: { lv_pref: cookie } })).status, 200, cookie);
  }
  const expired = await mintTag({}, 'aaaaaaaaaa', Date.now() - 31 * 86_400_000);
  assert.equal((await w.call('/api/products', { ip: OTHER_IP, cookies: { lv_pref: expired.value } })).status, 200, 'expired');
  // A different key: the tag minted under the pepper is no tag on a Worker with its own secret.
  const keyed = await deceptionWorld({ env: { SECURITY_CANARY_KEY: 'a-real-secret' } });
  assert.equal((await keyed.call('/api/products', { ip: OTHER_IP, cookies: { lv_pref: real } })).status, 200);
  // Lifted (by the owner, from another isolate): passes, and the cookie goes.
  assert.equal((await w.call('/api/products', { ip: OTHER_IP, cookies: { lv_pref: real } })).status, 403);
  w.raw.exec(`UPDATE security_blocks SET lifted_at = '${new Date().toISOString()}', lifted_by = 'usr_owner', updated_at = '${new Date().toISOString()}' WHERE actor_kind = 'device'`);
  w.env.DB = asD1(w.raw);
  const after = await w.call('/api/products', { ip: OTHER_IP, cookies: { lv_pref: real } });
  assert.equal(after.status, 200);
  assert.equal(setCookieValue(after, 'lv_pref'), '', 'the lifted tag is deleted');
});

test('SPEED: with a warm snapshot an ordinary request issues no statement of this layer; cold without a tag, nothing waits', async () => {
  const w = await deceptionWorld();
  // Cold, no execution context, no tag: nothing of this layer runs at all.
  const coldSeen = counting(w);
  assert.equal((await w.call('/api/products', { ip: OTHER_IP, withCtx: false, headers: SCRIPT })).status, 200);
  assert.ok(!coldSeen.some((sql) => /security_/.test(sql)), coldSeen.filter((s) => /security_/.test(s)).join('\n'));
  // Warm the snapshot (the background load the first request with a context starts).
  await w.call('/api/products', { ip: OTHER_IP, headers: SCRIPT });
  assert.equal(snapshotFor(w.env.DB)?.status, 'ready');
  const before = coldSeen.length;
  await w.call('/api/products', { ip: OTHER_IP, headers: SCRIPT });
  await w.call('/', { ip: OTHER_IP, headers: TYPED });
  const added = coldSeen.slice(before).filter((sql) => /security_|lv-/.test(sql));
  assert.deepEqual(added, [], 'no D1 statement of the deception layer on an ordinary request');
});

test('HITS: blocked requests are counted against their block, flushed after the answer', async () => {
  const w = await deceptionWorld();
  await hit(w);
  for (let i = 0; i < 3; i++) await w.call('/api/products', { ip: ATTACKER_IP, headers: SCRIPT });
  const net = blocks(w.raw).find((b) => b.actor_kind === 'network')!;
  assert.ok(Number(net.hits) >= 1);
  assert.ok(net.last_hit_at);
});

test('DEPLOY AHEAD (a database without 0185): no 500, the decoy still deceives, the stateless tag blocks, account and network blocks are off', async () => {
  const w = await deceptionWorld({ through: '0183' });
  const res = await w.call('/.env', { as: 'customer' });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /LEVONIS_API_KEY/);
  const tag = setCookieValue(res, 'lv_pref');
  assert.ok(tag);
  assert.equal((await w.call('/api/products', { cookies: { lv_pref: tag! }, ip: OTHER_IP })).status, 403, 'the tag needs no table');
  assert.equal((await w.call('/api/cart', { as: 'customer', ip: OTHER_IP })).status, 200, 'no account block without the table');
  const anon = await deceptionWorld({ through: '0183' });
  await anon.call('/.env');
  assert.equal((await anon.call('/api/products')).status, 200, 'no network block without the table');
  for (const path of ['/api/admin/security/summary', '/api/admin/security/blocks', '/api/admin/security/scores']) {
    const r = await w.call(path, { as: 'owner' });
    assert.equal(r.status, 200, path);
  }
  // Price fields and signals: scored nowhere, and still never a 500.
  const priced = await w.call('/api/cart/items', { as: 'neighbour', body: { productId: 'prd_x', qty: 1, unit_price_iqd: 1 } });
  assert.ok(priced.status < 500, String(priced.status));
});

test('THE OWNER IS NEVER BLOCKED: the table refuses an owner block row', async () => {
  const w = await deceptionWorld();
  assert.throws(() =>
    w.raw.exec(
      `INSERT INTO security_blocks (id, incident_id, reference, actor_kind, actor_key, actor_class, reason, expires_at)
       VALUES ('sbk_x', 'sin_xxxxxxxx', 'LV-AAAAAAAA', 'account', 'usr_owner', 'owner', 'decoy_hit', '2099-01-01T00:00:00.000Z')`
    )
  );
  // A score crossing by the owner opens nothing: the owner is never scored.
  for (let i = 0; i < 6; i++) await w.call('/api/cart/items', { as: 'owner', body: { productId: 'prd_x', qty: 1, unit_price_iqd: 1 } });
  assert.equal(blocks(w.raw).length, 0);
  assert.equal((w.raw.prepare("SELECT COUNT(*) AS n FROM security_scores WHERE actor_key = 'u:usr_owner'").get() as { n: number }).n, 0);
});
