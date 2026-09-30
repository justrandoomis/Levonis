/**
 * «مفتوح الآن؟» — worker/lib/storeHours.ts (merchant platform v2 §4.4).
 *
 * Pinned: the Baghdad clock (an instant at 22:00 UTC is 01:00 the next day
 * in Iraq), the boundaries (open at the opening minute, shut at the closing
 * one), overnight and all-day ranges, closed days beating «كل الأيام», the
 * day words in three scripts, unreadable rows skipped rather than guessed,
 * no hours = no claim, a vacation, and the client-side «has the change
 * passed» check the cached storefront relies on.
 *
 * Run: node --import tsx --test tests/storeHours.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baghdadDaysBetween, baghdadWeekday, nextChangePassed, openNow, parseDays } from '../worker/lib/storeHours';

/** A Baghdad wall-clock instant (UTC+3, no DST) as epoch ms. */
const baghdad = (day: string, time: string) => Date.parse(`${day}T${time}:00+03:00`);
const iso = (day: string, time: string) => new Date(baghdad(day, time)).toISOString();

// 2026-09-26 is a Saturday.
const SAT = '2026-09-26';
const SUN = '2026-09-27';
const THU = '2026-10-01';
const FRI = '2026-10-02';

const workWeek = [{ day: 'السبت - الخميس', open: '09:00', close: '21:00' }, { day: 'الجمعة', open: '', close: '', closed: true }];

test('day words: Arabic, English and Sorani, with articles, lists, ranges and «every day»', () => {
  assert.deepEqual(parseDays('السبت'), [6]);
  assert.deepEqual(parseDays('سبت'), [6]);
  assert.deepEqual(parseDays('يوم الجمعة'), [5]);
  assert.deepEqual(parseDays('Saturday'), [6]);
  assert.deepEqual(parseDays('sat'), [6]);
  assert.deepEqual(parseDays('شەممە'), [6]);
  assert.deepEqual(parseDays('هەینی'), [5]);
  assert.deepEqual(parseDays('یەکشەممە'), [0]);
  assert.deepEqual(parseDays('پێنجشەممە'), [4]);
  assert.deepEqual(parseDays('السبت - الخميس'), [6, 0, 1, 2, 3, 4], 'the settings preset: a range that wraps the week');
  assert.deepEqual(parseDays('Sat – Thu'), [6, 0, 1, 2, 3, 4]);
  assert.deepEqual(parseDays('شەممە تا پێنجشەممە'), [6, 0, 1, 2, 3, 4]);
  assert.deepEqual(parseDays('Monday to Wednesday'), [1, 2, 3]);
  assert.deepEqual(parseDays('السبت، الأحد'), [0, 6]);
  assert.deepEqual(parseDays('السبت والأحد'), [0, 6]);
  assert.deepEqual(parseDays('كل الأيام'), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(parseDays('Every day'), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(parseDays('هەموو ڕۆژێک'), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(parseDays('بعد الظهر'), [], 'prose is not a day');
  assert.deepEqual(parseDays(''), []);
  assert.deepEqual(parseDays(42), []);
});

test('open at the opening minute, shut at the closing minute; the next change is the other edge', () => {
  const hours = [{ day: 'كل الأيام', open: '09:00', close: '21:00' }];
  assert.deepEqual(openNow(hours, null, baghdad(SAT, '08:59')), { open_now: false, next_change_at: iso(SAT, '09:00') });
  assert.deepEqual(openNow(hours, null, baghdad(SAT, '09:00')), { open_now: true, next_change_at: iso(SAT, '21:00') });
  assert.deepEqual(openNow(hours, null, baghdad(SAT, '20:59')), { open_now: true, next_change_at: iso(SAT, '21:00') });
  assert.deepEqual(openNow(hours, null, baghdad(SAT, '21:00')), { open_now: false, next_change_at: iso(SUN, '09:00') });
});

test('the clock is Baghdad\'s: 22:00 UTC is 01:00 tomorrow in Iraq, and the weekday follows', () => {
  // Thursday 22:30 UTC = Friday 01:30 in Baghdad: the store is on its Friday, which is closed.
  const utcThursdayNight = Date.parse(`${THU}T22:30:00Z`);
  assert.equal(baghdadWeekday(utcThursdayNight), 5, 'Friday in Baghdad');
  const state = openNow(workWeek, null, utcThursdayNight);
  assert.equal(state.open_now, false);
  assert.equal(state.next_change_at, iso('2026-10-03', '09:00'), 'opens Saturday morning');
  // Two hours earlier it is still Thursday in Baghdad and the shop is inside its 09–21 day.
  assert.equal(openNow(workWeek, null, Date.parse(`${THU}T17:30:00Z`)).open_now, true);
  assert.equal(baghdadDaysBetween(utcThursdayNight, Date.parse(`2026-10-02T21:30:00Z`)), 1, 'Saturday 00:30 Baghdad is tomorrow');
  assert.equal(baghdadDaysBetween(baghdad(SAT, '10:00'), baghdad(SAT, '23:00')), 0);
});

test('a closed day wins over «كل الأيام», and a week that is all closed days has no opening to name', () => {
  const state = openNow(workWeek, null, baghdad(FRI, '12:00'));
  assert.deepEqual(state, { open_now: false, next_change_at: iso('2026-10-03', '09:00') });
  const everyDayButFriday = [{ day: 'Every day', open: '10:00', close: '18:00' }, { day: 'Friday', open: '', close: '', closed: true }];
  assert.equal(openNow(everyDayButFriday, null, baghdad(FRI, '12:00')).open_now, false, 'the specific word corrects the general one');
  assert.equal(openNow(everyDayButFriday, null, baghdad(SAT, '12:00')).open_now, true);
  const onlyClosedRows = [{ day: 'الجمعة', open: '', close: '', closed: true }];
  assert.deepEqual(openNow(onlyClosedRows, null, baghdad(SAT, '12:00')), { open_now: null, next_change_at: null }, 'closed days alone say nothing about opening');
});

test('overnight and all-day ranges run into the next day; adjacent rows merge into one stretch', () => {
  const night = [{ day: 'كل الأيام', open: '18:00', close: '02:00' }];
  assert.deepEqual(openNow(night, null, baghdad(SUN, '01:30')), { open_now: true, next_change_at: iso(SUN, '02:00') }, 'still Saturday\'s shift');
  assert.deepEqual(openNow(night, null, baghdad(SUN, '02:00')), { open_now: false, next_change_at: iso(SUN, '18:00') });
  assert.deepEqual(openNow(night, null, baghdad(SUN, '12:00')), { open_now: false, next_change_at: iso(SUN, '18:00') });
  const allDay = [{ day: 'كل الأيام', open: '00:00', close: '00:00' }];
  const always = openNow(allDay, null, baghdad(SUN, '12:00'));
  assert.equal(always.open_now, true);
  assert.equal(always.next_change_at, iso('2026-10-05', '00:00'), 'the stretch merges across the week it can see');
  const split = [{ day: 'السبت', open: '09:00', close: '13:00' }, { day: 'السبت', open: '13:00', close: '18:00' }];
  assert.deepEqual(openNow(split, null, baghdad(SAT, '12:59')), { open_now: true, next_change_at: iso(SAT, '18:00') }, 'no false «closes 13:00»');
  const gap = [{ day: 'السبت', open: '09:00', close: '13:00' }, { day: 'السبت', open: '16:00', close: '20:00' }];
  assert.deepEqual(openNow(gap, null, baghdad(SAT, '14:00')), { open_now: false, next_change_at: iso(SAT, '16:00') });
  assert.equal(openNow([{ day: 'السبت', open: '09:00', close: '24:00' }], null, baghdad(SAT, '23:59')).open_now, true);
});

test('no hours, prose, a row without times or with a typo for a day: no claim, never «closed»', () => {
  assert.deepEqual(openNow([], null, baghdad(SAT, '12:00')), { open_now: null, next_change_at: null });
  assert.deepEqual(openNow('nonsense', null, baghdad(SAT, '12:00')), { open_now: null, next_change_at: null });
  assert.deepEqual(openNow(null, null, baghdad(SAT, '12:00')), { open_now: null, next_change_at: null });
  assert.deepEqual(openNow([{ day: 'حسب الاتفاق', open: '', close: '' }], null, baghdad(SAT, '12:00')), { open_now: null, next_change_at: null });
  assert.deepEqual(openNow([{ day: 'السبت', open: 'صباحًا', close: 'مساءً' }], null, baghdad(SAT, '12:00')), { open_now: null, next_change_at: null });
  assert.deepEqual(openNow([{ day: 'السبت', open: '25:00', close: '26:00' }], null, baghdad(SAT, '12:00')), { open_now: null, next_change_at: null });
  // A misspelt day is skipped; the readable rows still answer.
  const typo = [{ day: 'السبتت', open: '09:00', close: '21:00' }, { day: 'الأحد', open: '09:00', close: '21:00' }];
  assert.deepEqual(openNow(typo, null, baghdad(SAT, '12:00')), { open_now: false, next_change_at: iso(SUN, '09:00') });
  assert.deepEqual(openNow(workWeek, null, Number.NaN), { open_now: null, next_change_at: null });
});

test('away: shut until the vacation ends, then the hours decide the next change', () => {
  const back = iso('2026-10-05', '00:00'); // a Monday
  const during = openNow(workWeek, back, baghdad(SAT, '12:00'));
  assert.equal(during.open_now, false);
  assert.equal(during.next_change_at, iso('2026-10-05', '09:00'), 'shut at midnight by the hours: the first opening after the vacation');
  const backInside = openNow([{ day: 'كل الأيام', open: '00:00', close: '00:00' }], back, baghdad(SAT, '12:00'));
  assert.deepEqual(backInside, { open_now: false, next_change_at: back }, 'an all-day shop reopens the moment the vacation ends');
  // A vacation that is over is not a vacation.
  assert.equal(openNow(workWeek, iso(SAT, '08:00'), baghdad(SAT, '12:00')).open_now, true);
  assert.equal(openNow(workWeek, 'garbage', baghdad(SAT, '12:00')).open_now, true);
});

test('nextChangePassed: the cached body is stale once the server\'s instant has gone by', () => {
  const state = openNow(workWeek, null, baghdad(SAT, '20:59'));
  assert.equal(nextChangePassed(state, baghdad(SAT, '20:59')), false);
  assert.equal(nextChangePassed(state, baghdad(SAT, '21:00')), true);
  assert.equal(nextChangePassed({ next_change_at: null }, baghdad(SAT, '21:00')), false);
  assert.equal(nextChangePassed(null, baghdad(SAT, '21:00')), false);
  // The client re-derives with the same function and gets the flipped word.
  assert.equal(openNow(workWeek, null, baghdad(SAT, '21:00')).open_now, false);
});
