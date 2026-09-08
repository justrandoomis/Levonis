/**
 * Event → audit entry. One function per event type Audit subscribes to
 * (`packages/contracts/src/subscriptions.ts`, the `audit` rows), each turning a
 * validated payload into the `{action, target, detail}` triple the log records.
 *
 * Pure and synchronous: no database, no clock, no crypto — so the mapping is
 * unit-tested against the committed fixtures directly, and a change to what an
 * admin sees in the log is a change to a function with a test, not to a handler
 * that also writes rows.
 *
 * `AuditRecorded` is the special case: its body does not travel in the envelope
 * (`03-EVENTS.md` §4 — the producer keeps it in `<svc>_audit_details` and it is
 * pruned within 24 h of the ack), so the entry carries the producer's own
 * `detail_hash` and a `detail_ref` pointing at that row. Everything else is
 * derived from the payload, which is already an allowlist, so its body is
 * recorded verbatim.
 */
import type { EventEnvelope } from '@levonis/contracts/envelope';
import type { AuditRecordedV1 } from '@levonis/contracts/events/v1/AuditRecorded';
import type { EventRejectedV1 } from '@levonis/contracts/events/v1/EventRejected';
import type { UserCreatedV1 } from '@levonis/contracts/events/v1/UserCreated';
import type { OrderCreatedV1 } from '@levonis/contracts/events/v1/OrderCreated';
import type { PaymentCompletedV1 } from '@levonis/contracts/events/v1/PaymentCompleted';
import type { RefundCompletedV1 } from '@levonis/contracts/events/v1/RefundCompleted';
import type { RoleChangedV1 } from '@levonis/contracts/events/v1/RoleChanged';
import type { DepositDecidedV1 } from '@levonis/contracts/events/v1/DepositDecided';
import type { WithdrawalStateChangedV1 } from '@levonis/contracts/events/v1/WithdrawalStateChanged';

/** What the log records about one event. `detail_hash` is computed by the caller unless the event supplied one. */
export interface EntryDraft {
  action: string;
  target: string;
  actor_id: string | null;
  detail: Record<string, unknown> | null;
  /** present only for `AuditRecorded`, whose body stayed with the producer */
  detail_hash?: string;
  detail_ref?: string | null;
}

export type EntryMapper = (env: EventEnvelope) => EntryDraft;

const p = <T>(env: EventEnvelope): T => env.payload as T;

export const ENTRY_MAPPERS: Record<string, EntryMapper> = {
  'AuditRecorded.v1': (env) => {
    const a = p<AuditRecordedV1>(env);
    return {
      action: a.action,
      target: a.target,
      actor_id: a.actor_id,
      detail: null, // the body is the producer's row; the hash below is the proof
      detail_hash: a.detail_hash,
      detail_ref: a.detail_ref,
    };
  },

  'EventRejected.v1': (env) => {
    const a = p<EventRejectedV1>(env);
    return {
      action: 'event.rejected',
      target: `event:${a.event_id}`,
      actor_id: null,
      detail: { consumer: a.consumer, reason: a.reason, event_type: a.event_type },
    };
  },

  'UserCreated.v1': (env) => {
    const a = p<UserCreatedV1>(env);
    return {
      action: 'user.created',
      target: `user:${a.user_id}`,
      actor_id: a.user_id,
      detail: { method: a.method, locale: a.locale, email_verified: a.email_verified, referred: a.referrer_code !== null },
    };
  },

  'OrderCreated.v1': (env) => {
    const a = p<OrderCreatedV1>(env);
    return {
      action: 'order.created',
      target: `order:${a.order_id}`,
      actor_id: a.user_id,
      detail: {
        seller_type: a.seller_type,
        merchant_id: a.merchant_id,
        payment_state: a.payment_state,
        total_iqd: a.totals.total_iqd,
        payment_method: a.payment.method,
        items: a.items.length,
      },
    };
  },

  'PaymentCompleted.v1': (env) => {
    const a = p<PaymentCompletedV1>(env);
    return {
      action: 'payment.completed',
      target: `wallet:${a.user_id}`,
      actor_id: a.user_id,
      detail: { kind: a.kind, currency: a.currency, amount: a.amount, order_id: a.order_id, event_key: a.event_key, tx_ids: a.ledger_tx_ids },
    };
  },

  'RefundCompleted.v1': (env) => {
    const a = p<RefundCompletedV1>(env);
    return {
      action: 'refund.completed',
      target: `${a.ref_type}:${a.ref_id}`,
      actor_id: a.user_id,
      detail: { usd_cents: a.usd_cents, points: a.points, event_key: a.event_key, tx_ids: a.ledger_tx_ids },
    };
  },

  'RoleChanged.v1': (env) => {
    const a = p<RoleChangedV1>(env);
    return {
      // the actor is the ADMIN who changed it, not the subject — the whole
      // point of auditing a privilege change
      action: 'user.role_changed',
      target: `user:${a.user_id}`,
      actor_id: a.actor_id,
      detail: { role: a.role, admin_scope: a.admin_scope, is_investor: a.is_investor },
    };
  },

  'DepositDecided.v1': (env) => {
    const a = p<DepositDecidedV1>(env);
    return {
      action: 'wallet.deposit_decided',
      target: `deposit:${a.request_id}`,
      actor_id: a.decided_by,
      detail: { decision: a.decision, usd_cents: a.usd_cents, user_id: a.user_id },
    };
  },

  'WithdrawalStateChanged.v1': (env) => {
    const a = p<WithdrawalStateChangedV1>(env);
    return {
      action: 'wallet.withdrawal_state_changed',
      target: `withdrawal:${a.withdrawal_id}`,
      actor_id: env.actor_id,
      detail: { from: a.from, to: a.to, usd_cents: a.usd_cents, user_id: a.user_id },
    };
  },
};

export const AUDITED_EVENT_KEYS = Object.keys(ENTRY_MAPPERS);
