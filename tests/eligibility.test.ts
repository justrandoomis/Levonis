/**
 * ELIGIBILITY AS DATA (W5-B) — the truth table of worker/lib/eligibility.ts.
 *
 * One baseline workshop that CAN make one baseline job, then each dimension
 * broken on its own: every one narrows (the verdict turns false and names its
 * reason), and no preference can ever widen (a randomised sweep). Plus the
 * rules that sit between the dimensions: notification is not eligibility, an
 * unknown size is `unknown` and not a refusal, stock is judged only when
 * tracked, canonical physics win.
 *
 * Run: node --import tsx --test tests/eligibility.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_REASONS,
  DIMENSIONS,
  EMPTY_PREFS,
  REASONS,
  dimensionOf,
  evaluateEligibility,
  readReasons,
  type CapabilityPrinter,
  type CatalogueMaterial,
  type EligibilityCandidate,
  type EligibilityRequest,
  type MerchantPrefs,
} from '../worker/lib/eligibility';
import { DEFAULT_DELIVERY_PROFILE } from '@levonis/shipping/merchantDelivery';
import { DEFAULT_MATERIALS } from '../worker/lib/printPricing';
import { resolvePrinter } from '../worker/lib/printMatchingStore';
import { REASON_CODES as UI_REASON_CODES } from '../src/components/merchant/workshop/reasons';

const NOW = Date.parse('2026-09-25T12:00:00Z');
const CAT = new Map<string, CatalogueMaterial>(DEFAULT_MATERIALS.map((m) => [m.id, m]));

const printer = (o: Partial<CapabilityPrinter> = {}): CapabilityPrinter => ({
  id: 'p1', technology: 'fdm', build_x_mm: 256, build_y_mm: 256, build_z_mm: 256, nozzle_mm: 0.4,
  materials: [], enclosed: false, hardened_nozzle: false, max_colors: 1, quality_max: 'fine',
  machine_hour_iqd: null, availability: 'available', active: true, canonical: true, ...o,
});
const prefs = (o: Partial<MerchantPrefs> = {}): MerchantPrefs => ({ ...EMPTY_PREFS, ...o });
const shop = (o: Partial<EligibilityCandidate> = {}): EligibilityCandidate => ({
  merchant_id: 'm1', user_id: 'u1', merchant_status: 'active', store_status: 'active', store_id: 's1',
  accepts_custom_requests: true, plan_ok: true, printers: [printer()], stock: 'untracked',
  reach: { profile: { ...DEFAULT_DELIVERY_PROFILE, version: 1 }, rules: [] }, prefs: prefs(),
  request_opportunities: true, ...o,
});
const job = (o: Partial<EligibilityRequest> = {}): EligibilityRequest => ({
  id: 'r1', customer_id: 'c1', revision: 1, on_board: true, process: 'fdm', material_id: 'petg',
  color_hex: '#000000', quality: 'standard', colors_count: 1, dims_mm: { x: 120, y: 80, z: 40 },
  grams: 90, governorate: 'baghdad', delivery_pref: '', estimate_iqd: 25_000, quantity: 1, ...o,
});
const verdict = (m: EligibilityCandidate, r: EligibilityRequest) => evaluateEligibility(m, r, CAT, NOW);

test('the baseline workshop can make the baseline job, on its one printer, and is told', () => {
  const v = verdict(shop(), job());
  assert.equal(v.eligible, true);
  assert.deepEqual(v.reasons, []);
  assert.equal(v.printer_id, 'p1');
  assert.equal(v.notify, true);
  assert.deepEqual(v.dims, { trade: 'pass', capability: 'pass', stock: 'untracked', reach: 'pass', preference: 'pass' });
});

/** Each row breaks ONE thing and must fail with exactly that reason, in that dimension. */
const TABLE: Array<[string, EligibilityCandidate, EligibilityRequest, string]> = [
  ['request left the board', shop(), job({ on_board: false }), 'REQUEST_CLOSED'],
  ['own request', shop({ user_id: 'c1' }), job(), 'OWN_REQUEST'],
  ['merchant restricted', shop({ merchant_status: 'restricted' }), job(), 'MERCHANT_INACTIVE'],
  ['store paused', shop({ store_status: 'paused' }), job(), 'STORE_UNAVAILABLE'],
  ['no store row at all', shop({ store_status: '' }), job(), 'STORE_UNAVAILABLE'],
  ['plan lapsed', shop({ plan_ok: false }), job(), 'PLAN_LAPSED'],
  ['not taking custom requests', shop({ accepts_custom_requests: false }), job(), 'NOT_TAKING_REQUESTS'],
  ['no printer', shop({ printers: [] }), job(), 'NO_PRINTER'],
  ['printer offline', shop({ printers: [printer({ availability: 'offline' })] }), job(), 'NO_PRINTER'],
  ['resin shop, FDM job', shop({ printers: [printer({ technology: 'resin', nozzle_mm: 0 })] }), job(), 'PROCESS'],
  ['bed too small in every orientation', shop({ printers: [printer({ build_x_mm: 100, build_y_mm: 100, build_z_mm: 100 })] }), job(), 'BUILD_VOLUME'],
  ['material not run on this printer', shop({ printers: [printer({ materials: ['pla'] })] }), job(), 'MATERIAL'],
  ['a resin material on an FDM printer', shop(), job({ material_id: 'resin-tough' }), 'MATERIAL'],
  ['ABS without an enclosure', shop(), job({ material_id: 'abs' }), 'ENCLOSURE'],
  ['CF without a hardened nozzle', shop(), job({ material_id: 'pla-cf' }), 'HARDENED_NOZZLE'],
  ['quality above the machine', shop({ printers: [printer({ quality_max: 'standard' })] }), job({ quality: 'ultra' }), 'QUALITY'],
  ['fine work with a 0.8 nozzle', shop({ printers: [printer({ nozzle_mm: 0.8 })] }), job({ quality: 'fine' }), 'NOZZLE'],
  ['three colours on a single-material machine', shop(), job({ colors_count: 3 }), 'MULTICOLOR'],
  ['stock tracked, material absent', shop({ stock: [{ material_id: 'pla', color_hex: '', grams: 5000 }] }), job(), 'STOCK_MATERIAL'],
  ['stock tracked, colour absent', shop({ stock: [{ material_id: 'petg', color_hex: '#ffffff', grams: 5000 }] }), job(), 'STOCK_COLOR'],
  ['stock tracked, not enough grams', shop({ stock: [{ material_id: 'petg', color_hex: '#000000', grams: 50 }] }), job(), 'STOCK_GRAMS'],
  ['stock tracked, the spool is empty', shop({ stock: [{ material_id: 'petg', color_hex: '#000000', grams: 0 }] }), job(), 'STOCK_MATERIAL'],
  ['delivery off to the customer governorate', shop({ reach: { profile: { ...DEFAULT_DELIVERY_PROFILE, version: 1 }, rules: [{ governorate_id: 'baghdad', mode: 'disabled', fee_iqd: null, free_over_iqd: null, prep_days: null, eta_note: '', note: '' }] } }), job({ delivery_pref: 'delivery' }), 'REACH_DELIVERY'],
  ['pickup asked, pickup off', shop(), job({ delivery_pref: 'pickup' }), 'REACH_PICKUP'],
  ['pickup asked, pickup in another governorate', shop({ reach: { profile: { ...DEFAULT_DELIVERY_PROFILE, pickup_enabled: true, pickup_governorate: 'erbil', version: 1 }, rules: [] } }), job({ delivery_pref: 'pickup' }), 'REACH_PICKUP'],
  ['store delivers nowhere and has no pickup', shop({ reach: { profile: { ...DEFAULT_DELIVERY_PROFILE, default_mode: 'disabled', version: 1 }, rules: [] } }), job(), 'REACH_DELIVERY'],
  ['preference: resin only', shop({ prefs: prefs({ processes: ['resin'] }) }), job(), 'PREF_PROCESS'],
  ['preference: PLA only', shop({ prefs: prefs({ materials: ['pla'] }) }), job(), 'PREF_MATERIAL'],
  ['preference: white only', shop({ prefs: prefs({ colors: ['#ffffff'] }) }), job(), 'PREF_COLOR'],
  ['preference: capabilities without multicolour', shop({ printers: [printer({ max_colors: 4 })], prefs: prefs({ capabilities: ['high_detail'] }) }), job({ colors_count: 2 }), 'PREF_CAPABILITY'],
  ['preference: Basra only', shop({ prefs: prefs({ governorates: ['basra'] }) }), job(), 'PREF_GOVERNORATE'],
  ['preference: pickup jobs only', shop({ prefs: prefs({ delivery: ['pickup'] }) }), job({ delivery_pref: 'delivery' }), 'PREF_DELIVERY'],
  ['preference: parts over 200 mm', shop({ prefs: prefs({ min_size_mm: 200 }) }), job(), 'PREF_SIZE'],
  ['preference: jobs over 100,000', shop({ prefs: prefs({ min_job_iqd: 100_000 }) }), job(), 'PREF_JOB_TOO_SMALL'],
  ['preference: jobs under 10,000', shop({ prefs: prefs({ max_job_iqd: 10_000 }) }), job(), 'PREF_JOB_TOO_LARGE'],
];

for (const [name, m, r, code] of TABLE) {
  test(`narrows — ${name} → ${code}`, () => {
    const v = verdict(m, r);
    assert.equal(v.eligible, false, 'refused');
    assert.deepEqual(v.reasons, [code], 'exactly the one broken thing');
    assert.equal(v.reason, code);
    assert.equal(v.dims[dimensionOf(code as never)], 'fail');
    assert.equal(v.notify, false, 'an ineligible workshop is never told');
    assert.equal(v.printer_id, '');
  });
}

test('the truth table covers every reason code there is', () => {
  const covered = new Set(TABLE.map((row) => row[3]));
  assert.deepEqual(ALL_REASONS.filter((c) => !covered.has(c)), [], 'a reason no test can produce is a reason nobody checked');
});

test('failing reasons are ALL reported, in policy order — trade, capability, stock, reach, preference', () => {
  const v = verdict(
    shop({ plan_ok: false, printers: [printer({ technology: 'resin' })], stock: [{ material_id: 'pla', color_hex: '', grams: 1 }], prefs: prefs({ governorates: ['basra'] }) }),
    job({ delivery_pref: 'pickup' })
  );
  assert.deepEqual(v.reasons, ['PLAN_LAPSED', 'PROCESS', 'STOCK_MATERIAL', 'REACH_PICKUP', 'PREF_GOVERNORATE']);
  assert.equal(v.reason, 'PLAN_LAPSED');
});

test('PREFERENCES NEVER WIDEN: over 4,000 random preference sets, none turns an ineligible verdict eligible', () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <T,>(xs: readonly T[]) => xs.filter(() => rand() < 0.35);
  const blockers: Array<[EligibilityCandidate, EligibilityRequest]> = [
    [shop({ printers: [printer({ build_x_mm: 50, build_y_mm: 50, build_z_mm: 50 })] }), job()],
    [shop({ printers: [printer({ technology: 'resin' })] }), job()],
    [shop({ stock: [{ material_id: 'pla', color_hex: '', grams: 10_000 }] }), job()],
    [shop({ plan_ok: false }), job()],
    [shop(), job({ delivery_pref: 'pickup' })],
    [shop(), job({ material_id: 'abs' })],
  ];
  for (let i = 0; i < 4000; i++) {
    const p = prefs({
      processes: pick(['fdm', 'resin']),
      materials: pick(['pla', 'petg', 'abs', 'resin-tough']),
      colors: pick(['#000000', '#ffffff']),
      capabilities: pick(['multicolor', 'large_format', 'high_detail', 'functional', 'flexible', 'cf']),
      governorates: pick(['baghdad', 'basra', 'erbil']),
      delivery: pick(['delivery', 'pickup']),
      min_job_iqd: rand() < 0.5 ? 0 : Math.floor(rand() * 60_000),
      max_job_iqd: rand() < 0.5 ? null : Math.floor(rand() * 60_000),
      min_size_mm: rand() < 0.5 ? 0 : Math.floor(rand() * 200),
      max_size_mm: rand() < 0.5 ? null : Math.floor(rand() * 400),
      paused: rand() < 0.3,
    });
    const [m, r] = blockers[i % blockers.length];
    assert.equal(verdict({ ...m, prefs: p }, r).eligible, false, `preferences widened case ${i % blockers.length}`);
    // …and from an eligible baseline, a preference can only keep or remove it.
    const base = verdict(shop({ prefs: p }), job());
    if (base.eligible) assert.deepEqual(base.reasons, []);
    else assert.ok(base.reasons.every((c) => dimensionOf(c) === 'preference'), 'only preference reasons appear');
  }
});

test('an empty preference list means everything the workshop can make (decision 6)', () => {
  assert.equal(verdict(shop({ prefs: EMPTY_PREFS }), job({ material_id: 'pla', color_hex: '#ff0000', governorate: 'basra' })).eligible, true);
});

test('NOTIFICATION IS NOT ELIGIBILITY: switched off or paused, the workshop may still bid, it is just not told', () => {
  const off = verdict(shop({ request_opportunities: false }), job());
  assert.equal(off.eligible, true);
  assert.equal(off.notify, false);
  assert.equal(off.notify_block, 'NOTIFICATIONS_OFF');
  const paused = verdict(shop({ prefs: prefs({ paused: true, paused_until: '2026-12-01T00:00:00Z' }) }), job());
  assert.deepEqual([paused.eligible, paused.notify, paused.notify_block], [true, false, 'PAUSED']);
  const expired = verdict(shop({ prefs: prefs({ paused: true, paused_until: '2026-09-01T00:00:00Z' }) }), job());
  assert.equal(expired.notify, true, 'a pause with an end date ends');
});

test('a job of unknown size is not refused on size, and says the size is unknown', () => {
  const v = verdict(shop({ printers: [printer({ build_x_mm: 50, build_y_mm: 50, build_z_mm: 50 })], prefs: prefs({ min_size_mm: 100 }) }), job({ dims_mm: null }));
  assert.equal(v.eligible, true);
  assert.equal(v.dims.capability, 'unknown');
});

test('«لست متأكدًا»: an unsure process fits a resin shop and an FDM shop; an unsure material skips the material gates', () => {
  const unsure = job({ process: null, material_id: null });
  assert.equal(verdict(shop({ printers: [printer({ technology: 'resin', nozzle_mm: 0 })] }), unsure).eligible, true);
  assert.equal(verdict(shop(), unsure).eligible, true);
  // …but a technology preference still narrows it to shops whose capable machine matches.
  assert.equal(verdict(shop({ prefs: prefs({ processes: ['resin'] }) }), unsure).eligible, false);
  // Stock with an unsure material: any stocked material of a capable technology feeds it.
  assert.equal(verdict(shop({ stock: [{ material_id: 'pla', color_hex: '', grams: 500 }] }), job({ material_id: null, color_hex: '' })).eligible, true);
  assert.deepEqual(verdict(shop({ stock: [{ material_id: 'resin-tough', color_hex: '', grams: 500 }] }), job({ material_id: null })).reasons, ['STOCK_MATERIAL']);
});

test('stock: untracked is judged on printers alone; a colour-untracked line serves any colour; grams unknown needs only some', () => {
  assert.equal(verdict(shop({ stock: 'untracked' }), job()).dims.stock, 'untracked');
  assert.equal(verdict(shop({ stock: [{ material_id: 'petg', color_hex: '', grams: 500 }] }), job()).eligible, true);
  assert.equal(verdict(shop({ stock: [{ material_id: 'petg', color_hex: '#000000', grams: 5 }] }), job({ grams: null })).eligible, true);
});

test('reach: a store that never configured delivery (free everywhere) reaches any governorate; pickup in the same governorate counts', () => {
  assert.equal(verdict(shop(), job({ delivery_pref: 'delivery', governorate: 'duhok' })).eligible, true);
  const pickupHere = shop({ reach: { profile: { ...DEFAULT_DELIVERY_PROFILE, default_mode: 'disabled', pickup_enabled: true, pickup_governorate: 'baghdad', version: 1 }, rules: [] } });
  assert.equal(verdict(pickupHere, job({ delivery_pref: 'pickup' })).eligible, true);
  assert.equal(verdict(pickupHere, job({ delivery_pref: '' })).eligible, true, '«either» is satisfied by pickup');
  assert.deepEqual(verdict(pickupHere, job({ delivery_pref: 'delivery' })).reasons, ['REACH_DELIVERY']);
});

test('the machine chosen is the idle one, then the cheapest hour', () => {
  const m = shop({
    printers: [
      printer({ id: 'busy', availability: 'busy', machine_hour_iqd: 500 }),
      printer({ id: 'dear', machine_hour_iqd: 3000 }),
      printer({ id: 'cheap', machine_hour_iqd: 1000 }),
    ],
  });
  assert.equal(verdict(m, job()).printer_id, 'cheap');
});

test('CANONICAL PHYSICS WIN: a printer tied to a model takes the model\'s bed, enclosure and nozzle, whatever was typed', () => {
  const typedHuge = {
    id: 'p', technology: 'fdm', build_x_mm: 900, build_y_mm: 900, build_z_mm: 900, nozzle_mm: 0.4, materials: '[]',
    enclosed: 1, hardened_nozzle: 1, multicolor: 1, quality_max: 'ultra', availability: 'available', active: 1,
    m_id: 'bbl-a1m', m_technology: 'fdm', m_build_x_mm: 180, m_build_y_mm: 180, m_build_z_mm: 180,
    m_nozzle_sizes: '[0.2,0.4,0.6,0.8]', m_default_nozzle_mm: 0.4, m_enclosed: 0, m_hardened: 0, m_max_simultaneous_materials: 4,
  };
  const p = resolvePrinter(typedHuge);
  assert.deepEqual([p.build_x_mm, p.enclosed, p.hardened_nozzle, p.max_colors, p.canonical], [180, false, false, 4, true]);
  assert.deepEqual(verdict(shop({ printers: [p] }), job({ dims_mm: { x: 300, y: 50, z: 50 } })).reasons, ['BUILD_VOLUME']);
  assert.deepEqual(verdict(shop({ printers: [p] }), job({ material_id: 'abs' })).reasons, ['ENCLOSURE']);
  // A self-declared printer keeps what was typed (and is marked as such).
  const own = resolvePrinter({ ...typedHuge, m_id: null });
  assert.deepEqual([own.build_x_mm, own.canonical], [900, false]);
  // A resin printer has no nozzle, whatever the row says.
  assert.equal(resolvePrinter({ ...typedHuge, technology: 'resin', m_id: null }).nozzle_mm, 0);
});

test('every reason code has words in the client, and nothing else does', () => {
  assert.deepEqual([...UI_REASON_CODES].sort(), [...ALL_REASONS].sort());
  assert.deepEqual(DIMENSIONS, ['trade', 'capability', 'stock', 'reach', 'preference']);
  assert.equal(REASONS.capability[0], 'NO_PRINTER');
});

test('a stored reasons column is read back with only known codes', () => {
  assert.deepEqual(readReasons('["PROCESS","<script>","STOCK_GRAMS"]'), ['PROCESS', 'STOCK_GRAMS']);
  assert.deepEqual(readReasons('not json'), []);
});
