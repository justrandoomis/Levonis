/**
 * THE IMPORT'S LISTING FACETS (the Bambu import spec §G.5 «Filters»;
 * packages/catalog/src/discovery.ts FACET_FIELDS, worker/lib/listingFacets.ts,
 * packages/catalog/src/facetVocabulary.ts, src/lib/catalog/listingModel.ts).
 *
 *   1. the grammar: `family` and `spool` in a page URL, `f.product_family` and
 *      `f.spool_type` in the API; unknown values dropped;
 *   2. the tokens a product answers: the family code, the spool pieces, the
 *      base colours of a multi-valued `color_name` ("white | black") — and an
 *      admin's own single colour exactly as before;
 *   3. filtering and disjunctive counts over a mixed candidate set;
 *   4. the real route over the live catalogue;
 *   5. the words: titles, spool values, base colours and families in
 *      ar / en / ckb, the Sorani never the Arabic.
 *
 * Run: node --import tsx --test tests/listingFacetsImport.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asD1, freshDb, get, json, stubApp } from './fixtures/app';
import { P, seedLiveCatalog } from './fixtures/liveCatalog';
import { productRoutes } from '../worker/routes/products';
import { applyFilters, facetCounts, facetTokensOf, type ListingItem } from '../worker/lib/listingFacets';
import {
  DEFAULT_LISTING,
  FACET_FIELDS,
  facetToken,
  familyToken,
  listingParamPairs,
  parseListingParams,
  spoolToken,
} from '../packages/catalog/src/discovery';
import { BASE_COLOURS } from '../packages/catalog/src/bambuImport/registry/colours';
import { FAMILY_LABELS, IMPORT_FACET_TITLES, SPOOL_LABELS, baseColourLabel, familyLabel } from '../packages/catalog/src/facetVocabulary';
import { facetTitle, sheetSections, specValueLabel } from '../src/lib/catalog/listingModel';

// ------------------------------------------------------------------ 1. the grammar

test('the two new facets travel as `family` / `spool` on a page and `f.<field>` in the API', () => {
  assert.equal(FACET_FIELDS.product_family, 'family');
  assert.equal(FACET_FIELDS.spool_type, 'spool');
  const page = parseListingParams((k) => ({ family: 'bambu_filament,Bambu Lab 3D Printers,../x', spool: 'refill,cardboard,spool' } as Record<string, string>)[k], 'page');
  assert.deepEqual(page.specs.product_family, ['bambu_filament', 'bambu_lab_3d_printers'], 'codes and words read alike; junk dropped');
  assert.deepEqual(page.specs.spool_type, ['refill', 'spool'], 'only the two spool tokens');
  const api = listingParamPairs({ ...DEFAULT_LISTING, specs: { spool_type: ['refill'], product_family: ['bambu_filament'] } }, 'api');
  assert.deepEqual(api, [['f.product_family', 'bambu_filament'], ['f.spool_type', 'refill']].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  assert.equal(facetToken('spool_type', 'Refill'), 'refill');
  assert.equal(facetToken('product_family', 'bambu_lab_ams'), 'bambu_lab_ams');
  assert.equal(facetToken('color_name', 'White'), 'white');
});

test('spool and family words → tokens; nothing guessed', () => {
  assert.equal(spoolToken('Refill'), 'refill');
  assert.equal(spoolToken('Refill (No Spool)'), 'refill');
  assert.equal(spoolToken('With spool'), 'spool');
  assert.equal(spoolToken('Filament with spool'), 'spool');
  assert.equal(spoolToken('Cardboard'), 'spool', 'the form’s cardboard spool is a spool');
  assert.equal(spoolToken('Vacuum bag'), null);
  assert.equal(spoolToken(''), null);
  assert.equal(familyToken('Bambu Lab 3D Printers'), 'bambu_lab_3d_printers');
  assert.equal(familyToken('bambu_filament'), 'bambu_filament');
  assert.equal(familyToken('بامبو'), null, 'a family code is Latin');
});

// ------------------------------------------------------------------ 2. the tokens

test('a product’s tokens: the family, each spool piece, each base colour; an admin’s own colour as before', () => {
  assert.deepEqual(facetTokensOf('product_family', { product_family: 'bambu_filament' }), ['bambu_filament']);
  assert.deepEqual(facetTokensOf('product_family', {}), [], 'no family, no token — never assumed');
  assert.deepEqual(facetTokensOf('spool_type', { spool_type: 'Refill | With spool' }), ['refill', 'spool']);
  assert.deepEqual(facetTokensOf('spool_type', { spool_type: 'Refill, With spool' }), ['refill', 'spool'], 'the form’s list reads the same');
  assert.deepEqual(facetTokensOf('spool_type', { spool_type: 'Refill' }), ['refill']);
  assert.deepEqual(facetTokensOf('color_name', { color_name: 'white | black | multicolour' }), ['white', 'black', 'multicolour']);
  // Before the import every colour was ONE value and its token was the whole text: unchanged.
  assert.deepEqual(facetTokensOf('color_name', { color_name: 'Matte Black' }), ['matte black']);
  assert.deepEqual(facetTokensOf('color_name', { color_name: 'Black|White' }), ['black|white'], 'only " | " separates');
  assert.deepEqual(facetTokensOf('color_name', { color_name: '' }), []);
});

const item = (id: string, specs: Record<string, unknown>, rank: number): ListingItem => ({
  id,
  card: { id },
  name: id,
  price: null,
  regular: null,
  prime: null,
  pro: null,
  available: 0,
  saleTypes: [],
  brandId: null,
  brandSlug: null,
  fits: [],
  createdAt: '2026-10-01',
  rank,
  scheduledOffer: false,
  priced: false,
  specs,
});

// ------------------------------------------------------------------ 3. filtering, counts

test('filters and disjunctive counts over a mixed set: an imported filament matches each of its colours', () => {
  const all = [
    item('pla', { color_name: 'white | black', spool_type: 'Refill | With spool', product_family: 'bambu_filament' }, 0),
    item('petg', { color_name: 'black', spool_type: 'With spool', product_family: 'bambu_filament' }, 1),
    item('old', { color_name: 'Galaxy Purple' }, 2),
  ];
  const byColour = (c: string) => applyFilters(all, { ...DEFAULT_LISTING, specs: { color_name: [c] } }).map((i) => i.id);
  assert.deepEqual(byColour('black'), ['pla', 'petg']);
  assert.deepEqual(byColour('white'), ['pla']);
  assert.deepEqual(byColour('galaxy purple'), ['old'], 'an admin’s colour is still a value of its own');
  assert.deepEqual(applyFilters(all, { ...DEFAULT_LISTING, specs: { spool_type: ['refill'] } }).map((i) => i.id), ['pla']);
  assert.deepEqual(applyFilters(all, { ...DEFAULT_LISTING, specs: { product_family: ['bambu_filament'] } }).map((i) => i.id), ['pla', 'petg']);
  const f = facetCounts(all, { ...DEFAULT_LISTING, specs: { spool_type: ['refill'] } }, new Map());
  assert.deepEqual(f.specs.spool_type, [{ value: 'refill', label: 'refill', count: 1 }, { value: 'spool', label: 'spool', count: 2 }]);
  assert.deepEqual(
    f.specs.color_name?.map((o) => [o.value, o.label, o.count]),
    [['black', 'black', 1], ['galaxy purple', 'Galaxy Purple', 0], ['white', 'white', 1]],
    'counted under the spool filter; each colour piece is its own option, an admin colour keeps its words'
  );
  assert.deepEqual(f.specs.product_family?.map((o) => [o.value, o.count]), [['bambu_filament', 1]]);
});

// ------------------------------------------------------------------ 4. the route

test('the real listing: the materials shelf offers family, spool and base colours, and filters by them', async () => {
  const raw = freshDb();
  seedLiveCatalog(raw);
  raw.exec(`UPDATE products SET spec_fields = json_set(spec_fields, '$.color_name', 'white | black', '$.spool_type', 'Refill | With spool', '$.product_family', 'bambu_filament') WHERE id = '${P.PLA}'`);
  const app = stubApp(asD1(raw), null, (a) => a.route('/api/products', productRoutes));
  const b = await json(await get(app, '/api/products?category=cat_materials&facets=1'));
  assert.deepEqual(b.facets.specs.product_family.map((o: { value: string }) => o.value), ['bambu_filament']);
  assert.deepEqual(b.facets.specs.spool_type.map((o: { value: string }) => o.value), ['refill', 'spool']);
  assert.deepEqual(b.facets.specs.color_name.map((o: { value: string }) => o.value), ['black', 'white']);
  const white = await json(await get(app, '/api/products?category=cat_materials&f.color_name=white&f.spool_type=refill'));
  assert.deepEqual(white.products.map((p: { id: string }) => p.id), [P.PLA]);
  const none = await json(await get(app, '/api/products?category=cat_materials&f.product_family=bambu_lab_ams'));
  assert.deepEqual(none.products, []);
});

// ------------------------------------------------------------------ 5. the words

test('every new word in three languages, exactly as the spec writes them; the Sorani never the Arabic', () => {
  assert.deepEqual(IMPORT_FACET_TITLES.product_family, { ar: 'العائلة', en: 'Family', ckb: 'خێزان' });
  assert.deepEqual(IMPORT_FACET_TITLES.spool_type, { ar: 'البكرة', en: 'Spool', ckb: 'ماسوورە' });
  assert.deepEqual(SPOOL_LABELS.refill, { ar: 'عبوة بدون بكرة', en: 'Refill', ckb: 'پڕکردنەوە بەبێ ماسوورە' });
  assert.deepEqual(SPOOL_LABELS.spool, { ar: 'مع بكرة', en: 'With spool', ckb: 'لەگەڵ ماسوورە' });
  const spec: Record<string, [string, string, string]> = {
    black: ['أسود', 'Black', 'ڕەش'], white: ['أبيض', 'White', 'سپی'], grey: ['رمادي', 'Grey', 'خۆڵەمێشی'],
    red: ['أحمر', 'Red', 'سوور'], orange: ['برتقالي', 'Orange', 'پرتەقاڵی'], yellow: ['أصفر', 'Yellow', 'زەرد'],
    green: ['أخضر', 'Green', 'سەوز'], blue: ['أزرق', 'Blue', 'شین'], purple: ['بنفسجي', 'Purple', 'مۆر'],
    pink: ['وردي', 'Pink', 'پەمەیی'], brown: ['بني', 'Brown', 'قاوەیی'], beige: ['بيج', 'Beige', 'بێژ'],
    gold: ['ذهبي', 'Gold', 'زێڕین'], silver: ['فضي', 'Silver', 'زیوی'],
    transparent: ['شفاف', 'Transparent', 'ڕوون'], multicolour: ['متعدد الألوان', 'Multicolour', 'فرەڕەنگ'],
  };
  assert.deepEqual(Object.keys(BASE_COLOURS).sort(), Object.keys(spec).sort());
  for (const [k, [ar, en, ckb]] of Object.entries(spec)) assert.deepEqual(baseColourLabel(k), { ar, en, ckb }, k);
  for (const w of [...Object.values(IMPORT_FACET_TITLES), ...Object.values(SPOOL_LABELS), ...Object.values(BASE_COLOURS), ...Object.values(FAMILY_LABELS)]) {
    assert.ok(w.ar && w.en && w.ckb);
    assert.notEqual(w.ckb, w.ar, `${w.en}: the Sorani copies the Arabic`);
  }
  assert.equal(baseColourLabel('galaxy purple'), null);
  assert.deepEqual(familyLabel('bambu_new_family'), { ar: 'bambu new family', en: 'bambu new family', ckb: 'bambu new family' });
});

test('the page draws them: titles, values and base colours in the reader’s language; the filament sheet lists them', () => {
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    assert.equal(facetTitle('product_family', lang), IMPORT_FACET_TITLES.product_family[lang]);
    assert.equal(facetTitle('spool_type', lang), IMPORT_FACET_TITLES.spool_type[lang]);
    assert.equal(specValueLabel('spool_type', 'refill', lang), SPOOL_LABELS.refill[lang]);
    assert.equal(specValueLabel('color_name', 'white', lang, 'white'), BASE_COLOURS.white[lang]);
    assert.equal(specValueLabel('product_family', 'bambu_filament', lang), FAMILY_LABELS.bambu_filament[lang]);
  }
  assert.equal(specValueLabel('color_name', 'galaxy purple', 'ar', 'Galaxy Purple'), 'Galaxy Purple', 'an admin’s colour is shown as typed');
  const facets = {
    total: 3,
    avail: { now: 0 },
    sale: { direct: 0, preorder: 0 },
    price: { min: null, max: null, histogram: [] },
    brands: [],
    printers: [],
    offer: 0,
    member: 0,
    specs: {
      spool_type: [{ value: 'refill', count: 1 }, { value: 'spool', count: 2 }],
      product_family: [{ value: 'bambu_filament', count: 2 }, { value: 'bambu_lab_ams', count: 1 }],
    },
  };
  const sections = sheetSections('filament', facets, DEFAULT_LISTING);
  assert.ok(sections.includes('spool_type') && sections.includes('product_family'), sections.join(','));
});
