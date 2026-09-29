/**
 * `www.` IS NOT A SECOND HOME — the Google sign-in fix (docs/GOOGLE_SIGNIN_FIX.md §8).
 *
 * The live site answered on `www.levonis-iq.com` with the whole application,
 * while Google's Authorized JavaScript origins name the apex: a sign-in begun
 * on `www` ended in `origin_mismatch`. Both halves of the fix are pinned here:
 * the SPA moves a `www` page to the apex before anything renders
 * (src/lib/canonicalHost.ts), and the Worker answers the documents it serves
 * first with a 301 (worker/lib/hosts.ts `apexRedirectFor`), driven through the
 * real entry point.
 *
 * The negative cases matter as much: the apex, merchant shops and system
 * hosts are never moved, the API and the file store are never redirected (a
 * page already open on `www` keeps working, a POST keeps its body), and the
 * server's Google verification is not touched at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { freshDb, asD1, ctx, APEX, MERCHANT_HOST } from './fixtures/app';
import worker from '../worker/index';
import { apexUrlFor } from '../src/lib/canonicalHost';
import { apexRedirectFor } from '../worker/lib/hosts';

const WWW = `www.${APEX}`;

// ------------------------------------------------------------------ the SPA half

test('a www page moves to the apex with its path, query and fragment', () => {
  assert.equal(apexUrlFor(`https://${WWW}/auth`), `https://${APEX}/auth`);
  assert.equal(apexUrlFor(`https://${WWW}/`), `https://${APEX}/`);
  assert.equal(
    apexUrlFor(`https://${WWW}/auth?next=%2Fcommunity%2Frequests&x=1#top`),
    `https://${APEX}/auth?next=%2Fcommunity%2Frequests&x=1#top`
  );
  assert.equal(apexUrlFor(`https://WWW.LEVONIS-IQ.COM/chats/c1`), `https://${APEX}/chats/c1`, 'the host is case-insensitive');
  assert.equal(apexUrlFor(`http://${WWW}:8080/x`), `http://${APEX}:8080/x`, 'scheme and port are kept');
});

test('nothing but www moves: the apex, shops, system hosts and local development stay', () => {
  for (const href of [
    `https://${APEX}/auth`,
    `https://${MERCHANT_HOST}/`,
    `https://ali3d.${APEX}/product/p1`,
    `https://admin.${APEX}/`,
    `https://www2.${APEX}/`,
    `https://wwwshop.${APEX}/`,
    'http://localhost:4192/auth',
    'http://127.0.0.1:8787/',
    'file:///www.levonis-iq.com/index.html',
    'about:blank',
    'not a url',
    '',
  ]) {
    assert.equal(apexUrlFor(href), null, `${href} must not be moved`);
  }
});

test('the entry redirects before anything renders, and registers nothing on the way out', () => {
  const main = readFileSync(join(ROOT, 'src/main.tsx'), 'utf8');
  assert.match(main, /import \{ apexUrlFor \} from '\.\/lib\/canonicalHost';/);
  const decide = main.indexOf('apexUrlFor(window.location.href)');
  const replace = main.indexOf('window.location.replace(apex)');
  assert.ok(decide > 0 && replace > decide, 'the entry must decide and leave with location.replace (no history entry)');
  // The app, the install listener and the theme all start only on a page that stays.
  for (const call of ['startInstallPromptCapture();', 'initTheme();', 'createRoot(']) {
    const at = main.indexOf(call);
    assert.ok(at > replace, `${call} must run after the www check, never before it`);
  }
  assert.match(main, /if \(!apex\) registerServiceWorker\(\);/, 'a page that is leaving must not install a service worker on www');
});

// ------------------------------------------------------------ the Worker half

test('apexRedirectFor: only www of the configured root, only GET and HEAD, never the API or files', () => {
  assert.equal(apexRedirectFor(WWW, APEX, 'GET', '/', ''), `https://${APEX}/`);
  assert.equal(apexRedirectFor(WWW, APEX, 'HEAD', '/product/p1', '?ref=share'), `https://${APEX}/product/p1?ref=share`);
  assert.equal(apexRedirectFor(`${WWW}:443`, APEX, 'GET', '/community/store/ali3d', ''), `https://${APEX}/community/store/ali3d`);
  assert.equal(apexRedirectFor('WWW.Levonis-IQ.com.', APEX, 'GET', '/sitemap.xml', ''), `https://${APEX}/sitemap.xml`);

  // Other hosts.
  assert.equal(apexRedirectFor(APEX, APEX, 'GET', '/', ''), null);
  assert.equal(apexRedirectFor(MERCHANT_HOST, APEX, 'GET', '/', ''), null);
  assert.equal(apexRedirectFor(`www.${MERCHANT_HOST}`, APEX, 'GET', '/', ''), null);
  assert.equal(apexRedirectFor('www.evil.com', APEX, 'GET', '/', ''), null, 'a foreign www is never an open redirect');
  assert.equal(apexRedirectFor(`${WWW}\n`, APEX, 'GET', '/', ''), null, 'a smuggled Host is refused');
  assert.equal(apexRedirectFor(WWW, '', 'GET', '/', ''), null, 'no configured root, no guess');
  assert.equal(apexRedirectFor(WWW, undefined, 'GET', '/', ''), null);

  // Other methods and paths.
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    assert.equal(apexRedirectFor(WWW, APEX, method, '/', ''), null, `${method} keeps its body where it was sent`);
  }
  for (const path of ['/api', '/api/', '/api/auth/google', '/api/auth/capabilities', '/files/products/x.webp']) {
    assert.equal(apexRedirectFor(WWW, APEX, 'GET', path, ''), null, `${path} is not a document`);
  }
});

async function realWorker() {
  const raw = freshDb();
  const assetCalls: string[] = [];
  const env = {
    DB: asD1(raw),
    STORE_ROOT_DOMAIN: APEX,
    APP_ORIGIN: `https://${APEX}`,
    EXTRA_ALLOWED_ORIGINS: '',
    ASSETS: {
      fetch: async (req: Request) => {
        assetCalls.push(new URL(req.url).pathname);
        return new Response('<!doctype html><title>spa</title>', { headers: { 'content-type': 'text/html' } });
      },
    },
  };
  const call = (host: string, method: string, path: string) =>
    worker.fetch(
      new Request(`https://${host}${path}`, {
        method,
        redirect: 'manual',
        headers: { Host: host, 'CF-Connecting-IP': '9.9.9.9', 'content-type': 'application/json' },
        body: method === 'GET' || method === 'HEAD' ? undefined : '{}',
      }),
      env as never,
      ctx
    );
  return { call, assetCalls };
}

test('the real Worker answers a www document with a 301 to the apex, path and query kept', async () => {
  const { call, assetCalls } = await realWorker();
  for (const [path, to] of [
    ['/', `https://${APEX}/`],
    ['/product/p1?ref=share', `https://${APEX}/product/p1?ref=share`],
    ['/community/store/ali3d', `https://${APEX}/community/store/ali3d`],
    ['/robots.txt', `https://${APEX}/robots.txt`],
  ] as const) {
    const res = await call(WWW, 'GET', path);
    assert.equal(res.status, 301, `${path} → ${res.status}`);
    assert.equal(res.headers.get('Location'), to);
  }
  assert.deepEqual(assetCalls, [], 'a www document is never served, only moved');
});

test('the real Worker leaves the API on www working, and never moves the apex or a shop', async () => {
  const { call } = await realWorker();

  // A page already open on www keeps working until its next navigation.
  const caps = await call(WWW, 'GET', '/api/auth/capabilities');
  assert.notEqual(caps.status, 301);
  assert.equal(caps.headers.get('Location'), null);

  // A POST is never redirected: its body would be lost on the way.
  const post = await call(WWW, 'POST', '/');
  assert.notEqual(post.status, 301);

  for (const host of [APEX, MERCHANT_HOST]) {
    const res = await call(host, 'GET', '/');
    assert.notEqual(res.status, 301, `${host} must not be redirected`);
    assert.equal(res.headers.get('Location'), null);
  }
});

test('the server-side Google verification is unchanged by the fix', () => {
  // The fix is a host move. Signature, issuer, audience, expiry and a verified
  // e-mail are still all required (worker/lib/google.ts).
  const google = readFileSync(join(ROOT, 'worker/lib/google.ts'), 'utf8');
  for (const needle of ['RS256', 'accounts.google.com', 'email_verified', 'exp']) {
    assert.ok(google.includes(needle), `worker/lib/google.ts no longer checks ${needle}`);
  }
  assert.match(google, /aud/, 'the audience check is gone');
});
