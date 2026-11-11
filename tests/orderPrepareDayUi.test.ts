/**
 * THE DAY TO PREPARE, ON THE SCREEN (DECISIONS row 322) — the row's day chip,
 * the board's note and the order window's line, in three languages.
 *
 * The board files each order on the day it is packed and handed to the
 * courier, so a row under «اليوم» may be the customer's «غدًا». The chip
 * therefore names whose day it shows («التوصيل: غدًا»), adds the day to
 * prepare away from «اليوم» («التجهيز: …»), and says which lateness «متأخر»
 * is: still on our shelf, or with the courier. The real components are
 * rendered with `renderToStaticMarkup` (tests/orderBoardRowItems.test.ts) and
 * the words are held to DECISIONS row 183: the `ckb` slot is its own Sorani.
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
import { DayChip } from '../src/components/adminOrders/OrderBoardBadges';
import OrderBoardRow from '../src/components/adminOrders/OrderBoardRow';
import { PREPARE_DAY_STRINGS, dayLine } from '../src/components/adminOrders/prepareDayStrings';
import type { AdminOrderRow, OrderDueBucket } from '../src/lib/api';
import { HANDOVER_HOUR } from '../worker/lib/deliveryLead';

/** Letters Sorani writes and Arabic does not, plus Sorani's own ی and ک (tests/financeDisplayStrings.test.ts). */
const SORANI_ONLY = /[ڕڵێۆەڤگچپژیک]/;
const ARABIC_ONLY = /[ةىيك]/;
const placeholders = (s: string) => [...s.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]).sort();

type Lang = 'ar' | 'en' | 'ckb';
const locIn = (lang: Lang) => (ar: string, en: string, ckb?: string) => (lang === 'en' ? en : lang === 'ckb' ? ckb ?? ar : ar);
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();

test('every sentence has ar, en and its own Sorani — never the Arabic or the English, a Sorani letter, no Arabic-only one', () => {
  const entries = Object.entries(PREPARE_DAY_STRINGS);
  assert.equal(entries.length, 5);
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
  assert.deepEqual(placeholders(PREPARE_DAY_STRINGS.delivery.ar), ['day']);
  assert.deepEqual(placeholders(PREPARE_DAY_STRINGS.prepare.ar), ['day']);
});

test('the note names the 7 pm hand-over in each language’s own digits', () => {
  const hour = String(HANDOVER_HOUR - 12);
  const indic = hour.replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)));
  const note = PREPARE_DAY_STRINGS.boardNote;
  assert.ok(note.ar.includes(`${indic} مساءً`), note.ar);
  assert.ok(note.en.includes(`${hour} pm`), note.en);
  assert.ok(note.ckb.includes(`${indic}ی ئێوارە`), note.ckb);
  for (const s of [note.ar, note.ckb]) assert.doesNotMatch(s, /[0-9]/, 'Arabic-Indic digits in ar and ckb, as dayLabel writes them');
  assert.doesNotMatch(note.en, /[٠-٩]/);
  // A `$` in a server label is text, never a replacement pattern.
  assert.equal(dayLine(locIn('en'), PREPARE_DAY_STRINGS.delivery, '$& $1'), 'Delivery: $& $1');
});

function chip(lang: Lang, props: { label?: string; bucket?: OrderDueBucket; prepareLabel?: string; handedOver?: boolean; postponed?: boolean }) {
  return renderToStaticMarkup(createElement(DayChip, { postponed: false, ...props, loc: locIn(lang) }));
}

test('the chip names the customer’s day — «التوصيل: غدًا» — in three languages', () => {
  assert.equal(text(chip('ar', { label: 'غدًا', bucket: 'today', prepareLabel: 'اليوم' })), 'التوصيل: غدًا');
  assert.equal(text(chip('en', { label: 'Tomorrow', bucket: 'today', prepareLabel: 'Today' })), 'Delivery: Tomorrow');
  assert.equal(text(chip('ckb', { label: 'بەیانی', bucket: 'today', prepareLabel: 'ئەمڕۆ' })), 'گەیاندن: بەیانی');
  // Filed under «اليوم», the header already says when to pack it: no second day.
  assert.doesNotMatch(chip('ar', { label: 'غدًا', bucket: 'today', prepareLabel: 'اليوم' }), /data-order-prepare-day/);
  // No day: «بلا موعد», and no «التوصيل» before nothing.
  const none = chip('ar', { label: '', bucket: 'unscheduled' });
  assert.equal(text(none), 'بلا موعد');
  assert.match(none, /data-order-day="unscheduled"/);
});

test('away from «اليوم» the chip adds the day to prepare — only when the server sent one', () => {
  for (const bucket of ['tomorrow', 'week', 'later'] as const) {
    const html = chip('ar', { label: 'الأحد ١٥ تشرين الثاني', bucket, prepareLabel: 'السبت ١٤ تشرين الثاني' });
    assert.match(html, new RegExp(`data-order-day="${bucket}"`));
    assert.equal(text(html), 'التوصيل: الأحد ١٥ تشرين الثاني التجهيز: السبت ١٤ تشرين الثاني', bucket);
    assert.match(html, /data-order-prepare-day/);
  }
  assert.equal(
    text(chip('en', { label: 'Sunday 15 November', bucket: 'week', prepareLabel: 'Saturday 14 November' })),
    'Delivery: Sunday 15 November Prepare: Saturday 14 November'
  );
  assert.equal(text(chip('ckb', { label: 'یەکشەممە ١٥ تشرینی دووەم', bucket: 'later', prepareLabel: 'شەممە ١٤ تشرینی دووەم' })), 'گەیاندن: یەکشەممە ١٥ تشرینی دووەم ئامادەکردن: شەممە ١٤ تشرینی دووەم');
  // Our own same-day driver: one day, so the server sends no second one and nothing is drawn.
  assert.doesNotMatch(chip('ar', { label: 'غدًا', bucket: 'tomorrow', prepareLabel: '' }), /data-order-prepare-day/);
});

test('«متأخر» says which lateness it is: the packing, or the courier', () => {
  const shelf = chip('ar', { label: 'اليوم', bucket: 'overdue', prepareLabel: 'أمس' });
  assert.match(shelf, /data-order-overdue="prepare"/);
  assert.ok(shelf.includes(`title="${PREPARE_DAY_STRINGS.overduePrepare.ar}"`), shelf);
  const courier = chip('ar', { label: 'الأربعاء ١١ تشرين الثاني', bucket: 'overdue', handedOver: true });
  assert.match(courier, /data-order-overdue="courier"/);
  assert.ok(courier.includes(`title="${PREPARE_DAY_STRINGS.overdueCourier.ar}"`), courier);
  assert.ok(chip('en', { label: 'Today', bucket: 'overdue' }).includes(`title="${PREPARE_DAY_STRINGS.overduePrepare.en}"`));
  assert.ok(chip('ckb', { label: 'ئەمڕۆ', bucket: 'overdue', handedOver: true }).includes(`title="${PREPARE_DAY_STRINGS.overdueCourier.ckb}"`));
  assert.match(text(shelf), /متأخر/);
  assert.doesNotMatch(chip('ar', { label: 'غدًا', bucket: 'today' }), /data-order-overdue/);
});

function row(over: Partial<AdminOrderRow>): string {
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
    })
  );
}

test('the row hands the chip the server’s second day and the stage that picks the lateness', () => {
  const tomorrowWork = row({ due_bucket: 'tomorrow', due_label: 'السبت ١٤ تشرين الثاني', prepare_label: 'غدًا' });
  assert.match(text(tomorrowWork), /التوصيل: السبت ١٤ تشرين الثاني التجهيز: غدًا/);
  assert.match(row({ due_bucket: 'overdue', due_label: 'اليوم', stage: 'preparing' }), /data-order-overdue="prepare"/);
  assert.match(row({ due_bucket: 'overdue', due_label: 'أمس', stage: 'out_for_delivery', status: 'shipped' }), /data-order-overdue="courier"/);
});

test('the board says the rule once, under its header, on the live board only; the window shows both days from the server', () => {
  const board = read('src/components/adminOrders/OrdersBoard.tsx');
  assert.match(
    board,
    /\{!archive && \(\s*<p data-order-board-note className="[^"]*text-text-muted[^"]*">\s*\{dayLine\(loc, PREPARE_DAY_STRINGS\.boardNote\)\}/,
    'one muted line, never in the archive'
  );
  // The header words did not change: «اليوم / غدًا / هذا الأسبوع / لاحقًا / بلا موعد».
  for (const word of ["ar: 'اليوم'", "ar: 'غدًا'", "ar: 'هذا الأسبوع'", "ar: 'لاحقًا'", "ar: 'بلا موعد'"]) assert.ok(board.includes(word), word);

  const modal = read('src/components/adminOrders/OrderDetailModal.tsx');
  assert.match(modal, /api\.get<\{ order: EstimateOrderDetail \}>\(`\/api\/admin\/orders\/\$\{orderId\}\?lang=\$\{lang\}`\)/, 'the labels come in the reader’s language');
  assert.match(modal, /\}, \[orderId, lang\]\);/);
  assert.match(
    modal,
    /\{detail\.delivery_day_label \? \(\s*<p data-order-days[^>]*>\s*\{dayLine\(loc, PREPARE_DAY_STRINGS\.delivery, detail\.delivery_day_label\)\}\s*\{detail\.prepare_label \? \([\s\S]{0,200}dayLine\(loc, PREPARE_DAY_STRINGS\.prepare, detail\.prepare_label\)/
  );
});
