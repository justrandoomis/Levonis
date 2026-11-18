/**
 * SEARCH UPGRADE (owner, 2026-11-18): search by photo answers only with the
 * shop's own products and their own colours/options; the scan puts any code in
 * the field; the placeholder types popular products; recent searches stay on
 * the device; section shortcuts come from the rows themselves.
 *
 * Run: node --import tsx --test tests/searchImage.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  candidateOf,
  candidateText,
  colourSelection,
  imageSearchFromSetting,
  photoOf,
  pictureKeyOf,
  searchTexts,
  validatePick,
  validateRead,
  IMAGE_SEARCH_DEFAULT,
} from '../worker/lib/search/imageSearch';
import { popularLabel } from '../src/components/search/popularLabel';

const JPEG_HEAD = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1)) + 'AAAA';
const PNG_HEAD = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0));

const row = (id: string, name: string, colours: string[] = [], options: string[] = []) => ({
  id,
  name,
  brand: 'Bambu Lab',
  colors: JSON.stringify(colours.map((n, i) => ({ id: `${id}-col${i}`, name_en: n, name_ar: n }))),
  options: JSON.stringify(options.map((n, i) => ({ id: `${id}-opt${i}`, name_en: n }))),
});

test('the switch: on by default, off only for a literal false, bad values keep the default', () => {
  assert.deepEqual(imageSearchFromSetting(null), IMAGE_SEARCH_DEFAULT);
  assert.deepEqual(imageSearchFromSetting('not json'), IMAGE_SEARCH_DEFAULT);
  assert.equal(imageSearchFromSetting('{"enabled":false}').enabled, false);
  assert.equal(imageSearchFromSetting('{"enabled":"false"}').enabled, true);
  assert.equal(imageSearchFromSetting('{"daily":50}').daily, 50);
  assert.equal(imageSearchFromSetting('{"daily":-3}').daily, IMAGE_SEARCH_DEFAULT.daily);
  assert.equal(imageSearchFromSetting('{"daily":999999}').daily, IMAGE_SEARCH_DEFAULT.daily);
});

test('the photo: the declared type must be the sniffed one', () => {
  assert.deepEqual(photoOf(`data:image/jpeg;base64,${JPEG_HEAD}`)?.mime, 'image/jpeg');
  assert.equal(photoOf(`data:image/png;base64,${JPEG_HEAD}`), null, 'a JPEG declared as PNG');
  assert.equal(photoOf(`data:image/png;base64,${PNG_HEAD}`)?.mime, 'image/png');
  assert.equal(photoOf('data:image/svg+xml;base64,PHN2Zz4='), null, 'SVG is never a photo');
  assert.equal(photoOf('https://example.com/a.jpg'), null);
  assert.equal(photoOf(`data:image/jpeg;base64,${'A'.repeat(2_100_000)}`), null, 'too large');
});

test('the read: bounded, cleaned, colour only from the enum, codes need three characters', () => {
  const r = validateRead({
    is_product: true,
    kind: ' 3D printer ',
    brand: 'Bambu Lab',
    model: 'A1 mini',
    colour: 'none',
    codes: ['A1M-0001', 'x', 'A1M-0001', '<b>'],
    queries: ['Bambu Lab A1 mini', 'Bambu Lab A1 mini', 'A1 mini combo', 'a', 'b'],
  });
  assert.ok(r);
  assert.equal(r.colour, null);
  assert.deepEqual(r.codes, ['A1M-0001']);
  assert.deepEqual(r.queries, ['Bambu Lab A1 mini', 'A1 mini combo', 'a']);
  assert.equal(validateRead({ is_product: 'yes' }), null);
  assert.equal(validateRead({ is_product: true, colour: 'black', codes: [], queries: [] })?.colour, 'black');
  assert.equal(validateRead({ is_product: true, colour: 'chartreuse', codes: [], queries: [] })?.colour, null);
});

test('the shop search is asked the brand and model first, then the phrases', () => {
  const base = { is_product: true, kind: 'printer', colour: null, codes: [] as string[] };
  assert.deepEqual(searchTexts({ ...base, brand: 'Bambu Lab', model: 'P1S', queries: ['3D printer enclosed'] }), ['Bambu Lab P1S', '3D printer enclosed']);
  assert.deepEqual(searchTexts({ ...base, brand: 'Bambu Lab', model: 'P1S', queries: ['bambu lab p1s combo'] }), ['bambu lab p1s combo']);
  assert.deepEqual(searchTexts({ ...base, brand: '', model: '', queries: [] }), ['printer']);
});

test('candidates list every own colour and option, keyed small', () => {
  const c = candidateOf(0, row('prd_1', 'PLA Matte', ['Matte Charcoal', 'Ivory White'], ['1 kg']));
  assert.equal(c.key, 'p1');
  assert.deepEqual(
    c.choices.map((x) => [x.key, x.name]),
    [['o1', '1 kg'], ['c2', 'Matte Charcoal'], ['c3', 'Ivory White']]
  );
  const text = candidateText([c], new Set(['p1']));
  assert.match(text, /^p1: PLA Matte \(brand: Bambu Lab\) \[picture attached\]\n {3}options: o1=1 kg; c2=Matte Charcoal; c3=Ivory White$/);
});

test('the colour match: one choice of that base colour, or none', () => {
  const c = candidateOf(0, row('prd_1', 'PLA', ['Jade White', 'Matte Black', 'Basic Black', 'Red']));
  assert.equal(colourSelection(c, 'white')?.name, 'Jade White');
  assert.equal(colourSelection(c, 'black'), null, 'two blacks: no guess');
  assert.equal(colourSelection(c, 'blue'), null);
  assert.equal(colourSelection(c, null), null);
});

test('the pick: only listed keys, only own options, «same» needs a high pick', () => {
  const list = [candidateOf(0, row('prd_a1', 'A1', ['Black', 'Grey'])), candidateOf(1, row('prd_mini', 'A1 mini', ['Black']))];
  const ok = validatePick(
    { verdict: 'same', picks: [{ key: 'p1', confidence: 'high', option: 'c2' }, { key: 'p9', confidence: 'high', option: '' }, { key: 'p1', confidence: 'low', option: '' }] },
    list,
    null
  );
  assert.ok(ok);
  assert.equal(ok.verdict, 'same');
  assert.equal(ok.picks.length, 1, 'an invented key and a repeat are dropped');
  assert.deepEqual(ok.picks[0].selection, { option_value_ids: [], color_id: 'prd_a1-col1', variant_id: null });
  assert.equal(ok.picks[0].via, 'model');

  // An option key of ANOTHER product is not this product's: the colour words decide instead.
  const foreign = validatePick({ verdict: 'same', picks: [{ key: 'p2', confidence: 'high', option: 'c2' }] }, list, 'black');
  assert.deepEqual(foreign?.picks[0].selection, { option_value_ids: [], color_id: 'prd_mini-col0', variant_id: null });
  assert.equal(foreign?.picks[0].via, 'colour');

  // «same» with no high pick is «similar»; a similar pick is never high.
  assert.equal(validatePick({ verdict: 'same', picks: [{ key: 'p1', confidence: 'medium', option: '' }] }, list, null)?.verdict, 'similar');
  const sim = validatePick({ verdict: 'similar', picks: [{ key: 'p2', confidence: 'high', option: '' }] }, list, null);
  assert.equal(sim?.picks[0].confidence, 'medium');

  // Nothing listed survives → none; «none» lists nothing.
  assert.deepEqual(validatePick({ verdict: 'same', picks: [{ key: 'zz', confidence: 'high', option: '' }] }, list, null), { verdict: 'none', picks: [] });
  assert.deepEqual(validatePick({ verdict: 'none', picks: [{ key: 'p1', confidence: 'high', option: '' }] }, list, null), { verdict: 'none', picks: [] });
  assert.equal(validatePick({ verdict: 'maybe', picks: [] }, list, null), null);
});

test('candidate pictures: only the catalogue’s own public picture keys', () => {
  assert.equal(pictureKeyOf('/files/products/catalog/gallery/abc.webp'), 'products/catalog/gallery/abc.webp');
  assert.equal(pictureKeyOf('/files/products/../private/x.webp'), null);
  assert.equal(pictureKeyOf('/files/kyc/x.webp'), null);
  assert.equal(pictureKeyOf('https://cdn.example.com/products/a.webp'), null);
});

test('the placeholder types a short name', () => {
  assert.equal(popularLabel('B7000 Clear Jewelry & Mobile Phone Repair Adhesive — 110 mL with Built-in Needle Tip'), 'B7000 Clear Jewelry & Mobile');
  assert.equal(popularLabel('Bambu Lab A1 mini Combo'), 'Bambu Lab A1 mini Combo');
  assert.equal(popularLabel('PLA Basic (10101) Black'), 'PLA Basic');
  assert.equal(popularLabel('Hardened Steel Nozzle, 0.4 mm'), 'Hardened Steel Nozzle');
});

test('the field: camera button, animated placeholder and recent searches are wired; the photo route is mounted', () => {
  const field = readFileSync(new URL('../src/components/search/LiveSearch.tsx', import.meta.url), 'utf8');
  assert.match(field, /import\('\.\/FieldExtras'\)/, 'placeholder, camera and photo search are one lazy chunk');
  assert.doesNotMatch(field, /^import [^;]*from '\.\/(FieldExtras|AnimatedPlaceholder|VisualSearch)'/m, 'never a static import into the header');
  assert.doesNotMatch(field, /recentTerms/, 'recent searches live in the after-paint chunk, not the field');
  const extras = readFileSync(new URL('../src/components/search/FieldExtras.tsx', import.meta.url), 'utf8');
  assert.match(extras, /data-testid="search-camera"/);
  assert.match(extras, /import\('\.\/VisualSearch'\)/, 'the scan / photo window is fetched on press');
  assert.match(extras, /addEventListener\('submit', onSubmit\)/, 'a submitted search is remembered');
  assert.match(extras, /data-search-recent/);
  const index = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8');
  assert.match(index, /app\.route\('\/api\/search', searchImageRoutes\)/);
  const visual = readFileSync(new URL('../src/components/search/VisualSearch.tsx', import.meta.url), 'utf8');
  assert.match(visual, /accept="any"/, 'the scan takes any code');
  // Sorani is never a copy of the Arabic (DECISIONS row 183).
  for (const m of visual.matchAll(/loc\('([^']+)', '[^']+', '([^']+)'\)/g)) assert.notEqual(m[1], m[2]);
});

test('a scanned QR opens only a path on this shop, never another host', async () => {
  const { shopPathOf } = await import('../src/components/search/VisualSearch');
  const origin = 'https://levonis-iq.com';
  assert.equal(shopPathOf('https://levonis-iq.com/product/a1?x=1#t', origin), '/product/a1?x=1#t');
  assert.equal(shopPathOf('https://levonis-iq.com//evil.com', origin), null);
  assert.equal(shopPathOf('https://levonis-iq.com/\\evil.com', origin), null);
  assert.equal(shopPathOf('https://evil.com/product/a1', origin), null);
  assert.equal(shopPathOf('javascript:alert(1)', origin), null);
  assert.equal(shopPathOf('4006381333931', origin), null);
});

test('the photo route checks the real body size, not only the header', () => {
  const route = readFileSync(new URL('../worker/routes/searchImage.ts', import.meta.url), 'utf8');
  assert.match(route, /LENGTH_REQUIRED/);
  assert.match(route, /bytes\.byteLength > cap/);
  assert.doesNotMatch(route, /c\.req\.json/);
});
