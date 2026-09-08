/**
 * The bus consumers (`03-EVENTS.md` §2.3) for the four types
 * `02-MIGRATION-PLAN.md` slice 1.7 names: `UserCreated{verify}`,
 * `OrderCreated`, `DepositDecided` and `RequestPublished`.
 *
 * Every handler returns STATEMENTS. They go into the same `db.batch()` as the
 * `notifications_processed_events` row, so the inbox row and the "I have seen
 * this event" record commit together or not at all — a redelivery is then a
 * `replayed` ack with no second message, and a crash between them cannot leave
 * an event acked with nothing to show for it.
 *
 * Every `event_key` is derived from the EVENT (`order:<id>:created`,
 * `deposit:<id>:approved`), never from request input, and the two UNIQUE
 * constraints — `notify_outbox.event_key` and
 * `user_notifications (user_id, event_key)` — make a duplicate message
 * impossible at the database rather than unlikely in the code.
 *
 * `piiMax: 'personal'`: unlike Ads, this service is allowed the personal
 * envelopes (`DepositDecided` is one), because telling a person about their own
 * money is the whole point of it.
 */
import { defineConsumer, type Consumer, type EventHandler, type HandlerContext } from '@levonis/platform-kit/consumer';
import type { EventEnvelope } from '@levonis/contracts/envelope';
import type { KeyRing } from '@levonis/platform-kit/keys';
import type { Logger } from '@levonis/platform-kit/log';
import { enqueueStatement, notifyStatement } from './store';
import { depositDecidedInApp, emailLink, orderCreatedAdmin, orderCreatedInApp, requestPublishedInApp, verifyEmail } from './templates';

/** Exactly the four types this slice handles. The rest of `subscriptions.ts` lands in Phase 4. */
export const NOTIFICATION_EVENT_TYPES = ['UserCreated.v1', 'OrderCreated.v1', 'DepositDecided.v1', 'RequestPublished.v1'] as const;

/**
 * How a recipient is found.
 *
 * `UserCreated` carries no contact — deliberately: `03-EVENTS.md` §1 forbids a
 * raw address in any envelope, and Identity is the owner of the contacts. From
 * Phase 4 this is `IDENTITY.contactFor` over a service binding. Until that
 * binding exists the resolver is ABSENT, and the handler records the event
 * honestly as a `skipped` outbox row rather than inventing a recipient or
 * silently dropping the fact that a signup happened.
 */
export interface ContactResolver {
  contactFor(userId: string): Promise<{ email: string | null; locale: 'ar' | 'en' | 'ckb' } | null>;
  /** the verification link Identity mints; this service never mints one */
  verifyLinkFor(userId: string): Promise<string | null>;
}

export interface NotificationsConsumerOptions {
  keys: KeyRing;
  env: Record<string, string | undefined>;
  contacts?: ContactResolver;
  acceptFixtureSig?: boolean;
  log?: Logger;
  now?: () => string;
}

type Payload = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0);

/** `UserCreated` — the verification mail. */
function userCreated(opts: NotificationsConsumerOptions): EventHandler {
  return async (event: EventEnvelope, ctx: HandlerContext) => {
    const p = event.payload as Payload;
    const userId = str(p.user_id);
    if (!userId || p.email_verified === true) return [];
    const eventKey = `user:${userId}:verify`;
    const contact = opts.contacts ? await opts.contacts.contactFor(userId) : null;
    const link = opts.contacts ? await opts.contacts.verifyLinkFor(userId) : null;
    if (!contact?.email || !link) {
      // Recorded, not sent, and the row says why — the core's own
      // `enqueue(..., { state: 'skipped', note })` semantics.
      return [
        enqueueStatement(
          ctx.db,
          eventKey,
          { kind: 'email', to: '', subject: '', html: '', text: '' },
          { state: 'skipped', note: 'NO_CONTACT_RESOLVER: IDENTITY.contactFor is bound in Phase 4', at: ctx.now }
        ).stmt,
      ];
    }
    const locale = (p.locale === 'ar' || p.locale === 'ckb' || p.locale === 'en' ? p.locale : 'en') as 'ar' | 'en' | 'ckb';
    const absolute = emailLink(opts.env.APP_ORIGIN, link);
    return [enqueueStatement(ctx.db, eventKey, verifyEmail(contact.email, absolute, locale), { at: ctx.now }).stmt];
  };
}

/** `OrderCreated` — the customer's in-app row, and the admin group message. */
function orderCreated(opts: NotificationsConsumerOptions): EventHandler {
  return async (event: EventEnvelope, ctx: HandlerContext) => {
    const p = event.payload as Payload;
    const orderId = str(p.order_id);
    const userId = str(p.user_id);
    if (!orderId || !userId) return [];
    const statements: D1PreparedStatement[] = [notifyStatement(ctx.db, orderCreatedInApp(userId, orderId, `order:${orderId}:created`), ctx.now).stmt];

    // The admin message goes only to the configured group. Without the chat id
    // there is no recipient, so there is no row: `notifyAdmins()` in the core
    // returns false in exactly this case, and a row addressed to nobody is a
    // stub, not a record.
    const chatId = (opts.env.TELEGRAM_ADMIN_CHAT_ID ?? '').trim();
    if (chatId) {
      const totals = (p.totals ?? {}) as Payload;
      statements.push(
        enqueueStatement(ctx.db, `order:${orderId}:admin`, orderCreatedAdmin(chatId, orderId, int(totals.total_iqd), str(p.seller_type) || 'platform'), { at: ctx.now }).stmt
      );
    }
    return statements;
  };
}

/** `DepositDecided` — the customer's in-app row. Personal; never reaches Analytics or Ads. */
function depositDecided(): EventHandler {
  return async (event: EventEnvelope, ctx: HandlerContext) => {
    const p = event.payload as Payload;
    const userId = str(p.user_id);
    const requestId = str(p.request_id);
    const decision = p.decision === 'approved' ? 'approved' : 'rejected';
    if (!userId || !requestId) return [];
    return [notifyStatement(ctx.db, depositDecidedInApp(userId, requestId, decision, int(p.usd_cents), `deposit:${requestId}:${decision}`), ctx.now).stmt];
  };
}

/**
 * `RequestPublished` — one inbox row per matched merchant.
 *
 * The event key is the REQUEST, shared by every merchant: two merchants must
 * both be told about the same request, and `UNIQUE (user_id, event_key)` is
 * what allows that while still refusing to tell one merchant twice
 * (`migrations/0045_print_requests.sql`).
 */
function requestPublished(): EventHandler {
  return async (event: EventEnvelope, ctx: HandlerContext) => {
    const p = event.payload as Payload;
    const requestId = str(p.request_id);
    const merchants = Array.isArray(p.matched_merchant_ids) ? (p.matched_merchant_ids as unknown[]).filter((m): m is string => typeof m === 'string') : [];
    if (!requestId || merchants.length === 0) return [];
    return merchants.map((m) => notifyStatement(ctx.db, requestPublishedInApp(m, requestId, `request:${requestId}`), ctx.now).stmt);
  };
}

export function createNotificationsConsumer(opts: NotificationsConsumerOptions): Consumer {
  return defineConsumer({
    name: 'notifications',
    piiMax: 'personal',
    keys: opts.keys,
    handlers: {
      'UserCreated.v1': userCreated(opts),
      'OrderCreated.v1': orderCreated(opts),
      'DepositDecided.v1': depositDecided(),
      'RequestPublished.v1': requestPublished(),
    },
    acceptFixtureSig: opts.acceptFixtureSig,
    now: opts.now,
    log: opts.log,
  });
}
