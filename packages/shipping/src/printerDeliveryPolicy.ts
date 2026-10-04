/** Conditional store policy for a printer consignment sent by standard delivery. */
export const PRINTER_STANDARD_DELIVERY_POLICY = Object.freeze({
  key: 'printer_standard_transport',
  version: 1,
  text_ar: 'قد يتعرض الطلب لأضرار أثناء التوصيل العادي، ولا نتحمل مسؤولية أضرار النقل. عند حدوث ضرر أثناء التوصيل لا يشمل الطلب الاسترجاع المجاني.',
});

export function requiresPrinterStandardAcceptance(method: string, containsPrinter: boolean): boolean {
  return method === 'standard' && containsPrinter;
}

export function isPrinterStandardAcceptance(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const acceptance = value as Record<string, unknown>;
  return acceptance.accepted === true && acceptance.version === PRINTER_STANDARD_DELIVERY_POLICY.version;
}

/** Preserve an explicit valid choice; prefer personal delivery for a printer on initial selection. */
export function chooseDeliveryMethod(current: string, available: readonly string[], containsPrinter: boolean,
  fees?: ReadonlyArray<{ id: string; available: boolean }>): string {
  if (available.includes(current)) return current;
  // Quote errors affect the initial preference, never the visible methods.
  // If all fees need configuration, keep a stable method so its quote can
  // explain the blocker instead of clearing/re-creating the quote forever.
  const priced = available.filter((id) => !fees?.some((fee) => fee.id === id && !fee.available));
  const defaults = priced.length ? priced : available;
  if (containsPrinter && defaults.includes('personal')) return 'personal';
  return defaults[0] ?? '';
}

/** An acknowledgment belongs to this selection and version, never to a later cart or address. */
export function printerStandardAcceptanceContext(method: string, printer: boolean, address: string, items: string, version: number, locale: string): string | null {
  return requiresPrinterStandardAcceptance(method, printer) ? JSON.stringify([method, address, items, version, locale]) : null;
}
