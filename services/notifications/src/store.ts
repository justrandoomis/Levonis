/**
 * The store: every table `levonis-notifications` reads or writes, in one module.
 *
 * ONE file on purpose — the list of tables a service touches is what
 * `tests/serviceBoundaries.test.ts` and every reviewer actually need to see,
 * and inside one deployable only a sibling's `statements.ts` may be imported
 * across package directories (ADR-004), which would otherwise put the reads out
 * of reach of `src/http/*`.
 *
 * The write half returns `D1PreparedStatement`s rather than executing them, so
 * an inbox row and the consumer's `notifications_processed_events` row go into
 * ONE `db.batch()` — the pattern `worker/lib/notifications.ts` `notifyStatement`
 * already uses, and the reason a redelivery cannot produce a second message.
 */
import type { NotifyDeliveryRow, NotifyDeliveryStatus } from '@levonis/contracts/http/notifications';
import type { NotificationChannel, NotificationInput, OutboxMessage, OutboxRow } from './types';

/**
 * The tables this service owns, as the runtime guard needs them. Declared in
 * TypeScript because the repo's tsconfig has no `resolveJsonModule`;
 * `test/boundaries.test.ts` fails the moment this list and `OWNERSHIP.json`
 * differ, so there is one source of truth and two spellings of it.
 */
export const NOTIFICATIONS_OWNS = ['notify_outbox', 'user_notifications', 'notify_deliveries', 'telegram_updates'] as const;

/** Notifications reads no other service's table: the events carry what a message needs. */
export const NOTIFICATIONS_READS: readonly string[] = [];

export const MAX_ATTEMPTS = 5;

export const newId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

// ------------------------------------------------------------------ inbox

/**
 * Enqueue, idempotent on `event_key` — `worker/lib/outbox.ts` `enqueue()` as a
 * STATEMENT, so it can ride in the same batch as the processed-events row
 * instead of racing it.
 *
 * `INSERT OR IGNORE` plus the UNIQUE index is the replay guard: a second
 * attempt with the same key is a no-op, not an error and not a duplicate.
 * `state: 'skipped'` records an event honestly WITHOUT sending it (the
 * unverified-recipient case), documenting why in `last_error`.
 */
export function enqueueStatement(
  db: D1Database,
  eventKey: string,
  message: OutboxMessage,
  opts: { id?: string; state?: 'pending' | 'skipped'; note?: string; at?: string } = {}
): { id: string; stmt: D1PreparedStatement } {
  const id = opts.id ?? newId('obx');
  const recipient = message.kind === 'email' ? message.to : String(message.chat_id);
  const stmt = db
    .prepare(
      `INSERT OR IGNORE INTO notify_outbox (id, kind, event_key, recipient, payload, state, last_error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')))`
    )
    .bind(id, message.kind, eventKey, recipient, JSON.stringify(message), opts.state ?? 'pending', (opts.note ?? '').slice(0, 500), opts.at ?? null);
  return { id, stmt };
}

/** The pump's work list: pending or failed rows that have not exhausted their attempts. */
export async function claimable(db: D1Database, limit = 10): Promise<OutboxRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, kind, event_key, recipient, payload, state, attempts, last_error, created_at, sent_at
         FROM notify_outbox
        WHERE state IN ('pending','failed') AND attempts < ?
        ORDER BY created_at
        LIMIT ?`
    )
    .bind(MAX_ATTEMPTS, limit)
    .all<OutboxRow>();
  return results ?? [];
}

/**
 * The claim: a compare-and-swap on `attempts`, so only one processor wins a
 * row. The `state` CHECK has no transient `sending` value — deliberately, as in
 * the core — so the attempt bump IS the claim; a crash mid-send leaves the row
 * `pending` with the attempt consumed and the next run retries it.
 */
export async function claim(db: D1Database, row: OutboxRow): Promise<boolean> {
  const res = await db
    .prepare("UPDATE notify_outbox SET attempts = attempts + 1 WHERE id = ? AND state IN ('pending','failed') AND attempts = ?")
    .bind(row.id, row.attempts)
    .run()
    .catch(() => null);
  return !!res && (res.meta.changes ?? 0) > 0;
}

export function markSentStatement(db: D1Database, id: string, at: string): D1PreparedStatement {
  return db.prepare("UPDATE notify_outbox SET state = 'sent', sent_at = ?, last_error = '' WHERE id = ?").bind(at, id);
}

export function markStateStatement(db: D1Database, id: string, state: OutboxRow['state'], error: string): D1PreparedStatement {
  return db.prepare('UPDATE notify_outbox SET state = ?, last_error = ? WHERE id = ?').bind(state, error.slice(0, 500), id);
}

/** Oldest unsent row's age in seconds — the §11.4 golden signal for this service. */
export async function outboxLagSeconds(db: D1Database, nowIso: string): Promise<number | null> {
  const row = await db
    .prepare("SELECT MIN(created_at) AS oldest FROM notify_outbox WHERE state IN ('pending','failed')")
    .first<{ oldest: string | null }>();
  if (!row?.oldest) return null;
  return Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(row.oldest)) / 1000));
}

// --------------------------------------------------------- in-app inbox

/**
 * `worker/lib/notifications.ts` `notifyStatement`, moved. Returned rather than
 * executed so a caller notifying twenty merchants does it in ONE round trip and
 * so the rows land in the same batch as the event that earned them.
 */
export function notifyStatement(db: D1Database, n: NotificationInput, at?: string): { id: string; stmt: D1PreparedStatement } {
  const id = newId('ntf');
  const stmt = db
    .prepare(
      `INSERT OR IGNORE INTO user_notifications
         (id, user_id, kind, title_ar, title_en, body_ar, body_en, link, entity_type, entity_id, meta, event_key, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')))`
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
      n.eventKey ?? '',
      at ?? null
    );
  return { id, stmt };
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
  read_at: string | null;
  created_at: string;
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
      `SELECT id, kind, title_ar, title_en, body_ar, body_en, link, entity_type, entity_id, read_at, created_at
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
  const row = await db.prepare('SELECT COUNT(*) AS n FROM user_notifications WHERE user_id = ? AND read_at IS NULL').bind(userId).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** Scoped to the owner IN SQL, so a guessed id belonging to someone else changes nothing. */
export async function markRead(db: D1Database, userId: string, id?: string): Promise<number> {
  const at = new Date().toISOString();
  const res = id
    ? await db.prepare('UPDATE user_notifications SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL').bind(at, userId, id).run()
    : await db.prepare('UPDATE user_notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').bind(at, userId).run();
  return res.meta.changes ?? 0;
}

// ----------------------------------------------------------- deliveries

export function deliveryStatement(
  db: D1Database,
  r: { id?: string; event_key: string; channel: NotificationChannel; template: string; status: NotifyDeliveryStatus; attempts: number; error: string | null; at: string; delivered_at?: string | null }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO notify_deliveries (id, event_key, channel, template, status, attempts, error, created_at, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (event_key, channel) DO UPDATE SET
         status       = excluded.status,
         attempts     = excluded.attempts,
         error        = excluded.error,
         delivered_at = excluded.delivered_at`
    )
    .bind(r.id ?? newId('nd'), r.event_key, r.channel, r.template, r.status, r.attempts, r.error, r.at, r.delivered_at ?? null);
}

export async function listDeliveries(
  db: D1Database,
  opts: { channel?: NotificationChannel; status?: NotifyDeliveryStatus; limit?: number; cursor?: string } = {}
): Promise<NotifyDeliveryRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.channel) {
    where.push('channel = ?');
    binds.push(opts.channel);
  }
  if (opts.status) {
    where.push('status = ?');
    binds.push(opts.status);
  }
  if (opts.cursor) {
    where.push('created_at < ?');
    binds.push(opts.cursor);
  }
  const { results } = await db
    .prepare(
      `SELECT id, event_key, channel, template, status, attempts, error, created_at, delivered_at
         FROM notify_deliveries
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC
        LIMIT ?`
    )
    .bind(...binds, limit)
    .all<NotifyDeliveryRow>();
  return results ?? [];
}

// ------------------------------------------------------ webhook ingress

/**
 * Telegram redelivers an update until it is acknowledged, so the dedup is the
 * primary key. Returns false when this update has been seen before.
 */
export async function recordUpdate(db: D1Database, updateId: number, at: string): Promise<boolean> {
  const res = await db
    .prepare('INSERT OR IGNORE INTO telegram_updates (update_id, received_at) VALUES (?, ?)')
    .bind(updateId, at)
    .run()
    .catch(() => null);
  return !!res && (res.meta.changes ?? 0) > 0;
}

/**
 * THE RETENTION ROLL (`03-EVENTS.md` §5 rule 6).
 *
 * WHAT IS NOT ROLLED, and why it matters more than what is:
 *
 *  - `notify_outbox`. Its `event_key UNIQUE` IS the "one delivery per key,
 *    forever" guarantee this service is built on. Deleting a row there would
 *    let the same business event mail the same person a second time, which is
 *    the one failure the whole outbox exists to prevent.
 *  - `user_notifications`. A customer's inbox is theirs, not a log.
 *  - anything not yet settled, and `dead` rows: a `dead` delivery is what an
 *    operator still has to answer for.
 *
 * WHAT ROLLS: the settled DELIVERY LOG (history, reconstructible from nothing
 * and needed by nobody after the window), the Telegram update dedup set (the
 * platform stops redelivering an update in minutes, never in weeks), and the
 * bus's processed-events markers, whose window has to stay far longer than any
 * redelivery — the bus dead-letters after eight attempts and about two hours.
 */
export function pruneDeliveryLogStatement(db: D1Database, beforeIso: string, limit = 1000): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM notify_deliveries
        WHERE rowid IN (
          SELECT rowid FROM notify_deliveries
           WHERE status IN ('sent','dropped') AND created_at < ?
           LIMIT ?
        )`
    )
    .bind(beforeIso, limit);
}

export function pruneTelegramUpdatesStatement(db: D1Database, beforeIso: string, limit = 1000): D1PreparedStatement {
  return db
    .prepare('DELETE FROM telegram_updates WHERE rowid IN (SELECT rowid FROM telegram_updates WHERE received_at < ? LIMIT ?)')
    .bind(beforeIso, limit);
}
