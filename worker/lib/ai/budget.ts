/**
 * THE DAILY CAP, RESERVED BEFORE EVERY CALL (push B plan §6.8, §10; I9).
 *
 * Integer micro-USD, one cap across every provider, UTC days (the same day
 * the FX `provider_calls_day` and the Workers AI free allocation use).
 *
 *   worstCaseMicro  what one call could cost at most, from the owner's rates
 *   reserve         ONE conditional UPDATE at that worst case, with the guest
 *                   share inside the same WHERE: no row changed, no call
 *   settle          swaps the reservation for the real cost and writes the
 *                   ledger row, in one batch
 *
 * FAIL CLOSED. A reservation that cannot be written is a refusal. A settle
 * that never lands (the Worker dies, D1 refuses) leaves the reservation in
 * place, so the day's headroom shrinks instead of growing; the day row then
 * simply expires with its day.
 */
import type { AiConfig, LedgerRow, Rates, TaskModel, Usage } from './types';

/** `YYYY-MM-DD` of the UTC day containing `nowMs`. */
export const utcDay = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

/** The most output a structured answer may spend (plan §7: `max_tokens` 1536). */
export const MAX_OUTPUT_TOKENS = 1536;
/** Headroom added to the measured prompt bytes for the request envelope and the schema. */
export const INPUT_HEADROOM_TOKENS = 2000;
/** The longest note a speech call is charged for, whatever the provider reports. */
export const SPEECH_WORST_MS = 75_000;
/** One call may use at most this share of the daily cap (§10), as a divisor. */
export const PER_CALL_CAP_DIVISOR = 10;

/**
 * The provider's input tokens can never exceed the UTF-8 byte count of the
 * text (a token is at least one byte), plus the headroom, plus each picture's
 * own token estimate. Over-counting is the point: this is the reservation.
 */
export function estimateInputTokens(system: string, userText: string, imageTokenCounts: readonly number[] = []): number {
  const bytes = new TextEncoder().encode(system + userText).byteLength;
  return bytes + INPUT_HEADROOM_TOKENS + imageTokenCounts.reduce((s, n) => s + n, 0);
}

const mul = (tokens: number, ratePerMTok: number) => tokens * ratePerMTok;

export function worstCaseMicro(m: TaskModel, est: { inputTokens: number; maxTokens: number; speechMs?: number }): number {
  if (m.task === 'speech') {
    const ms = Math.max(est.speechMs ?? 0, SPEECH_WORST_MS);
    return Math.ceil((ms * m.rates.speechPerMinute) / 60_000);
  }
  // No request asks for caching (plan §3), so every input token is billed at the input rate.
  return Math.ceil((mul(est.inputTokens, m.rates.inPerMTok) + mul(est.maxTokens, m.rates.outPerMTok)) / 1_000_000);
}

/**
 * The real cost of one call (§10):
 *   ceil((in·inR + cw·cwR′ + cr·crR′ + out·outR) / 1e6) + ceil(speechMs/60000 · minR)
 * with cwR′ the entered cache-write rate or 2 × inR when it is 0, and crR′
 * the entered cache-read rate or inR when it is 0. Reasoning tokens are
 * already inside `output_tokens`.
 */
export function costMicro(r: Rates, u: Usage): number {
  const cwR = r.cacheWritePerMTok > 0 ? r.cacheWritePerMTok : 2 * r.inPerMTok;
  const crR = r.cacheReadPerMTok > 0 ? r.cacheReadPerMTok : r.inPerMTok;
  const tokens =
    mul(u.inputTokens, r.inPerMTok) + mul(u.cacheWriteTokens, cwR) + mul(u.cacheReadTokens, crR) + mul(u.outputTokens, r.outPerMTok);
  return Math.ceil(tokens / 1_000_000) + Math.ceil((u.speechMs * r.speechPerMinute) / 60_000);
}

/** The rates a task cannot run without (§11: in and out for text and vision, per-minute for speech). */
export function hasRequiredRates(m: Pick<TaskModel, 'task' | 'rates'>): boolean {
  return m.task === 'speech' ? m.rates.speechPerMinute > 0 : m.rates.inPerMTok > 0 && m.rates.outPerMTok > 0;
}

/** Most a single call may reserve against this cap. */
export const perCallLimitMicro = (capMicro: number): number => Math.floor(capMicro / PER_CALL_CAP_DIVISOR);

/**
 * Reserve `micro` against today's cap. ONE conditional UPDATE (after an
 * idempotent INSERT of the day row) decides, so fifty concurrent callers can
 * never together pass the cap; a guest's call must also fit the guest share,
 * inside the same WHERE. `true` only when exactly one row changed.
 */
export async function reserve(db: D1Database, day: string, micro: number, cfg: AiConfig, guest: boolean): Promise<boolean> {
  if (!Number.isSafeInteger(micro) || micro <= 0 || cfg.capMicro <= 0) return false;
  try {
    const [, upd] = await db.batch([
      db.prepare('INSERT OR IGNORE INTO ai_spend_day (day) VALUES (?1)').bind(day),
      db
        .prepare(
          `UPDATE ai_spend_day
              SET reserved_micro_usd = reserved_micro_usd + ?2,
                  guest_micro_usd    = guest_micro_usd + (?2 * ?4),
                  calls = calls + 1
            WHERE day = ?1
              AND spent_micro_usd + reserved_micro_usd + ?2 <= ?3
              AND (?4 = 0 OR guest_micro_usd + ?2 <= (?3 * ?5) / 100)`
        )
        .bind(day, micro, cfg.capMicro, guest ? 1 : 0, cfg.guestSharePct),
    ]);
    return Number(upd?.meta?.changes ?? 0) === 1;
  } catch {
    return false;
  }
}

/**
 * Swap the reservation for the real cost and write the ledger row, one batch.
 * Never throws: a lost settle keeps the reservation (fail closed).
 */
export async function settle(db: D1Database, day: string, reserved: number, guest: boolean, row: LedgerRow): Promise<void> {
  const g = guest ? 1 : 0;
  const cost = Math.max(0, Math.floor(row.costMicro));
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE ai_spend_day
              SET reserved_micro_usd = MAX(0, reserved_micro_usd - ?2),
                  spent_micro_usd = spent_micro_usd + ?3,
                  guest_micro_usd = MAX(0, guest_micro_usd - (?2 * ?4) + (?3 * ?4))
            WHERE day = ?1`
        )
        .bind(day, reserved, cost, g),
      db
        .prepare(
          `INSERT INTO ai_usage (day, task, rank, provider, model_id, outcome, guest, input_tokens, output_tokens,
                                 cache_write_tokens, cache_read_tokens, speech_ms, cost_micro_usd, latency_ms)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`
        )
        .bind(
          day,
          row.task,
          row.rank,
          row.provider,
          row.modelId,
          row.outcome,
          g,
          Math.max(0, Math.floor(row.usage.inputTokens)),
          Math.max(0, Math.floor(row.usage.outputTokens)),
          Math.max(0, Math.floor(row.usage.cacheWriteTokens)),
          Math.max(0, Math.floor(row.usage.cacheReadTokens)),
          Math.max(0, Math.floor(row.usage.speechMs)),
          cost,
          Math.max(0, Math.floor(row.latencyMs))
        ),
    ]);
  } catch {
    /* fail closed: the reservation stays */
  }
}

/** Ledger rows kept for the admin's 7-day table and for audit; spend rows for a year and a month. */
export const USAGE_RETENTION_DAYS = 90;
export const SPEND_RETENTION_DAYS = 400;
const PRUNE_LIMIT = 5000;

/**
 * The durable-jobs `ai_retention` step (worker/lib/jobs.ts): old ledger and
 * spend rows go, bounded per run. Skips (no error) before migration 0210.
 */
export async function pruneAiLedger(
  db: D1Database,
  nowMs: number = Date.now()
): Promise<{ usage_deleted: number; days_deleted: number; skipped: boolean }> {
  const usageBefore = utcDay(nowMs - USAGE_RETENTION_DAYS * 86_400_000);
  const spendBefore = utcDay(nowMs - SPEND_RETENTION_DAYS * 86_400_000);
  try {
    const [u, d] = await db.batch([
      db
        .prepare('DELETE FROM ai_usage WHERE id IN (SELECT id FROM ai_usage WHERE day < ?1 ORDER BY id LIMIT ?2)')
        .bind(usageBefore, PRUNE_LIMIT),
      db.prepare('DELETE FROM ai_spend_day WHERE day < ?1').bind(spendBefore),
    ]);
    return { usage_deleted: Number(u?.meta?.changes ?? 0), days_deleted: Number(d?.meta?.changes ?? 0), skipped: false };
  } catch (e) {
    if (/no such table/i.test(e instanceof Error ? e.message : '')) return { usage_deleted: 0, days_deleted: 0, skipped: true };
    throw e;
  }
}

/** The longest user turn a nominal worst case assumes, in UTF-8 bytes. */
export const NOMINAL_USER_BYTES = 4096;

/**
 * The most one call of `task` could cost on this model, for readiness and
 * the admin's `worst_case_warn` (§10, §11): the task's system prompt, the
 * longest user turn, the largest picture load the limits allow (vision), a
 * 75 s note (speech).
 */
export function nominalWorstCaseMicro(m: TaskModel, systemPromptBytes: number, pictureTokens = 0): number {
  const inputTokens = systemPromptBytes + NOMINAL_USER_BYTES + INPUT_HEADROOM_TOKENS + (m.task === 'vision' ? pictureTokens : 0);
  return worstCaseMicro(m, { inputTokens, maxTokens: MAX_OUTPUT_TOKENS });
}

