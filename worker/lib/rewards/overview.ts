/**
 * ADMIN → المكافآت → نظرة عامة (owner, 2026-11-05: «every thing to admin side»;
 * DECISIONS row 298). What the programme is doing right now and what it has given
 * away, on one screen, from one read.
 *
 * WHO EARNS is the sweep's own definition (./earning.ts). «Due now» is the backlog the
 * next quarter-hour ticks will serve, the sweep's own test with `missing` in it.
 *
 * WHAT IT COSTS THE SHOP IS NOT HERE. «Value spent» is what the coupons took off orders
 * (the redemption rows' `amount_iqd`), goods and delivery apart, never a cost; and the
 * weekly exposure is a ceiling, named as one: how much the coupons of a week could take
 * if every printer's pair were spent in full.
 */
import { isSchemaMissing } from '../membershipBenefits';
import { REWARD_COUPON_KINDS, type RewardCouponKind } from './config';
import { DAY_MS, GRANT_STATE_SQL, printerSourceRefSql, type RewardGrantState } from './coupons';
import {
  SLOT_IS_PRINTER_SQL,
  SLOT_SOLD_HERE_SQL,
  slotInShopSql,
  slotInsideMonthsSql,
  slotJoins,
  slotNotRefundedSql,
  slotOpenSql,
  slotTradedInSql,
  slotWeekSql,
} from './earning';
import { weeklyProgramme } from './printers';

const BINDS = { now: '?1', started: '?2', months: '?3' };

/** Does this product have a live offer window that sets its price? One scalar SQL expression, 1 or 0. */
export const LIVE_OFFER_SQL = (product: string, now: string): string =>
  `EXISTS (SELECT 1 FROM offer_windows w
            WHERE w.subject_type = 'product' AND w.subject_id = ${product} AND w.active = 1 AND w.offer_price_mode <> ''
              AND (w.starts_at IS NULL OR w.starts_at <= ${now}) AND (w.ends_at IS NULL OR w.ends_at > ${now}))`;

export interface CouponTally {
  issued: number;
  live: number;
  spent: number;
  expired: number;
  withdrawn: number;
  /** Spent ÷ issued, 0 to 100, whole. */
  use_rate: number;
}

export interface ValueSpent {
  goods_iqd: number;
  delivery_iqd: number;
  total_iqd: number;
}

export interface RewardsOverview {
  installed: boolean;
  server_time: string;
  printers: { earning: number; customers: number; due_now: number };
  coupons: Record<RewardCouponKind, CouponTally> & { all: CouponTally };
  value_spent: { last_7_days: ValueSpent; last_30_days: ValueSpent; all_time: ValueSpent };
  points_taken_by_shop: number;
  weekly_exposure: {
    printers: number;
    /** What one printer's pair of a week can take at most, at today's terms. */
    per_printer_iqd: number;
    ceiling_iqd: number;
    /** The filament coupon has no ceiling of its own, so this ceiling leaves it out. */
    filament_uncapped: boolean;
  };
  last_issued_at: string | null;
  switches: {
    enabled: boolean;
    weekly: boolean;
    free_shipping: boolean;
    filament: boolean;
    shop_free_shipping: boolean;
    shop_filament: boolean;
    /** How many products the shop sells for points (DECISIONS row 299). */
    shop_products: number;
    /** The database can say when the weekly programme reached it. */
    weekly_started: boolean;
  };
  attention: {
    /** The shop sells nothing at all, and these coupons have no price. Empty while anything is on sale. */
    shop_without_price: RewardCouponKind[];
    /** Filaments the owner ticked that a live offer keeps his coupon off (`filament.on_offer` is off). */
    filament_on_offer: Array<{ id: string; name: { ar: string; en: string; ckb: string } }>;
    reviews_waiting: number;
    competitions_open: number;
    competitions_awaiting_verdict: number;
  };
}

const emptyTally = (): CouponTally => ({ issued: 0, live: 0, spent: 0, expired: 0, withdrawn: 0, use_rate: 0 });
const emptyValue = (): ValueSpent => ({ goods_iqd: 0, delivery_iqd: 0, total_iqd: 0 });
const whole = (v: unknown) => Math.max(0, Math.trunc(Number(v) || 0));

function add(tally: CouponTally, state: RewardGrantState, n: number) {
  tally.issued += n;
  if (state === 'active') tally.live += n;
  else if (state === 'used') tally.spent += n;
  else if (state === 'expired') tally.expired += n;
  else tally.withdrawn += n;
}

const withRate = (t: CouponTally): CouponTally => ({ ...t, use_rate: t.issued > 0 ? Math.round((t.spent / t.issued) * 100) : 0 });

export async function rewardsOverview(db: D1Database, nowIso = new Date().toISOString()): Promise<RewardsOverview> {
  const { config, startedAt, off } = await weeklyProgramme(db);
  const kinds = REWARD_COUPON_KINDS.filter((k) => (k === 'free_shipping' ? config.free_shipping.enabled : config.filament.enabled));
  const missing = kinds.map((k) => `NOT EXISTS (SELECT 1 FROM reward_grants g WHERE g.source_ref = ${printerSourceRefSql(k, 'd')})`).join(' OR ') || '0';
  const nowMs = Date.parse(nowIso);
  const since = (days: number) => new Date(nowMs - days * DAY_MS).toISOString();

  const [slots, grants, value, misc, reviews, competitions] = await Promise.all([
    // The sweep's own WHERE, without its LIMIT, and «due» is its `missing` test.
    off
      ? Promise.resolve({ earning: 0, customers: 0, due: 0 })
      : db
          .prepare(
            `SELECT COUNT(*) AS earning, COUNT(DISTINCT o.user_id) AS customers, COALESCE(SUM(CASE WHEN (${missing}) THEN 1 ELSE 0 END), 0) AS due
               FROM (SELECT u.*, ${slotWeekSql(BINDS)} AS week
                       FROM order_item_units u
                      WHERE u.replacement_of_unit_id IS NULL
                        AND ${slotInsideMonthsSql(BINDS)}) AS d
               ${slotJoins()}
              WHERE d.week >= 0
                AND ${SLOT_SOLD_HERE_SQL}
                AND ${slotOpenSql()}
                AND ${slotTradedInSql()} IS NULL
                AND ${slotInShopSql()} IS NULL
                AND ${slotNotRefundedSql()}
                AND ${SLOT_IS_PRINTER_SQL}`
          )
          .bind(nowIso, startedAt ?? nowIso, config.weekly.months)
          .first<{ earning: number; customers: number; due: number }>(),
    db
      .prepare(
        `SELECT kind, state, COUNT(*) AS n
           FROM (SELECT g.kind, ${GRANT_STATE_SQL('?1')} AS state FROM reward_grants g LEFT JOIN coupons c ON c.id = g.coupon_id)
          GROUP BY kind, state`
      )
      .bind(nowIso)
      .all<{ kind: RewardCouponKind; state: RewardGrantState; n: number }>(),
    // Active only: a cancelled order gave its coupons back.
    db
      .prepare(
        `SELECT g.kind,
                COALESCE(SUM(v.amount_iqd), 0) AS all_time,
                COALESCE(SUM(CASE WHEN julianday(v.created_at) >= julianday(?1) THEN v.amount_iqd END), 0) AS last_30,
                COALESCE(SUM(CASE WHEN julianday(v.created_at) >= julianday(?2) THEN v.amount_iqd END), 0) AS last_7
           FROM (SELECT coupon_id, amount_iqd, created_at FROM coupon_redemptions WHERE state = 'active'
                 UNION ALL
                 SELECT coupon_id, amount_iqd, created_at FROM coupon_redemption_extras WHERE state = 'active') v
           JOIN reward_grants g ON g.coupon_id = v.coupon_id
          GROUP BY g.kind`
      )
      .bind(since(30), since(7))
      .all<{ kind: RewardCouponKind; all_time: number; last_30: number; last_7: number }>(),
    db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN source = 'points_shop' THEN points_spent ELSE 0 END), 0) AS points, MAX(issued_at) AS last_issued_at FROM reward_grants`
      )
      .first<{ points: number; last_issued_at: string | null }>(),
    db.prepare("SELECT COUNT(*) AS n FROM review_rewards WHERE kind = 'printer_gift' AND state = 'submitted'").first<{ n: number }>(),
    db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN starts_at <= ?1 AND ends_at > ?1 THEN 1 ELSE 0 END), 0) AS open,
                COALESCE(SUM(CASE WHEN ends_at <= ?1 THEN 1 ELSE 0 END), 0) AS awaiting
           FROM reward_competitions WHERE state = 'published'`
      )
      .bind(nowIso)
      .first<{ open: number; awaiting: number }>(),
  ]);

  // What the products took (DECISIONS row 299): a cancel gave its points back. Zero before 0229, and the rest of the overview stands.
  const productPoints = await db
    .prepare("SELECT COALESCE(SUM(points_spent), 0) AS points FROM gift_entitlements WHERE shop_item_id IS NOT NULL AND state <> 'cancelled'")
    .first<{ points: number }>()
    .catch((e: unknown) => {
      if (isSchemaMissing(e)) return null;
      throw e;
    });

  // The owner's own filament on an offer: his coupon takes nothing from it until he rules.
  const held = config.filament.enabled && !config.filament.on_offer && config.filament.product_ids.length > 0
    ? await db
        .prepare(`SELECT p.id, p.name, p.name_ar, p.name_ku FROM products p WHERE p.id IN (SELECT value FROM json_each(?1)) AND ${LIVE_OFFER_SQL('p.id', '?2')} ORDER BY p.name LIMIT 5`)
        .bind(JSON.stringify(config.filament.product_ids), nowIso)
        .all<{ id: string; name: string; name_ar: string | null; name_ku: string | null }>()
    : null;

  const tally: Record<RewardCouponKind, CouponTally> = { free_shipping: emptyTally(), filament_discount: emptyTally() };
  const all = emptyTally();
  for (const g of grants.results ?? []) {
    const n = whole(g.n);
    if (tally[g.kind]) add(tally[g.kind], g.state, n);
    add(all, g.state, n);
  }

  const spent = { last_7_days: emptyValue(), last_30_days: emptyValue(), all_time: emptyValue() };
  for (const v of value.results ?? []) {
    const part = v.kind === 'free_shipping' ? 'delivery_iqd' : 'goods_iqd';
    spent.last_7_days[part] += whole(v.last_7);
    spent.last_30_days[part] += whole(v.last_30);
    spent.all_time[part] += whole(v.all_time);
  }
  for (const w of Object.values(spent)) w.total_iqd = w.goods_iqd + w.delivery_iqd;

  const earning = whole(slots?.earning);
  const shipPart = config.free_shipping.enabled ? config.free_shipping.amount_iqd : 0;
  const filamentCap = config.filament.enabled ? config.filament.max_discount_iqd : 0;
  const perPrinter = shipPart + (filamentCap ?? 0);

  return {
    installed: true,
    server_time: nowIso,
    printers: { earning, customers: whole(slots?.customers), due_now: whole(slots?.due) },
    coupons: { free_shipping: withRate(tally.free_shipping), filament_discount: withRate(tally.filament_discount), all: withRate(all) },
    value_spent: spent,
    points_taken_by_shop: whole(misc?.points) + whole(productPoints?.points),
    weekly_exposure: { printers: earning, per_printer_iqd: perPrinter, ceiling_iqd: earning * perPrinter, filament_uncapped: filamentCap === null },
    last_issued_at: misc?.last_issued_at ?? null,
    switches: {
      enabled: config.enabled,
      weekly: config.weekly.enabled,
      free_shipping: config.free_shipping.enabled,
      filament: config.filament.enabled,
      shop_free_shipping: config.shop.free_shipping.enabled,
      shop_filament: config.shop.filament_discount.enabled,
      shop_products: config.shop.items.filter((i) => i.enabled).length,
      weekly_started: !!startedAt,
    },
    attention: {
      // Under the owner's own terms only the delivery coupon has a price: nothing waits on the other.
      shop_without_price:
        config.shop.free_shipping.enabled || config.shop.filament_discount.enabled || config.shop.items.some((i) => i.enabled)
          ? []
          : REWARD_COUPON_KINDS.filter((k) => config.shop[k].points === null),
      filament_on_offer: (held?.results ?? []).map((p) => ({ id: p.id, name: { ar: p.name_ar || p.name, en: p.name, ckb: p.name_ku || p.name } })),
      reviews_waiting: whole(reviews?.n),
      competitions_open: whole(competitions?.open),
      competitions_awaiting_verdict: whole(competitions?.awaiting),
    },
  };
}

/** The same shape on a database before 0220/0225: zeros and the settings, `installed: false`. */
export function emptyOverview(nowIso: string): RewardsOverview {
  return {
    installed: false,
    server_time: nowIso,
    printers: { earning: 0, customers: 0, due_now: 0 },
    coupons: { free_shipping: emptyTally(), filament_discount: emptyTally(), all: emptyTally() },
    value_spent: { last_7_days: emptyValue(), last_30_days: emptyValue(), all_time: emptyValue() },
    points_taken_by_shop: 0,
    weekly_exposure: { printers: 0, per_printer_iqd: 0, ceiling_iqd: 0, filament_uncapped: false },
    last_issued_at: null,
    switches: { enabled: false, weekly: false, free_shipping: false, filament: false, shop_free_shipping: false, shop_filament: false, shop_products: 0, weekly_started: false },
    attention: { shop_without_price: [], filament_on_offer: [], reviews_waiting: 0, competitions_open: 0, competitions_awaiting_verdict: 0 },
  };
}
