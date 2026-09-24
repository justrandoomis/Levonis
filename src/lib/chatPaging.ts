/**
 * A CONVERSATION READ IN PAGES, NEWEST FIRST — the two rules the chat screen
 * needs to keep what is on screen and what the server returns as one list.
 *
 * `GET /api/chats/:id/messages` answers the NEWEST page of a thread (oldest →
 * newest within it) with an `older_cursor` when more exists, and pages back
 * with `?before=` (worker/routes/chats.ts). It used to answer the OLDEST 500,
 * so a long thread never showed its latest messages at all (audit 04 B5).
 *
 *   • `mergeNewestPage` folds the 5-second poll's newest page into what the
 *     reader already has. Older pages they scrolled back through are KEPT —
 *     the poll must not throw away history they are reading — unless the new
 *     page no longer touches them (more arrived between two polls than one
 *     page holds), in which case keeping them would show a silent gap, and
 *     the list restarts from the newest page with `reset: true`.
 *   • `prependOlder` puts an older page above, dropping any row already shown.
 *
 * Both return the SAME array when nothing changed, so a quiet poll does not
 * re-render the thread.
 */
export interface PagedMessage {
  id: string;
  created_at: string;
}

/** Order by (created_at, id) — the server's keyset order. */
function before(a: PagedMessage, b: PagedMessage): boolean {
  return a.created_at < b.created_at || (a.created_at === b.created_at && a.id < b.id);
}

function sameList<T extends PagedMessage>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((m, i) => m.id === b[i].id);
}

export function mergeNewestPage<T extends PagedMessage>(
  current: T[],
  page: T[],
  hasOlder: boolean
): { messages: T[]; reset: boolean } {
  if (!hasOlder || !page.length) {
    // The page IS the whole thread (or the thread is empty).
    return { messages: sameList(current, page) ? current : page, reset: false };
  }
  const first = page[0];
  const pageIds = new Set(page.map((m) => m.id));
  const kept = current.filter((m) => !pageIds.has(m.id) && before(m, first));
  // A gap: the reader's newest row is older than the page and not in it —
  // more messages arrived than one page holds. Restart from the newest page.
  const touches = current.some((m) => pageIds.has(m.id)) || current.length === 0;
  if (!touches && kept.length) return { messages: page, reset: true };
  const next = [...kept, ...page];
  return { messages: sameList(current, next) ? current : next, reset: false };
}

export function prependOlder<T extends PagedMessage>(current: T[], older: T[]): T[] {
  const have = new Set(current.map((m) => m.id));
  const fresh = older.filter((m) => !have.has(m.id));
  return fresh.length ? [...fresh, ...current] : current;
}
