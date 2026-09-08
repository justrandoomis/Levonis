/**
 * The `audit()` facade (ADR-012): keeps today's signature
 * (`audit(db, actorId, action, target, detail)`) and, when the bus is enabled,
 * appends an `AuditRecorded` outbox row to the caller's batch IN ADDITION to
 * the legacy `audit_log` insert (dual-write until Phase 3). The `detail` body
 * never travels in the envelope: it is stored in `<svc>_audit_details`
 * (pruned within 24 h of ack) and handed to Audit in the same `deliver()`.
 */
import { FIXTURE_SIG, type EventEnvelope, type UnsignedEnvelope } from '@levonis/contracts/envelope';
import { AuditRecordedV1 } from '@levonis/contracts/events/v1/AuditRecorded';
import { canonicalHash } from '@levonis/contracts/canonical';
import { publishStatement, type PublishOptions } from './outbox';
import { uuidv7, type Clock, systemClock } from './correlation';

export const auditDetailsTable = (prefix: string) => `${prefix}_audit_details`;

export function auditDetailsSchemaSql(prefix: string): string {
  return `CREATE TABLE IF NOT EXISTS ${auditDetailsTable(prefix)} (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL UNIQUE,
  detail     TEXT NOT NULL,
  created_at TEXT NOT NULL
);`;
}

export interface AuditContext extends PublishOptions {
  /** the emitting service (`source_service`) */
  source: string;
  correlationId: string;
  /** dual-write the legacy `audit_log` row (the core, until Phase 3) */
  legacyAuditLog?: boolean;
  /**
   * Signs the envelope with the producer's `<SVC>_SIGNING_KEY` (`eventSig.ts`
   * `signEnvelope`). Omitted where no key is configured yet — the envelope then
   * carries the `fixture` marker, which only a consumer running with
   * `acceptFixtureSig` (dark, tests) will take.
   */
  sign?: (envelope: UnsignedEnvelope) => Promise<EventEnvelope>;
  clock?: Clock;
}

export interface AuditStatements {
  statements: D1PreparedStatement[];
  eventId: string | null;
}

/**
 * The statements the caller appends to its batch: the legacy `audit_log` row
 * (when asked), the `<svc>_audit_details` row and the `AuditRecorded` outbox row.
 * A sensitive mutation therefore cannot succeed unaudited.
 */
export async function auditStatements(
  db: D1Database,
  ctx: AuditContext,
  actorId: string | null,
  action: string,
  target: string,
  detail: Record<string, unknown> = {}
): Promise<AuditStatements> {
  const clock = ctx.clock ?? systemClock;
  const detailJson = JSON.stringify(detail).slice(0, 4000);
  const statements: D1PreparedStatement[] = [];
  if (ctx.legacyAuditLog) {
    statements.push(db.prepare('INSERT INTO audit_log (actor_id, action, target, detail) VALUES (?, ?, ?, ?)').bind(actorId, action, target, detailJson));
  }
  const eventId = uuidv7(clock);
  const unsigned = AuditRecordedV1.envelope({
    event_id: eventId,
    created_at: new Date(clock.now()).toISOString(),
    source_service: ctx.source,
    correlation_id: ctx.correlationId,
    causation_id: null,
    actor_id: actorId,
    aggregate_id: eventId,
    aggregate_seq: 1, // the aggregate IS this event (aggregate_id = event_id), so 1 is unique by construction
    payload: { actor_id: actorId, action, target, detail_hash: await canonicalHash(detail), detail_ref: eventId, source_service: ctx.source },
  });
  // Signed by the producer here, at build time, because the outbox row stores
  // the envelope verbatim; `fixture` when no key is configured yet.
  const envelope: EventEnvelope = ctx.sign ? await ctx.sign(unsigned) : { ...unsigned, sig: FIXTURE_SIG };
  const outbox = await publishStatement(db, envelope, ctx);
  if (outbox) {
    statements.push(
      db.prepare(`INSERT INTO ${auditDetailsTable(ctx.prefix)} (id, event_id, detail, created_at) VALUES (?, ?, ?, ?)`).bind(eventId, eventId, detailJson, envelope.created_at),
      outbox
    );
    return { statements, eventId };
  }
  return { statements, eventId: null };
}

/**
 * Today's signature, for call sites outside a batch. Failures are logged, not
 * thrown, exactly as `worker/lib/audit.ts` behaves — the strong guarantee is
 * `auditStatements()` inside the caller's batch.
 */
export async function audit(db: D1Database, ctx: AuditContext, actorId: string | null, action: string, target: string, detail: Record<string, unknown> = {}): Promise<void> {
  try {
    const { statements } = await auditStatements(db, ctx, actorId, action, target, detail);
    if (statements.length === 1) await statements[0].run();
    else if (statements.length > 1) await db.batch(statements);
  } catch (e) {
    console.error('audit write failed', action, e);
  }
}

/** Drops detail rows older than 24 h whose event was acked — `03-EVENTS.md` §5 rule 6. */
export function pruneAuditDetailsStatement(db: D1Database, prefix: string, olderThanIso: string): D1PreparedStatement {
  return db
    .prepare(`DELETE FROM ${auditDetailsTable(prefix)} WHERE created_at < ? AND event_id IN (SELECT event_id FROM ${prefix}_outbox_events WHERE dispatched_at IS NOT NULL)`)
    .bind(olderThanIso);
}
