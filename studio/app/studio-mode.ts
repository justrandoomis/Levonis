/**
 * Studio Simple / Advanced mode (P1-10; owner decisions S6/S7).
 *
 * SIMPLE IS THE DEFAULT FOR EVERYONE (S6). Simple hides the engine's side
 * panel at every width and the engine's native controls it does not support
 * (app/editor-theme.ts, `data-levo-mode` on the engine host); the Setup sheet
 * keeps the essentials and the shell keeps every warning, the stale-result
 * banner and the slicing estimate, which live outside that panel. Advanced is
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
 * Reconciliation (pure, `reconcileMode`): a stored server value wins; when
 * the account has never stored one but this device holds a choice for it (a
 * change made while the server could not be reached), the device's choice is
 * pushed up instead of being overwritten by the default.
 */

export const STUDIO_MODES = ["simple", "advanced"] as const;
export type StudioMode = (typeof STUDIO_MODES)[number];
export const DEFAULT_STUDIO_MODE: StudioMode = "simple";

export function isStudioMode(value: unknown): value is StudioMode {
  return typeof value === "string" && (STUDIO_MODES as readonly string[]).includes(value);
}

/** localStorage key prefix; the namespace follows (`user:<id>` or guest). */
export const MODE_STORAGE_PREFIX = "levo-studio-mode/";

export function modeStorageKey(namespace: string): string {
  return `${MODE_STORAGE_PREFIX}${namespace}`;
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

export function writeModeMirror(namespace: string, mode: StudioMode): void {
  try {
    modeStorage()?.setItem(modeStorageKey(namespace), mode);
  } catch {
    /* the in-memory choice still applies for this page */
  }
}

/** Drops a namespace's mirror (used by the sign-out purge of that account). */
export function clearModeMirror(namespace: string): void {
  try {
    modeStorage()?.removeItem(modeStorageKey(namespace));
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
 *   server unreachable / guest  → the mirror, else Simple; nothing pushed
 *   server has a stored choice   → the server's; nothing pushed
 *   server never stored, mirror  → the mirror; pushed
 *   server never stored, nothing → Simple; nothing pushed
 */
export function reconcileMode(
  mirror: StudioMode | null,
  server: ServerModeAnswer | null
): { mode: StudioMode; push: StudioMode | null } {
  if (!server) return { mode: mirror ?? DEFAULT_STUDIO_MODE, push: null };
  if (server.stored) return { mode: server.mode, push: null };
  if (mirror) return { mode: mirror, push: mirror };
  return { mode: DEFAULT_STUDIO_MODE, push: null };
}

/** Resolves the mode for a namespace: mirror first, then the server (signed in). */
export async function loadStudioMode(input: {
  namespace: string;
  signedIn: boolean;
  api: StudioPrefsApi;
}): Promise<StudioMode> {
  const mirror = readModeMirror(input.namespace);
  if (!input.signedIn) return mirror ?? DEFAULT_STUDIO_MODE;
  let server: ServerModeAnswer | null = null;
  try {
    server = await input.api.get();
  } catch {
    server = null; // offline / 5xx / 429: the mirror stands
  }
  const result = reconcileMode(mirror, server);
  if (server?.stored) writeModeMirror(input.namespace, server.mode);
  if (result.push) {
    try {
      await input.api.put(result.push);
    } catch {
      /* stays in the mirror; pushed again on the next load */
    }
  }
  return result.mode;
}

/** Applies a choice: the mirror at once, the server when signed in. True = the server has it. */
export async function saveStudioMode(input: {
  namespace: string;
  signedIn: boolean;
  api: StudioPrefsApi;
  mode: StudioMode;
}): Promise<boolean> {
  writeModeMirror(input.namespace, input.mode);
  if (!input.signedIn) return false;
  try {
    await input.api.put(input.mode);
    return true;
  } catch {
    return false;
  }
}
