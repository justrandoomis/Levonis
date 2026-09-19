/**
 * «يستطيع اختيار وتغيير يوم التوصيل في أي وقت يريد ولكن بحد أقصى أسبوع»
 * THE CUSTOMER CHOOSES THE DELIVERY DAY — and the ceiling on that choice.
 *
 * PURE, AND `now` IS AN ARGUMENT. Nothing here reads a clock, a database or a
 * settings row; `todayDay` is passed in, exactly as `orderStages.ts` takes its
 * `now`. That is what lets a test put an order at 22:30 UTC on the 18th — the
 * instant where a UTC day and a Baghdad day disagree — instead of hoping the
 * suite never runs in that three-hour window.
 *
 * ---------------------------------------------------------------------------
 *  THE CEILING IS FROZEN, NOT ROLLING  — owner decision (ب)
 * ---------------------------------------------------------------------------
 * «الأسبوع أقصد به مدة سبعة أيام من تاريخ الطلب» — seven days from the ORDER
 * date. So the ceiling is computed ONCE, from the order's own anchor day, and
 * written to the row (`orders.delivery_day_window_end`). It is never
 * recomputed from today.
 *
 * A ROLLING WINDOW IS NOT A CEILING. Recompute "today + 7" each time the
 * customer opens the picker and they can move 18-9 → 25-9, then next week
 * 25-9 → 2-10, for ever, in weekly hops — each single step looking perfectly
 * legal. A test that moves the day once cannot see this; `tests/
 * deliveryDay.test.ts` moves it twice for that reason.
 *
 * ---------------------------------------------------------------------------
 *  THE ANCHOR IS baghdadDayOf(created_at), NEVER created_at.slice(0, 10)
 * ---------------------------------------------------------------------------
 * An order placed at 01:00 Baghdad on the 19th carries
 * `created_at = '2026-09-18T22:00:00Z'`. Slicing that string anchors the
 * window on the 18th and silently sells that customer a six-day week. It is
 * the same off-by-one-day the rewards route already paid for, and it is
 * invisible for twenty-one hours out of every twenty-four.
 *
 * ---------------------------------------------------------------------------
 *  WHY dayLabel IS HERE, ON THE SERVER
 * ---------------------------------------------------------------------------
 * The same division `/tracking` already uses: the server localises, the SPA
 * renders a string it was handed. `new Date('2026-09-23').toLocaleDateString()`
 * in a browser west of Baghdad parses that as UTC midnight, converts to local
 * time and renders the TWENTY-SECOND — the customer picks Wednesday and the
 * confirmation says Tuesday. The label is computed once, from the same day
 * string the row stores, in whichever of the three languages was asked for.
 */

import { addDays, dayOfWeek, dayParts, isDay } from './baghdadTime';

// ============================================================ the policy

export interface DeliveryDayPolicy {
  /** Is the customer offered a day at all? */
  enabled: boolean;
  /** How many days past the ORDER day the ceiling sits. Clamped 1..30. */
  max_days: number;
  /** May the chosen day be today, or does the offer start tomorrow? */
  allow_same_day: boolean;
}

/** The shortest window that still is one. 0 would mean "no choice at all". */
export const MIN_DELIVERY_DAYS = 1;
/** Past a month this is a pre-order, which is a different scope of the board. */
export const MAX_DELIVERY_DAYS = 30;

/**
 * SHIPPED ENABLED, AND THAT IS A DELIBERATE DEVIATION FROM THE HOUSE DEFAULT.
 *
 * Every other new policy in this codebase ships off — `orderExpiryConfig`,
 * `printerGiftConfig`, `preorderGiftConfig`, `minMarginPercent` — so that a
 * deploy changes nothing until an owner chooses. This one ships ON, with
 * `max_days: 7`, because the owner asked for the feature directly and named
 * the number: «بحد أقصى أسبوع», and «الأسبوع أقصد به مدة سبعة أيام من تاريخ
 * الطلب».
 *
 * It is written down here so that a reader who knows the house rule sees a
 * decision rather than an oversight.
 *
 * NOTHING DEPLOYED CHANGES ANYWAY, and that is the other half of the
 * guarantee: migration 0094 backfills nothing. Every existing row keeps
 * `delivery_day_schedulable = 0` and a NULL day, so this policy first has an
 * effect on the first NEW checkout after the deploy.
 */
export const DEFAULT_DELIVERY_DAY_POLICY: DeliveryDayPolicy = {
  enabled: true,
  max_days: 7,
  allow_same_day: true,
};

/**
 * Merges a stored value over the defaults and clamps it — the same contract
 * `resolveOrderExpiry` and `resolveDurations` have, and for the same reason:
 * `settings.ts` normalises on the way OUT and the admin route validates on the
 * way IN, so what is stored is what runs.
 *
 * `max_days` is clamped rather than rejected. A junk 0 would offer an empty
 * picker with no error anywhere, and a junk 10_000 would let a customer park
 * an order in 2054 — both of which look like working software.
 */
export function resolveDeliveryDayPolicy(stored: unknown): DeliveryDayPolicy {
  const out: DeliveryDayPolicy = { ...DEFAULT_DELIVERY_DAY_POLICY };
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return out;
  const raw = stored as Record<string, unknown>;

  if (raw.enabled !== undefined) out.enabled = truthy(raw.enabled);
  if (raw.allow_same_day !== undefined) out.allow_same_day = truthy(raw.allow_same_day);

  const days = num(raw.max_days);
  if (days !== null) out.max_days = Math.min(MAX_DELIVERY_DAYS, Math.max(MIN_DELIVERY_DAYS, Math.round(days)));

  return out;
}

// ============================================================ the window

export interface DeliveryWindow {
  /** The earliest day still offered — moves forward with today. */
  start: string;
  /** THE FROZEN CEILING: anchor + max_days. Never recomputed from today. */
  end: string;
  /** Every day from `start` to `end` inclusive; empty when nothing is offered. */
  days: string[];
}

export interface DeliveryWindowInput {
  /** `baghdadDayOf(order.created_at)`. NOT `created_at.slice(0, 10)`. */
  anchorDay: string;
  /** `baghdadDay(Date.now())` — the server's Baghdad day, never the client's. */
  todayDay: string;
  policy: DeliveryDayPolicy;
}

/**
 * What the customer may choose from, right now, for an order anchored on
 * `anchorDay`.
 *
 * TWO ENDS, TWO DIFFERENT CLOCKS, and mixing them up is the whole bug class:
 *
 *   `end`   comes from the ANCHOR and is therefore fixed for the life of the
 *           order. This is the value checkout freezes onto the row.
 *   `start` comes from TODAY, because yesterday cannot be offered however
 *           generous the policy is. It walks forward until it passes `end`,
 *           at which point the window is closed and `days` is empty.
 *
 * `end` is still reported when the window is closed or the policy is off, so
 * an admin screen can say WHICH ceiling was reached rather than showing a
 * blank. Only `days` decides what may be picked.
 */
export function deliveryWindow({ anchorDay, todayDay, policy }: DeliveryWindowInput): DeliveryWindow {
  const anchor = isDay(anchorDay) ? anchorDay : '';
  const today = isDay(todayDay) ? todayDay : '';
  if (!anchor || !today) return { start: '', end: '', days: [] };

  const end = addDays(anchor, policy.max_days);

  // The floor: today, or tomorrow when same-day is switched off — but never
  // before the order itself existed, which matters for a row whose anchor is
  // in the future because an admin corrected a clock.
  const floor = policy.allow_same_day ? today : addDays(today, 1);
  const start = floor > anchor ? floor : anchor;

  if (!policy.enabled || !end || !start || start > end) return { start, end, days: [] };

  // Bounded by MAX_DELIVERY_DAYS + 1 entries by construction, so this cannot
  // become an unbounded loop on a corrupt pair of dates.
  const days: string[] = [];
  for (let d = start; d && d <= end; d = addDays(d, 1)) days.push(d);
  return { start, end, days };
}

// ============================================================ validation

/**
 * 'ok'            the day may be written to the row.
 * 'PAST'          the customer asked for a day that has already gone.
 * 'BEYOND_WINDOW' past the frozen ceiling — «بحد أقصى أسبوع».
 * 'BAD_FORMAT'    not a 'YYYY-MM-DD' civil day, or the row carries no ceiling
 *                 to measure against (see below).
 */
export type DeliveryDayCheck = 'ok' | 'PAST' | 'BEYOND_WINDOW' | 'BAD_FORMAT';

export interface DeliveryDayCheckInput {
  /** What the customer asked for. The only untrusted value here. */
  requested: string;
  /** The server's Baghdad day. */
  todayDay: string;
  /** `orders.delivery_day_window_end`, frozen at checkout. */
  windowEnd: string;
}

/**
 * THE FLOOR AND THE CEILING. Two facts, checked in the order a customer would
 * notice them.
 *
 * WHAT THIS DELIBERATELY DOES NOT CHECK: `allow_same_day`. It is not given the
 * policy, and it should not be — same-day is a question about what is OFFERED,
 * which is `deliveryWindow().days`. A caller that lets a customer pick a day
 * outside that list has already skipped the offer; this function is the last
 * guard on the two facts that hold whatever the policy says.
 *
 * AN ABSENT `windowEnd` IS BAD_FORMAT, NOT AN OPEN WINDOW. A row with no
 * frozen ceiling — every row that predates migration 0094, and every merchant
 * or pickup order — is not schedulable at all, and the caller must have
 * checked `delivery_day_schedulable` before asking. Treating an empty ceiling
 * as "no limit" would turn the one row shape that must refuse a day into the
 * one row shape that accepts any day.
 */
export function validateDeliveryDay({ requested, todayDay, windowEnd }: DeliveryDayCheckInput): DeliveryDayCheck {
  if (!dayParts(requested) || !isDay(todayDay) || !isDay(windowEnd)) return 'BAD_FORMAT';
  // Lexicographic on fixed-width civil days == chronological. No Date, no zone.
  if (requested < todayDay) return 'PAST';
  if (requested > windowEnd) return 'BEYOND_WINDOW';
  return 'ok';
}

// ============================================================ the label

export type DeliveryDayLang = 'ar' | 'en' | 'ckb';

export interface DayLabel {
  /** Ready to render. The SPA never re-formats this. */
  label: string;
  is_today: boolean;
  is_tomorrow: boolean;
}

/** Sunday-first, matching `Date.prototype.getUTCDay()`. */
const WEEKDAYS: Record<DeliveryDayLang, string[]> = {
  ar: ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  ckb: ['یەکشەممە', 'دووشەممە', 'سێشەممە', 'چوارشەممە', 'پێنجشەممە', 'هەینی', 'شەممە'],
};

/**
 * The Levantine/Iraqi month names, not the transliterated ones — «أيلول», not
 * «سبتمبر». Identical to the list `worker/lib/warrantyDoc.ts` prints on a
 * warranty receipt, so a customer comparing a screen with a printed document
 * reads the same month name on both.
 */
const MONTHS: Record<DeliveryDayLang, string[]> = {
  ar: [
    'كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران',
    'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول',
  ],
  en: [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ],
  ckb: [
    'کانوونی دووەم', 'شوبات', 'ئازار', 'نیسان', 'ئایار', 'حوزەیران',
    'تەمموز', 'ئاب', 'ئەیلوول', 'تشرینی یەکەم', 'تشرینی دووەم', 'کانوونی یەکەم',
  ],
};

const TODAY_WORD: Record<DeliveryDayLang, string> = { ar: 'اليوم', en: 'Today', ckb: 'ئەمڕۆ' };
const TOMORROW_WORD: Record<DeliveryDayLang, string> = { ar: 'غدًا', en: 'Tomorrow', ckb: 'بەیانی' };

/**
 * A day, written the way a customer in Iraq would say it: «اليوم», «غدًا», or
 * «الأربعاء ٢٣ أيلول».
 *
 * THE RELATIVE WORDS ARE COMPUTED FROM `todayDay`, the server's Baghdad day —
 * which is the second half of why this is not done in the browser. A phone
 * left on yesterday's date, or simply in another timezone, renders "tomorrow"
 * over a day that is today.
 *
 * ARABIC-INDIC DIGITS for `ar` and `ckb`, Latin for `en`. Iraqi Kurdish is
 * written with the same ٠-٩ as Arabic here rather than the Persian ۰-۹, which
 * is what the rest of this codebase already folds (`worker/lib/phone.ts`).
 */
export function dayLabel(day: string, todayDay: string, lang: string): DayLabel {
  const L: DeliveryDayLang = lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar';
  const parts = dayParts(day);
  const is_today = parts !== null && isDay(todayDay) && day === todayDay;
  const is_tomorrow = parts !== null && isDay(todayDay) && day === addDays(todayDay, 1);

  if (!parts) return { label: '', is_today: false, is_tomorrow: false };
  if (is_today) return { label: TODAY_WORD[L], is_today, is_tomorrow: false };
  if (is_tomorrow) return { label: TOMORROW_WORD[L], is_today: false, is_tomorrow };

  const weekday = WEEKDAYS[L][dayOfWeek(day)] ?? '';
  const month = MONTHS[L][parts.m - 1] ?? '';
  const dayNo = L === 'en' ? String(parts.d) : arabicIndic(parts.d);
  return { label: `${weekday} ${dayNo} ${month}`.trim(), is_today: false, is_tomorrow: false };
}

/** ASCII digits → ٠-٩. The inverse of the fold `phone.ts` applies on input. */
function arabicIndic(n: number): string {
  return String(n).replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)));
}

function truthy(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true';
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
