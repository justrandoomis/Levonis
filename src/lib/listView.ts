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

/**
 * A TAP ON A ROW OPENS ITS RECORD. On a phone a card is a big target and its
 * title link a small one, so a tap anywhere on the card is passed on to that
 * link (`[data-row-link]`). The link stays the real way in: it is what the
 * keyboard reaches, what a screen reader announces and what opens in a new
 * tab — the row itself gets no role and no tab stop.
 *
 * A tap is NOT passed on when it began on something that acts for itself (a
 * checkbox, a button, a link — the title link included —, a field, a menu or
 * a dialog drawn from the row), when it is not the main button, when someone
 * already handled it, when it ended a text selection, when it came through
 * a portal from outside the row, or when its press closed a menu drawn over
 * the page (that menu has no scrim: the press that closes it is not a tap on
 * the row).
 */
export const ROW_TAP_SKIP =
  'a,button,input,select,textarea,label,summary,[role="button"],[role="checkbox"],[role="switch"],[role="menu"],[role="menuitem"],[role="dialog"],[contenteditable="true"],[data-row-tap-skip]';

export interface RowTap<L> {
  target: { closest(selector: string): unknown } | null;
  row: { contains(node: unknown): boolean; querySelector(selector: string): L | null };
  button: number;
  defaultPrevented: boolean;
  /** The page's selected text when the tap ended. */
  selection: string;
  /** A menu drawn over the page was open when this tap was pressed: the press closed it. */
  closedMenu: boolean;
}

/** The row's link a tap on the row should open, or null to leave the tap alone. */
export function rowTapLink<L>(tap: RowTap<L>): L | null {
  if (tap.defaultPrevented || tap.button !== 0 || tap.selection || tap.closedMenu) return null;
  if (!tap.target || !tap.row.contains(tap.target)) return null;
  if (tap.target.closest(ROW_TAP_SKIP)) return null;
  return tap.row.querySelector('[data-row-link]');
}
