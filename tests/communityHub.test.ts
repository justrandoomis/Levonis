/**
 * THE COMMUNITY PAGE'S FEEDS — /api/community/{products,merchants,requests,works}.
 *
 * What these pin, each against the real migrations in SQLite:
 *
 *   * A product card opens the page it can be BOUGHT on — its store's product
 *     page on this site, even when the shop has its own address — and
 *     /product/:slug only for a pre-store listing. It used to open
 *     /product/:slug for every row, which renders a community listing as
 *     «not sold through the store cart».
 *   * Only what the storefront itself serves is listed: published, not hidden
 *     by Levonis, nothing of a sanctioned shop.
 *   * Search is the server's, over every row — with a person's `%` taken
 *     literally — and the feeds page by (created_at, id) without repeating or
 *     dropping a row that shares a millisecond.
 *   * The directory carries each shop's own public header (rating, completed
 *     orders, followers, published products, the STORE's governorate) and the
 *     viewer's own follow — never the merchant row's governorate.
 *   * The request list answers with the board's whitelist: the job, never the
 *     customer's private notes or ids.
 *   * «من أعمال الورش» lists finished work with a picture, three per shop at
 *     most, and nothing of a sanctioned shop; it sits inside the maintenance
 *     wall like every other community read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, get, json, type Mount } from './fixtures/app';
import { communityRoutes } from '../worker/routes/community';

const mount: Mount = (a) => {
  a.route('/api/community', communityRoutes);
};

function seed(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,username,email,password_hash,role) VALUES
      ('viewer','Sara','sara','s@x.co','h','customer'),
      ('o1','Ali','ali','a@x.co','h','customer'),
      ('o2','Noor','noor','n@x.co','h','customer'),
      ('o3','Old','old','o@x.co','h','customer'),
      ('o4','Banned','banned','b@x.co','h','customer'),
      ('o5','Shut','shut','sh@x.co','h','customer'),
      ('buyer','Hadi Jaber','hadi','h@x.co','h','customer');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');

    INSERT INTO community_merchants (id,user_id,name,bio,avatar_key,governorate,rating_avg_x100,rating_count,completed_orders,badge,status,created_at) VALUES
      ('m1','o1','Ali merchant','bio one','community/o1/avatar.webp','basra',480,37,52,'trusted','active','2026-09-01T00:00:00.000Z'),
      ('m2','o2','Noor merchant','bio two',NULL,'erbil',0,0,0,'new','active','2026-09-02T00:00:00.000Z'),
      ('m3','o3','Profile only','legacy bio','community/o3/avatar.webp','najaf',0,0,0,'new','active','2026-09-03T00:00:00.000Z'),
      ('m4','o4','Suspended merchant','',NULL,'',0,0,0,'new','suspended','2026-09-04T00:00:00.000Z'),
      ('m5','o5','Merchant of a suspended store','',NULL,'',0,0,0,'new','active','2026-09-05T00:00:00.000Z');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,tagline,logo_key,governorate,status) VALUES
      ('s1','m1','o1','ali3d','Ali 3D Workshop','Spare parts to order','community/o1/logo.webp','baghdad','active'),
      ('s2','m2','o2','printlab','Print Lab','Resin minis',NULL,'erbil','paused'),
      ('s4','m4','o4','banned','Banned store','',NULL,'','active'),
      ('s5','m5','o5','shut','Shut store','',NULL,'','suspended');

    INSERT INTO community_products (id,merchant_id,store_id,slug,name,name_ar,description,images,price_iqd,original_price_iqd,publish_state,admin_hidden_at,stock,track_stock,created_at) VALUES
      ('p1','m1','s1','red-dragon','Red dragon','تنين أحمر','resin','["/files/community/o1/d.webp"]',45000,NULL,'published',NULL,3,1,'2026-09-10T00:00:00.000Z'),
      ('p2','m1','s1','vase-sale','Vase 50% off','مزهرية','pla','[]',18000,22000,'published',NULL,0,1,'2026-09-09T00:00:00.000Z'),
      ('p3','m2','s2','knight','Knight mini','فارس','resin','[]',12000,NULL,'published',NULL,5,1,'2026-09-08T00:00:00.000Z'),
      ('p4','m3',NULL,'legacy-thing','Legacy thing','','old','[]',9000,NULL,'published',NULL,0,1,'2026-09-07T00:00:00.000Z'),
      ('p5','m1','s1','draft-one','Draft one','','','[]',1000,NULL,'draft',NULL,1,1,'2026-09-11T00:00:00.000Z'),
      ('p6','m1','s1','hidden-one','Hidden by Levonis','','','[]',1000,NULL,'published','2026-09-12T00:00:00.000Z',1,1,'2026-09-12T00:00:00.000Z'),
      ('p7','m4','s4','banned-one','From a suspended merchant','','','[]',1000,NULL,'published',NULL,1,1,'2026-09-13T00:00:00.000Z'),
      ('p8','m5','s5','shut-one','From a suspended store','','','[]',1000,NULL,'published',NULL,1,1,'2026-09-14T00:00:00.000Z'),
      ('p9','m1','s1','tie-a','Tie A','','','[]',2000,NULL,'published',NULL,0,0,'2026-09-06T00:00:00.000Z'),
      ('p10','m1','s1','tie-b','Tie B','','','[]',2000,NULL,'published',NULL,0,0,'2026-09-06T00:00:00.000Z');

    INSERT INTO follows (user_id, merchant_id) VALUES ('viewer','m1'), ('o2','m1');
  `);
  return raw;
}

const as = (raw: DatabaseSync, id: string | null, env: Record<string, unknown> = {}) =>
  stubApp(asD1(raw), id ? { id, role: 'customer', email: `${id}@x.co` } : null, mount, { env });

type Row = Record<string, unknown>;
const ids = (rows: unknown) => (rows as Row[]).map((r) => r.id);

// --------------------------------------------------------------- products

test('a product card opens its store\'s product page, and a pre-store listing keeps /product/:slug', async () => {
  const raw = seed();
  const body = await json(await get(as(raw, 'viewer'), '/api/community/products'));
  const byId = new Map((body.products as Row[]).map((p) => [p.id, p]));

  const dragon = byId.get('p1')!;
  assert.equal(dragon.url, '/community/store/ali3d/p/red-dragon', 'the store slug route StorefrontProduct resolves');
  assert.deepEqual(dragon.store, {
    id: 's1',
    slug: 'ali3d',
    name: 'Ali 3D Workshop',
    logoUrl: '/files/community/o1/logo.webp',
    url: '/community/store/s1',
  });
  assert.equal(dragon.in_stock, true);
  assert.equal(byId.get('p2')!.in_stock, false, 'a tracked product with nothing left is «نفد»');
  assert.equal(byId.get('p9')!.in_stock, true, 'an untracked product is always in stock');
  assert.equal('stock' in dragon, false, 'the count is never served');

  const legacy = byId.get('p4')!;
  assert.equal(legacy.url, '/product/legacy-thing');
  assert.equal(legacy.store, null);
  assert.equal(legacy.in_stock, null, 'no cart path, so no stock claim');
});

test('with a root domain the SHOP is its own address, and the product card still opens in-site — no tab per product', async () => {
  const raw = seed();
  const body = await json(await get(as(raw, 'viewer', { STORE_ROOT_DOMAIN: 'levonis-iq.com' }), '/api/community/products'));
  const dragon = (body.products as Row[]).find((p) => p.id === 'p1')!;
  assert.equal(dragon.url, '/community/store/ali3d/p/red-dragon');
  assert.equal((dragon.store as Row).url, 'https://ali3d.levonis-iq.com');
});

test('the feed lists what the storefront serves: published, not hidden by Levonis, nothing of a sanctioned shop', async () => {
  const raw = seed();
  const body = await json(await get(as(raw, null), '/api/community/products'));
  const listed = new Set(ids(body.products));
  for (const shown of ['p1', 'p2', 'p3', 'p4', 'p9', 'p10']) assert.ok(listed.has(shown), `${shown} is listed`);
  for (const gone of ['p5', 'p6', 'p7', 'p8']) assert.ok(!listed.has(gone), `${gone} is not listed`);
  assert.ok(listed.has('p3'), 'a PAUSED store is not a sanction — its page says it is closed');
  assert.equal(body.total, 6, 'the total counts the same rows');
});

test('search is the server\'s, over every row, and a typed % is a percent sign, not a wildcard', async () => {
  const raw = seed();
  const app = as(raw, null);
  const arabic = await json(await get(app, `/api/community/products?q=${encodeURIComponent('تنين')}`));
  assert.deepEqual(ids(arabic.products), ['p1']);
  assert.equal(arabic.total, 1);

  const percent = await json(await get(app, `/api/community/products?q=${encodeURIComponent('%')}`));
  assert.deepEqual(ids(percent.products), ['p2'], 'only the row that really contains «%»');

  const description = await json(await get(app, '/api/community/products?q=resin'));
  assert.deepEqual(new Set(ids(description.products)), new Set(['p1', 'p3']), 'the description is searched too');

  // A term longer than D1's 50-byte LIKE limit is cut, not refused.
  const long = await get(app, `/api/community/products?q=${encodeURIComponent('تنين'.repeat(30))}`);
  assert.equal(long.status, 200);
});

test('pages by (created_at, id): a row sharing a millisecond with the page boundary is neither repeated nor lost', async () => {
  const raw = seed();
  const app = as(raw, null);
  const seen: unknown[] = [];
  let cursor: string | null = null;
  let first = true;
  for (let guard = 0; guard < 20; guard++) {
    const path: string = `/api/community/products?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page = await json(await get(app, path));
    seen.push(...ids(page.products));
    if (first) assert.equal(page.total, 6, 'the first page carries the total');
    else assert.equal(page.total, null, 'later pages do not count again');
    first = false;
    cursor = page.next_cursor;
    if (!cursor) break;
  }
  // Newest first; p9 and p10 share a millisecond and are ordered by id,
  // descending as TEXT ('p9' > 'p10').
  assert.deepEqual(seen, ['p1', 'p2', 'p3', 'p4', 'p9', 'p10']);
  assert.equal(new Set(seen).size, seen.length, 'no row twice');
});

// -------------------------------------------------------------- merchants

test('the directory shows each shop\'s own public header, and the viewer\'s own follow', async () => {
  const raw = seed();
  const body = await json(await get(as(raw, 'viewer'), '/api/community/merchants'));
  const byId = new Map((body.merchants as Row[]).map((m) => [m.id, m]));
  assert.deepEqual([...byId.keys()].sort(), ['m1', 'm2', 'm3'], 'no suspended merchant, no merchant of a suspended store');
  assert.equal(body.total, 3);

  const ali = byId.get('m1')!;
  assert.equal(ali.store_name, 'Ali 3D Workshop');
  assert.equal(ali.tagline, 'Spare parts to order');
  assert.equal(ali.logoUrl, '/files/community/o1/logo.webp', 'the store logo before the community avatar');
  assert.equal(ali.governorate, 'baghdad', "the STORE's governorate, not the merchant row's «basra»");
  assert.equal(ali.rating, 4.8);
  assert.equal(ali.rating_count, 37);
  assert.equal(ali.completed_orders, 52);
  assert.equal(ali.badge, 'trusted');
  assert.equal(ali.followers, 2);
  assert.equal(ali.product_count, 4, 'published and not hidden only: p1, p2, p9, p10');
  assert.equal(ali.following, true);
  assert.equal(ali.store_url, '/community/store/s1');
  assert.equal('phone' in ali, false);
  assert.equal('status_reason' in ali, false);

  const noor = byId.get('m2')!;
  assert.equal(noor.rating, null, 'no reviews is «جديد», never a number');
  assert.equal(noor.following, false);

  const legacy = byId.get('m3')!;
  assert.equal(legacy.store_name, null);
  assert.equal(legacy.governorate, '', 'a merchant row\'s own governorate was never public');
  assert.equal(legacy.logoUrl, '/files/community/o3/avatar.webp');
  assert.equal(legacy.product_count, 1, 'a pre-store merchant counts its own listings');
});

test('a guest follows nobody, and the directory searches store names and taglines', async () => {
  const raw = seed();
  const guest = await json(await get(as(raw, null), '/api/community/merchants'));
  assert.ok((guest.merchants as Row[]).every((m) => m.following === false));

  const byTagline = await json(await get(as(raw, null), '/api/community/merchants?q=resin'));
  assert.deepEqual(ids(byTagline.merchants), ['m2']);
  const byStore = await json(await get(as(raw, null), '/api/community/merchants?q=Workshop'));
  assert.deepEqual(ids(byStore.merchants), ['m1']);
});

// --------------------------------------------------------------- requests

function seedRequests(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO community_requests (id,customer_id,title,description,category,quantity,material,budget_iqd,governorate,notes,state,status,visibility,offer_count,expires_at,created_at) VALUES
      ('r1','buyer','Vacuum clip','Broken hose clip','spare_part',2,'PETG',15000,'baghdad','private link','receiving_offers','open','public',3,'2099-01-01T00:00:00.000Z','2026-09-20T00:00:00.000Z'),
      ('r2','buyer','Cake topper','Two names in gold','decor',1,'PLA',NULL,'erbil','','open','open','public',0,NULL,'2026-09-19T00:00:00.000Z'),
      ('r_private','buyer','Private one','x','',1,'',NULL,'','','open','open','private',0,NULL,'2026-09-21T00:00:00.000Z'),
      ('r_draft','buyer','Draft one','x','',1,'',NULL,'','','draft','closed','public',0,NULL,'2026-09-22T00:00:00.000Z'),
      ('r_expired','buyer','Expired one','x','',1,'',NULL,'','','open','open','public',0,'2020-01-01T00:00:00.000Z','2026-09-23T00:00:00.000Z');
    INSERT INTO community_request_files (id,request_id,file_key,file_name) VALUES
      ('f1','r1','requests/buyer/a.jpg','a.jpg'), ('f2','r1','requests/buyer/b.stl','b.stl');
  `);
}

test('the request list says what the job is, with the board\'s whitelist and nothing private', async () => {
  const raw = seed();
  seedRequests(raw);
  const body = await json(await get(as(raw, 'viewer'), '/api/community/requests'));
  assert.deepEqual(ids(body.requests), ['r1', 'r2'], 'no private, draft or expired request');
  assert.equal(body.total, 2);
  const r1 = (body.requests as Row[])[0];
  assert.equal(r1.quantity, 2);
  assert.equal(r1.material, 'PETG');
  assert.equal(r1.budget_iqd, 15000);
  assert.equal(r1.governorate, 'baghdad');
  assert.equal(r1.offer_count, 3);
  assert.equal(r1.file_count, 2);
  assert.equal(r1.customer_username, 'hadi', 'the old field still answers');
  for (const secret of ['notes', 'customer_id', 'email', 'phone']) assert.equal(secret in r1, false, `${secret} is never served`);
  assert.ok(!JSON.stringify(body).includes('private link'));
  assert.ok(!JSON.stringify(body).includes('requests/buyer/'), 'no file key');

  const search = await json(await get(as(raw, null), '/api/community/requests?q=gold'));
  assert.deepEqual(ids(search.requests), ['r2'], 'the description is searched');
  const paged = await json(await get(as(raw, null), '/api/community/requests?limit=1'));
  assert.deepEqual(ids(paged.requests), ['r1']);
  const next = await json(await get(as(raw, null), `/api/community/requests?limit=1&cursor=${encodeURIComponent(paged.next_cursor)}`));
  assert.deepEqual(ids(next.requests), ['r2']);
});

// ------------------------------------------------------------------ works

function seedWorks(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO merchant_showcase (id,store_id,kind,title,details,image_key,active,created_at) VALUES
      ('w1','s1','work','Gear clock','PLA','community/o1/w1.webp',1,'2026-09-20T00:00:00.000Z'),
      ('w2','s1','work','Vase set','','community/o1/w2.webp',1,'2026-09-19T00:00:00.000Z'),
      ('w3','s1','work','Brackets','','community/o1/w3.webp',1,'2026-09-18T00:00:00.000Z'),
      ('w4','s1','work','Fourth of one shop','','community/o1/w4.webp',1,'2026-09-17T00:00:00.000Z'),
      ('w_printer','s1','printer','X1C','','community/o1/x1c.webp',1,'2026-09-21T00:00:00.000Z'),
      ('w_noimg','s1','work','No picture','',NULL,1,'2026-09-22T00:00:00.000Z'),
      ('w_off','s1','work','Switched off','','community/o1/off.webp',0,'2026-09-23T00:00:00.000Z'),
      ('w_paused','s2','work','Dragon','','community/o2/d.webp',1,'2026-09-16T00:00:00.000Z'),
      ('w_banned','s4','work','Banned work','','community/o4/b.webp',1,'2026-09-24T00:00:00.000Z'),
      ('w_shut','s5','work','Shut work','','community/o5/s.webp',1,'2026-09-25T00:00:00.000Z');
  `);
}

test('«من أعمال الورش»: finished work with a picture, three per shop at most, nothing of a sanctioned shop', async () => {
  const raw = seed();
  seedWorks(raw);
  const body = await json(await get(as(raw, null), '/api/community/works'));
  assert.deepEqual(ids(body.works), ['w1', 'w2', 'w3', 'w_paused']);
  const first = (body.works as Row[])[0];
  assert.equal(first.imageUrl, '/files/community/o1/w1.webp');
  assert.deepEqual(first.store, {
    id: 's1',
    slug: 'ali3d',
    name: 'Ali 3D Workshop',
    logoUrl: '/files/community/o1/logo.webp',
    url: '/community/store/s1',
  });

  const rooted = await json(await get(as(raw, null, { STORE_ROOT_DOMAIN: 'levonis-iq.com' }), '/api/community/works?limit=1'));
  assert.equal(((rooted.works as Row[])[0].store as Row).url, 'https://ali3d.levonis-iq.com');
});

test('the new reads sit inside the maintenance wall', async () => {
  const raw = seed();
  raw.exec(`UPDATE admin_settings SET value = '{"open":false}' WHERE key = 'communityGate'`);
  for (const path of ['/api/community/works', '/api/community/products?q=x', '/api/community/merchants?cursor=x', '/api/community/requests']) {
    const res = await get(as(raw, null), path);
    assert.equal(res.status, 503, path);
    assert.equal((await json(res)).code, 'COMMUNITY_CLOSED', path);
  }
});
