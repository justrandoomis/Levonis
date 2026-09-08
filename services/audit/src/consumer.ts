/**
 * The consumer half (`03-EVENTS.md` §2.3). `defineConsumer` does the refusing —
 * envelope shape, producer allowlist, signature, PII ceiling, payload schema,
 * `processed_events` idempotency — and this file supplies the one thing that is
 * Audit's own: the side effect, which is a single INSERT.
 *
 * `piiMax` is `personal`: Audit is one of the six consumers `03-EVENTS.md` §5
 * rule 5 allows to see `AuditRecorded`, `RoleChanged`, `DepositDecided` and
 * `WithdrawalStateChanged` at all. That is also why its reads are `admin:full`.
 */
import { defineConsumer, type Consumer, type EventHandler } from '@levonis/platform-kit/consumer';
import { canonicalHash } from '@levonis/contracts/canonical';
import { uuidv7 } from '@levonis/platform-kit/correlation';
import type { Logger } from '@levonis/platform-kit/log';
import type { KeyRing } from '@levonis/platform-kit/keys';
import { ENTRY_MAPPERS } from './entries';
import { insertEntryStatement, fillDetailStatement, type AuditEntry } from './store';
import { SERVICE } from './env';

export const DETAIL_MAX_CHARS = 4000;

/** The detail body, bounded exactly as the `audit()` facade bounds it. */
export const encodeDetail = (detail: Record<string, unknown> | null): string | null =>
  detail === null ? null : JSON.stringify(detail).slice(0, DETAIL_MAX_CHARS);

/**
 * One handler shape for every subscribed type: map the payload, hash the body
 * (or take the producer's hash), append. The mapper is looked up by event key,
 * so adding a type is adding a mapper plus a `subscriptions.ts` row — never a
 * new code path here.
 */
function handlerFor(key: string): EventHandler {
  const map = ENTRY_MAPPERS[key];
  return async (env, ctx) => {
    const draft = map(env);
    const detail = encodeDetail(draft.detail);
    const entry: AuditEntry = {
      id: uuidv7(),
      event_id: env.event_id,
      event_type: key,
      actor_id: draft.actor_id,
      action: draft.action,
      target: draft.target,
      detail_hash: draft.detail_hash ?? (await canonicalHash(draft.detail ?? {})),
      detail_ref: draft.detail_ref ?? null,
      detail,
      source_service: env.source_service,
      correlation_id: env.correlation_id,
      occurred_at: env.created_at,
      recorded_at: ctx.now,
    };
    return [insertEntryStatement(ctx.db, entry)];
  };
}

export interface AuditConsumerOptions {
  keys: KeyRing;
  acceptFixtureSig?: boolean;
  now?: () => string;
  log?: Logger;
  /** called for every refusal so the caller can log it (and, later, emit `EventRejected`) */
  onRejected?: (eventId: string, type: string, reason: string) => void;
}

export function auditConsumer(opts: AuditConsumerOptions): Consumer {
  const handlers: Record<string, EventHandler> = {};
  for (const key of Object.keys(ENTRY_MAPPERS)) handlers[key] = handlerFor(key);
  return defineConsumer({
    name: SERVICE,
    piiMax: 'personal',
    handlers,
    keys: opts.keys,
    acceptFixtureSig: opts.acceptFixtureSig,
    now: opts.now,
    log: opts.log,
    onRejected: (envelope, reason) => opts.onRejected?.(envelope.event_id, envelope.event_type, reason),
  });
}

/** The direct-write path (`AuditApi.record`), shared with the consumer's INSERT. */
export interface DirectEntry {
  event_id: string;
  actor_id: string | null;
  action: string;
  target: string;
  detail: Record<string, unknown> | null;
  source_service: string;
  correlation_id: string;
  occurred_at: string;
  recorded_at: string;
}

export async function directEntryStatements(db: D1Database, e: DirectEntry): Promise<D1PreparedStatement[]> {
  const detail = encodeDetail(e.detail);
  const entry: AuditEntry = {
    id: uuidv7(),
    event_id: e.event_id,
    event_type: 'record',
    actor_id: e.actor_id,
    action: e.action,
    target: e.target,
    detail_hash: await canonicalHash(e.detail ?? {}),
    detail_ref: null,
    detail,
    source_service: e.source_service,
    correlation_id: e.correlation_id,
    occurred_at: e.occurred_at,
    recorded_at: e.recorded_at,
  };
  const statements = [insertEntryStatement(db, entry)];
  // A producer that emitted `AuditRecorded` first and calls `record()` after
  // (the facade's two halves, `03-EVENTS.md` §4) fills the body of the row the
  // event created. The chain covers `detail_hash`, so this never disturbs it.
  if (detail) statements.push(fillDetailStatement(db, e.event_id, detail));
  return statements;
}
