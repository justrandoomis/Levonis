/**
 * THE CORE'S EVENT BUS — the monolith as a producer (02-MIGRATION-PLAN.md 1.6,
 * 03-EVENTS.md §2, ADR-005).
 *
 * WHAT IT DOES. `outboxStatement()` returns ONE `D1PreparedStatement` that a
 * caller appends to the `db.batch()` it was already running, so the event row
 * commits with the business rows or not at all (a transactional outbox). The
 * dispatcher — `RpcFanoutBus` from the platform kit — delivers those rows to
 * the consumer Workers bound to this Worker and records what each of them
 * acknowledged, with backoff and a dead-letter state.
 *
 * WHAT IT DOES NOT DO, WHICH IS THE POINT. With no `EVENT_BUS_ENABLED=on`
 * var, no `core_outbox_events` table or no consumer binding — which is exactly
 * the live Worker today — every function here is a no-op:
 *
 *   - `eventsEnabled(env)` is a plain string comparison; every emitter checks
 *     it FIRST, so a disabled bus costs no query, no allocation and no latency;
 *   - `outboxStatement()` returns `null`, so the caller's batch is byte-for-byte
 *     the batch it is today (the kit's boot probe also returns null while the
 *     table is absent, which is what lets this code ship before its migration);
 *   - nothing here ever throws into a caller: an emitter that fails logs and
 *     returns null. An event is a description of something that happened; it
 *     must never be the reason the thing fails to happen.
 *
 * WHY A MODULE-LEVEL HANDLE. `audit(db, …)` and the wallet/inventory helpers
 * take a `D1Database`, not an `Env`, at two hundred call sites. Rather than
 * change all of them, `configureEventBus(env)` is called once per invocation
 * (fetch and scheduled) and every emitter looks the bus up BY THE DATABASE
 * OBJECT IT WAS HANDED (`busFor(db)`). A test that never configures a bus, or
 * that configures one for a different database, gets `null` and the legacy
 * path — the isolation is by object identity, not by hope.
 */
import { RpcFanoutBus, selectConsumers, type ConsumerBinding, type QueueBinding } from '@levonis/platform-kit/bus';
import { busEnabled, defaultProbe, outboxTables, type PublishGuard } from '@levonis/platform-kit/outbox';
import { pruneAuditDetailsStatement } from '@levonis/platform-kit/audit';
import { uuidv7 } from '@levonis/platform-kit/correlation';
import { importSigningKey, type SigningKey } from '@levonis/platform-kit/keys';
import { signEnvelope } from '@levonis/platform-kit/eventSig';
import { SUBSCRIPTIONS } from '@levonis/contracts/subscriptions';
import { sha256Hex } from '@levonis/contracts/canonical';
import { FIXTURE_SIG, type EventEnvelope, type UnsignedEnvelope } from '@levonis/contracts/envelope';
import type { EventSchema } from '@levonis/contracts/events/index';
import type { PumpReport } from '@levonis/platform-kit/log';
import type { Env } from './types';

/** `source_service` of everything the monolith publishes, and its table prefix. */
export const CORE_SERVICE = 'core';

/** The consumer services this Worker can be bound to (02-MIGRATION-PLAN.md 2.2). */
const CONSUMER_BINDINGS = [
  ['audit', 'AUDIT'],
  ['analytics', 'ANALYTICS'],
  ['ads', 'ADS'],
  ['notifications', 'NOTIFICATIONS'],
] as const;

/** Queue producer bindings for `EVENT_BUS_MODE=queue` — same interface, later switch. */
const QUEUE_BINDINGS = [
  ['audit', 'Q_AUDIT'],
  ['analytics', 'Q_ANALYTICS'],
  ['ads', 'Q_ADS'],
  ['notifications', 'Q_NOTIFICATIONS'],
] as const;

export interface EmitOptions {
  /** the aggregate this event belongs to (`order_id`, `user_id`, …) */
  aggregateId: string;
  actorId?: string | null;
  correlationId?: string;
  causationId?: string | null;
  /** override the monotonic default; only for a producer that keeps its own sequence */
  aggregateSeq?: number;
  /**
   * The proof that the business write this event describes actually committed
   * (`packages/platform-kit/src/outbox.ts` `PublishGuard`). Required of any
   * emitter whose business statements are themselves conditional: without it
   * the batch can commit the EVENT and nothing else. The statement must be
   * appended AFTER the write it proves.
   */
  guard?: PublishGuard;
}

interface Handle {
  env: Env;
  bus: RpcFanoutBus;
  bound: string[];
}

let current: Handle | null = null;
let signingKey: Promise<SigningKey | null> | null = null;
let lockSeeded: WeakSet<object> = new WeakSet();

/** Which consumers this Worker can actually reach right now. */
function boundConsumers(env: Env): { rpc: Record<string, ConsumerBinding>; names: string[] } {
  const rpc: Record<string, ConsumerBinding> = {};
  for (const [name, binding] of CONSUMER_BINDINGS) {
    const b = (env as unknown as Record<string, ConsumerBinding | undefined>)[binding];
    if (b && typeof b.deliver === 'function') rpc[name] = b;
  }
  return { rpc, names: Object.keys(rpc) };
}

function queueBindings(env: Env): Record<string, QueueBinding> {
  const out: Record<string, QueueBinding> = {};
  for (const [name, binding] of QUEUE_BINDINGS) {
    const q = (env as unknown as Record<string, QueueBinding | undefined>)[binding];
    if (q && typeof q.sendBatch === 'function') out[name] = q;
  }
  return out;
}

/**
 * The subscription table narrowed to the consumers this deployment can reach.
 *
 * WHY NARROW IT. `SUBSCRIPTIONS` is the END-STATE table: `OrderCreated` names
 * `risk` and `search`, Workers that do not exist yet. Creating a delivery row
 * for an unreachable consumer would leave every event permanently `pending`,
 * so `dispatched_at` would never be set and the cron would re-select the same
 * growing backlog every minute, forever. Narrowing means an unbound consumer
 * simply is not a subscriber yet; when its binding is added, new events reach
 * it and the backlog it missed is replayable from the outbox by `seq` range
 * (`bus.replay()`), which is the whole reason the envelopes are retained.
 */
export function subscriptionsFor(names: readonly string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [type, consumers] of Object.entries(SUBSCRIPTIONS)) {
    const reachable = consumers.filter((c) => names.includes(c));
    if (reachable.length) out[type] = reachable;
  }
  return out;
}

function makeHandle(env: Env): Handle {
  const { rpc, names } = boundConsumers(env);
  const consumers = selectConsumers(env.EVENT_BUS_MODE, rpc, queueBindings(env), CORE_SERVICE);
  return {
    env,
    bound: names,
    bus: new RpcFanoutBus({
      db: env.DB,
      prefix: CORE_SERVICE,
      source: CORE_SERVICE,
      enabled: env.EVENT_BUS_ENABLED,
      consumers,
      subscriptions: subscriptionsFor(names),
    }),
  };
}

/**
 * Called once per invocation, before anything else runs. Cheap: it builds one
 * small object and only when the environment actually changed.
 */
export function configureEventBus(env: Env): void {
  if (current && current.env.DB === env.DB && current.env.EVENT_BUS_ENABLED === env.EVENT_BUS_ENABLED) {
    current.env = env;
    return;
  }
  current = makeHandle(env);
}

/** Tests: forget the handle, the cached key and the boot probe's answers. */
export function resetEventBus(): void {
  current = null;
  signingKey = null;
  lockSeeded = new WeakSet();
  defaultProbe.reset();
}

/**
 * The bus configured for THIS database, or null — the isolation every emitter
 * relies on, and the "is the bus on at all?" answer in the same call.
 *
 * `configureEventBus(env)` runs on EVERY fetch, so a handle exists whether or
 * not the bus is enabled. Answering "yes, here is the handle" on a Worker with
 * `EVENT_BUS_ENABLED` unset made `if (busFor(db))` — the guard three emitters
 * use before doing any work — true on the live Worker, which is how an extra
 * `SELECT` reached the checkout settlement path and three catalogue reads
 * reached every product save. The var check belongs HERE, once, rather than in
 * each caller's memory: a handle that cannot publish is not a bus.
 */
export function busFor(db: D1Database | undefined | null): Handle | null {
  if (!db || !current || current.env.DB !== db) return null;
  if (!eventsEnabled(current.env)) return null;
  return current;
}

/** True when the var says `on`. The first thing every emitter asks, before any work. */
export const eventsEnabled = (env: Pick<Env, 'EVENT_BUS_ENABLED'>): boolean => busEnabled(env.EVENT_BUS_ENABLED);

/** The consumer services currently bound (deep health, tests). */
export const boundConsumerNames = (): string[] => current?.bound ?? [];

// --------------------------------------------------------------- envelope ids

/**
 * `aggregate_seq` — ordered per aggregate, without a per-aggregate counter
 * table. Milliseconds give the ordering the projections need ("last sequence
 * wins"); the low digits are a per-isolate slot so two events for the same
 * aggregate in the same millisecond do not land on the same number.
 *
 * THREE PROPERTIES, and each is here for a reason:
 *
 *  - The counter RESETS EVERY MILLISECOND and counts up from the isolate's
 *    base. Carrying it across milliseconds let it wrap 999 -> 0 inside one
 *    millisecond, numbering two events of one aggregate BACKWARDS — and a
 *    "last seq wins" projection (`services/ads/src/store.ts`) then discards
 *    the newer fact.
 *  - The base is RANDOM PER ISOLATE, so two isolates emitting for the same
 *    aggregate in the same millisecond start at different numbers. A shared
 *    starting point would make that collision certain rather than unlikely.
 *  - SLOTS_PER_MS stays 1 000. It cannot usefully grow: `now * SLOTS_PER_MS`
 *    is computed as a JavaScript number, and 1.8e12 ms x 1e4 already passes
 *    `Number.MAX_SAFE_INTEGER`, at which point the low digits — the slot
 *    itself — are rounded away and EVERY event in a millisecond collides.
 *
 * Collisions across isolates cannot be made impossible without a counter
 * table, so the outbox INSERT carries `ON CONFLICT DO NOTHING`
 * (`packages/platform-kit/src/outbox.ts`): a collision loses the EVENT, never
 * the order it rides with. An event must never be the reason the thing fails
 * to happen.
 */
export const SLOTS_PER_MS = 1_000;
const slotBase = Math.floor(Math.random() * SLOTS_PER_MS);
let slotMs = -1;
let slotN = 0;
export function nextAggregateSeq(now = Date.now()): number {
  if (now !== slotMs) {
    slotMs = now;
    slotN = 0;
  } else {
    slotN += 1;
  }
  return now * SLOTS_PER_MS + ((slotBase + slotN) % SLOTS_PER_MS);
}

/** The daily-salted user hash every `user_hash` field carries (03-EVENTS.md §5 rule 3). */
export async function dailyUserHash(userId: string, day = new Date().toISOString().slice(0, 10)): Promise<string> {
  return sha256Hex(`levonis:user:${day}:${userId}`);
}

async function coreSigningKey(env: Env): Promise<SigningKey | null> {
  if (!env.CORE_SIGNING_KEY || !env.CORE_SIGNING_PUBLIC_KEY) return null;
  if (!signingKey) {
    signingKey = importSigningKey(env.CORE_SIGNING_KEY, env.CORE_SIGNING_PUBLIC_KEY).catch((e) => {
      console.error('event bus: CORE_SIGNING_KEY could not be imported', e instanceof Error ? e.message : String(e));
      return null;
    });
  }
  return signingKey;
}

/**
 * The signing callback the kit's `audit()` facade takes, or undefined while no
 * key is configured. Deliberately a callback: the key material stays inside
 * this module and is never passed around, logged or serialised.
 */
export function coreSigner(env: Env): ((envelope: UnsignedEnvelope) => Promise<EventEnvelope>) | undefined {
  if (!env.CORE_SIGNING_KEY || !env.CORE_SIGNING_PUBLIC_KEY) return undefined;
  return async (envelope) => {
    const key = await coreSigningKey(env);
    return key ? signEnvelope(key, envelope) : { ...envelope, sig: FIXTURE_SIG };
  };
}

/**
 * Builds and signs the envelope. Unsigned (`sig: 'fixture'`) while no signing
 * key is configured — the dark consumers accept that marker explicitly and
 * production ones never will, so an unsigned envelope cannot be mistaken for
 * a trusted one.
 */
export async function buildEnvelope<T>(env: Env, schema: EventSchema<T>, payload: T, o: EmitOptions): Promise<EventEnvelope<T>> {
  const unsigned = schema.envelope({
    event_id: uuidv7(),
    created_at: new Date().toISOString(),
    source_service: CORE_SERVICE,
    correlation_id: o.correlationId ?? uuidv7(),
    causation_id: o.causationId ?? null,
    actor_id: o.actorId ?? null,
    aggregate_id: o.aggregateId,
    aggregate_seq: o.aggregateSeq ?? nextAggregateSeq(),
    payload,
  });
  const key = await coreSigningKey(env);
  return key ? await signEnvelope(key, unsigned) : { ...unsigned, sig: FIXTURE_SIG };
}

// ------------------------------------------------------------------ producing

export interface PendingEvent {
  statement: D1PreparedStatement;
  eventId: string;
}

/**
 * THE ONE STATEMENT A BUSINESS BATCH GAINS — or null, which is what today's
 * live Worker gets. Never throws: a malformed payload, a missing table or a
 * refusing probe all end as `null` plus a log line.
 */
export async function outboxStatement<T>(
  db: D1Database,
  schema: EventSchema<T>,
  payload: T,
  o: EmitOptions
): Promise<PendingEvent | null> {
  const handle = busFor(db);
  if (!handle || !eventsEnabled(handle.env)) return null;
  try {
    const envelope = await buildEnvelope(handle.env, schema, payload, o);
    const statement = await handle.bus.publishStatement(envelope, o.guard);
    return statement ? { statement, eventId: envelope.event_id } : null;
  } catch (e) {
    console.error(`event ${schema.type} not published:`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** `outboxStatement` for callers with no batch of their own: writes the row immediately. */
export async function emitEvent<T>(db: D1Database, schema: EventSchema<T>, payload: T, o: EmitOptions): Promise<string | null> {
  const pending = await outboxStatement(db, schema, payload, o);
  if (!pending) return null;
  try {
    await pending.statement.run();
    return pending.eventId;
  } catch (e) {
    console.error(`event ${schema.type} not written:`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

/**
 * A `best_effort` event (03-EVENTS.md §2.1): fire-and-forget RPC to the bound
 * subscribers, never an outbox row, never a D1 write. Telemetry at page-view
 * rates must not cost the customer database anything.
 */
export async function emitBestEffort<T>(
  db: D1Database,
  schema: EventSchema<T>,
  payload: T,
  o: EmitOptions & { waitUntil?: (p: Promise<unknown>) => void }
): Promise<void> {
  const handle = busFor(db);
  if (!handle || !eventsEnabled(handle.env) || handle.bound.length === 0) return;
  try {
    const envelope = await buildEnvelope(handle.env, schema, payload, o);
    handle.bus.emitBestEffort(envelope, o.waitUntil);
  } catch (e) {
    console.error(`event ${schema.type} not emitted:`, e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------- dispatching

/**
 * Delivers exactly the events this request just committed. No lock, no
 * `SELECT … WHERE dispatched_at IS NULL` on the shared database per request.
 * Swallows everything: a delivery failure is the cron's problem, never the
 * response's.
 */
export function pumpAfter(db: D1Database, ids: Array<string | null | undefined>, waitUntil?: (p: Promise<unknown>) => void): void {
  const eventIds = ids.filter((x): x is string => typeof x === 'string' && x !== '');
  if (eventIds.length === 0) return;
  const handle = busFor(db);
  if (!handle || handle.bound.length === 0) return;
  const work = handle.bus.pumpIds(eventIds).catch((e) => {
    console.error('event pump failed', e instanceof Error ? e.message : String(e));
    return null;
  });
  if (waitUntil) waitUntil(work);
  else void work;
}

/**
 * The request's `waitUntil`, or undefined when there is no execution context
 * (a unit test, a direct call). Hono THROWS when a context has none, so this
 * is the one place that has to catch it.
 */
export function waitUntilFrom(c: unknown): ((p: Promise<unknown>) => void) | undefined {
  try {
    const ctx = (c as { executionCtx?: ExecutionContext }).executionCtx;
    if (ctx && typeof ctx.waitUntil === 'function') return (p) => ctx.waitUntil(p);
  } catch {
    // no ExecutionContext here — the cron sweep will deliver instead
  }
  return undefined;
}

/**
 * The one-liner a route uses when it has no batch of its own: write the event
 * row, then deliver it after the response. Returns the event id, or null when
 * the bus is off — which is every call on the live Worker today.
 */
export async function emitFromRequest<T>(
  c: { env: Env },
  schema: EventSchema<T>,
  payload: T,
  o: EmitOptions
): Promise<string | null> {
  if (!eventsEnabled(c.env)) return null;
  const id = await emitEvent(c.env.DB, schema, payload, o);
  pumpAfter(c.env.DB, [id], waitUntilFrom(c));
  return id;
}

/**
 * Creates the pump's lock row if it is missing. Idempotent, once per isolate:
 * the migration deliberately ships no seed row (it would be its only non-CREATE
 * statement), and a lock row that does not exist would make `pump()` a silent
 * no-op forever — the conditional UPDATE would match nothing.
 */
async function ensurePumpLock(env: Env): Promise<void> {
  if (lockSeeded.has(env.DB as unknown as object)) return;
  const t = outboxTables(CORE_SERVICE);
  await env.DB.prepare(`INSERT OR IGNORE INTO ${t.lock} (name) VALUES (?)`).bind(CORE_SERVICE).run();
  lockSeeded.add(env.DB as unknown as object);
}

/**
 * The cron sweep (step 0 of `lib/jobs.ts`) — the only lock holder. Returns
 * null when the bus is off, no consumer is bound, the table is absent or
 * another run holds the lock.
 */
export async function pumpOutbox(env: Env, holder = 'cron'): Promise<PumpReport | null> {
  configureEventBus(env);
  const handle = busFor(env.DB);
  if (!handle || !eventsEnabled(env) || handle.bound.length === 0) return null;
  if (!(await defaultProbe.present(env.DB, outboxTables(CORE_SERVICE).events))) return null;
  await ensurePumpLock(env);
  return handle.bus.pump(holder);
}

/** Oldest undelivered event age in seconds — the deep-health lag number. */
export async function outboxLagSeconds(env: Env): Promise<number | null> {
  const handle = busFor(env.DB);
  if (!handle || !eventsEnabled(env)) return null;
  if (!(await defaultProbe.present(env.DB, outboxTables(CORE_SERVICE).events))) return null;
  return handle.bus.oldestPendingAgeS();
}

/**
 * OUTBOX RETENTION (`03-EVENTS.md` §5 rule 6, the header of
 * `migrations/0057_core_outbox.sql`).
 *
 * Three tables grow for ever without this. `core_outbox_events` keeps the full
 * signed JSON envelope of every event the core publishes; `core_outbox_deliveries`
 * one row per (event, consumer); `core_audit_details` a SECOND, complete copy
 * of every audit body — the most sensitive payloads the system writes. All of
 * them live in the shared customer database, which D1 caps at 10 GB, and the
 * only prune helper the platform kit exports had no caller anywhere in the
 * tree.
 *
 * The windows, and why they are what they are:
 *
 *  - AUDIT DETAILS: 24 hours after the event was dispatched. The migration
 *    promises exactly that, and the body is a hand-over buffer, not a store —
 *    Audit owns the record.
 *  - DELIVERIES: acked rows older than the replay window. A `dead` row is NOT
 *    pruned: it is the DLQ, and it stays until someone redelivers it.
 *  - EVENTS: dispatched rows older than the replay window. `bus.replay(from_seq,
 *    to_seq)` is the rebuild path for Audit and Analytics, so the window is
 *    what "how far back can we rebuild" means — 30 days, stated here rather
 *    than left as "for ever".
 *
 * Deletes are BOUNDED per run (`LIMIT` through a subquery), so a first run
 * against a large table is many small deletes rather than one that times out.
 */
export const OUTBOX_REPLAY_WINDOW_DAYS = 30;
export const AUDIT_DETAIL_RETENTION_HOURS = 24;
export const RETENTION_DELETE_LIMIT = 500;

export interface RetentionReport {
  audit_details: number;
  deliveries: number;
  events: number;
}

export async function pruneOutbox(env: Env, nowMs = Date.now()): Promise<RetentionReport | null> {
  const report: RetentionReport = { audit_details: 0, deliveries: 0, events: 0 };
  const handle = busFor(env.DB);
  if (!handle) return null;
  const t = outboxTables(CORE_SERVICE);
  if (!(await defaultProbe.present(env.DB, t.events))) return null;
  const detailsBefore = new Date(nowMs - AUDIT_DETAIL_RETENTION_HOURS * 3_600_000).toISOString();
  const eventsBefore = new Date(nowMs - OUTBOX_REPLAY_WINDOW_DAYS * 86_400_000).toISOString();

  const details = await pruneAuditDetailsStatement(env.DB, CORE_SERVICE, detailsBefore).run();
  report.audit_details = details.meta.changes ?? 0;

  // Deliveries first: an event row may not be dropped while a delivery still
  // points at it, and a `dead` delivery is the DLQ and is never pruned.
  const deliveries = await env.DB.prepare(
    `DELETE FROM ${t.deliveries}
      WHERE rowid IN (SELECT rowid FROM ${t.deliveries} WHERE state = 'acked' AND acked_at IS NOT NULL AND acked_at < ? LIMIT ?)`
  )
    .bind(eventsBefore, RETENTION_DELETE_LIMIT)
    .run();
  report.deliveries = deliveries.meta.changes ?? 0;

  const events = await env.DB.prepare(
    `DELETE FROM ${t.events}
      WHERE rowid IN (
        SELECT e.rowid FROM ${t.events} e
         WHERE e.dispatched_at IS NOT NULL AND e.created_at < ?
           AND NOT EXISTS (SELECT 1 FROM ${t.deliveries} d WHERE d.event_id = e.event_id)
         LIMIT ?
      )`
  )
    .bind(eventsBefore, RETENTION_DELETE_LIMIT)
    .run();
  report.events = events.meta.changes ?? 0;
  return report;
}

/** Admin/replay surfaces (the DLQ is the deliveries table). */
export async function redeliverEvent(env: Env, eventId: string, consumer: string): Promise<PumpReport | null> {
  const handle = busFor(env.DB);
  if (!handle) return null;
  return handle.bus.redeliver(eventId, consumer);
}
