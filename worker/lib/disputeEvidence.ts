/**
 * DISPUTE EVIDENCE ACCESS — WHICH CONVERSATION STAFF MAY READ, AND FOR HOW LONG
 * (docs/COMMUNITY_ECOSYSTEM.md §9.6 «Dispute evidence access», migration 0163).
 *
 * The brief's rule, verbatim: staff read-only, audited, only while disputed,
 * only for the pre-order store conversation linked to a disputed order. A
 * store's thread with its customer (`store`) and a custom request's thread
 * (`request`) are the two parties' own; staff are admitted to one ONLY when
 *
 *   · a `community_orders` row in state `disputed` links to it — the order
 *     was written with this thread (`community_orders.chat_id`, 0151/0159: a
 *     direct request's origin thread or a board deal's request thread), or the
 *     thread is the request thread of the order's own request AND merchant; or
 *   · a store order bought FROM it (`orders.origin_chat_id`, 0152) has a
 *     complaint that is still open.
 *
 * The door is a verdict over rows, recomputed on every read, so it closes the
 * moment the order leaves `disputed` or the complaint is resolved — there is
 * no grant to revoke and nothing to forget. A merchant-store ORDER's own
 * thread (`store_order`) keeps the older, separate rule (audit 04 B6,
 * worker/routes/chats.ts): staff read it read-only whenever they handle it.
 *
 * WHAT THIS FILE DOES NOT DO: decide who is staff (the chat routes ask
 * `isPlatformAdmin`, the admin mounts' own bar), throw (the routes own the
 * refusal codes EVIDENCE_CLOSED / EVIDENCE_NOT_LINKED), or ever return a
 * storage key — a verdict names orders and complaints by id, never a file.
 */
import { newId } from './crypto';
import { audit } from './audit';
import { isSchemaMissing } from './membershipBenefits';

/** The complaint states that mean «decided» — the same set every open-complaint predicate uses. */
export const CLOSED_COMPLAINT_STATES = ['resolved', 'rejected', 'closed'] as const;
export const complaintIsOpen = (status: unknown) =>
  typeof status === 'string' && !(CLOSED_COMPLAINT_STATES as readonly string[]).includes(status);

/** One read session per admin per thread lasts this long; a poll inside it writes nothing. */
export const STAFF_READ_SESSION_MINUTES = 30;

export type EvidenceState = 'open' | 'closed' | 'none';

export interface EvidenceLink {
  /** open = admit; closed = there was a dispute and it is over; none = nothing links this thread to one. */
  state: EvidenceState;
  community_order_id: string | null;
  /** The store order whose complaint opened (or last opened) the door. */
  order_id: string | null;
  complaint_id: string | null;
  request_id: string | null;
}

export interface LinkedCommunityOrder {
  id: string;
  state: string;
  request_id: string | null;
}

export interface LinkedComplaint {
  id: string;
  status: string;
  community_order_id: string | null;
  order_id: string | null;
}

const NONE: EvidenceLink = { state: 'none', community_order_id: null, order_id: null, complaint_id: null, request_id: null };

/**
 * THE VERDICT, PURE. `complaints` are the linked orders' complaints, newest
 * first. A disputed community order wins (with its open complaint, else its
 * newest); then an open complaint on a store order bought here. «Closed» is a
 * thread whose every linked complaint has been decided — a dispute that
 * existed and ended; anything else is «none».
 */
export function evidenceVerdict(
  orders: readonly LinkedCommunityOrder[],
  storeOrderIds: readonly string[],
  complaints: readonly LinkedComplaint[]
): EvidenceLink {
  const disputed = orders.find((o) => o.state === 'disputed');
  if (disputed) {
    const own = complaints.filter((c) => c.community_order_id === disputed.id);
    const pick = own.find((c) => complaintIsOpen(c.status)) ?? own[0] ?? null;
    return { state: 'open', community_order_id: disputed.id, order_id: null, complaint_id: pick?.id ?? null, request_id: disputed.request_id };
  }
  const openStore = complaints.find((c) => c.order_id !== null && storeOrderIds.includes(c.order_id) && complaintIsOpen(c.status));
  if (openStore) {
    return { state: 'open', community_order_id: null, order_id: openStore.order_id, complaint_id: openStore.id, request_id: null };
  }
  if (complaints.length && complaints.every((c) => !complaintIsOpen(c.status))) {
    const last = complaints[0];
    return {
      state: 'closed',
      community_order_id: last.community_order_id,
      order_id: last.order_id,
      complaint_id: last.id,
      request_id: orders.find((o) => o.id === last.community_order_id)?.request_id ?? null,
    };
  }
  return { ...NONE };
}

export interface EvidenceThread {
  chat_id: string;
  context_type: 'store' | 'request';
  context_id: string;
  store_id: string | null;
  merchant_id: string | null;
}

/**
 * The verdict for one conversation, read from the database as it stands — or
 * null when the thread is not a store or request thread at all (the shop's own
 * order threads, a store order's thread, a personal message): the evidence
 * door does not exist there and the caller's ordinary rule applies.
 */
export async function evidenceLinkForThread(db: D1Database, chatId: string): Promise<(EvidenceLink & { thread: EvidenceThread }) | null> {
  const thread = await db
    .prepare(
      `SELECT ch.id AS chat_id, ch.context_type, ch.context_id, ch.store_id,
              COALESCE(ch.merchant_id, s.merchant_id) AS merchant_id
         FROM chats ch LEFT JOIN merchant_stores s ON s.id = ch.store_id
        WHERE ch.id = ? AND ch.context_type IN ('store','request')`
    )
    .bind(chatId)
    .first<EvidenceThread>();
  if (!thread) return null;
  const [orders, storeOrders] = await Promise.all([
    db
      .prepare(
        `SELECT o.id, o.state, o.request_id FROM community_orders o WHERE o.chat_id = ?1
         UNION
         SELECT o.id, o.state, o.request_id FROM community_orders o
          WHERE ?2 = 'request' AND o.request_id = ?3 AND o.merchant_id = ?4`
      )
      .bind(chatId, thread.context_type, thread.context_id, thread.merchant_id ?? '')
      .all<LinkedCommunityOrder>()
      .then((r) => r.results ?? []),
    db
      .prepare("SELECT o.id FROM orders o WHERE o.origin_chat_id = ? AND o.seller_type = 'merchant'")
      .bind(chatId)
      .all<{ id: string }>()
      .then((r) => (r.results ?? []).map((o) => String(o.id)))
      // A database behind 0152 has no `origin_chat_id`: nothing was bought from a thread yet.
      .catch((e: unknown) => {
        if (isSchemaMissing(e)) return [] as string[];
        throw e;
      }),
  ]);
  const orderIds = orders.map((o) => String(o.id));
  const complaints =
    orderIds.length || storeOrders.length
      ? ((
          await db
            .prepare(
              `SELECT id, status, community_order_id, order_id FROM community_complaints
                WHERE community_order_id IN (SELECT value FROM json_each(?1))
                   OR order_id IN (SELECT value FROM json_each(?2))
                ORDER BY created_at DESC, id DESC`
            )
            .bind(JSON.stringify(orderIds), JSON.stringify(storeOrders))
            .all<LinkedComplaint>()
        ).results ?? [])
      : [];
  return { thread, ...evidenceVerdict(orders, storeOrders, complaints) };
}

/**
 * ONE ROW PER READ SESSION — `chat_staff_reads` plus the `admin.chat_read`
 * audit row, once per admin per thread per `STAFF_READ_SESSION_MINUTES`,
 * whichever of the thread, its pages or its files is opened first. The
 * «not within the last half hour» test is inside the INSERT, so two polls
 * racing each other write one row. Nothing here names a key or a message.
 * Returns whether this call opened a new session.
 */
export async function recordStaffEvidenceRead(
  db: D1Database,
  p: { chatId: string; adminId: string; link: EvidenceLink; nowMs?: number }
): Promise<boolean> {
  const now = p.nowMs ?? Date.now();
  const at = new Date(now).toISOString();
  const since = new Date(now - STAFF_READ_SESSION_MINUTES * 60_000).toISOString();
  let opened: boolean;
  try {
    const res = await db
      .prepare(
        `INSERT INTO chat_staff_reads (id, chat_id, admin_id, complaint_id, community_order_id, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
          WHERE NOT EXISTS (SELECT 1 FROM chat_staff_reads WHERE chat_id = ?2 AND admin_id = ?3 AND created_at > ?7)`
      )
      .bind(newId('csr'), p.chatId, p.adminId, p.link.complaint_id, p.link.community_order_id, at, since)
      .run();
    opened = Number(res.meta?.changes ?? 0) === 1;
  } catch (e) {
    if (!isSchemaMissing(e)) throw e;
    // A Worker ahead of 0163: the audit row alone is the record, deduped on
    // the limiter's fixed half-hour window instead.
    const windowSeconds = STAFF_READ_SESSION_MINUTES * 60;
    const seconds = Math.floor(now / 1000);
    const seen = await db
      .prepare(
        `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
         ON CONFLICT(key) DO UPDATE SET
           count = CASE WHEN window_start = ?2 THEN count + 1 ELSE 1 END,
           window_start = ?2
         RETURNING count`
      )
      .bind(`chat-evidence-read:${p.adminId}:${p.chatId}`, seconds - (seconds % windowSeconds))
      .first<{ count: number }>();
    opened = Number(seen?.count) === 1;
  }
  if (opened) {
    await audit(db, p.adminId, 'admin.chat_read', p.chatId, {
      read_only: true,
      evidence: true,
      community_order: p.link.community_order_id,
      order: p.link.order_id,
      complaint: p.link.complaint_id,
    });
  }
  return opened;
}

/** The desk's links for one case: the conversation its order lives in, and its request. */
export interface DisputeLinks {
  chat_id: string | null;
  request_id: string | null;
}

/**
 * «المحادثة» and «الطلب» for a page of complaints (the dispute desk,
 * worker/routes/adminCommunity.ts). A custom order's conversation is the one
 * it was written with, else its request's thread with its merchant; a store
 * order's is the thread it was bought from, else its own order thread. Two
 * reads for the whole page, whatever its length.
 */
export async function disputeLinksFor(
  db: D1Database,
  complaints: ReadonlyArray<Record<string, unknown>>
): Promise<(complaint: Record<string, unknown>) => DisputeLinks> {
  const ids = (k: string) => [...new Set(complaints.map((c) => c[k]).filter((v): v is string => typeof v === 'string' && v !== ''))];
  const communityIds = ids('community_order_id');
  const storeIds = ids('order_id');
  const [custom, store] = await Promise.all([
    communityIds.length
      ? db
          .prepare(
            `SELECT o.id, o.request_id,
                    COALESCE(o.chat_id, (SELECT ch.id FROM chats ch
                                          WHERE ch.context_type = 'request' AND ch.context_id = o.request_id
                                            AND ch.merchant_id = o.merchant_id LIMIT 1)) AS chat_id
               FROM community_orders o WHERE o.id IN (SELECT value FROM json_each(?))`
          )
          .bind(JSON.stringify(communityIds))
          .all<{ id: string; request_id: string | null; chat_id: string | null }>()
          .then((r) => r.results ?? [])
      : Promise.resolve([]),
    storeIds.length
      ? db
          .prepare(
            `SELECT o.id, COALESCE(o.origin_chat_id, (SELECT ch.id FROM chats ch WHERE ch.order_id = o.id LIMIT 1)) AS chat_id
               FROM orders o WHERE o.id IN (SELECT value FROM json_each(?))`
          )
          .bind(JSON.stringify(storeIds))
          .all<{ id: string; chat_id: string | null }>()
          .then((r) => r.results ?? [])
          .catch((e: unknown) => {
            if (isSchemaMissing(e)) return [] as Array<{ id: string; chat_id: string | null }>;
            throw e;
          })
      : Promise.resolve([]),
  ]);
  const customBy = new Map(custom.map((o) => [String(o.id), o]));
  const storeBy = new Map(store.map((o) => [String(o.id), o]));
  return (c) => {
    const co = typeof c.community_order_id === 'string' ? customBy.get(c.community_order_id) : undefined;
    if (co) return { chat_id: co.chat_id ?? null, request_id: co.request_id ?? null };
    const so = typeof c.order_id === 'string' ? storeBy.get(c.order_id) : undefined;
    return { chat_id: so?.chat_id ?? null, request_id: null };
  };
}
