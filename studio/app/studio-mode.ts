/**
 * Studio Simple / Advanced mode (P1-10; owner decisions S6/S7).
 *
 * SIMPLE IS THE DEFAULT FOR EVERYONE (S6). Simple hides the engine's side
 * panel at every width and the engine's native controls it does not support
 * (app/editor-theme.ts, `data-levo-mode` on the engine host); the Setup sheet
 * keeps the essentials and the shell keeps every warning, the stale-result
 * banner and the slicing estimate, which live outside that panel. The two
 * the engine keeps ONLY inside that panel — its slow-slice (triangle count)
 * warning and its "simplified retry" offer after a failed slice — are carried
 * by the shell itself, in both modes (app/slicer-client.tsx; the containment
 * test in tests/studio-mode.test.mjs fails on any new one). Advanced is
 * today's full editor.
 *
 * WHERE THE CHOICE LIVES (S7): on the server for a signed-in account
 * (`/api/prefs`, worker/api/prefs.ts), so it follows the person to another
 * device, with a LOCAL MIRROR per draft namespace (`user:<id>` / guest) so
 * the editor opens in the right mode before the network answers. A guest has
 * the mirror only. Namespaced exactly like the drafts (app/project-store.ts):
 * one account's choice is never applied to another account or to a guest on
 * the same device.
 *
 * Reconciliation (pure, `reconcileMode`): a choice made on THIS device that
 * the server never confirmed (the mirror is marked PENDING until a PUT
 * succeeds — offline, 429, 5xx) is pushed up and wins, even over a value the
 * account stored earlier: the person's last click is never silently reverted
 * on the next load. Otherwise a stored server value wins; when the account
 * has never stored one, the device's choice is pushed up instead of being
 * overwritten by the default.
 *
 * A load never undoes a click made while it was in flight: `loadStudioMode`
 * takes a `stillCurrent()` check and, once a newer choice exists, neither
 * rewrites the mirror nor pushes its own (stale) answer.
 */

export const STUDIO_MODES = ["simple", "advanced"] as const;
export type StudioMode = (typeof STUDIO_MODES)[number];
export const DEFAULT_STUDIO_MODE: StudioMode = "simple";

export function isStudioMode(value: unknown): value is StudioMode {
  return typeof value === "string" && (STUDIO_MODES as readonly string[]).includes(value);
}

/** localStorage key prefix; the namespace follows (`user:<id>` or guest). */
export const MODE_STORAGE_PREFIX = "levo-studio-mode/";
/** Present (holding the mode) while that choice has not reached the server. */
export const MODE_PENDING_PREFIX = "levo-studio-mode-pending/";

export function modeStorageKey(namespace: string): string {
  return `${MODE_STORAGE_PREFIX}${namespace}`;
}

export function modePendingKey(namespace: string): string {
  return `${MODE_PENDING_PREFIX}${namespace}`;
}

// Storage seam ---------------------------------------------------------------

export interface ModeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

let storageOverride: ModeStorage | null = null;

/** Test hook: an in-memory storage in place of localStorage (null restores). */
export function setModeStorageForTests(storage: ModeStorage | null): void {
  storageOverride = storage;
}

function modeStorage(): ModeStorage | null {
  if (storageOverride) return storageOverride;
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null; // storage denied (private mode, blocked cookies)
  }
}

/** The mirrored choice for a namespace, or null when none was ever made here. */
export function readModeMirror(namespace: string): StudioMode | null {
  try {
    const value = modeStorage()?.getItem(modeStorageKey(namespace)) ?? null;
    return isStudioMode(value) ? value : null;
  } catch {
    return null;
  }
}

/** True while this device holds a choice the server has not confirmed. */
export function isModeMirrorPending(namespace: string): boolean {
  try {
    const mirror = readModeMirror(namespace);
    const pending = modeStorage()?.getItem(modePendingKey(namespace)) ?? null;
    return mirror !== null && pending === mirror;
  } catch {
    return false;
  }
}

/**
 * Writes the mirror. `pending: true` marks a choice the server still has to
 * receive; `pending: false` records a value the server confirmed (or a
 * guest's, which has no server copy).
 */
export function writeModeMirror(namespace: string, mode: StudioMode, options: { pending?: boolean } = {}): void {
  try {
    const storage = modeStorage();
    storage?.setItem(modeStorageKey(namespace), mode);
    if (options.pending) storage?.setItem(modePendingKey(namespace), mode);
    else storage?.removeItem(modePendingKey(namespace));
  } catch {
    /* the in-memory choice still applies for this page */
  }
}

/** The server confirmed `mode`: clear the pending mark if it still names it. */
function confirmModeMirror(namespace: string, mode: StudioMode): void {
  try {
    const storage = modeStorage();
    if (storage?.getItem(modePendingKey(namespace)) === mode) storage.removeItem(modePendingKey(namespace));
  } catch {
    /* stays pending; pushed again on the next load */
  }
}

/** Drops a namespace's mirror (used by the sign-out purge of that account). */
export function clearModeMirror(namespace: string): void {
  try {
    modeStorage()?.removeItem(modeStorageKey(namespace));
    modeStorage()?.removeItem(modePendingKey(namespace));
  } catch {
    /* nothing to clear */
  }
}

// Server API -----------------------------------------------------------------

export interface ServerModeAnswer {
  mode: StudioMode;
  /** Whether the account has ever stored a choice. */
  stored: boolean;
}

export interface StudioPrefsApi {
  get(): Promise<ServerModeAnswer>;
  put(mode: StudioMode): Promise<ServerModeAnswer>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function parseAnswer(body: unknown): ServerModeAnswer {
  const value = body as { success?: unknown; prefs?: { mode?: unknown }; stored?: unknown } | null;
  if (!value || value.success !== true) throw new Error("prefs request failed");
  const mode = value.prefs?.mode;
  return { mode: isStudioMode(mode) ? mode : DEFAULT_STUDIO_MODE, stored: value.stored === true };
}

/** Same-origin `/api/prefs` client (credentials same-origin only, like project-sync). */
export function createStudioPrefsApi(fetchImpl?: FetchLike): StudioPrefsApi {
  const doFetch: FetchLike = (input, init) => {
    const impl = fetchImpl ?? (globalThis.fetch as FetchLike);
    return impl(input, { credentials: "same-origin", ...init });
  };
  const read = async (response: Response) => {
    if (!response.ok) throw new Error(`prefs request failed (${response.status})`);
    return parseAnswer(await response.json().catch(() => null));
  };
  return {
    async get() {
      return read(await doFetch("/api/prefs"));
    },
    async put(mode) {
      return read(
        await doFetch("/api/prefs", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode }),
        })
      );
    },
  };
}

// Reconciliation ---------------------------------------------------------------

/**
 * Which mode applies, and whether this device's choice must be pushed up.
 *   server unreachable / guest   → the mirror, else Simple; nothing pushed
 *   mirror PENDING (unconfirmed) → the mirror; pushed — even over a stored
 *                                  value: the person's last click wins
 *   server has a stored choice   → the server's; nothing pushed
 *   server never stored, mirror  → the mirror; pushed
 *   server never stored, nothing → Simple; nothing pushed
 */
export function reconcileMode(
  mirror: StudioMode | null,
  server: ServerModeAnswer | null,
  pending = false
): { mode: StudioMode; push: StudioMode | null } {
  if (!server) return { mode: mirror ?? DEFAULT_STUDIO_MODE, push: null };
  if (mirror && pending) return { mode: mirror, push: mirror };
  if (server.stored) return { mode: server.mode, push: null };
  if (mirror) return { mode: mirror, push: mirror };
  return { mode: DEFAULT_STUDIO_MODE, push: null };
}

/** PUTs `mode`; on success the mirror's pending mark for it is cleared. */
async function pushMode(namespace: string, api: StudioPrefsApi, mode: StudioMode): Promise<boolean> {
  try {
    await api.put(mode);
  } catch {
    return false; // stays pending; pushed again on the next load or reconnect
  }
  confirmModeMirror(namespace, mode);
  return true;
}

/**
 * Resolves the mode for a namespace: mirror first, then the server (signed
 * in). `stillCurrent` is asked once the server answers: false means a newer
 * choice was made meanwhile, and this load then writes nothing and pushes
 * nothing (it returns the mirror, which already holds that newer choice).
 */
export async function loadStudioMode(input: {
  namespace: string;
  signedIn: boolean;
  api: StudioPrefsApi;
  stillCurrent?: () => boolean;
}): Promise<StudioMode> {
  const mirror = readModeMirror(input.namespace);
  if (!input.signedIn) return mirror ?? DEFAULT_STUDIO_MODE;
  let server: ServerModeAnswer | null = null;
  try {
    server = await input.api.get();
  } catch {
    server = null; // offline / 5xx / 429: the mirror stands
  }
  if (input.stillCurrent && !input.stillCurrent()) {
    return readModeMirror(input.namespace) ?? DEFAULT_STUDIO_MODE;
  }
  // Read the pending mark AFTER the answer: a click during the GET has
  // already been caught above, so this is the state the answer applies to.
  const current = readModeMirror(input.namespace);
  const result = reconcileMode(current, server, isModeMirrorPending(input.namespace));
  if (server?.stored && !result.push) writeModeMirror(input.namespace, server.mode);
  if (result.push) await pushMode(input.namespace, input.api, result.push);
  return result.mode;
}

/**
 * Applies a choice: the mirror at once (marked pending until the server has
 * it), the server when signed in. True = the server has it; false keeps the
 * choice pending, so the next load (or `pushPendingMode`) sends it again
 * instead of letting an older stored value revert it.
 */
export async function saveStudioMode(input: {
  namespace: string;
  signedIn: boolean;
  api: StudioPrefsApi;
  mode: StudioMode;
}): Promise<boolean> {
  writeModeMirror(input.namespace, input.mode, { pending: input.signedIn });
  if (!input.signedIn) return false;
  return pushMode(input.namespace, input.api, input.mode);
}

/** Re-sends a choice still pending (the hook calls this when back online). */
export async function pushPendingMode(input: { namespace: string; signedIn: boolean; api: StudioPrefsApi }): Promise<boolean> {
  if (!input.signedIn || !isModeMirrorPending(input.namespace)) return false;
  const mode = readModeMirror(input.namespace);
  if (!mode) return false;
  return pushMode(input.namespace, input.api, mode);
}
