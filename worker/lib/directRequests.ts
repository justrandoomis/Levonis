/**
 * A REQUEST ADDRESSED TO ONE STORE (migration 0151; docs/COMMUNITY_COMMERCE_CHAT.md §2 D4, D5).
 *
 * A «طلب طباعة» sent inside a store's conversation, or the request a store's
 * «عرض سعر» makes for the customer of that conversation, is an ordinary
 * `community_requests` row with `visibility = 'direct'` and the store it is
 * addressed to. Everything after that is the flow that already exists — offers
 * with revisions, acceptance that holds the money in ONE fenced batch, the
 * order lifecycle, release and disputes. What differs is WHO MAY QUOTE:
 *
 *   · on the board, any workshop whose printers and stock can make the job
 *     (the live verdict, worker/lib/printMatchingStore.ts);
 *   · here, only the store the customer addressed — no matching, because the
 *     customer chose the store — and only while that store takes new work
 *     (`merchantTakesNewWork`, the same allow-list acceptance asks).
 *
 * The database keeps the same promise (0151's triggers): an offer on a direct
 * request can only be its store's, and a request never changes store or moves
 * onto the board.
 */
import type { Env } from './types';
import { HttpError, conflict, notFound } from './http';
import { isSchemaMissing } from './membershipBenefits';
import { isPast, merchantTakesNewWork } from './communityRequests';
import { approvedAtSql, merchantApproved, merchantIsPublic, publicStoreUnavailable, storeIsPublic, withApprovalSchema } from './merchantApproval';
import { assertMayOffer, type LiveVerdict } from './printMatchingStore';

export interface DirectRequestRow {
  id: string;
  customer_id: string;
  title: string;
  state: string;
  visibility: string;
  expires_at: string | null;
  revision: number;
  target_merchant_id: string;
  origin_chat_id: string | null;
  created_by: 'customer' | 'merchant';
}

const DIRECT_COLUMNS = `r.id, r.customer_id, r.title, r.state, r.visibility, r.expires_at, r.revision,
       r.target_merchant_id, r.origin_chat_id, r.created_by`;

/** The request, when it is a DIRECT one — null otherwise, and on a database behind 0151 (none exist there). */
export async function directRequest(db: D1Database, requestId: string): Promise<DirectRequestRow | null> {
  try {
    const row = await db
      .prepare(`SELECT ${DIRECT_COLUMNS} FROM community_requests r WHERE r.id = ? AND r.visibility = 'direct'`)
      .bind(requestId)
      .first<DirectRequestRow>();
    return row ?? null;
  } catch (e) {
    if (isSchemaMissing(e)) return null;
    throw e;
  }
}

// `isDirectMerchant` lives beside the other request access questions (worker/lib/communityRequests.ts).
export { isDirectMerchant } from './communityRequests';

/** The merchant behind a merchant id, with what `merchantTakesNewWork` asks (the approval stamp NULL on a database without 0204). */
async function merchantStanding(db: D1Database, merchantId: string) {
  return withApprovalSchema((schema) =>
    db
      .prepare(
        `SELECT m.id, m.status AS m_status, m.user_id, s.status AS s_status, ${approvedAtSql('m', schema)} AS approved_at
           FROM community_merchants m LEFT JOIN merchant_stores s ON s.merchant_id = m.id
          WHERE m.id = ?`
      )
      .bind(merchantId)
      .first<{ id: string; m_status: string; user_id: string; s_status: string | null; approved_at: string | null }>()
  );
}

/**
 * MAY THIS STORE QUOTE THIS DIRECT REQUEST RIGHT NOW — the direct twin of the
 * board's `assertMayOffer`. Addressed to this store, taking offers, not
 * expired, not the store's own account, and the store takes new work. Refuses
 * with the board's own codes where the meaning is the same, so every screen
 * that already words them words these.
 */
export async function assertDirectStanding(env: Env, requestId: string, merchantId: string): Promise<DirectRequestRow> {
  const r = await directRequest(env.DB, requestId);
  // Another store's direct request does not exist as far as this store knows.
  if (!r || r.target_merchant_id !== merchantId) throw notFound('Request not found');
  if (r.state !== 'open' && r.state !== 'receiving_offers') {
    throw conflict('This request is no longer accepting offers', 'REQUEST_NOT_OPEN');
  }
  if (isPast(r.expires_at)) throw conflict('This request has expired and no longer takes offers', 'REQUEST_EXPIRED');
  const m = await merchantStanding(env.DB, merchantId);
  if (!m) throw notFound('Request not found');
  if (m.user_id === r.customer_id) throw new HttpError(400, 'You cannot quote your own request', 'OWN_REQUEST');
  const takes = await merchantTakesNewWork(env.DB, {
    merchantStatus: m.m_status,
    storeStatus: m.s_status,
    merchantApproved: merchantApproved(m),
    ownerUserId: m.user_id,
  });
  if (!takes) {
    throw new HttpError(403, 'Your store is not taking new work right now', 'MERCHANT_UNAVAILABLE');
  }
  return r;
}

/**
 * THE OFFER GATE FOR ANY REQUEST: a direct request asks the direct standing, a
 * board request the live verdict. The edit and re-confirm doors call this, so
 * a store's quote in its own conversation is never refused for printers the
 * customer never asked about.
 */
export async function assertMayQuote(env: Env, requestId: string, merchantId: string): Promise<LiveVerdict | null> {
  const direct = await directRequest(env.DB, requestId);
  if (direct) {
    await assertDirectStanding(env, requestId, merchantId);
    return null;
  }
  // The live verdict, for a caller that also asks it of each covered part (P1-05).
  return assertMayOffer(env, requestId, merchantId);
}

/** The store a customer addresses a request to from its page (P1-06): who it is and where it lives. */
export interface DirectStore {
  merchantId: string;
  merchantUserId: string;
  storeId: string;
  storeName: string;
  storeSlug: string;
}

/**
 * MAY THIS CUSTOMER ADDRESS A REQUEST TO THIS STORE — the store page's «لهذا
 * المتجر فقط» and a product page's «اطلب طباعته» (worker/routes/
 * requestEntries.ts; P1-06, docs/DECISIONS.md row 268). The conversation's
 * own rules, asked in the same order, so the editor and the chat sheet answer
 * one store the same way:
 *
 *   a store the public may see (E12) — or one this customer already has
 *   business with (`knows`, the chat door's `customerKnowsMerchant`) —
 *   else the one generic STORE_UNAVAILABLE (C9);
 *   not the customer's own store (OWN_STORE_REQUEST — its own code, not the
 *   offer door's OWN_REQUEST, so the client says «this is your own store»);
 *   taking custom requests (STORE_NO_CUSTOM_REQUESTS);
 *   taking new work (STORE_NOT_TAKING_WORK: its own code, because the offer door's
 *   MERCHANT_UNAVAILABLE sentence asks the customer to choose another offer).
 *
 * Nothing is written and no conversation is opened: the store hears of a
 * request when it is SENT, never when its customer starts writing it.
 */
export async function assertStoreTakesDirect(
  db: D1Database,
  merchantId: string,
  customerId: string,
  knows: (db: D1Database, customerId: string, merchantId: string, merchantUserId: string) => Promise<boolean>
): Promise<DirectStore> {
  const m = await withApprovalSchema((schema) =>
    db
      .prepare(
        `SELECT m.id, m.user_id, m.name AS merchant_name, m.status, ${approvedAtSql('m', schema)} AS approved_at,
                s.id AS store_id, s.status AS store_status, s.name AS store_name, s.slug AS store_slug,
                s.accepts_custom_requests
           FROM community_merchants m LEFT JOIN merchant_stores s ON s.merchant_id = m.id
          WHERE m.id = ?`
      )
      .bind(merchantId)
      .first<{
        id: string; user_id: string; merchant_name: string | null; status: string; approved_at: string | null;
        store_id: string | null; store_status: string | null; store_name: string | null; store_slug: string | null;
        accepts_custom_requests: number | null;
      }>()
  );
  if (!m || !m.store_id) throw publicStoreUnavailable();
  if (m.user_id === customerId) throw new HttpError(400, 'This is your own store', 'OWN_STORE_REQUEST');
  const isPublic = merchantIsPublic(m) && storeIsPublic({ status: m.store_status });
  if (!isPublic && !(await knows(db, customerId, merchantId, m.user_id))) throw publicStoreUnavailable();
  if (Number(m.accepts_custom_requests ?? 1) !== 1) {
    throw conflict('This store is not taking custom requests right now', 'STORE_NO_CUSTOM_REQUESTS');
  }
  const takes = await merchantTakesNewWork(db, {
    merchantStatus: m.status,
    storeStatus: m.store_status,
    merchantApproved: merchantApproved(m),
    ownerUserId: m.user_id,
  });
  if (!takes) throw conflict('This store is not taking new work right now', 'STORE_NOT_TAKING_WORK');
  return {
    merchantId: m.id,
    merchantUserId: m.user_id,
    storeId: m.store_id,
    storeName: String(m.store_name || m.merchant_name || ''),
    storeSlug: String(m.store_slug ?? ''),
  };
}
