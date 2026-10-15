/**
 * SPECIFICATIONS WITH PROVENANCE (Bambu import spec §C.6 golden cells, the
 * region rule, PLA net weight and diameter).
 *
 *   - A1 "Physical Dimensions": product 465×410×430 mm; package 596×536×325 mm
 *     (scope A1); net weight 8.3 kg; gross weight 13 kg (A1) and 13.5 kg
 *     (A1 Combo); the Combo's package 560×540×430 mm.
 *   - H2D: product 492×514×626 mm; package 580×605×750 mm (us_110v);
 *     recommended space 700×700×1100 mm; net weight 31 kg; gross weight
 *     40.6 / 44.2 / 48.2 kg per version (us_110v); no verified 100–120 V row.
 *   - PLA Basic: material.net_weight 1000 g from the `1kg` value; diameter
 *     1.75 mm ± 0.03 mm, verified.
 *   - an expected key no checked source gives is `not_found`, never 0.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOptions, newProductId, type OptionModel } from '../packages/catalog/src/bambuImport/options';
import { describe } from '../packages/catalog/src/bambuImport/describe';
import { buildSpecs, compositeCell, typeValue, type SpecResult, type SpecRow } from '../packages/catalog/src/bambuImport/specs';
import { productTypeOf } from '../packages/catalog/src/bambuImport/registry/types';
import { modelsInText } from '../packages/catalog/src/bambuImport/registry/models';
import { keyForLabel } from '../packages/catalog/src/bambuImport/registry/specKeys';
import { sample, type SampleHandle } from './fixtures/bambu/load';

function specsOf(h: SampleHandle): { r: SpecResult; m: OptionModel; name: (id: string) => string } {
  const x = sample(h);
  const productId = newProductId(x.sourceProductId);
  const m = buildOptions(x, productId);
  const r = buildSpecs(
    { described: describe(x.description), features: x.features, featuresTitle: x.featuresTitle },
    { productId, productType: productTypeOf(x.route), canonicalUrl: x.canonicalUrl, retrievedAt: '2026-10-15', model: m, modelToken: modelsInText(x.title)[0]?.token ?? '' }
  );
  const name = (id: string) => m.groups.flatMap((g) => g.values).find((v) => v.id === id)?.nameEn ?? id;
  return { r, m, name };
}

const pick = (rows: SpecRow[], key: string, scope = '', name?: (id: string) => string) =>
  rows.filter((r) => r.key === key && (scope === '' ? r.scopeKind === 'product' : name?.(r.scopeId) === scope));

test('A1 composite cell (§C.6 golden)', () => {
  const { r, name } = specsOf('a1');
  const one = (key: string, scope = '') => {
    const hit = pick(r.rows, key, scope, name);
    assert.equal(hit.length, 1, `${key} ${scope}`);
    return hit[0];
  };
  assert.deepEqual(['length', 'width', 'height'].map((e) => one(`product.${e}`).valueNum), [465, 410, 430]);
  assert.deepEqual(['length', 'width', 'height'].map((e) => one(`package.${e}`, 'A1').valueNum), [596, 536, 325]);
  assert.deepEqual(['length', 'width', 'height'].map((e) => one(`package.${e}`, 'A1 Combo').valueNum), [560, 540, 430]);
  assert.equal(one('product.net_weight').valueNum, 8300);
  assert.equal(one('shipment.gross_weight', 'A1').valueNum, 13000);
  const combo = one('shipment.gross_weight', 'A1 Combo');
  assert.equal(combo.valueNum, 13500);
  assert.equal(combo.testCondition, 'AMS lite included');
  for (const row of r.rows.filter((x) => x.group === 'logistics' && x.key !== 'package.volume_m3')) {
    assert.equal(row.status, 'verified', row.key);
    assert.equal(row.region, '', 'the A1 table is not a US table');
    assert.match(row.sourceLocator, /A1 SPECS › row \d+/);
    assert.ok(row.sourceExcerpt.length <= 200);
  }
  assert.equal(pick(r.rows, 'printing.supported_filament')[0].valueList.length, 2, 'the [group, label, value] matrix rows join into one list');
});

test('H2D composite cells and the region rule (§C.6 golden)', () => {
  const { r, name } = specsOf('h2d');
  assert.ok(r.usTable);
  const at = (key: string, scope = '') => pick(r.rows, key, scope, name);
  assert.deepEqual(['length', 'width', 'height'].map((e) => at(`product.${e}`)[0].valueNum), [492, 514, 626]);
  for (const e of ['length', 'width', 'height']) {
    const rows = r.rows.filter((x) => x.key === `package.${e}`);
    assert.equal(rows.length, 1, `one package.${e} row`);
    assert.equal(rows[0].region, 'us_110v');
    assert.equal(rows[0].status, 'unverified');
    assert.equal(rows[0].testCondition, 'US version (100–120 V)');
  }
  assert.deepEqual(['length', 'width', 'height'].map((e) => at(`package.${e}`)[0].valueNum), [580, 605, 750]);
  assert.deepEqual(at('physical.recommended_space')[0].valueList, [700, 700, 1100]);
  assert.equal(at('product.net_weight')[0].valueNum, 31000);
  const gross = r.rows.filter((x) => x.key === 'shipment.gross_weight');
  assert.deepEqual(gross.map((g) => [name(g.scopeId), g.valueNum, g.region]).sort((a, b) => Number(a[1]) - Number(b[1])), [
    ['H2D', 40600, 'us_110v'],
    ['H2D AMS Combo', 44200, 'us_110v'],
    ['H2D Laser Full Combo', 48200, 'us_110v'],
  ]);
  // No verified 100–120 V row; voltage purchase advice is region evidence, not a value.
  for (const row of r.rows) if (row.region === 'us_110v') assert.notEqual(row.status, 'verified', row.key);
  assert.ok(r.rows.some((x) => x.key === 'electrical.voltage' && x.region === 'us_110v'));
  assert.ok(r.regionEvidence.some((e) => /corresponding to your region/i.test(e)));
  assert.ok(!r.rows.some((x) => /corresponding to your region/i.test(x.valueText)));
  assert.ok(!r.rows.some((x) => x.key === 'package.volume_m3'), 'no CBM from a US-only printer box');
  assert.equal(at('motion.max_acceleration')[0].valueNum, 20000, '"20,000 mm/s²" is twenty thousand');
});

test('PLA Basic: net weight from the 1kg value, diameter and tolerance verified; absent expected keys are not_found', () => {
  const { r, name } = specsOf('pla-basic-filament');
  const net = r.rows.filter((x) => x.key === 'material.net_weight');
  assert.equal(net.length, 1);
  assert.equal(net[0].scopeKind, 'option_value');
  assert.equal(name(net[0].scopeId), '1kg');
  assert.equal(net[0].valueNum, 1000);
  assert.equal(net[0].confidence, 'official_variant');
  const d = r.rows.find((x) => x.key === 'material.diameter')!;
  const t = r.rows.find((x) => x.key === 'material.diameter_tolerance')!;
  assert.deepEqual([d.valueNum, d.unit, d.status], [1.75, 'mm', 'verified']);
  assert.deepEqual([t.valueNum, t.unit, t.status], [0.03, 'mm', 'verified']);
  for (const nf of r.rows.filter((x) => x.status === 'not_found')) {
    assert.equal(nf.valueNum, null);
    assert.equal(nf.valueText, '');
    assert.equal(nf.missingReason, 'not_found_in_checked_sources');
    assert.equal(nf.checkedSources[0].kind, 'store_page');
  }
  assert.ok(r.relationBullets.some((b) => /AMS/.test(b)), 'compatibility bullets are relation evidence, not specs');
});

test('several measures nothing attributes (PEI plate packaging per plate size) stay one unverified text row, no number', () => {
  const { r } = specsOf('bambu-textured-pei-plate');
  const len = r.rows.filter((x) => x.key === 'package.length');
  assert.equal(len.length, 1);
  assert.equal(len[0].valueNum, null);
  assert.equal(len[0].status, 'unverified');
  assert.equal(len[0].valueText, '408 / 300 / 220 mm');
  assert.ok(!r.rows.some((x) => x.key === 'package.volume_m3'));
});

test('a bundle page keeps each component table under the component name (build-plate combo)', () => {
  const { r } = specsOf('build-plate-combo');
  assert.ok(!r.rows.some((x) => x.key.startsWith('package.') || x.key === 'part.material'), 'component rows never become the product keys');
  assert.ok(r.rows.some((x) => x.key === 'x.textured_pei_part_material'));
  assert.ok(r.rows.some((x) => x.key === 'x.engineering_plate_package_length'));
});

test('compositeCell: soft wraps, sub-labels, scopes, trailing units, and a version this product does not offer', () => {
  const { m } = specsOf('h2d');
  const segs = compositeCell('31 kg\n(Gross weight: H2D: 40.6 kg; H2D AMS Combo: 44.2 kg;\nH2D Laser Full Combo: 48.2 kg)', 'product.net_weight', m, 'H2D');
  assert.deepEqual(segs.map((s) => [s.target, s.measures[0].value]), [
    ['product.net_weight', 31000],
    ['shipment.gross_weight', 40600],
    ['shipment.gross_weight', 44200],
    ['shipment.gross_weight', 48200],
  ]);
  const foreign = compositeCell('Gross weight: H2S Laser Edition: 50 kg', 'shipment.gross_weight', m, 'H2D');
  assert.equal(foreign[0].scope, 'FOREIGN');
  const bare = compositeCell('Gross weight: H2D: 40.6; H2D AMS Combo: 44.2 kg', 'shipment.gross_weight', m, 'H2D');
  assert.deepEqual(bare.map((s) => s.measures[0].value), [40600, 44200], 'a trailing unit applies to the bare number before it');
});

test('labels map case- and punctuation-insensitively; values type by the key', () => {
  assert.equal(keyForLabel('Build Volume(W*D*H)', 'printer')?.key, 'printing.build_volume');
  assert.equal(keyForLabel('max. printing temp.', 'hotend')?.key, 'thermal.max_nozzle_temp');
  assert.equal(keyForLabel('Net Weight', 'filament')?.key, 'material.net_weight');
  assert.equal(keyForLabel('Net Weight', 'printer')?.key, 'product.net_weight');
  assert.equal(keyForLabel('Totally Unknown Label', 'printer'), null);
  assert.equal(typeValue('300 °C', 'number', '°C').valueNum, 300);
  assert.equal(typeValue('190–240 °C', 'range', '°C').valueNumMax, 240);
  assert.equal(typeValue('Supported', 'boolean', '').valueBool, 1);
  assert.equal(typeValue('Not supported', 'boolean', '').valueBool, 0);
  assert.equal(typeValue('256*256*256 mm³', 'object', 'mm').valueText, '256 × 256 × 256 mm');
});
