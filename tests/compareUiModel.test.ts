/**
 * THE COMPARE PAGE, UPGRADED (catalog discovery S7-client;
 * docs/ux/CATALOG_DISCOVERY.md §10.1–10.4, mockup 8).
 *
 * Over the real server comparison of the live X2D / H2S / P2S (worker routes on
 * the seeded live catalogue), this pins what the page draws:
 *   - «الفروقات فقط» is ON for three or more columns, hides every identical row
 *     and says how many; a present-versus-missing row is a difference;
 *   - best in row is the SERVER's `winners` — the table marks exactly those,
 *     with a check and the word, never by colour alone, and never marks a loss;
 *   - bars: value/max (higher) or min/value (lower), none for a missing value,
 *     none for a year;
 *   - the lenses (?lens= round-trip), the rows each lens tints, the summary's
 *     reason copy from the finder's vocabulary;
 *   - remove and reorder go through the URL; the tray is written back.
 *
 * Run: node --import tsx --test tests/compareUiModel.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ROOT } from './fixtures/d1';
import { asD1, freshDb, get, json, stubApp } from './fixtures/app';
import { P, seedLiveCatalog } from './fixtures/liveCatalog';
import { compareRoutes } from '../worker/routes/compare';
import { LanguageProvider } from '../src/LanguageContext';
import {
  LENS_FIELDS,
  LENS_IDS,
  barRatio,
  diffOnlyByDefault,
  identicalRowCount,
  lensById,
  litres,
  moveColumn,
  readLens,
  rowDiffers,
  rowHint,
  specGroups,
  type CompareProductCard,
  type CompareResult,
  type CompareRow,
} from '../src/lib/compare';
import SpecTable from '../src/components/compare/SpecTable';
import BestForSummary from '../src/components/compare/BestForSummary';
import { stripNames } from '../src/components/compare/StickyColumns';
import { lensStrings } from '../src/components/compare/lensStrings';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

async function liveComparison(ids: string[]): Promise<{ products: CompareProductCard[]; comparison: CompareResult }> {
  const raw = freshDb();
  seedLiveCatalog(raw);
  const app = stubApp(asD1(raw), null, (a) => a.route('/api/compare', compareRoutes));
  const body = await json(await get(app, `/api/compare?ids=${ids.join(',')}`));
  return { products: body.products, comparison: body.comparison };
}

const within = (el: React.ReactElement) =>
  renderToStaticMarkup(createElement(LanguageProvider, { children: createElement(MemoryRouter, null, el) }));

const row = (over: Partial<CompareRow>): CompareRow => ({
  field_id: 'f',
  label: { ar: 'x', en: 'x', ckb: 'x' },
  unit: '',
  parse: 'number',
  better: 'higher',
  values: [],
  winners: [],
  decisive: true,
  weight: 1,
  ...over,
});
const v = (num: number | null, text = String(num)) => ({ raw: text, num, text, missing: num === null });

test('«الفروقات فقط» starts ON from three columns and hides only identical rows', async () => {
  assert.equal(diffOnlyByDefault(2), false);
  assert.equal(diffOnlyByDefault(3), true);
  assert.equal(diffOnlyByDefault(4), true);
  const { products, comparison } = await liveComparison([P.X2D, P.H2S, P.P2S]);
  const hidden = identicalRowCount(comparison);
  const all = specGroups(comparison).reduce((n, g) => n + g.rows.length, 0);
  assert.ok(hidden > 0 && hidden < all, `${hidden} of ${all}`);
  const on = within(createElement(SpecTable, { products, result: comparison, diffOnly: true, onDiffOnly: () => {} }));
  const off = within(createElement(SpecTable, { products, result: comparison, diffOnly: false, onDiffOnly: () => {} }));
  const count = (html: string) => (html.match(/data-field="/g) ?? []).length;
  // The price row is always drawn (+1).
  assert.equal(count(off), all + 1);
  assert.equal(count(on), all - hidden + 1);
  assert.ok(on.includes(lensStrings('ar').hiddenRows(hidden, 3)), 'the footer says how many were hidden');
  assert.ok(on.includes('إظهار الكل'));
  assert.doesNotMatch(off, /أُخفيت/);
  // A present-versus-missing row is a difference, not an identical row.
  assert.equal(rowDiffers(row({ values: [v(50, '50 dB'), { raw: '', num: null, text: '', missing: true }] })), true);
});

test('BEST IN ROW is the server’s winners: a check and the word, nothing else marked', async () => {
  const { products, comparison } = await liveComparison([P.X2D, P.H2S, P.P2S]);
  const html = within(createElement(SpecTable, { products, result: comparison, diffOnly: false, onDiffOnly: () => {} }));
  for (const g of specGroups(comparison)) {
    for (const r of g.rows) {
      const start = html.indexOf(`data-field="${r.field_id}"`);
      const end = html.indexOf('data-field="', start + 10);
      const chunk = html.slice(start, end < 0 ? undefined : end);
      const marks = (chunk.match(/<span class="sr-only">الأفضل: <\/span>/g) ?? []).length;
      assert.equal(marks, r.winners.length, `${r.field_id}: ${marks} marks for ${r.winners.length} winners`);
    }
  }
  // Values never wear a series colour: no inline colour on any value.
  assert.doesNotMatch(html, /style="color:/);
  // A missing value reads «غير مذكور», never a dash.
  assert.match(html, /غير مذكور/);
});

test('BARS: value/max where higher is better, min/value where lower is, none for missing or a year', () => {
  const hi = row({ values: [v(1000), v(600), v(500)], better: 'higher' });
  assert.deepEqual([0, 1, 2].map((i) => barRatio(hi, i)), [1, 0.6, 0.5]);
  const lo = row({ values: [v(0.04), v(0.08)], better: 'lower' });
  assert.deepEqual([0, 1].map((i) => barRatio(lo, i)), [1, 0.5]);
  const gap = row({ values: [v(50), { raw: '', num: null, text: '', missing: true }] });
  assert.equal(barRatio(gap, 1), null, 'a missing value draws no bar (never a zero-length loss)');
  assert.equal(barRatio(gap, 0), null, 'one reading is not a comparison');
  assert.equal(barRatio(row({ field_id: 'release_year', values: [v(2025), v(2026)] }), 1), null);
  assert.equal(barRatio(row({ better: 'none', values: [v(1), v(2)] }), 1), null);
  assert.equal(barRatio(row({ parse: 'text', values: [v(1), v(2)] }), 1), null);
  const vol = row({ parse: 'dimensions', unit: 'mm', values: [{ raw: '', num: 1, text: '', missing: false, axes: [340, 320, 340] }] });
  assert.equal(litres(vol, 0), 37);
  assert.equal(rowHint(row({ better: 'lower', values: [v(1), v(2)], winners: [0] })), 'lower');
  assert.equal(rowHint(row({ better: 'none', weight: 0 })), 'informational');
  assert.equal(rowHint(row({ values: [v(1), { raw: '', num: null, text: '', missing: true }] })), 'unscored');
});

test('LENSES: ?lens= round-trips, each lens tints real rows, the summary speaks the finder’s vocabulary', async () => {
  for (const id of LENS_IDS) assert.equal(readLens(new URLSearchParams(`ids=a,b&lens=${id}`)), id);
  assert.equal(readLens(new URLSearchParams('lens=bogus')), null);
  assert.equal(readLens(''), null);

  const { products, comparison } = await liveComparison([P.X2D, P.H2S, P.P2S]);
  assert.deepEqual(comparison.lenses!.map((l) => l.id), [...LENS_IDS]);
  assert.equal(products[lensById(comparison, 'business')!.winner!].product_id ?? products[lensById(comparison, 'business')!.winner!].id, P.H2S);
  const fields = new Set(specGroups(comparison).flatMap((g) => g.rows.map((r) => r.field_id)));
  for (const id of ['business', 'multicolor', 'precision'] as const) {
    assert.ok(LENS_FIELDS[id].some((f) => fields.has(f)), `${id} tints no row of a printer comparison`);
  }
  const tinted = within(createElement(SpecTable, { products, result: comparison, diffOnly: false, onDiffOnly: () => {}, lens: 'business' }));
  assert.match(tinted, /data-field="print_speed" data-lens-row="true"/);
  assert.doesNotMatch(tinted, /data-field="max_colors" data-lens-row/);

  const summary = within(createElement(BestForSummary, { lenses: comparison.lenses!, products, value: 'business', onChange: () => {} }));
  assert.equal((summary.match(/data-lens-summary=/g) ?? []).length, 5);
  assert.match(summary, /aria-pressed="true" data-lens-summary="business"/);
  assert.match(summary, /أعلى نقاط المقارنة لكل دينار/, 'the value lens reads its code, not a price string');
  assert.match(summary, /Bambu Lab H2S/);
});

test('a tie and missing data are said, not guessed', () => {
  const products = [
    { id: 'a', slug: 'a', name: { ar: 'A', en: 'A', ckb: 'A' }, image: null, price_iqd: 1, product_type: 'printer', section: null, brand_id: null, graded: false },
    { id: 'b', slug: 'b', name: { ar: 'B', en: 'B', ckb: 'B' }, image: null, price_iqd: 1, product_type: 'printer', section: null, brand_id: null, graded: false },
  ] as CompareProductCard[];
  const html = within(
    createElement(BestForSummary, {
      products,
      value: null,
      onChange: () => {},
      lenses: [
        { id: 'business', winner: null, state: 'tie', scores: [0.5, 0.49], reason: null },
        { id: 'beginners', winner: null, state: 'no_data', scores: [null, null], reason: null },
      ],
    })
  );
  assert.match(html, /متقاربة/);
  assert.match(html, /لا توجد بيانات كافية/);
});

test('REORDER and REMOVE: one place at a time, clamped, through the URL', () => {
  assert.deepEqual(moveColumn(['a', 'b', 'c'], 1, -1), ['b', 'a', 'c']);
  assert.deepEqual(moveColumn(['a', 'b', 'c'], 1, 1), ['a', 'c', 'b']);
  assert.deepEqual(moveColumn(['a', 'b', 'c'], 0, -1), ['a', 'b', 'c']);
  assert.deepEqual(moveColumn(['a', 'b', 'c'], 2, 1), ['a', 'b', 'c']);
  const page = read('src/pages/Compare.tsx');
  assert.match(page, /setIds\(moveColumn\(ids, index, delta\)\)/);
  assert.match(page, /onRemove=\{\(i\) => removeId\(ids\[i\]\)\}/);
  // The lens survives a column change; choosing a lens replaces, not pushes.
  assert.match(page, /if \(lens && value\) query\.set\('lens', lens\);/);
  assert.match(page, /setParams\(query, \{ replace: true \}\);/);
});

test('TWO-WAY TRAY SYNC: the URL wins on /compare and is written back by product', () => {
  const page = read('src/pages/Compare.tsx');
  assert.match(page, /compareTray\.replaceAll\(items, type\)/);
  assert.match(page, /const id = p\.product_id \?\? p\.id;/, 'a slot key is one product in the tray');
  assert.match(page, /const tray = compareTray\.getSnapshot\(\);/, 'a bare /compare opens the tray’s comparison');
});

test('the collapsed strip drops the brand every column shares', () => {
  assert.deepEqual(stripNames(['Bambu Lab X2D / X2D Combo', 'Bambu Lab H2S', 'Bambu Lab P2S']), ['X2D', 'H2S', 'P2S']);
  assert.deepEqual(stripNames(['Bambu Lab A1', 'Snapmaker U1 3D Printer']), ['Bambu Lab A1', 'Snapmaker U1 3D Printer']);
  assert.deepEqual(stripNames(['Bambu Lab', 'Bambu Lab X']), ['Bambu Lab', 'Bambu Lab X'], 'never empties a name');
});

test('dataviz rules: bars are status + neutral, text wears text tokens only', () => {
  const bars = read('src/components/compare/RowBars.tsx');
  assert.match(bars, /winner \? 'bg-success'/);
  assert.match(bars, /aria-hidden="true"/);
  assert.doesNotMatch(bars, /#[0-9a-fA-F]{3,8}\b/, 'no hard-coded hex');
  for (const f of ['SpecTable', 'StickyColumns', 'LensBar', 'BestForSummary', 'RowBars', 'lensStrings', 'grid']) {
    assert.doesNotMatch(read(`src/components/compare/${f}.tsx`.replace('.tsx', f === 'lensStrings' || f === 'grid' ? '.ts' : '.tsx')), /#[0-9a-fA-F]{6}\b|text-white|bg-black|zinc-/);
  }
});
