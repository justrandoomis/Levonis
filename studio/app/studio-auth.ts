/**
 * Studio identity provider for the SSR app — replaces the removed
 * chatgpt-auth.ts (which trusted the forgeable `oai-authenticated-user-*`
 * headers of the retired hosting platform).
 *
 * Identity here comes ONLY from the internal `x-levo-user` request header,
 * which the Studio worker (worker/index.ts) sets AFTER validating the
 * host-scoped HttpOnly session cookie against the database — and only after
 * stripping every inbound `oai-*` / `x-levo-*` header a client may have
 * forged. The value is the stable opaque user id plus display name and
 * locale; no email, phone, wallet or KYC data ever reaches the Studio
 * (owner mandate §3).
 *
 * Guest editing stays: a missing header simply means "not signed in".
 */
import { headers } from "next/headers";

export type StudioUser = {
  /** Stable opaque LEVONIS user id (users.id on the main site). */
  id: string;
  displayName: string;
  locale: "ar" | "en" | "ckb";
};

const USER_HEADER = "x-levo-user";
const SIGN_IN_PATH = "/auth/login";
const SIGN_OUT_PATH = "/auth/logout";

export async function getStudioUser(): Promise<StudioUser | null> {
  const requestHeaders = await headers();
  const raw = requestHeaders.get(USER_HEADER);
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as { id?: unknown; display_name?: unknown; locale?: unknown };
  if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 128) return null;

  return {
    id: value.id,
    displayName:
      (typeof value.display_name === "string" ? value.display_name.slice(0, 200) : "") || "User",
    locale: value.locale === "en" || value.locale === "ckb" ? value.locale : "ar",
  };
}

/** Navigation target that starts the main-site sign-in handoff. */
export function studioSignInPath(returnTo = "/"): string {
  return `${SIGN_IN_PATH}?return_to=${encodeURIComponent(safeRelativeReturnPath(returnTo))}`;
}

/** Navigation target that destroys the Studio session (worker-side row + cookie). */
export function studioSignOutPath(returnTo = "/"): string {
  return `${SIGN_OUT_PATH}?return_to=${encodeURIComponent(safeRelativeReturnPath(returnTo))}`;
}

/** Same-origin RELATIVE paths only; auth endpoints and anything absolute fall back to "/". */
function safeRelativeReturnPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  let url: URL;
  try {
    url = new URL(value, "https://studio.local");
  } catch {
    return "/";
  }
  if (url.origin !== "https://studio.local") return "/";
  if (url.pathname === "/auth" || url.pathname.startsWith("/auth/")) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}
