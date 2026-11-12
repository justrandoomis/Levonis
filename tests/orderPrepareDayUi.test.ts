/**
 * THE DAY TO PREPARE, ON THE SCREEN (DECISIONS row 322) — the row's day chip,
 * its «متأخر», the board's note and the order window's line, in three
 * languages.
 *
 * The board files each order on the day it is packed and handed to the
 * courier, so a row under «اليوم» may be the customer's «غدًا». The chip
 * therefore names whose day it shows («التوصيل: غدًا»), adds the day to
 * prepare away from «اليوم» — and on every row of a list with no day headers
 * («التجهيز: …») — and says in WORDS which lateness «متأخر» is: still on our
 * shelf, a booked shipment nothing moved, or with the courier (the review,
 * 2026-11-12: a title cannot be opened on a phone). The order window says the
 * same, «متأخر» included. The real components are rendered with
 * `renderToStaticMarkup` (tests/orderBoardRowItems.test.ts) and the words are
 * held to DECISIONS row 183: the `ckb` slot is its own Sorani.
 *
 * Run: node --import tsx --test tests/orderPrepareDayUi.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ROOT } from './fixtures/d1';
import { DayChip, LateMark, OrderDaysLine, lateReasonOfRow } from '../src/components/adminOrders/OrderBoardBadges';
import OrderBoardRow from '../src/components/adminOrders/OrderBoardRow';
import { BoardNote } from '../src/components/adminOrders/OrdersBoardList';
import { PREPARE_DAY_STRINGS, dayLine } from '../src/components/adminOrders/prepareDayStrings';
import type { AdminOrderRow, OrderDueBucket, OrderLateReason } from '../src/lib/api';
import { HANDOVER_HOUR } from '../worker/lib/deliveryLead';

/** Letters Sorani writes and Arabic does not, plus Sorani's own ی and ک (tests/financeDisplayStrings.test.ts). */
const SORANI_ONLY = /[ڕڵێۆەڤگچپژیک]/;
const ARABIC_ONLY = /[ةىيك]/;
const placeholders = (s: string) => [...s.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]).sort();
const NBSP = '\u00a0';

type Lang = 'ar' | 'en' | 'ckb';
const locIn = (lang: Lang) => (ar: string, en: string, ckb?: string) => (lang === 'en' ? en : lang === 'ckb' ? ckb ?? ar : ar);
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
/** The text a reader sees: tags out, every space (the no-break ones too) one space. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
/** The text a sighted reader sees: the screen-reader-only spans out as well. */
const seen = (html: string) => text(html.replace(/<span class="sr-only">[\s\S]*?<\/span>/g, ''));

test('every sentence has ar, en and its own Sorani — never the Arabic or the English, a Sorani letter, no Arabic-only one', () => {
  const entries = Object.entries(PREPARE_DAY_STRINGS);
  assert.equal(entries.length, 7);
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
  // A label and its day never part: «التوصيل:» + no-break space + the day, in every language.
  for (const key of ['delivery', 'prepare'] as const) {
    for (const s of Object.values(PREPARE_DAY_STRINGS[key])) assert.match(s, /:\u00a0\{day\}$/, `${key}: ${JSON.stringify(s)}`);
  }
  // The day to prepare is a date's label, not the row's «تجهيز» / "Prepare" button nor its Sorani «ئامادەکردن».
  assert.equal(PREPARE_DAY_STRINGS.prepare.en, `Prepare on:${NBSP}{day}`);
  assert.equal(PREPARE_DAY_STRINGS.prepare.ckb, `ڕۆژی ئامادەکردن:${NBSP}{day}`);
  assert.equal(PREPARE_DAY_STRINGS.prepare.ar, `التجهيز:${NBSP}{day}`);
});

test('the note names the 7 pm hand-over in each language’s own digits, unbroken, and the parcel with the courier', () => {
  const hour = String(HANDOVER_HOUR - 12);
  const indic = hour.replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)));
  const note = PREPARE_DAY_STRINGS.boardNote;
  // The time never breaks over two lines on a 320 px phone: no-break spaces inside it.
  assert.ok(note.ar.includes(`الساعة${NBSP}${indic}${NBSP}مساءً`), note.ar);
  assert.ok(note.en.includes(`(${hour}${NBSP}pm)`), note.en);
  assert.ok(note.ckb.includes(`کاتژمێر${NBSP}${indic}ی${NBSP}ئێوارە`), note.ckb);
  for (const s of [note.ar, note.ckb]) assert.doesNotMatch(s, /[0-9]/, 'Arabic-Indic digits in ar and ckb, as dayLabel writes them');
  assert.doesNotMatch(note.en, /[٠-٩]/);
  // …and it does not claim more than the board does: a parcel with the courier shows on its delivery day.
  assert.match(note.ar, /والطرد الذي صار مع المندوب يظهر في يوم وصوله\.$/);
  assert.match(note.en, /a parcel already with the courier shows on its delivery day\.$/);
  assert.match(note.ckb, /ئەو پاکەتەی لای گەیەنەرە لە ڕۆژی گەیاندنی دەردەکەوێت\.$/);
  // A `$` in a server label is text, never a replacement pattern.
  assert.equal(dayLine(locIn('en'), PREPARE_DAY_STRINGS.delivery, '$& $1'), `Delivery:${NBSP}$& $1`);
});

function chip(
  lang: Lang,
  props: { label?: string; bucket?: OrderDueBucket; prepareLabel?: string; lateReason?: OrderLateReason; flat?: boolean; postponed?: boolean }
) {
  return renderToStaticMarkup(createElement(DayChip, { postponed: false, ...props, loc: locIn(lang) }));
}

test('the chip names the customer’s day — «التوصيل: غدًا» — in three languages, never split from its label', () => {
  assert.equal(text(chip('ar', { label: 'غدًا', bucket: 'today', prepareLabel: 'اليوم' })), 'التوصيل: غدًا');
  assert.equal(text(chip('en', { label: 'Tomorrow', bucket: 'today', prepareLabel: 'Today' })), 'Delivery: Tomorrow');
  assert.equal(text(chip('ckb', { label: 'بەیانی', bucket: 'today', prepareLabel: 'ئەمڕۆ' })), 'گەیاندن: بەیانی');
  // The space after the label is a no-break one: a short day never wraps inside its pill.
  assert.ok(chip('ckb', { label: 'ئەمڕۆ', bucket: 'today' }).includes(`گەیاندن:${NBSP}ئەمڕۆ`));
  assert.ok(chip('en', { label: 'Tomorrow', bucket: 'today' }).includes(`Delivery:${NBSP}Tomorrow`));
  // Filed under «اليوم», the header already says when to pack it: no second day.
  assert.doesNotMatch(chip('ar', { label: 'غدًا', bucket: 'today', prepareLabel: 'اليوم' }), /data-order-prepare-day/);
  // No day: «بلا موعد», and no «التوصيل» before nothing.
  const none = chip('ar', { label: '', bucket: 'unscheduled' });
  assert.equal(text(none), 'بلا موعد');
  assert.match(none, /data-order-day="unscheduled"/);
});

test('away from «اليوم» the chip adds the day to prepare — and in a list with no day headers, on every row', () => {
  for (const bucket of ['tomorrow', 'week', 'later'] as const) {
    const html = chip('ar', { label: 'الأحد ١٥ تشرين الثاني', bucket, prepareLabel: 'السبت ١٤ تشرين الثاني' });
    assert.match(html, new RegExp(`data-order-day="${bucket}"`));
    assert.equal(text(html), 'التوصيل: الأحد ١٥ تشرين الثاني التجهيز: السبت ١٤ تشرين الثاني', bucket);
    assert.match(html, /data-order-prepare-day/);
  }
  assert.equal(
    text(chip('en', { label: 'Sunday 15 November', bucket: 'week', prepareLabel: 'Saturday 14 November' })),
    'Delivery: Sunday 15 November Prepare on: Saturday 14 November'
  );
  assert.equal(
    text(chip('ckb', { label: 'یەکشەممە ١٥ تشرینی دووەم', bucket: 'later', prepareLabel: 'شەممە ١٤ تشرینی دووەم' })),
    'گەیاندن: یەکشەممە ١٥ تشرینی دووەم ڕۆژی ئامادەکردن: شەممە ١٤ تشرینی دووەم'
  );
  // Our own same-day driver: one day, so the server sends no second one and nothing is drawn.
  assert.doesNotMatch(chip('ar', { label: 'غدًا', bucket: 'tomorrow', prepareLabel: '' }), /data-order-prepare-day/);
  // A lookup's results have no «اليوم» header to say when to pack: the row says it, late or not.
  assert.equal(text(chip('ar', { label: 'غدًا', bucket: 'today', prepareLabel: 'اليوم', flat: true })), 'التوصيل: غدًا التجهيز: اليوم');
  assert.match(seen(chip('ar', { label: 'اليوم', bucket: 'overdue', prepareLabel: 'أمس', flat: true })), /^التوصيل: اليوم التجهيز: أمس متأخر$/);
  assert.doesNotMatch(chip('ar', { label: 'غدًا', bucket: 'today', prepareLabel: '', flat: true }), /data-order-prepare-day/);
});

test('«متأخر» says in words which lateness it is: the shelf, or the courier (a booked shipment is the courier’s) — title and screen reader too', () => {
  const shelf = chip('ar', { label: 'اليوم', bucket: 'overdue', prepareLabel: 'أمس' });
  assert.match(shelf, /data-order-overdue="prepare"/, 'the default: still on our shelf');
  assert.equal(seen(shelf), 'التوصيل: اليوم متأخر', 'the common case stays one word');
  const cases: Array<[Lang, OrderLateReason, string, keyof typeof PREPARE_DAY_STRINGS]> = [
    ['ar', 'courier', 'متأخر · مع المندوب', 'overdueCourier'],
    ['en', 'courier', 'Overdue · with the courier', 'overdueCourier'],
    ['ckb', 'courier', 'دواکەوتوو · لای گەیەنەر', 'overdueCourier'],
    ['ar', 'prepare', 'متأخر', 'overduePrepare'],
    ['en', 'prepare', 'Overdue', 'overduePrepare'],
    ['ckb', 'prepare', 'دواکەوتوو', 'overduePrepare'],
  ];
  for (const [lang, reason, visible, why] of cases) {
    const html = renderToStaticMarkup(createElement(LateMark, { reason, loc: locIn(lang) }));
    const sentence = PREPARE_DAY_STRINGS[why][lang];
    assert.match(html, new RegExp(`data-order-overdue="${reason}"`));
    assert.equal(seen(html), visible, `${lang} ${reason}: on its face`);
    assert.ok(html.includes(`title="${sentence}"`), `${lang} ${reason}: the title`);
    assert.ok(html.includes(`<span class="sr-only"> — ${sentence}</span>`), `${lang} ${reason}: the screen reader hears why`);
    assert.match(html, /class="text-\[11px\] leading-\[1\.4\] font-bold text-danger"/, 'the one red thing');
  }
  // The «·» never starts a line (a no-break space before it), and the reason is one unbreakable
  // phrase: a narrow row breaks after the «·», never inside «مع المندوب».
  assert.ok(renderToStaticMarkup(createElement(LateMark, { reason: 'courier', loc: locIn('ar') })).includes(`متأخر${NBSP}· مع${NBSP}المندوب`));
  for (const key of ['lateCourier'] as const) {
    for (const [lang, s] of Object.entries(PREPARE_DAY_STRINGS[key])) assert.ok(!s.includes(' ') && s.includes(NBSP), `${key}.${lang}: ${JSON.stringify(s)}`);
  }
  assert.doesNotMatch(chip('ar', { label: 'غدًا', bucket: 'today' }), /data-order-overdue/);
});

function row(over: Partial<AdminOrderRow>, flat = false): string {
  const order = {
    id: 'ORD-DAY1',
    status: 'processing',
    stage: 'preparing',
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
      loc: locIn('ar'),
      onOpen: () => {},
      onDelete: () => {},
      onAdvance: () => {},
      advancing: false,
      deleting: false,
      flat,
    })
  );
}

test('the row hands the chip the server’s second day and the server’s reason for «متأخر»', () => {
  const tomorrowWork = row({ due_bucket: 'tomorrow', due_label: 'السبت ١٤ تشرين الثاني', prepare_label: 'غدًا' });
  assert.match(text(tomorrowWork), /التوصيل: السبت ١٤ تشرين الثاني التجهيز: غدًا/);
  // The server decides the reason — a booked shipment still at «قيد التجهيز» is with the courier (the owner,
  // 2026-11-12: a booking is the hand-over), so a passed day is the courier's, not «go and pack it».
  assert.match(row({ due_bucket: 'overdue', due_label: 'أمس', stage: 'preparing', overdue_reason: 'courier' }), /data-order-overdue="courier"/);
  assert.match(seen(row({ due_bucket: 'overdue', due_label: 'أمس', stage: 'preparing', overdue_reason: 'courier' })), /متأخر · مع المندوب/);
  assert.match(row({ due_bucket: 'overdue', due_label: 'اليوم', stage: 'preparing', overdue_reason: 'prepare' }), /data-order-overdue="prepare"/);
  assert.match(row({ due_bucket: 'overdue', due_label: 'أمس', stage: 'out_for_delivery', status: 'shipped', overdue_reason: 'courier' }), /data-order-overdue="courier"/);
  // An older server sends no reason: the stage alone tells the courier's from the shelf's.
  assert.match(row({ due_bucket: 'overdue', due_label: 'اليوم', stage: 'preparing' }), /data-order-overdue="prepare"/);
  assert.match(row({ due_bucket: 'overdue', due_label: 'أمس', stage: 'out_for_delivery', status: 'shipped' }), /data-order-overdue="courier"/);
  assert.deepEqual(
    [lateReasonOfRow({ stage: 'preparing' }), lateReasonOfRow({ stage: 'out_for_delivery' }), lateReasonOfRow({ stage: 'preparing', overdue_reason: 'courier' })],
    ['prepare', 'courier', 'courier']
  );
  // In a lookup's flat list the row names the day to pack it even under «اليوم».
  assert.match(text(row({ due_bucket: 'today', due_label: 'غدًا', prepare_label: 'اليوم' }, true)), /التوصيل: غدًا التجهيز: اليوم/);
  assert.doesNotMatch(row({ due_bucket: 'today', due_label: 'غدًا', prepare_label: 'اليوم' }), /data-order-prepare-day/);
});

function days(lang: Lang, props: { deliveryLabel?: string; prepareLabel?: string; lateReason?: OrderLateReason | null }) {
  return renderToStaticMarkup(createElement(OrderDaysLine, { ...props, loc: locIn(lang) }));
}

test('the order window: both days from the server, each a block that breaks whole — and «متأخر» when its day has passed', () => {
  // On time: the two days, nothing red.
  const onTime = days('ar', { deliveryLabel: 'غدًا', prepareLabel: 'اليوم' });
  assert.equal(text(onTime), 'التوصيل: غدًا · التجهيز: اليوم');
  assert.doesNotMatch(onTime, /data-order-overdue|text-danger/);
  // Each part one `inline-block`, the «·» at the end of the part before it: the line breaks
  // between the days, never between «ئامادەکردن:» and its day.
  assert.equal(onTime.match(/<span class="inline-block">/g)?.length, 2);
  assert.match(onTime, /<span class="inline-block"><span>التوصيل:\u00a0غدًا<\/span><span class="mx-1\.5 text-text-muted" aria-hidden="true">·<\/span><\/span>/);
  assert.equal(
    text(days('ckb', { deliveryLabel: 'بەیانی', prepareLabel: 'سێشەممە ٢٤ تشرینی دووەم' })),
    'گەیاندن: بەیانی · ڕۆژی ئامادەکردن: سێشەممە ٢٤ تشرینی دووەم'
  );
  // Late: the board's own «متأخر» and its reason, after the days — a past day to pack never reads as a schedule.
  const late = days('ar', { deliveryLabel: 'اليوم', prepareLabel: 'الأربعاء ١١ تشرين الثاني', lateReason: 'prepare' });
  assert.equal(seen(late), 'التوصيل: اليوم · التجهيز: الأربعاء ١١ تشرين الثاني · متأخر');
  assert.match(late, /data-order-overdue="prepare"/);
  assert.equal(late.match(/<span class="inline-block">/g)?.length, 3);
  assert.equal(seen(days('en', { deliveryLabel: 'Yesterday', lateReason: 'courier' })), 'Delivery: Yesterday · Overdue · with the courier');
  assert.equal(seen(days('ckb', { deliveryLabel: 'دوێنێ', lateReason: 'courier' })), 'گەیاندن: دوێنێ · دواکەوتوو · لای گەیەنەر');
  // No day («في أقرب وقت»): no line at all.
  assert.equal(days('ar', { deliveryLabel: '', prepareLabel: '', lateReason: null }), '');
  assert.equal(days('ar', {}), '');
});

test('the window asks in the reader’s language and draws the server’s line; the board says the rule once', () => {
  const modal = read('src/components/adminOrders/OrderDetailModal.tsx');
  assert.match(modal, /api\.get<\{ order: EstimateOrderDetail \}>\(`\/api\/admin\/orders\/\$\{orderId\}\?lang=\$\{lang\}`\)/, 'the labels come in the reader’s language');
  assert.match(modal, /\}, \[orderId, lang\]\);/);
  assert.match(
    modal,
    /<OrderDaysLine\s+deliveryLabel=\{detail\.delivery_day_label\}\s+prepareLabel=\{detail\.prepare_label\}\s+lateReason=\{detail\.overdue_reason\}\s+loc=\{loc\}\s+\/>/
  );
  // The note: one muted line over the live board's day groups — never over the
  // archive or a lookup's results, which have no day headers to explain.
  type NoteData = Parameters<typeof BoardNote>[0]['data'];
  const note = (data: NoteData, lang: Lang = 'ar') => renderToStaticMarkup(createElement(BoardNote, { data, loc: locIn(lang) }));
  const live: NonNullable<NoteData> = {
    scope: 'open',
    orders: [],
    total: 0,
    counts: { total: 0, overdue: 0, today: 0, tomorrow: 0, week: 0, later: 0, unscheduled: 0 },
    search: null,
    sort: null,
  };
  const html = note(live);
  assert.match(html, /^<p data-order-board-note="[^"]*" class="mt-0\.5 text-\[12px\] leading-\[1\.5\] text-text-muted">/);
  assert.equal(text(html), text(PREPARE_DAY_STRINGS.boardNote.ar));
  assert.equal(text(note(live, 'ckb')), text(PREPARE_DAY_STRINGS.boardNote.ckb));
  assert.equal(note(null).length > 0, true, 'the live board before its first answer');
  assert.equal(note({ ...live, scope: 'delivered' }), '');
  assert.equal(note({ ...live, search: { raw: '07809998877', pierced: true } }), '');
  assert.match(read('src/components/adminOrders/OrdersBoard.tsx'), /<BoardNote data=\{data\} loc=\{loc\} \/>/);
});
