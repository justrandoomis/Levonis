/**
 * BUILD PLATES IN THE SUPPLIER MATCHER (docs/SMART_PRICING.md §3.5).
 *
 *   - the 3D Effect Plate is a plate type of its own: Tmall sells it as a
 *     transfer plate or film (转印板, 转印膜), so another plate's listing is
 *     refused and the transfer plates offered beside a textured plate are
 *     never that plate's SKUs;
 *   - the plate type a product's name states counts only where no option value
 *     states one, for the item as for each SKU: a plate-kind value of another
 *     type keeps that type's listings;
 *   - a build plate (its name states a plate type) is no item the capture files
 *     under another category ("Printer base plate — A1 mini" is a spare part);
 *   - a plate-kind value that states only a generation ("1st Gen") refuses a
 *     SKU of another generation;
 *   - a 3D Effect set (2 films + 1 spring steel plate) is one offer, not a
 *     pack of 3.
 *
 * The items are the real listings of the 2026-10-31 captures (ids, titles and
 * options as captured), except two hand-made ones: 900000000050 (one pattern)
 * and the store item textured-pei-plate (the EU store sells no plate). The
 * prices are not the capture's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plateOf } from '../packages/catalog/src/supplierPrices/keys';
import { matchProduct, type CatalogueItem, type ItemMatch, type ProductMatch } from '../packages/catalog/src/supplierPrices/match';
import type { SupplierSource } from '../packages/catalog/src/supplierPrices/format';
import { catalogueItems, handIdentity, importedIdentity, tmallFile } from './fixtures/supplierPrices/load';

const tmall = tmallFile();
const T = (...keys: string[]) => catalogueItems(tmall, keys);

function itemOf(r: ProductMatch, source: SupplierSource, itemKey: string): ItemMatch {
  const m = r.sources.find((s) => s.source === source)?.items.find((i) => i.item_key === itemKey);
  assert.ok(m, `${source} ${itemKey} scored`);
  return m!;
}
const bestOf = (r: ProductMatch, source: SupplierSource) => r.sources.find((s) => s.source === source)?.best ?? null;
const mappedKeys = (r: ProductMatch) => r.sources.flatMap((s) => s.items.flatMap((m) => m.skus.map((x) => x.sku_key).filter((k): k is string => k !== null)));

const PRINTERS = ['A2L', 'X2D', 'P2S', 'H2C', 'H2S', 'H2D', 'A1', 'A1 mini', 'P1 Series', 'X1 Series'];

const tm = (item_key: string, title: string, name_en: string, category: string, skus: Array<[string, string]>): CatalogueItem => ({
  source: 'tmall_cn',
  item_key,
  title,
  name_en,
  category,
  sourcing_hint: 'CHINA_CNY',
  skus: skus.map(([sku_key, value], i) => ({ sku_key, options: { 配件类型: value }, price: String(i + 1) })),
});
const superTack = tm('1000231253475', '拓竹 增稳低温打印板Pro【A2L/X2D/P2S/H2系列/P1/X1/A1】 冷打板 低温打印板 3D打印板 3D打印板配件', 'Cool Plate SuperTack Pro — A2L/X2D/P2S/H2 series/P1/X1/A1', 'build_plate', [
  ['6150763586257', '适配H2D'],
  ['6155440810349', '适配H2C'],
  ['6155440810350', '增稳低温打印板Pro-适配X2D/P2S/P1/A1/X1'],
]);
const dualMini = tm('800723865579', '拓竹 A1mini 纹理+光面双面PEI打印面板 3D打印机配件 【A1mini 适用】', 'Dual-texture PEI plate (textured + smooth) — A1 mini', 'build_plate', [['5622162702684', '金色+黑色']]);
const texturedMini = tm('743408633650', '拓竹 A1 mini 纹理 PEI 打印板 PEI 板 纹理板 3D打印板 3D打印配件', 'Textured PEI plate — A1 mini', 'build_plate', [
  ['5300821699363', '纹理 PEI 打印板-适配A1 mini'],
  ['6198828119652', '【推荐加购】固体胶*1'],
  ['6198828119653', '【推荐加购】液体胶*1'],
]);
const basePlate = tm('1007428650186', '拓竹 打印机底板 3D打印机配件【适配A1 mini】', 'Printer base plate — A1 mini', 'spare_part', [['6170899099185', '打印机底板']]);
/** The four transfer plates the textured listing offers beside its own plates (【创意打印】…转印板). */
const TRANSFER_SKUS = ['6208672791653', '6208672791654', '6208672791655', '6208672791656'];
/** The 3D Effect listing (six of its 16 SKUs): sets of 2 films + 1 spring steel plate, and 2 films alone. */
const effectSets = tm('800769896817', '拓竹 转印膜打印板 替换膜【适配A1/P1系列/A1mini/X1C】 3D打印机配件 镭射纹 花纹转印', 'Replacement film for the transfer-pattern plate — A1/P1 series/A1 mini/X1C', 'build_plate', [
  ['6004157692334', '【适配X1/P1/A1】碳纤纹套装（膜*2+弹簧钢板*1）'],
  ['6004157692337', '【适配X1/P1/A1】星空纹套装（膜*2+弹簧钢板*1）'],
  ['6004157692338', '【适配A1 mini】碳纤纹套装（膜*2+弹簧钢板*1）'],
  ['6004157692341', '【适配A1 mini】星空纹套装（膜*2+弹簧钢板*1）'],
  ['5454509920232', '【适配A1/X/P】星空纹（膜*2）'],
  ['5454509920236', '【适配A1mini】星空纹（膜*2）'],
]);

test('the 3D Effect Plate is a plate type of its own, in its English name and in Tmall’s words', () => {
  for (const t of ['Bambu 3D Effect Plate', '3D Effect Plate Full Combo', '【创意打印】星空纹转印板-适配P1/A1/X1C', '拓竹 转印膜打印板 替换膜【适配A1/P1系列/A1mini/X1C】 3D打印机配件 镭射纹 花纹转印']) {
    assert.equal(plateOf(t).type, '3d_effect', t);
  }
  assert.equal(plateOf('拓竹 A1 mini 纹理 PEI 打印板 3D打印板').type, 'textured_pei', 'a 3D printer plate is no 3D Effect Plate');
  assert.equal(plateOf('Hall Effect Sensor').type, null);
  // A listing that names transfer plates beside its own plate in the title: its English name decides.
  const textured = tmall.items.find((i) => i.item_key === '728613928927')!;
  assert.match(textured.title, /转印板/);
  assert.equal(plateOf(textured.title).type, null, 'the title names two plate types');
  assert.equal(plateOf(textured.title, textured.name_en).type, 'textured_pei');
  assert.equal(plateOf('拓竹 纹理+光面PEI打印板 转印板【A1/X1C/P1系列适用】双面板光面板纹理板镭射板3D打印板 创意3D打印机配件', 'Dual-texture PEI plate (textured + smooth) — A1/X1C/P1 series').type, 'dual_pei');
});

test('a 3D Effect Plate refuses another plate’s listing, and the transfer plates beside a textured plate are never its SKUs', () => {
  // The finding: before, the SuperTack Pro's H2C and H2D SKUs were the best for a 3D Effect Plate by printer.
  const effect = handIdentity({ name: 'Bambu 3D Effect Plate', groups: [{ kind: 'printer', values: PRINTERS }] });
  const r = matchProduct(effect, [superTack, ...T('728613928927')]);
  assert.equal(itemOf(r, 'tmall_cn', '1000231253475').refused, 'LISTING_MISMATCH');
  assert.equal(itemOf(r, 'tmall_cn', '728613928927').refused, 'LISTING_MISMATCH', 'a textured plate listing');
  assert.equal(bestOf(r, 'tmall_cn'), null);
  assert.deepEqual(mappedKeys(r), []);
  // Its own kind of listing still serves it (900000000050 is hand-made: one pattern, one SKU).
  const pattern = tm('900000000050', '拓竹 星空纹转印板【适配P1/A1/X1C】', 'Starry-sky pattern plate — P1/A1/X1C', 'build_plate', [['900000000051', '【创意打印】星空纹转印板-适配P1/A1/X1C']]);
  const own = itemOf(matchProduct(handIdentity({ name: 'Bambu 3D Effect Plate', groups: [{ kind: 'printer', values: ['X1 Series'] }] }), [pattern]), 'tmall_cn', '900000000050');
  assert.deepEqual([own.refused, own.skus[0]!.sku_key], [null, '900000000051']);

  // The real Textured PEI import against the real textured listing: its plates of two generations only.
  const textured = importedIdentity('bambu-textured-pei-plate');
  const t = itemOf(matchProduct(textured, T('728613928927')), 'tmall_cn', '728613928927');
  const couldBe = t.skus.flatMap((s) => s.could_be);
  assert.ok(couldBe.includes('6207134270420') && couldBe.includes('5226725323060'), 'both generations of the textured plate');
  assert.ok(!couldBe.some((k) => TRANSFER_SKUS.includes(k)), JSON.stringify(t.skus));
});

test('a plate-kind value states its own type: the name’s type no longer refuses that type’s listings', () => {
  // The round-1 verifier's probe: before, both dual listings were refused for the textured name.
  const id = handIdentity({ name: 'Bambu Textured PEI Plate', groups: [{ kind: 'plate', values: ['Textured PEI Plate', 'Dual-Texture PEI Plate'] }, { kind: 'printer', values: ['A1 mini'] }] });
  const r = matchProduct(id, [dualMini, texturedMini]);
  const dual = itemOf(r, 'tmall_cn', '800723865579');
  assert.equal(dual.refused, null);
  assert.deepEqual(dual.skus.map((s) => s.sku_key), [null, '5622162702684'], 'the dual-texture SKU');
  assert.deepEqual(itemOf(r, 'tmall_cn', '743408633650').skus.map((s) => s.sku_key), ['5300821699363', null], 'the textured SKU');

  // A SKU whose value states no plate keeps the name's type, against the item's title too: no SKU of the
  // SuperTack listing (its H2D and H2C options say only the printer) is ever a textured plate.
  const mixed = handIdentity({ name: 'Bambu Textured PEI Plate', groups: [{ kind: 'plate', values: ['Dual-Texture PEI Plate', 'Plate only'] }, { kind: 'printer', values: ['H2D', 'H2C'] }] });
  const st = itemOf(matchProduct(mixed, [superTack]), 'tmall_cn', '1000231253475');
  assert.equal(st.refused, null, 'not every SKU takes its type from the name');
  assert.equal(st.mapped, 0);
  assert.deepEqual(st.skus.map((s) => [s.sku_key, s.could_be]), [
    [null, []],
    [null, []],
    [null, []],
    [null, []],
  ]);
});

test('a build plate is no item the capture files under another category', () => {
  // The finding: once the SuperTack listing is refused, "Printer base plate — A1 mini" (a spare part) was next.
  for (const name of ['Bambu Engineering Plate', 'Bambu Cool Plate', 'Bambu 3D Effect Plate']) {
    const id = handIdentity({ name, groups: [{ kind: 'printer', values: ['A1 mini'] }] });
    const m = itemOf(matchProduct(id, [basePlate]), 'tmall_cn', '1007428650186');
    assert.deepEqual([m.refused, m.mapped], ['LISTING_MISMATCH', 0], name);
  }
  // A store item is judged the same way (its category is the manifest type): an EU spare part is no plate.
  const hall: CatalogueItem = {
    source: 'bambu_eu',
    item_key: 'hall-effect-sensor',
    title: 'Hall Effect Sensor',
    name_en: 'Hall Effect Sensor',
    category: 'spare_part',
    sourcing_hint: 'EU_STORE_EUR',
    skus: [{ sku_key: '54196965900636', options: { option1: 'H2 Series' }, price: '1' }],
  };
  assert.equal(itemOf(matchProduct(handIdentity({ name: 'Bambu 3D Effect Plate' }), [hall]), 'bambu_eu', 'hall-effect-sensor').refused, 'LISTING_MISMATCH');

  // Unchanged: an item without a category, a product whose name states no plate type, a build-plate item.
  const a1mini = (name: string) => handIdentity({ name, groups: [{ kind: 'printer', values: ['A1 mini'] }] });
  assert.equal(itemOf(matchProduct(a1mini('Bambu Engineering Plate'), [{ ...basePlate, category: '' }]), 'tmall_cn', '1007428650186').refused, null);
  assert.equal(itemOf(matchProduct(a1mini('Glass Cover Plate'), [basePlate]), 'tmall_cn', '1007428650186').mapped, 1);
  assert.equal(itemOf(matchProduct(a1mini('Build Plate Combo'), [basePlate]), 'tmall_cn', '1007428650186').refused, null);
  const r = matchProduct(a1mini('Bambu Textured PEI Plate'), [texturedMini, basePlate]);
  assert.deepEqual(bestOf(r, 'tmall_cn')!.skus.map((s) => s.sku_key), ['5300821699363']);
  assert.equal(itemOf(r, 'tmall_cn', '1007428650186').refused, 'LISTING_MISMATCH');
});

test('a plate-kind value that states only a generation refuses a SKU of another generation', () => {
  // The finding: before, "1st Gen" and "2nd Gen" could each be either generation of the real textured listing.
  const gens = handIdentity({ name: 'Bambu Textured PEI Plate', groups: [{ kind: 'plate', values: ['1st Gen', '2nd Gen'] }] });
  const t = itemOf(matchProduct(gens, T('728613928927')), 'tmall_cn', '728613928927');
  assert.deepEqual(t.skus.map((s) => [s.sku_key, s.could_be]), [
    ['5226725323060', []],
    ['6207134270420', []],
  ], '一代 and 二代');
  // Before, a 1st-gen SKU for the X2D took the listing's only X2D plate, a 2nd-gen one.
  const x2d = handIdentity({ name: 'Bambu Textured PEI Plate', groups: [{ kind: 'plate', values: ['1st Gen'] }, { kind: 'printer', values: ['X2D'] }] });
  assert.deepEqual(itemOf(matchProduct(x2d, T('728613928927')), 'tmall_cn', '728613928927').skus.map((s) => [s.sku_key, s.could_be]), [[null, []]]);
  // A store states its values: the same label still pairs, another generation is refused (a hand-made store item).
  const store: CatalogueItem = {
    source: 'bambu_eu',
    item_key: 'textured-pei-plate',
    title: 'Bambu Textured PEI Plate',
    name_en: 'Bambu Textured PEI Plate',
    category: 'build_plate',
    sourcing_hint: 'EU_STORE_EUR',
    skus: [
      { sku_key: '900000000061', options: { option1: '2nd Gen' }, price: '1' },
      { sku_key: '900000000062', options: { option1: '1st Gen' }, price: '2' },
    ],
  };
  assert.deepEqual(itemOf(matchProduct(gens, [store]), 'bambu_eu', 'textured-pei-plate').skus.map((s) => s.sku_key), ['900000000062', '900000000061']);
});

test('a 3D Effect set (2 films + 1 spring steel plate) is one offer, not a pack of 3', () => {
  // The finding: 膜*2+弹簧钢板*1 read as 3 units, so the real listing was PACK_MISMATCH for the plate.
  const id = handIdentity({ name: 'Bambu 3D Effect Plate', groups: [{ kind: 'printer', values: ['X1 Series', 'A1 mini'] }] });
  const m = itemOf(matchProduct(id, [effectSets]), 'tmall_cn', '800769896817');
  assert.equal(m.refused, null);
  // Each printer's two pattern sets; 2 films alone are a pack of 2, never the plate.
  assert.deepEqual(m.skus.map((s) => [s.sku_key, s.could_be]), [
    [null, ['6004157692334', '6004157692337']],
    [null, ['6004157692338', '6004157692341']],
  ]);
});
