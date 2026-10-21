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

/**
 * THE REST OF THE CONVERSATION, kept for the same tab: the transcript (the
 * last 40 turns), the ticket draft and the attachments waiting for a ticket.
 *
 * So a reload, a language change or a trip to the sign-in page does not lose
 * the photo of the clogged nozzle or the steps already tried. The page strips
 * every price before it stores a card (a price is only ever shown fresh from
 * the server), and reads the stored value back as untrusted: anything that is
 * not the shape it wrote is dropped whole.
 */
const STATE_KEY = 'levonis.assist.state.v1';
/** Far below any quota; a transcript that grows past it is simply not kept. */
const STATE_MAX_CHARS = 200_000;

export function loadAssistState(): unknown {
  try {
    const raw = sessionStorage.getItem(STATE_KEY);
    if (!raw || raw.length > STATE_MAX_CHARS) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function saveAssistState(state: unknown): void {
  try {
    if (state === undefined || state === null) {
      sessionStorage.removeItem(STATE_KEY);
      return;
    }
    const raw = JSON.stringify(state);
    if (raw.length <= STATE_MAX_CHARS) sessionStorage.setItem(STATE_KEY, raw);
    else sessionStorage.removeItem(STATE_KEY);
  } catch {
    // Storage refused: the conversation lives in the page for this visit only.
  }
}
