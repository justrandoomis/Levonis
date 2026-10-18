/**
 * PLAIN HTTP IS NEVER SERVED — the sign-in fix of 2026-10-18.
 *
 * `http://levonis-iq.com` answered 200 with no upgrade, and three reported
 * symptoms shared that one cause: Google refuses the `http://` origin
 * (`origin_mismatch`), and the session cookie is `Secure`, so a browser on
 * http never stores it — the person signs in, and the next page shows a guest.
 *
 * Pinned here: the pure decision (worker/lib/hosts.ts `httpsUpgradeFor`), and
 * the real Worker entry — a GET over http is a 301 that still carries HSTS, a
 * password POSTed over http is refused before any route runs (no session row,
 * no Set-Cookie), and the same POST over https still signs in with the cookie
 * attributes unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APEX, MERCHANT_HOST, asD1, count, ctx, freshDb } from './fixtures/app';
import worker from '../worker/index';
import { httpsUpgradeFor, isLocalHostname } from '../worker/lib/hosts';
import { hashPassword } from '../worker/lib/crypto';

const WWW = `www.${APEX}`;

// ------------------------------------------------------------- the decision

test('a GET or HEAD over http moves to https on the same host', () => {
  assert.deepEqual(httpsUpgradeFor(`http://${APEX}/`, undefined, APEX, 'GET'), { redirect: `https://${APEX}/` });
  assert.deepEqual(httpsUpgradeFor(`http://${APEX}/auth?next=%2Fcart`, null, APEX, 'GET'), {
    redirect: `https://${APEX}/auth?next=%2Fcart`,
  });
  assert.deepEqual(httpsUpgradeFor(`http://${APEX}/product/p1`, undefined, APEX, 'HEAD'), {
    redirect: `https://${APEX}/product/p1`,
  });
  // A shop keeps its own host — only the scheme changes.
  assert.deepEqual(httpsUpgradeFor(`http://${MERCHANT_HOST}/p/x?y=1`, undefined, APEX, 'GET'), {
    redirect: `https://${MERCHANT_HOST}/p/x?y=1`,
  });
  // Lower-case method names are the same request.
  assert.deepEqual(httpsUpgradeFor(`http://${APEX}/`, undefined, APEX, 'get'), { redirect: `https://${APEX}/` });
});

test('www over http goes straight to the apex in one hop; the API on www keeps its host', () => {
  assert.deepEqual(httpsUpgradeFor(`http://${WWW}/auth`, undefined, APEX, 'GET'), { redirect: `https://${APEX}/auth` });
  assert.deepEqual(httpsUpgradeFor(`http://${WWW}/api/x`, undefined, APEX, 'GET'), { redirect: `https://${WWW}/api/x` });
  // Without a configured root there is no apex to name: the scheme alone moves.
  assert.deepEqual(httpsUpgradeFor(`http://${WWW}/auth`, undefined, null, 'GET'), { redirect: `https://${WWW}/auth` });
});

test('any other method over http is refused, never redirected (a redirect loses the body)', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    assert.equal(httpsUpgradeFor(`http://${APEX}/api/auth/login`, undefined, APEX, method), 'refuse', method);
  }
});

test('https, a CF-Visitor that saw https, and local hosts are left alone', () => {
  assert.equal(httpsUpgradeFor(`https://${APEX}/`, undefined, APEX, 'GET'), null);
  assert.equal(httpsUpgradeFor(`https://${APEX}/api/auth/login`, undefined, APEX, 'POST'), null);
  // Cloudflare's own view of the visitor wins: a redirect here could only loop.
  assert.equal(httpsUpgradeFor(`http://${APEX}/`, '{"scheme":"https"}', APEX, 'GET'), null);
  assert.equal(httpsUpgradeFor(`http://${APEX}/api/auth/login`, '{"scheme":"https"}', APEX, 'POST'), null);
  assert.equal(httpsUpgradeFor(`http://${APEX}/`, 'not json', APEX, 'GET'), null, 'an unreadable CF-Visitor never loops either');
  // …and a CF-Visitor that says http is the ordinary case.
  assert.deepEqual(httpsUpgradeFor(`http://${APEX}/`, '{"scheme":"http"}', APEX, 'GET'), { redirect: `https://${APEX}/` });
  for (const href of [
    'http://localhost/api/auth/login',
    'http://localhost:8787/',
    'http://app.localhost:5173/',
    'http://box.local/',
    'http://127.0.0.1:8787/',
    'http://192.168.1.4:4173/',
    'http://[::1]:3000/',
  ]) {
    assert.equal(httpsUpgradeFor(href, undefined, APEX, 'GET'), null, href);
    assert.equal(httpsUpgradeFor(href, undefined, APEX, 'POST'), null, `${href} POST`);
  }
  assert.equal(httpsUpgradeFor('not a url', undefined, APEX, 'GET'), null);
  assert.equal(isLocalHostname(APEX), false);
  assert.equal(isLocalHostname('localhost.evil.com'), false);
});

test('the documented subdomain recipe on levonis.test:8787 keeps working over plain http', () => {
  // docs/SUBDOMAIN_ARCHITECTURE.md: wrangler dev with STORE_ROOT_DOMAIN=levonis.test,
  // APP_ORIGIN=http://levonis.test:8787; scripts/e2e-subdomains.mjs signs in and
  // POSTs on the apex and a shop. A 403 on every POST — or a redirect to https
  // with the port dropped — would end that run.
  const ROOT = 'levonis.test';
  for (const href of ['http://levonis.test:8787/', 'http://levonis.test:8787/api/auth/login', 'http://myshop.levonis.test:8787/api/cart']) {
    for (const method of ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE']) {
      assert.equal(httpsUpgradeFor(href, undefined, ROOT, method), null, `${method} ${href}`);
    }
  }
  // The RFC 2606 names, and only them: a real domain that merely CONTAINS one is not local.
  for (const host of ['levonis.test', 'myshop.levonis.test', 'site.example', 'nowhere.invalid']) assert.equal(isLocalHostname(host), true, host);
  for (const host of ['test.levonis-iq.com', 'example.com', 'testshop.com', 'levonis-iq.com.evil', 'test', 'example']) {
    assert.equal(isLocalHostname(host), false, host);
  }
  assert.deepEqual(httpsUpgradeFor(`http://test.${APEX}/`, undefined, APEX, 'GET'), { redirect: `https://test.${APEX}/` });
});

// ------------------------------------------------------ through the real Worker

const PW = 'Str0ng-passw0rd';

async function realWorker() {
  const raw = freshDb();
  raw
    .prepare(
      `INSERT INTO users (id, name, email, username, password_hash, role, email_verified_at)
       VALUES ('usr_https', 'Https Person', 'https-person@example.com', 'httpsperson', ?, 'customer', ?)`
    )
    .run(await hashPassword(PW), new Date().toISOString());
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
  let ip = 0;
  const call = (href: string, method: string, body?: unknown, headers: Record<string, string> = {}) => {
    const url = new URL(href);
    return worker.fetch(
      new Request(href, {
        method,
        redirect: 'manual',
        headers: {
          Host: url.host,
          'CF-Connecting-IP': `9.9.9.${++ip}`,
          'content-type': 'application/json',
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env as never,
      ctx
    );
  };
  return { raw, call, assetCalls };
}

test('the real Worker answers an http document with a 301 to https, and the 301 still carries HSTS', async () => {
  const { call, assetCalls } = await realWorker();
  const res = await call(`http://${APEX}/`, 'GET');
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('Location'), `https://${APEX}/`);
  assert.match(res.headers.get('Strict-Transport-Security') ?? '', /max-age=\d+/);
  assert.equal(res.headers.get('Set-Cookie'), null);

  const www = await call(`http://${WWW}/auth?next=%2Fcart`, 'GET');
  assert.equal(www.status, 301);
  assert.equal(www.headers.get('Location'), `https://${APEX}/auth?next=%2Fcart`, 'www over http: one hop to the apex');
  assert.deepEqual(assetCalls, [], 'nothing is served over http, only moved');
});

test('a correct password POSTed over http is refused before any route: 403, no cookie, no session', async () => {
  const { raw, call } = await realWorker();
  const before = count(raw, 'SELECT COUNT(*) AS n FROM sessions');
  const res = await call(
    `http://${APEX}/api/auth/login`,
    'POST',
    { identifier: 'https-person@example.com', password: PW },
    { Origin: `http://${APEX}` }
  );
  assert.equal(res.status, 403);
  const body = (await res.json()) as { code?: string; success?: boolean };
  assert.equal(body.success, false);
  assert.equal(body.code, 'HTTPS_REQUIRED');
  assert.equal(res.headers.get('Set-Cookie'), null, 'no cookie is ever set over http');
  assert.match(res.headers.get('Strict-Transport-Security') ?? '', /max-age=\d+/, 'the refusal carries HSTS too');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM sessions'), before, 'no session row was created');
});

test('the same sign-in over https still works, with the cookie attributes unchanged', async () => {
  const { raw, call } = await realWorker();
  const before = count(raw, 'SELECT COUNT(*) AS n FROM sessions');
  const res = await call(
    `https://${APEX}/api/auth/login`,
    'POST',
    { identifier: 'https-person@example.com', password: PW },
    { Origin: `https://${APEX}` }
  );
  assert.equal(res.status, 200, await res.clone().text());
  const body = (await res.json()) as { user?: { id?: string } };
  assert.equal(body.user?.id, 'usr_https');
  const cookie = res.headers.get('Set-Cookie') ?? '';
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Secure/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, new RegExp(`Domain=\\.?${APEX.replace(/\./g, '\\.')}`, 'i'), 'shared with the shops, as before');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM sessions'), before + 1);
});
