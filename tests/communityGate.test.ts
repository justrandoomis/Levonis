/**
 * LEVO COMMUNITY IS UNDER MAINTENANCE — «ليفو كوميونيتي تحت الصيانة، واسمح
 * بالأعضاء من قائمة في الادارة».
 *
 * This suite pins what that had to mean to be true rather than decorative:
 *
 *   * THE SERVER REFUSES, not just the app. /api/community writes real rows —
 *     customer requests, merchant profiles, follows — and answers a curl from
 *     anyone, so every gated route answers 503 COMMUNITY_CLOSED to a visitor
 *     while it is shut, and a refused request creates NOTHING;
 *   * IT SHIPS CLOSED. With no `admin_settings.communityGate` row the
 *     community is shut, so the deploy itself carries out the instruction.
 *     Only the literal `{"open": true}` opens it — a blank, a malformed
 *     value, `{"open": "true"}` or a non-array allow-list all read as closed
 *     with an EMPTY list;
 *   * THE ALLOW-LIST LETS EXACTLY THE NAMED IDS IN, and matches on `users.id`
 *     — never a username or an email, which their owner can change;
 *   * THE ADMIN DOOR STAYS OPEN on the existing `users.role` check;
 *   * THE MERCHANT'S OWN SHOP IS OUTSIDE THE WALL. /my-store,
 *     /my-store/products and /profile-status answer while the community is
 *     shut, because a merchant runs a live business from them and closing a
 *     browsing surface must not strand trade in flight;
 *   * ONE SWITCH, NO DEPLOY, AND AUDITED. One settings write through the
 *     admin route opens it or adds a member, and every flip leaves an audit
 *     row naming who did it;
 *   * CLOSING IS NOT A WIPE. Every merchant, product, request and follow is
 *     still there, byte for byte, when it reopens;
 *   * and the client half is PRESENTATION: it reads the same three booleans
 *     and refuses to invent an answer it could not read.
 *
 * The real routes run against the real migrations through the SQLite adapter;
 * only the session is stubbed. The client half is read as source, the way the
 * other client-gate suites do it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ROOT, SqliteD1 } from './fixtures/d1';
import type { AppContext } from '../worker/lib/types';
import { HttpError, requireMainHost } from '../worker/lib/http';
import { classifyHost } from '../worker/lib/hosts';
import {
  COMMUNITY_GATE_SETTING_KEY,
  communityGateFromSetting,
  communityMayEnter,
  communityPathOutsideWall,
  readCommunityGate,
} from '../worker/lib/communityGate';
import { communityRoutes } from '../worker/routes/community';
import { adminCommunityRoutes } from '../worker/routes/adminCommunity';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { communityReviewRoutes } from '../worker/routes/merchantReviews';
import { merchantRoutes } from '../worker/routes/merchant';
import { communityAccessOf } from '../src/pages/community/access';

// ------------------------------------------------------------------ harness

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) raw.exec(readFileSync(join(dir, f), 'utf8'));
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username) VALUES
      ('u1','Sara','sara@x.co','h','customer','sara'),
      ('u2','Ali','ali@x.co','h','customer','ali'),
      ('boss','Owner','a@x.co','h','admin','boss');
    INSERT INTO users (id,name,email,password_hash,role,username,phone_e164) VALUES
      ('u_phone','Tester','p_964770@phone.levonis.invalid','h','customer',NULL,'+9647701234567');
    INSERT INTO community_merchants (id,user_id,name,bio) VALUES ('cm1','u2','Ali Prints','bio');
    INSERT INTO community_products (id,merchant_id,slug,name,price_iqd) VALUES ('cp1','cm1','thing','Thing',5000);
    INSERT INTO community_requests (id,customer_id,title) VALUES ('creq1','u1','Need a bracket');
  `);
  // No communityGate row on purpose: that IS the shipped state.
  return { raw, db: new SqliteD1(raw) as unknown as D1Database };
}

function appAs(db: D1Database, userId: string | null, role = 'customer', host = 'levonis-iq.com') {
  const a = new Hono<AppContext>();
  a.use('*', async (c, next) => {
    if (userId) {
      c.set('user', { id: userId, role, email: `${userId}@x.co`, username: userId, name: userId } as never);
    }
    c.set('host', classifyHost(host, 'levonis-iq.com'));
    c.env = { DB: db, INITIAL_ADMIN_EMAIL: 'a@x.co' } as never;
    await next();
  });
  // Exactly how worker/index.ts wires the two routers.
  a.use('/api/admin/*', requireMainHost);
  a.route('/api/admin/community', adminCommunityRoutes);
  a.route('/api/community', communityRoutes);
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
  a.route('/api/community-reviews', communityReviewRoutes);
  a.route('/api/merchant', merchantRoutes);
  a.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json(
        { success: false, error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) },
        err.status as 400
      );
    }
    throw err;
  });
  return a;
}
type App = ReturnType<typeof appAs>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response) => (await res.json()) as Record<string, any>;
const post = (a: App, path: string, body: Record<string, unknown> = {}) =>
  a.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' },
    body: JSON.stringify(body),
  });
const put = (a: App, path: string, body: Record<string, unknown>) =>
  a.request(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Write the switch the way the admin route does, without going through it. */
const setSwitch = (raw: DatabaseSync, value: string) =>
  raw
    .prepare('INSERT INTO admin_settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(COMMUNITY_GATE_SETTING_KEY, value);
const count = (raw: DatabaseSync, sql: string) => (raw.prepare(sql).get() as { n: number }).n;

/** Every gated route, one of each shape. */
const GATED_READS = [
  '/api/community/products',
  '/api/community/merchants',
  '/api/community/requests',
  '/api/community/store/cm1',
  '/api/community/followed',
  // The /requests print-request marketplace IS Levo Community (owner,
  // 2026-09-23: «نعم، أغلقه مع المجتمع») — the same rows, around the wall.
  '/api/marketplace/requests',
  '/api/marketplace/requests/creq1',
  // The twin of the walled /followed.
  '/api/community-reviews/following',
];
const GATED_WRITES: Array<[string, Record<string, unknown>]> = [
  ['/api/community/requests', { title: 'A new bracket' }],
  ['/api/community/store/cm1/follow', {}],
  ['/api/community/requests/creq1/close', {}],
  ['/api/marketplace/requests', { title: 'A new bracket', description: 'A bracket for the shelf, please' }],
  ['/api/marketplace/requests/creq1/offers', { price_iqd: 5000 }],
  ['/api/marketplace/print/requests/creq1/publish', {}],
  ['/api/marketplace/print/requests/creq1/repeat', {}],
  ['/api/community-reviews/follow/cm1', {}],
];

// ------------------------------------------------------- the server refuses

test('shipped closed: with no settings row every gated route refuses a customer AND a guest with 503 COMMUNITY_CLOSED', async () => {
  const { db, raw } = setup();
  const customer = appAs(db, 'u1');
  const guest = appAs(db, null);

  for (const path of GATED_READS) {
    for (const [who, a] of [['a customer', customer], ['a guest', guest]] as const) {
      const res = await a.request(path);
      assert.equal(res.status, 503, `${path} answered ${res.status} to ${who}`);
      const body = await json(res);
      assert.equal(body.success, false);
      assert.equal(body.code, 'COMMUNITY_CLOSED', `${path} → ${JSON.stringify(body)}`);
      assert.equal(body.details?.closed, true, `${path} says which switch refused it`);
      // The refusal is honest: it names the place and its state rather than
      // pretending the route is missing.
      assert.match(String(body.error), /صيانة|maintenance/);
    }
  }
  for (const [path, payload] of GATED_WRITES) {
    const res = await post(customer, path, payload);
    assert.equal(res.status, 503, `${path} answered ${res.status}`);
    assert.equal((await json(res)).code, 'COMMUNITY_CLOSED');
  }
  const res = await customer.request('/api/community/store/cm1/follow', { method: 'DELETE' });
  assert.equal(res.status, 503);
  for (const [method, path] of [
    ['DELETE', '/api/community-reviews/follow/cm1'],
    ['PATCH', '/api/community-reviews/follow/cm1'],
    ['PATCH', '/api/marketplace/offers/off1'],
  ] as const) {
    const r = await customer.request(path, { method, headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 503, `${method} ${path} answered ${r.status}`);
  }

  // A refused request created nothing.
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_requests WHERE title = 'A new bracket'"), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM follows'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_requests'), 1, 'no request was posted around the wall');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_offers'), 0, 'no offer was made around the wall');
  assert.equal(
    (raw.prepare("SELECT status FROM community_requests WHERE id='creq1'").get() as { status: string }).status,
    'open',
    'the refused close left the request open'
  );
});

test('the gate is in front of requireAuth: a guest is told the place is shut, not asked to sign in', async () => {
  const { db } = setup();
  const guest = appAs(db, null);
  // /followed is requireAuth-only. Closed, it must answer 503, not 401 —
  // being asked to sign in for a page that would refuse you anyway is a lie.
  const res = await guest.request('/api/community/followed');
  assert.equal(res.status, 503);
  assert.equal((await json(res)).code, 'COMMUNITY_CLOSED');
});

test('only {"open": true} opens it; every unreadable value reads CLOSED with an empty list', async () => {
  for (const v of [
    undefined,
    null,
    '',
    '   ',
    'true',
    '{',
    '[]',
    'null',
    '{"open":"true"}',
    '{"open":1}',
    '{"closed":false}',
    '{"open":false}',
  ]) {
    const gate = communityGateFromSetting(v as string | null | undefined);
    assert.equal(gate.open, false, `${JSON.stringify(v)} must not open the community`);
    assert.deepEqual([...gate.allowed], [], `${JSON.stringify(v)} must carry no allow-list`);
  }
  assert.equal(communityGateFromSetting('{"open":true}').open, true);

  // A non-array allow-list contributes nobody; an array yields only the
  // non-empty strings in it.
  assert.deepEqual([...communityGateFromSetting('{"open":false,"allowed_user_ids":"u1"}').allowed], []);
  assert.deepEqual([...communityGateFromSetting('{"open":false,"allowed_user_ids":{"0":"u1"}}').allowed], []);
  assert.deepEqual(
    [...communityGateFromSetting('{"open":false,"allowed_user_ids":["u1",null,42,"","  ","u2"]}').allowed],
    ['u1', 'u2']
  );
});

test('a malformed row does not open the community through the real reader', async () => {
  const { db, raw } = setup();
  setSwitch(raw, '{"open":tru');
  assert.equal((await readCommunityGate(db)).open, false);
  const res = await appAs(db, 'u1').request('/api/community/products');
  assert.equal(res.status, 503, 'a value nobody can parse is not permission');
});

test('opened: everyone gets in again, including a guest', async () => {
  const { db, raw } = setup();
  setSwitch(raw, '{"open":true}');
  for (const a of [appAs(db, 'u1'), appAs(db, null)]) {
    for (const path of ['/api/community/products', '/api/community/merchants', '/api/community/requests', '/api/community/store/cm1']) {
      const res = await a.request(path);
      assert.equal(res.status, 200, `${path} answered ${res.status} with the community open`);
    }
  }
});

// -------------------------------------------------------- the allow-list

test('the allow-list lets exactly the named ids in, and nobody else', async () => {
  const { db, raw } = setup();
  setSwitch(raw, '{"open":false,"allowed_user_ids":["u1"]}');

  const listed = await appAs(db, 'u1').request('/api/community/products');
  assert.equal(listed.status, 200, 'the listed member is let in while it is shut');

  const other = await appAs(db, 'u2').request('/api/community/products');
  assert.equal(other.status, 503, 'a member who is not on the list is still refused');

  const guest = await appAs(db, null).request('/api/community/products');
  assert.equal(guest.status, 503, 'a guest has no id and matches no slot');
});

test('the allow-list matches user IDS, never a username or an email', async () => {
  const { db, raw } = setup();
  // u1's username is 'sara' and email 'sara@x.co'. Putting either in the list
  // must let NOBODY in: anything its owner can change is an impersonation
  // surface, so only the server-minted id may match.
  for (const handle of ['sara', 'sara@x.co', 'Sara']) {
    setSwitch(raw, JSON.stringify({ open: false, allowed_user_ids: [handle] }));
    const res = await appAs(db, 'u1').request('/api/community/products');
    assert.equal(res.status, 503, `"${handle}" must not be a way into the community`);
  }
});

test('an empty id never matches an empty slot', () => {
  const gate = communityGateFromSetting('{"open":false,"allowed_user_ids":["u1"]}');
  assert.equal(communityMayEnter(gate, null), false);
  assert.equal(communityMayEnter(gate, { id: '', role: 'customer' } as never), false);
  assert.equal(communityMayEnter(gate, { id: 'u1', role: 'customer' } as never), true);
});

// ------------------------------------------------------- the admin door

test('an admin is let through the whole time, on users.role and nothing else', async () => {
  const { db } = setup();
  const admin = appAs(db, 'boss', 'admin');
  for (const path of GATED_READS) {
    const res = await admin.request(path);
    assert.equal(res.status, 200, `${path} answered ${res.status} to an admin while shut`);
  }
  // A customer claiming the role in a header or a body gets nowhere: the role
  // is read from the session the server resolved, never from the request.
  const faker = appAs(db, 'u1');
  const res = await faker.request('/api/community/products', { headers: { 'x-role': 'admin', role: 'admin' } });
  assert.equal(res.status, 503);
});

// ------------------------------------------------- what stays outside the wall

test('a merchant keeps running their own shop while the community is shut', async () => {
  const { db, raw } = setup();
  // u2 owns cm1 and is NOT on the allow-list.
  const merchant = appAs(db, 'u2');

  const mine = await merchant.request('/api/community/my-store');
  assert.equal(mine.status, 200, '/my-store must answer: a live catalogue is not a browsing surface');
  assert.equal((await json(mine)).merchant.id, 'cm1');

  const status = await merchant.request('/api/community/profile-status');
  assert.equal(status.status, 200, '/profile-status decides what a merchant is shown at all');

  // The legacy product doors are RETIRED onto the store API (audit 01 B10):
  // the same request is handed on with a 307, never walled with 503.
  const handed = await post(merchant, '/api/community/my-store/products', { name: 'New thing', price_iqd: 7000 });
  assert.equal(handed.status, 307, 'a merchant may still add to their own catalogue — through the store API');
  assert.equal(handed.headers.get('location'), '/api/merchant/products');

  // …which is outside the wall, and runs the store rules: with a store and a
  // live PLUS, the product is added while the community is shut.
  raw.exec(`
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES ('st1','cm1','u2','aliprints','Ali Prints');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at)
      VALUES ('mem_u2','u2','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
  `);
  const added = await post(merchant, '/api/merchant/products', { name: 'New thing', price_iqd: 7000 });
  assert.equal(added.status, 201, 'the store API is not behind the community wall');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_products'), 2);

  const id = (await json(added)).product.id;
  const del = await merchant.request(`/api/community/my-store/products/${id}`, { method: 'DELETE' });
  assert.equal(del.status, 307);
  assert.equal(del.headers.get('location'), `/api/merchant/products/${id}`);
});

test('running trade finishes: marketplace orders and complaints answer while the community is shut', async () => {
  const { db } = setup();
  const customer = appAs(db, 'u1');
  // Nothing new starts, but whatever is already in escrow must be able to
  // finish — a customer waiting on a delivery is not browsing the community.
  for (const path of ['/api/marketplace/orders', '/api/marketplace/complaints', '/api/marketplace/my-requests']) {
    const res = await customer.request(path);
    assert.equal(res.status, 200, `${path} answered ${res.status} with the wall up`);
  }
});

test('a NEW community merchant waits for the community; an existing one keeps editing', async () => {
  const { db, raw } = setup();
  // u1 has no merchant and is not on the list: creating one is a way in.
  const refused = await post(appAs(db, 'u1'), '/api/community/my-store', { name: 'Sara Prints', bio: '' });
  assert.equal(refused.status, 503);
  assert.equal((await json(refused)).code, 'COMMUNITY_CLOSED');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_merchants WHERE user_id = 'u1'"), 0);

  // u2 already owns cm1: renaming it is running a shop, not entering one.
  const kept = await post(appAs(db, 'u2'), '/api/community/my-store', { name: 'Ali Prints 2', bio: '' });
  assert.equal(kept.status, 200);
  assert.equal((raw.prepare("SELECT name FROM community_merchants WHERE id='cm1'").get() as { name: string }).name, 'Ali Prints 2');

  // An allow-listed tester gets past the gate (and on to the tier check,
  // which is the server's answer, not the gate's).
  setSwitch(raw, '{"open":false,"allowed_user_ids":["u1"]}');
  const listed = await post(appAs(db, 'u1'), '/api/community/my-store', { name: 'Sara Prints', bio: '' });
  assert.notEqual(listed.status, 503);
});

test('a NEW store from /merchant/start waits for the community too — the path the app actually uses', async () => {
  const { db, raw } = setup();
  const body = { name: 'Sara Prints', slug: 'sara-prints' };
  const before = count(raw, 'SELECT COUNT(*) AS n FROM community_merchants');
  const refused = await post(appAs(db, 'u1'), '/api/merchant/onboard', body);
  assert.equal(refused.status, 503);
  assert.equal((await json(refused)).code, 'COMMUNITY_CLOSED');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_merchants'), before, 'no merchant row was created');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM merchant_stores'), 0, 'no store was created');

  // An allow-listed member is past the gate and on to the membership check —
  // the server's own answer, not the gate's.
  setSwitch(raw, '{"open":false,"allowed_user_ids":["u1"]}');
  const listed = await post(appAs(db, 'u1'), '/api/merchant/onboard', body);
  assert.notEqual(listed.status, 503);
});

test('the print spec of a request on the public board is walled too; its customer keeps it', async () => {
  const { db, raw } = setup();
  const path = '/api/marketplace/print/requests/creq1';
  for (const [who, a] of [['another customer', appAs(db, 'u2')], ['a guest', appAs(db, null)]] as const) {
    const res = await a.request(path);
    assert.equal(res.status, 503, `${who} read the print spec of a board request while the community is shut`);
    assert.equal((await json(res)).code, 'COMMUNITY_CLOSED');
  }
  // u1 posted creq1: their own request is trade in flight, not the board.
  assert.equal((await appAs(db, 'u1').request(path)).status, 200);
  assert.equal((await appAs(db, 'boss', 'admin').request(path)).status, 200);
  setSwitch(raw, '{"open":true}');
  assert.equal((await appAs(db, null).request(path)).status, 200, 'reopened, the board is public again');
});

test('the enumeration of what is outside the wall is exact, and anything unknown is INSIDE it', () => {
  for (const p of [
    '/api/community/access',
    '/api/community/my-store',
    '/api/community/my-store/products',
    '/api/community/my-store/products/cp1',
    '/api/community/profile-status',
  ]) {
    assert.equal(communityPathOutsideWall(p), true, `${p} must answer with the wall up`);
  }
  for (const p of [
    '/api/community/products',
    '/api/community/merchants',
    '/api/community/requests',
    '/api/community/store/cm1',
    '/api/community/followed',
    // Not a prefix trick: a route that merely STARTS with an allowed word is
    // inside, because the match is on a path segment boundary.
    '/api/community/my-storefront',
    '/api/community/profile-status-x',
    '/api/community/accessories',
    // And a route nobody has written yet is gated until somebody names it.
    '/api/community/something-new',
  ]) {
    assert.equal(communityPathOutsideWall(p), false, `${p} must be inside the wall`);
  }
});

// ------------------------------------------------------- the status route

test('GET /access always answers, is never cached, and tells each viewer the truth about themselves', async () => {
  const { db, raw } = setup();

  const shut = await appAs(db, 'u1').request('/api/community/access');
  assert.equal(shut.status, 200, 'the status route must answer while the community is shut');
  assert.equal(shut.headers.get('Cache-Control'), 'no-store', 'a per-viewer verdict must never be cached');
  assert.deepEqual(await json(shut), { success: true, closed: true, admin: false, may_enter: false });

  const admin = await json(await appAs(db, 'boss', 'admin').request('/api/community/access'));
  assert.deepEqual(admin, { success: true, closed: true, admin: true, may_enter: true }, 'closed is what the CARD says; may_enter is what this viewer may do');

  setSwitch(raw, '{"open":false,"allowed_user_ids":["u1"]}');
  const member = await json(await appAs(db, 'u1').request('/api/community/access'));
  assert.deepEqual(member, { success: true, closed: true, admin: false, may_enter: true });

  setSwitch(raw, '{"open":true}');
  const open = await json(await appAs(db, null).request('/api/community/access'));
  assert.deepEqual(open, { success: true, closed: false, admin: false, may_enter: true });
});

// ------------------------------------------------------- the admin switch

test('one audited settings write opens the community and adds a member — no deploy, no migration', async () => {
  const { db, raw } = setup();
  const admin = appAs(db, 'boss', 'admin');

  const before = await json(await admin.request('/api/admin/community/gate'));
  assert.equal(before.open, false);
  assert.deepEqual(before.allowed_user_ids, []);

  const added = await put(admin, '/api/admin/community/gate', { open: false, allowed_user_ids: ['u1', 'u1'] });
  assert.equal(added.status, 200);
  assert.deepEqual((await json(added)).allowed_user_ids, ['u1'], 'a repeated id is stored once');

  // The customer is in, on the strength of that one row.
  assert.equal((await appAs(db, 'u1').request('/api/community/products')).status, 200);
  assert.equal((await appAs(db, 'u2').request('/api/community/products')).status, 503);

  // And the panel can show a person rather than an opaque string.
  const listed = await json(await admin.request('/api/admin/community/gate'));
  assert.equal(listed.members[0].username, 'sara');

  const opened = await put(admin, '/api/admin/community/gate', { open: true, allowed_user_ids: [] });
  assert.equal((await json(opened)).changed, true);
  assert.equal((await appAs(db, 'u2').request('/api/community/products')).status, 200);

  // Every flip is on the record, naming who did it.
  const audits = raw
    .prepare("SELECT actor_id, detail FROM audit_log WHERE action = 'community.gate_update' ORDER BY id")
    .all() as Array<{ actor_id: string; detail: string }>;
  assert.equal(audits.length, 2, 'both writes were audited');
  assert.ok(audits.every((r) => r.actor_id === 'boss'), 'the audit row names who flipped it');
  // And which way it went, so the record answers "when did the community open?"
  assert.deepEqual(JSON.parse(audits[1].detail).before_open, false);
  assert.deepEqual(JSON.parse(audits[1].detail).after_open, true);
});

test('the admin finds a phone-only tester by phone number or exact id, and adds them', async () => {
  const { db, raw } = setup();
  const admin = appAs(db, 'boss', 'admin');
  // The account's email is a placeholder and it has no username: before the
  // lookup, the only thing the owner knows about this tester — the phone
  // number — matched nothing.
  for (const typed of ['07701234567', '+964 770 123 4567', '9647701234567', '٠٧٧٠١٢٣٤٥٦٧', 'u_phone']) {
    const res = await admin.request(`/api/admin/community/gate/lookup?q=${encodeURIComponent(typed)}`);
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.users[0]?.id, 'u_phone', `"${typed}" must find the phone-only tester`);
    // Recognisable, not a phone directory.
    assert.equal(body.users[0].phone_masked, '+9647******567');
    assert.ok(!JSON.stringify(body).includes('7701234567'), 'the full number never leaves the server');
  }
  // Names still work, and nonsense finds nobody.
  assert.equal((await json(await admin.request('/api/admin/community/gate/lookup?q=sara'))).users[0].id, 'u1');
  assert.deepEqual((await json(await admin.request('/api/admin/community/gate/lookup?q=zzzz'))).users, []);

  const added = await put(admin, '/api/admin/community/gate', { open: false, allowed_user_ids: ['u_phone'] });
  assert.equal(added.status, 200);
  assert.equal((await appAs(db, 'u_phone').request('/api/community/products')).status, 200);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'community.gate_update'"), 1);

  // Admin-only, like the switch.
  assert.equal((await appAs(db, 'u1').request('/api/admin/community/gate/lookup?q=u1')).status, 403);
});

test('the admin switch refuses a list it cannot honour rather than storing a typo', async () => {
  const { db, raw } = setup();
  const admin = appAs(db, 'boss', 'admin');

  const bad = await put(admin, '/api/admin/community/gate', { open: false, allowed_user_ids: ['u1', 'usr_typo'] });
  assert.equal(bad.status, 400);
  assert.equal((await json(bad)).code, 'COMMUNITY_ALLOW_UNKNOWN_USER');
  // Nothing was written: an owner must never believe they let somebody in who
  // is still locked out.
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM admin_settings WHERE key = '${COMMUNITY_GATE_SETTING_KEY}'`), 0);

  const noOpen = await put(admin, '/api/admin/community/gate', { allowed_user_ids: [] });
  assert.equal(noOpen.status, 400);
  assert.equal((await json(noOpen)).code, 'COMMUNITY_OPEN_REQUIRED');

  const notArray = await put(admin, '/api/admin/community/gate', { open: false, allowed_user_ids: 'u1' });
  assert.equal(notArray.status, 400);

  const tooMany = await put(admin, '/api/admin/community/gate', {
    open: false,
    allowed_user_ids: Array.from({ length: 201 }, (_, i) => `u${i}`),
  });
  assert.equal(tooMany.status, 400);
});

test('the switch is admin-only and apex-only', async () => {
  const { db } = setup();
  assert.equal((await appAs(db, 'u1').request('/api/admin/community/gate')).status, 403);
  assert.equal((await appAs(db, null).request('/api/admin/community/gate')).status, 401);
  // A merchant subdomain cannot reach the admin surface at all (§53).
  const sub = appAs(db, 'boss', 'admin', 'shop.levonis-iq.com');
  assert.equal((await sub.request('/api/admin/community/gate')).status, 404);
});

// ------------------------------------------------------ closing is not a wipe

test('closing deletes nothing: every merchant, product, request and follow survives it', async () => {
  const { db, raw } = setup();
  setSwitch(raw, '{"open":true}');
  assert.equal((await post(appAs(db, 'u1'), '/api/community/store/cm1/follow')).status, 200);

  const beforeRows = {
    merchants: count(raw, 'SELECT COUNT(*) AS n FROM community_merchants'),
    products: count(raw, 'SELECT COUNT(*) AS n FROM community_products'),
    requests: count(raw, 'SELECT COUNT(*) AS n FROM community_requests'),
    follows: count(raw, 'SELECT COUNT(*) AS n FROM follows'),
  };

  await put(appAs(db, 'boss', 'admin'), '/api/admin/community/gate', { open: false, allowed_user_ids: [] });
  assert.equal((await appAs(db, 'u1').request('/api/community/products')).status, 503);

  assert.deepEqual(
    {
      merchants: count(raw, 'SELECT COUNT(*) AS n FROM community_merchants'),
      products: count(raw, 'SELECT COUNT(*) AS n FROM community_products'),
      requests: count(raw, 'SELECT COUNT(*) AS n FROM community_requests'),
      follows: count(raw, 'SELECT COUNT(*) AS n FROM follows'),
    },
    beforeRows,
    'the refusal is a door, not a delete'
  );

  // Reopening puts it all back exactly as it was.
  await put(appAs(db, 'boss', 'admin'), '/api/admin/community/gate', { open: true, allowed_user_ids: [] });
  const store = await json(await appAs(db, 'u1').request('/api/community/store/cm1'));
  assert.equal(store.followers, 1);
  assert.equal(store.following, true);
});

// --------------------------------------------------------- the client half

test('the client reads the same three booleans and never invents an answer', () => {
  assert.deepEqual(communityAccessOf({ success: true, closed: true, admin: false, may_enter: false }), {
    closed: true,
    admin: false,
    may_enter: false,
  });
  assert.deepEqual(communityAccessOf({ closed: false, admin: true, may_enter: true }), {
    closed: false,
    admin: true,
    may_enter: true,
  });
  // A body missing either decisive boolean is not permission.
  for (const body of [null, undefined, 'ok', 42, {}, { closed: true }, { may_enter: true }, { closed: 'true', may_enter: true }]) {
    assert.equal(communityAccessOf(body), null, `${JSON.stringify(body)} must not read as an answer`);
  }
});

test('the client gate is presentation, and says so — the refusal it reflects is the server\'s', () => {
  const src = readFileSync(join(ROOT, 'src/pages/community/access.tsx'), 'utf8');
  // It asks the always-answering route, and never a gated one.
  assert.match(src, /\/api\/community\/access/);
  assert.ok(!/\/api\/community\/(products|merchants|requests|store)/.test(src), 'the gate must not call a route that would refuse it');
  // It is keyed on the viewer, so a guest's verdict cannot survive a sign-in.
  assert.match(src, /user\?\.id/);
  // NO NEW SORANI. Every ckb word on the card comes from a translation key
  // that already exists, never from an inline ckb literal.
  assert.match(src, /t\('community'\)/);
  assert.match(src, /t\('maintenanceMain'\)/);
  assert.match(src, /t\('comingSoon'\)/);
});

test('the entry points reflect the server, and none of them hard-codes the verdict', () => {
  for (const f of [
    'src/components/BottomNav.tsx',
    'src/components/home/ServicesGrid.tsx',
    'src/components/DashboardLayout.tsx',
    'src/pages/Storefront.tsx',
    'src/pages/Profile.tsx',
  ]) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    assert.match(src, /useCommunityAccess/, `${f} must ask the server`);
    // An answer that has not arrived, or one that failed, must NOT hide the
    // link: `may_enter === false` is the only thing that does.
    assert.match(src, /may_enter === false/, `${f} must hide only on an explicit refusal`);
  }
  // The three community routes are wrapped in the gate.
  const app = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8');
  for (const path of ['/community"', '/community/store/:id"', '/community/store/:slug/p/:productSlug"', '/requests"']) {
    const line = app.split('\n').find((l) => l.includes(`path="${path}`) && l.includes('Route'));
    assert.ok(line, `no route line for ${path}`);
    assert.match(String(line), /CommunityGate/, `${path} is not behind the gate`);
  }
});

test('the ckb on the maintenance card is wording this repo already had, not a new translation', () => {
  const tr = readFileSync(join(ROOT, 'src/translations.ts'), 'utf8');
  // The three keys the card composes must all carry hand-written Sorani.
  for (const [key, ckb] of [
    ['community', 'کۆمەڵگە'],
    ['maintenanceMain', 'چاککردنەوە'],
    ['comingSoon', 'بەم زووانە'],
  ] as const) {
    assert.ok(tr.includes(`${key}: "${ckb}"`), `${key} must still carry the existing Sorani "${ckb}"`);
  }
});

test('the maintenance card offers a way in to the two refused visitors who can in fact enter', () => {
  const src = readFileSync(join(ROOT, 'src/pages/community/access.tsx'), 'utf8');
  // A signed-out tester: the server matches ids only, so the card offers a
  // sign-in that returns to this page — with the EXISTING `signIn` key.
  assert.match(src, /!user && \(/);
  assert.match(src, /\/auth\?next=\$\{encodeURIComponent\(next\)\}/);
  assert.match(src, /t\('signIn'\)/);
  // A member added while the app was open: the card asks the server again.
  assert.match(src, /<CommunityClosedCard onRecheck=\{reload\} \/>/);
  assert.match(src, /t\('retry'\)/);
});

test('Profile drops its community chips and skips /followed while the community is shut', () => {
  const src = readFileSync(join(ROOT, 'src/pages/Profile.tsx'), 'utf8');
  assert.match(src, /\{!communityShut && \(\s*<button type="button" onClick=\{\(\) => navigate\('\/followed-stores'\)\}/);
  assert.match(src, /\.\.\.\(communityShut\s*\? \[\]/);
  // The request is only made once the server said this viewer may enter.
  const effect = src.slice(src.indexOf('const mayAskFollowed'), src.indexOf("'/api/community/followed'"));
  assert.match(effect, /!mayAskFollowed/);
});

test('the gate panel searches by phone or id and can retry a failed first load', () => {
  const src = readFileSync(join(ROOT, 'src/components/adminCommunity/CommunityGatePanel.tsx'), 'utf8');
  assert.match(src, /\/api\/admin\/community\/gate\/lookup\?q=/);
  assert.ok(!src.includes('/api/admin/users?search='), 'the name-and-email-only search is gone');
  assert.match(src, /رقم الهاتف أو المعرّف/);
  // The retry sits OUTSIDE the `open !== null` block that holds everything else.
  assert.match(src, /open === null && note\?\.ok === false && \(/);
  assert.match(src, /data-community-gate-retry/);
});

test('the storefront follow pill is inert while follows are shut', () => {
  const src = readFileSync(join(ROOT, 'src/pages/Storefront.tsx'), 'utf8');
  assert.match(src, /closed=\{communityAccess\?\.may_enter === false\}/);
  assert.match(src, /disabled=\{busy \|\| closed\}/);
});

test('/merchant/start says the community is shut instead of showing a form the server refuses', () => {
  const src = readFileSync(join(ROOT, 'src/pages/MerchantStart.tsx'), 'utf8');
  assert.match(src, /communityAccess\?\.may_enter === false\) \{\s*return <CommunityClosedCard onRecheck=\{recheckCommunity\} \/>/);
});

test('per-store links go to the store\'s own site while the community is shut, never to the maintenance card', () => {
  const access = readFileSync(join(ROOT, 'src/pages/community/access.tsx'), 'utf8');
  assert.match(access, /\/api\/storefront\/by-id\//);
  assert.match(access, /if \(!shut\) return `\/community\/store\/\$\{merchantOrStoreId\}`;/);
  const product = readFileSync(join(ROOT, 'src/pages/Product.tsx'), 'utf8');
  assert.ok(!product.includes('to={`/community/store/${product.merchant.id}`}'), 'Product still hard-links the in-site store page');
  assert.match(product, /<CommunityStoreLink id=\{product\.merchant\.id\}/);
  const dash = readFileSync(join(ROOT, 'src/components/MerchantDashboard.tsx'), 'utf8');
  assert.ok(!dash.includes('navigate(`/community/store/${merchant.id}`)'), 'MerchantDashboard still navigates to the in-site store page');
  assert.match(dash, /useCommunityStoreHref\(merchant\?\.id\)/);
  const saved = readFileSync(join(ROOT, 'src/pages/SavedProducts.tsx'), 'utf8');
  assert.match(saved, /else if \(communityAccess\?\.may_enter !== false\) \{[^}]*navigate\(`\/community\/store\//);
  const requests = readFileSync(join(ROOT, 'src/pages/Requests.tsx'), 'utf8');
  assert.ok(!requests.includes('to={`/community/store/'), 'an offer card still hard-links the in-site store page');
});

test('no other door into /requests is left open while the community is shut', () => {
  const store = readFileSync(join(ROOT, 'src/pages/Storefront.tsx'), 'utf8');
  assert.match(store, /const quotes = accepts && communityAccess\?\.may_enter !== false;/);
  assert.match(store, /\{quotes && \(\s*<a\s*href=\{requestsHref\}/);
  for (const f of ['src/pages/MerchantDashboardPage.tsx', 'src/components/merchant/dashboard/SalesTabs.tsx']) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    assert.match(src, /\{communityAccess\?\.may_enter !== false && \(\s*<a\s*href=\{mainHref\('\/requests'\)\}/, `${f} still links the board unconditionally`);
  }
});

test('offers that arrived before the community shut can still be read and accepted under the card', () => {
  const src = readFileSync(join(ROOT, 'src/pages/Requests.tsx'), 'utf8');
  const running = src.slice(src.indexOf('export function RunningCommunityOrders'));
  assert.match(running, /<PendingOffersWhileClosed \/>/);
  assert.match(running, /\/api\/marketplace\/my-requests/);
  assert.match(running, /r\.state === 'receiving_offers'/);
  assert.match(running, /<RequestDetail request=\{open\} me=\{null\}/);
});

test('the offers list and acceptance really are outside the wall', async () => {
  const { db, raw } = setup();
  raw.exec(`
    INSERT INTO community_offers (id, request_id, merchant_id, price_iqd, state) VALUES ('off1','creq1','cm1',5000,'pending');
    UPDATE community_requests SET state = 'receiving_offers', offer_count = 1 WHERE id = 'creq1';
  `);
  const customer = appAs(db, 'u1');
  const mine = await customer.request('/api/marketplace/my-requests');
  assert.equal(mine.status, 200);
  assert.equal((await json(mine)).requests[0].state, 'receiving_offers');
  const offers = await customer.request('/api/marketplace/requests/creq1/offers');
  assert.equal(offers.status, 200, 'the customer can read the offers with the wall up');
  assert.equal((await json(offers)).offers.length, 1);
  const accept = await post(customer, '/api/marketplace/offers/off1/accept');
  assert.notEqual(accept.status, 503, 'accepting an existing offer is not refused by the wall');
});

test('a guest who sends a link as a print request signs in and comes back with the link', () => {
  const tools = readFileSync(join(ROOT, 'src/pages/Tools.tsx'), 'utf8');
  assert.match(tools, /else navigate\(`\/auth\?next=\$\{encodeURIComponent\(`\/requests\?link=\$\{encodeURIComponent\(url\)\}`\)\}`\)/);
  assert.match(tools, /onClick=\{\(\) => sendLinkAsRequest\(linkResult\.link\.canonical_url\)\}/);
  const requests = readFileSync(join(ROOT, 'src/pages/Requests.tsx'), 'utf8');
  assert.match(requests, /: params\.get\('link'\) \?\? ''/);
});
