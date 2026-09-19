/**
 * IN-APP NOTIFICATIONS — telling a user something inside the site.
 *
 * WHY THIS IS NEW. The codebase had no way to do this. `outbox` (0003) sends
 * email and Telegram; `merchant_notification_preferences` (0030) stores nine
 * switches that nothing reads; `chat_participants.last_read_at` is the only
 * unread marker anywhere. None of that can carry "a request that suits your
 * shop was posted — here it is", which is the message this whole feature turns
 * on. So this is the missing general mechanism, deliberately not print-specific.
 *
 * THREE DECISIONS THAT SHAPE IT:
 *
 *  - THE TEXT IS STORED PER LANGUAGE, not pre-rendered. A notification read next
 *    month must be in the language the reader is using then, not the one that
 *    happened to be active when it was written.
 *
 *  - THE LINK IS A PATH, never an absolute URL. A stored origin is a stored
 *    mistake waiting for the day the domain changes.
 *
 *  - REPLAY IS THE DATABASE'S PROBLEM, not the caller's. `event_key` is unique
 *    per user, so telling the same merchant about the same request twice is
 *    impossible rather than merely unlikely — and "no duplicates" is the exact
 *    property the owner asked this feature to have.
 */

import { newId } from './crypto';

/**
 * `user_notifications.kind` and `.entity_type` are bare TEXT with no CHECK
 * (0045), so these two unions are the ONLY thing that decides what may be
 * written. That is why a new sender has to appear in BOTH of them and why
 * neither is a formality: TypeScript is the whole constraint.
 */
export type NotificationKind =
  | 'print_request_match'
  | 'offer_received'
  | 'offer_accepted'
  | 'order_update'
  | 'review_reward_pending'
  /**
   * «رجع المنتج» — the back-in-stock sweep (0092, worker/lib/stockAlerts.ts)
   * telling a customer the thing they armed an alert on is buyable again.
   */
  | 'stock_back'
  /**
   * «رد من الدعم» — staff answered a support ticket
   * (worker/lib/engagementNotify.ts). Added because the ticket conversation had
   * NO notification of any kind: a customer learned that support had replied
   * only by opening the site and looking, while a sheet on the site offered to
   * send them exactly that news on WhatsApp or Telegram.
   */
  | 'support_reply';

export interface NotificationInput {
  userId: string;
  kind: NotificationKind;
  title_ar: string;
  title_en: string;
  body_ar?: string;
  body_en?: string;
  /** In-app path, e.g. `/requests?request=req_123`. */
  link: string;
  /**
   * WIDENED WITH `kind`, NEVER AFTER IT. `notifyStatement` writes
   * `n.entity_type ?? ''`, so a sender whose kind compiles but whose entity
   * type does not has exactly one way out: drop the field and store ''. The row
   * still arrives, still reads correctly, and has permanently lost the join
   * back to what it is about — which for a stock alert is the product the
   * customer is being told to go and buy. 'product' is here because
   * 'stock_back' is above.
   */
  entity_type?: 'request' | 'offer' | 'order' | 'review' | 'product' | 'ticket' | '';
  entity_id?: string;
  meta?: Record<string, unknown>;
  /** Unique per user. Empty means "no replay protection wanted". */
  eventKey?: string;
}

export interface NotificationRow {
  id: string;
  kind: string;
  title_ar: string;
  title_en: string;
  body_ar: string;
  body_en: string;
  link: string;
  entity_type: string;
  entity_id: string;
  meta: string;
  read_at: string | null;
  created_at: string;
}

/**
 * The statement that creates one notification, ready for a `db.batch`.
 *
 * Returned rather than executed so a caller notifying twenty merchants does it
 * in ONE round trip, and so the notifications land in the same batch as the
 * audit rows that explain them — either both or neither.
 *
 * `INSERT OR IGNORE` plus the unique index is the replay guard: a second
 * attempt with the same event key is a no-op, not an error and not a duplicate.
 */
export function notifyStatement(db: D1Database, n: NotificationInput): { id: string; stmt: D1PreparedStatement } {
  const id = newId('ntf');
  const stmt = db
    .prepare(
      `INSERT OR IGNORE INTO user_notifications
         (id, user_id, kind, title_ar, title_en, body_ar, body_en, link,
          entity_type, entity_id, meta, event_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .bind(
      id,
      n.userId,
      n.kind,
      n.title_ar,
      n.title_en,
      n.body_ar ?? '',
      n.body_en ?? '',
      n.link,
      n.entity_type ?? '',
      n.entity_id ?? '',
      JSON.stringify(n.meta ?? {}),
      n.eventKey ?? ''
    );
  return { id, stmt };
}

/** The single-notification convenience. Never throws: a notification that
 *  cannot be written must not undo the business event that earned it. */
export async function notify(db: D1Database, n: NotificationInput): Promise<string | null> {
  try {
    const { id, stmt } = notifyStatement(db, n);
    const res = await stmt.run();
    return res.meta.changes > 0 ? id : null;
  } catch (e) {
    console.error(`notification not written (${n.kind}): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export async function listNotifications(
  db: D1Database,
  userId: string,
  opts: { limit?: number; before?: string; unreadOnly?: boolean } = {}
): Promise<NotificationRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const clauses = ['user_id = ?'];
  const binds: unknown[] = [userId];
  if (opts.unreadOnly) clauses.push('read_at IS NULL');
  if (opts.before) {
    clauses.push('created_at < ?');
    binds.push(opts.before);
  }
  const { results } = await db
    .prepare(
      `SELECT id, kind, title_ar, title_en, body_ar, body_en, link, entity_type,
              entity_id, meta, read_at, created_at
         FROM user_notifications
        WHERE ${clauses.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT ?`
    )
    .bind(...binds, limit)
    .all<NotificationRow>();
  return results ?? [];
}

export async function unreadCount(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = ? AND read_at IS NULL')
    .bind(userId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** Marks one notification, or all of them, read. Scoped to the owner in SQL so
 *  a guessed id belonging to someone else changes nothing. */
export async function markRead(db: D1Database, userId: string, id?: string): Promise<number> {
  const sql = id
    ? `UPDATE user_notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE user_id = ? AND id = ? AND read_at IS NULL`
    : `UPDATE user_notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE user_id = ? AND read_at IS NULL`;
  const stmt = id ? db.prepare(sql).bind(userId, id) : db.prepare(sql).bind(userId);
  const res = await stmt.run();
  return res.meta.changes ?? 0;
}
