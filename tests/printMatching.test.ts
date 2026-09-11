/**
 * SMART MATCHING, pinned on the owner's own worked example.
 *
 * The spec gave four merchants and the answer for each:
 *
 *   Request: PETG · black · 220x180x140 · Baghdad
 *   A  resin only ................................ NO notification
 *   B  FDM but the bed is too small ............... NO notification
 *   C  FDM + PETG + enough build volume ........... notify
 *   D  compatible but notifications paused ........ NO notification
 *
 * That case is the first test below, verbatim. The rest pin the rules that make
 * it hold in every other shape: physics before preference, PRO never buying
 * eligibility, and every rejection carrying a reason a merchant could be shown.
 *
 * Run: npm run test:unit
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchMerchants,
  decide,
  printerFits,
  fitsInBuild,
  requiredCapabilities,
  DEFAULT_MATCH_WEIGHTS,
  type MatchRequest,
  type MerchantCandidate,
  type MerchantPrinter,
  type MerchantPrefs,
} from '../worker/lib/printMatching';
import { DEFAULT_MATERIALS, type PrintMaterial } from '../worker/lib/printPricing';

const NOW = Date.parse('2026-03-01T12:00:00Z');
const W = DEFAULT_MATCH_WEIGHTS;
const petg = DEFAULT_MATERIALS.find((m) => m.id === 'petg')!;

// ---------------------------------------------------------------- fixtures

const printer = (o: Partial<MerchantPrinter> = {}): MerchantPrinter => ({
  id: 'p1',
  technology: 'fdm',
  build_x_mm: 256,
  build_y_mm: 256,
  build_z_mm: 256,
  nozzle_mm: 0.4,
  materials: ['pla', 'petg'],
  colors: [],
  multicolor: false,
  enclosed: false,
  hardened_nozzle: false,
  quality_max: 'fine',
  machine_hour_iqd: null,
  availability: 'available',
  active: true,
  ...o,
});

const prefs = (o: Partial<MerchantPrefs> = {}): MerchantPrefs => ({
  processes: [],
  materials: [],
  colors: [],
  capabilities: [],
  governorates: [],
  delivery: [],
  min_job_iqd: 0,
  max_job_iqd: null,
  min_size_mm: 0,
  max_size_mm: null,
  workload: 'normal',
  paused: false,
  paused_until: null,
  ...o,
});

const merchant = (id: string, o: Partial<MerchantCandidate> = {}): MerchantCandidate => ({
  merchant_id: id,
  user_id: `u_${id}`,
  status: 'active',
  store_status: 'active',
  store_id: `s_${id}`,
  accepts_custom_requests: true,
  governorate: 'baghdad',
  request_opportunities: true,
  printers: [printer()],
  prefs: prefs(),
  rating_avg_x100: 450,
  rating_count: 12,
  completed_orders: 20,
  response_minutes: 60,
  trouble_rate: 0,
  pro: false,
  ...o,
});

const request = (o: Partial<MatchRequest> = {}): MatchRequest => ({
  id: 'req1',
  process: 'fdm',
  material_id: 'petg',
  color_hex: '#000000',
  quality: 'standard',
  colors_count: 1,
  dimensions_mm: { x: 220, y: 180, z: 140 },
  governorate: 'baghdad',
  delivery_pref: '',
  estimate_iqd: 25000,
  quantity: 1,
  ...o,
});

// ------------------------------------------------- 1. the owner's example

test("the owner's four merchants get exactly the four answers they specified", () => {
  const req = request();
  const merchants = [
    // A — resin only.
    merchant('A', { printers: [printer({ technology: 'resin', materials: ['resin-standard'] })] }),
    // B — FDM, but 180x180x180 cannot take a 220mm part in any orientation.
    merchant('B', { printers: [printer({ build_x_mm: 180, build_y_mm: 180, build_z_mm: 180 })] }),
    // C — FDM, PETG, 256mm bed.
    merchant('C'),
    // D — identical to C, but paused.
    merchant('D', { prefs: prefs({ paused: true }) }),
  ];

  const { decisions, notify } = matchMerchants(merchants, req, petg, W, NOW);
  const by = new Map(decisions.map((d) => [d.merchant_id, d]));

  assert.equal(by.get('A')!.eligible, false, 'A is a resin shop');
  assert.equal(by.get('A')!.reject_reason, 'PROCESS');

  assert.equal(by.get('B')!.eligible, false, "B's bed is too small");
  assert.equal(by.get('B')!.reject_reason, 'BUILD_VOLUME');

  assert.equal(by.get('C')!.eligible, true, 'C can make it');

  assert.equal(by.get('D')!.eligible, false, 'D asked not to be told');
  assert.equal(by.get('D')!.reject_reason, 'PAUSED');

  assert.deepEqual(notify.map((d) => d.merchant_id), ['C'], 'exactly one merchant is notified');
});

test('the matcher returns decisions only — it can never create a request', () => {
  const { decisions, notify } = matchMerchants([merchant('C')], request(), petg, W, NOW);
  // The shape is the whole guarantee: there is no request field to write to.
  for (const d of [...decisions, ...notify]) {
    assert.deepEqual(
      Object.keys(d).sort(),
      ['detail', 'eligible', 'merchant_id', 'printer_id', 'reject_reason', 'score', 'user_id'],
      'a decision names a merchant and a reason, and nothing else'
    );
  }
});

test('every rejected merchant carries a reason that could be shown to them', () => {
  const req = request();
  const merchants = [
    merchant('m1', { status: 'suspended' }),
    merchant('m2', { store_status: 'paused' }),
    merchant('m3', { accepts_custom_requests: false }),
    merchant('m4', { request_opportunities: false }),
    merchant('m5', { printers: [] }),
    merchant('m6', { printers: [printer({ materials: ['pla'] })] }),
    merchant('m7', { prefs: prefs({ governorates: ['basra'] }) }),
    merchant('m8', { prefs: prefs({ min_job_iqd: 100000 }) }),
  ];
  const { decisions } = matchMerchants(merchants, req, petg, W, NOW);
  assert.deepEqual(
    decisions.map((d) => d.reject_reason),
    [
      'MERCHANT_INACTIVE', 'STORE_UNAVAILABLE', 'NOT_TAKING_REQUESTS', 'NOTIFICATIONS_OFF',
      'NO_PRINTER', 'MATERIAL', 'GOVERNORATE', 'JOB_TOO_SMALL',
    ]
  );
  assert.equal(decisions.every((d) => !d.eligible), true);
});

// --------------------------------------------------- 2. physics is absolute

test('a part is allowed to be rotated onto the bed, as a slicer would', () => {
  const bed = { build_x_mm: 250, build_y_mm: 250, build_z_mm: 150 };
  // 140 tall fits standing; 240 does not, but lying down it does.
  assert.equal(fitsInBuild({ x: 220, y: 180, z: 140 }, bed), true);
  assert.equal(fitsInBuild({ x: 240, y: 100, z: 100 }, bed), true, 'lay it on its side');
  assert.equal(fitsInBuild({ x: 300, y: 100, z: 100 }, bed), false, 'nothing saves 300mm');
});

test('a resin shop is never told about an FDM job, whatever else is true', () => {
  const superb = merchant('star', {
    printers: [printer({ technology: 'resin' })],
    rating_avg_x100: 500,
    rating_count: 900,
    completed_orders: 5000,
    response_minutes: 1,
    trouble_rate: 0,
    pro: true,
  });
  const d = decide(superb, request(), petg, W, NOW);
  assert.equal(d.eligible, false);
  assert.equal(d.reject_reason, 'PROCESS');
  assert.equal(d.score, 0, 'an ineligible merchant has no score to compare');
});

test('an enclosure and a hardened nozzle are facts, not preferences', () => {
  const abs = DEFAULT_MATERIALS.find((m) => m.id === 'abs')!;
  const cf = DEFAULT_MATERIALS.find((m) => m.id === 'pla-cf')!;
  const open = printer({ materials: ['abs', 'pla-cf'], enclosed: false, hardened_nozzle: false });

  assert.equal(printerFits(open, request({ material_id: 'abs' }), abs), 'MATERIAL', 'ABS needs a chamber');
  assert.equal(printerFits(open, request({ material_id: 'pla-cf' }), cf), 'MATERIAL', 'CF needs a hardened nozzle');

  const equipped = printer({ materials: ['abs', 'pla-cf'], enclosed: true, hardened_nozzle: true });
  assert.equal(printerFits(equipped, request({ material_id: 'abs' }), abs), '');
  assert.equal(printerFits(equipped, request({ material_id: 'pla-cf' }), cf), '');
});

test('a machine that cannot reach the asked-for quality is not offered the job', () => {
  const rough = merchant('rough', { printers: [printer({ quality_max: 'standard' })] });
  assert.equal(decide(rough, request({ quality: 'ultra' }), petg, W, NOW).reject_reason, 'QUALITY');
  assert.equal(decide(rough, request({ quality: 'draft' }), petg, W, NOW).eligible, true);
});

test('a multicolour job needs a multicolour machine', () => {
  const single = merchant('single');
  assert.equal(decide(single, request({ colors_count: 3 }), petg, W, NOW).reject_reason, 'CAPABILITY');
  const ams = merchant('ams', { printers: [printer({ multicolor: true })] });
  assert.equal(decide(ams, request({ colors_count: 3 }), petg, W, NOW).eligible, true);
});

test('the rejection names the most fundamental problem, not the first one checked', () => {
  // This shop is wrong about the process AND the size AND the material. The
  // reason a merchant should be shown is the one they cannot fix by buying a
  // spool.
  const hopeless = merchant('h', {
    printers: [printer({ technology: 'resin', build_x_mm: 50, build_y_mm: 50, build_z_mm: 50, materials: ['pla'] })],
  });
  assert.equal(decide(hopeless, request(), petg, W, NOW).reject_reason, 'PROCESS');
});

// ------------------------------------------------- 3. PRO never buys a match

test('PRO cannot make an incompatible merchant eligible', () => {
  const proButWrong = merchant('pro', {
    pro: true,
    printers: [printer({ build_x_mm: 100, build_y_mm: 100, build_z_mm: 100 })],
  });
  const d = decide(proButWrong, request(), petg, W, NOW);
  assert.equal(d.eligible, false);
  assert.equal(d.reject_reason, 'BUILD_VOLUME');
});

test('PRO reorders merchants who already qualify, and only by a little', () => {
  const plain = merchant('plain');
  const pro = merchant('pro', { pro: true });
  const { notify } = matchMerchants([plain, pro], request(), petg, W, NOW);
  assert.deepEqual(notify.map((d) => d.merchant_id), ['pro', 'plain'], 'PRO goes first between equals');

  // But a materially better shop still beats a PRO one.
  const better = merchant('better', { rating_avg_x100: 500, rating_count: 200, completed_orders: 400, response_minutes: 10 });
  const worseButPro = merchant('worsepro', { pro: true, rating_avg_x100: 300, rating_count: 200, completed_orders: 1, response_minutes: 900, trouble_rate: 0.2 });
  const ranked = matchMerchants([worseButPro, better], request(), petg, W, NOW).notify;
  assert.equal(ranked[0].merchant_id, 'better', 'reputation outweighs a subscription');
});

test('the PRO bonus is worth no more than the smallest merit signal', () => {
  const others = Object.entries(W).filter(([k]) => k !== 'pro_bonus').map(([, v]) => v);
  assert.ok(W.pro_bonus <= Math.min(...others), 'a subscription must not outweigh any real signal');
  const total = Object.values(W).reduce((n, v) => n + v, 0);
  assert.ok(W.pro_bonus / total < 0.05, `PRO is ${Math.round((W.pro_bonus / total) * 100)}% of the ranking`);
});

// ------------------------------------------------------- 4. the preferences

test('a paused merchant is silent even when nobody else can take the job', () => {
  const only = merchant('only', { prefs: prefs({ paused: true }) });
  const { notify } = matchMerchants([only], request(), petg, W, NOW);
  assert.equal(notify.length, 0, 'a pause is a pause');
});

test('a pause with an end date stops applying after it', () => {
  const m = merchant('m', { prefs: prefs({ paused: true, paused_until: '2026-02-01T00:00:00Z' }) });
  assert.equal(decide(m, request(), petg, W, NOW).eligible, true, 'the pause expired in February');
  const still = merchant('m', { prefs: prefs({ paused: true, paused_until: '2026-12-01T00:00:00Z' }) });
  assert.equal(decide(still, request(), petg, W, NOW).reject_reason, 'PAUSED');
});

test('an empty preference list means "everything my printers can do"', () => {
  // The default merchant has declared no filters at all and must still match.
  assert.equal(decide(merchant('m'), request(), petg, W, NOW).eligible, true);
});

test('a job outside a merchant stated size or value band is not sent to them', () => {
  const small = merchant('small', { prefs: prefs({ max_size_mm: 100 }) });
  assert.equal(decide(small, request(), petg, W, NOW).reject_reason, 'SIZE_PREFERENCE');
  const big = merchant('big', { prefs: prefs({ min_size_mm: 400 }) });
  assert.equal(decide(big, request(), petg, W, NOW).reject_reason, 'SIZE_PREFERENCE');
  const rich = merchant('rich', { prefs: prefs({ min_job_iqd: 200000 }) });
  assert.equal(decide(rich, request(), petg, W, NOW).reject_reason, 'JOB_TOO_SMALL');
  const modest = merchant('modest', { prefs: prefs({ max_job_iqd: 10000 }) });
  assert.equal(decide(modest, request(), petg, W, NOW).reject_reason, 'JOB_TOO_LARGE');
});

// ----------------------------------------------------------- 5. the ranking

test('a merchant in the same governorate outranks a distant one', () => {
  const near = merchant('near', { governorate: 'baghdad' });
  const far = merchant('far', { governorate: 'basra' });
  const { notify } = matchMerchants([far, near], request(), petg, W, NOW);
  assert.equal(notify[0].merchant_id, 'near');
});

test('an idle shop outranks a full one that could also take it', () => {
  const idle = merchant('idle', { prefs: prefs({ workload: 'light' }) });
  const full = merchant('full', { prefs: prefs({ workload: 'full' }) });
  const { notify } = matchMerchants([full, idle], request(), petg, W, NOW);
  assert.equal(notify[0].merchant_id, 'idle');
  assert.equal(notify.length, 2, 'but the busy one is still told — they may want it');
});

test('a shop that cancels and disputes is ranked below one that does not', () => {
  const clean = merchant('clean', { trouble_rate: 0 });
  const messy = merchant('messy', { trouble_rate: 0.3 });
  const { notify } = matchMerchants([messy, clean], request(), petg, W, NOW);
  assert.equal(notify[0].merchant_id, 'clean');
});

test('a brand-new merchant is placed mid-table, not last', () => {
  const fresh = merchant('fresh', { rating_avg_x100: 0, rating_count: 0, completed_orders: 0, response_minutes: null });
  const poor = merchant('poor', { rating_avg_x100: 200, rating_count: 40, completed_orders: 5, response_minutes: 1400, trouble_rate: 0.25 });
  const { notify } = matchMerchants([poor, fresh], request(), petg, W, NOW);
  assert.equal(notify[0].merchant_id, 'fresh', 'no history beats a bad one');
});

test('the score is explained line by line, so a ranking can be argued with', () => {
  const d = decide(merchant('m'), request(), petg, W, NOW);
  assert.equal(d.eligible, true);
  assert.deepEqual(Object.keys(d.detail).sort(), Object.keys(W).sort(), 'every weight is accounted for');
  assert.equal(
    Object.values(d.detail).reduce((n, v) => n + v, 0),
    d.score,
    'the parts add up to the whole'
  );
});

test('the notification list is capped, and the cap is the only thing it caps', () => {
  const many = Array.from({ length: 40 }, (_, i) => merchant(`m${String(i).padStart(2, '0')}`));
  const { decisions, notify } = matchMerchants(many, request(), petg, W, NOW, 10);
  assert.equal(decisions.length, 40, 'every merchant is still judged and recorded');
  assert.equal(notify.length, 10, 'ten phones, not forty');
  assert.equal(decisions.filter((d) => d.eligible).length, 40, 'the other thirty are eligible, just not paged');
});

// ------------------------------------------------- 6. what the job demands

test('the capabilities a job needs are derived from the job, not asked for', () => {
  assert.deepEqual(requiredCapabilities(request(), petg), []);
  assert.deepEqual(requiredCapabilities(request({ colors_count: 4 }), petg), ['multicolor']);
  assert.ok(requiredCapabilities(request({ dimensions_mm: { x: 300, y: 100, z: 100 } }), petg).includes('large_format'));
  assert.ok(requiredCapabilities(request({ quality: 'ultra' }), petg).includes('high_detail'));
  assert.ok(requiredCapabilities(request({ process: 'resin' }), null).includes('high_detail'));

  const tpu = DEFAULT_MATERIALS.find((m) => m.id === 'tpu')!;
  assert.ok(requiredCapabilities(request(), tpu).includes('flexible'));
  const cf: PrintMaterial = DEFAULT_MATERIALS.find((m) => m.id === 'petg-cf')!;
  assert.ok(requiredCapabilities(request(), cf).includes('cf'));
});

test('a shop that filtered out a capability the job needs is not told about it', () => {
  const noMulti = merchant('nm', {
    printers: [printer({ multicolor: true })],
    prefs: prefs({ capabilities: ['high_detail'] }),
  });
  assert.equal(decide(noMulti, request({ colors_count: 2 }), petg, W, NOW).reject_reason, 'CAPABILITY');
});
