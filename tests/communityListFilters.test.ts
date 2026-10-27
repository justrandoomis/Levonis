/**
 * THE COMMUNITY LISTS' FILTERS AND EXTRA FIELDS (plan B3; the closed lists
 * are packages/contracts/src/communityFilters.ts) — one test per parameter,
 * over the real routes and migrations.
 *
 * Each filter is validated (a value outside its list is 400, never read into
 * SQL), ANDed into the list's one `where` so the first page's `total` counts
 * exactly the rows it lets through, and each new field keeps the privacy of
 * the list it rides on: no private workshop preference in a card, no place
 * for a person, no request file for a reader who may not open it, and works
 * only from what the public may already see. The works and the cover are
 * read for a whole page in one statement, never one per row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { approveMerchants, asD1, freshDb, get, json, stubApp, type Mount, type StubUser } from './fixtures/app';
import { addFile, as as worldAs, newDraft, offerOn, PLA, publish, world } from './fixtures/requestModelWorld';
import { communityRoutes } from '../worker/routes/community';
import { communityPostRoutes } from '../worker/routes/communityPosts';
import { communitySocialRoutes } from '../worker/routes/communitySocial';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import { printRequestRoutes } from '../worker/routes/printRequests';
import { POST_MATERIAL_IDS, POST_PRINTER_IDS } from '../packages/contracts/src/communityFilters';

const mount: Mount = (a) => {
  a.route('/api/community', communityRoutes);
  a.route('/api/community', communityPostRoutes);
  a.route('/api/community', communitySocialRoutes);
  a.route('/api/marketplace/print', printRequestRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
};
const VIC: StubUser = { id: 'vic', role: 'customer', email: 'vic@x.co', username: 'vic' };
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

/**
 * The social world: two makers (Sara, Eve), three approved workshops (Ali
 * FDM in Baghdad with a design service, Omar resin in Erbil, Zed with no
 * store), one workshop nobody approved (Hid), and Vic, who follows Sara and
 * Ali's store.
 */
function seed(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username,creator_public,follower_count) VALUES
      ('sara','Sara','sara@x.co','h','customer','sara',1,5),
      ('eve','Eve','eve@x.co','h','customer','eve',1,9),
      ('ali','Ali','ali@x.co','h','customer','ali',0,2),
      ('omar','Omar','omar@x.co','h','customer','omar',0,1),
      ('zed','Zed','zed@x.co','h','customer','zed',0,0),
      ('hid','Hid','hid@x.co','h','customer','hid',0,50),
      ('vic','Vic','vic@x.co','h','customer','vic',0,0);
    INSERT INTO community_merchants (id,user_id,name,status,phone,governorate) VALUES
      ('m_ali','ali','Ali 3D','active','+9647500000001','baghdad'),
      ('m_omar','omar','Omar Resin','active','',''),
      ('m_zed','zed','Zed Design','active','',''),
      ('m_hid','hid','Hidden Lab','active','','');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status,governorate,logo_key) VALUES
      ('s_ali','m_ali','ali','ali3d','Ali 3D','active','baghdad','merchants/ali/public/logo.webp'),
      ('s_omar','m_omar','omar','omarresin','Omar Resin','active','erbil',NULL),
      ('s_hid','m_hid','hid','hidlab','Hidden Lab','active','baghdad',NULL);
    INSERT INTO merchant_printers (id,merchant_id,store_id,name,technology,build_x_mm,build_y_mm,build_z_mm,materials,quality_max) VALUES
      ('pr_ali','m_ali','s_ali','A1','fdm',256,256,256,'[]','fine'),
      ('pr_omar','m_omar','s_omar','Old FDM','fdm',200,200,200,'[]','fine'),
      ('pr_hid','m_hid','s_hid','Saturn','resin',200,200,200,'[]','ultra');
    INSERT INTO merchant_request_prefs (merchant_id, technologies, workshop_intro) VALUES ('m_omar','["resin"]','A private note');
    INSERT INTO merchant_services (id,store_id,merchant_id,title,kind,active) VALUES
      ('sv_ali','s_ali','m_ali','Modelling','design',1),
      ('sv_omar','s_omar','m_omar','Modelling','design',0),
      ('sv_hid','s_hid','m_hid','Modelling','design',1);
    INSERT INTO merchant_showcase (id,store_id,kind,title,image_key,sort_order,active) VALUES
      ('w_a3','s_ali','work','Third','merchants/ali/public/w3.webp',2,1),
      ('w_a1','s_ali','work','First','merchants/ali/public/w1.webp',0,1),
      ('w_a4','s_ali','work','Fourth','merchants/ali/public/w4.webp',3,1),
      ('w_a2','s_ali','work','Second','merchants/ali/public/w2.webp',1,1),
      ('w_a0','s_ali','work','No picture',NULL,0,1),
      ('w_ax','s_ali','work','Retired','merchants/ali/public/wx.webp',0,0),
      ('w_ap','s_ali','printer','A printer','merchants/ali/public/p.webp',0,1),
      ('w_o1','s_omar','work','Mini','merchants/omar/public/w1.webp',0,1),
      ('w_h1','s_hid','work','Hidden','merchants/hid/public/w1.webp',0,1);
    INSERT INTO user_follows (follower_id,user_id) VALUES ('vic','sara');
    INSERT INTO follows (user_id,merchant_id) VALUES ('vic','m_ali');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  approveMerchants(raw);
  raw.prepare(`UPDATE community_merchants SET approved_at = NULL WHERE id = 'm_hid'`).run();
  const posts: Array<[string, string, string, string, number, string, string, number, string | null, string]> = [
    // id, author, title, state, age in days, material, printer, likes, hidden, media kind
    ['p1', 'sara', 'Desk lamp', 'published', 10, 'PLA Matte', 'Bambu Lab A1', 1, null, 'image'],
    ['p2', 'eve', 'Gear set', 'published', 1, 'PETG', 'Prusa MK4', 50, null, 'image'],
    ['p3', 'ali', 'Resin mini', 'published', 2, 'Standard Resin', 'Elegoo Saturn 3', 5, null, 'image'],
    ['p4', 'eve', 'Cable clip', 'published', 3, 'PLA+', 'Ender 3 V3', 0, null, 'video'],
    ['p5', 'sara', 'Old bridge', 'published', 40, 'PLA', 'Prusa MK3', 0, null, 'image'],
    ['p6', 'sara', 'Taken down', 'published', 1, 'PLA', 'Bambu Lab A1', 9, day(0), 'image'],
    ['p7', 'sara', 'Unfinished', 'draft', 0, 'PLA', 'Bambu Lab A1', 0, null, 'image'],
    ['p8', 'sara', 'Vase', 'published', 4, 'PLA Silk', 'Bambu Lab P1S', 0, null, 'image'],
    ['p9', 'sara', 'Stand', 'published', 5, '', '', 0, null, 'image'],
  ];
  for (const [id, author, title, state, age, material, printer, likes, hidden, media] of posts) {
    raw.prepare(
      `INSERT INTO community_posts (id,author_id,kind,title,body,state,visibility,material,printer_name,like_count,admin_hidden_at,published_at,tags)
       VALUES (?,?,'project',?,'',?,'public',?,?,?,?,?,'[]')`
    ).run(id, author, title, state, material, printer, likes, hidden, state === 'published' ? day(age) : null);
    raw.prepare(`INSERT INTO community_post_media (id,post_id,kind,media_key,width,height,sort_order) VALUES (?,?,?,?,800,600,0)`)
      .run(`${id}_m`, id, media, `users/${author}/posts/${id}.${media === 'image' ? 'webp' : 'mp4'}`);
  }
  raw.exec(`
    INSERT INTO community_post_files (id,post_id,file_key,kind,name,bytes,mime,downloadable,position) VALUES
      ('pf1','p1','users/sara/private/pf1.stl','model','lamp',1000,'model/stl',1,0),
      ('pf2','p1','users/sara/private/pf2','model','base',1000,'model/3mf',1,1),
      ('pf3','p3','users/ali/private/pf3.stl','model','mini.stl',1000,'model/stl',0,0);
    INSERT INTO community_comments (id,post_id,author_id,body,state,created_at) VALUES
      ('c1','p1','eve','First','visible','2026-10-01T00:00:01.000Z'),
      ('c2','p1','vic','Second','visible','2026-10-01T00:00:02.000Z'),
      ('c3','p1','sara','Third','visible','2026-10-01T00:00:03.000Z');
  `);
  return raw;
}

const as = (raw: DatabaseSync, user: StubUser | null = null, db?: D1Database) => stubApp(db ?? asD1(raw), user, mount);
const read = async (raw: DatabaseSync, path: string, user: StubUser | null = null) => {
  const res = await get(as(raw, user), path);
  return { status: res.status, body: await json(res) };
};
const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

/** A D1 that counts the statements a request prepares — the N+1 probe. */
function counting(raw: DatabaseSync): { db: D1Database; n: () => number } {
  const db = asD1(raw);
  let n = 0;
  const prepare = db.prepare.bind(db);
  (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
    n++;
    return prepare(sql);
  }) as typeof db.prepare;
  return { db, n: () => n };
}

// ------------------------------------------------------------------ projects

test('trending: days=7|30 (default 30), echoed as window_days; anything else is refused', async () => {
  const raw = seed();
  const month = await read(raw, '/api/community/posts/trending');
  assert.equal(month.status, 200);
  assert.equal(month.body.window_days, 30);
  assert.deepEqual(new Set(ids(month.body.posts)), new Set(['p1', 'p2', 'p3', 'p4', 'p8', 'p9']), 'never a hidden post, a draft or one older than the window');
  const week = await read(raw, '/api/community/posts/trending?days=7');
  assert.equal(week.body.window_days, 7);
  assert.deepEqual(new Set(ids(week.body.posts)), new Set(['p2', 'p3', 'p4', 'p8', 'p9']));
  assert.equal((await read(raw, '/api/community/posts/trending?days=14')).status, 400);
});

test('posts: material is a family matched as a word, ANDed into the total', async () => {
  const raw = seed();
  const pla = await read(raw, '/api/community/posts?material=pla');
  assert.equal(pla.status, 200);
  assert.deepEqual(new Set(ids(pla.body.posts)), new Set(['p1', 'p4', 'p5', 'p8']), '«PLA Matte», «PLA+», «PLA», «PLA Silk»; not PETG');
  assert.equal(pla.body.total, 4);
  assert.deepEqual(ids((await read(raw, '/api/community/posts?material=resin')).body.posts), ['p3']);
  assert.deepEqual(ids((await read(raw, '/api/community/posts?material=petg')).body.posts), ['p2']);
  const none = await read(raw, '/api/community/posts?material=asa');
  assert.deepEqual(none.body.posts, []);
  assert.equal(none.body.total, 0);
  assert.equal((await read(raw, '/api/community/posts?material=PLA%25')).status, 400);
  assert.ok(POST_MATERIAL_IDS.includes('pla'));
});

test('posts: printer is a brand matched in the printer, ANDed into the total', async () => {
  const raw = seed();
  const ender = await read(raw, '/api/community/posts?printer=creality');
  assert.deepEqual(ids(ender.body.posts), ['p4'], '«Ender 3 V3» is a Creality');
  assert.equal(ender.body.total, 1);
  const prusa = await read(raw, '/api/community/posts?printer=prusa');
  assert.deepEqual(new Set(ids(prusa.body.posts)), new Set(['p2', 'p5']));
  assert.equal(prusa.body.total, 2);
  const both = await read(raw, '/api/community/posts?printer=bambu&material=pla');
  assert.deepEqual(new Set(ids(both.body.posts)), new Set(['p1', 'p8']));
  assert.equal(both.body.total, 2);
  assert.equal((await read(raw, '/api/community/posts?printer=makerbot')).status, 400);
  assert.ok(POST_PRINTER_IDS.includes('bambu'));
});

test('posts: sort=popular orders by engagement and pages without a gap or a repeat', async () => {
  const raw = seed();
  const newest = await read(raw, '/api/community/posts');
  assert.deepEqual(ids(newest.body.posts), ['p2', 'p3', 'p4', 'p8', 'p9', 'p1', 'p5']);
  const seen: string[] = [];
  let cursor: string | null = null;
  let total: number | null = null;
  do {
    const page = await read(raw, `/api/community/posts?sort=popular&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    if (total === null) total = page.body.total as number;
    seen.push(...ids(page.body.posts));
    cursor = page.body.next_cursor as string | null;
  } while (cursor);
  assert.deepEqual(seen, ['p2', 'p3', 'p1', 'p4', 'p8', 'p9', 'p5'], 'likes 50, 5, 1, then the newest first');
  assert.equal(total, 7);
  assert.equal((await read(raw, '/api/community/posts?sort=trending')).status, 400);
  assert.equal((await read(raw, '/api/community/posts?sort=popular&cursor=garbage')).status, 400);
});

test('posts: has_files=1 keeps the projects with a file their reader may download', async () => {
  const raw = seed();
  const files = await read(raw, '/api/community/posts?has_files=1');
  assert.deepEqual(ids(files.body.posts), ['p1'], 'p3 has a file, but not one to download');
  assert.equal(files.body.total, 1);
  assert.equal((await read(raw, '/api/community/posts?has_files=0')).body.total, 7);
  assert.equal((await read(raw, '/api/community/posts?has_files=yes')).status, 400);
});

test('a project file carries its extension, derived on the server, and never its key below the author', async () => {
  const raw = seed();
  const guest = await read(raw, '/api/community/posts/p1');
  assert.equal(guest.status, 200);
  const files = guest.body.post.files as Array<Record<string, unknown>>;
  assert.deepEqual(files.map((f) => [f.id, f.ext]), [['pf1', 'stl'], ['pf2', '3mf']], 'from the key, else from the type');
  assert.ok(files.every((f) => !('key' in f)), 'a reader never gets the key');
  const author = await read(raw, '/api/community/posts/p1', { id: 'sara', role: 'customer', email: 'sara@x.co' });
  assert.ok((author.body.post.files as Array<Record<string, unknown>>).every((f) => typeof f.key === 'string' && typeof f.ext === 'string'));
});

test('comments: order=newest reads the preview newest first, and pages that way', async () => {
  const raw = seed();
  const oldest = await read(raw, '/api/community/posts/p1/comments');
  assert.deepEqual(ids(oldest.body.comments), ['c1', 'c2', 'c3']);
  const first = await read(raw, '/api/community/posts/p1/comments?order=newest&limit=2');
  assert.deepEqual(ids(first.body.comments), ['c3', 'c2']);
  assert.equal(first.body.total, 3);
  const second = await read(raw, `/api/community/posts/p1/comments?order=newest&limit=2&cursor=${encodeURIComponent(first.body.next_cursor)}`);
  assert.deepEqual(ids(second.body.comments), ['c1']);
  assert.equal(second.body.next_cursor, null);
  assert.equal((await read(raw, '/api/community/posts/p1/comments?order=random')).status, 400);
});

// ------------------------------------------------------------------ the feed

test('feed: from=makers|stores reads one half of «أتابعهم», all both', async () => {
  const raw = seed();
  const all = await read(raw, '/api/community/feed?scope=following', VIC);
  assert.equal(all.status, 200);
  assert.deepEqual(new Set(ids(all.body.posts)), new Set(['p1', 'p3', 'p5', 'p8', 'p9']));
  assert.equal(all.body.from, 'all');
  const makers = await read(raw, '/api/community/feed?scope=following&from=makers', VIC);
  assert.deepEqual(new Set(ids(makers.body.posts)), new Set(['p1', 'p5', 'p8', 'p9']), 'Sara, whom Vic follows');
  const stores = await read(raw, '/api/community/feed?scope=following&from=stores', VIC);
  assert.deepEqual(ids(stores.body.posts), ['p3'], 'the owner of the store Vic follows');
  assert.equal((await read(raw, '/api/community/feed?scope=following&from=everyone', VIC)).status, 400);
  assert.equal((await read(raw, '/api/community/feed?scope=following&from=makers')).status, 401, 'a guest has no «أتابعهم»');
});

// ------------------------------------------------------------------ stores

test('stores: governorate is one of the eighteen, ANDed into the total', async () => {
  const raw = seed();
  const all = await read(raw, '/api/community/merchants');
  assert.deepEqual(new Set(all.body.merchants.map((m: { id: string }) => m.id)), new Set(['m_ali', 'm_omar']), 'never a workshop nobody approved');
  const baghdad = await read(raw, '/api/community/merchants?governorate=baghdad');
  assert.deepEqual(baghdad.body.merchants.map((m: { id: string }) => m.id), ['m_ali']);
  assert.equal(baghdad.body.total, 1);
  assert.equal((await read(raw, '/api/community/merchants?governorate=erbil')).body.total, 1);
  assert.equal((await read(raw, '/api/community/merchants?governorate=Baghdad')).status, 400, 'an id, not a label');
});

test('stores: tech reads the workshop technologies, the printers only when it declared none; no preference is served', async () => {
  const raw = seed();
  const fdm = await read(raw, '/api/community/merchants?tech=fdm');
  assert.deepEqual(fdm.body.merchants.map((m: { id: string }) => m.id), ['m_ali'], 'Omar declared resin; his old FDM printer does not override it');
  assert.equal(fdm.body.total, 1);
  const resin = await read(raw, '/api/community/merchants?tech=resin');
  assert.deepEqual(resin.body.merchants.map((m: { id: string }) => m.id), ['m_omar']);
  assert.equal(resin.body.total, 1);
  const text = JSON.stringify(resin.body);
  assert.ok(!text.includes('technologies') && !text.includes('A private note') && !text.includes('+9647500000001'), 'no private preference, intro or phone');
  assert.equal((await read(raw, '/api/community/merchants?tech=sla')).status, 400);
});

test('stores: service=design keeps the stores offering an active design service', async () => {
  const raw = seed();
  const design = await read(raw, '/api/community/merchants?service=design');
  assert.deepEqual(design.body.merchants.map((m: { id: string }) => m.id), ['m_ali'], 'Omar retired his');
  assert.equal(design.body.total, 1);
  const none = await read(raw, '/api/community/merchants?service=design&governorate=erbil');
  assert.deepEqual(none.body.merchants, []);
  assert.equal(none.body.total, 0);
  assert.equal((await read(raw, '/api/community/merchants?service=repair')).status, 400);
});

test('stores: each card carries up to three works with a picture, in the store order, read in one statement', async () => {
  const raw = seed();
  const all = await read(raw, '/api/community/merchants');
  const works = Object.fromEntries(all.body.merchants.map((m: { id: string; works: Array<{ id: string }> }) => [m.id, ids(m.works)]));
  assert.deepEqual(works, { m_ali: ['w_a1', 'w_a2', 'w_a3'], m_omar: ['w_o1'] });
  const card = all.body.merchants.find((m: { id: string }) => m.id === 'm_ali');
  assert.equal(card.works[0].imageUrl, '/files/merchants/ali/public/w1.webp');
  assert.ok(!JSON.stringify(all.body).includes('w_h1'), 'nothing of a workshop the public may not see');
  // No N+1: one store or two, the same number of statements.
  const one = counting(raw);
  await get(as(raw, null, one.db), '/api/community/merchants?limit=1');
  const two = counting(raw);
  await get(as(raw, null, two.db), '/api/community/merchants?limit=2');
  assert.equal(one.n(), two.n());
});

// ------------------------------------------------------------------ makers

test('makers: works are up to three public image projects each, read in one statement', async () => {
  const raw = seed();
  const res = await read(raw, '/api/community/creators');
  assert.equal(res.status, 200);
  const works = Object.fromEntries(res.body.creators.map((c: { id: string; works: Array<{ id: string }> }) => [c.id, ids(c.works)]));
  assert.deepEqual(works, { sara: ['p8', 'p9', 'p1'], eve: ['p2'], ali: ['p3'], omar: [], zed: [] }, 'not the taken-down, the draft, nor a clip');
  const sara = res.body.creators.find((c: { id: string }) => c.id === 'sara');
  assert.deepEqual(Object.keys(sara.works[0]).sort(), ['height', 'id', 'imageUrl', 'title', 'url', 'width']);
  assert.ok(!('governorate' in sara), 'no place for a person');
  const one = counting(raw);
  await get(as(raw, null, one.db), '/api/community/creators?limit=1');
  const all = counting(raw);
  await get(as(raw, null, all.db), '/api/community/creators?limit=5');
  assert.equal(one.n(), all.n());
});

test('makers: sort=recent|featured|followers; featured=1 is sort=featured', async () => {
  const raw = seed();
  const order = async (qs: string) => ids((await read(raw, `/api/community/creators${qs}`)).body.creators);
  assert.deepEqual(await order(''), ['eve', 'ali', 'sara', 'omar', 'zed'], 'the newest public project first');
  assert.deepEqual(await order('?sort=recent'), ['eve', 'ali', 'sara', 'omar', 'zed']);
  assert.deepEqual(await order('?sort=featured'), ['sara', 'eve', 'ali', 'omar', 'zed'], 'the most projects');
  assert.deepEqual(await order('?featured=1'), ['sara', 'eve', 'ali', 'omar', 'zed']);
  assert.deepEqual(await order('?sort=followers'), ['eve', 'sara', 'ali', 'omar', 'zed']);
  assert.equal((await read(raw, '/api/community/creators?sort=random')).status, 400);
});

test('makers: has_store=1 keeps the makers with a store the public may see, ANDed into the total', async () => {
  const raw = seed();
  const res = await read(raw, '/api/community/creators?has_store=1');
  assert.deepEqual(new Set(ids(res.body.creators)), new Set(['ali', 'omar']), 'not Zed, who has no store');
  assert.equal(res.body.total, 2);
  assert.equal((await read(raw, '/api/community/creators?has_store=true')).status, 400);
});

test('makers: approved=1 keeps the approved providers, ANDed into the total', async () => {
  const raw = seed();
  const res = await read(raw, '/api/community/creators?approved=1');
  assert.deepEqual(new Set(ids(res.body.creators)), new Set(['ali', 'omar', 'zed']));
  assert.equal(res.body.total, 3);
  assert.ok(res.body.creators.every((c: { badges: { approved_provider: boolean } }) => c.badges.approved_provider));
  const both = await read(raw, '/api/community/creators?approved=1&has_store=1&q=zed');
  assert.deepEqual(both.body.creators, []);
  assert.equal(both.body.total, 0);
  assert.equal((await read(raw, '/api/community/creators?approved=2')).status, 400);
});

// ------------------------------------------------------------------ requests

/** Three published requests of the buyer: FDM, resin, and FDM with an offer. */
async function board() {
  const raw = world();
  const fdm = await newDraft(raw, { title: 'An FDM bracket' });
  assert.equal((await publish(raw, fdm, PLA)).status, 200);
  const resin = await newDraft(raw, { title: 'A resin figure' });
  const r = await publish(raw, resin, { process: 'resin', material_id: 'resin-standard', quality: 'standard', quantity: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const offered = await newDraft(raw, { title: 'An FDM clip' });
  assert.equal((await publish(raw, offered, PLA)).status, 200);
  await offerOn(raw, offered);
  return { raw, fdm, resin, offered };
}
const boardIds = async (raw: DatabaseSync, path: string) => {
  const res = await get(as(raw, VIC), path);
  const body = await json(res);
  return { status: res.status, ids: res.status === 200 ? new Set(ids(body.requests)) : null, total: body.total as number | null | undefined };
};

test('requests: process=fdm|resin on the board and the community list, ANDed into the total', async () => {
  const { raw, fdm, resin, offered } = await board();
  for (const base of ['/api/marketplace/requests', '/api/community/requests']) {
    const f = await boardIds(raw, `${base}?process=fdm`);
    assert.deepEqual(f.ids, new Set([fdm, offered]), base);
    const r = await boardIds(raw, `${base}?process=resin`);
    assert.deepEqual(r.ids, new Set([resin]), base);
    assert.equal((await boardIds(raw, `${base}?process=sla`)).status, 400, base);
  }
  assert.equal((await boardIds(raw, '/api/community/requests?process=fdm')).total, 2);
  assert.equal((await boardIds(raw, '/api/community/requests?process=resin')).total, 1);
});

test('requests: offers=none|some on the board and the community list, ANDed into the total', async () => {
  const { raw, fdm, resin, offered } = await board();
  for (const base of ['/api/marketplace/requests', '/api/community/requests']) {
    assert.deepEqual((await boardIds(raw, `${base}?offers=some`)).ids, new Set([offered]), base);
    assert.deepEqual((await boardIds(raw, `${base}?offers=none`)).ids, new Set([fdm, resin]), base);
    assert.deepEqual((await boardIds(raw, `${base}?offers=none&process=fdm`)).ids, new Set([fdm]), base);
    assert.equal((await boardIds(raw, `${base}?offers=many`)).status, 400, base);
  }
  assert.equal((await boardIds(raw, '/api/community/requests?offers=none')).total, 2);
  assert.equal((await boardIds(raw, '/api/marketplace/requests?governorate=nowhere')).status, 400);
});

test('my requests: cover_url is the route of the first picture, for the owner only, and the list pages by cursor', async () => {
  const { raw, fdm, resin, offered } = await board();
  addFile(raw, fdm, 'f_model', 'model', 'bracket.stl');
  addFile(raw, fdm, 'f_ref', 'reference', 'ref.png');
  addFile(raw, fdm, 'f_ref2', 'reference', 'ref2.png');
  addFile(raw, resin, 'f_only_model', 'model', 'figure.stl');
  const mine = await json(await get(worldAs(raw, 'buyer'), '/api/marketplace/print/my-requests'));
  const byId = Object.fromEntries((mine.requests as Array<{ id: string; cover_url: string | null }>).map((r) => [r.id, r.cover_url]));
  assert.equal(byId[fdm], `/api/marketplace/requests/${fdm}/files/f_ref`);
  assert.equal(byId[resin], null, 'a model is not a picture');
  assert.equal(byId[offered], null);
  // The route answers the owner.
  const cover = await get(worldAs(raw, 'buyer'), byId[fdm]!);
  assert.notEqual(cover.status, 403);
  // Another customer never sees the buyer's rows.
  const other = await json(await get(worldAs(raw, 'stranger'), '/api/marketplace/print/my-requests'));
  assert.deepEqual(other.requests, []);
  // Paged: two, then one, nothing twice.
  const p1 = await json(await get(worldAs(raw, 'buyer'), '/api/marketplace/print/my-requests?limit=2'));
  assert.equal(p1.requests.length, 2);
  assert.ok(p1.next_cursor);
  const p2 = await json(await get(worldAs(raw, 'buyer'), `/api/marketplace/print/my-requests?limit=2&cursor=${encodeURIComponent(p1.next_cursor)}`));
  assert.equal(p2.requests.length, 1);
  assert.equal(p2.next_cursor, null);
  assert.deepEqual(new Set([...ids(p1.requests), ...ids(p2.requests)]), new Set([fdm, resin, offered]));
  assert.equal(mine.next_cursor, null, 'the whole list fits the default page');
  assert.equal((await get(worldAs(raw, 'buyer'), '/api/marketplace/print/my-requests?limit=0')).status, 400);
});

test('offers: the merchant carries the store logo route and governorate, never a contact', async () => {
  const { raw, offered } = await board();
  raw.prepare(`UPDATE merchant_stores SET logo_key = 'merchants/owner/public/logo.webp', governorate = 'baghdad' WHERE id = 's1'`).run();
  const res = await json(await get(worldAs(raw, 'buyer'), `/api/marketplace/requests/${offered}/offers`));
  const merchant = res.offers[0].merchant as Record<string, unknown>;
  assert.equal(merchant.logo_url, '/files/merchants/owner/public/logo.webp');
  assert.equal(merchant.governorate, 'baghdad');
  assert.ok(!JSON.stringify(res).includes('+9647511111111'), 'no phone');
  // A store with no logo says null, not a broken route.
  raw.prepare(`UPDATE merchant_stores SET logo_key = NULL WHERE id = 's1'`).run();
  const bare = await json(await get(worldAs(raw, 'buyer'), `/api/marketplace/requests/${offered}/offers`));
  assert.equal(bare.offers[0].merchant.logo_url, null);
});
