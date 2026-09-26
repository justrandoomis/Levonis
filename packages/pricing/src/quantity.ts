/**
 * THE QUANTITY A BUYER TYPES, AND THE MOST THEY MAY HAVE.
 *
 * «في تحديد الكمية … يضغط على الرقم ويكتب الكمية التي يريدها … إذا كان المخزون
 *  ألف قطعة وكتب المستخدم ألف وواحد يرفض ويرجعه إلى ألف، يعني لا يقول له كلا
 *  بل يقوم أوتوماتيكيا بتحديد الكمية إلى أقصى شيء … أما في البيع المسبق فيكون
 *  متاحا.» — the owner.
 *
 * Pure (no DOM, no I/O), so the product page, the cart, the store pages and the
 * Worker read ONE set of rules, and `tests/quantityInput.test.ts` proves them.
 *
 *   · A typed quantity is DIGITS. An Arabic or Kurdish keyboard types ١٢٣ or
 *     ۱۲۳; a paste may carry «1,000» or «١٬٠٠٠». Everything that is not a digit
 *     is dropped — a quantity has no sign, no fraction and no separator.
 *   · Nothing typed is ever refused with a dialog. Empty or unreadable goes
 *     back to what it was; below the floor becomes the floor (1); above the
 *     ceiling becomes the ceiling, and the caller is told it was capped so it
 *     can say «الحد الأقصى المتوفر: 1,000» quietly beside the field.
 *   · The ceiling is the SERVER's `max_qty` for the chosen selection — the
 *     direct-sale shelf for a direct sale, the pre-order quota (or the per-line
 *     ceiling when there is none) for a pre-order. The client never invents it.
 */

/**
 * THE MOST ONE CART LINE MAY HOLD, whatever the sale type.
 *
 * It is the storage limit, not a policy: `cart_items.qty` carries
 * `CHECK (qty > 0 AND qty <= 9999)` since migration 0141 (it was 99 from 0001), so every door that
 * writes a quantity (worker/routes/cart.ts, worker/routes/products.ts) reads
 * THIS constant and a quantity above it is refused with `QTY_UNAVAILABLE`
 * carrying `max_qty` — the same refusal a short shelf gets — rather than a
 * CHECK failure. Raising it is one migration that rebuilds that CHECK plus this
 * one line; nothing else in the stack hard-codes the number.
 */
export const LINE_QTY_MAX = 9999;

/** The longest figure a quantity field accepts while typing (a 7th digit is dropped). */
export const QTY_MAX_DIGITS = 6;

/**
 * The largest figure a door READS as a quantity. Anything above the ceiling
 * but within this is a real request for "that many" and gets the stable
 * `QTY_UNAVAILABLE` answer naming the ceiling; beyond it is not a quantity
 * anyone typed into this field (six digits) and is a plain input refusal (`qty must be between …`).
 */
export const QTY_INPUT_MAX = 999_999;

/** ٠-٩ (U+0660…) and ۰-۹ (U+06F0…) → 0-9, then everything but a digit is dropped. */
export function sanitizeQuantityDraft(raw: string): string {
  const ascii = String(raw ?? '').replace(/[٠-٩۰-۹]/g, (ch) => {
    const c = ch.charCodeAt(0);
    return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
  });
  return ascii.replace(/\D/g, '').slice(0, QTY_MAX_DIGITS);
}

export interface ResolvedQuantity {
  /** The quantity to use. Always an integer in [min, max]. */
  value: number;
  /** True when what was asked for was ABOVE the ceiling and was lowered to it. */
  capped: boolean;
  /** True when what was asked for was below the floor (0) and was raised to it. */
  raised: boolean;
}

/**
 * Clamp a number (a step, a server answer) into [min, max].
 * `max` below `min` (nothing sellable) resolves to `min`; the caller's
 * add-to-cart button is what is disabled in that case, not this figure.
 */
export function clampQuantity(n: number, max: number, min = 1): ResolvedQuantity {
  const floor = Math.max(1, Math.trunc(min) || 1);
  const ceiling = Math.max(floor, Math.trunc(Number.isFinite(max) ? max : floor));
  const whole = Number.isFinite(n) ? Math.trunc(n) : floor;
  if (whole > ceiling) return { value: ceiling, capped: true, raised: false };
  if (whole < floor) return { value: floor, capped: false, raised: true };
  return { value: whole, capped: false, raised: false };
}

/**
 * What a typed draft commits to. `previous` is what the field held before the
 * edit: an empty (or all-garbage) draft goes back to it, never to 0 or to 1.
 */
export function resolveQuantityDraft(draft: string, opts: { max: number; min?: number; previous: number }): ResolvedQuantity {
  const digits = sanitizeQuantityDraft(draft);
  if (digits === '') {
    const back = clampQuantity(opts.previous, opts.max, opts.min);
    return { value: back.value, capped: false, raised: false };
  }
  return clampQuantity(Number(digits), opts.max, opts.min);
}

/** Why the ceiling is where it is — it decides the sentence beside the field. */
export type QuantityLimitKind = 'stock' | 'preorder_quota' | 'per_order';

export interface QuantityLimit {
  max: number;
  kind: QuantityLimitKind;
}

/**
 * The subset of the server's `SaleAvailability` (worker/routes/products.ts)
 * the ceiling is read from. Optional everywhere: a response from an older
 * Worker, or a line with no availability block, still gets a safe answer.
 */
export interface QuantityAvailabilityLike {
  mode?: 'direct_sale' | 'preorder' | 'unavailable' | string;
  stock?: { available?: number | null; max_qty?: number | null } | null;
  preorder?: { capacity?: { available?: number | null; max_qty?: number | null } | null } | null;
}

/**
 * THE CEILING FOR THIS SELECTION, AND WHICH COUNTER SETS IT.
 *
 * `stock.max_qty` is already the server's clamp for the mode it resolved:
 * min(shelf, LINE_QTY_MAX) for a direct sale, min(quota, LINE_QTY_MAX) for a
 * pre-order, the flat pool cap for a mystery member. This function never
 * recomputes it — it only names WHY, so the hint says «المتوفر» for a shelf
 * and «للطلب الواحد» for the per-line ceiling instead of claiming a shelf of 99.
 */
export function quantityLimit(a: QuantityAvailabilityLike | null | undefined, fallbackMax = LINE_QTY_MAX): QuantityLimit {
  const published = a?.stock?.max_qty;
  const max = typeof published === 'number' && Number.isFinite(published) ? Math.max(0, Math.trunc(published)) : fallbackMax;
  if (a?.mode === 'preorder') {
    const quota = a.preorder?.capacity?.available;
    return { max, kind: typeof quota === 'number' && quota <= max ? 'preorder_quota' : 'per_order' };
  }
  const shelf = a?.stock?.available;
  return { max, kind: typeof shelf === 'number' && shelf <= max ? 'stock' : 'per_order' };
}
