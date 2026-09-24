/**
 * THE CUSTOM-REQUEST LIFECYCLE, WHERE MORE THAN ONE ROUTE NEEDS THE SAME RULE.
 *
 * worker/routes/marketplace.ts, worker/routes/printRequests.ts,
 * worker/routes/adminCommunity.ts and the scheduled sweeps below all move the
 * same three rows — a request, its offers, its order — and each of them used
 * to carry its own copy of "what else has to change when this does". The
 * copies drifted, and wave 1's audit (docs/merchant-platform/audit/03 §10)
 * found the drift: an offer count nobody decremented, viewer links that
 * outlived the request, a completion counted twice, a request left
 * `disputed` after its dispute was decided. The statements that keep those
 * rows consistent now live here, ONCE, and every caller appends them to its
 * own batch so they commit with the change that needs them or not at all.
 *
 * NOTHING HERE READS A CLIENT FIGURE, and every statement is conditional on
 * the state it expects: replaying any of them is a no-op, which is what makes
 * a retried request, an overlapping cron run and a double tap all safe.
 */

import type { Env, SessionUser } from './types';
import { newId } from './crypto';
import { communityMayEnter, readCommunityGate } from './communityGate';
import { storeForUser } from './merchantAuth';
import { benefits, getTierStatus } from './entitlements';
import { escrowForOrder, releaseEscrow, releaseEscrowReservation } from './escrowOps';
import { notifyStatement } from './notifications';
import { merchantNotificationStatement, offerAcceptedNotice } from './merchantNotify';
import { merchantHref } from '@levonis/contracts/merchantRoutes';
import { audit } from './audit';

const nowIso = () => new Date().toISOString();

/** Request states a merchant may still bid on. */
export const BOARD_STATES = ['open', 'receiving_offers'] as const;

/** Request states the CUSTOMER may cancel from — nothing is committed yet. */
export const CUSTOMER_CANCELLABLE_STATES = ['draft', 'open', 'receiving_offers'] as const;

// ------------------------------------------------------------------- reads

/** The columns every access decision needs. */
export interface RequestForAccess {
  id: string;
  customer_id: string;
  state: string;
  visibility: string;
  expires_at: string | null;
}

/** An ISO instant that has already passed. Empty and unparseable are "never". */
export function isPast(at: string | null | undefined, now: string = nowIso()): boolean {
  return typeof at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(at) && at <= now;
}

/**
 * ON THE PUBLIC BOARD RIGHT NOW: public, taking offers, and not past its
 * expiry. The board query, the request page, the print facts, the file route
 * and the viewer all ask this ONE question — audit 03 §10 I found the board
 * hiding expired requests while every other door still served them.
 */
export function onPublicBoard(r: RequestForAccess, now: string = nowIso()): boolean {
  return (
    r.visibility === 'public' &&
    (BOARD_STATES as readonly string[]).includes(r.state) &&
    !isPast(r.expires_at, now)
  );
}

/** Is this user the merchant whose offer on this request was accepted? */
export async function isEngagedMerchant(db: D1Database, requestId: string, userId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS x FROM community_offers o
         JOIN community_merchants m ON m.id = o.merchant_id
        WHERE o.request_id = ? AND m.user_id = ? AND o.state = 'accepted'`
    )
    .bind(requestId, userId)
    .first();
  return !!row;
}

/**
 * MAY THIS ACCOUNT QUOTE ON THE BOARD RIGHT NOW? The same bar the offer route
 * sets (`requireSellingPrivileges` + the `communityOffers` benefit), asked as a
 * question rather than thrown: a store that is not suspended or paused, a
 * merchant who is not suspended, and a plan that includes community offers.
 * It is what "merchants the file policy allows" means for the 3D preview — a
 * preview exists so a merchant can decide what to offer, so an account that
 * cannot offer has no reason to mint one.
 */
export async function mayQuoteOnBoard(db: D1Database, userId: string): Promise<boolean> {
  const ctx = await storeForUser(db, userId);
  if (!ctx) return false;
  return merchantTakesNewWork(db, {
    merchantStatus: ctx.merchant.status,
    storeStatus: ctx.store.status,
    ownerUserId: userId,
  });
}

/**
 * MAY THIS MERCHANT TAKE ON NEW WORK — the ONE allow-list behind making an
 * offer (`requireOfferPrivileges` + the `communityOffers` benefit), minting a
 * preview link on the board (`mayQuoteOnBoard`) and a customer ACCEPTING a
 * standing offer (worker/routes/marketplace.ts). Review S2: acceptance asked
 * only "not suspended", so an offer from a PAUSED store or an owner whose plan
 * had lapsed was accepted and its escrow funded while the same merchant was
 * refused a new offer; and a RESTRICTED merchant, refused every offer, could
 * still mint a viewer link.
 *
 * An allow-list, like the buy path: the merchant exactly `active`, the store
 * exactly `active` (a missing store is not one), and the owner's plan carries
 * both the store and the community-offers benefit.
 */
export async function merchantTakesNewWork(
  db: D1Database,
  p: { merchantStatus: unknown; storeStatus: unknown; ownerUserId: string }
): Promise<boolean> {
  if (p.merchantStatus !== 'active' || p.storeStatus !== 'active') return false;
  const tier = await getTierStatus(db, p.ownerUserId);
  return benefits.merchantStore(tier) && benefits.communityOffers(tier);
}

export type FileAccess = 'owner' | 'admin' | 'engaged' | 'board';

/**
 * WHO MAY READ A REQUEST'S ATTACHMENTS, derived from the request on every read.
 *
 *   owner   — the customer, always: it is their file.
 *   admin   — moderation of a reported request.
 *   engaged — the merchant whose offer was accepted, for the life of the job.
 *   board   — anyone signed in while the request is ON THE BOARD (public,
 *             taking offers, not expired) AND Levo Community lets them in.
 *
 * `gateClosed` is true when the ONLY way in would have been the board and the
 * community gate refused it: the caller gets the maintenance refusal the board
 * itself gives (audit 03 §10 G — the file used to answer 200 while the board
 * answered 503), not a 404 that would pretend the file does not exist.
 */
export async function requestFileAccess(
  env: Env,
  r: RequestForAccess,
  user: SessionUser | null | undefined,
  opts: { allowAdmin: boolean }
): Promise<{ access: FileAccess | null; gateClosed: boolean }> {
  if (!user) return { access: null, gateClosed: false };
  if (user.id === r.customer_id) return { access: 'owner', gateClosed: false };
  if (opts.allowAdmin && user.role === 'admin') return { access: 'admin', gateClosed: false };
  if (await isEngagedMerchant(env.DB, r.id, user.id)) return { access: 'engaged', gateClosed: false };
  if (!onPublicBoard(r)) return { access: null, gateClosed: false };
  if (!communityMayEnter(await readCommunityGate(env.DB), user)) return { access: null, gateClosed: true };
  return { access: 'board', gateClosed: false };
}

// -------------------------------------------------------------- statements

/**
 * THE ADVERTISED OFFER COUNT, RECOMPUTED FROM THE OFFERS IT COUNTS (audit 03
 * §10 H). "Live" is the definition the admin reject route already used:
 * pending or accepted. Append it to every batch that moves an offer and the
 * number on the board can no longer disagree with the offers behind it.
 */
export function offerCountStatement(db: D1Database, requestId: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE community_requests
          SET offer_count = (SELECT COUNT(*) FROM community_offers o
                              WHERE o.request_id = ?1 AND o.state IN ('pending','accepted'))
        WHERE id = ?1`
    )
    .bind(requestId);
}

/**
 * EVERY 3D VIEWER LINK ON THIS REQUEST STOPS WORKING (audit 03 §10 F).
 *
 * Called when the request closes — cancelled, removed, expired, completed —
 * and at acceptance for everyone except the customer and the winning
 * merchant (`keepUserIds`): a merchant who lost the job loses the preview
 * with it. `revoked_at` existed since 0045 and nothing ever wrote it.
 */
export function revokeViewerTokensStatement(
  db: D1Database,
  requestId: string,
  ts: string,
  keepUserIds: string[] = []
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE model_view_tokens SET revoked_at = ?2
        WHERE request_id = ?1 AND revoked_at IS NULL
          AND created_by NOT IN (SELECT value FROM json_each(?3))`
    )
    .bind(requestId, ts, JSON.stringify(keepUserIds));
}

/**
 * A FENCE: aborts the whole batch unless the request now carries `state`
 * stamped with THIS batch's `ts` — i.e. unless the conditional UPDATE before it
 * really moved the request. The NOT NULL `updated_at` is what refuses: the same
 * idiom as walletOps' `assertHoldStateStatement`. Without it, the statements
 * after a guard that matched nothing (a request somebody else already moved)
 * would still run.
 */
export function requestMovedFence(db: D1Database, requestId: string, state: string, ts: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE community_requests
          SET updated_at = CASE WHEN state = ?2 AND updated_at = ?3 THEN updated_at ELSE NULL END
        WHERE id = ?1`
    )
    .bind(requestId, state, ts);
}

/**
 * THE ORDER IS FINISHED, AND THE MERCHANT EARNS IT EXACTLY ONCE (audit 04 B9).
 *
 * Two «تأكيد الاستلام» taps racing each other both got `ok` from
 * `releaseEscrow` (the second as a replay), and both then ran an
 * unconditional `completed_orders + 1` and a +10 reputation event. Here the
 * order flips only from `merchant_marked_delivered`, and the counter and the
 * event are written only when (a) THIS batch is the one that completed the
 * order — `completed_at` carries this batch's stamp — and (b) no
 * `order_completed` event exists for the order yet. The customer's
 * confirmation and the auto-confirm sweep both finish an order through here.
 */
export function completionStatements(
  db: D1Database,
  order: { id: string; request_id: string; merchant_id: string },
  ts: string,
  opts: { confirmedByCustomer: boolean }
): D1PreparedStatement[] {
  const noCompletionYet = `NOT EXISTS (SELECT 1 FROM merchant_reputation_events
                              WHERE community_order_id = ?2 AND kind = 'order_completed')`;
  const completedHere = `EXISTS (SELECT 1 FROM community_orders
                           WHERE id = ?2 AND state = 'completed' AND completed_at = ?3)`;
  return [
    db
      .prepare(
        `UPDATE community_orders
            SET state = 'completed',
                confirmed_at = CASE WHEN ?2 = 1 THEN ?3 ELSE confirmed_at END,
                completed_at = ?3, updated_at = ?3
          WHERE id = ?1 AND state = 'merchant_marked_delivered'`
      )
      .bind(order.id, opts.confirmedByCustomer ? 1 : 0, ts),
    db
      .prepare(
        `UPDATE community_requests SET state = 'completed', status = 'closed', updated_at = ?2
          WHERE id = ?1 AND state IN ('offer_selected','in_progress','delivered')`
      )
      .bind(order.request_id, ts),
    // The counter BEFORE the event: both ask "no completion event yet", so the
    // counter must look before the event it is paired with exists.
    db
      .prepare(
        `UPDATE community_merchants SET completed_orders = completed_orders + 1
          WHERE id = ?1 AND ${completedHere} AND ${noCompletionYet}`
      )
      .bind(order.merchant_id, order.id, ts),
    // Reputation is a raw EVENT, never a number someone edits (§41).
    db
      .prepare(
        `INSERT INTO merchant_reputation_events (id, merchant_id, kind, points, community_order_id)
         SELECT ?4, ?1, 'order_completed', 10, ?2
          WHERE ${completedHere} AND ${noCompletionYet}`
      )
      .bind(order.merchant_id, order.id, ts, newId('rep')),
    revokeViewerTokensStatement(db, order.request_id, ts),
  ];
}

// ----------------------------------------------------------- notifications

/**
 * «قُبل عرضك» — the merchant hears that the customer chose them (audit 03 §10
 * N: `'offer_accepted'` was declared and never sent, so a merchant learned
 * they had a paid job by opening the dashboard). The link opens the request,
 * which the engaged merchant may read for the life of the job. The customer's
 * title is not in it: it is free text in the customer's language, and the
 * bell stores ar/en only (see printMatchNotification for why a title is never
 * copied into the `_en` slot).
 */
export function offerAcceptedNotification(
  db: D1Database,
  p: { merchantUserId: string; requestId: string; offerId: string; orderId: string; priceIqd: number }
): D1PreparedStatement {
  // The one copy and the workspace address of the job (worker/lib/merchantNotify.ts, W2-E).
  return merchantNotificationStatement(db, p.merchantUserId, offerAcceptedNotice(p));
}

/**
 * «تغيّر الطلب» — one notification per merchant whose PENDING offer priced an
 * older revision of the job (audit 03 §10 K). Keyed per offer AND revision, so
 * a second change is a second message and a replay of the same change is not.
 */
export async function staleOfferNotifications(
  db: D1Database,
  requestId: string,
  revision: number
): Promise<D1PreparedStatement[]> {
  const { results } = await db
    .prepare(
      `SELECT o.id, m.user_id FROM community_offers o
         JOIN community_merchants m ON m.id = o.merchant_id
        WHERE o.request_id = ? AND o.state = 'pending' AND o.request_revision < ?`
    )
    .bind(requestId, revision)
    .all<{ id: string; user_id: string }>();
  return (results ?? []).map(
    (o) =>
      notifyStatement(db, {
        userId: o.user_id,
        kind: 'offer_stale',
        title_ar: 'تغيّر طلب قدّمت عليه عرضًا',
        title_en: 'A request you offered on has changed',
        body_ar: `عدّل العميل تفاصيل الطلب ${requestId}. عرضك معلّق ولا يمكن قبوله حتى تؤكده من جديد أو تسحبه.`,
        body_en: `The customer changed request ${requestId}. Your offer is on hold and cannot be accepted until you re-confirm or withdraw it.`,
        link: merchantHref.request(requestId),
        entity_type: 'offer',
        entity_id: o.id,
        meta: { request_id: requestId, revision },
        eventKey: `offer_stale:${o.id}:${revision}`,
      }).stmt
  );
}

// ------------------------------------------------------------------ sweeps

export interface CommunitySweepReport {
  /** Delivered orders confirmed by the clock (`auto_complete_at` passed, no dispute). */
  auto_completed: number;
  /** Due orders left alone: no escrow, a disputed escrow, or a refusal from it. */
  auto_complete_skipped: number;
  /** Requests past `expires_at` moved to `expired`, with their pending offers. */
  expired_requests: number;
  /** Pending offers past their own `expires_at`. */
  expired_offers: number;
  /** Requests found stranded in `offer_selected` with no live order, reopened. */
  reopened_requests: number;
  /** Orders stranded in `accepted` by the pre-0116 acceptance, healed. */
  healed_orders: number;
  /** `community_order` wallet holds no escrow points at, given back. */
  released_holds: number;
  errors: string[];
}

export const emptyCommunitySweepReport = (): CommunitySweepReport => ({
  auto_completed: 0,
  auto_complete_skipped: 0,
  expired_requests: 0,
  expired_offers: 0,
  reopened_requests: 0,
  healed_orders: 0,
  released_holds: 0,
  errors: [],
});

/** How long a half-finished acceptance may sit before a sweep calls it abandoned. */
export const STRANDED_AFTER_MINUTES = 15;

/**
 * THE «يتأكد تلقائيًا في» DATE, MADE TRUE (audit 03 §10 M, audit 04 #13).
 *
 * `auto_complete_at` is stamped when the merchant marks the work delivered
 * (`communityAutoCompleteDays` after it; 0 disables it and stamps nothing),
 * and both parties have been shown that date — but nothing ever read it, so
 * the merchant's money waited for the customer indefinitely. This is the
 * reader. It releases through the SAME `releaseEscrow` the customer's button
 * uses, under the SAME idempotency key (`confirm:<order>`), so a customer
 * confirming at the same moment and this sweep settle the escrow once
 * between them; the completion is `completionStatements`, gated the same way.
 *
 * NOT WHEN DISPUTED. A disputed order has left `merchant_marked_delivered`,
 * and an escrow frozen by a dispute is skipped even if an older bug left its
 * order behind (the dispute route used to flip the two separately). And not
 * on a READ of either (review F1): the release itself is conditional on the
 * escrow still being `held` (`releaseEscrow`, as the system — only an admin
 * settles a disputed escrow) AND on the order still being
 * `merchant_marked_delivered`, inside the settlement batch, so a dispute filed
 * between this SELECT and the release wins.
 *
 * ONLY ROWS IT CAN SETTLE ARE READ (review F3). Due orders whose escrow is
 * missing or frozen used to be selected, skipped in code and counted — and
 * `ORDER BY auto_complete_at LIMIT n` served the same n of them to every run,
 * so a hundred stuck rows at the head of the queue starved every later due
 * order for ever. They are filtered in the SELECT and counted by a query of
 * their own.
 */
export async function sweepCommunityAutoComplete(
  env: Env,
  now: string,
  limit: number,
  report: CommunitySweepReport
): Promise<void> {
  const settleable = `EXISTS (SELECT 1 FROM community_escrows e
                              WHERE e.community_order_id = o.id AND e.state IN ('held','released'))`;
  const { results } = await env.DB.prepare(
    `SELECT o.id, o.request_id, o.merchant_id, o.customer_id, o.auto_complete_at FROM community_orders o
      WHERE o.state = 'merchant_marked_delivered' AND o.auto_complete_at IS NOT NULL AND o.auto_complete_at <= ?1
        AND ${settleable}
      ORDER BY o.auto_complete_at LIMIT ?2`
  )
    .bind(now, limit)
    .all<{ id: string; request_id: string; merchant_id: string; customer_id: string; auto_complete_at: string }>();
  const stuck = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM community_orders o
      WHERE o.state = 'merchant_marked_delivered' AND o.auto_complete_at IS NOT NULL AND o.auto_complete_at <= ?1
        AND NOT ${settleable}`
  )
    .bind(now)
    .first<{ n: number }>();
  report.auto_complete_skipped += Number(stuck?.n ?? 0);

  for (const o of results ?? []) {
    try {
      const esc = await escrowForOrder(env.DB, o.id);
      if (!esc || (esc.state !== 'held' && esc.state !== 'released')) {
        report.auto_complete_skipped += 1;
        continue;
      }
      const released = await releaseEscrow(env.DB, {
        escrowId: esc.id,
        actorId: null,
        actorRole: 'system',
        reason: `auto-confirmed: no confirmation or dispute by ${o.auto_complete_at}`,
        idempotencyKey: `confirm:${o.id}`,
        orderStates: ['merchant_marked_delivered'],
      });
      if (!released.ok) {
        report.auto_complete_skipped += 1;
        report.errors.push(`auto_complete ${o.id}: ${released.reason}`);
        continue;
      }
      const ts = nowIso();
      const res = await env.DB.batch(completionStatements(env.DB, o, ts, { confirmedByCustomer: false }));
      if (res[0]?.meta.changes) {
        report.auto_completed += 1;
        await audit(env.DB, null, 'community.order_auto_completed', o.id, {
          escrow: esc.id,
          auto_complete_at: o.auto_complete_at,
        });
      } else {
        report.auto_complete_skipped += 1;
      }
    } catch (e) {
      report.errors.push(`auto_complete ${o.id}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
    }
  }
}

/**
 * EXPIRY IS A STATE, NOT A FILTER (audit 03 §10 I).
 *
 * The board hid a request past `expires_at`, and it stayed `open` — still
 * offerable, still acceptable, still counted. Here it becomes `expired` (a
 * declared transition from open and receiving_offers), its pending offers
 * `expired` with it, its count zero and its viewer links revoked, in ONE batch
 * per chunk. Every statement re-checks the state, so a request accepted a
 * moment before the sweep reached it is not touched. Offers carry their own
 * optional `expires_at`; a pending offer past it expires on its own.
 */
export async function sweepCommunityExpiry(
  env: Env,
  now: string,
  limit: number,
  report: CommunitySweepReport
): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM community_requests
      WHERE state IN ('open','receiving_offers') AND expires_at IS NOT NULL AND expires_at <> ''
        AND expires_at <= ?
      ORDER BY expires_at LIMIT ?`
  )
    .bind(now, limit)
    .all<{ id: string }>();
  const ids = (results ?? []).map((r) => r.id);
  if (ids.length) {
    const due = `SELECT id FROM community_requests
                  WHERE id IN (SELECT value FROM json_each(?1))
                    AND state IN ('open','receiving_offers') AND expires_at <= ?2`;
    const res = await env.DB.batch([
      env.DB.prepare(
        `UPDATE community_offers SET state = 'expired', updated_at = ?2
          WHERE state = 'pending' AND request_id IN (${due})`
      ).bind(JSON.stringify(ids), now),
      env.DB.prepare(
        `UPDATE model_view_tokens SET revoked_at = ?2
          WHERE revoked_at IS NULL AND request_id IN (${due})`
      ).bind(JSON.stringify(ids), now),
      env.DB.prepare(
        `UPDATE community_requests
            SET state = 'expired', status = 'closed', offer_count = 0, updated_at = ?2
          WHERE id IN (${due})`
      ).bind(JSON.stringify(ids), now),
    ]);
    report.expired_requests += Number(res[2]?.meta.changes ?? 0);
  }

  // Offers with their own validity. Only a well-formed ISO date is read as
  // one: the column took 40 characters of free text before it was validated.
  const { results: offers } = await env.DB.prepare(
    `SELECT id, request_id FROM community_offers
      WHERE state = 'pending' AND expires_at IS NOT NULL
        AND expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' AND expires_at <= ?
      LIMIT ?`
  )
    .bind(now, limit)
    .all<{ id: string; request_id: string }>();
  for (const o of offers ?? []) {
    const res = await env.DB.batch([
      env.DB.prepare(
        `UPDATE community_offers SET state = 'expired', updated_at = ? WHERE id = ? AND state = 'pending'`
      ).bind(now, o.id),
      offerCountStatement(env.DB, o.request_id),
    ]);
    report.expired_offers += Number(res[0]?.meta.changes ?? 0);
  }
}

/**
 * NO ACCEPTANCE STAYS HALF-DONE.
 *
 * The acceptance before 0116 moved the request to `offer_selected`, then
 * wrote the order, then asked for the money — three commits. A failure or a
 * crash between them left a request no offer could be accepted on (audit 03
 * §10 A, audit 04 B12), and the live database still holds rows it left. The
 * acceptance now reserves first and commits in one batch, which leaves one
 * crash window: a wallet hold reserved for an order that was never written.
 * This step closes every one of those, and each rule is conditional on the
 * exact stranded shape, so a healthy row is never touched:
 *
 *   1. an ORDER still `accepted` (pre-0116): funded by a held escrow → carried
 *      forward to `funded`/`in_progress`; with no escrow → cancelled, its offer
 *      and the rivals it rejected put back to `pending`.
 *   2. a REQUEST in `offer_selected` with no live order → reopened (receiving
 *      offers if any are pending, else open), acceptance fields cleared.
 *   3. an ACTIVE `community_order` wallet hold no escrow row points at → released.
 *
 * `STRANDED_AFTER_MINUTES` keeps it off anything a request is still working on.
 */
export async function reconcileCommunityAcceptances(
  env: Env,
  now: string,
  limit: number,
  report: CommunitySweepReport
): Promise<void> {
  const cutoff = new Date(Date.parse(now) - STRANDED_AFTER_MINUTES * 60_000).toISOString();

  // 1. Orders the pre-0116 acceptance left in `accepted`.
  const { results: orders } = await env.DB.prepare(
    `SELECT o.id, o.request_id, o.offer_id, o.created_at,
            (SELECT e.state FROM community_escrows e WHERE e.community_order_id = o.id) AS escrow_state
       FROM community_orders o
      WHERE o.state = 'accepted' AND o.created_at < ?
      LIMIT ?`
  )
    .bind(cutoff, limit)
    .all<{ id: string; request_id: string; offer_id: string; created_at: string; escrow_state: string | null }>();
  for (const o of orders ?? []) {
    try {
      const ts = nowIso();
      if (o.escrow_state === 'held') {
        const res = await env.DB.batch([
          env.DB.prepare(
            `UPDATE community_orders SET state = 'funded', updated_at = ? WHERE id = ? AND state = 'accepted'`
          ).bind(ts, o.id),
          env.DB.prepare(
            `UPDATE community_requests SET state = 'in_progress', status = 'closed', updated_at = ?
              WHERE id = ? AND state = 'offer_selected' AND community_order_id = ?`
          ).bind(ts, o.request_id, o.id),
        ]);
        report.healed_orders += Number(res[0]?.meta.changes ?? 0);
      } else if (o.escrow_state === null) {
        const res = await env.DB.batch([
          env.DB.prepare(
            `UPDATE community_orders SET state = 'cancelled', cancelled_at = ?1, updated_at = ?1
              WHERE id = ?2 AND state = 'accepted'
                AND NOT EXISTS (SELECT 1 FROM community_escrows WHERE community_order_id = ?2)`
          ).bind(ts, o.id),
          env.DB.prepare(
            `UPDATE community_offers SET state = 'pending', updated_at = ?1
              WHERE id = ?2 AND state = 'accepted'
                AND EXISTS (SELECT 1 FROM community_orders WHERE id = ?3 AND state = 'cancelled')`
          ).bind(ts, o.offer_id, o.id),
          // The rivals that acceptance rejected carry its instant as their
          // `updated_at` — the same key the old in-route rollback used.
          env.DB.prepare(
            `UPDATE community_offers SET state = 'pending', updated_at = ?1
              WHERE request_id = ?2 AND id <> ?3 AND state = 'rejected' AND updated_at = ?4
                AND EXISTS (SELECT 1 FROM community_orders WHERE id = ?5 AND state = 'cancelled')`
          ).bind(ts, o.request_id, o.offer_id, o.created_at, o.id),
        ]);
        report.healed_orders += Number(res[0]?.meta.changes ?? 0);
      }
      // An `accepted` order over a disputed/settled escrow is not a shape
      // this sweep knows how to finish — it is left for a human.
    } catch (e) {
      report.errors.push(`reconcile order ${o.id}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
    }
  }

  // 2. Requests left in `offer_selected` with no live order behind them.
  const { results: stranded } = await env.DB.prepare(
    `SELECT r.id FROM community_requests r
      WHERE r.state = 'offer_selected' AND r.updated_at < ?
        AND NOT EXISTS (SELECT 1 FROM community_orders o WHERE o.request_id = r.id AND o.state <> 'cancelled')
      LIMIT ?`
  )
    .bind(cutoff, limit)
    .all<{ id: string }>();
  for (const r of stranded ?? []) {
    try {
      const ts = nowIso();
      const res = await env.DB.batch([
        env.DB.prepare(
          `UPDATE community_requests
              SET state = CASE WHEN EXISTS (SELECT 1 FROM community_offers
                                             WHERE request_id = ?2 AND state = 'pending')
                               THEN 'receiving_offers' ELSE 'open' END,
                  status = 'open', accepted_offer_id = NULL, community_order_id = NULL, updated_at = ?1
            WHERE id = ?2 AND state = 'offer_selected'
              AND NOT EXISTS (SELECT 1 FROM community_orders o WHERE o.request_id = ?2 AND o.state <> 'cancelled')`
        ).bind(ts, r.id),
        offerCountStatement(env.DB, r.id),
      ]);
      report.reopened_requests += Number(res[0]?.meta.changes ?? 0);
    } catch (e) {
      report.errors.push(`reconcile request ${r.id}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
    }
  }

  // 3. Reservations no escrow was ever recorded over.
  const { results: holds } = await env.DB.prepare(
    `SELECT h.id FROM wallet_holds h
      WHERE h.kind = 'purchase' AND h.state = 'active' AND h.ref_type = 'community_order'
        AND h.created_at < ?
        AND NOT EXISTS (SELECT 1 FROM community_escrows e
                         WHERE e.community_order_id = h.ref_id AND e.hold_id = h.id)
      LIMIT ?`
  )
    .bind(cutoff, limit)
    .all<{ id: string }>();
  for (const h of holds ?? []) {
    try {
      const r = await releaseEscrowReservation(env.DB, h.id, 'Community acceptance never completed');
      if (r.ok && !r.replayed) report.released_holds += 1;
    } catch (e) {
      report.errors.push(`reconcile hold ${h.id}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`);
    }
  }
}

/**
 * THE COMMUNITY'S SCHEDULED WORK, as ONE step of `runDurableJobs`
 * (worker/lib/jobs.ts). Reconciliation first — a request it reopens may then
 * expire in the same run — then expiry, then the auto-confirm clock. Each part
 * reports into the same object and a failure in one does not stop the others.
 */
export async function runCommunitySweeps(env: Env, now: string = nowIso(), limit = 100): Promise<CommunitySweepReport> {
  const report = emptyCommunitySweepReport();
  const part = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      report.errors.push(`${name}: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
    }
  };
  await part('reconcile', () => reconcileCommunityAcceptances(env, now, limit, report));
  await part('expiry', () => sweepCommunityExpiry(env, now, limit, report));
  await part('auto_complete', () => sweepCommunityAutoComplete(env, now, limit, report));
  return report;
}
