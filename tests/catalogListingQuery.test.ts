/**
 * THE LISTING'S URL GRAMMAR (catalog discovery S0, docs/ux/IMPLEMENTATION_PLAN.md).
 *
 * The page writes this state into a link people share, and the Worker reads the
 * same grammar out of `/api/products` (packages/catalog/src/discovery.ts is the
 * one parser). What must hold: every parameter round-trips, an unknown value is
 * DROPPED rather than thrown or guessed, and the default state is ''.
 *
 * Run: node --import tsx --test tests/catalogListingQuery.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeFilterCount,
  emptyListing,
  hasListingFilters,
  listingApiQuery,
  parseListing,
  serializeListing,
} from '../src/lib/catalog/listingQuery';
import { parseListingParams } from '../packages/catalog/src/discovery';
import type { ListingState } from '../src/lib/catalog/types';

const roundTrip = (s: ListingState) => parseListing(serializeListing(s));

test('the default state serialises to the empty string, and parses back to itself', () => {
  assert.equal(serializeListing(emptyListing()), '');
  assert.deepEqual(parseListing(''), emptyListing());
  assert.deepEqual(parseListing('?'), emptyListing());
  assert.equal(hasListingFilters(emptyListing()), false);
});

test('every parameter round-trips', () => {
  const cases: Array<[string, Partial<ListingState>]> = [
    ['q', { q: 'h2' }],
    ['sort newest', { sort: 'newest' }],
    ['sort price_asc', { sort: 'price_asc' }],
    ['sort price_desc', { sort: 'price_desc' }],
    ['sort name', { sort: 'name' }],
    ['sort available', { sort: 'available' }],
    ['sort direct', { sort: 'direct' }],
    ['avail', { avail: true }],
    ['sale direct', { sale: 'direct' }],
    ['sale preorder', { sale: 'preorder' }],
    ['price closed', { price: { min: 500000, max: 2500000 } }],
    ['price open top', { price: { min: 500000, max: null } }],
    ['price open bottom', { price: { min: null, max: 750000 } }],
    ['brands', { brands: ['bambu-lab', 'snapmaker'] }],
    ['offer', { offer: true }],
    ['member', { member: true }],
    ['tech', { specs: { technology: ['fdm'] } }],
    ['colors', { specs: { max_colors: ['16-20', '24-'] } }],
    ['size', { specs: { build_volume: ['large'] } }],
    ['enclosed', { specs: { enclosed: ['1'] } }],
    ['level', { specs: { skill_level: ['beginner'] } }],
    ['material', { specs: { material_type: ['petg', 'pla'] } }],
    ['diameter', { specs: { diameter: ['1.75'] } }],
    ['color', { specs: { color_name: ['black'] } }],
  ];
  for (const [label, patch] of cases) {
    const state = { ...emptyListing(), ...patch };
    const s = serializeListing(state);
    assert.notEqual(s, '', `${label} must serialise`);
    assert.deepEqual(roundTrip(state), state, `${label} must round-trip (${s})`);
  }
});

test('the design\'s example link parses to exactly the filters it shows, and re-serialises in one stable order', () => {
  const url = '?sort=price_asc&avail=1&sale=direct&price=500000-2500000&brand=snapmaker,bambu-lab&colors=24-&size=large&enclosed=1&level=beginner&q=h2';
  const s = parseListing(url);
  assert.equal(s.q, 'h2');
  assert.equal(s.sort, 'price_asc');
  assert.equal(s.avail, true);
  assert.equal(s.sale, 'direct');
  assert.deepEqual(s.price, { min: 500000, max: 2500000 });
  assert.deepEqual(s.brands, ['bambu-lab', 'snapmaker'], 'sorted: two equal states are one string');
  assert.deepEqual(s.specs, { max_colors: ['24-'], build_volume: ['large'], enclosed: ['1'], skill_level: ['beginner'] });
  assert.equal(activeFilterCount(s), 8);
  assert.equal(
    serializeListing(s),
    'q=h2&sort=price_asc&avail=1&sale=direct&price=500000-2500000&brand=bambu-lab,snapmaker&colors=24-&size=large&enclosed=1&level=beginner'
  );
});

test('an unknown value is dropped — never thrown, never guessed', () => {
  const s = parseListing(
    'sort=cheapest&avail=yes&sale=both&price=9-1&brand=Bad%20Slug,ok-brand&colors=many&size=huge&enclosed=maybe&level=guru&tech=sla&diameter=wide&material=%3Cscript%3E&member=true&offer=2&x=1'
  );
  assert.deepEqual(s, { ...emptyListing(), brands: ['ok-brand'] });
  assert.equal(serializeListing(s), 'brand=ok-brand');
});

test('lists are bounded and deduplicated, and a reversed range is refused', () => {
  const brands = Array.from({ length: 30 }, (_, i) => `b${i}`).join(',');
  assert.equal(parseListing(`brand=${brands}`).brands.length, 10);
  assert.deepEqual(parseListing('brand=a,a,A').brands, ['a']);
  assert.deepEqual(parseListing('colors=16,16,16-20').specs.max_colors, ['16', '16-20']);
  assert.equal(parseListing('price=2000-1000').price, null);
  assert.deepEqual(parseListing('colors=20-16').specs, {});
  assert.equal(parseListing(`q=${'x'.repeat(300)}`).q.length, 100);
});

test('the API query uses the API vocabulary (search, f.<field>) and the same values', () => {
  const s = parseListing('q=h2&colors=24-&brand=bambu-lab&avail=1');
  const api = listingApiQuery(s, { category: 'cat_printers_fdm', facets: true, limit: 24, offset: 24 });
  assert.equal(api, 'category=cat_printers_fdm&search=h2&avail=1&brand=bambu-lab&f.max_colors=24-&facets=1&limit=24&offset=24');
  const back = parseListingParams((k) => new URLSearchParams(api).get(k), 'api');
  assert.deepEqual(back, s, 'the Worker reads back the state the page wrote');
});
