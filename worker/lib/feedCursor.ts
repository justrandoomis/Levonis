/**
 * A FEED PAGES BY (created_at, id), newest first — the storefront's cursor
 * (worker/routes/storefront.ts): `<created_at>|<id>`, so two rows written in
 * the same millisecond can neither repeat nor vanish across a page boundary.
 * A bare timestamp reads as `(timestamp, '')`: strictly older.
 *
 * Used by the community feeds (worker/routes/community.ts) and the request
 * board (worker/routes/marketplace.ts), whose bare-timestamp cursor dropped a
 * request that shared its second with the last one on the page.
 */
export function feedCursor(raw: string | undefined): { at: string; id: string } {
  const v = (raw ?? '').slice(0, 200);
  const bar = v.lastIndexOf('|');
  return bar === -1 ? { at: v, id: '' } : { at: v.slice(0, bar), id: v.slice(bar + 1) };
}

export function nextFeedCursor(rows: Array<Record<string, unknown>>, limit: number): string | null {
  if (rows.length !== limit) return null;
  const last = rows[rows.length - 1];
  return `${String(last.created_at)}|${String(last.id)}`;
}
