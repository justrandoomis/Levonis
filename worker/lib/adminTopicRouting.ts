/**
 * WHICH TOPIC AN ADMIN NOTIFICATION BELONGS IN — and the promise that asking
 * the question can never cost a customer their order.
 *
 * worker/lib/telegramAdmin.ts already answers WHERE a notification goes: it
 * owns the topic vocabulary, the group binding, the fallback ladder and the
 * send. This file owns the two things every CALLER of it kept re-deciding,
 * badly and differently:
 *
 *   1. WHICH ORDER TOPIC. The owner's group has no single «Orders» topic. It
 *      has «📝 Orders pre-order» and «📝 Orders direct», because a pre-order
 *      is a supplier queue watched for capacity and promised dates while a
 *      direct sale is printed and shipped today. Every call site that passed
 *      the flat literal `'orders'` was therefore addressing a topic that does
 *      not exist in the group, and every pre-order was landing in whatever the
 *      fallback chain reached — which is `orders_direct`. That is not a
 *      cosmetic mis-file: it puts a shipment that is six weeks out in the
 *      queue the owner scans for what to print this morning.
 *
 *   2. WHETHER A FAILED SEND CAN BREAK THE CUSTOMER. `notifyAdminTopic`
 *      returns its misses rather than throwing, which is right — but it
 *      reaches D1 twice (`readAdminGroup`, `readTopics`) before it reaches
 *      Telegram, and a D1 error there is a REJECTED promise, not a returned
 *      miss. Every call site that predated this file handed that promise
 *      straight to `executionCtx.waitUntil` bare; all of them now go through
 *      here instead (returns.ts, orders.ts, wallet.ts and the four new ones).
 *
 *      BEING PRECISE ABOUT WHAT THAT COSTS, because the wrong model of it is
 *      how the wrapper gets deleted by the next reader. Inside `waitUntil` the
 *      response has ALREADY been returned, so a rejection there is an unhandled
 *      rejection in the isolate — log noise and a lost notification, not a 500
 *      the shopper sees. The 500 is the OTHER path: a call site with no
 *      ExecutionContext, where the promise would be awaited or where reaching
 *      for `c.executionCtx` throws in Hono, and there a Telegram outage really
 *      does surface as an error on a purchase that actually went through.
 *      `announceToAdmins` closes both: it cannot reject, ever.
 *
 *      WHAT IT DOES NOT COVER, and the next caller should know it: the `text`
 *      argument is evaluated EAGERLY by the caller before this function is
 *      entered. A throw while formatting it — `.toLocaleString()` on an
 *      undefined, `.repeat()` with a negative count — happens outside the
 *      try/catch and lands on the request. Build the string from values the
 *      handler has already validated.
 *
 * WHY THIS IS NOT IN telegramAdmin.ts. That file is the TRANSPORT — the bot,
 * the group, the binding commands. This is the POLICY its callers share: which
 * key an event of a given shape deserves. Keeping them apart means adding an
 * event kind here never risks the machinery that carries the wallet's money
 * buttons, and it keeps this module free to import the pricing package that
 * defines what a pre-order is.
 *
 * WHAT GOES IN THE TEXT. These messages land in a GROUP that staff read on
 * their phones. The rule the wallet captions already follow (§12.1, "minimum
 * necessary data") holds everywhere: an id the staff can open in the admin
 * panel, what happened, and the one or two facts that let them decide whether
 * to act now. Never a full phone number, a street address or an email —
 * `worker/lib/walletNotify.ts` masks the phone even in the wallet caption,
 * where the reviewer genuinely needs a contact, so nothing less careful is
 * acceptable in a message that exists only to say "something arrived".
 */

import type { Env } from './types';
import { notifyAdminTopic, type NotifyOutcome, type TopicKey } from './telegramAdmin';
import { SHIPPING_TYPES, isPreorder, type ShippingType } from './shippingType';

/**
 * THE ORDER SPLIT, COMPUTED THE WAY THE REST OF THE SYSTEM COMPUTES IT.
 *
 * `isPreorder` is the shared definition in packages/pricing/src/shippingType.ts:
 *
 *     export function isPreorder(type: ShippingType): boolean {
 *       return type !== 'direct';
 *     }
 *
 * which is the SAME test worker/routes/orders.ts:1825 makes when it decides
 * how to price the cart (`const isPreorderCart = shippingType !== 'direct'`).
 * Re-deriving it here — a second `startsWith('preorder_')`, say — would be a
 * fork that can drift the day a fifth transport is added, and the symptom of
 * that drift would be silent: notifications quietly filed in the wrong queue,
 * with nothing in any log to say so.
 *
 * AN UNREADABLE VALUE READS AS DIRECT, deliberately and to match
 * `typeForTransport`, whose documented rule is "anything unknown reads as
 * direct". `orders.shipping_type` is NOT NULL in the schema, but a value read
 * back through a `SELECT *` or an older row is still `unknown` to TypeScript,
 * and guessing "pre-order" for a row we cannot parse would push a routine
 * same-day sale into the queue nobody checks hourly. Direct is the louder
 * mistake, which is the one to make.
 */
export function orderTopic(shippingType: unknown): TopicKey {
  const raw = String(shippingType ?? '');
  const type: ShippingType = (SHIPPING_TYPES as readonly string[]).includes(raw)
    ? (raw as ShippingType)
    : 'direct';
  return isPreorder(type) ? 'orders_preorder' : 'orders_direct';
}

/**
 * A SUPPORT TICKET THAT NAMES A DEVICE IS A WARRANTY TICKET.
 *
 * The owner asked for «تذاكر الضمان» to have their own topic, and the group
 * has «🔥 Warranty support» for them. `support_tickets.unit_id` is the column
 * that already answers it: it is set only when the customer opened the ticket
 * from a serialized unit they own (worker/routes/support.ts validates it
 * against `order_item_units.owner_user_id`), and that is exactly the
 * after-sale, still-under-warranty conversation the topic exists for.
 *
 * THIS PREDICATE COVERS THE TICKETS, NOT THE CLAIMS — and that is not a gap
 * any more. The FORMAL warranty claim (the `warranty_claims` row with its
 * stages and its private evidence, opened by
 * `POST /api/devices/units/:unitId/claims`) announces itself directly with the
 * `warranty` key in worker/routes/devices.ts, because there is nothing to
 * decide there: a claim is always a warranty claim. Both kinds of after-sale
 * conversation therefore reach «🔥 Warranty support», by two paths that each
 * say so in plain terms rather than one clever shared predicate.
 */
export function ticketTopic(unitId: unknown): TopicKey {
  return unitId ? 'warranty' : 'support';
}

/** What `announceToAdmins` adds to `NotifyOutcome`: the send threw. */
export type AnnounceResult = NotifyOutcome | { ok: false; reason: 'threw'; error: string };

/**
 * TELL THE STAFF, AND NEVER LET THAT FAIL THE THING THE CUSTOMER DID.
 *
 * Every notification in this file is a SIDE EFFECT of a business write that
 * has already committed. The order exists. The ticket exists. The review is
 * published. Nothing here can undo any of it and nothing here is allowed to
 * look as though it might: a rejected promise handed to `waitUntil` is an
 * unhandled rejection in the isolate and a silently lost notification, and the
 * same rejection on a path with no ExecutionContext is a 500 for a shopper
 * whose purchase actually went through.
 *
 * So the whole function is a try/catch that returns instead of throwing, and
 * the catch LOGS — structured, with the topic — because a routing failure the
 * operator cannot see is the failure mode §9 of the admin mandate exists to
 * forbid: «Do not silently discard it.» The event itself is not lost either
 * way; it is a row in D1 that the admin panel still lists.
 */
export async function announceToAdmins(
  env: Env,
  topic: TopicKey,
  text: string
): Promise<AnnounceResult> {
  try {
    return await notifyAdminTopic(env, topic, text);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(
      JSON.stringify({
        event: 'telegram_admin_announce_threw',
        topic,
        error: error.slice(0, 300),
        detail: 'the admin notification threw; the business write it describes is unaffected',
      })
    );
    return { ok: false, reason: 'threw', error };
  }
}

/**
 * THE ONE-LINER A ROUTE USES: announce after the response, never before it.
 *
 * `executionCtx.waitUntil` is the right place for this — the customer's
 * response is not held while three network round-trips happen — but reaching
 * for `c.executionCtx` directly has two sharp edges that every new call site
 * would have to remember:
 *
 *   • There is not always an ExecutionContext. A route exercised from a test
 *     harness, or reached through a code path that built its own context, has
 *     none, and `c.executionCtx` THROWS in Hono when it is absent. A route
 *     that crashes in tests because of its notification is a route whose
 *     notification will be deleted by the next person who touches it.
 *   • A bare promise handed to `waitUntil` carries its rejection with it.
 *     `announceToAdmins` cannot reject, which is exactly why this wrapper
 *     accepts nothing else.
 *
 * With no context the send still HAPPENS — it is simply not registered as
 * work to keep the isolate alive. Dropping the promise is safe here and
 * nowhere else, because the promise is guaranteed not to reject.
 */
export function announceAfterResponse(
  c: { env: Env },
  topic: TopicKey,
  text: string
): void {
  const promise = announceToAdmins(c.env, topic, text);
  try {
    const ctx = (c as { executionCtx?: ExecutionContext }).executionCtx;
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(promise);
  } catch {
    // No ExecutionContext on this call path. The send is already in flight and
    // cannot reject; there is simply nothing to keep alive for it.
  }
}
