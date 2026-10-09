/**
 * A planned FX batch (commit.ts) as D1 statements: each fence as its two
 * `ops_guards` statements (worker/lib/operations.ts), each audit row through
 * `auditStatements` — ids and codes only — appended in the same batch, so a
 * write cannot succeed unaudited.
 */
import { auditStatements } from '../audit';
import { fence } from '../operations';
import type { PlannedBatch } from './commit';

export async function toStatements(db: D1Database, plan: PlannedBatch, actorId: string | null): Promise<D1PreparedStatement[]> {
  const out: D1PreparedStatement[] = [];
  for (const s of plan.statements) {
    if (s.kind === 'fence') out.push(...fence(db, s.condition, s.params));
    else out.push(db.prepare(s.sql).bind(...s.params));
  }
  for (const a of plan.audits) out.push(...(await auditStatements(db, actorId, a.action, a.target, a.detail)).statements);
  return out;
}
