/**
 * THE ANALYTICS PAGE'S CHART ARITHMETIC (W3-B) — scales, ticks, the time
 * axis in both directions, deltas only between real figures, shares that add
 * to 100, the funnel, the ranges — and the page's source rules: no chart
 * library, one axis per chart, a table view for every chart, text never in a
 * series colour.
 *
 * Run: node --import tsx --test tests/merchantAnalyticsCharts.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SERIES,
  customRangeProblem,
  dailyTableRows,
  dayTickIndexes,
  funnelSteps,
  nearestIndex,
  niceTicks,
  periodDelta,
  rangeFor,
  seriesMax,
  shares,
  xPositions,
  yScale,
  baghdadToday,
} from '../src/components/merchant/analytics/chartMath';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

test('niceTicks: clean whole steps from 0 past the maximum; nothing to draw is one empty step, not a fake scale', () => {
  assert.deepEqual(niceTicks(7, 4), [0, 2, 4, 6, 8]);
  assert.deepEqual(niceTicks(100, 4), [0, 50, 100]);
  assert.deepEqual(niceTicks(1840, 3), [0, 1000, 2000]);
  assert.deepEqual(niceTicks(3, 4), [0, 1, 2, 3], 'counts never get a 0.5 step');
  assert.deepEqual(niceTicks(0), [0, 1]);
  assert.deepEqual(niceTicks(NaN), [0, 1]);
  for (const m of [1, 9, 13, 49, 999, 12345]) {
    const t = niceTicks(m, 4);
    assert.ok(t[t.length - 1] >= m, `${m}: the top tick covers the maximum`);
    assert.ok(t.length <= 7, `${m}: a handful of ticks`);
  }
});

test('xPositions: time runs in the reading direction — mirrored in RTL, same spacing', () => {
  const ltr = xPositions(3, 100, 5, false);
  const rtl = xPositions(3, 100, 5, true);
  assert.deepEqual(ltr.map(Math.round), [20, 50, 80]);
  assert.deepEqual(rtl.map(Math.round), [80, 50, 20]);
  assert.deepEqual(xPositions(0, 100, 5, false), []);
});

test('nearestIndex: the crosshair snaps to the day under the pointer, both directions, clamped', () => {
  assert.equal(nearestIndex(21, 3, 100, 5, false), 0);
  assert.equal(nearestIndex(60, 3, 100, 5, false), 1);
  assert.equal(nearestIndex(99, 3, 100, 5, false), 2);
  assert.equal(nearestIndex(99, 3, 100, 5, true), 0, 'in Arabic the right edge is the first day');
  assert.equal(nearestIndex(-50, 3, 100, 5, false), 0);
  assert.equal(nearestIndex(500, 3, 100, 5, false), 2);
  assert.equal(nearestIndex(10, 0, 100, 5, false), -1);
});

test('yScale: 0 on the baseline, the top tick on the plot top, never outside', () => {
  assert.equal(yScale(0, 10, 10, 150), 150);
  assert.equal(yScale(10, 10, 10, 150), 10);
  assert.equal(yScale(5, 10, 10, 150), 80);
  assert.equal(yScale(50, 10, 10, 150), 10);
  assert.equal(yScale(-1, 10, 10, 150), 150);
});

test('dayTickIndexes: first and last always, evenly between, at most the asked number', () => {
  assert.deepEqual(dayTickIndexes(30, 5), [0, 7, 15, 22, 29]);
  assert.deepEqual(dayTickIndexes(3, 5), [0, 1, 2]);
  assert.deepEqual(dayTickIndexes(0), []);
});

test('periodDelta: only between two real figures, never «from nothing»', () => {
  assert.deepEqual(periodDelta(150, 100), { percent: 50 });
  assert.deepEqual(periodDelta(2, 3), { percent: -33.3 });
  assert.equal(periodDelta(5, 0), null, 'a rise from 0 has no percent');
  assert.equal(periodDelta(5, undefined), null, 'no previous period: no delta');
  assert.equal(periodDelta(undefined, 5), null);
  assert.equal(periodDelta(null, null), null);
});

test('shares: whole percentages that add up to exactly 100; none of nothing', () => {
  assert.deepEqual(shares([1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(shares([900, 400, 480, 60]), [49, 22, 26, 3]);
  assert.equal(shares([900, 400, 480, 60]).reduce((a, b) => a + b, 0), 100);
  assert.deepEqual(shares([0, 0]), []);
  assert.deepEqual(shares([5, 0]), [100, 0]);
});

test('funnelSteps: each stage of the first and of the one before; nothing divided by 0', () => {
  const s = funnelSteps([
    { key: 'v', value: 200 },
    { key: 'p', value: 100 },
    { key: 'c', value: 0 },
    { key: 'o', value: 0 },
  ]);
  assert.deepEqual(s.map((x) => [x.ofFirst, x.ofPrevious]), [[100, null], [50, 50], [0, 0], [0, null]]);
  assert.deepEqual(funnelSteps([{ key: 'v', value: 0 }, { key: 'o', value: 0 }]).map((x) => x.ofFirst), [null, null]);
});

test('ranges: presets end today in Baghdad; a custom range is refused before the server refuses it', () => {
  assert.equal(baghdadToday(Date.parse('2026-09-24T22:30:00.000Z')), '2026-09-25', 'past 21:00 UTC it is tomorrow in Baghdad');
  assert.deepEqual(rangeFor('7', '2026-09-25'), { from: '2026-09-19', to: '2026-09-25' });
  assert.deepEqual(rangeFor('30', '2026-03-01'), { from: '2026-01-31', to: '2026-03-01' });
  const today = '2026-09-25';
  assert.equal(customRangeProblem('2026-09-01', '2026-09-10', today), null);
  assert.equal(customRangeProblem('2026-09-10', '2026-09-01', today), 'order');
  assert.equal(customRangeProblem('2026-09-01', '2026-09-30', today), 'future');
  assert.equal(customRangeProblem('2024-01-01', '2026-09-01', today), 'too_long');
  assert.equal(customRangeProblem('', '2026-09-01', today), 'missing');
});

test('table rows and maxima: the table is the chart\'s own numbers, every day', () => {
  const series = [{ day: 'a', orders: 1 }, { day: 'b', orders: 0 }];
  assert.deepEqual(dailyTableRows(series, (r) => r.orders), [{ day: 'a', value: 1 }, { day: 'b', value: 0 }]);
  assert.equal(seriesMax([3, NaN, 7, -1]), 7);
  assert.equal(seriesMax([]), 0);
});

test('the palette is the validated dark reference, in its fixed order', () => {
  assert.deepEqual([...SERIES], ['#3987e5', '#d95926', '#199e70', '#c98500']);
});

test('source rules: no chart library, one axis per chart, a table view for every chart, text in text tokens', () => {
  const charts = read('src/components/merchant/analytics/charts.tsx');
  const page = read('src/components/merchant/shell/sections/AnalyticsSection.tsx');
  for (const src of [charts, page]) {
    assert.doesNotMatch(src, /from ['"](recharts|chart\.js|d3|victory|@nivo|echarts|apexcharts|plotly)/, 'a chart library in the workspace');
    assert.doesNotMatch(src, /yAxisId|secondaryAxis|rightAxis/, 'a second axis');
    assert.doesNotMatch(src, /\.message\b/, 'raw server text');
  }
  // Every ChartCard carries its table twin.
  const cards = page.match(/<ChartCard\b/g)?.length ?? 0;
  assert.ok(cards >= 8, `${cards} chart cards`);
  assert.equal((page.match(/table=\{/g) ?? []).length, cards, 'a ChartCard without a table view');
  // Series colours go on marks (fill/stroke/background of a swatch), never on text classes.
  assert.doesNotMatch(charts, /className="[^"]*text-\[#/);
  assert.doesNotMatch(charts, /color:\s*(color|p\.color|SERIES)/, 'text coloured by its series');
  // Views and orders are two charts, not one.
  assert.equal((page.match(/<DailyChart\b/g) ?? []).length, 2);
});
