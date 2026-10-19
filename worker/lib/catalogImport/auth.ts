/**
 * THE OPS DOOR OF THE CATALOGUE IMPORT: ITS TOKEN, ITS ANSWERS, ITS CODES
 * (Bambu import spec §A.3 "Authentication middleware", §A.8, §B.5; DECISIONS
 * row 241).
 *
 * `requireImportToken`, in order:
 *
 *   1. `Authorization: Bearer <64 hex>` and `X-Levonis-Import-Protocol: 2`.
 *   2. h = sha256Hex(token) (worker/lib/crypto.ts).
 *   3. One indexed read of catalog_import_runs: token_sha256 = h, the run open,
 *      running or blocked, the token not expired.
 *   4. ANY miss answers 404 `{ error: 'Not found' }` — no header, a malformed
 *      header, a bad token, an expired token, a revoked token, a closed run, a
 *      database without migration 0195 — with the same body and the same work:
 *      a missing or malformed header still costs one hash and the same read
 *      (a decoy token), so the time an answer takes says nothing about why. A
 *      merchant subdomain is a miss too (the main site only, as for /api/admin).
 *   5. `c.set('importRun', row)`.
 *
 * Every answer of the router is `Cache-Control: private, no-store`. The door
 * is CSRF-exempt by construction: a bearer token and no cookie (worker/lib/http.ts
 * `originCheck` judges only a request that carries an Origin, and the runner
 * sends none). The rate limit is per run (`catalog-import-ops`, 600 a minute).
 *
 * ERRORS are `{ code, message }`: a code from the fixed catalogue below and a
 * fixed English template (the runner's log reads it; the owner's dashboard
 * shows the code in ar/en/ckb), plus ids the Worker itself chose — never the
 * caller's input, never SQL or a stack. At most 300 characters.
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { AppContext, Env } from '../types';
import { HttpError } from '../http';
import { adminAllowedOn } from '../hosts';
import { rateLimit } from '../ratelimit';
import { sha256Hex } from '../crypto';
import { countingD1, type InvocationCounter } from './budget';

export const IMPORT_PROTOCOL = 2;
export const OPS_PREFIX = '/api/ops/catalog-import';
/** Leases last 15 minutes and every call renews them (§A.7). */
export const LEASE_MS = 15 * 60_000;
/** Every body is JSON of at most 2 MB (§A.3). */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export interface ImportRun {
  id: string;
  state: string;
  token_expires_at: string;
  github_run_id: string;
  reviewed_bundle_sha256: string;
  code_commit: string;
  manifest_total: number;
  started_at: string;
}

export type OpsEnv = {
  Bindings: Env;
  Variables: AppContext['Variables'] & { importRun: ImportRun; opsCounter: InvocationCounter };
};
export type OpsContext = Context<OpsEnv>;

/** The one body every miss of the door answers. */
export const NOT_FOUND_BODY = Object.freeze({ error: 'Not found' });
export const NO_STORE = 'private, no-store';

/** Hashed in place of a missing or malformed token, so every miss does the same work. No run ever holds it. */
const DECOY_TOKEN = 'f'.repeat(64);
const BEARER = /^Bearer ([0-9a-f]{64})$/;

export function opsNotFound(c: Context): Response {
  return c.json(NOT_FOUND_BODY, 404, { 'Cache-Control': NO_STORE });
}

/**
 * The first middleware of the router: every answer leaves `private, no-store`, and every statement of the
 * invocation — the door's own read, the rate limit, the item reads, the write — goes through one counted
 * binding (§A.5: the budget counts the whole invocation, not the batch alone).
 */
export const opsInvocation: MiddlewareHandler<OpsEnv> = async (c, next) => {
  if (c.env?.DB) {
    const counted = countingD1(c.env.DB);
    c.env = { ...c.env, DB: counted.db };
    c.set('opsCounter', counted.counter);
  }
  await next();
  try {
    c.res.headers.set('Cache-Control', NO_STORE);
  } catch {
    // An immutable response (none in this router) keeps its own headers.
  }
};

export const requireImportToken: MiddlewareHandler<OpsEnv> = async (c, next) => {
  const m = BEARER.exec(c.req.header('Authorization') ?? '');
  const shaped = !!m && (c.req.header('X-Levonis-Import-Protocol') ?? '') === String(IMPORT_PROTOCOL);
  const hash = await sha256Hex(shaped ? m![1] : DECOY_TOKEN);
  let run: ImportRun | null = null;
  try {
    run = await c.env.DB.prepare(
      `SELECT id, state, token_expires_at, github_run_id, reviewed_bundle_sha256, code_commit, manifest_total, started_at
         FROM catalog_import_runs
        WHERE token_sha256 = ? AND token_sha256 <> '' AND state IN ('open','running','blocked')
          AND token_expires_at > ${NOW_SQL}`
    )
      .bind(hash)
      .first<ImportRun>();
  } catch (e) {
    // No 0195 (a deploy ahead of its migration): the door does not exist. Any other failure of this read (a lost
    // connection, an overloaded database) is not a miss: a 404 would read as "token gone" and stop the job, so it
    // answers the transient 503 — which says nothing about the token, since no caller can choose it.
    if (!/no such table/i.test(e instanceof Error ? e.message : String(e))) return opsError(c, 503, 'D1_OVERLOADED');
    run = null;
  }
  // The main site only, like global administration (worker/lib/http.ts requireMainHost): a merchant subdomain
  // meets the same 404 — after the same read, so the host does not change the work either.
  if (!shaped || !run || !adminAllowedOn(c.get('host'))) return opsNotFound(c);
  c.set('importRun', run);
  try {
    await rateLimit(c as unknown as Context<AppContext>, 'catalog-import-ops', 600, 60, run.id);
  } catch (e) {
    if (e instanceof HttpError && e.status === 429) return opsError(c, 429, 'RATE_LIMITED', [], { 'Retry-After': '60' });
    throw e;
  }
  await next();
};

// ---------------------------------------------------------------- the code catalogue

/** Fixed templates, by code. The message of an answer is one of these plus ids the Worker chose. */
export const OPS_MESSAGES: Readonly<Record<string, string>> = {
  IMPORT_BAD_REQUEST: 'The request body is not what this endpoint takes.',
  IMPORT_BODY_TOO_LARGE: 'The request body is larger than 2 MB.',
  IMPORT_PROTOCOL_MISMATCH: 'The runner speaks another protocol version than this Worker.',
  IMPORT_ITEM_NOT_FOUND: 'No item of this run has that source id.',
  IMPORT_LEASE_LOST: 'The lease is not held by this caller any more; lease the item again.',
  IMPORT_ILLEGAL_TRANSITION: 'The item is not in a state that allows this call.',
  IMPORT_RUN_NOT_OPEN: 'The run is not open.',
  IMPORT_NOT_INSTALLED: 'The import tables are not installed on this database.',
  IMPORT_MEDIA_UNAVAILABLE: 'The media bindings are not available.',
  IMPORT_ITEM_CHANGED: 'The item changed between the plan and the write; nothing was written.',
  IMPORT_NOT_STAGED: 'The payload differs from the one staged for this item.',
  IMPORT_DUPLICATE_CREATE: 'The source was already written as a product; nothing was written.',
  IMPORT_CREATE_ON_PRICED_PRODUCT: 'The product already has published prices; the import never records a create on it.',
  IMPORT_FINANCIAL_WRITE_REFUSED: 'A guard trigger refused a money, stock or package write; nothing was written.',
  IMPORT_PAYLOAD_KEY_REFUSED: 'The payload carries a key or a text the allow-list refuses.',
  IMPORT_IDENTITY_AMBIGUOUS: 'The payload does not name this item consistently.',
  IMPORT_REVIEWED_SCOPE_REFUSED: 'The reviewed files do not allow this source, merge or create.',
  REVIEWED_SCOPE_REFUSED: 'The reviewed files do not allow this source, merge or create.',
  REVIEWED_BUNDLE_INVALID: 'A reviewed file bundled into this Worker is invalid.',
  REVIEWED_BUNDLE_UNAVAILABLE: 'The reviewed files are not bundled into this Worker.',
  TAXONOMY_UNMAPPED: 'The taxonomy map gives this product no prepared section.',
  OWNER_HIDDEN: 'A reviewed match targets a product the owner hid.',
  ORDER_TYPE_WORD: 'An option value reads as an order type.',
  CURATION_MISSING: 'The curated file of this product is not in the reviewed index.',
  PLAN_TOO_LARGE: 'The write does not fit the invocation budget.',
  ROW_CAP: 'A collection of this product is over 400 rows.',
  PRIMARY_MEDIA_FAILED: 'The primary image is not stored.',
  PAYLOAD_REFUSED: 'The product save refused the payload.',
  MEDIA_BATCH_SIZE: 'A media call takes one to four media.',
  IMPORT_EVENT_REFUSED: 'This transition is made by its own endpoint, not by an event.',
  IMPORT_WITHDRAW_REFUSED: 'The item is not BLOCKED SOURCE_WITHDRAWN with the evidence and the approval this needs.',
  IMPORT_RUN_NOT_FINISHED: 'Items of this run are still queued or in flight.',
  RETRIES_EXHAUSTED: 'This stage has failed eight times; the item blocks.',
  IMPORT_READBACK_PENDING: 'The write was committed but its read-back has not run yet; ask again.',
  IMPORT_STORAGE_UNAVAILABLE: 'The media storage did not answer; ask again.',
  IMPORT_VERIFY_DISAGREES: 'The runner evidence and the Worker recompute do not both pass and agree.',
  IMPORT_DELTA_REFUSED: 'The delta run does not allow this: the source run is not closed, the item is not new or not a completed item with failed media, or this call is not a media item\'s.',
  TRANSLATIONS_PART_UNKNOWN: 'This translations part is not in the deployed build; wait for the deploy, then retry.',
  TRANSLATIONS_PART_MISMATCH: 'The translations part does not match the reviewed copy, so it was not loaded.',
  TRANSLATIONS_ROW_INVALID: 'A row of the translations part failed validation, so the part was not loaded.',
  TRANSLATIONS_SCHEMA_MISSING: 'The database does not have the translation tables yet.',
  RATE_LIMITED: 'Too many calls for this run; wait a minute.',
  D1_OVERLOADED: 'The database is busy; try again.',
  IMPORT_INTERNAL: 'The import endpoint could not complete this call.',
};

export class OpsRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly ids: readonly string[] = []
  ) {
    super(code);
    this.name = 'OpsRefusal';
  }
}

export function opsMessage(code: string, ids: readonly string[] = []): string {
  const base = OPS_MESSAGES[code] ?? OPS_MESSAGES.IMPORT_INTERNAL;
  const tail = ids.filter((x) => /^[A-Za-z0-9_.:-]{1,80}$/.test(x)).join(', ');
  return (tail ? `${base} (${tail})` : base).slice(0, 300);
}

export function opsError(c: Context, status: number, code: string, ids: readonly string[] = [], headers: Record<string, string> = {}): Response {
  return c.json({ code, message: opsMessage(code, ids) }, status as 400, { 'Cache-Control': NO_STORE, ...headers });
}

/**
 * THE CODES AN EVENT MAY CARRY (§A.3 "a code from a fixed list"): the §B.5 blockers, the transient codes,
 * the deadline park, every code the runner raises itself (scripts/bambu-import/{fetch,run,opsClient}.ts) and
 * every code this Worker answers. `HTTP_<status>` is the runner's name for an answer that carried no code.
 * An event naming anything else is still recorded — the transition is the runner's fact — under
 * UNCLASSIFIED, never under the text it sent.
 */
export const EVENT_CODES: ReadonlySet<string> = new Set([
  '',
  // §B.5 permanent
  'ACCESS_CHALLENGE', 'SOURCE_WITHDRAWN', 'IDENTITY_AMBIGUOUS', 'REVIEWED_SCOPE_REFUSED', 'REVIEWED_BUNDLE_MISMATCH',
  'TAXONOMY_UNMAPPED', 'PAYLOAD_REFUSED', 'PLAN_TOO_LARGE', 'ROW_CAP', 'PRIMARY_MEDIA_FAILED', 'MEDIA_HOST_NOT_ALLOWED',
  'PROTECTED_FIELDS_CHANGED', 'IMPORT_FINANCIAL_WRITE_REFUSED', 'VERIFY_FAILED_PERSISTENT', 'CURATION_MISSING',
  'OWNER_HIDDEN', 'ORDER_TYPE_WORD', 'RETRIES_EXHAUSTED',
  // §B.5 transient, and the deadline park (§A.7 rule 3; it never counts toward stage_attempts)
  'SQLITE_BUSY', 'D1_BUSY', 'D1_OVERLOADED', 'OVERLOADED', 'RATE_LIMITED', 'MEDIA_TIMEOUT', 'CURATION_PENDING', 'VERIFY_STALE',
  'DEADLINE_EXIT',
  // the runner's own
  'STORE_UNREACHABLE', 'STORE_UNAVAILABLE', 'STORE_RATE_LIMITED', 'SOURCE_TOO_LARGE', 'HOST_UNREACHABLE', 'HOST_NOT_ALLOWED',
  'OPS_UNREACHABLE', 'OPS_BAD_ANSWER', 'BAD_SOURCE_ID', 'MEDIA_BATCH_SIZE', 'MANIFEST_BATCH_TOO_LARGE', 'BLOCKED',
  // this Worker's answers
  ...Object.keys(OPS_MESSAGES),
  'IMPORT_STAGE_PLAN', 'IMAGE_SOURCE_TOO_LARGE', 'IMAGE_NOT_SUPPORTED', 'IMAGE_ANIMATED_GIF', 'IMAGE_CONVERT_UNAVAILABLE',
  'IMAGE_CONVERT_FAILED', 'IMAGE_STORAGE_FAILED', 'IMAGE_REFERENCE_INVALID', 'IMAGE_REFERENCE_MISSING',
  'UNCLASSIFIED',
]);

/** The code an event records: one of the catalogue, `HTTP_4xx/5xx`, or UNCLASSIFIED. */
export function eventCode(raw: unknown): string {
  const code = typeof raw === 'string' ? raw : '';
  if (EVENT_CODES.has(code)) return code;
  if (/^HTTP_[45]\d\d$/.test(code)) return code;
  return 'UNCLASSIFIED';
}

/** The §B.5 blocker a BLOCKED item records (the CHECK needs one): the event's code, or UNCLASSIFIED. */
export function blockerCode(raw: unknown): string {
  const code = eventCode(raw);
  return code === '' ? 'UNCLASSIFIED' : code;
}

/** The resume instruction every BLOCKED item carries (§H.2), in the three languages. */
export const RESUME_INSTRUCTION =
  'لاستئناف هذا المنتج: عالج السبب أعلاه ثم شغّل سير العمل 60 بوضع run مع resume. | ' +
  'To resume this product: fix the cause above, then run workflow 60 in run mode with resume. | ' +
  'بۆ دەستپێکردنەوەی ئەم بەرهەمە: هۆکارەکەی سەرەوە چارەسەر بکە، پاشان ڕێڕەوی کاری 60 بە دۆخی run لەگەڵ resume کار پێبکە.';

// ---------------------------------------------------------------- the body

/** Reads the JSON object body (≤ 2 MB). Anything else is an OpsRefusal, never an echo of what was sent. */
export async function readBody(c: OpsContext): Promise<Record<string, unknown>> {
  const declared = Number(c.req.header('Content-Length') ?? '0');
  if (declared > MAX_BODY_BYTES) throw new OpsRefusal(413, 'IMPORT_BODY_TOO_LARGE');
  const text = await c.req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new OpsRefusal(413, 'IMPORT_BODY_TOO_LARGE');
  if (!text) return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new OpsRefusal(400, 'IMPORT_BAD_REQUEST');
  return v as Record<string, unknown>;
}

/** A source product id in a path: digits only (the runner's own rule). */
export const SOURCE_ID = /^[0-9]{1,24}$/;
