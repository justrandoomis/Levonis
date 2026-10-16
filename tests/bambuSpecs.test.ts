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
import { publishedWeight } from '../packages/catalog/src/bambuImport/logistics';
import { productTypeOf } from '../packages/catalog/src/bambuImport/registry/types';
import { modelsInText } from '../packages/catalog/src/bambuImport/registry/models';
import { keyForLabel, SPEC_KEYS } from '../packages/catalog/src/bambuImport/registry/specKeys';
import { labelKey } from '../packages/catalog/src/bambuImport/normalize';
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
  // The number in grams, the text as published (§G.2 «the unit as published»): «31 kg», never «31000 g».
  assert.equal(at('product.net_weight')[0].valueText, '31 kg');
  assert.deepEqual(r.rows.filter((x) => x.key === 'shipment.gross_weight').map((g) => g.valueText).sort(), ['40.6 kg', '44.2 kg', '48.2 kg']);
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
  assert.equal(net[0].valueText, '1 kg', 'the option «1kg» as published, the number in grams');
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
  assert.deepEqual(bare.map((s) => publishedWeight(s.measures[0])), ['40.6 kg', '44.2 kg'], 'and the published text takes the unit it inherits');
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

/**
 * THE §C.6 HOTEND RULE (review 4, finding 8): the Size value text gives
 * nozzle.diameter and nozzle.material per value (value-scoped,
 * official_variant). A group of bare "0.4 mm" values under a nozzle label
 * (obxidian-high-flow-hotend: "Nozzle Diameter" 0.4 mm / 0.6 mm) is a nozzle
 * group giving the diameter only; a parenthetical ("(Standard Included)",
 * bambu-hotend-x1c) is never part of the material.
 */
test('hotend: per-value nozzle diameter and material; bare "0.4 mm" values; parentheticals dropped', async () => {
  const { classifyGroup } = await import('../packages/catalog/src/bambuImport/registry/groups');
  const { r, m, name } = specsOf('bambu-hotend-a1-a2');
  const size = m.groups.find((g) => g.kind === 'nozzle');
  assert.ok(size, 'the Size group is the nozzle group');
  for (const v of size!.values) {
    const want = /^(\d(?:\.\d+)?)mm (.+)$/.exec(v.nameEn)!;
    const d = pick(r.rows, 'nozzle.diameter', v.nameEn, name);
    const mat = pick(r.rows, 'nozzle.material', v.nameEn, name);
    assert.equal(d.length, 1, `${v.nameEn}: diameter`);
    assert.equal(d[0].valueNum, Number(want[1]));
    assert.equal(d[0].unit, 'mm');
    assert.equal(d[0].confidence, 'official_variant');
    assert.equal(d[0].status, 'verified');
    assert.equal(mat.length, 1, `${v.nameEn}: material`);
    assert.equal(mat[0].valueText, want[2]);
  }
  assert.deepEqual(pick(r.rows, 'nozzle.diameter').filter((x) => x.status === 'not_found').length, 0, 'never not_found while the values publish it');

  const g = (propertyKey: string, values: string[]) => classifyGroup({ propertyKey, type: 0, title: '', values: values.map((value) => ({ value, colorUrl: '' })) }).kind;
  assert.equal(g('Nozzle Diameter', ['0.4 mm', '0.6 mm']), 'nozzle', 'obxidian-high-flow-hotend');
  assert.equal(g('Nozzle Size', ['0.2mm', '0.4mm']), 'nozzle');
  assert.equal(g('Diameter', ['1.75 mm', '2.85 mm']), 'other', 'a filament diameter is not a nozzle');
  assert.equal(g('Thickness', ['0.2mm', '0.4mm']), 'size', 'black-aluminium-card: a thickness is not a nozzle');
  assert.equal(g('Size', ['0.4 mm', '0.6 mm']), 'size', 'a bare size is not a nozzle without a nozzle label');

  // The same product with bare values and a parenthetical: the specs read the value text the same way.
  const x = sample('bambu-hotend-a1-a2');
  const productId = newProductId(x.sourceProductId);
  const bare = buildOptions(x, productId);
  const grp = bare.groups.find((q) => q.kind === 'nozzle')!;
  const renamed = ['0.2 mm', '0.4 mm', '0.6 mm', '0.8mm Hardened Steel (Standard Included)', '0.45 mm'];
  grp.values.forEach((v, i) => (v.nameEn = renamed[i] ?? v.nameEn));
  const r2 = buildSpecs(
    { described: describe(x.description), features: x.features, featuresTitle: x.featuresTitle },
    { productId, productType: productTypeOf(x.route), canonicalUrl: x.canonicalUrl, retrievedAt: '2026-10-15', model: bare, modelToken: modelsInText(x.title)[0]?.token ?? '' }
  );
  const nameOf = (id: string) => bare.groups.flatMap((q) => q.values).find((v) => v.id === id)?.nameEn ?? id;
  assert.equal(pick(r2.rows, 'nozzle.diameter', '0.4 mm', nameOf)[0]?.valueNum, 0.4);
  assert.equal(pick(r2.rows, 'nozzle.material', '0.4 mm', nameOf).length, 0, 'a bare value names no material');
  assert.equal(pick(r2.rows, 'nozzle.material', '0.8mm Hardened Steel (Standard Included)', nameOf)[0]?.valueText, 'Hardened Steel');
});

/**
 * THE LABELS P0 LEFT UNKNOWN (owner-questions §E.7). scans.md §5's top 50
 * join the registry with three-language labels, a type and a unit, by the
 * product type the label was seen on; "Specification" and "Parameter" are
 * table-header words (the parser drops them as labels) and stay out.
 */
test('the top 50 unknown labels of the P0 scan resolve to registry keys', () => {
  const cases: Array<[string, Parameters<typeof keyForLabel>[1], string]> = [
    ['Shape', 'makers_supply', 'part.shape'],
    ['Electrical Requirements', 'printer', 'electrical.requirements'],
    ['L (mm) Length', 'makers_supply', 'product.length'],
    ['Connectivity', 'makers_supply', 'part.connection'],
    ['LED Board Type', 'makers_supply', 'part.led_board_type'],
    ['Rate of Fire', 'makers_supply', 'part.rate_of_fire'],
    ['Lanyard Circumference', 'makers_supply', 'part.lanyard_circumference'],
    ['Supported Filament Type', 'printer', 'printing.supported_filament'],
    ['Main Extruder Gear', 'printer', 'extrusion.main_extruder_gear'],
    ['Main Extruder Motor', 'printer', 'extrusion.main_extruder_motor'],
    ['Auxiliary Extruder Gear', 'printer', 'extrusion.aux_extruder_gear'],
    ['Auxiliary Extruder Motor', 'printer', 'extrusion.aux_extruder_motor'],
    ['Main Hotend', 'printer', 'printing.filament_main_hotend'],
    ['Auxiliary Hotend', 'printer', 'printing.filament_aux_hotend'],
    ['Auxiliary Hotend (print with caution¹)', 'printer', 'printing.filament_aux_hotend_caution'],
    ['Steady-State Power', 'printer', 'electrical.steady_state_power'],
    ['Working area', 'laser_machine', 'printing.working_area'],
    ['Software', 'laser_machine', 'connectivity.software'],
    ['Screen ratio', 'part', 'part.screen_ratio'],
    ['External interface', 'part', 'part.external_interface'],
    ['Rotating angle', 'part', 'part.rotating_angle'],
    ['Feature', 'accessory', 'part.feature'],
    ['Life Cycle', 'accessory', 'part.life_cycle'],
    ['Cable width', 'part', 'part.cable_width'],
    ['LCD type', 'part', 'part.lcd_type'],
    ['Module power consumption', 'part', 'part.module_power'],
    ['Recommended viewing direction', 'part', 'part.viewing_direction'],
    ['Backlight type', 'part', 'part.backlight'],
    ['Viewing area (W*H)', 'part', 'part.viewing_area'],
    ['Active area (W*H)', 'part', 'part.active_area'],
    ['Humidity', 'part', 'part.humidity'],
    ['Number of Dots', 'part', 'part.resolution'],
    ['Constrast ratio', 'part', 'part.contrast_ratio'],
    ['Luminance uniformity', 'part', 'part.luminance_uniformity'],
    ['Surface Luminance', 'part', 'part.luminance'],
    ['Viewing angle range', 'part', 'part.viewing_angle'],
    ['Package volume', 'accessory', 'part.capacity'],
    ['Button', 'makers_supply', 'part.buttons'],
    ['DPI', 'makers_supply', 'part.dpi'],
    ['Hardware Platform', 'makers_supply', 'part.platforms'],
    ['Sensor', 'makers_supply', 'part.sensor_type'],
    ['Operating Systems', 'makers_supply', 'connectivity.operating_systems'],
    ['Power Source', 'makers_supply', 'part.power_source'],
    ['Batteries', 'makers_supply', 'electrical.battery'],
    ['Resolution', 'part', 'part.resolution'],
    ['Display Color', 'part', 'part.display_colours'],
    ['Active Area', 'part', 'part.active_area'],
    ['LED life time', 'part', 'part.expected_life'],
  ];
  for (const [label, type, key] of cases) assert.equal(keyForLabel(label, type)?.key, key, `${label} (${type})`);
  // The step-4 corpus report's most frequent unknowns, too.
  for (const [label, type, key] of [
    ['Surface Treatment', 'makers_supply', 'part.surface_treatment'],
    ['Thread Ridge Type', 'makers_supply', 'part.thread_type'],
    ['Quantity', 'part', 'contents.pieces'],
    ['Mounting Hole Shape', 'makers_supply', 'part.drive_shape'],
    ['Screw Type', 'makers_supply', 'part.screw_type'],
    ['Door Sensor', 'printer', 'printing.door_sensor'],
    ['Cooling Fan for Hotend', 'printer', 'thermal.hotend_fan'],
    ['Network Kill Switch', 'printer', 'connectivity.network_kill_switch'],
  ] as const) {
    assert.equal(keyForLabel(label, type)?.key, key, `${label} (${type})`);
  }
});

test('a synonym two keys share resolves by product type; generic part labels never take a printer label', () => {
  assert.equal(keyForLabel('Part Cooling Fan', 'printer')?.key, 'thermal.part_cooling_fan');
  assert.equal(keyForLabel('Part Cooling Fan', 'filament')?.key, 'print_settings.fan_speed');
  assert.equal(keyForLabel('Max Temperature', 'makers_supply')?.key, 'part.max_temperature');
  // A printer's "Chamber Temperature Control › Max Temperature" still reaches the chamber key through its group.
  assert.equal(keyForLabel('Max Temperature', 'printer'), null);
  assert.equal(keyForLabel('Chamber Max Temperature', 'printer')?.key, 'thermal.chamber_temp');
  for (const generic of ['Shape', 'Type', 'Style', 'Feature', 'Sensor', 'Temperature', 'Quantity', 'Thickness']) assert.equal(keyForLabel(generic, 'printer'), null, generic);
  // Keys that share a synonym never both apply to one product type.
  const byLabel = new Map<string, Array<{ key: string; appliesTo: readonly string[] }>>();
  for (const s of SPEC_KEYS) {
    for (const syn of new Set(s.synonyms.map(labelKey))) byLabel.set(syn, [...(byLabel.get(syn) ?? []), s]);
  }
  for (const [label, keys] of byLabel) {
    if (keys.length < 2) continue;
    assert.ok(keys.every((k) => k.appliesTo.length > 0), `"${label}" is shared by a key that applies to every type`);
    const types = keys.flatMap((k) => k.appliesTo);
    assert.equal(new Set(types).size, types.length, `"${label}" resolves to two keys for one type`);
  }
  // Three cameras in one table are three keys.
  assert.deepEqual(['Live View Camera', 'Toolhead Camera', 'Nozzle Camera', 'BirdsEye Camera'].map((l) => keyForLabel(l, 'printer')?.key), [
    'printing.camera', 'printing.camera_toolhead', 'printing.camera_nozzle', 'printing.camera_birdseye',
  ]);
});

test('a section titled "Parameter" (R1 accessories) is a specification section', async () => {
  const { sectionKindOf } = await import('../packages/catalog/src/bambuImport/registry/sections');
  assert.equal(sectionKindOf('Parameter'), 'specs');
  assert.equal(sectionKindOf('Parameters'), 'specs');
});

/** "Slicer & Software" is prose on the printers (review 5, finding 3): one string, never sentence fragments. */
test('the printers\' Software cell stays one string', () => {
  let seen = 0;
  for (const handle of ['h2d', 'h2c'] as const) {
    const sw = specsOf(handle).r.rows.find((x) => x.key === 'connectivity.software');
    if (!sw) continue;
    seen++;
    assert.equal(sw.dataType, 'string', handle);
    assert.deepEqual(sw.valueList, [], handle);
    assert.match(sw.valueText, /G-code/, handle);
  }
  assert.ok(seen > 0, 'a printer fixture carries the Software row');
  assert.equal(SPEC_KEYS.find((k) => k.key === 'connectivity.software')!.type, 'string');
});
