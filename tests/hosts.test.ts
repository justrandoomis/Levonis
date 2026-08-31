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
  adminAllowedOn,
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

// ------------------------------------------- who may reach platform admin

/**
 * `adminAllowedOn` replaced a bare `kind === 'main'`, and the reason is worth
 * keeping in the test names: the old check turned a mistyped APP_ORIGIN into
 * a total admin outage. When no root domain matches the host it is served on,
 * EVERY host classifies as `foreign` — the apex included — and the whole
 * admin API answered 404 on the real site.
 *
 * The rule is about the relationship to the root domain, not the label.
 */
test('admin is allowed on the apex and on www', () => {
  const R = 'levonis-iq.com';
  assert.equal(adminAllowedOn(classifyHost('levonis-iq.com', R)), true);
  assert.equal(adminAllowedOn(classifyHost('www.levonis-iq.com', R)), true);
});

test('admin is REFUSED on a merchant storefront — the whole point', () => {
  const R = 'levonis-iq.com';
  assert.equal(adminAllowedOn(classifyHost('ali3d.levonis-iq.com', R)), false);
  assert.equal(adminAllowedOn(classifyHost('evil.levonis-iq.com', R)), false);
});

test('admin is REFUSED on a system host', () => {
  const R = 'levonis-iq.com';
  assert.equal(adminAllowedOn(classifyHost('studio.levonis-iq.com', R)), false);
  assert.equal(adminAllowedOn(classifyHost('mail.levonis-iq.com', R)), false);
});

test('admin is REFUSED on a deeper name under the root, which is foreign but adjacent', () => {
  const R = 'levonis-iq.com';
  const info = classifyHost('a.b.levonis-iq.com', R);
  assert.equal(info.kind, 'foreign');
  assert.equal(info.underRoot, true);
  // A universal certificate covers one level. Deeper names are where cookie
  // and certificate scoping mistakes get exploited, so they are not admin.
  assert.equal(adminAllowedOn(info), false);
  assert.equal(adminAllowedOn(classifyHost('x.ali3d.levonis-iq.com', R)), false);
});

test('admin IS allowed outside the root domain — that is the operator, not a merchant', () => {
  const R = 'levonis-iq.com';
  for (const host of ['levonis-staging.someone.workers.dev', 'localhost:8787', '127.0.0.1']) {
    const info = classifyHost(host, R);
    assert.equal(info.underRoot, false, host);
    assert.equal(adminAllowedOn(info), true, host);
  }
});

test('a misconfigured root domain does not take the admin API down', () => {
  // THE REGRESSION. With no root domain — or one that does not match the host
  // the site is actually served on — every host is `foreign`, and the old
  // guard refused the apex along with everything else.
  for (const root of [null, undefined, '', 'levonis-staging.workers.dev']) {
    const info = classifyHost('levonis-iq.com', root);
    assert.equal(info.kind, 'foreign');
    assert.equal(info.underRoot, false);
    assert.equal(adminAllowedOn(info), true, `root=${String(root)}`);
  }
});

test('a spoofed Host that is not under the root cannot become a merchant', () => {
  const R = 'levonis-iq.com';
  const info = classifyHost('ali3d.levonis-iq.com.evil.example', R);
  assert.equal(info.kind, 'foreign');
  assert.equal(info.underRoot, false);
  assert.equal(info.slug, null);
});

test('a host that cannot be parsed at all is never admin-adjacent by accident', () => {
  const R = 'levonis-iq.com';
  // An unparseable Host yields host: '' and underRoot false. It reaches no
  // merchant and no store; whether admin is served there is decided by
  // whether the caller is an admin, as everywhere else.
  const info = classifyHost('has a space', R);
  assert.equal(info.kind, 'foreign');
  assert.equal(info.host, '');
});

// -------------------------------------- the reserved list, name by name
//
// The wildcard is live. `*.levonis-iq.com` now reaches this Worker, so this
// list is no longer a precaution — it is the only thing standing between a
// merchant slug and a name that already means something on this domain.

test('the four names that are running services today are never a merchant', () => {
  // studio → LEVO Studio. mail + send → outbound email. www → the site.
  // Handing any of these to a merchant takes a live product down; `send`
  // additionally breaks deliverability for every address on the domain.
  for (const name of ['studio', 'mail', 'send', 'www']) {
    const h = classifyHost(`${name}.${ROOT}`, ROOT);
    assert.notEqual(h.kind, 'merchant', `${name}. was handed to a merchant`);
    assert.equal(h.slug, null, `${name}. produced a slug`);
    assert.equal(h.underRoot, true);
  }
  // www is the site itself; the other three are system hosts.
  assert.equal(classifyHost(`www.${ROOT}`, ROOT).kind, 'main');
  for (const name of ['studio', 'mail', 'send']) {
    assert.equal(classifyHost(`${name}.${ROOT}`, ROOT).kind, 'system', name);
  }
});

test('the reserved list survives the shapes a Host header actually arrives in', () => {
  // Uppercase, a trailing FQDN dot, a port — all legal, all normalised
  // before classification. A reserved name that only matched the tidy form
  // would be no protection at all.
  for (const raw of ['STUDIO.levonis-iq.com', 'Send.LEVONIS-IQ.com.', 'mail.levonis-iq.com:443']) {
    assert.equal(classifyHost(raw, ROOT).kind, 'system', raw);
  }
});

test('no name appears twice, because a Set would hide the mistake', async () => {
  // Two entries for one name is a symptom — usually a name added to the
  // wrong group by someone who did not find the one already there. `new Set`
  // swallows it silently, so the source is what gets checked.
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { ROOT: REPO } = await import('./fixtures/d1');
  const src = readFileSync(join(REPO, 'worker/lib/hosts.ts'), 'utf8');
  const block = src.slice(src.indexOf('SYSTEM_SUBDOMAINS'), src.indexOf('/** Slug syntax.'));
  const names = [...block.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
  assert.equal(names.length, SYSTEM_SUBDOMAINS.size, 'the literal and the Set disagree on size');
  const seen = new Set<string>();
  const dupes = names.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
  assert.deepEqual(dupes, [], `duplicated in the literal: ${dupes.join(', ')}`);
});

test('every reserved name is stored in the form a hostname label arrives in', () => {
  // A stray capital, space or dot makes an entry unreachable: the prefix
  // being tested is already lowercase and cannot contain a dot. Such an
  // entry looks like protection in a code review and provides none.
  for (const s of SYSTEM_SUBDOMAINS) {
    assert.equal(s, s.toLowerCase().trim(), `"${s}" is not normalised`);
    assert.equal(s.includes('.'), false, `"${s}" contains a dot and can never match a label`);
    assert.match(s, /^[a-z0-9][a-z0-9-]*$/, `"${s}" is not a DNS label`);
  }
});

test('reservation is what refuses these names — not slug syntax', () => {
  // A name refused only because it is too short or oddly shaped would come
  // back the moment the syntax rules loosened. Every entry that IS
  // slug-shaped must be refused by the list itself.
  for (const s of SYSTEM_SUBDOMAINS) {
    if (s === 'www') continue; // www is the main site, handled before the list
    if (!isValidSlugSyntax(s)) continue; // too short to be a slug anyway
    assert.equal(isSystemSlug(s), true, `"${s}" is slug-shaped and not reserved`);
    assert.equal(classifyHost(`${s}.${ROOT}`, ROOT).kind, 'system', s);
  }
});

test('the phishing names are reserved for who could ask for them, not for us', () => {
  // These are the ones worth naming explicitly. A merchant controls their
  // storefront's content, so a merchant holding `login.levonis-iq.com` gets a
  // valid certificate on the real brand's domain and writes the page that
  // this platform's own customers are looking at.
  for (const name of ['login', 'signin', 'verify', 'reset', 'password', 'secure', 'account', 'wallet', 'checkout']) {
    assert.equal(classifyHost(`${name}.${ROOT}`, ROOT).kind, 'system', name);
  }
});

test('a reserved name buried deeper is foreign, not system', () => {
  // `send.ali3d.levonis-iq.com` is two labels deep. It is refused for being
  // deep, and must not be reported as a system host — a caller that trusted
  // `kind === 'system'` to mean "our service" would be wrong about it.
  const h = classifyHost(`send.ali3d.${ROOT}`, ROOT);
  assert.equal(h.kind, 'foreign');
  assert.equal(h.system, null);
  assert.equal(h.underRoot, true); // still adjacent to merchant content
  assert.equal(adminAllowedOn(h), false);
});

test('no system host may serve platform admin, whatever the name', () => {
  for (const s of SYSTEM_SUBDOMAINS) {
    if (s === 'www') continue; // www IS the main site
    assert.equal(adminAllowedOn(classifyHost(`${s}.${ROOT}`, ROOT)), false, s);
  }
});
