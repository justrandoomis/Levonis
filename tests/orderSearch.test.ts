/**
 * THE CLASSIFIER, THE TWO FOLDS, AND THE ONE DAY A YEAR THE DATE PARSER CARES
 * ABOUT.
 *
 * Three defects are pinned here, and none of them has a symptom:
 *
 *  (a) THE TWO FOLDS DRIFTING. `arabicFoldSql` and `foldForSql` are generated
 *      from one table, and this file runs the GENERATED SQL through a real
 *      SQLite to prove the generated TypeScript agrees with it character for
 *      character. If they ever diverge, the search does not throw — it returns
 *      zero rows for every name containing the drifted letter, and the first
 *      person to notice is a customer on the phone.
 *
 *  (b) `substr(created_at, 1, 10)` AS A DAY. It is right for twenty-one hours
 *      of every twenty-four, so a date test run at any other hour cannot tell
 *      the two implementations apart. The clock is pinned at 22:00 UTC here
 *      for exactly that reason.
 *
 *  (c) A HEDGED CLASSIFIER. `07701234567` must be a phone and never an order
 *      id; `2024` must be a year and `1234` must not. These are decisions, and
 *      a table of them is the only way a later change to the order of the four
 *      readings gets noticed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { classifyOrderSearch, parseOrderSearchDate } from '../worker/lib/orderSearch';
import { arabicFoldSql, foldForSql, phoneDigitsSql } from '../worker/lib/sqlFold';
import { normalizeText } from '../worker/lib/search/normalize';
import { phoneSearchKeys } from '../worker/lib/phone';
import { likePattern, patternBytes, D1_LIKE_PATTERN_MAX_BYTES } from '../worker/lib/sqlLike';

/** Baghdad is UTC+3, so this instant is 13:00 on the nineteenth, in Baghdad. */
const NOW = Date.parse('2026-09-19T10:00:00.000Z');
/** 01:00 on the NINETEENTH in Baghdad, and the EIGHTEENTH in UTC. */
const MIDNIGHT_EDGE = Date.parse('2026-09-18T22:00:00.000Z');

// =========================================================================
// (a) THE TWO FOLDS ARE ONE FOLD
// =========================================================================

/**
 * Names carrying every fold the table knows: hamza on alef in both directions,
 * madda, wasla, ta marbuta, alef maqsura, the two hamza carriers, tashkeel,
 * tatweel, and the Kurdish letters that share a sound with Arabic ones.
 */
const NAMES = [
  'أحمد', 'إبراهيم', 'آلاء', 'ٱسماء', 'فاطمة', 'فاطمه', 'مصطفى', 'مصطفي',
  'رؤى', 'رئيس', 'عبد الله', 'عبدالله', 'مُحَمَّد', 'محمد', 'زيــنب',
  'کاروان', 'یاسین', 'ئەحمەد', 'سۆران', 'ژیان', 'نۆژەن',
  'حسين علي', 'Ahmed', 'AHMED al-Khafaji', 'زهراء', 'شذى',
  'طابعة', 'طابعه', 'ليلى', 'دُعَاء', 'مريم', '', '   ', '٢٠٢٦',
];

test('(a) the SQL fold and its TypeScript twin agree, character for character', () => {
  const db = new DatabaseSync(':memory:');
  // The expression is generated over a bound parameter, so what SQLite runs
  // here is byte-identical to what the board query runs over a column.
  const stmt = db.prepare(`SELECT ${arabicFoldSql('?')} AS v`);
  for (const name of NAMES) {
    const inSql = (stmt.get(name) as { v: string }).v;
    assert.equal(
      foldForSql(name),
      inSql,
      `the folds disagree on «${name}» — a name search would silently return nothing for it`
    );
  }
  db.close();
});

test('(a) the fold actually folds: the orthographic variants collapse onto each other', () => {
  const same = (a: string, b: string) => assert.equal(foldForSql(a), foldForSql(b), `${a} vs ${b}`);
  same('فاطمة', 'فاطمه');       // ta marbuta
  same('مصطفى', 'مصطفي');       // alef maqsura
  same('أحمد', 'احمد');          // hamza on alef
  same('إبراهيم', 'ابراهيم');
  same('آلاء', 'الاء');
  same('مُحَمَّد', 'محمد');        // tashkeel
  same('زيــنب', 'زينب');        // tatweel
  same('کاروان', 'كاروان');      // Kurdish kaf
  same('یاسین', 'ياسين');        // Kurdish ya
  same('ئەحمەد', 'يهحمهد');      // Kurdish e and the hamza carrier
  // And does NOT merge letters that are different sounds.
  assert.notEqual(foldForSql('سۆران'), foldForSql('سوران'));
});

test('(a) the SQL fold is the WEAKER of the two, and that loss is written down', () => {
  // `normalizeText` decomposes Latin accents; SQLite cannot, so this one does
  // not either. If it did, the TERM would fold further than the COLUMN and
  // match nothing at all — which is the worse failure of the two.
  assert.equal(normalizeText('Créality'), 'creality');
  assert.equal(foldForSql('Créality'), 'créality', 'the accent survives — the accepted, stated loss');
  assert.notEqual(foldForSql('Créality'), foldForSql('Creality'));

  // Lower-casing is ASCII-only, exactly like SQLite's `lower()`.
  assert.equal(foldForSql('AHMED'), 'ahmed');
  assert.equal(foldForSql('İSTANBUL'), 'İstanbul'.replace(/[A-Z]/g, (c) => c.toLowerCase()));

  // And punctuation is NOT collapsed, for the same reason.
  assert.equal(normalizeText('al-khafaji'), 'al khafaji');
  assert.equal(foldForSql('al-khafaji'), 'al-khafaji');
});

test('(a) the phone digit strip reduces BOTH stored shapes to the same suffix', () => {
  const db = new DatabaseSync(':memory:');
  const stmt = db.prepare(`SELECT ${phoneDigitsSql('?')} AS v`);
  const legacy = (stmt.get('+964-0770 123 4567') as { v: string }).v;
  const modern = (stmt.get('+9647701234567') as { v: string }).v;
  assert.equal(legacy, '96407701234567');
  assert.equal(modern, '9647701234567');
  const key = phoneSearchKeys('07701234567').national;
  assert.equal(key, '7701234567');
  assert.ok(legacy.endsWith(key), 'the legacy snapshot shape must end with the national number');
  assert.ok(modern.endsWith(key), 'and so must the modern one');
  db.close();
});

// =========================================================================
// (b) A DATE IS A BAGHDAD CIVIL DAY, EXPRESSED AS A UTC RANGE
// =========================================================================

test('(b) a day becomes the UTC range 21:00Z→21:00Z, not a string slice', () => {
  const d = parseOrderSearchDate('2026-09-18', NOW)!;
  assert.equal(d.day_from, '2026-09-18');
  assert.equal(d.day_to, '2026-09-18');
  assert.equal(d.from, '2026-09-17T21:00:00.000Z', 'Baghdad 18-9 starts at 21:00Z on the 17th');
  assert.equal(d.to, '2026-09-18T21:00:00.000Z', 'and ends, exclusively, at 21:00Z on the 18th');

  // The row this range exists for: an order placed at 01:00 Baghdad on the
  // 18th, whose `created_at` is dated the SEVENTEENTH in UTC. A ten-character
  // slice files it under the 17th and the admin searching 18-9 finds nothing.
  const createdAt = '2026-09-17T22:00:00.000Z';
  assert.equal(createdAt.slice(0, 10), '2026-09-17', 'the slice says the seventeenth — the whole defect');
  assert.ok(createdAt >= d.from && createdAt < d.to, 'the range catches it, because it is built from the offset');

  // And the boundary is half-open, so no instant belongs to two days.
  const next = parseOrderSearchDate('2026-09-19', NOW)!;
  assert.equal(d.to, next.from, 'one day ends exactly where the next begins');
});

test('(b) a missing year resolves BACKWARD, because orders are in the past', () => {
  // 19 September 2026 is "today". 18-9 is yesterday, this year.
  assert.equal(parseOrderSearchDate('18-9', NOW)!.day_from, '2026-09-18');
  // 28-12 has not happened yet in 2026, so it means last December.
  const dec = parseOrderSearchDate('28-12', NOW)!;
  assert.equal(dec.day_from, '2025-12-28');
  assert.equal(dec.assumed_year, true, 'and the screen is told a year was assumed');
  // Resolving FORWARD would have returned 2026-12-28 and an empty screen,
  // which reads as "no such order" rather than "wrong year".
  assert.ok(dec.day_from < '2026-09-19');
});

test('(b) "today" for a date search is the BAGHDAD day, asserted at 22:00 UTC', () => {
  // 22:00Z on the 18th is 01:00 on the NINETEENTH in Baghdad.
  const d = parseOrderSearchDate('19-9', MIDNIGHT_EDGE)!;
  assert.equal(d.day_from, '2026-09-19', 'the nineteenth is today, so it resolves to this year');
  // A UTC-derived today would still read the eighteenth, decide the
  // nineteenth is in the future, and send the admin to 2025.
  assert.notEqual(d.day_from, '2025-09-19');
});

test('(b) `5-9` is read DAY-FIRST, says so, and offers the other reading — it does not OR both', () => {
  const d = parseOrderSearchDate('5-9', NOW)!;
  assert.equal(d.day_from, '2026-09-05', 'five September, which is how Iraq writes a date');
  assert.equal(d.day_to, '2026-09-05', 'ONE day — two unrelated days on one screen looks broken');
  assert.equal(d.assumed_day_first, true);
  assert.equal(d.flip_day, '2026-05-09', 'nine May, ready to be sent straight back as the query');
  // The flip is a real, sendable query and lands where it says it will.
  assert.equal(parseOrderSearchDate(d.flip_day!, NOW)!.day_from, '2026-05-09');

  // Unambiguous when the first number cannot be a month.
  const plain = parseOrderSearchDate('18-9', NOW)!;
  assert.equal(plain.assumed_day_first, false);
  assert.equal(plain.flip_day, null);
  // And month-first is only reachable when day-first is impossible.
  assert.equal(parseOrderSearchDate('9-18', NOW)!.day_from, '2026-09-18');
});

test('(b) 29 February looks back past the non-leap years instead of giving up', () => {
  const d = parseOrderSearchDate('29-2', NOW)!;
  assert.equal(d.day_from, '2024-02-29', '2026 and 2025 have no 29 February; 2024 does');
  // A one-year lookback would have returned null and sent this to the phone
  // reading, which finds nothing and says nothing.
  assert.equal(parseOrderSearchDate('31-2', NOW), null, 'and a date that never exists is still not a date');
});

test('(b) years and months, and the shapes deliberately refused', () => {
  const year = parseOrderSearchDate('2024', NOW)!;
  assert.equal(year.day_from, '2024-01-01');
  assert.equal(year.day_to, '2024-12-31');
  assert.equal(year.from, '2023-12-31T21:00:00.000Z');

  const month = parseOrderSearchDate('2026-02', NOW)!;
  assert.equal(month.day_from, '2026-02-01');
  assert.equal(month.day_to, '2026-02-28', 'the real last day, not a hardcoded 30');
  assert.equal(parseOrderSearchDate('2024-02', NOW)!.day_to, '2024-02-29');

  assert.equal(parseOrderSearchDate('18-9-26', NOW), null, 'a two-digit year is a guess with no honest default');
  assert.equal(parseOrderSearchDate('1999', NOW), null, 'before this shop existed');
  assert.equal(parseOrderSearchDate('1234', NOW), null, 'not a year — so the phone reading gets it');
  assert.equal(parseOrderSearchDate('9', NOW), null, 'a bare single number is not a date');
  assert.equal(parseOrderSearchDate('أحمد', NOW), null);

  // Arabic-Indic digits are a date too — the keyboard an Iraqi admin uses.
  assert.equal(parseOrderSearchDate('١٨-٩-٢٠٢٦', NOW)!.day_from, '2026-09-18');
});

// =========================================================================
// (c) THE CLASSIFIER TABLE — the decisions, one row each
// =========================================================================

const KIND = (q: string, now = NOW) => classifyOrderSearch(q, now).kind;

test('(c) the four readings are tried in a fixed order, and the table says which wins', () => {
  const table: [string, string, string][] = [
    ['ORD-3F2A9B1C0D', 'order_id', 'the shape a receipt carries'],
    ['ord-3f2a9b', 'order_id', 'case folded here, so the SQL needs no COLLATE NOCASE'],
    ['ORD 3F2A', 'order_id', 'a space where the dash should be'],
    ['07701234567', 'phone', 'ALL DIGITS IS A PHONE, NEVER AN ID — collision (1)'],
    ['٠٧٧٠١٢٣٤٥٦٧', 'phone', 'the same number on an Arabic keyboard'],
    ['+964 770 123 4567', 'phone', 'international, with the spaces people type'],
    ['009647701234567', 'phone', 'the 00 prefix'],
    ['0770-123-4567', 'phone', 'dashes inside a phone are not a date'],
    ['1234', 'phone', 'four digits OUTSIDE 2020–2100 is not a year'],
    ['2024', 'date', 'four digits INSIDE 2020–2100 IS a year — collision (2)'],
    ['2026-09-18', 'date', ''],
    ['18-9', 'date', ''],
    ['5-9', 'date', 'ambiguous, read day-first and flagged'],
    ['أحمد', 'name', ''],
    ['فاطمة الزهراء', 'name', ''],
    ['ahmed al-khafaji', 'name', ''],
    ['ORDER', 'name', 'not an id: `ORD` must be followed by hex'],
    ['ORD-ZZZZ', 'name', 'Z is not hex'],
    ['', 'none', ''],
    ['   ', 'none', ''],
    ['ا', 'none', 'one letter matches half the customer table'],
  ];
  for (const [q, want, why] of table) {
    assert.equal(KIND(q), want, `«${q}» should classify as ${want}${why ? ` — ${why}` : ''}`);
  }
});

test('(c) an order id keeps its prefix shape, upper-cased, ready for a PREFIX LIKE', () => {
  const s = classifyOrderSearch('ord-3f2a', NOW);
  assert.equal(s.kind, 'order_id');
  assert.equal(s.kind === 'order_id' && s.id_prefix, 'ORD-3F2A');
  // A prefix pattern, not a contains pattern: `o.id` is the primary key and a
  // leading `%` would throw its index away just as surely as COLLATE NOCASE.
  const pattern = likePattern('ORD-3F2A', 'prefix');
  assert.equal(pattern, 'ORD-3F2A%');
  assert.ok(patternBytes(pattern) <= D1_LIKE_PATTERN_MAX_BYTES);
});

test('(c) a phone search carries both keys: E.164 for identity, the national number for the suffix', () => {
  const s = classifyOrderSearch('07701234567', NOW);
  assert.equal(s.kind, 'phone');
  if (s.kind !== 'phone') return;
  assert.equal(s.phone.e164, '+9647701234567');
  assert.equal(s.phone.national, '7701234567');
  // Every shape of the SAME number produces the SAME suffix key, which is the
  // only reason one query finds both the legacy and the modern snapshot.
  for (const shape of ['+9647701234567', '009647701234567', '9647701234567', '+964-0770 123 4567', '٠٧٧٠١٢٣٤٥٦٧']) {
    assert.equal(phoneSearchKeys(shape).national, '7701234567', shape);
  }
  // A PARTIAL number still yields a key, because an admin reading digits off a
  // receipt has an invalid number until the very last one.
  assert.equal(phoneSearchKeys('077012').e164, null);
  assert.equal(phoneSearchKeys('077012').national, '77012');
  assert.equal(phoneSearchKeys('nothing here').national, '');
});

test('(c) a name search hands over a term folded the way the COLUMN is, never `normalizeText`', () => {
  const s = classifyOrderSearch('  فاطمة  ', NOW);
  assert.equal(s.kind, 'name');
  assert.equal(s.kind === 'name' && s.folded, foldForSql('فاطمة'));
  // The whole point: the term and the column come out of the same function.
  assert.equal(foldForSql('فاطمة'), foldForSql('فاطمه'));
});

test('(c) an Arabic name still fits D1`s 50-BYTE LIKE limit after folding', () => {
  // Arabic is two bytes a letter; a long name is well past 50 bytes wrapped in
  // two `%`, and `likePattern` is the only thing standing between that and a
  // D1_ERROR on the live admin screen.
  const long = 'عبد الرحمن بن عبد العزيز الخفاجي التميمي';
  const s = classifyOrderSearch(long, NOW);
  assert.equal(s.kind, 'name');
  const pattern = likePattern(s.kind === 'name' ? s.folded : '');
  assert.ok(patternBytes(pattern) <= D1_LIKE_PATTERN_MAX_BYTES, `${patternBytes(pattern)} bytes`);
});
