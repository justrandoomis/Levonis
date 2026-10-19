/**
 * Which account this tab was rendered for, carried on every account API call.
 *
 * The page takes its identity from the server render, once; the API takes it
 * from the session cookie on every request. They part ways when the person
 * signs in as another account in ANOTHER tab: the cookie now names B while
 * this tab still holds A's editor, A's draft namespace and A's pending mode
 * choice. Without a check, "save to my account", "create project", adopting
 * guest work, or a mode choice pushed on the `online` event would land in B's
 * account (ownership checks only stopped autosaves into A's projects).
 *
 * So every call from the two API clients (project-sync.ts, studio-mode.ts)
 * names the expected user in `X-Studio-Expect-User`. The worker
 * (worker/api/router.ts, refuseIdentityMismatch) answers 409
 * `IDENTITY_CHANGED` when it is not the session's user and touches nothing,
 * and this tab then reloads, which renders it for the account the cookie
 * really holds. A's local drafts stay in A's namespace on this device.
 *
 * The header name sits outside the `oai-` / `x-levo-` prefixes the worker
 * strips from every inbound request. A guest tab sends nothing: a guest has no
 * account to protect, and every account route answers a guest 401 anyway.
 */

export const EXPECTED_USER_HEADER = "X-Studio-Expect-User";
export const IDENTITY_CHANGED_CODE = "IDENTITY_CHANGED";

/** Reload at most once in this window, so a confused server cannot loop us. */
const RELOAD_GUARD_KEY = "levo-studio-identity-reload";
const RELOAD_GUARD_MS = 30_000;

let expectedUserId: string | null = null;

/** Set by the hooks that own the account boundary (persistence, mode). */
export function setExpectedStudioUser(userId: string | null): void {
  expectedUserId = userId || null;
}

export function expectedStudioUser(): string | null {
  return expectedUserId;
}

/** `init` with the expected-user header added when this tab is signed in. */
export function withExpectedUser(init: RequestInit = {}): RequestInit {
  if (!expectedUserId) return init;
  const headers = new Headers(init.headers);
  headers.set(EXPECTED_USER_HEADER, expectedUserId);
  return { ...init, headers };
}

/** True when the response is the worker's identity refusal. Reads a clone. */
export async function isIdentityChanged(response: Response): Promise<boolean> {
  if (response.status !== 409) return false;
  try {
    const body = (await response.clone().json()) as { code?: unknown } | null;
    return body?.code === IDENTITY_CHANGED_CODE;
  } catch {
    return false;
  }
}

/**
 * Reload this tab so it is rendered for the account the cookie holds. At most
 * once per RELOAD_GUARD_MS (a sessionStorage stamp; without storage it still
 * reloads, since the next render answers from the cookie and stops the loop).
 */
export function reloadForChangedIdentity(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_GUARD_KEY) || 0);
    if (Number.isFinite(last) && Date.now() - last < RELOAD_GUARD_MS) return false;
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  } catch {
    /* storage unavailable: reload anyway */
  }
  window.location.reload();
  return true;
}

/**
 * The fetch wrapper both API clients use: adds the header, and on the
 * identity refusal starts the reload. The response is returned unchanged, so
 * the caller still fails the call the usual way.
 */
export async function fetchAsExpectedUser(
  impl: (input: string, init?: RequestInit) => Promise<Response>,
  input: string,
  init: RequestInit = {}
): Promise<Response> {
  const response = await impl(input, withExpectedUser(init));
  if (expectedUserId && (await isIdentityChanged(response))) reloadForChangedIdentity();
  return response;
}
