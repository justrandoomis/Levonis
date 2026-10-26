/**
 * LEVONIS PRINT CLOUD — the pure rules, without a database: exact money
 * arithmetic, lot valuation, the gram price engine, the job state machine,
 * plate geometry, format detection, archive inspection, webhook signatures,
 * configuration normalisation and the three-language refusals.
 *
 * Run: node --import tsx --test tests/printCloudUnits.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync } from 'fflate';
import { apportion, mulDivRound, mulMulDivRound, roundUpTo } from '../worker/lib/printCloud/util';
import { drawValue, planDraws } from '../worker/lib/printCloud/lots';
import { priceMaterial, promotionDiscount, topUpQuantity, type PricedLine, type TierRow } from '../worker/lib/printCloud/pricing';
import { CUSTOMER_CANCELLABLE, JOB_STATUSES, TERMINAL, TRANSITIONS, canTransition } from '../worker/lib/printCloud/jobs';
import { shelfPack, validatePlacements, occupied } from '../worker/lib/printCloud/plates';
import { detectFormat, fitsBuildVolume, inspect3mfArchive, validateUpload } from '../worker/lib/printCloud/files';
import { signGatewayPayload, verifyGatewaySignature, paymentAvailable } from '../worker/lib/printCloud/payments';
import { DEFAULT_CONFIG, normalizeConfig, publicSettings } from '../worker/lib/printCloud/settings';
import { classifyDbError, pcError, pcWords } from '../worker/lib/printCloud/errors';
import { NOTICE_TEXT } from '../worker/lib/printCloud/notify';
import { printCloudHostAllowed } from '../worker/lib/printCloud/http';
import { classifyHost } from '../worker/lib/hosts';
import { boxStl } from './fixtures/printCloud';

test('money: a × b / c rounds half up exactly, beyond 2^53 intermediates', () => {
  assert.equal(mulDivRound(24250, 500, 1000), 12125);
  assert.equal(mulDivRound(12125, 5000, 10000), 6063); // 6,062.5 → 6,063
  assert.equal(mulDivRound(1, 1, 3), 0);
  assert.equal(mulDivRound(2, 1, 3), 1);
  assert.equal(mulMulDivRound(24250, 500, 5000, 1000, 10000), 6063);
  // 9e15 × 9e3 overflows a double; BigInt keeps it exact.
  assert.equal(mulDivRound(9_000_000_000_000_000 / 1000, 9000, 9000), 9_000_000_000_000);
  assert.throws(() => mulDivRound(1.5, 2, 3));
  assert.throws(() => mulDivRound(-1, 2, 3));
  assert.equal(roundUpTo(15680, 250), 15750);
  assert.equal(roundUpTo(15750, 250), 15750);
  assert.equal(roundUpTo(15680, 0), 15680);
});

test('apportion: integer parts that always sum to the total', () => {
  for (const [total, weights] of [
    [100, [1, 1, 1]],
    [7, [3, 3, 1]],
    [12345, [36000, 8000, 2000, 1500]],
    [1, [5, 5]],
  ] as Array<[number, number[]]>) {
    const parts = apportion(total, weights);
    assert.equal(parts.reduce((s, v) => s + v, 0), total);
    assert.ok(parts.every((p) => Number.isInteger(p) && p >= 0));
  }
  assert.deepEqual(apportion(10, [0, 0]), [0, 0]);
});

test('lots: draw values are cumulative — however a lot is drawn, its draws sum to exactly what was paid', () => {
  const lot = { id: 'l', total: 1000, remaining: 1000, value: 24250 };
  let remaining = 1000;
  let sum = 0;
  for (const k of [1, 7, 333, 159, 500]) {
    sum += drawValue({ ...lot, remaining }, k);
    remaining -= k;
  }
  assert.equal(remaining, 0);
  assert.equal(sum, 24250);
  const plan = planDraws(
    [
      { id: 'a', total: 100, remaining: 30, value: 3500 },
      { id: 'b', total: 250, remaining: 250, value: 8000 },
    ],
    100
  );
  assert.deepEqual(plan.draws.map((d) => [d.lotId, d.qty, d.expectedRemaining]), [['a', 30, 30], ['b', 70, 250]]);
  assert.equal(plan.shortfall, 0);
  assert.equal(planDraws([{ id: 'a', total: 10, remaining: 10, value: 10 }], 11).shortfall, 1);
});

const PLA: TierRow[] = [
  { mode: 'pack', min_qty: 100, pack_price_iqd: 3500, unit_price_milli_iqd: null },
  { mode: 'pack', min_qty: 250, pack_price_iqd: 8000, unit_price_milli_iqd: null },
  { mode: 'pack', min_qty: 500, pack_price_iqd: 14500, unit_price_milli_iqd: null },
  { mode: 'pack', min_qty: 1000, pack_price_iqd: 24250, unit_price_milli_iqd: null },
  { mode: 'bracket', min_qty: 100, pack_price_iqd: null, unit_price_milli_iqd: 35000 },
  { mode: 'bracket', min_qty: 250, pack_price_iqd: null, unit_price_milli_iqd: 32000 },
  { mode: 'bracket', min_qty: 500, pack_price_iqd: null, unit_price_milli_iqd: 29000 },
  { mode: 'bracket', min_qty: 1000, pack_price_iqd: null, unit_price_milli_iqd: 24250 },
];

test('gram pricing engine: packs, brackets, rounding up, the next-pack cap, and the 1 kg best value', () => {
  const p = (q: number, cap = true) => priceMaterial(q, PLA, { rounding: 250, capAtNextPack: cap })!;
  assert.equal(p(100).price_iqd, 3500);
  assert.equal(p(1000).price_iqd, 24250);
  assert.equal(p(150).price_iqd, 5250); // 35 × 150
  assert.equal(p(200).price_iqd, 7000);
  assert.equal(p(370).price_iqd, 12000); // 11,840 → 12,000
  assert.equal(p(750).price_iqd, 21750); // 29 × 750
  assert.equal(p(1500).price_iqd, 36500);
  assert.equal(p(490).price_iqd, 14500); // capped by the 500 g pack
  assert.equal(p(490).capped_by_pack_qty, 500);
  assert.equal(p(490, false).price_iqd, 15750);
  const perGram = [100, 250, 500, 1000].map((q) => p(q).effective_unit_price_milli_iqd);
  assert.deepEqual([...perGram].sort((a, b) => b - a), perGram, 'bigger packs never cost more per gram');
  assert.equal(priceMaterial(50, PLA, { rounding: 250, capAtNextPack: true }), null, 'below every bracket: no price, never a guess');
  assert.equal(topUpQuantity(490, 1000, 10, 100), 510);
  assert.equal(topUpQuantity(995, 1000, 10, 100), 100, 'a top-up is never below the minimum purchase');
  assert.equal(topUpQuantity(1000, 1000, 10, 100), 0);
  assert.equal(topUpQuantity(493, 1000, 10, 100), 510, 'rounded up to the step');
});

test('promotions: scoped, thresholded, apportioned to the dinar', () => {
  const line = (kind: PricedLine['kind'], price: number, tier: string | null = null): PricedLine => ({
    line_no: 1, kind, tier_id: tier, package_id: null, variant_id: null, category_code: kind === 'material' ? 'filaments' : null, quantity: 1, seconds: 0,
    base_price_iqd: price, discount_iqd: 0, final_price_iqd: price, fulfillment: 'credits', project_id: null, expires_after_days: null, bundle: [], breakdown: {}, stock: null,
  });
  const lines = [line('credit_package', 36000, 't1'), line('material', 8000), line('material', 3500)];
  const promo = { id: 'p', code: null, scope: 'materials', percent_bps: 1000, amount_off_iqd: 0, min_subtotal_iqd: 0, membership: null, starts_at: null, ends_at: null, max_redemptions: null, redemptions: 0 };
  assert.deepEqual(promotionDiscount(promo, lines), [0, 800, 350]);
  assert.deepEqual(promotionDiscount({ ...promo, scope: 'tier:t1', percent_bps: 0, amount_off_iqd: 5000 }, lines), [5000, 0, 0]);
  assert.deepEqual(promotionDiscount({ ...promo, min_subtotal_iqd: 20000 }, lines), [0, 0, 0]);
});

test('job state machine: only declared transitions; terminal states lead nowhere; every state is reachable from draft', () => {
  for (const t of TERMINAL) assert.deepEqual(TRANSITIONS[t], [], `${t} is terminal`);
  assert.equal(canTransition('completed', 'printing'), false, 'a completed job never restarts');
  assert.equal(canTransition('cancelled', 'queued'), false, 'a cancelled job never returns to the queue');
  assert.equal(canTransition('failed', 'completed'), false);
  assert.equal(canTransition('queued', 'printing'), false, 'nothing prints without a machine assigned');
  const seen = new Set(['draft']);
  const walk = ['draft'];
  while (walk.length) {
    for (const n of TRANSITIONS[walk.pop() as keyof typeof TRANSITIONS]) {
      if (seen.has(n)) continue;
      seen.add(n);
      walk.push(n);
    }
  }
  assert.deepEqual([...seen].sort(), [...JOB_STATUSES].sort());
  assert.ok(!CUSTOMER_CANCELLABLE.includes('printing'), 'a customer cannot cancel a running print; they ask an operator');
});

test('plates: placements are checked against the bed, the height and each other; the shelf packer places real rectangles', () => {
  const bed = { x_um: 256_000, y_um: 256_000, z_um: 256_000 };
  const fp = { x_um: 40_000, y_um: 30_000, z_um: 10_000 };
  const place = (key: string, x: number, y: number, rot = 0) => ({ key, x_um: x, y_um: y, rotation_z_mdeg: rot, scale_ppm: 1_000_000, footprint: fp });
  assert.deepEqual(validatePlacements([place('a', 50_000, 50_000), place('b', 120_000, 50_000)], bed, 5000), []);
  assert.equal(validatePlacements([place('a', 50_000, 50_000), place('b', 70_000, 50_000)], bed, 5000)[0].code, 'COLLISION');
  assert.equal(validatePlacements([place('a', 10_000, 50_000)], bed, 5000)[0].code, 'OUT_OF_BED');
  assert.equal(validatePlacements([{ ...place('a', 50_000, 50_000), footprint: { ...fp, z_um: 300_000 } }], bed, 0)[0].code, 'TOO_TALL');
  const r = occupied(place('a', 100_000, 100_000, 90_000));
  assert.deepEqual([Math.round(r.maxX - r.minX), Math.round(r.maxY - r.minY)], [30_000, 40_000], 'rotated 90° swaps the footprint');
  const items = Array.from({ length: 20 }, (_, i) => ({ key: `m#${i + 1}`, footprint: fp, scale_ppm: 1_000_000 }));
  const out = shelfPack.arrange(items, bed, 5000);
  assert.equal(out.placements.length + out.unplaced.length, 20);
  assert.deepEqual(validatePlacements(out.placements, bed, 5000), [], 'whatever the packer places is valid');
  const tooBig = shelfPack.arrange([{ key: 'x#1', footprint: { x_um: 300_000, y_um: 10_000, z_um: 10_000 }, scale_ppm: 1_000_000 }], bed, 5000);
  assert.deepEqual(tooBig.unplaced, ['x#1'], 'what cannot fit is reported, never forced');
  assert.equal(shelfPack.name, 'bbox_shelf_v1');
});

test('files: the bytes must prove the format; 3MF archives are inspected without inflating', async () => {
  const stl = boxStl(10, 10, 10);
  assert.equal(detectFormat(stl), 'stl');
  assert.equal(detectFormat(strToU8('solid cube\nfacet normal 0 0 1\n')), 'stl');
  assert.equal(detectFormat(strToU8('# obj\nv 0 0 0\nv 1 0 0\nf 1 2 3\n')), 'obj');
  assert.equal(detectFormat(strToU8('<html>not a model</html>')), 'unknown');
  assert.equal(detectFormat(new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 1, 2, 3])), 'unknown', 'an executable is not an OBJ');
  await assert.rejects(validateUpload(strToU8('hello'), 'renamed.stl', 1_000_000), (e: { code?: string }) => e.code === 'FILE_TYPE_NOT_SUPPORTED');
  await assert.rejects(validateUpload(stl, 'model.step', 1_000_000), (e: { code?: string }) => e.code === 'FILE_TYPE_NOT_SUPPORTED');
  await assert.rejects(validateUpload(stl, 'model.stl', 100), (e: { code?: string }) => e.code === 'FILE_TOO_LARGE');
  const ok = await validateUpload(stl, 'model.STL', 1_000_000);
  assert.equal(ok.extension, 'stl');
  assert.match(ok.sha256, /^[0-9a-f]{64}$/);
  const model = strToU8('<model><resources/></model>');
  assert.equal(inspect3mfArchive(zipSync({ '3D/3dmodel.model': model })).ok, true);
  assert.equal(inspect3mfArchive(zipSync({ '../../evil.model': model })).reason, 'ARCHIVE_PATH_TRAVERSAL');
  assert.equal(inspect3mfArchive(zipSync({ '3D/3dmodel.model': model, 'Metadata/run.exe': strToU8('MZ') })).reason, 'ARCHIVE_DANGEROUS_ENTRY');
  assert.equal(inspect3mfArchive(zipSync({ 'readme.txt': strToU8('x') })).reason, 'ARCHIVE_NO_MODEL');
  assert.equal(inspect3mfArchive(strToU8('PK\u0003\u0004garbage')).ok, false);
  assert.deepEqual(fitsBuildVolume({ x: 300, y: 10, z: 10 }, { x: 256, y: 256, z: 320 }), { as_oriented: false, any_orientation: true });
});

test('payment webhook signatures: correct, fresh, untampered — or refused', async () => {
  const secret = 's'.repeat(40);
  const body = JSON.stringify({ event_id: 'e', order_id: 'o', amount_iqd: 100, status: 'succeeded' });
  const now = new Date('2026-10-26T12:00:00Z');
  const t = Math.floor(now.getTime() / 1000);
  const sig = await signGatewayPayload(secret, body, t);
  assert.equal(await verifyGatewaySignature(secret, body, sig, now), true);
  assert.equal(await verifyGatewaySignature(secret, body.replace('100', '1'), sig, now), false, 'a changed amount breaks the signature');
  assert.equal(await verifyGatewaySignature(secret, body, sig, new Date(now.getTime() + 301_000)), false, 'replayed after the window');
  assert.equal(await verifyGatewaySignature('t'.repeat(40), body, sig, now), false);
  assert.equal(await verifyGatewaySignature(secret, body, null, now), false);
  assert.equal(await verifyGatewaySignature('short', body, sig, now), false);
  assert.equal(paymentAvailable({}, 'dev'), false, 'the development adapter is off unless explicitly on');
  assert.equal(paymentAvailable({ PRINT_CLOUD_DEV_PAYMENTS: 'true' }, 'dev'), false);
  assert.equal(paymentAvailable({ PRINT_CLOUD_DEV_PAYMENTS: 'on' }, 'dev'), true);
  assert.equal(paymentAvailable({}, 'levonis_wallet'), false, 'the wallet adapter is not connected');
  assert.equal(paymentAvailable({}, 'manual'), true);
});

test('configuration: defaults are safe, out-of-range values fall back, cost keys are the owner’s', () => {
  assert.equal(DEFAULT_CONFIG.enabled, false, 'the service starts closed');
  assert.equal(DEFAULT_CONFIG.failure_policy.workshop, 'no_charge');
  const c = normalizeConfig({ quote_ttl_minutes: -5, telemetry_stale_seconds: 'x', failure_policy: { workshop: 'charge_everything' }, import_providers: [{ id: 'evil', hosts: ['127.0.0.1'] }] });
  assert.equal(c.quote_ttl_minutes, DEFAULT_CONFIG.quote_ttl_minutes);
  assert.equal(c.failure_policy.workshop, 'no_charge');
  assert.deepEqual(c.import_providers, [], 'a provider with no valid host is dropped');
  assert.ok(!('cost_electricity_iqd_per_kwh' in publicSettings(c)));
});

test('three languages: every refusal and every notice has Arabic, English and Sorani — and Sorani is never the Arabic', () => {
  const codes = ['OUT_OF_STOCK', 'INSUFFICIENT_CREDIT', 'INSUFFICIENT_INVENTORY', 'INVALID_TRANSITION', 'PRINT_CLOUD_DISABLED', 'FILE_REJECTED', 'BUYBACK_NOT_ALLOWED'] as const;
  for (const code of codes) {
    const w = pcWords(code);
    assert.ok(w.ar && w.en && w.ckb, code);
    assert.notEqual(w.ckb, w.ar, `${code}: ckb must not copy the Arabic`);
    const err = pcError(code);
    assert.equal(err.code, code);
    assert.deepEqual((err.details as { messages: unknown }).messages, w);
  }
  for (const [notice, t] of Object.entries(NOTICE_TEXT)) {
    assert.ok(t.title_ckb && t.body_ckb && t.title_ar && t.title_en, notice);
    assert.notEqual(t.title_ckb, t.title_ar, notice);
    assert.notEqual(t.body_ckb, t.body_ar, notice);
  }
});

test('database refusals map to their meaning; anything else is not a refusal', () => {
  assert.equal(classifyDbError(new Error('PC_FENCE:OUT_OF_STOCK'))?.code, 'OUT_OF_STOCK');
  assert.equal(classifyDbError(new Error('D1_ERROR: CHECK constraint failed: ck_pc_credit_available: SQLITE_CONSTRAINT'))?.code, 'INSUFFICIENT_CREDIT');
  assert.equal(classifyDbError(new Error('UNIQUE constraint failed: pc_printer_assignments.printer_id'))?.code, 'PRINTER_BUSY');
  assert.equal(classifyDbError(new Error('UNIQUE constraint failed: pc_variants.sku'))?.code, 'VALIDATION');
  assert.equal(classifyDbError(new Error('PC_APPEND_ONLY'))?.code, 'FORBIDDEN');
  assert.equal(classifyDbError(new Error('network connection lost')), null, 'an outage is a 500 to retry, never an invented refusal');
});

test('hosts: Print Cloud never answers on a merchant storefront', () => {
  const root = 'levonis-iq.com';
  assert.equal(printCloudHostAllowed(classifyHost('levonis-iq.com', root)), true);
  assert.equal(printCloudHostAllowed(classifyHost('cloud.levonis-iq.com', root)), true);
  assert.equal(printCloudHostAllowed(classifyHost('ali3d.levonis-iq.com', root)), false);
  assert.equal(printCloudHostAllowed(classifyHost('studio.levonis-iq.com', root)), false);
  assert.equal(printCloudHostAllowed(classifyHost('a.b.levonis-iq.com', root)), false);
  assert.equal(printCloudHostAllowed(classifyHost('localhost', root)), true);
  assert.equal(classifyHost('cloud.levonis-iq.com', root).kind, 'system', 'cloud is reserved: no merchant can take it');
});
