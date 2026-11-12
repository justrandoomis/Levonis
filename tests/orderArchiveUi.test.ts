/**
 * THE COMPLETED ORDERS ON THE SCREEN (DECISIONS row 323) — the archive's
 * «الأحدث أولًا / الأقدم أولًا» switch, its one list in the server's order, the
 * finished row's «سُلّم …» / «أُلغي …» chip and the archive's header line — and,
 * since the review (2026-11-12), an order- or phone-number lookup drawn the same
 * way: one list, «نتائج البحث N», no «متأخر» count, no switch.
 *
 *   THE WORDS     one typed ar/en/ckb table; the `ckb` slot is its own Sorani
 *                 (DECISIONS row 183): not the Arabic, a Sorani letter, no
 *                 Arabic-only letter, the same placeholders; a verb and its
 *                 day joined by a no-break space.
 *   THE CHOICE    remembered per browser and never able to throw: missing,
 *                 blocked or throwing storage reads as newest.
 *   THE LIST      which of the three lists an answer is — the live board's
 *                 day groups, the archive's one list, a lookup's results —
 *                 decided by the answer alone; the one list keeps the
 *                 server's order.
 *   THE ROW       a finished order says when it was finished and is never
 *                 «متأخر»; a live one still is, when late. The real components
 *                 are rendered with `renderToStaticMarkup`.
 *   THE BOARD     the header line, the note, the switch and the trays rendered
 *                 from whole answers (OrdersBoardList.tsx) — the live board's,
 *                 the archive's, and a lookup that finds a customer's
 *                 delivered and cancelled orders beside a live one; and
 *                 OrdersBoard.tsx sending `sort` from the archive only.
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
  ARCHIVE_SCOPES,
  ARCHIVE_SORTS,
  ARCHIVE_SORT_KEY,
  ARCHIVE_STRINGS,
  doneText,
  flatRowsOf,
  isFinished,
  listModeOf,
  readArchiveSort,
  saveArchiveSort,
} from '../src/components/adminOrders/archiveSort';
import { DoneChip } from '../src/components/adminOrders/OrderBoardBadges';
import OrderBoardRow from '../src/components/adminOrders/OrderBoardRow';
import { ArchiveSortSwitch, BoardHeaderLine, BoardNote, BoardTrays, GROUPS } from '../src/components/adminOrders/OrdersBoardList';
import type { AdminOrderRow, AdminOrdersResponse } from '../src/lib/api';

/** Letters Sorani writes and Arabic does not, plus Sorani's own ی and ک (tests/financeDisplayStrings.test.ts). */
const SORANI_ONLY = /[ڕڵێۆەڤگچپژیک]/;
const ARABIC_ONLY = /[ةىيك]/;
const placeholders = (s: string) => [...s.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]).sort();
const NBSP = String.fromCharCode(0xa0);

type Lang = 'ar' | 'en' | 'ckb';
const locIn = (lang: Lang) => (ar: string, en: string, ckb?: string) => (lang === 'en' ? en : lang === 'ckb' ? ckb ?? ar : ar);
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** The code of a file without its comments: a comment may quote what it explains. */
const code = (rel: string) =>
  read(rel)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
/** The text a reader sees: tags out, every space (the no-break ones too) one space. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
/** …and without the screen-reader-only spans. */
const seen = (html: string) => text(html.replace(/<span class="sr-only">[\s\S]*?<\/span>/g, ''));

// =========================================================================
// THE WORDS
// =========================================================================

test('every sentence has ar, en and its own Sorani — never the Arabic or the English, a Sorani letter, no Arabic-only one', () => {
  const entries: Array<[string, { ar: string; en: string; ckb: string }]> = [
    ...Object.entries(ARCHIVE_STRINGS),
    ...ARCHIVE_SCOPES.map((s) => [`scope:${s.id}`, s] as [string, { ar: string; en: string; ckb: string }]),
  ];
  assert.equal(Object.keys(ARCHIVE_STRINGS).length, 8);
  assert.deepEqual(ARCHIVE_SCOPES.map((s) => s.id), ['delivered', 'cancelled']);
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
  assert.equal(ARCHIVE_STRINGS.delivered.ar, `سُلّم${NBSP}{day}`);
  assert.equal(ARCHIVE_STRINGS.cancelled.ar, `أُلغي${NBSP}{day}`);
  // A verb and its day never part inside the pill on a 320 px phone: «Delivered: Today», whole.
  for (const key of ['delivered', 'cancelled'] as const) {
    for (const s of Object.values(ARCHIVE_STRINGS[key])) assert.ok(s.endsWith(`${NBSP}{day}`) && !s.includes(' {day}'), `${key}: ${JSON.stringify(s)}`);
  }
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

type Answer = Pick<AdminOrdersResponse, 'scope' | 'orders' | 'total' | 'counts' | 'search' | 'sort'>;
const COUNTS = { total: 0, overdue: 0, today: 0, tomorrow: 0, week: 0, later: 0, unscheduled: 0 };
const answer = (
  scope: AdminOrdersResponse['scope'],
  orders: Array<Partial<AdminOrderRow>>,
  over: Partial<Answer> = {}
): Answer => ({ scope, orders: orders as AdminOrderRow[], total: orders.length, counts: { ...COUNTS, total: orders.length }, search: null, sort: null, ...over });
const PIERCED = { raw: '07809998877', pierced: true };

test('which list an answer is — decided by the answer alone; the one list is exactly the server’s order', () => {
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
  const order = ['ORD-1', 'ORD-2', 'ORD-3', 'ORD-4', 'ORD-5'];
  for (const scope of ['delivered', 'cancelled'] as const) {
    assert.equal(listModeOf(answer(scope, rows)), 'archive', scope);
    assert.deepEqual(flatRowsOf(answer(scope, rows))?.map((o) => o.id), order, scope);
  }
  // An order- or phone-number lookup is one list from EITHER half — the live board's included.
  for (const scope of ['open', 'preorder', 'all', 'prepare', 'delivered', 'cancelled'] as const) {
    assert.equal(listModeOf(answer(scope, rows, { search: PIERCED })), 'results', scope);
    assert.deepEqual(flatRowsOf(answer(scope, rows, { search: PIERCED }))?.map((o) => o.id), order, scope);
  }
  // A name or date search browses the board: the live board keeps its day groups.
  for (const scope of ['open', 'preorder', 'all', 'prepare'] as const) {
    assert.equal(listModeOf(answer(scope, rows)), 'groups', scope);
    assert.equal(flatRowsOf(answer(scope, rows, { search: { raw: 'احمد', pierced: false } })), null, scope);
  }
  assert.deepEqual(flatRowsOf(answer('delivered', [])), []);
  assert.equal(flatRowsOf(null), null, 'nothing loaded yet');
  assert.equal(listModeOf(undefined), 'groups');
  assert.deepEqual(flatRowsOf({ ...answer('delivered', []), orders: undefined as unknown as AdminOrderRow[] }), [], 'an odd answer is an empty list, not a crash');
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
  // The verb and a short day stay one piece.
  assert.ok(chip('en', 'cancelled', 'Today').includes(`Cancelled:${NBSP}Today`));
  assert.ok(chip('ckb', 'cancelled', 'ئەمڕۆ').includes(`هەڵوەشێنرا:${NBSP}ئەمڕۆ`));
  assert.equal(text(chip('ar', 'delivered', '')), 'سُلّم');
  assert.equal(text(chip('en', 'cancelled')), 'Cancelled');
  assert.equal(text(chip('ckb', 'delivered')), 'گەیەنرا');
  assert.match(chip('ar', 'delivered'), /text-text-muted/, 'no time: muted, like «بلا موعد»');
  // A `$` in a server label is text, never a replacement pattern.
  assert.equal(doneText(locIn('en'), 'delivered', '$& $1'), `Delivered:${NBSP}$& $1`);
});

function rowHtml(over: Partial<AdminOrderRow>, lang: Lang = 'ar', flat = false): string {
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
      flat,
    })
  );
}

test('a finished row says when it was finished, never its delivery day — even with the past-day bucket the server still sends', () => {
  // What the server sends for a delivery made on the 10th, due on the 3rd: bucket `overdue`.
  const delivered = rowHtml({ due_bucket: 'overdue', due_label: 'الثلاثاء ٣ تشرين الثاني', done_label: 'الثلاثاء ١٠ تشرين الثاني' });
  assert.match(text(delivered), /سُلّم الثلاثاء ١٠ تشرين الثاني/);
  assert.match(delivered, /data-order-done="delivered"/);
  for (const absent of [/data-order-overdue/, /data-order-day=/, /متأخر/, /التوصيل:/, /text-danger/]) assert.doesNotMatch(delivered, absent);

  const cancelled = rowHtml({ status: 'cancelled', stage: 'cancelled', due_bucket: 'tomorrow', due_label: 'غدًا', done_label: 'اليوم' });
  assert.match(text(cancelled), /أُلغي اليوم/);
  assert.match(cancelled, /data-order-done="cancelled"/);
  assert.match(cancelled, /data-action="delete-order-permanently"/, 'the owner’s delete stays on a cancelled row');
  assert.doesNotMatch(cancelled, /data-order-day=/);

  assert.match(text(rowHtml({ done_label: 'Tuesday 10 November', due_bucket: 'overdue' }, 'en')), /Delivered: Tuesday 10 November/);
  assert.match(text(rowHtml({ status: 'cancelled', stage: 'cancelled', done_label: 'ئەمڕۆ' }, 'ckb')), /هەڵوەشێنرا: ئەمڕۆ/);

  // A live order is unchanged: its delivery day, and «متأخر» when it is late.
  const late = rowHtml({ status: 'processing', stage: 'preparing', due_bucket: 'overdue', due_label: 'أمس', done_label: '', overdue_reason: 'prepare' });
  assert.match(late, /data-order-overdue="prepare"/);
  assert.match(text(late), /التوصيل: أمس/);
  assert.doesNotMatch(late, /data-order-done/);
});

// =========================================================================
// THE BOARD — whole answers, drawn
// =========================================================================

const rowOf = (lang: Lang) => (order: AdminOrderRow, flat: boolean) =>
  createElement(OrderBoardRow, {
    key: order.id,
    // The fields a row reads, where the test's answer left them out.
    order: { shipping_type: 'direct', total_iqd: 50_000, address: { name: 'زبون', governorate: 'baghdad' }, items: [], quick_next: null, ...(order as Partial<AdminOrderRow>) } as AdminOrderRow,
    loc: locIn(lang),
    onOpen: () => {},
    onDelete: () => {},
    onAdvance: () => {},
    advancing: false,
    deleting: false,
    latin: lang === 'en',
    flat,
  });

function board(data: Answer | null, lang: Lang = 'ar', pages = 1) {
  const loc = locIn(lang);
  const latin = lang === 'en';
  return {
    header: renderToStaticMarkup(createElement(BoardHeaderLine, { data, loc, latin, pages })),
    note: renderToStaticMarkup(createElement(BoardNote, { data, loc })),
    trays: renderToStaticMarkup(createElement(BoardTrays, { data, loc, latin, rowOf: rowOf(lang) })),
  };
}
const groupsOf = (html: string) => [...html.matchAll(/data-order-group="([a-z]+)"/g)].map((m) => m[1]);
const cardsOf = (html: string) => [...html.matchAll(/data-order-card="([^"]+)"/g)].map((m) => m[1]);

/** A customer's phone number on the live board: a delivered and a cancelled order beside the live one, as the route answers it. */
const LOOKUP = answer(
  'open',
  [
    { id: 'ORD-D0E000003', status: 'delivered', stage: 'delivered', due_bucket: 'overdue', due_label: 'الثلاثاء ٣ تشرين الثاني', done_label: 'الأربعاء ٤ تشرين الثاني', overdue_reason: null, priority: 1 },
    { id: 'ORD-CA0C00005', status: 'cancelled', stage: 'cancelled', due_bucket: 'overdue', due_label: 'الخميس ٥ تشرين الثاني', done_label: 'الخميس ٥ تشرين الثاني', overdue_reason: null },
    { id: 'ORD-11FE00013', status: 'processing', stage: 'preparing', due_bucket: 'today', due_label: 'غدًا', prepare_label: 'اليوم', overdue_reason: null },
  ],
  { search: PIERCED, counts: { total: 3, overdue: 2, today: 1, tomorrow: 0, week: 0, later: 0, unscheduled: 0 } }
);

test('a phone lookup on the live board: one list «نتائج البحث ٣» — no «اليوم», no red «متأخر ٢», no PRO, no note', () => {
  const { header, note, trays } = board(LOOKUP);
  assert.equal(text(header), 'نتائج البحث ٣');
  assert.match(header, /data-order-list-total="results"/);
  for (const absent of [/data-order-overdue-count/, /text-danger/, /متأخر/, /PRO/, /اليوم/]) assert.doesNotMatch(header, absent, `header: ${absent}`);
  assert.equal(note, '', 'the note explains day groups, and there are none');
  assert.deepEqual(groupsOf(trays), ['results'], 'one tray — never «اليوم»');
  assert.deepEqual(cardsOf(trays), ['ORD-D0E000003', 'ORD-CA0C00005', 'ORD-11FE00013'], 'the server’s order');
  assert.doesNotMatch(trays, /data-order-overdue|text-danger/, 'nothing on it is late');
  assert.match(text(trays), /سُلّم الأربعاء ٤ تشرين الثاني/);
  assert.match(text(trays), /أُلغي الخميس ٥ تشرين الثاني/);
  // The live row has no «اليوم» header over it, so it names its day to pack itself.
  assert.match(text(trays), /التوصيل: غدًا التجهيز: اليوم/);
  // The same answer in English and Sorani.
  assert.equal(text(board(LOOKUP, 'en').header), 'Search results 3');
  assert.equal(text(board(LOOKUP, 'ckb').header), 'ئەنجامی گەڕان ٣');
  // From the archive the same lookup draws the same list.
  assert.deepEqual(groupsOf(board({ ...LOOKUP, scope: 'delivered' }).trays), ['results']);
  assert.equal(text(board({ ...LOOKUP, scope: 'cancelled' }).header), 'نتائج البحث ٣');
});

test('the live board keeps its day groups, its counts, «متأخر» in red, PRO and the note — a name search too', () => {
  const live = answer(
    'open',
    [
      { id: 'ORD-A1', status: 'confirmed', stage: 'confirmed', due_bucket: 'overdue', due_label: 'اليوم', prepare_label: 'أمس', overdue_reason: 'prepare' },
      { id: 'ORD-A2', status: 'processing', stage: 'preparing', due_bucket: 'today', due_label: 'غدًا', prepare_label: 'اليوم', priority: 1 },
      { id: 'ORD-A3', status: 'processing', stage: 'preparing', due_bucket: 'tomorrow', due_label: 'السبت ١٤ تشرين الثاني', prepare_label: 'غدًا' },
      { id: 'ORD-A4', status: 'pending', stage: 'received', due_bucket: 'unscheduled', due_label: '' },
    ],
    { counts: { total: 4, overdue: 1, today: 1, tomorrow: 1, week: 0, later: 0, unscheduled: 1 } }
  );
  for (const data of [live, { ...live, search: { raw: 'احمد', pierced: false } }]) {
    const { header, note, trays } = board(data, 'ar', 2);
    assert.equal(text(header), 'اليوم ٢ · غدًا ١ · متأخر ١ · PRO ١ (هذه الصفحة)');
    assert.match(header, /<span data-order-overdue-count="true" class="tabular-nums font-bold text-danger">متأخر ١<\/span>/);
    assert.match(note, /data-order-board-note/);
    assert.deepEqual(groupsOf(trays), ['today', 'tomorrow', 'unscheduled']);
    assert.match(text(trays), /^اليوم \(٢\)/, '«اليوم» counts the late box too');
    assert.deepEqual(cardsOf(trays), ['ORD-A1', 'ORD-A2', 'ORD-A3', 'ORD-A4']);
    assert.match(trays, /data-order-overdue="prepare"/);
    // Under «اليوم» the header says when to pack: no second day on its rows.
    assert.doesNotMatch(trays.slice(0, trays.indexOf('data-order-group="tomorrow"')), /data-order-prepare-day/);
  }
  // The words of the day groups did not change.
  assert.deepEqual(GROUPS.map((g) => g.ar), ['اليوم', 'غدًا', 'هذا الأسبوع', 'لاحقًا', 'بلا موعد']);
  // Nothing loaded yet: the live board's empty line, and its note.
  assert.equal(text(board(null).header), 'اليوم ٠ · غدًا ٠');
  assert.match(board(null).note, /data-order-board-note/);
});

test('the archive: one tray by when each was finished, the half and its total, no note and nothing late', () => {
  const half = answer(
    'delivered',
    [
      { id: 'ORD-N1', status: 'delivered', stage: 'delivered', due_bucket: 'overdue', due_label: 'الثلاثاء ٣ تشرين الثاني', done_label: 'اليوم' },
      { id: 'ORD-N2', status: 'delivered', stage: 'delivered', due_bucket: 'tomorrow', due_label: 'غدًا', done_label: 'الأربعاء ١١ تشرين الثاني' },
    ],
    { sort: 'newest', total: 9, counts: { total: 9, overdue: 7, today: 1, tomorrow: 1, week: 0, later: 0, unscheduled: 0 } }
  );
  const { header, note, trays } = board(half);
  assert.equal(text(header), 'تم التسليم ٩');
  assert.match(header, /data-order-list-total="archive"/);
  assert.doesNotMatch(header, /data-order-overdue-count|متأخر/);
  assert.equal(note, '');
  assert.match(trays, /<section data-order-group="archive" data-order-sorted="newest" class="min-w-0">/);
  assert.deepEqual(cardsOf(trays), ['ORD-N1', 'ORD-N2']);
  assert.doesNotMatch(trays, /data-order-overdue|data-order-day=/);
  assert.equal(text(board({ ...half, scope: 'cancelled' }, 'en').header), 'Cancelled 9');
  assert.equal(text(board({ ...half, scope: 'cancelled' }, 'ckb').header), 'هەڵوەشاوە ٩');
  // An empty half draws no tray at all (the board's «لا توجد طلبات» line says it).
  assert.equal(board(answer('delivered', [])).trays, '');
});

test('the switch: the archive only, never during a lookup — 44 px, the pressed one is the choice', () => {
  const sw = (archive: boolean, data: Answer | null, value: 'newest' | 'oldest' = 'newest', lang: Lang = 'ar') =>
    renderToStaticMarkup(createElement(ArchiveSortSwitch, { archive, data, value, onChoose: () => {}, loc: locIn(lang) }));
  const archiveAnswer = answer('delivered', [{ id: 'ORD-N1', status: 'delivered' }], { sort: 'oldest' });
  const html = sw(true, archiveAnswer, 'oldest');
  assert.match(html, /^<div data-order-archive-sort="true" role="group" aria-label="ترتيب الطلبات المكتملة" class="flex flex-wrap gap-2 min-w-0">/);
  assert.deepEqual([...html.matchAll(/data-order-sort="([a-z]+)" aria-pressed="(true|false)"/g)].map((m) => `${m[1]}:${m[2]}`), ['newest:false', 'oldest:true']);
  assert.equal(html.match(/class="lv-choice press-scale inline-flex min-h-\[44px\] items-center px-3 text-\[13px\] leading-\[1\.4\] font-bold"/g)?.length, 2);
  assert.equal(seen(html), 'الأحدث أولًا الأقدم أولًا');
  assert.equal(seen(sw(true, archiveAnswer, 'newest', 'en')), 'Newest first Oldest first');
  // Shown the moment the archive is chosen, before its first answer arrives…
  assert.notEqual(sw(true, null), '');
  assert.notEqual(sw(true, answer('open', [])), '');
  // …but never on the live board, and never over a lookup's results, which keep the work list's order.
  assert.equal(sw(false, archiveAnswer), '');
  assert.equal(sw(true, { ...archiveAnswer, search: PIERCED, sort: null }), '');
  assert.equal(sw(true, { ...archiveAnswer, search: { raw: 'احمد', pierced: false } }) === '', false, 'a name search still sorts');
});

const BOARD = 'src/components/adminOrders/OrdersBoard.tsx';

test('the board sends `sort` from the archive only, re-reads on a change, starts again from page one — and draws the answer through OrdersBoardList', () => {
  const src = code(BOARD);
  const archiveBranch = src.slice(src.indexOf('if (archive) {'), src.indexOf("} else if (journey === 'prepare') {"));
  assert.match(archiveBranch, /params\.set\('scope', archiveScope\);[\s\S]*params\.set\('sort', archiveSort\);/);
  assert.equal(src.match(/params\.set\('sort'/g)?.length, 1, 'never sent from the live board');
  assert.match(src, /\}, \[archive, archiveScope, archiveSort, journey, status, query, page, lang, priceHold, priceEstimate\]\);/);
  assert.match(src, /useState<ArchiveSort>\(\(\) => readArchiveSort\(\)\)/, 'the remembered choice, read once');
  assert.match(src, /setArchiveSort\(s\);\s*saveArchiveSort\(s\);/);
  assert.match(src, /<ArchiveSortSwitch\s+archive=\{archive\}\s+data=\{data\}\s+value=\{archiveSort\}\s+onChoose=\{\(s\) => \{\s*chooseArchiveSort\(s\);\s*setPage\(0\);\s*\}\}/);
  assert.doesNotMatch(src, /localStorage/, 'storage only through archiveSort.ts, inside its try/catch');
  // The switch's own row sits under the three controls — never a fourth in theirs (the e2e pins that row at three).
  const strip = src.slice(src.indexOf('<div data-order-filters'), src.indexOf('data-order-filter="archive"'));
  assert.ok(strip.length > 0);
  assert.doesNotMatch(strip, /ArchiveSortSwitch|data-order-sort/);
  assert.ok(src.indexOf('<ArchiveSortSwitch') > src.indexOf('data-order-filter="archive"'), 'below the three controls');
  // The header line, the note and the list are the answer's, drawn in one place.
  assert.match(src, /<BoardHeaderLine data=\{data\} loc=\{loc\} latin=\{latin\} pages=\{pages\} \/>\s*<BoardNote data=\{data\} loc=\{loc\} \/>/);
  assert.match(src, /<BoardTrays data=\{data\} loc=\{loc\} latin=\{latin\} rowOf=\{rowOf\} \/>/);
  assert.match(src, /const rowOf = \(o: AdminOrderRow, flat: boolean\) => \([\s\S]{0,400}flat=\{flat\}/);
  for (const gone of [/data-order-overdue-count/, /groupOf\(/, /archiveRowsOf/]) assert.doesNotMatch(src, gone, 'drawn by OrdersBoardList.tsx only');
});
