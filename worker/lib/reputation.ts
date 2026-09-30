/**
 * REPUTATION V2 — WHAT A WORKSHOP HAS EARNED, AND THE EVIDENCE FOR IT
 * (docs/COMMUNITY_ECOSYSTEM.md §9.6 «Reputation V2», migration 0163).
 *
 * ONE SYSTEM, THREE LAYERS.
 *
 *   1. THE DAY. `aggregateMerchantMetrics(env, day)` turns one Baghdad day of
 *      raw rows — the store's and the request's conversations, the orders that
 *      finished, the cancellations the merchant made, the disputes they lost —
 *      into ONE `merchant_metrics_daily` row per merchant. The day is written
 *      whole: its rows are replaced, so running a night twice changes nothing.
 *   2. THE WINDOWS. The last 30 and 90 complete days, summed in SQL, are the
 *      only input of every decision below. Nothing reads a counter somebody
 *      could edit (`completed_orders` stays the tier badge's).
 *   3. THE DECISIONS, PURE. `computeBadges`, `medianReplyWithin` and
 *      `rankSignalsFromMetrics` take the sums and answer; the routes, the
 *      nightly job and the matcher (worker/lib/printMatchingStore.ts) carry no
 *      arithmetic of their own, and the tests need no HTTP for the rules.
 *
 * THE BADGES ARE EXPLAINABLE BY CONSTRUCTION. Each one is stored as
 * `{key, since, evidence}` — the figures that earned it, as of the night it
 * was computed — so the merchant's own page can say «لأن ١٤ محادثة من أصل ٢٠
 * أُجيبت خلال ساعة». The PUBLIC reads carry `{key, since}` only
 * (`publicBadges`): a customer learns THAT a store answers fast, not how many
 * conversations it had. A badge whose evidence is gone is gone the next night.
 *
 * NO COPY LIVES HERE. The badge names, the «لماذا؟» sentences and the rule
 * explanations are the client's (ar / en / ckb); the server answers closed keys
 * and `rule_params` (`badgeCatalogue`).
 *
 * THE MEDIAN IS A COUNT, NOT AN ESTIMATE. A day keeps, beside the sum and the
 * count of first-reply gaps, how many were answered WITHIN each of the bounds
 * in `REPLY_BOUNDS` (cumulative). «The median reply came within an hour» is
 * then exactly «at least half the samples are in the ≤ 60 column», summed over
 * any window without keeping a single per-thread value. The store's
 * «يرد عادةً خلال …» line (`merchant_stores.responds_within_minutes`) is the
 * smallest bound holding the median — a promise the data backs, never an
 * interpolated number.
 */
import type { Env } from './types';
import { safeParse } from './types';
import { BAGHDAD_OFFSET_MS, addDays, baghdadDay, dayParts, isDay } from './baghdadTime';
import { isSchemaMissing } from './membershipBenefits';

// ============================================================ the catalogue

/** The closed badge catalogue, in the order a card shows them. */
export const BADGE_KEYS = ['verified_merchant', 'fast_response', 'reliable_seller', 'custom_specialist', 'high_completion'] as const;
export type BadgeKey = (typeof BADGE_KEYS)[number];

export function isBadgeKey(v: unknown): v is BadgeKey {
  return typeof v === 'string' && (BADGE_KEYS as readonly string[]).includes(v);
}

/**
 * The bounds a first reply is counted within, in minutes. Each is a sentence
 * the client can say («خلال ربع ساعة», «خلال ساعة», «خلال يوم»); 1440 is also
 * the cap — a turn nobody answered within a day is a sample of its own kind.
 */
export const REPLY_BOUNDS = [15, 30, 60, 120, 240, 480, 1440] as const;
export type ReplyBound = (typeof REPLY_BOUNDS)[number];
export const REPLY_CAP_MINUTES = 1440;
/** Under this many samples no median is claimed — not a badge, not a response line, not a ranking signal. */
export const MIN_REPLY_SAMPLES = 10;

/**
 * THE RULES, AS DATA — what `GET /api/community/badges` publishes as
 * `rule_params`, and the only numbers `computeBadges` compares against.
 * Percentages are whole percents so the client's sentence needs no rounding.
 */
export const BADGE_RULES = {
  verified_merchant: { verified: true },
  fast_response: { window_days: 30, median_within_minutes: 60, min_threads: MIN_REPLY_SAMPLES },
  reliable_seller: { window_days: 90, min_completed: 20, max_merchant_cancel_percent: 3, max_disputes_lost: 0 },
  custom_specialist: { window_days: 90, min_custom_completed: 10, accepts_custom_requests: true },
  high_completion: { window_days: 90, min_completion_percent: 95, min_orders: 20 },
} as const satisfies Record<BadgeKey, Record<string, number | boolean>>;

export interface BadgeCatalogueEntry {
  key: BadgeKey;
  rule_params: Record<string, number | boolean>;
}

/** The public catalogue: every key and the numbers its rule uses. The words are the client's. */
export function badgeCatalogue(): BadgeCatalogueEntry[] {
  return BADGE_KEYS.map((key) => ({ key, rule_params: { ...BADGE_RULES[key] } }));
}

// ============================================================ the sums

/** A window's (or a day's) figures — the `merchant_metrics_daily` columns. */
export interface MetricSums {
  first_reply_minutes_sum: number;
  first_reply_count: number;
  first_reply_within_15: number;
  first_reply_within_30: number;
  first_reply_within_60: number;
  first_reply_within_120: number;
  first_reply_within_240: number;
  first_reply_within_480: number;
  first_reply_within_1440: number;
  orders_completed: number;
  custom_orders_completed: number;
  orders_cancelled_by_merchant: number;
  disputes_lost: number;
}

/** Every metric column, in the table's order — the one list the SQL below is built from. */
export const METRIC_COLUMNS = [
  'first_reply_minutes_sum',
  'first_reply_count',
  'first_reply_within_15',
  'first_reply_within_30',
  'first_reply_within_60',
  'first_reply_within_120',
  'first_reply_within_240',
  'first_reply_within_480',
  'first_reply_within_1440',
  'orders_completed',
  'custom_orders_completed',
  'orders_cancelled_by_merchant',
  'disputes_lost',
] as const satisfies ReadonlyArray<keyof MetricSums>;

export const withinColumn = (bound: ReplyBound) => `first_reply_within_${bound}` as keyof MetricSums;

export function emptySums(): MetricSums {
  return Object.fromEntries(METRIC_COLUMNS.map((k) => [k, 0])) as unknown as MetricSums;
}

/** A row from the database (strings, nulls, a missing column) as whole, non-negative numbers. */
export function sumsFromRow(r: Record<string, unknown> | null | undefined): MetricSums {
  const out = emptySums();
  if (!r) return out;
  for (const k of METRIC_COLUMNS) {
    const v = Math.trunc(Number(r[k] ?? 0));
    out[k] = Number.isFinite(v) && v > 0 ? v : 0;
  }
  return out;
}

const isEmpty = (s: MetricSums) => METRIC_COLUMNS.every((k) => s[k] === 0);

// ============================================================ the decisions

/**
 * The smallest bound holding the MEDIAN first reply — the lower median, the
 * ⌈n/2⌉-th sample in order — or null: under `minSamples` samples, or a median
 * past a day (a merchant who mostly does not answer is not told «يرد خلال يوم»).
 */
export function medianReplyWithin(s: MetricSums, minSamples = MIN_REPLY_SAMPLES): ReplyBound | null {
  const n = s.first_reply_count;
  if (!(n >= minSamples) || n <= 0) return null;
  const half = Math.ceil(n / 2);
  for (const bound of REPLY_BOUNDS) if (s[withinColumn(bound)] >= half) return bound;
  return null;
}

/** Orders that ENDED on the merchant's side: finished, or walked away from. */
export const ordersEnded = (s: MetricSums) => s.orders_completed + s.orders_cancelled_by_merchant;

/** A share as a percent with one decimal — what the evidence shows; decisions compare exact integers. */
const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

export interface BadgeMerchant {
  verified: boolean;
  /** The store takes custom print requests (`merchant_stores.accepts_custom_requests`). */
  accepts_custom_requests: boolean;
}

export type BadgeEvidence = Record<string, number | boolean>;

export interface StoredBadge {
  key: BadgeKey;
  /** The Baghdad day it was first earned, held continuously since. */
  since: string;
  evidence: BadgeEvidence;
}

/** What each badge's evidence is, when the sums earn it; null when they do not. */
function evidenceFor(key: BadgeKey, m30: MetricSums, m90: MetricSums, merchant: BadgeMerchant): BadgeEvidence | null {
  switch (key) {
    case 'verified_merchant':
      return merchant.verified ? { verified: true } : null;
    case 'fast_response': {
      const r = BADGE_RULES.fast_response;
      const within = medianReplyWithin(m30, r.min_threads);
      return within !== null && within <= r.median_within_minutes
        ? { median_within_minutes: within, threads: m30.first_reply_count, window_days: r.window_days }
        : null;
    }
    case 'reliable_seller': {
      const r = BADGE_RULES.reliable_seller;
      const ended = ordersEnded(m90);
      const earned =
        m90.orders_completed >= r.min_completed &&
        // ≤ 3 %, compared as integers: cancelled × 100 ≤ 3 × ended.
        m90.orders_cancelled_by_merchant * 100 <= r.max_merchant_cancel_percent * ended &&
        m90.disputes_lost <= r.max_disputes_lost;
      return earned
        ? {
            completed: m90.orders_completed,
            merchant_cancel_percent: percent(m90.orders_cancelled_by_merchant, ended),
            disputes_lost: m90.disputes_lost,
            window_days: r.window_days,
          }
        : null;
    }
    case 'custom_specialist': {
      const r = BADGE_RULES.custom_specialist;
      return merchant.accepts_custom_requests && m90.custom_orders_completed >= r.min_custom_completed
        ? { custom_completed: m90.custom_orders_completed, window_days: r.window_days }
        : null;
    }
    case 'high_completion': {
      const r = BADGE_RULES.high_completion;
      const ended = ordersEnded(m90);
      return ended >= r.min_orders && m90.orders_completed * 100 >= r.min_completion_percent * ended
        ? { completion_percent: percent(m90.orders_completed, ended), orders: ended, window_days: r.window_days }
        : null;
    }
  }
}

/**
 * THE BADGES THE WINDOWS EARN — each with its evidence, and none without.
 *
 *   verified_merchant   `verified = 1` (an admin's mark)
 *   fast_response       median first reply ≤ 60 min over 30 days, ≥ 10 threads
 *   reliable_seller     ≥ 20 completed in 90 days, merchant cancels ≤ 3 % of
 *                       the orders that ended, no dispute lost
 *   custom_specialist   ≥ 10 completed custom (community) orders in 90 days,
 *                       and the store takes custom requests
 *   high_completion     completed ≥ 95 % of ≥ 20 orders that ended in 90 days
 *
 * «Ended» is completed + cancelled by the merchant: a customer's own
 * cancellation is not held against the workshop. `since` is carried from
 * `previous` while the badge is held without a break, else `today`.
 */
export function computeBadges(
  m30: MetricSums,
  m90: MetricSums,
  merchant: BadgeMerchant,
  opts: { today: string; previous?: readonly StoredBadge[] }
): StoredBadge[] {
  const out: StoredBadge[] = [];
  for (const key of BADGE_KEYS) {
    const evidence = evidenceFor(key, m30, m90, merchant);
    if (!evidence) continue;
    const held = opts.previous?.find((b) => b.key === key);
    out.push({ key, since: held && isDay(held.since) ? held.since : opts.today, evidence });
  }
  return out;
}

/** A stored `badges_json` as the badges it can honestly be read as: known keys, a day, an object of figures. */
export function parseStoredBadges(raw: unknown): StoredBadge[] {
  const list = typeof raw === 'string' ? safeParse<unknown>(raw, []) : raw;
  if (!Array.isArray(list)) return [];
  const byKey = new Map<BadgeKey, StoredBadge>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const b = item as Record<string, unknown>;
    if (!isBadgeKey(b.key) || !isDay(b.since) || byKey.has(b.key)) continue;
    const evidence: BadgeEvidence = {};
    if (b.evidence && typeof b.evidence === 'object' && !Array.isArray(b.evidence)) {
      for (const [k, v] of Object.entries(b.evidence as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) evidence[k] = v;
        else if (typeof v === 'boolean') evidence[k] = v;
      }
    }
    byKey.set(b.key, { key: b.key, since: b.since, evidence });
  }
  return BADGE_KEYS.filter((k) => byKey.has(k)).map((k) => byKey.get(k)!);
}

export interface PublicBadge {
  key: BadgeKey;
  since: string;
}

/**
 * WHAT A CUSTOMER SEES: `[{key, since}]`, never the evidence. Read from the
 * nightly `badges_json` — a database behind 0163 (no column) answers `[]` —
 * with one live guard: a verification an admin REVOKED is gone at once, not
 * the next night.
 */
export function publicBadges(m: Record<string, unknown> | null | undefined): PublicBadge[] {
  if (!m) return [];
  const verified = Number(m.verified ?? 0) === 1;
  return parseStoredBadges(m.badges_json)
    .filter((b) => b.key !== 'verified_merchant' || verified)
    .map((b) => ({ key: b.key, since: b.since }));
}

/** The matcher's two reputation signals (worker/lib/printMatchingScore.ts `RankSignals`). */
export interface ReputationSignals {
  /** The bound holding the 30-day median first reply; null = not enough history (ranks mid-table). */
  response_minutes: number | null;
  /** Merchant cancellations and lost disputes as a share of the orders that ended in 90 days, 0..1. */
  trouble_rate: number;
}

export function rankSignalsFromMetrics(m30: MetricSums, m90: MetricSums): ReputationSignals {
  const ended = ordersEnded(m90);
  const trouble = m90.orders_cancelled_by_merchant + m90.disputes_lost;
  return {
    response_minutes: medianReplyWithin(m30),
    trouble_rate: ended > 0 ? Math.min(1, trouble / ended) : 0,
  };
}

// ============================================================ a day's samples

/** The UTC instants bounding one Baghdad day, `[start, end)`, as ISO strings — or null for a malformed day. */
export function dayWindow(day: string): { start: string; end: string } | null {
  const p = dayParts(day);
  if (!p) return null;
  const start = Date.UTC(p.y, p.m - 1, p.d) - BAGHDAD_OFFSET_MS;
  return { start: new Date(start).toISOString(), end: new Date(start + 86_400_000).toISOString() };
}

/** One conversation's turn that day: the customer's opening message and the merchant's first reply after it. */
export interface ReplySample {
  merchant_id: string;
  opened_at: string;
  replied_at: string | null;
}

/**
 * A sample's gap in whole minutes (rounded UP — «within an hour» must be
 * true), `Infinity` for a turn not answered within a day, or null while it can
 * still change: unanswered and younger than a day. A pending sample is left
 * out of tonight's row and counted when the day is re-aggregated.
 */
export function replyGapMinutes(s: Pick<ReplySample, 'opened_at' | 'replied_at'>, nowMs: number): number | null {
  const opened = Date.parse(s.opened_at);
  if (!Number.isFinite(opened)) return null;
  const replied = s.replied_at ? Date.parse(s.replied_at) : NaN;
  if (Number.isFinite(replied)) {
    const gap = Math.max(0, Math.ceil((replied - opened) / 60_000));
    return gap > REPLY_CAP_MINUTES ? Infinity : gap;
  }
  return nowMs - opened >= REPLY_CAP_MINUTES * 60_000 ? Infinity : null;
}

/** Adds one final sample to a merchant's day. */
export function addReplySample(into: MetricSums, gap: number): void {
  into.first_reply_count += 1;
  into.first_reply_minutes_sum += Math.min(gap, REPLY_CAP_MINUTES);
  for (const bound of REPLY_BOUNDS) if (gap <= bound) into[withinColumn(bound)] += 1;
}

/**
 * THE TURNS OF ONE DAY. Per store or request thread with activity since the
 * day began: the customer's first message that day that OPENED a turn — the
 * message before it (system cards aside) was not the customer's own, so a
 * customer who writes four lines is one question waiting — and the first line
 * the merchant wrote after it, whenever that was. Sides come from
 * `chat_participants.role` (0124); a thread whose roles were never written is
 * not measured rather than guessed.
 */
const REPLY_SAMPLES_SQL = `
  SELECT x.merchant_id, x.chat_id, x.opened_at,
         (SELECT MIN(r.created_at) FROM chat_messages r
            JOIN chat_participants rp ON rp.chat_id = r.chat_id AND rp.user_id = r.sender_id AND rp.role = 'merchant'
           WHERE r.chat_id = x.chat_id AND r.created_at > x.opened_at AND r.is_system = 0) AS replied_at
    FROM (
      SELECT t.merchant_id, t.chat_id,
             (SELECT m.created_at FROM chat_messages m
                JOIN chat_participants cp ON cp.chat_id = m.chat_id AND cp.user_id = m.sender_id AND cp.role = 'customer'
               WHERE m.chat_id = t.chat_id AND m.created_at >= ?1 AND m.created_at < ?2 AND m.is_system = 0
                 AND COALESCE((SELECT p.sender_id FROM chat_messages p
                                WHERE p.chat_id = m.chat_id AND p.is_system = 0
                                  AND (p.created_at < m.created_at OR (p.created_at = m.created_at AND p.id < m.id))
                                ORDER BY p.created_at DESC, p.id DESC LIMIT 1), '') <> m.sender_id
               ORDER BY m.created_at, m.id LIMIT 1) AS opened_at
        FROM (SELECT ch.id AS chat_id, s.merchant_id
                FROM chats ch JOIN merchant_stores s ON s.id = ch.store_id
               WHERE ch.context_type IN ('store','request') AND COALESCE(ch.last_message_at, '') >= ?1) t
    ) x
   WHERE x.opened_at IS NOT NULL`;

/** How far back an order may have been PLACED and still finish on the day — the orders indexes' range. */
const ORDER_AGE_DAYS = 365;

export interface AggregateReport {
  day: string;
  merchants: number;
  samples: number;
  pending: number;
}

/**
 * ONE BAGHDAD DAY, INTO `merchant_metrics_daily` — the whole day, idempotent.
 *
 *   first replies            REPLY_SAMPLES_SQL, final samples only
 *   orders_completed         community orders `completed` that day (a partial
 *                            refund completes an order, audit review F9) +
 *                            store orders delivered that day
 *   custom_orders_completed  the community part of the above
 *   cancelled by merchant    a store order's cancellation row written «by the
 *                            merchant» (worker/lib/storeOrderOps.ts
 *                            `cancelStoreOrder`: id `osh_cancel_<order>`) + a
 *                            community order's `community.order_cancelled`
 *                            audit row with `by: merchant`
 *   disputes_lost            `dispute_lost` reputation events that day (the
 *                            escrow resolve writes one per order)
 *
 * Written in one batch: the day's rows for merchants with nothing that day
 * are deleted and everyone else's upserted, so the second run of a night, and
 * the re-run the next night (when yesterday's pending replies have settled),
 * each leave exactly the day's truth.
 */
export async function aggregateMerchantMetrics(env: Env, day: string, nowMs = Date.now()): Promise<AggregateReport> {
  const win = dayWindow(day);
  if (!win) throw new Error(`aggregateMerchantMetrics: not a day: ${day}`);
  const db = env.DB;
  const placedFrom = new Date(Date.parse(win.start) - ORDER_AGE_DAYS * 86_400_000).toISOString();
  const counts = (sql: string, ...binds: unknown[]) =>
    db.prepare(sql).bind(...binds).all<{ merchant_id: string; n: number }>().then((r) => r.results ?? []);

  const [samples, customDone, storeDelivered, storeCancelled, customCancelled, lost] = await Promise.all([
    db.prepare(REPLY_SAMPLES_SQL).bind(win.start, win.end).all<ReplySample>().then((r) => r.results ?? []),
    counts(
      `SELECT merchant_id, COUNT(*) AS n FROM community_orders
        WHERE state = 'completed' AND completed_at >= ?1 AND completed_at < ?2 GROUP BY merchant_id`,
      win.start, win.end
    ),
    counts(
      `SELECT merchant_id, COUNT(*) AS n FROM orders
        WHERE status = 'delivered' AND created_at >= ?3 AND seller_type = 'merchant' AND merchant_id IS NOT NULL
          AND delivered_at >= ?1 AND delivered_at < ?2
        GROUP BY merchant_id`,
      win.start, win.end, placedFrom
    ),
    counts(
      `SELECT o.merchant_id, COUNT(*) AS n FROM orders o
         JOIN order_status_history h ON h.id = 'osh_cancel_' || o.id
        WHERE o.status = 'cancelled' AND o.created_at >= ?3 AND o.seller_type = 'merchant' AND o.merchant_id IS NOT NULL
          AND h.changed_at >= ?1 AND h.changed_at < ?2 AND h.note LIKE 'Cancelled by the merchant%'
        GROUP BY o.merchant_id`,
      win.start, win.end, placedFrom
    ),
    counts(
      `SELECT o.merchant_id, COUNT(*) AS n FROM audit_log a JOIN community_orders o ON o.id = a.target
        WHERE a.action = 'community.order_cancelled' AND a.created_at >= ?1 AND a.created_at < ?2
          AND json_valid(a.detail) AND json_extract(a.detail, '$.by') = 'merchant'
        GROUP BY o.merchant_id`,
      win.start, win.end
    ),
    counts(
      `SELECT merchant_id, COUNT(*) AS n FROM merchant_reputation_events
        WHERE kind = 'dispute_lost' AND created_at >= ?1 AND created_at < ?2 GROUP BY merchant_id`,
      win.start, win.end
    ),
  ]);

  const byMerchant = new Map<string, MetricSums>();
  const of = (id: string) => {
    let s = byMerchant.get(id);
    if (!s) byMerchant.set(id, (s = emptySums()));
    return s;
  };
  let pending = 0;
  for (const sample of samples) {
    const gap = replyGapMinutes(sample, nowMs);
    if (gap === null) {
      pending += 1;
      continue;
    }
    addReplySample(of(String(sample.merchant_id)), gap);
  }
  for (const r of customDone) {
    const s = of(String(r.merchant_id));
    s.orders_completed += Number(r.n) || 0;
    s.custom_orders_completed += Number(r.n) || 0;
  }
  for (const r of storeDelivered) of(String(r.merchant_id)).orders_completed += Number(r.n) || 0;
  for (const r of storeCancelled) of(String(r.merchant_id)).orders_cancelled_by_merchant += Number(r.n) || 0;
  for (const r of customCancelled) of(String(r.merchant_id)).orders_cancelled_by_merchant += Number(r.n) || 0;
  for (const r of lost) of(String(r.merchant_id)).disputes_lost += Number(r.n) || 0;

  const rows = [...byMerchant.entries()].filter(([, s]) => !isEmpty(s));
  const computedAt = new Date(nowMs).toISOString();
  const cols = METRIC_COLUMNS.join(', ');
  const picks = METRIC_COLUMNS.map((k) => `json_extract(value, '$.${k}')`).join(', ');
  const sets = METRIC_COLUMNS.map((k) => `${k} = excluded.${k}`).join(', ');
  const stmts: D1PreparedStatement[] = [
    db
      .prepare('DELETE FROM merchant_metrics_daily WHERE day = ?1 AND merchant_id NOT IN (SELECT value FROM json_each(?2))')
      .bind(day, JSON.stringify(rows.map(([id]) => id))),
  ];
  // One statement per 100 merchants: every row travels as ONE json parameter,
  // so D1's bound-parameter ceiling never applies.
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100).map(([merchant_id, s]) => ({ merchant_id, ...s }));
    stmts.push(
      db
        .prepare(
          `INSERT INTO merchant_metrics_daily (merchant_id, day, ${cols}, computed_at)
           SELECT json_extract(value, '$.merchant_id'), ?1, ${picks}, ?3
             FROM json_each(?2)
            WHERE EXISTS (SELECT 1 FROM community_merchants m WHERE m.id = json_extract(value, '$.merchant_id'))
           ON CONFLICT(merchant_id, day) DO UPDATE SET ${sets}, computed_at = excluded.computed_at`
        )
        .bind(day, JSON.stringify(chunk), computedAt)
    );
  }
  await db.batch(stmts);
  return { day, merchants: rows.length, samples: samples.length - pending, pending };
}

// ============================================================ the windows

/** Every merchant's sums over `[from, to)` (Baghdad days), or only these merchants'. */
export async function windowSums(db: D1Database, from: string, to: string, merchantIds?: readonly string[]): Promise<Map<string, MetricSums>> {
  const sums = METRIC_COLUMNS.map((k) => `SUM(${k}) AS ${k}`).join(', ');
  const scoped = merchantIds !== undefined;
  const { results } = await db
    .prepare(
      `SELECT merchant_id, ${sums} FROM merchant_metrics_daily
        WHERE day >= ?1 AND day < ?2 ${scoped ? 'AND merchant_id IN (SELECT value FROM json_each(?3))' : ''}
        GROUP BY merchant_id`
    )
    .bind(...(scoped ? [from, to, JSON.stringify([...new Set(merchantIds)])] : [from, to]))
    .all<Record<string, unknown>>();
  return new Map((results ?? []).map((r) => [String(r.merchant_id), sumsFromRow(r)]));
}

/**
 * The matcher's signals for these merchants, from the last 30 / 90 complete
 * days. A database behind 0163 answers an empty map: every workshop keeps the
 * «no history» signals it had before (null, 0) — ranking never fails over it.
 */
export async function reputationSignals(
  db: D1Database,
  merchantIds: readonly string[],
  today = baghdadDay(Date.now())
): Promise<Map<string, ReputationSignals>> {
  const out = new Map<string, ReputationSignals>();
  if (!merchantIds.length) return out;
  try {
    const [m30, m90] = await Promise.all([
      windowSums(db, addDays(today, -BADGE_RULES.fast_response.window_days), today, merchantIds),
      windowSums(db, addDays(today, -BADGE_RULES.reliable_seller.window_days), today, merchantIds),
    ]);
    for (const id of new Set(merchantIds)) {
      if (!m30.has(id) && !m90.has(id)) continue;
      out.set(id, rankSignalsFromMetrics(m30.get(id) ?? emptySums(), m90.get(id) ?? emptySums()));
    }
  } catch (e) {
    if (!isSchemaMissing(e)) throw e;
  }
  return out;
}

// ============================================================ the night

export interface RefreshReport {
  merchants: number;
  badges_changed: number;
  response_changed: number;
}

/**
 * THE NIGHTLY DECISION — every merchant's badges and response line, from the
 * windows ending yesterday. Only rows that changed are written (fifty to a
 * batch, like `refreshStaleMerchantBadges` beside it), so a quiet night is
 * three reads.
 */
export async function refreshMerchantReputation(env: Env, today: string): Promise<RefreshReport> {
  const db = env.DB;
  const [merchants, m30, m90] = await Promise.all([
    db
      .prepare(
        `SELECT m.id, m.verified, m.badges_json, s.id AS store_id, s.accepts_custom_requests, s.responds_within_minutes
           FROM community_merchants m LEFT JOIN merchant_stores s ON s.merchant_id = m.id`
      )
      .all<Record<string, unknown>>()
      .then((r) => r.results ?? []),
    windowSums(db, addDays(today, -BADGE_RULES.fast_response.window_days), today),
    windowSums(db, addDays(today, -BADGE_RULES.reliable_seller.window_days), today),
  ]);
  const writes: D1PreparedStatement[] = [];
  let badgesChanged = 0;
  let responseChanged = 0;
  for (const m of merchants) {
    const id = String(m.id);
    const s30 = m30.get(id) ?? emptySums();
    const s90 = m90.get(id) ?? emptySums();
    const previous = parseStoredBadges(m.badges_json);
    const badges = computeBadges(
      s30,
      s90,
      { verified: Number(m.verified ?? 0) === 1, accepts_custom_requests: Number(m.accepts_custom_requests ?? 0) === 1 },
      { today, previous }
    );
    // The stored text is exactly what the last night wrote, so the strings compare.
    const next = JSON.stringify(badges);
    if (m.badges_json !== next) {
      writes.push(db.prepare('UPDATE community_merchants SET badges_json = ? WHERE id = ?').bind(next, id));
      badgesChanged += 1;
    }
    if (typeof m.store_id === 'string' && m.store_id) {
      const within = medianReplyWithin(s30);
      const have = m.responds_within_minutes === null || m.responds_within_minutes === undefined ? null : Number(m.responds_within_minutes);
      if (within !== have) {
        writes.push(db.prepare('UPDATE merchant_stores SET responds_within_minutes = ? WHERE id = ?').bind(within, m.store_id));
        responseChanged += 1;
      }
    }
  }
  for (let i = 0; i < writes.length; i += 50) await db.batch(writes.slice(i, i + 50));
  return { merchants: merchants.length, badges_changed: badgesChanged, response_changed: responseChanged };
}

/**
 * ONCE PER BAGHDAD DAY, FROM THE FIFTEEN-MINUTE CRON. The claim is a fixed-window row in
 * `rate_limits` whose window is the day's own first second, so the limiter's
 * opportunistic prune (rows older than a day) can never reopen it the same
 * day — and it is RELEASED when the run fails, so the next tick retries rather
 * than waiting a night.
 */
const CLAIM_KEY = 'sweep:reputation-daily';

function dayStartSeconds(day: string): number {
  const win = dayWindow(day);
  return win ? Math.floor(Date.parse(win.start) / 1000) : 0;
}

async function claimDay(db: D1Database, day: string): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN window_start = ?2 THEN count + 1 ELSE 1 END,
         window_start = ?2
       RETURNING count`
    )
    .bind(CLAIM_KEY, dayStartSeconds(day))
    .first<{ count: number }>();
  return Number(row?.count) === 1;
}

async function releaseDay(db: D1Database, day: string): Promise<void> {
  await db.prepare('DELETE FROM rate_limits WHERE key = ? AND window_start = ?').bind(CLAIM_KEY, dayStartSeconds(day)).run();
}

export interface ReputationRunReport {
  /** The Baghdad day this run belongs to. */
  day: string;
  /** False when this day's run already happened (or a missing table skipped it). */
  ran: boolean;
  aggregated: AggregateReport[];
  refresh: RefreshReport | null;
  skipped?: 'schema';
}

/**
 * THE NIGHT'S WORK: the day before yesterday again (its last replies have now
 * had a full day to arrive, so its row becomes final) and yesterday, then
 * every merchant's badges and response line from the windows they close.
 * Registered on the scheduled handler in worker/index.ts beside the durable
 * jobs (whose `merchant_badges` step keeps the TIER badge in step); contained
 * like them — a failure is logged there, never a failed invocation.
 */
export async function runReputationJobs(env: Env, nowMs = Date.now()): Promise<ReputationRunReport> {
  const today = baghdadDay(nowMs);
  const report: ReputationRunReport = { day: today, ran: false, aggregated: [], refresh: null };
  if (!(await claimDay(env.DB, today))) return report;
  try {
    for (const day of [addDays(today, -2), addDays(today, -1)]) {
      report.aggregated.push(await aggregateMerchantMetrics(env, day, nowMs));
    }
    report.refresh = await refreshMerchantReputation(env, today);
    report.ran = true;
    return report;
  } catch (e) {
    await releaseDay(env.DB, today).catch(() => undefined);
    if (isSchemaMissing(e)) {
      console.error(`reputation: the database is behind 0163 — skipped (${e instanceof Error ? e.message : String(e)})`);
      return { ...report, skipped: 'schema' };
    }
    throw e;
  }
}

// ============================================================ the merchant's own page

export interface WindowSummary {
  window_days: number;
  first_reply_count: number;
  /** The bound holding the median (null under 10 samples or past a day). */
  median_within_minutes: number | null;
  /** The mean gap, each capped at a day — beside the median, never instead of it. */
  first_reply_avg_minutes: number | null;
  orders_completed: number;
  custom_orders_completed: number;
  orders_cancelled_by_merchant: number;
  disputes_lost: number;
  orders_ended: number;
  merchant_cancel_percent: number | null;
  completion_percent: number | null;
}

export function summarizeWindow(s: MetricSums, windowDays: number): WindowSummary {
  const ended = ordersEnded(s);
  return {
    window_days: windowDays,
    first_reply_count: s.first_reply_count,
    median_within_minutes: medianReplyWithin(s),
    first_reply_avg_minutes: s.first_reply_count > 0 ? Math.round(s.first_reply_minutes_sum / s.first_reply_count) : null,
    orders_completed: s.orders_completed,
    custom_orders_completed: s.custom_orders_completed,
    orders_cancelled_by_merchant: s.orders_cancelled_by_merchant,
    disputes_lost: s.disputes_lost,
    orders_ended: ended,
    merchant_cancel_percent: ended > 0 ? percent(s.orders_cancelled_by_merchant, ended) : null,
    completion_percent: ended > 0 ? percent(s.orders_completed, ended) : null,
  };
}

export interface MerchantReputation {
  /** The badges as last computed, WITH their evidence — the owner's eyes only. */
  badges: StoredBadge[];
  responds_within_minutes: number | null;
  metrics: { window_30: WindowSummary; window_90: WindowSummary };
  rules: typeof BADGE_RULES;
  /** The last day the windows include (yesterday, Baghdad). */
  through: string;
}

/**
 * GET /api/merchant/reputation's body (worker/routes/merchantReputation.ts):
 * the stored badges with their evidence and the live windows, so the page can
 * show what is missing for a badge not yet earned. Null behind 0163.
 */
export async function merchantReputation(db: D1Database, merchantId: string, today = baghdadDay(Date.now())): Promise<MerchantReputation | null> {
  try {
    const [m, s30, s90] = await Promise.all([
      db
        .prepare(
          `SELECT m.badges_json, s.responds_within_minutes
             FROM community_merchants m LEFT JOIN merchant_stores s ON s.merchant_id = m.id WHERE m.id = ?`
        )
        .bind(merchantId)
        .first<Record<string, unknown>>(),
      windowSums(db, addDays(today, -30), today, [merchantId]),
      windowSums(db, addDays(today, -90), today, [merchantId]),
    ]);
    const within = m?.responds_within_minutes;
    return {
      badges: parseStoredBadges(m?.badges_json),
      responds_within_minutes: within === null || within === undefined ? null : Number(within),
      metrics: {
        window_30: summarizeWindow(s30.get(merchantId) ?? emptySums(), 30),
        window_90: summarizeWindow(s90.get(merchantId) ?? emptySums(), 90),
      },
      rules: BADGE_RULES,
      through: addDays(today, -1),
    };
  } catch (e) {
    if (isSchemaMissing(e)) return null;
    throw e;
  }
}
