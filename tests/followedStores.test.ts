/**
 * «متاجر أتابعها» — A FOLLOWED SHOP LOOKS LIKE THE SHOP (review of Levo
 * Community, 2026-09-28).
 *
 * The list sent the community profile — its name, bio and avatar — so a shop
 * renamed in its settings, or known by its logo, was a stranger on the page
 * that lists the shops a customer chose to follow; the page drew it on a
 * clickable <div> holding a button, and a failed unfollow went to the console.
 * Now the server answers with the directory's own card (store name, logo,
 * tagline, rating, place, whether it takes custom requests) and the page draws
 * it with the directory's StoreCard. A sanctioned shop's neutral card is pinned
 * in tests/securityReviewW1.test.ts; 150 followed shops in
 * tests/d1BoundParamLists.test.ts.
 *
 * Also here: the storefront's «اطلب عرض سعر» opens the request wizard.
 *
 * Run: node --import tsx --test tests/followedStores.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb, asD1, stubApp, get, json, type StubUser } from './fixtures/app';
import { communityRoutes, FOLLOWED_LIMIT } from '../worker/routes/community';
import { communityReviewRoutes } from '../worker/routes/merchantReviews';
import { storesLabel } from '../src/components/community/hub/copy';

const ROOT = join(import.meta.dirname, '..');
const code = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const VIEWER: StubUser = { id: 'v', role: 'customer', email: 'v@x.co' };

function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,username,email,password_hash,role) VALUES
      ('v','Viewer','viewer','v@x.co','h','customer'),
      ('ali','Ali','ali','ali@x.co','h','merchant'),
      ('omar','Omar','omar','omar@x.co','h','merchant');
    INSERT INTO community_merchants (id,user_id,name,bio,avatar_key,status,rating_count,rating_avg_x100,completed_orders) VALUES
      ('m_ali','ali','Ali (old name)','Profile bio','merchants/ali/public/a.webp','active',4,450,9),
      ('m_omar','omar','Omar 3D','','', 'active',0,0,0);
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,tagline,logo_key,governorate,accepts_custom_requests,status) VALUES
      ('s_ali','m_ali','ali','ali3d','Ali Prints','Brackets and parts','merchants/ali/public/logo.webp','baghdad',1,'active');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,status,lifecycle,price_iqd)
      VALUES ('p1','m_ali','s_ali','ali3d-widget','Widget','active','active',1000);
    INSERT INTO follows (user_id, merchant_id) VALUES ('v','m_ali'), ('v','m_omar');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  return raw;
}

const app = (raw: ReturnType<typeof freshDb>) =>
  stubApp(asD1(raw), VIEWER, (a) => a.route('/api/community', communityRoutes), { env: { STORE_ROOT_DOMAIN: 'levonis-iq.com' } });

test('a followed shop is the directory\'s card: the store\'s own name, logo and tagline, its numbers, and «following»', async () => {
  const raw = seed();
  const res = await get(app(raw), '/api/community/followed');
  assert.equal(res.status, 200);
  const cards = (await json(res)).merchants as Array<Record<string, unknown>>;
  const ali = cards.find((m) => m.id === 'm_ali')!;
  assert.equal(ali.store_name, 'Ali Prints', 'the shop\'s name, not the community profile\'s');
  assert.equal(ali.tagline, 'Brackets and parts');
  assert.equal(ali.logoUrl, '/files/merchants/ali/public/logo.webp');
  assert.equal(ali.governorate, 'baghdad');
  assert.equal(ali.accepts_custom_requests, true);
  assert.equal(ali.rating, 4.5);
  assert.equal(ali.rating_count, 4);
  assert.equal(ali.completed_orders, 9);
  assert.equal(ali.product_count, 1);
  assert.equal(ali.followers, 1);
  assert.equal(ali.following, true);
  assert.equal(ali.unavailable, false);
  assert.equal(ali.bio, 'Profile bio', 'the profile fields ride along, as in the directory');
  assert.equal(ali.store_url, 'https://ali3d.levonis-iq.com', 'a card opens the shop\'s own address');

  // A merchant without a store: the profile is all there is.
  const omar = cards.find((m) => m.id === 'm_omar')!;
  assert.equal(omar.store_name, null);
  assert.equal(omar.store_url, null);
  assert.equal(omar.accepts_custom_requests, false);
  assert.equal(omar.following, true);

  // Exactly the directory's card for the same shop (plus «unavailable»).
  const dir = (await json(await get(app(raw), '/api/community/merchants'))).merchants as Array<Record<string, unknown>>;
  const fromDir = dir.find((m) => m.id === 'm_ali')!;
  assert.deepEqual({ ...ali, unavailable: undefined }, { ...fromDir, unavailable: undefined });
});

const reviewsApp = (raw: ReturnType<typeof freshDb>) =>
  stubApp(asD1(raw), VIEWER, (a) => a.route('/api/community-reviews', communityReviewRoutes));

test('«do I follow this shop?» asks about that shop only', async () => {
  const raw = seed();
  const all = (await json(await get(reviewsApp(raw), '/api/community-reviews/following'))).following as Array<Record<string, unknown>>;
  assert.deepEqual(all.map((f) => f.merchant_id).sort(), ['m_ali', 'm_omar']);
  const one = (await json(await get(reviewsApp(raw), '/api/community-reviews/following?merchant_id=m_omar'))).following as Array<Record<string, unknown>>;
  assert.deepEqual(one.map((f) => f.merchant_id), ['m_omar']);
  const none = (await json(await get(reviewsApp(raw), '/api/community-reviews/following?merchant_id=m_nobody'))).following;
  assert.deepEqual(none, []);
  assert.match(
    code('src/pages/Storefront.tsx'),
    /\/api\/community-reviews\/following\?merchant_id=\$\{encodeURIComponent\(merchantId\)\}/,
    'the store page\'s follow pill reads its own row'
  );
});

test('a sanctioned shop in the following list carries nothing its merchant wrote (as /followed, review S5)', async () => {
  const raw = seed();
  raw.exec("UPDATE merchant_stores SET tagline = 'DM us your wallet code' WHERE id = 's_ali'; UPDATE merchant_stores SET status = 'suspended' WHERE id = 's_ali'");
  const res = await get(reviewsApp(raw), '/api/community-reviews/following');
  const text = await res.clone().text();
  assert.ok(!text.includes('DM us your wallet code') && !text.includes('Ali (old name)') && !text.includes('logo.webp'));
  const ali = ((await json(res)).following as Array<Record<string, unknown>>).find((f) => f.merchant_id === 'm_ali')!;
  assert.equal(ali.unavailable, true);
  assert.equal(ali.name, null);
  assert.equal(ali.logoUrl, null);
  assert.equal(ali.tagline, null);
  const omar = ((await json(await get(reviewsApp(raw), '/api/community-reviews/following'))).following as Array<Record<string, unknown>>).find((f) => f.merchant_id === 'm_omar')!;
  assert.equal(omar.unavailable, false);
  assert.equal(omar.name, 'Omar 3D');
});

test('the list is bounded — it has no pages', () => {
  assert.equal(FOLLOWED_LIMIT, 500);
  assert.match(code('worker/routes/community.ts'), /WHERE f\.user_id = \? ORDER BY f\.created_at DESC LIMIT \$\{FOLLOWED_LIMIT\}/);
  const reviews = code('worker/routes/merchantReviews.ts');
  assert.match(reviews, /const FOLLOWING_LIMIT = 500;/);
  assert.match(reviews, /ORDER BY f\.created_at DESC LIMIT \$\{FOLLOWING_LIMIT\}/);
});

test('the page draws the directory\'s StoreCard, toggles in place, and says a failure', () => {
  const page = code('src/pages/FollowedStores.tsx');
  assert.match(page, /<StoreCard key=\{m\.id\} store=\{\{ \.\.\.m, following: m\.following !== false \}\} canFollow busy=\{busyId === m\.id\} onToggleFollow=\{\(\) => toggle\(m\)\} \/>/);
  assert.match(page, /await \(was \? communityHubApi\.unfollow\(m\.id\) : communityHubApi\.follow\(m\.id\)\);\s*forgetCommunityFeed\('merchants'\);/, 'the hub\'s cached «تتابعه» agrees');
  assert.match(page, /set\(was, m\.followers \?\? 0\);/, 'a failure puts the button back');
  assert.match(page, /toast\.error\(loc\('تعذّر تحديث المتابعة/);
  assert.doesNotMatch(page, /console\.error/);
  assert.match(page, /<ErrorState error=\{error\} onRetry=\{retry\} \/>/);
  assert.match(page, /to="\/community\?tab=merchants"/, 'an empty list leads to the stores');
  assert.match(page, /useGoBack\('\/community'\)/);
  assert.doesNotMatch(page, /<div[^>]*onClick=/, 'no clickable <div> around a button');

  // The count beside the title is a counted noun, not a bare number.
  assert.match(page, /\{storesLabel\(followingNow, lang\)\}/);
  assert.deepEqual(
    [1, 2, 5, 12, 100].map((n) => storesLabel(n, 'ar')),
    ['متجر واحد', 'متجران', '5 متاجر', '12 متجرًا', '100 متجر']
  );
  assert.deepEqual([1, 3].map((n) => storesLabel(n, 'en')), ['1 store', '3 stores']);

  const card = code('src/components/community/hub/StoreCard.tsx');
  assert.match(card, /\{m\.accepts_custom_requests && \(/);
  assert.match(card, /inline-flex min-h-11 items-center gap-1 rounded-full border/, 'the follow button is a 44px target');
});

test('a store\'s «اطلب عرض سعر» opens the request wizard, not the board', () => {
  const sf = code('src/pages/Storefront.tsx');
  assert.match(sf, /const QUOTE_PATH = '\/requests\?view=new';/);
  assert.match(sf, /requestsHref: onHost \? `\$\{MAIN_SITE\}\$\{QUOTE_PATH\}` : QUOTE_PATH,/);
  assert.match(sf, /const requestsHref = onHost \? `\$\{MAIN_SITE\}\$\{QUOTE_PATH\}` : QUOTE_PATH;/);
  // …and the wizard answers that address for a signed-in customer.
  assert.match(code('src/pages/Requests.tsx'), /if \(\(asked === 'new' \|\| asked === 'orders'\) && user\) return asked;/);
});

test('a suspended shop\'s community link says «غير متاح», as its own address does', () => {
  const page = code('src/pages/CommunityStorePage.tsx');
  assert.match(page, /const refused = \(e: unknown\) => e instanceof ApiError && e\.code === 'STORE_UNAVAILABLE';/);
  assert.match(page, /\.catch\(\(e: unknown\) => \{\s*if \(refused\(e\)\) throw e;\s*return storefrontApi\.storeById\(id\);\s*\}\)/, 'a refusal is not retried as another kind of id');
  assert.match(page, /if \(alive && refused\(legacy\)\) setUnavailable\(true\);/, 'the profile-only door answers the same');
  assert.match(page, /if \(unavailable\) return <StoreUnavailable \/>;/);
});

test('the legacy store page says a failed follow or chat instead of writing it to the console', () => {
  const page = code('src/pages/MerchantStore.tsx');
  assert.doesNotMatch(page, /console\.error/);
  assert.match(page, /toast\.error\(loc\('تعذّر فتح المحادثة/);
  assert.match(page, /err\.code === 'CANNOT_FOLLOW_OWN_STORE'/);
  assert.match(page, /setLoadError\(err \?\? new Error\('load failed'\)\)/, 'the error is worded at render time (no stale-language effect)');
});

test('a follow from the store page moves the page\'s own follower count', () => {
  const sf = code('src/pages/Storefront.tsx');
  assert.match(sf, /setStore\(\(s\) => \(s \? \{ \.\.\.s, followers: Math\.max\(0, \(s\.followers \?\? 0\) \+ \(following \? 1 : -1\)\) \} : s\)\)/);
  assert.match(sf, /await api\.delete\(`\/api\/community-reviews\/follow\/\$\{merchantId\}`\);\s*setFollowing\(false\);\s*onChange\?\.\(false\);/);
  assert.match(sf, /await api\.post\(`\/api\/community-reviews\/follow\/\$\{merchantId\}`\);\s*setFollowing\(true\);\s*onChange\?\.\(true\);/);
  assert.match(sf, /onChange=\{onFollowChange\} \/>/);
});
