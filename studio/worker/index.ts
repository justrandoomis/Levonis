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
import { handleAuthRoute, isAuthRoute } from "./auth/callback";
import {
  type StudioAuthEnv,
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
  // three-slicer selects its threaded WASM core only in a cross-origin-isolated
  // context. All runtime assets are same-origin, so these headers safely unlock
  // SharedArrayBuffer and remove the largest source of slow slices on the web.
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
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
      return withSecurityHeaders(await handleAuthRoute(request, env));
    }

    // Storage API (owned by worker/api/*): receives the validated session so
    // every handler can enforce ownership; guests get null (editing without
    // an account keeps working — only account features need sign-in).
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const session = await loadStudioSession(request, env);
      return withSecurityHeaders(await apiRouter(request, env, ctx, session));
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
      return withSecurityHeaders(response);
    }

    // SSR/assets. Only document navigations pay for the session lookup; the
    // app reads the identity via studio-auth.ts from the x-levo-user header.
    let forwarded = request;
    if (isDocumentRequest(request)) {
      const session = await loadStudioSession(request, env);
      if (session) forwarded = withUserHeader(request, session.user);
    }
    return withSecurityHeaders(await handler.fetch(forwarded, env, ctx));
  },
};

export default worker;
