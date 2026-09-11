/**
 * THE REVEAL STATE MACHINE (docs/BUNDLES_MYSTERY.md §8).
 *
 *   allocated ──(milestone reached)──▶ revealed        monotone, never back
 *
 * Two facts decide it and nothing else: `mystery_allocations.revealed_at`,
 * which once written IS the truth, and a pure derivation over the milestone
 * FROZEN ONTO THE ALLOCATION at draw time. Neither reads a config row, which
 * is the whole point:
 *
 *  - `bundle_config.reveal_stage` is ONE MUTABLE ROW shared by every past and
 *    in-flight order of that offer. Editing it from 'paid' to 'delivered'
 *    would retroactively hide picks customers have already been shown; from
 *    'delivered' to 'paid' it would reveal every in-flight order at once. So
 *    the milestone an order was SOLD UNDER is copied onto its allocation and
 *    read from there for ever (§8.1) — a later config edit changes what future
 *    orders are sold under and cannot move an existing order's milestone in
 *    either direction.
 *
 *  - An admin moving a stage backwards (`canMoveStage` allows one step) does
 *    NOT un-reveal. Un-telling a customer what they bought would be the worse
 *    lie, and the same rule already governs delivered effects.
 *
 * The derivation compares STAGE INDICES WITHIN `stagesFor(shipping_type)`, so
 * the five-stage direct path and the fourteen-stage pre-order path both work
 * with one table and no second mapping.
 *
 * Everything customer-facing is routed through `mysteryProjection` on the way
 * out — every mystery row, always — rather than relying on the NULL
 * `product_id` to do the work. The NULL makes most of §8.2 structural; this
 * function makes the rest of it a single place to audit.
 */

import { stageLabel, stagesFor, type OrderStage } from './orderStages';
import type { ShippingType } from './shippingType';

export type RevealStage = 'paid' | 'confirmed' | 'preparing' | 'shipped' | 'delivered';

export const REVEAL_STAGES: RevealStage[] = ['paid', 'confirmed', 'preparing', 'shipped', 'delivered'];

/** The default is the LATEST milestone: an offer whose configuration says
 *  nothing reveals as late as possible, never as early as possible. */
export const DEFAULT_REVEAL_STAGE: RevealStage = 'delivered';

export function normalizeRevealStage(raw: unknown): RevealStage {
  const v = String(raw ?? '').trim();
  return (REVEAL_STAGES as string[]).includes(v) ? (v as RevealStage) : DEFAULT_REVEAL_STAGE;
}

/**
 * The ORDER STAGE that satisfies a milestone on a given journey — §8.1's
 * table, and the only place the `'preparing' → supplier_preparing` mapping is
 * written. `'paid'` is not a stage at all (it is a settlement fact), and a
 * milestone whose stage is not on this journey returns null and is never
 * reached by a stage move.
 */
export function stageForMilestone(milestone: RevealStage, shippingType: ShippingType): OrderStage | null {
  switch (milestone) {
    case 'paid':
      return null;
    case 'confirmed':
      return 'confirmed';
    case 'preparing':
      return shippingType === 'direct' ? 'preparing' : 'supplier_preparing';
    case 'shipped':
      return 'out_for_delivery';
    case 'delivered':
      return 'delivered';
    default:
      return null;
  }
}

export interface RevealOrderFacts {
  stage: string;
  status: string;
  shipping_type: ShippingType;
}

/**
 * Has `order` reached `milestone`? Pure, database-free, and incapable of
 * disagreeing between two screens.
 *
 * `paid` is the settlement fact the caller supplies: the wallet debit at
 * creation (a fully prepaid order settles at purchase) or a recorded
 * `POST /api/orders/:id/settlement` for a cash-on-delivery one.
 */
export function milestoneReached(milestone: RevealStage, order: RevealOrderFacts, paid: boolean): boolean {
  if (milestone === 'paid') return paid;
  const path = stagesFor(order.shipping_type);
  const want = stageForMilestone(milestone, order.shipping_type);
  if (!want) return false;
  const wantIdx = path.indexOf(want);
  const atIdx = path.indexOf(order.stage as OrderStage);
  if (wantIdx < 0 || atIdx < 0) return false;
  return atIdx >= wantIdx;
}

export interface RevealAllocation {
  revealed_at: string | null;
  reveal_stage_snapshot: string;
}

/** `revealed_at !== null || derive(reveal_stage_snapshot, order, paid)`. */
export function isRevealed(allocation: RevealAllocation, order: RevealOrderFacts, paid: boolean): boolean {
  if (allocation.revealed_at) return true;
  return milestoneReached(normalizeRevealStage(allocation.reveal_stage_snapshot), order, paid);
}

/**
 * Which milestones a given order state satisfies — the set the stamping
 * statement narrows on, so one UPDATE stamps every allocation whose milestone
 * the order has just crossed and touches none of the others.
 */
export function reachedMilestones(order: RevealOrderFacts, paid: boolean): RevealStage[] {
  return REVEAL_STAGES.filter((m) => milestoneReached(m, order, paid));
}

// ------------------------------------------------------------- the payload

export interface AllocationRow {
  order_item_id: string;
  spool_index: number;
  order_id: string;
  offer_product_id: string;
  pool_id: string;
  pool_entry_id: string;
  product_id: string;
  option_value_ids: string;
  color_id: string;
  name_snapshot: string;
  image_snapshot: string;
  variant_snapshot: string;
  sale_mode: string;
  reveal_stage_snapshot: string;
  revealed_at: string | null;
  created_at?: string;
  /** Present only where the caller joined it; never in a customer payload. */
  product_slug?: string | null;
}

export interface MysteryBlock {
  revealed: boolean;
  spools: number;
  reveal_at: RevealStage;
  reveal_stage_label?: string;
  revealed_at?: string | null;
  sale_mode?: string;
  /** The picks. ABSENT — not empty, not nulled — on a customer payload before
   *  the milestone. An admin always gets them (§8.2). */
  picks?: Array<{
    spool_index: number;
    product_id: string;
    product_slug?: string | null;
    name: string;
    image: string;
    variant: string;
    color_id: string;
    option_value_ids: string[];
  }>;
  /** Admin only: the pick is on the screen but the customer has not seen it. */
  pending_customer_reveal?: boolean;
}

const parseIds = (raw: unknown): string[] => {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

/**
 * THE ONE PROJECTION every mystery row leaves the server through (§8.2).
 *
 * Before the milestone a customer payload may carry only
 * `{ revealed: false, spools, reveal_at }` — not a product id, not a name, not
 * a slug, not an image URL, not an R2 key, not a colour hex, not a stock
 * delta, not a weight, not a pool id. `picks` is therefore ABSENT rather than
 * emptied: a key that exists and is sometimes populated is a key a future
 * refactor fills in by accident.
 *
 * `viewer: 'admin'` always carries the picks — operational access is the
 * justification for admins holding this data at all, and `OrderDetailModal`
 * renders it with a "not yet revealed to the customer" chip driven by
 * `pending_customer_reveal`.
 */
export function mysteryProjection(
  allocations: AllocationRow[],
  ctx: { order: RevealOrderFacts; paid: boolean; lang?: string },
  viewer: 'customer' | 'admin'
): MysteryBlock | null {
  if (allocations.length === 0) return null;
  const first = allocations[0];
  const milestone = normalizeRevealStage(first.reveal_stage_snapshot);
  // ONE verdict for the line: every spool of one line shares its milestone
  // (they were drawn together, under one snapshot), so a half-revealed line
  // cannot exist and no screen has to decide what it would mean.
  const revealed = allocations.every((a) => isRevealed(a, ctx.order, ctx.paid));
  const stage = stageForMilestone(milestone, ctx.order.shipping_type);
  const block: MysteryBlock = {
    revealed,
    spools: allocations.length,
    reveal_at: milestone,
    reveal_stage_label: stage ? stageLabel(stage, ctx.order.shipping_type, ctx.lang ?? 'ar') : undefined,
    sale_mode: first.sale_mode,
  };
  if (viewer === 'customer' && !revealed) return block;
  if (viewer === 'admin') block.pending_customer_reveal = !revealed;
  if (revealed) block.revealed_at = allocations.map((a) => a.revealed_at).find((x) => !!x) ?? null;
  block.picks = allocations
    .slice()
    .sort((a, b) => a.spool_index - b.spool_index)
    .map((a) => ({
      spool_index: a.spool_index,
      product_id: a.product_id,
      ...(viewer === 'admin' ? { product_slug: a.product_slug ?? null } : {}),
      name: a.name_snapshot,
      image: a.image_snapshot,
      variant: a.variant_snapshot,
      color_id: a.color_id,
      option_value_ids: parseIds(a.option_value_ids),
    }));
  return block;
}

// ------------------------------------------------------------- persistence

const allocationSelect = (withSlug: boolean) => `SELECT a.order_item_id, a.spool_index, a.order_id,
         a.offer_product_id, a.pool_id, a.pool_entry_id, a.product_id, a.option_value_ids, a.color_id,
         a.name_snapshot, a.image_snapshot, a.variant_snapshot, a.sale_mode, a.reveal_stage_snapshot,
         a.revealed_at, a.created_at${withSlug ? ', p.slug AS product_slug' : ''}
    FROM mystery_allocations a${withSlug ? ' LEFT JOIN products p ON p.id = a.product_id' : ''}`;

export const ALLOCATION_SELECT = allocationSelect(false);

/**
 * Allocations of one or more orders, grouped by the `order_items.id` they hang
 * from. The `products` join is ADMIN-ONLY and off by default — a customer
 * payload has no use for the drawn product's live slug even after the reveal
 * (the frozen snapshots are what it renders), and a join that is never made
 * cannot leak.
 */
export async function loadAllocations(
  db: D1Database,
  orderIds: string[],
  opts: { withSlug?: boolean } = {}
): Promise<Map<string, AllocationRow[]>> {
  const out = new Map<string, AllocationRow[]>();
  const ids = [...new Set(orderIds.filter(Boolean))];
  if (ids.length === 0) return out;
  for (let i = 0; i < ids.length; i += 20) {
    const part = ids.slice(i, i + 20);
    const { results } = await db
      .prepare(
        `${allocationSelect(opts.withSlug === true)} WHERE a.order_id IN (${part
          .map(() => '?')
          .join(', ')}) ORDER BY a.spool_index`
      )
      .bind(...part)
      .all<AllocationRow>();
    for (const r of results ?? []) {
      const key = String(r.order_item_id);
      const list = out.get(key);
      if (list) list.push(r);
      else out.set(key, [r]);
    }
  }
  return out;
}

/**
 * Is this order PAID, for the `'paid'` milestone? The recorded collections
 * covering the total — the same predicate `buildSettlementStatements` uses to
 * settle a points accrual, so "paid" means one thing in this codebase.
 *
 * A fully prepaid order records its purchase settlement inside the checkout
 * batch, so it is paid the instant it exists; a cash-on-delivery order becomes
 * paid when `POST /api/orders/:id/settlement` records the collection.
 */
export async function paidOrderIds(db: D1Database, orderIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const ids = [...new Set(orderIds.filter(Boolean))];
  if (ids.length === 0) return out;
  for (let i = 0; i < ids.length; i += 20) {
    const part = ids.slice(i, i + 20);
    const { results } = await db
      .prepare(
        `SELECT o.id AS id FROM orders o
          WHERE o.id IN (${part.map(() => '?').join(', ')})
            AND (SELECT COALESCE(SUM(s.amount_iqd), 0) FROM order_payment_settlements s WHERE s.order_id = o.id)
                >= o.total_iqd`
      )
      .bind(...part)
      .all<{ id: string }>();
    for (const r of results ?? []) out.add(String(r.id));
  }
  return out;
}

/**
 * THE STAMP. `revealed_at` is written the first time the derivation returns
 * true and is NEVER cleared, which is what makes reveal monotone against a
 * later backwards stage move and against an edit of the offer's configuration.
 *
 * `WHERE revealed_at IS NULL` makes it idempotent, and the milestone list is
 * computed from the order state the caller is committing — so the statement
 * can ride inside that caller's own batch and reveal exactly when the order
 * actually moves, never before and never in a second write nobody rolls back.
 */
export function revealStampStatement(
  db: D1Database,
  orderId: string,
  milestones: RevealStage[],
  nowIso: string,
  /**
   * The stage the caller is committing in this same batch. When given, the
   * stamp re-reads `orders.stage` INSIDE the transaction and applies only if
   * the flip actually landed — so a mover that lost the conditional-update
   * race stamps nothing, rather than revealing on a move that never happened.
   */
  expectStage?: string
): D1PreparedStatement | null {
  if (milestones.length === 0) return null;
  const guard = expectStage === undefined ? '' : ' AND (SELECT o.stage FROM orders o WHERE o.id = ?) = ?';
  return db
    .prepare(
      `UPDATE mystery_allocations
          SET revealed_at = ?
        WHERE order_id = ? AND revealed_at IS NULL
          AND reveal_stage_snapshot IN (${milestones.map(() => '?').join(', ')})${guard}`
    )
    .bind(nowIso, orderId, ...milestones, ...(expectStage === undefined ? [] : [orderId, expectStage]));
}
