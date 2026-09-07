/**
 * Orders' RPC surface (`01-TARGET.md` §2.2, §2.4, §6.6) — the core's
 * `OrdersEntrypoint` (read-only methods first, slice 1.6), then Commerce.
 */
import type { Actor, HealthReport, RpcCtx } from './common';

export interface OrderItemRef {
  order_item_id: string;
  product_id: string;
  qty: number;
  unit_price_iqd: number;
  is_printer: boolean;
  warranty_plan_id: string | null;
  ops_policy_id: string | null;
}

export interface ItemSnapshot extends OrderItemRef {
  warranty_snapshot: Record<string, unknown> | null;
  ops_policy: Record<string, unknown> | null;
}

export interface OrdersReadApi {
  canAccessOrder(orderId: string, sub: string, ctx: RpcCtx): Promise<{ allowed: boolean; role: 'owner' | 'merchant' | 'admin' | null }>;
  itemSnapshots(orderId: string, ctx: RpcCtx): Promise<ItemSnapshot[]>;
  health(): Promise<HealthReport>;
}

export interface OrdersApi extends OrdersReadApi {
  applyStage(cmd: { orderId: string; stage: string; status: string; actor: Actor; opId: string }, ctx: RpcCtx): Promise<{ applied: boolean }>;
  applyStatus(cmd: { orderId: string; from: string; to: string; actor: Actor; opId: string }, ctx: RpcCtx): Promise<{ applied: boolean }>;
  createMerchantOrder(cmd: { idempotencyKey: string; userId: string; merchantId: string; storeId: string; items: OrderItemRef[]; totals: Record<string, number>; couponCode: string | null }, ctx: RpcCtx): Promise<{ orderId: string; created: boolean }>;
  cancel(cmd: { orderId: string; actor: Actor; reason: string; opId: string }, ctx: RpcCtx): Promise<{ ok: boolean; code?: 'ORDER_SETTLING' | 'STATE_CONFLICT' | 'FORBIDDEN' }>;
  unblockSaga(cmd: { sagaId: string; actor: Actor; note: string }, ctx: RpcCtx): Promise<{ ok: boolean }>;
}
