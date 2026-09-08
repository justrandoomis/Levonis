/**
 * Append-only audit trail for sensitive admin/financial mutations.
 *
 * PHASE 1 (02-MIGRATION-PLAN.md 1.6, ADR-012): this is now a FACADE over the
 * platform kit's `audit()`. The signature and the `audit_log` row are exactly
 * what they were — every one of the ~200 call sites is untouched, and every
 * existing test that reads `audit_log` still reads the same row.
 *
 * What is new is a DUAL WRITE: when the event bus is enabled for this database,
 * the same call also writes an `AuditRecorded` outbox row (plus the detail body
 * in `core_audit_details`, because the body never travels in an envelope —
 * 03-EVENTS.md §4) inside ONE batch with the `audit_log` insert. Either both
 * land or neither does, so the future Audit service's hash chain and today's
 * table can never disagree about what happened.
 *
 * With the bus off — the live Worker today — `busFor()` returns null and this
 * is the same single INSERT it always was, failures logged and swallowed.
 */
import { auditStatements as kitAuditStatements, type AuditContext } from '@levonis/platform-kit/audit';
import { uuidv7 } from '@levonis/platform-kit/correlation';
import { busFor, coreSigner, CORE_SERVICE, eventsEnabled, pumpAfter } from './eventBus';

/** The legacy statement, unchanged — the only thing written when the bus is off. */
function legacyStatement(
  db: D1Database,
  actorId: string | null,
  action: string,
  target: string,
  detail: Record<string, unknown>
): D1PreparedStatement {
  return db
    .prepare('INSERT INTO audit_log (actor_id, action, target, detail) VALUES (?, ?, ?, ?)')
    .bind(actorId, action, target, JSON.stringify(detail).slice(0, 4000));
}

function contextFor(db: D1Database, correlationId?: string): AuditContext | null {
  const handle = busFor(db);
  if (!handle || !eventsEnabled(handle.env)) return null;
  return {
    enabled: handle.env.EVENT_BUS_ENABLED,
    prefix: CORE_SERVICE,
    source: CORE_SERVICE,
    correlationId: correlationId ?? uuidv7(),
    legacyAuditLog: true,
    sign: coreSigner(handle.env),
  };
}

/**
 * The statements an audited mutation appends to ITS OWN batch, so a sensitive
 * write cannot succeed unaudited. Callers that have no batch use `audit()`.
 */
export async function auditStatements(
  db: D1Database,
  actorId: string | null,
  action: string,
  target: string,
  detail: Record<string, unknown> = {},
  opts: { correlationId?: string } = {}
): Promise<{ statements: D1PreparedStatement[]; eventId: string | null }> {
  const ctx = contextFor(db, opts.correlationId);
  if (!ctx) return { statements: [legacyStatement(db, actorId, action, target, detail)], eventId: null };
  try {
    return await kitAuditStatements(db, ctx, actorId, action, target, detail);
  } catch (e) {
    // A bus that cannot build its envelope never costs the audit row.
    console.error('audit event not built', action, e instanceof Error ? e.message : String(e));
    return { statements: [legacyStatement(db, actorId, action, target, detail)], eventId: null };
  }
}

/** Today's signature and today's failure behaviour: never throws into a caller. */
export async function audit(
  db: D1Database,
  actorId: string | null,
  action: string,
  target: string,
  detail: Record<string, unknown> = {}
): Promise<void> {
  try {
    const { statements, eventId } = await auditStatements(db, actorId, action, target, detail);
    if (statements.length === 1) await statements[0].run();
    else await db.batch(statements);
    pumpAfter(db, [eventId]);
  } catch (e) {
    console.error('audit write failed', action, e);
  }
}
