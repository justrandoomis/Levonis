/**
 * THE FX CHAIN, EXACT (FX programme plan §2, §3; packages/pricing/src/fxChain.ts).
 *
 * E1 is fed the effective IQD rates USD = U, EUR = E×U and CNY = C×U. These
 * pin that the chain is exact rationals (no float anywhere), that the cross
 * rate rounds UP at the tenth decimal, that the IQD convenience round trip is
 * exact (§12), and the guard arithmetic (§30, §31): exactly the threshold is
 * not "more", and a dead band of 0 never swallows a move.
 *
 * Run: node --import tsx --test tests/fxChain.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  changePctText,
  changePpm,
  composeIqdRates,
  crossRateCnyUsd,
  currentUsdCost,
  iqdToCanonicalUsd,
  movesLessThanPct,
  movesMoreThanPct,
  sumOfMoves,
  ratioExceedsPct,
  usdIqdCandidate,
  withinBounds,
} from '../packages/pricing/src/fxChain';
import { ceilToPlaces, floorToPlaces, procurementExact, procurementExactText, quotientProcurementExact, mulProcurementExact, ceilProcurementExact } from '../packages/contracts/src/procurementCost';

test('EUR amount × E × U equals amount × (E×U) exactly', () => {
  const rates = composeIqdRates('1660.25', '1.1186', '0.1492023689');
  assert.equal(rates.USD, '1660.25');
  assert.equal(rates.EUR, '1857.15565');
  const amount = '999.99';
  const viaUsd = mulProcurementExact(mulProcurementExact(procurementExact(amount), procurementExact('1.1186')), procurementExact('1660.25'));
  const viaIqd = mulProcurementExact(procurementExact(amount), procurementExact(rates.EUR!));
  assert.equal(procurementExactText(viaUsd), procurementExactText(viaIqd));
});

test('CNY/USD = ceil10(1.1186 / 7.4972) = 0.1492023689 — rounded UP, so cost is never under-stated', () => {
  assert.equal(crossRateCnyUsd('1.1186', '7.4972'), '0.1492023689');
  const exact = quotientProcurementExact(procurementExact('1.1186'), procurementExact('7.4972'));
  const c = procurementExact(crossRateCnyUsd('1.1186', '7.4972'));
  assert.ok(c.num * exact.den >= exact.num * c.den, 'C ≥ the exact quotient');
  // A terminating quotient is not moved: 1.2 / 8 = 0.15.
  assert.equal(crossRateCnyUsd('1.2', '8'), '0.15');
});

test('composed rates are terminating decimals (procurementExactText never throws on them)', () => {
  for (const [u, e, c] of [['1660', '1.1186', crossRateCnyUsd('1.1186', '7.4972')], ['1500.0001', '0.9999', '0.1'], ['999', '1.6', '0.25']] as const) {
    const r = composeIqdRates(u, e, c);
    for (const v of Object.values(r)) assert.match(v!, /^[0-9]+(\.[0-9]+)?$/);
  }
  assert.deepEqual(composeIqdRates(null, '1.1', '0.1'), { USD: null, EUR: null, CNY: null }, 'no U: nothing is composed');
  assert.deepEqual(composeIqdRates('1660', null, '0.1'), { USD: '1660', EUR: null, CNY: '166' });
});

test('USD/IQD candidate = market sell + the signed adjustment (Q1: dinars per dollar)', () => {
  assert.equal(usdIqdCandidate('1660', '20'), '1680');
  assert.equal(usdIqdCandidate('1660.25', '-10.5'), '1649.75');
  assert.equal(usdIqdCandidate('1660', '0'), '1660');
});

test('current USD cost: USD as is, EUR × E, CNY × C; null when the rate is missing', () => {
  assert.equal(currentUsdCost({ amount: '100', currency: 'USD' }, null, null), '100');
  assert.equal(currentUsdCost({ amount: '1000', currency: 'EUR' }, '1.12', null), '1120');
  assert.equal(currentUsdCost({ amount: '1000', currency: 'CNY' }, null, '0.1492023689'), '149.2023689');
  assert.equal(currentUsdCost({ amount: '1000', currency: 'EUR' }, null, null), null);
});

test('IQD convenience → canonical USD: 1,000,000 at 1,660 → 602.409638; ceil(602.409638 × 1660) = 1,000,000', () => {
  const usd = iqdToCanonicalUsd(1_000_000, '1660');
  assert.equal(usd, '602.409638');
  assert.equal(ceilProcurementExact(mulProcurementExact(procurementExact(usd), procurementExact('1660'))), 1_000_000n);
});

test('property: for any whole I ≤ 1e10 and any U < 1e6 the round trip is exact', () => {
  let seed = 20261008;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 3000; i++) {
    const iqd = Math.floor(rnd() * 1e10);
    const whole = 1 + Math.floor(rnd() * 999_998);
    const frac = Math.floor(rnd() * 10_000);
    const u = frac ? `${whole}.${String(frac).padStart(4, '0').replace(/0+$/, '')}` : String(whole);
    const usd = iqdToCanonicalUsd(iqd, u);
    assert.equal(ceilProcurementExact(mulProcurementExact(procurementExact(usd), procurementExact(u))), BigInt(iqd), `${iqd} at ${u}`);
  }
});

test('floor and ceil to places: down and up, terminating, negatives toward −∞ and +∞', () => {
  const third = quotientProcurementExact(procurementExact('1'), procurementExact('3'));
  assert.equal(procurementExactText(floorToPlaces(third, 4)), '0.3333');
  assert.equal(procurementExactText(ceilToPlaces(third, 4)), '0.3334');
  const minus = quotientProcurementExact(procurementExact('-1', { signed: true }), procurementExact('3'));
  assert.equal(procurementExactText(floorToPlaces(minus, 2)), '-0.34');
  assert.equal(procurementExactText(ceilToPlaces(minus, 2)), '-0.33');
  assert.equal(procurementExactText(ceilToPlaces(procurementExact('2.5'), 0)), '3');
  assert.throws(() => quotientProcurementExact(procurementExact('1'), procurementExact('0')), /division by zero/);
});

test('the guards are exact: exactly 3% is not "more than 3%", 3.0001% is; a 0 dead band never swallows a move', () => {
  assert.equal(movesMoreThanPct('1709.8', '1660', '3'), false, '+3.00% exactly applies');
  assert.equal(movesMoreThanPct('1709.81', '1660', '3'), true);
  assert.equal(movesMoreThanPct('1610.2', '1660', '3'), false, '−3.00% exactly applies');
  assert.equal(movesMoreThanPct('1610.19', '1660', '3'), true);
  assert.equal(movesLessThanPct('1664.98', '1660', '0.5'), true, '0.3% is inside the 0.5% dead band');
  assert.equal(movesLessThanPct('1668.3', '1660', '0.5'), false, 'exactly 0.5% is not inside');
  assert.equal(movesLessThanPct('1660.0001', '1660', '0'), false);
  assert.equal(withinBounds('1000', '1000', '3000'), true);
  assert.equal(withinBounds('3000.0001', '1000', '3000'), false);
});

test('display figures: ppm floored, percent signed and rounded half away from zero; the 24-hour sum of moves', () => {
  assert.equal(changePpm('1660', '1720'), 36144);
  assert.equal(changePctText('1660', '1720'), '3.61');
  assert.equal(changePctText('1660', '1600'), '-3.61');
  assert.equal(changePctText('1660', '1660'), '0');
  const sum = sumOfMoves([{ before: '1660', after: '1875.8' }, { before: '1875.8', after: '1631.946' }]);
  assert.equal(ratioExceedsPct(sum, '15'), true);
  assert.equal(ratioExceedsPct(sumOfMoves([{ before: '100', after: '113' }]), '15'), false);
});
