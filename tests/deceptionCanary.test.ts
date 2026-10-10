/**
 * CANARY USE — trap data from a decoy answer, presented anywhere a key, a
 * credential or an id can be (worker/lib/deception/canary.ts, gate.ts;
 * DECISIONS row 206 and its fix round), through the REAL Worker.
 *
 *   blocks at once   where no link can put it: the key in any header, the
 *                    e-mail or password at the sign-in door whatever the body's
 *                    type or size (and no table ever holds the password), the
 *                    session token or any cookie, anything a tool sends — a
 *                    product-shaped canary only with its batch row (else 30)
 *   never framed     a canary in a LINK — opened from another app, echoed by
 *                    the app's own fetch, clicked on this site — is recorded
 *                    and scored, never a block: an attacker can hand a victim
 *                    any link (fix round BLOCKER); staff the same
 *   never hidden     canary-shaped junk in the query cannot use up the check a
 *                    credential or a header gets; a flood of junk is itself a
 *                    probe (fix round M4)
 *   never collides   10,000 real product ids match nothing; a token minted
 *                    under another key matches nothing
 *   admins           blocked only by a CONFIRMED canary; the owner never — the
 *                    bell «استُعملت بيانات فخّ من حسابك» rings instead
 *   the log          stores no target id the trap value could be (fix round m3)
 *
 * Local only. Run: node --import tsx --test tests/deceptionCanary.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { json } from './fixtures/app';
import { CLICKED, INDUCED, KEYED, OPENED, OTHER_IP, SCRIPT, TOOL, TYPED, blocks, deceptionEvents, deceptionWorld, ownerBells, setCookieValue, type World } from './fixtures/deception';
import { MAX_STRONG_CANDIDATES, findCanaries, mintBatch } from '../worker/lib/deception/canary';
import { batchShape } from '../worker/lib/deception/decoys';
import { newId } from '../worker/lib/crypto';

/** An attacker took /config.json from 192.0.2.9; returns the trap data he was given (its batch row exists). */
async function stolen(w: World) {
  const res = await w.call('/config.json', { ip: '192.0.2.9', headers: TOOL });
  assert.equal(res.status, 200);
  const cfg = JSON.parse(await res.text()) as {
    api: { key: string };
    admin: { email: string; password: string; session: string };
    database: { password: string };
    pricing: { featured: string[] };
  };
  return { key: cfg.api.key, email: cfg.admin.email, password: cfg.admin.password, dbPassword: cfg.database.password, session: cfg.admin.session, productId: cfg.pricing.featured[0]! };
}

const isBlocked = async (res: Response) => res.status === 403 && (await json(res.clone())).code === 'ACCESS_BLOCKED';
const score = (w: World, key: string) => (w.raw.prepare('SELECT score FROM security_scores WHERE actor_key = ?').get(key) as { score: number } | undefined)?.score ?? 0;

test('the key blocks at once — in Authorization, in X-API-Key, in any other header, in a cookie, in a tool\'s query — and links its batch', async () => {
  for (const place of ['bearer', 'x-api-key', 'x-auth-token', 'cookie', 'query'] as const) {
    const w = await deceptionWorld();
    const t = await stolen(w);
    const res =
      place === 'bearer'
        ? await w.call('/api/products', { ip: OTHER_IP, headers: { Authorization: `Bearer ${t.key}` } })
        : place === 'x-api-key'
          ? await w.call('/api/products', { ip: OTHER_IP, headers: { ...SCRIPT, 'X-API-Key': t.key } })
          : place === 'x-auth-token'
            ? await w.call('/api/home', { ip: OTHER_IP, headers: { ...SCRIPT, 'X-Auth-Token': t.key } })
            : place === 'cookie'
              ? await w.call('/api/home', { ip: OTHER_IP, headers: SCRIPT, cookies: { api_key: t.key } })
              : await w.call(`/api/products?api_key=${t.key}`, { ip: OTHER_IP, headers: TOOL });
    assert.ok(await isBlocked(res), place);
    const body = await json(res);
    assert.ok(!JSON.stringify(body).includes(t.key), 'the block never echoes the canary');
    assert.ok(setCookieValue(res, 'lv_pref'), `${place}: the device is tagged on the block answer`);
    const batch = w.raw.prepare('SELECT use_count, first_used_at FROM security_canaries').get() as { use_count: number; first_used_at: string | null };
    assert.equal(batch.use_count, 1, place);
    assert.ok(batch.first_used_at);
    assert.equal(deceptionEvents(w.raw, 'CANARY_USED').length, 1);
    assert.ok(blocks(w.raw).some((b) => b.reason === 'canary_used' && b.actor_kind === 'network'), 'anonymous: the network too');
    // The next tool request from that address, without the tag: blocked.
    assert.equal((await w.call('/api/home', { ip: OTHER_IP, headers: TOOL })).status, 403);
  }
});

function everyText(raw: DatabaseSync): string {
  const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((t) => t.name);
  return tables.map((t) => JSON.stringify(raw.prepare(`SELECT * FROM "${t}"`).all())).join('\n');
}

test('the e-mail or the password at the sign-in door blocks at once — and afterwards NO TABLE holds the password', async () => {
  for (const body of ['email', 'password', 'otp'] as const) {
    const w = await deceptionWorld();
    const t = await stolen(w);
    const res =
      body === 'otp'
        ? await w.call('/api/auth/otp/start', { ip: OTHER_IP, body: { channel: 'email', destination: t.email }, headers: SCRIPT })
        : await w.call('/api/auth/login', {
            ip: OTHER_IP,
            body: body === 'email' ? { identifier: t.email, password: 'whatever-1' } : { identifier: 'cust@x.co', password: t.password },
            headers: SCRIPT,
          });
    assert.ok(await isBlocked(res), body);
    const text = everyText(w.raw);
    assert.ok(!text.includes(t.password), `${body}: the canary password is stored somewhere`);
    assert.ok(!text.includes(t.dbPassword));
    assert.ok(!text.includes(t.key));
  }
});

test('NOTHING HIDES A CREDENTIAL: a text/plain body, a body padded past 64 KB, canary-shaped junk in the query — still blocked at once (fix round M4)', async () => {
  const cases: Array<[string, (t: Awaited<ReturnType<typeof stolen>>) => { path: string; headers: Record<string, string>; rawBody?: string; body?: unknown }]> = [
    ['text/plain', (t) => ({ path: '/api/auth/login', headers: { ...SCRIPT, 'content-type': 'text/plain' }, rawBody: JSON.stringify({ identifier: t.email, password: t.password }) })],
    ['padded', (t) => ({ path: '/api/auth/login', headers: { ...SCRIPT, 'content-type': 'application/json' }, rawBody: JSON.stringify({ pad: 'A'.repeat(70_000), identifier: 'cust@x.co', password: t.password }) })],
    [
      'junk in the query, the password in the body',
      (t) => ({ path: '/api/auth/login?a=Lv-000000000000aaaaaaaaaa&b=Lv-111111111111bbbbbbbbbb&c=Lv-222222222222cccccccccc', headers: SCRIPT, body: { identifier: 'cust@x.co', password: t.password } }),
    ],
    [
      'junk in the query, the key in Authorization',
      (t) => ({ path: '/api/home?a=lvk_live_000000000000000000000000aaaaaaaa&b=lvk_live_111111111111111111111111bbbbbbbb&c=lvk_live_222222222222222222222222cccccccc', headers: { ...SCRIPT, Authorization: `Bearer ${t.key}` } }),
    ],
  ];
  for (const [name, make] of cases) {
    const w = await deceptionWorld();
    const t = await stolen(w);
    const r = make(t);
    const res = await w.call(r.path, { ip: OTHER_IP, headers: r.headers, rawBody: r.rawBody, body: r.body });
    assert.ok(await isBlocked(res), name);
  }
  // A flood of canary-shaped junk past the check is itself a probe: recorded and scored like hard evidence.
  const w = await deceptionWorld();
  const junk = Array.from({ length: MAX_STRONG_CANDIDATES + 2 }, (_, i) => `lvk_live_${i.toString(16).padStart(24, '0')}deadbeef`).join(' ');
  await w.call('/api/home', { ip: OTHER_IP, headers: { 'X-Junk': junk } });
  assert.equal(deceptionEvents(w.raw, 'CANARY_FLOOD').length, 1);
  const n = w.raw.prepare("SELECT score FROM security_scores WHERE actor_key LIKE 'n:%'").get() as { score: number };
  assert.equal(n.score, 50, 'a tool\'s flood counts in full');
});

test('the session token as the session cookie blocks at once', async () => {
  const w = await deceptionWorld();
  const t = await stolen(w);
  const res = await w.call('/api/auth/me', { ip: OTHER_IP, cookies: { levonis_session: t.session } });
  assert.ok(await isBlocked(res));
});

test('a product-shaped canary blocks only with its batch row; without one it scores 30 and is recorded; in a cart body the app sent, it is linkable', async () => {
  const w = await deceptionWorld();
  const t = await stolen(w);
  const res = await w.call(`/api/products/${t.productId}`, { ip: OTHER_IP, headers: TOOL });
  assert.ok(await isBlocked(res), 'with the row');
  // A valid product canary whose batch was never recorded (the daily cap, or chance).
  const w2 = await deceptionWorld();
  const shape = batchShape('abcdef0123');
  const lone = await mintBatch(KEYED, 'abcdef0123', 'levonis-iq.com', shape.productCount, shape.keyNoise);
  const r2 = await w2.call(`/api/products/${lone.productIds[0]}`, { ip: OTHER_IP, headers: TOOL });
  assert.notEqual(r2.status, 403);
  assert.equal(blocks(w2.raw).length, 0);
  assert.equal(deceptionEvents(w2.raw, 'CANARY_UNCONFIRMED').length, 1);
  const sc = w2.raw.prepare("SELECT score FROM security_scores WHERE actor_key LIKE 'n:%'").get() as { score: number };
  assert.equal(sc.score, 30);
  // In a cart body: from a tool, blocked; from the app's own fetch (which could echo an id from a link), counted, not blocked.
  const w3 = await deceptionWorld();
  const t3 = await stolen(w3);
  const viaApp = await w3.call('/api/cart/items', { as: 'customer', ip: OTHER_IP, body: { productId: t3.productId, qty: 1 }, headers: SCRIPT });
  assert.equal(await isBlocked(viaApp), false);
  assert.equal(score(w3, 'u:usr_cust'), 60);
  const viaTool = await w3.call('/api/cart/items', { as: 'customer', ip: OTHER_IP, body: { productId: t3.productId, qty: 1 }, headers: TOOL });
  assert.ok(await isBlocked(viaTool), 'a canary product added to the cart by a tool');
  assert.ok(blocks(w3.raw).some((b) => b.actor_kind === 'account' && b.actor_key === 'usr_cust'));
});

test('NEVER COLLIDES: 10,000 real product ids match nothing; a token minted under another key matches nothing', async () => {
  const ids = Array.from({ length: 10_000 }, () => newId('prd'));
  for (let i = 0; i < ids.length; i += 3) {
    const found = await findCanaries(KEYED, [[ids.slice(i, i + 3).join(' '), 'url']]);
    assert.deepEqual(found, [], ids[i]);
  }
  const shape = batchShape('0123456789');
  const other = await mintBatch({ SECURITY_CANARY_KEY: 'key-A' }, '0123456789', 'levonis-iq.com', shape.productCount, shape.keyNoise);
  for (const tok of [other.apiKey, other.email, other.password, other.dbPassword, other.session, other.productIds[0]!]) {
    assert.deepEqual(await findCanaries({ SECURITY_CANARY_KEY: 'key-B' }, [[tok, 'header']]), [], tok);
    const mine = await findCanaries({ SECURITY_CANARY_KEY: 'key-A' }, [[tok, 'header']]);
    assert.equal(mine.length, 1, tok);
    assert.equal(mine[0]!.batch, '0123456789', 'the batch comes back out of the token');
  }
  // Ordinary text never reaches a check.
  assert.deepEqual(await findCanaries(KEYED, [['/api/products?search=طابعة ثلاثية الأبعاد', 'url'], ['Bearer abc.def', 'header']]), []);
});

test('ADMINS: blocked only by a CONFIRMED canary; an unconfirmed one is recorded', async () => {
  // Confirmed: the batch row exists.
  const w = await deceptionWorld();
  const t = await stolen(w);
  const res = await w.call('/api/admin/users', { as: 'full', ip: OTHER_IP, headers: { 'X-API-Key': t.key } });
  assert.ok(await isBlocked(res));
  assert.ok(blocks(w.raw).some((b) => b.actor_kind === 'account' && b.actor_key === 'usr_full' && b.actor_class === 'full_admin'));
  // Unconfirmed (a valid token whose batch has no row): recorded, not blocked.
  const w2 = await deceptionWorld();
  const shape = batchShape('fedcba9876');
  const forged = await mintBatch(KEYED, 'fedcba9876', 'levonis-iq.com', shape.productCount, shape.keyNoise);
  const r2 = await w2.call('/api/products', { as: 'assistant', ip: OTHER_IP, headers: { 'X-API-Key': forged.apiKey } });
  assert.equal(r2.status, 200);
  assert.equal(blocks(w2.raw).length, 0);
  assert.equal(JSON.parse(String(deceptionEvents(w2.raw, 'CANARY_USED')[0]!.detail)).ex, 'admin');
  // …whereas a customer presenting the very same key is blocked.
  const r3 = await w2.call('/api/products', { as: 'customer', ip: OTHER_IP, headers: { 'X-API-Key': forged.apiKey } });
  assert.ok(await isBlocked(r3));
});

test('THE OWNER is never blocked by a canary; the bell says trap data was used from the account', async () => {
  const w = await deceptionWorld();
  const t = await stolen(w);
  const before = ownerBells(w.raw).length;
  const res = await w.call('/api/admin/security/summary', { as: 'owner', ip: OTHER_IP, headers: { Authorization: `Bearer ${t.key}` } });
  assert.equal(res.status, 200);
  assert.equal(blocks(w.raw).filter((b) => b.actor_key === 'usr_owner').length, 0);
  const bells = ownerBells(w.raw).slice(before);
  assert.equal(bells.length, 1);
  assert.equal(bells[0]!.title_ar, 'استُعملت بيانات فخّ من حسابك');
  assert.equal(JSON.parse(String(bells[0]!.meta)).title_ckb, 'زانیاریی تەڵە لە هەژمارەکەتەوە بەکارهات');
  assert.equal(JSON.parse(String(deceptionEvents(w.raw, 'CANARY_USED')[0]!.detail)).ex, 'owner');
  // On a path that never loads the session too: the owner behind the cookie is still the owner.
  for (const path of ['/api/products', '/api/storefront/resolve']) {
    const r = await w.call(path, { as: 'owner', ip: OTHER_IP, headers: { Authorization: `Bearer ${t.key}` } });
    assert.equal(r.status, 200, path);
    assert.equal(setCookieValue(r, 'lv_pref'), null, `${path}: no tag for the owner`);
  }
  assert.equal(blocks(w.raw).filter((b) => b.reason === 'canary_used').length, 0);
});

test('NEVER FRAMED: a victim handed a link carrying trap data — opened from another app, echoed by the app, clicked here — is never blocked; staff neither (fix round BLOCKER)', async () => {
  const w = await deceptionWorld();
  const t = await stolen(w);
  const V = '198.51.100.77';
  for (const who of ['customer', 'full', null] as const) {
    // The link opened from WhatsApp, Telegram, a QR code, an e-mail…
    const doc = await w.call(`/products?search=${t.key}`, { as: who, ip: V, headers: OPENED });
    assert.notEqual(doc.status, 403, `${who}: the document`);
    // …then the app's own boot fetch forwards ?search= to the API (src/lib/bootFetch.ts).
    const boot = await w.call(`/api/products?search=${t.key}&limit=50`, { as: who, ip: V, headers: SCRIPT });
    assert.equal(await isBlocked(boot), false, `${who}: the app's echo`);
    // Typed, or clicked on this site.
    assert.equal(await isBlocked(await w.call(`/api/cart?token=${t.key}`, { as: who, ip: V, headers: TYPED })), false);
    assert.equal(await isBlocked(await w.call(`/api/cart?token=${t.key}`, { as: who, ip: V, headers: CLICKED })), false);
  }
  assert.equal(blocks(w.raw).filter((b) => b.reason === 'canary_used').length, 0, 'nobody is blocked by a link');
  assert.ok(deceptionEvents(w.raw, 'CANARY_USED').every((e) => JSON.parse(String(e.detail)).ex === 'linked'), 'recorded as linked');
  assert.ok(score(w, 'u:usr_cust') > 0 && score(w, 'u:usr_cust') < 100);
  // Still nothing after it all: the customer browses on.
  assert.equal((await w.call('/api/products', { as: 'customer', ip: V, headers: SCRIPT })).status, 200);
});

test('INDUCED: a canary in an image, a frame or a cross-site fetch is recorded only — a header canary always counts', async () => {
  const w = await deceptionWorld();
  const t = await stolen(w);
  for (const headers of INDUCED) {
    const r = await w.call(`/api/cart?token=${t.key}`, { as: 'neighbour', ip: OTHER_IP, headers });
    assert.equal(r.status, 200, JSON.stringify(headers));
  }
  assert.equal(blocks(w.raw).filter((b) => b.actor_key === 'usr_neighbour').length, 0);
  assert.ok(deceptionEvents(w.raw, 'CANARY_INDUCED').length >= 1);
  assert.equal(score(w, 'u:usr_neighbour'), 0);
  // The same key in a header from an image request still counts: a page cannot set a header.
  const header = await w.call('/api/products', { as: 'neighbour', ip: OTHER_IP, headers: { ...INDUCED[0], 'X-API-Key': t.key } });
  assert.ok(await isBlocked(header));
});

test('THE LOG HOLDS NO TRAP VALUE: a canary password where an order id goes is never stored as the target (fix round m3)', async () => {
  const w = await deceptionWorld();
  const t = await stolen(w);
  for (let i = 0; i < 3; i++) await w.call(`/api/orders/${t.password}`, { as: 'customer', ip: OTHER_IP, headers: SCRIPT });
  await w.call(`/api/orders/${t.password}`, { as: 'neighbour', ip: OTHER_IP, headers: TOOL });
  const rows = deceptionEvents(w.raw);
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((e) => e.target_id === null), JSON.stringify(rows.map((e) => [e.code, e.target_id])));
  assert.ok(!everyText(w.raw).includes(t.password));
});
