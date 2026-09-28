/**
 * SAVING THE STORE SETTINGS, THROUGH THE REAL ROUTE (review of the settings
 * screen, 2026-09-28).
 *
 *   - a refused field is NAMED: STORE_FIELD_INVALID {field, min, max, reason},
 *     MEDIA_NOT_OWNED {field} — and nothing of the save is written;
 *   - links: `instagram.com/x` is stored as https://instagram.com/x (it used
 *     to be dropped while the screen said «saved»); a link that cannot be an
 *     address is refused by its key or row; a long one is read whole;
 *   - hours: a day listed as closed is stored as closed;
 *   - a paused store can fix a typo in a service that is already on, but not
 *     switch an off one back on;
 *   - a second onboarding is STORE_EXISTS, the code the page answers.
 *
 * Run: node --import tsx --test tests/storeSettingsSave.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, patch, post, json, row, type StubUser } from './fixtures/app';
import { merchantRoutes } from '../worker/routes/merchant';

const OWNER: StubUser = { id: 'owner', role: 'merchant', email: 'owner@x.co' };
const FUTURE = '2099-01-01T00:00:00.000Z';
const ENV = { STORE_ROOT_DOMAIN: 'levonis-iq.com' };

function seed(status: 'active' | 'paused' = 'active') {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('owner','Ali','owner@x.co','h','merchant'), ('rival','Zaid','z@x.co','h','merchant');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at) VALUES
      ('mem1','owner','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','${FUTURE}');
    INSERT INTO admin_settings (key, value) VALUES ('communityGate', '{"open":true}');
    INSERT INTO community_merchants (id,user_id,name,governorate) VALUES ('m1','owner','Ali 3D','baghdad');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,tagline,governorate,status)
      VALUES ('s1','m1','owner','ali3d','Ali 3D','Prints that last','baghdad','${status}');
    INSERT INTO merchant_store_slugs (slug, store_id, active) VALUES ('ali3d','s1',1);
  `);
  return raw;
}

const app = (raw: ReturnType<typeof freshDb>, user: StubUser = OWNER) =>
  stubApp(asD1(raw), user, (a) => a.route('/api/merchant', merchantRoutes), { env: ENV });

const stored = (raw: ReturnType<typeof freshDb>) =>
  row<{ name: string; tagline: string; social_links: string; profile_links: string; business_hours: string; logo_key: string | null; accent: string }>(
    raw,
    "SELECT name, tagline, social_links, profile_links, business_hours, logo_key, accent FROM merchant_stores WHERE id = 's1'"
  )!;

async function refused(res: Response, status = 400) {
  const body = await json(res);
  assert.equal(res.status, status, JSON.stringify(body));
  return body as { code: string; details: Record<string, unknown> };
}

// ------------------------------------------------------------ named fields

test('STORE_FIELD_INVALID names the field, its limits and why — and nothing of the save is written', async () => {
  const raw = seed();
  const short = await refused(await patch(app(raw), '/api/merchant/store', { name: 'A', tagline: 'A new line' }));
  assert.equal(short.code, 'STORE_FIELD_INVALID');
  assert.deepEqual(short.details, { field: 'name', min: 2, max: 60, reason: 'short' });
  assert.equal(stored(raw).tagline, 'Prints that last', 'the tagline in the same save was not written');

  const long = await refused(await patch(app(raw), '/api/merchant/store', { tagline: 't'.repeat(141) }));
  assert.deepEqual(long.details, { field: 'tagline', min: 0, max: 140, reason: 'long' });

  const phone = await refused(await patch(app(raw), '/api/merchant/store', { contact_phone: '1'.repeat(33) }));
  assert.deepEqual(phone.details, { field: 'contact_phone', min: 0, max: 32, reason: 'long' });

  const typed = await refused(await patch(app(raw), '/api/merchant/store', { name: 42 }));
  assert.deepEqual([typed.code, typed.details.field, typed.details.reason], ['STORE_FIELD_INVALID', 'name', 'invalid']);

  const accent = await refused(await patch(app(raw), '/api/merchant/store', { accent: '#ff0000' }));
  assert.deepEqual([accent.code, accent.details.field], ['STORE_FIELD_INVALID', 'accent']);
  assert.equal(stored(raw).accent, 'default');
});

test('MEDIA_NOT_OWNED names the picture: another merchant\'s file is refused, the merchant\'s own is kept', async () => {
  const raw = seed();
  const theirs = await refused(await patch(app(raw), '/api/merchant/store', { logo_key: 'merchants/rival/public/abcd1234.webp' }));
  assert.equal(theirs.code, 'MEDIA_NOT_OWNED');
  assert.deepEqual(theirs.details, { field: 'logo_key' });
  const banner = await refused(await patch(app(raw), '/api/merchant/store', { banner_key: 'https://tracker.example/x.png' }));
  assert.deepEqual([banner.code, banner.details.field], ['MEDIA_NOT_OWNED', 'banner_key']);

  const mine = await patch(app(raw), '/api/merchant/store', { logo_key: '/files/merchants/owner/public/abcd1234.webp' });
  assert.equal(mine.status, 200, JSON.stringify(await json(mine.clone())));
  assert.equal(stored(raw).logo_key, 'merchants/owner/public/abcd1234.webp');
  assert.equal((await json(mine)).store.logoUrl, '/files/merchants/owner/public/abcd1234.webp');
});

// ------------------------------------------------------------ links

test('social links: what people type is stored as an address; a trimmed name; empty rows are not rows', async () => {
  const raw = seed();
  const res = await patch(app(raw), '/api/merchant/store', {
    social_links: { ' Instagram ': ' instagram.com/ali3d ', Telegram: 'https://t.me/ali3d', Facebook: '', '  ': 'x.com/a' },
  });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  const want = { Instagram: 'https://instagram.com/ali3d', Telegram: 'https://t.me/ali3d' };
  assert.deepEqual(JSON.parse(stored(raw).social_links), want);
  assert.deepEqual((await json(res)).store.social_links, want, 'the answer is what was kept — the form rebuilds from it');
});

test('social links: an address that cannot be one is refused by its key — never dropped after «saved»', async () => {
  const raw = seed();
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'not a link', `https://ali3d.iq/${'a'.repeat(300)}`]) {
    const body = await refused(await patch(app(raw), '/api/merchant/store', { name: 'Renamed', social_links: { Instagram: 'instagram.com/a', X: bad } }));
    assert.equal(body.code, 'STORE_FIELD_INVALID', bad);
    assert.deepEqual(body.details, { field: 'social_links', key: 'X' }, bad);
  }
  assert.equal(stored(raw).name, 'Ali 3D', 'nothing was written');
  assert.equal(stored(raw).social_links, '{}');
});

test('header links: normalised like the social links; a bad one is refused by its row AS SENT', async () => {
  const raw = seed();
  const ok = await patch(app(raw), '/api/merchant/store', {
    profile_links: [
      { icon: 'globe', title: 'Site', url: 'ali3d.iq', visible: true },
      { icon: 'instagram', title: 'Insta', url: '', visible: false },
    ],
  });
  assert.equal(ok.status, 200, JSON.stringify(await json(ok.clone())));
  assert.deepEqual(JSON.parse(stored(raw).profile_links), [
    { icon: 'globe', title: 'Site', visible: true, url: 'https://ali3d.iq/' },
    { icon: 'instagram', title: 'Insta', visible: false },
  ]);

  const bad = await refused(
    await patch(app(raw), '/api/merchant/store', {
      profile_links: [
        { icon: 'globe', title: '', url: '' },
        { icon: 'globe', title: 'Site', url: 'ali3d.iq' },
        { icon: 'globe', title: 'Bad', url: 'javascript:alert(1)' },
      ],
    })
  );
  assert.deepEqual([bad.code, bad.details.field, bad.details.index], ['STORE_FIELD_INVALID', 'profile_links', 2]);
});

// ------------------------------------------------------------ hours

test('hours: a day listed as closed is stored closed, with no times; a day with times keeps them', async () => {
  const raw = seed();
  const res = await patch(app(raw), '/api/merchant/store', {
    business_hours: [
      { day: 'Fri', open: '09:00', close: '12:00', closed: true },
      { day: 'Sat', open: '09:00', close: '18:00' },
      { day: 'Sun', open: 'soon', close: '<b>' },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  assert.deepEqual(JSON.parse(stored(raw).business_hours), [
    { day: 'Fri', open: '', close: '', closed: true },
    { day: 'Sat', open: '09:00', close: '18:00' },
    { day: 'Sun', open: '', close: '' },
  ]);
});

// ------------------------------------------------------------ services

test('a paused store fixes a typo in a service that is on; switching an OFF one on still needs selling rights', async () => {
  const raw = seed('paused');
  raw.exec(`
    INSERT INTO merchant_services (id, store_id, merchant_id, title, active) VALUES
      ('sv_on', 's1', 'm1', 'Resin printng', 1), ('sv_off', 's1', 'm1', 'Scanning', 0);
  `);
  // The editor sends the whole form, `active` included.
  const typo = await patch(app(raw), '/api/merchant/services/sv_on', { title: 'Resin printing', active: true });
  assert.equal(typo.status, 200, JSON.stringify(await json(typo.clone())));
  assert.equal(row<{ title: string }>(raw, "SELECT title FROM merchant_services WHERE id = 'sv_on'")!.title, 'Resin printing');

  const on = await refused(await patch(app(raw), '/api/merchant/services/sv_off', { title: 'Scanning', active: true }), 403);
  assert.equal(on.code, 'STORE_PAUSED');
  assert.equal(row<{ active: number }>(raw, "SELECT active FROM merchant_services WHERE id = 'sv_off'")!.active, 0);

  // Another store's service is not found, whatever it carries.
  assert.equal((await patch(app(raw), '/api/merchant/services/nope', { title: 'x y', active: true })).status, 404);
});

test('MEDIA_NOT_OWNED on a service picture names the field too', async () => {
  const raw = seed();
  raw.exec(`INSERT INTO merchant_services (id, store_id, merchant_id, title, active) VALUES ('sv_on', 's1', 'm1', 'Resin', 1)`);
  const body = await refused(await patch(app(raw), '/api/merchant/services/sv_on', { image_key: 'merchants/rival/public/abcd1234.webp' }));
  assert.deepEqual([body.code, body.details.field], ['MEDIA_NOT_OWNED', 'image_key']);
});

// ------------------------------------------------------------ onboarding

test('a second onboarding is STORE_EXISTS — the code the page answers by opening the workspace', async () => {
  const raw = seed();
  const res = await refused(await post(app(raw), '/api/merchant/onboard', { name: 'Another', slug: 'another-shop' }), 409);
  assert.equal(res.code, 'STORE_EXISTS');
});

test('onboarding names a too-short store name by field, like the settings do', async () => {
  const raw = seed();
  raw.exec("DELETE FROM merchant_store_slugs; DELETE FROM merchant_stores; DELETE FROM community_merchants;");
  const res = await refused(await post(app(raw), '/api/merchant/onboard', { name: 'A', slug: 'a-new-shop' }));
  assert.equal(res.code, 'STORE_FIELD_INVALID');
  assert.equal(res.details.field, 'name');
});
