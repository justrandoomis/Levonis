/**
 * The store: every table `levonis-ads` reads or writes, in one module.
 *
 * ONE file on purpose. The list of tables a service touches is the thing
 * `tests/serviceBoundaries.test.ts` and every reviewer actually need to see,
 * and splitting it across a directory would also put it out of reach of
 * `src/http/*` — inside one deployable only a sibling's `statements.ts` may be
 * imported across package directories (ADR-004), and the admin surface needs
 * the reads as well as the writes.
 *
 * The write half returns `D1PreparedStatement`s rather than executing them, so
 * a delivery row and the consumer's `ads_processed_events` row go into ONE
 * `db.batch()`: written together or not at all, which is what makes a
 * redelivery incapable of producing a second conversion (`03-EVENTS.md` §2.3).
 *
 * The read half is the entire surface a PostgreSQL driver would have to
 * reimplement when D1 is swapped out (ADR-003).
 */
import type { AdsDeliveryStatus, AdsEventMapping } from '@levonis/contracts/http/ads';
import { NO_CONSENT, type AdsProviderName, type ConsentState } from './types';

/**
 * The tables this service owns, as the runtime guard needs them.
 *
 * Declared in TypeScript rather than imported from `OWNERSHIP.json` because the
 * repo's tsconfig does not enable `resolveJsonModule` and a Worker bundle
 * should not carry a manifest it only reads two arrays from.
 * `test/ownership.test.ts` fails the moment this list and the manifest differ,
 * so there is no second source of truth, only a second spelling of one.
 */
export const ADS_OWNS = ['ads_providers', 'ads_event_map', 'ads_deliveries', 'ads_consent_snapshots', 'ads_dead_letters'] as const;

/** Ads reads no other service's table (`01-TARGET.md` §9.1: it joins locally). */
export const ADS_READS: readonly string[] = [];

// ---------------------------------------------------------------- writes

export interface DeliveryRecord {
  id: string;
  event_id: string;
  event_type: string;
  provider: AdsProviderName;
  provider_event: string;
  status: AdsDeliveryStatus | 'pending';
  attempts: number;
  next_attempt_at: string | null;
  error: string | null;
  payload: string;
  correlation_id: string;
  created_at: string;
  delivered_at: string | null;
}

/**
 * The delivery upsert. `ON CONFLICT (event_id, provider) DO NOTHING` is the
 * idempotency of this service: a redelivered envelope, a replayed outbox row
 * and a manual replay all collapse onto the row that already exists, so a
 * conversion is reported to a platform exactly once.
 */
export function insertDeliveryStatement(db: D1Database, r: DeliveryRecord): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO ads_deliveries
         (id, event_id, event_type, provider, provider_event, status, attempts, next_attempt_at, error, payload, correlation_id, created_at, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (event_id, provider) DO NOTHING`
    )
    .bind(
      r.id,
      r.event_id,
      r.event_type,
      r.provider,
      r.provider_event,
      r.status,
      r.attempts,
      r.next_attempt_at,
      r.error,
      r.payload,
      r.correlation_id,
      r.created_at,
      r.delivered_at
    );
}

/** The retry sweeper's outcome write: a terminal status, or a new backoff. */
export function updateDeliveryStatement(
  db: D1Database,
  id: string,
  patch: { status: AdsDeliveryStatus | 'pending'; attempts: number; next_attempt_at: string | null; error: string | null; delivered_at: string | null }
): D1PreparedStatement {
  return db
    .prepare('UPDATE ads_deliveries SET status = ?, attempts = ?, next_attempt_at = ?, error = ?, delivered_at = ? WHERE id = ?')
    .bind(patch.status, patch.attempts, patch.next_attempt_at, patch.error, patch.delivered_at, id);
}

/** A dead delivery's DLQ row (`01-TARGET.md` §11.4: DLQ depth, alert > 0). */
export function deadLetterStatement(
  db: D1Database,
  r: { id: string; delivery_id: string; event_id: string; event_type: string; provider: string; reason: string; attempts: number; payload: string; created_at: string }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO ads_dead_letters (id, delivery_id, event_id, event_type, provider, reason, attempts, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (delivery_id) DO NOTHING`
    )
    .bind(r.id, r.delivery_id, r.event_id, r.event_type, r.provider, r.reason, r.attempts, r.payload, r.created_at);
}

/**
 * The consent snapshot upsert.
 *
 * `WHERE excluded.last_seq >= ads_consent_snapshots.last_seq` is the
 * "last aggregate_seq wins" rule (`01-TARGET.md` §5): an out-of-order
 * redelivery of an older `UserUpdated` cannot resurrect a consent the user has
 * since withdrawn.
 *
 * `first_ads_at` is set once, by `COALESCE`, so `CompleteRegistration` fires on
 * the FIRST transition to `ads` consent and never again.
 */
export function upsertConsentStatement(db: D1Database, s: ConsentState & { last_seq: number; updated_at: string }): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO ads_consent_snapshots (user_hash, consent, email_hash, phone_hash, first_ads_at, last_seq, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_hash) DO UPDATE SET
         consent      = excluded.consent,
         email_hash   = excluded.email_hash,
         phone_hash   = excluded.phone_hash,
         first_ads_at = COALESCE(ads_consent_snapshots.first_ads_at, excluded.first_ads_at),
         last_seq     = excluded.last_seq,
         updated_at   = excluded.updated_at
       WHERE excluded.last_seq >= ads_consent_snapshots.last_seq`
    )
    .bind(s.user_hash, s.consent, s.email_hash, s.phone_hash, s.first_ads_at, s.last_seq, s.updated_at);
}

/** The per-provider kill switch. */
export function setProviderEnabledStatement(db: D1Database, name: string, enabled: boolean, at: string): D1PreparedStatement {
  return db.prepare('UPDATE ads_providers SET enabled = ?, updated_at = ? WHERE name = ?').bind(enabled ? 1 : 0, at, name);
}

/** The per-event kill switch, optionally scoped to one provider. */
export function setEventEnabledStatement(db: D1Database, eventType: string, enabled: boolean, provider?: string): D1PreparedStatement {
  return provider
    ? db.prepare('UPDATE ads_event_map SET enabled = ? WHERE event_type = ? AND provider = ?').bind(enabled ? 1 : 0, eventType, provider)
    : db.prepare('UPDATE ads_event_map SET enabled = ? WHERE event_type = ?').bind(enabled ? 1 : 0, eventType);
}

// ----------------------------------------------------------------- reads

interface ConsentRow {
  user_hash: string;
  consent: string;
  email_hash: string | null;
  phone_hash: string | null;
  first_ads_at: string | null;
  last_seq: number;
}

/** The snapshot for a `user_hash`, or `NO_CONSENT` when Ads has never heard of it. */
export async function consentFor(db: D1Database, userHash: string | null): Promise<ConsentState & { last_seq: number }> {
  if (!userHash) return { ...NO_CONSENT, last_seq: 0 };
  const row = await db
    .prepare('SELECT user_hash, consent, email_hash, phone_hash, first_ads_at, last_seq FROM ads_consent_snapshots WHERE user_hash = ?')
    .bind(userHash)
    .first<ConsentRow>();
  if (!row) return { ...NO_CONSENT, user_hash: userHash, last_seq: 0 };
  return {
    user_hash: row.user_hash,
    consent: row.consent === 'ads' || row.consent === 'analytics' ? row.consent : 'none',
    email_hash: row.email_hash,
    phone_hash: row.phone_hash,
    first_ads_at: row.first_ads_at,
    last_seq: Number(row.last_seq ?? 0),
  };
}

export interface EventMapRow {
  event_type: string;
  provider: AdsProviderName;
  provider_event: string;
  /** the AND of the per-event switch and the provider's own switch */
  enabled: boolean;
}

/**
 * The enabled (event_type -> provider, provider_event) pairings.
 *
 * The join is what makes the two kill switches independent: `ads_event_map`
 * silences one event, `ads_providers` silences a whole platform, and a row is
 * delivered only when BOTH say yes.
 */
export async function mappingsFor(db: D1Database, eventType: string): Promise<EventMapRow[]> {
  const { results } = await db
    .prepare(
      `SELECT m.event_type, m.provider, m.provider_event, (m.enabled AND p.enabled) AS enabled
         FROM ads_event_map m
         JOIN ads_providers p ON p.name = m.provider
        WHERE m.event_type = ?
        ORDER BY m.provider`
    )
    .bind(eventType)
    .all<{ event_type: string; provider: string; provider_event: string; enabled: number }>();
  return (results ?? []).map((r) => ({
    event_type: r.event_type,
    provider: r.provider as AdsProviderName,
    provider_event: r.provider_event,
    enabled: Number(r.enabled) === 1,
  }));
}

/** The whole map, for `GET /api/v1/ads/admin/event-map`. */
export async function allMappings(db: D1Database): Promise<AdsEventMapping[]> {
  const { results } = await db
    .prepare(
      `SELECT m.event_type, m.provider, m.provider_event, (m.enabled AND p.enabled) AS enabled
         FROM ads_event_map m
         JOIN ads_providers p ON p.name = m.provider
        ORDER BY m.event_type, m.provider`
    )
    .all<{ event_type: string; provider: string; provider_event: string; enabled: number }>();
  return (results ?? []).map((r) => ({
    event_type: r.event_type,
    provider: r.provider as AdsProviderName,
    provider_event: r.provider_event,
    enabled: Number(r.enabled) === 1,
  }));
}

/** The per-provider switch, by name. */
export async function providerSwitches(db: D1Database): Promise<Record<string, boolean>> {
  const { results } = await db.prepare('SELECT name, enabled FROM ads_providers').all<{ name: string; enabled: number }>();
  const out: Record<string, boolean> = {};
  for (const r of results ?? []) out[r.name] = Number(r.enabled) === 1;
  return out;
}

/** A page of `ads_deliveries` for the admin view; `cursor` is the last row's `created_at`. */
export async function listDeliveries(
  db: D1Database,
  opts: { provider?: string; status?: AdsDeliveryStatus; limit?: number; cursor?: string } = {}
): Promise<DeliveryRecord[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.provider) {
    where.push('provider = ?');
    binds.push(opts.provider);
  }
  if (opts.status) {
    where.push('status = ?');
    binds.push(opts.status);
  }
  if (opts.cursor) {
    where.push('created_at < ?');
    binds.push(opts.cursor);
  }
  const { results } = await db
    .prepare(
      `SELECT id, event_id, event_type, provider, provider_event, status, attempts, next_attempt_at, error, payload, correlation_id, created_at, delivered_at
         FROM ads_deliveries
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC
        LIMIT ?`
    )
    .bind(...binds, limit)
    .all<DeliveryRecord>();
  return results ?? [];
}

/** Deliveries whose backoff has expired — the cron sweeper's work list. */
/**
 * The rows the sweeper may work on: everything QUEUED by `deliver()`
 * (`pending`) and everything a previous attempt left retryable (`failed`)
 * whose backoff has expired. `deliver()` no longer sends, so `pending` is the
 * ordinary first-attempt state and this query is the ONLY path to an outbound
 * request.
 */
export async function dueRetries(db: D1Database, nowIso: string, limit = 50): Promise<DeliveryRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT id, event_id, event_type, provider, provider_event, status, attempts, next_attempt_at, error, payload, correlation_id, created_at, delivered_at
         FROM ads_deliveries
        WHERE status IN ('pending','failed') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY next_attempt_at
        LIMIT ?`
    )
    .bind(nowIso, limit)
    .all<DeliveryRecord>();
  return results ?? [];
}

/**
 * CLAIM ONE ROW BEFORE SENDING IT — a compare-and-swap, the same shape
 * `services/notifications/src/pump.ts` uses.
 *
 * The cron is `* * * * *`, and a sweep of 50 rows against a slow provider takes
 * far longer than a minute (5 s timeout x 3 attempts x 50). Without a claim the
 * next tick selects exactly the same rows and repeats every outbound call, so
 * during the very outage this sweeper exists for, one backlog of 50 becomes
 * 50 x N duplicate conversion requests per minute.
 *
 * The claim bumps `attempts` and pushes `next_attempt_at` out by the backoff the
 * attempt would earn, so a run that dies mid-flight leaves the row retryable
 * later rather than stuck — and only the writer whose UPDATE changed a row
 * (`meta.changes === 1`) may send it.
 */
export function claimDeliveryStatement(db: D1Database, r: { id: string; attempts: number }, nextAttemptAt: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE ads_deliveries
          SET attempts = attempts + 1, next_attempt_at = ?
        WHERE id = ? AND attempts = ? AND status IN ('pending','failed')`
    )
    .bind(nextAttemptAt, r.id, r.attempts);
}

export async function deadLetterCount(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM ads_dead_letters').first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/**
 * THE RETENTION ROLL (`03-EVENTS.md` §5 rule 6).
 *
 * `ads_deliveries` takes one row per (event, provider) — four per
 * `ProductViewed`, an event that fires at page-view rate — and
 * `ads_processed_events` one per event. Without this they grow for ever in the
 * service's own D1, which is capped like every other.
 *
 * What is kept: everything not yet settled (`pending`, `failed`), and every
 * `ads_dead_letters` row, which is the DLQ an operator still has to answer for.
 * What rolls: settled deliveries and their processed-events markers past the
 * window. A processed-events marker is idempotency, so the window has to be far
 * longer than any redelivery could plausibly be — the bus dead-letters after 8
 * attempts and about two hours.
 */
export function pruneDeliveriesStatement(db: D1Database, beforeIso: string, limit = 1000): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM ads_deliveries
        WHERE rowid IN (
          SELECT rowid FROM ads_deliveries
           WHERE status IN ('sent','sandbox','no_consent','rejected') AND created_at < ?
           LIMIT ?
        )`
    )
    .bind(beforeIso, limit);
}

export function pruneProcessedStatement(db: D1Database, beforeIso: string, limit = 1000): D1PreparedStatement {
  return db
    .prepare(`DELETE FROM ads_processed_events WHERE rowid IN (SELECT rowid FROM ads_processed_events WHERE processed_at < ? LIMIT ?)`)
    .bind(beforeIso, limit);
}
