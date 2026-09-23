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
 *
 * AND THE ONE MESSAGE THAT IS NOT «SOMETHING ARRIVED». The order notification
 * is not read to be informed, it is read to DECIDE: whether today's run can
 * carry it, whether the thing is in the room, whether to confirm it now. For
 * as long as it carried seven facts and no product names it could not be read
 * that way at all — it said «Items: 3» and the owner opened the admin panel
 * every single time, which is the panel doing the notification's job.
 * `orderAnnouncement` below is therefore allowed MORE than the paragraph above
 * allows, and this is the exact list of what more:
 *
 *   • THE PRODUCT LINES — name, the already-resolved «option / colour» text,
 *     quantity and line total — because they are the whole reason the message
 *     is opened. A mystery spool prints its `name_snapshot` and never the
 *     drawn product, so §8.2 is not defeated by the one surface that is handed
 *     the in-memory line instead of the stored row.
 *   • THE TRANSPORT, read from `SHIPPING_TYPE_LABELS` and never re-worded.
 *   • THE CUSTOMER'S NAME, and the phone MASKED — `maskPhone`, the same
 *     function and the same shape `worker/lib/walletNotify.ts` uses in the
 *     wallet caption, where the reviewer genuinely has to call.
 *   • THE DELIVERY AREA at governorate / area / landmark granularity.
 *
 * WHAT IT STILL REFUSES, which is the part of the paragraph above that did not
 * move: the street line (`addresses.address`) is not in the message, the full
 * phone is not in the message, and the email is not in the message. A courier
 * needs a door; somebody deciding whether to confirm an order does not, and a
 * group export holding every customer's street is a different kind of document
 * from one holding «بغداد — الكرادة». `orderAnnouncement` does not even take
 * the street as a parameter, so a later caller cannot pass it by accident.
 */

import type { Env } from './types';
import { notifyAdminTopic, type NotifyOutcome, type TopicKey } from './telegramAdmin';
import { SHIPPING_TYPES, SHIPPING_TYPE_LABELS, isPreorder, type ShippingType } from './shippingType';
import { maskPhone } from './phone';
import { groupDigits, sanitizeUserText } from './walletNotify';

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
  return isPreorder(normalizeShippingType(shippingType)) ? 'orders_preorder' : 'orders_direct';
}

/**
 * The «anything unreadable is direct» rule of the comment above, as ONE
 * function, because two things now depend on it: which topic the order is
 * filed in, and which transport NAME the message prints. If those two ever
 * normalised differently the group would show a message headed «شحن مباشر»
 * sitting in «📝 Orders pre-order», and nothing would be wrong enough to log.
 */
function normalizeShippingType(shippingType: unknown): ShippingType {
  const raw = String(shippingType ?? '');
  return (SHIPPING_TYPES as readonly string[]).includes(raw) ? (raw as ShippingType) : 'direct';
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
 * decide there: a claim is always a warranty claim.
 *
 * AND THERE IS A THIRD KIND, which this comment once forgot to count and which
 * therefore reached the topic by no path at all. `POST /api/profile/warranty-
 * claims` is the GENERAL claim — the one «منتج غير مرتبط كطابعة؟» opens for a
 * customer holding something the shop never serialized, so there is no unit to
 * hang it on and `ticketTopic` never sees it. It now announces itself with the
 * `warranty` key too, in worker/routes/profile.ts. ALL THREE kinds of
 * after-sale conversation therefore reach «🔥 Warranty support», by three
 * paths that each say so in plain terms rather than one clever shared
 * predicate — and a fourth entry point added later has to say so as well,
 * because nothing in this file will notice that it did not.
 */
export function ticketTopic(unitId: unknown): TopicKey {
  return unitId ? 'warranty' : 'support';
}

// ------------------------------------------------------------ order message

/**
 * HOW MANY PRODUCT LINES ARE PRINTED BEFORE THE REST IS COUNTED.
 *
 * `sendMessageToChat` slices the body at 4000 characters (worker/lib/telegram.ts)
 * and says nothing when it does, so an unbounded list does not fail loudly —
 * it silently eats the TOTAL at the bottom, which is the one figure the owner
 * scrolls to. Every field below is length-capped by `sanitizeUserText`, so a
 * fifteen-line list is roughly 2,100 characters on top of a header that cannot
 * exceed a few hundred: the money is always still on screen. A cart with more
 * lines than this is a cart the panel should be opened for anyway.
 */
const ORDER_LINES_SHOWN = 15;

/**
 * ONE PRODUCT LINE, AS BOTH ORDER PATHS ALREADY HOLD IT.
 *
 * Deliberately loose, and deliberately reading two names for the same money:
 * `ComputedLine` (worker/routes/orders.ts) calls the line total `line`, while
 * the community-store `PricedLine` (worker/routes/storeOrders.ts) calls it
 * `line_total_iqd`. Normalising that difference HERE keeps both call sites a
 * plain handoff of rows they already have in memory; the alternative is a
 * mapping expression in each route, which is two more places for the message
 * to drift apart from itself.
 */
export interface OrderAnnouncementLine {
  name?: unknown;
  name_ar?: unknown;
  /**
   * ALREADY HUMAN TEXT, not an id. `resolveCartLine` (worker/routes/cart.ts)
   * builds it by looking every selected option value and the colour up in the
   * product document and joining their DISPLAY names with ' / '. So «الخيار
   * واللون» costs no query here and needs no second vocabulary.
   */
  variant?: unknown;
  qty?: unknown;
  line?: unknown;
  line_total_iqd?: unknown;
  /**
   * Set on a bundle COMPONENT. Components carry zero money and belong under
   * their parent, which is why the count this message replaces already
   * filtered on exactly this field; printing them would show the owner a
   * five-line order for a two-item cart, each component priced at nothing.
   */
  bundle_parent_item_id?: unknown;
  /**
   * §8.2 SURVIVES CONTACT WITH THE GROUP. On a mystery spool the sibling
   * `name` and `product_id` carry the REAL drawn product — `planInventory`
   * needs them — and only the `order_items` INSERT binds NULL in their place.
   * Every other surface is protected structurally; this one is not, because it
   * is handed the in-memory line rather than the stored row. So the snapshot
   * is read FIRST and the real name is never reachable from here.
   */
  mystery_spool?: { name_snapshot?: unknown; variant_snapshot?: unknown } | null;
}

/**
 * EVERYTHING THE MESSAGE IS ALLOWED TO SAY — and nothing the builder has to
 * fetch. Every field is already in memory at both call sites at the moment the
 * order commits, which is what keeps this function synchronous and what keeps
 * it out of the request's critical path.
 *
 * All fields are optional and all are read defensively. `strictNullChecks` is
 * OFF in this repo, so the compiler will not warn about a missing one, and the
 * header above spells out what a throw in here would cost: the text is built
 * EAGERLY by the caller, before `announceAfterResponse` is entered, so it
 * lands on the request of a customer whose order has already committed. There
 * is no `.toLocaleString()` on a possibly-undefined anywhere below.
 */
export interface OrderAnnouncementInput {
  orderId?: unknown;
  /** Set only for a community-store sale; it changes the headline, because the
   *  first question about a store order is always whose store it was. */
  storeName?: unknown;
  customerName?: unknown;
  /** Printed MASKED. See the header. */
  phone?: unknown;
  governorate?: unknown;
  area?: unknown;
  landmark?: unknown;
  /** A `ShippingType`, normalised the same way `orderTopic` normalises it. */
  shippingType?: unknown;
  paymentMethodId?: unknown;
  /** `orders.fulfillment_service`. Printed only when it is not 'standard'. */
  fulfilmentService?: unknown;
  totalIqd?: unknown;
  bnplIqd?: unknown;
  bnplDueAt?: unknown;
  dueOnDeliveryIqd?: unknown;
  /** Community-store sales only: what the merchant is owed from this order. */
  merchantReceivableIqd?: unknown;
  lines?: OrderAnnouncementLine[];
}

/**
 * THE TWO PAYMENT METHODS, IN WORDS THE OWNER ALREADY WROTE.
 *
 * `allowedPaymentMethods` (worker/lib/paymentPolicy.ts) admits exactly
 * `wallet` and `cash`, plus `full_advance` as the stored alias of `wallet`
 * kept for orders placed before the rename. The Arabic is lifted verbatim from
 * the customer's own payment summary
 * (src/components/orders/PaymentBreakdown.tsx: «من المحفظة», «الدفع عند
 * الاستلام») rather than written fresh, so the group and the customer are
 * never reading two different names for one thing.
 *
 * AN UNKNOWN ID FALLS THROUGH AS ITSELF, sanitized. A message that says
 * `gini` is honest and searchable; one that guesses «من المحفظة» for it would
 * be a lie about where the money is, which is the only kind of mistake this
 * line can make that matters.
 */
const PAYMENT_METHOD_AR: Record<string, string> = {
  wallet: 'من المحفظة',
  full_advance: 'من المحفظة',
  cash: 'الدفع عند الاستلام',
};

/** Dinars, grouped by the deterministic formatter the wallet captions use —
 *  never `toLocaleString`, whose output depends on the runtime's ICU data and
 *  which throws nothing useful when handed an undefined. */
function iqd(value: unknown): string {
  const n = Number(value);
  return `${groupDigits(Number.isFinite(n) ? n : 0)} د.ع`;
}

/**
 * THE MESSAGE THE OWNER ACTUALLY READS WHEN AN ORDER LANDS.
 *
 * It replaces a seven-fact English template literal that lived inline at the
 * checkout call site and said, in full: a new order exists, by a username, with
 * N items, for a total. Not one product name, not one option, not one
 * quantity, no transport, no customer and no area — so «Items: 3» was a
 * prompt to go and open the admin panel, every time, which is the panel doing
 * the notification's job. Everything added here is a value the handler had
 * already computed and validated; the builder performs no query and can add no
 * latency to a checkout.
 *
 * ARABIC, AND ONLY ARABIC. This is a STAFF message in the owner's own group,
 * the same audience and the same register as `buildDepositCaption` and
 * `TOPIC_LABELS`. The customer-facing ar/en/ckb rule does not reach it, so no
 * Sorani is written here and none is needed.
 *
 * EVERY USER-SUPPLIED VALUE GOES THROUGH `sanitizeUserText`. A product name or
 * a landmark carrying a bidi override would otherwise reorder the lines around
 * it — the totals could be made to read as another line's — and a newline
 * inside one would forge a field of its own. The send carries no parse_mode,
 * so nothing can additionally activate as markup.
 */
export function orderAnnouncement(input: OrderAnnouncementInput = {}): string {
  const lines = Array.isArray(input.lines) ? input.lines : [];
  // The same filter the `Items:` count it replaces already applied.
  const sellable = lines.filter((l) => !(l && l.bundle_parent_item_id));
  const shown = sellable.slice(0, ORDER_LINES_SHOWN);
  const hidden = sellable.length - shown.length;

  const orderId = sanitizeUserText(input.orderId, { max: 64 });
  const storeName = sanitizeUserText(input.storeName, { max: 80 });
  const out: string[] = [];

  out.push(storeName ? `🛒 طلب متجر جديد — ${orderId}` : `🛒 طلب جديد — ${orderId}`);
  if (storeName) out.push(`المتجر: ${storeName}`);

  const customer = sanitizeUserText(input.customerName, { max: 60 });
  // `maskPhone` is the wallet caption's own function, used on the wallet's own
  // terms: five leading digits, three trailing, stars in between. A reviewer
  // can recognise a number they already hold; nobody can read one off a
  // forwarded screenshot.
  const phoneRaw = sanitizeUserText(input.phone, { max: 24 });
  const phone = phoneRaw ? maskPhone(phoneRaw) : '';
  if (customer || phone) out.push(`الزبون: ${[customer, phone].filter(Boolean).join(' · ')}`);

  // AREA, NOT ADDRESS. `addresses.address` — the street line — is deliberately
  // not a parameter of this function, so no later caller can pass it by
  // accident. See the header contract.
  const area = [
    sanitizeUserText(input.governorate, { max: 40 }),
    sanitizeUserText(input.area, { max: 40 }),
  ]
    .filter(Boolean)
    .join(' — ');
  const landmark = sanitizeUserText(input.landmark, { max: 60 });
  if (area || landmark) out.push(`المنطقة: ${[area, landmark].filter(Boolean).join(' · ')}`);

  // The transport NAME is owner-authored and lives in one place. Re-wording it
  // here would be a second copy to keep in step with the storefront's.
  out.push(`النقل: ${SHIPPING_TYPE_LABELS[normalizeShippingType(input.shippingType)].ar}`);

  const payment = sanitizeUserText(input.paymentMethodId, { max: 40 });
  const fulfilment = sanitizeUserText(input.fulfilmentService, { max: 40 });
  // `hasOwnProperty`, not a bare lookup: `paymentMethodId` is a string that
  // reached us from a request body, and a plain object answers 'constructor'
  // and 'toString' with functions. `${PAYMENT_METHOD_AR['constructor']}` would
  // paste a function body into the group message.
  const payLabel = Object.prototype.hasOwnProperty.call(PAYMENT_METHOD_AR, payment)
    ? PAYMENT_METHOD_AR[payment]
    : payment;
  const meta = [payment ? `الدفع: ${payLabel}` : ''];
  // 'PRO' / 'PRO · 12H' is the vocabulary the admin order board already prints
  // for this column (src/components/adminOrders/OrderBoardBadges.tsx); it is
  // language-neutral on purpose and needs no new wording in any language.
  if (fulfilment === 'pro_priority_12h') meta.push('⚡ PRO · 12H');
  else if (fulfilment === 'pro_priority') meta.push('⚡ PRO');
  const metaLine = meta.filter(Boolean).join(' · ');
  if (metaLine) out.push(metaLine);

  out.push('');
  out.push(`الأصناف (${sellable.length}):`);
  for (const l of shown) {
    const spool = l && l.mystery_spool;
    const name = sanitizeUserText(spool ? spool.name_snapshot : (l && (l.name_ar || l.name)), { max: 60 });
    const variant = sanitizeUserText(spool ? spool.variant_snapshot : l && l.variant, { max: 50 });
    const qtyNum = Number(l && l.qty);
    const qty = Number.isFinite(qtyNum) && qtyNum > 0 ? Math.trunc(qtyNum) : 1;
    const money = iqd(l && (l.line !== undefined && l.line !== null ? l.line : l.line_total_iqd));
    out.push(`• ${name || 'صنف'}${variant ? ` — ${variant}` : ''} × ${qty} — ${money}`);
  }
  if (hidden > 0) out.push(`و ${groupDigits(hidden)} سطر آخر`);

  out.push('');
  out.push(`الإجمالي: ${iqd(input.totalIqd)}`);
  const bnpl = Number(input.bnplIqd);
  if (Number.isFinite(bnpl) && bnpl > 0) {
    const due = sanitizeUserText(input.bnplDueAt, { max: 40 });
    out.push(`الأقساط المؤجلة: ${iqd(bnpl)}${due ? ` — يستحق ${due}` : ''}`);
  } else if (input.dueOnDeliveryIqd !== undefined && input.dueOnDeliveryIqd !== null) {
    out.push(`المستحق عند التسليم: ${iqd(input.dueOnDeliveryIqd)}`);
  }
  if (input.merchantReceivableIqd !== undefined && input.merchantReceivableIqd !== null) {
    out.push(`يستلم التاجر: ${iqd(input.merchantReceivableIqd)}`);
  }

  return out.join('\n');
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
