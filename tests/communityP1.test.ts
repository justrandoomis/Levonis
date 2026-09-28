/**
 * LEVO COMMUNITY — the first-priority fixes (review of Levo Community,
 * 2026-09-28).
 *
 *   C1   the floating nav steps aside for a store's product page (its own buy
 *        bar) and for a full-screen flow (the request wizard's bar);
 *   C4   every request state reads as words — «طلباتي» printed the machine
 *        word for three of them;
 *   C12  nobody follows their own store, and a suspended store takes no new
 *        followers — through both follow routes;
 *   C2/C9/C10/C11/C13/C14  pinned in the sources (their flows run in the
 *        browser sweeps).
 *
 * Run: node --import tsx --test tests/communityP1.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb, asD1, stubApp, post, json, count, type StubUser } from './fixtures/app';
import { communityRoutes } from '../worker/routes/community';
import { communityReviewRoutes } from '../worker/routes/merchantReviews';
import { isBottomNavHidden } from '../src/components/BottomNav';
import { isBottomNavSuppressed, suppressBottomNav } from '../src/lib/bottomNavSuppress';
import { requestStateLabel, REQUEST_STATE_TONE } from '../src/components/community/requests/requestStates';

const ROOT = join(import.meta.dirname, '..');
const code = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ------------------------------------------------------------ C1

test('C1: the nav steps aside on a store product page on the main site, and nowhere else new', () => {
  assert.equal(isBottomNavHidden('/community/store/m1/p/dragon'), true);
  assert.equal(isBottomNavHidden('/community/store/raf3d/p/raf3d-p1'), true);
  assert.equal(isBottomNavHidden('/community/store/m1'), false, 'the store page itself keeps the nav');
  assert.equal(isBottomNavHidden('/community'), false);
  assert.equal(isBottomNavHidden('/requests'), false);
});

test('C1: a full-screen flow hides the nav while it is open — counted, released once', () => {
  assert.equal(isBottomNavSuppressed(), false);
  const a = suppressBottomNav();
  const b = suppressBottomNav();
  assert.equal(isBottomNavSuppressed(), true);
  a();
  a();
  assert.equal(isBottomNavSuppressed(), true, 'a second release of the same flow does nothing; the other flow is still open');
  b();
  assert.equal(isBottomNavSuppressed(), false);
  const wizard = code('src/components/community/requests/RequestWizard.tsx');
  assert.match(wizard, /useSuppressBottomNav\(\);/);
  assert.match(code('src/components/BottomNav.tsx'), /if \(isBottomNavHidden\(location\.pathname\) \|\| suppressed\) return null;/);
  assert.match(code('src/App.tsx'), /const navHidden = isBottomNavHidden\(location\.pathname\) \|\| navSuppressed;/);
});

// ------------------------------------------------------------ C4

test('C4: every request state reads as words, in every language — never the machine word', () => {
  const states = ['draft', 'open', 'receiving_offers', 'offer_selected', 'awarded', 'in_progress', 'delivered', 'completed', 'disputed', 'cancelled', 'expired', 'someday_new'];
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const loc = (ar: string, en: string, ckb?: string) => (lang === 'en' ? en : lang === 'ckb' ? (ckb ?? ar) : ar);
    for (const s of states) {
      const words = requestStateLabel(s, loc);
      assert.ok(words.trim().length > 0, `${lang}/${s}`);
      assert.doesNotMatch(words, /_/, `${lang}/${s} reads as a code: ${words}`);
    }
  }
  for (const s of states.slice(0, -1)) assert.ok(REQUEST_STATE_TONE[s], `a tone for ${s}`);
  const list = code('src/components/print/MyRequestsList.tsx');
  assert.doesNotMatch(list, /STATE_TEXT/, '«طلباتي» has no table of its own any more');
  assert.match(list, /requestStateLabel\(r\.state, loc\)/);
});

// ------------------------------------------------------------ C12

const OWNER: StubUser = { id: 'owner', role: 'merchant', email: 'o@x.co' };
const FAN: StubUser = { id: 'fan', role: 'customer', email: 'f@x.co' };

function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('owner','Ali','o@x.co','h','merchant'), ('fan','Sara','f@x.co','h','customer'), ('bad','Zed','z@x.co','h','merchant');
    INSERT INTO admin_settings (key, value) VALUES ('communityGate', '{"open":true}');
    INSERT INTO community_merchants (id,user_id,name,status) VALUES ('m1','owner','Ali 3D','active'), ('m2','bad','Zed','suspended');
  `);
  return raw;
}
const app = (raw: ReturnType<typeof freshDb>, user: StubUser) =>
  stubApp(asD1(raw), user, (a) => {
    a.route('/api/community', communityRoutes);
    a.route('/api/community-reviews', communityReviewRoutes);
  });

test('C12: a merchant cannot follow their own store — through either route — and a fan can', async () => {
  const raw = seed();
  for (const path of ['/api/community/store/m1/follow', '/api/community-reviews/follow/m1']) {
    const res = await post(app(raw, OWNER), path);
    assert.equal(res.status, 400, path);
    assert.equal((await json(res)).code, 'CANNOT_FOLLOW_OWN_STORE', path);
  }
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM follows WHERE merchant_id = 'm1'"), 0);
  assert.equal((await post(app(raw, FAN), '/api/community-reviews/follow/m1')).status, 200);
  assert.equal((await post(app(raw, FAN), '/api/community/store/m1/follow')).status, 200, 'following twice is still one follow');
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM follows WHERE merchant_id = 'm1'"), 1);
});

test('C12: a store Levonis suspended takes no new followers', async () => {
  const raw = seed();
  for (const path of ['/api/community/store/m2/follow', '/api/community-reviews/follow/m2']) {
    assert.equal((await post(app(raw, FAN), path)).status, 404, path);
  }
  assert.equal(count(raw, "SELECT COUNT(*) AS n FROM follows WHERE merchant_id = 'm2'"), 0);
});

// ------------------------------------------------------------ the rest, pinned

test('C2/C3/C9/C11: the request page follows its address, says failures, and gates the workshop board on a store', () => {
  const page = code('src/pages/Requests.tsx');
  assert.match(page, /if \(!deepLinked \|\| \(open && open\.id !== deepLinked\)\) setOpen\(null\);/, 'Back closes the request');
  assert.match(page, /key=\{open\.id\}/, 'another request never inherits this one\'s state');
  assert.match(page, /if \(pushed && pushedHere\.current\) navigate\(-1\);/, '«رجوع» is a real step back');
  assert.match(page, /canOffer=\{!!me\?\.store && !!me\?\.can\.offers\}/);
  assert.match(page, /const canOffer = !!me\?\.store && !!me\?\.can\.offers && !isCustomer && open;/);
  assert.doesNotMatch(page, /\.catch\(\(\) => setRows\(\[\]\)\)/, 'a board that did not load is not «no requests»');
  assert.doesNotMatch(page, /\.catch\(\(\) => setOffers\(\[\]\)\)/, 'offers that did not load are not «no offers»');
  assert.match(page, /<CommunityLoadError error=\{loadError\}/);
  assert.match(page, /<OnlookerCard me=\{me\} onNewRequest=\{onNewRequest\} \/>/);
  // The customer closes a published request from its page (the server always allowed it).
  assert.match(page, /\{isOwner && open && \(/);
  assert.match(page, /onConfirm=\{closePublished\}/);
  assert.match(page, /\{me\?\.store && !isCustomer && !isOwner && current\.state !== 'draft' && \(/, 'the workshop card only for a merchant with a store');
  const access = code('src/pages/community/access.tsx');
  assert.match(access, /error\.code === 'COMMUNITY_CLOSED'\) return <CommunityClosedCard onRecheck=\{onRetry\} \/>/);
});

test('C10/C13/C14: the offer links the merchant, a failed follow says so, and Back is a real step back', () => {
  assert.match(code('src/components/community/offers/OfferCompare.tsx'), /id=\{o\.merchant_id\}/);
  const sf = code('src/pages/Storefront.tsx');
  assert.doesNotMatch(sf, /if \(!\(e instanceof ApiError\)\) throw e;/, 'a follow error is no longer swallowed');
  assert.match(sf, /data-follow-error/);
  assert.match(sf, /const goBack = useGoBack\(backTo\);/);
  assert.match(code('src/pages/Community.tsx'), /const goBack = useGoBack\('\/'\);/);
});

test('C6: publishing or closing a request drops the community page\'s remembered request lists', () => {
  const strip = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const wizard = strip('src/components/community/requests/RequestWizard.tsx');
  assert.match(wizard, /const d = await requestsApi\.publish\(id, wizardPayload\(s, primary\?\.id \?\? '', measured\)\);\s*forgetCommunityFeed\('requests'\);/);
  const page = strip('src/pages/Requests.tsx');
  assert.match(page, /\/publish`, \{\}\);\s*forgetCommunityFeed\('requests'\);/);
  assert.equal(page.match(/\/cancel`\);\s*forgetCommunityFeed\('requests'\);/g)?.length, 2, 'closing a published request and discarding a draft');
  assert.match(page, /import \{ forgetCommunityFeed \} from '\.\.\/components\/community\/hub\/feedCache';/, 'the cache module, not the feed hook');
});
