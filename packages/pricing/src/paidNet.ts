/**
 * «ما دفعه فعلاً» — WHAT A CUSTOMER ACTUALLY PAID FOR ONE UNIT OF A LINE.
 *
 * Services V2 plan §3.2: one definition for every service that pays back, or
 * credits against, a purchase — price protection, trade-in and (later) the
 * return refund and the finance cross-check — so that no two of them can
 * disagree about the same unit:
 *
 *     unit merchandise (no warranty fee, no transport fee)
 *   − the frozen line membership
 *   − the line's own discount (`order_items.coupon_discount_iqd`: a targeted
 *     code or a perk, once a writer exists)
 *   − the line's share of the order-level coupon RESIDUAL and of the points
 *     spent (the residual is the order coupon less every line's own discount,
 *     so a code that is allocated to lines is never subtracted twice —
 *     correction 2 of the plan)
 *   + the line's share of an accepted price adjustment (signed)
 *
 * The coupon and points shares are weighed by the line's gross over
 * subtotal + delivery, the established split (a coupon may cover part of the
 * delivery fee, and delivery is not a unit's price).
 *
 * A TRADE-IN CREDIT IS PAYMENT, NOT A DISCOUNT (owner decision 5): an order
 * paid partly with one passes it as `paid_in_kind_iqd` and not as a coupon;
 * it is not subtracted, and the ceiling below is the total plus that credit.
 *
 * NEVER MORE THAN WAS PAID. When the lines add up to more than the order's
 * total (plus a credit paid in kind) — a final-price cut that reached the
 * delivery fee, for instance — the total is spread exactly across them.
 *
 * Pure integer dinars: no I/O. The worker reads the facts
 * (worker/lib/paidNet.ts); this decides.
 */

export interface PaidNetOrderFacts {
  subtotal_iqd: number;
  shipping_iqd: number;
  /** What the order charged, after coupon and points (`orders.total_iqd`). */
  total_iqd: number;
  /** The order-level coupon (`coupon_snapshot.discount_iqd`), 0 when that coupon is a trade-in credit. */
  order_coupon_iqd: number;
  /** Points spent on the order (1 point = 1 IQD). */
  points_iqd: number;
  /** A trade-in credit that paid part of the order: counts as paid (decision 5). */
  paid_in_kind_iqd?: number;
}

export interface PaidNetLineFacts {
  id: string;
  qty: number;
  /** The line's gross — unit price × qty, or a bundle component's allocation: the weight of its shares. */
  gross_iqd: number;
  /** The line's merchandise, whole line: gross without warranty or transport fees. */
  merchandise_iqd: number;
  /** The frozen line membership saving (whole line). */
  membership_iqd: number;
  /** The line's own discount (`order_items.coupon_discount_iqd`). */
  line_discount_iqd: number;
  /** The line's share of an accepted price adjustment (signed). */
  price_adjustment_iqd: number;
}

const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0);
const nonNeg = (v: unknown): number => Math.max(0, int(v));

/**
 * Exact integer split of `total` by `weights` (largest remainder, ties to the
 * earlier line) — the same rule as the finance report's `allocateExact`.
 */
export function splitExact(total: number, weights: readonly number[]): number[] {
  const t = BigInt(nonNeg(total));
  if (!weights.length) return [];
  const w = weights.map((x) => BigInt(nonNeg(x)));
  const sum = w.reduce((a, b) => a + b, 0n);
  const basis = sum > 0n ? w : w.map(() => 1n);
  const den = sum > 0n ? sum : BigInt(basis.length);
  const shares = basis.map((x) => (t * x) / den);
  const ranked = basis
    .map((x, i) => ({ i, rem: (t * x) % den }))
    .sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  let left = t - shares.reduce((a, b) => a + b, 0n);
  for (const r of ranked) {
    if (left <= 0n) break;
    shares[r.i] += 1n;
    left -= 1n;
  }
  return shares.map(Number);
}

/** floor(a × b ÷ c) in exact integers (dinar products can pass 2^53). */
const mulDiv = (a: number, b: number, c: number): number => (c > 0 ? Number((BigInt(a) * BigInt(b)) / BigInt(c)) : 0);

/** Each line's paid net, whole line, in the order given. */
export function paidNetLines(order: PaidNetOrderFacts, lines: readonly PaidNetLineFacts[]): number[] {
  const ownDiscounts = lines.reduce((s, l) => s + nonNeg(l.line_discount_iqd), 0);
  const residual = Math.max(0, nonNeg(order.order_coupon_iqd) - ownDiscounts);
  const shared = residual + nonNeg(order.points_iqd);
  const basis = nonNeg(order.subtotal_iqd) + nonNeg(order.shipping_iqd);
  const paid = lines.map((l) => {
    const share = mulDiv(shared, nonNeg(l.gross_iqd), basis);
    return Math.max(
      0,
      nonNeg(l.merchandise_iqd) - nonNeg(l.membership_iqd) - nonNeg(l.line_discount_iqd) - share + int(l.price_adjustment_iqd)
    );
  });
  const ceiling = nonNeg(order.total_iqd) + nonNeg(order.paid_in_kind_iqd);
  const total = paid.reduce((a, b) => a + b, 0);
  return total > ceiling ? splitExact(ceiling, paid) : paid;
}

/** ONE unit of `lineId`: the line's paid net over its quantity, rounded down. Null when the line is not in the order. */
export function paidNetPerUnit(order: PaidNetOrderFacts, lines: readonly PaidNetLineFacts[], lineId: string): number | null {
  const index = lines.findIndex((l) => l.id === lineId);
  if (index < 0) return null;
  const qty = Math.max(1, nonNeg(lines[index].qty));
  return Math.floor(paidNetLines(order, lines)[index] / qty);
}
