/**
 * PROJECTS, POSTS AND CREATOR PAGES (0153; docs/COMMUNITY_ECOSYSTEM.md Phase 1)
 * over the real routes — and every rule of theirs as an attack:
 *
 *   · a draft is nobody's business; publishing puts it in the feed and opens
 *     the author's creator page;
 *   · every link and every picture is the author's own, checked in the
 *     database — a forged store, product or media key is refused with the
 *     words a missing one gets;
 *   · unlisted is the link only; private is the author only; a post Levonis
 *     hid is a 404 to everybody but its author (who is told why) and staff;
 *   · a workshop's portfolio piece waits for the customer's consent, and only
 *     that customer can give it;
 *   · a creator page exists only for an account that chose to be public, and
 *     never carries an email or a phone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, get, patch, json, count, row, type StubUser, type Mount } from './fixtures/app';
import { communityRoutes } from '../worker/routes/community';
import { communityPostRoutes } from '../worker/routes/communityPosts';

const SARA: StubUser = { id: 'sara', role: 'customer', email: 'sara@x.co' };
const EVE: StubUser = { id: 'eve', role: 'customer', email: 'eve@x.co' };
const ALI: StubUser = { id: 'ali', role: 'merchant', email: 'ali@x.co' };
const BOSS: StubUser = { id: 'boss', role: 'admin', email: 'boss@x.co' };

const mount: Mount = (a) => {
  a.route('/api/community', communityRoutes);
  a.route('/api/community', communityPostRoutes);
};

function seed(open = true) {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username,phone_e164,bio,profile_json) VALUES
      ('sara','Sara Kareem','sara@x.co','h','customer','sara','+9647700000009','I print at home','{"instagram":"sara.prints","secret_note":"x"}'),
      ('eve','Eve','eve@x.co','h','customer','eve',NULL,'','{}'),
      ('ali','Ali','ali@x.co','h','merchant','ali',NULL,'','{}'),
      ('boss','Boss','boss@x.co','h','admin','boss',NULL,'','{}');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m_ali','ali','Ali 3D','active');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status) VALUES ('s_ali','m_ali','ali','ali3d','Ali 3D Store','active');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock) VALUES
      ('cp_vase','m_ali','s_ali','vase','Vase','active','active',25000,5,1);
    INSERT INTO products (id,slug,name,name_ar,price_iqd,status) VALUES
      ('p_a1','bambu-a1','Bambu Lab A1','بامبو A1',450000,'active'),
      ('p_pla','pla-black','PLA Black 1kg','PLA أسود',22000,'active');
    INSERT INTO file_objects (object_key,visibility,domain,owner_id,entity_id,mime_type,byte_size,width,height) VALUES
      ('users/sara/posts/a1.webp','public','users','sara','sara','image/webp',1000,1200,900),
      ('users/sara/posts/a2.webp','public','users','sara','sara','image/webp',1000,1200,900),
      ('users/sara/posts/v1.mp4','public','users','sara','sara','video/mp4',5000,NULL,NULL),
      ('users/eve/posts/e1.webp','public','users','eve','eve','image/webp',1000,800,800),
      ('merchants/ali/public/w1.webp','public','merchants','ali','ali','image/webp',1000,1000,1000);
    INSERT INTO community_requests (id,customer_id,title,description,status,state,visibility) VALUES
      ('req_eve','eve','Phone stand','A stand','closed','in_progress','public');
    INSERT INTO community_offers (id,request_id,merchant_id,store_id,price_iqd,completion_days,state) VALUES
      ('off_ali','req_eve','m_ali','s_ali',40000,2,'accepted');
    UPDATE community_requests SET accepted_offer_id = 'off_ali' WHERE id = 'req_eve';
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','${open ? '{"open":true}' : '{"open":false}'}');
  `);
  return raw;
}
const as = (raw: DatabaseSync, user: StubUser | null) => stubApp(asD1(raw), user, mount);

const PROJECT = {
  title: 'Articulated dragon',
  body: 'Printed in two colours, no supports.',
  kind: 'project',
  printer_product_id: 'p_a1',
  material_product_id: 'p_pla',
  color: 'black',
  print_settings: { layer_height_mm: 0.2, infill_percent: 15, supports: false, nozzle_mm: 0.4 },
  print_time_minutes: 380,
  dimensions: { x_mm: 220, y_mm: 60, z_mm: 40 },
  tags: ['Dragon', '#toy', 'dragon', 'PLA'],
  media: [{ key: 'users/sara/posts/a1.webp', kind: 'image', width: 1200, height: 900 }, { key: '/files/users/sara/posts/v1.mp4', kind: 'video', duration_s: 12 }],
};

async function published(raw: DatabaseSync, who: StubUser = SARA, body: Record<string, unknown> = PROJECT): Promise<string> {
  const made = await post(as(raw, who), '/api/community/posts', body);
  assert.equal(made.status, 201, JSON.stringify(await json(made.clone())));
  const id = (await json(made)).post.id as string;
  const pub = await post(as(raw, who), `/api/community/posts/${id}/publish`);
  assert.equal(pub.status, 200, JSON.stringify(await json(pub.clone())));
  return id;
}

// ================================================================ the happy path

test('a draft is nobody\'s business; publishing puts it in the feed with its facts and doors, and opens the creator page', async () => {
  const raw = seed();
  const made = await post(as(raw, SARA), '/api/community/posts', PROJECT);
  assert.equal(made.status, 201, JSON.stringify(await json(made.clone())));
  const draft = (await json(made)).post;
  assert.equal(draft.state, 'draft');
  assert.deepEqual(draft.tags, ['dragon', 'toy', 'pla'], 'tags are lower-cased, de-duplicated, without #');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_post_media WHERE post_id = ?', draft.id), 2);

  // Not in the feed, not readable by anyone else, not on a creator page yet.
  assert.deepEqual((await json(await get(as(raw, null), '/api/community/posts'))).posts, []);
  assert.equal((await get(as(raw, EVE), `/api/community/posts/${draft.id}`)).status, 404);
  assert.equal((await get(as(raw, null), '/api/community/creators/sara')).status, 404, 'a plain account has no public page');
  assert.equal((await get(as(raw, SARA), `/api/community/posts/${draft.id}`)).status, 200, 'the author reads their own draft');

  // Publishing needs a picture (it has two) and sets the date.
  const pub = await post(as(raw, SARA), `/api/community/posts/${draft.id}/publish`);
  assert.equal(pub.status, 200, JSON.stringify(await json(pub.clone())));
  assert.ok((await json(pub)).post.published_at);
  assert.equal((await post(as(raw, SARA), `/api/community/posts/${draft.id}/publish`)).status, 200, 'a second tap is a replay');

  const feed = await json(await get(as(raw, null), '/api/community/posts'));
  assert.equal(feed.posts.length, 1);
  const card = feed.posts[0];
  assert.equal(card.author.username, 'sara');
  assert.equal(card.cover.url, '/files/users/sara/posts/a1.webp');
  assert.equal(card.media_count, 2);
  assert.equal(card.printer.product.slug, 'bambu-a1');
  assert.equal(card.material.product.url, '/product/pla-black');
  assert.deepEqual(card.counts, { likes: 0, comments: 0, saves: 0, views: 0 });
  assert.equal(card.url, `/community/projects/${draft.id}`);
  assert.equal(feed.total, 1);

  // The page: body, media, settings; a stranger never sees the storage keys of the media.
  const page = (await json(await get(as(raw, EVE), `/api/community/posts/${draft.id}`))).post;
  assert.equal(page.print_settings.layer_height_mm, 0.2);
  assert.equal(page.media.length, 2);
  assert.equal(page.media[0].key, undefined);
  assert.equal(page.viewer.mine, false);

  // The creator page is public now, with the socials she typed and nothing private.
  const creator = await get(as(raw, null), '/api/community/creators/sara');
  assert.equal(creator.status, 200);
  const text = await creator.clone().text();
  assert.ok(!text.includes('sara@x.co') && !text.includes('+9647700000009') && !text.includes('secret_note'), 'no email, phone or unknown profile key');
  const c = (await json(creator)).creator;
  assert.deepEqual([c.username, c.socials.instagram, c.stats.projects, c.store], ['sara', 'sara.prints', 1, null]);
});

test('the feed narrows on the server — kind, author, tag, a search term — and pages by (published_at, id)', async () => {
  const raw = seed();
  const a = await published(raw, SARA, { ...PROJECT, title: 'Dragon one' });
  const b = await published(raw, SARA, { ...PROJECT, title: 'Timelapse of a vase', kind: 'timelapse', tags: ['vase'], media: [{ key: 'users/sara/posts/a2.webp', kind: 'image' }] });
  const list = async (qs: string) => ((await json(await get(as(raw, null), `/api/community/posts${qs}`))).posts as Array<{ id: string }>).map((p) => p.id);
  assert.deepEqual(await list(''), [b, a], 'newest first');
  assert.deepEqual(await list('?kind=timelapse'), [b]);
  assert.deepEqual(await list('?tag=Dragon'), [a]);
  assert.deepEqual(await list('?q=vase'), [b]);
  assert.deepEqual(await list('?author=sara'), [b, a]);
  assert.deepEqual(await list('?author=eve'), []);
  const first = await json(await get(as(raw, null), '/api/community/posts?limit=1'));
  assert.deepEqual(first.posts.map((p: { id: string }) => p.id), [b]);
  assert.ok(first.next_cursor);
  const second = await json(await get(as(raw, null), `/api/community/posts?limit=1&cursor=${encodeURIComponent(first.next_cursor)}`));
  assert.deepEqual(second.posts.map((p: { id: string }) => p.id), [a]);
  assert.equal(second.next_cursor, null);
  assert.equal((await json(await get(as(raw, null), '/api/community/posts/trending'))).posts.length, 2);
});

// ================================================================ attacks

test('ATTACK: a picture that is not the author\'s — another account\'s key, a key not in the ledger, a wrong kind — is refused, nothing written', async () => {
  const raw = seed();
  const tries: Array<[Record<string, unknown>, string]> = [
    [{ ...PROJECT, media: [{ key: 'users/eve/posts/e1.webp', kind: 'image' }] }, 'POST_MEDIA_NOT_OWNED'],
    [{ ...PROJECT, media: [{ key: 'users/sara/posts/never-uploaded.webp', kind: 'image' }] }, 'POST_MEDIA_NOT_OWNED'],
    [{ ...PROJECT, media: [{ key: 'merchants/ali/public/w1.webp', kind: 'image' }] }, 'POST_MEDIA_NOT_OWNED'],
    [{ ...PROJECT, media: [{ key: '../users/sara/posts/a1.webp', kind: 'image' }] }, 'POST_MEDIA_NOT_OWNED'],
    [{ ...PROJECT, media: [{ key: 'users/sara/posts/v1.mp4', kind: 'image' }] }, 'POST_MEDIA_KIND'],
    [{ ...PROJECT, media: Array.from({ length: 13 }, () => ({ key: 'users/sara/posts/a1.webp', kind: 'image' })) }, 'POST_MEDIA_TOO_MANY'],
  ];
  for (const [body, code] of tries) {
    const r = await post(as(raw, SARA), '/api/community/posts', body);
    assert.equal(r.status, 400, code);
    assert.equal((await json(r)).code, code);
  }
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_posts'), 0);
});

test('ATTACK: a forged link — a store the author does not own, a product of another store, a private product, a printer that is not in the catalogue', async () => {
  const raw = seed();
  raw.exec(`INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd,stock,track_stock,audience_user_id)
            VALUES ('cp_private','m_ali','s_ali','custom-x','Private lamp','hidden','active',60000,1,1,'eve')`);
  const tries: Array<[StubUser, Record<string, unknown>, string]> = [
    [SARA, { ...PROJECT, store_id: 's_ali' }, 'POST_LINK_NOT_OWNED'],
    [SARA, { ...PROJECT, product_id: 'cp_vase' }, 'POST_LINK_NOT_OWNED'],
    [ALI, { ...PROJECT, media: [{ key: 'merchants/ali/public/w1.webp', kind: 'image' }], store_id: 's_ali', product_id: 'cp_private' }, 'POST_LINK_NOT_OWNED'],
    [SARA, { ...PROJECT, printer_product_id: 'p_nope' }, 'POST_LINK_NOT_FOUND'],
    [SARA, { ...PROJECT, request_id: 'req_eve' }, 'POST_LINK_NOT_OWNED'],
  ];
  for (const [who, body, code] of tries) {
    const r = await post(as(raw, who), '/api/community/posts', body);
    assert.equal(r.status, 400, `${code}: ${JSON.stringify(await json(r.clone()))}`);
    assert.equal((await json(r)).code, code);
  }
  // The store owner linking their own store and product is fine.
  const ok = await post(as(raw, ALI), '/api/community/posts', { ...PROJECT, media: [{ key: 'merchants/ali/public/w1.webp', kind: 'image' }], store_id: 's_ali', product_id: 'cp_vase' });
  assert.equal(ok.status, 201, JSON.stringify(await json(ok.clone())));
  assert.equal((await json(ok)).post.product.slug, 'vase');
});

test('ATTACK: only the author edits, publishes, archives or deletes; the body cannot set counters, state or the author', async () => {
  const raw = seed();
  const id = await published(raw);
  for (const [who, verb, path, body] of [
    [EVE, 'patch', `/api/community/posts/${id}`, { title: 'Mine now' }],
    [EVE, 'post', `/api/community/posts/${id}/archive`, {}],
    [EVE, 'post', `/api/community/posts/${id}/publish`, {}],
    [ALI, 'patch', `/api/community/posts/${id}`, { title: 'Mine now' }],
  ] as const) {
    const r = verb === 'patch' ? await patch(as(raw, who), path, body) : await post(as(raw, who), path, body);
    assert.equal(r.status, 404, `${who.id} ${path}`);
  }
  const del = await as(raw, EVE).request(`/api/community/posts/${id}`, { method: 'DELETE' });
  assert.equal(del.status, 404);
  assert.equal(row<{ title: string }>(raw, 'SELECT title FROM community_posts WHERE id = ?', id)!.title, 'Articulated dragon');

  const edited = await patch(as(raw, SARA), `/api/community/posts/${id}`, { title: 'Dragon v2', like_count: 999, state: 'archived', author_id: 'eve', view_count: 5 });
  assert.equal(edited.status, 200);
  const p = row<Record<string, unknown>>(raw, 'SELECT title, like_count, state, author_id, view_count FROM community_posts WHERE id = ?', id)!;
  assert.deepEqual([p.title, p.like_count, p.state, p.author_id, p.view_count], ['Dragon v2', 0, 'published', 'sara', 0]);

  // A published post is archived before it can be deleted; then restored to a draft.
  assert.equal((await as(raw, SARA).request(`/api/community/posts/${id}`, { method: 'DELETE' })).status, 409);
  assert.equal((await post(as(raw, SARA), `/api/community/posts/${id}/archive`)).status, 200);
  assert.deepEqual((await json(await get(as(raw, null), '/api/community/posts'))).posts, [], 'archived leaves the feed');
  assert.equal((await post(as(raw, SARA), `/api/community/posts/${id}/restore`)).status, 200);
  assert.equal(row<{ state: string }>(raw, 'SELECT state FROM community_posts WHERE id = ?', id)!.state, 'draft');
  assert.equal((await as(raw, SARA).request(`/api/community/posts/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_posts'), 0);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_post_media'), 0, 'its pictures\' rows went with it');
});

test('unlisted is the link only, private is the author only, and a post Levonis hid is a 404 to all but its author and staff', async () => {
  const raw = seed();
  const unlisted = await published(raw, SARA, { ...PROJECT, visibility: 'unlisted' });
  const priv = await published(raw, SARA, { ...PROJECT, visibility: 'private', media: [{ key: 'users/sara/posts/a2.webp', kind: 'image' }] });
  const open = await published(raw, SARA, { ...PROJECT, title: 'Open one' });
  const feed = (await json(await get(as(raw, null), '/api/community/posts'))).posts.map((p: { id: string }) => p.id);
  assert.deepEqual(feed, [open]);
  assert.equal((await get(as(raw, EVE), `/api/community/posts/${unlisted}`)).status, 200, 'unlisted by link');
  assert.equal((await get(as(raw, EVE), `/api/community/posts/${priv}`)).status, 404, 'private to others');
  assert.equal((await get(as(raw, SARA), `/api/community/posts/${priv}`)).status, 200);
  assert.equal((await json(await get(as(raw, null), '/api/community/creators/sara'))).creator.stats.projects, 1, 'only the public one counts');

  raw.exec(`UPDATE community_posts SET admin_hidden_at = '2026-09-29T00:00:00.000Z', admin_hidden_reason = 'copyright' WHERE id = '${open}'`);
  assert.deepEqual((await json(await get(as(raw, null), '/api/community/posts'))).posts, []);
  assert.equal((await get(as(raw, EVE), `/api/community/posts/${open}`)).status, 404);
  const mine = (await json(await get(as(raw, SARA), `/api/community/posts/${open}`))).post;
  assert.equal(mine.hidden.reason, 'copyright', 'the author is told why');
  assert.equal((await get(as(raw, BOSS), `/api/community/posts/${open}`)).status, 200, 'staff read it');
  // Re-publishing a hidden post is refused until the review is lifted.
  await post(as(raw, SARA), `/api/community/posts/${open}/archive`);
  await post(as(raw, SARA), `/api/community/posts/${open}/restore`);
  const again = await post(as(raw, SARA), `/api/community/posts/${open}/publish`);
  assert.equal(again.status, 409);
  assert.equal((await json(again)).code, 'POST_HIDDEN_BY_ADMIN');
});

test('a workshop\'s portfolio piece from a customer\'s job waits for that customer\'s consent — and only they can give it', async () => {
  const raw = seed();
  const made = await post(as(raw, ALI), '/api/community/posts', {
    ...PROJECT, title: 'A stand we made', media: [{ key: 'merchants/ali/public/w1.webp', kind: 'image' }], store_id: 's_ali', request_id: 'req_eve',
  });
  assert.equal(made.status, 201, JSON.stringify(await json(made.clone())));
  const id = (await json(made)).post.id as string;
  assert.equal(row<{ consent_status: string }>(raw, 'SELECT consent_status FROM community_posts WHERE id = ?', id)!.consent_status, 'pending');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'eve' AND kind = 'portfolio_consent'"), 1, 'the customer is asked');

  const refused = await post(as(raw, ALI), `/api/community/posts/${id}/publish`);
  assert.equal(refused.status, 409);
  assert.equal((await json(refused)).code, 'CONSENT_REQUIRED');

  // Neither a stranger nor the workshop itself can answer for the customer.
  assert.equal((await post(as(raw, SARA), `/api/community/posts/${id}/consent`, { decision: 'granted' })).status, 404);
  assert.equal((await post(as(raw, ALI), `/api/community/posts/${id}/consent`, { decision: 'granted' })).status, 404);
  assert.equal((await post(as(raw, EVE), `/api/community/posts/${id}/consent`, { decision: 'granted' })).status, 200);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = 'ali' AND kind = 'portfolio_consent'"), 1, 'the workshop hears the answer');
  assert.equal((await post(as(raw, ALI), `/api/community/posts/${id}/publish`)).status, 200);

  // The customer's OWN job needs nobody's consent.
  const own = await post(as(raw, EVE), '/api/community/posts', { ...PROJECT, media: [{ key: 'users/eve/posts/e1.webp', kind: 'image' }], request_id: 'req_eve' });
  assert.equal(own.status, 201, JSON.stringify(await json(own.clone())));
  assert.equal(row<{ consent_status: string }>(raw, 'SELECT consent_status FROM community_posts WHERE id = ?', (await json(own)).post.id)!.consent_status, 'not_needed');
});

test('a store owner is a public creator through their store; the page carries the store card and the merchant badges', async () => {
  const raw = seed();
  const r = await get(as(raw, null), '/api/community/creators/ali');
  assert.equal(r.status, 200);
  const c = (await json(r)).creator;
  assert.equal(c.store.store_slug, 'ali3d');
  assert.equal(c.store.store_name, 'Ali 3D Store');
  assert.equal(typeof c.badges.verified_merchant, 'boolean');
  raw.exec("UPDATE community_merchants SET status = 'suspended' WHERE id = 'm_ali'");
  assert.equal((await get(as(raw, null), '/api/community/creators/ali')).status, 404, 'a sanctioned shop\'s owner is not advertised');
  assert.equal((await get(as(raw, ALI), '/api/community/creators/ali')).status, 200, 'except to themselves');
});

test('the new reads and writes sit inside the maintenance wall', async () => {
  const raw = seed(false);
  for (const path of ['/api/community/posts', '/api/community/posts/trending', '/api/community/creators/ali']) {
    assert.equal((await get(as(raw, SARA), path)).status, 503, path);
  }
  assert.equal((await post(as(raw, SARA), '/api/community/posts', PROJECT)).status, 503);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM community_posts'), 0);
});
