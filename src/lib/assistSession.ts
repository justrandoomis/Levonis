/**
 * THE SUPPORT ASSISTANT'S CONVERSATION CONTEXT, kept for this browser tab.
 *
 * The server hands back a small, closed-set context with each reply (which
 * printer this conversation is about, where the printer-problem triage is)
 * and reads it again with the next message. This page never interprets it:
 * it stores the object as the server sent it and returns it unchanged, so a
 * guest keeps «the A1» across «نوزل مال اي ون» and «واكو بليت؟», and across
 * a reload, without an account. `sessionStorage`, so it ends with the tab.
 * Storage may be unavailable (private mode, a full quota); every access is
 * guarded and the assistant then simply remembers within the page.
 */
const KEY = 'levonis.assist.v1';
/** The server ignores a larger context; so does this page. */
const MAX_CHARS = 2048;

export function loadAssistContext(): unknown {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw || raw.length > MAX_CHARS) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function saveAssistContext(context: unknown): void {
  try {
    if (context === undefined || context === null) {
      sessionStorage.removeItem(KEY);
      return;
    }
    const raw = JSON.stringify(context);
    if (raw.length <= MAX_CHARS) sessionStorage.setItem(KEY, raw);
  } catch {
    // Storage refused: the context lives in the page for this visit only.
  }
}
