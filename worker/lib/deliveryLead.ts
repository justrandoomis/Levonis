/**
 * THE DAY TO PREPARE AN ORDER — how many days before the customer's delivery
 * day a parcel has to be packed and handed over.
 *
 * Owner, 2026-11-11: «when the customer needs the order delivered on e.g.
 * 13-11, it should appear to the admin to prepare on 12-11 because delivery
 * takes 24hr». Every parcel is packed and handed to the delivery company's
 * courier at 7 pm in Hillah, and the road takes a day. Asked whether far
 * governorates (Basra, the Kurdistan Region) need more, the owner answered
 * «1 day everywhere» (DECISIONS row 322). So:
 *
 *   1 day    every order the courier carries, whatever the governorate;
 *   0 days   the store's own same-day methods — «توصيل شخصي — نفس اليوم»
 *            (`personal`) and «استلام من المخزن» (`pickup`) — which have no
 *            road day: the box is made up on the day itself;
 *   0 days   an order no longer on our shelf: with the courier
 *            (`out_for_delivery`), delivered or cancelled. It is filed by the
 *            day it reaches the customer, so a parcel handed over last night is
 *            not «late» this morning, and a courier who IS late still shows so.
 *
 * WHY THE METHOD IDS AND NOT A FLAG. `home_delivery` (settings.ts) separates
 * the pickup from the two home deliveries, but `standard` and `personal` both
 * end at the door — only their ids say which one our own driver makes the
 * same day. A pickup never carries a day at all (orders.ts
 * `checkoutDeliveryDay`), so its 0 is the honest value rather than one the
 * board ever reads.
 *
 * SHAPED LIKE THE SETTING IT MAY BECOME. `DeliveryLeadTable` is the value an
 * `admin_settings` row would hold; every function takes the table as an
 * argument and defaults to the constant, so promoting it is one settings read
 * and nothing here changes. `checkLeadTable` refuses anything that is not
 * plain whole days and plain ids, because `leadDaysSql` writes the table into
 * SQL text — a bad table fails a test, never a statement on D1.
 *
 * TWO READINGS OF ONE RULE. `leadDaysSql` is what the board's SQL files, counts
 * and sorts by; `leadDaysFor` is the same rule in TypeScript for the order
 * window. tests/deliveryLead.test.ts runs both over every stage, status and
 * method and requires them to agree row for row.
 *
 * A LEAF. It imports only ./baghdadTime, itself a leaf (see the import-cycle
 * note there): settings.ts must never be reachable from here.
 */
import { addDays, isDay } from './baghdadTime';

/** The value a later `admin_settings` row would hold. Whole days, 0..MAX_LEAD_DAYS. */
export interface DeliveryLeadTable {
  /** Days between the hand-over and the customer's day, for every method not named below. */
  default_days: number;
  /** Methods with a lead of their own, by `orders.delivery_method_id`. */
  method_days: Readonly<Record<string, number>>;
}

/** The owner's table (DECISIONS row 322): a day on the road, none for our own same-day methods. */
export const DELIVERY_LEAD: DeliveryLeadTable = Object.freeze({
  default_days: 1,
  method_days: Object.freeze({ personal: 0, pickup: 0 }),
});

/** Stages after which the order is no longer ours to pack — it is filed by its own day. */
export const HANDED_OVER_STAGES = ['out_for_delivery', 'delivered', 'cancelled'] as const;
/**
 * The finished statuses, whatever the stage column says: the archive is
 * filed by the customer's day by construction, even on a row whose stage was
 * left behind by a hand correction of its status.
 */
export const FINISHED_STATUSES = ['delivered', 'cancelled'] as const;

/** The courier hand-over the board's note names: 7 pm Baghdad, every day. */
export const HANDOVER_HOUR = 19;

/** More than a week on the road is not a delivery, it is a pre-order. */
export const MAX_LEAD_DAYS = 7;

const METHOD_ID = /^[a-z0-9_-]{1,40}$/;
const SQL_ALIAS = /^[a-z_][a-z0-9_]{0,30}$/i;
const wholeDays = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= MAX_LEAD_DAYS;

/** The table itself, or a throw naming what is wrong with it. */
export function checkLeadTable(table: DeliveryLeadTable): DeliveryLeadTable {
  if (!table || typeof table !== 'object') throw new Error('delivery lead: the table is missing');
  if (!wholeDays(table.default_days)) throw new Error(`delivery lead: default_days must be whole days 0..${MAX_LEAD_DAYS}`);
  const methods = table.method_days;
  if (!methods || typeof methods !== 'object') throw new Error('delivery lead: method_days is missing');
  for (const [id, days] of Object.entries(methods)) {
    if (!METHOD_ID.test(id)) throw new Error(`delivery lead: ${JSON.stringify(id)} is not a delivery method id`);
    if (!wholeDays(days)) throw new Error(`delivery lead: ${id} must be whole days 0..${MAX_LEAD_DAYS}`);
  }
  return table;
}

/** What the rule reads off an order row. Unknown values read as "not that". */
export interface LeadInput {
  stage?: unknown;
  status?: unknown;
  delivery_method_id?: unknown;
}

const has = (list: readonly string[], v: unknown): boolean => typeof v === 'string' && list.includes(v);

/** The order's lead in whole days — the TypeScript reading of `leadDaysSql`. */
export function leadDaysFor(order: LeadInput, table: DeliveryLeadTable = DELIVERY_LEAD): number {
  if (has(HANDED_OVER_STAGES, order.stage) || has(FINISHED_STATUSES, order.status)) return 0;
  const method = typeof order.delivery_method_id === 'string' ? order.delivery_method_id : '';
  if (method && Object.hasOwn(table.method_days, method)) return table.method_days[method];
  return table.default_days;
}

/** The smallest and largest lead the table can give — 0 is always possible (handed over). */
export function leadBounds(table: DeliveryLeadTable = DELIVERY_LEAD): { min: number; max: number } {
  const t = checkLeadTable(table);
  const all = [0, t.default_days, ...Object.values(t.method_days)];
  return { min: Math.min(...all), max: Math.max(...all) };
}

/** The day to prepare: the delivery day less the lead, or '' when there is no day. */
export function boardDayOf(day: unknown, lead: number): string {
  return isDay(day) ? addDays(day, -lead) : '';
}

const quoted = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(',');

/**
 * The lead as one SQL expression over `alias`. Constants only — the table is
 * checked, and every value it writes is a whole number or a plain id — so it
 * is text, never a bind, and the route can export it for EXPLAIN tests.
 */
export function leadDaysSql(table: DeliveryLeadTable = DELIVERY_LEAD, alias = 'o'): string {
  const t = checkLeadTable(table);
  if (!SQL_ALIAS.test(alias)) throw new Error(`delivery lead: ${JSON.stringify(alias)} is not a table alias`);
  // One WHEN per distinct lead, ids in a fixed order, so the text is stable.
  const byDays = new Map<number, string[]>();
  for (const id of Object.keys(t.method_days).sort()) {
    const days = t.method_days[id];
    byDays.set(days, [...(byDays.get(days) ?? []), id]);
  }
  const methods = [...byDays.keys()]
    .sort((a, b) => a - b)
    .map((days) => ` WHEN ${alias}.delivery_method_id IN (${quoted(byDays.get(days)!)}) THEN ${days}`)
    .join('');
  return (
    `(CASE WHEN ${alias}.stage IN (${quoted(HANDED_OVER_STAGES)}) OR ${alias}.status IN (${quoted(FINISHED_STATUSES)}) THEN 0` +
    `${methods} ELSE ${t.default_days} END)`
  );
}

/**
 * The board day in SQL: `date(day, '-N days')`. NULL when the order has no
 * day, and the stored string itself when the lead is 0.
 */
export function boardDaySql(table: DeliveryLeadTable = DELIVERY_LEAD, alias = 'o'): string {
  return `date(${alias}.delivery_due_day, '-' || ${leadDaysSql(table, alias)} || ' days')`;
}
