/**
 * A STORE LINK UNFURLS AS THE STORE, AND ITS OWNER CAN HAND IT ON
 * (merchant platform W2-D — docs/MERCHANT_PLATFORM.md §2 decision 11, §4.5).
 *
 *   · the store's card (worker/lib/socialPreview.ts `resolveStorePreview`):
 *     its home on its own host, its page on the main site, and the frame of
 *     its product cards — the platform's card only as a true fallback;
 *   · the share kit (GET /api/merchant/store/share): the absolute link, that
 *     same card, and the app icon a customer installs — for the OWNER only;
 *   · the logo hook: a new logo is cut after the save, a removed one cleared.
 *
 * Real migrations throughout; the document rewrite is driven through the real
 * Worker entry point.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APEX, MERCHANT_HOST, asD1, ctx, freshDb, get, json, patch, pending, stubApp, type StubUser } from './fixtures/app';
import { fixtureWebp, iconEnv, imagesStub } from './fixtures/storeIcons';
import worker from '../worker/index';
import { merchantRoutes } from '../worker/routes/merchant';
import {
  framedByStore,
  injectSocialPreview,
  resolveStorePreview,
  storeHomeRef,
} from '../worker/lib/socialPreview';
import { readStoreIcons, refreshStoreIcons } from '../worker/lib/storeIcons';

const STORE = `https://${MERCHANT_HOST}`;
const LOGO = 'merchants/u1/public/abcd1234.webp';
const OWNER: StubUser = { id: 'u1', role: 'merchant', email: 'a@x.co' };

function seed(over: Partial<{ name: string; tagline: string; description: string; logo: string | null; status: string }> = {}) {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('u1','Ali','a@x.co','h','merchant'), ('u2','Omar','o@x.co','h','merchant');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','u1','Ali 3D');
  `);
  raw
    .prepare(
      `INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,tagline,description,logo_key,status)
       VALUES ('s1','m1','u1','somestore',?,?,?,?,?)`
    )
    .run(
      over.name ?? 'متجر علي',
      over.tagline ?? 'طباعة ثلاثية الأبعاد في أربيل',
      over.description ?? '',
      over.logo === undefined ? LOGO : over.logo,
      over.status ?? 'active'
    );
  raw.exec(`
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,name_ar,description_ar,images,status,lifecycle,price_iqd) VALUES
      ('cp1','m1','s1','somestore-bracket','Bracket','حامل رف','حامل متين','["/files/merchants/u1/public/aaaa1111.webp"]','active','active',7000),
      ('cp2','m1','s1','somestore-bare','Bare','قطعة بلا صورة','','[]','active','active',5000);
  `);
  return raw;
}

async function cut(raw: ReturnType<typeof seed>) {
  const images = imagesStub();
  const bound = iconEnv(asD1(raw), images.binding);
  bound.publicBucket.seed(LOGO, fixtureWebp(640, 640));
  const out = await refreshStoreIcons(bound.env, { id: 's1', user_id: 'u1', logo_key: LOGO, accent: 'default' });
  assert.equal(out.outcome, 'ready');
  const rev = (raw.prepare(`SELECT rev FROM merchant_store_icons`).get() as { rev: string }).rev;
  return { images, bound, rev };
}

// ------------------------------------------------------------------ the card

test('a store\'s card: its name, its line, its own square icon — and the store as the site', async () => {
  const raw = seed();
  const { rev } = await cut(raw);
  const card = await resolveStorePreview(asD1(raw), STORE, { storeSlug: 'somestore' });
  assert.deepEqual(card, {
    title: 'متجر علي',
    description: 'طباعة ثلاثية الأبعاد في أربيل',
    image: `${STORE}/files/merchants/u1/logos/appicon-${rev}-icon512.png`,
    siteName: 'متجر علي',
    twitterCard: 'summary',
  });
});

test('before its renditions exist the card uses the logo; with no logo it leaves the shell\'s image', async () => {
  const withLogo = await resolveStorePreview(asD1(seed()), STORE, { storeSlug: 'somestore' });
  assert.equal(withLogo?.image, `${STORE}/files/${LOGO}`);
  const noLogo = await resolveStorePreview(asD1(seed({ logo: null })), STORE, { storeSlug: 'somestore' });
  assert.equal(noLogo?.image, '', 'the platform mark only as the true fallback');
  const foreign = await resolveStorePreview(asD1(seed({ logo: 'receipts/u1/x.png' })), STORE, { storeSlug: 'somestore' });
  assert.equal(foreign?.image, '', 'a key a crawler cannot fetch is never put in a card');
});

test('the line: the tagline, else the store\'s own description cut for a card, else «متجر X على منصة Levonis»', async () => {
  const long = 'نطبع القطع الهندسية والهدايا والمجسمات بدقة عالية. '.repeat(10);
  const fromDescription = await resolveStorePreview(asD1(seed({ tagline: '', description: long })), STORE, { storeSlug: 'somestore' });
  assert.ok(fromDescription!.description.length <= 161);
  assert.ok(fromDescription!.description.endsWith('…'));
  const generated = await resolveStorePreview(asD1(seed({ tagline: '', description: '', name: 'علي' })), STORE, { storeSlug: 'somestore' });
  assert.equal(generated!.description, 'متجر علي على منصة \u2068Levonis\u2069', 'never the platform describing ITSELF');
});

test('a bidi override or a zero-width character never reaches a chat card', async () => {
  const card = await resolveStorePreview(asD1(seed({ name: 'Ali\u202e3D\u200b Shop' })), STORE, { storeSlug: 'somestore' });
  assert.ok(card);
  assert.doesNotMatch(card.title, /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/);
});

test('a sanctioned store gives NO card; a paused one still does', async () => {
  for (const sql of [
    "UPDATE merchant_stores SET status = 'suspended' WHERE id = 's1'",
    "UPDATE community_merchants SET status = 'suspended' WHERE id = 'm1'",
  ]) {
    const raw = seed();
    raw.exec(sql);
    assert.equal(await resolveStorePreview(asD1(raw), STORE, { storeSlug: 'somestore' }), null, sql);
  }
  const paused = await resolveStorePreview(asD1(seed({ status: 'paused' })), STORE, { storeSlug: 'somestore' });
  assert.equal(paused?.title, 'متجر علي');
});

test('scoped like its page: a host by slug only; the main site by slug, store id or merchant id', async () => {
  const db = asD1(seed());
  for (const ref of ['somestore', 's1', 'm1']) {
    assert.equal((await resolveStorePreview(db, `https://${APEX}`, { storeRef: ref }))?.title, 'متجر علي', ref);
  }
  assert.equal(await resolveStorePreview(db, STORE, { storeSlug: 's1' }), null, 'an id is not an address');
  assert.equal(await resolveStorePreview(db, STORE, {}), null);
  assert.equal(storeHomeRef('/community/store/somestore'), 'somestore');
  assert.equal(storeHomeRef('/community/store/s1/'), 's1');
  for (const path of ['/community/store/x/p/y', '/community/store/', '/community/store/%E0%A4', '/', '/p/x', '/community/store/favicon.ico']) {
    assert.equal(storeHomeRef(path), null, path);
  }
});

test('a product card on the store\'s host is framed by the store: its site name, and its line and logo for what the product lacks', () => {
  const store = { title: 'S', description: 'store line', image: 'https://s/icon.png', siteName: 'S', twitterCard: 'summary' as const };
  assert.deepEqual(framedByStore({ title: 'P', description: 'p line', image: 'https://s/p.webp' }, store), {
    title: 'P',
    description: 'p line',
    image: 'https://s/p.webp',
    siteName: 'S',
  });
  assert.deepEqual(framedByStore({ title: 'P', description: '', image: '' }, store), {
    title: 'P',
    description: 'store line',
    image: 'https://s/icon.png',
    siteName: 'S',
  });
  assert.deepEqual(framedByStore({ title: 'P', description: '', image: '' }, null), { title: 'P', description: '', image: '' });
});

test('the injector writes the site name and the card type, escaped, and adds them when absent', () => {
  const html = '<html><head><meta property="og:site_name" content="LEVONIS" /><meta name="twitter:card" content="summary_large_image" /></head></html>';
  const out = injectSocialPreview(html, { title: 'A "B" & C', description: '', image: '', url: '', siteName: 'A "B" & C', twitterCard: 'summary' });
  assert.match(out, /<meta property="og:site_name" content="A &quot;B&quot; &amp; C" \/>/);
  assert.match(out, /<meta name="twitter:card" content="summary" \/>/);
  const bare = injectSocialPreview('<html><head></head></html>', { title: 'T', description: '', image: '', url: '', siteName: 'T' });
  assert.match(bare, /og:site_name" content="T"/);
  // Absent fields leave the document's values alone.
  assert.match(injectSocialPreview(html, { title: 'T', description: '', image: '', url: '' }), /content="LEVONIS"/);
});

// ------------------------------------------------- the document, via the Worker

const SHELL = `<!doctype html><html><head><title>LEVONIS</title>
<meta name="description" content="platform" />
<meta property="og:site_name" content="LEVONIS" />
<meta property="og:title" content="LEVONIS" />
<meta property="og:description" content="platform" />
<meta property="og:url" content="https://levonis-iq.com/" />
<meta property="og:image" content="https://levonis-iq.com/files/UiUx/Logo/Logo.webp?v=bc80fc2b" />
<meta name="twitter:card" content="summary_large_image" />
</head><body><div id="root"></div></body></html>`;

function counting(db: D1Database) {
  const reads = { n: 0 };
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          reads.n += 1;
          return (target as D1Database).prepare(sql);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { db: proxy as D1Database, reads };
}

function envOf(db: unknown) {
  return {
    DB: db,
    STORE_ROOT_DOMAIN: APEX,
    APP_ORIGIN: `https://${APEX}`,
    INITIAL_ADMIN_EMAIL: 'boss@x.co',
    EXTRA_ALLOWED_ORIGINS: '',
    ASSETS: { fetch: async () => new Response(SHELL, { headers: { 'content-type': 'text/html; charset=utf-8', etag: '"shell"' } }) },
  } as never;
}

const doc = (host: string, path: string, env: unknown) =>
  worker.fetch(new Request(`https://${host}${path}`, { headers: { Host: host, 'CF-Connecting-IP': '9.9.9.9' } }), env as never, ctx);

const metaOf = (html: string, attr: 'property' | 'name', key: string) =>
  new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`).exec(html)?.[1] ?? null;

test('THROUGH THE WORKER: a store\'s home link unfurls as the store, on the store\'s own host', async () => {
  const raw = seed();
  const { rev } = await cut(raw);
  const res = await doc(MERCHANT_HOST, '/', envOf(asD1(raw)));
  const html = await res.text();
  assert.equal(metaOf(html, 'property', 'og:title'), 'متجر علي');
  assert.equal(metaOf(html, 'property', 'og:description'), 'طباعة ثلاثية الأبعاد في أربيل');
  assert.equal(metaOf(html, 'property', 'og:site_name'), 'متجر علي');
  assert.equal(metaOf(html, 'property', 'og:url'), `${STORE}/`, 'the host the link was shared from');
  assert.equal(metaOf(html, 'property', 'og:image'), `${STORE}/files/merchants/u1/logos/appicon-${rev}-icon512.png`);
  assert.equal(metaOf(html, 'name', 'twitter:card'), 'summary', 'a square logo is not cropped into a banner');
  assert.match(html, /<title>متجر علي<\/title>/);
  assert.equal(res.headers.get('etag'), null, 'the rewritten body is not the hashed asset');
});

test('THROUGH THE WORKER: the apex home is the shell untouched, with no database read', async () => {
  const raw = seed();
  const { db, reads } = counting(asD1(raw));
  const res = await doc(APEX, '/', envOf(db));
  assert.equal(await res.text(), SHELL);
  assert.equal(reads.n, 0, 'not even the session: `/` is skipped like the manifest');
});

test('THROUGH THE WORKER: a product on the store\'s host keeps its own card, framed by the store', async () => {
  const raw = seed();
  const { rev } = await cut(raw);
  const html = await (await doc(MERCHANT_HOST, '/p/somestore-bracket', envOf(asD1(raw)))).text();
  assert.equal(metaOf(html, 'property', 'og:title'), 'حامل رف');
  assert.equal(metaOf(html, 'property', 'og:image'), `${STORE}/files/merchants/u1/public/aaaa1111.webp`);
  assert.equal(metaOf(html, 'property', 'og:site_name'), 'متجر علي');
  assert.equal(metaOf(html, 'name', 'twitter:card'), 'summary_large_image', 'a product photo keeps the large card');
  // A product with no picture and no description borrows the STORE's, not the platform's.
  const bare = await (await doc(MERCHANT_HOST, '/p/somestore-bare', envOf(asD1(raw)))).text();
  assert.equal(metaOf(bare, 'property', 'og:title'), 'قطعة بلا صورة');
  assert.equal(metaOf(bare, 'property', 'og:image'), `${STORE}/files/merchants/u1/logos/appicon-${rev}-icon512.png`);
  assert.equal(metaOf(bare, 'property', 'og:description'), 'طباعة ثلاثية الأبعاد في أربيل');
});

test('THROUGH THE WORKER: a link on the store\'s host that names no product of it is the STORE\'s card', async () => {
  const raw = seed();
  const html = await (await doc(MERCHANT_HOST, '/p/no-such-product', envOf(asD1(raw)))).text();
  assert.equal(metaOf(html, 'property', 'og:title'), 'متجر علي');
  assert.equal(metaOf(html, 'property', 'og:url'), `${STORE}/p/no-such-product`);
});

test('THROUGH THE WORKER: the store\'s page on the main site unfurls as the store', async () => {
  const raw = seed();
  const html = await (await doc(APEX, '/community/store/s1', envOf(asD1(raw)))).text();
  assert.equal(metaOf(html, 'property', 'og:title'), 'متجر علي');
  assert.equal(metaOf(html, 'property', 'og:url'), `https://${APEX}/community/store/s1`);
  // …and the apex's own catalogue product cards are not framed by any store.
  raw.exec(`INSERT INTO products (id, slug, name, name_ar, price_iqd, status) VALUES ('p1', 'filament-pla', 'PLA', 'خيط PLA', 100000, 'active')`);
  const product = await (await doc(APEX, '/product/filament-pla', envOf(asD1(raw)))).text();
  assert.equal(metaOf(product, 'property', 'og:site_name'), 'LEVONIS');
});

test('THROUGH THE WORKER: a suspended store\'s home is the shell untouched', async () => {
  const raw = seed({ status: 'suspended' });
  const res = await doc(MERCHANT_HOST, '/', envOf(asD1(raw)));
  assert.equal(await res.text(), SHELL);
});

// -------------------------------------------------------------- the share kit

const ROOTED = { STORE_ROOT_DOMAIN: APEX, APP_ORIGIN: `https://${APEX}` };
const shareApp = (raw: ReturnType<typeof seed>, user: StubUser | null = OWNER, env: Record<string, unknown> = ROOTED) =>
  stubApp(asD1(raw), user, (a) => a.route('/api/merchant', merchantRoutes), { env });

test('the share kit: the store\'s absolute link, the card it unfurls as, and the app icon — for its owner', async () => {
  const raw = seed();
  const res = await get(shareApp(raw), '/api/merchant/store/share');
  assert.equal(res.status, 200);
  const kit = await json(res);
  assert.equal(kit.store_id, 's1');
  assert.equal(kit.url, STORE);
  assert.equal(kit.host, MERCHANT_HOST);
  assert.equal(kit.suspended, false);
  assert.deepEqual(kit.card, {
    title: 'متجر علي',
    description: 'طباعة ثلاثية الأبعاد في أربيل',
    image: `${STORE}/files/${LOGO}`,
    site_name: 'متجر علي',
    url: STORE,
  });
  // No Images binding here: said honestly, not faked.
  assert.equal(kit.app_icon.state, 'unavailable');
  assert.equal(kit.app_icon.reason, 'IMAGES_UNAVAILABLE');
  assert.equal(kit.app_icon.icon, null);
  assert.equal(kit.app_icon.name, 'متجر علي');
  assert.equal(kit.app_icon.background, '#000000');
});

test('the share kit shows the real app icon once it is cut, and cuts it when it is missing', async () => {
  const raw = seed();
  const images = imagesStub();
  const bound = iconEnv(asD1(raw), images.binding);
  bound.publicBucket.seed(LOGO, fixtureWebp(640, 640));
  const env = { ...ROOTED, ...bound.env, DB: asD1(raw) };

  pending.length = 0;
  const first = await json(await get(shareApp(raw, OWNER, env), '/api/merchant/store/share'));
  assert.equal(first.app_icon.state, 'pending', 'the owner is told it is being prepared');
  await Promise.all(pending.splice(0));
  const second = await json(await get(shareApp(raw, OWNER, env), '/api/merchant/store/share'));
  const rev = (raw.prepare(`SELECT rev FROM merchant_store_icons`).get() as { rev: string }).rev;
  assert.equal(second.app_icon.state, 'ready');
  assert.equal(second.app_icon.icon, `${STORE}/files/merchants/u1/logos/appicon-${rev}-apple180.png`);
  assert.equal(second.app_icon.maskable, `${STORE}/files/merchants/u1/logos/appicon-${rev}-maskable512.png`);
  assert.equal(second.card.image, `${STORE}/files/merchants/u1/logos/appicon-${rev}-icon512.png`, 'the card and the kit agree');
});

test('with no root domain the link is the in-app page, absolute on the platform origin', async () => {
  // Neither STORE_ROOT_DOMAIN nor APP_ORIGIN (a preview with no wildcard DNS):
  // `storeUrl` falls back to the in-app route, and a link handed to another
  // phone is made absolute on the origin this deployment answers on.
  const raw = seed();
  const kit = await json(await get(shareApp(raw, OWNER, {}), '/api/merchant/store/share'));
  assert.equal(kit.url, 'http://localhost/community/store/s1');
  assert.equal(kit.host, '');
  assert.equal(kit.card.title, 'متجر علي');
  assert.equal(kit.card.url, kit.url);
});

test('the share kit is the OWNER\'s: signed out is 401, a user with no store is 404, a suspended store has no card', async () => {
  const raw = seed();
  assert.equal((await get(shareApp(raw, null), '/api/merchant/store/share')).status, 401);
  assert.equal((await get(shareApp(raw, { id: 'u2', role: 'merchant', email: 'o@x.co' }), '/api/merchant/store/share')).status, 404);
  raw.exec(`UPDATE merchant_stores SET status = 'suspended' WHERE id = 's1'`);
  const kit = await json(await get(shareApp(raw), '/api/merchant/store/share'));
  assert.equal(kit.suspended, true);
  assert.equal(kit.card, null, 'its link shows «المتجر غير متاح حاليًا», not a card');
});

// ------------------------------------------------------------- the logo hook

test('PATCH /store with a new logo cuts its icons after the response; removing the logo clears them', async () => {
  const raw = seed({ logo: null });
  const images = imagesStub();
  const bound = iconEnv(asD1(raw), images.binding);
  bound.publicBucket.seed(LOGO, fixtureWebp(640, 640));
  const app = shareApp(raw, OWNER, { ...ROOTED, ...bound.env, DB: asD1(raw) });

  pending.length = 0;
  const saved = await patch(app, '/api/merchant/store', { logo_key: `/files/${LOGO}` });
  assert.equal(saved.status, 200);
  assert.ok(pending.length >= 1, 'scheduled after the response, not in front of it');
  await Promise.all(pending.splice(0));
  const row = await readStoreIcons(asD1(raw), 's1');
  assert.equal(row?.source_key, LOGO);
  assert.equal(images.calls.length, 5);

  // An unrelated save does not touch the icons at all.
  pending.length = 0;
  await patch(app, '/api/merchant/store', { tagline: 'جديد' });
  assert.equal(pending.length, 0);

  // Removing the logo clears the set and queues its renditions for cleanup.
  await patch(app, '/api/merchant/store', { logo_key: '' });
  await Promise.all(pending.splice(0));
  assert.equal(await readStoreIcons(asD1(raw), 's1'), null);
  const queued = raw.prepare(`SELECT COUNT(*) AS n FROM media_cleanup_jobs WHERE state = 'pending'`).get() as { n: number };
  assert.equal(queued.n, 5);
});
