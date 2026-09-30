/**
 * PARTS AS STORE PRODUCTS — the facts and the fences (Programme C, phase C1;
 * docs/LEVO_PROJECT_PROGRAMME.md §B.3, §F; migration 0164).
 *
 * Pinned:
 *   · ONE reader for both catalogues: `readPartSpec` reads a Levonis
 *     `printed_part` sheet and a merchant's stored `part_spec` alike, derives
 *     and never invents (a number outside its cap, a range, an unknown kind,
 *     a line for an option the product does not have — all absent, never
 *     guessed), and `partSpecToMap` round-trips it;
 *   · the part in words in Arabic, English and written Sorani, with the
 *     Arabic adjective agreeing and the Sorani ezafe placed;
 *   · `fitsSlot`: a fit is proven, never assumed;
 *   · the merchant PATCH round trip, 400 PART_SPEC_INVALID {path}, the
 *     server-owned `source`, and `is_part` / `?kind=` on the list;
 *   · a HIDDEN part is on no storefront list, no product page, no search and
 *     no community list, while PART_BUYABLE_SQL lets it through — and refuses
 *     another store, an admin-hidden, a private and a non-part product;
 *   · `loadStoreParts` prices a unit by `resolveCatalogLine`'s own rule;
 *   · no public body carries `part_spec`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { freshDb, asD1, stubApp, get, patch, post, json, row, all, type StubUser, type Mount } from './fixtures/app';
import { seedCatalog, variantBody } from './fixtures/catalog';
import { merchantRoutes } from '../worker/routes/merchant';
import { merchantCatalogRoutes } from '../worker/routes/merchantCatalog';
import { storefrontRoutes } from '../worker/routes/storefront';
import { communityRoutes } from '../worker/routes/community';
import { communitySearchRoutes } from '../worker/routes/communitySearch';
import {
  PART_KINDS,
  PART_SHAPES,
  fitsSlot,
  partKindWord,
  partShapeWord,
  partSpecToMap,
  partSpecWords,
  readPartSpec,
  type PartSpec,
} from '../packages/catalog/src/personalize/parts';
import {
  PART_BUYABLE_SQL,
  PART_SPEC_KEYS,
  loadStoreParts,
  partUnitIqd,
  readPartSpecInput,
} from '../worker/lib/personalize/parts';
import { resolveCatalogLine } from '../worker/lib/catalog/lines';
import { resetPrivateProductsMemo } from '../worker/lib/privateProducts';

const ALI: StubUser = { id: 'ali', role: 'merchant', email: 'ali@x.co' };
const EVE: StubUser = { id: 'eve', role: 'customer', email: 'eve@x.co' };

const mount: Mount = (a) => {
  a.route('/api/merchant', merchantRoutes);
  a.route('/api/merchant', merchantCatalogRoutes);
  a.route('/api/storefront', storefrontRoutes);
  a.route('/api/community', communityRoutes);
  a.route('/api/community', communitySearchRoutes);
};
const as = (raw: DatabaseSync, user: StubUser | null) => stubApp(asD1(raw), user, mount);

function world(): DatabaseSync {
  resetPrivateProductsMemo();
  const raw = freshDb();
  seedCatalog(raw);
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('eve','Eve','eve@x.co','h','customer');
    INSERT OR REPLACE INTO admin_settings (key,value) VALUES ('communityGate','{"open":true}');
  `);
  return raw;
}

// ================================================================ the reader

test('readPartSpec reads a Levonis printed_part sheet: English select words, units typed after numbers, lines keyed by option key', () => {
  const levonis = {
    printed_use: 'Yes',
    part_kind: 'Magnet',
    part_shape: 'Round',
    diameter_mm: '6',
    height_mm: '3 mm',
    voltage: '',
    install_type: 'Press fit',
    install_minutes: '2',
    fits_family: 'lamp, keychain',
    uses: 'base; lid',
    variant_specs: 'magnet-10x2: diameter_mm=10, height_mm=2\nopt-bogus: diameter_mm=99\n\nnot a line',
    net_weight: '12', // another group's field: not a part fact, not read
  };
  assert.deepEqual(readPartSpec(levonis, ['opt-6x3', 'magnet-10x2']), {
    kind: 'magnet',
    shape: 'round',
    diameter_mm: 6,
    height_mm: 3,
    install: 'Press fit',
    install_minutes: 2,
    fits: ['lamp', 'keychain'],
    uses: ['base', 'lid'],
    variants: { 'magnet-10x2': { diameter_mm: 10, height_mm: 2 } },
  });
  // Without the option list every well-formed line is kept, as written.
  assert.deepEqual(Object.keys(readPartSpec(levonis)!.variants!), ['magnet-10x2', 'opt-bogus']);
  // Matched case-insensitively and returned as the caller spells the id.
  assert.deepEqual(readPartSpec({ part_kind: 'magnet', variant_specs: 'OV_A: height_mm=4' }, ['ov_a'])!.variants, { ov_a: { height_mm: 4 } });
  // The admin's other spellings of the same words.
  assert.equal(readPartSpec({ part_kind: 'LED', part_shape: 'Rectangular' })!.shape, 'rect');
  assert.equal(readPartSpec({ part_kind: 'Key ring' })!.kind, 'keyring');
  assert.equal(readPartSpec({ part_kind: 'NFC' })!.kind, 'nfc');
});

test('readPartSpec reads a merchant\'s stored part_spec — the JSON text itself, Arabic digits, decimal volts', () => {
  const stored = JSON.stringify({ printed_use: 'Yes', part_kind: 'battery', part_shape: 'round', diameter_mm: '٢٠', height_mm: '3.2', voltage: '٣٫٧ فولت', source: 'levonis:lv_1#opt_a' });
  assert.deepEqual(readPartSpec(stored), { kind: 'battery', shape: 'round', diameter_mm: 20, height_mm: 3.2, voltage: 3.7, source: 'levonis:lv_1#opt_a' });
  assert.equal(readPartSpec('{not json'), null);
  assert.equal(readPartSpec('[]'), null);
  assert.equal(readPartSpec(null), null);
});

test('readPartSpec NEVER INVENTS: a bad number, a range, an unknown kind, a «No», a forged source — absent or null, never guessed', () => {
  assert.equal(readPartSpec({ part_kind: 'laser' }), null, 'an unknown kind is not a part');
  assert.equal(readPartSpec({ printed_use: 'No', part_kind: 'magnet' }), null, 'marked «not for printed products»');
  assert.equal(readPartSpec({}), null, 'an empty sheet is not a part');
  // The one default: a sheet marked Yes with no kind chosen is «other», what the form offers for «not said».
  assert.deepEqual(readPartSpec({ printed_use: 'Yes' }), { kind: 'other' });
  const spec = readPartSpec({
    part_kind: 'motor',
    diameter_mm: '0',
    length_mm: '-5',
    width_mm: '20000',
    height_mm: 'abc',
    voltage: '5-12V',
    power_w: 'NaN',
    install_minutes: 99999,
    part_shape: 'hexagon',
    source: 'https://evil.example/x',
    colour: 'red',
  });
  assert.deepEqual(spec, { kind: 'motor' }, 'nothing it could not read is there');
  // The caps are the edges: inside is kept, outside is dropped.
  assert.deepEqual(readPartSpec({ part_kind: 'cable', length_mm: '10000', voltage: 400, power_w: 5000 }), {
    kind: 'cable', length_mm: 10000, voltage: 400, power_w: 5000,
  });
  assert.equal(readPartSpec({ part_kind: 'cable', length_mm: '10001' })!.length_mm, undefined);
});

test('partSpecToMap round-trips: the stored map reads back to the same part', () => {
  const specs: PartSpec[] = [
    { kind: 'magnet', shape: 'round', diameter_mm: 6, height_mm: 3, install: 'Glue', install_minutes: 2, fits: ['lamp'], uses: ['base', 'lid'], source: 'levonis:lv_1#opt_a', variants: { ov_1: { diameter_mm: 10, height_mm: 2 }, ov_2: { shape: 'ring', voltage: 5 } } },
    { kind: 'led', shape: 'strip', length_mm: 1000, voltage: 5, power_w: 7.5 },
    { kind: 'other' },
  ];
  for (const s of specs) {
    const map = partSpecToMap(s);
    assert.equal(map.printed_use, 'Yes');
    assert.ok(Object.keys(map).every((k) => (PART_SPEC_KEYS as readonly string[]).includes(k)), 'only the spec group\'s keys');
    assert.deepEqual(readPartSpec(map, s.variants ? Object.keys(s.variants) : undefined), s);
  }
});

// ================================================================ the words

test('the part in words — «مغناطيس دائري ٦ × ٣ مم», «Round magnet 6 × 3 mm», «موگناتیسی خڕ ٦ × ٣ ملم»', () => {
  const magnet: PartSpec = { kind: 'magnet', shape: 'round', diameter_mm: 6, height_mm: 3, variants: { ov_big: { diameter_mm: 10, height_mm: 2 } } };
  assert.equal(partSpecWords(magnet, 'ar'), 'مغناطيس دائري ٦ × ٣ مم');
  assert.equal(partSpecWords(magnet, 'en'), 'Round magnet 6 × 3 mm');
  assert.equal(partSpecWords(magnet, 'ckb'), 'موگناتیسی خڕ ٦ × ٣ ملم');
  assert.equal(partSpecWords(magnet, 'en', 'ov_big'), 'Round magnet 10 × 2 mm', 'one option value\'s line');
  // The Arabic adjective agrees with a feminine noun; Sorani puts the shape after the first word.
  assert.equal(partSpecWords({ kind: 'battery', shape: 'round', diameter_mm: 20, height_mm: 3.2, voltage: 3 }, 'ar'), 'بطارية دائرية ٢٠ × ٣٫٢ مم ٣ فولت');
  assert.equal(partSpecWords({ kind: 'led', shape: 'strip', length_mm: 1000, voltage: 5, power_w: 7.5 }, 'ckb'), 'گڵۆپی شریتی LED ١٠٠٠ ملم ٥ ڤۆڵت ٧٫٥ وات');
  assert.equal(partSpecWords({ kind: 'led', shape: 'strip', length_mm: 1000, voltage: 5 }, 'en'), 'Strip LED 1000 mm 5 V');
  assert.equal(partSpecWords({ kind: 'keyring', shape: 'ring' }, 'ar'), 'حلقة مفاتيح حلقية');
  assert.equal(partSpecWords({ kind: 'screw', diameter_mm: 3, length_mm: 10 }, 'en'), 'Screw 3 × 10 mm');
  assert.equal(partSpecWords({ kind: 'nfc', shape: 'other' }, 'en'), 'NFC tag', '«other» adds no word');
});

test('every kind and every shape has a word in all three languages, and the Sorani is its own', () => {
  for (const k of PART_KINDS) {
    const [ar, en, ckb] = (['ar', 'en', 'ckb'] as const).map((l) => partKindWord(k, l));
    assert.ok(ar && en && ckb, `${k} is missing a word`);
    assert.notEqual(ckb, ar, `${k}: the Sorani is the Arabic`);
  }
  for (const s of PART_SHAPES.filter((x) => x !== 'other')) {
    const [ar, en, ckb] = (['ar', 'en', 'ckb'] as const).map((l) => partShapeWord(s, l));
    assert.ok(ar && en && ckb, `${s} is missing a word`);
    assert.notEqual(ckb, ar, `${s}: the Sorani is the Arabic`);
  }
});

// ================================================================ the fit

test('fitsSlot: a part fits a slot only on the facts it states', () => {
  const magnet: PartSpec = { kind: 'magnet', shape: 'round', diameter_mm: 6, height_mm: 3, variants: { ov_big: { diameter_mm: 10 } } };
  assert.equal(fitsSlot(magnet, { shape: 'round', diameter_mm: 6 }), true);
  assert.equal(fitsSlot(magnet, { shape: 'round', diameter_mm: 6.04 }), true, 'within 0.05 mm');
  assert.equal(fitsSlot(magnet, { shape: 'round', diameter_mm: 6 }, 'ov_big'), false, 'the 10 mm option does not go in a 6 mm hole');
  assert.equal(fitsSlot(magnet, { diameter_mm: { min: 5, max: 12 } }, 'ov_big'), true);
  assert.equal(fitsSlot(magnet, { kind: ['magnet', 'insert'], shape: ['round', 'ring'] }), true);
  assert.equal(fitsSlot(magnet, { kind: 'led' }), false);
  assert.equal(fitsSlot(magnet, { voltage: 5 }), false, 'a magnet states no volts, so it is not proven to fit a 5 V slot');
  assert.equal(fitsSlot({ kind: 'magnet' }, { shape: 'round' }), false, 'no shape stated, no fit');
  assert.equal(fitsSlot(magnet, null), true, 'a slot that asks nothing takes any part');
  assert.equal(fitsSlot(null, {}), false);
});

// ================================================================ the write path

async function makeProduct(raw: DatabaseSync, body: Record<string, unknown>) {
  const res = await post(as(raw, ALI), '/api/merchant/products', body);
  assert.equal(res.status, 201, JSON.stringify(await json(res.clone())));
  return (await json(res)).product;
}

test('the merchant PATCH round trip: the map is stored, read back on the detail, and `is_part` marks the list row', async () => {
  const raw = world();
  const product = await makeProduct(raw, variantBody());
  const small = product.option_groups[0].values[0].id as string;
  const res = await patch(as(raw, ALI), `/api/merchant/products/${product.id}`, {
    part_spec: { part_kind: 'magnet', part_shape: 'round', diameter_mm: '6', height_mm: 3, variant_specs: `${small}: diameter_mm=10, height_mm=2` },
  });
  assert.equal(res.status, 200, JSON.stringify(await json(res.clone())));
  const saved = (await json(res)).product;
  const expected = { printed_use: 'Yes', part_kind: 'magnet', part_shape: 'round', diameter_mm: '6', height_mm: '3', variant_specs: `${small}: diameter_mm=10, height_mm=2` };
  assert.deepEqual(saved.part_spec, expected);
  assert.equal(saved.is_part, true);
  assert.deepEqual(JSON.parse(row<{ part_spec: string }>(raw, 'SELECT part_spec FROM community_products WHERE id = ?', product.id)!.part_spec), expected);
  // The detail answers what was stored; the client can send it straight back.
  const detail = (await json(await get(as(raw, ALI), `/api/merchant/products/${product.id}`))).product;
  assert.deepEqual(detail.part_spec, expected);
  const again = await patch(as(raw, ALI), `/api/merchant/products/${product.id}`, { part_spec: detail.part_spec });
  assert.equal(again.status, 200);
  assert.deepEqual((await json(again)).product.part_spec, expected);

  // The list carries the flag, never the facts; `?kind=` filters by it.
  await makeProduct(raw, { name: 'Plain vase', price_iqd: 5000, state: 'published' });
  const list = (await json(await get(as(raw, ALI), '/api/merchant/products'))).products as Array<Record<string, unknown>>;
  assert.deepEqual(list.map((p) => [p.name, p.is_part]).sort(), [['Dragon figure', true], ['Plain vase', false]]);
  assert.ok(list.every((p) => !('part_spec' in p)), 'the list row carries `is_part`, not the facts');
  const parts = (await json(await get(as(raw, ALI), '/api/merchant/products?kind=parts'))).products as Array<{ name: string }>;
  assert.deepEqual(parts.map((p) => p.name), ['Dragon figure']);
  const plain = (await json(await get(as(raw, ALI), '/api/merchant/products?kind=products'))).products as Array<{ name: string }>;
  assert.deepEqual(plain.map((p) => p.name), ['Plain vase']);

  // null makes it an ordinary product again.
  const cleared = await patch(as(raw, ALI), `/api/merchant/products/${product.id}`, { part_spec: null });
  assert.equal(cleared.status, 200);
  assert.equal((await json(cleared)).product.part_spec, null);
  assert.equal(row<{ part_spec: string | null }>(raw, 'SELECT part_spec FROM community_products WHERE id = ?', product.id)!.part_spec, null);
});

test('400 PART_SPEC_INVALID {path}: every fact the body states must read back — kind, numbers, shapes, keys, lines of other values', async () => {
  const raw = world();
  const product = await makeProduct(raw, variantBody());
  const cases: Array<[unknown, string]> = [
    ['magnet', 'part_spec'],
    [['magnet'], 'part_spec'],
    [{ part_kind: 'laser' }, 'part_spec.part_kind'],
    [{ part_shape: 'round' }, 'part_spec.part_kind'],
    [{ printed_use: 'No', part_kind: 'magnet' }, 'part_spec.printed_use'],
    [{ part_kind: 'magnet', diameter_mm: 'six' }, 'part_spec.diameter_mm'],
    [{ part_kind: 'magnet', height_mm: -3 }, 'part_spec.height_mm'],
    [{ part_kind: 'led', voltage: '5-12V' }, 'part_spec.voltage'],
    [{ part_kind: 'magnet', part_shape: 'hexagon' }, 'part_spec.part_shape'],
    [{ part_kind: 'magnet', colour: 'red' }, 'part_spec.colour'],
    [{ part_kind: 'magnet', diameter_mm: { n: 6 } }, 'part_spec.diameter_mm'],
    [{ part_kind: 'magnet', variant_specs: 'pov_not_mine: diameter_mm=10' }, 'part_spec.variant_specs'],
    [{ part_kind: 'magnet', variant_specs: `${product.option_groups[0].values[0].id}: diameter_mm=ten` }, 'part_spec.variant_specs'],
    [{ part_kind: 'magnet', variant_specs: `${product.option_groups[0].values[0].id}: colour=red` }, 'part_spec.variant_specs'],
    [{ part_kind: 'magnet', uses: Array.from({ length: 13 }, (_, i) => `use ${i}`) }, 'part_spec.uses'],
  ];
  for (const [part_spec, path] of cases) {
    const res = await patch(as(raw, ALI), `/api/merchant/products/${product.id}`, { part_spec });
    const body = await json(res);
    assert.equal(res.status, 400, `${JSON.stringify(part_spec)} → ${res.status}`);
    assert.equal(body.code, 'PART_SPEC_INVALID', JSON.stringify(part_spec));
    assert.deepEqual(body.details, { path }, JSON.stringify(part_spec));
  }
  assert.equal(row<{ part_spec: string | null }>(raw, 'SELECT part_spec FROM community_products WHERE id = ?', product.id)!.part_spec, null, 'nothing was stored');
  // Beside another problem it is one more row of the editor's list.
  const both = await json(await patch(as(raw, ALI), `/api/merchant/products/${product.id}`, { price_iqd: -1, part_spec: { part_kind: 'laser' } }));
  assert.equal(both.code, 'PRODUCT_INVALID');
  assert.deepEqual(both.details.errors, [
    { path: 'price_iqd', code: 'PRICE_INVALID' },
    { path: 'part_spec.part_kind', code: 'PART_SPEC_INVALID' },
  ]);
  // A new product has no option values yet, so no line can name one.
  const created = await post(as(raw, ALI), '/api/merchant/products', { ...variantBody(), part_spec: { part_kind: 'magnet', variant_specs: 's: diameter_mm=6' } });
  assert.equal(created.status, 400);
  assert.deepEqual((await json(created)).details, { path: 'part_spec.variant_specs' });
  // …and a plain one is created a part in one request.
  const plain = await makeProduct(raw, { name: 'Hook', price_iqd: 500, state: 'hidden', part_spec: { part_kind: 'hook', length_mm: 30 } });
  assert.deepEqual(plain.part_spec, { printed_use: 'Yes', part_kind: 'hook', length_mm: '30' });
  assert.equal(plain.is_part, true);
});

test('the source is the server\'s: a body cannot set or move it, and an edit keeps the one «من ليفونيس» wrote', async () => {
  const raw = world();
  const product = await makeProduct(raw, { name: 'Magnet', price_iqd: 500, state: 'hidden', part_spec: { part_kind: 'magnet', source: 'levonis:forged#x' } });
  assert.equal(product.part_spec.source, undefined, 'a client never writes it');
  raw.prepare('UPDATE community_products SET part_spec = ? WHERE id = ?').run(
    JSON.stringify({ printed_use: 'Yes', part_kind: 'magnet', source: 'levonis:lv_mag#opt_a' }),
    product.id
  );
  const res = await patch(as(raw, ALI), `/api/merchant/products/${product.id}`, { part_spec: { part_kind: 'magnet', diameter_mm: 6, source: 'levonis:other' } });
  assert.equal(res.status, 200);
  assert.deepEqual((await json(res)).product.part_spec, { printed_use: 'Yes', part_kind: 'magnet', diameter_mm: '6', source: 'levonis:lv_mag#opt_a' });
});

test('readPartSpecInput is strict where readPartSpec is lenient', () => {
  assert.deepEqual(readPartSpecInput(null), { ok: true, map: null });
  assert.deepEqual(readPartSpecInput({ part_kind: 'magnet', diameter_mm: '6', fits_family: ['lamp', 'sign'] }), {
    ok: true,
    map: { printed_use: 'Yes', part_kind: 'magnet', diameter_mm: '6', fits_family: 'lamp, sign' },
  });
  assert.deepEqual(readPartSpecInput({ part_kind: 'magnet', diameter_mm: '' }), { ok: true, map: { printed_use: 'Yes', part_kind: 'magnet' } }, 'a blank field is a cleared field');
  assert.deepEqual(readPartSpecInput({ part_kind: 'magnet', install_type: 'x'.repeat(61) }), { ok: false, path: 'part_spec.install_type' });
  assert.deepEqual(readPartSpecInput({ part_kind: 'magnet', variant_specs: 'a: height_mm=2' }, ['a']), {
    ok: true,
    map: { printed_use: 'Yes', part_kind: 'magnet', variant_specs: 'a: height_mm=2' },
  });
});

// ================================================================ hidden, and still buyable

async function hiddenPart(raw: DatabaseSync) {
  return makeProduct(raw, {
    name: 'Hidden magnet part',
    price_iqd: 750,
    stock: 40,
    state: 'hidden',
    part_spec: { part_kind: 'magnet', part_shape: 'round', diameter_mm: 6, height_mm: 3 },
  });
}

test('a HIDDEN part is on no storefront list, no product page, no search and no community list — the 0152 mirror says status hidden', async () => {
  const raw = world();
  const part = await hiddenPart(raw);
  await makeProduct(raw, { name: 'Hidden magnet vase', price_iqd: 9000, state: 'published' });
  assert.deepEqual(row(raw, 'SELECT publish_state, lifecycle, status FROM community_products WHERE id = ?', part.id), {
    publish_state: 'hidden', lifecycle: 'hidden', status: 'hidden',
  });
  for (const who of [null, EVE, ALI]) {
    const app = as(raw, who);
    const list = await json(await get(app, '/api/storefront/ali3d/products'));
    assert.ok(!JSON.stringify(list).includes(part.id), 'the storefront list');
    const searched = await json(await get(app, '/api/storefront/ali3d/products?q=magnet'));
    assert.deepEqual(searched.products.map((p: { name: string }) => p.name), ['Hidden magnet vase'], 'the store\'s own search');
    assert.equal((await get(app, `/api/storefront/ali3d/products/${part.slug}`)).status, 404, 'its product page');
    const feed = await json(await get(app, '/api/community/products'));
    assert.ok(!JSON.stringify(feed).includes(part.id), 'the community list');
    const search = await json(await get(app, '/api/community/search?q=magnet'));
    assert.ok(!JSON.stringify(search).includes(part.id), 'the community search');
  }
});

test('PART_BUYABLE_SQL lets the hidden part through in its own store, and refuses another store, admin-hidden, private, draft and non-parts', async () => {
  const raw = world();
  const hidden = await hiddenPart(raw);
  const published = await makeProduct(raw, { name: 'Shelf magnet', price_iqd: 800, state: 'published', part_spec: { part_kind: 'magnet' } });
  const draft = await makeProduct(raw, { name: 'Draft magnet', price_iqd: 800, state: 'draft', part_spec: { part_kind: 'magnet' } });
  const plain = await makeProduct(raw, { name: 'Just a vase', price_iqd: 800, state: 'hidden' });
  const banned = await makeProduct(raw, { name: 'Moderated magnet', price_iqd: 800, state: 'hidden', part_spec: { part_kind: 'magnet' } });
  raw.prepare("UPDATE community_products SET admin_hidden_at = '2026-09-01T00:00:00.000Z' WHERE id = ?").run(banned.id);
  raw.exec(`
    INSERT INTO community_products (id,merchant_id,store_id,slug,name,price_iqd,publish_state,audience_user_id,part_spec)
      VALUES ('cp_private','m_ali','s_ali','private-magnet','Private magnet',800,'published','eve','{"part_kind":"magnet"}'),
             ('cp_zain','m_zain','s_zain','zain-magnet','Zain magnet',800,'hidden',NULL,'{"part_kind":"magnet"}');
  `);
  const buyable = (store: string) =>
    all<{ id: string }>(raw, `SELECT p.id FROM community_products p WHERE ${PART_BUYABLE_SQL('p', '?1')} ORDER BY p.id`, store).map((r) => r.id);
  assert.deepEqual(buyable('s_ali'), [hidden.id, published.id].sort());
  assert.deepEqual(buyable('s_zain'), ['cp_zain']);
  for (const id of [draft.id, plain.id, banned.id, 'cp_private']) assert.ok(!buyable('s_ali').includes(id), id);
});

test('loadStoreParts: one row per sellable unit, priced by resolveCatalogLine\'s rule, the facts laid per value, in ONE statement', async () => {
  const raw = world();
  const product = await makeProduct(raw, { ...variantBody({ state: 'hidden' }) });
  const [small, medium] = product.option_groups[0].values.map((v: { id: string }) => v.id);
  const red = product.option_groups[1].values[0].id;
  await patch(as(raw, ALI), `/api/merchant/products/${product.id}`, {
    part_spec: { part_kind: 'magnet', part_shape: 'round', diameter_mm: 6, height_mm: 3, variant_specs: `${medium}: diameter_mm=10` },
  });
  const hidden = await hiddenPart(raw);
  let statements = 0;
  const db = asD1(raw);
  const counting = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => { statements += 1; return target.prepare(sql); };
      const v = Reflect.get(target, key);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const parts = await loadStoreParts(counting, 's_ali');
  assert.equal(statements, 1, 'one statement for every part and variant');
  const byKey = new Map(parts.map((p) => [`${p.product_id}|${p.variant_id ?? ''}`, p]));
  assert.equal(parts.length, 3);
  const variantRows = parts.filter((p) => p.product_id === product.id);
  const mRow = variantRows.find((p) => p.label.includes('وسط'))!;
  const sRow = variantRows.find((p) => p !== mRow)!;
  assert.equal(sRow.unit_iqd, 10_000, 'the product\'s price when the variant has none');
  assert.equal(mRow.unit_iqd, 14_000, 'the variant\'s own price');
  assert.equal(sRow.spec.diameter_mm, 6);
  assert.equal(mRow.spec.diameter_mm, 10, 'the medium value\'s line');
  assert.equal(mRow.spec.variants, undefined);
  assert.deepEqual([sRow.stock, sRow.in_stock, mRow.stock], [2, true, 5]);
  const simple = byKey.get(`${hidden.id}|`)!;
  assert.deepEqual([simple.unit_iqd, simple.stock, simple.in_stock, simple.variant_id], [750, 40, true, null]);
  // The same rule the cart line uses, on the same rows.
  for (const p of variantRows) {
    const verdict = resolveCatalogLine({ variant_mode: 'variants', price_iqd: 10_000, ci_variant_id: p.variant_id, v_id: p.variant_id, v_active: 1, v_price: p.unit_iqd === 10_000 ? null : p.unit_iqd });
    assert.ok(verdict.ok && verdict.unit === p.unit_iqd);
  }
  assert.equal(partUnitIqd({ price_iqd: 900, v_price: null }), 900);
  assert.equal(partUnitIqd({ price_iqd: 900, v_price: 1200 }), 1200);
  // Narrowed by id and by kind.
  assert.deepEqual((await loadStoreParts(db, 's_ali', { ids: [hidden.id] })).map((p) => p.product_id), [hidden.id]);
  assert.deepEqual(await loadStoreParts(db, 's_ali', { kinds: ['led'] }), []);
  assert.equal((await loadStoreParts(db, 's_ali', { kinds: ['magnet'] })).length, 3);
  // A deactivated variant is not a unit; another store's parts are not this store's.
  raw.prepare('UPDATE community_product_variants SET active = 0 WHERE product_id = ? AND value1_id = ? AND value2_id = ?').run(product.id, small, red);
  assert.equal((await loadStoreParts(db, 's_ali')).length, 2);
  assert.deepEqual(await loadStoreParts(db, 's_zain'), []);
});

// ================================================================ no public body carries it

function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
  return out;
}

test('no public body carries part_spec — a PUBLISHED part\'s storefront list, product page and community card', async () => {
  const raw = world();
  const part = await makeProduct(raw, {
    name: 'Shelf magnet',
    price_iqd: 800,
    state: 'published',
    part_spec: { part_kind: 'magnet', part_shape: 'round', diameter_mm: 6, height_mm: 3, fits_family: 'secret family' },
  });
  raw.prepare('UPDATE community_products SET part_spec = json_set(part_spec, \'$.source\', \'levonis:lv_secret#opt\') WHERE id = ?').run(part.id);
  const guest = as(raw, null);
  const bodies = [
    await json(await get(guest, '/api/storefront/ali3d/products')),
    await json(await get(guest, `/api/storefront/ali3d/products/${part.slug}`)),
    await json(await get(guest, '/api/community/products')),
    await json(await get(guest, '/api/community/search?q=magnet')),
  ];
  assert.ok(JSON.stringify(bodies[1]).includes(part.id), 'the part is on its page — it is published');
  for (const body of bodies) {
    const keys = keysOf(body);
    // The facts' own words — `source` and `uses` are ordinary words other bodies may use for other things.
    for (const k of ['part_spec', 'is_part', 'printed_use', 'part_kind', 'part_shape', 'fits_family', 'variant_specs']) {
      assert.ok(!keys.has(k), `a public body carries «${k}»`);
    }
    const text = JSON.stringify(body);
    assert.ok(!text.includes('levonis:lv_secret') && !text.includes('secret family'), 'nor any of its values');
  }
});
