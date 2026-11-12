/**
 * THE COMPLETED ORDERS ON THE SCREEN (DECISIONS row 323) — the archive's
 * «الأحدث أولًا / الأقدم أولًا» switch, its one list in the server's order, the
 * finished row's «سُلّم …» / «أُلغي …» chip and the archive's header line.
 *
 *   THE WORDS     one typed ar/en/ckb table; the `ckb` slot is its own Sorani
 *                 (DECISIONS row 183): not the Arabic, a Sorani letter, no
 *                 Arabic-only letter, the same placeholders.
 *   THE CHOICE    remembered per browser and never able to throw: missing,
 *                 blocked or throwing storage reads as newest.
 *   THE LIST      the archive's rows exactly as the server sent them — the day
 *                 groups would scramble them — and the live board's untouched.
 *   THE ROW       a finished order says when it was finished and is never
 *                 «متأخر»; a live one still is, when late. The real components
 *                 are rendered with `renderToStaticMarkup`.
 *   THE BOARD     OrdersBoard.tsx sends `sort` from the archive only, re-reads
 *                 on a change, starts again from page one, keeps the switch
 *                 outside the three controls' row, and draws the header and the
 *                 list from the answer.
 *
 * Run: node --import tsx --test tests/orderArchiveUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ROOT } from './fixtures/d1';
import {
  ARCHIVE_SORTS,
  ARCHIVE_SORT_KEY,
  ARCHIVE_STRINGS,
  archiveRowsOf,
  doneText,
  isFinished,
  readArchiveSort,
  saveArchiveSort,
} from '../src/components/adminOrders/archiveSort';
import { DoneChip } from '../src/components/adminOrders/OrderBoardBadges';
import OrderBoardRow from '../src/components/adminOrders/OrderBoardRow';
import type { AdminOrderRow, AdminOrdersResponse } from '../src/lib/api';

/** Letters Sorani writes and Arabic does not, plus Sorani's own ی and ک (tests/financeDisplayStrings.test.ts). */
const SORANI_ONLY = /[ڕڵێۆەڤگچپژیک]/;
const ARABIC_ONLY = /[ةىيك]/;
const placeholders = (s: string) => [...s.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]).sort();

type Lang = 'ar' | 'en' | 'ckb';
const locIn = (lang: Lang) => (ar: string, en: string, ckb?: string) => (lang === 'en' ? en : lang === 'ckb' ? ckb ?? ar : ar);
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** The code of a file without its comments: a comment may quote what it explains. */
const code = (rel: string) =>
  read(rel)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();

// =========================================================================
// THE WORDS
// =========================================================================

test('every sentence has ar, en and its own Sorani — never the Arabic or the English, a Sorani letter, no Arabic-only one', () => {
  const entries = Object.entries(ARCHIVE_STRINGS);
  assert.equal(entries.length, 8);
  for (const [key, { ar, en, ckb }] of entries) {
    for (const [lang, s] of Object.entries({ ar, en, ckb })) assert.ok(s.trim().length > 0 && s === s.trim(), `${key}.${lang}`);
    assert.notEqual(ckb, ar, `${key}: the Sorani slot carries the Arabic (row 183)`);
    assert.notEqual(ckb, en, `${key}: the Sorani slot carries the English`);
    assert.match(ckb, SORANI_ONLY, `${key}: no Sorani letter — is it Arabic?`);
    assert.doesNotMatch(ckb, ARABIC_ONLY, `${key}: an Arabic-only letter in the Sorani`);
    assert.match(ar, /[؀-ۿ]/, `${key}: the Arabic is not Arabic`);
    assert.doesNotMatch(en, /[؀-ۿ]/, `${key}: Arabic script in the English`);
    assert.deepEqual(placeholders(ckb), placeholders(ar), `${key}: ckb placeholders`);
    assert.deepEqual(placeholders(en), placeholders(ar), `${key}: en placeholders`);
  }
  // The owner's words for the switch, and the chip's verbs around the server's day.
  assert.deepEqual([ARCHIVE_STRINGS.newest.ar, ARCHIVE_STRINGS.oldest.ar], ['الأحدث أولًا', 'الأقدم أولًا']);
  assert.deepEqual([ARCHIVE_STRINGS.newest.en, ARCHIVE_STRINGS.oldest.en], ['Newest first', 'Oldest first']);
  assert.deepEqual(placeholders(ARCHIVE_STRINGS.delivered.ar), ['day']);
  assert.deepEqual(placeholders(ARCHIVE_STRINGS.cancelled.ar), ['day']);
  assert.equal(ARCHIVE_STRINGS.delivered.ar, 'سُلّم {day}');
  assert.equal(ARCHIVE_STRINGS.cancelled.ar, 'أُلغي {day}');
  assert.deepEqual([...ARCHIVE_SORTS], ['newest', 'oldest'], 'the default first');
});

// =========================================================================
// THE CHOICE
// =========================================================================

function memoryStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

test('the choice: newest unless this browser chose oldest — and storage that is missing, blocked or throwing never throws', () => {
  assert.equal(ARCHIVE_SORT_KEY, 'levonis.admin.ordersArchiveSort');
  assert.equal(readArchiveSort(() => memoryStorage()), 'newest');
  assert.equal(readArchiveSort(() => memoryStorage({ [ARCHIVE_SORT_KEY]: 'oldest' })), 'oldest');
  for (const v of ['newest', 'OLDEST', 'sideways', '']) assert.equal(readArchiveSort(() => memoryStorage({ [ARCHIVE_SORT_KEY]: v })), 'newest', v);
  assert.equal(readArchiveSort(() => null), 'newest', 'no storage at all');
  assert.equal(readArchiveSort(() => { throw new Error('SecurityError: access denied'); }), 'newest', 'reading window.localStorage throws');
  assert.equal(readArchiveSort(() => ({ getItem: () => { throw new Error('denied'); } })), 'newest', 'getItem throws');
  // Node has no window: the default reads as newest instead of throwing.
  assert.equal(readArchiveSort(), 'newest');

  const s = memoryStorage();
  assert.equal(saveArchiveSort('oldest', () => s), true);
  assert.equal(s.m.get(ARCHIVE_SORT_KEY), 'oldest');
  assert.equal(readArchiveSort(() => s), 'oldest', 'remembered');
  assert.equal(saveArchiveSort('newest', () => s), true);
  assert.equal(readArchiveSort(() => s), 'newest');
  assert.equal(saveArchiveSort('oldest', () => ({ setItem: () => { throw new Error('QuotaExceededError'); } })), false, 'private mode: kept for the visit');
  assert.equal(saveArchiveSort('oldest', () => { throw new Error('denied'); }), false);
  assert.equal(saveArchiveSort('oldest', () => null), false);
  assert.equal(saveArchiveSort('oldest'), false, 'no window in Node');
});

// =========================================================================
// THE LIST
// =========================================================================

const answer = (scope: AdminOrdersResponse['scope'], orders: Array<Partial<AdminOrderRow>>) =>
  ({ scope, orders: orders as AdminOrderRow[] }) as Pick<AdminOrdersResponse, 'scope' | 'orders'>;

test('the archive is one list in exactly the server’s order — its day buckets would scramble it; the live board keeps its groups', () => {
  // Newest delivery first, as the server sends it. Their buckets (the day each
  // was due) run in another order entirely: grouped, «اليوم» would come first
  // and the two «لاحقًا»/«بلا موعد» rows would sink to the bottom.
  const rows = [
    { id: 'ORD-1', status: 'delivered', due_bucket: 'today' },
    { id: 'ORD-2', status: 'delivered', due_bucket: 'unscheduled' },
    { id: 'ORD-3', status: 'delivered', due_bucket: 'overdue' },
    { id: 'ORD-4', status: 'delivered', due_bucket: 'later' },
    { id: 'ORD-5', status: 'delivered', due_bucket: 'overdue' },
  ] as Array<Partial<AdminOrderRow>>;
  for (const scope of ['delivered', 'cancelled'] as const) {
    assert.deepEqual(archiveRowsOf(answer(scope, rows))?.map((o) => o.id), ['ORD-1', 'ORD-2', 'ORD-3', 'ORD-4', 'ORD-5'], scope);
  }
  assert.deepEqual(archiveRowsOf(answer('delivered', [])), []);
  for (const scope of ['open', 'preorder', 'all', 'prepare'] as const) assert.equal(archiveRowsOf(answer(scope, rows)), null, scope);
  assert.equal(archiveRowsOf(null), null, 'nothing loaded yet');
  assert.equal(archiveRowsOf(undefined), null);
  assert.deepEqual(archiveRowsOf({ scope: 'delivered', orders: undefined as unknown as AdminOrderRow[] }), [], 'an odd answer is an empty list, not a crash');
  assert.deepEqual(['delivered', 'cancelled', 'shipped', 'pending', undefined].map(isFinished), [true, true, false, false, false]);
});

// =========================================================================
// THE ROW
// =========================================================================

test('the chip: «سُلّم <day>» / «أُلغي <day>» in three languages, the verb alone without a time — never red, never «متأخر»', () => {
  const chip = (lang: Lang, status: 'delivered' | 'cancelled', label?: string) =>
    renderToStaticMarkup(createElement(DoneChip, { status, label, loc: locIn(lang) }));
  const cases: Array<[Lang, 'delivered' | 'cancelled', string, string]> = [
    ['ar', 'delivered', 'الثلاثاء ١٠ تشرين الثاني', 'سُلّم الثلاثاء ١٠ تشرين الثاني'],
    ['en', 'delivered', 'Tuesday 10 November', 'Delivered: Tuesday 10 November'],
    ['ckb', 'delivered', 'سێشەممە ١٠ تشرینی دووەم', 'گەیەنرا: سێشەممە ١٠ تشرینی دووەم'],
    ['ar', 'cancelled', 'اليوم', 'أُلغي اليوم'],
    ['en', 'cancelled', 'Today', 'Cancelled: Today'],
    ['ckb', 'cancelled', 'ئەمڕۆ', 'هەڵوەشێنرا: ئەمڕۆ'],
    ['ar', 'delivered', 'الاثنين ١٠ تشرين الثاني ٢٠٢٥', 'سُلّم الاثنين ١٠ تشرين الثاني ٢٠٢٥'],
  ];
  for (const [lang, status, label, want] of cases) {
    const html = chip(lang, status, label);
    assert.equal(text(html), want, `${lang} ${status}`);
    assert.match(html, new RegExp(`data-order-done="${status}"`));
    assert.match(html, /bg-surface-selected text-text-primary/, 'drawn as the day chip is');
    assert.doesNotMatch(html, /text-danger|data-order-overdue|متأخر|Overdue|دواکەوتوو/);
  }
  assert.equal(text(chip('ar', 'delivered', '')), 'سُلّم');
  assert.equal(text(chip('en', 'cancelled')), 'Cancelled');
  assert.equal(text(chip('ckb', 'delivered')), 'گەیەنرا');
  assert.match(chip('ar', 'delivered'), /text-text-muted/, 'no time: muted, like «بلا موعد»');
  // A `$` in a server label is text, never a replacement pattern.
  assert.equal(doneText(locIn('en'), 'delivered', '$& $1'), 'Delivered: $& $1');
});

function row(over: Partial<AdminOrderRow>, lang: Lang = 'ar'): string {
  const order = {
    id: 'ORD-DONE1',
    status: 'delivered',
    stage: 'delivered',
    shipping_type: 'direct',
    total_iqd: 250_000,
    address: { name: 'سارة', governorate: 'baghdad' },
    items: [],
    quick_next: null,
    ...over,
  } as unknown as AdminOrderRow;
  return renderToStaticMarkup(
    createElement(OrderBoardRow, {
      order,
      loc: locIn(lang),
      onOpen: () => {},
      onDelete: () => {},
      onAdvance: () => {},
      advancing: false,
      deleting: false,
      latin: lang === 'en',
    })
  );
}

test('a finished row says when it was finished, never its delivery day — even with the past-day bucket the server still sends', () => {
  // What the server sends for a delivery made on the 10th, due on the 3rd: bucket `overdue`.
  const delivered = row({ due_bucket: 'overdue', due_label: 'الثلاثاء ٣ تشرين الثاني', done_label: 'الثلاثاء ١٠ تشرين الثاني' });
  assert.match(text(delivered), /سُلّم الثلاثاء ١٠ تشرين الثاني/);
  assert.match(delivered, /data-order-done="delivered"/);
  for (const absent of [/data-order-overdue/, /data-order-day=/, /متأخر/, /التوصيل:/, /text-danger/]) assert.doesNotMatch(delivered, absent);

  const cancelled = row({ status: 'cancelled', stage: 'cancelled', due_bucket: 'tomorrow', due_label: 'غدًا', done_label: 'اليوم' });
  assert.match(text(cancelled), /أُلغي اليوم/);
  assert.match(cancelled, /data-order-done="cancelled"/);
  assert.match(cancelled, /data-action="delete-order-permanently"/, 'the owner’s delete stays on a cancelled row');
  assert.doesNotMatch(cancelled, /data-order-day=/);

  assert.match(text(row({ done_label: 'Tuesday 10 November', due_bucket: 'overdue' }, 'en')), /Delivered: Tuesday 10 November/);
  assert.match(text(row({ status: 'cancelled', stage: 'cancelled', done_label: 'ئەمڕۆ' }, 'ckb')), /هەڵوەشێنرا: ئەمڕۆ/);

  // A live order is unchanged: its delivery day, and «متأخر» when it is late.
  const late = row({ status: 'processing', stage: 'preparing', due_bucket: 'overdue', due_label: 'أمس', done_label: '' });
  assert.match(late, /data-order-overdue="prepare"/);
  assert.match(text(late), /التوصيل: أمس/);
  assert.doesNotMatch(late, /data-order-done/);
});

// =========================================================================
// THE BOARD
// =========================================================================

const BOARD = 'src/components/adminOrders/OrdersBoard.tsx';

test('the board sends `sort` from the archive only, re-reads on a change and starts again from page one', () => {
  const src = code(BOARD);
  const archiveBranch = src.slice(src.indexOf('if (archive) {'), src.indexOf("} else if (journey === 'prepare') {"));
  assert.match(archiveBranch, /params\.set\('scope', archiveScope\);[\s\S]*params\.set\('sort', archiveSort\);/);
  assert.equal(src.match(/params\.set\('sort'/g)?.length, 1, 'never sent from the live board');
  assert.match(src, /\}, \[archive, archiveScope, archiveSort, journey, status, query, page, lang, priceHold, priceEstimate\]\);/);
  assert.match(src, /useState<ArchiveSort>\(\(\) => readArchiveSort\(\)\)/, 'the remembered choice, read once');
  assert.match(src, /setArchiveSort\(s\);\s*saveArchiveSort\(s\);/);
  assert.match(src, /chooseArchiveSort\(s\);\s*setPage\(0\);/);
  assert.doesNotMatch(src, /localStorage/, 'storage only through archiveSort.ts, inside its try/catch');
});

test('the switch: the archive only, its own row under the three controls (never a fourth in theirs), 44 px, pressed state', () => {
  const src = code(BOARD);
  const strip = src.slice(src.indexOf('<div data-order-filters'), src.indexOf('data-order-filter="archive"'));
  assert.ok(strip.length > 0);
  assert.doesNotMatch(strip, /data-order-sort/, 'not inside [data-order-filters] — the e2e pins that row at three');
  assert.ok(src.indexOf('data-order-archive-sort') > src.indexOf('data-order-filter="archive"'), 'below the three controls');
  assert.match(src, /\{archive && \(\s*<div\s+data-order-archive-sort\s+role="group"\s+aria-label=\{say\(loc, ARCHIVE_STRINGS\.sortGroup\)\}/);
  assert.match(
    src,
    /\{ARCHIVE_SORTS\.map\(\(s\) => \(\s*<button\s+key=\{s\}\s+type="button"\s+data-order-sort=\{s\}\s+aria-pressed=\{archiveSort === s\}/
  );
  assert.match(src, /data-order-sort=\{s\}[\s\S]{0,300}className="lv-choice press-scale inline-flex min-h-\[44px\] items-center px-3 text-\[13px\] leading-\[1\.4\] font-bold"/);
  assert.match(src, /\{say\(loc, ARCHIVE_STRINGS\[s\]\)\}/);
});

test('the list and the header come from the answer: one tray in the server’s order, no day groups, the half and its total', () => {
  const src = code(BOARD);
  assert.match(src, /const archiveRows = useMemo\(\(\) => archiveRowsOf\(data\), \[data\]\);/);
  assert.match(src, /const groups = useMemo\(\(\) => \{\s*if \(archiveRowsOf\(data\)\) return \[\];/, 'no day groups for the archive');
  assert.match(
    src,
    /\{archiveRows && archiveRows\.length > 0 && \(\s*<section data-order-group="archive" data-order-sorted=\{data\?\.sort \?\? ''\} className="min-w-0">\s*<div className="lv-surface divide-y divide-border-subtle overflow-hidden">\{archiveRows\.map\(rowOf\)\}<\/div>/
  );
  // The header: the half (or «نتائج البحث» for a lookup) and the total — no «اليوم · غدًا · متأخر» in the archive.
  assert.match(src, /\{archiveRows \? \(\s*<span data-order-archive-total className="tabular-nums">\s*\{say\(loc, archiveTitle\)\} \{countText\(total, latin\)\}/);
  assert.match(src, /const archiveTitle = data\?\.search\?\.pierced\s*\? ARCHIVE_STRINGS\.results\s*: \(ARCHIVE_SCOPES\.find\(\(s\) => s\.id === data\?\.scope\) \?\? ARCHIVE_SCOPES\[0\]\);/);
  const header = src.slice(src.indexOf('<p data-order-buckets'), src.indexOf('</p>', src.indexOf('<p data-order-buckets')));
  assert.ok(header.indexOf('data-order-archive-total') < header.indexOf('data-order-overdue-count'), 'the overdue count is in the live branch only');
  // The live board's note stays on the live board.
  assert.match(src, /\{!archive && \(\s*<p data-order-board-note/);
});
