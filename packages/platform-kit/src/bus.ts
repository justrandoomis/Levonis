/**
 * The dispatcher (`03-EVENTS.md` §2.2, ADR-005). `RpcFanoutBus` today: the
 * post-request `pumpIds()` delivers only the ids the request just committed
 * (no lock, no `SELECT pending` per request); the per-minute cron's `pump()`
 * is the ONLY `pump_lock` holder and sweeps what the pumps missed. Delivery
 * state is written with ONE statement per `deliver()` call (`UPDATE … WHERE
 * event_id IN (<=50 ids)`), never per event; a run is budgeted at <=600 D1
 * statements and <=60 RPC calls; batches are <=50 events and <=500 KB;
 * backoff `min(15 min, 5 s * 2^attempts)` + jitter; dead after 8 attempts
 * (the DLQ is the deliveries table, replayable). `QueueBus` when Queues
 * exist: one queue per consumer, `sendBatch` in <=100-message / 256 KB chunks,
 * envelopes above 100 KB sent as pointers. `best_effort` events never touch
 * the outbox: `emitBestEffort()` fires the subscribers in `waitUntil`.
 */
import type { EventEnvelope } from '@levonis/contracts/envelope';
import { eventKeyOf, type PiiClass } from '@levonis/contracts/envelope';
import { mayConsume, SUBSCRIPTIONS } from '@levonis/contracts/subscriptions';
import type { DeliverResult, HopEnvelope } from '@levonis/contracts/rpc/common';
import { DELIVER_MAX_BYTES, DELIVER_MAX_EVENTS } from '@levonis/contracts/rpc/consumer';
import { chunk, inList, placeholders } from './inList';
import { outboxTables, publishStatement, type OutboxProbe } from './outbox';
import { signHop, type HopSigner } from './hop';
import type { Logger, PumpReport } from './log';

export interface ConsumerBinding {
  deliver(batch: EventEnvelope[], hop?: HopEnvelope): Promise<DeliverResult>;
}

export interface QueueBinding {
  sendBatch(messages: Array<{ body: unknown }>): Promise<void>;
}

export interface BusBudgets {
  statements: number; // <=600 per run
  rpcCalls: number; // <=60 per run
  batchEvents: number; // <=50 per deliver()
  batchBytes: number; // <=500 KB serialised per deliver()
  selectLimit: number; // pending events selected per pump()
}

export const DEFAULT_BUS_BUDGETS: BusBudgets = { statements: 600, rpcCalls: 60, batchEvents: DELIVER_MAX_EVENTS, batchBytes: DELIVER_MAX_BYTES, selectLimit: 200 };
export const MAX_DELIVERY_ATTEMPTS = 8;
export const BACKOFF_CAP_S = 15 * 60;
export const PUMP_LOCK_TTL_S = 55;
/** A released lock is dated at the epoch so the next run acquires it whatever the clock granularity. */
export const LOCK_RELEASED = '1970-01-01T00:00:00.000Z';

export interface BusOptions {
  db: D1Database;
  /** platform-table prefix (`core`, `commerce`, …) */
  prefix: string;
  /** this producer's service name — `source_service` of what it publishes */
  source: string;
  /** the `EVENT_BUS_ENABLED` var */
  enabled: string | boolean | undefined;
  /** bound consumers by service name (`env.AUDIT` -> 'audit'); an unbound subscriber's deliveries stay pending */
  consumers: Partial<Record<string, ConsumerBinding>>;
  hopSigner?: HopSigner;
  subscriptions?: Record<string, string[]>;
  budgets?: Partial<BusBudgets>;
  probe?: OutboxProbe;
  now?: () => number;
  log?: Logger;
}

interface EventRow {
  seq: number;
  event_id: string;
  envelope: string;
}

interface DueRow {
  event_id: string;
  consumer: string;
  attempts: number;
}

const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).length;
const iso = (ms: number) => new Date(ms).toISOString();

class Budget {
  statements = 0;
  rpcCalls = 0;
  hit = false;
  constructor(private readonly limits: BusBudgets) {}
  canStatement(n = 1): boolean {
    if (this.statements + n > this.limits.statements) {
      this.hit = true;
      return false;
    }
    return true;
  }
  canRpc(): boolean {
    if (this.rpcCalls + 1 > this.limits.rpcCalls) {
      this.hit = true;
      return false;
    }
    return true;
  }
}

/** Splits envelopes into deliver() batches respecting both caps. */
export function batchEnvelopes(envelopes: EventEnvelope[], maxEvents = DELIVER_MAX_EVENTS, maxBytes = DELIVER_MAX_BYTES): EventEnvelope[][] {
  const out: EventEnvelope[][] = [];
  let cur: EventEnvelope[] = [];
  let bytes = 0;
  for (const e of envelopes) {
    const size = byteLength(JSON.stringify(e));
    if (cur.length > 0 && (cur.length >= maxEvents || bytes + size > maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(e);
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** `min(15 min, 5 s * 2^attempts)` — the SQL form adds jitter of up to 5 s. */
export function backoffSeconds(attempts: number): number {
  return Math.min(BACKOFF_CAP_S, 5 * 2 ** Math.min(attempts, 20));
}

export class RpcFanoutBus {
  readonly tables;
  private readonly limits: BusBudgets;
  private readonly subs: Record<string, string[]>;
  private readonly now: () => number;

  constructor(private readonly opts: BusOptions) {
    this.tables = outboxTables(opts.prefix);
    this.limits = { ...DEFAULT_BUS_BUDGETS, ...opts.budgets };
    this.subs = opts.subscriptions ?? SUBSCRIPTIONS;
    this.now = opts.now ?? (() => Date.now());
  }

  /** The outbox statement for the business batch — or null while the bus is off / the table absent. */
  publishStatement(envelope: EventEnvelope): Promise<D1PreparedStatement | null> {
    return publishStatement(this.opts.db, envelope, { enabled: this.opts.enabled, prefix: this.opts.prefix, probe: this.opts.probe });
  }

  /** Subscribers of this envelope that may receive its PII class (the bus never delivers `personal` to Ads/Analytics/Search/Farm). */
  subscribersFor(envelope: EventEnvelope): string[] {
    const all = this.subs[eventKeyOf(envelope)] ?? [];
    return all.filter((c) => mayConsume(c, envelope.pii_class as PiiClass));
  }

  /** Fire-and-forget delivery of a best_effort envelope; drops on failure; never touches D1. */
  emitBestEffort(envelope: EventEnvelope, waitUntil: (p: Promise<unknown>) => void = (p) => void p): void {
    if (envelope.delivery !== 'best_effort') throw new Error(`emitBestEffort: ${envelope.event_type} is transactional — publish it through the outbox`);
    for (const name of this.subscribersFor(envelope)) {
      const binding = this.opts.consumers[name];
      if (!binding) continue;
      waitUntil(
        this.callDeliver(binding, name, [envelope]).catch((e) => {
          this.opts.log?.warn('bus.best_effort_dropped', { consumer: name, type: envelope.event_type, error: (e as Error).message });
        })
      );
    }
  }

  /** Delivers only the events this request just committed. No lock. */
  async pumpIds(eventIds: string[]): Promise<PumpReport> {
    const budget = new Budget(this.limits);
    const report: PumpReport = { selected: 0, delivered: 0, retried: 0, dead: 0, budget_hit: false, statements: 0, rpc_calls: 0 };
    if (eventIds.length === 0) return report;
    const rows = await inList(eventIds, async (part, marks) => {
      budget.statements++;
      const r = await this.opts.db.prepare(`SELECT seq, event_id, envelope FROM ${this.tables.events} WHERE event_id IN (${marks}) AND dispatched_at IS NULL ORDER BY seq`).bind(...part).all<EventRow>();
      return r.results ?? [];
    });
    await this.process(rows, budget, report);
    return this.finish(report, budget);
  }

  /** The cron sweep: the only lock holder. Returns null when another run holds the lock. */
  async pump(holder = 'cron'): Promise<PumpReport | null> {
    const budget = new Budget(this.limits);
    const report: PumpReport = { selected: 0, delivered: 0, retried: 0, dead: 0, budget_hit: false, statements: 0, rpc_calls: 0 };
    const nowMs = this.now();
    budget.statements++;
    const lock = await this.opts.db
      .prepare(`UPDATE ${this.tables.lock} SET locked_until = ?, holder = ? WHERE name = ? AND locked_until <= ?`)
      .bind(iso(nowMs + PUMP_LOCK_TTL_S * 1000), holder, this.opts.prefix, iso(nowMs))
      .run();
    if ((lock.meta.changes ?? 0) !== 1) return null;
    try {
      budget.statements++;
      const rows = await this.opts.db
        .prepare(`SELECT seq, event_id, envelope FROM ${this.tables.events} WHERE dispatched_at IS NULL ORDER BY seq LIMIT ?`)
        .bind(this.limits.selectLimit)
        .all<EventRow>();
      await this.process(rows.results ?? [], budget, report);
    } finally {
      budget.statements++;
      await this.opts.db.prepare(`UPDATE ${this.tables.lock} SET locked_until = ?, holder = '' WHERE name = ?`).bind(LOCK_RELEASED, this.opts.prefix).run();
    }
    return this.finish(report, budget);
  }

  /** Re-delivers a range of the outbox to one consumer (Audit/Analytics rebuilds). Safe by construction. */
  async replay(range: { from_seq: number; to_seq: number; consumer: string }): Promise<PumpReport> {
    const budget = new Budget(this.limits);
    const report: PumpReport = { selected: 0, delivered: 0, retried: 0, dead: 0, budget_hit: false, statements: 0, rpc_calls: 0 };
    budget.statements++;
    const rows = await this.opts.db
      .prepare(`SELECT seq, event_id, envelope FROM ${this.tables.events} WHERE seq BETWEEN ? AND ? ORDER BY seq LIMIT ?`)
      .bind(range.from_seq, range.to_seq, this.limits.selectLimit)
      .all<EventRow>();
    const ids = (rows.results ?? []).map((r) => r.event_id);
    if (ids.length) {
      await this.runStatements(
        chunk(ids, 90).map((part) =>
          this.opts.db
            .prepare(`UPDATE ${this.tables.deliveries} SET state = 'pending', attempts = 0, next_attempt_at = ?, acked_at = NULL WHERE consumer = ? AND event_id IN (${placeholders(part.length)})`)
            .bind(iso(this.now()), range.consumer, ...part)
        ),
        budget
      );
      await this.runStatements(
        chunk(ids, 90).map((part) => this.opts.db.prepare(`UPDATE ${this.tables.events} SET dispatched_at = NULL WHERE event_id IN (${placeholders(part.length)})`).bind(...part)),
        budget
      );
    }
    await this.process(rows.results ?? [], budget, report, range.consumer);
    return this.finish(report, budget);
  }

  /** Admin: put one dead delivery back to pending and deliver it. */
  async redeliver(eventId: string, consumer: string): Promise<PumpReport> {
    await this.opts.db
      .prepare(`UPDATE ${this.tables.deliveries} SET state = 'pending', attempts = 0, next_attempt_at = ?, last_error = '' WHERE event_id = ? AND consumer = ?`)
      .bind(iso(this.now()), eventId, consumer)
      .run();
    await this.opts.db.prepare(`UPDATE ${this.tables.events} SET dispatched_at = NULL WHERE event_id = ?`).bind(eventId).run();
    return this.pumpIds([eventId]);
  }

  /** Oldest pending event age in seconds (deep health), or null when nothing is pending. */
  async oldestPendingAgeS(): Promise<number | null> {
    const row = await this.opts.db.prepare(`SELECT MIN(created_at) AS oldest FROM ${this.tables.events} WHERE dispatched_at IS NULL`).first<{ oldest: string | null }>();
    if (!row?.oldest) return null;
    return Math.max(0, Math.round((this.now() - Date.parse(row.oldest)) / 1000));
  }

  // ------------------------------------------------------------------ internals

  private finish(report: PumpReport, budget: Budget): PumpReport {
    report.budget_hit = budget.hit;
    report.statements = budget.statements;
    report.rpc_calls = budget.rpcCalls;
    this.opts.log?.money('PumpReport', { ...report, prefix: this.opts.prefix });
    return report;
  }

  private async runStatements(stmts: D1PreparedStatement[], budget: Budget): Promise<void> {
    if (stmts.length === 0) return;
    if (!budget.canStatement(stmts.length)) return;
    budget.statements += stmts.length;
    await this.opts.db.batch(stmts);
  }

  private async callDeliver(binding: ConsumerBinding, consumer: string, batch: EventEnvelope[]): Promise<DeliverResult> {
    const hop = this.opts.hopSigner
      ? await signHop(this.opts.hopSigner, { method: `${consumer}.deliver`, args: [batch], nowSeconds: Math.floor(this.now() / 1000) })
      : undefined;
    return binding.deliver(batch, hop);
  }

  private async process(rows: EventRow[], budget: Budget, report: PumpReport, onlyConsumer?: string): Promise<void> {
    if (rows.length === 0) return;
    report.selected = rows.length;
    const envelopes = new Map<string, EventEnvelope>();
    const subscribers = new Map<string, string[]>();
    for (const r of rows) {
      const env = JSON.parse(r.envelope) as EventEnvelope;
      envelopes.set(r.event_id, env);
      const subs = this.subscribersFor(env).filter((c) => !onlyConsumer || c === onlyConsumer);
      subscribers.set(r.event_id, subs);
    }
    // 1. deliveries rows for every subscriber (INSERT OR IGNORE, multi-row, <=33 rows per statement under the 100-param cap)
    const nowIso = iso(this.now());
    const pairs: Array<[string, string]> = [];
    for (const [id, subs] of subscribers) for (const c of subs) pairs.push([id, c]);
    await this.runStatements(
      chunk(pairs, 33).map((part) =>
        this.opts.db
          .prepare(`INSERT OR IGNORE INTO ${this.tables.deliveries} (event_id, consumer, next_attempt_at) VALUES ${part.map(() => '(?, ?, ?)').join(', ')}`)
          .bind(...part.flatMap(([id, c]) => [id, c, nowIso]))
      ),
      budget
    );
    if (budget.hit) return;
    // 2. due deliveries
    const ids = [...envelopes.keys()];
    const due = await inList(ids, async (part, marks) => {
      if (!budget.canStatement()) return [];
      budget.statements++;
      const r = await this.opts.db
        .prepare(`SELECT event_id, consumer, attempts FROM ${this.tables.deliveries} WHERE state = 'pending' AND next_attempt_at <= ? AND event_id IN (${marks})${onlyConsumer ? ' AND consumer = ?' : ''}`)
        .bind(nowIso, ...part, ...(onlyConsumer ? [onlyConsumer] : []))
        .all<DueRow>();
      return r.results ?? [];
    });
    // 3. group by consumer, chunk, deliver, one bookkeeping statement per outcome class per call
    const byConsumer = new Map<string, DueRow[]>();
    for (const d of due) {
      if (!byConsumer.has(d.consumer)) byConsumer.set(d.consumer, []);
      byConsumer.get(d.consumer)!.push(d);
    }
    for (const [consumer, rowsForConsumer] of byConsumer) {
      const binding = this.opts.consumers[consumer];
      if (!binding) {
        this.opts.log?.warn('bus.consumer_unbound', { consumer, pending: rowsForConsumer.length });
        continue;
      }
      const ordered = rowsForConsumer.map((d) => envelopes.get(d.event_id)!).sort((a, b) => (rows.findIndex((r) => r.event_id === a.event_id) - rows.findIndex((r) => r.event_id === b.event_id)));
      for (const batch of batchEnvelopes(ordered, this.limits.batchEvents, this.limits.batchBytes)) {
        if (!budget.canRpc() || !budget.canStatement(3)) return;
        budget.rpcCalls++;
        let outcome: DeliverResult | null = null;
        let error = '';
        try {
          outcome = await this.callDeliver(binding, consumer, batch);
        } catch (e) {
          error = (e as Error).message ?? 'deliver threw';
        }
        const acked: string[] = [];
        const poison: Array<[string, string]> = [];
        const retry: string[] = [];
        if (!outcome) retry.push(...batch.map((b) => b.event_id));
        else {
          const seen = new Map(outcome.results.map((r) => [r.event_id, r]));
          for (const env of batch) {
            const r = seen.get(env.event_id);
            if (!r || r.result === 'retry') retry.push(env.event_id);
            else if (r.result === 'acked' || r.result === 'replayed') acked.push(env.event_id);
            else poison.push([env.event_id, r.result]);
          }
        }
        const stmts: D1PreparedStatement[] = [];
        if (acked.length) {
          stmts.push(
            this.opts.db
              .prepare(`UPDATE ${this.tables.deliveries} SET state = 'acked', acked_at = ?, attempts = attempts + 1, last_error = '' WHERE consumer = ? AND event_id IN (${placeholders(acked.length)})`)
              .bind(nowIso, consumer, ...acked)
          );
          report.delivered += acked.length;
        }
        if (poison.length) {
          // schema-invalid, forged or above the consumer's PII class: dead at once, never retried
          stmts.push(
            this.opts.db
              .prepare(`UPDATE ${this.tables.deliveries} SET state = 'dead', attempts = attempts + 1, last_error = ? WHERE consumer = ? AND event_id IN (${placeholders(poison.length)})`)
              .bind(poison.map(([, why]) => why).join(','), consumer, ...poison.map(([id]) => id))
          );
          report.dead += poison.length;
          this.opts.log?.error('bus.poison', { consumer, events: poison });
        }
        if (retry.length) {
          stmts.push(
            this.opts.db
              .prepare(
                `UPDATE ${this.tables.deliveries}
                    SET attempts = attempts + 1,
                        last_error = ?,
                        state = CASE WHEN attempts + 1 >= ${MAX_DELIVERY_ATTEMPTS} THEN 'dead' ELSE 'pending' END,
                        next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+' || (min(${BACKOFF_CAP_S}, 5 * (1 << min(attempts + 1, 20))) + (abs(random()) % 5)) || ' seconds')
                  WHERE consumer = ? AND event_id IN (${placeholders(retry.length)})`
              )
              .bind(error || 'retry', nowIso, consumer, ...retry)
          );
          report.retried += retry.length;
        }
        await this.runStatements(stmts, budget);
      }
    }
    // 4. events whose deliveries are all settled (or that have no subscriber) are dispatched
    await this.runStatements(
      chunk(ids, 90).map((part) =>
        this.opts.db
          .prepare(
            `UPDATE ${this.tables.events} SET dispatched_at = ? WHERE dispatched_at IS NULL AND event_id IN (${placeholders(part.length)})
               AND NOT EXISTS (SELECT 1 FROM ${this.tables.deliveries} d WHERE d.event_id = ${this.tables.events}.event_id AND d.state = 'pending')`
          )
          .bind(nowIso, ...part)
      ),
      budget
    );
  }
}

/**
 * Queue mode (`EVENT_BUS_MODE=queue`): one queue per consumer service. Every
 * producer declares `queues.producers` for each subscriber; `pump` calls
 * `env.Q_<CONSUMER>.sendBatch()` in chunks of <=100 messages / <=256 KB; an
 * envelope above 100 KB stays in the outbox and a pointer is sent instead.
 * The consumer's `queue()` handler calls the same `deliver()`.
 */
export const QUEUE_BATCH_MAX_MESSAGES = 100;
export const QUEUE_BATCH_MAX_BYTES = 256 * 1024;
export const QUEUE_POINTER_THRESHOLD_BYTES = 100 * 1024;

export type QueueMessage = { kind: 'envelope'; envelope: EventEnvelope } | { kind: 'pointer'; event_id: string; producer: string };

export function toQueueMessages(envelopes: EventEnvelope[], producer: string): QueueMessage[] {
  return envelopes.map((e) => (byteLength(JSON.stringify(e)) > QUEUE_POINTER_THRESHOLD_BYTES ? { kind: 'pointer', event_id: e.event_id, producer } : { kind: 'envelope', envelope: e }));
}

export function chunkQueueMessages(messages: QueueMessage[]): QueueMessage[][] {
  const out: QueueMessage[][] = [];
  let cur: QueueMessage[] = [];
  let bytes = 0;
  for (const m of messages) {
    const size = byteLength(JSON.stringify(m));
    if (cur.length > 0 && (cur.length >= QUEUE_BATCH_MAX_MESSAGES || bytes + size > QUEUE_BATCH_MAX_BYTES)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(m);
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Adapts a queue binding to the consumer interface so `RpcFanoutBus` bookkeeping is reused unchanged. */
export function queueAsConsumer(queue: QueueBinding, producer: string): ConsumerBinding {
  return {
    async deliver(batch) {
      for (const part of chunkQueueMessages(toQueueMessages(batch, producer))) await queue.sendBatch(part.map((body) => ({ body })));
      return { results: batch.map((e) => ({ event_id: e.event_id, result: 'acked' as const })) };
    },
  };
}

/** Selects the transport from `EVENT_BUS_MODE` + binding presence; producers' code does not change. */
export function selectConsumers(
  mode: string | undefined,
  rpc: Partial<Record<string, ConsumerBinding>>,
  queues: Partial<Record<string, QueueBinding>>,
  producer: string
): Partial<Record<string, ConsumerBinding>> {
  if (mode !== 'queue') return rpc;
  const out: Partial<Record<string, ConsumerBinding>> = { ...rpc };
  for (const [name, q] of Object.entries(queues)) if (q) out[name] = queueAsConsumer(q, producer);
  return out;
}
