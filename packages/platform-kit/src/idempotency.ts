/**
 * Two idempotency layers (`01-TARGET.md` §4 item 10, `03-EVENTS.md` §2.3):
 *
 *  - consumers: `<svc>_processed_events (event_id PK, consumer, processed_at,
 *    result)` inserted IN THE SAME BATCH as the side effect — a PK violation
 *    rejects the batch and the event is acked as `replayed`;
 *  - HTTP/RPC commands: `<svc>_idempotency (service, scope, key, payload_hash,
 *    status, body, created_at)` scoped to the caller (`principal.sub`,
 *    `anon:<ip-hash>` or the hop `iss`), keys >= 16 chars, same key with a
 *    different payload hash -> 409 IDEMPOTENCY_MISMATCH.
 */
import { canonicalHash } from '@levonis/contracts/canonical';
import { idempotencyKeyInvalid, idempotencyMismatch } from './errors';

export const processedEventsTable = (prefix: string) => `${prefix}_processed_events`;
export const idempotencyTable = (prefix: string) => `${prefix}_idempotency`;

export function processedEventsSchemaSql(prefix: string): string {
  return `CREATE TABLE IF NOT EXISTS ${processedEventsTable(prefix)} (
  event_id     TEXT PRIMARY KEY,
  consumer     TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  result       TEXT
);`;
}

export function idempotencySchemaSql(prefix: string): string {
  return `CREATE TABLE IF NOT EXISTS ${idempotencyTable(prefix)} (
  service      TEXT NOT NULL,
  scope        TEXT NOT NULL,
  key          TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status       INTEGER NOT NULL,
  body         TEXT,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (service, scope, key)
);
CREATE INDEX IF NOT EXISTS idx_${prefix}_idempotency_created ON ${idempotencyTable(prefix)}(created_at);`;
}

/** The statement a consumer appends to its side-effect batch. */
export function processedEventStatement(db: D1Database, prefix: string, consumer: string, eventId: string, result: string, at: string): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO ${processedEventsTable(prefix)} (event_id, consumer, processed_at, result) VALUES (?, ?, ?, ?)`)
    .bind(eventId, consumer, at, result);
}

export async function isProcessed(db: D1Database, prefix: string, eventId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS one FROM ${processedEventsTable(prefix)} WHERE event_id = ?`).bind(eventId).first<{ one: number }>();
  return !!row;
}

/** True when a D1/SQLite error is the processed_events PK violation (= replay). */
export function isUniqueViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT|constraint failed/i.test(msg);
}

export const IDEMPOTENCY_KEY_MIN = 16;

export function assertIdempotencyKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length < IDEMPOTENCY_KEY_MIN || key.length > 200) throw idempotencyKeyInvalid();
}

export type IdempotencyBegin =
  | { kind: 'new' }
  | { kind: 'replay'; status: number; body: string | null }
  | { kind: 'in_progress' };

export interface IdempotencyStoreOptions {
  prefix: string;
  service: string;
  /** bodies are stored only for routes whose response cannot be recomputed (24 h TTL) */
  storeBodies?: boolean;
  now?: () => string;
}

/**
 * The command-idempotency store. `begin()` claims the key for this scope and
 * payload (or reports a replay / mismatch); `complete()` records the outcome;
 * `prune()` drops rows older than 24 h.
 */
export class IdempotencyStore {
  private readonly table: string;
  private readonly now: () => string;

  constructor(private readonly db: D1Database, private readonly opts: IdempotencyStoreOptions) {
    this.table = idempotencyTable(opts.prefix);
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  static async hashPayload(payload: unknown): Promise<string> {
    return canonicalHash(payload ?? null);
  }

  async begin(scope: string, key: string, payloadHash: string): Promise<IdempotencyBegin> {
    assertIdempotencyKey(key);
    const existing = await this.db
      .prepare(`SELECT payload_hash, status, body FROM ${this.table} WHERE service = ? AND scope = ? AND key = ?`)
      .bind(this.opts.service, scope, key)
      .first<{ payload_hash: string; status: number; body: string | null }>();
    if (existing) {
      if (existing.payload_hash !== payloadHash) throw idempotencyMismatch();
      if (existing.status === 0) return { kind: 'in_progress' };
      return { kind: 'replay', status: existing.status, body: existing.body };
    }
    try {
      await this.db
        .prepare(`INSERT INTO ${this.table} (service, scope, key, payload_hash, status, body, created_at) VALUES (?, ?, ?, ?, 0, NULL, ?)`)
        .bind(this.opts.service, scope, key, payloadHash, this.now())
        .run();
      return { kind: 'new' };
    } catch (e) {
      if (isUniqueViolation(e)) return this.begin(scope, key, payloadHash);
      throw e;
    }
  }

  /** The statement that records the outcome — append it to the command's batch. */
  completeStatement(scope: string, key: string, status: number, body: unknown): D1PreparedStatement {
    const stored = this.opts.storeBodies && body !== undefined ? JSON.stringify(body) : null;
    return this.db
      .prepare(`UPDATE ${this.table} SET status = ?, body = ? WHERE service = ? AND scope = ? AND key = ?`)
      .bind(status, stored, this.opts.service, scope, key);
  }

  async complete(scope: string, key: string, status: number, body: unknown): Promise<void> {
    await this.completeStatement(scope, key, status, body).run();
  }

  /** A failed attempt releases the key so the client can retry. */
  async release(scope: string, key: string): Promise<void> {
    await this.db.prepare(`DELETE FROM ${this.table} WHERE service = ? AND scope = ? AND key = ? AND status = 0`).bind(this.opts.service, scope, key).run();
  }

  async prune(olderThanIso: string): Promise<number> {
    const r = await this.db.prepare(`DELETE FROM ${this.table} WHERE created_at < ?`).bind(olderThanIso).run();
    return r.meta.changes ?? 0;
  }
}
