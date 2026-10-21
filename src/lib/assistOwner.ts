/**
 * WHOSE SUPPORT CONVERSATION THIS TAB HOLDS, and nothing else.
 *
 * The auth layer (src/AuthContext.tsx) calls `adoptAssistOwner` on every
 * identity change, so this module is part of the entry chunk: it imports
 * nothing and holds only the owner stamp and the drop. The conversation itself
 * (load and save) stays in src/lib/assistSession.ts, which only the lazy
 * Support page imports. tests/bundleBudget.test.ts measures the entry.
 */
/** The server context and the rest of the conversation (src/lib/assistSession.ts reads and writes them). */
export const ASSIST_CONTEXT_KEY = 'levonis.assist.v1';
export const ASSIST_STATE_KEY = 'levonis.assist.state.v1';
/** The signed-in id the conversation was held for, or '' for a guest. */
const OWNER_KEY = 'levonis.assist.owner.v1';
/** Dispatched on `window` when the stored conversation was dropped, so an open Support page resets too. */
export const ASSIST_CLEARED_EVENT = 'levonis:assist-cleared';

/** Drops the transcript, the draft, the attachment keys and the context, for this tab. */
export function clearAssistSession(): void {
  try {
    sessionStorage.removeItem(ASSIST_CONTEXT_KEY);
    sessionStorage.removeItem(ASSIST_STATE_KEY);
  } catch {
    // Storage refused: nothing was kept to drop.
  }
  try {
    window.dispatchEvent(new Event(ASSIST_CLEARED_EVENT));
  } catch {
    // No window (a test or a worker): there is no page to reset.
  }
}

/**
 * A SIGNED-IN CONVERSATION NEVER PASSES TO ANOTHER IDENTITY.
 *
 * Signing out navigates inside the app, without a reload, and the storage of
 * this tab kept the transcript (order ids, order status, the masked device
 * names, the lines the customer typed), the ticket draft with its device,
 * the attachment keys and the server context: the next account, or a guest,
 * opening /support in the same tab got all of it back. So when the identity
 * changes AWAY from the signed-in user the conversation was held for (sign
 * out, another account, a session that expired before a reload), everything
 * is dropped. A guest who signs in keeps the conversation they started: that
 * is the trip to the sign-in page the draft is kept for. Stored state with no
 * owner on record (kept before this stamp existed) is not trusted either.
 */
export function adoptAssistOwner(userId: string | null): void {
  const next = userId ?? '';
  let stored: string | null = null;
  let held = false;
  try {
    stored = sessionStorage.getItem(OWNER_KEY);
    held = sessionStorage.getItem(ASSIST_CONTEXT_KEY) !== null || sessionStorage.getItem(ASSIST_STATE_KEY) !== null;
  } catch {
    return;
  }
  const leaving = stored === null ? held : stored !== '' && stored !== next;
  if (leaving) clearAssistSession();
  try {
    sessionStorage.setItem(OWNER_KEY, next);
  } catch {
    // Storage refused: nothing is kept for anyone.
  }
}
