/**
 * META CONVERSIONS API (worker/lib/metaCapi.ts, worker/routes/metaEvents.ts and
 * the cart, quote and order doors). What these hold is what the privacy policy
 * (version 4, chapter 7) tells customers: the main site only, the reported
 * pages only, the email and phone hashed and never in clear, amounts in US
 * dollars, no order number, nothing sent without the secret, and nothing a
 * browser types in taken as a price.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import {
  META_CAPI_ENDPOINT,
  META_DATASET_CHECK_URL,
  META_DATASET_ID,
  checkMetaCapi,
  iqdToUsd,
  isMetaReportedPath,
  metaLinesData,
  metaLinesFrom,
  metaUserData,
  normalizeMetaEmail,
  normalizeMetaPhone,
  sendMetaEvents,
  type MetaServerEvent,
} from '../worker/lib/metaCapi';
import { isMetaPixelPath, META_PIXEL_ID } from '../src/lib/metaPixel';
import { metaEventRoutes } from '../worker/routes/metaEvents';
import { classifyHost } from '../worker/lib/hosts';
import { HttpError } from '../worker/lib/http';
import type { AppContext } from '../worker/lib/types';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

test('the dataset is the pixel, on the current Graph API', () => {
  assert.equal(META_DATASET_ID, META_PIXEL_ID);
  assert.equal(META_CAPI_ENDPOINT, `https://graph.facebook.com/v26.0/${META_PIXEL_ID}/events`);
});

test('the server reports exactly the pages the browser reports', () => {
  const sample = [
    '/', '/products', '/product/x', '/product/x/', '/categories', '/categories/a', '/categories/a/b', '/categories/a/b/c', '/compare',
    '/used-printers', '/trade-in', '/bundles', '/bundles/s', '/cart', '/checkout', '/community', '/community/stores',
    '/community/makers', '/community/projects', '/community/projects/p1', '/community/projects/new', '/community/projects/p1/edit',
    '/community/store/s', '/community/store/s/p/x', '/community/saved', '/u/sara', '/tools', '/printer-finder', '/policies',
    '/policies/privacy', '/policy', '/admin', '/merchant', '/orders', '/orders/1', '/chat/1', '/auth', '/settings', '/wallet',
    '/model-viewer/t', '/warranty/1', '/requests', '/store-checkout', '/later',
  ];
  for (const p of sample) assert.equal(isMetaReportedPath(p), isMetaPixelPath(p), p);
});

test('email and phone are normalised as Meta asks, and only ever leave hashed', async () => {
  assert.equal(normalizeMetaEmail('  Sara.K@Example.COM '), 'sara.k@example.com');
  assert.equal(normalizeMetaEmail('tg-123@telegram.local'), null, 'a phone-only account\'s placeholder is never sent');
  assert.equal(normalizeMetaEmail('not-an-email'), null);
  assert.equal(normalizeMetaPhone('+9647701234567'), '9647701234567');
  assert.equal(normalizeMetaPhone(null), null);
  const app = new Hono<AppContext>();
  app.get('/', async (c) => c.json(await metaUserData(c, { email: 'Sara@Example.com', phone_e164: '+9647701234567' })));
  const res = await app.request('/', {
    headers: {
      'CF-Connecting-IP': '203.0.113.7',
      'User-Agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/130',
      Cookie: '_fbp=fb.1.1730000000000.1234567890; _fbc=fb.1.1730000000000.AbCd_123; levonis_session=secret',
    },
  });
  const data = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(data, {
    em: [sha('sara@example.com')],
    ph: [sha('9647701234567')],
    client_ip_address: '203.0.113.7',
    client_user_agent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130',
    fbp: 'fb.1.1730000000000.1234567890',
    fbc: 'fb.1.1730000000000.AbCd_123',
  });
  const text = JSON.stringify(data);
  for (const clear of ['Sara', 'sara@', '7701234567', 'secret']) assert.ok(!text.includes(clear), `${clear} left in clear`);
});

test('money is sent in US dollars at the given rate; bundle parts and gifts are not lines of their own', () => {
  assert.equal(iqdToUsd(1_500_000, 1_500), 1000);
  assert.equal(iqdToUsd(1_000, 1_473), 0.68);
  assert.equal(iqdToUsd(1_000, 0), null);
  const lines = metaLinesFrom([
    { product_id: 'p_a', qty: 2, unit: 30_000 },
    { product_id: 'p_bundle', qty: 1, unit: 150_000 },
    { product_id: 'p_part', qty: 1, unit: 0, bundle_parent_item_id: 'ci_bundle' },
    { product_id: 'p_gift', qty: 1, unit: 0, gift: { gift_id: 'g' } },
    { product_id: null, qty: 1, unit: 10_000 },
  ]);
  assert.deepEqual(lines.map((l) => l.product_id), ['p_a', 'p_bundle']);
  assert.deepEqual(metaLinesData(lines, 210_000, 1_500, { numItems: true }), {
    content_type: 'product',
    content_ids: ['p_a', 'p_bundle'],
    contents: [{ id: 'p_a', quantity: 2, item_price: 20 }, { id: 'p_bundle', quantity: 1, item_price: 100 }],
    currency: 'USD',
    value: 140,
    num_items: 3,
  });
});

test('nothing leaves without the secret; with it, one form POST carries the token in the body, never the URL', async () => {
  const event: MetaServerEvent = { event_name: 'PageView', event_time: 1, event_id: 'evt_12345678', action_source: 'website', user_data: { client_user_agent: 'x' } };
  let called = 0;
  const never = (async () => { called++; return new Response('{}'); }) as typeof fetch;
  assert.equal(await sendMetaEvents({}, [event], { fetchImpl: never }), 'not-configured');
  assert.equal(await sendMetaEvents({ META_CAPI_ACCESS_TOKEN: '   ' }, [event], { fetchImpl: never }), 'not-configured');
  assert.equal(called, 0);
  const seen: Array<{ url: string; body: string; type: string }> = [];
  const ok = (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(url), body: String(init?.body), type: new Headers(init?.headers).get('content-type') ?? '' });
    return new Response('{"events_received":1}', { status: 200 });
  }) as typeof fetch;
  assert.equal(await sendMetaEvents({ META_CAPI_ACCESS_TOKEN: 'tok_SECRET', META_CAPI_TEST_EVENT_CODE: 'TEST123' }, [event], { fetchImpl: ok }), 'sent');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, META_CAPI_ENDPOINT);
  assert.ok(!seen[0].url.includes('tok_SECRET'), 'the token is never in the URL');
  assert.equal(seen[0].type, 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(seen[0].body);
  assert.equal(form.get('access_token'), 'tok_SECRET');
  assert.equal(form.get('test_event_code'), 'TEST123');
  assert.deepEqual(JSON.parse(form.get('data')!), [event]);
  const refused = (async () => new Response('{"error":{}}', { status: 400 })) as typeof fetch;
  assert.equal(await sendMetaEvents({ META_CAPI_ACCESS_TOKEN: 'tok' }, [event], { fetchImpl: refused }), 'failed', 'a refusal is reported, never thrown');
});

/** The beacon route on a given host, with the secret set and the network stubbed. */
async function beacon(host: string, body: unknown, opts: { token?: boolean; ua?: string } = {}) {
  const sent: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).startsWith('https://graph.facebook.com/')) {
      sent.push(String(init?.body));
      return new Response('{}', { status: 200 });
    }
    return realFetch(url, init);
  }) as typeof fetch;
  const pending: Promise<unknown>[] = [];
  const rateRows: unknown[] = [];
  const db = {
    prepare: () => ({ bind: () => ({ first: async () => { rateRows.push(1); return { count: 1 }; }, run: async () => ({}) }) }),
  };
  const app = new Hono<AppContext>();
  app.use('*', async (c, next) => {
    c.set('host', classifyHost(host, 'levonis-iq.com'));
    c.set('user', null);
    await next();
  });
  app.route('/api/meta-events', metaEventRoutes);
  // As worker/index.ts answers a refusal.
  app.onError((err, c) => (err instanceof HttpError ? c.json({ code: err.code }, err.status as 400) : c.json({ code: 'ERROR' }, 500)));
  try {
    const res = await app.request(
      `https://${host}/api/meta-events`,
      {
        method: 'POST',
        body: typeof body === 'string' ? body : JSON.stringify(body),
        headers: { 'User-Agent': opts.ua ?? 'Mozilla/5.0 (Linux; Android 14) Chrome/130', 'CF-Connecting-IP': '203.0.113.7' },
      },
      { DB: db, ...(opts.token === false ? {} : { META_CAPI_ACCESS_TOKEN: 'tok' }) } as never,
      { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} } as never
    );
    await Promise.all(pending);
    return { status: res.status, sent: sent.map((b) => JSON.parse(new URLSearchParams(b).get('data')!) as MetaServerEvent[]) };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('the beacon relays PageView and ViewContent from the main site, and nothing from a store host, a private page or a crawler', async () => {
  const pv = await beacon('levonis-iq.com', { event: 'PageView', id: 'abcdef123456', path: '/products' });
  assert.equal(pv.status, 204);
  assert.equal(pv.sent.length, 1);
  assert.equal(pv.sent[0][0].event_name, 'PageView');
  assert.equal(pv.sent[0][0].event_id, 'abcdef123456', 'the browser pixel\'s id, so Meta keeps one');
  assert.equal(pv.sent[0][0].event_source_url, 'https://levonis-iq.com/products');
  const vc = await beacon('levonis-iq.com', { event: 'ViewContent', id: 'abcdef123457', path: '/product/benchy', product: 'p_1' });
  assert.deepEqual(vc.sent[0][0].custom_data, { content_type: 'product', content_ids: ['p_1'] }, 'no price taken from a browser');
  for (const [host, body, opts] of [
    ['ali3d.levonis-iq.com', { event: 'PageView', id: 'abcdef123458', path: '/products' }, {}],
    ['levonis-iq.com', { event: 'PageView', id: 'abcdef123459', path: '/orders/ORD-1' }, {}],
    ['levonis-iq.com', { event: 'ViewContent', id: 'abcdef123460', path: '/products', product: 'p_1' }, {}],
    ['levonis-iq.com', { event: 'PageView', id: 'abcdef123461', path: '/products' }, { ua: 'Googlebot/2.1' }],
    ['levonis-iq.com', { event: 'PageView', id: 'abcdef123462', path: '/products' }, { token: false }],
  ] as const) {
    const r = await beacon(host, body, opts);
    assert.equal(r.status, 204, JSON.stringify(body));
    assert.equal(r.sent.length, 0, `${host} ${JSON.stringify(body)} ${JSON.stringify(opts)} must send nothing`);
  }
});

test('the beacon refuses what it does not relay: a Purchase, a price, a malformed id', async () => {
  for (const body of [
    { event: 'Purchase', id: 'abcdef123456', path: '/checkout' },
    { event: 'AddToCart', id: 'abcdef123456', path: '/product/x', product: 'p' },
    { event: 'PageView', id: 'bad id!', path: '/products' },
    { event: 'PageView', id: 'abcdef123456', path: 'products' },
    { event: 'ViewContent', id: 'abcdef123456', path: '/product/x' },
    'not json',
  ]) {
    const r = await beacon('levonis-iq.com', body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.sent.length, 0);
  }
  assert.equal((await beacon('levonis-iq.com', 'x'.repeat(2000))).status, 413);
});

test('the server doors send their own figures: AddToCart from the cart, InitiateCheckout from the quote, Purchase after the commit', () => {
  const cart = read('worker/routes/cart.ts');
  assert.equal((cart.match(/queueCartAddForMeta\(c, items,/g) ?? []).length, 3, 'single add, batch add and composition add');
  assert.ok(!/queueCartAddForMeta[\s\S]{0,400}merchant-items/.test(cart));
  const orders = read('worker/routes/orders.ts');
  const quote = orders.indexOf("orderRoutes.post('/quote'");
  const ic = orders.indexOf('queueMetaInitiateCheckout(c, user, comp);');
  assert.ok(quote > 0 && ic > quote && ic < orders.indexOf('return c.json({', quote), 'InitiateCheckout before the quote answers');
  const commit = orders.indexOf('await c.env.DB.batch(stmts)');
  const purchase = orders.indexOf('queueMetaPurchase(c, user, { id: orderId');
  assert.ok(commit > 0 && purchase > commit, 'Purchase only after the order\'s batch committed');
  const lib = read('worker/lib/metaCapi.ts');
  assert.match(lib, /event_id: await metaEventId\('purchase', order\.id\)/, 'the order number leaves only as a one-way hash');
  assert.ok(!/console\.\w+\([^)]*token/i.test(lib), 'the token is never logged');
});

test('the owner\'s check asks Meta about the dataset with the token in a header — never the URL, never an event', async () => {
  let called = 0;
  const never = (async () => { called++; return new Response('{}'); }) as typeof fetch;
  const off = await checkMetaCapi({}, { fetchImpl: never });
  assert.deepEqual(off, { configured: false, testMode: false, ok: false, status: null, datasetName: null, error: null });
  assert.equal(called, 0, 'no token, no request');

  const seen: Array<{ url: string; method: string; auth: string; body: unknown }> = [];
  const ok = (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(url), method: String(init?.method), auth: new Headers(init?.headers).get('authorization') ?? '', body: init?.body });
    return new Response(JSON.stringify({ id: META_DATASET_ID, name: 'Levonis pixel' }), { status: 200 });
  }) as typeof fetch;
  const good = await checkMetaCapi({ META_CAPI_ACCESS_TOKEN: 'tok_SECRET' }, { fetchImpl: ok });
  assert.equal(good.ok, true);
  assert.equal(good.datasetName, 'Levonis pixel');
  assert.equal(good.testMode, false);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, META_DATASET_CHECK_URL);
  assert.equal(seen[0].url, `https://graph.facebook.com/v26.0/${META_DATASET_ID}?fields=id,name`);
  assert.equal(seen[0].method, 'GET', 'a read: no event is created');
  assert.equal(seen[0].auth, 'Bearer tok_SECRET');
  assert.ok(!seen[0].url.includes('tok_SECRET'), 'the token is never in the URL');
  assert.equal(seen[0].body, undefined);

  const tested = await checkMetaCapi({ META_CAPI_ACCESS_TOKEN: 'tok', META_CAPI_TEST_EVENT_CODE: 'TEST1' }, { fetchImpl: ok });
  assert.equal(tested.testMode, true, 'test mode is reported: events land in Test events only');

  // Meta's own verdict comes back, and the token never does — even if an answer echoed it.
  const expired = (async () =>
    new Response(JSON.stringify({ error: { message: 'Error validating access token: tok_SECRET has expired', type: 'OAuthException', code: 190, error_subcode: 463 } }), { status: 400 })) as typeof fetch;
  const bad = await checkMetaCapi({ META_CAPI_ACCESS_TOKEN: 'tok_SECRET' }, { fetchImpl: expired });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
  assert.deepEqual({ ...bad.error, message: undefined }, { code: 190, subcode: 463, type: 'OAuthException', message: undefined });
  assert.ok(!JSON.stringify(bad).includes('tok_SECRET'), 'the token never comes back');

  // Another dataset's id is not a pass.
  const other = (async () => new Response(JSON.stringify({ id: '1', name: 'x' }), { status: 200 })) as typeof fetch;
  assert.equal((await checkMetaCapi({ META_CAPI_ACCESS_TOKEN: 'tok' }, { fetchImpl: other })).ok, false);

  const down = (async () => { throw new Error('network down tok_SECRET'); }) as typeof fetch;
  const unreachable = await checkMetaCapi({ META_CAPI_ACCESS_TOKEN: 'tok_SECRET' }, { fetchImpl: down });
  assert.equal(unreachable.ok, false);
  assert.equal(unreachable.error?.type, 'unreachable');
  assert.ok(!JSON.stringify(unreachable).includes('tok_SECRET'));
});

test('Admin → Providers carries the Meta presence and the "check with Meta" door', () => {
  const admin = read('worker/routes/admin.ts');
  assert.match(admin, /meta: \{\s*configured: metaCapiConfigured\(c\.env\),/);
  assert.match(admin, /\['email', 'whatsapp', 'telegram', 'meta'\] as const/);
  assert.match(admin, /const r = await checkMetaCapi\(c\.env\);/);
  const ui = read('src/components/AdminChannels.tsx');
  assert.match(ui, /runTest\('meta'\)/);
  for (const key of ['meta:', 'metaNoToken:', 'metaTestMode:', 'metaCheck:', 'metaOk:', 'metaRefused:']) {
    assert.equal(ui.split(`    ${key}`).length - 1, 3, `${key} exists in ar, en and ckb`);
  }
});
