/**
 * THE TWO DEFECTS THAT FAIL SILENTLY AND ONLY IN PRODUCTION.
 *
 * Both of the first two tests here were written BEFORE the code they check,
 * because neither has a symptom anybody would notice:
 *
 *  (a) THE ANCHOR. `created_at.slice(0, 10)` is the Baghdad day for
 *      twenty-one hours out of every twenty-four and is one day EARLY for the
 *      other three — 21:00–24:00 UTC, which is 00:00–03:00 in Baghdad. An
 *      order placed at one in the morning gets a six-day "week". Nothing
 *      throws, nothing logs, and the customer's picker simply stops one day
 *      sooner than the one on the next customer's screen. The clock here is
 *      pinned inside that window on purpose; a test run at any other hour
 *      cannot tell the two implementations apart.
 *
 *  (b) THE CEILING. A ceiling recomputed from today looks CORRECT in every
 *      single-step test — move the day once and the answer is right. It is
 *      only on the SECOND hop that the customer walks the window forward for
 *      ever in weekly jumps. So every ceiling test below moves the day twice.
 *
 * The rest of the file pins the things the board and checkout will build on:
 * lexicographic day ordering, the clamp, the three error codes, the localised
 * label, and — against a real SQLite database — the migration's shape CHECK,
 * the no-backfill guarantee and the partial index's verbatim WHERE.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { dbThrough, freshDb } from './fixtures/app';
import { ROOT } from './fixtures/d1';
import { addDays, baghdadDay, baghdadDayOf, BAGHDAD_OFFSET_MS, dayParts, isDay } from '../worker/lib/baghdadTime';
import {
  DEFAULT_DELIVERY_DAY_POLICY,
  dayLabel,
  deliveryWindow,
  resolveDeliveryDayPolicy,
  validateDeliveryDay,
  type DeliveryDayPolicy,
} from '../worker/lib/deliveryDay';
import { deliversToHome, PUBLIC_SETTING_KEYS, SETTING_DEFAULTS } from '../worker/lib/settings';

const WEEK: DeliveryDayPolicy = { enabled: true, max_days: 7, allow_same_day: true };

// =========================================================================
// (a) THE ANCHOR IS baghdadDayOf(created_at), NEVER created_at.slice(0, 10)
// =========================================================================

test('(a) an order placed at 01:00 Baghdad anchors on TODAY, not on yesterday\'s UTC date', () => {
  // 22:00 UTC on the 18th IS 01:00 on the 19th in Baghdad. This is the row a
  // customer created one minute after midnight, local time.
  const created_at = '2026-09-18T22:00:00.000Z';
  // The clock, pinned half an hour later — inside the three-hour window where
  // a UTC day string and a Baghdad day string disagree.
  const nowMs = Date.parse('2026-09-18T22:30:00.000Z');

  assert.equal(baghdadDayOf(created_at), '2026-09-19', 'the customer placed it on the nineteenth');
  assert.equal(created_at.slice(0, 10), '2026-09-18', 'and slicing the string says the eighteenth — the whole bug');
  assert.equal(baghdadDay(nowMs), '2026-09-19', 'today is the nineteenth too, for the same three hours');

  const right = deliveryWindow({ anchorDay: baghdadDayOf(created_at), todayDay: baghdadDay(nowMs), policy: WEEK });
  const wrong = deliveryWindow({ anchorDay: created_at.slice(0, 10), todayDay: baghdadDay(nowMs), policy: WEEK });

  assert.equal(right.end, '2026-09-26', 'seven days from the day the customer actually ordered');
  assert.equal(wrong.end, '2026-09-25', 'the sliced anchor is a day short, and nothing anywhere says so');
  assert.equal(right.days.length, 8, 'the nineteenth through the twenty-sixth, inclusive');
  assert.equal(wrong.days.length, 7, 'one day of the customer\'s week, gone');
  assert.equal(right.days[0], '2026-09-19');
  assert.equal(right.days.at(-1), '2026-09-26');
});

test('(a) the two anchors agree for the other twenty-one hours, which is why nobody notices', () => {
  const daytime = '2026-09-18T09:00:00.000Z';
  assert.equal(baghdadDayOf(daytime), daytime.slice(0, 10), 'identical at noon — the defect is invisible by day');
  // And disagree from 21:00 UTC onwards, every single day.
  assert.equal(baghdadDayOf('2026-09-18T20:59:59.000Z'), '2026-09-18');
  assert.equal(baghdadDayOf('2026-09-18T21:00:00.000Z'), '2026-09-19', 'the boundary, to the second');
});

test('(a) BAGHDAD_OFFSET_MS is the whole of the rule, and it is fixed — Iraq has had no DST since 2007', () => {
  assert.equal(BAGHDAD_OFFSET_MS, 3 * 3_600_000);
  // Midsummer and midwinter are the same offset. A DST-aware implementation
  // would differ on one of these two.
  assert.equal(baghdadDayOf('2026-06-21T21:30:00.000Z'), '2026-06-22');
  assert.equal(baghdadDayOf('2026-12-21T21:30:00.000Z'), '2026-12-22');
});

// =========================================================================
// (b) THE CEILING DOES NOT MOVE
// =========================================================================

test('(b) an order created 18-9 may go to 23-9 and may NOT go to 26-9', () => {
  const anchorDay = baghdadDayOf('2026-09-18T09:00:00.000Z');
  const { end: frozenCeiling } = deliveryWindow({ anchorDay, todayDay: '2026-09-18', policy: WEEK });
  assert.equal(frozenCeiling, '2026-09-25', 'seven days from the order date — «مدة سبعة أيام من تاريخ الطلب»');

  assert.equal(validateDeliveryDay({ requested: '2026-09-23', todayDay: '2026-09-18', windowEnd: frozenCeiling }), 'ok');
  assert.equal(
    validateDeliveryDay({ requested: '2026-09-26', todayDay: '2026-09-18', windowEnd: frozenCeiling }),
    'BEYOND_WINDOW',
    'one day past the ceiling is past the ceiling'
  );
  assert.equal(validateDeliveryDay({ requested: '2026-09-25', todayDay: '2026-09-18', windowEnd: frozenCeiling }), 'ok', 'the ceiling day itself is inclusive');
});

test('(b) AFTER MOVING TO 23-9 THE CEILING IS STILL 25-9, NOT 30-9 — the second hop is where a rolling window shows', () => {
  const anchorDay = '2026-09-18';
  const frozenCeiling = deliveryWindow({ anchorDay, todayDay: '2026-09-18', policy: WEEK }).end;

  // The customer has moved the day to the 23rd. Five days pass; they open the
  // picker again. A ROLLING window would now offer today + 7 = 30-9, and each
  // step looks perfectly legal on its own — this is how a customer walks an
  // order forward for ever in weekly hops.
  const rollingCeilingBug = addDays('2026-09-23', WEEK.max_days);
  assert.equal(rollingCeilingBug, '2026-09-30', 'what a recomputed ceiling would say');

  const second = deliveryWindow({ anchorDay, todayDay: '2026-09-23', policy: WEEK });
  assert.equal(second.end, '2026-09-25', 'the ceiling is computed from the ANCHOR and has not moved');
  assert.equal(second.end, frozenCeiling, 'five days later it is the same value it was at checkout');
  assert.notEqual(second.end, rollingCeilingBug);
  assert.deepEqual(second.days, ['2026-09-23', '2026-09-24', '2026-09-25'], 'only what is left of the original week');

  assert.equal(
    validateDeliveryDay({ requested: '2026-09-30', todayDay: '2026-09-23', windowEnd: second.end }),
    'BEYOND_WINDOW',
    'the day a rolling ceiling would have accepted'
  );
});

test('(b) the start walks forward with today while the end stays put, and the window eventually closes', () => {
  const anchorDay = '2026-09-18';
  const day2 = deliveryWindow({ anchorDay, todayDay: '2026-09-20', policy: WEEK });
  assert.equal(day2.start, '2026-09-20', 'yesterday is never offered');
  assert.equal(day2.end, '2026-09-25');

  const closed = deliveryWindow({ anchorDay, todayDay: '2026-09-26', policy: WEEK });
  assert.deepEqual(closed.days, [], 'past the ceiling nothing may be chosen');
  assert.equal(closed.end, '2026-09-25', 'and the ceiling is still reported, so an admin can see WHICH one was reached');
});

test('(b) a day in the past is PAST, whatever the ceiling says', () => {
  assert.equal(validateDeliveryDay({ requested: '2026-09-17', todayDay: '2026-09-18', windowEnd: '2026-09-25' }), 'PAST');
  assert.equal(validateDeliveryDay({ requested: '2026-09-18', todayDay: '2026-09-18', windowEnd: '2026-09-25' }), 'ok', 'today is not the past');
});

// =========================================================================
// THE DAY STRING
// =========================================================================

test('days compare lexicographically in date order, so no comparison needs a Date or a timezone', () => {
  const days = ['2026-10-01', '2026-09-30', '2027-01-01', '2026-09-09'];
  assert.deepEqual([...days].sort(), ['2026-09-09', '2026-09-30', '2026-10-01', '2027-01-01']);
  assert.ok('2026-09-09' < '2026-09-10', 'zero padding is what makes this true — 9 < 10 as text only when padded');
});

test('addDays normalises month ends, leap days and year boundaries', () => {
  assert.equal(addDays('2026-09-18', 7), '2026-09-25');
  assert.equal(addDays('2026-09-30', 1), '2026-10-01');
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29', '2028 is a leap year');
  assert.equal(addDays('2027-02-28', 1), '2027-03-01', '2027 is not');
  assert.equal(addDays('2026-09-01', -1), '2026-08-31');
  assert.equal(addDays('2026-09-18', 0), '2026-09-18');
});

test('junk is the empty string and never a throw — one bad created_at must not take the board down', () => {
  assert.equal(baghdadDayOf('not a date'), '');
  assert.equal(baghdadDayOf(''), '');
  assert.equal(baghdadDay(Number.NaN), '');
  assert.equal(addDays('2026-13-01', 1), '', 'shape alone is not a date');
  assert.equal(addDays('2026-02-31', 1), '', 'and the round-trip is what rejects it');
  assert.equal(dayParts('2026-02-31'), null);
  assert.ok(isDay('2026-02-31'), 'isDay is SHAPE only, which is exactly what the SQL CHECK can express');
  assert.equal(isDay('2026-9-1'), false);
});

// =========================================================================
// THE POLICY
// =========================================================================

test('the policy ships ENABLED at seven days — the deliberate deviation from the house off-by-default rule', () => {
  assert.equal(DEFAULT_DELIVERY_DAY_POLICY.enabled, true, 'the owner asked for this one directly');
  assert.equal(DEFAULT_DELIVERY_DAY_POLICY.max_days, 7, '«الأسبوع أقصد به مدة سبعة أيام من تاريخ الطلب»');
  assert.deepEqual(SETTING_DEFAULTS.deliveryDayPolicy, DEFAULT_DELIVERY_DAY_POLICY, 'and settings.ts carries the same object');
});

test('a stored policy is merged over the defaults and clamped 1..30', () => {
  assert.deepEqual(resolveDeliveryDayPolicy(undefined), DEFAULT_DELIVERY_DAY_POLICY);
  assert.deepEqual(resolveDeliveryDayPolicy('nonsense'), DEFAULT_DELIVERY_DAY_POLICY);
  assert.equal(resolveDeliveryDayPolicy({ max_days: 0 }).max_days, 1, 'zero would be an empty picker with no error');
  assert.equal(resolveDeliveryDayPolicy({ max_days: -5 }).max_days, 1);
  assert.equal(resolveDeliveryDayPolicy({ max_days: 10_000 }).max_days, 30, 'thirty years out is not a delivery day');
  assert.equal(resolveDeliveryDayPolicy({ max_days: '14' }).max_days, 14, 'a settings row is text');
  assert.equal(resolveDeliveryDayPolicy({ max_days: 'x' }).max_days, 7, 'junk keeps the default rather than becoming NaN');
  // A partial object keeps every field it did not mention.
  assert.deepEqual(resolveDeliveryDayPolicy({ allow_same_day: false }), { enabled: true, max_days: 7, allow_same_day: false });
});

test('allow_same_day moves the START of the offer, and the ceiling is untouched by it', () => {
  const policy: DeliveryDayPolicy = { enabled: true, max_days: 7, allow_same_day: false };
  const w = deliveryWindow({ anchorDay: '2026-09-18', todayDay: '2026-09-18', policy });
  assert.equal(w.start, '2026-09-19', 'the offer starts tomorrow');
  assert.equal(w.end, '2026-09-25', 'the ceiling is still seven days from the order');
  assert.equal(w.days[0], '2026-09-19');
});

test('a policy switched off offers nothing while still reporting the ceiling', () => {
  const w = deliveryWindow({ anchorDay: '2026-09-18', todayDay: '2026-09-18', policy: { ...WEEK, enabled: false } });
  assert.deepEqual(w.days, [], 'the off switch is off in one place');
  assert.equal(w.end, '2026-09-25');
});

test('validateDeliveryDay refuses junk, and refuses a row with no frozen ceiling', () => {
  assert.equal(validateDeliveryDay({ requested: '23-09-2026', todayDay: '2026-09-18', windowEnd: '2026-09-25' }), 'BAD_FORMAT');
  assert.equal(validateDeliveryDay({ requested: '2026-02-31', todayDay: '2026-09-18', windowEnd: '2026-09-25' }), 'BAD_FORMAT');
  assert.equal(validateDeliveryDay({ requested: '', todayDay: '2026-09-18', windowEnd: '2026-09-25' }), 'BAD_FORMAT');
  // A row that predates 0094, a pickup, a merchant order: no ceiling at all.
  // An empty ceiling must not read as "no limit", which would make the one
  // row shape that must refuse a day the one that accepts any day.
  assert.equal(validateDeliveryDay({ requested: '2026-09-23', todayDay: '2026-09-18', windowEnd: '' }), 'BAD_FORMAT');
});

// =========================================================================
// THE LABEL — the server localises, the SPA renders a string
// =========================================================================

test('dayLabel says «اليوم» and «غدًا» from the SERVER\'s Baghdad day, in three languages', () => {
  const today = '2026-09-19';
  assert.deepEqual(dayLabel(today, today, 'ar'), { label: 'اليوم', is_today: true, is_tomorrow: false });
  assert.deepEqual(dayLabel('2026-09-20', today, 'ar'), { label: 'غدًا', is_today: false, is_tomorrow: true });
  assert.equal(dayLabel(today, today, 'en').label, 'Today');
  assert.equal(dayLabel('2026-09-20', today, 'en').label, 'Tomorrow');
  assert.equal(dayLabel(today, today, 'ckb').label, 'ئەمڕۆ');
  assert.equal(dayLabel('2026-09-20', today, 'ckb').label, 'بەیانی');
  assert.equal(dayLabel(today, today, 'fr').label, 'اليوم', 'an unknown language falls back to Arabic, not to English');
});

test('a further day is written out with the Iraqi month name and Arabic-Indic digits', () => {
  const today = '2026-09-19';
  // 2026-09-23 is a Wednesday. The browser must never compute this: in any
  // timezone west of Baghdad, `new Date('2026-09-23').toLocaleDateString()`
  // parses UTC midnight, converts to local time and renders the TWENTY-SECOND.
  const l = dayLabel('2026-09-23', today, 'ar');
  assert.equal(l.label, 'الأربعاء ٢٣ أيلول');
  assert.equal(l.is_today, false);
  assert.equal(l.is_tomorrow, false);
  assert.equal(dayLabel('2026-09-23', today, 'en').label, 'Wednesday 23 September');
  assert.equal(dayLabel('2026-09-23', today, 'ckb').label, 'چوارشەممە ٢٣ ئەیلوول');
  // «أيلول», not «سبتمبر» — the same month list a warranty receipt prints, so
  // a customer comparing a screen with a document reads one name.
  assert.ok(dayLabel('2026-09-23', today, 'ar').label.includes('أيلول'));
});

test('dayLabel is empty, not a crash, for a day that is not one', () => {
  assert.deepEqual(dayLabel('', '2026-09-19', 'ar'), { label: '', is_today: false, is_tomorrow: false });
  assert.deepEqual(dayLabel('2026-02-31', '2026-09-19', 'ar'), { label: '', is_today: false, is_tomorrow: false });
});

// =========================================================================
// THE DELIVERY METHOD FLAG
// =========================================================================

test('deliversToHome: an explicit flag wins, and absent it the existing id test is preserved exactly', () => {
  assert.equal(deliversToHome({ id: 'standard', home_delivery: true }), true);
  assert.equal(deliversToHome({ id: 'pickup', home_delivery: false }), false);
  // Every method configured before the flag existed keeps today's behaviour.
  assert.equal(deliversToHome({ id: 'standard' }), true);
  assert.equal(deliversToHome({ id: 'pickup' }), false);
  // THE POINT OF THE FLAG: a pickup-like method the owner adds tomorrow can
  // say so, instead of being silently classified as a home delivery.
  assert.equal(deliversToHome({ id: 'branch_two_pickup' }), true, 'the id test alone gets this wrong');
  assert.equal(deliversToHome({ id: 'branch_two_pickup', home_delivery: false }), false, 'and the flag is how it declares itself');
});

test('the three seeded methods carry the flag, and the policy is public because Checkout needs it before an order exists', () => {
  const byId = new Map(SETTING_DEFAULTS.checkoutDeliveryMethods.map((m) => [m.id, m]));
  assert.equal(byId.get('standard')?.home_delivery, true);
  assert.equal(byId.get('personal')?.home_delivery, true);
  assert.equal(byId.get('pickup')?.home_delivery, false);
  assert.ok(PUBLIC_SETTING_KEYS.includes('deliveryDayPolicy'), 'the picker is drawn before there is an order to read it off');
});

// =========================================================================
// MIGRATION 0094, AGAINST A REAL DATABASE
// =========================================================================

/** Migration 0094's own text, applied to a database that stops before it. */
function applyO94(raw: DatabaseSync): void {
  raw.exec(readFileSync(join(ROOT, 'migrations', '0094_order_delivery_day.sql'), 'utf8'));
}

function seedOrder(raw: DatabaseSync, id: string, extraCols = '', extraVals = ''): void {
  raw.exec(
    `INSERT INTO orders (id, user_id, address_snapshot, delivery_method_id, delivery_method_snapshot,
                         payment_method_id, subtotal_iqd, total_iqd, exchange_rate, due_on_delivery_iqd${extraCols})
     VALUES ('${id}', 'usr_1', '{}', 'standard', '{}', 'cash', 100, 100, 1400, 0${extraVals})`
  );
}

function seedUser(raw: DatabaseSync): void {
  raw.exec("INSERT INTO users (id, email, username, name, role) VALUES ('usr_1','u@x.co','usr_1','Name','customer')");
}

test('NO BACKFILL: a row that existed before 0094 comes out not-schedulable with a NULL day', () => {
  // The database on the night of the deploy, with a real order already on it.
  const raw = dbThrough('0093');
  seedUser(raw);
  seedOrder(raw, 'ORD-OLD');
  applyO94(raw);

  const row = raw.prepare('SELECT * FROM orders WHERE id = ?').get('ORD-OLD') as Record<string, unknown>;
  assert.equal(row.delivery_due_day, null, 'NULL means "no day can be named yet" — never "today"');
  assert.equal(row.delivery_day_window_end, null);
  assert.equal(row.delivery_day_schedulable, 0, 'the guarantee: deployed behaviour is byte-identical');
  assert.equal(row.delivery_day_source, '');
  assert.equal(row.delivery_day_changed_at, null);
  assert.equal(row.delivery_day_changes, 0);
});

test('the CHECK enforces SHAPE, accepts NULL, and its GLOB pattern is 42 bytes against D1\'s 50', () => {
  const raw = freshDb();
  seedUser(raw);

  seedOrder(raw, 'ORD-NULL');
  seedOrder(raw, 'ORD-OK', ', delivery_due_day', ", '2026-09-23'");

  assert.throws(
    () => seedOrder(raw, 'ORD-BAD', ', delivery_due_day', ", '2026-9-23'"),
    /CHECK constraint failed/,
    'an unpadded day would break the lexicographic ordering the whole design rests on'
  );
  assert.throws(() => seedOrder(raw, 'ORD-BAD2', ', delivery_due_day', ", '23-09-2026'"), /CHECK constraint failed/);
  assert.throws(() => seedOrder(raw, 'ORD-BAD3', ', delivery_day_window_end', ", 'soon'"), /CHECK constraint failed/);

  // THE BUDGET. D1 refuses a LIKE/GLOB pattern over 50 BYTES
  // (worker/lib/sqlLike.ts), and this one is 42. There is no room for a
  // prettier one, and nothing local ever reproduces the failure because
  // SQLite's own default for the limit is 50 000.
  const pattern = '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]';
  assert.equal(new TextEncoder().encode(pattern).length, 42);
  assert.ok(42 <= 50, 'it fits — and a longer, tidier pattern would not');
  const sql = raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'").get() as { sql: string };
  assert.ok(sql.sql.includes(pattern), 'and it is exactly this pattern on the table');
});

test('THE PARTIAL INDEX IS LOST THE MOMENT THE WHERE IS REWRITTEN — NOT IN must stay verbatim', () => {
  const raw = freshDb();
  const plan = (q: string) =>
    (raw.prepare(`EXPLAIN QUERY PLAN ${q}`).all() as { detail: string }[]).map((r) => r.detail).join(' | ');

  const order = 'ORDER BY delivery_due_day, priority DESC, created_at';
  const verbatim = plan(`SELECT id FROM orders WHERE status NOT IN ('delivered','cancelled') ${order}`);
  assert.ok(
    verbatim.includes('idx_orders_board_open'),
    `the board query must use its index; plan was: ${verbatim}`
  );

  // The "improvement" that silently costs the board its index. It is
  // logically identical — SQLite matches the TEXT of the partial index's
  // expression, it does not reason about set theory — and there is no visible
  // symptom until the table is large.
  const rewritten = plan(
    `SELECT id FROM orders WHERE status IN ('pending','confirmed','processing','shipped') ${order}`
  );
  assert.ok(!rewritten.includes('idx_orders_board_open'), 'the positive rewrite cannot use a partial index');
  // AND IT IS QUIETER THAN A FULL SCAN, which is worse. On this schema the
  // planner falls back to `idx_orders_cancelled_retention` for the predicate,
  // so EXPLAIN still says "USING INDEX" and looks healthy — while the ORDER BY
  // is now a temp B-tree over every open order, sorted by hand on every page
  // of the board.
  assert.ok(rewritten.includes('TEMP B-TREE'), `the ORDER BY is sorted by hand; plan was: ${rewritten}`);
  assert.ok(!verbatim.includes('TEMP B-TREE'), 'where the verbatim form reads the rows already in order');
});

test('the board index sorts on the day FIRST and PRO second — decision (أ): PRO is a tie-break inside a day', () => {
  const raw = freshDb();
  const sql = (
    raw.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_orders_board_open'").get() as {
      sql: string;
    }
  ).sql.replace(/\s+/g, ' ');
  assert.ok(sql.includes('orders(delivery_due_day, priority DESC, created_at)'), sql);
  assert.ok(sql.includes("status NOT IN ('delivered','cancelled')"), 'and the WHERE the board must repeat verbatim');
  assert.ok(
    sql.indexOf('delivery_due_day') < sql.indexOf('priority'),
    'a PRO pre-order forty days out is NOT pinned above today\'s work'
  );
});
