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
  /**
   * «ورشة تريد عرض قطعتك» — a workshop asks a customer's permission to show
   * their part in its portfolio, and the customer's answer back (0153).
   */
  | 'portfolio_consent'
  | 'print_request_match'
  | 'offer_received'
  | 'offer_accepted'
  /**
   * «تغيّر الطلب» — the customer changed a published request (a re-publish
   * with a different spec, an attachment added or removed), so a merchant's
   * pending offer now prices a job that no longer exists. The offer is held
   * until they re-confirm or withdraw it (worker/lib/communityRequests.ts).
   */
  | 'offer_stale'
  | 'order_update'
  | 'review_reward_pending'
  /**
   * «وصلتك هدية» — an admin granted the customer a gift, or approved a review
   * reward as one (worker/lib/gifts/grant.ts). The link opens /gifts.
   */
  | 'gift_granted'
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
  | 'support_reply'
  /**
   * «الشكاوى» — an admin answered a complaint
   * (worker/routes/adminCommunity.ts). Added for the same reason
   * `support_reply` was, one surface over: `community_complaint_messages` had
   * no INSERT anywhere in the repository, and when one was added there was
   * still NO customer-facing screen that reads that table. A reply written
   * into a thread the reporter cannot open is not an answer, so this row is
   * where they actually read it — behind their own login, carrying the text.
   */
  | 'complaint_reply'
  /**
   * «رد من فريق الضمان» — staff wrote in a warranty claim's thread
   * (worker/routes/devices.ts → worker/lib/engagementNotify.ts). Added for the
   * owner's own sentence: «لا يرسل الإشعار إلى المستخدم بأن هناك رسالة جديدة
   * تخص الضمان». The claim thread had the same silence the ticket thread had
   * before `support_reply`: the ADMIN group heard every customer reply, and
   * the customer heard nothing back.
   */
  | 'warranty_reply'
  /**
   * «تحديث على مطالبة الضمان» — the claim moved a stage (diagnosing, a
   * decision, repair, replacement, closed). A decision with its reason is the
   * one message a claimant is waiting for, and the admin queue recorded it in
   * the audit log and nowhere the claimant could see without looking.
   */
  | 'warranty_stage'
  /**
   * «رسالة جديدة» — a message in a merchant-store order's thread, told to the
   * OTHER side of it: the seller when the customer writes, the customer when
   * the seller answers (worker/routes/chats.ts). A customer's question on a
   * store order used to reach nobody at all (audit 04 B10).
   */
  | 'chat_message'
  /**
   * «الاستبدال» — a trade-in request moved (submitted, valued, a new value
   * waiting for the customer's decision, ready to pay, completed, cancelled).
   * worker/lib/tradeIn.ts; the link opens the request at /trade-in.
   */
  | 'trade_in'
  /**
   * THE MERCHANT'S KINDS (docs/MERCHANT_PLATFORM.md §4.8, stream W2-E). Each
   * is written by worker/lib/merchantNotify.ts from the real event it names,
   * links to its object's workspace address (packages/contracts/src/
   * merchantRoutes.ts), and is what makes a row the STORE's: the merchant
   * notification centre lists exactly these kinds (`MERCHANT_KINDS`).
   */
  | 'new_order'
  | 'order_needs_action'
  /** «لم يُختر عرضك» — a rival was accepted, the customer declined, or cancelled (W5-A). */
  | 'offer_rejected'
  | 'new_message'
  | 'matching_request'
  | 'low_stock'
  | 'new_review'
  | 'dispute_opened'
  | 'payout_available'
  | 'payout_paid'
  /** «تعذّر تحويل طلب السحب» — an admin failed a payout; the amount is back in «متاح» (review F11). */
  | 'payout_failed'
  /** «رصيدك سالب» — a claw-back left the merchant's available balance below zero (review F11). */
  | 'balance_reversed'
  /** «قرّرت Levonis النزاع» — an admin decided a disputed custom order's escrow (review F4). */
  | 'dispute_resolved'
  | 'coupon_ending'
  | 'store_status_changed'
  /**
   * THE SOCIAL KINDS (0154; docs/COMMUNITY_ECOSYSTEM.md Phase 2), written by
   * `notifyGrouped` and never by `notify`: a burst of likes is ONE row whose
   * count climbs («أعجب 12 شخصًا بمشروعك»), not twelve rows. Saves are private
   * and never notify.
   */
  | 'post_liked'
  | 'post_commented'
  | 'comment_replied'
  | 'new_follower'
  /**
   * THE FILE KINDS (0158; docs/COMMUNITY_ECOSYSTEM.md §9.4 "Grouped file
   * notifications"), both grouped by `notifyGrouped` and never by `notify`:
   * «أرسل أحمد ملفات» to the other side of a conversation
   * (`files_added:<chatId>`, worker/routes/chats.ts) and «أضاف سارة ملفات إلى
   * الطلب» to the workshops matched to a request (`request_files:<requestId>`,
   * worker/routes/marketplace.ts). A burst of attachments is ONE row per
   * recipient whose count is PEOPLE, exactly as a burst of likes is.
   */
  | 'files_added'
  | 'request_files'
  /**
   * THE DISCUSSION KINDS (0160; docs/COMMUNITY_ECOSYSTEM.md §9.5), grouped by
   * `notifyGrouped`: «علّق … على طلبك» to the customer while the job is on the
   * board (`request_comment:<requestId>`, people-counting), «سأل … عن طلبك»
   * to the customer (`request_question:<requestId>`) and «أجاب الزبون» to the
   * workshop that asked (`request_answer:<questionId>`) — the last two with
   * `repeatActor: 'bump'`, because a second question from the same workshop
   * is news, not noise. `order_update` (above) rides the same upsert per
   * order (`order_update:<orderId>`), bumped on every update: the two parties
   * of an order are exactly who may ring each other's bell about it.
   */
  | 'request_comment'
  | 'request_question'
  | 'request_answer';

export interface NotificationInput {
  userId: string;
  kind: NotificationKind;
  title_ar: string;
  title_en: string;
  body_ar?: string;
  body_en?: string;
  /** In-app path, e.g. `/requests/req_123`. */
  link: string;
  /**
   * WIDENED WITH `kind`, NEVER AFTER IT. `notifyStatement` writes
   * `n.entity_type ?? ''`, so a sender whose kind compiles but whose entity
   * type does not has exactly one way out: drop the field and store ''. The row
   * still arrives, still reads correctly, and has permanently lost the join
   * back to what it is about — which for a stock alert is the product the
   * customer is being told to go and buy. 'product' is here because
   * 'stock_back' is above, and 'complaint' because 'complaint_reply' is —
   * widened in the same commit as the kind, which is what this paragraph
   * asks for. 'claim' arrived with 'warranty_reply' and 'warranty_stage'.
   */
  entity_type?:
    | 'request' | 'offer' | 'order' | 'review' | 'product' | 'ticket' | 'complaint' | 'claim' | 'chat'
    // The merchant kinds' objects (W2-E): a custom order, a coupon, a payout, the store itself.
    | 'custom_order' | 'coupon' | 'payout' | 'store'
    // 0143 — a trade-in request, with 'trade_in' above.
    | 'trade_in'
    // 0153 — a maker's project or post (portfolio consent, and the social kinds after it).
    | 'community_post'
    // 0154 — a comment under a post ('comment_replied'), a person ('new_follower').
    | 'community_comment' | 'user'
    // 0175 — a granted gift ('gift_granted').
    | 'gift'
    | '';
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

/**
 * A GROUPED NOTIFICATION — one row per (recipient, group key) whose count
 * climbs (docs/COMMUNITY_ECOSYSTEM.md Phase 2).
 *
 * The social kinds arrive in bursts: a project that does well is liked forty
 * times in an hour, and forty rows in the bell is noise that buries the one
 * offer the person was waiting for. So a burst is ONE row: the first like
 * inserts it, every later like lands on the partial unique index
 * (`user_id, event_key WHERE event_key <> ''`, 0045) and the conflict clause
 * raises `meta.count`, remembers the latest actor, clears `read_at` and moves
 * `created_at` to now — the row climbs back to the top, unread, saying «12
 * people liked …». The title is recomputed from the count the database
 * answers with (RETURNING), so two likes that race both raise the number and
 * the last writer's title names the larger count.
 *
 * THE COUNT IS PEOPLE, NOT EVENTS. One account liking, unliking and liking
 * again is one person, and a row that said «6 people liked» over a single
 * actor — coming back unread each time — was a lie and a lever: the like
 * bucket allows 240 an hour, so one account could ring a victim's bell a
 * hundred times an hour per post. `meta.actors` keeps the ids already counted
 * (the last `ACTORS_KEPT`, a window rather than the whole audience), and the
 * upsert is conditional on the actor being NEW to it: a repeat leaves the
 * count, the body, the link, `read_at` and `created_at` exactly as they were.
 * An actor who fell out of the window is counted again — an approximation
 * that errs by one in a burst of fifty, never by a hundred over one person.
 *
 * SQLite accepts a conflict target with a WHERE clause exactly when it
 * matches a partial unique index, which `idx_user_notifications_event` is;
 * `INSERT OR IGNORE` (notify) and this upsert therefore share one index and
 * one replay rule. Never throws, for the same reason `notify` never does.
 */
export interface GroupedNotificationInput {
  userId: string;
  kind: Extract<
    NotificationKind,
    | 'post_liked' | 'post_commented' | 'comment_replied' | 'new_follower' | 'files_added' | 'request_files'
    // 0160 — the request's discussion and the order's timeline (§9.5).
    | 'order_update' | 'request_comment' | 'request_question' | 'request_answer'
  >;
  /** One row per recipient per key: `post_liked:<postId>`, `new_follower:<userId>`, … */
  groupKey: string;
  actor: { id: string; name: string };
  /** The title for a given count — 1 names the actor, more name the number. */
  title: (count: number, actorName: string) => { ar: string; en: string };
  body?: { ar: string; en: string };
  link: string;
  entity_type: NonNullable<NotificationInput['entity_type']>;
  entity_id: string;
  /**
   * WHAT A REPEAT ACTOR DOES TO THE ROW. `'ignore'` (the default, and the
   * rule for every crowd kind) leaves the row exactly as it was: the count is
   * PEOPLE. `'bump'` is for the kinds where the sender and the recipient are
   * the two parties of one thing — an order's updates, a question and its
   * answer — and a second message from the same person IS a new event: the
   * count climbs, the body and link are the latest, the row comes back
   * unread at the top. The actors window is still kept, so a caller reading
   * `meta.actors` sees who wrote.
   */
  repeatActor?: 'ignore' | 'bump';
}

/** How many distinct actors a grouped row remembers, so a repeat is recognised. */
export const ACTORS_KEPT = 50;

export async function notifyGrouped(db: D1Database, n: GroupedNotificationInput): Promise<{ id: string; count: number } | null> {
  try {
    const first = n.title(1, n.actor.name);
    const actorJson = JSON.stringify({ id: n.actor.id, name: n.actor.name });
    // The row as it stands is `user_notifications.*` inside the DO UPDATE.
    // A kind that BUMPS on a repeat actor never finds the actor «seen»: every
    // event of theirs counts, and the row resurfaces (see `repeatActor`).
    const seen =
      n.repeatActor === 'bump'
        ? '0'
        : `EXISTS (SELECT 1 FROM json_each(user_notifications.meta, '$.actors') WHERE value = ?13)`;
    const actors = `CASE
        WHEN json_type(user_notifications.meta, '$.actors') IS NOT 'array' THEN json_array(?13)
        WHEN json_array_length(user_notifications.meta, '$.actors') >= ${ACTORS_KEPT}
          THEN json_insert(json_remove(json_extract(user_notifications.meta, '$.actors'), '$[0]'), '$[#]', ?13)
        ELSE json_insert(json_extract(user_notifications.meta, '$.actors'), '$[#]', ?13) END`;
    const row = await db
      .prepare(
        `INSERT INTO user_notifications
           (id, user_id, kind, title_ar, title_en, body_ar, body_en, link, entity_type, entity_id, meta, event_key)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, json_object('count', 1, 'last_actor', json(?11), 'actors', json_array(?13)), ?12)
         ON CONFLICT(user_id, event_key) WHERE event_key <> '' DO UPDATE SET
           meta = CASE WHEN ${seen} THEN user_notifications.meta
                  ELSE json_set(user_notifications.meta,
                                '$.count', COALESCE(json_extract(user_notifications.meta, '$.count'), 1) + 1,
                                '$.last_actor', json(?11),
                                '$.actors', json(${actors})) END,
           body_ar = CASE WHEN ${seen} THEN user_notifications.body_ar ELSE excluded.body_ar END,
           body_en = CASE WHEN ${seen} THEN user_notifications.body_en ELSE excluded.body_en END,
           link = CASE WHEN ${seen} THEN user_notifications.link ELSE excluded.link END,
           read_at = CASE WHEN ${seen} THEN user_notifications.read_at ELSE NULL END,
           created_at = CASE WHEN ${seen} THEN user_notifications.created_at ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END
         RETURNING id, json_extract(meta, '$.count') AS count`
      )
      .bind(
        newId('ntf'), n.userId, n.kind, first.ar, first.en, n.body?.ar ?? '', n.body?.en ?? '', n.link,
        n.entity_type, n.entity_id, actorJson, n.groupKey, n.actor.id
      )
      .first<{ id: string; count: number }>();
    if (!row) return null;
    const count = Number(row.count ?? 1);
    if (count > 1) {
      const t = n.title(count, n.actor.name);
      await db.prepare('UPDATE user_notifications SET title_ar = ?, title_en = ? WHERE id = ?').bind(t.ar, t.en, row.id).run();
    }
    return { id: String(row.id), count };
  } catch (e) {
    console.error(`grouped notification not written (${n.kind}): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * THE SORANI OF A GROUPED ROW — the meta trick worker/lib/merchantNotify.ts
 * uses (`meta.title_ckb` / `meta.body_ckb`), applied AFTER `notifyGrouped`
 * answered with the count, because the grouped upsert owns `meta` (count,
 * last actor, actors) and the Sorani title depends on the count it returns.
 * A second stamp for the same row overwrites the first, so the Sorani names
 * the same number the Arabic does. Never throws, like every notifier.
 */
export async function stampGroupedCkb(
  db: D1Database,
  id: string,
  text: { title_ckb: string; body_ckb?: string }
): Promise<void> {
  try {
    await db
      .prepare(`UPDATE user_notifications SET meta = json_set(meta, '$.title_ckb', ?, '$.body_ckb', ?) WHERE id = ?`)
      .bind(text.title_ckb, text.body_ckb ?? '', id)
      .run();
  } catch (e) {
    console.error(`grouped notification's Sorani not stamped (${id}): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * «N أشخاص» in Arabic, with the dual and the 3–10 / 11+ forms — the counted
 * noun changes with the number, so the caller cannot template it.
 */
export function peopleAr(n: number): string {
  if (n === 2) return 'شخصان';
  if (n >= 3 && n <= 10) return `${n} أشخاص`;
  return `${n} شخصًا`;
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
