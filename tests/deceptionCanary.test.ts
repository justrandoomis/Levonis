/**
 * CANARY USE — trap data from a decoy answer, presented anywhere a key, a
 * credential or an id can be (worker/lib/deception/canary.ts, gate.ts;
 * DECISIONS row 206), through the REAL Worker.
 *
 *   blocks at once   the key in Authorization, X-API-Key or the query; the
 *                    e-mail or password at the sign-in door (and no table ever
 *                    holds the password); the session token as the cookie; a
 *                    product-shaped canary only with its batch row (else 30)
 *   never collides   10,000 real product ids match nothing; a token minted
 *                    under another key matches nothing
 *   admins           blocked only by a CONFIRMED canary; the owner never — the
 *                    bell «استُعملت بيانات فخّ من حسابك» rings instead
 *   linked           a use from another address marks the batch (first use,
 *                    count), so the console ties the decoy to its later use
 *   intent           a URL canary from a clicked link scores 60; an induced
 *                    one is recorded only
 *
 * Local only. Run: node --import tsx --test tests/deceptionCanary.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { json } from './fixtures/app';
import { CLICKED, INDUCED, OTHER_IP, SCRIPT, blocks, deceptionEvents, deceptionWorld, ownerBells, setCookieValue, type World } from './fixtures/deception';
import { findCanaries, mintBatch } from '../worker/lib/deception/canary';
import { batchShape } from '../worker/lib/deception/decoys';
import { newId } from '../worker/lib/crypto';

/** An attacker took /config.json from 192.0.2.9; returns the trap data he was given (its batch row exists). */
async function stolen(w: World) {
  const res = await w.call('/config.json', { ip: '192.0.2.9' });
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

test('the key blocks at once — in Authorization, in X-API-Key, in the query — and links its batch', async () => {
  for (const place of ['bearer', 'x-api-key', 'query'] as const) {
    const w = await deceptionWorld();
    const t = await stolen(w);
    const res =
      place === 'bearer'
        ? await w.call('/api/products', { ip: OTHER_IP, headers: { Authorization: `Bearer ${t.key}` } })
        : place === 'x-api-key'
          ? await w.call('/api/products', { ip: OTHER_IP, headers: { 'X-API-Key': t.key } })
          : await w.call(`/api/products?api_key=${t.key}`, { ip: OTHER_IP });
    assert.ok(await isBlocked(res), place);
    const body = await json(res);
    assert.ok(!JSON.stringify(body).includes(t.key), 'the block never echoes the canary');
    assert.ok(setCookieValue(res, 'lv_pref'), `${place}: the device is tagged on the block answer`);
    const batch = w.raw.prepare('SELECT use_count, first_used_at FROM security_canaries').get() as { use_count: number; first_used_at: string | null };
    assert.equal(batch.use_count, 1, place);
    assert.ok(batch.first_used_at);
    const canary = deceptionEvents(w.raw, 'CANARY_USED');
    assert.equal(canary.length, 1);
    assert.ok(blocks(w.raw).some((b) => b.reason === 'canary_used' && b.actor_kind === 'network'), 'anonymous: the network too');
    // The next request from that address, without the tag: blocked.
    assert.equal((await w.call('/api/home', { ip: OTHER_IP })).status, 403);
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

test('the session token as the session cookie blocks at once', async () => {
  const w = await deceptionWorld();
  const t = await stolen(w);
  const res = await w.call('/api/auth/me', { ip: OTHER_IP, cookies: { levonis_session: t.session } });
  assert.ok(await isBlocked(res));
});

test('a product-shaped canary blocks only with its batch row; without one it scores 30 and is recorded', async () => {
  const w = await deceptionWorld();
  const t = await stolen(w);
  const res = await w.call(`/api/products/${t.productId}`, { ip: OTHER_IP });
  assert.ok(await isBlocked(res), 'with the row');
  // A valid product canary whose batch was never recorded (the daily cap, or chance).
  const w2 = await deceptionWorld();
  const shape = batchShape('abcdef0123');
  const lone = await mintBatch({}, 'abcdef0123', 'levonis-iq.com', shape.productCount, shape.keyNoise);
  const r2 = await w2.call(`/api/products/${lone.productIds[0]}`, { ip: OTHER_IP, headers: SCRIPT });
  assert.notEqual(r2.status, 403);
  assert.equal(blocks(w2.raw).length, 0);
  assert.equal(deceptionEvents(w2.raw, 'CANARY_UNCONFIRMED').length, 1);
  const score = w2.raw.prepare("SELECT score FROM security_scores WHERE actor_key LIKE 'n:%'").get() as { score: number };
  assert.equal(score.score, 30);
  // In a cart body too.
  const w3 = await deceptionWorld();
  const t3 = await stolen(w3);
  const cart = await w3.call('/api/cart/items', { as: 'customer', ip: OTHER_IP, body: { productId: t3.productId, qty: 1 }, headers: SCRIPT });
  assert.ok(await isBlocked(cart), 'a canary product added to the cart');
  assert.ok(blocks(w3.raw).some((b) => b.actor_kind === 'account' && b.actor_key === 'usr_cust'));
});

test('NEVER COLLIDES: 10,000 real product ids match nothing; a token minted under another key matches nothing', async () => {
  const ids = Array.from({ length: 10_000 }, () => newId('prd'));
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500).join(' ');
    // The verifier looks at three candidates per text; feed them three at a time.
    for (let j = 0; j < 500; j += 3) {
      const found = await findCanaries({}, [[ids.slice(i + j, i + j + 3).join(' '), 'url']]);
      assert.deepEqual(found, [], chunk.slice(0, 40));
    }
  }
  const shape = batchShape('0123456789');
  const other = await mintBatch({ SECURITY_CANARY_KEY: 'key-A' }, '0123456789', 'levonis-iq.com', shape.productCount, shape.keyNoise);
  for (const tok of [other.apiKey, other.email, other.password, other.session, other.productIds[0]!]) {
    assert.deepEqual(await findCanaries({ SECURITY_CANARY_KEY: 'key-B' }, [[tok, 'header']]), [], tok);
    assert.equal((await findCanaries({ SECURITY_CANARY_KEY: 'key-A' }, [[tok, 'header']])).length, 1, tok);
  }
  // Ordinary text never reaches a check.
  assert.deepEqual(await findCanaries({}, [['/api/products?search=طابعة ثلاثية الأبعاد', 'url'], ['Bearer abc.def', 'header']]), []);
});

test('ADMINS: blocked only by a CONFIRMED canary; an unconfirmed one is recorded', async () => {
  // Confirmed: the batch row exists.
  const w = await deceptionWorld();
  const t = await stolen(w);
  const res = await w.call('/api/admin/users', { as: 'full', ip: OTHER_IP, headers: { 'X-API-Key': t.key } });
  assert.ok(await isBlocked(res));
  assert.ok(blocks(w.raw).some((b) => b.actor_kind === 'account' && b.actor_key === 'usr_full' && b.actor_class === 'full_admin'));
  // Unconfirmed (minted with the pepper, no row): recorded, not blocked.
  const w2 = await deceptionWorld();
  const shape = batchShape('fedcba9876');
  const forged = await mintBatch({}, 'fedcba9876', 'levonis-iq.com', shape.productCount, shape.keyNoise);
  const r2 = await w2.call('/api/products', { as: 'assistant', ip: OTHER_IP, headers: { 'X-API-Key': forged.apiKey } });
  assert.equal(r2.status, 200);
  assert.equal(blocks(w2.raw).length, 0);
  assert.equal(JSON.parse(String(deceptionEvents(w2.raw, 'CANARY_USED')[0]!.detail)).ex, 'admin');
  // …whereas a customer presenting the very same forged key is blocked (a forged canary only blocks its sender).
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
});

test('INTENT: a canary in a clicked link scores 60; in an induced request it is recorded only — a header canary always counts', async () => {
  const w = await deceptionWorld();
  const t = await stolen(w);
  const clicked = await w.call(`/api/cart?token=${t.key}`, { as: 'customer', ip: OTHER_IP, headers: CLICKED });
  assert.equal(clicked.status, 200);
  assert.equal((w.raw.prepare("SELECT score FROM security_scores WHERE actor_key = 'u:usr_cust'").get() as { score: number }).score, 60);
  for (const headers of INDUCED) {
    const r = await w.call(`/api/cart?token=${t.key}`, { as: 'neighbour', ip: OTHER_IP, headers });
    assert.equal(r.status, 200, JSON.stringify(headers));
  }
  assert.equal(blocks(w.raw).filter((b) => b.actor_key === 'usr_nb').length, 0);
  assert.ok(deceptionEvents(w.raw, 'CANARY_INDUCED').length >= 1);
  assert.equal((w.raw.prepare("SELECT COUNT(*) AS n FROM security_scores WHERE actor_key = 'u:usr_nb'").get() as { n: number }).n, 0);
  // The same key in a header from an image request still counts: a page cannot set a header.
  const header = await w.call('/api/products', { as: 'neighbour', ip: OTHER_IP, headers: { ...INDUCED[0], 'X-API-Key': t.key } });
  assert.ok(await isBlocked(header));
});
