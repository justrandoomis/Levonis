/**
 * alwaseet_status_id -> internal_order_stage, as a table the owner controls.
 *
 * WHY A TABLE AND NOT A CONSTANT. "اجلب قائمة الحالات الرسمية من GET
 * /v1/merchant/statuses ولا تعتمد على نصوص hardcoded إذا كانت الـAPI توفر
 * status IDs." A courier adds statuses, renames them, and reorders their ids
 * between releases. A switch statement in this repo would need a deploy every
 * time; a table needs an owner ticking a box.
 *
 * AN UNMAPPED STATUS DOES NOTHING. That is the whole safety property. A
 * courier status nobody has mapped yet leaves the order exactly where it is —
 * it does not fall through to a default, does not guess from the text, and
 * does not mark anything delivered. The status is still RECORDED on the order
 * so the admin can see what the courier said and map it.
 */

/** One row of the courier's list, plus whatever the owner mapped it to. */
export interface StatusMapping {
  provider: string;
  remote_id: string;
  remote_text: string;
  /** '' means unmapped — the sync must leave such an order alone. */
  internal_stage: string;
  updated_at: string;
}

/**
 * Records the courier's official list without touching the owner's mappings.
 *
 * The remote text is refreshed (a courier may reword a status) but
 * internal_stage is left alone on rows that already exist: re-fetching the
 * list must never silently unmap a status the owner mapped weeks ago.
 */
export async function upsertRemoteStatuses(
  db: D1Database,
  provider: string,
  statuses: Array<{ id: string; text: string }>,
  now: string
): Promise<{ added: number; refreshed: number }> {
  if (statuses.length === 0) return { added: 0, refreshed: 0 };
  const { results: existing } = await db
    .prepare('SELECT remote_id FROM delivery_status_map WHERE provider = ?')
    .bind(provider)
    .all<{ remote_id: string }>();
  const known = new Set((existing ?? []).map((r) => r.remote_id));

  await db.batch(
    statuses.map((s) =>
      db.prepare(
        `INSERT INTO delivery_status_map (provider, remote_id, remote_text, internal_stage, updated_at)
         VALUES (?, ?, ?, '', ?)
         ON CONFLICT(provider, remote_id) DO UPDATE SET remote_text = excluded.remote_text, updated_at = excluded.updated_at`
      ).bind(provider, s.id, s.text, now)
    )
  );
  const added = statuses.filter((s) => !known.has(s.id)).length;
  return { added, refreshed: statuses.length - added };
}

export async function listStatusMap(db: D1Database, provider: string): Promise<StatusMapping[]> {
  const { results } = await db
    .prepare('SELECT * FROM delivery_status_map WHERE provider = ? ORDER BY CAST(remote_id AS INTEGER), remote_id')
    .bind(provider)
    .all<StatusMapping>();
  return results ?? [];
}

/** The stage a courier status means, or null when nobody has mapped it. */
export async function stageForRemoteStatus(
  db: D1Database,
  provider: string,
  remoteId: string
): Promise<string | null> {
  const row = await db
    .prepare('SELECT internal_stage FROM delivery_status_map WHERE provider = ? AND remote_id = ?')
    .bind(provider, remoteId)
    .first<{ internal_stage: string }>();
  const stage = row?.internal_stage ?? '';
  return stage === '' ? null : stage;
}

export async function setStatusMapping(
  db: D1Database,
  provider: string,
  remoteId: string,
  internalStage: string,
  now: string
): Promise<void> {
  // A row may not exist yet when the owner maps a status seen on a live order
  // before the official list has been fetched.
  await db
    .prepare(
      `INSERT INTO delivery_status_map (provider, remote_id, remote_text, internal_stage, updated_at)
       VALUES (?, ?, '', ?, ?)
       ON CONFLICT(provider, remote_id) DO UPDATE SET internal_stage = excluded.internal_stage, updated_at = excluded.updated_at`
    )
    .bind(provider, remoteId, internalStage, now)
    .run();
}
