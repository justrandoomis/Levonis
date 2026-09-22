/**
 * «الإحالة عند مشاركة المنتج مع مستخدم آخر لا تعمل»
 *
 * The share link was never the problem. `productSupportPath` builds
 * `/product/<slug>?ref=<handle>` correctly (tests/supportCode.test.ts pins
 * it), and the product page captures the ref on arrival. What was lost was
 * the trip through sign-in.
 *
 * A shared product page is opened by someone who does not have an account —
 * that is the point of sharing it. The first thing they do is tap add to
 * cart, or the heart, or «خبرني لما يرجع», and every one of those sent them
 * to a hand-built `/auth?next=/product/<slug>` with no `ref` on it. §3 keeps
 * two separate things behind that parameter, and that one URL broke both:
 *
 *   * THE SIGNUP INVITE. `referral_attributions` is bound exactly ONCE, at
 *     account creation, and /auth reads the inviter from `?ref=` and nowhere
 *     else. With the parameter dropped, the account the sharer had just
 *     brought in was recorded as having no inviter — and "once" means there
 *     is no later chance to fix it.
 *   * THE PURCHASE SUPPORT CODE. It survived only by luck: sessionStorage
 *     persists across a same-tab navigation. An email-first sign-up (#88)
 *     finishes in whatever tab the mail app opens, and there the storage —
 *     and the code — is gone.
 *
 * So `authPathWithSupportRef` sends the ref both ways: as `?ref=` for the
 * binding, and inside `next` so the return trip re-captures it into a session
 * that may be brand new.
 *
 * Everything below executes the REAL helper against a real store object, and
 * the last test reads the call sites — because a helper nobody calls fixes
 * nothing, and the five hand-built URLs on the product page are exactly how
 * this broke.
 *
 * Run: npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  authPathWithSupportRef,
  captureSupportRef,
  removeSupportRef,
  type RefStore,
} from '../src/lib/supportRef';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A sessionStorage stand-in. The helpers take one explicitly for this reason. */
function store(): RefStore {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

const NOW = 1_800_000_000_000;

test('with nothing captured it is byte-identical to the URL it replaces', () => {
  assert.equal(
    authPathWithSupportRef('/product/bambu-a1', { store: store(), now: NOW }),
    `/auth?next=${encodeURIComponent('/product/bambu-a1')}`,
    'no ref, no change — this is what makes it safe to use at every call site'
  );
});

test('a captured ref rides BOTH ways', () => {
  const s = store();
  captureSupportRef('Ammar', { store: s, now: NOW, product: '/product/bambu-a1' });
  const url = authPathWithSupportRef('/product/bambu-a1', { store: s, now: NOW });
  const q = new URLSearchParams(url.slice(url.indexOf('?') + 1));
  assert.equal(q.get('ref'), 'ammar', 'the signup binding reads THIS, and binds exactly once');
  assert.equal(
    q.get('next'),
    '/product/bambu-a1?ref=ammar',
    'and the return trip re-captures it, so an email-first sign-up in a new tab still has it'
  );
});

test('the ref does not destroy a next that already has a query string', () => {
  const s = store();
  captureSupportRef('ammar', { store: s, now: NOW });
  const url = authPathWithSupportRef('/product/bambu-a1?alert=m1', { store: s, now: NOW });
  const next = new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('next');
  assert.equal(next, '/product/bambu-a1?alert=m1&ref=ammar', 'appended, not overwritten');
});

test('a REMOVED code is not resurrected by a sign-in', () => {
  /**
   * §3.3: "removing the support code is respected; do not re-add it from a
   * cookie on every render." Reading the captured STATE rather than the
   * current URL is what gives this for free — the state is where the
   * dismissal lives.
   */
  const s = store();
  captureSupportRef('ammar', { store: s, now: NOW });
  removeSupportRef({ store: s, now: NOW });
  assert.equal(
    authPathWithSupportRef('/product/bambu-a1', { store: s, now: NOW }),
    `/auth?next=${encodeURIComponent('/product/bambu-a1')}`
  );
});

test('an expired capture is not sent either', () => {
  const s = store();
  captureSupportRef('ammar', { store: s, now: NOW });
  const later = NOW + 13 * 60 * 60 * 1000; // past SUPPORT_REF_TTL_MS
  assert.equal(
    authPathWithSupportRef('/product/bambu-a1', { store: s, now: later }),
    `/auth?next=${encodeURIComponent('/product/bambu-a1')}`,
    'the announced 12-hour bound applies here like everywhere else'
  );
});

test('an unresolved CONFLICT sends nothing — the cart still asks', () => {
  const s = store();
  captureSupportRef('ammar', { store: s, now: NOW });
  captureSupportRef('sara', { store: s, now: NOW });
  const url = authPathWithSupportRef('/product/bambu-a1', { store: s, now: NOW });
  const q = new URLSearchParams(url.slice(url.indexOf('?') + 1));
  assert.equal(q.get('ref'), 'ammar', 'the standing code, never the challenger');
  assert.ok(!url.includes('sara'), 'a second link does not become the inviter by arriving during sign-in');
});

test('a hostile `next` cannot be turned into an open redirect', () => {
  const s = store();
  captureSupportRef('ammar', { store: s, now: NOW });
  for (const bad of ['//evil.example', 'https://evil.example/x', 'javascript:alert(1)']) {
    const url = authPathWithSupportRef(bad, { store: s, now: NOW });
    const next = new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('next');
    assert.equal(next, '/?ref=ammar', `"${bad}" falls back to the site root`);
  }
});

test('no purchase-path screen hand-builds the auth URL any more', () => {
  /**
   * The fix is only real at the CALL SITES. The product page alone had five
   * copies of `/auth?next=${encodeURIComponent(...)}`, and each of them was a
   * separate way to lose the referral.
   */
  const sites = [
    'src/pages/Product.tsx',
    'src/pages/BundleDetail.tsx',
    'src/components/product/StockAlertPanel.tsx',
    'src/components/BottomNav.tsx',
    'src/components/ui/AsyncStates.tsx',
  ];
  for (const rel of sites) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.ok(src.includes('authPathWithSupportRef('), `${rel} routes sign-in through the helper`);
    assert.ok(
      !/`\/auth\?next=\$\{encodeURIComponent/.test(src),
      `${rel} still hand-builds an /auth URL, which is how the ref was dropped`
    );
  }
});

test('the product page still CAPTURES on arrival — the other half of the round trip', () => {
  const src = readFileSync(join(ROOT, 'src/pages/Product.tsx'), 'utf8');
  assert.ok(src.includes('captureSupportRefFromSearch(location.search'), 'a returning visitor re-captures');
  assert.ok(src.includes("location.search.indexOf('ref=')"), 'and only when there is something to capture');
});
