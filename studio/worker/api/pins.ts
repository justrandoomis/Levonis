/**
 * Revision pins (P1-09; GAP-MAP conflict 19).
 *
 * A pinned revision is held by something outside the editor — a print
 * request, an order, or the owner's own "keep this version" — and the cleanup
 * cron must therefore NEVER prune or purge it (worker/api/cleanup.ts asks
 * `isRevisionPinned` before deleting anything, and the foreign key from
 * project_revision_pins makes the database refuse the delete as well).
 *
 * Storage is the `project_revision_pins` side table (db/schema.ts): one row
 * per holder, keyed (revision_id, pin_reason, pin_ref), so releasing one
 * holder never unpins a revision another holder still needs.
 *
 * Who pins:
 *   - 'user'    — the owner, through POST /api/projects/:id/revisions/:rev/pin
 *                 (and only this reason can be released by the owner);
 *   - 'request' / 'order' — server code only (the P1-11 Studio → request
 *                 handoff calls `pinRevision` after it commits the revision
 *                 it hands over). There is no client route that can create
 *                 or release these.
 *
 * Only a COMMITTED revision of a live (not soft-deleted) project owned by the
 * caller can be pinned: a pending upload is not a version anyone can hold.
 */
import { ensureStudioTables, newId, nowIso } from "./router";

export const PIN_REASONS = ["user", "request", "order"] as const;
export type PinReason = (typeof PIN_REASONS)[number];

export function isPinReason(value: unknown): value is PinReason {
  return typeof value === "string" && (PIN_REASONS as readonly string[]).includes(value);
}

/** Holder ids are opaque ids from the holder's own system; keep them tame. */
const PIN_REF_RE = /^[A-Za-z0-9_:.-]{1,128}$/;

export type PinResult =
  | { ok: true; pinned_at: string; already: boolean }
  | { ok: false; code: "NOT_FOUND" | "NOT_COMMITTED" | "BAD_PIN" };

/**
 * Pins one revision for one holder. Idempotent per (revision, reason, ref):
 * pinning twice keeps the first pinned_at. Ownership is enforced in SQL — a
 * revision of someone else's project answers NOT_FOUND, never a pin.
 */
export async function pinRevision(
  db: D1Database,
  input: { ownerId: string; projectId: string; revisionId: string; reason: PinReason; ref?: string }
): Promise<PinResult> {
  if (!isPinReason(input.reason)) return { ok: false, code: "BAD_PIN" };
  const ref = input.reason === "user" ? "" : (input.ref ?? "");
  if (input.reason !== "user" && !PIN_REF_RE.test(ref)) return { ok: false, code: "BAD_PIN" };
  // Server callers outside the API router (the P1-11 handoff) must not meet a
  // database the 0001 migration has not reached: the bootstrap is idempotent.
  await ensureStudioTables(db);

  const row = await db
    .prepare(
      `SELECT r.state FROM project_revisions r JOIN projects p ON p.id = r.project_id
        WHERE r.id = ? AND r.project_id = ? AND p.owner_id = ? AND p.deleted_at IS NULL`
    )
    .bind(input.revisionId, input.projectId, input.ownerId)
    .first<{ state: string }>();
  if (!row) return { ok: false, code: "NOT_FOUND" };
  if (row.state !== "committed") return { ok: false, code: "NOT_COMMITTED" };

  const now = nowIso();
  const insert = await db
    .prepare(
      `INSERT OR IGNORE INTO project_revision_pins (id, revision_id, pinned_at, pin_reason, pin_ref)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(newId(), input.revisionId, now, input.reason, ref)
    .run();
  if (insert.meta.changes) return { ok: true, pinned_at: now, already: false };
  const existing = await db
    .prepare(`SELECT pinned_at FROM project_revision_pins WHERE revision_id = ? AND pin_reason = ? AND pin_ref = ?`)
    .bind(input.revisionId, input.reason, ref)
    .first<{ pinned_at: string }>();
  return { ok: true, pinned_at: existing?.pinned_at ?? now, already: true };
}

/**
 * Releases ONE holder's pin. The revision stays pinned while any other holder
 * remains. Ownership is enforced the same way as pinRevision.
 */
export async function unpinRevision(
  db: D1Database,
  input: { ownerId: string; projectId: string; revisionId: string; reason: PinReason; ref?: string }
): Promise<{ ok: true; released: boolean } | { ok: false; code: "NOT_FOUND" | "BAD_PIN" }> {
  if (!isPinReason(input.reason)) return { ok: false, code: "BAD_PIN" };
  const ref = input.reason === "user" ? "" : (input.ref ?? "");
  await ensureStudioTables(db);
  const owned = await db
    .prepare(
      `SELECT 1 AS x FROM project_revisions r JOIN projects p ON p.id = r.project_id
        WHERE r.id = ? AND r.project_id = ? AND p.owner_id = ?`
    )
    .bind(input.revisionId, input.projectId, input.ownerId)
    .first();
  if (!owned) return { ok: false, code: "NOT_FOUND" };
  const res = await db
    .prepare(`DELETE FROM project_revision_pins WHERE revision_id = ? AND pin_reason = ? AND pin_ref = ?`)
    .bind(input.revisionId, input.reason, ref)
    .run();
  return { ok: true, released: Boolean(res.meta.changes) };
}

/** True while ANY holder pins the revision (the cleanup cron's guard). */
export async function isRevisionPinned(db: D1Database, revisionId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS x FROM project_revision_pins WHERE revision_id = ? LIMIT 1`)
    .bind(revisionId)
    .first();
  return Boolean(row);
}

/**
 * revision id → the pin reasons holding it (owner-facing: reasons only, never
 * the holders' ids). Callers pass ids they already resolved under ownership.
 * A reason this build does not know yet (a later holder) is still reported —
 * the revision IS pinned, and hiding that would be the dishonest answer.
 */
export async function pinReasonsFor(db: D1Database, revisionIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const CHUNK = 50;
  for (let i = 0; i < revisionIds.length; i += CHUNK) {
    const chunk = revisionIds.slice(i, i + CHUNK);
    if (chunk.length === 0) continue;
    const { results } = await db
      .prepare(
        `SELECT revision_id, pin_reason FROM project_revision_pins
          WHERE revision_id IN (${chunk.map(() => "?").join(",")}) ORDER BY pinned_at`
      )
      .bind(...chunk)
      .all<{ revision_id: string; pin_reason: string }>();
    for (const row of results || []) {
      const list = out.get(row.revision_id) ?? [];
      if (!list.includes(row.pin_reason)) list.push(row.pin_reason);
      out.set(row.revision_id, list);
    }
  }
  return out;
}
