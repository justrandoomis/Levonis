/**
 * Which localized sentence a failed panel action shows (projects panel).
 *
 * Returns a KEY of the panel's ar/en/ckb dictionary — never a message. Server
 * refusals carry English text and browser network errors carry the browser's
 * own text ("Failed to fetch"); neither is what an Arabic or Sorani user may
 * read, so the panel never renders error.message (docs/DECISIONS.md row 183:
 * every user-facing string exists in ar, en and ckb).
 */
import { DraftAdoptError, StudioApiError } from "./project-sync";

export type PanelErrorKey =
  | "quotaExceeded"
  | "rateLimited"
  | "guestTitle"
  | "draftMissing"
  | "draftEmpty"
  | "networkFailed"
  | "historyConflict"
  | "trashExpired"
  | "actionFailed";

export const PANEL_ERROR_KEYS: readonly PanelErrorKey[] = [
  "quotaExceeded",
  "rateLimited",
  "guestTitle",
  "draftMissing",
  "draftEmpty",
  "networkFailed",
  "historyConflict",
  "trashExpired",
  "actionFailed",
];

export function panelErrorKey(error: unknown): PanelErrorKey {
  if (error instanceof DraftAdoptError) {
    switch (error.reason) {
      case "quota":
        return "quotaExceeded";
      case "rate-limited":
        return "rateLimited";
      case "auth":
      case "signed-out":
        return "guestTitle";
      case "missing":
        return "draftMissing";
      case "empty":
        return "draftEmpty";
      case "network":
        return "networkFailed";
      default:
        return "actionFailed";
    }
  }
  if (error instanceof StudioApiError) {
    if (error.code === "REVISION_CONFLICT") return "historyConflict";
    if (error.code === "QUOTA_EXCEEDED" || error.status === 413) return "quotaExceeded";
    if (error.code === "RETENTION_EXPIRED" || error.status === 410) return "trashExpired";
    if (error.code === "RATE_LIMITED" || error.status === 429) return "rateLimited";
    if (error.status === 401) return "guestTitle";
    return "actionFailed";
  }
  // fetch() rejects with a TypeError when the network is down.
  if (error instanceof TypeError) return "networkFailed";
  return "actionFailed";
}
