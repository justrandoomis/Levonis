/**
 * LINK CARDS AND GROUPED FILE NOTIFICATIONS (docs/COMMUNITY_ECOSYSTEM.md §9.4).
 *
 * Every test here walks the real code with only the NETWORK, the buckets and
 * the clock replaced: `resolveLinkCard` takes a fetcher and a `now`, the
 * routes read `globalThis.fetch`, and both are stubbed with a recorder so a
 * test can say not merely "the card is right" but "and nothing was fetched" —
 * which, for a feature whose whole risk is making this Worker call somebody's
 * address, is the assertion that matters.
 *
 * Run: node --import tsx --test tests/linkCards.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, post, get, json, count, row, memoryBucket, type StubUser, type Mount } from './fixtures/app';
import { HttpError } from '../worker/lib/http';
import { chatRoutes } from '../worker/routes/chats';
import { linkCardRoutes } from '../worker/routes/linkCards';
import { marketplaceRoutes } from '../worker/routes/marketplace';
import {
  LINK_URL_MAX,
  linkFromSnapshot,
  normalizeLinkUrl,
  parseOpenGraph,
  previewKindFor,
  resolveLinkCard,
  type LinkEnv,
} from '../worker/lib/linkCards';

// ------------------------------------------------------------------ people

const SARA: StubUser = { id: 'sara', role: 'customer', email: 'sara@x.co', username: 'sara' };
const EVE: StubUser = { id: 'eve', role: 'customer', email: 'eve@x.co', username: 'eve' };
const ZED: StubUser = { id: 'zed', role: 'customer', email: 'zed@x.co', username: 'zed' };
const ALI: StubUser = { id: 'ali', role: 'merchant', email: 'ali@x.co', username: 'ali' };

const mount: Mount = (a) => {
  a.route('/api/link-cards', linkCardRoutes);
  a.route('/api/chats', chatRoutes);
  a.route('/api/marketplace', marketplaceRoutes);
};

function seed(): DatabaseSync {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role,username) VALUES
      ('sara','Sara Kareem','sara@x.co','h','customer','sara'),
      ('eve','Eve','eve@x.co','h','customer','eve'),
      ('zed','Zed','zed@x.co','h','customer','zed'),
      ('ali','Ali','ali@x.co','h','merchant','ali'),
      ('omar','Omar','omar@x.co','h','merchant','omar');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m_ali','ali','Ali 3D'), ('m_omar','omar','Omar 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES
      ('s_ali','m_ali','ali','ali3d','Ali 3D'), ('s_omar','m_omar','omar','omar3d','Omar 3D');
    INSERT INTO chats (id) VALUES ('chat_1');
    INSERT INTO chat_participants (chat_id,user_id) VALUES ('chat_1','sara'), ('chat_1','eve'), ('chat_1','zed');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  return raw;
}

// ----------------------------------------------------------------- network

interface Served {
  status?: number;
  type?: string;
  body?: Uint8Array | string;
  headers?: Record<string, string>;
}

/** A fetch that answers from a table and REMEMBERS every address it was asked for. */
function network(routes: Record<string, Served>) {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    const served = routes[url];
    if (!served) return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
    return new Response((served.body ?? '') as BodyInit, {
      status: served.status ?? 200,
      headers: { 'content-type': served.type ?? 'text/html; charset=utf-8', ...(served.headers ?? {}) },
    });
  }) as typeof fetch;
  return { calls, fetcher };
}

async function withFetch<T>(fetcher: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

/** A WebP header the sniffer accepts and the dimension reader can measure (VP8X, 24-bit minus-one fields). */
function webp(width = 320, height = 200, size = 64): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x52, 0x49, 0x46, 0x46], 0);
  b.set([0x57, 0x45, 0x42, 0x50], 8);
  b.set([0x56, 0x50, 0x38, 0x58], 12);
  const w = width - 1;
  const h = height - 1;
  b.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 24);
  b.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 27);
  return b;
}
function png(size = 64): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return b;
}
const PDF = new TextEncoder().encode('%PDF-1.7\n%âãÏÓ\n1 0 obj <<>> endobj\n');

/** The IMAGES binding as the converter uses it: anything in, a measurable WebP out (or a failure). */
function imagesBinding(opts: { fail?: boolean } = {}) {
  const calls: number[] = [];
  return {
    calls,
    binding: {
      input(_stream: ReadableStream) {
        const handle = {
          transform() {
            return handle;
          },
          async output(_o: { format: string; quality?: number }) {
            calls.push(1);
            return { response: () => (opts.fail ? new Response('no', { status: 500 }) : new Response(webp() as BodyInit)) };
          },
        };
        return handle;
      },
    },
  };
}

// ---------------------------------------------------------------- fixtures

const MODEL_URL = 'https://www.printables.com/model/12345-articulated-dragon';
const MODEL_IMAGE = 'https://www.printables.com/images/dragon.png';
const PAGE = `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Fallback &lt;title&gt; — Printables</title>
<meta property="og:title" content="Articulated   Dragon &amp; Friends">
<meta property='og:description' content='A flexi dragon that prints in place &#8212; no supports'>
<meta name="twitter:image" content="/images/twitter.png">
<meta property="og:image" content="/images/dragon.png">
<meta name="description" content="ignored because og wins">
</head><body><h1>Dragon</h1><script>var later = '<meta property="og:title" content="not this">';</script></body></html>`;

const T0 = new Date('2026-09-29T10:00:00.000Z');
const at = (ms: number) => () => new Date(T0.getTime() + ms);
const HOUR = 60 * 60 * 1000;

function env(raw: DatabaseSync, extra: Record<string, unknown> = {}) {
  const bucket = memoryBucket();
  const e = { DB: asD1(raw), BUCKET: bucket, R2_PUBLIC: bucket, R2_PRIVATE: bucket, ...extra } as unknown as LinkEnv;
  return { env: e, bucket, raw };
}
const as = (raw: DatabaseSync, user: StubUser | null, extra: Record<string, unknown> = {}) => {
  const bucket = memoryBucket();
  return { app: stubApp(asD1(raw), user, mount, { env: { BUCKET: bucket, R2_PUBLIC: bucket, R2_PRIVATE: bucket, ...extra } }), bucket };
};
const notes = (raw: DatabaseSync, user: string, kind: string) =>
  raw
    .prepare('SELECT id, title_ar, title_en, body_ar, meta, read_at, event_key, link FROM user_notifications WHERE user_id = ? AND kind = ? ORDER BY created_at')
    .all(user, kind) as Array<{ id: string; title_ar: string; title_en: string; body_ar: string; meta: string; read_at: string | null; event_key: string; link: string }>;

// =========================================================================
// 1. WHAT IS REFUSED — and never fetched
// =========================================================================

test('javascript:, file:, data:, private addresses and a 3 KB URL are refused with the right code, and nothing is fetched', async () => {
  const { env: e, raw } = env(seed());
  const { calls, fetcher } = network({});
  const cases: Array<[unknown, string]> = [
    ['javascript:alert(1)', 'LINK_URL_INVALID'],
    ['file:///etc/passwd', 'LINK_URL_INVALID'],
    ['data:text/html,<script>1</script>', 'LINK_URL_INVALID'],
    ['ftp://printables.com/x', 'LINK_URL_INVALID'],
    ['https://user:pw@www.printables.com/model/1', 'LINK_URL_INVALID'],
    ['not a link', 'LINK_URL_INVALID'],
    ['', 'LINK_URL_INVALID'],
    [42, 'LINK_URL_INVALID'],
    [`https://www.printables.com/model/${'a'.repeat(3000)}`, 'LINK_URL_INVALID'],
    ['http://10.0.0.1/', 'LINK_HOST_BLOCKED'],
    ['http://169.254.169.254/latest/meta-data/', 'LINK_HOST_BLOCKED'],
    ['http://127.0.0.1:8787/api/admin', 'LINK_HOST_BLOCKED'],
    ['http://localhost/x', 'LINK_HOST_BLOCKED'],
    ['http://[::1]/x', 'LINK_HOST_BLOCKED'],
    ['http://192.168.1.10/', 'LINK_HOST_BLOCKED'],
  ];
  for (const [bad, code] of cases) {
    await assert.rejects(
      resolveLinkCard(e, bad, { fetcher }),
      (err: unknown) => err instanceof HttpError && err.status === 400 && err.code === code,
      `${String(bad).slice(0, 40)} must be refused with ${code}`
    );
  }
  assert.deepEqual(calls, [], 'a refused address is never fetched');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM link_cards'), 0, 'a refused address leaves no row');
  assert.equal(LINK_URL_MAX, 2048);
});

test('the route refuses the same way (400 + code), and a 2 KB address at the limit is still an address', async () => {
  const raw = seed();
  const { calls, fetcher } = network({});
  await withFetch(fetcher, async () => {
    const { app } = as(raw, SARA);
    const blocked = await post(app, '/api/link-cards/resolve', { url: 'http://10.0.0.1/' });
    assert.equal(blocked.status, 400);
    assert.equal((await json(blocked)).code, 'LINK_HOST_BLOCKED');
    const invalid = await post(app, '/api/link-cards/resolve', { url: 'javascript:alert(1)' });
    assert.equal(invalid.status, 400);
    assert.equal((await json(invalid)).code, 'LINK_URL_INVALID');
    assert.equal((await post(as(raw, null).app, '/api/link-cards/resolve', { url: MODEL_URL })).status, 401, 'the resolve door is signed-in only');
  });
  assert.deepEqual(calls, []);
  const long = normalizeLinkUrl(`https://example.com/${'b'.repeat(LINK_URL_MAX - 30)}`);
  assert.equal(long.hostname, 'example.com');
});

// =========================================================================
// 2. A HOST OFF THE LIST — a bare card, no fetch
// =========================================================================

test('an unknown host gets a bare card (host only, status blocked) and no fetch; the row is reused', async () => {
  const { env: e, raw } = env(seed());
  const { calls, fetcher } = network({});
  const card = await resolveLinkCard(e, 'https://Example.com/some/page?utm_source=x&id=7&fbclid=abc#frag', { fetcher });
  assert.deepEqual(
    { kind: card.kind, status: card.status, host: card.host, url: card.url, title: card.title, image_url: card.image_url, reason: card.reason },
    { kind: 'unknown', status: 'blocked', host: 'example.com', url: 'https://example.com/some/page?id=7', title: '', image_url: null, reason: null },
    'the fragment is dropped, share tracking stripped, the host lower-cased'
  );
  const again = await resolveLinkCard(e, 'https://example.com/some/page?id=7#other', { fetcher, now: at(48 * HOUR) });
  assert.equal(again.id, card.id, 'one row per URL, reused whatever its age');
  assert.deepEqual(calls, [], 'a host off the allow-list is NEVER fetched');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM link_cards'), 1);
  // A subdomain of a listed host is not the listed host.
  assert.equal(previewKindFor('pages.github.com'), null);
  assert.equal(previewKindFor('www.github.com'), 'article');
  assert.equal(previewKindFor('youtu.be'), 'video');
  assert.equal(previewKindFor('WWW.Cults3D.com.'), 'model_page');
});

// =========================================================================
// 3. A MODEL HOST — fetched once, reused for a day, the picture ours
// =========================================================================

test('a model host is fetched once, parsed, its picture re-hosted, and the row reused for 24 h', async () => {
  const images = imagesBinding();
  const { env: e, raw, bucket } = env(seed(), { IMAGES: images.binding });
  const { calls, fetcher } = network({
    [MODEL_URL]: { body: PAGE },
    [MODEL_IMAGE]: { body: png(), type: 'image/png' },
  });

  const card = await resolveLinkCard(e, MODEL_URL, { fetcher, now: at(0) });
  assert.deepEqual(calls, [MODEL_URL, MODEL_IMAGE], 'the page, then its picture — nothing else');
  assert.equal(card.kind, 'model_page');
  assert.equal(card.status, 'ok');
  assert.equal(card.host, 'printables.com');
  assert.equal(card.title, 'Articulated Dragon & Friends', 'og:title wins over <title>; entities decoded; whitespace collapsed');
  assert.equal(card.description, 'A flexi dragon that prints in place — no supports');
  assert.equal(card.image_url, `/files/link-cards/${card.id}.webp`, 'the picture is OUR key, never the source address');
  assert.ok(bucket.objects.has(`link-cards/${card.id}.webp`), 'the WebP landed in the public bucket');
  assert.equal(bucket.objects.get(`link-cards/${card.id}.webp`)!.contentType, 'image/webp');
  assert.equal(images.calls.length, 1, 'converted through the IMAGES binding');
  assert.equal(row(raw, 'SELECT visibility, domain FROM file_objects WHERE object_key = ?', `link-cards/${card.id}.webp`)!.visibility, 'public');
  assert.equal(card.fetched_at, T0.toISOString());

  const later = await resolveLinkCard(e, MODEL_URL, { fetcher, now: at(23 * HOUR) });
  assert.equal(later.id, card.id);
  assert.equal(later.title, card.title);
  assert.equal(calls.length, 2, 'inside 24 h nothing is fetched again');

  const stale = await resolveLinkCard(e, MODEL_URL, { fetcher, now: at(25 * HOUR) });
  assert.equal(stale.id, card.id, 'a refresh keeps the row (and the picture key named after it)');
  assert.equal(calls.length, 4, 'after 24 h the page is read again');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM link_cards'), 1);
  assert.equal(row(raw, 'SELECT fetched_at FROM link_cards WHERE id = ?', card.id)!.fetched_at, at(25 * HOUR)().toISOString());
});

test('OG parsing: the fallbacks, the entities, relative pictures, and the ceilings', () => {
  const bytes = (html: string) => new TextEncoder().encode(html);
  const base = 'https://www.thingiverse.com/thing:99';

  const full = parseOpenGraph(bytes(PAGE), base);
  assert.equal(full.image, 'https://www.thingiverse.com/images/dragon.png', 'og:image resolved against the page, ahead of twitter:image');

  const twitter = parseOpenGraph(
    bytes(`<head><title>Plain &amp; simple</title><meta name="twitter:title" content="Tweeted title"><meta name="twitter:description" content="From twitter"><meta name="twitter:image:src" content="https://cdn.example/t.jpg"></head>`),
    base
  );
  assert.deepEqual(twitter, { title: 'Tweeted title', description: 'From twitter', image: 'https://cdn.example/t.jpg' });

  const plain = parseOpenGraph(bytes(`<html><head><title>\n  Just a &#x1F409; title \n</title><meta name="description" content="meta description"></head></html>`), base);
  assert.deepEqual(plain, { title: 'Just a 🐉 title', description: 'meta description', image: null });

  const nothing = parseOpenGraph(bytes('<html><body>no head at all</body></html>'), base);
  assert.deepEqual(nothing, { title: '', description: '', image: null });

  const unsafe = parseOpenGraph(bytes(`<meta property="og:image" content="javascript:alert(1)"><meta property="og:title" content="x">`), base);
  assert.equal(unsafe.image, null, 'a picture address that is not http(s) is dropped');
  const data = parseOpenGraph(bytes(`<meta property="og:image" content="data:image/png;base64,AAAA">`), base);
  assert.equal(data.image, null);

  const long = parseOpenGraph(bytes(`<meta property="og:title" content="${'t'.repeat(500)}"><meta property="og:description" content="${'d'.repeat(900)}">`), base);
  assert.equal(long.title.length, 200);
  assert.ok(long.title.endsWith('…'));
  assert.equal(long.description.length, 500);

  const unquoted = parseOpenGraph(bytes(`<META PROPERTY=og:title CONTENT=Unquoted><meta content="Second" property="og:title">`), base);
  assert.equal(unquoted.title, 'Unquoted', 'the first og:title wins; attribute order and quoting do not matter');
});

// =========================================================================
// 4. THE PICTURE FAILS — the card does not
// =========================================================================

test('a picture that cannot be fetched, is not an image, or cannot be converted leaves image_key NULL and the card ok', async () => {
  const run = async (label: string, imageServed: Served | null, images: unknown) => {
    const { env: e, raw, bucket } = env(seed(), images ? { IMAGES: images } : {});
    const routes: Record<string, Served> = { [MODEL_URL]: { body: PAGE } };
    if (imageServed) routes[MODEL_IMAGE] = imageServed;
    const { fetcher } = network(routes);
    const card = await resolveLinkCard(e, MODEL_URL, { fetcher });
    assert.equal(card.status, 'ok', `${label}: the card is still ok`);
    assert.equal(card.title, 'Articulated Dragon & Friends', `${label}: the words survived`);
    assert.equal(card.image_url, null, `${label}: no picture`);
    assert.equal(row(raw, 'SELECT image_key FROM link_cards WHERE id = ?', card.id)!.image_key, null);
    assert.equal(bucket.objects.size, 0, `${label}: nothing was stored`);
  };
  await run('the picture 500s', { status: 500, body: 'boom', type: 'image/png' }, imagesBinding().binding);
  await run('the picture is missing', null, imagesBinding().binding);
  await run('the picture is HTML wearing a .png name', { body: '<html><body>not a picture</body></html>', type: 'image/png' }, imagesBinding().binding);
  await run('the picture is a PDF', { body: PDF, type: 'image/png' }, imagesBinding().binding);
  await run('the picture is too big', { body: png(2 * 1024 * 1024 + 1), type: 'image/png' }, imagesBinding().binding);
  await run('the IMAGES binding is absent', { body: png(), type: 'image/png' }, null);
  await run('the IMAGES binding fails', { body: png(), type: 'image/png' }, imagesBinding({ fail: true }).binding);
});

// =========================================================================
// 5. THE PAGE FAILS — remembered for an hour, then retried
// =========================================================================

test('text/html only: a listed host answering JSON is a failed card, remembered for an hour and retried after it', async () => {
  const { env: e } = env(seed());
  const routes: Record<string, Served> = { [MODEL_URL]: { body: '{"not":"html"}', type: 'application/json' } };
  const { calls, fetcher } = network(routes);

  const failed = await resolveLinkCard(e, MODEL_URL, { fetcher, now: at(0) });
  assert.deepEqual({ status: failed.status, reason: failed.reason, title: failed.title, host: failed.host, kind: failed.kind }, {
    status: 'failed', reason: 'LINK_FETCH_FAILED', title: '', host: 'printables.com', kind: 'model_page',
  });
  assert.equal(calls.length, 1);

  const soon = await resolveLinkCard(e, MODEL_URL, { fetcher, now: at(30 * 60 * 1000) });
  assert.equal(soon.status, 'failed');
  assert.equal(calls.length, 1, 'inside the hour the dead page is not asked again');

  routes[MODEL_URL] = { body: PAGE };
  const retried = await resolveLinkCard(e, MODEL_URL, { fetcher, now: at(61 * 60 * 1000) });
  assert.equal(retried.status, 'ok');
  assert.equal(retried.title, 'Articulated Dragon & Friends');
  assert.equal(retried.id, failed.id);
  assert.equal(calls.length, 3, 'the page again, then its picture');
});

test('a listed host that redirects off the list is a failed card, and the landing page\'s picture is never fetched', async () => {
  const { env: e } = env(seed(), { IMAGES: imagesBinding().binding });
  const evil = 'https://evil.example/landing';
  const { calls, fetcher } = network({
    [MODEL_URL]: { status: 302, headers: { location: evil } },
    [evil]: { body: `<meta property="og:title" content="Gotcha"><meta property="og:image" content="https://evil.example/i.png">` },
    'https://evil.example/i.png': { body: png(), type: 'image/png' },
  });
  const card = await resolveLinkCard(e, MODEL_URL, { fetcher });
  assert.equal(card.status, 'failed');
  assert.equal(card.title, '');
  assert.ok(!calls.includes('https://evil.example/i.png'), 'no picture is fetched from a page that is not on the list');
  const timedOut = await resolveLinkCard(e, 'https://www.printables.com/model/2', {
    fetcher: (async () => new Response('slow', { status: 500 })) as typeof fetch,
  });
  assert.equal(timedOut.status, 'failed', 'an HTTP error is a failed card, not a thrown error');
});

test('the allow-list holds on EVERY hop: an og:image on an off-list host is never requested, a listed host\'s CDN is, and a redirect off the list is refused before the landing page is asked for', async () => {
  const images = imagesBinding();
  const { env: e, bucket } = env(seed(), { IMAGES: images.binding });
  const offList = 'https://attacker.example/anything.png';
  const { calls, fetcher } = network({
    [MODEL_URL]: { body: PAGE.replace('/images/dragon.png', offList) },
    [offList]: { body: png(), type: 'image/png' },
  });
  const card = await resolveLinkCard(e, MODEL_URL, { fetcher });
  assert.equal(card.status, 'ok');
  assert.equal(card.title, 'Articulated Dragon & Friends');
  assert.equal(card.image_url, null, 'no picture from a host outside the list');
  assert.deepEqual(calls, [MODEL_URL], 'the page only — the off-list picture was never requested');
  assert.equal(bucket.objects.size, 0);

  // The picture hosts the listed pages use are fine.
  const cdnPage = 'https://www.printables.com/model/777-cdn';
  const cdn = 'https://media.printables.com/media/dragon.png';
  const ok = network({ [cdnPage]: { body: PAGE.replace('/images/dragon.png', cdn) }, [cdn]: { body: png(), type: 'image/png' } });
  const withCdn = await resolveLinkCard(e, cdnPage, { fetcher: ok.fetcher });
  assert.equal(withCdn.image_url, `/files/link-cards/${withCdn.id}.webp`);
  assert.deepEqual(ok.calls, [cdnPage, cdn]);

  // The redirect: refused at the hop, so the off-list landing page is never even requested.
  const evil = 'https://evil.example/landing';
  const redirecting = network({
    ['https://www.printables.com/model/2-redirect']: { status: 302, headers: { location: evil } },
    [evil]: { body: '<meta property="og:title" content="Gotcha">' },
  });
  const failed = await resolveLinkCard(e, 'https://www.printables.com/model/2-redirect', { fetcher: redirecting.fetcher });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(redirecting.calls, ['https://www.printables.com/model/2-redirect'], 'no request to the landing page');
  // …and a picture that redirects off the list is a picture that is not fetched either.
  const bouncePage = 'https://www.printables.com/model/3-bounce';
  const bounce = network({
    [bouncePage]: { body: PAGE },
    [MODEL_IMAGE]: { status: 302, headers: { location: offList } },
    [offList]: { body: png(), type: 'image/png' },
  });
  const bounced = await resolveLinkCard(e, bouncePage, { fetcher: bounce.fetcher });
  assert.equal(bounced.status, 'ok');
  assert.equal(bounced.image_url, null);
  assert.deepEqual(bounce.calls, [bouncePage, MODEL_IMAGE], 'the picture\'s first hop is asked, the off-list hop never');
});

// =========================================================================
// 6. THE CHAT — the participant check, the snapshot, the reader
// =========================================================================

test('a non-participant cannot post a link card; a participant can, once per client_id, and every reader sees `link`', async () => {
  const raw = seed();
  const { calls, fetcher } = network({});
  await withFetch(fetcher, async () => {
    assert.equal((await post(as(raw, ALI).app, '/api/chats/chat_1/cards/link', { url: 'https://example.org/thing' })).status, 403);
    assert.equal((await post(as(raw, null).app, '/api/chats/chat_1/cards/link', { url: 'https://example.org/thing' })).status, 401);
    assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM chat_messages'), 0);

    const bad = await post(as(raw, SARA).app, '/api/chats/chat_1/cards/link', { url: 'http://10.0.0.1/', client_id: 'send-0001' });
    assert.equal(bad.status, 400);
    assert.equal((await json(bad)).code, 'LINK_HOST_BLOCKED');

    const sent = await post(as(raw, SARA).app, '/api/chats/chat_1/cards/link', { url: 'https://example.org/thing?utm_medium=chat#x', client_id: 'send-0001' });
    assert.equal(sent.status, 201, JSON.stringify(await json(sent.clone())));
    const body = await json(sent);
    assert.equal(body.message.kind, 'text', 'an older screen draws a plain line');
    assert.equal(body.message.body, 'https://example.org/thing', 'whose body is the address');
    assert.equal(body.message.card, null, 'not a commerce card');
    assert.deepEqual(body.message.link, {
      card_id: body.card.id, url: 'https://example.org/thing', host: 'example.org', title: '', description: '', image_url: null, kind: 'unknown',
    });
    assert.equal(body.card.status, 'blocked');

    const replay = await post(as(raw, SARA).app, '/api/chats/chat_1/cards/link', { url: 'https://example.org/thing', client_id: 'send-0001' });
    assert.equal(replay.status, 200);
    const replayed = await json(replay);
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.id, body.id);
    assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM chat_messages'), 1, 'a retried send is the same message');

    const stored = row(raw, 'SELECT card_type, card_snapshot, body FROM chat_messages WHERE id = ?', body.id)!;
    assert.equal(stored.card_type, null, "0150's CHECK is not touched");
    assert.equal(JSON.parse(String(stored.card_snapshot)).type, 'link');
    assert.deepEqual(linkFromSnapshot(stored.card_snapshot), body.message.link);

    const read = await json(await get(as(raw, EVE).app, '/api/chats/chat_1/messages'));
    assert.equal(read.messages.length, 1);
    assert.equal(read.messages[0].link.url, 'https://example.org/thing');
    assert.equal(read.messages[0].mine, false);
    assert.equal(read.messages[0].link.host, 'example.org');
  });
  assert.deepEqual(calls, [], 'an off-list host in a chat is never fetched either');
  assert.equal(linkFromSnapshot('{"type":"product","x":1}'), null);
  assert.equal(linkFromSnapshot('not json'), null);
  assert.equal(linkFromSnapshot(null), null);
  const forged = linkFromSnapshot(JSON.stringify({ type: 'link', card_id: 'c', url: 'https://a.b', host: 'a.b', image_url: 'https://evil/x.png', kind: 'weird' }));
  assert.equal(forged!.image_url, null, 'a snapshot picture is served from /files or not at all');
  assert.equal(forged!.kind, 'unknown');
});

test('a link card in a chat with a listed host is resolved on the server and its snapshot freezes what was learned', async () => {
  const raw = seed();
  const images = imagesBinding();
  const { calls, fetcher } = network({ [MODEL_URL]: { body: PAGE }, [MODEL_IMAGE]: { body: png(), type: 'image/png' } });
  await withFetch(fetcher, async () => {
    const { app } = as(raw, SARA, { IMAGES: images.binding });
    const sent = await json(await post(app, '/api/chats/chat_1/cards/link', { url: MODEL_URL, client_id: 'send-0002' }));
    assert.equal(sent.message.link.title, 'Articulated Dragon & Friends');
    assert.equal(sent.message.link.kind, 'model_page');
    assert.equal(sent.message.link.image_url, `/files/link-cards/${sent.card.id}.webp`);
    assert.deepEqual(calls, [MODEL_URL, MODEL_IMAGE]);
    // A second person sharing the same page in another send: the row is reused.
    const again = await json(await post(as(raw, EVE, { IMAGES: images.binding }).app, '/api/chats/chat_1/cards/link', { url: MODEL_URL, client_id: 'send-0003' }));
    assert.equal(again.card.id, sent.card.id);
    assert.equal(calls.length, 2, 'one fetch per URL per day, whoever pastes it');
  });
});

// =========================================================================
// 7. THE READER'S DOOR — never a fetch
// =========================================================================

test('GET /api/link-cards?url= answers the stored row or 404 and never fetches, for a guest through the anonymous cache', async () => {
  const raw = seed();
  const { calls, fetcher } = network({ [MODEL_URL]: { body: PAGE }, [MODEL_IMAGE]: { body: png(), type: 'image/png' } });
  await withFetch(fetcher, async () => {
    const guest = as(raw, null).app;
    const q = `/api/link-cards?url=${encodeURIComponent(MODEL_URL)}`;
    const missing = await get(guest, q);
    assert.equal(missing.status, 404);
    assert.deepEqual(calls, [], 'the reader never triggers a fetch — not even for a listed host nobody resolved');

    assert.equal((await get(guest, '/api/link-cards?url=javascript:alert(1)')).status, 400);
    assert.equal((await json(await get(guest, '/api/link-cards?url=javascript:alert(1)'))).code, 'LINK_URL_INVALID');
    assert.equal((await get(guest, '/api/link-cards')).status, 400);

    const resolved = await json(await post(as(raw, SARA).app, '/api/link-cards/resolve', { url: MODEL_URL }));
    assert.equal(resolved.card.status, 'ok');
    assert.equal(calls.length, 2);

    const hit = await get(guest, `/api/link-cards?url=${encodeURIComponent(`${MODEL_URL}#frag`)}`);
    assert.equal(hit.status, 200);
    const card = (await json(hit)).card;
    assert.equal(card.id, resolved.card.id);
    assert.equal(card.title, 'Articulated Dragon & Friends');
    assert.match(hit.headers.get('Cache-Control') ?? '', /max-age=/, 'a guest answer is edge-cacheable');
    assert.ok(hit.headers.get('ETag'));
    assert.equal(calls.length, 2, 'the read fetched nothing');

    const mine = await get(as(raw, EVE).app, `/api/link-cards?url=${encodeURIComponent(MODEL_URL)}`);
    assert.equal(mine.status, 200);
    assert.equal(mine.headers.get('Cache-Control'), 'private, no-store', 'a signed-in answer is never stored at the edge');
    assert.equal(calls.length, 2);
  });
});

// =========================================================================
// 8. GROUPED FILE NOTIFICATIONS — people, not events
// =========================================================================

test('files_added: a burst of attachments is ONE row per other participant whose count is PEOPLE', async () => {
  const raw = seed();
  const bucket = memoryBucket();
  for (const k of ['a', 'b', 'c']) await bucket.put(`chat/chat_1/files/${k}.pdf`, PDF, { httpMetadata: { contentType: 'application/pdf' } });
  const appFor = (u: StubUser) => stubApp(asD1(raw), u, mount, { env: { BUCKET: bucket, R2_PUBLIC: bucket, R2_PRIVATE: bucket } });
  const sendFile = async (u: StubUser, k: string) => {
    const res = await post(appFor(u), '/api/chats/chat_1/messages', { kind: 'file', fileKey: `chat/chat_1/files/${k}.pdf` });
    assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  };

  await sendFile(SARA, 'a');
  await sendFile(SARA, 'b');
  const afterSara = notes(raw, 'eve', 'files_added');
  assert.equal(afterSara.length, 1, 'two files from one person are one row');
  assert.equal(JSON.parse(afterSara[0].meta).count, 1, 'and one PERSON');
  assert.equal(afterSara[0].title_en, 'sara sent new files');
  assert.equal(afterSara[0].title_ar, 'أرسل sara ملفات جديدة');
  assert.equal(JSON.parse(afterSara[0].meta).title_ckb, 'sara فایلی نوێی نارد', 'the Sorani rides in meta, the merchant centre\'s trick');
  assert.equal(afterSara[0].event_key, 'files_added:chat_1');
  assert.equal(afterSara[0].link, '/chat/chat_1');
  assert.equal(notes(raw, 'sara', 'files_added').length, 0, 'the sender does not hear about their own files');

  raw.exec("UPDATE user_notifications SET read_at = '2026-09-01T00:00:00.000Z' WHERE user_id = 'eve'");
  await sendFile(ZED, 'c');
  const afterZed = notes(raw, 'eve', 'files_added');
  assert.equal(afterZed.length, 1, 'still one row');
  const meta = JSON.parse(afterZed[0].meta);
  assert.equal(meta.count, 2, 'a second PERSON raises the count');
  assert.equal(meta.last_actor.id, 'zed');
  assert.equal(afterZed[0].title_en, '2 people sent new files');
  assert.equal(afterZed[0].title_ar, 'أرسل شخصان ملفات جديدة');
  assert.equal(meta.title_ckb, '2 کەس فایلی نوێیان نارد');
  assert.equal(afterZed[0].read_at, null, 'and the row came back unread');
  assert.equal(notes(raw, 'sara', 'files_added').length, 1, 'sara hears about zed\'s file');
  assert.equal(notes(raw, 'zed', 'files_added').length, 1, 'zed heard about sara\'s');

  // A plain line is not a file.
  assert.equal((await post(appFor(SARA), '/api/chats/chat_1/messages', { body: 'thanks' })).status, 200);
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM user_notifications WHERE kind = 'files_added'"), 3);
});

test('request_files: only the workshops on a request\'s matches hear that its files changed — once per person', async () => {
  const raw = seed();
  raw.exec(`
    INSERT INTO community_requests (id,customer_id,title,description,state,status,visibility,offer_count,expires_at)
      VALUES ('r1','sara','A bracket','A bracket for a shelf','receiving_offers','open','public',0,'2099-01-01T00:00:00.000Z');
    INSERT INTO community_request_matches (id,request_id,merchant_id,eligible,score) VALUES
      ('rm1','r1','m_ali',1,80), ('rm2','r1','m_omar',0,0);
  `);
  const bucket = memoryBucket();
  const app = stubApp(asD1(raw), SARA, mount, { env: { BUCKET: bucket } });
  const upload = () => {
    const form = new FormData();
    form.append('file', new File([png() as unknown as BlobPart], 'photo.png'));
    return app.request('/api/marketplace/requests/r1/files', { method: 'POST', body: form, headers: { 'CF-Connecting-IP': '1.2.3.4' } });
  };
  const first = await upload();
  assert.equal(first.status, 201, JSON.stringify(await json(first.clone())));

  const heard = notes(raw, 'ali', 'request_files');
  assert.equal(heard.length, 1, 'the matched workshop\'s owner hears');
  assert.equal(heard[0].title_en, 'sara added files to the request “A bracket”');
  assert.equal(heard[0].title_ar, 'أضاف sara ملفات إلى الطلب «A bracket»');
  assert.equal(heard[0].event_key, 'request_files:r1');
  assert.ok(heard[0].link.includes('r1'), 'the link opens the request in the workspace');
  assert.ok(JSON.parse(heard[0].meta).title_ckb.includes('A bracket'));
  assert.equal(notes(raw, 'omar', 'request_files').length, 0, 'a workshop the engine rejected hears nothing');
  assert.equal(notes(raw, 'sara', 'request_files').length, 0, 'the customer does not hear about their own files');

  const second = await upload();
  assert.equal(second.status, 201);
  const still = notes(raw, 'ali', 'request_files');
  assert.equal(still.length, 1, 'a second file from the same person is the same row');
  assert.equal(JSON.parse(still[0].meta).count, 1, 'counted by people, not by files');
});
