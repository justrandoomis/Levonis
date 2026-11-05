/**
 * WHEN A SALE ENDS, AS A CUSTOMER IS TOLD (worker/lib/offerEndText.ts, DECISIONS row 296): the window's end
 * in Baghdad time, a midnight end said as the last minute of the day before, in Arabic (the price feed's
 * «ينتهي العرض»), English and Sorani.
 *
 * Run: node --import tsx --test tests/offerEndText.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offerEndText } from '../worker/lib/offerEndText';
import { normalizeUtc } from '../worker/lib/offers';

test('the owner’s example: Black Friday ending Friday 27/11/2026 at 23:59 in Baghdad', () => {
  const end = '2026-11-27T20:59:00.000Z';
  assert.equal(offerEndText(end), 'الجمعة 27/11/2026 الساعة 11:59 مساءً');
  assert.equal(offerEndText(end, 'ar'), 'الجمعة 27/11/2026 الساعة 11:59 مساءً');
  assert.equal(offerEndText(end, 'en'), 'Friday 27/11/2026 at 11:59 PM');
  assert.equal(offerEndText(end, 'ckb'), 'هەینی 27/11/2026 کاتژمێر 11:59 د.ن');
  // Seconds are dropped, never rounded up into the next minute.
  assert.equal(offerEndText('2026-11-27T20:59:59.999Z'), 'الجمعة 27/11/2026 الساعة 11:59 مساءً');
});

test('a midnight end is the end of the day before — as the owner types it on the Baghdad clock, too', () => {
  // The owner ends the sale at «28/11/2026 00:00»: the admin form sends the naive Baghdad text, the door stores UTC.
  const stored = normalizeUtc('2026-11-28T00:00');
  assert.equal(stored, '2026-11-27T21:00:00.000Z');
  assert.equal(offerEndText(stored), 'الجمعة 27/11/2026 الساعة 11:59 مساءً');
  assert.equal(offerEndText(stored, 'en'), 'Friday 27/11/2026 at 11:59 PM');
  assert.equal(offerEndText(stored, 'ckb'), 'هەینی 27/11/2026 کاتژمێر 11:59 د.ن');
  assert.equal(offerEndText('2026-11-28T00:00:00+03:00'), 'الجمعة 27/11/2026 الساعة 11:59 مساءً');
  // Across a year: the first midnight of 2027 ends Thursday 31/12/2026.
  assert.equal(offerEndText('2026-12-31T21:00:00.000Z'), 'الخميس 31/12/2026 الساعة 11:59 مساءً');
  // Seconds into the midnight minute are still that minute (the admin form takes HH:MM:SS too): the day before.
  assert.equal(offerEndText('2026-11-27T21:00:30.000Z'), 'الجمعة 27/11/2026 الساعة 11:59 مساءً');
  assert.equal(offerEndText('2026-11-27T21:00:59.999Z'), 'الجمعة 27/11/2026 الساعة 11:59 مساءً');
  // A minute after midnight is the new day, at its own minute.
  assert.equal(offerEndText('2026-11-27T21:01:00.000Z'), 'السبت 28/11/2026 الساعة 12:01 صباحاً');
  assert.equal(offerEndText('2026-11-27T21:01:00.000Z', 'en'), 'Saturday 28/11/2026 at 12:01 AM');
  assert.equal(offerEndText('2026-11-27T21:01:00.000Z', 'ckb'), 'شەممە 28/11/2026 کاتژمێر 12:01 ب.ن');
});

test('Baghdad’s day and hour, never UTC’s: morning, noon, and an evening UTC still calls yesterday', () => {
  // 09:30 Baghdad on Tuesday 1 December.
  assert.equal(offerEndText('2026-12-01T06:30:00.000Z'), 'الثلاثاء 01/12/2026 الساعة 9:30 صباحاً');
  // Noon is after noon's hour: 12:00 PM.
  assert.equal(offerEndText('2026-12-01T09:00:00.000Z'), 'الثلاثاء 01/12/2026 الساعة 12:00 مساءً');
  assert.equal(offerEndText('2026-12-01T09:00:00.000Z', 'en'), 'Tuesday 01/12/2026 at 12:00 PM');
  // 22:30 UTC on Monday 30 November is 01:30 on Tuesday 1 December in Baghdad.
  assert.equal(offerEndText('2026-11-30T22:30:00.000Z'), 'الثلاثاء 01/12/2026 الساعة 1:30 صباحاً');
  // An instant written with its own offset reads the same.
  assert.equal(offerEndText('2026-12-01T01:30:00+03:00'), 'الثلاثاء 01/12/2026 الساعة 1:30 صباحاً');
});

test('a time without a zone is Baghdad’s clock — normalizeUtc’s own rule — never the host’s zone', () => {
  // A host far from Baghdad, where `Date.parse` alone would read these at the wrong hour — pinned here, so the
  // test proves the rule wherever it runs (on a +03:00 laptop a bare `Date.parse` would happen to agree).
  const before = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    assert.equal(offerEndText('2026-11-28T00:00'), 'الجمعة 27/11/2026 الساعة 11:59 مساءً');
    assert.equal(offerEndText('2026-11-28T00:00:00'), 'الجمعة 27/11/2026 الساعة 11:59 مساءً');
    assert.equal(offerEndText('2026-11-28 00:00'), 'الجمعة 27/11/2026 الساعة 11:59 مساءً');
    assert.equal(offerEndText('2026-11-28t00:00'), 'الجمعة 27/11/2026 الساعة 11:59 مساءً');
    assert.equal(offerEndText('2026-11-28T00:00:00.123456'), 'الجمعة 27/11/2026 الساعة 11:59 مساءً');
    assert.equal(offerEndText('2026-12-01T09:30'), 'الثلاثاء 01/12/2026 الساعة 9:30 صباحاً');
    assert.equal(offerEndText('2026-12-01T09:30:15.250', 'en'), 'Tuesday 01/12/2026 at 9:30 AM');
    // A bare date is not a time: no end, as the door stores none for it.
    assert.equal(offerEndText('2026-11-28'), '');
    assert.equal(normalizeUtc('2026-11-28'), null);
    // Each agrees with what the door stores for it.
    for (const naive of ['2026-11-28T00:00', '2026-11-28 00:00', '2026-11-28 00:00:00', '2026-11-28t00:00', '2026-11-28T00:00:00.123456', '2026-12-01T09:30', '2026-12-31T23:59:59']) {
      assert.equal(offerEndText(naive), offerEndText(normalizeUtc(naive)), naive);
    }
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
});

test('no end, no words: an open-ended sale or an unreadable instant is the empty string, never a throw', () => {
  for (const none of [null, undefined, '', '   ', 'soon', '2026-13-45T99:00:00Z']) assert.equal(offerEndText(none as string | null | undefined), '', String(none));
  assert.equal(offerEndText(null, 'en'), '');
  assert.equal(offerEndText(undefined, 'ckb'), '');
});
