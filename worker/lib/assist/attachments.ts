/**
 * THE ASSISTANT CHAT'S PHOTOS, CLIPS AND VOICE NOTES, HANDED TO A TICKET
 * (support assistant v2, push A; migration 0209).
 *
 * The customer attaches them in the assistant chat before any ticket exists,
 * so the upload route files them under the UPLOADER: `assist/<uid>/<folder>/…`
 * (worker/routes/uploads.ts, purpose `assist`). «تحدث مع الفريق» then sends the
 * keys with the ticket, and this module decides which of them the ticket may
 * take:
 *
 *   - at most `ASSIST_ATTACH_MAX`, each a safe media key;
 *   - under THIS user's own prefix, so nobody can hand a ticket another
 *     customer's file (the `/files` gate would then show it to staff);
 *   - in one of the three folders the upload route writes, which also names
 *     the kind (no client claim decides between <img>, <video> and <audio>);
 *   - actually stored (an R2 HEAD), the way a ticket message's key is checked;
 *   - held against the media cleanup first (`protectMediaObjectFromCleanup`),
 *     so the drain cannot delete a week-old key between that HEAD and the row
 *     that names it: the cleanup either sees the protection and leaves the
 *     key, or holds its claim and the ticket door refuses the key by name.
 *
 * Mime and size come from the uploader's own ledger row (`file_objects`),
 * falling back to the HEAD's size. Nothing here reads the bytes and nothing
 * analyses them: there is no AI in this push.
 */
import { badRequest } from '../http';
import { headMediaObject, isSafeMediaKey } from '../mediaStorage';
import { protectMediaObjectFromCleanup } from '../productDeletion';
import { tableColumns } from '../schemaColumns';
import type { Env } from '../types';

export const ASSIST_ATTACH_MAX = 6;

export type AssistAttachmentKind = 'image' | 'video' | 'audio';

const FOLDER_KIND: Readonly<Record<string, AssistAttachmentKind>> = {
  attachments: 'image',
  video: 'video',
  audio: 'audio',
};

export interface CheckedAttachment {
  key: string;
  kind: AssistAttachmentKind;
  mime: string;
  bytes: number;
}

/** The kind a stored key is, read from its folder; null for any other shape. */
export function assistKindOf(key: string): AssistAttachmentKind | null {
  const parts = key.split('/');
  if (parts.length !== 4 || parts[0] !== 'assist') return null;
  return FOLDER_KIND[parts[2] ?? ''] ?? null;
}

/**
 * The keys a ticket body names, checked for shape and ownership (no I/O).
 * Throws the refusal the form shows; an absent list is no attachments.
 */
export function readAttachmentKeys(raw: unknown, userId: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest('Invalid attachments', 'ATTACHMENT_INVALID');
  if (raw.length > ASSIST_ATTACH_MAX) {
    throw badRequest(`At most ${ASSIST_ATTACH_MAX} attachments`, 'ATTACHMENT_LIMIT', { limit: ASSIST_ATTACH_MAX });
  }
  const keys: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !isSafeMediaKey(item)) throw badRequest('Invalid file reference', 'ATTACHMENT_INVALID');
    if (!item.startsWith(`assist/${userId}/`)) throw badRequest('That file is not yours to attach', 'ATTACHMENT_NOT_YOURS');
    if (!assistKindOf(item)) throw badRequest('Invalid file reference', 'ATTACHMENT_INVALID');
    if (!keys.includes(item)) keys.push(item);
  }
  return keys;
}

/** How long a key handed to a ticket is held against the cleanup: the ticket's batch commits well within it. */
export const ASSIST_ATTACH_PROTECT_MINUTES = 15;

/**
 * THE TICKET DOOR COOPERATES WITH THE CLEANUP (worker/lib/productDeletion.ts).
 * Each key is protected before it is checked and linked. A key the drain has
 * already claimed is being deleted: refused as not uploaded, never linked to
 * a ticket that would then point at nothing. A database without the guard
 * table (before 0099) has no cooperating cleanup either, and passes.
 */
async function holdAgainstCleanup(db: D1Database, keys: readonly string[]): Promise<void> {
  for (const key of keys) {
    let held: boolean;
    try {
      held = await protectMediaObjectFromCleanup(db, key, ASSIST_ATTACH_PROTECT_MINUTES);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not installed|no such table/i.test(message)) return;
      throw error;
    }
    if (!held) throw badRequest('That attachment was not uploaded — attach it again', 'ATTACHMENT_NOT_FOUND');
  }
}

/** Each key is a stored object; its mime and size from the uploader's ledger row. */
export async function checkStoredAttachments(
  env: Pick<Env, 'DB'> & Parameters<typeof headMediaObject>[0],
  userId: string,
  keys: readonly string[]
): Promise<CheckedAttachment[]> {
  if (!keys.length) return [];
  await holdAgainstCleanup(env.DB, keys);
  const heads = await Promise.all(keys.map((key) => headMediaObject(env, 'private', key)));
  heads.forEach((head) => {
    if (!head) throw badRequest('That attachment was not uploaded — attach it again', 'ATTACHMENT_NOT_FOUND');
  });
  const ledger = new Map<string, { mime_type: string; byte_size: number }>();
  try {
    const { results } = await env.DB.prepare(
      `SELECT object_key, mime_type, byte_size FROM file_objects
        WHERE owner_id = ? AND deleted_at IS NULL AND object_key IN (${keys.map(() => '?').join(', ')})`
    )
      .bind(userId, ...keys)
      .all<{ object_key: string; mime_type: string; byte_size: number }>();
    for (const row of results ?? []) ledger.set(row.object_key, row);
  } catch {
    // A ledger that cannot be read leaves the HEAD's size and an empty type.
  }
  return keys.map((key, i) => {
    const row = ledger.get(key);
    const head = heads[i] as { size?: number } | null;
    return {
      key,
      kind: assistKindOf(key)!,
      mime: String(row?.mime_type ?? '').slice(0, 100),
      bytes: Math.max(0, Number(row?.byte_size ?? head?.size ?? 0) || 0),
    };
  });
}

/**
 * ONE statement for every row, and only onto the ticket THIS REQUEST created,
 * for THIS user:
 *
 *   - if the derived ticket id ever belonged to someone else (the collision
 *     the ticket door refuses by name), not a row is written under it;
 *   - an idempotent REPLAY (the same key sent again) finds the ticket the
 *     first request wrote, at that request's `created_at`, so the guard is
 *     false and nothing is added: a hand-built replay can neither pass the
 *     six-file limit nor slip files onto a ticket staff have since resolved,
 *     unannounced. `createdAt` is the instant this request wrote into the
 *     ticket row of the same batch;
 *   - and never onto a ticket that already holds files.
 */
export function attachmentInsert(
  db: D1Database,
  ticketId: string,
  userId: string,
  rows: readonly CheckedAttachment[],
  createdAt: string
): D1PreparedStatement | null {
  if (!rows.length) return null;
  const values: unknown[] = [ticketId, userId, createdAt];
  const tuples = rows.map((row, i) => {
    const base = values.length;
    values.push(row.key, row.kind, row.mime, row.bytes, i);
    return `(?${base + 1}, ?${base + 2}, ?${base + 3}, ?${base + 4}, ?${base + 5})`;
  });
  return db
    .prepare(
      `INSERT INTO support_ticket_attachments (ticket_id, file_key, kind, mime_type, byte_size, position)
       SELECT ?1, column1, column2, column3, column4, column5 FROM (VALUES ${tuples.join(', ')})
        WHERE EXISTS (SELECT 1 FROM support_tickets WHERE id = ?1 AND user_id = ?2 AND created_at = ?3)
          AND NOT EXISTS (SELECT 1 FROM support_ticket_attachments held WHERE held.ticket_id = ?1)
       ON CONFLICT (ticket_id, file_key) DO NOTHING`
    )
    .bind(...values);
}

export interface PublicAttachment {
  kind: AssistAttachmentKind;
  /** `/files/<key>`, composed here; the key itself is never handed out as data. */
  file_url: string;
  mime: string;
  bytes: number;
  created_at: string;
}

/** A ticket's attachments, oldest first; none on a database before 0209. */
export async function ticketAttachments(db: D1Database, ticketId: string): Promise<PublicAttachment[]> {
  try {
    const { results } = await db
      .prepare(
        `SELECT file_key, kind, mime_type, byte_size, created_at FROM support_ticket_attachments
          WHERE ticket_id = ? ORDER BY position ASC, created_at ASC LIMIT ${ASSIST_ATTACH_MAX * 2}`
      )
      .bind(ticketId)
      .all<{ file_key: string; kind: string; mime_type: string; byte_size: number; created_at: string }>();
    return (results ?? [])
      .filter((r) => isSafeMediaKey(r.file_key) && assistKindOf(r.file_key))
      .map((r) => ({
        kind: assistKindOf(r.file_key)!,
        file_url: `/files/${r.file_key}`,
        mime: String(r.mime_type ?? ''),
        bytes: Number(r.byte_size) || 0,
        created_at: String(r.created_at ?? ''),
      }));
  } catch {
    return [];
  }
}

/** An assistant attachment no ticket took is kept this long, then queued for deletion. */
export const ASSIST_RETENTION_DAYS = 7;

/**
 * THE RETENTION SWEEP'S HALF (worker/lib/jobs.ts `assist_retention`).
 *
 * Queues — never deletes — the `assist/` objects older than the retention
 * window that no ticket names, on the same `media_cleanup_jobs` queue every
 * other cleanup uses. The guarded drain (`runGuardedMediaCleanup`) rebuilds
 * the full reference set before it touches the bucket, and
 * `support_ticket_attachments.file_key` is registered there
 * (worker/lib/mediaRefs.ts), so a key handed to a ticket after it was queued
 * survives as `skipped_shared`. A key already queued once, in any state, is
 * not queued again. Bounded per run; a database before 0209 is skipped.
 */
export async function queueUnattachedAssistMedia(db: D1Database, limit = 50): Promise<{ queued: number; skipped: boolean }> {
  const cols = await tableColumns(db, 'support_ticket_attachments');
  if (!cols || cols.size === 0) return { queued: 0, skipped: true };
  const r = await db
    .prepare(
      `INSERT OR IGNORE INTO media_cleanup_jobs (id, object_key, visibility, reason, source_product_id)
       SELECT 'mcj_' || lower(hex(randomblob(12))), f.object_key, 'private', 'assist_unattached', ''
         FROM file_objects f
        WHERE f.domain = 'assist' AND f.deleted_at IS NULL AND f.created_at < datetime('now', ?1)
          AND NOT EXISTS (SELECT 1 FROM support_ticket_attachments a WHERE a.file_key = f.object_key)
          AND NOT EXISTS (SELECT 1 FROM media_cleanup_jobs j WHERE j.object_key = f.object_key)
        LIMIT ?2`
    )
    .bind(`-${ASSIST_RETENTION_DAYS} days`, limit)
    .run();
  return { queued: Number(r.meta?.changes ?? 0), skipped: false };
}
