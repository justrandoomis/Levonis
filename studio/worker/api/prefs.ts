/**
 * Studio user preferences (P1-10; owner decisions S6/S7).
 *
 *   GET /api/prefs   → { success, prefs: { mode }, stored, updated_at }
 *   PUT /api/prefs   { mode: "simple" | "advanced" } → the same shape
 *
 * One preference today: the editor MODE. Simple is the default for everyone
 * (S6) — an account with no row, a row with a value this build does not know,
 * and a guest (who never reaches this route; the client keeps a local mirror)
 * all get Simple. The server row is the source of truth for a signed-in
 * account, so the choice follows the person to another device (S7); the
 * client mirrors it locally so the editor opens in the right mode before the
 * network answers (app/studio-mode.ts).
 *
 * `stored` says whether the account has ever chosen. The client uses it to
 * push a choice made while the server could not be reached, instead of
 * overwriting that choice with the default.
 *
 * Storage: `studio_user_prefs` (drizzle/0002_user_prefs.sql), keyed by the
 * opaque owner id. Deliberately no CHECK on `mode`: a future mode must not
 * need a table rebuild (the Studio migration gate admits CREATE only), so the
 * value is validated here and an unknown stored value reads as Simple.
 */
import type { StudioSession } from "../auth/session";
import { apiError, jsonResponse, methodNotAllowed, nowIso, type StudioApiEnv } from "./router";

export const STUDIO_MODES = ["simple", "advanced"] as const;
export type StudioMode = (typeof STUDIO_MODES)[number];
export const DEFAULT_STUDIO_MODE: StudioMode = "simple";

export function isStudioMode(value: unknown): value is StudioMode {
  return typeof value === "string" && (STUDIO_MODES as readonly string[]).includes(value);
}

const MAX_BODY_BYTES = 1024;

interface PrefsRow {
  mode: string;
  updated_at: string;
}

function prefsResponse(row: PrefsRow | null): Response {
  return jsonResponse({
    success: true,
    prefs: { mode: row && isStudioMode(row.mode) ? row.mode : DEFAULT_STUDIO_MODE },
    stored: Boolean(row && isStudioMode(row.mode)),
    updated_at: row?.updated_at ?? null,
  });
}

async function readPrefs(db: D1Database, ownerId: string): Promise<PrefsRow | null> {
  return db
    .prepare("SELECT mode, updated_at FROM studio_user_prefs WHERE owner_id = ?")
    .bind(ownerId)
    .first<PrefsRow>();
}

export async function handlePrefsRoute(request: Request, env: StudioApiEnv, session: StudioSession): Promise<Response> {
  const ownerId = session.user.id;

  if (request.method === "GET" || request.method === "HEAD") {
    return prefsResponse(await readPrefs(env.DB, ownerId));
  }

  if (request.method === "PUT") {
    let text: string;
    try {
      text = await request.text();
    } catch {
      return apiError(400, "BAD_BODY", "Could not read request body");
    }
    if (text.length > MAX_BODY_BYTES) return apiError(413, "BODY_TOO_LARGE", "Request body too large");
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* handled below */
    }
    const mode = body && typeof body === "object" && !Array.isArray(body) ? (body as { mode?: unknown }).mode : undefined;
    if (!isStudioMode(mode)) {
      return apiError(400, "INVALID_MODE", "mode must be \"simple\" or \"advanced\"");
    }
    const updatedAt = nowIso();
    await env.DB.prepare(
      `INSERT INTO studio_user_prefs (owner_id, mode, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(owner_id) DO UPDATE SET mode = ?2, updated_at = ?3`
    )
      .bind(ownerId, mode, updatedAt)
      .run();
    return prefsResponse({ mode, updated_at: updatedAt });
  }

  return methodNotAllowed("GET, HEAD, PUT");
}
