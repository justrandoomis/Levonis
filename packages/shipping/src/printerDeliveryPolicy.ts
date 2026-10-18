/**
 * RETIRED (owner, 2026-10-18): personal delivery was cancelled, so the
 * transport warning a printer sent by standard delivery had to be accepted
 * at checkout — written for a customer who could still pick personal
 * delivery instead — is no longer shown, asked for or required. The text stays
 * as the record of what an older order accepted: its frozen acceptance lives
 * in `orders.delivery_method_snapshot.printer_standard_transport_acceptance`
 * and an older client may still send `printerStandardDeliveryAcceptance`,
 * which the server now ignores.
 */
export const PRINTER_STANDARD_DELIVERY_POLICY = Object.freeze({
  key: 'printer_standard_transport',
  version: 1,
  text_ar: 'قد يتعرض الطلب لأضرار أثناء التوصيل العادي، ولا نتحمل مسؤولية أضرار النقل. عند حدوث ضرر أثناء التوصيل لا يشمل الطلب الاسترجاع المجاني.',
});

/** Preserve an explicit valid choice; otherwise the first priced method, then the first visible one. */
export function chooseDeliveryMethod(current: string, available: readonly string[],
  fees?: ReadonlyArray<{ id: string; available: boolean }>): string {
  if (available.includes(current)) return current;
  // Quote errors affect the initial preference, never the visible methods.
  // If all fees need configuration, keep a stable method so its quote can
  // explain the blocker instead of clearing/re-creating the quote forever.
  const priced = available.filter((id) => !fees?.some((fee) => fee.id === id && !fee.available));
  const defaults = priced.length ? priced : available;
  return defaults[0] ?? '';
}
