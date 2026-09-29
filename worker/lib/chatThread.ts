/**
 * WHO A CONVERSATION IS BETWEEN — read once, from the database, for every door
 * that needs to know: the chat routes, the card resolver and the system cards
 * posted after a money move (worker/lib/chatCards.ts). Moved out of
 * worker/routes/chats.ts so a library can ask the question without importing
 * a router.
 *
 * Nothing here trusts the request: the store, its merchant, its seller and its
 * customer all come from the thread's own row (migration 0124 stamps them when
 * the thread is opened) and the entity it is about.
 */

/** The order a thread is about, when it is a MERCHANT-STORE order's thread. */
export interface StoreOrderThread {
  order_id: string;
  customer_id: string;
  seller_id: string;
}

export async function storeOrderThread(db: D1Database, chatId: string): Promise<StoreOrderThread | null> {
  const row = await db
    .prepare(
      `SELECT o.id AS order_id, o.user_id AS customer_id, m.user_id AS seller_id
         FROM chats ch
         JOIN orders o ON o.id = ch.order_id
         JOIN community_merchants m ON m.id = o.merchant_id
        WHERE ch.id = ?`
    )
    .bind(chatId)
    .first<StoreOrderThread>();
  return row ?? null;
}

/**
 * A THREAD THE STORE OWNS (migration 0124): a customer's direct message to the
 * store (`store`), a store order's thread (`store_order`), or a custom
 * request's thread (`request`) — with who its customer and its seller are.
 * A store order's thread opened before 0124 stamped its context is found
 * through the order, exactly as before.
 */
export interface StoreThread {
  store_id: string;
  /** The store's merchant (community_merchants.id). */
  merchant_id: string;
  context_type: 'store' | 'store_order' | 'request';
  context_id: string;
  customer_id: string;
  seller_id: string;
}

export async function storeThreadOf(db: D1Database, chatId: string): Promise<StoreThread | null> {
  const row = await db
    .prepare(
      `SELECT ch.store_id, s.merchant_id, ch.context_type, ch.context_id, s.user_id AS seller_id,
              CASE ch.context_type
                WHEN 'store' THEN ch.context_id
                WHEN 'store_order' THEN (SELECT o.user_id FROM orders o WHERE o.id = ch.context_id)
                WHEN 'request' THEN (SELECT r.customer_id FROM community_requests r WHERE r.id = ch.context_id)
              END AS customer_id
         FROM chats ch
         JOIN merchant_stores s ON s.id = ch.store_id
        WHERE ch.id = ? AND ch.context_type IN ('store', 'store_order', 'request')`
    )
    .bind(chatId)
    .first<StoreThread>()
    .catch(() => null);
  if (row?.customer_id) return row;
  const legacy = await storeOrderThread(db, chatId);
  if (!legacy) return null;
  const store = await db
    .prepare('SELECT s.id, s.merchant_id FROM orders o JOIN merchant_stores s ON s.merchant_id = o.merchant_id WHERE o.id = ?')
    .bind(legacy.order_id)
    .first<{ id: string; merchant_id: string }>();
  return store
    ? {
        store_id: store.id,
        merchant_id: store.merchant_id,
        context_type: 'store_order',
        context_id: legacy.order_id,
        customer_id: legacy.customer_id,
        seller_id: legacy.seller_id,
      }
    : null;
}

/** Which side of a store thread an account is on, or null for neither. */
export function threadRole(thread: StoreThread, userId: string): 'customer' | 'merchant' | null {
  if (userId === thread.seller_id) return 'merchant';
  if (userId === thread.customer_id) return 'customer';
  return null;
}
