/**
 * The governorate list exists twice — once for the Worker, once for the SPA,
 * because the two are built independently and neither can import the other's
 * module graph. Two copies of the same data drift; this makes them fail loudly
 * instead of quietly disagreeing about what a stored id means.
 *
 * Also pins the normalizer, which is the thing standing between a courier
 * routing on "بغداد" and routing on "Bagdad".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IRAQ_GOVERNORATES,
  governorateName,
  normalizeGovernorate,
} from '../worker/lib/iraqGovernorates';
import { GOVERNORATES } from '../src/lib/governorates';

test('the Worker and the SPA hold exactly the same list, in the same order', () => {
  assert.deepEqual(
    GOVERNORATES.map((g) => ({ id: g.id, ar: g.ar, en: g.en, ckb: g.ckb })),
    IRAQ_GOVERNORATES.map((g) => ({ id: g.id, ar: g.ar, en: g.en, ckb: g.ckb }))
  );
});

test('there are eighteen governorates, and every id is unique', () => {
  // Iraq has eighteen. A nineteenth entry is a typo, not a new province.
  assert.equal(IRAQ_GOVERNORATES.length, 18);
  assert.equal(new Set(IRAQ_GOVERNORATES.map((g) => g.id)).size, 18);
});

test('every entry carries all three languages', () => {
  for (const g of IRAQ_GOVERNORATES) {
    assert.ok(g.ar, `${g.id} has no Arabic name`);
    assert.ok(g.en, `${g.id} has no English name`);
    assert.ok(g.ckb, `${g.id} has no Kurdish name`);
  }
});

test('an id round-trips', () => {
  for (const g of IRAQ_GOVERNORATES) {
    assert.equal(normalizeGovernorate(g.id), g.id);
  }
});

test('a NAME in any of the three languages resolves to the id', () => {
  // A client that sends the label rather than the id must not silently store
  // nothing — that is a parcel with no governorate on it.
  assert.equal(normalizeGovernorate('بغداد'), 'baghdad');
  assert.equal(normalizeGovernorate('Baghdad'), 'baghdad');
  assert.equal(normalizeGovernorate('baghdad'), 'baghdad');
  assert.equal(normalizeGovernorate('BAGHDAD'), 'baghdad');
  assert.equal(normalizeGovernorate('بەغدا'), 'baghdad');
  assert.equal(normalizeGovernorate('  السليمانية  '), 'sulaymaniyah');
});

test('anything that is not one of the eighteen normalizes to empty', () => {
  // Empty is honest: the field is not filled. A guess would put a parcel on
  // the wrong truck.
  assert.equal(normalizeGovernorate('Atlantis'), '');
  assert.equal(normalizeGovernorate(''), '');
  assert.equal(normalizeGovernorate('   '), '');
  assert.equal(normalizeGovernorate(null), '');
  assert.equal(normalizeGovernorate(42), '');
  assert.equal(normalizeGovernorate({ id: 'baghdad' }), '');
});

test('governorateName gives the right language, and never invents one', () => {
  assert.equal(governorateName('baghdad', 'ar'), 'بغداد');
  assert.equal(governorateName('baghdad', 'en'), 'Baghdad');
  assert.equal(governorateName('baghdad', 'ckb'), 'بەغدا');
  // An id the list does not know (a row written before the closed list) shows
  // what it actually holds rather than a blank or a placeholder.
  assert.equal(governorateName('some_old_value', 'ar'), 'some_old_value');
});
