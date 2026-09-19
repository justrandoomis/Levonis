/**
 * ONE SEARCH BOX THAT DECIDES WHAT WAS TYPED.
 *
 * «كذلك أضف بحث في الطلبات» — one box. The obvious implementation is to search
 * everything four ways and OR the results together, and it is the wrong one:
 * an admin typing a phone number gets back an order whose id happens to
 * contain those digits, a customer named after a month appears in a date
 * search, and nobody can tell which of the four readings produced a row. A
 * search that hedges cannot be trusted, and an untrusted search is not used.
 *
 * So this classifier DECIDES. It tries four readings in a FIXED order and
 * returns the FIRST that hits:
 *
 *      ORDER ID  →  DATE  →  PHONE  →  NAME
 *
 * and the caller tells the screen which one won (`search_kind`), so the board
 * can say «بحث برقم الهاتف» with a one-tap «ابحث كاسم» beside it. That button
 * is the cheapest possible answer to a misclassification: instead of trying to
 * be right about every ambiguous string, be LEGIBLE about the guess and make
 * the correction one tap.
 *
 * ---------------------------------------------------------------------------
 *  THE TWO COLLISIONS, DECIDED RATHER THAN HEDGED
 * ---------------------------------------------------------------------------
 * 1. AN ALL-DIGIT RUN IS A PHONE, NEVER AN ORDER ID. An order id is `ORD-`
 *    plus hex, and an admin holding an order number is holding a receipt with
 *    `ORD-` printed on it — they will type it. An admin holding a phone number
 *    has only digits and nothing to prefix them with. So the id reading
 *    REQUIRES the `ORD-` prefix, which leaves every bare digit run to the
 *    phone reading with no overlap to arbitrate.
 *
 * 2. A BARE FOUR-DIGIT NUMBER IN 2020–2100 IS A YEAR. `2024` is a year and
 *    `1234` is the start of a phone number. The range is the whole rule: this
 *    shop did not exist before 2020 and an order cannot be placed after 2100,
 *    so no four-digit number outside it is a date anybody means.
 *
 * ---------------------------------------------------------------------------
 *  PURE, WITH THE CLOCK AS AN ARGUMENT
 * ---------------------------------------------------------------------------
 * `nowMs` is passed in, exactly as `deliveryDay.ts` takes `todayDay`. A date
 * search resolves a missing year against today, so a test has to be able to
 * put "today" at 22:00 UTC — the window where the UTC day and the Baghdad day
 * disagree — rather than hope the suite never runs then.
 */
import { addDays, baghdadDay, dayParts, isDay } from './baghdadTime';
import { foldForSql } from './sqlFold';
import { phoneSearchKeys, toAsciiDigits, type PhoneSearchKeys } from './phone';

/** Which reading won. `'none'` means nothing searchable was typed. */
export type OrderSearchKind = 'none' | 'order_id' | 'date' | 'phone' | 'name';

/**
 * A Baghdad civil day (or span of days) expressed as a HALF-OPEN UTC INSTANT
 * RANGE, because that is the only comparison `orders.created_at` supports
 * correctly.
 *
 * ############################################################################
 * #  `substr(created_at, 1, 10)` IS WRONG FOR THREE HOURS OF EVERY DAY       #
 * ############################################################################
 * `created_at` is UTC. Baghdad is UTC+3 with no DST, so the civil day D runs
 * from `D-1T21:00:00Z` to `DT21:00:00Z`. An order placed at 01:00 on the 19th
 * carries `2026-09-18T22:00:00.000Z`, and slicing ten characters off that
 * files it under the EIGHTEENTH. An admin searching «19-9» for the order a
 * customer placed just after midnight finds nothing, and there is no error to
 * explain it — the same off-by-one-day `worker/routes/rewards.ts` already
 * recorded and `baghdadTime.ts` exists to end.
 *
 * Both bounds are full fixed-width ISO instants, so the SQL comparison is a
 * plain string `>=` / `<` against the stored format and needs no date function
 * — which matters, because SQLite's `date('now')` is UTC and must never decide
 * a boundary here either.
 */
export interface OrderSearchDate {
  /** Inclusive lower bound, a UTC ISO instant. */
  from: string;
  /** EXCLUSIVE upper bound. Half-open, so no instant belongs to two days. */
  to: string;
  /** First Baghdad civil day covered, inclusive. */
  day_from: string;
  /** Last Baghdad civil day covered, inclusive. Equal to `day_from` for a day. */
  day_to: string;
  /**
   * True when `5-9` was read DAY-FIRST — 5 September — because that is how
   * Iraq writes dates. The flag exists so the screen can say so and offer the
   * other reading; see `flip_day`.
   */
  assumed_day_first: boolean;
  /** True when no year was typed and one was resolved BACKWARD from today. */
  assumed_year: boolean;
  /**
   * The day the OTHER reading of an ambiguous `5-9` would give, ready to be
   * sent straight back as the query for a one-tap flip. Null when there is no
   * second reading.
   *
   * THE ALTERNATIVE IS NOT SILENTLY OR-ED IN. Returning both 5 September and
   * 9 May in one result set shows an admin two unrelated days of orders, which
   * does not look like a helpful search — it looks like the software is
   * broken.
   */
  flip_day: string | null;
}

export type OrderSearch =
  | { kind: 'none'; raw: string }
  /** `id_prefix` is matched with a PREFIX LIKE against the primary key. */
  | { kind: 'order_id'; raw: string; id_prefix: string }
  | { kind: 'date'; raw: string; date: OrderSearchDate }
  | { kind: 'phone'; raw: string; phone: PhoneSearchKeys }
  /** `folded` has already been through `foldForSql` — bind it, do not re-fold. */
  | { kind: 'name'; raw: string; folded: string };

/** Before this the shop did not exist; after it, nobody is placing orders. */
const YEAR_MIN = 2020;
const YEAR_MAX = 2100;

/**
 * Order ids are `ORD-` + ten UPPERCASE hex characters (`newOrderId`). The
 * prefix is matched case-insensitively HERE, in TypeScript, and the term is
 * then upper-cased — so the SQL stays a plain `LIKE 'ORD-3F2A%'`.
 *
 * NOT `COLLATE NOCASE`. `orders.id` is the primary key and a NOCASE comparison
 * throws its index away, turning an order lookup into a full table scan. The
 * case fold costs nothing here and everything there.
 */
const ORDER_ID_RE = /^ORD[\s-]?([0-9A-F]{1,16})$/i;

/** Digits, and the punctuation people put between them when writing a phone. */
const PHONE_SHAPE_RE = /^\+?[\d\s\-().]+$/;
/** Below this a digit run is a fragment, not a number worth searching. */
const PHONE_MIN_DIGITS = 4;
/** A single letter matches half the customer table and ranks nothing. */
const NAME_MIN_CHARS = 2;

/**
 * What was typed, and which reading of it won.
 *
 * The order of the four blocks below IS the specification — moving one changes
 * which reading claims an ambiguous string.
 */
export function classifyOrderSearch(raw: unknown, nowMs: number): OrderSearch {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { kind: 'none', raw: '' };

  // 1. ORDER ID. Requires the `ORD-` a receipt carries, which is exactly what
  //    keeps a bare digit run out of this branch — see collision (1) above.
  const id = ORDER_ID_RE.exec(text);
  if (id) return { kind: 'order_id', raw: text, id_prefix: `ORD-${id[1].toUpperCase()}` };

  // 2. DATE. Before PHONE so `2024` and `18-9-2026` are read as the dates they
  //    plainly are rather than as digit runs.
  const date = parseOrderSearchDate(text, nowMs);
  if (date) return { kind: 'date', raw: text, date };

  // 3. PHONE. Everything that is digits and phone punctuation, long enough to
  //    be a number rather than a fragment.
  //
  //    THE SHAPE IS TESTED ON THE FOLDED TEXT, not the raw. «٠٧٧٠١٢٣٤٥٦٧» is
  //    the same number typed on the keyboard an Iraqi admin actually has, and
  //    an ASCII-only `\d` reads it as letters — so it fell through to the NAME
  //    reading and searched the customer table for a phone number, finding
  //    nothing and explaining nothing.
  if (PHONE_SHAPE_RE.test(toAsciiDigits(text))) {
    const phone = phoneSearchKeys(text);
    if (phone.digits.length >= PHONE_MIN_DIGITS) return { kind: 'phone', raw: text, phone };
  }

  // 4. NAME. The fallback, and folded HERE so the caller binds a term folded
  //    exactly the way the column is — see worker/lib/sqlFold.ts.
  const folded = foldForSql(text).trim();
  if (folded.length >= NAME_MIN_CHARS) return { kind: 'name', raw: text, folded };

  return { kind: 'none', raw: text };
}

/**
 * A typed date → the UTC instant range covering the Baghdad civil day(s) it
 * names, or null when the text is not a date at all.
 *
 * SHAPES ACCEPTED, separated by `-`, `/`, `.` or spaces:
 *
 *   2026            a whole year
 *   2026-09         a whole month
 *   2026-09-18      one day, unambiguous — a four-digit part can only be a year
 *   18-9-2026       one day, day-first
 *   18-9            one day, year resolved BACKWARD
 *
 * SHAPES DELIBERATELY REFUSED: a two-digit year (`18-9-26`). Guessing a
 * century is a guess with no honest default, and the string falls through to
 * the phone reading rather than quietly meaning 1926.
 *
 * THE YEAR RESOLVES BACKWARD BECAUSE ORDERS ARE IN THE PAST. On 1 February, an
 * admin typing `28-12` means last December — the order they are chasing has
 * already been placed. Resolving forward would return an empty screen every
 * time, which reads as "no such order" rather than "wrong year".
 */
export function parseOrderSearchDate(text: unknown, nowMs: number): OrderSearchDate | null {
  const raw = typeof text === 'string' ? toAsciiDigits(text).trim() : '';
  if (!raw) return null;
  const parts = raw.split(/[-/.\s]+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 3) return null;
  if (!parts.every((p) => /^\d{1,4}$/.test(p))) return null;

  const today = baghdadDay(nowMs);
  if (!isDay(today)) return null;
  const n = parts.map(Number);

  // ---- a bare year: 2024
  if (parts.length === 1) {
    if (parts[0].length !== 4 || !inYearRange(n[0])) return null;
    return range(`${n[0]}-01-01`, `${n[0]}-12-31`, false, false, null);
  }

  // ---- a month: 2026-09
  if (parts.length === 2 && parts[0].length === 4) {
    if (!inYearRange(n[0]) || n[1] < 1 || n[1] > 12) return null;
    const first = `${n[0]}-${pad(n[1])}-01`;
    if (!dayParts(first)) return null;
    return range(first, lastDayOfMonth(n[0], n[1]), false, false, null);
  }

  // ---- a day with its year: 2026-09-18 or 18-9-2026
  if (parts.length === 3) {
    if (parts[0].length === 4) {
      const day = makeDay(n[0], n[1], n[2]);
      return day ? range(day, day, false, false, null) : null;
    }
    if (parts[2].length === 4) {
      // Day-first, which is how Iraq writes a date. Month-first is only
      // reachable when the first number cannot be a month.
      const dayFirst = makeDay(n[2], n[1], n[0]);
      const monthFirst = makeDay(n[2], n[0], n[1]);
      if (dayFirst) {
        const ambiguous = monthFirst !== null && monthFirst !== dayFirst;
        return range(dayFirst, dayFirst, ambiguous, false, ambiguous ? monthFirst : null);
      }
      return monthFirst ? range(monthFirst, monthFirst, false, false, null) : null;
    }
    return null; // a two-digit year — see the note above
  }

  // ---- a day with no year: 18-9 / 5-9
  const dayFirst = backward(n[0], n[1], today);
  const monthFirst = backward(n[1], n[0], today);
  if (dayFirst) {
    const ambiguous = monthFirst !== null && monthFirst !== dayFirst;
    return range(dayFirst, dayFirst, ambiguous, true, ambiguous ? monthFirst : null);
  }
  return monthFirst ? range(monthFirst, monthFirst, false, true, null) : null;
}

/**
 * The most recent `day`/`month` at or before today, looking back far enough to
 * land on 29 February.
 *
 * FOUR YEARS, NOT ONE. `29-2` typed in a non-leap year has no answer this year
 * or last; the nearest real 29 February can be three years back. Returning
 * null there would send a perfectly good date search off to the phone reading.
 */
function backward(day: number, month: number, today: string): string | null {
  const year = Number(today.slice(0, 4));
  for (let y = year; y >= year - 4; y--) {
    const candidate = makeDay(y, month, day);
    if (candidate && candidate <= today) return candidate;
  }
  return null;
}

/** A calendar-valid 'YYYY-MM-DD', or null. `dayParts` rejects 31 February. */
function makeDay(y: number, m: number, d: number): string | null {
  if (!inYearRange(y) || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const s = `${y}-${pad(m)}-${pad(d)}`;
  return dayParts(s) ? s : null;
}

/**
 * Two Baghdad civil days (inclusive) → the half-open UTC instant range that
 * covers them.
 *
 * Baghdad day D starts at `D-1T21:00:00Z`. Both bounds are built from that one
 * fact and nothing else — no Date, no timezone, no `date('now')`.
 */
function range(
  dayFrom: string,
  dayTo: string,
  assumedDayFirst: boolean,
  assumedYear: boolean,
  flipDay: string | null
): OrderSearchDate | null {
  const start = addDays(dayFrom, -1);
  if (!start || !isDay(dayTo)) return null;
  return {
    from: `${start}T21:00:00.000Z`,
    to: `${dayTo}T21:00:00.000Z`,
    day_from: dayFrom,
    day_to: dayTo,
    assumed_day_first: assumedDayFirst,
    assumed_year: assumedYear,
    flip_day: flipDay,
  };
}

/** 28, 29, 30 or 31 — day 0 of the next month, which `Date.UTC` normalises. */
function lastDayOfMonth(y: number, m: number): string {
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

const inYearRange = (y: number): boolean => Number.isInteger(y) && y >= YEAR_MIN && y <= YEAR_MAX;
const pad = (n: number): string => String(n).padStart(2, '0');
