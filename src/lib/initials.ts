/**
 * The avatar a person has before they upload one: the first grapheme of their
 * name, drawn by us. Never a third-party image service — those received the
 * username with every page view (a privacy leak) and broke when blocked.
 */
export function initialOf(name?: string | null): string {
  const s = (name ?? '').trim();
  if (!s) return '';
  const first = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)[Symbol.iterator]().next().value?.segment
    : undefined;
  return (first ?? Array.from(s)[0]).toLocaleUpperCase();
}
