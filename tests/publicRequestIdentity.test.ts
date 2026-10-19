/**
 * ACCEPTANCE 34 — A PUBLIC VIEW OF A PRINT REQUEST NEVER NAMES ITS CUSTOMER
 * (P1-02; GAP-MAP conflict 62, the COMMUNITY-V3-GAP recommendation).
 *
 * The request list used to carry `customer_name` and `customer_username`
 * (worker/routes/community.ts), and the board's whitelist (`publicRequest`,
 * worker/routes/marketplace.ts) carried the display name to every reader.
 * Now every read of a request by anyone but its parties — a guest, another
 * member, a workshop browsing its own `?for=me` board, search, the public
 * API — carries the job and nothing of the person: no name, no username, no
 * id, no avatar, no email, no phone. A schema assertion walks each payload
 * for those keys and for the customer's actual values.
 *
 * The parties keep what they need on their own reads: the customer, the
 * workshop with an accepted offer, and the store a direct request was sent to
 * read the name on the request page (`partyRequest`).
 *
 * Run: node --import tsx --test tests/publicRequestIdentity.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { approveMerchants, freshDb, hasColumn, asD1, stubApp, get, json, type StubUser } from './fixtures/app';
import { communityRoutes } from '../worker/routes/community';
import { communitySearchRoutes } from '../worker/routes/communitySearch';
import { marketplaceRoutes, partyRequest, publicRequest } from '../worker/routes/marketplace';
import { publicApiRoutes } from '../worker/routes/publicApi';
import { MATCH_ENGINE } from '../worker/lib/printMatchingStore';

const FUTURE = '2099-01-01T00:00:00.000Z';
const CUSTOMER = { id: 'cust_q7k', name: 'Hadi Jaber', username: 'hadijaber', email: 'hadi.jaber@example.test', phone: '+9647701234567', avatar: 'community/cust_q7k/avatar.webp' };

const GUEST = null;
const STRANGER: StubUser = { id: 'stranger', role: 'customer', email: 'stranger@x.co' };
const WORKSHOP: StubUser = { id: 'maker', role: 'merchant', email: 'maker@x.co' };
const ENGAGED: StubUser = { id: 'engaged', role: 'merchant', email: 'engaged@x.co' };
const OWNER: StubUser = { id: CUSTOMER.id, role: 'customer', email: CUSTOMER.email };

function seed(): DatabaseSync {
  const raw = freshDb();
  const phone = hasColumn(raw, 'users', 'phone');
  raw.exec(`
    INSERT INTO users (id,name,username,email,password_hash,role,avatar_key${phone ? ',phone' : ''}) VALUES
      ('${CUSTOMER.id}','${CUSTOMER.name}','${CUSTOMER.username}','${CUSTOMER.email}','h','customer','${CUSTOMER.avatar}'${phone ? `,'${CUSTOMER.phone}'` : ''}),
      ('stranger','Sara','sara','stranger@x.co','h','customer',NULL${phone ? ',NULL' : ''}),
      ('maker','Ali','ali','maker@x.co','h','merchant',NULL${phone ? ',NULL' : ''}),
      ('engaged','Noor','noor','engaged@x.co','h','merchant',NULL${phone ? ',NULL' : ''});
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m_maker','maker','Ali 3D','active'), ('m_engaged','engaged','Noor Prints','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status,accepts_custom_requests) VALUES
      ('s_maker','m_maker','maker','ali3d','Ali 3D','active',1), ('s_engaged','m_engaged','engaged','noor','Noor Prints','active',1);
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at) VALUES
      ('mem1','maker','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT INTO community_requests (id,customer_id,title,description,category,quantity,material,budget_iqd,governorate,notes,state,status,visibility,offer_count,expires_at,created_at) VALUES
      ('r_board','${CUSTOMER.id}','Vacuum clip','Broken hose clip','spare_part',2,'PETG',15000,'baghdad','call me on my phone','receiving_offers','open','public',1,'${FUTURE}','2026-09-20T00:00:00.000Z'),
      ('r_taken','${CUSTOMER.id}','Cake topper','Two names in gold','decor',1,'PLA',NULL,'erbil','','offer_selected','open','public',1,'${FUTURE}','2026-09-19T00:00:00.000Z');
    INSERT INTO community_offers (id,request_id,merchant_id,store_id,price_iqd,completion_days,state) VALUES
      ('o_taken','r_taken','m_engaged','s_engaged',20000,3,'accepted');
  `);
  // The workshop's own board: the engine marked r_board eligible for m_maker at its current revision.
  raw.prepare('INSERT INTO community_request_matches (id,request_id,merchant_id,eligible,score,engine,revision) VALUES (?,?,?,?,?,?,?)')
    .run('mt1', 'r_board', 'm_maker', 1, 80, MATCH_ENGINE, 1);
  approveMerchants(raw);
  return raw;
}

const app = (raw: DatabaseSync, user: StubUser | null) =>
  stubApp(asD1(raw), user, (a) => {
    a.route('/api/community', communityRoutes);
    a.route('/api/community', communitySearchRoutes);
    a.route('/api/marketplace', marketplaceRoutes);
    a.route('/api/public/v1', publicApiRoutes);
  });

/** Every key that names, reaches or pictures a person. */
const IDENTITY_KEYS = ['customer_name', 'customer_username', 'customer_id', 'customer_avatar', 'customer_email', 'customer_phone', 'username', 'email', 'phone', 'avatarUrl', 'avatar_key', 'user_id', 'author'];

/** The schema assertion: no identity key anywhere in a request payload, at any depth, and none of the customer's values. */
function assertNoIdentity(payload: unknown, where: string) {
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        assert.equal(IDENTITY_KEYS.includes(k), false, `${where}: ${path}.${k} is served`);
        walk(x, `${path}.${k}`);
      }
    }
  };
  walk(payload, '$');
  const text = JSON.stringify(payload);
  for (const value of [CUSTOMER.id, CUSTOMER.name, CUSTOMER.username, CUSTOMER.email, CUSTOMER.phone, CUSTOMER.avatar, 'Hadi']) {
    assert.equal(text.includes(value), false, `${where}: «${value}» appears in the payload`);
  }
  assert.equal(text.includes('call me on my phone'), false, `${where}: the private notes`);
}

const read = async (raw: DatabaseSync, user: StubUser | null, path: string) => {
  const res = await get(app(raw, user), path);
  assert.equal(res.status, 200, `${path} answers`);
  return json(res);
};

test('the whitelist itself: publicRequest names nobody; partyRequest adds the display name and nothing else', () => {
  const row = {
    id: 'r', title: 't', customer_id: CUSTOMER.id, customer_name: CUSTOMER.name, customer_username: CUSTOMER.username,
    email: CUSTOMER.email, phone: CUSTOMER.phone, avatar_key: CUSTOMER.avatar, notes: 'private',
  };
  assertNoIdentity(publicRequest(row), 'publicRequest');
  const party = partyRequest(row) as Record<string, unknown>;
  assert.equal(party.customer_name, CUSTOMER.name);
  const { customer_name: _name, ...rest } = party;
  assertNoIdentity(rest, 'partyRequest beyond the name');
});

test('acceptance 34: the community list, search and the board name nobody — to a guest or to another member', async () => {
  const raw = seed();
  for (const user of [GUEST, STRANGER]) {
    const who = user ? 'a member' : 'a guest';
    const list = await read(raw, user, '/api/community/requests');
    assert.deepEqual((list.requests as Array<{ id: string }>).map((r) => r.id), ['r_board'], 'the board rows only');
    assert.equal((list.requests as Array<Record<string, unknown>>)[0].title, 'Vacuum clip', 'the job is there');
    assertNoIdentity(list, `community list (${who})`);

    assertNoIdentity(await read(raw, user, '/api/community/requests?q=clip'), `community list search (${who})`);
    const found = await read(raw, user, '/api/community/search?q=clip&types=requests');
    assert.ok(JSON.stringify(found).includes('Vacuum clip'), 'search finds the request');
    assertNoIdentity(found, `search (${who})`);

    const board = await read(raw, user, '/api/marketplace/requests');
    assert.ok(JSON.stringify(board).includes('Vacuum clip'));
    assertNoIdentity(board, `board (${who})`);
  }
});

test('acceptance 34: the request page names the customer to its parties only', async () => {
  const raw = seed();
  for (const user of [GUEST, STRANGER, WORKSHOP]) {
    const page = await read(raw, user, '/api/marketplace/requests/r_board');
    assert.equal((page.request as Record<string, unknown>).title, 'Vacuum clip');
    assertNoIdentity(page.request, `request page (${user?.id ?? 'guest'})`);
  }
  // The customer reads their own request with their name; so does the workshop with the accepted offer.
  const own = await read(raw, OWNER, '/api/marketplace/requests/r_board');
  assert.equal((own.request as Record<string, unknown>).customer_name, CUSTOMER.name);
  assert.equal(own.is_owner, true);
  const engaged = await read(raw, ENGAGED, '/api/marketplace/requests/r_taken');
  assert.equal((engaged.request as Record<string, unknown>).customer_name, CUSTOMER.name, 'the workshop dealing with them');
  // The customer's own list keeps the parties' view.
  const mine = await read(raw, OWNER, '/api/marketplace/my-requests');
  assert.ok((mine.requests as Array<Record<string, unknown>>).every((r) => r.customer_name === CUSTOMER.name));
});

test('acceptance 34: a workshop\'s own «طلبات تناسبك» board is another account\'s read — the job and its rank, nobody\'s name', async () => {
  const raw = seed();
  const board = await read(raw, WORKSHOP, '/api/community/requests?for=me');
  assert.deepEqual((board.requests as Array<{ id: string }>).map((r) => r.id), ['r_board'], 'the eligible job is listed');
  assert.equal((board.requests as Array<Record<string, unknown>>)[0].match_score, 80, 'the workshop\'s own rank stays');
  assertNoIdentity(board, 'the workshop board');
});

test('acceptance 34: the public API never named the customer and still does not', async () => {
  const raw = seed();
  const list = await read(raw, GUEST, '/api/public/v1/community/requests');
  assert.ok(JSON.stringify(list).includes('Vacuum clip'));
  assertNoIdentity(list, 'public API list');
  assertNoIdentity(await read(raw, GUEST, '/api/public/v1/community/requests/r_board'), 'public API request');
});
