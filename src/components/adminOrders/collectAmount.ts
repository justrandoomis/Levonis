/**
 * The amount the courier collects at the door, as the order-preparation sheet
 * copies it onto the paper receipt.
 *
 * `total_iqd` still counts money already paid (wallet, Gini) — copying it
 * over-collected every part-prepaid order (owner, 2026-09-25). The stored
 * `due_on_delivery_iqd` is the door amount the sticker, the receipt and the
 * Telegram card print; it is 0 for BNPL (nothing is collected at the door)
 * and does not drop to 0 once a collection is recorded, which is what the
 * sheet needs when the receipt is reprinted. An order read without the
 * financial block falls back to the total.
 */
export function collectOnDeliveryIqd(
  financial: { due_on_delivery_iqd?: number | null } | null | undefined,
  totalIqd: number | null | undefined
): number {
  if (financial) return Math.max(0, Math.trunc(Number(financial.due_on_delivery_iqd) || 0));
  return Math.max(0, Math.trunc(Number(totalIqd) || 0));
}
