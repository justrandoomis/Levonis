/**
 * OFFER TIMES ARE BAGHDAD TIME (docs/ux/PRODUCT-DISCOUNT.md D11, F4; src/lib/offerTime.ts).
 *
 * A stored instant is shown as a Baghdad clock shows it, and a typed value is sent as Baghdad time,
 * whatever the device's zone — round trip through the server's own reader (`normalizeUtc`), across
 * midnight and the date line. The special-offers tab no longer prints UTC as if it were local.
 *
 * Run: npx tsx --test tests/offerTime.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { baghdadInputToNaive, baghdadInputToZoned, isoToBaghdadInput } from '../src/lib/offerTime';
import { normalizeUtc } from '../worker/lib/offers';

test('a stored instant reads as Baghdad shows it (UTC+3), across midnight and the year', () => {
  assert.equal(isoToBaghdadInput('2026-10-20T09:00:00.000Z'), '2026-10-20T12:00');
  assert.equal(isoToBaghdadInput('2026-10-20T22:30:00.000Z'), '2026-10-21T01:30', 'past Baghdad midnight: the next day');
  assert.equal(isoToBaghdadInput('2026-12-31T21:00:00.000Z'), '2027-01-01T00:00', 'the new year arrives in Baghdad first');
  assert.equal(isoToBaghdadInput(null), '');
  assert.equal(isoToBaghdadInput('not a date'), '');
});

test('a typed value is Baghdad time: naive for the server, which reads it as +03:00 — a round trip', () => {
  for (const local of ['2026-10-20T12:00', '2026-10-21T00:00', '2027-01-01T00:00', '2026-02-28T23:59']) {
    const naive = baghdadInputToNaive(local)!;
    assert.match(naive, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/);
    const stored = normalizeUtc(naive)!;
    assert.equal(isoToBaghdadInput(stored), local, `${local} → ${stored} → back`);
    assert.equal(normalizeUtc(baghdadInputToZoned(local)), stored, 'the zoned form is the same instant');
  }
  assert.equal(normalizeUtc(baghdadInputToNaive('2026-10-20T12:00')), '2026-10-20T09:00:00.000Z');
  // The date line: an owner whose device is in Auckland or Honolulu still types Baghdad time.
  const before = process.env.TZ;
  for (const tz of ['Pacific/Auckland', 'Pacific/Honolulu', 'UTC']) {
    process.env.TZ = tz;
    assert.equal(normalizeUtc(baghdadInputToNaive('2026-10-20T12:00')), '2026-10-20T09:00:00.000Z', tz);
    assert.equal(isoToBaghdadInput('2026-10-20T09:00:00.000Z'), '2026-10-20T12:00', tz);
  }
  if (before === undefined) delete process.env.TZ;
  else process.env.TZ = before;
  for (const bad of ['', '2026-13-01T00:00', '2026-10-20 12:00', '2026-10-20T25:00', 'tomorrow']) assert.equal(baghdadInputToNaive(bad), null, bad);
});

test('the special-offers tab reads and writes through Baghdad, never the browser’s zone', () => {
  const src = readFileSync('src/components/adminOffers/AdminOffers.tsx', 'utf8');
  assert.doesNotMatch(src, /iso\.slice\(0, 16\)/, 'a stored UTC instant is no longer printed as local');
  assert.doesNotMatch(src, /new Date\(local\)\.toISOString\(\)/, 'a typed value no longer goes through the device zone');
  assert.doesNotMatch(src, /\(o\.(?:starts|ends)_at \?\? '—'\)\.slice\(0, 10\)/, 'the list prints the Baghdad date, not the UTC one');
  assert.match(src, /isoToBaghdadInput\(o\.ends_at\)\.slice\(0, 10\)/);
  assert.match(src, /isoToBaghdadInput/);
  assert.match(src, /baghdadInputToZoned/);
});
