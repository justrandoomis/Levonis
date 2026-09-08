/**
 * The delivery engine: one envelope in, the statements of its side effect out.
 *
 * The order of the gates is the design's, and it matters
 * (`01-TARGET.md` §9.1, `03-EVENTS.md` §5):
 *
 *   1. global kill switch          -> nothing at all, not even a row
 *   2. the (event_type, provider) map, ANDed with the provider switch
 *   3. the consent snapshot        -> without `ads` consent the row is
 *                                     `no_consent` and NO identifier is
 *                                     computed, stored or sent
 *   4. the adapter's `map()`       -> a `null` means this platform cannot
 *                                     express this conversion
 *   5. `configured()`              -> unconfigured runs the SANDBOX adapter:
 *                                     the mapping is validated, the row says
 *                                     `sandbox`, nothing leaves the account
 *   6. the row is written `pending` -> the CRON owns every outbound call
 *
 * DELIVER() MAKES NO OUTBOUND REQUEST. That is the point of step 6, and it is
 * what "never on the hot path" (`01-TARGET.md` §9.2) has to mean here.
 *
 * The bus hands a consumer up to `DELIVER_MAX_EVENTS` (50) envelopes in ONE
 * `deliver()` call, and this file maps each of them onto every enabled
 * provider — four are seeded. Sending inline therefore meant up to 200
 * sequential `fetchWithBudget` calls per bus batch, each with 2 retries and a
 * jittered sleep between attempts: measured against the real schema, a flaky
 * provider produced 400 outbound fetches and ~30 s of wall clock with an
 * INSTANT network, and ~600 subrequests against the Workers per-invocation cap
 * of 1000. Worse, the caller is the CORE'S PUMP, whose `pump_lock` lease is
 * 55 s — one Ads batch could outlive the lock and let the next cron tick
 * deliver the same rows concurrently. And `ProductViewed` is a best-effort
 * subscriber, so every product view paid four provider round trips inside
 * `waitUntil`.
 *
 * So the delivery row is INSERTed `pending` with `next_attempt_at = now`, the
 * event is acked, and `retryDue()` — the per-minute cron, which claims each row
 * before it sends and stops at an explicit budget — makes the calls. An Ads
 * outage can then never hold a producer's outbox open, and one bus batch costs
 * one D1 batch.
 */
import type { EventEnvelope } from '@levonis/contracts/envelope';
import type { AdsDeliveryStatus } from '@levonis/contracts/http/ads';
import { backoffSeconds, MAX_DELIVERY_ATTEMPTS } from '@levonis/platform-kit/bus';
import { PROVIDER_BUDGETS } from '@levonis/platform-kit/httpx';
import type { Logger } from '@levonis/platform-kit/log';
import { stableUserHash } from './consent';
import { factsOf } from './facts';
import { adsEnabled, type ProviderRegistry, type ResolvedProvider } from './registry';
import {
  claimDeliveryStatement,
  consentFor,
  deadLetterStatement,
  insertDeliveryStatement,
  mappingsFor,
  updateDeliveryStatement,
  upsertConsentStatement,
  type DeliveryRecord,
} from './store';
import type { AdsProviderName, ConsentState, ProviderEvent, SendResult } from './types';

export const newId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

export interface DeliverDeps {
  db: D1Database;
  /** the Worker's vars + secret names; only `configured()` and `send()` read a credential */
  env: Record<string, string | undefined>;
  registry: ProviderRegistry;
  now?: () => string;
  fetchImpl?: typeof fetch;
  log?: Logger;
  /** overrides the 5 s / 2-retry budget in tests */
  timeoutMs?: number;
  retries?: number;
  /** the sweeper's per-invocation ceilings; see `retryDue` */
  sendBudget?: number;
  wallClockMs?: number;
  /** monotonic milliseconds, injectable so the wall-clock bound is testable */
  clock?: () => number;
}

/** What the engine did with one envelope, for the log line and the tests. */
export interface DeliveryOutcomeRow {
  provider: AdsProviderName;
  status: AdsDeliveryStatus | 'pending';
  error: string | null;
}

export interface EngineResult {
  statements: D1PreparedStatement[];
  outcomes: DeliveryOutcomeRow[];
  /**
   * Kept for the consumer's log line and for callers written against the
   * inline-send engine. It is now always `false`: `deliverEnvelope` makes no
   * outbound call, so it cannot observe a transient provider failure — the
   * cron does, and it records the backoff on the row.
   */
  transient: boolean;
}

const nowIso = () => new Date().toISOString();

const plus = (iso: string, seconds: number): string => new Date(Date.parse(iso) + seconds * 1000).toISOString();

/**
 * The join key for the consent snapshot. Every envelope but
 * `SubscriptionChanged` carries a hash; that one carries only a `pii` user id,
 * from which the key is derived and which is never persisted.
 */
async function consentKey(event: EventEnvelope): Promise<string | null> {
  const facts = factsOf(event);
  if (facts?.user_hash) return facts.user_hash;
  if (event.event_type === 'SubscriptionChanged') {
    const uid = (event.payload as { user_id?: unknown }).user_id;
    if (typeof uid === 'string' && uid) return stableUserHash(uid);
  }
  return null;
}

/**
 * `UserUpdated` is the only envelope that WRITES consent rather than reading
 * it: it is the consent-change fact (`03-EVENTS.md` §4). The hashes are kept
 * only while the new value is `ads`; on anything else NULLs are written, which
 * erases a previously stored hash — a withdrawal removes the identifier, it
 * does not merely stop using it.
 */
export function consentUpdateFrom(event: EventEnvelope, existing: ConsentState & { last_seq: number }, at: string): { statement: (db: D1Database) => D1PreparedStatement; next: ConsentState; firstAds: boolean } | null {
  const p = event.payload as { user_hash?: unknown; marketing_consent?: unknown; email_hash?: unknown; phone_hash?: unknown };
  const userHash = typeof p.user_hash === 'string' ? p.user_hash : '';
  if (!userHash) return null;
  const consent = p.marketing_consent === 'ads' || p.marketing_consent === 'analytics' ? p.marketing_consent : 'none';
  const keep = consent === 'ads';
  const next: ConsentState = {
    user_hash: userHash,
    consent,
    email_hash: keep && typeof p.email_hash === 'string' ? p.email_hash : null,
    phone_hash: keep && typeof p.phone_hash === 'string' ? p.phone_hash : null,
    first_ads_at: existing.first_ads_at ?? (keep ? at : null),
  };
  const firstAds = keep && !existing.first_ads_at;
  return {
    next,
    firstAds,
    statement: (db) => upsertConsentStatement(db, { ...next, last_seq: event.aggregate_seq, updated_at: at }),
  };
}

/** `SubscriptionChanged` maps only while the membership is active (`01-TARGET.md` §9.1 "Subscribe"). */
const subscriptionIsActive = (event: EventEnvelope): boolean => (event.payload as { active?: unknown }).active === true;

export async function deliverEnvelope(event: EventEnvelope, deps: DeliverDeps): Promise<EngineResult> {
  const at = (deps.now ?? nowIso)();
  const statements: D1PreparedStatement[] = [];
  const outcomes: DeliveryOutcomeRow[] = [];

  // 1. the global kill switch, before anything is read or written.
  if (!adsEnabled(deps.env.ADS_ENABLED)) return { statements, outcomes, transient: false };

  const key = await consentKey(event);
  const existing = await consentFor(deps.db, key);
  let consent: ConsentState = existing;
  let mapAllowed = true;

  if (event.event_type === 'UserUpdated') {
    const update = consentUpdateFrom(event, existing, at);
    if (!update) return { statements, outcomes, transient: false };
    statements.push(update.statement(deps.db));
    consent = update.next;
    // `CompleteRegistration` is the FIRST transition to `ads` consent and
    // nothing else — a later profile edit with the same consent maps to nothing.
    mapAllowed = update.firstAds;
  } else if (event.event_type === 'SubscriptionChanged') {
    mapAllowed = subscriptionIsActive(event);
  }

  if (!mapAllowed) return { statements, outcomes, transient: false };

  // 2. the map, already ANDed with the per-provider switch by the SQL join.
  const mappings = (await mappingsFor(deps.db, event.event_type)).filter((m) => m.enabled);
  if (mappings.length === 0) return { statements, outcomes, transient: false };

  const transient = false;
  for (const m of mappings) {
    const resolved = deps.registry.resolve(m.provider, deps.env);
    if (!resolved) continue;

    // 3. consent. Recorded, never sent — and no identifier was ever computed.
    if (consent.consent !== 'ads') {
      statements.push(
        insertDeliveryStatement(deps.db, row(event, m.provider, m.provider_event, 'no_consent', at, { error: null, payload: {} }))
      );
      outcomes.push({ provider: m.provider, status: 'no_consent', error: null });
      continue;
    }

    // 4. the adapter's own mapping.
    const mapped = resolved.adapter.map(event, consent, m.provider_event);
    if (!mapped) {
      statements.push(insertDeliveryStatement(deps.db, row(event, m.provider, m.provider_event, 'no_consent', at, { error: 'not mappable', payload: {} })));
      outcomes.push({ provider: m.provider, status: 'no_consent', error: 'not mappable' });
      continue;
    }

    // 5. Unconfigured is decided here and costs nothing: the mapping was
    //    validated, the row says `sandbox`, and no request will ever be made.
    if (!resolved.configured) {
      statements.push(insertDeliveryStatement(deps.db, row(event, m.provider, m.provider_event, 'sandbox', at, { error: null, payload: mapped.body, attempts: 0 })));
      outcomes.push({ provider: m.provider, status: 'sandbox', error: null });
      continue;
    }

    // 6. Everything else is QUEUED, never sent. `next_attempt_at = at` makes
    //    it due to the very next cron tick, so the latency cost is bounded by
    //    the minute cadence and the request path pays one D1 write.
    statements.push(insertDeliveryStatement(deps.db, row(event, m.provider, m.provider_event, 'pending', at, { error: null, payload: mapped.body, attempts: 0, next_attempt_at: at })));
    outcomes.push({ provider: m.provider, status: 'pending', error: null });
  }

  return { statements, outcomes, transient };
}

interface AttemptOutcome {
  status: AdsDeliveryStatus;
  error: string | null;
  attempts: number;
  next_attempt_at: string | null;
  delivered_at: string | null;
}

/**
 * One send attempt, translated into the delivery row's terms.
 *
 * The breaker comes from the registry, so it is shared by every attempt this
 * isolate makes against that provider: five consecutive failures open it and
 * `fetchWithBudget` then fails fast with `DEPENDENCY_UNAVAILABLE`, which is a
 * retryable error here — a delivery is never dropped because a breaker was
 * open, only postponed.
 */
export async function attempt(
  resolved: ResolvedProvider,
  mapped: ProviderEvent,
  deps: DeliverDeps,
  correlationId: string,
  at: string,
  priorAttempts: number
): Promise<AttemptOutcome> {
  const attempts = priorAttempts + 1;
  let res: SendResult;
  try {
    res = await resolved.adapter.send([mapped], deps.env, {
      timeoutMs: deps.timeoutMs ?? PROVIDER_BUDGETS.ads.timeoutMs,
      retries: deps.retries ?? PROVIDER_BUDGETS.ads.retries,
      correlationId,
      breaker: resolved.breaker,
      fetchImpl: deps.fetchImpl,
    });
  } catch (e) {
    res = { accepted: 0, rejected: 1, error: (e as Error).message, retryable: true };
  }
  if (res.sandbox || !resolved.configured) return { status: 'sandbox', error: null, attempts, next_attempt_at: null, delivered_at: null };
  if (res.accepted > 0 && res.rejected === 0) return { status: 'sent', error: null, attempts, next_attempt_at: null, delivered_at: at };
  if (!res.retryable) return { status: 'rejected', error: res.error ?? 'rejected', attempts, next_attempt_at: null, delivered_at: null };
  if (attempts >= MAX_DELIVERY_ATTEMPTS) return { status: 'dead', error: res.error ?? 'out of attempts', attempts, next_attempt_at: null, delivered_at: null };
  return { status: 'failed', error: res.error ?? 'transient', attempts, next_attempt_at: plus(at, backoffSeconds(attempts)), delivered_at: null };
}

function row(
  event: EventEnvelope,
  provider: AdsProviderName,
  providerEvent: string,
  status: AdsDeliveryStatus | 'pending',
  at: string,
  extra: { error: string | null; payload: Record<string, unknown>; attempts?: number; next_attempt_at?: string | null; delivered_at?: string | null }
): DeliveryRecord {
  return {
    id: newId('adl'),
    event_id: event.event_id,
    event_type: event.event_type,
    provider,
    provider_event: providerEvent,
    status,
    attempts: extra.attempts ?? 0,
    next_attempt_at: extra.next_attempt_at ?? null,
    error: extra.error,
    payload: JSON.stringify(extra.payload ?? {}),
    correlation_id: event.correlation_id,
    created_at: at,
    delivered_at: extra.delivered_at ?? null,
  };
}

/**
 * THE ONLY PLACE THIS SERVICE TALKS TO AN ADVERTISING PLATFORM.
 *
 * It sends what `deliver()` queued (`pending`) and retries what a previous
 * attempt left `failed` once its backoff has expired, promoting a row out of
 * attempts to `dead` plus a DLQ row.
 *
 * Two bounds, both of which the inline path had none of:
 *
 *  - EVERY ROW IS CLAIMED FIRST (`claimDeliveryStatement`), so overlapping
 *    minute ticks cannot send the same row twice.
 *  - THE RUN IS BUDGETED (`sendBudget`, `wallClockMs`). A tick stops when it
 *    has spent its budget and leaves the rest due; the next tick picks them up.
 *    Without it a sweep of 50 rows against a slow provider runs for ~750 s.
 */
export const SWEEP_SEND_BUDGET = 40;
export const SWEEP_WALL_CLOCK_MS = 20_000;

export async function retryDue(rows: DeliveryRecord[], deps: DeliverDeps): Promise<{ retried: number; sent: number; dead: number; deferred: number }> {
  const at = (deps.now ?? nowIso)();
  const started = deps.clock?.() ?? Date.now();
  const budget = deps.sendBudget ?? SWEEP_SEND_BUDGET;
  const wall = deps.wallClockMs ?? SWEEP_WALL_CLOCK_MS;
  let retried = 0;
  let sent = 0;
  let dead = 0;
  let deferred = 0;
  for (const r of rows) {
    if (retried >= budget || (deps.clock?.() ?? Date.now()) - started >= wall) {
      // Out of budget: the remaining rows keep their state and stay due.
      deferred = rows.length - retried;
      break;
    }
    const resolved = deps.registry.resolve(r.provider, deps.env);
    if (!resolved) continue;
    // The claim is the permission to send. A concurrent tick that already took
    // this row changed `attempts`, so this UPDATE matches nothing and the row
    // is skipped rather than sent twice.
    const claim = await claimDeliveryStatement(deps.db, r, plus(at, backoffSeconds(r.attempts + 1))).run();
    if (Number(claim.meta?.changes ?? 0) !== 1) continue;
    retried++;
    const mapped: ProviderEvent = {
      event_id: r.event_id,
      event_type: r.event_type,
      event_name: r.provider_event,
      body: JSON.parse(r.payload || '{}') as Record<string, unknown>,
    };
    const outcome = await attempt(resolved, mapped, deps, r.correlation_id, at, r.attempts);
    const writes: D1PreparedStatement[] = [
      updateDeliveryStatement(deps.db, r.id, {
        status: outcome.status,
        attempts: outcome.attempts,
        next_attempt_at: outcome.next_attempt_at,
        error: outcome.error,
        delivered_at: outcome.delivered_at,
      }),
    ];
    if (outcome.status === 'dead') {
      dead++;
      writes.push(
        deadLetterStatement(deps.db, {
          id: newId('adq'),
          delivery_id: r.id,
          event_id: r.event_id,
          event_type: r.event_type,
          provider: r.provider,
          reason: outcome.error ?? 'out of attempts',
          attempts: outcome.attempts,
          payload: r.payload,
          created_at: at,
        })
      );
    }
    if (outcome.status === 'sent') sent++;
    await deps.db.batch(writes);
  }
  return { retried, sent, dead, deferred };
}
