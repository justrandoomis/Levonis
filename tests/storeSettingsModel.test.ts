/**
 * THE STORE SETTINGS FORM, AS DATA (review of the settings screen, 2026-09-28).
 *
 * src/components/merchant/dashboard/storeSettingsModel.ts holds the screen's
 * rules without React: what the form starts from, what it refuses before
 * sending, what it sends, and how a server refusal becomes a marked field.
 * Each test pins one of the defects the review found:
 *
 *   - a social link typed as `instagram.com/x` was dropped on save while the
 *     screen said «تم الحفظ» — now it is sent (and stored) as https://…;
 *   - two rows called «Instagram» merged into one; a thirteenth policy
 *     vanished; a too-short name came back as «تعذّر الحفظ» with no field;
 *   - «+ إضافة رابط» always proposed Instagram;
 *   - a closed day rendered as a stray dash — it is now `closed: true`;
 *   - the form's limits drifted from the server's — they are read here from
 *     the route's own source and compared.
 *
 * Run: node --import tsx --test tests/storeSettingsModel.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  LIMITS,
  SOCIAL_NETWORKS,
  fieldErrorFromRefusal,
  formFromStore,
  formSignature,
  nextNetwork,
  patchFromForm,
  socialRowForKey,
  validateForm,
  widgetRowForSentIndex,
  type SettingsForm,
} from '../src/components/merchant/dashboard/storeSettingsModel';
import { profileHref } from '../packages/storeLayout/src/refs';
import type { MerchantStore } from '../src/lib/merchant';

const ROOT = join(import.meta.dirname, '..');

function store(over: Partial<MerchantStore> = {}): MerchantStore {
  return {
    id: 's1',
    slug: 'ali3d',
    name: 'Ali 3D',
    tagline: 'Prints that last',
    description: 'We print.',
    logoUrl: null,
    bannerUrl: null,
    accent: 'olive',
    governorate: 'baghdad',
    contact_phone: '+9647800000001',
    contact_phone_public: 1,
    accepts_custom_requests: 1,
    sells_direct_products: 1,
    categories: ['figures'],
    service_areas: ['Karrada'],
    business_hours: [
      { day: 'Sat', open: '09:00', close: '18:00' },
      { day: 'Fri', open: '', close: '', closed: true },
    ],
    policies: { Returns: 'Seven days.' },
    social_links: { Instagram: 'https://instagram.com/ali3d' },
    profile_links: [{ icon: 'globe', title: 'Site', url: 'https://ali3d.iq/', visible: true }],
    profile_facts: [{ icon: 'clock', title: 'Prep', subtitle: '2 days', visible: true }],
    status: 'active',
    ...over,
  } as unknown as MerchantStore;
}

const form = (over: Partial<SettingsForm> = {}): SettingsForm => ({ ...formFromStore(store()), ...over });
const kinds = (f: SettingsForm) => validateForm(f).map((e) => [e.field, e.kind, e.index ?? null]);

// ------------------------------------------------------------ the starting form

test('the form starts from the store: rows as rows, a closed day as closed, open from the status', () => {
  const f = formFromStore(store());
  assert.equal(f.name, 'Ali 3D');
  assert.equal(f.contact_phone_public, true);
  assert.deepEqual(f.business_hours, [
    { day: 'Sat', open: '09:00', close: '18:00', closed: false },
    { day: 'Fri', open: '', close: '', closed: true },
  ]);
  assert.deepEqual(f.policies, [['Returns', 'Seven days.']]);
  assert.deepEqual(f.social_links, [['Instagram', 'https://instagram.com/ali3d']]);
  assert.equal(f.open, true);
  assert.equal(formFromStore(store({ status: 'paused' } as Partial<MerchantStore>)).open, false);
  // A pre-structured hours row (free text) is kept as the day, open.
  const legacy = formFromStore(store({ business_hours: ['السبت – الخميس 9–6'] } as unknown as Partial<MerchantStore>));
  assert.deepEqual(legacy.business_hours, [{ day: 'السبت – الخميس 9–6', open: '', close: '', closed: false }]);
});

test('the form is a copy: editing it never writes into the store it came from', () => {
  const s = store();
  const f = formFromStore(s);
  f.profile_links[0].title = 'Changed';
  f.categories.push('new');
  assert.equal((s.profile_links as Array<{ title: string }>)[0].title, 'Site');
  assert.deepEqual(s.categories, ['figures']);
});

test('dirty is a signature: the same store twice is clean, one keystroke is not', () => {
  assert.equal(formSignature(formFromStore(store())), formSignature(formFromStore(store())));
  assert.notEqual(formSignature(formFromStore(store())), formSignature(form({ tagline: 'Prints that last!' })));
});

// ------------------------------------------------------------ social rows

test('«+ إضافة رابط» proposes the first network not yet used, whatever its case', () => {
  assert.equal(nextNetwork([]), 'Instagram');
  assert.equal(nextNetwork([['instagram', 'x']]), 'Facebook');
  assert.equal(nextNetwork([[' Instagram ', ''], ['FACEBOOK', '']]), 'TikTok');
  assert.equal(nextNetwork(SOCIAL_NETWORKS.map((n) => [n, ''] as [string, string])), '');
});

// ------------------------------------------------------------ validation

test('a clean store has nothing to say', () => {
  assert.deepEqual(validateForm(form()), []);
});

test('the name: at least two characters and at most sixty, counted after trimming', () => {
  assert.deepEqual(kinds(form({ name: ' A ' })), [['name', 'short', null]]);
  assert.deepEqual(kinds(form({ name: 'x'.repeat(61) })), [['name', 'long', null]]);
  assert.deepEqual(kinds(form({ name: 'Ab' })), []);
  const [e] = validateForm(form({ name: '' }));
  assert.deepEqual([e.min, e.max], [2, 60], 'the error carries the limits it quotes');
});

test('the texts: tagline, about and phone stop at the server\'s lengths', () => {
  assert.deepEqual(kinds(form({ tagline: 't'.repeat(141) })), [['tagline', 'long', null]]);
  assert.deepEqual(kinds(form({ description: 'd'.repeat(4001) })), [['description', 'long', null]]);
  assert.deepEqual(kinds(form({ contact_phone: '1'.repeat(33) })), [['contact_phone', 'long', null]]);
});

test('social links: an address or nothing, a network once, a name on every row, ten at most', () => {
  // What people type is accepted; what cannot be an address is named on its row.
  assert.deepEqual(kinds(form({ social_links: [['Instagram', 'instagram.com/ali3d']] })), []);
  assert.deepEqual(kinds(form({ social_links: [['Instagram', 'javascript:alert(1)']] })), [['social_links', 'invalid_url', 0]]);
  assert.deepEqual(kinds(form({ social_links: [['Site', 'not a link']] })), [['social_links', 'invalid_url', 0]]);
  // Two rows called «Instagram» — the second used to overwrite the first on save.
  assert.deepEqual(
    kinds(form({ social_links: [['Instagram', 'instagram.com/a'], ['instagram ', 'instagram.com/b']] })),
    [['social_links', 'duplicate', 1]]
  );
  assert.deepEqual(kinds(form({ social_links: [['', 'instagram.com/a']] })), [['social_links', 'untitled', 0]]);
  // An empty row is not a problem: it is simply not sent.
  assert.deepEqual(kinds(form({ social_links: [['Instagram', ''], ['', '']] })), []);
  const eleven = Array.from({ length: 11 }, (_, i) => [`net${i}`, `example${i}.com`] as [string, string]);
  assert.deepEqual(kinds(form({ social_links: eleven })), [['social_links', 'too_many', null]]);
});

test('policies: titled, once each, twelve at most — the thirteenth used to vanish on save', () => {
  assert.deepEqual(kinds(form({ policies: [['', 'Seven days.']] })), [['policies', 'untitled', 0]]);
  assert.deepEqual(kinds(form({ policies: [['Returns', 'a'], ['returns', 'b']] })), [['policies', 'duplicate', 1]]);
  assert.deepEqual(kinds(form({ policies: [['Returns', 'x'.repeat(2001)]] })), [['policies', 'long', 0]]);
  const thirteen = Array.from({ length: 13 }, (_, i) => [`Policy ${i}`, 'text'] as [string, string]);
  assert.deepEqual(kinds(form({ policies: thirteen })), [['policies', 'too_many', null]]);
  assert.deepEqual(kinds(form({ policies: [['Returns', ''], ['', '']] })), [], 'a title with no text yet is not sent, not refused');
});

test('header rows: a value needs a title, a link needs to be an address', () => {
  assert.deepEqual(
    kinds(form({ profile_links: [{ icon: 'globe', title: '', url: 'ali3d.iq', visible: true }] })),
    [['profile_links', 'untitled', 0]]
  );
  assert.deepEqual(
    kinds(form({ profile_links: [{ icon: 'globe', title: 'Site', url: 'data:text/html,x', visible: true }] })),
    [['profile_links', 'invalid_url', 0]]
  );
  assert.deepEqual(kinds(form({ profile_links: [{ icon: 'globe', title: 'Site', url: '', visible: true }] })), [], 'no address yet is kept, not refused');
  assert.deepEqual(
    kinds(form({ profile_facts: [{ icon: 'clock', title: 'Prep', subtitle: 's'.repeat(41), visible: true }] })),
    [['profile_facts', 'long', 0]]
  );
});

test('hours: fourteen days at most, sixty characters a day', () => {
  const fifteen = Array.from({ length: 15 }, (_, i) => ({ day: `Day ${i}`, open: '', close: '', closed: false }));
  assert.deepEqual(kinds(form({ business_hours: fifteen })), [['business_hours', 'too_many', null]]);
  assert.deepEqual(
    kinds(form({ business_hours: [{ day: 'd'.repeat(61), open: '', close: '', closed: false }] })),
    [['business_hours', 'long', 0]]
  );
});

// ------------------------------------------------------------ what is sent

test('links travel normalised: instagram.com/x is sent as https://instagram.com/x — the value the page will show', () => {
  const body = patchFromForm(
    form({
      social_links: [['  Instagram ', ' instagram.com/ali3d '], ['Facebook', ''], ['', '']],
      profile_links: [
        { icon: 'globe', title: ' Site ', url: 'ali3d.iq', visible: true },
        { icon: 'link', title: '', url: '', visible: true },
      ],
    }),
    store()
  );
  assert.deepEqual(body.social_links, { Instagram: 'https://instagram.com/ali3d' }, 'trimmed key, normalised address, empty rows not sent');
  assert.deepEqual(body.profile_links, [{ icon: 'globe', title: 'Site', url: 'https://ali3d.iq/', visible: true }]);
});

test('a closed day travels closed, with no times; a row with no day is not sent', () => {
  const body = patchFromForm(
    form({
      business_hours: [
        { day: 'Fri', open: '09:00', close: '12:00', closed: true },
        { day: 'Sat', open: '09:00', close: '18:00', closed: false },
        { day: '  ', open: '09:00', close: '18:00', closed: false },
      ],
    }),
    store()
  );
  assert.deepEqual(body.business_hours, [
    { day: 'Fri', open: '', close: '', closed: true },
    { day: 'Sat', open: '09:00', close: '18:00' },
  ]);
});

test('`open` is sent only when it changed, and never for a suspended store', () => {
  assert.equal('open' in patchFromForm(form(), store()), false);
  assert.equal(patchFromForm(form({ open: false }), store()).open, false);
  assert.equal(patchFromForm(form({ open: true }), store({ status: 'paused' } as Partial<MerchantStore>)).open, true);
  assert.equal('open' in patchFromForm(form({ open: true }), store({ status: 'suspended' } as Partial<MerchantStore>)), false);
});

test('pictures: a removed logo is sent as empty — the server reads that as «no logo»', () => {
  const body = patchFromForm(form({ logo_key: null, banner_key: 'merchants/u/covers/b.webp' }), store());
  assert.equal(body.logo_key, '');
  assert.equal(body.banner_key, 'merchants/u/covers/b.webp');
});

// ------------------------------------------------------------ refusals → fields

test('a refusal the server named becomes the field it is about', () => {
  assert.deepEqual(fieldErrorFromRefusal('STORE_FIELD_INVALID', { field: 'name', min: 2, max: 60, reason: 'short' }), {
    field: 'name', kind: 'short', min: 2, max: 60,
  });
  assert.deepEqual(fieldErrorFromRefusal('STORE_FIELD_INVALID', { field: 'tagline', min: 0, max: 140, reason: 'long' }), {
    field: 'tagline', kind: 'long', min: 0, max: 140,
  });
  assert.deepEqual(fieldErrorFromRefusal('STORE_FIELD_INVALID', { field: 'profile_links', index: 1 }), {
    field: 'profile_links', kind: 'invalid_url', index: 1,
  });
  assert.deepEqual(fieldErrorFromRefusal('STORE_FIELD_INVALID', { field: 'accent' }), { field: 'accent', kind: 'invalid' });
  assert.deepEqual(fieldErrorFromRefusal('MEDIA_NOT_OWNED', { field: 'logo_key' }), { field: 'logo_key', kind: 'not_owned' });
  // Anything else is not a field's problem: the screen says it in a sentence.
  assert.equal(fieldErrorFromRefusal('STORE_SUSPENDED', undefined), null);
  assert.equal(fieldErrorFromRefusal('STORE_FIELD_INVALID', undefined), null);
});

test('a refused social link is found by its KEY; a refused header link by its place among the rows SENT', () => {
  assert.equal(socialRowForKey([['Instagram', 'a'], ['X', 'b']], 'X'), 1);
  assert.equal(socialRowForKey([['Instagram', 'a']], ' Instagram '), 0);
  assert.equal(socialRowForKey([['Instagram', 'a']], 'Nope'), undefined);
  // Only titled rows are sent, so the second SENT row is the form's third.
  const rows = [
    { icon: 'globe', title: 'A', url: 'a.iq', visible: true },
    { icon: 'globe', title: ' ', url: '', visible: true },
    { icon: 'globe', title: 'C', url: 'bad', visible: true },
  ];
  assert.equal(widgetRowForSentIndex(rows, 1), 2);
  assert.equal(widgetRowForSentIndex(rows, 0), 0);
  assert.equal(widgetRowForSentIndex(rows, 5), undefined);
  assert.equal(widgetRowForSentIndex(rows, 'x'), undefined);
});

// ------------------------------------------------------------ the shared link rule

test('profileHref: what people type becomes an address; anything that is not one is null', () => {
  assert.equal(profileHref('instagram.com/ali3d'), 'https://instagram.com/ali3d');
  assert.equal(profileHref('  https://t.me/ali3d  '), 'https://t.me/ali3d');
  assert.equal(profileHref('http://ali3d.iq'), 'http://ali3d.iq/', 'plain http stays allowed for profile links');
  assert.equal(profileHref('wa.me/9647800000001'), 'https://wa.me/9647800000001');
  for (const bad of [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', 'mailto:a@b.co', 'tel:+964',
    'ftp://ali3d.iq', 'whatsapp://send?phone=1', 'https://user:pass@ali3d.iq', 'localhost:3000', 'ali3d', 'not a link',
    'https://ali3d.iq/\\evil', 'https://[::1]/', '', '   ', `https://ali3d.iq/${'a'.repeat(300)}`,
  ]) {
    assert.equal(profileHref(bad), null, bad);
  }
  assert.equal(profileHref(42), null);
});

// ------------------------------------------------------------ in step with the server

test('the form\'s limits are the route\'s own — read from worker/routes/merchant.ts', () => {
  const route = readFileSync(join(ROOT, 'worker/routes/merchant.ts'), 'utf8');
  const limit = (re: RegExp) => {
    const m = route.match(re);
    assert.ok(m, `not found: ${re}`);
    return m!.slice(1).map(Number);
  };
  assert.deepEqual(limit(/storeText\(body\.name, 'name', \{ min: (\d+), max: (\d+) \}\)/), [LIMITS.name.min, LIMITS.name.max]);
  assert.deepEqual(limit(/storeText\(body\.tagline, 'tagline', \{ min: 0, max: (\d+)/), [LIMITS.tagline.max]);
  assert.deepEqual(limit(/storeText\(body\.description, 'description', \{ min: 0, max: (\d+)/), [LIMITS.description.max]);
  assert.deepEqual(limit(/storeText\(body\.contact_phone, 'contact_phone', \{ min: 0, max: (\d+)/), [LIMITS.phone.max]);
  assert.deepEqual(limit(/sanitizeMap\(body\.policies, (\d+), (\d+)\)/), [LIMITS.policies, LIMITS.policyText]);
  assert.deepEqual(limit(/sanitizeList\(body\[key\], (\d+), (\d+)\)/), [LIMITS.list, LIMITS.listItem]);
  assert.deepEqual(limit(/const key = k\.trim\(\)\.slice\(0, (\d+)\);\s*if \(!key \|\| !val\.trim\(\)\) continue;\s*if \(Object\.keys\(out\)\.length >= (\d+)\) break;/), [
    LIMITS.socialKey,
    LIMITS.social,
  ]);
  assert.deepEqual(limit(/const day = typeof r\.day === 'string' \? r\.day\.trim\(\)\.slice\(0, (\d+)\)/), [LIMITS.day]);
  assert.deepEqual(limit(/\.filter\(\(r\): r is \{ day: string; open: string; close: string; closed\?: true \} => !!r && !!r\.day\)\s*\.slice\(0, (\d+)\)/), [LIMITS.hours]);
  assert.deepEqual(limit(/if \(out\.length >= (\d+)\) break;/), [LIMITS.widgets]);
  assert.deepEqual(limit(/r\.title\.trim\(\)\.slice\(0, (\d+)\)/), [LIMITS.widgetTitle]);
  assert.deepEqual(limit(/r\.subtitle\.trim\(\)\.slice\(0, (\d+)\)/), [LIMITS.widgetSubtitle]);
  // The policy title: sanitizeMap keeps 40 characters of a key.
  assert.deepEqual(limit(/out\[k\.slice\(0, (\d+)\)\] = val\.slice\(0, maxLen\)/), [LIMITS.policyTitle]);
});
