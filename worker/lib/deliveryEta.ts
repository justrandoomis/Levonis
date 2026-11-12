/**
 * «كل الطلبات تُجهَّز وتُسلَّم لمندوب شركة التوصيل الساعة ٧ مساءً» — WHEN THE
 * PARCEL LEAVES, AND WHEN IT SHOULD REACH THE CUSTOMER'S GOVERNORATE.
 *
 * The owner, 2026-11-11 (DECISIONS row 324): every order is prepared and handed
 * to the delivery company's courier at 7 pm, so an order placed at 8 pm leaves
 * a day later — order before 7 pm. From the warehouse in Hillah (Babil) the
 * near governorates are about 17 hours after the handover (Baghdad: an order at
 * 1 pm arrives the next day around 11 am, between 10 am and 3 pm; one at 7:30 pm
 * a day later), the far ones such as Basra the next evening between 6 and 8 pm,
 * and the Kurdistan Region the day after next at night — later still, because
 * the checkpoints are very slow.
 *
 * THE OWNER'S ANSWERS SHAPE WHAT THIS DOES NOT DO. Asked whether the customer's
 * delivery-day picker should refuse days the courier cannot meet, the owner
 * answered «only add the note»: `deliveryDay.ts`, its offered days and the
 * server's refusals are untouched, and nothing here is imported by them. This
 * module only WORDS an estimate for the checkout note (and the admin control
 * that edits it); no order, price or day is decided from it.
 *
 * THE TIERS ARE THE OWNER'S TABLE, EDITABLE PER GOVERNORATE in «إدارة التوصيل»
 * (`deliveryHandover.tiers` holds only the governorates moved off this table).
 * The arrival windows are constants — the hours are the owner's words, and
 * changing them is a copy change, not a setting.
 *
 * A LEAF, like `deliveryDay.ts` and `baghdadTime.ts`: it imports those two and
 * the governorate table (a leaf itself) and nothing that could reach
 * `settings.ts` — settings.ts imports THIS module's resolver, and a cycle
 * through it leaves a module constant undefined at runtime with no type error.
 * `now` is always an argument; nothing here reads a clock.
 */

import { addDays, BAGHDAD_OFFSET_MS, baghdadDay, dayOfWeek, dayParts } from './baghdadTime';
import { dayLabel, WEEKDAYS } from './deliveryDay';
import { IRAQ_GOVERNORATES, governorateName, normalizeGovernorate } from '../../packages/shipping/src/iraqGovernorates';

// ============================================================ the policy

export type EtaTier = 'near' | 'far' | 'kurdistan';
export const ETA_TIERS: readonly EtaTier[] = ['near', 'far', 'kurdistan'];
export type EtaLang = 'ar' | 'en' | 'ckb';

export interface DeliveryHandoverPolicy {
  /** The owner's off switch: false draws no note anywhere. */
  enabled: boolean;
  /** The daily handover, as a Baghdad hour within `HANDOVER_HOURS` (12..23) — 19 is «الساعة ٧ مساءً». */
  hour: number;
  /** Governorates moved off `DEFAULT_ETA_TIERS`, by id. Only real differences are kept. */
  tiers: Partial<Record<string, EtaTier>>;
  /** Weekdays with no handover (0 = Sunday). Empty: the courier comes «كل يوم». At most 6. */
  closed_weekdays: number[];
}

export const DEFAULT_HANDOVER_HOUR = 19;

/**
 * THE HOURS A HANDOVER MAY BE SET TO: noon to 11 pm (the independent review,
 * 2026-11-12). The arrival windows below are the owner's words for an EVENING
 * handover — next day 10–15, next day 18–20, the day after next at night — and
 * they are constants: a midnight handover read «فات تسليم اليوم (الساعة ١٢
 * ليلًا)» all day and put Baghdad two days out, and a morning one promised
 * «the next day» to a parcel that leaves at breakfast. The admin's select
 * offers these hours only, the PUT refuses any other, and a stored hour outside
 * them reads as the owner's 7 pm.
 */
export const HANDOVER_HOURS = { min: 12, max: 23 } as const;

/**
 * THE BOARD'S PREPARATION DAY (owner, 2026-11-11: «1 day everywhere»): a
 * courier order with a chosen delivery day is prepared and handed to the
 * courier the day BEFORE that day — the Kurdistan Region too — and the orders
 * board (another lane) files it there. The note names the same handover for a
 * picked day, so the customer and the warehouse are told one day. Under the
 * owner's own windows a Kurdistan parcel handed over the day before arrives a
 * day after the picked day, and the note says so rather than promising the
 * picked day (DECISIONS row 324, the review; the owner's call whether Kurdistan
 * should be prepared two days ahead instead — this number and the board's
 * change together).
 */
export const PREP_LEAD_DAYS = 1;

/**
 * SHIPPED ON, like `DEFAULT_DELIVERY_DAY_POLICY` and for the same reason: the
 * owner asked for the note itself («Add a note on the website»), not for a
 * switch to find later. It changes no price, no order and no day — the off
 * switch is in «إدارة التوصيل».
 */
export const DEFAULT_DELIVERY_HANDOVER: DeliveryHandoverPolicy = {
  enabled: true,
  hour: DEFAULT_HANDOVER_HOUR,
  tiers: {},
  closed_weekdays: [],
};

/**
 * THE OWNER-APPROVED TABLE (2026-11-11). Near: the governorates around Hillah
 * and Baghdad. Far: the south and the north outside the Region — Muthanna is
 * FAR, as the owner approved, unlike the scout's draft. Kurdistan: the three
 * governorates behind the Region's checkpoints.
 */
export const DEFAULT_ETA_TIERS: Readonly<Record<string, EtaTier>> = {
  baghdad: 'near',
  babil: 'near',
  karbala: 'near',
  najaf: 'near',
  qadisiyyah: 'near',
  wasit: 'near',
  diyala: 'near',
  anbar: 'near',
  basra: 'far',
  maysan: 'far',
  dhi_qar: 'far',
  muthanna: 'far',
  salahuddin: 'far',
  kirkuk: 'far',
  nineveh: 'far',
  erbil: 'kurdistan',
  sulaymaniyah: 'kurdistan',
  duhok: 'kurdistan',
};

export interface EtaWindow {
  /** Days after the HANDOVER day. */
  days: number;
  /** Baghdad hours of the arrival window; null = «ليلًا» with no hours promised. */
  from_hour: number | null;
  to_hour: number | null;
  /** The owner's «may be delayed more»: said in the words, never hidden. */
  maybe_later: boolean;
}

/** The owner's hours: next day 10–15, next day 18–20, the day after next at night (maybe later). */
export const ETA_WINDOWS: Readonly<Record<EtaTier, EtaWindow>> = {
  near: { days: 1, from_hour: 10, to_hour: 15, maybe_later: false },
  far: { days: 1, from_hour: 18, to_hour: 20, maybe_later: false },
  kurdistan: { days: 2, from_hour: null, to_hour: null, maybe_later: true },
};

const GOVERNORATE_IDS = new Set(IRAQ_GOVERNORATES.map((g) => g.id));
const isTier = (v: unknown): v is EtaTier => typeof v === 'string' && (ETA_TIERS as readonly string[]).includes(v);
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Any stored value → a whole, usable policy. The admin PUT refuses junk on the
 * way in (`validateDeliveryHandover`); this is the read side's clamp, so a row
 * written any other way still runs as something sane: the hour rounded, and
 * the owner's 19 for anything unreadable or outside `HANDOVER_HOURS` (not the
 * nearest end: a stored 31 or −3 was 23 or midnight, both of which make the
 * fixed windows false), tiers only for real governorates and the three
 * tiers (a name is read as its id; an entry equal to the table is dropped),
 * weekdays only 0..6, unique, sorted, at most six — so a handover day always
 * remains and `nextHandover` always ends.
 */
export function resolveDeliveryHandover(stored: unknown): DeliveryHandoverPolicy {
  const out: DeliveryHandoverPolicy = { ...DEFAULT_DELIVERY_HANDOVER, tiers: {}, closed_weekdays: [] };
  if (!isPlainObject(stored)) return out;

  const enabled = bool(stored.enabled);
  if (enabled !== null) out.enabled = enabled;

  const hour = num(stored.hour);
  if (hour !== null) {
    const h = Math.round(hour);
    out.hour = h >= HANDOVER_HOURS.min && h <= HANDOVER_HOURS.max ? h : DEFAULT_HANDOVER_HOUR;
  }

  if (isPlainObject(stored.tiers)) {
    for (const [key, tier] of Object.entries(stored.tiers)) {
      const id = normalizeGovernorate(key);
      if (id && isTier(tier) && tier !== DEFAULT_ETA_TIERS[id]) out.tiers[id] = tier;
    }
  }

  if (Array.isArray(stored.closed_weekdays)) {
    const days = new Set<number>();
    for (const d of stored.closed_weekdays) {
      const n = num(d);
      if (n !== null && Number.isInteger(n) && n >= 0 && n <= 6) days.add(n);
    }
    out.closed_weekdays = [...days].sort((a, b) => a - b).slice(0, 6);
  }
  return out;
}

export type HandoverField = 'value' | 'enabled' | 'hour' | 'tiers' | 'closed_weekdays';

/**
 * THE ADMIN PUT's STRICT CHECK — a typo is refused in three languages, never
 * stored (the house rule for `deliveryPolicy` and `walletFreeDelivery`). What
 * passes is stored as the resolver's canonical form, never as sent.
 */
export function validateDeliveryHandover(
  value: unknown
):
  | { ok: true; value: DeliveryHandoverPolicy }
  | { ok: false; error: { field: HandoverField; message: Record<EtaLang, string> } } {
  const refuse = (field: HandoverField) => ({
    ok: false as const,
    error: { field, message: { ar: HANDOVER_REFUSALS.ar[field], en: HANDOVER_REFUSALS.en[field], ckb: HANDOVER_REFUSALS.ckb[field] } },
  });
  if (!isPlainObject(value)) return refuse('value');
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') return refuse('enabled');
  if (
    value.hour !== undefined &&
    !(typeof value.hour === 'number' && Number.isInteger(value.hour) && value.hour >= HANDOVER_HOURS.min && value.hour <= HANDOVER_HOURS.max)
  ) {
    return refuse('hour');
  }
  if (value.tiers !== undefined) {
    if (!isPlainObject(value.tiers)) return refuse('tiers');
    for (const [id, tier] of Object.entries(value.tiers)) if (!GOVERNORATE_IDS.has(id) || !isTier(tier)) return refuse('tiers');
  }
  if (value.closed_weekdays !== undefined) {
    const days = value.closed_weekdays;
    if (!Array.isArray(days) || days.some((d) => !(typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6))) return refuse('closed_weekdays');
    if (new Set(days).size > 6) return refuse('closed_weekdays');
  }
  return { ok: true, value: resolveDeliveryHandover(value) };
}

// ============================================================ the clock

export interface Handover {
  /** Baghdad's day at `nowMs`. */
  today: string;
  /** The day the parcel goes to the courier. */
  day: string;
  is_today: boolean;
  /** Today is one of the closed weekdays: there is no handover today at all, before or after the hour. */
  today_closed: boolean;
  /** Today was a handover day and its hour has already passed (never on a closed day). */
  cutoff_passed: boolean;
  /** The handover instant, epoch ms (19:00 Baghdad = 16:00Z). */
  at_ms: number;
}

const DAY_MS = 86_400_000;

/**
 * THE NEXT HANDOVER. Before the hour it is today; from the hour on, tomorrow —
 * 18:59 is still today, 19:00 is not. Then forward past any closed weekday.
 * Baghdad's hour is read from epoch ms plus Iraq's fixed +3 (no DST since
 * 2007), so 20:59Z is 23:59 on one Baghdad day and 21:00Z is 00:00 on the next.
 *
 * A CLOSED DAY HAS NO HOUR TO PASS (the review): on a closed Friday the line is
 * «لا تسليم لشركة التوصيل اليوم» at 11:00 and at 20:00 alike — it read «فات
 * تسليم اليوم» after 19:00, a handover that never was, and flipped at an hour
 * the page's timer (armed for midnight on a closed day) never woke for.
 */
export function nextHandover(nowMs: number, policy: DeliveryHandoverPolicy): Handover | null {
  const today = baghdadDay(nowMs);
  if (!today) return null;
  const minute = Math.floor(((((nowMs + BAGHDAD_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS) / 60_000);
  const today_closed = policy.closed_weekdays.includes(dayOfWeek(today));
  const cutoff_passed = !today_closed && minute >= policy.hour * 60;
  let day = cutoff_passed ? addDays(today, 1) : today;
  // At most six closed weekdays (the resolver's clamp), so this ends.
  for (let i = 0; i < 7 && policy.closed_weekdays.includes(dayOfWeek(day)); i++) day = addDays(day, 1);
  return {
    today,
    day,
    is_today: day === today,
    today_closed,
    cutoff_passed,
    at_ms: Date.parse(`${day}T00:00:00.000Z`) + policy.hour * 3_600_000 - BAGHDAD_OFFSET_MS,
  };
}

/** The governorate's tier: the owner's override, else the table. null = no governorate on the address. */
export function tierOf(governorate: unknown, policy: DeliveryHandoverPolicy): EtaTier | null {
  const id = normalizeGovernorate(governorate);
  if (!id) return null;
  return policy.tiers[id] ?? DEFAULT_ETA_TIERS[id] ?? null;
}

export interface DeliveryEta {
  hour: number;
  /** The next handover from now — the one an order placed now as soon as possible goes with. */
  handover: Handover;
  /** The delivery day the customer picked in the picker under the note; '' = «في أقرب وقت». */
  requested_day: string;
  /**
   * The handover THIS order goes with: the next one, or — for a picked day
   * later than that — the evening before the picked day (`PREP_LEAD_DAYS`, the
   * board's rule), past any closed weekday.
   */
  send_day: string;
  /** The governorate id, '' when the address has none. */
  governorate: string;
  /** null → the generic sentence. */
  tier: EtaTier | null;
  /** From `send_day`; '' when the tier is unknown. */
  arrival_day: string;
  /** A picked day the estimate lands after (a «today» picked at 8 pm; any Kurdistan pick). */
  after_requested: boolean;
  /** The next instant the sentences change: the handover, or Baghdad's midnight once it has passed. */
  next_change_ms: number;
}

/**
 * null when the owner switched the note off. `day` is the picker's choice, as
 * the checkout holds it (null or '' = as soon as possible): the note is worded
 * for the order being placed (the review: with «الأحد ١٥» picked it still said
 * «يُسلَّم … اليوم» and «الوصول المتوقع: غدًا»). The picker and the server's
 * checks are untouched — the owner's «only add the note»; this only words it.
 */
export function deliveryEta(input: { nowMs: number; governorate: unknown; policy: DeliveryHandoverPolicy; day?: unknown }): DeliveryEta | null {
  const { policy } = input;
  if (!policy.enabled) return null;
  const handover = nextHandover(input.nowMs, policy);
  if (!handover) return null;
  const governorate = normalizeGovernorate(input.governorate);
  const tier = tierOf(governorate, policy);
  // A real calendar day, not just its shape ('2026-13-40' is no day: as soon as possible).
  const requested_day = typeof input.day === 'string' && dayParts(input.day) ? input.day : '';
  const send_day = requested_day ? sendDayFor(requested_day, handover.day, policy) : handover.day;
  const arrival_day = tier ? addDays(send_day, ETA_WINDOWS[tier].days) : '';
  const midnight = Date.parse(`${addDays(handover.today, 1)}T00:00:00.000Z`) - BAGHDAD_OFFSET_MS;
  return {
    hour: policy.hour,
    handover,
    requested_day,
    send_day,
    governorate,
    tier,
    arrival_day,
    after_requested: requested_day !== '' && arrival_day !== '' && arrival_day > requested_day,
    // A picked day's words move at the same two instants: its handover is
    // reckoned from the next one, and «غدًا» / «اليوم» from Baghdad's day.
    next_change_ms: Math.min(handover.at_ms, midnight),
  };
}

/**
 * A PICKED DAY'S HANDOVER: the evening before it (the board's day,
 * `PREP_LEAD_DAYS`), unless that evening is no later than the next handover —
 * a «tomorrow» picked before 7 pm goes tonight as any order would, and a
 * «today» picked at 8 pm cannot go before tomorrow's. A closed weekday moves
 * it on to the next open day, as `nextHandover` does.
 */
function sendDayFor(requested: string, next: string, policy: DeliveryHandoverPolicy): string {
  let day = addDays(requested, -PREP_LEAD_DAYS);
  if (day <= next) return next;
  for (let i = 0; i < 7 && policy.closed_weekdays.includes(dayOfWeek(day)); i++) day = addDays(day, 1);
  return day;
}

/**
 * The store's OWN same-day methods: «توصيل شخصي — نفس اليوم» goes with the
 * shop's driver, not the courier, so it has no 7 pm handover and no road day.
 * By id, like the board's preparation day (`method_days: { personal: 0 }`).
 */
export const SAME_DAY_METHOD_IDS: readonly string[] = ['personal'];

/**
 * Does this checkout method go by the delivery company's courier? A home
 * delivery (the method's own `home_delivery`, else `id !== 'pickup'` — the
 * same fallback as `deliversToHome`, repeated because this leaf may not import
 * settings.ts) that is not one of the store's same-day methods. A method the
 * owner adds later is a courier delivery: the owner's rule is «all orders».
 */
export function leavesWithCourier(method: { id?: unknown; home_delivery?: unknown } | null | undefined): boolean {
  if (!method || typeof method.id !== 'string' || !method.id) return false;
  const home = typeof method.home_delivery === 'boolean' ? method.home_delivery : method.id !== 'pickup';
  return home && !SAME_DAY_METHOD_IDS.includes(method.id);
}

// ============================================================ the words

/** Hour buckets, so each language says «ظهرًا» / «دوای نیوەڕۆ» / "pm" where it should. */
type Period = 'small' | 'morning' | 'noon' | 'early' | 'afternoon' | 'evening' | 'late';
const periodOf = (h: number): Period =>
  h < 4 ? 'small' : h < 12 ? 'morning' : h === 12 ? 'noon' : h < 15 ? 'early' : h < 17 ? 'afternoon' : h < 22 ? 'evening' : 'late';

export interface EtaWords {
  /** Today is a handover day and its hour has not come: {hour}. */
  handoverToday: string;
  /** Today's hour has passed: {hour} {day}. */
  handoverPassed: string;
  /** Today is a closed weekday: {hour} {day}. */
  handoverClosed: string;
  /**
   * Paid through Gini: the order waits for the receipt barcode (up to the Gini
   * hold), so «today before 7 pm» is no promise — the next handover after it: {hour}.
   */
  handoverGini: string;
  /** A picked day later than the next handover: the evening before it, {day} {hour}. */
  handoverForDay: string;
  /** The chosen address's governorate: {gov} {day} {window}. */
  arrival: string;
  /** The same, when the estimate lands after the day the customer picked: {gov} {day} {window}. */
  arrivalLate: string;
  /** Kurdistan's window — no hours, «may be later». */
  night: string;
  /** The address has no governorate. */
  generic: string;
  /** {from} {to} */
  between: string;
  /** An hour: {n} the number, {p} the period. */
  clock: string;
  periods: Record<Period, string>;
  /** The long version, inside «تفاصيل التوصيل». */
  title: string;
  rule: string;
  ruleClosed: string;
  cutoff: string;
  /** Each group: {list} {window}; near also {about}. */
  groups: Record<EtaTier, string>;
  /** The owner's «+17 hrs» — true of the 7 pm handover only, so said only then (the review). */
  nearAbout: string;
  example: string;
  estimates: string;
  /** The delivery row's «!» once it also answers «when». */
  question: string;
}

/**
 * ARABIC-INDIC DIGITS in ar and ckb, Latin in en — `dayLabel`'s convention,
 * so «الجمعة ١٣ تشرين الثاني» and «٧ مساءً» read in one hand.
 */
export const ETA_TEXT: Record<EtaLang, EtaWords> = {
  ar: {
    handoverToday: 'أتمم طلبك قبل الساعة {hour} ليُسلَّم لمندوب شركة التوصيل اليوم.',
    handoverPassed: 'فات تسليم اليوم (الساعة {hour})، فيُسلَّم طلبك لمندوب شركة التوصيل {day} الساعة {hour}.',
    handoverClosed: 'لا تسليم لشركة التوصيل اليوم، فيُسلَّم طلبك لمندوبها {day} الساعة {hour}.',
    handoverGini: 'بعد تأكيد شرائه من تطبيق جني ومسح باركود الاستلام، يُسلَّم طلبك لمندوب شركة التوصيل في أقرب تسليم الساعة {hour}.',
    handoverForDay: 'نجهّز طلبك لليوم الذي اخترته، ونسلّمه لمندوب شركة التوصيل {day} الساعة {hour}.',
    arrival: 'الوصول المتوقع إلى {gov}: {day} {window} (تقديري).',
    arrivalLate: 'الوصول المتوقع إلى {gov}: {day} {window} (تقديري) — بعد اليوم الذي اخترته.',
    night: 'ليلًا، وقد تؤخّره نقاط التفتيش أكثر',
    generic:
      'يصل غالبًا في اليوم التالي للتسليم إلى المحافظات القريبة من مخزننا في الحلة، ومساء اليوم التالي إلى المحافظات البعيدة، وبعد يومين من التسليم ليلًا أو أكثر إلى إقليم كردستان (تقديري).',
    between: 'بين {from} و{to}',
    clock: '{n} {p}',
    periods: { small: 'ليلًا', morning: 'صباحًا', noon: 'ظهرًا', early: 'ظهرًا', afternoon: 'عصرًا', evening: 'مساءً', late: 'ليلًا' },
    title: 'متى يصل طلبك؟',
    rule: 'نجهّز كل الطلبات ونسلّمها لمندوب شركة التوصيل يوميًا الساعة {hour}.',
    ruleClosed: 'نجهّز كل الطلبات ونسلّمها لمندوب شركة التوصيل الساعة {hour} من كل يوم عدا {days}.',
    cutoff: 'اطلب قبل الساعة {hour} ليُسلَّم طلبك في اليوم نفسه. الطلب بعد الساعة {hour} يُسلَّم في اليوم التالي، فيتأخر وصوله يومًا كاملًا (٢٤ ساعة).',
    groups: {
      near: 'المحافظات القريبة من مخزننا في الحلة (بابل): {list} — في اليوم التالي للتسليم {window}{about}.',
      far: 'المحافظات البعيدة: {list} — في اليوم التالي للتسليم {window}.',
      kurdistan: 'إقليم كردستان: {list} — بعد يومين من التسليم ليلًا، وقد يتأخر أكثر من ٤٨ ساعة لأن نقاط التفتيش صعبة جدًا.',
    },
    nearAbout: '، أي بعد نحو ١٧ ساعة من التسليم',
    example: 'مثال من بغداد: الطلب الساعة {early} يصل في اليوم التالي قرابة ١١ صباحًا ({window})، والطلب الساعة {late} يتأخر وصوله يومًا كاملًا.',
    estimates: 'كل هذه الأوقات تقديرية، وليست موعدًا ملزمًا.',
    question: 'كيف حُسبت تكلفة التوصيل، ومتى يصل طلبك؟',
  },
  en: {
    handoverToday: "Place your order before {hour} and it goes to the delivery company's courier today.",
    handoverPassed: "Today's {hour} handover has passed, so your order goes to the delivery company's courier {day} at {hour}.",
    handoverClosed: "There is no courier handover today, so your order goes to the delivery company's courier {day} at {hour}.",
    handoverGini:
      "Once the purchase is confirmed in the Gini app and the receipt barcode is scanned, your order goes to the delivery company's courier at the next {hour} handover.",
    handoverForDay: "We prepare your order for the day you chose. Handover to the delivery company's courier: {day}, {hour}.",
    arrival: 'Expected in {gov}: {day}, {window} (estimate).',
    arrivalLate: 'Expected in {gov}: {day}, {window} (estimate) — later than the day you chose.',
    night: 'at night — checkpoints can delay it further',
    generic:
      'It usually arrives the day after handover in the governorates near our warehouse in Hillah, the evening of the day after handover in the far ones, and two or more days after handover, at night, in the Kurdistan Region (estimate).',
    between: 'between {from} and {to}',
    clock: '{n} {p}',
    periods: { small: 'am', morning: 'am', noon: 'pm', early: 'pm', afternoon: 'pm', evening: 'pm', late: 'pm' },
    title: 'When will your order arrive?',
    rule: "We prepare every order and hand it to the delivery company's courier at {hour} every day.",
    ruleClosed: "We prepare every order and hand it to the delivery company's courier at {hour} every day except {days}.",
    cutoff: 'Order before {hour} and your order is handed over the same day. An order placed after {hour} is handed over the next day, so it arrives a full day (24 hours) later.',
    groups: {
      near: 'Governorates near our warehouse in Hillah (Babil): {list} — the day after handover, {window}{about}.',
      far: 'Far governorates: {list} — the day after handover, {window}.',
      kurdistan: 'Kurdistan Region: {list} — two days after handover, at night; it can take more than 48 hours because the checkpoints are very slow.',
    },
    nearAbout: ', about 17 hours after it',
    example: 'Example from Baghdad: an order placed at {early} arrives the next day around 11 am ({window}); one placed at {late} arrives a full day later.',
    estimates: 'All of these times are estimates, not a guaranteed delivery time.',
    question: 'How is the delivery cost calculated, and when will your order arrive?',
  },
  ckb: {
    handoverToday: 'پێش کاتژمێر {hour} داواکارییەکەت تەواو بکە، بۆ ئەوەی ئەمڕۆ ڕادەستی گەیێنەری کۆمپانیای گەیاندن بکرێت.',
    handoverPassed: 'کاتی ڕادەستکردنی ئەمڕۆ (کاتژمێر {hour}) تێپەڕیوە، بۆیە داواکارییەکەت {day} کاتژمێر {hour} ڕادەستی گەیێنەری کۆمپانیای گەیاندن دەکرێت.',
    handoverClosed: 'ئەمڕۆ ڕادەستی کۆمپانیای گەیاندن ناکەین، بۆیە داواکارییەکەت {day} کاتژمێر {hour} ڕادەستی گەیێنەرەکەیان دەکرێت.',
    handoverGini:
      'دوای پشتڕاستکردنەوەی کڕینەکەی لە ئەپی جینی و سکانکردنی باڕکۆدی وەرگرتن، داواکارییەکەت لە نزیکترین ڕادەستکردندا کاتژمێر {hour} ڕادەستی گەیێنەری کۆمپانیای گەیاندن دەکرێت.',
    handoverForDay: 'داواکارییەکەت بۆ ئەو ڕۆژەی هەڵتبژاردووە ئامادە دەکەین، و {day} کاتژمێر {hour} ڕادەستی گەیێنەری کۆمپانیای گەیاندنی دەکەین.',
    arrival: 'گەیشتنی چاوەڕوانکراو بۆ {gov}: {day} {window} (خەمڵێنراو).',
    arrivalLate: 'گەیشتنی چاوەڕوانکراو بۆ {gov}: {day} {window} (خەمڵێنراو) — دوای ئەو ڕۆژەی هەڵتبژاردووە.',
    night: 'بە شەو، و لەوانەیە خاڵەکانی پشکنین زیاتر دوای بخەن',
    generic:
      'زۆربەی جار ڕۆژی دوای ڕادەستکردن دەگاتە ئەو پارێزگایانەی نزیکی کۆگاکەمانن لە حیللە، ئێوارەی ڕۆژی دوای ڕادەستکردن دەگاتە پارێزگا دوورەکان، و دوو ڕۆژ یان زیاتر دوای ڕادەستکردن، بە شەو، دەگاتە هەرێمی کوردستان (خەمڵێنراو).',
    between: 'لە نێوان کاتژمێر {from} و {to}',
    clock: '{n}ی {p}',
    periods: { small: 'شەو', morning: 'پێش نیوەڕۆ', noon: 'نیوەڕۆ', early: 'دوای نیوەڕۆ', afternoon: 'دوای نیوەڕۆ', evening: 'ئێوارە', late: 'شەو' },
    title: 'داواکارییەکەت کەی دەگات؟',
    rule: 'هەموو داواکارییەکان ئامادە دەکەین و ڕۆژانە کاتژمێر {hour} ڕادەستی گەیێنەری کۆمپانیای گەیاندنیان دەکەین.',
    ruleClosed: 'هەموو داواکارییەکان ئامادە دەکەین و هەموو ڕۆژێک جگە لە {days}، کاتژمێر {hour} ڕادەستی گەیێنەری کۆمپانیای گەیاندنیان دەکەین.',
    cutoff: 'پێش کاتژمێر {hour} داوا بکە بۆ ئەوەی داواکارییەکەت هەمان ڕۆژ ڕادەست بکرێت. داواکاریی دوای کاتژمێر {hour} ڕۆژی دواتر ڕادەست دەکرێت، بۆیە گەیشتنی ڕۆژێکی تەواو (٢٤ کاتژمێر) دوادەکەوێت.',
    groups: {
      near: 'پارێزگا نزیکەکانی کۆگاکەمان لە حیللە (بابل): {list} — ڕۆژی دوای ڕادەستکردن {window}{about}.',
      far: 'پارێزگا دوورەکان: {list} — ڕۆژی دوای ڕادەستکردن {window}.',
      kurdistan: 'هەرێمی کوردستان: {list} — دوو ڕۆژ دوای ڕادەستکردن بە شەو، و لەوانەیە زیاتر لە ٤٨ کاتژمێر بخایەنێت چونکە خاڵەکانی پشکنین زۆر قورسن.',
    },
    nearAbout: '، واتە نزیکەی ١٧ کاتژمێر دوای ڕادەستکردن',
    example: 'نموونە لە بەغداوە: داواکارییەک کە کاتژمێر {early} دەکرێت ڕۆژی دواتر نزیکەی کاتژمێر ١١ی پێش نیوەڕۆ دەگات ({window})؛ داواکارییەک کە کاتژمێر {late} دەکرێت ڕۆژێکی تەواو دواتر دەگات.',
    estimates: 'هەموو ئەم کاتانە خەمڵێنراون، نەک کاتێکی بەڵێندراو.',
    question: 'تێچووی گەیاندن چۆن هەژمار کرا، و داواکارییەکەت کەی دەگات؟',
  },
};

export interface HandoverAdminWords {
  title: string;
  intro: string;
  enabled: string;
  hour: string;
  /** The select's accessible name on one governorate's row: {gov}. */
  tier: string;
  /** Each option, the window in words: near/far {window}. */
  tiers: Record<EtaTier, string>;
  /** Beside a governorate moved off the owner's table, so a move is visible on the row. */
  moved: string;
  /** After a Save that sent the handover (the fees' own sentence speaks of fees). */
  saved: string;
}

/** «إدارة التوصيل»: the handover hour and each governorate's time group. */
export const HANDOVER_ADMIN_TEXT: Record<EtaLang, HandoverAdminWords> = {
  ar: {
    title: 'وقت التسليم لشركة التوصيل والوصول المتوقع',
    intro:
      'يظهر للزبون في صفحة الدفع تحت التوصيل بشركة التوصيل: متى يُسلَّم طلبه للمندوب، ومتى يُتوقَّع وصوله إلى محافظته. الأوقات تقديرية، ولا يتغير بها يوم التوصيل الذي يختاره الزبون.',
    enabled: 'إظهار ملاحظة وقت الوصول في صفحة الدفع',
    hour: 'ساعة التسليم اليومية للمندوب (بتوقيت بغداد)',
    tier: 'وقت الوصول — {gov}',
    tiers: { near: 'قريبة: اليوم التالي، {window}', far: 'بعيدة: اليوم التالي، {window}', kurdistan: 'كردستان: بعد يومين ليلًا، وقد يتأخر' },
    moved: 'معدّلة عن الجدول الافتراضي',
    saved: 'تم حفظ وقت التسليم — تتبعه ملاحظة صفحة الدفع من الآن.',
  },
  en: {
    title: 'Courier handover and expected arrival',
    intro:
      "Shown at checkout under courier delivery: when the order goes to the delivery company's courier and when it should reach the customer's governorate. The times are estimates and do not change the delivery day the customer picks.",
    enabled: 'Show the arrival note at checkout',
    hour: 'Daily courier handover (Baghdad time)',
    tier: 'Arrival time — {gov}',
    tiers: { near: 'Near: next day, {window}', far: 'Far: next day, {window}', kurdistan: 'Kurdistan: two days later at night, maybe later' },
    moved: 'changed from the default table',
    saved: 'Handover saved — the checkout note follows it from now on.',
  },
  ckb: {
    title: 'کاتی ڕادەستکردن بە کۆمپانیای گەیاندن و گەیشتنی چاوەڕوانکراو',
    intro:
      'لە پەڕەی پارەدان لە ژێر گەیاندن بە کۆمپانیای گەیاندن پیشان دەدرێت: داواکارییەکە کەی ڕادەستی گەیێنەر دەکرێت و کەی چاوەڕوان دەکرێت بگاتە پارێزگاکەی کڕیار. کاتەکان خەمڵێنراون و ئەو ڕۆژی گەیاندنەی کڕیار هەڵیدەبژێرێت ناگۆڕن.',
    enabled: 'تێبینیی کاتی گەیشتن لە پەڕەی پارەدان پیشان بدە',
    hour: 'کاتژمێری ڕادەستکردنی ڕۆژانە بە گەیێنەر (بە کاتی بەغدا)',
    tier: 'کاتی گەیشتن — {gov}',
    tiers: { near: 'نزیک: ڕۆژی دواتر، {window}', far: 'دوور: ڕۆژی دواتر، {window}', kurdistan: 'کوردستان: دوو ڕۆژ دواتر بە شەو، لەوانەیە دواتر' },
    moved: 'جیاوازە لە خشتەی بنەڕەت',
    saved: 'کاتی ڕادەستکردن پاشەکەوت کرا — تێبینیی پەڕەی پارەدان لە ئێستاوە پەیڕەوی دەکات.',
  },
};

/** The admin PUT's refusals, one per field. */
export const HANDOVER_REFUSALS: Record<EtaLang, Record<HandoverField, string>> = {
  ar: {
    value: 'قيمة وقت التسليم غير صالحة.',
    enabled: 'مفتاح إظهار الملاحظة قيمته true أو false فقط.',
    hour: 'ساعة التسليم عدد صحيح من 12 إلى 23 (بعد الظهر أو المساء).',
    tiers: 'كل محافظة تأخذ near أو far أو kurdistan، بمعرّف إحدى المحافظات الثماني عشرة.',
    closed_weekdays: 'أيام العطلة أرقام من 0 (الأحد) إلى 6 (السبت)، ويبقى يوم تسليم واحد على الأقل في الأسبوع.',
  },
  en: {
    value: 'The handover setting is not valid.',
    enabled: 'The note switch takes true or false only.',
    hour: 'The handover hour is a whole number from 12 to 23 (afternoon or evening).',
    tiers: 'Each governorate takes near, far or kurdistan, by one of the eighteen governorate ids.',
    closed_weekdays: 'Closed days are numbers from 0 (Sunday) to 6 (Saturday), and at least one handover day must remain each week.',
  },
  ckb: {
    value: 'ڕێکخستنی کاتی ڕادەستکردن دروست نییە.',
    enabled: 'کلیلی پیشاندانی تێبینی تەنها true یان false وەردەگرێت.',
    hour: 'کاتژمێری ڕادەستکردن ژمارەیەکی تەواوە لە 12 تا 23 (دوای نیوەڕۆ یان ئێوارە).',
    tiers: 'هەر پارێزگایەک near یان far یان kurdistan وەردەگرێت، بە ناسنامەی یەکێک لە هەژدە پارێزگاکە.',
    closed_weekdays: 'ڕۆژە داخراوەکان ژمارەن لە 0 (یەکشەممە) تا 6 (شەممە)، و دەبێت لانیکەم ڕۆژێکی ڕادەستکردن لە هەفتەدا بمێنێتەوە.',
  },
};

export const etaLang = (lang: string): EtaLang => (lang === 'en' ? 'en' : lang === 'ckb' ? 'ckb' : 'ar');

const fill = (template: string, vars: Record<string, string>) => template.replace(/\{(\w+)\}/g, (all, key: string) => vars[key] ?? all);
const indic = (n: number | string) => String(n).replace(/[0-9]/g, (d) => String.fromCharCode(0x0660 + Number(d)));
const digits = (n: number | string, L: EtaLang) => (L === 'en' ? String(n) : indic(n));
const twelve = (h: number) => h % 12 || 12;
/** A list of names: the Arabic comma in ar and ckb. Punctuation, not a word. */
const list = (names: string[], L: EtaLang) => names.join(L === 'en' ? ', ' : '، ');

/** «٧ مساءً» / "7 pm" / «٧ی ئێوارە». */
export function hourWords(hour: number, lang: string): string {
  const L = etaLang(lang);
  return fill(ETA_TEXT[L].clock, { n: digits(twelve(hour), L), p: ETA_TEXT[L].periods[periodOf(hour)] });
}

/** «٧:٣٠ مساءً» / "7:30 pm" / «٧:٣٠ی ئێوارە». */
function clockWords(hour: number, minute: number, L: EtaLang): string {
  const n = `${digits(twelve(hour), L)}:${digits(String(minute).padStart(2, '0'), L)}`;
  return fill(ETA_TEXT[L].clock, { n, p: ETA_TEXT[L].periods[periodOf(hour)] });
}

/** A tier's window in words: «بين ١٠ صباحًا و٣ عصرًا», «بين ٦ و٨ مساءً», or Kurdistan's night. */
export function windowWords(tier: EtaTier, lang: string): string {
  const L = etaLang(lang);
  const T = ETA_TEXT[L];
  const w = ETA_WINDOWS[tier];
  if (w.from_hour === null || w.to_hour === null) return T.night;
  // One period for both ends («بين ٦ و٨ مساءً»), or each its own («بين ١٠ صباحًا و٣ عصرًا»).
  const same = T.periods[periodOf(w.from_hour)] === T.periods[periodOf(w.to_hour)];
  return fill(T.between, { from: same ? digits(twelve(w.from_hour), L) : hourWords(w.from_hour, L), to: hourWords(w.to_hour, L) });
}

/** A day for these sentences: dayLabel's own words, with English «Today»/«Tomorrow» lowercased mid-sentence. */
function dayWords(day: string, today: string, L: EtaLang): string {
  const d = dayLabel(day, today, L);
  return L === 'en' && (d.is_today || d.is_tomorrow) ? d.label.toLowerCase() : d.label;
}

/**
 * Which first line the note draws (and the checkout's `data-courier-handover`):
 * a picked day later than the next handover → 'day'; paid through Gini → 'gini'
 * (the order waits for its receipt barcode, so no «before 7 pm today»); else
 * before the hour → 'today', after it → 'passed', a closed weekday → 'closed'.
 */
export type HandoverKind = 'day' | 'gini' | 'today' | 'passed' | 'closed';
export function etaHandoverKind(eta: DeliveryEta, opts: { gini?: boolean } = {}): HandoverKind {
  if (eta.send_day !== eta.handover.day) return 'day';
  if (opts.gini) return 'gini';
  if (eta.handover.is_today) return 'today';
  return eta.handover.today_closed ? 'closed' : 'passed';
}

/** The first line under the card: when this order goes to the courier. */
export function etaHandoverLine(eta: DeliveryEta, lang: string, opts: { gini?: boolean } = {}): string {
  const L = etaLang(lang);
  const T = ETA_TEXT[L];
  const hour = hourWords(eta.hour, L);
  const kind = etaHandoverKind(eta, opts);
  if (kind === 'today') return fill(T.handoverToday, { hour });
  if (kind === 'gini') return fill(T.handoverGini, { hour });
  const day = dayWords(kind === 'day' ? eta.send_day : eta.handover.day, eta.handover.today, L);
  return fill(kind === 'day' ? T.handoverForDay : kind === 'passed' ? T.handoverPassed : T.handoverClosed, { hour, day });
}

/**
 * The second line: the expected arrival in the address's governorate, named —
 * said to be after the picked day when it is — or the generic sentence.
 */
export function etaArrivalLine(eta: DeliveryEta, lang: string): string {
  const L = etaLang(lang);
  const T = ETA_TEXT[L];
  if (!eta.tier || !eta.arrival_day) return T.generic;
  return fill(eta.after_requested ? T.arrivalLate : T.arrival, {
    gov: governorateName(eta.governorate, L),
    day: dayWords(eta.arrival_day, eta.handover.today, L),
    window: windowWords(eta.tier, L),
  });
}

/**
 * The long explanation: the rule, the cutoff, the three groups as the table
 * stands now (an override moves a governorate between the lists; an empty
 * group is left out), the owner's Baghdad example while it is still true
 * (Baghdad near, and 1 pm before the hour) and the estimate.
 */
export function etaDetails(policy: DeliveryHandoverPolicy, lang: string): { title: string; lines: string[] } {
  const L = etaLang(lang);
  const T = ETA_TEXT[L];
  const hour = hourWords(policy.hour, L);
  const lines: string[] = [
    policy.closed_weekdays.length
      ? fill(T.ruleClosed, { hour, days: list(policy.closed_weekdays.map((d) => WEEKDAYS[L][d] ?? ''), L) })
      : fill(T.rule, { hour }),
    fill(T.cutoff, { hour }),
  ];
  // The owner's «+17 hrs» is 7 pm to about noon the next day: said at the owner's hour only.
  const about = policy.hour === DEFAULT_HANDOVER_HOUR ? T.nearAbout : '';
  for (const tier of ETA_TIERS) {
    const names = IRAQ_GOVERNORATES.filter((g) => tierOf(g.id, policy) === tier).map((g) => governorateName(g.id, L));
    if (names.length) lines.push(fill(T.groups[tier], { list: list(names, L), window: windowWords(tier, L), about }));
  }
  if (policy.hour > 13 && tierOf('baghdad', policy) === 'near') {
    lines.push(fill(T.example, { early: hourWords(13, L), late: clockWords(policy.hour, 30, L), window: windowWords('near', L) }));
  }
  lines.push(T.estimates);
  return { title: T.title, lines };
}

/** One option of the admin's time-group select, the window in words. */
export function tierOptionWords(tier: EtaTier, lang: string): string {
  const L = etaLang(lang);
  return fill(HANDOVER_ADMIN_TEXT[L].tiers[tier], { window: windowWords(tier, L) });
}

export interface HandoverAdminView {
  /** The owner's table, so the page knows which governorate is moved off it. */
  table: Readonly<Record<string, EtaTier>>;
  /**
   * The page's words with the windows written out, and the select's hours —
   * `HANDOVER_HOURS` only, each with its label; `tier` keeps its {gov}.
   */
  words: Record<EtaLang, Omit<HandoverAdminWords, 'tiers'> & { tiers: Record<EtaTier, string>; hours: Array<{ hour: number; label: string }> }>;
}

/**
 * WHAT «إدارة التوصيل» DRAWS, SENT BY THE SERVER (GET /api/admin/delivery-policy)
 * rather than imported. The page and the checkout both importing this module
 * would make it a chunk of its own, and every chunk the checkout loads is
 * named in the entry's preload map — bytes on every first visit, past the
 * storefront payload's cap (tests/bundleBudget.test.ts). So the checkout is
 * its only importer in the browser, and the admin reads the same table and
 * the same typed words from here, the way the delivery-day chips arrive
 * already written.
 */
export function handoverAdminView(): HandoverAdminView {
  const words = {} as HandoverAdminView['words'];
  for (const L of ['ar', 'en', 'ckb'] as const) {
    const W = HANDOVER_ADMIN_TEXT[L];
    words[L] = {
      ...W,
      tiers: { near: tierOptionWords('near', L), far: tierOptionWords('far', L), kurdistan: tierOptionWords('kurdistan', L) },
      hours: Array.from({ length: HANDOVER_HOURS.max - HANDOVER_HOURS.min + 1 }, (_, i) => {
        const hour = HANDOVER_HOURS.min + i;
        return { hour, label: hourWords(hour, L) };
      }),
    };
  }
  return { table: DEFAULT_ETA_TIERS, words };
}

function bool(v: unknown): boolean | null {
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  if (v === false || v === 0 || v === '0' || v === 'false') return false;
  return null;
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
