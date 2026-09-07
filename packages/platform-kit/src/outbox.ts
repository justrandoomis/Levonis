/**
 * The transactional outbox in the producer's own store (`03-EVENTS.md` §2.1,
 * ADR-005). `publishStatement()` returns ONE statement to append to the
 * business batch — or null while the bus is disabled or the isolate's boot
 * probe found no outbox table, so code can ship before its migration without
 * breaking the batch it rides in. `Uow` refuses to commit a command declared
 * as publishing without its outbox statement.
 */
import type { EventEnvelope } from '@levonis/contracts/envelope';

export interface OutboxTables {
  events: string;
  deliveries: string;
  lock: string;
}

/** `core` -> `core_outbox_events`, `core_outbox_deliveries`, `pump_lock`. */
export function outboxTables(prefix: string): OutboxTables {
  return { events: `${prefix}_outbox_events`, deliveries: `${prefix}_outbox_deliveries`, lock: 'pump_lock' };
}

/** The DDL for a producer's outbox — the text every `<svc>` migration uses (`03-EVENTS.md` §2.1). */
export function outboxSchemaSql(prefix: string): string {
  const t = outboxTables(prefix);
  return `CREATE TABLE IF NOT EXISTS ${t.events} (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id       TEXT NOT NULL UNIQUE,
  event_type     TEXT NOT NULL,
  version        INTEGER NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id   TEXT NOT NULL,
  aggregate_seq  INTEGER NOT NULL,
  envelope       TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  dispatched_at  TEXT,
  UNIQUE (aggregate_type, aggregate_id, aggregate_seq)
);
CREATE INDEX IF NOT EXISTS idx_${prefix}_outbox_pending ON ${t.events}(dispatched_at) WHERE dispatched_at IS NULL;
CREATE TABLE IF NOT EXISTS ${t.deliveries} (
  event_id        TEXT NOT NULL,
  consumer        TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  state           TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','acked','dead')),
  last_error      TEXT NOT NULL DEFAULT '',
  next_attempt_at TEXT NOT NULL,
  acked_at        TEXT,
  PRIMARY KEY (event_id, consumer)
);
CREATE INDEX IF NOT EXISTS idx_${prefix}_outbox_deliveries_due ON ${t.deliveries}(state, next_attempt_at);
CREATE TABLE IF NOT EXISTS ${t.lock} (
  name         TEXT PRIMARY KEY,
  locked_until TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
  holder       TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO ${t.lock} (name) VALUES ('${prefix}');`;
}

/**
 * Per-isolate cache of "does the outbox table exist?" — `PRAGMA table_info`
 * once per isolate, so a deploy that precedes its migration writes today's
 * batches unchanged (the incident of DECISIONS row 36 cannot recur).
 */
export class OutboxProbe {
  private readonly cache = new Map<string, Promise<boolean>>();

  present(db: D1Database, table: string): Promise<boolean> {
    let p = this.cache.get(table);
    if (!p) {
      p = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .then((r) => (r.results?.length ?? 0) > 0)
        .catch(() => false);
      this.cache.set(table, p);
    }
    return p;
  }

  /** Tests and post-migration boots call this to forget a negative answer. */
  reset(table?: string): void {
    if (table) this.cache.delete(table);
    else this.cache.clear();
  }
}

export const defaultProbe = new OutboxProbe();

export interface PublishOptions {
  /** the `EVENT_BUS_ENABLED` var: anything but 'on' means off */
  enabled: string | boolean | undefined;
  prefix: string;
  probe?: OutboxProbe;
}

export const busEnabled = (v: string | boolean | undefined): boolean => v === true || v === 'on';

/**
 * The statement that rides in the business batch, or null when the bus is off
 * or the table is absent. Deliveries rows are created by the pump when it
 * first picks the event up, so the batch grows by exactly one statement.
 */
export async function publishStatement(db: D1Database, envelope: EventEnvelope, opts: PublishOptions): Promise<D1PreparedStatement | null> {
  if (!busEnabled(opts.enabled)) return null;
  if (envelope.delivery !== 'transactional') throw new Error(`publishStatement: ${envelope.event_type} is best_effort — use emitBestEffort`);
  const t = outboxTables(opts.prefix);
  if (!(await (opts.probe ?? defaultProbe).present(db, t.events))) return null;
  return db
    .prepare(
      `INSERT INTO ${t.events} (event_id, event_type, version, aggregate_type, aggregate_id, aggregate_seq, envelope, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(envelope.event_id, envelope.event_type, envelope.version, envelope.aggregate_type, envelope.aggregate_id, envelope.aggregate_seq, JSON.stringify(envelope), envelope.created_at);
}

/**
 * A unit of work: the business statements plus the outbox rows of the events
 * the command publishes. `commit()` refuses to run when a declared publish has
 * no statement while the bus is enabled — a publishing command cannot
 * silently drop its event.
 */
export class Uow {
  private readonly statements: D1PreparedStatement[] = [];
  private readonly declared = new Set<string>();
  private readonly published = new Set<string>();
  readonly eventIds: string[] = [];

  constructor(private readonly db: D1Database, private readonly opts: PublishOptions) {}

  /** The event types this command MUST publish. */
  declarePublishes(...eventTypes: string[]): this {
    for (const t of eventTypes) this.declared.add(t);
    return this;
  }

  add(...statements: D1PreparedStatement[]): this {
    this.statements.push(...statements);
    return this;
  }

  async publish(envelope: EventEnvelope): Promise<this> {
    const stmt = await publishStatement(this.db, envelope, this.opts);
    this.published.add(envelope.event_type);
    if (stmt) {
      this.statements.push(stmt);
      this.eventIds.push(envelope.event_id);
    }
    return this;
  }

  get size(): number {
    return this.statements.length;
  }

  async commit(): Promise<D1Result[]> {
    if (busEnabled(this.opts.enabled)) {
      for (const t of this.declared) {
        if (!this.published.has(t)) throw new Error(`Uow: command declared it publishes ${t} but no envelope was published`);
      }
    }
    if (this.statements.length === 0) return [];
    return this.db.batch(this.statements);
  }
}
