/**
 * THE PRINTER HOME-DELIVERY ADVANCE — the part that is no longer only a note.
 *
 * The owner's rule: when a printer is sent to a home address, 50,000 IQD is
 * paid from the wallet BEFORE the order exists. Until now the number was
 * display-only — `printerHomeDeliveryNoteIqd` was documented as "never added
 * to any total by any code path" and nothing enforced it, so an order for a
 * 1,525,000 IQD printer went through with an empty wallet.
 *
 * WHY THIS IS NOT PART OF THE SHIPPING FEE ENGINE. That engine already has a
 * printer path with an `advance_required` flag, and it is the wrong lever
 * twice over. Its components only appear when `products.ops_policy.size_class`
 * is set, a field with no writer anywhere in the app; and setting it to reach
 * this rule would switch on the printer FEE mapping, whose amounts are
 * deliberately unconfigured, so every checkout containing a printer would fail
 * with SHIPPING_NEEDS_CONFIG. worker/lib/printerIdentity.ts spells out the same
 * trap for the note. The advance therefore keys off the SAME catalog flag the
 * note, the PLUS gift and the warranty rules already use, and feeds the
 * existing `requiredAdvance` machinery in routes/orders.ts, which debits the
 * wallet and refuses with INSUFFICIENT_BALANCE. No new payment path.
 *
 * PER ORDER, NOT PER PRINTER. The owner's wording is singular — «عند طلب
 * توصيل الطابعة إلى المنزل، يدفع 50,000 د.ع مقدماً» — and a cart with two
 * printers is rare enough that silently asking for 100,000 would be a worse
 * error than asking for 50,000. If the intent is per unit, `units` is already
 * threaded through so the multiplication is a one-line change here.
 *
 * PICKUP IS EXEMPT BY CONSTRUCTION. The rule is about delivering a printer to
 * a home; collecting it from the store is not that, and the note says so too.
 */

export interface PrinterAdvanceInput {
  /** True when any line in the cart is a printer (catalog flag). */
  hasPrinterLine: boolean;
  /** True when the chosen delivery method is store pickup. */
  isPickup: boolean;
  /**
   * The configured advance, from `printerHomeDeliveryNoteIqd`. Null when the
   * owner has cleared it, which switches the requirement off rather than
   * inventing a figure — the same rule `printerNoteIqdFrom` applies to the
   * displayed note, so the screen and the charge can never disagree.
   */
  noteIqd: number | null;
}

/** What must be in the wallet before this order may be created, in IQD. */
export function printerHomeDeliveryAdvanceIqd(input: PrinterAdvanceInput): number {
  if (!input.hasPrinterLine) return 0;
  if (input.isPickup) return 0;
  const amount = input.noteIqd;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) return 0;
  return amount;
}

/**
 * Whether the storefront should present the advance as a REQUIREMENT rather
 * than a note. The two are the same condition; this exists so the checkout
 * screen and the server cannot drift into saying different things.
 */
export function printerAdvanceApplies(input: PrinterAdvanceInput): boolean {
  return printerHomeDeliveryAdvanceIqd(input) > 0;
}
