/**
 * TWO REPORTS ABOUT THE COMPARISON PAGE, from «6».
 *
 *   «في المحاورة الحاسمة بالإضافة إلى الشريط اجعل هنالك رقما يكتب — مثلا أقصى
 *    معدل تدفق — يكتب مع الشريط أمامه رقم وليس فقط شريط.»
 *
 *   «كما أن عند الضغط على المقارنة فإنه يظهر فقط الذي شاهدته مؤخرا أريد أن
 *    يكون زر لاضافه الطابعه.»
 *
 * THE FIRST IS ABOUT WHICH NUMBER. The chart's `series` is a 0..1 ratio
 * against the best answer on that axis; printing it would put «78%» on screen,
 * a number that answers nothing a customer asked. The figure they want is the
 * machine's own — «32 mm³/s» — and it already exists, typed and with its unit,
 * in the row the server sent for that field. So the chart reads it from there,
 * which also means the chart and the table below it print the same string and
 * cannot drift.
 *
 * THE SECOND IS ABOUT A DEAD END. `/api/compare/candidates` required `for`, so
 * with nothing placed the page could only offer the last product this browser
 * happened to look at. A first visit, cleared storage, or simply wanting a
 * machine unlike the one you were reading had no way in at all. `for` is
 * optional now and the empty state has a button.
 *
 * Run: npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// ------------------------------------------- the number beside the bar

test('the chart prints the typed figure, never the normalised ratio', () => {
  const chart = read('src/components/compare/SpecChart.tsx');
  // The figure comes from the ROW the server sent, by field_id.
  assert.match(chart, /const rows = useMemo\(\(\) => rowIndex\(result\), \[result\]\);/);
  assert.match(chart, /const cell = rows\.get\(axis\.field_id\)\?\.values\[p\];/);
  assert.match(chart, /const figure = cell && !cell\.missing && cell\.text \? cell\.text : '—';/);
  // The percentage is still computed — it is the BAR'S LENGTH — but it must
  // not be rendered as text anywhere.
  assert.match(chart, /inlineSize: `\$\{Math\.max\(percent, 2\)\}%`/);
  assert.ok(!/\{percent\}%|\$\{percent\}%`?\s*<\/span>/.test(chart), 'the ratio is being printed as a figure');
  // Even the accessible name is the real value now: «78%» is no more useful
  // read aloud than it is on screen.
  assert.match(chart, /aria-label=\{`\$\{columnName\(product, l\)\} — \$\{tri\(axis\.label, l\)\}: \$\{figure\}`\}/);
});

test('a missing answer is an em dash, never a zero', () => {
  // `missing: true` is "nobody wrote this down". A 0 printed there reads as a
  // MEASURED zero, which on «أقصى معدل تدفق» is a very different claim about
  // the machine.
  const chart = read('src/components/compare/SpecChart.tsx');
  assert.match(chart, /!cell\.missing/);
  assert.ok(chart.includes("'—'"), 'there is no em dash for the unknown case');
});

test('the figure is LTR and column-aligned, whatever the page direction is', () => {
  const chart = read('src/components/compare/SpecChart.tsx');
  // Digits plus a Latin unit inside an Arabic page: without dir="ltr" the
  // browser reorders the unit around the number.
  assert.match(chart, /dir="ltr"[\s\S]{0,160}tabular-nums/);
  assert.match(chart, /minInlineSize: '4\.5rem'/, 'the figures will jitter without a floor');
  // `inline-size`, not `width` — the bar has to grow from the right edge in RTL.
  assert.ok(!/style=\{\{\s*width: `\$\{Math\.max\(percent/.test(chart));
});

test('the row index reads the server’s own rows rather than re-deriving them', () => {
  const lib = read('src/lib/compare.ts');
  assert.match(lib, /export function rowIndex\(result: CompareResult\): Map<string, CompareRow> \{/);
  assert.match(lib, /for \(const group of result\.groups\) for \(const row of group\.rows\) out\.set\(row\.field_id, row\);/);
});

// ----------------------------------------------- the add-a-product way in

test('the candidates endpoint no longer demands an anchor', () => {
  const route = read('worker/routes/compare.ts');
  assert.match(route, /const anchorId = str\(c\.req\.query\('for'\), 'for', \{ max: 60, required: false \}\);/);
  assert.match(route, /if \(!anchorId\) \{[\s\S]{0,400}browseCompareCandidates\(/);
  assert.match(route, /for: null,/, 'the anchor-free answer must say so rather than inventing a card');
});

test('the anchor-free list obeys the one rule both lists share', () => {
  const route = read('worker/routes/compare.ts');
  const fn = route.slice(
    route.indexOf('export async function browseCompareCandidates'),
    route.indexOf('compareRoutes.get(\'/candidates\'')
  );
  assert.ok(fn.length > 0, 'browseCompareCandidates moved');
  // A tap that ends in COMPARE_NO_SPECS is a tap that teaches people not to
  // tap. Both the SQL predicate and the second look are required.
  assert.match(fn, /spec_fields <> '\{\}' AND spec_fields <> ''/);
  assert.match(fn, /hasAnySpec\(candidate\.specs\)/);
  // Through likePattern, never a hand-built pattern: D1 refuses a LIKE pattern
  // over 50 BYTES and Arabic is two bytes a letter.
  assert.match(fn, /const pattern = likePattern\(q\);/);
  // Comments stripped: the note above that line NAMES the concatenated form to
  // forbid it, and a grep over prose would fail on the warning itself.
  const code = fn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/'%' \+ q/.test(code), 'a concatenated LIKE pattern is a 500 for Arabic search');
  assert.match(fn, /ORDER BY created_at DESC/, 'with no anchor there is nothing to rank by but recency');
});

test('the client sends no `for` when there is none', () => {
  const lib = read('src/lib/compare.ts');
  assert.match(lib, /export function fetchCandidates\(\s*anchorId: string \| null,/);
  assert.match(lib, /if \(anchorId\) params\.set\('for', anchorId\);/);
  // `for=` with an empty value is NOT the same request — it would reach the
  // anchor lookup and 404.
  assert.ok(!/\?for=\$\{encodeURIComponent\(anchorId\)\}/.test(lib));
  assert.match(lib, /for: CompareProductCard \| null;/, 'the response type still promises a card');
});

test('the picker opens without an anchor', () => {
  const picker = read('src/components/compare/ProductPicker.tsx');
  // The guard used to be `!open || !anchorId`, which is why the sheet could
  // only ever be opened from a product page.
  assert.ok(!/if \(!open \|\| !anchorId\) return;/.test(picker), 'the null-anchor guard is back');
  assert.match(picker, /if \(!open\) return;/);
  assert.match(picker, /fetchCandidates\(anchorId, q, \{ signal: controller\.signal/);
});

test('the empty state has a real add button, and keeps the recent rail under it', () => {
  const page = read('src/pages/Compare.tsx');
  assert.match(page, /onClick=\{\(\) => setPicking\(-1\)\}[\s\S]{0,260}\{s\.addProduct\}/);
  // The header control is available with nothing placed too — its gate used to
  // be `ids.length > 0`, which is exactly the screen that had no way in.
  assert.match(page, /\{ids\.length < MAX_COMPARE_IDS \? \(/);
  assert.ok(!/\{ids\.length > 0 && ids\.length < MAX_COMPARE_IDS \? \(/.test(page));
  // The rail the owner described is still there: it is the fastest way in for
  // someone who just came off a product page, it was simply the ONLY one.
  assert.match(page, /\{s\.emptyRecent\}/);
  assert.match(page, /cards=\{seedCards\}/);
});

test('a null anchor card cannot reach the grid', () => {
  // `for` is nullable now; the seeded call always has one, but spreading a
  // null into the card list would crash the grid on the one screen this
  // change exists to fix.
  assert.match(
    read('src/pages/Compare.tsx'),
    /\[res\.for, \.\.\.res\.products\]\.filter\(Boolean\)/
  );
});
