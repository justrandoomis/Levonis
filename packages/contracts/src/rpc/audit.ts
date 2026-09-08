import type { EventConsumer } from './consumer';
import type { RpcCtx } from './common';

export interface AuditQuery {
  actor_id?: string;
  action?: string;
  target?: string;
  from?: string;
  to?: string;
  limit?: number; // ≤200
  cursor?: string | null;
}

export interface AuditRow {
  id: string;
  seq: number;
  prev_hash: string;
  hash: string;
  event_id: string;
  actor_id: string | null;
  action: string;
  target: string;
  detail: Record<string, unknown> | null;
  source_service: string;
  created_at: string;
}

/**
 * One entry written directly rather than through an `AuditRecorded` envelope
 * (`03-EVENTS.md` §4): the two halves of the `audit()` facade end in the same
 * row, so a producer may emit the event (hash + reference, no body) and later
 * hand over the body, or skip the bus entirely for an entry that has no batch
 * to ride in.
 */
export interface AuditEntryInput {
  /**
   * The idempotency key: the `event_id` of the `AuditRecorded` this entry
   * belongs to, or a fresh UUIDv7. A second call with the same id records
   * nothing and reports `replayed`.
   */
  event_id: string;
  actor_id: string | null;
  action: string;
  target: string;
  /** ≤4000 characters once serialised; never a token, secret or full contact */
  detail?: Record<string, unknown> | null;
  /** Ignored when the call carries a signed hop — the issuer is the authority on who wrote this. */
  source_service?: string;
  correlation_id?: string;
  occurred_at?: string;
}

export interface AuditRecordResult {
  ok: true;
  event_id: string;
  /** true when the entry was already recorded under this `event_id` */
  replayed: boolean;
}

/** `levonis-audit` (`01-TARGET.md` row 20, ADR-012). Reads are `admin:full` only. */
export interface AuditApi extends EventConsumer {
  record(entry: AuditEntryInput, ctx: RpcCtx): Promise<AuditRecordResult>;
  query(q: AuditQuery, ctx: RpcCtx): Promise<{ rows: AuditRow[]; next: string | null }>;
  verifyChain(ctx: RpcCtx): Promise<{ ok: boolean; checked: number; head: string; anchored_head: string | null }>;
}
