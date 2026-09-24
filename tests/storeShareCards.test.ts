/**
 * A SHARED STORE LINK UNFURLS AS THAT STORE — audit 01 B15, B19.
 *
 *   B15  `/p/<slug>` on ali3d's host unfurled ANY merchant's product — or a
 *        catalogue product — under ali3d's address, with an `og:url` on the
 *        apex (`https://<apex>/p/…`, which is not an apex route). A suspended
 *        shop still unfurled its products in every chat.
 *   B19  the store screens hard-coded the platform's domain instead of the
 *        root domain the server is configured with.
 *
 * Real migrations through the D1 adapter; the worker wiring is pinned by
 * source, as tests/socialPreview.test.ts pins the rest of `assetWithPreview`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb, asD1 } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { previewStoreRef, resolveProductPreview } from '../worker/lib/socialPreview';

function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES
      ('owner','Ali','a@x.co','h','merchant'), ('owner2','Omar','o@x.co','h','merchant');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Ali 3D'), ('m2','owner2','Omar 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name) VALUES
      ('s1','m1','owner','ali3d','Ali 3D'), ('s2','m2','owner2','omar3d','Omar 3D');
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,name_ar,description_ar,images,status,lifecycle,price_iqd) VALUES
      ('cp1','m1','s1','ali3d-bracket','Bracket','حامل رف','حامل متين','["/files/merchants/owner/public/aaaa1111.webp"]','active','active',7000),
      ('cp2','m2','s2','omar3d-vase','Vase','مزهرية','طويلة','[]','active','active',9000),
      ('cp3','m1','s1','ali3d-draft','Draft','مسودة','','[]','hidden','draft',1000);
    INSERT INTO products (id, slug, name, name_ar, price_iqd, status) VALUES ('p1', 'filament-pla', 'PLA', 'خيط PLA', 100000, 'active');
  `);
  return raw;
}

const STORE = 'https://ali3d.levonis-iq.com';

test('B15: on a store\'s host only THAT store\'s published product is a card', async () => {
  const db = asD1(seed());
  const own = await resolveProductPreview(db, 'ali3d-bracket', STORE, { storeSlug: 'ali3d' });
  assert.equal(own?.title, 'حامل رف');
  assert.equal(own?.image, `${STORE}/files/merchants/owner/public/aaaa1111.webp`, 'the picture is addressed on the store\'s own host');

  assert.equal(await resolveProductPreview(db, 'omar3d-vase', STORE, { storeSlug: 'ali3d' }), null, 'another shop\'s product');
  assert.equal(await resolveProductPreview(db, 'filament-pla', STORE, { storeSlug: 'ali3d' }), null, 'a catalogue product');
  assert.equal(await resolveProductPreview(db, 'ali3d-draft', STORE, { storeSlug: 'ali3d' }), null, 'a draft');

  // The apex is unchanged: the catalogue first, then any merchant's product.
  assert.equal((await resolveProductPreview(db, 'filament-pla', 'https://levonis-iq.com'))?.title, 'خيط PLA');
  assert.equal((await resolveProductPreview(db, 'omar3d-vase', 'https://levonis-iq.com'))?.title, 'مزهرية');
});

test('B15: /community/store/<ref>/p/<slug> is scoped like its page — by slug, store id or merchant id', async () => {
  assert.equal(previewStoreRef('/community/store/ali3d/p/ali3d-bracket'), 'ali3d');
  assert.equal(previewStoreRef('/community/store/s1/p/ali3d-bracket/'), 's1');
  assert.equal(previewStoreRef('/p/ali3d-bracket'), null);
  assert.equal(previewStoreRef('/community/store/%E0%A4/p/x'), null, 'malformed percent-encoding is no scope, not a crash');

  const db = asD1(seed());
  for (const ref of ['ali3d', 's1', 'm1']) {
    assert.equal((await resolveProductPreview(db, 'ali3d-bracket', 'https://levonis-iq.com', { storeRef: ref }))?.title, 'حامل رف', ref);
  }
  for (const ref of ['omar3d', 's2', 'm2']) {
    assert.equal(await resolveProductPreview(db, 'ali3d-bracket', 'https://levonis-iq.com', { storeRef: ref }), null, ref);
  }
  // A store HOST scope is a slug only — an id there is not an address.
  assert.equal(await resolveProductPreview(db, 'ali3d-bracket', STORE, { storeSlug: 's1' }), null);
});

test('B15: a sanctioned shop gives no card anywhere; a paused one still does', async () => {
  for (const sql of [
    "UPDATE merchant_stores SET status = 'suspended' WHERE id = 's1'",
    "UPDATE community_merchants SET status = 'suspended' WHERE id = 'm1'",
  ]) {
    const raw = seed();
    raw.exec(sql);
    const db = asD1(raw);
    assert.equal(await resolveProductPreview(db, 'ali3d-bracket', STORE, { storeSlug: 'ali3d' }), null, sql);
    assert.equal(await resolveProductPreview(db, 'ali3d-bracket', 'https://levonis-iq.com', { storeRef: 's1' }), null, sql);
    assert.equal(await resolveProductPreview(db, 'ali3d-bracket', 'https://levonis-iq.com'), null, `${sql} (apex)`);
    // The other shop is untouched.
    assert.equal((await resolveProductPreview(db, 'omar3d-vase', 'https://levonis-iq.com'))?.title, 'مزهرية');
  }
  const raw = seed();
  raw.exec("UPDATE merchant_stores SET status = 'paused' WHERE id = 's1'");
  assert.equal((await resolveProductPreview(asD1(raw), 'ali3d-bracket', STORE, { storeSlug: 'ali3d' }))?.title, 'حامل رف', 'paused is the merchant\'s own switch, not a sanction');
});

test('B15: the worker gives a store host its own origin and scope', () => {
  const index = readFileSync(join(ROOT, 'worker/index.ts'), 'utf8');
  const fn = /async function assetWithPreview[\s\S]*?\n}\n/.exec(index)?.[0] ?? '';
  assert.ok(fn, 'assetWithPreview not found');
  assert.match(fn, /const onStore = host\.kind === 'merchant' && !!host\.slug;/);
  assert.match(fn, /const origin = onStore \? `https:\/\/\$\{host\.host\}` : trustedOrigin\(c\);/);
  assert.match(fn, /storeSlug: onStore \? host\.slug : null/);
  assert.match(fn, /storeRef: previewStoreRef\(c\.req\.path\)/);
  assert.match(fn, /url: `\$\{origin\}\$\{url\.pathname\}\$\{url\.search\}`/, 'og:url on the host the link was shared from');
});

test('B19: the store screens take the platform\'s domain from the server, never from a literal', () => {
  const code = (rel: string) =>
    readFileSync(join(ROOT, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '') // block and JSX comments
      .replace(/^\s*\/\/.*$/gm, ''); // whole-line comments
  for (const rel of [
    'src/pages/MerchantStart.tsx',
    'src/pages/Storefront.tsx',
    'src/pages/StorefrontProduct.tsx',
    'src/pages/MerchantDashboardPage.tsx',
    'src/components/merchant/StoreUnavailable.tsx',
    'src/StoreContext.tsx',
  ]) {
    assert.doesNotMatch(code(rel), /levonis-iq\.com|levonis\.com/i, `${rel} hard-codes the platform domain`);
  }
  assert.match(code('src/pages/MerchantStart.tsx'), /root_domain/, 'onboarding previews <slug>.<root_domain from /me>');
});
