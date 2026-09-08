/**
 * Request validation (`01-TARGET.md` §3.2 step 5) — the cheap refusals that
 * happen before a session is resolved, a limiter is touched or a byte is
 * forwarded.
 *
 * FIVE RULES, AND WHY EACH ONE IS SHAPED THE WAY IT IS.
 *
 *  1. **Method allowlist.** The platform speaks GET/HEAD/POST/PUT/PATCH/DELETE
 *     and nothing else — there is no CORS, so there are no preflights to
 *     answer (`docs/SECURITY.md` §2). A handful of prefixes are read-only in
 *     the core today (`/files/*`, `/api/home`, `/api/settings/public`,
 *     `/api/storefront/*`, `/api/health`); a mutation there matches no route
 *     and gets today's 404. The refusal body is exactly `worker/index.ts`'s
 *     `notFound` — `{success:false,error:'Not found'}` — because that is what
 *     a client already receives for these, and parity is the whole point of
 *     putting a Worker in front of a live site.
 *
 *  2. **`..` segments.** Refused raw and percent-encoded. `/files/<key>` is
 *     the one path whose tail is used as an R2 key, and a request that
 *     contains a traversal segment has no legitimate reading.
 *
*  3. **Body present ⇒ a content type we accept.** "Present" is
 *     `Content-Length > 0`, a `Transfer-Encoding` header, or a body stream
 *     (HTTP/2 needs neither header) — NOT "the method is a mutation". The SPA
 *     sends 41 bodiless `POST`/`DELETE` calls
 *     (`api.delete()`, `/api/auth/logout`, cart-line removal, address
 *     deletion, offer accept, order cancel) with no `Content-Type` at all, and
 *     refusing those would be an outage on day one.
 *
 *  4. **`Content-Length` + `Transfer-Encoding` together** is request
 *     smuggling, never a client. Refused.
 *
 *  5. **Size caps** from `uploadClasses.ts`.
 *
 * Everything here is a pure function of method, path and headers, so the whole
 * rule set is unit-testable without a Worker, a binding or a network.
 */
import type { ApiFailure } from '@levonis/contracts/http/common';
import { maxBodyBytes } from './uploadClasses';

export const ALLOWED_METHODS: readonly string[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
export const MUTATING_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'];

/** Prefixes the core mounts read-only today: a mutation there matches no route. */
export const READ_ONLY_PREFIXES: readonly string[] = ['/files', '/api/health', '/api/home', '/api/settings/public', '/api/storefront'];

/** The two content types the platform's mutations use (`multipart/form-data` carries a boundary). */
export const ACCEPTED_CONTENT_TYPES: readonly string[] = ['application/json', 'multipart/form-data'];

export interface Refusal {
  status: number;
  body: ApiFailure;
}

const notFound = (): Refusal => ({ status: 404, body: { success: false, error: 'Not found' } });
const bad = (error: string, status = 400): Refusal => ({ status, body: { success: false, error, code: 'CONTRACT_VIOLATION' } });

/**
 * True when the request carries a body at all.
 *
 * All three signals matter. `Content-Length` is the HTTP/1.1 case;
 * `Transfer-Encoding` is the chunked one; and `bodyStream` is HTTP/2, where a
 * request may legally carry a body with NEITHER header — reading only the
 * headers would let a typed body through the content-type rule unexamined.
 */
export function hasBody(headers: Headers, bodyStream = false): boolean {
  if (headers.has('transfer-encoding')) return true;
  const raw = headers.get('content-length');
  if (raw !== null) {
    // A DECLARED length is the authority, and `0` means "no body" even when
    // the runtime still hands us a stream object. workerd does exactly that
    // for a bodiless `POST`: `request.body` is a non-null empty stream, and
    // trusting it alone would have refused all 41 of the SPA's bodiless POST
    // and DELETE calls with a 415 the moment this Worker went live. The local
    // rig (dev/probe.mjs) is what caught it.
    const len = Number.parseInt(raw, 10);
    return Number.isFinite(len) && len > 0;
  }
  return bodyStream;
}

export function hasTraversal(path: string): boolean {
  const lowered = path.toLowerCase();
  if (lowered.includes('%2e%2e') || lowered.includes('%2e.') || lowered.includes('.%2e')) return true;
  return path.split('/').includes('..');
}

export interface ValidateInput {
  method: string;
  path: string;
  headers: Headers;
  /** `request.body !== null` — the HTTP/2 case, where a body needs no header */
  bodyStream?: boolean;
}

/** Returns the refusal, or null when the request may proceed. */
export function validateRequest(input: ValidateInput): Refusal | null {
  const method = input.method.toUpperCase();
  if (!ALLOWED_METHODS.includes(method)) return notFound();
  if (hasTraversal(input.path)) return bad('Bad request path');

  const mutating = MUTATING_METHODS.includes(method);
  if (mutating && READ_ONLY_PREFIXES.some((p) => input.path === p || input.path.startsWith(p + '/'))) return notFound();

  const headers = input.headers;
  if (headers.has('transfer-encoding') && headers.has('content-length')) return bad('Ambiguous request framing');

  if (mutating && hasBody(headers, input.bodyStream)) {
    const ct = (headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!ACCEPTED_CONTENT_TYPES.includes(ct)) return bad('Unsupported content type', 415);
  }

  const declared = Number.parseInt(headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > maxBodyBytes(input.path, method)) return bad('Request body is too large', 413);

  return null;
}
