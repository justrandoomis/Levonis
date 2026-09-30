/**
 * MODERATION V2 (0162; docs/COMMUNITY_ECOSYSTEM.md §9.6) over the real routes,
 * mounted the way worker/index.ts mounts them — the banned-writes middleware
 * first, then the community, chat, marketplace and moderation routers — and
 * every rule as an attack:
 *
 *   · a hidden post or comment is gone from the feed, trending, search, the
 *     creator grid and the saved list; its page is a 404 to everybody but its
 *     author (who is told why) and staff;
 *   · a banned author's content is gone everywhere, their page is the 404 a
 *     private one is, and every write they try is refused at the middleware —
 *     but they can still read, appeal, sign out and clear their bell;
 *   · a restricted account cannot post, comment, offer, request or send a
 *     direct message, and can still read, like and follow; an order's thread
 *     stays open to it;
 *   · a suspension whose end date passed is over — no cron runs, the next read
 *     says so, in SQL and in the session alike;
 *   · the ladder refuses a lighter decision than the one in force (409);
 *   · one appeal per decision; an accepted appeal restores, never over a newer
 *     decision;
 *   · every decision is one action row and one audit row, exactly;
 *   · a ban suspends the person's store the way the store door does.
 *
 * The acting user is the STORED row (`SELECT * FROM users`), as the session
 * loader reads it, so a decision is in force from the next request exactly as
 * in production.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { freshDb, asD1, stubApp, post, get, put, json, count, row, all, type StubUser, type Mount } from './fixtures/app';
import { communityRoutes } from '../worker/routes/community';
import { communityPostRoutes } from '../worker/routes/communityPosts';
import { communitySocialRoutes } from '../worker/routes/communitySocial';
import { communitySearchRoutes } from '../worker/routes/communitySearch';
import { chatRoutes } from '../worker/routes/chats';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { notificationRoutes } from '../worker/routes/notifications';
import { adminModerationRoutes, moderationRoutes } from '../worker/routes/adminModeration';
import {
  AUTHOR_VISIBLE_SQL,
  HIDDEN_AUTHORS_SQL,
  assertMayWrite,
  effectiveStatus,
  refuseBannedWrites,
  type WriteKind,
} from '../worker/lib/userStatus';
import { publicUser, type AppContext, type SessionUser } from '../worker/lib/types';
import { HttpError } from '../worker/lib/http';

// ------------------------------------------------------------------ harness

const mount: Mount = (a) => {
  // worker/index.ts order: the banned-writes middleware before every router.
  a.use('*', refuseBannedWrites);
  a.route('/api/community', communityRoutes);
  a.route('/api/community', communityPostRoutes);
  a.route('/api/community', communitySocialRoutes);
  a.route('/api/community', communitySearchRoutes);
  a.route('/api/chats', chatRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
  a.route('/api/notifications', notificationRoutes);
  a.route('/api', moderationRoutes);
  a.route('/api/admin', adminModerationRoutes);
};

function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username,bio,phone_e164) VALUES
      ('sara','Sara Kareem','sara@x.co','h','customer','sara','I print dragons','+9647700000009'),
      ('eve','Eve','eve@x.co','h','customer','eve','',NULL),
      ('ali','Ali','ali@x.co','h','merchant','ali','',NULL),
      ('omar','Omar','omar@x.co','h','customer','omar','',NULL),
      ('boss','Boss','boss@x.co','h','admin','boss','',NULL);
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m_ali','ali','Ali 3D','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status) VALUES ('s_ali','m_ali','ali','ali3d','Ali 3D Store','active');
    INSERT INTO file_objects (object_key,visibility,domain,owner_id,entity_id,mime_type,byte_size,width,height) VALUES
      ('users/sara/posts/a1.webp','public','users','sara','sara','image/webp',1000,1200,900),
      ('users/eve/posts/e1.webp','public','users','eve','eve','image/webp',1000,800,800),
      ('users/omar/posts/o1.webp','public','users','omar','omar','image/webp',1000,800,800),
      ('merchants/ali/public/w1.webp','public','merchants','ali','ali','image/webp',1000,1000,1000);
    INSERT INTO orders (id,user_id,status,total_iqd,merchant_id,store_id,seller_type,origin,address_snapshot,delivery_method_id,delivery_method_snapshot,payment_method_id,subtotal_iqd,exchange_rate,due_on_delivery_iqd)
      VALUES ('shop_eve','eve','pending',1000,NULL,NULL,'levonis','platform','{}','d','{}','wallet',1000,1500,0);
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  return raw;
}

/** The caller as their STORED row — what the session loader hands the routes — or a guest. */
const as = (raw: DatabaseSync, id: string | null) =>
  stubApp(asD1(raw), id ? (raw.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as StubUser) : null, mount);
const desk = (raw: DatabaseSync) => as(raw, 'boss');

const MEDIA: Record<string, string> = {
  sara: 'users/sara/posts/a1.webp',
  eve: 'users/eve/posts/e1.webp',
  omar: 'users/omar/posts/o1.webp',
  ali: 'merchants/ali/public/w1.webp',
};

async function published(raw: DatabaseSync, who: string, title = 'Articulated dragon', tags: string[] = ['dragon']): Promise<string> {
  const made = await post(as(raw, who), '/api/community/posts', { title, body: 'Printed in two colours.', kind: 'project', tags, media: [{ key: MEDIA[who], kind: 'image' }] });
  assert.equal(made.status, 201, JSON.stringify(await json(made.clone())));
  const id = (await json(made)).post.id as string;
  const pub = await post(as(raw, who), `/api/community/posts/${id}/publish`);
  assert.equal(pub.status, 200, JSON.stringify(await json(pub.clone())));
  return id;
}

const ids = (rows: Array<{ id: string }> | undefined) => (rows ?? []).map((r) => r.id);

/** Every public list a project can appear in, as this viewer reads them. */
async function listings(raw: DatabaseSync, viewer: string | null, q = 'dragon') {
  const a = as(raw, viewer);
  const read = async (path: string) => {
    const res = await get(a, path);
    assert.equal(res.status, 200, `${path} → ${res.status} ${await res.clone().text()}`);
    return json(res);
  };
  return {
    posts: ids((await read('/api/community/posts')).posts),
    feed: ids((await read('/api/community/feed')).posts),
    rail: ids((await read('/api/community/posts/trending')).posts),
    trending: ids((await read('/api/community/trending')).projects),
    search: ids((await read(`/api/community/search?q=${q}`)).sections.projects.rows),
    suggest: ((await read(`/api/community/search/suggest?q=${q}`)).suggestions as Array<{ type: string; href: string }>)
      .filter((s) => s.type === 'project')
      .map((s) => s.href.split('/').pop()!),
  };
}

function assertNowhere(where: Awaited<ReturnType<typeof listings>>, id: string, label: string) {
  for (const [list, got] of Object.entries(where)) assert.ok(!got.includes(id), `${label}: ${id} is still in ${list}`);
}
function assertEverywhere(where: Awaited<ReturnType<typeof listings>>, id: string, label: string) {
  for (const [list, got] of Object.entries(where)) assert.ok(got.includes(id), `${label}: ${id} is missing from ${list}`);
}

const hidePost = (raw: DatabaseSync, id: string, body: Record<string, unknown>) => post(desk(raw), `/api/admin/moderation/posts/${id}/hide`, body);
const setStatus = (raw: DatabaseSync, id: string, body: Record<string, unknown>) => post(desk(raw), `/api/admin/moderation/users/${id}/status`, body);
const code = async (res: Response) => (await json(res.clone())).code as string | undefined;
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString();

// ================================================================ hidden content

test('a hidden project leaves the feed, trending, search, the creator grid and saved lists; its page is 404 to others and shows the author why', async () => {
  const raw = seed();
  const id = await published(raw, 'sara');
  assert.equal((await put(as(raw, 'eve'), `/api/community/posts/${id}/save`)).status, 200);
  assertEverywhere(await listings(raw, null), id, 'before the hide');

  const res = await hidePost(raw, id, { reason: 'Copied from another maker' });
  assert.equal(res.status, 200, await res.clone().text());
  const hidden = await json(res);
  assert.equal(hidden.hidden, true);
  assert.match(hidden.action_id, /^mod/);

  assertNowhere(await listings(raw, null), id, 'guest');
  assertNowhere(await listings(raw, 'eve'), id, 'signed in');
  assert.deepEqual(ids((await json(await get(as(raw, null), '/api/community/posts?author=sara'))).posts), [], 'the creator grid');
  assert.deepEqual(ids((await json(await get(as(raw, 'eve'), '/api/community/saved'))).posts), [], 'the saved list');

  // The page: 404 to a stranger and a guest, the reason to the author, the page to staff.
  assert.equal((await get(as(raw, 'eve'), `/api/community/posts/${id}`)).status, 404);
  assert.equal((await get(as(raw, null), `/api/community/posts/${id}`)).status, 404);
  const own = (await json(await get(as(raw, 'sara'), `/api/community/posts/${id}`))).post;
  assert.equal(own.hidden.reason, 'Copied from another maker');
  assert.equal((await get(desk(raw), `/api/community/posts/${id}`)).status, 200);
  // Nobody but the author and staff may touch it either.
  assert.equal((await put(as(raw, 'omar'), `/api/community/posts/${id}/like`)).status, 404);

  // One action, one audit row, one notice with the reason and the appeal door.
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM moderation_actions WHERE target_type = 'post' AND target_id = ? AND action = 'hide'", id), 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'admin.moderation.post_hidden' AND target = ?", id), 1);
  const note = row<{ link: string; title_en: string; body_ar: string; meta: string }>(
    raw,
    "SELECT link, title_en, body_ar, meta FROM user_notifications WHERE user_id = 'sara' AND kind = 'moderation_action'"
  )!;
  assert.equal(note.link, `/moderation?action=${hidden.action_id}`);
  assert.equal(note.title_en, 'Levonis hid your project “Articulated dragon”');
  assert.match(note.body_ar, /Copied from another maker/);
  assert.ok(JSON.parse(note.meta).title_ckb, 'the Sorani title travels in meta');

  // A second press is a replay: no second row anywhere.
  assert.equal((await json(await hidePost(raw, id, { reason: 'Copied from another maker' }))).replayed, true);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM moderation_actions'), 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'moderation_action'"), 1);

  // A hide needs its reason; an unknown post is the desk's own 404.
  assert.equal((await hidePost(raw, id, { hidden: true })).status, 400);
  assert.equal(await code(await hidePost(raw, 'prj_nope', { reason: 'Spam spam' })), 'MODERATION_TARGET_NOT_FOUND');

  // Lifting it puts it back everywhere, as its own action.
  const lifted = await json(await hidePost(raw, id, { hidden: false, reason: 'Reviewed' }));
  assert.equal(lifted.hidden, false);
  assertEverywhere(await listings(raw, null), id, 'after the lift');
  assert.deepEqual(
    all(raw, "SELECT action FROM moderation_actions WHERE target_id = ? ORDER BY created_at, rowid", id).map((r) => r.action),
    ['hide', 'restore']
  );
});

test('a hidden comment leaves the thread and the counter; its author and staff still see it; lifting it restores both', async () => {
  const raw = seed();
  const id = await published(raw, 'sara');
  const made = await post(as(raw, 'eve'), `/api/community/posts/${id}/comments`, { body: 'This is spam spam spam' });
  assert.equal(made.status, 201, await made.clone().text());
  const cid = (await json(made)).comment.id as string;
  assert.equal(row<{ comment_count: number }>(raw, 'SELECT comment_count FROM community_posts WHERE id = ?', id)!.comment_count, 1);

  const res = await post(desk(raw), `/api/admin/moderation/comments/${cid}/hide`, { reason: 'Spam in the comments' });
  assert.equal(res.status, 200, await res.clone().text());
  const guest = await json(await get(as(raw, null), `/api/community/posts/${id}/comments`));
  assert.deepEqual(ids(guest.comments), []);
  assert.equal(guest.total, 0);
  assert.equal(row<{ comment_count: number }>(raw, 'SELECT comment_count FROM community_posts WHERE id = ?', id)!.comment_count, 0, "0154's trigger keeps the count");
  const mine = await json(await get(as(raw, 'eve'), `/api/community/posts/${id}/comments`));
  assert.deepEqual(mine.comments.map((c: { id: string; state: string }) => [c.id, c.state]), [[cid, 'hidden']]);
  assert.deepEqual(ids((await json(await get(desk(raw), `/api/community/posts/${id}/comments`))).comments), [cid]);
  assert.equal(row<{ admin_hidden_reason: string }>(raw, 'SELECT admin_hidden_reason FROM community_comments WHERE id = ?', cid)!.admin_hidden_reason, 'Spam in the comments');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'eve' AND kind = 'moderation_action'"), 1);

  const back = await post(desk(raw), `/api/admin/moderation/comments/${cid}/hide`, { hidden: false });
  assert.equal(back.status, 200, await back.clone().text());
  assert.deepEqual(ids((await json(await get(as(raw, null), `/api/community/posts/${id}/comments`))).comments), [cid]);
  assert.equal(row<{ comment_count: number }>(raw, 'SELECT comment_count FROM community_posts WHERE id = ?', id)!.comment_count, 1);
});

test('a comment under a request is hidden from its discussion by the same desk', async () => {
  const raw = seed();
  raw.exec(`
    INSERT INTO community_requests (id,customer_id,title,description,status,state,visibility) VALUES ('req_1','omar','Phone stand','A stand','open','open','public');
    INSERT INTO community_request_comments (id,request_id,author_id,kind,body) VALUES ('rqc_1','req_1','eve','public_comment','Buy followers here');
  `);
  const res = await post(desk(raw), '/api/admin/moderation/request-comments/rqc_1/hide', { reason: 'Advertising' });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(row<{ state: string }>(raw, "SELECT state FROM community_request_comments WHERE id = 'rqc_1'")!.state, 'hidden');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM moderation_actions WHERE target_type = 'request_comment' AND subject_user_id = 'eve'"), 1);
  // The server's own rows are nobody's words and are not moderated here.
  raw.exec("INSERT INTO community_request_comments (id,request_id,author_id,kind,body) VALUES ('rqc_sys','req_1',NULL,'system_update','{}')");
  assert.equal(await code(await post(desk(raw), '/api/admin/moderation/request-comments/rqc_sys/hide', { reason: 'Nope nope' })), 'MODERATION_TARGET_NOT_FOUND');
});

// ================================================================ a ban

test('a banned author\'s content is gone everywhere, their page is a 404, and every write is refused at the middleware — reads, appeals and signing out stay', async () => {
  const raw = seed();
  const dragon = await published(raw, 'sara');
  const stand = await published(raw, 'eve', 'Phone stand', ['stand']);
  const made = await post(as(raw, 'sara'), `/api/community/posts/${stand}/comments`, { body: 'Lovely stand' });
  assert.equal(made.status, 201);
  const cid = (await json(made)).comment.id as string;
  const creators = async () => ids((await json(await get(as(raw, null), '/api/community/creators'))).creators);
  assert.ok((await creators()).includes('sara'));

  const res = await setStatus(raw, 'sara', { status: 'ban', reason: 'A spam ring' });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await json(res)).status, 'banned');

  assertNowhere(await listings(raw, null), dragon, 'guest');
  assertNowhere(await listings(raw, 'eve'), dragon, 'signed in');
  assert.ok(!(await creators()).includes('sara'), 'the creators list');
  const makers = (await json(await get(as(raw, null), '/api/community/search/suggest?q=sar'))).suggestions as Array<{ type: string; text: string }>;
  assert.ok(!makers.some((s) => s.type === 'creator'), 'a suggestion');
  assert.equal((await get(as(raw, null), '/api/community/creators/sara')).status, 404, 'the page answers like a private one');
  assert.equal((await get(as(raw, 'eve'), '/api/community/creators/sara')).status, 404);
  assert.equal((await get(as(raw, 'eve'), `/api/community/posts/${dragon}`)).status, 404);
  assert.equal((await put(as(raw, 'eve'), '/api/community/users/sara/follow')).status, 404, 'no page, no follow');
  const thread = await json(await get(as(raw, null), `/api/community/posts/${stand}/comments`));
  assert.ok(!ids(thread.comments).includes(cid), 'her comment under somebody else\'s project');
  assert.equal(thread.total, 0);
  // Staff still see everything; she still sees her own.
  assert.ok(ids((await json(await get(desk(raw), `/api/community/posts/${stand}/comments`))).comments).includes(cid));
  assert.equal((await get(as(raw, 'sara'), `/api/community/posts/${dragon}`)).status, 200);
  assert.equal((await get(as(raw, 'sara'), '/api/community/creators/sara')).status, 200);

  // Every write, at the middleware — `save` has no door check of its own, so its 403 is the middleware's.
  const sara = as(raw, 'sara');
  for (const [method, path, body] of [
    ['POST', '/api/community/posts', { title: 'Another one', media: [] }],
    ['PUT', `/api/community/posts/${stand}/save`, {}],
    ['PUT', `/api/community/posts/${stand}/like`, {}],
    ['POST', `/api/community/posts/${stand}/comments`, { body: 'hello there' }],
    ['PUT', '/api/community/users/eve/follow', {}],
    ['POST', '/api/community/reports', { target_type: 'post', target_id: stand, reason: 'spam' }],
    ['POST', '/api/chats/open', { userId: 'eve' }],
    ['POST', '/api/marketplace/requests', { title: 'A stand please', description: 'A phone stand, black' }],
  ] as const) {
    const r = await sara.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(r.status, 403, `${method} ${path} → ${r.status}`);
    assert.equal((await r.json() as { code: string }).code, 'USER_BANNED', `${method} ${path}`);
  }
  // Reads stay; the bell can be cleared; the appeal door is open.
  assert.equal((await get(sara, '/api/community/feed')).status, 200);
  const standing = await json(await get(sara, '/api/moderation/status'));
  assert.equal(standing.standing.status, 'banned');
  assert.equal(standing.standing.reason, 'A spam ring');
  assert.equal((await post(sara, '/api/notifications/read', {})).status, 200);
  const appeal = await post(sara, '/api/moderation/appeals', { action_id: standing.actions[0].id, body: 'That was not me' });
  assert.equal(appeal.status, 201, await appeal.clone().text());
});

test('the middleware answers only for a banned account\'s non-read API request, and keeps its three doors open', async () => {
  const app = new Hono<AppContext>();
  let who: Partial<SessionUser> | null = { id: 'u1', role: 'customer', status: 'banned' };
  app.use('*', async (c, next) => {
    c.set('user', who as never);
    await next();
  });
  app.use('*', refuseBannedWrites);
  app.all('*', (c) => c.json({ ok: true }));
  app.onError((err, c) => (err instanceof HttpError ? c.json({ code: err.code }, err.status as 403) : c.json({ err: String(err) }, 500)));
  const hit = (method: string, path: string) => app.request(path, { method });
  assert.equal((await hit('POST', '/api/community/posts')).status, 403);
  assert.equal((await hit('DELETE', '/api/community/posts/p1')).status, 403);
  assert.equal((await hit('PATCH', '/api/profile')).status, 403);
  assert.equal((await hit('GET', '/api/community/feed')).status, 200, 'reads stay');
  assert.equal((await hit('HEAD', '/api/community/feed')).status, 200);
  assert.equal((await hit('POST', '/api/auth/logout')).status, 200, 'signing out');
  assert.equal((await hit('POST', '/api/moderation/appeals')).status, 200, 'the appeal door');
  assert.equal((await hit('POST', '/api/notifications/read')).status, 200, 'clearing the bell');
  assert.equal((await hit('POST', '/api/moderation/status')).status, 403, 'only the appeals under /moderation');
  who = { id: 'u1', role: 'customer', status: 'suspended' };
  assert.equal((await hit('POST', '/api/community/posts')).status, 200, 'a suspension is enforced at the doors, not here');
  who = null;
  assert.equal((await hit('POST', '/api/community/posts')).status, 200, 'a guest is the routes\' own business');
});

// ================================================================ a restriction

test('a restricted account cannot post, comment, offer, request or DM — and can still read, like and follow; an order\'s thread stays open', async () => {
  const raw = seed();
  const dragon = await published(raw, 'sara');
  const before = await published(raw, 'eve', 'Phone stand', ['stand']);
  const dm = (await json(await post(as(raw, 'eve'), '/api/chats/open', { userId: 'omar' }))).chatId as string;
  assert.ok(dm);

  const until = tomorrow();
  const res = await setStatus(raw, 'eve', { status: 'restrict', reason: 'Cool down for a day', until });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await json(res)).until, until);

  const eve = as(raw, 'eve');
  const refused = async (r: Response | Promise<Response>, label: string) => {
    const got = await r;
    assert.equal(got.status, 403, `${label} → ${got.status} ${await got.clone().text()}`);
    const b = await json(got);
    assert.equal(b.code, 'USER_RESTRICTED', label);
    assert.equal(b.details?.until, until, `${label} names the end date`);
  };
  await refused(post(eve, '/api/community/posts', { title: 'Another stand', media: [{ key: MEDIA.eve, kind: 'image' }] }), 'a post');
  await refused(post(eve, `/api/community/posts/${dragon}/comments`, { body: 'Nice dragon' }), 'a comment');
  await refused(post(eve, '/api/marketplace/requests', { title: 'A stand please', description: 'A phone stand, black' }), 'a request');
  await refused(post(eve, '/api/marketplace/requests/req_x/offers', { price_iqd: 1000 }), 'an offer');
  await refused(post(eve, '/api/chats/open', { userId: 'sara' }), 'a new DM');
  await refused(post(eve, `/api/chats/${dm}/messages`, { body: 'hi again' }), 'a DM that exists');

  // Reads, likes and follows stay; her earlier project is still public.
  assert.equal((await get(eve, '/api/community/feed')).status, 200);
  assert.equal((await put(eve, `/api/community/posts/${dragon}/like`)).status, 200);
  assert.equal((await put(eve, '/api/community/users/sara/follow')).status, 200);
  assert.ok(ids((await json(await get(as(raw, null), '/api/community/posts'))).posts).includes(before), 'a restriction hides nothing');

  // The order's own thread is not a DM.
  const order = await json(await post(eve, '/api/chats/open', { orderId: 'shop_eve' }));
  assert.ok(order.chatId);
  assert.equal((await post(eve, `/api/chats/${order.chatId}/messages`, { body: 'Where is my parcel?' })).status, 200);
  // And the session says so, for the banner.
  const me = publicUser(raw.prepare("SELECT * FROM users WHERE id = 'eve'").get() as unknown as SessionUser);
  assert.deepEqual(me.moderation, { status: 'restricted', reason: 'Cool down for a day', until });
});

// ================================================================ time

test('a suspension whose end date has passed is over at the next read — no cron — in SQL and in the session alike', async () => {
  const raw = seed();
  const dragon = await published(raw, 'sara');
  const stand = await published(raw, 'eve', 'Phone stand', ['stand']);
  const res = await setStatus(raw, 'sara', { status: 'suspend', reason: 'Harassment', until: tomorrow() });
  assert.equal(res.status, 200, await res.clone().text());

  assertNowhere(await listings(raw, null), dragon, 'while suspended');
  assert.equal((await get(as(raw, null), '/api/community/creators/sara')).status, 404);
  const like = await put(as(raw, 'sara'), `/api/community/posts/${stand}/like`);
  assert.equal(like.status, 403);
  assert.equal((await json(like)).code, 'USER_SUSPENDED');
  assert.equal(await code(await put(as(raw, 'sara'), '/api/community/users/eve/follow')), 'USER_SUSPENDED');

  // Nothing runs. The date simply passes.
  raw.exec("UPDATE users SET status_until = '2020-01-01T00:00:00.000Z' WHERE id = 'sara'");
  assertEverywhere(await listings(raw, null), dragon, 'after the end date');
  assert.equal((await get(as(raw, null), '/api/community/creators/sara')).status, 200);
  assert.equal((await put(as(raw, 'sara'), `/api/community/posts/${stand}/like`)).status, 200);
  assert.equal((await json(await get(as(raw, 'sara'), '/api/moderation/status'))).standing.status, 'active');
  const stored = raw.prepare("SELECT * FROM users WHERE id = 'sara'").get() as unknown as SessionUser;
  assert.equal(stored.status, 'suspended', 'the row still says it — the reading does not');
  assert.deepEqual(publicUser(stored).moderation, { status: 'active', reason: '', until: null });
  // A lapsed suspension is no bar to a lighter step either.
  assert.equal((await setStatus(raw, 'sara', { status: 'restrict', reason: 'Keep it calm' })).status, 200);
});

test('the one SQL fragment and the JS reading agree on every standing', () => {
  const raw = seed();
  const past = '2020-01-01T00:00:00.000Z';
  const future = tomorrow();
  raw.exec(`
    UPDATE users SET status = 'restricted' WHERE id = 'eve';
    UPDATE users SET status = 'suspended', status_until = '${future}' WHERE id = 'sara';
    UPDATE users SET status = 'suspended', status_until = '${past}' WHERE id = 'omar';
    UPDATE users SET status = 'banned', status_until = '${past}' WHERE id = 'ali';
  `);
  const visible = all<{ id: string }>(raw, `SELECT u.id FROM users u WHERE ${AUTHOR_VISIBLE_SQL('u')} ORDER BY u.id`).map((r) => r.id);
  assert.deepEqual(visible, ['boss', 'eve', 'omar'], 'restricted and lapsed are shown; suspended and banned (whatever its date) are not');
  const hidden = all<{ id: string }>(raw, `${HIDDEN_AUTHORS_SQL} ORDER BY hu.id`).map((r) => r.id);
  assert.deepEqual(hidden, ['ali', 'sara']);
  for (const r of all<Record<string, unknown>>(raw, 'SELECT * FROM users')) {
    const s = effectiveStatus(r);
    assert.equal(s === 'suspended' || s === 'banned', hidden.includes(String(r.id)), `${String(r.id)}: ${s}`);
  }
  // What each standing takes away.
  const refusedKinds = (status: string, until: string | null = null) =>
    (['post', 'comment', 'offer', 'request', 'dm', 'follow', 'like'] as WriteKind[]).filter((k) => {
      try {
        assertMayWrite({ status, status_until: until }, k);
        return false;
      } catch {
        return true;
      }
    });
  assert.deepEqual(refusedKinds('active'), []);
  assert.deepEqual(refusedKinds('restricted'), ['post', 'comment', 'offer', 'request', 'dm']);
  assert.deepEqual(refusedKinds('suspended'), ['post', 'comment', 'offer', 'request', 'dm', 'follow', 'like']);
  assert.deepEqual(refusedKinds('banned'), ['post', 'comment', 'offer', 'request', 'dm', 'follow', 'like']);
  assert.deepEqual(refusedKinds('suspended', past), [], 'lapsed');
  assert.deepEqual(refusedKinds('banned', past), ['post', 'comment', 'offer', 'request', 'dm', 'follow', 'like'], 'a ban never lapses');
  assert.equal(effectiveStatus({ status: 'restricted', status_until: 'garbled' }), 'restricted', 'an unreadable date keeps the restriction');
  assert.equal(effectiveStatus(null), 'active');
  assert.equal(effectiveStatus({}), 'active', 'a row before 0162');
});

// ================================================================ the ladder

test('the ladder: a decision lighter than the one in force is 409 until a restore; staff, dates and words are checked', async () => {
  const raw = seed();
  assert.equal((await setStatus(raw, 'omar', { status: 'ban', reason: 'Fraud attempts' })).status, 200);
  assert.equal((await json(await setStatus(raw, 'omar', { status: 'ban', reason: 'Fraud attempts' }))).replayed, true, 'a second press');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM moderation_actions WHERE target_id = 'omar'"), 1);
  for (const status of ['restrict', 'suspend']) {
    const r = await setStatus(raw, 'omar', { status, reason: 'Lighter step' });
    assert.equal(r.status, 409, status);
    const b = await json(r);
    assert.equal(b.code, 'MODERATION_LADDER');
    assert.equal(b.details.current, 'banned');
  }
  assert.equal((await setStatus(raw, 'omar', { status: 'warn', reason: 'A warning never lowers' })).status, 200);
  const restored = await json(await setStatus(raw, 'omar', { status: 'restore', reason: 'Reviewed' }));
  assert.equal(restored.status, 'active');
  assert.equal((await json(await setStatus(raw, 'omar', { status: 'restore' }))).replayed, true, 'nothing left to lift');
  assert.equal((await setStatus(raw, 'omar', { status: 'restrict', reason: 'Start again' })).status, 200);
  assert.equal((await setStatus(raw, 'omar', { status: 'suspended', reason: 'The status word reads as its step', until: tomorrow() })).status, 200);
  assert.equal(await code(await setStatus(raw, 'omar', { status: 'restrict', reason: 'Lighter' })), 'MODERATION_LADDER');
  assert.equal(row<{ status: string }>(raw, "SELECT status FROM users WHERE id = 'omar'")!.status, 'suspended');

  assert.equal(await code(await setStatus(raw, 'boss', { status: 'ban', reason: 'Nope nope' })), 'MODERATION_STAFF_TARGET');
  assert.equal(await code(await setStatus(raw, 'sara', { status: 'suspend', reason: 'Past date', until: '2020-01-01' })), 'MODERATION_UNTIL_INVALID');
  assert.equal(await code(await setStatus(raw, 'sara', { status: 'suspend', reason: 'Bad date', until: 'soon' })), 'MODERATION_UNTIL_INVALID');
  assert.equal(await code(await setStatus(raw, 'nobody', { status: 'warn', reason: 'Who?' })), 'MODERATION_TARGET_NOT_FOUND');
  assert.equal((await setStatus(raw, 'sara', { status: 'vanish', reason: 'x x x' })).status, 400);
  assert.equal((await setStatus(raw, 'sara', { status: 'ban' })).status, 400, 'a reason is required');
  // The desk is staff only.
  assert.equal((await post(as(raw, 'eve'), '/api/admin/moderation/users/sara/status', { status: 'ban', reason: 'I do not like her' })).status, 403);
  assert.equal(row<{ status: string }>(raw, "SELECT status FROM users WHERE id = 'sara'")!.status, 'active');
});

// ================================================================ appeals

test('one appeal per decision; an accepted appeal restores — never over a newer decision — and the person is told', async () => {
  const raw = seed();
  const dragon = await published(raw, 'sara');
  const hideId = (await json(await hidePost(raw, dragon, { reason: 'Looks copied' }))).action_id as string;
  const suspendId = (await json(await setStatus(raw, 'sara', { status: 'suspend', reason: 'Too many reports', until: tomorrow() }))).action_id as string;

  const sara = as(raw, 'sara');
  const status = await json(await get(sara, '/api/moderation/status'));
  assert.equal(status.standing.status, 'suspended');
  assert.deepEqual(status.actions.map((a: { id: string; appealable: boolean }) => [a.id, a.appealable]), [[suspendId, true], [hideId, true]]);
  assert.equal(status.actions[1].target_label, 'Articulated dragon');

  const filed = await post(sara, '/api/moderation/appeals', { action_id: suspendId, body: 'Those reports were a brigade' });
  assert.equal(filed.status, 201, await filed.clone().text());
  const appealId = (await json(filed)).appeal.id as string;
  assert.equal(await code(await post(sara, '/api/moderation/appeals', { action_id: suspendId, body: 'Again, please' })), 'APPEAL_EXISTS');
  assert.equal(await code(await post(as(raw, 'eve'), '/api/moderation/appeals', { action_id: suspendId, body: 'Not mine to appeal' })), 'APPEAL_NOT_FOUND');
  assert.equal((await post(sara, '/api/moderation/appeals', { action_id: suspendId, body: String('x').repeat(1001) })).status, 400, 'body ≤ 1000');
  assert.equal((await json(await get(sara, '/api/moderation/appeals'))).appeals.length, 1);
  assert.equal((await json(await get(sara, '/api/moderation/status'))).actions[0].appealable, false, 'one appeal per decision');

  const queue = await json(await get(desk(raw), '/api/admin/moderation/appeals'));
  assert.deepEqual(queue.appeals.map((a: { id: string }) => a.id), [appealId]);
  assert.equal(queue.appeals[0].user.status, 'suspended');

  const decided = await post(desk(raw), `/api/admin/moderation/appeals/${appealId}`, { state: 'accepted', decision: 'The reports did not hold up' });
  assert.equal(decided.status, 200, await decided.clone().text());
  const d = await json(decided);
  assert.equal(d.restored, true);
  assert.equal(row<{ status: string }>(raw, "SELECT status FROM users WHERE id = 'sara'")!.status, 'active');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM moderation_actions WHERE id = ? AND action = 'restore' AND target_id = 'sara'", d.restore_action_id), 1);
  const told = row<{ title_en: string; body_en: string }>(raw, "SELECT title_en, body_en FROM user_notifications WHERE event_key = ?", `moderation_appeal:${appealId}`)!;
  assert.equal(told.title_en, 'Your appeal was accepted');
  assert.match(told.body_en, /did not hold up/);
  // An appeal is decided once.
  assert.equal(await code(await post(desk(raw), `/api/admin/moderation/appeals/${appealId}`, { state: 'rejected' })), 'APPEAL_DECIDED');
  assert.equal((await json(await post(desk(raw), `/api/admin/moderation/appeals/${appealId}`, { state: 'accepted' }))).replayed, true);
  assert.equal(await code(await post(desk(raw), '/api/admin/moderation/appeals/apl_nope', { state: 'accepted' })), 'APPEAL_NOT_FOUND');

  // The hide, appealed and accepted: the project is back.
  const second = await json(await post(sara, '/api/moderation/appeals', { action_id: hideId, body: 'I designed it myself' }));
  assert.equal((await json(await post(desk(raw), `/api/admin/moderation/appeals/${second.appeal.id}`, { state: 'accepted' }))).restored, true);
  assertEverywhere(await listings(raw, null), dragon, 'after the appeal');
  // A restore is not a decision against anybody.
  const restoreId = String(all(raw, "SELECT id FROM moderation_actions WHERE action = 'restore' AND target_type = 'post'")[0].id);
  assert.equal(await code(await post(sara, '/api/moderation/appeals', { action_id: restoreId, body: 'Appeal a restore?' })), 'APPEAL_NOT_FOUND');

  // A newer decision stands: suspend, then ban; the suspension's appeal wins nothing back.
  const s2 = (await json(await setStatus(raw, 'sara', { status: 'suspend', reason: 'Round two', until: tomorrow() }))).action_id as string;
  assert.equal((await setStatus(raw, 'sara', { status: 'ban', reason: 'Round three' })).status, 200);
  const late = await json(await post(as(raw, 'sara'), '/api/moderation/appeals', { action_id: s2, body: 'About the suspension' }));
  const lateDecision = await json(await post(desk(raw), `/api/admin/moderation/appeals/${late.appeal.id}`, { state: 'accepted' }));
  assert.equal(lateDecision.restored, false);
  assert.equal(row<{ status: string }>(raw, "SELECT status FROM users WHERE id = 'sara'")!.status, 'banned');
  // A rejection is told too.
  const ban = String(row(raw, "SELECT id FROM moderation_actions WHERE action = 'ban' AND target_id = 'sara'")!.id);
  const last = await json(await post(as(raw, 'sara'), '/api/moderation/appeals', { action_id: ban, body: 'About the ban' }));
  assert.equal((await json(await post(desk(raw), `/api/admin/moderation/appeals/${last.appeal.id}`, { state: 'rejected', decision: 'The evidence is clear' }))).restored, false);
  assert.equal(row<{ title_en: string }>(raw, 'SELECT title_en FROM user_notifications WHERE event_key = ?', `moderation_appeal:${last.appeal.id}`)!.title_en, 'Your appeal was rejected');
});

// ================================================================ the store

test('a user ban suspends their store through the store door\'s steps; lifting the ban leaves the store to its own decision', async () => {
  const raw = seed();
  const storesFound = async () => ids((await json(await get(as(raw, null), '/api/community/search?q=Ali&types=stores'))).sections.stores.rows);
  assert.equal((await storesFound()).length, 1);

  const res = await json(await setStatus(raw, 'ali', { status: 'ban', reason: 'Counterfeit listings' }));
  assert.deepEqual(res.store, { id: 's_ali', slug: 'ali3d', status: 'suspended' });
  assert.deepEqual(row(raw, "SELECT status, status_reason FROM merchant_stores WHERE id = 's_ali'"), { status: 'suspended', status_reason: 'Counterfeit listings' });
  const storeAudit = row<{ detail: string }>(raw, "SELECT detail FROM audit_log WHERE action = 'admin.store_status' AND target = 's_ali'")!;
  assert.equal(JSON.parse(storeAudit.detail).via, 'user_ban');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM moderation_actions WHERE target_type = 'store' AND target_id = 's_ali' AND action = 'suspend' AND subject_user_id = 'ali'"), 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'ali' AND kind = 'store_status_changed'"), 1, "the merchant's own notice");
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'ali' AND kind = 'moderation_action'"), 1);
  assert.deepEqual(await storesFound(), [], 'the directory no longer lists it');

  const lifted = await json(await setStatus(raw, 'ali', { status: 'restore', reason: 'Resolved' }));
  assert.equal(lifted.status, 'active');
  assert.equal(lifted.store.status, 'suspended', 'reopening the store is its own decision');
  assert.equal(row<{ status: string }>(raw, "SELECT status FROM merchant_stores WHERE id = 's_ali'")!.status, 'suspended');
});

// ================================================================ the record

test('every decision is exactly one action row and one audit row naming it', async () => {
  const raw = seed();
  const dragon = await published(raw, 'sara');
  const cid = (await json(await post(as(raw, 'eve'), `/api/community/posts/${dragon}/comments`, { body: 'Buy my followers' }))).comment.id as string;
  await hidePost(raw, dragon, { reason: 'Copied design' });
  await hidePost(raw, dragon, { reason: 'Copied design' }); // a replay
  await hidePost(raw, dragon, { hidden: false });
  await post(desk(raw), `/api/admin/moderation/comments/${cid}/hide`, { reason: 'Spam spam' });
  await setStatus(raw, 'eve', { status: 'warn', reason: 'Please stop' });
  await setStatus(raw, 'eve', { status: 'restrict', reason: 'Stop now' });
  await setStatus(raw, 'ali', { status: 'ban', reason: 'Fraud' });
  const s = (await json(await setStatus(raw, 'omar', { status: 'suspend', reason: 'Harassment', until: tomorrow() }))).action_id as string;
  const appeal = await json(await post(as(raw, 'omar'), '/api/moderation/appeals', { action_id: s, body: 'I apologise' }));
  await post(desk(raw), `/api/admin/moderation/appeals/${appeal.appeal.id}`, { state: 'accepted' });

  const actions = all<{ id: string; action: string }>(raw, 'SELECT id, action FROM moderation_actions');
  assert.equal(actions.length, 9, JSON.stringify(actions));
  for (const a of actions) {
    assert.equal(
      count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE json_extract(detail, '$.action_id') = ?", a.id),
      1,
      `${a.action} ${a.id} is audited exactly once`
    );
  }
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'admin.moderation.appeal_decided'"), 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'moderation.appeal_filed' AND actor_id = 'omar'"), 1);
});

test('the queue renders what each report names with the reporter count, pages exactly, and takes the desk\'s decision', async () => {
  const raw = seed();
  const dragon = await published(raw, 'sara');
  for (const who of ['eve', 'omar']) {
    const r = await post(as(raw, who), '/api/community/reports', { target_type: 'post', target_id: dragon, reason: 'copyright' });
    assert.equal(r.status, 201, await r.clone().text());
  }
  const userReport = (await json(await post(as(raw, 'eve'), '/api/community/reports', { target_type: 'user', target_id: 'sara', reason: 'abuse' }))).report_id as string;
  // A request comment's report, the way 0160 files it: 'comment' plus the side row.
  raw.exec(`
    INSERT INTO community_requests (id,customer_id,title,description,status,state,visibility) VALUES ('req_1','omar','Phone stand','A stand','open','open','public');
    INSERT INTO community_request_comments (id,request_id,author_id,kind,body) VALUES ('rqc_1','req_1','eve','public_comment','Cheap followers here');
    INSERT INTO community_reports (id,reporter_id,target_type,target_id,reason,created_at) VALUES ('rpt_rc','omar','comment','rqc_1','spam','2020-01-01T00:00:00.000Z');
    INSERT INTO community_report_targets (report_id,kind,target_id) VALUES ('rpt_rc','request_comment','rqc_1');
  `);

  const res = await get(desk(raw), '/api/admin/moderation/reports');
  assert.equal(res.status, 200, await res.clone().text());
  const text = await res.clone().text();
  assert.ok(!text.includes('sara@x.co') && !text.includes('+9647700000009'), 'no email and no phone in the queue');
  interface QueueRow {
    id: string;
    reports_on_target: number;
    open_on_target: number;
    target: { kind: string; id: string; body?: string; request_id?: string; name?: string; status?: string; card?: { title: string }; author?: { id: string } };
  }
  const queue = (await json(res)).reports as QueueRow[];
  assert.equal(queue.length, 4);
  const posts = queue.filter((r) => r.target.kind === 'post');
  assert.equal(posts.length, 2);
  for (const r of posts) {
    assert.equal(r.target.card?.title, 'Articulated dragon');
    assert.equal(r.target.author?.id, 'sara');
    assert.equal(r.reports_on_target, 2);
    assert.equal(r.open_on_target, 2);
  }
  const person = queue.find((r) => r.target.kind === 'user')!;
  assert.equal(person.target.name, 'Sara Kareem');
  assert.equal(person.target.status, 'active');
  const rc = queue.find((r) => r.target.kind === 'request_comment')!;
  assert.equal(rc.target.body, 'Cheap followers here');
  assert.equal(rc.target.request_id, 'req_1');

  assert.equal((await json(await get(desk(raw), '/api/admin/moderation/reports?type=post'))).reports.length, 2);
  assert.equal((await json(await get(desk(raw), '/api/admin/moderation/reports?type=request_comment'))).reports.length, 1);
  const page1 = await json(await get(desk(raw), '/api/admin/moderation/reports?limit=3'));
  assert.equal(page1.reports.length, 3);
  assert.ok(page1.next_cursor);
  const page2 = await json(await get(desk(raw), `/api/admin/moderation/reports?limit=3&cursor=${encodeURIComponent(page1.next_cursor)}`));
  assert.deepEqual(page2.reports.map((r: { id: string }) => r.id), ['rpt_rc']);
  assert.equal(page2.next_cursor, null, 'no cursor without a next page');

  // Deciding one report; a decision taken on another marks it actioned.
  const dismissed = await post(desk(raw), `/api/admin/moderation/reports/${userReport}`, { state: 'dismissed', resolution: 'Not abuse' });
  assert.equal(dismissed.status, 200, await dismissed.clone().text());
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'admin.moderation.report' AND target = ?", userReport), 1);
  assert.equal((await json(await get(desk(raw), '/api/admin/moderation/reports?state=dismissed'))).reports.length, 1);
  assert.equal((await post(desk(raw), `/api/admin/moderation/reports/${userReport}`, { state: 'closed' })).status, 400);
  assert.equal(await code(await post(desk(raw), '/api/admin/moderation/reports/rpt_nope', { state: 'reviewed' })), 'MODERATION_TARGET_NOT_FOUND');
  const linked = posts[0].id as string;
  await hidePost(raw, dragon, { reason: 'Copied design', report_id: linked });
  assert.deepEqual(row(raw, 'SELECT state, reviewed_by FROM community_reports WHERE id = ?', linked), { state: 'actioned', reviewed_by: 'boss' });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM moderation_actions WHERE report_id = ?', linked), 1);
  assert.equal(await code(await hidePost(raw, dragon, { hidden: false, report_id: 'rpt_nope' })), 'MODERATION_TARGET_NOT_FOUND');
  // Staff only.
  assert.equal((await get(as(raw, 'eve'), '/api/admin/moderation/reports')).status, 403);
});

test('a target\'s history joins its decisions (with any appeal) and the audit rows the desk may read', async () => {
  const raw = seed();
  const dragon = await published(raw, 'sara');
  const hideId = (await json(await hidePost(raw, dragon, { reason: 'Copied design' }))).action_id as string;
  await post(as(raw, 'sara'), '/api/moderation/appeals', { action_id: hideId, body: 'My own design' });
  await setStatus(raw, 'sara', { status: 'warn', reason: 'Careful' });

  const history = await json(await get(desk(raw), `/api/admin/moderation/audit?target_type=post&target_id=${dragon}`));
  assert.deepEqual(history.actions.map((a: { action: string }) => a.action), ['hide']);
  assert.equal(history.actions[0].appeal.body, 'My own design');
  assert.equal(history.current.hidden.reason, 'Copied design');
  const trail = history.audit.map((a: { action: string }) => a.action);
  for (const action of ['community.post_created', 'community.post_published', 'admin.moderation.post_hidden']) assert.ok(trail.includes(action), action);

  // An account's history carries the decisions about its content too.
  const person = await json(await get(desk(raw), '/api/admin/moderation/audit?target=user:sara'));
  assert.deepEqual(person.actions.map((a: { action: string }) => a.action).sort(), ['hide', 'warn']);
  assert.equal(person.current.status, 'active');
  assert.equal((await get(desk(raw), '/api/admin/moderation/audit?target_type=planet&target_id=x')).status, 400);
});
