/**
 * LOGISTICS, KEPT SEPARATE, WITH CBM DERIVED (Bambu import spec §B.7).
 *
 * CBM (`package.volume_m3`, owner-only, unverified, derived) comes only from
 * three package edges of ONE source, scope and region, and never from a
 * multi-box shipment or a US-only (110 V) machine box. Measures are typed
 * spec rows, never products.package_* / net_weight_g (the 0195 guards refuse
 * those). Units convert to mm and g; "20,000" is a thousands group.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveCbm, dimsToMm, findDims, findWeights, isMultiBoxNote, num, weightToG, type EdgeRow } from '../packages/catalog/src/bambuImport/logistics';
import { buildImportPayload } from '../packages/catalog/src/bambuImport/payload';
import { extractionFingerprint } from '../packages/catalog/src/bambuImport/fingerprint';
import { sample, type SampleHandle } from './fixtures/bambu/load';

const edges = (scopeId: string, region: string, l: number, w: number, h: number, locator = 'Specs › row 5'): EdgeRow[] =>
  (['length', 'width', 'height'] as const).map((e, i) => ({
    key: `package.${e}`,
    scopeKind: scopeId ? 'option_value' : 'product',
    scopeId,
    region,
    valueNum: [l, w, h][i],
    sourceKind: 'store_page',
    sourceLocator: locator,
  }));

test('CBM from three edges of one source and scope', () => {
  const [d] = deriveCbm(edges('', '', 100, 135, 45), { multiBoxScopes: new Set(), isPrinter: false });
  assert.equal(d.volume, 0.000608);
  assert.equal(d.reason, '');
  assert.match(d.derivedFrom, /package\.length × package\.width × package\.height/);
});

test('no CBM from a multi-box shipment', () => {
  const [d] = deriveCbm(edges('ov_laser', '', 580, 605, 750), { multiBoxScopes: new Set(['ov_laser']), isPrinter: true });
  assert.deepEqual([d.volume, d.reason], [null, 'multi_box']);
  assert.ok(isMultiBoxNote('Laser module(s) will be shipped in separate boxes.'));
  assert.ok(!isMultiBoxNote('Ships with a spool holder.'));
});

test('no CBM from a US-only (110 V) machine box; an accessory box may have one', () => {
  const [p] = deriveCbm(edges('', 'us_110v', 580, 605, 750), { multiBoxScopes: new Set(), isPrinter: true });
  assert.deepEqual([p.volume, p.reason], [null, 'us_110v_only']);
  const [a] = deriveCbm(edges('', '', 60, 60, 30), { multiBoxScopes: new Set(), isPrinter: false });
  assert.equal(a.volume, 0.000108);
});

test('no CBM from incomplete edges or edges of different sources', () => {
  const [inc] = deriveCbm(edges('', '', 100, 100, 100).slice(0, 2), { multiBoxScopes: new Set(), isPrinter: false });
  assert.equal(inc.reason, 'incomplete_edges');
  const mixed = edges('', '', 100, 100, 100);
  mixed[2] = { ...mixed[2], sourceLocator: 'Other table › row 1' };
  assert.equal(deriveCbm(mixed, { multiBoxScopes: new Set(), isPrinter: false })[0].reason, 'mixed_sources');
});

test('on the fixtures: the AMS 2 Pro feeder (a part) gets an owner-only derived CBM; the H2D (US box) gets none', () => {
  const build = (h: SampleHandle) => {
    const x = sample(h);
    return buildImportPayload({ extraction: x, writeMode: 'create', extractionSha256: extractionFingerprint(x), targets: null, retrievedAt: '2026-10-15T00:00:00Z' }).payload;
  };
  const part = build('ams-2-pro-feeder-unit').specs.filter((s) => s.key === 'package.volume_m3');
  assert.equal(part.length, 1);
  assert.deepEqual([part[0].value_num, part[0].visibility, part[0].status, part[0].confidence, part[0].source_kind], [0.000608, 'owner', 'unverified', 'derived', 'derived']);
  assert.equal(build('h2d').specs.filter((s) => s.key === 'package.volume_m3').length, 0);
  assert.equal(build('refurbished-bambu-lab-h2d-3d-printer').specs.filter((s) => s.key === 'package.volume_m3').length, 0);
});

test('units: dimensions and weights convert to mm and g; implausible edges are refused', () => {
  const [hit] = findDims('Package size : 596*536*325 mm³');
  assert.deepEqual(dimsToMm(hit)!.map((m) => m.value), [596, 536, 325]);
  assert.deepEqual(dimsToMm(findDims('393mm*380mm*15mm')[0])!.map((m) => m.value), [393, 380, 15]);
  assert.deepEqual(dimsToMm(findDims('10 x 20 x 30 cm')[0])!.map((m) => m.value), [100, 200, 300]);
  assert.equal(dimsToMm(findDims('1*2*9999 m')[0]), null, 'an edge over 3 m is implausible');
  assert.equal(weightToG(8.3, 'kg')!.value, 8300);
  assert.equal(weightToG(147, 'g')!.value, 147);
  assert.equal(weightToG(500, 'kg'), null, 'over 200 kg is implausible');
  assert.deepEqual(findWeights('Net weight 8.3 kg , Gross weight 13 kg').map((w) => w.value), [8.3, 13]);
  assert.equal(num('20,000'), 20000);
  assert.equal(num('13,5'), 13.5);
});
