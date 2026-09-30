/**
 * «مفتوح الآن؟» — a store's opening hours, read at ONE instant, in Baghdad.
 *
 * The merchant writes hours as rows of `{day, open, close, closed?}`
 * (worker/routes/merchant.ts `sanitizeHours`): `day` is FREE TEXT from a
 * datalist («السبت», «السبت - الخميس», «كل الأيام», «Saturday», «شەممە»…),
 * the times are «HH:MM». This module turns those rows into one answer —
 * `open_now` and the instant it next changes — so the workspace's status
 * strip, the storefront and the chat thread all say the same word, and none
 * of them re-implements the week.
 *
 * WHAT IT ANSWERS, AND WHAT IT REFUSES TO GUESS.
 *   · `open_now: true|false` only when at least one row names a day it can
 *     read AND carries an opening time. A store with no hours, hours written
 *     as prose («حسب الاتفاق»), or only «مغلق» rows answers `null` — the UI
 *     then says nothing about the clock instead of inventing «مغلق».
 *   · A row whose day it cannot read is skipped, never mis-filed: a typo does
 *     not move Friday's hours to Saturday.
 *   · «مغلق» on a day wins over any «كل الأيام» row: the specific word is the
 *     merchant's correction of the general one.
 *   · A range that ends at or before it starts («18:00 – 02:00», «00:00 –
 *     00:00») runs into the next day — an overnight shift, or all day.
 *   · `next_change_at` is the end of the current open stretch (adjacent and
 *     overlapping rows merged), or the next opening within a week; `null`
 *     when nothing changes in the coming week.
 *   · Away (`away_until` in the future, P7's vacation) closes the store until
 *     that instant; the next change is the vacation's end, or the first
 *     opening after it if the shop would still be shut then.
 *
 * BAGHDAD, ALWAYS (worker/lib/baghdadTime.ts): Iraq has no DST, so the
 * local clock is one addition. `nowMs` is the server's `Date.now()` on the
 * server; on the client it is the reader's clock, which is why the storefront
 * (served to guests from the edge cache for up to 120 s) re-runs this same
 * function once `next_change_at` has passed (`nextChangePassed`).
 *
 * THIS IS A LEAF MODULE, like baghdadTime.ts: no worker imports, so the
 * client may import it too (src/components/merchant/counter/StatusStrip.tsx).
 */
import { BAGHDAD_OFFSET_MS } from './baghdadTime';

export interface HoursRowLike {
  day?: unknown;
  open?: unknown;
  close?: unknown;
  closed?: unknown;
}

export interface OpenNow {
  /** `null`: the hours do not say (none written, or none readable). */
  open_now: boolean | null;
  /** ISO instant of the next flip, or `null` when nothing changes within a week. */
  next_change_at: string | null;
}

const NOTHING: OpenNow = { open_now: null, next_change_at: null };
const DAY_MIN = 1440;
const DAY_MS = 86_400_000;

// ------------------------------------------------------------ the words

/**
 * Letters that spell the same day two ways are folded before matching:
 * diacritics and tatweel dropped, the alef and yeh variants merged, the
 * Kurdish kaf/yeh/heh (ک ی ە) folded onto the Arabic letters, ZWNJ removed —
 * «یەکشەممە», «يه‌كشه‌ممه» and «یەکشەمە» all become one key.
 */
function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ً-ْٰـ‌‍]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/[ىی]/g, 'ي')
    .replace(/ک/g, 'ك')
    .replace(/[ەة]/g, 'ه')
    .replace(/[ڕ]/g, 'ر')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 0 = Sunday … 6 = Saturday, as `Date#getUTCDay` counts. */
const DAY_WORDS: Array<[number, string[]]> = [
  [6, ['السبت', 'سبت', 'saturday', 'sat', 'شەممە', 'شەمە', 'شەم']],
  [0, ['الأحد', 'احد', 'sunday', 'sun', 'یەکشەممە', 'یەکشەمە', 'یەکشەم', 'یەک شەممە']],
  [1, ['الاثنين', 'الإثنين', 'اثنين', 'الاتنين', 'monday', 'mon', 'دووشەممە', 'دوشەممە', 'دووشەمە', 'دووشەم', 'دوو شەممە']],
  [2, ['الثلاثاء', 'ثلاثاء', 'الثلاثا', 'tuesday', 'tue', 'tues', 'سێشەممە', 'سیشەممە', 'سێشەمە', 'سێشەم', 'سێ شەممە']],
  [3, ['الأربعاء', 'اربعاء', 'الاربعا', 'wednesday', 'wed', 'چوارشەممە', 'چوارشەمە', 'چوارشەم', 'چوار شەممە']],
  [4, ['الخميس', 'خميس', 'thursday', 'thu', 'thur', 'thurs', 'پێنجشەممە', 'پینجشەممە', 'پێنجشەمە', 'پێنجشەم', 'پێنج شەممە']],
  [5, ['الجمعة', 'جمعة', 'الجمعه', 'friday', 'fri', 'هەینی', 'هەيني', 'جومعە', 'جومعه']],
];
const EVERY_DAY = [
  'كل الأيام', 'كل الايام', 'كل يوم', 'يوميا', 'يومياً', 'يومیا', 'طوال الأسبوع', 'طوال الاسبوع', 'جميع الأيام', 'جميع الايام',
  'every day', 'everyday', 'daily', 'all days', 'all week', 'the whole week',
  'هەموو ڕۆژێک', 'هەموو ڕۆژەکان', 'ڕۆژانە', 'هەموو ڕۆژ',
];

const DAY_LOOKUP = new Map<string, number>();
for (const [dow, words] of DAY_WORDS) for (const w of words) DAY_LOOKUP.set(fold(w), dow);
const EVERY_LOOKUP = new Set(EVERY_DAY.map(fold));
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** One word → one weekday, or -1. Tolerates a leading «يوم» / «ڕۆژی» / «day». */
function dayOf(token: string): number {
  let t = fold(token).replace(/^(يوم|رۆژي|day)\s+/u, '').trim();
  if (!t) return -1;
  const direct = DAY_LOOKUP.get(t);
  if (direct !== undefined) return direct;
  // «الجمعه» / «الاحد» without the article, and «sat.» with a trailing dot.
  t = t.replace(/\.$/, '');
  if (t.startsWith('ال')) {
    const bare = DAY_LOOKUP.get(t.slice(2));
    if (bare !== undefined) return bare;
  } else {
    const article = DAY_LOOKUP.get(`ال${t}`);
    if (article !== undefined) return article;
  }
  return -1;
}

/**
 * The weekdays a `day` text names: a single day, a list («السبت، الأحد»), an
 * inclusive range in either script («السبت - الخميس», «Sat–Thu», «شەممە تا
 * پێنجشەممە»), or every day. Empty when nothing in it can be read.
 */
export function parseDays(text: unknown): number[] {
  if (typeof text !== 'string') return [];
  const raw = text.trim();
  if (!raw) return [];
  if (EVERY_LOOKUP.has(fold(raw))) return ALL_DAYS;
  const range = raw.split(/\s*[-–—]\s*|\s+(?:to|إلى|الى|حتى|لغاية|هەتا|تا|بۆ)\s+/u);
  if (range.length === 2) {
    const a = dayOf(range[0]);
    const b = dayOf(range[1]);
    if (a >= 0 && b >= 0) {
      const out: number[] = [];
      for (let d = a; ; d = (d + 1) % 7) {
        out.push(d);
        if (d === b || out.length === 7) break;
      }
      return out;
    }
  }
  const out = new Set<number>();
  for (const part of raw.split(/\s*[,،/&+]\s*|\s+and\s+|\s+و(?=\S)/u)) {
    const d = dayOf(part);
    if (d >= 0) out.add(d);
  }
  return [...out].sort((x, y) => x - y);
}

/** «9:00» / «21:30» / «24:00» → minutes from midnight, or -1. */
function minutesOf(v: unknown): number {
  if (typeof v !== 'string') return -1;
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(v);
  if (!m) return -1;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min > 0)) return -1;
  return h * 60 + min;
}

interface Rule {
  days: number[];
  closed: boolean;
  open: number;
  close: number;
}

function parseRules(rows: unknown): Rule[] {
  if (!Array.isArray(rows)) return [];
  const out: Rule[] = [];
  for (const r of rows.slice(0, 14)) {
    if (!r || typeof r !== 'object') continue;
    const row = r as HoursRowLike;
    const days = parseDays(row.day);
    if (!days.length) continue;
    if (row.closed === true) {
      out.push({ days, closed: true, open: 0, close: 0 });
      continue;
    }
    const open = minutesOf(row.open);
    const close = minutesOf(row.close);
    // A row with a day and no readable times is prose («بعد الظهر») — skipped, not guessed.
    if (open < 0 || close < 0) continue;
    out.push({ days, closed: false, open, close });
  }
  return out;
}

// ------------------------------------------------------------ the answer

/**
 * Is the store open at `nowMs`, and when does that change?
 *
 * `hours` is the stored `business_hours` (already parsed JSON, any shape —
 * a bad value is «no hours»). `awayUntil` is an ISO instant or null (P7's
 * vacation; pass null until the column exists). `nowMs` is the server's
 * clock on the server — never a value from the request.
 */
export function openNow(hours: unknown, awayUntil: string | null | undefined, nowMs: number): OpenNow {
  if (!Number.isFinite(nowMs)) return NOTHING;
  const away = awayUntil ? Date.parse(awayUntil) : NaN;
  if (Number.isFinite(away) && away > nowMs) {
    // Shut for the vacation; afterwards the hours decide — if they would still
    // be shut at that instant, the next change is their first opening after it.
    const then = openNow(hours, null, away);
    return { open_now: false, next_change_at: then.open_now === false ? then.next_change_at : new Date(away).toISOString() };
  }
  const rules = parseRules(hours);
  if (!rules.some((r) => !r.closed)) return NOTHING;

  const local = nowMs + BAGHDAD_OFFSET_MS;
  const midnight = Math.floor(local / DAY_MS) * DAY_MS;
  const t = (local - midnight) / 60_000;
  const todayDow = new Date(midnight).getUTCDay();

  // Every open stretch from yesterday (an overnight shift still running) to a
  // week ahead, in minutes from today's local midnight.
  const stretches: Array<[number, number]> = [];
  for (let off = -1; off <= 7; off++) {
    const dow = (todayDow + off + 7) % 7;
    if (rules.some((r) => r.closed && r.days.includes(dow))) continue;
    for (const r of rules) {
      if (r.closed || !r.days.includes(dow)) continue;
      const start = off * DAY_MIN + r.open;
      const end = off * DAY_MIN + (r.close <= r.open ? r.close + DAY_MIN : r.close);
      stretches.push([start, end]);
    }
  }
  stretches.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const s of stretches) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  const at = (min: number) => new Date(midnight + min * 60_000 - BAGHDAD_OFFSET_MS).toISOString();
  for (const [start, end] of merged) {
    if (start <= t && t < end) return { open_now: true, next_change_at: at(end) };
    if (start > t) return { open_now: false, next_change_at: at(start) };
  }
  return { open_now: false, next_change_at: null };
}

/**
 * Has the instant the server named already passed on this clock? The
 * storefront's cached body may be up to two minutes old; when this is true
 * the client runs `openNow` itself over the same `business_hours`.
 */
export function nextChangePassed(state: Pick<OpenNow, 'next_change_at'> | null | undefined, nowMs: number): boolean {
  const iso = state?.next_change_at;
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t <= nowMs;
}

/**
 * Whole Baghdad calendar days from `fromMs` to `toMs` (0 = the same day,
 * 1 = tomorrow, …) — for «يفتح غدًا 9:00» versus «يفتح السبت 9:00».
 */
export function baghdadDaysBetween(fromMs: number, toMs: number): number {
  const day = (ms: number) => Math.floor((ms + BAGHDAD_OFFSET_MS) / DAY_MS);
  return day(toMs) - day(fromMs);
}

/** The Baghdad weekday of an instant, 0 = Sunday … 6 = Saturday. */
export function baghdadWeekday(ms: number): number {
  return new Date(Math.floor((ms + BAGHDAD_OFFSET_MS) / DAY_MS) * DAY_MS).getUTCDay();
}
