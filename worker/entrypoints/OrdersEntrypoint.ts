/**
 * `OrdersEntrypoint` — the read half of the order aggregate (`01-TARGET.md`
 * §2.4, §6.6). Slice 1.6 exposes READ-ONLY methods first, on purpose: they are
 * what the Phase-1 and Phase-4 consumers need (Chat and Files ask whether a
 * person may see an order; Devices asks for the frozen warranty and ops
 * snapshots of a delivered order's lines) and they cannot corrupt anything.
 * The commands — `applyStage`, `applyStatus`, `createMerchantOrder`, `cancel`,
 * `unblockSaga` — arrive with the slices that move their callers (6a, 7.1-7.3,
 * 7b), so a command exists in exactly one place at a time.
 *
 * `itemSnapshots` is why `OrderDelivered` can carry references instead of
 * snapshots: the envelope stays far below the queue message cap and Devices
 * fetches the frozen objects here, idempotently, when it needs them.
 */
import type { ItemSnapshot, OrdersReadApi } from '@levonis/contracts/rpc/orders';
import type { RpcCtx } from '@levonis/contracts/rpc/common';
import { CoreEntrypoint } from './base';

/** A hard cap: an order with more lines than this is answered up to the cap. */
export const MAX_ITEMS = 200;

export class OrdersEntrypoint extends CoreEntrypoint {
  /**
   * May this principal see this order, and as what? The owner, the merchant
   * whose store sold it, and an admin — decided HERE, in SQL, from the order
   * row, never from a role the caller asserts about itself.
   */
  async canAccessOrder(orderId: string, sub: string, ctx?: RpcCtx): Promise<{ allowed: boolean; role: 'owner' | 'merchant' | 'admin' | null }> {
    await this.assertHop('canAccessOrder', [orderId, sub], ctx);
    const env = this.ready();
    const order = await env.DB.prepare('SELECT user_id, merchant_id FROM orders WHERE id = ?')
      .bind(orderId)
      .first<{ user_id: string; merchant_id: string | null }>();
    if (!order) return { allowed: false, role: null };
    if (order.user_id === sub) return { allowed: true, role: 'owner' };
    if (order.merchant_id) {
      const merchant = await env.DB.prepare('SELECT 1 AS x FROM community_merchants WHERE id = ? AND user_id = ?')
        .bind(order.merchant_id, sub)
        .first<{ x: number }>();
      if (merchant) return { allowed: true, role: 'merchant' };
    }
    const admin = await env.DB.prepare("SELECT 1 AS x FROM users WHERE id = ? AND role = 'admin'").bind(sub).first<{ x: number }>();
    return admin ? { allowed: true, role: 'admin' } : { allowed: false, role: null };
  }

  /** The frozen per-line objects: the warranty and ops policy AS SOLD, never as configured today. */
  async itemSnapshots(orderId: string, ctx?: RpcCtx): Promise<ItemSnapshot[]> {
    await this.assertHop('itemSnapshots', [orderId], ctx);
    const env = this.ready();
    const { results } = await env.DB.prepare(
      `SELECT oi.id, oi.product_id, oi.qty, oi.unit_price_iqd, oi.warranty_snapshot, p.ops_policy,
              EXISTS (SELECT 1 FROM product_catalogs pc
                        JOIN catalogs c ON c.id = pc.catalog_id AND c.is_printer_catalog = 1
                       WHERE pc.product_id = oi.product_id) AS is_printer
         FROM order_items oi
         LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ?
        LIMIT ?`
    )
      .bind(orderId, MAX_ITEMS)
      .all<{
        id: string;
        product_id: string;
        qty: number;
        unit_price_iqd: number;
        warranty_snapshot: string | null;
        ops_policy: string | null;
        is_printer: number;
      }>();
    return (results ?? []).map((r) => {
      const warranty = parseObject(r.warranty_snapshot);
      return {
        order_item_id: String(r.id),
        product_id: String(r.product_id),
        qty: Math.max(1, Number(r.qty) || 1),
        unit_price_iqd: Math.max(0, Math.round(Number(r.unit_price_iqd) || 0)),
        is_printer: !!Number(r.is_printer),
        warranty_plan_id: typeof warranty?.plan_id === 'string' && warranty.plan_id ? warranty.plan_id : null,
        ops_policy_id: null,
        warranty_snapshot: warranty,
        ops_policy: parseObject(r.ops_policy),
      };
    });
  }
}

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Compile-time proof against `packages/contracts/src/rpc/orders.ts`. */
export const _ordersContract: (e: OrdersEntrypoint) => OrdersReadApi = (e) => e;
