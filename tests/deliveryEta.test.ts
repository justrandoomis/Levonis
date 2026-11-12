/**
 * «كل الطلبات تُجهَّز وتُسلَّم لمندوب شركة التوصيل الساعة ٧ مساءً» — THE CHECKOUT
 * NOTE'S CLOCK, TIERS AND WORDS (owner, 2026-11-11; DECISIONS row 324).
 *
 * Pure: every clock is an argument, pinned at the instants where the answer
 * flips — 18:59 / 19:00 / 19:01 Baghdad, and 20:59Z / 21:00Z, where the UTC
 * day and the Baghdad day disagree. Then the owner's own examples, the
 * approved tier table (Muthanna FAR), an override, a missing governorate, the
 * off switch, the clamp, the strict PUT check, the three languages under the
 * Sorani rules (DECISIONS row 183) — and the owner's «only add the note»: the
 * delivery-day picker offers exactly what it did, and the server's checks are
 * the same code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/d1';
import { addDays } from '../worker/lib/baghdadTime';
import { DEFAULT_DELIVERY_DAY_POLICY, dayLabel, deliveryWindow } from '../worker/lib/deliveryDay';
import {
  DEFAULT_DELIVERY_HANDOVER,
  DEFAULT_ETA_TIERS,
  ETA_TEXT,
  ETA_WINDOWS,
  HANDOVER_ADMIN_TEXT,
  HANDOVER_REFUSALS,
  HANDOVER_HOURS,
  PREP_LEAD_DAYS,
  deliveryEta,
  etaArrivalLine,
  etaDetails,
  etaHandoverKind,
  etaHandoverLine,
  handoverAdminView,
  hourWords,
  leavesWithCourier,
  nextHandover,
  resolveDeliveryHandover,
  tierOf,
  tierOptionWords,
  validateDeliveryHandover,
  windowWords,
  type DeliveryHandoverPolicy,
} from '../worker/lib/deliveryEta';
import { IRAQ_GOVERNORATES } from '../packages/shipping/src/iraqGovernorates';
import { PUBLIC_SETTING_KEYS, SETTING_DEFAULTS } from '../worker/lib/settings';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const P: DeliveryHandoverPolicy = resolveDeliveryHandover(undefined);
/** Baghdad wall-clock → epoch ms. Iraq is UTC+3 all year. */
const baghdad = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00.000+03:00`);
const eta = (nowMs: number, governorate: unknown, policy = P, day?: string | null) => {
  const e = deliveryEta({ nowMs, governorate, policy, day });
  assert.ok(e, 'the note is on');
  return e;
};

// =========================================================================
// THE HANDOVER: before the hour → today, from the hour on → tomorrow
// =========================================================================

test('18:59 Baghdad hands over today at 19:00 (16:00Z); 19:00 and 19:01 hand over tomorrow', () => {
  const before = nextHandover(baghdad('2026-11-11', '18:59'), P)!;
  assert.deepEqual(
    { day: before.day, is_today: before.is_today, cutoff_passed: before.cutoff_passed },
    { day: '2026-11-11', is_today: true, cutoff_passed: false }
  );
  assert.equal(new Date(before.at_ms).toISOString(), '2026-11-11T16:00:00.000Z', '19:00 Baghdad is 16:00 UTC');
  for (const hhmm of ['19:00', '19:01', '23:59']) {
    const h = nextHandover(baghdad('2026-11-11', hhmm), P)!;
    assert.deepEqual({ day: h.day, is_today: h.is_today, cutoff_passed: h.cutoff_passed }, { day: '2026-11-12', is_today: false, cutoff_passed: true }, hhmm);
    assert.equal(new Date(h.at_ms).toISOString(), '2026-11-12T16:00:00.000Z', hhmm);
  }
  // The sentence turns at the hour, and the page re-renders then: one timeout at the handover.
  assert.equal(new Date(eta(baghdad('2026-11-11', '18:59'), 'baghdad').next_change_ms).toISOString(), '2026-11-11T16:00:00.000Z');
});

test('across the UTC day boundary: 20:59Z is 23:59 of the 11th in Baghdad, 21:00Z is midnight of the 12th', () => {
  const late = eta(Date.parse('2026-11-11T20:59:00.000Z'), 'baghdad');
  assert.equal(late.handover.today, '2026-11-11', 'still the 11th in Baghdad although… it is too');
  assert.equal(late.handover.day, '2026-11-12', 'the hour has passed: tomorrow');
  assert.equal(late.handover.cutoff_passed, true);
  assert.equal(late.arrival_day, '2026-11-13');
  // After the hour the next change is Baghdad's midnight, when «tomorrow» becomes «today».
  assert.equal(new Date(late.next_change_ms).toISOString(), '2026-11-11T21:00:00.000Z');

  const midnight = eta(Date.parse('2026-11-11T21:00:00.000Z'), 'baghdad');
  assert.equal(midnight.handover.today, '2026-11-12', '21:00Z is 00:00 on the 12th in Baghdad, while UTC still says the 11th');
  assert.equal(midnight.handover.day, '2026-11-12');
  assert.equal(midnight.handover.is_today, true, 'a new Baghdad day, before its hour: today');
  assert.equal(midnight.handover.cutoff_passed, false);
  assert.equal(midnight.arrival_day, '2026-11-13', 'the same arrival as one minute earlier — only the words change');
  assert.equal(etaHandoverLine(late, 'ar'), 'فات تسليم اليوم (الساعة ٧ مساءً)، فيُسلَّم طلبك لمندوب شركة التوصيل غدًا الساعة ٧ مساءً.');
  assert.equal(etaHandoverLine(midnight, 'ar'), 'أتمم طلبك قبل الساعة ٧ مساءً ليُسلَّم لمندوب شركة التوصيل اليوم.');
});

// =========================================================================
// THE OWNER'S EXAMPLES, EACH TIER, AN OVERRIDE
// =========================================================================

test('the owner-approved table: near, far, Kurdistan — Muthanna is FAR — covering exactly the eighteen governorates', () => {
  assert.deepEqual(Object.keys(DEFAULT_ETA_TIERS).sort(), IRAQ_GOVERNORATES.map((g) => g.id).sort());
  const of = (tier: string) => Object.entries(DEFAULT_ETA_TIERS).filter(([, t]) => t === tier).map(([id]) => id).sort();
  assert.deepEqual(of('near'), ['anbar', 'babil', 'baghdad', 'diyala', 'karbala', 'najaf', 'qadisiyyah', 'wasit']);
  assert.deepEqual(of('far'), ['basra', 'dhi_qar', 'kirkuk', 'maysan', 'muthanna', 'nineveh', 'salahuddin']);
  assert.deepEqual(of('kurdistan'), ['duhok', 'erbil', 'sulaymaniyah']);
  // The windows in the owner's hours: next day 10–15, next day 18–20, the day after next at night, maybe later.
  assert.deepEqual(ETA_WINDOWS.near, { days: 1, from_hour: 10, to_hour: 15, maybe_later: false });
  assert.deepEqual(ETA_WINDOWS.far, { days: 1, from_hour: 18, to_hour: 20, maybe_later: false });
  assert.deepEqual(ETA_WINDOWS.kurdistan, { days: 2, from_hour: null, to_hour: null, maybe_later: true });
});

test('Baghdad: an order at 1 pm arrives the next day 10 am – 3 pm; one at 7:30 pm a full day later', () => {
  const a = eta(baghdad('2026-11-11', '13:00'), 'baghdad');
  assert.equal(a.tier, 'near');
  assert.equal(a.arrival_day, '2026-11-12');
  assert.equal(etaArrivalLine(a, 'ar'), 'الوصول المتوقع إلى بغداد: غدًا بين ١٠ صباحًا و٣ عصرًا (تقديري).');
  assert.equal(etaArrivalLine(a, 'en'), 'Expected in Baghdad: tomorrow, between 10 am and 3 pm (estimate).');
  assert.equal(etaArrivalLine(a, 'ckb'), 'گەیشتنی چاوەڕوانکراو بۆ بەغدا: بەیانی لە نێوان کاتژمێر ١٠ی پێش نیوەڕۆ و ٣ی دوای نیوەڕۆ (خەمڵێنراو).');
  assert.equal(etaHandoverLine(a, 'en'), "Place your order before 7 pm and it goes to the delivery company's courier today.");

  const b = eta(baghdad('2026-11-11', '19:30'), 'baghdad');
  assert.equal(b.arrival_day, '2026-11-13', '«order B at 7:30 pm adds 24 hrs»');
  assert.equal(etaArrivalLine(b, 'ar'), 'الوصول المتوقع إلى بغداد: الجمعة ١٣ تشرين الثاني بين ١٠ صباحًا و٣ عصرًا (تقديري).');
  assert.equal(etaHandoverLine(b, 'en'), "Today's 7 pm handover has passed, so your order goes to the delivery company's courier tomorrow at 7 pm.");
  assert.equal(etaHandoverLine(b, 'ckb'), 'کاتی ڕادەستکردنی ئەمڕۆ (کاتژمێر ٧ی ئێوارە) تێپەڕیوە، بۆیە داواکارییەکەت بەیانی کاتژمێر ٧ی ئێوارە ڕادەستی گەیێنەری کۆمپانیای گەیاندن دەکرێت.');
});

test('Basra (far): the next evening between 6 and 8 pm; Erbil (Kurdistan): the day after next at night, maybe later', () => {
  const basra = eta(baghdad('2026-11-11', '13:00'), 'basra');
  assert.equal(basra.tier, 'far');
  assert.equal(basra.arrival_day, '2026-11-12');
  assert.equal(etaArrivalLine(basra, 'ar'), 'الوصول المتوقع إلى البصرة: غدًا بين ٦ و٨ مساءً (تقديري).');
  assert.equal(etaArrivalLine(basra, 'en'), 'Expected in Basra: tomorrow, between 6 and 8 pm (estimate).');
  assert.equal(etaArrivalLine(basra, 'ckb'), 'گەیشتنی چاوەڕوانکراو بۆ بەسرە: بەیانی لە نێوان کاتژمێر ٦ و ٨ی ئێوارە (خەمڵێنراو).');

  const erbil = eta(baghdad('2026-11-11', '13:00'), 'erbil');
  assert.equal(erbil.tier, 'kurdistan');
  assert.equal(erbil.arrival_day, '2026-11-13', 'handed over today, the night of the day after next');
  assert.equal(etaArrivalLine(erbil, 'ar'), 'الوصول المتوقع إلى أربيل: الجمعة ١٣ تشرين الثاني ليلًا، وقد تؤخّره نقاط التفتيش أكثر (تقديري).');
  assert.equal(etaArrivalLine(erbil, 'en'), 'Expected in Erbil: Friday 13 November, at night — checkpoints can delay it further (estimate).');
  assert.equal(etaArrivalLine(erbil, 'ckb'), 'گەیشتنی چاوەڕوانکراو بۆ هەولێر: هەینی ١٣ تشرینی دووەم بە شەو، و لەوانەیە خاڵەکانی پشکنین زیاتر دوای بخەن (خەمڵێنراو).');
  assert.equal(eta(baghdad('2026-11-11', '20:00'), 'erbil').arrival_day, '2026-11-14', 'after the hour, a day later');
  // Muthanna is far, as approved (the scout's draft had it near).
  assert.equal(eta(baghdad('2026-11-11', '13:00'), 'muthanna').tier, 'far');
});

test('an override in «إدارة التوصيل» moves one governorate and nothing else; a name reads as its id', () => {
  const moved = resolveDeliveryHandover({ tiers: { muthanna: 'near', Erbil: 'far' } });
  assert.deepEqual(moved.tiers, { muthanna: 'near', erbil: 'far' });
  assert.equal(tierOf('muthanna', moved), 'near');
  assert.equal(tierOf('erbil', moved), 'far');
  assert.equal(tierOf('duhok', moved), 'kurdistan', 'the rest of the table stands');
  const e = eta(baghdad('2026-11-11', '13:00'), 'erbil', moved);
  assert.equal(e.arrival_day, '2026-11-12', 'Erbil moved to far: the next day');
  assert.equal(etaArrivalLine(e, 'en'), 'Expected in Erbil: tomorrow, between 6 and 8 pm (estimate).');
  // The long version lists Erbil with the far governorates now.
  const far = etaDetails(moved, 'en').lines.find((l) => l.startsWith('Far governorates'))!;
  assert.match(far, /Erbil/);
  assert.match(etaDetails(moved, 'en').lines.find((l) => l.startsWith('Governorates near'))!, /Muthanna/);
});

test('an address with no governorate (saved before migration 0026) gets the generic sentence in three languages', () => {
  for (const governorate of ['', null, undefined, 'atlantis']) {
    const e = eta(baghdad('2026-11-11', '13:00'), governorate);
    assert.equal(e.tier, null);
    assert.equal(e.arrival_day, '');
    for (const lang of ['ar', 'en', 'ckb'] as const) assert.equal(etaArrivalLine(e, lang), ETA_TEXT[lang].generic);
  }
  // The handover line still says the hour: it does not depend on the governorate.
  assert.equal(etaHandoverLine(eta(baghdad('2026-11-11', '13:00'), ''), 'ar'), 'أتمم طلبك قبل الساعة ٧ مساءً ليُسلَّم لمندوب شركة التوصيل اليوم.');
});

test('the owner switches the note off: no estimate at all', () => {
  const off = resolveDeliveryHandover({ enabled: false });
  assert.equal(deliveryEta({ nowMs: baghdad('2026-11-11', '13:00'), governorate: 'baghdad', policy: off }), null);
});

test('a closed weekday (supported, empty by default): Thursday 20:30 and Friday morning both hand over on Saturday', () => {
  assert.deepEqual(DEFAULT_DELIVERY_HANDOVER.closed_weekdays, [], 'the courier comes «كل يوم»');
  const fridays = resolveDeliveryHandover({ closed_weekdays: [5] });
  const thu = eta(baghdad('2026-11-12', '20:30'), 'baghdad', fridays);
  assert.equal(thu.handover.day, '2026-11-14');
  assert.equal(thu.arrival_day, '2026-11-15');
  assert.equal(etaHandoverLine(thu, 'ar'), 'فات تسليم اليوم (الساعة ٧ مساءً)، فيُسلَّم طلبك لمندوب شركة التوصيل السبت ١٤ تشرين الثاني الساعة ٧ مساءً.');
  const fri = eta(baghdad('2026-11-13', '11:00'), 'baghdad', fridays);
  assert.equal(fri.handover.day, '2026-11-14');
  assert.equal(fri.handover.cutoff_passed, false, 'not passed — closed');
  assert.equal(etaHandoverLine(fri, 'en'), "There is no courier handover today, so your order goes to the delivery company's courier tomorrow at 7 pm.");
  assert.equal(etaDetails(fridays, 'en').lines[0], "We prepare every order and hand it to the delivery company's courier at 7 pm every day except Friday.");
});

test('a closed weekday has no hour to pass: Friday 20:00 still says «no handover today», and its next change is midnight (the review)', () => {
  const fridays = resolveDeliveryHandover({ closed_weekdays: [5] });
  for (const hhmm of ['00:30', '11:00', '18:59', '19:00', '20:00', '23:59']) {
    const fri = eta(baghdad('2026-11-13', hhmm), 'baghdad', fridays);
    assert.equal(fri.handover.today_closed, true, hhmm);
    assert.equal(fri.handover.cutoff_passed, false, `${hhmm}: there was no handover today to pass`);
    assert.equal(fri.handover.day, '2026-11-14', hhmm);
    assert.equal(etaHandoverKind(fri), 'closed', hhmm);
    assert.equal(etaHandoverLine(fri, 'ar'), 'لا تسليم لشركة التوصيل اليوم، فيُسلَّم طلبك لمندوبها غدًا الساعة ٧ مساءً.', hhmm);
    // The page's timer wakes at midnight on a closed day; nothing is due to change at 19:00 any more.
    assert.equal(new Date(fri.next_change_ms).toISOString(), '2026-11-13T21:00:00.000Z', hhmm);
  }
  // The day before a closed day, after the hour, its own handover did pass: «فات» is true there.
  const thu = eta(baghdad('2026-11-12', '20:00'), 'baghdad', fridays);
  assert.equal(etaHandoverKind(thu), 'passed');
  assert.equal(thu.handover.today_closed, false);
});

test('the long version: the rule, the cutoff, the three groups as the table stands, the Baghdad example, the estimate', () => {
  const ar = etaDetails(P, 'ar');
  assert.equal(ar.title, 'متى يصل طلبك؟');
  assert.deepEqual(ar.lines, [
    'نجهّز كل الطلبات ونسلّمها لمندوب شركة التوصيل يوميًا الساعة ٧ مساءً.',
    'اطلب قبل الساعة ٧ مساءً ليُسلَّم طلبك في اليوم نفسه. الطلب بعد الساعة ٧ مساءً يُسلَّم في اليوم التالي، فيتأخر وصوله يومًا كاملًا (٢٤ ساعة).',
    'المحافظات القريبة من مخزننا في الحلة (بابل): بغداد، ديالى، الأنبار، بابل، كربلاء، النجف، واسط، القادسية — في اليوم التالي للتسليم بين ١٠ صباحًا و٣ عصرًا، أي بعد نحو ١٧ ساعة من التسليم.',
    'المحافظات البعيدة: البصرة، نينوى، كركوك، ميسان، ذي قار، المثنى، صلاح الدين — في اليوم التالي للتسليم بين ٦ و٨ مساءً.',
    'إقليم كردستان: أربيل، السليمانية، دهوك — بعد يومين من التسليم ليلًا، وقد يتأخر أكثر من ٤٨ ساعة لأن نقاط التفتيش صعبة جدًا.',
    'مثال من بغداد: الطلب الساعة ١ ظهرًا يصل في اليوم التالي قرابة ١١ صباحًا (بين ١٠ صباحًا و٣ عصرًا)، والطلب الساعة ٧:٣٠ مساءً يتأخر وصوله يومًا كاملًا.',
    'كل هذه الأوقات تقديرية، وليست موعدًا ملزمًا.',
  ]);
  const en = etaDetails(P, 'en').lines;
  assert.equal(en[5], 'Example from Baghdad: an order placed at 1 pm arrives the next day around 11 am (between 10 am and 3 pm); one placed at 7:30 pm arrives a full day later.');
  // The example follows the hour, and leaves when it would no longer be true.
  assert.match(etaDetails(resolveDeliveryHandover({ hour: 18 }), 'en').lines.join(' '), /one placed at 6:30 pm/);
  assert.equal(etaDetails(resolveDeliveryHandover({ hour: 12 }), 'en').lines.some((l) => l.startsWith('Example')), false, '1 pm is after a noon handover');
  assert.equal(etaDetails(resolveDeliveryHandover({ tiers: { baghdad: 'far' } }), 'en').lines.some((l) => l.startsWith('Example')), false, 'Baghdad moved off near');
  // A group the owner emptied is left out rather than printed with no names.
  const noKurdistan = resolveDeliveryHandover({ tiers: { erbil: 'far', sulaymaniyah: 'far', duhok: 'far' } });
  assert.equal(etaDetails(noKurdistan, 'en').lines.some((l) => l.startsWith('Kurdistan Region')), false);
  // «+17 hrs» is the owner's figure for 7 pm (to about noon the next day): at any other hour it is not said.
  for (const hour of [12, 18, 20, 23]) {
    const near = etaDetails(resolveDeliveryHandover({ hour }), 'en').lines.find((l) => l.startsWith('Governorates near'))!;
    assert.match(near, /— the day after handover, between 10 am and 3 pm\.$/, `hour ${hour}`);
    assert.doesNotMatch(near, /17 hours/, `hour ${hour}`);
    for (const lang of ['ar', 'ckb'] as const) assert.doesNotMatch(etaDetails(resolveDeliveryHandover({ hour }), lang).lines.join(' '), /١٧/, `${lang} hour ${hour}`);
  }
  assert.match(etaDetails(P, 'en').lines.join(' '), /about 17 hours after it\./);
});

// =========================================================================
// THE PICKED DAY: the note words the order being placed (the review)
// =========================================================================

test('a later day picked: the evening before it is the handover (the board’s day), and the picked day is the arrival', () => {
  assert.equal(PREP_LEAD_DAYS, 1, 'the owner’s «1 day everywhere»');
  // Wed 11-11 13:00, Baghdad, «الأحد ١٥ تشرين الثاني» picked under the note.
  const e = eta(baghdad('2026-11-11', '13:00'), 'baghdad', P, '2026-11-15');
  assert.equal(e.requested_day, '2026-11-15');
  assert.equal(e.send_day, '2026-11-14', 'prepared and handed over the day before, as the board files it');
  assert.equal(e.arrival_day, '2026-11-15');
  assert.equal(e.after_requested, false);
  assert.equal(etaHandoverKind(e), 'day');
  assert.equal(etaHandoverLine(e, 'ar'), 'نجهّز طلبك لليوم الذي اخترته، ونسلّمه لمندوب شركة التوصيل السبت ١٤ تشرين الثاني الساعة ٧ مساءً.');
  assert.equal(etaHandoverLine(e, 'en'), "We prepare your order for the day you chose. Handover to the delivery company's courier: Saturday 14 November, 7 pm.");
  assert.equal(etaHandoverLine(e, 'ckb'), 'داواکارییەکەت بۆ ئەو ڕۆژەی هەڵتبژاردووە ئامادە دەکەین، و شەممە ١٤ تشرینی دووەم کاتژمێر ٧ی ئێوارە ڕادەستی گەیێنەری کۆمپانیای گەیاندنی دەکەین.');
  assert.equal(etaArrivalLine(e, 'ar'), 'الوصول المتوقع إلى بغداد: الأحد ١٥ تشرين الثاني بين ١٠ صباحًا و٣ عصرًا (تقديري).');
  assert.equal(etaArrivalLine(e, 'en'), 'Expected in Baghdad: Sunday 15 November, between 10 am and 3 pm (estimate).');
  // Not «اليوم» and not «غدًا»: the two sentences the review found under a picked Sunday.
  assert.doesNotMatch(etaHandoverLine(e, 'ar'), /اليوم\./);
  assert.doesNotMatch(etaArrivalLine(e, 'ar'), /غدًا/);
  // Two days ahead: the handover is tomorrow, said as such.
  assert.equal(etaHandoverLine(eta(baghdad('2026-11-11', '13:00'), 'basra', P, '2026-11-13'), 'en'), "We prepare your order for the day you chose. Handover to the delivery company's courier: tomorrow, 7 pm.");
});

test('a picked day no later than the next handover allows goes with it; one the estimate cannot meet is said to be later', () => {
  // Before 7 pm, «غدًا» picked: tonight's handover, arriving the picked day — the same words as «في أقرب وقت».
  const tomorrow = eta(baghdad('2026-11-11', '13:00'), 'baghdad', P, '2026-11-12');
  const asap = eta(baghdad('2026-11-11', '13:00'), 'baghdad');
  assert.equal(tomorrow.send_day, '2026-11-11');
  assert.equal(etaHandoverKind(tomorrow), 'today');
  assert.equal(etaHandoverLine(tomorrow, 'ar'), etaHandoverLine(asap, 'ar'));
  assert.equal(etaArrivalLine(tomorrow, 'ar'), etaArrivalLine(asap, 'ar'));
  // 8 pm, «اليوم» or «غدًا» picked (the picker still offers both — the owner's «only add the note»):
  // tomorrow's handover, Friday's arrival, and the note says that is after the picked day.
  for (const picked of ['2026-11-11', '2026-11-12']) {
    const late = eta(baghdad('2026-11-11', '20:00'), 'baghdad', P, picked);
    assert.equal(late.send_day, '2026-11-12', picked);
    assert.equal(late.arrival_day, '2026-11-13', picked);
    assert.equal(late.after_requested, true, picked);
    assert.equal(etaHandoverKind(late), 'passed', picked);
    assert.equal(etaArrivalLine(late, 'ar'), 'الوصول المتوقع إلى بغداد: الجمعة ١٣ تشرين الثاني بين ١٠ صباحًا و٣ عصرًا (تقديري) — بعد اليوم الذي اخترته.', picked);
    assert.equal(etaArrivalLine(late, 'en'), 'Expected in Baghdad: Friday 13 November, between 10 am and 3 pm (estimate) — later than the day you chose.', picked);
    assert.equal(etaArrivalLine(late, 'ckb'), 'گەیشتنی چاوەڕوانکراو بۆ بەغدا: هەینی ١٣ تشرینی دووەم لە نێوان کاتژمێر ١٠ی پێش نیوەڕۆ و ٣ی دوای نیوەڕۆ (خەمڵێنراو) — دوای ئەو ڕۆژەی هەڵتبژاردووە.', picked);
  }
  // Nothing picked, or something that is not a day: as soon as possible, exactly as before.
  for (const none of [null, '', 'soon', '2026-13-40']) {
    const e = deliveryEta({ nowMs: baghdad('2026-11-11', '13:00'), governorate: 'baghdad', policy: P, day: none })!;
    assert.equal(e.requested_day, '', String(none));
    assert.equal(e.send_day, e.handover.day, String(none));
    assert.equal(e.after_requested, false, String(none));
  }
  // The picked day's words change at the same instants as the rest of the note.
  assert.equal(eta(baghdad('2026-11-11', '13:00'), 'baghdad', P, '2026-11-15').next_change_ms, asap.next_change_ms);
});

test('Kurdistan with a day picked: handed over the evening before, so by the owner’s two-day road it lands after the picked day — said, not hidden', () => {
  const e = eta(baghdad('2026-11-11', '13:00'), 'erbil', P, '2026-11-15');
  assert.equal(e.send_day, '2026-11-14');
  assert.equal(e.arrival_day, '2026-11-16');
  assert.equal(e.after_requested, true);
  assert.equal(etaArrivalLine(e, 'ar'), 'الوصول المتوقع إلى أربيل: الاثنين ١٦ تشرين الثاني ليلًا، وقد تؤخّره نقاط التفتيش أكثر (تقديري) — بعد اليوم الذي اخترته.');
  // A governorate the owner moved to far keeps the picked day.
  const moved = eta(baghdad('2026-11-11', '13:00'), 'erbil', resolveDeliveryHandover({ tiers: { erbil: 'far' } }), '2026-11-15');
  assert.equal(moved.arrival_day, '2026-11-15');
  assert.equal(moved.after_requested, false);
  // An address with no governorate: the picked day's handover, then the generic sentence.
  const none = eta(baghdad('2026-11-11', '13:00'), '', P, '2026-11-15');
  assert.equal(etaHandoverKind(none), 'day');
  assert.equal(etaArrivalLine(none, 'en'), ETA_TEXT.en.generic);
});

test('a closed weekday the evening before the picked day moves the handover on, and the note says the estimate is later', () => {
  const fridays = resolveDeliveryHandover({ closed_weekdays: [5] });
  // Wed 11-11, Saturday 14 picked: Friday's evening is closed, so Saturday's handover, Sunday's arrival.
  const e = eta(baghdad('2026-11-11', '13:00'), 'baghdad', fridays, '2026-11-14');
  assert.equal(e.send_day, '2026-11-14');
  assert.equal(e.arrival_day, '2026-11-15');
  assert.equal(e.after_requested, true);
});

test('paid through Gini: no «before 7 pm, today» — the order waits for its receipt barcode, then the next handover', () => {
  const e = eta(baghdad('2026-11-11', '15:00'), 'baghdad');
  assert.equal(etaHandoverKind(e, { gini: true }), 'gini');
  assert.equal(etaHandoverLine(e, 'ar', { gini: true }), 'بعد تأكيد شرائه من تطبيق جني ومسح باركود الاستلام، يُسلَّم طلبك لمندوب شركة التوصيل في أقرب تسليم الساعة ٧ مساءً.');
  assert.equal(
    etaHandoverLine(e, 'en', { gini: true }),
    "Once the purchase is confirmed in the Gini app and the receipt barcode is scanned, your order goes to the delivery company's courier at the next 7 pm handover."
  );
  assert.equal(
    etaHandoverLine(e, 'ckb', { gini: true }),
    'دوای پشتڕاستکردنەوەی کڕینەکەی لە ئەپی جینی و سکانکردنی باڕکۆدی وەرگرتن، داواکارییەکەت لە نزیکترین ڕادەستکردندا کاتژمێر ٧ی ئێوارە ڕادەستی گەیێنەری کۆمپانیای گەیاندن دەکرێت.'
  );
  // The arrival stays, marked as the estimate it is.
  assert.match(etaArrivalLine(e, 'ar'), /\(تقديري\)\.$/);
  // Any other payment, the hour's own line; a later picked day, the picked day's line (confirmed or cancelled by then).
  assert.equal(etaHandoverKind(e), 'today');
  assert.equal(etaHandoverKind(eta(baghdad('2026-11-11', '15:00'), 'baghdad', P, '2026-11-15'), { gini: true }), 'day');
});

// =========================================================================
// THE CLAMP (read) AND THE STRICT CHECK (the admin PUT)
// =========================================================================

test('the resolver clamps whatever a row holds into a usable policy', () => {
  for (const junk of [undefined, null, 'x', 7, [], [1, 2]]) assert.deepEqual(resolveDeliveryHandover(junk), DEFAULT_DELIVERY_HANDOVER, String(junk));
  const hour = (v: unknown) => resolveDeliveryHandover({ hour: v }).hour;
  assert.deepEqual(HANDOVER_HOURS, { min: 12, max: 23 }, 'noon to 11 pm: the hours the evening windows hold for');
  // Outside the hours the fixed windows were written for: the owner's 7 pm, not the nearest end (the review).
  for (const outside of [25, 24, -3, 0, 5, 11, 11.4]) assert.equal(hour(outside), 19, String(outside));
  assert.equal(hour(12), 12);
  assert.equal(hour(23), 23);
  assert.equal(hour('18'), 18, 'a settings row is text');
  assert.equal(hour(18.6), 19);
  assert.equal(hour('abc'), 19, 'unreadable keeps the owner’s 7 pm');
  assert.equal(hour(''), 19);
  // Hour 0 used to run as «فات تسليم اليوم (الساعة ١٢ ليلًا)» all day long; read as 7 pm it is the owner's line at 13:00.
  assert.equal(etaHandoverKind(eta(baghdad('2026-11-11', '13:00'), 'baghdad', resolveDeliveryHandover({ hour: 0 }))), 'today');
  assert.equal(resolveDeliveryHandover({ enabled: false }).enabled, false);
  assert.equal(resolveDeliveryHandover({ enabled: 'yes' }).enabled, true, 'junk keeps the default');
  assert.deepEqual(
    resolveDeliveryHandover({ tiers: { baghdad: 'near', atlantis: 'far', basra: 'mars', najaf: 'kurdistan' } }).tiers,
    { najaf: 'kurdistan' },
    'unknown governorates, unknown tiers and entries equal to the table are dropped'
  );
  assert.deepEqual(resolveDeliveryHandover({ closed_weekdays: [5, 5, 9, -1, 'x', 2.5, 0] }).closed_weekdays, [0, 5]);
  // Seven closed days would mean no handover ever: six at most, so the walk always ends.
  const all = resolveDeliveryHandover({ closed_weekdays: [0, 1, 2, 3, 4, 5, 6] });
  assert.equal(all.closed_weekdays.length, 6);
  assert.equal(nextHandover(baghdad('2026-11-11', '13:00'), all)!.day, '2026-11-14', 'the one open weekday, Saturday');
});

test('the admin PUT refuses junk in three languages and stores only the canonical form', () => {
  const refused = (value: unknown, field: string) => {
    const r = validateDeliveryHandover(value);
    assert.equal(r.ok, false, JSON.stringify(value));
    if (r.ok) return;
    assert.equal(r.error.field, field, JSON.stringify(value));
    for (const lang of ['ar', 'en', 'ckb'] as const) assert.equal(r.error.message[lang], HANDOVER_REFUSALS[lang][r.error.field]);
  };
  refused(null, 'value');
  refused([], 'value');
  refused('19', 'value');
  refused({ enabled: 'yes' }, 'enabled');
  refused({ hour: 24 }, 'hour');
  refused({ hour: -1 }, 'hour');
  refused({ hour: 0 }, 'hour');
  refused({ hour: 11 }, 'hour');
  refused({ hour: 7.5 }, 'hour');
  refused({ hour: '19' }, 'hour');
  for (const hour of [12, 23]) assert.equal(validateDeliveryHandover({ hour }).ok, true, `hour ${hour}`);
  assert.match(HANDOVER_REFUSALS.en.hour, /from 12 to 23/);
  refused({ tiers: [] }, 'tiers');
  refused({ tiers: { atlantis: 'near' } }, 'tiers');
  refused({ tiers: { Erbil: 'far' } }, 'tiers');
  refused({ tiers: { baghdad: 'mars' } }, 'tiers');
  refused({ closed_weekdays: 'fri' }, 'closed_weekdays');
  refused({ closed_weekdays: [7] }, 'closed_weekdays');
  refused({ closed_weekdays: [0, 1, 2, 3, 4, 5, 6] }, 'closed_weekdays');
  const ok = validateDeliveryHandover({ enabled: true, hour: 18, tiers: { baghdad: 'near', muthanna: 'near' }, closed_weekdays: [5, 0], extra: 'dropped' });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.value, { enabled: true, hour: 18, tiers: { muthanna: 'near' }, closed_weekdays: [0, 5] });
});

test('the setting is public (checkout draws the note before an order exists) and ships the module’s default', () => {
  assert.ok(PUBLIC_SETTING_KEYS.includes('deliveryHandover'));
  assert.deepEqual(SETTING_DEFAULTS.deliveryHandover, DEFAULT_DELIVERY_HANDOVER);
  assert.deepEqual(DEFAULT_DELIVERY_HANDOVER, { enabled: true, hour: 19, tiers: {}, closed_weekdays: [] });
});

// =========================================================================
// WHICH METHOD GETS THE NOTE; WHAT THE DEFAULTS BESIDE IT SAY
// =========================================================================

test('only a courier method: not pickup, not the store’s own same-day «توصيل شخصي»; a method added later is a courier one', () => {
  const byId = new Map(SETTING_DEFAULTS.checkoutDeliveryMethods.map((m) => [m.id, m]));
  assert.equal(leavesWithCourier(byId.get('standard')), true);
  assert.equal(leavesWithCourier(byId.get('personal')), false, 'our own driver, the same day');
  assert.equal(leavesWithCourier(byId.get('pickup')), false);
  assert.equal(leavesWithCourier({ id: 'express' }), true, 'the owner’s rule is «all orders»');
  assert.equal(leavesWithCourier({ id: 'branch_two', home_delivery: false }), false);
  assert.equal(leavesWithCourier({ id: 'pickup' }), false, 'the legacy id test, as deliversToHome');
  for (const nothing of [undefined, null, {}, { id: '' }, { id: 7 }]) assert.equal(leavesWithCourier(nothing as never), false);
});

test('the shipped standard card no longer names a duration the note would contradict, in three languages', () => {
  const standard = SETTING_DEFAULTS.checkoutDeliveryMethods.find((m) => m.id === 'standard')!;
  for (const text of [standard.descAr, standard.descEn, standard.descCkb ?? '']) {
    assert.doesNotMatch(text, /[0-9٠-٩]|أيام|business days|ڕۆژی کار/, `«${text}» names a duration`);
    assert.ok(text.trim(), 'a description is still there');
  }
  assert.notEqual(standard.descCkb, standard.descAr);
  // The other two cards carry no note, so their words stand: «نفس اليوم» is our own driver, pickup has no road.
  assert.equal(SETTING_DEFAULTS.checkoutDeliveryMethods.find((m) => m.id === 'personal')?.descAr, 'نفس اليوم');
  assert.equal(SETTING_DEFAULTS.checkoutDeliveryMethods.find((m) => m.id === 'pickup')?.descAr, 'جاهز خلال ساعتين');
});

// =========================================================================
// THE WORDS: three languages, the Sorani rules, the digits
// =========================================================================

/** Every string of a table, by its key path. */
function flatten(value: unknown, path = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof value === 'string') out.set(path, value);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) for (const [p, s] of flatten(v, path ? `${path}.${k}` : k)) out.set(p, s);
  return out;
}
const SORANI_ONLY = /[ڕڵێۆەڤگچپژیک]/;
const ARABIC_ONLY = /[ةىيك]/;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('every string exists in Arabic, English and Sorani; the Sorani is its own (DECISIONS row 183); placeholders match', () => {
  for (const [name, table] of [['ETA_TEXT', ETA_TEXT], ['HANDOVER_ADMIN_TEXT', HANDOVER_ADMIN_TEXT], ['HANDOVER_REFUSALS', HANDOVER_REFUSALS]] as const) {
    const ar = flatten(table.ar);
    const en = flatten(table.en);
    const ckb = flatten(table.ckb);
    assert.deepEqual([...en.keys()], [...ar.keys()], `${name}: en has the keys ar has`);
    assert.deepEqual([...ckb.keys()], [...ar.keys()], `${name}: ckb has the keys ar has`);
    for (const [key, a] of ar) {
      const e = en.get(key)!;
      const k = ckb.get(key)!;
      assert.ok(a.trim() && e.trim() && k.trim(), `${name}.${key} is empty somewhere`);
      assert.equal(placeholders(e), placeholders(a), `${name}.${key}: en placeholders`);
      assert.equal(placeholders(k), placeholders(a), `${name}.${key}: ckb placeholders`);
      // English and Arabic share the am/pm-free clock pattern '{n} {p}'; Sorani never copies either.
      assert.notEqual(k, a, `${name}.${key}: the Sorani is the Arabic`);
      assert.notEqual(k, e, `${name}.${key}: the Sorani is the English`);
      assert.match(k, SORANI_ONLY, `${name}.${key}: «${k}» has no Sorani letter`);
      assert.doesNotMatch(k, ARABIC_ONLY, `${name}.${key}: «${k}» has an Arabic-only letter`);
    }
  }
});

test('Arabic-Indic digits in ar and ckb, Latin in en — dayLabel’s convention — and every estimate says so', () => {
  const e = eta(baghdad('2026-11-11', '20:00'), 'baghdad');
  for (const lang of ['ar', 'ckb'] as const) {
    const said = [etaHandoverLine(e, lang), etaArrivalLine(e, lang), ...etaDetails(P, lang).lines].join(' ');
    assert.doesNotMatch(said, /[0-9]/, `${lang}: a Latin digit`);
    assert.ok(said.includes(dayLabel('2026-11-13', '2026-11-11', lang).label), `${lang}: the day is dayLabel's own`);
  }
  const en = [etaHandoverLine(e, 'en'), etaArrivalLine(e, 'en'), ...etaDetails(P, 'en').lines].join(' ');
  assert.doesNotMatch(en, /[٠-٩]/);
  assert.match(etaArrivalLine(e, 'ar'), /\(تقديري\)\.$/);
  assert.match(etaArrivalLine(e, 'en'), /\(estimate\)\.$/);
  assert.match(etaArrivalLine(e, 'ckb'), /\(خەمڵێنراو\)\.$/);
  assert.deepEqual([0, 12, 13, 19].map((h) => hourWords(h, 'ar')), ['١٢ ليلًا', '١٢ ظهرًا', '١ ظهرًا', '٧ مساءً']);
  assert.deepEqual([0, 12, 13, 19].map((h) => hourWords(h, 'en')), ['12 am', '12 pm', '1 pm', '7 pm']);
  assert.deepEqual([0, 12, 13, 19].map((h) => hourWords(h, 'ckb')), ['١٢ی شەو', '١٢ی نیوەڕۆ', '١ی دوای نیوەڕۆ', '٧ی ئێوارە']);
  assert.equal(windowWords('near', 'ar'), 'بين ١٠ صباحًا و٣ عصرًا');
  assert.equal(windowWords('far', 'ar'), 'بين ٦ و٨ مساءً');
  assert.equal(tierOptionWords('far', 'ckb'), 'دوور: ڕۆژی دواتر، لە نێوان کاتژمێر ٦ و ٨ی ئێوارە');
});

// =========================================================================
// «ONLY ADD THE NOTE»: THE PICKER AND ITS SERVER CHECKS ARE WHAT THEY WERE
// =========================================================================

test('at 20:00 the picker still offers today and the seven days after it — the note says the parcel leaves tomorrow', () => {
  const now = baghdad('2026-11-11', '20:00');
  const today = '2026-11-11';
  // What Checkout's offeredCheckoutDays runs: the default policy, anchored today.
  const offer = deliveryWindow({ anchorDay: today, todayDay: today, policy: DEFAULT_DELIVERY_DAY_POLICY });
  assert.deepEqual(offer.days, Array.from({ length: 8 }, (_, i) => addDays(today, i)), 'today first, eight days, unchanged');
  // Beside it the note is honest about the courier, and decides nothing.
  const e = eta(now, 'baghdad');
  assert.equal(e.handover.day, '2026-11-12');
  assert.equal(e.arrival_day, '2026-11-13');

  const checkout = read('src/pages/Checkout.tsx');
  assert.match(checkout, /function offeredCheckoutDays\(\s*policy: \{ enabled: boolean; max_days: number; allow_same_day: boolean \} \| undefined,\s*todayDay: string,\s*lang: string\s*\): DeliveryDayOption\[\] \{/);
  assert.match(checkout, /const window = deliveryWindow\(\{ anchorDay: todayDay, todayDay, policy: resolved \}\);/);
  assert.match(checkout, /\(\) => offeredCheckoutDays\(dayPolicy, todayDay, lang\),/);
  // The server and the picker never hear of the note.
  const orders = read('worker/routes/orders.ts');
  assert.doesNotMatch(orders, /deliveryEta|DELIVERY_DAY_TOO_SOON|earliestDay|earliest_day/);
  assert.doesNotMatch(read('worker/lib/deliveryDay.ts'), /deliveryEta|earliestDay/);
  assert.doesNotMatch(read('src/components/orders/DeliveryDayPicker.tsx'), /deliveryEta|courierEta|handover/i);
});

test('checkout draws the note under the chosen courier card, above the picker, and the long version inside «تفاصيل التوصيل»', () => {
  const checkout = read('src/pages/Checkout.tsx');
  // Gated as the picker is (a direct cart), on a courier method the server has not called unavailable,
  // never beside the PRO 12-hour strip; the clock read at render and the picked day passed (the review).
  assert.match(
    checkout,
    /const selectedDeliveryFee = quotedDeliveryFees\?\.find\(\(f\) => f\.id === selectedDelivery\?\.id\);\s*const courierEta =\s*settings !== null &&\s*leavesWithCourier\(selectedDelivery\) &&\s*selectedDeliveryFee\?\.available !== false &&\s*\(quote \? quote\.shipping_type === 'direct' : cartLooksDirect\) &&\s*quote\?\.priority_delivery\?\.eligible !== true\s*\? deliveryEta\(\{ nowMs: Date\.now\(\), governorate: etaGovernorate, policy: handoverPolicy, day: requestedDay \}\)\s*: null;\s*useRerenderAt\(courierEta\?\.next_change_ms \?\? null\);/
  );
  // No clock kept in state: the frozen `etaNow` was the review's finding (tests/courierNoteClock.test.ts renders the hook).
  assert.doesNotMatch(checkout, /etaNow|setEtaNow/);
  // Gini words its own first line; the data attribute names which line is drawn.
  assert.match(checkout, /const etaGini = paymentMethod === 'gini';/);
  assert.match(checkout, /data-courier-handover=\{etaHandoverKind\(courierEta, \{ gini: etaGini \}\)\}>\s*\{etaHandoverLine\(courierEta, lang, \{ gini: etaGini \}\)\}/);
  const note = checkout.indexOf('testId="checkout-courier-note"');
  const picker = checkout.indexOf('<DeliveryDayPicker');
  const card = checkout.indexOf('data-delivery-fee={method.id}');
  assert.ok(card > 0 && note > card && picker > note, 'card, then the note, then the picker');
  assert.match(checkout, /\{selected && courierEta && !unavailable \? \(\s*<Note\s+tone="zinc"\s+compact\s+animate=\{false\}/);
  // The long version and the widened question hang on the same `courierEta`, so an unavailable card has neither.
  assert.match(checkout, /question=\{courierEta \? etaWords\.question :/);
  assert.match(checkout, /\{courierEta && \(\s*<div className="space-y-1 border-t border-white\/5 pt-2" data-courier-details>/);
  // The long version sits in the delivery row's «!», after the fee's own reasons.
  const details = checkout.indexOf('data-courier-details');
  const summaryOpen = checkout.indexOf('testId="delivery"');
  const summaryClose = checkout.indexOf('</SummaryInfo>', summaryOpen);
  assert.ok(details > summaryOpen && details < summaryClose, 'inside the delivery SummaryInfo');
});

test('«إدارة التوصيل» edits the hour, the switch and each governorate’s time group, and saves through the setting', () => {
  const page = read('src/components/adminDeliveryPricing/DeliveryManagement.tsx');
  assert.match(page, /data-delivery-handover-hour/);
  assert.match(page, /data-delivery-handover-enabled/);
  assert.match(page, /data-delivery-tier=\{gov\.id\}/);
  assert.match(page, /api\.put\('\/api\/admin\/settings\/deliveryHandover', \{ value: handover \}\)/);
  // Only real moves are stored: back on the table, the override is dropped.
  assert.match(page, /if \(tier === handoverView\.table\[id\]\) delete tiers\[id\];/);
  // The review: the select fits a phone's row (its own line there, never wider than the row) …
  assert.match(page, /<select\s+className="lv-input w-full sm:w-auto max-w-full min-w-0"\s+value=\{tierOfRow\(gov\.id\)\}/);
  assert.doesNotMatch(page, /className="lv-input w-auto"\s+value=\{tierOfRow/);
  // … a moved governorate is marked on its row, and a Save that sent the handover says so in its own words.
  assert.match(page, /movedOff\(gov\.id\) && \(\s*<span className="text-\[11px\] text-text-muted" data-delivery-tier-moved=\{gov\.id\}>\s*\{handoverWords\.moved\}/);
  assert.match(page, /\{state === 'saved' && savedWhat\.handover && handoverWords && \(/);
  assert.match(page, /\{state === 'saved' && savedWhat\.policy && \(/);
  // The hour select offers the server's hours, not 0..23.
  assert.match(page, /handoverWords\.hours\.map\(\(\{ hour, label \}\) => \(/);
});

test('the admin page reads the table and its words from the server, so it never shares the module with the checkout', () => {
  const view = handoverAdminView();
  assert.deepEqual(view.table, DEFAULT_ETA_TIERS);
  for (const lang of ['ar', 'en', 'ckb'] as const) {
    const w = view.words[lang];
    // Noon to 11 pm only (the review): the windows are the owner's words for an evening handover.
    assert.deepEqual(w.hours.map((x) => x.hour), [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
    assert.equal(w.hours.find((x) => x.hour === 19)?.label, hourWords(19, lang));
    assert.equal(w.tiers.far, tierOptionWords('far', lang));
    assert.equal(w.title, HANDOVER_ADMIN_TEXT[lang].title);
    assert.equal(w.moved, HANDOVER_ADMIN_TEXT[lang].moved);
    assert.equal(w.saved, HANDOVER_ADMIN_TEXT[lang].saved);
    assert.match(w.tier, /\{gov\}/, 'the page fills the governorate');
  }
  assert.equal(view.words.ar.tiers.near, 'قريبة: اليوم التالي، بين ١٠ صباحًا و٣ عصرًا');
  assert.deepEqual(view.words.en.hours[0], { hour: 12, label: '12 pm' });
  // THE CHECKOUT IS THE ONLY BROWSER IMPORTER. A second one makes the module a
  // chunk of its own, named in the entry's preload map on every first visit —
  // 12 B over the storefront payload's cap when it was tried (DECISIONS row 324).
  const importers: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name) && /from '[^']*worker\/lib\/deliveryEta'/.test(read(rel))) importers.push(rel);
    }
  };
  walk('src');
  assert.deepEqual(importers, ['src/pages/Checkout.tsx']);
});
