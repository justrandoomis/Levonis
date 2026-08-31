/**
 * Cloudflare Worker entry point for LEVO Studio.
 *
 * Request pipeline (order matters — STUDIO_PLAN decisions 3 & 5):
 *   1. Strip untrusted inbound headers (`oai-*` legacy-hosting identity,
 *      internal `x-levo-*`) before ANY processing.
 *   2. /auth/* (and the legacy sign-in paths) are handled here, same-origin,
 *      BEFORE vinext delegation — no connect-src widening, no COOP/COEP
 *      weakening for sign-in.
 *   3. /api/* goes to the storage API router with the validated Studio
 *      session (or null for guests).
 *   4. Everything else renders through vinext; document requests carry the
 *      validated identity to the SSR app via the internal x-levo-user
 *      header (trustworthy only because step 1 stripped inbound copies).
 *   5. Every response is wrapped in the security headers (COOP/COEP for the
 *      threaded WASM core) and HTML is never cached (Cache-Control:
 *      no-store) so the header wrap cannot be bypassed by a cached copy.
 */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { apiRouter } from "./api/router";
import { scheduledCleanup } from "./api/cleanup";
import { handleAuthRoute, isAuthRoute } from "./auth/callback";
import { isMemoryConstrainedApple } from "./platform";
import {
  type StudioAuthEnv,
  isStudioSessionStillAuthorized,
  loadStudioSession,
  sanitizeRequestHeaders,
  withUserHeader,
} from "./auth/session";

interface Env extends StudioAuthEnv {
  ASSETS: Fetcher;
  /** Private project-file storage — used by the storage API (worker/api). */
  BUCKET: R2Bucket;
  /** Studio's own trusted origin (deploy-time var; may be empty locally). */
  APP_ORIGIN?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

/**
 * Cross-origin isolation, withheld from iOS and iPadOS.
 *
 * WHY. three-slicer picks its WASM core on ONE signal, and nothing else:
 *
 *     if (crossOriginIsolated) { try { …slicer_core.mt… } catch { …st… } }
 *
 * `mt` is the threaded core: a SharedArrayBuffer heap plus a pthread pool.
 * That is the right choice on a desktop and the reason these headers were
 * added in the first place. On an iPad it is not — WebKit's per-tab memory
 * budget is a fraction of a desktop's, and the pool is sized from
 * hardwareConcurrency, so the worker gets KILLED by the OS shortly after it
 * boots. The engine's `catch` cannot save it: a kill is not a thrown error,
 * it arrives on the parent as an ErrorEvent with an empty message, which the
 * engine then reports with its stock guess — "Worker terminated (likely out
 * of memory): worker error", the exact message the owner photographed on a
 * project with nothing loaded.
 *
 * The engine already ships a single-threaded core and treats it as a
 * first-class path. So rather than patching a vendored bundle, we stop
 * advertising isolation on the platform where the threaded core cannot
 * survive, and the engine's own branch takes `st`. Slower, and it finishes.
 *
 * Everything else is unaffected: no other Studio feature needs
 * SharedArrayBuffer, and every other platform keeps threads.
 */
const ISOLATION_HEADERS: Record<string, string> = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// The platform predicate moved to ./platform so it can be tested: this file
// imports vinext and the Cloudflare runtime, so no plain test can load it,
// and that predicate was carrying the whole iPad mitigation untested.
// Still exported from here — it is part of this module's public surface.
export { isMemoryConstrainedApple };

function withSecurityHeaders(response: Response, request?: Request): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  if (!isMemoryConstrainedApple(request?.headers.get("User-Agent") ?? "")) {
    for (const [name, value] of Object.entries(ISOLATION_HEADERS)) headers.set(name, value);
  }
  // HTML always flows through the worker and is never cached: identity is
  // per-request and a cached page would dodge future header/policy changes.
  const contentType = headers.get("Content-Type") || "";
  if (contentType.includes("text/html") && !headers.has("Cache-Control")) {
    headers.set("Cache-Control", "private, no-store");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Document navigations get the SSR identity header; assets/RSC data do not. */
function isDocumentRequest(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const dest = request.headers.get("Sec-Fetch-Dest");
  if (dest) return dest === "document";
  return (request.headers.get("Accept") || "").includes("text/html");
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(rawRequest: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Defense in depth FIRST: forged legacy-hosting identity headers and
    // reserved internal headers never survive past this line.
    const request = sanitizeRequestHeaders(rawRequest);
    const url = new URL(request.url);

    // Same-origin auth endpoints (login/callback/logout/me + legacy paths).
    if (isAuthRoute(url.pathname)) {
      return withSecurityHeaders(await handleAuthRoute(request, env), request);
    }

    // Storage API (owned by worker/api/*): receives the validated session so
    // every handler can enforce ownership; guests get null (editing without
    // an account keeps working — only account features need sign-in).
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      let session = await loadStudioSession(request, env);
      // Studio's own session lasts 14 days, so without this a main-site
      // logout would leave the account signed in here for a fortnight. The
      // answer is cached for a minute and only a definite "inactive" revokes;
      // an unconfigured or unreachable main site keeps the session (see
      // isStudioSessionStillAuthorized). A revoked session becomes a GUEST,
      // not an error: editing keeps working, account features stop.
      if (session && !(await isStudioSessionStillAuthorized(env, session))) session = null;
      return withSecurityHeaders(await apiRouter(request, env, ctx, session), request);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      const response = await handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
      return withSecurityHeaders(response, request);
    }

    // SSR/assets. Only document navigations pay for the session lookup; the
    // app reads the identity via studio-auth.ts from the x-levo-user header.
    let forwarded = request;
    if (isDocumentRequest(request)) {
      const session = await loadStudioSession(request, env);
      if (session) forwarded = withUserHeader(request, session.user);
    }
    return withSecurityHeaders(await handler.fetch(forwarded, env, ctx), request);
  },

  // Storage cleanup cron (STUDIO_PLAN decision 4, step CLEANUP): expired
  // sessions, stale pending/abandoned revisions, soft-deleted projects past
  // retention, committed-revision pruning, and the low-frequency R2<->D1
  // reconciliation. Work is capped per run (see api/cleanup.ts), so the
  // hourly cron in studio/wrangler.jsonc stays well inside Workers limits.
  scheduled(_event: unknown, env: Env, ctx: ExecutionContext): void {
    scheduledCleanup(env, ctx);
  },
};

export default worker;
