/**
 * A MERCHANT COUPON'S WINDOW (review of the merchant page, 2026-09-28).
 *
 * The server stored `starts_at`/`ends_at` and the Command Center counted
 * coupons «ending soon» from them, but the coupon form had no field for
 * either — no merchant coupon ever had an end. The form now speaks in days
 * (src/components/merchant/dashboard/couponDates.ts), and the route refuses a
 * window that ends before it starts (COUPON_DATES_INVALID), judging one moved
 * end against the other as stored.
 *
 * Run: node --import tsx --test tests/couponDates.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, asD1, stubApp, patch, post, json, row, type StubUser } from './fixtures/app';
import { merchantRoutes } from '../worker/routes/merchant';
import { couponPhase, dayToIso, isoToDay, windowProblem } from '../src/components/merchant/dashboard/couponDates';

// ------------------------------------------------------------ the days

test('a start is the first instant of its day, an end the last — in local time — and back again', () => {
  const start = dayToIso('2026-10-01', 'start')!;
  const end = dayToIso('2026-10-01', 'end')!;
  assert.ok(Date.parse(end) > Date.parse(start));
  assert.equal(Date.parse(end) - Date.parse(start), 86_399_000);
  assert.equal(isoToDay(start), '2026-10-01');
  assert.equal(isoToDay(end), '2026-10-01');
  assert.equal(dayToIso('', 'start'), null);
  assert.equal(dayToIso('01/10/2026', 'end'), null);
  assert.equal(isoToDay(null), '');
  assert.equal(isoToDay('not a date'), '');
});

test('a window may be one day; an end before the start is the one problem', () => {
  assert.equal(windowProblem('2026-10-01', '2026-10-01'), null);
  assert.equal(windowProblem('2026-10-02', '2026-10-01'), 'end_before_start');
  assert.equal(windowProblem('', '2026-10-01'), null);
  assert.equal(windowProblem('2026-10-01', ''), null);
});

test('the phase: ended, scheduled, ending (soon within seven days), or open', () => {
  const now = Date.parse('2026-10-10T12:00:00.000Z');
  assert.deepEqual(couponPhase({ starts_at: null, ends_at: '2026-10-09T00:00:00.000Z' }, now), { phase: 'ended', at: '2026-10-09T00:00:00.000Z' });
  assert.deepEqual(couponPhase({ starts_at: '2026-10-11T00:00:00.000Z', ends_at: null }, now), { phase: 'scheduled', at: '2026-10-11T00:00:00.000Z' });
  assert.deepEqual(couponPhase({ starts_at: null, ends_at: '2026-10-15T00:00:00.000Z' }, now), { phase: 'ends', at: '2026-10-15T00:00:00.000Z', soon: true });
  assert.deepEqual(couponPhase({ starts_at: null, ends_at: '2026-11-15T00:00:00.000Z' }, now), { phase: 'ends', at: '2026-11-15T00:00:00.000Z', soon: false });
  assert.deepEqual(couponPhase({ starts_at: null, ends_at: null }, now), { phase: 'open' });
});

// ------------------------------------------------------------ the route

const OWNER: StubUser = { id: 'owner', role: 'merchant', email: 'owner@x.co' };
function seed() {
  const raw = freshDb();
  raw.exec(`
    INSERT INTO users (id,name,email,password_hash,role) VALUES ('owner','Ali','owner@x.co','h','merchant');
    INSERT INTO memberships (id,user_id,plan_id,tier,state,duration_months,starts_at,expires_at) VALUES
      ('mem1','owner','plus_12mo','plus','active',12,'2026-01-01T00:00:00.000Z','2099-01-01T00:00:00.000Z');
    INSERT INTO community_merchants (id,user_id,name) VALUES ('m1','owner','Ali 3D');
    INSERT INTO merchant_stores (id,merchant_id,user_id,slug,name,status) VALUES ('s1','m1','owner','ali3d','Ali 3D','active');
  `);
  return raw;
}
const app = (raw: ReturnType<typeof freshDb>) => stubApp(asD1(raw), OWNER, (a) => a.route('/api/merchant', merchantRoutes));

test('a coupon is created with its window; a window that ends before it starts is refused and not stored', async () => {
  const raw = seed();
  const ok = await post(app(raw), '/api/merchant/coupons', {
    code: 'AUTUMN', kind: 'percent', value: 10,
    starts_at: '2026-10-01T00:00:00.000Z', ends_at: '2026-10-31T23:59:59.000Z',
  });
  assert.equal(ok.status, 201, JSON.stringify(await json(ok.clone())));
  const coupon = (await json(ok)).coupon;
  assert.deepEqual([coupon.starts_at, coupon.ends_at], ['2026-10-01T00:00:00.000Z', '2026-10-31T23:59:59.000Z']);

  const bad = await post(app(raw), '/api/merchant/coupons', {
    code: 'BACKWARDS', kind: 'percent', value: 10,
    starts_at: '2026-10-31T00:00:00.000Z', ends_at: '2026-10-01T00:00:00.000Z',
  });
  assert.equal(bad.status, 400);
  assert.equal((await json(bad)).code, 'COUPON_DATES_INVALID');
  assert.equal(row(raw, "SELECT id FROM merchant_coupons WHERE code = 'BACKWARDS'"), undefined);

  const garbage = await post(app(raw), '/api/merchant/coupons', { code: 'GARBAGE', kind: 'percent', value: 10, ends_at: 'someday' });
  assert.deepEqual([garbage.status, (await json(garbage)).code], [400, 'COUPON_DATES_INVALID']);
});

test('moving one end is judged against the other as stored; an empty day clears that end', async () => {
  const raw = seed();
  const id = (await json(await post(app(raw), '/api/merchant/coupons', {
    code: 'AUTUMN', kind: 'percent', value: 10, starts_at: '2026-10-10T00:00:00.000Z', ends_at: '2026-10-31T23:59:59.000Z',
  }))).coupon.id as string;

  const before = await patch(app(raw), `/api/merchant/coupons/${id}`, { ends_at: '2026-10-05T00:00:00.000Z' });
  assert.deepEqual([before.status, (await json(before)).code], [400, 'COUPON_DATES_INVALID']);
  assert.equal(row<{ ends_at: string }>(raw, 'SELECT ends_at FROM merchant_coupons WHERE id = ?', id)!.ends_at, '2026-10-31T23:59:59.000Z');

  assert.equal((await patch(app(raw), `/api/merchant/coupons/${id}`, { ends_at: '2026-11-30T23:59:59.000Z' })).status, 200);
  assert.equal((await patch(app(raw), `/api/merchant/coupons/${id}`, { starts_at: '', ends_at: '' })).status, 200);
  assert.deepEqual(row(raw, 'SELECT starts_at, ends_at FROM merchant_coupons WHERE id = ?', id), { starts_at: null, ends_at: null });
  assert.equal((await patch(app(raw), '/api/merchant/coupons/nope', { ends_at: '2026-11-30T23:59:59.000Z' })).status, 404);
});
