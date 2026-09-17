import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BRAND_SLOTS,
  MAIN_PAGE_PREFIX,
  SERVICE_SLOTS,
  SITE_MEDIA_SLOTS,
  findSiteMediaSlot,
  isSiteMediaObject,
  mintSiteMediaObject,
  normalizeSiteMedia,
  resolveSiteMedia,
  siteMediaKey,
} from '../worker/lib/siteMedia';
import { isAnonymousPublicMediaKey, isSafeMediaKey } from '../worker/lib/mediaStorage';

/**
 * The seven marks the owner asked for, spelled as the OBJECTS IN THE BUCKET
 * are spelled — `Bamabulab.webp` included. If someone "corrects" that to
 * `Bambulab.webp` the strip silently renders seven broken images, because the
 * file under the corrected name does not exist. This test is the tripwire.
 */
test('the seeded brand defaults name the objects that are actually in R2', () => {
  assert.deepEqual(
    BRAND_SLOTS.map((s) => s.defaultObject),
    ['Bamabulab.webp', 'Creality.webp', 'Qidi.webp', 'Biqu.webp', 'Bigtreetech.webp', 'Esun.webp', 'Antinsky.webp']
  );
  assert.equal(BRAND_SLOTS.length, 7);
});

test('every brand default resolves to a key an anonymous visitor may fetch', () => {
  // The home page is the first thing a signed-out visitor sees. A brand mark
  // that needs a session is not a private asset, it is a broken one.
  for (const slot of BRAND_SLOTS) {
    const key = siteMediaKey(slot.defaultObject);
    assert.ok(isSafeMediaKey(key), `${key} is not a safe media key`);
    assert.ok(isAnonymousPublicMediaKey(key), `${key} would not be served to a signed-out visitor`);
  }
});

test('resolve marks defaults and uploads apart, and gives every slot a url or an empty string', () => {
  const fresh = resolveSiteMedia({});
  assert.equal(fresh.length, SITE_MEDIA_SLOTS.length);

  const bambu = fresh.find((m) => m.slot === 'brand-bambulab')!;
  assert.equal(bambu.url, `/files/${MAIN_PAGE_PREFIX}Bamabulab.webp`);
  assert.equal(bambu.custom, false);

  // Service slots ship with no default on purpose: the drawn lucide icon is a
  // design, so an empty url means "keep drawing it", not "show a hole".
  for (const s of SERVICE_SLOTS) {
    assert.equal(fresh.find((m) => m.slot === s.slot)!.url, '');
  }

  const edited = resolveSiteMedia({ 'brand-bambulab': 'brand-bambulab-ab12cd.webp' });
  const replaced = edited.find((m) => m.slot === 'brand-bambulab')!;
  assert.equal(replaced.url, `/files/${MAIN_PAGE_PREFIX}brand-bambulab-ab12cd.webp`);
  assert.equal(replaced.custom, true);
  // Replacing one slot must not disturb its neighbours.
  assert.equal(edited.find((m) => m.slot === 'brand-creality')!.url, `/files/${MAIN_PAGE_PREFIX}Creality.webp`);
});

test('a stored value is re-validated on the way out, not trusted', () => {
  // mainPageMedia round-trips through a JSON settings row. Anything that got
  // in by another path must not become a URL the storefront renders.
  const hostile = normalizeSiteMedia({
    'brand-qidi': '../../../etc/passwd',
    'brand-biqu': 'logo.png',
    'brand-esun': 'sub/dir/logo.webp',
    'brand-antinsky': '',
    'not-a-slot': 'whatever.webp',
    'brand-creality': 'creality-9f3a.webp',
  });
  assert.deepEqual(hostile, { 'brand-creality': 'creality-9f3a.webp' });
});

test('only a bare .webp filename is accepted as an object name', () => {
  assert.ok(isSiteMediaObject('Bamabulab.webp'));
  assert.ok(isSiteMediaObject('brand-qidi-0a1b2c.webp'));
  assert.ok(!isSiteMediaObject('logo.png'), 'the owner asked for webp only');
  assert.ok(!isSiteMediaObject('a/b.webp'), 'no directories');
  assert.ok(!isSiteMediaObject('../b.webp'), 'no traversal');
  assert.ok(!isSiteMediaObject('.hidden.webp'), 'must start alphanumeric');
  assert.ok(!isSiteMediaObject(''));
  assert.ok(!isSiteMediaObject(null));
});

test('a minted name is unique per upload, safe, and still a webp', () => {
  // Every upload must land on a NEW key: /files/* stamps public objects
  // `immutable` for a year, so overwriting one would leave caches serving the
  // old logo with no way to purge them from the app.
  const first = mintSiteMediaObject('brand-bambulab', 'A1b2C3d4E5f6');
  const second = mintSiteMediaObject('brand-bambulab', 'Z9y8X7w6V5u4');
  assert.notEqual(first, second);
  for (const name of [first, second]) {
    assert.ok(isSiteMediaObject(name), `${name} is not a valid object name`);
    assert.ok(isAnonymousPublicMediaKey(siteMediaKey(name)));
  }
  // A hostile slot id cannot escape the prefix even though the route already
  // rejects unknown slots.
  assert.ok(isSiteMediaObject(mintSiteMediaObject('../../evil', 'abc123')));
});

test('service slot ids match the ids ServicesGrid already renders', () => {
  // The storefront looks a card's image up as `service-${card.id}` using the
  // id it already puts in data-service. Renaming either side silently stops
  // the lookup matching, so the pairing is asserted here.
  assert.deepEqual(
    SERVICE_SLOTS.map((s) => s.slot),
    ['service-studio', 'service-warranty', 'service-tools', 'service-bundles', 'service-community', 'service-rewards']
  );
});

test('slots are unique and every one is findable by id', () => {
  const ids = SITE_MEDIA_SLOTS.map((s) => s.slot);
  assert.equal(new Set(ids).size, ids.length, 'duplicate slot id');
  for (const id of ids) assert.ok(findSiteMediaSlot(id));
  assert.equal(findSiteMediaSlot('nope'), null);
  assert.equal(findSiteMediaSlot(42), null);
});
