/**
 * Every Print Cloud act involving money, stock, credits, refunds, balances,
 * printer control, order status or prices writes an `audit_log` row IN THE
 * SAME BATCH as the act (worker/lib/audit.ts `auditStatements`), so a write
 * can never land unaudited. Actions are namespaced `print_cloud.*`.
 */
import { auditStatements } from '../audit';
import type { Stmt } from './db';

export async function pcAudit(
  db: D1Database,
  actorId: string | null,
  action: string,
  target: string,
  detail: Record<string, unknown> = {}
): Promise<Stmt[]> {
  const { statements } = await auditStatements(db, actorId && actorId !== 'system' ? actorId : null, `print_cloud.${action}`, target, detail);
  return statements;
}
