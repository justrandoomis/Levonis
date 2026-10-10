/**
 * DECEIVE, THEN BLOCK — the gate (worker/lib/deception/gate.ts) and the block
 * store (blocks.ts) through the REAL Worker. DECISIONS row 206 and its fix
 * round.
 *
 *   deceive then block   a tool's decoy hit gets the fake data and nothing
 *                        else; from its NEXT request: 403 ACCESS_BLOCKED with a
 *                        reference and the three languages, the block page for
 *                        a document — never the reason, the expiry or the kind
 *   who is blocked       the tag (set on a BLOCK answer); the account (30 days,
 *                        from a fresh browser too, which is tagged); the
 *                        network for TOOLS only — every browser behind a
 *                        carrier's shared address passes, a signed-in tool
 *                        passes unless its account was made after the block
 *                        (signing up does not escape it), a session cookie no
 *                        session backs is no account; a network block expires
 *   always reachable     /api/auth/* under every block — signing in, proving an
 *                        address (the unverified owner's way back), signing
 *                        out; the owner on a tagged device; the static paths
 *   the tag              forged, expired or lifted tags block nothing; lifting
 *                        an account lifts the tags its block answers minted
 *   budgets              the block rows anonymous incidents may fill leave
 *                        room for canary uses and accounts; an IPv6 /48
 *                        rotating its /64s ends up blocked as a whole
 *   speed, deploy ahead  no statement on an ordinary request; a database
 *                        without 0185 is never a 500
 *   the owner            the table refuses an owner block row
 *
 * Local only. Run: node --import tsx --test tests/deceptionBlocking.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, json } from './fixtures/app';
import { ATTACKER_IP, KEYED, OTHER_IP, SCRIPT, TOOL, TYPED, blocks, deceptionWorld, setCookieValue, type World } from './fixtures/deception';
import { keyForNet, mintTag, networkKeyFor } from '../worker/lib/deception/actors';
import { DECOY_ROW_CAP, PREFIX_INCIDENT_BUDGET, snapshotFor } from '../worker/lib/deception/blocks';
import { sha256Hex } from '../worker/lib/crypto';
import { baghdadDay } from '../worker/lib/baghdadTime';

/** The attacker's first request: a decoy, from a tool (no Sec-Fetch headers). The answer carries the fake data and no cookie. */
async function hit(w: World, opts: { as?: 'customer' | null; ip?: string } = {}) {
  const res = await w.call('/.env', { as: opts.as ?? null, ip: opts.ip ?? ATTACKER_IP, headers: TOOL });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /LEVONIS_API_KEY=lvk_live_/);
  assert.equal(setCookieValue(res, 'lv_pref'), null, 'the deceiving answer carries no tag');
}

/** A browser that used trap data where no link puts it: its block answer carries the device tag. */
async function tagged(w: World, ip = ATTACKER_IP): Promise<string> {
  const cfg = JSON.parse(await (await w.call('/config.json', { ip: '192.0.2.9', headers: TYPED })).text()) as { api: { key: string } };
  const res = await w.call('/api/products', { ip, headers: { ...SCRIPT, 'X-API-Key': cfg.api.key } });
  assert.equal(res.status, 403);
  const tag = setCookieValue(res, 'lv_pref');
  assert.ok(tag, 'the block answer carries the device tag');
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
  await hit(w);
  const res = await w.call('/api/products', { headers: TOOL });
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
  const refs = new Set(blocks(w.raw).map((b) => b.reference));
  assert.deepEqual([...refs], [body.details.reference]);
  // A document gets the block page: 403, the reference, no script, its own policy.
  const doc = await w.call('/', { headers: TOOL });
  assert.equal(doc.status, 403);
  assert.match(doc.headers.get('content-type') ?? '', /text\/html/);
  const html = await doc.text();
  assert.match(html, new RegExp(body.details.reference));
  assert.match(html, /تم رصد نشاط مشبوه وحظر هذا الوصول/);
  assert.match(html, /ئەم دەستگەیشتنە قەدەغە کرا/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(doc.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  // Another decoy answers the block now, not more fake data.
  assert.equal((await w.call('/backup.sql', { headers: TOOL })).status, 403);
});

test('A CARRIER\'S SHARED ADDRESS: one subscriber\'s scan blocks tools on it, never the browsers behind it (fix round CGNAT)', async () => {
  const w = await deceptionWorld();
  const CGNAT = '100.64.10.20';
  await w.call('/.env', { ip: CGNAT, headers: TOOL });
  for (const [path, headers] of [['/', TYPED], ['/products', TYPED], ['/api/storefront/resolve', SCRIPT], ['/api/home', SCRIPT], ['/api/products', SCRIPT]] as const) {
    assert.notEqual((await w.call(path, { ip: CGNAT, headers })).status, 403, `${path}: a signed-out shopper behind the same address`);
  }
  assert.equal((await w.call('/api/products', { ip: CGNAT, headers: TOOL })).status, 403, 'the scanner itself');
  assert.equal(blocks(w.raw).filter((b) => b.actor_kind === 'device').length, 0, 'nobody behind the address is tagged');
});

test('NETWORK: a tool on the address is blocked; a signed-in tool with an older account passes; a cookie no session backs is no account; the block expires', async () => {
  const w = await deceptionWorld();
  await hit(w);
  assert.equal((await w.call('/api/products', { ip: ATTACKER_IP, headers: TOOL })).status, 403, 'a tool without a cookie');
  assert.equal((await w.call('/api/cart', { as: 'neighbour', ip: ATTACKER_IP, headers: TOOL })).status, 200, 'an account made before the block');
  assert.equal((await w.call('/api/products', { as: 'neighbour', ip: ATTACKER_IP, headers: TOOL })).status, 200, 'the same, on a session-free path');
  assert.equal((await w.call('/api/products', { ip: OTHER_IP, headers: TOOL })).status, 200);
  // A session cookie no session backs does not dodge it — where the session is read, and where it is not (fix round M1).
  for (const path of ['/api/cart', '/api/products', '/api/storefront/abc', '/api/home']) {
    assert.equal((await w.call(path, { ip: ATTACKER_IP, cookies: { levonis_session: 'garbage' }, headers: TOOL })).status, 403, path);
  }
  // Network blocks are 24 hours, never longer; the key is keyed (no address can be enumerated back from it).
  const net = blocks(w.raw).find((b) => b.actor_kind === 'network')!;
  const hours = (Date.parse(String(net.expires_at)) - Date.parse(String(net.created_at))) / 3_600_000;
  assert.ok(hours > 23.9 && hours <= 24.01, `${hours} hours`);
  assert.equal(net.actor_key, await networkKeyFor(KEYED, ATTACKER_IP, Date.now()));
  const plain = (await sha256Hex(`lv-net|${ATTACKER_IP}|${baghdadDay(Date.now())}`)).slice(0, 32);
  assert.notEqual(net.actor_key, plain, 'an unkeyed hash of the address (fix round m4)');
  assert.notEqual(await keyForNet({ SECURITY_CANARY_KEY: 'another' }, ATTACKER_IP, Date.now()), net.actor_key);
  assert.ok(!JSON.stringify(blocks(w.raw)).includes(ATTACKER_IP), 'no address is stored');
  // Another isolate (a fresh snapshot of the same database), once warm, honours the block it reads…
  w.env.DB = asD1(w.raw);
  await w.call('/api/cart', { as: 'customer', ip: OTHER_IP, headers: SCRIPT });
  assert.equal(snapshotFor(w.env.DB)?.status, 'ready');
  assert.equal((await w.call('/api/products', { ip: ATTACKER_IP, headers: TOOL })).status, 403, 'a new isolate reads the block');
  // …and once it has expired, lets the address through.
  w.raw.exec(`UPDATE security_blocks SET created_at = '2026-01-01T00:00:00.000Z', expires_at = '2026-01-02T00:00:00.000Z', updated_at = '2026-01-02T00:00:00.000Z' WHERE actor_kind = 'network'`);
  w.env.DB = asD1(w.raw);
  await w.call('/api/cart', { as: 'customer', ip: OTHER_IP, headers: SCRIPT });
  assert.equal(snapshotFor(w.env.DB)?.status, 'ready');
  assert.equal((await w.call('/api/products', { ip: ATTACKER_IP, headers: TOOL })).status, 200, 'an expired network block blocks nobody');
});

test('SIGNING UP DOES NOT ESCAPE A NETWORK BLOCK: an account made from the blocked address after the block is the address\'s (fix round M7)', async () => {
  const w = await deceptionWorld();
  await hit(w);
  const reg = await w.call('/api/auth/register', { ip: ATTACKER_IP, headers: TOOL, body: { email: 'new1@x.co', password: 'Passw0rd!xyz9', name: 'New One', username: 'newone1' } });
  assert.notEqual(reg.status, 403, 'the sign-in doors stay open');
  const session = setCookieValue(reg, 'levonis_session');
  assert.ok(session, `registered: ${reg.status} ${await reg.clone().text()}`);
  for (const path of ['/api/cart', '/api/products', '/api/orders']) {
    assert.equal((await w.call(path, { ip: ATTACKER_IP, cookies: { levonis_session: session! }, headers: TOOL })).status, 403, path);
  }
  // The account made before the block, from the same address: untouched.
  assert.equal((await w.call('/api/cart', { as: 'neighbour', ip: ATTACKER_IP, headers: TOOL })).status, 200);
});

test('ACCOUNT: a signed-in customer\'s decoy hit blocks the account for 30 days — from a fresh browser too, which is tagged; no network block', async () => {
  const w = await deceptionWorld();
  await hit(w, { as: 'customer' });
  const rows = blocks(w.raw);
  assert.deepEqual(rows.map((b) => b.actor_kind), ['account']);
  const days = (Date.parse(String(rows[0]!.expires_at)) - Date.parse(String(rows[0]!.created_at))) / 86_400_000;
  assert.ok(days > 29.9 && days < 30.1, `${days} days`);
  assert.equal(rows[0]!.actor_class, 'customer');
  // A fresh browser, another address, same account: blocked — and that browser is tagged, never past the account's own end.
  const fresh = await w.call('/api/cart', { as: 'customer', ip: OTHER_IP, headers: SCRIPT });
  assert.equal(fresh.status, 403);
  const newTag = setCookieValue(fresh, 'lv_pref');
  assert.ok(newTag, 'the account-blocked answer tags the new browser');
  const exp = parseInt(newTag!.split('.')[1]!, 36) * 1000;
  assert.ok(Math.abs(exp - Date.parse(String(rows[0]!.expires_at))) < 2000, 'the tag ends with the account block');
  assert.equal((await w.call('/api/products', { ip: OTHER_IP, cookies: { lv_pref: newTag! }, headers: SCRIPT })).status, 403, 'signing out does not undo it');
  // The way out stays open: signing out, the session check, proving the address (fix round BLOCKER amplifier).
  assert.notEqual((await w.call('/api/auth/logout', { as: 'customer', method: 'POST', body: {}, ip: OTHER_IP, headers: SCRIPT })).status, 403);
  for (const path of ['/api/auth/me', '/api/auth/verify-email/status']) {
    assert.notEqual((await w.call(path, { as: 'customer', ip: OTHER_IP, headers: SCRIPT })).status, 403, path);
  }
  // Another customer on the attacker's address is untouched (no network block for a signed-in hit).
  assert.equal((await w.call('/api/products', { ip: ATTACKER_IP, headers: TOOL })).status, 200);
});

test('THE UNVERIFIED OWNER, blocked by her own test with trap data, gets back in by proving her address (fix round MAJOR owner)', async () => {
  const w = await deceptionWorld();
  w.raw.exec("UPDATE users SET email_verified_at = NULL WHERE id = 'usr_owner'");
  const cfg = JSON.parse(await (await w.call('/config.json', { ip: '192.0.2.9', headers: TOOL })).text()) as { api: { key: string } };
  const used = await w.call('/api/products', { as: 'owner', ip: OTHER_IP, headers: { ...SCRIPT, 'X-API-Key': cfg.api.key } });
  assert.equal(used.status, 403, 'an unproven owner address is an admin here: a confirmed canary blocks it');
  // Blocked — but the e-mail proof stays reachable.
  for (const path of ['/api/auth/verify-email/status', '/api/auth/me']) {
    assert.notEqual((await w.call(path, { as: 'owner', ip: OTHER_IP, headers: SCRIPT })).status, 403, path);
  }
  // The address proven: the owner is never blocked, and the console is hers.
  w.raw.exec("UPDATE users SET email_verified_at = '2026-10-10T00:00:00.000Z' WHERE id = 'usr_owner'");
  assert.equal((await w.call('/api/admin/security/summary', { as: 'owner', ip: OTHER_IP, headers: SCRIPT })).status, 200);
  assert.equal((await w.call('/api/products', { as: 'owner', ip: OTHER_IP, headers: SCRIPT })).status, 200);
});

test('ALWAYS REACHABLE: sign-in under a device and a network block; the owner on a tagged device; a non-owner on it stays blocked', async () => {
  const w = await deceptionWorld();
  const tag = await tagged(w);
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
  const tag = await tagged(w);
  const seen = counting(w);
  for (const path of ['/api/health', '/robots.txt', '/sitemap.xml', '/manifest.webmanifest', '/store-icon/favicon-32.png']) {
    const res = await w.call(path, { cookies: { lv_pref: tag } });
    assert.notEqual(res.status, 403, path);
  }
  const files = await w.call('/files/public/x.webp', { cookies: { lv_pref: tag } });
  assert.notEqual((await files.text()).includes('ACCESS_BLOCKED'), true);
  assert.ok(!seen.some((sql) => /security_/.test(sql)), 'no statement of the deception layer on a static path');
});

test('THE TAG: a forged, an expired, a malformed and a lifted tag block nothing; lifting the account lifts the tags of its block answers', async () => {
  const w = await deceptionWorld();
  const real = await tagged(w, '192.0.2.50');
  const [id, exp36] = real.split('.');
  const forged = `${id}.${exp36}.0123456789abcdef`;
  for (const cookie of [forged, 'nonsense', `${id}.${exp36}`]) {
    assert.equal((await w.call('/api/products', { ip: OTHER_IP, cookies: { lv_pref: cookie }, headers: SCRIPT })).status, 200, cookie);
  }
  const expired = (await mintTag(KEYED, 'aaaaaaaaaa', Date.now() - 31 * 86_400_000))!;
  assert.equal((await w.call('/api/products', { ip: OTHER_IP, cookies: { lv_pref: expired.value }, headers: SCRIPT })).status, 200, 'expired');
  assert.equal(await mintTag({}, 'aaaaaaaaaa', Date.now()), null, 'no key, no tag');
  // A different key: the tag is no tag on a Worker with another secret.
  const keyed = await deceptionWorld({ env: { SECURITY_CANARY_KEY: 'a-real-secret' } });
  assert.equal((await keyed.call('/api/products', { ip: OTHER_IP, cookies: { lv_pref: real }, headers: SCRIPT })).status, 200);
  // Lifted (by the owner, from another isolate): passes, and the cookie goes.
  assert.equal((await w.call('/api/products', { ip: OTHER_IP, cookies: { lv_pref: real }, headers: SCRIPT })).status, 403);
  w.raw.exec(`UPDATE security_blocks SET lifted_at = '${new Date().toISOString()}', lifted_by = 'usr_owner', updated_at = '${new Date().toISOString()}' WHERE actor_kind = 'device'`);
  w.env.DB = asD1(w.raw);
  const after = await w.call('/api/products', { ip: OTHER_IP, cookies: { lv_pref: real }, headers: SCRIPT });
  assert.equal(after.status, 200);
  assert.equal(setCookieValue(after, 'lv_pref'), '', 'the lifted tag is deleted');
  // An account-blocked answer's tag has no row of its own: lifting the account (in another isolate) lifts it.
  const w2 = await deceptionWorld();
  await hit(w2, { as: 'customer' });
  const t2 = setCookieValue(await w2.call('/api/cart', { as: 'customer', ip: OTHER_IP, headers: SCRIPT }), 'lv_pref')!;
  assert.equal((await w2.call('/api/products', { ip: OTHER_IP, cookies: { lv_pref: t2 }, headers: SCRIPT })).status, 403);
  w2.raw.exec(`UPDATE security_blocks SET lifted_at = '${new Date().toISOString()}', lifted_by = 'usr_owner', updated_at = '${new Date().toISOString()}' WHERE actor_kind = 'account'`);
  w2.env.DB = asD1(w2.raw);
  await w2.call('/api/cart', { as: 'neighbour', ip: OTHER_IP, headers: SCRIPT });
  assert.equal((await w2.call('/api/products', { ip: OTHER_IP, cookies: { lv_pref: t2 }, headers: SCRIPT })).status, 200);
});

test('BUDGETS: anonymous incidents fill only their share — canary uses and accounts still write; an IPv6 /48 rotating its /64s is blocked whole (fix round M6)', async () => {
  const w = await deceptionWorld();
  const now = new Date().toISOString();
  const exp = new Date(Date.now() + 3_600_000).toISOString();
  const ins = w.raw.prepare(
    "INSERT INTO security_blocks (id, incident_id, reference, actor_kind, actor_key, actor_class, reason, signal, created_at, expires_at, updated_at) VALUES (?, ?, 'LV-AAAAAAAA', 'network', ?, 'guest', 'decoy_hit', 'DECOY_HIT', ?, ?, ?)"
  );
  for (let i = 0; i < DECOY_ROW_CAP; i++) ins.run(`sbk_fill${i}`, `sin_fill${i}`, `fill${String(i).padStart(28, '0')}`, now, exp, now);
  const mine = () => blocks(w.raw).filter((b) => !String(b.id).startsWith('sbk_fill'));
  await w.call('/.env', { ip: '192.0.2.170', headers: TOOL });
  assert.equal(mine().length, 0, 'the anonymous share is full: no row');
  assert.equal((await w.call('/api/products', { ip: '192.0.2.170', headers: TOOL })).status, 403, 'this isolate blocks it all the same');
  // A canary use and an account block still write.
  await hit(w, { as: 'customer', ip: '192.0.2.171' });
  assert.ok(mine().some((b) => b.actor_kind === 'account'), 'the account block is written');
  const cfg = JSON.parse(await (await w.call('/config.json', { ip: '192.0.2.172', headers: TYPED })).text()) as { api: { key: string } };
  await w.call('/api/products', { ip: '192.0.2.173', headers: { 'X-API-Key': cfg.api.key } });
  assert.ok(mine().some((b) => b.reason === 'canary_used'), 'the canary use is written');

  // IPv6: one /48, a new /64 for every hit.
  const v6 = await deceptionWorld();
  const addr = (i: number) => `2001:db8:77:${(i + 1).toString(16)}::1`;
  for (let i = 0; i <= PREFIX_INCIDENT_BUDGET; i++) await v6.call('/.env', { ip: addr(i), headers: TOOL });
  const rows = blocks(v6.raw).filter((b) => b.actor_kind === 'network');
  assert.equal(rows.length, PREFIX_INCIDENT_BUDGET + 1, `${rows.length}: one row per /64 up to the budget, then one for the /48`);
  const wide = await keyForNet(KEYED, '2001:db8:77::/48', Date.now());
  assert.ok(rows.some((b) => b.actor_key === wide), 'the whole /48 is blocked');
  // A /64 never seen before, in that /48, on a fresh isolate: blocked.
  v6.env.DB = asD1(v6.raw);
  await v6.call('/api/cart', { as: 'customer', ip: OTHER_IP, headers: SCRIPT });
  assert.equal((await v6.call('/api/products', { ip: '2001:db8:77:ffff::9', headers: TOOL })).status, 403);
  assert.equal((await v6.call('/api/products', { ip: '2001:db8:78:1::9', headers: TOOL })).status, 200, 'the next /48 is not');
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
  await w.call('/api/products', { ip: OTHER_IP, headers: TOOL });
  const added = coldSeen.slice(before).filter((sql) => /security_|lv-/.test(sql));
  assert.deepEqual(added, [], 'no D1 statement of the deception layer on an ordinary request');
});

test('HITS: blocked requests are counted against their block, flushed after the answer', async () => {
  const w = await deceptionWorld();
  await hit(w);
  for (let i = 0; i < 3; i++) await w.call('/api/products', { ip: ATTACKER_IP, headers: TOOL });
  const net = blocks(w.raw).find((b) => b.actor_kind === 'network')!;
  assert.ok(Number(net.hits) >= 1);
  assert.ok(net.last_hit_at);
});

test('DEPLOY AHEAD (a database without 0185): no 500, the decoy still deceives, the stateless tag blocks, account and network blocks are off', async () => {
  const w = await deceptionWorld({ through: '0183' });
  const res = await w.call('/.env', { as: 'customer', headers: TOOL });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /LEVONIS_API_KEY/);
  const tag = await tagged(w, '192.0.2.60');
  assert.equal((await w.call('/api/products', { cookies: { lv_pref: tag }, ip: OTHER_IP, headers: SCRIPT })).status, 403, 'the tag needs no table');
  assert.equal((await w.call('/api/cart', { as: 'customer', ip: OTHER_IP, headers: SCRIPT })).status, 200, 'no account block without the table');
  const anon = await deceptionWorld({ through: '0183' });
  await anon.call('/.env', { headers: TOOL });
  await anon.call('/api/cart', { as: 'customer', ip: OTHER_IP, headers: SCRIPT });
  assert.equal((await anon.call('/api/products', { headers: TOOL })).status, 200, 'no network block without the table');
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
