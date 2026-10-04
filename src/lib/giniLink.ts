/** Only an absolute web link can truthfully open this product in the bank's app. */
export function giniLinkOf(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return /^https?:\/\//i.test(value) ? value : '';
}
