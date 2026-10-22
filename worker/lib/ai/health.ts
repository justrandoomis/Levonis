/**
 * THE PER-PROVIDER CIRCUIT (push B plan §6.8, §10 "Circuit"), best effort.
 *
 *   3 consecutive TIMEOUT | NETWORK | HTTP_5XX | OVERLOADED | RATE_LIMITED
 *                                  → open for 5 minutes
 *   KEY_REJECTED | QUOTA           → open for 60 minutes at once
 *   MODEL_GONE                     → that model row is marked gone and the
 *                                    settings version bumped; the row is
 *                                    skipped until the owner saves again
 *   OK                             → the failure count resets, the circuit closes
 *
 * Any other code (a refusal, a truncation, invalid output, a bad input, a 4xx)
 * is recorded as the last failure but does not count: those say something
 * about one request, not about the provider.
 *
 * After its window an open circuit lets one call through; while the count
 * stays at or above three, that call failing re-opens it at once.
 *
 * Never throws: health is advice for the next call, and the budget, not the
 * circuit, is what fails closed.
 */
import type { AiTask, FailCode, Outcome, ProviderKind } from './types';

export const TRANSIENT_CODES: ReadonlySet<FailCode> = new Set(['TIMEOUT', 'NETWORK', 'HTTP_5XX', 'OVERLOADED', 'RATE_LIMITED']);
export const HARD_CODES: ReadonlySet<FailCode> = new Set(['KEY_REJECTED', 'QUOTA']);
export const TRANSIENT_THRESHOLD = 3;
export const TRANSIENT_OPEN_MS = 5 * 60_000;
export const HARD_OPEN_MS = 60 * 60_000;

const iso = (ms: number) => new Date(ms).toISOString();

/** Is the provider's circuit open right now? A failed read answers false (best effort). */
export async function circuitOpen(db: D1Database, provider: ProviderKind, nowMs: number): Promise<boolean> {
  try {
    const row = await db
      .prepare('SELECT open_until FROM ai_provider_health WHERE provider = ?')
      .bind(provider)
      .first<{ open_until: string | null }>();
    return !!row?.open_until && row.open_until > iso(nowMs);
  } catch {
    return false;
  }
}

/**
 * Record one call's outcome. Returns the epoch ms the circuit is now open
 * until when THIS outcome opened it (so the caller can honour it in its
 * isolate at once), otherwise null.
 */
export async function recordHealth(db: D1Database, provider: ProviderKind, code: Outcome, nowMs: number): Promise<number | null> {
  const now = iso(nowMs);
  try {
    if (code === 'OK') {
      await db
        .prepare(
          `INSERT INTO ai_provider_health (provider, last_ok_at, consecutive_failures, open_until) VALUES (?1, ?2, 0, NULL)
           ON CONFLICT(provider) DO UPDATE SET last_ok_at = excluded.last_ok_at, consecutive_failures = 0, open_until = NULL`
        )
        .bind(provider, now)
        .run();
      return null;
    }
    const hard = HARD_CODES.has(code);
    const transient = TRANSIENT_CODES.has(code);
    const step = hard || transient ? 1 : 0;
    const threshold = hard ? 1 : transient ? TRANSIENT_THRESHOLD : Number.MAX_SAFE_INTEGER;
    const untilMs = nowMs + (hard ? HARD_OPEN_MS : TRANSIENT_OPEN_MS);
    const row = await db
      .prepare(
        `INSERT INTO ai_provider_health (provider, last_fail_at, last_fail_code, consecutive_failures, open_until)
         VALUES (?1, ?2, ?3, ?4, CASE WHEN ?4 >= ?5 THEN ?6 ELSE NULL END)
         ON CONFLICT(provider) DO UPDATE SET
           last_fail_at = excluded.last_fail_at,
           last_fail_code = excluded.last_fail_code,
           consecutive_failures = ai_provider_health.consecutive_failures + ?4,
           open_until = CASE WHEN ?4 > 0 AND ai_provider_health.consecutive_failures + ?4 >= ?5 THEN ?6 ELSE ai_provider_health.open_until END
         RETURNING open_until`
      )
      .bind(provider, now, code, step, threshold, iso(untilMs))
      .first<{ open_until: string | null }>();
    return row?.open_until === iso(untilMs) ? untilMs : null;
  } catch {
    return null;
  }
}

/**
 * A model the provider no longer serves: its row is skipped until the owner
 * saves again (which clears `gone`), and the version bump carries that to
 * every isolate within the memo's 30 s.
 */
export async function markModelGone(db: D1Database, task: AiTask, rank: 0 | 1, modelId: string): Promise<void> {
  try {
    await db.batch([
      db.prepare('UPDATE ai_task_models SET gone = 1 WHERE task = ? AND rank = ? AND model_id = ? AND gone = 0').bind(task, rank, modelId),
      db.prepare('UPDATE ai_settings SET version = version + 1 WHERE id = 1'),
    ]);
  } catch {
    /* best effort: the next call will meet the same answer and try again */
  }
}
