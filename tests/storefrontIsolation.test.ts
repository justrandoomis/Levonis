/**
 * Rules the storefront must not quietly lose.
 *
 * These are source guards, not renders. They exist because each rule below
 * was a deliberate decision that a later "tidy-up" could reverse without
 * anything visibly breaking — a merchant-supplied colour reaching the
 * stylesheet, a hostname parsed in the browser, admin routes served on a
 * merchant host. Every one of those is silent until it is exploited.
 *
 * The repo already uses this idiom (tests/store-isolation.test.ts), so the
 * shape is familiar: read the file, strip comments so prose about a rule is
 * never mistaken for the rule, then assert on the code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** Code with comments removed — prose describing a rule is not the rule. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// ------------------------------------------------- the apex-only admin guard

test('platform admin is refused on every host a merchant could control', () => {
  // THE guard that makes wildcard subdomains survivable. Without it, a page
  // on evil.levonis-iq.com is same-origin with evil.levonis-iq.com/api/admin
  // and carries a visiting admin's own session.
  //
  // The DECISION lives in hosts.ts (`adminAllowedOn`) and is tested against
  // real hostnames in tests/hosts.test.ts. The MIDDLEWARE that asks it is
  // `requireMainHost` in lib/http.ts, shared with the credential routes below.
  // This asserts that /api/admin/* is mounted behind it, and that it still
  // consults adminAllowedOn and still answers 404 — a later refactor that
  // inlined a different condition is exactly what this catches.
  const index = code(read('worker/index.ts'));
  assert.match(
    index,
    /app\.use\(\s*['"]\/api\/admin\/\*['"]\s*,\s*requireMainHost\s*\)/,
    'no host guard is mounted on /api/admin/*'
  );
  const http = code(read('worker/lib/http.ts'));
  const guard = /export async function requireMainHost[\s\S]{0,400}?\n\}/.exec(http)?.[0] ?? '';
  assert.match(guard, /adminAllowedOn\(\s*c\.get\(\s*['"]host['"]\s*\)\s*\)/,
    'the guard does not consult adminAllowedOn');
  assert.match(guard, /404/, 'a wrong-host caller should get 404, not a 403 that confirms the route exists');
});

test('changing a signed-in account\'s credentials is apex-only, behind the same guard', () => {
  // The session cookie is scoped to the parent domain, so a merchant host
  // carries the visitor's session; nothing a storefront does needs to change
  // a password, an email or a linked Google account. Same guard as admin.
  const auth = code(read('worker/routes/auth.ts'));
  for (const route of ['/change-password', '/change-email', '/google/link']) {
    const re = new RegExp("authRoutes\\.post\\(\\s*'" + route.replace('/', '\\/') + "'\\s*,\\s*requireMainHost\\s*,");
    assert.match(auth, re, route + ' is not behind requireMainHost');
  }
  // Sign-in itself must keep working on a storefront (/auth is a storefront route).
  assert.doesNotMatch(auth, /authRoutes\.post\(\s*'\/login'\s*,\s*requireMainHost/, '/login must stay reachable on every host');
});

test('the community admin API is mounted under /api/admin so the guard covers it', () => {
  const index = code(read('worker/index.ts'));
  assert.match(
    index,
    /app\.route\(\s*['"]\/api\/admin\/community['"]\s*,\s*adminCommunityRoutes\s*\)/,
    'adminCommunity must sit under /api/admin or it is reachable from a merchant storefront'
  );
});

test('merchant administration is NOT under /api/admin', () => {
  // A merchant managing their own shop must not travel through the platform
  // admin surface — different authority, different guard, different name.
  const index = code(read('worker/index.ts'));
  assert.match(index, /app\.route\(\s*['"]\/api\/merchant['"]/, 'merchant routes are not mounted');
  assert.equal(
    /['"]\/api\/admin\/merchant/.test(index),
    false,
    'merchant routes must not be mounted under the platform admin prefix'
  );
});

// ------------------------------------------------------ host resolution

test('the browser never decides which store a hostname is', () => {
  // Only the server knows which slugs exist, and only the server classifies
  // system hosts. A second answer in the browser is a second answer that can
  // disagree.
  const ctx = code(read('src/StoreContext.tsx'));
  assert.match(ctx, /storefrontApi\s*\n?\s*\.resolve\(\)/, 'StoreContext must ask the server');
  assert.equal(
    /location\.hostname|window\.location\.host\b/.test(ctx),
    false,
    'StoreContext parses the hostname in the browser instead of asking the server'
  );
});

test('a merchant host renders the storefront, not the main site with a shop inside it', () => {
  const app = code(read('src/App.tsx'));
  assert.match(app, /function StorefrontApp\(/, 'no storefront application branch exists');
  // The branch must come before the main site renders, or a visitor sees the
  // wrong brand flash first.
  // A store host that resolves to a SUSPENDED store is still a store host: it
  // renders «المتجر غير متاح حاليًا», never the main site (owner, 2026-09-24).
  const branch = app.indexOf('if (store || unknownStore || unavailableStore) return <StorefrontApp />');
  const header = app.indexOf('<Header />');
  assert.ok(branch > 0, 'the storefront branch is missing from AppContent');
  assert.ok(branch < header, 'the storefront branch must be decided before the main site chrome renders');
});

// ------------------------------------------------------ merchant styling

test('a merchant can never put a colour, style or raw HTML on their page', () => {
  const src = read('src/pages/Storefront.tsx');
  const c = code(src);

  // The accent is a NAME looked up in a table defined here. If a merchant's
  // string could reach a style attribute or a class string directly, they
  // could paint over the platform — or worse, break out of the container.
  assert.match(c, /const ACCENTS: Record<string,/, 'the accent preset table is gone');
  assert.match(c, /ACCENTS\[store\?\.accent \?\? 'default'\] \?\? ACCENTS\.default/, 'unknown accents must fall back');

  assert.equal(
    /dangerouslySetInnerHTML/.test(c),
    false,
    'the storefront renders raw HTML somewhere — a merchant field could carry a script'
  );
  // The one inline style is a computed width for the rating bars, which is a
  // number this file derives. A merchant string must never appear in one.
  const inlineStyles = c.match(/style=\{\{[^}]*\}\}/g) ?? [];
  for (const s of inlineStyles) {
    assert.equal(
      /store\.|product\.|merchant\./.test(s),
      false,
      `a merchant-supplied value reaches an inline style: ${s}`
    );
  }
});

test('outbound merchant links cannot hand the new tab a handle on the page', () => {
  const c = code(read('src/pages/Storefront.tsx'));
  // Every target=_blank anchor needs noopener; without it the opened page
  // gets window.opener back onto the storefront.
  const anchors = c.match(/<a[\s\S]{0,400}?>/g) ?? [];
  for (const a of anchors) {
    if (!/target=["']_blank["']/.test(a)) continue;
    const rel = /\brel=["']([^"']*)["']/.exec(a)?.[1] ?? '';
    const tokens = new Set(rel.split(/\s+/).filter(Boolean));
    assert.ok(tokens.has('noopener'), `a _blank link without noopener: ${a.slice(0, 120)}`);
    assert.ok(tokens.has('noreferrer'), `a _blank link without noreferrer: ${a.slice(0, 120)}`);
  }
});

// ------------------------------------------------- entitlements stay server-side

test('the frontend never decides who may sell', () => {
  // Every capability flag must come from /api/merchant/me. A page that reads
  // a tier string and draws its own conclusion is a page the browser can lie
  // to.
  for (const f of [
    'src/pages/MerchantStart.tsx',
    'src/pages/MerchantDashboardPage.tsx',
    'src/components/merchant/StoreCta.tsx',
  ]) {
    const c = code(read(f));
    assert.equal(
      /membership_tier\s*===|subscription_plan\s*===/.test(c),
      false,
      `${f} decides eligibility from a tier string instead of asking the server`
    );
  }
  assert.match(code(read('src/pages/MerchantStart.tsx')), /me\?\.eligible/, 'onboarding must gate on the server answer');
});

test('a restriction is always explained, never a silently missing control', () => {
  // §84: a merchant whose capability was paused should be told which and why.
  const cta = code(read('src/components/merchant/StoreCta.tsx'));
  assert.match(cta, /function reasonText\(/, 'no reason text exists for a restricted store');
  for (const reason of ['subscription_inactive', 'store_paused', 'store_suspended', 'benefit_restricted']) {
    assert.match(cta, new RegExp(`case '${reason}'`), `no message for the "${reason}" state`);
  }
});

// ------------------------------------------------------ honest empty states

test('an average over zero orders reports no data, not zero', () => {
  // A dashboard that shows "0 IQD average order" to a new merchant is stating
  // something false about their business.
  const c = code(read('worker/routes/merchant.ts'));
  assert.match(
    c,
    /average_order_iqd:\s*orderCount\s*\?/,
    'the average order value is not guarded against a zero denominator'
  );
});

test('the storefront shows availability, never the exact stock count', () => {
  // A competitor should not be able to read a shop's inventory levels off its
  // public pages.
  const c = code(read('worker/routes/storefront.ts'));
  assert.match(c, /in_stock:/, 'the public product shape should expose in_stock');
  assert.equal(
    /^\s*stock:\s*p\.stock/m.test(c),
    false,
    'the public product shape leaks the raw stock count'
  );
});

// ------------------------------------------ the shadowing route collision

/**
 * `/api/admin` is mounted before `/api/admin/community`, so a `/community/*`
 * route declared in admin.ts wins over the dedicated module — silently, with
 * a different response shape and different rules.
 *
 * That is not hypothetical. Four such routes existed, and the first of them
 * answered the community admin board for as long as it took someone to read
 * a response field by field. The old `GET /community/requests` returned rows
 * with `email`/`username` where the module returns `customer_email`, so the
 * board rendered but the customer column was blank.
 *
 * Hono matches the first registration. A collision like this cannot be seen
 * in either file alone, which is why it is asserted here.
 */
test('community admin lives in ONE module — admin.ts declares no /community route', () => {
  const admin = code(read('worker/routes/admin.ts'));
  const offenders = [...admin.matchAll(/adminRoutes\.(get|post|patch|delete|put)\(\s*['"](\/community[^'"]*)['"]/g)]
    .map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  assert.deepEqual(
    offenders,
    [],
    `these shadow /api/admin/community because /api/admin is mounted first: ${offenders.join(', ')}`
  );
});

test('and the dedicated module is the one mounted there', () => {
  const index = code(read('worker/index.ts'));
  assert.match(
    index,
    /app\.route\(\s*['"]\/api\/admin\/community['"]\s*,\s*adminCommunityRoutes\s*\)/,
    'the community admin module is not mounted at /api/admin/community'
  );
});

test('nothing in the community module DELETES a product row', () => {
  // Removing the row blanks out what a customer actually bought. The rule is
  // archive-when-ordered (MERCHANT_STORES.md §5), and the route that used to
  // break it lived in admin.ts.
  const mod = code(read('worker/routes/adminCommunity.ts'));
  assert.equal(
    /DELETE\s+FROM\s+community_products/i.test(mod),
    false,
    'the community admin module deletes a product row instead of archiving it'
  );
});
