/**
 * THE LEVONIS INTEGRATION ADAPTERS (docs/PRINT_CLOUD.md §8).
 *
 * Print Cloud lives inside the Levonis Worker, so two integrations are REAL
 * today and say so:
 *
 *   identity      one Levonis account: the customer is the signed-in `users`
 *                 row of the shared session, never a second account;
 *   notification  the Levonis in-app inbox (`user_notifications`).
 *
 * The rest are CONTRACTS with no live implementation, and they say that too
 * (`connected: false`) — nothing here pretends a Levonis wallet charge, order,
 * catalogue sync or accounting entry happened:
 *
 *   wallet_payment  paying with the Levonis wallet (USD cents with holds and an
 *                   FX snapshot) is a separate value system from printing
 *                   hours; the `levonis_wallet` payment method answers 503
 *                   ADAPTER_NOT_CONNECTED until this adapter is built on
 *                   `walletOps` holds through the Ledger boundary.
 *   product_catalog `levonis_product_id` / `levonis_variant_ref` LINK a Print
 *                   Cloud row to a Levonis product; nothing is copied or synced.
 *   inventory       Print Cloud's own warehouse ledger is the source of truth
 *                   while standalone; before go-live with shared stock it must
 *                   become a projection of `inventory_lots` (owner decision).
 *   orders          `pc_integration_events` rows ('orders') wait to be shown in
 *                   the unified Levonis order history.
 *   membership      promotions limited to a membership never apply until the
 *                   tier can be read through the Levonis entitlement rules.
 *   accounting      cash collected, revenue recognised, refunds and buybacks
 *                   are queued ('accounting') for the finance ledger.
 *
 * Outbound events are written in the same batch as the business event, keyed
 * by the event, and stay 'pending' until their adapter is connected.
 */
import type { Stmt } from './db';
import { many } from './db';
import { iso, pcId } from './util';

export type AdapterName = 'identity' | 'notification' | 'wallet_payment' | 'product_catalog' | 'inventory' | 'orders' | 'membership' | 'accounting';

export interface AdapterStatus {
  name: AdapterName;
  connected: boolean;
  implementation: string;
  note: string;
}

export const ADAPTERS: readonly AdapterStatus[] = [
  { name: 'identity', connected: true, implementation: 'levonis_session', note: 'Customers are Levonis users; the shared session cookie identifies them on every host.' },
  { name: 'notification', connected: true, implementation: 'levonis_inbox', note: 'In-app notifications through user_notifications (kind print_cloud).' },
  { name: 'wallet_payment', connected: false, implementation: 'none', note: 'Levonis wallet payments are not wired; the levonis_wallet method answers ADAPTER_NOT_CONNECTED.' },
  { name: 'product_catalog', connected: false, implementation: 'link_only', note: 'Print Cloud products may carry a Levonis product id as a link; no sync.' },
  { name: 'inventory', connected: false, implementation: 'standalone_ledger', note: 'Print Cloud keeps its own warehouse ledger until integrated with inventory_lots.' },
  { name: 'orders', connected: false, implementation: 'outbox', note: 'Order events are queued in pc_integration_events (adapter orders).' },
  { name: 'membership', connected: false, implementation: 'none', note: 'Membership-limited promotions do not apply until connected.' },
  { name: 'accounting', connected: false, implementation: 'outbox', note: 'Accounting events are queued in pc_integration_events (adapter accounting).' },
];

/** MembershipAdapter: the customer's Levonis membership tier, or null — not connected, so always null. */
export async function membershipTier(_db: D1Database, _userId: string): Promise<string | null> {
  return null;
}

export type IntegrationKind =
  | 'order.fulfilled'
  | 'cash.collected'
  | 'revenue.recognized'
  | 'refund.recorded'
  | 'buyback.approved'
  | 'stock.received'
  | 'stock.consumed';

/** One outbound event, keyed by what happened, so a replayed business event cannot queue it twice. */
export function integrationEvent(
  db: D1Database,
  p: { adapter: 'orders' | 'accounting' | 'inventory'; kind: IntegrationKind; refId: string; payload: Record<string, unknown>; now: Date }
): Stmt {
  return db
    .prepare(
      `INSERT OR IGNORE INTO pc_integration_events (id, event_key, adapter, kind, ref_id, payload_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    )
    .bind(pcId('pcie'), `${p.adapter}:${p.kind}:${p.refId}`, p.adapter, p.kind, p.refId, JSON.stringify(p.payload), iso(p.now), iso(p.now));
}

export async function integrationBacklog(db: D1Database) {
  return many<{ adapter: string; kind: string; status: string; n: number }>(
    db,
    'SELECT adapter, kind, status, COUNT(*) AS n FROM pc_integration_events GROUP BY adapter, kind, status ORDER BY adapter, kind, status'
  );
}
