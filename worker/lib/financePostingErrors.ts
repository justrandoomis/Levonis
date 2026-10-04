import { operationsInstalled } from './operations';

/** Committed source operations keep a durable retry when a projection fails. */
export async function recordFinancialFailure(db: D1Database, orderId: string, event: string, error: unknown) {
  if (!await operationsInstalled(db)) return;
  await db.prepare(`INSERT INTO finance_posting_errors(event_key,order_id,message,last_attempt_at)
    VALUES (?,?,?,?) ON CONFLICT(event_key) DO UPDATE SET message=excluded.message,last_attempt_at=excluded.last_attempt_at`)
    .bind(`${event}:${orderId}`, orderId, (error instanceof Error ? error.message : String(error)).slice(0, 500), new Date().toISOString())
    .run();
}
