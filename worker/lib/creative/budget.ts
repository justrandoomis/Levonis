/**
 * THE SPEND GUARD — a worst-case reservation before every provider call
 * (spec §29; docs/CREATIVE_STUDIO.md §4 "Budget").
 *
 * ONE CONDITIONAL UPDATE RESERVES. Before a call, the worst case it can cost
 * (its input estimate plus its full `max_tokens`, and the USD that would cost
 * when the owner has entered rates) is added to today's row of
 * `creative_spend_day` — but only if, with it, the day stays within every cap:
 * requests, tokens, the daily and monthly USD caps (rates only), and the
 * number of calls in flight. SQLite runs the check and the increment as one
 * statement, so two parallel calls can never both take the last slot: the
 * second one's WHERE sees the first one's reservation and fails.
 *
 * AFTER THE CALL the reservation is SETTLED with the real usage (or the worst
 * case again when the outcome is unknown — a timeout may still be billed), or
 * RELEASED when the provider certainly did not process the request. A
 * reservation whose Worker died before settling is released by `sweepStale`
 * after five minutes (the longest call deadline is one minute plus one retry),
 * so a crash can never wedge the parallel limit for the rest of the day.
 *
 * COST IS AN ESTIMATE, AND SAYS SO. Micro-USD = tokens × the owner's rate per
 * million tokens. Cache tokens are priced at the full input rate (an upper
 * bound: the studio sends no cache_control). Without rates the cost is null —
 * never a guessed number.
 */
import type { Rates, UsageTotals } from '../../../packages/creativeDoc/src/api';
import { addDays, baghdadDay } from '../baghdadTime';
import type { ProviderUsage } from './anthropic';
import type { BudgetSettings } from '../../../packages/creativeDoc/src/api';

export type ReserveRefusal = 'BUDGET_EXCEEDED' | 'PARALLEL_LIMIT';

export interface Reservation {
  day: string;
  tokens: number;
  usdMicro: number;
}

/** Micro-USD for a token count at a per-million rate: tokens × rate (USD per 1M tokens = micro-USD per token). */
export function microUsd(tokens: number, ratePerMtokUsd: number): number {
  return Math.ceil(tokens * ratePerMtokUsd);
}

/** The estimated cost of a usage, or null without rates. */
export function estimateCostMicro(usage: ProviderUsage | null, rates: Rates | null): number | null {
  if (!usage || !rates) return null;
  const input = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
  return microUsd(input, rates.input_per_mtok_usd) + microUsd(usage.output_tokens, rates.output_per_mtok_usd);
}

/** The worst case of one call: its input estimate and its whole output budget. */
export function worstCase(inputTokens: number, maxTokens: number, rates: Rates | null): { tokens: number; usdMicro: number } {
  const tokens = inputTokens + maxTokens;
  const usdMicro = rates ? microUsd(inputTokens, rates.input_per_mtok_usd) + microUsd(maxTokens, rates.output_per_mtok_usd) : 0;
  return { tokens, usdMicro };
}

/**
 * A conservative input estimate: the UTF-8 bytes of the request body over two
 * (Arabic letters are two bytes; any tokenizer yields fewer tokens than this
 * for the JSON and prose the studio sends), plus the image allowance.
 */
export function estimateInputTokens(bodyText: string, imageTokens = 0): number {
  return Math.ceil(new TextEncoder().encode(bodyText).length / 2) + imageTokens;
}

/** An image's token allowance from its pixel size (≈ width×height/750, capped). */
export function imageTokenAllowance(width: number | null, height: number | null): number {
  if (!width || !height) return 5_000;
  return Math.min(5_000, Math.ceil((width * height) / 750));
}

const monthStart = (day: string) => `${day.slice(0, 7)}-01`;

/**
 * Reserve, or say which cap refused. `now` is injectable for the day boundary
 * (Asia/Baghdad, worker/lib/baghdadTime.ts).
 */
export async function reserve(
  db: D1Database,
  budget: BudgetSettings,
  rates: Rates | null,
  need: { tokens: number; usdMicro: number },
  nowMs = Date.now()
): Promise<{ ok: true; reservation: Reservation } | { ok: false; code: ReserveRefusal }> {
  const day = baghdadDay(nowMs);
  const dailyUsdMicro = rates && budget.daily_usd !== null ? Math.round(budget.daily_usd * 1_000_000) : null;
  const monthlyUsdMicro = rates && budget.monthly_usd !== null ? Math.round(budget.monthly_usd * 1_000_000) : null;
  await db.prepare('INSERT OR IGNORE INTO creative_spend_day (day) VALUES (?)').bind(day).run();
  const res = await db
    .prepare(
      `UPDATE creative_spend_day
          SET requests = requests + 1,
              tokens_reserved = tokens_reserved + ?2,
              usd_micro_reserved = usd_micro_reserved + ?3,
              in_flight = in_flight + 1
        WHERE day = ?1
          AND requests < ?4
          AND tokens_used + tokens_reserved + ?2 <= ?5
          AND in_flight < ?6
          AND (?7 IS NULL OR usd_micro_spent + usd_micro_reserved + ?3 <= ?7)
          AND (?8 IS NULL OR (SELECT COALESCE(SUM(m.usd_micro_spent + m.usd_micro_reserved), 0) FROM creative_spend_day m WHERE m.day >= ?9 AND m.day <= ?1) + ?3 <= ?8)`
    )
    .bind(day, need.tokens, need.usdMicro, budget.daily_requests, budget.daily_tokens, budget.max_parallel, dailyUsdMicro, monthlyUsdMicro, monthStart(day))
    .run();
  if ((res.meta?.changes ?? 0) === 1) return { ok: true, reservation: { day, tokens: need.tokens, usdMicro: need.usdMicro } };
  const row = await db.prepare('SELECT in_flight FROM creative_spend_day WHERE day = ?').bind(day).first<{ in_flight: number }>();
  return { ok: false, code: (row?.in_flight ?? 0) >= budget.max_parallel ? 'PARALLEL_LIMIT' : 'BUDGET_EXCEEDED' };
}

/** Replace a reservation with what the call really used (`tokens`, `usdMicro` ≥ 0). */
export function settleStatement(db: D1Database, r: Reservation, used: { tokens: number; usdMicro: number }): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE creative_spend_day
          SET tokens_reserved = MAX(0, tokens_reserved - ?2),
              usd_micro_reserved = MAX(0, usd_micro_reserved - ?3),
              tokens_used = tokens_used + ?4,
              usd_micro_spent = usd_micro_spent + ?5,
              in_flight = MAX(0, in_flight - 1)
        WHERE day = ?1`
    )
    .bind(r.day, r.tokens, r.usdMicro, Math.max(0, Math.round(used.tokens)), Math.max(0, Math.round(used.usdMicro)));
}

/** Give a reservation back: the provider did not process the request. */
export function releaseStatement(db: D1Database, r: Reservation): D1PreparedStatement {
  return settleStatement(db, r, { tokens: 0, usdMicro: 0 });
}

/** Today's and this month's totals from the usage ledger (estimated cost only with rates). */
export async function usageTotals(db: D1Database, nowMs = Date.now()): Promise<{ today: UsageTotals; month: UsageTotals }> {
  const day = baghdadDay(nowMs);
  // Baghdad midnight as a UTC instant: the day string at 00:00 +03:00.
  const dayStartUtc = new Date(`${day}T00:00:00+03:00`).toISOString();
  const monthStartUtc = new Date(`${monthStart(day)}T00:00:00+03:00`).toISOString();
  const totals = async (from: string): Promise<UsageTotals> => {
    const r = await db
      .prepare(
        `SELECT COUNT(*) AS requests, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
                SUM(est_cost_micro_usd) AS cost, COUNT(est_cost_micro_usd) AS costed
           FROM creative_usage WHERE created_at >= ?`
      )
      .bind(from)
      .first<{ requests: number; input_tokens: number; output_tokens: number; cost: number | null; costed: number }>();
    return {
      requests: r?.requests ?? 0,
      input_tokens: r?.input_tokens ?? 0,
      output_tokens: r?.output_tokens ?? 0,
      est_cost_usd: r && r.costed > 0 && r.cost !== null ? Math.round(r.cost) / 1_000_000 : null,
    };
  };
  return { today: await totals(dayStartUtc), month: await totals(monthStartUtc) };
}

/** Is there budget left today for at least one more request? (For `ready` on the provider page.) */
export async function budgetLeft(db: D1Database, budget: BudgetSettings, nowMs = Date.now()): Promise<boolean> {
  const row = await db
    .prepare('SELECT requests, tokens_used, tokens_reserved FROM creative_spend_day WHERE day = ?')
    .bind(baghdadDay(nowMs))
    .first<{ requests: number; tokens_used: number; tokens_reserved: number }>();
  if (!row) return true;
  return row.requests < budget.daily_requests && row.tokens_used + row.tokens_reserved < budget.daily_tokens;
}

/** The days a usage page covers, newest first (Asia/Baghdad). */
export function lastDays(n: number, nowMs = Date.now()): string[] {
  const today = baghdadDay(nowMs);
  return Array.from({ length: n }, (_, i) => addDays(today, -i));
}
