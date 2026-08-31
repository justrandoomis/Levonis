/**
 * Host classification and cookie scope — the boundary wildcard subdomains create.
 *
 * Once `*.levonis-iq.com` reaches this Worker and the session cookie is scoped
 * to `.levonis-iq.com`, a page on `evil.levonis-iq.com` is SAME-ORIGIN with
 * `evil.levonis-iq.com/api/…`, which is the same Worker holding the same
 * session. `originCheck` cannot catch that — the origin really does match. So
 * these functions are the boundary, and the interesting cases are all the
 * ones an attacker picks: a spoofed Host, a nested label, a system name, a
 * slug that renders as something else in the address bar.
 *
 * The cookie half matters just as much in the boring direction: a Domain a
 * browser rejects does not raise an error, it silently drops the cookie, and
 * that reads as "login is broken" for the whole of staging.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyHost,
  normalizeHost,
  isValidSlugSyntax,
  isSystemSlug,
  sessionCookieDomain,
  rootDomainFrom,
  storeUrl,
  SYSTEM_SUBDOMAINS,
} from '../worker/lib/hosts';

const ROOT = 'levonis-iq.com';

// ------------------------------------------------------------- normalisation

test('a Host header is normalised, or refused — never parsed generously', () => {
  assert.equal(normalizeHost('LEVONIS-IQ.COM'), 'levonis-iq.com');
  assert.equal(normalizeHost('  ali3d.levonis-iq.com  '), 'ali3d.levonis-iq.com');
  assert.equal(normalizeHost('levonis-iq.com.'), 'levonis-iq.com', 'a legal FQDN trailing dot');
  assert.equal(normalizeHost('localhost:8787'), 'localhost');
  assert.equal(normalizeHost('ali3d.levonis-iq.com:443'), 'ali3d.levonis-iq.com');

  // Everything below is a Host an attacker can send.
  for (const bad of [
    '',
    '   ',
    'evil.com/levonis-iq.com',       // path smuggled into the authority
    'a b.levonis-iq.com',            // whitespace
    'user@levonis-iq.com',           // userinfo
    'levonis-iq.com:notaport',
    'levonis-iq.com:1:2',
    '.levonis-iq.com',               // empty leading label
    'a..levonis-iq.com',             // empty middle label
    '-bad.levonis-iq.com',           // label starts with a hyphen
    'bad-.levonis-iq.com',           // label ends with a hyphen
    'ali3d.levonis-iq.com\n',        // header injection attempt
    'ali_3d.levonis-iq.com',         // underscore is not a DNS label char
    'x'.repeat(64) + '.levonis-iq.com', // label over 63 chars
  ]) {
    assert.equal(normalizeHost(bad), null, `normalizeHost accepted ${JSON.stringify(bad)}`);
  }
});

// ------------------------------------------------------------ classification

test('the apex and www are the main site', () => {
  assert.equal(classifyHost('levonis-iq.com', ROOT).kind, 'main');
  assert.equal(classifyHost('www.levonis-iq.com', ROOT).kind, 'main');
  assert.equal(classifyHost('LEVONIS-IQ.COM', ROOT).kind, 'main');
});

test('a merchant subdomain resolves to a slug', () => {
  const h = classifyHost('ali3d.levonis-iq.com', ROOT);
  assert.equal(h.kind, 'merchant');
  assert.equal(h.slug, 'ali3d');
  assert.equal(h.host, 'ali3d.levonis-iq.com');
});

test('every system subdomain is classified as system, never as a merchant', () => {
  // This is the check that runs BEFORE any database lookup, so a deleted row
  // in reserved_slugs cannot hand a merchant a live service (§7).
  for (const s of SYSTEM_SUBDOMAINS) {
    const h = classifyHost(`${s}.${ROOT}`, ROOT);
    assert.notEqual(h.kind, 'merchant', `"${s}" was treated as a merchant slug`);
    assert.equal(h.slug, null);
  }
  // The two that are live products right now: handing either to a merchant
  // takes down a running service.
  assert.equal(classifyHost('studio.levonis-iq.com', ROOT).kind, 'system');
  assert.equal(classifyHost('mail.levonis-iq.com', ROOT).kind, 'system');
});

test('a host outside the root domain is foreign, and never a merchant', () => {
  for (const bad of [
    'levonis-iq.com.evil.com',      // the classic suffix trick
    'evil-levonis-iq.com',          // no dot separator
    'notlevonis-iq.com',
    'levonis-iq.co',
    'ali3d.levonis-iq.com.evil.com',
    'example.com',
  ]) {
    const h = classifyHost(bad, ROOT);
    assert.equal(h.kind, 'foreign', `${bad} was classified ${h.kind}`);
    assert.equal(h.slug, null);
  }
});

test('only one label deep counts as a merchant', () => {
  // A wildcard certificate covers one level. Deeper names are where cookie
  // and certificate scoping mistakes get exploited.
  assert.equal(classifyHost('a.b.levonis-iq.com', ROOT).kind, 'foreign');
  assert.equal(classifyHost('admin.ali3d.levonis-iq.com', ROOT).kind, 'foreign');
});

test('with no configured root domain nothing is a merchant', () => {
  // The platform refuses to guess which domain it is rather than trusting the
  // Host header to tell it.
  for (const root of [null, undefined, '']) {
    assert.equal(classifyHost('ali3d.levonis-iq.com', root).kind, 'foreign');
  }
});

// -------------------------------------------------------------------- slugs

test('slug syntax admits real names and refuses dangerous ones', () => {
  for (const good of ['ali3d', 'ali-3d', 'abc', 'a1b2c3', 'x'.repeat(32)]) {
    assert.equal(isValidSlugSyntax(good), true, `rejected a valid slug: ${good}`);
  }
  for (const bad of [
    '', 'ab',                    // under the minimum
    'x'.repeat(33),              // over the maximum
    '-ali3d', 'ali3d-',          // leading/trailing hyphen: not a DNS label
    'Ali3D',                     // uppercase — the host is lowercased, a slug is not
    'ali_3d', 'ali.3d', 'ali 3d', 'ali/3d', 'ali:3d',
    'xn--80ak6aa92e',            // punycode: renders as another script entirely
    'ali--3d',                   // double hyphen, which is how xn-- is smuggled
  ]) {
    assert.equal(isValidSlugSyntax(bad), false, `accepted a dangerous slug: ${bad}`);
  }
});

test('system names are reserved at the code level, not only in the database', () => {
  assert.equal(isSystemSlug('studio'), true);
  assert.equal(isSystemSlug('admin'), true);
  assert.equal(isSystemSlug('api'), true);
  assert.equal(isSystemSlug('ali3d'), false);
});

// ------------------------------------------------------------------ cookies

test('production shares one cookie across the apex and every storefront', () => {
  assert.equal(sessionCookieDomain('levonis-iq.com', ROOT), '.levonis-iq.com');
  assert.equal(sessionCookieDomain('www.levonis-iq.com', ROOT), '.levonis-iq.com');
  assert.equal(sessionCookieDomain('ali3d.levonis-iq.com', ROOT), '.levonis-iq.com');
});

test('development and staging get a host-only cookie instead of a dropped one', () => {
  // A browser silently DISCARDS Set-Cookie with a Domain it will not accept.
  // There is no error; sign-in simply never sticks. Both of these must return
  // null so the cookie is host-only and actually works.
  assert.equal(sessionCookieDomain('localhost', 'localhost'), null, 'localhost has no dot');
  assert.equal(sessionCookieDomain('127.0.0.1:8787', 'localhost'), null);
  assert.equal(
    sessionCookieDomain('levonis-staging.someone.workers.dev', 'workers.dev'),
    null,
    'workers.dev is a public suffix — a cookie there would be offered to every other tenant'
  );
  assert.equal(sessionCookieDomain('x.pages.dev', 'pages.dev'), null);
});

test('a foreign host never receives a cookie scoped to the platform domain', () => {
  assert.equal(sessionCookieDomain('evil.com', ROOT), null);
  assert.equal(sessionCookieDomain('levonis-iq.com.evil.com', ROOT), null);
  assert.equal(sessionCookieDomain(null, ROOT), null);
  assert.equal(sessionCookieDomain('levonis-iq.com', null), null);
});

// ------------------------------------------------------------- configuration

test('the root domain comes from configuration, never from the request', () => {
  assert.equal(rootDomainFrom({ STORE_ROOT_DOMAIN: 'levonis-iq.com' }), 'levonis-iq.com');
  assert.equal(rootDomainFrom({ APP_ORIGIN: 'https://levonis-iq.com' }), 'levonis-iq.com');
  assert.equal(
    rootDomainFrom({ STORE_ROOT_DOMAIN: 'levonis-iq.com', APP_ORIGIN: 'https://other.com' }),
    'levonis-iq.com',
    'the explicit setting wins'
  );
  assert.equal(rootDomainFrom({}), null);
  assert.equal(rootDomainFrom({ APP_ORIGIN: 'not a url' }), null);
});

test('a storefront URL falls back to the in-app route when wildcard DNS is not configured', () => {
  assert.equal(storeUrl('ali3d', ROOT, 'store_1'), 'https://ali3d.levonis-iq.com');
  assert.equal(storeUrl('ali3d', null, 'store_1'), '/community/store/store_1');
  // Defence in depth: even if a bad slug reached the database, it never
  // becomes a link to a system host.
  assert.equal(storeUrl('studio', ROOT, 'store_1'), '/community/store/store_1');
  assert.equal(storeUrl('bad slug', ROOT, 'store_1'), '/community/store/store_1');
});
