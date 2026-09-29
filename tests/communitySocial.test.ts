/**
 * THE SOCIAL GRAPH (0154; docs/COMMUNITY_ECOSYSTEM.md Phase 2) over the real
 * routes — and every rule of its as an attack:
 *
 *   · a like, a save, a follow, a report is a ROW: replaying it changes
 *     nothing and answers the same numbers; the counters are the triggers';
 *   · a comment is removed by its author or by the post's author, and the
 *     stub keeps the replies' place; a stranger gets 404;
 *   · a draft is nobody's to like or talk under;
 *   · a block is mutual silence: no follow, no comment, no DM, no page, and
 *     neither side's posts in the other's lists; a mute hides quietly;
 *   · a burst of likes is ONE notification whose count climbs and which
 *     comes back unread;
 *   · «أتابع» is the makers one follows and the owners of the stores one
 *     follows, and nobody else; a guest has no «أتابع»;
 *   · the body never names who acts — the session does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, get, put, send, json, count, row, type StubUser, type Mount } from './fixtures/app';
import { communityRoutes } from '../worker/routes/community';
import { communityPostRoutes } from '../worker/routes/communityPosts';
import { communitySocialRoutes } from '../worker/routes/communitySocial';
import { chatRoutes } from '../worker/routes/chats';

const SARA: StubUser = { id: 'sara', role: 'customer', email: 'sara@x.co', username: 'sara' };
const EVE: StubUser = { id: 'eve', role: 'customer', email: 'eve@x.co', username: 'eve' };
const ALI: StubUser = { id: 'ali', role: 'merchant', email: 'ali@x.co', username: 'ali' };
const OMAR: StubUser = { id: 'omar', role: 'customer', email: 'omar@x.co', username: 'omar' };
const BOSS: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co', username: 'boss' };

const mount: Mount = (a) => {
  a.route('/api/community', communityRoutes);
  a.route('/api/community', communityPostRoutes);
  a.route('/api/community', communitySocialRoutes);
  a.route('/api/chats', chatRoutes);
};

function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username,bio) VALUES
      ('sara','Sara Kareem','sara@x.co','h','customer','sara','I print dragons'),
      ('eve','Eve','eve@x.co','h','customer','eve',''),
      ('ali','Ali','ali@x.co','h','merchant','ali',''),
      ('omar','Omar','omar@x.co','h','customer','omar',''),
      ('boss','Boss','boss@x.co','h','admin','boss','');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m_ali','ali','Ali 3D','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status) VALUES ('s_ali','m_ali','ali','ali3d','Ali 3D Store','active');
    INSERT INTO file_objects (object_key,visibility,domain,owner_id,entity_id,mime_type,byte_size,width,height) VALUES
      ('users/sara/posts/a1.webp','public','users','sara','sara','image/webp',1000,1200,900),
      ('users/eve/posts/e1.webp','public','users','eve','eve','image/webp',1000,800,800),
      ('users/omar/posts/o1.webp','public','users','omar','omar','image/webp',1000,800,800),
      ('merchants/ali/public/w1.webp','public','merchants','ali','ali','image/webp',1000,1000,1000);
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  return raw;
}
const as = (raw: DatabaseSync, user: StubUser | null) => stubApp(asD1(raw), user, mount);
const del = (a: ReturnType<typeof as>, path: string, body: unknown = {}) => send(a, 'DELETE', path, body);

const MEDIA: Record<string, string> = { sara: 'users/sara/posts/a1.webp', eve: 'users/eve/posts/e1.webp', omar: 'users/omar/posts/o1.webp', ali: 'merchants/ali/public/w1.webp' };

async function draft(raw: DatabaseSync, who: StubUser, title = 'Articulated dragon'): Promise<string> {
  const made = await post(as(raw, who), '/api/community/posts', { title, body: 'Printed in two colours.', kind: 'project', media: [{ key: MEDIA[who.id], kind: 'image' }] });
  assert.equal(made.status, 201, JSON.stringify(await json(made.clone())));
  return (await json(made)).post.id as string;
}
async function published(raw: DatabaseSync, who: StubUser, title = 'Articulated dragon'): Promise<string> {
  const id = await draft(raw, who, title);
  const pub = await post(as(raw, who), `/api/community/posts/${id}/publish`);
  assert.equal(pub.status, 200, JSON.stringify(await json(pub.clone())));
  return id;
}
const notes = (raw: DatabaseSync, user: string, kind: string) =>
  raw.prepare('SELECT id, title_ar, title_en, meta, read_at, event_key FROM user_notifications WHERE user_id = ? AND kind = ? ORDER BY created_at').all(user, kind) as Array<{
    id: string; title_ar: string; title_en: string; meta: string; read_at: string | null; event_key: string;
  }>;
/** Backdate a comment so the ten-second cooldown does not hold a later test step. */
// Moves every comment a day into the past — past the cooldown — while keeping
// their order: the list sorts by (created_at, id), and a collapsed timestamp
// would leave the order to the random ids.
const ageComments = (raw: DatabaseSync) =>
  raw.exec("UPDATE community_comments SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '-1 day')");

// ==================================================================== likes

test('a like is a row: PUT twice → 1, DELETE twice → 0, the counter is the trigger\'s, and the author hears once', async () => {
  const raw = seed();
  const id = await published(raw, SARA);
  const first = await put(as(raw, EVE), `/api/community/posts/${id}/like`);
  assert.equal(first.status, 200, JSON.stringify(await json(first.clone())));
  assert.deepEqual(await json(first), { success: true, liked: true, likes: 1 });
  assert.deepEqual(await json(await put(as(raw, EVE), `/api/community/posts/${id}/like`)), { success: true, liked: true, likes: 1 }, 'a replay answers the same');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_likes WHERE post_id = ?', id), 1);
  assert.equal(row(raw, 'SELECT like_count FROM community_posts WHERE id = ?', id)!.like_count, 1);

  // The card and the page carry the viewer's own mark; a guest's is false.
  const mine = (await json(await get(as(raw, EVE), '/api/community/posts'))).posts[0];
  assert.deepEqual(mine.viewer, { liked: true, saved: false });
  assert.deepEqual((await json(await get(as(raw, null), '/api/community/posts'))).posts[0].viewer, { liked: false, saved: false });
  const page = (await json(await get(as(raw, EVE), `/api/community/posts/${id}`))).post;
  assert.equal(page.viewer.liked, true);
  assert.equal(page.viewer.mine, false);

  assert.deepEqual(await json(await del(as(raw, EVE), `/api/community/posts/${id}/like`)), { success: true, liked: false, likes: 0 });
  assert.deepEqual(await json(await del(as(raw, EVE), `/api/community/posts/${id}/like`)), { success: true, liked: false, likes: 0 });
  assert.equal(row(raw, 'SELECT like_count FROM community_posts WHERE id = ?', id)!.like_count, 0);

  const heard = notes(raw, 'sara', 'post_liked');
  assert.equal(heard.length, 1);
  // The stub session carries no display name, so the actor reads as the handle.
  assert.equal(heard[0].title_en, 'eve liked your project “Articulated dragon”');
  assert.equal(JSON.parse(heard[0].meta).count, 1);
  // Liking one's own post says nothing to oneself.
  await put(as(raw, SARA), `/api/community/posts/${id}/like`);
  assert.equal(notes(raw, 'sara', 'post_liked').length, 1);
  assert.equal((await put(as(raw, null), `/api/community/posts/${id}/like`)).status, 401);
});

test('a burst of likes is ONE notification whose count climbs, retitled, and back unread', async () => {
  const raw = seed();
  const id = await published(raw, SARA);
  await put(as(raw, EVE), `/api/community/posts/${id}/like`);
  raw.exec("UPDATE user_notifications SET read_at = '2026-09-01T00:00:00.000Z' WHERE user_id = 'sara'");
  await put(as(raw, ALI), `/api/community/posts/${id}/like`);
  await put(as(raw, OMAR), `/api/community/posts/${id}/like`);
  await put(as(raw, OMAR), `/api/community/posts/${id}/like`); // a replay does not climb
  const heard = notes(raw, 'sara', 'post_liked');
  assert.equal(heard.length, 1, 'one row, not three');
  const meta = JSON.parse(heard[0].meta);
  assert.equal(meta.count, 3);
  assert.equal(meta.last_actor.id, 'omar');
  assert.equal(heard[0].title_en, '3 people liked your project “Articulated dragon”');
  assert.equal(heard[0].title_ar, 'أعجب 3 أشخاص بمشروعك «Articulated dragon»');
  assert.equal(heard[0].read_at, null, 'the row came back unread');
  assert.equal(heard[0].event_key, `post_liked:${id}`);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'sara'"), 1);
});

// ==================================================================== saves

test('a save is a row and private: PUT twice → 1, DELETE twice → 0, «المحفوظات» lists it, nobody is told', async () => {
  const raw = seed();
  const id = await published(raw, SARA);
  assert.deepEqual(await json(await put(as(raw, EVE), `/api/community/posts/${id}/save`, { collection: 'ideas' })), { success: true, saved: true, saves: 1 });
  assert.deepEqual(await json(await put(as(raw, EVE), `/api/community/posts/${id}/save`)), { success: true, saved: true, saves: 1 });
  assert.equal(row(raw, 'SELECT save_count FROM community_posts WHERE id = ?', id)!.save_count, 1);
  const saved = await json(await get(as(raw, EVE), '/api/community/saved'));
  assert.equal(saved.posts.length, 1);
  assert.equal(saved.posts[0].id, id);
  assert.deepEqual(saved.posts[0].viewer, { liked: false, saved: true });
  assert.equal(saved.next_cursor, null);
  assert.equal((await get(as(raw, null), '/api/community/saved')).status, 401);
  assert.deepEqual(await json(await del(as(raw, EVE), `/api/community/posts/${id}/save`)), { success: true, saved: false, saves: 0 });
  assert.deepEqual(await json(await del(as(raw, EVE), `/api/community/posts/${id}/save`)), { success: true, saved: false, saves: 0 });
  assert.deepEqual((await json(await get(as(raw, EVE), '/api/community/saved'))).posts, []);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM user_notifications'), 0, 'a save notifies nobody');
});

// ================================================================= comments

test('comment ownership: the author removes their own, the post\'s author removes anyone\'s, a stranger gets 404, the stub keeps the replies', async () => {
  const raw = seed();
  const id = await published(raw, SARA);
  const first = await post(as(raw, EVE), `/api/community/posts/${id}/comments`, { body: 'Beautiful print!', client_id: 'c1' });
  assert.equal(first.status, 201, JSON.stringify(await json(first.clone())));
  const c1 = (await json(first)).comment;
  assert.equal(c1.author.id, 'eve');
  assert.equal(c1.author.username, null, 'no creator page yet, so nothing links to a 404 (D4)');
  assert.equal(c1.parent_id, null);
  assert.deepEqual(c1.viewer, { mine: true, can_remove: true });

  // The same words again within the cooldown is the client retrying; different words are too fast.
  const again = await post(as(raw, EVE), `/api/community/posts/${id}/comments`, { body: 'Beautiful print!', client_id: 'c1' });
  assert.equal(again.status, 200);
  const replay = await json(again);
  assert.equal(replay.replayed, true);
  assert.equal(replay.comment.id, c1.id);
  const fast = await post(as(raw, EVE), `/api/community/posts/${id}/comments`, { body: 'And another thing' });
  assert.equal(fast.status, 429);
  assert.equal((await json(fast)).code, 'COMMENT_TOO_FAST');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_comments'), 1);

  const reply = await post(as(raw, ALI), `/api/community/posts/${id}/comments`, { body: 'Which nozzle?', parent_id: c1.id });
  assert.equal(reply.status, 201, JSON.stringify(await json(reply.clone())));
  const c2 = (await json(reply)).comment;
  assert.equal(c2.parent_id, c1.id);
  assert.equal(row(raw, 'SELECT comment_count FROM community_posts WHERE id = ?', id)!.comment_count, 2);
  // The post's author hears «علّق» once per burst; the one replied to hears «ردّ».
  assert.equal(JSON.parse(notes(raw, 'sara', 'post_commented')[0].meta).count, 2);
  assert.equal(notes(raw, 'eve', 'comment_replied')[0].title_en, 'ali replied to your comment');
  // A reply to a reply is filed under the thread's root.
  ageComments(raw);
  const deep = await post(as(raw, OMAR), `/api/community/posts/${id}/comments`, { body: 'Same question', parent_id: c2.id });
  assert.equal((await json(deep)).comment.parent_id, c1.id);
  assert.equal(notes(raw, 'ali', 'comment_replied').length, 1, 'the direct parent\'s author is the one replied to');

  // A stranger cannot remove; a parent of the wrong post is a 404.
  assert.equal((await del(as(raw, OMAR), `/api/community/comments/${c1.id}`)).status, 404);
  const other = await published(raw, EVE, 'Eve\'s vase');
  assert.equal((await post(as(raw, ALI), `/api/community/posts/${other}/comments`, { body: 'Nice', parent_id: c1.id })).status, 404);

  // Eve removes her own: the stub keeps its place, the count drops, the reply still points at it.
  ageComments(raw);
  assert.equal((await del(as(raw, EVE), `/api/community/comments/${c1.id}`)).status, 200);
  assert.equal((await del(as(raw, EVE), `/api/community/comments/${c1.id}`)).status, 200, 'a replay');
  const list = await json(await get(as(raw, null), `/api/community/posts/${id}/comments`));
  assert.equal(list.total, 2);
  assert.equal(list.comments.length, 3);
  assert.deepEqual({ ...list.comments[0], created_at: undefined }, { id: c1.id, post_id: id, parent_id: null, body: '', state: 'removed', author: null, viewer: { mine: false, can_remove: false }, created_at: undefined });
  assert.equal(list.comments[1].parent_id, c1.id);
  assert.equal(list.comments[1].viewer.can_remove, false, 'a guest removes nothing');
  // Sara, the post's author, removes Ali's; Ali cannot remove Omar's.
  assert.equal((await del(as(raw, ALI), `/api/community/comments/${list.comments[2].id}`)).status, 404);
  assert.equal((await del(as(raw, SARA), `/api/community/comments/${c2.id}`)).status, 200);
  assert.equal(row(raw, 'SELECT comment_count FROM community_posts WHERE id = ?', id)!.comment_count, 1);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM community_comments WHERE state = 'removed'"), 2);
  // A hidden comment is served to staff and its author only.
  raw.exec(`UPDATE community_comments SET state = 'hidden' WHERE id = '${list.comments[2].id}'`);
  assert.equal((await json(await get(as(raw, null), `/api/community/posts/${id}/comments`))).comments.length, 2);
  assert.equal((await json(await get(as(raw, OMAR), `/api/community/posts/${id}/comments`))).comments.length, 3);
  assert.equal((await json(await get(as(raw, BOSS), `/api/community/posts/${id}/comments`))).comments.length, 3);
  // Bounds and a page.
  assert.equal((await post(as(raw, BOSS), `/api/community/posts/${id}/comments`, { body: 'x' })).status, 400);
  const page = await json(await get(as(raw, BOSS), `/api/community/posts/${id}/comments?limit=2`));
  assert.equal(page.comments.length, 2);
  assert.ok(page.next_cursor);
  const rest = await json(await get(as(raw, BOSS), `/api/community/posts/${id}/comments?limit=2&cursor=${encodeURIComponent(page.next_cursor)}`));
  assert.equal(rest.comments.length, 1);
  assert.equal(rest.next_cursor, null);
});

test('a draft is nobody\'s to like, save or talk under', async () => {
  const raw = seed();
  const id = await draft(raw, SARA);
  assert.equal((await put(as(raw, EVE), `/api/community/posts/${id}/like`)).status, 404);
  assert.equal((await put(as(raw, EVE), `/api/community/posts/${id}/save`)).status, 404);
  assert.equal((await post(as(raw, EVE), `/api/community/posts/${id}/comments`, { body: 'Hello there' })).status, 404);
  assert.equal((await get(as(raw, EVE), `/api/community/posts/${id}/comments`)).status, 404);
  assert.equal((await post(as(raw, EVE), '/api/community/reports', { target_type: 'post', target_id: id, reason: 'spam' })).status, 404);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_likes'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_comments'), 0);
  // The author may mark their own draft; nobody is told.
  assert.equal((await put(as(raw, SARA), `/api/community/posts/${id}/like`)).status, 200);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM user_notifications'), 0);
});

// ================================================================== follows

test('follow: a row, a page, never oneself; the target hears once per burst', async () => {
  const raw = seed();
  await published(raw, SARA);
  const first = await put(as(raw, EVE), '/api/community/users/sara/follow');
  assert.equal(first.status, 200, JSON.stringify(await json(first.clone())));
  assert.deepEqual(await json(first), { success: true, following: true, followers: 1 });
  assert.deepEqual(await json(await put(as(raw, EVE), '/api/community/users/sara/follow')), { success: true, following: true, followers: 1 });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM user_follows'), 1);
  assert.equal(row(raw, "SELECT follower_count FROM users WHERE id = 'sara'")!.follower_count, 1);
  const self = await put(as(raw, EVE), '/api/community/users/eve/follow');
  assert.equal(self.status, 400);
  assert.equal((await json(self)).code, 'CANNOT_FOLLOW_SELF');
  assert.equal((await put(as(raw, EVE), '/api/community/users/omar/follow')).status, 404, 'no page, no follow');
  assert.equal((await put(as(raw, EVE), '/api/community/users/nobody/follow')).status, 404);
  assert.equal((await put(as(raw, EVE), '/api/community/users/ali/follow')).status, 200, 'a merchant has a page');
  await put(as(raw, OMAR), '/api/community/users/sara/follow');
  const heard = notes(raw, 'sara', 'new_follower');
  assert.equal(heard.length, 1);
  assert.equal(JSON.parse(heard[0].meta).count, 2);
  assert.equal(heard[0].title_ar, 'بدأ شخصان بمتابعتك');

  // The creator page and the list carry the numbers and the viewer's mark.
  const page = (await json(await get(as(raw, EVE), '/api/community/creators/sara'))).creator;
  assert.equal(page.stats.followers, 2);
  assert.deepEqual(page.viewer, { mine: false, following: true, blocked: false });
  const social = await json(await get(as(raw, EVE), '/api/community/me/social'));
  assert.deepEqual(social, { success: true, following_users: ['ali', 'sara'], following_stores: [], blocked: [], muted: [] });

  assert.deepEqual(await json(await del(as(raw, EVE), '/api/community/users/sara/follow')), { success: true, following: false, followers: 1 });
  assert.deepEqual(await json(await del(as(raw, EVE), '/api/community/users/sara/follow')), { success: true, following: false, followers: 1 });
  assert.equal(row(raw, "SELECT follower_count FROM users WHERE id = 'sara'")!.follower_count, 1);
});

test('follow spam: the bucket closes at 60 an hour, and sixty replays still leave one follower', async () => {
  const raw = seed();
  await published(raw, SARA);
  for (let i = 0; i < 60; i++) {
    const r = await put(as(raw, EVE), '/api/community/users/sara/follow');
    assert.equal(r.status, 200, `call ${i + 1}`);
  }
  const shut = await put(as(raw, EVE), '/api/community/users/sara/follow');
  assert.equal(shut.status, 429);
  assert.equal((await json(shut)).code, 'RATE_LIMITED');
  assert.equal(row(raw, "SELECT follower_count FROM users WHERE id = 'sara'")!.follower_count, 1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM user_follows'), 1);
  // Another account's bucket is its own.
  assert.equal((await put(as(raw, OMAR), '/api/community/users/sara/follow')).status, 200);
});

// ==================================================================== blocks

test('a block is mutual silence: no follow, no comment, no DM, no page, and no posts in either\'s lists', async () => {
  const raw = seed();
  const saras = await published(raw, SARA);
  const eves = await published(raw, EVE, 'Eve\'s vase');
  await put(as(raw, EVE), '/api/community/users/sara/follow');
  await put(as(raw, SARA), '/api/community/users/eve/follow');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM user_follows'), 2);

  assert.deepEqual(await json(await put(as(raw, SARA), '/api/community/users/eve/block')), { success: true, blocked: true });
  assert.deepEqual(await json(await put(as(raw, SARA), '/api/community/users/eve/block')), { success: true, blocked: true });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM user_follows'), 0, 'the follows both ways went with the block');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM user_blocks'), 1);
  assert.equal((await json(await get(as(raw, SARA), '/api/community/me/social'))).blocked[0], 'eve');
  assert.equal((await put(as(raw, SARA), '/api/community/users/sara/block')).status, 400);

  // Every community door answers a block with the words a missing thing gets
  // — the page, the post, its comments, a like, a save, a comment, a follow —
  // so the blocked side learns nothing from any of them. The DM door is the
  // one that names it (a thread cannot pretend not to exist).
  for (const [who, other, theirs] of [[EVE, 'sara', saras], [SARA, 'eve', eves]] as const) {
    const follow = await put(as(raw, who), `/api/community/users/${other}/follow`);
    assert.equal(follow.status, 404, `${who.id} follows ${other}`);
    assert.equal((await json(follow)).code, 'NOT_FOUND', 'the follow door does not say BLOCKED');
    const dm = await post(as(raw, who), '/api/chats/open', { userId: other });
    assert.equal(dm.status, 403, `${who.id} DMs ${other}`);
    assert.equal((await json(dm)).code, 'BLOCKED');
    assert.equal((await get(as(raw, who), `/api/community/creators/${other}`)).status, 404, `${who.id} opens ${other}'s page`);
    assert.equal((await get(as(raw, who), `/api/community/posts/${theirs}`)).status, 404, `${who.id} opens ${other}'s post`);
    assert.equal((await get(as(raw, who), `/api/community/posts/${theirs}/comments`)).status, 404, `${who.id} reads ${other}'s comments`);
    for (const door of [put(as(raw, who), `/api/community/posts/${theirs}/like`), put(as(raw, who), `/api/community/posts/${theirs}/save`), post(as(raw, who), `/api/community/posts/${theirs}/comments`, { body: 'Let me in' })]) {
      const r = await door;
      assert.equal(r.status, 404, `${who.id} → ${other}'s post`);
      assert.equal((await json(r)).code, 'NOT_FOUND');
    }
  }
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM chats'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_comments'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_likes'), 0);

  // Neither sees the other's posts in any list; a third party and a guest see both.
  const ids = async (who: StubUser | null, path: string) => ((await json(await get(as(raw, who), path))).posts as Array<{ id: string }>).map((p) => p.id).sort();
  assert.deepEqual(await ids(EVE, '/api/community/posts'), [eves]);
  assert.deepEqual(await ids(SARA, '/api/community/posts'), [saras]);
  assert.deepEqual(await ids(EVE, '/api/community/feed'), [eves]);
  assert.deepEqual(await ids(SARA, '/api/community/feed'), [saras]);
  assert.deepEqual(await ids(EVE, '/api/community/posts/trending'), [eves]);
  assert.deepEqual(await ids(null, '/api/community/posts'), [eves, saras].sort());
  assert.deepEqual(await ids(OMAR, '/api/community/feed'), [eves, saras].sort());
  assert.equal((await json(await get(as(raw, EVE), '/api/community/posts'))).total, 1, 'the count agrees with the list');
  const creators = (await json(await get(as(raw, EVE), '/api/community/creators'))).creators as Array<{ id: string }>;
  assert.deepEqual(creators.map((x) => x.id).sort(), ['ali', 'eve']);
  assert.equal((await get(as(raw, OMAR), '/api/community/creators/sara')).status, 200, 'a third party still reads the page');

  // Unblocking opens the doors again.
  assert.deepEqual(await json(await del(as(raw, SARA), '/api/community/users/eve/block')), { success: true, blocked: false });
  assert.equal((await put(as(raw, EVE), '/api/community/users/sara/follow')).status, 200);
  assert.equal((await post(as(raw, EVE), '/api/chats/open', { userId: 'sara' })).status, 200);
});

test('a mute hides the muted maker from the viewer\'s own lists and tells nobody', async () => {
  const raw = seed();
  const saras = await published(raw, SARA);
  const omars = await published(raw, OMAR, 'Omar\'s cup');
  assert.deepEqual(await json(await put(as(raw, EVE), '/api/community/users/omar/mute')), { success: true, muted: true });
  assert.deepEqual(await json(await put(as(raw, EVE), '/api/community/users/omar/mute')), { success: true, muted: true });
  const ids = async (who: StubUser | null, path: string) => ((await json(await get(as(raw, who), path))).posts as Array<{ id: string }>).map((p) => p.id).sort();
  assert.deepEqual(await ids(EVE, '/api/community/feed?scope=foryou'), [saras]);
  assert.deepEqual(await ids(EVE, '/api/community/posts'), [saras]);
  assert.deepEqual(await ids(null, '/api/community/feed'), [omars, saras].sort());
  assert.deepEqual(await ids(OMAR, '/api/community/feed'), [omars, saras].sort(), 'the muted person notices nothing');
  assert.equal((await get(as(raw, EVE), '/api/community/creators/omar')).status, 200, 'a mute closes no page');
  assert.equal((await put(as(raw, EVE), `/api/community/posts/${omars}/like`)).status, 200, 'a mute is not a block: the door stays open');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM user_notifications'), 1, 'the like still tells omar; the mute told nobody');
  assert.deepEqual((await json(await get(as(raw, EVE), '/api/community/me/social'))).muted, ['omar']);
  assert.deepEqual(await json(await del(as(raw, EVE), '/api/community/users/omar/mute')), { success: true, muted: false });
  assert.deepEqual(await ids(EVE, '/api/community/feed'), [omars, saras].sort());
});

// ===================================================================== feed

test('«أتابع» is the makers one follows and the owners of the stores one follows — and a guest has none', async () => {
  const raw = seed();
  const saras = await published(raw, SARA);
  const alis = await published(raw, ALI, 'Ali\'s bracket');
  const omars = await published(raw, OMAR, 'Omar\'s cup');
  await put(as(raw, EVE), '/api/community/users/sara/follow');
  assert.equal((await post(as(raw, EVE), '/api/community/store/m_ali/follow')).status, 200);
  const following = await json(await get(as(raw, EVE), '/api/community/feed?scope=following&limit=1'));
  assert.equal(following.scope, 'following');
  assert.equal(following.posts.length, 1);
  assert.ok(following.next_cursor, 'a second page exists');
  const second = await json(await get(as(raw, EVE), `/api/community/feed?scope=following&limit=1&cursor=${encodeURIComponent(following.next_cursor)}`));
  assert.equal(second.posts.length, 1);
  assert.equal(second.next_cursor, null, 'no empty tail');
  assert.deepEqual([following.posts[0].id, second.posts[0].id].sort(), [alis, saras].sort());
  assert.ok(![following.posts[0].id, second.posts[0].id].includes(omars), 'a stranger\'s post is not in «أتابع»');
  const foryou = await json(await get(as(raw, EVE), '/api/community/feed'));
  assert.deepEqual(foryou.posts.map((p: { id: string }) => p.id).sort(), [alis, omars, saras].sort());
  assert.equal((await get(as(raw, null), '/api/community/feed?scope=following')).status, 401);
  assert.equal((await get(as(raw, null), '/api/community/feed')).status, 200);
  assert.equal((await get(as(raw, EVE), '/api/community/feed?scope=nope')).status, 400);
  assert.deepEqual((await json(await get(as(raw, EVE), '/api/community/me/social'))).following_stores, ['m_ali']);
});

// ================================================================== reports

test('a report is filed once: the second press is a replay, the target must exist, staff are told after the response', async () => {
  const raw = seed();
  const id = await published(raw, SARA);
  const first = await post(as(raw, EVE), '/api/community/reports', { target_type: 'post', target_id: id, reason: 'spam', details: 'Sells stuff' });
  assert.equal(first.status, 201, JSON.stringify(await json(first.clone())));
  const reportId = (await json(first)).report_id as string;
  assert.ok(reportId);
  const again = await post(as(raw, EVE), '/api/community/reports', { target_type: 'post', target_id: id, reason: 'abuse' });
  assert.equal(again.status, 200);
  assert.deepEqual(await json(again), { success: true, report_id: reportId, replayed: true });
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_reports'), 1);
  assert.equal(row(raw, 'SELECT reason, state FROM community_reports WHERE id = ?', reportId)!.reason, 'spam', 'the first reason stands');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'community.report'"), 1);

  const gone = await post(as(raw, EVE), '/api/community/reports', { target_type: 'comment', target_id: 'cmt_nope', reason: 'spam' });
  assert.equal(gone.status, 404);
  assert.equal((await json(gone)).code, 'REPORT_TARGET_NOT_FOUND');
  assert.equal((await post(as(raw, EVE), '/api/community/reports', { target_type: 'post', target_id: id, reason: 'meh' })).status, 400);
  assert.equal((await post(as(raw, EVE), '/api/community/reports', { target_type: 'wallet', target_id: id, reason: 'spam' })).status, 400);
  assert.equal((await post(as(raw, null), '/api/community/reports', { target_type: 'post', target_id: id, reason: 'spam' })).status, 401);
  // Every other target kind resolves against its own table.
  for (const [target_type, target_id, status] of [['user', 'sara', 201], ['store', 's_ali', 201], ['store', 's_nope', 404], ['product', 'cp_nope', 404], ['request', 'req_nope', 404]] as const) {
    const r = await post(as(raw, OMAR), '/api/community/reports', { target_type, target_id, reason: 'other' });
    assert.equal(r.status, status, `${target_type}:${target_id}`);
  }
});

// ================================================================== creators

test('the creators list: only accounts with a page, searched and featured, with the viewer\'s mark', async () => {
  const raw = seed();
  await published(raw, SARA);
  await published(raw, SARA, 'Second dragon');
  await put(as(raw, EVE), '/api/community/users/sara/follow');
  await put(as(raw, OMAR), '/api/community/users/ali/follow');
  await put(as(raw, SARA), '/api/community/users/ali/follow');
  const list = await json(await get(as(raw, EVE), '/api/community/creators'));
  assert.deepEqual(list.creators.map((x: { id: string }) => x.id), ['sara', 'ali'], 'newest published project first; a merchant with none after');
  assert.equal(list.total, 2);
  assert.equal(list.next_cursor, null);
  const sara = list.creators[0];
  assert.deepEqual(sara.stats, { projects: 2, followers: 1 });
  assert.deepEqual(sara.viewer, { following: true });
  assert.equal(sara.store, null);
  assert.equal(sara.url, '/u/sara');
  assert.deepEqual(sara.badges, { pro: false, premium: false, verified_merchant: false });
  const ali = list.creators[1];
  assert.equal(ali.store.slug, 'ali3d');
  assert.deepEqual(ali.stats, { projects: 0, followers: 2 });
  assert.equal(JSON.stringify(list).includes('@x.co'), false, 'no email anywhere');

  const featured = await json(await get(as(raw, null), '/api/community/creators?featured=1'));
  assert.deepEqual(featured.creators.map((x: { id: string }) => x.id), ['sara', 'ali']);
  assert.deepEqual(featured.creators[0].viewer, { following: false });
  const searched = await json(await get(as(raw, null), '/api/community/creators?q=dragons'));
  assert.deepEqual(searched.creators.map((x: { id: string }) => x.id), ['sara'], 'the bio is searched');
  const paged = await json(await get(as(raw, null), '/api/community/creators?limit=1'));
  assert.equal(paged.creators.length, 1);
  assert.equal(paged.next_cursor, '1');
  const rest = await json(await get(as(raw, null), '/api/community/creators?limit=1&cursor=1'));
  assert.equal(rest.creators[0].id, 'ali');
  assert.equal(rest.next_cursor, null);
  assert.equal(rest.total, null);
});

// ==================================================================== forgery

test('the body never says who acts: user ids in a body are ignored, the session is the actor', async () => {
  const raw = seed();
  const id = await published(raw, SARA);
  await put(as(raw, EVE), `/api/community/posts/${id}/like`, { user_id: 'omar', post_id: 'other' });
  assert.deepEqual(row(raw, 'SELECT user_id, post_id FROM community_likes'), { user_id: 'eve', post_id: id });
  await put(as(raw, EVE), `/api/community/posts/${id}/save`, { user_id: 'omar' });
  assert.equal(row(raw, 'SELECT user_id FROM community_saves')!.user_id, 'eve');
  await post(as(raw, EVE), `/api/community/posts/${id}/comments`, { body: 'Hello from me', author_id: 'omar', post_id: 'other', state: 'hidden', id: 'cmt_forged' });
  const cm = row(raw, 'SELECT id, author_id, post_id, state FROM community_comments')!;
  assert.equal(cm.author_id, 'eve');
  assert.equal(cm.post_id, id);
  assert.equal(cm.state, 'visible');
  assert.notEqual(cm.id, 'cmt_forged');
  await put(as(raw, EVE), '/api/community/users/sara/follow', { follower_id: 'omar' });
  assert.deepEqual(row(raw, 'SELECT follower_id, user_id FROM user_follows'), { follower_id: 'eve', user_id: 'sara' });
  await post(as(raw, EVE), '/api/community/reports', { target_type: 'user', target_id: 'sara', reason: 'spam', reporter_id: 'omar', state: 'actioned' });
  const rp = row(raw, 'SELECT reporter_id, state FROM community_reports')!;
  assert.equal(rp.reporter_id, 'eve');
  assert.equal(rp.state, 'open');
  await put(as(raw, EVE), '/api/community/users/sara/block', { user_id: 'omar' });
  assert.deepEqual(row(raw, 'SELECT user_id, blocked_id FROM user_blocks'), { user_id: 'eve', blocked_id: 'sara' });
  // And the counters are the triggers': a body cannot move them.
  assert.equal(row(raw, 'SELECT like_count FROM community_posts WHERE id = ?', id)!.like_count, 1);
});


// ======================================================== review regressions

test('a grouped notification counts PEOPLE: like→unlike→like is one person, and it never comes back unread for a repeat', async () => {
  const raw = seed();
  const id = await published(raw, SARA);
  await put(as(raw, EVE), `/api/community/posts/${id}/like`);
  raw.exec("UPDATE user_notifications SET read_at = '2026-09-01T00:00:00.000Z', created_at = '2026-09-01T00:00:00.000Z' WHERE user_id = 'sara'");
  for (let i = 0; i < 5; i++) {
    await del(as(raw, EVE), `/api/community/posts/${id}/like`);
    await put(as(raw, EVE), `/api/community/posts/${id}/like`);
  }
  let heard = notes(raw, 'sara', 'post_liked');
  assert.equal(heard.length, 1);
  assert.equal(JSON.parse(heard[0].meta).count, 1, 'one actor toggling is one person');
  assert.deepEqual(JSON.parse(heard[0].meta).actors, ['eve']);
  assert.equal(heard[0].title_en, 'eve liked your project “Articulated dragon”');
  assert.equal(heard[0].read_at, '2026-09-01T00:00:00.000Z', 'a repeat does not clear read_at');
  assert.equal(row(raw, "SELECT created_at FROM user_notifications WHERE user_id = 'sara'")!.created_at, '2026-09-01T00:00:00.000Z', 'nor does it climb back to the top');
  assert.equal(row(raw, 'SELECT like_count FROM community_posts WHERE id = ?', id)!.like_count, 1);
  // A NEW person is counted, and the row does come back unread.
  await put(as(raw, OMAR), `/api/community/posts/${id}/like`);
  heard = notes(raw, 'sara', 'post_liked');
  assert.equal(JSON.parse(heard[0].meta).count, 2);
  assert.equal(heard[0].read_at, null);
  assert.equal(heard[0].title_ar, 'أعجب شخصان بمشروعك «Articulated dragon»');
  // The same for a follow toggled sixty times, and for one person replying three times.
  for (let i = 0; i < 3; i++) {
    await put(as(raw, EVE), '/api/community/users/sara/follow');
    await del(as(raw, EVE), '/api/community/users/sara/follow');
  }
  assert.equal(JSON.parse(notes(raw, 'sara', 'new_follower')[0].meta).count, 1);
  const c1 = (await json(await post(as(raw, EVE), `/api/community/posts/${id}/comments`, { body: 'First!' }))).comment;
  for (const body of ['Reply one', 'Reply two', 'Reply three']) {
    ageComments(raw);
    assert.equal((await post(as(raw, OMAR), `/api/community/posts/${id}/comments`, { body, parent_id: c1.id })).status, 201);
  }
  const replied = notes(raw, 'eve', 'comment_replied');
  assert.equal(replied.length, 1);
  assert.equal(JSON.parse(replied[0].meta).count, 1, 'three replies by one person are one person');
  assert.equal(replied[0].title_en, 'omar replied to your comment');
});

test('a DM opened before the block is closed by it: no message, no typing, and it leaves the blocker\'s inbox', async () => {
  const raw = seed();
  const opened = await post(as(raw, EVE), '/api/chats/open', { userId: 'sara' });
  assert.equal(opened.status, 200);
  const chatId = (await json(opened)).chatId as string;
  assert.equal((await post(as(raw, EVE), `/api/chats/${chatId}/messages`, { body: 'hello', client_id: 'dm-send-00001' })).status, 200);
  assert.equal((await put(as(raw, SARA), '/api/community/users/eve/block')).status, 200);
  for (const [who, tag] of [[EVE, 'the blocked'], [SARA, 'the blocker']] as const) {
    const sent = await post(as(raw, who), `/api/chats/${chatId}/messages`, { body: 'still here', client_id: `dm-send-${who.id}-2` });
    assert.equal(sent.status, 403, `${tag} writes`);
    assert.equal((await json(sent)).code, 'BLOCKED');
    const typing = await post(as(raw, who), `/api/chats/${chatId}/typing`, {});
    assert.equal(typing.status, 403, `${tag} types`);
    assert.equal((await json(typing)).code, 'BLOCKED');
  }
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM chat_messages WHERE chat_id = ?', chatId), 1, 'nothing landed after the block');
  const saraChats = (await json(await get(as(raw, SARA), '/api/chats'))).chats as Array<{ id: string }>;
  assert.equal(saraChats.some((ch) => ch.id === chatId), false, 'the harasser\'s thread is gone from the blocker\'s list');
  const eveChats = (await json(await get(as(raw, EVE), '/api/chats'))).chats as Array<{ id: string }>;
  assert.equal(eveChats.some((ch) => ch.id === chatId), true, 'the other side\'s list says nothing about a block');
  // Unblocking reopens the thread.
  await del(as(raw, SARA), '/api/community/users/eve/block');
  assert.equal((await post(as(raw, EVE), `/api/chats/${chatId}/messages`, { body: 'back', client_id: 'dm-send-00003' })).status, 200);
});

test('two identical comment sends in flight are ONE comment (0155 client_id): one row, one count, one notification', async () => {
  const raw = seed();
  const id = await published(raw, SARA);
  const fire = () => post(as(raw, EVE), `/api/community/posts/${id}/comments`, { body: 'double tap', client_id: 'c1' });
  const [a, b] = await Promise.all([fire(), fire()]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 201], JSON.stringify([await json(a.clone()), await json(b.clone())]));
  const ja = await json(a);
  const jb = await json(b);
  assert.equal(ja.comment.id, jb.comment.id, 'both answers name the same comment');
  assert.equal([ja.replayed, jb.replayed].filter(Boolean).length, 1, 'exactly one is the replay');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_comments'), 1);
  assert.equal(row(raw, 'SELECT comment_count FROM community_posts WHERE id = ?', id)!.comment_count, 1);
  assert.equal(row(raw, "SELECT client_id FROM community_comments")!.client_id, 'c1');
  const heard = notes(raw, 'sara', 'post_commented');
  assert.equal(heard.length, 1);
  assert.equal(JSON.parse(heard[0].meta).count, 1);
  assert.equal(heard[0].event_key, `post_commented:${id}`);
  // Long after the cooldown, the same client id is still the same comment.
  ageComments(raw);
  const late = await post(as(raw, EVE), `/api/community/posts/${id}/comments`, { body: 'double tap', client_id: 'c1' });
  assert.equal(late.status, 200);
  assert.equal((await json(late)).replayed, true);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_comments'), 1);
  // A different name after the cooldown is a new comment; the client id is per author.
  const other = await post(as(raw, EVE), `/api/community/posts/${id}/comments`, { body: 'double tap', client_id: 'c2' });
  assert.equal(other.status, 201);
  ageComments(raw);
  assert.equal((await post(as(raw, OMAR), `/api/community/posts/${id}/comments`, { body: 'mine', client_id: 'c1' })).status, 201);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_comments'), 3);
});

test('the comments `total` is what the viewer is shown: a blocked or muted author\'s comments are out of the number too', async () => {
  const raw = seed();
  const id = await published(raw, SARA);
  await post(as(raw, EVE), `/api/community/posts/${id}/comments`, { body: 'Nice one' });
  await post(as(raw, OMAR), `/api/community/posts/${id}/comments`, { body: 'Agreed' });
  const before = await json(await get(as(raw, SARA), `/api/community/posts/${id}/comments`));
  assert.equal(before.total, 2);
  await put(as(raw, SARA), '/api/community/users/eve/block');
  const afterBlock = await json(await get(as(raw, SARA), `/api/community/posts/${id}/comments`));
  assert.equal(afterBlock.comments.length, 1);
  assert.equal(afterBlock.total, 1, 'the title agrees with the rows');
  await put(as(raw, SARA), '/api/community/users/omar/mute');
  const afterMute = await json(await get(as(raw, SARA), `/api/community/posts/${id}/comments`));
  assert.deepEqual([afterMute.comments.length, afterMute.total], [0, 0]);
  // A guest and a third party still count both; the card's counter is the post's own number.
  assert.equal((await json(await get(as(raw, null), `/api/community/posts/${id}/comments`))).total, 2);
  assert.equal((await json(await get(as(raw, ALI), `/api/community/posts/${id}/comments`))).total, 2);
  assert.equal(row(raw, 'SELECT comment_count FROM community_posts WHERE id = ?', id)!.comment_count, 2);
});

test('a JSON `null` body is a 400, never a 500, on save, comment and report', async () => {
  const raw = seed();
  const id = await published(raw, SARA);
  const nul = (path: string, method: 'PUT' | 'POST') => send(as(raw, EVE), method, path, null);
  const saved = await nul(`/api/community/posts/${id}/save`, 'PUT');
  assert.equal(saved.status, 200, 'a save needs no body at all');
  assert.equal((await json(saved)).saved, true);
  const talk = await nul(`/api/community/posts/${id}/comments`, 'POST');
  assert.equal(talk.status, 400, JSON.stringify(await json(talk.clone())));
  const report = await nul('/api/community/reports', 'POST');
  assert.equal(report.status, 400);
  for (const body of ['a string', 7, [1, 2]]) {
    assert.equal((await send(as(raw, EVE), 'POST', `/api/community/posts/${id}/comments`, body)).status, 400, JSON.stringify(body));
  }
});

test('a report confirms nothing the reporter could not already open: no page, no listing, no board → the same 404', async () => {
  const raw = seed();
  raw.exec(`
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m_omar','omar','Omar Prints','suspended');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status) VALUES ('s_omar','m_omar','omar','omarprints','Omar Prints','suspended');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,price_iqd,status,lifecycle) VALUES
      ('cp_live','m_ali','s_ali','hook','Hook',1000,'active','active'),
      ('cp_gone','m_ali','s_ali','old-hook','Old hook',1000,'active','archived');
    INSERT INTO community_requests (id,customer_id,title,state,visibility) VALUES
      ('req_open','omar','A gear','open','public'),
      ('req_private','omar','A private gear','open','private'),
      ('req_closed','omar','A closed gear','closed','public');
  `);
  const draftId = await draft(raw, SARA, 'Private draft');
  raw.exec(`INSERT INTO community_comments (id,post_id,author_id,body) VALUES ('cmt_draft','${draftId}','sara','note to self')`);
  const pubId = await published(raw, SARA);
  const visible = (await json(await post(as(raw, OMAR), `/api/community/posts/${pubId}/comments`, { body: 'Hello' }))).comment.id as string;
  const cases: Array<[string, string, number]> = [
    ['user', 'sara', 201], // published → a page
    ['user', 'ali', 201], // a live merchant → a page
    ['user', 'omar', 404], // an account with no page: the same words as no account
    ['user', 'nobody', 404],
    ['comment', visible, 201],
    ['comment', 'cmt_draft', 404], // under a draft the reporter cannot read
    ['store', 's_ali', 201],
    ['store', 's_omar', 404], // suspended
    ['product', 'cp_live', 201],
    ['product', 'cp_gone', 404], // not listed
    ['request', 'req_open', 201],
    ['request', 'req_private', 404],
    ['request', 'req_closed', 404],
  ];
  for (const [target_type, target_id, status] of cases) {
    const r = await post(as(raw, EVE), '/api/community/reports', { target_type, target_id, reason: 'other' });
    assert.equal(r.status, status, `${target_type}:${target_id} → ${JSON.stringify(await json(r.clone()))}`);
    if (status === 404) assert.equal((await json(r)).code, 'REPORT_TARGET_NOT_FOUND');
  }
});

test('a mute is silent on the bell: the muted person\'s like, comment and follow say nothing to the one who muted them', async () => {
  const raw = seed();
  const id = await published(raw, SARA);
  await published(raw, EVE, 'Eve\'s vase');
  await put(as(raw, SARA), '/api/community/users/eve/mute');
  assert.equal((await put(as(raw, EVE), `/api/community/posts/${id}/like`)).status, 200, 'a mute is not a block: the door stays open');
  assert.equal((await post(as(raw, EVE), `/api/community/posts/${id}/comments`, { body: 'Lovely' })).status, 201);
  assert.equal((await put(as(raw, EVE), '/api/community/users/sara/follow')).status, 200);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'sara'"), 0, 'sara hears nothing from eve');
  assert.equal(row(raw, 'SELECT like_count, comment_count FROM community_posts WHERE id = ?', id)!.like_count, 1, 'the facts are still the facts');
  assert.equal(row(raw, "SELECT follower_count FROM users WHERE id = 'sara'")!.follower_count, 1);
  // Someone sara did not mute still reaches her, and a reply to eve's comment tells eve (eve muted nobody).
  await put(as(raw, OMAR), `/api/community/posts/${id}/like`);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'sara'"), 1);
  const eves = (await json(await get(as(raw, null), `/api/community/posts/${id}/comments`))).comments[0].id as string;
  ageComments(raw);
  await post(as(raw, OMAR), `/api/community/posts/${id}/comments`, { body: 'Agreed', parent_id: eves });
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'eve' AND kind = 'comment_replied'"), 1);
});

test('GET /posts?not_kind=project is the creator\'s «المنشورات»: an exact total and no projects in it; the post page says whether one follows its author', async () => {
  const raw = seed();
  await published(raw, SARA, 'Dragon one');
  await published(raw, SARA, 'Dragon two');
  const postId = await draft(raw, SARA, 'A photo');
  raw.exec(`UPDATE community_posts SET kind = 'post' WHERE id = '${postId}'`);
  await post(as(raw, SARA), `/api/community/posts/${postId}/publish`);
  const all = await json(await get(as(raw, null), '/api/community/posts?author=sara'));
  assert.equal(all.total, 3);
  const posts = await json(await get(as(raw, null), '/api/community/posts?author=sara&not_kind=project'));
  assert.deepEqual(posts.posts.map((p: { id: string }) => p.id), [postId]);
  assert.equal(posts.total, 1, 'the total counts what the list shows');
  assert.equal(posts.next_cursor, null);
  const projects = await json(await get(as(raw, null), '/api/community/posts?author=sara&kind=project'));
  assert.equal(projects.total, 2);
  assert.equal((await json(await get(as(raw, null), '/api/community/posts?not_kind=nope'))).total, 3, 'an unknown kind filters nothing');

  const page = (await json(await get(as(raw, EVE), `/api/community/posts/${postId}`))).post;
  assert.equal(page.viewer.following_author, false);
  await put(as(raw, EVE), '/api/community/users/sara/follow');
  assert.equal((await json(await get(as(raw, EVE), `/api/community/posts/${postId}`))).post.viewer.following_author, true);
  assert.equal((await json(await get(as(raw, SARA), `/api/community/posts/${postId}`))).post.viewer.following_author, false, 'one does not follow oneself');
  assert.equal((await json(await get(as(raw, null), `/api/community/posts/${postId}`))).post.viewer.following_author, false);
});

test('notification links land somewhere: a follower without a page links to the directory, a comment opens the sheet', async () => {
  const raw = seed();
  const id = await published(raw, SARA);
  await put(as(raw, OMAR), '/api/community/users/sara/follow'); // omar has a username and no page
  assert.equal(row(raw, "SELECT link FROM user_notifications WHERE user_id = 'sara' AND kind = 'new_follower'")!.link, '/community?tab=creators');
  await published(raw, EVE, 'Eve\'s vase'); // now eve has a page
  await put(as(raw, EVE), '/api/community/users/sara/follow');
  assert.equal(row(raw, "SELECT link FROM user_notifications WHERE user_id = 'sara' AND kind = 'new_follower'")!.link, '/u/eve');
  const c1 = (await json(await post(as(raw, OMAR), `/api/community/posts/${id}/comments`, { body: 'Hi' }))).comment;
  assert.equal(row(raw, "SELECT link FROM user_notifications WHERE user_id = 'sara' AND kind = 'post_commented'")!.link, `/community/projects/${id}#comments`);
  ageComments(raw);
  await post(as(raw, EVE), `/api/community/posts/${id}/comments`, { body: 'Hey', parent_id: c1.id });
  assert.equal(row(raw, "SELECT link FROM user_notifications WHERE user_id = 'omar' AND kind = 'comment_replied'")!.link, `/community/projects/${id}#comments`);
});
