/**
 * WHAT A LIST SHOULD SHOW — decided in one place, from three facts.
 *
 * The failure this exists to make impossible: a request fails (the network
 * dropped, the server answered 500), the list is left with its initial `[]`,
 * and the screen says «لا توجد طلبات» — telling a merchant they have no orders
 * when the truth is that nobody could look. An error is NEVER rendered as an
 * empty list, and "not loaded yet" is never rendered as empty either.
 *
 *   rows undefined/null       → not loaded: skeleton (or the error, if it failed)
 *   error, nothing to show     → the error, with retry
 *   error, rows from before    → the rows, marked stale, with the error above
 *   rows = [], no error        → loading ? skeleton : the empty state
 *   rows present               → the rows (refreshing while `loading`)
 */
export type ListView = 'skeleton' | 'error' | 'empty' | 'rows' | 'refreshing' | 'stale';

export function listView(rows: readonly unknown[] | null | undefined, loading: boolean, error: unknown): ListView {
  const failed = error !== undefined && error !== null && error !== false;
  const have = !!rows && rows.length > 0;
  if (failed) return have ? 'stale' : 'error';
  if (!rows) return 'skeleton';
  if (!have) return loading ? 'skeleton' : 'empty';
  return loading ? 'refreshing' : 'rows';
}

/**
 * Which layout a container of `width` px gets. Hysteresis around `wideAt`:
 * a table that grows a scrollbar would otherwise flip to cards, lose the
 * scrollbar, and flip back, forever.
 */
export function isWideLayout(width: number, wideAt: number, wasWide: boolean | null): boolean {
  if (wasWide === null) return width >= wideAt;
  return wasWide ? width >= wideAt - 16 : width >= wideAt;
}
