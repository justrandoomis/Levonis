/** Append-only audit trail for sensitive admin/financial mutations. */
export async function audit(
  db: D1Database,
  actorId: string | null,
  action: string,
  target: string,
  detail: Record<string, unknown> = {}
): Promise<void> {
  try {
    await db
      .prepare('INSERT INTO audit_log (actor_id, action, target, detail) VALUES (?, ?, ?, ?)')
      .bind(actorId, action, target, JSON.stringify(detail).slice(0, 4000))
      .run();
  } catch (e) {
    console.error('audit write failed', action, e);
  }
}
