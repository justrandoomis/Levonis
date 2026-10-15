/**
 * THE JOB DEADLINE AND THE CLOCK (Bambu import spec §A.7, §B.5, §J.1).
 *
 * The deadline is absolute: workflow 60's first step writes
 * `DEADLINE_EPOCH = job start + 330 min` (the job's timeout is 350 min). The
 * runner keeps the spec's table of worst-case stage durations and never starts
 * anything whose worst case does not fit before it:
 *
 *   1. every wait (backoff, Retry-After, cache wait, spacing) must satisfy
 *      `now + wait + worst(what follows the wait) < deadline`;
 *   2. `/write` starts only when `now + worst(write) + worst(publish-finish)
 *      + worst(verify) + margin < deadline` — 13 minutes, so a committed
 *      product is verified in the same job;
 *   3. a wait that does not fit releases the lease (event RETRYING with
 *      `retry_at`) and the job exits `more=true blocked=false`;
 *   4. eight attempts of one stage across jobs → BLOCKED RETRIES_EXHAUSTED
 *      (`stage_attempts` lives in D1).
 *
 * Everything here is pure or takes a Clock, so tests/bambuImportRunner.test.ts
 * drives every rule with a fake clock.
 */

/** Wall time and sleeping, injectable (tests use a fake clock that advances on sleep). */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

const S = 1000;
const MIN = 60 * S;

/** The worst-case durations of §A.7, in milliseconds. */
export const WORST = {
  EXTRACT: 60 * S, // 11 s spacing + 30 s timeout + parse
  ENRICH: 6 * MIN, // ≤ 20 document checks, ≤ 5 tracker HEADs, ≤ 3 wiki pages at ≥ 5 s
  VALIDATE: 45 * S, // VALIDATE + /stage
  MEDIA_CALL: 50 * S, // one /media call
  WRITE: 90 * S,
  PUBLISH_FINISH: 30 * S,
  VERIFY: 10 * MIN, // including a ≤ 360 s cache wait
} as const;

export type WorstKey = keyof typeof WORST;

/** The cache wait inside VERIFY (§I.1.9): s-maxage + 60 s, at most 360 s. */
export const CACHE_WAIT_MAX = 360 * S;
/** What VERIFY still needs after its cache wait. */
export const VERIFY_AFTER_CACHE_WAIT = WORST.VERIFY - CACHE_WAIT_MAX;

/**
 * Rule 2: `/write` needs write + publish-finish + verify (12 min) and a minute
 * of margin for the calls around them: never started with less than 13 min left.
 */
export const WRITE_MARGIN = 1 * MIN;
export const WRITE_RESERVE = WORST.WRITE + WORST.PUBLISH_FINISH + WORST.VERIFY + WRITE_MARGIN;

/** A fresh item is not started unless one whole item fits (no item is extracted only to be parked). */
export const ITEM_RESERVE = WORST.EXTRACT + WORST.ENRICH + WORST.VALIDATE + WORST.MEDIA_CALL + WRITE_RESERVE;

/** §B.5: transient failures back off 30 s × 2^k, at most 30 min per wait; 8 attempts of one stage. */
export const BACKOFF_BASE = 30 * S;
export const BACKOFF_CAP = 30 * MIN;
export const MAX_STAGE_ATTEMPTS = 8;

/** §J.1: a 429 / 503 from the store without Retry-After: 60 s, 120 s, 240 s … 30 min. */
export const STORE_BACKOFF_BASE = 60 * S;

export function backoff(attempt: number, base = BACKOFF_BASE): number {
  const k = Math.max(0, Math.min(30, Math.floor(attempt)));
  return Math.min(BACKOFF_CAP, base * 2 ** k);
}

/** A Retry-After header (seconds or an HTTP date) in ms, capped at 30 min; null when absent or unreadable. */
export function retryAfterMs(value: string | null | undefined, now: number): number | null {
  if (value === null || value === undefined) return null;
  const v = value.trim();
  if (/^\d{1,7}$/.test(v)) return Math.min(BACKOFF_CAP, Number(v) * S);
  const at = Date.parse(v);
  if (Number.isFinite(at)) return Math.min(BACKOFF_CAP, Math.max(0, at - now));
  return null;
}

/** `DEADLINE_EPOCH` (seconds) → ms; refused when absent or malformed (the importer never runs without one). */
export function parseDeadlineEpoch(value: string | undefined): number {
  if (value === undefined || !/^\d{9,11}$/.test(value)) throw new Error('DEADLINE_EPOCH is not a time in seconds');
  return Number(value) * S;
}

export class Deadline {
  constructor(
    readonly at: number,
    readonly clock: Clock
  ) {}

  left(): number {
    return this.at - this.clock.now();
  }

  /** Rule 1: a wait of `waitMs` followed by work whose worst case is `afterMs`. */
  fits(waitMs: number, afterMs: number): boolean {
    return this.clock.now() + Math.max(0, waitMs) + Math.max(0, afterMs) < this.at;
  }

  /** Rule 1 for a stage of the table. */
  fitsStage(waitMs: number, stage: WorstKey): boolean {
    return this.fits(waitMs, WORST[stage]);
  }

  /** Rule 2: `/write` (with the finish and the verification it commits the job to). */
  canStartWrite(): boolean {
    return this.fits(0, WRITE_RESERVE);
  }

  /** A fresh item is started only when a whole item fits. */
  canStartItem(): boolean {
    return this.fits(0, ITEM_RESERVE);
  }

  /** The absolute time of a retry `waitMs` from now, as D1 stores times. */
  retryAt(waitMs: number): string {
    return new Date(this.clock.now() + Math.max(0, waitMs)).toISOString();
  }
}

/** Minimum spacing between requests to one host (§J.1, §J.2), with an injectable clock. */
export class Spacer {
  private last = new Map<string, number>();

  constructor(
    readonly clock: Clock,
    readonly gaps: Readonly<Record<string, number>>
  ) {}

  /** How long the next request to `key` must still wait. */
  due(key: string): number {
    const gap = this.gaps[key] ?? 0;
    const last = this.last.get(key);
    if (last === undefined) return 0;
    return Math.max(0, last + gap - this.clock.now());
  }

  /** Records a request to `key` made now. */
  mark(key: string): void {
    this.last.set(key, this.clock.now());
  }

  /** Time of the last request to `key`, or null. */
  lastAt(key: string): number | null {
    return this.last.get(key) ?? null;
  }
}
