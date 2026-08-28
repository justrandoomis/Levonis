/**
 * Unit tests for per-device warranty math (worker/lib/deviceOps.ts).
 * Run: npm run test:unit
 * Pins mandate §4: calendar-month coverage from delivered_at (leap years,
 * end-of-month clamping), +12/+24 extensions → 24/36 total, explicit
 * serialization config, honest needs_config for unconfigured durations,
 * and registration never touching any clock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMonths } from '../worker/lib/membershipOps';
import {
  parseOpsPolicy,
  computeCoverage,
  coverageState,
  normalizeSerial,
  maskSerial,
  unitTotalMonths,
  recomputeUnitWindow,
  effectiveClaimStage,
  stageToLegacyStatus,
  type UnitRow,
} from '../worker/lib/deviceOps';

// ---------------------------------------------------------------- addMonths

test('addMonths: plain 12 months', () => {
  assert.equal(addMonths('2026-03-15T10:00:00.000Z', 12), '2027-03-15T10:00:00.000Z');
});

test('addMonths: Jan 31 + 1 month clamps to Feb 28 (non-leap)', () => {
  assert.equal(addMonths('2023-01-31T00:00:00.000Z', 1), '2023-02-28T00:00:00.000Z');
});

test('addMonths: Jan 31 + 1 month clamps to Feb 29 (leap year)', () => {
  assert.equal(addMonths('2024-01-31T00:00:00.000Z', 1), '2024-02-29T00:00:00.000Z');
});

test('addMonths: Feb 29 + 12 months clamps to Feb 28', () => {
  assert.equal(addMonths('2024-02-29T12:30:00.000Z', 12), '2025-02-28T12:30:00.000Z');
});

test('addMonths: Aug 31 + 1 month clamps to Sep 30', () => {
  assert.equal(addMonths('2026-08-31T23:59:59.000Z', 1), '2026-09-30T23:59:59.000Z');
});

test('addMonths: Nov 30 + 24 months keeps day and time', () => {
  assert.equal(addMonths('2026-11-30T05:00:00.000Z', 24), '2028-11-30T05:00:00.000Z');
});

// ------------------------------------------------------------- ops policy

test('serialization is explicit config only — empty/foreign policies are inert', () => {
  assert.deepEqual(parseOpsPolicy('{}'), { serialized: false, base_months: null });
  assert.deepEqual(parseOpsPolicy(null), { serialized: false, base_months: null });
  assert.deepEqual(parseOpsPolicy('not json'), { serialized: false, base_months: null });
  // "serialized" must be literally true, not truthy
  assert.equal(parseOpsPolicy('{"serialized":"yes"}').serialized, false);
  assert.equal(parseOpsPolicy('{"serialized":1}').serialized, false);
});

test('ops_policy warranty months: canonical and alias keys, bounds enforced', () => {
  assert.deepEqual(parseOpsPolicy('{"serialized":true,"warranty_base_months":12}'), { serialized: true, base_months: 12 });
  assert.deepEqual(parseOpsPolicy('{"serialized":true,"warranty_months":12}'), { serialized: true, base_months: 12 });
  assert.equal(parseOpsPolicy('{"serialized":true,"warranty_base_months":0}').base_months, null);
  assert.equal(parseOpsPolicy('{"serialized":true,"warranty_base_months":999}').base_months, null);
  assert.equal(parseOpsPolicy('{"serialized":true,"warranty_base_months":12.5}').base_months, null);
});

// -------------------------------------------------------------- coverage

const DELIVERED = '2026-02-10T09:00:00.000Z';

test('printer: base 12 months from delivered_at', () => {
  const cov = computeCoverage(12, null, DELIVERED);
  assert.equal(cov.total_months, 12);
  assert.equal(cov.ext_months, 0);
  assert.equal(cov.end_at, '2027-02-10T09:00:00.000Z');
});

test('base 12 + purchased +12 extension = 24 total months', () => {
  const cov = computeCoverage(12, { plan_id: 'wp1', duration_months: 12, duration_kind: 'extension' }, DELIVERED);
  assert.equal(cov.total_months, 24);
  assert.equal(cov.ext_months, 12);
  assert.equal(cov.end_at, '2028-02-10T09:00:00.000Z');
});

test('base 12 + purchased +24 extension = 36 total months', () => {
  const cov = computeCoverage(12, { plan_id: 'wp2', duration_months: 24, duration_kind: 'extension' }, DELIVERED);
  assert.equal(cov.total_months, 36);
  assert.equal(cov.end_at, '2029-02-10T09:00:00.000Z');
});

test('purchased "total"-kind plan defines total coverage explicitly', () => {
  const cov = computeCoverage(12, { plan_id: 'wp3', duration_months: 24, duration_kind: 'total' }, DELIVERED);
  assert.equal(cov.total_months, 24);
  assert.equal(cov.ext_months, 12);
  assert.equal(cov.end_at, '2028-02-10T09:00:00.000Z');
});

test('AMS with no configured duration → honest needs_config (never assumed)', () => {
  const cov = computeCoverage(null, null, DELIVERED);
  assert.equal(cov.total_months, null);
  assert.equal(cov.end_at, null);
  assert.equal(coverageState(DELIVERED, cov.end_at).state, 'needs_config');
});

test('extension without a configured base cannot invent a total', () => {
  const cov = computeCoverage(null, { duration_months: 12, duration_kind: 'extension' }, DELIVERED);
  assert.equal(cov.total_months, null);
  assert.equal(cov.end_at, null);
});

test('leap delivery: Feb 29 + 12 base months ends Feb 28 next year', () => {
  const cov = computeCoverage(12, null, '2024-02-29T00:00:00.000Z');
  assert.equal(cov.end_at, '2025-02-28T00:00:00.000Z');
});

// --------------------------------------------------------- coverage state

test('coverageState: undelivered / active / expired', () => {
  const now = Date.parse('2026-08-28T00:00:00.000Z');
  assert.equal(coverageState(null, null, now).state, 'not_delivered');
  const active = coverageState('2026-08-01T00:00:00.000Z', '2027-08-01T00:00:00.000Z', now);
  assert.equal(active.state, 'active');
  assert.equal(active.remaining_days, Math.ceil((Date.parse('2027-08-01T00:00:00.000Z') - now) / 86_400_000));
  const expired = coverageState('2024-08-01T00:00:00.000Z', '2025-08-01T00:00:00.000Z', now);
  assert.equal(expired.state, 'expired');
  assert.equal(expired.remaining_days, 0);
});

// ---------------------------------------------------------------- serials

test('normalizeSerial: upper-case, spaces/dashes removed; raw stays untouched by design', () => {
  assert.equal(normalizeSerial('  ab-12 cd 34 '), 'AB12CD34');
  assert.equal(normalizeSerial('01P00A123456789'), '01P00A123456789');
});

test('maskSerial shows only the last 4 characters', () => {
  assert.equal(maskSerial('01P00A123456789'), '****6789');
  assert.equal(maskSerial('abc'), '****');
});

// ------------------------------------------------------ delivery correction

const unit = (over: Partial<UnitRow> = {}): UnitRow => ({
  id: 'unit_1',
  order_id: 'ORD-1',
  order_item_id: 'oi_1',
  product_id: 'prd_1',
  owner_user_id: 'usr_1',
  unit_index: 1,
  delivered_at: DELIVERED,
  warranty_base_months: 12,
  warranty_ext_months: 0,
  warranty_start_at: DELIVERED,
  warranty_end_at: '2027-02-10T09:00:00.000Z',
  policy_version: JSON.stringify({ v: 1, base: 12, ext: 0, total: 12 }),
  replaced_by_unit_id: null,
  replacement_of_unit_id: null,
  ...over,
});

test('delivery correction recomputes ONLY that unit window from stored months', () => {
  const win = recomputeUnitWindow(unit(), '2026-03-01T00:00:00.000Z');
  assert.equal(win.start_at, '2026-03-01T00:00:00.000Z');
  assert.equal(win.end_at, '2027-03-01T00:00:00.000Z');
});

test('delivery correction with unconfigured duration keeps honest null end', () => {
  const win = recomputeUnitWindow(
    unit({ warranty_base_months: null, warranty_end_at: null, policy_version: JSON.stringify({ v: 1, base: null, ext: 0, total: null }) }),
    '2026-03-01T00:00:00.000Z'
  );
  assert.equal(win.end_at, null);
});

test('replacement unit carrying the original end keeps it on delivery correction', () => {
  const win = recomputeUnitWindow(
    unit({ policy_version: JSON.stringify({ v: 1, carried: 'original_end', total: 12 }), warranty_end_at: '2027-02-10T09:00:00.000Z' }),
    '2026-12-01T00:00:00.000Z'
  );
  assert.equal(win.end_at, '2027-02-10T09:00:00.000Z');
  assert.equal(win.start_at, '2026-12-01T00:00:00.000Z');
});

test('unitTotalMonths falls back to base+ext columns when policy_version is legacy', () => {
  assert.equal(unitTotalMonths({ warranty_base_months: 12, warranty_ext_months: 12, policy_version: '' }), 24);
  assert.equal(unitTotalMonths({ warranty_base_months: null, warranty_ext_months: 12, policy_version: '' }), null);
  assert.equal(unitTotalMonths({ warranty_base_months: 12, warranty_ext_months: 0, policy_version: JSON.stringify({ total: 36 }) }), 36);
});

// ------------------------------------------------------------ claim stages

test('legacy status maps into the new stage model', () => {
  assert.equal(effectiveClaimStage(null, 'submitted'), 'received');
  assert.equal(effectiveClaimStage(null, 'in_review'), 'diagnosing');
  assert.equal(effectiveClaimStage(null, 'approved'), 'approved');
  assert.equal(effectiveClaimStage(null, 'rejected'), 'rejected');
  assert.equal(effectiveClaimStage('repairing', 'approved'), 'repairing');
});

test('stage → legacy status respects the 0001 CHECK constraint values', () => {
  assert.equal(stageToLegacyStatus('received'), 'submitted');
  assert.equal(stageToLegacyStatus('diagnosing'), 'in_review');
  assert.equal(stageToLegacyStatus('approved'), 'approved');
  assert.equal(stageToLegacyStatus('repairing'), 'approved');
  assert.equal(stageToLegacyStatus('replaced'), 'approved');
  assert.equal(stageToLegacyStatus('resolved'), 'approved');
  assert.equal(stageToLegacyStatus('rejected'), 'rejected');
});
